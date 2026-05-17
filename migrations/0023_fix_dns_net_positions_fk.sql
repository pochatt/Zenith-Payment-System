-- =============================================================================
-- 0023_fix_dns_net_positions_fk.sql
--
-- Root cause
-- ----------
-- 0012_fix_dns_cycles renamed DnsCycles → DnsCycles_old (step A). SQLite
-- automatically rewrites every FK reference in child tables, so the
-- sqlite_master entry for DnsNetPositions became:
--
--   FOREIGN KEY (cycle_id) REFERENCES DnsCycles_old(cycle_id)
--
-- Step D of 0012 then dropped DnsCycles_old, leaving a dangling reference
-- inside sqlite_master. D1's batch executor validates referenced tables when
-- it prepares each statement, so any db.batch() that includes an
-- INSERT OR REPLACE INTO DnsNetPositions statement fails with:
--
--   D1_ERROR: no such table: main.DnsCycles_old: SQLITE_ERROR
--
-- This only surfaces when net positions are recorded (i.e. when non-HIGH_VALUE
-- transactions exist in DECIDED_TO_SETTLE state), because that is the only
-- code path that issues an INSERT OR REPLACE INTO DnsNetPositions inside a
-- db.batch() call.
--
-- Fix
-- ---
-- Drop and recreate DnsNetPositions with the FK pointing to DnsCycles.
-- DnsNetPositions rows are cycle-scoped and regenerated on every kickDns
-- call, so clearing them here is safe (any cycle currently in KICKED state
-- will need to be re-kicked after this migration is applied).
--
-- Both statements are idempotent: DROP IF EXISTS is a no-op when the table
-- is already absent; CREATE TABLE fails only if DnsNetPositions already
-- exists with the correct schema, which means a previous run of this
-- migration completed successfully.
-- =============================================================================

DROP TABLE IF EXISTS DnsNetPositions;

CREATE TABLE DnsNetPositions (
  id            TEXT    PRIMARY KEY,
  cycle_id      TEXT    NOT NULL,
  bank_id       TEXT    NOT NULL,
  gross_send    INTEGER NOT NULL DEFAULT 0,
  gross_receive INTEGER NOT NULL DEFAULT 0,
  net_position  INTEGER NOT NULL DEFAULT 0,
  is_settled    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (cycle_id) REFERENCES DnsCycles(cycle_id)
);
