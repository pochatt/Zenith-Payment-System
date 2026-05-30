/**
 * @file Timeout sweep (runs every minute). Expires stale transactions in
 * T2/T3 timeout, recovers SUSPENDED->FAILED, expires Hash-Time-Locked Contract timelocks, and
 * cleans up stalled GTID transactions.
 * @module cron/timeout_sweep
 */
// - Vault TTL切れ → 論理削除（is_evicted = 1）
// - GT_DECIDED_TO_SETTLE スタック GTID 回収
import type { Env } from "../types";
import { nowISO } from "../types";
import { suspendTx, checkAndFinalizeGtid } from "../zc/orchestrator";
import { transitionWithLog } from "../zc/lanes/_helpers";
import { cancelHtlc } from "../zc/lanes/htlc";
import { expireRtpRequests } from "../zc/rtp";
import { retryPendingNotifications } from "../zc/credit_notify";

// タイムアウト閾値（秒）
const T2_EXEC_TIMEOUT_SEC = 300; // 5分: DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED
const T3_PAYEE_TIMEOUT_SEC = 300; // 5分: PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED

export async function runTimeoutSweep(env: Env): Promise<{ swept: number }> {
  const db = env.DB;
  const now = new Date();
  let swept = 0;

  // 1. T2_exec timeout: DECIDED_TO_SETTLE exceeds 5 minutes
  // BULK/DEFERRED are excluded because they are designed to wait in DECIDED_TO_SETTLE state until EOD
  // Hash-Time-Locked Contract is excluded because it is independently managed by timelock (claimHtlc completes as synchronous debit)
  const t2Deadline = new Date(now.getTime() - T2_EXEC_TIMEOUT_SEC * 1000).toISOString();
  const decidedOld = await db
    .prepare(
      `SELECT txid FROM Transactions WHERE state='DECIDED_TO_SETTLE' AND lane NOT IN ('BULK','DEFERRED','Hash-Time-Locked Contract') AND updated_at < ?`
    )
    .bind(t2Deadline)
    .all<{ txid: string }>();

  for (const tx of decidedOld.results) {
    await suspendTx(tx.txid, "SUSPEND_EXEC_TIMEOUT", db);
    swept++;
  }

  // 2. T3_payee_proof timeout: PAYER_EXEC_CONFIRMED exceeds 5 minutes
  const t3Deadline = new Date(now.getTime() - T3_PAYEE_TIMEOUT_SEC * 1000).toISOString();
  const payerConfOld = await db
    .prepare(`SELECT txid FROM Transactions WHERE state='PAYER_EXEC_CONFIRMED' AND updated_at < ?`)
    .bind(t3Deadline)
    .all<{ txid: string }>();

  for (const tx of payerConfOld.results) {
    await suspendTx(tx.txid, "SUSPEND_PAYEE_PROOF_TIMEOUT", db);
    swept++;
  }

  // 3. FAILED_EXECUTION transition: when SUSPENDED exceeds expires_at
  const failedOld = await db
    .prepare(
      `SELECT txid FROM Transactions WHERE state='SUSPENDED' AND expires_at IS NOT NULL AND expires_at < ?`
    )
    .bind(now.toISOString())
    .all<{ txid: string }>();

  for (const tx of failedOld.results) {
    // Route through transitionWithLog so the SUSPENDED → FAILED_EXECUTION
    // advance writes its paired FinalityLog entry atomically. A raw UPDATE
    // here moved a transaction to a *terminal* state with no audit record —
    // exactly the "state advanced without evidence" window the system forbids
    // (design principle #1). FAILED_EXECUTION is terminal, so a missing log is
    // unrecoverable after the fact.
    const { applied } = await transitionWithLog(db, {
      txid: tx.txid,
      fromState: "SUSPENDED",
      toState: "FAILED_EXECUTION",
      eventType: "FailedExecution",
      setColumns: { reason_code: "FAILED_EXEC_TIMEOUT" },
      payload: { txid: tx.txid, reason_code: "FAILED_EXEC_TIMEOUT" },
    });
    if (applied) swept++;
  }

  // 4. Hash-Time-Locked Contract timelock expiration
  const expiredHtlcs = await db
    .prepare(
      `SELECT htlc_id, txid FROM HtlcContracts WHERE state IN ('Hash-Time-Locked Contract_RECEIVED','Hash-Time-Locked Contract_LOCKED') AND timelock < ?`
    )
    .bind(now.toISOString())
    .all<{ htlc_id: string; txid: string }>();

  for (const htlc of expiredHtlcs.results) {
    // Pass env to also send bank-side suspense release notification (reserve-funds already executed when Hash-Time-Locked Contract is in _LOCKED state)
    await cancelHtlc(htlc.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
    swept++;
  }

  // 5. Vault TTL expiration (logical deletion)
  const expiredVault = await db
    .prepare(`UPDATE Vault SET is_evicted=1 WHERE is_evicted=0 AND expires_at < ?`)
    .bind(now.toISOString())
    .run();
  swept += expiredVault.meta.changes ?? 0;

  // 6. RTP expiration (update state column only)
  swept += await expireRtpRequests(db);

  // 7. 未配信通知リトライ
  await retryPendingNotifications(db, env);

  // 8. GT_DECIDED_TO_SETTLE stuck GTID recovery (no updates for 10+ minutes)
  // Rescue GTIDs where checkAndFinalizeGtid was not called due to leg execution failure or 0-legs
  const gtStuckDeadline = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const stuckGtids = await db
    .prepare(
      `SELECT gtid FROM GtidTransactions WHERE state='GT_DECIDED_TO_SETTLE' AND updated_at < ?`
    )
    .bind(gtStuckDeadline)
    .all<{ gtid: string }>();

  for (const g of stuckGtids.results) {
    await checkAndFinalizeGtid(g.gtid, db);
    swept++;
  }

  // 9. Batch fix records where GT_SETTLED is complete but GtidLegs.state is not updated
  const legFixResult = await db
    .prepare(`
    UPDATE GtidLegs SET state='LEG_SETTLED', updated_at=?
    WHERE state NOT IN ('LEG_SETTLED','LEG_FAILED','LEG_REGISTERED')
      AND gtid IN (SELECT gtid FROM GtidTransactions WHERE state='GT_SETTLED')
  `)
    .bind(nowISO())
    .run();
  swept += legFixResult.meta.changes ?? 0;

  return { swept };
}
