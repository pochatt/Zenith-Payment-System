/**
 * @file Server-Sent Events (SSE) for real-time bank notifications. Delivers
 *       tx_state_change, credit_notification, rtp_request events.
 * @module zc/stream
 */

import type { EventStreamRow, StreamEventType } from '../types'
import { nowISO } from '../types'

// ---------------------------------------------------------------------------
// イベント発行
// ---------------------------------------------------------------------------

/**
 * EventStream テーブルへイベントを INSERT し event_id を返す。
 *
 * @param db           - D1 データベース
 * @param targetBankId - 配信先銀行ID
 * @param eventType    - イベント種別
 * @param payload      - ペイロードオブジェクト（JSON シリアライズされる）
 * @returns event_id (UUID)
 */
export async function publishEvent(
  db: D1Database,
  targetBankId: string,
  eventType: StreamEventType,
  payload: object,
): Promise<string> {
  const eventId = crypto.randomUUID()
  const now = nowISO()

  await db.prepare(`
    INSERT INTO EventStream
      (event_id, target_bank_id, event_type, payload_json, is_delivered, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).bind(eventId, targetBankId, eventType, JSON.stringify(payload), now).run()

  return eventId
}

// ---------------------------------------------------------------------------
// 未配信イベント取得
// ---------------------------------------------------------------------------

/**
 * 未配信イベントをポーリング用に取得する。
 * afterEventId が指定された場合、そのイベント以降（created_at 昇順）の未配信を返す。
 *
 * @param db           - D1 データベース
 * @param targetBankId - 配信先銀行ID
 * @param afterEventId - このイベントID以降を取得（オプション）
 * @returns EventStreamRow[]
 */
export async function getPendingEvents(
  db: D1Database,
  targetBankId: string,
  afterEventId?: string,
): Promise<EventStreamRow[]> {
  if (afterEventId) {
    // afterEventId の created_at を取得してカーソルとして使う
    const cursor = await db.prepare(`
      SELECT created_at FROM EventStream WHERE event_id = ?
    `).bind(afterEventId).first<{ created_at: string }>()

    if (cursor) {
      const { results } = await db.prepare(`
        SELECT * FROM EventStream
        WHERE target_bank_id = ? AND is_delivered = 0 AND created_at > ?
        ORDER BY created_at ASC
        LIMIT 100
      `).bind(targetBankId, cursor.created_at).all<EventStreamRow>()
      return results ?? []
    }
  }

  const { results } = await db.prepare(`
    SELECT * FROM EventStream
    WHERE target_bank_id = ? AND is_delivered = 0
    ORDER BY created_at ASC
    LIMIT 100
  `).bind(targetBankId).all<EventStreamRow>()

  return results ?? []
}

// ---------------------------------------------------------------------------
// イベント配信済みマーク（単一）
// ---------------------------------------------------------------------------

/**
 * 単一イベントを配信済みにする。
 *
 * @param db      - D1 データベース
 * @param eventId - イベントID
 */
export async function markEventDelivered(db: D1Database, eventId: string): Promise<void> {
  await db.prepare(`
    UPDATE EventStream SET is_delivered = 1 WHERE event_id = ?
  `).bind(eventId).run()
}

// ---------------------------------------------------------------------------
// イベント配信済みマーク（バッチ）
// ---------------------------------------------------------------------------

/**
 * 複数イベントを一括で配信済みにする。
 * D1 の batch API を使用して 1 ラウンドトリップで完結させる。
 *
 * @param db       - D1 データベース
 * @param eventIds - イベントIDの配列
 */
export async function markEventsDelivered(db: D1Database, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return

  // D1 は パラメータ展開でIN句が使えないため batch で処理
  const stmts = eventIds.map(id =>
    db.prepare(`UPDATE EventStream SET is_delivered = 1 WHERE event_id = ?`).bind(id),
  )
  await db.batch(stmts)
}

// ---------------------------------------------------------------------------
// SSE Response 生成
// ---------------------------------------------------------------------------

/**
 * Cloudflare Workers ReadableStream を使って SSE レスポンスを生成する。
 *
 * 動作:
 * 1. ReadableStream を生成
 * 2. getPendingEvents を 2 秒ごとにポーリング
 * 3. 各イベントを SSE フォーマット (`data: {...}\n\n`) でエンキュー
 * 4. 送信後に配信済みマーク
 *
 * @param db           - D1 データベース
 * @param targetBankId - 配信先銀行ID
 * @returns SSE レスポンス
 */
export function createSseResponse(db: D1Database, targetBankId: string): Response {
  let lastEventId: string | undefined

  const stream = new ReadableStream({
    async start(controller) {
      // 初回接続通知
      const connectMsg = `data: ${JSON.stringify({ type: 'CONNECTED', bank_id: targetBankId })}\n\n`
      controller.enqueue(new TextEncoder().encode(connectMsg))

      // ポーリングループ（2 秒間隔）
      const poll = async () => {
        try {
          const events = await getPendingEvents(db, targetBankId, lastEventId)

          if (events.length > 0) {
            for (const ev of events) {
              const sseData = formatSseEvent(ev)
              controller.enqueue(new TextEncoder().encode(sseData))
              lastEventId = ev.event_id
            }

            // 配信済みマーク
            await markEventsDelivered(db, events.map(e => e.event_id))
          }
        } catch (err) {
          console.error('[stream] SSE poll error:', err)
          // エラーをクライアントへ通知してもストリームは継続
          const errMsg = `data: ${JSON.stringify({ type: 'ERROR', message: 'poll failed' })}\n\n`
          try {
            controller.enqueue(new TextEncoder().encode(errMsg))
          } catch {
            // コントローラが既にクローズされている場合は無視
          }
        }
      }

      // 2 秒ごとのポーリング（Workers のイベントループ内で動作）
      // Cloudflare Workers では setInterval が使用可能
      const timer = setInterval(poll, 2000)

      // ストリームが閉じられたらタイマーを停止
      // cancel は ReadableStreamController では直接コールバックを持たないため、
      // Workers の接続切断時に自動的にガベージコレクトされる
      void timer
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

// ---------------------------------------------------------------------------
// 古い配信済みイベント削除
// ---------------------------------------------------------------------------

/**
 * 24 時間以上経過した配信済みイベントを削除する（cron 用）。
 *
 * @param db - D1 データベース
 * @returns 削除件数
 */
export async function pruneDeliveredEvents(db: D1Database): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const result = await db.prepare(`
    DELETE FROM EventStream
    WHERE is_delivered = 1 AND created_at < ?
  `).bind(cutoff).run()

  return result.meta.changes ?? 0
}

// ---------------------------------------------------------------------------
// 内部ユーティリティ
// ---------------------------------------------------------------------------

/**
 * EventStreamRow を SSE フォーマット文字列に変換する。
 *
 * @param ev - イベント行
 * @returns SSE フォーマット文字列 (`id: ...\ndata: ...\n\n`)
 */
function formatSseEvent(ev: EventStreamRow): string {
  let payload: object
  try {
    payload = JSON.parse(ev.payload_json) as object
  } catch {
    payload = { raw: ev.payload_json }
  }

  const data = JSON.stringify({
    event_id: ev.event_id,
    event_type: ev.event_type,
    created_at: ev.created_at,
    ...payload,
  })

  return `id: ${ev.event_id}\ndata: ${data}\n\n`
}
