/**
 * @file STANDARD lane processing. Async multi-step flow: PreCheck -> H-Reserve
 *       -> Authorization -> Decision -> Debit -> Credit -> Settle.
 *
 * Migrated to use `transitionWithLog` / `cancelInFlightTx` so each state
 * advance is validated against `ALLOWED_TRANSITIONS` and atomically logged.
 *
 * @module zc/lanes/standard
 */
import type { Env, PaymentInitiatedRequest } from "../../types";
import { nowISO } from "../../types";
import { reserveH, lockH } from "../h_model";
import { newDecisionProofRef, newFinalityLogRef } from "../../shared/proof";
import {
  callBankAuthorityCheck,
  callBankNameCheck,
  callBankReserveFunds,
  callBankReleaseReserve,
} from "../orchestrator";
import { getOrCreateDnsCycle } from "../dns";
import { transitionWithLog, cancelInFlightTx } from "./_helpers";

export interface StandardIngressResult {
  result: "INGRESS_ACCEPTED";
  txid: string;
  state: "RECEIVED";
}

/**
 * Standardレーン受付: RECEIVED を返す（同期）
 * 後続処理（PreCheck → NameCheck → AuthorityCheck）はキューで非同期実行
 */
export function processStandardIngress(req: PaymentInitiatedRequest): StandardIngressResult {
  return { result: "INGRESS_ACCEPTED", txid: req.txid, state: "RECEIVED" };
}

/**
 * Standard非同期処理: RECEIVED → PRECHECKED → (PRECHECKED_SUSPENDED) → H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held) → DECIDED_TO_SETTLE
 * Queueコンシューマーから呼ばれる
 */
export async function advanceStandard(txid: string, env: Env): Promise<void> {
  const db = env.DB;

  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{
      state: string;
      payer_bank_id: string;
      payee_bank_id: string;
      amount_value: number;
      pspr_ref: string | null;
      payer_account_hash: string;
      payee_account_hash: string | null;
      version: number;
      expires_at: string | null;
      purpose: string | null;
    }>();
  if (!tx) return;
  if (tx.state !== "RECEIVED") return; // 既に進んでいる

  // 1. PRECHECKED
  const prechecked = await transitionWithLog(db, {
    txid,
    fromState: "RECEIVED",
    toState: "PRECHECKED",
    eventType: "PreCheckPassed",
    payload: { txid },
  });
  if (!prechecked.applied) return; // 別コールが先に遷移済み

  // 2. AML Authority Check
  const authResult = await callBankAuthorityCheck(
    tx.payer_bank_id,
    {
      request_id: `AUTH-${txid}`,
      txid,
      check_type: "INITIAL",
    },
    env
  );
  if (authResult.result === "NG") {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: authResult.reason_code ?? "AUTHORITY_CHECK_NG",
      fromStates: ["PRECHECKED"],
    });
    return;
  }

  // 3. Name Check（Standard は口座情報→名義結果を提示）
  const nameResult = await callBankNameCheck(
    tx.payee_bank_id,
    {
      request_id: `NAME-${txid}`,
      txid,
      pspr_ref: tx.pspr_ref ?? undefined,
      account_hash: tx.payee_account_hash ?? "",
    },
    env
  );
  if (nameResult.result === "MISMATCH") {
    // 名義確認結果を PRECHECKED_SUSPENDED に遷移して待機（顧客最終確認）
    await transitionWithLog(db, {
      txid,
      fromState: "PRECHECKED",
      toState: "PRECHECKED_SUSPENDED",
      eventType: "PreCheckSuspended",
      payload: { reason_code: "SUSPEND_NAMECHECK_PENDING" },
      setColumns: { reason_code: "SUSPEND_NAMECHECK_PENDING" },
    });
    return;
  }

  // 4. H予約
  const hResult = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db);
  if (!hResult.ok) {
    await cancelInFlightTx(db, { txid, reasonCode: hResult.reason, fromStates: ["PRECHECKED"] });
    return;
  }
  const reservationId = hResult.reservation_id;

  const reserved = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED",
    toState: "H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)",
    eventType: "HReserved",
    payload: { reservation_id: reservationId },
    setColumns: { h_reservation_id: reservationId },
  });
  if (!reserved.applied) return;

  // 5. Bank reserve-funds
  const reserveResult = await callBankReserveFunds(
    tx.payer_bank_id,
    {
      request_id: `RESERVE-${txid}`,
      txid,
      amount: { value: tx.amount_value, currency: "JPY" },
      account_hash: tx.payer_account_hash,
    },
    env
  );
  if (reserveResult.result === "ERROR") {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: reserveResult.reason_code ?? "RESERVE_FAILED",
      fromStates: ["H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)"],
    });
    return;
  }

  // 6. 支払人最終認可待ち（Standard固有）
  // REFUND purpose（Reversal TX）は OPS 起点で自然な承認者が存在しないため自動認可する。
  // その他の取引は送金行（または顧客）が POST /api/transfers/:txid/authorize を
  // 呼び出すまで H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held) 状態で待機する。
  // 基本思想: ZC は決定主体ではなく状態の中継者。送金の最終認可は送金行に委ねる。
  if (tx.purpose === "REFUND") {
    await authorizeStandard(txid, true, env);
  }
}

/**
 * /authorize エンドポイントから呼ばれる: H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held) → DECIDED_TO_SETTLE
 */
export async function authorizeStandard(
  txid: string,
  authorized: boolean,
  env: Env
): Promise<{ ok: boolean; state: string; decision_proof_ref?: string }> {
  const db = env.DB;
  const now = nowISO();

  const tx = await db
    .prepare(
      `SELECT state, payer_bank_id, payee_bank_id, amount_value, h_reservation_id, version FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      state: string;
      payer_bank_id: string;
      payee_bank_id: string;
      amount_value: number;
      h_reservation_id: string | null;
      version: number;
    }>();
  if (!tx || tx.state !== "H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)") return { ok: false, state: tx?.state ?? "NOT_FOUND" };

  if (!authorized) {
    await cancelInFlightTx(db, { txid, reasonCode: "CANCEL_BY_PAYER", fromStates: ["H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)"] });
    // H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held) キャンセル時は reserve-funds 成功済みのため銀行の別段預金を解放する
    const suspense = await db
      .prepare(
        `SELECT suspense_id FROM SuspenseDetails WHERE txid=? AND bank_id=? AND status='RESERVED' AND direction='PAY' LIMIT 1`
      )
      .bind(txid, tx.payer_bank_id)
      .first<{ suspense_id: string }>();
    if (suspense) {
      await callBankReleaseReserve(
        tx.payer_bank_id,
        {
          request_id: `CANCEL-RELEASE-${txid}`,
          txid,
          reservation_ref: suspense.suspense_id,
        },
        env
      ).catch((e) => console.error(`[authorizeStandard] release-reserve failed: ${e}`));
    }
    return { ok: true, state: "DECIDED_CANCEL" };
  }

  const decisionProofRef = newDecisionProofRef();
  const finalityLogRef = newFinalityLogRef();
  const dnsCycleId = await getOrCreateDnsCycle(db, now);

  const decided = await transitionWithLog(db, {
    txid,
    fromState: "H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)",
    toState: "DECIDED_TO_SETTLE",
    eventType: "DecidedToSettle",
    payload: { decision_proof_ref: decisionProofRef },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
      dns_cycle_id: dnsCycleId,
    },
  });
  if (!decided.applied) return { ok: false, state: decided.previousState ?? "STATE_CONFLICT" };

  // H予約を RESERVED → LOCKED に切り替え（DNS清算まで保持）
  if (tx.h_reservation_id) {
    await lockH(tx.h_reservation_id, db);
  }

  // Execution をキューに投入
  await env.QUEUE.send({
    type: "ZC_BANK_DEBIT",
    payload: {
      payer_bank_id: tx.payer_bank_id,
      payee_bank_id: tx.payee_bank_id,
      txid,
      amount: { value: tx.amount_value, currency: "JPY" },
      decision_proof_ref: decisionProofRef,
      reservation_id: tx.h_reservation_id,
    },
    txid,
    attempt: 0,
    enqueued_at: now,
  });

  return { ok: true, state: "DECIDED_TO_SETTLE", decision_proof_ref: decisionProofRef };
}

/**
 * 名義不一致サスペンド後の再開: PRECHECKED_SUSPENDED → PRECHECKED → H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)
 * 送金行が顧客確認を経て /resume-namecheck を呼び出した際に実行される。
 */
export async function resumeFromNameCheckSuspended(
  txid: string,
  env: Env
): Promise<{ ok: boolean; state: string }> {
  const db = env.DB;

  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{
      state: string;
      payer_bank_id: string;
      amount_value: number;
      payer_account_hash: string;
      version: number;
    }>();
  if (!tx) return { ok: false, state: "NOT_FOUND" };
  if (tx.state !== "PRECHECKED_SUSPENDED") return { ok: false, state: tx.state };

  // PRECHECKED_SUSPENDED → PRECHECKED（名義チェック上書き承認）
  const resumed = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED_SUSPENDED",
    toState: "PRECHECKED",
    eventType: "NameCheckOverridden",
    payload: { txid },
    setColumns: { reason_code: null },
  });
  if (!resumed.applied) return { ok: false, state: "STATE_CONFLICT" };

  // H予約
  const hResult = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db);
  if (!hResult.ok) {
    await cancelInFlightTx(db, { txid, reasonCode: hResult.reason, fromStates: ["PRECHECKED"] });
    return { ok: true, state: "DECIDED_CANCEL" };
  }
  const reservationId = hResult.reservation_id;

  const reserved = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED",
    toState: "H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)",
    eventType: "HReserved",
    payload: { reservation_id: reservationId },
    setColumns: { h_reservation_id: reservationId },
  });
  if (!reserved.applied) return { ok: false, state: "STATE_CONFLICT" };

  // Bank reserve-funds
  const reserveResult = await callBankReserveFunds(
    tx.payer_bank_id,
    {
      request_id: `RESERVE-${txid}`,
      txid,
      amount: { value: tx.amount_value, currency: "JPY" },
      account_hash: tx.payer_account_hash,
    },
    env
  );
  if (reserveResult.result === "ERROR") {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: reserveResult.reason_code ?? "RESERVE_FAILED",
      fromStates: ["H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)"],
    });
    return { ok: true, state: "DECIDED_CANCEL" };
  }

  return { ok: true, state: "H_RESERVED (H-reserve funds are held) (H-reserve funds are held) (H-reserve funds are held)" };
}
