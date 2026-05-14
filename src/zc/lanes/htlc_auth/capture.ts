/**
 * @file HTLC Auth capture (settle) and void (cancel).
 * @module zc/lanes/htlc_auth/capture
 */
import type {
  Env,
  HtlcCaptureRequest, HtlcVoidRequest,
  HtlcAuthRequestRow,
} from '../../../types'
import { nowISO } from '../../../types'
import { writeFinalityLog } from '../../orchestrator'
import { logTxEvent } from '../../trace'
import { claimHtlc, cancelHtlc } from '../htlc'

/**
 * 受取側（加盟店）がキャプチャを実行する。
 * Vault から preimage を取得して内部的に claimHtlc を呼び出す。
 * POST /api/htlc/:htlc_id/capture
 */
export async function captureHtlcAuth(
  htlcId: string,
  req: HtlcCaptureRequest,
  env: Env,
): Promise<{ result: 'CAPTURED' | 'ERROR'; txid?: string; reason_code?: string }> {
  const db = env.DB
  const now = nowISO()

  const authReq = await db.prepare(
    `SELECT * FROM HtlcAuthRequests WHERE htlc_id=?`
  ).bind(htlcId).first<HtlcAuthRequestRow>()

  if (!authReq) return { result: 'ERROR', reason_code: 'AUTH_NOT_FOUND' }
  if (authReq.status !== 'AUTH_APPROVED') {
    return { result: 'ERROR', reason_code: 'INVALID_AUTH_STATE' }
  }

  // キャプチャ期限チェック
  if (new Date(authReq.capture_expires_at) <= new Date(now)) {
    await db.prepare(
      `UPDATE HtlcAuthRequests SET status='EXPIRED', updated_at=? WHERE auth_id=?`
    ).bind(now, authReq.auth_id).run()
    return { result: 'ERROR', reason_code: 'CAPTURE_EXPIRED' }
  }

  // Vault から preimage を取得
  const vault = await db.prepare(
    `SELECT payload_json FROM Vault WHERE vault_ref=? AND is_evicted=0`
  ).bind(authReq.vault_ref).first<{ payload_json: string }>()

  if (!vault) return { result: 'ERROR', reason_code: 'PREIMAGE_NOT_AVAILABLE' }

  const { preimage } = JSON.parse(vault.payload_json) as { preimage: string }

  // claimHtlc を内部呼び出し（preimage を提示して DECIDED_TO_SETTLE へ）
  const claimResult = await claimHtlc({
    htlc_id: htlcId,
    preimage,
    idempotency_key: req.idempotency_key,
  }, env)

  if (claimResult.result !== 'ACCEPTED') {
    return { result: 'ERROR', reason_code: claimResult.reason_code ?? 'CLAIM_FAILED' }
  }

  // Vault の preimage を使用済みにする
  await db.prepare(
    `UPDATE Vault SET is_evicted=1 WHERE vault_ref=?`
  ).bind(authReq.vault_ref).run()

  // HtlcAuthRequests を CAPTURED に更新
  await db.prepare(
    `UPDATE HtlcAuthRequests
     SET status='CAPTURED', captured_at=?, updated_at=?, version=version+1
     WHERE auth_id=?`
  ).bind(now, now, authReq.auth_id).run()

  await logTxEvent(db, {
    txid: authReq.txid, actor: `BANK_${authReq.payee_bank_id}`, action: 'HTLC_CAPTURE', status: 'OK',
    amount: authReq.amount_value, bank_id: authReq.payee_bank_id,
    details: { auth_id: authReq.auth_id, htlc_id: htlcId },
  })

  return { result: 'CAPTURED', txid: authReq.txid ?? undefined }
}

/**
 * 受取側または送金側がオーソリを取り消す。
 * POST /api/htlc/:htlc_id/void
 */
export async function voidHtlcAuth(
  htlcId: string,
  req: HtlcVoidRequest,
  env: Env,
): Promise<{ result: 'VOIDED' | 'ERROR'; reason_code?: string }> {
  const db = env.DB
  const now = nowISO()

  const authReq = await db.prepare(
    `SELECT * FROM HtlcAuthRequests WHERE htlc_id=?`
  ).bind(htlcId).first<HtlcAuthRequestRow>()

  if (!authReq) return { result: 'ERROR', reason_code: 'AUTH_NOT_FOUND' }
  if (authReq.status !== 'AUTH_APPROVED') {
    return { result: 'ERROR', reason_code: 'INVALID_AUTH_STATE' }
  }

  // cancelHtlc を内部呼び出し（H 解放 + 銀行側別段解放）
  // env を渡して callBankReleaseReserve を実行し、承認済み別段預金を解放する
  await cancelHtlc(htlcId, authReq.txid!, req.reason ?? 'VOID_REQUESTED', db, env)

  // Vault の preimage を無効化
  if (authReq.vault_ref) {
    await db.prepare(
      `UPDATE Vault SET is_evicted=1 WHERE vault_ref=?`
    ).bind(authReq.vault_ref).run()
  }

  // HtlcAuthRequests を VOIDED に更新
  await db.prepare(
    `UPDATE HtlcAuthRequests
     SET status='VOIDED', voided_at=?, decline_reason=?, updated_at=?, version=version+1
     WHERE auth_id=?`
  ).bind(now, req.reason ?? 'VOID_REQUESTED', now, authReq.auth_id).run()

  await writeFinalityLog(db, {
    txid: authReq.txid, event_type: 'HtlcVoided',
    state_from: 'AUTH_APPROVED', state_to: 'VOIDED',
    payload_json: JSON.stringify({ auth_id: authReq.auth_id, reason: req.reason }),
    txid_or_gtid: authReq.txid,
  })

  await logTxEvent(db, {
    txid: authReq.txid, actor: 'ZC', action: 'HTLC_VOID', status: 'OK',
    amount: authReq.amount_value,
    details: { auth_id: authReq.auth_id, htlc_id: htlcId, reason: req.reason },
  })

  return { result: 'VOIDED' }
}
