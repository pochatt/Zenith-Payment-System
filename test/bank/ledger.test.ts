/**
 * @file Integration tests for src/bank/ledger.ts
 *
 * Verifies double-entry zero-sum invariants, balance calculation,
 * and interest accrual.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  insertJournalGroup,
  calcBalance,
  verifyZeroSum,
  applyDailyInterest,
  snapshotDailyBalance,
} from "../../src/bank/ledger";

const BANK_ID = "001";

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  // 0002_bank_schema.sql の初期データ（JNL-INIT-001-*）がロード済み
});

describe("insertJournalGroup", () => {
  it("inserts zero-sum entries without throwing", async () => {
    await expect(
      insertJournalGroup(d1 as any, {
        bankId: BANK_ID,
        txGroupId: "TEST-GROUP-001",
        entries: [
          { accountId: "0010000001", amount: 50_000, txType: "TRANSFER" },
          { accountId: "001-ZCS", amount: -50_000, txType: "TRANSFER" },
        ],
        valueDate: "2025-06-01",
      })
    ).resolves.toBeUndefined();
  });

  it("throws on non-zero-sum entries", async () => {
    await expect(
      insertJournalGroup(d1 as any, {
        bankId: BANK_ID,
        txGroupId: "TEST-GROUP-BAD",
        entries: [
          { accountId: "0010000001", amount: 50_000, txType: "TRANSFER" },
          { accountId: "001-ZCS", amount: -49_999, txType: "TRANSFER" }, // off by 1
        ],
        valueDate: "2025-06-01",
      })
    ).rejects.toThrow("Zero-sum violation");
  });

  it("inserts entries and they appear in calcBalance", async () => {
    const before = await calcBalance("0010000001", d1 as any);
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "TEST-GROUP-002",
      entries: [
        { accountId: "0010000001", amount: 30_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: -30_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    const after = await calcBalance("0010000001", d1 as any);
    expect(after - before).toBe(30_000);
  });
});

describe("calcBalance", () => {
  it("returns the correct balance for an account with initial data", async () => {
    // 0010000001 has two initial entries of +1,000,000 each in the seed
    const balance = await calcBalance("0010000001", d1 as any);
    expect(balance).toBe(1_000_000);
  });

  it("returns 0 for an account with no entries", async () => {
    const balance = await calcBalance("nonexistent-account", d1 as any);
    expect(balance).toBe(0);
  });

  it("sums positive and negative entries correctly", async () => {
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "CALC-TEST",
      entries: [
        { accountId: "0010000001", amount: -200_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: 200_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-02",
    });
    const balance = await calcBalance("0010000001", d1 as any);
    expect(balance).toBe(800_000); // 1,000,000 - 200,000
  });
});

describe("verifyZeroSum", () => {
  it("returns true for the initial seed data", async () => {
    const ok = await verifyZeroSum(BANK_ID, d1 as any);
    expect(ok).toBe(true);
  });

  it("returns true after adding a zero-sum journal", async () => {
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "ZS-TEST-001",
      entries: [
        { accountId: "0010000001", amount: 10_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: -10_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    expect(await verifyZeroSum(BANK_ID, d1 as any)).toBe(true);
  });

  it("returns false after directly injecting an unbalanced entry", async () => {
    // Bypass insertJournalGroup to simulate a corruption scenario
    d1.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES ('BAD-ENTRY', ?, '0010000001', 1, 'TRANSFER', 'BAD', '2025-06-01', '2025-06-01T00:00:00Z')`
    )
      .bind(BANK_ID)
      ._runSync();
    expect(await verifyZeroSum(BANK_ID, d1 as any)).toBe(false);
  });
});

describe("applyDailyInterest", () => {
  it("credits interest to savings accounts and debits retained earnings", async () => {
    const beforeBalance = await calcBalance("0010000001", d1 as any);
    await applyDailyInterest(BANK_ID, "2025-06-01", d1 as any);
    const afterBalance = await calcBalance("0010000001", d1 as any);

    // annual_rate=0.001, daily = 0.001/360 ≈ 0.0000028
    // interest = floor(1_000_000 * 0.001 / 360) = floor(2.78) = 2
    expect(afterBalance - beforeBalance).toBe(2);
  });

  it("preserves zero-sum after interest accrual", async () => {
    await applyDailyInterest(BANK_ID, "2025-06-01", d1 as any);
    expect(await verifyZeroSum(BANK_ID, d1 as any)).toBe(true);
  });

  it("does not credit interest for accounts with zero balance", async () => {
    // Drain account 0010000002 to zero first
    const balance = await calcBalance("0010000002", d1 as any);
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "DRAIN",
      entries: [
        { accountId: "0010000002", amount: -balance, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: balance, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    const before = await calcBalance("0010000002", d1 as any);
    await applyDailyInterest(BANK_ID, "2025-06-01", d1 as any);
    const after = await calcBalance("0010000002", d1 as any);
    expect(after).toBe(before);
  });
});

describe("snapshotDailyBalance", () => {
  it("stores the current balance as a daily snapshot", async () => {
    await snapshotDailyBalance("0010000001", "2025-06-01", d1 as any);
    const row = await d1
      .prepare(
        `SELECT end_of_day_balance FROM DailyBalances WHERE account_id=? AND snapshot_date=?`
      )
      .bind("0010000001", "2025-06-01")
      .first<{ end_of_day_balance: number }>();
    expect(row?.end_of_day_balance).toBe(1_000_000);
  });

  it("overwrites an existing snapshot (INSERT OR REPLACE)", async () => {
    await snapshotDailyBalance("0010000001", "2025-06-01", d1 as any);
    // Add a transaction and re-snapshot
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "SNAP-UPDATE",
      entries: [
        { accountId: "0010000001", amount: 5_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: -5_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    await snapshotDailyBalance("0010000001", "2025-06-01", d1 as any);
    const row = await d1
      .prepare(
        `SELECT end_of_day_balance FROM DailyBalances WHERE account_id=? AND snapshot_date=?`
      )
      .bind("0010000001", "2025-06-01")
      .first<{ end_of_day_balance: number }>();
    expect(row?.end_of_day_balance).toBe(1_005_000);
  });
});
