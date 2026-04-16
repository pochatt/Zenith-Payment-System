# DBスキーマ定義（正）

`migrations/` のSQLと完全に一致させること。矛盾がある場合は本ファイルを正とする。

マイグレーションファイル一覧:
- `0001_zc_schema.sql` — ZC側基本テーブル（14テーブル）
- `0002_bank_schema.sql` — Bank側基本テーブル（6テーブル）
- `0003_trace_filter_htlc_auth.sql` — トレーサビリティ・着金フィルタ・HTLC Auth（6テーブル）
- `0004_new_settlement.sql` — 新決済機能（9テーブル + ALTER TABLE）
- `0005_rtp_request_rows.sql` — RtpRequestRows（0004のALTER失敗対応）

---

## ZC側テーブル（0001_zc_schema.sql）

### Participants（参加主体）
```sql
CREATE TABLE Participants (
  bank_id          TEXT    PRIMARY KEY,             -- '001', '002', ...
  bank_name        TEXT    NOT NULL,
  ingress_base_url TEXT    NOT NULL,                -- '/bank/001'
  h_limit          INTEGER NOT NULL DEFAULT 0,      -- H上限（円）
  h_used           INTEGER NOT NULL DEFAULT 0,      -- H消費中（円）
  is_active        INTEGER NOT NULL DEFAULT 1,
  registered_at    TEXT    NOT NULL,                -- RFC3339
  -- 0004追加
  participation_mode TEXT  NOT NULL DEFAULT 'FULL', -- FULL|LIMITED
  tx_amount_limit  INTEGER,                         -- 1件あたり上限（円）
  daily_amount_limit INTEGER,                       -- 日次上限（円）
  daily_amount_used INTEGER NOT NULL DEFAULT 0      -- 日次累計（EODリセット）
);
```

### Transactions（取引）
```sql
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
  updated_at            TEXT    NOT NULL,
  -- 0004追加
  external_settlement_status TEXT DEFAULT 'NONE',  -- NONE|REQUESTED|SETTLED|FAILED
  verification_id       TEXT,                      -- FK → AccountVerifications
  edi_ref               TEXT,                      -- FK → EdiRecords
  fatf_data_json        TEXT,                      -- FATF R16データ JSON
  is_cross_border       INTEGER NOT NULL DEFAULT 0,
  fatf16_applicable     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tx_state ON Transactions(state);
CREATE INDEX idx_tx_payer ON Transactions(payer_bank_id, state);
CREATE INDEX idx_tx_payee ON Transactions(payee_bank_id, state);
CREATE INDEX idx_tx_dns   ON Transactions(dns_cycle_id);
```

### HReservations（H予約）
```sql
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
```

### FinalityLog（不変ログ・INSERT ONLY）
```sql
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
```

### DnsCycles（DNSサイクル）
```sql
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
```

### DnsNetPositions（DNS清算明細）
```sql
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
```

### HtlcContracts（HTLC取引）
```sql
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
```

### GtidTransactions（GTID取引）
```sql
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
```

### GtidLegs（GTIDの脚）
```sql
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
```

### Cases（例外処理チケット）
```sql
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
```

### Vault（短期秘匿ストア）
```sql
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
```

### PsprRegistry（PSPR登録）
```sql
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
```

### RtpRequests（RTP請求）
```sql
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
  updated_at    TEXT    NOT NULL,
  -- 0006-0008 migrations additions
  rtp_status         TEXT    NOT NULL DEFAULT 'CREATED',
  payee_name         TEXT,
  description        TEXT,
  edi_ref            TEXT,
  notified_at        TEXT,
  linked_txid_new    TEXT,
  payer_account_id   TEXT,
  response_type      TEXT,
  responded_at       TEXT,
  payee_account_hash TEXT
);
```

### IdempotencyKeys（冪等キー管理：ZC側）
```sql
CREATE TABLE IdempotencyKeys (
  key           TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'PROCESSING', -- PROCESSING|DONE
  response_body TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
```

---

## ZC側追加テーブル（0003_trace_filter_htlc_auth.sql）

### TxEventLog（ZC側 詳細処理イベントログ：INSERT ONLY）
FinalityLogが状態遷移イベントを記録するのに対し、TxEventLogはZC↔Bank間の呼び出し結果・フィルタ評価・処理時間を記録する。

```sql
CREATE TABLE TxEventLog (
  log_id        TEXT    PRIMARY KEY,             -- UUID
  txid          TEXT,                            -- 関連取引ID（NULL可）
  correlation_id TEXT,                           -- ZC→Bank 横断追跡ID
  actor         TEXT    NOT NULL,                -- 'ZC'|'BANK_{bankId}'|'CUSTOMER'|'SYSTEM'
  action        TEXT    NOT NULL,                -- アクション名
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
```

**action 定数一覧:**
- ZC側: `PAYMENT_INITIATED`, `PRE_CHECK`, `H_RESERVE`, `H_LOCK`, `H_RELEASE`, `DECIDE_SETTLE`, `DECIDE_CANCEL`, `PAYER_EXEC_CONFIRMED`, `PAYEE_EXEC_CONFIRMED`, `SETTLED`, `SUSPENDED`, `CANCELLED`
- Bank呼出: `RESERVE_FUNDS`, `EXECUTE_DEBIT`, `EXECUTE_CREDIT`, `RELEASE_RESERVE`, `AUTHORITY_CHECK`, `NAME_CHECK`, `LEG_READY_CHECK`
- Filter: `FILTER_EVALUATED`, `FILTER_REJECTED`, `FILTER_PENDING`
- HTLC Auth: `HTLC_AUTH_REQUESTED`, `HTLC_AUTH_APPROVED`, `HTLC_AUTH_DECLINED`, `HTLC_CAPTURE`, `HTLC_VOID`

### HtlcAuthWhitelist（HTLC受取側起点ロック ホワイトリスト）
```sql
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
```

### HtlcAuthRequests（HTLC受取側起点オーソリリクエスト）
カードのオーソリ（authorize → capture/void）に相当。受取側（加盟店）が起点となり、送金側（顧客）の承認を得てHTLCロックを確立する。

```sql
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
  payee_bank_id        TEXT    NOT NULL,
  payee_account_hash   TEXT    NOT NULL,
  payer_bank_id        TEXT    NOT NULL,
  payer_account_hash   TEXT    NOT NULL,
  amount_value         INTEGER NOT NULL,
  purpose              TEXT,
  description          TEXT,                     -- 商品・サービス説明
  auth_expires_at      TEXT    NOT NULL,         -- 送金側が承認する期限
  capture_expires_at   TEXT    NOT NULL,         -- 受取側がキャプチャする期限
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
```

---

## ZC側追加テーブル（0004_new_settlement.sql）

### IgsRequests（IGS連携 — 日銀ネット即時グロス清算）
```sql
CREATE TABLE IgsRequests (
  ext_instruction_id  TEXT PRIMARY KEY,
  txid                TEXT NOT NULL,
  payer_bank_id       TEXT NOT NULL,
  payee_bank_id       TEXT NOT NULL,
  amount_value        INTEGER NOT NULL,
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  status              TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|SETTLED|FAILED|HOLD
  boj_settle_ref      TEXT,
  requested_at        TEXT NOT NULL,
  settled_at          TEXT,
  failed_reason       TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_igs_txid   ON IgsRequests(txid);
CREATE INDEX idx_igs_status ON IgsRequests(status);
```

### AccountVerifications（事前口座確認）
```sql
CREATE TABLE AccountVerifications (
  verification_id     TEXT PRIMARY KEY,
  request_bank_id     TEXT NOT NULL,
  target_bank_id      TEXT NOT NULL,
  target_account_hash TEXT NOT NULL,
  target_account_name TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|VERIFIED|MISMATCH|NOT_FOUND
  name_provided       TEXT,
  match_score         REAL,
  fraud_warning       INTEGER NOT NULL DEFAULT 0,
  cached_until        TEXT,
  idempotency_key     TEXT UNIQUE,
  created_at          TEXT NOT NULL,
  responded_at        TEXT
);
CREATE INDEX idx_av_target ON AccountVerifications(target_bank_id, target_account_hash);
CREATE INDEX idx_av_status ON AccountVerifications(status);
```

### CreditNotifications（入金結果通知）
```sql
CREATE TABLE CreditNotifications (
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
  status              TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|DELIVERED|FAILED
  delivery_attempts   INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 5,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT,
  next_retry_at       TEXT
);
CREATE INDEX idx_cn_payee ON CreditNotifications(payee_bank_id, status);
CREATE INDEX idx_cn_txid  ON CreditNotifications(txid);
```

### EdiRecords（ZEDI統合 — 全銀EDIリッチデータ）
```sql
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
  line_items_json     TEXT,                        -- JSON配列
  created_by_bank_id  TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_edi_txid    ON EdiRecords(txid);
CREATE INDEX idx_edi_invoice ON EdiRecords(invoice_number);
```

### ProxyDirectory（エイリアス送金）
```sql
CREATE TABLE ProxyDirectory (
  proxy_id            TEXT PRIMARY KEY,
  proxy_type          TEXT NOT NULL,               -- PHONE|EMAIL|CORPORATE_ID|TAX_ID
  proxy_value         TEXT NOT NULL,
  bank_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  is_active           INTEGER NOT NULL DEFAULT 1,
  registered_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(proxy_type, proxy_value)
);
CREATE INDEX idx_proxy_lookup ON ProxyDirectory(proxy_type, proxy_value, is_active);
CREATE INDEX idx_proxy_bank   ON ProxyDirectory(bank_id, account_id);
```

### QrCodes（QRコード送金）
```sql
CREATE TABLE QrCodes (
  qr_ref              TEXT PRIMARY KEY,
  qr_type             TEXT NOT NULL,               -- STATIC|DYNAMIC
  payee_bank_id       TEXT NOT NULL,
  payee_account_id    TEXT NOT NULL,
  payee_name          TEXT NOT NULL,
  amount_value        INTEGER,                     -- NULL=任意額（Static QR）
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  purpose             TEXT,
  edi_ref             TEXT,
  signature           TEXT NOT NULL,               -- HMAC署名
  is_used             INTEGER NOT NULL DEFAULT 0,
  expires_at          TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_qr_payee ON QrCodes(payee_bank_id);
```

### RichDataStore（リッチデータストレージ）
```sql
CREATE TABLE RichDataStore (
  data_ref            TEXT PRIMARY KEY,
  data_type           TEXT NOT NULL,               -- INVOICE|RECEIPT|ATTACHMENT|STRUCTURED
  txid                TEXT,
  content_json        TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  r2_key              TEXT,                        -- R2バケットキー（大容量データ用）
  created_by_bank_id  TEXT NOT NULL,
  retention_days      INTEGER NOT NULL DEFAULT 2555, -- 約7年
  created_at          TEXT NOT NULL,
  expires_at          TEXT
);
CREATE INDEX idx_rds_txid ON RichDataStore(txid);
CREATE INDEX idx_rds_type ON RichDataStore(data_type);
```

### CrossBorderTransactions（クロスボーダー送金）
```sql
CREATE TABLE CrossBorderTransactions (
  cb_txid             TEXT PRIMARY KEY,
  domestic_txid       TEXT,                        -- FK → Transactions
  direction           TEXT NOT NULL,               -- OUTBOUND|INBOUND
  foreign_fps_id      TEXT NOT NULL,               -- 外国FPS識別子
  foreign_bank_bic    TEXT NOT NULL,               -- 相手行BIC
  foreign_account_id  TEXT NOT NULL,
  foreign_currency    TEXT NOT NULL,
  foreign_amount      INTEGER NOT NULL,
  exchange_rate       REAL,
  domestic_amount     INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'INITIATED', -- INITIATED|SUBMITTED|SETTLED|FAILED
  settlement_bank_id  TEXT,
  nostro_account_ref  TEXT,
  fatf_data_json      TEXT NOT NULL,               -- FATF R16準拠送金人・受取人データ
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_cb_domestic ON CrossBorderTransactions(domestic_txid);
CREATE INDEX idx_cb_status   ON CrossBorderTransactions(status);
```

### EventStream（双方向通信 — SSEイベントキュー）
```sql
CREATE TABLE EventStream (
  event_id            TEXT PRIMARY KEY,
  target_bank_id      TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  is_delivered        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_es_bank ON EventStream(target_bank_id, is_delivered, created_at);
```

---

## ZC側追加テーブル（0005_rtp_request_rows.sql）

### RtpRequestRows（RTP請求（拡張版））
RtpRequestsとは別に、RTP通知ワークフロー用のテーブル。

```sql
CREATE TABLE RtpRequestRows (
  rtp_id          TEXT PRIMARY KEY,
  payee_bank_id   TEXT NOT NULL,
  payer_bank_id   TEXT NOT NULL,
  amount_value    INTEGER NOT NULL,
  rtp_status      TEXT NOT NULL DEFAULT 'CREATED', -- CREATED|NOTIFIED|RESPONDED|EXPIRED
  payee_name      TEXT,
  payer_account_id TEXT,
  description     TEXT,
  edi_ref         TEXT,
  linked_txid     TEXT,
  linked_txid_new TEXT,
  expires_at      TEXT NOT NULL,
  notified_at     TEXT,
  responded_at    TEXT,
  response_type   TEXT,                            -- ACCEPTED|DECLINED
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_rtp_request_rows_payer_bank ON RtpRequestRows(payer_bank_id, rtp_status, expires_at);
CREATE INDEX idx_rtp_request_rows_payee_bank ON RtpRequestRows(payee_bank_id);
```

---

## Bank側テーブル（0002_bank_schema.sql）

### BankAccounts（口座マスター）
```sql
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
```

### BankJournals（元帳：ゼロサム・INSERT ONLY）
```sql
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
```

### ZcRequests（ZC指示の冪等管理）
```sql
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
```

### SuspenseDetails（別段預金明細）
```sql
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
```

### DailyBalances（日次残高スナップショット）
```sql
CREATE TABLE DailyBalances (
  account_id       TEXT    NOT NULL,
  snapshot_date    TEXT    NOT NULL,             -- 'YYYY-MM-DD'
  end_of_day_balance INTEGER NOT NULL,
  PRIMARY KEY (account_id, snapshot_date)
);
```

### InterestRates（利率マスター）
```sql
CREATE TABLE InterestRates (
  rate_id        TEXT PRIMARY KEY,
  bank_id        TEXT NOT NULL,
  account_type   TEXT NOT NULL,
  annual_rate    REAL NOT NULL,                -- 例: 0.001 = 0.1%
  effective_from TEXT NOT NULL,
  effective_to   TEXT
);
```

---

## Bank側追加テーブル（0003_trace_filter_htlc_auth.sql）

### BankAuditLog（Bank側 コマンド監査ログ：INSERT ONLY）
```sql
CREATE TABLE BankAuditLog (
  log_id       TEXT    PRIMARY KEY,              -- UUID
  bank_id      TEXT    NOT NULL,
  txid         TEXT,
  request_id   TEXT,                             -- ZC request_id
  command      TEXT    NOT NULL,                 -- reserve-funds|execute-debit|...
  status       TEXT    NOT NULL,                 -- 'OK'|'NG'
  reason_code  TEXT,
  amount       INTEGER,
  account_id   TEXT,
  details_json TEXT,
  occurred_at  TEXT    NOT NULL
);
CREATE INDEX idx_audlog_bank ON BankAuditLog(bank_id, occurred_at);
CREATE INDEX idx_audlog_txid ON BankAuditLog(txid);
CREATE INDEX idx_audlog_req  ON BankAuditLog(request_id);
```

### PaymentFilters（着金フィルタリングルール）
```sql
CREATE TABLE PaymentFilters (
  filter_id      TEXT    PRIMARY KEY,
  bank_id        TEXT    NOT NULL,
  scope          TEXT    NOT NULL DEFAULT 'ACCOUNT',  -- 'BANK_WIDE'|'ACCOUNT'
  account_id     TEXT,                           -- scope=ACCOUNT の場合の対象口座
  filter_type    TEXT    NOT NULL,
  -- 'SENDER_BLOCK'      : 特定送金元口座ハッシュをブロック
  -- 'SENDER_BANK_BLOCK' : 特定送金元銀行IDをブロック
  -- 'AMOUNT_LIMIT'      : 金額上限（超過は action 適用）
  -- 'EDI_PATTERN'       : 電文EDIのパターンマッチ
  -- 'REQUIRE_APPROVAL'  : 全着金に顧客承認を要求
  condition_json TEXT    NOT NULL,
  action         TEXT    NOT NULL,               -- 'REJECT'|'HOLD_CONFIRM'|'HOLD_MANUAL'
  description    TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX idx_filter_bank    ON PaymentFilters(bank_id, is_active);
CREATE INDEX idx_filter_account ON PaymentFilters(account_id, is_active);
```

### PaymentApprovalRequests（着金承認待ちリクエスト）
```sql
CREATE TABLE PaymentApprovalRequests (
  approval_id         TEXT    PRIMARY KEY,
  bank_id             TEXT    NOT NULL,
  account_id          TEXT    NOT NULL,
  txid                TEXT    NOT NULL,
  filter_id           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|REJECTED|TIMEOUT
  sender_bank_id      TEXT    NOT NULL,
  sender_account_hash TEXT,
  amount_value        INTEGER NOT NULL,
  edi_data            TEXT,
  expires_at          TEXT    NOT NULL,
  responded_at        TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);
CREATE INDEX idx_approval_account ON PaymentApprovalRequests(account_id, status);
CREATE INDEX idx_approval_txid    ON PaymentApprovalRequests(txid);
```

---

## 初期データ

### ZC側（0001_zc_schema.sql）
```sql
INSERT OR IGNORE INTO Participants (...) VALUES
  ('001', '長岡銀行',    '/bank/001', 100000000, 0, 1, '2025-01-01T00:00:00Z'),
  ('002', '尾張銀行',   '/bank/002', 100000000, 0, 1, '2025-01-01T00:00:00Z');
```

### Bank側（0002_bank_schema.sql）

口座命名規則: `{bankId}0000000`=別段預金, `{bankId}-ZCS`=清算勘定, `{bankId}-CASH`=現金, `{bankId}-BOJ`=日銀預け金

```sql
-- 口座マスター（システム勘定 + 顧客口座）
-- 001行: 別段預金, ZC清算勘定, 現金, 日銀預け金, 顧客2名
-- 002行: 同上
-- 各顧客口座の初期残高: 100万円（ゼロサム仕訳でZC清算勘定と相殺）
-- 利率: 普通預金 0.1%（001・002共通）
```
