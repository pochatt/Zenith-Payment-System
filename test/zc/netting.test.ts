import { describe, it, expect } from 'vitest'
import {
  computeNetPositions, reduceToMinimumTransfers, netObligations,
  isBalanced, type Obligation,
} from '../../src/zc/netting'

describe('netting.computeNetPositions', () => {
  it('returns empty for no obligations', () => {
    const result = computeNetPositions([])
    expect(result.size).toBe(0)
  })

  it('computes net positions for a single transfer', () => {
    const result = computeNetPositions([{ from: 'A', to: 'B', amount: 100 }])
    expect(result.get('A')).toBe(-100n)
    expect(result.get('B')).toBe(100n)
  })

  it('aggregates multiple transfers between the same banks', () => {
    const obligations: Obligation[] = [
      { from: 'A', to: 'B', amount: 100 },
      { from: 'B', to: 'A', amount: 30 },
      { from: 'A', to: 'B', amount: 50 },
    ]
    const result = computeNetPositions(obligations)
    expect(result.get('A')).toBe(-120n)
    expect(result.get('B')).toBe(120n)
  })

  it('balances to zero across all participants', () => {
    const obligations: Obligation[] = [
      { from: 'A', to: 'B', amount: 100 },
      { from: 'B', to: 'C', amount: 50 },
      { from: 'C', to: 'A', amount: 25 },
    ]
    const result = computeNetPositions(obligations)
    expect(isBalanced(result)).toBe(true)
  })
})

describe('netting.reduceToMinimumTransfers', () => {
  it('returns empty for all-zero positions', () => {
    const net = new Map<string, bigint>([['A', 0n], ['B', 0n]])
    expect(reduceToMinimumTransfers(net)).toEqual([])
  })

  it('produces a single transfer between two banks', () => {
    const net = new Map<string, bigint>([['A', -100n], ['B', 100n]])
    const payments = reduceToMinimumTransfers(net)
    expect(payments).toEqual([{ from: 'A', to: 'B', amount: 100 }])
  })

  it('uses at most (participants − 1) transfers', () => {
    const net = new Map<string, bigint>([
      ['A', -50n], ['B', -30n], ['C', 40n], ['D', 40n],
    ])
    const payments = reduceToMinimumTransfers(net)
    expect(payments.length).toBeLessThanOrEqual(3)

    const check = new Map<string, bigint>()
    for (const p of payments) {
      check.set(p.from, (check.get(p.from) ?? 0n) - BigInt(p.amount))
      check.set(p.to,   (check.get(p.to)   ?? 0n) + BigInt(p.amount))
    }
    for (const [bank, expectedPos] of net) {
      expect(check.get(bank) ?? 0n).toBe(expectedPos)
    }
  })

  it('matches largest debtor to largest creditor first', () => {
    const net = new Map<string, bigint>([
      ['A', -1000n], ['B', -100n], ['C', 500n], ['D', 600n],
    ])
    const payments = reduceToMinimumTransfers(net)
    expect(payments[0]!.from).toBe('A')
    expect(payments[0]!.to).toBe('D')
  })
})

describe('netting.netObligations', () => {
  it('reports compression ratio', () => {
    const obligations: Obligation[] = [
      { from: 'A', to: 'B', amount: 100 },
      { from: 'B', to: 'A', amount: 90 },
    ]
    const result = netObligations(obligations)
    expect(result.grossVolume).toBe(190)
    expect(result.nettedVolume).toBe(10)
    expect(result.compressionRatio).toBeCloseTo(10 / 190, 6)
    expect(result.payments).toEqual([{ from: 'A', to: 'B', amount: 10 }])
  })

  it('detects cycles can be netted to zero', () => {
    // A → B → C → A all for 100 — perfect cycle, nets to nothing
    const obligations: Obligation[] = [
      { from: 'A', to: 'B', amount: 100 },
      { from: 'B', to: 'C', amount: 100 },
      { from: 'C', to: 'A', amount: 100 },
    ]
    const result = netObligations(obligations)
    expect(result.payments).toEqual([])
    expect(result.nettedVolume).toBe(0)
    expect(result.grossVolume).toBe(300)
    expect(result.compressionRatio).toBe(0)
  })
})
