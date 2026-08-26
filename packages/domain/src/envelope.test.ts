import { describe, expect, it } from "vitest";

import {
  EventEnvelopeRoutingSchema,
  UnknownPayloadEventEnvelopeSchema,
  eventEnvelopeSchema,
  pinnedEventEnvelopeSchema,
  type EventEnvelope,
} from "./envelope.js";
import { SAMPLE_ENVELOPE_BASE, SAMPLE_TIMESTAMP, sampleEnvelope } from "./testing/samples.js";
import { z } from "zod";

const payloadSchema = z.strictObject({ value: z.string() });
const schema = eventEnvelopeSchema(payloadSchema);

function validEnvelope(): Record<string, unknown> {
  return sampleEnvelope("BookSnapshot", 1, { value: "ok" });
}

describe("event envelope (handoff §7.1)", () => {
  it("accepts a minimal valid envelope", () => {
    const parsed = schema.parse(validEnvelope());
    expect(parsed.eventType).toBe("BookSnapshot");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.payload).toEqual({ value: "ok" });
  });

  it("accepts every optional field", () => {
    const parsed = schema.parse({
      ...validEnvelope(),
      venueTimestamp: SAMPLE_TIMESTAMP,
      connectionId: "conn-1",
      subscriptionGeneration: 3,
      rawSegmentId: "segment-1",
      rawRecordOffset: "9007199254740993",
      correlationId: "corr-1",
      causationId: "cause-1",
    });
    expect(parsed.subscriptionGeneration).toBe(3);
    expect(parsed.rawRecordOffset).toBe("9007199254740993");
  });

  const requiredFields = [
    "eventId",
    "eventType",
    "schemaVersion",
    "source",
    "sourceChannel",
    "receivedAt",
    "receivedMonotonicNs",
    "gatewayEpoch",
    "ingestSeq",
    "payload",
  ] as const;

  it.each(requiredFields)("rejects an envelope missing %s", (field) => {
    const envelope = validEnvelope();
    delete envelope[field];
    expect(schema.safeParse(envelope).success).toBe(false);
  });

  it("requires gateway epoch and ingest sequence (acceptance criterion 4)", () => {
    for (const field of ["gatewayEpoch", "ingestSeq"] as const) {
      const envelope = validEnvelope();
      delete envelope[field];
      const result = schema.safeParse(envelope);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes(field))).toBe(true);
      }
      const undefinedValue = { ...validEnvelope(), [field]: undefined };
      expect(schema.safeParse(undefinedValue).success).toBe(false);
    }
  });

  it("rejects unknown keys instead of silently stripping them", () => {
    expect(schema.safeParse({ ...validEnvelope(), somethingNew: 1 }).success).toBe(false);
  });

  it("keeps bigint-like fields as canonical unsigned integer strings", () => {
    for (const field of ["receivedMonotonicNs", "ingestSeq"] as const) {
      expect(schema.safeParse({ ...validEnvelope(), [field]: 42 }).success).toBe(false);
      expect(schema.safeParse({ ...validEnvelope(), [field]: 42n }).success).toBe(false);
      expect(schema.safeParse({ ...validEnvelope(), [field]: "-1" }).success).toBe(false);
      expect(schema.safeParse({ ...validEnvelope(), [field]: "007" }).success).toBe(false);
      expect(schema.safeParse({ ...validEnvelope(), [field]: "1.5" }).success).toBe(false);
      expect(schema.safeParse({ ...validEnvelope(), [field]: "" }).success).toBe(false);
    }
  });

  it("requires ISO-8601 timestamps with an offset or Z", () => {
    expect(schema.safeParse({ ...validEnvelope(), receivedAt: "2026-08-26" }).success).toBe(false);
    expect(
      schema.safeParse({ ...validEnvelope(), receivedAt: "2026-08-26 12:00:00Z" }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...validEnvelope(), receivedAt: 1_756_209_600_000 }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ...validEnvelope(), receivedAt: "2026-02-30T00:00:00Z" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...validEnvelope(), receivedAt: "2026-08-26T12:00:00+02:00" }).success,
    ).toBe(true);
  });

  it("requires a UUIDv7 event id and a UUID gateway epoch", () => {
    expect(schema.safeParse({ ...validEnvelope(), eventId: "not-a-uuid" }).success).toBe(false);
    // A valid UUIDv4 is not a valid UUIDv7 event id.
    expect(
      schema.safeParse({
        ...validEnvelope(),
        eventId: "9f1b6b1e-1c4a-4f8e-8b3a-2c5d7e9f0a1b",
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...validEnvelope(), gatewayEpoch: "epoch-1" }).success).toBe(false);
    expect(
      schema.safeParse({
        ...validEnvelope(),
        gatewayEpoch: "9F1B6B1E-1C4A-4F8E-8B3A-2C5D7E9F0A1B",
      }).success,
    ).toBe(false);
  });

  it("restricts source to the §7.1 enumeration", () => {
    for (const source of ["polymarket", "binance", "coinbase", "rtds", "internal"]) {
      expect(schema.safeParse({ ...validEnvelope(), source }).success).toBe(true);
    }
    expect(schema.safeParse({ ...validEnvelope(), source: "kraken" }).success).toBe(false);
  });

  it("validates the payload with the supplied schema", () => {
    expect(schema.safeParse({ ...validEnvelope(), payload: { value: 1 } }).success).toBe(false);
    expect(schema.safeParse({ ...validEnvelope(), payload: {} }).success).toBe(false);
  });

  it("pins event type and schema version when requested", () => {
    const pinned = pinnedEventEnvelopeSchema("BookSnapshot", 1, payloadSchema);
    expect(pinned.safeParse(validEnvelope()).success).toBe(true);
    expect(
      pinned.safeParse({ ...validEnvelope(), eventType: "BookLevelChanged" }).success,
    ).toBe(false);
    expect(pinned.safeParse({ ...validEnvelope(), schemaVersion: 2 }).success).toBe(false);
  });

  it("rejects non-integer and non-positive schema versions", () => {
    expect(schema.safeParse({ ...validEnvelope(), schemaVersion: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...validEnvelope(), schemaVersion: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...validEnvelope(), schemaVersion: "1" }).success).toBe(false);
  });

  it("routes on event type and schema version", () => {
    const routing = EventEnvelopeRoutingSchema.parse(validEnvelope());
    expect(routing).toEqual({ eventType: "BookSnapshot", schemaVersion: 1 });
  });

  it("accepts any payload through the transport-level schema", () => {
    expect(
      UnknownPayloadEventEnvelopeSchema.safeParse(sampleEnvelope("Anything", 7, { any: true }))
        .success,
    ).toBe(true);
  });

  it("statically matches the §7.1 type", () => {
    const envelope: EventEnvelope<{ value: string }> = {
      ...SAMPLE_ENVELOPE_BASE,
      eventType: "BookSnapshot",
      schemaVersion: 1,
      payload: { value: "ok" },
    };
    expect(schema.parse(envelope)).toEqual(envelope);
  });
});
