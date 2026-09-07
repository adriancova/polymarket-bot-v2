/**
 * THE LIFECYCLE DOOR: read a §7.4 market event payload into plain OWN data,
 * judge it inside a containment, and take every folded value from the read tree.
 *
 * ## Why this module exists
 *
 * `docs/adr/ADR-020-schema-parse-boundary-integrity.md` §1: at the pinned
 * `zod@4.4.3` a successful `safeParse` guarantees neither that the output
 * matches the input nor that the declared checks ran. A key the schema
 * DECLARES is read off the prototype chain when the input lacks it, and lands
 * in the library's output.
 *
 * `docs/contracts/schema-boundary.md` §3 measured that on this package (probe
 * O) and ranked it **HIGH**, because what it reaches is the projection's ONE
 * irreversible transition. A `MarketResolved` payload with `outcome` deleted is
 * refused clean (`UNIVERSE_INPUT_INVALID`); under a NON-ENUMERABLE inherited
 * `outcome` the same payload **resolves the market** —
 * `lifecycleState=RESOLVED`, `outcomeState=YES_WIN` — although
 * `docs/contracts/domain.md` §6.2 and rule 1 of `./lifecycle.ts` restrict a
 * terminal outcome to a `MarketResolved` event that carries one. The same holds
 * for `resolvedAt` (the market resolves at an instant no event carried) and for
 * `conditionId`, whose {@link module:./lifecycle} `checkIdentity` guard exists
 * to refuse an event naming a DIFFERENT market and is satisfiable from the
 * prototype.
 *
 * `UNIV-1` re-measured all of that at base `78ec81d` and swept every declared
 * key of all EIGHT dispatch arms: **32 of 32 required keys and 8 of 8 optional
 * keys adopt**, in BOTH the non-enumerable and the enumerable variant.
 * `z.strictObject` is not a defence — it never protected a key the schema
 * itself declares (ADR-020 §2).
 *
 * ## What this door performs, stated per `schema-boundary.md` §4
 *
 * - **D1 — materialize prototype-free before parsing.** {@link readOwnPayload}
 *   rebuilds the caller's value with `Object.create(null)`, reading own
 *   DESCRIPTORS only and refusing an accessor without invoking it. The tree
 *   handed to `zod` has no chain to read, so an absent declared key is absent.
 * - **D2 — NOT PERFORMED, and disclosed.** A severed, warmed arena is the
 *   `packages/risk` `schema-arena.ts` mechanism. This package may not import it
 *   (`docs/contracts/dependency-direction.md` lists no universe → risk edge,
 *   and `pnpm check:deps` is the gate) and may not paste it (the repo-wide
 *   deletion guard in `test/unit/execution-planner/mirrors.test.ts`). So the
 *   library's own state reads — `skipChecks`, `optin`/`optout`, `when` —
 *   remain defeatable HERE, exactly as in the `REC-1` adapter doors.
 *   **The compensation is measured**: this door does not delegate its
 *   DECISIONS to the library. {@link readDeclaredPayload} re-states, on its own
 *   reads of the materialized tree, the PRESENCE the frozen schema declares for
 *   every declared key of every arm, plus the type, the `.min(1)` bounds, the
 *   `z.int().positive()` bound, and the two enum vocabularies — so a payload
 *   missing a declared key is refused with every `zod` check switched off.
 *   Measured at base with an inherited `skipChecks`: `resolvedAt: "yesterday"`
 *   RESOLVED A MARKET at "yesterday", an empty `clarificationId` was recorded,
 *   and a fractional `metadataVersion` was accepted. Those close here too.
 *   What is NOT re-stated is disclosed below.
 * - **D3 — take every folded value from the materialized tree.**
 *   `./lifecycle.ts` never reads `parsed.data` at any of the nine sites it used
 *   to: `zod` answers "is this shape acceptable", and this door answers "what
 *   did the event actually carry".
 * - **D4 — emit prototype-free.** The payload record every arm folds is built
 *   with `Object.create(null)`, so an arm's `payload.rulesVersionId === undefined`
 *   test cannot be answered by `Object.prototype`. (Arrays keep
 *   `Array.prototype`; the numeric-name family is a different class, owned
 *   elsewhere — `schema-boundary.md` §2.)
 * - **Refusal construction is contained** (ADR-020 amendment 2026-09-06): a
 *   warm schema still builds its issues lazily per refusal, and that path reads
 *   through the prototype chain. Measured at base on this very door: of nine
 *   hostile prototype shapes, SEVEN turned a clean `UNIVERSE_INPUT_INVALID`
 *   into an escaping `TypeError` out of `applyMarketLifecycleEvent`.
 *   {@link containedParse} runs the parse AND the issue rendering inside one
 *   `try`, and a throw becomes a refusal detail.
 *
 * ## What this door does NOT re-state (owned residuals)
 *
 * The FORMAT checks that are not presence, bound, or vocabulary: the UUIDv7
 * pattern on `internalMarketId`, the canonical-integer pattern on the token
 * ids, the `CodeString` character class on `changedFields`, the decimal grammar
 * on `tickSize`/`minimumOrderSize`, and the full ISO-8601 shape on the four
 * instants (the door re-states only that an instant PARSES, which is what this
 * package's own comparisons need — `./time.ts`). With `zod`'s checks intact
 * those are enforced by the frozen schemas; under an inherited `skipChecks`
 * they are not, and the verdict is then base-identical rather than improved,
 * except where the identity guard or a bound already fails the event closed.
 * Be precise about the sharpest cell of that residual (review round 1,
 * MED-2): the instant-FORMAT half REACHES THE IRREVERSIBLE TRANSITION —
 * under an inherited `skipChecks`, a `MarketResolved` carrying
 * `resolvedAt: "Aug 28 2026"` or an offsetless `"2026-08-28T12:15:30"`
 * still RESOLVES the market and writes that string into
 * `projection.resolvedAt`, exactly as at base. Base-identical, not a
 * regression — but it is the transition this door exists to protect.
 * Owner: a `packages/universe` follow-up, or D2 when a severed arena becomes
 * reachable without a forbidden edge.
 *
 * ## Deployment reading, required whenever the §3 row is quoted
 *
 * Nothing on the wire can write `Object.prototype`. Every class above needs
 * code already executing in the process, so the row says "this check is not
 * load-bearing against an attacker already inside the process", not "a venue
 * can turn this off". It still matters because a terminal outcome is
 * irreversible, gates settlement and eligibility, and is the one transition the
 * frozen contract reserves to a single event.
 */

import { MAX_DECIMAL_STRING_LENGTH } from "@polymarket-bot/decimal";
import {
  MAX_CODE_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MarketClarificationObservedPayloadSchema,
  MarketClosingPayloadSchema,
  MarketDiscoveredPayloadSchema,
  MarketMetadataChangedPayloadSchema,
  MarketOpenedPayloadSchema,
  MarketResolvedPayloadSchema,
  MarketRulesChangedPayloadSchema,
  TerminalMarketOutcomeStateSchema,
  TradingParameterKindSchema,
  TradingParametersChangedPayloadSchema,
} from "@polymarket-bot/domain";
import type { z } from "zod";

import type { MarketLifecycleEventType } from "./lifecycle.js";
import { instantMilliseconds } from "./time.js";

/**
 * Deepest nesting a lifecycle payload may have.
 *
 * Every §7.4 lifecycle payload is FLAT except for its one string array, so two
 * levels is the documented shape; the bound exists so a gateway-published input
 * cannot drive unbounded recursion in this module.
 */
export const MAX_PAYLOAD_DEPTH = 8;

/** A record this module built: no prototype, own data properties only. */
export type OwnRecord = Readonly<Record<string, unknown>>;

/** The outcome of reading a value as plain own data. Never a throw. */
export type OwnPayloadRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string };

/** Internal signal: this value is not plain data and the read stops here. */
class NotPlainData extends Error {}

/**
 * The one descriptor every record this package emits is built from.
 *
 * Exported (`UNIV-2`) so the registration and envelope doors in
 * `./caller-door.ts` define their own properties with the SAME prototype-free
 * descriptor rather than re-deriving it: a second, near-identical copy of this
 * six-line defence inside one package is exactly the drift
 * `docs/contracts/schema-boundary.md` §1 warns about. The behaviour is
 * unchanged from `UNIV-1` — this is a rename plus an export, and
 * `./lifecycle-door.test.ts` still passes unmodified.
 */
export function ownDataDescriptor(value: unknown): PropertyDescriptor {
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
    throw new NotPlainData(
      "an accessor property: a getter is code rather than event data, and it is refused without being invoked",
    );
  }
  return { present: true, value: descriptor.value };
}

function readMember(value: unknown, depth: number): unknown {
  if (value === null) {
    return null;
  }
  // `undefined` is not a JSON value. It reaches here only from a hand-built
  // object, and it is read as ABSENT — the verdict `zod` already gives an own
  // `undefined` (measured at base: the refusal message for an own
  // `outcome: undefined` and for a missing `outcome` is the same string), and
  // the one that cannot later diverge from absence on a prototype-free tree.
  if (value === undefined) {
    return undefined;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value;
  }
  if (kind !== "object") {
    throw new NotPlainData(`a lifecycle payload carries event data, not a ${kind}`);
  }
  if (depth >= MAX_PAYLOAD_DEPTH) {
    throw new NotPlainData(`nested deeper than ${String(MAX_PAYLOAD_DEPTH)} levels`);
  }
  const container = value as object;
  const prototype: unknown = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    if (prototype !== null && prototype !== Array.prototype) {
      throw new NotPlainData("an array with a non-plain prototype is not event data");
    }
    return readArrayInto(container, depth);
  }
  if (prototype !== null && prototype !== Object.prototype) {
    throw new NotPlainData(
      "a non-plain prototype: an inherited property is state the event does not own, and no copy of it can be faithful",
    );
  }
  return readObjectInto(container, depth);
}

function readObjectInto(container: object, depth: number): OwnRecord {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key === "symbol") {
      throw new NotPlainData("a symbol-keyed property is not event data");
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
      Object.defineProperty(out, key, ownDataDescriptor(read));
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
      throw new NotPlainData("a sparse array: event data has no holes");
    }
    Object.defineProperty(out, String(index), ownDataDescriptor(readMember(member.value, depth + 1)));
  }
  return out;
}

/**
 * D1. Reads a caller-supplied payload into a fresh prototype-free tree of plain
 * data, or says why it is not one. TOTAL: never throws, including on a
 * `RangeError` from a pathologically deep input.
 */
export function readOwnPayload(value: unknown): OwnPayloadRead {
  try {
    return { ok: true, value: readMember(value, 0) };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof NotPlainData
          ? error.message
          : "reading the payload as data failed unexpectedly; a payload that cannot be read is refused rather than folded (fail closed)",
    };
  }
}

/**
 * D4. Builds one of this module's emitted records with a null prototype.
 *
 * An emitted record is read by someone else's `record.rulesVersionId`, and a
 * key the record does not carry must not be answerable by `Object.prototype`
 * (`schema-boundary.md` §1, D4; the same class `WP-160-FU1` closed on the
 * feature snapshot's members). Every property is non-writable and
 * non-configurable, so nothing can be added afterwards either.
 */
export function ownEmit<T>(fields: Readonly<Record<string, unknown>>): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    Object.defineProperty(out, key, ownDataDescriptor(fields[key]));
  }
  return out as T;
}

/** The result of a contained parse: no error object escapes, only rendered issues. */
export type ContainedParse =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Anything with `zod`'s `safeParse` shape. */
interface PayloadSchema {
  readonly safeParse: (
    value: unknown,
  ) => { readonly success: true } | { readonly success: false; readonly error: z.ZodError };
}

/**
 * Runs a schema AND renders its refusal inside one containment.
 *
 * ADR-020's 2026-09-06 amendment: the warmed arena protects the parse, not
 * `zod`'s ERROR CONSTRUCTION, which is built lazily per call even on a warm
 * schema and reads through the prototype chain. Measured on this door at base:
 * an inherited `get`, `value`, `_zod` or `message` turned the clean refusal of
 * a malformed `MarketOpened` payload into an escaping `TypeError`.
 * `applyMarketLifecycleEvent` returns a typed result and no caller in this
 * repository wraps it in a `try`, so a throw here is an availability defeat.
 *
 * The rendering is byte-identical to what the raw `zod` path produced, so an
 * honest refusal's message does not move.
 */
export function containedParse(schema: PayloadSchema, value: unknown): ContainedParse {
  try {
    const result = schema.safeParse(value);
    if (result.success) {
      return { ok: true };
    }
    return {
      ok: false,
      issues: result.error.issues.map((issue) => {
        const path = issue.path.map((segment) => String(segment)).join(".");
        return `${path === "" ? "(root)" : path}: ${issue.message}`;
      }),
    };
  } catch {
    return {
      ok: false,
      issues: [
        "(root): the schema could not judge this payload (its refusal could not be constructed); refused",
      ],
    };
  }
}

/**
 * The shapes this door re-states on its own reads (the D2 compensation).
 *
 * Each name is the frozen schema's own declaration, restated as a read that no
 * inherited `skipChecks` can switch off. Nothing here invents a vocabulary: the
 * two enum option lists are read FROM the frozen schemas at module load, and
 * the two length bounds are the frozen constants.
 */
type DeclaredShape =
  /** `Uuidv7Schema` — a string; the UUIDv7 PATTERN is not re-stated (see the header). */
  | "identifier"
  /** `NonEmptyStringSchema` / `TokenIdSchema` — a bounded non-empty string. */
  | "boundedString"
  /** `CodeStringSchema` — a short bounded non-empty string; the character class is not re-stated. */
  | "codeString"
  /** `IsoTimestampSchema` — a non-empty string that names a parseable instant. */
  | "instant"
  /** `PositiveIntegerSchema` — `z.int().positive()`. */
  | "positiveInteger"
  /** `z.array(CodeStringSchema).min(1)` — a non-empty list of code strings. */
  | "codeStringList"
  /** `z.array(TradingParameterKindSchema).min(1)` — a non-empty list from the frozen vocabulary. */
  | "parameterKindList"
  /** `TerminalMarketOutcomeStateSchema` — one of the four terminal states. */
  | "terminalOutcome"
  /**
   * `PositiveDecimalStringSchema` — a non-empty decimal string within
   * `MAX_DECIMAL_STRING_LENGTH`; the canonical GRAMMAR is not re-stated.
   */
  | "decimalString";

interface DeclaredKey {
  readonly key: string;
  readonly shape: DeclaredShape;
  /** Whether the frozen schema requires the key. Verified against the schema in the suite. */
  readonly required: boolean;
}

/** How a refusal names each re-stated shape. */
const SHAPE_DESCRIPTIONS: Readonly<Record<DeclaredShape, string>> = Object.freeze({
  identifier: "a non-empty identifier",
  boundedString: "a non-empty string within the declared length bound",
  codeString: "a non-empty code within the declared length bound",
  instant: "an instant that parses",
  positiveInteger: "a positive integer",
  codeStringList: "a non-empty list of codes",
  parameterKindList: "a non-empty list of trading parameter kinds",
  terminalOutcome: "one of the four terminal outcome states",
  decimalString: "a non-empty decimal string",
});

function declared(key: string, shape: DeclaredShape, required = true): DeclaredKey {
  return Object.freeze({ key, shape, required });
}

/** The two identity keys every §7.4 lifecycle payload declares (`marketReferenceShape`). */
const MARKET_REFERENCE: readonly DeclaredKey[] = [
  declared("internalMarketId", "identifier"),
  declared("conditionId", "boundedString"),
];

/**
 * Every key the frozen schema of every arm declares — the required-key sweep,
 * turned into the door's own read list.
 *
 * A key MISSING from this table would be a key the fold could still adopt from
 * the prototype, so the table is not allowed to drift: `./lifecycle-door.test.ts`
 * derives the key set and the required/optional split FROM the frozen schemas
 * and fails when the two disagree.
 */
const DECLARED_KEYS: Readonly<Record<MarketLifecycleEventType, readonly DeclaredKey[]>> =
  Object.freeze({
    MarketDiscovered: [
      ...MARKET_REFERENCE,
      declared("yesTokenId", "boundedString"),
      declared("noTokenId", "boundedString"),
      declared("seriesId", "codeString", false),
      declared("metadataVersion", "positiveInteger"),
    ],
    MarketMetadataChanged: [
      ...MARKET_REFERENCE,
      declared("metadataVersion", "positiveInteger"),
      declared("previousMetadataVersion", "positiveInteger", false),
      declared("changedFields", "codeStringList"),
    ],
    MarketRulesChanged: [
      ...MARKET_REFERENCE,
      declared("rulesVersionId", "boundedString"),
      declared("previousRulesVersionId", "boundedString", false),
      declared("changedFields", "codeStringList"),
    ],
    MarketOpened: [...MARKET_REFERENCE, declared("openedAt", "instant")],
    MarketClosing: [...MARKET_REFERENCE, declared("closesAt", "instant")],
    MarketResolved: [
      ...MARKET_REFERENCE,
      declared("outcome", "terminalOutcome"),
      declared("resolvedAt", "instant"),
      declared("rulesVersionId", "boundedString", false),
    ],
    MarketClarificationObserved: [
      ...MARKET_REFERENCE,
      declared("clarificationId", "boundedString"),
      declared("observedAt", "instant"),
      declared("rulesVersionId", "boundedString", false),
    ],
    TradingParametersChanged: [
      ...MARKET_REFERENCE,
      declared("parametersVersion", "positiveInteger"),
      declared("previousParametersVersion", "positiveInteger", false),
      declared("parameterVersionRef", "boundedString"),
      declared("changedParameters", "parameterKindList"),
      declared("tickSize", "decimalString", false),
      declared("minimumOrderSize", "decimalString", false),
    ],
  });

/** The declared keys of one arm, for the drift census in the suite. */
export function declaredKeysOf(eventType: MarketLifecycleEventType): readonly DeclaredKey[] {
  return DECLARED_KEYS[eventType];
}

/**
 * The two frozen vocabularies, copied into this module's OWN frozen lists at
 * module load. Read from the schemas rather than retyped: a vocabulary this
 * package spelled out itself could drift from the contract silently.
 */
const TERMINAL_OUTCOMES: readonly string[] = Object.freeze([
  ...TerminalMarketOutcomeStateSchema.options,
]);
const PARAMETER_KINDS: readonly string[] = Object.freeze([...TradingParameterKindSchema.options]);

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum
    ? value
    : undefined;
}

function readShape(shape: DeclaredShape, value: unknown): unknown {
  switch (shape) {
    case "identifier":
      // No maximum: `Uuidv7Schema` declares none, and a re-statement may never
      // be STRICTER than the schema it re-states.
      return typeof value === "string" && value.length >= 1 ? value : undefined;
    case "boundedString":
      return boundedString(value, MAX_IDENTIFIER_LENGTH);
    case "decimalString":
      // `MAX_DECIMAL_STRING_LENGTH`, not the identifier bound: the frozen
      // decimal schema accepts up to 1024 characters, and a re-statement may
      // never be STRICTER than the schema it re-states.
      return boundedString(value, MAX_DECIMAL_STRING_LENGTH);
    case "codeString":
      return boundedString(value, MAX_CODE_LENGTH);
    case "instant": {
      const text = typeof value === "string" && value.length >= 1 ? value : undefined;
      // An instant that does not parse is one this package's own comparisons
      // (`./time.ts`) fall back to string equality on, and a market that
      // resolved at "yesterday" is what an inherited `skipChecks` produced at
      // base.
      return text !== undefined && instantMilliseconds(text) !== undefined ? text : undefined;
    }
    case "positiveInteger":
      return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
    case "terminalOutcome":
      return typeof value === "string" && TERMINAL_OUTCOMES.includes(value) ? value : undefined;
    case "codeStringList":
      return readList(value, (member) => boundedString(member, MAX_CODE_LENGTH));
    case "parameterKindList":
      return readList(value, (member) =>
        typeof member === "string" && PARAMETER_KINDS.includes(member) ? member : undefined,
      );
  }
}

function readList(
  value: unknown,
  readMemberValue: (member: unknown) => unknown,
): readonly unknown[] | undefined {
  if (!Array.isArray(value) || value.length < 1) {
    return undefined;
  }
  const out: unknown[] = [];
  for (const member of value as readonly unknown[]) {
    const read = readMemberValue(member);
    if (read === undefined) {
      return undefined;
    }
    Object.defineProperty(out, String(out.length), ownDataDescriptor(read));
  }
  return out;
}

/**
 * The record an arm folds: null-prototype, own data only.
 *
 * The two identity keys are typed as PRESENT because every §7.4 lifecycle
 * payload declares `marketReferenceShape` and the door refuses an event that
 * does not carry both — which is precisely the `conditionId` row of probe O.
 */
export interface OwnLifecyclePayload {
  readonly internalMarketId: string;
  readonly conditionId: string;
  readonly [key: string]: unknown;
}

/** What the door produced for an arm to fold, or why it refused. */
export type DeclaredPayloadRead =
  | { readonly ok: true; readonly value: OwnLifecyclePayload }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * D3 + D4. Builds the record the arm folds, entirely from the materialized
 * tree, with a null prototype.
 *
 * Every declared key of the arm is read here — including the ones no arm
 * consumes (`seriesId`, `changedFields`, `changedParameters`,
 * `previousParametersVersion`), because a key adopted from the prototype
 * changes ACCEPTANCE even when it changes no projected field: at base, deleting
 * any one of the 32 required keys is refused clean and every one of them is
 * satisfiable from `Object.prototype`.
 */
export function readDeclaredPayload(
  eventType: MarketLifecycleEventType,
  own: unknown,
): DeclaredPayloadRead {
  if (typeof own !== "object" || own === null || Array.isArray(own)) {
    return { ok: false, issues: ["(root): a lifecycle payload is an object"] };
  }
  const source = own as Record<string, unknown>;
  const out = Object.create(null) as Record<string, unknown>;
  const issues: string[] = [];
  for (const entry of DECLARED_KEYS[eventType]) {
    // The materialized tree has no prototype, so this read cannot inherit.
    const present = Object.hasOwn(source, entry.key);
    if (!present) {
      if (entry.required) {
        issues.push(`${entry.key}: the event carries no ${entry.key}`);
      }
      continue;
    }
    const read = readShape(entry.shape, source[entry.key]);
    if (read === undefined) {
      issues.push(
        `${entry.key}: the event's own ${entry.key} is not ${SHAPE_DESCRIPTIONS[entry.shape]}`,
      );
      continue;
    }
    Object.defineProperty(out, entry.key, ownDataDescriptor(read));
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  // The cast is the door's own statement: every key present on `out` was read
  // through {@link readShape} into the shape the frozen schema declares, and
  // both identity keys are present or this line was not reached. The record is
  // frozen as well as prototype-free: nothing downstream may extend the event.
  return { ok: true, value: Object.freeze(out) as OwnLifecyclePayload };
}

/** The frozen §7.4 payload schema each arm is judged against. */
const PAYLOAD_SCHEMAS: Readonly<Record<MarketLifecycleEventType, z.ZodType>> = Object.freeze({
  MarketDiscovered: MarketDiscoveredPayloadSchema,
  MarketMetadataChanged: MarketMetadataChangedPayloadSchema,
  MarketRulesChanged: MarketRulesChangedPayloadSchema,
  MarketOpened: MarketOpenedPayloadSchema,
  MarketClosing: MarketClosingPayloadSchema,
  MarketResolved: MarketResolvedPayloadSchema,
  MarketClarificationObserved: MarketClarificationObservedPayloadSchema,
  TradingParametersChanged: TradingParametersChangedPayloadSchema,
});

/** The frozen schema for an arm, exposed so the suite can derive the census from it. */
export function payloadSchemaOf(eventType: MarketLifecycleEventType): z.ZodType {
  return PAYLOAD_SCHEMAS[eventType];
}

/**
 * THE DOOR, in the order the four steps must happen.
 *
 * 1. **D1** materialize the caller's value prototype-free;
 * 2. judge the MATERIALIZED tree against the frozen schema, with the parse and
 *    the refusal rendering both contained;
 * 3. **D3/D4** build the arm's payload from the materialized tree, re-stating
 *    the presence and bounds the schema declares (the D2 compensation).
 *
 * Step 2 runs before step 3 so that an honest refusal keeps the frozen schema's
 * own message, byte for byte. Step 3 only ever refuses something step 2 let
 * through, which — with `zod`'s checks intact — is nothing.
 */
export function openLifecyclePayload(
  eventType: MarketLifecycleEventType,
  value: unknown,
): DeclaredPayloadRead {
  const own = readOwnPayload(value);
  if (!own.ok) {
    return { ok: false, issues: [`(root): ${own.detail}`] };
  }
  const parsed = containedParse(PAYLOAD_SCHEMAS[eventType], own.value);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues };
  }
  return readDeclaredPayload(eventType, own.value);
}
