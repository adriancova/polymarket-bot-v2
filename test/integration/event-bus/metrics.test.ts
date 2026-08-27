/**
 * The §8.3 metric set, measured against a real bounded stream.
 *
 * §8.3: "Every queue is bounded and exposes: current depth, maximum depth,
 * oldest message age, messages dropped, producer blocked time, consumer lag."
 * Each of the six is asserted against a state the test arranged, so a metric
 * that merely exists but never moves would fail.
 */

import type { StreamQueueMetrics } from "@polymarket-bot/event-bus";
import {
  createTestEnvelope,
  createTestEnvelopeSequence,
  pauseServerWrites,
  resumeServerWrites,
} from "@polymarket-bot/event-bus/testing";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, inject, it } from "vitest";

import { connectTransport, drain, publishAll, resumeStored, testStream } from "./context.js";

/** A metric set without the one field that legitimately advances between reads. */
function withoutAge(metrics: StreamQueueMetrics): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...metrics };
  delete copy["oldestMessageAgeMs"];
  return copy;
}

describe("queue metrics", () => {
  it("reports depth against the configured bound", async () => {
    const transport = await connectTransport({ maxEvents: 6 });
    const stream = testStream("metrics-depth");

    const empty = await transport.streamMetrics(stream);
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 4 }));
    const partial = await transport.streamMetrics(stream);
    await publishAll(
      transport,
      stream,
      createTestEnvelopeSequence({ count: 10, startIngestSeq: 500n }),
    );
    const full = await transport.streamMetrics(stream);

    expect(empty.currentDepth).toBe(0);
    expect(empty.maximumDepth).toBe(6);
    expect(partial.currentDepth).toBe(4);
    expect(full.currentDepth).toBe(6);
    expect(full.maximumDepth).toBe(6);
    expect(full.publishedTotal).toBe(14);
  });

  it("counts what retention removed, and says so out loud to the consumer", async () => {
    const transport = await connectTransport({ maxEvents: 3 });
    const stream = testStream("metrics-dropped");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 1 }));

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const opening = await subscription.receive({ maxEvents: 1 });
    if (opening.status !== "events") {
      throw new Error(`expected events, received ${opening.status}`);
    }
    const first = opening.events[0];
    if (first === undefined) {
      throw new Error("expected one event");
    }
    await subscription.checkpoint(first.checkpoint);
    await publishAll(
      transport,
      stream,
      createTestEnvelopeSequence({ count: 9, startIngestSeq: 700n }),
    );

    const metrics = await transport.streamMetrics(stream);

    expect(metrics.messagesDropped).toBe(7);
    // The drop is a bounded-retention fact, not a silent one: the consumer that
    // had not read those events is told.
    expect((await subscription.receive()).status).toBe("resync-required");
  });

  it("reports the age of the oldest retained event against the server clock", async () => {
    const transport = await connectTransport({ maxEvents: 10 });
    const stream = testStream("metrics-age");

    expect((await transport.streamMetrics(stream)).oldestMessageAgeMs).toBe(0);
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 2 }));
    await delay(120);
    const aged = await transport.streamMetrics(stream);

    expect(aged.oldestMessageAgeMs).toBeGreaterThanOrEqual(100);
    expect(aged.oldestMessageAgeMs).toBeLessThan(60_000);
  });

  it("accumulates the time producers spent inside publish", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("metrics-blocked");

    expect((await transport.streamMetrics(stream)).producerBlockedTimeMs).toBe(0);
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 5 }));
    const after = await transport.streamMetrics(stream);
    await publishAll(
      transport,
      stream,
      createTestEnvelopeSequence({ count: 5, startIngestSeq: 100n }),
    );
    const later = await transport.streamMetrics(stream);

    expect(after.producerBlockedTimeMs).toBeGreaterThan(0);
    expect(later.producerBlockedTimeMs).toBeGreaterThan(after.producerBlockedTimeMs);
  });

  it("counts the wait behind a stalled publish, not only the round trip", async () => {
    // Round-2 review, H1: the candidate started the clock when a queued publish
    // *began*, so the four calls below would have reported roughly one stall
    // between them — the transport would look fast while every caller behind
    // the first one waited. §8.3's producer blocked time is the caller's wait.
    const url = inject("redisUrl");
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("metrics-queue-wait");
    const stallMs = 400;
    const envelopes = createTestEnvelopeSequence({ count: 4 });

    await pauseServerWrites({ url, ms: stallMs });
    try {
      const inFlight = envelopes.map(async (envelope) => transport.publish(stream, envelope));
      // Snapshotted at call time, so it describes the stalled moment rather
      // than whatever is true when the server answers.
      const duringStall = transport.streamMetrics(stream);
      await Promise.all(inFlight);
      const stalled = await duringStall;
      const after = await transport.streamMetrics(stream);

      expect(stalled.publishQueueDepth).toBe(4);
      expect(stalled.publishQueueMaxDepth).toBeGreaterThanOrEqual(4);
      expect(stalled.oldestQueuedPublishAgeMs).toBeGreaterThan(0);
      // Every one of the four waited out the stall, so the cumulative wait is a
      // multiple of it; timing only the round trip would report about one.
      expect(after.producerBlockedTimeMs).toBeGreaterThan(2 * stallMs);
      expect(after.publishQueueDepth).toBe(0);
      expect(after.oldestQueuedPublishAgeMs).toBe(0);
      expect(after.publishedTotal).toBe(4);
    } finally {
      await resumeServerWrites(url);
    }
  });

  it("tracks consumer lag per consumer as each one advances", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("metrics-lag");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 10 }));

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const beforeReading = await subscription.metrics();
    const batch = await subscription.receive({ maxEvents: 6 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const afterReading = await subscription.metrics();
    const sixth = batch.events[5];
    if (sixth === undefined) {
      throw new Error("expected six events");
    }
    await subscription.checkpoint(sixth.checkpoint);
    const afterCheckpoint = await subscription.metrics();

    expect(beforeReading.consumerLag).toBe(10);
    expect(afterReading.consumerLag).toBe(4);
    // Delivered but not yet checkpointed is a separate number from lag: the
    // first is what a restart would replay, the second is what is still owed.
    expect(afterReading.uncheckpointedCount).toBe(6);
    expect(afterCheckpoint.uncheckpointedCount).toBe(0);
    expect(afterCheckpoint.queue.consumerLag).toStrictEqual([{ consumerId: "trader", lag: 4 }]);
  });

  it("carries the stream's queue metrics inside every consumer's view", async () => {
    const transport = await connectTransport({ maxEvents: 8 });
    const stream = testStream("metrics-nested");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 3 }));

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const metrics = await subscription.metrics();
    const direct = await transport.streamMetrics(stream);

    // `oldestMessageAgeMs` advances between the two reads by design, so the
    // comparison is over everything that should not have moved.
    expect(withoutAge(metrics.queue)).toStrictEqual(withoutAge(direct));
    expect(Object.keys(metrics.queue)).toEqual(
      expect.arrayContaining([
        "currentDepth",
        "maximumDepth",
        "oldestMessageAgeMs",
        "messagesDropped",
        "producerBlockedTimeMs",
        "consumerLag",
        // The producer queue is a queue too, and §8.3 bounds every queue.
        "publishQueueDepth",
        "publishQueueMaxDepth",
        "oldestQueuedPublishAgeMs",
      ]),
    );
  });

  it("counts deliveries and leaves the anomaly counters at zero on a healthy stream", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("metrics-counters");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 12 }));

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    await drain(subscription);
    const metrics = await subscription.metrics();

    expect(metrics.deliveredTotal).toBe(12);
    expect(metrics.hardResyncTotal).toBe(0);
    expect(metrics.missedEventsTotal).toBe(0);
    expect(metrics.nonMonotonicDeliveries).toBe(0);
    expect(metrics.unreadableEntriesTotal).toBe(0);
    expect(metrics.resyncPending).toBe(false);
    expect(metrics.receiveWaitTimeMs).toBeGreaterThan(0);
  });

  it("reports a repeated ordering identity, which no eventId comparison would catch", async () => {
    // Two publishers, one `gatewayEpoch`: each has its own in-memory cursor, so
    // the second accepts an ordering identity the first already used. ADR-002
    // §2 makes `(gatewayEpoch, ingestSeq)` the identity that matters — the two
    // envelopes below have *different* `eventId`s, so a consumer deduplicating
    // on `eventId` would treat them as two distinct events and act on both.
    const stream = testStream("metrics-duplicate-identity");
    const first = await connectTransport({ maxEvents: 100 });
    const second = await connectTransport({ maxEvents: 100 });
    const epoch = randomUUID();
    const original = createTestEnvelope({ gatewayEpoch: epoch, ingestSeq: 1n });
    const republished = createTestEnvelope({ gatewayEpoch: epoch, ingestSeq: 1n });

    await first.publish(stream, original);
    await second.publish(stream, republished);

    const subscription = await first.subscribe(resumeStored(stream, "trader"));
    const { envelopes } = await drain(subscription);
    const metrics = await subscription.metrics();

    expect(original.eventId).not.toBe(republished.eventId);
    expect(envelopes.map((e) => e.ingestSeq)).toStrictEqual(["1", "1"]);
    // Both are delivered — stopping a trader on a legitimate at-least-once
    // duplicate would be worse — and the repeat is counted rather than hidden.
    expect(metrics.deliveredTotal).toBe(2);
    expect(metrics.nonMonotonicDeliveries).toBe(1);
  });

  it("keeps two streams' metrics apart", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const busy = testStream("metrics-busy");
    const quiet = testStream("metrics-quiet");
    await publishAll(transport, busy, createTestEnvelopeSequence({ count: 7 }));
    await publishAll(transport, quiet, createTestEnvelopeSequence({ count: 1 }));

    expect((await transport.streamMetrics(busy)).currentDepth).toBe(7);
    expect((await transport.streamMetrics(quiet)).currentDepth).toBe(1);
  });
});
