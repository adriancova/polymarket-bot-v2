import { describe, expect, it } from "vitest";

import {
  normalizeVenueConditionId,
  normalizeVenueDecimal,
  normalizeVenueInstant,
  normalizeVenueSide,
  normalizeVenueTokenId,
  requireVenueDecimal,
} from "./values.js";

describe("normalizeVenueDecimal", () => {
  it("collapses every wire spelling of absence to ABSENT", () => {
    // ADR-001 §8.1: the websocket serializes an absent optional decimal as "",
    // the SDK declares these fields `.nullish()`, and a key may simply be
    // missing. Past this boundary all three are one fact.
    for (const value of [undefined, null, ""]) {
      expect(normalizeVenueDecimal(value)).toEqual({ status: "absent" });
    }
  });

  it("never substitutes zero for an absent value", () => {
    const absent = normalizeVenueDecimal("");
    expect(absent).not.toEqual({ status: "ok", value: "0" });
  });

  it("canonicalizes the non-canonical spellings the venue actually publishes", () => {
    // The official order-book example prints "last_trade_price": "0.090".
    expect(normalizeVenueDecimal("0.090")).toEqual({ status: "ok", value: "0.09" });
    expect(normalizeVenueDecimal("01.5")).toEqual({ status: "ok", value: "1.5" });
    expect(normalizeVenueDecimal("+1.5")).toEqual({ status: "ok", value: "1.5" });
    expect(normalizeVenueDecimal("1.")).toEqual({ status: "ok", value: "1" });
    expect(normalizeVenueDecimal(".5")).toEqual({ status: "ok", value: "0.5" });
    expect(normalizeVenueDecimal("-0.00")).toEqual({ status: "ok", value: "0" });
  });

  it("passes an already-canonical value through unchanged", () => {
    expect(normalizeVenueDecimal("33343.4")).toEqual({ status: "ok", value: "33343.4" });
    expect(normalizeVenueDecimal("0")).toEqual({ status: "ok", value: "0" });
  });

  it("rejects spellings that are not decimals at all", () => {
    for (const value of ["1e5", "NaN", "Infinity", " 1", "1 ", "1,5", "0x1f", "abc"]) {
      expect(normalizeVenueDecimal(value).status, value).toBe("invalid");
    }
  });

  it("accepts the JSON-number form the SDK's DecimalishSchema accepts", () => {
    // ADR-002 §7 / ADR-001 §8.2. The market channel types every decimal as a
    // string, so this branch serves Gamma-shaped input; the obligation is
    // discharged by one implementation rather than two.
    expect(normalizeVenueDecimal(100)).toEqual({ status: "ok", value: "100" });
    expect(normalizeVenueDecimal(0.5)).toEqual({ status: "ok", value: "0.5" });
  });

  it("rejects a number JavaScript prints in exponential form rather than expanding it", () => {
    expect(normalizeVenueDecimal(1e21).status).toBe("invalid");
    expect(normalizeVenueDecimal(5e-7).status).toBe("invalid");
    expect(normalizeVenueDecimal(Number.NaN).status).toBe("invalid");
    expect(normalizeVenueDecimal(Number.POSITIVE_INFINITY).status).toBe("invalid");
  });

  it("rejects a non-string, non-number value", () => {
    expect(normalizeVenueDecimal(true).status).toBe("invalid");
    expect(normalizeVenueDecimal({}).status).toBe("invalid");
  });
});

describe("requireVenueDecimal", () => {
  it("turns absence into a named failure instead of a hole", () => {
    const result = requireVenueDecimal("", "price");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("price");
    }
  });
});

describe("normalizeVenueInstant", () => {
  it("reads a digit string as epoch milliseconds", () => {
    // `EpochMillisecondsStringSchema` is what every market-channel timestamp uses.
    expect(normalizeVenueInstant("1782753357257")).toEqual({
      status: "ok",
      value: "2026-06-29T17:15:57.257Z",
    });
  });

  it("reads an integer number with the SDK's seconds-versus-milliseconds rule", () => {
    expect(normalizeVenueInstant(1782753357257)).toEqual({
      status: "ok",
      value: "2026-06-29T17:15:57.257Z",
    });
    // Below 1_000_000_000_000 the SDK multiplies by 1000.
    expect(normalizeVenueInstant(1782753357)).toEqual({
      status: "ok",
      value: "2026-06-29T17:15:57.000Z",
    });
  });

  it("accepts the date-like string form the SDK also accepts", () => {
    expect(normalizeVenueInstant("2026-06-29T17:15:57.257000Z")).toEqual({
      status: "ok",
      value: "2026-06-29T17:15:57.257Z",
    });
    expect(normalizeVenueInstant("2026-06-29")).toEqual({
      status: "ok",
      value: "2026-06-29T00:00:00.000Z",
    });
  });

  it("treats null and absence as absent, per the SDK's .nullish() declaration", () => {
    expect(normalizeVenueInstant(null)).toEqual({ status: "absent" });
    expect(normalizeVenueInstant(undefined)).toEqual({ status: "absent" });
  });

  it("reports an unusable timestamp instead of throwing inside the message loop", () => {
    expect(normalizeVenueInstant("not-a-date").status).toBe("invalid");
    expect(normalizeVenueInstant(1.5).status).toBe("invalid");
    expect(normalizeVenueInstant(1e18).status).toBe("invalid");
  });
});

describe("normalizeVenueTokenId", () => {
  it("accepts the canonical unsigned integer form", () => {
    const value = "107505882767731489358349912513945399560393482969656700824895970500493757150417";
    expect(normalizeVenueTokenId(value)).toEqual({ status: "ok", value });
  });

  it("strips redundant leading zeros, as adapters do for decimals", () => {
    expect(normalizeVenueTokenId("0007")).toEqual({ status: "ok", value: "7" });
    expect(normalizeVenueTokenId("000")).toEqual({ status: "ok", value: "0" });
  });

  it("reports a token id that is not an unsigned integer", () => {
    for (const value of ["", "-1", "1.5", "0x1f", "abc"]) {
      const result = normalizeVenueTokenId(value);
      if (value === "") {
        expect(result).toEqual({ status: "absent" });
      } else {
        expect(result.status, value).toBe("invalid");
      }
    }
  });
});

describe("normalizeVenueConditionId", () => {
  it("accepts a 32-byte hex condition id", () => {
    const value = `0x${"a".repeat(64)}`;
    expect(normalizeVenueConditionId(value)).toEqual({ status: "ok", value });
  });

  it("accepts a 31-byte hex condition id, which the fixture catalogue narrows away", () => {
    // ADR-002 §7: `ConditionIdResponseSchema` "validates hex syntax without
    // constraining the condition ID byte length".
    const value = `0x${"b".repeat(62)}`;
    expect(normalizeVenueConditionId(value)).toEqual({ status: "ok", value });
  });

  it("accepts a hex condition id of any other length up to the domain bound", () => {
    for (const value of ["0x00", `0x${"c".repeat(40)}`, `0x${"d".repeat(128)}`]) {
      expect(normalizeVenueConditionId(value), value).toEqual({ status: "ok", value });
    }
  });

  it("states its ACTUAL boundary: 200 characters accepted, 201 rejected", () => {
    // Round-1 finding M2. This bound is `packages/domain`'s frozen
    // `ConditionIdSchema` (`MAX_IDENTIFIER_LENGTH`), not a venue fact and not
    // the fixture catalogue's 31/32-byte narrowing, and it is NOT what
    // `docs/contracts/protected-contracts.md` §9 describes. Asserting the exact
    // boundary is how this package stops claiming "any length".
    const atBound = `0x${"e".repeat(198)}`;
    expect(atBound).toHaveLength(200);
    expect(normalizeVenueConditionId(atBound)).toEqual({ status: "ok", value: atBound });

    const pastBound = `${atBound}e`;
    expect(pastBound).toHaveLength(201);
    expect(normalizeVenueConditionId(pastBound)).toEqual({
      status: "invalid",
      reason: "condition id exceeds 200 characters",
    });
  });

  it("reports an over-long value rather than throwing", () => {
    expect(() => normalizeVenueConditionId(`0x${"e".repeat(400)}`)).not.toThrow();
    expect(normalizeVenueConditionId(`0x${"e".repeat(400)}`).status).toBe("invalid");
  });
});

describe("normalizeVenueSide", () => {
  it("maps the documented enumeration onto the domain's book sides", () => {
    expect(normalizeVenueSide("BUY")).toEqual({ status: "ok", value: "BID" });
    expect(normalizeVenueSide("SELL")).toEqual({ status: "ok", value: "ASK" });
  });

  it("upper-cases first, as the SDK's NormalizedOrderSideSchema does", () => {
    expect(normalizeVenueSide("buy")).toEqual({ status: "ok", value: "BID" });
    expect(normalizeVenueSide("Sell")).toEqual({ status: "ok", value: "ASK" });
  });

  it("treats an unrecognized value as UNKNOWN rather than defaulting", () => {
    const result = normalizeVenueSide("SHORT");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("SHORT");
    }
  });
});
