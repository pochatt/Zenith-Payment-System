/**
 * @file Reversal — post-settlement compensation transactions.
 *
 * Implements the spec's Reversal requirement:
 *   "b（受取側完了）後の取消は禁止。救済はReversal（別取引）で行う。"
 *
 * A Reversal is a NEW transaction that compensates a previously settled
 * transaction. It does NOT modify the original transaction's state (which
 * is terminal at SETTLED). Instead, it creates a mirror-image payment
 * flowing in the opposite direction (payee → payer) and links back to the
 * original via `original_txid`.
 *
 * Reversal lifecycle:
 *   1. Caller requests reversal of a SETTLED transaction
 *   2. ZC validates: original must be SETTLED, reversal amount ≤ original
 *   3. A new TX is created with lane=STANDARD, purpose=REFUND
 *   4. The reversal TX follows the normal state machine (Decision→Execution)
 *   5. ReversalRecords table links original ↔ reversal for audit trail
 *
 * Terminology alignment with the spec:
 *   - 取消 (Cancel): Decision前のキャンセル → DECIDED_CANCEL → CANCELLED
 *   - 失敗 (Failure): Decision後だが未実行で終端 → FAILED_EXECUTION
 *   - 救済 (Reversal): b後の補償 → 別取引として新規作成
 *
 * @module zc/reversal
 */
import type { Env, TransactionRow } from '../types'
import { nowISO } from '../types'
import { newUUID } from '../shared/idempotency'
import { writeFinalityLog } from './orchestrator'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReversalReason =
  | 'CUSTOMER_DISPUTE'
  | 'DUPLICATE_PAYMENT'
  | 'INCORRECT_AMOUNT'
  | 'INCORRECT_PAYEE'
  | 'FRAUD'
  | 'OPERATIONAL_ERROR'

export type ReversalStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'TX_CREATED'
  | 'COMPLETED'
  | 'REJECTED'

export interface ReversalRequest {
  original_txid: string
  amount?: number          // partial reversal; omit for full reversal
  reason: ReversalReason
  requested_by: string     // bank_id or 'OPS'
  idempotency_key: string
  description?: string
}

export interface ReversalRecord {
  reversal_id: string
  original_txid: string
  reversal_txid: string | null
  amount: number
  reason: ReversalReason
  status: ReversalStatus
  requested_by: string
  description: string | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Request a reversal of a SETTLED transaction.
 *
 * Validates the original transaction, creates a ReversalRecords entry,
 * and (if auto-approved) creates the compensating transaction.
 *
 * @returns reversal_id and the created reversal TX (if approved)
 */
export async function requestReversal(
  req: ReversalRequest,
  env: Env,
): Promise<{
  result: 'REVERSAL_CREATED' | 'REJECTED'
  reversal_id: string
  reversal_txid?: string
  reason_code?: string
}> {
  const db = env.DB
  const now = nowISO()

  // 1. Validate original transaction
  const original = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(req.original_txid)
    .first<TransactionRow>()

  if (!original) {
    return { result: 'REJECTED', reversal_id: '', reason_code: 'ORIGINAL_NOT_FOUND' }
  }

  if (original.state !== 'SETTLED') {
    return { result: 'REJECTED', reversal_id: '', reason_code: 'ORIGINAL_NOT_SETTLED' }
  }

  // 2. Validate amount
  const reversalAmount = req.amount ?? original.amount_value
  if (reversalAmount <= 0 || reversalAmount > original.amount_value) {
    return { result: 'REJECTED', reversal_id: '', reason_code: 'INVALID_REVERSAL_AMOUNT' }
  }

  // 3. Check for existing reversals (prevent over-reversal)
  // D1 note: INSERT 前に SUM をチェックする SELECT と INSERT の間に
  // race condition が存在する可能性があるため、以下の対策を施す：
  //   1. ReversalRecords への INSERT を先行実施（REQUESTED 状態で予約）
  //   2. INSERT 失敗時（制約違反など）は over-reversal として reject
  //   3. INSERT 成功後に SUM 再確認して確実に超過チェックを行う
  //
  // 実装: 以下のステップで atomicity を高める
  //   - first INSERT: ReversalRecords 作成（status='REQUESTED'）
  //   - SUM with CAS: 全 active reversal の合計を再確認
  //   - 超過判定: 新規 INSERT 分を含めた合計がオリジナル超過なら rollback 代わりに DELETE

  const reversalId = `REV-${newUUID()}`

  // Step 1: ReversalRecords を先に INSERT（status='REQUESTED'で予約）
  const now = nowISO()
  await db.prepare(
    `INSERT INTO ReversalRecords
     (reversal_id, original_txid, reversal_txid, amount, reason, status,
      requested_by, description, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'REQUESTED', ?, ?, ?, ?)`,
  ).bind(
    reversalId, req.original_txid, reversalAmount, req.reason,
    req.requested_by, req.description ?? null, now, now,
  ).run()

  // Step 2: INSERT 後に全 active reversal（新規含む）の合計をチェック
  const allReversals = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total_reversed
       FROM ReversalRecords
       WHERE original_txid = ? AND status IN ('REQUESTED', 'APPROVED', 'TX_CREATED', 'COMPLETED')`,
    )
    .bind(req.original_txid)
    .first<{ total_reversed: number }>()

  const totalReversed = allReversals?.total_reversed ?? 0
  if (totalReversed > original.amount_value) {
    // Over-reversal detected: 今回の INSERT を削除してリジェクト
    await db.prepare(`DELETE FROM ReversalRecords WHERE reversal_id = ?`).bind(reversalId).run()
    return { result: 'REJECTED', reversal_id: '', reason_code: 'OVER_REVERSAL' }
  }

  // 4. Create ReversalRecords entry
  const reversalId = `REV-${newUUID()}`
  await db.prepare(
    `INSERT INTO ReversalRecords
     (reversal_id, original_txid, reversal_txid, amount, reason, status,
      requested_by, description, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'REQUESTED', ?, ?, ?, ?)`,
  ).bind(
    reversalId, req.original_txid, reversalAmount, req.reason,
    req.requested_by, req.description ?? null, now, now,
  ).run()

  await writeFinalityLog(db, {
    txid: req.original_txid,
    event_type: 'ReversalRequested',
    state_from: 'SETTLED',
    state_to: 'SETTLED',  // original stays SETTLED
    payload_json: JSON.stringify({
      reversal_id: reversalId,
      amount: reversalAmount,
      reason: req.reason,
    }),
    txid_or_gtid: req.original_txid,
  })

  // 5. Auto-approve and create compensating transaction
  //    (In production, some reasons would require manual approval)
  const reversalTxid = `TX-REV-${newUUID()}`

  // Create the reversal TX: payee→payer (reversed direction)
  await db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      purpose, idempotency_key, schema_version, version, created_at, updated_at)
     VALUES (?, 'STANDARD', 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, 'REFUND', ?, '1.0', 0, ?, ?)`,
  ).bind(
    reversalTxid,
    reversalAmount,
    original.payee_bank_id,                    // original payee becomes payer
    original.payee_account_hash ?? '',
    original.payer_bank_id,                    // original payer becomes payee
    original.payer_account_hash,
    req.idempotency_key,
    now, now,
  ).run()

  // Update ReversalRecords with the TX link
  await db.prepare(
    `UPDATE ReversalRecords
     SET status = 'TX_CREATED', reversal_txid = ?, updated_at = ?
     WHERE reversal_id = ?`,
  ).bind(reversalTxid, now, reversalId).run()

  await writeFinalityLog(db, {
    txid: reversalTxid,
    event_type: 'ReversalTxCreated',
    state_from: null,
    state_to: 'RECEIVED',
    payload_json: JSON.stringify({
      reversal_id: reversalId,
      original_txid: req.original_txid,
      amount: reversalAmount,
    }),
    txid_or_gtid: reversalTxid,
  })

  // Enqueue the reversal TX for standard processing
  await env.QUEUE.send({
    type: 'ZC_STATE_ADVANCE',
    payload: { txid: reversalTxid, action: 'ADVANCE_STANDARD' },
    txid: reversalTxid,
    attempt: 0,
    enqueued_at: now,
  })

  return {
    result: 'REVERSAL_CREATED',
    reversal_id: reversalId,
    reversal_txid: reversalTxid,
  }
}

/**
 * Mark a reversal as COMPLETED when the reversal TX reaches SETTLED.
 * Called from onPayeeExecConfirmed when txid starts with "TX-REV-".
 */
export async function completeReversal(reversalTxid: string, db: D1Database): Promise<void> {
  const now = nowISO()
  await db.prepare(
    `UPDATE ReversalRecords
     SET status = 'COMPLETED', updated_at = ?
     WHERE reversal_txid = ? AND status = 'TX_CREATED'`,
  ).bind(now, reversalTxid).run()
}

/**
 * Get reversal records for an original transaction.
 */
export async function getReversals(originalTxid: string, db: D1Database): Promise<ReversalRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM ReversalRecords WHERE original_txid = ? ORDER BY created_at DESC`)
    .bind(originalTxid)
    .all<ReversalRecord>()
  return results ?? []
}

/**
 * Get a single reversal record by ID.
 */
export async function getReversalById(reversalId: string, db: D1Database): Promise<ReversalRecord | null> {
  return db
    .prepare(`SELECT * FROM ReversalRecords WHERE reversal_id = ?`)
    .bind(reversalId)
    .first<ReversalRecord>()
}
