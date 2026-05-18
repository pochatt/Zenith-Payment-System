/**
 * @file orchestrator.ts - ZC State Machine Core & Bank Call Hub
 *
 * Public API barrel: imports from domain sub-modules and defines the queue
 * dispatcher and execution confirmation handlers that tie them together.
 *
 * Sub-modules (each independently importable):
 *   orchestrator/state_machine.ts  — isValidTransition, ALLOWED_TRANSITIONS
 *   orchestrator/finality.ts       — writeFinalityLog, finalizeCancelledTx, suspendTx
 *   orchestrator/gtid.ts           — checkAndFinalizeGtid
 *   orchestrator/bank_hub.ts       — callBank* functions
 */
import type { Env, TxState, QueueMessage } from "../types";
import { nowISO } from "../types";
import { releaseH } from "./h_model";
import { openCase, autoResolveCaseForTx } from "./case";
import { logTxEvent } from "./trace";
import { createCreditNotification, deliverNotification } from "./credit_notify";
import { publishEvent } from "./stream";

// ---------------------------------------------------------------------------
// Sub-module imports (used internally and re-exported below)
// ---------------------------------------------------------------------------
import { isValidTransition, ALLOWED_TRANSITIONS } from "./orchestrator/state_machine";
import type { FinalityLogEntry } from "./orchestrator/finality";
import { writeFinalityLog, finalizeCancelledTx, suspendTx } from "./orchestrator/finality";
import { checkAndFinalizeGtid } from "./orchestrator/gtid";
import {
  callBankReserveFunds,
  callBankExecuteDebit,
  callBankExecuteCredit,
  callBankReleaseReserve,
  callBankLegReadyCheck,
  callBankAuthorityCheck,
  callBankNameCheck,
} from "./orchestrator/bank_hub";

// ---------------------------------------------------------------------------
// Re-exports — all existing import paths remain valid without changes
// ---------------------------------------------------------------------------
export {
  isValidTransition,
  ALLOWED_TRANSITIONS,
  writeFinalityLog,
  finalizeCancelledTx,
  suspendTx,
  checkAndFinalizeGtid,
  callBankReserveFunds,
  callBankExecuteDebit,
  callBankExecuteCredit,
  callBankReleaseReserve,
  callBankLegReadyCheck,
  callBankAuthorityCheck,
  callBankNameCheck,
};
export type { FinalityLogEntry };

// ---------------------------------------------------------------------------
// Execution 完了後の状態遷移処理
// ---------------------------------------------------------------------------

/**
 * Handle payer execution confirmation (proof "a").
 * Records the payer bank proof, transitions to PAYER_EXEC_CONFIRMED,
 * then enqueues the payee credit (proof "b") for asynchronous processing.
 */
export async function onPayerExecConfirmed(
  txid: string,
  bankProofRefJson: string,
  env: Env
): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const tx = await db
    .prepare(
      `SELECT state, lane, payee_bank_id, payee_account_hash, amount_value, decision_proof_ref, version FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      state: TxState;
      lane: string;
      payee_bank_id: string;
      payee_account_hash: string | null;
      amount_value: number;
      decision_proof_ref: string | null;
      version: number;
    }>();
  if (!tx) return;

  if (!isValidTransition(tx.state, "PAYER_EXEC_CONFIRMED")) {
    console.error(
      `[orchestrator] Invalid transition ${tx.state} → PAYER_EXEC_CONFIRMED for ${txid}`
    );
    return;
  }

  const updated = await db
    .prepare(
      `UPDATE Transactions SET state='PAYER_EXEC_CONFIRMED', payer_bank_proof_ref=?, updated_at=?, version=version+1
     WHERE txid=? AND state=? AND version=?`
    )
    .bind(bankProofRefJson, now, txid, tx.state, tx.version)
    .run();

  if ((updated.meta.changes ?? 0) === 0) return;

  await writeFinalityLog(db, {
    txid,
    event_type: "PayerExecConfirmed",
    state_from: tx.state,
    state_to: "PAYER_EXEC_CONFIRMED",
    // bankProofRefJson は呼び出し側で JSON.stringify 済み。parse→stringify を経由せず
    // 文字列連結で payload を構築し、中間オブジェクト確保を回避する。
    payload_json: `{"payer_bank_proof_ref":${bankProofRefJson}}`,
    txid_or_gtid: txid,
  });

  await autoResolveCaseForTx(db, txid);

  // HIGH_VALUE レーンは IGS コールバック（handleIgsCallback）が ZC_BANK_CREDIT を投入する
  if (tx.lane !== "HIGH_VALUE") {
    await env.QUEUE.send({
      type: "ZC_BANK_CREDIT",
      payload: {
        txid,
        payee_bank_id: tx.payee_bank_id,
        payee_account_hash: tx.payee_account_hash ?? undefined,
        amount: { value: tx.amount_value, currency: "JPY" },
        decision_proof_ref: tx.decision_proof_ref ?? "",
      },
      txid,
      attempt: 0,
      enqueued_at: now,
    });
  }
}

/**
 * Handle payee execution confirmation (proof "b").
 * Records the payee bank proof, transitions through PAYEE_EXEC_CONFIRMED to
 * SETTLED, publishes SSE events, and triggers credit notification delivery.
 */
export async function onPayeeExecConfirmed(
  txid: string,
  bankProofRefJson: string,
  env: Env
): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const tx = await db
    .prepare(
      `SELECT state, lane, h_reservation_id, payee_bank_id, payee_account_hash, payer_bank_id, amount_value, purpose, edi_ref, version, external_settlement_status FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      state: TxState;
      lane: string;
      h_reservation_id: string | null;
      payee_bank_id: string;
      payee_account_hash: string | null;
      payer_bank_id: string;
      amount_value: number;
      purpose: string | null;
      edi_ref: string | null;
      version: number;
      external_settlement_status: string;
    }>();
  if (!tx) return;

  if (!isValidTransition(tx.state, "PAYEE_EXEC_CONFIRMED")) return;

  // HIGH_VALUE 不変条件: external_settlement_status = 'SETTLED' でなければ b確認を拒否
  // (spec: "PAYEE_EXEC_CONFIRMED(b)へ遷移してよいのは external_settlement_status == SETTLED の場合に限る")
  if (tx.lane === "HIGH_VALUE" && tx.external_settlement_status !== "SETTLED") {
    console.error(
      `[orchestrator] HV invariant violated for ${txid}: external_settlement_status=${tx.external_settlement_status}, expected SETTLED`
    );
    return;
  }

  const updated = await db
    .prepare(
      `UPDATE Transactions SET state='PAYEE_EXEC_CONFIRMED', payee_bank_proof_ref=?, updated_at=?, version=version+1
     WHERE txid=? AND state=? AND version=?`
    )
    .bind(bankProofRefJson, now, txid, tx.state, tx.version)
    .run();

  if ((updated.meta.changes ?? 0) === 0) return;

  await writeFinalityLog(db, {
    txid,
    event_type: "PayeeExecConfirmed",
    state_from: tx.state,
    state_to: "PAYEE_EXEC_CONFIRMED",
    // 同上: parse→stringify を回避（bankProofRefJson は既に有効な JSON 文字列）
    payload_json: `{"payee_bank_proof_ref":${bankProofRefJson}}`,
    txid_or_gtid: txid,
  });

  await autoResolveCaseForTx(db, txid);

  // SETTLED への遷移（CAS version guard 付き）
  const txAfterPayee = await db
    .prepare(`SELECT version FROM Transactions WHERE txid = ? AND state = 'PAYEE_EXEC_CONFIRMED'`)
    .bind(txid)
    .first<{ version: number }>();
  if (!txAfterPayee) return;
  const settledResult = await db
    .prepare(
      `UPDATE Transactions SET state='SETTLED', updated_at=?, version=version+1 WHERE txid=? AND state='PAYEE_EXEC_CONFIRMED' AND version=?`
    )
    .bind(now, txid, txAfterPayee.version)
    .run();
  if ((settledResult.meta.changes ?? 0) === 0) return;
  await writeFinalityLog(db, {
    txid,
    event_type: "Settled",
    state_from: "PAYEE_EXEC_CONFIRMED",
    state_to: "SETTLED",
    payload_json: JSON.stringify({ txid }),
    txid_or_gtid: txid,
  });

  await publishEvent(db, tx.payee_bank_id, "TX_STATE_CHANGED", { txid, newState: "SETTLED" });

  let notificationId: string | null = null;
  let notificationDelivered = false;
  try {
    notificationId = await createCreditNotification(
      db,
      txid,
      tx.payee_bank_id,
      tx.payee_account_hash ?? "",
      { value: tx.amount_value, currency: "JPY" },
      tx.payer_bank_id,
      tx.purpose ?? null,
      tx.edi_ref ?? null
    );
    await deliverNotification(db, notificationId, env);
    notificationDelivered = true;
    await publishEvent(db, tx.payee_bank_id, "CREDIT_RECEIVED", { txid, amount: tx.amount_value });
  } catch (err) {
    console.error(`[orchestrator] credit notification failed for ${txid}:`, err);
  }
  await writeFinalityLog(db, {
    txid,
    event_type: "CreditNotificationAttempted",
    state_from: "SETTLED",
    state_to: "SETTLED",
    payload_json: JSON.stringify({
      notification_id: notificationId,
      delivered: notificationDelivered,
      payee_bank_id: tx.payee_bank_id,
    }),
    txid_or_gtid: txid,
  });

  try {
    const { handleBankIngress } = await import("../bank/ingress");
    await handleBankIngress(
      tx.payer_bank_id,
      "debit-settled",
      {
        request_id: `DEBIT-SETTLED-${txid}`,
        txid,
        amount: { value: tx.amount_value, currency: "JPY" },
        payee_bank_id: tx.payee_bank_id,
        settled_at: now,
      },
      env
    );
  } catch (err) {
    console.error(`[orchestrator] debit-settled notification failed for ${txid}:`, err);
  }

  // Reversal cascade: look up by ReversalRecords.reversal_txid instead of a
  // txid prefix so future txid format changes do not silently skip the
  // completion callback.
  const reversalRow = await db
    .prepare(`SELECT reversal_id FROM ReversalRecords WHERE reversal_txid = ? LIMIT 1`)
    .bind(txid)
    .first<{ reversal_id: string }>();
  if (reversalRow) {
    const { completeReversal } = await import("./reversal");
    await completeReversal(txid, db).catch((e) =>
      console.error(`[orchestrator] completeReversal failed for ${txid}:`, e)
    );
  }

  // GTID cascade: query GtidLegs by txid (the foreign-key already exists)
  // instead of inferring lane membership from a txid prefix.
  const leg = await db
    .prepare(`SELECT gtid FROM GtidLegs WHERE txid = ?`)
    .bind(txid)
    .first<{ gtid: string }>();
  if (leg) {
    await checkAndFinalizeGtid(leg.gtid, db);
  }
}

// ---------------------------------------------------------------------------
// Queue message dispatcher
// ---------------------------------------------------------------------------

/**
 * Central queue message dispatcher. Routes at-least-once messages to the
 * appropriate handler based on message type. Re-throws errors to trigger
 * queue retry (at-least-once delivery guarantee).
 */
export async function processQueueMessage(msg: QueueMessage, env: Env): Promise<void> {
  try {
    switch (msg.type) {
      case "ZC_BANK_RESERVE": {
        const p = msg.payload as { htlc_id: string; txid: string };
        const { lockHtlc } = await import("./lanes/htlc");
        await lockHtlc(p.htlc_id, env);
        break;
      }
      case "ZC_BANK_DEBIT": {
        const p = msg.payload as {
          txid: string;
          payer_bank_id: string;
          payee_bank_id: string;
          amount: { value: number; currency: string };
          decision_proof_ref: string;
          reservation_id?: string;
          lane?: string;
          payer_account_hash?: string;
        };
        const t0 = Date.now();
        const bankResp = await callBankExecuteDebit(
          p.payer_bank_id,
          {
            request_id: `DEBIT-${p.txid}`,
            txid: p.txid,
            amount: p.amount,
            decision_proof_ref: p.decision_proof_ref,
            h_reservation: p.reservation_id
              ? { reservation_id: p.reservation_id, mode: "RESERVED" }
              : undefined,
            lane: p.lane as any,
            payer_account_hash: p.payer_account_hash,
          },
          env
        );
        await logTxEvent(env.DB, {
          txid: p.txid,
          actor: `BANK_${p.payer_bank_id}`,
          action: "EXECUTE_DEBIT",
          status: bankResp.result === "OK" ? "OK" : "NG",
          reason_code:
            bankResp.result !== "OK"
              ? ((bankResp as unknown as Record<string, unknown>).reason_code as string | undefined)
              : null,
          amount: p.amount.value,
          bank_id: p.payer_bank_id,
          duration_ms: Date.now() - t0,
        });
        if (bankResp.result === "OK") {
          await onPayerExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env);
          if (p.lane === "HIGH_VALUE") {
            const { initiateIgsSettlement } = await import("./igs");
            await env.DB.prepare(
              `UPDATE Transactions SET external_settlement_status='REQUESTED', updated_at=? WHERE txid=?`
            )
              .bind(nowISO(), p.txid)
              .run();
            await initiateIgsSettlement(
              env.DB,
              p.txid,
              { value: p.amount.value, currency: p.amount.currency },
              p.payer_bank_id,
              p.payee_bank_id,
              env
            );
          }
        } else {
          await suspendTx(p.txid, "EXEC_DEBIT_FAILED", env.DB, {
            bank_id: p.payer_bank_id,
            bank_result: (bankResp as unknown as Record<string, unknown>).result,
            bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
          });
        }
        break;
      }
      case "ZC_BANK_CREDIT": {
        const p = msg.payload as {
          txid: string;
          payee_bank_id: string;
          amount: { value: number; currency: string };
          decision_proof_ref: string;
          payee_account_hash?: string;
        };
        const t1 = Date.now();
        const bankResp = await callBankExecuteCredit(
          p.payee_bank_id,
          {
            request_id: `CREDIT-${p.txid}`,
            txid: p.txid,
            amount: p.amount,
            decision_proof_ref: p.decision_proof_ref,
            payee_account_hash: p.payee_account_hash,
          },
          env
        );
        await logTxEvent(env.DB, {
          txid: p.txid,
          actor: `BANK_${p.payee_bank_id}`,
          action: "EXECUTE_CREDIT",
          status:
            bankResp.result === "OK"
              ? "OK"
              : bankResp.result === "PENDING_APPROVAL"
                ? "PENDING"
                : "NG",
          reason_code:
            bankResp.result === "FILTER_REJECTED"
              ? bankResp.reason_code
              : bankResp.result === "PENDING_APPROVAL"
                ? "AWAITING_PAYEE_APPROVAL"
                : null,
          amount: p.amount.value,
          bank_id: p.payee_bank_id,
          details:
            bankResp.result === "PENDING_APPROVAL"
              ? { approval_id: bankResp.approval_id }
              : undefined,
          duration_ms: Date.now() - t1,
        });
        if (bankResp.result === "OK") {
          await onPayeeExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env);
        } else if (bankResp.result === "PENDING_APPROVAL") {
          await suspendTx(p.txid, "AWAITING_PAYEE_APPROVAL", env.DB);
          await writeFinalityLog(env.DB, {
            txid: p.txid,
            event_type: "FilterPending",
            state_from: "PAYER_EXEC_CONFIRMED",
            state_to: "SUSPENDED",
            payload_json: JSON.stringify({ approval_id: bankResp.approval_id }),
            txid_or_gtid: p.txid,
          });
        } else if (bankResp.result === "FILTER_REJECTED") {
          await suspendTx(p.txid, "PAYEE_FILTER_REJECTED", env.DB);
          await writeFinalityLog(env.DB, {
            txid: p.txid,
            event_type: "FilterRejected",
            state_from: "PAYER_EXEC_CONFIRMED",
            state_to: "SUSPENDED",
            payload_json: JSON.stringify({
              filter_id: bankResp.filter_id,
              reason_code: bankResp.reason_code,
            }),
            txid_or_gtid: p.txid,
          });
        } else {
          await suspendTx(p.txid, "EXEC_CREDIT_FAILED", env.DB, {
            bank_id: p.payee_bank_id,
            bank_result: (bankResp as unknown as Record<string, unknown>).result,
            bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
          });
        }
        break;
      }
      case "ZC_RESUME_CREDIT": {
        const p = msg.payload as {
          txid: string;
          payee_bank_id: string;
          payee_account_hash?: string;
        };
        const resumeRequestId = `CREDIT-RESUME-${p.txid}`;
        const txInfo = await env.DB.prepare(
          `SELECT amount_value, decision_proof_ref, payee_account_hash FROM Transactions WHERE txid=?`
        )
          .bind(p.txid)
          .first<{
            amount_value: number;
            decision_proof_ref: string | null;
            payee_account_hash: string | null;
          }>();
        if (!txInfo) {
          console.error("[ZC_RESUME_CREDIT] txid not found:", p.txid);
          break;
        }
        const bankResp = await callBankExecuteCredit(
          p.payee_bank_id,
          {
            request_id: resumeRequestId,
            txid: p.txid,
            amount: { value: txInfo.amount_value, currency: "JPY" },
            decision_proof_ref: txInfo.decision_proof_ref ?? "",
            payee_account_hash: p.payee_account_hash ?? txInfo.payee_account_hash ?? undefined,
          },
          env
        );
        if (bankResp.result === "OK") {
          await onPayeeExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env);
        } else {
          console.error(`[ZC_RESUME_CREDIT] retry failed: ${JSON.stringify(bankResp)}`);
          const resumeFailReason = "EXEC_CREDIT_FAILED_ON_RESUME";
          await env.DB.prepare(
            `UPDATE Transactions SET reason_code=?, updated_at=?, version=version+1 WHERE txid=? AND state='SUSPENDED'`
          )
            .bind(resumeFailReason, nowISO(), p.txid)
            .run();
          await writeFinalityLog(env.DB, {
            txid: p.txid,
            event_type: "ResumeCreditFailed",
            state_from: "SUSPENDED",
            state_to: "SUSPENDED",
            payload_json: JSON.stringify({
              reason_code: resumeFailReason,
              bank_id: p.payee_bank_id,
              bank_result: (bankResp as unknown as Record<string, unknown>).result,
              bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
            }),
            txid_or_gtid: p.txid,
          });
          await openCase(env.DB, {
            related_txid: p.txid,
            reason_code: resumeFailReason,
            opened_by: "ZC",
            description: `Resume credit failed after payee approval: ${JSON.stringify(bankResp)}`,
          });
        }
        break;
      }
      case "ZC_BANK_RELEASE": {
        const p = msg.payload as { reservation_id: string; txid?: string; bank_id?: string };
        await releaseH(p.reservation_id, env.DB);
        if (p.txid && p.bank_id) {
          await callBankReleaseReserve(
            p.bank_id,
            {
              request_id: `RELEASE-${p.reservation_id}`,
              txid: p.txid,
              reservation_ref: p.reservation_id,
            },
            env
          ).catch((e) => console.error(`[ZC_BANK_RELEASE] release-reserve failed: ${e}`));
        }
        break;
      }
      case "ZC_BANK_LEG_READY": {
        const p = msg.payload as { gtid: string };
        const { advanceGtid } = await import("./lanes/gtid");
        await advanceGtid(p.gtid, env);
        break;
      }
      case "ZC_STATE_ADVANCE": {
        const p = msg.payload as { txid: string; action: string };
        if (p.action === "ADVANCE_STANDARD") {
          const { advanceStandard } = await import("./lanes/standard");
          await advanceStandard(p.txid, env);
        } else if (p.action === "ADVANCE_BULK") {
          const { advanceBulk } = await import("./lanes/bulk");
          await advanceBulk(p.txid, env);
        } else if (p.action === "ADVANCE_HV") {
          const { advanceHighValue } = await import("./lanes/highvalue");
          await advanceHighValue(p.txid, env);
        } else if (p.action === "AUTO_AUTHORIZE") {
          const { authorizeStandard } = await import("./lanes/standard");
          await authorizeStandard(p.txid, true, env);
        }
        break;
      }
      case "ZC_IGS_CALLBACK": {
        const p = msg.payload as import("../types").IgsCallbackInput;
        const { handleIgsCallback } = await import("./igs");
        await handleIgsCallback(env.DB, p, env);
        break;
      }
      default:
        console.error("[queue] Unknown message type:", msg.type);
    }
  } catch (err) {
    console.error("[queue] Error processing message:", err);
    throw err;
  }
}
