-- =============================================================================
-- 0002_bank_schema.sql  Bank側テーブル定義
-- Bank Mock (B001 / B002) — Cloudflare D1 (SQLite)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- BankAccounts（口座マスター）
-- ---------------------------------------------------------------------------
CREATE TABLE BankAccounts (
  account_id    TEXT PRIMARY KEY,              -- UUID
  bank_id       TEXT NOT NULL,                 -- '001'|'002'
  customer_id   TEXT NOT NULL,
  customer_name TEXT NOT NULL,                 -- 名義（名義確認用）
  account_type  TEXT NOT NULL DEFAULT 'SAVINGS', -- SAVINGS|CURRENT|SUSPENSE|SETTLEMENT|ASSET|BOJ
  status        TEXT NOT NULL DEFAULT 'NORMAL',  -- NORMAL|FROZEN|CLOSING_HOLD|CLOSED
  freeze_reason TEXT,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT
);

CREATE INDEX idx_acct_bank     ON BankAccounts(bank_id, status);
CREATE INDEX idx_acct_customer ON BankAccounts(customer_id);

-- ---------------------------------------------------------------------------
-- BankJournals（元帳：ゼロサム・INSERT ONLY）
-- ---------------------------------------------------------------------------
CREATE TABLE BankJournals (
  journal_id  TEXT    PRIMARY KEY,             -- UUID
  bank_id     TEXT    NOT NULL,
  account_id  TEXT    NOT NULL,
  amount      INTEGER NOT NULL,                -- 符号付き（正=増加、負=減少）
  tx_type     TEXT    NOT NULL,                -- TRANSFER|RESERVE|EXECUTE|CREDIT|INTEREST|CASH|CORRECTION
  txid        TEXT,                            -- ZC取引ID（外部参照）
  tx_group_id TEXT    NOT NULL,                -- 仕訳グループ（ゼロサム確認単位）
  description TEXT,
  value_date  TEXT    NOT NULL,                -- 勘定日付 'YYYY-MM-DD'
  created_at  TEXT    NOT NULL
);

CREATE INDEX idx_jnl_account ON BankJournals(account_id, value_date);
CREATE INDEX idx_jnl_txid    ON BankJournals(txid);
CREATE INDEX idx_jnl_group   ON BankJournals(tx_group_id);

-- ---------------------------------------------------------------------------
-- ZcRequests（ZC指示の冪等管理）
-- ---------------------------------------------------------------------------
CREATE TABLE ZcRequests (
  request_id    TEXT PRIMARY KEY,              -- ZCのidempotency_key
  bank_id       TEXT NOT NULL,
  txid          TEXT,
  command_type  TEXT NOT NULL,                 -- reserve-funds|execute-debit|execute-credit|...
  status        TEXT NOT NULL DEFAULT 'PROCESSING', -- PROCESSING|DONE|PROOF_ISSUED
  response_body TEXT,                          -- 処理済みレスポンスJSON（重複時に返す）
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE INDEX idx_zcreq_txid ON ZcRequests(txid);

-- ---------------------------------------------------------------------------
-- SuspenseDetails（別段預金明細）
-- ---------------------------------------------------------------------------
CREATE TABLE SuspenseDetails (
  suspense_id    TEXT    PRIMARY KEY,          -- UUID
  bank_id        TEXT    NOT NULL,
  account_id     TEXT    NOT NULL,             -- 元口座
  direction      TEXT    NOT NULL,             -- PAY|RECEIVE|HV_TRANSIT|HTLC
  status         TEXT    NOT NULL,             -- SuspenseStatus
  amount         INTEGER NOT NULL,
  txid           TEXT,
  request_id     TEXT,                         -- ZC request_id
  dns_cycle_id   TEXT,
  expires_at     TEXT,                         -- HTLC timelock
  custody_reason TEXT,                         -- CUSTODY時の理由
  settled_at     TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX idx_susp_account ON SuspenseDetails(account_id, status);
CREATE INDEX idx_susp_txid    ON SuspenseDetails(txid);

-- ---------------------------------------------------------------------------
-- DailyBalances（日次残高スナップショット）
-- ---------------------------------------------------------------------------
CREATE TABLE DailyBalances (
  account_id       TEXT    NOT NULL,
  snapshot_date    TEXT    NOT NULL,           -- 'YYYY-MM-DD'
  end_of_day_balance INTEGER NOT NULL,
  PRIMARY KEY (account_id, snapshot_date)
);

-- ---------------------------------------------------------------------------
-- InterestRates（利率マスター）
-- ---------------------------------------------------------------------------
CREATE TABLE InterestRates (
  rate_id        TEXT PRIMARY KEY,
  bank_id        TEXT NOT NULL,
  account_type   TEXT NOT NULL,
  annual_rate    REAL NOT NULL,                -- 例: 0.001 = 0.1%
  effective_from TEXT NOT NULL,
  effective_to   TEXT
);

-- ---------------------------------------------------------------------------
-- 初期データ投入
-- 001(みずほ) / 002(三菱UFJ) 参加行
-- 口座命名規則: {bankId}0000000=別段預金, {bankId}-ZCS=清算勘定,
--               {bankId}-CASH=現金, {bankId}-BOJ=日銀預け金
-- /internal/seed を呼ぶと上書きリセットされる
-- ---------------------------------------------------------------------------

-- 口座マスター（システム勘定 + 顧客口座）
INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at) VALUES
  -- 001行 システム勘定
  ('0010000000', '001', 'SYSTEM', '別段預金',               'SUSPENSE',   'NORMAL', '2025-01-01T00:00:00Z'),
  ('001-ZCS',    '001', 'SYSTEM', 'ZC清算勘定',             'SETTLEMENT', 'NORMAL', '2025-01-01T00:00:00Z'),
  ('001-CASH',   '001', 'SYSTEM', '現金',                   'ASSET',      'NORMAL', '2025-01-01T00:00:00Z'),
  ('001-BOJ',    '001', 'BOJ',    '日本銀行（預け金勘定）', 'BOJ',        'NORMAL', '2025-01-01T00:00:00Z'),
  -- 001行 顧客口座
  ('0010000001', '001', 'C001', '田中 太郎', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z'),
  ('0010000002', '001', 'C002', '佐藤 花子', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z'),
  -- 002行 システム勘定
  ('0020000000', '002', 'SYSTEM', '別段預金',               'SUSPENSE',   'NORMAL', '2025-01-01T00:00:00Z'),
  ('002-ZCS',    '002', 'SYSTEM', 'ZC清算勘定',             'SETTLEMENT', 'NORMAL', '2025-01-01T00:00:00Z'),
  ('002-CASH',   '002', 'SYSTEM', '現金',                   'ASSET',      'NORMAL', '2025-01-01T00:00:00Z'),
  ('002-BOJ',    '002', 'BOJ',    '日本銀行（預け金勘定）', 'BOJ',        'NORMAL', '2025-01-01T00:00:00Z'),
  -- 002行 顧客口座
  ('0020000001', '002', 'C003', '鈴木 一郎', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z'),
  ('0020000002', '002', 'C004', '山田 美咲', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z');

-- 初期残高（ゼロサム仕訳: 顧客口座(+) / ZC清算勘定(−)）
-- ZCS(−) = ZCが当行に支払義務あり（当行の初期清算資産 = 日銀当座相当）
-- Suspense は 0 スタート（送金中のみ動く中間勘定）
INSERT OR IGNORE INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at) VALUES
  ('JNL-INIT-001-1',  '001', '0010000001',  1000000, 'CASH', 'INIT-001', '初期残高',              '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-001-1X', '001', '001-ZCS',    -1000000, 'CASH', 'INIT-001', '初期ZC清算残高 offset', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-001-2',  '001', '0010000002',  1000000, 'CASH', 'INIT-001', '初期残高',              '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-001-2X', '001', '001-ZCS',    -1000000, 'CASH', 'INIT-001', '初期ZC清算残高 offset', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-002-1',  '002', '0020000001',  1000000, 'CASH', 'INIT-002', '初期残高',              '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-002-1X', '002', '002-ZCS',    -1000000, 'CASH', 'INIT-002', '初期ZC清算残高 offset', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-002-2',  '002', '0020000002',  1000000, 'CASH', 'INIT-002', '初期残高',              '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-002-2X', '002', '002-ZCS',    -1000000, 'CASH', 'INIT-002', '初期ZC清算残高 offset', '2025-01-01', '2025-01-01T00:00:00Z');

-- 利率マスター
INSERT OR IGNORE INTO InterestRates (rate_id, bank_id, account_type, annual_rate, effective_from) VALUES
  ('RATE-001-SAVINGS', '001', 'SAVINGS', 0.001, '2025-01-01'),
  ('RATE-002-SAVINGS', '002', 'SAVINGS', 0.001, '2025-01-01');
