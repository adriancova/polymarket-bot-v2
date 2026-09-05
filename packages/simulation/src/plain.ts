/**
 * THE INPUT BOUNDARY: read a caller or wire value into plain own data, or refuse.
 *
 * WHY THIS MODULE EXISTS. [ADR-020](../../../docs/adr/ADR-020-schema-parse-boundary-integrity.md)
 * §1: at the pinned `zod@4.4.3` a successful parse guarantees neither that the
 * output matches the input nor that the declared checks ran — a declared key can
 * be ADOPTED from `Object.prototype` (enumerable *or* non-enumerable), a present
 * field can be LOST, a `.default()` can be defeated, and one inherited
 * `skipChecks` turns every `.uuid()` / `.datetime()` / `.regex()` in the whole
 * process into a no-op. `docs/contracts/schema-boundary.md` §1 fixes the remedy
 * as four steps (D1-D4).
 *
 * This package implements the strongest local form: it runs **no runtime schema
 * library at all** (the `packages/features` / WP-160 precedent). This module is
 * D1 and D4:
 *
 * - **D1** {@link materializeInput} reads a caller value into a fresh
 *   prototype-free tree, from property DESCRIPTORS rather than property reads,
 *   so a getter is refused without being invoked. {@link readOwnPlainInput} is
 *   the one-line form every door uses, so "a door materializes its caller value
 *   before touching it" is mechanical rather than a habit.
 * - **D3** is satisfied by construction, because there is no library output to
 *   take values from: {@link ./grammar.js} validates the materialized tree and
 *   every downstream read is of that tree.
 * - **D4** {@link ownPlainCopy} / {@link ownFrozenTree} emit prototype-free, so
 *   an absent optional field of an emitted record can never be answered by a
 *   polluted `Object.prototype` in the consumer. D4 is an EMIT step: it copies
 *   trees this package built, and a caller value reaches it only after D1.
 *
 * **D2 does not apply**: D2 is "parse through a severed, warmed arena", and an
 * arena exists to close the library's own `_zod` state reads. There is no
 * library, so there is no `_zod` state, no lazy build to poison, and no
 * `skipChecks` / `optin` / `optout` / `when` / `values` slot to inherit. The
 * conformance statement this package makes is recorded in its `README.md` §2.
 *
 * DISCLOSED LIMIT (the same one `packages/features` records): this module does
 * not detect a `Proxy`. Every reflective probe for one runs a trap, i.e. runs
 * caller code inside the door that exists to stop caller code running, and the
 * `node:util` `types.isProxy` answer is not available here — `packages/simulation`
 * is not on `docs/contracts/dependency-direction.md` §2.2's layer-1 built-in
 * allowlist, and this package may not add itself to a contract it does not own.
 * The containment is the same: each property is read EXACTLY ONCE into the tree,
 * every trap invocation sits inside the totality guard, and everything
 * downstream consumes only the materialized tree — so a `Proxy` can cause a
 * refusal or supply a tree, but it cannot make two reads of one field disagree.
 */

import {
  ownDataDescriptor,
  simulationFailure,
  simulationOk,
  type SimulationResult,
} from "./refusals.js";

/** Deepest nesting an input may have. A manifest is a record, not a data structure. */
export const MAX_INPUT_DEPTH = 64;

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
    return isArray
      ? readArray(container, path, depth, state)
      : readObject(container, path, depth, state);
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
      state.problems.push({
        path,
        problem: `a symbol-keyed property (${String(key)}) is not input data`,
      });
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
  if (!Object.hasOwn(descriptor, "value")) {
    state.problems.push({
      path,
      problem: "an accessor property: a getter is code, not data — it is refused without being invoked",
    });
    return { present: false };
  }
  return { present: true, value: descriptor.value };
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
    Object.defineProperty(out, key, ownDataDescriptor(read));
  }
  return out;
}

function readArray(container: object, path: string, depth: number, state: ReadState): unknown {
  const array = container as readonly unknown[];
  let length: number;
  try {
    length = array.length;
  } catch {
    state.problems.push({ path, problem: "its length could not be read" });
    return undefined;
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    state.problems.push({ path, problem: "its length is not a safe non-negative integer" });
    return undefined;
  }
  const keys = ownStringKeys(container, path, state);
  if (keys === undefined) return undefined;
  for (const key of keys) {
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
      state.problems.push({
        path: `${path}.${key}`,
        problem: "an array carries indexed data only; a named or out-of-range property is not data",
      });
    }
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const memberPath = `${path}[${String(index)}]`;
    const member = ownDataValue(container, String(index), memberPath, state);
    if (!member.present) {
      // A hole is not `undefined`: a sparse array would read its missing member
      // off `Array.prototype`, which is the adoption class this door exists for.
      state.problems.push({ path: memberPath, problem: "a sparse array hole is not data" });
      continue;
    }
    out.push(readInto(member.value, memberPath, depth + 1, state));
  }
  return out;
}

/**
 * Reads a CALLER value at a door, or answers that door's typed refusal.
 *
 * THE RULE THIS EXISTS TO MAKE MECHANICAL (round-2 review, MEDIUM-1): a door
 * that takes a caller record materializes it through {@link materializeInput}
 * FIRST, and validates and emits the materialized tree — never the caller's own
 * object. {@link ownPlainCopy} is D4, an emitter for trees this package BUILT;
 * pointing it at a caller object made it the ingress path for a getter (which it
 * would invoke) and for a cycle (which it would follow until the stack ran out).
 *
 * The refusal is `SIMULATION_INPUT_NOT_DATA`, which
 * {@link ./refusals.js#SIMULATION_REFUSAL_CODES} defines for exactly this class
 * — "a caller value could not be read as plain data (Proxy, accessor, cycle …)"
 * — so it is distinguishable from the door's own domain refusals.
 */
export function readOwnPlainInput<TValue>(
  value: unknown,
  what: string,
): SimulationResult<TValue> {
  const materialized = materializeInput(value, what);
  if (materialized.ok) return simulationOk(materialized.value as TValue);
  const first = materialized.problems[0];
  return simulationFailure(
    "SIMULATION_INPUT_NOT_DATA",
    `${what} is not plain data and is refused rather than copied: ${first?.problem ?? "it could not be read as data"}`,
    {
      at: first?.path ?? what,
      problems: materialized.problems.length,
    },
  );
}

/**
 * Thrown when {@link ownPlainCopy} is handed something that is not a finite tree
 * of own data. Internal: it is an ASSERTION about this package's own emit path.
 */
class NotOwnPlainDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotOwnPlainDataError";
  }
}

/**
 * A deep, PROTOTYPE-FREE copy of a tree THIS PACKAGE built.
 *
 * Applied to every emitted record (D4). `undefined` members are dropped, so an
 * absent optional field stays absent under any later read whatever sits on
 * `Object.prototype` — the exact adoption route ADR-020 §1 item 1 documents.
 *
 * ## Why it reads descriptors, guards cycles and bounds depth (round-2, MEDIUM-1)
 *
 * The previous version read members with `value[key]`, which INVOKES a getter —
 * the exact class {@link materializeInput} exists to prevent — and recursed with
 * no cycle check and no depth bound, so a cyclic argument raised
 * `RangeError: Maximum call stack size exceeded` out of the doors that applied
 * it to caller objects. Those doors now materialize first
 * ({@link readOwnPlainInput}), so every value reaching here is one this package
 * built. These guards are therefore ASSERTIONS on that claim rather than input
 * validation: a violation cannot produce a wrong tree, because it produces no
 * tree at all. It THROWS rather than returning a partial copy, and every public
 * seam that can reach it sits inside a totality guard
 * ({@link ./refusals.js#totally}), which turns the throw into a typed
 * `SIMULATION_INTERNAL` refusal — measured, door by door, by
 * `test/unit/simulation/doors.test.ts`.
 */
export function ownPlainCopy(value: unknown): unknown {
  return copyOwnPlain(value, 0, new WeakSet<object>());
}

function copyOwnPlain(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  const container = value as object;
  if (ancestors.has(container)) {
    throw new NotOwnPlainDataError("a cycle: an emitted value is a finite tree of data");
  }
  if (depth >= MAX_INPUT_DEPTH) {
    throw new NotOwnPlainDataError(`nested deeper than ${String(MAX_INPUT_DEPTH)} levels`);
  }
  ancestors.add(container);
  try {
    return Array.isArray(container)
      ? copyOwnPlainArray(container, depth, ancestors)
      : copyOwnPlainObject(container, depth, ancestors);
  } finally {
    ancestors.delete(container);
  }
}

function copyOwnPlainObject(
  container: object,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(container)) {
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    /* c8 ignore next -- `Object.keys` just reported the key as own and enumerable. */
    if (descriptor === undefined) continue;
    // `Object.hasOwn`, not `"value" in descriptor`: with `Object.prototype.value`
    // defined, `in` reads an accessor descriptor as a data one (WP-180 round 6).
    if (!Object.hasOwn(descriptor, "value")) {
      throw new NotOwnPlainDataError(
        `an accessor property (${key}) is code, not data: it is refused without being invoked`,
      );
    }
    const member = descriptor.value as unknown;
    if (member === undefined) continue;
    Object.defineProperty(out, key, ownDataDescriptor(copyOwnPlain(member, depth + 1, ancestors)));
  }
  return out;
}

function copyOwnPlainArray(
  container: readonly unknown[],
  depth: number,
  ancestors: WeakSet<object>,
): unknown[] {
  const out: unknown[] = [];
  for (let index = 0; index < container.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(container, String(index));
    if (descriptor === undefined) {
      // A hole would otherwise be read off `Array.prototype` by any later index
      // read, which is the adoption class ADR-020 §1 item 1 documents.
      throw new NotOwnPlainDataError("a sparse array hole is not data");
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new NotOwnPlainDataError(
        `an accessor element ([${String(index)}]) is code, not data: it is refused without being invoked`,
      );
    }
    out.push(copyOwnPlain(descriptor.value as unknown, depth + 1, ancestors));
  }
  return out;
}

/** {@link ownPlainCopy}, deep-frozen. The shape every public result is emitted in. */
export function ownFrozenTree<TValue>(value: TValue): TValue {
  return deepFreeze(ownPlainCopy(value)) as TValue;
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const member of value) deepFreeze(member);
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
