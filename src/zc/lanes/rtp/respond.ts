/**
 * @file RTP response handling — payer accepts (creates tx) or rejects.
 * @module zc/lanes/rtp/respond
 */
import type { Env, RtpRequestRow, RtpRespondRequest } from "../../../types";
import { nowISO } from "../../../types";
import { insertTxWithLog } from "../_helpers";

/**
 * RTP応答処理（ACCEPTED / REJECTED）
 *
 * 支払人がapprovalした場合、RTP 紐づきfund transfertransactionを自動generateして ZC に投入する。
 */
export async function respondToRtp(
  db: D1Database,
  rtpId: string,
  response: RtpRespondRequest,
  env: Env
): Promise<{ result: string; txid?: string }> {
  const now = nowISO();

  const rtp = await db
    .prepare(`
    SELECT * FROM RtpRequests WHERE rtp_id = ?
  `)
    .bind(rtpId)
    .first<
      RtpRequestRow & {
        payee_name?: string;
        description?: string;
        edi_ref?: string;
        payee_account_hash?: string;
      }
    >();

  if (!rtp) {
    return { result: "NOT_FOUND" };
  }

  // 既に応答済みの場合
  const alreadyDone: RtpRequestRow["state"][] = [
    "ACCEPTED",
    "DECLINED",
    "EXPIRED",
    "TX_CREATED",
    "COMPLETED",
    "FAILED",
  ];
  if (alreadyDone.includes(rtp.state)) {
    return { result: "ALREADY_RESPONDED", txid: rtp.linked_txid ?? undefined };
  }

  // deadlinecheck
  if (new Date(rtp.expires_at) <= new Date(now)) {
    await db
      .prepare(`
      UPDATE RtpRequests SET state = 'EXPIRED', updated_at = ? WHERE rtp_id = ?
    `)
      .bind(now, rtpId)
      .run();
    return { result: "EXPIRED" };
  }

  if (response.response === "REJECTED") {
    await db
      .prepare(`
      UPDATE RtpRequests
      SET state = 'DECLINED', response_type = 'REJECTED',
          payer_account_id = ?, responded_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `)
      .bind(response.payer_account_id, now, now, rtpId)
      .run();

    return { result: "DECLINED" };
  }

  // ACCEPTED: fund transfertransactionを自動generate
  const linkedTxid = `TX-${crypto.randomUUID()}`;

  // fund transfer Transaction create + FinalityLog + RtpRequests の TX_CREATED 化を
  // 1 つの db.batch() に統合する。旧implementationは INSERT/UPDATE をbatch、FinalityLog を別 await
  // していたため「Transactions 行はあるが RtpAccepted logが残らない」窓が存在した。
  // insertTxWithLog は ALLOWED_ENTRY_STATES = ['RECEIVED', ...] を強制するので、
  // RTP は canonical な RECEIVED 入口で他laneと合流する。
  await insertTxWithLog(db, {
    txid: linkedTxid,
    lane: "RTP",
    initialState: "RECEIVED",
    amount: { value: rtp.amount_value, currency: "JPY" },
    payerBankId: rtp.payer_bank_id,
    payerAccountHash: response.payer_account_id,
    payeeBankId: rtp.payee_bank_id,
    payeeAccountHash: rtp.payee_account_hash ?? "",
    idempotencyKey: response.idempotency_key,
    extraColumns: { purpose: "P2P" },
    eventType: "RtpAccepted",
    payload: { rtp_id: rtpId, linked_txid: linkedTxid },
    sideUpdates: [
      {
        sql: `UPDATE RtpRequests
              SET state = 'TX_CREATED', attempt_count = attempt_count + 1,
                  linked_txid = ?, linked_txid_new = ?, payer_account_id = ?, response_type = 'ACCEPTED',
                  responded_at = ?, updated_at = ?
              WHERE rtp_id = ?`,
        binds: [linkedTxid, linkedTxid, response.payer_account_id, now, now, rtpId],
      },
    ],
  });

  // オーケストレーターへsend（STANDARD フローで精算処理を進める）
  await env.QUEUE.send({
    type: "ZC_STATE_ADVANCE",
    payload: { txid: linkedTxid, action: "ADVANCE_STANDARD" },
    txid: linkedTxid,
    attempt: 0,
    enqueued_at: now,
  });

  return { result: "ACCEPTED", txid: linkedTxid };
}
