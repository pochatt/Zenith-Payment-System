import { describe, it, expect } from 'vitest'
import { analyzeGtidGraph, buildGtidGraph } from '../../src/zc/gtid_graph'
import type { GtidLegRow } from '../../src/types'

function leg(
  legId: string, role: 'PAYER' | 'PAYEE', bankId: string, amount: number,
): GtidLegRow {
  return {
    leg_id: legId,
    gtid: 'GTID-TEST',
    txid: null,
    role,
    bank_id: bankId,
    account_hash: `${bankId}0000000000`,
    amount_value: amount,
    state: 'LEG_REGISTERED',
    bank_proof_ref: null,
    expires_at: null,
    version: 0,
    created_at: '2026-05-12T00:00:00Z',
    updated_at: '2026-05-12T00:00:00Z',
  }
}

describe('gtid_graph.buildGtidGraph', () => {
  it('pairs PAYER and PAYEE legs by sorted leg_id', () => {
    const legs = [
      leg('L1', 'PAYER', '001', 100),
      leg('L2', 'PAYEE', '002', 100),
    ]
    const { edges } = buildGtidGraph(legs)
    expect(edges).toEqual([{ from: '001', to: '002', amount: 100 }])
  })
})

describe('gtid_graph.analyzeGtidGraph', () => {
  it('reports no circular flow for a simple bilateral GTID', () => {
    const legs = [
      leg('L1', 'PAYER', '001', 100),
      leg('L2', 'PAYEE', '002', 100),
    ]
    const result = analyzeGtidGraph(legs)
    expect(result.hasCircularFlow).toBe(false)
    expect(result.cycle).toBe(null)
  })

  it('detects a 3-bank circular GTID (A→B→C→A)', () => {
    const legs = [
      leg('L1', 'PAYER', '001', 100),
      leg('L2', 'PAYEE', '002', 100),
      leg('L3', 'PAYER', '002', 100),
      leg('L4', 'PAYEE', '003', 100),
      leg('L5', 'PAYER', '003', 100),
      leg('L6', 'PAYEE', '001', 100),
    ]
    const result = analyzeGtidGraph(legs)
    expect(result.hasCircularFlow).toBe(true)
    expect(result.cycle).not.toBe(null)
  })

  it('detects a self-pay leg (bank pays itself)', () => {
    const legs = [
      leg('L1', 'PAYER', '001', 100),
      leg('L2', 'PAYEE', '001', 100),
    ]
    const result = analyzeGtidGraph(legs)
    expect(result.hasCircularFlow).toBe(true)
  })
})
