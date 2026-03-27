-- =============================================================================
-- 0004_new_settlement.sql  新決済機能追加スキーマ
-- 「資金決済システムの将来像に関するスタディグループ」報告書(2026年3月)対応
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. IgsRequests（IGS連携 — 日銀ネット即時グロス清算）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS IgsRequests (
  ext_instruction_id  TEXT PRIMARY KEY,
  txid                TEXT NOT NULL,
  payer_bank_id       TEXT NOT NULL,
  payee_bank_id       TEXT NOT NULL,
  amount_value        INTEGER NOT NULL,
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  status              TEXT NOT NULL DEFAULT 'REQUESTED',
  boj_settle_ref      TEXT,
  requested_at        TEXT NOT NULL,
  settled_at          TEXT,
  failed_reason       TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_igs_txid   ON IgsRequests(txid);
CREATE INDEX IF NOT EXISTS idx_igs_status ON IgsRequests(status);

-- ---------------------------------------------------------------------------
-- 2. AccountVerifications（事前口座確認）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS AccountVerifications (
  verification_id     TEXT PRIMARY KEY,
  request_bank_id     TEXT NOT NULL,
  target_bank_id      TEXT NOT NULL,
  target_account_hash TEXT NOT NULL,
  target_account_name TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  name_provided       TEXT,
  match_score         REAL,
  fraud_warning       INTEGER NOT NULL DEFAULT 0,
  cached_until        TEXT,
  idempotency_key     TEXT UNIQUE,
  created_at          TEXT NOT NULL,
  responded_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_av_target ON AccountVerifications(target_bank_id, target_account_hash);
CREATE INDEX IF NOT EXISTS idx_av_status ON AccountVerifications(status);

-- ---------------------------------------------------------------------------
-- 3. CreditNotifications（入金結果通知）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS CreditNotifications (
  notification_id     TEXT PRIMARY KEY,
  txid                TEXT NOT NULL,
  payee_bank_id       TEXT NOT NULL,
  payee_account_hash  TEXT NOT NULL,
  amount_value        INTEGER NOT NULL,
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  payer_bank_id       TEXT NOT NULL,
  payer_name_masked   TEXT,
  purpose             TEXT,
  edi_summary         TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  delivery_attempts   INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 5,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT,
  next_retry_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cn_payee ON CreditNotifications(payee_bank_id, status);
CREATE INDEX IF NOT EXISTS idx_cn_txid  ON CreditNotifications(txid);

-- ---------------------------------------------------------------------------
-- 4. EdiRecords（ZEDI統合 — 全銀EDIリッチデータ）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS EdiRecords (
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
CREATE INDEX IF NOT EXISTS idx_edi_txid    ON EdiRecords(txid);
CREATE INDEX IF NOT EXISTS idx_edi_invoice ON EdiRecords(invoice_number);

-- ---------------------------------------------------------------------------
-- 5. ProxyDirectory（エイリアス送金）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ProxyDirectory (
  proxy_id            TEXT PRIMARY KEY,
  proxy_type          TEXT NOT NULL,
  proxy_value         TEXT NOT NULL,
  bank_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  is_active           INTEGER NOT NULL DEFAULT 1,
  registered_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(proxy_type, proxy_value)
);
CREATE INDEX IF NOT EXISTS idx_proxy_lookup ON ProxyDirectory(proxy_type, proxy_value, is_active);
CREATE INDEX IF NOT EXISTS idx_proxy_bank   ON ProxyDirectory(bank_id, account_id);

-- ---------------------------------------------------------------------------
-- 6. QrCodes（QRコード送金）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS QrCodes (
  qr_ref              TEXT PRIMARY KEY,
  qr_type             TEXT NOT NULL,
  payee_bank_id       TEXT NOT NULL,
  payee_account_id    TEXT NOT NULL,
  payee_name          TEXT NOT NULL,
  amount_value        INTEGER,
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  purpose             TEXT,
  edi_ref             TEXT,
  signature           TEXT NOT NULL,
  is_used             INTEGER NOT NULL DEFAULT 0,
  expires_at          TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_payee ON QrCodes(payee_bank_id);

-- ---------------------------------------------------------------------------
-- 7. RichDataStore（リッチデータストレージ）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS RichDataStore (
  data_ref            TEXT PRIMARY KEY,
  data_type           TEXT NOT NULL,
  txid                TEXT,
  content_json        TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  r2_key              TEXT,
  created_by_bank_id  TEXT NOT NULL,
  retention_days      INTEGER NOT NULL DEFAULT 2555,
  created_at          TEXT NOT NULL,
  expires_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_rds_txid ON RichDataStore(txid);
CREATE INDEX IF NOT EXISTS idx_rds_type ON RichDataStore(data_type);

-- ---------------------------------------------------------------------------
-- 8. CrossBorderTransactions（クロスボーダー送金）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS CrossBorderTransactions (
  cb_txid             TEXT PRIMARY KEY,
  domestic_txid       TEXT,
  direction           TEXT NOT NULL,
  foreign_fps_id      TEXT NOT NULL,
  foreign_bank_bic    TEXT NOT NULL,
  foreign_account_id  TEXT NOT NULL,
  foreign_currency    TEXT NOT NULL,
  foreign_amount      INTEGER NOT NULL,
  exchange_rate       REAL,
  domestic_amount     INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'INITIATED',
  settlement_bank_id  TEXT,
  nostro_account_ref  TEXT,
  fatf_data_json      TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cb_domestic ON CrossBorderTransactions(domestic_txid);
CREATE INDEX IF NOT EXISTS idx_cb_status   ON CrossBorderTransactions(status);

-- ---------------------------------------------------------------------------
-- 9. EventStream（双方向通信 — SSEイベントキュー）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS EventStream (
  event_id            TEXT PRIMARY KEY,
  target_bank_id      TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  is_delivered        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_es_bank ON EventStream(target_bank_id, is_delivered, created_at);

-- ---------------------------------------------------------------------------
-- 10. Transactions テーブル拡張（ALTER TABLE）
-- ---------------------------------------------------------------------------
ALTER TABLE Transactions ADD COLUMN external_settlement_status TEXT DEFAULT 'NONE';
ALTER TABLE Transactions ADD COLUMN verification_id TEXT;
ALTER TABLE Transactions ADD COLUMN edi_ref TEXT;
ALTER TABLE Transactions ADD COLUMN fatf_data_json TEXT;
ALTER TABLE Transactions ADD COLUMN is_cross_border INTEGER NOT NULL DEFAULT 0;
ALTER TABLE Transactions ADD COLUMN fatf16_applicable INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 11. Participants テーブル拡張
-- ---------------------------------------------------------------------------
ALTER TABLE Participants ADD COLUMN participation_mode TEXT NOT NULL DEFAULT 'FULL';
ALTER TABLE Participants ADD COLUMN tx_amount_limit INTEGER;
ALTER TABLE Participants ADD COLUMN daily_amount_limit INTEGER;
ALTER TABLE Participants ADD COLUMN daily_amount_used INTEGER NOT NULL DEFAULT 0;

-- section 12 は削除済み。
-- RtpRequestRows は 0005_rtp_request_rows.sql で全カラム込みで CREATE TABLE IF NOT EXISTS する。
-- （0004 でここを ALTER TABLE すると、テーブル未存在で FAIL し 0005 以降が適用されないため）
