/**
 * @file anomaly.ts - Statistical outlier detection for transaction streams.
 *
 * Three independent detectors are exposed:
 *   - z-score:      classic mean/stddev; flags |z| > threshold (default 3.0)
 *   - IQR:          robust to outliers; flags points outside [Q1 - k·IQR, Q3 + k·IQR]
 *   - modified-z:   median + MAD; robust + symmetric; default threshold 3.5
 *
 * All detectors run in a single pass where possible. Stable computations use
 * Welford's online algorithm so accumulated error stays O(ε·n) rather than
 * the O(ε·n²) of naive sum-of-squares.
 *
 * Designed for advisory use by orchestrator hooks and reporting. Not on the
 * critical path of settlement.
 */

export interface ZScoreStats {
  mean: number
  stddev: number
  n: number
}

export interface AnomalyResult<T> {
  value: T
  score: number
  isAnomaly: boolean
}

/**
 * Welford's online mean/variance — single pass, numerically stable.
 * Returns sample stddev (divides by n − 1 when n ≥ 2).
 */
export function welford(values: number[]): ZScoreStats {
  let n = 0
  let mean = 0
  let m2 = 0
  for (const x of values) {
    n++
    const delta = x - mean
    mean += delta / n
    const delta2 = x - mean
    m2 += delta * delta2
  }
  const stddev = n >= 2 ? Math.sqrt(m2 / (n - 1)) : 0
  return { mean, stddev, n }
}

/**
 * Flag values whose z-score exceeds `threshold` standard deviations from the
 * mean. Returns one result per input value with `score = z`.
 */
export function detectZScoreOutliers(
  values: number[],
  threshold = 3.0,
): Array<AnomalyResult<number>> {
  const { mean, stddev } = welford(values)
  if (stddev === 0) {
    return values.map(v => ({ value: v, score: 0, isAnomaly: false }))
  }
  return values.map(v => {
    const score = (v - mean) / stddev
    return { value: v, score, isAnomaly: Math.abs(score) > threshold }
  })
}

/**
 * Linear-interpolation quantile (matches numpy's default). `q` ∈ [0, 1].
 * Sorts a copy of the input; caller's array is unchanged.
 */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  const w = pos - lo
  return sorted[lo]! * (1 - w) + sorted[hi]! * w
}

/**
 * Tukey's IQR rule. Default `k = 1.5` flags "mild" outliers; `k = 3.0` flags
 * "extreme" outliers. The `score` returned is the distance beyond the fence
 * expressed in IQR units (positive above, negative below, 0 inside).
 */
export function detectIqrOutliers(
  values: number[],
  k = 1.5,
): Array<AnomalyResult<number>> {
  if (values.length < 4) {
    return values.map(v => ({ value: v, score: 0, isAnomaly: false }))
  }
  const q1 = quantile(values, 0.25)
  const q3 = quantile(values, 0.75)
  const iqr = q3 - q1
  if (iqr === 0) {
    return values.map(v => ({ value: v, score: 0, isAnomaly: false }))
  }
  const lower = q1 - k * iqr
  const upper = q3 + k * iqr
  return values.map(v => {
    let score = 0
    if (v > upper) score = (v - upper) / iqr
    else if (v < lower) score = (v - lower) / iqr
    return { value: v, score, isAnomaly: v < lower || v > upper }
  })
}

/**
 * Modified z-score using median and MAD (Median Absolute Deviation).
 * More robust than the mean-based z-score under contamination; the standard
 * 1.4826 scaling makes σ̂ consistent with stddev for normal data.
 *
 * Iglewicz & Hoaglin recommend threshold 3.5.
 */
export function detectModifiedZScoreOutliers(
  values: number[],
  threshold = 3.5,
): Array<AnomalyResult<number>> {
  if (values.length === 0) return []
  const median = quantile(values, 0.5)
  const deviations = values.map(v => Math.abs(v - median))
  const mad = quantile(deviations, 0.5)
  if (mad === 0) {
    return values.map(v => ({ value: v, score: 0, isAnomaly: false }))
  }
  const scale = 1.4826 * mad
  return values.map(v => {
    const score = (v - median) / scale
    return { value: v, score, isAnomaly: Math.abs(score) > threshold }
  })
}
