import {
  DataQualityIncidentOpenedContract,
  FeedConnectedContract,
  FeedDisconnectedContract,
  FeedGapDetectedContract,
  FeedStaleContract,
} from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import {
  BINANCE_REASON_CODES,
  dataQualityIncidentOpened,
  feedConnected,
  feedDisconnected,
  feedGapDetected,
  feedStale,
  type FeedStatusContext,
} from "./incidents.js";

const CONTEXT: FeedStatusContext = {
  feedId: "binance.reference",
  sourceChannel: "binance:stream-connection",
  receipt: { receivedAt: "2026-08-27T12:00:00.000Z", receivedMonotonicNs: "1000000000" },
  provenance: { connectionId: "conn-1", subscriptionGeneration: 2 },
};

const ENDPOINT = "wss://data-stream.binance.vision/stream";

describe("feed-status builders", () => {
  it("produces a FeedConnected the frozen contract accepts", () => {
    const emission = feedConnected(CONTEXT, ENDPOINT);
    expect(FeedConnectedContract.payloadSchema.safeParse(emission.payload).success).toBe(true);
    expect(emission.eventType).toBe("FeedConnected");
  });

  it("records a credential-free endpoint with no query string", () => {
    const emission = feedConnected(CONTEXT, ENDPOINT);
    const payload = emission.payload as { endpoint: string };
    expect(payload.endpoint).toBe(ENDPOINT);
    expect(payload.endpoint).not.toContain("?");
    expect(payload.endpoint).not.toMatch(/key|token|secret|signature/iu);
  });

  it("produces a FeedDisconnected the frozen contract accepts, with and without detail", () => {
    for (const input of [
      { reasonCode: BINANCE_REASON_CODES.socketClosed },
      { reasonCode: BINANCE_REASON_CODES.socketClosed, detail: "close code 1006" },
    ]) {
      const emission = feedDisconnected(CONTEXT, input);
      expect(FeedDisconnectedContract.payloadSchema.safeParse(emission.payload).success).toBe(true);
    }
  });

  it("pins the gap's snapshot obligation to the contract's literal `true`", () => {
    const emission = feedGapDetected(CONTEXT, {
      reasonCode: BINANCE_REASON_CODES.reconnect,
      detail: "resubscribed after a disconnect",
    });
    expect(FeedGapDetectedContract.payloadSchema.safeParse(emission.payload).success).toBe(true);
    expect((emission.payload as { requiresAuthoritativeSnapshot: boolean })
      .requiresAuthoritativeSnapshot).toBe(true);
  });

  it("omits affectedMarketIds, because a Binance symbol is not an InternalMarketId", () => {
    const emission = feedGapDetected(CONTEXT, { reasonCode: BINANCE_REASON_CODES.reconnect });
    expect("affectedMarketIds" in (emission.payload as object)).toBe(false);
  });

  it("produces a FeedStale the frozen contract accepts", () => {
    const emission = feedStale(CONTEXT, {
      stalenessMs: 45_000,
      lastMessageAt: "2026-08-27T11:59:15.000Z",
    });
    expect(FeedStaleContract.payloadSchema.safeParse(emission.payload).success).toBe(true);
  });

  it("produces a DataQualityIncidentOpened the frozen contract accepts", () => {
    const emission = dataQualityIncidentOpened(CONTEXT, {
      incidentId: "binance.reference:conn-1:1",
      reasonCode: BINANCE_REASON_CODES.frameMalformed,
      severity: "NOTIFY",
      detail: "NOT_JSON: Unexpected token",
    });
    expect(DataQualityIncidentOpenedContract.payloadSchema.safeParse(emission.payload).success).toBe(
      true,
    );
  });

  it("carries the subscription generation onto every status emission", () => {
    for (const emission of [
      feedConnected(CONTEXT, ENDPOINT),
      feedDisconnected(CONTEXT, { reasonCode: BINANCE_REASON_CODES.socketClosed }),
      feedGapDetected(CONTEXT, { reasonCode: BINANCE_REASON_CODES.reconnect }),
      feedStale(CONTEXT, { stalenessMs: 1 }),
    ]) {
      expect(emission.subscriptionGeneration).toBe(2);
      expect(emission.source).toBe("binance");
    }
  });
});
