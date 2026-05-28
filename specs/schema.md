# DBスキーマ定義（正）

`migrations/` のSQLと完全に一致させること。矛盾がある場合は本ファイルを正とする。

マイグレーションファイル一覧:
- `0001_zc_schema.sql` — ZC側基本テーブル（14テーブル）
- `0002_bank_schema.sql` — Bank側基本テーブル（6テーブル）
- `0003_trace_filter_htlc_auth.sql` — トレーサビリティ・着金フィルタ・HTLC Auth（6テーブル）
- `0004_new_settlement.sql` — 新決済機能（9テーブル + ALTER TABLE）
- `0005_rtp_request_rows.sql` — RtpRequestRows（0004のALTER失敗対応）
- `0006_rtp_columns.sql` 〜 `0009_boj_prefund.sql` — RTP/BOJ カラム追加
- `0010_fix_missing_columns.sql` — Participants の追加カラム no-op パッチ（下記参照）
- `0011_fix_gtid_legs.sql` — GtidLegs(txid) インデックス（フルスキャン解消）
- `0012_fix_dns_cycles.sql` — DnsCycles の補正
- `0013_retained_earnings_account.sql` — Bank 利益剰余金口座
- `0014_circuit_breaker_reversal.sql` — CircuitBreaker / Reversal 機能（2テーブル）
- `0015_finality_hash_chain.sql` — FinalityLog ハッシュチェーン化（`prev_hash` / `entry_hash` 列追加）
- `0016_performance_indexes.sql` — ホットパスのインデックス追加（下記 Index Catalog 参照）
- `0017_circuit_breaker_metrics.sql` — `CircuitBreakerState` に観測メトリクス 6 列追加
- `0018_bug_fixes.sql` — B4 `ReversalRecords.approval_ref` / B5・B6 FinalityLog 部分 UNIQUE 索引 / B8 `Participants.daily_amount_last_reset_date`
- `0019_gtid_chain_fix.sql` — B9 `idx_fl_gtid_chain_prev_hash`（GTID 専用 prev_hash 部分 UNIQUE）
- `0020_hv_threshold.sql` — `Participants.hv_threshold`（HIGH_VALUE 自動エスカレーション閾値）
- `0021_finality_seq_counter.sql` — B10 `FinalitySeq` カウンタ表（event_seq 単調割当）
- `0022_fix_dns_cycles_cleanup.sql` — `0012` の部分適用（`DnsCycles_old` 残置 / `DnsCycles` 欠落）を `IF [NOT] EXISTS` で是正
- `0023_fix_dns_net_positions_fk.sql` — `DnsNetPositions` の FK を `DnsCycles` に貼り直し（`0012` の RENAME 由来の dangling FK 解消）
- `0024_entity_state_log.sql` — `EntityStateLog` 追記専用表（Transactions 以外のエンティティの状態遷移履歴）
- `0025_rtp_consolidate.sql` — `RtpRequests.state` / `rtp_status` の二重持ち統合（rtp_status 語彙を state に昇格）+ 重複テーブル `RtpRequestRows` 廃止

> **`schema/baseline.sql` の位置付け**: `baseline.sql` は全マイグレーション
> 適用後のスキーマ断面を**人間レビュー用**にまとめた参照資料であり、再生成は
> 手動。新マイグレーション追加後に `baseline.sql` が追いついていない場合が
> あるため、**スキーマの正は本ファイル (`schema.md`) と `migrations/` の連番
> SQL**。ローカルで baseline と齟齬が出たら `migrations/` 側を信じること。

---

## マイグレーション運用

### 鉄則
1. **既存マイグレーションは編集しない。** 必ず新しい連番ファイルを切る。
   D1 の `wrangler d1 migrations apply` は適用済みファイルの再適用を行わ
   ないため、適用後に書き換えても本番に反映されない。
2. **`ALTER TABLE ADD COLUMN IF NOT EXISTS` は SQLite で使えない。**
   過去の本番デプロイで失敗した ALTER は、後続マイグレーションで
   `CREATE TABLE IF NOT EXISTS` 全カラム版を切り直す（0005 が前例）。
3. **インデックス追加は常に `IF NOT EXISTS`。** 同名インデックスが既に
   存在する環境への投入を許容する。
4. **マイグレーション追加時は `test/helpers/d1-mock.ts` の
   `SCHEMA_MIGRATIONS` 配列にも追記する。** これを忘れるとテストが
   旧スキーマで走る。

### 既知のパッチマイグレーション
本番デプロイ後に判明した不具合を埋めるためのパッチ。

| ファイル                           | 目的                                                                  |
|------------------------------------|----------------------------------------------------------------------|
| `0010_fix_missing_columns.sql`     | `0004` の ALTER が一部環境で失敗 → no-op として残置（履歴保全）。     |
| `0011_fix_gtid_legs.sql`           | `GtidLegs(txid)` のフルスキャン解消（オーケストレータの hot path）。 |
| `0012_fix_dns_cycles.sql`          | DnsCycles の制約・カラム不整合を補正。                                |
| `0013_retained_earnings_account.sql` | 利益剰余金（RE）口座を口座マスタに追加。                            |
| `0018_bug_fixes.sql` (B4)          | Reversal の承認フロー導入に伴い `ReversalRecords.approval_ref` 列を追加。 |
| `0018_bug_fixes.sql` (B5/B6)       | 並列 ZC ワーカーが FinalityLog のチェーンを分岐させる事象に対する部分 UNIQUE 索引。 |
| `0018_bug_fixes.sql` (B8)          | EOD クロン失敗時にも日次上限がリセットされるよう `Participants.daily_amount_last_reset_date` を追加。 |
| `0019_gtid_chain_fix.sql` (B9)     | GTID 専用 FinalityLog エントリ（txid IS NULL, gtid NOT NULL）でも prev_hash 分岐が起こり得るため部分 UNIQUE。 |
| `0021_finality_seq_counter.sql` (B10) | `event_seq` 単調割当のための単一行カウンタ表。`Date.now()*1000+random` 廃止。 |

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
  participation_mode TEXT  NOT NULL DEFAULT 'FULL', -- FULL|RECEIVE_ONLY|SEND_ONLY
  tx_amount_limit  INTEGER,                         -- 1件あたり上限（円）
  daily_amount_limit INTEGER,                       -- 日次上限（円）
  daily_amount_used INTEGER NOT NULL DEFAULT 0,     -- 日次累計（EODリセット）
  -- 0018 B8追加: 日次上限のリセット日付（クロン未実行時の自動リセット判定用）
  daily_amount_last_reset_date TEXT,                -- 'YYYY-MM-DD'
  -- 0020追加: HIGH_VALUE 自動エスカレーション閾値
  -- NULL = 環境変数 ZC_HV_THRESHOLD（既定 1 億円）にフォールバック
  hv_threshold     INTEGER
);
```

> **`h_used` / `daily_amount_used` の設計意図**: これらは一見すると
> `SUM(HReservations WHERE is_released=0)` や当日 `Transactions` の合計から
> 導出できる冗長カラムに見えるが、**意図的に保持している実体化カウンタ**で
> ある。`UPDATE Participants SET h_used = h_used + ? WHERE (h_used + ?)
> <= h_limit` のような単文 UPDATE は、上限チェックと加算を 1 命令で済ませる
> ことで同時実行下でも race-free に上限を強制できる。SUM して比較してから
> INSERT する形に置き換えると、SUM と INSERT の間に TOCTOU 窓が開いて
> 上限超過の二重予約が発生し得る。本リポジトリは「事実は追記、状態カラムは
> 更新しない」を原則とするが、性能/同時実行のための materialization は
> 例外として明示的に容認する（参照: `src/zc/h_model.ts#reserveH`、
> `src/zc/ingress.ts` の `daily_amount_used` 加算）。整合性は `is_released=0`
> な `HReservations` の合計との reconciliation で随時検証できる。

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

### FinalityLog（不変ログ・INSERT ONLY、改ざん耐性ハッシュチェーン）
```sql
CREATE TABLE FinalityLog (
  log_id       TEXT    PRIMARY KEY,                -- UUID
  txid         TEXT,
  gtid         TEXT,
  event_type   TEXT    NOT NULL,                   -- 付録 A.0 cmd/event 一覧の name
  state_from   TEXT,
  state_to     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,                   -- イベント全体（JSON）
  event_seq    INTEGER NOT NULL,                   -- 0021 以降 FinalitySeq から単調割当
  occurred_at  TEXT    NOT NULL,
  -- 0015 追加: SHA-256 ハッシュチェーン
  prev_hash    TEXT,                               -- 同 chain の直前 entry_hash（先頭は 'GENESIS'）
  entry_hash   TEXT                                -- SHA-256(prev|log_id|txid|gtid|event_type|state_from|state_to|payload_json|event_seq|occurred_at)
);
CREATE INDEX idx_fl_txid ON FinalityLog(txid);
CREATE INDEX idx_fl_gtid ON FinalityLog(gtid);
CREATE INDEX idx_fl_seq  ON FinalityLog(event_seq);
-- 0015 追加
CREATE INDEX idx_fl_chain_seq  ON FinalityLog(txid, event_seq);
CREATE INDEX idx_fl_gchain_seq ON FinalityLog(gtid, event_seq);
-- 0018 B5: TX チェーンの prev_hash 部分 UNIQUE（並列ワーカーによる分岐防止）
CREATE UNIQUE INDEX idx_fl_chain_prev_hash
  ON FinalityLog(txid, prev_hash) WHERE txid IS NOT NULL;
-- 0018 B6: event_seq 全体 UNIQUE（FinalitySeq の belt-and-braces）
CREATE UNIQUE INDEX idx_fl_event_seq_unique ON FinalityLog(event_seq);
-- 0019 B9: GTID 専用チェーンの prev_hash 部分 UNIQUE
CREATE UNIQUE INDEX idx_fl_gtid_chain_prev_hash
  ON FinalityLog(gtid, prev_hash) WHERE gtid IS NOT NULL AND txid IS NULL;
```

#### ハッシュチェーンの規範
- **chain_id**: `COALESCE(txid, gtid, 'GLOBAL')` で識別される。TX と GTID
  は独立したチェーンに記録され、`'GLOBAL'` はシステム全体イベント用。
- **prev_hash の決定**: 同一 chain の直前エントリの `entry_hash`。新規
  チェーン先頭は `'GENESIS'`。
- **entry_hash の決定**: 上記 SQL コメント記載の通り、フィールドを `|`
  連結した文字列を SHA-256。フィールド順は契約。
- **検証**: `verifyChain(db, chain_id)` がチェーン全体を再計算し、
  `LEGACY_UNCHAINED_ENTRY` / `PREV_HASH_MISMATCH` / `ENTRY_HASH_MISMATCH`
  のいずれかを break_reason として返す。`GET /api/transactions/:txid/verify`
  および `GET /api/gtid/:gtid/verify` 経由で公開。
- **書込み原子性**: `transitionWithLog` は CAS UPDATE と FinalityLog
  INSERT を 1 つの `db.batch()` で発行し、`changes() > 0` でガードする。
  CAS に勝った呼び出しのみがログを書く。

### FinalitySeq（FinalityLog 単調 event_seq 採番、0021）
```sql
CREATE TABLE FinalitySeq (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  next_seq  INTEGER NOT NULL
);
-- 初期化（migration 内で実行）
INSERT OR IGNORE INTO FinalitySeq (id, next_seq)
VALUES (1, COALESCE((SELECT MAX(event_seq) FROM FinalityLog), 0));
```
`writeFinalityLog` は `UPDATE FinalitySeq SET next_seq = next_seq + 1
WHERE id = 1 RETURNING next_seq` で event_seq をアトミック割当する。
旧方式（`Date.now()*1000 + random` + UNIQUE リトライ）は廃止。

### EntityStateLog（非Transaction エンティティの状態遷移履歴・INSERT ONLY、0024）
マネーパス（`Transactions` / `HtlcContracts` / `GtidTransactions` / `GtidLegs`）
の状態遷移は `transitionWithLog` が `FinalityLog` に、DNS サイクルは
`'DNS-'` チェーンにそれぞれ追記する。一方で運用系エンティティ
（`Cases.state` / `PsprRegistry.capability_state` / `BankAccounts.status` /
`ReversalRecords.status`）は status 列を上書きするだけで遷移履歴が失われて
いた。`EntityStateLog` は status 列を**現在状態の射影**として残しつつ、変更
ごとに不変の事実（`state_from → state_to`）を 1 行追記する。**UPDATE/DELETE
は一切しない。**

```sql
CREATE TABLE EntityStateLog (
  log_id       TEXT    PRIMARY KEY,           -- 'ESL-<uuid>'
  entity_type  TEXT    NOT NULL,              -- 'CASE'|'PSPR'|'BANK_ACCOUNT'|'REVERSAL'
  entity_id    TEXT    NOT NULL,              -- エンティティ主キー値
  event_type   TEXT    NOT NULL,              -- ドメインイベント名（'CaseOpened' 等）
  state_from   TEXT,                          -- 直前状態（生成時 NULL）
  state_to     TEXT    NOT NULL,              -- 新状態
  reason_code  TEXT,                          -- 変更理由（任意）
  actor        TEXT,                          -- 'ZC'|'OPS'|'BANK_{bankId}'|'SYSTEM'
  payload_json TEXT,                          -- 追加コンテキスト JSON（任意）
  occurred_at  TEXT    NOT NULL               -- RFC3339
);
CREATE INDEX idx_esl_entity   ON EntityStateLog(entity_type, entity_id, occurred_at);
CREATE INDEX idx_esl_occurred ON EntityStateLog(occurred_at);
```

**書込み規範**: `src/shared/entity_state_log.ts#transitionEntityWithLog` が
status 変更 UPDATE と `EntityStateLog` INSERT を 1 つの `db.batch()` で発行する。
INSERT は直前 UPDATE の `changes() > 0` をガードに用いる条件付き形式のため、
no-op（同一状態への再適用など）ではログを書かない。`FinalityLog` の
`buildFinalityLogConditionalInsert` と同型。同一 `occurred_at` のタイ解決は
INSERT 順（rowid 昇順）で行う。

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

> **`legs_ready_count` / `legs_settled_count` の位置付け**: GT の合流判定
> （`checkAndFinalizeGtid`）は実 leg/tx state を JOIN して評価しており、
> これらのカラムを参照していない。ダッシュボード表示用の denormalize 値で
> あり、`GT_DECIDED_TO_SETTLE` / `GT_SETTLED` 遷移時に snapshot 書込みされる
> ため終端状態では正確だが、原理的には drift し得る。単一 GTID 詳細 API
> （`handleGetGtid`）は実 leg 状態から導出した値で上書きして返す。新規の
> GT 合流ロジックは**実 leg state を参照**し、これらのカウンタに依存しない
> こと（参照: `src/zc/orchestrator/gtid.ts#checkAndFinalizeGtid`）。
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

**0025_rtp_consolidate.sql で `state` と `rtp_status` の二重持ちを統合**。
旧 `rtp_status` の細粒度語彙を `state` に昇格し、旧 `state` 列は破棄。
同時に重複していた `RtpRequestRows` も廃止し、payer 側受信一覧は本テーブルを
直接参照する。

```sql
CREATE TABLE RtpRequests (
  rtp_id        TEXT    PRIMARY KEY,
  payee_bank_id TEXT    NOT NULL,
  payer_bank_id TEXT    NOT NULL,
  amount_value  INTEGER NOT NULL,
  -- 唯一の状態列。CREATED|NOTIFIED|ACCEPTED|TX_CREATED|COMPLETED|DECLINED|EXPIRED|FAILED
  state         TEXT    NOT NULL DEFAULT 'CREATED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  linked_txid   TEXT,
  expires_at    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  -- 0006-0008 migrations additions
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
  status              TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|SETTLED|FAILED|HOLD|TIMEOUT
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
  status              TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|MATCHED|UNMATCHED|NOT_FOUND|ERROR|EXPIRED
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
  proxy_type          TEXT NOT NULL,               -- PHONE|EMAIL|NATIONAL_ID
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
  status              TEXT NOT NULL DEFAULT 'INITIATED', -- INITIATED|ROUTED|FOREIGN_ACCEPTED|SETTLED|FAILED|RETURNED
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

## ZC側追加テーブル（0014_circuit_breaker_reversal.sql）

### CircuitBreakerState（参加行疎通監視）
参加行ごとのサーキットブレーカー状態と運用観測メトリクスを保持する。
状態遷移は `CLOSED → OPEN → HALF_OPEN → CLOSED` の標準パターン。

```sql
CREATE TABLE CircuitBreakerState (
  bank_id               TEXT PRIMARY KEY,
  state                 TEXT NOT NULL DEFAULT 'CLOSED',  -- CLOSED|OPEN|HALF_OPEN
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_failure_at       TEXT,
  opened_at             TEXT,
  half_open_at          TEXT,
  updated_at            TEXT NOT NULL,
  -- 0017 追加: 観測メトリクス
  total_requests        INTEGER NOT NULL DEFAULT 0,      -- 累計呼び出し数
  total_successes       INTEGER NOT NULL DEFAULT 0,      -- 累計成功
  total_failures        INTEGER NOT NULL DEFAULT 0,      -- 累計失敗
  total_denied          INTEGER NOT NULL DEFAULT 0,      -- OPEN 状態で拒否した数
  half_open_inflight    INTEGER NOT NULL DEFAULT 0,      -- HALF_OPEN 中の進行中呼び出し
  last_success_at       TEXT                             -- 直近成功時刻
);
```

`GET /api/circuit-breaker[/:bank_id]` で全行 / 特定行のメトリクスを照会、
`POST /api/circuit-breaker/:bank_id/reset` で運用上の強制 CLOSED が可能。
詳細は `api-contracts.md § Circuit Breaker`。

### ReversalRecords（救済取引）
SETTLED 後に発生した苦情・誤送金等を救済するための補償取引メタデータ。
`reversal_txid` は実際の補償送金 TX を指す（lane=STANDARD, purpose='REFUND'
で生成）。

```sql
CREATE TABLE ReversalRecords (
  reversal_id    TEXT PRIMARY KEY,
  original_txid  TEXT NOT NULL,                     -- 元の SETTLED な txid
  reversal_txid  TEXT,                              -- 補償送金の txid（生成後に埋まる）
  amount         INTEGER NOT NULL,
  reason         TEXT NOT NULL,                     -- CUSTOMER_DISPUTE|DUPLICATE_PAYMENT|FRAUD|... 
  status         TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|APPROVED|TX_CREATED|COMPLETED|REJECTED
  requested_by   TEXT NOT NULL,                     -- bank_id | 'OPS'
  description    TEXT,
  -- 0018 B4 追加: 一部の reason は事前承認 ref が必須
  approval_ref   TEXT,                              -- 内部統制系チケット参照
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_rev_original    ON ReversalRecords(original_txid);
CREATE INDEX idx_rev_reversal_tx ON ReversalRecords(reversal_txid);
```

**`reversal_txid` 経由のカスケード**: `onPayeeExecConfirmed`（補償送金が
SETTLED に到達）は `ReversalRecords WHERE reversal_txid = ?` を引いて該当
すれば `completeReversal` を呼ぶ。旧実装は `txid.startsWith('TX-REV-')` で
判定していたが、prefix 規約の変更に脆弱なので廃止。

---

## ~~ZC側追加テーブル（0005_rtp_request_rows.sql）~~ — 廃止

### ~~RtpRequestRows~~ — 0025_rtp_consolidate.sql で廃止

旧設計では payer 側通知ストレージとして `RtpRequestRows` を別途用意していたが、
`RtpRequests` と完全に重複していたため統合。`/api/rtp/incoming` および
`bankRtpNotify`（rtp-notify Ingress）は `RtpRequests` を直接参照する。
状態は `state` 列に一本化（旧 `rtp_status` 語彙を昇格）。

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

---

## Index Catalog

D1 はクエリプランナの統計情報が貧弱で、行数が増えるとインデックス無し
クエリの p99 が急速に悪化する。下表は**現在実装されている**クエリが
利用するインデックスを網羅したもの。新規クエリ追加時は本表をまず確認し、
既存インデックスで賄えない場合は `IF NOT EXISTS` 付きで連番マイグレー
ションを切ること。

### Transactions
| Index               | Columns                       | Backed query                                           | Migration |
|---------------------|-------------------------------|--------------------------------------------------------|-----------|
| idx_tx_state        | (state)                       | 状態別一覧                                             | 0001      |
| idx_tx_payer        | (payer_bank_id, state)        | 銀行毎の出金照会                                       | 0001      |
| idx_tx_payee        | (payee_bank_id, state)        | 銀行毎の入金照会                                       | 0001      |
| idx_tx_dns          | (dns_cycle_id)                | DNS 清算明細生成                                       | 0001      |
| **idx_tx_updated_at** | (updated_at)                | timeout sweep の古い行スキャン                         | **0016**  |
| **idx_tx_lane_state** | (lane, state)               | レーン × 状態のダッシュボードフィルタ                  | **0016**  |

### FinalityLog
| Index                          | Columns                       | Backed query                                                   | Migration |
|--------------------------------|-------------------------------|----------------------------------------------------------------|-----------|
| idx_fl_txid                    | (txid)                        | TX 単体トレース                                                | 0001      |
| idx_fl_gtid                    | (gtid)                        | GTID 単体トレース                                              | 0001      |
| idx_fl_seq                     | (event_seq)                   | 全体時系列                                                     | 0001      |
| idx_fl_chain_seq               | (txid, event_seq)             | ハッシュチェーン検証（TX）                                     | 0015      |
| idx_fl_gchain_seq              | (gtid, event_seq)             | ハッシュチェーン検証（GTID）                                   | 0015      |
| **idx_fl_occurred_at**         | (occurred_at)                 | 時間範囲監査（`GET /api/events?limit=&offset=`）               | **0016**  |
| **idx_fl_chain_prev_hash**     | (txid, prev_hash) WHERE …     | TX チェーン分岐防止（部分 UNIQUE）                             | **0018 B5** |
| **idx_fl_event_seq_unique**    | (event_seq)                   | event_seq 重複防止（UNIQUE）                                   | **0018 B6** |
| **idx_fl_gtid_chain_prev_hash**| (gtid, prev_hash) WHERE …     | GTID 専用チェーン分岐防止（部分 UNIQUE）                       | **0019 B9** |

### HtlcContracts
| Index                  | Columns                       | Backed query                                       | Migration |
|------------------------|-------------------------------|----------------------------------------------------|-----------|
| **idx_htlc_payee_state** | (payee_bank_id, state)      | timeout sweep / payee 側 HTLC 一覧                 | **0016**  |
| **idx_htlc_payer_state** | (payer_bank_id, state)      | payer 側 HTLC 一覧                                 | **0016**  |
| **idx_htlc_timelock**    | (timelock, state)           | timelock 期限切れ抽出                              | **0016**  |

### RtpRequests
| Index                 | Columns                       | Backed query                                       | Migration |
|-----------------------|-------------------------------|----------------------------------------------------|-----------|
| **idx_rtp_payer_state** | (payer_bank_id, state)      | 銀行毎の RTP 一覧                                  | **0016**  |
| **idx_rtp_payee_state** | (payee_bank_id, state)      | 銀行毎の RTP 一覧                                  | **0016**  |
| **idx_rtp_expires**     | (expires_at, state)         | 期限切れ RTP 巡回                                  | **0016**  |

### Cases / IdempotencyKeys / DnsCycles
| Index            | Columns                  | Backed query                                          | Migration |
|------------------|--------------------------|-------------------------------------------------------|-----------|
| idx_case_txid    | (related_txid)           | TX に紐づくケース照会                                 | 0001      |
| **idx_case_state** | (state, created_at)    | OPEN/IN_PROGRESS のケース一覧                         | **0016**  |
| **idx_case_gtid**  | (related_gtid)         | GTID に紐づくケース照会                               | **0016**  |
| **idx_idemp_created** | (created_at)        | 24h 経過冪等キーの TTL sweep                          | **0016**  |
| **idx_dns_state**     | (state, created_at) | DNS サイクル状態別一覧                                | **0016**  |

その他の表（ZC: GtidLegs, Vault, …、Bank: BankAccounts, BankJournals, …）
は 0001〜0014 で定義された既存インデックスで賄える。

---

## Foreign Key 戦略

D1 (SQLite) では `PRAGMA foreign_keys = ON` が必要だが、既存の
マイグレーションは大半 FK を貼っていない（明示 FK は 2 個のみ）。
これは**本リポジトリが mock であり、参照整合性は ZC 側の状態機械と
FinalityLog で担保する**という設計判断による。

将来本番化する際の方針:
1. 子テーブル（HReservations, RtpRequests, GtidLegs, HtlcAuthRequests,
   EdiRecords, RichDataStore, CrossBorderTransactions, Cases）は親
   `Transactions(txid)` に対して `FOREIGN KEY ... REFERENCES Transactions(txid)
   ON DELETE RESTRICT` を貼る。
2. 監査用テーブル（FinalityLog, TxEventLog, BankAuditLog）は意図的に
   FK を貼らない（INSERT-ONLY で削除されないため不要、かつ親が消えても
   履歴は残したい）。
3. FK 追加は破壊的変更になり得るため、orphan 行のクリーンアップ →
   `CREATE TABLE ... FOREIGN KEY` で再構築 → `INSERT INTO ... SELECT` で
   データ移行、の専用マイグレーションを別途用意する。
