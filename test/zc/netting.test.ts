/**
 * @file Multilateral netting optimizer tests (analysis-only).
 *
 * Covers the pure planner (computeNettingPlan / computeNetPositions) and the
 * DB loader (loadObligationsForDate). Verifies the core invariants:
 * - net positions are preserved across all three regimes
 * - multilateral produces at most (P-1) transfers and never more liquidity
 *   than bilateral, which never exceeds gross
 * - a pure debt cycle (A→B→C→A) nets to zero transfers
 * - the loader only pulls settlement-eligible txs assigned to the date's cycle
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  computeNetPositions,
  computeNettingPlan,
  loadObligationsForDate,
  type Obligation,
  type Transfer,
} from "../../src/zc/netting";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

// Net positions implied by a transfer list, for invariant checks.
function netOf(transfers: Transfer[]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const t of transfers) {
    net[t.from] = (net[t.from] ?? 0) - t.amount;
    net[t.to] = (net[t.to] ?? 0) + t.amount;
  }
  // drop zero entries for easy comparison
  for (const k of Object.keys(net)) if (net[k] === 0) delete net[k];
  return net;
}

describe("computeNetPositions", () => {
  it("folds obligations into zero-sum net positions", () => {
    const obs: Obligation[] = [
      { from: "001", to: "002", amount: 100 },
      { from: "002", to: "003", amount: 30 },
    ];
    const net = computeNetPositions(obs);
    expect(net["001"]).toBe(-100);
    expect(net["002"]).toBe(70);
    expect(net["003"]).toBe(30);
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("ignores zero/negative amounts and self-transfers", () => {
    const net = computeNetPositions([
      { from: "001", to: "001", amount: 500 },
      { from: "001", to: "002", amount: 0 },
      { from: "001", to: "002", amount: -50 },
    ]);
    expect(Object.keys(net)).toHaveLength(0);
  });
});

describe("computeNettingPlan", () => {
  it("collapses bilateral round-trips and preserves net positions", () => {
    // 001→002 100, 002→001 60  => net 001 -40, 002 +40
    const plan = computeNettingPlan([
      { from: "001", to: "002", amount: 100 },
      { from: "002", to: "001", amount: 60 },
    ]);

    expect(plan.gross.payment_count).toBe(2);
    expect(plan.gross.total_liquidity).toBe(160);

    expect(plan.bilateral.transfers).toEqual([{ from: "001", to: "002", amount: 40 }]);
    expect(plan.multilateral.transfers).toEqual([{ from: "001", to: "002", amount: 40 }]);

    // all regimes must reproduce the same net positions
    expect(netOf(plan.gross.transfers)).toEqual(plan.net_positions);
    expect(netOf(plan.bilateral.transfers)).toEqual(plan.net_positions);
    expect(netOf(plan.multilateral.transfers)).toEqual(plan.net_positions);
    expect(plan.balanced).toBe(true);
  });

  it("zeroes out a pure debt cycle A→B→C→A", () => {
    const plan = computeNettingPlan([
      { from: "001", to: "002", amount: 100 },
      { from: "002", to: "003", amount: 100 },
      { from: "003", to: "001", amount: 100 },
    ]);
    // every net position is zero → no settlement needed at all
    expect(plan.net_positions).toEqual({});
    expect(plan.multilateral.payment_count).toBe(0);
    expect(plan.multilateral.total_liquidity).toBe(0);
    expect(plan.gross.total_liquidity).toBe(300);
    expect(plan.netting_efficiency).toBe(1);
    expect(plan.savings.liquidity_reduction_pct).toBe(100);
  });

  it("bounds multilateral transfers by (participants - 1) and orders by magnitude", () => {
    // Three debtors paying one big creditor.
    const plan = computeNettingPlan([
      { from: "001", to: "004", amount: 50 },
      { from: "002", to: "004", amount: 30 },
      { from: "003", to: "004", amount: 20 },
    ]);
    expect(plan.participant_count).toBe(4);
    expect(plan.multilateral.payment_count).toBeLessThanOrEqual(plan.participant_count - 1);
    // largest debtor settles first (deterministic ordering)
    expect(plan.multilateral.transfers[0]).toEqual({ from: "001", to: "004", amount: 50 });
    expect(netOf(plan.multilateral.transfers)).toEqual(plan.net_positions);
  });

  it("never moves more liquidity than the looser regimes", () => {
    const plan = computeNettingPlan([
      { from: "001", to: "002", amount: 100 },
      { from: "002", to: "003", amount: 80 },
      { from: "003", to: "001", amount: 40 },
      { from: "001", to: "003", amount: 25 },
    ]);
    expect(plan.multilateral.total_liquidity).toBeLessThanOrEqual(plan.bilateral.total_liquidity);
    expect(plan.bilateral.total_liquidity).toBeLessThanOrEqual(plan.gross.total_liquidity);
    expect(netOf(plan.multilateral.transfers)).toEqual(plan.net_positions);
    expect(plan.balanced).toBe(true);
  });

  it("handles the empty obligation set", () => {
    const plan = computeNettingPlan([]);
    expect(plan.participant_count).toBe(0);
    expect(plan.netting_efficiency).toBe(0);
    expect(plan.savings.liquidity_reduction_pct).toBe(0);
    expect(plan.balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB loader
// ---------------------------------------------------------------------------

describe("loadObligationsForDate", () => {
  let d1: MockD1Database;
  const DATE = "2025-06-01";

  function seedCycle(db: MockD1Database, cycleId: string, businessDate: string) {
    db.prepare(
      `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, created_at)
       VALUES (?, ?, 'KICKED', 'NORMAL', '2025-06-01T07:30:00Z')`
    )
      .bind(cycleId, businessDate)
      ._runSync();
  }

  function insertTx(
    db: MockD1Database,
    txid: string,
    payer: string,
    payee: string,
    amount: number,
    state: string,
    cycleId: string | null
  ) {
    db.prepare(
      `INSERT OR IGNORE INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, dns_cycle_id, created_at, updated_at, version)
       VALUES (?, 'STANDARD', ?, ?, 'JPY', ?, 'pa', ?, 'qa', ?, '1.0', ?, '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
    )
      .bind(txid, state, amount, payer, payee, `IK-${txid}`, cycleId)
      ._runSync();
  }

  beforeEach(() => {
    const { d1: db } = createTestDb();
    d1 = db;
    seedCycle(d1, `DNS-${DATE}`, DATE);
  });

  it("loads only settlement-eligible txs assigned to the date's cycle", async () => {
    insertTx(d1, "TX1", "001", "002", 100, "DECIDED_TO_SETTLE", `DNS-${DATE}`);
    insertTx(d1, "TX2", "002", "003", 40, "SETTLED", `DNS-${DATE}`);
    insertTx(d1, "TX3", "001", "003", 999, "RECEIVED", `DNS-${DATE}`); // wrong state
    insertTx(d1, "TX4", "001", "002", 888, "DECIDED_TO_SETTLE", null); // unassigned

    const obs = await loadObligationsForDate(DATE, d1 as any);
    expect(obs).toHaveLength(2);
    const total = obs.reduce((s, o) => s + o.amount, 0);
    expect(total).toBe(140);

    const plan = computeNettingPlan(obs);
    expect(plan.net_positions).toEqual({ "001": -100, "002": 60, "003": 40 });
  });

  it("returns an empty list for a date with no cycle", async () => {
    const obs = await loadObligationsForDate("2099-01-01", d1 as any);
    expect(obs).toEqual([]);
  });
});
