import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  DuplicateEventContractError,
  EventValidationError,
  UnknownEventContractError,
} from "./errors.js";
import { defineEventContract } from "./events/event-contract.js";
import { DOMAIN_EVENT_CONTRACTS, DOMAIN_EVENT_TYPES } from "./events/index.js";
import { DOMAIN_EVENT_REGISTRY, createEventSchemaRegistry } from "./registry.js";
import { EVENT_SAMPLES, sampleEnvelope } from "./testing/samples.js";

describe("the frozen domain event registry", () => {
  it("registers every §7.4 event type at version 1", () => {
    expect(DOMAIN_EVENT_REGISTRY.contracts).toHaveLength(DOMAIN_EVENT_CONTRACTS.length);
    for (const eventType of DOMAIN_EVENT_TYPES) {
      expect(DOMAIN_EVENT_REGISTRY.has(eventType, 1)).toBe(true);
      expect(DOMAIN_EVENT_REGISTRY.versionsOf(eventType)).toEqual([1]);
      expect(DOMAIN_EVENT_REGISTRY.latestVersionOf(eventType)).toBe(1);
    }
  });

  it("reports unknown types and versions", () => {
    expect(DOMAIN_EVENT_REGISTRY.has("MarketDiscovered", 2)).toBe(false);
    expect(DOMAIN_EVENT_REGISTRY.has("NotAnEvent", 1)).toBe(false);
    expect(DOMAIN_EVENT_REGISTRY.lookup("NotAnEvent", 1)).toBeUndefined();
    expect(DOMAIN_EVENT_REGISTRY.latestVersionOf("NotAnEvent")).toBeUndefined();
    expect(() => DOMAIN_EVENT_REGISTRY.require("MarketDiscovered", 2)).toThrow(
      UnknownEventContractError,
    );
  });

  it("parses a valid envelope for every registered event", () => {
    for (const sample of EVENT_SAMPLES) {
      const envelope = sampleEnvelope(sample.eventType, 1, sample.payload);
      const parsed = DOMAIN_EVENT_REGISTRY.parseEnvelope(envelope);
      expect(parsed.eventType).toBe(sample.eventType);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.gatewayEpoch).toBe(envelope["gatewayEpoch"]);
      expect(parsed.ingestSeq).toBe(envelope["ingestSeq"]);
    }
  });

  it("rejects an envelope whose payload does not match its declared type", () => {
    const envelope = sampleEnvelope("BookLevelChanged", 1, { nope: true });
    expect(() => DOMAIN_EVENT_REGISTRY.parseEnvelope(envelope)).toThrow(EventValidationError);
  });

  it("rejects an envelope for an unregistered version", () => {
    const envelope = sampleEnvelope("BookLevelChanged", 99, {});
    expect(() => DOMAIN_EVENT_REGISTRY.parseEnvelope(envelope)).toThrow(UnknownEventContractError);
  });

  it("rejects a value that cannot be routed", () => {
    for (const value of [null, undefined, 42, "MarketOpened", {}, { eventType: "MarketOpened" }]) {
      expect(() => DOMAIN_EVENT_REGISTRY.parseEnvelope(value)).toThrow(UnknownEventContractError);
    }
  });

  it("returns structured failures from the non-throwing variant", () => {
    const ok = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(
      sampleEnvelope("MarketOpened", 1, EVENT_SAMPLES[3]?.payload),
    );
    expect(ok.ok).toBe(true);

    const unknown = DOMAIN_EVENT_REGISTRY.safeParseEnvelope({ eventType: "Nope", schemaVersion: 1 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toBeInstanceOf(UnknownEventContractError);
      expect(unknown.error.code).toBe("UNKNOWN_EVENT_CONTRACT");
    }

    const invalid = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(
      sampleEnvelope("MarketOpened", 1, { internalMarketId: "nope" }),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toBeInstanceOf(EventValidationError);
      expect(invalid.error.message).toContain("MarketOpened");
      expect((invalid.error as EventValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it("validates payloads independently of the envelope", () => {
    const sample = EVENT_SAMPLES.find((entry) => entry.eventType === "PublicTradeObserved");
    expect(sample).toBeDefined();
    expect(DOMAIN_EVENT_REGISTRY.parsePayload("PublicTradeObserved", 1, sample?.payload)).toEqual(
      sample?.payload,
    );
    expect(() =>
      DOMAIN_EVENT_REGISTRY.parsePayload("PublicTradeObserved", 1, {
        ...sample?.payload,
        price: 0.53,
      }),
    ).toThrow(EventValidationError);
    expect(() => DOMAIN_EVENT_REGISTRY.parsePayload("Nope", 1, {})).toThrow(
      UnknownEventContractError,
    );
  });
});

describe("registry construction", () => {
  const payloadV1 = z.strictObject({ value: z.string() });
  const payloadV2 = z.strictObject({ value: z.string(), extra: z.string() });

  it("keeps multiple versions of one event type available for replay", () => {
    const registry = createEventSchemaRegistry([
      defineEventContract("SampleEvent", 1, payloadV1),
      defineEventContract("SampleEvent", 2, payloadV2),
    ]);

    expect(registry.versionsOf("SampleEvent")).toEqual([1, 2]);
    expect(registry.latestVersionOf("SampleEvent")).toBe(2);
    expect(registry.eventTypes).toEqual(["SampleEvent"]);

    const v1 = registry.parseEnvelope(sampleEnvelope("SampleEvent", 1, { value: "a" }));
    expect(v1.schemaVersion).toBe(1);
    expect(() =>
      registry.parseEnvelope(sampleEnvelope("SampleEvent", 2, { value: "a" })),
    ).toThrow(EventValidationError);
    const v2 = registry.parseEnvelope(
      sampleEnvelope("SampleEvent", 2, { value: "a", extra: "b" }),
    );
    expect(v2.schemaVersion).toBe(2);
  });

  it("refuses duplicate registrations", () => {
    expect(() =>
      createEventSchemaRegistry([
        defineEventContract("SampleEvent", 1, payloadV1),
        defineEventContract("SampleEvent", 1, payloadV2),
      ]),
    ).toThrow(DuplicateEventContractError);
  });

  it("pins the event type and version on the generated envelope schema", () => {
    const contract = defineEventContract("SampleEvent", 3, payloadV1);
    expect(contract.eventType).toBe("SampleEvent");
    expect(contract.schemaVersion).toBe(3);
    expect(
      contract.envelopeSchema.safeParse(sampleEnvelope("SampleEvent", 3, { value: "a" })).success,
    ).toBe(true);
    expect(
      contract.envelopeSchema.safeParse(sampleEnvelope("OtherEvent", 3, { value: "a" })).success,
    ).toBe(false);
  });
});
