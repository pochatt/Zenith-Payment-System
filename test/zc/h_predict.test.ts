import { describe, it, expect } from 'vitest'
import { ema, recommendHLimitEMA, recommendHLimitRobust } from '../../src/zc/h_predict'

describe('h_predict.ema', () => {
  it('returns 0 for empty input', () => {
    expect(ema([], 0.3)).toBe(0)
  })

  it('returns first value when only one is present', () => {
    expect(ema([100], 0.3)).toBe(100)
  })

  it('weights recent values more heavily for larger alpha', () => {
    const series = [10, 10, 10, 100]
    const slow = ema(series, 0.1)
    const fast = ema(series, 0.9)
    expect(fast).toBeGreaterThan(slow)
    expect(fast).toBeLessThanOrEqual(100)
    expect(slow).toBeGreaterThanOrEqual(10)
  })
})

describe('h_predict.recommendHLimitEMA', () => {
  it('only counts negative (outgoing) net positions', () => {
    // Bank is a net receiver every day → recommended H = 0
    const rec = recommendHLimitEMA('001', [100, 200, 150, 300])
    expect(rec.recommended_h_limit).toBe(0)
    expect(rec.method).toBe('ema')
  })

  it('recommends a positive H for a regular net payer', () => {
    const rec = recommendHLimitEMA('002', [-100, -120, -90, -110, -105])
    expect(rec.recommended_h_limit).toBeGreaterThan(100)
    expect(rec.ema).toBeGreaterThan(90)
  })

  it('honours overrides for alpha and kSigma', () => {
    const tight = recommendHLimitEMA('003', [-100, -100, -100], { kSigma: 0 })
    const loose = recommendHLimitEMA('003', [-100, -100, -100], { kSigma: 5 })
    expect(loose.recommended_h_limit).toBeGreaterThanOrEqual(tight.recommended_h_limit)
  })
})

describe('h_predict.recommendHLimitRobust', () => {
  it('ignores extreme outliers compared to EMA', () => {
    const history = [-100, -100, -100, -100, -100, -100, -100, -100, -100, -10000]
    const emaRec = recommendHLimitEMA('004', history)
    const robustRec = recommendHLimitRobust('004', history)
    expect(robustRec.recommended_h_limit).toBeLessThan(emaRec.recommended_h_limit)
  })

  it('returns 0 for an empty history', () => {
    const rec = recommendHLimitRobust('005', [])
    expect(rec.recommended_h_limit).toBe(0)
  })
})
