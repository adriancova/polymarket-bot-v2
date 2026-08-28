/**
 * Continuity tracking for the two counters Coinbase publishes.
 *
 * SCOPE, AND THE CONFLICT BEHIND IT (C-CB-1). Two official sources disagree
 * about what `sequence_num` counts. The WebSocket overview says "Sequence
 * numbers are increasing integer values **for each product**"
 * (`sequence-gap-meaning`), while the machine-readable AsyncAPI document
 * describes the same field as a "**Per-connection** message sequence number"
 * (`envelope-base`). The two readings give different gap detection: under the
 * per-product reading, a connection carrying two products would look like a
 * continuous storm of gaps.
 *
 * This package follows the **per-connection** reading, for three reasons, and
 * records the conflict rather than hiding it:
 *
 *   1. The AsyncAPI document is the machine-readable specification of these
 *      exact frames and is the more precise statement.
 *   2. A read-only observation of the public feed on 2026-08-27 (O-CB-2) found
 *      `sequence_num` advancing by exactly one across all channels and products
 *      on one connection, starting at 0 — which the per-product reading cannot
 *      produce.
 *   3. It is the conservative choice for *this* adapter: under the
 *      per-connection reading a genuine per-product gap still shows up, because
 *      any dropped message breaks the connection-wide run.
 *
 * If the venue ever changes to per-product numbering, this tracker reports a
 * storm of gaps rather than silently mis-detecting — a loud wrong answer, which
 * is the failure mode this repository prefers.
 *
 * NO INVENTED SEQUENCE. Handoff §9.4 and ADR-002 §2.3 forbid inventing a venue
 * sequence number. Nothing here creates one: it only reads what the venue sent,
 * and the results are *validation aids*, never an ordering key. Ordering comes
 * from `(gatewayEpoch, ingestSeq)`, which the gateway assigns.
 */

/** What one observation of a venue counter means. */
export type CoinbaseCounterObservation =
  /** The first value seen since the last reset. Establishes the baseline. */
  | { readonly kind: "FIRST"; readonly received: number }
  /** Exactly one greater than the previous value, as documented. */
  | { readonly kind: "IN_ORDER"; readonly received: number }
  /** A forward jump: the venue documents this as messages having been dropped. */
  | {
      readonly kind: "GAP";
      readonly expected: number;
      readonly received: number;
      /** How many values were skipped. Never negative. */
      readonly missing: number;
    }
  /**
   * The value repeated or moved backwards.
   *
   * The venue says such a value "can be ignored or represent a message that has
   * arrived out of order" (`sequence-gap-meaning`). This adapter does not ignore
   * it — ignoring is a silent drop — it reports it and leaves the baseline where
   * it was, so a later in-order value still resumes cleanly.
   */
  | { readonly kind: "REGRESSED"; readonly previous: number; readonly received: number };

/**
 * A monotonic-by-one venue counter.
 *
 * Used twice: for `sequence_num` on the connection, and for `heartbeat_counter`
 * on the heartbeats channel. They are the same shape of fact — a counter the
 * venue promises to advance by one — and the heartbeat one matters because it
 * detects loss during a period when *no* market-data message was expected.
 */
export class CoinbaseCounterTracker {
  #previous: number | undefined;

  /** The last accepted value, or `undefined` before the first observation. */
  get previous(): number | undefined {
    return this.#previous;
  }

  /**
   * Records one value.
   *
   * A `REGRESSED` value does NOT become the new baseline: accepting it would
   * turn one out-of-order arrival into a permanent offset and make every
   * following message look like a gap.
   */
  observe(received: number): CoinbaseCounterObservation {
    const previous = this.#previous;
    if (previous === undefined) {
      this.#previous = received;
      return { kind: "FIRST", received };
    }
    if (received === previous + 1) {
      this.#previous = received;
      return { kind: "IN_ORDER", received };
    }
    if (received <= previous) {
      return { kind: "REGRESSED", previous, received };
    }
    this.#previous = received;
    return {
      kind: "GAP",
      expected: previous + 1,
      received,
      missing: received - previous - 1,
    };
  }

  /**
   * Forgets the baseline.
   *
   * Called when a new connection is opened: the counter is per-connection, so
   * carrying a previous connection's value across would report a meaningless
   * gap. The *reconnect itself* is what is reported as a gap, by the stream
   * processor, and it is reported unconditionally — a reconnect loses data
   * whatever the new connection's first sequence number happens to be (U-CB-2).
   */
  reset(): void {
    this.#previous = undefined;
  }
}
