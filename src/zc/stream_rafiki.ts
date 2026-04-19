/**
 * @file stream_rafiki.ts — Rafiki-Style WebSocket Micro-payment Stream DO
 * 
 * Aggregates high-frequency micro-payments via WebSockets into a Durable Object,
 * bypassing D1 execution limits by batch-committing via DO alarms.
 */
import type { Env } from '../types'
import { newUUID } from '../shared/idempotency'
import { writeFinalityLog } from './orchestrator'
import { nowISO } from '../types'

export class StreamDO {
  private accumulated_amount: number = 0
  private gtid: string | null = null
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<{ amt: number, gtid: string }>('stream_state')
      if (stored) {
        this.accumulated_amount = stored.amt
        this.gtid = stored.gtid
      }
    })
  }

  async fetch(req: Request): Promise<Response> {
    const upgradeHeader = req.headers.get('Upgrade')
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 })
    }

    const webSocketPair = new WebSocketPair()
    const client = (Object.values(webSocketPair)[0] as any)
    const server = (Object.values(webSocketPair)[1] as any)
    
    // Accept the WebSocket connection
    this.state.acceptWebSocket(server)

    // Await messages on the server side
    server.addEventListener('message', async (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'START') {
          this.gtid = msg.gtid || newUUID()
          // Set alarm to flush to D1 every 10 seconds
          await this.state.storage.setAlarm(Date.now() + 10000)
          server.send(JSON.stringify({ type: 'STARTED', gtid: this.gtid }))
        } else if (msg.type === 'PACKET' && typeof msg.amount === 'number') {
          this.accumulated_amount += msg.amount
          await this.state.storage.put('stream_state', { amt: this.accumulated_amount, gtid: this.gtid })
          server.send(JSON.stringify({ type: 'ACK', current: this.accumulated_amount }))
        }
      } catch (e) {
        console.error('[StreamDO] Error parsing ws message', e)
        server.send(JSON.stringify({ type: 'ERROR' }))
      }
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  async alarm() {
    if (this.accumulated_amount > 0 && this.gtid) {
      console.log(`[StreamDO] Flushing accumulated ${this.accumulated_amount} for ${this.gtid}`)
      
      try {
        // Here we simulate writing the batched result to D1 Finality Log (a/b execution)
        const db = this.env.DB
        if (db) {
           await writeFinalityLog(db, {
             txid: this.gtid, 
             event_type: 'StreamingBatchFlush', 
             state_from: 'STREAMING', 
             state_to: 'STREAMING',
             payload_json: JSON.stringify({ flushed_amount: this.accumulated_amount }), 
             txid_or_gtid: this.gtid,
           })
        }
      } catch(e) {
        console.error('[StreamDO] Flush failed', e)
      }
      
      // Reset after flush
      this.accumulated_amount = 0
      await this.state.storage.put('stream_state', { amt: 0, gtid: this.gtid })
    }
    
    // Look for active connections, if none, stop alarm. If active, reschedule.
    // For this mock, we'll unconditionally stop unless a packet re-triggers it.
    // In production, check state.getWebSockets()
  }
}
