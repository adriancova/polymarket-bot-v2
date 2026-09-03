/**
 * Small pure guards shared by this package.
 *
 * `deepFreeze` follows the WP-110 remediation precedent (`packages/universe`
 * registry hardening, review finding H3): every value this package returns is
 * deeply frozen so an in-place edit throws instead of silently corrupting
 * commitment accounting. Tamper-EVIDENT, not tamper-proof — an adversary with
 * prototype access inside the process is out of scope for a pure library.
 *
 * `uuidShapedNotCanonical` implements ADR-016 §2 (2026-09-02 amendment): a
 * UUID-shaped identifier arriving at this package's input surface in a
 * non-canonical (non-lowercase) spelling is REFUSED, never case-folded. This
 * catches an id that IS a UUID but was re-cased by a transforming pipeline;
 * ids that are not UUID-shaped at all remain governed by the bounded-string
 * schemas (`docs/contracts/domain.md` §8: internal ids without a §7.2 format
 * are bounded non-empty strings).
 */

/** Case-insensitive UUID shape (any variant/version — shape only). */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

/** Canonical lowercase UUID (what the frozen domain schemas accept). */
const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * True when `value` is UUID-shaped but NOT in the canonical lowercase form
 * (ADR-016 §2: refuse, do not normalize).
 */
export function uuidShapedNotCanonical(value: string): boolean {
  return UUID_SHAPE.test(value) && !UUID_CANONICAL.test(value);
}

/**
 * Recursively freezes plain objects and arrays. Returns the same reference.
 *
 * Recurses into ALREADY-frozen containers too (a zod `.readonly()` array
 * arrives shallow-frozen with mutable elements — skipping it would leave the
 * elements editable); a visited set makes cycles safe.
 */
export function deepFreeze<T>(value: T): T {
  freezeRecursive(value, new WeakSet());
  return value;
}

function freezeRecursive(value: unknown, visited: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }
  visited.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    freezeRecursive((value as Record<string, unknown>)[key], visited);
  }
  Object.freeze(value);
}
