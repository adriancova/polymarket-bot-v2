/**
 * Acceptance 1: "Ordered events remain ordered per gateway epoch."
 *
 * ADR-003 §2 states the obligation in two halves, and both are tested here: the
 * transport must not reorder within an epoch, and it must not merge two epochs
 * into one apparent sequence.
 */

import { createTestEnvelope, createTestEnvelopeSequence } from "@polymarket-bot/event-bus/testing";
import { EventBusOrderingError } from "@polymarket-bot/event-bus";
import type { EventEnvelope } from "@polymarket-bot/domain";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { captureRejection, connectTransport, drain, publishAll, testStream } from "./context.js";

function ingestSeqsOf(envelopes: readonly EventEnvelope<unknown>[], epoch: string): string[] {
  return envelopes.filter((e) => e.gatewayEpoch === epoch).map((e) => e.ingestSeq);
}

describe("per-epoch ordering", () => {
  it("delivers one epoch in exactly the published order", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("ordering-single-epoch");
    const published = createTestEnvelopeSequence({ count: 50 });

    await publishAll(transport, stream, published);
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const { envelopes } = await drain(subscription);

    expect(envelopes.map((e) => e.eventId)).toStrictEqual(published.map((e) => e.eventId));
    expect(envelopes.map((e) => e.ingestSeq)).toStrictEqual(published.map((e) => e.ingestSeq));
  });

  it("keeps two interleaved epochs as two ordered sequences, not one", async () => {
    const transport = await connectTransport({ maxEvents: 1_000 });
    const stream = testStream("ordering-interleaved");
    const epochA = randomUUID();
    const epochB = randomUUID();
    const a = createTestEnvelopeSequence({ count: 12, gatewayEpoch: epochA, label: "a" });
    // The second epoch restarts its ingestSeq from 1, exactly as a restarted
    // gateway does. Anything that merged the two into one sequence would have
    // to reorder or renumber to keep it monotonic.
    const b = createTestEnvelopeSequence({ count: 12, gatewayEpoch: epochB, label: "b" });

    const interleaved: EventEnvelope<unknown>[] = [];
    for (let index = 0; index < 12; index += 1) {
      const fromA = a[index];
      const fromB = b[index];
      if (fromA === undefined || fromB === undefined) {
        throw new Error("fixture is incomplete");
      }
      interleaved.push(fromA, fromB);
    }

    await publishAll(transport, stream, interleaved);
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const { envelopes } = await drain(subscription);

    // Publication order is preserved verbatim…
    expect(envelopes.map((e) => e.eventId)).toStrictEqual(interleaved.map((e) => e.eventId));
    // …and each epoch's own subsequence is intact and strictly increasing.
    expect(ingestSeqsOf(envelopes, epochA)).toStrictEqual(ingestSeqsOf(interleaved, epochA));
    expect(ingestSeqsOf(envelopes, epochB)).toStrictEqual(ingestSeqsOf(interleaved, epochB));
    expect(ingestSeqsOf(envelopes, epochA)).toStrictEqual(ingestSeqsOf(envelopes, epochB));

    const metrics = await subscription.metrics();
    expect(metrics.nonMonotonicDeliveries).toBe(0);
    expect(metrics.deliveredTotal).toBe(24);
  });

  it("orders ingestSeq values that JavaScript numbers cannot tell apart", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("ordering-bigint");
    const epoch = randomUUID();
    // Every one of these collapses onto the same `Number`, so a transport that
    // compared them as numbers would either reorder them or refuse them.
    const seqs = [9007199254740992n, 9007199254740993n, 9007199254740994n, 9007199254740995n];
    const published = seqs.map((ingestSeq) =>
      createTestEnvelope({ gatewayEpoch: epoch, ingestSeq }),
    );

    await publishAll(transport, stream, published);
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const { envelopes } = await drain(subscription);

    expect(envelopes.map((e) => e.ingestSeq)).toStrictEqual(seqs.map((seq) => seq.toString()));
    for (let index = 1; index < envelopes.length; index += 1) {
      const previous = envelopes[index - 1];
      const current = envelopes[index];
      if (previous === undefined || current === undefined) {
        throw new Error("delivery is incomplete");
      }
      expect(BigInt(current.ingestSeq) > BigInt(previous.ingestSeq)).toBe(true);
    }
  });

  it("refuses an ingestSeq that does not advance within its epoch", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("ordering-refusal");
    const epoch = randomUUID();

    await transport.publish(stream, createTestEnvelope({ gatewayEpoch: epoch, ingestSeq: 5n }));

    for (const ingestSeq of [5n, 4n, 0n]) {
      const error = await captureRejection(async () =>
        transport.publish(stream, createTestEnvelope({ gatewayEpoch: epoch, ingestSeq })),
      );
      expect(error).toBeInstanceOf(EventBusOrderingError);
    }

    // The refusals are not silent drops: nothing entered the stream, and the
    // caller still holds every refused envelope.
    const metrics = await transport.streamMetrics(stream);
    expect(metrics.currentDepth).toBe(1);
    expect(metrics.publishedTotal).toBe(1);
    expect(metrics.publishFailures).toBe(3);
  });

  it("lets a different epoch restart its ingestSeq without a refusal", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("ordering-new-epoch");

    await transport.publish(
      stream,
      createTestEnvelope({ gatewayEpoch: randomUUID(), ingestSeq: 900n }),
    );
    const receipt = await transport.publish(
      stream,
      createTestEnvelope({ gatewayEpoch: randomUUID(), ingestSeq: 1n }),
    );

    expect(receipt.sequence).toBe(2);
  });

  it("refuses the out-of-order one of two overlapping publishes rather than reordering", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("ordering-concurrent-reverse");
    const epoch = randomUUID();
    const two = createTestEnvelope({ gatewayEpoch: epoch, ingestSeq: 2n });
    const one = createTestEnvelope({ gatewayEpoch: epoch, ingestSeq: 1n });

    // Neither call is awaited before the other is made, so both would read the
    // same ordering cursor if the check and the append were not one step. The
    // publisher must not be able to put `1` after `2` in the stream and call
    // both a success: the epoch's order would then be the producer's
    // concurrency rather than its intent (ADR-003 §2).
    const outcomes = await Promise.allSettled([
      transport.publish(stream, two),
      transport.publish(stream, one),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toStrictEqual(["fulfilled", "rejected"]);
    const refusal = outcomes[1];
    if (refusal?.status !== "rejected") {
      throw new Error("expected the second publish to be refused");
    }
    expect(refusal.reason).toBeInstanceOf(EventBusOrderingError);

    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const { envelopes } = await drain(subscription);
    // The refused event never entered the stream, so there is no anomaly for a
    // consumer to count after the fact.
    expect(envelopes.map((e) => e.ingestSeq)).toStrictEqual(["2"]);
    expect((await subscription.metrics()).nonMonotonicDeliveries).toBe(0);
    expect((await transport.streamMetrics(stream)).publishFailures).toBe(1);
  });

  it("keeps overlapping publishes of one epoch in the order they were submitted", async () => {
    const transport = await connectTransport({ maxEvents: 200 });
    const stream = testStream("ordering-concurrent-burst");
    const published = createTestEnvelopeSequence({ count: 40 });

    // Submitted in order, none awaited: the transport, not the caller, is what
    // keeps them in order once they are in flight together.
    const receipts = await Promise.all(
      published.map(async (envelope) => await transport.publish(stream, envelope)),
    );

    expect(receipts.map((receipt) => receipt.sequence)).toStrictEqual(
      published.map((_, index) => index + 1),
    );
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const { envelopes } = await drain(subscription);
    expect(envelopes.map((e) => e.eventId)).toStrictEqual(published.map((e) => e.eventId));
    expect((await subscription.metrics()).nonMonotonicDeliveries).toBe(0);
  });

  it("does not make one epoch wait behind another", async () => {
    const transport = await connectTransport({ maxEvents: 200 });
    const stream = testStream("ordering-concurrent-epochs");
    const a = createTestEnvelopeSequence({ count: 15, label: "a" });
    const b = createTestEnvelopeSequence({ count: 15, label: "b" });

    // Two epochs are two sequences (ADR-003 §2), so they are serialized
    // separately: each one's own order survives, and the interleaving between
    // them is not something either epoch's consumer can depend on.
    await Promise.all([
      ...a.map(async (envelope) => await transport.publish(stream, envelope)),
      ...b.map(async (envelope) => await transport.publish(stream, envelope)),
    ]);

    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const { envelopes } = await drain(subscription);
    expect(envelopes).toHaveLength(30);
    const epochA = a[0]?.gatewayEpoch ?? "";
    const epochB = b[0]?.gatewayEpoch ?? "";
    expect(ingestSeqsOf(envelopes, epochA)).toStrictEqual(ingestSeqsOf(a, epochA));
    expect(ingestSeqsOf(envelopes, epochB)).toStrictEqual(ingestSeqsOf(b, epochB));
    expect((await subscription.metrics()).nonMonotonicDeliveries).toBe(0);
  });

  it("accepts a retry of a publish that failed, with the same ingestSeq", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("ordering-retry");
    const epoch = randomUUID();
    const envelope = createTestEnvelope({ gatewayEpoch: epoch, ingestSeq: 7n });

    // A refusal must not move the ordering cursor, or a producer retrying an
    // event that never landed would be locked out of publishing it.
    await captureRejection(async () =>
      transport.publish(stream, { ...envelope, payload: { amount: 1n } }),
    );
    const receipt = await transport.publish(stream, envelope);

    expect(receipt.sequence).toBe(1);
  });
});
