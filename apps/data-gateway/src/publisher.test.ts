import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "@polymarket-bot/domain";

import { GatewayPublisher } from "./publisher.js";
import type { PublicationHalt } from "./publisher.js";
import { MemoryEventTransport } from "./testing/memory-transport.js";

const EPOCH = "00000000-0000-4000-8000-000000000001";

function envelopeAt(ingestSeq: string): EventEnvelope<unknown> {
  return {
    eventId: "01900000-0000-7000-8000-000000000001",
    eventType: "FeedStale",
    schemaVersion: 1,
    source: "binance",
    sourceChannel: "binance:stream-connection",
    receivedAt: "2026-08-30T12:00:00.000Z",
    receivedMonotonicNs: "1",
    gatewayEpoch: EPOCH,
    ingestSeq,
    payload: {
      feedId: "binance-reference",
      detectedAt: "2026-08-30T12:00:00.000Z",
      stalenessMs: 45_000,
    },
  };
}

describe("GatewayPublisher", () => {
  it("publishes in submission order and reports receipts", async () => {
    const transport = new MemoryEventTransport();
    const publisher = new GatewayPublisher({ transport, stream: "market" });
    const outcomes = await Promise.all([
      publisher.enqueue(envelopeAt("1")),
      publisher.enqueue(envelopeAt("2")),
      publisher.enqueue(envelopeAt("3")),
    ]);
    expect(outcomes.every((outcome) => outcome.published)).toBe(true);
    expect(transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  // Obligation 1: (gatewayEpoch, ingestSeq) is the dedup identity — a repeated
  // identity must not double-publish, and the refusal is observable.
  it("refuses to publish the same (gatewayEpoch, ingestSeq) twice, with a counter", async () => {
    const transport = new MemoryEventTransport();
    const refused: string[] = [];
    const publisher = new GatewayPublisher({
      transport,
      stream: "market",
      onDuplicateRefused: (identity) => {
        refused.push(identity.ingestSeq);
      },
    });
    await publisher.enqueue(envelopeAt("1"));
    await publisher.enqueue(envelopeAt("2"));
    const duplicate = await publisher.enqueue(envelopeAt("2"));
    expect(duplicate.published).toBe(false);
    if (duplicate.published) return;
    expect(duplicate.reason).toBe("duplicate-identity");
    expect(refused).toEqual(["2"]);
    expect(transport.published("market")).toHaveLength(2);
    expect(publisher.metrics().duplicatesRefused).toBe(1);
  });

  // Obligation 6 / acceptance 4 shape: EVENT_BUS_PUBLISH_QUEUE_FULL is a HALT
  // signal, not a drop signal — publication stops loudly.
  it("halts terminally on EVENT_BUS_PUBLISH_QUEUE_FULL with an observable halt", async () => {
    const transport = new MemoryEventTransport();
    const halts: PublicationHalt[] = [];
    const publisher = new GatewayPublisher({
      transport,
      stream: "market",
      onPublicationHalted: (halt) => halts.push(halt),
    });
    await publisher.enqueue(envelopeAt("1"));
    transport.failNextPublishWithQueueFull();
    const failed = await publisher.enqueue(envelopeAt("2"));
    expect(failed.published).toBe(false);
    expect(publisher.halted).toBe(true);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.cause).toBe("EVENT_BUS_PUBLISH_QUEUE_FULL");
    expect(halts[0]?.haltedAtIngestSeq).toBe("2");

    // The halt is terminal for the epoch: later events are suppressed with a
    // counter, never quietly retried into a stream with a silent gap.
    const suppressed = await publisher.enqueue(envelopeAt("3"));
    expect(suppressed.published).toBe(false);
    if (suppressed.published) return;
    expect(suppressed.reason).toBe("publication-halted");
    expect(publisher.metrics().suppressedWhileHalted).toBe(2);
    expect(transport.published("market")).toHaveLength(1);
  });

  it("halts terminally on EVENT_BUS_UNAVAILABLE and never rejects the caller's promise", async () => {
    const transport = new MemoryEventTransport();
    const publisher = new GatewayPublisher({ transport, stream: "market" });
    transport.setUnavailable(true);
    const outcome = await publisher.enqueue(envelopeAt("1"));
    expect(outcome.published).toBe(false);
    if (outcome.published) return;
    expect(outcome.reason).toBe("transport-unavailable");
    expect(publisher.halted).toBe(true);
    expect(publisher.metrics().halt?.cause).toBe("EVENT_BUS_UNAVAILABLE");

    // Restoring the transport does NOT resume publication mid-epoch: events
    // assigned during the outage were never in the stream, and a mid-epoch
    // resume would hand consumers a gap the transport cannot detect.
    transport.setUnavailable(false);
    const after = await publisher.enqueue(envelopeAt("2"));
    expect(after.published).toBe(false);
    expect(transport.published("market")).toHaveLength(0);
  });

  it("counts a non-outage transport rejection without halting", async () => {
    const transport = new MemoryEventTransport();
    const rejections: string[] = [];
    const publisher = new GatewayPublisher({
      transport,
      stream: "market",
      onPublishRejected: (rejection) => rejections.push(rejection.ingestSeq),
    });
    const bad = envelopeAt("1");
    // Sabotage the envelope so the transport's schema validation refuses it.
    const outcome = await publisher.enqueue({ ...bad, receivedAt: "not-a-timestamp" });
    expect(outcome.published).toBe(false);
    if (outcome.published) return;
    expect(outcome.reason).toBe("transport-rejected");
    expect(publisher.halted).toBe(false);
    expect(rejections).toEqual(["1"]);
  });
});
