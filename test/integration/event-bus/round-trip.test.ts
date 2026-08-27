/**
 * Round-trip fidelity.
 *
 * ADR-003 §2: the transport carries normalized envelopes. It is not a
 * normalizer. A payload's economics belong to the producer that built them and
 * the consumer that reads them, so what comes out must be what went in —
 * decimal strings unrounded and unre-spelled, bigint-like fields still strings,
 * and no field quietly added or removed.
 */

import { createTestEnvelope } from "@polymarket-bot/event-bus/testing";
import type { EventEnvelope } from "@polymarket-bot/domain";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { connectTransport, drain, publishAll, testStream } from "./context.js";

async function roundTrip(envelope: EventEnvelope<unknown>): Promise<EventEnvelope<unknown>> {
  const transport = await connectTransport({ maxEvents: 100 });
  const stream = testStream("round-trip");
  await publishAll(transport, stream, [envelope]);
  const subscription = await transport.subscribe({ stream, consumerId: "trader" });
  const { envelopes } = await drain(subscription);
  const delivered = envelopes[0];
  if (delivered === undefined) {
    throw new Error("expected one delivered envelope");
  }
  return delivered;
}

describe("round-trip fidelity", () => {
  it("delivers every envelope field exactly as published", async () => {
    const published: EventEnvelope<unknown> = {
      ...createTestEnvelope(),
      venueTimestamp: "2026-08-27T10:15:30.123Z",
      connectionId: "conn-7",
      subscriptionGeneration: 3,
      rawSegmentId: "segment-0001",
      rawRecordOffset: "18446744073709551615",
      correlationId: "corr-1",
      causationId: "cause-1",
      receivedMonotonicNs: "1758000000123456789",
      ingestSeq: "9007199254740993",
    };

    expect(await roundTrip(published)).toStrictEqual(published);
  });

  it("does not touch decimal strings in the payload", async () => {
    const payload = {
      // Deliberately non-canonical spellings: the transport is not the place
      // where normalization happens, so they must survive unchanged.
      price: "0.4500",
      size: "10.0",
      fee: "0.000000000000000001",
      zero: "0",
      big: "123456789012345678901234567890",
    };

    const delivered = await roundTrip(createTestEnvelope({ payload }));

    expect(delivered.payload).toStrictEqual(payload);
    for (const value of Object.values(delivered.payload as Record<string, unknown>)) {
      expect(typeof value).toBe("string");
    }
  });

  it("keeps bigint-like fields as exact strings", async () => {
    const delivered = await roundTrip(
      createTestEnvelope({
        ingestSeq: 18446744073709551615n,
        receivedMonotonicNs: "18446744073709551615",
      }),
    );

    expect(delivered.ingestSeq).toBe("18446744073709551615");
    expect(delivered.receivedMonotonicNs).toBe("18446744073709551615");
    expect(BigInt(delivered.ingestSeq)).toBe(18446744073709551615n);
  });

  it("carries a nested, opaque payload without interpreting it", async () => {
    const payload = {
      book: {
        bids: [
          { price: "0.4900", size: "100" },
          { price: "0.4800", size: "250.5" },
        ],
        asks: [],
      },
      flags: { negRisk: false, disputed: null },
      note: "límite · 資産 · \u{1f4c8}",
      emptyObject: {},
    };

    expect((await roundTrip(createTestEnvelope({ payload }))).payload).toStrictEqual(payload);
  });

  it("preserves provenance and the epoch identity a consumer orders by", async () => {
    const gatewayEpoch = randomUUID();
    const published = createTestEnvelope({
      gatewayEpoch,
      source: "binance",
      sourceChannel: "trades",
      eventType: "ReferenceTradeObserved",
      payload: { venue: "binance", price: "63000.10" },
    });

    const delivered = await roundTrip(published);

    expect(delivered.gatewayEpoch).toBe(gatewayEpoch);
    expect(delivered.source).toBe("binance");
    expect(delivered.eventType).toBe("ReferenceTradeObserved");
    expect(delivered.payload).toStrictEqual({ venue: "binance", price: "63000.10" });
  });
});
