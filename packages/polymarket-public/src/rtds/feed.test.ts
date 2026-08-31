import { describe, expect, it } from "vitest";

import { PublicMarketStateError } from "../errors.js";
import type { FakeWebSocket } from "../testing/index.js";
import {
  ManualScheduler,
  fakeWebSocketFactory,
  sequentialConnectionIds,
} from "../testing/index.js";
import type { RtdsTwapFeedOptions } from "./config.js";
import { RtdsTwapFeed, type RawRtdsFrame } from "./feed.js";
import type { NormalizedRtdsEventAny, RtdsProblem } from "./result.js";

const OBSERVATION_MS = Date.UTC(2026, 6, 27, 19, 0, 0);

function twapUpdate(
  overrides: {
    readonly topic?: string;
    readonly symbol?: string;
    readonly observationMs?: number;
    readonly fullAccuracyValue?: string;
    readonly windowSeconds?: number;
  } = {},
): unknown {
  const observationMs = overrides.observationMs ?? OBSERVATION_MS;
  return {
    topic: overrides.topic ?? "crypto_prices_twap_thirty",
    type: "update",
    timestamp: observationMs + 123,
    payload: {
      symbol: overrides.symbol ?? "btc/usd",
      value: 65000.5,
      full_accuracy_value: overrides.fullAccuracyValue ?? "65000500000000000000000",
      timestamp: observationMs,
      window_s: overrides.windowSeconds ?? 30,
    },
  };
}

interface Harness {
  readonly feed: RtdsTwapFeed;
  readonly scheduler: ManualScheduler;
  readonly sockets: FakeWebSocket[];
  readonly events: NormalizedRtdsEventAny[];
  readonly problems: RtdsProblem[];
  readonly rawFrames: RawRtdsFrame[];
  latest(): FakeWebSocket;
  eventTypes(): readonly string[];
}

function harness(
  options: Partial<RtdsTwapFeedOptions> = {},
  factoryOptions: { readonly onCreate?: (socket: FakeWebSocket) => void } = {},
): Harness {
  const scheduler = new ManualScheduler(OBSERVATION_MS);
  const { factory, sockets, latest } = fakeWebSocketFactory(factoryOptions);
  const events: NormalizedRtdsEventAny[] = [];
  const problems: RtdsProblem[] = [];
  const rawFrames: RawRtdsFrame[] = [];
  const feed = new RtdsTwapFeed(
    {
      clock: scheduler.clock,
      timers: scheduler.timers,
      webSocketFactory: factory,
      connectionId: sequentialConnectionIds(),
    },
    {
      onEvent: (event) => events.push(event),
      onProblem: (problem) => problems.push(problem),
      onRawFrame: (frame) => rawFrames.push(frame),
    },
    { subscriptions: [{ windowSeconds: 30 }], ...options },
  );
  return {
    feed,
    scheduler,
    sockets,
    events,
    problems,
    rawFrames,
    latest,
    eventTypes: () => events.map((event) => event.eventType),
  };
}

describe("connect and subscribe", () => {
  it("writes the subscribe frame before publishing FeedConnected", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    expect(context.latest().sentFrames).toEqual([
      {
        action: "subscribe",
        subscriptions: [{ topic: "crypto_prices_twap_thirty", type: "update" }],
      },
    ]);
    expect(context.eventTypes()).toEqual(["FeedConnected"]);
    expect(context.events[0]?.payload).toMatchObject({
      endpoint: "wss://ws-live-data.polymarket.com",
      subscriptionGeneration: 1,
      connectionId: "conn-1",
    });
  });

  it("still sends the subscription when the transport opens synchronously", () => {
    // The sibling adapters' review found exactly this: a transport that calls
    // onOpen from inside the factory call, before the handle is returned.
    const context = harness(
      {},
      {
        onCreate: (socket) => {
          socket.emitOpen();
        },
      },
    );
    context.feed.start();
    expect(context.latest().sent).toHaveLength(1);
    expect(context.eventTypes()).toEqual(["FeedConnected"]);
  });

  it("opens no gap on the first connection: nothing was missed", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    expect(context.eventTypes()).not.toContain("FeedGapDetected");
    expect(context.feed.openGap).toBeUndefined();
  });

  it("subscribes to both windows in one frame when both are configured", () => {
    const context = harness({
      subscriptions: [
        { windowSeconds: 30, symbols: ["btc/usd"] },
        { windowSeconds: 60 },
      ],
    });
    context.feed.start();
    context.latest().emitOpen();
    expect(context.latest().sentFrames[0]).toEqual({
      action: "subscribe",
      subscriptions: [
        {
          topic: "crypto_prices_twap_thirty",
          type: "update",
          filters: '{"symbol":"btc/usd"}',
        },
        { topic: "crypto_prices_twap_sixty", type: "update" },
      ],
    });
  });

  it("refuses to restart a stopped feed", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.feed.stop();
    expect(() => {
      context.feed.start();
    }).toThrow(PublicMarketStateError);
  });
});

describe("publishing observations", () => {
  it("records the raw frame before parsing it", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitMessage("definitely not json");
    expect(context.rawFrames).toHaveLength(1);
    expect(context.rawFrames[0]).toMatchObject({
      connectionId: "conn-1",
      subscriptionGeneration: 1,
      sourceChannel: "rtds:crypto-twap-ws",
      payload: "definitely not json",
    });
    expect(context.problems[0]?.code).toBe("RTDS_UNRECOGNIZED_FRAME");
  });

  it("publishes a TWAP observation with symbol, window and quality", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(twapUpdate());
    const event = context.events.at(-1);
    expect(event?.eventType).toBe("ReferenceTwapObserved");
    expect(event?.payload).toMatchObject({
      venue: "rtds",
      symbol: "btc/usd",
      windowSeconds: 30,
      value: "65000.5",
    });
    expect(context.feed.metrics().observationsPublished).toBe(1);
  });

  it("counts and reports a bare heartbeat text frame once per connection", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitMessage("PONG");
    context.latest().emitMessage("PONG");
    context.latest().emitMessage("PING");
    expect(context.problems.map((problem) => problem.code)).toEqual([
      "RTDS_UNDOCUMENTED_HEARTBEAT_TEXT",
    ]);
    expect(context.feed.metrics().heartbeatTextFramesReceived).toBe(3);
  });
});

describe("the client heartbeat", () => {
  it("sends the text PING every 5 seconds", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(15_000);
    expect(context.latest().sent.slice(1)).toEqual(["PING", "PING", "PING"]);
    expect(context.feed.metrics().heartbeatsSent).toBe(3);
  });

  it("stops sending once the socket closes", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(5_000);
    const sentWhileOpen = context.latest().sent.length;
    context.latest().emitClose({ code: 1006 });
    context.scheduler.advance(20_000);
    expect(context.sockets[0]?.sent).toHaveLength(sentWhileOpen);
  });
});

describe("staleness is data, and quiet is not death", () => {
  it("emits FeedStale once per episode, then again after a new episode", () => {
    const context = harness({ updateStalenessMs: 30_000, stalenessCheckIntervalMs: 5_000 });
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(60_000);
    expect(context.eventTypes().filter((type) => type === "FeedStale")).toHaveLength(1);

    context.latest().emitJson(twapUpdate());
    context.scheduler.advance(60_000);
    expect(context.eventTypes().filter((type) => type === "FeedStale")).toHaveLength(2);
    expect(context.feed.metrics().staleEpisodes).toBe(2);
  });

  it("does NOT close a quiet socket by default", () => {
    // RTDS-U1: the cadence is undocumented and must not be inferred, so quiet
    // is not evidence the socket is dead.
    const context = harness({ updateStalenessMs: 30_000 });
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(120_000);
    expect(context.latest().closedByClient).toBe(false);
    expect(context.eventTypes()).not.toContain("FeedDisconnected");
  });

  it("closes and reconnects when an operator opts in", () => {
    const context = harness({ updateStalenessMs: 30_000, reconnectWhenStale: true });
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(40_000);
    // The stale socket is the FIRST one; the backoff has already opened its
    // replacement inside the same window.
    expect(context.sockets[0]?.closedByClient).toBe(true);
    expect(context.events.find((event) => event.eventType === "FeedDisconnected")?.payload)
      .toMatchObject({ reasonCode: "STALE_CONNECTION" });
    expect(context.sockets.length).toBeGreaterThan(1);
  });

  it("exposes staleness as a typed metric, with no observability dependency", () => {
    const context = harness({ updateStalenessMs: 30_000 });
    expect(context.feed.metrics().stalenessMs).toBeUndefined();
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(7_000);
    expect(context.feed.metrics()).toMatchObject({
      status: "open",
      stalenessMs: 7_000,
      lastObservationAt: undefined,
    });
    context.latest().emitJson(twapUpdate());
    expect(context.feed.metrics().stalenessMs).toBe(0);
    expect(context.feed.metrics().lastObservationAt).toBeDefined();
  });
});

describe("reconnect fabricates no history", () => {
  it("resubscribes, advances the generation, and opens an unrecoverable gap", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(twapUpdate());
    context.latest().emitClose({ code: 1006, reason: "socket dropped" });
    context.scheduler.advance(1_000);
    context.latest().emitOpen();

    expect(context.eventTypes()).toEqual([
      "FeedConnected",
      "ReferenceTwapObserved",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
    ]);
    expect(context.feed.subscriptionGeneration).toBe(2);
    expect(context.feed.openGap).toMatchObject({
      reasonCode: "FEED_RECONNECTED",
      subscriptionGeneration: 2,
      previousSubscriptionGeneration: 1,
      recoverableFromVenue: false,
      unrecoverableReason: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
    });
    // The second socket really was resubscribed: "Direct clients must reconnect
    // and resubscribe after a disconnect."
    expect(context.sockets[1]?.sentFrames[0]).toMatchObject({ action: "subscribe" });
  });

  it("delivers the first post-reconnect update as a first observation, never a backfill", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(twapUpdate());
    context.latest().emitClose({});
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    context.latest().emitJson(twapUpdate({ observationMs: OBSERVATION_MS + 300_000 }));

    const observations = context.events.filter(
      (event) => event.eventType === "ReferenceTwapObserved",
    );
    // Exactly two observations: the one before the break and the one after it.
    // Nothing was interpolated, replayed, or carried forward across the gap.
    expect(observations).toHaveLength(2);
    const second = observations[1];
    expect(second?.eventType === "ReferenceTwapObserved" ? second.quality : undefined)
      .toMatchObject({
        firstObservationEver: false,
        firstObservationOnSubscription: true,
        unobservedInterval: {
          durationMs: 300_000,
          reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
          previousSubscriptionGeneration: 1,
        },
      });
  });

  it("never publishes FeedResynchronized", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitClose({});
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    context.latest().emitJson(twapUpdate());
    expect(context.eventTypes()).not.toContain("FeedResynchronized");
  });

  it("acknowledges an unobserved interval without claiming a recovery", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitClose({});
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    const before = context.events.length;

    expect(context.feed.acknowledgeUnobservedInterval({ subscriptionGeneration: 1 })).toMatchObject(
      { status: "rejected", reasonCode: "GENERATION_MISMATCH", expectedSubscriptionGeneration: 2 },
    );
    expect(context.feed.acknowledgeUnobservedInterval({ subscriptionGeneration: 2 })).toEqual({
      status: "accepted",
      subscriptionGeneration: 2,
    });
    expect(context.feed.acknowledgeUnobservedInterval({ subscriptionGeneration: 2 })).toMatchObject(
      { status: "rejected", reasonCode: "NO_OPEN_GAP" },
    );
    expect(context.feed.openGap).toBeUndefined();
    // Nothing was published: no recovery happened.
    expect(context.events).toHaveLength(before);
    expect(context.feed.metrics().acknowledgedGaps).toBe(1);
  });

  it("backs off exponentially between attempts", () => {
    const context = harness({ reconnectBaseDelayMs: 100, reconnectMaximumDelayMs: 1_000 });
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitClose({});
    context.scheduler.advance(99);
    expect(context.sockets).toHaveLength(1);
    context.scheduler.advance(1);
    expect(context.sockets).toHaveLength(2);
    context.latest().emitClose({});
    context.scheduler.advance(199);
    expect(context.sockets).toHaveLength(2);
    context.scheduler.advance(1);
    expect(context.sockets).toHaveLength(3);
  });
});

describe("connection identity binds every callback", () => {
  it("refuses a frame from a retired socket without relabelling it", () => {
    const context = harness();
    context.feed.start();
    const first = context.latest();
    first.emitOpen();
    first.emitClose({});
    context.scheduler.advance(1_000);
    context.latest().emitOpen();

    first.handlers.onMessage(JSON.stringify(twapUpdate()));
    const problem = context.problems.at(-1);
    expect(problem?.code).toBe("RTDS_STALE_CONNECTION_FRAME");
    expect(problem?.detail).toContain("conn-1");
    // Recorded raw under the STALE connection's own identity, never the live one.
    expect(context.rawFrames.at(-1)).toMatchObject({
      connectionId: "conn-1",
      subscriptionGeneration: 1,
    });
    expect(
      context.events.filter((event) => event.eventType === "ReferenceTwapObserved"),
    ).toHaveLength(0);
  });

  it("ignores a retired socket's error and close", () => {
    const context = harness();
    context.feed.start();
    const first = context.latest();
    first.emitOpen();
    first.emitClose({});
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    const eventsBefore = context.events.length;

    first.handlers.onError(new Error("late failure"));
    first.handlers.onClose({ code: 1011 });
    expect(context.events).toHaveLength(eventsBefore);
    expect(context.feed.connectionId).toBe("conn-2");
  });

  it("refuses a frame delivered before the subscription was written", () => {
    const context = harness(
      {},
      {
        onCreate: (socket) => {
          // A transport that is already connected: it opens and delivers a
          // frame while the factory call is still in flight.
          socket.handlers.onMessage(JSON.stringify(twapUpdate()));
        },
      },
    );
    context.feed.start();
    expect(context.problems.map((problem) => problem.code)).toEqual([
      "RTDS_PRE_SUBSCRIPTION_FRAME",
    ]);
    expect(context.problems[0]?.raw).toContain("crypto_prices_twap_thirty");
    expect(context.rawFrames).toHaveLength(1);
    expect(
      context.events.filter((event) => event.eventType === "ReferenceTwapObserved"),
    ).toHaveLength(0);
  });

  it("stands a pending reconnect down when the caller reconnects first", () => {
    const context = harness({ reconnectBaseDelayMs: 1_000 });
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitClose({});
    // The caller restarts during the backoff window.
    context.feed.start();
    expect(context.sockets).toHaveLength(2);
    context.latest().emitOpen();
    // The armed timer must not open a third socket over the live second one.
    context.scheduler.advance(10_000);
    expect(context.sockets).toHaveLength(2);
    expect(context.feed.connectionId).toBe("conn-2");
    expect(context.eventTypes()).not.toContain("CONNECTION_SUPERSEDED");
  });

  it("closes the socket and leaves no timer running when stopped", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.feed.stop();
    expect(context.latest().closedByClient).toBe(true);
    expect(context.eventTypes().at(-1)).toBe("FeedDisconnected");
    expect(context.scheduler.pendingTimerCount).toBe(0);
  });
});
