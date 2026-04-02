/**
 * @file CASE management — dispute/exception case creation, auto-classification,
 *       and state updates.
 *       Tracks OPEN -> IN_PROGRESS -> RESOLVED/ESCALATED lifecycle.
 *       Cases are classified as AUTO_RESOLVABLE, AUTO_PROGRESS, or MANUAL_ONLY.
 * @module zc/case
 */
import type { CaseState } from '../types'
import { nowISO } from '../types'
import { newUUID } from '../shared/idempotency'

/** CASE処理分類: 設計書 §12 CASE自動分類 */
export type CaseClassification = 'AUTO_RESOLVABLE' | 'AUTO_PROGRESS' | 'MANUAL_ONLY'

export interface OpenCaseInput {
  related_txid?: string
  related_gtid?: string
  reason_code: string
  description?: string
  opened_by: 'ZC' | 'BANK' | 'OPS'
}

/**
 * reason_code に基づいてCASEの処理分類を自動決定する。
 *
 * AUTO_RESOLVABLE: システムが自動解決可能（タイムアウト再送、期限切れ処理など）
 * AUTO_PROGRESS:   システムが自動で途中まで進め、最終確認のみ人手（部分的自動化）
 * MANUAL_ONLY:     完全に人手での対応が必要（不正疑い、制度上の問題など）
 */
export function classifyCase(reasonCode: string): CaseClassification {
  // AUTO_RESOLVABLE: タイムアウト・期限切れ系（再送やリトライで自動解決）
  const autoResolvable = [
    'SUSPEND_EXEC_TIMEOUT',
    'SUSPEND_PAYEE_PROOF_TIMEOUT',
    'TIMELOCK_EXPIRED',
    'FAILED_EXEC_TIMEOUT',
    'RESERVE_FAILED',
    'H_LIMIT_EXCEEDED',
    'CREDIT_DELIVERY_FAILED',
  ]
  if (autoResolvable.includes(reasonCode)) return 'AUTO_RESOLVABLE'

  // AUTO_PROGRESS: 部分的に自動処理可能だが最終判断は人手
  const autoProgress = [
    'GTID_PARTIAL_FAILURE',
    'EXEC_DEBIT_FAILED',
    'EXEC_CREDIT_FAILED',
    'SUSPEND_NAMECHECK_PENDING',
    'BOJ_INSUFFICIENT_FUNDS',
    'DNS_HOLD_ACTIVE',
    'RECHECK_AUTHORITY_NG',
  ]
  if (autoProgress.includes(reasonCode)) return 'AUTO_PROGRESS'

  // MANUAL_ONLY: 不正疑い、制度上の問題、手動エスカレーション
  return 'MANUAL_ONLY'
}

/**
 * CASE起票（自動分類付き）
 */
export async function openCase(db: D1Database, input: OpenCaseInput): Promise<string> {
  const caseId = `CASE-${newUUID()}`
  const now = nowISO()
  const classification = classifyCase(input.reason_code)

  await db.prepare(
    `INSERT INTO Cases
     (case_id, related_txid, related_gtid, state, reason_code, description, opened_by, classification, created_at, updated_at)
     VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)`
  ).bind(
    caseId,
    input.related_txid ?? null,
    input.related_gtid ?? null,
    input.reason_code,
    input.description ?? null,
    input.opened_by,
    classification,
    now, now,
  ).run()

  // Transactions に case_id を紐付け
  if (input.related_txid) {
    await db.prepare(
      `UPDATE Transactions SET case_id=?, updated_at=? WHERE txid=?`
    ).bind(caseId, now, input.related_txid).run()
  }

  // AUTO_RESOLVABLE の場合は即座に IN_PROGRESS へ遷移（自動処理開始を示す）
  if (classification === 'AUTO_RESOLVABLE') {
    await db.prepare(
      `UPDATE Cases SET state='IN_PROGRESS', updated_at=? WHERE case_id=?`
    ).bind(now, caseId).run()
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
