/**
 * @file Request-to-Pay (RTP) lane processing. Payment request creation, bank
 *       notification, and payer response handling.
 * @module zc/lanes/rtp
 */
import type {
  Env,
  RtpRequestInput,
  RtpRequestRow,
  RtpFullStatus,
  RtpRespondRequest,
} from '../../types'
import { nowISO } from '../../types'
import { writeFinalityLog } from '../orchestrator'
import { newUUID } from '../../shared/idempotency'

// =============================================================================
// 既存関数（変更なし）
// =============================================================================

/**
 * RTP請求登録
 */
export async function registerRtp(req: RtpRequestInput, env: Env): Promise<{
  result: 'INGRESS_ACCEPTED'; rtp_id: string; state: string
}> {
  const db = env.DB
  const now = nowISO()

  await db.prepare(
    `INSERT OR IGNORE INTO RtpRequests
     (rtp_id, payee_bank_id, payer_bank_id, amount_value, state, attempt_count, max_attempts,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'REQUESTED', 0, 3, ?, ?, ?)`
  ).bind(req.rtp_id, req.payee_bank_id, req.payer_bank_id, req.amount.value, req.expires_at, now, now).run()

  await writeFinalityLog(db, {
    txid: null, event_type: 'RtpRequested', state_from: null, state_to: 'REQUESTED',
    payload_json: JSON.stringify({ rtp_id: req.rtp_id }),
    txid_or_gtid: req.rtp_id,
  })

  return { result: 'INGRESS_ACCEPTED', rtp_id: req.rtp_id, state: 'REQUESTED' }
}

/**
 * RTP Attempt実行: REQUESTED → ATTEMPTED
 * payer が振込を起こしたとき（POST /api/transfers で lane=RTP）に呼ばれる
 */
export async function attemptRtp(rtpId: string, linkedTxid: string, env: Env): Promise<boolean> {
  const db = env.DB
  const now = nowISO()

  const rtp = await db
    .prepare(`SELECT * FROM RtpRequests WHERE rtp_id = ?`)
    .bind(rtpId)
    .first<RtpRequestRow>()

  if (!rtp) return false
  if (rtp.state !== 'REQUESTED') return false
  if (new Date(rtp.expires_at) <= new Date(now)) {
    await db.prepare(`UPDATE RtpRequests SET state='EXPIRED', updated_at=? WHERE rtp_id=?`).bind(now, rtpId).run()
    return false
  }
  if (rtp.attempt_count >= rtp.max_attempts) {
    await db.prepare(`UPDATE RtpRequests SET state='FAILED', updated_at=? WHERE rtp_id=?`).bind(now, rtpId).run()
    return false
  }

  await db.prepare(
    `UPDATE RtpRequests SET state='ATTEMPTED', attempt_count=attempt_count+1, linked_txid=?, updated_at=? WHERE rtp_id=?`
  ).bind(linkedTxid, now, rtpId).run()

  return true
}

/**
 * RTP完了マーク（txid が SETTLED になったとき）
 */
export async function settleRtp(rtpId: string, db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE RtpRequests SET state='SETTLED', updated_at=? WHERE rtp_id=?`
  ).bind(nowISO(), rtpId).run()
}

// =============================================================================
// 拡張関数（新規追加）
// =============================================================================

/**
 * RTP請求登録（拡張版）
 *
 * 処理:
 * 1. 冪等キー確認
 * 2. RtpRequests INSERT (rtp_status='CREATED')
 * 3. payerBankへ SSE/HTTP 通知
 * 4. rtp_status='NOTIFIED' に更新
 *
 * @param db             - D1 データベース
 * @param rtpId          - RTP ID
 * @param payeeBankId    - 受取銀行ID
 * @param payerBankId    - 支払銀行ID
 * @param amount         - 金額オブジェクト { value, currency }
 * @param expiresAt      - 有効期限 (ISO 8601)
 * @param idempotencyKey - 冪等キー
 * @param options        - 追加オプション
 * @param env            - 環境変数
 * @returns { result, rtpId }
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
  env: Env,
): Promise<{ result: 'REGISTERED' | 'DUPLICATE'; rtpId: string }> {
  const now = nowISO()

  // 冪等チェック: 既存レコードがあれば DUPLICATE を返す
  const existing = await db.prepare(
    `SELECT rtp_id FROM RtpRequests WHERE rtp_id = ?`,
  ).bind(rtpId).first<{ rtp_id: string }>()

  if (existing) {
    return { result: 'DUPLICATE', rtpId }
  }

  // RtpRequests INSERT
  await db.prepare(`
    INSERT INTO RtpRequests
      (rtp_id, payee_bank_id, payer_bank_id, amount_value, state, rtp_status,
       attempt_count, max_attempts, expires_at,
       payee_name, description, edi_ref, payee_account_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'REQUESTED', 'CREATED', 0, 3, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    rtpId, payeeBankId, payerBankId, amount.value, expiresAt,
    options.payeeName ?? null,
    options.description ?? null,
    options.ediRef ?? null,
    options.payeeAccountHash ?? null,
    now, now,
  ).run()

  await writeFinalityLog(db, {
    txid: null,
    event_type: 'RtpRequested',
    state_from: null,
    state_to: 'REQUESTED',
    payload_json: JSON.stringify({ rtp_id: rtpId, payee_bank_id: payeeBankId, payer_bank_id: payerBankId }),
    txid_or_gtid: rtpId,
  })

  // payerBank へ通知
  const notified = await notifyBankOfRtp(
    rtpId, payerBankId, payeeBankId,
    { value: amount.value, currency: amount.currency },
    expiresAt,
    { payeeName: options.payeeName, description: options.description },
    env,
  )

  if (notified) {
    await db.prepare(`
      UPDATE RtpRequests SET rtp_status = 'NOTIFIED', notified_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `).bind(now, now, rtpId).run()
  }

  return { result: 'REGISTERED', rtpId }
}

/**
 * RTP応答処理（ACCEPTED / REJECTED）
 *
 * 支払人が承認した場合、RTP 紐づき送金取引を自動生成して ZC に投入する。
 *
 * @param db       - D1 データベース
 * @param rtpId    - RTP ID
 * @param response - 応答リクエスト
 * @param env      - 環境変数
 * @returns { result, txid? }
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
    // レコードが存在しない場合がある。batch 内の UPDATE 空振りは D1 ではエラーに
    // ならないが、状態不整合を防ぐためレコードが無くても安全に動作するようにする。
    await db.prepare(`
      UPDATE RtpRequests
      SET rtp_status = 'DECLINED', state = 'FAILED', response_type = 'REJECTED',
          payer_account_id = ?, responded_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `).bind(response.payer_account_id, now, now, rtpId).run()
    // RtpRequestRows は存在する場合のみ更新（INSERT OR IGNORE で通知テーブルを補完）
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

/**
 * RTP照会
 *
 * @param db    - D1 データベース
 * @param rtpId - RTP ID
 * @returns RTP状態 + 生行データ、または null
 */
export async function getRtpStatus(
  db: D1Database,
  rtpId: string,
): Promise<{ rtpId: string; status: RtpFullStatus; rows: unknown[] } | null> {
  const row = await db.prepare(`
    SELECT * FROM RtpRequests WHERE rtp_id = ?
  `).bind(rtpId).first<RtpRequestRow & { rtp_status?: string }>()

  if (!row) return null

  // rtp_status が存在しない場合は state から推定
  let status: RtpFullStatus
  const rawStatus = row.rtp_status

  if (rawStatus === 'CREATED' || rawStatus === 'NOTIFIED' || rawStatus === 'ACCEPTED'
      || rawStatus === 'TX_CREATED' || rawStatus === 'COMPLETED'
      || rawStatus === 'REJECTED' || rawStatus === 'DECLINED' || rawStatus === 'EXPIRED') {
    status = rawStatus as RtpFullStatus
  } else {
    switch (row.state) {
      case 'REQUESTED': status = 'CREATED'; break
      case 'ATTEMPTED': status = 'TX_CREATED'; break
      case 'SETTLED':   status = 'COMPLETED'; break
      case 'EXPIRED':   status = 'EXPIRED'; break
      case 'FAILED':    status = 'REJECTED'; break
      default:          status = 'CREATED'
    }
  }

  return { rtpId, status, rows: [row] }
}

/**
 * RTPタイムアウト処理（cron用）
 *
 * expires_at < now かつ CREATED / NOTIFIED 状態の RTP を EXPIRED にする。
 *
 * @param db - D1 データベース
 * @returns 更新件数
 */
export async function expireRtpRequests(db: D1Database): Promise<number> {
  const now = nowISO()

  const result = await db.prepare(`
    UPDATE RtpRequests
    SET rtp_status = 'EXPIRED', state = 'EXPIRED', updated_at = ?
    WHERE expires_at < ? AND (rtp_status IN ('CREATED', 'NOTIFIED') OR state = 'REQUESTED')
  `).bind(now, now).run()

  return result.meta.changes ?? 0
}

// ---------------------------------------------------------------------------
// 銀行へRTP通知送信（内部）
// ---------------------------------------------------------------------------

/**
 * 銀行の ZC Ingress API へ RTP 通知を送信する。
 *
 * エンドポイント: POST /bank/:bankId/zc-ingress/rtp-notify
 *
 * @param rtpId      - RTP ID（冪等キーに使用）
 * @param payerBankId - 支払銀行ID
 * @param rtpData    - 通知ペイロード
 * @param env        - 環境変数
 * @returns 成功フラグ
 */
// dynamic import は Workers でバンドル解決不可のため、直接 RtpRequestRows に INSERT する
async function notifyBankOfRtp(
  rtpId: string,
  payerBankId: string,
  payeeBankId: string,
  amount: { value: number; currency: string },
  expiresAt: string,
  options: { payeeName?: string; description?: string },
  env: Env,
): Promise<boolean> {
  try {
    const now = nowISO()
    await env.DB.prepare(`
      INSERT OR IGNORE INTO RtpRequestRows
        (rtp_id, payee_bank_id, payer_bank_id, amount_value, rtp_status,
         payee_name, description, expires_at, notified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'NOTIFIED', ?, ?, ?, ?, ?, ?)
    `).bind(
      rtpId, payeeBankId, payerBankId, amount.value,
      options.payeeName ?? null,
      options.description ?? null,
      expiresAt, now, now, now,
    ).run()
    return true
  } catch (err) {
    console.error(`[rtp] notifyBankOfRtp error: bank=${payerBankId}`, err)
    return false
  }
}
