/**
 * The §2.1 **S5** and **S6** edges, pinned DOOR-ONLY.
 *
 * WHY THIS FILE EXISTS (`WP-200-FU1` review round 1, finding M1). `WP-200-FU1`
 * wrote two new `docs/contracts/dependency-direction.md` §2.1 rows —
 * `packages/ledger` → `packages/risk` (**S5**) and `packages/pnl` →
 * `packages/risk` (**S6**) — each granted for the prototype-free parse door and
 * NOTHING ELSE: "No rule, policy, or evaluation logic may travel this edge."
 *
 * A workspace edge is not a subpath. Once `packages/ledger` declares
 * `@polymarket-bot/risk`, EVERY export of that package resolves from every file
 * in the ledger tree, including the risk ENGINE at the package root
 * (`parseRiskPolicy`, `evaluateIntent`, the policy and the recommendations).
 * `pnpm check:deps` sees one edge and says PASS; `tsc` compiles it; `eslint`
 * has no opinion. This is exactly the hole `WP-180-FU2` review round 1 measured
 * for **S4** (finding M7) and round 1 of THIS package measured again:
 *
 * ```text
 * REPRODUCED at tip 7d5ac34, in a /dev/shm scratch tree:
 *   packages/ledger/src/nested/sneak.ts  -> import { evaluateIntent,
 *   packages/pnl/src/nested/sneak.ts        parseRiskPolicy } from "@polymarket-bot/risk"
 *
 *   pnpm check:deps  PASS — 34 packages / 49 declared workspace edges
 *   pnpm typecheck   PASS
 *   pnpm lint        PASS
 *   pnpm test        PASS — 229 files / 5354 tests
 * ```
 *
 * The whole gate set was green with the risk engine imported into both monetary
 * packages. The two guards in `test/unit/execution-planner/mirrors.test.ts` that
 * read the consumers cannot see it either: they match specifiers ENDING in
 * `plain-data`/`schema-arena`, and a bare package-root import ends in neither.
 * So the door-only property needs a guard that reads the whole tree and asserts
 * on EVERY `@polymarket-bot/risk` specifier it finds, which is what this file
 * is. It is `test/unit/risk/ports.test.ts`'s last describe — the **S3** pin —
 * applied to the two rows `WP-200-FU1` added.
 *
 * THE SCAN IS RECURSIVE, and that is load-bearing rather than tidy: the sneak
 * above sits at `src/nested/sneak.ts`, and a one-level `readdirSync(src)` walker
 * cannot see it. There is exactly one walker in this repository
 * (`test/unit/execution-planner/source-scan.ts`); this file imports it rather
 * than growing a second scan idiom, for the reason that module's header gives.
 *
 * A test tree is not a workspace package, so importing across it declares no
 * dependency edge — `test/unit/risk/ports.test.ts` already imports
 * `test/unit/execution-planner/source-scan.js` in the same way.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  packageSourceFiles,
  readSource,
  repoRoot,
} from "../execution-planner/source-scan.js";

/** The canonical package both rows run INTO. */
const CANONICAL = "packages/risk";

/**
 * The subpaths §2.1 S5 and S6 permit, and the only ones. Two at `WP-200-FU1`;
 * `SER-1` (2026-09-15) widened both rows' consumed-surface clause by the
 * own-data JSON encoder, `plain-json.ts`, which the five accounting Map keys
 * and the two `stableStringify` oracles now consume — the measured basis is
 * `docs/handoffs/SER-0-sweep.md` (an inherited `toJSON` collapsed every key).
 * Still door subpaths only: no rule, policy or evaluation logic.
 */
const DOOR_SUBPATHS = [
  "@polymarket-bot/risk/plain-data",
  "@polymarket-bot/risk/plain-json",
  "@polymarket-bot/risk/schema-arena",
];

/** The two rows `WP-200-FU1` added, as (row, consumer) pairs. */
const ROWS = [
  { row: "S5", dir: "packages/ledger", name: "@polymarket-bot/ledger" },
  { row: "S6", dir: "packages/pnl", name: "@polymarket-bot/pnl" },
] as const;

/**
 * Every layer-1 peer whose import would be an UNLISTED same-layer edge (F13)
 * from either of these two packages. `@polymarket-bot/risk` is in the list and
 * is the one crossing the rows permit — but only through {@link DOOR_SUBPATHS}.
 */
const LAYER_1_PEERS = [
  "@polymarket-bot/capital-allocator",
  "@polymarket-bot/execution-planner",
  "@polymarket-bot/features",
  "@polymarket-bot/inventory",
  "@polymarket-bot/ledger",
  "@polymarket-bot/oms",
  "@polymarket-bot/order-book",
  "@polymarket-bot/pnl",
  "@polymarket-bot/risk",
  "@polymarket-bot/settlement",
  "@polymarket-bot/simulation",
  "@polymarket-bot/strategy-runtime",
  "@polymarket-bot/strategy-sdk",
  "@polymarket-bot/universe",
];

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function manifestOf(dir: string): Manifest {
  return JSON.parse(readFileSync(resolve(repoRoot, dir, "package.json"), "utf8")) as Manifest;
}

function declaredWorkspacePeers(dir: string): string[] {
  const manifest = manifestOf(dir);
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((dependency) => dependency.startsWith("@polymarket-bot/"))
    .sort();
}

/** Every import/`import()` specifier appearing in one package's whole src tree. */
function specifiersOf(dir: string): { files: readonly string[]; specifiers: readonly string[] } {
  const files = packageSourceFiles(dir);
  const specifiers: string[] = [];
  for (const file of files) {
    for (const match of readSource(file).matchAll(/(?:from|import\()\s*"([^"]+)"/gu)) {
      specifiers.push(match[1] ?? "");
    }
  }
  return { files, specifiers };
}

describe("the S5/S6 edges exist, run one way, and carry the door only", () => {
  it("each consumer declares the edge, and packages/risk declares NEITHER back (F9)", () => {
    for (const { row, dir, name } of ROWS) {
      expect(declaredWorkspacePeers(dir), `${dir} must declare the ${row} edge`).toContain(
        "@polymarket-bot/risk",
      );
      // The reverse would close a cycle. `packages/risk` holds the two layer-0
      // contracts and nothing else, which is also what the S3 pin asserts.
      expect(declaredWorkspacePeers(CANONICAL)).not.toContain(name);
    }
    expect(declaredWorkspacePeers(CANONICAL)).toEqual([
      "@polymarket-bot/decimal",
      "@polymarket-bot/domain",
    ]);
  });

  it("neither consumer declares any layer-1 workspace peer beyond its own row", () => {
    // Two layer-0 contracts plus exactly one same-layer edge, the cited row.
    // Anything else would be an unlisted same-layer edge (F13) — including a
    // `ledger` ⇄ `pnl` edge, which no row permits and which the PnL-record
    // bridge is deliberately STRUCTURAL to avoid.
    for (const { dir } of ROWS) {
      expect(declaredWorkspacePeers(dir), `${dir}'s workspace peers`).toEqual([
        "@polymarket-bot/decimal",
        "@polymarket-bot/domain",
        "@polymarket-bot/risk",
      ]);
    }
  });

  /**
   * THE FINDING-M1 GUARD. Every `@polymarket-bot/risk` specifier in either
   * tree is one of the door subpaths above. A bare `from "@polymarket-bot/risk"`
   * — the package ROOT, which exports the engine, the policy and the
   * recommendations — is a violation, and so is any subpath the list does not
   * name. (The list grew from two to three at `SER-1`, with the §2.1 S5/S6
   * clause widened in the same change.)
   */
  for (const { row, dir } of ROWS) {
    it(`the ${row} edge carries the parse door and NOTHING ELSE — not the package root`, () => {
      const { files, specifiers } = specifiersOf(dir);
      const riskSpecifiers = specifiers.filter((specifier) =>
        /^@polymarket-bot\/risk(?:\/|$)/u.test(specifier),
      );
      // Non-vacuity: the recursive scan found the tree, and this package really
      // does consume the door.
      expect(files.length, `${dir} source files scanned`).toBeGreaterThan(10);
      expect(riskSpecifiers.length, `${dir} imports neither door module`).toBeGreaterThan(0);
      expect([...new Set(riskSpecifiers)].sort()).toEqual(DOOR_SUBPATHS);
    });
  }

  it("neither consumer's source IMPORTS any other layer-1 peer", () => {
    // Prose references to a peer package are expected — `fill-posting.ts` names
    // `@polymarket-bot/pnl` in its header on purpose. What must not appear is an
    // import SPECIFIER, so the assertion is on `from "<name>"` and
    // `from "<name>/…"`, never on the bare name in a comment.
    const offenders: string[] = [];
    for (const { dir, name } of ROWS) {
      const files = packageSourceFiles(dir);
      expect(files.length).toBeGreaterThan(10);
      for (const file of files) {
        for (const match of readSource(file).matchAll(/(?:from|import\()\s*"([^"]+)"/gu)) {
          const specifier = match[1] ?? "";
          const peer = LAYER_1_PEERS.find(
            (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
          );
          if (peer === undefined || peer === name) continue;
          // The one permitted crossing is this package's own §2.1 door edge.
          if (peer === "@polymarket-bot/risk" && DOOR_SUBPATHS.includes(specifier)) continue;
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("MUTATION KILL: the guard above really does reject a package-root import", () => {
    // Non-vacuity for the two guards over the scan. They are text guards, so
    // the thing that can rot is the MATCHER, not the tree: this replays the
    // reproduced sneak's exact import line through the same regexes and
    // requires both to classify it as a violation. Without this, a matcher that
    // silently stopped matching would leave both guards passing on an empty
    // set — the shape `WP-180-FU2` round 2 found in the evasion table.
    const sneak = 'import { evaluateIntent, parseRiskPolicy } from "@polymarket-bot/risk";';
    const found = [...sneak.matchAll(/(?:from|import\()\s*"([^"]+)"/gu)].map(
      (match) => match[1] ?? "",
    );
    expect(found).toEqual(["@polymarket-bot/risk"]);
    expect(DOOR_SUBPATHS).not.toContain(found[0]);
    expect(LAYER_1_PEERS).toContain(found[0]);
    expect(/^@polymarket-bot\/risk(?:\/|$)/u.test(found[0] ?? "")).toBe(true);
  });
});

describe("the ledger ⇄ pnl PnL-record bridge stays STRUCTURAL", () => {
  it("neither package imports the other, in either direction", () => {
    // `buildFillPosting` emits records `@polymarket-bot/pnl` folds. No §2.1 row
    // permits an edge between the two, and S5/S6 are not a licence for one:
    // both run to `packages/risk` and carry the parse door only.
    for (const { dir, name } of ROWS) {
      const other = ROWS.find((row) => row.dir !== dir);
      expect(other).toBeDefined();
      if (other === undefined) return;
      expect(declaredWorkspacePeers(dir), `${name} must not declare ${other.name}`).not.toContain(
        other.name,
      );
      const { specifiers } = specifiersOf(dir);
      for (const specifier of specifiers) {
        expect(
          specifier === other.name || specifier.startsWith(`${other.name}/`),
          `${dir} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });
});
