-- Migration: automatic due-date reminder emails
-- Run once against the LIVE database (schema.sql already has this baked in
-- for any future fresh install, this file is only for the DB that already exists).
--
-- Run with:
--   npx wrangler d1 execute vibe-tracker --remote --file=./MIGRATION-due-date-reminders.sql
--
-- What this does:
-- 1. Adds is_system to users, so the automated-reminder sender can be
--    excluded from /api/users and every admin/owner picker in the UI.
-- 2. Adds a 'system' user row ("VIBE Tracker") to be that sender. It never
--    logs in. nudges.sent_by is a required foreign key to a real user, so
--    automatic reminders need a real row to point at, same as a person would.

ALTER TABLE users ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

INSERT INTO users (id, name, email, role, status, is_system)
VALUES ('system', 'VIBE Tracker', 'system@vibe-tracker.local', 'member', 'active', 1);
