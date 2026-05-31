/**
 * @file ingress.ts — ZC Ingress API handlers (POST /api/transfers, /api/htlc, etc.)
 *
 * This module is the primary entry point for all external payment requests
 * into the Zenith Coordinator. It handles:
 *  - Payment initiation (all lanes: EXPRESS, STANDARD, BULK, HIGH_VALUE, etc.)
 *  - HTLC creation and claim (hash time-locked contracts)
 *  - HTLC Auth (payee-initiated authorization flow)
 *  - GTID registration (coordinated multi-leg transactions)
 *  - RTP request (Request-to-Pay)
 *  - Transfer authorization and cancellation
 *  - Participant/bank management and seed data initialization
 *  - Simulator large-scale setup (20 banks × 200 accounts)
 *
 * All endpoints enforce idempotency via the IdempotencyKeys table.
 * Cross-border transfers are validated against FATF R.16 compliance rules.
 *
 * @module zc/ingress
 */
import type {
  Env,
  PaymentInitiatedRequest,
  HtlcCreateRequest,
  HtlcClaimRequest,
  GtidRegisterRequest,
  RtpRequestInput,
  TransferAuthorizeRequest,
  TransferCancelRequest,
} from "../types";
import { nowISO } from "../types";
import {
  parseBody,
  validatePaymentInitiated,
  validateHtlcCreate,
  validateHtlcClaim,
  validateGtidRegister,
  validateRtpRequest,
} from "../shared/validator";
import {
  acquireIdempotency,
  completeIdempotency,
  getIdempotentResponse,
  newUUID,
} from "../shared/idempotency";
import { processExpress } from "./lanes/express";
import {
  processStandardIngress,
  advanceStandard,
  authorizeStandard,
  resumeFromNameCheckSuspended,
} from "./lanes/standard";
import { processBulkIngress, advanceBulk } from "./lanes/bulk";
import { createHtlc, claimHtlc } from "./lanes/htlc";
import {
  createAuthRequest,
  approveAuthRequest,
  declineAuthRequest,
  captureHtlcAuth,
  voidHtlcAuth,
  registerAuthWhitelist,
  revokeAuthWhitelist,
  listAuthWhitelist,
  getAuthRequest,
  listAuthRequests,
} from "./lanes/htlc_auth";
import type { HtlcAuthRequestInput, HtlcAuthWhitelistRegisterRequest } from "../types";
import { registerGtid } from "./lanes/gtid";
import { registerRtp, registerRtpRequest, attemptRtp } from "./lanes/rtp";
import { processHighValueIngress, advanceHighValue } from "./lanes/highvalue";
import { releaseH } from "./h_model";
import { writeFinalityLog, callBankReleaseReserve, finalizeCancelledTx } from "./orchestrator";
import { cancelInFlightTx } from "./lanes/_helpers";
import { linkEdiToTransaction } from "./edi";
import { resolveProxy } from "./proxy";
import { validateFatfR16 } from "../shared/fatf_validator";

// ---------------------------------------------------------------------------
// POST /api/transfers
// ---------------------------------------------------------------------------
export async function handlePostTransfers(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<PaymentInitiatedRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "Request body must be valid JSON");

  // Proxy resolution: resolve alias (phone/email/national_id) to account_hash
  if (body.proxy_type && body.proxy_value && !body.payee.account_hash) {
    const proxyResult = await resolveProxy(env.DB, body.proxy_type, body.proxy_value);
    if (!proxyResult)
      return jsonError(
        422,
        "PROXY_NOT_FOUND",
        `proxy ${body.proxy_type}:${body.proxy_value} not found`
      );
    body.payee.account_hash = "h:" + proxyResult.account_id;
    if (!body.payee.bank_id) body.payee.bank_id = proxyResult.bank_id;
  }

  const validation = validatePaymentInitiated(body);
  if (!validation.ok) return jsonError(400, validation.reason_code!, validation.message!);

  // FATF R.16 validation for all cross-border lanes (not just HIGH_VALUE)
  if (body.is_cross_border === 1 || body.is_cross_border === true) {
    if (!body.fatf_data)
      return jsonError(
        400,
        "FATF_DATA_REQUIRED",
        "fatf_data is required for cross-border transfers"
      );
    const fatfValidation = validateFatfR16(body.fatf_data);
    if (!fatfValidation.valid)
      return jsonError(400, "FATF_VALIDATION_FAILED", fatfValidation.errors.join("; "));
  }

  const db = env.DB;
  const idempKey = body.idempotency_key;
  const acquired = await acquireIdempotency(idempKey, db);
  if (!acquired) {
    const existing = await getIdempotentResponse(idempKey, db);
    return json(200, existing);
  }

  // Amount limit check / RECEIVE_ONLY participation mode check
  // If migration is not applied and 'no such column' error occurs, log details and fallback
  let participant: {
    tx_amount_limit?: number | null;
    daily_amount_limit?: number | null;
    daily_amount_used?: number;
    daily_amount_last_reset_date?: string | null;
    participation_mode?: string | null;
    hv_threshold?: number | null;
  } | null = null;
  try {
    participant = await db
      .prepare(
        `SELECT tx_amount_limit, daily_amount_limit, daily_amount_used, daily_amount_last_reset_date, participation_mode, hv_threshold FROM Participants WHERE bank_id = ?`
      )
      .bind(body.payer.bank_id)
      .first<{
        tx_amount_limit: number | null;
        daily_amount_limit: number | null;
        daily_amount_used: number;
        daily_amount_last_reset_date: string | null;
        participation_mode: string | null;
        hv_threshold: number | null;
      }>();
  } catch (e: any) {
    if (e.message && e.message.includes("no such column")) {
      // If migration not applied: limits not enforced, no RECEIVE_ONLY check
      console.error(
        `[ingress] Schema incomplete: missing columns in Participants table. Migration 0010+ may not have been applied. Error: ${e.message}`
      );
      participant = {
        tx_amount_limit: null,
        daily_amount_limit: null,
        daily_amount_used: 0,
        participation_mode: null,
        hv_threshold: null,
      };
    } else {
      throw e;
    }
  }

  // Receive-only participating banks cannot initiate fund transfer
  if (participant?.participation_mode === "RECEIVE_ONLY") {
    await completeIdempotency(
      idempKey,
      { result: "REJECTED", reason_code: "PARTICIPATION_MODE_RECEIVE_ONLY" },
      db
    );
    return jsonError(
      422,
      "PARTICIPATION_MODE_RECEIVE_ONLY",
      `bank ${body.payer.bank_id} is registered as RECEIVE_ONLY and cannot initiate transfers`
    );
  }

  if (participant?.tx_amount_limit != null && body.amount.value > participant.tx_amount_limit) {
    await completeIdempotency(
      idempKey,
      { result: "REJECTED", reason_code: "AMOUNT_EXCEEDS_TX_LIMIT" },
      db
    );
    return jsonError(
      422,
      "AMOUNT_EXCEEDS_TX_LIMIT",
      `amount ${body.amount.value} exceeds per-transaction limit ${participant.tx_amount_limit}`
    );
  }

  if (participant?.daily_amount_limit != null) {
    // Atomic limit gate (same shape as h_used in h_model.ts). daily_amount_used
    // is intentionally kept as a materialized counter rather than derived from
    // SUM(today's transactions) — a SUM-then-check would race under concurrent
    // payments. Reset is handled in the EOD cron and the per-request first-of-
    // day branch below.
    let success = false;
    try {
      const today = nowISO().slice(0, 10); // 'YYYY-MM-DD'

      // Even if EOD cron fails, auto-reset on first request of day
      // daily_amount_last_reset_date が今日以前であれば used を 0 にリセットしてから加算。
      // Date check + addition in 1 statement to prevent TOCTOU
      if (participant.daily_amount_last_reset_date !== today) {
        const upd = await db
          .prepare(
            `UPDATE Participants
           SET daily_amount_used = ?, daily_amount_last_reset_date = ?
           WHERE bank_id = ? AND daily_amount_last_reset_date IS NOT ? AND ? <= daily_amount_limit`
          )
          .bind(body.amount.value, today, body.payer.bank_id, today, body.amount.value)
          .run();
        success = upd.meta.changes > 0;
        if (!success) {
          // Another isolate already reset and incremented — fall through to normal increment.
          const upd2 = await db
            .prepare(
              `UPDATE Participants SET daily_amount_used = daily_amount_used + ?
             WHERE bank_id = ? AND daily_amount_used + ? <= daily_amount_limit`
            )
            .bind(body.amount.value, body.payer.bank_id, body.amount.value)
            .run();
          success = upd2.meta.changes > 0;
        }
      } else {
        // atomicに加算し、超過時は rows=0 になる
        const upd = await db
          .prepare(
            `UPDATE Participants SET daily_amount_used = daily_amount_used + ?
           WHERE bank_id = ? AND daily_amount_used + ? <= daily_amount_limit`
          )
          .bind(body.amount.value, body.payer.bank_id, body.amount.value)
          .run();
        success = upd.meta.changes > 0;
      }
    } catch (e: any) {
      if (e.message && e.message.includes("no such column")) {
        // If schema incomplete: warn, continue unrestricted (dev convenience)
        console.error(
          `[ingress] Schema incomplete: daily_amount_used column missing. Migration 0010+ may not have been applied. Daily limits will be ignored. Error: ${e.message}`
        );
        success = true;
      } else {
        throw e;
      }
    }

    if (!success) {
      await completeIdempotency(
        idempKey,
        { result: "REJECTED", reason_code: "DAILY_LIMIT_EXCEEDED" },
        db
      );
      return jsonError(
        422,
        "DAILY_LIMIT_EXCEEDED",
        "daily transfer limit exceeded for this participant"
      );
    }
  }

  // HIGH_VALUE auto-escalation
  // If amount ≥ threshold in STANDARD/EXPRESS, auto-switch to HIGH_VALUE
  // Threshold priority: bank set > env var > default (100M)
  const DEFAULT_HV_THRESHOLD = 100_000_000;
  const hvThreshold =
    participant?.hv_threshold ??
    (env.ZC_HV_THRESHOLD ? parseInt(env.ZC_HV_THRESHOLD, 10) : null) ??
    DEFAULT_HV_THRESHOLD;
  if ((body.lane === "STANDARD" || body.lane === "EXPRESS") && body.amount.value >= hvThreshold) {
    body.lane = "HIGH_VALUE";
  }

  // Transactions レコード挿入
  const now = nowISO();
  const isCrossBorder = body.is_cross_border === 1 || body.is_cross_border === true ? 1 : 0;
  const fatfDataJson = isCrossBorder && body.fatf_data ? JSON.stringify(body.fatf_data) : null;
  const fatf16Applicable = isCrossBorder && body.fatf_data ? 1 : 0;
  await db
    .prepare(
      `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      pspr_ref, purpose, idempotency_key, schema_version, expires_at,
      is_cross_border, fatf_data_json, fatf16_applicable,
      version, created_at, updated_at)
     VALUES (?, ?, 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, ?, ?, ?, '1.0', ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      body.txid,
      body.lane,
      body.amount.value,
      body.payer.bank_id,
      body.payer.account_hash,
      body.payee.bank_id,
      body.payee.account_hash ?? null,
      body.pspr_ref ?? null,
      body.purpose,
      idempKey,
      body.expires_at ?? null,
      isCrossBorder,
      fatfDataJson,
      fatf16Applicable,
      now,
      now
    )
    .run();

  await writeFinalityLog(db, {
    txid: body.txid,
    event_type: "PaymentInitiated",
    state_from: null,
    state_to: "RECEIVED",
    payload_json: JSON.stringify({ txid: body.txid, lane: body.lane, amount: body.amount }),
    txid_or_gtid: body.txid,
  });

  let result: unknown;
  switch (body.lane) {
    case "EXPRESS":
      result = await processExpress(body, env);
      break;
    case "STANDARD":
      result = processStandardIngress(body);
      await env.QUEUE.send({
        type: "ZC_STATE_ADVANCE",
        payload: { txid: body.txid, action: "ADVANCE_STANDARD" },
        txid: body.txid,
        attempt: 0,
        enqueued_at: now,
      });
      break;
    case "BULK":
    case "DEFERRED":
      result = processBulkIngress(body);
      await env.QUEUE.send({
        type: "ZC_STATE_ADVANCE",
        payload: { txid: body.txid, action: "ADVANCE_BULK" },
        txid: body.txid,
        attempt: 0,
        enqueued_at: now,
      });
      break;
    case "HIGH_VALUE":
      result = processHighValueIngress(body);
      await env.QUEUE.send({
        type: "ZC_STATE_ADVANCE",
        payload: { txid: body.txid, action: "ADVANCE_HV" },
        txid: body.txid,
        attempt: 0,
        enqueued_at: now,
      });
      break;
    case "RTP":
      result = { result: "INGRESS_ACCEPTED", txid: body.txid, state: "RECEIVED" };
      // RTP: Link RTP invoice and fund transfer TX (REQUESTED → ATTEMPTED)
      if (body.pspr_ref) {
        await attemptRtp(body.pspr_ref, body.txid, env);
      }
      // Proceed settlement in STANDARD flow
      await env.QUEUE.send({
        type: "ZC_STATE_ADVANCE",
        payload: { txid: body.txid, action: "ADVANCE_STANDARD" },
        txid: body.txid,
        attempt: 0,
        enqueued_at: now,
      });
      break;
    case "HTLC":
      // HTLC uses dedicated endpoint POST /api/htlc/create
      await completeIdempotency(
        idempKey,
        { result: "REJECTED", reason_code: "USE_HTLC_ENDPOINT" },
        db
      );
      return jsonError(
        422,
        "USE_HTLC_ENDPOINT",
        "HTLC lane must use POST /api/htlc/create endpoint"
      );
    default:
      result = { result: "INGRESS_ACCEPTED", txid: body.txid, state: "RECEIVED" };
  }

  // EDI linkage: if edi_ref specified, link to transaction
  const bodyAny3 = body as any;
  if (bodyAny3.edi_ref) {
    await linkEdiToTransaction(db, body.txid, bodyAny3.edi_ref).catch((e) =>
      console.error(`[ingress] linkEdiToTransaction failed: ${e}`)
    );
  }

  await completeIdempotency(idempKey, result, db);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/htlc/create
// ---------------------------------------------------------------------------
export async function handlePostHtlcCreate(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<HtlcCreateRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "Request body must be valid JSON");
  const v = validateHtlcCreate(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const acquired = await acquireIdempotency(body.idempotency_key, env.DB);
  if (!acquired) {
    const existing = await getIdempotentResponse(body.idempotency_key, env.DB);
    return json(200, existing);
  }

  const result = await createHtlc(body, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(201, result);
}

// ---------------------------------------------------------------------------
// POST /api/htlc/:htlc_id/claim
// ---------------------------------------------------------------------------
export async function handlePostHtlcClaim(
  req: Request,
  htlcId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<HtlcClaimRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateHtlcClaim(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const acquired = await acquireIdempotency(body.idempotency_key, env.DB);
  if (!acquired) {
    const existing = await getIdempotentResponse(body.idempotency_key, env.DB);
    return json(200, existing);
  }

  const result = await claimHtlc({ ...body, htlc_id: htlcId }, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/gtid/register
// ---------------------------------------------------------------------------
export async function handlePostGtidRegister(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<GtidRegisterRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateGtidRegister(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const acquired = await acquireIdempotency(body.idempotency_key, env.DB);
  if (!acquired) {
    const existing = await getIdempotentResponse(body.idempotency_key, env.DB);
    return json(200, existing);
  }

  const result = await registerGtid(body, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(201, result);
}

// ---------------------------------------------------------------------------
// POST /api/rtp/request
// ---------------------------------------------------------------------------
export async function handlePostRtpRequest(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<RtpRequestInput>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateRtpRequest(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const acquired = await acquireIdempotency(body.idempotency_key, env.DB);
  if (!acquired) {
    const existing = await getIdempotentResponse(body.idempotency_key, env.DB);
    return json(200, existing);
  }

  const result = await registerRtpRequest(
    env.DB,
    body.rtp_id,
    body.payee_bank_id,
    body.payer_bank_id,
    body.amount,
    body.expires_at,
    body.idempotency_key,
    {
      payeeName: body.payee_name,
      description: body.description,
      payeeAccountHash: body.payee_account,
    },
    env
  );
  const resp = {
    result: result.result === "REGISTERED" ? "INGRESS_ACCEPTED" : "DUPLICATE",
    rtp_id: result.rtpId,
    state: "REQUESTED",
  };
  await completeIdempotency(body.idempotency_key, resp, env.DB);
  return json(201, resp);
}

// ---------------------------------------------------------------------------
// POST /api/transfers/:txid/authorize
// ---------------------------------------------------------------------------
export async function handlePostAuthorize(req: Request, txid: string, env: Env): Promise<Response> {
  const body = await parseBody<TransferAuthorizeRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");

  const result = await authorizeStandard(txid, body.authorized ?? false, env);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/transfers/:txid/cancel
// ---------------------------------------------------------------------------
export async function handlePostCancel(req: Request, txid: string, env: Env): Promise<Response> {
  const body = await parseBody<TransferCancelRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");

  const db = env.DB;
  const now = nowISO();
  const tx = await db
    .prepare(
      `SELECT state, h_reservation_id, payer_bank_id, version FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      state: string;
      h_reservation_id: string | null;
      payer_bank_id: string;
      version: number;
    }>();

  if (!tx) return jsonError(404, "NOT_FOUND", `txid ${txid} not found`);

  const cancelableStates = ["RECEIVED", "PRECHECKED", "PRECHECKED_SUSPENDED", "H_RESERVED"];
  if (!cancelableStates.includes(tx.state)) {
    return jsonError(409, "INVALID_STATE", `Cannot cancel tx in state ${tx.state}`);
  }

  // CAS + FinalityLog + H release + finalize consolidated in cancelInFlightTx
  // Only bank suspense release is ingress-specific; call separately
  const cancelled = await cancelInFlightTx(db, {
    txid,
    reasonCode: body.reason_code,
    fromStates: cancelableStates,
  });
  if (!cancelled) {
    return jsonError(
      409,
      "STATE_CONFLICT",
      `Cancel conflict: tx ${txid} was concurrently modified`
    );
  }

  await callBankReleaseReserve(
    tx.payer_bank_id,
    {
      request_id: `CANCEL-${txid}`,
      txid,
      reservation_ref: tx.h_reservation_id ?? txid,
    },
    env
  ).catch((e) => console.error(`[cancel] release-reserve failed: ${e}`));

  return json(200, { result: "CANCELLED", txid, state: "CANCELLED" });
}

// ---------------------------------------------------------------------------
// POST /api/transfers/:txid/resume-namecheck
// ---------------------------------------------------------------------------
export async function handlePostResumeNameCheck(
  req: Request,
  txid: string,
  env: Env
): Promise<Response> {
  const result = await resumeFromNameCheckSuspended(txid, env);
  if (!result.ok) {
    if (result.state === "NOT_FOUND") return jsonError(404, "NOT_FOUND", `txid ${txid} not found`);
    if (result.state === "STATE_CONFLICT")
      return jsonError(409, "STATE_CONFLICT", `Concurrent modification on txid ${txid}`);
    return jsonError(409, "INVALID_STATE", `Cannot resume txid ${txid} in state ${result.state}`);
  }
  return json(200, { result: "RESUMED", txid, state: result.state });
}

// ---------------------------------------------------------------------------
// POST /api/participants/register
// ---------------------------------------------------------------------------
export async function handlePostParticipantRegister(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    bank_id: string;
    bank_name: string;
    ingress_base_url: string;
    h_limit: number;
  }>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");

  const now = nowISO();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`
  )
    .bind(body.bank_id, body.bank_name, body.ingress_base_url, body.h_limit, now)
    .run();

  return json(201, { result: "REGISTERED", bank_id: body.bank_id });
}

// ---------------------------------------------------------------------------
// POST seed Full reset → load initial data
// ---------------------------------------------------------------------------
export async function handleSeed(env: Env): Promise<Response> {
  const db = env.DB;
  const now = nowISO();

  // 1) Delete all tables (ZC → Bank dependency order)
  // Execute individually so continue if table missing
  const deleteTargets = [
    "TxEventLog",
    "BankAuditLog",
    "PaymentApprovalRequests",
    "PaymentFilters",
    "HtlcAuthRequests",
    "HtlcAuthWhitelist",
    "FinalityLog",
    "IdempotencyKeys",
    "Cases",
    "Vault",
    "PsprRegistry",
    "RtpRequests",
    "GtidLegs",
    "GtidTransactions",
    "HtlcContracts",
    "DnsNetPositions",
    "DnsCycles",
    "HReservations",
    "Transactions",
    "Participants",
    "ZcRequests",
    "SuspenseDetails",
    "DailyBalances",
    "BankJournals",
    "BankAccounts",
    "InterestRates",
    // table added in migration 0003+
    "AccountVerifications",
    "CreditNotifications",
    "CrossBorderTransactions",
    "EdiRecords",
    "EventStream",
    "IgsRequests",
    "ProxyDirectory",
    "QrCodes",
    "RichDataStore",
  ];
  // Hardcoded table names only (prevent SQL identifier injection)
  const ALLOWED_TABLES = new Set(deleteTargets);
  for (const t of deleteTargets) {
    if (!ALLOWED_TABLES.has(t) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) continue;
    try {
      await db.prepare(`DELETE FROM "${t}"`).run();
    } catch (e) {
      console.error(`[seed] DELETE FROM ${t} failed (table may not exist):`, e);
    }
  }

  // 2) Load initial data (all-numeric system: BBBAAAAAAA)
  await db.batch([
    // Participants（ZCparticipating bank）
    db
      .prepare(`INSERT INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
      VALUES ('001','長岡銀行','/bank/001',100000000,0,1,?)`)
      .bind(now),
    db
      .prepare(`INSERT INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
      VALUES ('002','尾張銀行','/bank/002',100000000,0,1,?)`)
      .bind(now),

    // BankAccounts (3-digit bank code + 7-digit serial; suspense=BBB0000000, ZCS=BBB-ZCS)
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0010000001','001','C001','田中 太郎','SAVINGS','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0010000002','001','C002','佐藤 花子','SAVINGS','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0010000000','001','SYSTEM','別段預金','SUSPENSE','NORMAL','2025-01-01T00:00:00Z')`),
    // ZC settlement (BOJ Checking equiv): negative = ZC owes (bank asset)
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('001-ZCS','001','SYSTEM','ZC清算勘定','SETTLEMENT','NORMAL','2025-01-01T00:00:00Z')`),
    // Cash account
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('001-CASH','001','SYSTEM','現金','ASSET','NORMAL','2025-01-01T00:00:00Z')`),
    // BOJ deposit account 001
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('001-BOJ','001','BOJ','日本銀行（預け金勘定）','BOJ','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0020000001','002','C003','鈴木 一郎','SAVINGS','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0020000002','002','C004','山田 美咲','SAVINGS','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0020000000','002','SYSTEM','別段預金','SUSPENSE','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('002-ZCS','002','SYSTEM','ZC清算勘定','SETTLEMENT','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('002-CASH','002','SYSTEM','現金','ASSET','NORMAL','2025-01-01T00:00:00Z')`),
    // BOJ deposit account 002
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('002-BOJ','002','BOJ','日本銀行（預け金勘定）','BOJ','NORMAL','2025-01-01T00:00:00Z')`),

    // BankJournals (init: 1M yen each)
    // Zero-sum: customer account(+) / ZC settlement(−) pair
    //   ZCS(−) = 'ZC owes 2M' = bank's settlement asset (BOJ current equiv)
    //   Suspense starts 0 (balance moves only during fund transfer; intermediate account)
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-1','001','0010000001',1000000,'CASH','INIT-001','初期残高','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-1X','001','001-ZCS',-1000000,'CASH','INIT-001','初期ZC清算残高 offset','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-2','001','0010000002',1000000,'CASH','INIT-001','初期残高','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-2X','001','001-ZCS',-1000000,'CASH','INIT-001','初期ZC清算残高 offset','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-1','002','0020000001',1000000,'CASH','INIT-002','初期残高','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-1X','002','002-ZCS',-1000000,'CASH','INIT-002','初期ZC清算残高 offset','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-2','002','0020000002',1000000,'CASH','INIT-002','初期残高','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-2X','002','002-ZCS',-1000000,'CASH','INIT-002','初期ZC清算残高 offset','2025-01-01','2025-01-01T00:00:00Z')`),

    // BOJ initial prefunding (HIGH_VALUE RTGS: 100 billion per bank)
    // Zero-sum: BOJ(-1000B) / ZCS(+1000B) pairing
    // calcBalance negative = balance exists. Positive = BOJ_INSUFFICIENT_FUNDS
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-BOJ','001','001-BOJ',-100000000000,'CASH','INIT-001-BOJ','BOJ初期プレファンド','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-BOJZCS','001','001-ZCS',100000000000,'CASH','INIT-001-BOJ','BOJ初期ZCS対当','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-BOJ','002','002-BOJ',-100000000000,'CASH','INIT-002-BOJ','BOJ初期プレファンド','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-BOJZCS','002','002-ZCS',100000000000,'CASH','INIT-002-BOJ','BOJ初期ZCS対当','2025-01-01','2025-01-01T00:00:00Z')`),

    // InterestRates
    db.prepare(`INSERT INTO InterestRates (rate_id,bank_id,account_type,annual_rate,effective_from)
      VALUES ('RATE-001-SAVINGS','001','SAVINGS',0.001,'2025-01-01')`),
    db.prepare(`INSERT INTO InterestRates (rate_id,bank_id,account_type,annual_rate,effective_from)
      VALUES ('RATE-002-SAVINGS','002','SAVINGS',0.001,'2025-01-01')`),
  ]);

  return json(200, {
    result: "RESET_AND_SEEDED",
    reset_at: now,
    initial_balance_per_account: 1000000,
  });
}

// ---------------------------------------------------------------------------
// POST /api/banks/add Add new bank
// ---------------------------------------------------------------------------
export async function handleAddBank(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ bank_name: string; h_limit?: number }>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  if (!body.bank_name) return jsonError(400, "INVALID_INPUT", "bank_name required");

  const db = env.DB;
  const now = nowISO();

  // Auto-assign next bank code: max bank_id + 1
  const maxBank = await db
    .prepare(`SELECT bank_id FROM Participants ORDER BY bank_id DESC LIMIT 1`)
    .first<{ bank_id: string }>();
  const nextCode = String(parseInt(maxBank?.bank_id ?? "000", 10) + 1).padStart(3, "0");

  // ZC 側: participating bank登録のみ（account管理はbankの責任）
  await db
    .prepare(
      `INSERT INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`
    )
    .bind(nextCode, body.bank_name, `/bank/${nextCode}`, body.h_limit ?? 100000000, now)
    .run();

  // Bank-side: request init via bank ingress (bank accountable for account mgmt)
  const { handleBankIngress } = await import("../bank/ingress");
  await handleBankIngress(
    nextCode,
    "initialize-bank",
    { request_id: `INIT-BANK-${nextCode}` },
    env
  );

  return json(201, { result: "BANK_CREATED", bank_id: nextCode, bank_name: body.bank_name });
}

// ---------------------------------------------------------------------------
// DELETE /api/banks/:bankId  bankdelete
// ---------------------------------------------------------------------------
export async function handleDeleteBank(bankId: string, env: Env): Promise<Response> {
  const db = env.DB;

  // Confirm no valid transaction
  const activeTx = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM Transactions WHERE (payer_bank_id=? OR payee_bank_id=?) AND state NOT IN ('SETTLED','CANCELLED','FAILED_EXECUTION')`
    )
    .bind(bankId, bankId)
    .first<{ cnt: number }>();
  if (activeTx && activeTx.cnt > 0) {
    return jsonError(
      409,
      "ACTIVE_TRANSACTIONS",
      `Bank ${bankId} has ${activeTx.cnt} active transactions`
    );
  }

  // Bank-side: request delete via bank ingress (bank accountable for account mgmt)
  const { handleBankIngress } = await import("../bank/ingress");
  await handleBankIngress(bankId, "cleanup-bank", {}, env);

  // ZC 側: participating bankデータのみdelete
  await db.batch([
    db.prepare("DELETE FROM SuspenseDetails WHERE bank_id=?").bind(bankId),
    db.prepare("DELETE FROM ZcRequests WHERE bank_id=?").bind(bankId),
    db.prepare("DELETE FROM Participants WHERE bank_id=?").bind(bankId),
  ]);

  return json(200, { result: "BANK_DELETED", bank_id: bankId });
}

// ---------------------------------------------------------------------------
// GET /api/banks  bank一覧
// ---------------------------------------------------------------------------
export async function handleListBanks(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT * FROM Participants ORDER BY bank_id ASC`).all();
  return json(200, { banks: rows.results });
}

// ---------------------------------------------------------------------------
// GET /api/banks/:bankId/accounts  bankの全account（名義confirmation用）
// ---------------------------------------------------------------------------
export async function handleBankAccounts(bankId: string, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT account_id, customer_name, account_type, status FROM BankAccounts WHERE bank_id=? AND account_type != 'SUSPENSE' ORDER BY account_id`
  )
    .bind(bankId)
    .all();
  return json(200, { accounts: rows.results });
}

// ---------------------------------------------------------------------------
// GET /api/accounts/:accountId/name  account名義inquiry（account number→名義人名）
// ---------------------------------------------------------------------------
export async function handleAccountNameLookup(accountId: string, env: Env): Promise<Response> {
  const { bankCodeFromAccount } = await import("../types");
  const bankCode = bankCodeFromAccount(accountId);
  const account = await env.DB.prepare(
    `SELECT account_id, customer_name, bank_id, status, account_type FROM BankAccounts WHERE account_id=? AND bank_id=?`
  )
    .bind(accountId, bankCode)
    .first<{
      account_id: string;
      customer_name: string;
      bank_id: string;
      status: string;
      account_type: string;
    }>();
  if (!account) return jsonError(404, "NOT_FOUND", "account not found");
  // System accounts cannot be transfer destinations
  if (account.account_type !== "SAVINGS") {
    return jsonError(422, "ACCOUNT_NOT_TRANSFERABLE", "this account cannot receive transfers");
  }
  // Also get bank name
  const bank = await env.DB.prepare(`SELECT bank_name FROM Participants WHERE bank_id=?`)
    .bind(bankCode)
    .first<{ bank_name: string }>();
  return json(200, {
    account_id: account.account_id,
    customer_name: account.customer_name,
    bank_id: account.bank_id,
    bank_name: bank?.bank_name ?? "",
    status: account.status,
  });
}

// ---------------------------------------------------------------------------
// POST sim setup Large-scale simulator init
// ---------------------------------------------------------------------------
export async function handleSimSetup(req: Request, env: Env): Promise<Response> {
  const t0 = Date.now();
  let params: { bank_count?: number; accounts_per_bank?: number; personal_ratio?: number } = {};
  try {
    params = await req.json();
  } catch {
    /* use defaults */
  }

  const bankCount = Math.min(params.bank_count ?? 18, 50); // 003~020 (max 50)
  const accountsPerBank = Math.min(params.accounts_per_bank ?? 200, 500); // Max 500
  const personalRatio = Math.max(0, Math.min(params.personal_ratio ?? 0.9, 1));
  const db = env.DB;
  const now = nowISO();
  const today = now.slice(0, 10);

  // Step 1: seed reset (init 001/002)
  const seedReq = new Request("http://internal/internal/seed", { method: "POST" });
  await handleSeed(env); // Ignore return (goal: DB init)

  // Step 2: add banks 003~(002+count)
  // handleAddBank uses 'max+1'; execute sequentially
  const bankIds: string[] = [];
  for (let i = 0; i < bankCount; i++) {
    const maxBank = await db
      .prepare(`SELECT bank_id FROM Participants ORDER BY bank_id DESC LIMIT 1`)
      .first<{ bank_id: string }>();
    const nextCode = String(parseInt(maxBank?.bank_id ?? "000", 10) + 1).padStart(3, "0");
    const bankName = `テスト銀行${nextCode}`;
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
        )
        .bind(nextCode, bankName, `/bank/${nextCode}`, 100_000_000, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, 'SYSTEM', '別段預金', 'SUSPENSE', 'NORMAL', ?)`
        )
        .bind(`${nextCode}0000000`, nextCode, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, 'SYSTEM', 'ZC清算勘定', 'SETTLEMENT', 'NORMAL', ?)`
        )
        .bind(`${nextCode}-ZCS`, nextCode, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, 'SYSTEM', '現金', 'ASSET', 'NORMAL', ?)`
        )
        .bind(`${nextCode}-CASH`, nextCode, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, 'BOJ', '日本銀行（預け金勘定）', 'BOJ', 'NORMAL', ?)`
        )
        .bind(`${nextCode}-BOJ`, nextCode, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO InterestRates (rate_id, bank_id, account_type, annual_rate, effective_from)
         VALUES (?, ?, 'SAVINGS', 0.001, ?)`
        )
        .bind(`RATE-${nextCode}-SAVINGS`, nextCode, today),
      // BOJ initial prefunding (HIGH_VALUE RTGS: 100 billion yen)
      db
        .prepare(
          `INSERT OR IGNORE INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
         VALUES (?, ?, ?, -100000000000, 'CASH', ?, 'BOJ初期プレファンド', ?, ?)`
        )
        .bind(
          `JNL-INIT-${nextCode}-BOJ`,
          nextCode,
          `${nextCode}-BOJ`,
          `INIT-${nextCode}-BOJ`,
          today,
          now
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
         VALUES (?, ?, ?, 100000000000, 'CASH', ?, 'BOJ初期ZCS対当', ?, ?)`
        )
        .bind(
          `JNL-INIT-${nextCode}-BOJZCS`,
          nextCode,
          `${nextCode}-ZCS`,
          `INIT-${nextCode}-BOJ`,
          today,
          now
        ),
    ]);
    bankIds.push(nextCode);
  }

  // Step 3: batch create accounts per bank (+ init deposit)
  // D1 batch ~1000 statements/call; 200 accounts = max 400 stmts → fits 1 bank
  let totalAccounts = 0;
  const personalCount = Math.round(accountsPerBank * personalRatio);
  const corporateCount = accountsPerBank - personalCount;

  const personalNames = [
    "田中太郎",
    "鈴木花子",
    "佐藤健",
    "高橋美咲",
    "伊藤誠",
    "渡辺直子",
    "山本浩二",
    "中村愛",
    "小林剛",
    "加藤由美",
  ];
  const corpNames = ["株式会社A", "有限会社B", "合同会社C", "一般社団法人D", "合資会社E"];

  for (const bankId of bankIds) {
    const stmts: ReturnType<D1Database["prepare"]>[] = [];
    // Get max serial (common)
    const maxAcct = await db
      .prepare(
        `SELECT account_id FROM BankAccounts WHERE bank_id=? AND account_type IN ('SAVINGS','CURRENT') ORDER BY CAST(SUBSTR(account_id, 4) AS INTEGER) DESC LIMIT 1`
      )
      .bind(bankId)
      .first<{ account_id: string }>();
    let seq = 1;
    if (maxAcct) {
      const n = parseInt(maxAcct.account_id.slice(3), 10);
      seq = isNaN(n) ? 1 : n + 1;
    }

    for (let j = 0; j < accountsPerBank; j++) {
      const isPersonal = j < personalCount;
      const accountType = isPersonal ? "SAVINGS" : "CURRENT";
      const nameBase = isPersonal
        ? personalNames[j % personalNames.length]
        : corpNames[j % corpNames.length];
      const customerName = `${nameBase}${(j + 1).toString().padStart(3, "0")}`;
      const customerId = `C${bankId}${seq.toString().padStart(6, "0")}`;
      const accountId = `${bankId}${seq.toString().padStart(7, "0")}`;
      const deposit = isPersonal ? 1_000_000 : 5_000_000; // Individual 1M / Corporate 5M

      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, ?, ?, ?, 'NORMAL', ?)`
          )
          .bind(accountId, bankId, customerId, customerName, accountType, now)
      );

      const txGroupId = `INIT-${accountId}`;
      const cashAcct = `${bankId}-CASH`;
      stmts.push(
        db
          .prepare(
            `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
         VALUES (?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`
          )
          .bind(
            `JNL-${newUUID()}`,
            bankId,
            accountId,
            deposit,
            txGroupId,
            "一括開設初期入金",
            today,
            now
          )
      );
      stmts.push(
        db
          .prepare(
            `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
         VALUES (?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`
          )
          .bind(
            `JNL-${newUUID()}`,
            bankId,
            cashAcct,
            -deposit,
            txGroupId,
            "一括開設 現金offset",
            today,
            now
          )
      );

      seq++;
    }
    // Split every 300 stmts to avoid D1 batch limit
    for (let k = 0; k < stmts.length; k += 300) {
      await db.batch(stmts.slice(k, k + 300));
    }
    totalAccounts += accountsPerBank;
  }

  return json(200, {
    result: "SIM_SETUP_COMPLETE",
    banks_created: bankIds.length,
    accounts_created: totalAccounts,
    elapsed_ms: Date.now() - t0,
  });
}

// ---------------------------------------------------------------------------
// POST sim setup-bank Batch create 1 bank's accounts
// Frontend controls progress by calling bank_index sequentially
// ---------------------------------------------------------------------------
export async function handleSimSetupOneBank(req: Request, env: Env): Promise<Response> {
  const t0 = Date.now();
  let params: { bank_index?: number; accounts_per_bank?: number; personal_ratio?: number } = {};
  try {
    params = await req.json();
  } catch {
    /* use defaults */
  }

  const bankIndex = params.bank_index ?? 0;
  const accountsPerBank = Math.min(params.accounts_per_bank ?? 200, 500);
  const personalRatio = Math.max(0, Math.min(params.personal_ratio ?? 0.9, 1));
  const db = env.DB;
  const now = nowISO();
  const today = now.slice(0, 10);

  // bank_index=0 → bank 003, bank_index=1 → bank 004 …
  // Calculate by index, not max + 1 (post-seed: 001/002 only)
  const nextCode = String(3 + bankIndex).padStart(3, "0");
  // Same bank name mapping as frontend SIM_BANKS
  const BANK_NAMES: Record<string, string> = {
    "003": "加賀銀行",
    "004": "肥前銀行",
    "005": "薩摩銀行",
    "006": "越後銀行",
    "007": "讃岐銀行",
    "008": "備後銀行",
    "009": "淡路銀行",
    "010": "日向銀行",
    "011": "紀伊銀行",
    "012": "相模銀行",
    "013": "駿河銀行",
    "014": "甲斐銀行",
    "015": "信濃銀行",
    "016": "近江銀行",
    "017": "丹波銀行",
    "018": "大隅銀行",
    "019": "播磨銀行",
    "020": "美作銀行",
  };
  const bankName = BANK_NAMES[nextCode] || `テスト銀行${nextCode}`;

  // Create Participant + system accounts
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES (?, ?, ?, ?, 0, 1, ?)`
      )
      .bind(nextCode, bankName, `/bank/${nextCode}`, 100_000_000, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', '別段預金', 'SUSPENSE', 'NORMAL', ?)`
      )
      .bind(`${nextCode}0000000`, nextCode, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', 'ZC清算勘定', 'SETTLEMENT', 'NORMAL', ?)`
      )
      .bind(`${nextCode}-ZCS`, nextCode, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', '現金', 'ASSET', 'NORMAL', ?)`
      )
      .bind(`${nextCode}-CASH`, nextCode, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'BOJ', '日本銀行（預け金勘定）', 'BOJ', 'NORMAL', ?)`
      )
      .bind(`${nextCode}-BOJ`, nextCode, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO InterestRates (rate_id, bank_id, account_type, annual_rate, effective_from)
       VALUES (?, ?, 'SAVINGS', 0.001, ?)`
      )
      .bind(`RATE-${nextCode}-SAVINGS`, nextCode, today),
    // BOJ initial prefunding (HIGH_VALUE RTGS: 100 billion yen)
    db
      .prepare(
        `INSERT OR IGNORE INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
       VALUES (?, ?, ?, -100000000000, 'CASH', ?, 'BOJ初期プレファンド', ?, ?)`
      )
      .bind(
        `JNL-INIT-${nextCode}-BOJ`,
        nextCode,
        `${nextCode}-BOJ`,
        `INIT-${nextCode}-BOJ`,
        today,
        now
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
       VALUES (?, ?, ?, 100000000000, 'CASH', ?, 'BOJ初期ZCS対当', ?, ?)`
      )
      .bind(
        `JNL-INIT-${nextCode}-BOJZCS`,
        nextCode,
        `${nextCode}-ZCS`,
        `INIT-${nextCode}-BOJ`,
        today,
        now
      ),
  ]);

  // Batch create customer accounts every 300 stmts
  const personalCount = Math.round(accountsPerBank * personalRatio);
  const corporateCount = accountsPerBank - personalCount;
  const personalNames = [
    "田中太郎",
    "鈴木花子",
    "佐藤健",
    "高橋美咲",
    "伊藤誠",
    "渡辺直子",
    "山本浩二",
    "中村愛",
    "小林剛",
    "加藤由美",
  ];
  const corpNames = ["株式会社A", "有限会社B", "合同会社C", "一般社団法人D", "合資会社E"];

  const stmts: ReturnType<D1Database["prepare"]>[] = [];
  const cashAcct = `${nextCode}-CASH`;
  for (let j = 0; j < accountsPerBank; j++) {
    const isPersonal = j < personalCount;
    const accountType = isPersonal ? "SAVINGS" : "CURRENT";
    const nameBase = isPersonal
      ? personalNames[j % personalNames.length]
      : corpNames[j % corpNames.length];
    const customerName = `${nameBase}${(j + 1).toString().padStart(3, "0")}`;
    const seq = j + 1;
    const customerId = `C${nextCode}${seq.toString().padStart(6, "0")}`;
    const accountId = `${nextCode}${seq.toString().padStart(7, "0")}`;
    const deposit = isPersonal ? 1_000_000 : 5_000_000;

    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, ?, ?, ?, 'NORMAL', ?)`
        )
        .bind(accountId, nextCode, customerId, customerName, accountType, now)
    );

    const txGroupId = `INIT-${accountId}`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`
        )
        .bind(
          `JNL-${newUUID()}`,
          nextCode,
          accountId,
          deposit,
          txGroupId,
          "一括開設初期入金",
          today,
          now
        )
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`
        )
        .bind(
          `JNL-${newUUID()}`,
          nextCode,
          cashAcct,
          -deposit,
          txGroupId,
          "一括開設 現金offset",
          today,
          now
        )
    );
  }

  // Execute batch + confirm created count
  let actualCreated = 0;
  for (let k = 0; k < stmts.length; k += 300) {
    await db.batch(stmts.slice(k, k + 300));
  }

  // Confirm actual account creation count
  const checkResult = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM BankAccounts WHERE bank_id = ? AND account_type IN ('SAVINGS', 'CURRENT')`
    )
    .bind(nextCode)
    .first<{ cnt: number }>();
  actualCreated = checkResult?.cnt ?? 0;

  return json(200, {
    result: "BANK_SETUP_DONE",
    bank_id: nextCode,
    bank_name: bankName,
    accounts_created: actualCreated,
    elapsed_ms: Date.now() - t0,
  });
}

// ---------------------------------------------------------------------------
// HTLC Auth (payee-initiated authorization) handler group
// ---------------------------------------------------------------------------

/** POST /api/htlc/auth-request  receipt側がオーソリリクエストをsend */
export async function handleHtlcAuthRequest(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<HtlcAuthRequestInput>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  if (
    !body.auth_id ||
    !body.payee_bank_id ||
    !body.payee_account_hash ||
    !body.payer_bank_id ||
    !body.payer_account_hash ||
    !body.amount ||
    !body.auth_expires_at ||
    !body.capture_expires_at ||
    !body.idempotency_key
  ) {
    return jsonError(
      400,
      "MISSING_FIELDS",
      "auth_id, payee/payer info, amount, expires_at, idempotency_key required"
    );
  }
  const result = await createAuthRequest(body, env);
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(201, result);
}

/** POST /api/htlc/auth/:auth_id/approve  fund transfer側がapproval */
export async function handleHtlcAuthApprove(
  req: Request,
  authId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<{ idempotency_key: string }>(req);
  if (!body?.idempotency_key) return jsonError(400, "MISSING_FIELDS", "idempotency_key required");
  const result = await approveAuthRequest(authId, { idempotency_key: body.idempotency_key }, env);
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(200, result);
}

/** POST /api/htlc/auth/:auth_id/decline  fund transfer側がdenial */
export async function handleHtlcAuthDecline(
  req: Request,
  authId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<{ reason?: string; idempotency_key: string }>(req);
  if (!body?.idempotency_key) return jsonError(400, "MISSING_FIELDS", "idempotency_key required");
  const result = await declineAuthRequest(
    authId,
    { reason: body.reason, idempotency_key: body.idempotency_key },
    env
  );
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(200, result);
}

/** POST /api/htlc/:htlc_id/capture  receipt側がキャプチャ（Vault からpreimagegetして自動claim） */
export async function handleHtlcCapture(req: Request, htlcId: string, env: Env): Promise<Response> {
  const body = await parseBody<{ idempotency_key: string }>(req);
  if (!body?.idempotency_key) return jsonError(400, "MISSING_FIELDS", "idempotency_key required");
  const result = await captureHtlcAuth(htlcId, { idempotency_key: body.idempotency_key }, env);
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(200, result);
}

/** POST /api/htlc/:htlc_id/void  receipt側またはfund transfer側がボイド（cancelled） */
export async function handleHtlcVoid(req: Request, htlcId: string, env: Env): Promise<Response> {
  const body = await parseBody<{ reason?: string; idempotency_key: string }>(req);
  if (!body?.idempotency_key) return jsonError(400, "MISSING_FIELDS", "idempotency_key required");
  const result = await voidHtlcAuth(
    htlcId,
    { reason: body.reason, idempotency_key: body.idempotency_key },
    env
  );
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(200, result);
}

/** GET /api/htlc/auth-requests  オーソリリクエスト一覧 */
export async function handleListHtlcAuthRequests(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const rows = await listAuthRequests(env.DB, {
    payer_bank_id: url.searchParams.get("payer_bank_id") ?? undefined,
    payee_bank_id: url.searchParams.get("payee_bank_id") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    limit: parseInt(url.searchParams.get("limit") ?? "50"),
  });
  return json(200, { auth_requests: rows });
}

/** GET /api/htlc/auth/:auth_id  オーソリリクエストdetail */
export async function handleGetHtlcAuthRequest(authId: string, env: Env): Promise<Response> {
  const row = await getAuthRequest(authId, env.DB);
  if (!row) return jsonError(404, "NOT_FOUND", `auth_id ${authId} not found`);
  return json(200, row);
}

/**
 * Verify admin-level authorization for privileged operations.
 * Checks ZC_ADMIN_KEY header first; falls back to ZC_HMAC_SECRET if ZC_ADMIN_KEY is unset.
 */
function isAdminAuthorized(req: Request, env: Env): boolean {
  const provided =
    req.headers.get("X-Admin-Key") ??
    req.headers.get("X-Api-Key") ??
    req.headers.get("Authorization")?.replace("Bearer ", "");
  const adminKey = env.ZC_ADMIN_KEY ?? env.ZC_HMAC_SECRET;
  return !!adminKey && provided === adminKey;
}

/** POST /api/htlc/auth-whitelist  ホワイトlist登録（管理者専用） */
export async function handleRegisterAuthWhitelist(req: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(req, env)) {
    return jsonError(403, "FORBIDDEN", "X-Admin-Key required for whitelist registration");
  }
  const body = await parseBody<HtlcAuthWhitelistRegisterRequest>(req);
  if (!body?.payee_bank_id || !body.payee_account_hash) {
    return jsonError(400, "MISSING_FIELDS", "payee_bank_id, payee_account_hash required");
  }
  const result = await registerAuthWhitelist(body, env.DB);
  return json(201, result);
}

/** DELETE /api/htlc/auth-whitelist/:whitelist_id  ホワイトlistdelete */
export async function handleRevokeAuthWhitelist(
  whitelistId: string,
  req: Request,
  env: Env
): Promise<Response> {
  if (!isAdminAuthorized(req, env)) {
    return jsonError(403, "FORBIDDEN", "X-Admin-Key required for whitelist revocation");
  }
  const ok = await revokeAuthWhitelist(whitelistId, env.DB);
  if (!ok) return jsonError(404, "NOT_FOUND", `whitelist_id ${whitelistId} not found`);
  return json(200, { result: "REVOKED", whitelist_id: whitelistId });
}

/** GET /api/htlc/auth-whitelist  ホワイトlist一覧 */
export async function handleListAuthWhitelist(env: Env): Promise<Response> {
  const rows = await listAuthWhitelist(env.DB);
  return json(200, { whitelist: rows });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
export function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonError(status: number, reason_code: string, message: string): Response {
  return json(status, { error: message, reason_code });
}
