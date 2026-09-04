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
 * WHAT IS SCANNED. Every `.ts` file under a workspace package's `src`,
 * recursively, `node_modules` and `dist` excluded. Test files (`*.test.ts`)
 * inside a package's `src` are INCLUDED deliberately: a copy of the parse door
 * parked in a `.test.ts` is still a second implementation to fix, and an import
 * written in a package's own test file is still that package's source.
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
 * `packageDir` is repository-relative (`"packages/execution-planner"`). Throws
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
 * Every `.ts` file under EVERY workspace package's `src`, recursively,
 * repository-relative and sorted.
 *
 * `packages/strategies/*` nests one level deeper than the rest, so a directory
 * with no `package.json` is treated as a container of packages rather than as a
 * package. Missing that is how a scan quietly stops covering a whole family.
 */
export function workspaceSourceFiles(): readonly string[] {
  const found: string[] = [];
  const packagesRoot = resolve(repoRoot, "packages");

  for (const entry of readdirSync(packagesRoot)) {
    const packageDir = join(packagesRoot, entry);
    if (!statSync(packageDir).isDirectory()) continue;
    const candidates: (readonly [string, string])[] = existsSync(join(packageDir, "package.json"))
      ? [[packageDir, `packages/${entry}`] as const]
      : readdirSync(packageDir)
          .map((nested) => [join(packageDir, nested), `packages/${entry}/${nested}`] as const)
          .filter(([absolute]) => statSync(absolute).isDirectory());
    for (const [absolute, relative] of candidates) {
      const source = join(absolute, "src");
      if (existsSync(source)) walk(source, `${relative}/src`, found);
    }
  }

  return found.sort();
}

/** The UTF-8 text of a repository-relative path. */
export function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}
