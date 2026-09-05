/**
 * The grammar cross-test: `packages/simulation`'s hand-written validators are
 * bound to the FROZEN `packages/domain` schemas they mirror.
 *
 * WHY THIS SUITE IS THE PRICE OF THE BOUNDARY CHOICE. `packages/simulation`
 * carries no runtime schema library (ADR-020 §3 / `schema-boundary.md` §1's
 * WP-160 route), which closes every measured `zod` class by removing the
 * library — but it also means the package's idea of "a UUIDv7" is its own. If
 * that idea drifted from the frozen contract, the door would be closed against
 * pollution and open against a value the rest of the system would refuse.
 *
 * So each predicate is compared against the real schema over a generated corpus,
 * in BOTH directions: an input the schema accepts and the predicate refuses is a
 * failure, and so is the reverse. Importing `zod` and `packages/domain` here
 * creates no workspace edge — this is the root test tree, where the
 * cross-package suites live (the `WP-190` `ports.test.ts` precedent).
 */

import { describe, expect, it } from "vitest";

import {
  CodeStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  TokenIdSchema,
  UnsignedBigIntStringSchema,
  UuidSchema,
  Uuidv7Schema,
} from "../../../packages/domain/src/index.js";
import {
  isCanonicalUuid,
  isCanonicalUuidV7,
  isCodeString,
  isIsoTimestamp,
  isNonEmptyString,
  isNonNegativeInteger,
  isTokenId,
  isUnsignedIntegerString,
  isoToEpochMilliseconds,
} from "../../../packages/simulation/src/index.js";

/**
 * The frozen schema surface this suite needs.
 *
 * Declared structurally rather than imported from `zod`: `zod` is not a root
 * devDependency (only the packages that own a schema declare it), and importing
 * it here just for a type would add one.
 */
interface SafeParsing {
  safeParse(value: unknown): { readonly success: boolean };
}

function agrees(
  name: string,
  schema: SafeParsing,
  predicate: (value: unknown) => boolean,
  corpus: readonly unknown[],
): void {
  const disagreements: { value: unknown; schema: boolean; predicate: boolean }[] = [];
  for (const value of corpus) {
    const bySchema = schema.safeParse(value).success;
    const byPredicate = predicate(value);
    if (bySchema !== byPredicate) {
      disagreements.push({ value, schema: bySchema, predicate: byPredicate });
    }
  }
  expect(
    disagreements,
    `${name} disagrees with its frozen schema on ${String(disagreements.length)} input(s): ${JSON.stringify(disagreements.slice(0, 5))}`,
  ).toEqual([]);
}

const NON_STRINGS: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  -1,
  1.5,
  Number.NaN,
  true,
  false,
  {},
  [],
  Symbol.iterator,
  10n,
];

describe("hand-written grammars agree with the frozen domain schemas", () => {
  it("UuidSchema", () => {
    const corpus: unknown[] = [
      ...NON_STRINGS,
      "",
      "0190a3e0-0000-7000-8000-000000000001",
      "0190A3E0-0000-7000-8000-000000000001",
      "0190a3e0-0000-0000-8000-000000000001",
      "0190a3e0-0000-9000-8000-000000000001",
      "0190a3e0-0000-7000-c000-000000000001",
      "0190a3e0-0000-7000-8000-00000000000",
      "0190a3e0-0000-7000-8000-0000000000012",
      "0190a3e0_0000_7000_8000_000000000001",
      "NOT-A-UUID",
      " 0190a3e0-0000-7000-8000-000000000001",
    ];
    for (let version = 0; version <= 9; version += 1) {
      for (const variant of ["0", "7", "8", "9", "a", "b", "c", "f"]) {
        corpus.push(`0190a3e0-0000-${String(version)}000-${variant}000-000000000001`);
      }
    }
    agrees("isCanonicalUuid", UuidSchema, isCanonicalUuid, corpus);
    agrees("isCanonicalUuidV7", Uuidv7Schema, isCanonicalUuidV7, corpus);
  });

  it("UnsignedBigIntStringSchema and TokenIdSchema", () => {
    const corpus: unknown[] = [
      ...NON_STRINGS,
      "",
      "0",
      "00",
      "01",
      "1",
      "10",
      "-1",
      "+1",
      "1.0",
      " 1",
      "1 ",
      "1e3",
      "٣",
      "9".repeat(39),
      "9".repeat(40),
      "9".repeat(41),
      "9".repeat(200),
      "9".repeat(201),
    ];
    agrees(
      "isUnsignedIntegerString",
      UnsignedBigIntStringSchema,
      (value) => isUnsignedIntegerString(value),
      corpus,
    );
    agrees("isTokenId", TokenIdSchema, isTokenId, corpus);
  });

  it("CodeStringSchema", () => {
    const corpus: unknown[] = [
      ...NON_STRINGS,
      "",
      "a",
      "A",
      "0a",
      "_a",
      "a_b",
      "a.b",
      "a:b",
      "a-b",
      "a b",
      "a\tb",
      "a\nb",
      "a/b",
      "a+b",
      "ä",
      "a".repeat(64),
      "a".repeat(65),
      "BookSnapshot",
      "polymarket-bot/wal/v1",
    ];
    agrees("isCodeString", CodeStringSchema, isCodeString, corpus);
  });

  it("NonEmptyStringSchema", () => {
    const corpus: unknown[] = [...NON_STRINGS, "", "a", " ", "a".repeat(200), "a".repeat(201)];
    agrees("isNonEmptyString", NonEmptyStringSchema, isNonEmptyString, corpus);
  });

  it("NonNegativeIntegerSchema", () => {
    const corpus: unknown[] = [
      ...NON_STRINGS,
      0,
      1,
      -1,
      2 ** 31,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 2,
      Number.POSITIVE_INFINITY,
      -0,
      0.5,
    ];
    agrees("isNonNegativeInteger", NonNegativeIntegerSchema, isNonNegativeInteger, corpus);
  });

  it("IsoTimestampSchema — shape, calendar, offsets and precision", () => {
    const corpus: unknown[] = [
      ...NON_STRINGS,
      "",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000000001Z",
      "2026-01-01T00:00Z",
      "2026-01-01T00:00:00+01:00",
      "2026-01-01T00:00:00-05:30",
      "2026-01-01T00:00:00+24:00",
      "2026-01-01T00:00:00+23:59",
      "2026-01-01T00:00:00+23:60",
      "2026-01-01T00:00:00",
      "2026-01-01 00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T23:60:00Z",
      "2026-01-01T23:59:60Z",
      "2026-02-29T00:00:00Z",
      "2024-02-29T00:00:00Z",
      "2000-02-29T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-00-01T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "2026-01-32T00:00:00Z",
      "2026-1-01T00:00:00Z",
      "26-01-01T00:00:00Z",
      "2026-01-01T00:00:00.Z",
      "2026-01-01t00:00:00Z",
      "2026-01-01T00:00:00z",
      "+2026-01-01T00:00:00Z",
    ];
    for (let month = 1; month <= 12; month += 1) {
      for (const day of [28, 29, 30, 31]) {
        const mm = String(month).padStart(2, "0");
        const dd = String(day).padStart(2, "0");
        corpus.push(`2026-${mm}-${dd}T12:00:00Z`);
        corpus.push(`2024-${mm}-${dd}T12:00:00Z`);
      }
    }
    agrees("isIsoTimestamp", IsoTimestampSchema, isIsoTimestamp, corpus);
  });
});

describe("isoToEpochMilliseconds is arithmetic, and agrees with an independent oracle", () => {
  /**
   * `Date.parse` is the INDEPENDENT oracle here and is deliberately not used in
   * the implementation: `packages/domain` records that `Date` "silently
   * normalizes and loses the original offset", and reading a clock type inside a
   * replay is exactly what §12.4 forbids. Using it as a test oracle is safe —
   * the test is not a replay — and it is a genuinely different primitive from
   * the implementation's `days_from_civil` arithmetic.
   */
  it("matches Date.parse over a spread of instants, offsets and leap days", () => {
    const samples = [
      "1970-01-01T00:00:00Z",
      "1970-01-01T00:00:00.001Z",
      "1999-12-31T23:59:59.999Z",
      "2000-02-29T12:34:56.789Z",
      "2024-02-29T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "2026-06-29T17:15:57.257Z",
      "2026-12-31T23:59:59Z",
      "2100-03-01T00:00:00Z",
      "2026-01-01T00:00:00+05:45",
      "2026-01-01T00:00:00-11:00",
      "2026-01-01T00:00+00:00",
    ];
    for (const sample of samples) {
      expect(isoToEpochMilliseconds(sample), sample).toBe(Date.parse(sample));
    }
  });

  it("refuses an instant its grammar refuses", () => {
    expect(isoToEpochMilliseconds("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(isoToEpochMilliseconds("not a time")).toBeUndefined();
  });

  it("truncates sub-millisecond precision toward its millisecond", () => {
    expect(isoToEpochMilliseconds("2026-01-01T00:00:00.123456789Z")).toBe(
      Date.parse("2026-01-01T00:00:00.123Z"),
    );
  });
});
