/**
 * `RedisStreamsEventTransport.publishBatch` (`THROUGHPUT-1b`) against a real
 * server.
 *
 * The claim under test: a batch is consecutive `publish` calls that stop at
 * the first failure, in ONE round trip — the same door, the same per-epoch
 * ordering check, the same stream entries, the same exact retention — and its
 * result says precisely which envelopes landed. Every failure is either
 * before the script (a refusal: the prefix before it lands, nothing after it
 * is appended) or inside it (all or nothing: the script undoes its own
 * appends), and both are asserted against the server's raw contents, not a
 * length.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import {
  EventBusConfigurationError,
  EventBusEnvelopeError,
  EventBusOrderingError,
  EventBusStateError,
  EventBusUnavailableError,
  RedisStreamsEventTransport,
} from "@polymarket-bot/event-bus";
import type { RetentionPolicy } from "@polymarket-bot/event-bus";
import {
  createCommandDeniedUrl,
  createTestEnvelope,
  createTestEnvelopeSequence,
  readRawStreamEntries,
  readRawStreamState,
  setPublicationCounter,
} from "@polymarket-bot/event-bus/testing";
import type { RawStreamEntry } from "@polymarket-bot/event-bus/testing";
import { afterEach, describe, expect, inject, it } from "vitest";

import { drain, publishAll, resumeStored, testStream } from "./context.js";

const opened: RedisStreamsEventTransport[] = [];

afterEach(async () => {
  for (const transport of opened.splice(0, opened.length)) {
    await transport.close();
  }
});

async function connect(
  retention: RetentionPolicy,
  url: string = inject("redisUrl"),
): Promise<RedisStreamsEventTransport> {
  const transport = await RedisStreamsEventTransport.connect({ connection: { url }, retention });
  opened.push(transport);
  return transport;
}

/** The fields of every entry, in order, WITHOUT the server-assigned ids. */
function fieldsOf(entries: readonly RawStreamEntry[]): readonly (readonly string[])[] {
  return entries.map((entry) => entry.fields);
}

function envelopeFieldsOf(entries: readonly RawStreamEntry[]): readonly string[] {
  return entries.map((entry) => entry.fields[3] ?? "");
}

describe("publishBatch writes what consecutive publishes write", () => {
  it("the same entries, field for field, and contiguous receipts", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 1_000 });
    const envelopes = createTestEnvelopeSequence({ count: 25 });
    const single = testStream("batch-same-single");
    const batched = testStream("batch-same-batched");

    await publishAll(transport, single, envelopes);
    const result = await transport.publishBatch(batched, envelopes);

    expect(result.failure).toBeUndefined();
    expect(result.receipts.map((receipt) => receipt.sequence)).toStrictEqual(
      envelopes.map((_, index) => index + 1),
    );
    expect(result.receipts.every((receipt) => receipt.stream === batched)).toBe(true);
    const singleEntries = await readRawStreamEntries({ url, stream: single });
    const batchedEntries = await readRawStreamEntries({ url, stream: batched });
    expect(batchedEntries).toHaveLength(25);
    // `seq`, its value, `env`, its value — identical bytes; only ids differ.
    expect(fieldsOf(batchedEntries)).toStrictEqual(fieldsOf(singleEntries));
    expect((await readRawStreamState({ url, stream: batched })).published).toBe("25");

    // And a consumer reads them back in order, as published.
    const subscription = await transport.subscribe(resumeStored(batched, "reader"));
    const { envelopes: delivered } = await drain(subscription);
    expect(delivered.map((envelope) => envelope.ingestSeq)).toStrictEqual(
      envelopes.map((envelope) => envelope.ingestSeq),
    );
  });

  it("at the retention bound, trims exactly as single publishes do", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 7 });
    const envelopes = createTestEnvelopeSequence({ count: 23 });
    const single = testStream("batch-trim-single");
    const batched = testStream("batch-trim-batched");

    await publishAll(transport, single, envelopes);
    // Three batches of uneven size, so no batch boundary lines up with the bound.
    for (const [from, to] of [
      [0, 5],
      [5, 16],
      [16, 23],
    ] as const) {
      const result = await transport.publishBatch(batched, envelopes.slice(from, to));
      expect(result.failure).toBeUndefined();
    }

    const singleEntries = await readRawStreamEntries({ url, stream: single });
    const batchedEntries = await readRawStreamEntries({ url, stream: batched });
    expect(batchedEntries).toHaveLength(7);
    expect(fieldsOf(batchedEntries)).toStrictEqual(fieldsOf(singleEntries));
    expect((await readRawStreamState({ url, stream: batched })).published).toBe("23");
    expect((await transport.streamMetrics(batched)).retentionTrimFailures).toBe(0);
  });

  it("a batch and single publishes issued together on one epoch land in issue order", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 100 });
    const stream = testStream("batch-interleave");
    const envelopes = createTestEnvelopeSequence({ count: 6 });
    const [a, b, c, d, e, f] = envelopes as [
      EventEnvelope<unknown>,
      EventEnvelope<unknown>,
      EventEnvelope<unknown>,
      EventEnvelope<unknown>,
      EventEnvelope<unknown>,
      EventEnvelope<unknown>,
    ];
    // Issued without awaiting: the epoch's serialized section orders them.
    const outcomes = await Promise.all([
      transport.publish(stream, a),
      transport.publishBatch(stream, [b, c, d]),
      transport.publish(stream, e),
      transport.publishBatch(stream, [f]),
    ]);
    expect(outcomes[1]).toMatchObject({ failure: undefined });
    expect(outcomes[3]).toMatchObject({ failure: undefined });
    const entries = await readRawStreamEntries({ url, stream });
    expect(entries.map((entry) => entry.fields[1])).toStrictEqual(["1", "2", "3", "4", "5", "6"]);
    expect(envelopeFieldsOf(entries).map((text) => (JSON.parse(text) as { ingestSeq: string }).ingestSeq)).toStrictEqual(
      envelopes.map((envelope) => envelope.ingestSeq),
    );
  });
});

describe("a refusal inside a batch: the prefix lands, nothing after the refused envelope", () => {
  it("an envelope the door refuses ends the run there", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 100 });
    const stream = testStream("batch-door-refusal");
    const envelopes = [...createTestEnvelopeSequence({ count: 5 })];
    const refused = { ...envelopes[2], receivedAt: "not-a-timestamp" } as EventEnvelope<unknown>;
    envelopes[2] = refused;

    const result = await transport.publishBatch(stream, envelopes);

    expect(result.receipts.map((receipt) => receipt.sequence)).toStrictEqual([1, 2]);
    expect(result.failure?.index).toBe(2);
    expect(result.failure?.error).toBeInstanceOf(EventBusEnvelopeError);
    const entries = await readRawStreamEntries({ url, stream });
    // Exactly the prefix: envelopes 3 and 4 (valid) were never appended.
    expect(envelopeFieldsOf(entries).map((text) => (JSON.parse(text) as { eventId: string }).eventId)).toStrictEqual([
      envelopes[0]?.eventId,
      envelopes[1]?.eventId,
    ]);
    expect((await readRawStreamState({ url, stream })).published).toBe("2");
    expect((await transport.streamMetrics(stream)).publishFailures).toBe(1);
  });

  it("a refusal of the FIRST envelope appends nothing and makes no round trip for the rest", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 100 });
    const stream = testStream("batch-door-first");
    const envelopes = [...createTestEnvelopeSequence({ count: 3 })];
    envelopes[0] = { ...envelopes[0], ingestSeq: "not-a-number" } as EventEnvelope<unknown>;

    const result = await transport.publishBatch(stream, envelopes);

    expect(result.receipts).toStrictEqual([]);
    expect(result.failure?.index).toBe(0);
    expect(result.failure?.error).toBeInstanceOf(EventBusEnvelopeError);
    expect(await readRawStreamState({ url, stream })).toStrictEqual({ published: undefined, depth: undefined });
  });

  it("a non-advancing ingestSeq inside the run ends it there", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 100 });
    const stream = testStream("batch-ordering-inside");
    const [one, two, three] = createTestEnvelopeSequence({ count: 3 }) as [
      EventEnvelope<unknown>,
      EventEnvelope<unknown>,
      EventEnvelope<unknown>,
    ];
    const repeat = { ...createTestEnvelope({ gatewayEpoch: two.gatewayEpoch, ingestSeq: two.ingestSeq }) };

    const result = await transport.publishBatch(stream, [one, two, repeat, three]);

    expect(result.receipts).toHaveLength(2);
    expect(result.failure?.index).toBe(2);
    expect(result.failure?.error).toBeInstanceOf(EventBusOrderingError);
    const entries = await readRawStreamEntries({ url, stream });
    expect(entries.map((entry) => entry.fields[1])).toStrictEqual(["1", "2"]);
  });

  it("a run that does not advance past the epoch's cursor is refused at its first envelope", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 100 });
    const stream = testStream("batch-ordering-cursor");
    const envelopes = createTestEnvelopeSequence({ count: 4 });
    await publishAll(transport, stream, envelopes.slice(2));

    const result = await transport.publishBatch(stream, envelopes.slice(0, 2));

    expect(result.receipts).toStrictEqual([]);
    expect(result.failure?.index).toBe(0);
    expect(result.failure?.error).toBeInstanceOf(EventBusOrderingError);
    expect((await readRawStreamState({ url, stream })).published).toBe("2");
  });

  it("an envelope of another epoch ends the run there", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 100 });
    const stream = testStream("batch-mixed-epoch");
    const first = createTestEnvelopeSequence({ count: 2 });
    const other = createTestEnvelopeSequence({ count: 2 });

    const result = await transport.publishBatch(stream, [...first, ...other]);

    expect(result.receipts).toHaveLength(2);
    expect(result.failure?.index).toBe(2);
    expect(result.failure?.error).toBeInstanceOf(EventBusOrderingError);
    expect((await readRawStreamState({ url, stream })).depth).toBe(2);
  });
});

describe("a failure inside the script: all or nothing", () => {
  it("the counter write fails after every append: the run is undone; stream and counter exactly as found", async () => {
    const url = inject("redisUrl");
    const stream = testStream("batch-counter-denied");
    const transport = await connect({ maxEvents: 3 });
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 3 }));
    // At the bound: a trim run by mistake before the undo would remove a real entry.
    const before = await readRawStreamEntries({ url, stream });

    const denied = await connect({ maxEvents: 3 }, await createCommandDeniedUrl({ url, deny: ["set"] }));
    const run = createTestEnvelopeSequence({ count: 4 });
    const result = await denied.publishBatch(stream, run);

    expect(result.receipts).toStrictEqual([]);
    expect(result.failure?.index).toBe(0);
    expect(result.failure?.error).toBeInstanceOf(EventBusUnavailableError);
    expect(String((result.failure?.error as EventBusUnavailableError).details["reason"])).toBe(
      "counter-write-failed",
    );
    // Contents, not length.
    expect(await readRawStreamEntries({ url, stream })).toStrictEqual(before);
    expect((await readRawStreamState({ url, stream })).published).toBe("3");
    const subscription = await transport.subscribe(resumeStored(stream, "reader"));
    expect((await drain(subscription)).envelopes).toHaveLength(3);
    expect(subscription.pendingResync()).toBeUndefined();
  });

  it("an append that is refused appends nothing and consumes no ordinal", async () => {
    const url = inject("redisUrl");
    const stream = testStream("batch-xadd-denied");
    const transport = await connect({ maxEvents: 10 });
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 2 }));
    const before = await readRawStreamEntries({ url, stream });

    const denied = await connect({ maxEvents: 10 }, await createCommandDeniedUrl({ url, deny: ["xadd"] }));
    const result = await denied.publishBatch(stream, createTestEnvelopeSequence({ count: 3 }));

    expect(result.receipts).toStrictEqual([]);
    expect(result.failure?.index).toBe(0);
    expect(String((result.failure?.error as EventBusUnavailableError).details["reason"])).toBe("append-failed");
    expect(await readRawStreamEntries({ url, stream })).toStrictEqual(before);
    expect((await readRawStreamState({ url, stream })).published).toBe("2");
  });

  it("the safe-integer ceiling is checked for the WHOLE run before anything is appended", async () => {
    const url = inject("redisUrl");
    const stream = testStream("batch-ceiling");
    const transport = await connect({ maxEvents: 100 });
    await setPublicationCounter({ url, stream, value: "9007199254740989" });

    const tooMany = await transport.publishBatch(stream, createTestEnvelopeSequence({ count: 3 }));
    expect(tooMany.receipts).toStrictEqual([]);
    expect(tooMany.failure?.index).toBe(0);
    expect(tooMany.failure?.error).toBeInstanceOf(EventBusUnavailableError);
    expect((await readRawStreamState({ url, stream })).published).toBe("9007199254740989");
    expect((await readRawStreamState({ url, stream })).depth).toBeUndefined();

    const fits = await transport.publishBatch(stream, createTestEnvelopeSequence({ count: 2 }));
    expect(fits.failure).toBeUndefined();
    expect(fits.receipts.map((receipt) => receipt.sequence)).toStrictEqual([
      9007199254740990, 9007199254740991,
    ]);
  });

  it("a trim that fails is counted, not reported as a failure: the run IS published", async () => {
    const url = inject("redisUrl");
    const stream = testStream("batch-trim-denied");
    const denied = await connect({ maxEvents: 2 }, await createCommandDeniedUrl({ url, deny: ["xtrim"] }));

    const result = await denied.publishBatch(stream, createTestEnvelopeSequence({ count: 4 }));

    expect(result.failure).toBeUndefined();
    expect(result.receipts).toHaveLength(4);
    expect((await readRawStreamState({ url, stream })).depth).toBe(4);
    expect((await denied.streamMetrics(stream)).retentionTrimFailures).toBe(1);
  });
});

describe("the call's own preconditions", () => {
  it("an empty batch does nothing; an oversized one is refused whole; a closed transport fails at 0", async () => {
    const url = inject("redisUrl");
    const transport = await connect({ maxEvents: 2_000 });
    const stream = testStream("batch-preconditions");

    expect(await transport.publishBatch(stream, [])).toStrictEqual({ receipts: [], failure: undefined });

    const oversized = await transport.publishBatch(stream, createTestEnvelopeSequence({ count: 1_025 }));
    expect(oversized.receipts).toStrictEqual([]);
    expect(oversized.failure?.index).toBe(0);
    expect(oversized.failure?.error).toBeInstanceOf(EventBusConfigurationError);
    expect(await readRawStreamState({ url, stream })).toStrictEqual({ published: undefined, depth: undefined });

    await transport.close();
    const closed = await transport.publishBatch(stream, createTestEnvelopeSequence({ count: 1 }));
    expect(closed.failure?.index).toBe(0);
    expect(closed.failure?.error).toBeInstanceOf(EventBusStateError);
  });
});
