/**
 * The §2.1 **S7** edge, pinned DOOR-ONLY.
 *
 * WHY THIS FILE EXISTS. `WP-170-FU1` wrote one new
 * `docs/contracts/dependency-direction.md` §2.1 row —
 * `packages/strategy-runtime` → `packages/risk` (**S7**) — granted for the
 * prototype-free parse door and NOTHING ELSE: "No rule, policy, or evaluation
 * logic may travel this edge." A workspace edge is not a subpath: once this
 * package declares `@polymarket-bot/risk`, EVERY export of that package
 * resolves from every file in the runtime tree, including the risk ENGINE at
 * the package root (`parseRiskPolicy`, `evaluateIntent`, the policy and the
 * recommendations). That is the hole `WP-180-FU2` review round 1 measured for
 * **S4** (finding M7) and `WP-200-FU1` review round 1 measured again for
 * **S5** and **S6** (finding M1), and the answer both times was a guard that reads
 * the whole tree and asserts on EVERY `@polymarket-bot/risk` specifier it
 * finds. This file is that guard for S7.
 *
 * WHAT THE SNEAK ACTUALLY REACHED HERE, MEASURED RATHER THAN ASSUMED. The
 * probe was reproduced at this round's tip in a `/dev/shm` scratch tree:
 *
 * ```text
 *   packages/strategy-runtime/src/nested/sneak.ts
 *     -> import { evaluateIntent, parseRiskPolicy } from "@polymarket-bot/risk"
 *
 *   pnpm check:deps  PASS — 34 packages / 52 declared workspace edges
 *   pnpm typecheck   PASS
 *   pnpm lint        PASS
 *   pnpm test        FAIL ×2 —
 *       test/unit/strategy-runtime/package-boundaries.test.ts
 *         "every runtime source import is relative, the domain/SDK entry
 *          point, or one of the two S7 door subpaths"
 *       test/unit/strategy-runtime/boundary-surface.test.ts
 *         "every callable the type checker resolves is classified"
 * ```
 *
 * So — stated plainly, because the ledger round's identical section reported
 * the opposite — the S5/S6 hole is NOT open on this edge: `WP-170`'s
 * `package-boundaries.test.ts` already walks this package's `src` tree
 * RECURSIVELY and enumerates the permitted specifiers one by one, so widening
 * it for the two door subpaths (this round) left the engine root failing by
 * name. What this file adds on top of that is the half a per-package import
 * allowlist cannot state: the edge must EXIST, it must run only INTO
 * `packages/risk` (F9 — no reverse edge, no cycle), the manifest may carry no
 * other same-layer peer than the two cited rows permit (S1 and S7), and the
 * matcher that does the work is itself non-vacuous. It is
 * `test/unit/ledger/ports.test.ts` — the S5/S6 pin — applied to the one row
 * `WP-170-FU1` added.
 *
 * THE SCAN IS RECURSIVE, and that is load-bearing rather than tidy: the sneak
 * above sits at `src/nested/sneak.ts`, and a one-level `readdirSync(src)`
 * walker cannot see it. There is exactly one walker in this repository
 * (`test/unit/execution-planner/source-scan.ts`); this file imports it rather
 * than growing a second scan idiom, for the reason that module's header gives.
 *
 * A test tree is not a workspace package, so importing across it declares no
 * dependency edge — `test/unit/ledger/ports.test.ts` and
 * `test/unit/risk/ports.test.ts` already import
 * `test/unit/execution-planner/source-scan.js` in the same way.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { packageSourceFiles, readSource, repoRoot } from "../execution-planner/source-scan.js";

/** The canonical package the row runs INTO. */
const CANONICAL = "packages/risk";

/** The consumer the row runs FROM. */
const CONSUMER = "packages/strategy-runtime";

/** The two subpaths §2.1 S7 permits, and the only ones. */
const DOOR_SUBPATHS = ["@polymarket-bot/risk/plain-data", "@polymarket-bot/risk/schema-arena"];

/**
 * Every layer-1 peer whose import would be an UNLISTED same-layer edge (F13)
 * from this package. Two of them are listed: `@polymarket-bot/strategy-sdk`
 * (row **S1**, the whole package — `WP-170` owns both sides) and
 * `@polymarket-bot/risk` (row **S7**, the two {@link DOOR_SUBPATHS} only).
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

describe("the S7 edge exists, runs one way, and carries the door only", () => {
  it("the consumer declares the edge, and packages/risk declares NOTHING back (F9)", () => {
    expect(declaredWorkspacePeers(CONSUMER), `${CONSUMER} must declare the S7 edge`).toContain(
      "@polymarket-bot/risk",
    );
    // The reverse would close a cycle. `packages/risk` holds the two layer-0
    // contracts and nothing else, which is also what the S3 and S5/S6 pins
    // assert — the acyclicity claim in the S7 row's basis, kept mechanical.
    expect(declaredWorkspacePeers(CANONICAL)).not.toContain("@polymarket-bot/strategy-runtime");
    expect(declaredWorkspacePeers(CANONICAL)).toEqual([
      "@polymarket-bot/decimal",
      "@polymarket-bot/domain",
    ]);
  });

  it("the consumer declares no layer-1 workspace peer beyond its two cited rows", () => {
    // The frozen layer-0 contract, plus exactly two same-layer edges: S1
    // (`strategy-sdk`, the callback interface) and S7 (`risk`, the parse door).
    // Anything else would be an unlisted same-layer edge (F13).
    expect(declaredWorkspacePeers(CONSUMER), `${CONSUMER}'s workspace peers`).toEqual([
      "@polymarket-bot/domain",
      "@polymarket-bot/risk",
      "@polymarket-bot/strategy-sdk",
    ]);
  });

  it("the S7 edge carries the parse door and NOTHING ELSE — not the package root", () => {
    const { files, specifiers } = specifiersOf(CONSUMER);
    const riskSpecifiers = specifiers.filter((specifier) =>
      /^@polymarket-bot\/risk(?:\/|$)/u.test(specifier),
    );
    // Non-vacuity: the recursive scan found the tree, and this package really
    // does consume the door.
    expect(files.length, `${CONSUMER} source files scanned`).toBeGreaterThan(10);
    expect(riskSpecifiers.length, `${CONSUMER} imports neither door module`).toBeGreaterThan(0);
    expect([...new Set(riskSpecifiers)].sort()).toEqual(DOOR_SUBPATHS);
  });

  it("the consumer's source IMPORTS no other layer-1 peer than S1 and the S7 door", () => {
    // Prose references to a peer package are expected — `parse-door.ts` names
    // `packages/risk` in its header on purpose. What must not appear is an
    // import SPECIFIER, so the assertion is on `from "<name>"` and
    // `from "<name>/…"`, never on the bare name in a comment.
    const offenders: string[] = [];
    const files = packageSourceFiles(CONSUMER);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      for (const match of readSource(file).matchAll(/(?:from|import\()\s*"([^"]+)"/gu)) {
        const specifier = match[1] ?? "";
        const peer = LAYER_1_PEERS.find(
          (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
        );
        if (peer === undefined || peer === "@polymarket-bot/strategy-runtime") continue;
        // Row S1: the SDK entry point, the whole package.
        if (peer === "@polymarket-bot/strategy-sdk" && specifier === peer) continue;
        // Row S7: the two door subpaths, and never the engine root.
        if (peer === "@polymarket-bot/risk" && DOOR_SUBPATHS.includes(specifier)) continue;
        offenders.push(`${file} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("MUTATION KILL: the guard above really does reject a package-root import", () => {
    // Non-vacuity for the two guards over the scan. They are text guards, so
    // the thing that can rot is the MATCHER, not the tree: this replays the
    // reproduced sneak's exact import line through the same regexes and
    // requires both to classify it as a violation. Without this, a matcher
    // that silently stopped matching would leave both guards passing on an
    // empty set — the shape `WP-180-FU2` round 2 found in the evasion table.
    const sneak = 'import { evaluateIntent, parseRiskPolicy } from "@polymarket-bot/risk";';
    const found = [...sneak.matchAll(/(?:from|import\()\s*"([^"]+)"/gu)].map(
      (match) => match[1] ?? "",
    );
    expect(found).toEqual(["@polymarket-bot/risk"]);
    expect(DOOR_SUBPATHS).not.toContain(found[0]);
    expect(LAYER_1_PEERS).toContain(found[0]);
    expect(/^@polymarket-bot\/risk(?:\/|$)/u.test(found[0] ?? "")).toBe(true);
    // …and a THIRD subpath is a violation too, not only the root.
    const third = 'import { x } from "@polymarket-bot/risk/policy";';
    const thirdFound = [...third.matchAll(/(?:from|import\()\s*"([^"]+)"/gu)].map(
      (match) => match[1] ?? "",
    );
    expect(thirdFound).toEqual(["@polymarket-bot/risk/policy"]);
    expect(DOOR_SUBPATHS).not.toContain(thirdFound[0]);
  });
});

describe("the S7 edge did not widen what a STRATEGY can reach", () => {
  it("no concrete strategy package declares packages/risk, and the runtime is still out of reach", () => {
    // §2.1 has no `packages/strategies/* → packages/risk` row and no
    // `strategies → strategy-runtime` row; F13 fails closed on both. The door
    // this round adopted lives BEHIND the runtime, so a strategy still cannot
    // see it — which is the property `package-boundaries.test.ts` states for
    // the SDK surface, restated here for the new edge.
    const strategy = declaredWorkspacePeers("packages/strategies/static-bracket");
    expect(strategy).not.toContain("@polymarket-bot/risk");
    expect(strategy).not.toContain("@polymarket-bot/strategy-runtime");
  });
});
