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

import {
  EventBusCheckpointError,
  EventBusResyncRequiredError,
  EventBusStateError,
  EventBusUnavailableError,
  RedisStreamsEventTransport,
} from "@polymarket-bot/event-bus";
import type { EventSubscription } from "@polymarket-bot/event-bus";
import {
  createTestEnvelopeSequence,
  occupyKeyWithWrongType,
  overwriteStreamOrigin,
  startRedisProxy,
} from "@polymarket-bot/event-bus/testing";
import { randomBytes } from "node:crypto";
import { describe, expect, inject, it } from "vitest";

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

/**
 * Asserts the sticky hard-resync state survived a failed acknowledgement.
 *
 * All three checks matter separately: the condition is still readable, the next
 * `receive` still refuses to deliver, and `checkpoint` is still refused. An
 * acknowledgement that failed must leave the subscription exactly as blocked as
 * it found it (ADR-003 §3.3).
 */
async function assertStillBlocked(subscription: EventSubscription): Promise<void> {
  expect(subscription.pendingResync()?.reason).toBe("retention-exceeded");
  expect((await subscription.receive()).status).toBe("resync-required");
  const last = subscription.lastCheckpoint();
  if (last !== undefined) {
    expect(await captureRejection(async () => subscription.checkpoint(last))).toBeInstanceOf(
      EventBusResyncRequiredError,
    );
  }
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

  it("stays blocked when the acknowledged position cannot be recorded", async () => {
    // Round-2 review, H2: the candidate moved the read position, reset the
    // ordering cursor and cleared the sticky state *before* awaiting the
    // durable write. A failure there threw while delivery was already
    // unlocked — the probe saw `pendingResync()` become undefined and the very
    // next `receive` deliver events across the gap.
    const { transport, stream } = await overrunRetention("resync-store-refused");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const before = await subscription.receive();
    expect(before.status).toBe("resync-required");

    // The positions key is occupied by something the durable write cannot be
    // applied to, so recording the acknowledged position fails.
    await occupyKeyWithWrongType({ url: inject("redisUrl"), stream, which: "checkpoints" });

    const error = await captureRejection(async () =>
      subscription.acknowledgeHardResync({
        authoritativeSnapshotApplied: true,
        resumeFrom: "oldest-retained",
      }),
    );

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    await assertStillBlocked(subscription);
  });

  it("stays blocked when the stream instance is re-marked mid-subscription", async () => {
    const { transport, stream } = await overrunRetention("resync-marker-rewritten");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    expect((await subscription.receive()).status).toBe("resync-required");

    // The marker every position of this subscription was minted against is
    // replaced, so the position the acknowledgement would record no longer
    // belongs to this stream instance and the server refuses to store it.
    await overwriteStreamOrigin({
      url: inject("redisUrl"),
      stream,
      origin: randomBytes(16).toString("hex"),
    });

    const error = await captureRejection(async () =>
      subscription.acknowledgeHardResync({
        authoritativeSnapshotApplied: true,
        resumeFrom: "newest",
      }),
    );

    expect(error).toBeInstanceOf(EventBusCheckpointError);
    await assertStillBlocked(subscription);
  });

  it("stays blocked when the transport is unreachable during the acknowledgement", async () => {
    // The same window, reached the way it is actually reached in production:
    // the server goes away between raising the condition and recording the
    // recovery from it.
    const url = inject("redisUrl");
    const stream = testStream("resync-unreachable-ack");
    const direct = await connectTransport({ maxEvents: 3 });
    const proxy = await startRedisProxy(url);
    const through = await RedisStreamsEventTransport.connect({
      connection: { url: proxy.url, maxRetriesPerRequest: 1, connectTimeoutMs: 2_000 },
      retention: { maxEvents: 3 },
    });

    try {
      await publishAll(direct, stream, createTestEnvelopeSequence({ count: 1 }));
      const opening = await through.subscribe(resumeStored(stream, "trader"));
      const first = await opening.receive({ maxEvents: 1 });
      if (first.status !== "events") {
        throw new Error(`expected events, received ${first.status}`);
      }
      const event = first.events[0];
      if (event === undefined) {
        throw new Error("expected one event");
      }
      await opening.checkpoint(event.checkpoint);
      await opening.close();
      await publishAll(
        direct,
        stream,
        createTestEnvelopeSequence({ count: 12, startIngestSeq: 500n }),
      );

      const subscription = await through.subscribe(resumeStored(stream, "trader"));
      expect((await subscription.receive()).status).toBe("resync-required");

      await proxy.close();
      const error = await captureRejection(async () =>
        subscription.acknowledgeHardResync({
          authoritativeSnapshotApplied: true,
          resumeFrom: "oldest-retained",
        }),
      );

      expect(error).toBeInstanceOf(EventBusUnavailableError);
      // The sticky state is answered from memory, so it is still readable with
      // the transport gone — which is the point: nothing about the halt depends
      // on the server that just disappeared.
      await assertStillBlocked(subscription);
    } finally {
      await through.close();
      await proxy.close();
    }
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
