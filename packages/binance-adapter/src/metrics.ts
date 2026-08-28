/**
 * Staleness and feed metrics, as typed values a caller queries.
 *
 * NO PROMETHEUS, NO `packages/observability`. `WP-080`'s deliverable is
 * "staleness metrics"; the metric *export* arrives with `WP-140`, and
 * `packages/observability` is a layer-1 package this layer-2 adapter must not
 * depend on (`docs/contracts/dependency-direction.md` §2, F12). So these are
 * plain readonly values. The same choice was made by `packages/event-bus`
 * (`StreamQueueMetrics`), and matching it means one exporter can later read both
 * without a per-package adapter.
 *
 * STALENESS IS MEASURED ON THE MONOTONIC CLOCK. `stalenessMs` is the elapsed
 * time since the last frame, computed from `receivedMonotonicNs`, because a wall
 * clock stepped by NTP would otherwise show a feed as fresh (or ancient) for
 * reasons that have nothing to do with the feed. `lastFrameAt` is the wall-clock
 * instant, for a human reading a log.
 *
 * STALENESS IS DATA, AND SO IS THE THRESHOLD. There is no documented maximum
 * interval between two market-data messages on a Binance stream — a quiet symbol
 * is quiet — so `stalenessThresholdMs` is a caller-stated tolerance, never a
 * default this package invents. The computation here only compares.
 *
 * WHY `venueToReceiptLagMs` IS SIGNED. It is the difference between two
 * different clocks (the venue's and this host's), so a negative value is real
 * evidence of skew. Clamping it at zero would delete the only signal an operator
 * has that the two disagree.
 */

import type { FeedConnectionState } from "./connection.js";
import type { SequenceState } from "./sequence.js";

/** Per-stream sequence state, for an operator looking for a stalled symbol. */
export type BinanceStreamMetrics = {
  /** `"<lowercase symbol>@<suffix>"`. */
  readonly streamName: string;
  /** Last `t` (trade) or `u` (bookTicker) observed on this stream. */
  readonly lastVenueSequenceId: number;
  readonly observations: number;
  /**
   * Ids currently inside this stream's duplicate window.
   *
   * The window is bounded, so this is the real reach of duplicate detection: an
   * id that has fallen out of it can no longer be recognised as a repeat. Making
   * it a metric is what keeps that limit visible instead of assumed away.
   */
  readonly recentIdsTracked: number;
};

/** Counters accumulated by one feed; every field is a plain count. */
export type BinanceFrameCounters = {
  readonly framesReceived: number;
  readonly eventsEmitted: number;
  readonly tradesNormalized: number;
  readonly topOfBookNormalized: number;
  readonly partialTopOfBook: number;
  readonly duplicatesSuppressed: number;
  /**
   * Trades whose id was below the last seen one and that were emitted anyway.
   *
   * A trade is a point observation, so a late one is real information and is
   * published; a top-of-book update is versioned state, so a late one would
   * overwrite newer state and is suppressed instead
   * (`staleUpdatesSuppressed`). The two counters exist separately because the
   * two decisions are different.
   */
  readonly lateTradesEmitted: number;
  readonly staleUpdatesSuppressed: number;
  readonly conflictingDuplicates: number;
  readonly unrepresentableValues: number;
  readonly unknownFrames: number;
  readonly malformedFrames: number;
  readonly framesWithUnknownFields: number;
  readonly controlResponses: number;
  readonly controlErrors: number;
  readonly serverShutdownNotices: number;
  /**
   * Frames refused because they did not come from the live socket, or arrived
   * when no socket was live at all.
   *
   * Counted separately from `framesReceived` (which counts everything the
   * transport delivered) so that a socket still talking after it was retired is
   * a number an operator can see rather than an invisible correction.
   */
  readonly framesNotFromLiveConnection: number;
};

/** Connection lifecycle counters. */
export type BinanceConnectionCounters = {
  readonly connectionAttempts: number;
  readonly connectionsOpened: number;
  readonly disconnects: number;
  readonly socketErrors: number;
  readonly staleEpisodes: number;
  readonly incidentsOpened: number;
  /**
   * OPEN/ERROR/CLOSE events refused on socket identity.
   *
   * Covers a retired socket still talking, a foreign socket while one is live,
   * a malformed identity, and an open on a feed the caller has closed.
   */
  readonly lifecycleEventsNotFromLiveConnection: number;
};

/** The whole queryable metric surface for one feed. */
export type BinanceFeedMetrics = {
  readonly feedId: string;
  readonly endpoint: string;
  readonly state: FeedConnectionState;
  readonly connectionId: string | undefined;
  /** §7.1: a resubscription creates a new generation. */
  readonly subscriptionGeneration: number;
  readonly subscribedStreams: readonly string[];

  /** Elapsed time since the last frame, from the monotonic clock. */
  readonly stalenessMs: number;
  /** Caller-stated tolerance; never defaulted by this package. */
  readonly stalenessThresholdMs: number;
  readonly stale: boolean;
  /** Wall-clock instant of the last frame, or `undefined` if none has arrived. */
  readonly lastFrameAt: string | undefined;
  /** Last venue instant seen (trades only; `bookTicker` supplies none). */
  readonly lastVenueTimestamp: string | undefined;
  /** Signed lag between the last venue instant and its receipt instant. */
  readonly lastVenueToReceiptLagMs: number | undefined;
  readonly maxVenueToReceiptLagMs: number | undefined;

  /** Age of the current connection, or `undefined` when not open. */
  readonly connectionAgeMs: number | undefined;
  /** Documented ceiling: "a single connection … is only valid for 24 hours". */
  readonly connectionLifetimeMs: number;
  /** Remaining budget before the documented 24-hour disconnect, clamped at zero. */
  readonly connectionLifetimeRemainingMs: number | undefined;

  readonly frames: BinanceFrameCounters;
  readonly connections: BinanceConnectionCounters;

  /** Reason codes with an incident opened and not yet closed by an operator. */
  readonly openIncidentReasonCodes: readonly string[];

  readonly streams: readonly BinanceStreamMetrics[];
  readonly trackedStreams: number;
  readonly maxTrackedStreams: number;
  /** Bound on each stream's duplicate window; ids beyond it are forgotten. */
  readonly maxRecentIdsPerStream: number;
  readonly untrackedSequenceObservations: number;
};

/** Inputs to {@link computeFeedMetrics}; all already-measured values. */
export type FeedMetricsInput = {
  readonly feedId: string;
  readonly endpoint: string;
  readonly state: FeedConnectionState;
  readonly connectionId: string | undefined;
  readonly subscriptionGeneration: number;
  readonly subscribedStreams: readonly string[];
  /** Elapsed milliseconds since the last frame (or since connect when none). */
  readonly stalenessMs: number;
  readonly stalenessThresholdMs: number;
  readonly lastFrameAt: string | undefined;
  readonly lastVenueTimestamp: string | undefined;
  readonly lastVenueToReceiptLagMs: number | undefined;
  readonly maxVenueToReceiptLagMs: number | undefined;
  readonly connectionAgeMs: number | undefined;
  readonly connectionLifetimeMs: number;
  readonly frames: BinanceFrameCounters;
  readonly connections: BinanceConnectionCounters;
  readonly openIncidentReasonCodes: readonly string[];
  readonly sequences: readonly SequenceState[];
  readonly trackedStreams: number;
  readonly maxTrackedStreams: number;
  readonly maxRecentIdsPerStream: number;
  readonly untrackedSequenceObservations: number;
};

/**
 * Assembles the metric surface. Pure, so the arithmetic is testable on its own.
 *
 * `stale` is `stalenessMs >= threshold`, inclusive: a threshold is a limit, and
 * reaching it is reaching it. `connectionLifetimeRemainingMs` is clamped at zero
 * rather than going negative, because the venue's answer past the deadline is a
 * disconnect, not a negative budget.
 */
export function computeFeedMetrics(input: FeedMetricsInput): BinanceFeedMetrics {
  return {
    feedId: input.feedId,
    endpoint: input.endpoint,
    state: input.state,
    connectionId: input.connectionId,
    subscriptionGeneration: input.subscriptionGeneration,
    subscribedStreams: input.subscribedStreams,

    stalenessMs: Math.max(0, input.stalenessMs),
    stalenessThresholdMs: input.stalenessThresholdMs,
    stale: Math.max(0, input.stalenessMs) >= input.stalenessThresholdMs,
    lastFrameAt: input.lastFrameAt,
    lastVenueTimestamp: input.lastVenueTimestamp,
    lastVenueToReceiptLagMs: input.lastVenueToReceiptLagMs,
    maxVenueToReceiptLagMs: input.maxVenueToReceiptLagMs,

    connectionAgeMs: input.connectionAgeMs,
    connectionLifetimeMs: input.connectionLifetimeMs,
    connectionLifetimeRemainingMs:
      input.connectionAgeMs === undefined
        ? undefined
        : Math.max(0, input.connectionLifetimeMs - input.connectionAgeMs),

    frames: input.frames,
    connections: input.connections,
    openIncidentReasonCodes: input.openIncidentReasonCodes,

    streams: input.sequences.map((entry) => ({
      streamName: entry.key,
      lastVenueSequenceId: entry.lastId,
      observations: entry.observations,
      recentIdsTracked: entry.recentIdsTracked,
    })),
    trackedStreams: input.trackedStreams,
    maxTrackedStreams: input.maxTrackedStreams,
    maxRecentIdsPerStream: input.maxRecentIdsPerStream,
    untrackedSequenceObservations: input.untrackedSequenceObservations,
  };
}
