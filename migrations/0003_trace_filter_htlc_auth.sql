-- =============================================================================
-- 0003_trace_filter_htlc_auth.sql
-- トレーサビリティ / 着金フィルタリング / 受取側起点HTLC (オーソリ型)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TxEventLog（ZC側 詳細処理イベントログ: INSERT ONLY）
-- FinalityLog が状態遷移イベントを記録するのに対し、TxEventLog は
-- ZC↔Bank 間の呼び出し結果・フィルタ評価・処理時間を記録する。
-- ---------------------------------------------------------------------------
CREATE TABLE TxEventLog (
  log_id        TEXT    PRIMARY KEY,             -- UUID
  txid          TEXT,                            -- 関連取引ID（NULL可）
  correlation_id TEXT,                           -- ZC→Bank 横断追跡ID
  actor         TEXT    NOT NULL,                -- 'ZC'|'BANK_{bankId}'|'CUSTOMER'|'SYSTEM'
  action        TEXT    NOT NULL,                -- アクション名（下記定数参照）
  status        TEXT    NOT NULL,                -- 'OK'|'NG'|'PENDING'
  reason_code   TEXT,                            -- NGの場合の理由コード
  amount        INTEGER,                         -- 関連金額（円）
  bank_id       TEXT,                            -- 関連銀行ID
  account_id    TEXT,                            -- 関連口座（マスク済み可）
  details_json  TEXT,                            -- 追加コンテキスト JSON
  duration_ms   INTEGER,                         -- 処理時間（ミリ秒）
  occurred_at   TEXT    NOT NULL                 -- RFC3339
);

CREATE INDEX idx_evtlog_txid     ON TxEventLog(txid);
CREATE INDEX idx_evtlog_occurred ON TxEventLog(occurred_at);
CREATE INDEX idx_evtlog_actor    ON TxEventLog(actor, action, occurred_at);
CREATE INDEX idx_evtlog_status   ON TxEventLog(status, occurred_at);

-- TxEventLog.action 定数:
--  ZC側:  PAYMENT_INITIATED, PRE_CHECK, H_RESERVE, H_LOCK, H_RELEASE
--          DECIDE_SETTLE, DECIDE_CANCEL, PAYER_EXEC_CONFIRMED,
--          PAYEE_EXEC_CONFIRMED, SETTLED, SUSPENDED, CANCELLED
--  Bank呼出: RESERVE_FUNDS, EXECUTE_DEBIT, EXECUTE_CREDIT, RELEASE_RESERVE,
--             AUTHORITY_CHECK, NAME_CHECK, LEG_READY_CHECK
--  Filter:  FILTER_EVALUATED, FILTER_REJECTED, FILTER_PENDING
--  HTLC Auth: HTLC_AUTH_REQUESTED, HTLC_AUTH_APPROVED, HTLC_AUTH_DECLINED,
--              HTLC_CAPTURE, HTLC_VOID

-- ---------------------------------------------------------------------------
-- BankAuditLog（Bank側 コマンド監査ログ: INSERT ONLY）
-- ZcRequests は冪等管理のためのキャッシュ。BankAuditLog は監査目的で
-- 実行されたコマンドの詳細（入力・結果・影響口座）を永続記録する。
-- ---------------------------------------------------------------------------
CREATE TABLE BankAuditLog (
  log_id       TEXT    PRIMARY KEY,              -- UUID
  bank_id      TEXT    NOT NULL,
  txid         TEXT,                             -- ZC取引ID
  request_id   TEXT,                             -- ZC request_id（冪等キー）
  command      TEXT    NOT NULL,                 -- reserve-funds|execute-debit|...
  status       TEXT    NOT NULL,                 -- 'OK'|'NG'
  reason_code  TEXT,                             -- NGの場合の理由コード
  amount       INTEGER,                          -- 操作金額（円）
  account_id   TEXT,                             -- 対象口座ID
  details_json TEXT,                             -- 追加情報 JSON
  occurred_at  TEXT    NOT NULL                  -- RFC3339
);

CREATE INDEX idx_audlog_bank    ON BankAuditLog(bank_id, occurred_at);
CREATE INDEX idx_audlog_txid    ON BankAuditLog(txid);
CREATE INDEX idx_audlog_req     ON BankAuditLog(request_id);

-- ---------------------------------------------------------------------------
-- PaymentFilters（着金フィルタリングルール）
-- 銀行全体または口座単位で着金条件を設定する。
-- 将来的な顧客承認フロー（スマートフォン通知等）を見据えた設計。
-- ---------------------------------------------------------------------------
CREATE TABLE PaymentFilters (
  filter_id      TEXT    PRIMARY KEY,            -- UUID
  bank_id        TEXT    NOT NULL,
  scope          TEXT    NOT NULL DEFAULT 'ACCOUNT',  -- 'BANK_WIDE'|'ACCOUNT'
  account_id     TEXT,                           -- scope=ACCOUNT の場合の対象口座
  filter_type    TEXT    NOT NULL,
  -- 'SENDER_BLOCK'      : 特定送金元口座ハッシュをブロック
  -- 'SENDER_BANK_BLOCK' : 特定送金元銀行IDをブロック
  -- 'AMOUNT_LIMIT'      : 金額上限（超過は action 適用）
  -- 'EDI_PATTERN'       : 電文EDIのパターンマッチ（正規表現）
  -- 'REQUIRE_APPROVAL'  : 全着金に顧客承認を要求
  condition_json TEXT    NOT NULL,               -- フィルタ条件 JSON
  -- SENDER_BLOCK:      {"sender_account_hash": "abc123"}
  -- SENDER_BANK_BLOCK: {"sender_bank_id": "001"}
  -- AMOUNT_LIMIT:      {"max_amount": 50000}
  -- EDI_PATTERN:       {"pattern": "\\bDENY\\b"}
  -- REQUIRE_APPROVAL:  {}
  action         TEXT    NOT NULL,               -- 'REJECT'|'HOLD_CONFIRM'|'HOLD_MANUAL'
  -- REJECT:       即時拒否（sender に返金）
  -- HOLD_CONFIRM: 顧客承認待ち（将来: プッシュ通知）
  -- HOLD_MANUAL:  行員手動対応待ち
  description    TEXT,                           -- 人間可読の説明
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT    NOT NULL,               -- customer_id or 'BANK'
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX idx_filter_bank    ON PaymentFilters(bank_id, is_active);
CREATE INDEX idx_filter_account ON PaymentFilters(account_id, is_active);

-- ---------------------------------------------------------------------------
-- PaymentApprovalRequests（着金承認待ちリクエスト）
-- HOLD_CONFIRM フィルタが発動したときに生成される。
-- 将来的に顧客スマートフォンへのプッシュ通知に使用する。
-- ---------------------------------------------------------------------------
CREATE TABLE PaymentApprovalRequests (
  approval_id         TEXT    PRIMARY KEY,       -- UUID
  bank_id             TEXT    NOT NULL,
  account_id          TEXT    NOT NULL,          -- 承認が必要な受取口座
  txid                TEXT    NOT NULL,          -- 対象取引
  filter_id           TEXT    NOT NULL,          -- 発動したフィルタ
  status              TEXT    NOT NULL DEFAULT 'PENDING',
  -- 'PENDING'  : 顧客回答待ち
  -- 'APPROVED' : 顧客が承認
  -- 'REJECTED' : 顧客が拒否
  -- 'TIMEOUT'  : 期限切れ（自動拒否）
  sender_bank_id      TEXT    NOT NULL,          -- 送金元銀行ID
  sender_account_hash TEXT,                      -- 送金元口座ハッシュ
  amount_value        INTEGER NOT NULL,
  edi_data            TEXT,                      -- 送金電文のEDIデータ（表示用）
  expires_at          TEXT    NOT NULL,          -- 承認期限（超過でTIMEOUT）
  responded_at        TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE INDEX idx_approval_account ON PaymentApprovalRequests(account_id, status);
CREATE INDEX idx_approval_txid    ON PaymentApprovalRequests(txid);

-- ---------------------------------------------------------------------------
-- HtlcAuthWhitelist（HTLC受取側起点ロック ホワイトリスト）
-- 着金側（加盟店）が送金側にHTLCロックをリクエストできる業者を登録する。
-- クレジットカードの加盟店登録に相当。慎重な運用が必要なため、
-- 管理者（ZC運営）のみが登録・削除できる。
-- ---------------------------------------------------------------------------
CREATE TABLE HtlcAuthWhitelist (
  whitelist_id          TEXT    PRIMARY KEY,     -- UUID
  payee_bank_id         TEXT    NOT NULL,        -- 加盟店の銀行ID
  payee_account_hash    TEXT    NOT NULL,        -- 加盟店の口座ハッシュ
  allowed_payer_bank_id TEXT,                    -- NULL=全銀行からのオーソリOK
  max_amount            INTEGER,                 -- NULL=金額制限なし（円）
  allowed_purposes      TEXT,                    -- JSON配列 ['MERCHANT'] NULL=全目的OK
  description           TEXT,                    -- 加盟店名・端末説明
  is_active             INTEGER NOT NULL DEFAULT 1,
  registered_at         TEXT    NOT NULL,
  expires_at            TEXT                     -- NULL=無期限
);

CREATE INDEX idx_whitelist_payee ON HtlcAuthWhitelist(payee_bank_id, payee_account_hash, is_active);

-- ---------------------------------------------------------------------------
-- HtlcAuthRequests（HTLC受取側起点オーソリリクエスト）
-- カードのオーソリ（authorize → capture/void）に相当する。
-- 受取側（加盟店）が起点となり、送金側（顧客）の承認を得てHTLCロックを確立する。
-- ---------------------------------------------------------------------------
CREATE TABLE HtlcAuthRequests (
  auth_id              TEXT    PRIMARY KEY,      -- UUID
  htlc_id              TEXT,                     -- 承認後に生成されるHTLC ID
  txid                 TEXT,                     -- 承認後に生成されるtxid
  status               TEXT    NOT NULL DEFAULT 'AUTH_REQUESTED',
  -- 'AUTH_REQUESTED' : オーソリリクエスト送信済み、送金側未承認
  -- 'AUTH_APPROVED'  : 送金側承認済み、HTLCロック確立
  -- 'AUTH_DECLINED'  : 送金側拒否
  -- 'CAPTURED'       : 受取側がキャプチャ（決済完了）
  -- 'VOIDED'         : 受取側がボイド（取消）
  -- 'EXPIRED'        : 有効期限切れ
  payee_bank_id        TEXT    NOT NULL,         -- 加盟店の銀行ID
  payee_account_hash   TEXT    NOT NULL,         -- 加盟店の口座ハッシュ
  payer_bank_id        TEXT    NOT NULL,         -- 顧客の銀行ID
  payer_account_hash   TEXT    NOT NULL,         -- 顧客の口座ハッシュ
  amount_value         INTEGER NOT NULL,
  purpose              TEXT,                     -- 取引目的
  description          TEXT,                     -- 商品・サービス説明（EDI相当）
  auth_expires_at      TEXT    NOT NULL,         -- 送金側が承認する期限
  capture_expires_at   TEXT    NOT NULL,         -- 受取側がキャプチャする期限（HTLCのtimelock）
  vault_ref            TEXT,                     -- Vault に保管した preimage への参照
  hashlock             TEXT,                     -- SHA256(preimage)（承認後に設定）
  whitelist_id         TEXT    NOT NULL,         -- FK → HtlcAuthWhitelist
  approved_at          TEXT,
  captured_at          TEXT,
  voided_at            TEXT,
  decline_reason       TEXT,
  idempotency_key      TEXT    NOT NULL UNIQUE,
  version              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

CREATE INDEX idx_authreq_payer  ON HtlcAuthRequests(payer_bank_id, status);
CREATE INDEX idx_authreq_payee  ON HtlcAuthRequests(payee_bank_id, payee_account_hash, status);
CREATE INDEX idx_authreq_htlc   ON HtlcAuthRequests(htlc_id);
