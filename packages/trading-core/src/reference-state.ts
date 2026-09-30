/**
 * Process-scoped reference-feed state — §9.5's reference inputs and §9.8 check
 * 7's freshness measurement.
 *
 * Two consumers need it, and both are the reason it exists rather than a
 * convenience:
 *
 * 1. **`packages/features`** computes the whole `reference.*` half of feature
 *    set v1 (returns, realized volatility, cross-venue agreement, the Chainlink
 *    TWAPs) from a per-venue price series. Without one, every reference feature
 *    is `ABSENT` — which is honest, and is what happens when no reference feed
 *    is configured.
 * 2. **`packages/risk` check 7.** §9.9 row 1 — "External reference feed stale,
 *    Polymarket healthy → Cancel signal-dependent quotes; halt new entries" —
 *    is implemented there as a refusal when the `REFERENCE_FEED` finding
 *    BLOCKS, and an UNMEASURED feed blocks exactly as a stale one does
 *    (`RISK_FRESHNESS_UNKNOWN`). So a trader that consumed reference events but
 *    never measured their age would be refused every entry, and one that never
 *    consumed them at all would be refused every entry for a reason it could
 *    not report. This module is the measurement.
 *
 * REFERENCE EVENTS ARE NOT MARKET-SCOPED. `ReferenceTradeObserved` names a
 * `(venue, symbol)` pair, not an `internalMarketId` — a BTC print informs every
 * BTC market at once — so this state is held by the process and read by every
 * market's snapshot.
 *
 * BOUNDED. The series per venue is capped by count and by the configured
 * window, oldest-first, for the same reason every queue is (§8.3): an event
 * storm may not become an unbounded memory commitment.
 *
 * NO CLOCK. Instants arrive as arguments, already strict UTC.
 */

import { prepareReferenceInput } from "@polymarket-bot/features";

export type ReferenceVenueName = "binance" | "coinbase";

export interface ReferencePoint {
  readonly price: string;
  readonly observedAt: string;
  readonly observedAtEpochMs: number;
}

interface VenueSeries {
  readonly symbol: string;
  lastEventAt: string;
  lastEventAtEpochMs: number;
  points: ReferencePoint[];
}

export class ReferenceState {
  readonly #series = new Map<ReferenceVenueName, VenueSeries>();
  readonly #windowMs: number;
  readonly #maximumPoints: number;
  /**
   * `THROUGHPUT-1a` (PERFORMANCE ONLY): the last {@link featureInput} answer
   * until the next {@link observe} changes the series. Every evaluation asks
   * for it and only a reference trade changes it (H1's burst: ~28 a second
   * against ~660 evaluations). It is the section as `packages/features`'
   * `prepareReferenceInput` returns it — that package's own frozen copy, which
   * its snapshot computation recognizes and reads, validates, copies and
   * serializes ONCE instead of on every evaluation. The snapshot is the one
   * the raw section produces, byte for byte.
   */
  #featureInput: unknown;

  constructor(options: { readonly windowMs: number; readonly maximumPoints: number }) {
    this.#windowMs = options.windowMs;
    this.#maximumPoints = options.maximumPoints;
  }

  /** Records one observed reference trade. */
  observe(input: {
    readonly venue: ReferenceVenueName;
    readonly symbol: string;
    readonly price: string;
    readonly observedAt: string;
    readonly observedAtEpochMs: number;
  }): void {
    const existing = this.#series.get(input.venue);
    const series: VenueSeries = existing ?? {
      symbol: input.symbol,
      lastEventAt: input.observedAt,
      lastEventAtEpochMs: input.observedAtEpochMs,
      points: [],
    };
    series.lastEventAt = input.observedAt;
    series.lastEventAtEpochMs = input.observedAtEpochMs;
    series.points.push({
      price: input.price,
      observedAt: input.observedAt,
      observedAtEpochMs: input.observedAtEpochMs,
    });
    const horizon = input.observedAtEpochMs - this.#windowMs;
    series.points = series.points.filter((point) => point.observedAtEpochMs >= horizon);
    if (series.points.length > this.#maximumPoints) {
      series.points = series.points.slice(series.points.length - this.#maximumPoints);
    }
    this.#series.set(input.venue, series);
    this.#featureInput = undefined;
  }

  /**
   * The age in milliseconds of the most recent reference event across every
   * venue, or `undefined` when none has been seen.
   *
   * `undefined` is the honest answer for "not measured", and the loop
   * propagates it as an ABSENT freshness observation rather than as a large
   * age — §9.8 distinguishes `STALE` from `UNKNOWN` and both fail closed, but
   * only one of them is true.
   */
  ageMs(nowEpochMs: number): number | undefined {
    let newest: number | undefined;
    for (const series of this.#series.values()) {
      if (newest === undefined || series.lastEventAtEpochMs > newest) {
        newest = series.lastEventAtEpochMs;
      }
    }
    return newest === undefined ? undefined : Math.max(0, nowEpochMs - newest);
  }

  /**
   * The `reference` section of a `packages/features` computation input.
   *
   * `THROUGHPUT-1a`: prepared by `packages/features`, and the SAME object
   * until the next `observe` (see `#featureInput`). The content is exactly
   * what it always was: one entry per venue with points, each `{symbol,
   * lastEventAt, trades: [{price, observedAt}]}`, venues in first-observation
   * order.
   */
  featureInput(): unknown {
    if (this.#featureInput !== undefined) return this.#featureInput;
    const input: Record<string, unknown> = {};
    for (const [venue, series] of this.#series) {
      if (series.points.length === 0) continue;
      input[venue] = {
        symbol: series.symbol,
        lastEventAt: series.lastEventAt,
        trades: series.points.map((point) => ({
          price: point.price,
          observedAt: point.observedAt,
        })),
      };
    }
    this.#featureInput = prepareReferenceInput(input);
    return this.#featureInput;
  }
}
