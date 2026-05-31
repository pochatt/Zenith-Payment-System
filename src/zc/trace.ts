/**
 * @file Transaction event logging (TxEventLog). Records all state transitions,
 *       bank calls, and system events for audit trails and dashboard display.
 * @module zc/trace
 */
import type { TxEventStatus } from "../types";
import { nowISO } from "../types";
import { newUUID } from "../shared/idempotency";

export interface TxEventParams {
  txid?: string | null;
  correlation_id?: string | null;
  actor: string; // 'ZC' | 'BANK_001' | 'CUSTOMER' | 'SYSTEM'
  action: string; // Action constants (see below)
  status: TxEventStatus; // 'OK' | 'NG' | 'PENDING'
  reason_code?: string | null;
  amount?: number | null;
  bank_id?: string | null;
  account_id?: string | null;
  details?: Record<string, unknown> | null;
  duration_ms?: number | null;
}

/**
 * TxEventLog にeventをrecordする（INSERT ONLY・失敗しても握りつぶす）
 * audit logの書き込み失敗が本処理をブlockしないよう try/catch で保護する。
 */
export async function logTxEvent(db: D1Database, params: TxEventParams): Promise<void> {
  try {
    const logId = `EVT-${newUUID()}`;
    await db
      .prepare(
        `INSERT INTO TxEventLog
       (log_id, txid, correlation_id, actor, action, status,
        reason_code, amount, bank_id, account_id, details_json, duration_ms, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        logId,
        params.txid ?? null,
        params.correlation_id ?? null,
        params.actor,
        params.action,
        params.status,
        params.reason_code ?? null,
        params.amount ?? null,
        params.bank_id ?? null,
        params.account_id ?? null,
        params.details ? JSON.stringify(params.details) : null,
        params.duration_ms ?? null,
        nowISO()
      )
      .run();
  } catch (err) {
    // Don't let log fail affect main
    console.error("[trace] TxEventLog write failed:", err);
  }
}

/**
 * ZC→Bank 呼び出しをラップし、自動的に TxEventLog をrecordするHelpers。
 * duration_ms も自動計測する。
 */
export async function tracedBankCall<T extends { result: string }>(
  db: D1Database,
  params: {
    txid?: string | null;
    bank_id: string;
    action: string;
    amount?: number;
    details?: Record<string, unknown>;
  },
  fn: () => Promise<T>
): Promise<T> {
  const t0 = Date.now();
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    const duration_ms = Date.now() - t0;
    await logTxEvent(db, {
      txid: params.txid,
      actor: `BANK_${params.bank_id}`,
      action: params.action,
      status: "NG",
      reason_code: "CALL_EXCEPTION",
      amount: params.amount,
      bank_id: params.bank_id,
      details: { ...params.details, error: String(err) },
      duration_ms,
    });
    throw err;
  }
  const duration_ms = Date.now() - t0;
  const isOk =
    result.result === "OK" ||
    result.result === "RESERVED" ||
    result.result === "RELEASED" ||
    result.result === "MATCH";
  await logTxEvent(db, {
    txid: params.txid,
    actor: `BANK_${params.bank_id}`,
    action: params.action,
    status: isOk ? "OK" : "NG",
    reason_code: isOk
      ? null
      : (((result as Record<string, unknown>).reason_code as string | null) ?? null),
    amount: params.amount,
    bank_id: params.bank_id,
    details: params.details,
    duration_ms,
  });
  return result;
}

// ---------------------------------------------------------------------------
// TxEventLog inquiry
// ---------------------------------------------------------------------------

/** transactionに紐付く全eventを時系列でreturn（TxEventLog + FinalityLog マージ） */
export async function getTxEvents(txid: string, db: D1Database): Promise<unknown[]> {
  const [evRows, flRows] = await Promise.all([
    db
      .prepare(
        `SELECT log_id, txid, actor, action, status, reason_code,
              amount, bank_id, account_id, details_json, duration_ms,
              occurred_at AS created_at, 'TRACE' AS source
       FROM TxEventLog
       WHERE txid = ?
       ORDER BY occurred_at ASC`
      )
      .bind(txid)
      .all(),
    db
      .prepare(
        `SELECT log_id, txid, 'ZC' AS actor,
              event_type AS action, 'OK' AS status,
              NULL AS reason_code, NULL AS amount,
              NULL AS bank_id, NULL AS account_id,
              json_object('state_from', COALESCE(state_from,''), 'state_to', state_to) AS details_json,
              NULL AS duration_ms,
              occurred_at AS created_at, 'FINALITY' AS source,
              state_from, state_to
       FROM FinalityLog
       WHERE txid = ?
       ORDER BY occurred_at ASC`
      )
      .bind(txid)
      .all(),
  ]);
  const combined: unknown[] = [...evRows.results, ...flRows.results];
  combined.sort((a: any, b: any) => (a.created_at < b.created_at ? -1 : 1));
  return combined;
}

/** Return all FinalityLog events linked to GTID chronologically */
export async function getGtidEvents(gtid: string, db: D1Database): Promise<unknown[]> {
  const flRows = await db
    .prepare(
      `SELECT log_id, NULL AS txid, 'ZC' AS actor,
            event_type AS action, 'OK' AS status,
            NULL AS reason_code, NULL AS amount,
            NULL AS bank_id, NULL AS account_id,
            json_object('state_from', COALESCE(state_from,''), 'state_to', state_to) AS details_json,
            NULL AS duration_ms,
            occurred_at AS created_at, 'FINALITY' AS source,
            state_from, state_to
     FROM FinalityLog
     WHERE gtid = ?
     ORDER BY occurred_at ASC`
    )
    .bind(gtid)
    .all();
  return flRows.results;
}

/** 最近 N 件の全event（dashboard用） */
export async function getRecentEvents(db: D1Database, limit = 100, offset = 0): Promise<unknown[]> {
  const rows = await db
    .prepare(
      `SELECT log_id, txid, actor, action, status, reason_code,
            amount, bank_id, occurred_at AS created_at
     FROM TxEventLog
     ORDER BY occurred_at DESC
     LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all();
  return rows.results;
}
