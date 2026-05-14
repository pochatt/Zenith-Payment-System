/**
 * @file RTP response handling — payer accepts (creates tx) or rejects.
 * @module zc/lanes/rtp/respond
 */
import type { Env, RtpRequestRow, RtpRespondRequest } from '../../../types'
import { nowISO } from '../../../types'
import { writeFinalityLog } from '../../orchestrator'

/**
 * RTP応答処理（ACCEPTED / REJECTED）
 *
 * 支払人が承認した場合、RTP 紐づき送金取引を自動生成して ZC に投入する。
 */
export async function respondToRtp(
  db: D1Database,
  rtpId: string,
  response: RtpRespondRequest,
  env: Env,
): Promise<{ result: string; txid?: string }> {
  const now = nowISO()

  const rtp = await db.prepare(`
    SELECT * FROM RtpRequests WHERE rtp_id = ?
  `).bind(rtpId).first<RtpRequestRow & {
    rtp_status?: string
    payee_name?: string
    description?: string
    edi_ref?: string
    payee_account_hash?: string
  }>()

  if (!rtp) {
    return { result: 'NOT_FOUND' }
  }

  // 既に応答済みの場合
  const alreadyDone = ['ACCEPTED', 'DECLINED', 'EXPIRED', 'TX_CREATED', 'COMPLETED', 'REJECTED']
  if (rtp.rtp_status && alreadyDone.includes(rtp.rtp_status)) {
    return { result: 'ALREADY_RESPONDED', txid: rtp.linked_txid ?? undefined }
  }

  // 期限チェック
  if (new Date(rtp.expires_at) <= new Date(now)) {
    await db.prepare(`
      UPDATE RtpRequests SET rtp_status = 'EXPIRED', state = 'EXPIRED', updated_at = ? WHERE rtp_id = ?
    `).bind(now, rtpId).run()
    return { result: 'EXPIRED' }
  }

  if (response.response === 'REJECTED') {
    // RtpRequests は ZC 側で必ず存在するため UPDATE は成功する。
    // RtpRequestRows は支払銀行側の通知テーブルのため、rtp-notify 未到達時には
    // レコードが存在しない場合がある。INSERT OR IGNORE で補完してから UPDATE する。
    await db.prepare(`
      UPDATE RtpRequests
      SET rtp_status = 'DECLINED', state = 'FAILED', response_type = 'REJECTED',
          payer_account_id = ?, responded_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `).bind(response.payer_account_id, now, now, rtpId).run()
    await db.prepare(`
      INSERT OR IGNORE INTO RtpRequestRows
        (rtp_id, payee_bank_id, payer_bank_id, amount_value, rtp_status,
         expires_at, responded_at, response_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'DECLINED', ?, ?, 'REJECTED', ?, ?)
    `).bind(
      rtpId, rtp.payee_bank_id, rtp.payer_bank_id, rtp.amount_value,
      rtp.expires_at, now, now, now,
    ).run()
    await db.prepare(`
      UPDATE RtpRequestRows SET rtp_status = 'DECLINED', responded_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `).bind(now, now, rtpId).run()

    return { result: 'DECLINED' }
  }

  // ACCEPTED: 送金取引を自動生成
  const linkedTxid = `TX-${crypto.randomUUID()}`

  // RtpRequestRows が未作成の場合に備え、INSERT OR IGNORE で補完してから UPDATE する
  await db.prepare(`
    INSERT OR IGNORE INTO RtpRequestRows
      (rtp_id, payee_bank_id, payer_bank_id, amount_value, rtp_status,
       expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?)
  `).bind(
    rtpId, rtp.payee_bank_id, rtp.payer_bank_id, rtp.amount_value,
    rtp.expires_at, now, now,
  ).run()

  await db.batch([
    db.prepare(`
      UPDATE RtpRequests
      SET rtp_status = 'TX_CREATED', state = 'ATTEMPTED', attempt_count = attempt_count + 1,
          linked_txid = ?, linked_txid_new = ?, payer_account_id = ?, response_type = 'ACCEPTED',
          responded_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `).bind(linkedTxid, linkedTxid, response.payer_account_id, now, now, rtpId),
    db.prepare(`
      UPDATE RtpRequestRows SET rtp_status = 'TX_CREATED', responded_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `).bind(now, now, rtpId),

    db.prepare(`
      INSERT INTO Transactions
        (txid, state, lane, amount_value, amount_currency,
         payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
         purpose, idempotency_key, schema_version, version, created_at, updated_at)
      VALUES (?, 'RECEIVED', 'RTP', ?, 'JPY', ?, ?, ?, ?, 'P2P', ?, '1.0', 0, ?, ?)
    `).bind(
      linkedTxid,
      rtp.amount_value,
      rtp.payer_bank_id,
      response.payer_account_id,
      rtp.payee_bank_id,
      rtp.payee_account_hash ?? null,
      response.idempotency_key,
      now,
      now,
    ),
  ])

  // オーケストレーターへ送信（STANDARD フローで精算処理を進める）
  await env.QUEUE.send({
    type: 'ZC_STATE_ADVANCE',
    payload: { txid: linkedTxid, action: 'ADVANCE_STANDARD' },
    txid: linkedTxid,
    attempt: 0,
    enqueued_at: now,
  })

  await writeFinalityLog(db, {
    txid: linkedTxid,
    event_type: 'RtpAccepted',
    state_from: 'REQUESTED',
    state_to: 'TX_CREATED',
    payload_json: JSON.stringify({ rtp_id: rtpId, linked_txid: linkedTxid }),
    txid_or_gtid: rtpId,
  })

  return { result: 'ACCEPTED', txid: linkedTxid }
}
