/**
 * @file RTP read-only queries and cron timeout sweep.
 * @module zc/lanes/rtp/query
 */
import type { RtpRequestRow, RtpState } from "../../../types";
import { nowISO } from "../../../types";

/**
 * RTPinquiry
 *
 * 0025_rtp_consolidate.sql 以降は state 列が唯一の状態源なので、そのままreturn。
 */
export async function getRtpStatus(
  db: D1Database,
  rtpId: string
): Promise<{ rtpId: string; status: RtpState; rows: unknown[] } | null> {
  const row = await db
    .prepare(`
    SELECT * FROM RtpRequests WHERE rtp_id = ?
  `)
    .bind(rtpId)
    .first<RtpRequestRow>();

  if (!row) return null;

  return { rtpId, status: row.state, rows: [row] };
}

/**
 * RTPtimeout処理（cron用）
 *
 * expires_at < now かつ CREATED / NOTIFIED 状態の RTP を EXPIRED にする。
 */
export async function expireRtpRequests(db: D1Database): Promise<number> {
  const now = nowISO();

  const result = await db
    .prepare(`
    UPDATE RtpRequests
    SET state = 'EXPIRED', updated_at = ?
    WHERE expires_at < ? AND state IN ('CREATED', 'NOTIFIED')
  `)
    .bind(now, now)
    .run();

  return result.meta.changes ?? 0;
}
