# Zenith Payment System - Repository File Structure

このドキュメントでは、Zenith Payment System モック実装のディレクトリ構造とその役割を説明します。本プロジェクトは Cloudflare Workers, D1 (SQLite), Queues, R2 というサーバーレススタックを用いた TypeScript バックエンドと、Alpine.js + Tailwind CSS を用いて構成されたフロントエンドを内包しています。

## ディレクトリ・ファイル構成概要

```text
/
├── .wrangler/          # (自動生成) Cloudflare Wranglerのローカル実行環境データ（ローカルD1のデータベースファイル等を含む）
│
├── migrations/         # データベーススキーマ（D1 SQLite）のマイグレーションスクリプト群
│   ├── 0001_zc_schema.sql                  # ZC（中央基盤）の基本テーブル
│   ├── 0002_bank_schema.sql                # 各参加銀行の基本テーブル
│   ├── 0003_trace_filter_htlc_auth.sql     # TxEventLog / AML フィルタ / HTLC Auth
│   ├── 0004_new_settlement.sql             # 新清算方式関連テーブル
│   ├── 0005_rtp_request_rows.sql           # RTP リクエスト格納
│   ├── 0006_rtp_columns.sql                # RTP 関連カラム追加
│   ├── 0007_rtp_respond_columns.sql        # RTP 応答カラム追加
│   ├── 0008_rtp_payee_account.sql          # RTP 受取口座情報
│   ├── 0009_boj_prefund.sql                # 日銀プレファンド残高のプロビジョニング
│   ├── 0010_fix_missing_columns.sql        # 欠落カラム補正
│   ├── 0011_fix_gtid_legs.sql              # GtidLegs スキーマ修正
│   ├── 0012_fix_dns_cycles.sql             # DnsCycles スキーマ修正
│   ├── 0013_retained_earnings_account.sql  # 利益剰余金勘定の追加
│   ├── 0014_circuit_breaker_reversal.sql   # Circuit Breaker / Reversal テーブル
│   ├── 0015_finality_hash_chain.sql        # FinalityLog ハッシュチェーン化（prev_hash / entry_hash 列）
│   ├── 0016_performance_indexes.sql        # ホットパスの索引追加
│   ├── 0017_circuit_breaker_metrics.sql    # CircuitBreakerState に観測メトリクス 6 列追加
│   ├── 0018_bug_fixes.sql                  # B4 approval_ref / B5・B6 FinalityLog 部分UNIQUE / B8 daily reset 列
│   ├── 0019_gtid_chain_fix.sql             # B9 GTID チェーンの prev_hash 部分UNIQUE
│   ├── 0020_hv_threshold.sql               # Participants.hv_threshold（HV 自動エスカレーション閾値）
│   └── 0021_finality_seq_counter.sql       # B10 FinalitySeq カウンタ（event_seq の単調割当）
│
├── schema/             # 統合済みスキーマのスナップショット（レビュー・参照用）
│   └── baseline.sql                        # 全マイグレーションを統合した現時点のベースラインDDL（0015 以降の列が未反映の場合がある — 正は migrations/ と schema.md）
│
├── specs/              # 仕様書・設計ドキュメント等のドキュメント群
│   ├── zenith_public.html                  # ZC（中央基盤）の対外向け公的仕様書（ビューアー）
│   ├── zenith_public.md                    # 基盤の方式設計書・全体マップ
│   ├── zenith_policy.md                    # 取引制度・業務ルール等のポリシー定義
│   ├── schema.md                           # データベーステーブルの詳細なスキーマおよび関係の仕様
│   ├── api-contracts.md                    # 基盤のAPI I/F仕様やJSONのスキーマ
│   ├── architecture.md                     # 横断実装規約（errors / logger / lane helpers）とロードマップ
│   └── file_structure.md                   # ［本ファイル］ディレクトリ構造の解説
│
├── src/                # バックエンド・フロントエンドのソースコード（素の Cloudflare Workers fetch ハンドラ）
│   ├── index.ts                            # Worker エントリーポイント・HTTP ルータ・Queue/Cron ハンドラ
│   ├── html.d.ts                           # `.html` を文字列としてインポートするための型宣言
│   ├── types.ts                            # 全型定義の単一バレル（下記 types/ を re-export）
│   │
│   ├── types/                              # 型定義モジュール（`src/types.ts` 経由で参照）
│   │   ├── primitives.ts                   # `Env` / `Amount` / `BankProofRef` / FATF データ型
│   │   ├── states.ts                       # ステート文字列ユニオン（`TxState` / `HtlcState` / `GtidState` / `DnsState`）
│   │   ├── rows.ts                         # D1 行型（`Transactions` / `Participants` / `BankAccounts` 他）
│   │   └── api.ts                          # HTTP 入出力型・Queue メッセージ型
│   │
│   ├── shared/                             # ZC/銀行で共用のユーティリティ
│   │   ├── constants.ts                    # システム定数・設定値
│   │   ├── errors.ts                       # DomainError / errorResponse / reason_code → category 写像（HTTP & retry の SoT）
│   │   ├── logger.ts                       # newRequestLogger（1イベント1JSON、X-Request-Id、PII 自動 redaction）
│   │   ├── hmac.ts                         # HMAC-SHA256 署名・検証（Web Crypto）
│   │   ├── idempotency.ts                  # Idempotency-Key 制御
│   │   ├── iso20022.ts                     # ISO 20022 メッセージ生成・全銀固定長変換
│   │   ├── format_converter.ts             # 全銀フォーマット ↔ 新電文変換
│   │   ├── routing.ts                      # ルーティング・BIC/bank_id マッピング
│   │   ├── fatf_validator.ts               # FATF R.16 コンプライアンス検証
│   │   ├── proof.ts                        # BankProofRef 生成
│   │   ├── request-id.ts                   # 決定論的リクエストID生成
│   │   └── validator.ts                    # ZC Ingress API ペイロードのスキーマ検証
│   │
│   ├── cron/                               # Cron トリガーで起動するバッチ処理
│   │   ├── eod.ts                          # EOD 8 ステップ（DNS kick/settle・利息計上・残高スナップショット等）
│   │   └── timeout_sweep.ts                # 1 分毎の停滞取引・HTLC タイムロック・GTID 失効処理
│   │
│   ├── dashboard/                          # フロントエンドの実装（静的HTMLとして Worker から Serve される）
│   │   ├── index.html                      # ZC（基盤）の全体の稼働状況やダッシュボード画面（/, /dashboard）
│   │   ├── console.html                    # 銀行および基盤向けのオペレーションコンソール（/console）
│   │   ├── bank-app.html                   # エンドユーザー（銀行ユーザー）向けのモックアプリ（/bank-app）
│   │   ├── theater.html                    # Settlement Theater — 状態遷移アニメーション（/theater, /theatre）
│   │   └── sky.html                        # Sky モード — システム俯瞰ビュー（/sky）
│   │
│   ├── openapi/                            # OpenAPI 形式での API スキーマ生成
│   │   ├── zc-api.ts                       # ZC Core API のスキーマ
│   │   └── bank-api.ts                     # 銀行モック API のスキーマ
│   │
│   ├── zc/                                 # Zenith Coordinator（決済基盤）のコアドメインロジック
│   │   ├── ingress.ts                      # 基盤側の送金受付 API・バリデーション（/api/*・/internal/*）
│   │   ├── orchestrator.ts                 # Queue consumer 本体（ingress から orchestrator/* を呼び分け）
│   │   ├── orchestrator/                   # 非同期ワーカーの分割実装
│   │   │   ├── state_machine.ts            # ALLOWED_TRANSITIONS / isValidTransition（全遷移の Single Source of Truth）
│   │   │   ├── finality.ts                 # FinalityLog 追記・取消・SUSPENDED 確定
│   │   │   ├── bank_hub.ts                 # ZC→銀行 内部呼び出しハブ（Circuit Breaker ゲート適用）
│   │   │   └── gtid.ts                     # GTID 多脚ファイナライズ判定
│   │   │
│   │   ├── lanes/                          # 個別レーン（送金の性質ごとの処理）の実装
│   │   │   ├── _helpers.ts                 # 共通プリミティブ（transitionWithLog: ALLOWED_TRANSITIONS 検証 + CAS+FinalityLog の atomic batch、cancelInFlightTx: TOCTOU安全な取消順）
│   │   │   ├── express.ts                  # Fast-track 店舗決済等（H 予約で即時確定）
│   │   │   ├── standard.ts                 # 名義確認・オーソリを伴う標準の一般送金
│   │   │   ├── bulk.ts                     # 一括決済・LSM キューイング
│   │   │   ├── highvalue.ts                # 日銀 RTGS 決済を介在する高額送金（H 予約スキップ）
│   │   │   ├── htlc.ts                     # 条件付きスマートコントラクト的取引（Hash Time-Lock）
│   │   │   ├── htlc_auth.ts                # HTLC Auth バレル（受取側起点オーソリ）
│   │   │   ├── htlc_auth/                  # HTLC Auth 機能分割
│   │   │   │   ├── whitelist.ts            # 加盟店ホワイトリスト管理（register / revoke / list）
│   │   │   │   ├── request.ts              # 受取側オーソリリクエスト + 送金側 decline
│   │   │   │   ├── approve.ts              # 送金側承認（preimage 生成 + canonical RECEIVED → HTLC_LOCKED）
│   │   │   │   ├── capture.ts              # 受取側キャプチャ + ボイド
│   │   │   │   └── query.ts                # オーソリ参照（list / get）
│   │   │   ├── gtid.ts                     # グローバル ID による原子決済・多脚決済
│   │   │   ├── rtp.ts                      # RTP バレル
│   │   │   └── rtp/                        # RTP 機能分割
│   │   │       ├── register.ts             # RTP 請求作成・支払人通知
│   │   │       ├── respond.ts              # 支払人 accept / decline
│   │   │       └── query.ts                # RTP 参照・期限切れ cron sweep
│   │   │
│   │   ├── dns.ts                          # 日次ネット清算（DNS）サイクルの処理
│   │   ├── igs.ts                          # 高額送金等のプレファンド制約即時清算
│   │   ├── h_model.ts                      # H-limit（二者間ネット送信上限）予約・解放
│   │   ├── qr.ts                           # QR コード（動的・静的）の発行ロジック
│   │   ├── proxy.ts                        # Proxy（電話番号・メールアドレス・マイナ等エイリアス）解決
│   │   ├── pspr.ts                         # Pre-Shared Payment Reference 登録・参照
│   │   ├── cross_border.ts                 # クロスボーダー送金・FATF 勧告対応
│   │   ├── edi.ts                          # EDI（企業間データ）
│   │   ├── richdata.ts                     # リッチデータ（金融コアと商流データの分離）
│   │   ├── account_verify.ts               # 事前口座照会・名義確認
│   │   ├── credit_notify.ts                # 受取銀行への入金通知（指数バックオフ再送）
│   │   ├── trace.ts                        # TxEventLog 追記（状態遷移・銀行呼出・監査証跡）
│   │   ├── case.ts                         # CASE（紛争・例外）管理 OPEN→IN_PROGRESS→RESOLVED/ESCALATED
│   │   ├── reversal.ts                     # Reversal（b ファイナリティ後の救済別取引）
│   │   ├── circuit_breaker.ts              # 参加行ヘルス監視と段階的遮断・再開
│   │   ├── finality_chain.ts               # FinalityLog の SHA-256 ハッシュチェーン計算・検証
│   │   ├── explain.ts                      # GET /api/transactions/:txid/explain（理由付き timeline + 改ざん検知）
│   │   ├── story.ts                        # GET /api/transactions/:txid/story（ナラティブ + Mermaid + 健全性）
│   │   ├── query.ts                        # Transaction 参照 API（Appendix E.6 QueryResponse）
│   │   ├── stream.ts                       # 銀行向け SSE（tx_state_change / credit_notification / rtp_request）
│   │   ├── stream_rafiki.ts                # Rafiki風ストリーミング決済 WebSocket/DOバッファ
│   │   ├── als.ts                          # Mojaloop風 アカウントエイリアス解決(KVキャッシュ)
│   │   ├── limit_do.ts                     # TigerBeetle風 H限度額の直列化・排他制御(Durable Object)
│   │   └── vault.ts                        # 短期機密データ貯蔵（AML 評価・PII・TTL 管理）
│   │
│   └── bank/                               # モックにおける参加銀行側のAPIとロジック処理
│       ├── ingress.ts                      # 銀行側（ZC インターフェース群）の受信・ハンドラ（/bank/*）
│       ├── teller_api.ts                   # ZC からの口座状態・残高照会等（テラー用）
│       ├── customer_api.ts                 # エンドユーザー（バンキングアプリ等）向け API
│       ├── ledger.ts                       # モック銀行の残高計算・ゼロサム複式仕訳コア
│       ├── suspense.ts                     # リザーブおよび別段預金等の中間口座処理
│       └── filter.ts                       # AML/制裁リスト等の仮フィルタリング実装
│
├── test/               # vitest テスト群（in-memory SQLite で src/ と並走する統合テスト）
│   ├── helpers/
│   │   └── d1-mock.ts                      # MockD1Database ファクトリ（better-sqlite3）
│   ├── shared/                             # shared/ 層の単体テスト（hmac, validator）
│   ├── bank/                               # 銀行側ロジックのテスト（ledger）
│   └── zc/                                 # ZC レーン・h_model・DNS・circuit_breaker 等のテスト
│
├── remote_participants.json                # リモート環境での参加行シードデータ
├── test.json                               # ローカル動作確認用の試験ペイロード
├── package.json                            # Node.js 依存関係定義（wrangler, vitest, better-sqlite3 等。Web フレームワークは使わず素の Workers fetch ハンドラ）
├── tsconfig.json                           # TypeScript コンパイル設定
├── tsconfig.test.json                      # テスト用 TypeScript 設定
├── vitest.config.ts                        # vitest 設定
└── wrangler.toml                           # (Git 管理外) Cloudflare Workers のデプロイ・バインディング定義（D1, Queue, R2, Cron 等）
```

## システムの動作について

- **エントリーポイント**: `src/index.ts` により、すべての HTTP ルーティング（`/api/*`・`/bank/*`・`/internal/*`・ダッシュボード）、Queue メッセージのディスパッチ、Cron ジョブの起動を集約します。
- **データベース**: Cloudflare D1 (SQLite) を利用し、`migrations/` の連番ファイル群を順次適用して初期化ならびにスキーマ維持を行います。既存マイグレーションの編集は不可で、変更は必ず新しい番号のファイルを追加します。`schema/baseline.sql` は全マイグレーション適用後のスキーマ断面を示す参照資料です。
- **ドメイン分割**: ZC（中央基盤）のコアは `src/zc/` に、参加銀行のモックは `src/bank/` に分かれます。両者から呼ばれる純粋ユーティリティは `src/shared/` に集約しています。
- **非同期処理**: Queue consumer（`src/zc/orchestrator.ts` とその配下の `orchestrator/`）が状態遷移の実行役となり、`src/cron/` は EOD 清算とタイムアウト掃引を担当します。
- **型定義の単一化**: 型はすべて `src/types.ts` から公開され、実体は `src/types/` 配下の 4 つのサブモジュールに分割されています。利用側は常に `src/types.ts` からのみインポートします。
- **フロントエンドダッシュボード**: `src/dashboard/` 内の HTML ファイルは、Alpine.js と Tailwind CSS で書かれた SPA 的なフロント実装で、Worker が `Response(htmlString)` で静的 Serve します。
- **テスト**: `test/` は `src/` のディレクトリ構成をミラーし、`test/helpers/d1-mock.ts` が提供する in-memory SQLite（better-sqlite3）を用いた統合テストとして動作します。
