import { describe, it, expect } from 'vitest'
import {
  welford, quantile, detectZScoreOutliers, detectIqrOutliers,
  detectModifiedZScoreOutliers,
} from '../../src/shared/anomaly'

describe('anomaly.welford', () => {
  it('computes sample mean and stddev', () => {
    const stats = welford([2, 4, 4, 4, 5, 5, 7, 9])
    expect(stats.mean).toBeCloseTo(5, 6)
    expect(stats.stddev).toBeCloseTo(2.138089935299395, 4)
    expect(stats.n).toBe(8)
  })

  it('returns 0 stddev for a single value', () => {
    expect(welford([42]).stddev).toBe(0)
  })

  it('returns zeros for empty input', () => {
    const stats = welford([])
    expect(stats).toEqual({ mean: 0, stddev: 0, n: 0 })
  })
})

describe('anomaly.quantile', () => {
  it('computes median', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
  })

  it('computes Q1 and Q3', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    expect(quantile(values, 0.25)).toBe(3)
    expect(quantile(values, 0.75)).toBe(7)
  })

  it('does not mutate input', () => {
    const xs = [5, 3, 1, 4, 2]
    quantile(xs, 0.5)
    expect(xs).toEqual([5, 3, 1, 4, 2])
  })
})

describe('anomaly.detectZScoreOutliers', () => {
  it('flags values beyond the threshold', () => {
    const xs = [10, 10, 10, 10, 10, 10, 10, 10, 10, 1000]
    const results = detectZScoreOutliers(xs, 2.0)
    expect(results[results.length - 1]!.isAnomaly).toBe(true)
    expect(results.slice(0, -1).every(r => !r.isAnomaly)).toBe(true)
  })

  it('returns all non-anomalies when stddev is zero', () => {
    const results = detectZScoreOutliers([5, 5, 5, 5])
    expect(results.every(r => !r.isAnomaly)).toBe(true)
  })
})

describe('anomaly.detectIqrOutliers', () => {
  it('flags values outside [Q1 − k·IQR, Q3 + k·IQR]', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]
    const results = detectIqrOutliers(xs, 1.5)
    expect(results[results.length - 1]!.isAnomaly).toBe(true)
  })

  it('returns non-anomalies when input is too small', () => {
    const results = detectIqrOutliers([1, 2, 3])
    expect(results.every(r => !r.isAnomaly)).toBe(true)
  })
})

describe('anomaly.detectModifiedZScoreOutliers', () => {
  it('flags outliers using MAD', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000]
    const results = detectModifiedZScoreOutliers(xs, 3.5)
    expect(results[results.length - 1]!.isAnomaly).toBe(true)
  })

  it('is robust against a corrupted mean', () => {
    // With a large outlier, classic z-score's mean and stddev are both
    // inflated. Modified z-score (median + MAD) stays anchored to the
    // bulk of the data and still flags the outlier.
    const xs = [9, 10, 11, 9, 10, 11, 9, 10, 11, 1000]
    const modz = detectModifiedZScoreOutliers(xs)
    expect(modz[modz.length - 1]!.isAnomaly).toBe(true)
  })
})
