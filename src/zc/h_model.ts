/**
 * @file h_model.ts - H-Limit Reservation Management (Liquidity Control)
 *
 * Implements the H-limit (bilateral net sending cap) reservation system for ZC.
 * Each participant bank has a configurable h_limit; outbound transfers consume
 * h_used via atomic SQL UPDATE with overflow guard (h_used + amount <= h_limit).
 *
 * Reservation lifecycle:
 *   RESERVED  - capacity claimed at ingress/pre-check time
 *   LOCKED    - promoted when DECIDED_TO_SETTLE (held until DNS settlement)
 *   RELEASED  - returned to pool on cancel, timeout, or DNS cycle completion
 *
 * All mutations use D1 batch or single-statement atomicity; no SELECT FOR UPDATE.
 */
import type { HReservationRow } from '../types'
import { nowISO } from '../types'
import { newUUID } from '../shared/idempotency'

// ---------------------------------------------------------------------------
// H予約取得（楽観的ロック）
// ---------------------------------------------------------------------------

/**
 * Acquire an H-limit reservation for an outbound transfer.
 * Atomically increments h_used if the amount fits within h_limit.
 *
 * @param bankId - Payer bank ID (Participants.bank_id)
 * @param txid   - Transaction ID to associate with the reservation
 * @param amount - Reservation amount in minor units (JPY)
 * @param db     - D1 database handle
 * @returns reservation_id on success, null if h_limit would be exceeded
 */
export async function reserveH(
  bankId: string,
  txid: string,
  amount: number,
  db: D1Database,
): Promise<string | null> {
  const reservationId = `H-${newUUID()}`
  const now = nowISO()

  // Participants.h_used を CAS で更新（超過チェック込み）
  const updated = await db
    .prepare(
      `UPDATE Participants
       SET h_used = h_used + ?
       WHERE bank_id = ? AND is_active = 1 AND (h_used + ?) <= h_limit`,
    )
    .bind(amount, bankId, amount)
    .run()

  if ((updated.meta.changes ?? 0) === 0) {
    // 超過または参加行なし
    return null
  }

  // HReservations レコード挿入
  await db
    .prepare(
      `INSERT INTO HReservations
         (reservation_id, txid, bank_id, amount, mode, is_released, created_at)
       VALUES (?, ?, ?, ?, 'RESERVED', 0, ?)`,
    )
    .bind(reservationId, txid, bankId, amount, now)
    .run()

  return reservationId
}

/**
 * Promote an H-reservation from RESERVED to LOCKED.
 * Called at DECIDED_TO_SETTLE to hold capacity until DNS cycle completion.
 *
 * @param reservationId - H-reservation ID to lock
 * @param db            - D1 database handle
 * @returns true if the lock succeeded, false if already released or not found
 */
export async function lockH(reservationId: string, db: D1Database): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE HReservations SET mode = 'LOCKED'
       WHERE reservation_id = ? AND mode = 'RESERVED' AND is_released = 0`,
    )
    .bind(reservationId)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * Release an H-reservation and return capacity to the bank's h_used pool.
 * Uses D1 batch to atomically mark the reservation released and decrement h_used.
 *
 * @param reservationId - H-reservation ID to release
 * @param db            - D1 database handle
 * @returns true if released, false if already released or not found
 */
export async function releaseH(reservationId: string, db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT bank_id, amount, is_released FROM HReservations WHERE reservation_id = ?`,
    )
    .bind(reservationId)
    .first<{ bank_id: string; amount: number; is_released: number }>()

  if (!row || row.is_released === 1) return false

  const now = nowISO()
  const stmts = [
    db
      .prepare(
        `UPDATE HReservations SET is_released = 1, released_at = ?
         WHERE reservation_id = ? AND is_released = 0`,
      )
      .bind(now, reservationId),
    db
      .prepare(
        `UPDATE Participants SET h_used = MAX(0, h_used - ?) WHERE bank_id = ?`,
      )
      .bind(row.amount, row.bank_id),
  ]

  const results = await db.batch(stmts)
  return (results[0]?.meta.changes ?? 0) > 0
}

/**
 * Retrieve an H-reservation record by ID.
 *
 * @param reservationId - H-reservation ID
 * @param db            - D1 database handle
 * @returns HReservationRow or null if not found
 */
export async function getHReservation(
  reservationId: string,
  db: D1Database,
): Promise<HReservationRow | null> {
  return db
    .prepare(`SELECT * FROM HReservations WHERE reservation_id = ?`)
    .bind(reservationId)
    .first<HReservationRow>()
}

/**
 * Get the current H-limit usage status for a participant bank.
 *
 * @param bankId - Participant bank ID
 * @param db     - D1 database handle
 * @returns Object with h_limit and h_used, or null if bank not found/inactive
 */
export async function getHStatus(
  bankId: string,
  db: D1Database,
): Promise<{ h_limit: number; h_used: number } | null> {
  return db
    .prepare(`SELECT h_limit, h_used FROM Participants WHERE bank_id = ? AND is_active = 1`)
    .bind(bankId)
    .first<{ h_limit: number; h_used: number }>()
}
