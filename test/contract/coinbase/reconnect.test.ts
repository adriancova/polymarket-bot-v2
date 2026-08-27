/**
 * Reconnect handling — work-plan acceptance criterion 1, second half, and
 * ADR-002 §2.4 (a resubscription creates a new `subscriptionGeneration`; a
 * restart or detected gap requires a new authoritative snapshot before affected
 * markets resume).
 *
 * The property under test is that a reconnect is never a silent resumption: it
 * produces an explicit, ordered sequence of feed-status events, and the gap it
 * opens is closed only by the venue's own snapshot.
 */

import { describe, expect, it } from "vitest";

import { CoinbaseConnectionManager, type CoinbaseFeedOutput } from "@polymarket-bot/coinbase-adapter";
import {
  FakeCoinbaseSocketFactory,
  ManualMonotonicClock,
  ManualTimer,
  ManualWallClock,
} from "@polymarket-bot/coinbase-adapter/testing";

import { frameText, frameTextWithSequence } from "./fixtures.js";
import { anomalyCodes, createHarness, feedEvent, feedEventTypes, tops, trades } from "./harness.js";

describe("reconnect, at the processor", () => {
  it("does not claim a gap on the first connection", () => {
    const harness = createHarness();
    const output = harness.processor.connectionOpened("c1");

    expect(feedEventTypes(output)).toEqual(["FeedConnected"]);
    expect(harness.processor.gapOpen).toBe(false);
  });

  it("advances the subscription generation on every connection", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    expect(harness.processor.subscriptionGeneration).toBe(0);

    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");
    expect(harness.processor.subscriptionGeneration).toBe(1);

    harness.processor.resubscribed();
    expect(harness.processor.subscriptionGeneration).toBe(2);
  });

  it("opens an explicit gap and an incident when a connection is replaced", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    const reopened = harness.processor.connectionOpened("c2");

    expect(feedEventTypes(reopened)).toEqual([
      "FeedConnected",
      "FeedGapDetected",
      "DataQualityIncidentOpened",
    ]);
    const gap = feedEvent(reopened, "FeedGapDetected");
    expect(gap.payload.requiresAuthoritativeSnapshot).toBe(true);
    expect(gap.payload.reasonCode).toBe("COINBASE_RECONNECT_NO_REPLAY");
    expect(anomalyCodes(reopened)).toContain("COINBASE_TRADE_HISTORY_NOT_BACKFILLED");
    expect(harness.processor.gapOpen).toBe(true);
  });

  it("keeps the gap open until every declared channel has delivered a snapshot", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    const afterTrades = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    expect(feedEventTypes(afterTrades)).not.toContain("FeedResynchronized");
    expect(harness.processor.gapOpen).toBe(true);

    const afterTicker = harness.processor.ingestFrame(frameTextWithSequence("ticker-snapshot", 1));
    const resync = feedEvent(afterTicker, "FeedResynchronized");
    expect(resync.payload.authoritativeSnapshotApplied).toBe(true);
    expect(resync.payload.subscriptionGeneration).toBe(1);
    expect(harness.processor.gapOpen).toBe(false);
  });

  it("does not accept an undocumented event type as an authoritative snapshot", () => {
    const harness = createHarness({ channels: ["market_trades"] });
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    const unknownType = harness.processor.ingestFrame(
      frameText("market-trades-unknown-event-type"),
    );
    expect(anomalyCodes(unknownType)).toContain("COINBASE_UNKNOWN_EVENT_TYPE");
    expect(feedEventTypes(unknownType)).not.toContain("FeedResynchronized");
    expect(harness.processor.gapOpen).toBe(true);
  });

  it("republishes the top of book after a reconnect even when it is unchanged", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("ticker-snapshot"));

    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");
    const replay = harness.processor.ingestFrame(frameText("ticker-snapshot"));

    // Suppressing this would leave the consumer with no authoritative state to
    // resume on, which is exactly what ADR-002 §2.4 forbids.
    expect(tops(replay)).toHaveLength(1);
    expect(tops(replay)[0]?.envelope.subscriptionGeneration).toBe(1);
  });

  it("treats a mid-stream sequence gap as requiring a fresh subscription", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    harness.processor.ingestFrame(frameTextWithSequence("ticker-snapshot", 1));
    harness.processor.ingestFrame(frameText("market-trades-update"));

    const gapped = harness.processor.ingestFrame(frameText("market-trades-sequence-gap"));
    expect(anomalyCodes(gapped)).toContain("COINBASE_SEQUENCE_GAP");
    expect(feedEvent(gapped, "FeedGapDetected").payload.requiresAuthoritativeSnapshot).toBe(true);
    expect(gapped.requiresResubscription).toBe(true);
    // The trade that DID arrive is still normalized; a gap is not a licence to
    // discard the data that survived it.
    expect(trades(gapped)).toHaveLength(1);

    harness.processor.resubscribed();
    harness.processor.ingestFrame(frameTextWithSequence("market-trades-snapshot", 13));
    const closed = harness.processor.ingestFrame(frameTextWithSequence("ticker-snapshot", 14));
    expect(feedEvent(closed, "FeedResynchronized").payload.subscriptionGeneration).toBe(1);
  });

  it("detects loss from heartbeat_counter even when sequence_num is intact", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("heartbeats"));

    const gapped = harness.processor.ingestFrame(frameText("heartbeats-gap"));
    expect(anomalyCodes(gapped)).not.toContain("COINBASE_SEQUENCE_GAP");
    expect(anomalyCodes(gapped)).toContain("COINBASE_HEARTBEAT_GAP");
    expect(feedEvent(gapped, "FeedGapDetected").payload.reasonCode).toBe("COINBASE_HEARTBEAT_GAP");
  });

  it("records a disconnection before the next connection", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    const closed = harness.processor.connectionClosed({
      reasonCode: "COINBASE_SOCKET_CLOSED",
      detail: "close code 1006",
    });

    const disconnected = feedEvent(closed, "FeedDisconnected");
    expect(disconnected.payload.connectionId).toBe("c1");
    expect(disconnected.payload.detail).toBe("close code 1006");
  });
});

describe("reconnect, at the connection manager", () => {
  function build(): {
    readonly manager: CoinbaseConnectionManager;
    readonly factory: FakeCoinbaseSocketFactory;
    readonly timer: ManualTimer;
    readonly outputs: CoinbaseFeedOutput[];
  } {
    const factory = new FakeCoinbaseSocketFactory();
    const timer = new ManualTimer();
    const outputs: CoinbaseFeedOutput[] = [];
    const manager = new CoinbaseConnectionManager({
      feedId: "coinbase.reference",
      productIds: ["ETH-USD"],
      socketFactory: factory,
      timer,
      wallClock: new ManualWallClock("2026-08-27T12:00:00.000Z"),
      monotonicClock: new ManualMonotonicClock(0n),
      onOutput: (output) => outputs.push(output),
    });
    return { manager, factory, timer, outputs };
  }

  it("subscribes to heartbeats and both market-data channels, with no credential", () => {
    const { manager, factory } = build();
    manager.start();
    factory.current.open();

    expect(factory.current.sent).toEqual([
      '{"type":"subscribe","channel":"heartbeats"}',
      '{"type":"subscribe","channel":"market_trades","product_ids":["ETH-USD"]}',
      '{"type":"subscribe","channel":"ticker","product_ids":["ETH-USD"]}',
    ]);
    for (const frame of factory.current.sent) {
      expect(frame).not.toContain("jwt");
    }
    manager.stop();
  });

  it("opens a new socket after a dropped connection, with a new generation", () => {
    const { manager, factory, timer, outputs } = build();
    manager.start();
    factory.current.open();
    factory.current.deliver(frameText("market-trades-snapshot"));

    factory.current.dropConnection();
    expect(outputs.flatMap(feedEventTypes)).toContain("FeedDisconnected");

    timer.advanceMs(1_000);
    expect(factory.sockets).toHaveLength(2);
    factory.current.open();

    const types = outputs.flatMap(feedEventTypes);
    expect(types).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
      "DataQualityIncidentOpened",
    ]);
    expect(manager.metrics().subscriptionGeneration).toBe(1);
    expect(manager.metrics().gapOpen).toBe(true);
    manager.stop();
  });

  it("resubscribes on the new socket and resynchronizes on the venue's snapshots", () => {
    const { manager, factory, timer, outputs } = build();
    manager.start();
    factory.current.open();
    factory.current.dropConnection();
    timer.advanceMs(1_000);
    factory.current.open();

    factory.current.deliver(frameText("market-trades-snapshot"));
    factory.current.deliver(frameTextWithSequence("ticker-snapshot", 1));

    expect(outputs.flatMap(feedEventTypes)).toContain("FeedResynchronized");
    expect(manager.metrics().gapOpen).toBe(false);
    manager.stop();
  });

  it("backs off deterministically, without unseeded jitter", () => {
    const { manager, factory, timer } = build();
    manager.start();
    factory.current.open();

    factory.current.dropConnection();
    // One failure so far: the first retry waits the initial delay exactly.
    timer.advanceMs(999);
    expect(factory.sockets).toHaveLength(1);
    timer.advanceMs(1);
    expect(factory.sockets).toHaveLength(2);
    manager.stop();
  });

  it("stops for good, cancelling every timer", () => {
    const { manager, factory, timer } = build();
    manager.start();
    factory.current.open();
    manager.stop();

    factory.current.dropConnection();
    timer.advanceMs(60_000);
    expect(factory.sockets).toHaveLength(1);
  });
});
