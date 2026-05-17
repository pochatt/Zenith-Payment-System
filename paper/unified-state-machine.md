# 銀行間決済における統一状態機械アーキテクチャ

―伝統的決済レーンと暗号学的ファイナリティ原語を単一遷移表で扱う協調層の設計と実装―

**版**：v2.0（2026年5月）
**実装根拠**：`pochatt/zenith-payment-system`（TypeScript / Cloudflare Workers / D1）

---

## 概要

複数銀行間の決済を協調するシステムでは、即時送金（リテール）、高額即時決済（RTGS）、日次ネット清算（DNS）、条件付き決済（HTLC）、多者協調決済（アトミック・マルチレグ）など、起源も意味論も異なる複数のファイナリティ原語を併存させる必要がある。従来の実装は、それぞれを独立した台帳・状態モデル・監査経路として構築し、それらの間を「ブリッジ」で接続する設計を取ってきた。本稿では、これら全レーンを **単一の正準的な状態遷移表** の上に並ぶ対等な経路として再構成し、状態遷移と追記型監査ログの書き込みを **データベースの単一バッチでアトミックに発行する** ことで、「状態は進んだが監査ログが残らない時間窓」を構造的に排除する協調層アーキテクチャを示す。Cloudflare Workers と D1（分散 SQLite）上の参照実装（TypeScript 約 18,000 行、テスト 7,886 行、マイグレーション 21 ファイル、28 テーブル）を題材として、(i) 14 状態 8 レーンを単一遷移表で表現する設計、(ii) CAS UPDATE と FinalityLog INSERT を `db.batch()` で対化する原子化プリミティブ、(iii) SHA-256 ハッシュチェーンによる事後改竄検出、(iv) 三状態 H モデルによる仕向超過限度の構造的不可超過、(v) BOJ プレファンドと DNS 三相清算による行内ゼロサム保存則の達成、を実装根拠とともに詳述する。

---

## 1. はじめに

### 1.1 背景：協調層と下層の分離

複数の金融機関にまたがる決済処理を、どこで・どのように「正本」として固定するかは、決済システム設計における中心的論点である。近年、トークン化預金やホールセール CBDC、共通台帳プラットフォームなど、貨幣・台帳の **下層（substrate）** を再構築することで、決済ライフサイクル全体を単一のデータ構造に閉じ込めようとする実装が広がっている。これらは強力なアプローチである一方、既存の銀行勘定系を全面的に置き換えることを前提とするため、社会的・制度的なコストは大きい。

本稿が扱うのは、**下層をそのままにしたうえで、その「間」だけを協調・説明可能化する層** の設計である。すなわち、各参加銀行の勘定系・口座管理・与信判断はこれまで通り各行の責任に置きつつ、銀行と銀行のあいだで生じる取引を「説明できる状態の連なり」として固定する協調層を、独立した設計対象として扱う。

### 1.2 課題：レーン間の意味論的断絶

協調層を実装するうえで実務的に最大の障壁となるのは、扱うべきファイナリティ原語の **異質性** である。代表的なレーンと、その「不可逆性を構成する原語」は次のように整理される。

| レーン | 出自 | 不可逆性を構成する原語 |
| --- | --- | --- |
| EXPRESS / STANDARD / BULK | 伝統系（リテール、全銀系） | 仕向超過限度の予約 + 日次ネッティング |
| HIGH_VALUE | 伝統系（中央銀行 RTGS） | 即時グロス決済（プレファンド消費） |
| RTP | ハイブリッド（受取人発起プル） | 名義確認 + 支払人事前承認 |
| HTLC / HTLC_AUTH | 暗号系（条件付きエスクロー） | ハッシュロック + タイムロック |
| GTID | 暗号系（多者協調マルチレグ） | 全レッグ確定の原子性 |

これらは異なる業界・文脈で発展した原語であり、素朴に並べると、それぞれが独自の状態語彙・独自の監査経路・独自の取消条件を持つことになる。実装上は「レーンごとに別の状態機械をコピペで書く」「監査ログのスキーマがレーンごとに分岐する」という事態を招き、運用・監査・障害解析のコストが指数的に増える。

### 1.3 本稿の提示する解

本稿は、上記の異質性に対し次の三層構造を提示する。

1. **単一遷移表（Single Transition Table）**：全レーンが共有する正準的な状態遷移表 `ALLOWED_TRANSITIONS` を、TypeScript の単一リテラルとして固定する。レーン固有の状態（例：`HTLC_LOCKED`、`HTLC_FULFILL_REQUESTED`）も同一表に登録され、レーンが独自の状態機械を持つことを禁ずる。
2. **状態遷移と監査ログのアトミック対化**：状態を進める CAS UPDATE と、対応する追記型監査ログ `FinalityLog` への INSERT を、D1 の `db.batch()` の単一バッチで発行する。CAS が他の writer に負けた場合は監査ログも書かれず、CAS が勝った場合は副台帳（HtlcContracts, GtidLegs 等）の更新まで含めて全件一括コミットされる。
3. **ハッシュチェーンによる事後改竄検出**：`FinalityLog` の各エントリは前エントリの `entry_hash` を `prev_hash` として取り込み、SHA-256 で連鎖する。任意の中間エントリの改竄は、後続の `prev_hash` 不一致として機械的に検出可能になる。

これらは「論文的な抽象設計」ではなく、参照実装の `src/zc/orchestrator/state_machine.ts`、`src/zc/lanes/_helpers.ts`、`src/zc/finality_chain.ts` に具体的なコードとして存在する。本稿は、それらの設計判断と実装上のトレードオフを、現場のエンジニアが業務システムへ持ち帰れる粒度で記述することを目的とする。

### 1.4 本稿の構成

第 2 章で全体アーキテクチャを概観する。第 3 章〜第 5 章で中核三層（遷移表・原子対化・ハッシュチェーン）を詳述する。第 6 章〜第 9 章で、それらを支える周辺機構（H モデル、銀行台帳、DNS サイクル、非同期処理基盤）を述べる。第 10 章で運用上の安全装置を、第 11 章で検証アプローチをまとめる。第 12 章で設計上の限界と今後の方向性を率直に整理する。

---

## 2. システム構成

### 2.1 物理構成

参照実装は次のクラウドネイティブ・スタックの上で動作する。

| 層 | 採用技術 | 役割 |
| --- | --- | --- |
| 計算 | Cloudflare Workers（V8 isolate） | 単一エントリポイント `src/index.ts`。HTTP ルーティング・キュー消費・cron 起動を一つのスクリプトに集約 |
| 永続化 | Cloudflare D1（分散 SQLite） | 28 テーブル。トランザクション本体・監査ログ・銀行台帳を同一データベースに同居 |
| 非同期 | Cloudflare Queues | レーン横断の状態前進、銀行呼出のリトライ |
| 大容量データ | Cloudflare R2 | 商流情報（リッチデータ）の 50KB 超オフロード |
| 一時メモリ | KV / Durable Object | エイリアス解決キャッシュ、限度額直列化 |

本稿の主題は協調層の **論理設計** にあるため、具体的なクラウド製品の選定は付随的な話題に留める。本設計は「単一データベースに対する CAS とバッチが利用可能」という前提のもとで再実装可能であり、PostgreSQL や CockroachDB を採用しても本質は変わらない。

### 2.2 論理構成

```
┌─────────────────────────────────────────────────────┐
│  src/index.ts  (HTTP router / queue consumer / cron) │
└──────────┬──────────────────────────────────────────┘
           │
   ┌───────┼────────────┬─────────────────┐
   ▼       ▼            ▼                 ▼
 /api/*  /bank/*    /internal/*       Queue consumer
   │        │           │                 │
   ▼        ▼           ▼                 ▼
 zc/lanes/* bank/  Cron(EOD,sweep)  zc/orchestrator/
   │ (8 lanes)       │              (state advance,
   ▼                 ▼               bank call hub,
 zc/orchestrator/  bank/ledger.ts    queue dispatch)
 _helpers.ts      (zero-sum journal)
   │
   ▼
 D1: Transactions / FinalityLog / HtlcContracts /
     GtidLegs / DnsCycles / HReservations /
     BankAccounts / BankJournals / ... (28 tables)
```

`src/index.ts` を単一エントリとし、HTTP・キュー・cron をルーティングする。協調層の本体は `src/zc/` 配下、銀行側（参照実装に同梱した擬似銀行）は `src/bank/` 配下に分離する。両者は実環境では別組織のシステムであり、HMAC 署名付きの HTTP で通信する関係にある。

### 2.3 中核データモデル

協調層の中核データは、次の二テーブルに集約される。

**Transactions**（取引本体）

```sql
CREATE TABLE Transactions (
  txid             TEXT    PRIMARY KEY,
  lane             TEXT    NOT NULL,         -- EXPRESS|STANDARD|BULK|HIGH_VALUE|RTP|HTLC|HTLC_AUTH|GTID|DEFERRED
  state            TEXT    NOT NULL,         -- 14 states (see §3.1)
  amount_value     INTEGER NOT NULL,         -- 整数（JPY 単位）。浮動小数を避ける
  amount_currency  TEXT    NOT NULL,
  payer_bank_id    TEXT    NOT NULL,
  payer_account_hash TEXT  NOT NULL,
  payee_bank_id    TEXT    NOT NULL,
  payee_account_hash TEXT,
  idempotency_key  TEXT    UNIQUE,
  decision_proof_ref TEXT,
  finality_log_ref TEXT,
  h_reservation_id TEXT,
  dns_cycle_id     TEXT,
  reason_code      TEXT,
  version          INTEGER NOT NULL DEFAULT 0,  -- CAS 楽観ロック
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
```

**FinalityLog**（追記型監査ログ、第 5 章で詳述）

```sql
CREATE TABLE FinalityLog (
  log_id       TEXT    PRIMARY KEY,
  txid         TEXT,                      -- TX 系チェーン
  gtid         TEXT,                      -- GTID/DNS 系チェーン
  event_type   TEXT    NOT NULL,
  state_from   TEXT,
  state_to     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  event_seq    INTEGER NOT NULL,          -- FinalitySeq から原子割当
  occurred_at  TEXT    NOT NULL,
  prev_hash    TEXT,                      -- 前エントリの entry_hash
  entry_hash   TEXT                       -- SHA-256(prev_hash | ...)
);
CREATE UNIQUE INDEX idx_fl_event_seq_unique ON FinalityLog(event_seq);
CREATE UNIQUE INDEX idx_fl_chain_prev_hash  ON FinalityLog(txid, prev_hash) WHERE txid IS NOT NULL;
CREATE UNIQUE INDEX idx_fl_gtid_chain_prev_hash
                                            ON FinalityLog(gtid, prev_hash)
                                            WHERE gtid IS NOT NULL AND txid IS NULL;
```

`Transactions.version` 列が CAS 楽観ロック、`FinalityLog.event_seq` が全順序、`FinalityLog.prev_hash` がハッシュチェーンを担う。これら三つの機構が組み合わさって、後述する「状態と監査の同時性」を支える。

---

## 3. 統一状態機械

### 3.1 単一遷移表

全レーン共通の正準的な状態遷移表 `ALLOWED_TRANSITIONS` は、`src/zc/orchestrator/state_machine.ts` に TypeScript リテラルとして固定される。

```typescript
export const ALLOWED_TRANSITIONS: Record<TxState, TxState[]> = {
  RECEIVED:               ['PRECHECKED', 'HTLC_LOCKED', 'DECIDED_CANCEL'],
  PRECHECKED:             ['PRECHECKED_SUSPENDED', 'H_RESERVED',
                           'DECIDED_CANCEL', 'DECIDED_TO_SETTLE'],
  PRECHECKED_SUSPENDED:   ['PRECHECKED', 'DECIDED_CANCEL'],
  H_RESERVED:             ['DECIDED_TO_SETTLE', 'DECIDED_CANCEL'],
  DECIDED_TO_SETTLE:      ['PAYER_EXEC_CONFIRMED', 'PAYEE_EXEC_CONFIRMED',
                           'SUSPENDED'],
  DECIDED_CANCEL:         ['CANCELLED'],
  PAYER_EXEC_CONFIRMED:   ['PAYEE_EXEC_CONFIRMED', 'SUSPENDED'],
  PAYEE_EXEC_CONFIRMED:   ['SETTLED'],
  SUSPENDED:              ['PAYER_EXEC_CONFIRMED', 'PAYEE_EXEC_CONFIRMED',
                           'FAILED_EXECUTION'],
  HTLC_LOCKED:            ['HTLC_FULFILL_REQUESTED', 'DECIDED_CANCEL'],
  HTLC_FULFILL_REQUESTED: ['DECIDED_TO_SETTLE', 'FAILED_EXECUTION'],
  SETTLED:                [],   // 終端
  FAILED_EXECUTION:       [],   // 終端
  CANCELLED:              [],   // 終端
}
```

状態は 14 個、うち終端が 3 個。注目すべきは、暗号系固有の状態（`HTLC_LOCKED`, `HTLC_FULFILL_REQUESTED`）が、伝統系の状態（`PRECHECKED`, `H_RESERVED`）と同一の表に並んでいる点である。両者は意味こそ異なるが、有限状態機械上の節点としては同格である。

新規レーンを追加する場合の規約は、(i) 新状態を `TxState` 型 union と本表に追加、(ii) 入口状態であれば `ALLOWED_ENTRY_STATES` ホワイトリストにも追加、の二点のみである。レーンが独自の状態機械を持つことは禁じられる。

### 3.2 確定点の三段階

設計上、すべての取引は次の三段階の確定点を経由して終端に向かう。

- **Decision（`DECIDED_TO_SETTLE`）**：協調層が「実施指示を出すこと」を確定した境界。
- **a（`PAYER_EXEC_CONFIRMED`）**：支払側参加者の実施が証憑により確定した境界。
- **b（`PAYEE_EXEC_CONFIRMED`）**：受取側参加者の利用可能化が確定した境界。**不可逆境界はここに置く**。

これらの境界はレーンに関係なく同一の語彙で表現される。HTLC の preimage 提示も RTGS の中央銀行確定も、結局は「Decision → a → b → SETTLED」という同じ四段階に投影される。

### 3.3 レーン別の状態経路

8 レーンの代表的経路を以下に示す。

| レーン | 状態経路 |
| --- | --- |
| EXPRESS | RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED |
| STANDARD | RECEIVED → PRECHECKED →（PRECHECKED_SUSPENDED）→ H_RESERVED → DECIDED_TO_SETTLE →（顧客最終認可待ち）→ a → b → SETTLED |
| BULK | RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE（DNS サイクル待ち）→ a → b → SETTLED |
| HIGH_VALUE | RECEIVED → PRECHECKED → DECIDED_TO_SETTLE → a → IGS 確定 → b → SETTLED |
| HTLC | RECEIVED → HTLC_LOCKED →（preimage 提示）→ HTLC_FULFILL_REQUESTED → DECIDED_TO_SETTLE → a → b → SETTLED |
| GTID | （GT-level Decision 後）DECIDED_TO_SETTLE → a → b → SETTLED |

特筆すべき経路二つを挙げる。

**HIGH_VALUE の H_RESERVED スキップ**：`PRECHECKED → DECIDED_TO_SETTLE` の直行遷移を、本表は明示的に許可する（`PRECHECKED` の遷移先に `DECIDED_TO_SETTLE` が含まれる）。これは、中央銀行 RTGS を経由する取引が「仕向超過限度（H）を消費しない」「DNS ネッティングのリザーブを必要としない」という業務規範を、状態機械の語彙だけで表現したものである。同等の規範を例外パスで処理すると、レーン分岐がコードベースに広く伝播するが、本設計では遷移表に一行追加するだけで完結する。

**GTID のレッグレベル INSERT 入口**：GTID のレッグ取引は GT 全体の Decision 確定後に「直接 `DECIDED_TO_SETTLE` 状態で INSERT される」。GT-level の原子的 Decision がすでにコミットされているため、レッグ単位での pre-decision 状態が存在しないからである。このような中間状態スキップを野放しにすると状態機械の単一性が崩れるため、`ALLOWED_ENTRY_STATES = {RECEIVED, HTLC_LOCKED, DECIDED_TO_SETTLE}` というホワイトリストを設け、`insertTxWithLog` ヘルパが静的に検証する。

### 3.4 機械的強制：レーン側の規約

`ALLOWED_TRANSITIONS` を「ドキュメントとしてではなく、強制される表として」機能させるため、次の三点を運用規約として固定する。

1. `Transactions.state` を変更する全コードは、共通ヘルパ `transitionWithLog`（次章）または `cancelInFlightTx` を経由しなければならない。生の `UPDATE Transactions SET state = ...` は禁止。
2. `Transactions` への INSERT は `insertTxWithLog` を経由する。直接 INSERT は禁止。
3. (1)(2) の違反は、CI 上の正規表現走査（`test/zc/lane_invariants.test.ts`）で機械検出される。具体的には `UPDATE\s+Transactions\s+SET\s+state` と `INSERT\s+INTO\s+Transactions` のパターンを `src/zc/lanes/` 配下で grep し、ヘルパファイル以外で検出された場合はテスト失敗とする。

これにより「将来の改修で誰かが状態機械を回避する」事故を、コードレビューではなく仕組みで防ぐ。

---

## 4. 状態遷移と監査ログのアトミック対化

### 4.1 問題：説明可能性プロトコルにおける時間窓

「監査ログのある追記型システム」は珍しくない。しかし、説明可能性を保証するうえで多くの実装が陥る根本的な失敗モードは次の二つである。

| 失敗モード | 内容 | 帰結 |
| --- | --- | --- |
| (a) 状態先行 | 状態 UPDATE は成功、監査 INSERT は失敗（UNIQUE 衝突、コネクション切断、再起動）| 「状態は進んだが、なぜ進んだか説明できない」 |
| (b) 監査先行 | 監査 INSERT は成功、状態 UPDATE は CAS 負け | 「監査ログにはあるが、実際の状態と一致しない」 |

これらを「適切なリトライ」「冪等性キー」「補償トランザクション」で吸収しようとする設計は、よくある一方で、**境界条件における失敗をゼロにすることはできない**。本稿の立場は、これらを **構造的に排除する** ことである。

### 4.2 `transitionWithLog` プリミティブ

参照実装は、全レーンが状態を進める際に通る単一のヘルパ `transitionWithLog`（`src/zc/lanes/_helpers.ts`）を提供する。中核は次の四点である。

**(1) 静的検証の事前実行**

CAS UPDATE 前に `isValidTransition(from, to)` を呼び、`ALLOWED_TRANSITIONS` に無い遷移はデータベース I/O 以前に弾く。違反は `INVARIANT_VIOLATION` 例外として捕捉される。

**(2) 条件付き INSERT**

`FinalityLog` への INSERT は `INSERT ... SELECT ... WHERE EXISTS(...)` の形を取り、直前の UPDATE が成功した場合（`changes() > 0`）にのみ実行される。CAS が負けた呼び出しは監査ログも書かれない。

**(3) 単一バッチでの発行**

UPDATE と条件付き INSERT を D1 の `db.batch([...])` の単一バッチで発行する。バッチは内部的に一つのトランザクション境界として扱われるため、いずれかの文が失敗すれば全体がロールバックされる。実装の核心部分（簡略化）：

```typescript
const results = await db.batch([
  // (i) 状態の CAS UPDATE
  db.prepare(`
    UPDATE Transactions
       SET state = ?, ...
       , version = version + 1
     WHERE txid = ? AND state IN (...) AND version = ?
  `).bind(toState, ...setValues, now, txid, ...fromStates, version),

  // (ii) 直前 UPDATE 成功時のみ走る条件付き INSERT
  buildFinalityLogConditionalInsert(db, logRow),

  // (iii) 副台帳の同期更新（HtlcContracts, GtidLegs 等）
  ...sideUpdates.map(u => db.prepare(u.sql).bind(...u.binds)),
])

const updateChanges = results[0]?.meta.changes ?? 0
if (updateChanges === 0) return { applied: false, ... }
```

**(4) 副台帳の巻き込み（`sideUpdates`）**

HTLC レーンは `HtlcContracts` 表、GTID レーンは `GtidLegs` 表という副台帳を持ち、これらが正準状態と並走する。副台帳更新を同一バッチに積むことで、「`Transactions.state` は `HTLC_LOCKED` に進んだが、`HtlcContracts.state` は `HTLC_RECEIVED` のまま」という不整合窓を消す。具体例（HTLC ロック時）：

```typescript
await transitionWithLog(db, {
  txid: htlc.txid,
  fromState: 'RECEIVED',
  toState: 'HTLC_LOCKED',
  eventType: 'HtlcLocked',
  payload: { htlc_id: htlcId, reservation_id: reservationId },
  setColumns: { h_reservation_id: reservationId },
  sideUpdates: [{
    sql: `UPDATE HtlcContracts SET state='HTLC_LOCKED', version=version+1, updated_at=?
          WHERE htlc_id=? AND state='HTLC_RECEIVED'`,
    binds: [now, htlcId],
  }],
})
```

### 4.3 取消経路における順序問題

順序問題（TOCTOU）が特に顕在化するのは取消経路である。素朴に「H 予約を解放してから状態をキャンセルに進める」順序で実装すると、並行する Decision 経路が CAS を勝ち取って `DECIDED_TO_SETTLE` に進んだ場合、すでに解放された H 予約に対して Decision が成立してしまう。

`cancelInFlightTx` ヘルパは、これを次の順序で解消する。

```
(1) CAS UPDATE で DECIDED_CANCEL への遷移を試みる
    （同一バッチで FinalityLog 'DecidedCancel' を発行）
        ↓ canonical UPDATE が changes > 0 で成功した場合のみ
(2) releaseH(reservation_id) を呼ぶ
        ↓
(3) finalizeCancelledTx で CANCELLED 終端化
```

「状態を先に押さえてから、H 解放等の副作用を実行する」順序は、過去に同型のバグ（"LOCKED 予約の誤解放"）が発生した経験から、不変条件として固定された。本順序により、並行 Decision 経路が CAS を勝ち取っていれば取消側の `changes` は 0 となり、H 解放はそもそも実行されない。

### 4.4 入口遷移の制御

GTID 由来のレッグレベル INSERT のように、中間状態をスキップした入口遷移を野放しにすると、状態機械の単一性が崩れる。`insertTxWithLog` ヘルパは次のホワイトリストで入口状態を制限する。

```typescript
const ALLOWED_ENTRY_STATES = new Set<TxState>([
  'RECEIVED',            // 通常のレーン入口
  'HTLC_LOCKED',         // HTLC 入口（hashlock 提示時）
  'DECIDED_TO_SETTLE',   // GTID レッグ入口（GT-level Decision 後）
])
```

ホワイトリスト外の状態での INSERT は `INVARIANT_VIOLATION` で拒否される。ホワイトリストを変更する PR は必ずレビュー対象となるため、「新レーンが任意の状態から INSERT する経路を作る」事故が静的検証回避にならない。

### 4.5 event_seq の単調性

`FinalityLog.event_seq` は、全イベントに対する全順序を構成する整数である。本設計は時刻ベース＋乱数＋UNIQUE リトライの方式を採用せず、専用カウンタテーブル `FinalitySeq` に対する `UPDATE ... RETURNING` で原子的に割り当てる（マイグレーション 0021）。

```sql
CREATE TABLE FinalitySeq (
  id       INTEGER PRIMARY KEY CHECK(id = 1),
  next_seq INTEGER NOT NULL
);

-- 割当（一文で原子的）
UPDATE FinalitySeq SET next_seq = next_seq + 1 WHERE id = 1 RETURNING next_seq;
```

SQLite/D1 の一文 UPDATE は暗黙のトランザクション境界として扱われるため、並行 isolate からの呼び出しはシリアライズされ、各々が異なる seq 値を受け取る。`idx_fl_event_seq_unique` は防御的なベルト＆サスペンダーであり、主機構ではない。

---

## 5. ファイナリティログのハッシュチェーン

### 5.1 設計目標：事後改竄の機械的検出

`FinalityLog` は **追記専用** であり、運用上の規約として更新・削除を禁ずる。しかし規約だけでは「DBA 権限で行を書き換える」事故・悪意を防げない。本設計は SHA-256 によるハッシュチェーンを追加し、任意の中間エントリの改竄が後続エントリの `prev_hash` 不一致として **機械的に検出可能** となるよう設計する。

### 5.2 チェーン識別子の解決規則

複数の取引（複数の `txid`、複数の GTID）が並走する環境で、どのエントリが同じチェーンに属するかを一意に決める規則が必要である。本実装は次の規則を採る（`src/zc/finality_chain.ts`）。

```typescript
function chainIdOf(entry: { txid: string | null; gtid: string | null }): string {
  return entry.txid ?? entry.gtid ?? GLOBAL_CHAIN_ID  // 'GLOBAL'
}
```

- `txid` を持つエントリは、その `txid` 単位の独立チェーンを形成
- `gtid`（GT-level イベント、または DNS イベント）のみを持つエントリは、`gtid` 単位のチェーン
- いずれも持たないエントリ（システム全体イベント）は `GLOBAL` チェーン

これにより、取引ごとのチェーンが独立して検証可能となり、長期運用での検証コストが O(取引数 × 取引ごとイベント数) ではなく O(チェーンごとイベント数) に抑えられる。

### 5.3 ハッシュ計算の正準化

エントリのハッシュは次の正準形を SHA-256 した値である。

```typescript
canonicalize(entry, prevHash) =
  [ prevHash,
    entry.log_id,
    entry.txid ?? '',
    entry.gtid ?? '',
    entry.event_type,
    entry.state_from ?? '',
    entry.state_to,
    entry.payload_json,
    String(entry.event_seq),
    entry.occurred_at,
  ].join('|')

entry.entry_hash = sha256hex(canonicalize(entry, prevHash))
```

正準形をパイプ区切りに固定するのは、フィールドの追加・削除・順序変更によるハッシュ非互換を **プロトコルバージョン変更として明示的に扱う** ためである。JSON シリアライズ（キー順や空白に依存）を避けることで、再計算結果が環境依存になる事故を防ぐ。

### 5.4 フォーク防止

ハッシュチェーンが線形であるためには、同一 `chain_id` 内で同じ `prev_hash` を持つエントリが二つ以上存在してはならない。これは次の UNIQUE インデックスで強制する。

```sql
CREATE UNIQUE INDEX idx_fl_chain_prev_hash
       ON FinalityLog(txid, prev_hash) WHERE txid IS NOT NULL;
CREATE UNIQUE INDEX idx_fl_gtid_chain_prev_hash
       ON FinalityLog(gtid, prev_hash) WHERE gtid IS NOT NULL AND txid IS NULL;
```

並行 isolate が同じ `prev_hash` を取得して INSERT を競った場合、後勝ち側は UNIQUE 制約違反で失敗する。失敗した INSERT を含むバッチは全体ロールバックされるため、状態 UPDATE もキャンセルされ、呼び出し元は再試行する。これにより、フォークしたチェーンが永続化することは構造的に起こらない。

### 5.5 検証アルゴリズム

`verifyChain(chainId, db)` は次の手順でチェーン全体を検証する（`src/zc/finality_chain.ts`）。

1. `chainId` に属する全エントリを `event_seq` 昇順で取得
2. 各エントリについて：
   - `entry_hash` を `canonicalize(entry, prev_hash)` から再計算し、保存値と比較
   - `prev_hash` が直前エントリの `entry_hash` と一致するか確認（最初のエントリは `GENESIS` 定数）
3. いずれかが不一致なら `{valid: false, break_at_seq, break_reason}` を返す

レガシー（マイグレーション 0015 以前）の hash 未付与エントリは検証対象外として明示的にスキップする規約とする。

---

## 6. 流動性制御：H モデル

### 6.1 H とは何か

**H（Headroom：仕向超過限度）** は、各銀行が DNS 清算サイクル内で「未確定のまま積み上げてよい仕向総額」の上限である。日次ネット清算では、サイクル内に発生した取引はサイクル終了まで実際の中央銀行決済を伴わないため、ある銀行が大きく仕向超過した状態でサイクル末を迎えると、清算時の流動性不足リスクが顕在化する。H はこれを上流（取引受付時）で構造的に抑制する仕掛けである。

### 6.2 三状態ライフサイクル

H 予約は次の三状態を持つ。

```
[reserveH]            [lockH]                [releaseH]
   ↓                     ↓                      ↓
RESERVED  ────────→  LOCKED  ──────────→  RELEASED
(取引受付時)        (Decision 確定時)      (DNS 清算時)
```

- **RESERVED**：取引が PRECHECKED から H_RESERVED へ遷移する際に確保。Decision 確定前の取消であれば即時解放可能。
- **LOCKED**：Decision 確定（`DECIDED_TO_SETTLE`）時に固定。以降は DNS 清算完了まで保持される。
- **RELEASED**：DNS 清算完了時、または取消時に解放。`is_released = 1` フラグで二重解放を防止。

### 6.3 不変条件の構造的保証

H の核心的な不変条件は次の一行である。

$$
\forall \text{bank } b : \sum_{\text{active reservations of } b} \text{amount} \leq \text{h\_limit}(b)
$$

これを **数値演算ではなく原子的 SQL** で構造保証する。`reserveH` の中核は次の一文に集約される。

```sql
UPDATE Participants
   SET h_used = h_used + ?
 WHERE bank_id = ?
   AND is_active = 1
   AND (h_used + ?) <= h_limit
```

`WHERE` 句に `(h_used + ?) <= h_limit` を含めることで、上限超過時には UPDATE が `changes = 0` となり、`h_used` は変化しない。並行する複数の `reserveH` 呼び出しが競合した場合も、SQLite の一文 UPDATE は原子的なため、各呼び出しは順次直列化される。**「読み取って判定して書く」TOCTOU パターンを完全に回避** している点が要諦である。

### 6.4 取消・解放の安全性

`releaseH` は次の二文バッチで実行される。

```sql
-- (1) 解放フラグを立てる（is_released=0 ガードで二重解放を防止）
UPDATE HReservations SET is_released = 1, released_at = ?
 WHERE reservation_id = ? AND is_released = 0;

-- (2) 上の (1) が成功した場合のみ h_used を減算（EXISTS 句で連動）
UPDATE Participants
   SET h_used = CASE WHEN h_used < ? THEN 0 ELSE h_used - ? END
 WHERE bank_id = ?
   AND EXISTS (
     SELECT 1 FROM HReservations
      WHERE reservation_id = ? AND is_released = 1 AND released_at = ?
   );
```

`CASE WHEN ... THEN 0` の床保護は、想定外の不整合時にも `h_used` が負値（unsigned 整数では巨大値）になる事故を避けるための防御策である。同時に、活性予約が残っているのに `h_used` が 0 にクランプされた場合は警告ログを出す（`src/zc/h_model.ts` lines 204–220）。

### 6.5 HIGH_VALUE レーンの除外

HIGH_VALUE レーンは H モデルを経由しない。これは「中央銀行 RTGS は即時グロス決済であり、DNS ネッティングのリスク管理枠を消費しない」という業務規範の表現である。代わりに、HIGH_VALUE は BOJ プレファンド残高を直接チェックする（次章）。除外を **状態機械の経路** として表現（`PRECHECKED → DECIDED_TO_SETTLE` 直行を遷移表で許可）することで、コードベース全体に "if lane == HIGH_VALUE then skip H" のような分岐を散らさずに済む。

---

## 7. 銀行台帳のゼロサム仕訳

### 7.1 勘定体系

参照実装の銀行台帳は、各参加銀行ごとに次の勘定種別を持つ。

| 種別 | 例 | 役割 |
| --- | --- | --- |
| `SAVINGS` | 顧客口座 | 利用者の預金残高 |
| `SUSPENSE` | `{bankId}0000000` | 別段預金。実行中の取引を一時的に保留 |
| `SETTLEMENT` | `{bankId}-ZCS` | 銀行内決済勘定（Zenith Coordinator Settlement） |
| `BOJ` | `{bankId}-BOJ` | 中央銀行当座勘定 |
| `ASSET` | `{bankId}-CASH` | 現金勘定 |

BOJ 勘定は会計上の「中央銀行への預け金」であり、本実装では負債側のサイン規約で **負値** として保持する。たとえば 1,000 万円のプレファンドを行った銀行は `BOJ` 勘定残高 `-10,000,000` を持つ。

### 7.2 ゼロサム仕訳の強制

`bank/ledger.ts#insertJournalGroup` は、複数仕訳エントリを一つの `tx_group_id` の下にまとめ、合計がゼロでなければ INSERT 以前に例外を投げる。

```typescript
export async function insertJournalGroup(
  db: D1Database, input: JournalGroupInput,
): Promise<void> {
  const sum = input.entries.reduce((s, e) => s + e.amount, 0)
  if (sum !== 0) {
    throw new Error(`Zero-sum violation: SUM(amount)=${sum} for group=${input.txGroupId}`)
  }
  await db.batch(input.entries.map(e => db.prepare(`
    INSERT INTO BankJournals (
      journal_id, bank_id, account_id, amount, tx_type,
      txid, tx_group_id, description, value_date, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(...)))
}
```

これにより、銀行台帳には次の不変条件が機械的に成立する。

| 不変条件 | 強制方法 |
| --- | --- |
| グループ内ゼロサム | INSERT 前のチェック（上記） |
| 行内ゼロサム | テストで全レーンについて検証 |
| BOJ 系全行ゼロサム | テストで検証 |

### 7.3 典型的な仕訳例：EXPRESS 一件

EXPRESS レーン一件（銀行 A から銀行 B へ X 円送金）が SETTLED まで到達する場合、銀行台帳に書き込まれる仕訳は概ね次のとおりである。

**フェーズ 1：支払側借記（execute-debit）**
```
Suspense(A): +X     tx_type='EXECUTE', tx_group_id='EXECUTE-DEBIT-{txid}'
Customer(A): -X
```

**フェーズ 2：受取側貸記（execute-credit）**
```
Customer(B): +X     tx_type='CREDIT', tx_group_id='SETTLE-CREDIT-{txid}'
ZCS(B):      -X
```

**フェーズ 3：DNS 清算（後述）**
```
（A 側：仕向超過分を別段から ZCS へ移す）
Suspense(A): -X     tx_type='SETTLE', tx_group_id='DNS-SETTLE-{cycle}-A'
ZCS(A):      +X

（A・B 各々：ZCS と BOJ を相殺）
ZCS(A):      -X     tx_group_id='DNS-BOJ-{cycle}-A'
BOJ(A):      +X
ZCS(B):      +X     tx_group_id='DNS-BOJ-{cycle}-B'
BOJ(B):      -X
```

最終的に、各銀行内の全勘定の合計はゼロ、システム全体の BOJ 残高の合計もゼロを保つ。これが「BOJ プレファンドを介した行間決済が、貨幣総量を保存する」ことの実装上の表現である。

### 7.4 二重着金事故からの学び

過去に検出された代表的バグとして、「`onPayeeExecConfirmed` が無条件に銀行側 `credit-notify` を呼び、その銀行ハンドラがもう一度 `Customer(+)/ZCS(-)` を仕訳していた」事象がある。EXPRESS / STANDARD / HTLC / HTLC_AUTH / HIGH_VALUE / BULK の全レーンで payee が **二倍着金** していた。

これは状態機械単体テストでは検出されなかった。なぜなら、状態は正しく `SETTLED` に到達するためである。検出したのは、レーン横断の **残高インバリアント統合テスト**（`test/integration/balance_invariants.test.ts`）で、「payee 顧客 Δ = +amount」「行内ゼロサム」のいずれかが破れたためであった。修正は「`bankCreditNotify` を仕訳しない通知層に変更（`BankAuditLog` への記録のみ）」であり、仕訳は `execute-credit` 経路に一本化された。

この経験から、現在は **「状態機械が正しい」と「仕訳まで合っている」を別レベルの不変条件として両方検証する** ことを設計規約としている。

---

## 8. DNS 清算サイクル

### 8.1 サイクルの状態機械

日次ネット清算（DNS）サイクルは、次の状態を持つ独自の小さな状態機械である。

```
OPEN ── kickDns ──→ KICKED ── settleDns ──→ SETTLED
  │                    │
  └───── holdDns ──────┴─────────────────→ HOLD_ACTIVE
```

サイクル ID は `DNS-{YYYY-MM-DD}` を基本形とし、SETTLED 済みのサイクルに対する遅着取引については `DNS-{YYYY-MM-DD}-{HHmmss}` でサフィックス付きの新サイクルを生成する。`DnsCycles.business_date` は UNIQUE 制約を持たない（マイグレーション 0012 で意図的に外した）ため、同一営業日に複数サイクルが並存できる。

cron で `30 7 * * *`（UTC 07:30 = JST 16:30）に自動 kick する設定を参照実装に同梱している。

### 8.2 三相清算

`settleDns` は三相に分かれる。

**第 1 相：BOJ プレファンド検証**

支払超過（`net_position < 0`）の銀行ごとに、BOJ 勘定残高をチェックする。BOJ 残高は負値（負債側）で保持されるため、不足判定式は次のとおりである。

```typescript
if (bojBalance + requiredDebit > 0) {
  // ↑ 負の BOJ 残高に正の借記を足してプラスに転じれば不足
  await transitionDnsToHold(cycleId, shortfallDetails)
  return
}
```

例：BOJ 残高 `-1,000,000`、必要借記 `900,000` → `-1,000,000 + 900,000 = -100,000 ≤ 0` → 充足。逆に必要借記 `1,100,000` → `+100,000 > 0` → 不足。サイクルは `HOLD_ACTIVE` に遷移し、`hold_reason` に不足明細を JSON で記録する。

**第 2 相：別段からの精算**

各支払側銀行について、サイクル内仕向総額（`gross_send`）相当を別段預金から ZCS へ移す。

```
Suspense(B): -gross_send     tx_group_id='DNS-SETTLE-{cycle}-{bank}'
ZCS(B):      +gross_send
```

**第 3 相：BOJ 清算**

各銀行について、ZCS と BOJ を相殺する。

```
ZCS(B): -(gross_send − gross_receive)     tx_group_id='DNS-BOJ-{cycle}-{bank}'
BOJ(B): +(gross_send − gross_receive)
```

第 3 相完了後、各銀行の ZCS 勘定残高は 0、BOJ 勘定残高は「日次ネット差額分だけ動いた」状態となる。システム全体での BOJ 残高合計はサイクル前後で不変（ゼロサム）である。

### 8.3 H 予約の解放と FinalityLog 連携

清算完了時、サイクルに紐付く全 H 予約を解放する。

```sql
SELECT h.reservation_id
  FROM HReservations h
  JOIN Transactions t ON t.h_reservation_id = h.reservation_id
 WHERE t.dns_cycle_id = ?
   AND h.is_released = 0
```

これらを `releaseH` で順次解放する。同時に、サイクル全体に対する `GtidTransactions` レコードを `state='GT_SETTLED'` で作成し（`GTID-DNS-{cycle_id}`）、FinalityLog の GTID 系チェーンとして DNS イベントを連鎖させる。これにより、後日「あの日の清算で何が起きたか」を単一の `gtid` で照会できる。

### 8.4 危機対応の制度化

`igs_mode` 列（`NORMAL` / `STOP` / `RINGFENCED` / `RINGFENCED_PLUS`）は、DNS HOLD 時に IGS（即時グロス清算）を段階的に絞り込む運用状態を表現する。本参照実装では `NORMAL ↔ STOP` のみを実装しており、`RINGFENCED` 系列の階層遷移、原因行集合の管理、`dns_recovery_reserve` 算定、`igs_throttle_budget` による公平性制御は方式仕様に記載されつつ未実装である。これは「危機対応は例外パスではなく、制度化された状態遷移として扱う」という設計規範の延長線上で、今後実装を進めるべき領域である。

---

## 9. 非同期処理基盤

### 9.1 キューと冪等性

レーン横断の状態前進と銀行呼出は非同期で実行される。キュー消費の中心は `src/zc/orchestrator.ts#processQueueMessage` で、メッセージ型 `type` で次の処理を選択する。

| メッセージ型 | 役割 |
| --- | --- |
| `ZC_BANK_RESERVE` | HTLC ロック時の H 予約と銀行 reserve-funds |
| `ZC_BANK_DEBIT` | a 経路：銀行 execute-debit |
| `ZC_BANK_CREDIT` | b 経路：銀行 execute-credit |
| `ZC_BANK_LEG_READY` | GTID レッグごとの ready-check |
| `ZC_STATE_ADVANCE` | STANDARD / HIGH_VALUE / BULK の `advance*` 呼出 |

冪等性は二層で確保する。

- **協調層側**：`IdempotencyKeys` テーブルにキーと結果を保存。同一キーの再送は前回結果を返す。
- **銀行側**：`ZcRequests` テーブル（銀行ローカル）に `request_id`（例：`DEBIT-{txid}`）と結果をキャッシュ。DONE 状態の `request_id` 再受信時は前回 `response_body` を返す。

銀行側のキャッシュは協調層側のリトライによる「同じ命令の複数回到達」を冪等に吸収する。

### 9.2 構造化エラーとリトライ判定

協調層は `DomainError` クラスを横串で使い、エラーの分類（`category`）でキューのリトライ判定を行う。

```typescript
type ErrorCategory =
  | 'DOWNSTREAM' | 'TIMEOUT' | 'RATE_LIMIT'       // → msg.retry()
  | 'VALIDATION' | 'CONFLICT' | 'INVARIANT'       // → msg.ack()
  | 'INTERNAL'   | 'NOT_FOUND' | 'AUTH'           // → msg.ack()

function dispatchDecision(err: unknown): 'retry' | 'ack' {
  return !isDomainError(err) || isRetryable(err.category) ? 'retry' : 'ack'
}
```

「業務ルール由来の失敗」（限度超過、状態不整合、検証エラー）は `ack` してエスカレーションへ。「外部系の一時障害」はリトライ。`DomainError` でない `throw`（想定外）は安全側に倒してリトライ。これにより「失敗のリトライしてよい/だめ」がエラーコード上で一意に決まり、運用者がメッセージごとに判断する負担を消す。

### 9.3 銀行呼出のサーキットブレーカ

特定の銀行が応答不能になった場合に、ヘルスチェックを兼ねたサーキットブレーカで隔離する。状態機械は次の三状態である。

```
CLOSED ── 連続 5 失敗 ──→ OPEN ── 30 秒経過 ──→ HALF_OPEN
  ↑                         ↑                       │
  └──── 任意の成功 ─────────┴──── 任意の失敗 ──────┘
                            (HALF_OPEN 中は最大 3 並列の試行のみ許容)
```

具体的なパラメータ（`src/zc/circuit_breaker.ts`）：

```typescript
const FAILURE_THRESHOLD     = 5
const OPEN_DURATION_MS      = 30_000    // 30 秒
const MAX_HALF_OPEN_PROBES  = 3
```

`CircuitBreakerState` テーブルに各銀行ごとの状態と総計（`total_requests`, `total_successes`, `total_failures`, `total_denied`）を保持し、運用ダッシュボードからの可観測性も同時に提供する。OPEN 状態の銀行へのリクエストは協調層側で `CIRCUIT_OPEN` 応答に即時短絡し、銀行側の追加負荷を避ける。

### 9.4 タイムアウト掃引

cron `* * * * *`（毎分）で `sweepTimeouts` を起動し、次の閾値で吊られた取引を救う。

```typescript
TIMEOUT_T2_EXEC_SEC          = 300    // DECIDED_TO_SETTLE → a まで 5 分
TIMEOUT_T3_PAYEE_PROOF_SEC   = 300    // a → b まで 5 分
TIMEOUT_SUSPENDED_TO_FAILED_SEC = 3600 // SUSPENDED → FAILED_EXECUTION まで 1 時間
TIMEOUT_GTID_STALLED_SEC     = 600    // GT_DECIDED_TO_SETTLE 停滞 10 分
```

タイムアウト発火は `SUSPENDED` 経由で `FAILED_EXECUTION` に収束させ、独立した `CASE` を起票して運用者の照会導線につなぐ。

---

## 10. 運用上の安全装置

### 10.1 高額即時自動エスカレーション

利用者または参加行が `EXPRESS` / `STANDARD` を指定して送金しても、金額が閾値以上であれば協調層は受付時点で `lane` を `HIGH_VALUE` に書き換える。閾値は次の優先順位で解決される。

```typescript
const DEFAULT_HV_THRESHOLD = 100_000_000  // 1 億円
const hvThreshold = participant?.hv_threshold
  ?? (env.ZC_HV_THRESHOLD ? parseInt(env.ZC_HV_THRESHOLD, 10) : null)
  ?? DEFAULT_HV_THRESHOLD
```

これは「即時性 vs リスク統制」のトレードオフを **制度規範として統制側に倒す** 判断であり、ユーザーの意図に依存しない。`FinalityLog` の `PaymentInitiated` イベントには **書換え後の lane** が記録されるため、後日の説明性も保たれる。API 仕様には「lane の書換え可能性」が明記されている。

### 10.2 HMAC 署名

協調層と銀行のあいだは HMAC-SHA256 で署名する。Web Crypto API を使い、秘密鍵は `crypto.subtle.importKey` 結果を `Map<secret, Promise<CryptoKey>>` でキャッシュする。

```typescript
async function signPayload(payload: unknown, secret: string): Promise<string> {
  const msgData = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload))
  const cryptoKey = await getHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData)
  return bufToHex(sig)
}
```

ヘッダは `X-ZC-Signature`、検証側は **定数時間比較** を採用してタイミング攻撃を避ける。

```typescript
let result = 0
for (let i = 0; i < expected.length; i++) {
  result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
}
return result === 0
```

なお、本参照実装はあくまでモックであり、実運用には TLS/mTLS、認証認可、秘密鍵ローテーション、保存時暗号化など別途必須の整備項目がある。

### 10.3 FATF R.16 ワイヤートランスファ規則

クロスボーダー送金については、FATF R.16 に従い発信人・受取人情報の完全性をプレチェック段階で検証する。閾値は次のとおり。

```typescript
export const FATF_THRESHOLD_JPY = 150_000  // ≒ 1,000 USD 相当
```

情報不備の送金は `FATF_VALIDATION_ERROR` として水際で拒否する。これは「コンプライアンスを下流（事務）で吸収する」のではなく「上流（基盤）で強制する」という設計選択である。

---

## 11. 検証アプローチ

### 11.1 三層の検証

参照実装は次の三層で品質を担保する。

| 層 | 対象 | 検証方法 | 規模 |
| --- | --- | --- | --- |
| 静的解析 | コーディング規約 | 正規表現走査 | 1 ファイル |
| 単体テスト | 各モジュール | Vitest + better-sqlite3 | 27 ファイル |
| 統合テスト | レーン横断 | Vitest + 全レーンシナリオ | 3 ファイル |

合計 30 ファイル、7,886 行のテストコード。テストは better-sqlite3 を D1 のインメモリモックとして用い、本物のスキーマ（21 マイグレーション・28 テーブル）に対して並行処理・冪等再送・ゼロサム残高不変条件・サーキットブレーカ復帰などを統合的に検証する。

### 11.2 静的解析による規約強制

`test/zc/lane_invariants.test.ts` は `src/zc/lanes/` 配下を正規表現で走査し、次を機械検出する。

| 検出パターン | 違反内容 |
| --- | --- |
| `UPDATE\s+Transactions\s+SET\s+state` | 状態 UPDATE の生発行（`transitionWithLog` 回避） |
| `INSERT\s+INTO\s+Transactions` | 取引 INSERT の生発行（`insertTxWithLog` 回避） |
| ヘルパインポートの欠落 | `_helpers` を import せずに状態を扱うレーン |
| FinalityEventType union 未登録のイベント名 | スキーマ外の event_type 発行 |

これにより「将来の改修で誰かが状態機械を回避する」事故を、コードレビューではなく仕組みで防ぐ。

### 11.3 残高インバリアントの統合テスト

`test/integration/balance_invariants.test.ts`（649 行）は、各レーンについて取引一件をエンドツーエンドで実行し、キュー消費まで完了させたうえで、銀行台帳に対して次の四条件を全件検証する。

```
(I-1) Δ(payer customer)  = -amount
(I-2) Δ(payee customer)  = +amount
(I-3) Σ(journals | bank) = 0     ∀ bank
(I-4) Σ(BOJ | all banks) = unchanged
```

カバーするケース：

| ケース | 検証目的 |
| --- | --- |
| EXPRESS | 同期完結フロー |
| STANDARD | 顧客最終認可を経由する非同期フロー |
| BULK | DNS 清算経路 |
| HIGH_VALUE | H スキップと RTGS 経路 |
| HTLC | hashlock + timelock |
| HTLC_AUTH | 受取側起点オーソリ |
| GTID 1×1 | 1 対 1 マルチレグ |
| GTID 2×2 逆順 | PAYEE 挿入順を意図的に逆転（取り違い検出） |

GTID 2×2 逆順ケースは、過去に「PAYEE が `leg_id` 昇順以外で挿入されると、PAYER↔PAYEE のペアが取り違わって誤った銀行に着金する」バグを検出したケースである。修正後は `payerLegs` / `payeeLegs` を `leg_id` でソートし、同じ index で組む規約を採用した。

### 11.4 ハッシュチェーン検証テスト

`test/zc/finality_chain.test.ts`（294 行）は次を検証する。

- 各エントリの `entry_hash` が `canonicalize()` の SHA-256 と一致
- `prev_hash` が直前エントリの `entry_hash` と一致
- 最初のエントリの `prev_hash` が `GENESIS` 定数
- 中間エントリの `entry_hash` を意図的に改竄した場合、`verifyChain` が `{valid: false, break_at_seq, ...}` を返す

### 11.5 並行処理テスト

`test/zc/lane_helpers.test.ts`（478 行）と `test/zc/atomic_finality.test.ts`（326 行）は、`transitionWithLog` の並行安全性を検証する。

- N 並列で同一遷移を試行 → `applied: true` を返すのは最大 1 本
- バッチ内のいずれかの文が失敗 → 全体ロールバック（CAS UPDATE も無効化、FinalityLog INSERT も無効化）
- `cancelInFlightTx` で取消側と Decision 側が競合 → どちらか一方が成功し、H 解放はその結果に整合
- `sideUpdates` の副台帳 UPDATE が正準 CAS と同じ運命をたどる

これらの並行テストは、CAS とバッチの組み合わせが本当に時間窓ゼロを実現していることの実装上の裏付けである。

---

## 12. 設計上の選択と限界

### 12.1 単一データベース前提

本設計は協調層の中核データ（`Transactions`, `FinalityLog`, `HReservations`, `HtlcContracts`, `GtidLegs`, `DnsCycles`, …）を **単一データベース** に同居させ、`db.batch()` を「複数の文を一つのトランザクション境界に乗せる」プリミティブとして利用している。これにより CAS UPDATE と FinalityLog INSERT を一括コミットでき、本稿の中核主張が成立する。

逆に言えば、本設計を地理分散の複数 DB に直接展開する場合、これらを跨ぐ二相コミットや Saga パターンが必要となる。Cloudflare D1 は本稿執筆時点で単一リージョン書き込みを基本とするため、グローバル分散書き込みが要件となる場合は別アーキテクチャ（Raft / Spanner 系）を検討する必要がある。本設計は **論理単一性** を達成しており、物理分散はその上に乗る独立した話題である。

### 12.2 実装が未到達な規範要件

仕様には記述されているがコードに反映未済の要件が複数残っている（`specs/architecture.md` § 7）。

- DNS HOLD の `igs_mode` 階層遷移（`RINGFENCED` / `RINGFENCED_PLUS`）と公平性制御
- `H_locked` の自動解放経路（長期詰まりの救済）
- `MisrecordCorrected`（協調層障害による誤記録の訂正）
- Bulk レーンの LSM（Liquidity Saving Mechanism）最適化
- GTID の N:M fan-in / fan-out

これらは方式仕様には記述されているが、参照実装としては最小限の動作を優先しており、本格運用には追加実装が必要である。

### 12.3 セキュリティ・運用基盤

参照実装は次を範囲外とする。

- TLS / mTLS、認証・認可、秘密鍵ローテーション
- 保存時暗号化、PII の保護階層
- 規制適合のためのコンプライアンス制御
- ハッシュチェーン定期検証 cron（現状は API 経由でのみ実行）
- OpenAPI YAML の自動生成（現状は手書き）

これらは本番運用化の際に必須となるが、本稿の主題（協調層の論理設計）とは独立した整備項目として切り分けている。

### 12.4 性能特性

本参照実装は性能ベンチマーク取得を主目的とせず、Cloudflare Workers の開発環境での動作確認に留まる。本設計の主要な追加コストは、状態遷移ごとに `FinalityLog` への INSERT が同一バッチで発行されるため、状態遷移あたりのデータベース書き込み件数が概ね 2 倍（`Transactions` UPDATE + `FinalityLog` INSERT）になることである。副台帳を持つレーン（HTLC, GTID）ではさらに 1 件追加される。D1 / SQLite のバッチ書き込みは単一トランザクション内で処理されるため、ネットワーク往復は 1 回に留まる。

本設計の対象ワークロード（金融機関間決済）における取引レートを想定すると、この追加コストは説明可能性のリターンに対して支配的にはならない、という設計判断である。本格的なベンチマーク（スループット、p99 レイテンシ、CAS 競合率、バッチサイズと原子性のトレードオフ）の取得は今後の課題である。

### 12.5 隣接層との関係

最後に、本設計の社会的位置付けを率直に述べる。本設計は **協調層** であり、**貨幣の表現形式** や **共通台帳の構造** といった下層の再設計（トークン化預金、ホールセール CBDC、共通台帳プラットフォーム）と同じ層を取り合わない。下層が現行の商業銀行貨幣か CBDC か、台帳が伝統的か DLT かに関わらず、その上に被さる協調・説明可能性層のリファレンスとして機能することを意図している。両者は競合ではなく、隣接する層を分担する関係にある。

---

## 13. むすび

本稿では、伝統的決済レーンと暗号学的ファイナリティ原語を、「橋」ではなく「同一の状態機械上の対等なレーン」として表現する協調層アーキテクチャを、参照実装の具体的なコード・SQL・数値とともに詳述した。

中核となる三つの設計判断は次のとおりである。

1. **単一遷移表**：14 状態 8 レーンを正準的な `ALLOWED_TRANSITIONS` リテラルに統合し、レーン独自の状態機械を禁ずる。新規レーン追加時の規約は表へのエントリ追加のみ。
2. **アトミック対化**：状態 CAS と監査ログ INSERT を `db.batch()` の単一バッチで発行し、「状態は進んだが監査がない」時間窓を構造的に排除する。
3. **ハッシュチェーン**：FinalityLog をパイプ区切り正準形 + SHA-256 で連鎖させ、事後改竄を機械的に検出可能にする。

これらを支える周辺機構として、三状態 H モデルによる仕向超過限度の構造的不可超過、ゼロサム強制の銀行台帳、三相 DNS 清算、構造化エラーに連動するキュー・リトライ・サーキットブレーカ機構を提示した。

参照実装と全文書は MIT ライセンスで `pochatt/zenith-payment-system` に公開されている。本稿は完成品の発表ではなく、議論の叩き台として、現場のエンジニアが業務システムに持ち帰り、自らの文脈で再評価・再実装するための素材を提供することを意図したものである。

---

*本稿および参照実装はフィクションであり、実在のいずれの組織・システム・運用も示していません。記述は参照実装に基づきますが、実プロダクション運用を意図したものではありません。*
