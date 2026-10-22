-- Apply once to khotba-db (the shared account database) only.
-- Preserve existing access; new accounts select a region in the user form.
ALTER TABLE users ADD COLUMN region_access TEXT NOT NULL DEFAULT 'both'
  CHECK(region_access IN ('15may', 'tebeen', 'both'));
