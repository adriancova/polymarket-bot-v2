/**
 * Reconnection behaviour.
 *
 * The fault injected here is the one that actually happens in production: an
 * established connection is severed while the server keeps running and keeps
 * its data. Restarting the container instead would test rediscovery of a new
 * address, which is the deployment's problem, not the transport's.
 *
 * What must hold across the fault: no event is lost, no event is duplicated,
 * order is preserved, and the durable checkpoint still means what it meant.
 */

import { createTestEnvelopeSequence, killClientConnections } from "@polymarket-bot/event-bus/testing";
import { describe, expect, inject, it } from "vitest";

import { connectTransport, drain, publishAll, resumeStored, testStream } from "./context.js";

describe("reconnection", () => {
  it("keeps publishing after the connection is severed", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("reconnect-publish");
    const before = createTestEnvelopeSequence({ count: 4 });
    await publishAll(transport, stream, before);

    await killClientConnections(inject("redisUrl"));

    const after = createTestEnvelopeSequence({ count: 4, startIngestSeq: 100n });
    await publishAll(transport, stream, after);
    const metrics = await transport.streamMetrics(stream);

    expect(metrics.publishedTotal).toBe(8);
    expect(metrics.currentDepth).toBe(8);
  });

  it("delivers the whole stream in order across a severed connection", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("reconnect-deliver");
    const before = createTestEnvelopeSequence({ count: 5 });
    await publishAll(transport, stream, before);

    const subscription = await transport.subscribe(resumeStored(stream, "trader"));
    const opening = await subscription.receive({ maxEvents: 5 });
    if (opening.status !== "events") {
      throw new Error(`expected events, received ${opening.status}`);
    }
    const fifth = opening.events[4];
    if (fifth === undefined) {
      throw new Error("expected five events");
    }
    await subscription.checkpoint(fifth.checkpoint);

    await killClientConnections(inject("redisUrl"));

    const after = createTestEnvelopeSequence({ count: 5, startIngestSeq: 200n });
    await publishAll(transport, stream, after);
    const { envelopes } = await drain(subscription);

    expect(envelopes.map((e) => e.eventId)).toStrictEqual(after.map((e) => e.eventId));
    const metrics = await subscription.metrics();
    expect(metrics.deliveredTotal).toBe(10);
    expect(metrics.hardResyncTotal).toBe(0);
    expect(metrics.nonMonotonicDeliveries).toBe(0);
  });

  it("resumes a restarted consumer from its checkpoint after a severed connection", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("reconnect-resume");
    const published = createTestEnvelopeSequence({ count: 9 });
    await publishAll(transport, stream, published);

    const first = await transport.subscribe(resumeStored(stream, "trader"));
    const batch = await first.receive({ maxEvents: 3 });
    if (batch.status !== "events") {
      throw new Error(`expected events, received ${batch.status}`);
    }
    const third = batch.events[2];
    if (third === undefined) {
      throw new Error("expected three events");
    }
    await first.checkpoint(third.checkpoint);
    await first.close();

    await killClientConnections(inject("redisUrl"));

    const resumed = await transport.subscribe(resumeStored(stream, "trader"));
    const { envelopes } = await drain(resumed);

    expect(envelopes.map((e) => e.eventId)).toStrictEqual(published.slice(3).map((e) => e.eventId));
  });

  it("survives a fault during a blocking read", async () => {
    const transport = await connectTransport({ maxEvents: 100 });
    const stream = testStream("reconnect-blocking");
    const subscription = await transport.subscribe(resumeStored(stream, "trader"));

    // Three outcomes are legitimate for the interrupted read: it reconnected
    // and delivered, it woke with nothing, or it reported the transport
    // unavailable. What must never happen is a lost event, which is what the
    // drain below actually asserts.
    const reading = subscription
      .receive({ waitMs: 1_500 })
      .catch(() => ({ status: "unavailable" }) as const);
    const disturbed = (async () => {
      await killClientConnections(inject("redisUrl"));
      await publishAll(transport, stream, createTestEnvelopeSequence({ count: 2 }));
    })();

    const [first] = await Promise.all([reading, disturbed]);
    expect(["events", "idle", "unavailable"]).toContain(first.status);

    const alreadyDelivered = first.status === "events" ? first.events.length : 0;
    const { envelopes } = await drain(subscription);

    expect(alreadyDelivered + envelopes.length).toBe(2);
  });
});
