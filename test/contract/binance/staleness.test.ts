/**
 * `WP-080` deliverable 3: staleness metrics as typed queryable values.
 *
 * Two properties are under test, and they are separable:
 *
 * 1. **Staleness is data.** `metrics()` reports it as a number against the
 *    caller's own stamp, with no hidden wall-clock read anywhere in the adapter.
 * 2. **Crossing the caller's threshold is an event.** `FeedStale` is emitted once
 *    per silence episode and re-armed by the next frame, so a long outage
 *    produces one report rather than one per poll — while `staleEpisodes` still
 *    counts the episodes.
 *
 * The threshold is the caller's, never this package's: Binance documents no
 * maximum interval between two market-data messages, and a default here would be
 * an invented venue fact.
 */

import { BinanceReferenceFeed } from "@polymarket-bot/binance-adapter";
import { FeedStaleContract } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { framesFixture, frameText } from "./fixtures.js";
import { createHarness, deliver, eventTypesOf, open } from "./support.js";

const TRADE = framesFixture("trade-documented");

function tradeText(): string {
  const frame = TRADE.frames[0];
  if (frame === undefined) {
    throw new Error("fixture frame missing");
  }
  return frameText(frame);
}

describe("staleness as queryable data", () => {
  it("requires the caller to state a threshold; there is no invented default", () => {
    expect(
      () =>
        new BinanceReferenceFeed({
          feedId: "binance.reference",
          subscriptions: [{ symbol: "BNBBTC", suffix: "trade" }],
          // @ts-expect-error the option is required precisely so it cannot default
          stalenessThresholdMs: undefined,
        }),
    ).toThrow();
  });

  it("measures silence from the last frame, against the caller's stamp", () => {
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-stale");
    deliver(harness, tradeText(), harness.clock.advance(1_000));

    expect(harness.feed.metrics(harness.clock.advance(2_500)).stalenessMs).toBe(2_500);
    expect(harness.feed.metrics(harness.clock.advance(2_500)).stalenessMs).toBe(5_000);
  });

  it("measures from the connect stamp before the first frame arrives", () => {
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-stale");
    const metrics = harness.feed.metrics(harness.clock.advance(3_000));
    expect(metrics.stalenessMs).toBe(3_000);
    expect(metrics.lastFrameAt).toBeUndefined();
  });

  it("reports `stale` against the caller's threshold, inclusively", () => {
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-stale");
    expect(harness.feed.metrics(harness.clock.advance(9_999)).stale).toBe(false);
    expect(harness.feed.metrics(harness.clock.advance(1)).stale).toBe(true);
  });

  it("reports the remaining budget before the documented 24-hour disconnect", () => {
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-stale");
    const metrics = harness.feed.metrics(harness.clock.advance(60_000));
    expect(metrics.connectionLifetimeMs).toBe(86_400_000);
    expect(metrics.connectionAgeMs).toBe(60_000);
    expect(metrics.connectionLifetimeRemainingMs).toBe(86_340_000);
  });
});

describe("staleness as an event", () => {
  it("emits FeedStale once per silence episode and re-arms on the next frame", () => {
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-stale");
    deliver(harness, tradeText(), harness.clock.advance(1_000));

    const first = harness.feed.checkStaleness(harness.clock.advance(10_000));
    expect(eventTypesOf(first.emissions)).toEqual(["FeedStale"]);
    expect(FeedStaleContract.payloadSchema.safeParse(first.emissions[0]?.payload).success).toBe(
      true,
    );

    // Still silent, still one report.
    expect(harness.feed.checkStaleness(harness.clock.advance(30_000)).emissions).toEqual([]);

    // A frame ends the episode; the next silence is a new one.
    deliver(
      harness,
      JSON.stringify({
        e: "trade",
        E: 1672515790000,
        s: "BNBBTC",
        t: 999_999,
        p: "0.001",
        q: "1",
        T: 1672515790000,
        m: false,
      }),
      harness.clock.advance(1),
    );
    expect(
      eventTypesOf(harness.feed.checkStaleness(harness.clock.advance(10_000)).emissions),
    ).toEqual(["FeedStale"]);
    expect(harness.feed.metrics(harness.clock.peek()).connections.staleEpisodes).toBe(2);
  });

  it("reports the last message instant alongside the elapsed silence", () => {
    const harness = createHarness(
      { stalenessThresholdMs: 5_000 },
      { startAt: "2026-08-27T09:00:00.000Z" },
    );
    open(harness, "conn-stale");
    deliver(harness, tradeText(), harness.clock.advance(2_000));
    const outcome = harness.feed.checkStaleness(harness.clock.advance(7_500));

    const payload = outcome.emissions[0]?.payload as {
      stalenessMs: number;
      lastMessageAt: string;
      detectedAt: string;
    };
    expect(payload.stalenessMs).toBe(7_500);
    expect(payload.lastMessageAt).toBe("2026-08-27T09:00:02.000Z");
    expect(payload.detectedAt).toBe("2026-08-27T09:00:09.500Z");
  });

  it("says nothing about a feed that is not connected", () => {
    const harness = createHarness({ stalenessThresholdMs: 1 });
    expect(harness.feed.checkStaleness(harness.clock.advance(1_000_000)).emissions).toEqual([]);
  });

  it("keeps watching a live socket while a replacement connection is being opened", () => {
    // A registered replacement is not a disconnect: until it opens, the socket
    // the feed is listening to is still the one whose silence matters
    // (round-3 review, R3-M1 — this interval used to report nothing at all).
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-stale");
    deliver(harness, tradeText(), harness.clock.advance(1_000));
    harness.feed.connecting("conn-replacement");

    expect(harness.feed.metrics(harness.clock.advance(10_000)).stale).toBe(true);
    expect(
      eventTypesOf(harness.feed.checkStaleness(harness.clock.peek()).emissions),
    ).toEqual(["FeedStale"]);
  });

  it("treats any frame as proof of life, including one it cannot use", () => {
    const harness = createHarness({ stalenessThresholdMs: 10_000 });
    open(harness, "conn-stale");
    deliver(harness, tradeText(), harness.clock.advance(1_000));
    harness.feed.checkStaleness(harness.clock.advance(10_000));

    // A control response carries no market data, but the socket is alive.
    deliver(harness, '{"result":null,"id":1}', harness.clock.advance(1));
    expect(harness.feed.metrics(harness.clock.peek()).stalenessMs).toBe(0);
  });
});
