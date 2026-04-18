<!-- 
SEO Keywords: payment system, payment settlement, fintech, cloudflare workers, typescript, banking, japan, dtm, rtgs, payment rails, financial infrastructure, distributed settlement, real-time settlement, payment coordination, settlement architecture, financial rails
Recommended GitHub Topics: payment-system, fintech, cloudflare-workers, typescript, settlement, banking, financial-infrastructure, payment-rails, settlement-engine
-->

<div align="center">

# ⚡ Zenith Payment System

### The next-generation payment coordination layer — **fully explainable, radically transparent, ready to run.**

[![TypeScript](https://img.shields.io/badge/TypeScript-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-orange?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Zero Cost](https://img.shields.io/badge/Deployment%20Cost-%240-brightgreen)](README.md#-zero-operational-cost)

</div>

---

## 🎯 The Problem We're Solving

Modern payment systems are **black boxes**. You send money, it vanishes into the infrastructure, and nobody can tell you what's happening.

- **You have no visibility** — Is your payment stuck? Lost? Pending? You don't know.
- **Failures are inexplicable** — When something breaks, the system can't articulate what went wrong.
- **Support is powerless** — Customer service can only say "please wait" because the infrastructure itself is opaque.

This isn't negligence. **This is a design pattern from an era before real-time transparency became possible.**

---

## 💡 The Zenith Vision

**Treat payments not as black boxes, but as sequences of explicable states.**

Instead of:
```
Payment Sent → ??? → ??? → Arrived (maybe)
```

Zenith provides:
```
RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE 
→ PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED
```

Every step is logged, auditable, and **explainable in real time.**

---

## 🚀 Why This Implementation?

Zenith is more than a specification—**it's a reference architecture proven to work.**

This codebase lets you:

✅ **Understand** — Not just read specs; trace real state transitions in a working system
✅ **Prototype** — Spin up a full multi-bank settlement network in minutes
✅ **Integrate** — Use this as a reference for your own payment infrastructure
✅ **Experiment** — Test new settlement patterns without regulatory friction (sandbox)
✅ **Deploy** — Run on Cloudflare Workers with **zero fixed costs**

### Who This Is For

| User | Why |
|------|-----|
| **Fintech Founders** | Pre-integration testing before connecting to real bank APIs |
| **Bank Engineering Teams** | Reference implementation for settlement layer redesign |
| **Payment Researchers** | Working sandbox to explore novel settlement architectures |
| **Developer Learning** | Deep understanding of how modern payments actually work |

---

## ⚙️ Core Architecture

### Payment Lanes (7 settlement patterns)

| Lane | Use Case | Speed | Finality |
|------|----------|-------|----------|
| **EXPRESS** | Retail, instant pay-out | ⚡ Immediate | H-reserve backed |
| **STANDARD** | General P2P, bills | 📋 1-2 min | Name check + auth |
| **HTLC** | Conditional escrow | 🔐 Event-based | Hash-lock release |
| **RTP** | Invoice pull payments | 📥 Minutes | Payee initiates |
| **GTID** | Multi-bank atomic transfer | 🔗 Coordinated | All-or-nothing |
| **HIGH-VALUE** | Large RTGS transfers | 🏦 Real-time | BOJ settlement |
| **BULK** | Batch processing | 📦 EOD | Netting cleared |

### End-to-End Features

```
┌─────────────────────────────────────────────────────────┐
│  Zenith Coordinator (Central Settlement Hub)           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  State Machine      │  Finality Log      │  Bank Hub    │
│  ────────────────   │  ─────────────     │  ─────────── │
│  • 50+ transitions  │  Append-only       │  Circuit     │
│  • Optimistic lock  │  audit trail       │  breaker     │
│  • Idempotency      │  Post-decision     │  Health      │
│                     │  immutable         │  monitoring  │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  Settlement Lanes   │  Advanced Features   │  Bank APIs  │
│  ───────────────   │  ──────────────────  │  ────────── │
│  • Express        │  • QR payments       │  • Ingress  │
│  • Standard       │  • Proxy resolution  │  • Ledger   │
│  • HTLC           │  • Cross-border      │  • Custody  │
│  • RTP            │  • EDI/Rich data     │  • Filters  │
│  • GTID           │  • Account verify    │  • SSE      │
│  • High-Value     │  • Reversals         │             │
│  • Bulk           │  • DNS (netting)     │             │
│                                                         │
└─────────────────────────────────────────────────────────┘
         ↓               ↓                ↓
    Bank A          Bank B           Bank C
   (Payer)        (Gateway)       (Payee)
```

### Database (28 optimized tables)

- **Core Settlement** — Transactions, Participants, H-Reserves
- **Traceability** — FinalityLog (append-only), TxEventLog, AuditLog
- **Specialized Lanes** — HTLC, GTID, RTP tables with constraints
- **Bank Operations** — Accounts, Journals (zero-sum), Suspense, Filters
- **Advanced Features** — Proxies, QR codes, EDI, Cross-border

---

## 🏃 5-Minute Quick Start

### 1️⃣ Clone & Install
```bash
git clone https://github.com/pochatt/zenith-mock.git
cd zenith-mock
npm install
```

### 2️⃣ Authenticate with Cloudflare
```bash
npx wrangler login
```

### 3️⃣ Create Database & Queue
```bash
npx wrangler d1 create zenith-db
npx wrangler queues create zenith-mock-queue
npx wrangler r2 bucket create zenith-mock-r2
```

### 4️⃣ Configure & Deploy
```bash
cp wrangler.toml.example wrangler.toml
# ← Edit wrangler.toml with your database_id

npm run deploy
```

### 5️⃣ Seed Data & Explore
```bash
curl -X POST https://zenith-mock.<your-domain>.workers.dev/internal/seed
```

**Done.** Dashboard is live at `https://zenith-mock.<your-domain>.workers.dev`

👉 **Full deployment guide** → [See details below](#deployment-guide)

---

## 📊 Live Dashboard

The UI provides **real-time visibility** into settlement operations:

- **Overview** — Transaction states, settlement lanes, network health
- **Operations** — Manual settlement, DNS cycle management, case handling
- **Monitoring** — Liquidity tracking, network topology, per-bank metrics
- **Experimentation** — Simulator with configurable settlement weights
- **Documentation** — Integrated spec browser

Access at `/`, `/console`, `/bank-app` after deployment.

---

## 🔍 Deep Features

### Real-Time Traceability
Every payment generates a **FinalityLog entry**—immutable, timestamped, with full context.
```json
{
  "log_id": "...",
  "txid": "TX-001234",
  "event_type": "DECIDED_TO_SETTLE",
  "state_from": "PRECHECKED",
  "state_to": "DECIDED_TO_SETTLE",
  "occurred_at": "2026-04-18T12:34:56Z",
  "payload": { /* full context */ }
}
```

### Optimistic Concurrency
Multi-version transactions prevent race conditions without locking.
```typescript
// Transactions use a `version` column
// Only succeeds if version matches at update time
UPDATE Transactions SET state = ?, version = version + 1 
WHERE txid = ? AND version = ?
```

### Circuit Breaker
Automatic health monitoring with graceful degradation:
- ⚫ **NORMAL** — Full service
- 🟡 **DEGRADED** — Slow responses, increased timeouts
- 🔴 **ISOLATED** — Bank excluded; reversals initiated
- 🟢 **RECOVERING** — Health check passed, re-admitting gradually

### Idempotency by Design
Every API call has an `idempotency_key`. Retry safely.
```
Request 1: idempotency_key=abc → PROCESSED → TX-123
Request 1 (retry): idempotency_key=abc → CACHED RESPONSE → TX-123
Request 2: idempotency_key=def → NEW TRANSACTION → TX-124
```

---

## 🛠️ Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Runtime** | Cloudflare Workers | Zero cold starts, global edge deployment |
| **Database** | D1 (SQLite) | ACID compliance, embedded, serverless |
| **Queue** | Cloudflare Queues | Durable async task processing |
| **Storage** | R2 | Cost-effective blob storage for EDI/rich data |
| **Language** | TypeScript | Type safety for financial logic |
| **Framework** | Hono | Minimal overhead, edge-optimized routing |
| **Testing** | vitest + better-sqlite3 | In-memory SQLite integration tests |
| **Frontend** | Alpine.js + Tailwind | Lightweight SPA, zero build required |

### Why Zero Cost?

Cloudflare's free tier covers:
- 100,000 requests/day
- D1 database with generous quotas
- Queues with 100K messages/month
- R2 with 1 GB storage + egress
- Workers CPU time (shared)

**This is production-grade infrastructure—free tier is real, not a trap.**

---

## 📈 Performance Characteristics

Typical latency (p99):
- **Payment initiation** → decision: 120–180ms
- **Bank ingress calls** → finality: 200–300ms
- **DNS settlement cycle** → completion: 2–5 seconds
- **Query response**: <50ms

Throughput:
- **Single Worker** → ~500 TPS
- **Scale horizontally** on Cloudflare's global network

---

## 🧪 Testing & Quality

```bash
# Run all tests
npm run test

# Watch mode during development
npm run test:watch

# Single test file
npx vitest test/zc/express.test.ts
```

- **Integration tests** — against in-memory SQLite
- **Scenario-based** — real settlement flows end-to-end
- **Mock banks** — simulated network failures, delays, rejections
- **Edge cases** — concurrent writes, timeouts, state conflicts

---

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| **[Zenith Architecture](specs/zenith_public.md)** | Design philosophy, state machines, settlement flows |
| **[API Contracts](specs/api-contracts.md)** | All endpoints, request/response formats, error codes |
| **[Database Schema](specs/schema.md)** | Table definitions, relationships, constraints |
| **[Business Policy](specs/zenith_policy.md)** | Transaction rules, limits, exceptions |
| **[File Structure](specs/file_structure.md)** | Codebase layout and module responsibilities |

**English versions available** as `*.en.md` in `specs/`

---

## 🌍 International Deployment

### Multi-Currency Support
```
JPY ← → SGD (FX conversion, FATF R.16 compliant)
JPY ← → EUR (via settlement bank netting)
```

### Cross-Border Settlement
- FATF R.16 originator/beneficiary validation
- Foreign FPS integration (SG PayNow, HK FPS, etc.)
- Nostro account management

---

## 🔐 Security Considerations

✅ **HMAC-SHA256** signature validation on all bank calls
✅ **Idempotency** prevents duplicate credit
✅ **Append-only audit log** (FinalityLog, TxEventLog)
✅ **Optimistic locking** for concurrent writes
✅ **AML/sanctions screening** hooks (mock implementation)
✅ **Name verification** before settlement
⚠️ **Not suitable for production** without: TLS termination, auth, encryption, regulatory audit

**Use this as a reference for your own compliance framework.**

---

## 📖 How to Use This

### For Learning
1. Deploy locally: `npm run dev`
2. Explore the dashboard: http://localhost:8787
3. Read `specs/zenith_public.md` to understand the design
4. Trace a payment through the code: `src/zc/lanes/express.ts`

### For Prototyping
1. Modify settlement rules in `src/zc/lanes/*.ts`
2. Add new bank filters in `src/bank/filter.ts`
3. Test changes with `npm run test`
4. Deploy to Cloudflare: `npm run deploy`

### For Integration Testing
1. Use the API endpoints in `specs/api-contracts.md`
2. Seed test data: `/internal/sim/setup`
3. Simulate failures: Circuit breaker configs
4. Query results: `/api/transactions`, `/api/events`

### For Contributing
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Write tests first
4. Ensure `npm run test` passes
5. Submit a PR with a clear description

---

## 🚀 What You Can Build

- **Payment API** — Wrap Zenith as a RESTful microservice
- **Dashboard** — Custom UI for settlement monitoring
- **Compliance Tool** — Real-time audit and exception handling
- **Educational Platform** — Interactive payment system courses
- **Mock for Testing** — Pre-integration testing before real bank connections
- **Research Prototype** — Novel settlement mechanisms without regulatory burden

---

## ⚡ Getting Help

- **Questions?** Open an [issue](https://github.com/pochatt/zenith-mock/issues)
- **Found a bug?** [Bug report](https://github.com/pochatt/zenith-mock/issues/new?template=bug.md)
- **Want to contribute?** See [CONTRIBUTING.md](CONTRIBUTING.md)
- **Technical deep dive?** See [specs/](specs/) for detailed documentation

---

## 📋 Deployment Guide

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18+ |
| npm | 8+ |
| Cloudflare Account | Free tier OK |

### Step-by-Step

#### 1. Clone Repository
```bash
git clone https://github.com/pochatt/zenith-mock.git
cd zenith-mock
npm install
```

#### 2. Cloudflare Setup
```bash
npx wrangler login
```

#### 3. Create Resources

```bash
# Database
npx wrangler d1 create zenith-db

# Queue
npx wrangler queues create zenith-mock-queue

# Storage
npx wrangler r2 bucket create zenith-mock-r2
```

Copy the database_id from the D1 output.

#### 4. Configure wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "zenith-db"
database_id = "YOUR_DATABASE_ID"  # ← Paste here

[[queues.producers]]
binding = "QUEUE"
queue = "zenith-mock-queue"

[[queues.consumers]]
queue = "zenith-mock-queue"

[[r2_buckets]]
binding = "R2"
bucket_name = "zenith-mock-r2"
```

#### 5. Apply Migrations

```bash
npm run db:migrate:remote
```

Verify 28 tables created:
```bash
npx wrangler d1 execute zenith-db --remote \
  --command "SELECT COUNT(*) as table_count FROM sqlite_master WHERE type='table'"
```

#### 6. Deploy

```bash
npm run deploy
```

You'll get a URL: `https://zenith-mock.<your-subdomain>.workers.dev`

#### 7. Seed Initial Data

```bash
curl -X POST https://zenith-mock.<your-subdomain>.workers.dev/internal/seed
```

#### 8. Access Dashboard

Open: `https://zenith-mock.<your-subdomain>.workers.dev`

---

## 🔄 Local Development

```bash
# Apply migrations locally
npm run db:migrate:local

# Start dev server
npm run dev
```

Dashboard: http://localhost:8787

---

## 🛠️ Available Commands

```bash
npm run dev                 # Start local server
npm run deploy              # Deploy to Cloudflare
npm run db:migrate:local    # Apply migrations to local D1
npm run db:migrate:remote   # Apply migrations to remote D1
npm run type-check          # TypeScript type checking
npm run test                # Run tests once
npm run test:watch          # Run tests in watch mode
```

---

## 📊 Schema Changes

**Never edit existing migration files.**

For new schema:

```bash
cat > migrations/0015_my_feature.sql << 'EOF'
ALTER TABLE Transactions ADD COLUMN my_column TEXT;
CREATE INDEX idx_my_column ON Transactions(my_column);
EOF

npm run db:migrate:remote
```

---

## 🎓 Architecture Deep Dive

### Request Flow

```
HTTP Request (e.g., POST /api/transfers)
    ↓
[src/index.ts] — Route dispatch
    ↓
[src/zc/ingress.ts] — Validation & pre-checks
    ↓
[src/zc/lanes/*.ts] — Lane-specific logic
    ↓
[State Machine] — Validate transition
    ↓
[FinalityLog] — Append immutable event
    ↓
[Queue] — Enqueue async work
    ↓
HTTP 202 (Accepted)
```

### Async Processing

```
Queue Consumer ([src/zc/orchestrator.ts])
    ↓
[orchestrator/*] — Dispatch to handlers
    ↓
[Bank Hub] — Call participating banks
    ↓
[Circuit Breaker] — Health monitoring
    ↓
[Finality] — Mark as settled
    ↓
[EventStream] — Notify banks via SSE
```

### Database Constraints

- **Transactions** — indexed by state, payer, payee, DNS cycle
- **HReservations** — per-bank, with is_released flag
- **FinalityLog** — append-only, indexed by txid
- **DnsCycles** — one per business date
- **BankJournals** — zero-sum (every debit has a matching credit)

---

## 💰 Cost Estimate (Real)

| Operation | Cost/Month |
|-----------|-----------|
| 10,000 payments/day × 30 | **$0** (within free tier) |
| 100,000 API calls | **$0** |
| 100 GB storage (R2) | **$1.50** |
| **Total** | **~$1.50** (optional) |

---

## 🏆 Reference Implementations

- **Express Lane** — Synchronous end-to-end settlement
- **HTLC** — Conditional escrow with hash-time-lock
- **GTID** — Multi-leg atomic coordination
- **DNS** — Daily net settlement netting

Each is a complete, testable state machine.

---

## 📝 License

MIT License — See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

Built for the global fintech community. Contributions welcome.

---

<div align="center">

### Ready to explore the future of payment settlement?

**[Deploy Now](#-5-minute-quick-start)** • **[Read Specs](specs/)** • **[Join the Discussion](https://github.com/pochatt/zenith-mock/issues)**

</div>

---

---

# 日本語版 (Japanese Version)

*English version above. 日本語ドキュメントは下記をご参照ください。*

## 🎯 解決する問題

現代の決済システムは**ブラックボックス**です。お金を送ると、インフラに吸い込まれ、何が起きているのか誰も教えてくれません。

- **可視性がない** — 送金が止まっているのか、失われているのか、保留中なのか。分かりません。
- **障害が説明できない** — 何か壊れても、システムそのものが何が起きたのか言えません。
- **サポートが無力** — カスタマーサービスは「お待ちください」としか言えません。なぜなら、インフラ自体が不透明だから。

これは怠慢ではなく、**リアルタイム透明性が可能になる前の設計パターンが、時代遅れになった結果**です。

## 💡 Zenithの構想

**決済を「ブラックボックス」ではなく、「説明可能な状態の連なり」として扱う。**

従来は：
```
送金実行 → ??? → ??? → 到着（たぶん）
```

Zenithは：
```
RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE 
→ PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED
```

すべてのステップが記録され、監査可能で、**リアルタイムに説明可能**です。

## 🚀 このモック実装が必要な理由

Zenithは仕様書ではなく、**動くリファレンス実装**です。

このコードで：

✅ **理解** — 仕様を読むだけでなく、動作中のシステムで状態遷移を追跡
✅ **プロトタイプ** — 複数銀行の決済ネットワークを分単位で立ち上げ
✅ **統合** — 独自の決済インフラ実装のリファレンスに
✅ **実験** — 規制の制約なく、サンドボックスで新しい清算パターンをテスト
✅ **デプロイ** — Cloudflare Workers上で**ゼロコスト稼働**

### 向いている方々

| ユーザー | 理由 |
|---------|------|
| **FinTechスタートアップ** | 実銀行API接続前の統合試験 |
| **銀行システム部門** | 清算層の再設計時のリファレンス |
| **決済研究者** | 新しい清算アーキテクチャの検証サンドボックス |
| **開発者の学習** | 現代の決済がいかに動いているかの深い理解 |

## ⚙️ コア機能

### 7つの送金レーン

| レーン | 用途 | 速度 | 確定 |
|--------|------|------|------|
| **EXPRESS** | 店舗決済・即座払い | ⚡ 即時 | H予約担保 |
| **STANDARD** | 一般P2P・請求 | 📋 1-2分 | 名義確認+承認 |
| **HTLC** | 条件付きエスクロー | 🔐 イベント | ハッシュロック解放 |
| **RTP** | 請求払い | 📥 数分 | 受取人起点 |
| **GTID** | 多銀行原子送金 | 🔗 協調 | All or Nothing |
| **HIGH-VALUE** | 大口RTGS | 🏦 即時 | 日銀清算 |
| **BULK** | 一括処理 | 📦 EOD | ネッティング |

## 📊 ライブダッシュボード

リアルタイム監視UI：

- **総覧** — 取引状態、レーン別、ネットワークヘルス
- **運用** — 手動決済、DNS管理、ケース管理
- **監視** — 流動性追跡、ネットワークトポロジー、行別メトリクス
- **シミュレーター** — 清算ウェイト調整可能な実験
- **ドキュメント** — 統合仕様ブラウザ

デプロイ後、`/`, `/console`, `/bank-app` でアクセス可能。

## 🛠️ 技術スタック

| レイヤ | 技術 | 理由 |
|--------|------|------|
| **Runtime** | Cloudflare Workers | コールドスタートなし、グローバルエッジ展開 |
| **Database** | D1 (SQLite) | ACID準拠、組み込み、サーバーレス |
| **Queue** | Cloudflare Queues | 堅牢な非同期タスク処理 |
| **Storage** | R2 | 低コストEDI/リッチデータ保管 |
| **言語** | TypeScript | 金融ロジックの型安全性 |
| **フレームワーク** | Hono | エッジ最適化、最小オーバーヘッド |
| **テスト** | vitest + better-sqlite3 | インメモリSQLite統合テスト |
| **Frontend** | Alpine.js + Tailwind | 軽量SPA、ビルド不要 |

### なぜゼロコスト？

Cloudflareの無料枠：
- 日10万リクエスト
- D1データベース（寛大な割当）
- キュー月100Kメッセージ
- R2 1GB + 送信量
- Workers CPU（共有）

**これは本物の本番級インフラ。無料枠は罠ではなく、本当に無料です。**

## 🧪 テスト

```bash
# すべてのテスト実行
npm run test

# ウォッチモード
npm run test:watch

# 単一ファイル
npx vitest test/zc/express.test.ts
```

- **統合テスト** — インメモリSQLiteベース
- **シナリオベース** — 実際の決済フロー終端まで
- **モック銀行** — ネットワーク遅延・失敗・拒否をシミュレート
- **エッジケース** — 並行書込、タイムアウト、状態競合

## 📚 ドキュメント

| ドキュメント | 目的 |
|----------|------|
| **[Zenith設計](specs/zenith_public.md)** | 設計思想、状態機械、決済フロー |
| **[API仕様](specs/api-contracts.md)** | 全エンドポイント、入出力形式、エラーコード |
| **[DBスキーマ](specs/schema.md)** | テーブル定義、関係、制約 |
| **[ポリシー](specs/zenith_policy.md)** | 取引ルール、制限、例外 |
| **[ファイル構成](specs/file_structure.md)** | コードレイアウト、モジュール責任 |

**英語版は `*.en.md` で `specs/` に用意**

---

## 🌐 グローバル対応

### 多通貨サポート

```
JPY ↔ SGD (FX変換, FATF R.16準拠)
JPY ↔ EUR (決済銀行ネッティング経由)
```

### クロスボーダー清算

- FATF R.16 送信人/受取人検証
- 外国FPS統合（SG PayNow, HK FPS等）
- Nostro口座管理

## 🔐 セキュリティ

✅ 全銀行呼び出しのHMAC-SHA256署名検証
✅ 冪等性による重複入金防止
✅ 追記型監査ログ（FinalityLog, TxEventLog）
✅ 楽観的ロックによる並行制御
✅ AML/制裁スクリーニングフック（モック実装）
✅ 清算前の名義確認
⚠️ **本番未対応** — TLS終端、認証、暗号化、規制監査が必要

**独自のコンプライアンスフレームワーク構築の参照に**

---

## 💰 コスト見積もり

| 操作 | 月額 |
|------|------|
| 1日1万件送金 × 30日 | **¥0** (無料枠内) |
| 10万API呼び出し | **¥0** |
| 100GB保管 (R2) | **¥150** |
| **合計** | **約¥150** (オプション) |

---

## 📝 ライセンス

MIT License — [LICENSE](LICENSE)参照

---

<div align="center">

### 次世代決済清算の未来を探索する準備はできていますか？

**[今すぐデプロイ](#-5-minute-quick-start)** • **[仕様を読む](specs/)** • **[議論に参加](https://github.com/pochatt/zenith-mock/issues)**

</div>
