import { describe, expect, it } from "vitest";

import type { AdapterEmission } from "./emission.js";
import { BinanceConfigurationError, BinanceStateError } from "./errors.js";
import { BinanceReferenceFeed, type FrameOutcome } from "./feed.js";
import { BINANCE_REASON_CODES } from "./incidents.js";
import { createManualClock } from "./testing/index.js";

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

function tradeFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    stream: "btcusdt@trade",
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

function bookTickerFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    stream: "btcusdt@bookTicker",
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
    feed.connecting();
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
    feed.connecting();
    const first = feed.onOpen("conn-1", clock.stamp());
    feed.onClose(clock.advance(100));
    feed.connecting();
    const second = feed.onOpen("conn-2", clock.advance(1_000));

    const all = [...typesOf(first.emissions), ...typesOf(second.emissions)];
    expect(all).not.toContain("FeedResynchronized");
  });

  it("increments the subscription generation on every resubscription (§7.1)", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    expect(feed.subscriptionGeneration).toBe(0);

    feed.onClose(clock.advance(10));
    feed.connecting();
    feed.onOpen("conn-2", clock.advance(10));
    expect(feed.subscriptionGeneration).toBe(1);

    feed.onClose(clock.advance(10));
    feed.connecting();
    feed.onOpen("conn-3", clock.advance(10));
    expect(feed.subscriptionGeneration).toBe(2);
  });

  it("uses the reconnect reason code from the second connection onward", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    feed.onClose(clock.advance(10));
    feed.connecting();
    const outcome = feed.onOpen("conn-2", clock.advance(10));
    const gap = outcome.emissions[1]?.payload as { reasonCode: string };
    expect(gap.reasonCode).toBe(BINANCE_REASON_CODES.reconnect);
  });

  it("refuses an empty or over-long connection id", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    expect(() => feed.onOpen("", clock.stamp())).toThrow(BinanceConfigurationError);
    expect(() => feed.onOpen("x".repeat(101), clock.stamp())).toThrow(BinanceConfigurationError);
  });
});

describe("frames", () => {
  function openFeed(): { feed: BinanceReferenceFeed; clock: ReturnType<typeof createManualClock> } {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    return { feed, clock };
  }

  it("normalizes a trade, preserving venue and receipt timestamps distinctly", () => {
    const { feed, clock } = openFeed();
    const receipt = clock.advance(5);
    const outcome = feed.onFrame(tradeFrame(), receipt);

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
    const outcome = feed.onFrame(bookTickerFrame(), clock.advance(5));
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
    feed.onFrame(tradeFrame(), clock.advance(1));
    const outcome = feed.onFrame(tradeFrame(), clock.advance(1));

    expect(outcome.classification).toBe("DUPLICATE_SUPPRESSED");
    expect(outcome.emissions).toEqual([]);
    expect(outcome.sequence?.outcome).toBe("DUPLICATE");
    expect(feed.metrics(clock.peek()).frames.duplicatesSuppressed).toBe(1);
  });

  it("opens an incident when the venue repeats an id with different content", () => {
    const { feed, clock } = openFeed();
    feed.onFrame(tradeFrame(), clock.advance(1));
    const outcome = feed.onFrame(tradeFrame({ p: "0.002" }), clock.advance(1));

    expect(outcome.classification).toBe("CONFLICTING_DUPLICATE");
    expect(typesOf(outcome.emissions)).toEqual(["DataQualityIncidentOpened"]);
    const incident = outcome.emissions[0]?.payload as { reasonCode: string };
    expect(incident.reasonCode).toBe(BINANCE_REASON_CODES.sequenceConflict);
  });

  it("publishes a LATE trade — a trade is a point observation, not versioned state", () => {
    const { feed, clock } = openFeed();
    feed.onFrame(tradeFrame({ t: 100 }), clock.advance(1));
    const outcome = feed.onFrame(tradeFrame({ t: 99, p: "0.002" }), clock.advance(1));

    expect(outcome.classification).toBe("NORMALIZED");
    expect(outcome.sequence?.outcome).toBe("REGRESSED");
    expect(feed.metrics(clock.peek()).frames.lateTradesEmitted).toBe(1);
  });

  it("SUPPRESSES a stale top of book — applying it would overwrite newer state", () => {
    const { feed, clock } = openFeed();
    feed.onFrame(bookTickerFrame({ u: 200 }), clock.advance(1));
    const outcome = feed.onFrame(bookTickerFrame({ u: 199, b: "24" }), clock.advance(1));

    expect(outcome.classification).toBe("STALE_SUPPRESSED");
    expect(outcome.emissions).toEqual([]);
    expect(feed.metrics(clock.peek()).frames.staleUpdatesSuppressed).toBe(1);
  });

  it("does not treat a jump in the venue id as a gap (BNC-U2/BNC-U3)", () => {
    const { feed, clock } = openFeed();
    feed.onFrame(tradeFrame({ t: 1 }), clock.advance(1));
    const outcome = feed.onFrame(tradeFrame({ t: 5_000_000 }), clock.advance(1));

    expect(outcome.classification).toBe("NORMALIZED");
    expect(typesOf(outcome.emissions)).toEqual(["ReferenceTradeObserved"]);
    expect(typesOf(outcome.emissions)).not.toContain("FeedGapDetected");
  });

  it("routes a malformed frame to an incident and preserves the raw frame", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame("not json at all", clock.advance(1));

    expect(outcome.classification).toBe("MALFORMED");
    expect(typesOf(outcome.emissions)).toEqual(["DataQualityIncidentOpened"]);
    expect(outcome.decoded.raw).toBe("not json at all");
    const incident = outcome.emissions[0]?.payload as { detail: string };
    expect(incident.detail).toContain("not json at all");
  });

  it("routes an unknown event type to an incident as first-class UNKNOWN (ADR-002 §7)", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame(
      JSON.stringify({ stream: "btcusdt@kline_1m", data: { e: "kline", E: 1 } }),
      clock.advance(1),
    );
    expect(outcome.classification).toBe("UNKNOWN");
    const incident = outcome.emissions[0]?.payload as { reasonCode: string };
    expect(incident.reasonCode).toBe(BINANCE_REASON_CODES.frameUnknown);
  });

  it("reports an added venue field once, at LOG severity, without rejecting the frame", () => {
    const { feed, clock } = openFeed();
    const outcome = feed.onFrame(bookTickerFrame({ E: 1, T: 2 }), clock.advance(1));

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
      JSON.stringify({ e: "serverShutdown", E: 1_770_123_456_789 }),
      clock.advance(1),
    );
    expect(outcome.classification).toBe("SERVER_SHUTDOWN");
    expect(outcome.advisory).toBe("ESTABLISH_NEW_CONNECTION");
    expect(outcome.directive).toEqual({ kind: "NONE" });
  });

  it("opens one incident per reason code per connection, and counts every occurrence", () => {
    const { feed, clock } = openFeed();
    const first = feed.onFrame("bad", clock.advance(1));
    const second = feed.onFrame("also bad", clock.advance(1));

    expect(typesOf(first.emissions)).toEqual(["DataQualityIncidentOpened"]);
    expect(second.emissions).toEqual([]);
    // Suppressing the repeat is not a silent drop: it is classified and counted.
    expect(second.classification).toBe("MALFORMED");
    expect(feed.metrics(clock.peek()).frames.malformedFrames).toBe(2);
  });

  it("rejects a frame delivered while the feed is not open", () => {
    const clock = createManualClock();
    const feed = newFeed();
    expect(() => feed.onFrame(tradeFrame(), clock.stamp())).toThrow(BinanceStateError);
  });

  it("classifies every frame it is given — no input returns nothing", () => {
    const { feed, clock } = openFeed();
    const outcomes: FrameOutcome[] = [
      feed.onFrame(tradeFrame(), clock.advance(1)),
      feed.onFrame(bookTickerFrame(), clock.advance(1)),
      feed.onFrame('{"result":null,"id":1}', clock.advance(1)),
      feed.onFrame('{"code":2,"msg":"Invalid request: too many parameters"}', clock.advance(1)),
      feed.onFrame("{", clock.advance(1)),
      feed.onFrame('{"nothing":"documented"}', clock.advance(1)),
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
});

describe("disconnect and reconnect", () => {
  it("emits FeedDisconnected and directs a backed-off reconnect", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    const outcome = feed.onClose(clock.advance(10), { code: 1006, reason: "abnormal" });

    expect(typesOf(outcome.emissions)).toEqual(["FeedDisconnected"]);
    expect(outcome.directive).toEqual({ kind: "RECONNECT_AFTER", delayMs: 1_000, attempt: 1 });
  });

  it("backs off further on consecutive failures and resets after a successful open", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());

    expect(feed.onClose(clock.advance(1)).directive).toEqual({
      kind: "RECONNECT_AFTER",
      delayMs: 1_000,
      attempt: 1,
    });
    expect(feed.onClose(clock.advance(1)).directive).toEqual({
      kind: "RECONNECT_AFTER",
      delayMs: 2_000,
      attempt: 2,
    });

    feed.connecting();
    feed.onOpen("conn-2", clock.advance(1));
    expect(feed.onClose(clock.advance(1)).directive).toEqual({
      kind: "RECONNECT_AFTER",
      delayMs: 1_000,
      attempt: 1,
    });
  });

  it("stops after the caller's attempt budget, and says why", () => {
    const clock = createManualClock();
    const feed = newFeed({
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, multiplier: 2, maxAttempts: 1 },
    });
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    feed.onClose(clock.advance(1));
    const outcome = feed.onClose(clock.advance(1));
    expect(outcome.directive).toEqual({
      kind: "STOP",
      reason: "RECONNECT_ATTEMPTS_EXHAUSTED",
    });
  });

  it("stops and does not reconnect when the caller closes the feed", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    const outcome = feed.close(clock.advance(1), "operator shutdown");

    expect(typesOf(outcome.emissions)).toEqual(["FeedDisconnected"]);
    expect(outcome.directive).toEqual({ kind: "STOP", reason: "CLOSED_BY_CALLER" });
    expect(feed.state).toBe("CLOSED");
    expect(() => feed.connecting()).toThrow(BinanceStateError);
  });

  it("remembers venue ids across a reconnect, so a replayed frame is still a duplicate", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame(tradeFrame({ t: 42 }), clock.advance(1));
    feed.onClose(clock.advance(1));
    feed.connecting();
    feed.onOpen("conn-2", clock.advance(1_000));

    const outcome = feed.onFrame(tradeFrame({ t: 42 }), clock.advance(1));
    expect(outcome.classification).toBe("DUPLICATE_SUPPRESSED");
  });
});

describe("staleness", () => {
  it("reports nothing before the caller's threshold is reached", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 10_000 });
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    expect(feed.checkStaleness(clock.advance(9_999)).emissions).toEqual([]);
  });

  it("emits FeedStale once per silence episode, re-armed by the next frame", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 10_000 });
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame(tradeFrame(), clock.advance(1_000));

    const first = feed.checkStaleness(clock.advance(10_000));
    expect(typesOf(first.emissions)).toEqual(["FeedStale"]);
    const payload = first.emissions[0]?.payload as { stalenessMs: number; lastMessageAt: string };
    expect(payload.stalenessMs).toBe(10_000);
    expect(payload.lastMessageAt).toBe("2026-08-27T00:00:01.000Z");

    expect(feed.checkStaleness(clock.advance(5_000)).emissions).toEqual([]);

    feed.onFrame(tradeFrame({ t: 99_999 }), clock.advance(1));
    expect(feed.checkStaleness(clock.advance(10_000)).emissions).toHaveLength(1);
    expect(feed.metrics(clock.peek()).connections.staleEpisodes).toBe(2);
  });

  it("measures staleness from the connect stamp before any frame has arrived", () => {
    const clock = createManualClock();
    const feed = newFeed({ stalenessThresholdMs: 5_000 });
    feed.connecting();
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
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame(tradeFrame({ t: 7 }), clock.advance(1_000));
    feed.onFrame(bookTickerFrame({ u: 11 }), clock.advance(1_000));

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
      { streamName: "btcusdt@bookTicker", lastVenueSequenceId: 11, observations: 1 },
      { streamName: "btcusdt@trade", lastVenueSequenceId: 7, observations: 1 },
    ]);
  });

  it("reports the venue-to-receipt lag from the last trade", () => {
    const clock = createManualClock({ startAt: "2022-12-31T19:43:02.000Z" });
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    // Venue trade time is …:02.136Z; the frame is received at …:02.436Z.
    feed.onFrame(tradeFrame(), clock.advance(436));

    const metrics = feed.metrics(clock.peek());
    expect(metrics.lastVenueTimestamp).toBe("2022-12-31T19:43:02.136Z");
    expect(metrics.lastVenueToReceiptLagMs).toBe(300);
    expect(metrics.maxVenueToReceiptLagMs).toBe(300);
  });

  it("lists the reason codes with an incident still open", () => {
    const clock = createManualClock();
    const feed = newFeed();
    feed.connecting();
    feed.onOpen("conn-1", clock.stamp());
    feed.onFrame("bad", clock.advance(1));

    expect(feed.metrics(clock.peek()).openIncidentReasonCodes).toEqual([
      BINANCE_REASON_CODES.frameMalformed,
      BINANCE_REASON_CODES.subscriptionStart,
    ]);
  });
});
