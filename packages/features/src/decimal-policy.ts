/**
 * The v1 division and rounding policy (WP-150 carried follow-up: "WP-160 must
 * CHOOSE and document its division options").
 *
 * ## The choice, and why it is pinned rather than overridable
 *
 * Every inexact division in this package uses ONE policy: 34 significant
 * digits, ROUND_HALF_EVEN (IEEE 754 decimal128 / banker's rounding) — the
 * `@polymarket-bot/decimal` documented default, invoked through the default
 * path and PINNED BY TEST to those numbers (see {@link dividePolicy} for why
 * the explicit-options path is avoided). The order-book package's
 * `executablePrice` exposes a per-call `division` override (ADR-001 §3.3);
 * this package deliberately does NOT. A feature value must be a pure function of
 * `(inputs, feature id, feature version)`: a per-call override would let two
 * callers compute two different values for the same feature id over the same
 * inputs, and both would content-address as "the" snapshot. Changing this
 * policy is therefore a feature-set version bump, never a call-site option.
 *
 * The constants are re-exported from `@polymarket-bot/decimal` and pinned by
 * test to the values this contract documents (34, ROUND_HALF_EVEN = 6), so a
 * drift in that package's defaults cannot silently change v1 values.
 *
 * ## Exact-halving carve-out
 *
 * Dividing a decimal by 2 always terminates (it appends at most one digit),
 * so midpoints use {@link halveExact} — `divDecimalExact`, which refuses to
 * round — rather than the 34-digit policy. A midpoint is exact by
 * construction; rounding one would discard information for no reason.
 *
 * ## Quantization and the deterministic square root
 *
 * EWMA accumulation multiplies exactly and then quantizes each step back to
 * the policy precision via {@link quantizePolicy} (division by "1" under the
 * policy constructor), so digit growth is bounded and every intermediate is a
 * deterministic function of the inputs. {@link sqrtPolicy} is a Newton
 * iteration built from policy divisions and exact halvings with a
 * magnitude-aware seed; it stops when two successive iterates render
 * identically at policy precision, and refuses (never loops) past a fixed
 * iteration bound.
 */

import {
  DIVISION_PRECISION,
  DIVISION_ROUNDING,
  addDecimal,
  compareDecimal,
  divDecimal,
  divDecimalExact,
  isZeroDecimal,
} from "@polymarket-bot/decimal";
import type { DecimalString } from "@polymarket-bot/decimal";

/** Significant digits for every inexact feature division. Pinned by test. */
export const FEATURE_DIVISION_PRECISION: number = DIVISION_PRECISION;

/** Rounding for every inexact feature division (ROUND_HALF_EVEN). Pinned by test. */
export const FEATURE_DIVISION_ROUNDING: number = DIVISION_ROUNDING;

/**
 * `numerator / denominator` under the pinned v1 policy.
 *
 * DELIBERATELY NO per-call `DivisionOptions`, for two measured reasons:
 *
 * 1. The v1 policy IS `@polymarket-bot/decimal`'s documented default (34,
 *    ROUND_HALF_EVEN), and this module's constants pin those values by test —
 *    a drift in that package's defaults fails `decimal-policy.test.ts`
 *    loudly instead of silently changing every v1 feature value.
 * 2. `divDecimal` WITH explicit options builds a fresh `Decimal.clone(...)`
 *    constructor per call, and `decimal.js`'s `clone` performs ordinary
 *    property assignments — under an inherited get-only
 *    `Object.prototype.set` (the WP-180 descriptor-poisoning class) that
 *    assignment THROWS. This package's hostile battery measured exactly that:
 *    the options path turned ambient pollution into a contained
 *    `FEATURES_INTERNAL` refusal of a computation that should succeed. The
 *    default path uses module-load-time constructors and performs no such
 *    assignment at call time.
 */
export function dividePolicy(numerator: DecimalString, denominator: DecimalString): DecimalString {
  return divDecimal(numerator, denominator);
}

/** Exact `value / 2`. Always terminates; never rounds. */
export function halveExact(value: DecimalString): DecimalString {
  return divDecimalExact(value, "2");
}

/** `value` rounded to the pinned policy precision (division by one). */
export function quantizePolicy(value: DecimalString): DecimalString {
  return divDecimal(value, "1");
}

/** Iteration bound for {@link sqrtPolicy}. Generous: convergence needs ~6. */
export const SQRT_MAX_ITERATIONS = 48;

export type SqrtResult =
  | { readonly ok: true; readonly value: DecimalString }
  | { readonly ok: false; readonly problem: string };

/**
 * A power of ten near `sqrt(value)`, as a deterministic Newton seed.
 *
 * Derived from the canonical string's own digits (no float math): for a value
 * with integer-part length `n > 1` the seed is `10^floor((n-1)/2)`; for a
 * purely fractional value with `z` leading fractional zeros the seed is
 * `10^-(floor(z/2)+1)`; otherwise `1`.
 */
function sqrtSeed(value: DecimalString): DecimalString {
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  const dot = unsigned.indexOf(".");
  const integerPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  if (integerPart !== "0") {
    const half = Math.floor((integerPart.length - 1) / 2);
    return half === 0 ? "1" : `1${"0".repeat(half)}`;
  }
  const fractionPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  let zeros = 0;
  while (zeros < fractionPart.length && fractionPart[zeros] === "0") {
    zeros += 1;
  }
  const scale = Math.floor(zeros / 2) + 1;
  return `0.${"0".repeat(scale - 1)}1`;
}

/**
 * Deterministic non-negative square root at policy precision.
 *
 * Newton's method: `x' = (x + value / x) / 2`, with the division under the
 * pinned policy and the halving exact. Refuses negative input and
 * non-convergence within {@link SQRT_MAX_ITERATIONS} (fail closed — a wrong
 * volatility is worse than an absent one).
 */
export function sqrtPolicy(value: DecimalString): SqrtResult {
  if (compareDecimal(value, "0") < 0) {
    return { ok: false, problem: "square root of a negative value" };
  }
  if (isZeroDecimal(value)) {
    return { ok: true, value: "0" };
  }
  let current = sqrtSeed(value);
  let previous: DecimalString | undefined;
  for (let iteration = 0; iteration < SQRT_MAX_ITERATIONS; iteration += 1) {
    const next = quantizePolicy(halveExact(addDecimal(current, dividePolicy(value, current))));
    if (next === current) {
      return { ok: true, value: next };
    }
    // A rounded Newton step can 2-cycle between two adjacent representable
    // values; the smaller is chosen deterministically (documented tie rule).
    if (previous !== undefined && next === previous) {
      return { ok: true, value: compareDecimal(next, current) < 0 ? next : current };
    }
    previous = current;
    current = next;
  }
  return {
    ok: false,
    problem: `did not converge within ${String(SQRT_MAX_ITERATIONS)} iterations`,
  };
}
