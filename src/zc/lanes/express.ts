/**
 * @file EXPRESS lane processing. Synchronous end-to-end settlement within a
 *       single request: PreCheck -> H-Reserve -> Decision -> Debit -> Credit -> Settle.
 *
 * Migrated to use `transitionWithLog` / `cancelInFlightTx` so every state
 * advance is validated against `ALLOWED_TRANSITIONS` and batched atomically
 * with its FinalityLog entry.
 *
 * @module zc/lanes/express
 */
import type { Env, PaymentInitiatedRequest } from "../../types";
import { nowISO } from "../../types";
import { reserveH, lockH } from "../h_model";
import { newDecisionProofRef, newFinalityLogRef } from "../../shared/proof";
import { callBankAuthorityCheck, callBankNameCheck, callBankReserveFunds } from "../orchestrator";
import { getOrCreateDnsCycle } from "../dns";
import { transitionWithLog, cancelInFlightTx } from "./_helpers";

export interface ExpressResult {
  result: "DECISION_ACCEPTED" | "DECISION_REJECTED";
  txid: string;
  state: string;
  decision_proof_ref?: string;
  reason_code?: string;
}

/**
 * Expressレーン: 同期で Decision まで完結
 * RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE
 */
export async function processExpress(
  req: PaymentInitiatedRequest,
  env: Env
): Promise<ExpressResult> {
  const db = env.DB;
  const txid = req.txid;
  const now = nowISO();

  // 1. PRECHECKED — validated via transitionWithLog (ALLOWED_TRANSITIONS check + atomic log).
  const prechecked = await transitionWithLog(db, {
    txid,
    fromState: "RECEIVED",
    toState: "PRECHECKED",
    eventType: "PreCheckPassed",
    payload: { txid },
  });
  if (!prechecked.applied) {
    return {
      result: "DECISION_REJECTED",
      txid,
      state: prechecked.previousState ?? "NOT_FOUND",
      reason_code: "INVALID_STATE",
    };
  }

  // 2. AML/Authority Check（payerBank）
  // 決定論的 request_id（同一 txid なら同一 request_id を生成）
  const authResult = await callBankAuthorityCheck(
    req.payer.bank_id,
    {
      request_id: `AUTH-${txid}`,
      txid,
      check_type: "INITIAL",
      vault_ref: req.payer.vault_ref,
    },
    env
  );
  if (authResult.result === "NG") {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: authResult.reason_code ?? "AUTHORITY_CHECK_NG",
    });
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "DECIDED_CANCEL",
      reason_code: authResult.reason_code,
    };
  }

  // 3. Name Check（PSPR参照または payeeAccount）
  const nameResult = await callBankNameCheck(
    req.payee.bank_id,
    {
      request_id: `NAME-${txid}`,
      txid,
      pspr_ref: req.pspr_ref,
      account_hash: req.payee.account_hash ?? "",
    },
    env
  );
  if (nameResult.result === "MISMATCH") {
    await cancelInFlightTx(db, { txid, reasonCode: "NAME_MISMATCH" });
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "DECIDED_CANCEL",
      reason_code: "NAME_MISMATCH",
    };
  }

  // 4. H予約
  const hResult = await reserveH(req.payer.bank_id, txid, req.amount.value, db);
  if (!hResult.ok) {
    await cancelInFlightTx(db, { txid, reasonCode: hResult.reason });
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "DECIDED_CANCEL",
      reason_code: hResult.reason,
    };
  }
  const reservationId = hResult.reservation_id;

  // H_RESERVED 状態に遷移
  const reserved = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED",
    toState: "H_RESERVED",
    eventType: "HReserved",
    payload: { reservation_id: reservationId },
    setColumns: { h_reservation_id: reservationId },
  });
  if (!reserved.applied) {
    return {
      result: "DECISION_REJECTED",
      txid,
      state: reserved.previousState ?? "NOT_FOUND",
      reason_code: "CAS_LOST",
    };
  }

  // 5. Bank reserve-funds 呼び出し
  const reserveResult = await callBankReserveFunds(
    req.payer.bank_id,
    {
      request_id: `RESERVE-${txid}`,
      txid,
      amount: req.amount,
      account_hash: req.payer.account_hash,
    },
    env
  );
  if (reserveResult.result === "ERROR") {
    await cancelInFlightTx(db, { txid, reasonCode: reserveResult.reason_code ?? "RESERVE_FAILED" });
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "DECIDED_CANCEL",
      reason_code: reserveResult.reason_code,
    };
  }

  // 6. Decision 確定
  const decisionProofRef = newDecisionProofRef();
  const finalityLogRef = newFinalityLogRef();
  // DECIDED_TO_SETTLE 時に dns_cycle_id を設定（H解放のために必要）
  const dnsCycleId = await getOrCreateDnsCycle(db, now);
  const decided = await transitionWithLog(db, {
    txid,
    fromState: "H_RESERVED",
    toState: "DECIDED_TO_SETTLE",
    eventType: "DecidedToSettle",
    payload: { decision_proof_ref: decisionProofRef },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
      dns_cycle_id: dnsCycleId,
    },
  });
  if (!decided.applied) {
    return {
      result: "DECISION_REJECTED",
      txid,
      state: decided.previousState ?? "NOT_FOUND",
      reason_code: "CAS_LOST",
    };
  }

  // H予約を RESERVED → LOCKED に切り替え（DNS清算まで保持）
  await lockH(reservationId, db);

  // 7. 非同期で Execution をキューに投入
  await env.QUEUE.send({
    type: "ZC_BANK_DEBIT",
    payload: {
      payer_bank_id: req.payer.bank_id,
      payee_bank_id: req.payee.bank_id,
      txid,
      amount: req.amount,
      decision_proof_ref: decisionProofRef,
      reservation_id: reservationId,
    },
    txid,
    attempt: 0,
    enqueued_at: now,
  });

  return {
    result: "DECISION_ACCEPTED",
    txid,
    state: "DECIDED_TO_SETTLE",
    decision_proof_ref: decisionProofRef,
  };
}
