/**
 * @file Pre-Shared Payment Reference (PSPR) registration and lookup. Allows
 *       payees to pre-register receiving references.
 * @module zc/pspr
 */
import type { PsprRegistryRow } from '../types'
import { nowISO } from '../types'
import { sha256hex } from '../shared/hmac'

/**
 * PSPR 登録（POST /api/pspr/register）
 */
export async function registerPspr(
  db: D1Database,
  psprRef: string,
  payeeBankId: string,
  accountHash: string,
  expiresAt: string,
): Promise<{ result: 'REGISTERED' | 'ALREADY_EXISTS'; pspr_ref: string }> {
  const now = nowISO()
  const digest = await sha256hex(`${psprRef}:${payeeBankId}:${accountHash}:${expiresAt}`)

  const result = await db.prepare(
    `INSERT OR IGNORE INTO PsprRegistry
     (pspr_ref, payee_bank_id, account_hash, capability_state, digest, expires_at, created_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`
  ).bind(psprRef, payeeBankId, accountHash, digest, expiresAt, now).run()

  return {
    result: (result.meta.changes ?? 0) > 0 ? 'REGISTERED' : 'ALREADY_EXISTS',
    pspr_ref: psprRef,
  }
}

/**
 * PSPR 照会
 */
export async function lookupPspr(
  db: D1Database, psprRef: string,
): Promise<PsprRegistryRow | null> {
  const row = await db
    .prepare(`SELECT * FROM PsprRegistry WHERE pspr_ref = ? AND capability_state = 'ACTIVE'`)
    .bind(psprRef)
    .first<PsprRegistryRow>()

  if (!row) return null
  if (new Date(row.expires_at) <= new Date()) {
    await db.prepare(`UPDATE PsprRegistry SET capability_state='REVOKED', revoked_at=? WHERE pspr_ref=?`).bind(nowISO(), psprRef).run()
    return null
  }
  return row
}

/**
 * PSPR 失効
 */
export async function revokePspr(db: D1Database, psprRef: string): Promise<void> {
  await db.prepare(
    `UPDATE PsprRegistry SET capability_state='REVOKED', revoked_at=? WHERE pspr_ref=?`
  ).bind(nowISO(), psprRef).run()
}
