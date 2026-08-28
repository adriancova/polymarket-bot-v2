import { describe, expect, it } from "vitest";

import {
  normalizeLevels,
  readNonNegativeSize,
  readOptionalHash,
  readOptionalPrice,
  readPrice,
  sortLevels,
} from "./fields.js";

describe("readPrice", () => {
  it("canonicalizes and accepts a price inside the unit interval", () => {
    expect(readPrice("0.080", "price")).toEqual({ ok: true, value: "0.08" });
    expect(readPrice("0", "price")).toEqual({ ok: true, value: "0" });
    expect(readPrice("1", "price")).toEqual({ ok: true, value: "1" });
  });

  it("fails loudly on a price outside [0, 1] rather than clamping it", () => {
    // ADR-001 Consequences: "the adapter fails loudly rather than clamping".
    const above = readPrice("1.5", "price");
    expect(above.ok).toBe(false);
    if (!above.ok) expect(above.failure.code).toBe("PRICE_OUT_OF_RANGE");

    const below = readPrice("-0.01", "price");
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.failure.code).toBe("PRICE_OUT_OF_RANGE");
  });

  it("distinguishes an unreadable decimal from an out-of-range one", () => {
    const bad = readPrice("1e-2", "price");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure.code).toBe("INVALID_DECIMAL");
  });
});

describe("readOptionalPrice", () => {
  it("maps every wire form of absence to undefined, never to zero", () => {
    for (const value of ["", null, undefined]) {
      expect(readOptionalPrice(value, "best_bid")).toEqual({ ok: true, value: undefined });
    }
  });
});

describe("readNonNegativeSize", () => {
  it("accepts zero, which at a level means the level is gone", () => {
    expect(readNonNegativeSize("0", "size")).toEqual({ ok: true, value: "0" });
  });

  it("rejects a negative size", () => {
    const result = readNonNegativeSize("-1", "size");
    expect(result.ok).toBe(false);
  });
});

describe("normalizeLevels", () => {
  it("normalizes every level's price and size", () => {
    const result = normalizeLevels(
      [
        { price: "0.070", size: "5000" },
        { price: "0.08", size: "33343.40" },
      ],
      "bids",
    );
    expect(result).toEqual({
      ok: true,
      value: [
        { price: "0.07", size: "5000" },
        { price: "0.08", size: "33343.4" },
      ],
    });
  });

  it("refuses a side that carries one price twice", () => {
    // Two entries at one price make the aggregate depth ambiguous, and a
    // snapshot is what a gap recovery rebuilds from.
    const result = normalizeLevels(
      [
        { price: "0.08", size: "1" },
        { price: "0.080", size: "2" },
      ],
      "bids",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("DUPLICATE_BOOK_LEVEL");
  });

  it("accepts an empty side", () => {
    expect(normalizeLevels([], "asks")).toEqual({ ok: true, value: [] });
  });
});

describe("sortLevels", () => {
  const levels = [
    { price: "0.1", size: "1" },
    { price: "0.07", size: "2" },
    { price: "0.09", size: "3" },
  ];

  it("orders bids descending and asks ascending, whatever the wire order was", () => {
    expect(sortLevels(levels, "desc").map((level) => level.price)).toEqual([
      "0.1",
      "0.09",
      "0.07",
    ]);
    expect(sortLevels(levels, "asc").map((level) => level.price)).toEqual([
      "0.07",
      "0.09",
      "0.1",
    ]);
  });

  it("compares exactly, so 0.1 and 0.09 order correctly as decimals", () => {
    // A lexicographic sort would put "0.1" before "0.09"; a float sort would be
    // correct here but not in general. This is exact decimal comparison.
    expect(sortLevels([{ price: "0.1", size: "1" }, { price: "0.09", size: "1" }], "asc")[0]).toEqual(
      { price: "0.09", size: "1" },
    );
  });

  it("does not mutate its input", () => {
    const input = [...levels];
    sortLevels(input, "desc");
    expect(input).toEqual(levels);
  });
});

describe("readOptionalHash", () => {
  it("carries a non-empty hash and drops every empty form", () => {
    expect(readOptionalHash("0xabc")).toBe("0xabc");
    expect(readOptionalHash("")).toBeUndefined();
    expect(readOptionalHash("   ")).toBeUndefined();
    expect(readOptionalHash(null)).toBeUndefined();
    expect(readOptionalHash(undefined)).toBeUndefined();
  });
});
