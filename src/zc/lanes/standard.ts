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
 * Standardlane受付: RECEIVED をreturn（同期）
 * 後続処理（PreCheck → NameCheck → AuthorityCheck）はqueueで非同期実行
 */
export function processStandardIngress(req: PaymentInitiatedRequest): StandardIngressResult {
  return { result: "INGRESS_ACCEPTED", txid: req.txid, state: "RECEIVED" };
}

/**
 * Standard非同期処理: RECEIVED → PRECHECKED → (PRECHECKED_SUSPENDED) → H_RESERVED → DECIDED_TO_SETTLE
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
  if (tx.state !== "RECEIVED") return; // If already progressed

  // 1. PRECHECKED
  const prechecked = await transitionWithLog(db, {
    txid,
    fromState: "RECEIVED",
    toState: "PRECHECKED",
    eventType: "PreCheckPassed",
    payload: { txid },
  });
  if (!prechecked.applied) return; // Other call already transitioned

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

  // 3. Name Check (Standard shows account info → name result)
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
    // Transition name confirmation to PRECHECKED_SUSPENDED, await (final customer confirmation)
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

  // 4. H-reserved
  const hResult = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db);
  if (!hResult.ok) {
    await cancelInFlightTx(db, { txid, reasonCode: hResult.reason, fromStates: ["PRECHECKED"] });
    return;
  }
  const reservationId = hResult.reservation_id;

  const reserved = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED",
    toState: "H_RESERVED",
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
      fromStates: ["H_RESERVED"],
    });
    return;
  }

  // 6. Final payer pending auth (Standard-specific)
  // REFUND purpose has no natural approver from OPS; auto-authorize
  // Other transactions: party calls POST /api/transfers/:txid/authorize
  // 呼び出すまで H_RESERVED 状態で待機する。
  // Principle: ZC is not decision authority but state relay. Final fund transfer authorization vested in party
  if (tx.purpose === "REFUND") {
    await authorizeStandard(txid, true, env);
  }
}

/**
 * /authorize endpointから呼ばれる: H_RESERVED → DECIDED_TO_SETTLE
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
  if (!tx || tx.state !== "H_RESERVED") return { ok: false, state: tx?.state ?? "NOT_FOUND" };

  if (!authorized) {
    await cancelInFlightTx(db, { txid, reasonCode: "CANCEL_BY_PAYER", fromStates: ["H_RESERVED"] });
    // On H_RESERVED cancellation, release bank segregated deposit (reserve-funds succeeded)
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
  if (!decided.applied) return { ok: false, state: decided.previousState ?? "STATE_CONFLICT" };

  // Switch H-reserved RESERVED → LOCKED (hold until DNS settlement)
  if (tx.h_reservation_id) {
    await lockH(tx.h_reservation_id, db);
  }

  // Enqueue Execution
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
 * 名義不一致サスペンド後の再開: PRECHECKED_SUSPENDED → PRECHECKED → H_RESERVED
 * fund transfer行がcustomerconfirmationを経て /resume-namecheck を呼び出した際に実行される。
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

  // PRECHECKED_SUSPENDED → PRECHECKED (name check override)
  const resumed = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED_SUSPENDED",
    toState: "PRECHECKED",
    eventType: "NameCheckOverridden",
    payload: { txid },
    setColumns: { reason_code: null },
  });
  if (!resumed.applied) return { ok: false, state: "STATE_CONFLICT" };

  // H-reserved
  const hResult = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db);
  if (!hResult.ok) {
    await cancelInFlightTx(db, { txid, reasonCode: hResult.reason, fromStates: ["PRECHECKED"] });
    return { ok: true, state: "DECIDED_CANCEL" };
  }
  const reservationId = hResult.reservation_id;

  const reserved = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED",
    toState: "H_RESERVED",
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
      fromStates: ["H_RESERVED"],
    });
    return { ok: true, state: "DECIDED_CANCEL" };
  }

  return { ok: true, state: "H_RESERVED" };
}
