/**
 * @file RTP read-only queries and cron timeout sweep.
 * @module zc/lanes/rtp/query
 */
import type { RtpRequestRow, RtpFullStatus } from "../../../types";
import { nowISO } from "../../../types";

/**
 * RTP照会
 */
export async function getRtpStatus(
  db: D1Database,
  rtpId: string
): Promise<{ rtpId: string; status: RtpFullStatus; rows: unknown[] } | null> {
  const row = await db
    .prepare(`
    SELECT * FROM RtpRequests WHERE rtp_id = ?
  `)
    .bind(rtpId)
    .first<RtpRequestRow & { rtp_status?: string }>();

  if (!row) return null;

  // rtp_status が存在しない場合は state から推定
  let status: RtpFullStatus;
  const rawStatus = row.rtp_status;

  if (
    rawStatus === "CREATED" ||
    rawStatus === "NOTIFIED" ||
    rawStatus === "ACCEPTED" ||
    rawStatus === "TX_CREATED" ||
    rawStatus === "COMPLETED" ||
    rawStatus === "REJECTED" ||
    rawStatus === "DECLINED" ||
    rawStatus === "EXPIRED"
  ) {
    status = rawStatus as RtpFullStatus;
  } else {
    switch (row.state) {
      case "REQUESTED":
        status = "CREATED";
        break;
      case "ATTEMPTED":
        status = "TX_CREATED";
        break;
      case "SETTLED":
        status = "COMPLETED";
        break;
      case "EXPIRED":
        status = "EXPIRED";
        break;
      case "FAILED":
        status = "REJECTED";
        break;
      default:
        status = "CREATED";
    }
  }

  return { rtpId, status, rows: [row] };
}

/**
 * RTPタイムアウト処理（cron用）
 *
 * expires_at < now かつ CREATED / NOTIFIED 状態の RTP を EXPIRED にする。
 */
export async function expireRtpRequests(db: D1Database): Promise<number> {
  const now = nowISO();

  const result = await db
    .prepare(`
    UPDATE RtpRequests
    SET rtp_status = 'EXPIRED', state = 'EXPIRED', updated_at = ?
    WHERE expires_at < ? AND (rtp_status IN ('CREATED', 'NOTIFIED') OR state = 'REQUESTED')
  `)
    .bind(now, now)
    .run();

  return result.meta.changes ?? 0;
}
