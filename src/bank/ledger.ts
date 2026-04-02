/**
 * @file Zero-sum double-entry ledger (BankJournals). Every journal group must
 * satisfy SUM(amount)==0. Supports daily balance snapshots, interest accrual
 * (30/360), and zero-sum verification.
 * @module bank/ledger
 */
import { nowISO, suspenseAccountId, retainedEarningsAccountId } from '../types'
import { newUUID } from '../shared/idempotency'

export interface JournalEntry {
  accountId: string
  amount: number       // 符号付き（正=増加、負=減少）
  txType: string       // TRANSFER|RESERVE|EXECUTE|CREDIT|INTEREST|CASH|CORRECTION
  txid?: string
  description?: string
}

export interface JournalGroupInput {
  bankId: string
  txGroupId: string
  entries: JournalEntry[]
  valueDate: string    // YYYY-MM-DD
}

/**
 * 仕訳グループを一括 INSERT する。
 * ゼロサム検証: SUM(amount) が 0 でなければ例外
 */
export async function insertJournalGroup(
  db: D1Database,
  input: JournalGroupInput,
): Promise<void> {
  const sum = input.entries.reduce((s, e) => s + e.amount, 0)
  if (sum !== 0) {
    // ゼロサム違反はシステムバグなので例外を投げる
    throw new Error(`Zero-sum violation: SUM(amount)=${sum} for group=${input.txGroupId}`)
  }

  const now = nowISO()
  const stmts = input.entries.map(e =>
    db.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, txid, tx_group_id, description, value_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `JNL-${newUUID()}`, input.bankId, e.accountId, e.amount,
      e.txType, e.txid ?? null, input.txGroupId,
      e.description ?? null, input.valueDate, now,
    )
  )
  await db.batch(stmts)
}

/**
 * 口座残高を計算する（仕訳の合計）
 */
export async function calcBalance(accountId: string, db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS balance FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ balance: number }>()
  return row?.balance ?? 0
}

/**
 * 日次残高スナップショットを保存
 */
export async function snapshotDailyBalance(
  accountId: string, snapshotDate: string, db: D1Database,
): Promise<void> {
  const balance = await calcBalance(accountId, db)
  await db.prepare(
    `INSERT OR REPLACE INTO DailyBalances (account_id, snapshot_date, end_of_day_balance)
     VALUES (?, ?, ?)`
  ).bind(accountId, snapshotDate, balance).run()
}

/**
 * 利息計算と仕訳（30/360）
 * annual_rate: 0.001 = 0.1%
 */
export async function applyDailyInterest(
  bankId: string, snapshotDate: string, db: D1Database,
): Promise<void> {
  const accounts = await db
    .prepare(`SELECT account_id FROM BankAccounts WHERE bank_id=? AND status='NORMAL' AND account_type='SAVINGS'`)
    .bind(bankId).all<{ account_id: string }>()

  const rate = await db
    .prepare(`SELECT annual_rate FROM InterestRates WHERE bank_id=? AND account_type='SAVINGS' AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`)
    .bind(bankId, snapshotDate).first<{ annual_rate: number }>()

  if (!rate || accounts.results.length === 0) return

  const dailyRate = rate.annual_rate / 360  // 30/360 ルール
  const reAcctId = retainedEarningsAccountId(bankId) // 利益剰余金口座（別段預金を汚さない）

  for (const acc of accounts.results) {
    const balance = await calcBalance(acc.account_id, db)
    if (balance <= 0) continue
    const interest = Math.floor(balance * dailyRate)
    if (interest === 0) continue

    // ゼロサム: 利益剰余金(負=費用) と 普通預金(正=負債)
    await insertJournalGroup(db, {
      bankId, txGroupId: `INT-${snapshotDate}-${acc.account_id}`,
      entries: [
        { accountId: acc.account_id, amount: interest, txType: 'INTEREST', description: `利息入金 ${snapshotDate}` },
        { accountId: reAcctId, amount: -interest, txType: 'INTEREST', description: `利息 費用計上 ${snapshotDate}` },
      ],
      valueDate: snapshotDate,
    })
  }
}

/**
 * ゼロサム検証（全仕訳の合計）
 */
export async function verifyZeroSum(bankId: string, db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(j.amount), 0) AS total FROM BankJournals j WHERE j.bank_id = ?`)
    .bind(bankId).first<{ total: number }>()
  return (row?.total ?? 0) === 0
}
