/**
 * The canonical byte form the golden is frozen in.
 *
 * A golden comparison is only as strong as the serializer under it. `JSON.stringify`
 * is NOT enough on its own for three reasons this module closes:
 *
 * 1. **Key order.** `JSON.stringify` emits own-property insertion order, so two
 *    runs that produced the SAME values by different construction paths would
 *    differ byte for byte. Keys are sorted here, so the bytes depend on the
 *    values and on nothing else.
 * 2. **Float leakage.** §6 invariant 1 forbids an economic value in binary
 *    floating point. `1.1 + 2.2` serialises happily as `3.3000000000000003`, and
 *    a golden that accepted it would freeze the defect instead of catching it.
 *    Every `number` here must be a SAFE INTEGER (ordinals, counters, sequence
 *    numbers, millisecond instants); a non-integer, `NaN`, `Infinity` or `-0`
 *    is REFUSED BY NAME with its path.
 * 3. **Unrepresentable values.** `undefined`, functions, symbols and `bigint`
 *    each either vanish or throw inside `JSON.stringify`. A value that vanishes
 *    is a value the golden stops protecting, so each is refused by name too —
 *    except an `undefined` OWN PROPERTY, which is dropped exactly as an absent
 *    optional field should be, and is recorded as such in this module's rules.
 *
 * The output ends with a newline, uses two-space indentation and LF line
 * endings, so a committed golden is a reviewable text file and `git diff` shows
 * the field that moved.
 */

/** A value this module can serialise. */
export type Canonical =
  | string
  | number
  | boolean
  | null
  | readonly Canonical[]
  | { readonly [key: string]: Canonical | undefined };

export class CanonicalJsonError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path === "" ? "(root)" : path}: ${detail}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function checkNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(path, `${String(value)} is not a finite number`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalJsonError(
      path,
      `${String(value)} is not a safe integer. §6 invariant 1 keeps economic values in ` +
        "canonical decimal STRINGS; a number in a golden artefact may only be an ordinal, " +
        "a counter, a sequence number or a millisecond instant",
    );
  }
  if (Object.is(value, -0)) {
    throw new CanonicalJsonError(path, "negative zero has two spellings and one meaning");
  }
}

/**
 * Rewrites a value into a form `JSON.stringify` renders canonically: object
 * keys sorted, every leaf checked.
 */
function canonicalize(value: unknown, path: string): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") {
    checkNumber(value as number, path);
    return value;
  }
  if (kind === "bigint") {
    throw new CanonicalJsonError(path, "a bigint has no JSON form; render it as a string first");
  }
  if (kind === "function" || kind === "symbol" || kind === "undefined") {
    throw new CanonicalJsonError(path, `a ${kind} cannot appear in a golden artefact`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${String(index)}]`));
  }
  if (kind !== "object") {
    throw new CanonicalJsonError(path, `unsupported value of type ${kind}`);
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const own = source[key];
    // An `undefined` OWN PROPERTY is an absent optional field. It is DROPPED —
    // the same thing `JSON.stringify` does — rather than refused, so an
    // exactOptionalPropertyTypes-shaped record does not have to be pre-pruned by
    // every caller. Nothing else undefined survives: `canonicalize` refuses it
    // inside an array, where dropping would shift every later index.
    if (own === undefined) continue;
    out[key] = canonicalize(own, path === "" ? key : `${path}.${key}`);
  }
  return out;
}

/**
 * The canonical bytes of a value.
 *
 * Deterministic: the same value always produces the same string, and two values
 * that differ anywhere produce different strings.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value, ""), null, 2)}\n`;
}
