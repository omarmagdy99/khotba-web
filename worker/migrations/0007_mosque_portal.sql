ALTER TABLE mosques ADD COLUMN manager_phone TEXT;
CREATE INDEX IF NOT EXISTS idx_mosques_manager_phone ON mosques(manager_phone);
CREATE TABLE IF NOT EXISTS mosque_accounts (
  phone TEXT PRIMARY KEY,
  password_hash TEXT,
  salt TEXT,
  telegram_chat_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mosque_sessions (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL REFERENCES mosque_accounts(phone) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mosque_sessions_phone ON mosque_sessions(phone);
CREATE TABLE IF NOT EXISTS mosque_reset_codes (
  phone TEXT PRIMARY KEY REFERENCES mosque_accounts(phone) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
