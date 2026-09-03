/**
 * Checkpointable JSON: the value grammar strategy state (and every
 * `statePatch`) must satisfy, plus the canonical serialization that makes
 * state byte-comparable (§12.4) and checkpoint hashes well-defined (§10.3
 * `state_checkpoints.state_hash` is computed by the store over these exact
 * bytes).
 *
 * Accepted: `null`, booleans, finite numbers (excluding `-0`), strings,
 * arrays, and plain objects (prototype `Object.prototype` or `null`), acyclic.
 *
 * Rejected with a stated path: `undefined`, functions, symbols, bigints,
 * `NaN`/`Infinity`, negative zero (it silently becomes `0` through a
 * JSON round trip — a value that changes identity when persisted is refused,
 * not tolerated), class instances / `Date` / `Map` / `Set` (their JSON forms
 * lose information silently), and circular structures.
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
        for (const key of Object.keys(value)) {
          const problem = walk((value as Record<string, unknown>)[key], `${path}.${key}`, seen);
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
 * Deterministic JSON serialization: object keys sorted by UTF-16 code units,
 * arrays in order, scalars via `JSON.stringify`. The caller must have
 * validated the value with `checkpointableJsonProblem` first; this function
 * assumes it and does not re-walk.
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
