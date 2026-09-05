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

  /** The `reference` section of a `packages/features` computation input. */
  featureInput(): Record<string, unknown> {
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
    return input;
  }
}
