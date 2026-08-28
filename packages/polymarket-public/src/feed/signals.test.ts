import { describe, expect, it } from "vitest";

import { PublicMarketConfigurationError } from "../errors.js";
import type { PublicMarketProblem } from "../normalize/result.js";
import {
  dataQualityIncidentFromProblem,
  feedConnected,
  feedGapDetected,
  feedResynchronized,
  feedStale,
} from "./signals.js";

const CONNECTED = {
  feedId: "polymarket-market",
  connectionId: "conn-1",
  endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  subscriptionGeneration: 1,
  connectedAt: "2026-08-27T12:00:00.000Z",
};

describe("feed signal payloads are validated against their own contracts", () => {
  it("builds a valid FeedConnected", () => {
    const event = feedConnected(CONNECTED);
    expect(event.eventType).toBe("FeedConnected");
    expect(event.payload).toEqual(CONNECTED);
  });

  it("refuses to publish an event its own domain contract rejects", () => {
    // An injected connection-id factory returning "" would otherwise publish a
    // FeedConnected no consumer can trace back to a connection.
    expect(() => feedConnected({ ...CONNECTED, connectionId: "" })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => feedConnected({ ...CONNECTED, feedId: "has space" })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => feedConnected({ ...CONNECTED, connectedAt: "yesterday" })).toThrow(
      PublicMarketConfigurationError,
    );
  });
});

describe("the unconditional gap invariant", () => {
  it("cannot emit a gap that waives the snapshot obligation", () => {
    const event = feedGapDetected({
      feedId: "polymarket-market",
      detectedAt: "2026-08-27T12:00:00.000Z",
      reasonCode: "FEED_RECONNECTED",
    });
    expect(event.payload).toMatchObject({ requiresAuthoritativeSnapshot: true });
  });

  it("cannot emit a resynchronization that did not apply a snapshot", () => {
    const event = feedResynchronized({
      feedId: "polymarket-market",
      resynchronizedAt: "2026-08-27T12:00:00.000Z",
      subscriptionGeneration: 3,
    });
    expect(event.payload).toMatchObject({ authoritativeSnapshotApplied: true });
  });
});

describe("feedStale", () => {
  it("rounds and floors the staleness so the contract's integer bound holds", () => {
    const event = feedStale({
      feedId: "polymarket-market",
      detectedAt: "2026-08-27T12:00:00.000Z",
      stalenessMs: 30_001.6,
    });
    expect(event.payload).toMatchObject({ stalenessMs: 30_002 });

    const negative = feedStale({
      feedId: "polymarket-market",
      detectedAt: "2026-08-27T12:00:00.000Z",
      stalenessMs: -5,
    });
    expect(negative.payload).toMatchObject({ stalenessMs: 0 });
  });
});

describe("dataQualityIncidentFromProblem", () => {
  const problem: PublicMarketProblem = {
    code: "UNKNOWN_SIDE",
    detail: 'unknown venue side "MIDDLE"',
    sourceChannel: "polymarket:market-ws",
    venueEventType: "price_change",
    observedIndex: 2,
    raw: { side: "MIDDLE" },
  };

  it("carries the problem's own code as the incident reason code", () => {
    const event = dataQualityIncidentFromProblem(problem, {
      incidentId: "incident-1",
      openedAt: "2026-08-27T12:00:00.000Z",
      severity: "NOTIFY",
      feedId: "polymarket-market",
    });
    expect(event.eventType).toBe("DataQualityIncidentOpened");
    expect(event.payload).toMatchObject({
      incidentId: "incident-1",
      reasonCode: "UNKNOWN_SIDE",
      severity: "NOTIFY",
      feedId: "polymarket-market",
    });
    expect((event.payload as { detail: string }).detail).toContain("price_change");
    expect((event.payload as { detail: string }).detail).toContain("MIDDLE");
  });

  it("refuses a caller-supplied incident id the contract rejects", () => {
    expect(() =>
      dataQualityIncidentFromProblem(problem, {
        incidentId: "",
        openedAt: "2026-08-27T12:00:00.000Z",
        severity: "LOG",
      }),
    ).toThrow(PublicMarketConfigurationError);
  });

  it("keeps the incident's position within the frame", () => {
    const event = dataQualityIncidentFromProblem(problem, {
      incidentId: "incident-1",
      openedAt: "2026-08-27T12:00:00.000Z",
      severity: "LOG",
    });
    expect(event.provenance.observedIndex).toBe(2);
  });
});
