/**
 * Small pure guards shared by this package.
 *
 * Duplicated (11 lines of substance) from `@polymarket-bot/capital-allocator`
 * rather than shared, because sharing would need a same-layer edge that
 * `docs/contracts/dependency-direction.md` §2.1 does not list — the WP-110
 * precedent (its `deviations` 5) applies verbatim. Each copy has its own
 * tests.
 *
 * `uuidShapedNotCanonical` implements ADR-016 §2 (2026-09-02 amendment):
 * REFUSE a UUID-shaped identifier arriving in a non-canonical (non-lowercase)
 * spelling; never case-fold.
 */

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** True when `value` is UUID-shaped but not canonical lowercase (ADR-016). */
export function uuidShapedNotCanonical(value: string): boolean {
  return UUID_SHAPE.test(value) && !UUID_CANONICAL.test(value);
}

/**
 * Recursively freezes plain objects and arrays. Returns the same reference.
 * Recurses into already-frozen containers (a zod `.readonly()` array arrives
 * shallow-frozen with mutable elements); a visited set makes cycles safe.
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
