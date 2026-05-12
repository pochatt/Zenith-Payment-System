/**
 * @file netting.ts - Multilateral netting algorithms.
 *
 * Used by DNS settlement and reporting to:
 *   1. Compute per-bank net positions from a list of bilateral obligations.
 *   2. Reduce the obligation graph to the minimum set of bilateral payments
 *      that resolves all net positions (no central counterparty).
 *
 * The reduction is a classical "debt simplification" problem. The optimal
 * version is NP-hard (subset-sum), but the greedy largest-debtor / largest-
 * creditor heuristic returns at most `participants - 1` transfers and is the
 * standard approach used by interbank netting services (e.g. CLS, CHIPS in
 * its bilateral closure mode).
 *
 * All arithmetic uses BigInt via `shared/money.ts` so the algorithm is safe
 * for high-volume cycles where summed amounts can exceed Number.MAX_SAFE_INTEGER.
 */

import { type Money, ZERO, fromNumber, toNumber, abs } from '../shared/money'

export interface Obligation {
  from: string
  to: string
  amount: number
}

export interface NettedPayment {
  from: string
  to: string
  amount: number
}

export interface NettingResult {
  netPositions: Record<string, number>
  payments: NettedPayment[]
  grossVolume: number
  nettedVolume: number
  compressionRatio: number
}

/**
 * Compute per-participant net positions.
 * `net[bank] = Σ(incoming) − Σ(outgoing)`.
 *
 * Net debtors have negative position, net creditors positive. Sum is exactly
 * zero by construction (every obligation contributes +amount to one bank and
 * -amount to another).
 */
export function computeNetPositions(obligations: Obligation[]): Map<string, Money> {
  const net = new Map<string, Money>()
  for (const o of obligations) {
    const amt = fromNumber(o.amount)
    net.set(o.from, (net.get(o.from) ?? ZERO) - amt)
    net.set(o.to,   (net.get(o.to)   ?? ZERO) + amt)
  }
  return net
}

/**
 * Greedy minimum-transfer reduction.
 *
 * Repeatedly match the largest net debtor with the largest net creditor and
 * issue a single payment for `min(|debtor|, creditor)`, exhausting one of
 * them per iteration. Terminates in at most `participants - 1` payments and
 * runs in O(n log n) due to the initial sort plus n iterations.
 */
export function reduceToMinimumTransfers(netPositions: Map<string, Money>): NettedPayment[] {
  const debtors: Array<{ bank: string; amount: Money }> = []
  const creditors: Array<{ bank: string; amount: Money }> = []
  for (const [bank, pos] of netPositions) {
    if (pos < 0n) debtors.push({ bank, amount: -pos })
    else if (pos > 0n) creditors.push({ bank, amount: pos })
  }

  debtors.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
  creditors.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))

  const payments: NettedPayment[] = []
  let di = 0
  let ci = 0
  while (di < debtors.length && ci < creditors.length) {
    const d = debtors[di]!
    const c = creditors[ci]!
    const pay: Money = d.amount < c.amount ? d.amount : c.amount
    payments.push({ from: d.bank, to: c.bank, amount: toNumber(pay) })
    d.amount -= pay
    c.amount -= pay
    if (d.amount === 0n) di++
    if (c.amount === 0n) ci++
  }
  return payments
}

/**
 * Full netting pipeline: obligations → net positions + reduced payments + stats.
 *
 * `compressionRatio` is `nettedVolume / grossVolume`. A lower ratio means
 * more compression (more savings in payment count/value).
 */
export function netObligations(obligations: Obligation[]): NettingResult {
  const netMap = computeNetPositions(obligations)
  const payments = reduceToMinimumTransfers(netMap)

  let gross: Money = ZERO
  for (const o of obligations) gross += fromNumber(o.amount)

  let netted: Money = ZERO
  for (const p of payments) netted += fromNumber(p.amount)

  const netPositions: Record<string, number> = {}
  for (const [bank, pos] of netMap) netPositions[bank] = toNumber(pos)

  const grossNum = toNumber(gross)
  const nettedNum = toNumber(netted)
  return {
    netPositions,
    payments,
    grossVolume: grossNum,
    nettedVolume: nettedNum,
    compressionRatio: grossNum === 0 ? 0 : nettedNum / grossNum,
  }
}

/**
 * Sanity check: net positions must sum to zero. Used as a defensive assertion
 * by callers that build obligations from heterogeneous sources.
 */
export function isBalanced(netPositions: Map<string, Money>): boolean {
  let total: Money = ZERO
  for (const v of netPositions.values()) total += v
  return total === 0n
}

/** Convert a Map<string, Money> to a plain object for FinalityLog payloads. */
export function netPositionsToRecord(netPositions: Map<string, Money>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of netPositions) out[k] = toNumber(v)
  return out
}

export { abs as absMoney }
