import { describe, expect, it } from "vitest";

import {
  BookSideSchema,
  ConditionIdSchema,
  InternalMarketIdSchema,
  OutcomeSideSchema,
  TokenIdSchema,
  UuidSchema,
  Uuidv7Schema,
  VenueOrderIdSchema,
} from "./identifiers.js";
import { MAX_IDENTIFIER_LENGTH } from "./primitives.js";
import { SAMPLE_CONDITION_ID, SAMPLE_MARKET_ID, SAMPLE_YES_TOKEN_ID } from "./testing/samples.js";

describe("canonical identifiers (handoff §7.2)", () => {
  it("accepts a lowercase UUIDv7 internal market id", () => {
    expect(InternalMarketIdSchema.parse(SAMPLE_MARKET_ID)).toBe(SAMPLE_MARKET_ID);
    expect(Uuidv7Schema.safeParse("018f3a5c-9b7e-7c3d-8f21-6b0f9a2c4d1e").success).toBe(true);
  });

  it("rejects non-v7 UUIDs, uppercase, and malformed values for market ids", () => {
    for (const value of [
      "9f1b6b1e-1c4a-4f8e-8b3a-2c5d7e9f0a1b",
      "018F3A5C-9B7E-7C3D-8F21-6B0F9A2C4D1E",
      "018f3a5c9b7e7c3d8f216b0f9a2c4d1e",
      "018f3a5c-9b7e-7c3d-cf21-6b0f9a2c4d1e",
      "",
      "market-1",
    ]) {
      expect(InternalMarketIdSchema.safeParse(value).success).toBe(false);
    }
    expect(InternalMarketIdSchema.safeParse(1).success).toBe(false);
  });

  it("accepts any lowercase UUID version for a gateway epoch", () => {
    expect(UuidSchema.safeParse("9f1b6b1e-1c4a-4f8e-8b3a-2c5d7e9f0a1b").success).toBe(true);
    expect(UuidSchema.safeParse("018f3a5c-9b7e-7c3d-8f21-6b0f9a2c4d1e").success).toBe(true);
    expect(UuidSchema.safeParse("00000000-0000-0000-0000-000000000000").success).toBe(false);
  });

  it("treats a token id as a canonical unsigned integer string", () => {
    expect(TokenIdSchema.parse(SAMPLE_YES_TOKEN_ID)).toBe(SAMPLE_YES_TOKEN_ID);
    expect(TokenIdSchema.safeParse("0").success).toBe(true);
    for (const value of ["0123", "-1", "1.5", "1e5", "0xabc", "", " 1"]) {
      expect(TokenIdSchema.safeParse(value).success).toBe(false);
    }
    expect(TokenIdSchema.safeParse(12_345).success).toBe(false);
    expect(TokenIdSchema.safeParse(12_345n).success).toBe(false);
  });

  it("keeps venue identifiers opaque but bounded", () => {
    expect(ConditionIdSchema.parse(SAMPLE_CONDITION_ID)).toBe(SAMPLE_CONDITION_ID);
    expect(VenueOrderIdSchema.safeParse("0xdeadbeef").success).toBe(true);
    expect(ConditionIdSchema.safeParse("").success).toBe(false);
    expect(ConditionIdSchema.safeParse("x".repeat(MAX_IDENTIFIER_LENGTH)).success).toBe(true);
    expect(ConditionIdSchema.safeParse("x".repeat(MAX_IDENTIFIER_LENGTH + 1)).success).toBe(false);
    expect(ConditionIdSchema.safeParse(1).success).toBe(false);
  });

  it("enumerates outcome and book sides", () => {
    expect(OutcomeSideSchema.options).toEqual(["YES", "NO"]);
    expect(BookSideSchema.options).toEqual(["BID", "ASK"]);
    expect(OutcomeSideSchema.safeParse("yes").success).toBe(false);
    expect(BookSideSchema.safeParse("BUY").success).toBe(false);
  });
});
