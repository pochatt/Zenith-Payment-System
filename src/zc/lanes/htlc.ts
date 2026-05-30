/**
 * @file Hash-Time-Locked Contract lane processing. Hash Time-Locked Contract creation, locking, and
 *       preimage-based claim.
 *
 * The canonical Transactions state machine is layered on top of the
 * HtlcContracts side-table state. Every Transactions advance now flows through
 * `transitionWithLog` so the ALLOWED_TRANSITIONS table is enforced and the
 * CAS UPDATE is atomically batched with its FinalityLog INSERT. HtlcContracts
 * updates ride in the same `db.batch()` via `setColumns`-style side updates
 * where they are part of the same logical transition.
 *
 * @module zc/lanes/htlc
 */
import type {
  Env,
  HtlcCreateRequest,
  HtlcClaimRequest,
  HtlcContractRow,
  ReleaseReserveRequest,
} from "../../types";
import { nowISO } from "../../types";
import { reserveH, lockH } from "../h_model";
import {
  writeFinalityLog,
  callBankAuthorityCheck,
  callBankExecuteDebit,
  callBankReleaseReserve,
  onPayerExecConfirmed,
  suspendTx,
} from "../orchestrator";
import { transitionWithLog, cancelInFlightTx, insertTxWithLog } from "./_helpers";
import { newDecisionProofRef, newFinalityLogRef } from "../../shared/proof";
import { sha256hex } from "../../shared/hmac";
import { getOrCreateDnsCycle } from "../dns";

/** ランダムなpreimageを生成（32バイト hex） */
async function generatePreimage(): Promise<string> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash-Time-Locked Contract新規作成。
 * Transactions は RECEIVED で挿入し、HtlcContracts は Hash-Time-Locked Contract_RECEIVED で並走させる。
 * lockHtlc キュー処理で RECEIVED → Hash-Time-Locked Contract_LOCKED に遷移する。
 */
export async function createHtlc(
  req: HtlcCreateRequest,
  env: Env
): Promise<{
  result: "CREATED" | "ERROR";
  htlc_id?: string;
  state?: string;
  reason_code?: string;
  hashlock?: string;
  preimage?: string;
}> {
  const db = env.DB;
  const now = nowISO();
  const txid = `TX-Hash-Time-Locked Contract-${req.htlc_id}`;

  // ハッシュを自動生成（ユーザーがhashlockを指定していない場合）
  let hashlock = req.hashlock;
  let preimage: string | undefined;
  if (!hashlock || hashlock === "") {
    preimage = await generatePreimage();
    hashlock = await sha256hex(preimage);
  }

  // canonical RECEIVED 入口で Transactions を作成。HtlcContracts INSERT と
  // FinalityLog INSERT を同一 db.batch() に統合し、「行はあるが audit が無い」窓を消す。
  await insertTxWithLog(db, {
    txid,
    lane: "Hash-Time-Locked Contract",
    initialState: "RECEIVED",
    amount: { value: req.amount.value, currency: "JPY" },
    payerBankId: req.payer_bank_id,
    payerAccountHash: req.payer_account_hash,
    payeeBankId: req.payee_bank_id,
    payeeAccountHash: req.payee_account_hash,
    idempotencyKey: req.idempotency_key,
    eventType: "HtlcCreated",
    payload: { htlc_id: req.htlc_id, hashlock, timelock: req.timelock },
    sideUpdates: [
      {
        sql: `INSERT OR IGNORE INTO HtlcContracts
            (htlc_id, txid, state, hashlock, timelock, amount_value,
             payer_bank_id, payee_bank_id, secret_verified, authority_recheck_required,
             version, created_at, updated_at)
            VALUES (?, ?, 'Hash-Time-Locked Contract_RECEIVED', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
        binds: [
          req.htlc_id,
          txid,
          hashlock,
          req.timelock,
          req.amount.value,
          req.payer_bank_id,
          req.payee_bank_id,
          now,
          now,
        ],
      },
    ],
  });

  // 非同期で H予約 & Lock
  await env.QUEUE.send({
    type: "ZC_BANK_RESERVE",
    payload: { htlc_id: req.htlc_id, txid },
    txid,
    attempt: 0,
    enqueued_at: now,
  });

  return { result: "CREATED", htlc_id: req.htlc_id, state: "Hash-Time-Locked Contract_RECEIVED", hashlock, preimage };
}

/**
 * Hash-Time-Locked Contract Lock処理（QueueConsumerから呼ばれる）
 * Transactions: RECEIVED → Hash-Time-Locked Contract_LOCKED
 * HtlcContracts: Hash-Time-Locked Contract_RECEIVED → Hash-Time-Locked Contract_LOCKED（バッチ内 side update で同期）
 */
export async function lockHtlc(htlcId: string, env: Env): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(htlcId)
    .first<HtlcContractRow>();
  if (!htlc || htlc.state !== "Hash-Time-Locked Contract_RECEIVED") return;

  // timelock が過去なら即キャンセル（銀行サスペンス未作成のため env 不要）
  if (new Date(htlc.timelock) < new Date(now)) {
    await cancelHtlc(htlcId, htlc.txid, "TIMELOCK_EXPIRED", db);
    return;
  }

  // H予約 (ZC側)
  const hResult = await reserveH(htlc.payer_bank_id, htlc.txid, htlc.amount_value, db);
  if (!hResult.ok) {
    await cancelHtlc(htlcId, htlc.txid, hResult.reason, db);
    return;
  }
  const reservationId = hResult.reservation_id;

  // Bank側 reserve-funds
  const txForPayer = await db
    .prepare(`SELECT payer_account_hash FROM Transactions WHERE txid = ?`)
    .bind(htlc.txid)
    .first<{ payer_account_hash: string | null }>();
  const { callBankReserveFunds } = await import("../orchestrator");
  const reserveResult = await callBankReserveFunds(
    htlc.payer_bank_id,
    {
      request_id: `RESERVE-${htlc.txid}`,
      txid: htlc.txid,
      amount: { value: htlc.amount_value, currency: "JPY" },
      account_hash: txForPayer?.payer_account_hash ?? "",
    },
    env
  );
  if (reserveResult.result === "ERROR") {
    await cancelHtlc(htlcId, htlc.txid, reserveResult.reason_code ?? "RESERVE_FAILED", db);
    return;
  }

  // Transactions: RECEIVED → Hash-Time-Locked Contract_LOCKED via transitionWithLog (validates + atomic log).
  // HtlcContracts UPDATE rides in the same db.batch() via sideUpdates so the
  // two state rows commit-or-rollback together — eliminating the window where
  // Transactions = Hash-Time-Locked Contract_LOCKED but HtlcContracts is still Hash-Time-Locked Contract_RECEIVED.
  await transitionWithLog(db, {
    txid: htlc.txid,
    fromState: "RECEIVED",
    toState: "Hash-Time-Locked Contract_LOCKED",
    eventType: "HtlcLocked",
    payload: { htlc_id: htlcId, reservation_id: reservationId },
    setColumns: { h_reservation_id: reservationId },
    sideUpdates: [
      {
        sql: `UPDATE HtlcContracts SET state='Hash-Time-Locked Contract_LOCKED', version=version+1, updated_at=? WHERE htlc_id=? AND state='Hash-Time-Locked Contract_RECEIVED'`,
        binds: [now, htlcId],
      },
    ],
  });
}

/**
 * preimage 提示: Hash-Time-Locked Contract_LOCKED → Hash-Time-Locked Contract_FULFILL_REQUESTED → DECIDED_TO_SETTLE
 */
export async function claimHtlc(
  req: HtlcClaimRequest,
  env: Env
): Promise<{
  result: "ACCEPTED" | "REJECTED";
  htlc_id: string;
  state: string;
  reason_code?: string;
}> {
  const db = env.DB;
  const now = nowISO();

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(req.htlc_id)
    .first<HtlcContractRow>();

  if (!htlc)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "NOT_FOUND",
      reason_code: "NOT_FOUND",
    };
  if (htlc.state !== "Hash-Time-Locked Contract_LOCKED")
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "INVALID_STATE",
    };

  // timelock 期限確認
  if (new Date(htlc.timelock) < new Date(now)) {
    await cancelHtlc(req.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "DECIDED_CANCEL",
      reason_code: "TIMELOCK_EXPIRED",
    };
  }

  // preimage 検証
  const computedHash = await sha256hex(req.preimage);
  if (computedHash !== htlc.hashlock) {
    // 検証失敗を FinalityLog に記録（実 preimage は出さない）
    await writeFinalityLog(db, {
      txid: htlc.txid,
      event_type: "HtlcClaimRejected",
      state_from: "Hash-Time-Locked Contract_LOCKED",
      state_to: "Hash-Time-Locked Contract_LOCKED",
      payload_json: JSON.stringify({
        htlc_id: req.htlc_id,
        reason_code: "INVALID_PREIMAGE",
        computed_hash_prefix: computedHash.slice(0, 8) + "…",
      }),
      txid_or_gtid: htlc.txid,
    });
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "INVALID_PREIMAGE",
    };
  }

  // timelockが翌日以降 → AML recheck
  const endOfToday = new Date(now.slice(0, 10) + "T23:59:59Z");
  const needsRecheck = new Date(htlc.timelock) > endOfToday;
  if (needsRecheck) {
    const recheckResult = await callBankAuthorityCheck(
      htlc.payer_bank_id,
      {
        request_id: `RECHECK-${htlc.txid}`,
        txid: htlc.txid,
        check_type: "RECHECK",
      },
      env
    );
    if (recheckResult.result === "NG") {
      await cancelHtlc(req.htlc_id, htlc.txid, "RECHECK_AUTHORITY_NG", db, env);
      return {
        result: "REJECTED",
        htlc_id: req.htlc_id,
        state: "DECIDED_CANCEL",
        reason_code: "RECHECK_AUTHORITY_NG",
      };
    }
  }

  // Hash-Time-Locked Contract_LOCKED → Hash-Time-Locked Contract_FULFILL_REQUESTED via transitionWithLog. HtlcContracts
  // CAS rides in the same batch so the two state rows stay in lockstep.
  const fulfillReq = await transitionWithLog(db, {
    txid: htlc.txid,
    fromState: "Hash-Time-Locked Contract_LOCKED",
    toState: "Hash-Time-Locked Contract_FULFILL_REQUESTED",
    eventType: "HtlcFulfillRequested",
    payload: { htlc_id: req.htlc_id },
    sideUpdates: [
      {
        sql: `UPDATE HtlcContracts SET state='Hash-Time-Locked Contract_FULFILL_REQUESTED', version=version+1, updated_at=? WHERE htlc_id=? AND state='Hash-Time-Locked Contract_LOCKED'`,
        binds: [now, req.htlc_id],
      },
    ],
  });
  if (!fulfillReq.applied) {
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: fulfillReq.previousState ?? "NOT_FOUND",
      reason_code: "INVALID_STATE",
    };
  }

  // dns_cycle_id 設定
  const decisionProofRef = newDecisionProofRef();
  const finalityLogRef = newFinalityLogRef();
  const dnsCycleId = await getOrCreateDnsCycle(db, now);

  // Hash-Time-Locked Contract_FULFILL_REQUESTED → DECIDED_TO_SETTLE. HtlcContracts CAS (and the
  // secret_verified flip) is appended as a side update so it commits atomically
  // with the canonical state advance.
  const decided = await transitionWithLog(db, {
    txid: htlc.txid,
    fromState: "Hash-Time-Locked Contract_FULFILL_REQUESTED",
    toState: "DECIDED_TO_SETTLE",
    eventType: "DecidedToSettle",
    payload: { htlc_id: req.htlc_id, decision_proof_ref: decisionProofRef },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
      dns_cycle_id: dnsCycleId,
    },
    sideUpdates: [
      {
        sql: `UPDATE HtlcContracts SET state='DECIDED_TO_SETTLE', secret_verified=1, version=version+1, updated_at=? WHERE htlc_id=? AND state='Hash-Time-Locked Contract_FULFILL_REQUESTED'`,
        binds: [now, req.htlc_id],
      },
    ],
  });
  if (decided.applied) {
    // lockH は DECIDED_TO_SETTLE 遷移成功後に実行
    const txForH = await db
      .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
      .bind(htlc.txid)
      .first<{ h_reservation_id: string | null }>();
    if (txForH?.h_reservation_id) {
      await lockH(txForH.h_reservation_id, db);
    }
  }

  // Hash-Time-Locked Contract は timelock があるため、キューの遅延リスクを避けて同期的に debit を実行する
  const bankResp = await callBankExecuteDebit(
    htlc.payer_bank_id,
    {
      request_id: `DEBIT-${htlc.txid}`,
      txid: htlc.txid,
      amount: { value: htlc.amount_value, currency: "JPY" },
      decision_proof_ref: decisionProofRef,
    },
    env
  );

  if (bankResp.result === "OK") {
    await onPayerExecConfirmed(htlc.txid, JSON.stringify(bankResp.bank_proof_ref), env);
    return { result: "ACCEPTED", htlc_id: req.htlc_id, state: "PAYER_EXEC_CONFIRMED" };
  } else {
    await suspendTx(htlc.txid, "EXEC_DEBIT_FAILED", db);
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "SUSPENDED",
      reason_code: "EXEC_DEBIT_FAILED",
    };
  }
}

/**
 * Cancel an Hash-Time-Locked Contract contract and its linked transaction.
 *
 * The dual-table CAS (HtlcContracts + Transactions) and H release order are
 * delegated to `cancelInFlightTx` — the canonical Transactions UPDATE is the
 * primary commit, HtlcContracts is a side update inside the same batch.
 */
export async function cancelHtlc(
  htlcId: string,
  txid: string,
  reasonCode: string,
  db: D1Database,
  env?: Env
): Promise<void> {
  const now = nowISO();
  const txForH = await db
    .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ h_reservation_id: string | null }>();

  const cancelled = await cancelInFlightTx(db, {
    txid,
    reasonCode,
    fromStates: ["RECEIVED", "Hash-Time-Locked Contract_LOCKED", "Hash-Time-Locked Contract_FULFILL_REQUESTED"],
    eventType: "HtlcCancelled",
    payloadExtra: { htlc_id: htlcId },
    sideUpdates: [
      {
        sql: `UPDATE HtlcContracts SET state='DECIDED_CANCEL', version=version+1, updated_at=?
            WHERE htlc_id=? AND state NOT IN ('DECIDED_TO_SETTLE','SETTLED')`,
        binds: [now, htlcId],
      },
    ],
  });

  if (!cancelled) {
    console.warn(
      `[cancelHtlc] state guard prevented cancel for htlc_id=${htlcId} (already settled or decided)`
    );
    return;
  }

  // Hash-Time-Locked Contract_LOCKED 時点で reserve-funds 済みのため、銀行側の別段預金も解放する。
  if (env) {
    const htlcRow = await db
      .prepare(`SELECT payer_bank_id FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ payer_bank_id: string }>();
    if (htlcRow) {
      const suspense = await db
        .prepare(
          `SELECT suspense_id FROM SuspenseDetails WHERE txid=? AND bank_id=? AND status='RESERVED' AND direction='PAY' LIMIT 1`
        )
        .bind(txid, htlcRow.payer_bank_id)
        .first<{ suspense_id: string }>();
      await callBankReleaseReserve(
        htlcRow.payer_bank_id,
        {
          request_id: `Hash-Time-Locked Contract-CANCEL-${htlcId}`,
          txid,
          reservation_ref: suspense?.suspense_id ?? txForH?.h_reservation_id ?? "",
        } as ReleaseReserveRequest,
        env
      ).catch((e) => console.error(`[cancelHtlc] bank release-reserve failed for ${htlcId}:`, e));
    }
  }
}
