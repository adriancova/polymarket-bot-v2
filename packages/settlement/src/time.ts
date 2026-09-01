/**
 * Instant comparison for settlement windows and deadlines.
 *
 * DETERMINISM (handoff §6 invariant 2, §12.4): nothing in this package reads a
 * clock. `Date.parse` is used only to *parse a string the caller supplied*, and
 * `Date.now()` / `new Date()` appear nowhere in this package. Every "as of"
 * instant enters as data, exactly as a replayed run requires — a settlement that
 * consulted the host clock would produce a different answer on replay than it
 * did live.
 *
 * ISO-8601 strings cannot be compared lexicographically once offsets are in play
 * (`2026-01-01T00:00:00Z` and `2026-01-01T01:00:00+01:00` are the same instant
 * and different strings), so comparison goes through the parsed epoch value.
 */

/**
 * Epoch milliseconds of an ISO-8601 instant, or `undefined` when the value is
 * not a parseable instant.
 *
 * The domain's `IsoTimestampSchema` has already rejected malformed strings at
 * the contract boundary; this returns `undefined` rather than throwing so a
 * caller that received an unvalidated string turns it into a typed refusal.
 */
export function instantMilliseconds(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Whether both values are parseable instants and `left` is strictly before `right`. */
export function isBefore(left: string, right: string): boolean | undefined {
  const a = instantMilliseconds(left);
  const b = instantMilliseconds(right);
  if (a === undefined || b === undefined) {
    return undefined;
  }
  return a < b;
}

/** Whether both values are parseable instants and `left` is at or after `right`. */
export function isAtOrAfter(left: string, right: string): boolean | undefined {
  const before = isBefore(left, right);
  return before === undefined ? undefined : !before;
}
