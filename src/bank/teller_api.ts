/**
 * @file Bank teller (staff) API handlers. Provides cash deposit/withdrawal,
 * account management (create, batch create, status update), journal queries,
 * suspense resolution, and batch status.
 * @module bank/teller_api
 */
import type { Env, BankAccountRow, SuspenseDetailRow } from '../types'
import { nowISO, suspenseAccountId, nostroAccountId, cashAccountId, generateAccountId } from '../types'
import { json, jsonError } from '../zc/ingress'
import { calcBalance as calcBalanceLedger } from './ledger'
import { insertJournalGroup } from './ledger'
import { newUUID } from '../shared/idempotency'

function getTellerHeaders(req: Request): { bankId: string; tellerId: string } | null {
  const bankId = req.headers.get('X-Bank-Id')
  const tellerId = req.headers.get('X-Teller-Id')
  if (!bankId || !tellerId) return null
  return { bankId, tellerId }
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/cash/deposit  現金入金
// ---------------------------------------------------------------------------
export async function handleCashDeposit(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  let body: { account_id: string; amount: number; description?: string }
  try { body = await req.json() } catch { return jsonError(400, 'INVALID_JSON', 'invalid json') }

  // 金額バリデーション: 正の整数のみ許可（負の金額で残高チェック迂回を防止）
  if (typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount <= 0) {
    return jsonError(400, 'INVALID_AMOUNT', 'amount must be a positive integer')
  }

  const account = await env.DB
    .prepare(`SELECT * FROM BankAccounts WHERE account_id=? AND bank_id=? AND status='NORMAL'`)
    .bind(body.account_id, bankId)
    .first<BankAccountRow>()
  if (!account) return jsonError(404, 'NOT_FOUND', 'account not found')

  const txGroupId = `CASH-DEP-${newUUID()}`
  // 現金入金の対向は現金（Cash）口座 — Cash(-) / Customer(+)
  await insertJournalGroup(env.DB, {
    bankId, txGroupId,
    entries: [
      { accountId: body.account_id, amount: body.amount, txType: 'CASH', description: body.description ?? '現金入金' },
      { accountId: cashAccountId(bankId), amount: -body.amount, txType: 'CASH', description: '現金入金 offset' },
    ],
    valueDate: nowISO().slice(0, 10),
  })

  const balance = await calcBalanceLedger(body.account_id, env.DB)
  return json(200, { result: 'OK', account_id: body.account_id, new_balance: balance, currency: 'JPY' })
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/cash/withdrawal  現金払い戻し
// ---------------------------------------------------------------------------
export async function handleCashWithdrawal(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  let body: { account_id: string; amount: number; description?: string }
  try { body = await req.json() } catch { return jsonError(400, 'INVALID_JSON', 'invalid json') }

  // 金額バリデーション: 正の整数のみ許可
  if (typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount <= 0) {
    return jsonError(400, 'INVALID_AMOUNT', 'amount must be a positive integer')
  }

  const account = await env.DB
    .prepare(`SELECT * FROM BankAccounts WHERE account_id=? AND bank_id=? AND status='NORMAL'`)
    .bind(body.account_id, bankId)
    .first<BankAccountRow>()
  if (!account) return jsonError(404, 'NOT_FOUND', 'account not found')

  const balance = await calcBalanceLedger(body.account_id, env.DB)
  if (balance < body.amount) return jsonError(400, 'INSUFFICIENT_FUNDS', 'insufficient balance')

  const txGroupId = `CASH-WD-${newUUID()}`
  // 現金払戻の対向は現金（Cash）口座 — Cash(+) / Customer(-)
  await insertJournalGroup(env.DB, {
    bankId, txGroupId,
    entries: [
      { accountId: body.account_id, amount: -body.amount, txType: 'CASH', description: body.description ?? '現金払い戻し' },
      { accountId: cashAccountId(bankId), amount: body.amount, txType: 'CASH', description: '現金払戻 offset' },
    ],
    valueDate: nowISO().slice(0, 10),
  })

  const newBalance = await calcBalanceLedger(body.account_id, env.DB)
  return json(200, { result: 'OK', account_id: body.account_id, new_balance: newBalance, currency: 'JPY' })
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/accounts/:accountId/journals  仕訳照会
// ---------------------------------------------------------------------------
export async function handleGetJournals(req: Request, bankId: string, accountId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  const url = new URL(req.url)
  const from = url.searchParams.get('from') ?? '2000-01-01'
  const to = url.searchParams.get('to') ?? '9999-12-31'
  const limit = parseInt(url.searchParams.get('limit') ?? '100', 10)

  const journals = await env.DB
    .prepare(`SELECT * FROM BankJournals WHERE account_id=? AND bank_id=? AND value_date BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?`)
    .bind(accountId, bankId, from, to, limit)
    .all()

  return json(200, { journals: journals.results, count: journals.results.length })
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/suspense/:suspenseId/resolve  別段預金収束
// ---------------------------------------------------------------------------
export async function handleSuspenseResolve(req: Request, bankId: string, suspenseId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  let body: { action: 'SETTLE' | 'RETURN'; target_account_id?: string }
  try { body = await req.json() } catch { return jsonError(400, 'INVALID_JSON', 'invalid json') }

  const suspense = await env.DB
    .prepare(`SELECT * FROM SuspenseDetails WHERE suspense_id=? AND bank_id=?`)
    .bind(suspenseId, bankId)
    .first<SuspenseDetailRow>()
  if (!suspense) return jsonError(404, 'NOT_FOUND', 'suspense not found')
  if (suspense.status !== 'CUSTODY') return jsonError(400, 'INVALID_STATE', 'only CUSTODY can be resolved here')

  const now = nowISO()
  const targetAccountId = body.target_account_id ?? suspense.account_id
  const txGroupId = `SUSP-RESOLVE-${suspenseId}`
  const suspAcctId = suspenseAccountId(bankId)

  if (body.action === 'SETTLE') {
    // 別段 → 普通預金
    await insertJournalGroup(env.DB, {
      bankId, txGroupId,
      entries: [
        { accountId: targetAccountId, amount: suspense.amount, txType: 'CREDIT', txid: suspense.txid ?? undefined, description: 'CUSTODY resolved' },
        { accountId: suspAcctId, amount: -suspense.amount, txType: 'CREDIT', description: 'CUSTODY resolved offset' },
      ],
      valueDate: now.slice(0, 10),
    })
    await env.DB.prepare(`UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, updated_at=? WHERE suspense_id=?`).bind(now, now, suspenseId).run()
    return json(200, { result: 'SETTLED', suspense_id: suspenseId })
  } else {
    // RETURN 時に別段残高を消去する仕訳を作成
    await insertJournalGroup(env.DB, {
      bankId, txGroupId: `SUSP-RETURN-${suspenseId}`,
      entries: [
        { accountId: suspAcctId, amount: -suspense.amount, txType: 'CREDIT', txid: suspense.txid ?? undefined, description: 'CUSTODY returned 別段消去' },
        { accountId: suspense.account_id, amount: suspense.amount, txType: 'CREDIT', txid: suspense.txid ?? undefined, description: 'CUSTODY returned 残高戻し' },
      ],
      valueDate: now.slice(0, 10),
    })
    await env.DB.prepare(`UPDATE SuspenseDetails SET status='RETURNED', updated_at=? WHERE suspense_id=?`).bind(now, suspenseId).run()
    return json(200, { result: 'RETURNED', suspense_id: suspenseId })
  }
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/batch/status  バッチ処理状態照会
// ---------------------------------------------------------------------------
export async function handleBatchStatus(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  const today = nowISO().slice(0, 10)
  const dnsCycle = await env.DB
    .prepare(`SELECT * FROM DnsCycles WHERE business_date = ?`)
    .bind(today).first()

  const openSuspense = await env.DB
    .prepare(`SELECT COUNT(*) AS cnt FROM SuspenseDetails WHERE bank_id=? AND status NOT IN ('SETTLED','RETURNED')`)
    .bind(bankId).first<{ cnt: number }>()

  return json(200, {
    business_date: today,
    dns_cycle: dnsCycle ?? { state: 'NOT_STARTED' },
    open_suspense_count: openSuspense?.cnt ?? 0,
    as_of: nowISO(),
  })
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/accounts  行員用全口座一覧
// ---------------------------------------------------------------------------
export async function handleTellerListAccounts(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  const url = new URL(req.url)
  const statusFilter = url.searchParams.get('status')

  const noBalance = url.searchParams.get('no_balance') === '1'

  let query = `SELECT * FROM BankAccounts WHERE bank_id=?`
  const params: unknown[] = [bankId]
  if (statusFilter) { query += ` AND status=?`; params.push(statusFilter) }
  query += ` ORDER BY opened_at ASC`

  const rows = await env.DB.prepare(query).bind(...params).all<BankAccountRow>()
  const result = noBalance
    ? rows.results
    : await Promise.all(rows.results.map(async acc => ({
        ...acc,
        balance: await calcBalanceLedger(acc.account_id, env.DB),
      })))
  return json(200, { accounts: result })
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/accounts  口座新規作成（全数値口座番号）
// ---------------------------------------------------------------------------
export async function handleCreateAccount(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  let body: { customer_name: string; account_type?: string; initial_deposit?: number }
  try { body = await req.json() } catch { return jsonError(400, 'INVALID_JSON', 'invalid json') }
  if (!body.customer_name)
    return jsonError(400, 'INVALID_INPUT', 'customer_name is required')

  const accountType = body.account_type ?? 'SAVINGS'
  const allowed = ['SAVINGS', 'CURRENT']
  if (!allowed.includes(accountType))
    return jsonError(400, 'INVALID_TYPE', 'account_type must be SAVINGS or CURRENT')

  const now = nowISO()

  // 次の口座番号を算出: 同一銀行の最大口座番号 + 1
  // IN ('SAVINGS','CURRENT') に限定 — '003-ZCS' 等のシステム口座を除外し
  //           parseInt('-ZCS') = NaN → NaN+1 = NaN で口座番号が壊れる問題を防ぐ
  const maxAcct = await env.DB.prepare(
    `SELECT account_id FROM BankAccounts WHERE bank_id=? AND account_type IN ('SAVINGS', 'CURRENT') ORDER BY account_id DESC LIMIT 1`
  ).bind(bankId).first<{ account_id: string }>()

  let nextSeq = 1
  if (maxAcct) {
    const currentSeq = parseInt(maxAcct.account_id.slice(3), 10)
    nextSeq = isNaN(currentSeq) ? 1 : currentSeq + 1
  }
  const accountId = generateAccountId(bankId, nextSeq)

  // 顧客IDを自動生成
  const customerId = `C${newUUID().replace(/-/g, '').slice(0, 12)}`

  await env.DB.prepare(
    `INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
     VALUES (?,?,?,?,?,'NORMAL',?)`
  ).bind(accountId, bankId, customerId, body.customer_name, accountType, now).run()

  if (body.initial_deposit && body.initial_deposit > 0) {
    await insertJournalGroup(env.DB, {
      bankId,
      txGroupId: `INIT-${accountId}`,
      entries: [
        { accountId, amount:  body.initial_deposit, txType: 'CASH', description: '口座開設初期入金' },
        { accountId: cashAccountId(bankId), amount: -body.initial_deposit, txType: 'CASH', description: '口座開設 現金offset' },
      ],
      valueDate: now.slice(0, 10),
    })
  }

  return json(201, { result: 'CREATED', account_id: accountId, bank_id: bankId, account_type: accountType, customer_name: body.customer_name })
}

// ---------------------------------------------------------------------------
// PATCH /bank/:bankId/v1/teller/accounts/:accountId  口座ステータス変更
// ---------------------------------------------------------------------------
export async function handleUpdateAccountStatus(req: Request, bankId: string, accountId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  let body: { status: string; reason?: string }
  try { body = await req.json() } catch { return jsonError(400, 'INVALID_JSON', 'invalid json') }

  const allowedStatuses = ['NORMAL', 'FROZEN', 'CLOSING_HOLD', 'CLOSED']
  if (!allowedStatuses.includes(body.status))
    return jsonError(400, 'INVALID_STATUS', `status must be one of: ${allowedStatuses.join(', ')}`)

  const now = nowISO()
  const result = await env.DB.prepare(
    `UPDATE BankAccounts SET status=?, freeze_reason=?, closed_at=? WHERE account_id=? AND bank_id=?`
  ).bind(
    body.status,
    body.status === 'NORMAL' ? null : (body.reason ?? null),
    body.status === 'CLOSED' ? now : null,
    accountId, bankId,
  ).run()

  if ((result.meta.changes ?? 0) === 0)
    return jsonError(404, 'NOT_FOUND', 'account not found')

  return json(200, { result: 'OK', account_id: accountId, status: body.status })
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/suspense  別段預金一覧
// ---------------------------------------------------------------------------
export async function handleListSuspense(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  const url = new URL(req.url)
  const statusFilter = url.searchParams.get('status')
  const txidFilter   = url.searchParams.get('txid')

  let query = `SELECT * FROM SuspenseDetails WHERE bank_id=?`
  const params: unknown[] = [bankId]
  if (statusFilter) { query += ` AND status=?`;     params.push(statusFilter) }
  if (txidFilter)   { query += ` AND txid LIKE ?`;  params.push(`%${txidFilter}%`) }
  query += ` ORDER BY created_at DESC LIMIT 200`

  const rows = await env.DB.prepare(query).bind(...params).all<SuspenseDetailRow>()
  return json(200, { suspense: rows.results, count: rows.results.length })
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/journals  全仕訳帳（口座IDはクエリパラメータ）
// ---------------------------------------------------------------------------
export async function handleGetAllJournals(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  const url    = new URL(req.url)
  const accId  = url.searchParams.get('account_id')
  const from   = url.searchParams.get('from') ?? '2000-01-01'
  const to     = url.searchParams.get('to')   ?? '9999-12-31'
  const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '200', 10), 500)

  let query = `SELECT * FROM BankJournals WHERE bank_id=? AND value_date BETWEEN ? AND ?`
  const params: unknown[] = [bankId, from, to]
  if (accId) { query += ` AND account_id=?`; params.push(accId) }
  query += ` ORDER BY created_at DESC LIMIT ?`
  params.push(limit)

  const rows = await env.DB.prepare(query).bind(...params).all()
  return json(200, { journals: rows.results, count: rows.results.length })
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/accounts/batch  口座一括作成
// 最大200口座/リクエスト。initial_deposit 付きで仕訳も同時生成。
// ---------------------------------------------------------------------------
export async function handleBatchCreateAccounts(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req)
  if (!headers) return jsonError(401, 'UNAUTHORIZED', 'teller headers required')

  let body: { accounts: Array<{ customer_name: string; account_type?: string; initial_deposit?: number }> }
  try { body = await req.json() } catch { return jsonError(400, 'INVALID_JSON', 'invalid json') }
  if (!Array.isArray(body.accounts) || body.accounts.length === 0)
    return jsonError(400, 'INVALID_INPUT', 'accounts array required')
  if (body.accounts.length > 200)
    return jsonError(400, 'TOO_MANY', 'max 200 accounts per batch')

  const now = nowISO()
  const today = now.slice(0, 10)
  const allowed = ['SAVINGS', 'CURRENT']

  // 現在の最大口座番号を取得（既存ロジックと共通）
  // 同時実行による ID 重複を防ぐため、UUID サフィックスでユニーク化
  const maxAcct = await env.DB.prepare(
    `SELECT account_id FROM BankAccounts WHERE bank_id=? AND account_type IN ('SAVINGS', 'CURRENT') ORDER BY account_id DESC LIMIT 1`
  ).bind(bankId).first<{ account_id: string }>()
  let nextSeq = 1
  if (maxAcct) {
    const currentSeq = parseInt(maxAcct.account_id.slice(3), 10)
    nextSeq = isNaN(currentSeq) ? 1 : currentSeq + 1
  }
  // 同時リクエストによる seq 衝突を回避するため、ランダムオフセットを加算
  nextSeq += Math.floor(Math.random() * 1000000)

  const stmts: ReturnType<D1Database['prepare']>[] = []
  const created: Array<{ account_id: string; bank_id: string; customer_name: string; initial_deposit?: number }> = []

  for (const spec of body.accounts) {
    if (!spec.customer_name?.trim()) continue
    const accountType = allowed.includes(spec.account_type ?? '') ? (spec.account_type as string) : 'SAVINGS'
    const customerId  = `C${newUUID().replace(/-/g, '').slice(0, 12)}`
    const accountId   = generateAccountId(bankId, nextSeq)

    stmts.push(env.DB.prepare(
      `INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
       VALUES (?,?,?,?,?,'NORMAL',?)`
    ).bind(accountId, bankId, customerId, spec.customer_name.trim(), accountType, now))

    if (spec.initial_deposit && spec.initial_deposit > 0) {
      const txGroupId = `INIT-${accountId}`
      stmts.push(env.DB.prepare(
        `INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
         VALUES (?,?,?,?,'CASH',?,?,?,?)`
      ).bind(`JNL-B-${newUUID()}`, bankId, accountId, spec.initial_deposit, txGroupId, '一括開設初期入金', today, now))
      stmts.push(env.DB.prepare(
        `INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
         VALUES (?,?,?,?,'CASH',?,?,?,?)`
      ).bind(`JNL-B-${newUUID()}`, bankId, cashAccountId(bankId), -spec.initial_deposit, txGroupId, '一括開設 現金offset', today, now))
    }

    created.push({ account_id: accountId, bank_id: bankId, customer_name: spec.customer_name.trim(), initial_deposit: spec.initial_deposit })
    nextSeq++
  }

  // D1 batch: 200口座×3ステートメント = 最大600件（制限内）
  if (stmts.length > 0) await env.DB.batch(stmts)

  return json(201, { result: 'BATCH_CREATED', count: created.length, created })
}
