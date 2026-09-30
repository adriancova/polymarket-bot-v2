/**
 * Canonical JSON for content addressing: one value has exactly one
 * serialization.
 *
 * Grammar (deliberately restricted; anything else throws, and the engine's
 * containment turns that into a `FEATURES_INTERNAL` refusal — this serializer
 * only ever sees trees this package built):
 *
 * - strings (JSON-escaped exactly as `JSON.stringify` escapes them — the
 *   ECMA-404/ECMA-262 escaping is fully specified and deterministic);
 * - SAFE INTEGERS only. No fractional or non-finite numbers, ever: every
 *   economic value in a snapshot is a decimal STRING (§7.3), and the only
 *   numbers are counts, versions and millisecond durations. Refusing
 *   non-integers closes the classic "1e21 serializes as scientific notation"
 *   and negative-zero ambiguities wholesale (`-0` is refused, not normalized);
 * - booleans;
 * - arrays (element order is meaning and is preserved);
 * - plain records (own enumerable string keys, sorted by UTF-16 code units —
 *   the same total order `Array.prototype.sort` applies to strings);
 * - NO null, NO undefined: an absent value is an absent KEY, and the feature
 *   model expresses absence as `{status: "ABSENT", reason}` rather than as a
 *   null value.
 */

/**
 * `THROUGHPUT-1a` — PRE-SERIALIZED members. PERFORMANCE ONLY. A fragment is a
 * value this package serialized with this very function earlier; meeting it,
 * the serializer emits those bytes where it would have walked the value again
 * — the same bytes. Only this module mints them (`canonicalFragment`), and
 * membership is by identity in a package-owned `WeakSet`, so no caller value
 * can pass for one.
 */
const FRAGMENTS = new WeakSet<object>();
const FRAGMENT_JSON = new WeakMap<object, string>();

/** A member whose canonical JSON is `json` — which the caller produced with {@link serializeCanonicalJson}. */
export function canonicalFragment(json: string): object {
  const fragment = Object.freeze(Object.create(null) as object);
  FRAGMENTS.add(fragment);
  FRAGMENT_JSON.set(fragment, json);
  return fragment;
}

export function serializeCanonicalJson(value: unknown): string {
  const parts: string[] = [];
  writeValue(value, parts, 0);
  return parts.join("");
}

const MAX_DEPTH = 64;

function writeValue(value: unknown, parts: string[], depth: number): void {
  if (depth >= MAX_DEPTH) {
    throw new Error("canonical JSON: value nested deeper than the serializer bound");
  }
  switch (typeof value) {
    case "string":
      parts.push(JSON.stringify(value));
      return;
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new Error(`canonical JSON: a number must be a safe integer (got ${String(value)})`);
      }
      parts.push(String(value));
      return;
    case "boolean":
      parts.push(value ? "true" : "false");
      return;
    case "object":
      break;
    default:
      throw new Error(`canonical JSON: a ${typeof value} is not serializable`);
  }
  if (value === null) {
    throw new Error("canonical JSON: null is not part of the snapshot grammar");
  }
  if (FRAGMENTS.has(value)) {
    parts.push(FRAGMENT_JSON.get(value) ?? "");
    return;
  }
  if (Array.isArray(value)) {
    parts.push("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) parts.push(",");
      writeValue(value[index], parts, depth + 1);
    }
    parts.push("]");
    return;
  }
  const keys = Object.keys(value).sort();
  parts.push("{");
  let first = true;
  for (const key of keys) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined) continue;
    if (!first) parts.push(",");
    first = false;
    parts.push(JSON.stringify(key), ":");
    writeValue(member, parts, depth + 1);
  }
  parts.push("}");
}
