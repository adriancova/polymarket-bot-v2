import { describe, expect, it } from "vitest";

import { PublicMarketConfigurationError } from "../errors.js";
import type { RtdsProblem } from "./result.js";
import * as signals from "./signals.js";
import {
  FEED_DISCONNECT_REASONS,
  FEED_GAP_REASONS,
  rtdsDataQualityIncidentFromProblem,
  rtdsFeedConnected,
  rtdsFeedDisconnected,
  rtdsFeedGapDetected,
  rtdsFeedStale,
} from "./signals.js";

const CONNECTED = {
  feedId: "polymarket-rtds-twap",
  connectionId: "conn-1",
  endpoint: "wss://ws-live-data.polymarket.com",
  subscriptionGeneration: 1,
  connectedAt: "2026-07-27T19:00:00.000Z",
};

describe("feed signals carry rtds provenance", () => {
  it("stamps the source the reference payload restates", () => {
    // `ReferenceTwapObserved.venue` is `rtds`, and `assertEnvelopePayloadProvenance`
    // compares the two; a `polymarket` envelope source here would break it.
    const event = rtdsFeedConnected(CONNECTED);
    expect(event.provenance).toEqual({
      source: "rtds",
      sourceChannel: "rtds:crypto-twap-ws",
      observedIndex: 0,
    });
  });

  it("validates every payload against its own domain contract", () => {
    expect(rtdsFeedConnected(CONNECTED).payload).toEqual(CONNECTED);
    expect(() => rtdsFeedConnected({ ...CONNECTED, connectionId: "" })).toThrow(
      PublicMarketConfigurationError,
    );
    expect(() => rtdsFeedConnected({ ...CONNECTED, feedId: "has space" })).toThrow(
      PublicMarketConfigurationError,
    );
  });
});

describe("the gap obligation cannot be waived", () => {
  it("pins requiresAuthoritativeSnapshot", () => {
    const event = rtdsFeedGapDetected({
      feedId: "polymarket-rtds-twap",
      detectedAt: "2026-07-27T19:00:00.000Z",
      reasonCode: FEED_GAP_REASONS.reconnected,
      detail: "reconnected",
    });
    expect(event.payload).toMatchObject({ requiresAuthoritativeSnapshot: true });
  });

  it("offers no way to publish a resynchronization", () => {
    // RTDS has no snapshot to apply, so this module deliberately exports no
    // `FeedResynchronized` builder: the event pins
    // `authoritativeSnapshotApplied: true`, and this adapter can never
    // truthfully assert it. Checked mechanically over the module's real
    // exports, so adding one later fails here rather than passing review.
    const exported = Object.keys(signals);
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.some((name) => /resynchron/iu.test(name))).toBe(false);
    expect(exported).toContain("rtdsFeedGapDetected");
  });
});

describe("staleness and disconnect signals", () => {
  it("rounds and floors the staleness it reports", () => {
    const event = rtdsFeedStale({
      feedId: "polymarket-rtds-twap",
      connectionId: "conn-1",
      detectedAt: "2026-07-27T19:00:00.000Z",
      lastMessageAt: "2026-07-27T18:58:00.000Z",
      stalenessMs: 120_000.7,
    });
    expect(event.payload).toMatchObject({ stalenessMs: 120_001 });
  });

  it("shares the sibling feed's disconnect vocabulary", () => {
    const event = rtdsFeedDisconnected({
      feedId: "polymarket-rtds-twap",
      connectionId: "conn-1",
      disconnectedAt: "2026-07-27T19:00:00.000Z",
      reasonCode: FEED_DISCONNECT_REASONS.transportClosed,
    });
    expect(event.payload).toMatchObject({ reasonCode: "TRANSPORT_CLOSED" });
  });
});

describe("problems become incidents on the same vocabulary", () => {
  it("uses the problem's own code as the incident reason", () => {
    const problem: RtdsProblem = {
      code: "RTDS_WINDOW_TOPIC_MISMATCH",
      detail: "window_s 60 contradicts topic crypto_prices_twap_thirty",
      sourceChannel: "rtds:crypto_prices_twap_thirty",
      topic: "crypto_prices_twap_thirty",
      observedIndex: 0,
      raw: { window_s: 60 },
    };
    const event = rtdsDataQualityIncidentFromProblem(problem, {
      incidentId: "incident-1",
      openedAt: "2026-07-27T19:00:00.000Z",
      severity: "NOTIFY",
      feedId: "polymarket-rtds-twap",
    });
    expect(event.payload).toMatchObject({
      incidentId: "incident-1",
      reasonCode: "RTDS_WINDOW_TOPIC_MISMATCH",
      severity: "NOTIFY",
      feedId: "polymarket-rtds-twap",
    });
  });
});
