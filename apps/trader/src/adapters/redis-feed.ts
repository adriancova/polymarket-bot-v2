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
 * ## Frame-aligned batches (`THROUGHPUT-2`, ADR-024)
 *
 * The core loop evaluates once per venue FRAME, and treats the end of a batch
 * as the end of a frame (`packages/trading-core` `drain`). So a batch this
 * feed hands out must never end in the middle of one. Two facts make that
 * checkable without waiting on the next event:
 *
 * 1. the gateway writes every envelope of one raw frame in ONE atomic script
 *    call (`apps/data-gateway/src/publisher.ts`, frame-atomic runs), so a
 *    reader sees all of a frame's entries or none of them;
 * 2. a read that returned FEWER entries than its `COUNT` reached the end of
 *    the stream at that instant.
 *
 * Hence: a SHORT read ends at a frame boundary (every frame in it is whole,
 * by 1), and is handed out whole. A FULL read may have cut its last frame at
 * the `COUNT` boundary, so its trailing run of one frame key is CARRIED —
 * held back, undelivered — and handed out at the front of the next poll, which
 * reads on until that frame is closed by a different key or by a short read.
 * Nothing waits for the NEXT event: a quiet stream answers the very next read
 * short. A batch never exceeds `maxEvents` (the read asks for what the carry
 * leaves room for); a single frame of `maxEvents` or more cannot be aligned
 * and is handed out as it stands (counted in {@link RedisMarketEventFeed.framesSplit}).
 *
 * Positions follow DELIVERY: `mark`/`commit` name the last event handed OUT,
 * never a carried one, so a crash re-reads a carried partial frame whole.
 *
 * NO CREDENTIAL. A Redis connection is not a venue credential and this module
 * holds none; it takes an already-constructed subscription, so it cannot even
 * name a connection string.
 */

import type { EventSubscription } from "@polymarket-bot/event-bus";

import {
  frameKeyOf,
  portFailed,
  portOk,
  type FeedMark,
  type IngestedEvent,
  type MarketEventFeed,
  type PortResult,
} from "@polymarket-bot/trading-core";

type Received = Awaited<ReturnType<EventSubscription<unknown>["receive"]>>;
type Delivered = Extract<Received, { readonly status: "events" }>["events"][number];

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
  /** `THROUGHPUT-2`: read but not yet handed out — the trailing run of a full read. */
  #carry: readonly Delivered[] = [];
  #framesSplit = 0;

  constructor(options: RedisMarketEventFeedOptions) {
    this.#subscription = options.subscription;
    this.#maxEvents = options.maxEvents;
  }

  async poll(): Promise<PortResult<readonly IngestedEvent[]>> {
    // The carry is always shorter than `maxEvents` (it is the tail of a batch
    // of `maxEvents` that has a frame boundary before it), so this read asks
    // for at least one entry and a batch never exceeds `maxEvents`.
    const room = this.#maxEvents - this.#carry.length;
    const received = await this.#receive(room);
    if (!received.ok) return received;
    const fresh = received.value;
    const buffer = this.#carry.length === 0 ? fresh : [...this.#carry, ...fresh];
    this.#carry = [];
    if (fresh.length < room) {
      // A SHORT read (an idle one included) reached the stream's end: every
      // frame in the buffer — a carried one included — is whole (module
      // header, fact 1), so it is handed out whole.
      return portOk(this.#deliver(buffer));
    }
    // A FULL read (the buffer now holds exactly `maxEvents`) may have cut its
    // last frame: carry the trailing run of one frame key.
    const tail = trailingFrameStart(buffer);
    if (tail === 0) {
      // One frame fills the whole batch: it cannot be aligned. Handed out as
      // it stands — never dropped, never held without bound — and counted.
      this.#framesSplit += 1;
      return portOk(this.#deliver(buffer));
    }
    this.#carry = buffer.slice(tail);
    return portOk(this.#deliver(buffer.slice(0, tail)));
  }

  /**
   * `THROUGHPUT-2`: how many times a single frame of `maxEvents` or more
   * events had to be handed out across two batches (see the module header).
   * `0` in every run measured; a non-zero value means some evaluation saw a
   * partially applied frame.
   */
  get framesSplit(): number {
    return this.#framesSplit;
  }

  /** Events read from the stream and not yet handed out (the carried partial frame). */
  get carried(): number {
    return this.#carry.length;
  }

  /** One read, converted to the port's data surface. */
  async #receive(maxEvents: number): Promise<PortResult<readonly Delivered[]>> {
    let received: Received;
    try {
      received = await this.#subscription.receive({ maxEvents });
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
      return portOk([]);
    }
    return portOk(received.events);
  }

  /** Hands events OUT: ordinals and the recordable position advance only here. */
  #deliver(delivered: readonly Delivered[]): readonly IngestedEvent[] {
    const events: IngestedEvent[] = [];
    for (const entry of delivered) {
      this.#ordinal += 1;
      this.#pendingCheckpoint = entry.checkpoint;
      events.push({
        envelope: entry.envelope,
        identity: {
          gatewayEpoch: entry.envelope.gatewayEpoch,
          ingestSeq: entry.envelope.ingestSeq,
          receivedAt: entry.envelope.receivedAt,
          datasetRowOrdinal: this.#ordinal,
        },
      });
    }
    return Object.freeze(events);
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

/**
 * `THROUGHPUT-2`: the index where the trailing run of one frame key begins
 * (`0` when the whole buffer is one frame). An event with no frame key is a
 * complete frame of its own, so nothing is carried after it (`buffer.length`).
 */
function trailingFrameStart(buffer: readonly Delivered[]): number {
  const last = buffer[buffer.length - 1];
  if (last === undefined) return 0;
  const key = frameKeyOf(last.envelope);
  if (key === undefined) return buffer.length;
  let start = buffer.length - 1;
  while (start > 0 && frameKeyOf((buffer[start - 1] as Delivered).envelope) === key) start -= 1;
  return start;
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
