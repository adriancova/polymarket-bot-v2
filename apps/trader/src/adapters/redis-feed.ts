/**
 * The Redis binding for {@link MarketEventFeed} — §4.2's transport boundary.
 *
 * `packages/event-bus` owns the transport (ADR-003 §1: "One implementation
 * exists and lives in `./redis/`"), and F8 forbids any package outside it from
 * importing a Redis client. This module therefore imports the PACKAGE, never a
 * client, and does one thing: turn `EventSubscription`'s surface into the
 * trader's port.
 *
 * ## What the conversion is for
 *
 * `EventSubscription.receive` already answers a discriminated union — `events`,
 * `idle`, or `resync-required` — because ADR-003 §3.3's hard resync "is an
 * expected operational state that the caller must handle… not an exception to
 * log and retry". What it does NOT convert to data is a CONNECTION failure: a
 * closed or unreachable transport is a typed throw. §4.2 makes that a trading
 * halt, and a halt controller cannot act on an exception it never sees, so the
 * throw is contained here and becomes the port's `UNAVAILABLE` failure.
 *
 * ## The recorded identity
 *
 * The trader's loop anchors every simulated outcome to a `RecordedEventIdentity`
 * (§6 invariant 15). In a replay it comes from the dataset; on this path it is
 * derived from the envelope's OWN §7.1 fields — `gatewayEpoch`, `ingestSeq`,
 * `receivedAt` — which is the same identity the recorder wrote, so a live run
 * and its later replay anchor to the same facts. `datasetRowOrdinal` is a
 * per-process delivery ordinal: the live path has no dataset row, and inventing
 * a row number that matched one would be worse than an honest counter.
 *
 * NO CREDENTIAL. A Redis connection is not a venue credential and this module
 * holds none; it takes an already-constructed subscription, so it cannot even
 * name a connection string.
 */

import type { EventSubscription } from "@polymarket-bot/event-bus";

import {
  portFailed,
  portOk,
  type IngestedEvent,
  type MarketEventFeed,
  type PortResult,
} from "@polymarket-bot/trading-core";

export interface RedisMarketEventFeedOptions {
  /** An already-subscribed `packages/event-bus` subscription. */
  readonly subscription: EventSubscription<unknown>;
  /** Upper bound on one batch (§8.3: every read is bounded). */
  readonly maxEvents: number;
}

export class RedisMarketEventFeed implements MarketEventFeed {
  readonly #subscription: EventSubscription<unknown>;
  readonly #maxEvents: number;
  #ordinal = 0;
  /** The checkpoint of the last event delivered, committed after the drain. */
  #pendingCheckpoint: Parameters<EventSubscription["checkpoint"]>[0] | undefined;

  constructor(options: RedisMarketEventFeedOptions) {
    this.#subscription = options.subscription;
    this.#maxEvents = options.maxEvents;
  }

  async poll(): Promise<PortResult<readonly IngestedEvent[]>> {
    let received: Awaited<ReturnType<EventSubscription<unknown>["receive"]>>;
    try {
      received = await this.#subscription.receive({ maxEvents: this.#maxEvents });
    } catch (cause) {
      return portFailed(
        "UNAVAILABLE",
        `the event transport threw while receiving (${describe(cause)}); §4.2 makes a Redis ` +
          "outage a trading halt",
      );
    }

    if (received.status === "resync-required") {
      return portFailed(
        "RESYNC_REQUIRED",
        `${received.condition.reason}: ${received.condition.detail} ` +
          `(missed ${String(received.condition.missedEventCount)} events)`,
      );
    }
    if (received.status === "idle") {
      return portOk(Object.freeze([]));
    }

    const events: IngestedEvent[] = [];
    for (const delivered of received.events) {
      this.#ordinal += 1;
      this.#pendingCheckpoint = delivered.checkpoint;
      events.push({
        envelope: delivered.envelope,
        identity: {
          gatewayEpoch: delivered.envelope.gatewayEpoch,
          ingestSeq: delivered.envelope.ingestSeq,
          receivedAt: delivered.envelope.receivedAt,
          datasetRowOrdinal: this.#ordinal,
        },
      });
    }
    return portOk(Object.freeze(events));
  }

  async commit(): Promise<PortResult<null>> {
    const checkpoint = this.#pendingCheckpoint;
    if (checkpoint === undefined) return portOk(null);
    try {
      await this.#subscription.checkpoint(checkpoint);
    } catch (cause) {
      return portFailed(
        "UNAVAILABLE",
        `the event transport threw while checkpointing (${describe(cause)}); a consumer that ` +
          "cannot record its position would resume from an unknown one (ADR-003 §3.4)",
      );
    }
    this.#pendingCheckpoint = undefined;
    return portOk(null);
  }

  async close(): Promise<void> {
    try {
      await this.#subscription.close();
    } catch {
      // Closing is best-effort: the process is stopping either way, and a throw
      // here would replace a clean shutdown with a stack trace.
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
