/**
 * The strict v1 UTC timestamp grammar and its pure calendar conversion.
 *
 * ORACLE: `Date.UTC` — a DIFFERENT primitive than the implementation's
 * days-from-civil integer arithmetic (`Date` is banned from the package
 * source by the no-wall-clock scan; tests are free to use it as an oracle,
 * and `Date.UTC` is a pure function of its arguments).
 */

import { describe, expect, it } from "vitest";

import { parseUtcTimestamp } from "./time.js";

function oracle(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}

describe("parseUtcTimestamp", () => {
  it("converts the epoch, a modern instant, and millisecond fractions exactly", () => {
    expect(parseUtcTimestamp("1970-01-01T00:00:00Z")).toEqual({ ok: true, epochMs: 0 });
    expect(parseUtcTimestamp("2026-09-03T12:34:56Z")).toEqual({
      ok: true,
      epochMs: oracle(2026, 9, 3, 12, 34, 56),
    });
    expect(parseUtcTimestamp("2026-09-03T12:34:56.789Z")).toEqual({
      ok: true,
      epochMs: oracle(2026, 9, 3, 12, 34, 56, 789),
    });
    expect(parseUtcTimestamp("2026-09-03T12:34:56.7Z")).toEqual({
      ok: true,
      epochMs: oracle(2026, 9, 3, 12, 34, 56, 700),
    });
  });

  it("agrees with the Date.UTC oracle across a broad sweep incl. leap years and month ends", () => {
    const dates: [number, number, number][] = [];
    for (const year of [1583, 1600, 1899, 1900, 1970, 1999, 2000, 2024, 2026, 2100, 2400, 9999]) {
      for (const [month, day] of [
        [1, 1],
        [2, 28],
        [3, 1],
        [6, 30],
        [7, 31],
        [12, 31],
      ] as const) {
        dates.push([year, month, day]);
      }
    }
    // Leap days in leap years only.
    for (const year of [1600, 2000, 2024, 2400]) {
      dates.push([year, 2, 29]);
    }
    for (const [year, month, day] of dates) {
      const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T23:59:59.999Z`;
      const parsed = parseUtcTimestamp(iso);
      expect(parsed, iso).toEqual({ ok: true, epochMs: oracle(year, month, day, 23, 59, 59, 999) });
    }
  });

  it("refuses impossible calendar dates", () => {
    for (const iso of [
      "2026-02-30T00:00:00Z", // February 30th
      "2025-02-29T00:00:00Z", // not a leap year
      "2100-02-29T00:00:00Z", // century non-leap
      "2026-00-01T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-01-00T00:00:00Z",
    ]) {
      expect(parseUtcTimestamp(iso).ok, iso).toBe(false);
    }
  });

  it("refuses impossible times of day and leap seconds", () => {
    for (const iso of ["2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z"]) {
      expect(parseUtcTimestamp(iso).ok, iso).toBe(false);
    }
  });

  it("refuses every non-Z spelling and every out-of-grammar shape", () => {
    for (const value of [
      "2026-09-03T12:34:56", // no designator
      "2026-09-03T12:34:56+00:00", // offset spelling of UTC — one instant, one spelling
      "2026-09-03T12:34:56-05:00",
      "2026-09-03 12:34:56Z", // space separator
      "2026-9-3T12:34:56Z", // unpadded
      "2026-09-03T12:34:56.1234Z", // sub-millisecond precision would truncate
      "2026-09-03T12:34:56.Z",
      "2026-09-03T12:34:56z", // lowercase designator
      "1582-12-31T23:59:59Z", // pre-Gregorian
      "+2026-09-03T12:34:56Z",
      "2026-09-03T12:34:56ZZ",
      "",
    ]) {
      expect(parseUtcTimestamp(value).ok, value).toBe(false);
    }
  });

  it("refuses non-strings without coercion", () => {
    for (const value of [1725364496000, null, undefined, {}, ["2026-09-03T12:34:56Z"], true]) {
      expect(parseUtcTimestamp(value).ok).toBe(false);
    }
  });
});
