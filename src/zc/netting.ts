/**
 * @file netting.ts — Multilateral netting optimizer (analysis-only).
 *
 * `settleDns()` already settles each participant on its *net* position, so the
 * money movement is correct. What it does NOT tell an operator is how much
 * liquidity and how many discrete payments that netting actually saved versus
 * naïvely settling every transaction one-by-one. This module answers that.
 *
 * It is deliberately non-destructive: it reads the obligation graph for a
 * business date and computes three settlement regimes side by side, but it
 * never writes journals, never advances a cycle, and never touches DnsCycles /
 * DnsNetPositions. The actual settlement path in `dns.ts` is untouched.
 *
 *   GROSS        — every transaction settled on its own (the baseline).
 *   BILATERAL    — each ordered bank pair collapsed to one net directional leg.
 *   MULTILATERAL — the minimal set of transfers that clears every participant's
 *                  net position, via a greedy max-debtor / max-creditor match.
 *
 * The multilateral pass is the interesting one: given net positions that sum to
 * zero, it produces at most (P-1) transfers — a deterministic two-pointer greedy
 * over sorted debtors and creditors. Globally minimizing the *number* of
 * transfers is NP-hard (it embeds subset-sum), but this greedy is the standard
 * cash-flow-minimization heuristic and is optimal in liquidity moved.
 *
 * Pure functions take obligations and return a plan; the DB loader at the bottom
 * is the only impure part and just gathers the obligation list for a date.
 *
 * Route that consumes this lives in `src/index.ts`:
 *   GET /api/dns/:business_date/netting-plan  → JSON NettingPlan
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single directional obligation: `from` owes `to` `amount` (JPY, integer). */
export interface Obligation {
  from: string;
  to: string;
  amount: number;
}

/** A directional settlement leg in a computed plan. */
export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

export type Regime = "GROSS" | "BILATERAL" | "MULTILATERAL";

export interface RegimeResult {
  regime: Regime;
  transfers: Transfer[];
  /** Number of discrete payments this regime requires. */
  payment_count: number;
  /** Sum of all transfer amounts — the liquidity that has to move. */
  total_liquidity: number;
}

export interface NettingPlan {
  participant_count: number;
  obligation_count: number;
  /** Net position per bank: positive = net receiver, negative = net payer. */
  net_positions: Record<string, number>;
  gross: RegimeResult;
  bilateral: RegimeResult;
  multilateral: RegimeResult;
  savings: {
    payments_saved: number;
    payment_reduction_pct: number;
    liquidity_saved: number;
    liquidity_reduction_pct: number;
  };
  /** Fraction of gross liquidity eliminated by multilateral netting (0..1). */
  netting_efficiency: number;
  /** True when net positions sum to zero (the zero-sum invariant holds). */
  balanced: boolean;
}

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

/** Sort by amount descending, then bank_id ascending — stable across runs. */
function byAmountThenId(a: { id: string; amt: number }, b: { id: string; amt: number }): number {
  if (b.amt !== a.amt) return b.amt - a.amt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sumLiquidity(transfers: Transfer[]): number {
  let s = 0;
  for (const t of transfers) s += t.amount;
  return s;
}

// ---------------------------------------------------------------------------
// Net positions
// ---------------------------------------------------------------------------

/**
 * Fold obligations into per-bank net positions.
 * positive = bank is a net receiver, negative = net payer.
 */
export function computeNetPositions(obligations: Obligation[]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const o of obligations) {
    if (o.amount <= 0 || o.from === o.to) continue;
    net[o.from] = (net[o.from] ?? 0) - o.amount;
    net[o.to] = (net[o.to] ?? 0) + o.amount;
  }
  // Banks that net to exactly zero need no settlement — drop them so the map
  // only carries participants that actually owe or are owed after netting.
  for (const id of Object.keys(net)) {
    if (net[id] === 0) delete net[id];
  }
  return net;
}

// ---------------------------------------------------------------------------
// Regimes
// ---------------------------------------------------------------------------

/** GROSS: settle every obligation independently. The baseline to beat. */
function grossRegime(obligations: Obligation[]): RegimeResult {
  const transfers = obligations
    .filter((o) => o.amount > 0 && o.from !== o.to)
    .map((o) => ({ from: o.from, to: o.to, amount: o.amount }));
  return {
    regime: "GROSS",
    transfers,
    payment_count: transfers.length,
    total_liquidity: sumLiquidity(transfers),
  };
}

/** BILATERAL: collapse each unordered bank pair into a single net leg. */
function bilateralRegime(obligations: Obligation[]): RegimeResult {
  // key "a|b" with a<b; value carries the pair and net flow in the a→b direction.
  const pairFlow = new Map<string, { a: string; b: string; flow: number }>();
  for (const o of obligations) {
    if (o.amount <= 0 || o.from === o.to) continue;
    const [a, b] = o.from < o.to ? [o.from, o.to] : [o.to, o.from];
    const key = `${a}|${b}`;
    const signed = o.from === a ? o.amount : -o.amount;
    const entry = pairFlow.get(key);
    if (entry) entry.flow += signed;
    else pairFlow.set(key, { a, b, flow: signed });
  }

  const transfers: Transfer[] = [];
  for (const key of [...pairFlow.keys()].sort()) {
    const { a, b, flow } = pairFlow.get(key)!;
    if (flow === 0) continue;
    transfers.push(flow > 0 ? { from: a, to: b, amount: flow } : { from: b, to: a, amount: -flow });
  }
  return {
    regime: "BILATERAL",
    transfers,
    payment_count: transfers.length,
    total_liquidity: sumLiquidity(transfers),
  };
}

/**
 * MULTILATERAL: minimal transfers that clear every net position.
 *
 * Greedy two-pointer over debtors and creditors sorted by magnitude: at each
 * step the largest remaining debtor pays the largest remaining creditor the
 * smaller of the two amounts, retiring at least one party. This yields at most
 * (debtors + creditors − 1) transfers and moves exactly the net liquidity, with
 * no leftover (net positions sum to zero, so both sides drain together).
 */
function multilateralRegime(netPositions: Record<string, number>): RegimeResult {
  const creditors = Object.entries(netPositions)
    .filter(([, v]) => v > 0)
    .map(([id, v]) => ({ id, amt: v }))
    .sort(byAmountThenId);
  const debtors = Object.entries(netPositions)
    .filter(([, v]) => v < 0)
    .map(([id, v]) => ({ id, amt: -v }))
    .sort(byAmountThenId);

  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!;
    const c = creditors[j]!;
    const x = Math.min(d.amt, c.amt);
    if (x > 0) transfers.push({ from: d.id, to: c.id, amount: x });
    d.amt -= x;
    c.amt -= x;
    if (d.amt === 0) i++;
    if (c.amt === 0) j++;
  }
  return {
    regime: "MULTILATERAL",
    transfers,
    payment_count: transfers.length,
    total_liquidity: sumLiquidity(transfers),
  };
}

// ---------------------------------------------------------------------------
// Plan assembly
// ---------------------------------------------------------------------------

function pct(saved: number, base: number): number {
  if (base <= 0) return 0;
  return Math.round((saved / base) * 1000) / 10; // one decimal place
}

/**
 * Compute the full three-regime netting plan for a set of obligations.
 * Pure — no I/O, deterministic given the same obligation list.
 */
export function computeNettingPlan(obligations: Obligation[]): NettingPlan {
  const netPositions = computeNetPositions(obligations);
  const gross = grossRegime(obligations);
  const bilateral = bilateralRegime(obligations);
  const multilateral = multilateralRegime(netPositions);

  const paymentsSaved = gross.payment_count - multilateral.payment_count;
  const liquiditySaved = gross.total_liquidity - multilateral.total_liquidity;

  let netSum = 0;
  for (const v of Object.values(netPositions)) netSum += v;

  return {
    participant_count: Object.keys(netPositions).length,
    obligation_count: gross.payment_count,
    net_positions: netPositions,
    gross,
    bilateral,
    multilateral,
    savings: {
      payments_saved: paymentsSaved,
      payment_reduction_pct: pct(paymentsSaved, gross.payment_count),
      liquidity_saved: liquiditySaved,
      liquidity_reduction_pct: pct(liquiditySaved, gross.total_liquidity),
    },
    netting_efficiency: gross.total_liquidity > 0 ? liquiditySaved / gross.total_liquidity : 0,
    balanced: netSum === 0,
  };
}

// ---------------------------------------------------------------------------
// DB loader (only impure part)
// ---------------------------------------------------------------------------

/**
 * Gather the raw per-transaction obligations assigned to a business date's DNS
 * cycle(s), in the same settlement-eligible states `settleDns` acts on. This
 * reflects what is actually in the cycle — it does not pull in unassigned txs.
 */
export async function loadObligationsForDate(
  businessDate: string,
  db: D1Database
): Promise<Obligation[]> {
  const rows = await db
    .prepare(
      `SELECT t.payer_bank_id AS from_bank, t.payee_bank_id AS to_bank, t.amount_value AS amount
       FROM Transactions t
       JOIN DnsCycles c ON c.cycle_id = t.dns_cycle_id
       WHERE c.business_date = ?
         AND t.state IN ('DECIDED_TO_SETTLE','PAYER_EXEC_CONFIRMED','PAYEE_EXEC_CONFIRMED','SETTLED')`
    )
    .bind(businessDate)
    .all<{ from_bank: string; to_bank: string; amount: number }>();

  return rows.results.map((r) => ({ from: r.from_bank, to: r.to_bank, amount: r.amount }));
}
