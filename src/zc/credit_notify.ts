/**
 * @file Credit notification delivery to payee banks. Implements exponential
 *       backoff retry and delivery tracking.
 * @module zc/credit_notify
 */
import type { Env, CreditNotificationRow, NotificationStatus } from "../types";
import { nowISO } from "../types";
import { newUUID } from "../shared/idempotency";

// ---------------------------------------------------------------------------
// createCreditNotification
// ---------------------------------------------------------------------------
/**
 * CreditNotifications レコードをcreateする。
 * status = PENDING、delivery_attempts = 0、max_attempts = 5。
 *
 * @returns notification_id
 */
export async function createCreditNotification(
  db: D1Database,
  txid: string,
  payeeBankId: string,
  payeeAccountHash: string,
  amount: { value: number; currency: string },
  payerBankId: string,
  purpose: string | null,
  ediSummary: string | null
): Promise<string> {
  const notificationId = newUUID();
  const now = nowISO();

  await db
    .prepare(
      `INSERT OR IGNORE INTO CreditNotifications
     (notification_id, txid, payee_bank_id, payee_account_hash,
      amount_value, amount_currency, payer_bank_id, payer_name_masked,
      purpose, edi_summary, status, delivery_attempts, max_attempts,
      created_at, next_retry_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'PENDING', 0, 5, ?, ?)`
    )
    .bind(
      notificationId,
      txid,
      payeeBankId,
      payeeAccountHash,
      amount.value,
      amount.currency,
      payerBankId,
      purpose,
      ediSummary,
      now,
      now // 初回は即時配信
    )
    .run();

  return notificationId;
}

// ---------------------------------------------------------------------------
// deliverNotification
// ---------------------------------------------------------------------------
/**
 * 指定された通知を payee bankの credit-notify endpointに配信する。
 * 成功: status = DELIVERED
 * 失敗: delivery_attempts < max_attempts なら RETRY に遷移し next_retry_at をset
 *       delivery_attempts >= max_attempts なら FAILED
 */
export async function deliverNotification(
  db: D1Database,
  notificationId: string,
  env: Env
): Promise<void> {
  const now = nowISO();

  const notif = await db
    .prepare(`SELECT * FROM CreditNotifications WHERE notification_id = ?`)
    .bind(notificationId)
    .first<CreditNotificationRow>();

  if (!notif) {
    console.error("[CreditNotify] notification not found:", notificationId);
    return;
  }

  if (notif.status === "DELIVERED" || notif.status === "FAILED") {
    // idempotent: 終端状態ならスキップ
    return;
  }

  // delivery_attempts をインクリメント
  const newAttempts = notif.delivery_attempts + 1;

  const idemKey = `CN-${notif.notification_id}-${newAttempts}`;

  // BankCreditNotifyIngressRequest として直接 handleBankIngress を呼び出す
  // （同一Worker内呼び出し: env.BANK_BASE_URL が空でも動作）
  const ingressPayload = {
    request_id: idemKey,
    notification_id: notif.notification_id,
    txid: notif.txid,
    payee_account_hash: notif.payee_account_hash,
    amount: { value: notif.amount_value, currency: notif.amount_currency },
    payer_bank_id: notif.payer_bank_id,
    payer_name_masked: notif.payer_name_masked ?? "",
    purpose: notif.purpose ?? null,
    edi_summary: notif.edi_summary ?? undefined,
  };

  let delivered = false;
  try {
    const { handleBankIngress } = await import("../bank/ingress");
    const result = (await handleBankIngress(
      notif.payee_bank_id,
      "credit-notify",
      ingressPayload,
      env
    )) as { result: string };
    if (result.result === "DELIVERED") {
      delivered = true;
    } else {
      console.error("[CreditNotify] bank returned error:", result);
    }
  } catch (err) {
    console.error("[CreditNotify] ingress error:", err);
  }

  if (delivered) {
    await db
      .prepare(
        `UPDATE CreditNotifications
       SET status = 'DELIVERED', delivery_attempts = ?, delivered_at = ?
       WHERE notification_id = ?`
      )
      .bind(newAttempts, now, notificationId)
      .run();
    return;
  }

  // 配信失敗: 再試行schedule or FAILED
  if (newAttempts >= notif.max_attempts) {
    await db
      .prepare(
        `UPDATE CreditNotifications
       SET status = 'FAILED', delivery_attempts = ?
       WHERE notification_id = ?`
      )
      .bind(newAttempts, notificationId)
      .run();
    console.error("[CreditNotify] max attempts reached, marking FAILED:", notificationId);
  } else {
    const nextRetryAt = calcNextRetryAt(now, newAttempts);
    await db
      .prepare(
        `UPDATE CreditNotifications
       SET status = 'RETRY', delivery_attempts = ?, next_retry_at = ?
       WHERE notification_id = ?`
      )
      .bind(newAttempts, nextRetryAt, notificationId)
      .run();
  }
}

// ---------------------------------------------------------------------------
// retryPendingNotifications
// ---------------------------------------------------------------------------
/**
 * cron から呼ばれる。next_retry_at <= now の PENDING / RETRY 通知を再配信する。
 */
export async function retryPendingNotifications(db: D1Database, env: Env): Promise<void> {
  const now = nowISO();

  const rows = await db
    .prepare(
      `SELECT notification_id FROM CreditNotifications
       WHERE status IN ('PENDING', 'RETRY')
         AND next_retry_at <= ?
       ORDER BY next_retry_at ASC
       LIMIT 50`
    )
    .bind(now)
    .all<{ notification_id: string }>();

  for (const row of rows.results ?? []) {
    try {
      await deliverNotification(db, row.notification_id, env);
    } catch (err) {
      console.error("[CreditNotify] retry error for:", row.notification_id, err);
    }
  }
}

// ---------------------------------------------------------------------------
// getNotificationStatus
// ---------------------------------------------------------------------------
/** notification_id に紐付く CreditNotifications レコードをreturn。 */
export async function getNotificationStatus(
  db: D1Database,
  notificationId: string
): Promise<CreditNotificationRow | null> {
  return db
    .prepare(`SELECT * FROM CreditNotifications WHERE notification_id = ?`)
    .bind(notificationId)
    .first<CreditNotificationRow>();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * 試行回数に応じた指数バックオフで次回再試行時刻を計算する。
 * attempt 1: +30s
 * attempt 2: +2m (120s)
 * attempt 3: +10m (600s)
 * attempt 4: +1h (3600s)
 * attempt 5+: +1h (3600s) — max_attempts に達する前に FAILED になる
 */
function calcNextRetryAt(nowStr: string, attempt: number): string {
  const backoffSeconds: Record<number, number> = {
    1: 30,
    2: 120,
    3: 600,
    4: 3600,
  };
  const secs = backoffSeconds[attempt] ?? 3600;
  return new Date(new Date(nowStr).getTime() + secs * 1000).toISOString();
}
