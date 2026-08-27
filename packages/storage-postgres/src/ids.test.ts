import { describe, expect, it } from "vitest";

import { MAX_UUID_V7_TIMESTAMP_MS, isUuidV7, uuidV7, uuidV7TimestampMs } from "./ids.js";

describe("uuidV7", () => {
  it("produces a lowercase canonical UUIDv7", () => {
    const value = uuidV7();
    expect(isUuidV7(value)).toBe(true);
    expect(value).toBe(value.toLowerCase());
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("encodes the supplied timestamp exactly", () => {
    const timestampMs = Date.UTC(2026, 7, 26, 12, 34, 56, 789);
    expect(uuidV7TimestampMs(uuidV7(timestampMs))).toBe(timestampMs);
  });

  it("sorts lexicographically in timestamp order, which is why §10.7 asks for it", () => {
    const earlier = uuidV7(1_700_000_000_000);
    const later = uuidV7(1_700_000_000_001);
    expect(earlier < later).toBe(true);
  });

  it("is unique across many draws at one instant", () => {
    const fixedInstant = 1_700_000_000_000;
    const values = new Set(Array.from({ length: 1000 }, () => uuidV7(fixedInstant)));
    expect(values.size).toBe(1000);
  });

  it("rejects a timestamp the 48-bit field cannot hold", () => {
    expect(() => uuidV7(MAX_UUID_V7_TIMESTAMP_MS + 1)).toThrow(RangeError);
    expect(() => uuidV7(-1)).toThrow(RangeError);
    expect(() => uuidV7(1.5)).toThrow(RangeError);
  });

  it("accepts the boundary timestamps", () => {
    expect(isUuidV7(uuidV7(0))).toBe(true);
    expect(isUuidV7(uuidV7(MAX_UUID_V7_TIMESTAMP_MS))).toBe(true);
  });
});

describe("isUuidV7", () => {
  it("rejects other UUID versions and non-canonical spellings", () => {
    expect(isUuidV7("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(isUuidV7("018F0000-0000-7000-8000-000000000000")).toBe(false);
    expect(isUuidV7("018f0000-0000-7000-0000-000000000000")).toBe(false);
    expect(isUuidV7("not-a-uuid")).toBe(false);
    expect(isUuidV7("")).toBe(false);
  });
});

describe("uuidV7TimestampMs", () => {
  it("refuses to read a timestamp out of a non-UUIDv7", () => {
    expect(() => uuidV7TimestampMs("00000000-0000-4000-8000-000000000000")).toThrow(TypeError);
  });
});
