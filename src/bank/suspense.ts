/**
 * @file Suspense account and custody management. Handles fund reservation
 * (RESERVED), debit execution (EXECUTED), credit landing (LANDED/CUSTODY),
 * DNS settlement, and available balance calculation.
 * @module bank/suspense
 */
import type { BankAccountRow, SuspenseDirection } from '../types'
import { nowISO, suspenseAccountId, nostroAccountId } from '../types'
import { newUUID } from '../shared/idempotency'
import { insertJournalGroup } from './ledger'

export interface ReserveSuspenseInput {
  bankId: string
  accountId: string
  direction: SuspenseDirection
  amount: number
  txid: string | null
  requestId?: string
  isCustody?: boolean
  custodyReason?: string
}

// ---------------------------------------------------------------------------
// 別段預金（支払口）: 普通預金 → 別段（RESERVED）
// ---------------------------------------------------------------------------
export async function reserveSuspense(
  db: D1Database,
  input: ReserveSuspenseInput,
): Promise<string> {
  const now = nowISO()
  const suspenseId = `SUSP-${newUUID()}`
  const suspAcctId = suspenseAccountId(input.bankId)

  // 仕訳: 普通預金(-) / 別段預金(+)  → ゼロサム
  await insertJournalGroup(db, {
    bankId: input.bankId,
    txGroupId: `RESERVE-${suspenseId}`,
    entries: [
      { accountId: input.accountId, amount: -input.amount, txType: 'RESERVE', txid: input.txid ?? undefined, description: 'Hard Reservation' },
      { accountId: suspAcctId, amount: input.amount, txType: 'RESERVE', txid: input.txid ?? undefined, description: 'Hard Reservation offset' },
    ],
    valueDate: now.slice(0, 10),
  })

  await db.prepare(
    `INSERT INTO SuspenseDetails
     (suspense_id, bank_id, account_id, direction, status, amount, txid, request_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)`
  ).bind(suspenseId, input.bankId, input.accountId, input.direction,
    input.amount, input.txid, input.requestId ?? null, now, now).run()

  return suspenseId
}

// ---------------------------------------------------------------------------
// 別段預金（支払口）: RESERVED → EXECUTED
// ---------------------------------------------------------------------------
export async function executeSuspenseDebit(
  suspenseId: string, db: D1Database,
): Promise<void> {
  await db.prepare(
    `UPDATE SuspenseDetails SET status='EXECUTED', updated_at=? WHERE suspense_id=? AND status='RESERVED'`
  ).bind(nowISO(), suspenseId).run()
}

// ---------------------------------------------------------------------------
// 別段預金（受取口）: Hard Landing
// ---------------------------------------------------------------------------
export interface LandSuspenseInput {
  bankId: string
  accountId: string
  direction: 'RECEIVE'
  amount: number
  txid: string
  requestId?: string
  isCustody: boolean
  custodyReason?: string
}

export async function landSuspense(
  db: D1Database,
  input: LandSuspenseInput,
): Promise<string> {
  const now = nowISO()
  const suspenseId = `SUSP-RCV-${newUUID()}`
  const suspAcctId = suspenseAccountId(input.bankId)
  const status = input.isCustody ? 'CUSTODY' : 'LANDED'

  // 仕訳: 別段（受取口）(+) / ZC清算勘定(−)
  //   ZCS(−) = ZCが当行に支払義務を負った（受取超方向に移動） ← ゼロサム ✓
  //   後続の executeSuspenseCredit で 別段(−) / 顧客口座(+) に解消される
  const zcsAccountId = nostroAccountId(input.bankId)
  await insertJournalGroup(db, {
    bankId: input.bankId,
    txGroupId: `LAND-${suspenseId}`,
    entries: [
      { accountId: suspAcctId,   amount:  input.amount, txType: 'CREDIT', txid: input.txid, description: 'Hard Landing 別段受取口(+)' },
      { accountId: zcsAccountId, amount: -input.amount, txType: 'CREDIT', txid: input.txid, description: 'Hard Landing ZC清算(−) ZCが当行へ支払義務' },
    ],
    valueDate: now.slice(0, 10),
  })

  await db.prepare(
    `INSERT INTO SuspenseDetails
     (suspense_id, bank_id, account_id, direction, status, amount, txid, request_id, custody_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'RECEIVE', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(suspenseId, input.bankId, input.accountId, status,
    input.amount, input.txid, input.requestId ?? null,
    input.custodyReason ?? null, now, now).run()

  return suspenseId
}

// ---------------------------------------------------------------------------
// 利用可能残高 = 帳簿残高
// reserveSuspense が既に customer(-amount)/suspense(+amount) の仕訳を作成済みのため
// SUM(BankJournals) に -amount が反映済み。SuspenseDetails を再度差し引くと二重控除になる。
// ---------------------------------------------------------------------------
export async function getAvailableBalance(accountId: string, db: D1Database): Promise<number> {
  const balance = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId).first<{ b: number }>()

  return balance?.b ?? 0
}

// ---------------------------------------------------------------------------
// account_hash/account_id から BankAccount を取得
// モック: account_hash は "h:{account_id}" または account_id そのもの
// ---------------------------------------------------------------------------
export async function getAccountByHash(
  bankId: string, accountHash: string, db: D1Database,
): Promise<BankAccountRow | null> {
  const accountId = accountHash.startsWith('h:') ? accountHash.slice(2) : accountHash

  const byId = await db
    .prepare(`SELECT * FROM BankAccounts WHERE account_id=? AND bank_id=?`)
    .bind(accountId, bankId).first<BankAccountRow>()
  if (byId) return byId

  // フォールバック: bank の最初の NORMAL SAVINGS 口座
  return db
    .prepare(`SELECT * FROM BankAccounts WHERE bank_id=? AND status='NORMAL' AND account_type='SAVINGS' ORDER BY account_id LIMIT 1`)
    .bind(bankId).first<BankAccountRow>()
}

// ---------------------------------------------------------------------------
// DNS清算時の別段解消
// ---------------------------------------------------------------------------
export async function settleSuspenseForDns(
  bankId: string, dnsCycleId: string, db: D1Database,
): Promise<void> {
  const now = nowISO()
  // 当該サイクルのTXのみに限定（他サイクルの別段を誤って清算しない）
  await db.prepare(
    `UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, dns_cycle_id=?, updated_at=?
     WHERE bank_id=? AND status='EXECUTED' AND direction='PAY'
       AND txid IN (SELECT txid FROM Transactions WHERE dns_cycle_id=?)`
  ).bind(now, dnsCycleId, now, bankId, dnsCycleId).run()
}
