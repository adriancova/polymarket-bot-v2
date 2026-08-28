import { describe, expect, it } from "vitest";

import { computeFeedMetrics, type FeedMetricsInput } from "./metrics.js";

const BASE: FeedMetricsInput = {
  feedId: "binance.reference",
  endpoint: "wss://data-stream.binance.vision/stream",
  state: "OPEN",
  connectionId: "conn-1",
  pendingConnectionId: undefined,
  subscriptionGeneration: 0,
  subscribedStreams: ["btcusdt@trade"],
  stalenessMs: 0,
  stalenessThresholdMs: 30_000,
  lastFrameAt: undefined,
  lastVenueTimestamp: undefined,
  lastVenueToReceiptLagMs: undefined,
  maxVenueToReceiptLagMs: undefined,
  connectionAgeMs: 0,
  connectionLifetimeMs: 86_400_000,
  frames: {
    framesReceived: 0,
    eventsEmitted: 0,
    tradesNormalized: 0,
    topOfBookNormalized: 0,
    partialTopOfBook: 0,
    duplicatesSuppressed: 0,
    lateTradesEmitted: 0,
    staleUpdatesSuppressed: 0,
    conflictingDuplicates: 0,
    unrepresentableValues: 0,
    unknownFrames: 0,
    malformedFrames: 0,
    framesWithUnknownFields: 0,
    controlResponses: 0,
    controlErrors: 0,
    serverShutdownNotices: 0,
    framesNotFromLiveConnection: 0,
  },
  connections: {
    connectionAttempts: 1,
    connectionsOpened: 1,
    disconnects: 0,
    socketErrors: 0,
    staleEpisodes: 0,
    incidentsOpened: 0,
    lifecycleEventsNotFromLiveConnection: 0,
  },
  openIncidentReasonCodes: [],
  sequences: [],
  trackedStreams: 0,
  maxTrackedStreams: 4096,
  maxRecentIdsPerStream: 64,
  untrackedSequenceObservations: 0,
};

describe("computeFeedMetrics", () => {
  it("treats reaching the threshold as stale, not merely exceeding it", () => {
    expect(computeFeedMetrics({ ...BASE, stalenessMs: 29_999 }).stale).toBe(false);
    expect(computeFeedMetrics({ ...BASE, stalenessMs: 30_000 }).stale).toBe(true);
    expect(computeFeedMetrics({ ...BASE, stalenessMs: 30_001 }).stale).toBe(true);
  });

  it("clamps a negative staleness at zero", () => {
    expect(computeFeedMetrics({ ...BASE, stalenessMs: -5 }).stalenessMs).toBe(0);
  });

  it("reports the remaining budget before the documented 24-hour disconnect", () => {
    const metrics = computeFeedMetrics({ ...BASE, connectionAgeMs: 86_000_000 });
    expect(metrics.connectionLifetimeRemainingMs).toBe(400_000);
  });

  it("clamps the remaining budget at zero rather than going negative", () => {
    const metrics = computeFeedMetrics({ ...BASE, connectionAgeMs: 90_000_000 });
    expect(metrics.connectionLifetimeRemainingMs).toBe(0);
  });

  it("reports no connection age or budget when the feed is not connected", () => {
    const metrics = computeFeedMetrics({ ...BASE, state: "IDLE", connectionAgeMs: undefined });
    expect(metrics.connectionAgeMs).toBeUndefined();
    expect(metrics.connectionLifetimeRemainingMs).toBeUndefined();
  });

  it("preserves a negative venue-to-receipt lag, which is real clock-skew evidence", () => {
    const metrics = computeFeedMetrics({ ...BASE, lastVenueToReceiptLagMs: -120 });
    expect(metrics.lastVenueToReceiptLagMs).toBe(-120);
  });

  it("projects per-stream sequence state, including the duplicate window's reach", () => {
    const metrics = computeFeedMetrics({
      ...BASE,
      sequences: [
        { key: "btcusdt@trade", lastId: 99, observations: 4, recentIdsTracked: 4 },
      ],
      trackedStreams: 1,
    });
    expect(metrics.streams).toEqual([
      {
        streamName: "btcusdt@trade",
        lastVenueSequenceId: 99,
        observations: 4,
        recentIdsTracked: 4,
      },
    ]);
    expect(metrics.maxRecentIdsPerStream).toBe(64);
  });
});
