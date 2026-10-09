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
 * of its own. A refusal from the book is a REFUSAL here too, classified by
 * `book-refusals.ts` (`C1-HALTS`): a benign drop is counted; a divergence
 * clears that book's baseline and delivery-session key
 * ({@link MarketState.noteBookRefusal}), so §9.8 check 8 ("book is
 * synchronized") refuses the market's placements until the next applied
 * snapshot re-arms it; a contract or programming fault halts the run.
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
import { prepareEvaluationView } from "@polymarket-bot/strategy-runtime";
import type { MarketView, OrderBookView } from "@polymarket-bot/strategy-sdk";

import type { BookRefusalClass, BookRefusalCounts } from "./book-refusals.js";
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

/** `THROUGHPUT-1a`: prepared level objects one market keeps (see `MarketState` `#levelView`). */
const LEVEL_VIEW_LIMIT = 4_096;

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

  /** Whether any data-quality incident is active for this market (ADR-023 rule 5). */
  hasActiveIncident(): boolean {
    return this.#incidents.size > 0;
  }

  openIncident(incident: ActiveIncident): void {
    this.#incidents.set(incident.incidentId, incident);
  }

  /** Whether this market's active set holds the incident (`C1-HALTS`: a close is routed by it). */
  holdsIncident(incidentId: string): boolean {
    return this.#incidents.has(incidentId);
  }

  closeIncident(incidentId: string): void {
    this.#incidents.delete(incidentId);
  }

  /**
   * Moves the market's lifecycle, and answers whether it moved. A RESOLUTION
   * IS TERMINAL (`ROLLOVER-1` r4, R4-ASTRA-02): once a resolution is applied
   * (`markResolved`), a later `MarketOpened` or `MarketClosing` — a lifecycle
   * poll that answers after the resolution was published, which needs no
   * fault (the gateway's lifecycle feed and its market channel are separate
   * paths) — changes nothing and answers `false`. Until r4 it overwrote
   * `RESOLVED`, which re-armed `onMarketResolved` for a repeated resolution
   * and hid the resolution from the window teardown.
   */
  markLifecycle(lifecycle: MarketLifecycle): boolean {
    if (this.#resolvedOutcome !== undefined) return false;
    this.#lifecycle = lifecycle;
    return true;
  }

  /**
   * Applies the market's resolution, and answers whether it was applied. A
   * market resolves ONCE (`ROLLOVER-1` r3 and r4): a repeat — the gateway
   * re-publishes a resolution an earlier epoch could not record as published,
   * and the market channel may deliver one twice — is judged on the
   * resolution EVIDENCE (`resolvedOutcome`), which nothing overwrites, changes
   * nothing, and answers `false`. The first resolution stands.
   */
  markResolved(outcome: string, at: string): boolean {
    if (this.#resolvedOutcome !== undefined) return false;
    this.#lifecycle = "RESOLVED";
    this.#resolvedOutcome = outcome;
    this.#resolvedAt = at;
    return true;
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

  /**
   * `THROUGHPUT-1c` (ADR-023): records the delivery session — the
   * `book-freshness.ts` session key — of the update just APPLIED to one
   * outcome's book, or `undefined` when that update carried none (a REST
   * snapshot). Called only after the book accepted the update, so the key
   * always describes the book's current last update.
   */
  noteBookSession(outcome: "YES" | "NO", sessionKey: string | undefined): void {
    this.#bookSessions[outcome] = sessionKey;
  }

  /**
   * `C1-HALTS` (BOOK-WAITS): records one refused book update the loop did not
   * halt on. A `DIVERGENCE` clears that outcome's baseline — risk check 8
   * then refuses the market's placements, entries and reductions alike — and
   * its delivery-session key, so no sibling frame on the session can vouch
   * for a book known to be behind (ADR-023 rule 2: its age is its last
   * APPLIED change). The next applied `BookSnapshot` re-baselines the book and
   * notes its session again: nothing else re-arms it, and nothing needs to.
   */
  noteBookRefusal(refusalClass: Exclude<BookRefusalClass, "FAULT">, outcome: "YES" | "NO"): void {
    if (refusalClass === "BENIGN") {
      this.#bookRefusals.benign += 1;
      return;
    }
    this.#bookRefusals.divergence += 1;
    this.bookFor(outcome).clearBaseline();
    this.#bookSessions[outcome] = undefined;
  }

  /** `C1-HALTS`: this market's book-refusal counts, and which books wait for a snapshot. */
  bookRefusals(): BookRefusalCounts {
    const waiting = (["NO", "YES"] as const).filter((outcome) => this.bookFor(outcome).baseline() === undefined);
    return Object.freeze({
      benign: this.#bookRefusals.benign,
      divergence: this.#bookRefusals.divergence,
      waiting: Object.freeze(waiting),
    });
  }

  readonly #bookRefusals = { benign: 0, divergence: 0 };

  /** The delivery session of one outcome's last applied update (ADR-023). */
  bookSession(outcome: "YES" | "NO"): string | undefined {
    return this.#bookSessions[outcome];
  }

  readonly #bookSessions: { YES: string | undefined; NO: string | undefined } = {
    YES: undefined,
    NO: undefined,
  };

  /** The outcome a token id names in this market, if either. */
  outcomeOfToken(tokenId: string | undefined): "YES" | "NO" | undefined {
    if (tokenId === this.config.yesTokenId) return "YES";
    if (tokenId === this.config.noTokenId) return "NO";
    return undefined;
  }

  /**
   * The canonical order-book v1 serialization the feature engine reads.
   *
   * `THROUGHPUT-1a` (PERFORMANCE ONLY): memoized per outcome under the book's
   * own revision — `updatesApplied()`, which `packages/order-book` advances on
   * every applied snapshot and level change (the only paths that change the
   * levels, the baseline, the last update or the venue hash), plus the tick
   * size (the one serialized field a tick-size change moves). A refused update
   * changes nothing and advances nothing. The books are this object's own
   * (`new MarketOutcomeBooks` above), so the counter is the book's, not a
   * caller's. Each event changes at most one token's book, so the other
   * outcome's text is reused instead of re-serialized — the same string.
   */
  serializedBook(outcome: "YES" | "NO"): string {
    const book = this.bookFor(outcome);
    const updates = book.updatesApplied();
    const tickSize = book.tickSize();
    const cached = this.#serialized[outcome];
    if (cached !== undefined && cached.updates === updates && cached.tickSize === tickSize) {
      return cached.text;
    }
    const text = serializeBook(book);
    this.#serialized[outcome] = { updates, tickSize, text };
    return text;
  }

  /** `THROUGHPUT-1a`: the memo behind {@link serializedBook}, per outcome. */
  readonly #serialized: {
    YES?: { readonly updates: number; readonly tickSize: string | undefined; readonly text: string };
    NO?: { readonly updates: number; readonly tickSize: string | undefined; readonly text: string };
  } = {};

  /**
   * `THROUGHPUT-1a`: one level of a view, `{ price, shares }`, as the strategy
   * runtime's prepared (inert, frozen) object — the same data as a fresh
   * frozen literal. A level change alters ONE level, so a view rebuilt after
   * it reuses every other level's prepared object. Bounded, oldest first out.
   */
  #levelView(price: string, shares: string): unknown {
    const key = `${price} ${shares}`;
    const cached = this.#levelViews.get(key);
    if (cached !== undefined) return cached;
    const prepared = prepareEvaluationView(Object.freeze({ price, shares }));
    this.#levelViews.set(key, prepared);
    if (this.#levelViews.size > LEVEL_VIEW_LIMIT) {
      const oldest = this.#levelViews.keys().next();
      if (oldest.done !== true) this.#levelViews.delete(oldest.value);
    }
    return prepared;
  }

  readonly #levelViews = new Map<string, unknown>();

  /**
   * `THROUGHPUT-1a`: one side's ladder of a view, `[{ price, shares }, …]`
   * (bids descending, asks ascending), as the strategy runtime's prepared
   * array — reused while that side's ladder is unchanged, which is the case
   * for three of the four sides after any level change. Keyed by the ladder's
   * exact content.
   */
  #sideView(outcome: "YES" | "NO", side: "BID" | "ASK", book: OutcomeTokenBook): unknown {
    const levels = book.levels(side);
    let key = "";
    for (const level of levels) key += `${level.price} ${level.size}\n`;
    const slot = `${outcome}:${side}`;
    const cached = this.#sideViews.get(slot);
    if (cached !== undefined && cached.key === key) return cached.view;
    const view = prepareEvaluationView(
      Object.freeze(levels.map((level) => this.#levelView(level.price, level.size))),
    );
    this.#sideViews.set(slot, { key, view });
    return view;
  }

  readonly #sideViews = new Map<string, { readonly key: string; readonly view: unknown }>();

  /** `THROUGHPUT-1a`: the memo behind {@link bookView}, per outcome. */
  readonly #views: {
    YES?: { readonly updates: number; readonly fallbackAsOf: string | undefined; readonly view: OrderBookView };
    NO?: { readonly updates: number; readonly fallbackAsOf: string | undefined; readonly view: OrderBookView };
  } = {};

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
    // `THROUGHPUT-1a` (PERFORMANCE ONLY): the view is deep-frozen and a pure
    // function of the book's levels and last update — which only an applied
    // update changes, and every applied update advances `updatesApplied()` —
    // and, only when the last update carries no `receivedAt`, of
    // `fallbackAsOf`. So one frozen view is shared while those are unchanged
    // (see `serializedBook`).
    const book = this.bookFor(outcome);
    const updates = book.updatesApplied();
    const lastUpdate = book.lastUpdate();
    const fallback = lastUpdate?.receivedAt === undefined ? fallbackAsOf : undefined;
    const cached = this.#views[outcome];
    if (cached !== undefined && cached.updates === updates && cached.fallbackAsOf === fallback) {
      return cached.view;
    }
    const built = Object.freeze({
      bids: this.#sideView(outcome, "BID", book),
      asks: this.#sideView(outcome, "ASK", book),
      asOf: lastUpdate?.receivedAt ?? fallbackAsOf,
    });
    // The strategy runtime's own inert copy of this view, which its
    // input acquisition then reuses rather than re-reading and re-freezing
    // (`packages/strategy-runtime` `prepareEvaluationView`): the same data.
    // Its levels are already the runtime's own (`#levelView`), so preparing
    // the view copies two arrays and one instant, not every level.
    const view = prepareEvaluationView(built) as OrderBookView;
    this.#views[outcome] = { updates, fallbackAsOf: fallback, view };
    return view;
  }
}
