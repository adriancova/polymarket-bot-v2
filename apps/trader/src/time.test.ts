/**
 * Strict-UTC normalisation — `WP-220` composition-root obligation 1.
 *
 * The split of responsibility this file tests: the STRATEGY refuses an offset
 * form (it has no authority to invent a conversion rule), and the ROOT converts
 * one, exactly once, here. Both halves matter, and getting them backwards is a
 * silent defect: a root that passed an offset through would make the strategy
 * refuse every evaluation, and a strategy that converted one would compare two
 * instants that print differently and are equal.
 */

import { describe, expect, it } from "vitest";

import { formatStrictUtc, isStrictUtcInstant, normalizeToStrictUtc, strictUtcEpochMs } from "./time.js";

describe("isStrictUtcInstant", () => {
  it.each([
    "2026-03-04T12:00:00Z",
    "2026-03-04T12:00:00.123Z",
    "1970-01-01T00:00:00Z",
  ])("accepts the canonical form %s", (value) => {
    expect(isStrictUtcInstant(value)).toBe(true);
  });

  it.each([
    "2026-03-04T12:00:00+01:00",
    "2026-03-04T12:00:00",
    "2026-03-04T12:00:00.123456Z",
    "2026-03-04 12:00:00Z",
    "",
    "yesterday",
  ])("refuses %s", (value) => {
    expect(isStrictUtcInstant(value)).toBe(false);
  });

  it("refuses a non-string without throwing", () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(isStrictUtcInstant(value)).toBe(false);
    }
  });
});

describe("normalizeToStrictUtc", () => {
  it("CONVERTS an offset instant — the root's job, not the strategy's", () => {
    const result = normalizeToStrictUtc("2026-03-04T13:00:00+01:00");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instant).toBe("2026-03-04T12:00:00Z");
    expect(result.epochMs).toBe(Date.parse("2026-03-04T12:00:00Z"));
  });

  it("converts a NEGATIVE offset too", () => {
    const result = normalizeToStrictUtc("2026-03-04T07:00:00-05:00");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instant).toBe("2026-03-04T12:00:00Z");
  });

  it("keeps milliseconds when they are non-zero and drops them when they are zero", () => {
    const withMillis = normalizeToStrictUtc("2026-03-04T12:00:00.250Z");
    expect(withMillis.ok && withMillis.instant).toBe("2026-03-04T12:00:00.250Z");
    const withoutMillis = normalizeToStrictUtc("2026-03-04T12:00:00.000Z");
    expect(withoutMillis.ok && withoutMillis.instant).toBe("2026-03-04T12:00:00Z");
  });

  it("REFUSES sub-millisecond precision rather than TRUNCATING it", () => {
    const result = normalizeToStrictUtc("2026-03-04T12:00:00.123456789Z");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("REFUSES rather than truncates");
    expect(result.problem).toContain("§8.4");
  });

  it("REFUSES an out-of-range calendar or clock field rather than rolling it over", () => {
    for (const value of [
      "2026-13-04T12:00:00Z",
      "2026-03-32T12:00:00Z",
      "2026-03-04T25:00:00Z",
      "2026-03-04T12:61:00Z",
    ]) {
      const result = normalizeToStrictUtc(value);
      expect(result.ok, value).toBe(false);
    }
  });

  it("REFUSES a day that does not exist rather than repairing it", () => {
    // `Date.parse("2026-02-30")` answers March 2nd. A silent repair here would
    // turn a malformed instant into a real one nobody wrote.
    const result = normalizeToStrictUtc("2026-02-30T12:00:00Z");
    expect(result.ok).toBe(false);
  });

  it("REFUSES a value with no explicit zone — §7.1 instants carry one", () => {
    expect(normalizeToStrictUtc("2026-03-04T12:00:00").ok).toBe(false);
  });

  it("REFUSES a non-string, naming the type", () => {
    const result = normalizeToStrictUtc(42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("number");
  });

  it("is TOTAL: nothing throws", () => {
    for (const value of [undefined, null, 42, {}, [], "", "x".repeat(500)]) {
      expect(() => normalizeToStrictUtc(value)).not.toThrow();
    }
  });

  it("round-trips: every accepted value normalises to a value it accepts", () => {
    for (const value of [
      "2026-03-04T12:00:00Z",
      "2026-03-04T13:00:00+01:00",
      "2026-03-04T12:00:00.250Z",
      "1970-01-01T00:00:00Z",
    ]) {
      const first = normalizeToStrictUtc(value);
      expect(first.ok, value).toBe(true);
      if (!first.ok) continue;
      const second = normalizeToStrictUtc(first.instant);
      expect(second.ok && second.instant).toBe(first.instant);
    }
  });
});

describe("formatStrictUtc / strictUtcEpochMs", () => {
  it("are inverses on the canonical form", () => {
    const epochMs = Date.parse("2026-03-04T12:34:56.789Z");
    expect(formatStrictUtc(epochMs)).toBe("2026-03-04T12:34:56.789Z");
    expect(strictUtcEpochMs("2026-03-04T12:34:56.789Z")).toBe(epochMs);
  });

  it("strictUtcEpochMs refuses a non-canonical spelling", () => {
    expect(strictUtcEpochMs("2026-03-04T13:34:56+01:00")).toBeUndefined();
  });
});
