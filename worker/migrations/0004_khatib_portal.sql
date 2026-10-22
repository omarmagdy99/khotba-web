-- ══════════════════════════════════════════════════════════════
-- 0004_khatib_portal.sql
-- دعم بوابة الخطباء برقم الهاتف وحالات الجاهزية والاعتذار
-- ══════════════════════════════════════════════════════════════

-- 1. جدول جلسات الخطباء
CREATE TABLE IF NOT EXISTS khatib_sessions (
  token TEXT PRIMARY KEY,
  khatib_id TEXT NOT NULL REFERENCES khatibs(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_khatib_sessions_khatib ON khatib_sessions(khatib_id);

-- 2. جدول جاهزية الخطباء غير المكلفين بمساجد
CREATE TABLE IF NOT EXISTS khatib_readiness (
  date TEXT NOT NULL,
  khatib_id TEXT NOT NULL REFERENCES khatibs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('ready', 'excused', 'undecided')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, khatib_id)
);
CREATE INDEX IF NOT EXISTS idx_khatib_readiness_date ON khatib_readiness(date);
