/**
 * THE INPUT BOUNDARY: read a caller value into plain own data, or refuse.
 *
 * WHY THIS MODULE EXISTS. The repository's recorded cross-package schema risk
 * (`IMPLEMENTATION_STATUS.md`, 2026-09-03; measured by WP-180 against the
 * pinned `zod` 4.4.3) is that a schema parse output is NOT clean data: it can
 * ADOPT inherited fields, DROP present fields, lose its own `.default()`s, and
 * have every format check disabled by one inherited parse-context flag. The
 * binding remedy is: materialize a prototype-free copy BEFORE parsing, and take
 * every value from YOUR materialized tree, never from a library's assembled
 * output.
 *
 * This package implements the strongest local form of that remedy: it runs NO
 * runtime schema library at all. This module reads the caller's value into a
 * fresh prototype-free tree (the WP-180 / `packages/risk` `readPlainData`
 * pattern, implemented locally because `packages/risk` is a same-layer package
 * this one may not import), and `inputs.ts` then validates that tree with
 * hand-written total predicates. Nothing downstream ever touches the caller's
 * object graph, and no correctness-relevant setting exists as a schema default
 * because no schema runs.
 *
 * Mechanics, each carrying a measured WP-180 lesson:
 *
 * - values are taken from property DESCRIPTORS, never property reads, so a
 *   getter is refused without being invoked;
 * - materialized properties are created with `Object.defineProperty` and a
 *   prototype-free descriptor, so no inherited setter runs and an inherited
 *   `get`/`set` on `Object.prototype` cannot make `defineProperty` throw;
 * - materialized objects have NO PROTOTYPE, so an absent field stays absent
 *   under any later read, whatever is on `Object.prototype`;
 * - `__proto__` as a property NAME is refused (it is the one name a strict
 *   schema in this repository cannot report, and a faithful copy of it would
 *   change meaning);
 * - symbol keys, accessors, functions, bigints, non-plain prototypes, cycles,
 *   sparse arrays and nesting past {@link MAX_INPUT_DEPTH} are refused with the
 *   path;
 * - the whole read is TOTAL: any unexpected throw becomes a refusal.
 *
 * DISCLOSED LIMIT (recorded in the WP-160 handoff): this module does not
 * detect a `Proxy`. The portable-JavaScript reason is the one `packages/risk`
 * documented — every reflective operation on a Proxy runs a trap, so a portable
 * probe IS the thing it avoids — and that package's answer (`node:util`
 * `types.isProxy`) is carried as its own open residual (R6-1). Here each
 * property is read EXACTLY ONCE into the tree, every trap invocation is inside
 * the totality guard, and everything downstream (validation, computation,
 * content addressing) consumes only the materialized tree — so a Proxy can
 * cause a refusal or supply a tree, but it cannot make one computation read two
 * different values, and the content address always covers exactly the tree the
 * features were computed from.
 */

import { ownDataDescriptor } from "./refusals.js";

/** Deepest nesting an input may have. An input is a record, not a data structure. */
export const MAX_INPUT_DEPTH = 32;

/**
 * A deep, PROTOTYPE-FREE copy of a tree THIS PACKAGE built (plain literals of
 * strings, numbers, booleans, arrays and records; `undefined` members are
 * dropped). Applied at the validated-model boundary and to computed feature
 * outcomes, so an ABSENT OPTIONAL FIELD of an internal model can never be
 * answered by a polluted `Object.prototype` — the exact adoption route the
 * repository's recorded schema risk documents, which this package's own
 * hostile battery reproduced against an earlier draft that returned ordinary
 * literals (`input.trades` on a trades-less model read a polluted prototype
 * section and drove a NaN into the serializer).
 */
export function ownPlainCopy(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((member) => ownPlainCopy(member));
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined) continue;
    Object.defineProperty(out, key, ownDataDescriptor(ownPlainCopy(member)));
  }
  return out;
}

/** One reason a value could not be read as plain data, and where it sat. */
export interface MaterializeProblem {
  readonly path: string;
  readonly problem: string;
}

export type MaterializedInput =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problems: readonly MaterializeProblem[] };

interface ReadState {
  readonly problems: MaterializeProblem[];
  /** Objects on the CURRENT path, so a shared sub-object is not a cycle. */
  readonly ancestors: WeakSet<object>;
}

/**
 * Reads `value` into a fresh prototype-free tree of plain data, or reports
 * every reason it is not one. TOTAL: never throws.
 */
export function materializeInput(value: unknown, rootPath: string): MaterializedInput {
  const state: ReadState = { problems: [], ancestors: new WeakSet() };
  let read: unknown;
  try {
    read = readInto(value, rootPath, 0, state);
  } catch {
    return {
      ok: false,
      problems: [
        {
          path: rootPath,
          problem:
            "reading it as data failed unexpectedly; a value that cannot be read is refused rather than computed over (fail closed)",
        },
      ],
    };
  }
  if (state.problems.length > 0) {
    return { ok: false, problems: state.problems };
  }
  return { ok: true, value: read };
}

function readInto(value: unknown, path: string, depth: number, state: ReadState): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean" || kind === "undefined") {
    return value;
  }
  if (kind !== "object") {
    state.problems.push({ path, problem: `an input carries data, not a ${kind}` });
    return undefined;
  }
  const container = value as object;

  if (state.ancestors.has(container)) {
    state.problems.push({ path, problem: "a cycle: an input is a finite tree of data" });
    return undefined;
  }
  if (depth >= MAX_INPUT_DEPTH) {
    state.problems.push({ path, problem: `nested deeper than ${String(MAX_INPUT_DEPTH)} levels` });
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
        "a non-plain prototype: an inherited property is state the input does not own, and no copy of the input can carry it faithfully",
    });
    return undefined;
  }

  state.ancestors.add(container);
  try {
    return isArray ? readArray(container, path, depth, state) : readObject(container, path, depth, state);
  } finally {
    state.ancestors.delete(container);
  }
}

function ownStringKeys(container: object, path: string, state: ReadState): readonly string[] | undefined {
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
      state.problems.push({ path, problem: `a symbol-keyed property (${String(key)}) is not input data` });
      continue;
    }
    stringKeys.push(key);
  }
  return stringKeys;
}

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
  // `Object.hasOwn`, not `"value" in descriptor`: `in` answers for an
  // INHERITED name, so with `Object.prototype.value` defined every accessor
  // descriptor would read as a data descriptor (the WP-180 round-6 census).
  if (!Object.hasOwn(descriptor, "value")) {
    state.problems.push({
      path,
      problem: "an accessor property: a getter is code, not data — it is refused without being invoked",
    });
    return { present: false };
  }
  return { present: true, value: descriptor.value };
}

function defineDataProperty(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, ownDataDescriptor(value));
}

function readObject(container: object, path: string, depth: number, state: ReadState): unknown {
  const keys = ownStringKeys(container, path, state);
  if (keys === undefined) return undefined;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const memberPath = `${path}.${key}`;
    if (key === "__proto__") {
      state.problems.push({
        path: memberPath,
        problem: 'a "__proto__" property: the one name a faithful copy cannot carry without changing meaning',
      });
      continue;
    }
    const member = ownDataValue(container, key, memberPath, state);
    if (!member.present) continue;
    const read = readInto(member.value, memberPath, depth + 1, state);
    // `undefined` members are materialized as ABSENT: the tree records only
    // fields that carry a value, so "present but undefined" cannot diverge
    // from "absent" under any later read of the prototype-free tree.
    if (read !== undefined) {
      defineDataProperty(out, key, read);
    }
  }
  return out;
}

/** A canonical array index as a property name (`"0"`, `"12"`, never `"01"`). */
function arrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : undefined;
}

function readArray(container: object, path: string, depth: number, state: ReadState): unknown {
  const keys = ownStringKeys(container, path, state);
  if (keys === undefined) return undefined;

  const members = new Map<number, unknown>();
  let highest = -1;
  for (const key of keys) {
    if (key === "length") continue;
    const index = arrayIndex(key);
    if (index === undefined) {
      state.problems.push({ path: `${path}.${key}`, problem: "a non-index property on an array is not input data" });
      continue;
    }
    const memberPath = `${path}[${String(index)}]`;
    const member = ownDataValue(container, key, memberPath, state);
    if (!member.present) continue;
    members.set(index, readInto(member.value, memberPath, depth + 1, state));
    if (index > highest) highest = index;
  }

  // Length is DERIVED from the indices that are really there; the reported
  // length is then cross-checked so holes are refused rather than skipped.
  const length = highest + 1;
  if (members.size !== length) {
    state.problems.push({ path, problem: "a sparse array: an input has no holes" });
    return undefined;
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(container, "length");
  } catch {
    state.problems.push({ path, problem: "its length could not be read" });
    return undefined;
  }
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    lengthDescriptor.value !== length
  ) {
    state.problems.push({
      path,
      problem: `its length disagrees with the ${String(length)} elements it carries`,
    });
    return undefined;
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    out.push(members.get(index));
  }
  return out;
}
