/**
 * @file Timeout sweep (runs every minute). Expires stale transactions in
 * T2/T3 timeout, recovers SUSPENDED->FAILED, expires HTLC timelocks, and
 * cleans up stalled GTID transactions.
 * @module cron/timeout_sweep
 */
// - Vault TTL expired → logical delete (is_evicted = 1)
// - Recover GTIDs stuck in GT_DECIDED_TO_SETTLE
import type { Env } from "../types";
import { nowISO } from "../types";
import { suspendTx, checkAndFinalizeGtid } from "../zc/orchestrator";
import { transitionWithLog } from "../zc/lanes/_helpers";
import { cancelHtlc } from "../zc/lanes/htlc";
import { expireRtpRequests } from "../zc/rtp";
import { retryPendingNotifications } from "../zc/credit_notify";

// Timeout threshold (seconds)
const T2_EXEC_TIMEOUT_SEC = 300; // 5 minutes: DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED
const T3_PAYEE_TIMEOUT_SEC = 300; // 5 minutes: PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED

export async function runTimeoutSweep(env: Env): Promise<{ swept: number }> {
  const db = env.DB;
  const now = new Date();
  let swept = 0;

  // 1. T2_exec timeout: DECIDED_TO_SETTLE for 5 minutes or more
  // Exclude BULK/DEFERRED since by design they wait in DECIDED_TO_SETTLE until EOD
  // Exclude HTLC since it is managed independently by timelock (claimHtlc completes with a synchronous debit)
  const t2Deadline = new Date(now.getTime() - T2_EXEC_TIMEOUT_SEC * 1000).toISOString();
  const decidedOld = await db
    .prepare(
      `SELECT txid FROM Transactions WHERE state='DECIDED_TO_SETTLE' AND lane NOT IN ('BULK','DEFERRED','HTLC') AND updated_at < ?`
    )
    .bind(t2Deadline)
    .all<{ txid: string }>();

  for (const tx of decidedOld.results) {
    await suspendTx(tx.txid, "SUSPEND_EXEC_TIMEOUT", db);
    swept++;
  }

  // 2. T3_payee_proof timeout: PAYER_EXEC_CONFIRMED for 5 minutes or more
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

  // 4. HTLC timelock expired
  const expiredHtlcs = await db
    .prepare(
      `SELECT htlc_id, txid FROM HtlcContracts WHERE state IN ('HTLC_RECEIVED','HTLC_LOCKED') AND timelock < ?`
    )
    .bind(now.toISOString())
    .all<{ htlc_id: string; txid: string }>();

  for (const htlc of expiredHtlcs.results) {
    // Pass env to also send the bank-side suspense release notification (reserve-funds has already run when HTLC_LOCKED)
    await cancelHtlc(htlc.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
    swept++;
  }

  // 5. Vault TTL expired (logical delete)
  const expiredVault = await db
    .prepare(`UPDATE Vault SET is_evicted=1 WHERE is_evicted=0 AND expires_at < ?`)
    .bind(now.toISOString())
    .run();
  swept += expiredVault.meta.changes ?? 0;

  // 6. RTP expired (update only the state column)
  swept += await expireRtpRequests(db);

  // 7. Retry undelivered notifications
  await retryPendingNotifications(db, env);

  // 8. Recover GTIDs stuck in GT_DECIDED_TO_SETTLE (no update for 10 minutes or more)
  // Rescue GTIDs for which checkAndFinalizeGtid was not called due to leg execution failure or 0-legs
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

  // 9. Bulk-fix records that are already GT_SETTLED but whose GtidLegs.state is not updated
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
