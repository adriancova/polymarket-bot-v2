/**
 * The v1 registry: complete against the §9.5 minimum list, versioned,
 * unique, sorted, and immutable.
 */

import { describe, expect, it } from "vitest";

import { FEATURES_V1, FEATURE_IDS_V1, FEATURE_SET_VERSION, featureDefinition } from "./registry.js";

/**
 * The §9.5 minimum feature list, spelled out BY HAND as the oracle. If the
 * registry and this list disagree, one of them is wrong and the disagreement
 * must be resolved by reading the handoff, not by editing whichever is
 * closer.
 */
const EXPECTED_IDS = [
  // Polymarket
  "polymarket.best_bid",
  "polymarket.best_ask",
  "polymarket.midpoint",
  "polymarket.spread",
  "polymarket.depth_at_levels",
  "polymarket.executable_buy_price",
  "polymarket.executable_sell_price",
  "polymarket.order_book_imbalance",
  "polymarket.microprice",
  "polymarket.recent_trades",
  // External: returns 250ms/1s/5s/30s per venue
  "reference.binance.return_250ms",
  "reference.binance.return_1s",
  "reference.binance.return_5s",
  "reference.binance.return_30s",
  "reference.coinbase.return_250ms",
  "reference.coinbase.return_1s",
  "reference.coinbase.return_5s",
  "reference.coinbase.return_30s",
  // External: cross-venue
  "reference.cross_venue.midpoint_difference",
  "reference.cross_venue.direction_agreement_250ms",
  "reference.cross_venue.direction_agreement_1s",
  "reference.cross_venue.direction_agreement_5s",
  "reference.cross_venue.direction_agreement_30s",
  // External: volatility and TWAP
  "reference.binance.ewma_realized_volatility",
  "reference.coinbase.ewma_realized_volatility",
  "reference.chainlink.twap_30s",
  "reference.chainlink.twap_60s",
  // Lifecycle
  "lifecycle.time_to_close_ms",
  "lifecycle.time_since_open_ms",
  "lifecycle.market_duration_ms",
  "lifecycle.reference_open_distance",
  // Quality
  "quality.input_feed_ages",
  "quality.active_incidents",
] as const;

describe("the v1 feature registry", () => {
  it("is versioned as polymarket-bot/features/v1", () => {
    expect(FEATURE_SET_VERSION).toBe("polymarket-bot/features/v1");
  });

  it("contains EXACTLY the §9.5 minimum feature set (33 features), nothing more, nothing less", () => {
    expect(EXPECTED_IDS).toHaveLength(33);
    expect([...FEATURE_IDS_V1].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("is sorted by id, and every definition carries version 1 and a real category", () => {
    expect(FEATURE_IDS_V1).toEqual([...FEATURE_IDS_V1].sort());
    for (const definition of FEATURES_V1) {
      expect(definition.version).toBe(1);
      expect(["polymarket", "reference", "lifecycle", "quality"]).toContain(definition.category);
      expect(definition.description.length).toBeGreaterThan(10);
      const [prefix] = definition.id.split(".");
      // Category and id prefix agree (reference features live under `reference.`).
      expect(prefix).toBe(definition.category === "reference" ? "reference" : definition.category);
    }
  });

  it("looks definitions up by id and answers undefined for unknown ids", () => {
    const midpoint = featureDefinition("polymarket.midpoint");
    expect(midpoint?.category).toBe("polymarket");
    expect(featureDefinition("polymarket.not_a_feature")).toBeUndefined();
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(FEATURES_V1)).toBe(true);
    for (const definition of FEATURES_V1) {
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });
});
