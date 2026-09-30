/**
 * `THROUGHPUT-1c` (ADR-023 D5) — projection rule R6 (`feature-projection/v2`):
 * `quality.input_feed_ages@<feedId>` projects that feed's age as a canonical
 * base-10 integer string. Everything v1 projected, v2 projects identically.
 *
 * R6 is new: under v1 the same key fell to R4 and was refused
 * (`SELECTOR_NOT_APPLICABLE`), which is the first test's base-commit failure.
 */

import { computeFeatureSnapshot, type FeatureSnapshot } from "@polymarket-bot/features";
import { describe, expect, it } from "vitest";

import { FEATURE_PROJECTION_VERSION, FEED_AGES_FEATURE_ID, projectFeatureValues } from "./projection.js";

const MARKET_ID = "018f4a7e-1111-7abc-8def-0123456789ab";
const YES_TOKEN = "111";
const EPOCH = "018f4a7e-5555-7abc-8def-0123456789ab";

function snapshot(bookLastEventAt: string, asOf = "2026-03-04T12:00:05.000Z"): FeatureSnapshot {
  const computed = computeFeatureSnapshot({
    subject: { internalMarketId: MARKET_ID, tokenId: YES_TOKEN },
    asOf,
    trigger: { gatewayEpoch: EPOCH, ingestSeq: "2" },
    config: {
      depthLevels: [1],
      executableShares: ["50"],
      tradeWindowMs: 60_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    book: {
      serializedBook: [
        "polymarket-bot/order-book/v1",
        `market ${MARKET_ID}`,
        `token ${YES_TOKEN}`,
        `epoch ${EPOCH}`,
        "generation 1",
        "lastIngestSeq 2",
        "venueBookHash -",
        "tickSize 0.01",
        "bestBid 0.32 200",
        "bestAsk 0.34 200",
        "spread 0.02",
        "depth bids 1 200 asks 1 200",
        "bids 1",
        "0.32 200",
        "asks 1",
        "0.34 200",
      ].join("\n"),
      lastEventAt: bookLastEventAt,
    },
    trades: { lastEventAt: "2026-03-04T12:00:04.000Z", window: [] },
    reference: {},
    quality: { activeIncidents: [] },
  });
  if (!computed.ok) throw new Error(`fixture snapshot refused: ${computed.refusal.code}`);
  return computed.snapshot;
}

describe("projection rule R6 — one feed's age (feature-projection/v2)", () => {
  it("is version 2", () => {
    expect(FEATURE_PROJECTION_VERSION).toBe("polymarket-bot/trader/feature-projection/v2");
    expect(FEED_AGES_FEATURE_ID).toBe("quality.input_feed_ages");
  });

  it("projects the book feed's age as an integer string", () => {
    const projected = projectFeatureValues(snapshot("2026-03-04T12:00:03.750Z"), [
      "quality.input_feed_ages@polymarket.book",
      "quality.input_feed_ages@polymarket.trades",
    ]);
    expect(projected.refusals).toEqual([]);
    expect(projected.values["quality.input_feed_ages@polymarket.book"]).toBe("1250");
    expect(projected.values["quality.input_feed_ages@polymarket.trades"]).toBe("1000");
  });

  it("projects a zero and a negative age canonically (a stamp after asOf is reported as-is)", () => {
    const zero = projectFeatureValues(snapshot("2026-03-04T12:00:05.000Z"), ["quality.input_feed_ages@polymarket.book"]);
    expect(zero.values["quality.input_feed_ages@polymarket.book"]).toBe("0");
    const negative = projectFeatureValues(snapshot("2026-03-04T12:00:05.020Z"), ["quality.input_feed_ages@polymarket.book"]);
    expect(negative.values["quality.input_feed_ages@polymarket.book"]).toBe("-20");
  });

  it("refuses a feed the snapshot carries no age for, and writes no value", () => {
    const projected = projectFeatureValues(snapshot("2026-03-04T12:00:03.750Z"), [
      "quality.input_feed_ages@reference.binance",
    ]);
    expect(projected.refusals.map((refusal) => refusal.reason)).toEqual(["SELECTOR_NAMES_NO_MEMBER"]);
    expect(Object.hasOwn(projected.values, "quality.input_feed_ages@reference.binance")).toBe(false);
  });

  it("without a selector the list is still refused (R1: not a scalar)", () => {
    const projected = projectFeatureValues(snapshot("2026-03-04T12:00:03.750Z"), ["quality.input_feed_ages"]);
    expect(projected.refusals.map((refusal) => refusal.reason)).toEqual(["VALUE_NOT_SCALAR"]);
  });
});
