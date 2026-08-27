/**
 * Acceptance 3: "Lag beyond retention returns a hard resync condition."
 *
 * ADR-003 §3.3: "Trader lag beyond configured retention is a hard
 * resynchronization event, not silent catch-up from an incomplete stream. The
 * consumer must detect that its checkpoint has fallen outside retention and
 * raise a resync condition; it must not resume from the oldest surviving entry
 * as though nothing were missing."
 *
 * "Not silent catch-up" is the part that needs a test with teeth: it is not
 * enough that a condition is *reported* once. Delivery must stay blocked until
 * the caller states that it applied an authoritative snapshot (§7.1).
 */

import { EventBusResyncRequiredError, EventBusStateError } from "@polymarket-bot/event-bus";
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

/** Publishes 3 events, consumes and checkpoints 2, then overruns retention. */
async function overrunRetention(label: string): Promise<{
  readonly transport: Awaited<ReturnType<typeof connectTransport>>;
  readonly stream: string;
}> {
  const transport = await connectTransport({ maxEvents: 5 });
  const stream = testStream(label);
  await publishAll(transport, stream, createTestEnvelopeSequence({ count: 3 }));

  const first = await transport.subscribe(resumeStored(stream, "trader"));
  const batch = await first.receive({ maxEvents: 2 });
  if (batch.status !== "events") {
    throw new Error(`expected events, received ${batch.status}`);
  }
  const second = batch.events[1];
  if (second === undefined) {
    throw new Error("expected two events");
  }
  await first.checkpoint(second.checkpoint);
  await first.close();

  // 20 more events with retention of 5 leaves ordinals 19..23 alive; the
  // consumer's position is ordinal 2, so 16 events are gone.
  await publishAll(
    transport,
    stream,
    createTestEnvelopeSequence({ count: 20, startIngestSeq: 1_000n }),
  );

  return { transport, stream };
}

describe("lag beyond retention", () => {
  it("returns a hard resync condition instead of the surviving events", async () => {
    const { transport, stream } = await overrunRetention("resync-detect");

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const result = await subscription.receive();

    expect(result.status).toBe("resync-required");
    if (result.status !== "resync-required") {
      throw new Error("expected a resync condition");
    }
    expect(result.condition.reason).toBe("retention-exceeded");
    expect(result.condition.missedEventCount).toBe(16);
    expect(result.condition.requiresAuthoritativeSnapshot).toBe(true);
    expect(result.condition.stream).toBe(stream);
    expect(result.condition.consumerId).toBe("trader");
    expect(Date.parse(result.condition.detectedAt)).not.toBeNaN();
  });

  it("detects the condition at subscribe time, before any event arrives", async () => {
    const { transport, stream } = await overrunRetention("resync-at-subscribe");

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));

    expect(subscription.pendingResync()?.reason).toBe("retention-exceeded");
    const metrics = await subscription.metrics();
    expect(metrics.resyncPending).toBe(true);
    expect(metrics.deliveredTotal).toBe(0);
  });

  it("keeps refusing to deliver until an authoritative snapshot is acknowledged", async () => {
    const { transport, stream } = await overrunRetention("resync-sticky");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await subscription.receive();
      expect(result.status).toBe("resync-required");
    }

    const metrics = await subscription.metrics();
    expect(metrics.deliveredTotal).toBe(0);
    expect(metrics.hardResyncTotal).toBe(1);
    expect(metrics.missedEventsTotal).toBe(16);
  });

  it("refuses to checkpoint past the gap", async () => {
    const { transport, stream } = await overrunRetention("resync-no-checkpoint");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const last = subscription.lastCheckpoint();
    if (last === undefined) {
      throw new Error("expected the stored checkpoint to be known");
    }

    const error = await captureRejection(async () => subscription.checkpoint(last));

    expect(error).toBeInstanceOf(EventBusResyncRequiredError);
  });

  it("resumes at the oldest retained event once a snapshot is acknowledged", async () => {
    const { transport, stream } = await overrunRetention("resync-acknowledge");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    expect((await subscription.receive()).status).toBe("resync-required");

    await subscription.acknowledgeHardResync({
      authoritativeSnapshotApplied: true,
      resumeFrom: "oldest-retained",
      incidentRef: "dq-incident-1",
    });
    const { envelopes } = await drain(subscription);

    expect(subscription.pendingResync()).toBeUndefined();
    expect(envelopes).toHaveLength(5);
    expect(envelopes.map((e) => e.ingestSeq)).toStrictEqual([
      "1015",
      "1016",
      "1017",
      "1018",
      "1019",
    ]);
  });

  it("can be acknowledged with a deliberate skip to the newest event", async () => {
    const { transport, stream } = await overrunRetention("resync-skip");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));

    await subscription.acknowledgeHardResync({
      authoritativeSnapshotApplied: true,
      resumeFrom: "newest",
    });
    const beforeMore = await subscription.receive();
    const later = createTestEnvelopeSequence({ count: 2, startIngestSeq: 9_000n });
    await publishAll(transport, stream, later);
    const { envelopes } = await drain(subscription);

    expect(beforeMore.status).toBe("idle");
    expect(envelopes.map((e) => e.eventId)).toStrictEqual(later.map((e) => e.eventId));
  });

  it("records the acknowledged position durably, so the gap is not replayed", async () => {
    const { transport, stream } = await overrunRetention("resync-durable");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    await subscription.acknowledgeHardResync({
      authoritativeSnapshotApplied: true,
      resumeFrom: "oldest-retained",
    });
    await subscription.close();

    const restarted = await transport.subscribe(resumeStored(stream, "trader"));

    expect(restarted.pendingResync()).toBeUndefined();
    const { envelopes } = await drain(restarted);
    expect(envelopes).toHaveLength(5);
  });

  it("cannot be acknowledged before a condition exists", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("resync-premature-ack");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 2 }));
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));

    const error = await captureRejection(async () =>
      subscription.acknowledgeHardResync({
        authoritativeSnapshotApplied: true,
        resumeFrom: "oldest-retained",
      }),
    );

    expect(error).toBeInstanceOf(EventBusStateError);
  });

  it("cannot be cleared without an applied authoritative snapshot", async () => {
    const { transport, stream } = await overrunRetention("resync-no-snapshot");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));

    const error = await captureRejection(async () =>
      subscription.acknowledgeHardResync({
        // A caller that only wants the events flowing again, reaching past the
        // type. §7.1 makes the snapshot unconditional, so this must fail.
        authoritativeSnapshotApplied: false as unknown as true,
        resumeFrom: "oldest-retained",
      }),
    );

    expect(error).toBeInstanceOf(EventBusStateError);
    expect(subscription.pendingResync()).toBeDefined();
  });

  it("raises the condition mid-stream when retention overtakes a stalled consumer", async () => {
    const transport = await connectTransport({ maxEvents: 4 });
    const stream = testStream("resync-mid-stream");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 4 }));

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const opening = await subscription.receive({ maxEvents: 2 });
    expect(opening.status).toBe("events");
    // The consumer stalls; the gateway keeps publishing and retention passes it.
    await publishAll(
      transport,
      stream,
      createTestEnvelopeSequence({ count: 12, startIngestSeq: 2_000n }),
    );
    const result = await subscription.receive();

    expect(result.status).toBe("resync-required");
    if (result.status !== "resync-required") {
      throw new Error("expected a resync condition");
    }
    expect(result.condition.missedEventCount).toBe(10);
  });

  it("never lets 'nothing to read' and 'what you had not read is gone' look alike", async () => {
    const transport = await connectTransport({ maxEvents: 3 });
    const streamA = testStream("resync-empty-a");
    const streamB = testStream("resync-empty-b");
    await publishAll(transport, streamA, createTestEnvelopeSequence({ count: 3 }));
    await publishAll(transport, streamB, createTestEnvelopeSequence({ count: 1 }));

    // Two subscriptions to two different streams: one caught up, one that
    // retention passed. Both find no event waiting at their own position, and
    // the pair is the point — the two must not report the same thing.
    const caughtUp = await transport.subscribe(resumeStored(streamB, "trader"));
    await drain(caughtUp);
    const behind = await transport.subscribe(resumeStored(streamA, "trader"));
    const opening = await behind.receive({ maxEvents: 1 });
    if (opening.status !== "events") {
      throw new Error(`expected events, received ${opening.status}`);
    }
    const firstEvent = opening.events[0];
    if (firstEvent === undefined) {
      throw new Error("expected one event");
    }
    await behind.checkpoint(firstEvent.checkpoint);
    await publishAll(
      transport,
      streamA,
      createTestEnvelopeSequence({ count: 6, startIngestSeq: 3_000n }),
    );

    expect((await caughtUp.receive()).status).toBe("idle");
    expect((await behind.receive()).status).toBe("resync-required");
  });
});
