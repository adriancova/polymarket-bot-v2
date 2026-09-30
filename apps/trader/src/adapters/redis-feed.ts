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
 * Dated addition (`OUTAGE-1`, `BOOT1-R7`): "a throw" presumed the transport
 * would throw. Under a real outage it did not — with the Redis container
 * stopped, the `receive` this adapter awaits was still pending 90 s later,
 * because `ioredis` had parked the in-flight command where its retry flush
 * never reaches. The bound that makes the throw happen now lives in
 * `packages/event-bus` (`responseTimeoutMs`: every command and every read is
 * answered within it or fails), so nothing here waits on its own clock. What
 * changed here is the halt DETAIL: it carries the failure's cause chain, which
 * is where the transport says why.
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
  type FeedMark,
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
  /** `THROUGHPUT-1a`: the checkpoint each handed-out {@link FeedMark} names. */
  readonly #marks = new WeakMap<FeedMark, Parameters<EventSubscription["checkpoint"]>[0]>();

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

  /**
   * `THROUGHPUT-1a`: a mark of the position delivered so far — the last
   * delivered event's checkpoint — for a later `commit(mark)`.
   */
  mark(): FeedMark | undefined {
    const checkpoint = this.#pendingCheckpoint;
    if (checkpoint === undefined) return undefined;
    const mark: FeedMark = { feedMark: true };
    Object.freeze(mark);
    this.#marks.set(mark, checkpoint);
    return mark;
  }

  async commit(upTo?: FeedMark): Promise<PortResult<null>> {
    const checkpoint = upTo === undefined ? this.#pendingCheckpoint : this.#marks.get(upTo);
    if (upTo !== undefined && checkpoint === undefined) {
      return portFailed(
        "UNREADABLE",
        "the position to record is not one this feed marked; a consumer that recorded a position it " +
          "cannot name would resume from an unknown one (ADR-003 §3.4)",
      );
    }
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
    if (checkpoint === this.#pendingCheckpoint) this.#pendingCheckpoint = undefined;
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

/** How many links of an error's `cause` chain a halt detail carries. */
const MAX_CAUSE_DEPTH = 3;

/**
 * The error and its cause chain, one line (`OUTAGE-1`).
 *
 * The transport wraps every failure in an `EventBusUnavailableError` whose
 * own message says only WHICH operation failed ("could not read from the
 * event transport"); WHY — "Command timed out", a read with no reply within
 * its bound, the retry limit — is its `cause`. An operator reading the halt
 * needs the why, so the chain is carried, bounded so that a cyclic chain
 * cannot grow the line without limit.
 */
function describe(cause: unknown, depth = 0): string {
  if (!(cause instanceof Error)) return String(cause);
  const own = `${cause.name}: ${cause.message}`;
  if (cause.cause === undefined || depth + 1 >= MAX_CAUSE_DEPTH) return own;
  return `${own}; caused by ${describe(cause.cause, depth + 1)}`;
}
