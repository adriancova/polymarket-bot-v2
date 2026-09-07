/**
 * THE CLOB WIRE DOOR: read an inbound venue value into plain OWN data, judge it
 * inside a containment, and build the answer from the data that was actually
 * there.
 *
 * ## Why this module exists
 *
 * `docs/adr/ADR-020-schema-parse-boundary-integrity.md` §1: at the pinned
 * `zod@4.4.3` a key the schema DECLARES is read off the prototype chain when
 * the input lacks it, and lands in the output.
 *
 * `docs/contracts/schema-boundary.md` §3 measured it on this package's CLOB
 * half (`REC-1`, reviewer-reproduced verbatim), and both measurements are
 * reproduced at base `989d41d` in `./prototype-boundary.test.ts`:
 *
 * - `parseMarketEvent` — under an inherited `event_type` (non-enumerable AND
 *   enumerable), a function documented to RETURN a `MarketEventParseResult`
 *   instead THREW `TypeError: propValues[key].add is not a function` out of the
 *   cold `discriminatedUnion` lazy build. The clean verdict for the same frame
 *   is `{"status":"unrecognized"}`. This is the `status`-family cold-lazy
 *   trigger the `schema-boundary.md` §2 refinements row records: the
 *   discriminator read and the poisoning trigger meet on one schema.
 * - `parseVenueOrderBook` — a book with `hash` deleted is refused clean
 *   (`invalid`), yet under an inherited `hash` it PARSES with
 *   `hash:"INVENTED"`, and under an inherited `tick_size` with
 *   `tick_size:"0.99"` — an ECONOMIC parameter entering the recorded book.
 *
 * The declared-key sweep behind those two cells is wider than the cells:
 * **every one of the 82 market-event cells and all 12 order-book cells (single
 * AND batch) diverged at base**, in both pollution variants. This door closes
 * the family, not the three named cells.
 *
 * ## What this door performs, stated per `docs/contracts/schema-boundary.md` §4
 *
 * - **D1 — materialize prototype-free before parsing.** {@link readOwnWireValue}
 *   rebuilds the value with `Object.create(null)` from own DESCRIPTORS only, at
 *   every level, so no node handed to `zod` has a chain to read.
 * - **D2 — NOT PERFORMED, and disclosed.** The severed, warmed arena lives in
 *   `packages/risk`; this package may not import it (the edge is forbidden by
 *   `docs/contracts/dependency-direction.md`) and may not paste it (the
 *   deletion guard in `test/unit/execution-planner/mirrors.test.ts`). The
 *   library's own state reads therefore remain defeatable here. The
 *   compensation is NAMED and BOUNDED, not a general claim:
 *   1. the ROUTING decision is the door's own — `parseMarketEvent` reads
 *      `event_type` from the materialized tree with {@link ownStringMember},
 *      so a frame that declared no event type is refused with every `zod`
 *      check switched off;
 *   2. required-key PRESENCE is re-stated on the door's own reads
 *      ({@link restatedFieldFailures}), so the required-key waiver class
 *      (inherited `optin`/`optout`) cannot admit a book that is missing
 *      `hash`, `tick_size` or any other declared-required field;
 *   3. exactly one BOUND is re-stated — the order book's `hash` `.min(1)`,
 *      the only `.min()` on either door's payload family — because "an empty
 *      hash is not a hash" (`./order-book.ts` header).
 *   Nothing else is re-stated. In particular the `z.number().int()` inside
 *   `VenueEpochLikeSchema` stays library-dependent; that residual is measured
 *   in `./prototype-boundary.test.ts` rather than asserted away.
 * - **D3 — take values from the materialized tree.**
 *   {@link projectDeclaredFields} builds the emitted event/book from the tree,
 *   key by declared key, never from `parsed.data`. This is what closes the LOSS
 *   half of the class: with a prototype-free INPUT the library can no longer
 *   adopt, but its own output assembly still writes through `Object.prototype`,
 *   so an inherited setter on a declared key can still swallow a field it did
 *   receive.
 * - **D4 — emit prototype-free.** Every record this door emits — the parse
 *   RESULT itself, the event, the book, each level, each batched entry — is
 *   built with `Object.create(null)`. Arrays keep `Array.prototype`: they are a
 *   separate class (`docs/handoffs/REC-1.md` residuals) and the normalizers
 *   iterate them with `.entries()`.
 * - **Refusal construction is contained** (ADR-020 amendment 2026-09-06): a
 *   warm schema still constructs its issues lazily per refusal and that path
 *   reads through the prototype chain, so a refusal can escape as an exception.
 *   {@link containedJudgement} runs the parse AND the issue rendering inside one
 *   `try`, which is what makes `parseMarketEvent`'s documented totality true
 *   rather than aspirational.
 *
 * ## Why this is a venue-local door and not the rtds one
 *
 * `../rtds/wire-door.ts` closes the same class for the RTDS half, and
 * `CLOB-1`'s grant excludes `src/rtds/**` — collapsing the two would edit a
 * module this round may not touch. So the repository now carries a fifth
 * near-parallel door (`docs/handoffs/REC-1.md` records the first four): a
 * materializer fix lands once more than it should. Recorded as a residual, with
 * the same owner as the other four — collapse them when a shared home exists
 * that every consumer may import without a forbidden edge.
 *
 * ## Deployment reading, required whenever the §3 row is quoted
 *
 * Nothing on the wire can write `Object.prototype`; every class above needs
 * code already executing in the process. The row says the check is not
 * load-bearing against an attacker already inside the process, not that a venue
 * can turn it off. It matters because the recorder is unattended.
 */

import type { z } from "zod";

/**
 * Deepest nesting a venue value may have.
 *
 * The deepest honest path is three levels (event → `bids` → level, event →
 * `price_changes` → entry), and `new_market.fee_schedule` is `z.unknown()`, so
 * the cap has to leave room for whatever the venue puts inside it. A value
 * nested deeper is refused rather than truncated — a known drift-refusal,
 * disclosed with the other exotic-shape refusals in this door's handoff.
 */
export const MAX_WIRE_DEPTH = 16;

/** A record this module built: no prototype, own data properties only. */
export type OwnWireRecord = Readonly<Record<string, unknown>>;

/** The outcome of reading a venue value as plain own data. Never a throw. */
export type OwnWireRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string };

/** Internal signal: this value is not plain wire data and the read stops here. */
class NotWireData extends Error {}

function wireDescriptor(value: unknown): PropertyDescriptor {
  // Built prototype-free on purpose: an inherited `get` makes every
  // object-literal descriptor throw (ADR-020 §1 class 8), and this door is
  // written to survive its own defences being attacked.
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.enumerable = true;
  descriptor.writable = false;
  descriptor.configurable = false;
  return descriptor;
}

/** Reads one own DATA property, refusing an accessor without invoking it. */
function ownMemberOf(
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
    throw new NotWireData("an accessor property, which is code rather than venue data");
  }
  return { present: true, value: descriptor.value };
}

function copyMember(value: unknown, depth: number): unknown {
  if (value === null) {
    return null;
  }
  // `undefined` is not a JSON value. It reaches here only from a hand-built
  // object, and it is read as ABSENT — the verdict a prototype-free tree can
  // never later see diverge from absence.
  if (value === undefined) {
    return undefined;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value;
  }
  if (kind !== "object") {
    throw new NotWireData(`the venue publishes JSON data, not a ${kind}`);
  }
  if (depth >= MAX_WIRE_DEPTH) {
    throw new NotWireData(`nested deeper than ${String(MAX_WIRE_DEPTH)} levels`);
  }
  const container = value as object;
  const chain: unknown = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    if (chain !== null && chain !== Array.prototype) {
      throw new NotWireData("an array with a non-plain prototype is not venue data");
    }
    return copyArray(container, depth);
  }
  if (chain !== null && chain !== Object.prototype) {
    throw new NotWireData(
      "a non-plain prototype, which no copy of the frame can carry faithfully",
    );
  }
  return copyRecord(container, depth);
}

function copyRecord(container: object, depth: number): OwnWireRecord {
  const built = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key === "symbol") {
      throw new NotWireData("a symbol-keyed property is not venue data");
    }
    if (key === "__proto__") {
      throw new NotWireData('a "__proto__" property, which no copy can carry faithfully');
    }
    const member = ownMemberOf(container, key);
    if (!member.present) {
      continue;
    }
    const copied = copyMember(member.value, depth + 1);
    // An `undefined` member is materialized as ABSENT, so "present but
    // undefined" and "absent" cannot diverge under any later read.
    if (copied !== undefined) {
      Object.defineProperty(built, key, wireDescriptor(copied));
    }
  }
  return built;
}

function copyArray(container: object, depth: number): readonly unknown[] {
  const lengthMember = ownMemberOf(container, "length");
  const length = lengthMember.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new NotWireData("an array whose length is not a count");
  }
  const built: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const member = ownMemberOf(container, String(index));
    if (!member.present) {
      throw new NotWireData("a sparse array: venue data has no holes");
    }
    Object.defineProperty(
      built,
      String(index),
      wireDescriptor(copyMember(member.value, depth + 1)),
    );
  }
  return built;
}

/**
 * D1. Reads an inbound value into a fresh prototype-free tree of plain data, or
 * says why it is not one. TOTAL: never throws.
 */
export function readOwnWireValue(value: unknown): OwnWireRead {
  try {
    return { ok: true, value: copyMember(value, 0) };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof NotWireData
          ? error.message
          : "reading the frame as data failed unexpectedly; a frame that cannot be read is refused rather than parsed (fail closed)",
    };
  }
}

/** Whether a value is a record this door materialized (and not an array). */
export function isOwnWireRecord(value: unknown): value is OwnWireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D3, for the field that ROUTES a market frame.
 *
 * The string check is this module's own. A `z.string()` type check is not a
 * FORMAT check and survives `skipChecks`, but the door's routing decision must
 * not depend on the library having run at all.
 */
export function ownStringMember(record: OwnWireRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** The result of a contained judgement: no error object escapes, only text. */
export type ContainedJudgement =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Anything with `zod`'s `safeParse` shape. */
export interface WireJudge {
  readonly safeParse: (
    value: unknown,
  ) => { readonly success: true } | { readonly success: false; readonly error: z.ZodError };
}

/**
 * Runs a schema AND renders its refusal inside one containment.
 *
 * ADR-020's 2026-09-06 amendment: a warm schema still constructs its issues
 * lazily per refusal, and that construction reads through the prototype chain,
 * so a refusal can escape as an exception instead of a value. A COLD schema can
 * do worse — the base measurement of this very package is a `TypeError` thrown
 * out of a lazy build. Both are converted here into the door's documented
 * refusal, because a parser documented total that throws is how a recorder
 * silently loses a frame.
 */
export function containedJudgement(schema: WireJudge, value: unknown): ContainedJudgement {
  try {
    const judged = schema.safeParse(value);
    if (judged.success) {
      return { ok: true };
    }
    return { ok: false, issues: renderIssues(judged.error) };
  } catch {
    return {
      ok: false,
      issues: [
        "<root>: the schema could not judge this value (its refusal could not be constructed)",
      ],
    };
  }
}

function renderIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}

// --------------------------------------------------------------------------
// D3 / D4 — the declared-field projection
// --------------------------------------------------------------------------

/**
 * What the door does with one declared field's own value.
 *
 * `"verbatim"` covers every field whose schema is a plain type check. The two
 * TRANSFORMING primitives get their own rule because the emitted value has to
 * be what the schema produces, byte for byte:
 *
 * - `"optional-decimal"` is `VenueOptionalDecimalStringSchema`, which
 *   preprocesses the wire empty string into `null` (ADR-001 §8.1: `""`, `null`
 *   and absent are one fact past the adapter);
 * - `"side"` is `VenueSideSchema`, which upper-cases.
 *
 * The two container rules project a nested shape onto ITS declared fields, which
 * is what makes the door's output a projection at every level, exactly as
 * `z.object` strips unknown keys at every level.
 *
 * `./venue-fields.test.ts` derives all four facts FROM the schemas — the key
 * list and its ORDER, requiredness via `isOptional()`, and the two transform
 * rules by node IDENTITY against the exported primitives — so a field added,
 * reordered, re-modified or re-typed without a matching table row fails the
 * suite instead of silently changing what the door emits.
 */
export type WireFieldRule =
  | "verbatim"
  | "optional-decimal"
  | "side"
  | { readonly object: WireFields }
  | { readonly objectArray: WireFields };

/** One declared field of one wire shape. */
export interface WireField {
  readonly key: string;
  /** `true` when the schema refuses the shape with this key absent. */
  readonly required: boolean;
  readonly rule: WireFieldRule;
  /**
   * The one re-stated BOUND (D2 compensation 3): the order book's `hash`
   * `.min(1)`. Absent everywhere else, because nothing else on either payload
   * family carries a `.min()`.
   */
  readonly nonEmpty?: true;
}

/** The declared fields of one wire shape, in the schema's declaration order. */
export type WireFields = readonly WireField[];

function projectValue(rule: WireFieldRule, value: unknown): unknown {
  if (rule === "verbatim") {
    return value;
  }
  if (rule === "optional-decimal") {
    // `z.preprocess((v) => (v === "" ? null : v), …)`, restated on the door's
    // own read. Every other input form is passed through untouched.
    return value === "" ? null : value;
  }
  if (rule === "side") {
    // `z.string().transform((v) => v.toUpperCase())`. The schema has already
    // refused a non-string by the time this runs; the guard is here so the
    // projection is total on its own terms rather than on the library's.
    return typeof value === "string" ? value.toUpperCase() : value;
  }
  if ("object" in rule) {
    return isOwnWireRecord(value) ? projectDeclaredFields(rule.object, value) : value;
  }
  if (!Array.isArray(value)) {
    return value;
  }
  const projected: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const element: unknown = value[index];
    Object.defineProperty(
      projected,
      String(index),
      wireDescriptor(
        isOwnWireRecord(element) ? projectDeclaredFields(rule.objectArray, element) : element,
      ),
    );
  }
  return projected;
}

/**
 * D3 + D4. Builds the emitted record from the MATERIALIZED tree: the declared
 * keys, in the schema's order, taking each value from the tree and applying the
 * schema's own transform, onto a null prototype.
 *
 * A declared key that is not an own property of the tree is OMITTED, which is
 * what `zod` does with an absent optional key (measured at base: a book without
 * `timestamp` and `last_trade_price` emits neither key).
 */
export function projectDeclaredFields(
  fields: WireFields,
  record: OwnWireRecord,
): OwnWireRecord {
  const built = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.hasOwn(record, field.key)) {
      continue;
    }
    Object.defineProperty(
      built,
      field.key,
      wireDescriptor(projectValue(field.rule, record[field.key])),
    );
  }
  return built;
}

/**
 * D2 compensation, points 2 and 3: the presence and bound re-statement.
 *
 * Runs AFTER the schema has said yes, so in a clean process it never changes a
 * verdict — `./venue-fields.test.ts` proves that over the whole declared-key
 * matrix by differencing the door against the raw schema. Under an inherited
 * `optin`/`optout` pair, or an inherited `skipChecks`, it is the only thing
 * left standing.
 */
export function restatedFieldFailures(
  fields: WireFields,
  record: OwnWireRecord,
): readonly string[] {
  const failures: string[] = [];
  for (const field of fields) {
    const present = Object.hasOwn(record, field.key);
    if (field.required && !present) {
      failures.push(
        `${field.key}: required by the wire contract and absent from the frame's own properties`,
      );
      continue;
    }
    if (field.nonEmpty === true && record[field.key] === "") {
      failures.push(`${field.key}: present but empty, which the wire contract forbids`);
    }
  }
  return failures;
}

/** D4 for the door's own answers: a result record with no prototype. */
export function ownResult<T extends object>(entries: T): Readonly<T> {
  const built = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(entries)) {
    Object.defineProperty(built, key, wireDescriptor((entries as Record<string, unknown>)[key]));
  }
  return built as Readonly<T>;
}
