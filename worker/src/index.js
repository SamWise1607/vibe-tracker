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
  nudgeEmail, dueDateReminderEmail, noteActivityEmail, joinRequestEmail, approvedEmail,
} from './email.js';

const app = new Hono();

const NUDGE_COOLDOWN_HOURS = 24;

// Automatic due-date reminders piggyback on the same nudges table and the
// same 24h cooldown as a manual Nudge (task_id + sent_to, regardless of who
// sent it), so a manual Nudge in the last 24h blocks an automatic reminder
// and vice versa, with no extra dedup logic needed.
const DUE_REMINDER_LEAD_DAYS = 7;
const SYSTEM_USER_ID = 'system';

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// "HH:MM", 24h. Purely a display companion to due_date, see schema.sql.
function isValidTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/**
 * Emails every other active human owner of a task that someone added or
 * edited a note on it. Not rate limited (unlike Nudge/due-date reminders,
 * see sendNudgeIfDue) since this is informational rather than a chase, and
 * always excludes whoever made the change themselves.
 */
async function notifyOtherOwnersOfNoteActivity(env, { task, project, actor, action, noteText }) {
  const owners = await env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM task_owners t
       JOIN users u ON u.id = t.user_id
      WHERE t.task_id = ?1 AND u.status = 'active' AND u.is_system = 0`
  ).bind(task.id).all();

  const notified = [];
  for (const owner of owners.results) {
    if (owner.id === actor.id) continue;
    const res = await sendEmail(env, noteActivityEmail(
      owner, task, project, actor, `${env.APP_URL}/#${project.id}`, { action, noteText }
    ));
    if (res.ok) notified.push(owner.name);
  }
  return notified;
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

/**
 * Records an admin-visible history entry. Never throws into the caller,
 * same philosophy as email sending: logging a thing going wrong should
 * never be the reason the real action fails.
 */
async function logAction(env, { actorId, action, entityType, entityId, snapshot, detail }) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, snapshot, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      actorId, action, entityType, entityId == null ? null : String(entityId),
      snapshot ? JSON.stringify(snapshot) : null, detail || null,
    ).run();
  } catch (e) {
    console.error('audit log failed', e);
  }
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
  const actualUser = c.get('user');

  // Read-only "view as": an admin can preview exactly what another active
  // user would see (their task scoping, their admin/member split), without
  // ever being able to act as them. `me` below always stays the real
  // signed-in admin; `viewingAs` is what the frontend uses to render the
  // preview and to know it must disable every write control while active.
  let scopeUser = actualUser;
  let viewingAs = null;
  const viewAsId = c.req.query('viewAs');
  if (viewAsId) {
    if (actualUser.role !== 'admin') return json(c, { error: 'View-as is admin-only' }, 403);
    const target = await getUser(c.env, viewAsId);
    if (!target || target.status !== 'active') return json(c, { error: 'No such active user' }, 404);
    scopeUser = target;
    viewingAs = { id: target.id, name: target.name, role: target.role };
  }

  const [projects, projOwners, risks, tasks, taskOwners, taskNotes, settings, lastEdit] = await Promise.all([
    db.prepare(`SELECT * FROM projects ORDER BY num`).all(),
    db.prepare(`SELECT po.project_id, u.id, u.name FROM project_owners po
                  JOIN users u ON u.id = po.user_id ORDER BY u.name`).all(),
    db.prepare(`SELECT project_id, body FROM key_risks ORDER BY project_id, sort_order`).all(),
    db.prepare(`SELECT * FROM tasks ORDER BY project_id, sort_order, id`).all(),
    db.prepare(`SELECT t.task_id, u.id, u.name FROM task_owners t
                  JOIN users u ON u.id = t.user_id ORDER BY u.name`).all(),
    // DESC: newest note first. Notes are still stored/inserted with an
    // ever-increasing sort_order (append-only), just displayed in reverse so
    // a newly added note folds in above older ones instead of at the bottom.
    // Joined to users twice to expose who originally added each note and
    // when, shown on hover in the frontend (added 5 Aug 2026; deliberately
    // still no "last edited by" beyond that, editing a note does not change
    // the displayed author/timestamp).
    db.prepare(`SELECT n.id, n.task_id, n.body, n.created_at, cu.name AS created_by_name
                  FROM task_notes n LEFT JOIN users cu ON cu.id = n.created_by
                 ORDER BY n.task_id, n.sort_order DESC, n.id DESC`).all(),
    db.prepare(`SELECT key, value FROM settings`).all(),
    db.prepare(`SELECT u.name AS by_name, p.updated_at AS at FROM projects p
                  LEFT JOIN users u ON u.id = p.updated_by
                 ORDER BY p.updated_at DESC LIMIT 1`).first(),
  ]);

  // isAdmin and the task scoping below are both computed against scopeUser,
  // which is the real signed-in user normally, or whoever an admin is
  // previewing when viewingAs is set. This is what makes it a real preview
  // of their POV rather than just a cosmetic label.
  const isAdmin = scopeUser.role === 'admin';

  const ownersByProject = groupBy(projOwners.results, 'project_id', (r) => ({ id: r.id, name: r.name }));
  const risksByProject  = groupBy(risks.results, 'project_id', (r) => r.body);
  const ownersByTask    = groupBy(taskOwners.results, 'task_id', (r) => ({ id: r.id, name: r.name }));
  const notesByTask     = groupBy(taskNotes.results, 'task_id', (r) => ({
    id: r.id, text: r.body, authorName: r.created_by_name || 'Unknown', createdAt: r.created_at,
  }));
  const allTasksByProject = groupBy(tasks.results, 'project_id', (t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    due: t.due_date,
    dueTime: t.due_time,                // "HH:MM", nullable, informational only
    notes: notesByTask[t.id] || [],      // array of {id, text, authorName, createdAt}, each its own box
    owners: ownersByTask[t.id] || [],
    ownerLabel: t.owner_label,          // 'Legal', 'External (Discovery)', 'Unassigned'
  }));

  // Task numbers like "1.1", "3.4": project.num + the task's 1-based rank
  // among the NOT-done tasks in that project, ordered by sort_order (the
  // `tasks` query above is already `ORDER BY project_id, sort_order, id`,
  // so groupBy already produced each project's array in that order).
  // Deliberately not stored anywhere: it's recomputed here on every read, so
  // dragging tasks to reorder (PUT /api/projects/:id/tasks/reorder) just
  // works with no separate renumbering step, and a done task shows no
  // number at all rather than a stale or out-of-sequence one (Sam's call:
  // once it's done, the number "can come off, it doesn't matter anymore").
  for (const [projectId, projectTasks] of Object.entries(allTasksByProject)) {
    const project = projects.results.find((p) => p.id === projectId);
    if (!project) continue;
    let rank = 0;
    for (const t of projectTasks) {
      t.number = t.status === 'done' ? null : `${project.num}.${++rank}`;
    }
  }

  // All projects are visible to everyone, member or admin (changed 6 Aug
  // 2026, was previously scoped to named project owners / task owners only
  // for members). Editing rights are unaffected by this: a member can still
  // edit only the status of a task they personally own, enforced separately
  // in PATCH /api/tasks/:id.
  const visibleProjects = projects.results;
  const tasksByProject = allTasksByProject;

  // Archived is a separate `projects.archived` flag, not a status value (a
  // project keeps its real status even once archived, see the schema
  // comment). Hidden from the dashboard by default (still counted in
  // archivedCount so the frontend can show a "Show archived (N)" toggle),
  // same visibility rules as everything else otherwise: a member who
  // couldn't see the project before archiving still can't see it after.
  // ?includeArchived=1 reveals them.
  const includeArchived = c.req.query('includeArchived') === '1';
  const archivedCount = visibleProjects.filter((p) => !!p.archived).length;
  const shownProjects = includeArchived ? visibleProjects : visibleProjects.filter((p) => !p.archived);

  // "Decisions Needed from Ferdi" is a team-wide status signal, not private
  // task data, so it is always built from the full unfiltered set, even for
  // members who cannot otherwise see Ferdi's tasks. Mirrors the existing
  // client-side convention of hardcoding the 'ferdi' user id. Archived
  // projects are excluded here too, same reasoning as hiding them from the
  // dashboard: a shelved project's asks of Ferdi are stale.
  const ferdiDecisions = Object.entries(allTasksByProject).flatMap(([projectId, projectTasks]) => {
    const project = projects.results.find((p) => p.id === projectId);
    if (project?.archived) return [];
    return projectTasks
      .filter((t) => (t.owners || []).some((o) => o.id === 'ferdi'))
      .map((t) => ({ ...t, projectId, projectName: project?.name || projectId }));
  });

  const settingsMap = Object.fromEntries(settings.results.map((s) => [s.key, s.value]));

  return json(c, {
    me: actualUser,
    viewingAs,
    focusThisWeek: settingsMap.focus_this_week || '',
    leaderNotes: safeParse(settingsMap.leadership_notes, []),
    ferdiDecisions,
    lastEdited: { by: lastEdit?.by_name || '—', at: (lastEdit?.at || '').slice(0, 10) || '—' },
    archivedCount,
    initiatives: shownProjects.map((p) => ({
      id: p.id,
      num: p.num,
      name: p.name,
      status: p.status,
      archived: !!p.archived,
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
  // is_system = 0 excludes the 'VIBE Tracker' automated-reminder sender, which
  // is a real users row (nudges.sent_by needs one) but should never show up
  // as a pickable owner or in the admin user-management list.
  const sql = isAdmin
    ? `SELECT id, name, email, role, status, created_at FROM users WHERE is_system = 0 ORDER BY status, name`
    : `SELECT id, name, email, role, status FROM users WHERE status = 'active' AND is_system = 0 ORDER BY name`;
  const rows = await c.env.DB.prepare(sql).all();
  return json(c, rows.results);
});

// ===========================================================================
// PROJECTS
// ===========================================================================

// Where We Are is the one project field any signed-in user can edit, its own
// long-standing inline "Edit" control on the card. Everything else
// (name, status, target, target date, summary) is admin-only: name always
// was, and the rest moved to admin-only once a real "Edit details" button
// made them easy to reach, rather than leaving them open just because
// nothing surfaced them in the UI before.
const PROJECT_FIELDS = { whereWeAre: 'where_we_are' };
const ADMIN_ONLY_PROJECT_FIELDS = {
  name: 'name', status: 'status', target: 'target_text',
  targetDate: 'target_date', summary: 'summary',
};
const PROJECT_STATUS_VALUES = ['on-track', 'at-risk', 'blocked', 'paused'];
// `archived` is a separate `projects.archived` flag (0/1), deliberately NOT
// a 5th status value: a project keeps its real status even once archived
// (e.g. an at-risk project stays "at-risk" underneath), so nothing is lost
// if it's ever unarchived. Also sidesteps ever needing to widen the
// `status` CHECK constraint, which in SQLite/D1 means recreating the whole
// `projects` table — too dangerous given D1's `PRAGMA foreign_keys = OFF`
// not reliably taking effect across a multi-statement file execution (hit
// this the hard way on 5 Aug 2026: recreating `projects` cascade-deleted
// every task, note, and owner in the live database; recovered via D1 Time
// Travel). Hidden from GET /api/state by default (see includeArchived
// below), reversible any time via this same admin-only PATCH.
const ADMIN_ONLY_PROJECT_BOOL_FIELDS = { archived: 'archived' };

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

/** Creating a project is admin-only. No milestones, matches the rest of the
 * structure: a project is just a name plus the same fields PATCH can edit. */
app.post('/api/projects', requireAuth, requireAdmin, async (c) => {
  const actor = c.get('user');
  const { name, status, target, targetDate, summary, whereWeAre } = await c.req.json().catch(() => ({}));
  const cleanName = String(name || '').trim();
  if (!cleanName) return json(c, { error: 'Project needs a name' }, 400);

  const cleanStatus = PROJECT_STATUS_VALUES.includes(status) ? status : 'on-track';

  // id from the name ("Fortress Africa" -> "fortress"), falling back to
  // "-2", "-3" etc. on a collision so it never silently overwrites another
  // project's id.
  const base = slugify(cleanName);
  let id = base, n = 2;
  while (await c.env.DB.prepare(`SELECT 1 FROM projects WHERE id = ?1`).bind(id).first()) {
    id = `${base}-${n++}`;
  }

  const max = await c.env.DB.prepare(`SELECT COALESCE(MAX(num), 0) AS m FROM projects`).first();

  await c.env.DB.prepare(
    `INSERT INTO projects (id, num, name, status, target_text, target_date, summary, where_we_are, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(
    id, max.m + 1, cleanName, cleanStatus, String(target || '').trim(),
    String(targetDate || '').trim() || null, String(summary || '').trim(), String(whereWeAre || '').trim(),
    nowIso(), actor.id,
  ).run();

  await logAction(c.env, {
    actorId: actor.id, action: 'project_created', entityType: 'project', entityId: id,
    detail: `"${cleanName}" created`,
  });
  return json(c, { ok: true, id });
});

app.patch('/api/projects/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const actor = c.get('user');
  const body = await c.req.json().catch(() => ({}));

  const adminFieldRequested = Object.keys(ADMIN_ONLY_PROJECT_FIELDS).some((key) => key in body) ||
    Object.keys(ADMIN_ONLY_PROJECT_BOOL_FIELDS).some((key) => key in body);
  if (adminFieldRequested && actor.role !== 'admin') {
    return json(c, { error: 'Editing project details is admin-only' }, 403);
  }
  if ('name' in body && !String(body.name || '').trim()) {
    return json(c, { error: 'Project needs a name' }, 400);
  }
  if ('status' in body && !PROJECT_STATUS_VALUES.includes(body.status)) {
    return json(c, { error: 'Invalid status' }, 400);
  }

  const fields = actor.role === 'admin' ? { ...PROJECT_FIELDS, ...ADMIN_ONLY_PROJECT_FIELDS } : PROJECT_FIELDS;
  const sets = [], vals = [];
  for (const [key, column] of Object.entries(fields)) {
    if (key in body) {
      const v = key === 'name' ? String(body.name).trim()
              : (body[key] === '' && key === 'targetDate' ? null : body[key]);
      sets.push(`${column} = ?`); vals.push(v);
    }
  }
  // Boolean fields (currently just `archived`) are handled separately from
  // the generic string-field loop above so they coerce cleanly to 0/1.
  if (actor.role === 'admin') {
    for (const [key, column] of Object.entries(ADMIN_ONLY_PROJECT_BOOL_FIELDS)) {
      if (key in body) { sets.push(`${column} = ?`); vals.push(body[key] ? 1 : 0); }
    }
  }
  if (!sets.length) return json(c, { error: 'Nothing to update' }, 400);

  sets.push('updated_at = ?', 'updated_by = ?');
  vals.push(nowIso(), actor.id, id);

  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  await logAction(c.env, {
    actorId: actor.id, action: 'project_updated', entityType: 'project', entityId: id,
    detail: `${id}: ${Object.keys(body).join(', ')} updated`,
  });
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
  await logAction(c.env, {
    actorId: c.get('user').id, action: 'key_risk_updated', entityType: 'project', entityId: id,
    detail: `${id}: Key Risk updated (${risks.length} item${risks.length === 1 ? '' : 's'})`,
  });
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
  await logAction(c.env, {
    actorId: actor.id, action: 'project_owner_added', entityType: 'project', entityId: projectId,
    detail: `${target.name} added to ${projectId}`,
  });
  return json(c, { ok: true, emailed });
});

app.delete('/api/projects/:id/owners/:userId', requireAuth, async (c) => {
  const projectId = c.req.param('id');
  const userId = c.req.param('userId');
  const actor = c.get('user');
  const target = await getUser(c.env, userId);

  await c.env.DB.prepare(
    `DELETE FROM project_owners WHERE project_id = ?1 AND user_id = ?2`
  ).bind(projectId, userId).run();
  await touchProject(c.env, projectId, actor.id);
  await logAction(c.env, {
    actorId: actor.id, action: 'project_owner_removed', entityType: 'project', entityId: projectId,
    detail: `${target?.name || userId} removed from ${projectId}`,
  });
  return json(c, { ok: true });
});

// ===========================================================================
// TASKS
// ===========================================================================

app.post('/api/projects/:id/tasks', requireAuth, async (c) => {
  const projectId = c.req.param('id');
  const actor = c.get('user');
  const { name, due, dueTime, note, ownerIds } = await c.req.json().catch(() => ({}));
  if (!String(name || '').trim()) return json(c, { error: 'Task needs a name' }, 400);

  const cleanDue = String(due || '').trim() || null;
  const cleanDueTime = String(dueTime || '').trim() || null;
  if (cleanDueTime && !isValidTime(cleanDueTime)) return json(c, { error: 'Invalid due time' }, 400);
  if (cleanDueTime && !cleanDue) return json(c, { error: 'Due time needs a due date' }, 400);

  // Members can only ever create a task assigned to themselves. Admins get
  // to pick, matching the owner field their version of the form shows.
  const owners = actor.role === 'admin'
    ? [...new Set(Array.isArray(ownerIds) ? ownerIds : [])]
    : [actor.id];

  const max = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE project_id = ?1`
  ).bind(projectId).first();

  const res = await c.env.DB.prepare(
    `INSERT INTO tasks (project_id, name, status, due_date, due_time, sort_order, updated_at, updated_by)
     VALUES (?1, ?2, 'not-started', ?3, ?4, ?5, ?6, ?7)`
  ).bind(
    projectId, String(name).trim(), cleanDue, cleanDueTime,
    max.m + 1, nowIso(), actor.id,
  ).run();

  const taskId = res.meta.last_row_id;
  if (owners.length) {
    await c.env.DB.batch(owners.map((uid) =>
      c.env.DB.prepare(`INSERT INTO task_owners (task_id, user_id) VALUES (?1, ?2)`).bind(taskId, uid)
    ));
  }

  // The "Add task" form's optional note field becomes note box #1, not a
  // write to the old single-note column.
  const initialNote = String(note || '').trim();
  if (initialNote) {
    await c.env.DB.prepare(
      `INSERT INTO task_notes (task_id, body, sort_order, created_at, created_by, updated_at, updated_by)
       VALUES (?1, ?2, 0, ?3, ?4, ?3, ?4)`
    ).bind(taskId, initialNote, nowIso(), actor.id).run();
  }

  await touchProject(c.env, projectId, actor.id);
  await logAction(c.env, {
    actorId: actor.id, action: 'task_created', entityType: 'task', entityId: taskId,
    detail: `"${String(name).trim()}" added to ${projectId}`,
  });
  return json(c, { ok: true, id: taskId });
});

/**
 * Drag-to-reorder. Admin-only, one project at a time. Body is the full list
 * of that project's task ids in the new order; sort_order is rewritten to
 * 0..n-1 to match. Rejects anything that isn't exactly a reordering of the
 * project's existing tasks (no sneaking a task in from another project, no
 * dropping one), so this can never be used to corrupt task_id/project_id
 * pairing.
 *
 * Task numbers ("1.1", "3.4") are NOT stored anywhere, see the comment above
 * allTasksByProject in GET /api/state; they're recomputed from this same
 * sort_order every time the state is read, so reordering here is all that's
 * needed to renumber.
 */
app.put('/api/projects/:id/tasks/reorder', requireAuth, requireAdmin, async (c) => {
  const projectId = c.req.param('id');
  const actor = c.get('user');
  const { taskIds } = await c.req.json().catch(() => ({}));

  if (!Array.isArray(taskIds) || !taskIds.length) return json(c, { error: 'taskIds must be a non-empty array' }, 400);

  const existing = await c.env.DB.prepare(`SELECT id FROM tasks WHERE project_id = ?1`).bind(projectId).all();
  const existingIds = existing.results.map((r) => r.id);
  const sameSet = existingIds.length === taskIds.length &&
    new Set(existingIds).size === new Set(taskIds.map(Number)).size &&
    existingIds.every((id) => taskIds.map(Number).includes(id));
  if (!sameSet) return json(c, { error: 'taskIds must be exactly this project\'s current tasks, reordered' }, 400);

  await c.env.DB.batch(taskIds.map((id, i) =>
    c.env.DB.prepare(`UPDATE tasks SET sort_order = ?1 WHERE id = ?2 AND project_id = ?3`).bind(i, Number(id), projectId)
  ));

  await touchProject(c.env, projectId, actor.id);
  await logAction(c.env, {
    actorId: actor.id, action: 'tasks_reordered', entityType: 'project', entityId: projectId,
    detail: `Tasks reordered in ${projectId}`,
  });
  return json(c, { ok: true });
});

const TASK_FIELDS = { name: 'name', status: 'status', due: 'due_date', dueTime: 'due_time', ownerLabel: 'owner_label' };
// Members can only ever touch status on a task, and only one they own.
// Notes are a separate free-for-all (see TASK NOTES below); everything else
// here (name, due date, non-person label) is admin-only.
const MEMBER_TASK_FIELDS = { status: 'status' };

app.patch('/api/tasks/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const actor = c.get('user');
  const body = await c.req.json().catch(() => ({}));

  const task = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(id).first();
  if (!task) return json(c, { error: 'No such task' }, 404);

  if (actor.role !== 'admin') {
    const owns = await c.env.DB.prepare(
      `SELECT 1 FROM task_owners WHERE task_id = ?1 AND user_id = ?2`
    ).bind(id, actor.id).first();
    if (!owns) return json(c, { error: 'You can only edit tasks assigned to you' }, 403);
  }

  if ('dueTime' in body && body.dueTime && !isValidTime(body.dueTime)) {
    return json(c, { error: 'Invalid due time' }, 400);
  }
  // Clearing the due date also clears any due time, so callers don't have to
  // clear both explicitly, and a due_time can never outlive its date.
  const clearingDue = 'due' in body && !body.due;
  const resultingDue = 'due' in body ? (body.due || null) : task.due_date;
  const resultingDueTime = 'dueTime' in body ? (body.dueTime || null) : (clearingDue ? null : task.due_time);
  if (resultingDueTime && !resultingDue) {
    return json(c, { error: 'Due time needs a due date' }, 400);
  }

  const fields = actor.role === 'admin' ? TASK_FIELDS : MEMBER_TASK_FIELDS;
  const sets = [], vals = [];
  for (const [key, column] of Object.entries(fields)) {
    if (key in body) {
      sets.push(`${column} = ?`);
      vals.push(body[key] === '' && (key === 'due' || key === 'dueTime' || key === 'ownerLabel') ? null : body[key]);
    }
  }
  if (clearingDue && !('dueTime' in body) && task.due_time && actor.role === 'admin') {
    sets.push('due_time = ?'); vals.push(null);
  }
  if (!sets.length) return json(c, { error: 'Nothing to update' }, 400);

  sets.push('updated_at = ?', 'updated_by = ?');
  vals.push(nowIso(), actor.id, id);

  await c.env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  await touchProject(c.env, task.project_id, actor.id);

  if ('status' in body && body.status !== task.status) {
    await logAction(c.env, {
      actorId: actor.id, action: 'task_status_changed', entityType: 'task', entityId: id,
      detail: `"${task.name}": ${task.status} -> ${body.status}`,
    });
  }
  return json(c, { ok: true });
});

// ===========================================================================
// TASK NOTES (multiple free-text entries per task, not one overwritable field)
// ===========================================================================
//
// Any signed-in user can add, edit or delete a note box on any task,
// regardless of who owns it. Looser than task editing generally (which is
// owner-or-admin), by design: notes are quick context left for whoever
// picks the task up next, not something worth gating. They are plain and
// freeform, no author or timestamp shown, and not restorable if deleted.

app.post('/api/tasks/:id/notes', requireAuth, async (c) => {
  const taskId = Number(c.req.param('id'));
  const actor = c.get('user');
  const { text } = await c.req.json().catch(() => ({}));
  const body = String(text || '').trim();
  if (!body) return json(c, { error: 'Note needs some text' }, 400);

  const task = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(taskId).first();
  if (!task) return json(c, { error: 'No such task' }, 404);

  const max = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM task_notes WHERE task_id = ?1`
  ).bind(taskId).first();

  const res = await c.env.DB.prepare(
    `INSERT INTO task_notes (task_id, body, sort_order, created_at, created_by, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?5)`
  ).bind(taskId, body, max.m + 1, nowIso(), actor.id).run();

  await touchProject(c.env, task.project_id, actor.id);
  await logAction(c.env, {
    actorId: actor.id, action: 'task_note_added', entityType: 'task', entityId: taskId,
    detail: `Note added to "${task.name}"`,
  });

  // Notify this task's other owners (never the person who just added the
  // note). Immediate, not rate limited, see notifyOtherOwnersOfNoteActivity.
  const project = await c.env.DB.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(task.project_id).first();
  const notified = project
    ? await notifyOtherOwnersOfNoteActivity(c.env, { task, project, actor, action: 'added', noteText: body })
    : [];

  return json(c, { ok: true, id: res.meta.last_row_id, notified });
});

app.patch('/api/tasks/:id/notes/:noteId', requireAuth, async (c) => {
  const taskId = Number(c.req.param('id'));
  const noteId = Number(c.req.param('noteId'));
  const actor = c.get('user');
  const { text } = await c.req.json().catch(() => ({}));
  const body = String(text || '').trim();
  if (!body) return json(c, { error: 'Note needs some text' }, 400);

  const note = await c.env.DB.prepare(
    `SELECT n.*, t.project_id FROM task_notes n JOIN tasks t ON t.id = n.task_id
      WHERE n.id = ?1 AND n.task_id = ?2`
  ).bind(noteId, taskId).first();
  if (!note) return json(c, { error: 'No such note' }, 404);

  await c.env.DB.prepare(
    `UPDATE task_notes SET body = ?1, updated_at = ?2, updated_by = ?3 WHERE id = ?4`
  ).bind(body, nowIso(), actor.id, noteId).run();

  await touchProject(c.env, note.project_id, actor.id);
  await logAction(c.env, {
    actorId: actor.id, action: 'task_note_updated', entityType: 'task', entityId: taskId,
    detail: `Note edited on task ${taskId}`,
  });

  // Same notification as adding a note: every other owner, never the editor.
  const task = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(taskId).first();
  const project = task ? await c.env.DB.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(note.project_id).first() : null;
  const notified = (task && project)
    ? await notifyOtherOwnersOfNoteActivity(c.env, { task, project, actor, action: 'edited', noteText: body })
    : [];

  return json(c, { ok: true, notified });
});

app.delete('/api/tasks/:id/notes/:noteId', requireAuth, async (c) => {
  const taskId = Number(c.req.param('id'));
  const noteId = Number(c.req.param('noteId'));
  const actor = c.get('user');

  const note = await c.env.DB.prepare(
    `SELECT n.*, t.project_id FROM task_notes n JOIN tasks t ON t.id = n.task_id
      WHERE n.id = ?1 AND n.task_id = ?2`
  ).bind(noteId, taskId).first();
  if (!note) return json(c, { error: 'No such note' }, 404);

  await c.env.DB.prepare(`DELETE FROM task_notes WHERE id = ?1`).bind(noteId).run();
  await touchProject(c.env, note.project_id, actor.id);
  await logAction(c.env, {
    actorId: actor.id, action: 'task_note_deleted', entityType: 'task', entityId: taskId,
    detail: `Note deleted from task ${taskId}`,
  });
  return json(c, { ok: true });
});

/** Admin-only: deleting captures a full snapshot first, so it can be undone
 * from the Activity Log if it turns out to be a mistake. */
app.delete('/api/tasks/:id', requireAuth, requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const actor = c.get('user');

  const task = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id = ?1`).bind(id).first();
  if (!task) return json(c, { error: 'No such task' }, 404);
  const owners = await c.env.DB.prepare(`SELECT user_id FROM task_owners WHERE task_id = ?1`).bind(id).all();
  const notes = await c.env.DB.prepare(
    `SELECT body, sort_order, created_at, created_by, updated_at, updated_by FROM task_notes WHERE task_id = ?1 ORDER BY sort_order`
  ).bind(id).all();

  await c.env.DB.prepare(`DELETE FROM tasks WHERE id = ?1`).bind(id).run();

  await logAction(c.env, {
    actorId: actor.id, action: 'task_deleted', entityType: 'task', entityId: id,
    snapshot: { ...task, ownerIds: owners.results.map((r) => r.user_id), notes: notes.results },
    detail: `"${task.name}" deleted from ${task.project_id}`,
  });
  return json(c, { ok: true });
});

/**
 * Replaces the owner set for a task. Emails anyone newly added.
 * `label` covers non-people such as 'Legal' or 'External (Discovery)', who
 * obviously cannot be emailed or nudged.
 */
app.put('/api/tasks/:id/owners', requireAuth, requireAdmin, async (c) => {
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
  await logAction(c.env, {
    actorId: actor.id, action: 'task_owners_changed', entityType: 'task', entityId: id,
    detail: `"${task.name}" owners set to [${userIds.join(', ') || 'none'}]${label ? ` (label: ${label})` : ''}`,
  });
  return json(c, { ok: true, notified });
});

/**
 * Shared by the manual Nudge button and the automatic due-date reminders:
 * checks the same per-person-per-task cooldown, sends via the same
 * sendEmail(), and records to the same `nudges` table either way. That
 * shared table + cutoff check is what makes a manual Nudge and an automatic
 * reminder dedupe against each other for free.
 *
 * @param {object} env
 * @param {object} opts
 * @param {object} opts.task
 * @param {object} opts.owner        {id, name, email}
 * @param {string} opts.sentById     users.id to record as the sender
 * @param {(url: string) => object} opts.buildMessage  returns a sendEmail() message
 * @returns {Promise<{sent: boolean, reason: 'cooldown'|'failed'|null}>}
 */
async function sendNudgeIfDue(env, { task, owner, sentById, buildMessage }) {
  const cutoff = new Date(Date.now() - NUDGE_COOLDOWN_HOURS * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);

  const recent = await env.DB.prepare(
    `SELECT sent_at FROM nudges WHERE task_id = ?1 AND sent_to = ?2 AND sent_at > ?3 LIMIT 1`
  ).bind(task.id, owner.id, cutoff).first();
  if (recent) return { sent: false, reason: 'cooldown' };

  const res = await sendEmail(env, buildMessage(`${env.APP_URL}/#${task.project_id}`));
  if (!res.ok) return { sent: false, reason: 'failed' };

  await env.DB.prepare(
    `INSERT INTO nudges (task_id, sent_by, sent_to) VALUES (?1, ?2, ?3)`
  ).bind(task.id, sentById, owner.id).run();
  return { sent: true, reason: null };
}

/**
 * The nudge button. Emails every human owner of a task asking for an update.
 *
 * Rate limited per person per task, for two reasons: it stops the button being
 * used as a stick, and it protects the EmailJS free allowance of 200/month.
 */
app.post('/api/tasks/:id/nudge', requireAuth, requireAdmin, async (c) => {
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

  const sent = [], skipped = [];
  for (const owner of owners.results) {
    if (owner.id === actor.id) { skipped.push(`${owner.name} (that is you)`); continue; }

    const result = await sendNudgeIfDue(c.env, {
      task, owner, sentById: actor.id,
      buildMessage: (url) => nudgeEmail(owner, task, project, actor, url),
    });
    if (result.sent) sent.push(owner.name);
    else if (result.reason === 'cooldown') skipped.push(`${owner.name} (nudged in the last ${NUDGE_COOLDOWN_HOURS}h)`);
    else skipped.push(`${owner.name} (email failed)`);
  }
  return json(c, { ok: true, sent, skipped });
});

/**
 * Automatic due-date reminders. Not an HTTP route: called from the
 * `scheduled` handler below (Cloudflare cron trigger), once a day.
 *
 * Picks up every task with a due date that is not 'done' and is within
 * DUE_REMINDER_LEAD_DAYS of its due date OR already overdue (no upper bound,
 * it keeps reminding daily until the task is marked done). Emails every
 * active human owner, subject to the same 24h cooldown as a manual Nudge via
 * sendNudgeIfDue(), so this can never double up with a Nudge someone already
 * sent today, or fire more than once a day per person even across several
 * qualifying tasks.
 */
export async function runDueDateReminders(env) {
  const today = new Date().toISOString().slice(0, 10);
  const cutoffDate = new Date(Date.now() + DUE_REMINDER_LEAD_DAYS * 86400000).toISOString().slice(0, 10);

  const due = await env.DB.prepare(
    `SELECT * FROM tasks WHERE due_date IS NOT NULL AND due_date <= ?1 AND status != 'done'`
  ).bind(cutoffDate).all();

  let remindersSent = 0;
  for (const task of due.results) {
    const project = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(task.project_id).first();
    // Archived projects are shelved on purpose; don't keep nagging owners
    // about tasks that belong to one.
    if (!project || project.archived) continue;

    const owners = await env.DB.prepare(
      `SELECT u.id, u.name, u.email FROM task_owners t
         JOIN users u ON u.id = t.user_id
        WHERE t.task_id = ?1 AND u.status = 'active' AND u.is_system = 0`
    ).bind(task.id).all();

    const isOverdue = task.due_date < today;
    for (const owner of owners.results) {
      const result = await sendNudgeIfDue(env, {
        task, owner, sentById: SYSTEM_USER_ID,
        buildMessage: (url) => dueDateReminderEmail(owner, task, project, url, isOverdue),
      });
      if (result.sent) remindersSent++;
    }
  }
  return { tasksChecked: due.results.length, remindersSent };
}

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
  await logAction(c.env, {
    actorId: c.get('user').id, action: 'focus_updated', entityType: 'settings', entityId: 'focus_this_week',
    detail: `This Week's focus set to: ${String(value || '').trim() || '(cleared)'}`,
  });
  return json(c, { ok: true });
});

app.put('/api/settings/leadership', requireAuth, requireAdmin, async (c) => {
  const { notes } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(notes)) return json(c, { error: 'notes must be an array' }, 400);
  const clean = notes.map((n) => String(n).trim()).filter(Boolean);
  await putSetting(c.env, 'leadership_notes', JSON.stringify(clean), c.get('user').id);
  await logAction(c.env, {
    actorId: c.get('user').id, action: 'leadership_updated', entityType: 'settings', entityId: 'leadership_notes',
    detail: `Leadership Flags updated (${clean.length} item${clean.length === 1 ? '' : 's'})`,
  });
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
  await logAction(c.env, {
    actorId: actor.id, action: 'user_approved', entityType: 'user', entityId: id,
    detail: `${target.name} (${target.email}) approved`,
  });
  return json(c, { ok: true, emailed: res.ok });
});

app.post('/api/users/:id/reject', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const actor = c.get('user');
  if (id === actor.id) return json(c, { error: 'You cannot reject yourself' }, 400);

  const target = await getUser(c.env, id);

  // Rejecting also kills any live session immediately.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET status = 'rejected' WHERE id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM magic_tokens WHERE user_id = ?1`).bind(id),
  ]);
  // No email. Telling someone they were rejected invites an argument.
  await logAction(c.env, {
    actorId: actor.id, action: 'user_rejected', entityType: 'user', entityId: id,
    detail: `${target?.name || id} (${target?.email || 'unknown'}) rejected`,
  });
  return json(c, { ok: true });
});

app.patch('/api/users/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const actor = c.get('user');
  const { role } = await c.req.json().catch(() => ({}));
  if (!['admin', 'member'].includes(role)) return json(c, { error: 'role must be admin or member' }, 400);

  // Guard against locking everyone out of admin.
  if (role === 'member' && id === actor.id) {
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`
    ).first();
    if (count.n <= 1) return json(c, { error: 'You are the last admin' }, 400);
  }

  const target = await getUser(c.env, id);
  await c.env.DB.prepare(`UPDATE users SET role = ?1 WHERE id = ?2`).bind(role, id).run();
  await logAction(c.env, {
    actorId: actor.id, action: 'user_role_changed', entityType: 'user', entityId: id,
    detail: `${target?.name || id} role changed from ${target?.role || '?'} to ${role}`,
  });
  return json(c, { ok: true });
});

// ===========================================================================
// AUDIT LOG (admin only)
// ===========================================================================

app.get('/api/audit', requireAuth, requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at, a.restored_at,
            u.name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT 200`
  ).all();
  return json(c, rows.results.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    detail: r.detail,
    at: r.created_at,
    actor: r.actor_name || r.actor_id,
    restorable: r.action === 'task_deleted' && !r.restored_at,
    restoredAt: r.restored_at,
  })));
});

/** Brings a deleted task back to life from its logged snapshot. */
app.post('/api/audit/:id/restore', requireAuth, requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const actor = c.get('user');

  const entry = await c.env.DB.prepare(`SELECT * FROM audit_log WHERE id = ?1`).bind(id).first();
  if (!entry) return json(c, { error: 'No such log entry' }, 404);
  if (entry.action !== 'task_deleted') return json(c, { error: 'Only a deleted task can be restored' }, 400);
  if (entry.restored_at) return json(c, { error: 'Already restored' }, 400);

  const snap = safeParse(entry.snapshot, null);
  if (!snap) return json(c, { error: 'Nothing to restore, no snapshot was saved' }, 400);

  const existing = await c.env.DB.prepare(`SELECT 1 FROM projects WHERE id = ?1`).bind(snap.project_id).first();
  if (!existing) return json(c, { error: 'The project this task belonged to no longer exists' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO tasks (id, project_id, name, status, due_date, due_time, note, owner_label, sort_order, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
  ).bind(
    snap.id, snap.project_id, snap.name, snap.status, snap.due_date, snap.due_time ?? null,
    snap.note, snap.owner_label, snap.sort_order, nowIso(), actor.id,
  ).run();

  if (Array.isArray(snap.ownerIds) && snap.ownerIds.length) {
    await c.env.DB.batch(snap.ownerIds.map((uid) =>
      c.env.DB.prepare(`INSERT INTO task_owners (task_id, user_id) VALUES (?1, ?2)`).bind(snap.id, uid)
    ));
  }
  if (Array.isArray(snap.notes) && snap.notes.length) {
    await c.env.DB.batch(snap.notes.map((n) =>
      c.env.DB.prepare(
        `INSERT INTO task_notes (task_id, body, sort_order, created_at, created_by, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(snap.id, n.body, n.sort_order, n.created_at, n.created_by, n.updated_at, n.updated_by)
    ));
  }

  await c.env.DB.prepare(`UPDATE audit_log SET restored_at = ?1 WHERE id = ?2`).bind(nowIso(), id).run();
  await touchProject(c.env, snap.project_id, actor.id);
  await logAction(c.env, {
    actorId: actor.id, action: 'task_restored', entityType: 'task', entityId: snap.id,
    detail: `"${snap.name}" restored from the Activity Log`,
  });
  return json(c, { ok: true, id: snap.id });
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

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // Cloudflare cron trigger, see wrangler.toml [triggers]. Runs once a day;
  // waitUntil keeps the Worker alive until every reminder email is sent.
  scheduled: async (event, env, ctx) => {
    ctx.waitUntil(runDueDateReminders(env));
  },
};
