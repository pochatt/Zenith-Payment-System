/**
 * @file Suspense account and custody management. Handles fund reservation
 * (RESERVED), debit execution (EXECUTED), credit landing (LANDED/CUSTODY),
 * DNS settlement, and available balance calculation.
 * @module bank/suspense
 */
import type { BankAccountRow, SuspenseDirection } from "../types";
import { nowISO, suspenseAccountId, nostroAccountId } from "../types";
import { newUUID } from "../shared/idempotency";
import { insertJournalGroup } from "./ledger";

export interface ReserveSuspenseInput {
  bankId: string;
  accountId: string;
  direction: SuspenseDirection;
  amount: number;
  txid: string | null;
  requestId?: string;
  isCustody?: boolean;
  custodyReason?: string;
}

// ---------------------------------------------------------------------------
// segregated deposit (payment): Savings → suspense (RESERVED)
// ---------------------------------------------------------------------------
export async function reserveSuspense(
  db: D1Database,
  input: ReserveSuspenseInput
): Promise<string> {
  const now = nowISO();
  const suspenseId = `SUSP-${newUUID()}`;
  const suspAcctId = suspenseAccountId(input.bankId);

  // journal entry: Savings(-) / suspense(+) → zero-sum
  await insertJournalGroup(db, {
    bankId: input.bankId,
    txGroupId: `RESERVE-${suspenseId}`,
    entries: [
      {
        accountId: input.accountId,
        amount: -input.amount,
        txType: "RESERVE",
        txid: input.txid ?? undefined,
        description: "Hard Reservation",
      },
      {
        accountId: suspAcctId,
        amount: input.amount,
        txType: "RESERVE",
        txid: input.txid ?? undefined,
        description: "Hard Reservation offset",
      },
    ],
    valueDate: now.slice(0, 10),
  });

  await db
    .prepare(
      `INSERT INTO SuspenseDetails
     (suspense_id, bank_id, account_id, direction, status, amount, txid, request_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)`
    )
    .bind(
      suspenseId,
      input.bankId,
      input.accountId,
      input.direction,
      input.amount,
      input.txid,
      input.requestId ?? null,
      now,
      now
    )
    .run();

  return suspenseId;
}

// ---------------------------------------------------------------------------
// segregated deposit（payment account）: RESERVED → EXECUTED
// ---------------------------------------------------------------------------
export async function executeSuspenseDebit(suspenseId: string, db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE SuspenseDetails SET status='EXECUTED', updated_at=? WHERE suspense_id=? AND status='RESERVED'`
    )
    .bind(nowISO(), suspenseId)
    .run();
}

// ---------------------------------------------------------------------------
// segregated deposit (receipt): Hard Landing
// ---------------------------------------------------------------------------
export interface LandSuspenseInput {
  bankId: string;
  accountId: string;
  direction: "RECEIVE";
  amount: number;
  txid: string;
  requestId?: string;
  isCustody: boolean;
  custodyReason?: string;
}

export async function landSuspense(db: D1Database, input: LandSuspenseInput): Promise<string> {
  const now = nowISO();
  const suspenseId = `SUSP-RCV-${newUUID()}`;
  const suspAcctId = suspenseAccountId(input.bankId);
  const status = input.isCustody ? "CUSTODY" : "LANDED";

  // journal entry: suspense (receipt) (+) / ZC settlement (−)
  //   ZCS(−) = ZC owes bank (receipt-excess direction) ← zero-sum ✓
  //   Resolved in executeSuspenseCredit: suspense(−) / customer account(+)
  const zcsAccountId = nostroAccountId(input.bankId);
  await insertJournalGroup(db, {
    bankId: input.bankId,
    txGroupId: `LAND-${suspenseId}`,
    entries: [
      {
        accountId: suspAcctId,
        amount: input.amount,
        txType: "CREDIT",
        txid: input.txid,
        description: "Hard Landing 別段受取口(+)",
      },
      {
        accountId: zcsAccountId,
        amount: -input.amount,
        txType: "CREDIT",
        txid: input.txid,
        description: "Hard Landing ZC清算(−) ZCが当行へ支払義務",
      },
    ],
    valueDate: now.slice(0, 10),
  });

  await db
    .prepare(
      `INSERT INTO SuspenseDetails
     (suspense_id, bank_id, account_id, direction, status, amount, txid, request_id, custody_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'RECEIVE', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      suspenseId,
      input.bankId,
      input.accountId,
      status,
      input.amount,
      input.txid,
      input.requestId ?? null,
      input.custodyReason ?? null,
      now,
      now
    )
    .run();

  return suspenseId;
}

// ---------------------------------------------------------------------------
// available balance = ledger balance
// Since reserveSuspense already created journal entry customer(-)/suspense(+)
// SUM(BankJournals) reflects -amount. Deducting SuspenseDetails again = double deduction
// ---------------------------------------------------------------------------
export async function getAvailableBalance(accountId: string, db: D1Database): Promise<number> {
  const balance = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();

  return balance?.b ?? 0;
}

// ---------------------------------------------------------------------------
// Get BankAccount from account_hash/account_id
// Mock: account_hash is "h:{account_id}" or account_id itself
// ---------------------------------------------------------------------------
export async function getAccountByHash(
  bankId: string,
  accountHash: string,
  db: D1Database
): Promise<BankAccountRow | null> {
  const accountId = accountHash.startsWith("h:") ? accountHash.slice(2) : accountHash;

  return db
    .prepare(`SELECT * FROM BankAccounts WHERE account_id=? AND bank_id=?`)
    .bind(accountId, bankId)
    .first<BankAccountRow>();
}

// ---------------------------------------------------------------------------
// Segregated deposit liquidation at DNS settlement
// ---------------------------------------------------------------------------
export async function settleSuspenseForDns(
  bankId: string,
  dnsCycleId: string,
  db: D1Database
): Promise<void> {
  const now = nowISO();
  // Limit to TXs in this cycle (don't accidentally settle suspense from other cycles)
  // PAY direction: RESERVED → EXECUTED → SETTLED (payer suspense settlement)
  await db
    .prepare(
      `UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, dns_cycle_id=?, updated_at=?
     WHERE bank_id=? AND status='EXECUTED' AND direction='PAY'
       AND txid IN (SELECT txid FROM Transactions WHERE dns_cycle_id=?)`
    )
    .bind(now, dnsCycleId, now, bankId, dnsCycleId)
    .run();
  // RECEIVE direction: CUSTODY receipt-side records also eligible for DNS settlement
  // CUSTODY: funds unable to credit due to account freeze/closure. Even after DNS settlement
  // Funds in custody; settlement status must be recorded
  await db
    .prepare(
      `UPDATE SuspenseDetails SET dns_cycle_id=?, updated_at=?
     WHERE bank_id=? AND status='CUSTODY' AND direction='RECEIVE'
       AND dns_cycle_id IS NULL
       AND txid IN (SELECT txid FROM Transactions WHERE dns_cycle_id=?)`
    )
    .bind(dnsCycleId, now, bankId, dnsCycleId)
    .run();
}
