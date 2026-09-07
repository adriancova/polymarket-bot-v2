/**
 * THE RTDS WIRE DOOR: read an inbound envelope into plain OWN data, judge it
 * inside a containment, and route it by what it actually declared.
 *
 * ## Why this module exists
 *
 * `docs/adr/ADR-020-schema-parse-boundary-integrity.md` §1: at the pinned
 * `zod@4.4.3` a key the schema DECLARES is read off the prototype chain when
 * the input lacks it, and lands in the output.
 *
 * `docs/contracts/schema-boundary.md` §3 measured it here: `RtdsEnvelopeSchema`
 * has a missing required `type` satisfied from the prototype (`"update"`), so
 * **a frame routes as a type it never declared** and a `ReferenceTwapObserved`
 * is published for it. Re-measured at base `5128d6c` by `REC-1`. The same row
 * records the other half, which this door must NOT regress: the TWAP payload's
 * numeric checks are not FORMAT checks and hold under `skipChecks`.
 *
 * ## What this door performs, stated per ADR-020 §4
 *
 * - **D1 — materialize prototype-free before parsing.** {@link readOwnEnvelope}
 *   rebuilds the value with `Object.create(null)` from own DESCRIPTORS only, at
 *   every level, so neither the envelope nor its payload has a chain to read.
 * - **D2 — NOT PERFORMED, and disclosed.** The severed, warmed arena lives in
 *   `packages/risk`; this package may not import it (the edge is forbidden by
 *   `docs/contracts/dependency-direction.md`) and may not paste it (the
 *   deletion guard in `test/unit/execution-planner/mirrors.test.ts`). The
 *   library's own state reads therefore remain defeatable here. The door
 *   answers that where it matters by making the ROUTING decision itself:
 *   `topic` and `type` are read from the materialized tree by
 *   {@link ownStringField}, so an envelope that declared no type is refused
 *   even with every `zod` check switched off.
 * - **D3 — take values from the materialized tree.** `normalize.ts` reads
 *   `topic`, `type`, `payload` and every payload field from the tree, never
 *   from `parsed.data`.
 * - **D4 — emit prototype-free** is already this package's shape for the
 *   values that leave it: a normalized observation is built from scalars taken
 *   from the tree, and a problem carries the materialized envelope as its
 *   `raw` evidence rather than the caller's object.
 * - **Refusal construction is contained** (ADR-020 amendment 2026-09-06): a
 *   warm schema still constructs its issues lazily per refusal and that path
 *   reads through the prototype chain, so a refusal can escape as an exception.
 *   {@link containedParse} runs the parse AND the issue rendering inside one
 *   `try`, which is what lets `normalizeRtdsFrame` keep its "nothing here
 *   throws" promise.
 *
 * ## Deployment reading, required whenever the §3 row is quoted
 *
 * Nothing on the wire can write `Object.prototype`; every class above needs
 * code already executing in the process. The row says the check is not
 * load-bearing against an attacker already inside the process, not that a venue
 * can turn it off. It matters because the recorder is unattended.
 */

import type { z } from "zod";

/** Deepest nesting an envelope may have: envelope → payload → fields. */
export const MAX_ENVELOPE_DEPTH = 16;

/** A record this module built: no prototype, own data properties only. */
export type OwnRecord = Readonly<Record<string, unknown>>;

/** The outcome of reading an envelope as plain own data. Never a throw. */
export type OwnEnvelopeRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string };

/** Internal signal: this value is not plain data and the read stops here. */
class NotEnvelopeData extends Error {}

function dataDescriptor(value: unknown): PropertyDescriptor {
  // Prototype-free: an inherited `get` makes every object-literal descriptor
  // throw (ADR-020 §1 class 8).
  const descriptor: PropertyDescriptor = Object.create(null);
  descriptor.value = value;
  descriptor.enumerable = true;
  descriptor.writable = false;
  descriptor.configurable = false;
  return descriptor;
}

/** Reads one own DATA property, refusing an accessor without invoking it. */
function ownValueOf(
  container: object,
  key: string,
): { readonly present: boolean; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) {
    return { present: false, value: undefined };
  }
  // `Object.hasOwn`, not `in`: with an inherited `value` every accessor
  // descriptor would read as a data descriptor.
  if (!Object.hasOwn(descriptor, "value")) {
    throw new NotEnvelopeData("an accessor property, which is code rather than envelope data");
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
    throw new NotEnvelopeData(`an envelope carries JSON data, not a ${kind}`);
  }
  if (depth >= MAX_ENVELOPE_DEPTH) {
    throw new NotEnvelopeData(`nested deeper than ${String(MAX_ENVELOPE_DEPTH)} levels`);
  }
  const container = value as object;
  const prototype: unknown = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    if (prototype !== null && prototype !== Array.prototype) {
      throw new NotEnvelopeData("an array with a non-plain prototype is not envelope data");
    }
    return readArrayInto(container, depth);
  }
  if (prototype !== null && prototype !== Object.prototype) {
    throw new NotEnvelopeData("a non-plain prototype, which no copy of the envelope can carry faithfully");
  }
  return readObjectInto(container, depth);
}

function readObjectInto(container: object, depth: number): OwnRecord {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key === "symbol") {
      throw new NotEnvelopeData("a symbol-keyed property is not envelope data");
    }
    if (key === "__proto__") {
      throw new NotEnvelopeData('a "__proto__" property, which no copy can carry faithfully');
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
    throw new NotEnvelopeData("an array whose length is not a count");
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const member = ownValueOf(container, String(index));
    if (!member.present) {
      throw new NotEnvelopeData("a sparse array: envelope data has no holes");
    }
    Object.defineProperty(out, String(index), dataDescriptor(readMember(member.value, depth + 1)));
  }
  return out;
}

/**
 * D1. Reads an inbound value into a fresh prototype-free tree of plain data, or
 * says why it is not one. TOTAL: never throws.
 */
export function readOwnEnvelope(value: unknown): OwnEnvelopeRead {
  try {
    return { ok: true, value: readMember(value, 0) };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof NotEnvelopeData
          ? error.message
          : "reading the envelope as data failed unexpectedly; an envelope that cannot be read is refused rather than normalized (fail closed)",
    };
  }
}

/** Whether a value is a record this door materialized. */
export function isOwnRecord(value: unknown): value is OwnRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D3, for the two fields that ROUTE an envelope.
 *
 * The type check is this module's own: a `z.string()` type check is not a
 * format check, but the door's decision must not depend on the library having
 * run at all.
 */
export function ownStringField(record: OwnRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** D3, for `window_s`. */
export function ownNumberField(record: OwnRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * D3, for the two instants: the documented shape is a number or a string, and
 * the MEANING is settled in `./values.ts`.
 */
export function ownInstantField(record: OwnRecord, key: string): number | string | undefined {
  const value = record[key];
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

/** The result of a contained parse: no error object escapes, only a detail. */
export type ContainedParse =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/** Anything with `zod`'s `safeParse` shape. */
interface EnvelopeSchema {
  readonly safeParse: (
    value: unknown,
  ) => { readonly success: true } | { readonly success: false; readonly error: z.ZodError };
}

/**
 * Runs a schema AND renders its refusal inside one containment.
 *
 * ADR-020's 2026-09-06 amendment: a warm schema still constructs its issues
 * lazily per refusal, and that construction reads through the prototype chain,
 * so a refusal can escape as an exception instead of a value. Nothing in this
 * package's message loop may throw — a throw in a message loop is how an event
 * gets dropped.
 */
export function containedParse(schema: EnvelopeSchema, value: unknown): ContainedParse {
  try {
    const result = schema.safeParse(value);
    if (result.success) {
      return { ok: true };
    }
    return { ok: false, detail: renderIssues(result.error) };
  } catch {
    return {
      ok: false,
      detail: "the schema could not judge this value (its refusal could not be constructed)",
    };
  }
}

function renderIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
