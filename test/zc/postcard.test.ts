/**
 * @file Tests for renderPostcard (postcard.ts).
 *
 * The renderer is a pure function over ExplainResult, so we feed it hand-built
 * snapshots rather than seeding the full DB. We assert structural properties:
 * vessel shape per lane, seam count == fracture-event count, seal status
 * depends on chain verification + terminal-ness, and palettes are deterministic
 * per txid.
 */
import { describe, it, expect } from "vitest";
import { renderPostcard } from "../../src/zc/postcard";
import type { ExplainResult, TimelineItem } from "../../src/zc/explain";

function tl(event: string, seq: number, state_to: string): TimelineItem {
  return {
    seq,
    at: `2025-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    event,
    state_from: null,
    state_to,
    reason: event,
    actors: ["ZC"],
    payload: null,
  };
}

function makeExp(opts: {
  txid?: string;
  lane?: string;
  state?: string;
  amount?: number;
  currency?: string;
  events?: TimelineItem[];
  verified?: boolean;
}): ExplainResult {
  const lane = opts.lane ?? "EXPRESS";
  const state = opts.state ?? "SETTLED";
  return {
    txid: opts.txid ?? "TX-POSTCARD-001",
    lane,
    current_state: state,
    summary: "テスト",
    reason_code: null,
    case_id: null,
    amount: { value: opts.amount ?? 50_000, currency: opts.currency ?? "JPY" },
    parties: { payer_bank_id: "001", payee_bank_id: "002" },
    timeline: opts.events ?? [tl("PaymentInitiated", 1, "RECEIVED"), tl("Settled", 2, "SETTLED")],
    integrity: {
      chain_verified: opts.verified ?? true,
      entries_checked: opts.events?.length ?? 2,
      break_at_seq: null,
      break_reason: null,
      algorithm: "sha256",
    },
    proofs: {
      decision_proof_ref: null,
      finality_log_ref: null,
      payer_bank_proof_ref: null,
      payee_bank_proof_ref: null,
    },
    timestamps: { created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:02Z" },
  };
}

describe("renderPostcard", () => {
  it("returns a non-empty SVG with the expected root element", () => {
    const card = renderPostcard(makeExp({}));
    expect(card.svg).toMatch(/^<\?xml/);
    expect(card.svg).toContain("<svg");
    expect(card.svg).toContain("</svg>");
    expect(card.svg).toContain("ZENITH KINTSUGI");
  });

  it("maps each lane to its vessel shape", () => {
    const cases: [string, string][] = [
      ["EXPRESS", "tumbler"],
      ["STANDARD", "teabowl"],
      ["HTLC", "jar"],
      ["HTLC_AUTH", "ringed_jar"],
      ["GTID", "twin_cups"],
      ["RTP", "cone"],
      ["HIGH_VALUE", "wide_jar"],
      ["BULK", "basin"],
    ];
    for (const [lane, shape] of cases) {
      const card = renderPostcard(makeExp({ lane, txid: `TX-${lane}` }));
      expect(card.motif.vessel_shape).toBe(shape);
    }
  });

  it("falls back to teabowl for unknown lanes", () => {
    const card = renderPostcard(makeExp({ lane: "UNKNOWN_LANE" }));
    expect(card.motif.vessel_shape).toBe("teabowl");
  });

  it("counts kintsugi seams from fracture events", () => {
    const events: TimelineItem[] = [
      tl("PaymentInitiated", 1, "RECEIVED"),
      tl("PreCheckFailed", 2, "FAILED"),
      tl("Suspended", 3, "SUSPENDED"),
      tl("HtlcCancelled", 4, "CANCELLED"),
    ];
    const card = renderPostcard(makeExp({ events, state: "CANCELLED", verified: true }));
    expect(card.motif.seams).toBe(3);
  });

  it("emits zero seams when nothing fractured", () => {
    const card = renderPostcard(makeExp({ state: "SETTLED" }));
    expect(card.motif.seams).toBe(0);
  });

  it("seal is VERIFIED on terminal+verified, PENDING in-flight, BROKEN on chain break", () => {
    const verifiedSettled = renderPostcard(makeExp({ state: "SETTLED", verified: true }));
    expect(verifiedSettled.motif.seal_status).toBe("VERIFIED");

    const inFlight = renderPostcard(makeExp({ state: "DECIDED_TO_SETTLE", verified: true }));
    expect(inFlight.motif.seal_status).toBe("PENDING");

    const broken = renderPostcard(makeExp({ state: "SETTLED", verified: false }));
    expect(broken.motif.seal_status).toBe("BROKEN");
  });

  it("renders the seal character matching status", () => {
    const verified = renderPostcard(makeExp({ state: "SETTLED", verified: true }));
    expect(verified.svg).toContain(">封<");

    const broken = renderPostcard(makeExp({ state: "SETTLED", verified: false }));
    expect(broken.svg).toContain(">破<");

    const pending = renderPostcard(makeExp({ state: "H_RESERVED" }));
    expect(pending.svg).toContain(">待<");
  });

  it("is deterministic per txid (same input → same SVG)", () => {
    const a = renderPostcard(makeExp({ txid: "TX-DETERMINISTIC-X" }));
    const b = renderPostcard(makeExp({ txid: "TX-DETERMINISTIC-X" }));
    expect(a.svg).toBe(b.svg);
    expect(a.poem).toEqual(b.poem);
    expect(a.motif).toEqual(b.motif);
  });

  it("different txids produce different palettes (with high probability)", () => {
    const a = renderPostcard(makeExp({ txid: "TX-ALPHA" }));
    const b = renderPostcard(makeExp({ txid: "TX-BETA-DIFFERENT" }));
    // Hues should usually differ. If they happen to collide, at least the
    // poems and seam layouts should diverge.
    expect(a.motif.hue_base === b.motif.hue_base && a.poem.join("") === b.poem.join("")).toBe(false);
  });

  it("always produces exactly three poem lines", () => {
    for (const state of ["SETTLED", "CANCELLED", "FAILED_EXECUTION", "SUSPENDED", "H_RESERVED"]) {
      const card = renderPostcard(makeExp({ state }));
      expect(card.poem).toHaveLength(3);
      for (const line of card.poem) expect(line.length).toBeGreaterThan(0);
    }
  });

  it("includes lane and state in the rendered caption", () => {
    const card = renderPostcard(makeExp({ lane: "HTLC", state: "SETTLED" }));
    expect(card.svg).toContain("HTLC");
    expect(card.svg).toContain("最終確定");
  });

  it("formats JPY amounts with ¥ prefix and thousands separator", () => {
    const card = renderPostcard(makeExp({ amount: 1_234_567 }));
    expect(card.caption.amount_label).toBe("¥1,234,567");
    expect(card.svg).toContain("¥1,234,567");
  });

  it("escapes XML-special characters in caption", () => {
    const card = renderPostcard(makeExp({ txid: 'TX-"<&>"-001' }));
    expect(card.svg).not.toMatch(/[^=]"<[^?!/]/); // no raw < following a non-attr context
    expect(card.svg).toContain("&amp;");
  });

  it("shortens long txids in the rendered caption", () => {
    const longId = `TX-${"A".repeat(50)}`;
    const card = renderPostcard(makeExp({ txid: longId }));
    expect(card.caption.txid_short.length).toBeLessThan(longId.length);
    expect(card.caption.txid_short).toContain("…");
  });
});
