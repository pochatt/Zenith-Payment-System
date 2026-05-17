-- =============================================================================
-- 0022_fix_dns_cycles_cleanup.sql
-- Clean up potential partial application of 0012_fix_dns_cycles.sql.
--
-- 0012 uses an ALTER TABLE RENAME → CREATE → INSERT → DROP pattern to remove
-- the UNIQUE constraint from business_date. In some D1 environments the batch
-- is NOT executed atomically: if the DROP TABLE DnsCycles_old step fails (or
-- is rolled back after an earlier step succeeds), the database can be left in
-- one of two broken states:
--
--   A) DnsCycles_old still exists (RENAME succeeded, DROP never ran)
--   B) DnsCycles missing (RENAME succeeded but the new CREATE was rolled back)
--
-- All statements below use IF [NOT] EXISTS so this migration is a no-op on a
-- correctly migrated database.
-- =============================================================================

-- Remove leftover DnsCycles_old from a partial 0012 run.
DROP TABLE IF EXISTS DnsCycles_old;

-- Recreate DnsCycles if the RENAME step of 0012 left it missing.
CREATE TABLE IF NOT EXISTS DnsCycles (
  cycle_id      TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'OPEN',
  igs_mode      TEXT NOT NULL DEFAULT 'NORMAL',
  kicked_at     TEXT,
  settled_at    TEXT,
  hold_reason   TEXT,
  net_positions TEXT,
  updated_at    TEXT,
  created_at    TEXT NOT NULL
);

-- Ensure the non-unique business_date index exists (was created in 0012 but may
-- be absent if 0012 was only partially applied).
CREATE INDEX IF NOT EXISTS idx_dns_business_date ON DnsCycles(business_date);
