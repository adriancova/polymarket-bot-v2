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
 *   all. Two epochs stay two sequences: each envelope carries its own
 *   `gatewayEpoch` and the tracker keeps one cursor per epoch (ADR-003 §2).
 * - **No silent drop.** Publication either lands in the stream or throws a
 *   typed error (§8.3). The stream never refuses an event for being full;
 *   retention removes the oldest instead, and every consumer that had not read
 *   those events is told so as a hard-resync condition (ADR-003 §3.3).
 * - **An outage stops publication.** ADR-003 §4: a transport outage halts
 *   trading by design. `publish` raises {@link EventBusUnavailableError} rather
 *   than buffering indefinitely, so the caller's halt path runs.
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
import { closeRedisClient, createRedisClient } from "./client.js";
import type { EventBusRedisClient, RedisConnectionOptions } from "./client.js";
import { assertConsumerId, DEFAULT_KEY_PREFIX, streamKeys } from "./keys.js";
import type { StreamKeys } from "./keys.js";
import { RedisStreamSubscription } from "./subscription.js";
import type { SubscriptionServices } from "./subscription.js";
import { readStreamState } from "./stream-state.js";

/** Identifies checkpoints this implementation minted. */
export const REDIS_STREAMS_TRANSPORT_ID: TransportId = "redis-streams";

/** Largest retention bound this implementation accepts. */
export const MAX_RETENTION_EVENTS = 100_000_000;

export type RedisStreamsTransportOptions = {
  readonly connection: RedisConnectionOptions;
  /** The §9.1 bounded-retention policy, applied to every stream. */
  readonly retention: RetentionPolicy;
  /** Key namespace. Defaults to `pmb:events`. */
  readonly keyPrefix?: string;
  /** Cap on epochs each ordering cursor tracks. See `../epoch-order.ts`. */
  readonly maxTrackedEpochs?: number;
};

type StreamContext = {
  readonly keys: StreamKeys;
  readonly order: EpochOrderTracker;
  producerBlockedTimeMs: number;
  publishFailures: number;
};

export class RedisStreamsEventTransport implements MarketEventTransport {
  readonly transportId: TransportId = REDIS_STREAMS_TRANSPORT_ID;
  readonly retention: RetentionPolicy;

  readonly #client: EventBusRedisClient;
  readonly #connection: RedisConnectionOptions;
  readonly #keyPrefix: string;
  readonly #maxTrackedEpochs: number | undefined;
  readonly #streams = new Map<EventStreamName, StreamContext>();
  readonly #subscriptions = new Map<number, { close(): Promise<void> }>();
  #nextSubscriptionKey = 0;
  #closed = false;

  private constructor(
    client: EventBusRedisClient,
    options: RedisStreamsTransportOptions,
    keyPrefix: string,
  ) {
    this.#client = client;
    this.#connection = options.connection;
    this.#keyPrefix = keyPrefix;
    this.#maxTrackedEpochs = options.maxTrackedEpochs;
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
    const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    const client = await createRedisClient(options.connection, "pmb-event-bus");
    return new RedisStreamsEventTransport(client, options, keyPrefix);
  }

  async publish(
    stream: EventStreamName,
    envelope: EventEnvelope<unknown>,
  ): Promise<PublishReceipt> {
    this.#assertOpen();
    const context = this.#context(stream);

    try {
      const encoded = encodeEnvelope(envelope);
      this.#assertOrderAdvances(context, envelope);

      const startedAt = performance.now();
      let reply: [string, string];
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
      } finally {
        context.producerBlockedTimeMs += performance.now() - startedAt;
      }

      const sequence = readPublishedSequence(reply, stream);
      // Recorded only after the event is in the stream, so a caller that
      // retries a failed publish with the same `ingestSeq` is not refused for
      // an event that never landed.
      context.order.observe(envelope.gatewayEpoch, envelope.ingestSeq);
      return { stream, sequence };
    } catch (error) {
      context.publishFailures += 1;
      throw error;
    }
  }

  async subscribe<TPayload = unknown>(
    options: SubscribeOptions,
  ): Promise<EventSubscription<TPayload>> {
    this.#assertOpen();
    assertConsumerId(options.consumerId);
    const context = this.#context(options.stream);
    const start: SubscriptionStart = options.start ?? {
      at: "stored-checkpoint",
      whenMissing: "oldest-retained",
    };

    const resolved = await this.#resolveStart(context.keys, options.stream, options.consumerId, start);
    const client = await createRedisClient(this.#connection, `pmb-event-bus-${options.consumerId}`);
    this.#nextSubscriptionKey += 1;
    const registryKey = this.#nextSubscriptionKey;

    let subscription: RedisStreamSubscription<TPayload>;
    try {
      subscription = new RedisStreamSubscription<TPayload>({
        transportId: this.transportId,
        stream: options.stream,
        consumerId: options.consumerId,
        streamKey: context.keys.events,
        client,
        services: this.#services(context.keys, options.stream),
        startPosition: resolved.position,
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
      await closeRedisClient(client);
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
    await closeRedisClient(this.#client);
  }

  #services(keys: StreamKeys, stream: EventStreamName): SubscriptionServices {
    return {
      readStreamState: async () => await readStreamState(this.#client, keys),
      storeCheckpoint: async (consumerId, token) => {
        try {
          await this.#client.hset(keys.checkpoints, consumerId, token);
        } catch (cause) {
          throw new EventBusUnavailableError(
            "could not record the consumer checkpoint",
            { stream, consumerId },
            cause,
          );
        }
      },
      queueMetrics: async () => await this.#queueMetrics(keys, stream),
    };
  }

  async #queueMetrics(keys: StreamKeys, stream: EventStreamName): Promise<StreamQueueMetrics> {
    const context = this.#context(stream);
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
    for (const [consumerId, token] of Object.entries(stored)) {
      const position = decodeCheckpointToken(token);
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
      consumerLag,
    });
  }

  async #resolveStart(
    keys: StreamKeys,
    stream: EventStreamName,
    consumerId: string,
    start: SubscriptionStart,
  ): Promise<{ readonly position: StreamPosition; readonly checkpoint?: StreamCheckpoint }> {
    if (start.at === "checkpoint") {
      const position = readCheckpoint(this.transportId, stream, start.checkpoint);
      return { position, checkpoint: createCheckpoint(this.transportId, stream, position) };
    }

    if (start.at === "stored-checkpoint") {
      const token = await this.#readStoredCheckpoint(keys, stream, consumerId);
      if (token !== undefined) {
        const position = decodeCheckpointToken(token);
        return { position, checkpoint: createCheckpoint(this.transportId, stream, position) };
      }
      if (start.whenMissing === "fail") {
        throw new EventBusCheckpointError(
          "no stored checkpoint exists for this consumer and `whenMissing` is `fail`",
          { stream, consumerId },
        );
      }
      return { position: await this.#positionAt(keys, start.whenMissing) };
    }

    return { position: await this.#positionAt(keys, start.at) };
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
   * position to resume, and is never a default: ADR-003 §3.4 requires a restart
   * to resume from a known position rather than from "now", so choosing it is
   * always the caller's explicit statement that it has no history to preserve.
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
      producerBlockedTimeMs: 0,
      publishFailures: 0,
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

function readPublishedSequence(reply: readonly string[], stream: EventStreamName): number {
  const raw = reply[1];
  if (raw === undefined) {
    throw new EventBusUnavailableError("the transport did not return a publication ordinal", {
      stream,
    });
  }
  const sequence = Number(raw);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new EventBusUnavailableError(
      "the stream's publication counter has exceeded what this process can represent exactly",
      { stream, sequence: raw },
    );
  }
  return sequence;
}
