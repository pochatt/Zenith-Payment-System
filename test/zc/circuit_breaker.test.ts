/**
 * @file Integration tests for src/zc/circuit_breaker.ts
 *
 * Verifies state transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb, type MockD1Database } from '../helpers/d1-mock'
import { allowRequest, recordFailure, recordSuccess } from '../../src/zc/circuit_breaker'

const BANK_ID = '001'

let d1: MockD1Database

beforeEach(() => {
  const { d1: db } = createTestDb()
  d1 = db
  // Participants テーブルに行を追加（circuit_breaker は bank_id 存在を前提）
  db.prepare(
    `INSERT OR IGNORE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/001', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
  ).bind(BANK_ID)._runSync()
})

async function tripOpen() {
  // FAILURE_THRESHOLD = 5
  for (let i = 0; i < 5; i++) {
    await recordFailure(BANK_ID, d1 as any)
  }
}

describe('initial state', () => {
  it('allows requests when no record exists (defaults to CLOSED)', async () => {
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true)
  })
})

describe('CLOSED → OPEN', () => {
  it('trips OPEN after 5 consecutive failures', async () => {
    await tripOpen()
    // Immediately after tripping, OPEN_DURATION_MS has not elapsed → deny
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(false)
  })

  it('does not trip before reaching threshold', async () => {
    for (let i = 0; i < 4; i++) {
      await recordFailure(BANK_ID, d1 as any)
    }
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true)
  })
})

describe('OPEN → HALF_OPEN', () => {
  it('transitions to HALF_OPEN after OPEN_DURATION_MS (time-mocked)', async () => {
    await tripOpen()

    // Rewind opened_at by 60 seconds so OPEN_DURATION_MS (30s) has elapsed
    d1.prepare(
      `UPDATE CircuitBreakerState SET opened_at=? WHERE bank_id=?`
    ).bind(new Date(Date.now() - 60_000).toISOString(), BANK_ID)._runSync()

    // allowRequest should transition to HALF_OPEN and return true (probe)
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true)

    const row = await d1.prepare(
      `SELECT state FROM CircuitBreakerState WHERE bank_id=?`
    ).bind(BANK_ID).first<{ state: string }>()
    expect(row?.state).toBe('HALF_OPEN')
  })
})

describe('HALF_OPEN → CLOSED (probe success)', () => {
  it('closes the circuit on a successful probe', async () => {
    await tripOpen()
    // Fast-forward time
    d1.prepare(
      `UPDATE CircuitBreakerState SET opened_at=? WHERE bank_id=?`
    ).bind(new Date(Date.now() - 60_000).toISOString(), BANK_ID)._runSync()
    await allowRequest(BANK_ID, d1 as any) // transitions to HALF_OPEN

    await recordSuccess(BANK_ID, d1 as any)

    const row = await d1.prepare(
      `SELECT state, consecutive_failures FROM CircuitBreakerState WHERE bank_id=?`
    ).bind(BANK_ID).first<{ state: string; consecutive_failures: number }>()
    expect(row?.state).toBe('CLOSED')
    expect(row?.consecutive_failures).toBe(0)
  })
})

describe('HALF_OPEN → OPEN (probe failure)', () => {
  it('re-opens the circuit when the probe fails', async () => {
    await tripOpen()
    d1.prepare(
      `UPDATE CircuitBreakerState SET opened_at=? WHERE bank_id=?`
    ).bind(new Date(Date.now() - 60_000).toISOString(), BANK_ID)._runSync()
    await allowRequest(BANK_ID, d1 as any) // transitions to HALF_OPEN

    await recordFailure(BANK_ID, d1 as any)

    const row = await d1.prepare(
      `SELECT state FROM CircuitBreakerState WHERE bank_id=?`
    ).bind(BANK_ID).first<{ state: string }>()
    expect(row?.state).toBe('OPEN')
  })

  it('resets opened_at so next HALF_OPEN probe waits a full OPEN_DURATION_MS', async () => {
    await tripOpen()
    d1.prepare(
      `UPDATE CircuitBreakerState SET opened_at=? WHERE bank_id=?`
    ).bind(new Date(Date.now() - 60_000).toISOString(), BANK_ID)._runSync()
    await allowRequest(BANK_ID, d1 as any) // HALF_OPEN

    const before = Date.now()
    await recordFailure(BANK_ID, d1 as any) // back to OPEN with new opened_at

    const row = await d1.prepare(
      `SELECT opened_at FROM CircuitBreakerState WHERE bank_id=?`
    ).bind(BANK_ID).first<{ opened_at: string }>()
    const openedAt = new Date(row!.opened_at).getTime()
    // opened_at should be at or after the start of this test (not the old 60s-ago value)
    expect(openedAt).toBeGreaterThanOrEqual(before - 1000)
  })
})

describe('recordSuccess in CLOSED state', () => {
  it('does nothing harmful when already CLOSED', async () => {
    await recordSuccess(BANK_ID, d1 as any)
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true)
  })
})
