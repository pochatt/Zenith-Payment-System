# API契約定義（全エンドポイント）

付録A・付録E・補遺Cを統合したエンドポイント一覧。
**実装の正は仕様書（zc-spec.md / bank-spec.md）。本ファイルはその写し。**

---

## ZC Core API

### 参加行→ZC 受付

#### POST /api/transfers
PaymentInitiated（付録E.1準拠）

Request:
```json
{
  "schema_version": "1.0",
  "message_type": "EVENT",
  "name": "PaymentInitiated",
  "message_id": "uuid",
  "idempotency_key": "string",
  "occurred_at": "RFC3339",
  "txid": "TX-...",
  "lane": "EXPRESS|STANDARD|BULK|DEFERRED|RTP|HTLC|HIGH_VALUE",
  "amount": { "value": 1200, "currency": "JPY" },
  "payer": { "bank_id": "001", "account_hash": "h:...", "vault_ref": "optional" },
  "payee": { "bank_id": "002", "account_hash": "h:optional", "vault_ref": "optional" },
  "purpose": "MERCHANT|P2P|BILL|SALARY|REFUND",
  "pspr_ref": "optional",
  "expires_at": "RFC3339",
  "is_cross_border": 0,
  "fatf_data": { "...FATF R16フィールド..." },
  "proxy_type": "optional",
  "proxy_value": "optional",
  "qr_ref": "optional"
}
```

Response (Express): `{ "result": "DECISION_ACCEPTED", "txid": "...", "state": "H_RESERVED" }`
Response (Standard/Bulk/HTLC/GTID): `{ "result": "INGRESS_ACCEPTED", "txid": "...", "state": "RECEIVED" }`

バリデーション:
- `tx_amount_limit` チェック（Participantsテーブル）
- `daily_amount_limit` チェック（アトミック UPDATE + meta.changes=0 パターン）
- クロスボーダー送金時は FATF R16 バリデーション（全レーン対象）

#### POST /api/htlc/create
HTLC新規作成

Request:
```json
{
  "htlc_id": "HTLC-...",
  "hashlock": "sha256hex",
  "timelock": "RFC3339",
  "amount": { "value": 5000, "currency": "JPY" },
  "payer_bank_id": "001",
  "payer_account_hash": "...",
  "payee_bank_id": "002",
  "payee_account_hash": "...",
  "idempotency_key": "string"
}
```

#### POST /api/htlc/:htlc_id/claim
preimage提示（付録E.5）

Request: `{ "htlc_id": "...", "preimage": "secret_hex", "idempotency_key": "string" }`

#### POST /api/htlc/:htlc_id/capture
受取側キャプチャ（オーソリ型HTLC専用）

Request: `{ "idempotency_key": "string" }`

#### POST /api/htlc/:htlc_id/void
受取側ボイド（オーソリ型HTLC取消）

Request: `{ "idempotency_key": "string" }`

#### POST /api/htlc/auth-request
受取側起点オーソリリクエスト

Request:
```json
{
  "payee_bank_id": "001",
  "payee_account_hash": "...",
  "payer_bank_id": "002",
  "payer_account_hash": "...",
  "amount": { "value": 3000, "currency": "JPY" },
  "purpose": "MERCHANT",
  "description": "商品名等",
  "auth_timeout_seconds": 300,
  "capture_timeout_seconds": 3600,
  "idempotency_key": "string"
}
```

#### POST /api/htlc/auth/:auth_id/approve
送金側承認

Request: `{ "idempotency_key": "string" }`

#### POST /api/htlc/auth/:auth_id/decline
送金側拒否

Request: `{ "reason": "optional reason", "idempotency_key": "string" }`

#### GET /api/htlc/auth-requests
オーソリリクエスト一覧

Query: `?payer_bank_id=001&status=AUTH_REQUESTED`

#### GET /api/htlc/auth/:auth_id
オーソリリクエスト詳細

#### POST /api/htlc/auth-whitelist
ホワイトリスト登録

Request:
```json
{
  "payee_bank_id": "001",
  "payee_account_hash": "...",
  "allowed_payer_bank_id": "optional",
  "max_amount": 100000,
  "allowed_purposes": ["MERCHANT"],
  "description": "加盟店名",
  "expires_at": "optional RFC3339"
}
```

#### GET /api/htlc/auth-whitelist
ホワイトリスト一覧

#### DELETE /api/htlc/auth-whitelist/:whitelist_id
ホワイトリスト削除

#### POST /api/gtid/register
GTID leg登録（GtLegRegistered）

Request:
```json
{
  "gtid": "GT-...",
  "legs": [
    { "leg_id": "L1", "role": "PAYER", "bank_id": "001", "account_hash": "h:...", "amount": { "value": 3000, "currency": "JPY" } },
    { "leg_id": "L2", "role": "PAYEE", "bank_id": "002", "account_hash": "h:...", "amount": { "value": 3000, "currency": "JPY" } }
  ],
  "expires_at": "RFC3339",
  "idempotency_key": "string"
}
```

#### POST /api/rtp/request
RTP請求登録

Request:
```json
{
  "rtp_id": "RTP-...",
  "payee_bank_id": "001",
  "payer_bank_id": "002",
  "amount": { "value": 2000, "currency": "JPY" },
  "expires_at": "RFC3339",
  "idempotency_key": "string",
  "payee_name": "optional",
  "description": "optional",
  "payee_account": "optional"
}
```

#### POST /api/rtp/:rtpId/respond
RTP請求への応答

Request: `{ "action": "ACCEPT|DECLINE", "payer_account_id": "...", "idempotency_key": "string" }`

#### GET /api/rtp/incoming
受信RTP請求一覧（payer側）

Query: `?account=XXXXXXXXXX`（口座番号先頭3桁で銀行ID自動判定）

#### POST /api/transfers/:txid/authorize
TransferAuthorize（Standard/HV: 支払人最終認可）

Request: `{ "txid": "...", "authorized": true, "idempotency_key": "string" }`

#### POST /api/transfers/:txid/cancel
取消（Decision前のみ）

Request: `{ "txid": "...", "reason_code": "CANCEL_BY_PAYER", "idempotency_key": "string" }`

#### POST /api/transfers/:txid/no-debit-proof
H_locked の自動解放（未実行証明・zenith_public.md §8.4.1）。PayerBank が「デビット未記録」を署名付きで提出し、ZC が `X-ZC-Signature` を検証のうえ H_locked を解放する。

Request: `{ "proof_ref": "PROOF-...", "bank_id": "001" }`（Header: `X-ZC-Signature`）

Response: `{ "ok": true, "result": "H_RELEASED", "txid": "...", "reservation_id": "H-...", "amount": 5000, "event": "NoDebitRecordedProofSubmitted" }`

ガード: a（PAYER_EXEC_CONFIRMED）/ b（PAYEE_EXEC_CONFIRMED）成立済みは解放不可（`422 A_OR_B_CONFIRMED` → 補償＝Reversal 経路）。現在状態と FinalityLog 履歴の双方で判定。

#### POST /api/transfers/:txid/h-unlock-authorize
H_locked の運用解放（二重統制＝4 眼・zenith_public.md §8.4.1）。未実行証明が得られない場合に、2 名の異なる承認者と証跡参照を要件として解放する。

Request: `{ "approver_1": "ops.alice", "approver_2": "ops.bob", "evidence_type": "LEDGER_HASH|QUERY_SIGNATURE|AUTHORITY_CHECK", "evidence_ref": "...", "case_id": "CASE-..." }`

Response: `{ "ok": true, "result": "H_RELEASED", "event": "HUnlockAuthorized", ... }`

ガード: `approver_1 != approver_2`（`422 FOUR_EYES_REQUIRED`）、`evidence_ref` 必須（`422 EVIDENCE_REQUIRED`）、a/b 成立済みは解放不可（`422 A_OR_B_CONFIRMED`）。

---

### 口座確認・EDI・Proxy・QR・RichData

#### POST /api/account-verify
口座確認リクエスト（単件）

Request:
```json
{
  "target_bank_id": "002",
  "target_account_hash": "...",
  "name_to_verify": "佐藤 花子",
  "request_bank_id": "001"
}
```

#### POST /api/account-verify/batch
口座確認リクエスト（一括）

Request:
```json
{
  "request_bank_id": "001",
  "items": [
    { "target_bank_id": "002", "target_account_hash": "...", "name_to_verify": "..." }
  ]
}
```

#### GET /api/account-verify/:verificationId
口座確認結果照会

#### POST /api/edi/register
EDIレコード登録

Request:
```json
{
  "txid": "TX-...",
  "invoice_number": "INV-2026-001",
  "invoice_date": "2026-03-01",
  "payment_due_date": "2026-03-31",
  "tax_amount": 500,
  "tax_rate": 0.1,
  "discount_amount": 0,
  "note": "optional",
  "sender_ref": "optional",
  "receiver_ref": "optional",
  "line_items": [{"item": "商品A", "quantity": 1, "unit_price": 5000}]
}
```

#### GET /api/edi/tx/:txid
取引IDでEDI照会

#### GET /api/edi/:ediRef
EDI参照IDで照会

#### POST /api/proxy/register
プロキシ（エイリアス）登録

Request:
```json
{
  "proxy_type": "PHONE|EMAIL|NATIONAL_ID",
  "proxy_value": "090-xxxx-xxxx",
  "bank_id": "001",
  "account_id": "0010000001",
  "account_holder_name": "田中 太郎"
}
```

#### GET /api/proxy/resolve
プロキシ解決

Query: `?type=PHONE&value=090-xxxx-xxxx`

#### DELETE /api/proxy/:proxyId
プロキシ無効化

#### POST /api/qr/generate
QRコード生成

Request:
```json
{
  "qr_type": "STATIC|DYNAMIC",
  "payee_bank_id": "001",
  "payee_account_id": "0010000001",
  "payee_name": "田中商店",
  "amount": { "value": 1000, "currency": "JPY" },
  "purpose": "MERCHANT",
  "expires_at": "optional RFC3339"
}
```

#### POST /api/qr/pay
QRコード決済実行

Request:
```json
{
  "qr_ref": "QR-...",
  "payer_bank_id": "002",
  "payer_account_id": "0020000001",
  "amount": 1000,
  "idempotency_key": "string"
}
```
→ 内部的に POST /api/transfers を呼び出してEXPRESS送金を起動

#### GET /api/qr/:qrRef
QRコード照会

#### POST /api/richdata/store
リッチデータ格納

Request:
```json
{
  "data_type": "INVOICE|RECEIPT|ATTACHMENT|STRUCTURED",
  "txid": "TX-...",
  "content": { "...任意のJSON..." },
  "retention_days": 2555
}
```

#### GET /api/richdata/tx/:txid
取引IDでリッチデータ照会

#### GET /api/richdata/:dataRef
参照IDでリッチデータ照会

---

### クロスボーダー送金

#### POST /api/cross-border/send
クロスボーダー送金開始

Request:
```json
{
  "direction": "OUTBOUND",
  "foreign_fps_id": "SGPAYNOW",
  "foreign_bank_bic": "DBSSSGSG",
  "foreign_account_id": "1234567890",
  "foreign_currency": "SGD",
  "foreign_amount": 100,
  "domestic_amount": 10000,
  "exchange_rate": 100.0,
  "settlement_bank_id": "001",
  "fatf_data": { "originator_name": "...", "beneficiary_name": "...", "..." },
  "domestic_txid": "TX-..."
}
```

#### GET /api/cross-border/:cbTxid
クロスボーダー送金照会

#### POST /api/cross-border/:cbTxid/callback
外国FPSからのステータス更新

Request: `{ "status": "SETTLED|FAILED", "foreign_ref": "..." }`

---

### 照会

#### GET /api/transactions/:txid
QueryResponse（付録E.6準拠）

Response:
```json
{
  "txid": "TX-...",
  "state": "TxState",
  "reason_code": "optional",
  "decision": { "status": "NONE|DECIDED_TO_SETTLE|DECIDED_CANCEL", "decision_proof_ref": "optional" },
  "execution": { "a": "NONE|OK|NG", "b": "NONE|OK|NG", "payer_bank_proof_ref": "optional", "payee_bank_proof_ref": "optional" },
  "case": { "case_id": "optional", "status": "optional" },
  "as_of": "RFC3339",
  "freshness_level": "GREEN",
  "next_action_hint": "WAIT|RETRY_LATER|CONTACT_PAYER_BANK|OPEN_CASE"
}
```

#### GET /api/transactions
取引一覧

Query: `?state=...&payer_bank_id=...&payee_bank_id=...&lane=...&limit=50&offset=0`

#### GET /api/transactions/:txid/events
取引イベントログ照会

#### GET /api/transactions/:txid/explain
人間可読な状態遷移サマリー + 改ざん検知付き。`FinalityLog` を辿って
イベントごとに日本語の reason / actors を付与し、`integrity.chain_verified`
で同 TX のハッシュチェーン健全性を返す。

Response（抜粋）:
```json
{
  "txid": "TX-...",
  "lane": "EXPRESS",
  "current_state": "SETTLED",
  "summary": "送金は正常に最終確定しました",
  "timeline": [
    { "seq": 1, "at": "...", "event": "PaymentInitiated",
      "state_from": null, "state_to": "RECEIVED",
      "reason": "送金リクエストを受け付けました", "actors": ["ZC"], "payload": {} },
    ...
  ],
  "integrity": {
    "chain_verified": true,
    "entries_checked": 7,
    "break_at_seq": null,
    "break_reason": null,
    "algorithm": "SHA-256 hash-chain v1"
  },
  "proofs": { "decision_proof_ref": "...", "payer_bank_proof_ref": "...",
              "payee_bank_proof_ref": "...", "finality_log_ref": "..." }
}
```

#### GET /api/transactions/:txid/story
`/explain` の構造化データに加えて、ナラティブ段落 + Mermaid sequenceDiagram +
健全性ヴァーディクト（`OK | WATCH | STUCK | TERMINAL`）を返す。オペレータが
1 件の TX を画面でレビューする用途。

Response（抜粋）:
```json
{
  "txid": "TX-...",
  "headline": "[EXPRESS] 001 → 002 の ¥5,000 は最終確定済み",
  "narrative": "09:00:01 JST に 001 から 002 への ¥5,000 の取引（EXPRESS）が動き出しました。...",
  "mermaid_sequence": "sequenceDiagram\n  autonumber\n  ...",
  "pacing": {
    "started_at": "...", "last_event_at": "...", "elapsed_ms": 123,
    "longest_gap": { "from_event": "...", "to_event": "...", "gap_ms": 80 }
  },
  "health": { "status": "TERMINAL", "message": "...", "next_expected": [] },
  "integrity": { "chain_verified": true, "entries_checked": 7 }
}
```
`health.status = STUCK`（最後のイベントから 60 秒以上経過し、まだ終端状態に
到達していない）が返ったら運用調査の合図。

#### GET /api/transactions/:txid/verify
TX チェーンのハッシュチェーン全件検証。

Response:
```json
{
  "chain_id": "TX-...",
  "valid": true,
  "entries_checked": 7,
  "break_at_seq": null,
  "break_reason": null,
  "algorithm": "SHA-256 hash-chain v1"
}
```
`valid: false` のとき `break_reason` は
`LEGACY_UNCHAINED_ENTRY | PREV_HASH_MISMATCH | ENTRY_HASH_MISMATCH` のいずれか。

#### GET /api/gtid/:gtid/verify
GTID チェーン専用のハッシュチェーン検証。Response 形は `/transactions/:txid/verify`
と同形（`chain_id` に gtid が入る）。

#### GET /api/events
全体イベントログ（最近N件）

Query: `?limit=100&offset=0`

Index: `idx_fl_occurred_at`（migration 0016）。

#### GET /api/gtid/:gtid
GTID照会

#### GET /api/gtid
GTID一覧

Query: `?limit=20&offset=0`

#### GET /api/gtid/:gtid/events
GTIDイベントログ照会

#### GET /api/htlc/:htlc_id
HTLC照会

#### GET /api/htlc
HTLC一覧

Query: `?limit=50&offset=0`

#### GET /api/dns/:business_date/status
DNS状態照会 → `{ "state": "OPEN|KICKED|SETTLED|HOLD_ACTIVE", "igs_mode": "NORMAL|...", "cycle_id": "..." }`

#### GET /api/dns/:business_date/position
参加行ネットポジション照会

#### GET /api/cases/:case_id
CASE照会

#### POST /api/cases/:case_id/update
CASE状態更新

Request: `{ "state": "IN_PROGRESS|RESOLVED|ESCALATED" }`

---

### SSE（Server-Sent Events）

#### GET /api/sse/events/:bankId
銀行宛リアルタイムイベントストリーム

レスポンス: `text/event-stream` 形式。EventStreamテーブルから未配信イベントをポーリング。

---

### IGS

#### POST /api/igs/callback
日銀ネット即時グロス清算のコールバック

Request:
```json
{
  "ext_instruction_id": "...",
  "status": "SETTLED|FAILED",
  "boj_settle_ref": "optional",
  "failed_reason": "optional"
}
```

---

---

### 先進的アーキテクチャ実験（Advanced Features）

#### GET /api/stream/connect
Rafiki風 ストリーミング・マイクロ決済 (WebSocket)
接続確立後、`{ "type": "START", "gtid": "..." }` を送信し、`{ "type": "PACKET", "amount": 10 }` 等を複数回送信可能。
一定間隔のDO AlarmによってD1にまとめてStateが記録される。

#### GET /api/als/lookup
Mojaloop風 O(1) エイリアス解決ディレクトリキャッシュ

Query: `?alias=phone:090xxxx`
Response: `{ "bank_id": "001", "account_hash": "...", "pspr_ref": "..." }`

#### POST /api/limit/reserve
TigerBeetle風 DOベースH限度額直列化

Request: `{ "amount": 1000 }`
Response: `{ "success": true, "reservation_id": "H-DO-RES-..." }`

---

### Reversal（救済取引）

SETTLED 済み TX に対する苦情・誤送金・二重送金などへの補償フロー。
詳細は `zenith_policy.md` 制度編、データ構造は `schema.md § ReversalRecords`。

#### POST /api/reversals
補償取引を起票する。一部の `reason` は `approval_ref` 必須（社内統制の事前
承認チケット番号など）。受理されると lane=STANDARD, purpose=REFUND の
新規 TX が生成される。

Request:
```json
{
  "original_txid": "TX-...",
  "amount": 5000,
  "reason": "CUSTOMER_DISPUTE|DUPLICATE_PAYMENT|FRAUD|WRONG_RECIPIENT|...",
  "requested_by": "001 (bank_id) | OPS",
  "approval_ref": "string (required when reason ∈ APPROVAL_REQUIRED_REASONS)",
  "description": "optional"
}
```
Response 201:
```json
{
  "result": "REVERSAL_CREATED",
  "reversal_id": "REV-...",
  "reversal_txid": "TX-...",
  "status": "TX_CREATED"
}
```
Response 422: `result` に `APPROVAL_REQUIRED | INVALID_ORIGINAL_STATE | AMOUNT_MISMATCH` 等。

#### GET /api/reversals/:reversal_id
特定 Reversal の状態と関連 TX を返す。

#### GET /api/transactions/:txid/reversals
ある TX に紐づく Reversal 一覧。

---

### Circuit Breaker（参加行疎通監視）

ZC→Bank 呼び出しの連続失敗に対するブレーカー。状態は `CLOSED → OPEN → HALF_OPEN → CLOSED`。
詳細は `schema.md § CircuitBreakerState` / `zenith_policy.md` § 縮退運用。

#### GET /api/circuit-breaker
全行のサーキットブレーカー状態とメトリクスを一覧。

Response:
```json
{ "circuit_breakers": [
  { "bank_id": "001", "state": "CLOSED", "consecutive_failures": 0,
    "total_requests": 1234, "total_successes": 1200, "total_failures": 34,
    "total_denied": 0, "half_open_inflight": 0,
    "last_success_at": "...", "last_failure_at": "..." },
  ...
] }
```

#### GET /api/circuit-breaker/:bank_id
特定行のサーキットブレーカー状態。未登録（メトリクスがまだ無い）行は
`state: CLOSED` の初期値が返る（404 ではない）。

#### POST /api/circuit-breaker/:bank_id/reset
強制 CLOSED へリセット（運用オペレーション）。

Response: `{ "result": "RESET", "bank_id": "..." }`

---

### 管理・設定

#### POST /api/pspr/register
PSPR登録

Request: `{ "pspr_ref": "...", "payee_bank_id": "001", "account_hash": "h:...", "expires_at": "RFC3339" }`

#### POST /api/participants/register
参加行登録（初期投入用）

Request: `{ "bank_id": "001", "bank_name": "長岡銀行", "ingress_base_url": "/bank/001", "h_limit": 100000000 }`

#### GET /api/banks
参加行一覧

#### POST /api/banks/add
参加行追加（シミュレーター用: 銀行＋システム勘定を一括作成）

Request: `{ "bank_id": "003", "bank_name": "加賀銀行", "h_limit": 100000000 }`

#### DELETE /api/banks/:bankId
参加行削除

#### GET /api/banks/:bankId/accounts
参加行の口座一覧

#### GET /api/accounts/:accountId/name
口座名義照会

---

### OpenAPI仕様書

#### GET /api/openapi/zc.yaml
ZC APIのOpenAPI仕様書（YAML）

#### GET /api/openapi/bank.yaml
Bank APIのOpenAPI仕様書（YAML）

---

## ZC→Bank Ingress API（10本・Bank Mockが実装）

全エンドポイントは `POST /bank/{bank_id}/zc-ingress/...`

共通リクエストヘッダー:
```
X-ZC-Signature: HMAC-SHA256-hex
X-Idempotency-Key: string
Content-Type: application/json
```

### POST /bank/:bankId/zc-ingress/reserve-funds
H_RESERVED確保要求

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "amount": { "value": 1200, "currency": "JPY" },
  "account_hash": "h:..."
}
```

Response OK: `{ "result": "RESERVED", "reservation_ref": "uuid" }`
Response NG: `{ "result": "ERROR", "reason_code": "INSUFFICIENT_FUNDS" }`

### POST /bank/:bankId/zc-ingress/execute-debit
a実行指示（PayerExecRequested準拠、付録E.2）

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "amount": { "value": 1200, "currency": "JPY" },
  "decision_proof_ref": "DP-...",
  "h_reservation": { "reservation_id": "H-...", "mode": "RESERVED" },
  "execution_deadline": "RFC3339",
  "lane": "EXPRESS|...",
  "payer_account_hash": "h:..."
}
```

Response: `{ "result": "OK", "bank_proof_ref": { "issuer_bank_id": "001", "proof_type": "PAYER_EXEC_PROOF", "proof_id": "...", "recorded_at": "RFC3339" } }`

※ HIGH_VALUEレーンは reserve-funds を経由しないため `payer_account_hash` を直接渡す

### POST /bank/:bankId/zc-ingress/execute-credit
b実行指示（PayeeExecRequested）

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "amount": { "value": 1200, "currency": "JPY" },
  "decision_proof_ref": "DP-...",
  "payee_account_hash": "h:..."
}
```

Response: `{ "result": "OK", "bank_proof_ref": { "issuer_bank_id": "002", "proof_type": "PAYEE_EXEC_PROOF", "proof_id": "...", "recorded_at": "RFC3339", "custody_detail": null } }`
※ Custody発生時: `"custody_detail": { "is_custody": true, "reason_code": "ACCOUNT_CLOSED", "custody_account_ref": "..." }`

### POST /bank/:bankId/zc-ingress/release-reserve
H_RESERVED解放

Request: `{ "request_id": "uuid", "txid": "TX-...", "reservation_ref": "uuid" }`

Response: `{ "result": "RELEASED", "reservation_ref": "uuid" }`

### POST /bank/:bankId/zc-ingress/leg-ready-check
GTID事前レディネス確認

Request:
```json
{
  "request_id": "uuid",
  "gtid": "GT-...",
  "leg_id": "L1",
  "role": "PAYER|PAYEE",
  "amount": { "value": 3000, "currency": "JPY" },
  "account_hash": "h:..."
}
```

Response: `{ "result": "OK" }` または `{ "result": "NG", "reason_code": "INSUFFICIENT_FUNDS" }`

### POST /bank/:bankId/zc-ingress/authority-check
AML/制裁スクリーニング

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "check_type": "INITIAL|RECHECK",
  "vault_ref": "optional"
}
```

Response: `{ "result": "OK" }` または `{ "result": "NG", "reason_code": "SANCTIONS_MATCH" }`

### POST /bank/:bankId/zc-ingress/name-check
名義確認

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "pspr_ref": "optional",
  "account_hash": "h:..."
}
```

Response: `{ "result": "MATCH" }` または `{ "result": "MISMATCH", "reason_code": "NAME_MISMATCH" }`

### POST /bank/:bankId/zc-ingress/account-verify
口座確認（ZCからBankへ照会）

Request:
```json
{
  "request_id": "uuid",
  "target_account_hash": "...",
  "name_to_verify": "佐藤 花子"
}
```

Response: `{ "result": "VERIFIED|MISMATCH|NOT_FOUND", "actual_name": "...", "match_score": 1.0 }`

### POST /bank/:bankId/zc-ingress/credit-notify
入金結果通知

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "payee_account_hash": "...",
  "amount": { "value": 1200, "currency": "JPY" },
  "payer_bank_id": "001",
  "payer_name_masked": "タ●●",
  "purpose": "P2P"
}
```

Response: `{ "result": "NOTIFIED" }`

### POST /bank/:bankId/zc-ingress/rtp-notify
RTP請求通知（payee → payer bank）

Request:
```json
{
  "request_id": "uuid",
  "rtp_id": "RTP-...",
  "payee_bank_id": "001",
  "payer_bank_id": "002",
  "amount_value": 2000,
  "payee_name": "田中商店",
  "description": "optional"
}
```

Response: `{ "result": "NOTIFIED" }`

---

## Bank 顧客API（bank-spec.md 補遺C.2準拠）

共通ヘッダー: `X-Bank-Id: 001`, `X-Customer-Id: customer_uuid`（モック用・認証なし）

#### GET /bank/:bankId/v1/me/accounts
口座一覧

#### GET /bank/:bankId/v1/me/accounts/:accountId/balance
残高照会 → `{ "account_id": "...", "balance": 980000, "currency": "JPY", "as_of": "RFC3339" }`

#### GET /bank/:bankId/v1/me/accounts/:accountId/transactions
取引履歴

#### POST /bank/:bankId/v1/me/transfers
振込実行（全ZCレーン対応）

Request:
```json
{
  "amount": { "value": 5000, "currency": "JPY" },
  "payee_bank_id": "002",
  "payee_account_hash": "h:...",
  "payee_account_id": "0020000001",
  "lane": "STANDARD",
  "purpose": "P2P",
  "idempotency_key": "uuid",
  "payer_account_id": "optional"
}
```

`payee_account_id` 指定時は `payee_bank_id` を口座番号先頭3桁から自動導出可能。

#### GET /bank/:bankId/v1/me/transfers/:txid
振込状態照会

#### GET /bank/:bankId/v1/me/approvals
着金承認リクエスト一覧

Query: `?account_id=...&status=PENDING`

#### POST /bank/:bankId/v1/me/approvals/:approvalId/respond
着金承認への応答

Request: `{ "approved": true }`

承認時はZCにresume_creditを通知（Queue経由）。

---

## Bank 行員API（bank-spec.md 補遺C.3準拠）

共通ヘッダー: `X-Bank-Id: 001`, `X-Teller-Id: teller_id`（モック用・認証なし）

#### POST /bank/:bankId/v1/teller/cash/deposit
現金入金

#### POST /bank/:bankId/v1/teller/cash/withdrawal
現金払い戻し

#### GET /bank/:bankId/v1/teller/accounts
口座一覧（行員用）

#### POST /bank/:bankId/v1/teller/accounts
口座作成

#### POST /bank/:bankId/v1/teller/accounts/batch
口座一括作成

#### PATCH /bank/:bankId/v1/teller/accounts/:accountId/status
口座ステータス更新（NORMAL/FROZEN/CLOSING_HOLD/CLOSED）

#### GET /bank/:bankId/v1/teller/accounts/:accountId/journals
口座の仕訳照会

#### GET /bank/:bankId/v1/teller/journals
全仕訳照会（行全体）

#### GET /bank/:bankId/v1/teller/suspense
別段預金一覧

#### POST /bank/:bankId/v1/teller/suspense/:suspenseId/resolve
別段預金収束処理（Custody解消等）

#### GET /bank/:bankId/v1/teller/batch/status
バッチ処理状態照会

#### GET /bank/:bankId/v1/teller/audit-log
監査ログ照会

Query: `?txid=TX-...&limit=100`

---

## Bank 着金フィルタAPI

#### GET /bank/:bankId/v1/filters
フィルタ一覧

Query: `?account_id=...`

#### POST /bank/:bankId/v1/filters
フィルタ作成

Request:
```json
{
  "scope": "ACCOUNT",
  "account_id": "0010000001",
  "filter_type": "AMOUNT_LIMIT|SENDER_BLOCK|SENDER_BANK_BLOCK|EDI_PATTERN|REQUIRE_APPROVAL",
  "condition": { "max_amount": 50000 },
  "action": "REJECT|HOLD_CONFIRM|HOLD_MANUAL",
  "description": "5万円超の着金を承認制に"
}
```

#### DELETE /bank/:bankId/v1/filters/:filterId
フィルタ削除

#### PATCH /bank/:bankId/v1/filters/:filterId
フィルタ有効/無効切替

Request: `{ "is_active": false }`

---

## 内部API（Cron用・外部公開しない）

`X-Cron-Secret` ヘッダー検証必須。

#### POST /internal/cron/eod
EODバッチ手動トリガー

#### POST /internal/cron/timeout-sweep
タイムアウト巡回手動トリガー

#### POST /internal/cron/finality-audit
FinalityLog ハッシュチェーン全鎖監査の手動トリガー（通常は EOD バッチに内包）。断絶検知時は CASE へ収束。

Response: `{ "chains_checked": N, "entries_checked": M, "broken_chains": [...], "cases_opened": K }`

#### POST /internal/seed
初期データ投入（開発用）

#### POST /internal/dns/kick
DNS手動キック

Request: `{ "business_date": "YYYY-MM-DD" }`（省略時は当日）

#### POST /internal/dns/settle
DNS手動清算

Request: `{ "cycle_id": "..." }`

#### GET /internal/boj-positions
各銀行の日銀預け金勘定（BOJ）残高照会

#### POST /internal/sim/setup
シミュレーター大規模初期化（20行×200口座）

#### POST /internal/sim/setup-bank
シミュレーター単行セットアップ

#### POST /internal/transfers/:txid/resume-credit
着金承認後のクレジット処理再開通知

---

## ダッシュボード・静的ページ

| パス | 内容 |
|---|---|
| `/` `/dashboard` | メインダッシュボード（取引一覧・状態可視化） |
| `/console` | オペレーションコンソール（Alpine.js + ECharts） |
| `/bank-app` | 顧客向け銀行アプリ（Alpine.js） |
| `/theater` `/theatre` | Settlement Theater — 状態遷移のアニメーション再生 |
| `/sky` | Sky モード（システム俯瞰ビュー） |

---

## リクエストトレーシング（横断仕様）

全 HTTP レスポンスは `X-Request-Id` ヘッダーを必ず返す。エラー時は
レスポンス本文の `request_id` フィールドにも同値が入り、構造化ログ
（後述）と突合可能になる。

- リクエスト側が `X-Request-Id` を付与した場合、その値をそのまま採用する。
- 付与が無い場合、サーバが `req-<uuid>` を生成して返す。
- Cloudflare Queues コンシューマでも同等の logger を初期化し、`request_id`,
  `message_type`, `txid`, `gtid`, `attempt` を 1 行 JSON として `console`
  に出力する（Logpush でそのままパース可能）。

実装: `src/shared/logger.ts` を参照。詳細は
[`specs/architecture.md` § Observability](./architecture.md#observability) に集約。

---

## エラーカタログ（横断仕様）

全エンドポイントは失敗時に以下の JSON 形を返す。`reason_code` は機械可読、
`category` は HTTP ステータスとリトライ可否を一元化する。

```json
{
  "error":       "human-readable message",
  "reason_code": "H_LIMIT_EXCEEDED",
  "category":    "CONFLICT",
  "details":     { "txid": "TX-001", "requested": 1000, "available": 500 },
  "request_id":  "req-..."
}
```

### カテゴリと HTTP ステータス対応

`src/shared/errors.ts` の `httpStatusOf()` がただ一つの真。

| Category    | HTTP | Retryable | 用途                                                           |
|-------------|------|-----------|---------------------------------------------------------------|
| VALIDATION  | 400  | ✗         | 入力不正、フォーマット違反、FATF R.16 違反                        |
| AUTH        | 401  | ✗         | API キー欠落・HMAC 不一致・Whitelist 拒否                        |
| NOT_FOUND   | 404  | ✗         | TX/HTLC/GTID/RTP/Account/Proxy/Participant 不在                 |
| CONFLICT    | 409  | ✗         | 状態ガード・楽観ロック衝突・H 上限超過・名義不一致・サーキット開放 |
| RATE_LIMIT  | 429  | ✓ (backoff) | レート制限                                                  |
| INVARIANT   | 500  | ✗         | 不変条件違反（バグ）。FinalityLog 改ざん検出、二重記帳など       |
| INTERNAL    | 500  | ✗         | 未分類例外。実装漏れ                                           |
| DOWNSTREAM  | 502  | ✓         | 銀行 / IGS / 外部呼び出しの一時的失敗                            |
| TIMEOUT     | 504  | ✓         | 銀行 / IGS のタイムアウト                                       |

Queue コンシューマは `Retryable=✓` のみ `msg.retry()` し、それ以外は
`msg.ack()` してケース化する（無限ループ防止）。

### 主要 reason_code 一覧

| reason_code            | category   | 発生箇所例                                                  |
|------------------------|------------|-------------------------------------------------------------|
| INVALID_REQUEST        | VALIDATION | バリデーション全般                                           |
| MISSING_FIELD          | VALIDATION | 必須フィールド欠落                                           |
| INVALID_AMOUNT         | VALIDATION | 金額が負・非整数                                             |
| INVALID_LANE           | VALIDATION | 未知の lane 値                                               |
| INVALID_STATE          | VALIDATION | クライアント側からの不正な状態指定                           |
| INVALID_PROXY_TYPE     | VALIDATION | Proxy 解決時                                                 |
| FATF_R16_VIOLATION     | VALIDATION | クロスボーダーの FATF データ不備                             |
| PREIMAGE_MISMATCH      | VALIDATION | HTLC claim 時に hashlock 不一致                              |
| EXPIRED                | VALIDATION | RTP・HTLC・QR の有効期限超過                                 |
| UNAUTHORIZED           | AUTH       | API キー欠落                                                 |
| INVALID_HMAC           | AUTH       | ZC↔Bank HMAC 検証失敗                                       |
| WHITELIST_REJECTED     | AUTH       | HTLC Auth Whitelist で拒否                                   |
| ACCOUNT_FROZEN         | AUTH       | 口座凍結中の操作                                             |
| TX_NOT_FOUND           | NOT_FOUND  | `GET /api/transactions/:txid` などで該当無し                 |
| HTLC_NOT_FOUND         | NOT_FOUND  | HTLC 操作対象不在                                            |
| GTID_NOT_FOUND         | NOT_FOUND  | GTID 操作対象不在                                            |
| RTP_NOT_FOUND          | NOT_FOUND  | RTP 操作対象不在                                             |
| ACCOUNT_NOT_FOUND      | NOT_FOUND  | 口座照会失敗                                                 |
| PROXY_NOT_FOUND        | NOT_FOUND  | Proxy 解決失敗                                               |
| PARTICIPANT_NOT_FOUND  | NOT_FOUND  | 参加行未登録                                                 |
| CONCURRENCY_CONFLICT   | CONFLICT   | 楽観ロック競合（`transitionWithLog` strict モード）          |
| STATE_GUARD            | CONFLICT   | 状態ガードで遷移不可                                         |
| IDEMPOTENCY_REPLAY     | CONFLICT   | 同一 idempotency_key の再送（既存応答返却）                  |
| ALREADY_PROCESSED      | CONFLICT   | 既処理イベントの再投入                                       |
| H_LIMIT_EXCEEDED       | CONFLICT   | H 予約が participant.h_limit を超過                          |
| RESERVE_FAILED         | CONFLICT   | 銀行側 reserve-funds が NG                                   |
| AUTHORITY_CHECK_NG     | CONFLICT   | 銀行側 authority-check が NG                                 |
| NAME_MISMATCH          | CONFLICT   | 名義不一致                                                   |
| CIRCUIT_OPEN           | CONFLICT   | CircuitBreaker が OPEN                                       |
| BANK_ERROR             | DOWNSTREAM | 銀行 ingress が 5xx                                          |
| BANK_TIMEOUT           | TIMEOUT    | 銀行 ingress が応答遅延                                      |
| IGS_ERROR              | DOWNSTREAM | IGS コールバック失敗                                         |
| ALS_LOOKUP_FAILED      | DOWNSTREAM | ALS（Account Lookup Service）失敗                            |
| RATE_LIMITED           | RATE_LIMIT | レート上限                                                   |
| CHAIN_TAMPERED         | INVARIANT  | FinalityLog のハッシュチェーン検証失敗                       |
| LEDGER_IMBALANCE       | INVARIANT  | Bank 仕訳の借方=貸方が崩れた                                 |
| IMPOSSIBLE_TRANSITION  | INVARIANT  | `ALLOWED_TRANSITIONS` 不在の遷移                             |

新規 `reason_code` を追加する場合は `src/shared/errors.ts` の
`REASON_CODE_CATEGORY` と本表を**同時に**更新する（CI で型チェック時に
`category` 漏れが INTERNAL 扱いになる仕組み）。
