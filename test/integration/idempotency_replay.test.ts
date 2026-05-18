/**
 * @file idempotency_replay.test.ts — Idempotency-key replay across major lanes.
 *
 * Verifies that a second request carrying the same Idempotency-Key returns the
 * cached response verbatim and does NOT create a second Transactions row.
 *
 * Lanes covered: EXPRESS (synchronous decision), STANDARD (queued advance),
 * and HTLC (separate create endpoint).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handlePostTransfers, handlePostHtlcCreate } from "../../src/zc/ingress";

const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const PAYER_ACC = "0010000001";
const PAYEE_ACC = "0020000001";

let d1: MockD1Database;

function makeEnv() {
  return {
    DB: d1 as unknown as D1Database,
    QUEUE: { send: async () => {} } as any,
    ZC_HMAC_SECRET: "test-secret",
  } as any;
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("https://zc.example.com/api/transfers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function transferPayload(txid: string, idemKey: string, lane = "EXPRESS", amount = 10_000) {
  return {
    schema_version: "1.0",
    txid,
    idempotency_key: idemKey,
    lane,
    amount: { value: amount, currency: "JPY" },
    payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
    payee: { bank_id: PAYEE_BANK, account_hash: PAYEE_ACC },
    purpose: "P2P",
  };
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;

  for (const bankId of [PAYER_BANK, PAYEE_BANK]) {
    d1.prepare(
      `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES (?, 'Test Bank', '/bank/${bankId}', 100000000, 0, 1, '2025-01-01T00:00:00Z')`
    )
      .bind(bankId)
      ._runSync();
  }
});

// ---------------------------------------------------------------------------
// EXPRESS — synchronous decision; result is stored immediately after the call.
// ---------------------------------------------------------------------------

describe("EXPRESS idempotency replay", () => {
  it("returns the same txid and result on second call, creates only one Transactions row", async () => {
    const env = makeEnv();
    const payload = transferPayload("TX-IDEM-EXP-001", "IK-EXP-001");

    const resp1 = await handlePostTransfers(makeRequest(payload), env);
    const body1 = await resp1.json<any>();
    expect(resp1.status).toBe(200);
    expect(body1.result).toBe("DECISION_ACCEPTED");

    const resp2 = await handlePostTransfers(makeRequest(payload), env);
    const body2 = await resp2.json<any>();
    expect(resp2.status).toBe(200);
    expect(body2).toEqual(body1);

    // Only one Transactions row must exist for this idempotency_key.
    const count = await d1
      .prepare(`SELECT COUNT(*) AS c FROM Transactions WHERE idempotency_key = ?`)
      .bind("IK-EXP-001")
      .first<{ c: number }>();
    expect(count?.c).toBe(1);

    // Only one IdempotencyKeys row.
    const idemCount = await d1
      .prepare(`SELECT COUNT(*) AS c FROM IdempotencyKeys WHERE key = ?`)
      .bind("IK-EXP-001")
      .first<{ c: number }>();
    expect(idemCount?.c).toBe(1);
  });

  it("a third call with the same key also returns the cached body", async () => {
    const env = makeEnv();
    const payload = transferPayload("TX-IDEM-EXP-002", "IK-EXP-002");

    const resp1 = await handlePostTransfers(makeRequest(payload), env);
    const body1 = await resp1.json<any>();

    await handlePostTransfers(makeRequest(payload), env);
    const resp3 = await handlePostTransfers(makeRequest(payload), env);
    const body3 = await resp3.json<any>();

    expect(body3).toEqual(body1);
  });

  it("a different key on a same-body request produces a new Transactions row", async () => {
    const env = makeEnv();

    await handlePostTransfers(makeRequest(transferPayload("TX-IDEM-EXP-003", "IK-EXP-003A")), env);
    await handlePostTransfers(makeRequest(transferPayload("TX-IDEM-EXP-004", "IK-EXP-003B")), env);

    const count = await d1
      .prepare(
        `SELECT COUNT(*) AS c FROM Transactions WHERE txid IN ('TX-IDEM-EXP-003', 'TX-IDEM-EXP-004')`
      )
      .first<{ c: number }>();
    expect(count?.c).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// STANDARD — queued advance; ingress returns INGRESS_ACCEPTED immediately.
// The replay must return the same INGRESS_ACCEPTED without re-queuing.
// ---------------------------------------------------------------------------

describe("STANDARD idempotency replay", () => {
  it("replays INGRESS_ACCEPTED response without creating a second Transactions row", async () => {
    const env = makeEnv();
    const payload = transferPayload("TX-IDEM-STD-001", "IK-STD-001", "STANDARD");

    const resp1 = await handlePostTransfers(makeRequest(payload), env);
    const body1 = await resp1.json<any>();
    expect(body1.result).toBe("INGRESS_ACCEPTED");

    const resp2 = await handlePostTransfers(makeRequest(payload), env);
    const body2 = await resp2.json<any>();
    expect(body2).toEqual(body1);

    const count = await d1
      .prepare(`SELECT COUNT(*) AS c FROM Transactions WHERE idempotency_key = ?`)
      .bind("IK-STD-001")
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HTLC — separate endpoint (POST /api/htlc/create).
// ---------------------------------------------------------------------------

describe("HTLC idempotency replay", () => {
  it("replays the CREATED response and does not create a second HtlcContracts row", async () => {
    const env = makeEnv();
    const body = {
      htlc_id: "HTLC-IDEM-001",
      idempotency_key: "IK-HTLC-001",
      amount: { value: 20_000, currency: "JPY" },
      payer_bank_id: PAYER_BANK,
      payer_account_hash: PAYER_ACC,
      payee_bank_id: PAYEE_BANK,
      payee_account_hash: PAYEE_ACC,
      timelock: "2099-12-31T00:00:00Z",
      hashlock: "a".repeat(64),
    };

    const req1 = new Request("https://zc.example.com/api/htlc/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const resp1 = await handlePostHtlcCreate(req1, env);
    const result1 = await resp1.json<any>();
    expect(resp1.status).toBe(201);
    expect(result1.result).toBe("CREATED");

    const req2 = new Request("https://zc.example.com/api/htlc/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const resp2 = await handlePostHtlcCreate(req2, env);
    const result2 = await resp2.json<any>();
    // Replay returns 200 (not 201), but body is the original result.
    expect(resp2.status).toBe(200);
    expect(result2).toEqual(result1);

    // Only one HtlcContracts row.
    const count = await d1
      .prepare(`SELECT COUNT(*) AS c FROM HtlcContracts WHERE htlc_id = ?`)
      .bind("HTLC-IDEM-001")
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });
});
