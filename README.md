<!-- 
SEO Keywords: payment system, payment settlement, fintech, cloudflare workers, typescript, banking, japan, dtm, rtgs, payment rails, financial infrastructure, distributed settlement, real-time settlement
Recommended GitHub Topics: payment-system, fintech, cloudflare-workers, typescript, settlement, banking, financial-infrastructure
-->

# Zenith Payment System — Reference Implementation

**A runnable implementation of the Zenith Coordinator (ZC) with multiple participating banks.**
Built on Cloudflare Workers + D1 + Queues + R2, with zero operational costs (all within free tier limits).

---

## What is Zenith?

Japan's payment infrastructure has long carried unresolved challenges:

- **No visibility** — money in flight disappears into a black box
- **Unexplainable failures** — when incidents occur, nobody can articulate what happened
- **No recourse** — customer inquiries are met with "please wait" and nothing more

This is not operational negligence, but the result of **design principles that were correct in their era becoming misaligned with modern expectations** as decades passed.

Zenith is a next-generation payment architecture designed to confront this problem directly. At its core lies a simple principle:

> Treat payments not as **"black boxes"** but as **"sequences of explicable states"**.

Banks continue to manage accounts and customer data. The Zenith Coordinator (ZC) takes responsibility for organizing, recording, and making explicable the state of payments flowing between them.

Read more → **[Zenith Architecture (Design Philosophy & Background)](https://www.sakuolia.jp/zenith.html)**

---

## Why This Implementation Exists

To preserve the Zenith design philosophy **as living, runnable code**.

Reading specifications alone is insufficient. Having an environment where you can call APIs directly, trace state transitions, and verify settlement behavior with your own hands raises the resolution of discussion. Before integration development begins, the ability to intuitively understand "this lane works this way" reduces implementation costs significantly.

This is a **reference implementation designed for integration testing and prototyping** by financial institutions and FinTech vendors.

---

## Core Features

### Payment Lanes

| Lane | Description |
|------|-------------|
| **Express** | High-speed lane for retail and instant settlements; immediate confirmation via H-reserve |
| **Standard** | Standard general payment with name verification and authorization |
| **HTLC** | Hash-time-locked conditional escrow settlement |
| **RTP** | Request-to-Pay (pull-initiated) payment collection |
| **High-Value** | High-value RTGS settlement via prefunded intermediation |

### Additional Capabilities

- **DNS (Daily Net Settlement)** — EOD batch and settlement flow simulation
- **QR Payments** — Static & dynamic QR codes with HMAC signature validation
- **Alias Resolution** — Account lookup by phone, email, or other proxy identifiers
- **Rich Data Integration** — Separation of financial core and commercial/EDI data with reference retention
- **Cross-Border Transfers** — FATF R.16 compliant
- **Frontend UI** — Central coordinator dashboard (`/`), teller dashboard (`/console`), customer bank app (`/bank-app`)

---

## Technology Stack

| Component | Service |
|-----------|---------|
| Runtime | Cloudflare Workers (TypeScript) |
| Database | Cloudflare D1 (SQLite) |
| Message Queue | Cloudflare Queues |
| Object Storage | Cloudflare R2 |
| Deployment | Wrangler CLI |

---

## Deployment from Scratch

### Prerequisites

| Tool | Minimum Version |
|------|-----------------|
| Node.js | 18+ |
| npm | 8+ |
| Cloudflare Account | Free tier eligible |

---

### 1. Clone Repository and Install Dependencies

```bash
git clone <this-repo>
cd zenith-mock
npm install
```

---

### 2. Create wrangler.toml

`wrangler.toml` contains your personal Cloudflare credentials and is excluded from Git control.
Copy the template and configure it:

```bash
cp wrangler.toml.example wrangler.toml
```

---

### 3. Authenticate with Cloudflare

```bash
npx wrangler login
```

Your browser will open for Cloudflare account authentication.

```bash
npx wrangler whoami  # Verify authentication
```

---

### 4. Create D1 Database

```bash
npx wrangler d1 create zenith-db
```

Example output:

```
✅ Successfully created DB 'zenith-db'

[[d1_databases]]
binding = "DB"
database_name = "zenith-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding       = "DB"
database_name = "zenith-db"
database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← Replace with your database_id
```

---

### 5. Create Queues

```bash
npx wrangler queues create zenith-mock-queue
```

---

### 6. Create R2 Bucket

```bash
npx wrangler r2 bucket create zenith-mock-r2
```

---

### 7. Run Migrations (Create Schema)

```bash
npm run db:migrate:remote
```

Verify tables were created:

```bash
npx wrangler d1 execute zenith-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Success is confirmed by 28 tables appearing.

---

### 8. Deploy

```bash
npm run deploy
```

After deployment, your dashboard is accessible at the URL shown (e.g., `https://zenith-mock.<your-subdomain>.workers.dev`).

---

### 9. Seed Initial Data

Open the dashboard (`/`) and click the **SEED** button, or execute:

```bash
curl -X POST https://zenith-mock.<your-subdomain>.workers.dev/internal/seed
```

SEED initializes:

| Component | Details |
|-----------|---------|
| Participating Banks | `001` (Nagaoka Bank), `002` (Owari Bank); add more as needed |
| Customer Accounts | 2 per bank (¥1M initial balance each) |
| BOJ Prefunding | ¥100B per bank |
| DNS Cycle | Today's cycle created |

---

## Local Development

```bash
# Apply migrations to local D1
npm run db:migrate:local

# Start dev server (http://localhost:8787)
npm run dev
```

---

## Schema Changes & Migrations

### Adding Columns or Tables

**Never edit existing migration files.** Always create a new numbered file:

```bash
# Example: create new migration in 0011 series
cat > migrations/0011_add_new_feature.sql << 'EOF'
ALTER TABLE Participants ADD COLUMN new_col TEXT;
EOF

npm run db:migrate:remote
```

### Full Database Reset (Development Only)

```bash
# Clear migration history
npx wrangler d1 execute zenith-db --remote \
  --command "DROP TABLE IF EXISTS d1_migrations"

# Or recreate the database entirely
npx wrangler d1 delete zenith-db
npx wrangler d1 create zenith-db
# Update database_id in wrangler.toml, then:
npm run db:migrate:remote
```

> [!WARNING]
> Editing existing migration files will **not** apply changes to remote D1.
> D1 tracks applied migrations and ignores modifications.

---

## Command Reference

```bash
npm run dev                 # Start local dev server
npm run deploy              # Deploy to Cloudflare
npm run db:migrate:local    # Apply migrations locally
npm run db:migrate:remote   # Apply migrations to remote D1
npm run type-check          # Run TypeScript type checking
```

---

## Directory Structure

```
zenith-mock/
├── migrations/              # D1 SQL migrations (0001–0014, applied in order)
├── schema/
│   └── baseline.sql         # Schema snapshot after all migrations (reference)
├── specs/                   # Specifications & design documentation
├── src/
│   ├── index.ts             # Worker entry point; HTTP/Queue/Cron dispatch
│   ├── types.ts             # Type definition barrel (re-exports types/)
│   ├── types/               # Type definitions (primitives / states / rows / api)
│   ├── shared/              # Shared utilities (HMAC, ISO 20022, FATF, routing, etc.)
│   ├── cron/                # EOD batch & timeout sweep jobs
│   ├── dashboard/           # Admin dashboard HTML (Alpine.js + Tailwind)
│   ├── openapi/             # OpenAPI schema definitions (zc-api / bank-api)
│   ├── zc/                  # Zenith Coordinator logic
│   │   ├── lanes/           # Express / Standard / HTLC / RTP / GTID / High-Value / Bulk
│   │   └── orchestrator/    # State transitions, FinalityLog, bank hub, GTID finalization
│   └── bank/                # Bank mock (core banking, customer API, AML filters)
├── test/                    # vitest integration tests (in-memory SQLite)
├── wrangler.toml.example    # Configuration template (Git-tracked)
└── wrangler.toml            # Actual config (Git-ignored; create yourself)
```

---

## License

MIT License

---

---

# 日本語版 (Japanese Version)

**Zenith Coordinator（ZC）と複数参加銀行のモック実装。**
Cloudflare Workers + D1 + Queues + R2 で動作し、固定費 **¥0**（全サービス無料枠内）。

---

## Zenithとは

日本の決済インフラが長年抱えてきた問題があります。

- 送ったお金が今どこにあるのか分からない
- 障害が起きると、何が起きているのか誰も説明できない
- 問い合わせても「しばらくお待ちください」としか言われない

これは運用の怠慢ではなく、**「当時正しかった設計思想」のまま年月を重ね、社会の要請とずれてきた結果**です。

Zenithはその問いに正面から向き合った、次世代決済基盤の設計構想です。
核心にあるのはシンプルな原則です。

> 決済を「ブラックボックス」ではなく、**「説明できる状態の連なり」** として扱う。

口座管理や顧客情報は引き続き各金融機関が担います。Zenith Coordinator（ZC）が担うのは、**その間で起きる決済の状態を整理し、記録し、説明可能にすること**です。

詳しくは → **[Zenith構想（設計思想・背景）](https://www.sakuolia.jp/zenith.html)**

---

## このモックが存在する理由

Zenithが目指す設計を、**コードとして動かせる形で残すこと**。

仕様書を読むだけでなく、実際にAPIを叩き、状態遷移を追い、決済がどう進むかを手で確認できる環境があれば、議論の解像度が上がります。接続開発に入る前に「このレーンはこう動く」と実感できれば、実装コストも下がります。

銀行・FinTechベンダー向けの、**接続試験・プロトタイピング用リファレンス実装**です。

---

## 主な機能

### 送金レーン（Lane）

| レーン | 概要 |
|--------|------|
| **Express** | 店舗・即時払い向けの高速レーン。H予約で即時確定 |
| **Standard** | 名義確認・承認を挟む標準的な一般送金 |
| **HTLC** | ハッシュタイムロックによる条件付きエスクロー決済 |
| **RTP** | 請求側起点（Pull型）の Request to Pay |
| **High-Value** | プレファンド型 RTGS を仲介する高額レーン |

### その他

- **DNS（日次ネット清算）** — EODバッチ・精算フローのモック
- **QRコード決済** — 動的/静的対応 + HMAC署名検証
- **エイリアス解決** — 電話番号/メールアドレス等から口座を解決
- **Rich Data連携** — 金融コアと商流データ/EDIの分離・参照保持
- **クロスボーダー送金** — FATF R.16 対応
- **フロントエンド UI** — ZC中央管理ダッシュボード（`/`）・行員向けロールダッシュボード（`/console`）・銀行アプリ（`/bank-app`）

---

## 技術スタック

| 用途 | サービス |
|------|---------|
| Runtime | Cloudflare Workers (TypeScript) |
| DB | Cloudflare D1 (SQLite) |
| キュー | Cloudflare Queues |
| ストレージ | Cloudflare R2 |
| デプロイ | Wrangler CLI |

---

## ゼロからのデプロイ手順

### 前提条件

| ツール | バージョン |
|--------|-----------|
| Node.js | 18 以上 |
| npm | 8 以上 |
| Cloudflare アカウント | 無料プランで可 |

---

### 1. リポジトリのクローンと依存インストール

```bash
git clone <this-repo>
cd zenith-mock
npm install
```

---

### 2. wrangler.toml を作成

`wrangler.toml` は個人の Cloudflare アカウント情報を含むため Git 管理外です。
テンプレートをコピーして作成します：

```bash
cp wrangler.toml.example wrangler.toml
```

---

### 3. Cloudflare へログイン

```bash
npx wrangler login
```

ブラウザが開くので Cloudflare アカウントで認証してください。

```bash
npx wrangler whoami  # ログイン確認
```

---

### 4. D1 データベースを作成

```bash
npx wrangler d1 create zenith-db
```

出力例：

```
✅ Successfully created DB 'zenith-db'

[[d1_databases]]
binding = "DB"
database_name = "zenith-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

出力された `database_id` を `wrangler.toml` の該当箇所に貼り付けます：

```toml
[[d1_databases]]
binding       = "DB"
database_name = "zenith-db"
database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← YOUR_DATABASE_ID を置き換える
```

---

### 5. Queues を作成

```bash
npx wrangler queues create zenith-mock-queue
```

---

### 6. R2 バケットを作成

```bash
npx wrangler r2 bucket create zenith-mock-r2
```

---

### 7. マイグレーション（テーブル作成）

```bash
npm run db:migrate:remote
```

完了後、テーブルが作成されたか確認：

```bash
npx wrangler d1 execute zenith-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

28テーブルが表示されれば成功です。

---

### 8. デプロイ

```bash
npm run deploy
```

デプロイ後に表示される URL（例: `https://zenith-mock.<your-subdomain>.workers.dev`）にアクセスすると管理画面が開きます。

---

### 9. 初期データ投入（SEED）

管理画面（`/`）を開き **「SEED」ボタン** をクリックするか、以下のコマンドを実行します：

```bash
curl -X POST https://zenith-mock.<your-subdomain>.workers.dev/internal/seed
```

SEED により以下が初期化されます：

| 内容 | 詳細 |
|------|------|
| 参加行 | `001`（長岡銀行）、`002`（尾張銀行）※初期データ。追加可能 |
| 顧客口座 | 各行2名（残高 各100万円） |
| BOJ プレファンド | 各行 1,000億円 |
| DNS サイクル | 当日分を新規作成 |

---

## ローカル開発

```bash
# ローカル D1 へマイグレーション適用
npm run db:migrate:local

# 開発サーバー起動（http://localhost:8787）
npm run dev
```

---

## スキーマ変更時のデプロイ手順

### カラム追加・テーブル追加

**既存の migration ファイルは絶対に編集しない。** 新しい番号のファイルを追加します：

```bash
# 例: 0011 番台に新ファイルを作成
cat > migrations/0011_add_new_feature.sql << 'EOF'
ALTER TABLE Participants ADD COLUMN new_col TEXT;
EOF

npm run db:migrate:remote
```

### DB を完全リセットしたい場合（開発中のみ）

```bash
# マイグレーション履歴をクリア
npx wrangler d1 execute zenith-db --remote \
  --command "DROP TABLE IF EXISTS d1_migrations"

# または DB ごと作り直す
npx wrangler d1 delete zenith-db
npx wrangler d1 create zenith-db
# → wrangler.toml の database_id を新しい値に更新してから
npm run db:migrate:remote
```

> [!WARNING]
> 既存の migration ファイルを編集してもリモート D1 には反映されません。
> D1 は各ファイルを「適用済み」として記録しており、変更は無視されます。

---

## コマンド一覧

```bash
npm run dev                 # ローカル開発サーバー起動
npm run deploy              # Cloudflare へデプロイ
npm run db:migrate:local    # ローカル D1 へマイグレーション適用
npm run db:migrate:remote   # リモート D1 へマイグレーション適用
npm run type-check          # TypeScript 型チェック
```

---

## ディレクトリ構成

```
zenith-mock/
├── migrations/              # D1 SQLマイグレーション（0001〜0014、番号順に適用）
├── schema/
│   └── baseline.sql         # 全マイグレーション適用後のスキーマ断面（参照用）
├── specs/                   # 仕様書・設計ドキュメント
├── src/
│   ├── index.ts             # Workerエントリーポイント・HTTP/Queue/Cron ディスパッチ
│   ├── types.ts             # 型定義バレル（types/ を re-export）
│   ├── types/               # 型定義（primitives / states / rows / api）
│   ├── shared/              # 共通ユーティリティ（HMAC, ISO20022, FATF, routing 等）
│   ├── cron/                # EODバッチ・タイムアウト巡回
│   ├── dashboard/           # 管理画面 HTML（Alpine.js + Tailwind）
│   ├── openapi/             # OpenAPI スキーマ定義（zc-api / bank-api）
│   ├── zc/                  # Zenith Coordinator ロジック
│   │   ├── lanes/           # Express / Standard / HTLC / RTP / GTID / High-Value / Bulk
│   │   └── orchestrator/    # 状態遷移・FinalityLog・銀行ハブ・GTID ファイナライズ
│   └── bank/                # 銀行モック（勘定系・顧客API・AMLフィルタ）
├── test/                    # vitest 統合テスト（in-memory SQLite）
├── wrangler.toml.example    # 設定テンプレート（Git管理）
└── wrangler.toml            # 実際の設定（.gitignore 対象・各自が作成）
```

---

## ライセンス

MIT License
