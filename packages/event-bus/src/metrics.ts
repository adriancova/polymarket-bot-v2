/**
 * Queue metrics for the bounded event transport (handoff §8.3).
 *
 * §8.3 states that every queue is bounded and exposes:
 *
 * ```text
 * current depth
 * maximum depth
 * oldest message age
 * messages dropped
 * producer blocked time
 * consumer lag
 * ```
 *
 * The six names are reproduced literally in {@link StreamQueueMetrics} so a
 * dashboard can be built from the specification rather than from an
 * implementation. Nothing here talks to Prometheus: `packages/observability`
 * does not exist yet and the metric export arrives with `WP-140`. These are
 * typed values a caller queries.
 *
 * The computation is pure and lives here, separately from any transport
 * implementation, so the arithmetic is unit-testable without a container.
 */

import { EventBusConfigurationError } from "./errors.js";
import type { ConsumerId, EventStreamName } from "./transport.js";

/** How far behind the newest published event one durable consumer is. */
export type ConsumerLagEntry = {
  readonly consumerId: ConsumerId;
  /** Events published to the stream that this consumer has not checkpointed. */
  readonly lag: number;
};

/**
 * The §8.3 metric set for one bounded stream.
 *
 * `consumerLag` is a list rather than a scalar because one stream may have
 * several durable consumers and §8.3's single number would have to pick one of
 * them arbitrarily.
 */
export type StreamQueueMetrics = {
  readonly stream: EventStreamName;
  /** §8.3 "current depth" — events retained right now. */
  readonly currentDepth: number;
  /** §8.3 "maximum depth" — the configured retention bound, not an observed peak. */
  readonly maximumDepth: number;
  /** §8.3 "oldest message age", in milliseconds. `0` when the stream is empty. */
  readonly oldestMessageAgeMs: number;
  /**
   * §8.3 "messages dropped" — events retention removed from the bounded stream.
   *
   * This is never a *silent* drop (§8.3, ADR-003 §3.2): a consumer whose
   * checkpoint falls inside the removed range receives a hard-resync condition
   * from `receive` instead of a quiet catch-up. Retention is a safety
   * parameter, and this counter is how an operator sees it biting.
   */
  readonly messagesDropped: number;
  /**
   * §8.3 "producer blocked time", in milliseconds.
   *
   * Cumulative wall-clock time producers **in this process** spent inside
   * `publish` waiting for the transport to accept an event — measured from the
   * moment `publish` submitted the event, so time spent waiting behind an
   * earlier publish of the same stream is included. Measuring only the round
   * trip would report a fast transport while every producer behind a stalled
   * one waited invisibly. A process that only consumes reports `0` because it
   * published nothing, not because the metric is missing.
   */
  readonly producerBlockedTimeMs: number;
  /**
   * Publishes queued or in flight in this process for this stream, right now.
   *
   * §8.3's "current depth" for the *producer* side. The retained-events depth
   * above describes what the transport holds; this describes what has been
   * handed to `publish` and has not come back yet.
   */
  readonly publishQueueDepth: number;
  /**
   * The bound on {@link publishQueueDepth} — a configured limit, not a peak.
   *
   * §8.3 requires every queue to be bounded. Reaching this bound refuses the
   * publish with a typed error rather than accepting an event the transport has
   * no way to move.
   */
  readonly publishQueueMaxDepth: number;
  /**
   * How long the longest-waiting queued publish has been waiting, in
   * milliseconds. `0` when nothing is queued.
   *
   * §8.3's "oldest message age" for the producer side, and the number that makes
   * a stalled transport visible before the queue fills.
   */
  readonly oldestQueuedPublishAgeMs: number;
  /** §8.3 "consumer lag", per durable consumer with a stored checkpoint. */
  readonly consumerLag: readonly ConsumerLagEntry[];
  /** Total events ever published to this stream, including those retention removed. */
  readonly publishedTotal: number;
  /** Publish attempts this process refused or could not complete. */
  readonly publishFailures: number;
  /**
   * Publishes that landed but whose retention bound could not then be applied.
   *
   * The event and its publication ordinal are consistent — the publish
   * succeeded and is reported as such — but the stream is temporarily holding
   * more than `maximumDepth`, which is visible as `currentDepth` exceeding it
   * until a later publish trims. Counted rather than ignored because retention
   * is "a safety parameter, not a tuning knob" (ADR-003 Consequences), and a
   * bound that silently stopped being applied would be exactly the kind of
   * quiet drift that sizing decisions rest on.
   */
  readonly retentionTrimFailures: number;
  /**
   * Stored consumer positions this transport could not turn into a position.
   *
   * Three things end up here, and none of them is a lag number: a value this
   * transport did not write, a position taken against a different instance of
   * this stream (another server, another key namespace, or a stream that was
   * destroyed and recreated), and a position the server itself refuses — judged
   * with the **same** judgement `subscribe` applies, so this counter and the
   * refusal a restart would hit cannot disagree. Reporting lag for any of them
   * would be an invented measurement; leaving them out entirely would make a
   * consumer disappear from `consumerLag` without a word.
   */
  readonly unreadableCheckpoints: number;
};

/** Per-subscription counters, alongside the stream's §8.3 queue metrics. */
export type ConsumerMetrics = {
  readonly stream: EventStreamName;
  readonly consumerId: ConsumerId;
  /** The §8.3 metric set for the stream this subscription reads. */
  readonly queue: StreamQueueMetrics;
  /** Events published but not yet delivered to this subscription. */
  readonly consumerLag: number;
  /** Events delivered to this subscription but not yet checkpointed. */
  readonly uncheckpointedCount: number;
  /** Events delivered since this subscription was created. */
  readonly deliveredTotal: number;
  /** Hard-resync conditions raised since this subscription was created. */
  readonly hardResyncTotal: number;
  /** Events retention removed before this subscription could read them. */
  readonly missedEventsTotal: number;
  /**
   * Deliveries whose `ingestSeq` did not advance within its `gatewayEpoch`
   * since this subscription started.
   *
   * A transport that reordered within an epoch, or a producer that republished
   * after an ambiguous failure, shows up here. Compared with `BigInt`;
   * `ingestSeq` is never coerced to a JavaScript `number` (ADR-002 §1).
   */
  readonly nonMonotonicDeliveries: number;
  /** Entries this subscription could not read back as envelopes. */
  readonly unreadableEntriesTotal: number;
  /** Cumulative wall-clock time this subscription spent waiting inside `receive`. */
  readonly receiveWaitTimeMs: number;
  /** True while a hard-resync condition is pending acknowledgement. */
  readonly resyncPending: boolean;
};

/** Inputs to {@link computeStreamQueueMetrics}; all transport-neutral. */
export type StreamQueueMetricsInput = {
  readonly stream: EventStreamName;
  readonly publishedTotal: number;
  readonly currentDepth: number;
  readonly maximumDepth: number;
  /** Publication time of the oldest retained event, or `undefined` when empty. */
  readonly oldestEntryAtMs: number | undefined;
  /** The transport server's current time, so a client clock skew cannot distort the age. */
  readonly nowMs: number;
  readonly producerBlockedTimeMs: number;
  readonly publishFailures: number;
  /** Publishes queued or in flight in the reporting process. */
  readonly publishQueueDepth: number;
  /** The bound on that queue. */
  readonly publishQueueMaxDepth: number;
  /** Wait of the longest-waiting queued publish, in milliseconds. */
  readonly oldestQueuedPublishAgeMs: number;
  /** Publishes after which the retention bound could not be applied. */
  readonly retentionTrimFailures: number;
  readonly consumerLag: readonly ConsumerLagEntry[];
  /** Stored consumer positions the caller could not turn into a position. */
  readonly unreadableCheckpoints: number;
};

/**
 * Assembles the §8.3 metric set from raw counters.
 *
 * `messagesDropped` is derived as `publishedTotal - currentDepth`: this package
 * never deletes an individual event, so everything that has left the stream
 * left because retention removed it. The subtraction is clamped at zero so an
 * operator who truncates the stream out from under a running process sees `0`
 * rather than a negative counter.
 */
export function computeStreamQueueMetrics(input: StreamQueueMetricsInput): StreamQueueMetrics {
  assertNonNegativeInteger(input.publishedTotal, "publishedTotal");
  assertNonNegativeInteger(input.currentDepth, "currentDepth");
  assertNonNegativeInteger(input.maximumDepth, "maximumDepth");
  assertNonNegativeInteger(input.unreadableCheckpoints, "unreadableCheckpoints");
  assertNonNegativeInteger(input.publishQueueDepth, "publishQueueDepth");
  assertNonNegativeInteger(input.publishQueueMaxDepth, "publishQueueMaxDepth");
  assertNonNegativeInteger(input.retentionTrimFailures, "retentionTrimFailures");

  const oldestMessageAgeMs =
    input.oldestEntryAtMs === undefined ? 0 : Math.max(0, input.nowMs - input.oldestEntryAtMs);

  return {
    stream: input.stream,
    currentDepth: input.currentDepth,
    maximumDepth: input.maximumDepth,
    oldestMessageAgeMs,
    messagesDropped: Math.max(0, input.publishedTotal - input.currentDepth),
    producerBlockedTimeMs: input.producerBlockedTimeMs,
    publishQueueDepth: input.publishQueueDepth,
    publishQueueMaxDepth: input.publishQueueMaxDepth,
    oldestQueuedPublishAgeMs: Math.max(0, input.oldestQueuedPublishAgeMs),
    consumerLag: input.consumerLag,
    publishedTotal: input.publishedTotal,
    publishFailures: input.publishFailures,
    retentionTrimFailures: input.retentionTrimFailures,
    unreadableCheckpoints: input.unreadableCheckpoints,
  };
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EventBusConfigurationError(
      `${field} must be a non-negative safe integer, received ${String(value)}`,
      { field, value },
    );
  }
}
