/**
 * @file Server-Sent Events (SSE) for real-time bank notifications. Delivers
 *       tx_state_change, credit_notification, rtp_request events.
 * @module zc/stream
 */

import type { EventStreamRow, StreamEventType } from "../types";
import { nowISO } from "../types";

// ---------------------------------------------------------------------------
// Emit event
// ---------------------------------------------------------------------------

/**
 * EventStream tableへeventを INSERT し event_id をreturn。
 *
 * @param db           - D1 データベース
 * @param targetBankId - 配信先bank ID
 * @param eventType    - event種別
 * @param payload      - ペイロードオブジェクト（JSON シリアライズされる）
 * @returns event_id (UUID)
 */
export async function publishEvent(
  db: D1Database,
  targetBankId: string,
  eventType: StreamEventType,
  payload: object
): Promise<string> {
  const eventId = crypto.randomUUID();
  const now = nowISO();

  await db
    .prepare(`
    INSERT INTO EventStream
      (event_id, target_bank_id, event_type, payload_json, is_delivered, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `)
    .bind(eventId, targetBankId, eventType, JSON.stringify(payload), now)
    .run();

  return eventId;
}

// ---------------------------------------------------------------------------
// Get undelivered events
// ---------------------------------------------------------------------------

/**
 * 未配信eventをポーリング用にgetする。
 * afterEventId が指定された場合、そのevent以降（created_at 昇順）の未配信をreturn。
 *
 * @param db           - D1 データベース
 * @param targetBankId - 配信先bank ID
 * @param afterEventId - このeventID以降をget（オプション）
 * @returns EventStreamRow[]
 */
export async function getPendingEvents(
  db: D1Database,
  targetBankId: string,
  afterEventId?: string
): Promise<EventStreamRow[]> {
  if (afterEventId) {
    // afterEventId の created_at をgetしてカーソルとして使う
    const cursor = await db
      .prepare(`
      SELECT created_at FROM EventStream WHERE event_id = ?
    `)
      .bind(afterEventId)
      .first<{ created_at: string }>();

    if (cursor) {
      const { results } = await db
        .prepare(`
        SELECT * FROM EventStream
        WHERE target_bank_id = ? AND is_delivered = 0 AND created_at > ?
        ORDER BY created_at ASC
        LIMIT 100
      `)
        .bind(targetBankId, cursor.created_at)
        .all<EventStreamRow>();
      return results ?? [];
    }
  }

  const { results } = await db
    .prepare(`
    SELECT * FROM EventStream
    WHERE target_bank_id = ? AND is_delivered = 0
    ORDER BY created_at ASC
    LIMIT 100
  `)
    .bind(targetBankId)
    .all<EventStreamRow>();

  return results ?? [];
}

// ---------------------------------------------------------------------------
// Mark event delivered (single)
// ---------------------------------------------------------------------------

/**
 * 単一eventを配信済みにする。
 *
 * @param db      - D1 データベース
 * @param eventId - eventID
 */
export async function markEventDelivered(db: D1Database, eventId: string): Promise<void> {
  await db
    .prepare(`
    UPDATE EventStream SET is_delivered = 1 WHERE event_id = ?
  `)
    .bind(eventId)
    .run();
}

// ---------------------------------------------------------------------------
// Mark event delivered (batch)
// ---------------------------------------------------------------------------

/**
 * 複数eventを一括で配信済みにする。
 * D1 の batch API を使用して 1 ラウンドトリップで完結させる。
 *
 * @param db       - D1 データベース
 * @param eventIds - eventIDのarray
 */
export async function markEventsDelivered(db: D1Database, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;

  // D1 cannot use IN clauses with parameter expansion; handle via batch
  const stmts = eventIds.map((id) =>
    db.prepare(`UPDATE EventStream SET is_delivered = 1 WHERE event_id = ?`).bind(id)
  );
  await db.batch(stmts);
}

// ---------------------------------------------------------------------------
// SSE Response generate
// ---------------------------------------------------------------------------

/**
 * Cloudflare Workers ReadableStream を使って SSE レスポンスをgenerateする。
 *
 * 動作:
 * 1. ReadableStream をgenerate
 * 2. getPendingEvents を 2 秒ごとにポーリング
 * 3. 各eventを SSE フォーマット (`data: {...}\n\n`) でエンqueue
 * 4. send後にMark delivered
 *
 * @param db           - D1 データベース
 * @param targetBankId - 配信先bank ID
 * @returns SSE レスポンス
 */
export function createSseResponse(db: D1Database, targetBankId: string): Response {
  let lastEventId: string | undefined;
  let timerId: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // First connection notification
      const connectMsg = `data: ${JSON.stringify({ type: "CONNECTED", bank_id: targetBankId })}\n\n`;
      controller.enqueue(new TextEncoder().encode(connectMsg));

      // Polling group (2 sec interval)
      const poll = async () => {
        try {
          const events = await getPendingEvents(db, targetBankId, lastEventId);

          if (events.length > 0) {
            for (const ev of events) {
              const sseData = formatSseEvent(ev);
              controller.enqueue(new TextEncoder().encode(sseData));
              lastEventId = ev.event_id;
            }

            // Mark delivered
            await markEventsDelivered(
              db,
              events.map((e) => e.event_id)
            );
          }
        } catch (err) {
          console.error("[stream] SSE poll error:", err);
          // Notify client of error; stream continues
          const errMsg = `data: ${JSON.stringify({ type: "ERROR", message: "poll failed" })}\n\n`;
          try {
            controller.enqueue(new TextEncoder().encode(errMsg));
          } catch {
            // Ignore if controller closed
            // Discard stream → stop timer
            if (timerId) {
              clearInterval(timerId);
              timerId = null;
            }
          }
        }
      };

      // Poll every 2 seconds (within Workers event loop)
      timerId = setInterval(poll, 2000);
    },
    cancel() {
      // クライアント切断時にtimerを停止（リソースリーク＆誤Mark delivered防止）
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Delete old delivered events
// ---------------------------------------------------------------------------

/**
 * 24 時間以上経過した配信済みeventをdeleteする（cron 用）。
 *
 * @param db - D1 データベース
 * @returns 削除件数
 */
export async function pruneDeliveredEvents(db: D1Database): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(`
    DELETE FROM EventStream
    WHERE is_delivered = 1 AND created_at < ?
  `)
    .bind(cutoff)
    .run();

  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// 内部Utilities
// ---------------------------------------------------------------------------

/**
 * EventStreamRow を SSE フォーマット文字列に変換する。
 *
 * @param ev - event行
 * @returns SSE フォーマット文字列 (`id: ...\ndata: ...\n\n`)
 */
function formatSseEvent(ev: EventStreamRow): string {
  let payload: object;
  try {
    payload = JSON.parse(ev.payload_json) as object;
  } catch {
    payload = { raw: ev.payload_json };
  }

  const data = JSON.stringify({
    event_id: ev.event_id,
    event_type: ev.event_type,
    created_at: ev.created_at,
    ...payload,
  });

  return `id: ${ev.event_id}\ndata: ${data}\n\n`;
}
