/**
 * @file HTLC Auth approval (payer-side accept). Reserves funds, mints preimage,
 *       and creates the HTLC contract + transaction in HTLC_LOCKED state.
 * @module zc/lanes/htlc_auth/approve
 */
import type {
  Env,
  HtlcAuthApproveInput,
  HtlcAuthRequestRow,
} from '../../../types'
import { nowISO } from '../../../types'
import { newUUID } from '../../../shared/idempotency'
import { sha256hex } from '../../../shared/hmac'
import { writeFinalityLog, callBankReserveFunds } from '../../orchestrator'
import { logTxEvent } from '../../trace'

/**
 * 送金側（顧客）がオーソリを承認する。
 * POST /api/htlc/auth/:auth_id/approve
 * - preimage + hashlock を生成して Vault に保管
 * - 送金側銀行に資金予約をかける
 * - HtlcContracts + Transactions を作成（AUTH_APPROVED → HTLC_LOCKED）
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
     VALUES (?, NULL, 'HTLC_PREIMAGE', ?, ?, 0, ?)`
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

  // Transactions レコード作成。
  // HtlcContracts と同じ HTLC_LOCKED 状態で挿入することが必須。
  // captureHtlcAuth → claimHtlc は `WHERE state='HTLC_LOCKED'` で CAS
  // するため、ここを H_RESERVED にすると Transactions が動かないまま
  // Bank 側だけ debit され、payee が永遠に着金しない（regression: 過去に
  // 発生したバグ — `test/integration/balance_invariants.test.ts` で固定）。
  // H 予約は ZC 側では行わない（別段預金で資金確保済みのため）。
  await db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, idempotency_key, schema_version,
      version, created_at, updated_at)
     VALUES (?, 'HTLC', 'HTLC_LOCKED', ?, 'JPY', ?, ?, ?, ?, ?, '1.0', 0, ?, ?)`
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
