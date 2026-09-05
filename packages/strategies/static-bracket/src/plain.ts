/**
 * The package's parse door: prototype-free materialization and own-only reads.
 *
 * ADR-020 conformance posture for `packages/strategies/static-bracket`, stated
 * where the door lives (`docs/contracts/schema-boundary.md` §4 requires the
 * statement to be in the door's own comment):
 *
 * - **D1 — materialize prototype-free before validating.** Every value this
 *   package validates (the instance params handed to `paramsSchema.safeParse`,
 *   and the state document read back out of `ctx.state()`) is first copied by
 *   {@link plainCopy} into a tree built with `Object.create(null)`, reading only
 *   own, enumerable, string-keyed DATA properties. An accessor, a symbol key, a
 *   non-enumerable own property, a non-plain prototype (`Map`, `Set`, `Date`, a
 *   class instance), a function, `undefined`, a non-finite number, a sparse
 *   array hole and a cycle are all REFUSED, not coerced.
 * - **D2 — parse through a warmed arena: NOT APPLICABLE, and that is a
 *   structural fact rather than an omission.** `packages/strategies/**` is
 *   purity-restricted (`docs/contracts/dependency-direction.md` §3 F3/F14,
 *   ADR-005 §1) and this package imports no schema library at all — there is no
 *   `zod` parse, so there is no `_zod` container to sever or warm. Validation
 *   below is hand-rolled, total, and reads nothing off a prototype chain, which
 *   is the property D2 exists to restore for a library that does.
 * - **D3 — every value comes from the materialized tree.** Validation never
 *   re-reads the caller's object: `safeParse` walks the copy, and the copy is
 *   what becomes `data`.
 * - **D4 — emit prototype-free.** Everything this door returns is built with a
 *   null prototype.
 *
 * One consequence that is NOT covered by D1-D4 and is handled separately: the
 * runtime re-materializes the params into ITS own copy, whose objects carry
 * `Object.prototype` (`packages/strategy-runtime/src/json.ts` builds `{}`), so a
 * key ABSENT from the parsed params could be answered by a polluted prototype
 * when a callback reads it. This package closes that by construction rather
 * than by copying again on every evaluation: the grammar in `params.ts` has NO
 * optional keys and NO defaults, so a validated params tree contains every
 * declared key as an own property and no read of it can reach a prototype.
 * `test/unit/strategies/static-bracket/hostile-config.test.ts` measures it.
 *
 * Purity: no I/O, no clock, no randomness, no `node:` import, no evaluator, no
 * `.constructor` read (F14).
 */

/** The inert data a materialized value is made of. */
export type PlainJson =
  | null
  | boolean
  | number
  | string
  | readonly PlainJson[]
  | { readonly [key: string]: PlainJson };

/** Every fallible operation in this package answers in this shape. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

/**
 * Maximum container nesting {@link plainCopy} accepts, counted from the value
 * handed in. The deepest structure this package's own grammars describe is
 * three containers (`params -> entry -> execution`), so 16 is far beyond any
 * legitimate input and far below any engine's stack limit. A deeper structure
 * is a refusal with a stated path, never a `RangeError`.
 */
export const MAX_PLAIN_DEPTH = 16;

const PLAIN_PROTOTYPES: readonly (object | null)[] = [Object.prototype, null];

export function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function bad<T>(problem: string): Outcome<T> {
  return { ok: false, problem };
}

/** Own-property test that cannot be answered by a prototype chain. */
export function hasOwn(container: object, key: string): boolean {
  return Object.hasOwn(container, key);
}

/** A short, total description of an unexpected value for a refusal message. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string") return "a string";
  if (kind === "number" || kind === "boolean" || kind === "bigint") {
    return `${kind} ${String(value)}`;
  }
  if (kind === "undefined") return "undefined";
  if (kind === "function") return "a function";
  if (kind === "symbol") return "a symbol";
  if (Array.isArray(value)) return `an array of length ${String(value.length)}`;
  return "an object";
}

/**
 * Copies `value` into a fresh, prototype-free tree of inert data, or refuses
 * with a stated path. TOTAL: it never throws, and it never runs caller code —
 * an accessor is refused from its DESCRIPTOR, without invoking its getter.
 */
export function plainCopy(value: unknown, path: string): Outcome<PlainJson> {
  return copyAt(value, path, 0, []);
}

function copyAt(
  value: unknown,
  path: string,
  depth: number,
  ancestors: readonly object[],
): Outcome<PlainJson> {
  const kind = typeof value;
  if (value === null) return ok(null);
  if (kind === "string") return ok(value as string);
  if (kind === "boolean") return ok(value as boolean);
  if (kind === "number") {
    const numeric = value as number;
    if (!Number.isFinite(numeric)) {
      return bad(`${path}: a non-finite number has no JSON form`);
    }
    return ok(numeric);
  }
  if (kind === "undefined") {
    return bad(
      `${path}: undefined is not a value — this grammar has no optional keys, so an ` +
        "absent setting is a refusal, never an implicit default",
    );
  }
  if (kind !== "object") {
    return bad(`${path}: ${describe(value)} is not JSON-shaped configuration data`);
  }

  const container = value as object;
  for (const ancestor of ancestors) {
    if (ancestor === container) {
      return bad(`${path}: the value is cyclic; configuration must be a finite tree`);
    }
  }
  if (depth >= MAX_PLAIN_DEPTH) {
    return bad(
      `${path}: nested deeper than ${String(MAX_PLAIN_DEPTH)} containers, which this ` +
        "boundary refuses rather than walks",
    );
  }
  const nextAncestors = [...ancestors, container];

  if (Array.isArray(container)) {
    const source = container as readonly unknown[];
    const keys = Object.keys(source);
    // `length` is not an own enumerable key, so the count is the element count;
    // a sparse array reports fewer keys than its length and is refused.
    if (keys.length !== source.length) {
      return bad(`${path}: a sparse array has holes that JSON would fill with null`);
    }
    if (Object.getOwnPropertySymbols(source).length > 0) {
      return bad(`${path}: symbol-keyed properties are invisible to JSON`);
    }
    const copy: PlainJson[] = [];
    for (let index = 0; index < source.length; index += 1) {
      const elementPath = `${path}[${String(index)}]`;
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
      if (descriptor === undefined) {
        return bad(`${elementPath}: array hole`);
      }
      if (!("value" in descriptor)) {
        return bad(`${elementPath}: an accessor property is not data`);
      }
      const element = copyAt(descriptor.value, elementPath, depth + 1, nextAncestors);
      if (!element.ok) return element;
      copy.push(element.value);
    }
    return ok(Object.freeze(copy));
  }

  const prototype = Object.getPrototypeOf(container) as object | null;
  if (!PLAIN_PROTOTYPES.includes(prototype)) {
    return bad(
      `${path}: only plain objects and arrays are configuration data — a Map, Set, Date, ` +
        "class instance or exotic object is refused, never unwrapped",
    );
  }
  if (Object.getOwnPropertySymbols(container).length > 0) {
    return bad(`${path}: symbol-keyed properties are invisible to JSON`);
  }
  const ownKeys = Object.getOwnPropertyNames(container);
  const enumerableKeys = Object.keys(container);
  if (ownKeys.length !== enumerableKeys.length) {
    return bad(
      `${path}: a non-enumerable own property is invisible to JSON serialization and would ` +
        "be dropped silently",
    );
  }
  const copy: Record<string, PlainJson> = Object.create(null) as Record<string, PlainJson>;
  for (const key of enumerableKeys) {
    const memberPath = `${path}.${key}`;
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined) {
      return bad(`${memberPath}: own properties changed while they were being read`);
    }
    if (!("value" in descriptor)) {
      return bad(
        `${memberPath}: an accessor property is a value recomputed on every read, which no ` +
          "immutable configuration may contain",
      );
    }
    const member = copyAt(descriptor.value, memberPath, depth + 1, nextAncestors);
    if (!member.ok) return member;
    // The copy has a null prototype, so a plain assignment of the literal key
    // `__proto__` creates an ordinary own property: there is no inherited
    // setter to trigger.
    copy[key] = member.value;
  }
  return ok(Object.freeze(copy));
}

/** A materialized object, for readers that must not touch a prototype chain. */
export type PlainRecord = { readonly [key: string]: PlainJson };

export function isPlainRecord(value: PlainJson | undefined): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one own key of a materialized record, refusing an absent key by name.
 * Every read in this package goes through here, so "absent" can never be
 * answered by an inherited value.
 */
export function readOwn(record: PlainRecord, key: string, path: string): Outcome<PlainJson> {
  if (!hasOwn(record, key)) {
    return bad(`${path}.${key} is required and absent (this grammar has no defaults)`);
  }
  return ok(record[key] as PlainJson);
}

/** Refuses any own key the grammar does not declare, naming the first one. */
export function refuseUnknownKeys(
  record: PlainRecord,
  allowed: readonly string[],
  path: string,
): Outcome<null> {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return bad(
        `${path}.${key} is not part of the static-bracket configuration grammar; an ` +
          "unrecognized key is refused rather than ignored",
      );
    }
  }
  return ok(null);
}
