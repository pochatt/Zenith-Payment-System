# Zenith Payment System — Mock Implementation

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
| 参加行 | `001`（みずほ銀行）、`002`（三菱UFJ銀行）※初期データ。追加可能 |
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
