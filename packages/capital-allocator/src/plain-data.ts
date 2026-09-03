/**
 * THE DATA-RECORD BOUNDARY — adversarial review round 5, BLOCKER 3.
 *
 * DUPLICATED, NOT SHARED, from `@polymarket-bot/risk`'s `src/plain-data.ts`.
 * The `guards.ts` precedent in this same package applies verbatim: sharing a
 * module between two layer-1 packages needs a same-layer edge that
 * `docs/contracts/dependency-direction.md` §2.1 does not list, and this
 * remediation may not widen a frozen contract to make its own life easier. The
 * two copies are byte-identical below the header, each has its own tests, and
 * `docs/handoffs/WP-180.md` records the duplication so a future contract owner
 * can collapse them with one §2.1 row.
 *
 * WHY THIS PACKAGE NEEDS IT. `parseAllocatorCaps`, `createAllocatorState` and
 * the reservation entry points all take a caller-supplied `unknown` and hand it
 * straight to `safeParse`. `zod` READS properties, so a caller's getter runs
 * inside the parse — review round 5 threw `Error("caps-getter")` straight out
 * of `parseAllocatorCaps` from a valid-SHAPED object whose `globalAccountCap`
 * was an accessor. A function whose contract is a typed refusal must not have
 * an exception as one of its answers, and the fix is the same one the risk
 * package landed: read the value into plain own data first, and let the schema
 * see only that.
 *
 * Everything below — including the round-5 claim and its stated assumptions —
 * is the risk package's text, kept verbatim so the two copies can be diffed.
 */

import { types } from "node:util";

/**
 * Whether `value` is a `Proxy`, WITHOUT running any of its traps.
 *
 * WHY A NODE BUILT-IN, AND WHY IT IS PERMITTED HERE. There is no portable
 * JavaScript predicate for this. `Object.getPrototypeOf`, `Reflect.ownKeys`,
 * `Object.getOwnPropertyDescriptor`, `Object.isFrozen`, `in`, and every other
 * reflective operation are trapped, so any portable probe hands control to the
 * caller — which is the thing being prevented. `util.types.isProxy` is a
 * V8-level type check (`value->IsProxy()`); it consults no handler, works on a
 * REVOKED proxy, and works on a proxy created in another realm.
 *
 * The import is inside this package's grant and inside the dependency contract:
 * `packages/risk` and `packages/capital-allocator` are both layer 1
 * (`docs/contracts/dependency-direction.md` §2), and layer 1 has no import
 * allowlist — only layer 0 does (§3 F15 binds `packages/decimal` to `decimal.js`
 * and `node:crypto`; the §3 F14 purity rule binds `packages/domain`,
 * `packages/strategies/**`, `packages/ledger` and `packages/simulation`, none of
 * which is either package here). And on the substance rather than the letter: a
 * type predicate is not I/O. It opens no connection, reads no clock, touches no
 * filesystem, consumes no entropy, and is a pure function of its argument, so
 * the package's own "no I/O, no clock, no network, no credential surface"
 * description still holds exactly as written.
 *
 * This reasoning is package-scoped by construction: it turns on which layer the
 * importing package sits in and which §3 rows bind it, so it establishes nothing
 * about any other package's import budget.
 */
function isProxyValue(value: object): boolean {
  return types.isProxy(value);
}

/** Deepest nesting a record may have. A record is data, not a data structure. */
export const MAX_DEPTH = 64;

/**
 * A TOTAL description of a value, for refusal text.
 *
 * NEVER COERCES. Round 5's escape was `String(reported)` on an array `length`
 * a `Proxy` had made a hostile object: `String` invokes `@@toPrimitive`, so
 * building the REFUSAL ran caller code and threw out of the boundary. This
 * helper only ever converts a PRIMITIVE (whose `ToString` is defined by the
 * specification with no method lookup) and describes anything else by its type.
 */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return value.length > 64 ? `a ${String(value.length)}-character string` : `"${value}"`;
    case "number":
    case "boolean":
    case "bigint":
      return `${value}`;
    case "symbol":
      return "a symbol";
    case "function":
      return "a function";
    default:
      return "an object";
  }
}

/** One reason a value could not be read as record data, and where it sat. */
export interface PlainDataProblem {
  readonly path: string;
  readonly problem: string;
}

/** One string the read materialized. */
export interface PlainDataString {
  /** Dotted/indexed path from the root, for refusal evidence. */
  readonly path: string;
  /** Property names on the way down, array indices excluded. */
  readonly keys: readonly string[];
  readonly value: string;
}

export type PlainDataRead =
  | {
      readonly ok: true;
      /** A fresh tree of plain objects, arrays and primitives. */
      readonly value: unknown;
      readonly strings: readonly PlainDataString[];
    }
  | { readonly ok: false; readonly problems: readonly PlainDataProblem[] };

interface ReadState {
  readonly problems: PlainDataProblem[];
  readonly strings: PlainDataString[];
  /** Objects on the CURRENT path, so a shared sub-object is not a cycle. */
  readonly ancestors: WeakSet<object>;
}

/**
 * Reads `value` into plain own data, or reports every reason it is not a record.
 *
 * `path` names the root in the problem and string paths (`"record"`).
 *
 * TOTAL. The outer guard is the last line of proposition 2 above: the walk below
 * already wraps every reflective operation, and this catches anything an
 * assumption of ours got wrong, so no caller of this module can receive an
 * exception where the contract promises a result.
 */
export function readPlainData(value: unknown, path: string): PlainDataRead {
  const state: ReadState = { problems: [], strings: [], ancestors: new WeakSet() };
  let read: unknown;
  try {
    read = readInto(value, path, [], 0, state);
  } catch {
    return {
      ok: false,
      problems: [
        {
          path,
          problem:
            "reading it as data failed unexpectedly; a value that cannot be read is refused rather than emitted (fail closed)",
        },
      ],
    };
  }
  if (state.problems.length > 0) return { ok: false, problems: state.problems };
  return { ok: true, value: read, strings: state.strings };
}

function readInto(
  value: unknown,
  path: string,
  keys: readonly string[],
  depth: number,
  state: ReadState,
): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string") {
    state.strings.push({ path, keys, value: value as string });
    return value;
  }
  if (kind === "number" || kind === "boolean" || kind === "undefined") return value;
  if (kind !== "object") {
    state.problems.push({ path, problem: `a record carries data, not a ${kind}` });
    return undefined;
  }

  const container = value as object;

  // FIRST, BEFORE ANY REFLECTIVE OPERATION. Everything below this line — the
  // prototype read, the key list, every descriptor — is trapped on a `Proxy`,
  // so the check that a value is not one has to come before all of them, and
  // has to be trap-free itself. See {@link isProxyValue}.
  let proxied: boolean;
  try {
    proxied = isProxyValue(container);
  } catch {
    state.problems.push({ path, problem: "it could not be classified as data" });
    return undefined;
  }
  if (proxied) {
    state.problems.push({
      path,
      problem:
        "a Proxy: a record is data, and a Proxy is code that answers questions about data — it may answer differently on a second read, omit a property, describe one it does not have, or throw",
    });
    return undefined;
  }

  if (state.ancestors.has(container)) {
    state.problems.push({ path, problem: "a cycle: a record is a finite tree of data" });
    return undefined;
  }
  if (depth >= MAX_DEPTH) {
    state.problems.push({ path, problem: `nested deeper than ${MAX_DEPTH} levels` });
    return undefined;
  }

  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(container);
  } catch {
    state.problems.push({ path, problem: "its prototype could not be read" });
    return undefined;
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(container);
  } catch {
    state.problems.push({ path, problem: "it could not be classified as data" });
    return undefined;
  }

  if (prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype)) {
    state.problems.push({
      path,
      problem:
        "a non-plain prototype: an inherited property is state the record does not own, and freezing the record cannot freeze it",
    });
    return undefined;
  }

  state.ancestors.add(container);
  try {
    return isArray
      ? readArray(container, path, keys, depth, state)
      : readObject(container, path, keys, depth, state);
  } finally {
    state.ancestors.delete(container);
  }
}

/** The own string keys of `container`, or `undefined` if they cannot be read. */
function ownStringKeys(
  container: object,
  path: string,
  state: ReadState,
): readonly string[] | undefined {
  let ownKeys: readonly (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(container);
  } catch {
    state.problems.push({ path, problem: "its own property names could not be read" });
    return undefined;
  }
  const stringKeys: string[] = [];
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      state.problems.push({
        path,
        problem: `a symbol-keyed property (${String(key)}) is not record data`,
      });
      continue;
    }
    stringKeys.push(key);
  }
  return stringKeys;
}

/**
 * The DATA value of one own property, or `undefined` with a problem recorded.
 *
 * Reads the descriptor rather than the property, so a getter is refused without
 * being invoked. `container` is known not to be a `Proxy` by the time this runs
 * (see {@link readInto}), so the descriptor object comes from the specification
 * rather than from a trap — which is what makes reading `"value" in descriptor`
 * and `descriptor.value` safe: on a trap result, `Object.getOwnPropertyDescriptor`
 * itself runs the caller's getters while normalizing it (round 5).
 */
function ownDataValue(
  container: object,
  key: string,
  path: string,
  state: ReadState,
): { readonly present: boolean; readonly value?: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, key);
  } catch {
    state.problems.push({ path, problem: "its property descriptor could not be read" });
    return { present: false };
  }
  if (descriptor === undefined) return { present: false };
  if (!("value" in descriptor)) {
    state.problems.push({
      path,
      problem:
        "an accessor property: a getter is code, not data — it can throw, can answer differently on a second read, and cannot be frozen",
    });
    return { present: false };
  }
  return { present: true, value: descriptor.value };
}

/**
 * Creates `key` on the materialized object as an OWN ENUMERABLE DATA property.
 *
 * `Object.defineProperty`, never `out[key] = value` — review round 5's first
 * BLOCKER. Assignment is `Set`, which consults the prototype chain: for
 * `key = "__proto__"` it finds `Object.prototype`'s accessor and invokes its
 * SETTER, so the value became the emitted object's PROTOTYPE and no own
 * property was created at all. The result reported `plainPrototype: false` and
 * `prototypeFrozen: false`, and adding a field to that prototype after the call
 * returned changed what the "frozen, validated" record reported — bypassing both
 * identity validation and deep immutability at once. `defineProperty` has
 * `CreateDataProperty` semantics: it defines on the object itself and consults
 * no setter, inherited or otherwise.
 */
function defineDataProperty(out: object, key: string, value: unknown): void {
  Object.defineProperty(out, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * The one property NAME a record may not carry, and the measured reason.
 *
 * `defineDataProperty` alone makes `__proto__` an honest own data property, and
 * that closes the prototype-hijack half of round 5's first BLOCKER. But
 * materializing it faithfully then exposed a second problem, found by probing
 * rather than by reading: **`zod`'s `strictObject` is blind to exactly this one
 * key.** Measured against the version this repository pins, with the property
 * created by `defineProperty` so it is genuinely own and enumerable:
 *
 * ```text
 * KEY __proto__:        success=true   parsed output keys = ["a"]   (dropped)
 * KEY constructor:      success=false  Unrecognized key: "constructor"
 * KEY prototype:        success=false  Unrecognized key: "prototype"
 * KEY toString:         success=false  Unrecognized key: "toString"
 * KEY hasOwnProperty:   success=false  Unrecognized key: "hasOwnProperty"
 * KEY valueOf:          success=false  Unrecognized key: "valueOf"
 * KEY __defineGetter__: success=false  Unrecognized key: "__defineGetter__"
 * KEY then / length / name: success=false  Unrecognized key
 * ```
 *
 * So a field under this name is the one field a strict schema in this
 * repository CANNOT refuse and CANNOT report — and this package's whole
 * emission contract is that an unexpected field is refused rather than dropped.
 * A record therefore may not carry the name at all: it is refused HERE, where
 * the refusal is explicit and names the path, rather than left to a validator
 * that silently ignores it.
 *
 * Nothing legitimate is lost. No shape in this repository declares a
 * `__proto__` field; `JSON.parse` is the only ordinary way to produce one, and
 * a payload that does is not a record this package should be emitting.
 */
const FORBIDDEN_KEY = "__proto__";

function readObject(
  container: object,
  path: string,
  keys: readonly string[],
  depth: number,
  state: ReadState,
): unknown {
  const stringKeys = ownStringKeys(container, path, state);
  if (stringKeys === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const memberPath = `${path}.${key}`;
    if (key === FORBIDDEN_KEY) {
      state.problems.push({
        path: memberPath,
        problem:
          'a "__proto__" property: it is the one property name a strict schema in this repository cannot report as unrecognized, so a field under it could never be validated — and a record whose extra fields cannot be refused is not a record',
      });
      continue;
    }
    const member = ownDataValue(container, key, memberPath, state);
    if (!member.present) continue;
    defineDataProperty(
      out,
      key,
      readInto(member.value, memberPath, [...keys, key], depth + 1, state),
    );
  }
  return out;
}

/** A canonical array index, as a property name (`"0"`, `"12"`, never `"01"`). */
function arrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : undefined;
}

/**
 * The reported `length` of an array, read from its DESCRIPTOR.
 *
 * Not `container.length`. A property READ is `Get`, which is trapped, and round
 * 5's escape was exactly that: an array `Proxy` answered `length` with an object
 * whose `@@toPrimitive` threw. A `Proxy` is refused before this point now, so
 * this is defence in depth — but the descriptor read is the correct primitive
 * for the same reason every other read in this module is one, and it costs
 * nothing.
 */
function reportedLength(
  container: object,
  path: string,
  state: ReadState,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, "length");
  } catch {
    state.problems.push({ path, problem: "its length could not be read" });
    return { ok: false };
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    state.problems.push({
      path,
      problem: "its length is not an own data property, so the array is not data",
    });
    return { ok: false };
  }
  return { ok: true, value: descriptor.value };
}

function readArray(
  container: object,
  path: string,
  keys: readonly string[],
  depth: number,
  state: ReadState,
): unknown {
  const stringKeys = ownStringKeys(container, path, state);
  if (stringKeys === undefined) return undefined;

  const members = new Map<number, unknown>();
  let highest = -1;
  for (const key of stringKeys) {
    if (key === "length") continue;
    const index = arrayIndex(key);
    if (index === undefined) {
      state.problems.push({
        path: `${path}.${key}`,
        problem: "a non-index property on an array is not record data",
      });
      continue;
    }
    const memberPath = `${path}[${index}]`;
    const member = ownDataValue(container, key, memberPath, state);
    if (!member.present) continue;
    members.set(index, readInto(member.value, memberPath, keys, depth + 1, state));
    if (index > highest) highest = index;
  }

  // The length is DERIVED from the index properties that are really there, so a
  // hostile `length` cannot drive an allocation or a loop. It is then compared
  // against the reported length: a mismatch means holes, which a record has not.
  const length = highest + 1;
  if (members.size !== length) {
    state.problems.push({ path, problem: "a sparse array: a record has no holes" });
    return undefined;
  }
  const reported = reportedLength(container, path, state);
  if (!reported.ok) return undefined;
  if (reported.value !== length) {
    state.problems.push({
      path,
      // `describeValue`, not `String(...)`: the reported length is a
      // caller-derived value, and coercing one to build a refusal is how round
      // 5's exception escaped.
      problem: `its length (${describeValue(reported.value)}) disagrees with the ${String(length)} elements it carries`,
    });
    return undefined;
  }

  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) out.push(members.get(index));
  return out;
}
