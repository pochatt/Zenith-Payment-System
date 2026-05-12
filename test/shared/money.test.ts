import { describe, it, expect } from 'vitest'
import {
  fromNumber, toNumber, sum, sumNumbers, abs, min, max, floorDiv, mulDiv, ZERO,
} from '../../src/shared/money'

describe('money.fromNumber / toNumber', () => {
  it('round-trips safe integers', () => {
    expect(toNumber(fromNumber(123))).toBe(123)
    expect(toNumber(fromNumber(-456))).toBe(-456)
    expect(toNumber(fromNumber(0))).toBe(0)
  })

  it('truncates fractional parts toward zero', () => {
    expect(toNumber(fromNumber(1.9))).toBe(1)
    expect(toNumber(fromNumber(-1.9))).toBe(-1)
  })

  it('throws on non-finite input', () => {
    expect(() => fromNumber(NaN)).toThrow(RangeError)
    expect(() => fromNumber(Infinity)).toThrow(RangeError)
  })

  it('throws when toNumber would lose precision', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n
    expect(() => toNumber(huge)).toThrow(RangeError)
  })
})

describe('money.sum / sumNumbers', () => {
  it('sum returns ZERO for empty input', () => {
    expect(sum([])).toBe(ZERO)
    expect(sumNumbers([])).toBe(ZERO)
  })

  it('sums correctly past Number.MAX_SAFE_INTEGER', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER)
    const result = sum([big, big])
    expect(result).toBe(big * 2n)
  })

  it('sumNumbers aggregates JS numbers via BigInt', () => {
    expect(sumNumbers([1, 2, 3, 4])).toBe(10n)
  })
})

describe('money helpers', () => {
  it('abs/min/max work on Money', () => {
    expect(abs(-7n)).toBe(7n)
    expect(min(3n, 5n)).toBe(3n)
    expect(max(3n, 5n)).toBe(5n)
  })

  it('floorDiv floors toward negative infinity', () => {
    expect(floorDiv(7n, 2n)).toBe(3n)
    expect(floorDiv(-7n, 2n)).toBe(-4n)
    expect(floorDiv(-8n, 2n)).toBe(-4n)
  })

  it('floorDiv throws on division by zero', () => {
    expect(() => floorDiv(1n, 0n)).toThrow(RangeError)
  })

  it('mulDiv computes scaled multiplication', () => {
    expect(mulDiv(100n, 3n, 10n)).toBe(30n)
    expect(mulDiv(1_000_000n, 7n, 10n)).toBe(700_000n)
  })
})
