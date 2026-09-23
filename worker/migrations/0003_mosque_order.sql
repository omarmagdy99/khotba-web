-- ══════════════════════════════════════════════════════════════
-- Migration: 0003_mosque_order.sql
--
-- Adds mosques.sort_order — the mosque's number (1..N) and the order every
-- screen lists mosques in. NOT idempotent (ALTER TABLE ADD COLUMN): run once.
--
-- The initial numbering keeps the order the schedule screen already showed
-- (mosque id ascending), active mosques first so they get 1..N without gaps.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE mosques ADD COLUMN sort_order INTEGER;

UPDATE mosques SET sort_order = (
  SELECT COUNT(*) FROM mosques m2
  WHERE m2.active > mosques.active
     OR (m2.active = mosques.active AND m2.id <= mosques.id)
);
