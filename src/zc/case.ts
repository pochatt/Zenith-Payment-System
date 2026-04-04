/**
 * @file CASE management — dispute/exception case creation and state updates.
 *       Tracks OPEN -> IN_PROGRESS -> RESOLVED/ESCALATED lifecycle.
 * @module zc/case
 */
import type { CaseState } from '../types'
import { nowISO } from '../types'
import { newUUID } from '../shared/idempotency'

export interface OpenCaseInput {
  related_txid?: string
  related_gtid?: string
  reason_code: string
  description?: string
  opened_by: 'ZC' | 'BANK' | 'OPS'
}

/**
 * CASE起票
 */
export async function openCase(db: D1Database, input: OpenCaseInput): Promise<string> {
  const caseId = `CASE-${newUUID()}`
  const now = nowISO()

  await db.prepare(
    `INSERT INTO Cases
     (case_id, related_txid, related_gtid, state, reason_code, description, opened_by, created_at, updated_at)
     VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`
  ).bind(
    caseId,
    input.related_txid ?? null,
    input.related_gtid ?? null,
    input.reason_code,
    input.description ?? null,
    input.opened_by,
    now, now,
  ).run()

  // Transactions に case_id を紐付け
  if (input.related_txid) {
    await db.prepare(
      `UPDATE Transactions SET case_id=?, updated_at=? WHERE txid=?`
    ).bind(caseId, now, input.related_txid).run()
  }

  return caseId
}

/**
 * CASE状態更新
 */
export async function updateCase(
  db: D1Database,
  caseId: string,
  newState: CaseState,
  resolvedAt?: string,
): Promise<void> {
  const now = nowISO()
  await db.prepare(
    `UPDATE Cases SET state=?, resolved_at=COALESCE(?, resolved_at), updated_at=? WHERE case_id=?`
  ).bind(newState, resolvedAt ?? null, now, caseId).run()
}

/**
 * CASE を解決状態へ自動遷移させる（状態進展による自動収束）
 */
export async function autoResolveCaseForTx(db: D1Database, txid: string): Promise<void> {
  const row = await db.prepare(
    `SELECT case_id FROM Transactions WHERE txid=? AND case_id IS NOT NULL`
  ).bind(txid).first<{ case_id: string }>()
  if (row?.case_id) {
    const c = await db.prepare(`SELECT state FROM Cases WHERE case_id=?`).bind(row.case_id).first<{state: string}>()
    if (c && (c.state === 'OPEN' || c.state === 'IN_PROGRESS')) {
       await updateCase(db, row.case_id, 'RESOLVED', nowISO())
    }
  }
}

export async function autoResolveCaseForGtid(db: D1Database, gtid: string): Promise<void> {
  const cases = await db.prepare(
    `SELECT case_id FROM Cases WHERE related_gtid=? AND state IN ('OPEN', 'IN_PROGRESS')`
  ).bind(gtid).all<{ case_id: string }>()
  for (const c of cases?.results ?? []) {
    await updateCase(db, c.case_id, 'RESOLVED', nowISO())
  }
}
