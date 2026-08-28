/**
 * Staleness metrics — the work plan's third deliverable, and the requirement
 * that staleness is surfaced as DATA rather than logged.
 */

import { describe, expect, it } from "vitest";

import { CoinbaseConnectionManager } from "@polymarket-bot/coinbase-adapter";
import {
  FakeCoinbaseSocketFactory,
  ManualMonotonicClock,
  ManualTimer,
  ManualWallClock,
} from "@polymarket-bot/coinbase-adapter/testing";

import { frameText, frameTextWithSequence } from "./fixtures.js";
import { anomalyCodes, createHarness, feedEvent, feedEventTypes } from "./harness.js";

describe("staleness as a queryable value", () => {
  it("measures elapsed time since the last frame, on the monotonic clock", () => {
    const harness = createHarness({ stalenessThresholdMs: 5_000 });
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("heartbeats"));

    expect(harness.processor.metrics().stalenessMs).toBe(0);
    harness.advanceMs(2_500);
    const metrics = harness.processor.metrics();
    expect(metrics.stalenessMs).toBe(2_500);
    expect(metrics.stale).toBe(false);
    expect(metrics.stalenessThresholdMs).toBe(5_000);
    expect(metrics.lastMessageAt).toBe("2026-08-27T12:00:00.000Z");
  });

  it("reports staleness per channel, keeping venue and receipt times apart", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    harness.advanceMs(1_000);
    harness.processor.ingestFrame(frameTextWithSequence("ticker-snapshot", 1));
    harness.advanceMs(1_000);

    const perChannel = new Map(
      harness.processor.metrics().perChannel.map((entry) => [entry.channel, entry]),
    );
    expect(perChannel.get("market_trades")?.stalenessMs).toBe(2_000);
    expect(perChannel.get("ticker")?.stalenessMs).toBe(1_000);
    expect(perChannel.get("market_trades")?.lastVenueTimestamp).toBe(
      "2023-02-09T20:19:35.39625135Z",
    );
    expect(perChannel.get("market_trades")?.lastMessageAt).toBe("2026-08-27T12:00:00.000Z");
    expect(perChannel.get("ticker")?.framesReceived).toBe(1);
  });

  it("raises a FeedStale event and an anomaly once per quiet period", () => {
    const harness = createHarness({ stalenessThresholdMs: 3_000 });
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("heartbeats"));

    harness.advanceMs(3_000);
    expect(harness.processor.pollStaleness().feedEvents).toHaveLength(0);

    harness.advanceMs(1);
    const stale = harness.processor.pollStaleness();
    const event = feedEvent(stale, "FeedStale");
    expect(event.payload.stalenessMs).toBe(3_001);
    expect(event.payload.lastMessageAt).toBe("2026-08-27T12:00:00.000Z");
    expect(anomalyCodes(stale)).toEqual(["COINBASE_FEED_STALE"]);

    // A feed quiet for an hour is one fact, not one fact per poll.
    harness.advanceMs(60_000);
    expect(harness.processor.pollStaleness().feedEvents).toHaveLength(0);
  });

  it("re-arms after a frame arrives", () => {
    const harness = createHarness({ stalenessThresholdMs: 1_000 });
    harness.processor.connectionOpened("c1");
    harness.advanceMs(2_000);
    expect(feedEventTypes(harness.processor.pollStaleness())).toEqual(["FeedStale"]);

    harness.processor.ingestFrame(frameText("heartbeats"));
    harness.advanceMs(2_000);
    expect(feedEventTypes(harness.processor.pollStaleness())).toEqual(["FeedStale"]);
  });

  it("counts every classification and every anomaly code", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    harness.processor.ingestFrame(frameTextWithSequence("ticker-snapshot", 1));
    harness.processor.ingestFrame(frameText("market-trades-update"));
    harness.processor.ingestFrame(frameText("market-trades-duplicate"));
    harness.processor.ingestFrame(frameTextWithSequence("candles-unhandled-channel", 4));
    harness.processor.ingestFrame(frameText("malformed-not-json"));

    const metrics = harness.processor.metrics();
    expect(metrics.counters.framesReceived).toBe(6);
    expect(metrics.counters.tradesNormalized).toBe(3);
    expect(metrics.counters.topOfBookNormalized).toBe(1);
    expect(metrics.counters.tradesDuplicateSuppressed).toBe(1);
    expect(metrics.counters.framesUnknownChannel).toBe(1);
    expect(metrics.counters.framesRejected).toBe(1);
    expect(metrics.counters.connectionsOpened).toBe(1);
    expect(metrics.counters.subscriptionGenerations).toBe(1);
    expect(metrics.anomaliesByCode.COINBASE_DUPLICATE_TRADE).toBe(1);
    expect(metrics.anomaliesByCode.COINBASE_UNKNOWN_CHANNEL).toBe(1);
    expect(metrics.anomaliesByCode.COINBASE_FRAME_NOT_JSON).toBe(1);
  });

  it("carries no Prometheus, registry, or exporter concept in its metric type", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const metrics = harness.processor.metrics();
    const keys = Object.keys(metrics).join(",").toLowerCase();
    for (const forbidden of ["prometheus", "registry", "gauge", "histogram", "exporter"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.parse(JSON.stringify(metrics))).toBeTypeOf("object");
  });
});

describe("a silent socket stall", () => {
  it("is turned into a recorded disconnect by the connection manager", () => {
    const factory = new FakeCoinbaseSocketFactory();
    const timer = new ManualTimer();
    const monotonicClock = new ManualMonotonicClock(0n);
    const types: string[] = [];
    const manager = new CoinbaseConnectionManager({
      feedId: "coinbase.reference",
      productIds: ["ETH-USD"],
      socketFactory: factory,
      timer,
      wallClock: new ManualWallClock("2026-08-27T12:00:00.000Z"),
      monotonicClock,
      stalenessThresholdMs: 2_000,
      stalenessPollIntervalMs: 1_000,
      onOutput: (output) => {
        for (const event of output.feedEvents) {
          types.push(event.eventType);
        }
      },
    });

    manager.start();
    factory.current.open();
    expect(types).toEqual(["FeedConnected"]);

    // The socket never says anything and never closes: exactly the stall the
    // gateway's own acceptance criterion cares about.
    monotonicClock.advanceMs(3_000);
    timer.advanceMs(1_000);

    expect(types).toContain("FeedStale");
    expect(types).toContain("FeedDisconnected");

    timer.advanceMs(1_000);
    expect(factory.sockets.length).toBeGreaterThan(1);
    manager.stop();
  });
});
