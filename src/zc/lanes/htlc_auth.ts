/**
 * @file HTLC Auth (payee-initiated authorization) flow. Whitelist-based
 *       auto-approval, manual approve/decline, capture, and void.
 * @module zc/lanes/htlc_auth
 */
//
// フロー:
//   1. 受取側（加盟店）が POST /api/htlc/auth-request を呼び出す
//      → ホワイトリスト確認 → HtlcAuthRequests 作成 (AUTH_REQUESTED)
//   2. 送金側（顧客）が自行の通知を確認し POST /api/htlc/auth/:auth_id/approve
//      → preimage/hashlock 生成 → 資金予約 → HtlcContracts + Transactions 作成
//      → HtlcAuthRequests を AUTH_APPROVED に更新
//   3. 受取側が POST /api/htlc/:htlc_id/capture
//      → Vault から preimage 取得 → claimHtlc を内部呼び出し → 決済確定
//   4. または受取側が POST /api/htlc/:htlc_id/void → HTLC キャンセル
//
// セキュリティ考慮:
//   - ホワイトリストは管理者（ZC運営）のみ登録・削除可能
//   - auth_expires_at: 顧客承認期限（超過でシステムが自動拒否）
//   - capture_expires_at: キャプチャ期限（超過で HTLC timelock が発動）
//   - preimage は Vault（短期秘匿ストア）に格納し、capture 時のみ参照
import type {
  Env,
  HtlcAuthRequestInput, HtlcAuthApproveInput, HtlcAuthDeclineInput,
  HtlcCaptureRequest, HtlcVoidRequest,
  HtlcAuthRequestRow, HtlcAuthWhitelistRow, HtlcAuthWhitelistRegisterRequest,
} from '../../types'
import { nowISO } from '../../types'
import { newUUID } from '../../shared/idempotency'
import { sha256hex } from '../../shared/hmac'
import { writeFinalityLog, callBankReserveFunds } from '../orchestrator'
import { logTxEvent } from '../trace'
import { claimHtlc, cancelHtlc } from './htlc'

// ---------------------------------------------------------------------------
// ホワイトリスト管理（管理者専用）
// ---------------------------------------------------------------------------

export async function registerAuthWhitelist(
  req: HtlcAuthWhitelistRegisterRequest,
  db: D1Database,
): Promise<{ whitelist_id: string }> {
  const whitelistId = `WL-${newUUID()}`
  const now = nowISO()
  await db.prepare(
    `INSERT INTO HtlcAuthWhitelist
     (whitelist_id, payee_bank_id, payee_account_hash, allowed_payer_bank_id,
      max_amount, allowed_purposes, description, is_active, registered_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(
    whitelistId, req.payee_bank_id, req.payee_account_hash,
    req.allowed_payer_bank_id ?? null,
    req.max_amount ?? null,
    req.allowed_purposes ? JSON.stringify(req.allowed_purposes) : null,
    req.description ?? null,
    now,
    req.expires_at ?? null,
  ).run()
  return { whitelist_id: whitelistId }
}

export async function revokeAuthWhitelist(
  whitelistId: string,
  db: D1Database,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE HtlcAuthWhitelist SET is_active=0 WHERE whitelist_id=?`
  ).bind(whitelistId).run()
  return (result.meta.changes ?? 0) > 0
}

export async function listAuthWhitelist(db: D1Database): Promise<HtlcAuthWhitelistRow[]> {
  const rows = await db.prepare(
    `SELECT * FROM HtlcAuthWhitelist ORDER BY registered_at DESC`
  ).all<HtlcAuthWhitelistRow>()
  return rows.results
}

// ---------------------------------------------------------------------------
// 1. オーソリリクエスト（受取側起点）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 2. 送金側の承認
// ---------------------------------------------------------------------------

/**
 * 送金側（顧客）がオーソリを承認する。
 * POST /api/htlc/auth/:auth_id/approve
 * - preimage + hashlock を生成して Vault に保管
 * - 送金側銀行に資金予約をかける
 * - HtlcContracts + Transactions を作成（AUTH_APPROVED → HTLC_RECEIVED → 非同期でHRESERVED）
 */
export async function approveAuthRequest(
  authId: string,
  req: HtlcAuthApproveInput,
  env: Env,
): Promise<{ result: 'APPROVED' | 'ERROR'; htlc_id?: string; hashlock?: string; reason_code?: string }> {
  const db = env.DB
  const now = nowISO()

  const authReq = await db.prepare(
    `SELECT * FROM HtlcAuthRequests WHERE auth_id=?`
  ).bind(authId).first<HtlcAuthRequestRow>()

  if (!authReq) return { result: 'ERROR', reason_code: 'AUTH_NOT_FOUND' }
  if (authReq.status !== 'AUTH_REQUESTED') {
    return { result: 'ERROR', reason_code: 'INVALID_AUTH_STATE' }
  }

  // 承認期限チェック
  if (new Date(authReq.auth_expires_at) <= new Date(now)) {
    await db.prepare(
      `UPDATE HtlcAuthRequests SET status='EXPIRED', updated_at=? WHERE auth_id=?`
    ).bind(now, authId).run()
    return { result: 'ERROR', reason_code: 'AUTH_EXPIRED' }
  }

  // preimage 生成 → Vault に保管
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  const preimage = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
  const hashlock = await sha256hex(preimage)

  const vaultRef = `VLT-AUTH-${newUUID()}`
  const vaultExpiresAt = new Date(Date.parse(authReq.capture_expires_at) + 60 * 60 * 1000).toISOString()
  await db.prepare(
    `INSERT INTO Vault (vault_ref, txid, data_type, payload_json, expires_at, is_evicted, created_at)
     VALUES (?, NULL, 'AML_EVAL', ?, ?, 0, ?)`
  ).bind(vaultRef, JSON.stringify({ preimage, auth_id: authId }), vaultExpiresAt, now).run()

  // 送金側銀行に資金予約
  const htlcId = `HAUTH-${authId}`
  const txid = `TX-HAUTH-${authId}`
  const requestId = `RESERVE-AUTH-${authId}`

  const reserveResp = await callBankReserveFunds(authReq.payer_bank_id, {
    request_id: requestId,
    txid,
    amount: { value: authReq.amount_value, currency: 'JPY' },
    account_hash: authReq.payer_account_hash,
  }, env)

  if (reserveResp.result !== 'RESERVED') {
    await logTxEvent(db, {
      txid, actor: `BANK_${authReq.payer_bank_id}`, action: 'RESERVE_FUNDS', status: 'NG',
      reason_code: (reserveResp as { reason_code?: string }).reason_code,
      amount: authReq.amount_value, bank_id: authReq.payer_bank_id,
    })
    return { result: 'ERROR', reason_code: (reserveResp as { reason_code?: string }).reason_code ?? 'RESERVE_FAILED' }
  }

  // Transactions レコード作成（DECIDED_TO_SETTLE 相当: 資金は既に確保済み）
  // H予約は不要（別段預金で資金確保済みのため）
  await db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, idempotency_key, schema_version,
      version, created_at, updated_at)
     VALUES (?, 'HTLC', 'H_RESERVED', ?, 'JPY', ?, ?, ?, ?, ?, '1.0', 0, ?, ?)`
  ).bind(
    txid, authReq.amount_value,
    authReq.payer_bank_id, authReq.payer_account_hash,
    authReq.payee_bank_id, authReq.payee_account_hash,
    req.idempotency_key, now, now,
  ).run()

  // HtlcContracts レコード作成（HTLC_LOCKED 状態: 資金確保済み）
  await db.prepare(
    `INSERT OR IGNORE INTO HtlcContracts
     (htlc_id, txid, state, hashlock, timelock, amount_value,
      payer_bank_id, payee_bank_id, secret_verified, authority_recheck_required,
      version, created_at, updated_at)
     VALUES (?, ?, 'HTLC_LOCKED', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`
  ).bind(
    htlcId, txid, hashlock, authReq.capture_expires_at,
    authReq.amount_value, authReq.payer_bank_id, authReq.payee_bank_id, now, now,
  ).run()

  // HtlcAuthRequests を AUTH_APPROVED に更新
  await db.prepare(
    `UPDATE HtlcAuthRequests
     SET status='AUTH_APPROVED', htlc_id=?, txid=?, vault_ref=?, hashlock=?,
         approved_at=?, updated_at=?, version=version+1
     WHERE auth_id=? AND status='AUTH_REQUESTED'`
  ).bind(htlcId, txid, vaultRef, hashlock, now, now, authId).run()

  await writeFinalityLog(db, {
    txid, event_type: 'HtlcAuthApproved',
    state_from: 'AUTH_REQUESTED', state_to: 'HTLC_LOCKED',
    payload_json: JSON.stringify({ auth_id: authId, htlc_id: htlcId, hashlock }),
    txid_or_gtid: txid,
  })

  await logTxEvent(db, {
    txid, actor: `BANK_${authReq.payer_bank_id}`, action: 'HTLC_AUTH_APPROVED', status: 'OK',
    amount: authReq.amount_value, bank_id: authReq.payer_bank_id,
    details: { auth_id: authId, htlc_id: htlcId, reservation_ref: reserveResp.reservation_ref },
  })

  return { result: 'APPROVED', htlc_id: htlcId, hashlock }
}

// ---------------------------------------------------------------------------
// 3. 送金側の拒否
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 4. キャプチャ（受取側起点の claimHtlc 相当）
// ---------------------------------------------------------------------------

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

  // HtlcAuthRequests からオーソリレコードを取得
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

// ---------------------------------------------------------------------------
// 5. ボイド（オーソリ取消）
// ---------------------------------------------------------------------------

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
  await cancelHtlc(htlcId, authReq.txid!, req.reason ?? 'VOID_REQUESTED', db)

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

// ---------------------------------------------------------------------------
// 照会
// ---------------------------------------------------------------------------

export async function getAuthRequest(
  authId: string,
  db: D1Database,
): Promise<HtlcAuthRequestRow | null> {
  return db.prepare(
    `SELECT auth_id, htlc_id, txid, status, payee_bank_id, payee_account_hash,
            payer_bank_id, payer_account_hash, amount_value, purpose, description,
            auth_expires_at, capture_expires_at, hashlock, whitelist_id,
            approved_at, captured_at, voided_at, decline_reason,
            version, created_at, updated_at
     FROM HtlcAuthRequests WHERE auth_id=?`
  ).bind(authId).first<HtlcAuthRequestRow>()
}

export async function listAuthRequests(
  db: D1Database,
  params: { payer_bank_id?: string; payee_bank_id?: string; status?: string; limit?: number },
): Promise<HtlcAuthRequestRow[]> {
  let sql = `SELECT auth_id, htlc_id, txid, status, payee_bank_id, payee_account_hash,
             payer_bank_id, payer_account_hash, amount_value, purpose, description,
             auth_expires_at, capture_expires_at, hashlock, whitelist_id,
             approved_at, captured_at, voided_at, decline_reason, created_at, updated_at
             FROM HtlcAuthRequests WHERE 1=1`
  const binds: unknown[] = []
  if (params.payer_bank_id) { sql += ` AND payer_bank_id=?`; binds.push(params.payer_bank_id) }
  if (params.payee_bank_id) { sql += ` AND payee_bank_id=?`; binds.push(params.payee_bank_id) }
  if (params.status) { sql += ` AND status=?`; binds.push(params.status) }
  sql += ` ORDER BY created_at DESC LIMIT ?`
  binds.push(params.limit ?? 50)
  const rows = await db.prepare(sql).bind(...binds).all<HtlcAuthRequestRow>()
  return rows.results
}
