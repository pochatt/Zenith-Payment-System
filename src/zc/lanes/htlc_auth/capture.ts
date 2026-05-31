/**
 * @file HTLC Auth capture (settle) and void (cancel).
 * @module zc/lanes/htlc_auth/capture
 */
import type { Env, HtlcCaptureRequest, HtlcVoidRequest, HtlcAuthRequestRow } from "../../../types";
import { nowISO } from "../../../types";
import { writeFinalityLog } from "../../orchestrator";
import { logTxEvent } from "../../trace";
import { claimHtlc, cancelHtlc } from "../htlc";

/**
 * The payee (merchant) performs the capture.
 * Retrieves the preimage from the Vault and calls claimHtlc internally.
 * POST /api/htlc/:htlc_id/capture
 */
export async function captureHtlcAuth(
  htlcId: string,
  req: HtlcCaptureRequest,
  env: Env
): Promise<{ result: "CAPTURED" | "ERROR"; txid?: string; reason_code?: string }> {
  const db = env.DB;
  const now = nowISO();

  const authReq = await db
    .prepare(`SELECT * FROM HtlcAuthRequests WHERE htlc_id=?`)
    .bind(htlcId)
    .first<HtlcAuthRequestRow>();

  if (!authReq) return { result: "ERROR", reason_code: "AUTH_NOT_FOUND" };
  if (authReq.status !== "AUTH_APPROVED") {
    return { result: "ERROR", reason_code: "INVALID_AUTH_STATE" };
  }

  // Capture deadline check
  if (new Date(authReq.capture_expires_at) <= new Date(now)) {
    await db
      .prepare(`UPDATE HtlcAuthRequests SET status='EXPIRED', updated_at=? WHERE auth_id=?`)
      .bind(now, authReq.auth_id)
      .run();
    return { result: "ERROR", reason_code: "CAPTURE_EXPIRED" };
  }

  // Retrieve the preimage from the Vault
  const vault = await db
    .prepare(`SELECT payload_json FROM Vault WHERE vault_ref=? AND is_evicted=0`)
    .bind(authReq.vault_ref)
    .first<{ payload_json: string }>();

  if (!vault) return { result: "ERROR", reason_code: "PREIMAGE_NOT_AVAILABLE" };

  const { preimage } = JSON.parse(vault.payload_json) as { preimage: string };

  // Call claimHtlc internally (present the preimage to move to DECIDED_TO_SETTLE)
  const claimResult = await claimHtlc(
    {
      htlc_id: htlcId,
      preimage,
      idempotency_key: req.idempotency_key,
    },
    env
  );

  if (claimResult.result !== "ACCEPTED") {
    return { result: "ERROR", reason_code: claimResult.reason_code ?? "CLAIM_FAILED" };
  }

  // Mark the Vault preimage as used
  await db.prepare(`UPDATE Vault SET is_evicted=1 WHERE vault_ref=?`).bind(authReq.vault_ref).run();

  // Update HtlcAuthRequests to CAPTURED
  await db
    .prepare(
      `UPDATE HtlcAuthRequests
     SET status='CAPTURED', captured_at=?, updated_at=?, version=version+1
     WHERE auth_id=?`
    )
    .bind(now, now, authReq.auth_id)
    .run();

  await logTxEvent(db, {
    txid: authReq.txid,
    actor: `BANK_${authReq.payee_bank_id}`,
    action: "HTLC_CAPTURE",
    status: "OK",
    amount: authReq.amount_value,
    bank_id: authReq.payee_bank_id,
    details: { auth_id: authReq.auth_id, htlc_id: htlcId },
  });

  return { result: "CAPTURED", txid: authReq.txid ?? undefined };
}

/**
 * The beneficiary or originator voids the authorization.
 * POST /api/htlc/:htlc_id/void
 */
export async function voidHtlcAuth(
  htlcId: string,
  req: HtlcVoidRequest,
  env: Env
): Promise<{ result: "VOIDED" | "ERROR"; reason_code?: string }> {
  const db = env.DB;
  const now = nowISO();

  const authReq = await db
    .prepare(`SELECT * FROM HtlcAuthRequests WHERE htlc_id=?`)
    .bind(htlcId)
    .first<HtlcAuthRequestRow>();

  if (!authReq) return { result: "ERROR", reason_code: "AUTH_NOT_FOUND" };
  if (authReq.status !== "AUTH_APPROVED") {
    return { result: "ERROR", reason_code: "INVALID_AUTH_STATE" };
  }

  // Internally call cancelHtlc (H release + bank-side segregated deposit release)
  // Pass env and run callBankReleaseReserve to release the approved segregated deposit
  await cancelHtlc(htlcId, authReq.txid!, req.reason ?? "VOID_REQUESTED", db, env);

  // Invalidate the preimage in the Vault
  if (authReq.vault_ref) {
    await db
      .prepare(`UPDATE Vault SET is_evicted=1 WHERE vault_ref=?`)
      .bind(authReq.vault_ref)
      .run();
  }

  // Update HtlcAuthRequests to VOIDED
  await db
    .prepare(
      `UPDATE HtlcAuthRequests
     SET status='VOIDED', voided_at=?, decline_reason=?, updated_at=?, version=version+1
     WHERE auth_id=?`
    )
    .bind(now, req.reason ?? "VOID_REQUESTED", now, authReq.auth_id)
    .run();

  await writeFinalityLog(db, {
    txid: authReq.txid,
    event_type: "HtlcVoided",
    state_from: "AUTH_APPROVED",
    state_to: "VOIDED",
    payload_json: JSON.stringify({ auth_id: authReq.auth_id, reason: req.reason }),
    txid_or_gtid: authReq.txid,
  });

  await logTxEvent(db, {
    txid: authReq.txid,
    actor: "ZC",
    action: "HTLC_VOID",
    status: "OK",
    amount: authReq.amount_value,
    details: { auth_id: authReq.auth_id, htlc_id: htlcId, reason: req.reason },
  });

  return { result: "VOIDED" };
}
