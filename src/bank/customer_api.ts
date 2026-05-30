/**
 * @file Customer-facing bank API handlers. Provides account listing, balance
 * inquiry, transaction history, transfer initiation, transfer status lookup,
 * and approval management.
 * @module bank/customer_api
 */
import type { Env, BankAccountRow, CustomerTransferRequest } from "../types";
import { nowISO, bankCodeFromAccount } from "../types";
import { json, jsonError, handlePostTransfers } from "../zc/ingress";
import { newUUID } from "../shared/idempotency";
import { calcBalance as calcBalanceLedger } from "./ledger";
import { getAvailableBalance } from "./suspense";

function getHeaders(req: Request): { bankId: string; customerId: string } | null {
  const bankId = req.headers.get("X-Bank-Id");
  const customerId = req.headers.get("X-Customer-Id");
  if (!bankId || !customerId) return null;
  return { bankId, customerId };
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/me/accounts  account list
// ---------------------------------------------------------------------------
export async function handleGetAccounts(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "X-Bank-Id and X-Customer-Id required");

  // Use LEFT JOIN to aggregate balances, avoiding N+1 parallel DB queries
  const accounts = await env.DB.prepare(`
      SELECT a.*, COALESCE(SUM(j.amount), 0) AS balance
      FROM BankAccounts a
      LEFT JOIN BankJournals j ON a.account_id = j.account_id
      WHERE a.bank_id=? AND a.customer_id=? AND a.status != 'CLOSED'
      GROUP BY a.account_id
      ORDER BY a.opened_at ASC
    `)
    .bind(bankId, headers.customerId)
    .all();

  const result = accounts.results.map((acc: any) => ({
    account_id: acc.account_id,
    account_type: acc.account_type,
    status: acc.status,
    customer_name: acc.customer_name,
    balance: acc.balance,
    currency: "JPY",
  }));

  return json(200, { accounts: result });
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/me/accounts/:accountId/balance
// ---------------------------------------------------------------------------
export async function handleGetBalance(
  req: Request,
  bankId: string,
  accountId: string,
  env: Env
): Promise<Response> {
  const headers = getHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "headers required");

  const account = await env.DB.prepare(
    `SELECT * FROM BankAccounts WHERE account_id=? AND bank_id=? AND customer_id=?`
  )
    .bind(accountId, bankId, headers.customerId)
    .first<BankAccountRow>();

  if (!account) return jsonError(404, "NOT_FOUND", "account not found");

  const balance = await calcBalanceLedger(account.account_id, env.DB);
  return json(200, {
    account_id: account.account_id,
    balance,
    currency: "JPY",
    as_of: nowISO(),
  });
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/me/accounts/:accountId/transactions  transaction history
// ---------------------------------------------------------------------------
export async function handleGetAccountTransactions(
  req: Request,
  bankId: string,
  accountId: string,
  env: Env
): Promise<Response> {
  const headers = getHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "headers required");

  const account = await env.DB.prepare(
    `SELECT account_id FROM BankAccounts WHERE account_id=? AND bank_id=? AND customer_id=?`
  )
    .bind(accountId, bankId, headers.customerId)
    .first<{ account_id: string }>();
  if (!account) return jsonError(404, "NOT_FOUND", "account not found");

  const url = new URL(req.url);
  const searchTxid = url.searchParams.get("txid");
  const searchDateFrom = url.searchParams.get("date_from");
  const searchDateTo = url.searchParams.get("date_to");
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

  let jqlConds = [`account_id=?`];
  const jqlParams: unknown[] = [accountId];
  if (searchTxid) {
    jqlConds.push(`txid LIKE ?`);
    jqlParams.push(`${searchTxid}%`);
  }
  if (searchDateFrom) {
    jqlConds.push(`value_date >= ?`);
    jqlParams.push(searchDateFrom);
  }
  if (searchDateTo) {
    jqlConds.push(`value_date <= ?`);
    jqlParams.push(searchDateTo);
  }
  jqlParams.push(limit);
  const jql = `SELECT journal_id, amount, tx_type, txid, description, value_date, created_at FROM BankJournals WHERE ${jqlConds.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;

  const journals = await env.DB.prepare(jql)
    .bind(...jqlParams)
    .all<{
      journal_id: string;
      amount: number;
      tx_type: string;
      txid: string | null;
      description: string | null;
      value_date: string;
      created_at: string;
    }>();

  // txid → Transactions（fund transfer人・payee information）をbatch lookup
  // Avoid intermediate array allocation in map().filter(), construct Set and convert to array in 1 pass
  const txidSet = new Set<string>();
  for (const j of journals.results) {
    if (j.txid) txidSet.add(j.txid);
  }
  const txids = Array.from(txidSet);
  const txInfoMap = new Map<
    string,
    {
      payer_account_hash: string;
      payee_account_hash: string | null;
      state: string;
      lane: string | null;
      purpose: string | null;
    }
  >();
  if (txids.length > 0) {
    const ph = txids.map(() => "?").join(",");
    const txRows = await env.DB.prepare(
      `SELECT txid, payer_account_hash, payee_account_hash, state, lane, purpose FROM Transactions WHERE txid IN (${ph})`
    )
      .bind(...txids)
      .all<{
        txid: string;
        payer_account_hash: string;
        payee_account_hash: string | null;
        state: string;
        lane: string | null;
        purpose: string | null;
      }>();
    for (const row of txRows.results) txInfoMap.set(row.txid, row);
  }

  // 関連accountの名義をbatch lookup
  const cpAccountIds = new Set<string>();
  for (const [, tx] of txInfoMap) {
    if (tx.payer_account_hash) cpAccountIds.add(tx.payer_account_hash);
    if (tx.payee_account_hash) cpAccountIds.add(tx.payee_account_hash);
  }
  const acctNameMap = new Map<string, string>();
  if (cpAccountIds.size > 0) {
    const ph2 = [...cpAccountIds].map(() => "?").join(",");
    const acctRows = await env.DB.prepare(
      `SELECT account_id, customer_name FROM BankAccounts WHERE account_id IN (${ph2})`
    )
      .bind(...cpAccountIds)
      .all<{ account_id: string; customer_name: string }>();
    for (const row of acctRows.results) acctNameMap.set(row.account_id, row.customer_name);
  }

  const transactions = journals.results.map((j) => {
    const txInfo = j.txid ? txInfoMap.get(j.txid) : undefined;
    const label = journalDisplayLabel(
      j.tx_type,
      j.amount,
      txInfo?.lane ?? null,
      txInfo?.purpose ?? null
    );
    let counterparty: string | null = null;
    if (j.txid && txInfo) {
      // Withdrawal (negative) counterparty account = payee, deposit (positive) counterparty account = payer
      const cpId = j.amount < 0 ? (txInfo.payee_account_hash ?? "") : txInfo.payer_account_hash;
      counterparty = acctNameMap.get(cpId) ?? null;
    }
    return {
      journal_id: j.journal_id,
      amount: j.amount,
      label,
      counterparty,
      description: j.description ?? null,
      value_date: j.value_date,
      created_at: j.created_at,
      txid: j.txid ?? null,
      tx_state: txInfo?.state ?? null,
    };
  });

  return json(200, { transactions });
}

function journalDisplayLabel(
  txType: string,
  amount: number,
  lane: string | null,
  purpose: string | null
): string {
  if (txType === "CASH") return amount >= 0 ? "現金入金" : "現金払い戻し";
  if (txType === "INTEREST") return "利息";
  if (txType === "CORRECTION") return "訂正";

  // fund transfer・credit / incoming paymentのtransaction typeラベル（lane優先）
  const isDebit = amount < 0;
  if (txType === "RESERVE" && !isDebit) return "振込取消";

  if (lane) {
    // deposit側は lane を問わず「transfer credit」ベース＋種別補足
    if (!isDebit) {
      switch (lane) {
        case "HIGH_VALUE":
          return "大口振込入金";
        case "HTLC":
          return "HTLC着金";
        case "DEFERRED":
          return "協調取引 着金";
        case "RTP":
          return "請求払い 着金";
        default:
          return "振込入金";
      }
    }
    // withdrawal側
    switch (lane) {
      case "EXPRESS":
        return purposeLabel(purpose);
      case "STANDARD":
        return purposeLabel(purpose);
      case "BULK":
        return "一括振込";
      case "HIGH_VALUE":
        return "大口送金";
      case "HTLC":
        return "HTLC送金";
      case "DEFERRED":
        return "協調取引 送金";
      case "RTP":
        return "請求払い";
      default:
        return purposeLabel(purpose);
    }
  }

  // lane 不明時は tx_type で判定
  if (txType === "CREDIT") return isDebit ? "取引" : "振込入金";
  return isDebit ? purposeLabel(purpose) : "振込入金";
}

function purposeLabel(purpose: string | null): string {
  switch (purpose) {
    case "P2P":
      return "個人間送金";
    case "MERCHANT":
      return "店舗支払";
    case "BILL":
      return "料金支払";
    case "SALARY":
      return "給与・賞与";
    default:
      return "お振込み";
  }
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/me/transfers  execute transfer
// payee_bank_id 不要: payee_account_id の先頭3桁から自動導出
// ---------------------------------------------------------------------------
export async function handlePostCustomerTransfer(
  req: Request,
  bankId: string,
  env: Env
): Promise<Response> {
  const headers = getHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "headers required");

  let body: CustomerTransferRequest;
  try {
    body = (await req.json()) as CustomerTransferRequest;
  } catch {
    return jsonError(400, "INVALID_JSON", "invalid json");
  }

  // payee_account_id から payee_bank_id を導出
  const payeeAccountId = body.payee_account_id ?? body.payee_account_hash ?? "";
  let payeeBankId = body.payee_bank_id;
  if (!payeeBankId) {
    if (payeeAccountId.startsWith("h:")) {
      return jsonError(
        400,
        "MISSING_BANK_ID",
        "payee_bank_id is required when using an account hash"
      );
    }
    payeeBankId = bankCodeFromAccount(payeeAccountId);
  }

  // customer accountを特定（customer_id で SAVINGS accountを検索）
  const account = await env.DB.prepare(
    `SELECT * FROM BankAccounts WHERE bank_id=? AND customer_id=? AND status='NORMAL' AND account_type='SAVINGS' LIMIT 1`
  )
    .bind(bankId, headers.customerId)
    .first<BankAccountRow>();
  if (!account) return jsonError(404, "NOT_FOUND", "customer account not found");

  // ZC の POST /api/transfers と同等のリクエストをconstruct
  const txid = `TX-${newUUID()}`;
  const zcReq = new Request("http://internal/api/transfers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      message_type: "EVENT",
      name: "PaymentInitiated",
      message_id: newUUID(),
      idempotency_key: body.idempotency_key,
      occurred_at: nowISO(),
      txid,
      lane: body.lane,
      amount: body.amount,
      payer: { bank_id: bankId, account_hash: account.account_id },
      payee: { bank_id: payeeBankId, account_hash: payeeAccountId },
      purpose: body.purpose,
      pspr_ref: body.pspr_ref,
    }),
  });

  return handlePostTransfers(zcReq, env);
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/me/transfers/:txid  transfer statusinquiry
// ---------------------------------------------------------------------------
export async function handleGetTransferStatus(
  req: Request,
  bankId: string,
  txid: string,
  env: Env
): Promise<Response> {
  const headers = getHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "headers required");

  // customerauthorization check: payer_account_hash がcustomerのaccountに一致するかvalidation
  // （水平privilege escalation防止: 同一bankの別customerがtxidを推測して閲覧できないようにする）
  const customerId = headers.customerId;
  const tx = await env.DB.prepare(
    `SELECT txid, state, reason_code, amount_value, amount_currency, payer_account_hash, created_at, updated_at FROM Transactions WHERE txid=? AND payer_bank_id=?`
  )
    .bind(txid, bankId)
    .first<{
      txid: string;
      state: string;
      reason_code: string | null;
      amount_value: number;
      amount_currency: string;
      payer_account_hash: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!tx) return jsonError(404, "NOT_FOUND", "transfer not found");

  // customer IDからaccountを検索し、payer_account_hash とreconcile
  if (customerId) {
    const customerAccounts = await env.DB.prepare(
      `SELECT account_id FROM BankAccounts WHERE bank_id=? AND customer_id=?`
    )
      .bind(bankId, customerId)
      .all<{ account_id: string }>();
    const accountIds = customerAccounts.results.map((a) => a.account_id);
    const payerHash = tx.payer_account_hash ?? "";
    // account_hash は "h:accountId" 形式または accountId そのもの
    const payerAccountId = payerHash.startsWith("h:") ? payerHash.slice(2) : payerHash;
    if (accountIds.length > 0 && !accountIds.includes(payerAccountId)) {
      return jsonError(403, "FORBIDDEN", "not authorized to view this transfer");
    }
  }

  const { payer_account_hash: _omit, ...safeResult } = tx;
  return json(200, safeResult);
}
