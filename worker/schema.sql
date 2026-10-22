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
  sort_order INTEGER, -- رقم المسجد وترتيبه في كل الشاشات
  CONSTRAINT uq_mosque_name_mujawra UNIQUE (name, mujawra)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mosques_permanent ON mosques(permanent_khatib_id) WHERE permanent_khatib_id IS NOT NULL AND permanent_khatib_id != '';

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
  created_at TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'coordinator' CHECK(role IN ('admin', 'coordinator', 'viewer')),
  region_access TEXT NOT NULL DEFAULT 'both' CHECK(region_access IN ('15may', 'tebeen', 'both'))
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

-- 8. محاولات تسجيل الدخول (login_attempts)
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL
);

-- 9. جلسات الخطباء (khatib_sessions)
CREATE TABLE IF NOT EXISTS khatib_sessions (
  token TEXT PRIMARY KEY,
  khatib_id TEXT NOT NULL REFERENCES khatibs(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_khatib_sessions_khatib ON khatib_sessions(khatib_id);

-- 10. جاهزية الخطباء غير المكلفين (khatib_readiness)
CREATE TABLE IF NOT EXISTS khatib_readiness (
  date TEXT NOT NULL,
  khatib_id TEXT NOT NULL REFERENCES khatibs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('ready', 'excused', 'undecided')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, khatib_id)
);
CREATE INDEX IF NOT EXISTS idx_khatib_readiness_date ON khatib_readiness(date);
