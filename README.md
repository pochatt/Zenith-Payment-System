<!-- 
SEO Keywords: payment system, payment settlement, fintech, cloudflare workers, typescript, banking, japan, dtm, rtgs, payment rails, financial infrastructure, distributed settlement, real-time settlement, payment coordination, settlement architecture, financial rails
Recommended GitHub Topics: payment-system, fintech, cloudflare-workers, typescript, settlement, banking, financial-infrastructure, payment-rails, settlement-engine
-->

# Zenith Payment System

Reference implementation of the Zenith Coordinator—a next-generation payment settlement architecture designed for transparency, auditability, and distributed coordination.

**Status:** Reference Implementation | **License:** MIT | **Cost:** Zero operational cost (Cloudflare free tier)

---

## Overview

Traditional payment systems operate as black boxes. Money is sent, disappears into infrastructure, and neither the customer nor support staff can explain what happened or where funds are at any moment.

Zenith treats payments as explicable state sequences rather than opaque transactions:

```
RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE 
→ PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED
```

Every state change is logged in an append-only FinalityLog, making the entire settlement process auditable and real-time transparent.

### Core Principles

- **Explicability** — Every state transition is recorded, auditable, and understandable
- **Coordination** — Multi-bank settlements with atomic guarantees where possible
- **Auditability** — Append-only event log with full context for each state change
- **Resilience** — Circuit breaker patterns, graceful degradation, automatic health monitoring
- **Idempotency** — Safe retry semantics for all operations

---

## Unified TradFi / DeFi Settlement Semantics

Zenith is not a bridge between two worlds — it collapses them into a single state vocabulary.

Traditional payment rails (RTGS, deferred net settlement, Zengin-style retail transfers, ISO 20022 messaging, FATF R.16 travel rule) and DeFi-native primitives (hash-time-locked contracts, multi-leg atomic swaps, preimage-conditional release) are expressed as **different lanes over the same state machine** (`RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE → … → SETTLED`), written to the same `FinalityLog`, and governed by the same idempotency and optimistic-locking guarantees.

| Lane | Heritage | Finality primitive |
|------|---------|--------------------|
| EXPRESS / STANDARD / BULK | TradFi (retail, Zengin-era) | H-reserve + netting |
| HIGH-VALUE | TradFi (central bank RTGS) | BOJ-style real-time gross settlement |
| DNS cycle | TradFi (clearing house) | End-of-day net position |
| HTLC / HTLC-AUTH | DeFi-native | Hashlock + timelock (preimage release) |
| GTID | Hybrid (atomic multi-leg) | All-or-nothing across legs |
| RTP | Hybrid (pull-based, payee-initiated) | Name verification + authorization |

### How this relates to prior art

The closest precedents in the public literature are central-bank experiments, each of which covers only a subset of what Zenith unifies:

- **BIS Project Stella Phase 2** (Bank of Japan + ECB, 2018) — HTLC-based cross-DLT synchronised settlement. Research PoC; no RTGS, DNS, or FATF integration.
- **BIS Project Jasper-Ubin** (Bank of Canada + MAS) — HTLC atomic cross-border payment between two separate DLTs.
- **BIS Project Agorá** (7 central banks + private banks, 2024–) — Tokenised deposits + wholesale CBDC on a unified ledger. Design-stage; reference code not public.
- **BIS Project mBridge** — Multi-CBDC cross-border payment, permissioned DLT.
- **Partior** (DBS / JPMorgan / Temasek / Standard Chartered) — Blockchain-native multi-currency clearing.
- **Fnality** — Tokenised central bank money for wholesale settlement.
- **JPM Onyx / Coin Systems**, **Canton Network**, **DCJPY / Progmat** — Deposit-token issuance layers.

What is unusual about Zenith — and what we have not found in a public open-source codebase — is the explicit choice to express **HTLC, GTID atomic multi-leg, RTGS, and DNS netting as coequal lanes inside one orchestrator**, rather than as separate systems with adapters. Most prior work treats "TradFi rails" and "DLT rails" as distinct ledgers joined by a bridge; Zenith treats them as different lanes on the same state machine. See `src/zc/orchestrator/state_machine.ts` and `src/zc/lanes/` for the implementation.

This makes Zenith a reference for questions like:
- What does a tokenised-deposit HTLC look like if its lifecycle is logged in the same append-only audit trail as an RTGS settlement?
- How should FATF R.16 travel-rule data attach to a hash-time-locked payment?
- Can DNS end-of-day netting coexist with intraday atomic multi-leg (GTID) in one coordinator?

---

## Use Cases

### For Financial Institutions

Reference implementation for modernizing settlement infrastructure. Demonstrates best practices for:
- State machine design under concurrency
- Auditability and compliance logging
- Multi-bank coordination protocols
- Graceful failure and recovery

### For Fintech Builders

Pre-integration testing environment before connecting to real bank APIs. Validate:
- Settlement lane behavior
- Edge cases and failure modes
- API contract compliance
- Performance characteristics under load

### For Payment Researchers

Sandbox for exploring novel settlement architectures without regulatory constraints. Experiment with:
- New lane patterns
- Alternative state machines
- Cross-border settlement mechanisms
- Netting and clearing strategies

### For Developers

Educational codebase for understanding modern payment system design. Learn:
- How payments actually flow through settlement infrastructure
- Distributed consensus under financial constraints
- Database design for auditability
- Concurrency control in financial systems

---

## Getting Started

### Requirements

- Node.js 18+
- npm 8+
- Cloudflare account (free tier eligible)

### 5-Minute Deploy

```bash
# 1. Clone and install
git clone https://github.com/pochatt/zenith-mock.git
cd zenith-mock
npm install

# 2. Authenticate with Cloudflare
npx wrangler login

# 3. Create resources
npx wrangler d1 create zenith-db
npx wrangler queues create zenith-mock-queue
npx wrangler r2 bucket create zenith-mock-r2

# 4. Configure
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml with your database_id

# 5. Apply migrations
npm run db:migrate:remote

# 6. Deploy
npm run deploy

# 7. Seed initial data
curl -X POST https://zenith-mock.<your-domain>.workers.dev/internal/seed
```

Dashboard is now live at `https://zenith-mock.<your-domain>.workers.dev`

### Local Development

```bash
npm run db:migrate:local
npm run dev  # http://localhost:8787
```

---

## Features

### Settlement Lanes

| Lane | Purpose | Finality Model |
|------|---------|---|
| EXPRESS | Instant retail payments | H-reserve backed |
| STANDARD | General P2P transfers | Name verification + authorization |
| HTLC | Conditional escrow settlement | Hash-time-lock release |
| RTP | Invoice-initiated collections | Payee-initiated pull |
| GTID | Multi-bank atomic transfers | Coordinated all-or-nothing |
| HIGH-VALUE | Large RTGS transfers | BOJ real-time gross settlement |
| BULK | Batch processing | End-of-day netting |

### Advanced Features

- **Daily Net Settlement (DNS)** — EOD cycle with position netting
- **Limit Operations (TigerBeetle-style DO)** — Strict single-threaded Headroom reservation overcoming D1 lock limits
- **Directory ALS (Mojaloop KV)** — O(1) alias caching bypassing DB loads
- **Streaming Micro-payments (Rafiki-style)** — WebSockets & DO-alarm based batched finality
- **QR Payments** — Static and dynamic codes with HMAC validation
- **Alias Resolution** — Phone, email, corporate ID routing
- **Cross-Border** — FATF R.16 compliant international transfers
- **Account Verification** — Pre-settlement name and account matching
- **EDI / Rich Data** — Structured commercial data integration
- **Circuit Breaker** — Automatic health monitoring with graceful degradation
- **Event Stream** — Real-time SSE notifications to participating banks

---

## Architecture

### State Machine

All transactions follow a deterministic state machine with explicit allowed transitions. Prevents invalid state combinations and ensures consistency across concurrent writes.

```typescript
// From src/zc/orchestrator/state_machine.ts
const ALLOWED_TRANSITIONS = {
  'RECEIVED': ['PRECHECKED', 'REJECTED'],
  'PRECHECKED': ['H_RESERVED', 'REJECTED'],
  'H_RESERVED': ['DECIDED_TO_SETTLE', 'H_RELEASED'],
  'DECIDED_TO_SETTLE': ['PAYER_EXEC_CONFIRMED', 'DECIDED_CANCEL'],
  'PAYER_EXEC_CONFIRMED': ['PAYEE_EXEC_CONFIRMED'],
  'PAYEE_EXEC_CONFIRMED': ['SETTLED'],
  // ... more transitions
};
```

### Request Flow

```
HTTP Request
    ↓
[Validation & Schema Check]
    ↓
[Lane-Specific Logic]
    ↓
[State Machine Verification]
    ↓
[FinalityLog Append]
    ↓
[Queue Enqueue]
    ↓
HTTP 202 Accepted
    ↓
[Async Processing]
    ↓
[Bank Calls via Circuit Breaker]
    ↓
[Finality Confirmation]
```

### Database Design

28 optimized tables across core settlement, traceability, and bank operations:

**Core Settlement**
- `Transactions` — Payment records with state tracking
- `Participants` — Participating banks with H-limits
- `HReservations` — H-model funds reservation

**Traceability**
- `FinalityLog` — Append-only state change log
- `TxEventLog` — Detailed processing events and audit trail
- `BankAuditLog` — Per-bank command history

**Specialized Lanes**
- `HtlcContracts`, `GtidTransactions`, `RtpRequests`

**Bank Operations**
- `BankAccounts` — Account master
- `BankJournals` — Zero-sum double-entry ledger
- `SuspenseDetails` — Custody and suspense handling

See `specs/schema.md` for full schema documentation.

---

## API

All endpoints are documented in `specs/api-contracts.md`.

### Core Endpoints

**Initiate Payment**
```bash
POST /api/transfers
Content-Type: application/json

{
  "schema_version": "1.0",
  "message_type": "EVENT",
  "name": "PaymentInitiated",
  "txid": "TX-...",
  "lane": "EXPRESS",
  "amount": { "value": 5000, "currency": "JPY" },
  "payer": { "bank_id": "001", "account_hash": "h:..." },
  "payee": { "bank_id": "002", "account_hash": "h:..." }
}
```

**Query Transaction**
```bash
GET /api/transactions/TX-123

{
  "txid": "TX-123",
  "state": "SETTLED",
  "decision": { "status": "DECIDED_TO_SETTLE" },
  "execution": {
    "a": "OK",
    "b": "OK",
    "payer_bank_proof_ref": "PROOF-...",
    "payee_bank_proof_ref": "PROOF-..."
  },
  "as_of": "2026-04-18T12:34:56Z"
}
```

**List Transactions**
```bash
GET /api/transactions?state=SETTLED&lane=EXPRESS&limit=50&offset=0
```

---

## Performance

Measured on Cloudflare Workers (shared infrastructure):

| Operation | Latency (p99) | Throughput |
|-----------|---|---|
| Payment initiation → decision | 120–180ms | - |
| Bank ingress call + response | 200–300ms | - |
| Query transaction | <50ms | - |
| Single Worker | - | ~500 TPS |

Horizontal scaling available across Cloudflare's global edge.

---

## Testing

```bash
npm run test              # Run all tests
npm run test:watch       # Watch mode
npx vitest test/zc/express.test.ts  # Single file
```

Integration tests run against in-memory SQLite (via better-sqlite3), with full schema and realistic settlement scenarios including:
- Concurrent transaction processing
- Network failures and retries
- State machine constraint violations
- Circuit breaker activation/recovery

---

## Deployment

### Production Considerations

This reference implementation is suitable for:
- Development and testing environments
- Integration testing before production deployment
- Sandbox/training systems
- Research prototypes

**Not suitable for production without:**
- TLS termination
- Authentication and authorization
- Encryption at rest
- Regulatory audit and compliance review
- Formal security assessment

### Production Deployment Pattern

Use this implementation as a reference for building your own settlement system:

1. **Study the state machines** — `src/zc/orchestrator/state_machine.ts`
2. **Understand the protocols** — `specs/zenith_public.md`
3. **Review the data model** — `specs/schema.md`
4. **Implement in your stack** — Apply the patterns to your infrastructure
5. **Apply compliance framework** — Add regulatory controls for your jurisdiction

---

## Configuration

Configuration lives in `wrangler.toml` (created from template `wrangler.toml.example`):

```toml
[[d1_databases]]
binding = "DB"
database_name = "zenith-db"
database_id = "YOUR_DATABASE_ID"

[[queues.producers]]
binding = "QUEUE"
queue = "zenith-mock-queue"

[[queues.consumers]]
queue = "zenith-mock-queue"
max_batch_size = 100
max_batch_timeout = 30

[[r2_buckets]]
binding = "R2"
bucket_name = "zenith-mock-r2"

[env.production]
vars = { LOG_LEVEL = "info" }
```

---

## Database Migrations

Migrations are sequential and immutable. New schema changes always go in a new numbered file:

```bash
cat > migrations/0015_add_feature.sql << 'EOF'
ALTER TABLE Transactions ADD COLUMN feature_flag TEXT;
CREATE INDEX idx_feature ON Transactions(feature_flag);
EOF

npm run db:migrate:remote
```

To reset database (development only):
```bash
npx wrangler d1 delete zenith-db --yes
npx wrangler d1 create zenith-db
# Update database_id in wrangler.toml
npm run db:migrate:remote
```

---

## Commands

```bash
npm run dev              # Local dev server
npm run deploy           # Deploy to Cloudflare
npm run type-check       # TypeScript type checking
npm run test             # Run test suite
npm run test:watch       # Test watch mode
npm run db:migrate:local # Apply migrations locally
npm run db:migrate:remote # Apply migrations to remote D1
```

---

## Directory Structure

```
zenith-mock/
├── migrations/           # D1 SQL migrations (0001–0014)
├── schema/
│   └── baseline.sql      # Schema snapshot (reference)
├── specs/                # Documentation
│   ├── zenith_public.md  # Architecture & design
│   ├── api-contracts.md  # Endpoint reference
│   ├── schema.md         # Database reference
│   └── zenith_policy.md  # Business rules
├── src/
│   ├── index.ts          # Worker entry point
│   ├── types.ts          # Type definitions barrel
│   ├── types/            # Type modules
│   ├── shared/           # Shared utilities
│   ├── cron/             # Scheduled jobs
│   ├── dashboard/        # Frontend UI
│   ├── openapi/          # OpenAPI schemas
│   ├── zc/               # Coordinator logic
│   │   ├── lanes/        # Settlement lanes
│   │   ├── orchestrator/ # Async processing
│   │   └── [features]    # HTLC, DNS, etc.
│   └── bank/             # Bank mock implementation
├── test/                 # Test suite
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── wrangler.toml         # Cloudflare configuration
```

---

## Documentation

### Reference

- **[Zenith Architecture](specs/zenith_public.md)** — Design philosophy, state machines, settlement flows
- **[API Contracts](specs/api-contracts.md)** — Complete endpoint reference
- **[Database Schema](specs/schema.md)** — Table definitions and relationships
- **[Business Policy](specs/zenith_policy.md)** — Transaction rules and constraints
- **[File Structure](specs/file_structure.md)** — Codebase organization

### Getting Started

1. Read `specs/zenith_public.md` for architectural overview
2. Deploy locally with `npm run dev`
3. Explore dashboard at http://localhost:8787
4. Review `specs/api-contracts.md` for API usage
5. Check `test/` for realistic usage examples

---

## Security

Security measures in this implementation:

- HMAC-SHA256 signature validation on all bank-to-coordinator calls
- Idempotency key tracking prevents duplicate settlement
- Append-only audit log (FinalityLog) for non-repudiation
- Optimistic versioning for optimistic locking under concurrency
- Name verification before settlement confirmation
- AML/sanctions screening hooks (mock implementation)

**Important:** This is a reference implementation. Before production use:

- Implement TLS/mTLS for all network calls
- Add authentication and authorization layers
- Encrypt sensitive data at rest and in transit
- Conduct security audit and penetration testing
- Implement regulatory compliance controls
- Review and test failure scenarios thoroughly

---

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Write tests first (test-driven development)
4. Ensure tests pass: `npm run test`
5. Submit a pull request with clear description

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Support

- **Questions?** Open an [issue](https://github.com/pochatt/zenith-mock/issues)
- **Bug report?** Use [bug template](https://github.com/pochatt/zenith-mock/issues/new?template=bug.md)
- **Technical discussion?** See `specs/` for detailed documentation

---

---

# 日本語版

## 概要

従来の決済システムはブラックボックスです。送金されたお金はインフラに吸い込まれ、顧客もサポート担当者も、何が起きたのか、資金がどこにあるのかを説明することができません。

Zenithは決済を不透明なトランザクションではなく、説明可能な状態の連なりとして扱います：

```
RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE 
→ PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED
```

すべての状態変化は追記型のFinalityLogに記録され、決済プロセス全体が監査可能で、リアルタイム透明性を持ちます。

### 基本原則

- **説明可能性** — すべての状態遷移が記録され、監査可能で、理解できる
- **協調性** — 複数銀行による決済、原子性保証を可能な限り
- **監査性** — 完全なコンテキストを持つ追記型イベントログ
- **回復性** — サーキットブレーカーパターン、段階的機能低下、自動ヘルス監視
- **冪等性** — すべての操作に対して安全な再試行セマンティクス

## TradFi と DeFi を同一セマンティクスで記述する

Zenith は「2つの世界をつなぐブリッジ」ではありません。**両者を同じ状態機械の語彙に畳み込む** 統合型コーディネーターです。

伝統的決済レール（RTGS、DNS、全銀レガシー、ISO 20022、FATF R.16）と、DeFiネイティブな原始要素（HTLC、マルチレグ原子スワップ、preimage 条件開示）を、**同一の状態機械 (`RECEIVED → PRECHECKED → H_RESERVED → … → SETTLED`) 上の異なるレーン** として記述し、同じ `FinalityLog` に追記し、同じ冪等キーと楽観ロックで統治します。

| レーン | 出自 | ファイナリティ原始要素 |
|------|------|-----------------|
| EXPRESS / STANDARD / BULK | TradFi（リテール、全銀系） | H予約 + ネッティング |
| HIGH-VALUE | TradFi（中央銀行RTGS） | 日銀ネット型即時グロス決済 |
| DNS サイクル | TradFi（清算機関） | 日次ネットポジション |
| HTLC / HTLC-AUTH | DeFi ネイティブ | ハッシュロック + タイムロック（preimage 開示） |
| GTID | ハイブリッド（原子マルチレグ） | レッグ横断的オール・オア・ナッシング |
| RTP | ハイブリッド（受取人発起型プル） | 名義確認 + 事前承認 |

### 先行例との関係

公開文献で最も近い先行例はいずれも中央銀行の実験で、**Zenithが統合している領域の一部のみを扱っています**：

- **BIS Project Stella Phase 2**（日銀 + ECB, 2018）— HTLCによるDLT間同期決済の研究PoC。RTGS/DNS/FATF統合なし。
- **BIS Project Jasper-Ubin**（カナダ中銀 + MAS）— 別個の2つのDLT間のHTLCクロスボーダー原子決済。
- **BIS Project Agorá**（7中銀＋民間銀行, 2024–）— トークン化預金と卸売CBDCを統一台帳で扱う。設計段階、参照コード非公開。
- **BIS Project mBridge** — マルチCBDCクロスボーダー、パーミッションドDLT。
- **Partior**（DBS / JPM / Temasek / SC）— ブロックチェーンネイティブなマルチ通貨清算。
- **Fnality** — ホールセール決済向けトークン化中銀マネー。
- **JPM Onyx / Canton Network / DCJPY / Progmat** — 預金トークン発行レイヤー。

Zenith の特異な点は、そして **公開されたオープンソース実装としては類例を見つけられなかった** 点は、**HTLC、GTID 原子マルチレグ、RTGS、DNS ネッティングを 1 つのオーケストレーター内の対等なレーンとして表現している** ことです。従来の研究は「TradFi レール」と「DLT レール」を別台帳として扱い、間をブリッジで繋ぎます。Zenith は両者を同じ状態機械上の異なるレーンとして扱います。実装は `src/zc/orchestrator/state_machine.ts` と `src/zc/lanes/` を参照してください。

これにより以下のような問いのリファレンスになります：

- トークン化預金の HTLC が、RTGS 決済と同じ追記型監査証跡でログされたらライフサイクルはどう見えるか？
- FATF R.16 のトラベルルール情報は、ハッシュタイムロック決済にどう添付されるべきか？
- DNS の日次ネッティングと、日中の原子マルチレグ (GTID) は、1 つのコーディネーターで共存できるか？


## 利用シーン

### 金融機関向け

決済インフラの現代化のためのリファレンス実装。以下のベストプラクティスを実証：
- 並行処理下での状態機械設計
- 監査性とコンプライアンスロギング
- 複数銀行間の協調プロトコル
- 優雅なフェイルオーバーと回復

### Fintech開発者向け

実銀行API接続前の統合試験環境。以下を検証：
- 送金レーンの挙動
- エッジケースと障害モード
- APIコントラクト適合性
- 負荷下でのパフォーマンス特性

### 決済研究者向け

規制制約なしで新しい決済アーキテクチャを検証するサンドボックス。以下を実験：
- 新しいレーンパターン
- 代替状態機械
- クロスボーダー決済メカニズム
- ネッティング・清算戦略

### 開発者の学習向け

現代的な決済システム設計を理解するための教育的コードベース。学習内容：
- 決済がいかに決済インフラを流れるのか
- 金融制約下での分散合意
- 監査性のためのデータベース設計
- 金融システムにおける並行制御

## クイックスタート

### 要件

- Node.js 18+
- npm 8+
- Cloudflareアカウント（無料枠対象）

### デプロイ手順

```bash
# 1. クローンとインストール
git clone https://github.com/pochatt/zenith-mock.git
cd zenith-mock
npm install

# 2. Cloudflareで認証
npx wrangler login

# 3. リソース作成
npx wrangler d1 create zenith-db
npx wrangler queues create zenith-mock-queue
npx wrangler r2 bucket create zenith-mock-r2

# 4. 設定
cp wrangler.toml.example wrangler.toml
# wrangler.tomlをdatabase_idで編集

# 5. マイグレーション適用
npm run db:migrate:remote

# 6. デプロイ
npm run deploy

# 7. 初期データ投入
curl -X POST https://zenith-mock.<your-domain>.workers.dev/internal/seed
```

ダッシュボードは `https://zenith-mock.<your-domain>.workers.dev` で利用可能です。

## 主要機能

### 送金レーン

| レーン | 目的 | ファイナリティ |
|--------|------|---|
| EXPRESS | 即時小売決済 | H予約担保 |
| STANDARD | 一般P2P | 名義確認+承認 |
| HTLC | 条件付きエスクロー | ハッシュロック解放 |
| RTP | 請求型回収 | 受取人発起型 |
| GTID | 複数銀行原子転送 | 協調型オールオアナッシング |
| HIGH-VALUE | 大口RTGS | 日銀即時グロス清算 |
| BULK | バッチ処理 | 営業終了時ネッティング |

### 高度な機能

- **日次ネット清算 (DNS)** — EODサイクルと建玉ネッティング
- **限度額直列化 (TigerBeetle的DO)** — D1のロック限界を超えるシングルスレッドH予約
- **超高速ディレクトリ ALS (Mojaloop的KV)** — DB負荷を回避するO(1)のエイリアスキャッシュ
- **ストリーミング・マイクロ決済 (Rafiki的)** — WebSocketとDOタイマーによる巨大バッチ遅延確定
- **QR決済** — 静的・動的コードとHMAC検証
- **エイリアス解決** — 電話番号・メール・法人IDルーティング
- **クロスボーダー** — FATF R.16準拠の国際送金
- **口座確認** — 清算前の名義・口座確認
- **EDI/リッチデータ** — 構造化された商流データ統合
- **サーキットブレーカー** — 自動ヘルス監視と段階的機能低下
- **イベントストリーム** — 参加銀行へのリアルタイムSSE通知

## テスト

```bash
npm run test              # 全テスト実行
npm run test:watch       # ウォッチモード
npx vitest test/zc/express.test.ts  # 単一ファイル
```

統合テストはインメモリSQLite（better-sqlite3経由）で実行され、完全なスキーマと現実的な決済シナリオを含みます：
- 並行トランザクション処理
- ネットワーク障害と再試行
- 状態機械制約違反
- サーキットブレーカーの起動と回復

## コマンド

```bash
npm run dev              # ローカル開発サーバー
npm run deploy           # Cloudflareにデプロイ
npm run type-check       # TypeScript型チェック
npm run test             # テストスイート実行
npm run test:watch       # テストウォッチモード
npm run db:migrate:local # ローカルマイグレーション適用
npm run db:migrate:remote # リモートD1マイグレーション適用
```

## ドキュメント

### リファレンス

- **[Zenith設計](specs/zenith_public.md)** — 設計思想、状態機械、決済フロー
- **[API仕様](specs/api-contracts.md)** — エンドポイント完全リファレンス
- **[DBスキーマ](specs/schema.md)** — テーブル定義と関係
- **[業務ポリシー](specs/zenith_policy.md)** — 取引ルールと制約
- **[ファイル構成](specs/file_structure.md)** — コードベース構成

## セキュリティ

本実装に含まれるセキュリティ対策：

- すべての銀行-コーディネーター通信のHMAC-SHA256署名検証
- 冪等キー追跡で重複決済を防止
- 追記型監査ログ（FinalityLog）で否認防止
- 楽観的バージョンで並行処理時の楽観的ロック
- 決済確認前の名義確認
- AML/制裁スクリーニングフック（モック実装）

**重要:** これはリファレンス実装です。本番運用前に以下を確認してください：
- すべてのネットワーク通信にTLS/mTLSを実装
- 認証・認可レイヤーを追加
- 保存時・転送時の機密データ暗号化
- セキュリティ監査とペネトレーションテスト実施
- 規制コンプライアンス制御を実装
- 障害シナリオを十分にテスト

## ライセンス

MIT License。[LICENSE](LICENSE)を参照してください。

## サポート

- **質問？** [issueを開く](https://github.com/pochatt/zenith-mock/issues)
- **バグ報告？** [バグテンプレート使用](https://github.com/pochatt/zenith-mock/issues/new?template=bug.md)
- **技術的な議論？** `specs/`の詳細ドキュメント参照
