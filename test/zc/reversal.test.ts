/**
 * @file Regression tests for src/zc/reversal.ts
 *
 * Covers:
 *   B4 — Reversal auto-approval bypassed spec §2.2 policy. Reasons such as
 *        CUSTOMER_DISPUTE, FRAUD, INCORRECT_AMOUNT, and INCORRECT_PAYEE now
 *        require an approval_ref. DUPLICATE_PAYMENT and OPERATIONAL_ERROR may
 *        proceed without one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { requestReversal, APPROVAL_REQUIRED_REASONS } from "../../src/zc/reversal";
import { advanceStandard } from "../../src/zc/lanes/standard";
import type { Env } from "../../src/types";

let d1: MockD1Database;

function makeEnv(): Env {
  return {
    DB: d1 as unknown as D1Database,
    QUEUE: { send: async () => {} } as any,
    R2: {} as any,
    ZC_HMAC_SECRET: "",
    VAULT_URL: "",
    VAULT_TOKEN: "",
  } as unknown as Env;
}

function seedSettledTx(txid: string, amount = 500000) {
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, version, created_at, updated_at)
     VALUES (?, 'STANDARD', 'SETTLED', ?, 'JPY',
             '001', '0010000001', '002', '0020000001',
             ?, '1.0', 0,
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
  )
    .bind(txid, amount, `IK-${txid}`)
    ._runSync();
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

// ---------------------------------------------------------------------------
// Basic mechanics
// ---------------------------------------------------------------------------

describe("requestReversal — basic mechanics", () => {
  it("rejects when original txid is not found", async () => {
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-NONEXISTENT",
        reason: "DUPLICATE_PAYMENT",
        requested_by: "001",
        idempotency_key: "ik-001",
      },
      env
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("ORIGINAL_NOT_FOUND");
  });

  it("rejects when original is not SETTLED", async () => {
    d1.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, version, created_at, updated_at)
       VALUES ('TX-PENDING', 'STANDARD', 'RECEIVED', 10000, 'JPY',
               '001', '0010000001', '002', '0020000001',
               'IK-PENDING', '1.0', 0,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )._runSync();

    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-PENDING",
        reason: "DUPLICATE_PAYMENT",
        requested_by: "001",
        idempotency_key: "ik-002",
      },
      env
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("ORIGINAL_NOT_SETTLED");
  });

  it("succeeds full reversal for DUPLICATE_PAYMENT without approval_ref", async () => {
    seedSettledTx("TX-DUP-001");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-DUP-001",
        reason: "DUPLICATE_PAYMENT",
        requested_by: "001",
        idempotency_key: "ik-dup-001",
      },
      env
    );
    expect(result.result).toBe("REVERSAL_CREATED");
    expect(result.reversal_txid).toMatch(/^TX-REV-/);
  });

  it("succeeds for OPERATIONAL_ERROR without approval_ref", async () => {
    seedSettledTx("TX-OPS-001");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-OPS-001",
        reason: "OPERATIONAL_ERROR",
        requested_by: "OPS",
        idempotency_key: "ik-ops-001",
      },
      env
    );
    expect(result.result).toBe("REVERSAL_CREATED");
  });

  it("rejects amount exceeding original", async () => {
    seedSettledTx("TX-OVER-001", 10000);
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-OVER-001",
        amount: 99999,
        reason: "DUPLICATE_PAYMENT",
        requested_by: "001",
        idempotency_key: "ik-over-001",
      },
      env
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("INVALID_REVERSAL_AMOUNT");
  });

  it("rejects over-reversal across multiple requests", async () => {
    seedSettledTx("TX-OVER2-001", 10000);
    const env = makeEnv();

    // First reversal for 8000 — OK
    await requestReversal(
      {
        original_txid: "TX-OVER2-001",
        amount: 8000,
        reason: "DUPLICATE_PAYMENT",
        requested_by: "001",
        idempotency_key: "ik-a",
      },
      env
    );

    // Second reversal for 3000 — would exceed original 10000
    const result = await requestReversal(
      {
        original_txid: "TX-OVER2-001",
        amount: 3000,
        reason: "DUPLICATE_PAYMENT",
        requested_by: "001",
        idempotency_key: "ik-b",
      },
      env
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("OVER_REVERSAL");
  });
});

// ---------------------------------------------------------------------------
// B4: Approval policy (spec §2.2)
// ---------------------------------------------------------------------------

describe("requestReversal — approval policy (B4)", () => {
  it("rejects CUSTOMER_DISPUTE without approval_ref", async () => {
    seedSettledTx("TX-CD-001");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-CD-001",
        reason: "CUSTOMER_DISPUTE",
        requested_by: "001",
        idempotency_key: "ik-cd-001",
      },
      env
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("APPROVAL_REF_REQUIRED");
  });

  it("rejects FRAUD without approval_ref", async () => {
    seedSettledTx("TX-FR-001");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-FR-001",
        reason: "FRAUD",
        requested_by: "OPS",
        idempotency_key: "ik-fr-001",
      },
      env
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("APPROVAL_REF_REQUIRED");
  });

  it("rejects INCORRECT_AMOUNT without approval_ref", async () => {
    seedSettledTx("TX-IA-001");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-IA-001",
        reason: "INCORRECT_AMOUNT",
        requested_by: "001",
        idempotency_key: "ik-ia-001",
      },
      env
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("APPROVAL_REF_REQUIRED");
  });

  it("rejects INCORRECT_PAYEE without approval_ref", async () => {
    seedSettledTx("TX-IP-001");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-IP-001",
        reason: "INCORRECT_PAYEE",
        requested_by: "001",
        idempotency_key: "ik-ip-001",
      },
      env
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("APPROVAL_REF_REQUIRED");
  });

  it("accepts CUSTOMER_DISPUTE with a payee consent approval_ref", async () => {
    seedSettledTx("TX-CD-002");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-CD-002",
        reason: "CUSTOMER_DISPUTE",
        requested_by: "001",
        idempotency_key: "ik-cd-002",
        approval_ref: "PAYEE_CONSENT:CONS-abc123",
      },
      env
    );
    expect(result.result).toBe("REVERSAL_CREATED");
    expect(result.reversal_txid).toMatch(/^TX-REV-/);
  });

  it("accepts FRAUD with an authority request approval_ref", async () => {
    seedSettledTx("TX-FR-002");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-FR-002",
        reason: "FRAUD",
        requested_by: "OPS",
        idempotency_key: "ik-fr-002",
        approval_ref: "AUTHORITY_REQUEST:AUTH-xyz789",
      },
      env
    );
    expect(result.result).toBe("REVERSAL_CREATED");
  });

  it("persists approval_ref in ReversalRecords", async () => {
    seedSettledTx("TX-CD-003");
    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-CD-003",
        reason: "CUSTOMER_DISPUTE",
        requested_by: "001",
        idempotency_key: "ik-cd-003",
        approval_ref: "COURT_ORDER:ORD-00099",
      },
      env
    );
    expect(result.result).toBe("REVERSAL_CREATED");

    const row = await d1
      .prepare(`SELECT approval_ref FROM ReversalRecords WHERE reversal_id = ?`)
      .bind(result.reversal_id)
      .first<{ approval_ref: string | null }>();
    expect(row?.approval_ref).toBe("COURT_ORDER:ORD-00099");
  });

  it("APPROVAL_REQUIRED_REASONS covers exactly the four policy-sensitive reasons", () => {
    expect(APPROVAL_REQUIRED_REASONS).toContain("CUSTOMER_DISPUTE");
    expect(APPROVAL_REQUIRED_REASONS).toContain("INCORRECT_AMOUNT");
    expect(APPROVAL_REQUIRED_REASONS).toContain("INCORRECT_PAYEE");
    expect(APPROVAL_REQUIRED_REASONS).toContain("FRAUD");
    expect(APPROVAL_REQUIRED_REASONS).not.toContain("DUPLICATE_PAYMENT");
    expect(APPROVAL_REQUIRED_REASONS).not.toContain("OPERATIONAL_ERROR");
  });
});

// ---------------------------------------------------------------------------
// B4 regression: Reversal TX auto-authorizes (purpose=REFUND)
// ---------------------------------------------------------------------------

describe("requestReversal — reversal TX auto-authorizes via advanceStandard (B4 regression)", () => {
  function seedParticipant(bankId: string, hLimit = 5_000_000) {
    d1.prepare(
      `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES (?, 'Test Bank', '/bank/${bankId}', ?, 0, 1, '2025-01-01T00:00:00Z')`
    )
      .bind(bankId, hLimit)
      ._runSync();
  }

  function seedAccount(bankId: string, accountId: string, balance = 0) {
    d1.prepare(
      `INSERT OR IGNORE INTO BankAccounts
       (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'CUST', 'Test User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
    )
      .bind(accountId, bankId)
      ._runSync();
    if (balance > 0) {
      d1.prepare(
        `INSERT INTO BankJournals
         (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
         VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
      )
        .bind(`JNL-${accountId}`, bankId, accountId, balance)
        ._runSync();
    }
  }

  it("reversal TX reaches DECIDED_TO_SETTLE automatically without a manual /authorize call", async () => {
    // Original TX: payer=001/0010000001, payee=002/0020000001
    // Reversal TX: payer=002/0020000001, payee=001/0010000001
    seedParticipant("001");
    seedParticipant("002");
    // Payer in reversal is bank 002 account 0020000001 — needs balance
    seedAccount("001", "0010000001"); // payee in reversal (name-check target)
    seedAccount("002", "0020000001", 2_000_000); // payer in reversal (needs balance for reserve-funds)
    seedAccount("001", "001-ZCS");
    seedAccount("002", "002-ZCS");
    seedAccount("001", "0010000000"); // suspense for bank 001
    seedAccount("002", "0020000000"); // suspense for bank 002

    seedSettledTx("TX-REV-B4-ORIG", 100_000);

    const env = makeEnv();
    const result = await requestReversal(
      {
        original_txid: "TX-REV-B4-ORIG",
        reason: "DUPLICATE_PAYMENT",
        requested_by: "001",
        idempotency_key: "ik-rev-b4-001",
      },
      env
    );
    expect(result.result).toBe("REVERSAL_CREATED");
    const reversalTxid = result.reversal_txid!;
    expect(reversalTxid).toMatch(/^TX-REV-/);

    // Simulate queue consumer processing ADVANCE_STANDARD for the reversal TX
    await advanceStandard(reversalTxid, env);

    const tx = await d1
      .prepare(`SELECT state, purpose FROM Transactions WHERE txid=?`)
      .bind(reversalTxid)
      .first<{ state: string; purpose: string | null }>();

    expect(tx?.purpose).toBe("REFUND");
    // Must have moved past H_RESERVED automatically — no manual /authorize needed
    expect(tx?.state).toBe("DECIDED_TO_SETTLE");
  });
});
