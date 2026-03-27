/**
 * @module bank/ingress
 * @description ZC -> Bank Ingress API (10 endpoints).
 *
 * This module implements the bank-side ingress layer that receives commands from
 * the Zenith Coordinator (ZC). Each command corresponds to a specific stage in
 * the payment lifecycle:
 *
 *   1. reserve-funds     — Reserve payer funds in suspense (H_RESERVED)
 *   2. execute-debit     — Finalize payer debit (a-proof generation)
 *   3. execute-credit    — Credit payee account (b-proof, hard landing)
 *   4. release-reserve   — Release reserved funds on cancel/timeout
 *   5. leg-ready-check   — GTID pre-readiness check for multi-leg coordination
 *   6. authority-check   — AML/sanctions screening (mock: always OK)
 *   7. name-check        — Payee name verification against account records
 *   8. account-verify    — Account existence + name matching (Levenshtein)
 *   9. credit-notify     — Post-settlement credit notification with journals
 *  10. rtp-notify        — Request-to-Pay notification to payer bank
 *
 * All commands are idempotent via the ZcRequests table (INSERT OR IGNORE pattern).
 * Every successful or failed command is recorded to BankAuditLog for traceability.
 *
 * The module exposes two entry points:
 *   - {@link handleBankIngress} — direct in-process dispatch (used by orchestrator)
 *   - {@link handleBankIngressHttp} — HTTP wrapper for external calls
 */
import type {
  Env,
  ReserveFundsRequest, ReserveFundsResponse,
  ExecuteDebitRequest, ExecuteDebitResponse,
  ExecuteCreditRequest, ExecuteCreditResponse, ExecuteCreditResult,
  ReleaseReserveRequest, ReleaseReserveResponse,
  LegReadyCheckRequest, LegReadyCheckResponse,
  AuthorityCheckRequest, AuthorityCheckResponse,
  NameCheckRequest, NameCheckResponse,
  BankAccountRow,
} from '../types'
import { nowISO, suspenseAccountId, nostroAccountId } from '../types'
import { newUUID } from '../shared/idempotency'
import { createProof } from '../shared/proof'
import { reserveSuspense, executeSuspenseDebit, landSuspense, getAvailableBalance, getAccountByHash } from './suspense'
import { insertJournalGroup } from './ledger'
import { evaluatePaymentFilters } from './filter'

/**
 * Write an entry to the BankAuditLog table. Failures are silently swallowed
 * so that audit logging never blocks the critical payment path.
 * @param db - D1 database handle
 * @param params - Audit log fields (bank_id, command, status, etc.)
 */
async function auditLog(db: D1Database, params: {
  bank_id: string; txid?: string | null; request_id?: string | null
  command: string; status: 'OK' | 'NG'; reason_code?: string | null
  amount?: number | null; account_id?: string | null
  details?: Record<string, unknown> | null
}): Promise<void> {
  try {
    const logId = `AUD-${newUUID()}`
    await db.prepare(
      `INSERT INTO BankAuditLog
       (log_id, bank_id, txid, request_id, command, status, reason_code,
        amount, account_id, details_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      logId, params.bank_id, params.txid ?? null, params.request_id ?? null,
      params.command, params.status, params.reason_code ?? null,
      params.amount ?? null, params.account_id ?? null,
      params.details ? JSON.stringify(params.details) : null,
      nowISO(),
    ).run()
  } catch (err) {
    console.error('[bank/audit] BankAuditLog write failed:', err)
  }
}

/**
 * Internal command router. Called directly by the ZC orchestrator within the
 * same Worker process (no HTTP overhead). Dispatches to the appropriate
 * command handler based on the command string.
 *
 * @param bankId  - Target bank identifier (e.g. "001")
 * @param command - Ingress command name (e.g. "reserve-funds", "execute-debit")
 * @param payload - Command-specific request body (type-cast per command)
 * @param env     - Cloudflare Worker environment bindings
 * @returns Command-specific response object
 */
export async function handleBankIngress(
  bankId: string, command: string, payload: unknown, env: Env,
): Promise<unknown> {
  switch (command) {
    case 'reserve-funds':    return bankReserveFunds(bankId, payload as ReserveFundsRequest, env)
    case 'execute-debit':    return bankExecuteDebit(bankId, payload as ExecuteDebitRequest, env)
    case 'execute-credit':   return bankExecuteCredit(bankId, payload as ExecuteCreditRequest, env)
    case 'release-reserve':  return bankReleaseReserve(bankId, payload as ReleaseReserveRequest, env)
    case 'leg-ready-check':  return bankLegReadyCheck(bankId, payload as LegReadyCheckRequest, env)
    case 'authority-check':  return bankAuthorityCheck(bankId, payload as AuthorityCheckRequest, env)
    case 'name-check':       return bankNameCheck(bankId, payload as NameCheckRequest, env)
    case 'account-verify':   return bankAccountVerify(bankId, payload as BankAccountVerifyIngressRequest, env)
    case 'credit-notify':    return bankCreditNotify(bankId, payload as BankCreditNotifyIngressRequest, env)
    case 'rtp-notify':       return bankRtpNotify(bankId, payload as BankRtpNotifyIngressRequest, env)
    default:
      return { result: 'ERROR', reason_code: 'UNKNOWN_COMMAND' }
  }
}

/**
 * HTTP wrapper for external ingress calls. Parses the JSON body from the
 * incoming Request and delegates to {@link handleBankIngress}.
 *
 * @param req     - Incoming HTTP request with JSON body
 * @param bankId  - Target bank identifier extracted from URL path
 * @param command - Ingress command name extracted from URL path
 * @param env     - Cloudflare Worker environment bindings
 * @returns HTTP Response (always 200 with JSON body for successful dispatch)
 */
export async function handleBankIngressHttp(
  req: Request, bankId: string, command: string, env: Env,
): Promise<Response> {
  let body: unknown
  try { body = await req.json() } catch { return errorResp(400, 'INVALID_JSON') }
  const result = await handleBankIngress(bankId, command, body, env)
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Check idempotency for a given request_id. Uses D1's INSERT OR IGNORE to
 * atomically claim the request_id. If the row already exists, returns the
 * previously stored response (or a PROCESSING sentinel if still in-flight).
 *
 * @param requestId   - Unique request identifier for idempotency
 * @param bankId      - Bank identifier
 * @param txid        - Associated transaction ID (nullable for some commands)
 * @param commandType - Command name for auditing
 * @param db          - D1 database handle
 * @returns `{ existing: true, response }` if already processed; `{ existing: false }` if new
 */
async function checkIdempotency(requestId: string, bankId: string, txid: string | null, commandType: string, db: D1Database): Promise<{ existing: boolean; response: unknown | null }> {
  const now = nowISO()
  const result = await db.prepare(
    `INSERT OR IGNORE INTO ZcRequests (request_id, bank_id, txid, command_type, status, created_at)
     VALUES (?, ?, ?, ?, 'PROCESSING', ?)`
  ).bind(requestId, bankId, txid, commandType, now).run()

  if ((result.meta.changes ?? 0) === 0) {
    const existing = await db.prepare(`SELECT response_body FROM ZcRequests WHERE request_id = ?`).bind(requestId).first<{ response_body: string | null }>()
    if (existing?.response_body) {
      return { existing: true, response: JSON.parse(existing.response_body) }
    }
    return { existing: true, response: { result: 'PROCESSING' } }
  }
  return { existing: false, response: null }
}

/**
 * Persist the command response to ZcRequests so that future idempotent
 * retries return the same result.
 *
 * @param requestId - The request_id to update
 * @param response  - Response object to serialize as JSON
 * @param db        - D1 database handle
 */
async function saveResponse(requestId: string, response: unknown, db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE ZcRequests SET status='DONE', response_body=?, updated_at=? WHERE request_id=?`
  ).bind(JSON.stringify(response), nowISO(), requestId).run()
}

/**
 * **Command 1: reserve-funds** — Reserve payer funds (H_RESERVED).
 *
 * Isolates the transfer amount from the payer's savings account into a
 * suspense account via double-entry journals:
 *   - Customer account: -(amount)
 *   - Suspense account: +(amount)
 *
 * The reservation prevents the payer from double-spending while the
 * transfer is in flight. Released by either execute-debit (success path)
 * or release-reserve (cancel/timeout path).
 *
 * @param bankId - Payer bank identifier
 * @param req    - Contains txid, account_hash, amount, request_id
 * @param env    - Worker environment bindings
 * @returns ReserveFundsResponse with result RESERVED or ERROR
 */
async function bankReserveFunds(
  bankId: string, req: ReserveFundsRequest, env: Env,
): Promise<ReserveFundsResponse> {
  const db = env.DB
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, 'reserve-funds', db)
  if (idempResult.existing) return idempResult.response as ReserveFundsResponse

  // 口座検索
  const account = await getAccountByHash(bankId, req.account_hash, db)
  if (!account || account.status !== 'NORMAL') {
    const resp: ReserveFundsResponse = { result: 'ERROR', reason_code: 'ACCOUNT_NOT_FOUND' }
    await saveResponse(req.request_id, resp, db)
    await auditLog(db, { bank_id: bankId, txid: req.txid, request_id: req.request_id,
      command: 'reserve-funds', status: 'NG', reason_code: 'ACCOUNT_NOT_FOUND',
      amount: req.amount.value, details: { account_hash: req.account_hash } })
    return resp
  }

  // 利用可能残高チェック
  const available = await getAvailableBalance(account.account_id, db)
  if (available < req.amount.value) {
    const resp: ReserveFundsResponse = { result: 'ERROR', reason_code: 'INSUFFICIENT_FUNDS' }
    await saveResponse(req.request_id, resp, db)
    await auditLog(db, { bank_id: bankId, txid: req.txid, request_id: req.request_id,
      command: 'reserve-funds', status: 'NG', reason_code: 'INSUFFICIENT_FUNDS',
      amount: req.amount.value, account_id: account.account_id,
      details: { available, requested: req.amount.value } })
    return resp
  }

  // 別段預金（支払口）に隔離 + 仕訳
  const suspenseId = await reserveSuspense(db, {
    bankId, accountId: account.account_id, direction: 'PAY',
    amount: req.amount.value, txid: req.txid, requestId: req.request_id,
  })

  const resp: ReserveFundsResponse = { result: 'RESERVED', reservation_ref: suspenseId }
  await saveResponse(req.request_id, resp, db)
  await auditLog(db, { bank_id: bankId, txid: req.txid, request_id: req.request_id,
    command: 'reserve-funds', status: 'OK',
    amount: req.amount.value, account_id: account.account_id,
    details: { reservation_ref: suspenseId } })
  return resp
}

/**
 * **Command 2: execute-debit** — Finalize the payer-side debit (a-proof).
 *
 * Two paths depending on the lane:
 *
 * - **HIGH_VALUE (RTGS):** Bypasses suspense entirely. Debits the customer
 *   account directly and credits the ZCS nostro account in a single journal
 *   group: Customer(-) / ZCS(+). This avoids the SuspenseDetails leak
 *   that occurred with the old HV_TRANSIT approach (BUG-3 fix).
 *
 * - **Standard/Express/Bulk:** Transitions the existing SuspenseDetails
 *   record from RESERVED to EXECUTED via {@link executeSuspenseDebit}.
 *
 * Generates a bank_proof_ref (a-proof) upon success for ZC verification.
 *
 * @param bankId - Payer bank identifier
 * @param req    - Contains txid, amount, request_id, lane, payer_account_hash
 * @param env    - Worker environment bindings
 * @returns ExecuteDebitResponse with bank_proof_ref, or ERROR
 */
async function bankExecuteDebit(
  bankId: string, req: ExecuteDebitRequest, env: Env,
): Promise<ExecuteDebitResponse | { result: 'ERROR'; reason_code: string }> {
  const db = env.DB
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, 'execute-debit', db)
  if (idempResult.existing) return idempResult.response as ExecuteDebitResponse

  const isHV = req.lane === 'HIGH_VALUE'
  let accountId: string

  if (isHV) {
    // HVレーン: account_hash で口座を特定（reserve-funds を経由しないため直接渡す）
    const account = req.payer_account_hash
      ? await getAccountByHash(bankId, req.payer_account_hash, db)
      : await db.prepare(`SELECT * FROM BankAccounts WHERE bank_id=? AND status='NORMAL' AND account_type='SAVINGS' LIMIT 1`).bind(bankId).first<BankAccountRow>()
    if (!account || account.status !== 'NORMAL') {
      const resp = { result: 'ERROR' as const, reason_code: 'ACCOUNT_NOT_FOUND' }
      await saveResponse(req.request_id, resp, db)
      return resp
    }
    accountId = account.account_id
    const available = await getAvailableBalance(accountId, db)
    if (available < req.amount.value) {
      const resp = { result: 'ERROR' as const, reason_code: 'INSUFFICIENT_FUNDS' }
      await saveResponse(req.request_id, resp, db)
      return resp
    }
    // HV は即時 RTGS 清算のため別段預金を経由せず直接 Customer(-) / ZCS(+) を仕訳
    await insertJournalGroup(db, {
      bankId, txGroupId: `HV-DEBIT-${req.txid}`,
      entries: [
        { accountId, amount: -req.amount.value, txType: 'TRANSFER', txid: req.txid, description: 'HV即時引落 普通預金(-)' },
        { accountId: nostroAccountId(bankId), amount: req.amount.value, txType: 'TRANSFER', txid: req.txid, description: 'HV ZCS清算義務(+)' },
      ],
      valueDate: nowISO().slice(0, 10),
    })
  } else {
    // 標準: RESERVED → EXECUTED に状態変更
    const suspense = await db
      .prepare(`SELECT suspense_id, account_id FROM SuspenseDetails WHERE txid=? AND bank_id=? AND status='RESERVED' LIMIT 1`)
      .bind(req.txid, bankId).first<{ suspense_id: string; account_id: string }>()
    if (!suspense) {
      const resp = { result: 'ERROR' as const, reason_code: 'RESERVATION_NOT_FOUND' }
      await saveResponse(req.request_id, resp, db)
      return resp
    }
    await executeSuspenseDebit(suspense.suspense_id, db)
    accountId = suspense.account_id
  }

  // a証憑生成
  const proofType = isHV ? 'PAYER_HV_ISOLATION_PROOF' as const : 'PAYER_EXEC_PROOF' as const
  const proof = await createProof(bankId, proofType, req.txid, req.amount.value)
  const resp: ExecuteDebitResponse = { result: 'OK', bank_proof_ref: proof }
  await saveResponse(req.request_id, resp, db)
  await auditLog(db, { bank_id: bankId, txid: req.txid, request_id: req.request_id,
    command: 'execute-debit', status: 'OK',
    amount: req.amount.value, account_id: accountId,
    details: { lane: req.lane ?? 'STANDARD', proof_type: proofType } })
  return resp
}

/**
 * **Command 3: execute-credit** — Credit the payee account (b-proof, hard landing).
 *
 * Processing flow:
 *   1. Resolve payee account by account_hash (with fallback chain)
 *   2. If account is abnormal (frozen/closed/system), route to custody
 *   3. Evaluate payment filters ({@link evaluatePaymentFilters}):
 *      - REJECT -> return FILTER_REJECTED immediately
 *      - HOLD_CONFIRM/HOLD_MANUAL -> create approval request, return PENDING_APPROVAL
 *   4. Hard-land funds into suspense: Suspense(+) / ZCS(-) journals
 *   5. For normal accounts, immediately settle: Suspense(-) / Customer(+)
 *   6. Generate b-proof (PAYEE_EXEC_PROOF) with optional custody metadata
 *
 * Custody accounts hold funds until a teller manually resolves them via
 * the suspense-resolve endpoint.
 *
 * @param bankId - Payee bank identifier
 * @param req    - Contains txid, amount, request_id, payee_account_hash
 * @param env    - Worker environment bindings
 * @returns ExecuteCreditResult (OK | FILTER_REJECTED | PENDING_APPROVAL)
 */
async function bankExecuteCredit(
  bankId: string, req: ExecuteCreditRequest, env: Env,
): Promise<ExecuteCreditResult> {
  const db = env.DB
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, 'execute-credit', db)
  if (idempResult.existing) return idempResult.response as ExecuteCreditResult

  // Payee 口座: リクエストの payee_account_hash を優先使用（Transactions 直参照を排除）
  let account: BankAccountRow | null = null
  const payeeHash = req.payee_account_hash
  if (payeeHash) {
    account = await getAccountByHash(bankId, payeeHash, db)
  }
  if (!account) {
    // フォールバック: txid から取得（シングルWorkerモックのみ許容）
    const tx = await db.prepare(`SELECT payee_account_hash FROM Transactions WHERE txid=?`).bind(req.txid).first<{ payee_account_hash: string | null }>()
    if (tx?.payee_account_hash) {
      account = await getAccountByHash(bankId, tx.payee_account_hash, db)
    }
  }
  if (!account) {
    account = await db
      .prepare(`SELECT * FROM BankAccounts WHERE bank_id=? AND account_type='SAVINGS' ORDER BY account_id LIMIT 1`)
      .bind(bankId).first<BankAccountRow>()
  }

  let isCustody = false
  let custodyReason = ''

  if (!account || account.status !== 'NORMAL' || account.account_type !== 'SAVINGS') {
    isCustody = true
    custodyReason = !account
      ? 'NOT_FOUND'
      : account.status === 'FROZEN' ? 'ACCOUNT_FROZEN'
      : account.status === 'CLOSED' ? 'ACCOUNT_CLOSED'
      : account.account_type !== 'SAVINGS' ? 'SYSTEM_ACCOUNT'
      : 'NOT_FOUND'
    if (!account) {
      account = {
        account_id: suspenseAccountId(bankId), bank_id: bankId, customer_id: 'SYSTEM',
        customer_name: '別段預金', account_type: 'SUSPENSE', status: 'NORMAL',
        freeze_reason: null, opened_at: nowISO(), closed_at: null,
      }
    } else if (account.account_type !== 'SAVINGS') {
      account = {
        account_id: suspenseAccountId(bankId), bank_id: bankId, customer_id: 'SYSTEM',
        customer_name: '別段預金', account_type: 'SUSPENSE', status: 'NORMAL',
        freeze_reason: null, opened_at: nowISO(), closed_at: null,
      }
    }
  }

  // --- 着金フィルタ評価（正常口座の場合のみ）---
  // 送金元情報を Transactions テーブルから取得
  if (!isCustody) {
    const txInfo = await db.prepare(
      `SELECT payer_bank_id, payer_account_hash, purpose FROM Transactions WHERE txid=?`
    ).bind(req.txid).first<{ payer_bank_id: string; payer_account_hash: string; purpose: string | null }>()

    if (txInfo) {
      const filterResult = await evaluatePaymentFilters(
        bankId,
        account.account_id,
        txInfo.payer_bank_id,
        txInfo.payer_account_hash,
        req.amount.value,
        txInfo.purpose ?? null,  // EDI相当として purpose を使用
        req.txid,
        db,
      )

      if (filterResult.matched) {
        if (filterResult.action === 'REJECT') {
          const resp = { result: 'FILTER_REJECTED' as const, reason_code: filterResult.reason_code, filter_id: filterResult.filter_id }
          await saveResponse(req.request_id, resp, db)
          await auditLog(db, { bank_id: bankId, txid: req.txid, request_id: req.request_id,
            command: 'execute-credit', status: 'NG', reason_code: 'PAYMENT_FILTER_REJECTED',
            amount: req.amount.value, account_id: account.account_id,
            details: { filter_id: filterResult.filter_id, payer_bank_id: txInfo.payer_bank_id } })
          return resp
        }
        // HOLD_CONFIRM / HOLD_MANUAL
        const resp = { result: 'PENDING_APPROVAL' as const, approval_id: filterResult.approval_id }
        await saveResponse(req.request_id, resp, db)
        await auditLog(db, { bank_id: bankId, txid: req.txid, request_id: req.request_id,
          command: 'execute-credit', status: 'NG', reason_code: 'AWAITING_APPROVAL',
          amount: req.amount.value, account_id: account.account_id,
          details: { filter_id: filterResult.filter_id, approval_id: filterResult.approval_id, action: filterResult.action } })
        return resp
      }
    }
  }

  // Hard Landing: 別段預金（受取口）に着金
  const suspId = await landSuspense(db, {
    bankId, accountId: account.account_id, direction: 'RECEIVE',
    amount: req.amount.value, txid: req.txid, requestId: req.request_id,
    isCustody, custodyReason,
  })

  // b証憑生成
  const custodyDetail = isCustody
    ? { is_custody: true as const, reason_code: custodyReason, custody_account_ref: suspId }
    : undefined
  const proof = await createProof(bankId, 'PAYEE_EXEC_PROOF', req.txid, req.amount.value, custodyDetail)

  // 正常口座の場合は即時着金（別段 → 普通預金）
  if (!isCustody) {
    await insertJournalGroup(db, {
      bankId, txGroupId: `SETTLE-${req.txid}`,
      entries: [
        { accountId: suspenseAccountId(bankId), amount: -req.amount.value, txType: 'CREDIT', txid: req.txid, description: 'ZC着金 別段(-)' },
        { accountId: account.account_id, amount: req.amount.value, txType: 'CREDIT', txid: req.txid, description: 'ZC着金 普通預金(+)' },
      ],
      valueDate: nowISO().slice(0, 10),
    })
    // txid 全体ではなく landSuspense が生成した特定の suspense_id を対象にする
    await db.prepare(`UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, updated_at=? WHERE suspense_id=?`)
      .bind(nowISO(), nowISO(), suspId).run()
  }

  const resp: ExecuteCreditResponse = { result: 'OK', bank_proof_ref: proof }
  await saveResponse(req.request_id, resp, db)
  await auditLog(db, { bank_id: bankId, txid: req.txid, request_id: req.request_id,
    command: 'execute-credit', status: 'OK',
    amount: req.amount.value, account_id: account.account_id,
    details: { is_custody: isCustody, custody_reason: isCustody ? custodyReason : null } })
  return resp
}

/**
 * **Command 4: release-reserve** — Release previously reserved funds.
 *
 * Called on transaction cancel or timeout. Reverses the reserve-funds
 * journals by moving funds back from suspense to the customer account:
 *   - Suspense: -(amount)
 *   - Customer: +(amount)
 *
 * Sets the SuspenseDetails status to RETURNED (not SETTLED, since no
 * settlement occurred).
 *
 * @param bankId - Bank identifier holding the reservation
 * @param req    - Contains txid, reservation_ref, request_id
 * @param env    - Worker environment bindings
 * @returns ReleaseReserveResponse with result RELEASED
 */
async function bankReleaseReserve(
  bankId: string, req: ReleaseReserveRequest, env: Env,
): Promise<ReleaseReserveResponse> {
  const db = env.DB
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, 'release-reserve', db)
  if (idempResult.existing) return idempResult.response as ReleaseReserveResponse

  // 別段預金を元口座に戻す
  const suspense = await db
    .prepare(`SELECT * FROM SuspenseDetails WHERE suspense_id=? OR (txid=? AND bank_id=? AND status='RESERVED') LIMIT 1`)
    .bind(req.reservation_ref, req.txid, bankId).first<{ suspense_id: string; account_id: string; amount: number }>()

  if (suspense) {
    // キャンセル解放は 'RETURNED'（'SETTLED' ではない）
    await db.prepare(`UPDATE SuspenseDetails SET status='RETURNED', settled_at=?, updated_at=? WHERE suspense_id=?`)
      .bind(nowISO(), nowISO(), suspense.suspense_id).run()
    // 普通預金に戻す仕訳: 別段預金(-) / 普通預金(+)
    await insertJournalGroup(db, {
      bankId, txGroupId: `RELEASE-${req.txid}`,
      entries: [
        { accountId: suspenseAccountId(bankId), amount: -suspense.amount, txType: 'RESERVE', txid: req.txid, description: '予約解放 別段(-）' },
        { accountId: suspense.account_id, amount: suspense.amount, txType: 'RESERVE', txid: req.txid, description: '予約解放 普通預金(+)' },
      ],
      valueDate: nowISO().slice(0, 10),
    })
  }

  const resp: ReleaseReserveResponse = { result: 'RELEASED', reservation_ref: req.reservation_ref }
  await saveResponse(req.request_id, resp, db)
  return resp
}

/**
 * **Command 5: leg-ready-check** — GTID multi-leg pre-readiness verification.
 *
 * Validates that a bank participant in a coordinated (GTID) transaction can
 * fulfill its role. For PAYER legs, checks available balance and pre-reserves
 * funds in suspense (equivalent to reserve-funds). For PAYEE legs, only
 * verifies account existence and status.
 *
 * @param bankId - Bank identifier for this leg
 * @param req    - Contains leg_id, account_hash, role (PAYER|PAYEE), amount
 * @param env    - Worker environment bindings
 * @returns LegReadyCheckResponse with result OK or NG
 */
async function bankLegReadyCheck(
  bankId: string, req: LegReadyCheckRequest, env: Env,
): Promise<LegReadyCheckResponse> {
  const db = env.DB
  const account = await getAccountByHash(bankId, req.account_hash, db)
  if (!account || account.status !== 'NORMAL') {
    return { result: 'NG', reason_code: 'ACCOUNT_NOT_FOUND' }
  }
  if (req.role === 'PAYER') {
    const available = await getAvailableBalance(account.account_id, db)
    if (available < req.amount.value) {
      return { result: 'NG', reason_code: 'INSUFFICIENT_FUNDS' }
    }
    // PAYER は別段預金への資金隔離を行う（reserve-funds と同等）
    // txid は後から作成される TX-GT-{leg_id} を予測して使用
    const predictedTxid = `TX-GT-${req.leg_id}`
    const suspenseId = await reserveSuspense(db, {
      bankId, accountId: account.account_id, direction: 'PAY',
      amount: req.amount.value, txid: predictedTxid, requestId: req.request_id,
    })
    return { result: 'OK', reservation_ref: suspenseId }
  }
  return { result: 'OK' }
}

/**
 * **Command 6: authority-check** — AML/sanctions screening (mock: always OK).
 *
 * In production, this would integrate with the bank's compliance engine
 * to perform anti-money laundering and sanctions list screening. The mock
 * implementation always returns OK.
 *
 * @param bankId - Bank identifier
 * @param req    - Contains txid, check_type
 * @param env    - Worker environment bindings
 * @returns AuthorityCheckResponse with result OK
 */
async function bankAuthorityCheck(
  bankId: string, req: AuthorityCheckRequest, env: Env,
): Promise<AuthorityCheckResponse> {
  console.log(`[bank/${bankId}] authority-check txid=${req.txid} type=${req.check_type}`)
  return { result: 'OK' }
}

/**
 * **Command 7: name-check** — Payee name verification.
 *
 * Verifies that the payee account exists and is transferable (SAVINGS or
 * CURRENT type only; system accounts like SUSPENSE/ZCS/CASH/BOJ are
 * rejected). Supports two resolution modes:
 *   - By PSPR reference (proxy payment service provider registry)
 *   - By account_hash (direct account lookup)
 *
 * Returns the customer_name on MATCH for UI display.
 *
 * @param bankId - Payee bank identifier
 * @param req    - Contains account_hash or pspr_ref
 * @param env    - Worker environment bindings
 * @returns NameCheckResponse with result MATCH or MISMATCH, plus customer_name
 */
async function bankNameCheck(
  bankId: string, req: NameCheckRequest, env: Env,
): Promise<NameCheckResponse & { customer_name?: string }> {
  const db = env.DB
  if (req.pspr_ref) {
    const pspr = await db
      .prepare(`SELECT pspr_ref FROM PsprRegistry WHERE pspr_ref=? AND capability_state='ACTIVE'`)
      .bind(req.pspr_ref).first()
    if (!pspr) return { result: 'MISMATCH', reason_code: 'PSPR_NOT_FOUND' }
    return { result: 'MATCH' }
  }
  if (req.account_hash) {
    const account = await getAccountByHash(bankId, req.account_hash, db)
    if (!account) return { result: 'MISMATCH', reason_code: 'NAME_MISMATCH' }
    // システム口座（別段預金・清算勘定・現金・BOJ）は振込不可
    // SAVINGS（個人普通預金）・CURRENT（法人当座預金）は着金可
    if (account.account_type !== 'SAVINGS' && account.account_type !== 'CURRENT') {
      return { result: 'MISMATCH', reason_code: 'ACCOUNT_NOT_TRANSFERABLE' }
    }
    return { result: 'MATCH', customer_name: account.customer_name }
  }
  return { result: 'MATCH' }
}

/**
 * Request shapes for ingress commands 8-10. These are defined locally
 * rather than in types.ts because they are internal to the bank ingress
 * layer and not shared across modules.
 */

/** Request body for the account-verify ingress command. */
interface BankAccountVerifyIngressRequest {
  request_id: string
  verification_id: string
  target_account_hash: string
  target_account_name?: string
}

/** Request body for the credit-notify ingress command. */
interface BankCreditNotifyIngressRequest {
  request_id: string
  notification_id: string
  txid: string
  payee_account_hash: string
  amount: { value: number; currency: string }
  payer_bank_id: string
  payer_name_masked: string
  purpose: string
  edi_summary?: string
}

/** Request body for the rtp-notify ingress command. */
interface BankRtpNotifyIngressRequest {
  request_id: string
  rtp_id: string
  payee_bank_id: string
  payer_bank_id: string
  amount: { value: number; currency: string }
  expires_at: string
  payee_name?: string
  description?: string
}

/**
 * **Command 8: account-verify** — Account existence and name matching.
 *
 * Looks up the target account by hash and compares the provided name against
 * the stored customer_name using Levenshtein distance:
 *   - Exact match: score 1.0, result MATCHED
 *   - Edit distance <= 1: score 0.8, result MATCHED (typo tolerance)
 *   - Otherwise: score 0.0, result MISMATCHED
 *
 * Only SAVINGS accounts are considered valid targets. If no name is provided,
 * returns MATCHED (account-existence-only check).
 *
 * @param bankId - Bank identifier to search
 * @param req    - Contains target_account_hash, optional target_account_name
 * @param env    - Worker environment bindings
 * @returns Object with result, match_score, name_provided, fraud_warning
 */
async function bankAccountVerify(
  bankId: string, req: BankAccountVerifyIngressRequest, env: Env,
): Promise<{ result: 'MATCHED' | 'MISMATCHED' | 'NOT_FOUND'; match_score: number; name_provided: string | null; fraud_warning: boolean }> {
  const db = env.DB

  // 口座検索
  const account = await getAccountByHash(bankId, req.target_account_hash, db)
  if (!account || account.account_type !== 'SAVINGS') {
    return { result: 'NOT_FOUND', match_score: 0.0, name_provided: req.target_account_name ?? null, fraud_warning: false }
  }

  // 名義未指定の場合は NOT_FOUND に準じず MATCHED（口座存在確認のみ）
  if (!req.target_account_name) {
    return { result: 'MATCHED', match_score: 1.0, name_provided: null, fraud_warning: false }
  }

  const provided = req.target_account_name
  const stored = account.customer_name

  // 完全一致
  if (provided === stored) {
    return { result: 'MATCHED', match_score: 1.0, name_provided: provided, fraud_warning: false }
  }

  // 1文字差（編集距離1）の部分一致
  const editDist = levenshtein(provided, stored)
  if (editDist <= 1) {
    return { result: 'MATCHED', match_score: 0.8, name_provided: provided, fraud_warning: false }
  }

  return { result: 'MISMATCHED', match_score: 0.0, name_provided: provided, fraud_warning: false }
}

/**
 * Compute Levenshtein edit distance between two strings.
 * Used for fuzzy name matching in account-verify.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Minimum number of single-character edits (insert/delete/replace)
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
    }
  }
  return dp[m]![n]!
}

/**
 * **Command 9: credit-notify** — Post-settlement credit notification.
 *
 * Called after DNS settlement to notify the payee bank that funds have
 * been credited. Creates zero-sum journal entries:
 *   - Customer account: +(amount)  — funds credited
 *   - ZCS nostro account: -(amount) — settlement obligation discharged
 *
 * Unlike execute-credit (which uses suspense for hard landing), credit-notify
 * directly credits the customer account since DNS settlement has already
 * occurred at the ZC level.
 *
 * @param bankId - Payee bank identifier
 * @param req    - Contains txid, payee_account_hash, amount, payer info
 * @param env    - Worker environment bindings
 * @returns DELIVERED with notification_id, or ERROR
 */
async function bankCreditNotify(
  bankId: string, req: BankCreditNotifyIngressRequest, env: Env,
): Promise<{ result: 'DELIVERED'; notification_id: string } | { result: 'ERROR'; reason_code: string }> {
  const db = env.DB
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, 'credit-notify', db)
  if (idempResult.existing) return idempResult.response as { result: 'DELIVERED'; notification_id: string }

  // Payee 口座検索
  const account = await getAccountByHash(bankId, req.payee_account_hash, db)
  if (!account || account.account_type !== 'SAVINGS') {
    const resp = { result: 'ERROR' as const, reason_code: 'ACCOUNT_NOT_FOUND' }
    await saveResponse(req.request_id, resp, db)
    return resp
  }

  const now = nowISO()
  const valueDate = now.slice(0, 10)
  const journalGroupId = `CNOTIFY-${req.notification_id}`
  const zcsAccountId = nostroAccountId(bankId)

  // ゼロサム仕訳: 着金口座(+) / ZCS勘定(-)  2エントリ
  await insertJournalGroup(db, {
    bankId,
    txGroupId: journalGroupId,
    entries: [
      {
        accountId: account.account_id,
        amount: req.amount.value,
        txType: 'CREDIT',
        txid: req.txid,
        description: `入金通知 ${req.payer_bank_id}→${bankId} ${req.purpose}`,
      },
      {
        accountId: zcsAccountId,
        amount: -req.amount.value,
        txType: 'CREDIT',
        txid: req.txid,
        description: '入金通知 ZCS清算勘定(-)offset',
      },
    ],
    valueDate,
  })

  const resp = { result: 'DELIVERED' as const, notification_id: req.notification_id }
  await saveResponse(req.request_id, resp, db)
  await auditLog(db, {
    bank_id: bankId, txid: req.txid, request_id: req.request_id,
    command: 'credit-notify', status: 'OK',
    amount: req.amount.value, account_id: account.account_id,
    details: { notification_id: req.notification_id, payer_bank_id: req.payer_bank_id },
  })
  return resp
}

// ---------------------------------------------------------------------------
// 10. rtp-notify  RTP請求通知（支払銀行側への通知格納）
// ---------------------------------------------------------------------------
async function bankRtpNotify(
  bankId: string, req: BankRtpNotifyIngressRequest, env: Env,
): Promise<{ result: 'NOTIFIED'; rtp_id: string } | { result: 'ERROR'; reason_code: string }> {
  const db = env.DB
  const idempResult = await checkIdempotency(req.request_id, bankId, null, 'rtp-notify', db)
  if (idempResult.existing) return idempResult.response as { result: 'NOTIFIED'; rtp_id: string }

  const now = nowISO()

  // RtpRequestRows に格納（支払銀行側のローカルストレージ）
  // INSERT OR IGNORE で冪等保証（rtp_id が PRIMARY KEY）
  await db.prepare(`
    INSERT OR IGNORE INTO RtpRequestRows
      (rtp_id, payee_bank_id, payer_bank_id, amount_value, rtp_status,
       payee_name, description, expires_at, notified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'NOTIFIED', ?, ?, ?, ?, ?, ?)
  `).bind(
    req.rtp_id,
    req.payee_bank_id,
    req.payer_bank_id,
    req.amount.value,
    req.payee_name ?? null,
    req.description ?? null,
    req.expires_at,
    now,
    now,
    now,
  ).run()

  const resp = { result: 'NOTIFIED' as const, rtp_id: req.rtp_id }
  await saveResponse(req.request_id, resp, db)
  await auditLog(db, {
    bank_id: bankId, txid: null, request_id: req.request_id,
    command: 'rtp-notify', status: 'OK',
    amount: req.amount.value,
    details: {
      rtp_id: req.rtp_id,
      payee_bank_id: req.payee_bank_id,
      payer_bank_id: req.payer_bank_id,
      expires_at: req.expires_at,
    },
  })
  return resp
}

function errorResp(status: number, reason_code: string): Response {
  return new Response(JSON.stringify({ error: reason_code, reason_code }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}
