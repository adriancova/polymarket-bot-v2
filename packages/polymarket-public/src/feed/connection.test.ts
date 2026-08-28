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
  function reconnected(): Harness {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({});
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();
    return subject;
  }

  it("is caller-driven: reopening a socket is not a recovery", () => {
    const subject = reconnected();

    expect(subject.eventTypes()).not.toContain("FeedResynchronized");
    expect(subject.feed.isAwaitingSnapshot).toBe(true);

    const gap = subject.feed.openGap;
    expect(gap?.reasonCode).toBe("FEED_RECONNECTED");
    const outcome = subject.feed.markResynchronized({
      subscriptionGeneration: gap?.subscriptionGeneration ?? -1,
    });

    expect(outcome).toEqual({
      status: "accepted",
      subscriptionGeneration: gap?.subscriptionGeneration,
    });
    expect(subject.eventTypes().at(-1)).toBe("FeedResynchronized");
    expect(subject.events.at(-1)?.payload).toMatchObject({
      authoritativeSnapshotApplied: true,
      subscriptionGeneration: gap?.subscriptionGeneration,
    });
    expect(subject.feed.isAwaitingSnapshot).toBe(false);
  });

  it("refuses an acknowledgement when no gap is open, and publishes nothing", () => {
    // H2: this used to emit `FeedResynchronized` unconditionally, so a caller
    // could declare a recovery from nothing.
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    const outcome = subject.feed.markResynchronized({
      subscriptionGeneration: subject.feed.subscriptionGeneration,
    });
    expect(outcome).toMatchObject({ status: "rejected", reasonCode: "NO_OPEN_GAP" });
    expect(subject.eventTypes()).not.toContain("FeedResynchronized");
  });

  it("refuses a DUPLICATE acknowledgement of the same gap", () => {
    const subject = reconnected();
    const generation = subject.feed.subscriptionGeneration;

    expect(subject.feed.markResynchronized({ subscriptionGeneration: generation }).status).toBe(
      "accepted",
    );
    const second = subject.feed.markResynchronized({ subscriptionGeneration: generation });

    expect(second).toMatchObject({ status: "rejected", reasonCode: "NO_OPEN_GAP" });
    expect(subject.events.filter((event) => event.eventType === "FeedResynchronized")).toHaveLength(
      1,
    );
  });

  it("refuses a snapshot taken for an older generation than the open gap's", () => {
    // The race that matters: the gateway fetched a snapshot for generation N,
    // and by the time it applied it a subscription change had opened the gap
    // for generation N+1. Closing the newer gap with the older snapshot would
    // publish an authoritative recovery nobody performed.
    const subject = reconnected();
    const staleGeneration = subject.feed.subscriptionGeneration;
    subject.feed.subscribe([MARKET.noTokenId]);
    const currentGeneration = subject.feed.subscriptionGeneration;
    expect(currentGeneration).toBeGreaterThan(staleGeneration);

    const outcome = subject.feed.markResynchronized({
      subscriptionGeneration: staleGeneration,
    });

    expect(outcome).toEqual({
      status: "rejected",
      reasonCode: "GENERATION_MISMATCH",
      detail: expect.stringContaining(String(currentGeneration)) as unknown as string,
      expectedSubscriptionGeneration: currentGeneration,
    });
    expect(subject.eventTypes()).not.toContain("FeedResynchronized");
    expect(subject.feed.isAwaitingSnapshot).toBe(true);
  });

  it("names the open gap so a caller can acknowledge it at all", () => {
    const subject = reconnected();
    expect(subject.feed.openGap).toMatchObject({
      reasonCode: "FEED_RECONNECTED",
      subscriptionGeneration: subject.feed.subscriptionGeneration,
      connectionId: "conn-2",
    });
  });
});

describe("subscription changes and the generation (H2)", () => {
  it("opens a gap for an ADDITION on a live connection, under the new generation", () => {
    const subject = harness();
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.feed.subscribe([MARKET.yesTokenId]);

    expect(subject.feed.openGap?.subscriptionGeneration).toBe(
      subject.feed.subscriptionGeneration,
    );
  });

  it("a REMOVAL neither advances the generation nor opens a gap", () => {
    // Before the fix this advanced 2 → 3 with `emittedGap: false`, so events
    // carried a generation boundary that nothing accounted for.
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId, MARKET.noTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    const before = subject.feed.subscriptionGeneration;

    subject.feed.unsubscribe([MARKET.noTokenId]);

    expect(subject.feed.subscriptionGeneration).toBe(before);
    expect(subject.eventTypes()).not.toContain("FeedGapDetected");
    expect(subject.feed.isAwaitingSnapshot).toBe(false);
    // The unsubscribe frame is still sent: the desired set really did change.
    expect(subject.sockets.latest().sentFrames.at(-1)).toEqual({
      operation: "unsubscribe",
      assets_ids: [MARKET.noTokenId],
    });
  });

  it("on a live connection the generation changes exactly when a gap opens", () => {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    const observed: { generation: number; gaps: number }[] = [];
    const record = (): void => {
      observed.push({
        generation: subject.feed.subscriptionGeneration,
        gaps: subject.events.filter((event) => event.eventType === "FeedGapDetected").length,
      });
    };
    record();
    subject.feed.subscribe([MARKET.noTokenId]);
    record();
    subject.feed.unsubscribe([MARKET.noTokenId]);
    record();
    subject.feed.subscribe([MARKET.yesTokenId]); // already subscribed: a no-op
    record();
    subject.sockets.latest().emitClose({});
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();
    record();

    for (let index = 1; index < observed.length; index += 1) {
      const previous = observed[index - 1];
      const current = observed[index];
      if (previous === undefined || current === undefined) continue;
      expect(
        current.generation !== previous.generation,
        `step ${String(index)}: generation ${String(previous.generation)} → ${String(current.generation)}, gaps ${String(previous.gaps)} → ${String(current.gaps)}`,
      ).toBe(current.gaps !== previous.gaps);
    }
  });

  it("a newer gap supersedes an older one, and only the newer can be closed", () => {
    const subject = harness();
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.feed.subscribe([MARKET.yesTokenId]);
    const firstGap = subject.feed.openGap?.subscriptionGeneration ?? -1;
    subject.feed.subscribe([MARKET.noTokenId]);
    const secondGap = subject.feed.openGap?.subscriptionGeneration ?? -1;

    expect(secondGap).toBeGreaterThan(firstGap);
    expect(
      subject.feed.markResynchronized({ subscriptionGeneration: firstGap }),
    ).toMatchObject({ reasonCode: "GENERATION_MISMATCH" });
    expect(
      subject.feed.markResynchronized({ subscriptionGeneration: secondGap }).status,
    ).toBe("accepted");
  });
});

describe("stale socket callbacks (H1)", () => {
  interface Reconnected {
    readonly subject: Harness;
    readonly stale: ReturnType<Harness["sockets"]["latest"]>;
    readonly live: ReturnType<Harness["sockets"]["latest"]>;
  }

  function reconnected(): Reconnected {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    const stale = subject.sockets.latest();
    stale.emitOpen();
    stale.emitClose({ code: 1006, reason: "abnormal" });
    subject.scheduler.advance(1_000);
    const live = subject.sockets.latest();
    live.emitOpen();
    return { subject, stale, live };
  }

  const BOOK_FRAME = JSON.stringify({
    event_type: "book",
    market: MARKET.conditionId,
    asset_id: MARKET.yesTokenId,
    timestamp: "1782753357257",
    bids: [{ price: "0.08", size: "1" }],
    asks: [{ price: "0.09", size: "2" }],
  });

  it("onMessage: a frame from a retired socket is never published as current data", () => {
    // Before the fix this became a BookSnapshot stamped `conn-2`, generation 3,
    // with zero problems reported.
    const { subject, stale } = reconnected();
    const eventsBefore = subject.events.length;

    stale.handlers.onMessage(BOOK_FRAME);

    expect(subject.events).toHaveLength(eventsBefore);
    expect(subject.problems).toHaveLength(1);
    expect(subject.problems[0]).toMatchObject({
      code: "STALE_CONNECTION_FRAME",
      raw: BOOK_FRAME,
    });
    expect(subject.problems[0]?.detail).toContain("conn-1");
    expect(subject.problems[0]?.detail).toContain("conn-2");
  });

  it("onMessage: the raw record keeps the frame, labelled with the socket it arrived on", () => {
    const { subject, stale } = reconnected();
    stale.handlers.onMessage(BOOK_FRAME);

    expect(subject.frames.at(-1)).toMatchObject({
      connectionId: "conn-1",
      subscriptionGeneration: 2,
      payload: BOOK_FRAME,
    });
    // ...while the live connection is conn-2 under generation 3.
    expect(subject.feed.connectionId).toBe("conn-2");
    expect(subject.feed.subscriptionGeneration).toBe(3);
  });

  it("onOpen: a retired socket that opens changes nothing and is closed", () => {
    const { subject, stale } = reconnected();
    const generationBefore = subject.feed.subscriptionGeneration;
    const eventsBefore = subject.eventTypes().length;
    stale.closedByClient = false;

    stale.handlers.onOpen();

    expect(subject.feed.subscriptionGeneration).toBe(generationBefore);
    expect(subject.eventTypes()).toHaveLength(eventsBefore);
    expect(stale.closedByClient).toBe(true);
  });

  it("onError: a retired socket's error does not relabel the live disconnect", () => {
    // Before the fix the live connection's close was reported as
    // TRANSPORT_ERROR carrying the DEAD socket's message.
    const { subject, stale, live } = reconnected();

    stale.handlers.onError(new Error("stale socket exploded"));
    live.emitClose({ code: 1001, reason: "going away" });

    const disconnect = subject.events.at(-1);
    expect(disconnect?.eventType).toBe("FeedDisconnected");
    expect(disconnect?.payload).toMatchObject({
      connectionId: "conn-2",
      reasonCode: "TRANSPORT_CLOSED",
    });
    expect(JSON.stringify(disconnect?.payload)).not.toContain("stale socket exploded");
  });

  it("onClose: a second close from a retired socket reports and reconnects nothing", () => {
    const { subject, stale } = reconnected();
    const eventsBefore = subject.eventTypes().length;
    const socketsBefore = subject.sockets.sockets.length;

    stale.handlers.onClose({ code: 1006, reason: "late close" });
    // Long enough for any reconnect backoff to fire, short enough that the LIVE
    // connection's staleness watchdog (30 s) has nothing to say.
    subject.scheduler.advance(5_000);

    expect(subject.events.slice(eventsBefore).map((event) => event.eventType)).not.toContain(
      "FeedDisconnected",
    );
    expect(subject.sockets.sockets).toHaveLength(socketsBefore);
  });

  it("a frame arriving after stop() is reported, not published and not dropped", () => {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    const socket = subject.sockets.latest();
    socket.emitOpen();
    subject.feed.stop();

    socket.handlers.onMessage(BOOK_FRAME);

    expect(subject.eventTypes()).not.toContain("BookSnapshot");
    expect(subject.problems[0]?.code).toBe("STALE_CONNECTION_FRAME");
    expect(subject.frames.at(-1)?.payload).toBe(BOOK_FRAME);
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
