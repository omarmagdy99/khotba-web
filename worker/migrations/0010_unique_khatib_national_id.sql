ALTER TABLE khatib_identity ADD COLUMN national_id_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_khatib_identity_fingerprint
  ON khatib_identity(national_id_fingerprint);

-- Keep older Workers from writing identities the unique index cannot see.
CREATE TRIGGER IF NOT EXISTS require_khatib_identity_fingerprint_on_insert
BEFORE INSERT ON khatib_identity
WHEN NEW.national_id_ciphertext IS NOT NULL AND NEW.national_id_fingerprint IS NULL
BEGIN
  SELECT RAISE(ABORT, 'National ID writes require a fingerprint');
END;

CREATE TRIGGER IF NOT EXISTS require_khatib_identity_fingerprint_on_update
BEFORE UPDATE OF national_id_ciphertext ON khatib_identity
WHEN NEW.national_id_ciphertext IS NOT OLD.national_id_ciphertext
  AND (
    (NEW.national_id_ciphertext IS NULL) <> (NEW.national_id_fingerprint IS NULL)
    OR (NEW.national_id_ciphertext IS NOT NULL AND NEW.national_id_fingerprint IS OLD.national_id_fingerprint)
  )
BEGIN
  SELECT RAISE(ABORT, 'National ID writes require a matching fingerprint');
END;
