/**
 * @file limit_do.ts — TigerBeetle-style Durable Object for H-Limit Management
 * 
 * Provides strict single-threaded execution for limit increments to bypass
 * the D1 SQLite transactional limits and lock contention. 
 */
import type { Env } from '../types'

export class LimitDO {
  private h_limit: number = 1000000000 // default 1 billion simulated limit
  private h_reserved: number = 0
  private state: DurableObjectState

  constructor(state: DurableObjectState, private env: Env) {
    this.state = state
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<{ limit: number, reserved: number }>('h_state')
      if (stored) {
        this.h_limit = stored.limit
        this.h_reserved = stored.reserved
      }
    })
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    
    // Express / Standard Lane H-Reservation endpoint
    if (url.pathname === '/reserve' && req.method === 'POST') {
      const body = await req.json<{ amount: number }>()
      if (typeof body.amount !== 'number') return new Response("Bad request", { status: 400 })

      if (this.h_limit - this.h_reserved >= body.amount) {
        this.h_reserved += body.amount
        await this.state.storage.put('h_state', { limit: this.h_limit, reserved: this.h_reserved })
        return Response.json({ success: true, reservation_id: `H-DO-RES-${Date.now()}-${Math.floor(Math.random()*1000)}` })
      }
      return Response.json({ success: false, reason: 'H_LIMIT_EXCEEDED' })
    }

    // Release previously reserved H
    if (url.pathname === '/release' && req.method === 'POST') {
      const body = await req.json<{ amount: number }>()
      if (typeof body.amount !== 'number') return new Response("Bad request", { status: 400 })

      this.h_reserved = Math.max(0, this.h_reserved - body.amount)
      await this.state.storage.put('h_state', { limit: this.h_limit, reserved: this.h_reserved })
      return Response.json({ success: true })
    }

    return new Response("Not found in LimitDO", { status: 404 })
  }
}
