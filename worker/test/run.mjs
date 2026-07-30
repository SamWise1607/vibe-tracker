/**
 * End-to-end tests for the VIBE tracker API.
 * Run:  npm test        (or: node test/run.mjs)
 */

import { fileURLToPath } from 'node:url';
import app from '../src/index.js';
import {
  makeEnv, installFakeEmail, outbox, req, cookieFrom,
  tokenFromLastEmail, check, section, results,
} from './harness.mjs';

// fileURLToPath, not .pathname. On Windows .pathname yields "/C:/Users/..."
// with a leading slash, which Node then resolves to "C:\C:\Users\...".
const paths = { schema: fileURLToPath(new URL('../schema.sql', import.meta.url)),
                seed:   fileURLToPath(new URL('../seed.sql',   import.meta.url)) };

let env;
const call = (path, opts) => app.fetch(req(path, opts), env);
const jsonOf = async (res) => { try { return await res.json(); } catch { return null; } };

/** Signs a user in and returns their session cookie. */
async function signIn(email) {
  await call('/api/auth/request', { method: 'POST', body: { email } });
  const token = tokenFromLastEmail();
  const res = await app.fetch(req(`/api/auth/verify?token=${token}`), env);
  return cookieFrom(res);
}

// ===========================================================================

env = makeEnv(paths);
installFakeEmail();

section('Seed data loaded correctly');
{
  const n = (sql) => env._rawDb.prepare(sql).get().n;
  check('6 users seeded',      n('SELECT COUNT(*) n FROM users') === 6);
  check('6 projects seeded',   n('SELECT COUNT(*) n FROM projects') === 6);
  check('36 tasks seeded',     n('SELECT COUNT(*) n FROM tasks') === 36);
  check('3 admins',            n("SELECT COUNT(*) n FROM users WHERE role='admin'") === 3);
  check('multi-owner tasks split into rows',
        n("SELECT COUNT(*) n FROM (SELECT task_id FROM task_owners GROUP BY task_id HAVING COUNT(*)>1)") === 2);
}

section('Auth: unauthenticated access is refused');
{
  for (const path of ['/api/state', '/api/me', '/api/users']) {
    const res = await call(path);
    check(`${path} returns 401 when signed out`, res.status === 401, `got ${res.status}`);
  }
  const res = await call('/api/settings/focus', { method: 'PUT', body: { value: 'x' } });
  check('PUT /api/settings/focus returns 401 when signed out', res.status === 401);
}

section('Auth: magic link');
{
  outbox.length = 0;
  const res = await call('/api/auth/request', { method: 'POST', body: { email: 'sam@visionbrokers.co.za' } });
  const body = await jsonOf(res);
  check('request returns generic message', body.ok === true && /check your inbox/i.test(body.message));
  check('exactly one email sent', outbox.length === 1, `sent ${outbox.length}`);
  check('email went to Sam', outbox[0]?.to_email === 'sam@visionbrokers.co.za');
  check('email contains a token link', /token=[a-f0-9]{64}/.test(outbox[0]?.cta_url || ''), outbox[0]?.cta_url);

  const token = tokenFromLastEmail();
  const verify = await app.fetch(req(`/api/auth/verify?token=${token}`), env);
  check('verify redirects (302)', verify.status === 302, `got ${verify.status}`);
  check('verify sets an HttpOnly Secure cookie',
        /HttpOnly/.test(verify.headers.get('Set-Cookie') || '') &&
        /Secure/.test(verify.headers.get('Set-Cookie') || ''));

  const cookie = cookieFrom(verify);
  const me = await jsonOf(await call('/api/me', { cookie }));
  check('session identifies Sam as admin', me?.id === 'sam' && me?.role === 'admin', JSON.stringify(me));

  // Single use
  const replay = await app.fetch(req(`/api/auth/verify?token=${token}`), env);
  check('token cannot be reused', (replay.headers.get('Location') || '').includes('error=invalid_link'),
        replay.headers.get('Location'));

  const bogus = await app.fetch(req('/api/auth/verify?token=deadbeef'), env);
  check('bogus token rejected', (bogus.headers.get('Location') || '').includes('error=invalid_link'));
}

section('Auth: unknown address creates a join request');
{
  outbox.length = 0;
  const res = await call('/api/auth/request', { method: 'POST', body: { email: 'stranger@example.com', name: 'Stranger' } });
  const body = await jsonOf(res);
  check('response is identical to a known address (no enumeration)',
        body.ok === true && /check your inbox/i.test(body.message));

  const row = env._rawDb.prepare("SELECT status, role FROM users WHERE email='stranger@example.com'").get();
  check('pending user created', row?.status === 'pending' && row?.role === 'member', JSON.stringify(row));
  check('all 3 admins notified', outbox.length === 3, `got ${outbox.length}`);
  check('no login link sent to the stranger',
        !outbox.some((m) => m.to_email === 'stranger@example.com'));

  outbox.length = 0;
  await call('/api/auth/request', { method: 'POST', body: { email: 'stranger@example.com' } });
  check('repeat request does not re-spam admins', outbox.length === 0, `got ${outbox.length}`);

  const pending = await call('/api/auth/request', { method: 'POST', body: { email: 'stranger@example.com' } });
  check('pending user still cannot sign in', (await jsonOf(pending)).ok === true && outbox.length === 0);
}

section('State endpoint shape');
{
  const cookie = await signIn('deoni@visionric.co.za');
  const state = await jsonOf(await call('/api/state', { cookie }));

  check('has me / focusThisWeek / leaderNotes / initiatives',
        state.me && 'focusThisWeek' in state && Array.isArray(state.leaderNotes) && Array.isArray(state.initiatives));
  check('6 initiatives, ordered by num',
        state.initiatives.length === 6 && state.initiatives.every((p, i) => p.num === i + 1));
  check('leaderNotes parsed from JSON into 4 strings', state.leaderNotes.length === 4, `got ${state.leaderNotes.length}`);
  check('focusThisWeek is the Fortress line', /Fortress/.test(state.focusThisWeek), state.focusThisWeek);

  const fortress = state.initiatives[0];
  check('Fortress keeps its draft fields',
        fortress.id === 'fortress' && fortress.status === 'at-risk' &&
        fortress.targetDate === '2026-08-31' && fortress.keyRisk.length === 4);
  check('project owners are {id,name} objects, not strings',
        fortress.owners.every((o) => o.id && o.name), JSON.stringify(fortress.owners));
  check('Fortress has 7 tasks', fortress.tasks.length === 7, `got ${fortress.tasks.length}`);

  const social = fortress.tasks.find((t) => /Social media/.test(t.name));
  check('"Deoni / Mia" became two real owners',
        social.owners.length === 2 && social.owners.map((o) => o.id).sort().join(',') === 'deoni,mia',
        JSON.stringify(social.owners));

  const marketing = fortress.tasks.find((t) => /marketing material/.test(t.name));
  check('non-person owner kept as a label', marketing.ownerLabel === 'Unassigned' && marketing.owners.length === 0);

  const vres = state.initiatives[3].tasks.find((t) => /Propcon/.test(t.name));
  check('the draft\'s hidden "paused" task status survives', vres.status === 'paused', vres.status);

  check('every task exposes a numeric id for the UI',
        state.initiatives.flatMap((p) => p.tasks).every((t) => Number.isInteger(t.id)));
}

section('Tasks: create, update, delete');
{
  const cookie = await signIn('sam@visionbrokers.co.za');

  const created = await jsonOf(await call('/api/projects/fortress/tasks', { method: 'POST', cookie, body: { name: 'Test task' } }));
  check('task created and returns an id', created.ok && Number.isInteger(created.id), JSON.stringify(created));

  const blank = await call('/api/projects/fortress/tasks', { method: 'POST', cookie, body: { name: '  ' } });
  check('blank task name rejected', blank.status === 400);

  await call(`/api/tasks/${created.id}`, { method: 'PATCH', cookie, body: { status: 'in-progress', due: '2026-09-01' } });
  let row = env._rawDb.prepare('SELECT * FROM tasks WHERE id=?').get(created.id);
  check('status and due both persisted',
        row.status === 'in-progress' && row.due_date === '2026-09-01',
        JSON.stringify(row));

  await call(`/api/tasks/${created.id}`, { method: 'PATCH', cookie, body: { due: '' } });
  row = env._rawDb.prepare('SELECT due_date FROM tasks WHERE id=?').get(created.id);
  check('clearing a date stores NULL, not empty string', row.due_date === null, JSON.stringify(row));

  await call(`/api/tasks/${created.id}`, { method: 'DELETE', cookie });
  check('task deleted', !env._rawDb.prepare('SELECT 1 FROM tasks WHERE id=?').get(created.id));
}

section('Notifications: adding an owner');
{
  const cookie = await signIn('sam@visionbrokers.co.za');
  outbox.length = 0;

  const res = await jsonOf(await call('/api/projects/vib/owners', { method: 'POST', cookie, body: { userId: 'mia' } }));
  check('Mia added to VIB', res.ok && res.emailed);
  check('one email sent', outbox.length === 1, `got ${outbox.length}`);
  check('email addressed to Mia', outbox[0]?.to_email === 'mia@visionbrokers.co.za');
  check('subject names the project', /VIB Website Rebuild/.test(outbox[0]?.subject || ''), outbox[0]?.subject);

  outbox.length = 0;
  const dup = await jsonOf(await call('/api/projects/vib/owners', { method: 'POST', cookie, body: { userId: 'mia' } }));
  check('adding twice is a no-op', dup.alreadyOwner === true && outbox.length === 0);

  outbox.length = 0;
  await call('/api/projects/vib/owners', { method: 'POST', cookie, body: { userId: 'sam' } });
  check('no self-notification when you add yourself', outbox.length === 0, `got ${outbox.length}`);

  const ghost = await call('/api/projects/vib/owners', { method: 'POST', cookie, body: { userId: 'nobody' } });
  check('unknown user rejected', ghost.status === 404);
}

section('Notifications: task assignment');
{
  const cookie = await signIn('deoni@visionric.co.za');
  const taskId = env._rawDb.prepare("SELECT id FROM tasks WHERE name LIKE 'Register domain%'").get().id;
  outbox.length = 0;

  const res = await jsonOf(await call(`/api/tasks/${taskId}/owners`, { method: 'PUT', cookie, body: { userIds: ['sam', 'stan'] } }));
  check('only the newly added owner is emailed', res.notified.length === 1 && res.notified[0] === 'Stan',
        JSON.stringify(res.notified));
  check('Sam not re-emailed for a task he already owned', !outbox.some((m) => m.to_email.startsWith('sam@')));

  outbox.length = 0;
  await call(`/api/tasks/${taskId}/owners`, { method: 'PUT', cookie, body: { userIds: [], label: 'Legal' } });
  const row = env._rawDb.prepare('SELECT owner_label FROM tasks WHERE id=?').get(taskId);
  check('owners can be swapped for a non-person label', row.owner_label === 'Legal' && outbox.length === 0);
}

section('Nudge button');
{
  const cookie = await signIn('sam@visionbrokers.co.za');
  const taskId = env._rawDb.prepare("SELECT id FROM tasks WHERE name LIKE 'Contact pilot partners%'").get().id;
  outbox.length = 0;

  const res = await jsonOf(await call(`/api/tasks/${taskId}/nudge`, { method: 'POST', cookie }));
  check('Elrine nudged', res.sent?.includes('Elrine'), JSON.stringify(res));
  check('one nudge email sent', outbox.length === 1);
  check('nudge subject asks for an update', /Update needed/.test(outbox[0]?.subject || ''));
  check('nudge body includes current status', /Not started/.test(outbox[0]?.body || ''), outbox[0]?.body);

  outbox.length = 0;
  const again = await jsonOf(await call(`/api/tasks/${taskId}/nudge`, { method: 'POST', cookie }));
  check('rate limit blocks a second nudge inside 24h', again.sent.length === 0 && again.skipped.length === 1,
        JSON.stringify(again));
  check('no email sent on the blocked nudge', outbox.length === 0);

  const legalTask = env._rawDb.prepare("SELECT id FROM tasks WHERE owner_label='Legal' LIMIT 1").get().id;
  const noOne = await call(`/api/tasks/${legalTask}/nudge`, { method: 'POST', cookie });
  check('cannot nudge a non-person owner', noOne.status === 400, `got ${noOne.status}`);

  // Self-nudge
  const own = env._rawDb.prepare(
    "SELECT t.id FROM tasks t JOIN task_owners o ON o.task_id=t.id WHERE o.user_id='sam' LIMIT 1"
  ).get().id;
  outbox.length = 0;
  const self = await jsonOf(await call(`/api/tasks/${own}/nudge`, { method: 'POST', cookie }));
  check('nudging yourself sends nothing', outbox.length === 0 && /that is you/.test(JSON.stringify(self.skipped)));
}

section('Permissions: members cannot do admin things');
{
  const member = await signIn('mia@visionbrokers.co.za');
  const admin  = await signIn('ferdi@visionpw.co.za');

  const cases = [
    ['PUT',  '/api/settings/focus',        { value: 'hacked' }],
    ['PUT',  '/api/settings/leadership',   { notes: ['hacked'] }],
    ['PUT',  '/api/projects/fortress/risks', { risks: ['hacked'] }],
    ['POST', '/api/users/stan/approve',    {}],
    ['POST', '/api/users/stan/reject',     {}],
    ['PATCH','/api/users/stan',            { role: 'admin' }],
  ];
  for (const [method, path, body] of cases) {
    const res = await call(path, { method, cookie: member, body });
    check(`member gets 403 on ${method} ${path}`, res.status === 403, `got ${res.status}`);
  }

  const ok = await call('/api/settings/focus', { method: 'PUT', cookie: admin, body: { value: 'New focus' } });
  check('admin can set the focus', ok.status === 200);
  const state = await jsonOf(await call('/api/state', { cookie: member }));
  check('focus change is visible to everyone', state.focusThisWeek === 'New focus', state.focusThisWeek);

  // Members can still do normal work
  const task = await call('/api/projects/fortress/tasks', { method: 'POST', cookie: member, body: { name: 'Member task' } });
  check('member can still add a task', task.status === 200);
}

section('State: task visibility is scoped for members, not for admins');
{
  const member = await signIn('mia@visionbrokers.co.za');
  const admin  = await signIn('deoni@visionric.co.za');

  const memberState = await jsonOf(await call('/api/state', { cookie: member }));
  const memberTasks = memberState.initiatives.flatMap((p) => p.tasks);
  check('Mia sees at least one task', memberTasks.length > 0);
  check('every task Mia sees actually has her as an owner',
        memberTasks.every((t) => (t.owners || []).some((o) => o.id === 'mia')),
        JSON.stringify(memberTasks.map((t) => t.id)));
  check('Mia cannot see task 24, which is Stan-only', !memberTasks.some((t) => t.id === 24));

  const adminState = await jsonOf(await call('/api/state', { cookie: admin }));
  const adminTasks = adminState.initiatives.flatMap((p) => p.tasks);
  check('admin still sees task 24', adminTasks.some((t) => t.id === 24));
  check('admin sees more tasks overall than the member does', adminTasks.length > memberTasks.length,
        `admin ${adminTasks.length} vs member ${memberTasks.length}`);

  check('ferdiDecisions is present for a member too',
        Array.isArray(memberState.ferdiDecisions) && memberState.ferdiDecisions.length > 0,
        JSON.stringify(memberState.ferdiDecisions));
  check('ferdiDecisions items are all actually Ferdi\'s, regardless of viewer',
        memberState.ferdiDecisions.every((t) => (t.owners || []).some((o) => o.id === 'ferdi')));
}

section('Permissions: members can only edit tasks they own, and only status');
{
  const member = await signIn('mia@visionbrokers.co.za');

  // Task 23 (mrcn): Mia is a co-owner.
  const ok = await call('/api/tasks/23', {
    method: 'PATCH', cookie: member,
    body: { status: 'in-progress', name: 'hacked name' },
  });
  check('member can update status on her own task', ok.status === 200, `got ${ok.status}`);
  const row = env._rawDb.prepare('SELECT status, name FROM tasks WHERE id=23').get();
  check('status applied', row.status === 'in-progress', JSON.stringify(row));
  check('name field silently ignored for a member', row.name !== 'hacked name', row.name);

  // Task 24 (vib): only Stan owns it.
  const forbidden = await call('/api/tasks/24', { method: 'PATCH', cookie: member, body: { status: 'blocked' } });
  check('member gets 403 editing a task she does not own', forbidden.status === 403, `got ${forbidden.status}`);

  const admin = await signIn('sam@visionbrokers.co.za');
  const adminEdit = await call('/api/tasks/24', { method: 'PATCH', cookie: admin, body: { due: '2026-10-01' } });
  check('admin can edit any task regardless of ownership', adminEdit.status === 200, `got ${adminEdit.status}`);
}

section('Task notes: multiple boxes per task, any signed-in user');
{
  const admin = await signIn('sam@visionbrokers.co.za');
  const member = await signIn('mia@visionbrokers.co.za');

  // Task 24 (vib) is Stan-only. Mia does not own it, but notes are open to
  // any signed-in user regardless of ownership.
  const add1 = await jsonOf(await call('/api/tasks/24/notes', { method: 'POST', cookie: member, body: { text: 'first note' } }));
  check('a non-owner member can add a note', add1.ok && Number.isInteger(add1.id), JSON.stringify(add1));

  const add2 = await jsonOf(await call('/api/tasks/24/notes', { method: 'POST', cookie: admin, body: { text: 'second note' } }));
  check('a second note becomes its own box, not an overwrite', add2.ok && add2.id !== add1.id, JSON.stringify(add2));

  const blank = await call('/api/tasks/24/notes', { method: 'POST', cookie: member, body: { text: '   ' } });
  check('blank note text rejected', blank.status === 400);

  const missing = await call('/api/tasks/99999/notes', { method: 'POST', cookie: member, body: { text: 'x' } });
  check('adding a note to a non-existent task 404s', missing.status === 404);

  const state = await jsonOf(await call('/api/state', { cookie: admin }));
  const task24 = state.initiatives.flatMap((p) => p.tasks).find((t) => t.id === 24);
  const newest = task24.notes.slice(-2);
  check('GET /api/state exposes both new notes as separate {id, text} boxes, in order, appended after the seeded one',
        newest.length === 2 && newest[0].text === 'first note' && newest[1].text === 'second note',
        JSON.stringify(task24.notes));

  const edit = await call(`/api/tasks/24/notes/${add1.id}`, { method: 'PATCH', cookie: admin, body: { text: 'edited note' } });
  check('any signed-in user can edit a note someone else wrote', edit.status === 200, `got ${edit.status}`);
  const editedRow = env._rawDb.prepare('SELECT body FROM task_notes WHERE id=?').get(add1.id);
  check('edit persisted', editedRow.body === 'edited note', JSON.stringify(editedRow));

  const wrongTask = await call(`/api/tasks/23/notes/${add1.id}`, { method: 'PATCH', cookie: admin, body: { text: 'x' } });
  check('editing a note under the wrong task id 404s', wrongTask.status === 404);

  const del = await call(`/api/tasks/24/notes/${add2.id}`, { method: 'DELETE', cookie: member });
  check('any signed-in user can delete a note', del.status === 200, `got ${del.status}`);
  check('note actually gone', !env._rawDb.prepare('SELECT 1 FROM task_notes WHERE id=?').get(add2.id));

  const stateAfter = await jsonOf(await call('/api/state', { cookie: admin }));
  const task24After = stateAfter.initiatives.flatMap((p) => p.tasks).find((t) => t.id === 24);
  check('deleted note box is gone, the other two remain',
        task24After.notes.length === task24.notes.length - 1 && !task24After.notes.some((n) => n.id === add2.id),
        JSON.stringify(task24After.notes));
}

section('Projects: create and rename, admin-only');
{
  const member = await signIn('mia@visionbrokers.co.za');
  const admin  = await signIn('sam@visionbrokers.co.za');

  const memberCreate = await call('/api/projects', { method: 'POST', cookie: member, body: { name: 'Should not exist' } });
  check('member gets 403 creating a project', memberCreate.status === 403, `got ${memberCreate.status}`);

  const blank = await call('/api/projects', { method: 'POST', cookie: admin, body: { name: '   ' } });
  check('blank project name rejected', blank.status === 400);

  const created = await jsonOf(await call('/api/projects', { method: 'POST', cookie: admin, body: { name: 'Test Project' } }));
  check('project created and returns an id', created.ok && typeof created.id === 'string', JSON.stringify(created));
  check('id is slugified from the name', created.id === 'test-project', created.id);

  const dup = await jsonOf(await call('/api/projects', { method: 'POST', cookie: admin, body: { name: 'Test Project' } }));
  check('a name collision gets a numbered suffix instead of overwriting', dup.id === 'test-project-2', dup.id);

  const state = await jsonOf(await call('/api/state', { cookie: admin }));
  const newProject = state.initiatives.find((p) => p.id === created.id);
  check('new project appears in state with defaults',
        newProject && newProject.name === 'Test Project' && newProject.status === 'on-track' && newProject.tasks.length === 0,
        JSON.stringify(newProject));
  check('new project got the 7th num (after the 6 seeded projects)', newProject.num === 7, newProject.num);

  const memberRename = await call(`/api/projects/${created.id}`, { method: 'PATCH', cookie: member, body: { name: 'Hacked' } });
  check('member gets 403 renaming a project', memberRename.status === 403, `got ${memberRename.status}`);
  const unchanged = env._rawDb.prepare('SELECT name FROM projects WHERE id=?').get(created.id);
  check('name unchanged after the rejected member rename', unchanged.name === 'Test Project', unchanged.name);

  const rename = await call(`/api/projects/${created.id}`, { method: 'PATCH', cookie: admin, body: { name: 'Renamed Project' } });
  check('admin can rename a project', rename.status === 200, `got ${rename.status}`);
  const renamed = env._rawDb.prepare('SELECT name FROM projects WHERE id=?').get(created.id);
  check('rename persisted', renamed.name === 'Renamed Project', renamed.name);

  const blankRename = await call(`/api/projects/${created.id}`, { method: 'PATCH', cookie: admin, body: { name: '  ' } });
  check('blank rename rejected', blankRename.status === 400);
}

section('Permissions: nudge, delete and reassigning owners are admin-only');
{
  const member = await signIn('mia@visionbrokers.co.za');

  const del = await call('/api/tasks/24', { method: 'DELETE', cookie: member });
  check('member gets 403 deleting a task', del.status === 403, `got ${del.status}`);

  const own = await call('/api/tasks/24/owners', { method: 'PUT', cookie: member, body: { userIds: ['mia'] } });
  check('member gets 403 reassigning task owners', own.status === 403, `got ${own.status}`);

  const nudge = await call('/api/tasks/23/nudge', { method: 'POST', cookie: member });
  check('member gets 403 nudging', nudge.status === 403, `got ${nudge.status}`);

  check('task 24 still exists, member could not delete it',
        !!env._rawDb.prepare('SELECT 1 FROM tasks WHERE id=24').get());
}

section('Tasks: adding a task assigns a member to themselves only');
{
  const member = await signIn('stanford@visionbrokers.co.za');
  const created = await jsonOf(await call('/api/projects/fortress/tasks', {
    method: 'POST', cookie: member, body: { name: 'Stan self task', ownerIds: ['mia'] },
  }));
  check('task created', created.ok && Number.isInteger(created.id), JSON.stringify(created));

  const owners = env._rawDb.prepare(`SELECT user_id FROM task_owners WHERE task_id=${created.id}`).all().map((r) => r.user_id);
  check('member cannot assign it to someone else, forced to self',
        owners.length === 1 && owners[0] === 'stan', JSON.stringify(owners));

  const admin = await signIn('sam@visionbrokers.co.za');
  const byAdmin = await jsonOf(await call('/api/projects/fortress/tasks', {
    method: 'POST', cookie: admin, body: { name: 'Admin-assigned task', ownerIds: ['mia', 'stan'] },
  }));
  const adminOwners = env._rawDb.prepare(`SELECT user_id FROM task_owners WHERE task_id=${byAdmin.id}`)
    .all().map((r) => r.user_id).sort();
  check('admin can assign a new task to whoever they choose', adminOwners.join(',') === 'mia,stan', JSON.stringify(adminOwners));
}

section('Audit log: task delete captures a snapshot and can be restored');
{
  const admin = await signIn('sam@visionbrokers.co.za');
  const member = await signIn('mia@visionbrokers.co.za');

  const beforeOwners = env._rawDb.prepare('SELECT user_id FROM task_owners WHERE task_id=24').all().map((r) => r.user_id).sort();
  const del = await call('/api/tasks/24', { method: 'DELETE', cookie: admin });
  check('admin can delete a task', del.status === 200, `got ${del.status}`);
  check('task 24 is actually gone', !env._rawDb.prepare('SELECT 1 FROM tasks WHERE id=24').get());

  const log = await jsonOf(await call('/api/audit', { cookie: admin }));
  const entry = log.find((l) => l.action === 'task_deleted' && l.entityId === '24');
  check('deletion shows up in the audit log', !!entry, JSON.stringify(log[0]));
  check('log entry is marked restorable', entry?.restorable === true);

  const memberView = await call('/api/audit', { cookie: member });
  check('member gets 403 on the audit log', memberView.status === 403, `got ${memberView.status}`);

  const restore = await jsonOf(await call(`/api/audit/${entry.id}/restore`, { method: 'POST', cookie: admin }));
  check('restore succeeds', restore.ok === true, JSON.stringify(restore));
  const restored = env._rawDb.prepare('SELECT * FROM tasks WHERE id=24').get();
  check('task 24 exists again with its original name',
        restored?.name === 'Timebox modify-vs-rebuild test on weakest page (2-3hrs)', JSON.stringify(restored));
  const restoredOwners = env._rawDb.prepare('SELECT user_id FROM task_owners WHERE task_id=24').all().map((r) => r.user_id).sort();
  check('owners restored too', restoredOwners.join(',') === beforeOwners.join(','), JSON.stringify(restoredOwners));

  const again = await call(`/api/audit/${entry.id}/restore`, { method: 'POST', cookie: admin });
  check('restoring the same entry twice is rejected', again.status === 400, `got ${again.status}`);

  const memberRestore = await call(`/api/audit/${entry.id}/restore`, { method: 'POST', cookie: member });
  check('member gets 403 trying to restore', memberRestore.status === 403, `got ${memberRestore.status}`);
}

section('Admin: approving and rejecting people');
{
  const admin = await signIn('sam@visionbrokers.co.za');
  const stranger = env._rawDb.prepare("SELECT id FROM users WHERE email='stranger@example.com'").get().id;

  outbox.length = 0;
  const res = await jsonOf(await call(`/api/users/${stranger}/approve`, { method: 'POST', cookie: admin }));
  check('approval succeeds and emails them', res.ok && res.emailed);
  check('approval email carries a login link', /token=[a-f0-9]{64}/.test(outbox[0]?.cta_url || ''));

  const cookie = await signIn('stranger@example.com');
  const me = await jsonOf(await call('/api/me', { cookie }));
  check('approved user can now sign in', me?.email === 'stranger@example.com', JSON.stringify(me));

  outbox.length = 0;
  await call(`/api/users/${stranger}/reject`, { method: 'POST', cookie: admin });
  check('rejection sends no email (avoids an argument)', outbox.length === 0);

  const after = await call('/api/me', { cookie });
  check('rejection kills the live session immediately', after.status === 401, `got ${after.status}`);

  const selfReject = await call('/api/users/sam/reject', { method: 'POST', cookie: admin });
  check('admin cannot reject themselves', selfReject.status === 400);
}

section('Admin: last-admin guard');
{
  const admin = await signIn('sam@visionbrokers.co.za');
  await call('/api/users/deoni', { method: 'PATCH', cookie: admin, body: { role: 'member' } });
  await call('/api/users/ferdi', { method: 'PATCH', cookie: admin, body: { role: 'member' } });

  const res = await call('/api/users/sam', { method: 'PATCH', cookie: admin, body: { role: 'member' } });
  check('cannot demote the last remaining admin', res.status === 400, `got ${res.status}`);
  const bad = await call('/api/users/sam', { method: 'PATCH', cookie: admin, body: { role: 'wizard' } });
  check('invalid role rejected', bad.status === 400);
}

section('Resilience: email failure must not break the action');
{
  env = makeEnv(paths);
  const { installFakeEmail: install } = await import('./harness.mjs');
  install({ failNext: true });

  // Sign in has to work even though the send fails, so do it via the DB directly.
  const { createMagicLink } = await import('../src/auth.js');
  const url = await createMagicLink(env, 'sam');
  const token = url.match(/token=([a-f0-9]+)/)[1];
  const cookie = cookieFrom(await app.fetch(req(`/api/auth/verify?token=${token}`), env));

  const res = await jsonOf(await call('/api/projects/vib/owners', { method: 'POST', cookie, body: { userId: 'mia' } }));
  check('owner still added when the email provider is down', res.ok === true && res.emailed === false, JSON.stringify(res));
  const row = env._rawDb.prepare("SELECT 1 x FROM project_owners WHERE project_id='vib' AND user_id='mia'").get();
  check('database write committed regardless', !!row);
}

section('Logout');
{
  env = makeEnv(paths);
  installFakeEmail();
  const cookie = await signIn('sam@visionbrokers.co.za');
  check('signed in before logout', (await call('/api/me', { cookie })).status === 200);
  await call('/api/auth/logout', { method: 'POST', cookie });
  check('session destroyed after logout', (await call('/api/me', { cookie })).status === 401);
}

section('Unknown endpoints');
{
  const res = await call('/api/nonsense');
  check('unknown /api route returns 404 JSON', res.status === 404);
}

// ===========================================================================

console.log(`\n${'─'.repeat(58)}`);
console.log(`  ${results.passed} passed, ${results.failed} failed`);
if (results.failed) {
  console.log('\n  Failures:');
  results.failures.forEach((f) => console.log(`    - ${f}`));
}
console.log(`${'─'.repeat(58)}\n`);
process.exit(results.failed ? 1 : 0);
