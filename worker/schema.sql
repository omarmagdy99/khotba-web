-- ══════════════════════════════════════════════════════════════
-- أوقاف 15 مايو — جدول خطب الجمعة
-- Cloudflare D1 Database Schema
-- ══════════════════════════════════════════════════════════════

-- 1. المساجد (mosques)
CREATE TABLE IF NOT EXISTS mosques (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mujawra TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  permanent_khatib_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CONSTRAINT uq_mosque_name_mujawra UNIQUE (name, mujawra)
);

-- 2. الخطباء (khatibs)
CREATE TABLE IF NOT EXISTS khatibs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  type TEXT NOT NULL CHECK(type IN ('primary', 'volunteer')) DEFAULT 'primary',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_khatibs_phone ON khatibs(phone) WHERE phone IS NOT NULL AND phone != '';

-- 3. الرغبات والتفضيلات (preferences)
CREATE TABLE IF NOT EXISTS preferences (
  khatib_id TEXT NOT NULL REFERENCES khatibs(id) ON DELETE CASCADE,
  mosque_id TEXT NOT NULL REFERENCES mosques(id) ON DELETE CASCADE,
  PRIMARY KEY (khatib_id, mosque_id)
);

-- 4. التكليفات والجمعات (assignments)
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY, -- {date}_{mosque_id}
  date TEXT NOT NULL,
  mosque_id TEXT NOT NULL REFERENCES mosques(id) ON DELETE CASCADE,
  khatib_id TEXT REFERENCES khatibs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed', 'unassigned', 'excused')) DEFAULT 'unassigned',
  date_type TEXT NOT NULL CHECK(date_type IN ('friday', 'special')) DEFAULT 'friday',
  label TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_date_mosque ON assignments(date, mosque_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_date_khatib ON assignments(date, khatib_id) WHERE khatib_id IS NOT NULL AND khatib_id != '';
CREATE INDEX IF NOT EXISTS idx_assignments_date ON assignments(date);
CREATE INDEX IF NOT EXISTS idx_assignments_khatib ON assignments(khatib_id);

-- 5. المستخدمون (users)
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 6. جلسات الدخول (sessions)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

-- 7. الإعدادات (settings)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
