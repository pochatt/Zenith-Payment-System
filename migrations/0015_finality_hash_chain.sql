-- =============================================================================
-- 0015_finality_hash_chain.sql
-- Tamper-evident FinalityLog: each entry binds to its predecessor via SHA-256.
-- Chain identifier = COALESCE(txid, gtid, 'GLOBAL').
-- =============================================================================

ALTER TABLE FinalityLog ADD COLUMN prev_hash  TEXT;
ALTER TABLE FinalityLog ADD COLUMN entry_hash TEXT;

-- Verification queries scan the chain in (chain_id, event_seq) order.
CREATE INDEX IF NOT EXISTS idx_fl_chain_seq ON FinalityLog(txid, event_seq);
CREATE INDEX IF NOT EXISTS idx_fl_gchain_seq ON FinalityLog(gtid, event_seq);
