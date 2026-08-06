-- VIBE Tracker: D1 schema
-- Run with: npx wrangler d1 execute vibe-tracker --file=./schema.sql --remote

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS magic_tokens;
DROP TABLE IF EXISTS nudges;
DROP TABLE IF EXISTS task_owners;
DROP TABLE IF EXISTS task_notes;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS key_risks;
DROP TABLE IF EXISTS project_owners;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS users;

-- ---------------------------------------------------------------
-- People
-- ---------------------------------------------------------------
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member'   CHECK (role   IN ('admin','member')),
  status      TEXT NOT NULL DEFAULT 'pending'  CHECK (status IN ('active','pending','rejected')),
  -- Never logs in, never appears in /api/users or any admin/owner picker.
  -- Exists only so automated due-date reminders have a real users.id to put
  -- in nudges.sent_by (that column is NOT NULL) and a name/email to show as
  -- the sender instead of misattributing the email to a real person.
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email  ON users(email);
CREATE INDEX idx_users_status ON users(status);

-- System user for automated due-date reminder emails. See is_system comment above.
INSERT INTO users (id, name, email, role, status, is_system)
VALUES ('system', 'VIBE Tracker', 'system@vibe-tracker.local', 'member', 'active', 1);

-- ---------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  num          INTEGER NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'on-track'
                 CHECK (status IN ('on-track','at-risk','blocked','paused')),
  -- Added 5 Aug 2026: a finished/shelved project, hidden from the dashboard
  -- by default so it stops cluttering it. Reversible any time by an admin
  -- via the same PATCH as any other project field. Deliberately a separate
  -- flag rather than a 5th `status` value: a project keeps its real status
  -- underneath even once archived, and it means this never requires
  -- widening the `status` CHECK constraint (which in SQLite/D1 means
  -- recreating the whole table, too dangerous given D1's `PRAGMA
  -- foreign_keys = OFF` not reliably applying across a multi-statement
  -- file execution). Fully independent of task status; archiving a project
  -- does not touch its tasks.
  archived     INTEGER NOT NULL DEFAULT 0,
  target_text  TEXT NOT NULL DEFAULT '',
  target_date  TEXT,                      -- ISO yyyy-mm-dd, nullable
  summary      TEXT NOT NULL DEFAULT '',
  where_we_are TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by   TEXT REFERENCES users(id)
);

CREATE INDEX idx_projects_num ON projects(num);

-- Project status is set manually, not rolled up from tasks. A project can be
-- at risk for reasons no single task captures.

CREATE TABLE project_owners (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE key_risks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_key_risks_project ON key_risks(project_id, sort_order);

-- ---------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------
CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- 'paused' was missing from the draft's task dropdown even though the seed data
  -- used it (VRES SA / Propcon). The draft silently rendered it as "Not started".
  status      TEXT NOT NULL DEFAULT 'not-started'
                CHECK (status IN ('not-started','in-progress','blocked','paused','done')),
  due_date    TEXT,                       -- ISO yyyy-mm-dd, nullable
  -- Added 5 Aug 2026: optional "HH:MM" 24h time alongside due_date. Purely
  -- informational/display, and only ever set together with a due_date (see
  -- the app-level check in index.js). Due-date reminder logic (7-day lead,
  -- daily until done) still keys off due_date's calendar day only.
  due_time    TEXT,
  note        TEXT NOT NULL DEFAULT '',
  owner_label TEXT,                       -- for non-people: 'Legal', 'External (Discovery)', 'Unassigned'
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT REFERENCES users(id)
);

CREATE INDEX idx_tasks_project ON tasks(project_id, sort_order);
CREATE INDEX idx_tasks_status  ON tasks(status);

-- Many-to-many so "Deoni / Mia" becomes two rows instead of one unmailable string.
-- A task has either human owners in this table, or an owner_label, or neither.
CREATE TABLE task_owners (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE INDEX idx_task_owners_user ON task_owners(user_id);

-- A task can carry several free-text notes, each its own entry, rather than
-- one field that gets overwritten. `tasks.note` above is kept only as a
-- legacy column for anything not yet migrated; the app reads/writes notes
-- through this table now.
CREATE TABLE task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id)
);

CREATE INDEX idx_task_notes_task ON task_notes(task_id, sort_order);

-- ---------------------------------------------------------------
-- Nudges (audit trail so people cannot be spammed)
-- ---------------------------------------------------------------
CREATE TABLE nudges (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sent_by TEXT    NOT NULL REFERENCES users(id),
  sent_to TEXT    NOT NULL REFERENCES users(id),
  sent_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_nudges_recent ON nudges(task_id, sent_to, sent_at);

-- ---------------------------------------------------------------
-- Auth
-- ---------------------------------------------------------------
-- Only the SHA-256 hash of a token is ever stored. A database leak does not
-- hand over working login links.
CREATE TABLE magic_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_magic_tokens_user ON magic_tokens(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------
-- App-wide settings (focus_this_week, leadership_notes)
-- ---------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT REFERENCES users(id)
);

-- ---------------------------------------------------------------
-- Audit log: so admins can see what other admins changed, and undo
-- an accidental task delete. Only reversible actions (task_deleted)
-- carry a snapshot; everything else is a plain-English record.
-- ---------------------------------------------------------------
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL,   -- e.g. task_created, task_deleted, task_status_changed
  entity_type TEXT NOT NULL,   -- 'task' | 'project' | 'settings' | 'user'
  entity_id   TEXT,
  snapshot    TEXT,            -- JSON, only set when the action is reversible
  detail      TEXT,            -- plain-English summary shown in the log
  restored_at TEXT,            -- set once a task_deleted entry has been restored
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC, id DESC);
