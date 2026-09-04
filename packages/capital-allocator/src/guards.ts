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

import { ownDataDescriptor } from "./plain-data.js";

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
 * The OWN entry of a keyed table, or `undefined` — never an INHERITED one.
 *
 * THE SWEEP HALF OF ROUND 5'S FIRST BLOCKER (mirrors `packages/risk/src/guards.ts`).
 * `table[key]` for `key === "__proto__"` answers `Object.prototype` rather than
 * `undefined`, and this package's scope keys — `strategyInstanceId`, `seriesKey`,
 * `underlyingKey`, `resolutionWindowKey` — are BOUNDED NON-EMPTY STRINGS, not
 * UUIDs, so that key is admissible input rather than a hypothetical. Every
 * "is there an entry?" test here is `=== undefined`, so an inherited member
 * would have read as a measured scope carrying no numbers.
 */
export function ownEntry<T>(
  table: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  if (table === undefined) return undefined;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * True when `flags` OWNS `key` and its value is exactly `true`.
 *
 * For a frozen lookup table of booleans (`RUN_MODE_PLACES_REAL_ORDERS`). The
 * key is validated caller data, so `flags[key]` would consult the prototype for
 * any spelling the table does not own — review round 6's census flagged both
 * call sites, and a fence over real-order run modes is the last place to answer
 * from anywhere but the table itself.
 */
export function ownFlag(flags: object, key: string): boolean {
  if (!Object.hasOwn(flags, key)) return false;
  return (flags as Record<string, unknown>)[key] === true;
}

/**
 * Creates or replaces an OWN, enumerable DATA property on a table being built.
 *
 * NEVER `table[key] = value`, where `key` comes from caller data. Assignment is
 * `Set`: it walks the prototype chain, and for `key === "__proto__"` it invokes
 * `Object.prototype`'s SETTER instead of creating a field — round 5's first
 * BLOCKER, reported against the risk package's materializer and swept for here.
 * In this package the same construct reached further: `table[key] ??= {...}`
 * read `Object.prototype` as an existing entry and would then have written the
 * commitment components ONTO `Object.prototype` itself. `defineProperty` has
 * `CreateDataProperty` semantics and consults no setter.
 *
 * The DESCRIPTOR is built by `plain-data.ts`'s `ownDataDescriptor` rather than
 * written as a literal (review round 8): a descriptor literal is an ordinary
 * object, its fields are read with `HasProperty`, and an inherited `get` turned
 * every `Object.defineProperty` in this repository into a `TypeError` — measured
 * at the round-7 tip, where it escaped a public door as an exception.
 */
export function setOwn<T>(table: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(table, key, ownDataDescriptor(value));
}

/**
 * Recursively freezes plain objects and arrays. Returns the same reference.
 *
 * Recurses into ALREADY-frozen containers too (a zod `.readonly()` array
 * arrives shallow-frozen with mutable elements — skipping it would leave the
 * elements editable); a visited set makes cycles safe.
 *
 * DESCRIPTOR-BASED (review round 5). It used to recurse through
 * `(value as Record<string, unknown>)[key]`, which is a property READ: on a
 * value carrying an accessor it would invoke the getter, and on a `Proxy` it
 * would run a trap. Every value this function is applied to is built from
 * schema output or from values `plain-data.ts` has already materialized, so
 * that was latent rather than live — but a freeze walk that runs the value's
 * own code is the defect class round 5 is about, and the descriptor read costs
 * nothing. Mirrors `packages/risk/src/guards.ts`, as the rest of this module
 * does.
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
    // `undefined` — recursed into. Mirrors `packages/risk/src/guards.ts`.
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) continue;
    freezeRecursive(descriptor.value, visited);
  }
  Object.freeze(value);
}
