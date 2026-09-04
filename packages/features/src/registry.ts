/**
 * The versioned feature registry (WP-160 deliverable 1; handoff §9.5:
 * "Feature definitions are registered and versioned").
 *
 * Feature set v1 is EXACTLY the §9.5 minimum list, expanded to one definition
 * per (venue, horizon) where the handoff names a family. Every definition
 * carries its own version, and the set as a whole is versioned by
 * {@link FEATURE_SET_VERSION}; both are part of every snapshot's
 * content-addressed body, so changing a definition (or the set) changes every
 * address computed under it. Changing a feature's SEMANTICS — including the
 * pinned division policy (`decimal-policy.ts`) — requires bumping that
 * feature's version and re-recording the contract in
 * `docs/contracts/features-v1.md`; recomputing history under new semantics
 * with old ids is exactly what content addressing exists to prevent (§6
 * invariant 9: versioned parameters; historical runs use historical
 * parameters).
 *
 * The registry is DATA. The engine (`snapshot.ts`) asserts that the set of
 * computed feature ids is EXACTLY the registry's id set and refuses the whole
 * snapshot otherwise, so a definition without a computation — or a computation
 * without a definition — is a loud failure, never a silent gap.
 */

export type FeatureCategory = "polymarket" | "reference" | "lifecycle" | "quality";

export interface FeatureDefinition {
  /** Stable dot-path identifier; unique within the set. */
  readonly id: string;
  /** Version of this feature's semantics. Bumped on ANY semantic change. */
  readonly version: number;
  readonly category: FeatureCategory;
  /** What the value means; the normative text lives in features-v1.md. */
  readonly description: string;
}

/** The versioned identity of feature set v1. */
export const FEATURE_SET_VERSION = "polymarket-bot/features/v1";

/** The return/agreement horizons (§9.5: 250ms, 1s, 5s, 30s). Frozen data. */
export const RETURN_HORIZONS = Object.freeze(
  [
    Object.freeze({ label: "250ms", ms: 250 }),
    Object.freeze({ label: "1s", ms: 1_000 }),
    Object.freeze({ label: "5s", ms: 5_000 }),
    Object.freeze({ label: "30s", ms: 30_000 }),
  ] as const,
);

/** The Chainlink TWAP windows (§9.5: 30s/60s where configured). Frozen data. */
export const TWAP_WINDOWS_SECONDS = Object.freeze([30, 60] as const);

const REFERENCE_VENUES = ["binance", "coinbase"] as const;

function define(id: string, category: FeatureCategory, description: string): FeatureDefinition {
  return Object.freeze({ id, version: 1, category, description });
}

const POLYMARKET_FEATURES: readonly FeatureDefinition[] = [
  define("polymarket.best_bid", "polymarket", "Best resting bid price and size; ABSENT on an empty bid side."),
  define("polymarket.best_ask", "polymarket", "Best resting ask price and size; ABSENT on an empty ask side."),
  define("polymarket.midpoint", "polymarket", "Exact (bestBid + bestAsk) / 2; ABSENT unless both sides are present."),
  define("polymarket.spread", "polymarket", "Exact bestAsk - bestBid; ABSENT unless both sides are present."),
  define(
    "polymarket.depth_at_levels",
    "polymarket",
    "Exact share sums over the top N levels per side for each configured N; an empty side sums to \"0\" (zero shares genuinely rest there).",
  ),
  define(
    "polymarket.executable_buy_price",
    "polymarket",
    "Volume-weighted executable BUY price per configured quantity (walking asks best-first); per-quantity INSUFFICIENT_DEPTH outcome when the book cannot fill, never a partial answer.",
  ),
  define(
    "polymarket.executable_sell_price",
    "polymarket",
    "Volume-weighted executable SELL price per configured quantity (walking bids best-first); per-quantity INSUFFICIENT_DEPTH outcome when the book cannot fill, never a partial answer.",
  ),
  define(
    "polymarket.order_book_imbalance",
    "polymarket",
    "bidShares / (bidShares + askShares) under the pinned division policy; ABSENT when both sides are empty.",
  ),
  define(
    "polymarket.microprice",
    "polymarket",
    "(bestBidPrice*bestAskSize + bestAskPrice*bestBidSize) / (bestBidSize + bestAskSize) under the pinned division policy; ABSENT unless both sides are present.",
  ),
  define(
    "polymarket.recent_trades",
    "polymarket",
    "Aggressor-direction volumes (ADR-014 vocabulary) and counts over the configured window ending at asOf; ABSENT when the trades feed input is missing.",
  ),
];

function returnFeatures(): FeatureDefinition[] {
  const features: FeatureDefinition[] = [];
  for (const venue of REFERENCE_VENUES) {
    for (const horizon of RETURN_HORIZONS) {
      features.push(
        define(
          `reference.${venue}.return_${horizon.label}`,
          "reference",
          `Simple return of the ${venue} reference price over ${horizon.label}: (p(asOf) - p(asOf - ${horizon.label})) / p(asOf - ${horizon.label}), each endpoint the latest trade at or before its instant.`,
        ),
      );
    }
  }
  return features;
}

function agreementFeatures(): FeatureDefinition[] {
  return RETURN_HORIZONS.map((horizon) =>
    define(
      `reference.cross_venue.direction_agreement_${horizon.label}`,
      "reference",
      `Sign agreement of the binance and coinbase ${horizon.label} returns: AGREE (both nonzero, same sign), DISAGREE (both nonzero, opposite), NEUTRAL (either zero).`,
    ),
  );
}

const REFERENCE_FEATURES: readonly FeatureDefinition[] = [
  ...returnFeatures(),
  define(
    "reference.cross_venue.midpoint_difference",
    "reference",
    "binance top-of-book midpoint minus coinbase top-of-book midpoint, both exact halvings; ABSENT unless both venues supply both sides.",
  ),
  ...agreementFeatures(),
  define(
    "reference.binance.ewma_realized_volatility",
    "reference",
    "Square root (deterministic Newton, pinned policy) of the EWMA of squared consecutive simple returns over the supplied binance series, with the configured lambda.",
  ),
  define(
    "reference.coinbase.ewma_realized_volatility",
    "reference",
    "Square root (deterministic Newton, pinned policy) of the EWMA of squared consecutive simple returns over the supplied coinbase series, with the configured lambda.",
  ),
  define(
    "reference.chainlink.twap_30s",
    "reference",
    "Latest supplied Chainlink 30s TWAP observation at or before asOf; ABSENT NOT_CONFIGURED when no chainlink input is supplied.",
  ),
  define(
    "reference.chainlink.twap_60s",
    "reference",
    "Latest supplied Chainlink 60s TWAP observation at or before asOf; ABSENT NOT_CONFIGURED when no chainlink input is supplied.",
  ),
];

const LIFECYCLE_FEATURES: readonly FeatureDefinition[] = [
  define("lifecycle.time_to_close_ms", "lifecycle", "closesAt - asOf in integer milliseconds; negative after the close; ABSENT when closesAt is not supplied."),
  define("lifecycle.time_since_open_ms", "lifecycle", "asOf - openedAt in integer milliseconds; ABSENT when openedAt is not supplied."),
  define("lifecycle.market_duration_ms", "lifecycle", "closesAt - openedAt in integer milliseconds; ABSENT unless both are supplied."),
  define(
    "lifecycle.reference_open_distance",
    "lifecycle",
    "Latest primary-venue reference price minus the reference price at market open (exact subtraction); ABSENT when either is unavailable.",
  ),
];

const QUALITY_FEATURES: readonly FeatureDefinition[] = [
  define(
    "quality.input_feed_ages",
    "quality",
    "asOf minus each supplied feed's lastEventAt, in integer milliseconds, one entry per input feed present, sorted by feedId; negative ages reported as-is (never clamped).",
  ),
  define(
    "quality.active_incidents",
    "quality",
    "The active data-quality incident flags supplied with the input, sorted by incidentId; an empty array means no active incident was supplied.",
  ),
];

function assertUniqueSortedIds(features: readonly FeatureDefinition[]): readonly FeatureDefinition[] {
  const sorted = [...features].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && previous.id === current.id) {
      // A duplicate id is a programming error in this module; it must fail the
      // module load loudly rather than ship an ambiguous registry.
      throw new Error(`duplicate feature id in the v1 registry: ${current.id}`);
    }
  }
  return Object.freeze(sorted);
}

/** Feature set v1: every §9.5 minimum feature, sorted by id, frozen. */
export const FEATURES_V1: readonly FeatureDefinition[] = assertUniqueSortedIds([
  ...POLYMARKET_FEATURES,
  ...REFERENCE_FEATURES,
  ...LIFECYCLE_FEATURES,
  ...QUALITY_FEATURES,
]);

/** The v1 feature ids, in registry (sorted) order. */
export const FEATURE_IDS_V1: readonly string[] = Object.freeze(FEATURES_V1.map((feature) => feature.id));

const BY_ID = new Map(FEATURES_V1.map((feature) => [feature.id, feature]));

/** Looks a definition up by id, or `undefined`. */
export function featureDefinition(id: string): FeatureDefinition | undefined {
  return BY_ID.get(id);
}
