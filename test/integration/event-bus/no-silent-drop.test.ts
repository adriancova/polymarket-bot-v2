/**
 * §8.3: "Dropping trading or raw market events silently is forbidden."
 *
 * Every way this transport can fail to move an event must be observable. These
 * tests walk each one and assert that it is a typed, inspectable failure — and,
 * where an event was already in the stream, that a caller is given exactly the
 * position it needs to step over the problem deliberately rather than by
 * accident.
 */

import {
  EventBusEntryError,
  EventBusEnvelopeError,
  EventBusPublishQueueFullError,
  EventBusStateError,
  EventBusUnavailableError,
  RedisStreamsEventTransport,
} from "@polymarket-bot/event-bus";
import type { StreamCheckpoint } from "@polymarket-bot/event-bus";
import {
  createCommandDeniedUrl,
  createTestEnvelope,
  createTestEnvelopeSequence,
  injectForeignEntry,
  injectUnreadableEntry,
  occupyKeyWithWrongType,
  pauseServerWrites,
  readRawStreamEntries,
  readRawStreamState,
  removeStreamKeys,
  resumeServerWrites,
  setPublicationCounter,
} from "@polymarket-bot/event-bus/testing";
import { describe, expect, inject, it } from "vitest";

import {
  captureRejection,
  connectTransport,
  drain,
  publishAll,
  resumeStored,
  testStream,
} from "./context.js";

function checkpointFrom(error: unknown): StreamCheckpoint {
  if (!(error instanceof EventBusEntryError)) {
    throw new Error(`expected an entry error, received ${String(error)}`);
  }
  const checkpoint = error.details["checkpoint"];
  if (checkpoint === undefined) {
    throw new Error("the entry error did not name the offending position");
  }
  return checkpoint as StreamCheckpoint;
}

describe("nothing is dropped silently", () => {
  it("refuses an invalid envelope without publishing anything", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-invalid");
    const valid = createTestEnvelope();

    const error = await captureRejection(async () =>
      transport.publish(stream, { ...valid, ingestSeq: "not-a-number" }),
    );

    expect(error).toBeInstanceOf(EventBusEnvelopeError);
    const metrics = await transport.streamMetrics(stream);
    expect(metrics.publishedTotal).toBe(0);
    expect(metrics.currentDepth).toBe(0);
    expect(metrics.publishFailures).toBe(1);
  });

  it("refuses an envelope with an unknown field rather than stripping it", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-unknown-field");

    const error = await captureRejection(async () =>
      transport.publish(stream, {
        ...createTestEnvelope(),
        surprise: "a field a newer producer added",
      } as never),
    );

    expect(error).toBeInstanceOf(EventBusEnvelopeError);
    expect((await transport.streamMetrics(stream)).publishedTotal).toBe(0);
  });

  it("reports an unreadable entry instead of stepping over it", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-unreadable");
    const before = createTestEnvelopeSequence({ count: 3 });
    await publishAll(transport, stream, before);
    await injectUnreadableEntry({ url: inject("redisUrl"), stream });
    const after = createTestEnvelopeSequence({ count: 2, startIngestSeq: 100n });
    await publishAll(transport, stream, after);

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const batch = await subscription.receive({ maxEvents: 10 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    // Everything readable before the bad entry is delivered first, so the
    // report costs no valid event.
    expect(batch.events.map((e) => e.envelope.eventId)).toStrictEqual(
      before.map((e) => e.eventId),
    );

    const error = await captureRejection(async () => subscription.receive());
    expect(error).toBeInstanceOf(EventBusEntryError);
    expect((await subscription.metrics()).unreadableEntriesTotal).toBe(1);

    // The error names the offending entry, so stepping over exactly that one is
    // a deliberate act rather than a side effect.
    const resumed = await transport.subscribe({
      stream,
      consumerId: "trader",
      start: { at: "checkpoint", checkpoint: checkpointFrom(error) },
    });
    const { envelopes } = await drain(resumed);
    expect(envelopes.map((e) => e.eventId)).toStrictEqual(after.map((e) => e.eventId));
  });

  it("reports an entry written by something else instead of ignoring it", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-foreign");
    const before = createTestEnvelopeSequence({ count: 2 });
    await publishAll(transport, stream, before);
    await injectForeignEntry({ url: inject("redisUrl"), stream });
    const after = createTestEnvelopeSequence({ count: 2, startIngestSeq: 100n });
    await publishAll(transport, stream, after);

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const batch = await subscription.receive({ maxEvents: 10 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    expect(batch.events).toHaveLength(2);

    const error = await captureRejection(async () => subscription.receive());
    expect(error).toBeInstanceOf(EventBusEntryError);

    // A foreign entry consumed no publication ordinal, so stepping over it must
    // not make the next real event look like a gap.
    const resumed = await transport.subscribe({
      stream,
      consumerId: "trader",
      start: { at: "checkpoint", checkpoint: checkpointFrom(error) },
    });
    const { envelopes } = await drain(resumed);
    expect(resumed.pendingResync()).toBeUndefined();
    expect(envelopes.map((e) => e.eventId)).toStrictEqual(after.map((e) => e.eventId));
  });

  it("stops publishing when the transport cannot be reached", async () => {
    const error = await captureRejection(async () =>
      RedisStreamsEventTransport.connect({
        // Port 1 is reserved and never listening; this is a local socket
        // failure, not a network call to anything.
        connection: { url: "redis://127.0.0.1:1", connectTimeoutMs: 1_000 },
        retention: { maxEvents: 10 },
      }),
    );

    expect(error).toBeInstanceOf(EventBusUnavailableError);
  });

  it("refuses to publish through a closed transport", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-closed");
    await transport.close();

    const error = await captureRejection(async () =>
      transport.publish(stream, createTestEnvelope()),
    );

    expect(error).toBeInstanceOf(EventBusStateError);
  });

  it("refuses to read through a closed subscription", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-closed-subscription");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 1 }));
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    await subscription.close();

    const error = await captureRejection(async () => subscription.receive());

    expect(error).toBeInstanceOf(EventBusStateError);
  });

  it("closes every subscription with the transport", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-close-cascade");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 1 }));
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));

    await transport.close();

    const error = await captureRejection(async () => subscription.receive());
    expect(error).toBeInstanceOf(EventBusStateError);
  });

  it("refuses two interleaved reads rather than advancing past events neither returned", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-interleaved-reads");
    const published = createTestEnvelopeSequence({ count: 4 });
    await publishAll(transport, stream, published);
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));

    const firstRead = subscription.receive({ waitMs: 200, maxEvents: 4 });
    const secondRead = captureRejection(async () => subscription.receive());
    const [batch, error] = await Promise.all([firstRead, secondRead]);

    expect(error).toBeInstanceOf(EventBusStateError);
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    expect(batch.events.map((e) => e.envelope.eventId)).toStrictEqual(
      published.map((e) => e.eventId),
    );
  });

  it("consumes no publication ordinal for an append that failed", async () => {
    // A script is isolated, not transactional: a counter moved before a failing
    // append would leave an ordinal with no entry behind it, and the next
    // consumer to read across the hole would be told that retention removed an
    // event that was never published — a hard resync and a phantom drop for
    // nothing.
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-burned-ordinal");
    const url = inject("redisUrl");
    await occupyKeyWithWrongType({ url, stream, which: "events" });

    const error = await captureRejection(async () =>
      transport.publish(stream, createTestEnvelope({ ingestSeq: 1n })),
    );
    expect(error).toBeInstanceOf(EventBusUnavailableError);
    expect((await readRawStreamState({ url, stream })).published).toBeUndefined();

    await removeStreamKeys({ url, stream, which: ["events"] });
    const receipt = await transport.publish(stream, createTestEnvelope({ ingestSeq: 2n }));
    expect(receipt.sequence).toBe(1);

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const { envelopes } = await drain(subscription);
    expect(envelopes).toHaveLength(1);
    expect(subscription.pendingResync()).toBeUndefined();
    const metrics = await transport.streamMetrics(stream);
    expect(metrics.messagesDropped).toBe(0);
    expect(metrics.publishedTotal).toBe(1);
  });

  it("refuses at the publication-ordinal ceiling without appending anything", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-ordinal-ceiling");
    const url = inject("redisUrl");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 1 }));
    // `Number.MAX_SAFE_INTEGER`: the next ordinal would be a value this process
    // cannot represent exactly, so the refusal must come before the append and
    // not after it.
    await setPublicationCounter({ url, stream, value: "9007199254740991" });

    const error = await captureRejection(async () =>
      transport.publish(stream, createTestEnvelope({ ingestSeq: 900n })),
    );

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    expect(await readRawStreamState({ url, stream })).toStrictEqual({
      published: "9007199254740991",
      depth: 1,
    });
  });

  it("refuses to publish against a counter it did not write", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-counter-unreadable");
    const url = inject("redisUrl");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 2 }));

    for (const arrange of [
      async () => {
        await setPublicationCounter({ url, stream, value: "not a number" });
      },
      async () => {
        await removeStreamKeys({ url, stream, which: ["published"] });
        await occupyKeyWithWrongType({ url, stream, which: "published" });
      },
    ]) {
      await arrange();
      const error = await captureRejection(async () =>
        transport.publish(stream, createTestEnvelope({ ingestSeq: 900n })),
      );

      expect(error).toBeInstanceOf(EventBusUnavailableError);
      // Nothing was appended for the refused event.
      expect((await readRawStreamState({ url, stream })).depth).toBe(2);
    }
  });

  it("refuses what a stalled transport's bounded queue cannot accept", async () => {
    // Round-2 review, H1: against the unmodified candidate, 200 publishes were
    // all admitted behind one stalled round trip — an unbounded chain of
    // promises holding every unacknowledged event, with no depth, no bound and
    // no waiting time to look at. §8.3 requires the opposite: a bounded queue,
    // and a refusal that halts affected trading when it cannot accept an event.
    const url = inject("redisUrl");
    const transport = await connectTransport(
      { maxEvents: 100 },
      { maxQueuedPublishes: 4 },
    );
    const stream = testStream("drop-queue-saturation");
    const envelopes = createTestEnvelopeSequence({ count: 10 });

    await pauseServerWrites({ url, ms: 500 });
    try {
      const admitted = envelopes
        .slice(0, 4)
        .map(async (envelope) => transport.publish(stream, envelope));
      // Taken while the four above are stalled; the snapshot is read before the
      // metric call's own round trip, so it describes the stalled moment.
      const duringStall = transport.streamMetrics(stream);

      const refusals = await Promise.all(
        envelopes
          .slice(4)
          .map(async (envelope) => captureRejection(async () => transport.publish(stream, envelope))),
      );
      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(EventBusPublishQueueFullError);
        // The halt path is the same one an unreachable transport takes.
        expect(refusal).toBeInstanceOf(EventBusUnavailableError);
      }

      const snapshot = await duringStall;
      expect(snapshot.publishQueueDepth).toBe(4);
      expect(snapshot.publishQueueMaxDepth).toBe(4);
      expect(snapshot.oldestQueuedPublishAgeMs).toBeGreaterThan(0);

      // The admitted four are not lost to the stall: they land, in order.
      await Promise.all(admitted);
      const settled = await transport.streamMetrics(stream);
      expect(settled.publishedTotal).toBe(4);
      expect(settled.publishQueueDepth).toBe(0);
      expect(settled.oldestQueuedPublishAgeMs).toBe(0);
      expect(settled.publishFailures).toBe(6);

      const subscription = await transport.subscribe(resumeStored(stream, "trader"));
      const { envelopes: delivered } = await drain(subscription);
      expect(delivered.map((e) => e.eventId)).toStrictEqual(
        envelopes.slice(0, 4).map((e) => e.eventId),
      );
    } finally {
      await resumeServerWrites(url);
    }
  });

  it("leaves a bounded stream exactly as it found it when the counter write fails", async () => {
    // Round-2 review, M1: the publish appended and trimmed in one command, so a
    // stream at its retention bound lost its oldest entry before the counter
    // write was attempted — and the compensation, which can only delete the
    // entry it just added, could not put that one back. Reproduced against the
    // candidate with a command-specific denial of the counter write: the stream
    // went from three entries to two, and the missing one was a real, unread
    // event.
    const url = inject("redisUrl");
    const stream = testStream("drop-trim-compensation");
    const transport = await connectTransport({ maxEvents: 3 });
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 3 }));
    const before = await readRawStreamEntries({ url, stream });
    expect(before).toHaveLength(3);

    // An account that may do everything the publish needs except write the
    // counter: the append succeeds, the counter write fails, and what the
    // script does next is the whole question.
    const denied = await createCommandDeniedUrl({ url, deny: ["set"] });
    const restricted = await RedisStreamsEventTransport.connect({
      connection: { url: denied },
      retention: { maxEvents: 3 },
    });
    try {
      const error = await captureRejection(async () =>
        restricted.publish(stream, createTestEnvelope({ ingestSeq: 99n })),
      );
      expect(error).toBeInstanceOf(EventBusUnavailableError);
    } finally {
      await restricted.close();
    }

    // Contents, not length: a stream at its bound stays the same length while
    // losing its oldest entry, so only an exact comparison catches the loss.
    expect(await readRawStreamEntries({ url, stream })).toStrictEqual(before);
    expect((await readRawStreamState({ url, stream })).published).toBe("3");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const { envelopes } = await drain(subscription);
    expect(envelopes).toHaveLength(3);
    expect(subscription.pendingResync()).toBeUndefined();
  });

  it("never accepts an event it cannot encode", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("drop-unencodable");

    const error = await captureRejection(async () =>
      transport.publish(stream, createTestEnvelope({ payload: { amount: 10n } })),
    );

    expect(error).toBeInstanceOf(EventBusEnvelopeError);
    expect((await transport.streamMetrics(stream)).publishedTotal).toBe(0);
  });
});
