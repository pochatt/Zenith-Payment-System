# Zenith Payment System

> 決済を「ブラックボックス」ではなく、「説明できる状態の連なり」として扱うための、共通基盤の参照実装です。
> — Zenith 構想より

---

## 日本語

### この文書について

このリポジトリは、**Zenith Coordinator（ZC）** という構想の参照実装です。

かつて銀行のなかで決済の制度・サービス企画と、政府渉外（規制当局・関係省庁との対話）に携わっていた個人が、現在はまったく異なる仕事をしている立場から、**機密資料は一切用いずに**、「こうした基盤があれば、日本の決済はもう一段上に行けるかもしれない」という願いをこめて、基本コンセプトから書き起こしたものです。

業務知見をもとに「決済を説明可能な状態機械として扱う」という設計思想を一貫して通し、TypeScript と Cloudflare Workers のうえで、最後まで動くところまで実装してあります。趣味で書いたものなので、現実のいずれの組織・システム・運用も示していません。

構想そのものの出発点は、別ページにまとまっています：[Zenith 構想・基本コンセプト](https://www.sakuolia.jp/zenith.html)

### なぜ作ったのか

日本の決済システムは、世界水準で見ても堅牢で、長く安定して動いてきました。これは多くの先達と現場の積み重ねの結果です。一方で、利用者の側から眺めたときの **「いま、自分のお金がどこにあるのか」「なぜ遅れているのか」「誰に聞けば分かるのか」** といった説明可能性については、まだ伸びしろが残っているように感じています。

Zenith 構想は、既存のレールを置き換えるものではありません。各金融機関の勘定系と口座管理は、これまで通りそれぞれの責任のもとに置いたまま、**その「間」で起きていることを、後からでも同じ取引番号で説明できる**ようにする協調層を、社会の共有物として描き直す試みです。

この実装は、その構想を読み物として伝えるだけでなく、**手で触れて動かせる形** にすることを意図しています。

### このシステムは何をするか・何をしないか

- **すること**：複数の銀行のあいだで起きる決済を、**受理 → Decision（決定）→ Execution（実施確認）→ b（確定）** という状態の連なりに固定し、すべての状態遷移を追記専用の FinalityLog に記録します。利用者・事業者・当局のいずれに対しても、同じ取引番号で同じ説明ができるようにします。
- **しないこと**：参加者の勘定系・口座管理を置き換えません。本人確認・与信・限度管理の基準は各参加主体の裁量に委ねます。法的判断は行いません。

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

詳細は [`specs/zenith_public.md`](specs/zenith_public.md) に書きました。

### 同じ語彙で TradFi と DeFi を語る

Zenith は、伝統的決済レール（RTGS、DNS ネッティング、全銀系リテール、ISO 20022、FATF R.16）と、新しい原始要素（ハッシュタイムロック、原子マルチレグ）を、**橋渡し（bridge）ではなく、同じ状態機械のうえに並ぶレーン** として扱います。

| レーン | 出自 | ファイナリティ原始要素 |
| --- | --- | --- |
| EXPRESS / STANDARD / BULK | 伝統系（リテール、全銀系） | H 予約 + ネッティング |
| HIGH_VALUE | 伝統系（中央銀行 RTGS） | 即時グロス決済 |
| DNS サイクル | 伝統系（清算機関） | 日次ネットポジション |
| HTLC / HTLC_AUTH | DeFi ネイティブ | ハッシュロック + タイムロック |
| GTID | ハイブリッド（原子マルチレグ） | レッグ横断 all-or-nothing |
| RTP | ハイブリッド（受取人発起プル） | 名義確認 + 事前承認 |

公開されている先行研究と Zenith は、扱っている層が異なります。BIS Project Stella Phase 2、Jasper-Ubin、Agorá、mBridge、Partior、Fnality、JPM Onyx、Canton Network、DCJPY / Progmat などは、いずれも **通貨そのもの**(ホールセール CBDC、トークン化預金、プログラマブル通貨)や **共通台帳の構造** を再設計する研究、つまり決済の **下層** を問い直す試みです。Zenith が扱うのは、現行の商業銀行貨幣と既存の銀行勘定をそのまま前提にしたうえで、その **上に被せる調整層(coordination layer)** の設計です。両者は競合ではなく、隣り合う層の話をしています。

その上で、Zenith が公開文献の範囲で先行していると考えられる点は、次の三つに絞られます。

- **HTLC・GTID 原子マルチレグ・RTGS・DNS ネッティングを、橋渡しではなく、ひとつの状態機械の対等なレーンとして並べたオープンソース実装。** 上記の先行研究は、いずれもこの表の一部のレーンを、それぞれ別の台帳・別のアーキテクチャ上で扱っています。
- **状態遷移と FinalityLog 書込みのアトミック強制、および単一 trace ID による生涯トレース。** 下層を問い直す研究は通貨・台帳の設計に集中するため、説明可能性プロトコルをこの粒度まで詰めた公開実装は、知る限り他にありません。
- **DNS_HOLD 時の流動性供給カスケードを、コードと同じ温度の規程文書として書き切った点**([`specs/zenith_policy.md`](specs/zenith_policy.md))。

逆に、Zenith が **意図的に扱わない** 領域も明示しておきます。トークン化預金・ホールセール CBDC、クロスボーダー多通貨原子決済、プライバシー原始要素(ZKP・機密取引)、agent identity・委任プロトコル ── これらは上記の先行研究や各国 CBDC プロジェクトの主戦場であり、Zenith はそれらと **同じ層を取り合わない** 設計選択をしています。下層の選択(現行通貨か CBDC か、既存台帳かトークン化台帳か)が変わっても、上に被せる調整層・説明可能性層のリファレンスとして機能することを意図しています。

実装は [`src/zc/orchestrator/state_machine.ts`](src/zc/orchestrator/state_machine.ts) と [`src/zc/lanes/`](src/zc/lanes/) を参照してください。

#### 補論：状態機械と元帳の同型性 ── 下層を作り直す読者へ

Zenith が調整層であるという最初の選択を変えないまま、もうひとつだけ観察を残しておきます。

構成要素を分解してみると、Zenith は permissioned blockchain（特に許可型 EVM 系チェーン）と **構造的にほぼ同型** です。これは偶然ではなく、両者の根に **追記専用ログ + 明示的な状態機械 + 状態遷移のアトミック性** という同じ三点セットがあるからです。

| Zenith の概念 | 許可型 EVM チェーンの対応物 |
| --- | --- |
| FinalityLog（`prev_hash` チェーン込み） | ブロックチェーン（正準チェーン） |
| `ALLOWED_TRANSITIONS` テーブル | Solidity コントラクトの状態遷移 |
| `transitionWithLog`（CAS UPDATE + ログ INSERT のバッチ） | EVM トランザクション（不可分な状態変更） |
| レーン（EXPRESS / HTLC / GTID …） | コントラクトファミリー |
| H-Model（予約・確定・解放） | ERC-20 + allowance + reserve コントラクト |
| `version` 列（楽観ロック） | nonce / sequence チェック |
| 冪等キー | トランザクションハッシュの一意性 |
| `Participants` テーブル | バリデータ／許可口座 allowlist |
| GTID の原子マルチレグ | コントラクト横断のアトミックコンポーザビリティ |

この同型性は、ホールセール CBDC・トークン化預金・共通台帳といった下層に関心を持つ読者にとって、ひとつの示唆を含みます。すなわち、**「中央銀行マネーをパブリックチェーンに wrap する」（Lock and Mint）と「中央銀行が自前で許可型チェーンを立てる」では、難易度の方向がまったく違う** ということです。

前者は、ファイナリティモデルの不整合（即時・法的ファイナル vs 確率的ファイナル）と、ブリッジ保管リスク（Ronin・Wormhole・Nomad の前例）という、**立法では消せない問題** を抱え込みます。wrap された瞬間、そのトークンは中央銀行マネーではなく、ロックされた準備預金に対する私的請求権に変わります。

後者は ── もしそういう判断がなされるなら ── 既存の RTGS の責務をチェーン状の元帳に置き直すという、純粋に設計の話に閉じます。EVM 互換性すら本質ではありません。それは Solidity を書ける開発者人口を取り込むための手段であって、**ファイナリティ・原子性・監査性そのものは EVM とは独立に成立している** からです。Zenith の状態機械と FinalityLog は、その「EVM とは独立に成立している部分」を、TypeScript と D1 のうえで実装してみせたものに過ぎません。同じ三点セットを、BFT 即時ファイナルの分散合意層と HSM バックドの署名鍵のうえに置き直せば、それはそのまま許可型の元帳になります。

繰り返しますが、これは Zenith が CBDC 基盤を目指す宣言ではありません。Zenith は調整層のリファレンスのままです。ただ、**設計の語彙には上下方向の互換性がある** ── 上に被せる調整層としても、下に置き直す元帳としても、ほぼそのまま機能する ── ということは、層を取り合わないという最初の選択と矛盾しません。リファレンス実装の意義は、層をまたいで読み替えてもらえることにあると考えています。

### 「制度」として書かれている部分

このリポジトリの特色は、コードや方式設計と並んで、**制度（規程・ガバナンス）の文書を同じ語彙・同じ温度で書いている** ことだと考えています。

- 4 眼承認、ブレークグラス手続き
- 利用目的コード（P01〜P07）と最小化原則
- DNS_HOLD 時の初動連絡・公表統制・LPB（流動性供給銀行）スキーム・共同拠出・最終的な中央銀行手当の発動順序
- WORM 保全と第三者保証の接続
- 「規範」と「推奨」の使い分け

これらは [`specs/zenith_policy.md`](specs/zenith_policy.md) に集約しています。技術仕様だけでは決済システムは社会に着地しないため、**制度面までを同じ姿勢で書き切る** ことを大切にしました。

### 触れてみる

#### 必要なもの

- Node.js 18 以上
- npm 8 以上
- Cloudflare アカウント（無料枠で動作）

#### ローカルで動かす

```bash
git clone https://github.com/pochatt/zenith-payment-system.git
cd zenith-payment-system
npm install
npm run db:migrate:local
npm run dev   # http://localhost:8787
```

#### Cloudflare 上にデプロイする

```bash
npx wrangler login
npx wrangler d1 create zenith-db
npx wrangler queues create zenith-mock-queue
npx wrangler r2 bucket create zenith-mock-r2
cp wrangler.toml.example wrangler.toml
# wrangler.toml の database_id 等を埋める
npm run db:migrate:remote
npm run deploy
curl -X POST https://<your-worker>.workers.dev/internal/seed
```

ダッシュボードはデプロイ先 URL のルートで表示されます。

### コマンド一覧

```bash
npm run dev               # ローカル開発サーバー
npm run deploy            # Cloudflare へデプロイ
npm run type-check        # TypeScript 型チェック
npm run test              # テストスイート（399 ケース）
npm run test:watch        # ウォッチモード
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

すべての状態遷移は `transitionWithLog` ヘルパを通り、`Transactions` への CAS UPDATE と `FinalityLog` への INSERT を 1 つの D1 バッチでアトミックに発行します。**「状態だけが進んで監査ログが残らない窓」は構造的に存在しません。**

### API のかたち（最小例）

```bash
# 送金の起票
POST /api/transfers
Content-Type: application/json

{
  "schema_version": "1.0",
  "message_type": "EVENT",
  "name": "PaymentInitiated",
  "txid":  "TX-...",
  "lane":  "EXPRESS",
  "amount": { "value": 5000, "currency": "JPY" },
  "payer":  { "bank_id": "001", "account_hash": "h:..." },
  "payee":  { "bank_id": "002", "account_hash": "h:..." }
}

# 取引の照会（誰が照会しても、同じ取引番号で同じ説明が返る）
GET /api/transactions/TX-...
```

エンドポイントの全容は [`specs/api-contracts.md`](specs/api-contracts.md) に記載しています。

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

横断機能：

- 日次ネット清算（DNS）サイクル管理
- 限度額直列化（TigerBeetle 流 Durable Object）
- ディレクトリ ALS（O(1) エイリアス解決キャッシュ）
- ストリーミング・マイクロ決済（Rafiki 流）
- QR 決済（静的／動的、HMAC 検証）
- エイリアス解決（電話・メール・法人 ID）
- FATF R.16 に沿ったクロスボーダー
- 口座名義確認、EDI／リッチデータ
- サーキットブレーカと自動健全性監視
- SSE による参加銀行向けイベントストリーム

### テスト

```bash
npm run test                          # 全 399 ケース
npx vitest test/zc/express.test.ts    # 単一ファイル
```

`better-sqlite3` を D1 のインメモリ・モックとして用い、本物のスキーマに対して並行処理・冪等再送・ゼロサム残高不変条件・サーキットブレーカ復帰などを統合的に検証します。`test/integration/balance_invariants.test.ts` では、各レーンについて「payer 顧客 Δ = −amount」「payee 顧客 Δ = +amount」「行内ゼロサム」「BOJ 系の保存則」を仕訳まで往復で固定しています。

### 文書地図

このリポジトリは **構想（読み物）→ 方式設計 → 制度・ガバナンス → インタフェース／データ** の四層で整理しています。

- **構想（読み物）**
  - [Zenith 構想・基本コンセプト](https://www.sakuolia.jp/zenith.md)
  - [`specs/walkthrough.md`](specs/walkthrough.md) — 口座振替を題材にした、5 分で雰囲気をつかむための短い案内
- **方式設計**
  - [`specs/zenith_public.md`](specs/zenith_public.md) — 設計思想、状態機械、レーン別フロー、補遺 A〜F（全 15 章）
  - [`specs/architecture.md`](specs/architecture.md) — 横断的な実装規約と、コード品質を引き上げるためのロードマップ
- **制度・ガバナンス**
  - [`specs/zenith_policy.md`](specs/zenith_policy.md) — 規程、データガバナンス、DNS_HOLD 時の発動順序
- **インタフェース／データ**
  - [`specs/api-contracts.md`](specs/api-contracts.md) — エンドポイント一覧と Error Catalog
  - [`specs/schema.md`](specs/schema.md) — テーブル定義、マイグレーション運用、Index Catalog
  - [`specs/file_structure.md`](specs/file_structure.md) — ディレクトリ構成

### 実装の現状と限界（誠実に）

このリポジトリは個人による趣味の参照実装であり、本番運用を意図したものではありません。

- 銀行ーコーディネータ間は HMAC-SHA256 署名検証のみです。TLS / mTLS、認証・認可、保存時暗号化、規制適合の制御は実装範囲外です。
- パフォーマンスの値は Cloudflare の開発環境での観測値であり、本番ワークロードでの保証ではありません。
- 一部の規範要件（DNS_HOLD の igs_mode 階層遷移、長期 H_locked の自動解放、`MisrecordCorrected`、Bulk LSM の最適化、GTID の N:M fan-in / fan-out など）は方式設計に記述しましたが、実装は道半ばです。詳細は [`specs/architecture.md`](specs/architecture.md) § 7 を参照してください。

意図は **実物の代わりではなく、議論のたたき台** を提供することです。

### 想定する読者

- 決済の制度・サービス企画にかかわるかた、または関心のあるかた
- 銀行・決済事業者のシステム部門、システムインテグレータのエンジニアのかた
- 中央銀行・規制当局周辺で、説明可能性や監査性に関心のあるかた
- 学生、研究者、個人開発者のかた

異なる立場のかたに、それぞれの視点で読んでいただけるよう、構想・方式・制度・コードを同じ温度で並べました。

### ご自由にお使いください

この資料は、どのような形でお使いいただいても構いません。中身をまるごと持ち帰っていただいても、考え方の一部だけを汲み取っていただいても、どちらも嬉しく思います。いつかそのプロジェクトが形になったとき、「Zenith を叩き台にした」と一言添えてくださるなら、それで十分です。

### ライセンス

MIT License。詳細は [LICENSE](LICENSE) をご覧ください。

### 連絡

- 質問・議論：[GitHub Issues](https://github.com/pochatt/zenith-payment-system/issues)
- 構想全体：[Zenith 構想（sakuolia.jp）](https://www.sakuolia.jp/zenith.md)

> このリポジトリと付属文書はフィクションであり、実在のいずれの組織・システム・運用も示していません。

---

## English

### About this document

This repository is a reference implementation of the **Zenith Coordinator (ZC)** concept.

It was written by an individual who once worked on payment-system planning and government relations inside the Japanese banking sector, and who is now in a different line of work. **No confidential material has been used**; everything here has been rebuilt from first principles, as a personal project, in the hope that — with a coordination layer of this kind — Japan's payment infrastructure could take one more step forward.

The implementation runs end-to-end on TypeScript and Cloudflare Workers. It is a reference, not a system in operation, and it does not represent any real institution, system, or way of working.

The starting concept lives on a separate page: [Zenith concept (Japanese)](https://www.sakuolia.jp/zenith.md).

### Why this exists

Japan's payment systems are, by international standards, robust, and they have been remarkably stable for a long time. That stability is the work of many people across decades, and it deserves respect.

What still feels incomplete, from the user's side, is **explicability** — knowing where one's money is at this moment, why something is delayed, and who can answer when one asks.

Zenith is not a replacement for the existing rails. Each financial institution keeps its own core banking and account management exactly as today. Zenith reimagines, as a shared public good, the **coordination layer** that sits between institutions, so that whatever happens in that space can later be explained, by anyone, under a single transaction identifier.

This implementation is meant not only to be read, but to be run and touched.

### What it does, and what it does not

- **It does:** treat each settlement as an explicit sequence of states — **Acceptance → Decision → Execution Confirmation → Finality (b)** — across multiple banks, and record every transition in an append-only FinalityLog, so that users, businesses, and authorities can each obtain the same explanation under the same transaction id.
- **It does not:** replace participants' core banking or account ledgers; decide identity, credit, or limits; or take legal positions. Those remain with the participants.

### Design principles, in ten lines

1. The single source of truth is the **Finality Log**. Derived views can be discarded and rebuilt.
2. **Decision and Execution are always separated**.
3. The irreversible boundary is **b (PAYEE_EXEC_CONFIRMED)**. Remedies after b are Reversals, posted as new transactions.
4. **States that cannot be explained are forbidden.** Unresolved or inconsistent states must converge into a CASE.
5. The meaning of a synchronous response is fixed by contract.
6. Evidence is never added after the fact.
7. Lanes are not UX categories — they are **contracts about finality points and evidence**.
8. **H (sending-side over-limit)** is managed as a state; absolute over-limit is impossible by construction.
9. Crisis handling is not an exception path; it is an **institutionalised state transition**.
10. Single-truth integrity is held by a distributed consensus log; under quorum loss, the system degrades to read-only rather than risk a wrong decision.

The full text lives in [`specs/zenith_public.md`](specs/zenith_public.md).

### TradFi and DeFi in one vocabulary

Zenith expresses traditional payment rails (RTGS, DNS netting, Zengin-style retail, ISO 20022, FATF R.16) and newer cryptographic primitives (hash-time-locked contracts, atomic multi-leg) **not as separate ledgers joined by a bridge, but as different lanes on the same state machine**:

| Lane | Heritage | Finality primitive |
| --- | --- | --- |
| EXPRESS / STANDARD / BULK | TradFi (retail, Zengin) | H-reserve + netting |
| HIGH_VALUE | TradFi (central-bank RTGS) | Real-time gross settlement |
| DNS cycle | TradFi (clearing house) | End-of-day net position |
| HTLC / HTLC_AUTH | DeFi-native | Hash-lock + time-lock |
| GTID | Hybrid (atomic multi-leg) | All-or-nothing across legs |
| RTP | Hybrid (pull-based, payee-initiated) | Name verification + authorisation |

Zenith and the most-cited public precedents operate at different layers. BIS Project Stella Phase 2, Jasper-Ubin, Agorá, mBridge, and platforms such as Partior, Fnality, JPM Onyx, Canton Network, and DCJPY / Progmat reach into the **monetary substrate** itself — tokenised deposits, wholesale CBDC, programmable money on a unified ledger — and rethink the **lower layer** of payments. Zenith does the opposite: it takes commercial-bank money and existing bank ledgers as given, and designs a **coordination layer that sits on top of them**. The two are adjacent layers, not competing designs.

Within that scope, three contributions of Zenith do not appear, to our knowledge, in the public literature:

- **HTLC, GTID atomic multi-leg, RTGS, and DNS netting expressed as coequal lanes inside one orchestrator's state machine** — not as separate ledgers joined by a bridge. The precedents above each address only part of this table, on a different ledger or architecture.
- **Atomic pairing of state transitions with FinalityLog writes, plus full lifecycle tracing under a single trace ID.** Research that rethinks the substrate concentrates its design effort on currency and ledger structure; we are not aware of another public implementation that has pushed an explicability protocol to this granularity.
- **A liquidity-cascade rulebook for DNS_HOLD scenarios, written at the same fidelity as the code** ([`specs/zenith_policy.md`](specs/zenith_policy.md)).

We are equally explicit about what Zenith **does not** attempt: tokenised deposits or wholesale CBDC, cross-border multi-currency atomic settlement, privacy primitives (ZKP / confidential transactions), and agent identity or delegation protocols. Those are the home territory of the precedents above and of national CBDC programmes; Zenith deliberately stays out of that layer. The intent is that the coordination and explicability layer described here remains useful regardless of what is chosen below — current commercial-bank money or CBDC, traditional ledgers or tokenised ones.

The implementation lives in [`src/zc/orchestrator/state_machine.ts`](src/zc/orchestrator/state_machine.ts) and [`src/zc/lanes/`](src/zc/lanes/).

#### An aside: state machines and permissioned ledgers are structurally the same

Without changing the earlier choice to stay on the coordination layer, one further observation is worth recording.

Decomposed into its components, Zenith turns out to be **almost isomorphic to a permissioned blockchain** — particularly a permissioned EVM-style chain. The resemblance is not coincidental: both rest on the same three primitives — **an append-only log, an explicit state machine, and atomicity of state transitions**.

| Zenith concept | Permissioned EVM chain equivalent |
| --- | --- |
| FinalityLog (with `prev_hash` chain) | Blockchain (the canonical chain) |
| `ALLOWED_TRANSITIONS` table | Solidity state-machine contract |
| `transitionWithLog` (batched CAS UPDATE + log INSERT) | EVM transaction (atomic state change) |
| Lane (EXPRESS / HTLC / GTID …) | Contract family |
| H-Model (reserve / commit / release) | ERC-20 + allowance + reserve contract |
| `version` column (optimistic lock) | Nonce / sequence check |
| Idempotency key | Transaction-hash uniqueness |
| `Participants` table | Validator / permissioned-account allowlist |
| GTID atomic multi-leg | Cross-contract atomic composability |

For readers thinking about the layer below — wholesale CBDC, tokenised deposits, a unified ledger — this isomorphism carries one implication. **Wrapping central-bank money onto a public chain (lock-and-mint), and a central bank running its own permissioned chain, are difficulties pointing in opposite directions.**

The former inherits a finality-model mismatch (instant, legally-final settlement vs. probabilistic finality) and the bridge-custody risk visible in the Ronin, Wormhole, and Nomad cases — problems that legislation cannot remove. The moment wrapping occurs, the token ceases to be central-bank money and becomes a private claim against locked reserves.

The latter — should such a decision ever be made — reduces to a pure design question: rehousing existing RTGS responsibilities into a chain-shaped ledger. EVM compatibility itself is not essential. It is a recruitment device for the Solidity developer base; **finality, atomicity, and auditability stand on their own without EVM**. Zenith's state machine and FinalityLog are an implementation of exactly that "EVM-independent core", written in TypeScript on top of D1. Place the same three primitives on a BFT-finality consensus layer with HSM-backed signing keys, and what you have is a permissioned ledger.

To repeat: this is not a declaration that Zenith aims to become CBDC infrastructure. It remains a reference for the coordination layer. But the design vocabulary works in both directions — as a layer placed on top, or as a ledger placed underneath — and that does not contradict the earlier choice to stay out of the substrate. The point of a reference implementation, we think, is precisely that it should remain readable across layers.

### The institutional layer

Perhaps the most distinctive feature of this repository is that, alongside code and method design, the **institutional and governance documents are written in the same register**:

- four-eyes approval and break-glass access
- purpose codes (P01–P07) and the data-minimisation rule
- in DNS_HOLD scenarios, the ordered sequence of initial communication, public-disclosure control, the liquidity-providing-bank scheme, mutual contribution, and last-resort central-bank funding
- WORM retention and third-party assurance
- the careful separation of "normative" and "recommended" wording

These are gathered in [`specs/zenith_policy.md`](specs/zenith_policy.md). A payment system does not land in society on technical specification alone, and we wanted the institutional surface to be written with the same care as the code.

### Getting hands on

**Requirements**

- Node.js 18+
- npm 8+
- A Cloudflare account (free tier is sufficient)

**Run locally**

```bash
git clone https://github.com/pochatt/zenith-payment-system.git
cd zenith-payment-system
npm install
npm run db:migrate:local
npm run dev   # http://localhost:8787
```

**Deploy to Cloudflare**

```bash
npx wrangler login
npx wrangler d1 create zenith-db
npx wrangler queues create zenith-mock-queue
npx wrangler r2 bucket create zenith-mock-r2
cp wrangler.toml.example wrangler.toml
# fill in database_id and bindings
npm run db:migrate:remote
npm run deploy
curl -X POST https://<your-worker>.workers.dev/internal/seed
```

The dashboard is served at the root of the deployed worker.

### Commands

```bash
npm run dev               # local dev server
npm run deploy            # deploy to Cloudflare
npm run type-check        # TypeScript type check
npm run test              # full test suite (399 cases)
npm run test:watch        # watch mode
npm run db:migrate:local  # apply migrations locally
npm run db:migrate:remote # apply migrations to remote D1
```

### State machine, in code

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
  // terminal: SETTLED, FAILED_EXECUTION, CANCELLED
}
```

Every state advance is routed through the `transitionWithLog` helper, which issues the CAS UPDATE on `Transactions` and the INSERT into `FinalityLog` as a single D1 batch. **There is no window in which the state moves forward without its paired audit entry.**

### A minimal look at the API

```bash
# Initiate a transfer
POST /api/transfers
Content-Type: application/json

{
  "schema_version": "1.0",
  "message_type": "EVENT",
  "name": "PaymentInitiated",
  "txid":  "TX-...",
  "lane":  "EXPRESS",
  "amount": { "value": 5000, "currency": "JPY" },
  "payer":  { "bank_id": "001", "account_hash": "h:..." },
  "payee":  { "bank_id": "002", "account_hash": "h:..." }
}

# Query a transaction — anyone who asks under this id gets the same explanation
GET /api/transactions/TX-...
```

The complete endpoint reference lives in [`specs/api-contracts.md`](specs/api-contracts.md).

### Features

| Lane | Purpose | Finality |
| --- | --- | --- |
| EXPRESS | retail / point-of-sale | H-reserve backed |
| STANDARD | general transfer | name check + authorisation |
| HTLC | conditional escrow | hash-lock release |
| HTLC_AUTH | payee-initiated authorisation | b on Capture |
| RTP | invoice / pull | payee-initiated |
| GTID | multi-party atomic | b on all legs |
| HIGH_VALUE | central-bank routed | RTGS final |
| BULK | batch | end-of-day netting |

Cross-cutting:

- daily net settlement (DNS) cycles
- TigerBeetle-style single-threaded limit Durable Object
- O(1) directory / alias cache
- Rafiki-style streaming micro-payments
- QR codes (static and dynamic, HMAC-validated)
- alias resolution (phone, email, corporate id)
- FATF R.16 framing for cross-border
- name and account verification
- EDI / rich commercial data
- circuit breaker and self-monitoring
- SSE event stream to participating banks

### Tests

```bash
npm run test                          # full suite, 399 cases
npx vitest test/zc/express.test.ts    # a single file
```

The suite runs against an in-memory SQLite mock of D1 (via `better-sqlite3`) on the real production schema, including concurrent processing, idempotent replays, zero-sum balance invariants, and circuit-breaker recovery. `test/integration/balance_invariants.test.ts` pins, lane by lane, that `payer Δ = −amount`, `payee Δ = +amount`, row-level zero sum, and the BOJ-side conservation law all hold all the way through the journals.

### How to read the documents

The repository is layered as **concept → method → institution → interface / data**.

- **Concept (essay)**
  - [Zenith concept (Japanese)](https://www.sakuolia.jp/zenith.md)
  - [`specs/walkthrough.md`](specs/walkthrough.md) — a five-minute walkthrough built around a household direct-debit scene (bilingual)
- **Method design**
  - [`specs/zenith_public.md`](specs/zenith_public.md) — design principles, state machines, lane-by-lane flows, appendices A–F (15 chapters)
  - [`specs/architecture.md`](specs/architecture.md) — cross-cutting implementation conventions and roadmap
- **Institutional and governance**
  - [`specs/zenith_policy.md`](specs/zenith_policy.md) — rules, data governance, the DNS_HOLD protocol *(Japanese, source of truth)*
  - [`specs/zenith_policy.en.md`](specs/zenith_policy.en.md) — English digest, premised on the legal and supervisory context of Japan
- **Interface and data**
  - [`specs/api-contracts.md`](specs/api-contracts.md) — endpoints and the error catalog
  - [`specs/schema.md`](specs/schema.md) — tables, migration policy, index catalog
  - [`specs/file_structure.md`](specs/file_structure.md) — directory map

### Status and limits, stated plainly

This is a personal reference implementation, and is not intended for production use.

- Bank-to-coordinator calls are authenticated with HMAC-SHA256 only. TLS / mTLS, authentication and authorisation, encryption at rest, and regulatory controls are out of scope here.
- Performance figures are observations in a Cloudflare development environment; no claim is made about real workloads.
- Several normative requirements (the igs_mode hierarchical transitions during DNS_HOLD, automatic release paths for long-held H_locked, `MisrecordCorrected`, the Bulk LSM optimiser, fully general N:M GTID fan-in / fan-out, and others) are written into the method spec but are not yet implemented. See [`specs/architecture.md`](specs/architecture.md) § 7.

The intent is to offer **something to argue with**, not something to replace anything.

### Who this is for

- People who work on, or simply care about, payment-system planning and policy
- Engineers in bank IT, payment service providers, and systems integrators
- People around central banks and regulators who think about explicability and auditability
- Students, researchers, and individual developers

The concept, the method, the institutional layer, and the code are laid alongside each other at the same temperature, so that readers from different vantage points can each find their entry.

### Yours to use

You are welcome to use this material in whatever form suits you. Adopt it wholesale, or take only a fragment of the thinking — either is welcome. When your project takes shape one day, if you mention that Zenith was the draft you started from, that will be more than enough.

### License

MIT — see [LICENSE](LICENSE).

### Contact

- Questions and discussion: [GitHub Issues](https://github.com/pochatt/zenith-payment-system/issues)
- Concept overview: [Zenith concept (sakuolia.jp)](https://www.sakuolia.jp/zenith.md)

> This repository and its accompanying documents are a work of fiction; they do not represent any real organisation, system, or way of working.
