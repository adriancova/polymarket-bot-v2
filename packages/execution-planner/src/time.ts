/**
 * Instant arithmetic for plan deadlines.
 *
 * NO CLOCK IS READ IN THIS PACKAGE. `Date.now()` and zero-argument
 * `new Date()` appear nowhere; `Date.parse` and `new Date(epochMs)` operate
 * only on values the CALLER supplied, so the same inputs produce the same plan
 * on replay as they did live (§6 invariant 2 by analogy, §12.4 determinism).
 * The planning instant arrives as `plannedAt` data.
 *
 * Duplicated (a dozen lines) from `@polymarket-bot/risk`'s `time.ts` — itself
 * duplicated from `@polymarket-bot/settlement` — rather than shared, because
 * sharing would need a same-layer edge `docs/contracts/dependency-direction.md`
 * §2.1 does not list.
 */

/**
 * Epoch milliseconds of an ISO-8601 instant, or `undefined` when the value is
 * not a parseable instant. Returns rather than throws so a caller turns a
 * malformed value into a typed refusal.
 */
export function instantMilliseconds(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The ISO-8601 UTC instant `milliseconds` after `iso`, or `undefined` when
 * `iso` is not parseable or the sum leaves the representable range.
 *
 * Output is always the canonical `toISOString` UTC form, whatever offset the
 * input carried — a NEW value this package derives, not a rewrite of a
 * caller's field.
 */
export function instantPlusMilliseconds(iso: string, milliseconds: number): string | undefined {
  const base = instantMilliseconds(iso);
  if (base === undefined || !Number.isSafeInteger(milliseconds)) return undefined;
  const sum = base + milliseconds;
  if (!Number.isSafeInteger(sum)) return undefined;
  try {
    return new Date(sum).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * The earlier of two parseable instants, or `undefined` when either is not
 * parseable. Ties return `left`.
 */
export function earlierInstant(left: string, right: string): string | undefined {
  const a = instantMilliseconds(left);
  const b = instantMilliseconds(right);
  if (a === undefined || b === undefined) return undefined;
  return a <= b ? left : right;
}

/**
 * True when `deadline` is a parseable instant strictly BEFORE `asOf`;
 * `undefined` means "not comparable" and the caller fails closed on it.
 */
export function isExpired(deadline: string, asOf: string): boolean | undefined {
  const end = instantMilliseconds(deadline);
  const now = instantMilliseconds(asOf);
  if (end === undefined || now === undefined) {
    return undefined;
  }
  return end < now;
}
