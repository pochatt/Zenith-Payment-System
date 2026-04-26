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
1. `Transactions` の状態遷移（CAS UPDATE）→ `FinalityLog` 書き込み（厳密
   にはアトミックでないが、業務上ペアであるべき）。
2. 取消時に「状態ガード → H 解放 → ログ → 終了状態化」という TOCTOU
   セーフな順序で進める。

これらが各ファイルにコピペされており、片方を直し忘れる事故が発生して
いた（実際 0011 マイグレーションは GtidLegs(txid) インデックス漏れの
事後パッチ、`htlc.ts` cancelHtlc の TOCTOU 事故も再発）。

### 提供 API
```ts
transitionWithLog(db, {
  txid, fromState, toState, eventType,
  payload?, setColumns?, strict?,  // strict:true で CONCURRENCY_CONFLICT throw
}): Promise<{ applied: boolean; previousState: string | null }>

cancelInFlightTx(db, {
  txid, reasonCode, fromStates?, skipReleaseH?,
}): Promise<boolean>
```

### 不変条件
- `transitionWithLog` の UPDATE は `version = ?` での CAS。並列 N 本でも
  applied:true は最大 1 本（テストで保証: `lane_helpers.test.ts`）。
- `cancelInFlightTx` は **状態ガード成立後にのみ** H 解放を行う。逆順だと
  並列 decision 経路に勝った場合に LOCKED 予約を誤って解放してしまう
  （ZC で発生済みのバグと同型）。

### Lane Refactor Roadmap
既存レーン 8 本は段階的に移行する。順序は **小さく安全な順 → 大物**:

| Phase | Target              | LOC delta (見込) | 備考                                                        |
|-------|---------------------|-----------------|-------------------------------------------------------------|
| 0     | (完了)             | —               | `_helpers.ts` 追加、テストで挙動確証                         |
| 1     | `bulk.ts` (103L)    | -30             | 最小レーン。リスク低                                         |
| 2     | `highvalue.ts`(119L)| -40             | IGS 連携部は維持                                             |
| 3     | `express.ts` (183L) | -60             | 既存テスト 10 本でリグレッション保証                         |
| 4     | `standard.ts` (253L)| -80             | name-check 中断・再開の特別ケース有り                        |
| 5     | `htlc.ts`  (305L)   | -90             | preimage / timelock の状態を helper に持ち込まない           |
| 6     | `gtid.ts`  (287L)   | -70             | leg 集約は別 helper（`gtidLegsHelper.ts`）に切り出し検討     |
| 7     | `rtp.ts`   (421L)   | -120            | 銀行コールバック多段、helper を強化してから着手              |
| 8     | `htlc_auth.ts`(498L)| -150            | 最大。Whitelist 周りに専用 helper を切り出すと吉             |

**着手原則**:
- 1 PR = 1 レーンに限定する（レビュー範囲を小さく）。
- 既存テストを 1 本も削らない／追加した動作はテストで担保する。
- helper のシグネチャ変更が必要になったら、まず `_helpers.ts` の PR を独
  立で出してテストで挙動を固定する。

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
- 270 テスト / 16 ファイル。Vitest + better-sqlite3 in-memory D1 mock。
- カバレッジ偏在: HTLC_AUTH, HIGH_VALUE, BULK は薄い。

### 横断プリミティブ（本 PR で追加）
- `test/shared/errors.test.ts` — DomainError/errorResponse/カテゴリ写像
- `test/shared/logger.test.ts` — JSON shape, redaction, child baggage
- `test/zc/lane_helpers.test.ts` — CAS / 並列 N 本 / TOCTOU 取消順序

### 推奨される追加テスト（次の PR）
1. **HTLC_AUTH の happy + reject + void** — 498 行で 0 テストはリスク。
2. **BULK / HIGH_VALUE の最小フロー**。
3. **冪等キー再送**（同 idempotency_key で 2 回叩いて同一レスポンス）。
4. **Bank コールバック失敗時のリトライ → ack ループ**（DomainError
   category × queue.retry 挙動）。

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
