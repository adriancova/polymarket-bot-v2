import { beforeEach, describe, expect, it } from "vitest";

import type { NormalizedPublicEventAny, PublicMarketProblem } from "../normalize/result.js";
import { PublicMarketStateError } from "../errors.js";
import {
  fakeWebSocketFactory,
  ManualScheduler,
  sequentialConnectionIds,
  staticMarketDirectory,
  testMarket,
} from "../testing/index.js";
import { PublicMarketFeed, computeReconnectDelayMs, type RawMarketFrame } from "./connection.js";

const MARKET = testMarket(1);

interface Harness {
  readonly feed: PublicMarketFeed;
  readonly scheduler: ManualScheduler;
  readonly sockets: ReturnType<typeof fakeWebSocketFactory>;
  readonly events: NormalizedPublicEventAny[];
  readonly problems: PublicMarketProblem[];
  readonly frames: RawMarketFrame[];
  eventTypes(): readonly string[];
}

function harness(options: Partial<ConstructorParameters<typeof PublicMarketFeed>[2]> = {}): Harness {
  const scheduler = new ManualScheduler();
  const sockets = fakeWebSocketFactory();
  const events: NormalizedPublicEventAny[] = [];
  const problems: PublicMarketProblem[] = [];
  const frames: RawMarketFrame[] = [];
  const feed = new PublicMarketFeed(
    {
      clock: scheduler.clock,
      timers: scheduler.timers,
      webSocketFactory: sockets.factory,
      directory: staticMarketDirectory({ known: [MARKET] }),
      connectionId: sequentialConnectionIds(),
      randomFraction: () => 1,
    },
    {
      onEvent: (event) => events.push(event),
      onProblem: (problem) => problems.push(problem),
      onRawFrame: (frame) => frames.push(frame),
    },
    options,
  );
  return {
    feed,
    scheduler,
    sockets,
    events,
    problems,
    frames,
    eventTypes: () => events.map((event) => event.eventType),
  };
}

describe("connect and subscribe", () => {
  let subject: Harness;

  beforeEach(() => {
    subject = harness();
  });

  it("sends the subscription frame on open and reports FeedConnected", () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    expect(subject.sockets.latest().sentFrames).toEqual([
      {
        assets_ids: [MARKET.yesTokenId],
        type: "market",
        custom_feature_enabled: false,
        initial_dump: true,
      },
    ]);
    expect(subject.eventTypes()).toEqual(["FeedConnected"]);
    expect(subject.events[0]?.payload).toMatchObject({
      feedId: "polymarket-market",
      connectionId: "conn-1",
      endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      subscriptionGeneration: 2,
    });
  });

  it("does not emit a gap on the FIRST connection: nothing was missed yet", () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    expect(subject.eventTypes()).not.toContain("FeedGapDetected");
    expect(subject.feed.isAwaitingSnapshot).toBe(false);
  });

  it("opens a gap when the desired token set changes on a live connection", () => {
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.feed.subscribe([MARKET.yesTokenId]);

    expect(subject.eventTypes()).toEqual(["FeedConnected", "FeedGapDetected"]);
    expect(subject.events[1]?.payload).toMatchObject({
      reasonCode: "SUBSCRIPTION_REPLACED",
      requiresAuthoritativeSnapshot: true,
    });
    expect(subject.feed.isAwaitingSnapshot).toBe(true);
  });

  it("refuses to restart a stopped feed", () => {
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.feed.stop();
    expect(() => subject.feed.start()).toThrow(PublicMarketStateError);
  });
});

describe("heartbeat and staleness", () => {
  it("sends PING at the documented cadence", () => {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    subject.scheduler.advance(10_000);
    subject.scheduler.advance(10_000);
    expect(subject.sockets.latest().sent.filter((frame) => frame === "PING")).toHaveLength(2);
  });

  it("does not report staleness while PONG keeps arriving", () => {
    const subject = harness();
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    for (let tick = 0; tick < 10; tick += 1) {
      subject.scheduler.advance(10_000);
      subject.sockets.latest().emitMessage("PONG");
    }
    expect(subject.eventTypes()).not.toContain("FeedStale");
  });

  it("reports staleness as DATA once per episode, not once per check", () => {
    const subject = harness({ reconnectWhenStale: false });
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    subject.scheduler.advance(60_000);
    const stale = subject.events.filter((event) => event.eventType === "FeedStale");
    expect(stale).toHaveLength(1);
    expect(stale[0]?.payload).toMatchObject({ feedId: "polymarket-market" });
    expect((stale[0]?.payload as { stalenessMs: number }).stalenessMs).toBeGreaterThan(30_000);
  });

  it("closes a stale connection so the reconnect path runs, when configured to", () => {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    subject.scheduler.advance(40_000);
    expect(subject.eventTypes()).toEqual(["FeedConnected", "FeedStale", "FeedDisconnected"]);
    expect(subject.events.at(-1)?.payload).toMatchObject({ reasonCode: "STALE_CONNECTION" });
  });
});

describe("reconnect", () => {
  it("reconnects, resubscribes under a new generation, and opens a gap", () => {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    const firstGeneration = subject.feed.subscriptionGeneration;

    subject.sockets.latest().emitClose({ code: 1006, reason: "abnormal" });
    expect(subject.eventTypes()).toEqual(["FeedConnected", "FeedDisconnected"]);

    subject.scheduler.advance(1_000);
    expect(subject.sockets.sockets).toHaveLength(2);
    subject.sockets.latest().emitOpen();

    expect(subject.eventTypes()).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
    ]);
    expect(subject.feed.subscriptionGeneration).toBeGreaterThan(firstGeneration);
    expect(subject.events.at(-1)?.payload).toMatchObject({
      reasonCode: "FEED_RECONNECTED",
      requiresAuthoritativeSnapshot: true,
    });
    // The whole desired set is re-sent on the new connection.
    expect(subject.sockets.latest().sentFrames[0]).toMatchObject({
      assets_ids: [MARKET.yesTokenId],
      type: "market",
    });
  });

  it("attributes a transport error to the disconnect rather than reporting it twice", () => {
    const subject = harness();
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitError(new Error("socket exploded"));
    subject.sockets.latest().emitClose({ code: 1006 });

    const disconnects = subject.events.filter((event) => event.eventType === "FeedDisconnected");
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]?.payload).toMatchObject({
      reasonCode: "TRANSPORT_ERROR",
      detail: "socket exploded",
    });
  });

  it("stops reconnecting once stopped, and leaves no timer running", () => {
    const subject = harness();
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.feed.stop();
    subject.scheduler.advance(120_000);

    expect(subject.sockets.sockets).toHaveLength(1);
    expect(subject.scheduler.pendingTimerCount).toBe(0);
    expect(subject.events.at(-1)?.payload).toMatchObject({ reasonCode: "CLIENT_STOPPED" });
  });
});

describe("markResynchronized", () => {
  it("is caller-driven: reopening a socket is not a recovery", () => {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({});
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();

    expect(subject.eventTypes()).not.toContain("FeedResynchronized");
    expect(subject.feed.isAwaitingSnapshot).toBe(true);

    subject.feed.markResynchronized();
    expect(subject.eventTypes().at(-1)).toBe("FeedResynchronized");
    expect(subject.events.at(-1)?.payload).toMatchObject({
      authoritativeSnapshotApplied: true,
    });
    expect(subject.feed.isAwaitingSnapshot).toBe(false);
  });
});

describe("inbound frames", () => {
  it("hands every raw frame to the recorder BEFORE parsing it", () => {
    const subject = harness();
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitMessage("{not json");

    expect(subject.frames).toHaveLength(1);
    expect(subject.frames[0]?.payload).toBe("{not json");
    expect(subject.problems[0]?.code).toBe("UNRECOGNIZED_FRAME");
  });

  it("does not treat PONG as data", () => {
    const subject = harness();
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitMessage("PONG");
    expect(subject.problems).toEqual([]);
    expect(subject.eventTypes()).toEqual(["FeedConnected"]);
  });

  it("stamps events with the connection and generation they arrived under", () => {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitJson({
      event_type: "book",
      market: MARKET.conditionId,
      asset_id: MARKET.yesTokenId,
      timestamp: "1782753357257",
      bids: [{ price: "0.08", size: "1" }],
      asks: [{ price: "0.09", size: "2" }],
    });

    const snapshot = subject.events.find((event) => event.eventType === "BookSnapshot");
    expect(snapshot?.provenance).toMatchObject({
      source: "polymarket",
      sourceChannel: "polymarket:market-ws",
      connectionId: "conn-1",
      subscriptionGeneration: 2,
      venueTimestamp: "2026-06-29T17:15:57.257Z",
    });
  });
});

describe("computeReconnectDelayMs", () => {
  it("is a capped exponential with full jitter, matching the SDK's own policy", () => {
    const options = { baseMs: 250, maximumMs: 30_000 };
    expect(computeReconnectDelayMs(0, options, 1)).toBe(250);
    expect(computeReconnectDelayMs(1, options, 1)).toBe(500);
    expect(computeReconnectDelayMs(2, options, 1)).toBe(1_000);
    expect(computeReconnectDelayMs(20, options, 1)).toBe(30_000);
  });

  it("applies the jitter fraction and never returns a negative delay", () => {
    const options = { baseMs: 250, maximumMs: 30_000 };
    expect(computeReconnectDelayMs(2, options, 0.5)).toBe(500);
    expect(computeReconnectDelayMs(2, options, 0)).toBe(0);
    expect(computeReconnectDelayMs(2, options, -1)).toBe(0);
    expect(computeReconnectDelayMs(2, options, Number.NaN)).toBe(1_000);
  });
});
