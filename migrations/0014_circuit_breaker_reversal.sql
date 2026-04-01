-- =============================================================================
-- 0014_circuit_breaker_reversal.sql
-- Add Circuit Breaker state table and Reversal records table.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CircuitBreakerState — per-participant bank health tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS CircuitBreakerState (
  bank_id               TEXT PRIMARY KEY,
  state                 TEXT NOT NULL DEFAULT 'CLOSED',  -- CLOSED|OPEN|HALF_OPEN
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_failure_at       TEXT,
  opened_at             TEXT,
  half_open_at          TEXT,
  updated_at            TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- ReversalRecords — post-settlement compensation transactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ReversalRecords (
  reversal_id    TEXT PRIMARY KEY,
  original_txid  TEXT NOT NULL,                -- FK → Transactions.txid (SETTLED)
  reversal_txid  TEXT,                         -- FK → Transactions.txid (the compensating TX)
  amount         INTEGER NOT NULL,
  reason         TEXT NOT NULL,                -- CUSTOMER_DISPUTE|DUPLICATE_PAYMENT|...
  status         TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|APPROVED|TX_CREATED|COMPLETED|REJECTED
  requested_by   TEXT NOT NULL,                -- bank_id or 'OPS'
  description    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rev_original ON ReversalRecords(original_txid);
CREATE INDEX IF NOT EXISTS idx_rev_reversal_tx ON ReversalRecords(reversal_txid);
