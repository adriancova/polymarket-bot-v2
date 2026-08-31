/**
 * Malformed and unknown inputs become typed problems carrying the raw value.
 *
 * §8.3 forbids dropping a market event silently, and ADR-002's Consequences
 * require the gateway to turn a typed failure into a `DataQualityIncidentOpened`
 * with the raw frame preserved. Nothing here may throw, and nothing may vanish.
 */

import {
  ManualScheduler,
  fakeWebSocketFactory,
  sequentialConnectionIds,
} from "@polymarket-bot/polymarket-public/testing";
import {
  RtdsTwapFeed,
  TwapObservationTracker,
  normalizeRtdsFrame,
  rtdsDataQualityIncidentFromProblem,
  type NormalizedRtdsEventAny,
  type RawRtdsFrame,
  type RtdsNormalizationContext,
  type RtdsProblem,
} from "@polymarket-bot/polymarket-public/rtds";
import { describe, expect, it } from "vitest";

import { loadLocalFixture } from "./fixtures.js";

const malformed = loadLocalFixture("./fixtures/malformed.json");

function context(): RtdsNormalizationContext {
  return {
    sourceChannel: "rtds:crypto-twap-ws",
    connectionId: "conn-1",
    subscriptionGeneration: 1,
    subscribedTopics: new Set(["crypto_prices_twap_thirty", "crypto_prices_twap_sixty"]),
    receivedEpochMs: 1785178800500,
    tracker: new TwapObservationTracker({ duplicateWindow: 8, maxTrackedSeries: 8 }),
  };
}

describe("every malformed probe is refused under its own code", () => {
  it("labels each probe with the code it expects", () => {
    // Guards the suite against a fixture that silently stops asserting anything.
    expect(malformed.examples.length).toBeGreaterThanOrEqual(10);
    for (const example of malformed.examples) {
      expect(example.expectedProblemCode).toBeDefined();
    }
    expect(malformed.provenance).toContain("DELIBERATELY BROKEN PROBES");
  });

  for (const example of malformed.examples) {
    it(`reports ${String(example.expectedProblemCode)} for ${example.name}`, () => {
      const { events, problems } = normalizeRtdsFrame([example.payload], context());
      expect(events).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.code).toBe(example.expectedProblemCode);
      // The evidence rides on the problem, unmodified.
      expect(problems[0]?.raw).toBe(example.payload);
      expect(problems[0]?.detail.length).toBeGreaterThan(0);
      expect(problems[0]?.detail.length).toBeLessThanOrEqual(2000);
    });
  }

  it("becomes a DataQualityIncidentOpened on the same vocabulary", () => {
    const { problems } = normalizeRtdsFrame([malformed.examples[0]?.payload], context());
    const problem = problems[0] as RtdsProblem;
    const incident = rtdsDataQualityIncidentFromProblem(problem, {
      incidentId: "incident-1",
      openedAt: "2026-07-27T19:00:00.000Z",
      severity: "NOTIFY",
      feedId: "polymarket-rtds-twap",
    });
    expect(incident.payload).toMatchObject({ reasonCode: problem.code });
  });
});

describe("frames that are not even envelopes", () => {
  function feedHarness() {
    const scheduler = new ManualScheduler(Date.UTC(2026, 6, 27, 19, 0, 0));
    const { factory, latest } = fakeWebSocketFactory();
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
      { subscriptions: [{ windowSeconds: 30 }] },
    );
    feed.start();
    latest().emitOpen();
    return { feed, latest, events, problems, rawFrames };
  }

  it("records the raw frame before it decides the frame is junk", () => {
    const context_ = feedHarness();
    for (const raw of ["", "   ", "not json at all", "42", "[]", '{"a":1}']) {
      context_.latest().emitMessage(raw);
    }
    // Six frames in: six raw records, six problems, zero events beyond the
    // connection announcement.
    expect(context_.rawFrames).toHaveLength(6);
    expect(context_.problems).toHaveLength(6);
    expect(context_.events.map((event) => event.eventType)).toEqual(["FeedConnected"]);
    expect(context_.problems.map((problem) => problem.code)).toEqual([
      "RTDS_UNRECOGNIZED_FRAME",
      "RTDS_UNRECOGNIZED_FRAME",
      "RTDS_UNRECOGNIZED_FRAME",
      "RTDS_UNRECOGNIZED_FRAME",
      "RTDS_UNRECOGNIZED_FRAME",
      "RTDS_INVALID_ENVELOPE",
    ]);
  });

  it("survives a frame designed to be hostile rather than merely wrong", () => {
    const context_ = feedHarness();
    const hostile = [
      JSON.stringify({ topic: "x".repeat(10_000), type: "update", payload: {} }),
      JSON.stringify({
        topic: "crypto_prices_twap_thirty",
        type: "update",
        timestamp: 1785178800123,
        payload: {
          symbol: "s".repeat(10_000),
          value: 1,
          full_accuracy_value: "1",
          timestamp: 1785178800000,
          window_s: 30,
        },
      }),
      JSON.stringify({
        topic: "crypto_prices_twap_thirty",
        type: "update",
        timestamp: 1785178800123,
        payload: {
          symbol: "btc/usd",
          value: 1,
          full_accuracy_value: "9".repeat(900),
          timestamp: 1785178800000,
          window_s: 30,
        },
      }),
    ];
    for (const raw of hostile) context_.latest().emitMessage(raw);
    expect(context_.problems).toHaveLength(3);
    for (const problem of context_.problems) {
      expect(problem.detail.length).toBeLessThanOrEqual(2000);
      expect((problem.topic ?? "").length).toBeLessThanOrEqual(64);
      expect((problem.symbol ?? "").length).toBeLessThanOrEqual(64);
    }
    // And the feed is still usable afterwards.
    context_.latest().emitJson({
      topic: "crypto_prices_twap_thirty",
      type: "update",
      timestamp: 1785178800123,
      payload: {
        symbol: "btc/usd",
        value: 65000.5,
        full_accuracy_value: "65000500000000000000000",
        timestamp: 1785178800000,
        window_s: 30,
      },
    });
    expect(context_.events.at(-1)?.eventType).toBe("ReferenceTwapObserved");
  });
});
