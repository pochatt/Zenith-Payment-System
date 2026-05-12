/**
 * @file h_predict.ts - H-limit prediction using EMA and robust statistics.
 *
 * Given a per-bank history of DNS net positions, estimate the H-reserve that
 * each bank should pre-fund so that DNS settles without BOJ shortfalls
 * (the case currently handled by `dns.ts:155` setting HOLD_ACTIVE).
 *
 * Two estimators are exposed:
 *
 *   1. EMA + stddev → recommended_h = max(0, |EMA| + k·σ)
 *      Fast-reacting; weights recent days more. Default α = 0.3, k = 2.0
 *      (covers ~97.7% of a normal distribution).
 *
 *   2. Robust quantile → recommended_h = max(0, |median| + q95 of deviation)
 *      Insensitive to outliers (e.g. month-end spikes). Use when history is
 *      contaminated.
 *
 * Pure functions over numeric arrays — no DB access. Wired in by callers that
 * read history from `DnsNetPositions` / `FinalityLog`.
 */

import { quantile, welford } from '../shared/anomaly'

export interface HLimitRecommendation {
  bank_id: string
  history_size: number
  ema: number
  stddev: number
  recommended_h_limit: number
  method: 'ema' | 'robust'
}

/**
 * Exponential moving average. α ∈ (0, 1]; higher α weights recent values more.
 * Standard for short-window forecasting in payment systems where the latest
 * regime change matters more than long-term mean.
 */
export function ema(values: number[], alpha: number): number {
  if (values.length === 0) return 0
  let s = values[0]!
  for (let i = 1; i < values.length; i++) {
    s = alpha * values[i]! + (1 - alpha) * s
  }
  return s
}

/**
 * EMA-based H-limit recommendation.
 *
 * The bank's outgoing net (positive number representing |negative net
 * position|) is smoothed via EMA, then padded by k standard deviations to
 * cover normal volatility. Cycles where the bank is a net receiver
 * contribute 0 to the outgoing-net series.
 */
export function recommendHLimitEMA(
  bankId: string,
  netPositionHistory: number[],
  options: { alpha?: number; kSigma?: number } = {},
): HLimitRecommendation {
  const alpha = options.alpha ?? 0.3
  const kSigma = options.kSigma ?? 2.0

  // Convert to "outgoing net" series: only payer-net days contribute.
  const outgoing = netPositionHistory.map(n => (n < 0 ? -n : 0))
  const emaValue = ema(outgoing, alpha)
  const { stddev } = welford(outgoing)
  const recommended = Math.max(0, emaValue + kSigma * stddev)
  return {
    bank_id: bankId,
    history_size: netPositionHistory.length,
    ema: emaValue,
    stddev,
    recommended_h_limit: Math.ceil(recommended),
    method: 'ema',
  }
}

/**
 * Robust quantile-based recommendation. Uses the 95th percentile of the
 * outgoing-net series — `recommended_h ≈ p95` covers 19 out of 20 cycles
 * without exposure to mean-pulling outliers (month-end, year-end spikes).
 */
export function recommendHLimitRobust(
  bankId: string,
  netPositionHistory: number[],
  options: { percentile?: number; safetyMargin?: number } = {},
): HLimitRecommendation {
  const percentile = options.percentile ?? 0.95
  const safetyMargin = options.safetyMargin ?? 1.1

  const outgoing = netPositionHistory.map(n => (n < 0 ? -n : 0))
  const median = outgoing.length > 0 ? quantile(outgoing, 0.5) : 0
  const tail = outgoing.length > 0 ? quantile(outgoing, percentile) : 0
  const recommended = Math.max(0, tail * safetyMargin)
  return {
    bank_id: bankId,
    history_size: netPositionHistory.length,
    ema: median,
    stddev: 0,
    recommended_h_limit: Math.ceil(recommended),
    method: 'robust',
  }
}
