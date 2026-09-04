/**
 * WP-160 acceptance 3: NO FEATURE READS THE CURRENT WALL CLOCK DIRECTLY.
 *
 * Two independent mechanisms:
 *
 * 1. A SOURCE SCAN over every production module of `packages/features` for
 *    clock/randomness/scheduling constructs and for Node built-in imports
 *    other than the one allowlisted `node:crypto` (pure SHA-256, the
 *    `packages/decimal` precedent). Test files and the package's own test
 *    fixture module are excluded; they may use `Date.UTC` as an oracle.
 * 2. A BEHAVIORAL PROBE: the system clock is moved by years between two
 *    computations of the same input; every byte of the output must be
 *    identical. A single `Date.now()` anywhere in the computation path
 *    (ages, returns, lifecycle) would surface here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { computeFeatureSnapshot } from "../../../packages/features/src/index.js";
import { validInput } from "./fixtures.js";

const PACKAGE_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "features", "src");

function productionSources(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name === "testing") continue; // test fixture helpers, not product
      files.push(...productionSources(path));
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    files.push(path);
  }
  return files;
}

/** Construct → the reason it is banned from this package's product code. */
const FORBIDDEN_CONSTRUCTS: readonly [RegExp, string][] = [
  [/\bDate\s*\.\s*now\b/u, "reads the wall clock"],
  [/\bnew\s+Date\b/u, "constructs a Date (wall clock + host parser)"],
  [/\bDate\s*\.\s*parse\b/u, "implementation-lenient date parsing"],
  [/\bDate\s*\.\s*UTC\b/u, "Date surface; the package owns its own calendar math"],
  [/\bMath\s*\.\s*random\b/u, "unseeded randomness"],
  [/\bperformance\s*\./u, "reads a monotonic clock"],
  [/\bprocess\s*\./u, "process global"],
  [/\bsetTimeout\b/u, "scheduling"],
  [/\bsetInterval\b/u, "scheduling"],
  [/\bsetImmediate\b/u, "scheduling"],
  [/\bqueueMicrotask\b/u, "scheduling"],
  [/\bhrtime\b/u, "reads a monotonic clock"],
  [/\bgetRandomValues\b/u, "entropy"],
  [/\brequire\s*\(/u, "opaque module load"],
];

describe("acceptance 3: no wall clock", () => {
  it("scans every production source: no clock, randomness, scheduling, or stray built-in", () => {
    const sources = productionSources(PACKAGE_SRC);
    // The scan must actually be scanning something.
    expect(sources.length).toBeGreaterThanOrEqual(10);
    const findings: string[] = [];
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      for (const [pattern, reason] of FORBIDDEN_CONSTRUCTS) {
        if (pattern.test(text)) {
          findings.push(`${path}: ${String(pattern)} (${reason})`);
        }
      }
      for (const match of text.matchAll(/from\s+"(node:[^"]+)"/gu)) {
        const specifier = match[1] ?? "";
        if (!(specifier === "node:crypto" && path.endsWith("hash.ts"))) {
          findings.push(`${path}: import of ${specifier} (only node:crypto in hash.ts is allowlisted)`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  describe("behavioral probe", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("moving the system clock by years changes NOTHING in the output", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
      const early = computeFeatureSnapshot(validInput());
      vi.setSystemTime(new Date("2031-07-19T13:37:00Z"));
      const late = computeFeatureSnapshot(validInput());
      expect(early.ok).toBe(true);
      expect(late.ok).toBe(true);
      if (!early.ok || !late.ok) return;
      expect(late.serialization).toBe(early.serialization);
      expect(late.snapshot.contentAddress).toBe(early.snapshot.contentAddress);
      expect(late.snapshot).toEqual(early.snapshot);
    });
  });
});
