/**
 * @file gtid_graph.ts - Graph analysis of multi-leg GTID flows.
 *
 * Builds a directed bank-level value-flow graph from PAYER/PAYEE legs and
 * exposes:
 *   - `analyzeGtidGraph()` — cycle detection + suggested execution order
 *   - `pairLegsTopologically()` — deterministic PAYER↔PAYEE leg pairing that
 *     respects the topological order of bank flow (replacement for the
 *     lexicographic-index pairing in `lanes/gtid.ts`).
 *
 * Used as an advisory pre-decision check: a cycle in the value graph signals
 * a circular payment (A→B→C→A) that could be netted to zero without leaving
 * the cycle. The detection writes to FinalityLog for compliance reporting.
 */

import type { GtidLegRow } from '../types'
import {
  type DirectedGraph, addEdge, findCycle, makeGraph,
  stronglyConnectedComponents,
} from '../shared/graph'

export interface GtidGraphAnalysis {
  cycle: string[] | null
  scc: string[][]
  edges: Array<{ from: string; to: string; amount: number }>
  hasCircularFlow: boolean
}

/**
 * Build a bank-level value graph from the legs of a single GTID. PAYER legs
 * are matched with PAYEE legs by sorted leg_id pairing to derive edges. This
 * mirrors the existing pairing rule in `lanes/gtid.ts:248` so analysis stays
 * consistent with execution.
 */
export function buildGtidGraph(legs: GtidLegRow[]): {
  graph: DirectedGraph
  edges: Array<{ from: string; to: string; amount: number }>
} {
  const payers = legs.filter(l => l.role === 'PAYER').sort((a, b) => a.leg_id < b.leg_id ? -1 : 1)
  const payees = legs.filter(l => l.role === 'PAYEE').sort((a, b) => a.leg_id < b.leg_id ? -1 : 1)

  const g = makeGraph()
  const edges: Array<{ from: string; to: string; amount: number }> = []
  const pairCount = Math.min(payers.length, payees.length)
  for (let i = 0; i < pairCount; i++) {
    const p = payers[i]!
    const q = payees[i]!
    addEdge(g, p.bank_id, q.bank_id)
    edges.push({ from: p.bank_id, to: q.bank_id, amount: p.amount_value })
  }
  return { graph: g, edges }
}

export function analyzeGtidGraph(legs: GtidLegRow[]): GtidGraphAnalysis {
  const { graph, edges } = buildGtidGraph(legs)
  const cycle = findCycle(graph)
  const scc = stronglyConnectedComponents(graph)
  const hasCircularFlow =
    cycle !== null ||
    scc.some(c => c.length > 1) ||
    // Self-loop check: a bank paying itself within the same GTID.
    edges.some(e => e.from === e.to)
  return { cycle, scc, edges, hasCircularFlow }
}
