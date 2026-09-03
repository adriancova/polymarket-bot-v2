/**
 * Checkpointable JSON: the value grammar strategy state (and every
 * `statePatch`) must satisfy, plus the canonical serialization that makes
 * state byte-comparable (§12.4) and checkpoint hashes well-defined (§10.3
 * `state_checkpoints.state_hash` is computed by the store over these exact
 * bytes).
 *
 * The grammar below is the CURRENT, verified behavior. It is stated as three
 * separate axes because a JavaScript value can be un-checkpointable because of
 * what it IS, because of how its properties are DEFINED, or because reading it
 * at all RUNS CODE that the runtime does not control.
 *
 * Accepted values: `null`, booleans, finite numbers (excluding `-0`), strings,
 * arrays, and plain objects (prototype `Object.prototype` or `null`), acyclic.
 *
 * Rejected values, with a stated path: `undefined`, functions, symbol VALUES,
 * bigints, `NaN`/`Infinity`, negative zero (it silently becomes `0` through a
 * JSON round trip — a value that changes identity when persisted is refused,
 * not tolerated), class instances / `Date` / `Map` / `Set` (their JSON forms
 * lose information silently), and circular structures.
 *
 * Rejected own-property FORMS, with a stated path — every one of these is a
 * property that canonical serialization would drop or transform silently:
 * - **symbol KEYS** (`{ [Symbol("k")]: 1 }`): invisible to `Object.keys`, so
 *   they never reach the output bytes;
 * - **non-enumerable properties** (`Object.defineProperty(o, "k", { value })`):
 *   likewise invisible to `Object.keys` and to `JSON.stringify`;
 * - **accessor (getter/setter) properties**: `JSON.stringify` calls the
 *   getter, so the bytes record a COMPUTED value that returns as a plain data
 *   property — and a getter reading mutable state can serialize differently on
 *   two passes over the same object, which is exactly the §12.4 divergence
 *   these functions exist to prevent;
 * - **non-index own properties on an array** (`Object.assign([1], { x: 2 })`,
 *   or a symbol key on an array): JSON serializes arrays positionally, so such
 *   properties are dropped.
 * An array HOLE is rejected too, by the value axis: reading the missing index
 * yields `undefined`, which is already refused (and it must be — the canonical
 * serializer would emit the invalid text `[1,,3]` for `[1, , 3]`).
 *
 * The third axis — how the value is OBTAINED. A Proxy (or any other exotic
 * object) can satisfy every check on the two axes above and still run arbitrary
 * strategy code on each property access, returning different answers to the
 * validator and to the serializer. No inspection can decide that: whatever a
 * trap answered, it may answer differently next time. So the boundary does not
 * try to DETECT an exotic value — it MATERIALIZES. `materializeCheckpointableJson`
 * reads every own property exactly ONCE and builds a fresh, plain, inert copy
 * as it validates; the copy is what the runtime keeps, freezes, serializes,
 * checkpoints and persists, and the caller's original is never read again. A
 * trap that throws during that read is not a crash but a stated refusal, and a
 * trap that lies can only lie into a copy that has already been validated as
 * data. `checkpointableJsonProblem` is that same walk with the copy discarded,
 * which is what keeps the validator and the materializer from ever drifting.
 *
 * DATED CORRECTION — 2026-09-02, remediation round 1 (review finding M1). The
 * previous version of this header said "Rejected … symbols", which was true
 * only of symbol *values*. Symbol *keys* were NOT rejected: both the validator
 * and the serializer enumerated with `Object.keys`, which cannot see them, so
 * `{ visible: 1, [Symbol("lost")]: 2 }` validated as `problem: null` and
 * serialized to `{"visible":1}` — silent state loss for any direct caller of
 * the exported utility, and (reproduced end to end) a nested symbol key rode
 * an accepted `statePatch` into live in-memory instance state while the
 * checkpoint bytes dropped it, so the restored instance and the live one
 * disagreed. Non-enumerable and accessor properties had the same hole. All of
 * these forms are refused as of this correction, and the grammar above now
 * describes the behavior the tests pin
 * (`test/unit/strategy-runtime/json-own-properties.test.ts`).
 *
 * DATED CORRECTION — 2026-09-02, remediation round 2 (review round 2's HIGH
 * finding). The round-1 correction above is left exactly as it was written, but
 * its framing — "the grammar below is the CURRENT, verified behavior", stated
 * over two axes — was INCOMPLETE, and the gap was not a missing property form
 * but a missing question. Round 1 inspected own-property DESCRIPTORS, which is
 * the right check for an ordinary object and no check at all for an exotic one:
 * a `Proxy` presenting `Object.prototype` and plain enumerable data descriptors
 * passed the whole grammar. Reproduced verbatim before the fix, with a proxy
 * whose `get` trap throws once something has frozen it:
 *
 *     validator=null
 *     first=Error:POST_FREEZE_PROXY_GET
 *     second=DECIDED
 *     sequences=[0,0]
 *     checkpoints=[0]
 *     status=ACTIVE
 *
 * `checkpointableJsonProblem({ nested: proxy })` returned `null`; the runtime
 * accepted the patch, persisted the decision, and only then threw out of
 * `evaluate()` while freezing the state — leaving a durable decision with no
 * checkpoint and an evaluation sequence that the next callback re-used. Two
 * neighbouring routes were swept in the same probe and were equally live: a
 * proxy whose trap throws EAGERLY made this very function throw instead of
 * returning a problem (`validator/eager=Error:EAGER_PROXY_GET`), and a hostile
 * returned decision made `DecisionResultSchema.safeParse` throw. As of this
 * correction the walk materializes (third axis above), every caller-supplied
 * property access is wrapped, and these functions are TOTAL: they return a
 * problem string, never a throw. Pinned by
 * `test/unit/strategy-runtime/json-exotic-values.test.ts` and the runtime-side
 * ordering tests in `test/unit/strategy-runtime/decision-commit-ordering.test.ts`.
 *
 * Note on numbers: a checkpoint value may be a non-economic number (a counter,
 * a flag). ECONOMIC values inside strategy state must be canonical decimal
 * strings by §6 invariant 1 — that is a strategy-discipline rule reviewed with
 * the strategy (the domain deliberately types `statePatch` as opaque).
 */

const PLAIN_OBJECT_PROTOTYPES = new Set<object | null>([Object.prototype, null]);

/** The inert data a materialized value is made of. */
export type CheckpointableJson =
  | null
  | boolean
  | number
  | string
  | readonly CheckpointableJson[]
  | { readonly [key: string]: CheckpointableJson };

export type MaterializeCheckpointableJsonResult =
  | { readonly ok: true; readonly value: CheckpointableJson }
  | { readonly ok: false; readonly problem: string };

/**
 * Validates a caller-supplied value against the grammar above AND returns a
 * fresh, plain, inert copy of it — one single walk, so the thing validated and
 * the thing kept are the same thing.
 *
 * This is the checkpointable-state BOUNDARY. A caller that keeps the original
 * instead of the returned copy has not crossed it: the original may be a Proxy
 * whose traps answer one way during validation and another way afterwards, and
 * no amount of inspection can rule that out. Every own key, descriptor and
 * value here is read exactly ONCE and inside a guard, so a hostile or merely
 * broken value yields a stated problem rather than a throw. **Never throws.**
 */
export function materializeCheckpointableJson(
  value: unknown,
  path = "$",
): MaterializeCheckpointableJsonResult {
  return materialize(value, path, new Set());
}

/**
 * Returns a human-readable problem description for the first offending value,
 * or `null` when the value is checkpointable. Never throws.
 *
 * Implemented as `materializeCheckpointableJson` with the copy discarded, so
 * the validator and the materializer cannot drift apart — a value this function
 * accepts is exactly a value the boundary can materialize. The discarded copy
 * is the price of that identity; the runtime's hot path calls the materializer
 * directly and keeps the copy, so it pays nothing extra.
 *
 * WHAT A `null` ANSWER MEANS, exactly: the values this walk READ are
 * checkpointable. For ordinary data that is a property of the value and holds
 * forever. For an exotic value it is a property of one reading, because a Proxy
 * may answer differently next time — and nothing can decide that in advance.
 * **A caller that intends to KEEP, freeze, serialize or persist the value must
 * therefore call `materializeCheckpointableJson` and keep the returned copy**,
 * which is what the runtime does; validating and then keeping the original is
 * the shape of the defect this pair of functions was rewritten to remove.
 */
export function checkpointableJsonProblem(value: unknown, path = "$"): string | null {
  const result = materializeCheckpointableJson(value, path);
  return result.ok ? null : result.problem;
}

function fail(problem: string): { readonly ok: false; readonly problem: string } {
  return { ok: false, problem };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Performs ONE property-access operation on a caller-supplied object. Every
 * such operation can run code the runtime does not control (a Proxy trap, an
 * exotic host object), so every one of them is wrapped: the boundary refuses,
 * it does not propagate.
 */
function attempt<T>(
  path: string,
  operation: string,
  read: () => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string } {
  try {
    return { ok: true, value: read() };
  } catch (cause) {
    return fail(
      `${path}: ${operation} threw (${describeCause(cause)}) — a value whose property ` +
        "access executes code (a Proxy or other exotic object) is not checkpointable",
    );
  }
}

function materialize(
  value: unknown,
  path: string,
  seen: Set<object>,
): MaterializeCheckpointableJsonResult {
  switch (typeof value) {
    case "boolean":
    case "string":
      return { ok: true, value };
    case "number":
      if (!Number.isFinite(value)) {
        return fail(`${path}: non-finite number ${String(value)}`);
      }
      if (Object.is(value, -0)) {
        return fail(`${path}: negative zero does not survive a JSON round trip`);
      }
      return { ok: true, value };
    case "undefined":
      return fail(`${path}: undefined is not representable in JSON`);
    case "bigint":
      return fail(`${path}: bigint is not representable in JSON`);
    case "function":
      return fail(`${path}: functions are not representable in JSON`);
    case "symbol":
      return fail(`${path}: symbols are not representable in JSON`);
    case "object": {
      if (value === null) {
        return { ok: true, value: null };
      }
      if (seen.has(value)) {
        return fail(`${path}: circular structure`);
      }
      seen.add(value);
      try {
        // `Array.isArray` pierces a Proxy to its target and cannot be trapped,
        // so it is safe to branch on before any trap has run.
        if (Array.isArray(value)) {
          return materializeArray(value as readonly unknown[], path, seen);
        }
        const prototype = attempt(path, "reading the prototype", () => Object.getPrototypeOf(value));
        if (!prototype.ok) {
          return prototype;
        }
        if (!PLAIN_OBJECT_PROTOTYPES.has(prototype.value as object | null)) {
          return fail(`${path}: only plain objects are checkpointable`);
        }
        return materializeObject(value, path, seen);
      } finally {
        seen.delete(value);
      }
    }
    default:
      return fail(`${path}: unsupported value`);
  }
}

function materializeObject(
  source: object,
  path: string,
  seen: Set<object>,
): MaterializeCheckpointableJsonResult {
  // `Reflect.ownKeys`, NOT `Object.keys`: the point of this walk is to see
  // every own property canonical serialization would silently drop or
  // transform. `Object.keys` cannot see symbol keys or non-enumerable
  // properties, which is precisely how they used to slip through.
  const keys = attempt(path, "enumerating own keys", () => Reflect.ownKeys(source));
  if (!keys.ok) {
    return keys;
  }
  const copy: Record<PropertyKey, CheckpointableJson> = {};
  for (const key of keys.value) {
    const formProblem = ownPropertyFormProblem(source, key, path);
    if (formProblem !== null) {
      return fail(formProblem);
    }
    const childPath = `${path}.${String(key)}`;
    const read = attempt(
      childPath,
      "reading the property value",
      () => (source as Record<PropertyKey, unknown>)[key],
    );
    if (!read.ok) {
      return read;
    }
    const child = materialize(read.value, childPath, seen);
    if (!child.ok) {
      return child;
    }
    // `defineProperty`, not assignment: an own `__proto__` data property (which
    // `JSON.parse` can produce and JSON serialization does emit) would trigger
    // the inherited setter under `copy[key] = …` and silently move the property
    // into the prototype instead of the copy.
    Object.defineProperty(copy, key, {
      value: child.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return { ok: true, value: copy as { readonly [key: string]: CheckpointableJson } };
}

function materializeArray(
  source: readonly unknown[],
  path: string,
  seen: Set<object>,
): MaterializeCheckpointableJsonResult {
  const length = attempt(path, "reading length", () => source.length);
  if (!length.ok) {
    return length;
  }
  const shapeProblem = arrayOwnPropertyProblem(source, path, length.value);
  if (shapeProblem !== null) {
    return fail(shapeProblem);
  }
  const copy: CheckpointableJson[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const childPath = `${path}[${index}]`;
    const read = attempt(childPath, "reading the element", () => source[index]);
    if (!read.ok) {
      return read;
    }
    const child = materialize(read.value, childPath, seen);
    if (!child.ok) {
      return child;
    }
    copy.push(child.value);
  }
  return { ok: true, value: copy };
}

/**
 * Refuses the own-property FORMS canonical serialization cannot round-trip.
 * Checked BEFORE the property's value is read, so a getter is never invoked by
 * validation — validating strategy state must not execute strategy code. The
 * descriptor read itself is guarded for the same reason (a Proxy's
 * `getOwnPropertyDescriptor` trap is code too).
 */
function ownPropertyFormProblem(owner: object, key: PropertyKey, path: string): string | null {
  if (typeof key === "symbol") {
    return (
      `${path}: symbol-keyed property ${key.toString()} is invisible to JSON serialization ` +
      "and would be dropped silently"
    );
  }
  const read = attempt(`${path}.${String(key)}`, "reading the property descriptor", () =>
    Object.getOwnPropertyDescriptor(owner, key),
  );
  if (!read.ok) {
    return read.problem;
  }
  const descriptor = read.value;
  if (descriptor === undefined) {
    // Unreachable for a plain object; refused rather than assumed away.
    return `${path}.${String(key)}: own property has no descriptor`;
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return (
      `${path}.${String(key)}: accessor properties are not checkpointable — serialization ` +
      "would persist a computed value that returns as a plain data property"
    );
  }
  if (!descriptor.enumerable) {
    return (
      `${path}.${String(key)}: non-enumerable property is invisible to JSON serialization ` +
      "and would be dropped silently"
    );
  }
  return null;
}

/**
 * Arrays serialize positionally, so any own property that is not an in-range
 * index (`length` excepted — it is the intrinsic, never a serialized key) is
 * dropped. Index properties themselves must still be plain enumerable data
 * properties. `length` is read once by the caller and passed in, so a lying
 * `length` cannot report one bound to this check and another to the copy.
 */
function arrayOwnPropertyProblem(
  value: readonly unknown[],
  path: string,
  length: number,
): string | null {
  const keys = attempt(path, "enumerating own keys", () => Reflect.ownKeys(value));
  if (!keys.ok) {
    return keys.problem;
  }
  for (const key of keys.value) {
    if (key === "length") {
      continue;
    }
    if (typeof key === "symbol") {
      return (
        `${path}: symbol-keyed property ${key.toString()} on an array is invisible to JSON ` +
        "serialization and would be dropped silently"
      );
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return (
        `${path}: non-index own property ${String(key)} on an array is dropped by JSON ` +
        "serialization (arrays are serialized positionally)"
      );
    }
    const formProblem = ownPropertyFormProblem(value, key, path);
    if (formProblem !== null) {
      return formProblem;
    }
  }
  return null;
}

/**
 * Deterministic JSON serialization: object keys sorted by UTF-16 code units,
 * arrays in order, scalars via `JSON.stringify`. The caller must have
 * validated the value with `checkpointableJsonProblem` first; this function
 * assumes it and does not re-walk.
 *
 * `Object.keys` is sufficient here BECAUSE of that precondition: validation
 * refuses every own-property form `Object.keys` cannot see (symbol keys,
 * non-enumerable properties) and every form whose value is computed rather
 * than stored (accessors), so on a validated value the two enumerations agree.
 * On an UNVALIDATED value they do not — that is the M1 defect, and the reason
 * this precondition is load-bearing rather than decorative.
 *
 * Since remediation round 2 the runtime never hands this function anything but
 * a MATERIALIZED copy (see `materializeCheckpointableJson`), so on the runtime's
 * own path the precondition is satisfied by construction and not merely by
 * discipline: the value being serialized is inert data the runtime built.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (key) =>
      `${JSON.stringify(key)}:${canonicalJsonStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * Recursively freezes a value in place and returns it. Cycle-safe. The caller
 * hands ownership of the object graph to the runtime by passing it here — this
 * is the documented contract of `EvaluationInput` views.
 */
export function deepFreeze<T>(value: T): T {
  freezeWalk(value, new Set());
  return value;
}

function freezeWalk(value: unknown, seen: Set<object>): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }
  const asObject = value as object;
  if (seen.has(asObject)) {
    return;
  }
  seen.add(asObject);
  Object.freeze(asObject);
  for (const key of Reflect.ownKeys(asObject)) {
    freezeWalk((asObject as Record<PropertyKey, unknown>)[key], seen);
  }
}
