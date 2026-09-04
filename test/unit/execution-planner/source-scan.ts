/**
 * THE ONE SOURCE SCAN — `WP-180-FU2` remediation round 1, 2026-09-04.
 *
 * WHY THIS MODULE EXISTS. Four guards in this repository decide whether a
 * package's source obeys a contract by ENUMERATING that source and reading it:
 *
 * - `mirrors.test.ts` — no fourth copy of the collapsed parse door exists;
 * - `test/unit/execution-planner/ports.test.ts` — the §2.1 **S4** edge carries
 *   the two door subpaths and nothing else, and the ports stay structural;
 * - `test/unit/risk/ports.test.ts` — the same for **S3**, plus "no other
 *   layer-1 peer is imported";
 * - `test/unit/execution-planner/determinism.test.ts` — no impure primitive
 *   and no import outside the allowlist.
 *
 * Three of those four enumerated `readdirSync(<pkg>/src)` **non-recursively**,
 * and review round 1 of `WP-180-FU2` (finding M7) measured the consequence: a
 * file at `packages/execution-planner/src/nested/sneak.ts` importing
 * `parseRiskPolicy` from the risk package ROOT — the engine, which the ruling
 * forbids crossing this edge — passed `pnpm typecheck`, `pnpm check:deps`,
 * `pnpm lint` and every one of those guards. The mirror collapse is what made
 * that reachable: before it, the planner declared no dependency on
 * `packages/risk` at all, so the same file failed to compile (TS2307).
 *
 * A guard that reads a directory listing must therefore read the whole TREE.
 * There is exactly one walker, here, and every guard imports it — a second scan
 * idiom is how three of the four came to disagree with the fourth in the first
 * place.
 *
 * WHAT IS SCANNED. Every `.ts` file under a workspace member's `src`,
 * recursively, `node_modules` and `dist` excluded. Test files (`*.test.ts`)
 * inside a package's `src` are INCLUDED deliberately: a copy of the parse door
 * parked in a `.test.ts` is still a second implementation to fix, and an import
 * written in a package's own test file is still that package's source.
 *
 * A WORKSPACE MEMBER IS NOT ONLY A `packages/*` ENTRY (`WP-180-FU2` remediation
 * round 2, review finding LOW-B). `pnpm-workspace.yaml` lists `apps/*`,
 * `packages/*` and `packages/strategies/*`, and six apps have `src` trees; the
 * round-1 walker enumerated `packages/` alone. The reviewer measured the
 * consequence: a VERBATIM `cp` of the canonical `plain-data.ts` into
 * `apps/trader/src/pasted-door.ts` passed the deletion guard 7/7. An app is
 * exactly as able to paste the parse door as a package is — more so, since apps
 * are where the wiring lives — so the walker covers both roots, and the guards'
 * claims ("no file under any workspace member's `src`") are true as written.
 *
 * Paths are returned repository-relative and sorted, so a failure message names
 * the offender the way a reader would cite it and the order does not depend on
 * the filesystem.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, resolved from this file rather than from `cwd`. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Directory names a source scan never descends into. */
const SKIPPED = new Set(["node_modules", "dist"]);

function walk(absolute: string, relative: string, found: string[]): void {
  for (const entry of readdirSync(absolute)) {
    if (SKIPPED.has(entry)) continue;
    const childAbsolute = join(absolute, entry);
    const childRelative = `${relative}/${entry}`;
    if (statSync(childAbsolute).isDirectory()) walk(childAbsolute, childRelative, found);
    else if (entry.endsWith(".ts")) found.push(childRelative);
  }
}

/**
 * Every `.ts` file under `<packageDir>/src`, RECURSIVELY, repository-relative
 * and sorted.
 *
 * `packageDir` is repository-relative — any workspace member, so
 * `"packages/execution-planner"` and `"apps/trader"` both work. Throws
 * if the directory does not exist: a scan that silently returns nothing is a
 * guard that silently passes, which is the failure mode this module is for.
 */
export function packageSourceFiles(packageDir: string): readonly string[] {
  const source = resolve(repoRoot, packageDir, "src");
  if (!existsSync(source)) throw new Error(`no src directory for ${packageDir}`);
  const found: string[] = [];
  walk(source, `${packageDir}/src`, found);
  return found.sort();
}

/**
 * The roots `pnpm-workspace.yaml` globs, in the order it lists them. Kept as
 * data so widening the workspace is a one-line change here rather than a new
 * scan somewhere else.
 */
const WORKSPACE_ROOTS = ["apps", "packages"] as const;

/** Every `.ts` file under one workspace root's members, appended to `found`. */
function walkRoot(root: string, found: string[]): void {
  const rootDir = resolve(repoRoot, root);
  for (const entry of readdirSync(rootDir)) {
    const memberDir = join(rootDir, entry);
    if (!statSync(memberDir).isDirectory()) continue;
    // `packages/strategies/*` nests one level deeper than the rest, so a
    // directory with no `package.json` is treated as a CONTAINER of members
    // rather than as one. Missing that is how a scan quietly stops covering a
    // whole family.
    const candidates: (readonly [string, string])[] = existsSync(join(memberDir, "package.json"))
      ? [[memberDir, `${root}/${entry}`] as const]
      : readdirSync(memberDir)
          .map((nested) => [join(memberDir, nested), `${root}/${entry}/${nested}`] as const)
          .filter(([absolute]) => statSync(absolute).isDirectory());
    for (const [absolute, relative] of candidates) {
      const source = join(absolute, "src");
      if (existsSync(source)) walk(source, `${relative}/src`, found);
    }
  }
}

/**
 * Every `.ts` file under EVERY workspace member's `src` — `apps/*` as well as
 * `packages/*` and `packages/strategies/*` — recursively, repository-relative
 * and sorted.
 *
 * The `apps/*` half was added in `WP-180-FU2` remediation round 2 (review
 * finding LOW-B); see the module header for the paste this file used to miss.
 */
export function workspaceSourceFiles(): readonly string[] {
  const found: string[] = [];
  for (const root of WORKSPACE_ROOTS) walkRoot(root, found);
  return found.sort();
}

/** The UTF-8 text of a repository-relative path. */
export function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}
