# Architecture & Improvement Notes

このドキュメントは、Zenith Mock の **横断的な実装規約**（エラー、ロギング、
レーン共通基盤）と、コード品質を引き上げるための**ロードマップ**を記録する。
ビジネス要件は `zenith_public.md` / `zenith_policy.md`、API 個別仕様は
`api-contracts.md`、DB は `schema.md` を参照。

> **読み方**:「なぜこの設計にしたか」と「次に何を直すか」を集約した内部
> 文書。具体的な API ペイロードや SQL は他ドキュメントが正。

---

## 1. システム階層

```
                ┌─────────────────────────────────────────┐
                │  src/index.ts  (Worker entry / router)  │  ← X-Request-Id 採番
                └───────────┬─────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────────┐
        ▼                   ▼                       ▼
   /api/* (ZC)         /bank/* (Bank)         /internal/*
    ZC Ingress      ZC→Bank Ingress         Cron / Seed
        │                   │
        ▼                   │
   src/zc/lanes/*           │            ┌──────────────────────┐
   (state machines)         │     ◀──── │ src/shared/errors.ts │ DomainError, errorResponse
        │                   │            └──────────────────────┘
        ▼                   │            ┌──────────────────────┐
   src/zc/orchestrator      │     ◀──── │ src/shared/logger.ts │ newRequestLogger
   (queue consumer +        │            └──────────────────────┘
    state transitions)      │            ┌──────────────────────┐
        │                   │     ◀──── │ src/zc/lanes/        │ transitionWithLog,
        ▼                   │            │   _helpers.ts        │ cancelInFlightTx
   FinalityLog              ▼            └──────────────────────┘
   (append-only)        Bank ledger
                       (zero-sum journal)
```

横断モジュール（右側）は **どのレーン・どの ingress からでも安全に呼べる**
副作用最小のプリミティブとして設計されている。新規エンドポイントや新規
レーンを追加する場合、まずここから組み立てる。

---

## 2. 構造化エラー — `src/shared/errors.ts`

### 設計意図
- かつてはレーン・ingress に「`console.error()` してから silent return」
  というアンチパターンが散在していた。これは**プロセス境界で失敗を観測
  できない** という致命的な問題を生む。
- `DomainError` を持ち上げて統一することで、HTTP / Queue / FinalityLog
  すべてで**同じ識別子（`reason_code`）と分類（`category`）**を使える。

### コア API
```ts
new DomainError(reason_code, message, details?, { category?, cause? })

errorResponse(err, request_id?)  // → Response (HTTP)
isDomainError(e)                 // 型ガード
isRetryable(category)            // Queue の retry 判定
httpStatusOf(category)           // HTTP マッピングの SoT
```

### カテゴリの拡張ルール
1. 新しい `reason_code` は `REASON_CODE_CATEGORY` に登録する。登録忘れは
   `categoryOf()` で `INTERNAL`（500）に落ちる — **意図的な fail-soft**
   ガードであり、登録漏れを CI で検出する仕掛けでもある。
2. `category` を増やす場合は `httpStatusOf` と `isRetryable` の両方を
   更新する。`api-contracts.md` § Error Catalog の表も同じ PR で更新する。
3. 業務ルール由来（H_LIMIT_EXCEEDED 等）は `CONFLICT`、外部系障害は
   `DOWNSTREAM` または `TIMEOUT` を選ぶ。**「リトライしていい失敗かどうか」
   が分類の本質**。

### Queue リトライポリシー
`src/index.ts#queue` は `DomainError` の `category` を見て:
- `DOWNSTREAM` / `TIMEOUT` / `RATE_LIMIT` → `msg.retry()`
- それ以外（`VALIDATION` / `CONFLICT` / `INVARIANT` / `INTERNAL`）→ `msg.ack()`

ack 側は無限ループせず、Cases テーブルにエスカレーションされる。
DomainError 以外の throw は従来通り全て retry する（互換性のため）。

---

## 3. 構造化ロギング — `src/shared/logger.ts` <a id="observability"></a>

### 1 リクエスト 1 コンテキスト
```ts
const log = newRequestLogger({ method: 'POST', path: '/api/transfers' })
const child = log.child({ txid, lane: 'EXPRESS' })
child.info('lane.dispatch')
```

- 出力は **1 行 1 JSON**。Cloudflare の Logpush / `wrangler tail` がそのまま
  パースできる。
- 自動付与フィールド: `ts`, `level`, `event`, `request_id`。
- `request_id`：受信ヘッダ `X-Request-Id` を honor し、無ければ `req-<uuid>`。
  全レスポンスにも `X-Request-Id` を返す → エラー報告→ログ突合が自明。
- PII セーフ: `vault_ref`, `preimage`, `secret`, `password`, `_pii` 末尾な
  キーは自動 `[REDACTED]`。
- `Error` インスタンスは `name` / `message` / `reason_code` / `details` の
  4 フィールドに圧縮して出力。

### イベント命名規約
`<scope>.<verb>` 形式。

| Scope             | 例                                                 |
|-------------------|----------------------------------------------------|
| `http.*`          | `http.request`, `http.not_found`, `http.unhandled_error`, `http.domain_error` |
| `queue.*`         | `queue.dispatch`, `queue.ack`, `queue.failed`      |
| `lane.*`          | `lane.dispatch`, `lane.transition`, `lane.cancel`  |
| `bank.*`          | `bank.call`, `bank.timeout`, `bank.error`          |
| `dns.*`, `eod.*`  | cron 系                                            |

新スコープ追加時は本表も更新する。

---

## 4. レーン共通プリミティブ — `src/zc/lanes/_helpers.ts`

### 動機
全 8 レーン（express, standard, htlc, gtid, rtp, highvalue, bulk, htlc_auth）
は **同じ 2 パターン**を独自実装していた:
1. `Transactions` の状態遷移（CAS UPDATE）→ `FinalityLog` 書き込み。
   原則ペアであるべきだが、別 SQL で発行されるとアトミックではない。
2. 取消時に「状態ガード → H 解放 → ログ → 終了状態化」という TOCTOU
   セーフな順序で進める。

これらが各ファイルにコピペされており、片方を直し忘れる事故が発生して
いた（実際 0011 マイグレーションは GtidLegs(txid) インデックス漏れの
事後パッチ、`htlc.ts` cancelHtlc の TOCTOU 事故も再発）。

### 提供 API
```ts
transitionWithLog(db, {
  txid, fromState, toState, eventType,
  payload?, setColumns?, sideUpdates?, strict?, skipStateMachineCheck?,
}): Promise<{ applied: boolean; previousState: string | null }>

cancelInFlightTx(db, {
  txid, reasonCode, fromStates?, skipReleaseH?, sideUpdates?, eventType?, payloadExtra?,
}): Promise<boolean>

insertTxWithLog(db, {
  txid, lane, initialState, amount, payer*, payee*,
  idempotencyKey, eventType, payload?, extraColumns?, sideUpdates?,
}): Promise<{ inserted: boolean }>
```

### 不変条件（実装で担保）
- **アトミック CAS + ログ**: `transitionWithLog` は CAS UPDATE と
  `FinalityLog` INSERT を 1 つの `db.batch()` で発行する。INSERT は直前
  UPDATE の `changes() > 0` をガードに用いる条件付き INSERT のため、CAS
  に勝てなかった呼び出しはログも書き込まれない。バッチ内で例外が起きれば
  両方ロールバック。これにより「状態だけ進んで監査ログが残らない」窓は
  存在しない。
- **状態機械検証**: `isValidTransition` を CAS UPDATE 前に常に呼ぶ。
  `ALLOWED_TRANSITIONS` に無い遷移は DB に到達せず、`INVARIANT_VIOLATION`
  を投げる（または `applied:false` を返す）。`skipStateMachineCheck` は
  既定で無効、ホワイトリスト的な例外時のみ使用。
- **CAS 並列安全**: `version = ?` 楽観ロック。並列 N 本でも `applied:true`
  は最大 1 本（テスト: `lane_helpers.test.ts`、`atomic_finality.test.ts`）。
- **取消順序**: `cancelInFlightTx` は **状態ガード成立後にのみ** H 解放を
  行う。逆順だと並列 decision 経路に勝った場合に LOCKED 予約を誤って解放
  してしまう（ZC で発生済みのバグと同型）。`DecidedCancel` ログも同じ
  `db.batch()` でアトミックに書き込む。
- **event_seq 単調性**: `writeFinalityLog` は `FinalitySeq.next_seq` を
  `UPDATE ... RETURNING` でアトミック増分し event_seq を割り当てる
  （migration 0021）。Date.now() + 乱数 + UNIQUE リトライ方式は廃止。

### 新規 lane 追加時のチェックリスト

CI で `test/zc/lane_invariants.test.ts` が以下を静的にチェックする
（regex によるソース走査）。チェックリストはそのまま自動 enforce される。

1. 既存状態を進めるなら **`transitionWithLog`**。CAS が他レーン側状態と
   並走するなら `sideUpdates` で同一バッチに入れる（HtlcContracts が参照実装）。
2. キャンセル経路は **`cancelInFlightTx`** を使う。`sideUpdates` で別表の
   キャンセル CAS も同時にロールバック可能にする（HtlcContracts の cancel が参照実装）。
3. 新規行をレーン特有の入口 state で作る場合は **`insertTxWithLog`** を使い、
   必要であれば `ALLOWED_ENTRY_STATES` に入口 state を追加する。FinalityLog は
   INSERT と同じバッチで書かれるので「行はあるが audit が無い」窓は構造的に閉じる。
   `purpose` のような一回限りのカラムは `extraColumns` で渡す。
4. 新規イベント名は `src/types/api.ts#FinalityEventType` の union に追加する
   （未登録のイベント名は lane_invariants が落ちる）。
5. `test/zc/<lane>.test.ts` に lane 単体テストを足し、
   `test/integration/balance_invariants.test.ts` に 1 ケース追加する。
6. 新規 lane file は `test/zc/lane_invariants.test.ts#LANE_FILES` に登録する
   （ファイル名 → 論理 lane 名 + Transactions.lane カラム値）。

### `lane_invariants.test.ts` が落ちたとき

| エラー | 直し方 |
|---|---|
| `UPDATE Transactions SET state` が検出された | `transitionWithLog` か `cancelInFlightTx` に置き換える |
| `INSERT INTO Transactions` が検出された | `insertTxWithLog` に置き換える。フィールドが足りなければ `extraColumns` を使う |
| lane file に `_helpers` の import が無い | 上記いずれかの helper を呼ぶ実装に直す |
| `LANE_FILES` と src ディレクトリが乖離 | テスト側の `LANE_FILES` 表を実態に合わせて更新 |
| lane の unit test が無い | `test/zc/<stem>*.test.ts` を作る |
| balance-invariant ケースが無い | `test/integration/balance_invariants.test.ts` に 1 ケース足す（または KNOWN_GAPS に登録） |
| event 名が `FinalityEventType` 未登録 | `src/types/api.ts` の union に追加 |

---

## 5. データベース改善

詳細は `schema.md` に集約。要点だけここに残す:

- **0016 で 13 個の hot-path index を追加**。timeout sweep, lane×state ダッ
  シュボード, audit by time-range, expired RTP/HTLC sweep などが対象。
- **既存マイグレーションの編集禁止**は鉄則。SQLite で `ADD COLUMN
  IF NOT EXISTS` が無いため、過去の失敗 ALTER は連番マイグレーション
  で再作成する（前例: 0005）。
- **Foreign Key は意図的に最小**（mock であり、参照整合は ZC 側状態機械と
  FinalityLog で担保）。本番化方針は `schema.md` § Foreign Key 戦略。

---

## 6. テスト戦略

### 既存
- 約 400 テスト / 30 ファイル。Vitest + better-sqlite3 in-memory D1 mock。

### 横断プリミティブ
- `test/shared/errors.test.ts` — DomainError/errorResponse/カテゴリ写像
- `test/shared/logger.test.ts` — JSON shape, redaction, child baggage
- `test/zc/lane_helpers.test.ts` — CAS / 並列 N 本 / TOCTOU 取消順序 / sideUpdates / insertTxWithLog

### 静的解析インバリアント（`test/zc/lane_invariants.test.ts`）
**目的**: 「新規 lane 追加時のチェックリスト」§4 を機械化する。`src/zc/lanes/`
配下のソースを regex で走査し、helper を回避する直書き SQL（`UPDATE
Transactions SET state` / `INSERT INTO Transactions`）、`FinalityEventType`
union 未登録のイベント名、test 漏れを検出する。runtime suite が「動く」を
確認するのに対し、こちらは「規約を守って動く」を確認する。

### 残高インバリアントの統合テスト（`test/integration/balance_invariants.test.ts`）
**目的**: 「状態機械が正しい」だけでなく「最終的に顧客口座の数字が合う」までを
往復で固定する。state-machine 系の単体テストはレーンの遷移条件を見るが、
仕訳まで追うものが無かったため、過去に以下のような**仕訳起点のバグが摺り抜けた**：

| バグ | 内容 | 修正 |
|---|---|---|
| double-credit | `onPayeeExecConfirmed` が無条件に `credit-notify` を呼び、その bank ハンドラがもう一度 `Customer(+)/ZCS(-)` を仕訳していた。EXPRESS / STANDARD / HTLC / HTLC_AUTH / HIGH_VALUE / BULK のすべてで payee が 2 倍着金。 | `bankCreditNotify` を**仕訳しない通知層**に変更（BankAuditLog + DELIVERED 応答のみ）。`execute-credit` 経由の仕訳が唯一の真実。 |
| HTLC_AUTH stuck | `approveAuthRequest` が `Transactions(state='H_RESERVED')` で INSERT。`claimHtlc` の CAS は `WHERE state='HTLC_LOCKED'` のため Transactions が動かず、Bank だけ debit されて payee は永遠に着金しない。 | INSERT 時の state を `HTLC_LOCKED` に変更し `HtlcContracts` と整合。 |
| GTID leg pairing | 2×2 で PAYEE が leg_id 昇順以外で挿入されると、PAYER↔PAYEE のペアが取り違わって誤った銀行に着金。 | `payerLegs` / `payeeLegs` を leg_id でソートし、同じ index で組む。 |

カバー範囲（11 テスト）:
- 各レーン（EXPRESS / STANDARD / HTLC / HTLC_AUTH / HIGH_VALUE / BULK / GTID 1×1 / GTID 2×2 逆順 / 複数レーン同時）について、
  1. payer 顧客 Δ == −amount
  2. payee 顧客 Δ == +amount
  3. 各行内ゼロサム
  4. BOJ 系全行合計の保存則（RTGS 経由でも 0 保存）

新規バグ修正は**この suite の `expect()` が落ちる**ことで検出できる。新レーン
追加時はこの suite に 1 ケース足すのを義務付けたい。

### 追加テスト（実装済み）
1. **冪等キー再送**（`test/integration/idempotency_replay.test.ts`）— EXPRESS / STANDARD / HTLC で
   同一 idempotency_key の 2 回目リクエストが同一レスポンスを返し、Transactions 行が 1 本のみであることを確認。
2. **Queue retry/ack ポリシー**（`test/integration/queue_retry_policy.test.ts`）— DomainError
   category × `msg.retry()` / `msg.ack()` の対応を全カテゴリで検証。non-DomainError も retry 対象であることを確認。
3. **HTLC cancel payer 残高**（`test/integration/htlc_cancel_balance.test.ts`）— `TIMELOCK_EXPIRED`
   および直接 cancel の 2 経路で payer suspense が普通預金に戻り、行内ゼロサムが保たれることを確認。

---

## 7. 既知の制約・将来項目

- **secret rotation**: `ZC_HMAC_SECRET` はワーカー env のみ。ローテーション
  時の overlap window が無い。
- **bank 認可**: HMAC のみ。Bank A → Bank B のクロス参照を API で塞ぐ
  仕組みは無い（mock では十分、本番には不可欠）。
- **ALS_KV / LIMIT_DO / STREAM_DO** の `?:` バインドが残っている
  （optional binding）。本番 wrangler.toml では required にする。
- **ハッシュチェーン検証 cron**: `verifyChain` は API 経由でのみ走る。
  日次自動化が望ましい。
- **OpenAPI YAML 自動生成**: `src/openapi/*.yaml` は手書き。コードの
  ルーティングと型から再生成する仕組みを入れたい。

これらは本書の Roadmap として残し、優先度の高いものから別途 issue 化する。
