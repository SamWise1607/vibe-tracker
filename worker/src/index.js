/**
 * VIBE Operations Tracker: Worker API.
 *
 * Frontend contract: GET /api/state returns almost exactly the shape the
 * original draft kept in its `state` variable, so the UI port is mostly
 * swapping window.storage for fetch(). The one deliberate difference is
 * owners, which are now objects with real user IDs instead of free-text
 * strings, because you cannot email the string "Deoni / Mia".
 */

import { Hono } from 'hono';
import {
  createMagicLink, redeemMagicLink, createSession, sessionCookie,
  clearCookie, getSessionUser, destroySession, purgeExpired,
} from './auth.js';
import {
  sendEmail, magicLinkEmail, addedToProjectEmail, addedToTaskEmail,
  nudgeEmail, joinRequestEmail, approvedEmail,
} from './email.js';

const app = new Hono();

const NUDGE_COOLDOWN_HOURS = 24;

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const json = (c, data, status = 200) => c.json(data, status);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Attaches the signed-in user to the context, or 401s. */
async function requireAuth(c, next) {
  const user = await getSessionUser(c.env, c.req.raw);
  if (!user) return json(c, { error: 'Not signed in' }, 401);
  c.set('user', user);
  await next();
}

async function requireAdmin(c, next) {
  const user = c.get('user');
  if (user.role !== 'admin') return json(c, { error: 'Admins only' }, 403);
  await next();
}

async function touchProject(env, projectId, userId) {
  await env.DB.prepare(`UPDATE projects SET updated_at = ?1, updated_by = ?2 WHERE id = ?3`)
    .bind(nowIso(), userId, projectId).run();
}

async function getUser(env, id) {
  return env.DB.prepare(`SELECT id, name, email, role, status FROM users WHERE id = ?1`)
    .bind(id).first();
}

// ===========================================================================
// AUTH
// ===========================================================================

/**
 * Sign in, or request access. One endpoint handles both, because from the
 * user's point of view it is the same action: "let me in".
 *
 * Always returns the same generic message. If it said "no such user" it would
 * leak which addresses are registered.
 */
app.post('/api/auth/request', async (c) => {
  const { email, name } = await c.req.json().catch(() => ({}));
  const clean = String(email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If that address is recognised, check your inbox.' };

  if (!clean || !clean.includes('@')) {
    return json(c, { error: 'Enter a valid email address' }, 400);
  }

  await purgeExpired(c.env);

  const user = await c.env.DB.prepare(
    `SELECT id, name, email, role, status FROM users WHERE lower(email) = ?1`
  ).bind(clean).first();

  // Known and active: send the link.
  if (user && user.status === 'active') {
    const url = await createMagicLink(c.env, user.id);
    await sendEmail(c.env, magicLinkEmail(user, url));
    return json(c, generic);
  }

  // Already asked, still waiting. Send nothing, so a pending user cannot spam
  // the admins by hammering the form.
  if (user && user.status === 'pending') return json(c, generic);

  // Previously rejected. Silence.
  if (user && user.status === 'rejected') return json(c, generic);

  // Brand new address: create a pending user and tell the admins.
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO users (id, name, email, role, status) VALUES (?1, ?2, ?3, 'member', 'pending')`
  ).bind(id, String(name || '').trim() || clean.split('@')[0], clean).run();

  const admins = await c.env.DB.prepare(
    `SELECT id, name, email FROM users WHERE role = 'admin' AND status = 'active'`
  ).all();

  for (const admin of admins.results) {
    await sendEmail(c.env, joinRequestEmail(admin, { name, email: clean }, `${c.env.APP_URL}/#admin`));
  }

  return json(c, generic);
});

/** Redeems the link from the email and starts a session. */
app.get('/api/auth/verify', async (c) => {
  const token = c.req.query('token');
  const user = await redeemMagicLink(c.env, token);

  if (!user) {
    return c.redirect(`${c.env.APP_URL}/?error=invalid_link`, 302);
  }

  const session = await createSession(c.env, user.id);
  return new Response(null, {
    status: 302,
    headers: { Location: c.env.APP_URL + '/', 'Set-Cookie': sessionCookie(session) },
  });
});

app.post('/api/auth/logout', async (c) => {
  await destroySession(c.env, c.req.raw);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie() },
  });
});

app.get('/api/me', requireAuth, (c) => json(c, c.get('user')));

// ===========================================================================
// STATE (the one read the UI needs)
// ===========================================================================

app.get('/api/state', requireAuth, async (c) => {
  const db = c.env.DB;

  const [projects, projOwners, risks, tasks, taskOwners, settings, lastEdit] = await Promise.all([
    db.prepare(`SELECT * FROM projects ORDER BY num`).all(),
    db.prepare(`SELECT po.project_id, u.id, u.name FROM project_owners po
                  JOIN users u ON u.id = po.user_id ORDER BY u.name`).all(),
    db.prepare(`SELECT project_id, body FROM key_risks ORDER BY project_id, sort_order`).all(),
    db.prepare(`SELECT * FROM tasks ORDER BY project_id, sort_order, id`).all(),
    db.prepare(`SELECT t.task_id, u.id, u.name FROM task_owners t
                  JOIN users u ON u.id = t.user_id ORDER BY u.name`).all(),
    db.prepare(`SELECT key, value FROM settings`).all(),
    db.prepare(`SELECT u.name AS by_name, p.updated_at AS at FROM projects p
                  LEFT JOIN users u ON u.id = p.updated_by
                 ORDER BY p.updated_at DESC LIMIT 1`).first(),
  ]);

  const ownersByProject = groupBy(projOwners.results, 'project_id', (r) => ({ id: r.id, name: r.name }));
  const risksByProject  = groupBy(risks.results, 'project_id', (r) => r.body);
  const ownersByTask    = groupBy(taskOwners.results, 'task_id', (r) => ({ id: r.id, name: r.name }));
  const tasksByProject  = groupBy(tasks.results, 'project_id', (t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    due: t.due_date,
    note: t.note,
    owners: ownersByTask[t.id] || [],
    ownerLabel: t.owner_label,          // 'Legal', 'External (Discovery)', 'Unassigned'
  }));

  const settingsMap = Object.fromEntries(settings.results.map((s) => [s.key, s.value]));

  return json(c, {
    me: c.get('user'),
    focusThisWeek: settingsMap.focus_this_week || '',
    leaderNotes: safeParse(settingsMap.leadership_notes, []),
    lastEdited: { by: lastEdit?.by_name || '—', at: (lastEdit?.at || '').slice(0, 10) || '—' },
    initiatives: projects.results.map((p) => ({
      id: p.id,
      num: p.num,
      name: p.name,
      status: p.status,
      owners: ownersByProject[p.id] || [],
      target: p.target_text,
      targetDate: p.target_date,
      summary: p.summary,
      whereWeAre: p.where_we_are,
      keyRisk: risksByProject[p.id] || [],
      tasks: tasksByProject[p.id] || [],
    })),
  });
});

app.get('/api/users', requireAuth, async (c) => {
  const isAdmin = c.get('user').role === 'admin';
  // Members get the roster so they can assign owners. They do not get to see
  // pending or rejected people, which is admin business.
  const sql = isAdmin
    ? `SELECT id, name, email, role, status, created_at FROM users ORDER BY status, name`
    : `SELECT id, name, email, role, status FROM users WHERE status = 'active' ORDER BY name`;
  const rows = await c.env.DB.prepare(sql).all();
  return json(c, rows.results);
});

// ===========================================================================
// PROJECTS
// ===========================================================================

const PROJECT_FIELDS = {
  status: 'status',
  target: 'target_text',
  targetDate: 'target_date',
  summary: 'summary',
  whereWeAre: 'where_we_are',
};

app.patch('/api/projects/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const sets = [], vals = [];
  for (const [key, column] of Object.entries(PROJECT_FIELDS)) {
    if (key in body) { sets.push(`${column} = ?`); vals.push(body[key] === '' && key === 'targetDate' ? null : body[key]); }
  }
  if (!sets.length) return json(c, { error: 'Nothing to update' }, 400);

  sets.push('updated_at = ?', 'updated_by = ?');
  vals.push(nowIso(), c.get('user').id, id);

  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return json(c, { ok: true });
});

/** Key Risk is admin-only. It was Deoni-only in the draft via an honour prompt. */
app.put('/api/projects/:id/risks', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const { risks } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(risks)) return json(c, { error: 'risks must be an array' }, 400);

  const stmts = [c.env.DB.prepare(`DELETE FROM key_risks WHERE project_id = ?1`).bind(id)];
  risks.map((r) => String(r).trim()).filter(Boolean).forEach((body, i) => {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO key_risks (project_id, body, sort_order) VALUES (?1, ?2, ?3)`
    ).bind(id, body, i));
  });

  await c.env.DB.batch(stmts);
  await touchProject(c.env, id, c.get('user').id);
  return json(c, { ok: true });
});

/** Adding an owner is one of the two things that sends a notification. */
app.post('/api/projects/:id/owners', requireAuth, async (c) => {
  const projectId = c.req.param('id');
  const { userId } = await c.req.json().catch(() => ({}));
  const actor = c.get('user');

  const [project, target] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(projectId).first(),
    getUser(c.env, userId),
  ]);
  if (!project) return json(c, { error: 'No such project' }, 404);
  if (!target || target.status !== 'active') return json(c, { error: 'No such active user' }, 404);

  const existing = await c.env.DB.prepare(
    `SELECT 1 FROM project_owners WHERE project_id = ?1 AND user_id = ?2`
  ).bind(projectId, userId).first();
  if (existing) return json(c, { ok: true, alreadyOwner: true });

  await c.env.DB.prepare(
    `INSERT INTO project_owners (project_id, user_id) VALUES (?1, ?2)`
  ).bind(projectId, userId).run();
  await touchProject(c.env, projectId, actor.id);

  // Do not email someone about adding themselves.
  let emailed = false;
  if (target.id !== actor.id) {
    const res = await sendEmail(c.env, addedToProjectEmail(target, project, actor, `${c.env.APP_URL}/#${projectId}`));
    emailed = res.ok;
  }
  return json(c, { ok: true, emailed });
});

app.delete('/api/projects/:id/owners/:userId', requireAuth, async (c) => {
  await c.env.DB.prepare(
    `DELETE FROM project_owners WHERE project_id = ?1 AND user_id = ?2`
  ).bind(c.req.param('id'), c.req.param('userId')).run();
  await touchProject(c.env, c.req.param('id'), c.get('user').id);
  return json(c, { ok: true });
});

// ===========================================================================
// TASKS
// ===========================================================================

app.post('/api/projects/:id/tasks', requireAuth, async (c) => {
  const projectId = c.req.param('id');
  const { name } = await c.req.json().catch(() => ({}));
  if (!String(name || '').trim()) return json(c, { error: 'Task needs a name' }, 400);

  const max = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE project_id = ?1`
  ).bind(projectId).first();

  const res = await c.env.DB.prepare(
    `INSERT INTO tasks (project_id, name, status, sort_order, updated_at, updated_by)
     VALUES (?1, ?2, 'not-started', ?3, ?4, ?5)`
  ).bind(projectId, String(name).trim(), max.m + 1, nowIso(), c.get('user').id).run();

  await touchProject(c.env, projectId, c.get('user').id);
  return json(c, { ok: true, id: res.meta.last_row_id });
});

const TASK_FIELDS = { name: 'name', status: 'status', due: 'due_date', note: 'note', ownerLabel: 'owner_label' };

app.patch('/api/tasks/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const sets = [], vals = [];
  for (const [key, column] of Object.entries(TASK_FIELDS)) {
    if (key in body) {
      sets.push(`${column} = ?`);
      vals.push(body[key] === '' && (key === 'due' || key === 'ownerLabel') ? null : body[key]);
    }
  }
  if (!sets.length) return json(c, { error: 'Nothing to update' }, 400);

  sets.push('updated_at = ?', 'updated_by = ?');
  vals.push(nowIso(), c.get('user').id, id);

  await c.env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();

  const task = await c.env.DB.prepare(`SELECT project_id FROM tasks WHERE id = ?1`).bind(id).first();
  if (task) await touchProject(c.env, task.project_id, c.get('user').id);
  return json(c, { ok: true });
});

app.delete('/api/tasks/:id', requireAuth, async (c) => {
  await c.env.DB.prepare(`DELETE FROM tasks WHERE id = ?1`).bind(Number(c.req.param('id'))).run();
  return json(c, { ok: true });
});

/**
 * Replaces the owner set for a task. Emails anyone newly added.
 * `label` covers non-people such as 'Legal' or 'External (Discovery)', who
 * obviously cannot be emailed or nudged.
 */
app.put('/api/tasks/:id/owners', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const { userIds = [], label = null } = await c.req.json().catch(() => ({}));
  const actor = c.get('user');

  const task = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(id).first();
  if (!task) return json(c, { error: 'No such task' }, 404);
  const project = await c.env.DB.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(task.project_id).first();

  const before = await c.env.DB.prepare(`SELECT user_id FROM task_owners WHERE task_id = ?1`).bind(id).all();
  const beforeIds = new Set(before.results.map((r) => r.user_id));

  const stmts = [c.env.DB.prepare(`DELETE FROM task_owners WHERE task_id = ?1`).bind(id)];
  for (const uid of userIds) {
    stmts.push(c.env.DB.prepare(`INSERT INTO task_owners (task_id, user_id) VALUES (?1, ?2)`).bind(id, uid));
  }
  stmts.push(c.env.DB.prepare(
    `UPDATE tasks SET owner_label = ?1, updated_at = ?2, updated_by = ?3 WHERE id = ?4`
  ).bind(label || null, nowIso(), actor.id, id));
  await c.env.DB.batch(stmts);
  await touchProject(c.env, task.project_id, actor.id);

  const notified = [];
  for (const uid of userIds) {
    if (beforeIds.has(uid) || uid === actor.id) continue;
    const target = await getUser(c.env, uid);
    if (!target || target.status !== 'active') continue;
    const res = await sendEmail(c.env, addedToTaskEmail(target, task, project, actor, `${c.env.APP_URL}/#${project.id}`));
    if (res.ok) notified.push(target.name);
  }
  return json(c, { ok: true, notified });
});

/**
 * The nudge button. Emails every human owner of a task asking for an update.
 *
 * Rate limited per person per task, for two reasons: it stops the button being
 * used as a stick, and it protects the EmailJS free allowance of 200/month.
 */
app.post('/api/tasks/:id/nudge', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const actor = c.get('user');

  const task = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(id).first();
  if (!task) return json(c, { error: 'No such task' }, 404);
  const project = await c.env.DB.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(task.project_id).first();

  const owners = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM task_owners t
       JOIN users u ON u.id = t.user_id
      WHERE t.task_id = ?1 AND u.status = 'active'`
  ).bind(id).all();

  if (!owners.results.length) {
    const who = task.owner_label ? `"${task.owner_label}"` : 'nobody';
    return json(c, { error: `This task is assigned to ${who}, so there is no one to nudge.` }, 400);
  }

  const cutoff = new Date(Date.now() - NUDGE_COOLDOWN_HOURS * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);

  const sent = [], skipped = [];
  for (const owner of owners.results) {
    if (owner.id === actor.id) { skipped.push(`${owner.name} (that is you)`); continue; }

    const recent = await c.env.DB.prepare(
      `SELECT sent_at FROM nudges WHERE task_id = ?1 AND sent_to = ?2 AND sent_at > ?3 LIMIT 1`
    ).bind(id, owner.id, cutoff).first();
    if (recent) { skipped.push(`${owner.name} (nudged in the last ${NUDGE_COOLDOWN_HOURS}h)`); continue; }

    const res = await sendEmail(c.env, nudgeEmail(owner, task, project, actor, `${c.env.APP_URL}/#${project.id}`));
    if (res.ok) {
      await c.env.DB.prepare(
        `INSERT INTO nudges (task_id, sent_by, sent_to) VALUES (?1, ?2, ?3)`
      ).bind(id, actor.id, owner.id).run();
      sent.push(owner.name);
    } else {
      skipped.push(`${owner.name} (email failed)`);
    }
  }
  return json(c, { ok: true, sent, skipped });
});

// ===========================================================================
// SETTINGS (admin only, replacing the draft's "type DEONI" gates)
// ===========================================================================

async function putSetting(env, key, value, userId) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4`
  ).bind(key, value, nowIso(), userId).run();
}

app.put('/api/settings/focus', requireAuth, requireAdmin, async (c) => {
  const { value } = await c.req.json().catch(() => ({}));
  await putSetting(c.env, 'focus_this_week', String(value || '').trim(), c.get('user').id);
  return json(c, { ok: true });
});

app.put('/api/settings/leadership', requireAuth, requireAdmin, async (c) => {
  const { notes } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(notes)) return json(c, { error: 'notes must be an array' }, 400);
  const clean = notes.map((n) => String(n).trim()).filter(Boolean);
  await putSetting(c.env, 'leadership_notes', JSON.stringify(clean), c.get('user').id);
  return json(c, { ok: true });
});

// ===========================================================================
// ADMIN: approving people
// ===========================================================================

app.post('/api/users/:id/approve', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const actor = c.get('user');

  const target = await getUser(c.env, id);
  if (!target) return json(c, { error: 'No such user' }, 404);
  if (target.status === 'active') return json(c, { ok: true, alreadyActive: true });

  await c.env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?1`).bind(id).run();

  const url = await createMagicLink(c.env, id);
  const res = await sendEmail(c.env, approvedEmail(target, actor, url));
  return json(c, { ok: true, emailed: res.ok });
});

app.post('/api/users/:id/reject', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  if (id === c.get('user').id) return json(c, { error: 'You cannot reject yourself' }, 400);

  // Rejecting also kills any live session immediately.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET status = 'rejected' WHERE id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM magic_tokens WHERE user_id = ?1`).bind(id),
  ]);
  // No email. Telling someone they were rejected invites an argument.
  return json(c, { ok: true });
});

app.patch('/api/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const { role } = await c.req.json().catch(() => ({}));
  if (!['admin', 'member'].includes(role)) return json(c, { error: 'role must be admin or member' }, 400);

  // Guard against locking everyone out of admin.
  if (role === 'member' && id === c.get('user').id) {
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`
    ).first();
    if (count.n <= 1) return json(c, { error: 'You are the last admin' }, 400);
  }

  await c.env.DB.prepare(`UPDATE users SET role = ?1 WHERE id = ?2`).bind(role, id).run();
  return json(c, { ok: true });
});

// ---------------------------------------------------------------------------

app.all('/api/*', (c) => json(c, { error: 'Unknown endpoint' }, 404));

// ---------------------------------------------------------------------------

function groupBy(rows, key, shape) {
  const out = {};
  for (const row of rows) (out[row[key]] ||= []).push(shape(row));
  return out;
}

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

export default app;
