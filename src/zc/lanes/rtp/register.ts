/**
 * @file RTP request creation, payer notification, and attempt linking.
 * @module zc/lanes/rtp/register
 */
import type { Env, RtpRequestInput, RtpRequestRow } from "../../../types";
import { nowISO } from "../../../types";
import { writeFinalityLog } from "../../orchestrator";

/**
 * RTP請求登録（既存 API）
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
     VALUES (?, ?, ?, ?, 'REQUESTED', 0, 3, ?, ?, ?)`
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
    state_to: "REQUESTED",
    payload_json: JSON.stringify({ rtp_id: req.rtp_id }),
    txid_or_gtid: req.rtp_id,
  });

  return { result: "INGRESS_ACCEPTED", rtp_id: req.rtp_id, state: "REQUESTED" };
}

/**
 * RTP Attempt実行: REQUESTED → ATTEMPTED
 * payer が振込を起こしたとき（POST /api/transfers で lane=RTP）に呼ばれる
 */
export async function attemptRtp(rtpId: string, linkedTxid: string, env: Env): Promise<boolean> {
  const db = env.DB;
  const now = nowISO();

  const rtp = await db
    .prepare(`SELECT * FROM RtpRequests WHERE rtp_id = ?`)
    .bind(rtpId)
    .first<RtpRequestRow>();

  if (!rtp) return false;
  if (rtp.state !== "REQUESTED") return false;
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
      `UPDATE RtpRequests SET state='ATTEMPTED', attempt_count=attempt_count+1, linked_txid=?, updated_at=? WHERE rtp_id=?`
    )
    .bind(linkedTxid, now, rtpId)
    .run();

  return true;
}

/**
 * RTP完了マーク（txid が SETTLED になったとき）
 */
export async function settleRtp(rtpId: string, db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE RtpRequests SET state='SETTLED', updated_at=? WHERE rtp_id=?`)
    .bind(nowISO(), rtpId)
    .run();
}

/**
 * RTP請求登録（拡張版 — 銀行 SSE 通知付き）
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

  // 冪等チェック: 既存レコードがあれば DUPLICATE を返す
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
      (rtp_id, payee_bank_id, payer_bank_id, amount_value, state, rtp_status,
       attempt_count, max_attempts, expires_at,
       payee_name, description, edi_ref, payee_account_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'REQUESTED', 'CREATED', 0, 3, ?, ?, ?, ?, ?, ?, ?)
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
    state_to: "REQUESTED",
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
      UPDATE RtpRequests SET rtp_status = 'NOTIFIED', notified_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `)
      .bind(now, now, rtpId)
      .run();
  }

  return { result: "REGISTERED", rtpId };
}

/**
 * 銀行の ZC Ingress API へ RTP 通知を送信する（D1 経由のモック実装）。
 * 本番では銀行 SSE / HTTP を呼ぶが、Workers のバンドル制約で動的 import が
 * 使えないため、ここでは RtpRequestRows に直接 INSERT して通知を表現する。
 */
async function notifyBankOfRtp(
  rtpId: string,
  payerBankId: string,
  payeeBankId: string,
  amount: { value: number; currency: string },
  expiresAt: string,
  options: { payeeName?: string; description?: string },
  env: Env
): Promise<boolean> {
  try {
    const now = nowISO();
    await env.DB.prepare(`
      INSERT OR IGNORE INTO RtpRequestRows
        (rtp_id, payee_bank_id, payer_bank_id, amount_value, rtp_status,
         payee_name, description, expires_at, notified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'NOTIFIED', ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        rtpId,
        payeeBankId,
        payerBankId,
        amount.value,
        options.payeeName ?? null,
        options.description ?? null,
        expiresAt,
        now,
        now,
        now
      )
      .run();
    return true;
  } catch (err) {
    console.error(`[rtp] notifyBankOfRtp error: bank=${payerBankId}`, err);
    return false;
  }
}
