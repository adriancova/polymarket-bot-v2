/**
 * The whole feed lifecycle, offline, driven by the frozen fixtures.
 *
 * Connect → subscribe → receive the fixture events → lose the connection →
 * back off → reconnect under a new generation → detect the gap → fetch an
 * authoritative REST snapshot → declare the resynchronization. Every port is a
 * double: no socket, no HTTP request, no real clock, no randomness.
 *
 * This is the test that shows the §7.1 / §9.1 invariant end to end: a
 * reconnection is NOT a recovery, and the stream says so until a snapshot has
 * actually been applied.
 */

import {
  PublicBookSnapshotFetcher,
  PublicMarketFeed,
  type NormalizedPublicEventAny,
  type PublicMarketProblem,
  type RawMarketFrame,
} from "@polymarket-bot/polymarket-public";
import {
  fakeWebSocketFactory,
  ManualScheduler,
  sequentialConnectionIds,
  staticMarketDirectory,
  stubHttpClient,
  type TestMarketDefinition,
} from "@polymarket-bot/polymarket-public/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { loadLocalFixture, loadMarketWsFixture } from "./fixtures.js";

const MARKET: TestMarketDefinition = {
  internalMarketId: "0199f0a0-0000-7000-8000-000000000001",
  conditionId: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
  yesTokenId:
    "107505882767731489358349912513945399560393482969656700824895970500493757150417",
  noTokenId:
    "7305630249804085635496399869905769372294302716159034447326228509068694952392",
};

function fixtureExample(file: Parameters<typeof loadMarketWsFixture>[0], name: string): unknown {
  const found = loadMarketWsFixture(file).examples.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing fixture ${file}/${name}`);
  return found.payload;
}

interface Harness {
  readonly feed: PublicMarketFeed;
  readonly scheduler: ManualScheduler;
  readonly sockets: ReturnType<typeof fakeWebSocketFactory>;
  readonly events: NormalizedPublicEventAny[];
  readonly problems: PublicMarketProblem[];
  readonly frames: RawMarketFrame[];
  readonly snapshots: PublicBookSnapshotFetcher;
  types(): readonly string[];
}

function harness(
  transport: Parameters<typeof fakeWebSocketFactory>[0] = {},
): Harness {
  const scheduler = new ManualScheduler();
  const sockets = fakeWebSocketFactory(transport);
  const directory = staticMarketDirectory({ known: [MARKET], registrable: [MARKET] });
  const events: NormalizedPublicEventAny[] = [];
  const problems: PublicMarketProblem[] = [];
  const frames: RawMarketFrame[] = [];
  const restFixture = loadLocalFixture("fixtures/clob-book-rest.json");
  const singleBook = restFixture.examples.find(
    (entry) => entry.name === "single-book-40-char-hash",
  )?.payload;

  const feed = new PublicMarketFeed(
    {
      clock: scheduler.clock,
      timers: scheduler.timers,
      webSocketFactory: sockets.factory,
      directory,
      connectionId: sequentialConnectionIds(),
      randomFraction: () => 1,
    },
    {
      onEvent: (event) => events.push(event),
      onProblem: (problem) => problems.push(problem),
      onRawFrame: (frame) => frames.push(frame),
    },
    { customFeatureEnabled: true },
  );

  const http = stubHttpClient(() => ({ status: 200, body: JSON.stringify(singleBook) }));
  return {
    feed,
    scheduler,
    sockets,
    events,
    problems,
    frames,
    snapshots: new PublicBookSnapshotFetcher({ http: http.client, directory }),
    types: () => events.map((event) => event.eventType),
  };
}

describe("a full connect → consume → drop → recover cycle", () => {
  let subject: Harness;

  beforeEach(() => {
    subject = harness();
  });

  it("subscribes, consumes the frozen fixtures, and reports no problem", () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    subject.sockets.latest().emitJson(fixtureExample("book-snapshot", "book-snapshot"));
    subject.sockets.latest().emitJson(fixtureExample("price-change", "level-updated"));
    subject.sockets.latest().emitJson(fixtureExample("last-trade-price", "last-trade-price"));
    subject.sockets.latest().emitJson(fixtureExample("tick-size-change", "tick-size-change"));
    subject.sockets.latest().emitJson(fixtureExample("best-bid-ask", "best-bid-ask"));

    expect(subject.problems).toEqual([]);
    expect(subject.types()).toEqual([
      "FeedConnected",
      "BookSnapshot",
      "BookLevelChanged",
      "PublicTradeObserved",
      "TradingParametersChanged",
      "BestBidAskChanged",
    ]);
  });

  it("preserves every raw frame for the recorder, including the heartbeat reply", () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitMessage("PONG");
    subject.sockets.latest().emitJson(fixtureExample("book-snapshot", "book-snapshot"));

    expect(subject.frames).toHaveLength(2);
    expect(subject.frames[0]?.payload).toBe("PONG");
    expect(subject.frames[1]?.subscriptionGeneration).toBe(2);
    expect(subject.frames[1]?.connectionId).toBe("conn-1");
    expect(subject.frames[1]?.sourceChannel).toBe("polymarket:market-ws");
  });

  it("consumes a batched frame carrying several events at once", () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitJson([
      fixtureExample("book-snapshot", "book-snapshot"),
      fixtureExample("price-change", "level-updated"),
    ]);

    expect(subject.types()).toEqual(["FeedConnected", "BookSnapshot", "BookLevelChanged"]);
  });

  it("treats a reconnection as a gap until a snapshot is actually applied", async () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    const generationBefore = subject.feed.subscriptionGeneration;

    // The connection drops.
    subject.sockets.latest().emitClose({ code: 1006, reason: "abnormal closure" });
    // Backoff elapses and a new socket is created and opened.
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();

    expect(subject.types()).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
    ]);
    expect(subject.feed.subscriptionGeneration).toBeGreaterThan(generationBefore);
    expect(subject.feed.isAwaitingSnapshot).toBe(true);

    // A reopened socket is not a recovery, and the stream does not claim one.
    expect(subject.types()).not.toContain("FeedResynchronized");

    // The gateway reads which generation it owes a snapshot for...
    const gap = subject.feed.openGap;
    expect(gap).toMatchObject({
      reasonCode: "FEED_RECONNECTED",
      subscriptionGeneration: subject.feed.subscriptionGeneration,
    });

    // ...obtains the authoritative snapshot the gap requires...
    const snapshot = await subject.snapshots.fetchSnapshot(MARKET.yesTokenId, {
      subscriptionGeneration: gap?.subscriptionGeneration ?? 0,
    });
    expect(snapshot.problems).toEqual([]);
    expect(snapshot.events[0]?.eventType).toBe("BookSnapshot");

    // ...and only then is the resynchronization declared, for that generation
    // and no other.
    const outcome = subject.feed.markResynchronized({
      subscriptionGeneration: gap?.subscriptionGeneration ?? 0,
    });
    expect(outcome.status).toBe("accepted");
    expect(subject.types().at(-1)).toBe("FeedResynchronized");
    expect(subject.events.at(-1)?.payload).toMatchObject({
      authoritativeSnapshotApplied: true,
      subscriptionGeneration: gap?.subscriptionGeneration,
    });
    expect(subject.feed.isAwaitingSnapshot).toBe(false);

    // A second acknowledgement of the same gap publishes nothing.
    expect(
      subject.feed.markResynchronized({
        subscriptionGeneration: gap?.subscriptionGeneration ?? 0,
      }),
    ).toMatchObject({ status: "rejected", reasonCode: "NO_OPEN_GAP" });
    expect(subject.events.filter((event) => event.eventType === "FeedResynchronized")).toHaveLength(
      1,
    );
  });

  it("refuses to close a NEWER gap with a snapshot taken for an older generation", async () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();

    // The gateway fetches the snapshot the reconnect gap asked for...
    const staleGeneration = subject.feed.openGap?.subscriptionGeneration ?? 0;
    const snapshot = await subject.snapshots.fetchSnapshot(MARKET.yesTokenId, {
      subscriptionGeneration: staleGeneration,
    });
    expect(snapshot.events).toHaveLength(1);

    // ...but before it is applied, a subscription change opens a newer gap.
    subject.feed.subscribe([MARKET.noTokenId]);
    const currentGeneration = subject.feed.openGap?.subscriptionGeneration ?? 0;
    expect(currentGeneration).toBeGreaterThan(staleGeneration);

    expect(
      subject.feed.markResynchronized({ subscriptionGeneration: staleGeneration }),
    ).toMatchObject({
      status: "rejected",
      reasonCode: "GENERATION_MISMATCH",
      expectedSubscriptionGeneration: currentGeneration,
    });
    expect(subject.types()).not.toContain("FeedResynchronized");
    expect(subject.feed.isAwaitingSnapshot).toBe(true);
  });

  it("never publishes a frame from a socket it has already abandoned", async () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    const abandoned = subject.sockets.latest();
    abandoned.emitOpen();
    abandoned.emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();

    const eventsBefore = subject.events.length;
    const frame = JSON.stringify(fixtureExample("book-snapshot", "book-snapshot"));
    abandoned.handlers.onMessage(frame);

    // No event, one problem carrying the raw frame, and the raw record labelled
    // with the connection it really arrived on.
    expect(subject.events).toHaveLength(eventsBefore);
    expect(subject.problems.at(-1)).toMatchObject({
      code: "STALE_CONNECTION_FRAME",
      raw: frame,
    });
    expect(subject.frames.at(-1)).toMatchObject({ connectionId: "conn-1", payload: frame });
    await Promise.resolve();
  });

  it("resubscribes the full token set on the new connection", () => {
    subject.feed.subscribe([MARKET.yesTokenId, MARKET.noTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({});
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();

    expect(subject.sockets.sockets).toHaveLength(2);
    expect(subject.sockets.latest().sentFrames[0]).toEqual({
      assets_ids: [MARKET.yesTokenId, MARKET.noTokenId],
      type: "market",
      custom_feature_enabled: true,
      initial_dump: true,
    });
  });

  it("surfaces a malformed frame as a problem with its evidence, never as a drop", () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitMessage('{"event_type":"book","market":"0xabc"}');

    expect(subject.problems).toHaveLength(1);
    expect(subject.problems[0]?.code).toBe("INVALID_EVENT_PAYLOAD");
    expect(subject.problems[0]?.raw).toMatchObject({ event_type: "book" });
    // And the raw frame was handed to the recorder before it failed to parse.
    expect(subject.frames).toHaveLength(1);
  });

  it("emits no event carrying a sequence number of its own", () => {
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitJson(fixtureExample("book-snapshot", "book-snapshot"));

    for (const event of subject.events) {
      const serialized = JSON.stringify(event.provenance);
      expect(serialized).not.toMatch(/ingestSeq|sequenceNumber|"seq"/u);
    }
  });
});

describe("transports and subscriptions the round-2 review found unhandled", () => {
  it("subscribes a transport that was already connected when the factory returned", () => {
    // Round-2 finding H1. A transport is not obliged to open asynchronously,
    // and this one calls `onOpen` from inside the factory call — on the FIRST
    // connection and on the reconnect. Both must send the subscription and both
    // must consume the fixtures afterwards; before the fix the feed published
    // `FeedConnected` having sent nothing, so the socket was never subscribed
    // and every subsequent frame in this test would have been venue traffic
    // nobody asked for.
    const subject = harness({ onCreate: (socket) => socket.emitOpen() });
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();

    expect(subject.sockets.latest().sentFrames).toEqual([
      {
        assets_ids: [MARKET.yesTokenId],
        type: "market",
        custom_feature_enabled: true,
        initial_dump: true,
      },
    ]);
    expect(subject.types()).toEqual(["FeedConnected"]);

    subject.sockets.latest().emitJson(fixtureExample("book-snapshot", "book-snapshot"));
    expect(subject.problems).toEqual([]);
    expect(subject.types()).toEqual(["FeedConnected", "BookSnapshot"]);

    // The reconnect path, same transport behaviour: the socket opens inside the
    // factory call, so nothing here emits the open.
    subject.sockets.latest().emitClose({ code: 1006, reason: "abnormal closure" });
    subject.scheduler.advance(1_000);

    expect(subject.sockets.sockets).toHaveLength(2);
    expect(subject.sockets.latest().sentFrames).toHaveLength(1);
    expect(subject.types()).toEqual([
      "FeedConnected",
      "BookSnapshot",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
    ]);
    expect(subject.feed.openGap?.subscriptionGeneration).toBe(
      subject.feed.subscriptionGeneration,
    );
  });

  it("owes no snapshot for a reconnect with nothing subscribed", () => {
    // Round-2 finding H2. `planFullSubscription()` of an empty set resubscribes
    // nothing and does not advance the generation, so a gap opened here would
    // carry the generation the PREVIOUS gap already used — and the gateway's
    // acknowledgement of that older gap would close it, publishing a recovery
    // nobody performed. There are also no affected markets to recover.
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();

    // A real gap, acknowledged the ordinary way.
    const gap = subject.feed.openGap?.subscriptionGeneration ?? -1;
    expect(subject.feed.markResynchronized({ subscriptionGeneration: gap }).status).toBe(
      "accepted",
    );

    // Everything is unsubscribed, and the connection drops again.
    subject.feed.unsubscribe([MARKET.yesTokenId]);
    subject.sockets.latest().emitClose({ code: 1006 });
    subject.scheduler.advance(1_000);
    subject.sockets.latest().emitOpen();

    expect(subject.feed.subscriptionGeneration).toBe(gap);
    expect(subject.feed.openGap).toBeUndefined();
    expect(subject.feed.isAwaitingSnapshot).toBe(false);
    expect(subject.sockets.latest().sent).toEqual([]);
    // Replaying the acknowledgement already spent on the earlier gap publishes
    // nothing: there is exactly one recovery in this whole lifecycle.
    expect(subject.feed.markResynchronized({ subscriptionGeneration: gap })).toMatchObject({
      status: "rejected",
      reasonCode: "NO_OPEN_GAP",
    });
    expect(subject.events.filter((event) => event.eventType === "FeedResynchronized")).toHaveLength(
      1,
    );
  });
});

describe("session lifetimes the round-3 review found unhandled", () => {
  it("keeps the connection a manual start() opened during the backoff", async () => {
    // Round-3 finding H1. A drop arms a backoff timer; the caller reconnects
    // itself inside that window; the timer used to fire anyway and connect a
    // THIRD socket over the second one, which stayed open and subscribed while
    // every frame on it was refused as stale — a connection the consumer was
    // told about and never told about again.
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.sockets.latest().emitClose({ code: 1006, reason: "abnormal closure" });
    subject.feed.start();
    subject.sockets.latest().emitOpen();

    const manual = subject.sockets.latest();
    // Well past the 250 ms backoff deadline the drop armed.
    subject.scheduler.advance(1_000);

    expect(subject.sockets.sockets).toHaveLength(2);
    expect(subject.sockets.latest()).toBe(manual);
    expect(manual.isOpen).toBe(true);
    expect(manual.closedByClient).toBe(false);

    // The fixture stream still arrives as current data on that connection...
    manual.emitJson(fixtureExample("book-snapshot", "book-snapshot"));
    expect(subject.problems).toEqual([]);
    expect(subject.types()).toEqual([
      "FeedConnected",
      "FeedDisconnected",
      "FeedConnected",
      "FeedGapDetected",
      "BookSnapshot",
    ]);
    expect(subject.events.at(-1)?.provenance).toMatchObject({
      connectionId: subject.feed.connectionId,
      subscriptionGeneration: subject.feed.subscriptionGeneration,
    });

    // ...and the gap it opened is still the gap the gateway can close, because
    // the connection that opened it is still the connection that is live.
    const gap = subject.feed.openGap;
    expect(gap?.connectionId).toBe(subject.feed.connectionId);
    const snapshot = await subject.snapshots.fetchSnapshot(MARKET.yesTokenId, {
      subscriptionGeneration: gap?.subscriptionGeneration ?? 0,
    });
    expect(snapshot.problems).toEqual([]);
    expect(
      subject.feed.markResynchronized({
        subscriptionGeneration: gap?.subscriptionGeneration ?? 0,
      }).status,
    ).toBe("accepted");
  });

  it("refuses a fixture frame delivered before the subscription was written", () => {
    // Round-3 finding M1. The transport opens AND delivers a real book frame
    // from inside the factory call, before the handle exists — so before the
    // deferred open planned the subscription, sent it, or advanced the
    // session's generation. That frame used to be published as a BookSnapshot
    // stamped with the pre-subscription generation, ahead of `FeedConnected`.
    const book = fixtureExample("book-snapshot", "book-snapshot");
    const subject = harness({
      onCreate: (socket) => {
        socket.emitOpen();
        socket.emitJson(book);
      },
    });
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();

    expect(subject.types()).toEqual(["FeedConnected"]);
    expect(subject.problems.map((problem) => problem.code)).toEqual(["PRE_SUBSCRIPTION_FRAME"]);
    // Refused, never dropped: the payload rides on the problem and the raw
    // record keeps it under the generation it truly arrived at.
    expect(subject.problems[0]?.raw).toBe(JSON.stringify(book));
    expect(subject.frames).toHaveLength(1);
    expect(subject.frames[0]?.subscriptionGeneration).toBeLessThan(
      subject.feed.subscriptionGeneration,
    );
    // The connection itself is healthy: subscribed, announced, and the very
    // next frame is ordinary data.
    expect(subject.sockets.latest().sentFrames).toHaveLength(1);
    subject.sockets.latest().emitJson(book);
    expect(subject.problems).toHaveLength(1);
    expect(subject.types()).toEqual(["FeedConnected", "BookSnapshot"]);
  });
});

describe("lifecycle events carry no credential and no secret", () => {
  it("names only the public endpoint", () => {
    const subject = harness();
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    const connected = subject.events[0]?.payload as { endpoint: string };
    expect(connected.endpoint).toBe("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    expect(connected.endpoint).not.toContain("@");
    expect(connected.endpoint).not.toContain("key");
  });

  it("sends no authentication frame at any point", () => {
    const subject = harness();
    subject.feed.subscribe([MARKET.yesTokenId]);
    subject.feed.start();
    subject.sockets.latest().emitOpen();
    subject.scheduler.advance(30_000);

    for (const frame of subject.sockets.latest().sent) {
      expect(frame.toLowerCase()).not.toContain("auth");
      expect(frame.toLowerCase()).not.toContain("secret");
      expect(frame.toLowerCase()).not.toContain("passphrase");
      expect(frame.toLowerCase()).not.toContain("apikey");
    }
  });
});
