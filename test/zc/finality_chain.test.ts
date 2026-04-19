/**
 * @file Tests for tamper-evident FinalityLog hash chain and explainability.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type MockD1Database } from '../helpers/d1-mock'
import { writeFinalityLog } from '../../src/zc/orchestrator'
import { verifyChain, GENESIS_PREV_HASH } from '../../src/zc/finality_chain'
import { explainTransaction } from '../../src/zc/explain'

let d1: MockD1Database

beforeEach(() => {
  const { d1: db } = createTestDb()
  d1 = db
})

function insertTx(txid: string, state: string) {
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'EXPRESS', ?, 100000, 'JPY', '001', '001ACC', '002', '002ACC',
             ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`,
  ).bind(txid, state, `IK-${txid}`)._runSync()
}

async function writeStandardFlow(txid: string) {
  await writeFinalityLog(d1 as any, {
    txid, event_type: 'PaymentInitiated', state_from: null, state_to: 'RECEIVED',
    payload_json: JSON.stringify({ txid }), txid_or_gtid: txid,
  })
  await writeFinalityLog(d1 as any, {
    txid, event_type: 'PreCheckPassed', state_from: 'RECEIVED', state_to: 'PRECHECKED',
    payload_json: '{}', txid_or_gtid: txid,
  })
  await writeFinalityLog(d1 as any, {
    txid, event_type: 'HReserved', state_from: 'PRECHECKED', state_to: 'H_RESERVED',
    payload_json: '{}', txid_or_gtid: txid,
  })
  await writeFinalityLog(d1 as any, {
    txid, event_type: 'Settled', state_from: 'PAYEE_EXEC_CONFIRMED', state_to: 'SETTLED',
    payload_json: '{}', txid_or_gtid: txid,
  })
}

describe('FinalityLog hash chain — writes', () => {
  it('stores prev_hash = GENESIS on the first entry of a chain', async () => {
    await writeFinalityLog(d1 as any, {
      txid: 'TX-CHAIN-001', event_type: 'PaymentInitiated',
      state_from: null, state_to: 'RECEIVED',
      payload_json: '{}', txid_or_gtid: 'TX-CHAIN-001',
    })
    const row = await d1.prepare(
      `SELECT prev_hash, entry_hash FROM FinalityLog WHERE txid = ?`,
    ).bind('TX-CHAIN-001').first<{ prev_hash: string; entry_hash: string }>()
    expect(row?.prev_hash).toBe(GENESIS_PREV_HASH)
    expect(row?.entry_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('links each entry to the previous one within a chain', async () => {
    await writeStandardFlow('TX-CHAIN-002')
    const rows = await d1.prepare(
      `SELECT prev_hash, entry_hash FROM FinalityLog
       WHERE txid = ? ORDER BY event_seq ASC`,
    ).bind('TX-CHAIN-002').all<{ prev_hash: string; entry_hash: string }>()
    expect(rows.results.length).toBe(4)
    for (let i = 1; i < rows.results.length; i++) {
      expect(rows.results[i]!.prev_hash).toBe(rows.results[i - 1]!.entry_hash)
    }
  })

  it('keeps separate chains isolated per txid', async () => {
    await writeStandardFlow('TX-CHAIN-A')
    await writeStandardFlow('TX-CHAIN-B')
    const a = await verifyChain(d1 as any, 'TX-CHAIN-A')
    const b = await verifyChain(d1 as any, 'TX-CHAIN-B')
    expect(a.valid).toBe(true)
    expect(b.valid).toBe(true)
    expect(a.entries_checked).toBe(4)
    expect(b.entries_checked).toBe(4)
  })
})

describe('verifyChain — detects tampering', () => {
  it('reports valid chain when no data has been modified', async () => {
    await writeStandardFlow('TX-VERIFY-OK')
    const result = await verifyChain(d1 as any, 'TX-VERIFY-OK')
    expect(result.valid).toBe(true)
    expect(result.break_at_seq).toBeNull()
    expect(result.break_reason).toBeNull()
  })

  it('detects payload tampering (ENTRY_HASH_MISMATCH)', async () => {
    await writeStandardFlow('TX-TAMPER-001')
    // Silently rewrite the payload of the 2nd entry — entry_hash now stale.
    d1.prepare(
      `UPDATE FinalityLog SET payload_json = ?
       WHERE txid = ? AND event_type = 'PreCheckPassed'`,
    ).bind('{"forged":true}', 'TX-TAMPER-001')._runSync()

    const result = await verifyChain(d1 as any, 'TX-TAMPER-001')
    expect(result.valid).toBe(false)
    expect(result.break_reason).toBe('ENTRY_HASH_MISMATCH')
    expect(result.break_at_seq).not.toBeNull()
  })

  it('detects link rewriting (PREV_HASH_MISMATCH)', async () => {
    await writeStandardFlow('TX-TAMPER-002')
    // Rewrite the prev_hash of the 3rd entry to break the link.
    d1.prepare(
      `UPDATE FinalityLog SET prev_hash = 'deadbeef'
       WHERE txid = ? AND event_type = 'HReserved'`,
    ).bind('TX-TAMPER-002')._runSync()

    const result = await verifyChain(d1 as any, 'TX-TAMPER-002')
    expect(result.valid).toBe(false)
    expect(result.break_reason).toBe('PREV_HASH_MISMATCH')
  })

  it('detects silent deletion of a middle entry', async () => {
    await writeStandardFlow('TX-TAMPER-003')
    d1.prepare(
      `DELETE FROM FinalityLog WHERE txid = ? AND event_type = 'HReserved'`,
    ).bind('TX-TAMPER-003')._runSync()

    const result = await verifyChain(d1 as any, 'TX-TAMPER-003')
    expect(result.valid).toBe(false)
    expect(result.break_reason).toBe('PREV_HASH_MISMATCH')
  })
})

describe('explainTransaction', () => {
  it('returns null for unknown txid', async () => {
    const result = await explainTransaction(d1 as any, 'TX-NOPE')
    expect(result).toBeNull()
  })

  it('produces a timeline with human-readable reasons and integrity status', async () => {
    insertTx('TX-EXPLAIN-001', 'SETTLED')
    await writeStandardFlow('TX-EXPLAIN-001')

    const result = await explainTransaction(d1 as any, 'TX-EXPLAIN-001')
    expect(result).not.toBeNull()
    expect(result!.current_state).toBe('SETTLED')
    expect(result!.summary).toMatch(/最終確定/)
    expect(result!.timeline.length).toBe(4)
    expect(result!.timeline[0]!.event).toBe('PaymentInitiated')
    expect(result!.timeline[0]!.reason).toMatch(/送金リクエスト/)
    expect(result!.timeline[0]!.actors).toContain('ZC')
    expect(result!.integrity.chain_verified).toBe(true)
    expect(result!.integrity.entries_checked).toBe(4)
    expect(result!.integrity.algorithm).toMatch(/SHA-256/)
  })

  it('surfaces tamper detection in the integrity block', async () => {
    insertTx('TX-EXPLAIN-002', 'SETTLED')
    await writeStandardFlow('TX-EXPLAIN-002')
    d1.prepare(
      `UPDATE FinalityLog SET payload_json = '{"forged":true}'
       WHERE txid = ? AND event_type = 'PaymentInitiated'`,
    ).bind('TX-EXPLAIN-002')._runSync()

    const result = await explainTransaction(d1 as any, 'TX-EXPLAIN-002')
    expect(result!.integrity.chain_verified).toBe(false)
    expect(result!.integrity.break_reason).toBe('ENTRY_HASH_MISMATCH')
  })
})
