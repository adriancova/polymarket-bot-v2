import { describe, expect, it } from "vitest";

import { EVENT_SAMPLES, sampleEnvelope } from "../testing/samples.js";
import { BookSnapshotPayloadSchema, BookLevelSchema } from "./book.js";
import { DOMAIN_EVENT_CONTRACTS, DOMAIN_EVENT_TYPES } from "./index.js";
import { MarketOutcomeStateSchema } from "./market-lifecycle.js";

const contractsByType = new Map(
  DOMAIN_EVENT_CONTRACTS.map((contract) => [contract.eventType, contract]),
);

describe("the §7.4 minimum event list is complete", () => {
  it("declares exactly the specified 22 event types", () => {
    expect(DOMAIN_EVENT_TYPES).toHaveLength(22);
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(22);
  });

  it("registers one contract per declared event type", () => {
    expect([...contractsByType.keys()].sort()).toEqual([...DOMAIN_EVENT_TYPES].sort());
  });

  it("versions every contract explicitly", () => {
    for (const contract of DOMAIN_EVENT_CONTRACTS) {
      expect(Number.isInteger(contract.schemaVersion)).toBe(true);
      expect(contract.schemaVersion).toBeGreaterThan(0);
    }
  });

  it("covers every event type with a sample", () => {
    expect(EVENT_SAMPLES.map((sample) => sample.eventType).sort()).toEqual(
      [...DOMAIN_EVENT_TYPES].sort(),
    );
  });
});

describe.each(EVENT_SAMPLES)("$eventType", (sample) => {
  const contract = contractsByType.get(sample.eventType);

  it("has a registered contract", () => {
    expect(contract).toBeDefined();
  });

  it("accepts its valid sample payload", () => {
    const result = contract?.payloadSchema.safeParse(sample.payload);
    expect(result?.success).toBe(true);
  });

  it("accepts its valid sample envelope", () => {
    const envelope = sampleEnvelope(sample.eventType, contract?.schemaVersion ?? 1, sample.payload);
    const result = contract?.envelopeSchema.safeParse(envelope);
    if (result !== undefined && !result.success) {
      throw new Error(
        `${sample.eventType} envelope rejected: ${result.error.issues
          .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    expect(result?.success).toBe(true);
  });

  it("rejects an unknown payload key", () => {
    expect(
      contract?.payloadSchema.safeParse({ ...sample.payload, unexpected: "value" }).success,
    ).toBe(false);
  });

  it("rejects the wrong event type on its envelope", () => {
    const envelope = sampleEnvelope("SomeOtherEvent", contract?.schemaVersion ?? 1, sample.payload);
    expect(contract?.envelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("rejects a JavaScript number in place of any string field", () => {
    for (const [key, value] of Object.entries(sample.payload)) {
      if (typeof value !== "string") {
        continue;
      }
      const mutated = { ...sample.payload, [key]: 1.5 };
      expect(
        contract?.payloadSchema.safeParse(mutated).success,
        `${sample.eventType}.${key} accepted a number`,
      ).toBe(false);
    }
  });

  it("rejects non-canonical decimals on every economic field", () => {
    for (const field of sample.economicFields) {
      for (const bad of ["1e5", "1.50", "+1", "-0", "1.", ""]) {
        const mutated = { ...sample.payload, [field]: bad };
        expect(
          contract?.payloadSchema.safeParse(mutated).success,
          `${sample.eventType}.${field} accepted ${JSON.stringify(bad)}`,
        ).toBe(false);
      }
    }
  });

  it("requires every field that is not declared optional", () => {
    for (const key of Object.keys(sample.payload)) {
      const mutated: Record<string, unknown> = { ...sample.payload };
      delete mutated[key];
      expect(
        contract?.payloadSchema.safeParse(mutated).success,
        `${sample.eventType}.${key} optionality mismatch`,
      ).toBe(sample.optionalFields.includes(key));
    }
  });
});

describe("book level economics", () => {
  it("validates nested levels exactly", () => {
    expect(BookLevelSchema.safeParse({ price: "0.52", size: "100" }).success).toBe(true);
    expect(BookLevelSchema.safeParse({ price: 0.52, size: "100" }).success).toBe(false);
    expect(BookLevelSchema.safeParse({ price: "0.52", size: 100 }).success).toBe(false);
    expect(BookLevelSchema.safeParse({ price: "1.5", size: "100" }).success).toBe(false);
    expect(BookLevelSchema.safeParse({ price: "0.52", size: "-1" }).success).toBe(false);
    expect(BookLevelSchema.safeParse({ price: "0.520", size: "100" }).success).toBe(false);
  });

  it("rejects numbers nested inside a snapshot", () => {
    const base = {
      internalMarketId: "018f3a5c-1111-7000-8000-000000000001",
      tokenId: "12345",
      bids: [{ price: 0.52, size: "100" }],
      asks: [],
    };
    expect(BookSnapshotPayloadSchema.safeParse(base).success).toBe(false);
  });

  it("accepts an empty book", () => {
    expect(
      BookSnapshotPayloadSchema.safeParse({
        internalMarketId: "018f3a5c-1111-7000-8000-000000000001",
        tokenId: "12345",
        bids: [],
        asks: [],
      }).success,
    ).toBe(true);
  });
});

describe("settlement outcome states (§9.3)", () => {
  it("enumerates exactly the required states", () => {
    expect(MarketOutcomeStateSchema.options).toEqual([
      "YES_WIN",
      "NO_WIN",
      "SPLIT_50_50",
      "CANCELLED",
      "DISPUTED",
      "PENDING",
      "PENDING_CLARIFICATION",
    ]);
    expect(MarketOutcomeStateSchema.safeParse("RESOLVED").success).toBe(false);
  });
});
