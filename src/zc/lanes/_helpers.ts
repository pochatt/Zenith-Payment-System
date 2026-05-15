/**
 * @file _helpers.ts — Shared building blocks for lane state machines.
 *
 * Every lane (express, standard, htlc, gtid, rtp, highvalue, bulk, htlc_auth)
 * implements the same three patterns:
 *
 *   1. Transition a Transactions row with optimistic-lock CAS, then write a
 *      FinalityLog entry. The two MUST commit together — a partial state
 *      advance with no audit record is a hard bug in an "explicable state
 *      sequence" system. `transitionWithLog` enforces this by issuing both
 *      statements in a single `db.batch()` with a conditional INSERT...SELECT
 *      WHERE EXISTS guard, so the log row is created iff the CAS UPDATE hit.
 *   2. Cancel an in-flight transaction: state guard → release H reservation
 *      (in the right order so a parallel `decision` cannot leak H) → log →
 *      finalize as CANCELLED.
 *   3. Sticky idempotency on `request_id` so retried bank callbacks no-op.
 *
 * This file centralizes (1) and (2). All lanes that mutate Transactions.state
 * are expected to use these helpers — never hand-roll `UPDATE Transactions
 * SET state=...` because it bypasses the `ALLOWED_TRANSITIONS` validator and
 * the atomic FinalityLog write.
 *
 * State-machine validation: `transitionWithLog` calls `isValidTransition`
 * before any DB I/O. An attempt to move a row through a transition not listed
 * in `ALLOWED_TRANSITIONS` raises `INVARIANT_VIOLATION` (or returns
 * `{applied:false}` in non-strict mode) and never reaches the DB. This is the
 * single chokepoint that makes the state machine table enforceable rather
 * than merely documentary.
 */
import { nowISO } from '../../types'
import type { FinalityEventType, TxState } from '../../types'
import {
  finalizeCancelledTx,
  prepareFinalityLogRow,
  buildFinalityLogConditionalInsert,
} from '../orchestrator/finality'
import { isValidTransition, ALLOWED_TRANSITIONS } from '../orchestrator/state_machine'
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
  /**
   * Skip the `ALLOWED_TRANSITIONS` static check. Use sparingly — currently
   * only for FinalityLog event names like 'PreCheckSuspended' or 'NameCheckOverridden'
   * that record bookkeeping transitions whose target state is internal to the
   * state machine but not directly user-facing. The default is to enforce.
   */
  skipStateMachineCheck?: boolean
}

export interface TransitionResult {
  applied: boolean
  /** Snapshot of the row's state before the UPDATE; null if the row did not exist. */
  previousState: string | null
}

/**
 * CAS-update a Transactions row and write a paired FinalityLog entry — atomically.
 *
 * Atomicity contract:
 *   - The UPDATE and the FinalityLog INSERT are issued as a single `db.batch()`.
 *   - The INSERT uses a conditional `INSERT...SELECT ... WHERE EXISTS(...)` form
 *     gated on the post-UPDATE row state and version, so it fires iff the CAS
 *     hit. A thrown INSERT (e.g. prev_hash UNIQUE collision) rolls back the
 *     UPDATE because both run inside the batch's implicit transaction.
 *
 * State machine validation:
 *   - Each (currentState, toState) pair is checked against `ALLOWED_TRANSITIONS`
 *     before the CAS UPDATE. Illegal transitions raise `INVARIANT_VIOLATION`
 *     (strict) or return `{applied:false}` (non-strict), and never touch the DB.
 *
 * Idempotency:
 *   - If no row matches `txid AND state IN (fromState)` the call is a no-op
 *     (returns `{applied:false}`). When `strict: true` the same condition
 *     raises `CONCURRENCY_CONFLICT` so callers can surface a 409 to the client.
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

  // State-machine validation: each candidate source must permit transitioning
  // to `toState`. Without this, a future refactor adding a new lane could
  // silently sneak through a transition not listed in ALLOWED_TRANSITIONS.
  if (!req.skipStateMachineCheck) {
    if (!isValidTransition(cur.state as TxState, req.toState as TxState)) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        `Disallowed state transition ${cur.state} → ${req.toState} for ${req.txid}. ` +
          `Allowed from ${cur.state}: [${(ALLOWED_TRANSITIONS[cur.state as TxState] ?? []).join(',') || '<none>'}]`,
        { txid: req.txid, from: cur.state, to: req.toState },
      )
    }
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

  const updateSql = `
    UPDATE Transactions
       SET state = ?
           ${setSql ? ', ' + setSql : ''}
           , updated_at = ?
           , version = version + 1
     WHERE txid = ?
       AND state IN (${placeholders})
       AND version = ?
  `

  // Pre-compute the FinalityLog row (event_seq, prev_hash, entry_hash) so the
  // INSERT can be batched with the UPDATE without a second round-trip.
  const logRow = await prepareFinalityLogRow(db, {
    txid: req.txid,
    event_type: req.eventType,
    state_from: cur.state,
    state_to: req.toState,
    payload_json: JSON.stringify(req.payload ?? { txid: req.txid }),
    txid_or_gtid: req.txid,
  })

  // Atomic batch: either both statements commit, or both roll back.
  // The conditional INSERT is gated on `changes() > 0` for the immediately
  // preceding UPDATE, so a losing CAS skips the log INSERT and the row is
  // not corrupted by an orphan audit entry.
  const results = await db.batch([
    db.prepare(updateSql).bind(req.toState, ...setValues, now, req.txid, ...fromStates, cur.version),
    buildFinalityLogConditionalInsert(db, logRow),
  ])

  const updateChanges = results[0]?.meta.changes ?? 0
  if (updateChanges === 0) {
    if (req.strict) {
      throw new DomainError(
        'CONCURRENCY_CONFLICT',
        `CAS lost on ${req.txid}: another writer advanced the row`,
        { txid: req.txid, expected_version: cur.version },
      )
    }
    return { applied: false, previousState: cur.state }
  }

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
 * The canonical CAS UPDATE and the paired DecidedCancel FinalityLog INSERT
 * are issued in a single batch (atomic). Side-updates (e.g. HtlcContracts)
 * are appended to that batch so they commit-or-rollback together with the
 * canonical update.
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
    .prepare(`SELECT state, version FROM Transactions WHERE txid = ?`)
    .bind(req.txid).first<{ state: string; version: number }>()
  if (!txRow) return false
  if (!fromStates.includes(txRow.state)) return false

  // Pre-compute the DecidedCancel log row so it can be batched with the CAS.
  const logRow = await prepareFinalityLogRow(db, {
    txid: req.txid,
    event_type: req.eventType ?? 'DecidedCancel',
    state_from: txRow.state,
    state_to: 'DECIDED_CANCEL',
    payload_json: JSON.stringify({ reason_code: req.reasonCode, ...(req.payloadExtra ?? {}) }),
    txid_or_gtid: req.txid,
  })

  // Statement order matters: the FinalityLog INSERT must come directly after
  // the CAS UPDATE so its `changes() > 0` guard reflects the UPDATE's row
  // count. Side-updates run last; their changes() do not gate anything.
  const stmts = [
    db.prepare(
      `UPDATE Transactions
          SET state = 'DECIDED_CANCEL', reason_code = ?, updated_at = ?, version = version + 1
        WHERE txid = ? AND state IN (${placeholders}) AND version = ?`
    ).bind(req.reasonCode, now, req.txid, ...fromStates, txRow.version),
    buildFinalityLogConditionalInsert(db, logRow),
    ...(req.sideUpdates ?? []).map(u => db.prepare(u.sql).bind(...u.binds)),
  ]

  const results = await db.batch(stmts)
  const canonicalChanges = results[0]?.meta.changes ?? 0
  if (canonicalChanges === 0) return false

  if (!req.skipReleaseH) {
    const txForH = await db
      .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
      .bind(req.txid).first<{ h_reservation_id: string | null }>()
    if (txForH?.h_reservation_id) {
      await releaseH(txForH.h_reservation_id, db)
    }
  }

  await finalizeCancelledTx(req.txid, db)
  return true
}
