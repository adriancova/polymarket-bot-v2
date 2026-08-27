/**
 * One-at-a-time execution per key.
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
 */

/** Runs operations one at a time per key, in the order they were submitted. */
export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  /** Keys with work queued or running. Zero when the queue is idle. */
  get activeKeyCount(): number {
    return this.#tails.size;
  }

  /**
   * Queues `operation` behind everything already submitted for `key`.
   *
   * The entry is dropped once nothing is left behind it, so a publisher that
   * sees many short-lived epochs does not accumulate one entry per epoch
   * forever.
   */
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
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
      await tail;
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}
