import { describe, expect, it } from "vitest";

import { MarketIdentitySchema, isSameMarketIdentity } from "./identity.js";
import { marketIdentitySample } from "./testing/index.js";

describe("MarketIdentitySchema", () => {
  it("accepts the sample identity", () => {
    expect(MarketIdentitySchema.safeParse(marketIdentitySample()).success).toBe(true);
  });

  it("requires a UUIDv7 internal market id (§7.2)", () => {
    for (const internalMarketId of [
      "not-a-uuid",
      "018F3A5C-1111-7000-8000-000000000001",
      "018f3a5c-1111-4000-8000-000000000001",
    ]) {
      expect(
        MarketIdentitySchema.safeParse({ ...marketIdentitySample(), internalMarketId }).success,
      ).toBe(false);
    }
  });

  it("requires canonical unsigned-integer token ids", () => {
    for (const yesTokenId of ["0100", "-1", "1.5", "0x1f", ""]) {
      expect(
        MarketIdentitySchema.safeParse({ ...marketIdentitySample(), yesTokenId }).success,
      ).toBe(false);
    }
  });

  it("refuses one token standing for both outcomes", () => {
    const identity = marketIdentitySample();
    const result = MarketIdentitySchema.safeParse({
      ...identity,
      noTokenId: identity.yesTokenId,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(
      MarketIdentitySchema.safeParse({ ...marketIdentitySample(), rawMetadata: {} }).success,
    ).toBe(false);
  });

  it("treats the venue event id and slug as optional", () => {
    const identity: Record<string, unknown> = { ...marketIdentitySample() };
    delete identity["venueEventId"];
    delete identity["venueMarketSlug"];
    delete identity["questionTitle"];
    expect(MarketIdentitySchema.safeParse(identity).success).toBe(true);
  });
});

describe("isSameMarketIdentity", () => {
  it("compares the venue identity, not the descriptive text", () => {
    const identity = marketIdentitySample();
    expect(
      isSameMarketIdentity(identity, { ...identity, questionTitle: "reworded question" }),
    ).toBe(true);
    expect(isSameMarketIdentity(identity, { ...identity, conditionId: "0xother" })).toBe(false);
    expect(isSameMarketIdentity(identity, { ...identity, yesTokenId: "9" })).toBe(false);
    expect(isSameMarketIdentity(identity, { ...identity, venueEventId: "other-event" })).toBe(
      false,
    );
  });
});
