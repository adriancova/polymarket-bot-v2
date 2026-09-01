/**
 * An in-memory `MarketEventTransport` with failure injection.
 *
 * Implements the WP-060 transport interface for offline tests: acceptance 4
 * ("Redis outage stops publication but not WAL recording") is tested against
 * this fake's failure injection, not against a real Redis — the compose
 * fragment carries the real one for local operation, and the event-bus
 * package's own Testcontainers suite covers the Redis implementation.
 *
 * Publication-side fidelity that matters for the gateway's obligations:
 *
 * - envelopes are validated against the frozen domain envelope schema, as the
 *   real transport validates them;
 * - a non-advancing `(gatewayEpoch, ingestSeq)` is refused, as the real
 *   publisher refuses one (ADR-002 §2);
 * - `setUnavailable()` makes every publish throw `EventBusUnavailableError`;
 *   `failNextPublishWithQueueFull()` throws the `EVENT_BUS_PUBLISH_QUEUE_FULL`
 *   subclass exactly once — the two §4.2/§8.3 failure shapes the gateway must
 *   halt on.
 *
 * The consumer side implements enough for tests that read back what the
 * gateway published; hard-resync conditions are out of scope here (the
 * gateway only publishes).
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import { UnknownPayloadEventEnvelopeSchema } from "@polymarket-bot/domain";
import type {
  EventStreamName,
  EventSubscription,
  MarketEventTransport,
  PublishReceipt,
  ReceiveResult,
  RetentionPolicy,
  StreamQueueMetrics,
  SubscribeOptions,
} from "@polymarket-bot/event-bus";
import {
  EventBusEnvelopeError,
  EventBusOrderingError,
  EventBusPublishQueueFullError,
  EventBusStateError,
  EventBusUnavailableError,
} from "@polymarket-bot/event-bus";

interface StoredEvent {
  readonly sequence: number;
  readonly envelope: EventEnvelope<unknown>;
}

export class MemoryEventTransport implements MarketEventTransport {
  readonly transportId = "memory-test-transport";
  readonly retention: RetentionPolicy;

  readonly #streams = new Map<EventStreamName, StoredEvent[]>();
  readonly #cursorByEpoch = new Map<string, bigint>();
  #sequence = 0;
  #unavailable = false;
  #failNextQueueFull = false;
  #closed = false;
  #beforePublish: ((envelope: EventEnvelope<unknown>) => void) | undefined;

  constructor(retention: RetentionPolicy = { maxEvents: 10_000 }) {
    this.retention = retention;
  }

  /**
   * Observes the exact moment a publish is attempted.
   *
   * This is what makes acceptance 1 ("raw frame is enqueued before normalized
   * publication") an ORDERING assertion rather than an inference: the hook
   * runs inside `publish`, so a test can read the WAL's accepted-frame count
   * at that instant and prove the enqueue already happened.
   */
  setPublishObserver(observer: (envelope: EventEnvelope<unknown>) => void): void {
    this.#beforePublish = observer;
  }

  /** Every publish from now on throws `EventBusUnavailableError`. */
  setUnavailable(unavailable: boolean): void {
    this.#unavailable = unavailable;
  }

  /** The next publish throws `EventBusPublishQueueFullError`, once. */
  failNextPublishWithQueueFull(): void {
    this.#failNextQueueFull = true;
  }

  /** Everything published to a stream, in publication order. */
  published(stream: EventStreamName): readonly EventEnvelope<unknown>[] {
    return (this.#streams.get(stream) ?? []).map((stored) => stored.envelope);
  }

  publish(
    stream: EventStreamName,
    envelope: EventEnvelope<unknown>,
  ): Promise<PublishReceipt> {
    this.#beforePublish?.(envelope);
    if (this.#closed) {
      return Promise.reject(new EventBusStateError("the transport is closed"));
    }
    if (this.#failNextQueueFull) {
      this.#failNextQueueFull = false;
      return Promise.reject(
        new EventBusPublishQueueFullError("the publish queue is full (injected)", {
          stream,
        }),
      );
    }
    if (this.#unavailable) {
      return Promise.reject(
        new EventBusUnavailableError("the transport is unreachable (injected)", { stream }),
      );
    }
    const parsed = UnknownPayloadEventEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      return Promise.reject(
        new EventBusEnvelopeError("the envelope failed the frozen domain schema", {
          issues: parsed.error.issues.length,
        }),
      );
    }
    const cursor = this.#cursorByEpoch.get(envelope.gatewayEpoch) ?? 0n;
    const seq = BigInt(envelope.ingestSeq);
    if (seq <= cursor) {
      return Promise.reject(
        new EventBusOrderingError("non-advancing (gatewayEpoch, ingestSeq)", {
          gatewayEpoch: envelope.gatewayEpoch,
          ingestSeq: envelope.ingestSeq,
        }),
      );
    }
    this.#cursorByEpoch.set(envelope.gatewayEpoch, seq);
    this.#sequence += 1;
    const events = this.#streams.get(stream) ?? [];
    events.push({ sequence: this.#sequence, envelope });
    while (events.length > this.retention.maxEvents) {
      events.shift();
    }
    this.#streams.set(stream, events);
    return Promise.resolve({ stream, sequence: this.#sequence });
  }

  subscribe<TPayload = unknown>(
    options: SubscribeOptions,
  ): Promise<EventSubscription<TPayload>> {
    const events = () => this.#streams.get(options.stream) ?? [];
    let position = 0;
    const subscription: EventSubscription<TPayload> = {
      stream: options.stream,
      consumerId: options.consumerId,
      receive: (receiveOptions): Promise<ReceiveResult<TPayload>> => {
        const max = receiveOptions?.maxEvents ?? 128;
        const batch = events().slice(position, position + max);
        if (batch.length === 0) {
          return Promise.resolve({ status: "idle" });
        }
        position += batch.length;
        return Promise.resolve({
          status: "events",
          events: batch.map((stored) => ({
            envelope: stored.envelope as EventEnvelope<TPayload>,
            checkpoint: {
              transport: this.transportId,
              stream: options.stream,
              token: String(stored.sequence),
            },
          })),
        });
      },
      checkpoint: () => Promise.resolve(),
      lastCheckpoint: () => undefined,
      pendingResync: () => undefined,
      acknowledgeHardResync: () =>
        Promise.reject(new EventBusStateError("no resync condition is pending")),
      metrics: () => Promise.reject(new EventBusStateError("not modelled by the memory fake")),
      close: () => Promise.resolve(),
    };
    return Promise.resolve(subscription);
  }

  streamMetrics(stream: EventStreamName): Promise<StreamQueueMetrics> {
    const events = this.#streams.get(stream) ?? [];
    return Promise.resolve({
      stream,
      currentDepth: events.length,
      maximumDepth: this.retention.maxEvents,
      oldestMessageAgeMs: 0,
      messagesDropped: 0,
      producerBlockedTimeMs: 0,
      publishQueueDepth: 0,
      publishQueueMaxDepth: 0,
      oldestQueuedPublishAgeMs: 0,
      consumerLag: [],
      publishedTotal: this.#sequence,
      publishFailures: 0,
      retentionTrimFailures: 0,
      unreadableCheckpoints: 0,
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
