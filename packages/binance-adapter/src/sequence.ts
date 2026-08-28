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
  /** The id is strictly greater than the highest seen, and is new. */
  | "ADVANCED"
  /**
   * An id already inside this key's window, repeated with the same content.
   *
   * Deliberately NOT "the same id as the immediately preceding frame": a
   * duplicate is a duplicate whether or not something else arrived in between.
   */
  | "DUPLICATE"
  /**
   * The same id but DIFFERENT content.
   *
   * Not documented as possible, and not silently resolved either way: the venue
   * said these are the same trade/book version while the payloads disagree, so
   * this is a data-quality condition the caller is told about.
   */
  | "CONFLICTING_DUPLICATE"
  /**
   * An id below the highest seen that this key has NOT seen before: a genuinely
   * late observation, not a repeat.
   */
  | "REGRESSED"
  /** The tracker is at its bound and is not following this key (see below). */
  | "UNTRACKED";

export type SequenceObservation = {
  readonly outcome: SequenceOutcome;
  readonly key: string;
  readonly current: number;
  /** The HIGHEST id seen on this key so far, not the previously handled frame. */
  readonly previous: number | undefined;
  /** `current - previous` when both are known; a *jump* is not a gap. */
  readonly step: number | undefined;
  /**
   * Whether this id had been observed before on this key.
   *
   * `true` for both duplicate outcomes; `false` for `FIRST`, `ADVANCED`, and a
   * genuinely unseen late arrival. It is the difference between "the venue
   * repeated something" and "the venue delivered something out of order", which
   * is what decides whether a late trade may be published.
   */
  readonly previouslySeen: boolean;
};

/** Per-key state exposed for metrics. */
export type SequenceState = {
  readonly key: string;
  readonly lastId: number;
  readonly observations: number;
  /** Ids currently remembered for this key; the duplicate window's real size. */
  readonly recentIdsTracked: number;
};

/**
 * Default size of the per-key duplicate window.
 *
 * Chosen, not documented: the venue states nothing about how far out of order
 * it may deliver. It is small enough that the worst case stays bounded
 * (`maxKeys` × this, and `maxKeys` is itself only reachable by subscribing to
 * that many streams) and large enough to cover any reordering a socket is
 * plausibly responsible for. A caller with a different tolerance sets its own.
 */
export const DEFAULT_MAX_RECENT_IDS_PER_KEY = 64;

type TrackedKey = {
  lastId: number;
  observations: number;
  /**
   * Recently observed ids on this key, mapped to their content fingerprints.
   *
   * A `Map` iterates in insertion order, which is what makes the oldest entry
   * the first one and the eviction policy a plain FIFO with no bookkeeping.
   */
  readonly recent: Map<number, string>;
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
 *
 * IT REMEMBERS A WINDOW OF IDS, NOT ONLY THE LATEST ONE. Remembering only the
 * highest id makes duplicate detection depend on the SCHEDULE rather than on
 * the data: `100, 101, 100` would report the second `100` as a genuinely late
 * trade and publish it a second time, while `100, 100, 101` would suppress it —
 * the same venue trade, published once or twice depending on what arrived in
 * between (round-1 review, finding M2). Since a trade id identifies one trade
 * on one symbol, "have I seen this id" is the question that decides, and it is
 * answered against a bounded window of recent ids.
 *
 * THE WINDOW'S EDGE IS A REAL LIMIT, AND IT IS VISIBLE. An id evicted from the
 * window can no longer be recognised as a repeat: arriving again below the
 * highest id, it is classified `REGRESSED` — which for a trade means it is
 * published a second time. The alternative is an unbounded map keyed by
 * venue-controlled values, which §8.3 forbids. `recentIdsTracked` and
 * `maxRecentIdsPerStream` are therefore reported in the metrics, so an operator
 * can see how wide the window actually is rather than assuming it is infinite.
 */
export class SequenceTracker {
  readonly #entries = new Map<string, TrackedKey>();
  readonly #maxKeys: number;
  readonly #maxRecentIds: number;
  #untrackedObservations = 0;

  public constructor(maxKeys = 4096, maxRecentIdsPerKey = DEFAULT_MAX_RECENT_IDS_PER_KEY) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
      throw new RangeError(`maxKeys must be a positive safe integer, received ${String(maxKeys)}`);
    }
    if (!Number.isSafeInteger(maxRecentIdsPerKey) || maxRecentIdsPerKey <= 0) {
      throw new RangeError(
        `maxRecentIdsPerKey must be a positive safe integer, received ${String(maxRecentIdsPerKey)}`,
      );
    }
    this.#maxKeys = maxKeys;
    this.#maxRecentIds = maxRecentIdsPerKey;
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
        return {
          outcome: "UNTRACKED",
          key,
          current: id,
          previous: undefined,
          step: undefined,
          previouslySeen: false,
        };
      }
      this.#entries.set(key, { lastId: id, observations: 1, recent: new Map([[id, identity]]) });
      return {
        outcome: "FIRST",
        key,
        current: id,
        previous: undefined,
        step: undefined,
        previouslySeen: false,
      };
    }

    const previous = existing.lastId;
    existing.observations += 1;
    const seenIdentity = existing.recent.get(id);

    if (seenIdentity !== undefined) {
      // The venue sent this id before, whether or not it is still the highest.
      // The first-seen content is kept: a contradiction is reported, not applied.
      return {
        outcome: seenIdentity === identity ? "DUPLICATE" : "CONFLICTING_DUPLICATE",
        key,
        current: id,
        previous,
        step: id - previous,
        previouslySeen: true,
      };
    }

    this.#remember(existing, id, identity);
    if (id > previous) {
      existing.lastId = id;
      return {
        outcome: "ADVANCED",
        key,
        current: id,
        previous,
        step: id - previous,
        previouslySeen: false,
      };
    }
    // Below the highest id and never seen: a genuinely late observation. (An id
    // equal to the highest one is always in the window, so it cannot land here.)
    return {
      outcome: "REGRESSED",
      key,
      current: id,
      previous,
      step: id - previous,
      previouslySeen: false,
    };
  }

  /** The last id seen on a key, or `undefined` when the key is unseen. */
  public lastIdFor(key: string): number | undefined {
    return this.#entries.get(key)?.lastId;
  }

  /** Whether an id is still inside the key's duplicate window. */
  public hasSeen(key: string, id: number): boolean {
    return this.#entries.get(key)?.recent.has(id) ?? false;
  }

  /** Number of keys currently tracked. */
  public get trackedKeys(): number {
    return this.#entries.size;
  }

  /** The configured bound on tracked keys. */
  public get maxKeys(): number {
    return this.#maxKeys;
  }

  /** The configured per-key duplicate window. */
  public get maxRecentIdsPerKey(): number {
    return this.#maxRecentIds;
  }

  /** Observations that arrived after the bound was reached and were not tracked. */
  public get untrackedObservations(): number {
    return this.#untrackedObservations;
  }

  /** A stable, sorted snapshot for the metrics surface. */
  public snapshot(): readonly SequenceState[] {
    return [...this.#entries.entries()]
      .map(([key, entry]) => ({
        key,
        lastId: entry.lastId,
        observations: entry.observations,
        recentIdsTracked: entry.recent.size,
      }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  }

  /** Records an id in the key's window, evicting the oldest when it is full. */
  #remember(entry: TrackedKey, id: number, identity: string): void {
    if (entry.recent.size >= this.#maxRecentIds) {
      const oldest = entry.recent.keys().next();
      if (!oldest.done) {
        entry.recent.delete(oldest.value);
      }
    }
    entry.recent.set(id, identity);
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
