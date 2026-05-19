/**
 * @file postcard.ts — Generative kintsugi-style SVG postcard for a transaction.
 *
 * The idea is metaphorical, not statistical: a payment's life is a piece of
 * pottery rendered against Zenith's deep-indigo night. A perfectly settled tx
 * is a clean glaze; every Suspended / FailedExecution / cancel-decision is a
 * gold seam (kintsugi) where the vessel was repaired. The lane chooses the
 * silhouette, the txid hash chooses the palette, the FinalityLog chooses the
 * seams, and the chain-verification status becomes a hanko-style seal —
 * intentionally the dominant visual anchor, because in Zenith's design ethos
 * 証跡 (evidence) is the point, not decoration.
 *
 * Visual language is aligned with `/theater` and `/sky`:
 *   - Deep indigo background (Zenith ink #0a1730 → #050d22)
 *   - Cool desaturated glaze with one warm seam color (kintsugi gold)
 *   - Sans for captions (IBM Plex Sans family) so it sits next to `/sky`
 *   - Mincho only for the three-line poem — the one place where serif is
 *     intentional, because the poem IS literary.
 *
 * Pure function: takes an `ExplainResult` and returns an SVG string plus the
 * motif/poem it derived. Determinism is per-txid for palette/poem-choice and
 * per-(txid,month) for the seasonal opening — so the same transaction always
 * yields the same postcard, but season tracks the tx's actual created_at.
 *
 * Routes that consume this live in `src/index.ts`:
 *   GET /api/transactions/:txid/postcard.svg   → image/svg+xml
 *   GET /api/transactions/:txid/postcard       → JSON (svg + motif + poem)
 */
import type { ExplainResult, TimelineItem } from "./explain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VesselShape =
  | "tumbler" // EXPRESS — sleek, fast
  | "teabowl" // STANDARD — everyday bowl, wider at the rim
  | "jar" // HTLC — sealed neck, locked
  | "ringed_jar" // HTLC_AUTH — jar with a hold ring
  | "twin_cups" // GTID — paired, multi-leg
  | "cone" // RTP — funnel, pulled in
  | "wide_jar" // HIGH_VALUE — heavy, stable, RTGS
  | "basin"; // BULK — wide shallow trough

export type SealStatus = "VERIFIED" | "BROKEN" | "PENDING";

export type Season = "spring" | "summer" | "autumn" | "winter";

export interface PostcardMotif {
  lane: string;
  state: string;
  vessel_shape: VesselShape;
  hue_base: number;
  hue_accent: number;
  seams: number;
  seal_status: SealStatus;
  season: Season;
}

export interface PostcardResult {
  svg: string;
  motif: PostcardMotif;
  /** 3-line evocative poem (haiku-flavored, not strictly mora-counted). */
  poem: string[];
  caption: {
    txid_short: string;
    lane: string;
    amount_label: string;
    state_jp: string;
  };
}

// ---------------------------------------------------------------------------
// Lane → vessel + hue
// ---------------------------------------------------------------------------

const LANE_TO_SHAPE: Record<string, VesselShape> = {
  EXPRESS: "tumbler",
  STANDARD: "teabowl",
  HTLC: "jar",
  HTLC_AUTH: "ringed_jar",
  GTID: "twin_cups",
  RTP: "cone",
  HIGH_VALUE: "wide_jar",
  BULK: "basin",
};

const LANE_HUE_BASE: Record<string, number> = {
  EXPRESS: 200, // sky blue
  STANDARD: 215, // institutional blue
  HTLC: 260, // violet
  HTLC_AUTH: 280, // magenta-violet
  GTID: 165, // jade green
  RTP: 195, // cyan
  HIGH_VALUE: 5, // deep red
  BULK: 225, // slate blue
};

const STATE_JP: Record<string, string> = {
  RECEIVED: "受付",
  PRECHECKED: "事前検証済",
  PRECHECKED_SUSPENDED: "事前検証保留",
  H_RESERVED: "H 予約済",
  DECIDED_TO_SETTLE: "確定判断後",
  DECIDED_CANCEL: "中止判断後",
  PAYER_EXEC_CONFIRMED: "出金確認済",
  PAYEE_EXEC_CONFIRMED: "入金確認済",
  SETTLED: "最終確定",
  CANCELLED: "取消",
  SUSPENDED: "保留",
  FAILED_EXECUTION: "失敗",
  FAILED: "失敗",
  HTLC_LOCKED: "HTLC ロック",
  HTLC_FULFILL_REQUESTED: "HTLC 解錠要求",
};

/** Events that broke the smooth glaze and required a gold seam to mend. */
const FRACTURE_EVENTS = new Set([
  "Suspended",
  "FailedExecution",
  "PreCheckFailed",
  "FilterRejected",
  "ApprovalDenied",
  "HtlcCancelled",
  "DecidedCancel",
  "HtlcVoided",
  "HtlcAuthDeclined",
]);

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function renderPostcard(exp: ExplainResult): PostcardResult {
  const shape = LANE_TO_SHAPE[exp.lane] ?? "teabowl";
  const seed = hashString(exp.txid);
  const rng = mulberry32(seed);
  const hueShift = Math.floor(rng() * 30) - 15;
  const hueBase = ((LANE_HUE_BASE[exp.lane] ?? 210) + hueShift + 360) % 360;
  const hueAccent = (hueBase + 35) % 360;

  const seamCount = exp.timeline.filter((ev) => FRACTURE_EVENTS.has(ev.event)).length;
  const sealStatus: SealStatus = !exp.integrity.chain_verified
    ? "BROKEN"
    : isTerminal(exp.current_state)
      ? "VERIFIED"
      : "PENDING";

  // Season is taken from the tx's own created_at: a payment that happened in
  // November should not be poemed about cherry blossoms.
  const season = monthToSeason(parseMonth(exp.timestamps.created_at));

  const motif: PostcardMotif = {
    lane: exp.lane,
    state: exp.current_state,
    vessel_shape: shape,
    hue_base: hueBase,
    hue_accent: hueAccent,
    seams: seamCount,
    seal_status: sealStatus,
    season,
  };

  const poem = composePoem(exp, season, rng);
  const caption = {
    txid_short: shortenTxid(exp.txid),
    lane: exp.lane,
    amount_label: formatAmount(exp.amount.value, exp.amount.currency),
    state_jp: STATE_JP[exp.current_state] ?? exp.current_state,
  };

  const svg = renderSvg({ exp, motif, poem, caption, rng });
  return { svg, motif, poem, caption };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

interface RenderCtx {
  exp: ExplainResult;
  motif: PostcardMotif;
  poem: string[];
  caption: PostcardResult["caption"];
  rng: () => number;
}

const W = 480;
const H = 680;

function renderSvg(ctx: RenderCtx): string {
  const { motif, poem, caption, rng } = ctx;
  const glazeId = "glaze";
  const goldId = "gold";
  const skyId = "sky";
  const sealShadowId = "sealShadow";
  const clipId = "vesselClip";

  const vessel = vesselPath(motif.vessel_shape);
  const extras = vesselExtras(motif.vessel_shape);
  const seams = buildSeams(motif.vessel_shape, motif.seams, rng);

  // Glaze stops sit in the "ceramic in moonlight" register: midtone of the
  // lane hue, a cool highlight at the top, a deeper accent at the foot.
  const hue1 = motif.hue_base;
  const hue2 = motif.hue_accent;
  const glazeStops = `
    <stop offset="0%"  stop-color="hsl(${hue1} 38% 62%)" />
    <stop offset="55%" stop-color="hsl(${hue1} 32% 42%)" />
    <stop offset="100%" stop-color="hsl(${hue2} 28% 22%)" />
  `;

  const seamMarkup = seams
    .map(
      (d, i) =>
        `<path d="${d}" stroke="url(#${goldId})" stroke-width="${
          1.6 + (i % 3) * 0.4
        }" fill="none" stroke-linecap="round" />`,
    )
    .join("");

  const extrasMarkup = extras
    .map(
      ({ d, stroke, opacity, width }) =>
        `<path d="${d}" fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round" />`,
    )
    .join("");

  const seal = renderSeal(motif.seal_status);
  const poemMarkup = renderPoem(poem);
  const captionMarkup = renderCaption(caption);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'IBM Plex Sans','Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif">
  <defs>
    <linearGradient id="${glazeId}" x1="0" y1="0" x2="0" y2="1">${glazeStops}</linearGradient>
    <linearGradient id="${goldId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"  stop-color="#f5d488" />
      <stop offset="50%" stop-color="#d4a056" />
      <stop offset="100%" stop-color="#8a5e28" />
    </linearGradient>
    <radialGradient id="${skyId}" cx="0.5" cy="0.2" r="0.95">
      <stop offset="0%"  stop-color="#15264a" />
      <stop offset="55%" stop-color="#0a1730" />
      <stop offset="100%" stop-color="#03081a" />
    </radialGradient>
    <filter id="paperNoise" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" />
      <feColorMatrix values="0 0 0 0 0.78  0 0 0 0 0.82  0 0 0 0 0.95  0 0 0 0.04 0" />
      <feComposite in2="SourceGraphic" operator="in" />
    </filter>
    <filter id="vesselShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="7" />
    </filter>
    <filter id="${sealShadowId}" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.55" />
    </filter>
    <clipPath id="${clipId}">
      <path d="${vessel}" />
    </clipPath>
  </defs>

  <!-- Deep-indigo silk background -->
  <rect width="${W}" height="${H}" fill="url(#${skyId})" />
  <rect width="${W}" height="${H}" fill="transparent" filter="url(#paperNoise)" />

  <!-- Inner gold rule (subtle Zenith frame, not heavy) -->
  <rect x="22" y="22" width="${W - 44}" height="${H - 44}" fill="none"
        stroke="#d4a056" stroke-opacity="0.42" stroke-width="0.8" />
  <rect x="28" y="28" width="${W - 56}" height="${H - 56}" fill="none"
        stroke="#d4a056" stroke-opacity="0.18" stroke-width="0.5" />

  <!-- Vessel shadow on the silk -->
  <ellipse cx="${W / 2}" cy="478" rx="118" ry="9"
           fill="rgba(0,0,0,0.55)" filter="url(#vesselShadow)" />

  <!-- Vessel body -->
  <g>
    <path d="${vessel}" fill="url(#${glazeId})" stroke="#1a2440" stroke-opacity="0.85" stroke-width="1.2" stroke-linejoin="round" />
    <!-- Glaze highlight along the left side, faint -->
    <path d="${vessel}" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="2" stroke-linejoin="round" />
    <!-- Kintsugi seams, clipped to the vessel silhouette so they read as
         cracks inside the pottery rather than free-floating lines. -->
    <g clip-path="url(#${clipId})">
      ${seamMarkup}
    </g>
    <!-- Decorative extras (e.g. ring bands, twin coupler), drawn on top. -->
    ${extrasMarkup}
  </g>

  ${captionMarkup}

  ${poemMarkup}

  ${seal}
</svg>`;
}

// ---------------------------------------------------------------------------
// Vessel silhouettes — drawn around cx=240, rim≈170, base≈460.
// All path strings are hand-tuned for visual balance, not derived from data.
// Goal: each shape is at-a-glance distinct from the others.
// ---------------------------------------------------------------------------

function vesselPath(shape: VesselShape): string {
  switch (shape) {
    case "tumbler":
      // EXPRESS — narrow tall beaker, slight foot at the bottom for "speed".
      return [
        "M205,170",
        "L275,170",
        "C278,170 280,173 280,176",
        "C283,260 283,360 280,432",
        "C280,438 277,442 272,444",
        "L208,444",
        "C203,442 200,438 200,432",
        "C197,360 197,260 200,176",
        "C200,173 202,170 205,170",
        // Foot
        "M198,448 L282,448 L286,460 L194,460 Z",
      ].join(" ");
    case "teabowl":
      // STANDARD — humble chawan: rim flares outward, base small and stable.
      return [
        "M160,184",
        "C194,178 286,178 320,184",
        "C322,196 318,206 308,212",
        "C314,260 308,388 290,432",
        "C272,452 208,452 190,432",
        "C172,388 166,260 172,212",
        "C162,206 158,196 160,184",
        "Z",
      ].join(" ");
    case "jar":
      // HTLC — pronounced shoulder + narrow neck (sealed neck = hash-locked).
      return [
        "M218,168",
        "L262,168",
        "L266,196",
        "C300,206 314,256 314,318",
        "C314,398 292,448 264,456",
        "L216,456",
        "C188,448 166,398 166,318",
        "C166,256 180,206 214,196",
        "Z",
      ].join(" ");
    case "ringed_jar":
      // HTLC_AUTH — same silhouette as jar; the hold ring is drawn as a
      // separate gold band in vesselExtras() so it doesn't break clip-path.
      return [
        "M218,168",
        "L262,168",
        "L266,196",
        "C300,206 314,256 314,318",
        "C314,398 292,448 264,456",
        "L216,456",
        "C188,448 166,398 166,318",
        "C166,256 180,206 214,196",
        "Z",
      ].join(" ");
    case "twin_cups":
      // GTID — two cups; the coupler line in vesselExtras() makes them read
      // as a single coordinated transfer rather than two separate vessels.
      return [
        "M150,180",
        "L222,180",
        "C226,200 224,420 218,452",
        "C200,460 172,460 154,452",
        "C148,420 146,200 150,180",
        "Z",
        "M258,180",
        "L330,180",
        "C334,200 332,420 326,452",
        "C308,460 280,460 262,452",
        "C256,420 254,200 258,180",
        "Z",
      ].join(" ");
    case "cone":
      // RTP — funnel that *pulls* value in; flat narrow base, not a tip.
      return [
        "M168,172",
        "L312,172",
        "C310,200 268,420 252,450",
        "L228,450",
        "C212,420 170,200 168,172",
        "Z",
      ].join(" ");
    case "wide_jar":
      // HIGH_VALUE — heaviest, widest body, lowered center of gravity.
      return [
        "M192,168",
        "L288,168",
        "L294,212",
        "C334,232 334,402 296,448",
        "C268,464 212,464 184,448",
        "C146,402 146,232 186,212",
        "Z",
      ].join(" ");
    case "basin":
      // BULK — wide and shallow: rises only to mid-canvas, suggesting batch.
      return [
        "M150,300",
        "L330,300",
        "C336,302 340,308 340,316",
        "C340,360 332,420 320,442",
        "C306,456 174,456 160,442",
        "C148,420 140,360 140,316",
        "C140,308 144,302 150,300",
        "Z",
      ].join(" ");
  }
}

// ---------------------------------------------------------------------------
// Vessel extras — strokes drawn on top of the body (not part of the clip).
// ---------------------------------------------------------------------------

interface VesselExtra {
  d: string;
  stroke: string;
  opacity: number;
  width: number;
}

function vesselExtras(shape: VesselShape): VesselExtra[] {
  switch (shape) {
    case "ringed_jar":
      // HTLC_AUTH: two gold ring bands signalling the authorization hold.
      return [
        { d: "M170,304 C200,312 280,312 310,304", stroke: "#d4a056", opacity: 0.9, width: 1.6 },
        { d: "M170,336 C200,344 280,344 310,336", stroke: "#d4a056", opacity: 0.7, width: 1.2 },
      ];
    case "twin_cups":
      // GTID: a thin gold coupler line tying the two bases together —
      // the visual signature of "Decision一体性".
      return [
        { d: "M186,458 L294,458", stroke: "#d4a056", opacity: 0.85, width: 1.4 },
        { d: "M240,452 L240,462", stroke: "#d4a056", opacity: 0.85, width: 1.4 },
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Seam generation — gold kintsugi cracks. One per fracture event.
// Seams start from a deterministic rim anchor and meander downward.
// They are clipped to the vessel silhouette at render time, so coordinates
// can be approximate without breaking the visual.
// ---------------------------------------------------------------------------

function buildSeams(shape: VesselShape, count: number, rng: () => number): string[] {
  if (count <= 0) return [];

  // basin sits in the lower half — seams must originate there, not from y=170.
  const rimY = shape === "basin" ? 304 : 174;
  const baseY = 454;
  const cx = W / 2;
  const halfWidth = shape === "twin_cups" ? 90 : 70;

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1);
    const baseX = cx + (rng() - 0.5) * halfWidth * 2;
    const anchorX = cx + (t - 0.5) * halfWidth * 2 + (rng() - 0.5) * 18;
    const length = baseY - rimY - 20 - rng() * 80;
    const endY = rimY + 12 + length;

    // Two control points: introduce a kink so the seam reads as natural.
    const c1x = anchorX + (rng() - 0.5) * 60;
    const c1y = rimY + (endY - rimY) * 0.35;
    const c2x = baseX + (rng() - 0.5) * 30;
    const c2y = rimY + (endY - rimY) * 0.7;

    out.push(
      `M${fmt(anchorX)},${fmt(rimY + 4)} C${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(baseX)},${fmt(endY)}`,
    );

    // Occasional short branch off the main seam.
    if (rng() < 0.45) {
      const branchStart = rimY + (endY - rimY) * (0.3 + rng() * 0.4);
      const branchEndX = c2x + (rng() - 0.5) * 50;
      const branchEndY = branchStart + 30 + rng() * 40;
      const branchAnchorX = (c1x + c2x) / 2;
      out.push(
        `M${fmt(branchAnchorX)},${fmt(branchStart)} Q${fmt(branchAnchorX + (rng() - 0.5) * 20)},${fmt((branchStart + branchEndY) / 2)} ${fmt(branchEndX)},${fmt(branchEndY)}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seal stamp — hanko-style square in the lower-right corner.
// Larger and more prominent than the v1 (chain verification IS the point of
// the postcard, not a small decoration).
// ---------------------------------------------------------------------------

function renderSeal(status: SealStatus): string {
  const char = status === "VERIFIED" ? "封" : status === "BROKEN" ? "破" : "待";
  const fill = status === "VERIFIED" ? "#b3322b" : status === "BROKEN" ? "#5a201b" : "#a98038";
  const innerStroke =
    status === "VERIFIED" ? "#fff6e8" : status === "BROKEN" ? "#d9c8b8" : "#fff6e8";
  const size = 74;
  // Lower-right corner, clear of the poem block above (which ends ~y=570).
  const x = W - size - 32;
  const y = H - size - 28;
  return `
  <g transform="translate(${x},${y}) rotate(-2.5)" filter="url(#sealShadow)">
    <rect width="${size}" height="${size}" rx="4" ry="4" fill="${fill}" stroke="#2a0a07" stroke-width="1.4" />
    <rect x="4" y="4" width="${size - 8}" height="${size - 8}" fill="none" stroke="${innerStroke}" stroke-opacity="0.55" stroke-width="0.9" />
    <text x="${size / 2}" y="${size - 16}" text-anchor="middle" font-size="46" fill="${innerStroke}" font-family="'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif" font-weight="700">${char}</text>
  </g>`;
}

// ---------------------------------------------------------------------------
// Poem — three lines of Japanese, evocative but rule-based.
// Now seasonal-by-tx-time and varied across termination states.
// ---------------------------------------------------------------------------

const SEASON_OPENINGS: Record<Season, string[]> = {
  spring: [
    "春霞の朝に",
    "桜散る刻に",
    "朝霧の中より",
    "風薫る朝に",
    "若葉のひかり",
  ],
  summer: [
    "夏の日盛りに",
    "蝉時雨のなか",
    "夕涼みの刻",
    "青葉のかげに",
    "凪の海より",
  ],
  autumn: [
    "秋風の立つ刻",
    "月白き夜半に",
    "朝の市の中",
    "木の葉ひらりと",
    "灯ともす頃に",
  ],
  winter: [
    "雪降る昼下がり",
    "霜の朝に",
    "寒月の夜半に",
    "息白き朝に",
    "炉の傍らに",
  ],
};

const LANE_MIDDLE: Record<string, string> = {
  EXPRESS: "ひと息に駆け抜け",
  STANDARD: "律儀に手順を踏み",
  HTLC: "鍵と鍵とを合わせ",
  HTLC_AUTH: "仮の鍵を預けて",
  GTID: "三脚 互いに支え",
  RTP: "招かれて参じて",
  HIGH_VALUE: "重き荷を運びて",
  BULK: "群れなして渡り",
};

const CLOSINGS: Record<string, string[]> = {
  SETTLED: [
    "春の海のごと 鎮まりぬ",
    "灯の消ゆるごと 鎮まりぬ",
    "波の引くごと 鎮まりぬ",
    "風の凪ぐごと 鎮まりぬ",
  ],
  CANCELLED: [
    "夢の如く 残らずに",
    "霞の消ゆるごと",
    "煙の如く 流れぬ",
    "影残らず 消えにけり",
  ],
  FAILED_EXECUTION: [
    "叶わぬまま 暮れにけり",
    "風に砕かれ 消えにけり",
    "途半ばに 立ち止まる",
  ],
  FAILED: [
    "叶わぬまま 暮れにけり",
    "風に砕かれ 消えにけり",
  ],
  SUSPENDED: [
    "問いのなか いまもなお",
    "霞のなかに 隠れぬ",
    "宵の中 待たれおり",
  ],
};

const IN_FLIGHT_CLOSINGS = [
  "ゆく末を 風に問う",
  "明日を待つ 朝にあり",
  "次の刻を 望みつつ",
];

function composePoem(exp: ExplainResult, season: Season, rng: () => number): string[] {
  const openings = SEASON_OPENINGS[season];
  const opening = openings[Math.floor(rng() * openings.length)] ?? openings[0]!;

  // Middle: lane-flavored, decorated by fracture/retry patterns.
  const fractureCount = exp.timeline.filter((ev) => FRACTURE_EVENTS.has(ev.event)).length;
  const filterRejected = exp.timeline.some((ev) => ev.event === "FilterRejected");
  const suspended = exp.timeline.some((ev) => ev.event === "Suspended");

  const laneMiddle = LANE_MIDDLE[exp.lane] ?? "ゆるりと進みて";
  let middle: string;
  if (filterRejected) {
    middle = `${laneMiddle} 門前に拒まれ`;
  } else if (suspended) {
    middle = `${laneMiddle} 一度立ち止まり`;
  } else if (fractureCount >= 2) {
    middle = `${laneMiddle} 幾度かの躊躇`;
  } else {
    middle = `${laneMiddle} ${formatAmountPoetic(exp.amount.value, exp.amount.currency)}`;
  }

  // Closing: terminal state → varied definitive line; in-flight → open-ended.
  const closingPool = CLOSINGS[exp.current_state] ?? IN_FLIGHT_CLOSINGS;
  const closing = closingPool[Math.floor(rng() * closingPool.length)] ?? closingPool[0]!;

  return [opening, middle, closing];
}

// ---------------------------------------------------------------------------
// Caption + poem layout — Zenith palette: pale ivory text on indigo silk.
// ---------------------------------------------------------------------------

function renderCaption(c: PostcardResult["caption"]): string {
  return `
  <g>
    <text x="${W / 2}" y="62" text-anchor="middle" font-size="11"
          letter-spacing="8" fill="#d4a056" fill-opacity="0.85" font-weight="500">ZENITH · KINTSUGI</text>
    <line x1="180" y1="74" x2="300" y2="74" stroke="#d4a056" stroke-opacity="0.35" stroke-width="0.6" />
    <text x="${W / 2}" y="100" text-anchor="middle" font-size="22" fill="#f0e8d8" font-weight="600" letter-spacing="1">${escapeXml(c.lane)} ／ ${escapeXml(c.state_jp)}</text>
    <text x="${W / 2}" y="124" text-anchor="middle" font-size="14" fill="#c8d0e0" letter-spacing="0.5">${escapeXml(c.amount_label)}</text>
    <text x="${W / 2}" y="144" text-anchor="middle" font-size="10" fill="#8090b8" font-family="'IBM Plex Mono','SF Mono','Consolas',monospace" letter-spacing="2">${escapeXml(c.txid_short)}</text>
  </g>`;
}

function renderPoem(lines: string[]): string {
  // Sits between the vessel shadow (~y=485) and the seal (~y=578). Lines kept
  // tight enough that even the longest middle line stays clear of the seal.
  const startY = 510;
  const lineGap = 26;
  const items = lines
    .map(
      (line, i) =>
        `<text x="${W / 2}" y="${startY + i * lineGap}" text-anchor="middle" font-size="17" fill="#f0e8d8" font-family="'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif" letter-spacing="2">${escapeXml(line)}</text>`,
    )
    .join("");
  return `<g>${items}</g>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  // 32-bit FNV-1a — small, deterministic, good enough for seeding palettes.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isTerminal(state: string): boolean {
  return state === "SETTLED" || state === "CANCELLED" || state === "FAILED_EXECUTION";
}

function shortenTxid(txid: string): string {
  if (txid.length <= 18) return txid;
  return `${txid.slice(0, 10)}…${txid.slice(-6)}`;
}

function formatAmount(value: number, currency: string): string {
  if (currency === "JPY") return `¥${value.toLocaleString("ja-JP")}`;
  return `${value.toLocaleString("en-US")} ${currency}`;
}

/**
 * Poetic amount: rounded to the nearest 万 for JPY so the line reads naturally
 * inside a 5-7-5-ish phrase. For other currencies we fall back to compact form.
 */
function formatAmountPoetic(value: number, currency: string): string {
  if (currency !== "JPY") {
    if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}百万 渡し`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}千 渡し`;
    return `${value} 渡し`;
  }
  if (value >= 100_000_000) return `${Math.round(value / 100_000_000)}億の重み`;
  if (value >= 10_000_000) return `千万の重み`;
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}百万 渡し`;
  if (value >= 10_000) return `${Math.round(value / 10_000)}万を渡し`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}千を渡し`;
  return `小銭を渡し`;
}

/** ISO timestamp → month (1-12), with safe fallback. */
function parseMonth(iso: string): number {
  const m = /^\d{4}-(\d{2})-/.exec(iso);
  if (!m) return 1;
  const parsed = Number.parseInt(m[1]!, 10);
  return parsed >= 1 && parsed <= 12 ? parsed : 1;
}

/** Northern-hemisphere conventional bins; matches WMO meteorological seasons. */
function monthToSeason(month: number): Season {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Re-export type from explain for callers that want to type the input.
export type { ExplainResult, TimelineItem };
