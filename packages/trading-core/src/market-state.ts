/**
 * Per-market local state: books, lifecycle, the trade window, and the active
 * data-quality incidents — handoff §8.1 step 2, "update local market/account
 * state".
 *
 * This is the trader's own state, and it is deliberately the SMALLEST thing
 * that can answer the three questions the rest of the loop asks:
 *
 * 1. what does the book look like right now (§9.4, `packages/order-book`);
 * 2. what does the feature engine need to compute a snapshot (§9.5,
 *    `packages/features`);
 * 3. what do the SDK views a strategy sees look like (§7.6).
 *
 * ## Books are the merged package's, not a reimplementation
 *
 * `MarketOutcomeBooks` owns ADR-013's semantics (absolute sizes,
 * replace-not-accumulate, `"0"` removes the level), the epoch and
 * subscription-generation gating, and the exact-decimal queries. This module
 * routes payloads into it and reads its answers; it computes no book arithmetic
 * of its own. A refusal from the book is a REFUSAL here too — the loop halts
 * the market with `BOOK_DESYNCHRONIZED` — because §9.8 check 8 ("book is
 * synchronized") is a risk gate, and a book that refused an update is a book
 * that no longer describes the venue.
 *
 * ## The trade window is bounded and time-ordered
 *
 * `packages/features` computes its trade-derived features from a window of
 * observed trades. The window here is bounded by BOTH a count and the
 * configured `tradeWindowMs`, evicting oldest-first, so an event storm cannot
 * grow it without limit (§8.3's spirit applied to state, not just to queues)
 * and a quiet market cannot carry stale trades into a fresh snapshot.
 *
 * ## Incidents are STATE, not a derived guess
 *
 * `DataQualityIncidentOpened` / `Closed` are §7.4 events, so the active set is
 * maintained from them rather than inferred from staleness. The strategy's
 * data-quality gate reads the projected flag, and "an absent or wrong-typed
 * flag counts as an incident, never as an all-clear" — which is the projection's
 * rule (`projection.ts`), not this module's; here the set is simply the truth
 * the feed reported.
 *
 * NO CLOCK. Every instant arrives as an argument, already normalised to strict
 * UTC by `time.ts`.
 */

import { MarketOutcomeBooks, serializeBook, type OutcomeTokenBook } from "@polymarket-bot/order-book";
import type { MarketView, OrderBookView } from "@polymarket-bot/strategy-sdk";

import type { MarketConfig } from "./config.js";

/** One observed public trade, kept for the feature engine's window. */
export interface ObservedTradeRecord {
  readonly price: string;
  readonly size: string;
  readonly takerSide?: "BID" | "ASK";
  readonly observedAt: string;
  readonly observedAtEpochMs: number;
  readonly tokenId: string;
}

/** One active data-quality incident, as §7.4 reported it. */
export interface ActiveIncident {
  readonly incidentId: string;
  readonly reasonCode: string;
  readonly severity: "PAGE" | "NOTIFY" | "LOG";
  readonly feedId?: string;
}

export type MarketLifecycle = "PENDING" | "OPEN" | "CLOSING" | "RESOLVED";

export interface BookApplyProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * The trader's state for one configured market.
 *
 * The market's identity and versioned trading parameters come from the
 * configuration (§6 invariant 9: "Market rules, settlement specs, fee
 * schedules, tick sizes, minimum sizes, and delays are versioned. Historical
 * runs use historical parameters"), so a run is pinned to the parameters it was
 * configured with rather than to whatever the feed most recently said.
 */
export class MarketState {
  readonly config: MarketConfig;
  readonly books: MarketOutcomeBooks;

  #lifecycle: MarketLifecycle = "PENDING";
  #lastEventAt: string | undefined;
  #lastEventAtEpochMs: number | undefined;
  #resolvedOutcome: string | undefined;
  #resolvedAt: string | undefined;
  #trades: ObservedTradeRecord[] = [];
  readonly #incidents = new Map<string, ActiveIncident>();
  readonly #tradeWindowMs: number;
  readonly #maximumTrades: number;

  constructor(options: {
    readonly config: MarketConfig;
    readonly tradeWindowMs: number;
    readonly maximumTrades: number;
  }) {
    this.config = options.config;
    this.#tradeWindowMs = options.tradeWindowMs;
    this.#maximumTrades = options.maximumTrades;
    this.books = new MarketOutcomeBooks({
      internalMarketId: options.config.marketId,
      yesTokenId: options.config.yesTokenId,
      noTokenId: options.config.noTokenId,
    });
  }

  get lifecycle(): MarketLifecycle {
    return this.#lifecycle;
  }

  get resolvedOutcome(): string | undefined {
    return this.#resolvedOutcome;
  }

  get resolvedAt(): string | undefined {
    return this.#resolvedAt;
  }

  get lastEventAt(): string | undefined {
    return this.#lastEventAt;
  }

  get lastEventAtEpochMs(): number | undefined {
    return this.#lastEventAtEpochMs;
  }

  /** Every active incident, ordered by id so the feature input is stable. */
  activeIncidents(): readonly ActiveIncident[] {
    return Object.freeze(
      [...this.#incidents.values()].sort((left, right) =>
        left.incidentId < right.incidentId ? -1 : left.incidentId > right.incidentId ? 1 : 0,
      ),
    );
  }

  openIncident(incident: ActiveIncident): void {
    this.#incidents.set(incident.incidentId, incident);
  }

  closeIncident(incidentId: string): void {
    this.#incidents.delete(incidentId);
  }

  markLifecycle(lifecycle: MarketLifecycle): void {
    this.#lifecycle = lifecycle;
  }

  markResolved(outcome: string, at: string): void {
    this.#lifecycle = "RESOLVED";
    this.#resolvedOutcome = outcome;
    this.#resolvedAt = at;
  }

  /** Records the instant of the most recent applied event (already strict UTC). */
  observeInstant(at: string, epochMs: number): void {
    this.#lastEventAt = at;
    this.#lastEventAtEpochMs = epochMs;
  }

  /**
   * Adds one observed trade and prunes the window.
   *
   * Pruned by BOTH bounds, oldest-first: age against `tradeWindowMs` measured
   * from the new trade's own instant, and count against `maximumTrades`. The
   * count bound exists because a burst inside one window is unbounded without
   * it.
   */
  observeTrade(trade: ObservedTradeRecord): void {
    this.#trades.push(trade);
    const horizon = trade.observedAtEpochMs - this.#tradeWindowMs;
    this.#trades = this.#trades.filter((member) => member.observedAtEpochMs >= horizon);
    if (this.#trades.length > this.#maximumTrades) {
      this.#trades = this.#trades.slice(this.#trades.length - this.#maximumTrades);
    }
  }

  /** The current trade window, oldest first. */
  trades(): readonly ObservedTradeRecord[] {
    return Object.freeze([...this.#trades]);
  }

  bookFor(outcome: "YES" | "NO"): OutcomeTokenBook {
    return outcome === "YES" ? this.books.yesBook : this.books.noBook;
  }

  /** The canonical order-book v1 serialization the feature engine reads. */
  serializedBook(outcome: "YES" | "NO"): string {
    return serializeBook(this.bookFor(outcome));
  }

  /**
   * The §7.6 `MarketView` a strategy sees.
   *
   * `openTime` / `closeTime` are the CONFIGURED, already-normalised instants:
   * obligation 1 requires strict UTC here, and the configuration is normalised
   * once at startup rather than on every evaluation.
   */
  marketView(input: {
    readonly openTime: string;
    readonly closeTime: string;
  }): MarketView {
    return Object.freeze({
      marketId: this.config.marketId,
      conditionId: this.config.conditionId,
      yesTokenId: this.config.yesTokenId,
      noTokenId: this.config.noTokenId,
      tickSize: this.config.tickSize,
      minimumOrderSize: this.config.minimumOrderSize,
      openTime: input.openTime,
      closeTime: input.closeTime,
    });
  }

  /**
   * The §7.6 `OrderBookView` for one outcome.
   *
   * `asOf` is the instant of the last event APPLIED TO THIS BOOK, not the
   * loop's current instant: the strategy's staleness gate
   * (`data_quality.maximum_book_age_ms`) measures exactly that distance, and a
   * view stamped with "now" would make every book look fresh.
   */
  bookView(outcome: "YES" | "NO", fallbackAsOf: string): OrderBookView {
    const book = this.bookFor(outcome);
    const lastUpdate = book.lastUpdate();
    return Object.freeze({
      bids: Object.freeze(
        book.levels("BID").map((level) =>
          Object.freeze({ price: level.price, shares: level.size }),
        ),
      ),
      asks: Object.freeze(
        book.levels("ASK").map((level) =>
          Object.freeze({ price: level.price, shares: level.size }),
        ),
      ),
      asOf: lastUpdate?.receivedAt ?? fallbackAsOf,
    });
  }
}
