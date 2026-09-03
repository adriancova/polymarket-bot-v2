/**
 * Checkpointable JSON: the value grammar strategy state (and every
 * `statePatch`) must satisfy, plus the canonical serialization that makes
 * state byte-comparable (§12.4) and checkpoint hashes well-defined (§10.3
 * `state_checkpoints.state_hash` is computed by the store over these exact
 * bytes).
 *
 * The grammar below is the CURRENT, verified behavior. It is stated as two
 * separate axes because a JavaScript value can be un-checkpointable either
 * because of what it IS or because of how its properties are DEFINED.
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
 * Note on numbers: a checkpoint value may be a non-economic number (a counter,
 * a flag). ECONOMIC values inside strategy state must be canonical decimal
 * strings by §6 invariant 1 — that is a strategy-discipline rule reviewed with
 * the strategy (the domain deliberately types `statePatch` as opaque).
 */

const PLAIN_OBJECT_PROTOTYPES = new Set<object | null>([Object.prototype, null]);

/**
 * Returns a human-readable problem description for the first offending value,
 * or `null` when the value is checkpointable.
 */
export function checkpointableJsonProblem(value: unknown, path = "$"): string | null {
  return walk(value, path, new Set());
}

function walk(value: unknown, path: string, seen: Set<object>): string | null {
  switch (typeof value) {
    case "boolean":
    case "string":
      return null;
    case "number":
      if (!Number.isFinite(value)) {
        return `${path}: non-finite number ${String(value)}`;
      }
      if (Object.is(value, -0)) {
        return `${path}: negative zero does not survive a JSON round trip`;
      }
      return null;
    case "undefined":
      return `${path}: undefined is not representable in JSON`;
    case "bigint":
      return `${path}: bigint is not representable in JSON`;
    case "function":
      return `${path}: functions are not representable in JSON`;
    case "symbol":
      return `${path}: symbols are not representable in JSON`;
    case "object": {
      if (value === null) {
        return null;
      }
      if (seen.has(value)) {
        return `${path}: circular structure`;
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const shapeProblem = arrayOwnPropertyProblem(value, path);
          if (shapeProblem !== null) {
            return shapeProblem;
          }
          for (let index = 0; index < value.length; index += 1) {
            const problem = walk(value[index], `${path}[${index}]`, seen);
            if (problem !== null) {
              return problem;
            }
          }
          return null;
        }
        if (!PLAIN_OBJECT_PROTOTYPES.has(Object.getPrototypeOf(value) as object | null)) {
          return `${path}: only plain objects are checkpointable`;
        }
        // `Reflect.ownKeys`, NOT `Object.keys`: the point of this walk is to
        // see every own property canonical serialization would silently drop
        // or transform. `Object.keys` cannot see symbol keys or non-enumerable
        // properties, which is precisely how they used to slip through.
        for (const key of Reflect.ownKeys(value)) {
          const formProblem = ownPropertyFormProblem(value, key, path);
          if (formProblem !== null) {
            return formProblem;
          }
          const problem = walk(
            (value as Record<string, unknown>)[key as string],
            `${path}.${String(key)}`,
            seen,
          );
          if (problem !== null) {
            return problem;
          }
        }
        return null;
      } finally {
        seen.delete(value);
      }
    }
    default:
      return `${path}: unsupported value`;
  }
}

/**
 * Refuses the own-property FORMS canonical serialization cannot round-trip.
 * Checked BEFORE the property's value is read, so a getter is never invoked by
 * validation — validating strategy state must not execute strategy code.
 */
function ownPropertyFormProblem(owner: object, key: PropertyKey, path: string): string | null {
  if (typeof key === "symbol") {
    return (
      `${path}: symbol-keyed property ${key.toString()} is invisible to JSON serialization ` +
      "and would be dropped silently"
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
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
 * properties.
 */
function arrayOwnPropertyProblem(value: readonly unknown[], path: string): string | null {
  for (const key of Reflect.ownKeys(value)) {
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
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
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
