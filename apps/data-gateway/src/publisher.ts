/**
 * The gateway's publication side of the WP-060 transport.
 *
 * ## Submission order is assignment order
 *
 * The transport enforces strictly increasing `ingestSeq` per epoch at publish
 * (WP-060: a non-advancing pair is refused before anything is appended), so
 * the gateway must SUBMIT in assignment order. All publishes go through one
 * serial chain: `enqueue()` is called synchronously in assignment order by the
 * dispatcher, and the chain preserves that order across every feed's async
 * callbacks. Gaps are fine — the order is monotonic, not contiguous.
 *
 * ## Publish-once (dedup identity, WP-050/WP-060 obligation)
 *
 * `(gatewayEpoch, ingestSeq)` is the deduplication identity. The publisher
 * refuses to submit an identity at or below its high-water mark, with a
 * counter and an observer callback — never silently. Within one process this
 * makes a double-publish of one identity unrepresentable; consumers still
 * deduplicate on the same key for the cross-restart at-least-once cases the
 * upstream handoffs document.
 *
 * ## Outage semantics (§4.2, acceptance 4; WP-060 `follow_up` 2)
 *
 * `EventBusUnavailableError` — INCLUDING its `EVENT_BUS_PUBLISH_QUEUE_FULL`
 * subclass, which is a halt signal and not a drop signal — halts publication
 * TERMINALLY for this epoch. Recording is not touched: the WAL path does not
 * run through this module, which is exactly the §4.2 boundary ("a Redis
 * outage stops publication … but the recorder continues writing WAL").
 * Publication does not resume mid-epoch: events assigned during the outage
 * were never in the stream, so a mid-epoch resume would hand consumers a
 * silent gap the transport cannot detect (its resync arithmetic watches its
 * own publication ordinals, not `ingestSeq`). A restart mints a new epoch and
 * a fresh snapshot obligation, which is the §7.1 recovery path.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { EventStreamName, MarketEventTransport } from "@polymarket-bot/event-bus";
import { EventBusPublishQueueFullError, EventBusUnavailableError } from "@polymarket-bot/event-bus";

export type PublishOutcome =
  | { readonly published: true; readonly sequence: number }
  | {
      readonly published: false;
      readonly reason:
        | "duplicate-identity"
        | "publication-halted"
        | "transport-unavailable"
        | "transport-rejected";
      readonly detail: string;
    };

export interface PublicationHalt {
  /** Which failure halted publication. */
  readonly cause: "EVENT_BUS_PUBLISH_QUEUE_FULL" | "EVENT_BUS_UNAVAILABLE";
  readonly detail: string;
  readonly haltedAtIngestSeq: string;
}

export interface GatewayPublisherOptions {
  readonly transport: MarketEventTransport;
  readonly stream: EventStreamName;
  /** Called exactly once, when the first unavailable/queue-full failure halts publication. */
  readonly onPublicationHalted?: (halt: PublicationHalt) => void;
  /** Called for every refused duplicate identity (observable, never silent). */
  readonly onDuplicateRefused?: (identity: {
    readonly gatewayEpoch: string;
    readonly ingestSeq: string;
  }) => void;
  /** Called when the transport rejects an envelope for a non-outage reason. */
  readonly onPublishRejected?: (rejection: {
    readonly ingestSeq: string;
    readonly detail: string;
  }) => void;
}

export interface GatewayPublisherMetrics {
  readonly published: number;
  readonly duplicatesRefused: number;
  readonly suppressedWhileHalted: number;
  readonly rejectedByTransport: number;
  readonly halted: boolean;
  readonly halt: PublicationHalt | undefined;
  /** Highest submitted ingestSeq, as a string; "0" before the first. */
  readonly highWaterMark: string;
}

export class GatewayPublisher {
  readonly #options: GatewayPublisherOptions;
  #chain: Promise<void> = Promise.resolve();
  #highWaterMark = 0n;
  #published = 0;
  #duplicatesRefused = 0;
  #suppressedWhileHalted = 0;
  #rejectedByTransport = 0;
  #halt: PublicationHalt | undefined;

  constructor(options: GatewayPublisherOptions) {
    this.#options = options;
  }

  get halted(): boolean {
    return this.#halt !== undefined;
  }

  /**
   * Enqueues one envelope for publication.
   *
   * MUST be called synchronously, in assignment order, by the dispatcher.
   * The returned promise resolves with the outcome; it never rejects, so a
   * feed driver's socket callback cannot be blown up by a transport failure.
   */
  enqueue(envelope: EventEnvelope<unknown>): Promise<PublishOutcome> {
    const seq = BigInt(envelope.ingestSeq);
    if (seq <= this.#highWaterMark) {
      this.#duplicatesRefused += 1;
      this.#options.onDuplicateRefused?.({
        gatewayEpoch: envelope.gatewayEpoch,
        ingestSeq: envelope.ingestSeq,
      });
      return Promise.resolve({
        published: false,
        reason: "duplicate-identity",
        detail: `(${envelope.gatewayEpoch}, ${envelope.ingestSeq}) is at or below the publish high-water mark ${this.#highWaterMark.toString()}`,
      });
    }
    this.#highWaterMark = seq;

    const submission = this.#chain.then(async (): Promise<PublishOutcome> => {
      if (this.#halt !== undefined) {
        this.#suppressedWhileHalted += 1;
        return {
          published: false,
          reason: "publication-halted",
          detail: `publication halted (${this.#halt.cause}); the event remains in the WAL`,
        };
      }
      try {
        const receipt = await this.#options.transport.publish(this.#options.stream, envelope);
        this.#published += 1;
        return { published: true, sequence: receipt.sequence };
      } catch (error) {
        if (error instanceof EventBusUnavailableError) {
          const halt: PublicationHalt = {
            cause:
              error instanceof EventBusPublishQueueFullError
                ? "EVENT_BUS_PUBLISH_QUEUE_FULL"
                : "EVENT_BUS_UNAVAILABLE",
            detail: error.message,
            haltedAtIngestSeq: envelope.ingestSeq,
          };
          this.#halt = halt;
          this.#suppressedWhileHalted += 1;
          this.#options.onPublicationHalted?.(halt);
          return {
            published: false,
            reason:
              halt.cause === "EVENT_BUS_PUBLISH_QUEUE_FULL"
                ? "publication-halted"
                : "transport-unavailable",
            detail: error.message,
          };
        }
        this.#rejectedByTransport += 1;
        const detail = error instanceof Error ? error.message : String(error);
        this.#options.onPublishRejected?.({ ingestSeq: envelope.ingestSeq, detail });
        return { published: false, reason: "transport-rejected", detail };
      }
    });
    // The chain must survive an outcome nobody awaits.
    this.#chain = submission.then(
      () => undefined,
      () => undefined,
    );
    return submission;
  }

  /** Waits for every enqueued publication to settle. */
  async settle(): Promise<void> {
    await this.#chain;
  }

  metrics(): GatewayPublisherMetrics {
    return {
      published: this.#published,
      duplicatesRefused: this.#duplicatesRefused,
      suppressedWhileHalted: this.#suppressedWhileHalted,
      rejectedByTransport: this.#rejectedByTransport,
      halted: this.#halt !== undefined,
      halt: this.#halt,
      highWaterMark: this.#highWaterMark.toString(),
    };
  }
}
