import { describe, it, expect } from 'vitest'
import {
  makeGraph, addEdge, findCycle, topologicalSort, stronglyConnectedComponents,
} from '../../src/shared/graph'

describe('graph.findCycle', () => {
  it('returns null for a DAG', () => {
    const g = makeGraph()
    addEdge(g, 'A', 'B')
    addEdge(g, 'B', 'C')
    addEdge(g, 'A', 'C')
    expect(findCycle(g)).toBe(null)
  })

  it('returns null for an empty graph', () => {
    expect(findCycle(makeGraph())).toBe(null)
  })

  it('detects a simple 3-node cycle', () => {
    const g = makeGraph()
    addEdge(g, 'A', 'B')
    addEdge(g, 'B', 'C')
    addEdge(g, 'C', 'A')
    const cycle = findCycle(g)
    expect(cycle).not.toBe(null)
    expect(cycle!.length).toBeGreaterThanOrEqual(3)
    expect(cycle![0]).toBe(cycle![cycle!.length - 1])
  })

  it('detects a self-loop', () => {
    const g = makeGraph()
    addEdge(g, 'A', 'A')
    const cycle = findCycle(g)
    expect(cycle).not.toBe(null)
  })
})

describe('graph.topologicalSort', () => {
  it('returns a valid order for a DAG', () => {
    const g = makeGraph()
    addEdge(g, 'A', 'B')
    addEdge(g, 'B', 'C')
    addEdge(g, 'A', 'C')
    const order = topologicalSort(g)
    expect(order).not.toBe(null)
    expect(order!.indexOf('A')).toBeLessThan(order!.indexOf('B'))
    expect(order!.indexOf('B')).toBeLessThan(order!.indexOf('C'))
  })

  it('returns null when a cycle exists', () => {
    const g = makeGraph()
    addEdge(g, 'A', 'B')
    addEdge(g, 'B', 'A')
    expect(topologicalSort(g)).toBe(null)
  })
})

describe('graph.stronglyConnectedComponents', () => {
  it('returns singletons for a DAG', () => {
    const g = makeGraph()
    addEdge(g, 'A', 'B')
    addEdge(g, 'B', 'C')
    const sccs = stronglyConnectedComponents(g)
    expect(sccs).toHaveLength(3)
    expect(sccs.every(c => c.length === 1)).toBe(true)
  })

  it('groups nodes of a cycle into one SCC', () => {
    const g = makeGraph()
    addEdge(g, 'A', 'B')
    addEdge(g, 'B', 'C')
    addEdge(g, 'C', 'A')
    addEdge(g, 'C', 'D')
    const sccs = stronglyConnectedComponents(g)
    const big = sccs.find(c => c.length > 1)
    expect(big).toBeDefined()
    expect(big!.sort()).toEqual(['A', 'B', 'C'])
  })
})
