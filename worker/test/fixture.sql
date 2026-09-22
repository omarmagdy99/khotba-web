-- Fixture data for integration tests
PRAGMA foreign_keys = OFF;

-- 1. settings
INSERT OR REPLACE INTO settings (key, value) VALUES ('publish_from', '');
INSERT OR REPLACE INTO settings (key, value) VALUES ('publish_to', '');
INSERT OR REPLACE INTO settings (key, value) VALUES ('next_mosque_seq', '5');
INSERT OR REPLACE INTO settings (key, value) VALUES ('next_khatib_seq', '6');

-- 2. users
-- testadmin / password123 with salt somesalt456 -> sha256('somesalt456password123')
INSERT OR REPLACE INTO users (username, display_name, password_hash, salt, active, created_at, role)
VALUES ('testadmin', 'أدمن التجربة', '303d7952b56e3a886071ce2e4f645aa5573236497276600427dc3804eac8443e', 'somesalt456', 1, '2026-09-22T00:00:00.000Z', 'admin');

-- 3. khatibs (~5 khatibs: one inactive, two with phones)
INSERT OR REPLACE INTO khatibs (id, name, phone, type, notes, active, created_at)
VALUES ('K001', 'أحمد علي', '01011111111', 'primary', '', 1, '2026-09-22T00:00:00.000Z');
INSERT OR REPLACE INTO khatibs (id, name, phone, type, notes, active, created_at)
VALUES ('K002', 'محمد حسن', '01022222222', 'primary', '', 1, '2026-09-22T00:00:00.000Z');
INSERT OR REPLACE INTO khatibs (id, name, phone, type, notes, active, created_at)
VALUES ('K003', 'محمود سيد', NULL, 'volunteer', '', 1, '2026-09-22T00:00:00.000Z');
INSERT OR REPLACE INTO khatibs (id, name, phone, type, notes, active, created_at)
VALUES ('K004', 'إبراهيم خليل', NULL, 'volunteer', '', 1, '2026-09-22T00:00:00.000Z');
INSERT OR REPLACE INTO khatibs (id, name, phone, type, notes, active, created_at)
VALUES ('K005', 'خالد عمر', NULL, 'volunteer', '', 0, '2026-09-22T00:00:00.000Z');

-- 4. mosques (~4 mosques, one with permanent khatib)
INSERT OR REPLACE INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at)
VALUES ('M001', 'مسجد النور', 'مجاورة 1', '', 'K001', 1, '2026-09-22T00:00:00.000Z');
INSERT OR REPLACE INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at)
VALUES ('M002', 'مسجد التقوى', 'مجاورة 2', '', NULL, 1, '2026-09-22T00:00:00.000Z');
INSERT OR REPLACE INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at)
VALUES ('M003', 'مسجد الإيمان', 'مجاورة 3', '', NULL, 1, '2026-09-22T00:00:00.000Z');
INSERT OR REPLACE INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at)
VALUES ('M004', 'مسجد الفردوس', 'مجاورة 4', '', NULL, 1, '2026-09-22T00:00:00.000Z');

PRAGMA foreign_keys = ON;
