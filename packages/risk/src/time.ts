/**
 * Instant comparison for intent deadlines.
 *
 * NO CLOCK IS READ IN THIS PACKAGE. `Date.now()` and `new Date()` appear
 * nowhere; `Date.parse` is used only to parse a string the CALLER supplied, so
 * the same inputs produce the same verdict on replay as they did live (§6
 * invariant 2, §12.4). The evaluation instant arrives as `evaluatedAt` data.
 *
 * ISO-8601 strings cannot be compared lexicographically once UTC offsets are in
 * play (`2026-01-01T00:00:00Z` and `2026-01-01T01:00:00+01:00` are the same
 * instant and different strings), so comparison goes through the parsed epoch
 * value. Duplicated (a dozen lines) from `@polymarket-bot/settlement`'s
 * `time.ts` rather than shared, because sharing would need a same-layer edge
 * `docs/contracts/dependency-direction.md` §2.1 does not list.
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
 * True when `deadline` is a parseable instant strictly BEFORE `asOf`.
 *
 * `undefined` on either side means "not comparable", and the caller fails
 * closed on that rather than treating unknown as fresh.
 */
export function isExpired(deadline: string, asOf: string): boolean | undefined {
  const end = instantMilliseconds(deadline);
  const now = instantMilliseconds(asOf);
  if (end === undefined || now === undefined) {
    return undefined;
  }
  return end < now;
}
