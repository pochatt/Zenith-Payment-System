/**
 * @file Idempotency control for ZC API endpoints.
 *
 * Uses D1/SQLite's INSERT OR IGNORE to atomically claim an idempotency key,
 * avoiding the need for SELECT FOR UPDATE (unsupported in D1).
 * Callers check the boolean return to decide whether to execute or replay.
 *
 * @module shared/idempotency
 */
import type { Env } from '../types'
import { nowISO } from '../types'

/**
 * Attempt to acquire an idempotency key atomically.
 *
 * Inserts a row with status PROCESSING. If the key already exists the
 * INSERT OR IGNORE is a no-op and `meta.changes` will be 0.
 *
 * @param key - Idempotency key from the X-Idempotency-Key header
 * @param db  - D1 database binding
 * @returns `true` if the key was newly acquired (caller should proceed),
 *          `false` if the key already existed (caller should replay)
 */
export async function acquireIdempotency(key: string, db: D1Database): Promise<boolean> {
  const now = nowISO()
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO IdempotencyKeys (key, status, created_at)
       VALUES (?, 'PROCESSING', ?)`,
    )
    .bind(key, now)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * Mark an idempotency key as DONE and persist the response body.
 *
 * On subsequent duplicate requests the stored response is returned
 * verbatim via {@link getIdempotentResponse}.
 *
 * @param key          - Idempotency key to finalize
 * @param responseBody - The JSON-serializable response to cache
 * @param db           - D1 database binding
 */
export async function completeIdempotency(
  key: string,
  responseBody: unknown,
  db: D1Database,
): Promise<void> {
  await db
    .prepare(
      `UPDATE IdempotencyKeys
       SET status = 'DONE', response_body = ?, updated_at = ?
       WHERE key = ?`,
    )
    .bind(JSON.stringify(responseBody), nowISO(), key)
    .run()
}

/**
 * Retrieve a previously stored idempotent response for replay.
 *
 * - If the key is still PROCESSING, returns `{ result: 'PROCESSING' }`.
 * - If DONE, returns the deserialized response body.
 * - If not found, returns `null`.
 *
 * @param key - Idempotency key to look up
 * @param db  - D1 database binding
 * @returns Cached response, a PROCESSING sentinel, or null
 */
export async function getIdempotentResponse(
  key: string,
  db: D1Database,
): Promise<unknown | null> {
  const row = await db
    .prepare(`SELECT response_body, status FROM IdempotencyKeys WHERE key = ?`)
    .bind(key)
    .first<{ response_body: string | null; status: string }>()

  if (!row) return null
  if (row.status === 'PROCESSING') return { result: 'PROCESSING' }
  if (row.response_body) return JSON.parse(row.response_body)
  return null
}

/**
 * Generate a UUID v4 using the Web Crypto API (`crypto.randomUUID()`).
 *
 * @returns A new random UUID string (e.g. `"550e8400-e29b-41d4-a716-446655440000"`)
 */
export function newUUID(): string {
  return crypto.randomUUID()
}
