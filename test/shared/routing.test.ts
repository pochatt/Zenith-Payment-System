import { describe, it, expect } from 'vitest'
import { findCorrespondentPath, type CorrespondentEdge } from '../../src/shared/routing'

describe('routing.findCorrespondentPath', () => {
  it('returns null when source or target is unknown', () => {
    const edges: CorrespondentEdge[] = [{ from: 'A', to: 'B', fee: 10, latency: 1 }]
    expect(findCorrespondentPath(edges, 'X', 'B')).toBe(null)
    expect(findCorrespondentPath(edges, 'A', 'X')).toBe(null)
  })

  it('finds the direct edge for a 2-node graph', () => {
    const edges: CorrespondentEdge[] = [{ from: 'A', to: 'B', fee: 10, latency: 1 }]
    const result = findCorrespondentPath(edges, 'A', 'B')
    expect(result).toEqual({ path: ['A', 'B'], totalFee: 10, totalLatency: 1, cost: 11 })
  })

  it('prefers a cheaper indirect path over a more expensive direct edge', () => {
    const edges: CorrespondentEdge[] = [
      { from: 'A', to: 'B', fee: 100, latency: 1 },
      { from: 'A', to: 'C', fee: 10, latency: 1 },
      { from: 'C', to: 'B', fee: 10, latency: 1 },
    ]
    const result = findCorrespondentPath(edges, 'A', 'B')
    expect(result!.path).toEqual(['A', 'C', 'B'])
    expect(result!.totalFee).toBe(20)
  })

  it('weights latency vs fee per caller preference', () => {
    const edges: CorrespondentEdge[] = [
      { from: 'A', to: 'B', fee: 100, latency: 1 },
      { from: 'A', to: 'C', fee: 1, latency: 100 },
      { from: 'C', to: 'B', fee: 1, latency: 100 },
    ]
    // Latency-sensitive caller picks the direct expensive edge.
    const latencyFirst = findCorrespondentPath(edges, 'A', 'B', { fee: 0, latency: 1 })
    expect(latencyFirst!.path).toEqual(['A', 'B'])

    // Fee-sensitive caller picks the cheap indirect route.
    const feeFirst = findCorrespondentPath(edges, 'A', 'B', { fee: 1, latency: 0 })
    expect(feeFirst!.path).toEqual(['A', 'C', 'B'])
  })

  it('returns null when target is unreachable', () => {
    const edges: CorrespondentEdge[] = [
      { from: 'A', to: 'B', fee: 1, latency: 1 },
      { from: 'C', to: 'D', fee: 1, latency: 1 },
    ]
    expect(findCorrespondentPath(edges, 'A', 'D')).toBe(null)
  })
})
