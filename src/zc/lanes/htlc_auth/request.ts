/**
 * @file HTLC Auth request (payee-initiated) + decline.
 * @module zc/lanes/htlc_auth/request
 */
import type {
  Env,
  HtlcAuthRequestInput, HtlcAuthDeclineInput,
  HtlcAuthRequestRow, HtlcAuthWhitelistRow,
} from '../../../types'
import { nowISO } from '../../../types'
import { logTxEvent } from '../../trace'

/**
 * 受取側（加盟店）がオーソリリクエストを送信する。
 * POST /api/htlc/auth-request
 */
export async function createAuthRequest(
  req: HtlcAuthRequestInput,
  env: Env,
): Promise<{ result: 'AUTH_REQUESTED' | 'ERROR'; auth_id?: string; reason_code?: string }> {
  const db = env.DB
  const now = nowISO()

  // 冪等チェック
  const existing = await db.prepare(
    `SELECT auth_id, status FROM HtlcAuthRequests WHERE idempotency_key=?`
  ).bind(req.idempotency_key).first<{ auth_id: string; status: string }>()
  if (existing) {
    return { result: 'AUTH_REQUESTED', auth_id: existing.auth_id }
  }

  // ホワイトリスト確認
  const whitelist = await db.prepare(
    `SELECT * FROM HtlcAuthWhitelist
     WHERE payee_bank_id=? AND payee_account_hash=? AND is_active=1
       AND (expires_at IS NULL OR expires_at > ?)
       AND (allowed_payer_bank_id IS NULL OR allowed_payer_bank_id=?)`
  ).bind(req.payee_bank_id, req.payee_account_hash, now, req.payer_bank_id)
    .first<HtlcAuthWhitelistRow>()

  if (!whitelist) {
    await logTxEvent(db, {
      txid: null, actor: 'ZC', action: 'HTLC_AUTH_REQUESTED', status: 'NG',
      reason_code: 'PAYEE_NOT_WHITELISTED',
      bank_id: req.payee_bank_id,
      details: { payee_account_hash: req.payee_account_hash, payer_bank_id: req.payer_bank_id },
    })
    return { result: 'ERROR', reason_code: 'PAYEE_NOT_WHITELISTED' }
  }

  // 金額制限チェック
  if (whitelist.max_amount !== null && req.amount.value > whitelist.max_amount) {
    return { result: 'ERROR', reason_code: 'AMOUNT_EXCEEDS_AUTH_LIMIT' }
  }

  // 目的チェック
  if (whitelist.allowed_purposes && req.purpose) {
    const allowed = JSON.parse(whitelist.allowed_purposes) as string[]
    if (!allowed.includes(req.purpose)) {
      return { result: 'ERROR', reason_code: 'PURPOSE_NOT_ALLOWED' }
    }
  }

  // 期限チェック
  if (new Date(req.auth_expires_at) <= new Date(now)) {
    return { result: 'ERROR', reason_code: 'AUTH_EXPIRES_IN_PAST' }
  }
  if (new Date(req.capture_expires_at) <= new Date(req.auth_expires_at)) {
    return { result: 'ERROR', reason_code: 'CAPTURE_EXPIRES_BEFORE_AUTH' }
  }

  // HtlcAuthRequests 作成
  const authId = req.auth_id
  await db.prepare(
    `INSERT INTO HtlcAuthRequests
     (auth_id, htlc_id, txid, status, payee_bank_id, payee_account_hash,
      payer_bank_id, payer_account_hash, amount_value, purpose, description,
      auth_expires_at, capture_expires_at, vault_ref, hashlock, whitelist_id,
      idempotency_key, version, created_at, updated_at)
     VALUES (?, NULL, NULL, 'AUTH_REQUESTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?)`
  ).bind(
    authId, req.payee_bank_id, req.payee_account_hash,
    req.payer_bank_id, req.payer_account_hash,
    req.amount.value, req.purpose ?? null, req.description ?? null,
    req.auth_expires_at, req.capture_expires_at,
    whitelist.whitelist_id, req.idempotency_key, now, now,
  ).run()

  await logTxEvent(db, {
    txid: null, actor: `BANK_${req.payee_bank_id}`, action: 'HTLC_AUTH_REQUESTED', status: 'OK',
    amount: req.amount.value, bank_id: req.payee_bank_id,
    details: {
      auth_id: authId, payer_bank_id: req.payer_bank_id,
      auth_expires_at: req.auth_expires_at, whitelist_id: whitelist.whitelist_id,
    },
  })

  return { result: 'AUTH_REQUESTED', auth_id: authId }
}

/**
 * 送金側がオーソリリクエストを拒否する。
 * POST /api/htlc/auth/:auth_id/decline
 */
export async function declineAuthRequest(
  authId: string,
  req: HtlcAuthDeclineInput,
  env: Env,
): Promise<{ result: 'DECLINED' | 'ERROR'; reason_code?: string }> {
  const db = env.DB
  const now = nowISO()

  const authReq = await db.prepare(
    `SELECT * FROM HtlcAuthRequests WHERE auth_id=?`
  ).bind(authId).first<HtlcAuthRequestRow>()

  if (!authReq) return { result: 'ERROR', reason_code: 'AUTH_NOT_FOUND' }
  if (authReq.status !== 'AUTH_REQUESTED') {
    return { result: 'ERROR', reason_code: 'INVALID_AUTH_STATE' }
  }

  await db.prepare(
    `UPDATE HtlcAuthRequests
     SET status='AUTH_DECLINED', decline_reason=?, updated_at=?, version=version+1
     WHERE auth_id=?`
  ).bind(req.reason ?? 'PAYER_DECLINED', now, authId).run()

  await logTxEvent(db, {
    txid: null, actor: `BANK_${authReq.payer_bank_id}`, action: 'HTLC_AUTH_DECLINED', status: 'OK',
    amount: authReq.amount_value, bank_id: authReq.payer_bank_id,
    details: { auth_id: authId, reason: req.reason },
  })

  return { result: 'DECLINED' }
}
