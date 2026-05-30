# Zenith Payment System

> 決済を「ブラックボックス」ではなく、「**説明できる状態の連なり**」として扱うための、共通基盤の参照実装です。
> — Zenith 構想より

---

## 日本語

### この文書について

このリポジトリは、**Zenith Coordinator（ZC）** という構想の参照実装です。かつて銀行のなかで決済の制度・サービス企画と政府渉外（規制当局・関係省庁との対話）に携わり、現在はまったく異なる仕事をしている個人が、**機密資料は一切用いずに**、「こうした基盤があれば、日本の決済はもう一段上に行けるかもしれない」という願いから、基本コンセプトを書き起こしたものです。

「決済を説明可能な状態機械として扱う」という設計思想を一貫して通し、TypeScript と Cloudflare Workers のうえで最後まで動くところまで実装してあります。趣味で書いたものなので、現実のいずれの組織・システム・運用も示していません。

→ 構想の全体像：[Zenith 構想・基本コンセプト](https://www.sakuolia.jp/zenith.html)

### なぜ作ったのか

日本の決済システムは、世界水準で見ても堅牢で、長く安定して動いてきました。一方で、利用者の側から眺めたときの **「いま、自分のお金がどこにあるのか」「なぜ遅れているのか」「誰に聞けば分かるのか」** という説明可能性には、まだ伸びしろがあるように感じています。

Zenith は既存のレールを置き換えるものではありません。各金融機関の勘定系と口座管理はこれまで通りに置いたまま、**その「間」で起きていることを、後からでも同じ取引番号で誰にでも説明できる**ようにする協調層を、社会の共有物として描き直す試みです。そして、それを読み物だけでなく **手で触れて動かせる形** にしてあります。

### 30 秒で伝わる例（電気代の口座振替で残高不足）

| | いまの体験 | Zenith があると |
| --- | --- | --- |
| 失敗に気づくまで | ハガキが届くまで（数日） | 数秒で利用者・事業者の双方に同じ通知 |
| 失敗 → 成立まで | 約 16 日 | 数時間 |
| 問い合わせ | 各自が状況を別々に再構成 | 全員が同じ取引番号・同じ時刻・同じ理由コードを見る |

派手な革新ではなく、**ただ「説明できる状態の連なり」がそこにある**だけ。詳細は [`specs/walkthrough.md`](specs/walkthrough.md)（5 分）。

### このシステムは何をするか・何をしないか

- **すること**：複数の銀行間の決済を、**受理 → Decision（決定）→ Execution（実施確認）→ b（確定）** という状態の連なりに固定し、すべての状態遷移を追記専用の FinalityLog に記録する。利用者・事業者・当局のいずれにも、同じ取引番号で同じ説明を返す。
- **しないこと**：参加者の勘定系・口座管理を置き換えない。本人確認・与信・限度管理は各参加主体の裁量。法的判断は行わない。

### 設計思想・10 箇条の要点

1. 唯一の正は **Finality Log**。派生ビューは捨てて再構築できる。
2. **Decision と Execution は必ず分離** する。
3. 不可逆境界は原則 **b（PAYEE_EXEC_CONFIRMED）**。b 後の救済は Reversal（別取引）として扱う。
4. **説明できない状態は禁止**。未決・不整合は必ず CASE へ収束させる。
5. 同期応答の意味は契約で固定する。
6. 証跡は後付けしない。
7. レーンは UX 区分ではなく、**確定点と証跡の契約**。
8. **H（仕向超過限度）は状態として管理** し、絶対超過を許さない。
9. 危機対応は例外ではなく **制度化された状態遷移** として扱う。
10. 単一正本性は分散合意ログで担保し、不確定時は Read-only へ縮退する。

詳細は [`specs/zenith_public.md`](specs/zenith_public.md)。

### 同じ語彙で TradFi と DeFi を語る

Zenith は、伝統的決済レール（RTGS、DNS ネッティング、全銀系リテール、ISO 20022、FATF R.16）と新しい原始要素（ハッシュタイムロック、原子マルチレグ）を、**橋渡し（bridge）ではなく、同じ状態機械のうえに並ぶ対等なレーン** として扱います。

| レーン | 出自 | ファイナリティ原始要素 |
| --- | --- | --- |
| EXPRESS / STANDARD / BULK | 伝統系（リテール、全銀系） | H 予約 + ネッティング |
| HIGH_VALUE | 伝統系（中央銀行 RTGS） | 即時グロス決済 |
| DNS サイクル | 伝統系（清算機関） | 日次ネットポジション |
| HTLC / HTLC_AUTH | DeFi ネイティブ | ハッシュロック + タイムロック |
| GTID | ハイブリッド（原子マルチレグ） | レッグ横断 all-or-nothing |
| RTP | ハイブリッド（受取人発起プル） | 名義確認 + 事前承認 |

公開されている先行研究（BIS Project Stella、Jasper-Ubin、Agorá、mBridge、Partior、Fnality、JPM Onyx、Canton Network、DCJPY / Progmat など）の多くは、**通貨そのもの**（ホールセール CBDC、トークン化預金）や **共通台帳の構造** を問い直す、決済の **下層** の研究です。Zenith はその逆で、現行の商業銀行貨幣と既存の銀行勘定を前提に、その **上に被せる調整層** を設計します。競合ではなく、隣り合う層の話です。

そのうえで Zenith が公開文献の範囲で先行していると考えられるのは、次の三点に絞られます。

- **HTLC・GTID 原子マルチレグ・RTGS・DNS ネッティングを、橋渡しではなく、ひとつの状態機械の対等なレーンとして並べたオープンソース実装。**
- **状態遷移と FinalityLog 書込みのアトミック強制、および単一 trace ID による生涯トレース。**
- **DNS_HOLD 時の流動性供給カスケードを、コードと同じ温度の規程文書として書き切った点**（[`specs/zenith_policy.md`](specs/zenith_policy.md)）。

逆に、トークン化預金・ホールセール CBDC、クロスボーダー多通貨原子決済、プライバシー原始要素（ZKP）、agent identity などは、各国 CBDC プロジェクトの主戦場であり、Zenith は **同じ層を取り合わない** 設計選択をしています。実装は [`src/zc/orchestrator/state_machine.ts`](src/zc/orchestrator/state_machine.ts) と [`src/zc/lanes/`](src/zc/lanes/) を参照。

> **補論：状態機械と許可型台帳の同型性。** Zenith を分解すると、許可型ブロックチェーン（特に許可型 EVM 系）と **構造的にほぼ同型** です。根に **追記専用ログ + 明示的な状態機械 + 状態遷移のアトミック性** という同じ三点セットがあるためです。
>
> | Zenith | 許可型 EVM チェーン |
> | --- | --- |
> | FinalityLog（`prev_hash` チェーン） | 正準チェーン |
> | `ALLOWED_TRANSITIONS` | Solidity の状態遷移 |
> | `transitionWithLog`（CAS + ログ INSERT のバッチ） | EVM トランザクション |
> | レーン（EXPRESS / HTLC / GTID …） | コントラクトファミリー |
> | H-Model（予約・確定・解放） | ERC-20 + allowance |
> | `version` 列（楽観ロック） | nonce / sequence |
> | 冪等キー | トランザクションハッシュの一意性 |
> | `Participants` | バリデータ allowlist |
>
> 示唆はひとつ。**下層通貨をパブリックチェーンに wrap する（Lock & Mint）のと、発行主体が自前で許可型チェーンを立てるのは、難易度の方向が逆** だということです。前者はファイナリティ不整合とブリッジ保管リスク（Ronin・Wormhole・Nomad）という立法では消せない問題を抱える。後者は既存 RTGS の責務をチェーン状元帳に置き直す純粋な設計問題に閉じ、EVM 互換性すら本質ではない（**ファイナリティ・原子性・監査性は EVM と独立に成立する**）。Zenith の状態機械と FinalityLog は、その「EVM と独立な核」を TypeScript と D1 で実装したものです。これは CBDC 基盤を目指す宣言ではなく、**設計の語彙が上下方向に互換である**ことの確認です。

### 「制度」として書かれている部分

このリポジトリの特色は、コードや方式設計と並んで、**制度（規程・ガバナンス）の文書を同じ語彙・同じ温度で書いている** ことです。4 眼承認・ブレークグラス、利用目的コード（P01〜P07）と最小化原則、DNS_HOLD 時の初動連絡・公表統制・LPB（流動性供給銀行）スキーム・共同拠出・最終的な中央銀行手当の発動順序、WORM 保全と第三者保証──これらを [`specs/zenith_policy.md`](specs/zenith_policy.md) に集約しています。技術仕様だけでは決済は社会に着地しないため、制度面まで同じ姿勢で書き切ることを大切にしました。

### 触れてみる

必要なもの：Node.js 18+ / npm 8+ / Cloudflare アカウント（無料枠で動作）。

```bash
# ローカル
git clone https://github.com/pochatt/zenith-payment-system.git
cd zenith-payment-system
npm install
npm run db:migrate:local
npm run dev          # http://localhost:8787（ルートがダッシュボード）

# Cloudflare へデプロイ
npx wrangler login
npx wrangler d1 create zenith-db
npx wrangler queues create zenith-mock-queue
npx wrangler r2 bucket create zenith-mock-r2
cp wrangler.toml.example wrangler.toml   # database_id 等を埋める
npm run db:migrate:remote
npm run deploy
curl -X POST https://<your-worker>.workers.dev/internal/seed
```

```bash
npm run dev               # ローカル開発サーバー
npm run deploy            # Cloudflare へデプロイ
npm run type-check        # TypeScript 型チェック
npm run test              # テストスイート（473 ケース）
npm run db:migrate:local  # ローカル D1 にマイグレーション
npm run db:migrate:remote # リモート D1 にマイグレーション
```

### 状態機械（中核）

```typescript
// src/zc/orchestrator/state_machine.ts
const ALLOWED_TRANSITIONS = {
  RECEIVED:               ['PRECHECKED', 'HTLC_LOCKED', 'DECIDED_CANCEL'],
  PRECHECKED:             ['PRECHECKED_SUSPENDED', 'H_RESERVED', 'DECIDED_CANCEL', 'DECIDED_TO_SETTLE'],
  PRECHECKED_SUSPENDED:   ['PRECHECKED', 'DECIDED_CANCEL'],
  H_RESERVED:             ['DECIDED_TO_SETTLE', 'DECIDED_CANCEL'],
  DECIDED_TO_SETTLE:      ['PAYER_EXEC_CONFIRMED', 'PAYEE_EXEC_CONFIRMED', 'SUSPENDED'],
  DECIDED_CANCEL:         ['CANCELLED'],
  PAYER_EXEC_CONFIRMED:   ['PAYEE_EXEC_CONFIRMED', 'SUSPENDED'],
  PAYEE_EXEC_CONFIRMED:   ['SETTLED'],
  SUSPENDED:              ['PAYER_EXEC_CONFIRMED', 'PAYEE_EXEC_CONFIRMED', 'FAILED_EXECUTION'],
  HTLC_LOCKED:            ['HTLC_FULFILL_REQUESTED', 'DECIDED_CANCEL'],
  HTLC_FULFILL_REQUESTED: ['DECIDED_TO_SETTLE', 'FAILED_EXECUTION'],
  // 終端: SETTLED, FAILED_EXECUTION, CANCELLED
}
```

すべての状態遷移は `transitionWithLog` ヘルパを通り、`Transactions` への CAS UPDATE と `FinalityLog` への INSERT を 1 つの D1 バッチでアトミックに発行します。FinalityLog はハッシュチェーン（`prev_hash`）で改ざん耐性を持ち、日次 cron で全チェーンを自動監査し、断絶を検知したら CASE へ収束させます。**「状態だけ進んで監査ログが残らない窓」は構造的に存在しません。**

### API のかたち（最小例）

```bash
# 送金の起票
POST /api/transfers
{ "lane": "EXPRESS", "amount": { "value": 5000, "currency": "JPY" },
  "payer": { "bank_id": "001", "account_hash": "h:..." },
  "payee": { "bank_id": "002", "account_hash": "h:..." } }

# 取引の照会（誰が照会しても、同じ取引番号で同じ説明が返る）
GET  /api/transactions/TX-...
GET  /api/transactions/TX-.../verify   # FinalityLog ハッシュチェーン検証
```

全エンドポイントは [`specs/api-contracts.md`](specs/api-contracts.md)。

### 主な機能

| レーン | 用途 | ファイナリティ |
| --- | --- | --- |
| EXPRESS | 店舗・即時 | H 予約担保 |
| STANDARD | 通常送金 | 名義確認 + 承認 |
| HTLC | 条件付きエスクロー | ハッシュロック解放 |
| HTLC_AUTH | 受取側起点オーソリ | Capture で b 成立 |
| RTP | 請求型回収 | 受取人発起 |
| GTID | 多者協調 | 全 leg の b 一致 |
| HIGH_VALUE | 高額即時（中銀経由） | RTGS 確定 |
| BULK | 大量バッチ | 日次ネッティング |

横断機能：日次ネット清算（DNS）、限度額直列化（TigerBeetle 流 Durable Object）、ディレクトリ ALS（O(1) エイリアス解決）、ストリーミング・マイクロ決済（Rafiki 流）、QR 決済（HMAC 検証）、エイリアス解決、FATF R.16 クロスボーダー、口座名義確認、EDI／リッチデータ、サーキットブレーカ、**FinalityLog チェーンの日次自動監査（改ざん検知 → CASE）**、SSE イベントストリーム。

### テスト

```bash
npm run test                          # 全 473 ケース
npx vitest test/zc/express.test.ts    # 単一ファイル
```

`better-sqlite3` を D1 のインメモリ・モックとして用い、本物のスキーマに対して並行処理・冪等再送・ゼロサム残高不変条件・サーキットブレーカ復帰・ハッシュチェーン監査などを統合的に検証します。`test/integration/balance_invariants.test.ts` では、各レーンで「payer Δ = −amount」「payee Δ = +amount」「行内ゼロサム」「BOJ 系の保存則」を仕訳まで往復で固定しています。

### 文書地図

**構想（読み物）→ 方式設計 → 制度・ガバナンス → インタフェース／データ** の四層：

- 構想：[Zenith 構想](https://www.sakuolia.jp/zenith.html)、[`specs/walkthrough.md`](specs/walkthrough.md)（5 分）
- 方式：[`specs/zenith_public.md`](specs/zenith_public.md)、[`specs/architecture.md`](specs/architecture.md)
- 制度：[`specs/zenith_policy.md`](specs/zenith_policy.md)
- IF／データ：[`specs/api-contracts.md`](specs/api-contracts.md)、[`specs/schema.md`](specs/schema.md)、[`specs/file_structure.md`](specs/file_structure.md)

### 実装の現状と限界（誠実に）

個人による趣味の参照実装であり、本番運用は意図していません。

- 銀行ーコーディネータ間は HMAC-SHA256 署名検証のみ。TLS / mTLS、認証・認可、保存時暗号化、規制適合は範囲外。
- パフォーマンス値は開発環境の観測値であり、本番保証ではない。
- 一部の規範要件（DNS_HOLD の igs_mode 階層遷移、Bulk LSM の最適化、GTID の N:M fan-in / fan-out など）は方式設計に記述したが実装は道半ば。詳細は [`specs/architecture.md`](specs/architecture.md) § 7。

意図は **実物の代わりではなく、議論のたたき台** を提供することです。とりわけ議論したい問いは三つ：

1. この協調層を **誰が運営** し、既存の全銀ネット・日銀ネットと **どう接続** するのが現実的か。
2. 移行コストを誰がどう負担するか（並行稼働・段階移行の現実解）。
3. 危機時（DNS_HOLD）の流動性供給を、制度としてどこまで自動化し、どこから人の判断にするか。

### 想定する読者・ライセンス・連絡

決済の制度／サービス企画にかかわる方、銀行・決済事業者・SIer のエンジニア、中央銀行・規制当局周辺で説明可能性や監査性に関心のある方、学生・研究者・個人開発者。どなたにも、それぞれの視点で読んでいただけるよう、構想・方式・制度・コードを同じ温度で並べました。

中身はどのような形でお使いいただいても構いません（MIT License、[LICENSE](LICENSE)）。いつかそのプロジェクトが形になったとき、「Zenith を叩き台にした」と一言添えてくださるなら、それで十分です。質問・議論は [GitHub Issues](https://github.com/pochatt/zenith-payment-system/issues) へ。

> このリポジトリと付属文書はフィクションであり、実在のいずれの組織・システム・運用も示していません。

---

## English

### About

A reference implementation of the **Zenith Coordinator (ZC)**: a **coordination layer** that makes inter-bank settlement explicable as a sequence of states recorded in an append-only, hash-chained FinalityLog — **without replacing any bank's core ledger**. Written by an individual who once worked on payment-system planning and government relations in Japanese banking and is now in a different line of work; built from first principles, **no confidential material**, as a personal project. It runs end-to-end on TypeScript + Cloudflare Workers, and represents no real institution, system, or operation.

→ The starting concept: [Zenith concept (Japanese)](https://www.sakuolia.jp/zenith.html).

### Why this exists

Japan's payment systems are robust and have been remarkably stable. What still feels incomplete, from the user's side, is **explicability** — knowing where one's money is, why something is delayed, and who can answer. Zenith does not replace the existing rails; each institution keeps its core banking exactly as today. It reimagines, as a shared public good, the **coordination layer between institutions**, so that whatever happens there can later be explained, by anyone, under a single transaction id — and it is meant to be run and touched, not only read.

**A 30-second example (a household direct debit that fails on insufficient funds):** today, the customer learns of the failure days later by mail and it takes ~16 days to resolve; with Zenith, both customer and biller see the same notification within seconds and it resolves in hours, all reading **the same transaction id, the same timestamps, the same reason code**. See [`specs/walkthrough.md`](specs/walkthrough.md).

### What it does, and does not

- **It does:** treat each settlement as **Acceptance → Decision → Execution → Finality (b)** across banks, recording every transition in an append-only FinalityLog, so users, businesses, and authorities obtain the same explanation under the same id.
- **It does not:** replace participants' core ledgers; decide identity, credit, or limits; or take legal positions.

### Design principles (ten lines)

1. The single source of truth is the **Finality Log**; derived views can be rebuilt.
2. **Decision and Execution are always separated.**
3. The irreversible boundary is **b (PAYEE_EXEC_CONFIRMED)**; remedies after b are Reversals (new transactions).
4. **States that cannot be explained are forbidden** — unresolved states converge into a CASE.
5. The meaning of a synchronous response is fixed by contract.
6. Evidence is never added after the fact.
7. Lanes are **contracts about finality points and evidence**, not UX categories.
8. **H (sending-side over-limit)** is managed as a state; absolute over-limit is impossible by construction.
9. Crisis handling is an **institutionalised state transition**, not an exception path.
10. Single-truth integrity is held by a consensus log; under quorum loss, the system degrades to read-only.

Full text: [`specs/zenith_public.md`](specs/zenith_public.md).

### TradFi and DeFi in one vocabulary

Zenith expresses traditional rails (RTGS, DNS netting, Zengin retail, ISO 20022, FATF R.16) and newer primitives (HTLC, atomic multi-leg) **as coequal lanes on one state machine, not ledgers joined by a bridge**:

| Lane | Heritage | Finality primitive |
| --- | --- | --- |
| EXPRESS / STANDARD / BULK | TradFi (retail, Zengin) | H-reserve + netting |
| HIGH_VALUE | TradFi (central-bank RTGS) | Real-time gross settlement |
| DNS cycle | TradFi (clearing house) | End-of-day net position |
| HTLC / HTLC_AUTH | DeFi-native | Hash-lock + time-lock |
| GTID | Hybrid (atomic multi-leg) | All-or-nothing across legs |
| RTP | Hybrid (pull-based) | Name verification + authorisation |

Most cited precedents (BIS Stella, Jasper-Ubin, Agorá, mBridge, Partior, Fnality, JPM Onyx, Canton, DCJPY / Progmat) reach into the **monetary substrate** — tokenised deposits, wholesale CBDC, a unified ledger. Zenith does the opposite: it takes commercial-bank money and existing ledgers as given and designs the **layer on top**. Adjacent layers, not competitors. Three contributions appear, to our knowledge, not to exist together in the public literature: (1) HTLC, GTID atomic multi-leg, RTGS, and DNS netting as coequal lanes inside one state machine; (2) atomic pairing of state transitions with FinalityLog writes plus single-trace-id lifecycle tracing; (3) a liquidity-cascade rulebook for DNS_HOLD written at the same fidelity as the code ([`specs/zenith_policy.md`](specs/zenith_policy.md)). Tokenised deposits, wholesale CBDC, cross-border multi-currency atomicity, ZKP privacy, and agent identity are deliberately **out of scope**.

> **An aside — state machines and permissioned ledgers are structurally the same.** Decomposed, Zenith is almost isomorphic to a permissioned (EVM-style) chain, because both rest on the same three primitives: an append-only log, an explicit state machine, and atomic state transitions (FinalityLog ↔ canonical chain; `ALLOWED_TRANSITIONS` ↔ Solidity; `transitionWithLog` ↔ an EVM tx; H-Model ↔ ERC-20 + allowance; `version` ↔ nonce; idempotency key ↔ tx-hash uniqueness; `Participants` ↔ validator allowlist). The implication: wrapping substrate money onto a public chain (lock-and-mint) and an issuer running its own permissioned chain are difficulties pointing in **opposite directions** — the former inherits finality mismatch and bridge-custody risk (Ronin, Wormhole, Nomad) that legislation cannot remove; the latter reduces to rehousing RTGS responsibilities into a chain-shaped ledger, where **finality, atomicity, and auditability stand without EVM**. This is not a claim to become CBDC infrastructure — only that the design vocabulary works in both directions.

### The institutional layer

Alongside code and method, the **institutional and governance documents are written in the same register**: four-eyes approval and break-glass access, purpose codes (P01–P07) and data minimisation, the ordered DNS_HOLD response (initial communication, disclosure control, liquidity-providing-bank scheme, mutual contribution, last-resort central-bank funding), and WORM retention. Gathered in [`specs/zenith_policy.md`](specs/zenith_policy.md). A payment system does not land in society on technical specification alone.

### Getting hands on

Requires Node.js 18+, npm 8+, a Cloudflare account (free tier).

```bash
git clone https://github.com/pochatt/zenith-payment-system.git
cd zenith-payment-system && npm install
npm run db:migrate:local
npm run dev          # http://localhost:8787 (dashboard at root)
npm run test         # full suite, 473 cases
```

Deploy: `wrangler login` → create D1/queue/R2 → `cp wrangler.toml.example wrangler.toml` (fill ids) → `npm run db:migrate:remote` → `npm run deploy` → `POST /internal/seed`.

### State machine, in code

Every state advance is routed through `transitionWithLog`, which issues the CAS UPDATE on `Transactions` and the INSERT into `FinalityLog` as a single D1 batch. The FinalityLog is a `prev_hash` hash-chain, audited across every chain by a daily cron that converges any break into a CASE. **There is no window in which the state moves forward without its paired audit entry.** See [`src/zc/orchestrator/state_machine.ts`](src/zc/orchestrator/state_machine.ts).

### Features

Lanes: EXPRESS (retail), STANDARD (name check + authorisation), HTLC (conditional escrow), HTLC_AUTH (payee-initiated authorisation, b on capture), RTP (pull/invoice), GTID (multi-party atomic, b on all legs), HIGH_VALUE (central-bank routed, RTGS final), BULK (end-of-day netting).

Cross-cutting: daily net settlement (DNS), TigerBeetle-style limit Durable Object, O(1) alias cache, Rafiki-style streaming micro-payments, HMAC-validated QR, alias resolution, FATF R.16 cross-border, name/account verification, EDI / rich data, circuit breaker, **daily FinalityLog hash-chain audit (tamper detection → CASE)**, SSE event stream. Full endpoint reference: [`specs/api-contracts.md`](specs/api-contracts.md).

### Status and limits, stated plainly

A personal reference implementation, not for production.

- Bank-to-coordinator calls are HMAC-SHA256 only. TLS/mTLS, authn/authz, encryption at rest, and regulatory controls are out of scope.
- Performance figures are dev-environment observations, not production claims.
- Several normative requirements (DNS_HOLD igs_mode transitions, the Bulk LSM optimiser, general N:M GTID fan-in/out, …) are specified but not yet implemented — see [`specs/architecture.md`](specs/architecture.md) § 7.

The intent is **something to argue with**, not something to replace anything. The questions worth arguing: **who operates this layer, how it connects to existing RTGS/clearing rails, and who bears the migration cost.**

### License

MIT — see [LICENSE](LICENSE). Use it in whatever form suits you; if your project takes shape, a mention that Zenith was the draft you started from is more than enough. Questions and discussion: [GitHub Issues](https://github.com/pochatt/zenith-payment-system/issues).

> This repository and its accompanying documents are a work of fiction; they do not represent any real organisation, system, or way of working.
