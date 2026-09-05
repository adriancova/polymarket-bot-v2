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
 * (`WP-200-FU1` added §2.1 **S5** and **S6**, but both run to
 * `packages/risk` and carry the parse door ONLY — they are not a licence for a
 * `pnl` ⇄ `ledger` edge, which no row permits and which would be a cycle.)
 */

import { ownDataDescriptor } from "@polymarket-bot/risk/plain-data";

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
 *
 * THE MEMO IS ADDED TO ONLY AFTER THE FREEZE SUCCEEDS (`WP-200-FU1`, closing
 * `WP-200`'s carried LOW residual). The order was `DEEP_FROZEN.add(object)`
 * then `Object.freeze(object)`, and the whole soundness argument for the memo
 * is the sentence above it — "a member of this set is frozen, so its own
 * property values cannot have changed since it was walked". A throwing
 * `Object.freeze` (a `Proxy` whose `preventExtensions` trap throws is the
 * reachable case) falsified that: the object was recorded as done while still
 * mutable, and every LATER `deepFreeze` of it — including one from a clean
 * caller on a retry — returned immediately without freezing anything. In this
 * package that value would be a lot, a trade effect or a realized figure.
 * Swapping the two lines makes the memo mean what it says. Cycle termination is
 * unaffected: the `add` still happens BEFORE the recursion below, which is the
 * only thing that can re-enter.
 *
 * `Object.hasOwn(descriptor, "value")`, NOT `"value" in descriptor`
 * (`WP-200-FU1`, the same class and the same fix as `packages/risk`'s
 * `plain-data.ts` review round 6): a descriptor is an ordinary object, `in`
 * answers for an INHERITED name, and with `Object.prototype.value` defined
 * every ACCESSOR descriptor read as a data descriptor here.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const object = value as unknown as object;
  if (DEEP_FROZEN.has(object)) {
    return value;
  }
  Object.freeze(object);
  DEEP_FROZEN.add(object);
  if (Array.isArray(object)) {
    for (const item of object) {
      deepFreeze(item);
    }
    return value;
  }
  for (const key of Object.keys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
      deepFreeze(descriptor.value);
    }
  }
  return value;
}

/**
 * A fresh MUTABLE record with no prototype, for accumulating own data.
 *
 * `WP-200-FU1`. An ordinary `{}` accumulator is not a neutral container: the
 * assignment `record[key] = value` is `Set`, which walks the prototype chain,
 * so an inherited get-only accessor at that key makes the write THROW and an
 * inherited setter makes it run caller code. This package's canonical
 * serializers — the byte oracle `WP-200`'s acceptance tests rest on — did
 * exactly that, keyed by token asset id and denomination asset, both of which
 * are caller-chosen strings. On a null-prototype target the same assignment is
 * a plain `CreateDataProperty`.
 */
export function plainRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * **D4** — a frozen record with NO PROTOTYPE, built from an ordinary literal.
 *
 * ADR-020 §3 step 4: "the door's own result has a null prototype", because an
 * emitted record is read by somebody else's `?? default` and an ordinary object
 * answers that read from `Object.prototype`. Concretely in this package: a
 * `PnlSnapshot` row read by a composition root binding it to
 * `accounting.pnl_snapshots`, and an `OpenLot` whose `marketId` is a nullable
 * column.
 *
 * Reading `fields` is safe: it is always a literal this package just built, and
 * an object literal's properties are CREATED, never assigned, so no inherited
 * setter ran while it was made. The DESCRIPTOR comes from
 * `@polymarket-bot/risk/plain-data`, because a descriptor written as an object
 * literal is read through the prototype chain and an inherited `get` turns
 * every `Object.defineProperty` into a `TypeError` (measured — `WP-180` round
 * 8).
 */
export function plainFrozen<T extends object>(fields: T): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const descriptor = Object.getOwnPropertyDescriptor(fields, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      continue;
    }
    Object.defineProperty(out, key, ownDataDescriptor(descriptor.value));
  }
  return Object.freeze(out) as unknown as T;
}

function refuse(container: string, method: string): () => never {
  return () => {
    throw new TypeError(
      `${container}.${method} is not available on a PnL value: a folded state is ` +
        "immutable and is rebuilt from its records, never edited (§6 invariant 8)",
    );
  };
}

/**
 * The guard's own descriptor, WITH NO PROTOTYPE (`WP-200-FU1`).
 *
 * `ownDataDescriptor` cannot be reused: a guard is deliberately non-writable,
 * non-enumerable and non-configurable, and that one is the door's data-property
 * shape. The reason it must not be an object LITERAL is the same measured one
 * (`WP-180` round 8): the specification reads a descriptor's fields with
 * `HasProperty`, which walks the prototype chain, so one inherited `get` made
 * every `Object.defineProperty` in the process a `TypeError`. That would have
 * made this package's containers UNSEALABLE under a name nothing in the schema
 * material names — which is a varying permission, not a varying refusal
 * (ADR-020 §6).
 */
function guardDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = false;
  descriptor.enumerable = false;
  descriptor.configurable = false;
  return descriptor;
}

function guard<T extends object>(container: string, target: T, methods: readonly string[]): T {
  for (const method of methods) {
    Object.defineProperty(target, method, guardDescriptor(refuse(container, method)));
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
