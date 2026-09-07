/**
 * `./grammar.ts` — the two re-stated formats, held to the frozen schemas' own
 * verdicts by a DIFFERENTIAL sweep.
 *
 * `docs/contracts/schema-boundary.md` §1's standing warning is that a
 * hand-written copy of a frozen grammar drifts from it, and `SETL-1` r1 B1's
 * lesson is that a re-statement has to be proven in BOTH directions: clean (it
 * must not be stricter than the schema, or it refuses inputs the contract
 * accepts) and under an inherited `skipChecks` (it must still refuse, or the
 * compensation is vacuous). Both are measured here, per row, with the corpus
 * counted so a shrunken corpus fails instead of silently passing.
 */

import { isCanonicalDecimalString } from "@polymarket-bot/decimal";
import { IsoTimestampSchema, PositiveDecimalStringSchema } from "@polymarket-bot/domain";
import { afterEach, describe, expect, it } from "vitest";

import { ISO_TIMESTAMP_PATTERN, isIsoTimestamp, isPositiveDecimalString } from "./grammar.js";

// ---------------------------------------------------------------------------
// Pollution, always removed in a `finally` and again in `afterEach`.
// ---------------------------------------------------------------------------

function withSkipChecks<T>(enumerable: boolean, run: () => T): T {
  Object.defineProperty(Object.prototype, "skipChecks", {
    value: true,
    enumerable,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(Object.prototype, "skipChecks");
  }
}

afterEach(() => {
  Reflect.deleteProperty(Object.prototype, "skipChecks");
});

// ---------------------------------------------------------------------------
// The corpora
// ---------------------------------------------------------------------------

const DATES: readonly string[] = [
  "2026-08-28",
  "2026-02-28",
  "2026-02-29",
  "2024-02-29",
  "2000-02-29",
  "1900-02-29",
  "2026-02-30",
  "2026-04-31",
  "2026-13-01",
  "2026-00-10",
  "2026-08-00",
  "2026-08-32",
  "26-08-28",
  "2026-8-28",
];

const TIMES: readonly string[] = [
  "12:15:30",
  "00:00:00",
  "23:59:59",
  "24:00:00",
  "12:60:00",
  "12:15",
  "12:15:30.1",
  "12:15:30.123456",
  "12:15:30.",
  "1:15:30",
];

const OFFSETS: readonly string[] = ["Z", "+00:00", "-05:00", "+14:00", "+99:00", "+0500", "", "z"];

/** Every combination, plus the shapes that are not `<date>T<time><offset>` at all. */
function instantCorpus(): readonly string[] {
  const values: string[] = [];
  for (const date of DATES) {
    for (const time of TIMES) {
      for (const offset of OFFSETS) {
        values.push(`${date}T${time}${offset}`);
      }
    }
  }
  values.push(
    "",
    " ",
    "yesterday",
    "Aug 28 2026",
    "2026-08-28",
    "2026-08-28 12:15:30Z",
    "2026-08-28t12:15:30Z",
    "20260828T121530Z",
    "\n2026-08-28T12:15:30Z",
    "2026-08-28T12:15:30Z\n",
    "2026-08-28T12:15:30Z ",
    "1756382130",
  );
  return values;
}

const DECIMAL_CORPUS: readonly string[] = [
  "0.01",
  "1",
  "5",
  "0.000001",
  "123456789012345678901234567890",
  "1.5",
  "0",
  "-0",
  "-1",
  "-9",
  "1.50",
  "01.5",
  "+1.5",
  ".5",
  "5.",
  "1e3",
  "1E3",
  "0x10",
  "Infinity",
  "NaN",
  "",
  " 1",
  "1 ",
  "1,5",
  "١٢٣",
  "9".repeat(1024),
  "9".repeat(1025),
];

// ---------------------------------------------------------------------------
// The pattern is the schema's own
// ---------------------------------------------------------------------------

describe("the instant grammar is recomposed, not rewritten", () => {
  it("reads IsoTimestampSchema's OWN compiled pattern", () => {
    // If a `zod` upgrade stops exposing it, `./grammar.ts` degrades to calling
    // the schema (never stricter) — and this assertion fails, so the
    // degradation is loud rather than silent.
    expect(ISO_TIMESTAMP_PATTERN).toBeInstanceOf(RegExp);
  });

  it("carries no global or sticky flag, so repeated calls cannot disagree", () => {
    for (const value of ["2026-08-28T12:15:30Z", "2026-08-28T12:15:30Z", "2026-08-28T12:15:30Z"]) {
      expect(isIsoTimestamp(value)).toBe(true);
    }
  });
});

describe("the instant grammar agrees with the frozen schema, row by row", () => {
  it("has ZERO drift over the whole corpus, in both directions", () => {
    const corpus = instantCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(1000);
    let accepted = 0;
    let refused = 0;
    const drift: string[] = [];
    for (const value of corpus) {
      const schema = IsoTimestampSchema.safeParse(value).success;
      const restated = isIsoTimestamp(value);
      if (schema !== restated) {
        drift.push(`${value}: schema=${String(schema)} restated=${String(restated)}`);
      }
      if (schema) {
        accepted += 1;
      } else {
        refused += 1;
      }
    }
    expect(drift).toEqual([]);
    // NON-VACUITY: a corpus that only refuses proves nothing about strictness,
    // and one that only accepts proves nothing about the compensation.
    expect(accepted).toBeGreaterThanOrEqual(50);
    expect(refused).toBeGreaterThanOrEqual(500);
  });

  it("refuses non-strings without consulting the schema", () => {
    for (const value of [undefined, null, 0, 1756382130, true, {}, [], new Date(0)]) {
      expect(isIsoTimestamp(value)).toBe(false);
    }
  });

  it("keeps its verdict under an inherited skipChecks, which the schema does not", () => {
    // The point of the compensation, measured: `skipChecks` makes the frozen
    // schema accept what it refused, and the re-statement is unmoved.
    const sample = ["Aug 28 2026", "2026-08-28T12:15:30", "2026-08-28", "2026-02-30T00:00:00Z"];
    for (const enumerable of [false, true]) {
      const label = enumerable ? "enumerable" : "non-enumerable";
      let schemaFlipped = 0;
      for (const value of sample) {
        expect(IsoTimestampSchema.safeParse(value).success, label).toBe(false);
        const underSkip = withSkipChecks(enumerable, () => ({
          schema: IsoTimestampSchema.safeParse(value).success,
          restated: isIsoTimestamp(value),
        }));
        if (underSkip.schema) {
          schemaFlipped += 1;
        }
        expect(underSkip.restated, `${label}: ${value}`).toBe(false);
      }
      // Per-variant non-vacuity: if `skipChecks` did not defeat the schema at
      // all, this test would pass while measuring nothing.
      expect(schemaFlipped, label).toBe(sample.length);
    }
  });
});

describe("the decimal grammar is the schema's own predicate", () => {
  it("has ZERO drift over the corpus, in both directions", () => {
    let accepted = 0;
    let refused = 0;
    const drift: string[] = [];
    for (const value of DECIMAL_CORPUS) {
      const schema = PositiveDecimalStringSchema.safeParse(value).success;
      const restated = isPositiveDecimalString(value);
      if (schema !== restated) {
        drift.push(`${value.slice(0, 20)}: schema=${String(schema)} restated=${String(restated)}`);
      }
      if (schema) {
        accepted += 1;
      } else {
        refused += 1;
      }
    }
    expect(drift).toEqual([]);
    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(refused).toBeGreaterThanOrEqual(15);
  });

  it("is the same function the frozen schema calls", () => {
    for (const value of DECIMAL_CORPUS) {
      expect(isPositiveDecimalString(value)).toBe(
        isCanonicalDecimalString(value, { range: "POSITIVE" }),
      );
    }
  });

  it("refuses non-strings, including the numbers §7.3 forbids for economics", () => {
    for (const value of [undefined, null, 0.01, 1, true, {}, [], 1n]) {
      expect(isPositiveDecimalString(value)).toBe(false);
    }
  });

  it("keeps its verdict under an inherited skipChecks, which the schema does not", () => {
    const sample = ["-9", "0", "1.50", "01.5", "1e3"];
    for (const enumerable of [false, true]) {
      const label = enumerable ? "enumerable" : "non-enumerable";
      let schemaFlipped = 0;
      for (const value of sample) {
        expect(PositiveDecimalStringSchema.safeParse(value).success, label).toBe(false);
        const underSkip = withSkipChecks(enumerable, () => ({
          schema: PositiveDecimalStringSchema.safeParse(value).success,
          restated: isPositiveDecimalString(value),
        }));
        if (underSkip.schema) {
          schemaFlipped += 1;
        }
        expect(underSkip.restated, `${label}: ${value}`).toBe(false);
      }
      expect(schemaFlipped, label).toBe(sample.length);
    }
  });
});
