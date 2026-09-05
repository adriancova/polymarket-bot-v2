/**
 * Binding this strategy's triggers to the REAL WP-160 feature registry.
 *
 * §13.2 names a `trigger_basis` of `executable_ask` / `executable_bid`. Those
 * are the handoff's words for two features the engine actually computes, and
 * this module is where the words are bound to the ids
 * `docs/contracts/features-v1.md` §7 registers:
 *
 * | §13.2 basis       | v1 feature id                       |
 * | ----------------- | ----------------------------------- |
 * | `executable_ask`  | `polymarket.executable_buy_price`   |
 * | `executable_bid`  | `polymarket.executable_sell_price`  |
 *
 * The buy price walks the ASKS (what an aggressive buyer pays), the sell price
 * walks the BIDS (what an aggressive seller receives), so the mapping is the
 * identity of meaning, not a naming coincidence.
 *
 * WHY A CONFIGURED KEY AND NOT JUST AN ID. The SDK view a strategy sees
 * (`FeatureSnapshot.values`) is a flat map of SCALARS
 * (`DecimalString | string | boolean | null`), while both executable-price
 * features are STRUCTURED (one outcome per configured quantity, each either a
 * quote or a typed `INSUFFICIENT_DEPTH`). Something between the engine and the
 * runtime must therefore project a structured feature onto a scalar key, and
 * that projection is the composition root's (WP-230). This package refuses to
 * guess it. Instead the operator states the exact key in the configuration, and
 * this module enforces that the key NAMES A REAL v1 FEATURE:
 *
 *     key := featureId | featureId "@" selector
 *     selector := [A-Za-z0-9_.:+-]{1,32}
 *
 * `featureId` must be a member of {@link FEATURE_IDS_V1} — a trigger naming a
 * feature that does not exist is refused at configuration validation, by name —
 * and it must be the id the declared basis maps to. The optional `@selector`
 * suffix is the projection coordinate (for example the configured quantity of
 * an executable-price feature); it is opaque to this strategy, and `@` is this
 * package's declared, versioned separator. Any other shape is refused.
 *
 * {@link FEATURE_IDS_V1} is a COPY of the v1 registry, because
 * `packages/features` is layer 1 like this package and no §2.1 same-layer edge
 * permits importing it (F13). The copy is bound to the original two ways by
 * `test/unit/strategies/static-bracket/feature-binding.test.ts`: against the
 * shipped `FEATURE_IDS_V1` of `packages/features`, and against the registry
 * table in `docs/contracts/features-v1.md`. A drift in either fails the suite.
 */

import { bad, ok, type Outcome } from "./plain.js";

/**
 * Feature set v1 (`polymarket-bot/features/v1`), all 33 ids, registry (sorted)
 * order. Copied from `packages/features/src/registry.ts`; see the module
 * comment for the two mechanical bindings that keep the copy honest.
 */
export const FEATURE_IDS_V1: readonly string[] = Object.freeze([
  "lifecycle.market_duration_ms",
  "lifecycle.reference_open_distance",
  "lifecycle.time_since_open_ms",
  "lifecycle.time_to_close_ms",
  "polymarket.best_ask",
  "polymarket.best_bid",
  "polymarket.depth_at_levels",
  "polymarket.executable_buy_price",
  "polymarket.executable_sell_price",
  "polymarket.microprice",
  "polymarket.midpoint",
  "polymarket.order_book_imbalance",
  "polymarket.recent_trades",
  "polymarket.spread",
  "quality.active_incidents",
  "quality.input_feed_ages",
  "reference.binance.ewma_realized_volatility",
  "reference.binance.return_1s",
  "reference.binance.return_250ms",
  "reference.binance.return_30s",
  "reference.binance.return_5s",
  "reference.chainlink.twap_30s",
  "reference.chainlink.twap_60s",
  "reference.coinbase.ewma_realized_volatility",
  "reference.coinbase.return_1s",
  "reference.coinbase.return_250ms",
  "reference.coinbase.return_30s",
  "reference.coinbase.return_5s",
  "reference.cross_venue.direction_agreement_1s",
  "reference.cross_venue.direction_agreement_250ms",
  "reference.cross_venue.direction_agreement_30s",
  "reference.cross_venue.direction_agreement_5s",
  "reference.cross_venue.midpoint_difference",
]);

/** The §13.2 trigger-basis vocabulary. Exactly two values; nothing is inferred. */
export const TRIGGER_BASES = Object.freeze(["executable_ask", "executable_bid"] as const);
export type TriggerBasis = (typeof TRIGGER_BASES)[number];

/** The §13.2 basis -> v1 feature id map. */
export const BASIS_FEATURE_ID: Readonly<Record<TriggerBasis, string>> = Object.freeze({
  executable_ask: "polymarket.executable_buy_price",
  executable_bid: "polymarket.executable_sell_price",
});

/** The v1 feature that carries active data-quality incident flags (§9.5). */
export const INCIDENT_FEATURE_ID = "quality.active_incidents";

const SELECTOR_PATTERN = /^[A-Za-z0-9_.:+-]{1,32}$/u;
const KEY_SEPARATOR = "@";

export interface FeatureKey {
  /** The v1 registry id the key names. */
  readonly featureId: string;
  /** The composition root's projection coordinate, or `null` when absent. */
  readonly selector: string | null;
  /** The key exactly as it must appear in `FeatureSnapshot.values`. */
  readonly key: string;
}

export function isFeatureIdV1(value: string): boolean {
  return FEATURE_IDS_V1.includes(value);
}

/**
 * Parses a configured feature key. TOTAL; every failure names the problem.
 *
 * `expectedFeatureId`, when supplied, additionally pins the key to the id the
 * declared trigger basis maps to, so a config that says `executable_ask` and
 * then reads the SELL price is refused rather than silently traded.
 */
export function parseFeatureKey(
  value: unknown,
  path: string,
  expectedFeatureId: string | null,
): Outcome<FeatureKey> {
  if (typeof value !== "string" || value.length === 0 || value.length > 96) {
    return bad(`${path} must be a non-empty feature key of at most 96 characters`);
  }
  const separatorAt = value.indexOf(KEY_SEPARATOR);
  const featureId = separatorAt < 0 ? value : value.slice(0, separatorAt);
  const selector = separatorAt < 0 ? null : value.slice(separatorAt + 1);
  if (!isFeatureIdV1(featureId)) {
    return bad(
      `${path} names feature "${featureId}", which is not a member of feature set v1 ` +
        "(polymarket-bot/features/v1); a trigger naming a feature the engine does not " +
        "compute is refused at configuration validation",
    );
  }
  if (selector !== null && !SELECTOR_PATTERN.test(selector)) {
    return bad(
      `${path} has an unusable projection selector after "${KEY_SEPARATOR}"; it must match ` +
        `${SELECTOR_PATTERN.source} (this package's declared key grammar)`,
    );
  }
  if (expectedFeatureId !== null && featureId !== expectedFeatureId) {
    return bad(
      `${path} names feature "${featureId}", but the declared trigger basis binds to ` +
        `"${expectedFeatureId}"; the basis and the feature it reads may not disagree`,
    );
  }
  return ok(Object.freeze({ featureId, selector, key: value }));
}

/**
 * The values map a strategy sees, exactly as §7.6 types it.
 *
 * Reads go through {@link readFeatureScalar} / {@link readFeatureFlag} so that
 * an ABSENT key is a stated refusal rather than a value adopted from
 * `Object.prototype` (the runtime materializes views into objects that carry
 * the ordinary prototype).
 */
export type FeatureValues = Readonly<Record<string, string | boolean | null>>;

export type FeatureRead<T> =
  | { readonly kind: "VALUE"; readonly value: T }
  /** The engine reported the feature as absent (`null`), a data condition. */
  | { readonly kind: "ABSENT" }
  /** The key is missing or its value has the wrong shape — a wiring fault. */
  | { readonly kind: "UNUSABLE"; readonly problem: string };

/** Reads one scalar feature value as a string, own-property only. */
export function readFeatureScalar(values: FeatureValues, key: string): FeatureRead<string> {
  if (!Object.hasOwn(values, key)) {
    return {
      kind: "UNUSABLE",
      problem:
        `the feature snapshot carries no key "${key}"; the composition root must project ` +
        "the configured feature onto exactly this key",
    };
  }
  const value = values[key];
  if (value === null) {
    return { kind: "ABSENT" };
  }
  if (typeof value !== "string") {
    return {
      kind: "UNUSABLE",
      problem: `feature "${key}" is ${typeof value}, but this trigger needs a decimal string`,
    };
  }
  return { kind: "VALUE", value };
}

/** Reads one boolean feature flag, own-property only. */
export function readFeatureFlag(values: FeatureValues, key: string): FeatureRead<boolean> {
  if (!Object.hasOwn(values, key)) {
    return {
      kind: "UNUSABLE",
      problem: `the feature snapshot carries no key "${key}"`,
    };
  }
  const value = values[key];
  if (value === null) {
    return { kind: "ABSENT" };
  }
  if (typeof value !== "boolean") {
    return {
      kind: "UNUSABLE",
      problem:
        `feature "${key}" is ${typeof value}, but the incident flag must be a boolean — ` +
        "an unusable data-quality flag is treated as an incident, never as 'healthy'",
    };
  }
  return { kind: "VALUE", value };
}
