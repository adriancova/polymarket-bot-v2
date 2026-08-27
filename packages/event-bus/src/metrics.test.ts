import { describe, expect, it } from "vitest";

import { EventBusConfigurationError } from "./errors.js";
import { computeStreamQueueMetrics } from "./metrics.js";

const base = {
  stream: "market",
  publishedTotal: 10,
  currentDepth: 4,
  maximumDepth: 4,
  oldestEntryAtMs: 1_000,
  nowMs: 1_750,
  producerBlockedTimeMs: 12,
  publishFailures: 0,
  publishQueueDepth: 0,
  publishQueueMaxDepth: 1_024,
  oldestQueuedPublishAgeMs: 0,
  retentionTrimFailures: 0,
  consumerLag: [],
  unreadableCheckpoints: 0,
} as const;

describe("computeStreamQueueMetrics", () => {
  it("exposes every §8.3 metric name", () => {
    const metrics = computeStreamQueueMetrics(base);

    expect(Object.keys(metrics)).toEqual(
      expect.arrayContaining([
        "currentDepth",
        "maximumDepth",
        "oldestMessageAgeMs",
        "messagesDropped",
        "producerBlockedTimeMs",
        "consumerLag",
      ]),
    );
  });

  it("exposes the same three names for the bounded producer queue", () => {
    // §8.3 asks for depth, maximum depth, and oldest message age of *every*
    // queue. The producer queue is one, and a bound nobody can see is not a
    // bound anyone can act on (round-2 review, H1).
    const metrics = computeStreamQueueMetrics({
      ...base,
      publishQueueDepth: 7,
      publishQueueMaxDepth: 8,
      oldestQueuedPublishAgeMs: 42.5,
    });

    expect(metrics.publishQueueDepth).toBe(7);
    expect(metrics.publishQueueMaxDepth).toBe(8);
    expect(metrics.oldestQueuedPublishAgeMs).toBe(42.5);
  });

  it("reports a retention bound that could not be applied", () => {
    // The publish landed and its ordinal is consistent, so it is not a failure —
    // but the stream is over its bound until something trims it, and an
    // unreported bound that stopped being applied is not a bound.
    const metrics = computeStreamQueueMetrics({ ...base, retentionTrimFailures: 3 });

    expect(metrics.retentionTrimFailures).toBe(3);
  });

  it("derives messages dropped from what left the stream", () => {
    expect(computeStreamQueueMetrics(base).messagesDropped).toBe(6);
  });

  it("never reports a negative drop count", () => {
    const metrics = computeStreamQueueMetrics({ ...base, publishedTotal: 2, currentDepth: 5 });

    expect(metrics.messagesDropped).toBe(0);
  });

  it("measures the oldest message age against the transport's own clock", () => {
    expect(computeStreamQueueMetrics(base).oldestMessageAgeMs).toBe(750);
  });

  it("reports an age of zero for an empty stream", () => {
    const metrics = computeStreamQueueMetrics({
      ...base,
      currentDepth: 0,
      oldestEntryAtMs: undefined,
    });

    expect(metrics.oldestMessageAgeMs).toBe(0);
  });

  it("clamps an age that a clock adjustment made negative", () => {
    const metrics = computeStreamQueueMetrics({ ...base, oldestEntryAtMs: 2_000 });

    expect(metrics.oldestMessageAgeMs).toBe(0);
  });

  it("carries per-consumer lag through unchanged", () => {
    const consumerLag = [
      { consumerId: "trader", lag: 3 },
      { consumerId: "shadow", lag: 8 },
    ];

    expect(computeStreamQueueMetrics({ ...base, consumerLag }).consumerLag).toStrictEqual(
      consumerLag,
    );
  });

  it("rejects a counter that is not a non-negative safe integer", () => {
    expect(() => computeStreamQueueMetrics({ ...base, currentDepth: -1 })).toThrow(
      EventBusConfigurationError,
    );
    expect(() => computeStreamQueueMetrics({ ...base, publishedTotal: 1.5 })).toThrow(
      EventBusConfigurationError,
    );
    expect(() => computeStreamQueueMetrics({ ...base, unreadableCheckpoints: -1 })).toThrow(
      EventBusConfigurationError,
    );
    expect(() => computeStreamQueueMetrics({ ...base, publishQueueDepth: -1 })).toThrow(
      EventBusConfigurationError,
    );
    expect(() => computeStreamQueueMetrics({ ...base, retentionTrimFailures: 0.5 })).toThrow(
      EventBusConfigurationError,
    );
  });

  it("reports stored positions that could not be read, rather than dropping them", () => {
    // A consumer whose stored position cannot be read must not simply vanish
    // from the metric set: nothing about its lag is known, and silence would
    // read as "no such consumer".
    const metrics = computeStreamQueueMetrics({ ...base, unreadableCheckpoints: 2 });

    expect(metrics.unreadableCheckpoints).toBe(2);
    expect(metrics.consumerLag).toStrictEqual([]);
  });
});
