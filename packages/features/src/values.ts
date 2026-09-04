/**
 * The feature-value model: every computed feature is OK with a value, or
 * ABSENT with a typed reason. Absence is a first-class answer, never `null`,
 * never a fabricated zero (see `docs/contracts/features-v1.md` §"absent
 * versus zero" — the WP-150 carried follow-up this package owns).
 */

/** The restricted value grammar features may carry (canonically serializable). */
export type FeatureData =
  | string
  | number
  | boolean
  | readonly FeatureData[]
  | { readonly [key: string]: FeatureData };

/** Why a feature has no value. Typed so consumers can branch without parsing prose. */
export type AbsenceReason =
  /** The bid side of the book is empty; a price cannot exist there. */
  | "EMPTY_BID_SIDE"
  /** The ask side of the book is empty; a price cannot exist there. */
  | "EMPTY_ASK_SIDE"
  /** Both sides of the book are empty. */
  | "EMPTY_BOOK"
  /** The input section this feature reads was not supplied. */
  | "INPUT_MISSING"
  /** No reference price exists at or before the required instant. */
  | "NO_PRICE_AT_HORIZON"
  /** The supplied venue series has fewer than two points, so no return exists. */
  | "INSUFFICIENT_SERIES"
  /** The venue series carries no top-of-book (or not both sides of it). */
  | "NO_TOP_OF_BOOK"
  /** No Chainlink input was supplied — the feed is not configured (§9.5 "where configured"). */
  | "NOT_CONFIGURED"
  /** Chainlink input exists but has no observation for this window at or before asOf. */
  | "NO_TWAP_OBSERVATION"
  /** No primary-venue reference price is available for the distance. */
  | "NO_REFERENCE_PRICE"
  /** The deterministic square root refused (fail closed; should be unreachable). */
  | "SQRT_UNAVAILABLE";

export type FeatureOutcome =
  | { readonly status: "OK"; readonly value: FeatureData }
  | { readonly status: "ABSENT"; readonly reason: AbsenceReason; readonly detail?: string };

/** One computed feature, before registry binding. */
export interface ComputedFeature {
  readonly id: string;
  readonly outcome: FeatureOutcome;
}

/**
 * Outcomes are built PROTOTYPE-FREE (`ownPlainCopy`): an OK outcome has no
 * own `reason`/`detail` and an ABSENT one may have no `detail`, and with an
 * ordinary literal a polluted `Object.prototype` would answer for the absent
 * name when the registry binder or a consumer reads it.
 */
import { ownPlainCopy } from "./materialize.js";

export function ok(id: string, value: FeatureData): ComputedFeature {
  return { id, outcome: ownPlainCopy({ status: "OK", value }) as FeatureOutcome };
}

export function absent(id: string, reason: AbsenceReason, detail?: string): ComputedFeature {
  return {
    id,
    outcome: ownPlainCopy({ status: "ABSENT", reason, ...(detail === undefined ? {} : { detail }) }) as FeatureOutcome,
  };
}
