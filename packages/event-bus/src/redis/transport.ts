/**
 * The Redis Streams implementation of the §9.1 transport (ADR-003 §1).
 *
 * This is the initial and only v1 implementation. Replacing it, or adding a
 * second one, requires a new ADR — the interface in `../transport.ts` exists so
 * that decision stays cheap, not so that it can be made silently.
 *
 * ## What this file guarantees
 *
 * - **Per-epoch order.** Events are appended in publish order and read back in
 *   the same order; nothing here sorts, groups, or renumbers. A publish whose
 *   `ingestSeq` does not advance within its `gatewayEpoch` is refused, because
 *   an event with no defined position (ADR-002 §2) must not enter the stream at
 *   all. That check and the append are one serialized step per epoch
 *   (`../serial-queue.ts`), so two overlapping publishes cannot both pass the
 *   same stale cursor and land out of order. Two epochs stay two sequences:
 *   each envelope carries its own `gatewayEpoch`, the tracker keeps one cursor
 *   per epoch, and the two are serialized independently (ADR-003 §2).
 * - **No silent drop.** Publication either lands in the stream or throws a
 *   typed error (§8.3). The stream never refuses an event for being full;
 *   retention removes the oldest instead, and every consumer that had not read
 *   those events is told so as a hard-resync condition (ADR-003 §3.3). The
 *   *producer* queue is a different matter and is bounded: when it is full the
 *   publish is refused with {@link EventBusPublishQueueFullError}, which §8.3
 *   requires — a queue that cannot accept an event halts affected trading
 *   rather than accepting it into unbounded memory.
 * - **A position is judged, not believed.** Every start position and every
 *   stored checkpoint is checked against the server's own state before delivery
 *   begins (`./position.ts`), because a token that merely parses can still name
 *   an entry that never existed, one from another server or key namespace, or
 *   one in the future — and resuming after any of those would skip retained
 *   events without a word.
 * - **A batch is consecutive publishes in one round trip** (`THROUGHPUT-1b`).
 *   `publishBatch` runs the same door and the same per-epoch ordering check
 *   on every envelope, in order, inside the same serialized section, and
 *   writes the same entries through one atomic script call. It reports the
 *   published prefix and the first envelope that was not published; nothing
 *   after that one is attempted.
 * - **An outage stops publication.** ADR-003 §4: a transport outage halts
 *   trading by design. `publish` raises {@link EventBusUnavailableError} rather
 *   than buffering indefinitely, so the caller's halt path runs.
 * - **A server that stops answering is an outage, within a bound**
 *   (`OUTAGE-1`). Every command on the command connection, every read on a
 *   subscription's connection (beyond its own `waitMs`), the handshake and
 *   the courtesy `QUIT` on close are bounded by `responseTimeoutMs`
 *   (`./client.ts`). The retry flush `ioredis` performs is not enough on its
 *   own: a stopped container left an in-flight command parked forever, and
 *   the trader awaiting it hung instead of halting.
 *
 * ## What it deliberately does not do
 *
 * No dead-letter queue, no second transport, no payload interpretation, and no
 * latency claim. Handoff §9.1 sets a gateway-to-trader p99 target under 5 ms;
 * ADR-003 §5 records that **no benchmark has been run**, and nothing here
 * measures or asserts it.
 */

import { performance } from "node:perf_hooks";

import type { EventEnvelope } from "@polymarket-bot/domain";

import { encodeEnvelope } from "../envelope-codec.js";
import { assertMaxTrackedEpochs, EpochOrderTracker, parseIngestSeq } from "../epoch-order.js";
import {
  EventBusCheckpointError,
  EventBusConfigurationError,
  EventBusOrderingError,
  EventBusStateError,
  EventBusUnavailableError,
} from "../errors.js";
import { computeStreamQueueMetrics } from "../metrics.js";
import type { ConsumerLagEntry, StreamQueueMetrics } from "../metrics.js";
import { assertMaxPending, KeyedSerialQueue } from "../serial-queue.js";
import type {
  EventStreamName,
  EventSubscription,
  MarketEventTransport,
  PublishReceipt,
  RetentionPolicy,
  StreamCheckpoint,
  SubscribeOptions,
  SubscriptionStart,
  TransportId,
} from "../transport.js";
import { createCheckpoint, decodeCheckpointToken, readCheckpoint, STREAM_ORIGIN_ENTRY_ID } from "./checkpoint.js";
import type { StreamPosition } from "./checkpoint.js";
import { closeRedisClient, createRedisClient, resolveResponseTimeoutMs } from "./client.js";
import type { EventBusRedisClient, RedisConnectionOptions } from "./client.js";
import { assertConsumerId, DEFAULT_KEY_PREFIX, streamKeys } from "./keys.js";
import type { StreamKeys } from "./keys.js";
import {
  ensureStreamOrigin,
  isAcceptedPosition,
  judgePosition,
  resolvePositionJudgement,
  storeConsumerCheckpoint,
} from "./position.js";
import { RedisStreamSubscription } from "./subscription.js";
import type { SubscriptionServices } from "./subscription.js";
import { readStreamState } from "./stream-state.js";

/** Identifies checkpoints this implementation minted. */
export const REDIS_STREAMS_TRANSPORT_ID: TransportId = "redis-streams";

/** Largest retention bound this implementation accepts. */
export const MAX_RETENTION_EVENTS = 100_000_000;

/**
 * Most envelopes {@link RedisStreamsEventTransport.publishBatch} takes in one
 * call. A larger call is refused whole, before anything is attempted: it is a
 * caller defect, and one script call must stay short enough not to stall the
 * server for every other client.
 */
export const MAX_PUBLISH_BATCH_ENVELOPES = 1024;

/** The first envelope of a batch that was NOT published, and why. */
export type PublishBatchFailure = {
  /** Its position in the batch. Every envelope before it was published. */
  readonly index: number;
  /** What `publish` would have thrown for it. */
  readonly error: unknown;
};

/**
 * What {@link RedisStreamsEventTransport.publishBatch} reports.
 *
 * Exactly one of two shapes, and never anything in between: every envelope
 * was published (`failure` is `undefined` and there is one receipt per
 * envelope), or a PREFIX was published — possibly empty — and `failure`
 * names the first envelope that was not. `receipts.length === failure.index`
 * always holds, and nothing after `failure.index` was attempted.
 */
export type PublishBatchResult = {
  /** One per published envelope, in batch order: the published prefix. */
  readonly receipts: readonly PublishReceipt[];
  readonly failure: PublishBatchFailure | undefined;
};

export type RedisStreamsTransportOptions = {
  readonly connection: RedisConnectionOptions;
  /** The §9.1 bounded-retention policy, applied to every stream. */
  readonly retention: RetentionPolicy;
  /** Key namespace. Defaults to `pmb:events`. */
  readonly keyPrefix?: string;
  /** Cap on epochs each ordering cursor tracks. See `../epoch-order.ts`. */
  readonly maxTrackedEpochs?: number;
  /**
   * Publishes one stream may have queued or in flight at once. Defaults to
   * 1024.
   *
   * §8.3 requires every queue to be bounded; this is that bound for the
   * producer side. Reaching it refuses the publish rather than accepting an
   * event the transport cannot move (`../serial-queue.ts`).
   */
  readonly maxQueuedPublishes?: number;
};

type StreamContext = {
  readonly keys: StreamKeys;
  readonly order: EpochOrderTracker;
  /**
   * Serializes each epoch's check-plus-append, and bounds how much may wait.
   * See `../serial-queue.ts`.
   */
  readonly publishQueue: KeyedSerialQueue;
  /** This stream instance's marker, resolved once and then reused. */
  origin: string | undefined;
  producerBlockedTimeMs: number;
  publishFailures: number;
  retentionTrimFailures: number;
};

export class RedisStreamsEventTransport implements MarketEventTransport {
  readonly transportId: TransportId = REDIS_STREAMS_TRANSPORT_ID;
  readonly retention: RetentionPolicy;

  readonly #client: EventBusRedisClient;
  readonly #connection: RedisConnectionOptions;
  readonly #keyPrefix: string;
  readonly #maxTrackedEpochs: number | undefined;
  readonly #maxQueuedPublishes: number | undefined;
  /** `RedisConnectionOptions.responseTimeoutMs`, validated once at connect. */
  readonly #responseTimeoutMs: number;
  readonly #streams = new Map<EventStreamName, StreamContext>();
  readonly #subscriptions = new Map<number, { close(): Promise<void> }>();
  #nextSubscriptionKey = 0;
  #closed = false;

  private constructor(
    client: EventBusRedisClient,
    options: RedisStreamsTransportOptions,
    keyPrefix: string,
    responseTimeoutMs: number,
  ) {
    this.#client = client;
    this.#responseTimeoutMs = responseTimeoutMs;
    this.#connection = options.connection;
    this.#keyPrefix = keyPrefix;
    this.#maxTrackedEpochs = options.maxTrackedEpochs;
    this.#maxQueuedPublishes = options.maxQueuedPublishes;
    this.retention = { maxEvents: options.retention.maxEvents };
  }

  /** Connects and returns a ready transport. */
  static async connect(
    options: RedisStreamsTransportOptions,
  ): Promise<RedisStreamsEventTransport> {
    assertRetention(options.retention);
    if (options.maxTrackedEpochs !== undefined) {
      // Validated at connect time rather than on the first publish.
      assertMaxTrackedEpochs(options.maxTrackedEpochs);
    }
    if (options.maxQueuedPublishes !== undefined) {
      assertMaxPending(options.maxQueuedPublishes);
    }
    const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    // Validated before anything is opened: a refused bound is a configuration
    // refusal, not a connection failure.
    const responseTimeoutMs = resolveResponseTimeoutMs(options.connection);
    const client = await createRedisClient(options.connection, "pmb-event-bus", "commands");
    return new RedisStreamsEventTransport(client, options, keyPrefix, responseTimeoutMs);
  }

  /**
   * Publishes one envelope, after everything already submitted for its epoch.
   *
   * The envelope is validated first, so a caller that hands over something
   * unpublishable learns immediately rather than behind a queue. Everything
   * that touches the epoch's cursor happens inside the serialized section.
   *
   * §8.3's "producer blocked time" is measured around the **whole** of that
   * wait — the queue and the round trip — because a producer sitting behind a
   * stalled publish is blocked in exactly the sense the metric exists to
   * report. Timing only the round trip would show a transport answering in
   * milliseconds while every caller behind it waited for seconds (round-2
   * review, H1).
   */
  async publish(
    stream: EventStreamName,
    envelope: EventEnvelope<unknown>,
  ): Promise<PublishReceipt> {
    this.#assertOpen();
    const context = this.#context(stream);

    let encoded: string;
    try {
      encoded = encodeEnvelope(envelope);
    } catch (error) {
      // A refused envelope is still a publish that did not happen, so it is
      // counted — but it is not producer *blocked* time: nothing was waiting on
      // the transport, and folding validation cost into that metric would
      // report a slow transport for a caller error.
      context.publishFailures += 1;
      throw error;
    }

    const startedAt = performance.now();
    try {
      return await context.publishQueue.run(
        envelope.gatewayEpoch,
        async () => await this.#publishInEpochOrder(context, stream, envelope, encoded),
      );
    } catch (error) {
      context.publishFailures += 1;
      throw error;
    } finally {
      context.producerBlockedTimeMs += performance.now() - startedAt;
    }
  }

  /**
   * Publishes a run of envelopes in ONE round trip, with the outcome
   * consecutive {@link publish} calls would have had if the caller stopped at
   * the first failure (`THROUGHPUT-1b`).
   *
   * Not part of `MarketEventTransport` (that interface is unchanged); the
   * gateway's publisher uses it when the transport it was given has it.
   *
   * ## Same checks, same entries, same order
   *
   * - The envelope door ({@link encodeEnvelope}) runs on every envelope, in
   *   order, exactly as `publish` runs it. The first refusal ends the run
   *   there.
   * - A batch carries ONE `gatewayEpoch` (ADR-003 §2: two epochs are never
   *   merged into one apparent sequence). The first envelope of another epoch
   *   ends the run there, refused as an ordering error.
   * - Inside the epoch's serialized section — the same one `publish` uses, so
   *   a batch and a single publish can never interleave — each `ingestSeq`
   *   must advance past the previous one, starting from the epoch's cursor,
   *   exactly as `publish` checks it. The first that does not ends the run.
   * - The envelopes before the end are appended by ONE server-side script
   *   call (`PUBLISH_BATCH_SCRIPT`), atomically: the entries are the ones the
   *   same number of single publishes would have written, the ordinals are
   *   contiguous, and the retention bound is applied exactly, once, after.
   *
   * ## Failure is a position, never a guess
   *
   * The result never leaves a caller wondering which envelopes landed. Every
   * failure is reported as the index of the first envelope NOT published;
   * everything before it IS in the stream and has a receipt, and nothing after
   * it was attempted:
   *
   * - a door, epoch or ordering refusal at index `k`: envelopes `0..k-1` are
   *   published (in one script call), `k` is the failure;
   * - a script refusal, an unreachable server, or a queue refusal: the script
   *   either ran completely or not at all (it undoes its own appends on
   *   failure), so NOTHING of the run was published, and the failure is at
   *   index 0.
   *
   * The one ambiguity is the one `publish` already has: a reply that never
   * arrives. A script that ran on the server after the caller stopped waiting
   * (the response deadline, a severed connection) may have published the
   * run, and the call reports index 0 — a publisher that halts on it has at
   * most that run in the stream after its boundary, as it had at most one
   * envelope before.
   *
   * It never rejects: every outcome, including a closed transport, is a
   * result.
   */
  async publishBatch(
    stream: EventStreamName,
    envelopes: readonly EventEnvelope<unknown>[],
  ): Promise<PublishBatchResult> {
    if (envelopes.length === 0) {
      return { receipts: [], failure: undefined };
    }
    let context: StreamContext;
    try {
      this.#assertOpen();
      context = this.#context(stream);
    } catch (error) {
      return { receipts: [], failure: { index: 0, error } };
    }
    if (envelopes.length > MAX_PUBLISH_BATCH_ENVELOPES) {
      context.publishFailures += 1;
      return {
        receipts: [],
        failure: {
          index: 0,
          error: new EventBusConfigurationError(
            `a batch publishes at most ${String(MAX_PUBLISH_BATCH_ENVELOPES)} envelopes; ` +
              `${String(envelopes.length)} were offered and none was attempted`,
            { stream, batchSize: envelopes.length },
          ),
        },
      };
    }

    // The door, in order, outside the serialized section as in `publish`: a
    // caller that hands over something unpublishable learns it without
    // waiting behind the queue. Stops at the first refusal.
    const encoded: string[] = [];
    let refusal: PublishBatchFailure | undefined;
    let epoch: string | undefined;
    for (let index = 0; index < envelopes.length; index += 1) {
      const envelope = envelopes[index] as EventEnvelope<unknown>;
      let wire: string;
      try {
        wire = encodeEnvelope(envelope);
      } catch (error) {
        refusal = { index, error };
        break;
      }
      if (epoch === undefined) {
        epoch = envelope.gatewayEpoch;
      } else if (envelope.gatewayEpoch !== epoch) {
        refusal = {
          index,
          error: new EventBusOrderingError(
            "a batch publishes one gatewayEpoch; an envelope of another epoch ends it " +
              "(ADR-003 §2: two epochs are never merged into one apparent sequence)",
            {
              gatewayEpoch: envelope.gatewayEpoch,
              batchEpoch: epoch,
              ingestSeq: envelope.ingestSeq,
              eventId: envelope.eventId,
            },
          ),
        };
        break;
      }
      encoded.push(wire);
    }
    if (epoch === undefined || encoded.length === 0) {
      // A refusal of the very first envelope: nothing waited on the
      // transport, so, as in `publish`, no producer blocked time.
      context.publishFailures += 1;
      return { receipts: [], failure: refusal ?? { index: 0, error: new Error("empty batch") } };
    }

    const batchEpoch = epoch;
    const startedAt = performance.now();
    try {
      return await context.publishQueue.run(
        batchEpoch,
        async () =>
          await this.#publishBatchInEpochOrder(context, stream, batchEpoch, envelopes, encoded, refusal),
      );
    } catch (error) {
      // Only the queue's own admission refusal reaches here (the section
      // itself returns every outcome): nothing was attempted.
      context.publishFailures += 1;
      return { receipts: [], failure: { index: 0, error } };
    } finally {
      context.producerBlockedTimeMs += performance.now() - startedAt;
    }
  }

  /**
   * The serialized half of {@link publishBatch}. Returns every outcome;
   * counts exactly one publish failure when it reports one, as `publish`
   * counts one per failed call.
   */
  async #publishBatchInEpochOrder(
    context: StreamContext,
    stream: EventStreamName,
    epoch: string,
    envelopes: readonly EventEnvelope<unknown>[],
    encoded: readonly string[],
    doorRefusal: PublishBatchFailure | undefined,
  ): Promise<PublishBatchResult> {
    const failed = (failure: PublishBatchFailure): PublishBatchResult => {
      context.publishFailures += 1;
      return { receipts: [], failure };
    };
    try {
      // Re-checked here, as in `publish`: the transport may have closed while
      // this batch waited behind another publish.
      this.#assertOpen();
    } catch (error) {
      return failed({ index: 0, error });
    }

    // The ordering check `publish` makes, envelope by envelope, from the
    // epoch's cursor. The first non-advancing identity ends the run.
    let submitted = encoded.length;
    let failure = doorRefusal;
    let previous = context.order.lastIngestSeq(epoch);
    for (let index = 0; index < encoded.length; index += 1) {
      const envelope = envelopes[index] as EventEnvelope<unknown>;
      const current = parseIngestSeq(envelope.ingestSeq);
      if (previous !== undefined && current <= previous) {
        submitted = index;
        failure = {
          index,
          error: new EventBusOrderingError(
            "ingestSeq did not advance within its gatewayEpoch; the event has no position in the stream " +
              "(ADR-002 §2)",
            {
              gatewayEpoch: envelope.gatewayEpoch,
              previousIngestSeq: previous.toString(),
              ingestSeq: envelope.ingestSeq,
              eventId: envelope.eventId,
            },
          ),
        };
        break;
      }
      previous = current;
    }
    const first = envelopes[0] as EventEnvelope<unknown>;
    if (submitted === 0) {
      return failed(failure ?? { index: 0, error: new Error("empty batch") });
    }

    let reply: string[];
    try {
      reply = await this.#client.ebPublishBatch(
        context.keys.events,
        context.keys.published,
        String(this.retention.maxEvents),
        ...encoded.slice(0, submitted),
      );
    } catch (cause) {
      return failed({
        index: 0,
        error: new EventBusUnavailableError(
          "could not publish to the event transport; publication stops and trading halts (ADR-003 §4)",
          { stream, eventId: first.eventId, batchSize: submitted },
          cause,
        ),
      });
    }

    let outcome: PublishBatchOutcome;
    try {
      outcome = readPublishBatchReply(reply, stream, first.eventId, submitted);
    } catch (error) {
      return failed({ index: 0, error });
    }
    if (outcome.trimFailed) {
      // As in `publish`: the run is published and its ordinals are
      // consistent; only the bound was not applied. Counted, not raised.
      context.retentionTrimFailures += 1;
    }
    // Recorded only after the run is in the stream, as in `publish`. The last
    // identity of the run is the cursor: the run advanced strictly.
    context.order.observe(epoch, (envelopes[submitted - 1] as EventEnvelope<unknown>).ingestSeq);
    const receipts: PublishReceipt[] = [];
    for (let index = 0; index < submitted; index += 1) {
      receipts.push({ stream, sequence: outcome.firstSequence + index });
    }
    if (failure !== undefined) {
      context.publishFailures += 1;
    }
    return { receipts, failure };
  }

  async #publishInEpochOrder(
    context: StreamContext,
    stream: EventStreamName,
    envelope: EventEnvelope<unknown>,
    encoded: string,
  ): Promise<PublishReceipt> {
    // Re-checked here rather than only at entry: a publish can wait behind
    // another one, and the transport may have been closed in between.
    this.#assertOpen();
    this.#assertOrderAdvances(context, envelope);

    let reply: string[];
    try {
      reply = await this.#client.ebPublish(
        context.keys.events,
        context.keys.published,
        String(this.retention.maxEvents),
        encoded,
      );
    } catch (cause) {
      throw new EventBusUnavailableError(
        "could not publish to the event transport; publication stops and trading halts (ADR-003 §4)",
        { stream, eventId: envelope.eventId },
        cause,
      );
    }

    const { sequence, trimFailed } = readPublishReply(reply, stream, envelope.eventId);
    if (trimFailed) {
      // The event is published and its ordinal is consistent; only the bound
      // was not applied. Counted rather than raised, because telling the caller
      // this publish failed would invite a duplicate of an event that landed.
      context.retentionTrimFailures += 1;
    }
    // Recorded only after the event is in the stream, so a caller that
    // retries a failed publish with the same `ingestSeq` is not refused for
    // an event that never landed. Nothing else can interleave here: this whole
    // method runs alone for its epoch.
    context.order.observe(envelope.gatewayEpoch, envelope.ingestSeq);
    return { stream, sequence };
  }

  async subscribe<TPayload = unknown>(
    options: SubscribeOptions,
  ): Promise<EventSubscription<TPayload>> {
    this.#assertOpen();
    assertConsumerId(options.consumerId);
    const context = this.#context(options.stream);
    const origin = await this.#origin(context, options.stream);
    const start: SubscriptionStart = options.start ?? {
      at: "stored-checkpoint",
      whenMissing: "oldest-retained",
    };

    const resolved = await this.#resolveStart(context.keys, options.stream, options.consumerId, start);
    const client = await createRedisClient(
      this.#connection,
      `pmb-event-bus-${options.consumerId}`,
      "blocking-reads",
    );
    this.#nextSubscriptionKey += 1;
    const registryKey = this.#nextSubscriptionKey;

    let subscription: RedisStreamSubscription<TPayload>;
    try {
      subscription = new RedisStreamSubscription<TPayload>({
        transportId: this.transportId,
        stream: options.stream,
        consumerId: options.consumerId,
        streamKey: context.keys.events,
        origin,
        client,
        services: this.#services(context.keys, options.stream, origin),
        startPosition: resolved.position,
        responseTimeoutMs: this.#responseTimeoutMs,
        ...(resolved.checkpoint === undefined ? {} : { startCheckpoint: resolved.checkpoint }),
        ...(this.#maxTrackedEpochs === undefined
          ? {}
          : { maxTrackedEpochs: this.#maxTrackedEpochs }),
        onClosed: () => {
          this.#subscriptions.delete(registryKey);
        },
      });
      await subscription.primeContinuity();
    } catch (error) {
      await closeRedisClient(client, this.#responseTimeoutMs);
      throw error;
    }

    this.#subscriptions.set(registryKey, subscription);
    return subscription;
  }

  async streamMetrics(stream: EventStreamName): Promise<StreamQueueMetrics> {
    this.#assertOpen();
    const context = this.#context(stream);
    return await this.#queueMetrics(context.keys, stream);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    await Promise.all(subscriptions.map(async (subscription) => subscription.close()));
    await closeRedisClient(this.#client, this.#responseTimeoutMs);
  }

  #services(keys: StreamKeys, stream: EventStreamName, origin: string): SubscriptionServices {
    return {
      readStreamState: async () => await readStreamState(this.#client, keys),
      storeCheckpoint: async (consumerId, position) =>
        await storeConsumerCheckpoint(this.#client, keys, stream, consumerId, origin, position),
      queueMetrics: async () => await this.#queueMetrics(keys, stream),
    };
  }

  /**
   * Reports the §8.3 metric set for one stream.
   *
   * A stored position that cannot be turned into a usable one — taken in a
   * different stream instance, written by something else, or refused by the
   * server's own judgement — is counted rather than either skipped or turned
   * into a lag number that means nothing.
   *
   * The publish-queue numbers are taken **before** the server round trips
   * below, so they describe the moment the caller asked rather than the moment
   * the server answered; on a slow transport those are not the same moment, and
   * the depth at the slow moment is the one worth reporting.
   */
  async #queueMetrics(keys: StreamKeys, stream: EventStreamName): Promise<StreamQueueMetrics> {
    const context = this.#context(stream);
    const publishQueueDepth = context.publishQueue.pendingCount;
    const publishQueueMaxDepth = context.publishQueue.maxPending;
    const oldestQueuedPublishAgeMs = context.publishQueue.oldestPendingAgeMs();

    const state = await readStreamState(this.#client, keys);
    let stored: Record<string, string>;
    try {
      stored = await this.#client.hgetall(keys.checkpoints);
    } catch (cause) {
      throw new EventBusUnavailableError(
        "could not read stored consumer checkpoints",
        { stream },
        cause,
      );
    }

    const consumerLag: ConsumerLagEntry[] = [];
    let unreadableCheckpoints = 0;
    for (const [consumerId, token] of Object.entries(stored)) {
      const position = readStoredPosition(token, state.origin);
      if (position === undefined || state.origin === undefined) {
        unreadableCheckpoints += 1;
        continue;
      }
      // Judged by the server, with the same script `subscribe` uses. Decoding
      // the token and matching the marker proves only that the value came from
      // this stream instance — a position naming an entry that never existed,
      // or one paired with the wrong ordinal, passes both and is still a
      // position no consumer can resume from (round-2 review, L1).
      const judgement = await resolvePositionJudgement(
        this.#client,
        keys,
        stream,
        state.origin,
        position,
      );
      if (!isAcceptedPosition(judgement.verdict)) {
        unreadableCheckpoints += 1;
        continue;
      }
      consumerLag.push({
        consumerId,
        lag: Math.max(0, state.publishedTotal - position.sequence),
      });
    }
    consumerLag.sort((left, right) => (left.consumerId < right.consumerId ? -1 : 1));

    return computeStreamQueueMetrics({
      stream,
      publishedTotal: state.publishedTotal,
      currentDepth: state.depth,
      maximumDepth: this.retention.maxEvents,
      oldestEntryAtMs: state.oldestEntryAtMs,
      nowMs: state.serverTimeMs,
      producerBlockedTimeMs: context.producerBlockedTimeMs,
      publishFailures: context.publishFailures,
      publishQueueDepth,
      publishQueueMaxDepth,
      oldestQueuedPublishAgeMs,
      retentionTrimFailures: context.retentionTrimFailures,
      consumerLag,
      unreadableCheckpoints,
    });
  }

  /** This stream instance's marker, minted on first use and then reused. */
  async #origin(context: StreamContext, stream: EventStreamName): Promise<string> {
    if (context.origin !== undefined) {
      return context.origin;
    }
    const origin = await ensureStreamOrigin(this.#client, context.keys, stream);
    context.origin = origin;
    return origin;
  }

  async #resolveStart(
    keys: StreamKeys,
    stream: EventStreamName,
    consumerId: string,
    start: SubscriptionStart,
  ): Promise<{ readonly position: StreamPosition; readonly checkpoint?: StreamCheckpoint }> {
    if (start.at === "checkpoint") {
      const bound = readCheckpoint(this.transportId, stream, start.checkpoint);
      return await this.#resumeAt(keys, stream, bound.origin, bound);
    }

    if (start.at === "stored-checkpoint") {
      const token = await this.#readStoredCheckpoint(keys, stream, consumerId);
      if (token !== undefined) {
        const bound = decodeCheckpointToken(token);
        return await this.#resumeAt(keys, stream, bound.origin, bound);
      }
      if (start.whenMissing === "fail") {
        throw new EventBusCheckpointError(
          "no stored checkpoint exists for this consumer and `whenMissing` is `fail`",
          { stream, consumerId },
        );
      }
      return { position: await this.#positionAt(keys, start.whenMissing) };
    }

    // `oldest-retained` and `newest` are derived from the stream's own state
    // rather than from a token, so there is nothing to judge: they cannot name
    // a position the stream does not hold.
    return { position: await this.#positionAt(keys, start.at) };
  }

  /**
   * Turns a token's claimed position into a real one, or refuses it.
   *
   * The marker checked is the **token's**, not this transport's: that is what
   * makes a checkpoint from another server, another key namespace, or a stream
   * that was destroyed and recreated a refusal rather than a plausible-looking
   * place to resume from.
   */
  async #resumeAt(
    keys: StreamKeys,
    stream: EventStreamName,
    origin: string,
    position: StreamPosition,
  ): Promise<{ readonly position: StreamPosition; readonly checkpoint: StreamCheckpoint }> {
    await judgePosition(this.#client, keys, stream, origin, position);
    const resumed: StreamPosition = { entryId: position.entryId, sequence: position.sequence };
    return { position: resumed, checkpoint: createCheckpoint(this.transportId, stream, origin, resumed) };
  }

  async #readStoredCheckpoint(
    keys: StreamKeys,
    stream: EventStreamName,
    consumerId: string,
  ): Promise<string | undefined> {
    try {
      return (await this.#client.hget(keys.checkpoints, consumerId)) ?? undefined;
    } catch (cause) {
      throw new EventBusUnavailableError(
        "could not read the stored consumer checkpoint",
        { stream, consumerId },
        cause,
      );
    }
  }

  /**
   * Turns `oldest-retained` / `newest` into a concrete position.
   *
   * `newest` is offered because a consumer's very first start has no earlier
   * position to resume, and it is never reached by omission: the default start
   * resumes the stored checkpoint and, when there is none, replays what
   * retention still holds. ADR-003 §3.4 requires a restart to resume from a
   * known position rather than from "now", so choosing `newest` is always the
   * caller's explicit statement that it has no history to preserve.
   */
  async #positionAt(
    keys: StreamKeys,
    at: "oldest-retained" | "newest",
  ): Promise<StreamPosition> {
    const state = await readStreamState(this.#client, keys);
    if (at === "newest") {
      return {
        entryId: state.lastEntryId ?? STREAM_ORIGIN_ENTRY_ID,
        sequence: state.publishedTotal,
      };
    }
    if (state.firstSequence === undefined) {
      return {
        entryId: state.lastEntryId ?? STREAM_ORIGIN_ENTRY_ID,
        sequence: state.publishedTotal,
      };
    }
    return { entryId: STREAM_ORIGIN_ENTRY_ID, sequence: state.firstSequence - 1 };
  }

  #assertOrderAdvances(context: StreamContext, envelope: EventEnvelope<unknown>): void {
    const previous = context.order.lastIngestSeq(envelope.gatewayEpoch);
    if (previous === undefined) {
      return;
    }
    const current = parseIngestSeq(envelope.ingestSeq);
    if (current > previous) {
      return;
    }
    throw new EventBusOrderingError(
      "ingestSeq did not advance within its gatewayEpoch; the event has no position in the stream " +
        "(ADR-002 §2)",
      {
        gatewayEpoch: envelope.gatewayEpoch,
        previousIngestSeq: previous.toString(),
        ingestSeq: envelope.ingestSeq,
        eventId: envelope.eventId,
      },
    );
  }

  #context(stream: EventStreamName): StreamContext {
    const existing = this.#streams.get(stream);
    if (existing !== undefined) {
      return existing;
    }
    const created: StreamContext = {
      keys: streamKeys(this.#keyPrefix, stream),
      order: new EpochOrderTracker(
        this.#maxTrackedEpochs === undefined ? {} : { maxTrackedEpochs: this.#maxTrackedEpochs },
      ),
      publishQueue: new KeyedSerialQueue(
        this.#maxQueuedPublishes === undefined ? {} : { maxPending: this.#maxQueuedPublishes },
      ),
      origin: undefined,
      producerBlockedTimeMs: 0,
      publishFailures: 0,
      retentionTrimFailures: 0,
    };
    this.#streams.set(stream, created);
    return created;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new EventBusStateError("this transport is closed", {});
    }
  }
}

function assertRetention(retention: RetentionPolicy): void {
  if (
    !Number.isSafeInteger(retention.maxEvents) ||
    retention.maxEvents < 1 ||
    retention.maxEvents > MAX_RETENTION_EVENTS
  ) {
    throw new EventBusConfigurationError(
      `retention.maxEvents must be an integer in [1, ${String(MAX_RETENTION_EVENTS)}], received ` +
        String(retention.maxEvents),
      { maxEvents: retention.maxEvents },
    );
  }
}

/**
 * Reads a stored position, or reports that it cannot be read.
 *
 * `undefined` covers both a value this transport did not write and one taken in
 * a different stream instance. Neither is a lag number, and reporting either as
 * one would be an invented measurement.
 */
function readStoredPosition(
  token: string,
  origin: string | undefined,
): StreamPosition | undefined {
  if (origin === undefined) {
    return undefined;
  }
  try {
    const position = decodeCheckpointToken(token);
    return position.origin === origin ? position : undefined;
  } catch {
    return undefined;
  }
}

/** What the publish script reported about one accepted publish. */
export type PublishOutcome = {
  readonly sequence: number;
  /**
   * True when the event landed but the retention bound could not be applied
   * afterwards. The publish still succeeded (`./scripts.ts`).
   */
  readonly trimFailed: boolean;
};

/**
 * Reads the publish script's reply.
 *
 * Every refusal it can return happened **before** anything was mutated, or was
 * compensated (`./scripts.ts`): the caller still holds an event that is not in
 * the stream, and no publication ordinal was consumed for it.
 */
export function readPublishReply(
  reply: readonly string[],
  stream: EventStreamName,
  eventId: string,
): PublishOutcome {
  const [status, first, second, third] = reply;
  if (status === "err") {
    throw publishRefusal(first ?? "unknown", second ?? "", stream, eventId);
  }
  if (status !== "ok" || second === undefined) {
    throw new EventBusUnavailableError("the transport did not return a publication ordinal", {
      stream,
      eventId,
    });
  }
  const sequence = Number(second);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new EventBusUnavailableError(
      "the stream's publication counter has exceeded what this process can represent exactly",
      { stream, sequence: second },
    );
  }
  return { sequence, trimFailed: third !== undefined && third !== "" };
}

/** What the batch publish script reported about one accepted run. */
export type PublishBatchOutcome = {
  /** The first envelope's ordinal; the run's are contiguous from it. */
  readonly firstSequence: number;
  /** As in {@link PublishOutcome}: landed, but the bound was not applied. */
  readonly trimFailed: boolean;
};

/**
 * Reads the batch publish script's reply for a run of `count` envelopes.
 *
 * A refusal means NOTHING of the run was appended (`./scripts.ts`): it was
 * refused before any mutation, or its appends were undone. An `ok` must carry
 * exactly `count` contiguous ordinals; anything else is treated as an
 * unreadable reply, which the caller halts on.
 */
export function readPublishBatchReply(
  reply: readonly string[],
  stream: EventStreamName,
  eventId: string,
  count: number,
): PublishBatchOutcome {
  const [status, first, second, third] = reply;
  if (status === "err") {
    throw publishRefusal(first ?? "unknown", second ?? "", stream, eventId);
  }
  if (status !== "ok" || first === undefined || second === undefined) {
    throw new EventBusUnavailableError("the transport did not return publication ordinals", {
      stream,
      eventId,
    });
  }
  const firstSequence = Number(first);
  const lastSequence = Number(second);
  if (
    !Number.isSafeInteger(firstSequence) ||
    !Number.isSafeInteger(lastSequence) ||
    firstSequence < 1
  ) {
    throw new EventBusUnavailableError(
      "the stream's publication counter has exceeded what this process can represent exactly",
      { stream, firstSequence: first, lastSequence: second },
    );
  }
  if (lastSequence - firstSequence + 1 !== count) {
    throw new EventBusUnavailableError(
      "the transport returned publication ordinals that do not cover the published run",
      { stream, eventId, firstSequence: first, lastSequence: second, count },
    );
  }
  return { firstSequence, trimFailed: third !== undefined && third !== "" };
}

function publishRefusal(
  code: string,
  detail: string,
  stream: EventStreamName,
  eventId: string,
): EventBusUnavailableError {
  if (code === "counter-ceiling") {
    return new EventBusUnavailableError(
      "the stream's publication counter has exceeded what this process can represent exactly; " +
        "nothing was appended",
      { stream, eventId, sequence: detail },
    );
  }
  return new EventBusUnavailableError(
    "could not publish to the event transport; publication stops and trading halts (ADR-003 §4)",
    { stream, eventId, reason: code, detail },
  );
}
