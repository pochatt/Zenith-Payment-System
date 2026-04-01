-- =============================================================================
-- 0012_fix_dns_cycles.sql
-- Fix DnsCycles schema: add missing updated_at column, drop UNIQUE on
-- business_date to allow late-arriving cycles (suffix-based cycle_id).
-- =============================================================================

-- 1. Add missing updated_at column (referenced by holdDns but never existed)
ALTER TABLE DnsCycles ADD COLUMN updated_at TEXT;

-- 2. Recreate DnsCycles without UNIQUE on business_date.
--    SQLite does not support DROP CONSTRAINT, so we recreate via rename+copy.
--    NOTE: D1 migrations run once; this is safe for fresh or existing DBs.

-- Step A: Rename existing table
ALTER TABLE DnsCycles RENAME TO DnsCycles_old;

-- Step B: Create new table without UNIQUE on business_date
CREATE TABLE DnsCycles (
  cycle_id      TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,                -- was UNIQUE, now allows multiple cycles/day
  state         TEXT NOT NULL DEFAULT 'OPEN', -- OPEN|KICKED|SETTLED|HOLD_ACTIVE
  igs_mode      TEXT NOT NULL DEFAULT 'NORMAL',
  kicked_at     TEXT,
  settled_at    TEXT,
  hold_reason   TEXT,
  net_positions TEXT,
  updated_at    TEXT,
  created_at    TEXT NOT NULL
);

-- Step C: Copy data
INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, kicked_at, settled_at, hold_reason, net_positions, updated_at, created_at)
  SELECT cycle_id, business_date, state, igs_mode, kicked_at, settled_at, hold_reason, net_positions, updated_at, created_at
  FROM DnsCycles_old;

-- Step D: Drop old table
DROP TABLE DnsCycles_old;

-- Step E: Add index for business_date queries (non-unique)
CREATE INDEX idx_dns_business_date ON DnsCycles(business_date);
