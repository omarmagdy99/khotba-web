CREATE TABLE IF NOT EXISTS khatib_identity (
  khatib_id TEXT PRIMARY KEY REFERENCES khatibs(id) ON DELETE CASCADE,
  national_id_ciphertext TEXT,
  code_hash TEXT,
  code_phone TEXT,
  code_expires_at TEXT
);
