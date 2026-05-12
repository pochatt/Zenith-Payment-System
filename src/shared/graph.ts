/**
 * @file graph.ts - Directed-graph primitives.
 *
 * Provides:
 *   - cycle detection via three-colour DFS (returns the cycle path if any)
 *   - topological sort via Kahn's algorithm (returns null if not a DAG)
 *   - strongly-connected components via Tarjan's algorithm
 *
 * Used by:
 *   - `zc/gtid_graph.ts`  → analyse multi-leg GTID flows for circular payments
 *   - future routing extensions that build a directed cost graph
 *
 * Adjacency is represented as `Map<NodeId, NodeId[]>`. Edge weights, when
 * needed, are stored separately by the caller.
 */

export type NodeId = string

export interface DirectedGraph {
  nodes: Set<NodeId>
  adj: Map<NodeId, NodeId[]>
}

export function makeGraph(): DirectedGraph {
  return { nodes: new Set(), adj: new Map() }
}

export function addEdge(g: DirectedGraph, from: NodeId, to: NodeId): void {
  g.nodes.add(from)
  g.nodes.add(to)
  const list = g.adj.get(from)
  if (list) list.push(to)
  else g.adj.set(from, [to])
}

/**
 * Find one cycle if any exists. Returns the cycle path as a list of nodes
 * `[v0, v1, ..., vk, v0]` (start node appears twice). Returns `null` for a DAG.
 *
 * Uses three-colour DFS: white = unvisited, grey = on current stack, black = done.
 * A back edge to a grey node signals a cycle; we reconstruct the path from
 * the parent map.
 */
export function findCycle(g: DirectedGraph): NodeId[] | null {
  const WHITE = 0, GREY = 1, BLACK = 2
  const colour = new Map<NodeId, number>()
  const parent = new Map<NodeId, NodeId | null>()
  for (const n of g.nodes) colour.set(n, WHITE)

  let cycle: NodeId[] | null = null

  const visit = (start: NodeId): void => {
    const stack: Array<{ node: NodeId; idx: number }> = [{ node: start, idx: 0 }]
    colour.set(start, GREY)
    parent.set(start, null)

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const neighbours = g.adj.get(top.node) ?? []
      if (top.idx >= neighbours.length) {
        colour.set(top.node, BLACK)
        stack.pop()
        continue
      }
      const next = neighbours[top.idx]!
      top.idx++
      const c = colour.get(next) ?? WHITE
      if (c === WHITE) {
        colour.set(next, GREY)
        parent.set(next, top.node)
        stack.push({ node: next, idx: 0 })
      } else if (c === GREY) {
        // Back edge: reconstruct cycle from top.node up to `next`.
        const path: NodeId[] = [next]
        let cur: NodeId | null = top.node
        while (cur !== null && cur !== next) {
          path.push(cur)
          cur = parent.get(cur) ?? null
        }
        path.push(next)
        cycle = path.reverse()
        return
      }
    }
  }

  for (const n of g.nodes) {
    if ((colour.get(n) ?? WHITE) === WHITE) {
      visit(n)
      if (cycle) return cycle
    }
  }
  return null
}

/**
 * Kahn's algorithm. Returns a topological ordering or `null` if the graph
 * contains a cycle. Ties broken by insertion order into the zero-indegree queue.
 */
export function topologicalSort(g: DirectedGraph): NodeId[] | null {
  const indeg = new Map<NodeId, number>()
  for (const n of g.nodes) indeg.set(n, 0)
  for (const list of g.adj.values()) {
    for (const v of list) indeg.set(v, (indeg.get(v) ?? 0) + 1)
  }

  const queue: NodeId[] = []
  for (const [n, d] of indeg) if (d === 0) queue.push(n)

  const order: NodeId[] = []
  while (queue.length > 0) {
    const n = queue.shift()!
    order.push(n)
    for (const v of g.adj.get(n) ?? []) {
      const d = (indeg.get(v) ?? 0) - 1
      indeg.set(v, d)
      if (d === 0) queue.push(v)
    }
  }
  return order.length === g.nodes.size ? order : null
}

/**
 * Tarjan's SCC algorithm. Returns components in reverse topological order.
 * A component of size > 1 (or a size-1 component with a self-loop) indicates
 * a cycle.
 */
export function stronglyConnectedComponents(g: DirectedGraph): NodeId[][] {
  let index = 0
  const indices = new Map<NodeId, number>()
  const lowlink = new Map<NodeId, number>()
  const onStack = new Set<NodeId>()
  const stack: NodeId[] = []
  const result: NodeId[][] = []

  const strongconnect = (v: NodeId): void => {
    indices.set(v, index)
    lowlink.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)

    for (const w of g.adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: NodeId[] = []
      while (true) {
        const w = stack.pop()!
        onStack.delete(w)
        component.push(w)
        if (w === v) break
      }
      result.push(component)
    }
  }

  for (const n of g.nodes) {
    if (!indices.has(n)) strongconnect(n)
  }
  return result
}
