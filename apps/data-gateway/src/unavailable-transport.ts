/**
 * The transport the gateway uses when the real one could not be reached.
 *
 * ## Why this exists (§4.2, acceptance 4; round-1 review H5)
 *
 * §4.2's failure boundary is unconditional: "a Redis outage stops publication
 * and therefore halts trading, **but the recorder continues writing WAL**."
 * Round 1 honoured that mid-run and violated it at startup — it awaited
 * `RedisStreamsEventTransport.connect()` BEFORE building the gateway, before
 * the WAL was opened, and before any public feed started, and exited the
 * process on failure. A recorder restarted during a Redis outage therefore
 * recorded NOTHING, which is the one outcome the first deliverable (§0.1,
 * "record without silent gaps") cannot tolerate: the venue data of those
 * minutes is gone forever, while Redis is replaceable in seconds.
 *
 * `main.ts` now builds the gateway with THIS transport when the connection
 * fails, and immediately puts publication into the same terminal halt (and
 * the same PAGE incident) a mid-run outage produces. Recording and every
 * public feed run normally.
 *
 * Every method throws `EventBusUnavailableError`, which is exactly what the
 * real transport throws when the server is gone — so nothing downstream needs
 * a special case, and if the halt were ever bypassed the first publish would
 * halt anyway. `close()` resolves, because closing something that was never
 * open is not an error and shutdown must not hang on it.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type {
  EventStreamName,
  EventSubscription,
  MarketEventTransport,
  PublishReceipt,
  RetentionPolicy,
  StreamQueueMetrics,
  SubscribeOptions,
} from "@polymarket-bot/event-bus";
import { EventBusUnavailableError } from "@polymarket-bot/event-bus";

export class UnavailableEventTransport implements MarketEventTransport {
  readonly transportId = "unavailable-transport";
  readonly retention: RetentionPolicy;
  readonly #detail: string;

  constructor(detail: string, retention: RetentionPolicy = { maxEvents: 0 }) {
    this.#detail = detail;
    this.retention = retention;
  }

  /** The failure that made the real transport unavailable. */
  get detail(): string {
    return this.#detail;
  }

  publish(stream: EventStreamName, envelope: EventEnvelope<unknown>): Promise<PublishReceipt> {
    // The envelope is deliberately not retained: it is already in the WAL, and
    // holding a copy here would be a second unbounded queue (review H2).
    void envelope;
    return Promise.reject(this.#unavailable(stream));
  }

  subscribe<TPayload = unknown>(
    options: SubscribeOptions,
  ): Promise<EventSubscription<TPayload>> {
    return Promise.reject(this.#unavailable(options.stream));
  }

  streamMetrics(stream: EventStreamName): Promise<StreamQueueMetrics> {
    return Promise.reject(this.#unavailable(stream));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #unavailable(stream: EventStreamName): EventBusUnavailableError {
    return new EventBusUnavailableError(
      `the event-bus transport was unreachable at gateway startup: ${this.#detail}`,
      { stream },
    );
  }
}
