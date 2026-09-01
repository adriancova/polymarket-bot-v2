import { describe, expect, it } from "vitest";

import type { MarketConfig } from "./config.js";
import { UniverseMarketDirectory } from "./directory.js";
import { GatewayConfigurationError } from "./errors.js";
import { ManualGatewayClock } from "./testing/index.js";

const MARKET: MarketConfig = {
  internalMarketId: "01990000-0000-7000-8000-000000000001",
  conditionId: "0x" + "ab".repeat(31),
  yesTokenId: "11111",
  noTokenId: "22222",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
  },
  observedAt: "2026-08-30T12:00:00.000Z",
};

describe("UniverseMarketDirectory", () => {
  it("resolves both outcome tokens to the configured identity", () => {
    const directory = new UniverseMarketDirectory([MARKET], new ManualGatewayClock());
    for (const tokenId of ["11111", "22222"]) {
      const identity = directory.identityForToken(tokenId);
      expect(identity?.internalMarketId).toBe(MARKET.internalMarketId);
      expect(identity?.conditionId).toBe(MARKET.conditionId);
      expect(identity?.yesTokenId).toBe("11111");
      expect(identity?.noTokenId).toBe("22222");
    }
    expect(directory.identityForToken("99999")).toBeUndefined();
  });

  // §9.2: "a new market pattern is not auto-approved" — announcements are
  // observed and declined, never adopted by heuristic (the venue documents no
  // outcome/token pairing rule, so YES/NO cannot be decided here).
  it("declines wire-announced markets and retains the observation", () => {
    const directory = new UniverseMarketDirectory([MARKET], new ManualGatewayClock());
    const observation = {
      venueMarketId: "mkt-1",
      conditionId: "0x" + "ee".repeat(31),
      tokenIds: ["55555", "66666"],
      outcomes: ["Yes", "No"],
    };
    expect(directory.registerDiscoveredMarket(observation)).toBeUndefined();
    expect(directory.declinedRegistrations).toHaveLength(1);
    expect(directory.metrics().declinedRegistrations).toBe(1);
    // Still not resolvable afterwards.
    expect(directory.identityForToken("55555")).toBeUndefined();
  });

  // §6 invariant 9 / ADR-002 §6: the catalogue versions parameters; the
  // returned ordinal and ref come from WP-110's own history, never invented.
  it("versions an observed tick-size change through the universe registry", () => {
    const directory = new UniverseMarketDirectory([MARKET], new ManualGatewayClock());
    const identity = directory.identityForToken("11111");
    expect(identity).toBeDefined();
    if (identity === undefined) return;
    const assignment = directory.assignTradingParameterVersion({
      identity,
      tokenId: "11111",
      previousTickSize: "0.01",
      tickSize: "0.001",
      observedAt: "2026-08-30T12:01:00.000Z",
    });
    expect(assignment).toBeDefined();
    expect(assignment?.parametersVersion).toBe(2);
    expect(assignment?.previousParametersVersion).toBe(1);
    expect(assignment?.parameterVersionRef).toBe(`${MARKET.internalMarketId}/v2`);
    expect(directory.metrics().parameterVersionsAssigned).toBe(1);
  });

  it("declines a no-op parameter change (the catalogue refuses it) rather than inventing a version", () => {
    const directory = new UniverseMarketDirectory([MARKET], new ManualGatewayClock());
    const identity = directory.identityForToken("11111");
    if (identity === undefined) return;
    const assignment = directory.assignTradingParameterVersion({
      identity,
      tokenId: "11111",
      tickSize: "0.01", // unchanged
      observedAt: "2026-08-30T12:01:00.000Z",
    });
    expect(assignment).toBeUndefined();
    expect(directory.metrics().parameterAssignmentsDeclined).toBe(1);
  });

  it("declines a change for an unknown token", () => {
    const directory = new UniverseMarketDirectory([MARKET], new ManualGatewayClock());
    const assignment = directory.assignTradingParameterVersion({
      identity: {
        internalMarketId: "01990000-0000-7000-8000-00000000ffff",
        conditionId: "0xff",
        yesTokenId: "77777",
        noTokenId: "88888",
      },
      tokenId: "77777",
      tickSize: "0.001",
    });
    expect(assignment).toBeUndefined();
  });

  it("fails loudly at construction when configured markets conflict", () => {
    const conflicting: MarketConfig = {
      ...MARKET,
      internalMarketId: "01990000-0000-7000-8000-000000000002",
      // Same condition id as MARKET — the universe registry refuses it.
    };
    expect(
      () => new UniverseMarketDirectory([MARKET, conflicting], new ManualGatewayClock()),
    ).toThrow(GatewayConfigurationError);
  });
});
