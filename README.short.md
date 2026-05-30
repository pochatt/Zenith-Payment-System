<!--
  これは README.md の「叩き台向け・短縮版」ドラフトです（自動生成ではなく提案）。
  現行 README.md は読み物として充実していますが、「議論のたたき台として渡す」用途では
  長さと自己説明的なトーンが入口の摩擦になります。この短縮版は、初見の実務者・研究者が
  5 分で要点と限界をつかみ、「どこを議論したいか」まで到達することを目的に再構成しました。
  採用する場合は README.md と差し替えるか、入口用として併置してください。
-->

# Zenith Payment System（短縮版ドラフト）

> 決済を「ブラックボックス」ではなく、「**説明できる状態の連なり**」として扱うための協調層の参照実装。

銀行の決済企画・政府渉外に携わった個人が、機密資料を一切使わず、基本コンセプトから個人の趣味として書き起こしたものです。TypeScript + Cloudflare Workers で最後まで動きます。実在のいずれの組織・システム・運用も示しません。

→ 構想の全体像：[Zenith 構想・基本コンセプト](https://www.sakuolia.jp/zenith.md) ／ 詳細な読み物：[README.md](README.md)

---

## 何の問題に手をつけているか

日本の決済は堅牢で安定しています。一方、利用者の側から見たときの「**いま自分のお金はどこにあるのか／なぜ遅れているのか／誰に聞けば分かるのか**」という説明可能性には、まだ伸びしろがあります。

Zenith は既存のレールを置き換えません。各行の勘定系・口座管理はそのままに、その「間」で起きることを、後からでも**同じ取引番号で誰にでも説明できる**ようにする協調層を描き直す試みです。

### 30 秒で伝わる例（電気代の口座振替）

| | いま | Zenith があると |
| --- | --- | --- |
| 残高不足で引落失敗 | ハガキが届くまで気づかない | 数秒で利用者・電気会社の双方に同じ通知 |
| 失敗→成立まで | 約 16 日 | 数時間 |
| コールセンター | 各自が状況を再構成 | 全員が同じ取引番号・同じ時刻・同じ理由コードを見る |

詳細は [`specs/walkthrough.md`](specs/walkthrough.md)（5 分）。

---

## 中核：状態機械 + 追記専用 FinalityLog

すべての決済を `受理 → Decision → Execution → 確定(b)` の状態の連なりに固定し、**すべての状態遷移を追記専用の FinalityLog に記録**します。

```
RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE
        → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED(b) → SETTLED
   （不能時）→ DECIDED_CANCEL → CANCELLED
```

状態遷移は必ず `transitionWithLog`（CAS UPDATE + FinalityLog INSERT を 1 バッチで原子発行）を通り、FinalityLog はハッシュチェーン（`prev_hash`）で改ざん耐性を持ち、日次 cron で全チェーンを自動監査します。**「状態だけ進んで監査ログが残らない窓」を構造的に作らない**ことを設計目標にしています。

TradFi（RTGS / DNS ネッティング / 全銀系 / ISO 20022 / FATF R.16）と DeFi 原始要素（HTLC / 原子マルチレグ）を、橋渡しではなく**同じ状態機械の対等なレーン**として並べています。

実装：[`src/zc/orchestrator/state_machine.ts`](src/zc/orchestrator/state_machine.ts)、[`src/zc/lanes/`](src/zc/lanes/)

---

## 触ってみる

```bash
git clone https://github.com/pochatt/zenith-payment-system.git
cd zenith-payment-system
npm install
npm run db:migrate:local
npm run dev          # http://localhost:8787（ルートがダッシュボード）
npm run test         # 統合テスト（463 ケース）
```

---

## 限界（誠実に）と、議論したいこと

本番運用は意図していません。

- 行ーコーディネータ間は HMAC-SHA256 のみ。TLS/mTLS・認可・保存時暗号化・規制適合は範囲外。
- 性能値は開発環境の観測値で、本番保証ではない。
- 一部の規範要件は方式設計に書いたが**実装は道半ば**（DNS_HOLD の igs_mode 階層遷移、長期 H_locked の自動解放、`MisrecordCorrected`、Bulk LSM 最適化、GTID の N:M fan-in/out 等）。詳細は [`specs/architecture.md`](specs/architecture.md) § 7。

**この叩き台に対して、特に議論したい問い：**

1. この協調層を**誰が運営**し、既存の全銀ネット・日銀ネットと**どう接続**するのが現実的か。
2. 移行コストを誰がどう負担するか（並行稼働・段階移行の現実解）。
3. 危機時（DNS_HOLD）の流動性供給カスケードを、制度としてどこまで自動化し、どこから人の判断にするか。

意図は「実物の代わり」ではなく「**議論のたたき台**」を提供することです。気に入った部分だけ持ち帰っていただいて構いません。

---

## ドキュメント地図

構想（読み物）→ 方式設計 → 制度・ガバナンス → IF/データ の四層：

- 構想：[Zenith 構想](https://www.sakuolia.jp/zenith.md)、[`specs/walkthrough.md`](specs/walkthrough.md)
- 方式：[`specs/zenith_public.md`](specs/zenith_public.md)、[`specs/architecture.md`](specs/architecture.md)
- 制度：[`specs/zenith_policy.md`](specs/zenith_policy.md)
- IF/データ：[`specs/api-contracts.md`](specs/api-contracts.md)、[`specs/schema.md`](specs/schema.md)

詳細な背景・設計思想 10 箇条・先行研究との関係は [README.md](README.md) を参照。

MIT License.

---

## English (brief)

A reference implementation of a **coordination layer** that makes inter-bank settlement explicable as a sequence of states recorded in an append-only, hash-chained FinalityLog — without replacing any bank's core ledger. Written by an individual, from first principles, no confidential material, as a personal project. Runs end-to-end on TypeScript + Cloudflare Workers.

It expresses traditional rails (RTGS, DNS netting, Zengin, ISO 20022, FATF R.16) and DeFi primitives (HTLC, atomic multi-leg) as **coequal lanes on one state machine**, not as ledgers joined by a bridge.

Not for production (HMAC-only auth; several normative requirements still unimplemented — see [`specs/architecture.md`](specs/architecture.md) § 7). The intent is **something to argue with**. The questions worth arguing: who operates this layer, how it connects to existing RTGS/clearing rails, and who bears the migration cost.

Full essay, design principles, and relation to prior art: [README.md](README.md).
