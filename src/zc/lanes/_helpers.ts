/**
 * @file _helpers.ts — Shared building blocks for lane state machines.
 *
 * Every lane (express, standard, htlc, gtid, rtp, highvalue, bulk, htlc_auth)
 * implements the same patterns, centralized here as three primitives:
 *
 *   1. `transitionWithLog` — CAS-advance a Transactions row and write a
 *      paired FinalityLog entry atomically. The two MUST commit together —
 *      a partial state advance with no audit record is a hard bug in an
 *      "explicable state sequence" system. Issued as a single `db.batch()`
 *      with a conditional INSERT...SELECT WHERE EXISTS guard, so the log row
 *      is created iff the CAS UPDATE hit. Optional `sideUpdates` ride in the
 *      same batch for lanes that maintain a parallel state row (HtlcContracts).
 *   2. `cancelInFlightTx` — Cancel an in-flight transaction: state guard →
 *      release H reservation (in the right order so a parallel `decision`
 *      cannot leak H) → log → finalize as CANCELLED. `sideUpdates` ride in
 *      the same batch as the canonical CAS.
 *   3. `insertTxWithLog` — Atomically INSERT a Transactions row at a
 *      whitelisted entry state and write a paired FinalityLog. Used by GTID
 *      leg creation where the row enters at DECIDED_TO_SETTLE directly after
 *      the GT-level decision commits. Entry states are restricted by
 *      `ALLOWED_ENTRY_STATES` so this remains explicit rather than a free
 *      pass to insert rows at arbitrary states.
 *
 * All lanes that mutate Transactions.state or create Transactions rows are
 * expected to use these helpers — never hand-roll `UPDATE Transactions
 * SET state=...` or `INSERT INTO Transactions (..., state, ...)` because it
 * bypasses the `ALLOWED_TRANSITIONS` / `ALLOWED_ENTRY_STATES` validator and
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
  /**
   * Optional secondary-table UPDATEs run atomically in the same D1 batch
   * as the canonical Transactions CAS UPDATE. Symmetric to
   * `cancelInFlightTx.sideUpdates`. Each entry's individual `changes` count
   * is informational only — the canonical UPDATE alone gates the FinalityLog
   * INSERT (which sits between the canonical UPDATE and the side updates so
   * `changes() > 0` reflects the canonical CAS). Used by lanes that maintain
   * a parallel state row (e.g. HtlcContracts) which must commit-or-rollback
   * together with the Transactions advance.
   */
  sideUpdates?: Array<{ sql: string; binds: Array<string | number | null> }>
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

  // Atomic batch: either all statements commit, or all roll back.
  // The conditional INSERT is gated on `changes() > 0` for the immediately
  // preceding UPDATE, so a losing CAS skips the log INSERT and the row is
  // not corrupted by an orphan audit entry. Side updates run after the
  // FinalityLog INSERT — their changes() do not gate anything, but they
  // commit-or-rollback as a unit with the canonical CAS.
  const results = await db.batch([
    db.prepare(updateSql).bind(req.toState, ...setValues, now, req.txid, ...fromStates, cur.version),
    buildFinalityLogConditionalInsert(db, logRow),
    ...(req.sideUpdates ?? []).map(u => db.prepare(u.sql).bind(...u.binds)),
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
// insertTxWithLog
// ---------------------------------------------------------------------------

/**
 * Whitelist of states a Transactions row is allowed to *enter* on INSERT.
 * Most lanes start at RECEIVED and walk the ALLOWED_TRANSITIONS graph; GTID
 * is the exception — after the GT-level decision commits, leg-level rows are
 * created already at DECIDED_TO_SETTLE because no per-leg pre-decision state
 * exists. Restricting the helper to a known set prevents future callers from
 * silently bypassing the state machine by INSERTing arbitrary states.
 */
const ALLOWED_ENTRY_STATES: ReadonlySet<TxState> = new Set<TxState>([
  'RECEIVED',
  'HTLC_LOCKED',
  'DECIDED_TO_SETTLE',
])

export interface InsertTxRequest {
  txid: string
  lane: string
  /** Initial state of the row. Must be in ALLOWED_ENTRY_STATES. */
  initialState: TxState
  amount: { value: number; currency: string }
  payerBankId: string
  payerAccountHash: string
  payeeBankId: string
  payeeAccountHash: string
  idempotencyKey: string
  decisionProofRef?: string | null
  finalityLogRef?: string | null
  hReservationId?: string | null
  dnsCycleId?: string | null
  /** FinalityLog event_type recording the row entry (e.g. 'GtidLegDecidedToSettle'). */
  eventType: FinalityEventType | string
  /** Arbitrary fields to record in the FinalityLog payload. */
  payload?: Record<string, unknown>
  /**
   * Optional secondary-table UPDATEs run atomically in the same D1 batch
   * as the canonical Transactions INSERT (e.g. GtidLegs.txid backref). Their
   * `changes` count is informational only; commit-or-rollback is gated on
   * the whole batch.
   */
  sideUpdates?: Array<{ sql: string; binds: Array<string | number | null> }>
}

export interface InsertTxResult {
  /** True when this call inserted a new row; false when the row already existed (idempotent no-op). */
  inserted: boolean
}

/**
 * Atomically INSERT a Transactions row at a known entry state and write a
 * paired FinalityLog entry recording how the row arrived. Symmetric to
 * `transitionWithLog`, but for the row-creation case where there is no
 * previous Transactions state.
 *
 * Atomicity contract:
 *   - INSERT, FinalityLog INSERT, and any `sideUpdates` are issued as a
 *     single `db.batch()`. A thrown statement (e.g. UNIQUE collision) rolls
 *     the others back, so a Transactions row never exists without its
 *     paired audit entry.
 *
 * Idempotency:
 *   - Uses `INSERT OR IGNORE`. Returns `{inserted:false}` if the row already
 *     exists; the FinalityLog INSERT is gated on `changes() > 0` so a duplicate
 *     call leaves the audit trail untouched.
 *
 * Entry-state validation:
 *   - `initialState` must be in `ALLOWED_ENTRY_STATES`. Attempts to INSERT at
 *     arbitrary states raise `INVARIANT_VIOLATION` before any DB I/O.
 */
export async function insertTxWithLog(
  db: D1Database,
  req: InsertTxRequest,
): Promise<InsertTxResult> {
  if (!ALLOWED_ENTRY_STATES.has(req.initialState)) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `Disallowed entry state ${req.initialState} for ${req.txid}. ` +
        `Allowed entry states: [${Array.from(ALLOWED_ENTRY_STATES).join(',')}]`,
      { txid: req.txid, initial_state: req.initialState },
    )
  }

  const now = nowISO()
  const logRow = await prepareFinalityLogRow(db, {
    txid: req.txid,
    event_type: req.eventType,
    state_from: null,
    state_to: req.initialState,
    payload_json: JSON.stringify(req.payload ?? { txid: req.txid }),
    txid_or_gtid: req.txid,
  })

  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO Transactions
         (txid, lane, state, amount_value, amount_currency,
          payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
          idempotency_key, schema_version, decision_proof_ref, finality_log_ref,
          h_reservation_id, dns_cycle_id, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?, ?, ?, ?, 0, ?, ?)`
    ).bind(
      req.txid, req.lane, req.initialState,
      req.amount.value, req.amount.currency,
      req.payerBankId, req.payerAccountHash,
      req.payeeBankId, req.payeeAccountHash,
      req.idempotencyKey,
      req.decisionProofRef ?? null,
      req.finalityLogRef ?? null,
      req.hReservationId ?? null,
      req.dnsCycleId ?? null,
      now, now,
    ),
    buildFinalityLogConditionalInsert(db, logRow),
    ...(req.sideUpdates ?? []).map(u => db.prepare(u.sql).bind(...u.binds)),
  ])

  const insertChanges = results[0]?.meta.changes ?? 0
  return { inserted: insertChanges > 0 }
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
