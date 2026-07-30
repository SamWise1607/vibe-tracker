/**
 * Regenerates seed.sql from the original draft HTML.
 *
 * You only need this if the draft's project data changes and you want to reload
 * the database from scratch. Day to day, edits happen inside the app.
 *
 * Run from the worker folder:  node tools/make-seed.js
 */

const fs = require('fs');
const path = require('path');

const ROOT  = path.resolve(__dirname, '..', '..');   // vibe-tracker/
const DRAFT = path.join(ROOT, '.reference', 'vibe_dashboardDRAFT.ORIGINAL.html');
const OUT   = path.join(ROOT, 'worker', 'seed.sql');

if (!fs.existsSync(DRAFT)) {
  console.error(`Cannot find the draft at:\n  ${DRAFT}\n`);
  console.error('That file is the source of the seed data. Restore it before running this.');
  process.exit(1);
}

const html = fs.readFileSync(DRAFT, 'utf8');

// Pull the seedData object literal out of the <script> block.
const start = html.indexOf('const seedData = ');
const end   = html.indexOf('\n};', start) + 3;
const src   = html.slice(start + 'const seedData = '.length, end).replace(/;\s*$/, '');
const seedData = eval('(' + src + ')');

// --- team -------------------------------------------------------
const users = [
  { id:'sam',    name:'Sam',    email:'sam@visionbrokers.co.za',      role:'admin'  },
  { id:'deoni',  name:'Deoni',  email:'deoni@visionric.co.za',        role:'admin'  },
  { id:'ferdi',  name:'Ferdi',  email:'ferdi@visionpw.co.za',         role:'admin'  },
  { id:'mia',    name:'Mia',    email:'mia@visionbrokers.co.za',      role:'member' },
  { id:'stan',   name:'Stan',   email:'stanford@visionbrokers.co.za', role:'member' },
  { id:'elrine', name:'Elrine', email:'elrine@visionbrokers.co.za',   role:'member' },
];
const byName = Object.fromEntries(users.map(u => [u.name, u.id]));

const NON_PERSON = new Set(['Unassigned','Legal','External (Discovery)']);

function q(v){
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Split an owner string like "Deoni / Mia" into { userIds, label }
function parseOwner(raw){
  const parts = String(raw).split('/').map(s => s.trim()).filter(Boolean);
  const userIds = [], labels = [];
  for (const p of parts){
    if (byName[p]) userIds.push(byName[p]);
    else labels.push(p);
  }
  return { userIds, label: labels.length ? labels.join(' / ') : null };
}

const out = [];
const warn = [];
out.push('-- VIBE Operations Tracker: seed data');
out.push('-- Generated from vibe_dashboardDRAFT.html. Do not hand-edit; regenerate instead.');
out.push('-- Run with: npx wrangler d1 execute vibe-tracker --file=./seed.sql --remote');
out.push('');
out.push('DELETE FROM task_owners; DELETE FROM tasks; DELETE FROM key_risks;');
out.push('DELETE FROM project_owners; DELETE FROM projects; DELETE FROM settings; DELETE FROM users;');
out.push('');
out.push('-- Users -------------------------------------------------------');
for (const u of users){
  out.push(`INSERT INTO users (id,name,email,role,status) VALUES (${q(u.id)},${q(u.name)},${q(u.email)},${q(u.role)},'active');`);
}
out.push('');
out.push('-- Settings ----------------------------------------------------');
out.push(`INSERT INTO settings (key,value,updated_by) VALUES ('focus_this_week',${q(seedData.focusThisWeek)},'deoni');`);
out.push(`INSERT INTO settings (key,value,updated_by) VALUES ('leadership_notes',${q(JSON.stringify(seedData.leaderNotes))},'deoni');`);
out.push('');

let taskId = 0;
for (const p of seedData.initiatives){
  out.push(`-- ${p.num}. ${p.name} ${'-'.repeat(Math.max(2, 50 - p.name.length))}`);
  out.push(`INSERT INTO projects (id,num,name,status,target_text,target_date,summary,where_we_are,updated_by) VALUES (${q(p.id)},${p.num},${q(p.name)},${q(p.status)},${q(p.target)},${q(p.targetDate)},${q(p.summary)},${q(p.whereWeAre)},'deoni');`);

  for (const o of p.owners){
    if (byName[o]) out.push(`INSERT INTO project_owners (project_id,user_id) VALUES (${q(p.id)},${q(byName[o])});`);
    else warn.push(`project "${p.name}" owner "${o}" is not a known user, dropped`);
  }

  p.keyRisk.forEach((r,i) => {
    out.push(`INSERT INTO key_risks (project_id,body,sort_order) VALUES (${q(p.id)},${q(r)},${i});`);
  });

  p.tasks.forEach((t,i) => {
    taskId++;
    const { userIds, label } = parseOwner(t.owner);
    if (label && !NON_PERSON.has(label)) warn.push(`task "${t.name}" has unrecognised owner label "${label}"`);
    out.push(`INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (${taskId},${q(p.id)},${q(t.name)},${q(t.status)},${q(t.due ?? null)},${q(t.note || '')},${q(label)},${i},'deoni');`);
    for (const uid of userIds){
      out.push(`INSERT INTO task_owners (task_id,user_id) VALUES (${taskId},${q(uid)});`);
    }
  });
  out.push('');
}

fs.writeFileSync(OUT, out.join('\n'));

console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
console.log('  projects:', seedData.initiatives.length);
console.log('  tasks   :', taskId);
console.log('  users   :', users.length);
if (warn.length){ console.log('\nWARNINGS:'); warn.forEach(w => console.log('  -', w)); }
