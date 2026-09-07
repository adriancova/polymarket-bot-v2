import { describe, expect, it } from "vitest";

import { decodeEnvelope, encodeEnvelope, validateEnvelope } from "./envelope-codec.js";
import { EventBusEnvelopeError } from "./errors.js";
import { createTestEnvelope } from "./testing/envelopes.js";

/** A copy of an envelope with one required key removed. */
function without(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...createTestEnvelope() };
  delete copy[key];
  return copy;
}

describe("validateEnvelope", () => {
  it("accepts a §7.1 envelope as a fresh frozen own-data record", () => {
    const envelope = createTestEnvelope();

    const result = validateEnvelope(envelope);
    expect(result).toEqual(envelope);
    expect(result).not.toBe(envelope);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(null);
    for (const key of ["eventId", "receivedAt", "gatewayEpoch", "ingestSeq"] as const) {
      expect(result[key]).toBe(envelope[key]);
    }
  });

  it("rejects a non-object", () => {
    for (const value of [null, undefined, 7, "envelope", true]) {
      expect(() => validateEnvelope(value)).toThrow(EventBusEnvelopeError);
    }
  });

  it("rejects an envelope with no payload", () => {
    expect(() => validateEnvelope(without("payload"))).toThrow(/must carry a payload/u);
  });

  it("rejects an unknown top-level key rather than stripping it", () => {
    const envelope = { ...createTestEnvelope(), unexpected: "value" };

    expect(() => validateEnvelope(envelope)).toThrow(EventBusEnvelopeError);
  });

  it("rejects an envelope missing an ordering field", () => {
    expect(() => validateEnvelope(without("gatewayEpoch"))).toThrow(EventBusEnvelopeError);
    expect(() => validateEnvelope(without("ingestSeq"))).toThrow(EventBusEnvelopeError);
  });

  it("rejects an envelope whose payload contradicts the envelope source", () => {
    const envelope = createTestEnvelope({
      source: "polymarket",
      payload: { venue: "binance" },
    });

    expect(() => validateEnvelope(envelope)).toThrow(EventBusEnvelopeError);
  });

  it("does not inspect a payload beyond the reserved provenance key", () => {
    const envelope = createTestEnvelope({
      payload: {
        price: "0.4500",
        size: "not-a-number-at-all",
        nested: { deeply: [1, "2", null, { three: true }] },
      },
    });

    expect(() => validateEnvelope(envelope)).not.toThrow();
  });
});

describe("encodeEnvelope / decodeEnvelope", () => {
  it("round-trips every envelope field unchanged", () => {
    const envelope = createTestEnvelope({
      ingestSeq: 9007199254740993n,
      receivedMonotonicNs: "1758000000123456789",
    });

    const decoded = decodeEnvelope(encodeEnvelope(envelope));

    expect(decoded).toEqual(envelope);
    expect(decoded.ingestSeq).toBe("9007199254740993");
    expect(decoded.receivedMonotonicNs).toBe("1758000000123456789");
  });

  it("carries decimal strings verbatim, never as numbers", () => {
    const payload = {
      price: "0.4500",
      shares: "10.000000",
      notional: "0.000000000000000001",
      zero: "0",
    };

    const decoded = decodeEnvelope(encodeEnvelope(createTestEnvelope({ payload })));

    expect(decoded.payload).toEqual(payload);
    for (const value of Object.values(decoded.payload as Record<string, unknown>)) {
      expect(typeof value).toBe("string");
    }
  });

  it("preserves unicode, empty containers, and null inside a payload", () => {
    const payload = {
      text: "límite · 資産 · \u{1f4c8}",
      emptyObject: {},
      emptyArray: [],
      explicitNull: null,
    };

    expect(decodeEnvelope(encodeEnvelope(createTestEnvelope({ payload }))).payload).toEqual(
      payload,
    );
  });

  it("refuses a payload that cannot be represented as JSON", () => {
    const envelope = createTestEnvelope({ payload: { amount: 1n } });

    expect(() => encodeEnvelope(envelope)).toThrow(EventBusEnvelopeError);
  });

  it("refuses to decode a non-JSON entry", () => {
    expect(() => decodeEnvelope("{not json")).toThrow(/not valid JSON/u);
  });

  it("refuses to decode JSON that is not a §7.1 envelope", () => {
    expect(() => decodeEnvelope(JSON.stringify({ hello: "world" }))).toThrow(
      EventBusEnvelopeError,
    );
  });
});
