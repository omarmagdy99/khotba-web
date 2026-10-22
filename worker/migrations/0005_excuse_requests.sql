-- ══════════════════════════════════════════════════════════════
-- 0005_excuse_requests.sql
-- دعم طلبات مراجعة الاعتذار بعد تأكيد الحضور
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS excuse_requests (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  mosque_id TEXT NOT NULL REFERENCES mosques(id) ON DELETE CASCADE,
  khatib_id TEXT NOT NULL REFERENCES khatibs(id) ON DELETE CASCADE,
  assignment_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')) DEFAULT 'pending',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_excuse_requests_date ON excuse_requests(date);
CREATE INDEX IF NOT EXISTS idx_excuse_requests_khatib ON excuse_requests(khatib_id);
CREATE INDEX IF NOT EXISTS idx_excuse_requests_status ON excuse_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_excuse_requests_pending_unique
  ON excuse_requests(date, mosque_id, khatib_id)
  WHERE status = 'pending';
