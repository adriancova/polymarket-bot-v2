/**
 * Small pure guards shared by this package.
 *
 * Adapted (not byte-mirrored — each function carries this package's own uses)
 * from `packages/risk/src/guards.ts` / `packages/capital-allocator/src/guards.ts`,
 * for the same reason those two are duplicates of each other: no §2.1 same-layer
 * edge exists between layer-1 packages (`docs/contracts/dependency-direction.md`
 * F13), and this package may not widen a frozen contract for convenience.
 *
 * `deepFreeze` follows the WP-110 precedent: every value this package returns
 * is deeply frozen so an in-place edit throws instead of silently corrupting a
 * plan — which is what makes "plans are IMMUTABLE once built" (WP-190 binding
 * constraint 2) tamper-EVIDENT rather than aspirational.
 *
 * `uuidShapedNotCanonical` implements ADR-016 §2 (2026-09-02 amendment): a
 * UUID-shaped identifier arriving at this package's input surface in a
 * non-canonical (non-lowercase) spelling is REFUSED, never case-folded.
 *
 * There is deliberately NO `ownEntry`/`setOwn` here: this package keeps no
 * caller-keyed tables at all (markets arrive as an ARRAY and are found by
 * `===` comparison), so the WP-180 round-5/6 prototype-lookup class has no
 * surface to bite — by construction rather than by guarded lookup.
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
 * DESCRIPTOR-BASED (WP-180 review round 5): recursing through a property READ
 * would invoke a getter or a `Proxy` trap. Every value this function is applied
 * to has already been materialized by `plain-data.ts` or built by this package,
 * so that is defence in depth — but a freeze walk that runs the value's own
 * code is exactly the defect class the boundary exists to close. Recurses into
 * already-frozen containers too; a visited set makes cycles safe.
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
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // `Object.hasOwn`, not `"value" in descriptor` (WP-180 round 6): a
    // descriptor object inherits from `Object.prototype`, so `in` answers for
    // an INHERITED `value` and an accessor would read as a data property.
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) continue;
    freezeRecursive(descriptor.value, visited);
  }
  Object.freeze(value);
}
