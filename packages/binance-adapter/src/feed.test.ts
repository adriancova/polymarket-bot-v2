import { describe, expect, it } from "vitest";

import type { AdapterEmission } from "./emission.js";
import { BinanceConfigurationError, BinanceStateError } from "./errors.js";
import { BinanceReferenceFeed, type FrameOutcome } from "./feed.js";
import { BINANCE_REASON_CODES } from "./incidents.js";
import { createManualClock } from "./testing/index.js";
import { BINANCE_UNVERIFIED } from "./venue.js";

function newFeed(
  overrides: Partial<ConstructorParameters<typeof BinanceReferenceFeed>[0]> = {},
): BinanceReferenceFeed {
  return new BinanceReferenceFeed({
    feedId: "binance.reference",
    subscriptions: [
      { symbol: "BTCUSDT", suffix: "trade" },
      { symbol: "BTCUSDT", suffix: "bookTicker" },
    ],
    stalenessThresholdMs: 30_000,
    ...overrides,
  });
}

function tradeFrame(overrides: Record<string, unknown> = {}, stream = "btcusdt@trade"): string {
  return JSON.stringify({
    stream,
    data: {
      e: "trade",
      E: 1_672_515_782_136,
      s: "BTCUSDT",
      t: 12_345,
      p: "0.001",
      q: "100",
      T: 1_672_515_782_136,
      m: true,
      ...overrides,
    },
  });
}

function bookTickerFrame(
  overrides: Record<string, unknown> = {},
  stream = "btcusdt@bookTicker",
): string {
  return JSON.stringify({
    stream,
    data: {
      u: 400_900_217,
      s: "BTCUSDT",
      b: "25.35190000",
      B: "31.21000000",
      a: "25.36520000",
      A: "40.66000000",
      ...overrides,
    },
  });
}

const typesOf = (emissions: readonly AdapterEmission[]): string[] =>
  emissions.map((emission) => emission.eventType);

describe("construction", () => {
  it("requires an explicit staleness threshold and refuses a nonsensical one", () => {
    expect(() => newFeed({ stalenessThresholdMs: 0 })).toThrow(BinanceConfigurationError);
    expect(() => newFeed({ stalenessThresholdMs: -1 })).toThrow(BinanceConfigurationError);
  });

  it("refuses a feedId the frozen CodeString grammar would reject", () => {
    expect(() => newFeed({ feedId: "1binance" })).toThrow(BinanceConfigurationError);
    expect(() => newFeed({ feedId: "binance reference" })).toThrow(BinanceConfigurationError);
  });

  it("exposes the URL it will connect to and the streams it encodes", () => {
    const feed = newFeed();
    expect(feed.url).toBe(
      "wss://data-stream.binance.vision/stream?streams=btcusdt@trade/btcusdt@bookTicker",
    );
    expect(feed.streamNames).toEqual(["btcusdt@trade", "btcusdt@bookTicker"]);
    expect(feed.state).toBe("IDLE");
  });
});

describe("connect", () => {
  it("emits FeedConnected and an unwaived gap on the first subscription", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    const outcome = feed.onOpen("conn-1", clock.stamp());

    expect(typesOf(outcome.emissions)).toEqual([
      "FeedConnected",
      "FeedGapDetected",
      "DataQualityIncidentOpened",
    ]);
    const gap = outcome.emissions[1]?.payload as { reasonCode: string; requiresAuthoritativeSnapshot: boolean };
    expect(gap.reasonCode).toBe(BINANCE_REASON_CODES.subscriptionStart);
    expect(gap.requiresAuthoritativeSnapshot).toBe(true);
  });

  it("NEVER emits FeedResynchronized — it applies no authoritative snapshot (ADR-002 §2.4)", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    const first = feed.onOpen("conn-1", clock.stamp());
    feed.onClose("conn-1", clock.advance(100));
    feed.connecting("conn-2");
    const second = feed.onOpen("conn-2", clock.advance(1_000));

    const all = [...typesOf(first.emissions), ...typesOf(second.emissions)];
    expect(all).not.toContain("FeedResynchronized");
  });

  it("increments the subscription generation on every resubscription (§7.1)", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    expect(feed.subscriptionGeneration).toBe(0);

    feed.onClose("conn-1", clock.advance(10));
    feed.connecting("conn-2");
    feed.onOpen("conn-2", clock.advance(10));
    expect(feed.subscriptionGeneration).toBe(1);

    feed.onClose("conn-2", clock.advance(10));
    feed.connecting("conn-3");
    feed.onOpen("conn-3", clock.advance(10));
    expect(feed.subscriptionGeneration).toBe(2);
  });

  it("uses the reconnect reason code from the second connection onward", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    feed.onClose("conn-1", clock.advance(10));
    feed.connecting("conn-2");
    const outcome = feed.onOpen("conn-2", clock.advance(10));
    const gap = outcome.emissions[1]?.payload as { reasonCode: string };
    expect(gap.reasonCode).toBe(BINANCE_REASON_CODES.reconnect);
  });

  it("refuses an empty or over-long connection id, as data rather than as a throw", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    for (const badId of ["", "x".repeat(101)]) {
      const outcome = feed.onOpen(badId, clock.advance(1));
      expect(outcome.rejected?.relation).toBe("INVALID");
      expect(typesOf(outcome.emissions)).not.toContain("FeedConnected");
      expect(feed.state).not.toBe("OPEN");
    }
  });
});

describe("socket identity (round-1 review, H1)", () => {
  it("does not record a retired socket's message as the live connection's", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-a");
    feed.onOpen("conn-a", clock.advance(1));
    feed.onClose("conn-a", clock.advance(1), { code: 1006 });
    feed.connecting("conn-b");
    feed.onOpen("conn-b", clock.advance(1));

    // The retired socket delivers a buffered frame after its replacement is up.
    const outcome = feed.onFrame("conn-a", tradeFrame({ t: 100 }), clock.advance(1));

    expect(outcome.classification).toBe("STALE_CONNECTION");
    expect(typesOf(outcome.emissions)).not.toContain("ReferenceTradeObserved");
    expect(outcome.rejected?.relation).toBe("RETIRED");
    expect(outcome.rejected?.liveConnectionId).toBe("conn-b");
    // The raw frame survives even though nothing was applied (§8.3).
    expect(outcome.decoded.raw).toBe(tradeFrame({ t: 100 }));
    const metrics = feed.metrics(clock.peek());
    expect(metrics.frames.framesNotFromLiveConnection).toBe(1);
    expect(metrics.frames.tradesNormalized).toBe(0);
    // …and its ids were not mixed into the live connection's sequence state.
    expect(metrics.streams).toEqual([]);
  });

  it("does not let a retired socket's close disconnect the live feed", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-a");
    feed.onOpen("conn-a", clock.advance(1));
    feed.onClose("conn-a", clock.advance(1), { code: 1006 });
    feed.connecting("conn-b");
    feed.onOpen("conn-b", clock.advance(1));

    const outcome = feed.onClose("conn-a", clock.advance(1), { code: 1006, reason: "late" });

    expect(typesOf(outcome.emissions)).not.toContain("FeedDisconnected");
    expect(outcome.directive).toEqual({ kind: "NONE" });
    expect(outcome.rejected?.relation).toBe("RETIRED");
    expect(feed.state).toBe("OPEN");
    expect(feed.liveConnectionId).toBe("conn-b");
    // The live connection's disconnect count is untouched by another socket.
    expect(feed.metrics(clock.peek()).connections.disconnects).toBe(1);
  });

  it("retires the superseded socket when two sockets overlap", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-a");
    feed.onOpen("conn-a", clock.advance(1));
    // A make-before-break reconnect: conn-b opens while conn-a never closed.
    feed.connecting("conn-b");
    const opened = feed.onOpen("conn-b", clock.advance(1));
    expect(opened.rejected).toBeUndefined();
    expect(feed.liveConnectionId).toBe("conn-b");
    expect(feed.subscriptionGeneration).toBe(1);

    const message = feed.onFrame("conn-a", tradeFrame({ t: 7 }), clock.advance(1));
    expect(message.classification).toBe("STALE_CONNECTION");
    const error = feed.onSocketError("conn-a", clock.advance(1), { detail: "late error" });
    expect(error.rejected?.relation).toBe("RETIRED");
    expect(feed.metrics(clock.peek()).connections.socketErrors).toBe(0);
  });

  it("refuses a second OPEN carrying the identity of the live connection", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-a");
    feed.onOpen("conn-a", clock.advance(1));
    const outcome = feed.onOpen("conn-a", clock.advance(1));

    expect(outcome.rejected?.relation).toBe("LIVE");
    expect(typesOf(outcome.emissions)).not.toContain("FeedConnected");
    // A repeat open is not a resubscription, so it creates no generation.
    expect(feed.subscriptionGeneration).toBe(0);
    expect(feed.metrics(clock.peek()).connections.connectionsOpened).toBe(1);
  });

  it("never revives a retired connection id", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-a");
    feed.onOpen("conn-a", clock.advance(1));
    feed.onClose("conn-a", clock.advance(1));
    // The caller registered conn-b for the replacement attempt; the transport
    // announces the RETIRED conn-a instead.
    feed.connecting("conn-b");
    const outcome = feed.onOpen("conn-a", clock.advance(1));

    expect(outcome.rejected?.relation).toBe("RETIRED");
    expect(feed.liveConnectionId).toBeUndefined();
    expect(feed.state).not.toBe("OPEN");
    expect(feed.metrics(clock.peek()).connections.connectionsOpened).toBe(1);
  });

  it("still accepts the close of an attempt that never opened, so a failed connect reconnects", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-attempt");
    const error = feed.onSocketError("conn-attempt", clock.advance(1), {
      detail: "connect ECONNREFUSED",
    });
    expect(error.rejected).toBeUndefined();
    const outcome = feed.onClose("conn-attempt", clock.advance(1), { code: 1006 });

    expect(typesOf(outcome.emissions)).toEqual(["FeedDisconnected"]);
    expect(outcome.directive).toEqual({ kind: "RECONNECT_AFTER", delayMs: 1_000, attempt: 1 });
    // The disconnect names the socket it belongs to, not a previous one.
    expect(
      (outcome.emissions[0]?.payload as { connectionId: string }).connectionId,
    ).toBe("conn-attempt");
  });

  it("refuses a foreign socket's error while a connection is live", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-a");
    feed.onOpen("conn-a", clock.advance(1));
    const outcome = feed.onSocketError("conn-elsewhere", clock.advance(1), { detail: "noise" });

    expect(outcome.rejected?.relation).toBe("UNKNOWN");
    expect(feed.metrics(clock.peek()).connections.socketErrors).toBe(0);
  });

  it("does not let a retired socket's frame re-arm the staleness clock", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 10_000 });
    feed.connecting("conn-a");
    feed.onOpen("conn-a", clock.advance(1));
    feed.onClose("conn-a", clock.advance(1));
    feed.connecting("conn-b");
    feed.onOpen("conn-b", clock.advance(1));
    feed.onFrame("conn-b", tradeFrame({ t: 1 }), clock.advance(1));

    clock.advance(9_000);
    feed.onFrame("conn-a", tradeFrame({ t: 2 }), clock.peek());
    // A dead socket's message is not evidence that the live one is alive.
    expect(typesOf(feed.checkStaleness(clock.advance(1_000)).emissions)).toEqual(["FeedStale"]);
  });

  it("classifies a frame that arrives with no live socket instead of throwing", () => {
    const clock = createManualClock();
    const feed = newFeed();
    let outcome: FrameOutcome | undefined;
    expect(() => {
      outcome = feed.onFrame("conn-1", tradeFrame(), clock.advance(1));
    }).not.toThrow();

    expect(outcome?.classification).toBe("STALE_CONNECTION");
    expect(outcome?.decoded.kind).toBe("TRADE");
    const reason = (outcome?.emissions[0]?.payload as { reasonCode: string }).reasonCode;
    expect(reason).toBe(BINANCE_REASON_CODES.frameWithoutConnection);
    expect(feed.metrics(clock.peek()).frames.tradesNormalized).toBe(0);
  });

  it("classifies an OPEN on a closed feed instead of throwing", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.advance(1));
    feed.close(clock.advance(1));

    const outcome = feed.onOpen("conn-2", clock.advance(1));
    expect(outcome.rejected?.eventType).toBe("OPEN");
    expect(outcome.directive).toEqual({ kind: "STOP", reason: "CLOSED_BY_CALLER" });
    expect(feed.state).toBe("CLOSED");
  });

  it("drives every socket event through one entry point, using the event's own identity", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-a");
    feed.handleSocketEvent({ type: "OPEN", connectionId: "conn-a" }, clock.advance(1));
    const applied = feed.handleSocketEvent(
      { type: "MESSAGE", connectionId: "conn-a", data: tradeFrame({ t: 5 }) },
      clock.advance(1),
    );
    const refused = feed.handleSocketEvent(
      { type: "MESSAGE", connectionId: "conn-ghost", data: tradeFrame({ t: 6 }) },
      clock.advance(1),
    );

    expect(typesOf(applied.emissions)).toEqual(["ReferenceTradeObserved"]);
    expect(refused.rejected?.connectionId).toBe("conn-ghost");
    expect(typesOf(refused.emissions)).not.toContain("ReferenceTradeObserved");
  });
});

/**
 * Being unrecognised is not a licence (round-2 review, finding R2-M1).
 *
 * Round 1 correlated events to the LIVE socket, which closed the retired-socket
 * hole but left the other half open: whenever nothing was live, any well-formed
 * identity was accepted. A forged close on a fresh feed disconnected it and
 * directed a reconnect; a forged close during a replacement's connecting
 * interval spent the caller's last reconnect attempt; a forged error after
 * shutdown was counted as the feed's; and an identity evicted from the bounded
 * retired memory could OPEN, supersede the live socket, and advance the
 * subscription generation. Authorization now comes from a registered attempt —
 * `connecting(connectionId)` — so each of the four probes is a refusal.
 */
describe("connection authorization (round-2 review, R2-M1)", () => {
  const FORGED = "forged-identity";

  /** Drives all four socket-event types under one identity. */
  function driveAllFour(
    feed: BinanceReferenceFeed,
    clock: ReturnType<typeof createManualClock>,
    connectionId: string,
  ): {
    open: ReturnType<BinanceReferenceFeed["onOpen"]>;
    message: FrameOutcome;
    error: ReturnType<BinanceReferenceFeed["onSocketError"]>;
    close: ReturnType<BinanceReferenceFeed["onClose"]>;
  } {
    return {
      open: feed.onOpen(connectionId, clock.advance(1)),
      message: feed.onFrame(connectionId, tradeFrame({ t: 1 }), clock.advance(1)),
      error: feed.onSocketError(connectionId, clock.advance(1), { detail: "forged" }),
      close: feed.onClose(connectionId, clock.advance(1), { code: 1006 }),
    };
  }

  it("refuses all four event types on a fresh IDLE feed that authorized nothing", () => {
    const clock = createManualClock();
    const feed = newFeed();
    const outcomes = driveAllFour(feed, clock, FORGED);

    for (const outcome of Object.values(outcomes)) {
      expect(outcome.rejected?.relation).toBe("UNKNOWN");
      expect(outcome.rejected?.pendingConnectionId).toBeUndefined();
      expect(typesOf(outcome.emissions)).not.toContain("FeedDisconnected");
      expect(typesOf(outcome.emissions)).not.toContain("FeedConnected");
      expect(outcome.directive).toEqual({ kind: "NONE" });
    }
    expect(outcomes.message.classification).toBe("STALE_CONNECTION");
    expect(feed.state).toBe("IDLE");
    expect(feed.liveConnectionId).toBeUndefined();

    const metrics = feed.metrics(clock.peek());
    expect(metrics.connections.connectionAttempts).toBe(0);
    expect(metrics.connections.connectionsOpened).toBe(0);
    expect(metrics.connections.disconnects).toBe(0);
    expect(metrics.connections.socketErrors).toBe(0);
    // Refused, but never silently: three lifecycle refusals and one frame.
    expect(metrics.connections.lifecycleEventsNotFromLiveConnection).toBe(3);
    expect(metrics.frames.framesNotFromLiveConnection).toBe(1);
    expect(metrics.openIncidentReasonCodes).toContain(
      BINANCE_REASON_CODES.unauthorizedConnectionEvent,
    );
  });

  it("does not let a forged close spend the reconnect budget during a connecting interval", () => {
    const clock = createManualClock();
    const feed = newFeed({
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, multiplier: 2, maxAttempts: 1 },
    });
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.advance(1));
    expect(feed.onClose("conn-1", clock.advance(1), { code: 1006 }).directive).toEqual({
      kind: "RECONNECT_AFTER",
      delayMs: 10,
      attempt: 1,
    });

    // The replacement attempt is registered but has not opened yet.
    feed.connecting("conn-2");
    const outcomes = driveAllFour(feed, clock, FORGED);
    for (const outcome of Object.values(outcomes)) {
      expect(outcome.rejected?.relation).toBe("UNKNOWN");
      expect(outcome.rejected?.pendingConnectionId).toBe("conn-2");
      expect(typesOf(outcome.emissions)).not.toContain("FeedDisconnected");
      expect(outcome.directive).toEqual({ kind: "NONE" });
    }
    expect(feed.metrics(clock.peek()).connections.disconnects).toBe(1);

    // The AUTHORIZED attempt's own failure is still applied, and the budget the
    // forgery could not spend is still there to be spent by it.
    const authorized = feed.onClose("conn-2", clock.advance(1), { code: 1006 });
    expect(typesOf(authorized.emissions)).toEqual(["FeedDisconnected"]);
    expect(authorized.directive).toEqual({
      kind: "STOP",
      reason: "RECONNECT_ATTEMPTS_EXHAUSTED",
    });
  });

  it("refuses all four event types after the caller shut the feed down", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.advance(1));
    feed.close(clock.advance(1), "operator shutdown");

    const outcomes = driveAllFour(feed, clock, FORGED);
    for (const outcome of Object.values(outcomes)) {
      expect(outcome.rejected?.relation).toBe("UNKNOWN");
      expect(typesOf(outcome.emissions)).not.toContain("FeedDisconnected");
      expect(typesOf(outcome.emissions)).not.toContain("FeedConnected");
    }
    // A closed feed says so, rather than leaving the driver to infer it.
    for (const outcome of [outcomes.open, outcomes.error, outcomes.close]) {
      expect(outcome.directive).toEqual({ kind: "STOP", reason: "CLOSED_BY_CALLER" });
    }
    expect(feed.state).toBe("CLOSED");
    const metrics = feed.metrics(clock.peek());
    expect(metrics.connections.socketErrors).toBe(0);
    expect(metrics.connections.disconnects).toBe(0);
    expect(metrics.connections.connectionsOpened).toBe(1);
  });

  it("stays quiet about the caller's own socket closing after a deliberate shutdown", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.advance(1));
    feed.close(clock.advance(1), "operator shutdown");

    // The transport reports the close of the socket the caller just closed: the
    // expected epilogue of a shutdown, not an anomaly to count and report.
    const outcome = feed.onClose("conn-1", clock.advance(1), { code: 1000 });
    expect(outcome.emissions).toEqual([]);
    expect(outcome.rejected).toBeUndefined();
    expect(outcome.directive).toEqual({ kind: "STOP", reason: "CLOSED_BY_CALLER" });
    expect(
      feed.metrics(clock.peek()).connections.lifecycleEventsNotFromLiveConnection,
    ).toBe(0);
  });

  it("revokes an outstanding authorization when the caller shuts the feed down", () => {
    const clock = createManualClock();
    const feed = newFeed();
    // An attempt is in flight when the operator shuts the feed down.
    feed.connecting("conn-attempt");
    feed.close(clock.advance(1), "operator shutdown");
    expect(feed.pendingConnectionId).toBeUndefined();

    const outcomes = driveAllFour(feed, clock, "conn-attempt");
    expect(outcomes.open.rejected?.relation).toBe("RETIRED");
    expect(typesOf(outcomes.open.emissions)).not.toContain("FeedConnected");
    expect(outcomes.message.classification).toBe("STALE_CONNECTION");
    expect(outcomes.error.rejected?.relation).toBe("RETIRED");
    // The abandoned socket's own close is the expected epilogue of a shutdown.
    expect(outcomes.close.emissions).toEqual([]);
    expect(outcomes.close.directive).toEqual({ kind: "STOP", reason: "CLOSED_BY_CALLER" });

    const metrics = feed.metrics(clock.peek());
    expect(metrics.connections.socketErrors).toBe(0);
    expect(metrics.connections.connectionsOpened).toBe(0);
    expect(metrics.connections.disconnects).toBe(0);
  });

  it("refuses an identity evicted from the bounded retired memory, OPEN included", () => {
    const clock = createManualClock();
    const feed = newFeed();
    // 257 connections retire the first identity out of the 256-entry FIFO.
    for (let index = 0; index < 257; index += 1) {
      const id = `conn-${String(index)}`;
      feed.connecting(id);
      feed.onOpen(id, clock.advance(1));
      feed.onClose(id, clock.advance(1));
    }
    feed.connecting("conn-live");
    feed.onOpen("conn-live", clock.advance(1));
    const generation = feed.subscriptionGeneration;

    const outcomes = driveAllFour(feed, clock, "conn-0");
    for (const outcome of Object.values(outcomes)) {
      // Evicted, so no longer RECOGNISED as retired — and refused all the same.
      expect(outcome.rejected?.relation).toBe("UNKNOWN");
      expect(typesOf(outcome.emissions)).not.toContain("FeedConnected");
      expect(typesOf(outcome.emissions)).not.toContain("FeedDisconnected");
    }
    // The live socket and its subscription generation are untouched: before the
    // fix this OPEN superseded conn-live and advanced the generation.
    expect(feed.liveConnectionId).toBe("conn-live");
    expect(feed.subscriptionGeneration).toBe(generation);
    expect(feed.state).toBe("OPEN");
    expect(feed.metrics(clock.peek()).connections.connectionsOpened).toBe(258);

    // An identity still inside the window is described as RETIRED, and refused
    // exactly the same way: the memory classifies, it does not authorize.
    const remembered = feed.onOpen("conn-256", clock.advance(1));
    expect(remembered.rejected?.relation).toBe("RETIRED");
    expect(feed.liveConnectionId).toBe("conn-live");
  });

  it("still applies the registered attempt's own pre-open failure", () => {
    const clock = createManualClock();
    const feed = newFeed();
    const attempt = feed.connecting("conn-attempt");
    expect(attempt.connectionId).toBe("conn-attempt");
    expect(feed.pendingConnectionId).toBe("conn-attempt");

    const error = feed.onSocketError("conn-attempt", clock.advance(1), {
      detail: "connect ECONNREFUSED",
    });
    expect(error.rejected).toBeUndefined();
    expect(feed.metrics(clock.peek()).connections.socketErrors).toBe(1);
    // An error does not resolve the attempt; the close that follows does.
    expect(feed.pendingConnectionId).toBe("conn-attempt");

    const close = feed.onClose("conn-attempt", clock.advance(1), { code: 1006 });
    expect(typesOf(close.emissions)).toEqual(["FeedDisconnected"]);
    expect(close.directive).toEqual({ kind: "RECONNECT_AFTER", delayMs: 1_000, attempt: 1 });
    expect(feed.pendingConnectionId).toBeUndefined();

    // Having resolved by failing, it authorizes nothing further.
    const late = feed.onOpen("conn-attempt", clock.advance(1));
    expect(late.rejected?.relation).toBe("RETIRED");
  });

  it("does not let a replacement attempt's failure disconnect the live socket", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 10_000 });
    feed.connecting("conn-a");
    feed.onOpen("conn-a", clock.advance(1));
    // A make-before-break replacement is registered and fails before it opens.
    feed.connecting("conn-b");
    const outcome = feed.onClose("conn-b", clock.advance(1), { code: 1006 });

    expect(outcome.rejected?.relation).toBe("PENDING");
    expect(typesOf(outcome.emissions)).not.toContain("FeedDisconnected");
    expect(outcome.directive).toEqual({ kind: "NONE" });
    expect(feed.liveConnectionId).toBe("conn-a");
    expect(feed.metrics(clock.peek()).connections.disconnects).toBe(0);

    // …and the socket that IS live is unaffected in every respect: the feed is
    // still OPEN, its frames are still normalized, and its silence is still
    // reported (round-3 review, R3-M1 — this test previously checked only the
    // live id and the disconnect counter).
    expect(feed.state).toBe("OPEN");
    const frame = feed.onFrame("conn-a", tradeFrame({ t: 4_242 }), clock.advance(1));
    expect(frame.classification).toBe("NORMALIZED");
    expect(typesOf(frame.emissions)).toEqual(["ReferenceTradeObserved"]);
    expect(typesOf(feed.checkStaleness(clock.advance(10_000)).emissions)).toEqual(["FeedStale"]);
  });

  it("registers an attempt only under an identity this feed has never seen", () => {
    const clock = createManualClock();
    const feed = newFeed();
    // A malformed identity cannot be registered at all.
    expect(() => feed.connecting("")).toThrow(BinanceConfigurationError);
    expect(() => feed.connecting("x".repeat(101))).toThrow(BinanceConfigurationError);
    expect(feed.metrics(clock.peek()).connections.connectionAttempts).toBe(0);

    feed.connecting("conn-a");
    // The attempt in flight is not registered twice.
    expect(() => feed.connecting("conn-a")).toThrow(BinanceStateError);
    feed.onOpen("conn-a", clock.advance(1));
    // Nor is the identity of the socket the feed is listening to.
    expect(() => feed.connecting("conn-a")).toThrow(BinanceStateError);

    feed.onClose("conn-a", clock.advance(1));
    // Nor a retired one: one connection id identifies exactly one connection.
    expect(() => feed.connecting("conn-a")).toThrow(BinanceStateError);
    expect(feed.metrics(clock.peek()).connections.connectionAttempts).toBe(1);
  });

  it("retires an attempt the caller abandoned by registering another", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-a");
    feed.connecting("conn-b");

    const abandoned = feed.onOpen("conn-a", clock.advance(1));
    expect(abandoned.rejected?.relation).toBe("RETIRED");
    expect(feed.liveConnectionId).toBeUndefined();

    const registered = feed.onOpen("conn-b", clock.advance(1));
    expect(registered.rejected).toBeUndefined();
    expect(feed.liveConnectionId).toBe("conn-b");
    expect(feed.pendingConnectionId).toBeUndefined();
  });
});

/**
 * A replacement attempt is not a disconnect (round-3 review, findings R3-M1/R3-L1).
 *
 * `connecting()` used to set the feed to `CONNECTING` even while a socket was
 * live, and both the frame gate and `checkStaleness()` require `OPEN`. The whole
 * make-before-break interval therefore threw away the live socket's market data
 * — reporting it, wrongly, as "a frame arrived with no live socket" — and
 * silenced staleness for that connection, indefinitely if the replacement never
 * resolved. The attempt in flight is now tracked only in `pendingConnectionId`,
 * orthogonally to the socket the feed is listening to.
 *
 * R3-L1 is the same episode's telemetry: the replacement's own refused events
 * were reported under `BINANCE_UNAUTHORIZED_CONNECTION_EVENT`, whose documented
 * meaning is an identity the feed "never authorized" — the opposite of an
 * identity the caller had just registered.
 */
describe("make-before-break replacement (round-3 review, R3-M1/R3-L1)", () => {
  /** Opens `conn-live` and registers a replacement without opening it. */
  function replacementRegistered(): {
    feed: BinanceReferenceFeed;
    clock: ReturnType<typeof createManualClock>;
  } {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 10_000 });
    feed.connecting("conn-live");
    feed.onOpen("conn-live", clock.advance(1));
    feed.connecting("conn-replacement");
    return { feed, clock };
  }

  it("keeps the feed OPEN and the live socket's frames flowing while a replacement is registered", () => {
    const { feed, clock } = replacementRegistered();

    // The state describes the SOCKET, and that socket is open.
    expect(feed.state).toBe("OPEN");
    expect(feed.liveConnectionId).toBe("conn-live");
    expect(feed.pendingConnectionId).toBe("conn-replacement");

    const during = feed.onFrame("conn-live", tradeFrame({ t: 1 }), clock.advance(1));
    expect(during.classification).toBe("NORMALIZED");
    expect(during.rejected).toBeUndefined();
    expect(typesOf(during.emissions)).toEqual(["ReferenceTradeObserved"]);

    // The replacement fails before it opens; the refusal disconnects nothing…
    const refused = feed.onClose("conn-replacement", clock.advance(1), { code: 1006 });
    expect(refused.rejected?.relation).toBe("PENDING");
    expect(refused.directive).toEqual({ kind: "NONE" });

    // …and the live socket is still heard AFTER that refusal, which is where the
    // old behavior discarded market data indefinitely.
    const after = feed.onFrame("conn-live", tradeFrame({ t: 2 }), clock.advance(1));
    expect(after.classification).toBe("NORMALIZED");
    expect(typesOf(after.emissions)).toEqual(["ReferenceTradeObserved"]);

    const metrics = feed.metrics(clock.peek());
    expect(metrics.state).toBe("OPEN");
    expect(metrics.frames.tradesNormalized).toBe(2);
    expect(metrics.frames.framesNotFromLiveConnection).toBe(0);
  });

  it("keeps the live socket's staleness clock running and re-armed across the registration", () => {
    const { feed, clock } = replacementRegistered();

    // A frame from the live socket re-arms staleness, exactly as before.
    feed.onFrame("conn-live", tradeFrame({ t: 1 }), clock.advance(5_000));
    expect(feed.checkStaleness(clock.advance(9_999)).emissions).toEqual([]);
    expect(typesOf(feed.checkStaleness(clock.advance(1)).emissions)).toEqual(["FeedStale"]);

    // The refused pre-open failure of the replacement does not stop the clock.
    feed.onClose("conn-replacement", clock.advance(1), { code: 1006 });
    feed.onFrame("conn-live", tradeFrame({ t: 2 }), clock.advance(1));
    expect(typesOf(feed.checkStaleness(clock.advance(10_000)).emissions)).toEqual(["FeedStale"]);
    expect(feed.metrics(clock.peek()).connections.staleEpisodes).toBe(2);
  });

  it("reports the attempt in flight BESIDE the live socket, not instead of it", () => {
    const { feed, clock } = replacementRegistered();
    const metrics = feed.metrics(clock.peek());

    expect(metrics.state).toBe("OPEN");
    expect(metrics.connectionId).toBe("conn-live");
    expect(metrics.pendingConnectionId).toBe("conn-replacement");
    // The attempt was still counted; only the state stopped lying about it.
    expect(metrics.connections.connectionAttempts).toBe(2);
  });

  it("still becomes CONNECTING when the attempt really is the only connection", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    expect(feed.state).toBe("CONNECTING");

    feed.onOpen("conn-1", clock.advance(1));
    feed.onClose("conn-1", clock.advance(1), { code: 1006 });
    expect(feed.state).toBe("IDLE");

    feed.connecting("conn-2");
    expect(feed.state).toBe("CONNECTING");
    expect(feed.liveConnectionId).toBeUndefined();
    // With nothing live, a frame is still refused and still reported as a frame
    // that arrived with no live socket.
    const orphan = feed.onFrame("conn-2", tradeFrame({ t: 3 }), clock.advance(1));
    expect(orphan.classification).toBe("STALE_CONNECTION");
    expect((orphan.emissions[0]?.payload as { reasonCode: string }).reasonCode).toBe(
      BINANCE_REASON_CODES.frameWithoutConnection,
    );
  });

  it("adopts the replacement when it finally opens, retiring the socket it replaces", () => {
    const { feed, clock } = replacementRegistered();
    feed.onFrame("conn-live", tradeFrame({ t: 1 }), clock.advance(1));

    const opened = feed.onOpen("conn-replacement", clock.advance(1));
    expect(opened.rejected).toBeUndefined();
    expect(typesOf(opened.emissions)).toContain("FeedConnected");
    expect(feed.liveConnectionId).toBe("conn-replacement");
    expect(feed.pendingConnectionId).toBeUndefined();
    expect(feed.subscriptionGeneration).toBe(1);

    // The superseded socket is retired the moment the replacement opens, and not
    // one event earlier.
    const late = feed.onFrame("conn-live", tradeFrame({ t: 2 }), clock.advance(1));
    expect(late.classification).toBe("STALE_CONNECTION");
    expect(late.rejected?.relation).toBe("RETIRED");
  });

  it("reports an authorized attempt's inadmissible event under its own reason code (R3-L1)", () => {
    const { feed, clock } = replacementRegistered();

    const close = feed.onClose("conn-replacement", clock.advance(1), { code: 1006 });
    const incident = close.emissions[0]?.payload as { reasonCode: string; detail: string };
    expect(incident.reasonCode).toBe(BINANCE_REASON_CODES.pendingAttemptEventInadmissible);
    // The identity was registered by the caller; saying otherwise was the bug.
    expect(incident.detail).not.toContain("nor authorized");
    expect(incident.detail).toContain("registered attempt");
    expect(close.rejected?.relation).toBe("PENDING");
    expect(close.rejected?.pendingConnectionId).toBe("conn-replacement");

    // A genuinely unknown identity on the SAME feed keeps the unauthorized code,
    // so the two conditions stay distinguishable in the telemetry.
    const forged = feed.onClose("forged-identity", clock.advance(1), { code: 1006 });
    expect(forged.rejected?.relation).toBe("UNKNOWN");
    expect((forged.emissions[0]?.payload as { reasonCode: string }).reasonCode).toBe(
      BINANCE_REASON_CODES.unauthorizedConnectionEvent,
    );
    expect(feed.metrics(clock.peek()).openIncidentReasonCodes).toEqual(
      expect.arrayContaining([
        BINANCE_REASON_CODES.pendingAttemptEventInadmissible,
        BINANCE_REASON_CODES.unauthorizedConnectionEvent,
      ]),
    );
  });

  it("uses the same code for a frame from an attempt that has not announced its OPEN", () => {
    const { feed, clock } = replacementRegistered();
    const early = feed.onFrame("conn-replacement", tradeFrame({ t: 5 }), clock.advance(1));

    expect(early.classification).toBe("STALE_CONNECTION");
    expect(early.rejected?.relation).toBe("PENDING");
    const incident = early.emissions[0]?.payload as { reasonCode: string };
    // Not `frameWithoutConnection`: a socket IS live, and it is not this one.
    expect(incident.reasonCode).toBe(BINANCE_REASON_CODES.pendingAttemptEventInadmissible);
    expect(feed.metrics(clock.peek()).frames.tradesNormalized).toBe(0);
  });

  it("leaves the refused attempt registered — the disclosed residual, with the feed still flowing", () => {
    const { feed, clock } = replacementRegistered();
    feed.onClose("conn-replacement", clock.advance(1), { code: 1006 });

    // A refusal mutates nothing, so the caller's own registration survives it.
    expect(feed.pendingConnectionId).toBe("conn-replacement");
    expect(feed.state).toBe("OPEN");
    expect(feed.liveConnectionId).toBe("conn-live");
    expect(feed.onFrame("conn-live", tradeFrame({ t: 9 }), clock.advance(1)).classification).toBe(
      "NORMALIZED",
    );

    // If that identity's socket does open after all, it is believed: the caller
    // authorized it. That is the residual, and it costs the live socket nothing
    // until the moment it is superseded.
    const opened = feed.onOpen("conn-replacement", clock.advance(1));
    expect(opened.rejected).toBeUndefined();
    expect(feed.liveConnectionId).toBe("conn-replacement");
  });
});

describe("frames", () => {
  function openFeed(): {
    feed: BinanceReferenceFeed;
    clock: ReturnType<typeof createManualClock>;
    connectionId: string;
  } {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    return { feed, clock, connectionId: "conn-1" };
  }

  it("normalizes a trade, preserving venue and receipt timestamps distinctly", () => {
    const { feed, clock } = openFeed();
    const receipt = clock.advance(5);
    const outcome = feed.onFrame("conn-1", tradeFrame(), receipt);

    expect(outcome.classification).toBe("NORMALIZED");
    const emission = outcome.emissions[0];
    if (emission === undefined) {
      throw new Error("expected an emission");
    }
    expect(emission.eventType).toBe("ReferenceTradeObserved");
    expect(emission.venueTimestamp).toBe("2022-12-31T19:43:02.136Z");
    expect(emission.receivedAt).toBe(receipt.receivedAt);
    expect(emission.receivedMonotonicNs).toBe(receipt.receivedMonotonicNs);
    expect(emission.venueTimestamp).not.toBe(emission.receivedAt);
    expect(emission.sourceChannel).toBe("btcusdt@trade");
    expect(emission.subscriptionGeneration).toBe(0);
    expect(emission.connectionId).toBe("conn-1");
  });

  it("normalizes a bookTicker with NO venue timestamp, never substituting the receipt time", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame("conn-1", bookTickerFrame(), clock.advance(5));
    expect(outcome.classification).toBe("NORMALIZED");
    const emission = outcome.emissions[0];
    if (emission === undefined) {
      throw new Error("expected an emission");
    }
    expect(emission.eventType).toBe("ReferenceTopOfBookChanged");
    expect("venueTimestamp" in emission).toBe(false);
    expect(emission.receivedAt.length).toBeGreaterThan(0);
  });

  it("suppresses an exact duplicate trade and reports it as a classification", () => {
    const { feed, clock } = openFeed();
    feed.onFrame("conn-1", tradeFrame(), clock.advance(1));
    const outcome = feed.onFrame("conn-1", tradeFrame(), clock.advance(1));

    expect(outcome.classification).toBe("DUPLICATE_SUPPRESSED");
    expect(outcome.emissions).toEqual([]);
    expect(outcome.sequence?.outcome).toBe("DUPLICATE");
    expect(feed.metrics(clock.peek()).frames.duplicatesSuppressed).toBe(1);
  });

  it("suppresses a DELAYED duplicate — one that is no longer the latest id (M2)", () => {
    const { feed, clock } = openFeed();
    const emitted: unknown[] = [];
    for (const t of [100, 101, 100]) {
      const outcome = feed.onFrame("conn-1", tradeFrame({ t }), clock.advance(1));
      for (const emission of outcome.emissions) {
        if (emission.eventType === "ReferenceTradeObserved") {
          emitted.push((emission.payload as { venueTradeId: string }).venueTradeId);
        }
      }
      if (t === 100 && emitted.length > 1) {
        expect(outcome.classification).toBe("DUPLICATE_SUPPRESSED");
      }
    }
    // Two distinct trades, published once each: the venue trade id decides,
    // not the order the frames happened to arrive in.
    expect(emitted).toEqual(["100", "101"]);
    expect(feed.metrics(clock.peek()).frames.duplicatesSuppressed).toBe(1);
    expect(feed.metrics(clock.peek()).frames.lateTradesEmitted).toBe(0);
  });

  it("reports a DELAYED repeat with different content as a conflict, not as a late trade", () => {
    const { feed, clock } = openFeed();
    feed.onFrame("conn-1", tradeFrame({ t: 100 }), clock.advance(1));
    feed.onFrame("conn-1", tradeFrame({ t: 101 }), clock.advance(1));
    const outcome = feed.onFrame("conn-1", tradeFrame({ t: 100, p: "0.002" }), clock.advance(1));

    expect(outcome.classification).toBe("CONFLICTING_DUPLICATE");
    expect(outcome.sequence?.previouslySeen).toBe(true);
    expect(typesOf(outcome.emissions)).toEqual(["DataQualityIncidentOpened"]);
  });

  it("opens an incident when the venue repeats an id with different content", () => {
    const { feed, clock } = openFeed();
    feed.onFrame("conn-1", tradeFrame(), clock.advance(1));
    const outcome = feed.onFrame("conn-1", tradeFrame({ p: "0.002" }), clock.advance(1));

    expect(outcome.classification).toBe("CONFLICTING_DUPLICATE");
    expect(typesOf(outcome.emissions)).toEqual(["DataQualityIncidentOpened"]);
    const incident = outcome.emissions[0]?.payload as { reasonCode: string };
    expect(incident.reasonCode).toBe(BINANCE_REASON_CODES.sequenceConflict);
  });

  it("publishes a LATE trade — a trade is a point observation, not versioned state", () => {
    const { feed, clock } = openFeed();
    feed.onFrame("conn-1", tradeFrame({ t: 100 }), clock.advance(1));
    const outcome = feed.onFrame("conn-1", tradeFrame({ t: 99, p: "0.002" }), clock.advance(1));

    expect(outcome.classification).toBe("NORMALIZED");
    expect(outcome.sequence?.outcome).toBe("REGRESSED");
    expect(outcome.sequence?.previouslySeen).toBe(false);
    expect(feed.metrics(clock.peek()).frames.lateTradesEmitted).toBe(1);
  });

  it("SUPPRESSES a stale top of book — applying it would overwrite newer state", () => {
    const { feed, clock } = openFeed();
    feed.onFrame("conn-1", bookTickerFrame({ u: 200 }), clock.advance(1));
    const outcome = feed.onFrame("conn-1", bookTickerFrame({ u: 199, b: "24" }), clock.advance(1));

    expect(outcome.classification).toBe("STALE_SUPPRESSED");
    expect(outcome.emissions).toEqual([]);
    expect(feed.metrics(clock.peek()).frames.staleUpdatesSuppressed).toBe(1);
  });

  it("does not treat a jump in the venue id as a gap (BNC-U2/BNC-U3)", () => {
    const { feed, clock } = openFeed();
    feed.onFrame("conn-1", tradeFrame({ t: 1 }), clock.advance(1));
    const outcome = feed.onFrame("conn-1", tradeFrame({ t: 5_000_000 }), clock.advance(1));

    expect(outcome.classification).toBe("NORMALIZED");
    expect(typesOf(outcome.emissions)).toEqual(["ReferenceTradeObserved"]);
    expect(typesOf(outcome.emissions)).not.toContain("FeedGapDetected");
  });

  it("routes a malformed frame to an incident and preserves the raw frame", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame("conn-1", "not json at all", clock.advance(1));

    expect(outcome.classification).toBe("MALFORMED");
    expect(typesOf(outcome.emissions)).toEqual(["DataQualityIncidentOpened"]);
    expect(outcome.decoded.raw).toBe("not json at all");
    const incident = outcome.emissions[0]?.payload as { detail: string };
    expect(incident.detail).toContain("not json at all");
  });

  it("routes an unknown event type to an incident as first-class UNKNOWN (ADR-002 §7)", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame(
      "conn-1",
      JSON.stringify({ stream: "btcusdt@kline_1m", data: { e: "kline", E: 1 } }),
      clock.advance(1),
    );
    expect(outcome.classification).toBe("UNKNOWN");
    const incident = outcome.emissions[0]?.payload as { reasonCode: string };
    expect(incident.reasonCode).toBe(BINANCE_REASON_CODES.frameUnknown);
  });

  it("reports an added venue field once, at LOG severity, without rejecting the frame", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame("conn-1", bookTickerFrame({ E: 1, T: 2 }), clock.advance(1));

    expect(outcome.classification).toBe("NORMALIZED");
    expect(typesOf(outcome.emissions)).toEqual([
      "DataQualityIncidentOpened",
      "ReferenceTopOfBookChanged",
    ]);
    const incident = outcome.emissions[0]?.payload as { reasonCode: string; severity: string };
    expect(incident.reasonCode).toBe(BINANCE_REASON_CODES.frameUnknownFields);
    expect(incident.severity).toBe("LOG");
  });

  it("surfaces the documented serverShutdown advisory instead of acting on it", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame(
      "conn-1",
      JSON.stringify({ e: "serverShutdown", E: 1_770_123_456_789 }),
      clock.advance(1),
    );
    expect(outcome.classification).toBe("SERVER_SHUTDOWN");
    expect(outcome.advisory).toBe("ESTABLISH_NEW_CONNECTION");
    expect(outcome.directive).toEqual({ kind: "NONE" });
  });

  it("opens one incident per reason code per connection, and counts every occurrence", () => {
    const { feed, clock } = openFeed();
    const first = feed.onFrame("conn-1", "bad", clock.advance(1));
    const second = feed.onFrame("conn-1", "also bad", clock.advance(1));

    expect(typesOf(first.emissions)).toEqual(["DataQualityIncidentOpened"]);
    expect(second.emissions).toEqual([]);
    // Suppressing the repeat is not a silent drop: it is classified and counted.
    expect(second.classification).toBe("MALFORMED");
    expect(feed.metrics(clock.peek()).frames.malformedFrames).toBe(2);
  });

  it("classifies every frame it is given — no input returns nothing", () => {
    const { feed, clock } = openFeed();
    const outcomes: FrameOutcome[] = [
      feed.onFrame("conn-1", tradeFrame(), clock.advance(1)),
      feed.onFrame("conn-1", bookTickerFrame(), clock.advance(1)),
      feed.onFrame("conn-1", '{"result":null,"id":1}', clock.advance(1)),
      feed.onFrame(
        "conn-1",
        '{"code":2,"msg":"Invalid request: too many parameters"}',
        clock.advance(1),
      ),
      feed.onFrame("conn-1", "{", clock.advance(1)),
      feed.onFrame("conn-1", '{"nothing":"documented"}', clock.advance(1)),
    ];
    expect(outcomes.map((outcome) => outcome.classification)).toEqual([
      "NORMALIZED",
      "NORMALIZED",
      "CONTROL",
      "CONTROL",
      "MALFORMED",
      "UNKNOWN",
    ]);
    expect(feed.metrics(clock.peek()).frames.framesReceived).toBe(6);
  });

  it("never throws on any frame, however hostile", () => {
    const { feed, clock } = openFeed();
    for (const raw of ["", "{", "null", "[]", '{"stream":"x"}', '{"stream":1,"data":{}}']) {
      expect(() => feed.onFrame("conn-1", raw, clock.advance(1))).not.toThrow();
    }
  });
});

describe("channel provenance (round-1 review, M1)", () => {
  function openFeed(): {
    feed: BinanceReferenceFeed;
    clock: ReturnType<typeof createManualClock>;
  } {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    return { feed, clock };
  }

  it("refuses a wrapper that names a different symbol than the payload", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame("conn-1", tradeFrame({}, "ethusdt@trade"), clock.advance(1));

    expect(outcome.classification).toBe("MALFORMED");
    expect(typesOf(outcome.emissions)).not.toContain("ReferenceTradeObserved");
    expect(outcome.decoded.kind).toBe("MALFORMED");
    if (outcome.decoded.kind !== "MALFORMED") {
      throw new Error("unreachable");
    }
    expect(outcome.decoded.reason).toBe("CHANNEL_MISMATCH");
  });

  it("refuses a wrapper that names a different stream type than the payload", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame("conn-1", tradeFrame({}, "btcusdt@bookTicker"), clock.advance(1));
    expect(outcome.classification).toBe("MALFORMED");
  });

  it("refuses a wrapper that is not a documented lowercase stream name", () => {
    const { feed, clock } = openFeed();
    // The venue documents "All symbols for streams are lowercase", so an
    // uppercase or free-text wrapper contradicts the payload it wraps.
    for (const stream of ["BTCUSDT@trade", "totally-unknown"]) {
      const outcome = feed.onFrame("conn-1", tradeFrame({}, stream), clock.advance(1));
      expect(outcome.classification, stream).toBe("MALFORMED");
      expect(typesOf(outcome.emissions), stream).not.toContain("ReferenceTradeObserved");
    }
    // An empty `stream` is not a combined wrapper at all: the frame matches no
    // documented shape and is reported as UNKNOWN rather than published.
    const empty = feed.onFrame("conn-1", tradeFrame({}, ""), clock.advance(1));
    expect(empty.classification).toBe("UNKNOWN");
    expect(typesOf(empty.emissions)).not.toContain("ReferenceTradeObserved");
  });

  it("refuses a frame for a channel this connection never subscribed to", () => {
    const clock = createManualClock();
    const feed = newFeed({ subscriptions: [{ symbol: "BTCUSDT", suffix: "trade" }] });
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());

    // A well-formed, self-consistent bookTicker frame — for a stream the URL
    // never asked for.
    const outcome = feed.onFrame("conn-1", bookTickerFrame(), clock.advance(1));
    expect(outcome.classification).toBe("MALFORMED");
    if (outcome.decoded.kind !== "MALFORMED") {
      throw new Error("unreachable");
    }
    expect(outcome.decoded.reason).toBe("CHANNEL_NOT_SUBSCRIBED");
  });

  it("accepts an unwrapped frame whose reconstructed channel is subscribed", () => {
    const { feed, clock } = openFeed();
    const raw = JSON.stringify({
      e: "trade",
      E: 1_672_515_782_136,
      s: "BTCUSDT",
      t: 1,
      p: "0.001",
      q: "100",
      T: 1_672_515_782_136,
      m: true,
    });
    const outcome = feed.onFrame("conn-1", raw, clock.advance(1));
    expect(outcome.classification).toBe("NORMALIZED");
    expect(outcome.decoded.channelSource).toBe("RECONSTRUCTED");
    expect(outcome.emissions[0]?.sourceChannel).toBe("btcusdt@trade");
  });

  it("never records an unverifiable wrapper name as an event's sourceChannel", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame(
      "conn-1",
      JSON.stringify({ stream: "!serverShutdown", data: { e: "serverShutdown", E: 1 } }),
      clock.advance(1),
    );

    expect(outcome.classification).toBe("SERVER_SHUTDOWN");
    expect(outcome.decoded.channelSource).toBe("UNVERIFIED_WRAPPER");
    expect(outcome.decoded.streamName).toBe("!serverShutdown");
    for (const emission of outcome.emissions) {
      expect(emission.sourceChannel).toBe("binance:stream-connection");
    }
  });
});

describe("disconnect and reconnect", () => {
  it("emits FeedDisconnected and directs a backed-off reconnect", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    const outcome = feed.onClose("conn-1", clock.advance(10), { code: 1006, reason: "abnormal" });

    expect(typesOf(outcome.emissions)).toEqual(["FeedDisconnected"]);
    expect(outcome.directive).toEqual({ kind: "RECONNECT_AFTER", delayMs: 1_000, attempt: 1 });
  });

  it("backs off further on consecutive failures and resets after a successful open", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());

    expect(feed.onClose("conn-1", clock.advance(1)).directive).toEqual({
      kind: "RECONNECT_AFTER",
      delayMs: 1_000,
      attempt: 1,
    });
    // The retry's socket fails before it ever opens: a second consecutive
    // failure, reported by the socket that failed.
    feed.connecting("conn-2");
    expect(feed.onClose("conn-2", clock.advance(1)).directive).toEqual({
      kind: "RECONNECT_AFTER",
      delayMs: 2_000,
      attempt: 2,
    });

    feed.connecting("conn-3");
    feed.onOpen("conn-3", clock.advance(1));
    expect(feed.onClose("conn-3", clock.advance(1)).directive).toEqual({
      kind: "RECONNECT_AFTER",
      delayMs: 1_000,
      attempt: 1,
    });
  });

  it("does not advance the backoff when the same socket closes twice", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    feed.onClose("conn-1", clock.advance(1));
    const repeat = feed.onClose("conn-1", clock.advance(1));

    expect(repeat.rejected?.relation).toBe("RETIRED");
    expect(repeat.directive).toEqual({ kind: "NONE" });
    expect(feed.metrics(clock.peek()).connections.disconnects).toBe(1);
  });

  it("stops after the caller's attempt budget, and says why", () => {
    const clock = createManualClock();
    const feed = newFeed({
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, multiplier: 2, maxAttempts: 1 },
    });
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    feed.onClose("conn-1", clock.advance(1));
    feed.connecting("conn-2");
    const outcome = feed.onClose("conn-2", clock.advance(1));
    expect(outcome.directive).toEqual({
      kind: "STOP",
      reason: "RECONNECT_ATTEMPTS_EXHAUSTED",
    });
  });

  it("stops and does not reconnect when the caller closes the feed", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    const outcome = feed.close(clock.advance(1), "operator shutdown");

    expect(typesOf(outcome.emissions)).toEqual(["FeedDisconnected"]);
    expect(outcome.directive).toEqual({ kind: "STOP", reason: "CLOSED_BY_CALLER" });
    expect(feed.state).toBe("CLOSED");
    expect(() => feed.connecting("conn-2")).toThrow(BinanceStateError);
  });

  it("remembers venue ids across a reconnect, so a replayed frame is still a duplicate", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame("conn-1", tradeFrame({ t: 42 }), clock.advance(1));
    feed.onClose("conn-1", clock.advance(1));
    feed.connecting("conn-2");
    feed.onOpen("conn-2", clock.advance(1_000));

    const outcome = feed.onFrame("conn-2", tradeFrame({ t: 42 }), clock.advance(1));
    expect(outcome.classification).toBe("DUPLICATE_SUPPRESSED");
  });

  it("recognises a replayed frame across a reconnect even when newer ids arrived first", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame("conn-1", tradeFrame({ t: 42 }), clock.advance(1));
    feed.onClose("conn-1", clock.advance(1));
    feed.connecting("conn-2");
    feed.onOpen("conn-2", clock.advance(1_000));
    feed.onFrame("conn-2", tradeFrame({ t: 43 }), clock.advance(1));

    const outcome = feed.onFrame("conn-2", tradeFrame({ t: 42 }), clock.advance(1));
    expect(outcome.classification).toBe("DUPLICATE_SUPPRESSED");
    expect(outcome.emissions).toEqual([]);
  });
});

describe("staleness", () => {
  it("reports nothing before the caller's threshold is reached", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 10_000 });
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    expect(feed.checkStaleness(clock.advance(9_999)).emissions).toEqual([]);
  });

  it("emits FeedStale once per silence episode, re-armed by the next frame", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 10_000 });
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame("conn-1", tradeFrame(), clock.advance(1_000));

    const first = feed.checkStaleness(clock.advance(10_000));
    expect(typesOf(first.emissions)).toEqual(["FeedStale"]);
    const payload = first.emissions[0]?.payload as { stalenessMs: number; lastMessageAt: string };
    expect(payload.stalenessMs).toBe(10_000);
    expect(payload.lastMessageAt).toBe("2026-08-27T00:00:01.000Z");

    expect(feed.checkStaleness(clock.advance(5_000)).emissions).toEqual([]);

    feed.onFrame("conn-1", tradeFrame({ t: 99_999 }), clock.advance(1));
    expect(feed.checkStaleness(clock.advance(10_000)).emissions).toHaveLength(1);
    expect(feed.metrics(clock.peek()).connections.staleEpisodes).toBe(2);
  });

  it("measures staleness from the connect stamp before any frame has arrived", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 5_000 });
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    const outcome = feed.checkStaleness(clock.advance(5_000));
    expect(typesOf(outcome.emissions)).toEqual(["FeedStale"]);
    expect("lastMessageAt" in (outcome.emissions[0]?.payload as object)).toBe(false);
  });

  it("says nothing about staleness when the feed is not connected", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 1 });
    expect(feed.checkStaleness(clock.advance(1_000_000)).emissions).toEqual([]);
  });
});

describe("metrics", () => {
  it("reports staleness, generation, and per-stream sequence state", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 30_000 });
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame("conn-1", tradeFrame({ t: 7 }), clock.advance(1_000));
    feed.onFrame("conn-1", bookTickerFrame({ u: 11 }), clock.advance(1_000));

    const metrics = feed.metrics(clock.advance(4_000));
    expect(metrics.feedId).toBe("binance.reference");
    expect(metrics.state).toBe("OPEN");
    expect(metrics.connectionId).toBe("conn-1");
    expect(metrics.subscriptionGeneration).toBe(0);
    expect(metrics.stalenessMs).toBe(4_000);
    expect(metrics.stale).toBe(false);
    expect(metrics.connectionAgeMs).toBe(6_000);
    expect(metrics.connectionLifetimeRemainingMs).toBe(86_400_000 - 6_000);
    expect(metrics.frames.tradesNormalized).toBe(1);
    expect(metrics.frames.topOfBookNormalized).toBe(1);
    expect(metrics.frames.eventsEmitted).toBe(2);
    expect(metrics.streams).toEqual([
      {
        streamName: "btcusdt@bookTicker",
        lastVenueSequenceId: 11,
        observations: 1,
        recentIdsTracked: 1,
      },
      { streamName: "btcusdt@trade", lastVenueSequenceId: 7, observations: 1, recentIdsTracked: 1 },
    ]);
  });

  it("publishes the duplicate window's bound, so its reach is not assumed", () => {
    const clock = createManualClock();
    const feed = newFeed({ maxRecentIdsPerStream: 4 });
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    for (const t of [1, 2, 3, 4, 5, 6]) {
      feed.onFrame("conn-1", tradeFrame({ t }), clock.advance(1));
    }

    const metrics = feed.metrics(clock.peek());
    expect(metrics.maxRecentIdsPerStream).toBe(4);
    expect(metrics.streams[0]?.recentIdsTracked).toBe(4);
  });

  it("reports the venue-to-receipt lag from the last trade", () => {
    const clock = createManualClock({ startAt: "2022-12-31T19:43:02.000Z" });
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    // Venue trade time is …:02.136Z; the frame is received at …:02.436Z.
    feed.onFrame("conn-1", tradeFrame(), clock.advance(436));

    const metrics = feed.metrics(clock.peek());
    expect(metrics.lastVenueTimestamp).toBe("2022-12-31T19:43:02.136Z");
    expect(metrics.lastVenueToReceiptLagMs).toBe(300);
    expect(metrics.maxVenueToReceiptLagMs).toBe(300);
  });

  it("lists the reason codes with an incident still open", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame("conn-1", "bad", clock.advance(1));

    expect(feed.metrics(clock.peek()).openIncidentReasonCodes).toEqual([
      BINANCE_REASON_CODES.frameMalformed,
      BINANCE_REASON_CODES.subscriptionStart,
    ]);
  });
});

describe("the UNVERIFIED register describes what the code actually does", () => {
  it("BNC-U4 distinguishes one unusable book side from both (round-1 review, L1)", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting("conn-1");
    feed.onOpen("conn-1", clock.stamp());

    const oneSide = feed.onFrame(
      "conn-1",
      bookTickerFrame({ u: 1, b: "0.00000000", B: "0.00000000" }),
      clock.advance(1),
    );
    const bothSides = feed.onFrame(
      "conn-1",
      bookTickerFrame({
        u: 2,
        b: "0.00000000",
        B: "0.00000000",
        a: "0.00000000",
        A: "0.00000000",
      }),
      clock.advance(1),
    );

    expect(oneSide.classification).toBe("NORMALIZED");
    expect(typesOf(oneSide.emissions)).toContain("ReferenceTopOfBookChanged");
    expect(bothSides.classification).toBe("UNREPRESENTABLE");
    expect(typesOf(bothSides.emissions)).not.toContain("ReferenceTopOfBookChanged");

    const entry = BINANCE_UNVERIFIED.find((candidate) => candidate.id === "BNC-U4");
    if (entry === undefined) {
      throw new Error("BNC-U4 is missing from the register");
    }
    // The register must state BOTH observed behaviors, not only the second one.
    expect(entry.conservativeBehavior).toContain("OMITTED");
    expect(entry.conservativeBehavior).toContain("NORMALIZED");
    expect(entry.conservativeBehavior).toContain("BOTH sides unusable");
    expect(entry.conservativeBehavior).toContain("UNREPRESENTABLE");
  });
});
