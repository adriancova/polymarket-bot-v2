import { beforeEach, describe, expect, it } from "vitest";

import type { NormalizedPublicEventAny, PublicMarketProblem } from "../normalize/result.js";
import { PublicMarketStateError } from "../errors.js";
import {
  fakeWebSocketFactory,
  ManualScheduler,
  sequentialConnectionIds,
  staticMarketDirectory,
  testMarket,
  type FakeWebSocket,
  type FakeWebSocketFactoryOptions,
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

/** Hooks that run as the feed publishes, for tests that assert on ORDER. */
interface HarnessObservers {
  readonly onEvent?: (event: NormalizedPublicEventAny) => void;
  readonly onProblem?: (problem: PublicMarketProblem) => void;
}

function harness(
  options: Partial<ConstructorParameters<typeof PublicMarketFeed>[2]> = {},
  transport: FakeWebSocketFactoryOptions = {},
  observers: HarnessObservers = {},
): Harness {
  const scheduler = new ManualScheduler();
  const sockets = fakeWebSocketFactory(transport);
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
      onEvent: (event) => {
        events.push(event);
        observers.onEvent?.(event);
      },
      onProblem: (problem) => {
        problems.push(problem);
        observers.onProblem?.(problem);
      },
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

  it("every gap opens under a generation no gap has used, swept over every transition", () => {
    // The invariant, restated in the direction that is actually true (round-2
    // finding H2 broke it): every gap this feed opens is opened by a transition
    // that advances the generation in the SAME step, so gap generations are
    // unique and strictly increasing and the generation alone identifies a gap.
    // The converse is not claimed — the first connection advances the
    // generation with nothing missed and no gap.
    //
    // The round-1 sweep missed the break because every reconnect it swept still
    // had an asset subscribed. This one includes the empty-set path.
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    const reconnect = (): void => {
      subject.sockets.latest().emitClose({ code: 1006 });
      // Long enough for the backoff (250 ms, reset by every successful open),
      // short enough that the 30 s staleness watchdog has nothing to say.
      subject.scheduler.advance(1_000);
      subject.sockets.latest().emitOpen();
    };
    const steps: readonly { readonly name: string; readonly run: () => void }[] = [
      { name: "add a token", run: () => subject.feed.subscribe([MARKET.noTokenId]) },
      { name: "remove a token", run: () => subject.feed.unsubscribe([MARKET.noTokenId]) },
      {
        name: "add a token already subscribed (a no-op)",
        run: () => subject.feed.subscribe([MARKET.yesTokenId]),
      },
      { name: "reconnect with assets subscribed", run: reconnect },
      {
        name: "remove the LAST token",
        run: () => subject.feed.unsubscribe([MARKET.yesTokenId]),
      },
      { name: "reconnect with NOTHING subscribed", run: reconnect },
      { name: "reconnect empty a second time", run: reconnect },
      {
        name: "subscribe again on the live connection",
        run: () => subject.feed.subscribe([MARKET.yesTokenId]),
      },
      { name: "reconnect with assets once more", run: reconnect },
    ];

    const openedGapGenerations: number[] = [];
    const gapCount = (): number =>
      subject.events.filter((event) => event.eventType === "FeedGapDetected").length;

    let previousGeneration = subject.feed.subscriptionGeneration;
    let previousGaps = gapCount();
    for (const step of steps) {
      step.run();
      const generation = subject.feed.subscriptionGeneration;
      const gaps = gapCount();
      const opened = gaps > previousGaps;
      const label = `${step.name}: generation ${String(previousGeneration)} → ${String(generation)}, gaps ${String(previousGaps)} → ${String(gaps)}`;

      if (opened) {
        // (a) a gap never opens without the generation moving with it...
        expect(generation, label).toBeGreaterThan(previousGeneration);
        const gapGeneration = subject.feed.openGap?.subscriptionGeneration;
        expect(gapGeneration, label).toBe(generation);
        // (b) ...and never reuses a generation an earlier gap already claimed.
        expect(openedGapGenerations, label).not.toContain(gapGeneration);
        openedGapGenerations.push(gapGeneration ?? -1);
      }
      // On a live connection the two move together in both directions, which is
      // the round-1 statement, and it survives the empty-set path.
      expect(generation !== previousGeneration, label).toBe(opened);
      previousGeneration = generation;
      previousGaps = gaps;
    }

    // Strictly increasing, and therefore unambiguous as an acknowledgement id.
    expect(openedGapGenerations.length).toBeGreaterThan(2);
    expect([...openedGapGenerations].sort((left, right) => left - right)).toEqual(
      openedGapGenerations,
    );
    expect(new Set(openedGapGenerations).size).toBe(openedGapGenerations.length);
    // Every generation an earlier gap was opened under is refused now.
    for (const spent of openedGapGenerations.slice(0, -1)) {
      expect(
        subject.feed.markResynchronized({ subscriptionGeneration: spent }).status,
        `generation ${String(spent)} belongs to a gap that is no longer open`,
      ).toBe("rejected");
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

describe("a transport that is already connected when the factory returns (round-2 H1)", () => {
  const SUBSCRIPTION_FRAME = {
    assets_ids: [MARKET.yesTokenId],
    type: "market",
    custom_feature_enabled: false,
    initial_dump: true,
  };

  it("sends the subscription, and only then publishes FeedConnected", () => {
    // The probe: a factory that calls `onOpen` during the call left the feed
    // with `socket === undefined`, so the subscription frame went nowhere while
    // `FeedConnected` was published anyway — a feed that believed it was
    // subscribed to a socket it had sent nothing on.
    const held: { socket?: FakeWebSocket } = {};
    const sentWhenConnected: number[] = [];
    const subject = harness(
      {},
      {
        onCreate: (socket) => {
          held.socket = socket;
          socket.emitOpen();
        },
      },
      {
        onEvent: (event) => {
          if (event.eventType === "FeedConnected") {
            sentWhenConnected.push(held.socket?.sent.length ?? -1);
          }
        },
      },
    );
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();

    expect(subject.sockets.latest().sentFrames).toEqual([SUBSCRIPTION_FRAME]);
    expect(subject.eventTypes()).toEqual(["FeedConnected"]);
    expect(subject.events[0]?.payload).toMatchObject({
      connectionId: "conn-1",
      subscriptionGeneration: 2,
    });
    // ORDER, not just presence: the frame was on the socket before the event
    // that claims the feed is connected reached the caller.
    expect(sentWhenConnected).toEqual([1]);
  });

  it("resubscribes when the RECONNECT's transport is already connected", () => {
    let created = 0;
    const subject = harness(
      {},
      {
        onCreate: (socket) => {
          created += 1;
          // Only the reconnect's transport is pre-opened, so the first
          // connection is driven the ordinary asynchronous way.
          if (created === 2) socket.emitOpen();
        },
      },
    );
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);

    expect(subject.sockets.sockets).toHaveLength(2);
    expect(subject.sockets.latest().sentFrames).toEqual([SUBSCRIPTION_FRAME]);
    expect(subject.eventTypes()).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
    ]);
    expect(subject.feed.openGap?.subscriptionGeneration).toBe(
      subject.feed.subscriptionGeneration,
    );
  });

  it("closes the socket when stop() runs inside a synchronous callback", () => {
    // The callback fires before the factory returns, so `stop()` has no handle
    // to close. A socket nobody closes outlives the feed that opened it.
    //
    // The problem this stops on is `PRE_SUBSCRIPTION_FRAME` rather than
    // `UNRECOGNIZED_FRAME` since round-3 M1: a frame delivered inside the
    // factory call arrives before any subscription was written, so it is
    // refused at the gate and never reaches the parser. The property under
    // test — a `stop()` issued from inside a synchronous transport callback
    // still closes the socket it cannot yet see — is unchanged, and so is the
    // fact that a problem is reported for the frame at all.
    const held: { feed?: PublicMarketFeed } = {};
    const subject = harness(
      {},
      {
        onCreate: (socket) => {
          socket.emitMessage("{not json");
        },
      },
      {
        onProblem: () => {
          held.feed?.stop();
        },
      },
    );
    held.feed = subject.feed;
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();

    expect(subject.problems.map((problem) => problem.code)).toEqual(["PRE_SUBSCRIPTION_FRAME"]);
    expect(subject.problems[0]?.raw).toBe("{not json");
    expect(subject.sockets.latest().closedByClient).toBe(true);
    expect(subject.eventTypes()).toEqual(["FeedDisconnected"]);
    expect(subject.sockets.latest().sent).toEqual([]);
  });

  it("neither sends on nor leaks an attempt overtaken before its handle arrived", () => {
    let created = 0;
    const subject = harness(
      {},
      {
        onCreate: (socket) => {
          created += 1;
          if (created !== 2) return;
          // The reconnect's transport opens and immediately fails, all inside
          // the factory call: by the time the handle exists the attempt has
          // already been retired and a further reconnect scheduled.
          socket.emitOpen();
          socket.emitClose({ code: 1006, reason: "instant failure" });
        },
      },
    );
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);

    const overtaken = subject.sockets.sockets[1];
    expect(overtaken?.sent).toEqual([]);
    expect(overtaken?.closedByClient).toBe(true);
    // One FeedConnected (the first connection) and no gap: the overtaken
    // attempt never became a connection, so it announced nothing.
    expect(subject.eventTypes()).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedDisconnected",
    ]);
    expect(subject.feed.isAwaitingSnapshot).toBe(false);
  });
});

describe("a reconnect with nothing subscribed (round-2 H2)", () => {
  /** Connect with one token, then drop everything and reconnect empty. */
  function emptyReconnect(): Harness {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.feed.unsubscribe([MARKET.yesTokenId]);
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();
    return subject;
  }

  it("opens no gap, because there is no subscription to recover", () => {
    // The probe: this opened a FEED_RECONNECTED gap at the UNCHANGED
    // generation 2 — `planFullSubscription()` of an empty set resubscribes
    // nothing and advances nothing — so the new gap was indistinguishable from
    // the previous one.
    const subject = emptyReconnect();

    expect(subject.feed.subscriptionGeneration).toBe(2);
    expect(subject.feed.openGap).toBeUndefined();
    expect(subject.feed.isAwaitingSnapshot).toBe(false);
    expect(subject.eventTypes()).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedConnected",
    ]);
    expect(subject.sockets.latest().sent).toEqual([]);
  });

  it("refuses the acknowledgement that used to close that phantom gap", () => {
    const subject = emptyReconnect();

    expect(subject.feed.markResynchronized({ subscriptionGeneration: 2 })).toMatchObject({
      status: "rejected",
      reasonCode: "NO_OPEN_GAP",
    });
    expect(subject.eventTypes()).not.toContain("FeedResynchronized");
  });

  it("cannot be closed a SECOND time by replaying an acknowledgement already spent", () => {
    // The duplicate/in-flight case the empty reconnect reopened: the gateway
    // acknowledges the reconnect gap for generation 3, then everything is
    // unsubscribed and the feed reconnects empty. Replaying the same
    // acknowledgement must not publish a second recovery.
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();

    const gap = subject.feed.openGap?.subscriptionGeneration ?? -1;
    expect(gap).toBe(3);
    expect(subject.feed.markResynchronized({ subscriptionGeneration: gap }).status).toBe(
      "accepted",
    );

    subject.feed.unsubscribe([MARKET.yesTokenId]);
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(5_000);
    subject.sockets.latest().emitOpen();

    expect(subject.feed.openGap).toBeUndefined();
    expect(subject.feed.markResynchronized({ subscriptionGeneration: gap })).toMatchObject({
      status: "rejected",
      reasonCode: "NO_OPEN_GAP",
    });
    expect(subject.events.filter((event) => event.eventType === "FeedResynchronized")).toHaveLength(
      1,
    );
  });

  it("opens a gap again as soon as there is something to recover", () => {
    // The empty reconnect is not a licence to stop reporting gaps: the next
    // subscription on that live connection replaces server-side state and owes
    // a snapshot, under a generation no gap has used.
    const subject = emptyReconnect();
    subject.feed.subscribe([MARKET.noTokenId]);

    expect(subject.feed.openGap).toMatchObject({
      reasonCode: "SUBSCRIPTION_REPLACED",
      subscriptionGeneration: 3,
    });
    expect(subject.feed.subscriptionGeneration).toBe(3);
  });
});

describe("a manual start() during the reconnect backoff (round-3 H1)", () => {
  /**
   * Drop a live connection, then reconnect MANUALLY while the backoff timer
   * for that drop is still armed.
   *
   * The probe: the timer survived `start()`, fired at its original deadline,
   * and called `#connect()` unconditionally — overwriting `#session` with a
   * third socket while conn-2 stayed physically open and subscribed, its
   * callbacks silently demoted to stale, and no `FeedDisconnected` ever naming
   * it.
   */
  function reconnectedManuallyDuringBackoff(): Harness {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    // conn-1 drops: the feed returns to `idle` and arms a 250 ms backoff.
    subject.sockets.latest().emitClose({ code: 1006, reason: "abnormal" });
    // ...and the caller reconnects itself, inside that window.
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    return subject;
  }

  it("opens no third socket when the armed timer's deadline passes", () => {
    const subject = reconnectedManuallyDuringBackoff();
    const conn2 = subject.sockets.latest();
    const eventsBefore = subject.eventTypes().length;

    // Past the 250 ms backoff deadline, and short of conn-2's own 5 s
    // staleness check, so the ONLY thing that could fire is the stale timer.
    subject.scheduler.advance(1_000);

    expect(subject.sockets.sockets).toHaveLength(2);
    expect(subject.feed.connectionId).toBe("conn-2");
    expect(subject.eventTypes()).toHaveLength(eventsBefore);
    // conn-2 is neither closed nor replaced: it is still THE connection.
    expect(conn2.closedByClient).toBe(false);
    expect(conn2.isOpen).toBe(true);
    expect(subject.sockets.latest()).toBe(conn2);
  });

  it("leaves no connection live but unnamed, and no gap naming a replaced one", () => {
    const subject = reconnectedManuallyDuringBackoff();
    subject.scheduler.advance(1_000);

    // Every FeedConnected is either still current or has a FeedDisconnected.
    const connected = subject.events
      .filter((event) => event.eventType === "FeedConnected")
      .map((event) => (event.payload as { connectionId: string }).connectionId);
    const disconnected = subject.events
      .filter((event) => event.eventType === "FeedDisconnected")
      .map((event) => (event.payload as { connectionId: string }).connectionId);
    expect(connected).toEqual(["conn-1", "conn-2"]);
    expect(disconnected).toEqual(["conn-1"]);
    expect(connected.filter((id) => !disconnected.includes(id))).toEqual([
      subject.feed.connectionId,
    ]);
    // The open gap names the connection that is actually current, which is the
    // other half of the same defect: the gap said conn-2 while the feed said
    // conn-3.
    expect(subject.feed.openGap?.connectionId).toBe(subject.feed.connectionId);
    expect(subject.feed.openGap?.subscriptionGeneration).toBe(
      subject.feed.subscriptionGeneration,
    );
  });

  it("keeps the manually started connection authoritative past the deadline", () => {
    const subject = reconnectedManuallyDuringBackoff();
    subject.scheduler.advance(1_000);
    const conn2 = subject.sockets.latest();

    conn2.emitJson({
      event_type: "book",
      market: MARKET.conditionId,
      asset_id: MARKET.yesTokenId,
      timestamp: "1782753357257",
      bids: [{ price: "0.08", size: "1" }],
      asks: [{ price: "0.09", size: "2" }],
    });

    // Published as current data on conn-2 — not refused as stale, which is what
    // an overwritten identity would have made it.
    const snapshot = subject.events.find((event) => event.eventType === "BookSnapshot");
    expect(snapshot?.provenance).toMatchObject({
      connectionId: "conn-2",
      subscriptionGeneration: 3,
    });
    expect(subject.problems).toEqual([]);
    // And its heartbeat still runs on the socket the feed is holding.
    subject.scheduler.advance(10_000);
    expect(conn2.sent.filter((frame) => frame === "PING")).toHaveLength(1);
  });

  it("still reconnects after the NEXT drop: standing a timer down is not disarming", () => {
    const subject = reconnectedManuallyDuringBackoff();
    subject.sockets.latest().emitClose({ code: 1006, reason: "again" });
    subject.scheduler.advance(1_000);

    expect(subject.sockets.sockets).toHaveLength(3);
    subject.sockets.latest().emitOpen();
    expect(subject.feed.connectionId).toBe("conn-3");
    expect(subject.eventTypes()).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
    ]);
  });
});

describe("a frame delivered before the subscription was written (round-3 M1)", () => {
  const BOOK = {
    event_type: "book",
    market: MARKET.conditionId,
    asset_id: MARKET.yesTokenId,
    timestamp: "1782753357257",
    bids: [{ price: "0.08", size: "1" }],
    asks: [{ price: "0.09", size: "2" }],
  };
  const BOOK_FRAME = JSON.stringify(BOOK);

  /** A transport that opens AND delivers a frame inside the factory call. */
  function preReturnFrame(socket: FakeWebSocket): void {
    socket.emitOpen();
    socket.emitJson(BOOK);
  }

  it("is refused as pre-subscription data on the FIRST connection", () => {
    // The probe: this became a BookSnapshot stamped `conn-1` generation 1 —
    // the session's PRE-full-subscription generation, under which no
    // subscription was ever written — and it reached the caller BEFORE
    // FeedConnected, with no problem and no gap saying so.
    const subject = harness({}, { onCreate: preReturnFrame });
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();

    expect(subject.eventTypes()).toEqual(["FeedConnected"]);
    expect(subject.problems).toHaveLength(1);
    expect(subject.problems[0]).toMatchObject({
      code: "PRE_SUBSCRIPTION_FRAME",
      raw: BOOK_FRAME,
      sourceChannel: "polymarket:market-ws",
    });
    expect(subject.problems[0]?.detail).toContain("conn-1");
    expect(subject.problems[0]?.detail).toContain("generation 1");
    // The open still completed normally: the subscription was written and the
    // connection announced under the generation it was written at.
    expect(subject.sockets.latest().sentFrames).toEqual([
      {
        assets_ids: [MARKET.yesTokenId],
        type: "market",
        custom_feature_enabled: false,
        initial_dump: true,
      },
    ]);
    expect(subject.events[0]?.payload).toMatchObject({ subscriptionGeneration: 2 });
  });

  it("preserves the raw frame, labelled with the generation it truly arrived under", () => {
    // §9.1: refusing it is not dropping it. The raw record keeps the session's
    // own pre-subscription generation rather than borrowing the one the open
    // went on to establish.
    const subject = harness({}, { onCreate: preReturnFrame });
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();

    expect(subject.frames).toHaveLength(1);
    expect(subject.frames[0]).toMatchObject({
      connectionId: "conn-1",
      subscriptionGeneration: 1,
      payload: BOOK_FRAME,
    });
    expect(subject.feed.subscriptionGeneration).toBe(2);
  });

  it("is refused on a RECONNECT's pre-opened transport too", () => {
    let created = 0;
    const subject = harness(
      {},
      {
        onCreate: (socket) => {
          created += 1;
          // Only the reconnect's transport is pre-opened and pre-delivering.
          if (created === 2) preReturnFrame(socket);
        },
      },
    );
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);

    expect(subject.eventTypes()).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
    ]);
    expect(subject.problems.map((problem) => problem.code)).toEqual(["PRE_SUBSCRIPTION_FRAME"]);
    // Generation 2 is what conn-2 held before it resubscribed; the gap it then
    // opened, and everything published on it, is generation 3.
    expect(subject.problems[0]?.detail).toContain("conn-2");
    expect(subject.problems[0]?.detail).toContain("generation 2");
    expect(subject.frames.at(-1)).toMatchObject({
      connectionId: "conn-2",
      subscriptionGeneration: 2,
    });
    expect(subject.feed.openGap?.subscriptionGeneration).toBe(3);
  });

  it("refuses a WINDOW, not the connection: the next frame is data as usual", () => {
    const subject = harness({}, { onCreate: preReturnFrame });
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();

    // The same socket, now that the open has been processed.
    subject.sockets.latest().emitJson(BOOK);

    expect(subject.problems).toHaveLength(1);
    const snapshot = subject.events.find((event) => event.eventType === "BookSnapshot");
    expect(snapshot?.provenance).toMatchObject({
      connectionId: "conn-1",
      subscriptionGeneration: 2,
    });
  });

  it("refuses it before it can be parsed, so a stale socket still reports STALE", () => {
    // The two refusals are siblings at the two ends of a connection's life, and
    // the stale one wins where both apply: the frame arrived on a connection
    // the feed no longer holds at all.
    const subject = harness({}, { onCreate: preReturnFrame });
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    const socket = subject.sockets.latest();
    subject.feed.stop();

    socket.handlers.onMessage(BOOK_FRAME);

    expect(subject.problems.map((problem) => problem.code)).toEqual([
      "PRE_SUBSCRIPTION_FRAME",
      "STALE_CONNECTION_FRAME",
    ]);
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
