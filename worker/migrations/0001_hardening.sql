-- ══════════════════════════════════════════════════════════════
-- Migration: 0001_hardening.sql
-- 
-- CAUTION / تنبيه قبل التطبيق:
-- Before running this migration on existing production data, ensure no duplicate permanent khatibs exist.
-- Run the following check first:
-- SELECT permanent_khatib_id, COUNT(*) FROM mosques WHERE permanent_khatib_id IS NOT NULL AND permanent_khatib_id != '' GROUP BY 1 HAVING COUNT(*) > 1;
-- If any rows are returned, resolve them manually before creating the unique index below.
-- ══════════════════════════════════════════════════════════════

-- 1. Table for login rate limiting (Item F)
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL
);

-- 2. Unique index for permanent khatib in mosques (Item A)
CREATE UNIQUE INDEX IF NOT EXISTS idx_mosques_permanent ON mosques(permanent_khatib_id) WHERE permanent_khatib_id IS NOT NULL AND permanent_khatib_id != '';
