/**
 * The committed golden bytes for the paper end-to-end run.
 *
 * The file lives under `test/replay-golden/`, beside the `WP-090` order-book
 * golden and the `WP-210` simulation golden, because it is the same kind of
 * artefact: a frozen, byte-compared record of a deterministic replay. It does
 * NOT join `pnpm test:replay`'s §12.4 gate, which is `WP-090`/`WP-210` owned
 * and stays exactly as it is; this golden freezes the PAPER-CORE end-to-end
 * surface that `WP-230` and `WP-240` assembled, and it is compared by this
 * package's own suite.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The committed golden. Absolute, so the cwd cannot change what is compared. */
export const GOLDEN_PATH = resolve(
  here,
  "../../replay-golden/paper-e2e/paper-e2e-run.json",
);

/**
 * The environment variable that REGENERATES the golden.
 *
 * Deliberately awkward, and deliberately fatal. A regeneration run REWRITES the
 * committed bytes and then FAILS, so it can never be the thing that turned a
 * red suite green: whoever regenerates has to look at the diff and re-run
 * without the variable. See `test/replay-golden/paper-e2e/README.md`.
 */
export const WRITE_GOLDEN_ENV = "WP250_WRITE_GOLDEN";

export function goldenBytes(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

export function writeGoldenBytes(bytes: string): void {
  writeFileSync(GOLDEN_PATH, bytes, "utf8");
}

export function regenerationRequested(env: Record<string, string | undefined>): boolean {
  const value = env[WRITE_GOLDEN_ENV];
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/**
 * The first differing line of two byte strings, for a failing assertion.
 *
 * A 45 KB `toBe` diff is unreadable; the LINE that moved is what a reader
 * needs, and its number lets them open the golden at the right place.
 */
export function firstDifference(actual: string, expected: string): string {
  if (actual === expected) return "the two byte strings are identical";
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const limit = Math.max(actualLines.length, expectedLines.length);
  for (let index = 0; index < limit; index += 1) {
    const left = actualLines[index];
    const right = expectedLines[index];
    if (left !== right) {
      return (
        `first difference at line ${String(index + 1)}:\n` +
        `  golden : ${right ?? "(end of file)"}\n` +
        `  run    : ${left ?? "(end of file)"}`
      );
    }
  }
  return `the lines match but the byte lengths differ (${String(actual.length)} vs ${String(
    expected.length,
  )})`;
}
