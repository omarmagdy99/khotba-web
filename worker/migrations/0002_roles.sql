-- ══════════════════════════════════════════════════════════════
-- Migration: 0002_roles.sql
--
-- Adds user roles. NOT idempotent (ALTER TABLE ADD COLUMN): run once.
-- Every user that exists before this migration becomes 'admin' so nobody
-- loses access; new users default to 'coordinator'.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'coordinator' CHECK(role IN ('admin', 'coordinator', 'viewer'));

UPDATE users SET role = 'admin';
