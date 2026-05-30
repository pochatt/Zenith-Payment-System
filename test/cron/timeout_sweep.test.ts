/**
 * @file Tests for the per-minute timeout sweep (cron/timeout_sweep.ts).
 *
 * The sweep advances stale transactions through several timeout paths. The
 * focus here is the SUSPENDED → FAILED_EXECUTION path: FAILED_EXECUTION is a
 * *terminal* state, so the transition MUST leave a paired FinalityLog entry —
 * otherwise a transaction reaches its end state with no audit record, the exact
 * "state advanced without evidence" window the system forbids (design
 * principle #1). This previously used a raw UPDATE that skipped the log; these
 * tests guard against that regression.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";

function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
  };
}

let d1: MockD1Database;

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

/** Seed a SUSPENDED transaction with an explicit expires_at. */
function seedSuspendedTx(db: MockD1Database, txid: string, expiresAt: string | null) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, reason_code, expires_at,
      created_at, updated_at, version)
     VALUES (?, 'EXPRESS', 'SUSPENDED', 5000, 'JPY', '001', 'payerAcc', '002', 'payeeAcc',
             ?, '1.0', 'SUSPEND_EXEC_TIMEOUT', ?, '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
  )
    .bind(txid, `IK-${txid}`, expiresAt)
    ._runSync();
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, "001");
  seedParticipant(d1, "002");
});

describe("runTimeoutSweep — SUSPENDED → FAILED_EXECUTION", () => {
  it("advances a SUSPENDED tx past expires_at to FAILED_EXECUTION", async () => {
    seedSuspendedTx(d1, "TX-SWEEP-1", "2000-01-01T00:00:00Z"); // long past
    await runTimeoutSweep(makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
      .bind("TX-SWEEP-1")
      .first<{ state: string; reason_code: string }>();
    expect(tx?.state).toBe("FAILED_EXECUTION");
    expect(tx?.reason_code).toBe("FAILED_EXEC_TIMEOUT");
  });

  it("writes a paired FinalityLog 'FailedExecution' entry for the transition", async () => {
    seedSuspendedTx(d1, "TX-SWEEP-2", "2000-01-01T00:00:00Z");
    await runTimeoutSweep(makeEnv(d1));

    const log = await d1
      .prepare(
        `SELECT event_type, state_from, state_to FROM FinalityLog
         WHERE txid = ? AND event_type = 'FailedExecution'`
      )
      .bind("TX-SWEEP-2")
      .first<{ event_type: string; state_from: string; state_to: string }>();
    expect(log).not.toBeNull();
    expect(log?.state_from).toBe("SUSPENDED");
    expect(log?.state_to).toBe("FAILED_EXECUTION");
  });

  it("does NOT sweep a SUSPENDED tx whose expires_at is still in the future", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    seedSuspendedTx(d1, "TX-SWEEP-3", future);
    await runTimeoutSweep(makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-SWEEP-3")
      .first<{ state: string }>();
    expect(tx?.state).toBe("SUSPENDED");

    const log = await d1
      .prepare(
        `SELECT COUNT(*) AS cnt FROM FinalityLog WHERE txid = ? AND event_type = 'FailedExecution'`
      )
      .bind("TX-SWEEP-3")
      .first<{ cnt: number }>();
    expect(log?.cnt).toBe(0);
  });

  it("does NOT sweep a SUSPENDED tx with no expires_at set", async () => {
    seedSuspendedTx(d1, "TX-SWEEP-4", null);
    await runTimeoutSweep(makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-SWEEP-4")
      .first<{ state: string }>();
    expect(tx?.state).toBe("SUSPENDED");
  });

  it("the FAILED_EXECUTION transition has exactly one FinalityLog entry (idempotent across runs)", async () => {
    seedSuspendedTx(d1, "TX-SWEEP-5", "2000-01-01T00:00:00Z");
    await runTimeoutSweep(makeEnv(d1));
    await runTimeoutSweep(makeEnv(d1)); // second run: tx already terminal, CAS no-ops

    const log = await d1
      .prepare(
        `SELECT COUNT(*) AS cnt FROM FinalityLog WHERE txid = ? AND event_type = 'FailedExecution'`
      )
      .bind("TX-SWEEP-5")
      .first<{ cnt: number }>();
    expect(log?.cnt).toBe(1);
  });
});
