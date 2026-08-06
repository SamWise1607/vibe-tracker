/**
 * End-to-end tests for the VIBE tracker API.
 * Run:  npm test        (or: node test/run.mjs)
 */

import { fileURLToPath } from 'node:url';
import app, { runDueDateReminders } from '../src/index.js';
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
  check('6 real users seeded', n('SELECT COUNT(*) n FROM users WHERE is_system = 0') === 6);
  check('plus the 1 system user for automated reminders',
        n("SELECT COUNT(*) n FROM users WHERE is_system = 1 AND id = 'system'") === 1);
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

section('The automated-reminder system user is hidden from /api/users');
{
  const adminCookie = await signIn('sam@visionbrokers.co.za');
  const adminList = await jsonOf(await call('/api/users', { cookie: adminCookie }));
  check('admin user list excludes the system user',
        !adminList.some((u) => u.id === 'system'), JSON.stringify(adminList.map((u) => u.id)));

  const memberCookie = await signIn('mia@visionbrokers.co.za');
  const memberList = await jsonOf(await call('/api/users', { cookie: memberCookie }));
  check('member user list excludes the system user',
        !memberList.some((u) => u.id === 'system'), JSON.stringify(memberList.map((u) => u.id)));
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

section('State: all projects are visible to everyone, member or admin (changed 6 Aug 2026)');
{
  const member = await signIn('mia@visionbrokers.co.za');
  const admin  = await signIn('deoni@visionric.co.za');

  const memberState = await jsonOf(await call('/api/state', { cookie: member }));
  const memberProjectIds = memberState.initiatives.map((p) => p.id);
  const memberTasks = memberState.initiatives.flatMap((p) => p.tasks);
  check('Mia sees at least one task', memberTasks.length > 0);

  // The old rule (project owner OR task owner, otherwise the project
  // disappears entirely) is gone. A member now sees every project and every
  // task on it, exactly like an admin, including ones they own no stake in
  // at all: vdirect (sam/elrine/"External (Discovery)" own its tasks, not
  // Mia) and task 28 on it are both now visible to her.
  check('Mia sees vdirect even though she owns nothing there', memberProjectIds.includes('vdirect'));
  check('Mia sees task 28 on vdirect', memberTasks.some((t) => t.id === 28));
  check('Mia sees fortress', memberProjectIds.includes('fortress'));
  check('Mia sees mrcn', memberProjectIds.includes('mrcn'));
  check('Mia sees vpic', memberProjectIds.includes('vpic'));
  const fortressForMia = memberState.initiatives.find((p) => p.id === 'fortress');
  check('Mia sees ALL of fortress\'s tasks, not just her own (task 1, owned by Deoni only, is visible to her)',
        fortressForMia.tasks.some((t) => t.id === 1 && !(t.owners || []).some((o) => o.id === 'mia')),
        JSON.stringify(fortressForMia.tasks.map((t) => t.id)));

  const adminState = await jsonOf(await call('/api/state', { cookie: admin }));
  const adminTasks = adminState.initiatives.flatMap((p) => p.tasks);
  check('admin still sees task 24', adminTasks.some((t) => t.id === 24));
  check('admin and member see the exact same set of projects now',
        JSON.stringify(memberProjectIds.slice().sort()) === JSON.stringify(adminState.initiatives.map((p) => p.id).sort()),
        `admin ${JSON.stringify(adminState.initiatives.map((p) => p.id))} vs member ${JSON.stringify(memberProjectIds)}`);
  check('admin and member see the same number of tasks overall',
        adminTasks.length === memberTasks.length,
        `admin ${adminTasks.length} vs member ${memberTasks.length}`);

  check('ferdiDecisions is present for a member too',
        Array.isArray(memberState.ferdiDecisions) && memberState.ferdiDecisions.length > 0,
        JSON.stringify(memberState.ferdiDecisions));
  check('ferdiDecisions items are all actually Ferdi\'s, regardless of viewer',
        memberState.ferdiDecisions.every((t) => (t.owners || []).some((o) => o.id === 'ferdi')));
}

section('View as: read-only admin preview of another user\'s POV');
{
  const member = await signIn('mia@visionbrokers.co.za');
  const admin  = await signIn('sam@visionbrokers.co.za');

  const memberTries = await call('/api/state?viewAs=stan', { cookie: member });
  check('a member gets 403 trying to view as anyone', memberTries.status === 403, `got ${memberTries.status}`);

  const bogus = await call('/api/state?viewAs=nobody', { cookie: admin });
  check('viewing as an unknown user 404s', bogus.status === 404, `got ${bogus.status}`);

  const ownState  = await jsonOf(await call('/api/state', { cookie: admin }));
  check('a normal call has no viewingAs', ownState.viewingAs === null, JSON.stringify(ownState.viewingAs));

  const asMia = await jsonOf(await call('/api/state?viewAs=mia', { cookie: admin }));
  check('viewingAs identifies Mia', asMia.viewingAs?.id === 'mia' && asMia.viewingAs?.role === 'member', JSON.stringify(asMia.viewingAs));
  check('"me" stays the real admin, not the previewed user', asMia.me.id === 'sam', JSON.stringify(asMia.me));

  const miaOwnState = await jsonOf(await call('/api/state', { cookie: member }));
  const miaTasksDirect = miaOwnState.initiatives.flatMap((p) => p.tasks).map((t) => t.id).sort();
  const miaTasksViaAdmin = asMia.initiatives.flatMap((p) => p.tasks).map((t) => t.id).sort();
  check('an admin viewing as Mia sees exactly the tasks Mia herself sees, no more, no less',
        JSON.stringify(miaTasksDirect) === JSON.stringify(miaTasksViaAdmin),
        `mia direct: ${JSON.stringify(miaTasksDirect)}, via admin: ${JSON.stringify(miaTasksViaAdmin)}`);

  const asFerdi = await jsonOf(await call('/api/state?viewAs=ferdi', { cookie: admin }));
  check('viewing as another admin identifies them as an admin', asFerdi.viewingAs?.role === 'admin', JSON.stringify(asFerdi.viewingAs));
  const adminOwnTaskCount = ownState.initiatives.flatMap((p) => p.tasks).length;
  const asFerdiTaskCount = asFerdi.initiatives.flatMap((p) => p.tasks).length;
  check('admin-as-admin preview sees the full unscoped task set, same count as any admin would',
        asFerdiTaskCount === adminOwnTaskCount, `${asFerdiTaskCount} vs ${adminOwnTaskCount}`);
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
  const newest = task24.notes.slice(0, 2);
  check('GET /api/state exposes both new notes as separate {id, text} boxes, newest first',
        newest.length === 2 && newest[0].text === 'second note' && newest[1].text === 'first note',
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

section('Projects: editing status/target/summary is admin-only, Where We Are stays open');
{
  const member = await signIn('mia@visionbrokers.co.za');
  const admin  = await signIn('sam@visionbrokers.co.za');

  const memberEdit = await call('/api/projects/fortress', {
    method: 'PATCH', cookie: member, body: { status: 'blocked', target: 'hacked', summary: 'hacked' },
  });
  check('member gets 403 editing status/target/summary', memberEdit.status === 403, `got ${memberEdit.status}`);
  const unchanged = env._rawDb.prepare('SELECT status, target_text, summary FROM projects WHERE id=?').get('fortress');
  check('nothing changed after the rejected member edit',
        unchanged.status === 'at-risk' && unchanged.target !== 'hacked' && unchanged.summary !== 'hacked',
        JSON.stringify(unchanged));

  const memberWwa = await call('/api/projects/fortress', { method: 'PATCH', cookie: member, body: { whereWeAre: 'member update' } });
  check('member can still edit Where We Are, unaffected by the tightened fields', memberWwa.status === 200, `got ${memberWwa.status}`);
  const wwaRow = env._rawDb.prepare('SELECT where_we_are FROM projects WHERE id=?').get('fortress');
  check('Where We Are actually persisted', wwaRow.where_we_are === 'member update', JSON.stringify(wwaRow));

  const adminEdit = await call('/api/projects/fortress', {
    method: 'PATCH', cookie: admin, body: { status: 'blocked', target: 'New target text', targetDate: '2026-12-01', summary: 'New summary' },
  });
  check('admin can edit status/target/targetDate/summary', adminEdit.status === 200, `got ${adminEdit.status}`);
  const adminRow = env._rawDb.prepare('SELECT status, target_text, target_date, summary FROM projects WHERE id=?').get('fortress');
  check('admin edit persisted',
        adminRow.status === 'blocked' && adminRow.target_text === 'New target text' &&
        adminRow.target_date === '2026-12-01' && adminRow.summary === 'New summary',
        JSON.stringify(adminRow));

  const badStatus = await call('/api/projects/fortress', { method: 'PATCH', cookie: admin, body: { status: 'wizard' } });
  check('invalid project status rejected', badStatus.status === 400, `got ${badStatus.status}`);
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

section('Task numbers ("1.1" style) and drag-to-reorder');
{
  // Fresh env: this section creates its own project and freely rewrites
  // sort_order, no need to share state with anything before or after it.
  env = makeEnv(paths);
  installFakeEmail();
  const cookie = await signIn('sam@visionbrokers.co.za');
  const memberCookie = await signIn('mia@visionbrokers.co.za');

  const newProj = await jsonOf(await call('/api/projects', { method: 'POST', cookie, body: { name: 'Reorder Test Project' } }));
  const projectId = newProj.id;
  const projNum = env._rawDb.prepare(`SELECT num FROM projects WHERE id = ?`).get(projectId).num;

  const ids = ['A', 'B', 'C', 'D'].map((label, i) => {
    const status = label === 'C' ? 'done' : 'in-progress';
    const r = env._rawDb.prepare(
      `INSERT INTO tasks (project_id, name, status, sort_order) VALUES (?, ?, ?, ?)`
    ).run(projectId, `Reorder test ${label}`, status, i);
    return Number(r.lastInsertRowid);
  });
  const [taskA, taskB, taskC, taskD] = ids;

  let state = await jsonOf(await call('/api/state', { cookie }));
  let proj = state.initiatives.find((p) => p.id === projectId);
  const byName = (n) => proj.tasks.find((t) => t.name === n);

  check('first non-done task is numbered N.1', byName('Reorder test A').number === `${projNum}.1`);
  check('second non-done task is numbered N.2', byName('Reorder test B').number === `${projNum}.2`);
  check('a done task gets no number at all', byName('Reorder test C').number === null,
        JSON.stringify(byName('Reorder test C')));
  check('numbering skips the done one, so the next non-done task is N.3, not N.4',
        byName('Reorder test D').number === `${projNum}.3`);

  // Reorder: move D to the front.
  const newOrder = [taskD, taskA, taskB, taskC];
  const reorderRes = await call(`/api/projects/${projectId}/tasks/reorder`, {
    method: 'PUT', cookie, body: { taskIds: newOrder },
  });
  check('admin can reorder', reorderRes.status === 200, `got ${reorderRes.status}`);

  state = await jsonOf(await call('/api/state', { cookie }));
  proj = state.initiatives.find((p) => p.id === projectId);
  check('after reordering, D is now first and renumbered N.1',
        proj.tasks[0].name === 'Reorder test D' && proj.tasks[0].number === `${projNum}.1`,
        JSON.stringify(proj.tasks.map((t) => [t.name, t.number])));
  check('A moved to second place and renumbered N.2',
        proj.tasks[1].name === 'Reorder test A' && proj.tasks[1].number === `${projNum}.2`);

  // Permissions and validation.
  const memberTry = await call(`/api/projects/${projectId}/tasks/reorder`, {
    method: 'PUT', cookie: memberCookie, body: { taskIds: [taskA, taskB, taskC, taskD] },
  });
  check('member gets 403 reordering', memberTry.status === 403, `got ${memberTry.status}`);

  const missingOne = await call(`/api/projects/${projectId}/tasks/reorder`, {
    method: 'PUT', cookie, body: { taskIds: [taskA, taskB, taskC] },
  });
  check('reorder rejects a list missing one of the project\'s tasks', missingOne.status === 400,
        `got ${missingOne.status}`);

  const foreignTask = env._rawDb.prepare(
    `SELECT id FROM tasks WHERE project_id != ? LIMIT 1`
  ).get(projectId).id;
  const foreignId = await call(`/api/projects/${projectId}/tasks/reorder`, {
    method: 'PUT', cookie, body: { taskIds: [taskA, taskB, taskC, foreignTask] },
  });
  check('reorder rejects a task id from a different project', foreignId.status === 400,
        `got ${foreignId.status}`);
}

section('Automatic due-date reminders');
{
  env = makeEnv(paths);
  installFakeEmail();
  const cookie = await signIn('sam@visionbrokers.co.za');
  outbox.length = 0;

  const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const projectId = env._rawDb.prepare('SELECT id FROM projects LIMIT 1').get().id;

  function makeTask(name, dueOffsetDays, status, ownerId) {
    const r = env._rawDb.prepare(
      `INSERT INTO tasks (project_id, name, status, due_date, sort_order) VALUES (?, ?, ?, ?, 999)`
    ).run(projectId, name, status, iso(dueOffsetDays));
    const taskId = Number(r.lastInsertRowid);
    if (ownerId) env._rawDb.prepare(`INSERT INTO task_owners (task_id, user_id) VALUES (?, ?)`).run(taskId, ownerId);
    return taskId;
  }

  const dueSoon  = makeTask('Reminder test: due in 3 days',  3,  'in-progress', 'elrine');
  makeTask('Reminder test: due in 10 days', 10, 'in-progress', 'stan');
  makeTask('Reminder test: overdue',        -1, 'blocked',     'stan');
  makeTask('Reminder test: done today',      0, 'done',        'elrine');

  const alreadyNudged = makeTask('Reminder test: nudged manually already', 0, 'in-progress', 'mia');
  env._rawDb.prepare(`INSERT INTO nudges (task_id, sent_by, sent_to) VALUES (?, 'sam', 'mia')`).run(alreadyNudged);

  await runDueDateReminders(env);
  const subjects = outbox.map((m) => m.subject);

  check('task due within the 7-day lead time gets a "Due soon" reminder',
        subjects.includes('Due soon: Reminder test: due in 3 days'), JSON.stringify(subjects));
  check('task due beyond the 7-day lead time gets nothing yet',
        !subjects.some((s) => s.includes('due in 10 days')), JSON.stringify(subjects));
  check('overdue task gets an "Overdue" reminder instead of "Due soon"',
        subjects.includes('Overdue: Reminder test: overdue'), JSON.stringify(subjects));
  check('a task already marked done gets no reminder even though due today',
        !subjects.some((s) => s.includes('done today')), JSON.stringify(subjects));
  check('a task someone already manually nudged in the last 24h is skipped, not double-sent',
        !subjects.some((s) => s.includes('nudged manually already')), JSON.stringify(subjects));
  check('automatic reminders are recorded in nudges with the system user as sender',
        env._rawDb.prepare(`SELECT COUNT(*) n FROM nudges WHERE sent_by = 'system'`).get().n === 2);
  check('reminder emails read as automatic, not as a person asking',
        outbox.every((m) => /VIBE Tracker/.test(m.heading)), JSON.stringify(outbox.map((m) => m.heading)));

  // Dedup the other way: an automatic reminder just sent should count against
  // the same 24h cooldown as a manual Nudge, so a manual Nudge right after is blocked.
  outbox.length = 0;
  const manualAfter = await jsonOf(await call(`/api/tasks/${dueSoon}/nudge`, { method: 'POST', cookie }));
  check('a manual Nudge right after an automatic reminder is blocked by the same cooldown',
        manualAfter.sent.length === 0 && /Elrine/.test(JSON.stringify(manualAfter.skipped)) && outbox.length === 0,
        JSON.stringify(manualAfter));
}

section('Task notes: author name and creation time exposed on hover');
{
  env = makeEnv(paths);
  installFakeEmail();
  const admin = await signIn('sam@visionbrokers.co.za');
  const member = await signIn('mia@visionbrokers.co.za');

  const add = await jsonOf(await call('/api/tasks/1/notes', { method: 'POST', cookie: member, body: { text: 'authorship test note' } }));
  check('note added', add.ok, JSON.stringify(add));

  const state = await jsonOf(await call('/api/state', { cookie: admin }));
  const task1 = state.initiatives.flatMap((p) => p.tasks).find((t) => t.id === 1);
  const note = task1.notes.find((n) => n.id === add.id);
  check("note exposes the author's name", note?.authorName === 'Mia', JSON.stringify(note));
  check('note exposes a creation timestamp', typeof note?.createdAt === 'string' && note.createdAt.length > 0, JSON.stringify(note));

  const edit = await call(`/api/tasks/1/notes/${add.id}`, { method: 'PATCH', cookie: admin, body: { text: 'edited by someone else' } });
  check('a different person can edit the note', edit.status === 200, `got ${edit.status}`);
  const stateAfter = await jsonOf(await call('/api/state', { cookie: admin }));
  const noteAfter = stateAfter.initiatives.flatMap((p) => p.tasks).find((t) => t.id === 1).notes.find((n) => n.id === add.id);
  check("editing a note does not change its displayed author, still the original creator",
        noteAfter?.authorName === 'Mia', JSON.stringify(noteAfter));
}

section('Notifications: note add/edit emails other owners, never the actor');
{
  env = makeEnv(paths);
  installFakeEmail();
  const sam = await signIn('sam@visionbrokers.co.za');
  const deoni = await signIn('deoni@visionric.co.za');
  const mia = await signIn('mia@visionbrokers.co.za');

  const proj = await jsonOf(await call('/api/projects', { method: 'POST', cookie: sam, body: { name: 'Note Notify Test' } }));

  function makeOwnedTask(name, ownerIds) {
    const r = env._rawDb.prepare(
      `INSERT INTO tasks (project_id, name, status, sort_order) VALUES (?, ?, 'in-progress', 999)`
    ).run(proj.id, name);
    const taskId = Number(r.lastInsertRowid);
    ownerIds.forEach((uid) => env._rawDb.prepare(`INSERT INTO task_owners (task_id, user_id) VALUES (?, ?)`).run(taskId, uid));
    return taskId;
  }

  const soleOwnerTask = makeOwnedTask('Sole owner task', ['sam']);
  const multiOwnerTask = makeOwnedTask('Multi owner task', ['sam', 'deoni']);
  const stanOnlyTask = makeOwnedTask('Stan only task', ['stan']);

  outbox.length = 0;
  const r1 = await jsonOf(await call(`/api/tasks/${soleOwnerTask}/notes`, { method: 'POST', cookie: sam, body: { text: 'note by sole owner' } }));
  check('sole owner adding their own note sends no email, no one else to notify',
        outbox.length === 0 && (r1.notified || []).length === 0, JSON.stringify({ outbox, r1 }));

  outbox.length = 0;
  const r2 = await jsonOf(await call(`/api/tasks/${multiOwnerTask}/notes`, { method: 'POST', cookie: deoni, body: { text: 'note by deoni' } }));
  check('Deoni adding a note on a task she and Sam own notifies Sam, not Deoni',
        outbox.length === 1 && outbox[0].to_email === 'sam@visionbrokers.co.za' && (r2.notified || []).includes('Sam'),
        JSON.stringify({ outbox, r2 }));
  check('note-add email names the actor and reads as an addition',
        /Note added/.test(outbox[0].subject) && /Deoni/.test(outbox[0].heading), JSON.stringify(outbox[0]));

  outbox.length = 0;
  const editRes = await jsonOf(await call(`/api/tasks/${multiOwnerTask}/notes/${r2.id}`, { method: 'PATCH', cookie: sam, body: { text: 'edited by sam' } }));
  check('Sam editing that same note notifies Deoni, not Sam',
        outbox.length === 1 && outbox[0].to_email === 'deoni@visionric.co.za' && (editRes.notified || []).includes('Deoni'),
        JSON.stringify({ outbox, editRes }));
  check('note-edit email reads as an edit', /Note edited/.test(outbox[0].subject), outbox[0].subject);

  outbox.length = 0;
  const r3 = await jsonOf(await call(`/api/tasks/${stanOnlyTask}/notes`, { method: 'POST', cookie: mia, body: { text: 'note by a non-owner' } }));
  check("a non-owner (Mia) adding a note still notifies the task's real owner (Stan)",
        outbox.length === 1 && outbox[0].to_email === 'stanford@visionbrokers.co.za', JSON.stringify({ outbox, r3 }));
}

section('Due-date time: optional, informational, reminder logic stays date-only');
{
  env = makeEnv(paths);
  installFakeEmail();
  const admin = await signIn('sam@visionbrokers.co.za');
  const member = await signIn('mia@visionbrokers.co.za');

  const proj = await jsonOf(await call('/api/projects', { method: 'POST', cookie: admin, body: { name: 'Due Time Test' } }));

  const created = await jsonOf(await call(`/api/projects/${proj.id}/tasks`, {
    method: 'POST', cookie: admin, body: { name: 'Task with time', due: '2026-09-01', dueTime: '17:30' },
  }));
  check('task created with a due date and time', created.ok, JSON.stringify(created));

  const badFormat = await call(`/api/projects/${proj.id}/tasks`, {
    method: 'POST', cookie: admin, body: { name: 'Bad time', due: '2026-09-01', dueTime: '5:30pm' },
  });
  check('invalid due time format rejected on create', badFormat.status === 400, `got ${badFormat.status}`);

  const noDate = await call(`/api/projects/${proj.id}/tasks`, {
    method: 'POST', cookie: admin, body: { name: 'Time without date', dueTime: '09:00' },
  });
  check('due time without a due date rejected on create', noDate.status === 400, `got ${noDate.status}`);

  const state = await jsonOf(await call('/api/state', { cookie: admin }));
  const task = state.initiatives.find((p) => p.id === proj.id).tasks.find((t) => t.id === created.id);
  check('GET /api/state exposes dueTime', task.dueTime === '17:30', JSON.stringify(task));

  const badPatch = await call(`/api/tasks/${created.id}`, { method: 'PATCH', cookie: admin, body: { dueTime: 'nope' } });
  check('invalid due time format rejected on PATCH', badPatch.status === 400, `got ${badPatch.status}`);

  const memberTask = await jsonOf(await call(`/api/projects/${proj.id}/tasks`, {
    method: 'POST', cookie: member, body: { name: 'Member owned task', due: '2026-09-05' },
  }));
  const memberDueTimePatch = await call(`/api/tasks/${memberTask.id}`, { method: 'PATCH', cookie: member, body: { dueTime: '10:00' } });
  check('member cannot set due time even on their own task, admin-only field like due date',
        memberDueTimePatch.status === 400, `got ${memberDueTimePatch.status}`);

  const setTimeWithoutDate = await call(`/api/tasks/${created.id}`, { method: 'PATCH', cookie: admin, body: { due: '', dueTime: '08:00' } });
  check('setting a due time while clearing the due date in the same request is rejected',
        setTimeWithoutDate.status === 400, `got ${setTimeWithoutDate.status}`);

  const clearDue = await call(`/api/tasks/${created.id}`, { method: 'PATCH', cookie: admin, body: { due: '' } });
  check('clearing the due date alone succeeds', clearDue.status === 200, `got ${clearDue.status}`);
  const row = env._rawDb.prepare('SELECT due_date, due_time FROM tasks WHERE id=?').get(created.id);
  check('clearing the due date also clears due time, a time cannot outlive its date',
        row.due_date === null && row.due_time === null, JSON.stringify(row));

  const setTimeAgainWithoutDate = await call(`/api/tasks/${created.id}`, { method: 'PATCH', cookie: admin, body: { dueTime: '08:00' } });
  check('setting a due time on a task with no due date at all is rejected',
        setTimeAgainWithoutDate.status === 400, `got ${setTimeAgainWithoutDate.status}`);
}

section('Archived project flag: hidden by default, admin-only, reminders skip it, status untouched');
{
  env = makeEnv(paths);
  installFakeEmail();
  const admin = await signIn('sam@visionbrokers.co.za');
  const member = await signIn('mia@visionbrokers.co.za');

  const proj = await jsonOf(await call('/api/projects', { method: 'POST', cookie: admin, body: { name: 'To Be Archived', status: 'at-risk' } }));
  await call(`/api/projects/${proj.id}/owners`, { method: 'POST', cookie: admin, body: { userId: 'mia' } });

  const memberArchiveAttempt = await call(`/api/projects/${proj.id}`, { method: 'PATCH', cookie: member, body: { archived: true } });
  check('member gets 403 archiving a project', memberArchiveAttempt.status === 403, `got ${memberArchiveAttempt.status}`);

  const archive = await call(`/api/projects/${proj.id}`, { method: 'PATCH', cookie: admin, body: { archived: true } });
  check('admin can archive a project', archive.status === 200, `got ${archive.status}`);
  const archivedRow = env._rawDb.prepare('SELECT status, archived FROM projects WHERE id=?').get(proj.id);
  check('archiving does not touch the real status underneath',
        archivedRow.status === 'at-risk' && archivedRow.archived === 1, JSON.stringify(archivedRow));

  const adminState = await jsonOf(await call('/api/state', { cookie: admin }));
  check('archived project is hidden from admin state by default', !adminState.initiatives.some((p) => p.id === proj.id));
  check('archivedCount reflects the hidden archived project', adminState.archivedCount >= 1, adminState.archivedCount);

  const adminStateWithArchived = await jsonOf(await call('/api/state?includeArchived=1', { cookie: admin }));
  const revealed = adminStateWithArchived.initiatives.find((p) => p.id === proj.id);
  check('includeArchived=1 reveals it again for an admin, still showing its real status',
        revealed?.archived === true && revealed?.status === 'at-risk', JSON.stringify(revealed));

  const memberState = await jsonOf(await call('/api/state', { cookie: member }));
  check('archived project is also hidden by default from a member',
        !memberState.initiatives.some((p) => p.id === proj.id));
  const memberStateWithArchived = await jsonOf(await call('/api/state?includeArchived=1', { cookie: member }));
  check('member can reveal it via includeArchived',
        memberStateWithArchived.initiatives.some((p) => p.id === proj.id));

  // Since all projects are visible to everyone (changed 6 Aug 2026), this is
  // no longer gated by being a named owner: a totally unrelated member sees
  // the same archived/includeArchived behaviour too.
  const unrelated = await signIn('stanford@visionbrokers.co.za');
  const unrelatedState = await jsonOf(await call('/api/state?includeArchived=1', { cookie: unrelated }));
  check('an unrelated member (Stan, not an owner) can also reveal the archived project',
        unrelatedState.initiatives.some((p) => p.id === proj.id));

  const unarchive = await call(`/api/projects/${proj.id}`, { method: 'PATCH', cookie: admin, body: { archived: false } });
  check('archiving is reversible', unarchive.status === 200, `got ${unarchive.status}`);
  const restoredState = await jsonOf(await call('/api/state', { cookie: admin }));
  const restored = restoredState.initiatives.find((p) => p.id === proj.id);
  check('unarchived project shows up again without the toggle, status unaffected throughout',
        !!restored && restored.archived === false && restored.status === 'at-risk', JSON.stringify(restored));

  await call(`/api/projects/${proj.id}`, { method: 'PATCH', cookie: admin, body: { archived: true } });
  const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const archivedTaskRes = env._rawDb.prepare(
    `INSERT INTO tasks (project_id, name, status, due_date, sort_order) VALUES (?, ?, ?, ?, 999)`
  ).run(proj.id, 'Archived project task', 'in-progress', iso(1));
  env._rawDb.prepare(`INSERT INTO task_owners (task_id, user_id) VALUES (?, 'stan')`).run(Number(archivedTaskRes.lastInsertRowid));

  outbox.length = 0;
  await runDueDateReminders(env);
  check('a task due soon in an archived project gets no automatic reminder',
        !outbox.some((m) => /Archived project task/.test(m.subject)), JSON.stringify(outbox.map((m) => m.subject)));
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
