# 統一状態機械によるTradFiとDeFiの融合

― 銀行間決済における協調層と暗号学的原始要素を同一の遷移表で扱う設計 ―

**著者**：Zenith 構想チーム
**版**：v1.0（2026年5月）
**実装根拠**：`pochatt/zenith-payment-system`（MIT License）

---

## 要旨（Abstract）

伝統的決済レール（RTGS, DNS ネッティング, 全銀系リテール）と暗号学的原始要素（HTLC, アトミック・マルチレグ）を結合する従来の手法は、両者を異なる台帳の上に置き、ブリッジ（橋渡し）で連結することを前提としてきた。本稿では、両者を「橋」ではなく **単一の状態機械上に並ぶ対等なレーン（lane）** として表現する設計を提示する。中核となる固定点は (i) 全レーンが共有する正準的な遷移表 `ALLOWED_TRANSITIONS`、(ii) 各状態遷移と追記型監査ログ `FinalityLog` を一つのデータベースバッチで原子的に発行するヘルパ `transitionWithLog`、(iii) レーン固有の副台帳（HtlcContracts, GtidLegs 等）を同一バッチに巻き込む `sideUpdates` 機構、の3点である。約 1.8 万行の TypeScript 参照実装（Cloudflare Workers + D1）と約 400 件の統合テストにより、(a) 状態だけが進んで監査ログが残らない時間窓が構造的に存在しないこと、(b) HTLC の preimage 検証、GTID のレッグ間 all-or-nothing、RTGS のプレファンド、DNS のネッティングが、いずれも同一の状態語彙（`PRECHECKED`, `H_RESERVED`, `DECIDED_TO_SETTLE`, `PAYEE_EXEC_CONFIRMED` ほか）で説明可能であることを示す。さらに、トークン化預金やホールセールCBDCが取り組む「貨幣・台帳の下層」とは異なり、本設計は **既存の商業銀行貨幣・既存の銀行勘定をそのまま前提とする協調層** に位置付けられること、両者は競合ではなく隣接する層であることを論じる。

**キーワード**：決済システム, 状態機械, 監査可能性, RTGS, HTLC, アトミック・マルチレグ, 協調層, 説明可能性

---

## 1. はじめに（Introduction）

### 1.1 動機と問題提起

決済システムの社会的な存立条件は、長らく「速さ」「安さ」「堅牢さ」の三角形で語られてきた。日本国内に限らず、世界の主要決済インフラはこの三辺の最適化を、おおむね組織と時間の積み上げによって達成してきた。一方で、利用者・事業者・規制当局のいずれの立場からも残存する課題が **「いま自分の取引はどこにあるのか」「なぜ遅延しているのか」「誰に聞けば説明が得られるのか」** という、後付け不能な **説明可能性（explicability）** の問題である [1]。

過去十年の研究と実装は、説明可能性を「ログ」ではなく「下層」で解決しようとしてきた。BIS Project Stella Phase 2 [2], Jasper-Ubin [3], Agorá, mBridge [4], および民間プラットフォーム（Partior, Fnality, JPM Onyx, Canton Network, DCJPY/Progmat）は、いずれも **貨幣そのもの（ホールセールCBDC、トークン化預金、プログラマブル・マネー）または共通台帳の構造** を再設計することで、決済ライフサイクル全体を単一の台帳の中に閉じ込めようとする試みであった。これらは決済の「下層」を再構築する取り組みである。

しかし、商業銀行貨幣と各行の既存勘定系を全面的に置き換えることは、技術的にも制度的にも高コストである。日本の場合、銀行勘定系の堅牢性は世界水準で見ても高く [5]、そこに最大の社会資本が積み上がっている。本稿の前提は、**この下層をそのままに保ったうえで、その「間」だけを説明可能にする協調層** が独立した設計対象として成立しうる、というものである。

### 1.2 既存アプローチの限界

協調層を設計するうえで、過去の研究は次の二系統に分かれる。

1. **伝統系の側からの拡張**：ISO 20022 [6] のリッチ・データ化、RTGS（Real-time Gross Settlement）への即時性付与、SWIFT GPI のトラッキング機能などは、伝統系のメッセージ・プロトコルを起点として「観測可能性」を高める方向にある。しかし状態遷移そのものは依然として各参加者の内部仕様に委ねられ、複数主体を跨いだ取引が「どの状態にあるか」を一意の語彙で表現できない。
2. **暗号学的原始要素の側からの拡張**：Bitcoin/Lightning ネットワークの HTLC [7], Cosmos IBC のアトミック・マルチレグ、各種クロスチェーン・ブリッジは、参加台帳全体を新規の暗号原語の上に再構築することで、ファイナリティ（finality, 不可逆境界）を機械的に固定する方向にある。しかしこれらは「橋を渡す」設計であり、既存銀行勘定系との整合を取るための変換コストは大きい。

両者を同時に扱うには「ブリッジ」を介する以外に手段がない、という暗黙の前提が、これまで広く共有されてきた。

### 1.3 本稿の貢献

本稿は次の三つの貢献を主張する。

1. **統一状態機械（Unified State Machine, USM）の定式化**：RTGS, DNS, HTLC, アトミック・マルチレグ（GTID）, プル型（RTP）, 一括（BULK）, 受取側オーソリ（HTLC_AUTH）の各レーンを、同一の正準的な遷移表 `ALLOWED_TRANSITIONS` の上に並ぶ「契約（contract）」として再定義する。これにより、伝統系と暗号系を区別する語彙が消え、すべての取引が `RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED` という共通の進行軸の上に投影される。
2. **状態遷移と監査ログの原子対化（Atomic State-Log Pairing）**：状態の変更（CAS UPDATE）と追記型監査ログ `FinalityLog` への書き込みを、データベースの単一バッチで同時に発行する `transitionWithLog` プリミティブを提示する。CAS が他の writer に負けた場合は監査エントリも書き込まれず、CAS が勝った場合は監査エントリと副台帳の更新が一括でコミットされる。これにより、説明可能性プロトコルにおける最も致命的なバグ―「状態は進んだが監査ログが書かれない時間窓」―が構造的に閉じる。
3. **協調層の独立性の論証**：上記設計は商業銀行貨幣と既存銀行勘定系を所与として動作し、貨幣・台帳の下層を変更しない。本稿は、協調層と下層が「同じ問題を競合的に解く」のではなく、**隣接する層を分担する** ことを論じ、両層が独立に進化しうることを示す。

### 1.4 本稿の構成

第2章で関連研究を整理し、本稿の設計が占める層を明確化する。第3章で設計目標を定式化する。第4章で統一状態機械の中核を述べる。第5章でレーン契約モデルを示し、第6章で原子対化の実装を詳述する。第7章で形式的不変条件を列挙し、第8章で参照実装と評価を述べる。第9章で考察、第10章で結論を述べる。

---

## 2. 関連研究

### 2.1 ホールセール領域における協調実験

BIS および各国中央銀行による協調実験は、決済の下層を再設計する系統に分類される。Project Stella Phase 2 [2] は分散台帳技術（DLT）上での銀行間決済の協調可能性を示し、Jasper-Ubin [3] はクロスボーダーのホールセール決済を異なる台帳間で原子化する初期実装を提示した。mBridge [4] は CBDC のマルチカレンシー・プラットフォーム化を目指している。これらは「貨幣の表現形式」を再構築することで全ライフサイクルを単一台帳に閉じ込める方針に立つ。

### 2.2 民間プラットフォーム

Partior [8], Fnality [9], JPM Onyx, Canton Network [10] は、参加銀行間でトークン化預金や合成貨幣を運用するための共通台帳を提供する。これらは民間主体の合意により下層を再構築する点で、上記の中央銀行系実験と思想的に近い。日本においては DCJPY と Progmat [11] が類似の方向で議論されている。

### 2.3 暗号学的ファイナリティ原始要素

HTLC（Hash Time-Locked Contract）は Bitcoin Lightning Network [7] で実用化された原始要素で、`hashlock`（受取側が preimage を提示することで解錠）と `timelock`（一定時刻を超過すると自動解約）を組み合わせる。アトミック・マルチレグ（atomic multi-leg）は、複数のレッグを「全部成立または全部不成立」で確定する原語で、Cosmos IBC や Polkadot XCM の派生として実装が広がる。

### 2.4 伝統的決済レール

RTGS は中央銀行の当座勘定を即時にグロスで決済する仕組みであり、日本では BOJ-NET、欧州では TARGET2 が代表例である [12]。DNS（Daily Netting Settlement）は一日分の取引を相殺してネット額のみを決済する仕組みで、流動性節約に貢献する。ISO 20022 [6] はメッセージ形式の標準であり、近年は SWIFT MT からの移行が進む。FATF Recommendation 16 [13] はクロスボーダー送金における発信人・受取人情報の完全性を要求する。

### 2.5 本稿の位置付け

本稿の設計は **2.1〜2.4 のいずれとも層が異なる**。すなわち、貨幣・台帳の表現を変えるのではなく、既存の伝統的レールと既存の暗号学的原始要素を **同じ語彙で記述するための上位層** を提供する。最も近接する先行研究は、SWIFT GPI のトラッキング機構と Open Banking 系の状態通知 API である。しかし、これらは伝統系の側からの観測可能性拡張に留まり、HTLC やアトミック・マルチレグを同じ状態語彙で表現することを目的としていない。

知る限り、HTLC・アトミック・マルチレグ・RTGS・DNS を、ブリッジを介さずに「単一の状態機械上の対等なレーン」として並べたオープンソース実装は、公開文献の範囲には存在しない。

---

## 3. 設計目標

本設計は以下の四つを設計規範（normative goals）として固定する。これらは事後的な性能要件ではなく、設計の初期に固定される不変条件である。

**D1: 単一遷移表（Single Transition Table）**
すべての取引（伝統系・暗号系を問わない）は、同一の正準的な遷移表 `ALLOWED_TRANSITIONS` を通過する。レーン固有の状態（例：`HTLC_LOCKED`）も同一の表に登録され、レーンごとに独立した状態機械を持たない。

**D2: 状態遷移と監査ログの原子対化（Atomic State-Log Pairing）**
状態の遷移と、その遷移を記述する `FinalityLog` エントリの書き込みは、データベースの単一トランザクション/バッチで発行される。一方が成功し他方が失敗する時間窓は構造的に存在しない。

**D3: 説明責任の閉包性（Explicability Closure）**
取引のあらゆる時点において、同一の取引識別子 `txid` を提示すれば、利用者・事業者・規制当局のいずれに対しても同じ説明が得られる。説明できない状態（曖昧、半確定、不整合）は禁止され、未決はすべて `SUSPENDED → CASE` に収束する。

**D4: 下層の不可触性（Substrate Neutrality）**
協調層は参加銀行の内部勘定処理、口座管理、与信判断を置き換えない。協調層が変更を要求するのは「外形上の状態語彙」のみであり、各参加者の内部実装には介入しない。協調層は商業銀行貨幣を前提とし、CBDC やトークン化預金の有無に依存しない。

これらの規範は相互に独立に見えるが、後述する統一状態機械の設計においては相互補強的に作用する。とりわけ D1 と D2 は対をなし、D3 を技術的に成立させる必要条件である。

---

## 4. 統一状態機械（Unified State Machine）

### 4.1 中核となる遷移表

本設計の中核は、レーンに依存しない単一の遷移表である。形式的には、状態の有限集合 $S$ と遷移関係 $T \subseteq S \times S$ の組として表現される。実装上は次の TypeScript リテラル `ALLOWED_TRANSITIONS` がその正準形である（`src/zc/orchestrator/state_machine.ts`）。

```ts
const ALLOWED_TRANSITIONS: Record<TxState, TxState[]> = {
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
  // 終端: SETTLED, FAILED_EXECUTION, CANCELLED
}
```

ここで重要なのは、`HTLC_LOCKED` と `HTLC_FULFILL_REQUESTED` という暗号系固有の状態が、同じ表の中に `RECEIVED` や `PRECHECKED` と並んで列挙されていることである。両者は語彙の意味こそ異なるが、有限状態機械上の節点としては同格である。

### 4.2 確定点と不可逆境界

設計規範 D3 を機械的に成立させるため、本設計は **三つの確定点（finality point）** を固定する。

- **Decision（DECIDED_TO_SETTLE）**：協調層が「実施指示を出すこと」を確定した境界。地理分散合意ログのコミットが立証根拠となる。
- **a（PAYER_EXEC_CONFIRMED）**：支払側参加者の実施が証憑により確定した境界。
- **b（PAYEE_EXEC_CONFIRMED）**：受取側参加者の利用可能化が確定した境界。**本設計における不可逆境界（point of no return）** は原則として b である。

これらの境界は、レーンに関係なく同一の語彙で表現される。HTLC の preimage 提示も RTGS の中央銀行確定も、結局は「Decision → a → b」の同じ三段階に投影される。

### 4.3 状態の語彙的還元

四つの代表的レーンが、どのように単一の状態語彙に還元されるかを示す。

| レーン | 状態経路 |
| --- | --- |
| EXPRESS | RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED |
| STANDARD | RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED |
| HIGH_VALUE | RECEIVED → PRECHECKED → DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED |
| HTLC | RECEIVED → HTLC_LOCKED → HTLC_FULFILL_REQUESTED → DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED |

HIGH_VALUE は `PRECHECKED → DECIDED_TO_SETTLE` という直行遷移を持つ。これは「中央銀行 RTGS は仕向超過限度（H）を消費しないため、ネッティングのためのリザーブが不要」という業務規範を、状態機械の語彙だけで表現したものである。同様に、HTLC は `RECEIVED → HTLC_LOCKED` という分岐を持ち、これが暗号的ファイナリティ原語の入口に対応する。**いずれのレーンも、Decision 以降の経路（a → b → SETTLED）は完全に共通である**。これが「橋」ではなく「同一機械上のレーン」と呼ぶ実体的根拠である。

### 4.4 確定点と証跡の対応

各レーンに固有のファイナリティ原語（`hashlock`/`timelock`, `boj_settle_ref`, `dns_cycle_id`, `decision_proof_ref` ほか）は、共通の `FinalityLog` イベントの `payload_json` に格納される。これにより、レーンが何であれ、検証側は **同じスキーマ** で証跡を読み出せる。

たとえば HTLC の `HtlcFulfillRequested` イベントの payload は `{ htlc_id, hashlock_prefix, ...}` を含むが、RTGS の `DecidedToSettle` の payload は `{ decision_proof_ref, lane: 'HIGH_VALUE' }` を含む。両者は同じ JSON 形式に従い、同じイベントログから問い合わせ可能である。

---

## 5. レーン契約モデル

### 5.1 レーンの再定義：UX 区分から「契約」へ

伝統的な決済システム設計では、「レーン」は UX 区分（即時送金、振込、給与一括、請求書）として扱われることが多い。本設計はこの慣習を反転させる。**レーンとは UX ではなく、確定点と証跡に関する契約（contract）である**。

形式的には、レーン契約 $C_L$ は次の四つ組として定義される。

$$
C_L = (\sigma_L, \beta_L, E_L, \Sigma_L)
$$

ここで $\sigma_L$ は同期境界（synchronous boundary：HTTP 応答時点で確定している状態）、$\beta_L$ は不可逆境界（原則 b、ただし HIGH_VALUE は中央銀行確定後の b）、$E_L$ は必須証跡集合、$\Sigma_L$ は許容される例外収束先である。

この定義により、EXPRESS と STANDARD は実装上は近似だが、$\sigma_L$ の値（Decision まで vs 受理まで）で明確に区別される。HTLC と GTID は $E_L$ の構成（hashlock vs leg_id 集合）で区別される。本設計はこれらすべてを単一の `lane` カラムと、対応する補助テーブル（HtlcContracts, GtidLegs, ...）で表現する。

### 5.2 七つのレーン契約

| レーン | 同期境界 $\sigma_L$ | 不可逆境界 $\beta_L$ | ファイナリティ原語 |
| --- | --- | --- | --- |
| EXPRESS | DECISION_ACCEPTED | b | H 予約＋ネッティング |
| STANDARD | INGRESS_ACCEPTED | b | 名義確認＋顧客認可 |
| HIGH_VALUE | INGRESS_ACCEPTED | 中銀確定→b | RTGS 即時グロス |
| BULK | INGRESS_ACCEPTED | b | 締切＋LSM＋日次ネッティング |
| RTP | INGRESS_ACCEPTED | b | 受取人発起プル |
| HTLC | INGRESS_ACCEPTED | preimage→b | hashlock＋timelock |
| GTID | GTID_ACCEPTED | 全 leg の b 一致 | アトミック・マルチレグ |

ここで注目すべきは、ファイナリティ原語の異質性（H 予約・RTGS・hashlock・leg 集合）にもかかわらず、不可逆境界がほぼすべて「b（PAYEE_EXEC_CONFIRMED）」に収束していることである。本設計はファイナリティの語彙を意図的に貧弱に保ち、その分だけ証跡の語彙を豊かに保つ。

### 5.3 取消可能性の単一規範

不可逆境界の単一化（D3 の系）により、取消可能性のルールも単一になる。

- **Decision 確定前**：`DECIDED_CANCEL → CANCELLED` で収束。証跡を残して未完了取引として閉じる。
- **a 成立後**：原則として取消不可。救済は **Reversal**（反対取引）として **別の `txid` で起票** する。因果リンク（correlation/causation）を必須とし、監査で辿れることを要件とする。
- **b 成立後**：取消禁止。理由は監督・訴訟で最も問題になるのは「後から取り消した」類型であるため。

この規範は HTLC の `timelock` 超過にも、RTGS の中銀不成立にも、GTID の一部レッグ失敗にも、同じ語彙で適用される。

### 5.4 例の比較：HTLC と RTGS の同形性

HTLC レーン（暗号系）と HIGH_VALUE レーン（伝統系）を、状態語彙のみに着目して比較すると、構造的な同形性が見える。

```
HTLC:
  RECEIVED →[HtlcLocked]→ HTLC_LOCKED →[HtlcFulfillRequested]→
  HTLC_FULFILL_REQUESTED →[DecidedToSettle]→ DECIDED_TO_SETTLE →
  PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED

HIGH_VALUE:
  RECEIVED →[PreCheckPassed]→ PRECHECKED →[DecidedToSettle]→
  DECIDED_TO_SETTLE →[PAYER_HV_ISOLATION_PROOF]→ PAYER_EXEC_CONFIRMED →
  [CB_SETTLED]→ PAYEE_EXEC_CONFIRMED → SETTLED
```

HTLC における preimage 検証も、HIGH_VALUE における中央銀行決済の確定も、いずれも「Decision の前段に置かれた条件成立イベント」として同型に扱える。両者の差異は、条件成立を駆動するアクター（前者は受取側、後者は中央銀行）と、証跡の形式（前者は preimage の SHA-256、後者は `boj_settle_ref`）のみである。

---

## 6. 状態遷移と監査ログの原子対化

### 6.1 問題設定

設計規範 D2（原子対化）は、形式的には次のように表現される。任意の状態遷移 $s_1 \to s_2$ について、対応する `FinalityLog` エントリ $\ell$ の書き込みが伴うとき、「$s_2$ がコミットされている」と「$\ell$ がコミットされている」は同時に真または同時に偽でなければならない。

実装上、これは次のような失敗モードを排除することを意味する。

1. CAS UPDATE で $s_2$ への遷移は成功したが、`FinalityLog` への INSERT が失敗した（例：UNIQUE 制約衝突、ネットワーク切断）。状態は進んだが監査記録がない。
2. `FinalityLog` への INSERT が成功したが、CAS UPDATE が他の writer に負けて状態が進まなかった。監査記録だけが残り、状態と整合しない。

両者とも、説明可能性プロトコルにおいては致命的である。

### 6.2 `transitionWithLog` プリミティブ

本設計は、上記の二つの失敗モードを構造的に排除するため、`transitionWithLog` という単一のヘルパを導入する（`src/zc/lanes/_helpers.ts`）。中核は次の四つの仕掛けである。

1. **静的検証の事前実行**：CAS UPDATE 前に `isValidTransition(from, to)` を呼び、`ALLOWED_TRANSITIONS` に無い遷移はデータベース I/O 以前に弾く。これにより、新規レーン追加時に遷移表を更新し忘れた場合の沈黙的失敗を防ぐ。
2. **条件付き INSERT**：`FinalityLog` への INSERT は `INSERT ... SELECT ... WHERE EXISTS(...)` の形を取り、直前の UPDATE が成功した場合（`changes() > 0`）にのみ実行される。CAS が負けた呼び出しは監査ログも書き込まない。
3. **単一バッチでの発行**：UPDATE と条件付き INSERT は `db.batch([...])` の単一バッチで発行される。バッチ内で例外が発生すれば両方ロールバックされる。これがアトミシティの担保である。
4. **副台帳の巻き込み（`sideUpdates`）**：HTLC では `HtlcContracts` テーブル、GTID では `GtidLegs` テーブルといった副台帳が、正準状態と並走する。これらの更新を同一バッチ内に積むことで、「`Transactions.state` は進んだが `HtlcContracts.state` は古いまま」という不整合窓を消す。

実装の核心部分を示す（簡略化）。

```ts
const results = await db.batch([
  db.prepare(updateSql).bind(toState, ...setValues, now, txid,
                             ...fromStates, version),
  buildFinalityLogConditionalInsert(db, logRow),
  ...sideUpdates.map(u => db.prepare(u.sql).bind(...u.binds)),
])
const updateChanges = results[0]?.meta.changes ?? 0
if (updateChanges === 0) return { applied: false, ... }
```

`updateChanges === 0` の場合（CAS 負け）、`FinalityLog` への INSERT も `WHERE EXISTS` ガードで自動的にスキップされ、副台帳更新も影響を持たない（ガードを介して効果を打ち消す設計とする）。

### 6.3 取消経路における順序問題（TOCTOU）

取消（`cancelInFlightTx`）には別種の難しさがある。素朴に「H 予約を解放してから状態をキャンセルに進める」順序で実装すると、並行する Decision 経路が CAS を勝ち取って `DECIDED_TO_SETTLE` に進んだ場合、すでに H 予約が解放されており、結果として「Decision は確定したが裏付けとなる H 予約は失われている」という不整合が生じる。

本設計はこれを **状態ガード成立後にのみ H 解放を行う** 順序で解消する。具体的には：

1. CAS UPDATE で `DECIDED_CANCEL` への遷移を試みる（同一バッチで `FinalityLog` `DecidedCancel` を発行）。
2. canonical UPDATE が `changes > 0` で成功した場合に限り、`releaseH(reservation_id)` を呼ぶ。
3. 最後に `finalizeCancelledTx` で `CANCELLED` の終端遷移を行う。

これは過去に同型のバグ（"LOCKED 予約の誤解放"）が発生した経験から、`_helpers.ts` の不変条件として固定された。

### 6.4 入口遷移の制御（`insertTxWithLog`）

GTID のレッグレベル取引は、GT-level Decision が確定した後に **直接 `DECIDED_TO_SETTLE` 状態で INSERT される**。これは、GT 全体での原子的 Decision が既にコミットされているため、レッグ単位での「pre-decision 状態」が存在しないからである。

このような「中間状態をスキップした入口遷移」を野放しにすると、状態機械の単一性が崩れる。本設計は `ALLOWED_ENTRY_STATES = {RECEIVED, HTLC_LOCKED, DECIDED_TO_SETTLE}` というホワイトリストを設け、`insertTxWithLog` がこれを静的に検証する。ホワイトリストに無い状態での INSERT は `INVARIANT_VIOLATION` で拒否される。

これにより、「将来の改修で新たなレーンが任意の状態から INSERT する経路を作る」という静的検証回避を、コードレビューではなく仕組みで防ぐ。

---

## 7. 形式的不変条件

本設計が機械的に保証する不変条件を列挙する。これらは参照実装の統合テスト（`test/integration/`）と静的解析テスト（`test/zc/lane_invariants.test.ts`）で連続的に検証される。

**I1: 単一遷移表通過の不変条件（Single-Path Invariant）**
`Transactions.state` を変更するすべてのコードは `transitionWithLog` を経由しなければならない。生の `UPDATE Transactions SET state = ...` および `INSERT INTO Transactions ... (..., state, ...)` はソースコード全体で禁じられ、CI 上の正規表現ベース静的解析が違反を検出する。

**I2: 原子対化の不変条件（Atomic Pairing Invariant）**
任意の `(txid, state_to)` 組について、対応する `FinalityLog` エントリが存在する。逆に、`FinalityLog` のエントリが存在するならば、`Transactions` 上で対応する状態遷移が成立している。CAS の競合により負けた呼び出しは、状態も監査ログも残さない。

**I3: 残高保存則（Balance Conservation Invariant）**
全レーン共通で次の四式が成立する。

$$
\Delta_{payer} = -\text{amount}, \quad \Delta_{payee} = +\text{amount}
$$

$$
\sum_{\text{行内}} \Delta = 0, \quad \sum_{\text{BOJ系全行}} \Delta = 0
$$

ここで「行内ゼロサム」は各銀行の仕訳整合を意味し、「BOJ 系の保存則」は RTGS を経由してもネットワーク全体での貨幣総量が保存されることを意味する。これは `test/integration/balance_invariants.test.ts` でレーン別に検証される。

**I4: 仕向超過限度の不変条件（H Constraint）**
任意の時点で各参加銀行について、`sum(H_reserved) + sum(H_locked) ≤ H_limit` が成立する。H は「数値」ではなく「状態」として管理されるため、論理的に絶対超過は発生しない。HIGH_VALUE レーンは H 経路を経由しないが、それは中央銀行 RTGS により独立に流動性が担保されるためである。

**I5: event_seq 単調性（Monotonic Event Sequence）**
`FinalityLog.event_seq` は `FinalitySeq` カウンタに対する `UPDATE ... RETURNING` により単調増加で割り当てられる。これにより、`FinalityLog` 全体に対する全順序が成立し、後付けの順序操作が不可能になる。

**I6: ハッシュチェーン整合性（Hash Chain Integrity）**
各 `FinalityLog` エントリは `entry_hash = SHA256(prev_hash || ...)` で連鎖する。任意の中間エントリの改竄は、後続エントリの `prev_hash` 不一致として検出可能である。これは将来的に WORM 保全との接続を想定したものである。

---

## 8. 参照実装と評価

### 8.1 実装概要

本設計の参照実装 Zenith Mock は、TypeScript（約 1.8 万行）で記述され、Cloudflare Workers + D1（分散 SQLite）+ Queues + R2 の上で動作する。実装の構成は次の通り（`specs/file_structure.md`）。

- `src/index.ts`：単一エントリポイント、HTTP ルーティング、キュー消費、cron 起動
- `src/zc/ingress.ts`：ZC HTTP API（`/api/*`, `/internal/*`）
- `src/zc/lanes/*.ts`：レーンごとの状態機械
- `src/zc/orchestrator/`：状態機械検証、`FinalityLog` 永続化、銀行呼出ハブ
- `src/zc/lanes/_helpers.ts`：`transitionWithLog`, `cancelInFlightTx`, `insertTxWithLog`
- `migrations/`：16 個の数値順マイグレーションファイル、28 テーブル

データベースは 28 テーブル、うち中核は `Transactions`（取引本体）, `FinalityLog`（追記型監査ログ）, `Participants`（参加銀行）, `BankAccounts`（銀行内勘定）, `BankJournals`（銀行内仕訳）, レーン固有の `HtlcContracts`, `GtidTransactions`, `GtidLegs`, `RtpRequests`, `DnsCycles` 等である。

### 8.2 テストスイートによる不変条件の検証

実装には約 400 件の統合テスト（vitest + better-sqlite3 による D1 インメモリモック）が含まれる。とくに重要な検証ファイルは以下である。

- `test/zc/lane_helpers.test.ts`：CAS の並列安全性（N 並列で `applied:true` は最大 1 本）、TOCTOU 取消順序、`sideUpdates` の整合性
- `test/zc/lane_invariants.test.ts`：ソース全体を正規表現で走査し、`UPDATE Transactions SET state` や `INSERT INTO Transactions` の生発行、`FinalityEventType` union への未登録イベント名、レーン単体テストの存在を静的に検証
- `test/zc/atomic_finality.test.ts`：CAS+ログのバッチ原子性
- `test/integration/balance_invariants.test.ts`：全レーン（EXPRESS / STANDARD / HTLC / HTLC_AUTH / HIGH_VALUE / BULK / GTID 1×1 / GTID 2×2 逆順）について、`payer Δ == -amount`、`payee Δ == +amount`、行内ゼロサム、BOJ 系全行ゼロサムの 4 条件を仕訳まで往復で固定（11 ケース）

これらのテストは I1〜I3 の不変条件を、レーンを跨いだ統合シナリオで連続的に検証する。

### 8.3 実装の特徴的なバグ修正履歴

本設計の妥当性を示すうえで、参考になるのは「設計が正しく機能した結果として発見・修正されたバグ」の履歴である。代表例を三件示す（`specs/architecture.md` § 6 より）。

| バグ | 内容 | 修正 |
| --- | --- | --- |
| double-credit | `onPayeeExecConfirmed` が無条件に `credit-notify` を呼び、銀行ハンドラがもう一度 `Customer(+)/ZCS(-)` を仕訳していた。EXPRESS / STANDARD / HTLC / HTLC_AUTH / HIGH_VALUE / BULK すべてで payee が 2 倍着金。 | `bankCreditNotify` を「仕訳しない通知層」に変更（BankAuditLog + DELIVERED 応答のみ）。`execute-credit` 経由の仕訳が唯一の真実。 |
| HTLC_AUTH stuck | `approveAuthRequest` が `state='H_RESERVED'` で INSERT。`claimHtlc` の CAS は `WHERE state='HTLC_LOCKED'` のため Transactions が動かず、Bank だけ debit されて payee は永遠に着金しない。 | INSERT 時の state を `HTLC_LOCKED` に変更し `HtlcContracts` と整合。`insertTxWithLog` の `ALLOWED_ENTRY_STATES` 検証で再発防止。 |
| GTID leg pairing | 2×2 で PAYEE が `leg_id` 昇順以外で挿入されると、PAYER↔PAYEE のペアが取り違わって誤った銀行に着金。 | `payerLegs` / `payeeLegs` を `leg_id` でソートし、同じ index で組む。 |

これらは個別バグの修正記録だが、本設計の観点から重要なのは、いずれも **残高インバリアントの統合テスト（I3）が落ちることで検出された** という事実である。状態機械の遷移条件だけを見る単体テストでは、これらは検出できなかった。「仕訳まで往復」を不変条件として固定しているため、検出可能になっている。

### 8.4 観測されたコスト

参照実装は Cloudflare Workers の開発環境で動作確認しており、本番ワークロードでの性能は本稿の範囲外である。本設計の主要な追加コストは、状態遷移ごとに `FinalityLog` への INSERT が同一バッチで発行されるため、状態遷移あたりのデータベース書き込みが概ね 2 倍（Transactions UPDATE + FinalityLog INSERT）になることである。副台帳（HtlcContracts 等）を持つレーンではさらに 1 件追加される。

しかし、D1 / SQLite のバッチ書き込みは単一トランザクション内で処理されるため、ネットワーク往復は 1 回に留まる。本設計の主たる用途（金融機関間決済）における取引レートを想定すると、この追加コストは説明可能性のリターンに対して支配的にはならない、というのが筆者らの設計判断である。

---

## 9. 考察

### 9.1 「ブリッジ vs レーン」の概念的差分

本稿の主張の核は、「TradFi と DeFi の融合は技術的にはブリッジを介さずに可能である」という点ではない。**両者がそもそも別の層を取り合っていない** という認識が、設計の基底にある。

ブリッジ設計の暗黙の前提は、「両者は別の台帳の上に存在し、その間にプロトコル変換が必要である」というものである。これに対して本設計は、「両者を **同じ状態語彙で記述する** ことが可能であり、その下層が何であっても（既存銀行勘定、CBDC、トークン化預金）、上層の協調プロトコルは独立に機能する」という立場を取る。

この立場の妥当性は、下層が変わったときに本設計がどう反応するかで検証できる。本設計は HIGH_VALUE レーンにおいて「BOJ 残高チェック」を行うが、これはレーン固有のロジックであり、状態語彙そのものは変わらない。下層を CBDC に置き換えた場合、変わるのは `calcBalance(payer_bank-BOJ)` の呼び出し先のみで、状態機械や `FinalityLog` のスキーマには変更が及ばない。同様に、HTLC レーンを Lightning ネットワークと接続するブリッジを作るとしても、必要なのは外部台帳との橋ではなく、本設計上の `HTLC_LOCKED` 状態を外部の hashlock イベントと連動させるアダプタである。

### 9.2 制限事項

本設計は次の領域を **意図的に対象外** とする。

1. **貨幣の表現形式**：トークン化預金、ホールセール CBDC、プログラマブル・マネー
2. **クロスボーダー多通貨原子決済**：FX レート凍結、流動性プール、決済通貨選択
3. **プライバシー原語**：ゼロ知識証明、機密取引、秘匿アドレス
4. **エージェント同一性**：分散 ID、委任プロトコル、AI エージェント間決済

これらは 2.1〜2.2 の先行研究および各国 CBDC プログラムの主戦場であり、本設計はそれらと **同じ層を取り合わない**。

また、参照実装には次の限界がある。

- 銀行↔協調層間は HMAC-SHA256 署名のみ。TLS/mTLS、認証認可、保存時暗号化、規制適合は実装範囲外。
- 一部の規範要件（DNS_HOLD 時の igs_mode 階層遷移、長期 H_locked 自動解放、`MisrecordCorrected`、Bulk LSM 最適化、GTID の N:M fan-in/fan-out）は方式仕様には記述されているが、実装は道半ばである。

### 9.3 将来の方向性

本設計の延長線として考えうる方向性は次の通り。

1. **下層との接続層の拡張**：CBDC やトークン化預金が普及した場合、それらをファイナリティ原語の一種としてレーン契約に登録できるか。最小例として「CBDC レーン」を `RECEIVED → PRECHECKED → CBDC_TRANSFERRED → DECIDED_TO_SETTLE → ...` という経路で追加することが想定される。
2. **クロスボーダーへの応用**：FATF R.16 [13] の発信人/受取人情報の完全性検証は既に実装されているが、多通貨原子決済への拡張は未着手である。HTLC と GTID の組み合わせにより、原理的には FX レート凍結を伴う原子決済が単一の状態語彙で表現可能と考えられる。
3. **危機対応の制度化**：DNS_HOLD 時の流動性供給銀行（LPB）スキーム、共同拠出、中央銀行手当の発動順序を、状態機械の一部として記述する取り組みが進行中である（`specs/zenith_policy.md`）。これは「危機対応は例外ではなく制度化された状態遷移である」という設計規範の延長にある。

---

## 10. 結論

本稿は、TradFi（RTGS, DNS, ISO 20022 等）と DeFi（HTLC, アトミック・マルチレグ等）を、ブリッジを介さずに **単一の状態機械の対等なレーン** として表現する設計を提示した。中核となる三つの貢献は、(i) 単一遷移表 `ALLOWED_TRANSITIONS`、(ii) 状態遷移と監査ログの原子対化を担う `transitionWithLog`、(iii) 協調層と下層が独立に進化しうるという層分離の論証、である。

約 1.8 万行の参照実装と約 400 件の統合テストにより、本設計が機械的に保証する不変条件（単一遷移表通過、原子対化、残高保存則、H 制約、event_seq 単調性、ハッシュチェーン整合性）が連続的に検証されることを示した。

本設計が積極的に主張するのは、「下層を再構築せずに説明可能性を獲得できる」という命題である。トークン化預金やホールセール CBDC が貨幣・台帳の下層を問い直す研究系統と並行して、現行の商業銀行貨幣・既存勘定系の上に被さる協調層が、独立した設計対象として成立する。両者は競合するのではなく、隣接する層を分担する。

参照実装と全文書は MIT ライセンスで `pochatt/zenith-payment-system` に公開されている。本稿は完成品の発表ではなく、議論の叩き台の提示である。

---

## 参考文献

[1] Committee on Payments and Market Infrastructures (CPMI), "Principles for Financial Market Infrastructures," Bank for International Settlements, 2012.

[2] Bank of Japan and European Central Bank, "Project Stella Phase 2: Securities Settlement Systems," 2018.

[3] Monetary Authority of Singapore and Bank of Canada, "Jasper-Ubin Design Paper: Enabling Cross-Border High Value Transfer Using Distributed Ledger Technologies," 2019.

[4] Bank for International Settlements Innovation Hub, "Project mBridge: Connecting Economies Through CBDC," 2022.

[5] 全国銀行協会, "全国銀行データ通信システム（全銀システム）の現状と展望," 各年版報告書.

[6] ISO 20022, "Financial services – Universal financial industry message scheme," International Organization for Standardization.

[7] J. Poon and T. Dryja, "The Bitcoin Lightning Network: Scalable Off-Chain Instant Payments," 2016.

[8] Partior, "Unified Payments Platform: Atomic Settlement for Wholesale Cross-Border Transactions," White Paper, 2022.

[9] Fnality International, "Fnality Payment Systems: A New Frontier for the Wholesale Banking Industry," 2021.

[10] Digital Asset Holdings, "Canton Network: A Privacy-Enabled, Interoperable Blockchain Network for Institutional Assets," 2023.

[11] Progmat, Inc., "DCJPY White Paper: A Programmable Digital Currency on a Permissioned Network," 2023.

[12] European Central Bank, "TARGET2: The Real-Time Gross Settlement System Operated by the Eurosystem," Operational Documentation.

[13] Financial Action Task Force, "Recommendation 16: Wire Transfers," FATF Standards, 2012 (updated).

[14] L. Lamport, "Time, Clocks, and the Ordering of Events in a Distributed System," Communications of the ACM, vol. 21, no. 7, pp. 558–565, 1978.

[15] D. Ongaro and J. Ousterhout, "In Search of an Understandable Consensus Algorithm (Extended Version)," USENIX Annual Technical Conference, 2014.

---

## 付録 A：状態遷移表の完全列挙

実装上の正準形（`src/zc/orchestrator/state_machine.ts`）を再掲する。

```ts
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
  SETTLED:                [],
  FAILED_EXECUTION:       [],
  CANCELLED:              [],
  HTLC_LOCKED:            ['HTLC_FULFILL_REQUESTED', 'DECIDED_CANCEL'],
  HTLC_FULFILL_REQUESTED: ['DECIDED_TO_SETTLE', 'FAILED_EXECUTION'],
}
```

`ALLOWED_ENTRY_STATES`（`src/zc/lanes/_helpers.ts`）は次の通り：

```ts
const ALLOWED_ENTRY_STATES = new Set<TxState>([
  'RECEIVED',           // 通常のレーン入口
  'HTLC_LOCKED',        // HTLC 入口（hashlock 提示時）
  'DECIDED_TO_SETTLE',  // GTID レッグ入口（GT-level Decision 後）
])
```

---

## 付録 B：実装の確認方法

参照実装は次の手順で動作確認できる（`README.md` より）。

```bash
git clone https://github.com/pochatt/zenith-payment-system.git
cd zenith-payment-system
npm install
npm run db:migrate:local
npm run dev               # http://localhost:8787

# テストスイート（約 400 ケース）
npm run test

# 単一レーンの動作確認
npx vitest test/zc/express.test.ts
npx vitest test/zc/htlc.test.ts
npx vitest test/integration/balance_invariants.test.ts
```

不変条件の検証コードは次のファイルに集約されている。

| 不変条件 | 検証ファイル |
| --- | --- |
| I1（単一遷移表通過） | `test/zc/lane_invariants.test.ts` |
| I2（原子対化） | `test/zc/atomic_finality.test.ts`, `test/zc/lane_helpers.test.ts` |
| I3（残高保存則） | `test/integration/balance_invariants.test.ts` |
| I4（H 制約） | `test/zc/h_model.test.ts` |
| I5（event_seq 単調性） | `test/zc/finality_seq.test.ts` |
| I6（ハッシュチェーン整合性） | `test/zc/finality_chain.test.ts` |

---

*本論文はフィクションであり、実在のいずれの組織・システム・運用も示していません。記述は参照実装に基づきますが、実プロダクション運用を意図したものではありません。*
