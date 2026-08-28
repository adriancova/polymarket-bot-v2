import { ReferenceTradeObservedContract } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { buildEmission } from "./emission.js";
import { BinancePayloadError } from "./errors.js";
import type { ReceiptStamp } from "./time.js";

const RECEIPT: ReceiptStamp = {
  receivedAt: "2026-08-27T12:00:00.000Z",
  receivedMonotonicNs: "1000000000",
};

const PROVENANCE = { connectionId: "conn-1", subscriptionGeneration: 0 } as const;

const PAYLOAD = {
  venue: "binance",
  symbol: "BNBBTC",
  price: "0.001",
  size: "100",
  venueTradeId: "12345",
} as const;

describe("buildEmission", () => {
  it("carries exactly the envelope fields an adapter owns", () => {
    const emission = buildEmission({
      contract: ReferenceTradeObservedContract,
      sourceChannel: "bnbbtc@trade",
      venueTimestamp: "2022-12-31T19:43:02.136Z",
      receipt: RECEIPT,
      provenance: PROVENANCE,
      payload: PAYLOAD,
    });

    expect(emission.eventType).toBe("ReferenceTradeObserved");
    expect(emission.schemaVersion).toBe(1);
    expect(emission.source).toBe("binance");
    expect(emission.sourceChannel).toBe("bnbbtc@trade");
    expect(emission.venueTimestamp).toBe("2022-12-31T19:43:02.136Z");
    expect(emission.receivedAt).toBe(RECEIPT.receivedAt);
    expect(emission.receivedMonotonicNs).toBe(RECEIPT.receivedMonotonicNs);
    expect(emission.connectionId).toBe("conn-1");
    expect(emission.subscriptionGeneration).toBe(0);
  });

  it("never assigns a gateway-owned field (ADR-002 §1, §2.1; handoff §9.1)", () => {
    const emission = buildEmission({
      contract: ReferenceTradeObservedContract,
      sourceChannel: "bnbbtc@trade",
      receipt: RECEIPT,
      provenance: PROVENANCE,
      payload: PAYLOAD,
    });
    for (const field of ["eventId", "gatewayEpoch", "ingestSeq"]) {
      expect(field in emission).toBe(false);
    }
  });

  it("omits the venueTimestamp KEY when the venue supplied none", () => {
    // Absence and "present with value undefined" are different documents once
    // serialized; ADR-001 §8.1 refuses to conflate them one layer down.
    const emission = buildEmission({
      contract: ReferenceTradeObservedContract,
      sourceChannel: "bnbbtc@trade",
      receipt: RECEIPT,
      provenance: PROVENANCE,
      payload: PAYLOAD,
    });
    expect("venueTimestamp" in emission).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(emission)) as object)).not.toContain(
      "venueTimestamp",
    );
  });

  it("refuses a payload the frozen contract rejects, at the adapter", () => {
    expect(() =>
      buildEmission({
        contract: ReferenceTradeObservedContract,
        sourceChannel: "bnbbtc@trade",
        receipt: RECEIPT,
        provenance: PROVENANCE,
        // Non-canonical decimal: the boundary never coerces (ADR-001 §3).
        payload: { ...PAYLOAD, price: "0.0010" },
      }),
    ).toThrow(BinancePayloadError);
  });

  it("refuses a payload whose venue contradicts this package's source", () => {
    expect(() =>
      buildEmission({
        contract: ReferenceTradeObservedContract,
        sourceChannel: "bnbbtc@trade",
        receipt: RECEIPT,
        provenance: PROVENANCE,
        payload: { ...PAYLOAD, venue: "coinbase" },
      }),
    ).toThrow(BinancePayloadError);
  });

  it("becomes a valid §7.1 envelope once the gateway adds its own fields", () => {
    const emission = buildEmission({
      contract: ReferenceTradeObservedContract,
      sourceChannel: "bnbbtc@trade",
      venueTimestamp: "2022-12-31T19:43:02.136Z",
      receipt: RECEIPT,
      provenance: PROVENANCE,
      payload: PAYLOAD,
    });

    const envelope = {
      ...emission,
      eventId: "0199a6f0-1c2d-7c3e-8a4b-5c6d7e8f9a0b",
      gatewayEpoch: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      ingestSeq: "1",
    };
    const parsed = ReferenceTradeObservedContract.envelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });
});
