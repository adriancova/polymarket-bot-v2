/**
 * Per-series observation history: first updates, unobserved intervals,
 * duplicates, and out-of-order arrivals.
 *
 * A "series" is one `(topic, symbol)` pair — which is one `(window, symbol)`
 * pair, because the topic IS the window. Everything this tracker knows is
 * something it OBSERVED; it never fills a hole. That is the whole point:
 * "Subscriptions start with the next update. There is no snapshot, history, or
 * replay after a disconnect", so the only truthful statements available are
 * "this is the first update I have received on this subscription", "the last one
 * I received was at T", and "the interval between them was not observed".
 *
 * ## Judge, then remember — in that order, and never together
 *
 * {@link TwapObservationTracker.judge} is PURE: it decides what an observation
 * is without recording anything. {@link TwapObservationTracker.remember} records
 * it, and is called only after the domain payload has been built and validated.
 * A rejected observation therefore does not reserve its identity, so a corrected
 * restatement is not suppressed as a duplicate of something that was never
 * published (the defect WP-090's review found in the sibling adapter).
 *
 * ## Two bounds, and what each costs
 *
 * Both bounds are this client's, not venue facts, and both consequences are
 * stated rather than hidden:
 *
 * 1. **`duplicateWindow` recent instants per series.** A redelivery older than
 *    the window is no longer recognized and is published as a late observation
 *    (flagged `outOfOrder`), not suppressed.
 * 2. **`maxTrackedSeries` series.** No symbol enumeration is published
 *    (RTDS-U4), so the key space is untrusted and cannot be left unbounded. When
 *    the bound is reached the least-recently-updated series is evicted and
 *    counted; if it reappears its next observation reports
 *    `firstObservationEver: true` again — which is why that field is documented
 *    as "first observation known to this adapter instance", not as a claim about
 *    the venue.
 */

import type { RtdsObservationQuality, RtdsUnobservedInterval } from "./result.js";

/** One observation, as the tracker needs to see it. */
export interface ObservationFacts {
  readonly topic: string;
  readonly symbol: string;
  /** Chainlink observation time. */
  readonly observationEpochMs: number;
  /** The same instant in ISO form. */
  readonly observationIso: string;
  /** The exact canonical decimal value this observation carries. */
  readonly value: string;
  /** The subscription this observation arrived under. */
  readonly subscriptionGeneration: number;
  /** When this process received the frame, for the age diagnostic. */
  readonly receivedEpochMs: number;
}

/** What an observation turned out to be, before anything is recorded. */
export type ObservationVerdict =
  | { readonly status: "accepted"; readonly quality: RtdsObservationQuality }
  | {
      readonly status: "duplicate";
      /** The instant this observation restates. */
      readonly previousObservationAt: string;
    }
  | {
      readonly status: "conflict";
      readonly previousObservationAt: string;
      /** The value already published for that instant. */
      readonly previousValue: string;
    };

interface RecentObservation {
  readonly epochMs: number;
  readonly value: string;
}

interface SeriesHistory {
  /** Bounded FIFO of recent instants, oldest first. */
  readonly recent: RecentObservation[];
  /** The newest observation instant seen for this series. */
  newestEpochMs: number;
  newestIso: string;
  /** The generation the newest observation arrived under. */
  newestGeneration: number;
  /** The generation of the most recent observation of any age. */
  lastGeneration: number;
}

export interface TwapObservationTrackerOptions {
  /** Recent instants remembered per series, for duplicate detection. */
  readonly duplicateWindow: number;
  /** Maximum number of `(topic, symbol)` series tracked at once. */
  readonly maxTrackedSeries: number;
}

export class TwapObservationTracker {
  readonly #options: TwapObservationTrackerOptions;
  /** Insertion-ordered, so the first key is the least recently updated. */
  readonly #series = new Map<string, SeriesHistory>();
  #evicted = 0;

  constructor(options: TwapObservationTrackerOptions) {
    this.#options = options;
  }

  /** How many series are currently tracked. */
  get trackedSeries(): number {
    return this.#series.size;
  }

  /** How many series have been evicted by the {@link maxTrackedSeries} bound. */
  get evictedSeries(): number {
    return this.#evicted;
  }

  /**
   * Decides what an observation is. Records NOTHING.
   *
   * @see TwapObservationTracker.remember
   */
  judge(facts: ObservationFacts): ObservationVerdict {
    const history = this.#series.get(seriesKey(facts.topic, facts.symbol));
    const observationAgeMs = facts.receivedEpochMs - facts.observationEpochMs;

    if (history === undefined) {
      return {
        status: "accepted",
        quality: {
          firstObservationEver: true,
          firstObservationOnSubscription: true,
          outOfOrder: false,
          observationAgeMs,
        },
      };
    }

    const restated = history.recent.find((entry) => entry.epochMs === facts.observationEpochMs);
    if (restated !== undefined) {
      const previousObservationAt = new Date(restated.epochMs).toISOString();
      return restated.value === facts.value
        ? { status: "duplicate", previousObservationAt }
        : { status: "conflict", previousObservationAt, previousValue: restated.value };
    }

    const firstOnSubscription = history.lastGeneration !== facts.subscriptionGeneration;
    const sincePreviousObservationMs = facts.observationEpochMs - history.newestEpochMs;
    const unobservedInterval: RtdsUnobservedInterval | undefined =
      firstOnSubscription && sincePreviousObservationMs > 0
        ? {
            fromAt: history.newestIso,
            toAt: facts.observationIso,
            durationMs: sincePreviousObservationMs,
            reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
            previousSubscriptionGeneration: history.newestGeneration,
          }
        : undefined;

    return {
      status: "accepted",
      quality: {
        firstObservationEver: false,
        firstObservationOnSubscription: firstOnSubscription,
        previousObservationAt: history.newestIso,
        sincePreviousObservationMs,
        ...(unobservedInterval === undefined ? {} : { unobservedInterval }),
        outOfOrder: sincePreviousObservationMs <= 0,
        observationAgeMs,
      },
    };
  }

  /**
   * Records an observation that has been published.
   *
   * Called only after the domain payload was built and accepted by its own
   * contract, so a refused observation never reserves its instant.
   */
  remember(facts: ObservationFacts): void {
    const key = seriesKey(facts.topic, facts.symbol);
    const existing = this.#series.get(key);
    const history: SeriesHistory = existing ?? {
      recent: [],
      newestEpochMs: facts.observationEpochMs,
      newestIso: facts.observationIso,
      newestGeneration: facts.subscriptionGeneration,
      lastGeneration: facts.subscriptionGeneration,
    };
    history.recent.push({ epochMs: facts.observationEpochMs, value: facts.value });
    while (history.recent.length > this.#options.duplicateWindow) history.recent.shift();
    if (facts.observationEpochMs >= history.newestEpochMs) {
      history.newestEpochMs = facts.observationEpochMs;
      history.newestIso = facts.observationIso;
      history.newestGeneration = facts.subscriptionGeneration;
    }
    history.lastGeneration = facts.subscriptionGeneration;
    // Re-insertion moves the key to the end of the iteration order, which is
    // what makes the first key the least recently updated one.
    this.#series.delete(key);
    this.#series.set(key, history);
    this.#evictOverflow();
  }

  #evictOverflow(): void {
    while (this.#series.size > this.#options.maxTrackedSeries) {
      const oldest = this.#series.keys().next();
      if (oldest.done === true) return;
      this.#series.delete(oldest.value);
      this.#evicted += 1;
    }
  }
}

/**
 * Composes a series key from two untrusted strings.
 *
 * Length-prefixed rather than separator-joined: a symbol containing the
 * separator would otherwise be able to collide with another series' key, and no
 * symbol grammar is published that would rule that out (RTDS-U4).
 */
function seriesKey(topic: string, symbol: string): string {
  return `${String(topic.length)}:${topic}:${symbol}`;
}
