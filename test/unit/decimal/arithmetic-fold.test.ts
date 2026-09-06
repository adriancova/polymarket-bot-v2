/**
 * THE HONEST-PATH FOLD, pinned (`WP-020-FU1` review round 1).
 *
 * `arithmetic-fold.ts` walks a fixed corpus of canonical decimal strings through
 * every public operation of `packages/decimal` and hashes the answers. This file
 * runs it and pins the digest, which turns the round's central claim —
 * **the index-name guard changes nothing an honest process computes** — from a
 * number in a handoff into a gate.
 *
 * MEASURED THREE WAYS, all identical, with this harness:
 *
 * ```text
 * tree                             valuesDigest       fullDigest
 * base            b4ce0aa          e2a7ac26…          dbb3a797…
 * round-0 tip     37fa983          e2a7ac26…          dbb3a797…
 * round-1 tip     (this commit)    e2a7ac26…          dbb3a797…
 * ```
 *
 * Round 0 asserted the base↔tip half on the strength of an UNCOMMITTED harness,
 * so the reviewer could not reproduce it. Reproducing it now needs two trees, so
 * the cross-commit half stays a handoff transcript; what lives here is the half
 * that can be re-derived from this checkout alone, and it is the half a later
 * edit would break.
 *
 * WHY A CHILD PROCESS. The same reason `unneutralizable-shapes.test.ts` uses
 * one, minus the danger: the fold must run in a process that nothing has
 * touched. A vitest worker has already loaded the test framework, and the whole
 * point of the digest is that it describes `packages/decimal` in a clean realm
 * rather than in whatever realm the file before it left behind.
 *
 * IF THIS FAILS, an arithmetic answer moved. That is either a defect or a
 * deliberate contract change (`docs/contracts/domain.md` freeze policy); it is
 * never a reason to edit the constant without saying which.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FOLD = resolve(HERE, "arithmetic-fold.ts");

/** Generous against the measured ~110 ms, for the reason in finding M2. */
const FOLD_TIMEOUT_MS = 60_000;

/** Answers only; a throw folds in as the bare token `THREW`. */
const VALUES_DIGEST = "e2a7ac26377be56ea3f1e5d9af045a4dc155c3613ed785553c824b28253fc411";

/** Answers plus every throw's class, `code` and message. */
const FULL_DIGEST = "dbb3a79742027ba29b28503bd766f7ed966a6718114cad1d17a8baa6c203fd9a";

interface FoldResult {
  readonly corpus: number;
  readonly ticks: number;
  readonly operations: number;
  readonly valuesDigest: string;
  readonly fullDigest: string;
}

describe("the honest-path fold", { timeout: FOLD_TIMEOUT_MS }, () => {
  it("answers the pinned digests over the whole corpus", () => {
    const stdout = execFileSync(process.execPath, [FOLD], {
      encoding: "utf8",
      timeout: FOLD_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(stdout) as FoldResult;
    // The shape of the fold, so a corpus that quietly shrank cannot pass by
    // hashing fewer rows into a constant somebody re-pasted.
    expect(result.corpus).toBe(24);
    expect(result.ticks).toBe(6);
    expect(result.operations).toBe(5568);
    expect(result.valuesDigest).toBe(VALUES_DIGEST);
    expect(result.fullDigest).toBe(FULL_DIGEST);
  });
});
