/**
 * THE SPEC DOOR: read a candidate settlement spec into plain OWN data, judge it
 * inside a containment, and take every value from the read tree.
 *
 * ## Why this module exists
 *
 * `docs/adr/ADR-020-schema-parse-boundary-integrity.md` §1: at the pinned
 * `zod@4.4.3` a successful `safeParse` guarantees neither that the output
 * matches the input nor that the declared checks ran. A key the schema
 * DECLARES is read off the prototype chain when the input lacks it, and lands
 * in the output.
 *
 * `docs/contracts/schema-boundary.md` §3 measured that on this package (probe
 * N) and ranked it HIGH, because settlement-spec integrity decides payouts.
 * Of the sixteen own keys of `terminalSpotSpecSample()`, FOURTEEN are required
 * — deleting any one is refused clean — and ALL FOURTEEN are supplied from
 * `Object.prototype` when the input lacks them. Two of those cells say what the
 * class costs:
 *
 * - an adopted `resolutionSource` is a spec that settles against a source its
 *   own text never named;
 * - an adopted `verification` is sharper still: a spec carrying NO verification
 *   key at all parses as a reviewed one, {@link isReviewedSettlementSpec}
 *   returns `true`, the adopted `VERIFIED` clears BOTH model-dependent
 *   activation gates, and `evaluateSettlement` stamps `reviewed: true` on the
 *   settlement it computes. §6 invariant 9 (a change is a new version, never an
 *   edit) and ADR-009 §5.4's stated-policy rule both rest on this door, and the
 *   review gate is itself adoptable.
 *
 * `z.strictObject` is not the defence and never was (ADR-020 §2). It refuses an
 * ENUMERABLE inherited key — at base, by the accident of the nested
 * `verification` object reporting it as unrecognized — and it does not see a
 * NON-ENUMERABLE one at all. It never protected a key the schema itself
 * declares, which is every key in the sweep above.
 *
 * ## What this door performs, stated per ADR-020 §4
 *
 * - **D1 — materialize prototype-free before parsing.** {@link readOwnSpec}
 *   rebuilds the candidate with `Object.create(null)`, reading own DESCRIPTORS
 *   only, so the tree handed to `zod` has no chain to read. An accessor, a
 *   symbol key, a `__proto__` key, a foreign prototype and an over-deep tree
 *   are refused rather than copied.
 * - **D2 — NOT PERFORMED, and disclosed.** A severed, warmed arena is the
 *   `packages/risk` `schema-arena.ts` mechanism. This package may not import it
 *   (`docs/contracts/dependency-direction.md` permits no settlement → risk
 *   edge) and may not paste it (the repository-wide deletion guard in
 *   `test/unit/execution-planner/mirrors.test.ts`). So the library's own state
 *   reads — `skipChecks`, `optin`/`optout`, `when` — remain defeatable HERE.
 *   The compensation is the REC-1 adapter-door precedent: the door does not
 *   delegate its DECISIONS to the library. `spec.ts`'s `ownSpecIssues` restates,
 *   on the door's own reads of the materialized tree, every presence, type,
 *   bound, vocabulary and stated-policy rule the schema declares, so the
 *   measured rows stay closed with every `zod` check switched off. That property
 *   is measured in `./prototype-boundary.test.ts` under an inherited
 *   `skipChecks`.
 * - **D3 — take values from the materialized tree.** The emitted
 *   `SettlementSpec` is projected from the tree the door built, never from
 *   `result.data`: `zod` answers "is this shape acceptable", and the door
 *   answers "what did the caller actually hand over".
 * - **D4 — emit prototype-free.** {@link ownEmit} builds the spec, its
 *   `verification` block and the activation verdict with a null prototype, so a
 *   consumer's `?? default` or `spec.verification` on an absent field cannot be
 *   answered by `Object.prototype`. (Arrays keep `Array.prototype`; the
 *   numeric-name family is a different class, owned elsewhere.)
 * - **Refusal construction is contained** (ADR-020 amendment 2026-09-06). A
 *   warm schema still builds its issues lazily per refusal and that path reads
 *   through the prototype chain: measured at this package's base, an inherited
 *   `_zod`, `path` or `value` makes `safeParseSettlementSpec` — documented
 *   non-throwing — THROW a `TypeError`, and takes `classifySettlementActivation`
 *   with it. {@link containedSpecParse} runs the parse, the whole `superRefine`
 *   the schema attaches, AND the issue rendering inside one `try`, and a throw
 *   becomes a typed refusal.
 *
 * ## Deployment reading, required whenever the §3 row is quoted
 *
 * Nothing on the wire can write `Object.prototype`. Every class above needs
 * code already executing in the process, so the row says "this check is not
 * load-bearing against an attacker already inside the process", not "a caller
 * can turn it off". It still matters because this door is the only enforcement
 * of a review gate whose failure mode is a payout.
 */

import type { z } from "zod";

/**
 * Deepest nesting a candidate spec may have.
 *
 * The §9.3 spec is two levels (the spec and its `verification` block). The
 * bound exists so a caller-supplied value cannot drive unbounded recursion in
 * the materializer, and it also terminates a cyclic input. Nothing the schema
 * accepts is anywhere near it: a deeper tree carries keys the strict schema
 * refuses as unrecognized, so the cap can never turn an accepted spec into a
 * refused one.
 */
export const MAX_SPEC_DEPTH = 8;

/** A record this module built: no prototype, own data properties only. */
export type OwnRecord = Readonly<Record<string, unknown>>;

/** The outcome of reading a value as plain own data. Never a throw. */
export type OwnSpecRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string };

/** Internal signal: this value is not plain data and the read stops here. */
class NotSpecData extends Error {}

/**
 * A prototype-free property descriptor.
 *
 * The descriptor object itself must have no chain: an inherited `get` makes
 * every `Object.defineProperty` written with an object-literal descriptor throw
 * `TypeError` (ADR-020 §1 class 8), and a door that cannot define its own
 * properties is a door that fails open by crashing.
 */
function ownDataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor: PropertyDescriptor = Object.create(null);
  descriptor.value = value;
  descriptor.enumerable = true;
  descriptor.writable = false;
  descriptor.configurable = false;
  return descriptor;
}

/**
 * Reads one OWN data property, refusing an accessor without invoking it.
 *
 * `Object.hasOwn(descriptor, "value")`, never `"value" in descriptor`: with an
 * inherited `value` every accessor descriptor would read as a data descriptor.
 */
function ownMember(container: object, key: string): { readonly present: boolean; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) {
    return { present: false, value: undefined };
  }
  if (!Object.hasOwn(descriptor, "value")) {
    throw new NotSpecData(
      "an accessor property: a settlement spec is a reviewed document, and a getter is code that can answer differently on a second read",
    );
  }
  return { present: true, value: descriptor.value };
}

function readSpecMember(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    // `undefined` is read as ABSENT below, so "present but undefined" and
    // "absent" cannot diverge under any later read of the copy.
    return value;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value;
  }
  if (kind !== "object") {
    throw new NotSpecData(`a settlement spec carries documented data, not a ${kind}`);
  }
  if (depth >= MAX_SPEC_DEPTH) {
    throw new NotSpecData(`nested deeper than ${String(MAX_SPEC_DEPTH)} levels`);
  }
  const container = value as object;
  const prototype: unknown = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    if (prototype !== null && prototype !== Array.prototype) {
      throw new NotSpecData("an array whose prototype is not the ordinary one");
    }
    return readSpecArray(container, depth);
  }
  if (prototype !== null && prototype !== Object.prototype) {
    throw new NotSpecData(
      "an object whose prototype is not the ordinary one: an inherited field is state the document does not own, and no copy of it can be faithful",
    );
  }
  return readSpecObject(container, depth);
}

function readSpecObject(container: object, depth: number): OwnRecord {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key === "symbol") {
      throw new NotSpecData("a symbol-keyed field, which no persisted spec column can carry");
    }
    if (key === "__proto__") {
      // The one field name a faithful copy cannot carry without changing what
      // the copy MEANS.
      throw new NotSpecData('a "__proto__" field, which no copy can carry faithfully');
    }
    const member = ownMember(container, key);
    if (!member.present) {
      continue;
    }
    const read = readSpecMember(member.value, depth + 1);
    if (read !== undefined) {
      Object.defineProperty(out, key, ownDataDescriptor(read));
    }
  }
  return out;
}

function readSpecArray(container: object, depth: number): readonly unknown[] {
  const lengthMember = ownMember(container, "length");
  const length = lengthMember.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new NotSpecData("an array whose length is not a count");
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const member = ownMember(container, String(index));
    if (!member.present) {
      throw new NotSpecData("an array with holes in it");
    }
    Object.defineProperty(
      out,
      String(index),
      ownDataDescriptor(readSpecMember(member.value, depth + 1)),
    );
  }
  return out;
}

/**
 * D1. Reads a candidate settlement spec into a fresh prototype-free tree of
 * plain data, or says why it is not one. TOTAL: never throws, including on a
 * `RangeError` from a pathologically deep input.
 *
 * A NON-OBJECT candidate is passed through unchanged rather than refused here,
 * so the schema keeps composing the refusal it always composed for a number, a
 * string or a boolean handed to a spec parser.
 */
export function readOwnSpec(value: unknown): OwnSpecRead {
  try {
    return { ok: true, value: readSpecMember(value, 0) };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof NotSpecData
          ? error.message
          : "reading it as spec data failed unexpectedly; a document that cannot be read is refused rather than parsed (fail closed)",
    };
  }
}

/** Whether a value is a record shape this door can read fields from. */
export function isOwnRecord(value: unknown): value is OwnRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D3, the general form: the value an OWN property of `container` carries, or
 * `undefined` when the container has no such own property.
 *
 * This is the read every gate in this package uses instead of `spec.field`.
 * Dot access asks the prototype chain the moment the own property is absent,
 * which is exactly how the measured `verification` cell reaches
 * `REVIEWED_MODEL_BACKED`; this asks the object only about itself. An accessor
 * is refused rather than invoked, so a getter cannot answer a gate either.
 */
export function ownField(container: unknown, key: string): unknown {
  if (typeof container !== "object" || container === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return undefined;
  }
  return descriptor.value;
}

/** Whether `container` carries `key` as an own DATA property of its own. */
export function hasOwnField(container: unknown, key: string): boolean {
  if (typeof container !== "object" || container === null) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

/** The result of a contained parse: no error object escapes, only rendered issues. */
export type ContainedSpecParse =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Anything with `zod`'s `safeParse` shape. */
interface SpecSchemaLike {
  readonly safeParse: (
    value: unknown,
  ) => { readonly success: true } | { readonly success: false; readonly error: z.ZodError };
}

/**
 * Runs a schema AND renders its refusal inside one containment.
 *
 * ADR-020's 2026-09-06 amendment: the warmed arena protects the parse, not
 * `zod`'s ERROR CONSTRUCTION, which is built lazily per call even on a warm
 * schema and reads through the prototype chain. Measured at this package's
 * base: an inherited `_zod` throws `TypeError: Cannot read properties of
 * undefined (reading 'has')`, an inherited `path` throws `iss.path is not
 * iterable`, and an inherited `value` throws `Invalid property descriptor`
 * — each escaping `safeParseSettlementSpec`, which is documented not to throw,
 * and each taking `classifySettlementActivation` with it. The `superRefine`
 * this schema attaches composes its own issues in the same call, so it is
 * inside the same containment.
 *
 * The rendered detail may VARY under pollution — ADR-020 §6 permits refusal
 * COMPOSITION to vary. What may not vary is that a verdict comes back at all.
 */
export function containedSpecParse(schema: SpecSchemaLike, value: unknown): ContainedSpecParse {
  try {
    const result = schema.safeParse(value);
    if (result.success) {
      return { ok: true };
    }
    return { ok: false, issues: renderSpecIssues(result.error) };
  } catch {
    return {
      ok: false,
      issues: [
        "(root): the schema could not judge this document (its refusal could not be constructed); refused",
      ],
    };
  }
}

/**
 * Formats `zod` issues the way this package always has: `path: message`, with
 * a rootless issue reported as `(root)`.
 *
 * Contained by its caller, and defensive on its own account: `issue.path` is
 * read through the library's error object, which is the value the amendment
 * above is about.
 */
function renderSpecIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

/**
 * D4. Builds one of this package's emitted records with a null prototype,
 * frozen, in the key order the caller supplies.
 *
 * The cast is the door's own statement: the caller supplies exactly the fields
 * the emitted shape declares, and nothing can be added afterwards.
 */
export function ownEmit<T>(fields: readonly (readonly [string, unknown])[]): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of fields) {
    Object.defineProperty(out, key, ownDataDescriptor(value));
  }
  return Object.freeze(out) as T;
}
