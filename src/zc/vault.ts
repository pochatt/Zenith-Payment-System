/**
 * @file Short-term confidential data store (Vault). Stores AML evaluations,
 *       PII, and risk hints with TTL-based eviction.
 * @module zc/vault
 */
import type { VaultRow } from '../types'
import { nowISO } from '../types'
import { newUUID } from '../shared/idempotency'

export type VaultDataType = 'AML_EVAL' | 'PII' | 'RISK_HINT'

/**
 * Vault に保存し vault_ref を返す
 */
export async function storeVault(
  db: D1Database,
  txid: string | null,
  dataType: VaultDataType,
  payload: unknown,
  ttlSeconds: number = 3600,
): Promise<string> {
  const vaultRef = `VLT-${newUUID()}`
  const now = nowISO()
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()

  await db.prepare(
    `INSERT INTO Vault (vault_ref, txid, data_type, payload_json, expires_at, is_evicted, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).bind(vaultRef, txid, dataType, JSON.stringify(payload), expiresAt, now).run()

  return vaultRef
}

/**
 * Vault から取得（TTL切れまたは evict済みは null）
 */
export async function fetchVault(
  db: D1Database, vaultRef: string,
): Promise<unknown | null> {
  const row = await db
    .prepare(`SELECT * FROM Vault WHERE vault_ref = ? AND is_evicted = 0`)
    .bind(vaultRef)
    .first<VaultRow>()

  if (!row) return null
  if (new Date(row.expires_at) <= new Date()) {
    await db.prepare(`UPDATE Vault SET is_evicted=1 WHERE vault_ref=?`).bind(vaultRef).run()
    return null
  }

  return JSON.parse(row.payload_json)
}

/**
 * 明示的 Evict
 */
export async function evictVault(db: D1Database, vaultRef: string): Promise<void> {
  await db.prepare(`UPDATE Vault SET is_evicted=1 WHERE vault_ref=?`).bind(vaultRef).run()
}
