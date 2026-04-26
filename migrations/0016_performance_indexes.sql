-- =============================================================================
-- 0016_performance_indexes.sql
--
-- Add hot-path indexes that were missing from the original schema. Each one
-- backs a query that previously required a full table scan; without them,
-- p99 latency degrades super-linearly as data grows.
--
-- Why these and not others:
--   - We only add indexes for queries that exist TODAY in the codebase.
--   - Composite indexes are ordered by (high-selectivity column, range column)
--     so they double as covering indexes for the most common predicates.
--   - All statements are IF NOT EXISTS to remain replayable.
--
-- See specs/schema.md § Index Catalog for the full list.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------
-- Used by cron/timeout_sweep.ts when scanning for stale rows.
CREATE INDEX IF NOT EXISTS idx_tx_updated_at ON Transactions(updated_at);

-- Used by ZC query handlers that filter by lane (e.g. dashboard "Show only
-- HTLC in HTLC_LOCKED"). Without this, every list query scans Transactions.
CREATE INDEX IF NOT EXISTS idx_tx_lane_state ON Transactions(lane, state);

-- ---------------------------------------------------------------------------
-- FinalityLog
-- ---------------------------------------------------------------------------
-- Audit / explainability queries by time range
-- (specs/api-contracts.md § GET /api/finality/recent).
CREATE INDEX IF NOT EXISTS idx_fl_occurred_at ON FinalityLog(occurred_at);

-- ---------------------------------------------------------------------------
-- HtlcContracts
-- ---------------------------------------------------------------------------
-- Timeout sweep walks (payee_bank_id, state) to find expired HTLC_LOCKED rows.
CREATE INDEX IF NOT EXISTS idx_htlc_payee_state ON HtlcContracts(payee_bank_id, state);
CREATE INDEX IF NOT EXISTS idx_htlc_payer_state ON HtlcContracts(payer_bank_id, state);
-- Timelock-driven cleanup
CREATE INDEX IF NOT EXISTS idx_htlc_timelock   ON HtlcContracts(timelock, state);

-- ---------------------------------------------------------------------------
-- RtpRequests
-- ---------------------------------------------------------------------------
-- Bank-side queries: "give me my RTP requests, newest first".
CREATE INDEX IF NOT EXISTS idx_rtp_payer_state ON RtpRequests(payer_bank_id, state);
CREATE INDEX IF NOT EXISTS idx_rtp_payee_state ON RtpRequests(payee_bank_id, state);
-- Expired-RTP sweep
CREATE INDEX IF NOT EXISTS idx_rtp_expires     ON RtpRequests(expires_at, state);

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------
-- Ops dashboards filter by state (OPEN | IN_PROGRESS | RESOLVED).
CREATE INDEX IF NOT EXISTS idx_case_state      ON Cases(state, created_at);
CREATE INDEX IF NOT EXISTS idx_case_gtid       ON Cases(related_gtid);

-- ---------------------------------------------------------------------------
-- IdempotencyKeys
-- ---------------------------------------------------------------------------
-- TTL sweep: delete idempotency keys older than 24h.
CREATE INDEX IF NOT EXISTS idx_idemp_created   ON IdempotencyKeys(created_at);

-- ---------------------------------------------------------------------------
-- DnsCycles / DnsNetPositions
-- ---------------------------------------------------------------------------
-- DNS daily kick scans by state (KICKED | HELD | SETTLED).
CREATE INDEX IF NOT EXISTS idx_dns_state       ON DnsCycles(state, created_at);
