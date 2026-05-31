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
// Segregated deposit (payment side): ordinary account → segregated (RESERVED)
// ---------------------------------------------------------------------------
export async function reserveSuspense(
  db: D1Database,
  input: ReserveSuspenseInput
): Promise<string> {
  const now = nowISO();
  const suspenseId = `SUSP-${newUUID()}`;
  const suspAcctId = suspenseAccountId(input.bankId);

  // Journal entry: ordinary deposit (-) / segregated deposit (suspense) (+)  -> zero-sum
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
// Segregated deposit (suspense) (payment leg): RESERVED -> EXECUTED
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
// Segregated deposit (suspense) (receiving leg): Hard Landing
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

  // Journal entry: segregated (suspense) (receiving leg) (+) / ZC settlement account (-)
  //   ZCS(-) = ZC incurred a payment obligation to this bank (moved toward a net-receiving position) <- zero-sum ✓
  //   Resolved by the subsequent executeSuspenseCredit into segregated (suspense) (-) / customer account (+)
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
// Available balance = book balance
// Because reserveSuspense has already created the customer(-amount)/suspense(+amount) journal entry
// -amount is already reflected in SUM(BankJournals). Subtracting SuspenseDetails again would cause a double deduction.
// ---------------------------------------------------------------------------
export async function getAvailableBalance(accountId: string, db: D1Database): Promise<number> {
  const balance = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();

  return balance?.b ?? 0;
}

// ---------------------------------------------------------------------------
// Fetch BankAccount from account_hash/account_id
// Mock: account_hash is either "h:{account_id}" or account_id itself
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
// Resolution of segregated (suspense) at DNS settlement
// ---------------------------------------------------------------------------
export async function settleSuspenseForDns(
  bankId: string,
  dnsCycleId: string,
  db: D1Database
): Promise<void> {
  const now = nowISO();
  // Restrict to the TX of this cycle only (do not mistakenly settle segregated (suspense) of other cycles)
  // PAY direction: RESERVED -> EXECUTED -> SETTLED (settlement of the payer-side segregated (suspense))
  await db
    .prepare(
      `UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, dns_cycle_id=?, updated_at=?
     WHERE bank_id=? AND status='EXECUTED' AND direction='PAY'
       AND txid IN (SELECT txid FROM Transactions WHERE dns_cycle_id=?)`
    )
    .bind(now, dnsCycleId, now, bankId, dnsCycleId)
    .run();
  // RECEIVE direction: receiving-side records with CUSTODY status are also included in DNS settlement
  // CUSTODY is funds that could not be credited due to a frozen/closed account. Even after DNS settlement completes,
  // the funds themselves remain in custody, but the settlement status must still be recorded
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
