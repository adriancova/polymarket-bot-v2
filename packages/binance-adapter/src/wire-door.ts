/**
 * THE WIRE DOOR: read a venue frame into plain OWN data, parse it inside a
 * containment, and take every value from the read tree.
 *
 * ## Why this module exists
 *
 * `docs/adr/ADR-020-schema-parse-boundary-integrity.md` §1: at the pinned
 * `zod@4.4.3` a successful `safeParse` guarantees neither that the output
 * matches the input nor that the declared checks ran. A key the schema
 * DECLARES is read off the prototype chain when the input lacks it, and lands
 * in the output.
 *
 * `docs/contracts/schema-boundary.md` §3 measured that on this package and
 * recorded it as the audit's sharpest row: a `trade` frame with `q` deleted is
 * refused clean (`kind=MALFORMED`, `reason=SCHEMA_MISMATCH`), and under a
 * NON-ENUMERABLE inherited `q` the same frame decodes as `kind=TRADE` with
 * `quantityRaw="999999"` and `unknownFields=[]`. It flows on: `normalizeTrade`
 * emits `size:"999999"` and `tradeIdentity` becomes
 * `64000.25|999999|1700000000000|false`, so a fabricated quantity is both
 * recorded as an economic field and used as the trade's dedup identity.
 * `z.looseObject` is not a defence — "reads named fields explicitly" is exactly
 * the mechanism by which the injected value lands, and the empty
 * `unknownFields` is what makes it silent rather than what makes it safe.
 *
 * ## What this door performs, stated per ADR-020 §4
 *
 * - **D1 — materialize prototype-free before parsing.** {@link readOwnWire}
 *   rebuilds the `JSON.parse` result with `Object.create(null)`, reading own
 *   DESCRIPTORS only. The tree handed to `zod` has no chain to read.
 * - **D2 — NOT PERFORMED, and disclosed.** A severed, warmed arena is the
 *   `packages/risk` `schema-arena.ts` mechanism. This package may not import it
 *   (`docs/contracts/dependency-direction.md` forbids an adapter → `risk` edge)
 *   and may not paste it (the repo-wide deletion guard in
 *   `test/unit/execution-planner/mirrors.test.ts`). So the library's own state
 *   reads — `skipChecks`, `optin`/`optout`, `when` — remain defeatable HERE.
 *   The door answers that by not delegating its DECISIONS to the library:
 *   every value it emits is taken by {@link ownBoundedString},
 *   {@link ownSafeInt} and {@link ownBoolean} from the materialized tree, with
 *   the same presence and bound the schema declares, so a frame missing a
 *   declared key is refused even with every `zod` check switched off. That
 *   property is measured in `./prototype-boundary.test.ts`.
 * - **D3 — take values from the materialized tree.** `frames.ts` never reads
 *   `result.data`; `zod` answers "is this shape acceptable", and the door
 *   answers "what did the frame actually carry".
 * - **D4 — emit prototype-free.** {@link ownEmit} builds every `DecodedFrame`
 *   with a null prototype, so a consumer's `?? default` on an absent field
 *   cannot be answered by `Object.prototype`. (Arrays keep `Array.prototype`;
 *   the numeric-name family is a different class, owned elsewhere.)
 * - **Refusal construction is contained** (ADR-020 amendment 2026-09-06): a
 *   warm schema still builds its issues lazily per refusal, and that path reads
 *   through the prototype chain, so `safeParse(INVALID)` can THROW while
 *   assembling them. {@link containedParse} runs the parse AND the issue
 *   rendering inside one `try`, and a throw becomes a refusal detail.
 *
 * ## Deployment reading, required whenever the §3 row is quoted
 *
 * Nothing on the wire can write `Object.prototype`. Every class above needs
 * code already executing in the process, so the row says "this check is not
 * load-bearing against an attacker already inside the process", not "a venue
 * can turn this off". It still matters because the recorder runs unattended
 * against live venue data, and the corruption lands in the dataset.
 */

import type { z } from "zod";

/**
 * Deepest nesting a frame may have. The documented frames are two levels
 * (the combined-stream wrapper around a payload); the bound exists so a
 * venue-controlled input cannot drive unbounded recursion here.
 */
export const MAX_WIRE_DEPTH = 16;

/** A record this module built: no prototype, own data properties only. */
export type OwnRecord = Readonly<Record<string, unknown>>;

/** The outcome of reading a value as plain own data. Never a throw. */
export type OwnWireRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string };

/** Internal signal: this value is not plain data and the read stops here. */
class NotPlainData extends Error {}

function dataDescriptor(value: unknown): PropertyDescriptor {
  // The descriptor itself is prototype-free: an inherited `get` makes every
  // object-literal descriptor throw (ADR-020 §1 class 8), and a door that
  // cannot define its own properties is a door that fails open by crashing.
  const descriptor: PropertyDescriptor = Object.create(null);
  descriptor.value = value;
  descriptor.enumerable = true;
  descriptor.writable = false;
  descriptor.configurable = false;
  return descriptor;
}

/** Reads one own DATA property, refusing an accessor without invoking it. */
function ownValueOf(container: object, key: string): { readonly present: boolean; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) {
    return { present: false, value: undefined };
  }
  // `Object.hasOwn`, not `in`: with an inherited `value` every accessor
  // descriptor would read as a data descriptor.
  if (!Object.hasOwn(descriptor, "value")) {
    throw new NotPlainData(
      "an accessor property: a getter is code rather than wire data, and it is refused without being invoked",
    );
  }
  return { present: true, value: descriptor.value };
}

function readMember(value: unknown, depth: number): unknown {
  if (value === null) {
    return null;
  }
  // `undefined` is not a JSON value. It reaches here only from a hand-built
  // object, and it is read as ABSENT — the same verdict `zod` gives an own
  // `undefined` on an optional key, and the one that cannot later diverge
  // from absence on a prototype-free tree.
  if (value === undefined) {
    return undefined;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value;
  }
  if (kind !== "object") {
    throw new NotPlainData(`a frame carries JSON data, not a ${kind}`);
  }
  if (depth >= MAX_WIRE_DEPTH) {
    throw new NotPlainData(`nested deeper than ${String(MAX_WIRE_DEPTH)} levels`);
  }
  const container = value as object;
  const prototype: unknown = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    if (prototype !== null && prototype !== Array.prototype) {
      throw new NotPlainData("an array with a non-plain prototype is not wire data");
    }
    return readArrayInto(container, depth);
  }
  if (prototype !== null && prototype !== Object.prototype) {
    throw new NotPlainData(
      "a non-plain prototype: an inherited property is state the frame does not own, and no copy of it can be faithful",
    );
  }
  return readObjectInto(container, depth);
}

function readObjectInto(container: object, depth: number): OwnRecord {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key === "symbol") {
      throw new NotPlainData("a symbol-keyed property is not wire data");
    }
    if (key === "__proto__") {
      // The one name a faithful copy cannot carry without changing meaning.
      throw new NotPlainData('a "__proto__" property, which no copy can carry faithfully');
    }
    const member = ownValueOf(container, key);
    if (!member.present) {
      continue;
    }
    const read = readMember(member.value, depth + 1);
    // An `undefined` member is materialized as ABSENT, so "present but
    // undefined" and "absent" cannot diverge under any later read.
    if (read !== undefined) {
      Object.defineProperty(out, key, dataDescriptor(read));
    }
  }
  return out;
}

function readArrayInto(container: object, depth: number): readonly unknown[] {
  const lengthMember = ownValueOf(container, "length");
  const length = lengthMember.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new NotPlainData("an array whose length is not a count");
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const member = ownValueOf(container, String(index));
    if (!member.present) {
      throw new NotPlainData("a sparse array: wire data has no holes");
    }
    Object.defineProperty(out, String(index), dataDescriptor(readMember(member.value, depth + 1)));
  }
  return out;
}

/**
 * D1. Reads a `JSON.parse` result into a fresh prototype-free tree of plain
 * data, or says why it is not one. TOTAL: never throws, including on a
 * `RangeError` from a pathologically deep input.
 */
export function readOwnWire(value: unknown): OwnWireRead {
  try {
    return { ok: true, value: readMember(value, 0) };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof NotPlainData
          ? error.message
          : "reading the frame as data failed unexpectedly; a frame that cannot be read is refused rather than decoded (fail closed)",
    };
  }
}

/** Whether a value is a record this door materialized. */
export function isOwnRecord(value: unknown): value is OwnRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D3, for a bounded venue string: the value the FRAME carries under `key`, or
 * `undefined` if it carries none of the right shape.
 *
 * The bounds are the ones the wire schemas declare (`VenueDecimalSchema`,
 * `VenueSymbolSchema`), restated here because a `.min()`/`.max()` is a format
 * check and every format check in the process is switchable off by one
 * inherited `skipChecks` — this read is not.
 */
export function ownBoundedString(
  record: OwnRecord,
  key: string,
  minimum: number,
  maximum: number,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    return undefined;
  }
  return value;
}

/** D3, for a documented integer field. `z.int()`'s own safe-integer bound. */
export function ownSafeInt(record: OwnRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** D3, for a documented boolean field. */
export function ownBoolean(record: OwnRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

/** The result of a contained parse: no error object escapes, only a detail. */
export type ContainedParse =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/** Anything with `zod`'s `safeParse` shape. */
interface WireSchema {
  readonly safeParse: (value: unknown) => { readonly success: true } | { readonly success: false; readonly error: z.ZodError };
}

/**
 * Runs a schema AND renders its refusal inside one containment.
 *
 * ADR-020's 2026-09-06 amendment: the warmed arena protects the parse, not
 * `zod`'s ERROR CONSTRUCTION, which is built lazily per call even on a warm
 * schema and reads through the prototype chain. A refusal that throws is a
 * clean refusal converted into an escaped exception, and `decodeFrame` is
 * documented total.
 */
export function containedParse(schema: WireSchema, value: unknown): ContainedParse {
  try {
    const result = schema.safeParse(value);
    if (result.success) {
      return { ok: true };
    }
    return { ok: false, detail: renderIssues(result.error) };
  } catch {
    return {
      ok: false,
      detail: "the schema could not judge this frame (its refusal could not be constructed); refused",
    };
  }
}

function renderIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * D4. Builds one of this package's emitted records with a null prototype.
 *
 * The cast is the door's own statement: the caller supplies exactly the fields
 * the variant declares, and nothing else can be added afterwards because every
 * property is non-writable and non-configurable.
 */
export function ownEmit<T>(fields: Readonly<Record<string, unknown>>): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    Object.defineProperty(out, key, dataDescriptor(fields[key]));
  }
  return out as T;
}
