-- =============================================================================
-- 0001_zc_schema.sql  ZC側テーブル定義
-- Zenith Coordinator (ZC) — Cloudflare D1 (SQLite)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Participants（参加主体）
-- ---------------------------------------------------------------------------
CREATE TABLE Participants (
  bank_id          TEXT    PRIMARY KEY,             -- '001', '002', ...
  bank_name        TEXT    NOT NULL,
  ingress_base_url TEXT    NOT NULL,                -- '/bank/001'
  h_limit          INTEGER NOT NULL DEFAULT 0,      -- H上限（円）
  h_used           INTEGER NOT NULL DEFAULT 0,      -- H消費中（円）
  is_active        INTEGER NOT NULL DEFAULT 1,
  registered_at    TEXT    NOT NULL                 -- RFC3339
);

-- ---------------------------------------------------------------------------
-- Transactions（取引）
-- ---------------------------------------------------------------------------
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
  h_reservation_id      TEXT,                      -- FK → HReservations
  decision_proof_ref    TEXT,
  finality_log_ref      TEXT,
  payer_bank_proof_ref  TEXT,                      -- JSON: bank_proof_ref構造
  payee_bank_proof_ref  TEXT,                      -- JSON: bank_proof_ref構造
  reason_code           TEXT,
  case_id               TEXT,
  dns_cycle_id          TEXT,
  expires_at            TEXT,                      -- RFC3339
  version               INTEGER NOT NULL DEFAULT 0, -- 楽観的ロック
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE INDEX idx_tx_state ON Transactions(state);
CREATE INDEX idx_tx_payer ON Transactions(payer_bank_id, state);
CREATE INDEX idx_tx_payee ON Transactions(payee_bank_id, state);
CREATE INDEX idx_tx_dns   ON Transactions(dns_cycle_id);

-- ---------------------------------------------------------------------------
-- HReservations（H予約）
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- FinalityLog（不変ログ・INSERT ONLY）
-- ---------------------------------------------------------------------------
CREATE TABLE FinalityLog (
  log_id       TEXT    PRIMARY KEY,                -- UUID
  txid         TEXT,
  gtid         TEXT,
  event_type   TEXT    NOT NULL,                   -- A.0 cmd/event一覧のname
  state_from   TEXT,
  state_to     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,                   -- イベント全体
  event_seq    INTEGER NOT NULL,
  occurred_at  TEXT    NOT NULL
);

CREATE INDEX idx_fl_txid ON FinalityLog(txid);
CREATE INDEX idx_fl_gtid ON FinalityLog(gtid);
CREATE INDEX idx_fl_seq  ON FinalityLog(event_seq);

-- ---------------------------------------------------------------------------
-- DnsCycles（DNSサイクル）
-- ---------------------------------------------------------------------------
CREATE TABLE DnsCycles (
  cycle_id      TEXT PRIMARY KEY,
  business_date TEXT NOT NULL UNIQUE,              -- 'YYYY-MM-DD'
  state         TEXT NOT NULL DEFAULT 'OPEN',      -- OPEN|KICKED|SETTLED|HOLD_ACTIVE
  igs_mode      TEXT NOT NULL DEFAULT 'NORMAL',    -- NORMAL|STOP|RINGFENCED|RINGFENCED_PLUS
  kicked_at     TEXT,
  settled_at    TEXT,
  hold_reason   TEXT,
  net_positions TEXT,                              -- JSON: {bank_id: net_amount}
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- DnsNetPositions（DNS清算明細）
-- ---------------------------------------------------------------------------
CREATE TABLE DnsNetPositions (
  id            TEXT    PRIMARY KEY,
  cycle_id      TEXT    NOT NULL,
  bank_id       TEXT    NOT NULL,
  gross_send    INTEGER NOT NULL DEFAULT 0,
  gross_receive INTEGER NOT NULL DEFAULT 0,
  net_position  INTEGER NOT NULL DEFAULT 0,        -- 正=受取超、負=支払超
  is_settled    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (cycle_id) REFERENCES DnsCycles(cycle_id)
);

-- ---------------------------------------------------------------------------
-- HtlcContracts（HTLC取引）
-- ---------------------------------------------------------------------------
CREATE TABLE HtlcContracts (
  htlc_id                    TEXT    PRIMARY KEY,
  txid                       TEXT    NOT NULL UNIQUE,
  state                      TEXT    NOT NULL,     -- HtlcState
  hashlock                   TEXT    NOT NULL,     -- SHA256ハッシュ（hex）
  timelock                   TEXT    NOT NULL,     -- RFC3339（期限）
  amount_value               INTEGER NOT NULL,
  payer_bank_id              TEXT    NOT NULL,
  payee_bank_id              TEXT    NOT NULL,
  secret_verified            INTEGER NOT NULL DEFAULT 0, -- 1=検証済み
  authority_recheck_required INTEGER NOT NULL DEFAULT 0,
  version                    INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT    NOT NULL,
  updated_at                 TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- GtidTransactions（GTID取引）
-- ---------------------------------------------------------------------------
CREATE TABLE GtidTransactions (
  gtid               TEXT    PRIMARY KEY,
  state              TEXT    NOT NULL,             -- GtidState
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

-- ---------------------------------------------------------------------------
-- GtidLegs（GTIDの脚）
-- ---------------------------------------------------------------------------
CREATE TABLE GtidLegs (
  leg_id         TEXT    PRIMARY KEY,
  gtid           TEXT    NOT NULL,
  txid           TEXT,                             -- 紐付くtxid（DECIDED後に確定）
  role           TEXT    NOT NULL,                 -- PAYER|PAYEE
  bank_id        TEXT    NOT NULL,
  account_hash   TEXT    NOT NULL,
  amount_value   INTEGER NOT NULL,
  state          TEXT    NOT NULL,                 -- LegState
  bank_proof_ref TEXT,                             -- JSON
  expires_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  FOREIGN KEY (gtid) REFERENCES GtidTransactions(gtid)
);

CREATE INDEX idx_legs_gtid ON GtidLegs(gtid);

-- ---------------------------------------------------------------------------
-- Cases（例外処理チケット）
-- ---------------------------------------------------------------------------
CREATE TABLE Cases (
  case_id      TEXT PRIMARY KEY,
  related_txid TEXT,
  related_gtid TEXT,
  state        TEXT NOT NULL DEFAULT 'OPEN',       -- CaseState: OPEN|IN_PROGRESS|RESOLVED|ESCALATED
  reason_code  TEXT NOT NULL,
  description  TEXT,
  opened_by    TEXT NOT NULL,                      -- 'ZC'|'BANK'|'OPS'
  resolved_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_case_txid ON Cases(related_txid);

-- ---------------------------------------------------------------------------
-- Vault（短期秘匿ストア）
-- ---------------------------------------------------------------------------
CREATE TABLE Vault (
  vault_ref    TEXT    PRIMARY KEY,
  txid         TEXT,
  data_type    TEXT    NOT NULL,                   -- 'AML_EVAL'|'PII'|'RISK_HINT'
  payload_json TEXT    NOT NULL,                   -- 暗号化不要（モック）
  expires_at   TEXT    NOT NULL,                   -- TTL
  is_evicted   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);

CREATE INDEX idx_vault_expires ON Vault(expires_at, is_evicted);

-- ---------------------------------------------------------------------------
-- PsprRegistry（PSPR登録）
-- ---------------------------------------------------------------------------
CREATE TABLE PsprRegistry (
  pspr_ref         TEXT PRIMARY KEY,
  payee_bank_id    TEXT NOT NULL,
  account_hash     TEXT NOT NULL,
  capability_state TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|SUSPENDED|REVOKED
  digest           TEXT NOT NULL,                  -- 内容ハッシュ（改ざん検知）
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  revoked_at       TEXT
);

-- ---------------------------------------------------------------------------
-- RtpRequests（RTP請求）
-- ---------------------------------------------------------------------------
CREATE TABLE RtpRequests (
  rtp_id        TEXT    PRIMARY KEY,
  payee_bank_id TEXT    NOT NULL,
  payer_bank_id TEXT    NOT NULL,
  amount_value  INTEGER NOT NULL,
  state         TEXT    NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|ATTEMPTED|SETTLED|EXPIRED|FAILED
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  linked_txid   TEXT,
  expires_at    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- IdempotencyKeys（冪等キー管理：ZC側）
-- ---------------------------------------------------------------------------
CREATE TABLE IdempotencyKeys (
  key           TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'PROCESSING', -- PROCESSING|DONE
  response_body TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- ---------------------------------------------------------------------------
-- 初期データ: 参加行（001=みずほ、002=三菱UFJ）
-- /internal/seed を呼ぶと上書きリセットされる。未seed環境でも最低限動作するよう配置。
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at) VALUES
  ('001', 'みずほ銀行',    '/bank/001', 100000000, 0, 1, '2025-01-01T00:00:00Z'),
  ('002', '三菱UFJ銀行',   '/bank/002', 100000000, 0, 1, '2025-01-01T00:00:00Z');
