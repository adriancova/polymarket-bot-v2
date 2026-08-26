import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  DuplicateEventContractError,
  EventValidationError,
  InvalidSchemaVersionError,
  UnknownEventContractError,
} from "./errors.js";
import { defineEventContract, type EventContractLike } from "./events/event-contract.js";
import { DOMAIN_EVENT_CONTRACTS, DOMAIN_EVENT_TYPES } from "./events/index.js";
import { DOMAIN_EVENT_REGISTRY, createEventSchemaRegistry } from "./registry.js";
import { EVENT_SAMPLES, envelopeForSample, sampleEnvelope } from "./testing/samples.js";

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
      const envelope = envelopeForSample(sample, 1);
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
    const marketOpened = EVENT_SAMPLES.find((entry) => entry.eventType === "MarketOpened");
    expect(marketOpened).toBeDefined();
    const ok = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(
      sampleEnvelope("MarketOpened", 1, marketOpened?.payload),
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

  const invalidVersions: ReadonlyArray<readonly [string, unknown]> = [
    ["zero", 0],
    ["a negative version", -1],
    ["a fractional version", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a numeric string", "1"],
    ["a bigint", 1n],
    ["null", null],
    ["undefined", undefined],
  ];

  it.each(invalidVersions)("refuses to define a contract at %s", (_description, version) => {
    expect(() =>
      defineEventContract("SampleEvent", version as number, payloadV1),
    ).toThrow(InvalidSchemaVersionError);
  });

  it.each(invalidVersions)("refuses to register a contract at %s", (_description, version) => {
    // `EventContractLike` is structural, so a caller can hand-assemble a
    // contract and bypass `defineEventContract`. The registry must catch it too.
    const smuggled = {
      eventType: "SmuggledEvent",
      schemaVersion: version as number,
      payloadSchema: payloadV1,
      envelopeSchema: payloadV1,
    } satisfies EventContractLike;
    expect(() => createEventSchemaRegistry([smuggled])).toThrow(InvalidSchemaVersionError);
  });

  it("accepts any positive integer version", () => {
    for (const version of [1, 2, 7, 1000]) {
      expect(defineEventContract("SampleEvent", version, payloadV1).schemaVersion).toBe(version);
    }
  });
});

describe("schema evolution under strict unknown-key rejection", () => {
  // Policy (see `schema-version.ts`): every change to the emitted field set is a
  // new version, including an added *optional* field, because every contract
  // rejects unknown keys and `(eventType, schemaVersion)` must identify exactly
  // one historical schema.
  const evolvedV1 = z.strictObject({ marketId: z.string() });
  const evolvedV2 = z.strictObject({ marketId: z.string(), note: z.string().optional() });

  const registry = createEventSchemaRegistry([
    defineEventContract("EvolvedEvent", 1, evolvedV1),
    defineEventContract("EvolvedEvent", 2, evolvedV2),
  ]);

  const v1Document = { marketId: "m-1" };
  const v2Document = { marketId: "m-1", note: "added in v2" };

  it("resolves both versions from the registry", () => {
    expect(registry.has("EvolvedEvent", 1)).toBe(true);
    expect(registry.has("EvolvedEvent", 2)).toBe(true);
    expect(registry.versionsOf("EvolvedEvent")).toEqual([1, 2]);
    expect(registry.latestVersionOf("EvolvedEvent")).toBe(2);
    expect(registry.require("EvolvedEvent", 1).payloadSchema).toBe(evolvedV1);
    expect(registry.require("EvolvedEvent", 2).payloadSchema).toBe(evolvedV2);
  });

  it("rejects a v2 document under the v1 schema", () => {
    // This is the whole reason the policy has no additive-optional exemption:
    // had v2's field been emitted as v1, every v1 consumer would reject it.
    expect(evolvedV1.safeParse(v2Document).success).toBe(false);
    expect(() => registry.parsePayload("EvolvedEvent", 1, v2Document)).toThrow(
      EventValidationError,
    );
    expect(() =>
      registry.parseEnvelope(sampleEnvelope("EvolvedEvent", 1, v2Document)),
    ).toThrow(EventValidationError);
  });

  it("keeps historical v1 documents replayable under v1", () => {
    expect(registry.parsePayload("EvolvedEvent", 1, v1Document)).toEqual(v1Document);
    const parsed = registry.parseEnvelope(sampleEnvelope("EvolvedEvent", 1, v1Document));
    expect(parsed.schemaVersion).toBe(1);
  });

  it("accepts a v1-shaped document under v2 because the new field is optional", () => {
    expect(registry.parsePayload("EvolvedEvent", 2, v1Document)).toEqual(v1Document);
    expect(registry.parsePayload("EvolvedEvent", 2, v2Document)).toEqual(v2Document);
  });

  it("routes each document to the version its envelope declares", () => {
    expect(
      registry.parseEnvelope(sampleEnvelope("EvolvedEvent", 2, v2Document)).schemaVersion,
    ).toBe(2);
    expect(() =>
      registry.parseEnvelope(sampleEnvelope("EvolvedEvent", 3, v2Document)),
    ).toThrow(UnknownEventContractError);
  });

  it("pins the event type and version on the generated envelope schema", () => {
    const contract = defineEventContract("SampleEvent", 3, evolvedV1);
    expect(contract.eventType).toBe("SampleEvent");
    expect(contract.schemaVersion).toBe(3);
    expect(
      contract.envelopeSchema.safeParse(sampleEnvelope("SampleEvent", 3, { marketId: "m-1" }))
        .success,
    ).toBe(true);
    expect(
      contract.envelopeSchema.safeParse(sampleEnvelope("OtherEvent", 3, { marketId: "m-1" }))
        .success,
    ).toBe(false);
  });
});
