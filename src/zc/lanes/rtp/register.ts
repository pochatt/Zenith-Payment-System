/**
 * @file RTP request creation, payer notification, and attempt linking.
 * @module zc/lanes/rtp/register
 */
import type { Env, RtpRequestInput, RtpRequestRow } from "../../../types";
import { nowISO } from "../../../types";
import { writeFinalityLog } from "../../orchestrator";

/**
 * RTP request registration (existing API)
 */
export async function registerRtp(
  req: RtpRequestInput,
  env: Env
): Promise<{
  result: "INGRESS_ACCEPTED";
  rtp_id: string;
  state: string;
}> {
  const db = env.DB;
  const now = nowISO();

  await db
    .prepare(
      `INSERT OR IGNORE INTO RtpRequests
     (rtp_id, payee_bank_id, payer_bank_id, amount_value, state, attempt_count, max_attempts,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'CREATED', 0, 3, ?, ?, ?)`
    )
    .bind(
      req.rtp_id,
      req.payee_bank_id,
      req.payer_bank_id,
      req.amount.value,
      req.expires_at,
      now,
      now
    )
    .run();

  await writeFinalityLog(db, {
    txid: null,
    event_type: "RtpRequested",
    state_from: null,
    state_to: "CREATED",
    payload_json: JSON.stringify({ rtp_id: req.rtp_id }),
    txid_or_gtid: req.rtp_id,
  });

  return { result: "INGRESS_ACCEPTED", rtp_id: req.rtp_id, state: "CREATED" };
}

/**
 * Execute RTP Attempt: CREATED/NOTIFIED → TX_CREATED
 * Called when the payer initiates a transfer (POST /api/transfers with lane=RTP)
 */
export async function attemptRtp(rtpId: string, linkedTxid: string, env: Env): Promise<boolean> {
  const db = env.DB;
  const now = nowISO();

  const rtp = await db
    .prepare(`SELECT * FROM RtpRequests WHERE rtp_id = ?`)
    .bind(rtpId)
    .first<RtpRequestRow>();

  if (!rtp) return false;
  if (rtp.state !== "CREATED" && rtp.state !== "NOTIFIED") return false;
  if (new Date(rtp.expires_at) <= new Date(now)) {
    await db
      .prepare(`UPDATE RtpRequests SET state='EXPIRED', updated_at=? WHERE rtp_id=?`)
      .bind(now, rtpId)
      .run();
    return false;
  }
  if (rtp.attempt_count >= rtp.max_attempts) {
    await db
      .prepare(`UPDATE RtpRequests SET state='FAILED', updated_at=? WHERE rtp_id=?`)
      .bind(now, rtpId)
      .run();
    return false;
  }

  await db
    .prepare(
      `UPDATE RtpRequests SET state='TX_CREATED', attempt_count=attempt_count+1, linked_txid=?, updated_at=? WHERE rtp_id=?`
    )
    .bind(linkedTxid, now, rtpId)
    .run();

  return true;
}

/**
 * Mark RTP as complete (when txid becomes SETTLED)
 */
export async function settleRtp(rtpId: string, db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE RtpRequests SET state='COMPLETED', updated_at=? WHERE rtp_id=?`)
    .bind(nowISO(), rtpId)
    .run();
}

/**
 * RTP request registration (extended version — with bank SSE notification)
 */
export async function registerRtpRequest(
  db: D1Database,
  rtpId: string,
  payeeBankId: string,
  payerBankId: string,
  amount: { value: number; currency: string },
  expiresAt: string,
  idempotencyKey: string,
  options: { payeeName?: string; description?: string; ediRef?: string; payeeAccountHash?: string },
  env: Env
): Promise<{ result: "REGISTERED" | "DUPLICATE"; rtpId: string }> {
  const now = nowISO();

  // Idempotency check: return DUPLICATE if an existing record is found
  const existing = await db
    .prepare(`SELECT rtp_id FROM RtpRequests WHERE rtp_id = ?`)
    .bind(rtpId)
    .first<{ rtp_id: string }>();

  if (existing) {
    return { result: "DUPLICATE", rtpId };
  }

  await db
    .prepare(`
    INSERT INTO RtpRequests
      (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
       attempt_count, max_attempts, expires_at,
       payee_name, description, edi_ref, payee_account_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'CREATED', 0, 3, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      rtpId,
      payeeBankId,
      payerBankId,
      amount.value,
      expiresAt,
      options.payeeName ?? null,
      options.description ?? null,
      options.ediRef ?? null,
      options.payeeAccountHash ?? null,
      now,
      now
    )
    .run();

  await writeFinalityLog(db, {
    txid: null,
    event_type: "RtpRequested",
    state_from: null,
    state_to: "CREATED",
    payload_json: JSON.stringify({
      rtp_id: rtpId,
      payee_bank_id: payeeBankId,
      payer_bank_id: payerBankId,
    }),
    txid_or_gtid: rtpId,
  });

  const notified = await notifyBankOfRtp(
    rtpId,
    payerBankId,
    payeeBankId,
    { value: amount.value, currency: amount.currency },
    expiresAt,
    { payeeName: options.payeeName, description: options.description },
    env
  );

  if (notified) {
    await db
      .prepare(`
      UPDATE RtpRequests SET state = 'NOTIFIED', notified_at = ?, updated_at = ?
      WHERE rtp_id = ? AND state = 'CREATED'
    `)
      .bind(now, now, rtpId)
      .run();
  }

  return { result: "REGISTERED", rtpId };
}

/**
 * Send an RTP notification to the bank.
 *
 * In production this is expected to call the paying bank's ZC Ingress
 * (`/bank/{bankId}/zc-ingress/rtp-notify`) via HTTP/SSE, but because dynamic
 * import is not possible under Workers bundle constraints, the mock returns
 * success as a no-op. Since the receiving side (`bankRtpNotify`) reads
 * RtpRequests directly after consolidation, replication to a separate table is unnecessary.
 */
async function notifyBankOfRtp(
  _rtpId: string,
  _payerBankId: string,
  _payeeBankId: string,
  _amount: { value: number; currency: string },
  _expiresAt: string,
  _options: { payeeName?: string; description?: string },
  _env: Env
): Promise<boolean> {
  return true;
}
