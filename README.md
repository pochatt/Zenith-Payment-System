# Zenith Payment System — Mock Implementation

> **Zenith** は全銀ネットが策定した次世代即時決済アーキテクチャです。
> 本リポジトリは **参加銀行向けインテグレーション開発・接続試験用のモック実装** です。

---

## 関連ドキュメント

| ドキュメント | URL |
|-------------|-----|
| 全銀ネット 公式アナウンスメント（2026年3月） | [announcement_20260319-3.pdf](https://www.zengin-net.jp/announcement/pdf/announcement_20260319-3.pdf) |
| Zenith 方式設計・仕様書 | [sakuolia.jp/zenith.html](https://www.sakuolia.jp/zenith.html) |

---

## このモックの目的

銀行・FinTechベンダーが **Zenith本番環境への接続前** に、以下を自前環境で検証するためのリファレンス実装です：

- **API契約の確認** — ZC（Zenith Coordinator）との送受信フォーマット・ステートマシンをエンドツーエンドで試せる
- **多レーン対応の実装検証** — Express / Standard / HTLC / RTP / High-Value の挙動差異を実際に叩いて確認できる
- **日次ネット清算（DNS）の動作確認** — EODバッチ・精算フローをローカルで再現できる
- **無料で動く** — Cloudflare Workers の無料枠のみで動作。インフラコスト **¥0**

---

## 主な機能

- **各種送金レーン（Lane）**
  - **Express**: 店舗・即時払い向けの高速レーン
  - **Standard**: 名義確認・承認を挟む標準的な一般送金
  - **HTLC**: ハッシュタイムロックコントラクトによる条件付きエスクロー
  - **RTP**: 請求側起点（Pull型）の送金（Request to Pay）
  - **High-Value**: プレファンド型のRTGS（即時グロス決済）を仲介する高額レーン
- **DNS（日次ネット清算）モック機能**
- **フロントエンドダッシュボード**
  - 中央管理者用ダッシュボード（`/`）
  - オペレーションコンソール（`/console`）
  - エンドユーザー向け銀行アプリ（`/bank-app`）
- **モダン機能プロファイル**
  - QRコード決済（動的/静的対応 + HMAC署名検証）
  - エイリアス解決（電話番号/メールアドレス等から口座を解決）
  - Rich Data連携（金融コアと商流データ/EDIの分離・参照保持）
  - クロスボーダー送金・FATF R.16 対応

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
| 参加行 | `001`（みずほ銀行）、`002`（三菱UFJ銀行） |
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
├── migrations/              # D1 SQLマイグレーション（0001〜順番に適用）
├── src/
│   ├── index.ts             # Workerエントリーポイント・ルーター
│   ├── types.ts             # 全共通型定義（唯一の型定義ファイル）
│   ├── zc/                  # Zenith Coordinator ロジック
│   ├── bank/                # 銀行モック（勘定系・顧客API）
│   ├── shared/              # 共通ユーティリティ
│   ├── cron/                # EODバッチ・タイムアウト巡回
│   └── dashboard/           # 管理画面 HTML
├── wrangler.toml.example    # 設定テンプレート（Git管理）
└── wrangler.toml            # 実際の設定（.gitignore 対象・各自が作成）
```

---

## ライセンス

MIT License
