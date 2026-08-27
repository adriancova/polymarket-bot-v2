/**
 * One-at-a-time execution per key, bounded and observable.
 *
 * ## Why publishing needs this
 *
 * `(gatewayEpoch, ingestSeq)` is the only ordering authority (ADR-002 §2), and
 * ADR-003 §2 requires the transport not to reorder within an epoch. The
 * publisher enforces that by comparing an arriving `ingestSeq` against the last
 * one it accepted for the epoch — but a check, an `await`, and then a cursor
 * update is a check-then-act: two overlapping publishes both read the same
 * stale cursor, both pass, and the stream ends up holding them in whatever
 * order the two round trips happened to complete. Both calls "succeed" and the
 * epoch is reordered, which is precisely what ADR-003 §2 forbids; a consumer
 * can then only *count* the anomaly, because by then the events are already in
 * the stream.
 *
 * Serializing the whole check-plus-append per epoch closes it: the second call
 * sees the first call's cursor and is refused before anything is appended, or —
 * when it does advance — is appended after it. Registration order is the
 * execution order, so a caller that issues two publishes in a definite order
 * gets them in that order even without awaiting the first.
 *
 * ## Why per key, and why that is enough
 *
 * The key is the epoch, not the stream: two epochs are two independent
 * sequences (ADR-003 §2), so making one wait behind the other would cost
 * throughput and buy nothing. Across processes there is nothing to serialize —
 * `gatewayEpoch` is "a UUID assigned at gateway startup" (ADR-002 §2.1), so one
 * epoch has exactly one publishing process, and two gateways sharing a stream
 * "must use distinct `gatewayEpoch` values" (ADR-002 Consequences). Ordering
 * *within* an epoch is therefore entirely a within-process question, which is
 * the question this answers.
 *
 * A failed operation does not block the ones behind it: the queue orders work,
 * it does not couple outcomes.
 *
 * ## Why it is bounded, and why the bound is not per key
 *
 * ADR-003 §3.1 and handoff §8.3 require **every** queue to be bounded and to
 * expose its depth, its maximum depth, and its oldest message's age. A queue of
 * promises with no admission limit is none of those: a producer publishing
 * faster than a stalled transport drains would sit behind an unbounded chain,
 * holding every unacknowledged event in memory, with no number an operator
 * could look at. §8.3's answer to a queue that cannot accept an event is to
 * refuse it and halt affected trading — never to accept it quietly.
 *
 * The bound counts everything queued **or running**, across keys, so that
 * "depth against maximum depth" is one comparison rather than a per-key
 * distribution. Execution stays per key, which is what ordering needs; only
 * admission is shared. One gateway process publishes one epoch (ADR-002 §2.1),
 * so the distinction is normally moot, and where it is not, refusing every
 * epoch on a saturated transport is the correct outcome: the transport, not one
 * sequence, is the thing that has stopped.
 */

import { performance } from "node:perf_hooks";

import { EventBusConfigurationError, EventBusPublishQueueFullError } from "./errors.js";

/**
 * Default bound on operations queued or running at once.
 *
 * Large enough that ordinary concurrency — a producer with several publishes in
 * flight while one round trip completes — is never refused, small enough that a
 * transport that has stopped answering is refused in bounded memory rather than
 * accumulating events with nowhere to go.
 */
export const DEFAULT_MAX_PENDING_OPERATIONS = 1024;

export type KeyedSerialQueueOptions = {
  /** Operations that may be queued or running at once. Defaults to 1024. */
  readonly maxPending?: number;
};

/**
 * One submitted operation, identified by object identity.
 *
 * It carries only the moment it was submitted: that is what makes the oldest
 * pending wait a real measurement rather than an estimate from a counter.
 */
type PendingEntry = { readonly enqueuedAtMs: number };

/** Runs operations one at a time per key, in the order they were submitted. */
export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Set<PendingEntry>();
  readonly #maxPending: number;

  constructor(options: KeyedSerialQueueOptions = {}) {
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_OPERATIONS;
    assertMaxPending(maxPending);
    this.#maxPending = maxPending;
  }

  /** Keys with work queued or running. Zero when the queue is idle. */
  get activeKeyCount(): number {
    return this.#tails.size;
  }

  /** Operations queued or running right now. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** The admission bound: the most this queue will hold at once. */
  get maxPending(): number {
    return this.#maxPending;
  }

  /**
   * How long the longest-waiting operation has been in the queue, in
   * milliseconds. `0` when nothing is pending.
   *
   * Measured from submission, not from the moment execution began: the point of
   * the number is to show a caller waiting behind a stall, and a stalled
   * operation's followers are exactly the ones whose wait would otherwise be
   * invisible.
   */
  oldestPendingAgeMs(): number {
    let oldest: number | undefined;
    for (const entry of this.#pending) {
      if (oldest === undefined || entry.enqueuedAtMs < oldest) {
        oldest = entry.enqueuedAtMs;
      }
    }
    return oldest === undefined ? 0 : Math.max(0, performance.now() - oldest);
  }

  /**
   * Queues `operation` behind everything already submitted for `key`.
   *
   * Refuses, rather than queues, once the bound is reached: the refusal is a
   * typed {@link EventBusPublishQueueFullError}, so the caller still holds its
   * event and its halt path runs (§8.3, ADR-003 §4).
   *
   * The entry is dropped once nothing is left behind it, so a publisher that
   * sees many short-lived epochs does not accumulate one entry per epoch
   * forever.
   */
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // Admission is decided before the first `await`, so a burst submitted in one
    // turn is counted one by one rather than all being let in on a stale depth.
    if (this.#pending.size >= this.#maxPending) {
      throw new EventBusPublishQueueFullError(
        "the bounded publish queue is full; the event was not accepted and affected trading " +
          "halts (§8.3, ADR-003 §4)",
        { key, pending: this.#pending.size, maxPending: this.#maxPending },
      );
    }
    const entry: PendingEntry = { enqueuedAtMs: performance.now() };
    this.#pending.add(entry);

    const previous = this.#tails.get(key) ?? Promise.resolve();
    const current = previous.then(async () => await operation());
    // The recorded tail never rejects, so one failure cannot reject every
    // operation queued behind it — and cannot become an unhandled rejection
    // when the caller of the failing operation handles its own error.
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    try {
      return await current;
    } finally {
      // Released here rather than after `await tail` so a refused or failed
      // operation frees its slot at once: a queue that only forgot successes
      // would fill up permanently on a stream of failures.
      this.#pending.delete(entry);
      await tail;
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

/** Validates an admission bound, so a bad one fails at construction. */
export function assertMaxPending(maxPending: number): void {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new EventBusConfigurationError(
      `maxPending must be a positive safe integer, received ${String(maxPending)}`,
      { maxPending },
    );
  }
}
