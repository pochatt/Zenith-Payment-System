# Zenith Payment System - Repository File Structure

このドキュメントでは、Zenith Payment System モック実装のディレクトリ構造とその役割を説明します。本プロジェクトは Cloudflare Workers, D1 (SQLite), Queues というサーバーレススタックを用いた TypeScript バックエンドと、Alpine.js + Tailwind CSS を用いて構成されたフロントエンドを内包しています。

## ディレクトリ・ファイル構成概要

```text
/
├── .wrangler/          # (自動生成) Cloudflare Wranglerのローカル実行環境データ（ローカルD1のデータベースファイル等を含む）
├── migrations/         # データベーススキーマ（D1 SQLite）のマイグレーションスクリプト群
│   ├── 0001_zc_schema.sql         # ZC（中央基盤）の基本テーブル
│   ├── 0002_bank_schema.sql       # 各参加銀行の基本テーブル
│   ├── ...                        # 各種追加・機能拡張のマイグレーション
│   └── 0009_boj_prefund.sql       # 日銀プレファンド残高のプロビジョニング
│
├── specs/              # 仕様書・設計ドキュメント等のドキュメント群
│   ├── zenith_public.html         # ZC（中央基盤）の対外向け公的仕様書（ビューアー）
│   ├── zenith_public.md           # 基盤の方式設計書・全体マップ
│   ├── zenith_policy.md           # 取引制度・業務ルール等のポリシー定義
│   ├── schema.md                  # データベーステーブルの詳細なスキーマおよび関係の仕様
│   ├── api-contracts.md           # 基盤のAPI I/F仕様やJSONのスキーマ
│   └── file_structure.md          # ［本ファイル］ディレクトリ構造の解説
│
├── src/                # バックエンド・フロントエンドのソースコード（HonoベースのWebサーバー）
│   ├── dashboard/                 # フロントエンドの実装（静的ファイルとしてHonoからServeされる）
│   │   ├── index.html             # ZC（基盤）の全体の稼働状況やダッシュボード画面
│   │   ├── console.html           # 銀行および基盤向けのオペレーションコンソール
│   │   └── bank-app.html          # エンドユーザー（銀行ユーザー）向けのモックアプリ
│   │
│   ├── zc/                        # Zenith Coordinator（決済基盤）のコアドメインロジック
│   │   ├── lanes/                 # 個別レーン（送金の性質ごとの処理）の実装
│   │   │   ├── express.ts         # Fast-track店舗決済等
│   │   │   ├── standard.ts        # 名義確認・オーソリを伴う標準の一般送金
│   │   │   ├── bulk.ts            # 一括決済・LSMキューイング
│   │   │   ├── highvalue.ts       # 日銀RTGS決済を介在する高額送金
│   │   │   ├── htlc.ts            # 条件付きのスマートコントラクト的取引（Hash Time-Lock）
│   │   │   ├── gtid.ts            # グローバルIDによる原子決済・多脚決済
│   │   │   └── rtp.ts             # 請求からのプル型決済（Request to Pay）
│   │   │
│   │   ├── orchestrator.ts        # 取引ステートマシン及び非同期ワーカープロセス
│   │   ├── dns.ts                 # 日次ネット清算（DNS）サイクルの処理
│   │   ├── igs.ts                 # 高額送金等のプレファンド制約即時清算
│   │   ├── ingress.ts             # 基盤側の送金受付APIおよびバリデーション
│   │   ├── qr.ts                  # QRコード（動的・静的）の発行ロジック
│   │   ├── proxy.ts               # Proxy（電話番号・メールアドレス・マイナ等のエイリアス）解決
│   │   ├── cross_border.ts        # クロスボーダー送金・FATF勧告対応ロジック
│   │   ├── edi.ts / richdata.ts   # EDI（企業間データ）およびリッチデータ保持
│   │   └── account_verify.ts      # 事前口座照会・名義確認
│   │
│   ├── bank/                      # モックにおける参加銀行側のAPIとロジック処理
│   │   ├── ingress.ts             # 銀行側（ZCインターフェース群）の受信・ハンドラ
│   │   ├── teller_api.ts          # ZCからの口座状態・残高照会等（テラー用）
│   │   ├── customer_api.ts        # エンドユーザー（バンキングアプリ等）向けAPI
│   │   ├── suspense.ts            # リザーブおよび別段預金等の中間口座処理
│   │   ├── ledger.ts              # モック銀行の残高計算コア
│   │   └── filter.ts              # AML/制裁リスト等の仮フィルタリング実装
│   │
│   ├── openapi/                   # OpenAPI形式でのAPIスキーマ生成
│   │   ├── zc-api.ts              # ZC Core API のスキーマ
│   │   └── bank-api.ts            # 銀行モック API のスキーマ
│   │
│   └── index.ts                   # Honoのメインルーター。API全体のエントリーポイントとワーカー定義
│
├── package.json        # Node.js依存関係定義（Hono, wrangler等）
├── tsconfig.json       # TypeScriptコンパイル設定
└── wrangler.toml       # Cloudflare Workersのデプロイやバインディング定義（KV, D1, Queue等）
```

## システムの動作について
- **エントリーポイント**: `src/index.ts` により、すべてのAPIリクエスト（`/api/*`）およびフロントエンドのルーティングが提供されます。
- **データベース**: Cloudflare D1 (SQLite) を利用し、`migrations/` のファイル群を用いて初期化ならびにスキーマの維持を行います。
- **フロントエンドダッシュボード**: `src/dashboard/` 内のHTMLファイルは、Alpine.js と Tailwind CSS で書かれた Single Page Application (SPA) 的なフロント実装となっており、エンドポイントを叩くことでデモ環境として完結して機能します。
