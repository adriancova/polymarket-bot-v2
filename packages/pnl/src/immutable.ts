/**
 * Runtime immutability for the containers this package hands out.
 *
 * `Object.freeze` freezes an object's PROPERTIES; it does not touch a `Map`'s
 * or a `Set`'s internal slots, so `Object.freeze(new Map())` still accepts
 * `.set(...)`. A `readonly` TypeScript type stops a TypeScript caller and
 * nobody else: a JavaScript consumer, a `JSON.parse`-shaped value cast at a
 * boundary, or a test can still write into a returned PnL state. That is a
 * money-shaped hazard here — `realizedTrading`, `lots`, `feesPaid`, and
 * `realizedRewards` are the folded record of what actually happened, and a
 * state a consumer can edit is a PnL figure a consumer can invent.
 *
 * So every `Map`/`Set` this package returns has its mutators replaced by
 * non-writable, non-configurable properties that THROW, and is then frozen.
 * A mutation attempt fails loudly instead of silently succeeding.
 *
 * GUARDING THE CONTAINER IS NOT ENOUGH (remediation round 2, 2026-09-03,
 * review HIGH-4). Round 1 sealed the containers and left their VALUES writable,
 * so `state.lots.get(token).costBasis = "999"` succeeded by ordinary property
 * assignment — no capability bypass required — and the very next snapshot
 * reported `capitalCommitted = 999` and `unrealizedPnlMidpoint = −994` from a
 * lot that cost 4. The same held for a `tradeLog` effect, which is what a
 * reversal unwinds against. So `frozenMap`/`frozenSet` now DEEP-FREEZE every
 * key and value they hold, recursively.
 *
 * Honest limits, stated rather than implied:
 *
 * - `Map.prototype.set.call(guarded, k, v)` still reaches the internal slot.
 *   Nothing short of a wrapper object closes that, and a wrapper would stop
 *   being a `Map` (`instanceof`, `new Map(other)`, structural equality in
 *   tests). The guard is a loud-failure boundary for ordinary use, not a
 *   capability confinement. This limit applies to the CONTAINER only: the
 *   values inside are ordinary frozen objects, and ordinary property
 *   assignment on them throws.
 * - The guard properties are NON-ENUMERABLE, so `Object.keys`, spreads, and
 *   deep-equality comparisons see exactly what an unguarded `Map` shows.
 *
 * `@polymarket-bot/ledger` carries the same helper: the two packages are the
 * same layer and no `docs/contracts/dependency-direction.md` §2.1 row permits
 * an edge between them, so the duplication is forced, small, and deliberate.
 */

/** The mutators that would rewrite folded state. */
const MAP_MUTATORS = ["set", "delete", "clear"] as const;
const SET_MUTATORS = ["add", "delete", "clear"] as const;

/**
 * Objects this module has already walked and frozen.
 *
 * Terminates a cyclic walk AND makes the walk O(1) amortized per object: the
 * fold copies its maps on every record, so without the memo every fold would
 * re-walk every lot and effect it carried forward. A member of this set is
 * frozen, so its own property values cannot have changed since it was walked —
 * skipping it is sound, not merely cheap. `WeakSet` holds no object alive.
 */
const DEEP_FROZEN = new WeakSet<object>();

/**
 * Recursively freezes a value, following arrays and own enumerable data
 * properties. Primitives pass through untouched.
 *
 * Only ENUMERABLE DATA properties are followed: an accessor is never invoked
 * (reading one to freeze it could run caller code), and the non-enumerable
 * mutator guards this module installs are not walked.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const object = value as unknown as object;
  if (DEEP_FROZEN.has(object)) {
    return value;
  }
  DEEP_FROZEN.add(object);
  Object.freeze(object);
  if (Array.isArray(object)) {
    for (const item of object) {
      deepFreeze(item);
    }
    return value;
  }
  for (const key of Object.keys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return value;
}

function refuse(container: string, method: string): () => never {
  return () => {
    throw new TypeError(
      `${container}.${method} is not available on a PnL value: a folded state is ` +
        "immutable and is rebuilt from its records, never edited (§6 invariant 8)",
    );
  };
}

function guard<T extends object>(container: string, target: T, methods: readonly string[]): T {
  for (const method of methods) {
    Object.defineProperty(target, method, {
      value: refuse(container, method),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  return Object.freeze(target);
}

/**
 * Seals a map: its entries cannot be added, replaced, or removed, AND every
 * key and value it holds is deep-frozen (review round 2, HIGH-4).
 */
export function frozenMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  for (const [key, value] of map) {
    deepFreeze(key);
    deepFreeze(value);
  }
  return guard("Map", map, MAP_MUTATORS);
}

/** Seals a set the same way, deep-freezing every member. */
export function frozenSet<T>(set: Set<T>): ReadonlySet<T> {
  for (const value of set) {
    deepFreeze(value);
  }
  return guard("Set", set, SET_MUTATORS);
}
