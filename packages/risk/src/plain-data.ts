/**
 * THE DATA-RECORD BOUNDARY — adversarial review round 4.
 *
 * WHY THIS MODULE EXISTS. Round 3 replaced a list of identity fields with a
 * WALK over the record about to be emitted. Round 4 found the walk's
 * ENUMERATION PRIMITIVE had become the new list: `Object.entries` sees only
 * enumerable, own, string-keyed properties, so three shapes slipped past it —
 * a non-enumerable property, a property on the object's PROTOTYPE, and an
 * accessor (which `Object.entries` does not skip but INVOKES, so a throwing
 * getter escaped a function whose whole contract is a typed result). Worse, the
 * property test walked the same way, so it could never see what the product
 * missed.
 *
 * The lesson generalizes past any particular primitive: a JavaScript object is
 * not the same thing as a data record. It can hide state behind enumerability,
 * inherit it, compute it on read, change it between two reads, or throw when
 * asked. So this package stops treating caller-supplied objects as records.
 * {@link readPlainData} READS a value into a record — a fresh tree of plain
 * objects, arrays and primitives, every property an own, enumerable, data
 * property — or refuses with the reason and the path. Everything downstream
 * (identity validation, arithmetic, emission) then operates on that tree, where
 * "what a walk can see" and "what the value carries" are the same set.
 *
 * WHAT IT REFUSES, AND WHY EACH IS NOT RECORD DATA:
 *
 * - a NON-PLAIN PROTOTYPE (anything but `Object.prototype`, `Array.prototype`
 *   or `null`). An inherited property is state the container does not own, and
 *   `Object.freeze` cannot freeze it: the round-4 probe froze a record and then
 *   changed the value it reported by editing the prototype afterwards. Refusing
 *   the shape outright is what makes "the emitted record is deeply immutable"
 *   true rather than approximately true;
 * - an ACCESSOR property. A getter is code, not data. It may throw, may return
 *   a different value on the next call (the validate-then-emit TOCTOU), and may
 *   have side effects. This module never invokes one: values are taken from
 *   property DESCRIPTORS, so a hostile getter is refused without ever running;
 * - a FUNCTION, SYMBOL or BIGINT value, and a SYMBOL-KEYED property. None can
 *   be a field of a persisted record; dropping them silently is the failure
 *   mode this whole review chain is about;
 * - a CYCLE, a SPARSE array, and nesting deeper than {@link MAX_DEPTH}. A
 *   record is a finite tree.
 *
 * WHAT IT DOES NOT REFUSE: a NON-ENUMERABLE own data property is READ, not
 * rejected. Hiding a field from enumeration does not make it disappear from the
 * value, so materializing it (as an ordinary own enumerable property) is what
 * lets the identity rules see it — the round-4 probe's uppercase market id
 * comes back as a `RISK_UUID_NOT_CANONICAL` refusal naming its exact path,
 * which is a better answer than a shape refusal.
 *
 * TOTAL AND NON-THROWING. Every reflective operation here can be trapped by a
 * `Proxy` and made to throw; each is wrapped, and a failure is a refusal at a
 * named path. Nothing in this module can propagate an exception to a caller
 * whose contract is a typed result.
 *
 * IT REPORTS THE STRINGS IT READ. The read yields an inventory of every string
 * it materialized, with the path and the property names on the way down. The
 * package's identity rules consume that inventory instead of walking again, so
 * there is exactly ONE traversal primitive in the emission path and it is this
 * one.
 */

/** Deepest nesting a record may have. A record is data, not a data structure. */
export const MAX_DEPTH = 64;

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
 */
export function readPlainData(value: unknown, path: string): PlainDataRead {
  const state: ReadState = { problems: [], strings: [], ancestors: new WeakSet() };
  const read = readInto(value, path, [], 0, state);
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
 * being invoked — no caller code runs inside this boundary.
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
    const member = ownDataValue(container, key, memberPath, state);
    if (!member.present) continue;
    out[key] = readInto(member.value, memberPath, [...keys, key], depth + 1, state);
  }
  return out;
}

/** A canonical array index, as a property name (`"0"`, `"12"`, never `"01"`). */
function arrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : undefined;
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
  let reported: unknown;
  try {
    reported = (container as { readonly length?: unknown }).length;
  } catch {
    state.problems.push({ path, problem: "its length could not be read" });
    return undefined;
  }
  if (reported !== length) {
    state.problems.push({
      path,
      problem: `its length (${String(reported)}) disagrees with the ${length} elements it carries`,
    });
    return undefined;
  }

  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) out.push(members.get(index));
  return out;
}
