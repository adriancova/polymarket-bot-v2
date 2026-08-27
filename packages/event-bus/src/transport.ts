/**
 * The gateway-to-trader transport interface (handoff §9.1, ADR-003 §1).
 *
 * §9.1 requires exactly four capabilities, and this file declares exactly those
 * four plus the observability obligations that §8.3 and ADR-003 §3 attach to
 * them:
 *
 * ```text
 * publish
 * subscribe
 * consumer checkpoint
 * bounded retention
 * ```
 *
 * ## What crosses this boundary
 *
 * Normalized {@link EventEnvelope} values (ADR-002, ADR-003 §2) — not raw
 * frames. Raw frames go to the write-ahead log, on a deliberately separate path
 * (ADR-004), so a transport outage costs decisions rather than recorded data.
 *
 * Payloads are **opaque** here. This package never parses, transforms, or
 * re-serializes payload economics, and never coerces a decimal string to a
 * JavaScript `number`.
 *
 * ## Vocabulary discipline
 *
 * ADR-003's Consequences make this a substantive rule, not a naming preference:
 * "If consumer-group names, `XADD` ids, or `MAXLEN` trimming appear in a
 * consumer's types, the transport is no longer replaceable and this ADR has
 * been violated in substance while satisfied in form."
 *
 * So a {@link StreamCheckpoint}'s `token` is **opaque**: it is issued by the
 * transport that produced it, persisted verbatim by the consumer, and handed
 * back verbatim. A consumer that parses it has broken the boundary.
 * `transport-vocabulary.test.ts` enforces the rule mechanically against this
 * file and `metrics.ts`.
 *
 * Replacing the v1 implementation, or adding a second one, requires a new ADR
 * (ADR-003 §1). The interface exists so that decision stays cheap, not so that
 * it can be made silently.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";

import type { ConsumerMetrics, StreamQueueMetrics } from "./metrics.js";

/**
 * A logical stream of normalized market events.
 *
 * A name, not an address: how it maps onto storage is the implementation's
 * business.
 */
export type EventStreamName = string;

/**
 * Identifies a durable consumer across restarts.
 *
 * The checkpoint a consumer stores is keyed by this, which is what makes
 * "resume from a known position" (ADR-003 §3.4) mean something after a
 * process restart.
 */
export type ConsumerId = string;

/**
 * Identifies the implementation that issued a checkpoint.
 *
 * A checkpoint token means nothing outside the implementation that minted it,
 * so it carries its issuer and is rejected by any other one. This is the
 * mechanism that keeps ADR-003 §1's "one transport at a time" honest instead of
 * merely stated.
 */
export type TransportId = string;

/**
 * A durable position in a stream.
 *
 * `token` is **opaque**. Persist it, compare it for equality, hand it back —
 * but do not parse it, do not order two tokens by inspecting them, and do not
 * construct one. `stream` and `transport` are not opaque: they exist so a
 * token cannot be replayed into the wrong stream or the wrong implementation.
 *
 * A token is bound to the transport instance that issued it, and the position
 * it names is checked against that instance before delivery resumes from it.
 * A token from another deployment, or one describing a position that does not
 * exist, is refused rather than resumed from — because resuming from a
 * position the transport cannot vouch for would skip whatever lay between it
 * and the consumer's real one, which is the silent catch-up ADR-003 §3.3
 * forbids. Refusal is an {@link EventSubscription} or `subscribe` error, never
 * a quiet reposition.
 */
export type StreamCheckpoint = {
  readonly transport: TransportId;
  readonly stream: EventStreamName;
  /** Opaque to every consumer. See the note above. */
  readonly token: string;
};

/** An event handed to a consumer, with the checkpoint that acknowledges it. */
export type DeliveredEvent<TPayload = unknown> = {
  readonly envelope: EventEnvelope<TPayload>;
  /**
   * Acknowledges this event **and everything delivered before it**.
   *
   * Checkpoints are cumulative: there is no per-event acknowledgement and no
   * out-of-order acknowledgement, because `(gatewayEpoch, ingestSeq)` is a
   * total order within an epoch and a consumer that skipped one event would
   * have no way to express that.
   */
  readonly checkpoint: StreamCheckpoint;
};

/**
 * The consumer is missing events that retention removed before it read them.
 *
 * ADR-003 §3.3: "Trader lag beyond configured retention is a hard
 * resynchronization event, not silent catch-up from an incomplete stream."
 * A subscription that raises this stops delivering until the caller
 * acknowledges it with {@link HardResyncAcknowledgement}; there is no path
 * through this package that resumes from the oldest surviving event as though
 * nothing were missing.
 */
export type HardResyncCondition = {
  readonly stream: EventStreamName;
  readonly consumerId: ConsumerId;
  readonly reason: HardResyncReason;
  /**
   * Events that left the stream before this consumer read them.
   *
   * `0` when `reason` is `transport-sequence-inconsistent`, where the loss is
   * real but cannot be counted exactly. A count of `0` there is not a claim
   * that nothing was lost — `reason` is.
   */
  readonly missedEventCount: number;
  /** Wall-clock ISO-8601 instant at which the condition was detected. */
  readonly detectedAt: string;
  /**
   * Pinned to `true`.
   *
   * §7.1 and ADR-002 §2.4 make the obligation unconditional: "a restart or
   * detected gap requires a new authoritative snapshot before affected markets
   * resume". A condition that could waive it would be a condition that permits
   * the silent catch-up ADR-003 §3.3 forbids.
   */
  readonly requiresAuthoritativeSnapshot: true;
  readonly detail: string;
};

export type HardResyncReason =
  /** Retention removed events between the consumer's checkpoint and the surviving stream. */
  | "retention-exceeded"
  /**
   * The transport's own publication counters disagree with the retained
   * stream — the stream was truncated or reset out from under the consumer.
   * Surfaced rather than papered over, because the consumer cannot know what
   * it missed.
   */
  | "transport-sequence-inconsistent";

/**
 * A caller's statement that it has recovered from a hard-resync condition.
 *
 * Requiring the literal `true` is the point: §7.1 makes an authoritative
 * snapshot mandatory after a gap, and ADR-002 §2.4 pins the equivalent domain
 * fields to `true` so "a resynchronization event cannot assert recovery it did
 * not perform". The same reasoning applies here — a subscription cannot be
 * un-stuck by a caller that merely wants the events to start flowing again.
 */
export type HardResyncAcknowledgement = {
  /** Must be the literal `true` (§7.1, ADR-002 §2.4, ADR-003 §3.3). */
  readonly authoritativeSnapshotApplied: true;
  /**
   * Where delivery resumes.
   *
   * `oldest-retained` replays everything still in the stream; `newest` skips
   * to the current end. Both are deliberate, recorded decisions taken *after*
   * a snapshot, never a default.
   */
  readonly resumeFrom: "oldest-retained" | "newest";
  /** Optional reference to the data-quality incident opened for the gap (§8.3). */
  readonly incidentRef?: string;
};

/** Where a new subscription starts reading. */
export type SubscriptionStart =
  | {
      /**
       * Resume the durable checkpoint stored for this consumer (ADR-003 §3.4).
       *
       * `whenMissing` applies only on a consumer's very first subscription,
       * when no checkpoint exists yet, and has deliberately no default of its
       * own: naming this variant means saying what happens when there is
       * nothing to resume. `newest` is therefore never reached by omission,
       * which is what ADR-003 §3.4 rules out — a consumer that silently
       * started at `newest` after losing its checkpoint would be resuming from
       * "now".
       */
      readonly at: "stored-checkpoint";
      readonly whenMissing: "oldest-retained" | "newest" | "fail";
    }
  /** Start at the oldest event retention still holds. */
  | { readonly at: "oldest-retained" }
  /** Start after the newest published event, receiving only what follows. */
  | { readonly at: "newest" }
  /** Resume a checkpoint the caller holds (for example one persisted elsewhere). */
  | { readonly at: "checkpoint"; readonly checkpoint: StreamCheckpoint };

export type SubscribeOptions = {
  readonly stream: EventStreamName;
  readonly consumerId: ConsumerId;
  /**
   * Where this subscription starts reading.
   *
   * Defaults to `{ at: "stored-checkpoint", whenMissing: "oldest-retained" }` —
   * resume what this consumer stored, and otherwise replay everything retention
   * still holds. The default is a real one, and it is the conservative one: it
   * can never start from "now" (ADR-003 §3.4), because reaching `newest`
   * requires asking for it.
   */
  readonly start?: SubscriptionStart;
};

export type ReceiveOptions = {
  /** Upper bound on the batch size. Defaults to 128. */
  readonly maxEvents?: number;
  /**
   * How long to wait for at least one event before returning `idle`.
   *
   * Defaults to `0` (return immediately). A caller inside the deterministic
   * core loop (§8.1) uses `0` and polls; a caller with a dedicated reader task
   * uses a positive value to avoid busy-waiting.
   */
  readonly waitMs?: number;
};

/**
 * The outcome of one `receive`.
 *
 * A discriminated union rather than "events, or throw": a hard-resync
 * condition is an expected operational state that the caller must handle
 * (halt affected trading, open a data-quality incident, obtain an
 * authoritative snapshot), not an exception to log and retry.
 */
export type ReceiveResult<TPayload = unknown> =
  | { readonly status: "events"; readonly events: readonly DeliveredEvent<TPayload>[] }
  | { readonly status: "idle" }
  | { readonly status: "resync-required"; readonly condition: HardResyncCondition };

/** What `publish` returns once the event is durably in the stream. */
export type PublishReceipt = {
  readonly stream: EventStreamName;
  /**
   * The transport's own publication ordinal for this stream: 1 for the first
   * event ever published, and contiguous thereafter.
   *
   * It is **not** an ordering authority — `(gatewayEpoch, ingestSeq)` is
   * (ADR-002 §2). It exists so the transport can tell "nothing has arrived
   * yet" from "events arrived and retention removed them", which is what makes
   * the hard-resync condition detectable at all.
   */
  readonly sequence: number;
};

/**
 * The bound on how much a stream retains (§9.1 "bounded retention").
 *
 * ADR-003's Consequences: "Retention size is a safety parameter, not a tuning
 * knob. Retention shorter than the worst tolerated trader restart converts an
 * ordinary restart into a hard resync plus an authoritative-snapshot cycle."
 */
export type RetentionPolicy = {
  /** Maximum events retained per stream. Enforced exactly, not approximately. */
  readonly maxEvents: number;
};

/** One consumer's live view of a stream. */
export interface EventSubscription<TPayload = unknown> {
  readonly stream: EventStreamName;
  readonly consumerId: ConsumerId;

  /**
   * Reads the next batch, in publication order.
   *
   * Ordering (ADR-003 §2): events are never reordered within a gateway epoch,
   * and two epochs are never merged into one apparent sequence — each delivered
   * envelope carries its own `gatewayEpoch`, and this package never sorts,
   * groups, or renumbers by anything.
   */
  receive(options?: ReceiveOptions): Promise<ReceiveResult<TPayload>>;

  /**
   * Durably records that everything up to and including `position` is consumed.
   *
   * Explicit, because ADR-003 §3.4 requires a restart to resume from a known
   * position rather than from "now". Refuses a checkpoint that regresses,
   * belongs to another stream, or names an event this subscription has not
   * delivered.
   */
  checkpoint(position: StreamCheckpoint): Promise<void>;

  /** The last position this subscription successfully recorded, if any. */
  lastCheckpoint(): StreamCheckpoint | undefined;

  /** The pending hard-resync condition, if delivery is currently blocked by one. */
  pendingResync(): HardResyncCondition | undefined;

  /**
   * Clears a pending hard-resync condition and resumes delivery.
   *
   * Throws when no condition is pending, so an acknowledgement can never be
   * pre-armed to make the next gap invisible.
   */
  acknowledgeHardResync(acknowledgement: HardResyncAcknowledgement): Promise<void>;

  metrics(): Promise<ConsumerMetrics>;

  close(): Promise<void>;
}

/**
 * The transport itself.
 *
 * One implementation exists (ADR-003 §1) and lives in `./redis/`. Nothing
 * outside this package may reach that implementation's client directly
 * (`docs/contracts/dependency-direction.md` §3, F8).
 */
export interface MarketEventTransport {
  readonly transportId: TransportId;

  /** The configured retention bound, applied to every stream (§9.1). */
  readonly retention: RetentionPolicy;

  /**
   * Publishes one normalized envelope.
   *
   * Never returns without either placing the event in the stream or throwing:
   * §8.3 forbids a silent drop, so an invalid envelope, a non-advancing
   * `ingestSeq`, a closed transport, and an unreachable transport are all
   * typed throws (see `./errors.ts`).
   *
   * The stream never refuses an event because it is full. Retention removes the
   * oldest events instead, and the loss becomes a hard-resync condition for any
   * consumer that had not read them (ADR-003 §3.3) rather than a quiet gap.
   */
  publish(stream: EventStreamName, envelope: EventEnvelope<unknown>): Promise<PublishReceipt>;

  subscribe<TPayload = unknown>(
    options: SubscribeOptions,
  ): Promise<EventSubscription<TPayload>>;

  /** The §8.3 metric set for one stream. */
  streamMetrics(stream: EventStreamName): Promise<StreamQueueMetrics>;

  /** Closes every subscription this transport created, then the transport. */
  close(): Promise<void>;
}
