/**
 * `THROUGHPUT-1a` — exact STRING answers to three range questions the input
 * validation asks of every book level and every reference point, for which
 * `compareDecimal` built two `decimal.js` values each time. PERFORMANCE ONLY:
 * every function here returns exactly what the `compareDecimal` expression it
 * replaces returns, on the inputs it is called with — which are always
 * CANONICAL (`isCanonicalDecimalString`) and NON-NEGATIVE, checked first by
 * the caller. `canonical-order.test.ts` pins each equivalence against
 * `compareDecimal` itself, exhaustively over short strings and on a seeded
 * sample of long ones.
 *
 * Why the answers are exact. The canonical grammar
 * (`/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/`, "-0" refused) gives every
 * value ONE spelling:
 *
 * - zero is exactly `"0"` — so, for a non-negative canonical value,
 *   `compareDecimal(v, "0") > 0` ⇔ `v !== "0"`;
 * - a non-negative canonical value is at most one exactly when it is `"0"`,
 *   `"1"`, or `"0."` followed by digits (its integer part is `0`); every other
 *   spelling has an integer part of at least `1` and either is `"1"` or
 *   exceeds it;
 * - two canonical values in `[0, 1]` are `"0"`, `"1"` or `"0.f"` with `f`
 *   ending in a non-zero digit, and their numeric order is their code-unit
 *   order: `"0"` is a proper prefix of every `"0.f"`; `"1"` differs from both
 *   at the first character; and for `"0.f"` against `"0.g"` either one
 *   fraction is a proper prefix of the other (the longer adds a last non-zero
 *   digit, so it is larger) or they first differ at a digit, which decides
 *   the order whatever follows.
 */

import type { DecimalString } from "@polymarket-bot/decimal";

/** For a canonical, non-negative `value`: exactly `compareDecimal(value, "0") > 0`. */
export function isPositiveCanonical(value: DecimalString): boolean {
  return value !== "0";
}

/** For a canonical, non-negative `value`: exactly `compareDecimal(value, "1") <= 0`. */
export function isAtMostOneCanonical(value: DecimalString): boolean {
  return value === "0" || value === "1" || value.startsWith("0.");
}

/** For two canonical values in `[0, 1]`: exactly `compareDecimal(left, right)`. */
export function compareCanonicalUnitInterval(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}
