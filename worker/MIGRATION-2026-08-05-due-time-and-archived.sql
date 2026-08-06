-- Migration: task due-time + archived project flag
-- Run once against the LIVE database (schema.sql already has this baked in
-- for any future fresh install, this file is only for the DB that already exists).
--
-- Run with:
--   npx wrangler d1 execute vibe-tracker --remote --file=./MIGRATION-2026-08-05-due-time-and-archived.sql
--
-- REWRITTEN 5 Aug 2026 after the first version of this file caused real data
-- loss. That version widened projects.status's CHECK constraint by
-- recreating the whole `projects` table (CREATE new -> COPY -> DROP old ->
-- RENAME), guarded by `PRAGMA foreign_keys = OFF`. D1 does not reliably
-- honor that PRAGMA across a multi-statement file execution, so the
-- `DROP TABLE projects` cascade-deleted every row in project_owners,
-- key_risks, and tasks (and, through tasks, task_owners and task_notes too)
-- because they all reference projects(id) ON DELETE CASCADE. Recovered via
-- D1 Time Travel (`npx wrangler d1 time-travel restore`). This version
-- avoids the entire risk: both changes below are plain `ALTER TABLE ...
-- ADD COLUMN` statements, which cannot cascade or drop anything.
--
-- What this does:
-- 1. Adds tasks.due_time, an optional "HH:MM" 24h time alongside due_date.
--    Purely informational/display; the automatic due-date reminder cron
--    still keys off due_date's calendar day only, unchanged.
-- 2. Adds projects.archived (0/1, default 0): a separate flag, not a 5th
--    status value, so a finished/shelved project can be hidden from the
--    dashboard by default (toggle to reveal) while keeping its real status
--    underneath. Fully reversible via the normal project PATCH.

ALTER TABLE tasks ADD COLUMN due_time TEXT;
ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
