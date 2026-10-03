/**
 * Units of the rate-limit budget (WP-310). Not limits: the conversions every
 * figure goes through, and the bound that keeps those conversions exact.
 *
 * - Time is Unix epoch milliseconds; `Retry-After` and `Poly-RateLimit-Reset`
 *   are seconds.
 * - Token levels are kept in THOUSANDTHS of a token: a rate in tokens per
 *   second times a span in milliseconds is then an exact integer number of
 *   them, and a level renders as an exact decimal string.
 * - {@link MAX_TOKEN_MAGNITUDE} is the largest token count (a
 *   `Poly-RateLimit-Remaining`, a canceled count) the budget interprets: its
 *   thousandths, and sums and differences of a thousand such values, stay
 *   exact safe integers. A larger figure is malformed, never interpreted.
 */

/** Unit: milliseconds per second. */
export const MS_PER_SECOND = 1000;

/** Thousandths of a token per token (one per millisecond of a one-token-per-second refill). */
export const MILLI_PER_TOKEN = MS_PER_SECOND;

/** The largest token magnitude interpreted: `Number.MAX_SAFE_INTEGER / MILLI_PER_TOKEN²`, rounded down. */
export const MAX_TOKEN_MAGNITUDE = Math.floor(Number.MAX_SAFE_INTEGER / (MILLI_PER_TOKEN * MILLI_PER_TOKEN));

/** A token count the budget can hold exactly in thousandths. */
export function isExactTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_TOKEN_MAGNITUDE;
}
