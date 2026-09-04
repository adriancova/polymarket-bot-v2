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
 * The OWN entry of a keyed table, or `undefined` — never an INHERITED one.
 *
 * THE SWEEP HALF OF ROUND 5'S FIRST BLOCKER. That BLOCKER was about writing a
 * caller-supplied key with `[]=`, which consults inherited setters; the mirror
 * defect is READING a caller-supplied key with `[]`, which consults inherited
 * values. `table[key]` for `key === "__proto__"` answers `Object.prototype` —
 * an object, not `undefined` — and every "is this scope measured?" test in this
 * package is written as `entry === undefined`. A scope key of `"__proto__"`
 * would therefore have LOOKED MEASURED while carrying no numbers at all,
 * bypassing `RISK_EXPOSURE_ENTRY_MISSING` (review round 1, BLOCKER 2 — a fix
 * this round may not weaken) and then feeding `undefined` to decimal
 * arithmetic. Scope keys are bounded non-empty strings, not UUIDs, so
 * `"__proto__"` is admissible input rather than a hypothetical.
 *
 * `Object.hasOwn` first, so absence stays absence.
 */
export function ownEntry<T>(
  table: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  if (table === undefined) return undefined;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * One OWN property of `container`, with an explicit PRESENCE flag.
 *
 * Never inherited, and never an accessor invocation: the value comes from the
 * descriptor. `Object.hasOwn` alone would answer the presence question but a
 * following `container[key]` would still invoke an OWN getter, and the whole
 * point of the round-6 fix at `inputs.ts` is that asking whether a field exists
 * must not run anybody's code.
 *
 * `present: false` covers three cases that are one case for this package: no
 * such property, an inherited one, and an accessor.
 */
export function ownProperty(
  container: object,
  key: string,
): { readonly present: boolean; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

/**
 * True when `flags` OWNS `key` and its value is exactly `true`.
 *
 * For a frozen lookup table of booleans (`RUN_MODE_PLACES_REAL_ORDERS`). The
 * key is validated caller data, so `flags[key]` would consult the prototype for
 * any spelling the table does not own — review round 6's census flagged the call
 * site, and a fence over real-order run modes is the last place to answer from
 * anywhere but the table itself. Mirrors
 * `packages/capital-allocator/src/guards.ts`.
 */
export function ownFlag(flags: object, key: string): boolean {
  if (!Object.hasOwn(flags, key)) return false;
  return (flags as Record<string, unknown>)[key] === true;
}

/**
 * Recursively freezes plain objects and arrays. Returns the same reference.
 * Recurses into already-frozen containers (a zod `.readonly()` array arrives
 * shallow-frozen with mutable elements); a visited set makes cycles safe.
 *
 * DESCRIPTOR-BASED (review round 5). It used to recurse through
 * `(value as Record<string, unknown>)[key]`, which is a property READ: on a
 * value carrying an accessor it would invoke the getter, and on a `Proxy` it
 * would run a trap. Every value this function is applied to has already been
 * materialized by `plain-data.ts` or built from schema output in this package,
 * so that was latent rather than live — but a freeze walk that runs the value's
 * own code is the same defect class the whole round-4/5 chain is about, and the
 * descriptor read costs nothing.
 *
 * This is a SECOND traversal, and round 4's claim that the package had "exactly
 * one traversal primitive" was wrong about it (round 5). What is true, and all
 * that is claimed now: the ADR-016 §2 IDENTITY check performs no traversal of
 * its own — it consumes the inventory `readPlainData` produced — and this walk
 * runs only over values that read has already turned into plain own data.
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
    // `Object.hasOwn`, not `"value" in descriptor` (review round 6). A
    // descriptor object inherits from `Object.prototype`, so `in` answers for an
    // inherited `value` too: with `Object.prototype.value` defined, an ACCESSOR
    // would have been treated as a data property and `descriptor.value` —
    // `undefined` — recursed into. Found by the round-6 census
    // (`test/unit/risk/prototype-access.test.ts`), not by a reviewer.
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) continue;
    freezeRecursive(descriptor.value, visited);
  }
  Object.freeze(value);
}
