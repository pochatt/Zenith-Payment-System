-- =============================================================================
-- schema/baseline.sql — Consolidated clean schema for Zenith Mock
--
-- This is NOT a migration. It documents the fully-intended schema as of
-- migrations 0001–0021, with each design decision stated explicitly.
-- Use this as the authoritative reference when bootstrapping a fresh DB
-- or reasoning about table structure.
--
-- Note: ALTER TABLE additions from 0004 (Participants.participation_mode,
-- tx_amount_limit, daily_amount_limit, daily_amount_used; Transactions
-- cross-border columns) are not yet consolidated here — those were
-- pre-existing gaps. All changes from 0015–0021 are reflected below.
--
-- Run order for fresh setup:
--   1. Apply this file (or run all migrations in order, which is equivalent).
--
-- Key design decisions recorded here:
--   • DnsCycles.business_date is NOT UNIQUE — allows multiple cycle_id values
--     per day (suffix-based IDs); uniqueness was dropped in 0012 to support
--     late-arriving holdDns cycles without collision.
--   • GtidLegs has idx_legs_txid — added in 0011 after orchestrator queries
--     (onPayeeExecConfirmed, suspendTx) showed full-table scans on txid.
--   • RtpRequests carries all status/notification columns upfront — added
--     incrementally in 0006–0008 as the RTP lifecycle was fleshed out.
--   • BankJournals uses signed amounts (positive = increase) with tx_group_id
--     as the zero-sum verification unit; no FK to BankAccounts by design so
--     internal accounts (ZCS, BOJ, RE, CASH) can be created without a row.
--   • CircuitBreakerState is keyed by bank_id — one row per participant bank,
--     state transitions: CLOSED → OPEN (on threshold failures) → HALF_OPEN
--     (after cooldown) → CLOSED (on success) or OPEN (on failure).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ZC SIDE
-- ---------------------------------------------------------------------------

CREATE TABLE Participants (
  bank_id          TEXT    PRIMARY KEY,
  bank_name        TEXT    NOT NULL,
  ingress_base_url TEXT    NOT NULL,
  h_limit          INTEGER NOT NULL DEFAULT 0,
  h_used           INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  registered_at    TEXT    NOT NULL,
  -- 0018 B8: daily limit reset date for auto-reset on EOD-cron-missed days
  daily_amount_last_reset_date TEXT,              -- 'YYYY-MM-DD'
  -- 0020: per-participant HIGH_VALUE auto-escalation threshold;
  --       NULL = fall back to ZC_HV_THRESHOLD env var (default 100,000,000 JPY)
  hv_threshold     INTEGER
);

CREATE TABLE Transactions (
  txid                  TEXT    PRIMARY KEY,
  lane                  TEXT    NOT NULL,           -- EXPRESS|STANDARD|BULK|DEFERRED|RTP|HTLC|HIGH_VALUE
  state                 TEXT    NOT NULL,           -- TxState
  amount_value          INTEGER NOT NULL,
  amount_currency       TEXT    NOT NULL DEFAULT 'JPY',
  payer_bank_id         TEXT    NOT NULL,
  payer_account_hash    TEXT    NOT NULL,
  payee_bank_id         TEXT    NOT NULL,
  payee_account_hash    TEXT,
  pspr_ref              TEXT,
  purpose               TEXT,                      -- MERCHANT|P2P|BILL|SALARY|REFUND
  idempotency_key       TEXT    UNIQUE NOT NULL,
  schema_version        TEXT    NOT NULL DEFAULT '1.0',
  h_reservation_id      TEXT,
  decision_proof_ref    TEXT,
  finality_log_ref      TEXT,
  payer_bank_proof_ref  TEXT,                      -- JSON BankProofRef
  payee_bank_proof_ref  TEXT,                      -- JSON BankProofRef
  reason_code           TEXT,
  case_id               TEXT,
  dns_cycle_id          TEXT,
  expires_at            TEXT,
  version               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE INDEX idx_tx_state ON Transactions(state);
CREATE INDEX idx_tx_payer ON Transactions(payer_bank_id, state);
CREATE INDEX idx_tx_payee ON Transactions(payee_bank_id, state);
CREATE INDEX idx_tx_dns   ON Transactions(dns_cycle_id);
-- 0016: hot-path indexes added after profiling showed full-table scans
CREATE INDEX IF NOT EXISTS idx_tx_updated_at ON Transactions(updated_at);    -- timeout sweep
CREATE INDEX IF NOT EXISTS idx_tx_lane_state ON Transactions(lane, state);   -- dashboard lane×state filter

CREATE TABLE HReservations (
  reservation_id TEXT    PRIMARY KEY,
  txid           TEXT    NOT NULL,
  bank_id        TEXT    NOT NULL,
  amount         INTEGER NOT NULL,
  mode           TEXT    NOT NULL DEFAULT 'RESERVED', -- RESERVED|LOCKED
  is_released    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  released_at    TEXT
);

CREATE INDEX idx_hres_bank ON HReservations(bank_id, is_released);

-- Immutable audit trail; append-only. event_seq is allocated by FinalitySeq
-- (0021) — a single-row counter atomically incremented via RETURNING,
-- replacing the previous Date.now()*1000+jitter scheme.
-- prev_hash / entry_hash (0015) form a SHA-256 hash chain for tamper evidence.
CREATE TABLE FinalityLog (
  log_id       TEXT    PRIMARY KEY,
  txid         TEXT,
  gtid         TEXT,
  event_type   TEXT    NOT NULL,
  state_from   TEXT,
  state_to     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  event_seq    INTEGER NOT NULL,
  occurred_at  TEXT    NOT NULL,
  -- 0015: SHA-256 hash chain (chain_id = COALESCE(txid, gtid, 'GLOBAL'))
  prev_hash    TEXT,              -- entry_hash of the predecessor in this chain
  entry_hash   TEXT               -- SHA-256 of this row's content
);

CREATE INDEX idx_fl_txid ON FinalityLog(txid);
CREATE INDEX idx_fl_gtid ON FinalityLog(gtid);
CREATE INDEX idx_fl_seq  ON FinalityLog(event_seq);
-- 0015: hash chain verification scans in (chain_id, event_seq) order
CREATE INDEX IF NOT EXISTS idx_fl_chain_seq   ON FinalityLog(txid, event_seq);
CREATE INDEX IF NOT EXISTS idx_fl_gchain_seq  ON FinalityLog(gtid, event_seq);
-- 0016: time-range audit queries
CREATE INDEX IF NOT EXISTS idx_fl_occurred_at ON FinalityLog(occurred_at);
-- 0018 B5: prevent two concurrent writes sharing the same prev_hash (chain fork)
CREATE UNIQUE INDEX IF NOT EXISTS idx_fl_chain_prev_hash
  ON FinalityLog(txid, prev_hash) WHERE txid IS NOT NULL;
-- 0018 B6: belt-and-braces guard against colliding event_seq values
CREATE UNIQUE INDEX IF NOT EXISTS idx_fl_event_seq_unique
  ON FinalityLog(event_seq);
-- 0019 B9: same fork-prevention for GTID-only entries (txid IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_fl_gtid_chain_prev_hash
  ON FinalityLog(gtid, prev_hash) WHERE gtid IS NOT NULL AND txid IS NULL;

-- business_date is intentionally NOT UNIQUE. Multiple cycle_ids can share
-- the same date (e.g. an intraday hold that spawns a new cycle after
-- resolution). The UNIQUE constraint present in 0001 was dropped in 0012.
CREATE TABLE DnsCycles (
  cycle_id      TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'OPEN',       -- OPEN|KICKED|SETTLED|HOLD_ACTIVE
  igs_mode      TEXT NOT NULL DEFAULT 'NORMAL',     -- NORMAL|STOP|RINGFENCED|RINGFENCED_PLUS
  kicked_at     TEXT,
  settled_at    TEXT,
  hold_reason   TEXT,
  net_positions TEXT,                               -- JSON {bank_id: net_amount}
  updated_at    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_dns_business_date ON DnsCycles(business_date);
-- 0016: state-based DNS cycle scans
CREATE INDEX IF NOT EXISTS idx_dns_state ON DnsCycles(state, created_at);

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

CREATE TABLE HtlcContracts (
  htlc_id                    TEXT    PRIMARY KEY,
  txid                       TEXT    NOT NULL UNIQUE,
  state                      TEXT    NOT NULL,       -- HtlcState
  hashlock                   TEXT    NOT NULL,
  timelock                   TEXT    NOT NULL,
  amount_value               INTEGER NOT NULL,
  payer_bank_id              TEXT    NOT NULL,
  payee_bank_id              TEXT    NOT NULL,
  secret_verified            INTEGER NOT NULL DEFAULT 0,
  authority_recheck_required INTEGER NOT NULL DEFAULT 0,
  version                    INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT    NOT NULL,
  updated_at                 TEXT    NOT NULL
);

-- 0016: timeout sweep and bank-side HTLC list queries
CREATE INDEX IF NOT EXISTS idx_htlc_payee_state ON HtlcContracts(payee_bank_id, state);
CREATE INDEX IF NOT EXISTS idx_htlc_payer_state ON HtlcContracts(payer_bank_id, state);
CREATE INDEX IF NOT EXISTS idx_htlc_timelock    ON HtlcContracts(timelock, state);

CREATE TABLE GtidTransactions (
  gtid               TEXT    PRIMARY KEY,
  state              TEXT    NOT NULL,               -- GtidState
  initiator_bank_id  TEXT    NOT NULL,
  total_amount       INTEGER NOT NULL,
  leg_count          INTEGER NOT NULL,
  legs_ready_count   INTEGER NOT NULL DEFAULT 0,
  legs_settled_count INTEGER NOT NULL DEFAULT 0,
  expires_at         TEXT,
  version            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE TABLE GtidLegs (
  leg_id         TEXT    PRIMARY KEY,
  gtid           TEXT    NOT NULL,
  txid           TEXT,
  role           TEXT    NOT NULL,                   -- PAYER|PAYEE
  bank_id        TEXT    NOT NULL,
  account_hash   TEXT    NOT NULL,
  amount_value   INTEGER NOT NULL,
  state          TEXT    NOT NULL,                   -- LegState
  bank_proof_ref TEXT,
  expires_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  FOREIGN KEY (gtid) REFERENCES GtidTransactions(gtid)
);

CREATE INDEX idx_legs_gtid ON GtidLegs(gtid);
-- Added in 0011: needed by onPayeeExecConfirmed and suspendTx which look
-- up GtidLegs by txid to find the parent GTID.
CREATE INDEX idx_legs_txid ON GtidLegs(txid);

CREATE TABLE Cases (
  case_id      TEXT PRIMARY KEY,
  related_txid TEXT,
  related_gtid TEXT,
  state        TEXT NOT NULL DEFAULT 'OPEN',
  reason_code  TEXT NOT NULL,
  description  TEXT,
  opened_by    TEXT NOT NULL,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_case_txid ON Cases(related_txid);
-- 0016: ops dashboard and GTID-case lookups
CREATE INDEX IF NOT EXISTS idx_case_state ON Cases(state, created_at);
CREATE INDEX IF NOT EXISTS idx_case_gtid  ON Cases(related_gtid);

CREATE TABLE Vault (
  vault_ref    TEXT    PRIMARY KEY,
  txid         TEXT,
  data_type    TEXT    NOT NULL,                     -- AML_EVAL|PII|RISK_HINT
  payload_json TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  is_evicted   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);

CREATE INDEX idx_vault_expires ON Vault(expires_at, is_evicted);

CREATE TABLE PsprRegistry (
  pspr_ref         TEXT PRIMARY KEY,
  payee_bank_id    TEXT NOT NULL,
  account_hash     TEXT NOT NULL,
  capability_state TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE|SUSPENDED|REVOKED
  digest           TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  revoked_at       TEXT
);

-- All RTP columns are present upfront. Columns were added incrementally
-- across 0006–0008 as the RTP lifecycle was designed:
--   0006: rtp_status, payee_name, description, edi_ref, notified_at
--   0007: payer_account_id, response_type, responded_at
--   0008: payee_account_hash (needed for payee-lookup in respondToRtp)
CREATE TABLE RtpRequests (
  rtp_id           TEXT    PRIMARY KEY,
  payee_bank_id    TEXT    NOT NULL,
  payer_bank_id    TEXT    NOT NULL,
  amount_value     INTEGER NOT NULL,
  state            TEXT    NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|ATTEMPTED|SETTLED|EXPIRED|FAILED
  -- rtp_status tracks the notification/response lifecycle (different from state):
  --   CREATED → NOTIFIED → ACCEPTED/REJECTED → TX_CREATED → COMPLETED/DECLINED/EXPIRED
  rtp_status       TEXT    NOT NULL DEFAULT 'CREATED',
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  linked_txid      TEXT,
  payee_name       TEXT,
  description      TEXT,
  edi_ref          TEXT,
  notified_at      TEXT,
  payer_account_id TEXT,
  response_type    TEXT,                               -- ACCEPTED|REJECTED
  responded_at     TEXT,
  payee_account_hash TEXT,
  expires_at       TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

-- 0016: bank-side RTP list and expiry sweep queries
CREATE INDEX IF NOT EXISTS idx_rtp_payer_state ON RtpRequests(payer_bank_id, state);
CREATE INDEX IF NOT EXISTS idx_rtp_payee_state ON RtpRequests(payee_bank_id, state);
CREATE INDEX IF NOT EXISTS idx_rtp_expires     ON RtpRequests(expires_at, state);

CREATE TABLE IdempotencyKeys (
  key           TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'PROCESSING',   -- PROCESSING|DONE
  response_body TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- 0016: TTL sweep deletes keys older than 24h
CREATE INDEX IF NOT EXISTS idx_idemp_created ON IdempotencyKeys(created_at);

-- ---------------------------------------------------------------------------
-- BANK SIDE
-- ---------------------------------------------------------------------------

CREATE TABLE BankAccounts (
  account_id    TEXT PRIMARY KEY,
  bank_id       TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  account_type  TEXT NOT NULL DEFAULT 'SAVINGS',      -- SAVINGS|CURRENT|SUSPENSE|SETTLEMENT|ASSET|BOJ
  status        TEXT NOT NULL DEFAULT 'NORMAL',       -- NORMAL|FROZEN|CLOSING_HOLD|CLOSED
  freeze_reason TEXT,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT
);

CREATE INDEX idx_acct_bank     ON BankAccounts(bank_id, status);
CREATE INDEX idx_acct_customer ON BankAccounts(customer_id);

-- Double-entry ledger; INSERT ONLY. tx_group_id identifies the zero-sum
-- group (all entries in a group must net to zero). No FK to BankAccounts
-- so internal synthetic accounts (ZCS, BOJ, RE, CASH) need no master row.
CREATE TABLE BankJournals (
  journal_id  TEXT    PRIMARY KEY,
  bank_id     TEXT    NOT NULL,
  account_id  TEXT    NOT NULL,
  amount      INTEGER NOT NULL,                       -- signed: positive=credit, negative=debit
  tx_type     TEXT    NOT NULL,
  txid        TEXT,
  tx_group_id TEXT    NOT NULL,
  description TEXT,
  value_date  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);

CREATE INDEX idx_jnl_account ON BankJournals(account_id, value_date);
CREATE INDEX idx_jnl_txid    ON BankJournals(txid);

CREATE TABLE ZcRequests (
  request_id    TEXT PRIMARY KEY,
  bank_id       TEXT NOT NULL,
  txid          TEXT,
  command_type  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PROCESSING',   -- PROCESSING|DONE|PROOF_ISSUED
  response_body TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE INDEX idx_zcreq_txid ON ZcRequests(txid);

CREATE TABLE SuspenseDetails (
  suspense_id   TEXT    PRIMARY KEY,
  bank_id       TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  direction     TEXT    NOT NULL,                     -- PAY|RECEIVE|HV_TRANSIT|HTLC
  status        TEXT    NOT NULL,                     -- SuspenseStatus
  amount        INTEGER NOT NULL,
  txid          TEXT,
  request_id    TEXT,
  dns_cycle_id  TEXT,
  expires_at    TEXT,
  custody_reason TEXT,
  settled_at    TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX idx_susp_txid   ON SuspenseDetails(txid);
CREATE INDEX idx_susp_status ON SuspenseDetails(bank_id, status);

-- ---------------------------------------------------------------------------
-- TRACE & OBSERVABILITY
-- ---------------------------------------------------------------------------

CREATE TABLE TxEventLog (
  log_id         TEXT PRIMARY KEY,
  txid           TEXT,
  correlation_id TEXT,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  status         TEXT NOT NULL,                       -- OK|NG|PENDING
  reason_code    TEXT,
  amount         INTEGER,
  bank_id        TEXT,
  account_id     TEXT,
  details_json   TEXT,
  duration_ms    INTEGER,
  occurred_at    TEXT NOT NULL
);

CREATE INDEX idx_txel_txid ON TxEventLog(txid);

CREATE TABLE BankAuditLog (
  log_id      TEXT PRIMARY KEY,
  bank_id     TEXT NOT NULL,
  txid        TEXT,
  request_id  TEXT,
  command     TEXT NOT NULL,
  status      TEXT NOT NULL,                          -- OK|NG
  reason_code TEXT,
  amount      INTEGER,
  account_id  TEXT,
  details_json TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_bal_bank ON BankAuditLog(bank_id, occurred_at);

-- ---------------------------------------------------------------------------
-- PAYMENT FILTERS
-- ---------------------------------------------------------------------------

CREATE TABLE PaymentFilters (
  filter_id      TEXT PRIMARY KEY,
  bank_id        TEXT NOT NULL,
  scope          TEXT NOT NULL,                       -- BANK_WIDE|ACCOUNT
  account_id     TEXT,
  filter_type    TEXT NOT NULL,                       -- SENDER_BLOCK|SENDER_BANK_BLOCK|AMOUNT_LIMIT|EDI_PATTERN|REQUIRE_APPROVAL
  condition_json TEXT NOT NULL,
  action         TEXT NOT NULL,                       -- REJECT|HOLD_CONFIRM|HOLD_MANUAL
  description    TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_pf_bank ON PaymentFilters(bank_id, is_active);

CREATE TABLE PaymentApprovalRequests (
  approval_id         TEXT PRIMARY KEY,
  bank_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  txid                TEXT NOT NULL,
  filter_id           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|REJECTED|TIMEOUT
  sender_bank_id      TEXT NOT NULL,
  sender_account_hash TEXT,
  amount_value        INTEGER NOT NULL,
  edi_data            TEXT,
  expires_at          TEXT NOT NULL,
  responded_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_par_txid ON PaymentApprovalRequests(txid);

-- ---------------------------------------------------------------------------
-- HTLC AUTH
-- ---------------------------------------------------------------------------

CREATE TABLE HtlcAuthWhitelist (
  whitelist_id           TEXT PRIMARY KEY,
  payee_bank_id          TEXT NOT NULL,
  payee_account_hash     TEXT NOT NULL,
  allowed_payer_bank_id  TEXT,
  max_amount             INTEGER,
  allowed_purposes       TEXT,                        -- JSON array
  description            TEXT,
  is_active              INTEGER NOT NULL DEFAULT 1,
  registered_at          TEXT NOT NULL,
  expires_at             TEXT
);

CREATE TABLE HtlcAuthRequests (
  auth_id             TEXT PRIMARY KEY,
  htlc_id             TEXT,
  txid                TEXT,
  status              TEXT NOT NULL,                  -- HtlcAuthStatus
  payee_bank_id       TEXT NOT NULL,
  payee_account_hash  TEXT NOT NULL,
  payer_bank_id       TEXT NOT NULL,
  payer_account_hash  TEXT NOT NULL,
  amount_value        INTEGER NOT NULL,
  purpose             TEXT,
  description         TEXT,
  auth_expires_at     TEXT NOT NULL,
  capture_expires_at  TEXT NOT NULL,
  vault_ref           TEXT,
  hashlock            TEXT,
  whitelist_id        TEXT NOT NULL,
  approved_at         TEXT,
  captured_at         TEXT,
  voided_at           TEXT,
  decline_reason      TEXT,
  idempotency_key     TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- NEW SETTLEMENT FEATURES (0004)
-- ---------------------------------------------------------------------------

CREATE TABLE IgsRequests (
  ext_instruction_id TEXT PRIMARY KEY,
  txid               TEXT NOT NULL,
  payer_bank_id      TEXT NOT NULL,
  payee_bank_id      TEXT NOT NULL,
  amount_value       INTEGER NOT NULL,
  amount_currency    TEXT NOT NULL DEFAULT 'JPY',
  status             TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|SETTLED|FAILED|HOLD|TIMEOUT
  boj_settle_ref     TEXT,
  requested_at       TEXT NOT NULL,
  settled_at         TEXT,
  failed_reason      TEXT,
  retry_count        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE AccountVerifications (
  verification_id      TEXT PRIMARY KEY,
  request_bank_id      TEXT NOT NULL,
  target_bank_id       TEXT NOT NULL,
  target_account_hash  TEXT NOT NULL,
  target_account_name  TEXT,
  status               TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|MATCHED|UNMATCHED|NOT_FOUND|ERROR|EXPIRED
  name_provided        TEXT,
  match_score          INTEGER,
  fraud_warning        INTEGER NOT NULL DEFAULT 0,
  cached_until         TEXT,
  idempotency_key      TEXT,
  created_at           TEXT NOT NULL,
  responded_at         TEXT
);

CREATE TABLE CreditNotifications (
  notification_id    TEXT PRIMARY KEY,
  txid               TEXT NOT NULL,
  payee_bank_id      TEXT NOT NULL,
  payee_account_hash TEXT NOT NULL,
  amount_value       INTEGER NOT NULL,
  amount_currency    TEXT NOT NULL DEFAULT 'JPY',
  payer_bank_id      TEXT NOT NULL,
  payer_name_masked  TEXT,
  purpose            TEXT,
  edi_summary        TEXT,
  status             TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|DELIVERED|FAILED|EXPIRED
  delivery_attempts  INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 3,
  created_at         TEXT NOT NULL,
  delivered_at       TEXT,
  next_retry_at      TEXT
);

CREATE INDEX idx_cn_txid ON CreditNotifications(txid);

CREATE TABLE EdiRecords (
  edi_ref             TEXT PRIMARY KEY,
  txid                TEXT,
  format_version      TEXT NOT NULL DEFAULT '1.0',
  invoice_number      TEXT,
  invoice_date        TEXT,
  payment_due_date    TEXT,
  tax_amount          INTEGER,
  tax_rate            REAL,
  discount_amount     INTEGER,
  note                TEXT,
  sender_ref          TEXT,
  receiver_ref        TEXT,
  line_items_json     TEXT,
  created_by_bank_id  TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE ProxyDirectory (
  proxy_id            TEXT PRIMARY KEY,
  proxy_type          TEXT NOT NULL,                  -- PHONE|EMAIL|NATIONAL_ID
  proxy_value         TEXT NOT NULL,
  bank_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  is_active           INTEGER NOT NULL DEFAULT 1,
  registered_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (proxy_type, proxy_value)                    -- one canonical account per alias
);

CREATE TABLE QrCodes (
  qr_ref           TEXT PRIMARY KEY,
  qr_type          TEXT NOT NULL,                     -- STATIC|DYNAMIC
  payee_bank_id    TEXT NOT NULL,
  payee_account_id TEXT NOT NULL,
  payee_name       TEXT NOT NULL,
  amount_value     INTEGER,
  amount_currency  TEXT NOT NULL DEFAULT 'JPY',
  purpose          TEXT,
  edi_ref          TEXT,
  signature        TEXT NOT NULL,
  is_used          INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE RichDataStore (
  data_ref           TEXT PRIMARY KEY,
  data_type          TEXT NOT NULL,                   -- EDI|INVOICE|ATTACHMENT_META|REMITTANCE
  txid               TEXT,
  content_json       TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  r2_key             TEXT,
  created_by_bank_id TEXT NOT NULL,
  retention_days     INTEGER NOT NULL DEFAULT 90,
  created_at         TEXT NOT NULL,
  expires_at         TEXT
);

CREATE TABLE CrossBorderTransactions (
  cb_txid            TEXT PRIMARY KEY,
  domestic_txid      TEXT,
  direction          TEXT NOT NULL,                   -- OUTBOUND|INBOUND
  foreign_fps_id     TEXT NOT NULL,
  foreign_bank_bic   TEXT NOT NULL,
  foreign_account_id TEXT NOT NULL,
  foreign_currency   TEXT NOT NULL,
  foreign_amount     INTEGER NOT NULL,
  exchange_rate      REAL,
  domestic_amount    INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'INITIATED', -- CrossBorderStatus
  settlement_bank_id TEXT,
  nostro_account_ref TEXT,
  fatf_data_json     TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE EventStream (
  event_id        TEXT PRIMARY KEY,
  target_bank_id  TEXT NOT NULL,
  event_type      TEXT NOT NULL,                      -- StreamEventType
  payload_json    TEXT NOT NULL,
  is_delivered    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_es_bank ON EventStream(target_bank_id, is_delivered);

-- ---------------------------------------------------------------------------
-- CIRCUIT BREAKER & REVERSALS (0014)
-- ---------------------------------------------------------------------------

-- Per-participant bank health state machine:
--   CLOSED → OPEN (after N consecutive failures)
--   OPEN   → HALF_OPEN (after cooldown duration)
--   HALF_OPEN → CLOSED (on success) | OPEN (on failure)
CREATE TABLE CircuitBreakerState (
  bank_id              TEXT PRIMARY KEY,
  state                TEXT    NOT NULL DEFAULT 'CLOSED', -- CLOSED|OPEN|HALF_OPEN
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at      TEXT,
  opened_at            TEXT,
  half_open_at         TEXT,
  updated_at           TEXT    NOT NULL,
  -- 0017: observable metrics for operator dashboards and HALF_OPEN probe throttling
  total_requests     INTEGER NOT NULL DEFAULT 0,   -- lifetime allowed requests (CLOSED + HALF_OPEN)
  total_successes    INTEGER NOT NULL DEFAULT 0,   -- lifetime recordSuccess() calls
  total_failures     INTEGER NOT NULL DEFAULT 0,   -- lifetime recordFailure() calls
  total_denied       INTEGER NOT NULL DEFAULT 0,   -- lifetime fast-failed requests (state=OPEN)
  half_open_inflight INTEGER NOT NULL DEFAULT 0,   -- probes currently outstanding
  last_success_at    TEXT                          -- ISO-8601 timestamp of latest success
);

-- Post-settlement compensation; original_txid must be in SETTLED state.
CREATE TABLE ReversalRecords (
  reversal_id   TEXT PRIMARY KEY,
  original_txid TEXT    NOT NULL,
  reversal_txid TEXT,
  amount        INTEGER NOT NULL,
  reason        TEXT    NOT NULL,                     -- CUSTOMER_DISPUTE|DUPLICATE_PAYMENT|...
  status        TEXT    NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|APPROVED|TX_CREATED|COMPLETED|REJECTED
  requested_by  TEXT    NOT NULL,
  description   TEXT,
  -- 0018 B4: approval reference required for certain reversal reason codes
  approval_ref  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX idx_rev_original   ON ReversalRecords(original_txid);
CREATE INDEX idx_rev_reversal_tx ON ReversalRecords(reversal_txid);

-- ---------------------------------------------------------------------------
-- SEED DATA
-- ---------------------------------------------------------------------------

-- Participants (ZC side)
INSERT OR IGNORE INTO Participants
  (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
VALUES
  ('001', 'みずほ銀行',  '/bank/001', 100000000, 0, 1, '2025-01-01T00:00:00Z'),
  ('002', '三菱UFJ銀行', '/bank/002', 100000000, 0, 1, '2025-01-01T00:00:00Z');

-- ---------------------------------------------------------------------------
-- FINALITY SEQ COUNTER (0021)
-- ---------------------------------------------------------------------------

-- Monotonic event_seq allocator for FinalityLog. Replaces the previous
-- Date.now()*1000+jitter scheme. Single row enforced by CHECK(id = 1).
-- Allocated via: UPDATE FinalitySeq SET next_seq = next_seq + 1 WHERE id = 1 RETURNING next_seq
CREATE TABLE IF NOT EXISTS FinalitySeq (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  next_seq  INTEGER NOT NULL
);

-- Seed at MAX(event_seq) so monotonicity is preserved across migration.
-- INSERT OR IGNORE makes this idempotent on re-application.
INSERT OR IGNORE INTO FinalitySeq (id, next_seq)
VALUES (1, COALESCE((SELECT MAX(event_seq) FROM FinalityLog), 0));

-- Retained Earnings internal accounts (one per bank, type ASSET)
-- Added in 0013 to separate interest accrual from suspense balances.
INSERT OR IGNORE INTO BankAccounts
  (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
VALUES
  ('001-RE', '001', 'INTERNAL', '利益剰余金', 'ASSET', 'NORMAL', '2025-01-01T00:00:00Z'),
  ('002-RE', '002', 'INTERNAL', '利益剰余金', 'ASSET', 'NORMAL', '2025-01-01T00:00:00Z');

-- BOJ prefund initial journals (0009): each bank pre-positions 10M JPY.
--   ZCS(+prefund) / BOJ(-prefund) = 0 zero-sum ✓
--   BOJ negative balance = available prefund (checked as: balance + amount > 0 → insufficient)
INSERT OR IGNORE INTO BankJournals
  (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
VALUES
  ('JNL-BOJ-INIT-001-ZCS', '001', '001-ZCS',  10000000, 'CASH', 'BOJ-INIT-001', 'RTGS prefund ZCS(+)', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-001-BOJ', '001', '001-BOJ', -10000000, 'CASH', 'BOJ-INIT-001', 'RTGS prefund BOJ(-)', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-002-ZCS', '002', '002-ZCS',  10000000, 'CASH', 'BOJ-INIT-002', 'RTGS prefund ZCS(+)', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-002-BOJ', '002', '002-BOJ', -10000000, 'CASH', 'BOJ-INIT-002', 'RTGS prefund BOJ(-)', '2025-01-01', '2025-01-01T00:00:00Z');
