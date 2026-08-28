import { describe, expect, it } from "vitest";

import { instantMilliseconds, isAtOrAfter, isBefore, isSameInstant } from "./time.js";

describe("instant comparison", () => {
  it("parses an ISO-8601 instant", () => {
    expect(instantMilliseconds("1970-01-01T00:00:00Z")).toBe(0);
    expect(instantMilliseconds("2026-08-28T12:00:00.500Z")).toBe(
      Date.parse("2026-08-28T12:00:00.500Z"),
    );
  });

  it("returns undefined for a value that is not an instant", () => {
    for (const value of ["", "soon", "2026-13-01T00:00:00Z"]) {
      expect(instantMilliseconds(value)).toBeUndefined();
    }
  });

  it("compares instants, not strings", () => {
    expect(isBefore("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00Z")).toBe(false);
    expect(isAtOrAfter("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00Z")).toBe(true);
    expect(isSameInstant("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00Z")).toBe(true);
  });

  it("propagates unparseable operands rather than guessing", () => {
    expect(isBefore("soon", "2026-01-01T00:00:00Z")).toBeUndefined();
    expect(isBefore("2026-01-01T00:00:00Z", "soon")).toBeUndefined();
    expect(isAtOrAfter("soon", "2026-01-01T00:00:00Z")).toBeUndefined();
  });

  it("falls back to string identity when a value cannot be parsed", () => {
    expect(isSameInstant("soon", "soon")).toBe(true);
    expect(isSameInstant("soon", "later")).toBe(false);
  });
});
