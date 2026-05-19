/**
 * @file postcard.ts — Generative kintsugi-style SVG postcard for a transaction.
 *
 * The idea is metaphorical, not statistical: a payment's life is a piece of
 * pottery. A perfectly settled tx is a clean glaze; every Suspended /
 * FailedExecution / cancel-decision is a gold seam (kintsugi) where the
 * vessel was repaired. The lane chooses the silhouette, the txid hash chooses
 * the palette, the FinalityLog chooses the seams, and the chain-verification
 * status becomes the red seal in the corner.
 *
 * Pure function: takes an `ExplainResult` and returns an SVG string plus the
 * motif/poem it derived. No timing dependence, no I/O — deterministic per txid.
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
  | "basin"; // BULK — rectangular trough

export type SealStatus = "VERIFIED" | "BROKEN" | "PENDING";

export interface PostcardMotif {
  lane: string;
  state: string;
  vessel_shape: VesselShape;
  hue_base: number;
  hue_accent: number;
  seams: number;
  seal_status: SealStatus;
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
  EXPRESS: 210, // cool blue
  STANDARD: 195, // teal-blue
  HTLC: 270, // violet
  HTLC_AUTH: 285, // magenta-violet
  GTID: 140, // jade green
  RTP: 200, // sky
  HIGH_VALUE: 355, // crimson
  BULK: 220, // slate-blue
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

  const motif: PostcardMotif = {
    lane: exp.lane,
    state: exp.current_state,
    vessel_shape: shape,
    hue_base: hueBase,
    hue_accent: hueAccent,
    seams: seamCount,
    seal_status: sealStatus,
  };

  const poem = composePoem(exp, rng);
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
  const inkId = "ink";
  const clipId = "vesselClip";

  const vessel = vesselPath(motif.vessel_shape);
  const extras = vesselExtras(motif.vessel_shape);
  const seams = buildSeams(motif.vessel_shape, motif.seams, rng);

  // Glaze inner highlight slightly lighter than base
  const hue1 = motif.hue_base;
  const hue2 = motif.hue_accent;
  const glazeStops = `
    <stop offset="0%"  stop-color="hsl(${hue1} 55% 78%)" />
    <stop offset="55%" stop-color="hsl(${hue1} 52% 58%)" />
    <stop offset="100%" stop-color="hsl(${hue2} 60% 32%)" />
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
      (d) => `<path d="${d}" fill="none" stroke="#2a1d10" stroke-opacity="0.5" stroke-width="1" />`,
    )
    .join("");

  const seal = renderSeal(motif.seal_status);
  const poemMarkup = renderPoem(poem);
  const captionMarkup = renderCaption(caption);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif">
  <defs>
    <linearGradient id="${glazeId}" x1="0" y1="0" x2="0" y2="1">${glazeStops}</linearGradient>
    <linearGradient id="${goldId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"  stop-color="#f5d488" />
      <stop offset="50%" stop-color="#d4a056" />
      <stop offset="100%" stop-color="#a87434" />
    </linearGradient>
    <radialGradient id="${inkId}" cx="0.5" cy="0.5" r="0.6">
      <stop offset="0%"  stop-color="#f8f2e3" />
      <stop offset="70%" stop-color="#efe6cd" />
      <stop offset="100%" stop-color="#d9cda9" />
    </radialGradient>
    <filter id="paperNoise" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" />
      <feColorMatrix values="0 0 0 0 0.55  0 0 0 0 0.50  0 0 0 0 0.40  0 0 0 0.08 0" />
      <feComposite in2="SourceGraphic" operator="in" />
    </filter>
    <filter id="vesselShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6" />
    </filter>
    <clipPath id="${clipId}">
      <path d="${vessel}" />
    </clipPath>
  </defs>

  <!-- Paper background -->
  <rect width="${W}" height="${H}" fill="url(#${inkId})" />
  <rect width="${W}" height="${H}" fill="transparent" filter="url(#paperNoise)" />

  <!-- Inner frame -->
  <rect x="22" y="22" width="${W - 44}" height="${H - 44}" fill="none"
        stroke="#3a2a18" stroke-opacity="0.55" stroke-width="1" />
  <rect x="28" y="28" width="${W - 56}" height="${H - 56}" fill="none"
        stroke="#3a2a18" stroke-opacity="0.25" stroke-width="0.5" />

  <!-- Vessel shadow -->
  <ellipse cx="${W / 2}" cy="478" rx="115" ry="10"
           fill="rgba(50,30,12,0.28)" filter="url(#vesselShadow)" />

  <!-- Vessel body -->
  <g>
    <path d="${vessel}" fill="url(#${glazeId})" stroke="#2a1d10" stroke-opacity="0.7" stroke-width="1.2" stroke-linejoin="round" />
    <!-- Glaze highlight -->
    <path d="${vessel}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2" stroke-linejoin="round" />
    <!-- Kintsugi seams, clipped to the vessel silhouette so they read as cracks
         inside the pottery rather than free-floating lines. -->
    <g clip-path="url(#${clipId})">
      ${seamMarkup}
    </g>
    <!-- Decorative extras (e.g. ring bands), drawn on top of seams. -->
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
// ---------------------------------------------------------------------------

function vesselPath(shape: VesselShape): string {
  switch (shape) {
    case "tumbler":
      // Tall sleek cylinder with a slight bulge.
      return [
        "M198,168",
        "L282,168",
        "C286,168 288,172 288,176",
        "C292,260 292,360 288,440",
        "C288,452 282,460 270,460",
        "L210,460",
        "C198,460 192,452 192,440",
        "C188,360 188,260 192,176",
        "C192,172 194,168 198,168",
        "Z",
      ].join(" ");
    case "teabowl":
      // Wide rim, gently curving inward to a narrower base.
      return [
        "M170,180",
        "C200,176 280,176 310,180",
        "C322,260 312,400 280,448",
        "C260,460 220,460 200,448",
        "C168,400 158,260 170,180",
        "Z",
      ].join(" ");
    case "jar":
      // Narrow neck, broad shoulder, narrowing again toward base — HTLC sealed jar.
      return [
        "M215,168",
        "L265,168",
        "L268,200",
        "C300,212 312,260 312,320",
        "C312,400 290,448 265,456",
        "L215,456",
        "C190,448 168,400 168,320",
        "C168,260 180,212 212,200",
        "Z",
      ].join(" ");
    case "ringed_jar":
      // Identical silhouette to `jar`; the "hold ring" is drawn as a
      // decorative extra in vesselExtras() so it doesn't break clip-path use.
      return [
        "M215,168",
        "L265,168",
        "L268,200",
        "C300,212 312,260 312,320",
        "C312,400 290,448 265,456",
        "L215,456",
        "C190,448 168,400 168,320",
        "C168,260 180,212 212,200",
        "Z",
      ].join(" ");
    case "twin_cups":
      // Two small cups — multi-leg GTID metaphor.
      return [
        // Left cup
        "M150,180",
        "L222,180",
        "C226,200 224,420 218,452",
        "C200,460 172,460 154,452",
        "C148,420 146,200 150,180",
        "Z",
        // Right cup
        "M258,180",
        "L330,180",
        "C334,200 332,420 326,452",
        "C308,460 280,460 262,452",
        "C256,420 254,200 258,180",
        "Z",
      ].join(" ");
    case "cone":
      // Funnel / inverted cone — RTP pulls value down.
      return [
        "M168,172",
        "L312,172",
        "C310,200 270,420 252,452",
        "C246,460 234,460 228,452",
        "C210,420 170,200 168,172",
        "Z",
      ].join(" ");
    case "wide_jar":
      // Heavy, wide-bodied RTGS jar — broader than `jar`.
      return [
        "M195,168",
        "L285,168",
        "L290,210",
        "C328,228 332,400 298,448",
        "C268,464 212,464 182,448",
        "C148,400 152,228 190,210",
        "Z",
      ].join(" ");
    case "basin":
      // Square-ish basin — batch processing.
      return [
        "M168,184",
        "L312,184",
        "L308,440",
        "C306,454 298,460 286,460",
        "L194,460",
        "C182,460 174,454 172,440",
        "Z",
      ].join(" ");
  }
}

/**
 * Optional decorative strokes drawn on top of the vessel — e.g. the hold ring
 * of HTLC_AUTH. These are not part of the clip silhouette, so they can extend
 * slightly beyond the body if it reads better.
 */
function vesselExtras(shape: VesselShape): string[] {
  switch (shape) {
    case "ringed_jar":
      return [
        "M170,300 C200,308 280,308 310,300",
        "M170,332 C200,340 280,340 310,332",
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Seam generation — gold kintsugi cracks. One per fracture event.
// Seams start from a deterministic rim anchor and meander downward.
// ---------------------------------------------------------------------------

function buildSeams(shape: VesselShape, count: number, rng: () => number): string[] {
  if (count <= 0) return [];

  // Vessel rim and base bounds vary by shape but stay within a known box.
  const rimY = 174;
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

    // Two control points: introduce a kink.
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
// ---------------------------------------------------------------------------

function renderSeal(status: SealStatus): string {
  const char = status === "VERIFIED" ? "封" : status === "BROKEN" ? "破" : "待";
  const fill = status === "VERIFIED" ? "#b3322b" : status === "BROKEN" ? "#7a2a22" : "#947233";
  const x = W - 96;
  const y = H - 132;
  return `
  <g transform="translate(${x},${y}) rotate(-3)">
    <rect width="64" height="64" rx="3" ry="3" fill="${fill}" stroke="#3a0d09" stroke-width="1.2" />
    <rect x="3" y="3" width="58" height="58" fill="none" stroke="#fff6e8" stroke-opacity="0.55" stroke-width="0.8" />
    <text x="32" y="46" text-anchor="middle" font-size="38" fill="#fff6e8" font-family="'Noto Serif JP','Hiragino Mincho ProN',serif" font-weight="700">${char}</text>
  </g>`;
}

// ---------------------------------------------------------------------------
// Poem — three lines of Japanese, evocative but rule-based.
// ---------------------------------------------------------------------------

const OPENING_PHRASES = [
  "春霞の朝に",
  "夏の日盛りに",
  "秋風の立つ刻",
  "雪降る昼下がり",
  "月白き夜半に",
  "夕暮れ近き刻",
  "朝の市の中",
  "風のなき宵に",
  "雨上がりの庭で",
  "灯ともす頃に",
  "鶴鳴く朝に",
  "霧のうちより",
];

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

function composePoem(exp: ExplainResult, rng: () => number): string[] {
  const opening = OPENING_PHRASES[Math.floor(rng() * OPENING_PHRASES.length)] ?? "静かなる朝に";

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

  // Closing: terminal state -> definitive line; in-flight -> open-ended.
  const state = exp.current_state;
  let closing: string;
  if (state === "SETTLED") {
    closing = "春の海のごと 鎮まりぬ";
  } else if (state === "CANCELLED") {
    closing = "夢の如く 残らずに";
  } else if (state === "FAILED_EXECUTION" || state === "FAILED") {
    closing = "叶わぬまま 暮れにけり";
  } else if (state === "SUSPENDED") {
    closing = "問いのなか いまもなお";
  } else {
    closing = "ゆく末を 風に問う";
  }

  return [opening, middle, closing];
}

// ---------------------------------------------------------------------------
// Caption + poem layout
// ---------------------------------------------------------------------------

function renderCaption(c: PostcardResult["caption"]): string {
  return `
  <g font-family="'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif">
    <text x="${W / 2}" y="64" text-anchor="middle" font-size="13"
          letter-spacing="6" fill="#3a2a18" fill-opacity="0.85">ZENITH KINTSUGI</text>
    <text x="${W / 2}" y="92" text-anchor="middle" font-size="22" fill="#1a1208" font-weight="600">${escapeXml(c.lane)} ／ ${escapeXml(c.state_jp)}</text>
    <text x="${W / 2}" y="118" text-anchor="middle" font-size="14" fill="#3a2a18">${escapeXml(c.amount_label)}</text>
    <text x="${W / 2}" y="138" text-anchor="middle" font-size="10" fill="#3a2a18" fill-opacity="0.6" font-family="'SF Mono','Consolas',monospace" letter-spacing="2">${escapeXml(c.txid_short)}</text>
  </g>`;
}

function renderPoem(lines: string[]): string {
  const startY = 524;
  const lineGap = 30;
  const items = lines
    .map(
      (line, i) =>
        `<text x="${W / 2}" y="${startY + i * lineGap}" text-anchor="middle" font-size="18" fill="#1a1208" font-family="'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif" letter-spacing="2">${escapeXml(line)}</text>`,
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
