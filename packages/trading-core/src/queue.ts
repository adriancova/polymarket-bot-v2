/**
 * Bounded queues — handoff §8.3.
 *
 * > "Every queue is bounded and exposes: current depth, maximum depth, oldest
 * > message age, messages dropped, producer blocked time, consumer lag.
 * > **Dropping trading or raw market events silently is forbidden.** If a
 * > critical queue cannot accept an event, affected trading halts and a
 * > data-quality incident opens."
 *
 * Two design consequences follow from that paragraph, and both are structural
 * here rather than conventional:
 *
 * 1. **`offer` cannot drop.** Its return type is a discriminated union whose
 *    `REJECTED` arm carries the reason; there is no arm that means "accepted,
 *    and something older was discarded". A caller that ignores the result gets
 *    a value it must narrow before it can use anything, and the loop's rejection
 *    path is a HALT (`halt.ts`), never a `continue`.
 * 2. **`messagesDropped` exists and is always `0`.** §8.3 names the metric, so
 *    the surface carries it; this implementation has no code path that can
 *    increment it. It is reported rather than omitted so an operator reading
 *    the metric set sees the zero rather than an absence they must interpret.
 *
 * TIME IS INJECTED. "Oldest message age" and "producer blocked time" are
 * durations, and a queue that read a clock would make the health surface
 * non-deterministic under replay (§12.4). Every method that needs an instant
 * takes epoch milliseconds from the caller, which in the trader is the §12.1
 * `Clock` port — the same one that drives the loop.
 */

/** §8.3's metric set for one queue, plus the identity of the queue itself. */
export interface QueueMetrics {
  readonly name: string;
  readonly currentDepth: number;
  readonly maximumDepth: number;
  /**
   * Age of the oldest queued message in milliseconds, or `null` when empty.
   *
   * `null`, not `0`: an empty queue has no oldest message, and reporting `0`
   * would be indistinguishable from a message that arrived this instant.
   */
  readonly oldestMessageAgeMs: number | null;
  /** Always `0`. See the module comment — no path here can drop. */
  readonly messagesDropped: number;
  /** Cumulative milliseconds a producer was refused because the queue was full. */
  readonly producerBlockedMs: number;
  /** Accepted minus consumed: how far the consumer trails the producer. */
  readonly consumerLag: number;
  /** Cumulative accepted / consumed counts, so lag can be audited. */
  readonly accepted: number;
  readonly consumed: number;
}

export type OfferOutcome =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: "QUEUE_FULL";
      readonly detail: string;
    };

interface Slot<T> {
  readonly value: T;
  readonly enqueuedAtMs: number;
}

/**
 * A bounded FIFO queue with the §8.3 surface.
 *
 * Deterministic: the same sequence of `offer`/`take` calls with the same
 * injected instants produces the same metric set, byte for byte.
 */
export class BoundedQueue<T> {
  readonly name: string;
  readonly maximumDepth: number;

  #slots: Slot<T>[] = [];
  #accepted = 0;
  #consumed = 0;
  #producerBlockedMs = 0;
  #lastRejectedAtMs: number | undefined;

  constructor(options: { readonly name: string; readonly maximumDepth: number }) {
    if (!Number.isSafeInteger(options.maximumDepth) || options.maximumDepth < 1) {
      throw new RangeError(
        `queue "${options.name}" needs a positive integral maximum depth (§8.3 bounds every queue); ` +
          `received ${String(options.maximumDepth)}`,
      );
    }
    this.name = options.name;
    this.maximumDepth = options.maximumDepth;
  }

  get depth(): number {
    return this.#slots.length;
  }

  /**
   * Offers one message.
   *
   * A full queue REFUSES. It does not evict, it does not overwrite, and it does
   * not silently succeed: §8.3 forbids the drop, so the back pressure is the
   * caller's to handle, and in this process the caller halts.
   *
   * `nowMs` also accumulates producer-blocked time: each consecutive refusal
   * adds the interval since the previous one, so the metric measures the span a
   * producer spent unable to enqueue rather than counting refusals.
   */
  offer(value: T, nowMs: number): OfferOutcome {
    if (this.#slots.length >= this.maximumDepth) {
      if (this.#lastRejectedAtMs !== undefined && nowMs > this.#lastRejectedAtMs) {
        this.#producerBlockedMs += nowMs - this.#lastRejectedAtMs;
      }
      this.#lastRejectedAtMs = nowMs;
      return {
        accepted: false,
        reason: "QUEUE_FULL",
        detail:
          `queue "${this.name}" is at its maximum depth of ${String(this.maximumDepth)}; ` +
          "§8.3 forbids dropping the event, so the offer is REFUSED and affected trading halts",
      };
    }
    this.#lastRejectedAtMs = undefined;
    this.#slots.push({ value, enqueuedAtMs: nowMs });
    this.#accepted += 1;
    return { accepted: true };
  }

  /** Removes and returns the oldest message, or `undefined` when empty. */
  take(): T | undefined {
    const slot = this.#slots.shift();
    if (slot === undefined) return undefined;
    this.#consumed += 1;
    return slot.value;
  }

  /** The oldest message without removing it. */
  peek(): T | undefined {
    return this.#slots[0]?.value;
  }

  metrics(nowMs: number): QueueMetrics {
    const oldest = this.#slots[0];
    return Object.freeze({
      name: this.name,
      currentDepth: this.#slots.length,
      maximumDepth: this.maximumDepth,
      oldestMessageAgeMs:
        oldest === undefined ? null : Math.max(0, nowMs - oldest.enqueuedAtMs),
      messagesDropped: 0,
      producerBlockedMs: this.#producerBlockedMs,
      consumerLag: this.#accepted - this.#consumed,
      accepted: this.#accepted,
      consumed: this.#consumed,
    });
  }
}
