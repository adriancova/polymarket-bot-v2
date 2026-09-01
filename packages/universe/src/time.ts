/**
 * Instant comparison.
 *
 * DETERMINISM (handoff §6 invariant 2, §12.4): nothing in this package reads a
 * clock. `Date.parse` parses a string the CALLER supplied; `Date.now()` and
 * `new Date()` appear nowhere in this package. Every "as of" instant — the one
 * a readiness check compares a close time against — enters as data.
 *
 * ISO-8601 strings cannot be compared lexicographically once offsets are in
 * play, so comparison goes through the parsed epoch value.
 *
 * DUPLICATION, DELIBERATE: `@polymarket-bot/settlement` carries the same three
 * functions. They are eleven lines of arithmetic, and sharing them would mean
 * either a same-layer package edge that
 * `docs/contracts/dependency-direction.md` §2.1 does not list (violation F13) or
 * a new shared package that no work package owns. Both cost more than the
 * duplication; each copy is covered by its own tests.
 */

/** Epoch milliseconds of an ISO-8601 instant, or `undefined` when unparseable. */
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

/** Whether both values name the same instant, whatever their offsets. */
export function isSameInstant(left: string, right: string): boolean {
  const a = instantMilliseconds(left);
  const b = instantMilliseconds(right);
  return a !== undefined && b !== undefined ? a === b : left === right;
}
