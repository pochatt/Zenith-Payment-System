-- =============================================================================
-- 0018_bug_fixes.sql
-- Schema changes that correspond to bug-fix patches in the application code.
--
-- B4: Add approval_ref to ReversalRecords (spec §2.2 post-settlement policy)
-- B5: Add partial UNIQUE index on (txid, prev_hash) so two concurrent writes to
--     the same FinalityLog chain cannot share the same prev_hash (breaks the
--     append-only property).
-- B6: Add UNIQUE index on event_seq so colliding sequence numbers are rejected
--     at the DB level rather than silently producing a branching chain.
-- B8: Add daily_amount_last_reset_date to Participants so the daily limit reset
--     can be detected and applied even when the EOD cron is delayed or missed.
-- =============================================================================

-- B4 -------------------------------------------------------------------------
ALTER TABLE ReversalRecords ADD COLUMN approval_ref TEXT;

-- B5 -------------------------------------------------------------------------
-- Partial unique index: within a given txid chain, no two entries may share the
-- same prev_hash.  This makes the second concurrent write fail atomically.
-- SQLite supports partial indexes (WHERE clause).
CREATE UNIQUE INDEX IF NOT EXISTS idx_fl_chain_prev_hash
  ON FinalityLog(txid, prev_hash) WHERE txid IS NOT NULL;

-- B6 -------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_fl_event_seq_unique
  ON FinalityLog(event_seq);

-- B8 -------------------------------------------------------------------------
ALTER TABLE Participants ADD COLUMN daily_amount_last_reset_date TEXT;
