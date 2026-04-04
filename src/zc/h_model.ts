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

  // Step 1: h_limit 超過チェック（UPDATE の changes=0 で判定）
  const upd = await db
    .prepare(
      `UPDATE Participants
       SET h_used = h_used + ?
       WHERE bank_id = ? AND is_active = 1 AND (h_used + ?) <= h_limit`,
    )
    .bind(amount, bankId, amount)
    .run()

  if ((upd.meta.changes ?? 0) === 0) {
    // 超過または参加行なし — HReservations INSERT をスキップして孤児レコードを防ぐ
    return null
  }

  // Step 2: h_used 増加成功後に HReservations を作成
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
  // TOCTOU防止: CASガード付きの単一バッチで実行
  // HReservations の is_released=0 ガードが二重解放を防ぎ、
  // Participants の h_used 減算はそのガードの成功に依存する
  const row = await db
    .prepare(
      `SELECT bank_id, amount, is_released FROM HReservations WHERE reservation_id = ?`,
    )
    .bind(reservationId)
    .first<{ bank_id: string; amount: number; is_released: number }>()

  if (!row || row.is_released === 1) return false

  const now = nowISO()
  // バッチ内で HReservations の CAS 更新と Participants の h_used 減算を同一トランザクションで実行
  // HReservations の UPDATE が changes=0 なら（既に is_released=1）、
  // Participants の UPDATE も同じトランザクション内で実行されるが、
  // 戻り値で changes=0 を検出して呼び出し元に false を返す
  const stmts = [
    db
      .prepare(
        `UPDATE HReservations SET is_released = 1, released_at = ?
         WHERE reservation_id = ? AND is_released = 0`,
      )
      .bind(now, reservationId),
    // h_used 減算は HReservations の CAS が成功した場合のみ意味がある
    // D1 batch はトランザクション内実行のため、CAS 失敗時は後続 stmt も含めて
    // ロールバックされないが、changes=0 で呼び出し元が判定する
    // 注: h_used < amount となる場合は会計不整合のため警告ログを出力する。
    // MAX(0, ...) はフロア保護として維持するが、不整合の隠蔽を防ぐ。
    db
      .prepare(
        `UPDATE Participants SET h_used = CASE
           WHEN h_used < ? THEN 0
           ELSE h_used - ?
         END
         WHERE bank_id = ? AND EXISTS (
           SELECT 1 FROM HReservations
           WHERE reservation_id = ? AND is_released = 1 AND released_at = ?
         )`,
      )
      .bind(row.amount, row.amount, row.bank_id, reservationId, now),
  ]

  const results = await db.batch(stmts)
  const released = (results[0]?.meta.changes ?? 0) > 0
  if (released) {
    // h_used < amount の場合は会計不整合（h_used が 0 にクランプされる）
    const p = await db
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(row.bank_id)
      .first<{ h_used: number }>()
    if (p && p.h_used === 0) {
      // 解放後 h_used=0 が期待通りでない可能性がある場合の警告
      // (他の予約が存在するのに 0 になっていればフロア保護が作動した兆候)
      const otherActive = await db
        .prepare(`SELECT COUNT(*) as cnt FROM HReservations WHERE bank_id = ? AND is_released = 0`)
        .bind(row.bank_id)
        .first<{ cnt: number }>()
      if (otherActive && otherActive.cnt > 0) {
        console.warn(
          `[h_model] WARNING: h_used floored to 0 for bank_id=${row.bank_id} but ${otherActive.cnt} active reservations remain. Possible accounting inconsistency.`,
        )
      }
    }
  }
  return released
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
