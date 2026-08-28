/**
 * The subscribe frame this adapter puts on the wire, against the frozen fixture.
 *
 * Both documented forms are frozen by `WP-000` — one with `filters`, one
 * without — and the second one exists precisely because the `filters`-is-
 * mandatory reading was wrong and was corrected in round 4. This suite drives
 * the real feed and compares the bytes it sends.
 */

import { ManualScheduler, fakeWebSocketFactory, sequentialConnectionIds } from "@polymarket-bot/polymarket-public/testing";
import {
  RtdsTwapFeed,
  type NormalizedRtdsEventAny,
  type RtdsProblem,
  type RtdsTwapWindowSubscription,
} from "@polymarket-bot/polymarket-public/rtds";
import { describe, expect, it } from "vitest";

import { frozenExample } from "./fixtures.js";

function startedFeed(subscriptions: readonly RtdsTwapWindowSubscription[]) {
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
    { subscriptions },
  );
  feed.start();
  latest().emitOpen();
  return { feed, scheduler, sockets, latest, events, problems };
}

describe("the subscribe frame matches the frozen fixture byte for byte", () => {
  it("reproduces the documented single-symbol form", () => {
    const context = startedFeed([{ windowSeconds: 30, symbols: ["btc/usd"] }]);
    expect(context.latest().sentFrames[0]).toEqual(frozenExample("subscribe-request"));
  });

  it("reproduces the documented omitted-filters form", () => {
    // "Omit it to receive every available symbol." The frozen fixture example
    // `subscribe-request-all-symbols-no-filters` is the corrected round-4 form.
    const context = startedFeed([{ windowSeconds: 60 }]);
    expect(context.latest().sentFrames[0]).toEqual(
      frozenExample("subscribe-request-all-symbols-no-filters"),
    );
  });

  it("omits filters when one window needs several symbols", () => {
    // "If you need several symbols for one window, omit filters and filter
    // updates by payload.symbol in your application."
    const context = startedFeed([{ windowSeconds: 30, symbols: ["btc/usd", "eth/usd"] }]);
    const frame = context.latest().sentFrames[0] as {
      subscriptions: readonly Record<string, unknown>[];
    };
    expect(frame.subscriptions).toHaveLength(1);
    expect(Object.hasOwn(frame.subscriptions[0] ?? {}, "filters")).toBe(false);
  });

  it("sends one frame carrying both windows", () => {
    const context = startedFeed([
      { windowSeconds: 30, symbols: ["btc/usd"] },
      { windowSeconds: 60, symbols: ["btc/usd"] },
    ]);
    expect(context.latest().sent).toHaveLength(1);
    expect(context.latest().sentFrames[0]).toEqual({
      action: "subscribe",
      subscriptions: [
        (frozenExample("subscribe-request") as { subscriptions: unknown[] }).subscriptions[0],
        {
          topic: "crypto_prices_twap_sixty",
          type: "update",
          filters: '{"symbol":"btc/usd"}',
        },
      ],
    });
  });
});

describe("client-side symbol filtering is the caller's job, not a silent drop", () => {
  it("publishes an update for a symbol the subscription did not name", () => {
    // With several symbols wanted, `filters` is omitted and the socket really
    // does deliver every symbol. Dropping the ones the caller did not name
    // would be a silent drop of valid venue data (§8.3); the symbol is explicit
    // on every event so the gateway can filter.
    const context = startedFeed([{ windowSeconds: 30, symbols: ["btc/usd", "eth/usd"] }]);
    context.latest().emitJson({
      topic: "crypto_prices_twap_thirty",
      type: "update",
      timestamp: 1785178800123,
      payload: {
        symbol: "sol/usd",
        value: 150.5,
        full_accuracy_value: "150500000000000000000",
        timestamp: 1785178800000,
        window_s: 30,
      },
    });
    const observation = context.events.at(-1);
    expect(observation?.eventType).toBe("ReferenceTwapObserved");
    expect(observation?.payload).toMatchObject({ symbol: "sol/usd", value: "150.5" });
    expect(context.problems).toEqual([]);
  });

  it("refuses an update on a window it never subscribed to", () => {
    const context = startedFeed([{ windowSeconds: 30 }]);
    context.latest().emitJson(frozenExample("twap-update-60s"));
    expect(context.problems.map((problem) => problem.code)).toEqual([
      "RTDS_TOPIC_NOT_SUBSCRIBED",
    ]);
    expect(context.problems[0]?.raw).toBeDefined();
    expect(
      context.events.filter((event) => event.eventType === "ReferenceTwapObserved"),
    ).toHaveLength(0);
  });
});

describe("resubscription after a disconnect", () => {
  it("re-sends the identical frame on the new socket", () => {
    // "Direct clients must reconnect and resubscribe after a disconnect."
    const context = startedFeed([{ windowSeconds: 30, symbols: ["btc/usd"] }]);
    context.latest().emitClose({ code: 1006 });
    context.scheduler.advance(1_000);
    context.latest().emitOpen();
    expect(context.sockets).toHaveLength(2);
    expect(context.sockets[1]?.sentFrames[0]).toEqual(frozenExample("subscribe-request"));
  });
});
