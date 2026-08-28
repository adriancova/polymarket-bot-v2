import { ReferenceTwapObservedContract } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { normalizeRtdsFrame, type RtdsNormalizationContext } from "./normalize.js";
import { TwapObservationTracker } from "./observations.js";

const BOTH_TOPICS = new Set(["crypto_prices_twap_thirty", "crypto_prices_twap_sixty"]);

/** The documented 30-second example, verbatim from the official page. */
const THIRTY_UPDATE = {
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
};

function context(overrides: Partial<RtdsNormalizationContext> = {}): RtdsNormalizationContext {
  return {
    sourceChannel: "rtds:crypto-twap-ws",
    connectionId: "conn-1",
    subscriptionGeneration: 1,
    subscribedTopics: BOTH_TOPICS,
    receivedEpochMs: 1785178800200,
    tracker: new TwapObservationTracker({ duplicateWindow: 8, maxTrackedSeries: 8 }),
    ...overrides,
  };
}

function normalizeOne(value: unknown, overrides: Partial<RtdsNormalizationContext> = {}) {
  return normalizeRtdsFrame([value], context(overrides));
}

describe("the documented example becomes a ReferenceTwapObserved", () => {
  it("carries symbol and window explicitly, and the exact scaled value", () => {
    const { events, problems } = normalizeOne(THIRTY_UPDATE);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      venue: "rtds",
      symbol: "btc/usd",
      feedId: "crypto_prices_twap_thirty",
      value: "65000.5",
      windowSeconds: 30,
      windowStartAt: "2026-07-27T18:59:30.000Z",
      windowEndAt: "2026-07-27T19:00:00.000Z",
    });
  });

  it("passes its own frozen domain contract", () => {
    const { events } = normalizeOne(THIRTY_UPDATE);
    expect(
      ReferenceTwapObservedContract.payloadSchema.safeParse(events[0]?.payload).success,
    ).toBe(true);
    expect(events[0]?.eventType).toBe("ReferenceTwapObserved");
    expect(events[0]?.schemaVersion).toBe(ReferenceTwapObservedContract.schemaVersion);
  });

  it("keeps the publisher timestamp, the observation time and receipt distinct", () => {
    const { events } = normalizeOne(THIRTY_UPDATE);
    // The outer timestamp is when the publisher submitted the update to RTDS.
    expect(events[0]?.provenance.venueTimestamp).toBe("2026-07-27T19:00:00.123Z");
    // The payload timestamp is the Chainlink observation time, and it is the
    // window's end — a different instant, 123 ms earlier.
    expect(events[0]?.payload.windowEndAt).toBe("2026-07-27T19:00:00.000Z");
    // Receipt is this host's clock, and it appears only as a diagnostic.
    expect(events[0]?.quality.observationAgeMs).toBe(200);
  });

  it("stamps rtds provenance, the topic channel, and the connection", () => {
    const { events } = normalizeOne(THIRTY_UPDATE);
    expect(events[0]?.provenance).toMatchObject({
      source: "rtds",
      sourceChannel: "rtds:crypto_prices_twap_thirty",
      connectionId: "conn-1",
      subscriptionGeneration: 1,
      observedIndex: 0,
    });
  });

  it("normalizes the 60-second window from its own topic", () => {
    const { events } = normalizeOne({
      topic: "crypto_prices_twap_sixty",
      type: "update",
      timestamp: 1785178860123,
      payload: {
        symbol: "eth/usd",
        value: 3200.25,
        full_accuracy_value: "3200250000000000000000",
        timestamp: 1785178860000,
        window_s: 60,
      },
    });
    expect(events[0]?.payload).toMatchObject({
      symbol: "eth/usd",
      value: "3200.25",
      windowSeconds: 60,
      windowStartAt: "2026-07-27T19:00:00.000Z",
      windowEndAt: "2026-07-27T19:01:00.000Z",
    });
  });
});

describe("the floating `value` is never read", () => {
  it("ignores a display value that disagrees with the exact one", () => {
    const { events } = normalizeOne({
      ...THIRTY_UPDATE,
      payload: { ...THIRTY_UPDATE.payload, value: 1 },
    });
    expect(events[0]?.payload.value).toBe("65000.5");
  });

  it("normalizes an update whose display value is absent or a string", () => {
    for (const display of [undefined, "65000.5", null]) {
      const { events, problems } = normalizeOne({
        ...THIRTY_UPDATE,
        payload: { ...THIRTY_UPDATE.payload, value: display },
      });
      expect(problems).toEqual([]);
      expect(events[0]?.payload.value).toBe("65000.5");
    }
  });

  it("refuses an update carrying only the display value", () => {
    const { symbol, timestamp, window_s } = THIRTY_UPDATE.payload;
    const { events, problems } = normalizeOne({
      ...THIRTY_UPDATE,
      payload: { symbol, timestamp, window_s, value: 65000.5 },
    });
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("RTDS_INVALID_TWAP_PAYLOAD");
    expect(problems[0]?.raw).toBeDefined();
  });
});

describe("every refusal is typed, carries the raw value, and drops nothing", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["RTDS_INVALID_ENVELOPE", { topic: 7, type: "update", payload: {} }],
    ["RTDS_UNKNOWN_TOPIC", { topic: "comments", type: "update", payload: {} }],
    [
      "RTDS_UNKNOWN_MESSAGE_TYPE",
      { ...THIRTY_UPDATE, type: "snapshot" },
    ],
    [
      "RTDS_INVALID_TWAP_PAYLOAD",
      { ...THIRTY_UPDATE, payload: { ...THIRTY_UPDATE.payload, window_s: "30" } },
    ],
    [
      "RTDS_INVALID_SYMBOL",
      { ...THIRTY_UPDATE, payload: { ...THIRTY_UPDATE.payload, symbol: "" } },
    ],
    [
      "RTDS_WINDOW_TOPIC_MISMATCH",
      { ...THIRTY_UPDATE, payload: { ...THIRTY_UPDATE.payload, window_s: 60 } },
    ],
    [
      "RTDS_INVALID_TWAP_VALUE",
      {
        ...THIRTY_UPDATE,
        payload: { ...THIRTY_UPDATE.payload, full_accuracy_value: "65000.5" },
      },
    ],
    [
      "RTDS_NEGATIVE_TWAP_VALUE",
      {
        ...THIRTY_UPDATE,
        payload: {
          ...THIRTY_UPDATE.payload,
          full_accuracy_value: "-65000500000000000000000",
        },
      },
    ],
    [
      "RTDS_INVALID_OBSERVATION_TIMESTAMP",
      { ...THIRTY_UPDATE, payload: { ...THIRTY_UPDATE.payload, timestamp: "yesterday" } },
    ],
  ];

  for (const [code, value] of cases) {
    it(`reports ${code} instead of publishing or dropping`, () => {
      const { events, problems } = normalizeOne(value);
      expect(events).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.code).toBe(code);
      expect(problems[0]?.raw).toBe(value);
      expect(problems[0]?.detail.length).toBeGreaterThan(0);
    });
  }

  it("classifies by topic and type before demanding a payload", () => {
    // A payload-less frame on a known topic is refused for its payload, not as
    // a malformed envelope: the more specific classification is the useful one.
    const { events, problems } = normalizeOne({
      topic: "crypto_prices_twap_thirty",
      type: "update",
    });
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("RTDS_INVALID_TWAP_PAYLOAD");
    // And a payload-less frame on an unknown topic is reported by its topic.
    expect(normalizeOne({ topic: "comments", type: "update" }).problems[0]?.code).toBe(
      "RTDS_UNKNOWN_TOPIC",
    );
  });

  it("refuses a modelled topic this feed never subscribed to", () => {
    const { events, problems } = normalizeOne(THIRTY_UPDATE, {
      subscribedTopics: new Set(["crypto_prices_twap_sixty"]),
    });
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("RTDS_TOPIC_NOT_SUBSCRIBED");
  });

  it("bounds an unknown topic before putting it in a problem", () => {
    const { problems } = normalizeOne({
      topic: "x".repeat(5000),
      type: "update",
      payload: {},
    });
    expect(problems[0]?.code).toBe("RTDS_UNKNOWN_TOPIC");
    expect((problems[0]?.topic ?? "").length).toBeLessThanOrEqual(64);
    expect(problems[0]?.sourceChannel).toBe("rtds:crypto-twap-ws");
  });

  it("bounds an over-long symbol before putting it in a problem", () => {
    const { problems } = normalizeOne({
      ...THIRTY_UPDATE,
      payload: { ...THIRTY_UPDATE.payload, symbol: "s".repeat(5000) },
    });
    expect(problems[0]?.code).toBe("RTDS_INVALID_SYMBOL");
    expect((problems[0]?.symbol ?? "").length).toBeLessThanOrEqual(64);
  });

  it("accounts for every envelope in a batched frame, in order", () => {
    const context_ = context();
    const { events, problems } = normalizeRtdsFrame(
      [THIRTY_UPDATE, { topic: "comments", type: "update" }, THIRTY_UPDATE],
      context_,
    );
    // Three envelopes in: one event, one unknown topic, one duplicate.
    expect(events).toHaveLength(1);
    expect(problems.map((problem) => problem.code)).toEqual([
      "RTDS_UNKNOWN_TOPIC",
      "RTDS_DUPLICATE_OBSERVATION",
    ]);
    expect(events[0]?.provenance.observedIndex).toBe(0);
    expect(problems.map((problem) => problem.observedIndex)).toEqual([1, 2]);
  });
});

describe("the observation timestamp is read strictly, the publisher's is not", () => {
  it("refuses every encoding the direct-RTDS payload is not documented to use", () => {
    // Round-1 review finding M1. The frozen report §10.3 writes this field as
    // `timestamp (unix ms)` and the page's example prints `1785178800000`; the
    // generic SDK "epoch-like" reading (seconds heuristic, calendar date, any
    // date-time string) belongs to a different surface and previously let
    // arbitrary strings set `windowEndAt`.
    for (const timestamp of [
      "2026-07-27T19:00:00Z",
      "2026-07-27",
      "2026-07-27T19:00:00.000Z",
      1785178800000.5,
      "+1785178800000",
      " 1785178800000",
      "1785178800000.0",
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const value = { ...THIRTY_UPDATE, payload: { ...THIRTY_UPDATE.payload, timestamp } };
      const { events, problems } = normalizeOne(value);
      expect(events).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.code).toBe("RTDS_INVALID_OBSERVATION_TIMESTAMP");
      // The evidence rides on the problem: the raw envelope, unmodified.
      expect(problems[0]?.raw).toBe(value);
    }
  });

  it("still classifies a non-string non-number by the payload shape", () => {
    // Classification order is unchanged: SHAPE is judged by the zod schema and
    // MEANING by `./values.ts`, so a boolean where an instant belongs is a
    // payload-shape refusal, not a timestamp one. Either way it is one typed
    // problem carrying the raw frame, and never an event.
    const value = {
      ...THIRTY_UPDATE,
      payload: { ...THIRTY_UPDATE.payload, timestamp: true },
    };
    const { events, problems } = normalizeOne(value);
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("RTDS_INVALID_TWAP_PAYLOAD");
    expect(problems[0]?.raw).toBe(value);
  });

  it("reads a small epoch value literally instead of rescaling it into plausibility", () => {
    // A seconds-scaled timestamp used to be multiplied by 1000 and published as
    // a confidently wrong 2026 window. It is now read as the milliseconds the
    // venue documents, which lands in 1970 — visibly wrong, flagged
    // `outOfOrder` against real data, and caught by any freshness threshold —
    // rather than silently inventing a plausible instant.
    const { events, problems } = normalizeOne({
      ...THIRTY_UPDATE,
      payload: { ...THIRTY_UPDATE.payload, timestamp: 1785178800 },
    });
    expect(problems).toEqual([]);
    expect(events[0]?.payload.windowEndAt).toBe("1970-01-21T15:52:58.800Z");
    expect(events[0]?.payload.windowStartAt).toBe("1970-01-21T15:52:28.800Z");
  });

  it("accepts the all-digit millisecond spelling as the same instant", () => {
    const { events, problems } = normalizeOne({
      ...THIRTY_UPDATE,
      payload: { ...THIRTY_UPDATE.payload, timestamp: "1785178800000" },
    });
    expect(problems).toEqual([]);
    expect(events[0]?.payload.windowEndAt).toBe("2026-07-27T19:00:00.000Z");
  });

  it("keeps the publisher timestamp tolerant, which is the point of the split", () => {
    // The same string that is refused as an observation time is accepted as
    // publisher provenance, because nothing is computed from it.
    const { events, problems } = normalizeOne({
      ...THIRTY_UPDATE,
      timestamp: "2026-07-27T19:00:00.123Z",
    });
    expect(problems).toEqual([]);
    expect(events[0]?.provenance.venueTimestamp).toBe("2026-07-27T19:00:00.123Z");
  });
});

describe("the publisher timestamp is a decoration, not a gate", () => {
  it("publishes without a venueTimestamp when the envelope carries none", () => {
    // The page's own Python type is `timestamp: datetime | None`.
    for (const timestamp of [undefined, null]) {
      const { events, problems, invalidPublisherTimestamps } = normalizeOne({
        ...THIRTY_UPDATE,
        timestamp,
      });
      expect(problems).toEqual([]);
      expect(events[0]?.provenance.venueTimestamp).toBeUndefined();
      expect(invalidPublisherTimestamps).toBe(0);
    }
  });

  it("counts an unusable publisher timestamp rather than losing the observation", () => {
    const { events, problems, invalidPublisherTimestamps } = normalizeOne({
      ...THIRTY_UPDATE,
      timestamp: "not a date",
    });
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.provenance.venueTimestamp).toBeUndefined();
    expect(invalidPublisherTimestamps).toBe(1);
  });
});

describe("series identity is reserved only after publication", () => {
  it("does not let a refused update suppress a corrected restatement", () => {
    const shared = context();
    const broken = {
      ...THIRTY_UPDATE,
      payload: { ...THIRTY_UPDATE.payload, full_accuracy_value: "not a number" },
    };
    expect(normalizeRtdsFrame([broken], shared).problems[0]?.code).toBe(
      "RTDS_INVALID_TWAP_VALUE",
    );
    // The corrected copy of the SAME instant must still be publishable.
    const { events, problems } = normalizeRtdsFrame([THIRTY_UPDATE], shared);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("refuses a second copy of a published observation", () => {
    const shared = context();
    normalizeRtdsFrame([THIRTY_UPDATE], shared);
    const { events, problems } = normalizeRtdsFrame([THIRTY_UPDATE], shared);
    expect(events).toEqual([]);
    expect(problems[0]?.code).toBe("RTDS_DUPLICATE_OBSERVATION");
  });

  it("reports a same-instant contradiction under its own code", () => {
    const shared = context();
    normalizeRtdsFrame([THIRTY_UPDATE], shared);
    const { problems } = normalizeRtdsFrame(
      [
        {
          ...THIRTY_UPDATE,
          payload: {
            ...THIRTY_UPDATE.payload,
            full_accuracy_value: "65000600000000000000000",
          },
        },
      ],
      shared,
    );
    expect(problems[0]?.code).toBe("RTDS_CONFLICTING_OBSERVATION");
    expect(problems[0]?.detail).toContain("65000.6");
  });
});

describe("first-update quality after a subscription change", () => {
  it("marks the first observation of a new generation and measures what it missed", () => {
    const tracker = new TwapObservationTracker({ duplicateWindow: 8, maxTrackedSeries: 8 });
    normalizeRtdsFrame([THIRTY_UPDATE], context({ tracker }));
    const later = {
      ...THIRTY_UPDATE,
      timestamp: 1785179100123,
      payload: { ...THIRTY_UPDATE.payload, timestamp: 1785179100000 },
    };
    const { events } = normalizeRtdsFrame(
      [later],
      context({ tracker, subscriptionGeneration: 2, receivedEpochMs: 1785179100200 }),
    );
    expect(events[0]?.quality).toMatchObject({
      firstObservationEver: false,
      firstObservationOnSubscription: true,
      unobservedInterval: {
        fromAt: "2026-07-27T19:00:00.000Z",
        toAt: "2026-07-27T19:05:00.000Z",
        durationMs: 300_000,
        reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
        previousSubscriptionGeneration: 1,
      },
    });
    expect(events[0]?.quality.unobservedIntervalUnavailable).toBeUndefined();
  });

  it("states the gap even when the first observation of the new generation regressed", () => {
    // Round-1 review finding M2, end to end: the break is real, it just cannot
    // be measured from an observation older than the last pre-break one.
    const tracker = new TwapObservationTracker({ duplicateWindow: 8, maxTrackedSeries: 8 });
    normalizeRtdsFrame(
      [
        {
          ...THIRTY_UPDATE,
          timestamp: 1785179100123,
          payload: { ...THIRTY_UPDATE.payload, timestamp: 1785179100000 },
        },
      ],
      context({ tracker, receivedEpochMs: 1785179100200 }),
    );
    const regressed = normalizeRtdsFrame(
      [THIRTY_UPDATE],
      context({ tracker, subscriptionGeneration: 2 }),
    );
    expect(regressed.problems).toEqual([]);
    expect(regressed.events[0]?.quality).toMatchObject({
      firstObservationOnSubscription: true,
      outOfOrder: true,
      unobservedIntervalUnavailable: {
        fromAt: "2026-07-27T19:05:00.000Z",
        reasonCode: "RTDS_NO_OBSERVATION_NEWER_THAN_GAP",
        previousSubscriptionGeneration: 1,
      },
    });
    expect(regressed.events[0]?.quality.unobservedInterval).toBeUndefined();

    // And the obligation is still outstanding: the next observation newer than
    // the pre-break one measures it.
    const measured = normalizeRtdsFrame(
      [
        {
          ...THIRTY_UPDATE,
          timestamp: 1785179400123,
          payload: { ...THIRTY_UPDATE.payload, timestamp: 1785179400000 },
        },
      ],
      context({ tracker, subscriptionGeneration: 2, receivedEpochMs: 1785179400200 }),
    );
    expect(measured.events[0]?.quality.unobservedInterval).toEqual({
      fromAt: "2026-07-27T19:05:00.000Z",
      toAt: "2026-07-27T19:10:00.000Z",
      durationMs: 300_000,
      reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
      previousSubscriptionGeneration: 1,
    });
    // Still no count of anything: the interval is measured, the updates inside
    // it are unknown.
    expect(JSON.stringify(measured.events[0]?.quality)).not.toMatch(/missed|skipped/iu);
  });
});
