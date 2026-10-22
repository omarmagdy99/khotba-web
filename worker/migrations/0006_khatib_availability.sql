-- ══════════════════════════════════════════════════════════════
-- 0006_khatib_availability.sql
-- إضافة نمط التوفر الشهري المتكرر للخطباء (كل جمعة أو جمع محددة من الشهر 1-5)
-- ══════════════════════════════════════════════════════════════

ALTER TABLE khatibs ADD COLUMN availability_mode TEXT NOT NULL DEFAULT 'all'
  CHECK(availability_mode IN ('all', 'custom'));

ALTER TABLE khatibs ADD COLUMN availability_weeks TEXT;
