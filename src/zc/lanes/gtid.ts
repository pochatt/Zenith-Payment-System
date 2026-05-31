/**
 * @file GTID (Global Transaction ID) coordinated multi-leg transaction
 *       processing. Manages leg-ready-check and atomic multi-bank settlement.
 * @module zc/lanes/gtid
 */
import type { Env, GtidRegisterRequest, GtidTransactionRow, GtidLegRow } from "../../types";
import { nowISO } from "../../types";
import { writeFinalityLog, callBankLegReadyCheck, callBankReleaseReserve } from "../orchestrator";
import { newDecisionProofRef, newFinalityLogRef } from "../../shared/proof";
import { reserveH, lockH, releaseH } from "../h_model";
import { getOrCreateDnsCycle } from "../dns";
import { insertTxWithLog } from "./_helpers";

/**
 * GTID 登録: GT_RECEIVED + legs = LEG_REGISTERED
 */
export async function registerGtid(
  req: GtidRegisterRequest,
  env: Env
): Promise<{
  result: "GTID_ACCEPTED";
  gtid: string;
  state: string;
}> {
  const db = env.DB;
  const now = nowISO();
  // total_amount = PAYER leg sum (all legs = 2x)
  const totalAmount = req.legs
    .filter((l) => l.role === "PAYER")
    .reduce((s, l) => s + l.amount.value, 0);

  const stmts = [
    db
      .prepare(
        `INSERT OR IGNORE INTO GtidTransactions
       (gtid, state, initiator_bank_id, total_amount, leg_count, legs_ready_count,
        legs_settled_count, expires_at, version, created_at, updated_at)
       VALUES (?, 'GT_RECEIVED', ?, ?, ?, 0, 0, ?, 0, ?, ?)`
      )
      .bind(
        req.gtid,
        req.legs[0]?.bank_id ?? "",
        totalAmount,
        req.legs.length,
        req.expires_at ?? null,
        now,
        now
      ),
  ];

  for (const leg of req.legs) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO GtidLegs
       (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'LEG_REGISTERED', 0, ?, ?)`
        )
        .bind(
          leg.leg_id,
          req.gtid,
          leg.role,
          leg.bank_id,
          leg.account_hash,
          leg.amount.value,
          now,
          now
        )
    );
  }

  await db.batch(stmts);

  await writeFinalityLog(db, {
    txid: null,
    event_type: "GtidRegistered",
    state_from: null,
    state_to: "GT_RECEIVED",
    payload_json: JSON.stringify({ gtid: req.gtid, leg_count: req.legs.length }),
    txid_or_gtid: req.gtid,
  });

  // Async: execute ready-check all legs
  await env.QUEUE.send({
    type: "ZC_BANK_LEG_READY",
    payload: { gtid: req.gtid },
    gtid: req.gtid,
    attempt: 0,
    enqueued_at: now,
  });

  return { result: "GTID_ACCEPTED", gtid: req.gtid, state: "GT_RECEIVED" };
}

/**
 * 全 leg の ready-check を実行し、全員 OK なら Decision finalized
 * QueueConsumer から呼ばれる
 */
export async function advanceGtid(gtid: string, env: Env): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const gt = await db
    .prepare(`SELECT * FROM GtidTransactions WHERE gtid = ?`)
    .bind(gtid)
    .first<GtidTransactionRow>();
  if (!gt || gt.state !== "GT_RECEIVED") return;

  const legs = await db
    .prepare(`SELECT * FROM GtidLegs WHERE gtid = ?`)
    .bind(gtid)
    .all<GtidLegRow>();

  // Transition to GT_PRECHECKED (CAS: prevent duplicate parallel execution)
  const toPrechecked = await db
    .prepare(
      `UPDATE GtidTransactions SET state='GT_PRECHECKED', updated_at=?, version=version+1 WHERE gtid=? AND state='GT_RECEIVED'`
    )
    .bind(now, gtid)
    .run();

  // changes=0 = other Worker already transitioned → don't duplicate
  if ((toPrechecked.meta.changes ?? 0) === 0) return;

  // ready-check per leg
  let allReady = true;
  for (const leg of legs.results) {
    // Guarantee same request_id in queue retry (leg_id unique, safe)
    const checkResult = await callBankLegReadyCheck(
      leg.bank_id,
      {
        request_id: `LEG-READY-${leg.leg_id}`,
        gtid,
        leg_id: leg.leg_id,
        role: leg.role,
        amount: { value: leg.amount_value, currency: "JPY" },
        account_hash: leg.account_hash,
      },
      env
    );

    if (checkResult.result === "OK") {
      await db
        .prepare(
          `UPDATE GtidLegs SET state='LEG_READY_CHECKED', updated_at=?, version=version+1 WHERE leg_id=? AND state='LEG_REGISTERED'`
        )
        .bind(now, leg.leg_id)
        .run();
    } else {
      allReady = false;
      await db
        .prepare(
          `UPDATE GtidLegs SET state='LEG_FAILED', updated_at=?, version=version+1 WHERE leg_id=? AND state='LEG_REGISTERED'`
        )
        .bind(now, leg.leg_id)
        .run();
    }
  }

  if (!allReady) {
    // Bug fix: AND state='GT_PRECHECKED' を追加して並行処理の上書きを防ぐ
    const cancelUpdated = await db
      .prepare(
        `UPDATE GtidTransactions SET state='GT_DECIDED_CANCEL', updated_at=?, version=version+1 WHERE gtid=? AND state='GT_PRECHECKED'`
      )
      .bind(now, gtid)
      .run();
    if ((cancelUpdated.meta.changes ?? 0) === 0) return;
    await writeFinalityLog(db, {
      txid: null,
      event_type: "GtidDecidedCancel",
      state_from: "GT_PRECHECKED",
      state_to: "GT_DECIDED_CANCEL",
      payload_json: JSON.stringify({ gtid, reason: "LEG_READY_CHECK_NG" }),
      txid_or_gtid: gtid,
    });
    await finalizeGtidCancelled(gtid, db, env);
    return;
  }

  // Bug #6: confirm PAYER/PAYEE existence before Decision finalized
  // Validation after Decision records improper GT_DECIDED_TO_SETTLE → GT_DECIDED_CANCEL in FinalityLog
  // V8 perf: single-pass partition + amount aggregation. The previous form did
  // two .filter() passes plus two .reduce() passes (4 traversals + 2 array
  // allocations). One for-loop covers all four computations.
  const payerLegs: GtidLegRow[] = [];
  const payeeLegs: GtidLegRow[] = [];
  let totalPayerAmount = 0;
  let totalPayeeAmount = 0;
  const legRows = legs.results;
  for (let i = 0; i < legRows.length; i++) {
    const leg = legRows[i]!;
    if (leg.role === "PAYER") {
      payerLegs.push(leg);
      totalPayerAmount += leg.amount_value;
    } else if (leg.role === "PAYEE") {
      payeeLegs.push(leg);
      totalPayeeAmount += leg.amount_value;
    }
  }
  // PAYER ↔ PAYEE pairing finalized by leg_id lexicographic order
  // SQLite SELECT in ROWID order; req.legs ordering
  // If different from leg_id order, both arrays must correspond same position
  // Misdirected credit (A→B becomes A→C) occurs. Both by leg_id
  // With sort, 'i-th on both' always pairs correctly
  // Specification note: guarantee 'stable mapping by leg_id' in implementation
  const cmpLegId = (a: GtidLegRow, b: GtidLegRow) =>
    a.leg_id < b.leg_id ? -1 : a.leg_id > b.leg_id ? 1 : 0;
  payerLegs.sort(cmpLegId);
  payeeLegs.sort(cmpLegId);
  const payerLeg = payerLegs[0];
  const payeeLeg = payeeLegs[0];
  if (!payerLeg || !payeeLeg) {
    console.error(`[gtid] GTID ${gtid} is missing PAYER or PAYEE leg — cancelling`);
    await db
      .prepare(
        `UPDATE GtidTransactions SET state='GT_DECIDED_CANCEL', updated_at=?, version=version+1 WHERE gtid=? AND state='GT_PRECHECKED'`
      )
      .bind(now, gtid)
      .run();
    await writeFinalityLog(db, {
      txid: null,
      event_type: "GtidDecidedCancel",
      state_from: "GT_PRECHECKED",
      state_to: "GT_DECIDED_CANCEL",
      payload_json: JSON.stringify({ gtid, reason: "MISSING_LEG_ROLE" }),
      txid_or_gtid: gtid,
    });
    await finalizeGtidCancelled(gtid, db, env);
    return;
  }

  // Bug #2 fix: Validate amount balance between PAYER and PAYEE legs.
  // Atomic settlement requires that total PAYER amount == total PAYEE amount.
  // Without this check, multi-leg transactions could settle with unbalanced amounts,
  // causing accounting inconsistencies and potential fund loss/gain.
  // (totalPayerAmount / totalPayeeAmount were computed during the single-pass
  // partition above to avoid two extra .reduce() traversals.)
  if (totalPayerAmount !== totalPayeeAmount) {
    console.error(
      `[gtid] GTID ${gtid} amount mismatch: PAYER total=${totalPayerAmount}, PAYEE total=${totalPayeeAmount} — cancelling`
    );
    await db
      .prepare(
        `UPDATE GtidTransactions SET state='GT_DECIDED_CANCEL', updated_at=?, version=version+1 WHERE gtid=? AND state='GT_PRECHECKED'`
      )
      .bind(now, gtid)
      .run();
    await writeFinalityLog(db, {
      txid: null,
      event_type: "GtidDecidedCancel",
      state_from: "GT_PRECHECKED",
      state_to: "GT_DECIDED_CANCEL",
      payload_json: JSON.stringify({
        gtid,
        reason: "AMOUNT_BALANCE_MISMATCH",
        total_payer_amount: totalPayerAmount,
        total_payee_amount: totalPayeeAmount,
      }),
      txid_or_gtid: gtid,
    });
    await finalizeGtidCancelled(gtid, db, env);
    return;
  }

  // Get/lock PAYER leg H reserved before Decision finalized
  const hReservations = new Map<string, string>(); // leg_id → reservationId
  for (const leg of legs.results) {
    if (leg.role !== "PAYER") continue;
    const legTxid = `TX-GT-${leg.leg_id}`;
    const hResult = await reserveH(leg.bank_id, legTxid, leg.amount_value, db);
    if (!hResult.ok) {
      // H exceeded or no bank → release reserved, cancel
      for (const resId of hReservations.values()) {
        await releaseH(resId, db);
      }
      await db
        .prepare(
          `UPDATE GtidTransactions SET state='GT_DECIDED_CANCEL', updated_at=?, version=version+1 WHERE gtid=? AND state='GT_PRECHECKED'`
        )
        .bind(now, gtid)
        .run();
      await writeFinalityLog(db, {
        txid: null,
        event_type: "GtidDecidedCancel",
        state_from: "GT_PRECHECKED",
        state_to: "GT_DECIDED_CANCEL",
        payload_json: JSON.stringify({ gtid, reason: hResult.reason }),
        txid_or_gtid: gtid,
      });
      await finalizeGtidCancelled(gtid, db, env);
      return;
    }
    const reservationId = hResult.reservation_id;
    // Direct to DECIDED_TO_SETTLE, so LOCK immediately
    await lockH(reservationId, db);
    hReservations.set(leg.leg_id, reservationId);
  }

  // All legs OK → Decision atomically finalized
  const decisionProofRef = newDecisionProofRef();
  const finalityLogRef = newFinalityLogRef();
  // dns_cycle_id をset（DNSsettlementでのH解放に必要）
  const dnsCycleId = await getOrCreateDnsCycle(db, now);

  // Bug #5 fix: AND state='GT_PRECHECKED' でステートガードを追加し、
  // Don't overwrite if parallel timeout already went to GT_DECIDED_CANCEL
  const decisionUpdated = await db
    .prepare(
      `UPDATE GtidTransactions SET state='GT_DECIDED_TO_SETTLE', legs_ready_count=leg_count, updated_at=?, version=version+1 WHERE gtid=? AND state='GT_PRECHECKED'`
    )
    .bind(now, gtid)
    .run();

  if ((decisionUpdated.meta.changes ?? 0) === 0) {
    // Already transitioned in parallel → release reserved H, skip
    for (const resId of hReservations.values()) {
      await releaseH(resId, db);
    }
    console.warn(
      `[gtid] advanceGtid: decision CAS failed for ${gtid} (already transitioned from GT_PRECHECKED)`
    );
    return;
  }

  await writeFinalityLog(db, {
    txid: null,
    event_type: "GtidDecided",
    state_from: "GT_PRECHECKED",
    state_to: "GT_DECIDED_TO_SETTLE",
    payload_json: JSON.stringify({ gtid, decision_proof_ref: decisionProofRef }),
    txid_or_gtid: gtid,
  });

  // Create PAYER leg Transaction; enqueue Execution
  // PAYEE leg has no Transaction. Credit via PAYER Transaction
  // Executed sequentially in onPayerExecConfirmed → ZC_BANK_CREDIT flow
  // Direct ZC_BANK_CREDIT here causes duplicate credit

  for (const leg of legs.results) {
    // PAYEE leg: no Transaction, no ZC_BANK_CREDIT
    // クレジットは対応する PAYERレグ Transaction の onPayerExecConfirmed で投入される。
    if (leg.role === "PAYEE") continue;

    const txid = `TX-GT-${leg.leg_id}`;
    // Corresponding PAYEE for PAYER by leg_id position (== post-sort array index)
    // Arrays already sorted by leg_id; findIndex result direct
    // Correct pairing index. If PAYEE < PAYER, first PAYEE
    // Use as fallback (convenience for single-payee, etc)
    const payerIdx = payerLegs.findIndex((p) => p.leg_id === leg.leg_id);
    const counterpartyPayeeLeg = payeeLegs[payerIdx] ?? payeeLeg;
    const hReservationId = hReservations.get(leg.leg_id) ?? null;

    // Atomic INSERT + paired FinalityLog + GtidLegs.txid backref via insertTxWithLog.
    // GTID is the one lane where leg-level Transactions rows enter at
    // DECIDED_TO_SETTLE directly — there is no per-leg pre-decision state because
    // the GT-level GtidDecided event already committed atomicity for all legs.
    // The helper enforces an entry-state whitelist so this remains an explicit,
    // auditable exception rather than a free-for-all.
    await insertTxWithLog(db, {
      txid,
      lane: "DEFERRED",
      initialState: "DECIDED_TO_SETTLE",
      amount: { value: leg.amount_value, currency: "JPY" },
      payerBankId: leg.bank_id,
      payerAccountHash: leg.account_hash,
      payeeBankId: counterpartyPayeeLeg.bank_id,
      payeeAccountHash: counterpartyPayeeLeg.account_hash,
      idempotencyKey: `GTID-${gtid}-${leg.leg_id}`,
      decisionProofRef,
      hReservationId,
      dnsCycleId,
      eventType: "GtidLegDecidedToSettle",
      payload: { gtid, leg_id: leg.leg_id, decision_proof_ref: decisionProofRef },
      sideUpdates: [
        {
          sql: `UPDATE GtidLegs SET txid=?, updated_at=?, version=version+1 WHERE leg_id=?`,
          binds: [txid, now, leg.leg_id],
        },
      ],
    });

    await env.QUEUE.send({
      type: "ZC_BANK_DEBIT",
      payload: {
        gtid,
        leg_id: leg.leg_id,
        payer_bank_id: leg.bank_id,
        payee_bank_id: counterpartyPayeeLeg.bank_id,
        txid,
        amount: { value: leg.amount_value, currency: "JPY" },
        decision_proof_ref: decisionProofRef,
      },
      gtid,
      attempt: 0,
      enqueued_at: now,
    });
  }
}

// ---------------------------------------------------------------------------
// GTID cancelled terminal: GT_DECIDED_CANCEL → GT_CANCELLED
// ---------------------------------------------------------------------------
async function finalizeGtidCancelled(gtid: string, db: D1Database, env?: Env): Promise<void> {
  // Release bank suspense for any PAYER legs that already reserved funds via leg-ready-check.
  // Each successful PAYER leg-ready-check creates a SuspenseDetails row with txid=TX-GT-{leg_id}.
  if (env) {
    const payerLegs = await db
      .prepare(`SELECT leg_id, bank_id FROM GtidLegs WHERE gtid = ? AND role = 'PAYER'`)
      .bind(gtid)
      .all<{ leg_id: string; bank_id: string }>();
    for (const leg of payerLegs.results ?? []) {
      const predictedTxid = `TX-GT-${leg.leg_id}`;
      const suspense = await db
        .prepare(
          `SELECT suspense_id FROM SuspenseDetails WHERE txid=? AND bank_id=? AND status='RESERVED' LIMIT 1`
        )
        .bind(predictedTxid, leg.bank_id)
        .first<{ suspense_id: string }>();
      if (suspense) {
        await callBankReleaseReserve(
          leg.bank_id,
          {
            request_id: `GTID-CANCEL-${leg.leg_id}`,
            txid: predictedTxid,
            reservation_ref: suspense.suspense_id,
          },
          env
        ).catch((e) =>
          console.error(`[gtid] bank release-reserve failed for leg ${leg.leg_id}:`, e)
        );
      }
    }
  }

  const now = nowISO();
  const updated = await db
    .prepare(
      `UPDATE GtidTransactions SET state='GT_CANCELLED', updated_at=?, version=version+1
     WHERE gtid=? AND state='GT_DECIDED_CANCEL'`
    )
    .bind(now, gtid)
    .run();
  if ((updated.meta.changes ?? 0) > 0) {
    await writeFinalityLog(db, {
      txid: null,
      event_type: "GtidCancelled",
      state_from: "GT_DECIDED_CANCEL",
      state_to: "GT_CANCELLED",
      payload_json: JSON.stringify({ gtid }),
      txid_or_gtid: gtid,
    });
  }
}
