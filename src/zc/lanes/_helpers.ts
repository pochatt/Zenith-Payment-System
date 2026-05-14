/**
 * @file _helpers.ts — Shared building blocks for lane state machines.
 *
 * Every lane (express, standard, htlc, gtid, rtp, highvalue, bulk, htlc_auth)
 * implements the same three patterns:
 *
 *   1. Transition a Transactions row with optimistic-lock CAS, then write a
 *      FinalityLog entry. The two MUST be atomic from the caller's POV.
 *   2. Cancel an in-flight transaction: state guard → release H reservation
 *      (in the right order so a parallel `decision` cannot leak H) → log →
 *      finalize as CANCELLED.
 *   3. Sticky idempotency on `request_id` so retried bank callbacks no-op.
 *
 * This file centralizes (1) and (2). New lanes should consume these helpers
 * instead of copy-pasting the patterns out of express.ts / standard.ts. The
 * existing lanes will be migrated incrementally — see
 * `specs/architecture.md` § Lane Refactor Roadmap for the plan.
 */
import { nowISO } from '../../types'
import type { FinalityEventType } from '../../types'
import { writeFinalityLog, finalizeCancelledTx } from '../orchestrator'
import { releaseH } from '../h_model'
import { DomainError } from '../../shared/errors'

// ---------------------------------------------------------------------------
// transitionWithLog
// ---------------------------------------------------------------------------

export interface TransitionRequest {
  txid: string
  /** Allowed source state(s). The CAS UPDATE only fires if the current row matches. */
  fromState: string | string[]
  toState: string
  eventType: FinalityEventType | string
  /** Arbitrary fields to record in the FinalityLog payload. */
  payload?: Record<string, unknown>
  /** Optional column updates applied alongside `state` (state, updated_at, version are managed). */
  setColumns?: Record<string, string | number | null>
  /** When true, raises DomainError('CONCURRENCY_CONFLICT') instead of returning {applied:false}. */
  strict?: boolean
}

export interface TransitionResult {
  applied: boolean
  /** Snapshot of the row's state before the UPDATE; null if the row did not exist. */
  previousState: string | null
}

/**
 * CAS-update a Transactions row and write a paired FinalityLog entry.
 *
 * Idempotency: if no row matches `txid AND state IN (fromState)` the call is
 * a no-op (returns `{applied:false}`). When `strict: true` the same condition
 * raises `CONCURRENCY_CONFLICT` so callers can surface a 409 to the client.
 *
 * The UPDATE bumps `version` and `updated_at` automatically; callers only
 * supply business columns via `setColumns`.
 */
export async function transitionWithLog(
  db: D1Database,
  req: TransitionRequest,
): Promise<TransitionResult> {
  const fromStates = Array.isArray(req.fromState) ? req.fromState : [req.fromState]
  const placeholders = fromStates.map(() => '?').join(',')

  const cur = await db
    .prepare(`SELECT state, version FROM Transactions WHERE txid = ?`)
    .bind(req.txid)
    .first<{ state: string; version: number }>()
  if (!cur) {
    if (req.strict) {
      throw new DomainError('TX_NOT_FOUND', `transaction ${req.txid} not found`, { txid: req.txid })
    }
    return { applied: false, previousState: null }
  }
  if (!fromStates.includes(cur.state)) {
    if (req.strict) {
      throw new DomainError(
        'CONCURRENCY_CONFLICT',
        `transaction ${req.txid} state=${cur.state}, expected one of [${fromStates.join(',')}]`,
        { txid: req.txid, current_state: cur.state, expected: fromStates },
      )
    }
    return { applied: false, previousState: cur.state }
  }

  // V8 perf: single-pass build of the SET clause + bind values. The previous
  // form enumerated `sets` three times (Object.keys + 2× .map) which both
  // allocates intermediate arrays and forces V8 to walk the property table
  // repeatedly. One `for...in` builds both arrays inline.
  const sets = req.setColumns ?? {}
  let setSql = ''
  const setValues: Array<string | number | null> = []
  for (const k in sets) {
    setSql += setSql ? `, ${k} = ?` : `${k} = ?`
    setValues.push(sets[k]!)
  }
  const now = nowISO()

  const sql = `
    UPDATE Transactions
       SET state = ?
           ${setSql ? ', ' + setSql : ''}
           , updated_at = ?
           , version = version + 1
     WHERE txid = ?
       AND state IN (${placeholders})
       AND version = ?
  `

  const updated = await db
    .prepare(sql)
    .bind(req.toState, ...setValues, now, req.txid, ...fromStates, cur.version)
    .run()

  if ((updated.meta.changes ?? 0) === 0) {
    if (req.strict) {
      throw new DomainError(
        'CONCURRENCY_CONFLICT',
        `CAS lost on ${req.txid}: another writer advanced the row`,
        { txid: req.txid, expected_version: cur.version },
      )
    }
    return { applied: false, previousState: cur.state }
  }

  await writeFinalityLog(db, {
    txid: req.txid,
    event_type: req.eventType,
    state_from: cur.state,
    state_to: req.toState,
    payload_json: JSON.stringify(req.payload ?? { txid: req.txid }),
    txid_or_gtid: req.txid,
  })

  return { applied: true, previousState: cur.state }
}

// ---------------------------------------------------------------------------
// cancelInFlightTx
// ---------------------------------------------------------------------------

export interface CancelRequest {
  txid: string
  reasonCode: string
  /** States from which a cancel is permitted. Defaults to pre-decision states. */
  fromStates?: string[]
  /** Skip the H release step (used for lanes that never reserve H). */
  skipReleaseH?: boolean
  /**
   * Optional secondary-table CAS UPDATEs run atomically in the same D1 batch
   * as the canonical Transactions UPDATE. Each entry's individual `changes`
   * count is informational only — H release, FinalityLog, and finalize gate
   * ONLY on the canonical Transactions UPDATE succeeding. This guarantees
   * that side-table state (e.g. HtlcContracts.state) cannot lead H to be
   * released when the canonical decision has already committed to settle.
   */
  sideUpdates?: Array<{ sql: string; binds: Array<string | number | null> }>
  /**
   * Custom FinalityLog event_type. Defaults to 'DecidedCancel'.
   * Useful when a lane wants a more specific name (e.g. 'HtlcCancelled').
   */
  eventType?: string
  /** Additional fields merged into the FinalityLog payload. */
  payloadExtra?: Record<string, unknown>
}

/**
 * Cancel an in-flight transaction: CAS to DECIDED_CANCEL → release H (if any)
 * → log → finalize as CANCELLED.
 *
 * The order is important: we transition state FIRST so a parallel decision
 * path cannot win the CAS. Only after the row is owned do we release H,
 * which prevents the bug where a LOCKED reservation gets released even
 * though the decision path won.
 *
 * With `sideUpdates`, additional CAS statements (e.g. HtlcContracts state
 * change) run inside the same batch so they commit-or-rollback atomically
 * with the canonical Transactions update.
 *
 * Returns true when the canonical cancel took effect; false when the row
 * was already past the cancel window (idempotent no-op).
 */
export async function cancelInFlightTx(
  db: D1Database,
  req: CancelRequest,
): Promise<boolean> {
  const now = nowISO()
  const fromStates = req.fromStates ?? [
    'RECEIVED', 'PRECHECKED', 'PRECHECKED_SUSPENDED', 'H_RESERVED',
  ]
  const placeholders = fromStates.map(() => '?').join(',')

  const txRow = await db
    .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
    .bind(req.txid).first<{ state: string }>()
  if (!txRow) return false

  const canonical = db.prepare(
    `UPDATE Transactions
        SET state = 'DECIDED_CANCEL', reason_code = ?, updated_at = ?, version = version + 1
      WHERE txid = ? AND state IN (${placeholders})`
  ).bind(req.reasonCode, now, req.txid, ...fromStates)

  let canonicalChanges: number
  if (req.sideUpdates && req.sideUpdates.length > 0) {
    const stmts = [canonical, ...req.sideUpdates.map(u => db.prepare(u.sql).bind(...u.binds))]
    const results = await db.batch(stmts)
    canonicalChanges = results[0]?.meta.changes ?? 0
  } else {
    const r = await canonical.run()
    canonicalChanges = r.meta.changes ?? 0
  }

  if (canonicalChanges === 0) return false

  if (!req.skipReleaseH) {
    const txForH = await db
      .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
      .bind(req.txid).first<{ h_reservation_id: string | null }>()
    if (txForH?.h_reservation_id) {
      await releaseH(txForH.h_reservation_id, db)
    }
  }

  const payload: Record<string, unknown> = { reason_code: req.reasonCode, ...(req.payloadExtra ?? {}) }
  await writeFinalityLog(db, {
    txid: req.txid,
    event_type: req.eventType ?? 'DecidedCancel',
    state_from: txRow.state,
    state_to: 'DECIDED_CANCEL',
    payload_json: JSON.stringify(payload),
    txid_or_gtid: req.txid,
  })

  await finalizeCancelledTx(req.txid, db)
  return true
}
