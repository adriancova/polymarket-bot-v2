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
  type FakeCoinbaseSocket,
} from "@polymarket-bot/coinbase-adapter/testing";

import { frameText, frameTextWithSequence } from "./fixtures.js";
import { anomalyCodes, createHarness, feedEvent, feedEventTypes, tops, trades } from "./harness.js";

/**
 * The socket at a given position, failing loudly rather than silently no-opping.
 *
 * `factory.current` is the newest socket; these tests deliberately reach back to
 * an OLDER one, because that is the case under test.
 */
function socketAt(factory: FakeCoinbaseSocketFactory, index: number): FakeCoinbaseSocket {
  const socket = factory.sockets[index];
  if (socket === undefined) {
    throw new Error(`expected a socket at index ${String(index)}; ${String(factory.sockets.length)} were opened`);
  }
  return socket;
}

function anomalyCodesOf(outputs: readonly CoinbaseFeedOutput[]): string[] {
  return outputs.flatMap((output) => output.anomalies.map((anomaly) => anomaly.code));
}

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

  it("does not accept a snapshot it could not apply as an authoritative snapshot", () => {
    const harness = createHarness({ channels: ["market_trades"] });
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    // Its one trade carries an empty price, which the decimal boundary refuses.
    // Receipt of a `snapshot`-typed frame is therefore NOT enough: nothing
    // authoritative was applied, so claiming
    // `authoritativeSnapshotApplied: true` would be a false statement about
    // recovery (ADR-002 §2.4).
    const refused = harness.processor.ingestFrame(frameText("malformed-snapshot-empty-price"));
    expect(anomalyCodes(refused)).toEqual([
      "COINBASE_ECONOMIC_FIELD_INVALID",
      "COINBASE_SNAPSHOT_NOT_APPLIED",
    ]);
    expect(trades(refused)).toHaveLength(0);
    expect(feedEventTypes(refused)).not.toContain("FeedResynchronized");
    expect(harness.processor.gapOpen).toBe(true);
    expect(harness.processor.metrics().counters.resynchronizations).toBe(0);

    // Recovery must still be possible: the next snapshot that DOES apply closes
    // the gap, so the refusal delays resynchronization rather than blocking it.
    const applied = harness.processor.ingestFrame(
      frameTextWithSequence("market-trades-snapshot", 1),
    );
    expect(feedEvent(applied, "FeedResynchronized").payload.authoritativeSnapshotApplied).toBe(true);
    expect(harness.processor.gapOpen).toBe(false);
  });

  it("does not let one channel's valid snapshot close a gap the other channel has not closed", () => {
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    const refusedTrades = harness.processor.ingestFrame(
      frameText("malformed-snapshot-empty-price"),
    );
    expect(anomalyCodes(refusedTrades)).toContain("COINBASE_SNAPSHOT_NOT_APPLIED");

    const ticker = harness.processor.ingestFrame(frameTextWithSequence("ticker-snapshot", 1));
    expect(tops(ticker)).toHaveLength(1);
    // The ticker snapshot is authoritative for the ticker channel and for
    // nothing else. The gap covers both channels, so it stays open.
    expect(feedEventTypes(ticker)).not.toContain("FeedResynchronized");
    expect(harness.processor.gapOpen).toBe(true);

    const closed = harness.processor.ingestFrame(
      frameTextWithSequence("market-trades-snapshot", 2),
    );
    expect(feedEvent(closed, "FeedResynchronized").payload.subscriptionGeneration).toBe(1);
  });

  it("counts a snapshot of trades it has already emitted as applied", () => {
    // The opposite failure, guarded: on a reconnect the venue replays trades
    // that are already in the dedupe window, so every entry is suppressed as a
    // duplicate. If suppression counted as "not applied", the gap could never
    // close, the processor would demand a resubscription for ever, and the
    // manager would reconnect in a loop.
    const harness = createHarness({ channels: ["market_trades"] });
    harness.processor.connectionOpened("c1");
    harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    const replay = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    expect(anomalyCodes(replay)).toContain("COINBASE_DUPLICATE_TRADE");
    expect(anomalyCodes(replay)).not.toContain("COINBASE_SNAPSHOT_NOT_APPLIED");
    expect(feedEvent(replay, "FeedResynchronized").payload.authoritativeSnapshotApplied).toBe(true);
    expect(harness.processor.gapOpen).toBe(false);
  });

  it("revokes an earlier snapshot mark when a newer snapshot on that channel is refused", () => {
    // The exact ordered sequence: a trades snapshot that APPLIES, then a newer
    // trades snapshot the adapter must refuse, then a valid ticker snapshot.
    // The mark the first one earned describes state the second one has just
    // restated in terms this adapter cannot read, so it no longer describes
    // anything known to be current. Left standing, it let the ticker snapshot
    // emit `FeedResynchronized` while the newest word on `market_trades` was
    // unapplied — contradicting the very anomaly that says the gap stays open
    // until a snapshot applies in full.
    const harness = createHarness();
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    const applied = harness.processor.ingestFrame(frameText("market-trades-snapshot"));
    expect(trades(applied)).toHaveLength(1);
    expect(feedEventTypes(applied)).not.toContain("FeedResynchronized");

    const refused = harness.processor.ingestFrame(
      frameTextWithSequence("malformed-snapshot-empty-price", 1),
    );
    expect(anomalyCodes(refused)).toEqual([
      "COINBASE_ECONOMIC_FIELD_INVALID",
      "COINBASE_SNAPSHOT_NOT_APPLIED",
    ]);

    const ticker = harness.processor.ingestFrame(frameTextWithSequence("ticker-snapshot", 2));
    expect(tops(ticker)).toHaveLength(1);
    expect(feedEventTypes(ticker)).not.toContain("FeedResynchronized");
    expect(harness.processor.gapOpen).toBe(true);
    expect(harness.processor.metrics().counters.resynchronizations).toBe(0);

    // Revocation delays resynchronization; it does not block it. A trades
    // snapshot that applies — here by suppressing trades already emitted —
    // re-earns the mark and closes the gap.
    const closed = harness.processor.ingestFrame(
      frameTextWithSequence("market-trades-snapshot", 3),
    );
    expect(anomalyCodes(closed)).toContain("COINBASE_DUPLICATE_TRADE");
    expect(feedEvent(closed, "FeedResynchronized").payload.authoritativeSnapshotApplied).toBe(true);
    expect(harness.processor.gapOpen).toBe(false);
  });

  it("refuses a frame delivered by a connection it has already replaced", () => {
    const harness = createHarness({ channels: ["market_trades"] });
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    const stale = harness.processor.ingestFrame(frameText("market-trades-snapshot"), {
      connectionId: "c1",
    });

    expect(anomalyCodes(stale)).toEqual(["COINBASE_STALE_CONNECTION_ACTIVITY"]);
    expect(stale.anomalies[0]?.rawFrame).toBe(frameText("market-trades-snapshot"));
    expect(trades(stale)).toHaveLength(0);
    // The frame is a `snapshot`, so before the origin check existed it would
    // also have closed the very gap the reconnect opened.
    expect(feedEventTypes(stale)).not.toContain("FeedResynchronized");
    expect(harness.processor.gapOpen).toBe(true);
    expect(harness.processor.metrics().counters.framesFromStaleConnection).toBe(1);
    expect(harness.processor.metrics().counters.tradesNormalized).toBe(0);
  });

  it("accepts the same frame when it comes from the current connection", () => {
    const harness = createHarness({ channels: ["market_trades"] });
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    const current = harness.processor.ingestFrame(frameText("market-trades-snapshot"), {
      connectionId: "c2",
    });
    expect(trades(current)).toHaveLength(1);
    expect(trades(current)[0]?.envelope.connectionId).toBe("c2");
    expect(trades(current)[0]?.envelope.subscriptionGeneration).toBe(1);
    expect(harness.processor.metrics().counters.framesFromStaleConnection).toBe(0);
  });

  it("does not let a stale frame stand in for liveness on the current connection", () => {
    const harness = createHarness({ stalenessThresholdMs: 1_000 });
    harness.processor.connectionOpened("c1");
    harness.processor.connectionClosed({ reasonCode: "COINBASE_SOCKET_CLOSED" });
    harness.processor.connectionOpened("c2");

    harness.advanceMs(2_000);
    harness.processor.ingestFrame(frameText("heartbeats"), { connectionId: "c1" });

    // A frame from a dead socket says nothing about whether the current one is
    // alive; letting it reset the clock would hide exactly the stall the bound
    // exists to catch.
    expect(feedEventTypes(harness.processor.pollStaleness())).toEqual(["FeedStale"]);
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

  it("refuses a frame delivered late by a socket it has already replaced", () => {
    const { manager, factory, timer, outputs } = build();
    manager.start();
    const first = socketAt(factory, 0);
    first.open();
    first.dropConnection();
    timer.advanceMs(1_000);
    socketAt(factory, 1).open();

    outputs.length = 0;
    // A frame that was in flight when the first socket died is delivered after
    // the replacement is already open. The listener belongs to the old socket.
    first.listener.onFrame(frameText("market-trades-snapshot"));

    expect(anomalyCodesOf(outputs)).toEqual(["COINBASE_STALE_CONNECTION_ACTIVITY"]);
    expect(outputs.flatMap((output) => output.normalized)).toHaveLength(0);
    expect(outputs.flatMap(feedEventTypes)).toEqual([]);
    // It must not close the gap the reconnect opened, and it must not be
    // published under the new connection's generation.
    expect(manager.metrics().gapOpen).toBe(true);
    expect(manager.metrics().counters.tradesNormalized).toBe(0);
    expect(manager.metrics().counters.framesFromStaleConnection).toBe(1);
    manager.stop();
  });

  it("refuses a frame from a retired socket while its replacement is still connecting", () => {
    const { manager, factory, timer, outputs } = build();
    manager.start();
    const first = socketAt(factory, 0);
    first.open();
    first.dropConnection();
    timer.advanceMs(1_000);
    // The replacement socket EXISTS but has not reported itself open, so the
    // processor's own view still names the retired connection. Only the
    // manager's ordinal knows the difference in this window.
    expect(factory.sockets).toHaveLength(2);
    expect(socketAt(factory, 1).opened).toBe(false);
    expect(manager.metrics().connectionId).toBe("coinbase.reference-c1");

    outputs.length = 0;
    first.listener.onFrame(frameText("market-trades-snapshot"));

    expect(anomalyCodesOf(outputs)).toEqual(["COINBASE_STALE_CONNECTION_ACTIVITY"]);
    const anomaly = outputs.flatMap((output) => output.anomalies)[0];
    // The bytes must survive the refusal: they are the only record of what the
    // dead socket said.
    expect(anomaly?.rawFrame).toBe(frameText("market-trades-snapshot"));
    expect(anomaly?.detail).toContain("coinbase.reference-c1");
    expect(outputs.flatMap((output) => output.normalized)).toHaveLength(0);
    expect(outputs.flatMap(feedEventTypes)).toEqual([]);

    const metrics = manager.metrics();
    expect(metrics.counters.framesFromStaleConnection).toBe(1);
    expect(metrics.counters.tradesNormalized).toBe(0);
    // Not evidence of liveness either: the replacement has not said anything.
    expect(metrics.lastMessageAt).toBeUndefined();

    // The replacement then opens, which is what declares the gap. The retired
    // socket's `snapshot` may not close it: it was never applied.
    socketAt(factory, 1).open();
    expect(manager.metrics().gapOpen).toBe(true);
    expect(manager.metrics().counters.tradesNormalized).toBe(0);
    manager.stop();
  });

  it("sends its subscriptions even when the transport reports open before connect() returns", () => {
    // A transport may report `onOpen` synchronously, from inside `connect()`,
    // before the manager holds any socket handle. Reporting `FeedConnected` for
    // a subscription that was never sent would be a connection that receives
    // nothing and says it is healthy.
    const factory = new FakeCoinbaseSocketFactory({ openOnConnect: true });
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

    manager.start();
    const expectedSubscriptions = [
      '{"type":"subscribe","channel":"heartbeats"}',
      '{"type":"subscribe","channel":"market_trades","product_ids":["ETH-USD"]}',
      '{"type":"subscribe","channel":"ticker","product_ids":["ETH-USD"]}',
    ];
    expect(socketAt(factory, 0).sent).toEqual(expectedSubscriptions);
    expect(outputs.flatMap(feedEventTypes)).toEqual(["FeedConnected"]);

    // The same must hold on the reconnect path, which reaches `#connect` from a
    // timer rather than from `start()`.
    socketAt(factory, 0).dropConnection();
    timer.advanceMs(1_000);
    expect(factory.sockets).toHaveLength(2);
    expect(socketAt(factory, 1).sent).toEqual(expectedSubscriptions);

    // A subscribed connection receives, and what it receives resynchronizes.
    socketAt(factory, 1).deliver(frameText("market-trades-snapshot"));
    socketAt(factory, 1).deliver(frameTextWithSequence("ticker-snapshot", 1));
    expect(outputs.flatMap(feedEventTypes)).toContain("FeedResynchronized");
    manager.stop();
  });

  it("does not report a superseded socket's late close as the live connection's disconnect", () => {
    const { manager, factory, timer, outputs } = build();
    manager.start();
    const first = socketAt(factory, 0);
    first.open();
    first.dropConnection();
    timer.advanceMs(1_000);
    socketAt(factory, 1).open();

    outputs.length = 0;
    first.listener.onClose({ code: 1006, reason: "late close from the old socket" });

    // A FeedDisconnected here would describe the connection that is currently
    // open as having gone away.
    expect(outputs.flatMap(feedEventTypes)).toEqual([]);
    expect(anomalyCodesOf(outputs)).toEqual(["COINBASE_STALE_CONNECTION_ACTIVITY"]);
    expect(manager.metrics().counters.disconnections).toBe(1);

    // And it must not have scheduled a second reconnect racing the live socket.
    timer.advanceMs(60_000);
    expect(factory.sockets).toHaveLength(2);
    manager.stop();
  });

  it("ignores a late error from a superseded socket instead of folding it into the next close", () => {
    const { manager, factory, timer, outputs } = build();
    manager.start();
    const first = socketAt(factory, 0);
    first.open();
    first.dropConnection();
    timer.advanceMs(1_000);
    const second = socketAt(factory, 1);
    second.open();

    outputs.length = 0;
    first.listener.onError(new Error("old socket, late error"));
    expect(anomalyCodesOf(outputs)).toEqual(["COINBASE_STALE_CONNECTION_ACTIVITY"]);

    outputs.length = 0;
    second.dropConnection(1006, "unrelated");
    const disconnected = outputs
      .flatMap((output) => output.feedEvents)
      .find((event) => event.eventType === "FeedDisconnected");
    // The old socket's error belongs to the old socket. Attributing it to this
    // close would blame the wrong connection for the wrong failure.
    expect(disconnected?.eventType).toBe("FeedDisconnected");
    if (disconnected?.eventType === "FeedDisconnected") {
      expect(disconnected.payload.detail ?? "").not.toContain("late error");
    }
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
