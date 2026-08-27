/**
 * Acceptance 2: "Reconnect resumes from checkpoint within retention."
 *
 * ADR-003 §3.4: "Consumer checkpoints are explicit, so a trader restart resumes
 * from a known position within retention rather than from 'now'." The tests
 * below assert both halves — that it resumes where it left off, and that it
 * does *not* resume from the end.
 */

import { EventBusCheckpointError, EventBusResyncRequiredError } from "@polymarket-bot/event-bus";
import { createTestEnvelopeSequence } from "@polymarket-bot/event-bus/testing";
import { describe, expect, it } from "vitest";

import {
  captureRejection,
  connectTransport,
  drain,
  publishAll,
  resumeStored,
  testStream,
} from "./context.js";

describe("consumer checkpoints", () => {
  it("resumes a restarted consumer from its checkpoint, not from now", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-stored");
    const published = createTestEnvelopeSequence({ count: 10 });
    await publishAll(transport, stream, published);

    const first = await transport.subscribe(resumeStored(stream, "trader"));
    const batch = await first.receive({ maxEvents: 4 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const fourth = batch.events[3];
    if (fourth === undefined) {
      throw new Error("expected four events");
    }
    await first.checkpoint(fourth.checkpoint);
    await first.close();

    // Everything published before the restart is still in the stream, so a
    // consumer resuming "from now" would silently skip events 5..10.
    const resumed = await transport.subscribe(resumeStored(stream, "trader"));
    const { envelopes } = await drain(resumed);

    expect(envelopes.map((e) => e.eventId)).toStrictEqual(
      published.slice(4).map((e) => e.eventId),
    );
    expect(resumed.pendingResync()).toBeUndefined();
  });

  it("resumes across a whole new transport instance, because the position is durable", async () => {
    const stream = testStream("resume-across-transport");
    const published = createTestEnvelopeSequence({ count: 6 });

    const producer = await connectTransport({ maxEvents: 1_000 });
    await publishAll(producer, stream, published);
    const before = await producer.subscribe(resumeStored(stream, "trader"));
    const opening = await before.receive({ maxEvents: 2 });
    if (opening.status !== "events") {
      throw new Error(`expected events, received ${opening.status}`);
    }
    const second = opening.events[1];
    if (second === undefined) {
      throw new Error("expected two events");
    }
    await before.checkpoint(second.checkpoint);
    await producer.close();

    const restarted = await connectTransport({ maxEvents: 1_000 });
    const after = await restarted.subscribe(resumeStored(stream, "trader"));
    const { envelopes } = await drain(after);

    expect(envelopes.map((e) => e.eventId)).toStrictEqual(
      published.slice(2).map((e) => e.eventId),
    );
  });

  it("resumes from a checkpoint the caller persisted itself", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-explicit");
    const published = createTestEnvelopeSequence({ count: 8 });
    await publishAll(transport, stream, published);

    const first = await transport.subscribe({ stream, consumerId: "trader" });
    const batch = await first.receive({ maxEvents: 3 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const third = batch.events[2];
    if (third === undefined) {
      throw new Error("expected three events");
    }
    // The token survives a JSON round trip, which is what "persist it beside
    // your own state" means in practice.
    const persisted = JSON.parse(JSON.stringify(third.checkpoint)) as typeof third.checkpoint;
    await first.close();

    const resumed = await transport.subscribe({
      stream,
      consumerId: "trader",
      start: { at: "checkpoint", checkpoint: persisted },
    });
    const { envelopes } = await drain(resumed);

    expect(envelopes.map((e) => e.eventId)).toStrictEqual(
      published.slice(3).map((e) => e.eventId),
    );
  });

  it("offers a first-ever consumer no implicit start", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-first-start");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 4 }));

    const error = await captureRejection(async () =>
      transport.subscribe({
        stream,
        consumerId: "trader",
        start: { at: "stored-checkpoint", whenMissing: "fail" },
      }),
    );

    expect(error).toBeInstanceOf(EventBusCheckpointError);
  });

  it("starts a first-ever consumer at the oldest retained event by default", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-default-start");
    const published = createTestEnvelopeSequence({ count: 4 });
    await publishAll(transport, stream, published);

    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const { envelopes } = await drain(subscription);

    expect(envelopes.map((e) => e.eventId)).toStrictEqual(published.map((e) => e.eventId));
  });

  it("skips history only when a caller says so explicitly", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-newest");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 4 }));

    const subscription = await transport.subscribe({
      stream,
      consumerId: "trader",
      start: { at: "newest" },
    });
    const idle = await subscription.receive();
    const later = createTestEnvelopeSequence({ count: 2, startIngestSeq: 100n });
    await publishAll(transport, stream, later);
    const { envelopes } = await drain(subscription);

    expect(idle.status).toBe("idle");
    expect(envelopes.map((e) => e.eventId)).toStrictEqual(later.map((e) => e.eventId));
  });

  it("records the checkpoint durably as soon as it is taken", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-durable");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 5 }));

    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const batch = await subscription.receive({ maxEvents: 5 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const second = batch.events[1];
    if (second === undefined) {
      throw new Error("expected five events");
    }
    await subscription.checkpoint(second.checkpoint);

    expect(subscription.lastCheckpoint()).toStrictEqual(second.checkpoint);
    const queue = await transport.streamMetrics(stream);
    expect(queue.consumerLag).toStrictEqual([{ consumerId: "trader", lag: 3 }]);
  });

  it("refuses a checkpoint that would move backwards", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-backwards");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 4 }));

    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const batch = await subscription.receive({ maxEvents: 4 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const [first, , third] = batch.events;
    if (first === undefined || third === undefined) {
      throw new Error("expected four events");
    }
    await subscription.checkpoint(third.checkpoint);

    const error = await captureRejection(async () => subscription.checkpoint(first.checkpoint));

    expect(error).toBeInstanceOf(EventBusCheckpointError);
    expect(subscription.lastCheckpoint()).toStrictEqual(third.checkpoint);
  });

  it("refuses a checkpoint for an event it never delivered", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-undelivered");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 6 }));

    const reader = await transport.subscribe({ stream, consumerId: "reader" });
    const all = await reader.receive({ maxEvents: 6 });
    if (all.status !== "events") {
      throw new Error(`expected events, received ${all.status}`);
    }
    const last = all.events[5];
    if (last === undefined) {
      throw new Error("expected six events");
    }

    const lagging = await transport.subscribe({ stream, consumerId: "lagging" });
    await lagging.receive({ maxEvents: 1 });
    const error = await captureRejection(async () => lagging.checkpoint(last.checkpoint));

    expect(error).toBeInstanceOf(EventBusCheckpointError);
  });

  it("refuses a checkpoint minted for another stream", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const streamA = testStream("resume-other-a");
    const streamB = testStream("resume-other-b");
    await publishAll(transport, streamA, createTestEnvelopeSequence({ count: 2 }));
    await publishAll(transport, streamB, createTestEnvelopeSequence({ count: 2 }));

    const onA = await transport.subscribe({ stream: streamA, consumerId: "trader" });
    const onB = await transport.subscribe({ stream: streamB, consumerId: "trader" });
    const fromA = await onA.receive({ maxEvents: 1 });
    if (fromA.status !== "events") {
      throw new Error(`expected events, received ${fromA.status}`);
    }
    const borrowed = fromA.events[0];
    if (borrowed === undefined) {
      throw new Error("expected one event");
    }
    await onB.receive({ maxEvents: 1 });

    const error = await captureRejection(async () => onB.checkpoint(borrowed.checkpoint));

    expect(error).toBeInstanceOf(EventBusCheckpointError);
  });

  it("does not raise a resync for an ordinary restart inside retention", async () => {
    const transport = await connectTransport({ maxEvents: 50 });
    const stream = testStream("resume-within-retention");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 20 }));

    const first = await transport.subscribe(resumeStored(stream, "trader"));
    const batch = await first.receive({ maxEvents: 5 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const fifth = batch.events[4];
    if (fifth === undefined) {
      throw new Error("expected five events");
    }
    await first.checkpoint(fifth.checkpoint);
    await first.close();

    await publishAll(
      transport,
      stream,
      createTestEnvelopeSequence({ count: 20, startIngestSeq: 1_000n }),
    );
    const resumed = await transport.subscribe(resumeStored(stream, "trader"));
    const { envelopes } = await drain(resumed);

    expect(resumed.pendingResync()).toBeUndefined();
    expect(envelopes).toHaveLength(35);
    const metrics = await resumed.metrics();
    expect(metrics.hardResyncTotal).toBe(0);
    expect(metrics.missedEventsTotal).toBe(0);
  });

  it("keeps two consumers of one stream independent", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("resume-two-consumers");
    const published = createTestEnvelopeSequence({ count: 6 });
    await publishAll(transport, stream, published);

    const fast = await transport.subscribe(resumeStored(stream, "fast"));
    const slow = await transport.subscribe(resumeStored(stream, "slow"));
    const fastBatch = await fast.receive({ maxEvents: 6 });
    const slowBatch = await slow.receive({ maxEvents: 2 });
    if (fastBatch.status !== "events" || slowBatch.status !== "events") {
      throw new Error("expected events on both subscriptions");
    }
    const fastLast = fastBatch.events[5];
    const slowLast = slowBatch.events[1];
    if (fastLast === undefined || slowLast === undefined) {
      throw new Error("expected the requested batches");
    }
    await fast.checkpoint(fastLast.checkpoint);
    await slow.checkpoint(slowLast.checkpoint);

    const queue = await transport.streamMetrics(stream);

    expect(queue.consumerLag).toStrictEqual([
      { consumerId: "fast", lag: 0 },
      { consumerId: "slow", lag: 4 },
    ]);
    // Both saw the same events in the same order.
    expect(fastBatch.events.slice(0, 2).map((e) => e.envelope.eventId)).toStrictEqual(
      slowBatch.events.map((e) => e.envelope.eventId),
    );
  });

  it("refuses to checkpoint while a resync is pending", async () => {
    const transport = await connectTransport({ maxEvents: 2 });
    const stream = testStream("resume-blocked-by-resync");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 2 }));

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const batch = await subscription.receive({ maxEvents: 1 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const first = batch.events[0];
    if (first === undefined) {
      throw new Error("expected one event");
    }
    await subscription.checkpoint(first.checkpoint);
    await publishAll(
      transport,
      stream,
      createTestEnvelopeSequence({ count: 10, startIngestSeq: 500n }),
    );
    const blocked = await subscription.receive();

    expect(blocked.status).toBe("resync-required");
    const error = await captureRejection(async () => subscription.checkpoint(first.checkpoint));
    expect(error).toBeInstanceOf(EventBusResyncRequiredError);
  });
});
