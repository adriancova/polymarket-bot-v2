/**
 * THE WIRE DOOR: read a Coinbase frame into plain OWN data, judge it inside a
 * containment, and route it by what it actually carried.
 *
 * ## Why this module exists
 *
 * `docs/adr/ADR-020-schema-parse-boundary-integrity.md` §1: at the pinned
 * `zod@4.4.3` a key the schema DECLARES is read off the prototype chain when
 * the input lacks it, and lands in the output. `z.strictObject` is not a
 * mitigation and this package does not even use one — it never protected a key
 * the schema declares (§2).
 *
 * `docs/contracts/schema-boundary.md` §3 measured it here: a missing required
 * `channel` is satisfied from the prototype (`"ticker"`), so **a frame routes
 * as a channel it never declared** — into a recorded dataset, from an
 * unattended recorder. `REC-1` re-measured it at base `5128d6c` and found the
 * same class on `sequence_num` (which gap detection is built on), on
 * `timestamp`, and one level down on a market trade's `size`.
 *
 * ## What this door performs, stated per ADR-020 §4
 *
 * - **D1 — materialize prototype-free before parsing.** {@link readOwnFrame}
 *   rebuilds the `JSON.parse` result with `Object.create(null)` from own
 *   DESCRIPTORS only, at every level, so neither the envelope nor a nested
 *   trade or ticker entry has a chain to read.
 * - **D2 — NOT PERFORMED, and disclosed.** The severed, warmed arena lives in
 *   `packages/risk`; this package may not import it (an adapter → `risk` edge
 *   is forbidden by `docs/contracts/dependency-direction.md`) and may not paste
 *   it (the deletion guard in `test/unit/execution-planner/mirrors.test.ts`).
 *   The library's own state reads therefore remain defeatable here. The door
 *   answers that where it matters by making the ROUTING decision itself:
 *   `channel`, `sequence_num` and `timestamp` are read by
 *   {@link ownNonEmptyString} and {@link ownSafeInt} from the materialized
 *   tree, so a frame that declared no channel is refused even with every `zod`
 *   check switched off. Residual, recorded: the per-channel shapes' own
 *   `.min(1)` checks are format checks and are not restated here.
 * - **D3 — take values from the materialized tree.** `classifyFrame` returns
 *   the tree it read, never `parsed.data`, so the value a consumer reads is the
 *   value the door judged.
 * - **D4 — emit prototype-free.** Every classification is built by
 *   {@link ownEmit} with a null prototype. (Arrays keep `Array.prototype`; the
 *   numeric-name family is a different class, owned elsewhere.)
 * - **Refusal construction is contained** (ADR-020 amendment 2026-09-06):
 *   `zod` builds a refusal's issues lazily per call even on a warm schema, and
 *   that path reads through the prototype chain, so `safeParse(INVALID)` can
 *   THROW. {@link containedParse} runs the parse AND
 *   `describeParseFailure` inside one `try`; `classifyFrame` is documented
 *   never to throw.
 *
 * ## Deployment reading, required whenever the §3 row is quoted
 *
 * Nothing on the wire can write `Object.prototype`; every class above needs
 * code already executing in the process. The row says the check is not
 * load-bearing against an attacker already inside the process, not that a venue
 * can turn it off. It matters because the recorder is unattended and a
 * misrouted frame corrupts a recorded dataset.
 */

import { describeParseFailure } from "./wire.js";
import type { z } from "zod";

/** Deepest nesting a frame may have: envelope → events → entries → fields. */
export const MAX_FRAME_DEPTH = 16;

/** A record this module built: no prototype, own data properties only. */
export type OwnRecord = Readonly<Record<string, unknown>>;

/** The outcome of reading a frame as plain own data. Never a throw. */
export type OwnFrameRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string };

/** Internal signal: this value is not plain data and the read stops here. */
class NotFrameData extends Error {}

function dataDescriptor(value: unknown): PropertyDescriptor {
  // Prototype-free: an inherited `get` makes every object-literal descriptor
  // throw (ADR-020 §1 class 8), and a door that cannot define its own
  // properties is a door that fails open by crashing.
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
    throw new NotFrameData("an accessor property, which is code rather than frame data");
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
    throw new NotFrameData(`a frame carries JSON data, not a ${kind}`);
  }
  if (depth >= MAX_FRAME_DEPTH) {
    throw new NotFrameData(`nested deeper than ${String(MAX_FRAME_DEPTH)} levels`);
  }
  const container = value as object;
  const prototype: unknown = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    if (prototype !== null && prototype !== Array.prototype) {
      throw new NotFrameData("an array with a non-plain prototype is not frame data");
    }
    return readArrayInto(container, depth);
  }
  if (prototype !== null && prototype !== Object.prototype) {
    throw new NotFrameData("a non-plain prototype, which no copy of the frame can carry faithfully");
  }
  return readObjectInto(container, depth);
}

function readObjectInto(container: object, depth: number): OwnRecord {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key === "symbol") {
      throw new NotFrameData("a symbol-keyed property is not frame data");
    }
    if (key === "__proto__") {
      throw new NotFrameData('a "__proto__" property, which no copy can carry faithfully');
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
    throw new NotFrameData("an array whose length is not a count");
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const member = ownValueOf(container, String(index));
    if (!member.present) {
      throw new NotFrameData("a sparse array: frame data has no holes");
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
export function readOwnFrame(value: unknown): OwnFrameRead {
  try {
    return { ok: true, value: readMember(value, 0) };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof NotFrameData
          ? error.message
          : "reading the frame as data failed unexpectedly; a frame that cannot be read is refused rather than classified (fail closed)",
    };
  }
}

/** Whether a value is a record this door materialized. */
export function isOwnRecord(value: unknown): value is OwnRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D3, for the envelope's two documented non-empty strings.
 *
 * The non-emptiness restates `z.string().min(1)`, because a `.min()` is a
 * format check and every format check in the process is switchable off by one
 * inherited `skipChecks` — this read is not.
 */
export function ownNonEmptyString(record: OwnRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** D3, for `sequence_num`. `z.int()`'s own safe-integer bound, restated. */
export function ownSafeInt(record: OwnRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** The result of a contained parse: no error object escapes, only a detail. */
export type ContainedParse =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/** Anything with `zod`'s `safeParse` shape. */
interface FrameSchema {
  readonly safeParse: (
    value: unknown,
  ) => { readonly success: true } | { readonly success: false; readonly error: z.ZodError };
}

/**
 * Runs a schema AND renders its refusal inside one containment.
 *
 * ADR-020's 2026-09-06 amendment: a warm schema still constructs its issues
 * lazily per refusal, and that construction reads through the prototype chain,
 * so a refusal can escape as an exception instead of a value.
 */
export function containedParse(schema: FrameSchema, value: unknown): ContainedParse {
  try {
    const result = schema.safeParse(value);
    if (result.success) {
      return { ok: true };
    }
    return { ok: false, detail: describeParseFailure(result.error) };
  } catch {
    return {
      ok: false,
      detail: "the schema could not judge this frame (its refusal could not be constructed)",
    };
  }
}

/** A fresh record with no prototype, for a caller assembling own data. */
export function ownRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/**
 * Defines one own DATA property, never assigning.
 *
 * `target[key] = value` is a `Set`, and `Set` consults the prototype chain: an
 * inherited setter can swallow the write and leave the key absent.
 */
export function ownDefine(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, dataDescriptor(value));
}

/**
 * D4. Builds one of this package's emitted records with a null prototype, so a
 * consumer's `?? default` on an absent field cannot be answered by
 * `Object.prototype`.
 */
export function ownEmit<T>(fields: Readonly<Record<string, unknown>>): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) {
      continue;
    }
    Object.defineProperty(out, key, dataDescriptor(fields[key]));
  }
  return out as T;
}
