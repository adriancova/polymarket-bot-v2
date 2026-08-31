/**
 * Stream-gap and first-update behaviour (`WP-100` acceptance 2 and 3).
 *
 * Verbatim, from https://docs.polymarket.com/market-data/chainlink-twap
 * (accessed 2026-08-28): "Subscriptions start with the next update. There is no
 * snapshot, history, or replay after a disconnect."
 *
 * So the properties this suite pins are, in order of how much they matter:
 *
 * 1. nothing is fabricated across a gap — no interpolation, no backfill, no
 *    carried-forward value, no invented count of missed updates;
 * 2. the first update after a (re)connect is delivered as a first observation
 *    with an explicit staleness/gap signal;
 * 3. the gap itself is typed, queryable, and honest about being unrecoverable.
 */

import {
  ManualScheduler,
  fakeWebSocketFactory,
  sequentialConnectionIds,
} from "@polymarket-bot/polymarket-public/testing";
import {
  RtdsTwapFeed,
  type NormalizedRtdsEventAny,
  type NormalizedTwapObservation,
  type RtdsProblem,
} from "@polymarket-bot/polymarket-public/rtds";
import { describe, expect, it } from "vitest";

import { loadLocalFixture } from "./fixtures.js";

const stream = loadLocalFixture("./fixtures/twap-stream.json");

function example(name: string): unknown {
  const found = stream.examples.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no derived example named "${name}"`);
  return found.payload;
}

function harness(options: Record<string, unknown> = {}) {
  const scheduler = new ManualScheduler(Date.UTC(2026, 6, 27, 19, 0, 0));
  const { factory, sockets, latest } = fakeWebSocketFactory();
  const events: NormalizedRtdsEventAny[] = [];
  const problems: RtdsProblem[] = [];
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
    },
    { subscriptions: [{ windowSeconds: 30 }], ...options },
  );
  const observations = (): readonly NormalizedTwapObservation[] =>
    events.filter(
      (event): event is NormalizedTwapObservation =>
        event.eventType === "ReferenceTwapObserved",
    );
  return { feed, scheduler, sockets, latest, events, problems, observations };
}

describe("the first update of a connection", () => {
  it("is a first observation, with no history claimed for it", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(example("thirty-btc-t0"));

    const quality = context.observations()[0]?.quality;
    expect(quality).toMatchObject({
      firstObservationEver: true,
      firstObservationOnSubscription: true,
      outOfOrder: false,
    });
    expect(quality?.previousObservationAt).toBeUndefined();
    expect(quality?.sincePreviousObservationMs).toBeUndefined();
    expect(quality?.unobservedInterval).toBeUndefined();
  });

  it("is not preceded by any invented snapshot event", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    // A subscription "starts with the next update": no snapshot arrives, and
    // this adapter must not manufacture one to fill the silence.
    expect(context.events.map((event) => event.eventType)).toEqual(["FeedConnected"]);
    expect(context.observations()).toHaveLength(0);
  });

  it("measures the interval to the next update on the same subscription", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(example("thirty-btc-t0"));
    context.latest().emitJson(example("thirty-btc-t1"));

    expect(context.observations()[1]?.quality).toMatchObject({
      firstObservationEver: false,
      firstObservationOnSubscription: false,
      previousObservationAt: "2026-07-27T19:00:00.000Z",
      sincePreviousObservationMs: 30_000,
    });
    expect(context.observations()[1]?.quality.unobservedInterval).toBeUndefined();
  });
});

describe("a reconnect fabricates nothing", () => {
  function reconnected() {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(example("thirty-btc-t0"));
    context.latest().emitJson(example("thirty-btc-t1"));
    context.latest().emitClose({ code: 1006, reason: "socket dropped" });
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    return context;
  }

  it("publishes exactly the updates it received, and no others", () => {
    const context = reconnected();
    context.latest().emitJson(example("thirty-btc-t2-after-outage"));
    // Two before the break, one after. The five minutes in between produced no
    // events at all: an unobserved interval has no observations, and this
    // adapter does not manufacture them.
    expect(context.observations()).toHaveLength(3);
    expect(context.observations().map((event) => event.payload.windowEndAt)).toEqual([
      "2026-07-27T19:00:00.000Z",
      "2026-07-27T19:00:30.000Z",
      "2026-07-27T19:05:30.000Z",
    ]);
  });

  it("opens a typed gap that says it cannot be recovered from the venue", () => {
    const context = reconnected();
    expect(context.feed.openGap).toEqual({
      reasonCode: "FEED_RECONNECTED",
      subscriptionGeneration: 2,
      previousSubscriptionGeneration: 1,
      connectionId: "conn-2",
      detectedAt: expect.any(String) as unknown as string,
      recoverableFromVenue: false,
      unrecoverableReason: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
    });
    const gap = context.events.find((event) => event.eventType === "FeedGapDetected");
    expect(gap?.payload).toMatchObject({ requiresAuthoritativeSnapshot: true });
    expect(JSON.stringify(gap?.payload)).toContain("no snapshot, history or replay");
  });

  it("marks the first post-reconnect update and measures what it did not see", () => {
    const context = reconnected();
    context.latest().emitJson(example("thirty-btc-t2-after-outage"));
    const quality = context.observations().at(-1)?.quality;
    expect(quality).toMatchObject({
      firstObservationEver: false,
      firstObservationOnSubscription: true,
      previousObservationAt: "2026-07-27T19:00:30.000Z",
      unobservedInterval: {
        fromAt: "2026-07-27T19:00:30.000Z",
        toAt: "2026-07-27T19:05:30.000Z",
        durationMs: 300_000,
        reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
        previousSubscriptionGeneration: 1,
      },
    });
  });

  it("states no count of missed updates anywhere", () => {
    // The cadence is undocumented and the page says "never infer the window
    // from update frequency", so a missed-update count could only be a guess.
    const context = reconnected();
    context.latest().emitJson(example("thirty-btc-t2-after-outage"));
    const serialized = JSON.stringify(context.observations().at(-1));
    expect(serialized).not.toMatch(/missed|skipped|expectedUpdates/iu);
  });

  it("never publishes a recovery it cannot perform", () => {
    const context = reconnected();
    context.latest().emitJson(example("thirty-btc-t2-after-outage"));
    expect(context.events.map((event) => event.eventType)).not.toContain("FeedResynchronized");
  });

  it("keeps the gap open until the caller acknowledges its exact generation", () => {
    const context = reconnected();
    context.latest().emitJson(example("thirty-btc-t2-after-outage"));
    // A fresh observation does NOT close the gap: it is new data, not the
    // recovery of what was missed.
    expect(context.feed.openGap?.subscriptionGeneration).toBe(2);
    expect(
      context.feed.acknowledgeUnobservedInterval({ subscriptionGeneration: 1 }).status,
    ).toBe("rejected");
    expect(
      context.feed.acknowledgeUnobservedInterval({ subscriptionGeneration: 2 }).status,
    ).toBe("accepted");
    expect(context.feed.openGap).toBeUndefined();
  });

  it("supersedes an unacknowledged gap with the newer one", () => {
    const context = reconnected();
    context.latest().emitClose({});
    context.scheduler.advance(2_000);
    context.latest().emitOpen();
    expect(context.feed.openGap).toMatchObject({
      subscriptionGeneration: 3,
      previousSubscriptionGeneration: 2,
    });
    // The stale acknowledgement for generation 2 must not clear generation 3's.
    expect(
      context.feed.acknowledgeUnobservedInterval({ subscriptionGeneration: 2 }),
    ).toMatchObject({ status: "rejected", reasonCode: "GENERATION_MISMATCH" });
    expect(context.feed.openGap?.subscriptionGeneration).toBe(3);
  });
});

describe("a reconnect whose first update is not newer than the last one before it", () => {
  /**
   * Round-1 review finding M2, at the feed level. The break is real; what is
   * missing is a second real observation to measure it against, and inventing
   * one is exactly what this adapter refuses to do. So the obligation is
   * neither discharged nor forgotten: it is stated, then measured as soon as an
   * observation can bound it.
   */
  function regressedAfterReconnect() {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(example("thirty-btc-t0"));
    context.latest().emitJson(example("thirty-btc-t1"));
    context.latest().emitClose({ code: 1006, reason: "socket dropped" });
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    context.latest().emitJson(example("thirty-btc-t1-regressed-after-outage"));
    return context;
  }

  it("states the gap it cannot measure rather than reporting none", () => {
    const context = regressedAfterReconnect();
    const quality = context.observations().at(-1)?.quality;
    expect(quality).toMatchObject({
      firstObservationOnSubscription: true,
      outOfOrder: true,
      unobservedIntervalUnavailable: {
        fromAt: "2026-07-27T19:00:30.000Z",
        reasonCode: "RTDS_NO_OBSERVATION_NEWER_THAN_GAP",
        previousSubscriptionGeneration: 1,
      },
    });
    expect(quality?.unobservedInterval).toBeUndefined();
    // The observation itself is still published — it is real data.
    expect(context.observations()).toHaveLength(3);
    expect(context.problems).toEqual([]);
  });

  it("measures the interval on the first later update that can bound it", () => {
    const context = regressedAfterReconnect();
    context.latest().emitJson(example("thirty-btc-t2-after-outage"));
    const quality = context.observations().at(-1)?.quality;
    expect(quality?.unobservedIntervalUnavailable).toBeUndefined();
    expect(quality?.unobservedInterval).toEqual({
      fromAt: "2026-07-27T19:00:30.000Z",
      toAt: "2026-07-27T19:05:30.000Z",
      durationMs: 300_000,
      reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
      previousSubscriptionGeneration: 1,
    });
    // Measured between two real observations, and still no count of what fell
    // inside it.
    expect(JSON.stringify(quality)).not.toMatch(/missed|skipped|expectedUpdates/iu);
  });

  it("fabricates nothing to make the interval measurable", () => {
    const context = regressedAfterReconnect();
    // Three received updates, three published observations, no fourth one
    // invented to bound the gap, and no recovery claimed.
    expect(context.observations().map((event) => event.payload.windowEndAt)).toEqual([
      "2026-07-27T19:00:00.000Z",
      "2026-07-27T19:00:30.000Z",
      "2026-07-27T19:00:15.000Z",
    ]);
    expect(context.events.map((event) => event.eventType)).not.toContain("FeedResynchronized");
    // The feed's own gap state is unchanged by any of this: it is cleared by an
    // acknowledgement, never by an observation.
    expect(context.feed.openGap?.subscriptionGeneration).toBe(2);
  });
});

describe("staleness is surfaced as data quality", () => {
  it("emits FeedStale and exposes the same fact as a typed metric", () => {
    const context = harness({ updateStalenessMs: 30_000, stalenessCheckIntervalMs: 5_000 });
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(example("thirty-btc-t0"));
    context.scheduler.advance(45_000);

    const stale = context.events.find((event) => event.eventType === "FeedStale");
    expect(stale?.payload).toMatchObject({
      feedId: "polymarket-rtds-twap",
      connectionId: "conn-1",
      stalenessMs: 35_000,
    });
    expect(context.feed.metrics()).toMatchObject({
      status: "open",
      staleEpisodes: 1,
      observationsPublished: 1,
      stalenessMs: 45_000,
    });
  });

  it("reports observation age on every event, from two distinct clocks", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.scheduler.advance(1_500);
    context.latest().emitJson(example("thirty-btc-t0"));
    // The harness clock starts at the observation instant, so the age is the
    // 1 500 ms of local time that passed before the frame arrived.
    expect(context.observations()[0]?.quality.observationAgeMs).toBe(1_500);
  });

  it("needs no observability dependency to be queried", () => {
    const context = harness();
    context.feed.start();
    context.latest().emitOpen();
    context.latest().emitJson(example("thirty-btc-t0"));
    const metrics = context.feed.metrics();
    // Every field is a plain typed value a dashboard can read directly.
    for (const value of Object.values(metrics)) {
      expect(typeof value).not.toBe("function");
    }
    expect(metrics.trackedSeries).toBe(1);
    expect(metrics.lastObservationAt).toBe("2026-07-27T19:00:00.000Z");
  });
});
