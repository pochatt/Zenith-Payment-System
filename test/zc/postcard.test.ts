/**
 * @file Tests for renderPostcard (postcard.ts).
 *
 * The renderer is a pure function over ExplainResult, so we feed it hand-built
 * snapshots rather than seeding the full DB. Tests cover:
 *   - structural / SVG well-formedness invariants
 *   - lane → vessel-shape mapping (incl. fallback)
 *   - fracture-event → seam count
 *   - chain verification + terminal-ness → seal status
 *   - palette / hue range bounds
 *   - season selection from created_at month
 *   - poem variation across states + txids
 *   - vessel-specific extras (HTLC_AUTH ring, GTID coupler)
 *   - basin seams stay in the lower half (regression for shallow shape)
 *   - non-JPY currency formatting
 *   - XML escaping for special caption characters
 *   - determinism per-txid
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

interface MakeOpts {
  txid?: string;
  lane?: string;
  state?: string;
  amount?: number;
  currency?: string;
  events?: TimelineItem[];
  verified?: boolean;
  createdAt?: string;
}

function makeExp(opts: MakeOpts = {}): ExplainResult {
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
    timestamps: {
      created_at: opts.createdAt ?? "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:02Z",
    },
  };
}

// ---------------------------------------------------------------------------
// Structure / well-formedness
// ---------------------------------------------------------------------------

describe("renderPostcard structure", () => {
  it("returns a non-empty SVG with the expected root element", () => {
    const card = renderPostcard(makeExp({}));
    expect(card.svg).toMatch(/^<\?xml/);
    expect(card.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(card.svg).toContain("</svg>");
    expect(card.svg).toContain("ZENITH");
    expect(card.svg).toContain("KINTSUGI");
  });

  it("declares the kintsugi gold gradient and the indigo sky background", () => {
    const card = renderPostcard(makeExp({}));
    expect(card.svg).toContain('<linearGradient id="gold"');
    expect(card.svg).toContain('<radialGradient id="sky"');
    expect(card.svg).toContain('fill="url(#sky)"');
  });

  it("includes a clipPath bound to the vessel silhouette", () => {
    const card = renderPostcard(makeExp({}));
    expect(card.svg).toContain('<clipPath id="vesselClip">');
    expect(card.svg).toContain('clip-path="url(#vesselClip)"');
  });

  it("balances open/close tags for <svg> and <g> at the top level", () => {
    const card = renderPostcard(makeExp({}));
    const opensSvg = (card.svg.match(/<svg\b/g) ?? []).length;
    const closesSvg = (card.svg.match(/<\/svg>/g) ?? []).length;
    expect(opensSvg).toBe(1);
    expect(closesSvg).toBe(1);
    // Count <g> (excluding self-closing, which we don't emit) vs </g>.
    const opensG = (card.svg.match(/<g[\s>]/g) ?? []).length;
    const closesG = (card.svg.match(/<\/g>/g) ?? []).length;
    expect(opensG).toBe(closesG);
  });

  it("renders text content for every line of the poem", () => {
    const card = renderPostcard(makeExp({}));
    for (const line of card.poem) {
      // The line should appear as the text content of a <text> element.
      expect(card.svg).toContain(`>${line}<`);
    }
  });
});

// ---------------------------------------------------------------------------
// Lane → shape mapping
// ---------------------------------------------------------------------------

describe("renderPostcard lane mapping", () => {
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
});

// ---------------------------------------------------------------------------
// Seams (fracture events)
// ---------------------------------------------------------------------------

describe("renderPostcard seams", () => {
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

  it("handles an empty timeline without crashing", () => {
    const card = renderPostcard(makeExp({ events: [] }));
    expect(card.motif.seams).toBe(0);
    expect(card.svg).toContain("</svg>");
  });

  it("handles many fracture events (10+) without producing malformed SVG", () => {
    const events: TimelineItem[] = [];
    for (let i = 1; i <= 12; i++) events.push(tl("Suspended", i, "SUSPENDED"));
    const card = renderPostcard(makeExp({ events, state: "SUSPENDED" }));
    expect(card.motif.seams).toBe(12);
    // SVG should still be balanced and contain at least 12 path commands for seams.
    expect((card.svg.match(/stroke="url\(#gold\)"/g) ?? []).length).toBeGreaterThanOrEqual(12);
    expect(card.svg).toContain("</svg>");
  });

  it("counts every fracture event type listed in the spec", () => {
    const fractureEvents = [
      "Suspended",
      "FailedExecution",
      "PreCheckFailed",
      "FilterRejected",
      "ApprovalDenied",
      "HtlcCancelled",
      "DecidedCancel",
      "HtlcVoided",
      "HtlcAuthDeclined",
    ];
    const events: TimelineItem[] = fractureEvents.map((e, i) => tl(e, i + 1, "X"));
    const card = renderPostcard(makeExp({ events }));
    expect(card.motif.seams).toBe(fractureEvents.length);
  });

  it("does not count routine events as seams", () => {
    const events: TimelineItem[] = [
      tl("PaymentInitiated", 1, "RECEIVED"),
      tl("PreCheckPassed", 2, "PRECHECKED"),
      tl("HReserved", 3, "H_RESERVED"),
      tl("DecidedToSettle", 4, "DECIDED_TO_SETTLE"),
      tl("PayerExecConfirmed", 5, "PAYER_EXEC_CONFIRMED"),
      tl("PayeeExecConfirmed", 6, "PAYEE_EXEC_CONFIRMED"),
      tl("Settled", 7, "SETTLED"),
    ];
    const card = renderPostcard(makeExp({ events, state: "SETTLED" }));
    expect(card.motif.seams).toBe(0);
  });

  it("places basin seams in the lower half of the canvas (regression)", () => {
    const events: TimelineItem[] = [
      tl("Suspended", 1, "SUSPENDED"),
      tl("FailedExecution", 2, "FAILED"),
    ];
    const card = renderPostcard(makeExp({ lane: "BULK", events, state: "SUSPENDED" }));
    // Extract every M command's Y from the seam path strings inside the
    // clip-path group, and assert they all start at or below y=300 (basin rim).
    const clipGroup = /<g clip-path="url\(#vesselClip\)">([\s\S]*?)<\/g>/.exec(card.svg);
    expect(clipGroup).not.toBeNull();
    const moveYs = Array.from(clipGroup![1]!.matchAll(/M[\d.]+,([\d.]+)/g)).map((m) =>
      Number.parseFloat(m[1]!),
    );
    expect(moveYs.length).toBeGreaterThan(0);
    for (const y of moveYs) expect(y).toBeGreaterThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// Seal status
// ---------------------------------------------------------------------------

describe("renderPostcard seal", () => {
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

  it("seal is a sizable focal element (≥70px), not a small decoration", () => {
    const card = renderPostcard(makeExp({ state: "SETTLED" }));
    const rectMatch = /<rect width="(\d+)" height="(\d+)" rx="4"/.exec(card.svg);
    expect(rectMatch).not.toBeNull();
    expect(Number.parseInt(rectMatch![1]!, 10)).toBeGreaterThanOrEqual(70);
  });

  it("seal is positioned in the lower-right and slightly rotated for stamped feel", () => {
    const card = renderPostcard(makeExp({ state: "SETTLED" }));
    expect(card.svg).toMatch(/<g transform="translate\(\d+,\d+\) rotate\(-[12]/);
  });

  it("seal does not overlap the poem (regression for v1 layout bug)", () => {
    // Pull the seal's top-left translate coords and rect size.
    const card = renderPostcard(makeExp({ state: "SETTLED" }));
    const sealTransform = /<g transform="translate\((\d+),(\d+)\) rotate/.exec(card.svg);
    expect(sealTransform).not.toBeNull();
    const sealTop = Number.parseInt(sealTransform![2]!, 10);
    const sealSizeMatch = /<rect width="(\d+)" height="(\d+)" rx="4"/.exec(card.svg);
    const sealSize = Number.parseInt(sealSizeMatch![1]!, 10);

    // Pull every poem <text> y attribute. The poem is the last <g> with three
    // sibling <text> elements before the seal. Easier: collect every <text>
    // with the mincho font (poem-only), and take their y attributes.
    const poemYs = Array.from(
      card.svg.matchAll(/<text x="240" y="(\d+)"[^>]*font-family="'Noto Serif JP/g),
    ).map((m) => Number.parseInt(m[1]!, 10));
    // Filter out the seal character (which also uses mincho but is centered on
    // a translated <g>, so its y attribute is small — under 100).
    const poemLineYs = poemYs.filter((y) => y > 200);
    expect(poemLineYs.length).toBeGreaterThanOrEqual(3);

    // Approximate text-bottom = y baseline + 5 (font-size 17, descender slack).
    const poemBottom = Math.max(...poemLineYs) + 5;
    expect(sealTop).toBeGreaterThan(poemBottom);
    // And the seal should fit inside the canvas (H=680).
    expect(sealTop + sealSize).toBeLessThan(680);
  });
});

// ---------------------------------------------------------------------------
// Palette / hues
// ---------------------------------------------------------------------------

describe("renderPostcard palette", () => {
  it("hue values stay within the valid 0–359 range for every lane", () => {
    for (const lane of [
      "EXPRESS",
      "STANDARD",
      "HTLC",
      "HTLC_AUTH",
      "GTID",
      "RTP",
      "HIGH_VALUE",
      "BULK",
    ]) {
      for (const txid of ["TX-A", "TX-B", "TX-C-different-seed", "TX-Δ"]) {
        const card = renderPostcard(makeExp({ lane, txid }));
        expect(card.motif.hue_base).toBeGreaterThanOrEqual(0);
        expect(card.motif.hue_base).toBeLessThan(360);
        expect(card.motif.hue_accent).toBeGreaterThanOrEqual(0);
        expect(card.motif.hue_accent).toBeLessThan(360);
      }
    }
  });

  it("two lanes with the same txid still get different base hues (most of the time)", () => {
    // Lane base hues are fixed in the source table; for the same txid the
    // jitter is identical. So differences come from LANE_HUE_BASE entries.
    const e = renderPostcard(makeExp({ lane: "EXPRESS", txid: "TX-SAME" }));
    const h = renderPostcard(makeExp({ lane: "HTLC", txid: "TX-SAME" }));
    expect(e.motif.hue_base).not.toBe(h.motif.hue_base);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("renderPostcard determinism", () => {
  it("is deterministic per txid (same input → same SVG)", () => {
    const a = renderPostcard(makeExp({ txid: "TX-DETERMINISTIC-X" }));
    const b = renderPostcard(makeExp({ txid: "TX-DETERMINISTIC-X" }));
    expect(a.svg).toBe(b.svg);
    expect(a.poem).toEqual(b.poem);
    expect(a.motif).toEqual(b.motif);
  });

  it("different txids produce divergent palettes or poems (with high probability)", () => {
    const a = renderPostcard(makeExp({ txid: "TX-ALPHA" }));
    const b = renderPostcard(makeExp({ txid: "TX-BETA-DIFFERENT-SEED" }));
    const same =
      a.motif.hue_base === b.motif.hue_base &&
      a.motif.hue_accent === b.motif.hue_accent &&
      a.poem.join("") === b.poem.join("");
    expect(same).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Season (created_at → poem opening)
// ---------------------------------------------------------------------------

describe("renderPostcard season", () => {
  it("maps every month to its meteorological season", () => {
    const monthToExpected: Record<string, string> = {
      "01": "winter",
      "02": "winter",
      "03": "spring",
      "04": "spring",
      "05": "spring",
      "06": "summer",
      "07": "summer",
      "08": "summer",
      "09": "autumn",
      "10": "autumn",
      "11": "autumn",
      "12": "winter",
    };
    for (const [mm, expected] of Object.entries(monthToExpected)) {
      const card = renderPostcard(makeExp({ createdAt: `2025-${mm}-15T12:00:00Z` }));
      expect(card.motif.season).toBe(expected);
    }
  });

  it("falls back to winter for malformed created_at", () => {
    const card = renderPostcard(makeExp({ createdAt: "not-a-date" }));
    expect(card.motif.season).toBe("winter");
  });

  it("poem opening reflects the season, not the txid alone", () => {
    // Same txid, two different seasons. The opening line should differ.
    const summer = renderPostcard(
      makeExp({ txid: "TX-SAME-SEED", createdAt: "2025-07-01T00:00:00Z" }),
    );
    const winter = renderPostcard(
      makeExp({ txid: "TX-SAME-SEED", createdAt: "2025-01-01T00:00:00Z" }),
    );
    expect(summer.motif.season).toBe("summer");
    expect(winter.motif.season).toBe("winter");
    expect(summer.poem[0]).not.toBe(winter.poem[0]);
  });

  it("summer openings sound summer, winter openings sound winter", () => {
    // Sweep across many txids: every summer opening should appear in the
    // summer pool and every winter opening in the winter pool — i.e. the
    // pools never leak across seasons.
    const summerPool = ["夏の日盛りに", "蝉時雨のなか", "夕涼みの刻", "青葉のかげに", "凪の海より"];
    const winterPool = ["雪降る昼下がり", "霜の朝に", "寒月の夜半に", "息白き朝に", "炉の傍らに"];

    for (let i = 0; i < 25; i++) {
      const summer = renderPostcard(
        makeExp({ txid: `TX-SEASON-${i}`, createdAt: "2025-07-15T00:00:00Z" }),
      );
      const winter = renderPostcard(
        makeExp({ txid: `TX-SEASON-${i}`, createdAt: "2025-12-15T00:00:00Z" }),
      );
      expect(summerPool).toContain(summer.poem[0]);
      expect(winterPool).toContain(winter.poem[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// Poem variation
// ---------------------------------------------------------------------------

describe("renderPostcard poem", () => {
  it("always produces exactly three non-empty lines", () => {
    for (const state of ["SETTLED", "CANCELLED", "FAILED_EXECUTION", "SUSPENDED", "H_RESERVED"]) {
      const card = renderPostcard(makeExp({ state }));
      expect(card.poem).toHaveLength(3);
      for (const line of card.poem) expect(line.length).toBeGreaterThan(0);
    }
  });

  it("closing differs by terminal state", () => {
    const settled = renderPostcard(makeExp({ state: "SETTLED" }));
    const cancelled = renderPostcard(makeExp({ state: "CANCELLED" }));
    const failed = renderPostcard(makeExp({ state: "FAILED_EXECUTION" }));
    expect(settled.poem[2]).not.toBe(cancelled.poem[2]);
    expect(settled.poem[2]).not.toBe(failed.poem[2]);
    expect(cancelled.poem[2]).not.toBe(failed.poem[2]);
  });

  it("SETTLED closings vary across txids (not always the same line)", () => {
    const closings = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const card = renderPostcard(makeExp({ txid: `TX-VARIETY-${i}`, state: "SETTLED" }));
      closings.add(card.poem[2]!);
    }
    // With 4 SETTLED-closing options and 30 txids, we should hit ≥2 variants.
    expect(closings.size).toBeGreaterThanOrEqual(2);
  });

  it("filter rejection produces a 門前に拒まれ middle line", () => {
    const card = renderPostcard(
      makeExp({
        events: [tl("FilterRejected", 1, "SUSPENDED")],
        state: "SUSPENDED",
      }),
    );
    expect(card.poem[1]).toContain("門前に拒まれ");
  });

  it("a clean single-step transaction includes the amount in the middle line", () => {
    const card = renderPostcard(makeExp({ amount: 30_000 }));
    expect(card.poem[1]).toMatch(/万を渡し|千を渡し|百万 渡し/);
  });
});

// ---------------------------------------------------------------------------
// Vessel extras
// ---------------------------------------------------------------------------

describe("renderPostcard vessel extras", () => {
  it("HTLC_AUTH (ringed_jar) draws gold hold-ring bands", () => {
    const card = renderPostcard(makeExp({ lane: "HTLC_AUTH" }));
    // The two gold ring bands are drawn as <path> elements with the kintsugi
    // gold stroke. Other gold strokes in the SVG (frame rectangles) are
    // <rect>s and don't count.
    const goldPaths = (card.svg.match(/<path[^>]*stroke="#d4a056"/g) ?? []).length;
    expect(goldPaths).toBeGreaterThanOrEqual(2);
  });

  it("GTID (twin_cups) draws a coupler tying the two bases", () => {
    const card = renderPostcard(makeExp({ lane: "GTID" }));
    expect(card.svg).toContain("M186,458 L294,458");
    const goldPaths = (card.svg.match(/<path[^>]*stroke="#d4a056"/g) ?? []).length;
    expect(goldPaths).toBeGreaterThanOrEqual(2);
  });

  it("a plain lane like STANDARD draws no vessel extras", () => {
    const card = renderPostcard(makeExp({ lane: "STANDARD" }));
    // STANDARD has no extras: zero <path> elements with the gold stroke.
    // The gold frame rectangles around the canvas are <rect>s, not <path>s.
    const goldPaths = (card.svg.match(/<path[^>]*stroke="#d4a056"/g) ?? []).length;
    expect(goldPaths).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Caption formatting
// ---------------------------------------------------------------------------

describe("renderPostcard caption", () => {
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

  it("formats non-JPY amounts with currency suffix", () => {
    const card = renderPostcard(makeExp({ amount: 1_500, currency: "USD" }));
    expect(card.caption.amount_label).toBe("1,500 USD");
    expect(card.svg).toContain("1,500 USD");
  });

  it("escapes all five XML-special characters in caption", () => {
    const card = renderPostcard(makeExp({ txid: `TX-<&>"'-001` }));
    expect(card.svg).toContain("&amp;");
    expect(card.svg).toContain("&lt;");
    expect(card.svg).toContain("&gt;");
    expect(card.svg).toContain("&quot;");
    expect(card.svg).toContain("&apos;");
    // Verify the raw, unescaped sequence does not appear in the SVG body.
    expect(card.svg).not.toContain(`TX-<&>"'`);
  });

  it("shortens long txids in the rendered caption", () => {
    const longId = `TX-${"A".repeat(50)}`;
    const card = renderPostcard(makeExp({ txid: longId }));
    expect(card.caption.txid_short.length).toBeLessThan(longId.length);
    expect(card.caption.txid_short).toContain("…");
  });

  it("preserves short txids as-is", () => {
    const card = renderPostcard(makeExp({ txid: "TX-SHORT-1" }));
    expect(card.caption.txid_short).toBe("TX-SHORT-1");
  });
});
