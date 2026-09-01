import { describe, expect, it } from "vitest";

import { completeEnvelope, rawFrameCausationId, type EnvelopeDraft } from "./envelope.js";
import type { GatewayReceipt } from "./ports.js";

const EPOCH = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "01900000-0000-7000-8000-000000000001";

const receipt: GatewayReceipt = {
  receivedAt: "2026-08-30T12:00:00.000Z",
  receivedMonotonicNs: "123456789",
  nowMs: 1_772_400_000_000,
};

const feedStaleDraft: EnvelopeDraft = {
  eventType: "FeedStale",
  schemaVersion: 1,
  source: "binance",
  sourceChannel: "binance:stream-connection",
  connectionId: "binance-a1",
  subscriptionGeneration: 1,
  payload: {
    feedId: "binance-reference",
    connectionId: "binance-a1",
    detectedAt: "2026-08-30T12:00:00.000Z",
    stalenessMs: 45_000,
  },
};

describe("completeEnvelope", () => {
  it("completes a valid draft into an envelope the frozen registry accepts", () => {
    const completed = completeEnvelope(feedStaleDraft, {
      eventId: EVENT_ID,
      gatewayEpoch: EPOCH,
      ingestSeq: "7",
      receipt,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.envelope.eventId).toBe(EVENT_ID);
    expect(completed.envelope.gatewayEpoch).toBe(EPOCH);
    expect(completed.envelope.ingestSeq).toBe("7");
    expect(completed.envelope.receivedAt).toBe(receipt.receivedAt);
    expect(completed.envelope.receivedMonotonicNs).toBe(receipt.receivedMonotonicNs);
    expect(completed.envelope.connectionId).toBe("binance-a1");
    expect(completed.envelope.subscriptionGeneration).toBe(1);
    // Absent optionals stay ABSENT, not undefined-valued (ADR-001 §8.1).
    expect("venueTimestamp" in completed.envelope).toBe(false);
    expect("causationId" in completed.envelope).toBe(false);
  });

  it("carries the raw-frame causation naming the recorded frame's dedup identity", () => {
    const completed = completeEnvelope(feedStaleDraft, {
      eventId: EVENT_ID,
      gatewayEpoch: EPOCH,
      ingestSeq: "8",
      receipt,
      causationId: rawFrameCausationId(EPOCH, "6"),
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.envelope.causationId).toBe(`raw:${EPOCH}:6`);
  });

  // ADR-002 Consequences: rejected envelopes need routing, not swallowing —
  // the typed failure comes back with the draft preserved as evidence.
  it("returns a typed rejection with the draft preserved when the contract refuses", () => {
    const badDraft: EnvelopeDraft = {
      ...feedStaleDraft,
      payload: { feedId: "binance-reference", stalenessMs: -1 },
    };
    const completed = completeEnvelope(badDraft, {
      eventId: EVENT_ID,
      gatewayEpoch: EPOCH,
      ingestSeq: "9",
      receipt,
    });
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.code).toBe("ENVELOPE_CONTRACT_REJECTED");
    expect(completed.draft).toBe(badDraft);
    expect(completed.detail).toContain("FeedStale@1");
  });

  // ADR-002 §5: the envelope source is authoritative; a payload restating a
  // different venue must be unrepresentable, and the gateway must surface the
  // contract's refusal rather than publish the contradiction.
  it("rejects a provenance contradiction between source and payload.venue", () => {
    const contradictoryDraft: EnvelopeDraft = {
      eventType: "ReferenceTradeObserved",
      schemaVersion: 1,
      source: "binance",
      sourceChannel: "btcusdt@trade",
      connectionId: "binance-a1",
      subscriptionGeneration: 1,
      venueTimestamp: "2026-08-30T12:00:00.000Z",
      payload: {
        venue: "coinbase", // contradicts source: "binance"
        symbol: "BTCUSDT",
        venueTradeId: "42",
        price: "50000.1",
        size: "0.5",
        takerSide: "BID",
      },
    };
    const completed = completeEnvelope(contradictoryDraft, {
      eventId: EVENT_ID,
      gatewayEpoch: EPOCH,
      ingestSeq: "10",
      receipt,
    });
    expect(completed.ok).toBe(false);
  });

  it("rejects an unknown (eventType, schemaVersion) pair", () => {
    const completed = completeEnvelope(
      { ...feedStaleDraft, eventType: "NotARealEvent" },
      { eventId: EVENT_ID, gatewayEpoch: EPOCH, ingestSeq: "11", receipt },
    );
    expect(completed.ok).toBe(false);
  });
});
