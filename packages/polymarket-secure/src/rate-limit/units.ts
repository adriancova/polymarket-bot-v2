/**
 * Units of the rate-limit budget (WP-310). Not limits: the conversions every
 * figure goes through, and the bounds that keep those conversions exact.
 *
 * - Time is Unix epoch milliseconds; `Retry-After` and `Poly-RateLimit-Reset`
 *   are seconds.
 * - Token levels are kept in THOUSANDTHS of a token: a rate in tokens per
 *   second times a span in milliseconds is then an exact integer number of
 *   them, and a level renders as an exact decimal string.
 * - {@link MAX_TOKEN_MAGNITUDE} is the largest token figure the budget
 *   interprets (a configured burst, rate, cost or window limit; a
 *   `Poly-RateLimit-Remaining`; a canceled count; a level either side of
 *   zero): its thousandths, times a per-mille share, and sums and
 *   differences of a thousand such values, stay exact safe integers. A larger
 *   figure is malformed, never interpreted.
 * - {@link MAX_DURATION_MS} is the longest duration a snapshot may configure
 *   (a window, a backoff, the bound on a header-derived wait).
 * - {@link MAX_EPOCH_MS} is the latest instant the budget accepts: every
 *   deadline it derives from an instant (a configured duration, a
 *   `Retry-After`, the refill of the deepest debt a level can hold) is then
 *   still an exact safe integer.
 *
 * None of these bounds is a venue number: each is derived from
 * `Number.MAX_SAFE_INTEGER` and the units above.
 */

/** Unit: milliseconds per second. */
export const MS_PER_SECOND = 1000;

/** Thousandths of a token per token (one per millisecond of a one-token-per-second refill). */
export const MILLI_PER_TOKEN = MS_PER_SECOND;

/** The largest token magnitude interpreted: `Number.MAX_SAFE_INTEGER / MILLI_PER_TOKEN²`, rounded down. */
export const MAX_TOKEN_MAGNITUDE = Math.floor(Number.MAX_SAFE_INTEGER / (MILLI_PER_TOKEN * MILLI_PER_TOKEN));

/** The longest configurable duration in milliseconds: `Number.MAX_SAFE_INTEGER / MS_PER_SECOND²`, rounded down (about 104 days). */
export const MAX_DURATION_MS = Math.floor(Number.MAX_SAFE_INTEGER / (MS_PER_SECOND * MS_PER_SECOND));

/**
 * The latest instant accepted (epoch milliseconds): `Number.MAX_SAFE_INTEGER` less the longest span the budget
 * ever adds to an instant. That span is the refill of a full swing of the level (from the deepest debt to the
 * largest burst, `2 × MAX_TOKEN_MAGNITUDE` tokens, at the slowest rate, one token per second: one thousandth
 * per millisecond), which exceeds every configured duration and every `Retry-After`.
 */
export const MAX_EPOCH_MS = Number.MAX_SAFE_INTEGER - (MAX_TOKEN_MAGNITUDE + MAX_TOKEN_MAGNITUDE) * MILLI_PER_TOKEN;

/** A token count the budget can hold exactly in thousandths. */
export function isExactTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_TOKEN_MAGNITUDE;
}

/** A level, in thousandths of a token, within `MAX_TOKEN_MAGNITUDE` tokens either side of zero. */
export function isExactLevelMilli(milli: number): boolean {
  return Number.isSafeInteger(milli) && Math.abs(milli) <= MAX_TOKEN_MAGNITUDE * MILLI_PER_TOKEN;
}
