/**
 * @file End-of-day (EOD) batch settlement. Executes 8 steps: DNS kick, DNS
 * settle, interest accrual, daily balance snapshots, suspense cleanup, daily
 * limit reset, and audit logging.
 * @module cron/eod
 */
// 3. Bank side: interest calculation, daily snapshot
// 4. Zero-sum validation
import type { Env } from "../types";
import { todayJST } from "../types";
import { kickDns, settleDns } from "../zc/dns";
import { cancelHtlc } from "../zc/lanes/htlc";
import { advanceBulk } from "../zc/lanes/bulk";
import { snapshotDailyBalance, applyDailyInterest, verifyZeroSum } from "../bank/ledger";
import { retryPendingNotifications } from "../zc/credit_notify";
import { retryFailedIgs } from "../zc/igs";
import { pruneDeliveredEvents } from "../zc/stream";
import { runFinalityChainAudit } from "../zc/finality_audit";

export async function runEod(env: Env): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];
  const db = env.DB;
  const today = todayJST();

  try {
    // 1. BULK preprocessing: RECEIVED → DECIDED_TO_SETTLE
    // Running this before kickDns ensures the dns_cycle_id of the day's OPEN cycle is assigned correctly
    const bulkReceived = await db
      .prepare(`SELECT txid FROM Transactions WHERE lane='BULK' AND state='RECEIVED'`)
      .all<{ txid: string }>();
    for (const tx of bulkReceived.results) {
      await advanceBulk(tx.txid, env);
      log.push(`BULK advanced: ${tx.txid}`);
    }
    log.push(`BULK: ${bulkReceived.results.length} advanced`);

    // 2. DNS Kick
    const kickResult = await kickDns(today, env);
    log.push(`DNS Kick: cycle=${kickResult.cycle_id} state=${kickResult.state}`);

    // 3. DNS settlement (mock: immediately SETTLED)
    // settleDns internally goes as far as enqueuing ZC_BANK_DEBIT for BULK DECIDED_TO_SETTLE TX
    if (kickResult.state === "KICKED") {
      await settleDns(kickResult.cycle_id, env);
      log.push(`DNS Settled: ${kickResult.cycle_id}`);
    }

    // 4. HTLC expiry check
    const expiredHtlcs = await db
      .prepare(
        `SELECT htlc_id, txid FROM HtlcContracts WHERE state IN ('HTLC_RECEIVED','HTLC_LOCKED') AND timelock < ?`
      )
      .bind(new Date().toISOString())
      .all<{ htlc_id: string; txid: string }>();

    for (const htlc of expiredHtlcs.results) {
      // Pass env to also send the bank-side suspense release notification (reserve-funds has already run when HTLC_LOCKED)
      await cancelHtlc(htlc.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
      log.push(`HTLC expired: ${htlc.htlc_id}`);
    }

    // 5. Interest calculation + balance snapshot
    const accounts = await db
      .prepare(`SELECT DISTINCT bank_id, account_id FROM BankAccounts WHERE status='NORMAL'`)
      .all<{ bank_id: string; account_id: string }>();

    // V8 perf: single-pass dedup. The previous `[...new Set(rows.map(...))]`
    // allocates an intermediate Array (from map), a Set, and a final Array
    // (from spread). Walking once and inserting into the Set directly avoids
    // both intermediates while preserving uniqueness semantics.
    const bankIdSet = new Set<string>();
    const accountRows = accounts.results;
    for (let i = 0; i < accountRows.length; i++) {
      bankIdSet.add(accountRows[i]!.bank_id);
    }
    for (const bankId of bankIdSet) {
      await applyDailyInterest(bankId, today, db);
    }

    for (let i = 0; i < accountRows.length; i++) {
      await snapshotDailyBalance(accountRows[i]!.account_id, today, db);
    }
    log.push(`Snapshots saved for ${accountRows.length} accounts`);

    // 6. Zero-sum validation
    for (const bankId of bankIdSet) {
      const ok = await verifyZeroSum(bankId, db);
      log.push(`ZeroSum ${bankId}: ${ok ? "OK" : "VIOLATED!"}`);
      if (!ok) {
        console.error(`[EOD] Zero-sum violation for ${bankId}`);
      }
    }

    // 7. Reset participating banks' daily cumulative transfer totals (for tx_amount_limit/daily_amount_limit)
    try {
      const today = todayJST();
      await db
        .prepare(`UPDATE Participants SET daily_amount_used = 0, daily_amount_last_reset_date = ?`)
        .bind(today)
        .run();
      log.push("daily_amount_used reset for all participants");
    } catch (e: any) {
      if (e.message && e.message.includes("no such column")) {
        log.push("daily_amount_used missing, skipped participant reset");
      } else {
        throw e;
      }
    }

    // 8. Notification retry / IGS retry / SSE event pruning
    await retryPendingNotifications(db, env);
    await retryFailedIgs(db, env);
    await pruneDeliveredEvents(db);
    log.push("Notification retry, IGS retry, event prune: done");

    // 9. FinalityLog hash chain daily audit
    // Scan the entire chain, and if tampering (prev_hash break / entry_hash mismatch) is detected,
    // converge to CASE. The integrity of FinalityLog, the single source of truth for explainability,
    // is verified daily, without waiting for someone to look up an individual txid.
    const audit = await runFinalityChainAudit(env);
    log.push(
      `Finality audit: ${audit.chains_checked} chains / ${audit.entries_checked} entries, ` +
        `${audit.broken_chains.length} broken, ${audit.cases_opened} cases opened`
    );
    if (audit.broken_chains.length > 0) {
      console.error("[EOD] FinalityLog chain audit detected breakage:", audit.broken_chains);
    }

    return { ok: true, log };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.push(`ERROR: ${msg}`);
    console.error("[EOD] Error:", err);
    return { ok: false, log };
  }
}
