/**
 * @file Transaction query API handlers (GET /api/transactions). Supports single
 *       lookup, list with filters, and QueryResponse (Appendix E.6) format.
 * @module zc/query
 */
import type {
  Env,
  QueryResponse,
  TransactionRow,
  GtidTransactionRow,
  HtlcContractRow,
  TxState,
  CaseState,
} from "../types";
import { nowISO } from "../types";
import { deserializeProof } from "../shared/proof";
import { json, jsonError } from "./ingress";
import { getDnsStatus, getDnsNetPositions } from "./dns";

// ---------------------------------------------------------------------------
// GET /api/transactions/:txid
// ---------------------------------------------------------------------------
export async function handleGetTransaction(txid: string, env: Env): Promise<Response> {
  const db = env.DB;
  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<TransactionRow>();

  if (!tx) return jsonError(404, "NOT_FOUND", `txid ${txid} not found`);

  const caseInfo = tx.case_id
    ? await db
        .prepare(`SELECT case_id, state FROM Cases WHERE case_id = ?`)
        .bind(tx.case_id)
        .first<{ case_id: string; state: CaseState }>()
    : null;

  const decisionStatus: QueryResponse["decision"]["status"] =
    tx.state === "DECIDED_TO_SETTLE" ||
    ["PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED", "SETTLED"].includes(tx.state)
      ? "DECIDED_TO_SETTLE"
      : tx.state === "DECIDED_CANCEL" || tx.state === "CANCELLED"
        ? "DECIDED_CANCEL"
        : "NONE";

  const execA: "NONE" | "OK" | "NG" = tx.payer_bank_proof_ref
    ? "OK"
    : tx.state === "FAILED_EXECUTION"
      ? "NG"
      : "NONE";

  const execB: "NONE" | "OK" | "NG" = tx.payee_bank_proof_ref
    ? "OK"
    : tx.state === "FAILED_EXECUTION"
      ? "NG"
      : "NONE";

  const nextHint: QueryResponse["next_action_hint"] =
    tx.state === "SETTLED" || tx.state === "CANCELLED"
      ? "WAIT"
      : tx.state === "SUSPENDED" || tx.state === "FAILED_EXECUTION"
        ? "OPEN_CASE"
        : tx.state === "DECIDED_CANCEL"
          ? "CONTACT_PAYER_BANK"
          : "WAIT";

  // ---------------------------------------------------------------------------
  // inquiry metadata (spec: operations > metadata)
  // ---------------------------------------------------------------------------

  // watermark: latest event_seq in FinalityLog for this tx
  // 窓口が「どこまで反映されたinformationか」をconfirmationできる
  const watermarkRow = await db
    .prepare(`SELECT MAX(event_seq) AS wm FROM FinalityLog WHERE txid = ?`)
    .bind(txid)
    .first<{ wm: number | null }>();
  const watermark = watermarkRow?.wm ?? 0;

  // next_retry_at: 次回inquiry推奨時刻（状態に応じて算出）
  // Terminal null (won't change); intermediate: recommend 5-30 sec later
  const now = new Date();
  let nextRetryAt: string | null = null;
  if (["SETTLED", "CANCELLED", "FAILED_EXECUTION"].includes(tx.state)) {
    nextRetryAt = null; // terminal — no need to re-query
  } else if (
    ["DECIDED_TO_SETTLE", "PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED"].includes(tx.state)
  ) {
    nextRetryAt = new Date(now.getTime() + 5_000).toISOString(); // 5s — active execution
  } else if (["SUSPENDED", "PRECHECKED_SUSPENDED"].includes(tx.state)) {
    nextRetryAt = new Date(now.getTime() + 30_000).toISOString(); // 30s — manual review
  } else {
    nextRetryAt = new Date(now.getTime() + 10_000).toISOString(); // 10s — default
  }

  // freshness_level: GREEN=latest, YELLOW=stale, RED=major delay
  const updatedAgo = now.getTime() - new Date(tx.updated_at).getTime();
  const freshness = updatedAgo < 10_000 ? "GREEN" : updatedAgo < 60_000 ? "YELLOW" : "RED";

  const resp: QueryResponse = {
    txid: tx.txid,
    state: tx.state,
    reason_code: tx.reason_code ?? undefined,
    decision: {
      status: decisionStatus,
      decision_proof_ref: tx.decision_proof_ref ?? undefined,
    },
    execution: {
      a: execA,
      b: execB,
      payer_bank_proof_ref: deserializeProof(tx.payer_bank_proof_ref) ?? undefined,
      payee_bank_proof_ref: deserializeProof(tx.payee_bank_proof_ref) ?? undefined,
    },
    case: caseInfo ? { case_id: caseInfo.case_id, status: caseInfo.state } : undefined,
    as_of: nowISO(),
    watermark,
    freshness_level: freshness,
    next_action_hint: nextHint,
    next_retry_at: nextRetryAt,
  };

  // UI convenience fields (not part of formal QueryResponse spec)
  const uiExtra = {
    lane: tx.lane,
    amount_value: tx.amount_value,
    amount_currency: tx.amount_currency,
    payer_bank_id: tx.payer_bank_id,
    payer_account_hash: tx.payer_account_hash,
    payee_bank_id: tx.payee_bank_id,
    payee_account_hash: tx.payee_account_hash,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
  };

  return json(200, { ...resp, ...uiExtra });
}

// ---------------------------------------------------------------------------
// GET /api/gtid/:gtid
// ---------------------------------------------------------------------------
export async function handleGetGtid(gtid: string, env: Env): Promise<Response> {
  const db = env.DB;
  const gt = await db
    .prepare(`SELECT * FROM GtidTransactions WHERE gtid = ?`)
    .bind(gtid)
    .first<GtidTransactionRow>();
  if (!gt) return jsonError(404, "NOT_FOUND", `gtid ${gtid} not found`);

  const legs = await db
    .prepare(`SELECT * FROM GtidLegs WHERE gtid = ?`)
    .bind(gtid)
    .all<{ state: string }>();

  // Derive the count fields from real leg states rather than trusting the
  // snapshot columns on GtidTransactions (see GtidTransactionRow doc-comment).
  // For DNS-synthetic GTs (`GTID-DNS-*`) that have no GtidLegs, fall back to
  // the stored snapshot so the dashboard still reflects the settled state.
  const hasLegs = (legs.results?.length ?? 0) > 0;
  const legs_ready_count = hasLegs
    ? legs.results.filter(
        (l) => l.state === "LEG_READY_CHECKED" || l.state === "LEG_SETTLED"
      ).length
    : gt.legs_ready_count;
  const legs_settled_count = hasLegs
    ? legs.results.filter((l) => l.state === "LEG_SETTLED").length
    : gt.legs_settled_count;

  return json(200, {
    ...gt,
    legs_ready_count,
    legs_settled_count,
    legs: legs.results,
  });
}

// ---------------------------------------------------------------------------
// GET /api/htlc/:htlc_id
// ---------------------------------------------------------------------------
export async function handleGetHtlc(htlcId: string, env: Env): Promise<Response> {
  const htlc = await env.DB.prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(htlcId)
    .first<HtlcContractRow>();
  if (!htlc) return jsonError(404, "NOT_FOUND", `htlc_id ${htlcId} not found`);
  return json(200, htlc);
}

// ---------------------------------------------------------------------------
// GET /api/dns/:business_date/status
// ---------------------------------------------------------------------------
export async function handleGetDnsStatus(businessDate: string, env: Env): Promise<Response> {
  const cycle = await getDnsStatus(businessDate, env.DB);
  if (!cycle) return json(200, { state: "NOT_STARTED", business_date: businessDate });
  return json(200, {
    state: cycle.state,
    igs_mode: cycle.igs_mode,
    cycle_id: cycle.cycle_id,
    business_date: businessDate,
  });
}

// ---------------------------------------------------------------------------
// GET /api/dns/:business_date/position
// ---------------------------------------------------------------------------
export async function handleGetDnsPosition(businessDate: string, env: Env): Promise<Response> {
  const positions = await getDnsNetPositions(businessDate, env.DB);
  return json(200, { business_date: businessDate, positions });
}

// ---------------------------------------------------------------------------
// GET /api/cases/:case_id
// ---------------------------------------------------------------------------
export async function handleGetCase(caseId: string, env: Env): Promise<Response> {
  const c = await env.DB.prepare(`SELECT * FROM Cases WHERE case_id = ?`).bind(caseId).first();
  if (!c) return jsonError(404, "NOT_FOUND", `case ${caseId} not found`);
  return json(200, c);
}

// ---------------------------------------------------------------------------
// GET /api/transactions  (一覧: dashboard用)
// ---------------------------------------------------------------------------
export async function handleListTransactions(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const state = url.searchParams.get("state");
  const txid = url.searchParams.get("txid");
  const account = url.searchParams.get("account"); // payer or payee account
  const bankId = url.searchParams.get("bank_id"); // payer or payee bank
  const dateFrom = url.searchParams.get("date_from"); // ISO datetime
  const dateTo = url.searchParams.get("date_to"); // ISO datetime

  let query = `SELECT txid, lane, state, reason_code, amount_value, payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash, created_at, updated_at FROM Transactions`;
  const params: unknown[] = [];
  const conds: string[] = [];

  if (state) {
    conds.push(`state = ?`);
    params.push(state);
  }
  if (txid) {
    conds.push(`txid LIKE ?`);
    params.push(`${txid}%`);
  }
  if (account) {
    conds.push(`(payer_account_hash = ? OR payee_account_hash = ?)`);
    params.push(account, account);
  }
  if (bankId) {
    conds.push(`(payer_bank_id = ? OR payee_bank_id = ?)`);
    params.push(bankId, bankId);
  }
  if (dateFrom) {
    conds.push(`created_at >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conds.push(`created_at <= ?`);
    params.push(dateTo);
  }

  // Query row count
  let countQuery = `SELECT COUNT(*) as count FROM Transactions`;
  if (conds.length > 0) countQuery += ` WHERE ` + conds.join(` AND `);
  const countRow = await env.DB.prepare(countQuery)
    .bind(...params)
    .first<{ count: number }>();
  const totalCount = countRow?.count ?? 0;

  if (conds.length > 0) query += ` WHERE ` + conds.join(` AND `);
  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await env.DB.prepare(query)
    .bind(...params)
    .all();
  return json(200, {
    transactions: rows.results,
    count: rows.results.length,
    total_count: totalCount,
  });
}

// ---------------------------------------------------------------------------
// GET /api/htlc  (HTLC一覧: dashboard用)
// ---------------------------------------------------------------------------
export async function handleListHtlcs(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM HtlcContracts`).first<{
    count: number;
  }>();
  const totalCount = countRow?.count ?? 0;

  const rows = await env.DB.prepare(
    `SELECT h.htlc_id, h.txid, h.state, h.hashlock, h.timelock, h.amount_value,
            h.payer_bank_id, h.payee_bank_id, h.secret_verified, h.created_at, h.updated_at,
            t.state AS tx_state
     FROM HtlcContracts h
     LEFT JOIN Transactions t ON h.txid = t.txid
     ORDER BY h.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all();
  return json(200, { htlcs: rows.results, count: rows.results.length, total_count: totalCount });
}

// ---------------------------------------------------------------------------
// GET /api/gtid  (GTID一覧: dashboard用)
// ---------------------------------------------------------------------------
export async function handleListGtids(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM GtidTransactions`).first<{
    count: number;
  }>();
  const totalCount = countRow?.count ?? 0;

  const rows = await env.DB.prepare(
    `SELECT * FROM GtidTransactions ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all<GtidTransactionRow>();
  return json(200, { gtids: rows.results, count: rows.results.length, total_count: totalCount });
}
