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
 * Honest limits, stated rather than implied:
 *
 * - `Map.prototype.set.call(guarded, k, v)` still reaches the internal slot.
 *   Nothing short of a wrapper object closes that, and a wrapper would stop
 *   being a `Map` (`instanceof`, `new Map(other)`, structural equality in
 *   tests). The guard is a loud-failure boundary for ordinary use, not a
 *   capability confinement.
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

/** Freezes a map's contents as well as its properties. */
export function frozenMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  return guard("Map", map, MAP_MUTATORS);
}

/** Freezes a set's contents as well as its properties. */
export function frozenSet<T>(set: Set<T>): ReadonlySet<T> {
  return guard("Set", set, SET_MUTATORS);
}
