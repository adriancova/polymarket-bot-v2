import { describe, expect, it } from "vitest";

import { instantMilliseconds, isAtOrAfter, isBefore } from "./time.js";

describe("instant comparison", () => {
  it("parses an ISO-8601 instant", () => {
    expect(instantMilliseconds("1970-01-01T00:00:00Z")).toBe(0);
    expect(instantMilliseconds("1970-01-01T00:00:00.001Z")).toBe(1);
  });

  it("returns undefined for a value that is not an instant", () => {
    for (const value of ["", "not-a-timestamp", "2026-13-01T00:00:00Z"]) {
      expect(instantMilliseconds(value)).toBeUndefined();
    }
  });

  it("compares instants, not strings", () => {
    // Same instant, different spellings: a lexicographic comparison would say
    // the offset form is later.
    expect(isBefore("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00Z")).toBe(false);
    expect(isAtOrAfter("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00Z")).toBe(true);
    expect(isBefore("2026-01-01T00:59:59+01:00", "2026-01-01T00:00:00Z")).toBe(true);
  });

  it("propagates unparseable operands as undefined rather than a verdict", () => {
    expect(isBefore("nonsense", "2026-01-01T00:00:00Z")).toBeUndefined();
    expect(isBefore("2026-01-01T00:00:00Z", "nonsense")).toBeUndefined();
    expect(isAtOrAfter("nonsense", "2026-01-01T00:00:00Z")).toBeUndefined();
  });
});
