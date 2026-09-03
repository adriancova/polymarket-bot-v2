/**
 * Freshness classification (§9.8 check 7) and the no-clock guarantee.
 *
 * Staleness is a CALLER-SUPPLIED measurement. These tests pass ages directly
 * and never advance or read a clock, which is the property that makes the same
 * decision reproducible on replay (§6 invariant 2, §12.4).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assessFreshness,
  blocksAsStale,
  isExpired,
  instantMilliseconds,
} from "../../../packages/risk/src/index.js";
import { MARKET_A, MARKET_B } from "./fixtures.js";

const policy = { venueBookMaxAgeMs: 1000, referenceFeedMaxAgeMs: 2000, featuresMaxAgeMs: 2000 };

describe("assessFreshness", () => {
  it("classifies a measured, in-limit feed as FRESH", () => {
    const assessment = assessFreshness(
      [{ feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 1000 }],
      policy,
      MARKET_A,
    );
    expect(assessment.venueBook.status).toBe("FRESH");
    expect(blocksAsStale(assessment.venueBook)).toBe(false);
  });

  it("classifies an over-limit feed as STALE (the limit itself is inclusive)", () => {
    const assessment = assessFreshness(
      [{ feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 1001 }],
      policy,
      MARKET_A,
    );
    expect(assessment.venueBook.status).toBe("STALE");
    expect(blocksAsStale(assessment.venueBook)).toBe(true);
  });

  it("classifies an UNMEASURED feed as UNKNOWN, and unknown blocks like stale", () => {
    const assessment = assessFreshness([], policy, MARKET_A);
    expect(assessment.venueBook.status).toBe("UNKNOWN");
    expect(assessment.referenceFeed.status).toBe("UNKNOWN");
    expect(assessment.features.status).toBe("UNKNOWN");
    expect(blocksAsStale(assessment.venueBook)).toBe(true);
    expect(blocksAsStale(assessment.referenceFeed)).toBe(true);
    expect(blocksAsStale(assessment.features)).toBe(true);
  });

  it("lets the STALEST measurement of a feed govern (fail closed)", () => {
    const assessment = assessFreshness(
      [
        { feed: "FEATURES", ageMs: 10 },
        { feed: "FEATURES", ageMs: 9000 },
      ],
      policy,
      MARKET_A,
    );
    expect(assessment.features.ageMs).toBe(9000);
    expect(assessment.features.status).toBe("STALE");
  });

  it("counts a VENUE_BOOK measurement only for the market it names", () => {
    const other = assessFreshness(
      [{ feed: "VENUE_BOOK", marketId: MARKET_B, ageMs: 10 }],
      policy,
      MARKET_A,
    );
    expect(other.venueBook.status).toBe("UNKNOWN");
  });

  it("returns a frozen assessment", () => {
    const assessment = assessFreshness([], policy, MARKET_A);
    expect(Object.isFrozen(assessment)).toBe(true);
  });
});

describe("deadline comparison reads no clock", () => {
  it("compares two caller-supplied instants", () => {
    expect(isExpired("2026-09-02T11:00:00.000Z", "2026-09-02T12:00:00.000Z")).toBe(true);
    expect(isExpired("2026-09-02T13:00:00.000Z", "2026-09-02T12:00:00.000Z")).toBe(false);
  });

  it("compares by instant, not lexicographically, across UTC offsets", () => {
    expect(isExpired("2026-09-02T13:00:00.000+02:00", "2026-09-02T12:00:00.000Z")).toBe(true);
    expect(instantMilliseconds("2026-09-02T12:00:00.000Z")).toBe(
      instantMilliseconds("2026-09-02T14:00:00.000+02:00"),
    );
  });

  it("returns undefined — not a verdict — for an unparseable instant", () => {
    expect(instantMilliseconds("not-a-time")).toBeUndefined();
    expect(isExpired("not-a-time", "2026-09-02T12:00:00.000Z")).toBeUndefined();
  });

  /**
   * Comments are stripped before the scan: `time.ts` DOCUMENTS that it does not
   * call `Date.now()`, and a scan that could not tell prose from code would
   * make that sentence unwriteable. The stripper is a test-local heuristic, not
   * a parser — the authoritative check is `tools/check-dependency-direction.mjs`
   * (F11 and its `new Date()` allowance), which walks the AST.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|\s)\/\/.*$/gmu, "$1");
  }

  it("this package's source contains no clock read and no unseeded randomness", () => {
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/risk/src");
    const scanned: string[] = [];
    for (const entry of readdirSync(source)) {
      if (!entry.endsWith(".ts")) continue;
      scanned.push(entry);
      const code = stripComments(readFileSync(join(source, entry), "utf8"));
      expect(code, `${entry} reads a clock`).not.toMatch(/Date\.now\s*\(/u);
      expect(code, `${entry} constructs a current Date`).not.toMatch(/new\s+Date\s*\(\s*\)/u);
      expect(code, `${entry} uses unseeded randomness`).not.toMatch(/Math\.random/u);
      expect(code, `${entry} performs I/O`).not.toMatch(/from\s+"node:/u);
    }
    // The scan is only meaningful if it actually saw the module that parses
    // instants; an empty or mis-pathed directory would pass vacuously.
    expect(scanned).toContain("time.ts");
    expect(scanned.length).toBeGreaterThan(10);
  });
});
