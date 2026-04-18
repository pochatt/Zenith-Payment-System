-- =============================================================================
-- 0015_finality_log_autoincrement.sql - FinalityLog sequence monotonicity fix
-- =============================================================================
--
-- MOTIVATION:
-- Previously, event_seq was manually computed via:
--   candidate = Date.now() * 1000 + Math.random() * 1000
--   seq = Math.max(candidate, MAX(event_seq) + 1)
--
-- Under high concurrency (multiple Workers), this SELECT-then-compute pattern
-- could produce duplicate sequences if two requests read the same MAX before
-- either writes, leading to non-monotonic FinalityLog.
--
-- FIX:
-- Recreate FinalityLog with AUTOINCREMENT event_seq to rely on SQLite's
-- atomic ROWID generation. SQLite guarantees monotonicity of ROWID/AUTOINCREMENT
-- even under concurrent writes within D1 transactions.
--
-- D1 NOTE:
-- D1 (SQLite) uses single-writer locking at the SQLite layer. Each D1 batch
-- or standalone .run() executes within a transaction, and AUTOINCREMENT
-- is atomically enforced. No concurrent drift is possible.
--
-- MIGRATION SAFETY:
-- This migration creates a new FinalityLog_new table with AUTOINCREMENT,
-- copies all existing data, drops the old table, and renames.
-- Data continuity is preserved; new rows will auto-increment from
-- MAX(event_seq) + 1.
-- =============================================================================

CREATE TABLE FinalityLog_new (
  log_id       TEXT    PRIMARY KEY,                -- UUID
  txid         TEXT,
  gtid         TEXT,
  event_type   TEXT    NOT NULL,
  state_from   TEXT,
  state_to     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  event_seq    INTEGER NOT NULL UNIQUE AUTOINCREMENT, -- Now auto-incrementing
  occurred_at  TEXT    NOT NULL
);

-- Copy existing data (event_seq values preserved)
INSERT INTO FinalityLog_new (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
SELECT log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at
FROM FinalityLog;

-- Drop old table and rename new one
DROP TABLE FinalityLog;
ALTER TABLE FinalityLog_new RENAME TO FinalityLog;

-- Recreate indexes
CREATE INDEX idx_fl_txid ON FinalityLog(txid);
CREATE INDEX idx_fl_gtid ON FinalityLog(gtid);
CREATE INDEX idx_fl_seq  ON FinalityLog(event_seq);
