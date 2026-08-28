/**
 * Staleness and stream-health metrics, as typed values a caller queries.
 *
 * NOT PROMETHEUS, AND NOT `packages/observability`. This package is layer 2 and
 * may only depend downward (`docs/contracts/dependency-direction.md` §2); the
 * metric *export* arrives with `WP-140`. Everything here is a plain immutable
 * snapshot, computed by pure functions, so the arithmetic is unit-testable with
 * no registry, no exporter, and no I/O — the same division `packages/event-bus`
 * already uses.
 *
 * STALENESS IS DATA. The work plan requires staleness to be surfaced as data
 * quality rather than hidden. It appears in three forms, all of them values:
 * {@link CoinbaseFeedMetrics.stalenessMs} on demand, a
 * `COINBASE_FEED_STALE` anomaly when it crosses the configured bound, and a
 * `FeedStale` domain event carrying the same number. None of them is a log line.
 *
 * MEASURED ON THE MONOTONIC CLOCK. Staleness is an elapsed duration, so it is
 * computed from `receivedMonotonicNs` deltas, not from wall-clock subtraction: a
 * clock step must not be able to invent — or hide — a stale feed. The wall-clock
 * `lastMessageAt` is reported alongside because `FeedStalePayload` needs a
 * timestamp a human can read.
 */

import type { CoinbaseAnomalyCode } from "./anomalies.js";

/** Nanoseconds per millisecond, as a bigint so no conversion goes through a float. */
const NS_PER_MS = 1_000_000n;

/** Per-channel view of when this feed last heard anything on that channel. */
export type CoinbaseChannelStaleness = {
  readonly channel: string;
  /** Wall-clock receipt time of the last frame on this channel. */
  readonly lastMessageAt?: string;
  /** The venue's own `timestamp` on that frame, kept distinct from receipt. */
  readonly lastVenueTimestamp?: string;
  /** Elapsed time since that frame, in whole milliseconds. */
  readonly stalenessMs: number;
  readonly framesReceived: number;
};

/** Cumulative counters for one processor instance. */
export type CoinbaseFeedCounters = {
  readonly framesReceived: number;
  /** Frames that produced no normalized event because they could not be read. */
  readonly framesRejected: number;
  /** Well-formed frames on a channel this adapter does not handle. */
  readonly framesUnknownChannel: number;
  /**
   * Frames delivered by a connection that is no longer current, and therefore
   * refused rather than relabelled with the current generation.
   */
  readonly framesFromStaleConnection: number;
  /** `onOpen` / `onClose` / `onError` callbacks from a superseded connection. */
  readonly staleConnectionCallbacks: number;
  readonly tradesNormalized: number;
  /** Trades recognized as already-seen and therefore not re-emitted. */
  readonly tradesDuplicateSuppressed: number;
  readonly topOfBookNormalized: number;
  /** Ticker entries whose top of book was identical to the last one emitted. */
  readonly topOfBookUnchangedSuppressed: number;
  readonly heartbeatsReceived: number;
  /** `sequence_num` forward jumps: the venue's own statement that data was lost. */
  readonly sequenceGaps: number;
  /** `sequence_num` repeats or backward steps. */
  readonly sequenceRegressions: number;
  /** `heartbeat_counter` forward jumps. */
  readonly heartbeatGaps: number;
  /** `heartbeat_counter` repeats or backward steps. Not a gap; still reported. */
  readonly heartbeatRegressions: number;
  /**
   * `snapshot` events that could not be applied in full, and therefore did not
   * mark their channel resynchronized.
   */
  readonly snapshotsNotApplied: number;
  readonly connectionsOpened: number;
  readonly disconnections: number;
  /** Resubscriptions; equals the highest `subscriptionGeneration` reached. */
  readonly subscriptionGenerations: number;
  /** Gaps closed by an authoritative snapshot on every subscribed channel. */
  readonly resynchronizations: number;
  /** Anomalies emitted, of every code. */
  readonly anomalies: number;
};

/** Everything this adapter knows about its own health, right now. */
export type CoinbaseFeedMetrics = {
  readonly feedId: string;
  readonly endpoint: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly connected: boolean;
  /** True between a detected gap and the snapshot that closes it. */
  readonly gapOpen: boolean;
  /** Wall-clock time this snapshot was taken. */
  readonly observedAt: string;
  readonly lastMessageAt?: string;
  readonly stalenessMs: number;
  readonly stalenessThresholdMs: number;
  /** `stalenessMs > stalenessThresholdMs`, precomputed so callers cannot disagree. */
  readonly stale: boolean;
  readonly perChannel: readonly CoinbaseChannelStaleness[];
  readonly counters: CoinbaseFeedCounters;
  /** How many anomalies of each code have been emitted. */
  readonly anomaliesByCode: Readonly<Partial<Record<CoinbaseAnomalyCode, number>>>;
};

/**
 * Elapsed whole milliseconds between two monotonic readings.
 *
 * Clamped at zero: a monotonic clock cannot go backwards, so a negative result
 * would mean the caller mixed two clocks, and reporting a negative staleness
 * would be worse than reporting none. Integer division truncates, which keeps
 * the result a safe integer and never rounds a fresh feed up into staleness.
 */
export function elapsedMs(sinceNs: bigint, nowNs: bigint): number {
  if (nowNs <= sinceNs) {
    return 0;
  }
  return Number((nowNs - sinceNs) / NS_PER_MS);
}
