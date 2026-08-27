/**
 * A checkpoint that parses is not a checkpoint that exists.
 *
 * ADR-003 §3.3 forbids "silent catch-up from an incomplete stream" and §3.4
 * requires a restart to resume "from a known position within retention". Both
 * are defeated by a position the transport merely *believes*: an id in the
 * future, an id that names no entry, an id paired with the wrong ordinal, or a
 * token minted against another server or key namespace all describe a place
 * delivery would happily resume from — and every event between the consumer's
 * real position and that place would be skipped without a word, with no gap for
 * the continuity arithmetic to find because nothing looks missing.
 *
 * So each test here hands the transport a position it cannot vouch for and
 * asserts two things: that it is refused, and that the events it would have
 * skipped are still there to be read by a consumer that asks honestly.
 */

import { EventBusCheckpointError } from "@polymarket-bot/event-bus";
import type { StreamCheckpoint } from "@polymarket-bot/event-bus";
import {
  createTestEnvelope,
  createTestEnvelopeSequence,
  injectEntryWithId,
  readCheckpointPosition,
  removeStreamKeys,
  tamperCheckpoint,
  writeStoredCheckpoint,
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

/** Publishes `count` events and returns the checkpoint of the first one. */
async function firstCheckpoint(
  transport: Awaited<ReturnType<typeof connectTransport>>,
  stream: string,
  count: number,
): Promise<StreamCheckpoint> {
  await publishAll(transport, stream, createTestEnvelopeSequence({ count }));
  const reader = await transport.subscribe({ stream, consumerId: "reader" });
  const batch = await reader.receive({ maxEvents: 1 });
  if (batch.status !== "events") {
    throw new Error(`expected events, received ${batch.status}`);
  }
  const first = batch.events[0];
  if (first === undefined) {
    throw new Error("expected one event");
  }
  await reader.close();
  return first.checkpoint;
}

describe("a checkpoint the stream cannot vouch for", () => {
  it("refuses a position the server's own clock says cannot exist yet", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-future");
    const genuine = await firstCheckpoint(transport, stream, 3);
    // The forgery the round-1 review demonstrated: a far-future position reads
    // nothing, so continuity arithmetic sees no gap and the subscription simply
    // goes idle while three published events sit unread behind it.
    const forged = tamperCheckpoint(genuine, { entryId: "9999999999999-0" });

    const error = await captureRejection(async () =>
      transport.subscribe({
        stream,
        consumerId: "trader",
        start: { at: "checkpoint", checkpoint: forged },
      }),
    );

    expect(error).toBeInstanceOf(EventBusCheckpointError);
    // Nothing was skipped: an honest consumer still finds all three.
    const honest = await transport.subscribe({ stream, consumerId: "honest" });
    const { envelopes } = await drain(honest);
    expect(envelopes).toHaveLength(3);
  });

  it("refuses a position beyond the newest entry the stream holds", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-beyond-newest");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 3 }));
    const reader = await transport.subscribe({ stream, consumerId: "reader" });
    const batch = await reader.receive({ maxEvents: 3 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const last = batch.events[2];
    if (last === undefined) {
      throw new Error("expected three events");
    }
    // The next id after the newest entry, in the same millisecond: not in the
    // future by the server's clock, so nothing but the stream's own contents
    // can refuse it.
    const { entryId } = readCheckpointPosition(last.checkpoint);
    const [millis, counter] = entryId.split("-");
    const forged = tamperCheckpoint(last.checkpoint, {
      entryId: `${String(millis)}-${String(Number(counter) + 1)}`,
    });

    const error = await captureRejection(async () =>
      transport.subscribe({
        stream,
        consumerId: "trader",
        start: { at: "checkpoint", checkpoint: forged },
      }),
    );

    expect(error).toBeInstanceOf(EventBusCheckpointError);
  });

  it("refuses a position whose two halves describe different events", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-ordinal");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 4 }));
    const reader = await transport.subscribe({ stream, consumerId: "reader" });
    const batch = await reader.receive({ maxEvents: 4 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const [first, , third] = batch.events;
    if (first === undefined || third === undefined) {
      throw new Error("expected four events");
    }

    // Same ordinal, another entry's id — and its mirror image, the same id with
    // another ordinal. Either would resume delivery at a position no event ever
    // occupied.
    const movedId = tamperCheckpoint(first.checkpoint, {
      entryId: readCheckpointPosition(third.checkpoint).entryId,
    });
    const movedOrdinal = tamperCheckpoint(third.checkpoint, {
      sequence: readCheckpointPosition(first.checkpoint).sequence,
    });

    for (const forged of [movedId, movedOrdinal]) {
      const error = await captureRejection(async () =>
        transport.subscribe({
          stream,
          consumerId: "trader",
          start: { at: "checkpoint", checkpoint: forged },
        }),
      );
      expect(error).toBeInstanceOf(EventBusCheckpointError);
    }
  });

  it("refuses a position minted in another key namespace on the same server", async () => {
    // Two transports, one server, the same stream name, different namespaces:
    // the ordinals and ids of one are perfectly plausible values in the other.
    const stream = testStream("forge-cross-prefix");
    const elsewhere = await connectTransport({ maxEvents: 100 }, { keyPrefix: "other.ns:events" });
    const here = await connectTransport({ maxEvents: 100 });
    const borrowed = await firstCheckpoint(elsewhere, stream, 3);
    await publishAll(here, stream, createTestEnvelopeSequence({ count: 3 }));

    const error = await captureRejection(async () =>
      here.subscribe({
        stream,
        consumerId: "trader",
        start: { at: "checkpoint", checkpoint: borrowed },
      }),
    );

    expect(error).toBeInstanceOf(EventBusCheckpointError);
    const honest = await here.subscribe({ stream, consumerId: "honest" });
    expect((await drain(honest)).envelopes).toHaveLength(3);
  });

  it("refuses a position from a stream that was destroyed and recreated", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-recreated");
    const genuine = await firstCheckpoint(transport, stream, 3);

    // What a restore from another server's backup, or an operator wiping a
    // namespace, looks like from here: the same name, a different stream.
    await removeStreamKeys({
      url: inject("redisUrl"),
      stream,
      which: ["events", "published", "origin"],
    });
    const rebuilt = await connectTransport({ maxEvents: 100 });
    await publishAll(rebuilt, stream, createTestEnvelopeSequence({ count: 2 }));

    const error = await captureRejection(async () =>
      rebuilt.subscribe({
        stream,
        consumerId: "trader",
        start: { at: "checkpoint", checkpoint: genuine },
      }),
    );

    expect(error).toBeInstanceOf(EventBusCheckpointError);
  });

  it("refuses a stored position that something else wrote", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-stored");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 3 }));
    await writeStoredCheckpoint({
      url: inject("redisUrl"),
      stream,
      consumerId: "trader",
      // The shape the previous token format had: it names no instance at all.
      token: "ebc1:9999999999999-0:1",
    });

    const error = await captureRejection(async () =>
      transport.subscribe({
        stream,
        consumerId: "trader",
        start: { at: "stored-checkpoint", whenMissing: "oldest-retained" },
      }),
    );

    // Refused rather than quietly replaced by a default start: a consumer whose
    // durable position cannot be read must not be given a new one behind an
    // operator's back.
    expect(error).toBeInstanceOf(EventBusCheckpointError);
  });

  it("refuses to store a position the stream does not hold", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-store");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 4 }));
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const batch = await subscription.receive({ maxEvents: 4 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const second = batch.events[1];
    if (second === undefined) {
      throw new Error("expected four events");
    }
    // An id inside the retained range that names no entry: the shape is right,
    // the position is not there.
    const { entryId } = readCheckpointPosition(second.checkpoint);
    const [millis, counter] = entryId.split("-");
    const forged = tamperCheckpoint(second.checkpoint, {
      entryId: `${String(millis)}-${String(Number(counter) + 1)}`,
    });

    const error = await captureRejection(async () => subscription.checkpoint(forged));

    expect(error).toBeInstanceOf(EventBusCheckpointError);
    // The durable position is untouched, so a restart still resumes honestly.
    expect(subscription.lastCheckpoint()).toBeUndefined();
    const metrics = await transport.streamMetrics(stream);
    expect(metrics.consumerLag).toStrictEqual([]);
    expect(metrics.unreadableCheckpoints).toBe(0);
  });

  it("counts a stored position it cannot read instead of dropping the consumer", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-metrics");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 2 }));
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const batch = await subscription.receive({ maxEvents: 1 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const first = batch.events[0];
    if (first === undefined) {
      throw new Error("expected one event");
    }
    await subscription.checkpoint(first.checkpoint);
    expect((await transport.streamMetrics(stream)).consumerLag).toStrictEqual([
      { consumerId: "trader", lag: 1 },
    ]);

    // The instance marker goes; the stored position now belongs to a stream
    // instance that no longer exists.
    await removeStreamKeys({ url: inject("redisUrl"), stream, which: ["origin"] });
    const metrics = await transport.streamMetrics(stream);

    expect(metrics.consumerLag).toStrictEqual([]);
    expect(metrics.unreadableCheckpoints).toBe(1);
  });

  it("counts a stored position the server refuses, instead of reporting lag for it", async () => {
    // Round-2 review, L1: the metric decoded the token and compared its marker,
    // which a position from *this* instance passes even when the position
    // itself names an entry that cannot exist. The candidate reported
    // `lag: 2` and `unreadableCheckpoints: 0` for a stored position `subscribe`
    // refuses outright — a number for a consumer that cannot start.
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-metrics-judged");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 3 }));
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
    expect((await transport.streamMetrics(stream)).consumerLag).toStrictEqual([
      { consumerId: "trader", lag: 2 },
    ]);

    // This stream instance's own marker, an id it will never hold.
    const forged = tamperCheckpoint(first.checkpoint, { entryId: "9999999999999-0" });
    await writeStoredCheckpoint({
      url: inject("redisUrl"),
      stream,
      consumerId: "trader",
      token: forged.token,
    });

    const metrics = await transport.streamMetrics(stream);
    expect(metrics.consumerLag).toStrictEqual([]);
    expect(metrics.unreadableCheckpoints).toBe(1);
    // The metric and the refusal agree, which is the whole point: what the
    // metric calls unusable is exactly what a restart cannot resume from.
    expect(
      await captureRejection(async () => transport.subscribe(resumeStored(stream, "trader"))),
    ).toBeInstanceOf(EventBusCheckpointError);
  });

  it("still resumes a retained entry whose id is ahead of the server's clock", async () => {
    // Round-2 review, L3: the future-clock guard ran before the entry lookup,
    // so a server clock that stepped backwards below a real entry's id turned
    // a genuine, retained, correctly numbered checkpoint into a refusal — and
    // took resumption away for as long as the regression lasted. An entry
    // appended at a future id reproduces that state exactly.
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-clock-regression");
    const genuine = await firstCheckpoint(transport, stream, 2);
    const injected = await injectEntryWithId({
      url: inject("redisUrl"),
      stream,
      entryId: `${String(Date.now() + 600_000)}-0`,
      envelope: createTestEnvelope({ ingestSeq: 5n }),
    });
    const ahead = tamperCheckpoint(genuine, {
      entryId: injected.entryId,
      sequence: injected.sequence,
    });

    const resumed = await transport.subscribe({
      stream,
      consumerId: "trader",
      start: { at: "checkpoint", checkpoint: ahead },
    });

    const accepted = resumed.lastCheckpoint();
    if (accepted === undefined) {
      throw new Error("expected the resumed position to be known");
    }
    expect(readCheckpointPosition(accepted)).toStrictEqual({
      origin: readCheckpointPosition(genuine).origin,
      entryId: injected.entryId,
      sequence: injected.sequence,
    });
    expect((await resumed.receive()).status).toBe("idle");
    // The guard still does its real job: an id in the future that names no
    // entry is refused, so this is not a hole opened by the reordering.
    expect(
      await captureRejection(async () =>
        transport.subscribe({
          stream,
          consumerId: "other",
          start: {
            at: "checkpoint",
            checkpoint: tamperCheckpoint(genuine, { entryId: "9999999999999-0" }),
          },
        }),
      ),
    ).toBeInstanceOf(EventBusCheckpointError);
  });

  it("still resumes a genuine checkpoint, so the guard is not a blanket refusal", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("forge-control");
    const published = createTestEnvelopeSequence({ count: 5 });
    await publishAll(transport, stream, published);
    const reader = await transport.subscribe({ stream, consumerId: "reader" });
    const batch = await reader.receive({ maxEvents: 2 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const second = batch.events[1];
    if (second === undefined) {
      throw new Error("expected two events");
    }

    const resumed = await transport.subscribe({
      stream,
      consumerId: "trader",
      start: { at: "checkpoint", checkpoint: second.checkpoint },
    });
    const { envelopes } = await drain(resumed);

    expect(envelopes.map((e) => e.eventId)).toStrictEqual(
      published.slice(2).map((e) => e.eventId),
    );
  });
});
