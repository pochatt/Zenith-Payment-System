/**
 * @file HTLC Auth approval (payer-side accept). Reserves funds, mints preimage,
 *       and creates the HTLC contract + transaction via the canonical state
 *       machine entry path (RECEIVED → HTLC_LOCKED).
 *
 * Earlier revisions inserted Transactions directly at `HTLC_LOCKED`, which
 * bypassed the canonical `RECEIVED` entry, skipped ALLOWED_TRANSITIONS
 * validation, and lost the `PaymentInitiated` audit event. Capture (claimHtlc)
 * later CAS-updates `WHERE state='HTLC_LOCKED'`, so any drift in the entry
 * state produced silent payee non-credit (regression fixed in
 * `test/integration/balance_invariants.test.ts`).
 *
 * This implementation:
 *   1. INSERTs the Transactions row at `RECEIVED` and writes the
 *      `PaymentInitiated` audit event.
 *   2. Uses `transitionWithLog` to advance `RECEIVED → HTLC_LOCKED` so the
 *      ALLOWED_TRANSITIONS table is enforced and CAS+log are atomic.
 *
 * @module zc/lanes/htlc_auth/approve
 */
import type { Env, HtlcAuthApproveInput, HtlcAuthRequestRow } from "../../../types";
import { nowISO } from "../../../types";
import { newUUID } from "../../../shared/idempotency";
import { sha256hex } from "../../../shared/hmac";
import { callBankReserveFunds } from "../../orchestrator";
import { logTxEvent } from "../../trace";
import { transitionWithLog, insertTxWithLog } from "../_helpers";

/**
 * 送金側（顧客）がオーソリを承認する。
 * POST /api/htlc/auth/:auth_id/approve
 *   1. preimage + hashlock を生成して Vault に保管
 *   2. 送金側銀行に資金予約をかける
 *   3. Transactions を RECEIVED で INSERT（canonical entry）
 *   4. RECEIVED → HTLC_LOCKED へ `transitionWithLog` で遷移
 *      （ALLOWED_TRANSITIONS チェック + FinalityLog 同時記録）
 */
export async function approveAuthRequest(
  authId: string,
  req: HtlcAuthApproveInput,
  env: Env
): Promise<{
  result: "APPROVED" | "ERROR";
  htlc_id?: string;
  hashlock?: string;
  reason_code?: string;
}> {
  const db = env.DB;
  const now = nowISO();

  const authReq = await db
    .prepare(`SELECT * FROM HtlcAuthRequests WHERE auth_id=?`)
    .bind(authId)
    .first<HtlcAuthRequestRow>();

  if (!authReq) return { result: "ERROR", reason_code: "AUTH_NOT_FOUND" };
  if (authReq.status !== "AUTH_REQUESTED") {
    return { result: "ERROR", reason_code: "INVALID_AUTH_STATE" };
  }

  // 承認期限チェック
  if (new Date(authReq.auth_expires_at) <= new Date(now)) {
    await db
      .prepare(`UPDATE HtlcAuthRequests SET status='EXPIRED', updated_at=? WHERE auth_id=?`)
      .bind(now, authId)
      .run();
    return { result: "ERROR", reason_code: "AUTH_EXPIRED" };
  }

  // preimage 生成 → Vault に保管
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const preimage = Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const hashlock = await sha256hex(preimage);

  const vaultRef = `VLT-AUTH-${newUUID()}`;
  const vaultExpiresAt = new Date(
    Date.parse(authReq.capture_expires_at) + 60 * 60 * 1000
  ).toISOString();
  await db
    .prepare(
      `INSERT INTO Vault (vault_ref, txid, data_type, payload_json, expires_at, is_evicted, created_at)
     VALUES (?, NULL, 'HTLC_PREIMAGE', ?, ?, 0, ?)`
    )
    .bind(vaultRef, JSON.stringify({ preimage, auth_id: authId }), vaultExpiresAt, now)
    .run();

  // 送金側銀行に資金予約
  const htlcId = `HAUTH-${authId}`;
  const txid = `TX-HAUTH-${authId}`;
  const requestId = `RESERVE-AUTH-${authId}`;

  const reserveResp = await callBankReserveFunds(
    authReq.payer_bank_id,
    {
      request_id: requestId,
      txid,
      amount: { value: authReq.amount_value, currency: "JPY" },
      account_hash: authReq.payer_account_hash,
    },
    env
  );

  if (reserveResp.result !== "RESERVED") {
    await logTxEvent(db, {
      txid,
      actor: `BANK_${authReq.payer_bank_id}`,
      action: "RESERVE_FUNDS",
      status: "NG",
      reason_code: (reserveResp as { reason_code?: string }).reason_code,
      amount: authReq.amount_value,
      bank_id: authReq.payer_bank_id,
    });
    return {
      result: "ERROR",
      reason_code: (reserveResp as { reason_code?: string }).reason_code ?? "RESERVE_FAILED",
    };
  }

  // Step 1: canonical entry — INSERT Transactions at RECEIVED, write the
  // PaymentInitiated audit event, and create the HtlcContracts row in one
  // atomic batch. The H reservation is already held by the bank's suspense
  // account (reserve-funds above), so ZC does not allocate an H_RESERVED row;
  // the lane goes RECEIVED → HTLC_LOCKED directly per ALLOWED_TRANSITIONS.
  await insertTxWithLog(db, {
    txid,
    lane: "HTLC",
    initialState: "RECEIVED",
    amount: { value: authReq.amount_value, currency: "JPY" },
    payerBankId: authReq.payer_bank_id,
    payerAccountHash: authReq.payer_account_hash,
    payeeBankId: authReq.payee_bank_id,
    payeeAccountHash: authReq.payee_account_hash,
    idempotencyKey: req.idempotency_key,
    eventType: "PaymentInitiated",
    payload: { txid, lane: "HTLC", flow: "HTLC_AUTH", auth_id: authId },
    sideUpdates: [
      {
        // HtlcContracts は HTLC_LOCKED で作成しておき、Step 2 の Transactions
        // 遷移 (RECEIVED → HTLC_LOCKED) と整合させる。claimHtlc がリードする
        // hashlock/timelock を確実に提供するため Transactions より先に存在させる。
        sql: `INSERT OR IGNORE INTO HtlcContracts
            (htlc_id, txid, state, hashlock, timelock, amount_value,
             payer_bank_id, payee_bank_id, secret_verified, authority_recheck_required,
             version, created_at, updated_at)
            VALUES (?, ?, 'HTLC_LOCKED', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
        binds: [
          htlcId,
          txid,
          hashlock,
          authReq.capture_expires_at,
          authReq.amount_value,
          authReq.payer_bank_id,
          authReq.payee_bank_id,
          now,
          now,
        ],
      },
    ],
  });

  // Step 2: RECEIVED → HTLC_LOCKED via the canonical helper.
  // ALLOWED_TRANSITIONS contains this edge (state_machine.ts: RECEIVED → HTLC_LOCKED),
  // so the validator allows it and the CAS+log batch is atomic.
  const transition = await transitionWithLog(db, {
    txid,
    fromState: "RECEIVED",
    toState: "HTLC_LOCKED",
    eventType: "HtlcAuthApproved",
    payload: { auth_id: authId, htlc_id: htlcId, hashlock },
  });
  if (!transition.applied) {
    // INSERT OR IGNORE meant Transactions already existed in a non-RECEIVED
    // state — surface as INVALID_AUTH_STATE rather than partially proceeding.
    return { result: "ERROR", reason_code: "INVALID_AUTH_STATE" };
  }

  // HtlcAuthRequests を AUTH_APPROVED に更新
  await db
    .prepare(
      `UPDATE HtlcAuthRequests
     SET status='AUTH_APPROVED', htlc_id=?, txid=?, vault_ref=?, hashlock=?,
         approved_at=?, updated_at=?, version=version+1
     WHERE auth_id=? AND status='AUTH_REQUESTED'`
    )
    .bind(htlcId, txid, vaultRef, hashlock, now, now, authId)
    .run();

  await logTxEvent(db, {
    txid,
    actor: `BANK_${authReq.payer_bank_id}`,
    action: "HTLC_AUTH_APPROVED",
    status: "OK",
    amount: authReq.amount_value,
    bank_id: authReq.payer_bank_id,
    details: { auth_id: authId, htlc_id: htlcId, reservation_ref: reserveResp.reservation_ref },
  });

  return { result: "APPROVED", htlc_id: htlcId, hashlock };
}
