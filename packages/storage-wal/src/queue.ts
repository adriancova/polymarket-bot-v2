/**
 * The bounded raw-frame queue (handoff §8.3).
 *
 * Two properties are the whole point of this file:
 *
 * 1. **It is bounded** — by frame count and by encoded bytes — so a stalled disk
 *    cannot turn into unbounded memory growth.
 * 2. **It never drops a frame.** When the bound is reached, `offer` returns a
 *    refusal and the frame stays with the caller. `messagesDropped` counts only
 *    what a caller has explicitly told the queue it discarded, through
 *    {@link BoundedRawFrameQueue.recordCallerDrop}. There is no code path in
 *    which an accepted frame disappears (`WP-050` acceptance 3; §8.3 "Dropping
 *    trading or raw market events silently is forbidden").
 *
 * The §8.3 metric names are reproduced literally so a dashboard can be built
 * from the specification rather than from this implementation.
 */

import { encodeFrameLine } from "./segment-format.js";
import type { RawFrameRecord } from "./raw-frame.js";

/** A frame waiting to be appended, with its encoded bytes computed once. */
export type QueuedFrame = {
  readonly record: RawFrameRecord;
  readonly bytes: Uint8Array;
  readonly enqueuedAtMs: number;
};

/** Why a caller discarded a refused frame; recorded for the incident trail. */
export type CallerDropReason = string;

export type WalQueueMetrics = {
  /** §8.3 "current depth". */
  readonly currentDepth: number;
  /** §8.3 "maximum depth" — the configured bound, not the observed peak. */
  readonly maximumDepth: number;
  /** Greatest depth observed since the queue was created. */
  readonly highWaterDepth: number;
  /** §8.3 "oldest message age", in milliseconds. `0` when empty. */
  readonly oldestMessageAgeMs: number;
  /**
   * §8.3 "messages dropped".
   *
   * Only a caller can increment this, by acknowledging that it discarded a
   * frame the queue refused. The queue itself never drops.
   */
  readonly messagesDropped: number;
  /**
   * §8.3 "producer blocked time", in milliseconds.
   *
   * Always `0`: this queue refuses rather than blocks, so a producer is never
   * held. The field exists because §8.3 requires every bounded queue to expose
   * it, and a value of `0` is a fact about the design, not a missing metric.
   */
  readonly producerBlockedTimeMs: number;
  /** §8.3 "consumer lag": frames accepted but not yet handed to the segment writer. */
  readonly consumerLag: number;
  /** Refusals caused by a full queue. Each one is an overflow signal. */
  readonly overflowSignals: number;
  readonly enqueuedTotal: number;
  readonly dequeuedTotal: number;
  readonly currentByteDepth: number;
  readonly maximumByteDepth: number;
  /** Caller-acknowledged drops, broken down by the reason the caller supplied. */
  readonly messagesDroppedByReason: Readonly<Record<string, number>>;
};

export type QueueOfferResult =
  | { readonly accepted: true; readonly depth: number }
  | {
      readonly accepted: false;
      readonly reason: "queue-overflow";
      readonly detail: string;
      readonly depth: number;
    };

export type BoundedRawFrameQueueOptions = {
  /** Maximum frames held at once. */
  readonly capacity: number;
  /** Maximum encoded bytes held at once. */
  readonly maxBytes: number;
};

/**
 * A FIFO queue of encoded raw frames with a hard bound on depth and bytes.
 *
 * Frames are encoded on `offer` rather than on drain: the byte bound then means
 * exactly what it says, an unencodable record is rejected at the boundary
 * instead of at write time, and the drain path becomes a pure I/O loop.
 */
export class BoundedRawFrameQueue {
  readonly #capacity: number;
  readonly #maxBytes: number;
  #items: (QueuedFrame | undefined)[] = [];
  #head = 0;
  #byteDepth = 0;
  #highWaterDepth = 0;
  #enqueuedTotal = 0;
  #dequeuedTotal = 0;
  #messagesDropped = 0;
  #overflowSignals = 0;
  readonly #messagesDroppedByReason = new Map<string, number>();

  constructor(options: BoundedRawFrameQueueOptions) {
    this.#capacity = options.capacity;
    this.#maxBytes = options.maxBytes;
  }

  get depth(): number {
    return this.#items.length - this.#head;
  }

  get byteDepth(): number {
    return this.#byteDepth;
  }

  /**
   * Offer a frame.
   *
   * On refusal the frame is **not** retained and **not** counted as dropped:
   * the caller still holds it and decides (halt trading, open an incident,
   * retry later — §8.3, ADR-004 §4).
   */
  offer(record: RawFrameRecord, nowMs: number, encodedBytes?: Uint8Array): QueueOfferResult {
    const bytes = encodedBytes ?? encodeFrameLine(record);
    if (this.depth >= this.#capacity) {
      this.#overflowSignals += 1;
      return {
        accepted: false,
        reason: "queue-overflow",
        detail: `raw-frame queue is at its capacity of ${this.#capacity} frames`,
        depth: this.depth,
      };
    }
    if (this.#byteDepth + bytes.length > this.#maxBytes) {
      this.#overflowSignals += 1;
      return {
        accepted: false,
        reason: "queue-overflow",
        detail: `raw-frame queue is at its byte capacity of ${this.#maxBytes} bytes`,
        depth: this.depth,
      };
    }
    this.#items.push({ record, bytes, enqueuedAtMs: nowMs });
    this.#byteDepth += bytes.length;
    this.#enqueuedTotal += 1;
    this.#highWaterDepth = Math.max(this.#highWaterDepth, this.depth);
    return { accepted: true, depth: this.depth };
  }

  /** Remove and return every queued frame, oldest first. */
  takeAll(): readonly QueuedFrame[] {
    const taken = this.#items.slice(this.#head).filter((item): item is QueuedFrame => item !== undefined);
    this.#items = [];
    this.#head = 0;
    this.#byteDepth = 0;
    this.#dequeuedTotal += taken.length;
    return taken;
  }

  /** Remove and return at most `count` frames, oldest first. */
  take(count: number): readonly QueuedFrame[] {
    const taken: QueuedFrame[] = [];
    while (taken.length < count && this.#head < this.#items.length) {
      const item = this.#items[this.#head];
      this.#head += 1;
      if (item === undefined) {
        continue;
      }
      taken.push(item);
      this.#byteDepth -= item.bytes.length;
    }
    if (this.#head >= this.#items.length) {
      this.#items = [];
      this.#head = 0;
      this.#byteDepth = 0;
    } else if (this.#head > 1024) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    this.#dequeuedTotal += taken.length;
    return taken;
  }

  /** Put frames back at the head, preserving order (used after a write fault). */
  requeueFront(frames: readonly QueuedFrame[]): void {
    if (frames.length === 0) {
      return;
    }
    const rest = this.#items.slice(this.#head).filter((item): item is QueuedFrame => item !== undefined);
    this.#items = [...frames, ...rest];
    this.#head = 0;
    this.#byteDepth = this.#items.reduce(
      (total, item) => total + (item?.bytes.length ?? 0),
      0,
    );
    this.#dequeuedTotal -= frames.length;
  }

  /** Age of the oldest queued frame in milliseconds; `0` when empty. */
  oldestMessageAgeMs(nowMs: number): number {
    const oldest = this.#items[this.#head];
    if (oldest === undefined) {
      return 0;
    }
    return Math.max(0, nowMs - oldest.enqueuedAtMs);
  }

  /**
   * Record that the caller discarded frames the queue refused.
   *
   * This is the **only** way `messagesDropped` moves. It exists so that a
   * deliberate, logged decision to shed load is visible in the same metric an
   * operator watches, and so that a silent drop remains impossible.
   */
  recordCallerDrop(count: number, reason: CallerDropReason): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(
        `dropped frame count must be a non-negative integer, received ${String(count)}`,
      );
    }
    if (typeof reason !== "string" || reason.length === 0) {
      throw new RangeError("a caller-acknowledged drop must state a reason");
    }
    this.#messagesDropped += count;
    this.#messagesDroppedByReason.set(reason, (this.#messagesDroppedByReason.get(reason) ?? 0) + count);
  }

  metrics(nowMs: number): WalQueueMetrics {
    return {
      currentDepth: this.depth,
      maximumDepth: this.#capacity,
      highWaterDepth: this.#highWaterDepth,
      oldestMessageAgeMs: this.oldestMessageAgeMs(nowMs),
      messagesDropped: this.#messagesDropped,
      producerBlockedTimeMs: 0,
      consumerLag: this.#enqueuedTotal - this.#dequeuedTotal,
      overflowSignals: this.#overflowSignals,
      enqueuedTotal: this.#enqueuedTotal,
      dequeuedTotal: this.#dequeuedTotal,
      currentByteDepth: this.#byteDepth,
      maximumByteDepth: this.#maxBytes,
      messagesDroppedByReason: Object.fromEntries(this.#messagesDroppedByReason),
    };
  }
}
