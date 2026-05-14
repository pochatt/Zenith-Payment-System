-- =============================================================================
-- 0019_gtid_chain_fix.sql
--
-- B9: Add partial UNIQUE index on (gtid, prev_hash) for GTID-only FinalityLog
-- entries. GTID entries have txid=NULL and gtid='GT-xxx'. Without this index,
-- concurrent writes to the same GTID chain can share the same prev_hash value,
-- silently producing a branching (non-linear) audit chain. This mirrors the
-- existing idx_fl_chain_prev_hash index that protects TX chains.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_fl_gtid_chain_prev_hash
  ON FinalityLog(gtid, prev_hash) WHERE gtid IS NOT NULL AND txid IS NULL;
