/**
 * @file lane_invariants.test.ts — static-analysis guard for the "新規 lane
 *       追加時のチェックリスト" in specs/architecture.md.
 *
 * These tests do not exercise runtime behaviour. They read source files at
 * test time and assert structural invariants that the helpers in
 * `src/zc/lanes/_helpers.ts` exist to enforce. When a new lane is added,
 * these failures point straight at the missing step instead of letting a
 * subtle audit-gap regression slip past the runtime suites.
 *
 * Invariants checked:
 *
 *   1. No hand-rolled `UPDATE Transactions SET state = ...` outside
 *      `_helpers.ts` — bypasses `ALLOWED_TRANSITIONS` and writes no FinalityLog.
 *   2. No hand-rolled `INSERT [OR IGNORE] INTO Transactions` outside
 *      `_helpers.ts` — bypasses `ALLOWED_ENTRY_STATES` and the paired
 *      FinalityLog INSERT, opening an "audit gap" window.
 *   3. Every top-level lane file imports at least one helper, so we know it
 *      is participating in the canonical machinery rather than rolling its own.
 *   4. Every lane name written into Transactions.lane has a corresponding
 *      test file under `test/zc/` (catches "lane added but no unit test").
 *   5. Every active lane appears in `test/integration/balance_invariants.test.ts`
 *      so the customer-facing balance promise is covered end-to-end.
 *   6. Every `eventType:` literal passed to the helpers is declared in
 *      `FinalityEventType` (in `src/types/api.ts`), so audit consumers can
 *      rely on the union as the SoT for event names.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..", "..");
const LANES_DIR = join(REPO_ROOT, "src", "zc", "lanes");
const HELPERS_FILE = join(LANES_DIR, "_helpers.ts");
const TYPES_API = join(REPO_ROOT, "src", "types", "api.ts");
const BALANCE_INVARIANTS = join(REPO_ROOT, "test", "integration", "balance_invariants.test.ts");
const LANE_TEST_DIR = join(REPO_ROOT, "test", "zc");

/** All .ts source files under src/zc/lanes/ (recursive), with repo-relative paths. */
function walkLaneSources(): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      if (statSync(full).isDirectory()) visit(full);
      else if (ent.endsWith(".ts")) out.push(full);
    }
  };
  visit(LANES_DIR);
  return out;
}

/** Top-level lane files (e.g. express.ts), excluding `_helpers.ts` and sub-dir files. */
function topLevelLaneFiles(): string[] {
  return readdirSync(LANES_DIR)
    .filter((name) => name.endsWith(".ts") && name !== "_helpers.ts")
    .map((name) => join(LANES_DIR, name));
}

/** Strip line and block comments so regex-banned patterns inside docs don't trip the test. */
function stripComments(src: string): string {
  // Block comments first (greedy single-line; multi-line via [\s\S])
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then line comments
  s = s.replace(/^\s*\/\/.*$/gm, "");
  return s;
}

// ---------------------------------------------------------------------------
// Invariant 1: no raw UPDATE Transactions SET state in lane code
// ---------------------------------------------------------------------------

describe("lane invariants — banned SQL patterns", () => {
  it("no lane file hand-rolls `UPDATE Transactions SET state` (use transitionWithLog/cancelInFlightTx)", () => {
    const offenders: string[] = [];
    const RE = /UPDATE\s+Transactions\s+SET\s+state\b/i;
    for (const file of walkLaneSources()) {
      if (file === HELPERS_FILE) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (RE.test(src)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(
      offenders,
      `These files bypass the state-machine + FinalityLog helpers:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("no lane file hand-rolls `INSERT INTO Transactions` (use insertTxWithLog)", () => {
    const offenders: string[] = [];
    // Match both `INSERT INTO` and `INSERT OR IGNORE INTO`.
    const RE = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+Transactions\b/i;
    for (const file of walkLaneSources()) {
      if (file === HELPERS_FILE) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      if (RE.test(src)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(
      offenders,
      `These files bypass the atomic INSERT + FinalityLog helper:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2: lane files consume the canonical helpers
// ---------------------------------------------------------------------------

describe("lane invariants — helper consumption", () => {
  it("every top-level lane file imports at least one helper from `./_helpers`", () => {
    // Lane "entrypoint" files (express.ts, htlc.ts, ...). Each must either
    // import a helper directly or be a thin barrel that re-exports something
    // that does. In practice every lane today imports at least one.
    const offenders: string[] = [];
    const RE = /from\s+['"]\.\/_helpers['"]/;
    for (const file of topLevelLaneFiles()) {
      const src = readFileSync(file, "utf8");
      if (!RE.test(src)) {
        // Allow lanes that only delegate to sub-modules to opt out if their
        // sub-modules import the helper. Check the sub-module folder by
        // matching the lane stem (e.g. htlc_auth.ts → htlc_auth/).
        const stem = file.replace(/\.ts$/, "");
        let subDirHasHelperImport = false;
        try {
          for (const ent of readdirSync(stem)) {
            const subSrc = readFileSync(join(stem, ent), "utf8");
            if (/from\s+['"]\.\.\/_helpers['"]/.test(subSrc)) {
              subDirHasHelperImport = true;
              break;
            }
          }
        } catch {
          /* no sub-dir: fall through and report */
        }
        if (!subDirHasHelperImport) offenders.push(relative(REPO_ROOT, file));
      }
    }
    expect(
      offenders,
      `These lane entrypoints never consume _helpers (probably hand-rolling state):\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3: every lane file has a test file + balance-invariant coverage
// ---------------------------------------------------------------------------

/**
 * Canonical mapping: lane source file (basename) → the logical lane label
 * used in test names and the `Transactions.lane` column value used in seeded
 * data. Some files map to the same column value (htlc_auth is a sub-flow of
 * the HTLC lane), so the test asserts on the *file* set, not the column set.
 *
 * Keep this list in sync with the table in CLAUDE.md § Payment Lanes.
 */
const LANE_FILES: Record<string, { logicalName: string; columnValue?: string }> = {
  "express.ts": { logicalName: "EXPRESS" },
  "standard.ts": { logicalName: "STANDARD" },
  "highvalue.ts": { logicalName: "HIGH_VALUE" },
  "bulk.ts": { logicalName: "BULK" },
  "htlc.ts": { logicalName: "HTLC" },
  "htlc_auth.ts": { logicalName: "HTLC_AUTH", columnValue: "HTLC" },
  "rtp.ts": { logicalName: "RTP" },
  // GTID legs are stored with lane='DEFERRED'; the GT row itself lives in
  // GtidTransactions. The describe block in balance_invariants is 'GTID'.
  "gtid.ts": { logicalName: "GTID", columnValue: "DEFERRED" },
};

describe("lane invariants — test-file and balance-invariant coverage", () => {
  it("LANE_FILES matches the set of top-level lane files on disk (drift guard)", () => {
    const onDisk = readdirSync(LANES_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "_helpers.ts")
      .sort();
    const declared = Object.keys(LANE_FILES).sort();
    expect(onDisk).toEqual(declared);
  });

  it("every lane file has a unit-test file under test/zc/", () => {
    const testFiles = readdirSync(LANE_TEST_DIR).filter((f) => f.endsWith(".test.ts"));
    const offenders: string[] = [];
    for (const [file] of Object.entries(LANE_FILES)) {
      const stem = file.replace(/\.ts$/, "");
      // Match any test file whose name starts with the lane stem — covers
      // 'htlc_auth_canonical.test.ts', 'htlc_auth_regression.test.ts', etc.
      if (!testFiles.some((f) => f.startsWith(stem))) offenders.push(file);
    }
    expect(
      offenders,
      `These lanes have no test/zc/<stem>*.test.ts:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("every lane appears in test/integration/balance_invariants.test.ts", () => {
    const src = readFileSync(BALANCE_INVARIANTS, "utf8");
    // Balance-invariants currently does not cover RTP (RTP-accepted responses
    // create a STANDARD row downstream, which IS covered). If you add an
    // RTP-specific balance test, remove it from this allowlist.
    const KNOWN_GAPS = new Set(["rtp.ts"]);
    const offenders: string[] = [];
    for (const [file, { logicalName, columnValue }] of Object.entries(LANE_FILES)) {
      if (KNOWN_GAPS.has(file)) continue;
      // A lane is considered covered if its describe block name OR its lane
      // column value appears anywhere in the file.
      const tokens = [logicalName, columnValue].filter(Boolean) as string[];
      const found = tokens.some(
        (t) =>
          src.includes(`'${t}'`) ||
          src.includes(`"${t}"`) ||
          src.includes(`— ${t}`) ||
          src.includes(`describe('${t}`)
      );
      if (!found) offenders.push(`${file} (looked for: ${tokens.join(", ")})`);
    }
    expect(
      offenders,
      `These lanes have no balance-invariant case:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 4: every eventType: literal is declared in FinalityEventType
// ---------------------------------------------------------------------------

/** Parse the `FinalityEventType` union literal members from types/api.ts. */
function parseFinalityEventTypes(): Set<string> {
  const src = readFileSync(TYPES_API, "utf8");
  const m = src.match(/export\s+type\s+FinalityEventType\s*=\s*([\s\S]*?)\n\n/);
  if (!m) throw new Error("Could not locate FinalityEventType union in src/types/api.ts");
  const body = m[1]!;
  const names = new Set<string>();
  const RE = /'([A-Za-z][A-Za-z0-9_]*)'/g;
  let mm: RegExpExecArray | null;
  while ((mm = RE.exec(body)) !== null) names.add(mm[1]!);
  return names;
}

describe("lane invariants — FinalityEventType union completeness", () => {
  it("every eventType literal used in lane source is declared in FinalityEventType", () => {
    const declared = parseFinalityEventTypes();
    // Allowlist for legitimate non-union uses (e.g. internal bookkeeping
    // events that intentionally bypass the union — see _helpers.ts skipStateMachineCheck).
    const ALLOWED_RAW: Set<string> = new Set([
      "PreCheckSuspended",
      "NameCheckOverridden",
      "HtlcClaimRejected",
      "GtidDecided", // already in union
    ]);
    const used = new Set<string>();
    // Match both `eventType: 'X'` (helper) and `event_type: 'X'` (raw writeFinalityLog).
    const RE = /\bevent[T_]ype\s*:\s*'([A-Za-z][A-Za-z0-9_]*)'/g;
    for (const file of walkLaneSources()) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = RE.exec(src)) !== null) used.add(m[1]!);
    }

    const offenders: string[] = [];
    for (const name of used) {
      if (!declared.has(name) && !ALLOWED_RAW.has(name)) offenders.push(name);
    }
    expect(
      offenders,
      `These event types are used in lanes but missing from FinalityEventType:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});
