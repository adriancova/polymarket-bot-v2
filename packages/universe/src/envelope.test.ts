import { describe, expect, it } from "vitest";

import { marketLifecycleInputFromEnvelope } from "./envelope.js";
import { applyMarketLifecycleEvent, type MarketProjection } from "./lifecycle.js";
import { createParameterHistory } from "./parameters.js";
import { UNBOUND_SERIES_BINDING } from "./series.js";
import {
  SAMPLE_MARKET_ID,
  marketIdentitySample,
  parameterObservationSample,
} from "./testing/index.js";

const CONDITION_ID = marketIdentitySample().conditionId;

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "018f3a5c-9b7e-7c3d-8f21-6b0f9a2c4d1f",
    eventType: "MarketOpened",
    schemaVersion: 1,
    source: "polymarket",
    sourceChannel: "market",
    receivedAt: "2026-08-28T12:00:00.000Z",
    receivedMonotonicNs: "123456789012345",
    gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e",
    ingestSeq: "42",
    payload: {
      internalMarketId: SAMPLE_MARKET_ID,
      conditionId: CONDITION_ID,
      openedAt: "2026-08-28T12:00:00Z",
    },
    ...overrides,
  };
}

function projection(): MarketProjection {
  return {
    identity: marketIdentitySample(),
    seriesBinding: UNBOUND_SERIES_BINDING,
    lifecycleState: "DISCOVERED",
    outcomeState: "PENDING",
    metadataVersion: 1,
    clarifications: [],
    parameters: createParameterHistory(SAMPLE_MARKET_ID, parameterObservationSample()),
  };
}

describe("marketLifecycleInputFromEnvelope", () => {
  it("extracts the event type, payload, ordering, and market id", () => {
    const result = marketLifecycleInputFromEnvelope(envelope());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventType).toBe("MarketOpened");
    expect(result.value.internalMarketId).toBe(SAMPLE_MARKET_ID);
    expect(result.value.order).toEqual({
      gatewayEpoch: "018f3a5c-9b7e-4c3d-8f21-6b0f9a2c4d1e",
      ingestSeq: "42",
    });
  });

  it("produces an input the projection accepts", () => {
    const result = marketLifecycleInputFromEnvelope(envelope());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const applied = applyMarketLifecycleEvent(projection(), result.value);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.projection.lifecycleState).toBe("OPEN");
      expect(applied.value.projection.lastEventOrder?.ingestSeq).toBe("42");
    }
  });

  it("refuses an envelope the frozen contract rejects", () => {
    for (const broken of [
      envelope({ ingestSeq: "not-a-number" }),
      envelope({ schemaVersion: 99 }),
      envelope({ payload: { internalMarketId: SAMPLE_MARKET_ID } }),
      {},
      null,
      "MarketOpened",
    ]) {
      const result = marketLifecycleInputFromEnvelope(broken);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusals[0]?.code).toBe("UNIVERSE_INPUT_INVALID");
      }
    }
  });

  it("refuses an event type this projection does not fold", () => {
    const result = marketLifecycleInputFromEnvelope(
      envelope({
        eventType: "BestBidAskChanged",
        source: "polymarket",
        payload: {
          internalMarketId: SAMPLE_MARKET_ID,
          tokenId: "1000000001",
          bestBidPrice: "0.4",
          bestBidSize: "10",
          bestAskPrice: "0.6",
          bestAskSize: "10",
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals[0]?.code).toBe("UNIVERSE_EVENT_UNSUPPORTED");
    }
  });
});
