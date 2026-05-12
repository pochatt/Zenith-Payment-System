/**
 * @file money.ts - BigInt-backed money arithmetic for math-heavy code paths.
 *
 * The existing wire format stores amounts as JS `number` (see `Amount.value` in
 * `src/types/primitives.ts`). For JPY (integer minor unit) this is safe up to
 * 2^53 = ~9 petayen, but algorithms that sum thousands of transactions or
 * compute weighted means (netting reducer, H-limit predictor, anomaly stats)
 * can drift if intermediate values cross the safe integer range.
 *
 * This module provides BigInt-based helpers used by new math code. Boundary
 * conversion (`fromNumber`, `toNumber`) is centralised here so that future
 * migration of `Amount.value` to `bigint` can be done without touching every
 * call site.
 *
 * Convention: 1 unit of `Money` = 1 minor currency unit (1 JPY).
 */

export type Money = bigint

export const ZERO: Money = 0n

export function fromNumber(n: number): Money {
  if (!Number.isFinite(n)) {
    throw new RangeError(`money.fromNumber: non-finite input: ${n}`)
  }
  // Floor toward zero to drop any sub-unit fractional part deterministically.
  return BigInt(Math.trunc(n))
}

export function toNumber(m: Money): number {
  if (m > BigInt(Number.MAX_SAFE_INTEGER) || m < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`money.toNumber: ${m} exceeds Number.MAX_SAFE_INTEGER`)
  }
  return Number(m)
}

export function sum(values: Iterable<Money>): Money {
  let acc: Money = 0n
  for (const v of values) acc += v
  return acc
}

export function sumNumbers(values: Iterable<number>): Money {
  let acc: Money = 0n
  for (const v of values) acc += fromNumber(v)
  return acc
}

export function abs(m: Money): Money {
  return m < 0n ? -m : m
}

export function min(a: Money, b: Money): Money {
  return a < b ? a : b
}

export function max(a: Money, b: Money): Money {
  return a > b ? a : b
}

/**
 * Integer division that floors toward negative infinity (matches mathematical
 * modulus). JS BigInt `/` truncates toward zero, which gives wrong results for
 * negative numerators in weighted-average and EMA computations.
 */
export function floorDiv(num: Money, den: Money): Money {
  if (den === 0n) throw new RangeError('money.floorDiv: division by zero')
  const q = num / den
  const r = num % den
  if (r !== 0n && (r < 0n) !== (den < 0n)) return q - 1n
  return q
}

/**
 * Scaled multiplication: (m * num) / den using BigInt to avoid overflow.
 * Used by the H-limit EMA predictor where the smoothing factor is rational.
 */
export function mulDiv(m: Money, num: bigint, den: bigint): Money {
  if (den === 0n) throw new RangeError('money.mulDiv: division by zero')
  return floorDiv(m * num, den)
}
