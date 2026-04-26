/**
 * @file Unit + concurrency tests for src/zc/lanes/_helpers.ts
 *
 * Verifies that:
 *   - transitionWithLog applies one CAS UPDATE and writes a paired FinalityLog
 *   - state-guard misses are idempotent no-ops (or strict throws)
 *   - concurrent transitions produce exactly one applied:true (race safety)
 *   - cancelInFlightTx orders state-guard before H release, preserving
 *     the existing TOCTOU bug-fix invariant (see express.ts cancelTx note).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type MockD1Database } from '../helpers/d1-mock'
import { transitionWithLog, cancelInFlightTx } from '../../src/zc/lanes/_helpers'
import { reserveH } from '../../src/zc/h_model'
import { isDomainError } from '../../src/shared/errors'

const PAYER_BANK = '001'
const PAYEE_BANK = '002'

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
  ).bind(bankId)._runSync()
}

function insertTx(db: MockD1Database, txid: string, state = 'RECEIVED') {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'EXPRESS', ?, 100000, 'JPY', '001', '0010000001', '002', '0020000001',
             ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  ).bind(txid, state, `IK-${txid}`)._runSync()
}

let d1: MockD1Database
beforeEach(() => {
  const { d1: db } = createTestDb()
  d1 = db
  seedParticipant(d1, PAYER_BANK)
  seedParticipant(d1, PAYEE_BANK)
})

// ---------------------------------------------------------------------------
// transitionWithLog
// ---------------------------------------------------------------------------

describe('transitionWithLog', () => {
  it('applies the transition and writes a paired FinalityLog entry', async () => {
    const txid = 'TX-LH-001'
    insertTx(d1, txid)

    const result = await transitionWithLog(d1 as any, {
      txid,
      fromState: 'RECEIVED',
      toState: 'PRECHECKED',
      eventType: 'PreCheckPassed',
      payload: { txid },
    })

    expect(result.applied).toBe(true)
    expect(result.previousState).toBe('RECEIVED')

    const row = await d1.prepare(`SELECT state, version FROM Transactions WHERE txid = ?`)
      .bind(txid).first<{ state: string; version: number }>()
    expect(row?.state).toBe('PRECHECKED')
    expect(row?.version).toBe(1) // bumped by helper

    const logs = await d1.prepare(
      `SELECT event_type, state_from, state_to FROM FinalityLog WHERE txid = ?`
    ).bind(txid).all<{ event_type: string; state_from: string; state_to: string }>()
    expect(logs.results).toHaveLength(1)
    expect(logs.results[0]).toEqual({
      event_type: 'PreCheckPassed', state_from: 'RECEIVED', state_to: 'PRECHECKED',
    })
  })

  it('is a no-op when the source state does not match', async () => {
    const txid = 'TX-LH-002'
    insertTx(d1, txid, 'PRECHECKED')

    const result = await transitionWithLog(d1 as any, {
      txid, fromState: 'RECEIVED', toState: 'H_RESERVED',
      eventType: 'HReserved',
    })

    expect(result.applied).toBe(false)
    expect(result.previousState).toBe('PRECHECKED')

    const logs = await d1.prepare(
      `SELECT COUNT(*) AS n FROM FinalityLog WHERE txid = ?`
    ).bind(txid).first<{ n: number }>()
    expect(logs?.n).toBe(0) // no log written on a no-op
  })

  it('returns previousState=null when the row does not exist', async () => {
    const result = await transitionWithLog(d1 as any, {
      txid: 'TX-MISSING', fromState: 'RECEIVED', toState: 'PRECHECKED',
      eventType: 'PreCheckPassed',
    })
    expect(result.applied).toBe(false)
    expect(result.previousState).toBeNull()
  })

  it('strict:true raises CONCURRENCY_CONFLICT on state mismatch', async () => {
    const txid = 'TX-LH-003'
    insertTx(d1, txid, 'PRECHECKED')

    let caught: unknown
    try {
      await transitionWithLog(d1 as any, {
        txid, fromState: 'RECEIVED', toState: 'H_RESERVED',
        eventType: 'HReserved', strict: true,
      })
    } catch (e) {
      caught = e
    }
    expect(isDomainError(caught)).toBe(true)
    if (isDomainError(caught)) {
      expect(caught.reason_code).toBe('CONCURRENCY_CONFLICT')
      expect(caught.category).toBe('CONFLICT')
    }
  })

  it('strict:true raises TX_NOT_FOUND when the row is missing', async () => {
    let caught: unknown
    try {
      await transitionWithLog(d1 as any, {
        txid: 'TX-MISSING', fromState: 'RECEIVED', toState: 'PRECHECKED',
        eventType: 'PreCheckPassed', strict: true,
      })
    } catch (e) {
      caught = e
    }
    expect(isDomainError(caught)).toBe(true)
    if (isDomainError(caught)) expect(caught.reason_code).toBe('TX_NOT_FOUND')
  })

  it('accepts an array of source states', async () => {
    const txid = 'TX-LH-004'
    insertTx(d1, txid, 'H_RESERVED')

    const result = await transitionWithLog(d1 as any, {
      txid,
      fromState: ['PRECHECKED', 'H_RESERVED'],
      toState: 'DECIDED_TO_SETTLE',
      eventType: 'DecidedToSettle',
    })
    expect(result.applied).toBe(true)
    expect(result.previousState).toBe('H_RESERVED')
  })

  it('applies setColumns alongside the state change', async () => {
    const txid = 'TX-LH-005'
    insertTx(d1, txid)

    await transitionWithLog(d1 as any, {
      txid, fromState: 'RECEIVED', toState: 'DECIDED_CANCEL',
      eventType: 'DecidedCancel',
      setColumns: { reason_code: 'NAME_MISMATCH' },
    })

    const row = await d1.prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
      .bind(txid).first<{ state: string; reason_code: string }>()
    expect(row?.state).toBe('DECIDED_CANCEL')
    expect(row?.reason_code).toBe('NAME_MISMATCH')
  })

  it('concurrent calls produce exactly one applied:true (race safety)', async () => {
    // Spin up N parallel transitions on the same row. Only one can win the
    // CAS; the rest must observe applied:false. This guards against the
    // double-H-reserve class of bug.
    const txid = 'TX-LH-RACE'
    insertTx(d1, txid)

    const N = 8
    const results = await Promise.all(
      Array.from({ length: N }, () => transitionWithLog(d1 as any, {
        txid, fromState: 'RECEIVED', toState: 'PRECHECKED',
        eventType: 'PreCheckPassed',
      }))
    )

    const applied = results.filter(r => r.applied)
    expect(applied).toHaveLength(1)

    const logs = await d1.prepare(
      `SELECT COUNT(*) AS n FROM FinalityLog WHERE txid = ? AND event_type = 'PreCheckPassed'`
    ).bind(txid).first<{ n: number }>()
    expect(logs?.n).toBe(1) // exactly one log entry, no duplicates
  })
})

// ---------------------------------------------------------------------------
// cancelInFlightTx
// ---------------------------------------------------------------------------

describe('cancelInFlightTx', () => {
  it('cancels a pre-decision tx and finalizes it as CANCELLED', async () => {
    const txid = 'TX-LH-CANCEL-001'
    insertTx(d1, txid, 'PRECHECKED')

    const ok = await cancelInFlightTx(d1 as any, {
      txid, reasonCode: 'NAME_MISMATCH',
    })
    expect(ok).toBe(true)

    const row = await d1.prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
      .bind(txid).first<{ state: string; reason_code: string }>()
    expect(row?.state).toBe('CANCELLED')
    expect(row?.reason_code).toBe('NAME_MISMATCH')

    // Two FinalityLog entries: DecidedCancel + Cancelled
    const logs = await d1.prepare(
      `SELECT event_type FROM FinalityLog WHERE txid = ? ORDER BY event_seq`
    ).bind(txid).all<{ event_type: string }>()
    expect(logs.results.map(r => r.event_type)).toEqual(['DecidedCancel', 'Cancelled'])
  })

  it('releases the H reservation when one is attached', async () => {
    const txid = 'TX-LH-CANCEL-H'
    insertTx(d1, txid, 'H_RESERVED')

    const reservationId = await reserveH(PAYER_BANK, txid, 100000, d1 as any)
    expect(reservationId).toBeTruthy()
    await d1.prepare(`UPDATE Transactions SET h_reservation_id = ? WHERE txid = ?`)
      .bind(reservationId, txid).run()

    const before = await d1.prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK).first<{ h_used: number }>()
    expect(before?.h_used).toBe(100000)

    await cancelInFlightTx(d1 as any, { txid, reasonCode: 'AUTHORITY_CHECK_NG' })

    const after = await d1.prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK).first<{ h_used: number }>()
    expect(after?.h_used).toBe(0) // released
  })

  it('does NOT release H when the tx has already advanced past the cancel window', async () => {
    // This is the TOCTOU regression guard. If the tx advanced to
    // DECIDED_TO_SETTLE in parallel, our CAS updates 0 rows and we must NOT
    // release the LOCKED reservation.
    const txid = 'TX-LH-CANCEL-RACE'
    insertTx(d1, txid, 'DECIDED_TO_SETTLE')

    const reservationId = await reserveH(PAYER_BANK, txid, 100000, d1 as any)
    await d1.prepare(`UPDATE Transactions SET h_reservation_id = ? WHERE txid = ?`)
      .bind(reservationId, txid).run()

    const ok = await cancelInFlightTx(d1 as any, { txid, reasonCode: 'AUTHORITY_CHECK_NG' })
    expect(ok).toBe(false)

    // h_used must still reflect the locked reservation
    const after = await d1.prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK).first<{ h_used: number }>()
    expect(after?.h_used).toBe(100000)

    const row = await d1.prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(txid).first<{ state: string }>()
    expect(row?.state).toBe('DECIDED_TO_SETTLE') // unchanged
  })
})
