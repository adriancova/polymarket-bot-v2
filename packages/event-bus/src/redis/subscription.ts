/**
 * One consumer's view of a Redis Stream.
 *
 * ## Reading by position, not by server-side group state
 *
 * Delivery is a forward scan from an explicit position the consumer owns. That
 * is a deliberate choice over a server-managed consumer group: ADR-003 §3.4
 * requires checkpoints to be *explicit*, and a group's last-delivered id is
 * implicit server state that advances as a side effect of reading. With an
 * explicit position, "where does a restarted trader resume?" has an answer the
 * trader can inspect, store beside its own state, and be refused on if it is
 * outside retention.
 *
 * ## The three states this object can be in
 *
 * 1. **Delivering** — `receive` returns batches in publication order.
 * 2. **Blocked on an unreadable entry** — the valid events before it were
 *    delivered; the next `receive` throws {@link EventBusEntryError} and the
 *    position does not move. Nothing was skipped and nothing was hidden.
 * 3. **Blocked on a hard resync** — retention removed events this consumer had
 *    not read. `receive` returns `resync-required` and keeps returning it, and
 *    `checkpoint` is refused, until the caller acknowledges with an applied
 *    authoritative snapshot (ADR-003 §3.3, §7.1). There is no path from here
 *    back to delivering that does not go through that acknowledgement.
 *
 * A dedicated connection carries the blocking reads, because a blocked socket
 * would otherwise stall every unrelated command queued behind it. Checkpoint
 * writes and state reads go through the transport's command connection for the
 * same reason.
 */

import { performance } from "node:perf_hooks";

import type { EventEnvelope } from "@polymarket-bot/domain";

import { decodeEnvelope } from "../envelope-codec.js";
import { EpochOrderTracker } from "../epoch-order.js";
import {
  EventBusCheckpointError,
  EventBusConfigurationError,
  EventBusEntryError,
  EventBusError,
  EventBusResyncRequiredError,
  EventBusStateError,
  EventBusUnavailableError,
} from "../errors.js";
import type { ConsumerMetrics, StreamQueueMetrics } from "../metrics.js";
import { checkSequenceContinuity } from "../resync.js";
import type { SequenceContinuity } from "../resync.js";
import type {
  ConsumerId,
  DeliveredEvent,
  EventStreamName,
  EventSubscription,
  HardResyncAcknowledgement,
  HardResyncCondition,
  ReceiveOptions,
  ReceiveResult,
  StreamCheckpoint,
  TransportId,
} from "../transport.js";
import type { EventBusRedisClient } from "./client.js";
import { closeRedisClient } from "./client.js";
import { createCheckpoint, readCheckpoint, STREAM_ORIGIN_ENTRY_ID } from "./checkpoint.js";
import type { StreamPosition } from "./checkpoint.js";
import { FIELD_ENVELOPE, FIELD_SEQUENCE } from "./scripts.js";
import type { StreamState } from "./stream-state.js";

/** Default batch bound: large enough to amortize a round trip, small enough to stay predictable. */
export const DEFAULT_MAX_EVENTS = 128;

/** Upper bound on a single batch, so one call cannot pull an unbounded amount into memory. */
export const MAX_EVENTS_LIMIT = 10_000;

/** Upper bound on how long one `receive` may block. */
export const MAX_WAIT_MS = 600_000;

/** Services the subscription borrows from the transport's command connection. */
export type SubscriptionServices = {
  readStreamState(): Promise<StreamState>;
  /**
   * Records a position durably, and only one the stream really holds.
   *
   * Takes the position rather than a token because the server judges the
   * position and writes it in one step (`./position.ts`); the token it stored is
   * returned so the subscription reports exactly what is durable.
   */
  storeCheckpoint(consumerId: ConsumerId, position: StreamPosition): Promise<string>;
  queueMetrics(): Promise<StreamQueueMetrics>;
};

export type RedisStreamSubscriptionOptions = {
  readonly transportId: TransportId;
  readonly stream: EventStreamName;
  readonly consumerId: ConsumerId;
  readonly streamKey: string;
  /** The marker of the stream instance this subscription reads. */
  readonly origin: string;
  readonly client: EventBusRedisClient;
  readonly services: SubscriptionServices;
  readonly startPosition: StreamPosition;
  /** Set when the start position came from a durable checkpoint. */
  readonly startCheckpoint?: StreamCheckpoint;
  readonly maxTrackedEpochs?: number;
  readonly onClosed: () => void;
};

/**
 * A retained entry, as read.
 *
 * `usable: false` covers an entry this transport did not write — it carries no
 * publication ordinal, so it cannot be ordered and cannot be delivered. It is
 * *reported*, never skipped: §8.3 forbids a silent drop, and "we did not
 * recognise it" is not a licence to ignore it.
 */
type StreamEntry =
  | {
      readonly usable: true;
      readonly entryId: string;
      readonly sequence: number;
      readonly envelope: string;
    }
  | { readonly usable: false; readonly entryId: string; readonly detail: string };

export class RedisStreamSubscription<TPayload = unknown> implements EventSubscription<TPayload> {
  readonly stream: EventStreamName;
  readonly consumerId: ConsumerId;

  readonly #transportId: TransportId;
  readonly #streamKey: string;
  readonly #origin: string;
  readonly #client: EventBusRedisClient;
  readonly #services: SubscriptionServices;
  readonly #onClosed: () => void;
  readonly #orderTracker: EpochOrderTracker;

  #position: StreamPosition;
  #checkpointedSequence: number;
  #lastCheckpoint: StreamCheckpoint | undefined;
  #resync: HardResyncCondition | undefined;
  #pendingEntryError: EventBusEntryError | undefined;
  #pendingContinuity: Exclude<SequenceContinuity, { kind: "continuous" }> | undefined;
  #inFlight = false;
  #closed = false;

  #deliveredTotal = 0;
  #hardResyncTotal = 0;
  #missedEventsTotal = 0;
  #nonMonotonicDeliveries = 0;
  #unreadableEntriesTotal = 0;
  #receiveWaitTimeMs = 0;

  constructor(options: RedisStreamSubscriptionOptions) {
    this.stream = options.stream;
    this.consumerId = options.consumerId;
    this.#transportId = options.transportId;
    this.#streamKey = options.streamKey;
    this.#origin = options.origin;
    this.#client = options.client;
    this.#services = options.services;
    this.#onClosed = options.onClosed;
    this.#position = options.startPosition;
    this.#checkpointedSequence = options.startPosition.sequence;
    this.#lastCheckpoint = options.startCheckpoint;
    this.#orderTracker = new EpochOrderTracker(
      options.maxTrackedEpochs === undefined
        ? {}
        : { maxTrackedEpochs: options.maxTrackedEpochs },
    );
  }

  /**
   * Checks continuity once, at subscription time.
   *
   * Detecting the gap here rather than at the first delivery matters
   * operationally: a trader that has fallen outside retention must learn it at
   * startup, while it is deciding whether it may trade, not later when an
   * event happens to arrive.
   */
  async primeContinuity(): Promise<void> {
    const state = await this.#services.readStreamState();
    const verdict = checkSequenceContinuity({
      source: "stream-state",
      lastDeliveredSequence: this.#position.sequence,
      firstRetainedSequence: state.firstSequence,
      publishedTotal: state.publishedTotal,
    });
    if (verdict.kind !== "continuous") {
      this.#raiseResync(verdict);
    }
  }

  /**
   * Reads the next batch.
   *
   * Serialized against itself and against `acknowledgeHardResync`: both move
   * the read position, and two of them interleaved would advance it past
   * events neither returned. A caller that needs concurrency uses two
   * subscriptions, which have separate positions by construction.
   */
  async receive(options: ReceiveOptions = {}): Promise<ReceiveResult<TPayload>> {
    return await this.#exclusively(async () => await this.#receive(options));
  }

  async #receive(options: ReceiveOptions): Promise<ReceiveResult<TPayload>> {
    if (this.#pendingEntryError !== undefined) {
      const error = this.#pendingEntryError;
      this.#pendingEntryError = undefined;
      throw error;
    }
    if (this.#pendingContinuity !== undefined) {
      const verdict = this.#pendingContinuity;
      this.#pendingContinuity = undefined;
      return { status: "resync-required", condition: this.#raiseResync(verdict) };
    }
    if (this.#resync !== undefined) {
      return { status: "resync-required", condition: this.#resync };
    }

    const maxEvents = boundedInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, 1, MAX_EVENTS_LIMIT, "maxEvents");
    const waitMs = boundedInteger(options.waitMs ?? 0, 0, MAX_WAIT_MS, "waitMs");

    const entries = await this.#read(maxEvents, waitMs);
    if (entries.length === 0) {
      return await this.#idleOrResync();
    }

    const first = entries[0];
    if (first === undefined) {
      return await this.#idleOrResync();
    }
    if (!first.usable) {
      throw this.#unusableEntryError(first);
    }
    const verdict = checkSequenceContinuity({
      source: "delivery",
      lastDeliveredSequence: this.#position.sequence,
      arrivingSequence: first.sequence,
    });
    if (verdict.kind !== "continuous") {
      return { status: "resync-required", condition: this.#raiseResync(verdict) };
    }

    return { status: "events", events: this.#deliver(entries) };
  }

  async checkpoint(position: StreamCheckpoint): Promise<void> {
    this.#assertOpen();
    if (this.#resync !== undefined) {
      throw new EventBusResyncRequiredError(
        "cannot checkpoint while a hard-resync condition is pending; checkpointing past the gap " +
          "would be exactly the silent catch-up ADR-003 §3.3 forbids",
        { stream: this.stream, consumerId: this.consumerId, missedEventCount: this.#resync.missedEventCount },
      );
    }

    const parsed = readCheckpoint(this.#transportId, this.stream, position);
    if (parsed.origin !== this.#origin) {
      // Recorded under this consumer's id, a position from another stream
      // instance would be resumed on the next restart as though it were ours.
      throw new EventBusCheckpointError(
        "checkpoint was taken in a different stream instance, so it names no position here",
        { stream: this.stream, consumerId: this.consumerId },
      );
    }
    if (parsed.sequence < this.#checkpointedSequence) {
      throw new EventBusCheckpointError(
        "checkpoint would move backwards; a consumer that has consumed further cannot un-consume",
        { stream: this.stream, consumerId: this.consumerId, from: this.#checkpointedSequence, to: parsed.sequence },
      );
    }
    if (parsed.sequence > this.#position.sequence) {
      throw new EventBusCheckpointError(
        "checkpoint names an event this subscription has not delivered",
        { stream: this.stream, consumerId: this.consumerId, delivered: this.#position.sequence, requested: parsed.sequence },
      );
    }

    // The server judges the position and records it in one step: a position it
    // does not hold is refused rather than stored for a later restart to
    // resume from.
    const token = await this.#services.storeCheckpoint(this.consumerId, {
      entryId: parsed.entryId,
      sequence: parsed.sequence,
    });
    this.#lastCheckpoint = { transport: this.#transportId, stream: this.stream, token };
    this.#checkpointedSequence = parsed.sequence;
  }

  lastCheckpoint(): StreamCheckpoint | undefined {
    return this.#lastCheckpoint;
  }

  pendingResync(): HardResyncCondition | undefined {
    return this.#resync;
  }

  async acknowledgeHardResync(acknowledgement: HardResyncAcknowledgement): Promise<void> {
    await this.#exclusively(async () => {
      await this.#acknowledgeHardResync(acknowledgement);
    });
  }

  async #acknowledgeHardResync(acknowledgement: HardResyncAcknowledgement): Promise<void> {
    if (this.#resync === undefined) {
      throw new EventBusStateError(
        "no hard-resync condition is pending; an acknowledgement cannot be armed in advance",
        { stream: this.stream, consumerId: this.consumerId },
      );
    }
    // Checked at runtime as well as in the type: the acknowledgement crosses a
    // process boundary in every realistic deployment, and §7.1 makes the
    // snapshot obligation unconditional.
    if (acknowledgement.authoritativeSnapshotApplied !== true) {
      throw new EventBusStateError(
        "a hard resync is cleared only by an applied authoritative snapshot (§7.1, ADR-002 §2.4)",
        { stream: this.stream, consumerId: this.consumerId },
      );
    }
    if (acknowledgement.resumeFrom !== "oldest-retained" && acknowledgement.resumeFrom !== "newest") {
      throw new EventBusConfigurationError("resumeFrom must be `oldest-retained` or `newest`", {
        resumeFrom: acknowledgement.resumeFrom,
      });
    }

    const state = await this.#services.readStreamState();
    const resumed = resolveResumePosition(state, acknowledgement.resumeFrom);

    this.#position = resumed;
    this.#orderTracker.reset();
    this.#resync = undefined;
    this.#pendingContinuity = undefined;

    // The skip is recorded durably, so a crash immediately after the
    // acknowledgement does not replay the gap and demand a second snapshot for
    // the same loss.
    const token = await this.#services.storeCheckpoint(this.consumerId, resumed);
    this.#lastCheckpoint = { transport: this.#transportId, stream: this.stream, token };
    this.#checkpointedSequence = resumed.sequence;
  }

  async metrics(): Promise<ConsumerMetrics> {
    this.#assertOpen();
    const queue = await this.#services.queueMetrics();
    return {
      stream: this.stream,
      consumerId: this.consumerId,
      queue,
      consumerLag: Math.max(0, queue.publishedTotal - this.#position.sequence),
      uncheckpointedCount: Math.max(0, this.#position.sequence - this.#checkpointedSequence),
      deliveredTotal: this.#deliveredTotal,
      hardResyncTotal: this.#hardResyncTotal,
      missedEventsTotal: this.#missedEventsTotal,
      nonMonotonicDeliveries: this.#nonMonotonicDeliveries,
      unreadableEntriesTotal: this.#unreadableEntriesTotal,
      receiveWaitTimeMs: this.#receiveWaitTimeMs,
      resyncPending: this.#resync !== undefined,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#onClosed();
    await closeRedisClient(this.#client);
  }

  async #read(maxEvents: number, waitMs: number): Promise<readonly StreamEntry[]> {
    const startedAt = performance.now();
    let reply: unknown;
    try {
      reply =
        waitMs > 0
          ? await this.#client.xread(
              "COUNT",
              maxEvents,
              "BLOCK",
              waitMs,
              "STREAMS",
              this.#streamKey,
              this.#position.entryId,
            )
          : await this.#client.xread(
              "COUNT",
              maxEvents,
              "STREAMS",
              this.#streamKey,
              this.#position.entryId,
            );
    } catch (cause) {
      this.#receiveWaitTimeMs += performance.now() - startedAt;
      throw new EventBusUnavailableError(
        "could not read from the event transport",
        { stream: this.stream, consumerId: this.consumerId },
        cause,
      );
    }
    this.#receiveWaitTimeMs += performance.now() - startedAt;
    return this.#parseReply(reply);
  }

  /**
   * Parses one read reply.
   *
   * An unrecognised reply shape is a failure, not an empty batch: returning
   * "nothing arrived" for a reply we could not read would advance a polling
   * caller past whatever it contained.
   */
  #parseReply(reply: unknown): readonly StreamEntry[] {
    if (reply === null || reply === undefined) {
      return [];
    }
    if (!Array.isArray(reply)) {
      throw this.#unreadableReply(reply);
    }
    const entries: StreamEntry[] = [];
    for (const perStream of reply as unknown[]) {
      if (!Array.isArray(perStream)) {
        throw this.#unreadableReply(reply);
      }
      const items = (perStream as unknown[])[1];
      if (!Array.isArray(items)) {
        throw this.#unreadableReply(reply);
      }
      for (const item of items as unknown[]) {
        entries.push(this.#parseEntry(item, reply));
      }
    }
    return entries;
  }

  #parseEntry(item: unknown, reply: unknown): StreamEntry {
    if (!Array.isArray(item)) {
      throw this.#unreadableReply(reply);
    }
    const [rawId, rawFields] = item as unknown[];
    if (typeof rawId !== "string" || !Array.isArray(rawFields)) {
      throw this.#unreadableReply(reply);
    }
    let sequence: string | undefined;
    let envelope: string | undefined;
    const fields = rawFields as unknown[];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const name = fields[index];
      const value = fields[index + 1];
      if (typeof name !== "string" || typeof value !== "string") {
        continue;
      }
      if (name === FIELD_SEQUENCE) {
        sequence = value;
      } else if (name === FIELD_ENVELOPE) {
        envelope = value;
      }
    }
    if (sequence === undefined || envelope === undefined) {
      return {
        usable: false,
        entryId: rawId,
        detail: "the entry carries none of this transport's own fields, so it was written by something else",
      };
    }
    const parsedSequence = Number(sequence);
    if (!Number.isSafeInteger(parsedSequence) || parsedSequence < 1) {
      return {
        usable: false,
        entryId: rawId,
        detail: `the entry's publication ordinal \`${sequence}\` is not a positive safe integer`,
      };
    }
    return { usable: true, entryId: rawId, sequence: parsedSequence, envelope };
  }

  #unreadableReply(reply: unknown): EventBusUnavailableError {
    return new EventBusUnavailableError(
      "the event transport returned a reply shape this implementation cannot read",
      { stream: this.stream, consumerId: this.consumerId, replyType: typeof reply },
    );
  }

  /**
   * The error raised for an entry that is not ours.
   *
   * The attached checkpoint keeps the publication ordinal where it is and moves
   * only past the offending entry id, because a foreign entry consumed no
   * ordinal — so stepping over it deliberately does not make the next real
   * event look like a gap.
   */
  #unusableEntryError(entry: { readonly entryId: string; readonly detail: string }): EventBusEntryError {
    this.#unreadableEntriesTotal += 1;
    return new EventBusEntryError(
      `a retained entry could not be read: ${entry.detail}; delivery stops here rather than stepping over it`,
      {
        stream: this.stream,
        consumerId: this.consumerId,
        entryId: entry.entryId,
        checkpoint: createCheckpoint(this.#transportId, this.stream, this.#origin, {
          entryId: entry.entryId,
          sequence: this.#position.sequence,
        }),
      },
    );
  }

  /**
   * Decodes a batch, stopping at the first entry that cannot be read back.
   *
   * The valid prefix is delivered and the position advances through it, so
   * nothing already readable is lost; the failure is stashed and thrown from
   * the next `receive`, with the offending entry's checkpoint attached so a
   * caller that has opened a data-quality incident can step over exactly that
   * entry and nothing else.
   */
  #deliver(entries: readonly StreamEntry[]): readonly DeliveredEvent<TPayload>[] {
    const delivered: DeliveredEvent<TPayload>[] = [];

    for (const entry of entries) {
      if (!entry.usable) {
        this.#pendingEntryError = this.#unusableEntryError(entry);
        break;
      }

      const expected = this.#position.sequence + 1;
      if (entry.sequence !== expected) {
        // Unreachable while the publish script is the only writer, since it
        // assigns ordinals and appends atomically. Kept because the
        // alternative to noticing a hole mid-batch is delivering across it.
        const midBatch = checkSequenceContinuity({
          source: "delivery",
          lastDeliveredSequence: this.#position.sequence,
          arrivingSequence: entry.sequence,
        });
        if (midBatch.kind !== "continuous") {
          this.#pendingContinuity = midBatch;
        }
        break;
      }

      let envelope: EventEnvelope<unknown>;
      try {
        envelope = decodeEnvelope(entry.envelope);
      } catch (cause) {
        this.#unreadableEntriesTotal += 1;
        this.#pendingEntryError = new EventBusEntryError(
          "a stored entry could not be read back as a §7.1 envelope; delivery stops here rather " +
            "than stepping over it",
          {
            stream: this.stream,
            consumerId: this.consumerId,
            entryId: entry.entryId,
            checkpoint: createCheckpoint(this.#transportId, this.stream, this.#origin, {
              entryId: entry.entryId,
              sequence: entry.sequence,
            }),
            reason: cause instanceof EventBusError ? cause.details : String(cause),
          },
        );
        break;
      }

      const observation = this.#orderTracker.observe(envelope.gatewayEpoch, envelope.ingestSeq);
      if (!observation.advanced) {
        this.#nonMonotonicDeliveries += 1;
      }

      this.#position = { entryId: entry.entryId, sequence: entry.sequence };
      this.#deliveredTotal += 1;
      delivered.push({
        envelope: envelope as EventEnvelope<TPayload>,
        checkpoint: createCheckpoint(this.#transportId, this.stream, this.#origin, this.#position),
      });
    }

    if (delivered.length === 0 && this.#pendingEntryError !== undefined) {
      const error = this.#pendingEntryError;
      this.#pendingEntryError = undefined;
      throw error;
    }
    return delivered;
  }

  async #idleOrResync(): Promise<ReceiveResult<TPayload>> {
    const state = await this.#services.readStreamState();
    const verdict = checkSequenceContinuity({
      source: "stream-state",
      lastDeliveredSequence: this.#position.sequence,
      firstRetainedSequence: state.firstSequence,
      publishedTotal: state.publishedTotal,
    });
    if (verdict.kind !== "continuous") {
      return { status: "resync-required", condition: this.#raiseResync(verdict) };
    }
    return { status: "idle" };
  }

  #raiseResync(verdict: Exclude<SequenceContinuity, { kind: "continuous" }>): HardResyncCondition {
    const missedEventCount = verdict.kind === "gap" ? verdict.missedEventCount : 0;
    const condition: HardResyncCondition = {
      stream: this.stream,
      consumerId: this.consumerId,
      reason: verdict.kind === "gap" ? "retention-exceeded" : "transport-sequence-inconsistent",
      missedEventCount,
      detectedAt: new Date().toISOString(),
      requiresAuthoritativeSnapshot: true,
      detail:
        verdict.kind === "gap"
          ? `retention removed ${String(missedEventCount)} event(s) after publication ordinal ` +
            `${String(this.#position.sequence)} before this consumer read them`
          : verdict.detail,
    };
    this.#resync = condition;
    this.#hardResyncTotal += 1;
    this.#missedEventsTotal += missedEventCount;
    return condition;
  }

  async #exclusively<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#inFlight) {
      throw new EventBusStateError(
        "another read or resync acknowledgement is already in flight on this subscription; both " +
          "move the read position, so they are not safe to interleave",
        { stream: this.stream, consumerId: this.consumerId },
      );
    }
    this.#inFlight = true;
    try {
      return await operation();
    } finally {
      this.#inFlight = false;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new EventBusStateError("this subscription is closed", {
        stream: this.stream,
        consumerId: this.consumerId,
      });
    }
  }
}

/** Where delivery resumes after an acknowledged hard resync. */
export function resolveResumePosition(
  state: StreamState,
  resumeFrom: "oldest-retained" | "newest",
): StreamPosition {
  if (resumeFrom === "newest") {
    return {
      entryId: state.lastEntryId ?? STREAM_ORIGIN_ENTRY_ID,
      sequence: state.publishedTotal,
    };
  }
  if (state.firstSequence === undefined) {
    // Nothing is retained, so "oldest retained" and "newest" are the same
    // place. Resuming at the end is not a second skip: there is nothing
    // between here and there.
    return {
      entryId: state.lastEntryId ?? STREAM_ORIGIN_ENTRY_ID,
      sequence: state.publishedTotal,
    };
  }
  return { entryId: STREAM_ORIGIN_ENTRY_ID, sequence: state.firstSequence - 1 };
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EventBusConfigurationError(
      `${field} must be an integer in [${String(min)}, ${String(max)}], received ${String(value)}`,
      { field, value },
    );
  }
  return value;
}
