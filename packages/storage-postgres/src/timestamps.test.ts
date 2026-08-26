import { describe, expect, it } from "vitest";

import { InvalidTimestampError } from "./errors.js";
import { assertIsoTimestamp, isIsoTimestamp, pgTimestampToIso } from "./timestamps.js";

describe("pgTimestampToIso", () => {
  it("converts a UTC timestamptz rendering", () => {
    expect(pgTimestampToIso("2026-08-26 12:00:00+00")).toBe("2026-08-26T12:00:00Z");
  });

  it("preserves microsecond precision, which a Date would truncate", () => {
    expect(pgTimestampToIso("2026-08-26 12:00:00.123456+00")).toBe("2026-08-26T12:00:00.123456Z");
  });

  it("accepts a timestamp without a zone (rendered by `timestamp` columns)", () => {
    expect(pgTimestampToIso("2026-08-26 12:00:00.5")).toBe("2026-08-26T12:00:00.5Z");
  });

  it("rejects a non-UTC offset rather than guessing a zone", () => {
    expect(() => pgTimestampToIso("2026-08-26 12:00:00+02")).toThrow(InvalidTimestampError);
    expect(() => pgTimestampToIso("2026-08-26 12:00:00-05:30")).toThrow(InvalidTimestampError);
  });

  it("rejects a non-ISO DateStyle rendering", () => {
    expect(() => pgTimestampToIso("08/26/2026 12:00:00")).toThrow(InvalidTimestampError);
    expect(() => pgTimestampToIso("Wed Aug 26 12:00:00 2026")).toThrow(InvalidTimestampError);
    expect(() => pgTimestampToIso("")).toThrow(InvalidTimestampError);
  });
});

describe("isIsoTimestamp", () => {
  it("accepts ISO-8601 instants with an explicit offset", () => {
    expect(isIsoTimestamp("2026-08-26T12:00:00Z")).toBe(true);
    expect(isIsoTimestamp("2026-08-26T12:00:00.123456Z")).toBe(true);
    expect(isIsoTimestamp("2026-08-26T12:00:00+02:00")).toBe(true);
  });

  it("rejects an instant with no offset, and other malformed values", () => {
    expect(isIsoTimestamp("2026-08-26T12:00:00")).toBe(false);
    expect(isIsoTimestamp("2026-08-26 12:00:00Z")).toBe(false);
    expect(isIsoTimestamp("2026-13-26T12:00:00Z")).toBe(false);
    expect(isIsoTimestamp("yesterday")).toBe(false);
  });
});

describe("assertIsoTimestamp", () => {
  it("returns the value unchanged when it is valid", () => {
    expect(assertIsoTimestamp("2026-08-26T12:00:00Z")).toBe("2026-08-26T12:00:00Z");
  });

  it("throws a typed error otherwise", () => {
    expect(() => assertIsoTimestamp("2026-08-26")).toThrow(InvalidTimestampError);
  });
});
