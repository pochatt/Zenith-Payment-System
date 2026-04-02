/**
 * @file Circuit Breaker — participant bank health monitoring and request throttling.
 *
 * Implements the spec's Circuit Breaker requirement:
 *   "参加行疎通不能を検知→該当行への実行要求停止→段階的再開（再送嵐防止）"
 *
 * States (per participant bank):
 *   CLOSED   — normal operation; all requests pass through
 *   OPEN     — bank unreachable; all requests fast-fail without calling the bank
 *   HALF_OPEN — tentative recovery; a limited probe is sent to test reachability
 *
 * The circuit trips OPEN after `FAILURE_THRESHOLD` consecutive failures.
 * After `OPEN_DURATION_MS` it transitions to HALF_OPEN and sends a single probe.
 * If the probe succeeds → CLOSED; if it fails → OPEN (reset timer).
 *
 * State is persisted in the CircuitBreakerState table so that it survives
 * Worker isolate restarts and is visible across concurrent isolates.
 *
 * @module zc/circuit_breaker
 */
import { nowISO } from '../types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of consecutive failures before the circuit trips OPEN. */
const FAILURE_THRESHOLD = 5

/** How long (ms) to stay OPEN before allowing a HALF_OPEN probe. */
const OPEN_DURATION_MS = 30_000  // 30 seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerStatus {
  bank_id: string
  state: CircuitState
  consecutive_failures: number
  last_failure_at: string | null
  opened_at: string | null
  half_open_at: string | null
  updated_at: string
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Check whether a request to the given bank should be allowed.
 *
 * - CLOSED → allow
 * - HALF_OPEN → allow (probe)
 * - OPEN → check if OPEN_DURATION_MS elapsed; if so → HALF_OPEN and allow probe;
 *          otherwise → deny (fast-fail)
 *
 * @returns `true` if the request may proceed, `false` if fast-failed
 */
export async function allowRequest(bankId: string, db: D1Database): Promise<boolean> {
  const row = await getOrInit(bankId, db)

  if (row.state === 'CLOSED') return true
  if (row.state === 'HALF_OPEN') return true  // probe in progress

  // OPEN: check elapsed time
  if (row.opened_at) {
    const elapsed = Date.now() - new Date(row.opened_at).getTime()
    if (elapsed >= OPEN_DURATION_MS) {
      // Transition OPEN → HALF_OPEN
      await db.prepare(
        `UPDATE CircuitBreakerState
         SET state = 'HALF_OPEN', half_open_at = ?, updated_at = ?
         WHERE bank_id = ? AND state = 'OPEN'`,
      ).bind(nowISO(), nowISO(), bankId).run()
      return true  // allow probe
    }
  }

  return false  // fast-fail
}

/**
 * Record a successful bank call. Resets the circuit to CLOSED.
 */
export async function recordSuccess(bankId: string, db: D1Database): Promise<void> {
  const now = nowISO()
  await db.prepare(
    `UPDATE CircuitBreakerState
     SET state = 'CLOSED', consecutive_failures = 0,
         last_failure_at = NULL, opened_at = NULL, half_open_at = NULL,
         updated_at = ?
     WHERE bank_id = ?`,
  ).bind(now, bankId).run()
}

/**
 * Record a failed bank call. Increments the failure counter and may trip
 * the circuit OPEN if the threshold is reached.
 */
export async function recordFailure(bankId: string, db: D1Database): Promise<void> {
  const now = nowISO()
  const row = await getOrInit(bankId, db)

  const newCount = row.consecutive_failures + 1

  if (row.state === 'HALF_OPEN') {
    // Probe failed → back to OPEN
    await db.prepare(
      `UPDATE CircuitBreakerState
       SET state = 'OPEN', consecutive_failures = ?, last_failure_at = ?,
           opened_at = ?, half_open_at = NULL, updated_at = ?
       WHERE bank_id = ?`,
    ).bind(newCount, now, now, now, bankId).run()
    return
  }

  if (newCount >= FAILURE_THRESHOLD && row.state === 'CLOSED') {
    // Trip OPEN
    await db.prepare(
      `UPDATE CircuitBreakerState
       SET state = 'OPEN', consecutive_failures = ?, last_failure_at = ?,
           opened_at = ?, updated_at = ?
       WHERE bank_id = ?`,
    ).bind(newCount, now, now, now, bankId).run()
    return
  }

  // Still CLOSED, just bump counter
  await db.prepare(
    `UPDATE CircuitBreakerState
     SET consecutive_failures = ?, last_failure_at = ?, updated_at = ?
     WHERE bank_id = ?`,
  ).bind(newCount, now, now, bankId).run()
}

/**
 * Get the current circuit breaker status for a bank. Returns null if the
 * bank is not registered in the circuit breaker table.
 */
export async function getCircuitStatus(bankId: string, db: D1Database): Promise<CircuitBreakerStatus | null> {
  return db
    .prepare(`SELECT * FROM CircuitBreakerState WHERE bank_id = ?`)
    .bind(bankId)
    .first<CircuitBreakerStatus>()
}

/**
 * List all circuit breaker states (dashboard / monitoring).
 */
export async function listCircuitStates(db: D1Database): Promise<CircuitBreakerStatus[]> {
  const { results } = await db
    .prepare(`SELECT * FROM CircuitBreakerState ORDER BY bank_id`)
    .all<CircuitBreakerStatus>()
  return results ?? []
}

/**
 * Manually reset a circuit to CLOSED (ops override).
 */
export async function resetCircuit(bankId: string, db: D1Database): Promise<void> {
  await recordSuccess(bankId, db)
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function getOrInit(bankId: string, db: D1Database): Promise<CircuitBreakerStatus> {
  const existing = await db
    .prepare(`SELECT * FROM CircuitBreakerState WHERE bank_id = ?`)
    .bind(bankId)
    .first<CircuitBreakerStatus>()

  if (existing) return existing

  const now = nowISO()
  await db.prepare(
    `INSERT OR IGNORE INTO CircuitBreakerState
     (bank_id, state, consecutive_failures, last_failure_at, opened_at, half_open_at, updated_at)
     VALUES (?, 'CLOSED', 0, NULL, NULL, NULL, ?)`,
  ).bind(bankId, now).run()

  return {
    bank_id: bankId,
    state: 'CLOSED',
    consecutive_failures: 0,
    last_failure_at: null,
    opened_at: null,
    half_open_at: null,
    updated_at: now,
  }
}
