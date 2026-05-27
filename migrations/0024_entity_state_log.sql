-- =============================================================================
-- 0024_entity_state_log.sql
-- EntityStateLog — append-only state-transition log for non-Transaction entities.
--
-- The money-path state machine (Transactions / HtlcContracts / GtidTransactions
-- / GtidLegs) already records every state overwrite as an immutable FinalityLog
-- entry via transitionWithLog, and DNS cycle transitions are logged on the
-- 'DNS-' FinalityLog chain. Several operational entities, however, overwrote
-- their status column with no paired fact, so their transition history was
-- lost on every UPDATE:
--
--   * Cases.state            (OPEN → IN_PROGRESS → RESOLVED / ESCALATED)
--   * PsprRegistry.capability_state (ACTIVE → SUSPENDED → REVOKED)
--   * BankAccounts.status    (NORMAL → FROZEN → CLOSING_HOLD → CLOSED)
--   * ReversalRecords.status (REQUESTED → TX_CREATED → COMPLETED / REJECTED)
--
-- EntityStateLog closes that gap with the same shape the rest of the system
-- already uses: keep the status column as a fast current-state projection, but
-- append one immutable fact (state_from → state_to) per change. The table is
-- INSERT-ONLY — it is never UPDATEd or DELETEd.
-- =============================================================================

CREATE TABLE IF NOT EXISTS EntityStateLog (
  log_id       TEXT    PRIMARY KEY,           -- 'ESL-<uuid>'
  entity_type  TEXT    NOT NULL,              -- 'CASE'|'PSPR'|'BANK_ACCOUNT'|'REVERSAL'
  entity_id    TEXT    NOT NULL,              -- the entity row's primary key value
  event_type   TEXT    NOT NULL,              -- domain event name (e.g. 'CaseOpened')
  state_from   TEXT,                          -- previous state; NULL on creation
  state_to     TEXT    NOT NULL,              -- new state
  reason_code  TEXT,                          -- optional reason for the change
  actor        TEXT,                          -- 'ZC'|'OPS'|'BANK_{bankId}'|'SYSTEM'
  payload_json TEXT,                          -- optional extra context (JSON)
  occurred_at  TEXT    NOT NULL               -- RFC3339
);

CREATE INDEX IF NOT EXISTS idx_esl_entity   ON EntityStateLog(entity_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_esl_occurred ON EntityStateLog(occurred_at);
