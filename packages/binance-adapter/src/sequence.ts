/**
 * Duplicate and out-of-order detection, grounded in what Binance documents.
 *
 * WHAT THE VENUE ACTUALLY GIVES US (`web-socket-streams.md` and `rest-api.md`,
 * accessed 2026-08-27):
 *
 * - `<symbol>@trade` carries `t`, "Trade ID". `GET /api/v3/historicalTrades`
 *   takes `fromId` — "TradeId to fetch from" — so a trade id identifies one trade
 *   on one symbol and orders it against the others. Two frames carrying the same
 *   `t` for the same symbol therefore describe the SAME trade.
 * - `<symbol>@bookTicker` carries `u`, "order book updateId". The documented
 *   local-order-book procedure fixes what a *lower* update id means: "If the
 *   event last update ID (`u`) is less than the update ID of your local order
 *   book, ignore the event." That procedure is written for `<symbol>@depth`, so
 *   applying it to `bookTicker` is recorded as `BNC-U3` (partially verified) —
 *   the *stale* reading is used, the *contiguity* reading is not.
 *
 * WHAT IS DELIBERATELY NOT INFERRED. Neither stream is documented to deliver
 * consecutive ids, so a jump is NOT a gap and this package never raises
 * `FeedGapDetected` from one (`BNC-U2`, `BNC-U3`). Handoff §9.4 is explicit that
 * an implementation "must not invent a venue sequence number", and treating a
 * documented-but-non-contiguous id as a contiguity guarantee is the same
 * invention with extra steps.
 *
 * NOTHING IS DROPPED SILENTLY. This module classifies; it never discards. Every
 * observation, including a duplicate and a regression, is returned to the caller
 * and counted in the metrics (§8.3).
 */

/** How one observed venue id relates to the last one seen on the same key. */
export type SequenceOutcome =
  /** No prior observation for this key. */
  | "FIRST"
  /** The id is strictly greater than the last seen one. */
  | "ADVANCED"
  /** The same id and the same content as the last observation: a repeat. */
  | "DUPLICATE"
  /**
   * The same id but DIFFERENT content.
   *
   * Not documented as possible, and not silently resolved either way: the venue
   * said these are the same trade/book version while the payloads disagree, so
   * this is a data-quality condition the caller is told about.
   */
  | "CONFLICTING_DUPLICATE"
  /** An id below the last seen one: an older observation arriving late. */
  | "REGRESSED"
  /** The tracker is at its bound and is not following this key (see below). */
  | "UNTRACKED";

export type SequenceObservation = {
  readonly outcome: SequenceOutcome;
  readonly key: string;
  readonly current: number;
  readonly previous: number | undefined;
  /** `current - previous` when both are known; a *jump* is not a gap. */
  readonly step: number | undefined;
};

/** Per-key state exposed for metrics. */
export type SequenceState = {
  readonly key: string;
  readonly lastId: number;
  readonly observations: number;
};

/**
 * Bounded per-key sequence tracker.
 *
 * BOUNDED ON PURPOSE. The keys come from the venue (a stream name plus the
 * symbol the venue put in `s`), so an unbounded map here would be a
 * venue-controlled allocation at a trust boundary. §8.3 requires every queue to
 * be bounded and observable; the same reasoning applies to per-key state. On
 * reaching the bound a new key is reported `UNTRACKED` — the frame still flows,
 * it simply cannot be deduplicated — and the count is exposed in the metrics
 * rather than swallowed.
 */
export class SequenceTracker {
  readonly #entries = new Map<string, { lastId: number; identity: string; observations: number }>();
  readonly #maxKeys: number;
  #untrackedObservations = 0;

  public constructor(maxKeys = 4096) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
      throw new RangeError(`maxKeys must be a positive safe integer, received ${String(maxKeys)}`);
    }
    this.#maxKeys = maxKeys;
  }

  /**
   * Records an observation and classifies it.
   *
   * `identity` is a content fingerprint of the fields the venue considers part of
   * the observation; it is what separates a harmless repeat from a contradiction.
   */
  public observe(key: string, id: number, identity: string): SequenceObservation {
    const existing = this.#entries.get(key);
    if (existing === undefined) {
      if (this.#entries.size >= this.#maxKeys) {
        this.#untrackedObservations += 1;
        return { outcome: "UNTRACKED", key, current: id, previous: undefined, step: undefined };
      }
      this.#entries.set(key, { lastId: id, identity, observations: 1 });
      return { outcome: "FIRST", key, current: id, previous: undefined, step: undefined };
    }

    const previous = existing.lastId;
    existing.observations += 1;

    if (id > previous) {
      existing.lastId = id;
      existing.identity = identity;
      return { outcome: "ADVANCED", key, current: id, previous, step: id - previous };
    }
    if (id === previous) {
      return {
        outcome: existing.identity === identity ? "DUPLICATE" : "CONFLICTING_DUPLICATE",
        key,
        current: id,
        previous,
        step: 0,
      };
    }
    return { outcome: "REGRESSED", key, current: id, previous, step: id - previous };
  }

  /** The last id seen on a key, or `undefined` when the key is unseen. */
  public lastIdFor(key: string): number | undefined {
    return this.#entries.get(key)?.lastId;
  }

  /** Number of keys currently tracked. */
  public get trackedKeys(): number {
    return this.#entries.size;
  }

  /** The configured bound on tracked keys. */
  public get maxKeys(): number {
    return this.#maxKeys;
  }

  /** Observations that arrived after the bound was reached and were not tracked. */
  public get untrackedObservations(): number {
    return this.#untrackedObservations;
  }

  /** A stable, sorted snapshot for the metrics surface. */
  public snapshot(): readonly SequenceState[] {
    return [...this.#entries.entries()]
      .map(([key, entry]) => ({ key, lastId: entry.lastId, observations: entry.observations }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  }
}

/**
 * Content fingerprint for a `<symbol>@trade` observation.
 *
 * Uses every documented economic and temporal field, so a same-id frame that
 * differs anywhere the venue could have differed is recognised as a conflict.
 * The wire strings are used verbatim (not the normalized forms) because the
 * question is "did the venue send the same thing twice", not "do these mean the
 * same value".
 */
export function tradeIdentity(input: {
  readonly priceRaw: string;
  readonly quantityRaw: string;
  readonly tradeTimeEpoch: number;
  readonly buyerIsMaker: boolean;
}): string {
  return `${input.priceRaw}|${input.quantityRaw}|${String(input.tradeTimeEpoch)}|${String(input.buyerIsMaker)}`;
}

/** Content fingerprint for a `<symbol>@bookTicker` observation. */
export function bookTickerIdentity(input: {
  readonly bidPriceRaw: string;
  readonly bidQuantityRaw: string;
  readonly askPriceRaw: string;
  readonly askQuantityRaw: string;
}): string {
  return `${input.bidPriceRaw}|${input.bidQuantityRaw}|${input.askPriceRaw}|${input.askQuantityRaw}`;
}
