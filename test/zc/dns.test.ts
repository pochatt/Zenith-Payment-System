/**
 * @file DNS cycle management tests.
 *
 * Covers:
 * - getOrCreateDnsCycle: idempotent creation of OPEN cycle
 * - kickDns: OPEN → KICKED with net position calculation
 * - DNS OPEN → KICKED state transition correctness
 * - Net zero-sum invariant across payer/payee banks
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type MockD1Database } from '../helpers/d1-mock'
import { getOrCreateDnsCycle, kickDns, getDnsStatus, getDnsNetPositions } from '../../src/zc/dns'

// ---------------------------------------------------------------------------
// Minimal Env mock (kickDns needs env.DB)
// ---------------------------------------------------------------------------
function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let d1: MockD1Database
const TODAY = '2025-06-01'

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
  ).bind(bankId)._runSync()
}

function insertDecidedTx(db: MockD1Database, txid: string, payerBank: string, payeeBank: string, amount: number, lane = 'EXPRESS') {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, ?, 'DECIDED_TO_SETTLE', ?, 'JPY', ?, 'payerAcc', ?, 'payeeAcc',
             ?, '1.0', '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
  ).bind(txid, lane, amount, payerBank, payeeBank, `IK-${txid}`)._runSync()
}

beforeEach(() => {
  const { d1: db } = createTestDb()
  d1 = db
  seedParticipant(d1, '001')
  seedParticipant(d1, '002')
  seedParticipant(d1, '003')
})

// ---------------------------------------------------------------------------
// getOrCreateDnsCycle
// ---------------------------------------------------------------------------

describe('getOrCreateDnsCycle', () => {
  it('creates a new OPEN cycle when none exists', async () => {
    const cycleId = await getOrCreateDnsCycle(d1 as any, `${TODAY}T10:00:00Z`)
    expect(cycleId).toBeTruthy()
    expect(cycleId.startsWith('DNS-')).toBe(true)

    const row = await d1.prepare(`SELECT state FROM DnsCycles WHERE cycle_id = ?`)
      .bind(cycleId).first<{ state: string }>()
    expect(row?.state).toBe('OPEN')
  })

  it('returns the same cycle_id on repeated calls for the same day', async () => {
    const id1 = await getOrCreateDnsCycle(d1 as any, `${TODAY}T10:00:00Z`)
    const id2 = await getOrCreateDnsCycle(d1 as any, `${TODAY}T11:00:00Z`)
    expect(id1).toBe(id2)
  })

  it('creates a new late cycle when the day cycle is already SETTLED', async () => {
    // Pre-create and mark SETTLED
    d1.prepare(
      `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, created_at)
       VALUES ('DNS-2025-06-01', '2025-06-01', 'SETTLED', 'NORMAL', '2025-06-01T08:00:00Z')`
    )._runSync()

    const lateId = await getOrCreateDnsCycle(d1 as any, `${TODAY}T15:30:00Z`)
    // Should create a new OPEN cycle with a different id (not 'DNS-2025-06-01')
    expect(lateId).not.toBe(`DNS-${TODAY}`)

    const row = await d1.prepare(`SELECT state FROM DnsCycles WHERE cycle_id = ?`)
      .bind(lateId).first<{ state: string }>()
    expect(row?.state).toBe('OPEN')
  })
})

// ---------------------------------------------------------------------------
// kickDns: OPEN → KICKED, net positions
// ---------------------------------------------------------------------------

describe('kickDns', () => {
  it('transitions the cycle from OPEN to KICKED', async () => {
    // Create an OPEN cycle
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`)
    const env = makeEnv(d1)
    const result = await kickDns(TODAY, env)

    expect(result.state).toBe('KICKED')
    expect(result.cycle_id).toContain('DNS-')

    const cycle = await getDnsStatus(TODAY, d1 as any)
    expect(cycle?.state).toBe('KICKED')
  })

  it('computes correct net positions for a single payment 001 → 002', async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`)
    insertDecidedTx(d1, 'TX-DNS-A', '001', '002', 100_000)

    const env = makeEnv(d1)
    const result = await kickDns(TODAY, env)

    expect(result.net_positions['001']).toBe(-100_000)  // payer = debit
    expect(result.net_positions['002']).toBe(100_000)   // payee = credit
  })

  it('maintains zero-sum net positions (all positions sum to zero)', async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`)
    insertDecidedTx(d1, 'TX-DNS-B1', '001', '002', 80_000)
    insertDecidedTx(d1, 'TX-DNS-B2', '002', '003', 30_000)
    insertDecidedTx(d1, 'TX-DNS-B3', '003', '001', 50_000)

    const env = makeEnv(d1)
    const result = await kickDns(TODAY, env)

    const total = Object.values(result.net_positions).reduce((a, b) => a + b, 0)
    expect(total).toBe(0)
  })

  it('assigns pending DECIDED_TO_SETTLE transactions to the cycle', async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`)
    insertDecidedTx(d1, 'TX-DNS-C1', '001', '002', 50_000)
    insertDecidedTx(d1, 'TX-DNS-C2', '001', '003', 25_000)

    const env = makeEnv(d1)
    const { cycle_id } = await kickDns(TODAY, env)

    const count = await d1.prepare(
      `SELECT COUNT(*) AS cnt FROM Transactions WHERE dns_cycle_id = ?`
    ).bind(cycle_id).first<{ cnt: number }>()
    expect(count?.cnt).toBe(2)
  })

  it('does not include HIGH_VALUE transactions in the cycle', async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`)
    insertDecidedTx(d1, 'TX-DNS-HV', '001', '002', 200_000, 'HIGH_VALUE')

    const env = makeEnv(d1)
    const { cycle_id } = await kickDns(TODAY, env)

    const count = await d1.prepare(
      `SELECT COUNT(*) AS cnt FROM Transactions WHERE dns_cycle_id = ?`
    ).bind(cycle_id).first<{ cnt: number }>()
    expect(count?.cnt).toBe(0)
  })

  it('returns existing cycle state when already KICKED', async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`)
    const env = makeEnv(d1)
    const first = await kickDns(TODAY, env)
    const second = await kickDns(TODAY, env)

    // Second call should return existing cycle info (no-op)
    expect(second.cycle_id).toBe(first.cycle_id)
    expect(second.state).toBe('KICKED')
  })

  it('persists DnsNetPositions rows after kicking', async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`)
    insertDecidedTx(d1, 'TX-DNS-D1', '001', '002', 60_000)

    const env = makeEnv(d1)
    await kickDns(TODAY, env)

    const positions = await getDnsNetPositions(TODAY, d1 as any)
    expect(positions.length).toBeGreaterThan(0)

    const payerPos = positions.find(p => p.bank_id === '001')
    const payeePos = positions.find(p => p.bank_id === '002')
    expect(payerPos?.net_position).toBe(-60_000)
    expect(payeePos?.net_position).toBe(60_000)
  })

  it('writes a DnsKicked FinalityLog entry', async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`)
    const env = makeEnv(d1)
    await kickDns(TODAY, env)

    const log = await d1.prepare(
      `SELECT event_type FROM FinalityLog WHERE event_type = 'DnsKicked' LIMIT 1`
    ).first<{ event_type: string }>()
    expect(log).not.toBeNull()
    expect(log?.event_type).toBe('DnsKicked')
  })
})
