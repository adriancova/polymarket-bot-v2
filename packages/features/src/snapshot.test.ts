/**
 * The engine end-to-end over the hand-computed fixture: values, absence
 * semantics, registry binding, content addressing, immutability, refusals,
 * and totality.
 *
 * Every expected number below was derived BY HAND from the fixture (see
 * `testing/fixture.ts`); none is a recording of the implementation's output.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FEATURE_IDS_V1 } from "./registry.js";
import {
  CONTENT_ADDRESS_DOMAIN,
  computeFeatureSnapshot,
  selectIndexedValues,
  snapshotReference,
  verifySnapshotSerialization,
} from "./snapshot.js";
import type { FeatureEntry, FeatureSnapshot } from "./snapshot.js";
import { FIXTURE_EPOCH, FIXTURE_MARKET, FIXTURE_TOKEN, fixtureBookText, fixtureInput } from "./testing/fixture.js";

function computeOk(input: unknown): { snapshot: FeatureSnapshot; serialization: string } {
  const result = computeFeatureSnapshot(input);
  if (!result.ok) {
    throw new Error(`expected success, got ${result.refusal.code}: ${result.refusal.message}`);
  }
  return { snapshot: result.snapshot, serialization: result.serialization };
}

function entry(snapshot: FeatureSnapshot, id: string): FeatureEntry {
  const found = snapshot.features.find((feature) => feature.id === id);
  if (found === undefined) throw new Error(`no entry for ${id}`);
  return found;
}

function value(snapshot: FeatureSnapshot, id: string): unknown {
  const found = entry(snapshot, id);
  expect(found.status, id).toBe("OK");
  return found.value;
}

describe("computeFeatureSnapshot on the full fixture", () => {
  const { snapshot, serialization } = computeOk(fixtureInput());

  it("carries every registered feature exactly once, in registry order", () => {
    expect(snapshot.features.map((feature) => feature.id)).toEqual([...FEATURE_IDS_V1]);
  });

  it("computes the book features (hand-derived)", () => {
    expect(value(snapshot, "polymarket.best_bid")).toEqual({ price: "0.48", size: "100" });
    expect(value(snapshot, "polymarket.best_ask")).toEqual({ price: "0.52", size: "80" });
    expect(value(snapshot, "polymarket.midpoint")).toBe("0.5");
    expect(value(snapshot, "polymarket.spread")).toBe("0.04");
    expect(value(snapshot, "polymarket.depth_at_levels")).toEqual([
      { levels: 1, bidShares: "100", bidLevelCount: 1, askShares: "80", askLevelCount: 1 },
      { levels: 2, bidShares: "150", bidLevelCount: 2, askShares: "200", askLevelCount: 2 },
      { levels: 5, bidShares: "350", bidLevelCount: 3, askShares: "200", askLevelCount: 2 },
    ]);
    expect(value(snapshot, "polymarket.order_book_imbalance")).toBe(`0.${"63".repeat(16)}64`);
    expect(value(snapshot, "polymarket.microprice")).toBe(`0.502${"2".repeat(31)}`);
  });

  it("computes executable prices with the pinned division policy and typed insufficiency", () => {
    expect(value(snapshot, "polymarket.executable_buy_price")).toEqual([
      {
        requestedShares: "50",
        outcome: "QUOTE",
        volumeWeightedAveragePrice: "0.52",
        totalCost: "26",
        worstPrice: "0.52",
        levelsConsumed: 1,
      },
      {
        requestedShares: "150",
        outcome: "QUOTE",
        volumeWeightedAveragePrice: `0.524${"6".repeat(30)}7`,
        totalCost: "78.7",
        worstPrice: "0.53",
        levelsConsumed: 2,
      },
      { requestedShares: "1000", outcome: "INSUFFICIENT_DEPTH", availableShares: "200" },
    ]);
    expect(value(snapshot, "polymarket.executable_sell_price")).toEqual([
      {
        requestedShares: "50",
        outcome: "QUOTE",
        volumeWeightedAveragePrice: "0.48",
        totalCost: "24",
        worstPrice: "0.48",
        levelsConsumed: 1,
      },
      {
        requestedShares: "150",
        outcome: "QUOTE",
        volumeWeightedAveragePrice: `0.476${"6".repeat(30)}7`,
        totalCost: "71.5",
        worstPrice: "0.47",
        levelsConsumed: 2,
      },
      { requestedShares: "1000", outcome: "INSUFFICIENT_DEPTH", availableShares: "350" },
    ]);
  });

  it("aggregates recent trades over the half-open window (ADR-014 sides)", () => {
    // The 11:58:30 trade sits exactly at/before asOf - 60s and is excluded.
    expect(value(snapshot, "polymarket.recent_trades")).toEqual({
      windowMs: 60_000,
      tradeCount: 3,
      buyVolume: "10",
      sellVolume: "5",
      unknownVolume: "2",
      totalVolume: "17",
      netSignedVolume: "5",
      netDirection: "BUY",
      lastTradeSide: "UNKNOWN",
    });
  });

  it("computes reference returns with last-value-carried-forward endpoints", () => {
    // 250ms/1s/5s all resolve to the same endpoints (100250 -> 100750).
    const r250 = value(snapshot, "reference.binance.return_250ms");
    expect(value(snapshot, "reference.binance.return_1s")).toBe(r250);
    expect(value(snapshot, "reference.binance.return_5s")).toBe(r250);
    // 30s resolves to (100500 -> 100750) — a different, smaller return.
    expect(value(snapshot, "reference.binance.return_30s")).not.toBe(r250);
    // Coinbase 250ms/1s endpoints are equal prices — the return is exactly zero.
    expect(value(snapshot, "reference.coinbase.return_250ms")).toBe("0");
    expect(value(snapshot, "reference.coinbase.return_1s")).toBe("0");
  });

  it("computes cross-venue agreement per horizon, with zero as NEUTRAL", () => {
    expect(value(snapshot, "reference.cross_venue.direction_agreement_250ms")).toBe("NEUTRAL");
    expect(value(snapshot, "reference.cross_venue.direction_agreement_1s")).toBe("NEUTRAL");
    expect(value(snapshot, "reference.cross_venue.direction_agreement_5s")).toBe("AGREE");
    expect(value(snapshot, "reference.cross_venue.direction_agreement_30s")).toBe("AGREE");
  });

  it("computes the cross-venue midpoint difference from exact halvings", () => {
    // binance (100700+100800)/2 = 100750; coinbase (100600+100800)/2 = 100700.
    expect(value(snapshot, "reference.cross_venue.midpoint_difference")).toBe("50");
  });

  it("selects the latest TWAP per window with the fixture's older 30s entry ignored", () => {
    expect(value(snapshot, "reference.chainlink.twap_30s")).toEqual({
      feedId: "btc.usd",
      value: "100400",
      windowSeconds: 30,
      windowEndAt: "2026-09-03T11:59:30Z",
    });
    expect(value(snapshot, "reference.chainlink.twap_60s")).toEqual({
      feedId: "btc.usd",
      value: "100300",
      windowSeconds: 60,
      windowEndAt: "2026-09-03T11:59:00Z",
    });
  });

  it("computes EWMA volatility over three returns with the configured lambda", () => {
    const volatility = value(snapshot, "reference.binance.ewma_realized_volatility") as Record<string, unknown>;
    expect(volatility["observations"]).toBe(3);
    expect(volatility["lambda"]).toBe("0.94");
    expect(typeof volatility["volatility"]).toBe("string");
    expect(typeof volatility["variance"]).toBe("string");
  });

  it("computes lifecycle features from event timestamps only", () => {
    expect(value(snapshot, "lifecycle.time_to_close_ms")).toBe(900_000);
    expect(value(snapshot, "lifecycle.time_since_open_ms")).toBe(900_000);
    expect(value(snapshot, "lifecycle.market_duration_ms")).toBe(1_800_000);
    expect(value(snapshot, "lifecycle.reference_open_distance")).toEqual({
      venue: "binance",
      referencePrice: "100750",
      referenceOpenPrice: "100200",
      distance: "550",
    });
  });

  it("includes the age of every input feed, sorted, with hand-computed values", () => {
    expect(value(snapshot, "quality.input_feed_ages")).toEqual([
      { feedId: "polymarket.book", ageMs: 500 },
      { feedId: "polymarket.trades", ageMs: 2_000 },
      { feedId: "reference.binance", ageMs: 100 },
      { feedId: "reference.chainlink", ageMs: 30_000 },
      { feedId: "reference.coinbase", ageMs: 1_000 },
    ]);
  });

  it("includes the active incident flags sorted by incidentId", () => {
    expect(value(snapshot, "quality.active_incidents")).toEqual([
      { incidentId: "inc-1", reasonCode: "STALE_FEED", severity: "NOTIFY" },
      { incidentId: "inc-2", reasonCode: "FEED_GAP", severity: "PAGE", feedId: "reference.binance" },
    ]);
  });

  it("records provenance: subject, trigger, config, and the book identity", () => {
    expect(snapshot.subject).toEqual({ internalMarketId: FIXTURE_MARKET, tokenId: FIXTURE_TOKEN });
    expect(snapshot.trigger).toEqual({ gatewayEpoch: FIXTURE_EPOCH, ingestSeq: "42" });
    expect(snapshot.inputs.bookGatewayEpoch).toBe(FIXTURE_EPOCH);
    expect(snapshot.inputs.bookSubscriptionGeneration).toBe(3);
    expect(snapshot.inputs.bookLastIngestSeq).toBe("42");
    expect(snapshot.inputs.bookVenueBookHash).toBe("abc123");
    expect(snapshot.inputs.tickSize).toBe("0.01");
    expect(snapshot.inputs.bookSerializationVersion).toBe("polymarket-bot/order-book/v1");
  });

  it("content-addresses the serialization under the domain prefix (recomputed here)", () => {
    const expected = createHash("sha256")
      .update(CONTENT_ADDRESS_DOMAIN + serialization, "utf8")
      .digest("hex");
    expect(snapshot.contentAddress).toBe(expected);
    expect(verifySnapshotSerialization(serialization, snapshot.contentAddress)).toBe(true);
    expect(verifySnapshotSerialization(`${serialization} `, snapshot.contentAddress)).toBe(false);
  });

  it("hashes the exact book text into inputs.bookSha256 (recomputed here)", () => {
    expect(snapshot.inputs.bookSha256).toBe(createHash("sha256").update(fixtureBookText(), "utf8").digest("hex"));
    expect(snapshot.inputs.inputsSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("returns a deeply frozen, prototype-free snapshot", () => {
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.isFrozen(snapshot.features)).toBe(true);
    const first = snapshot.features[0];
    expect(first !== undefined && Object.isFrozen(first)).toBe(true);
    expect(first === undefined ? null : Object.getPrototypeOf(first)).toBeNull();
    expect(() => {
      (snapshot as unknown as Record<string, unknown>)["contentAddress"] = "tampered";
    }).toThrow();
  });

  it("supports the §9.5 storage helpers: durable reference and selected indexed values", () => {
    expect(snapshotReference(snapshot)).toEqual({
      contentAddress: snapshot.contentAddress,
      format: "polymarket-bot/feature-snapshot/v1",
      featureSet: "polymarket-bot/features/v1",
      internalMarketId: FIXTURE_MARKET,
      tokenId: FIXTURE_TOKEN,
      asOf: "2026-09-03T12:00:00Z",
      triggerGatewayEpoch: FIXTURE_EPOCH,
      triggerIngestSeq: "42",
    });
    const selected = selectIndexedValues(snapshot, ["polymarket.midpoint", "polymarket.spread", "unknown.id"]);
    expect(selected).toEqual([
      { id: "polymarket.midpoint", version: 1, status: "OK", value: "0.5" },
      { id: "polymarket.spread", version: 1, status: "OK", value: "0.04" },
    ]);
  });
});

describe("absent-versus-zero semantics (the WP-150 carried follow-up)", () => {
  function inputWithBook(lines: readonly string[]): Record<string, unknown> {
    const input = fixtureInput();
    (input["book"] as Record<string, unknown>)["serializedBook"] = lines.join("\n");
    return input;
  }
  const emptyAskLines = [
    "polymarket-bot/order-book/v1",
    `market ${FIXTURE_MARKET}`,
    `token ${FIXTURE_TOKEN}`,
    `epoch ${FIXTURE_EPOCH}`,
    "generation 3",
    "lastIngestSeq 42",
    "venueBookHash -",
    "tickSize 0.01",
    "bestBid 0.48 100",
    "bestAsk - -",
    "spread -",
    "depth bids 1 100 asks 0 0",
    "bids 1",
    "0.48 100",
    "asks 0",
  ];

  it("PRICE features are ABSENT on an empty side; SUM features report zero", () => {
    const { snapshot } = computeOk(inputWithBook(emptyAskLines));
    expect(entry(snapshot, "polymarket.best_ask")).toMatchObject({ status: "ABSENT", reason: "EMPTY_ASK_SIDE" });
    expect(entry(snapshot, "polymarket.midpoint")).toMatchObject({ status: "ABSENT", reason: "EMPTY_ASK_SIDE" });
    expect(entry(snapshot, "polymarket.spread")).toMatchObject({ status: "ABSENT", reason: "EMPTY_ASK_SIDE" });
    expect(entry(snapshot, "polymarket.microprice")).toMatchObject({ status: "ABSENT", reason: "EMPTY_ASK_SIDE" });
    // Depth on the empty side is genuinely zero shares, not absent.
    expect(value(snapshot, "polymarket.depth_at_levels")).toEqual([
      { levels: 1, bidShares: "100", bidLevelCount: 1, askShares: "0", askLevelCount: 0 },
      { levels: 2, bidShares: "100", bidLevelCount: 1, askShares: "0", askLevelCount: 0 },
      { levels: 5, bidShares: "100", bidLevelCount: 1, askShares: "0", askLevelCount: 0 },
    ]);
    // Executable BUY against an empty ask side: typed insufficiency with 0 available.
    expect(value(snapshot, "polymarket.executable_buy_price")).toEqual([
      { requestedShares: "50", outcome: "INSUFFICIENT_DEPTH", availableShares: "0" },
      { requestedShares: "150", outcome: "INSUFFICIENT_DEPTH", availableShares: "0" },
      { requestedShares: "1000", outcome: "INSUFFICIENT_DEPTH", availableShares: "0" },
    ]);
    // All resting shares are bids: imbalance is exactly one.
    expect(value(snapshot, "polymarket.order_book_imbalance")).toBe("1");
  });

  it("an entirely empty book yields EMPTY_BOOK absences and an ABSENT imbalance", () => {
    const emptyBookLines = [
      "polymarket-bot/order-book/v1",
      `market ${FIXTURE_MARKET}`,
      `token ${FIXTURE_TOKEN}`,
      `epoch ${FIXTURE_EPOCH}`,
      "generation 3",
      "lastIngestSeq 42",
      "venueBookHash -",
      "tickSize -",
      "bestBid - -",
      "bestAsk - -",
      "spread -",
      "depth bids 0 0 asks 0 0",
      "bids 0",
      "asks 0",
    ];
    const { snapshot } = computeOk(inputWithBook(emptyBookLines));
    expect(entry(snapshot, "polymarket.midpoint")).toMatchObject({ status: "ABSENT", reason: "EMPTY_BOOK" });
    expect(entry(snapshot, "polymarket.order_book_imbalance")).toMatchObject({ status: "ABSENT", reason: "EMPTY_BOOK" });
    expect(snapshot.inputs.tickSize).toBeUndefined();
  });
});

describe("absence propagation for missing optional sections", () => {
  it("missing trades/reference/lifecycle sections yield typed ABSENT features, and ages shrink", () => {
    const input = fixtureInput();
    delete input["trades"];
    delete input["reference"];
    delete input["lifecycle"];
    const { snapshot } = computeOk(input);
    expect(entry(snapshot, "polymarket.recent_trades")).toMatchObject({ status: "ABSENT", reason: "INPUT_MISSING" });
    expect(entry(snapshot, "reference.binance.return_1s")).toMatchObject({ status: "ABSENT", reason: "INPUT_MISSING" });
    expect(entry(snapshot, "reference.cross_venue.midpoint_difference")).toMatchObject({
      status: "ABSENT",
      reason: "INPUT_MISSING",
    });
    expect(entry(snapshot, "reference.chainlink.twap_30s")).toMatchObject({ status: "ABSENT", reason: "NOT_CONFIGURED" });
    expect(entry(snapshot, "lifecycle.time_to_close_ms")).toMatchObject({ status: "ABSENT", reason: "INPUT_MISSING" });
    expect(entry(snapshot, "lifecycle.reference_open_distance")).toMatchObject({ status: "ABSENT", reason: "INPUT_MISSING" });
    expect(value(snapshot, "quality.input_feed_ages")).toEqual([{ feedId: "polymarket.book", ageMs: 500 }]);
  });

  it("a two-point series yields a volatility; a one-point series is INSUFFICIENT_SERIES", () => {
    const input = fixtureInput();
    const reference = input["reference"] as { coinbase: { trades: unknown[] } };
    reference.coinbase.trades = [{ price: "100", observedAt: "2026-09-03T11:59:00Z" }];
    const { snapshot } = computeOk(input);
    expect(entry(snapshot, "reference.coinbase.ewma_realized_volatility")).toMatchObject({
      status: "ABSENT",
      reason: "INSUFFICIENT_SERIES",
    });
  });

  it("sqrt(square) volatility identity: two points with a 10% move volatilize to exactly 0.1", () => {
    // 100 -> 110: r = 0.1, variance = r^2 = 0.01, volatility = 0.1 — the
    // sqrt-of-square identity is an oracle needing no reimplementation.
    const input = fixtureInput();
    const reference = input["reference"] as { coinbase: Record<string, unknown> };
    reference.coinbase["trades"] = [
      { price: "100", observedAt: "2026-09-03T11:58:00Z" },
      { price: "110", observedAt: "2026-09-03T11:59:00Z" },
    ];
    const { snapshot } = computeOk(input);
    expect(value(snapshot, "reference.coinbase.ewma_realized_volatility")).toEqual({
      volatility: "0.1",
      variance: "0.01",
      observations: 1,
      lambda: "0.94",
    });
  });

  it("lambda-independence oracle: equal consecutive returns make EWMA variance the square of the return", () => {
    // 100 -> 110 -> 121: r1 = r2 = 0.1; S = 0.94*0.01 + 0.06*0.01 = 0.01.
    const input = fixtureInput();
    const reference = input["reference"] as { coinbase: Record<string, unknown> };
    reference.coinbase["trades"] = [
      { price: "100", observedAt: "2026-09-03T11:57:00Z" },
      { price: "110", observedAt: "2026-09-03T11:58:00Z" },
      { price: "121", observedAt: "2026-09-03T11:59:00Z" },
    ];
    const { snapshot } = computeOk(input);
    expect(value(snapshot, "reference.coinbase.ewma_realized_volatility")).toEqual({
      volatility: "0.1",
      variance: "0.01",
      observations: 2,
      lambda: "0.94",
    });
  });
});

describe("refusals and totality", () => {
  it("refuses non-data input as FEATURES_INPUT_NOT_DATA without running the getter", () => {
    let invoked = false;
    const hostile = fixtureInput();
    Object.defineProperty(hostile, "asOf", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "2026-09-03T12:00:00Z";
      },
    });
    const result = computeFeatureSnapshot(hostile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("FEATURES_INPUT_NOT_DATA");
    expect(invoked).toBe(false);
  });

  const refusalCases: [string, (input: Record<string, unknown>) => void, string][] = [
    [
      "FEATURES_TIMESTAMP_INVALID",
      (input) => {
        input["asOf"] = "2026-09-03T12:00:00";
      },
      "FEATURES_TIMESTAMP_INVALID",
    ],
    [
      "FEATURES_INPUT_INVALID",
      (input) => {
        (input["config"] as Record<string, unknown>)["depthLevels"] = [];
      },
      "FEATURES_INPUT_INVALID",
    ],
    [
      "FEATURES_SUBJECT_MISMATCH",
      (input) => {
        (input["subject"] as Record<string, unknown>)["tokenId"] = "999";
      },
      "FEATURES_SUBJECT_MISMATCH",
    ],
    [
      "FEATURES_BOOK_SERIALIZATION_UNSUPPORTED",
      (input) => {
        (input["book"] as Record<string, unknown>)["serializedBook"] = "polymarket-bot/order-book/v2\nrest";
      },
      "FEATURES_BOOK_SERIALIZATION_UNSUPPORTED",
    ],
    [
      "FEATURES_BOOK_SERIALIZATION_MALFORMED",
      (input) => {
        (input["book"] as Record<string, unknown>)["serializedBook"] = "polymarket-bot/order-book/v1\ngarbage";
      },
      "FEATURES_BOOK_SERIALIZATION_MALFORMED",
    ],
    [
      "FEATURES_BOOK_SERIALIZATION_INCONSISTENT",
      (input) => {
        (input["book"] as Record<string, unknown>)["serializedBook"] = fixtureBookText().replace(
          "spread 0.04",
          "spread 0.05",
        );
      },
      "FEATURES_BOOK_SERIALIZATION_INCONSISTENT",
    ],
  ];
  for (const [name, edit, code] of refusalCases) {
    it(`refuses as ${name}`, () => {
      const input = fixtureInput();
      edit(input);
      const result = computeFeatureSnapshot(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe(code);
      expect(Object.isFrozen(result.refusal)).toBe(true);
    });
  }

  it("refuses an unbaselined book as FEATURES_BOOK_NOT_BASELINED", () => {
    const input = fixtureInput();
    (input["book"] as Record<string, unknown>)["serializedBook"] = fixtureBookText()
      .replace(`epoch ${FIXTURE_EPOCH}`, "epoch -")
      .replace("generation 3", "generation -")
      .replace("lastIngestSeq 42", "lastIngestSeq -");
    const result = computeFeatureSnapshot(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("FEATURES_BOOK_NOT_BASELINED");
  });

  it("is total over garbage inputs (never throws)", () => {
    for (const input of [undefined, null, 42, "input", [], {}, { subject: null }, Symbol("x"), () => 1]) {
      const result = computeFeatureSnapshot(input);
      expect(result.ok).toBe(false);
    }
  });
});
