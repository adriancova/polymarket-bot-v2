/**
 * Own-data boundary (ADR-020), following polymarket-public's wire-door.
 * D1/D3/D4: copy own enumerable data in key order, judge the copy, emit it frozen.
 * D2's shared arena is not importable on this package's dependency edges. The
 * field constraints are therefore re-derived from the frozen schema, and its
 * provenance refinement is enforced on own data independently of parse flags.
 * Containment covers parsing AND refusal rendering.
 * Arrays retain Array.prototype, as in the reference door (a separate class).
 *
 * D5 (review round 4): the WIRE BYTES are emitted by {@link encodeWireJson},
 * which walks the materialized tree and reads only own data. `JSON.stringify`
 * could not be used for that, because it consults the PROTOTYPE CHAIN for
 * `toJSON` — see that function's header for the two measured routes by which an
 * inherited `toJSON` changed the bytes of an accepted envelope.
 */
import { UnknownPayloadEventEnvelopeSchema } from "@polymarket-bot/domain";

import { brandOwn, ENVELOPE_REFUSAL_BRAND, hasOwnBrand } from "./brand.js";
import { EventBusEnvelopeError } from "./errors.js";

export const MAX_WIRE_DEPTH = 16;

/**
 * This module's private "the value is not wire data" signal.
 *
 * BRANDED rather than recognised with `instanceof`: the catch blocks below see
 * whatever a caller's `Proxy` trap threw as well as this class, and `instanceof`
 * walks the thrown value's prototype chain, so a hostile `getPrototypeOf` makes
 * the classification throw. See `./brand.ts`.
 */
const NOT_WIRE_DATA_BRAND: unique symbol = Symbol("@polymarket-bot/event-bus non-wire value");

class NotWireData extends Error {
  constructor(message: string) {
    super(message);
    brandOwn(this, NOT_WIRE_DATA_BRAND);
  }
}

function wireDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.enumerable = true;
  descriptor.writable = false;
  descriptor.configurable = false;
  return descriptor;
}

function copyMember(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new NotWireData("an envelope must contain data, not executable or symbolic values");
    }
    // Keep undefined and bigint: existing JSON encoding semantics (including
    // the typed bigint refusal) are unchanged for these primitive values.
    return value;
  }
  if (depth >= MAX_WIRE_DEPTH) {
    throw new NotWireData(`nested deeper than ${String(MAX_WIRE_DEPTH)} levels`);
  }
  const array = Array.isArray(value);
  const chain: unknown = Object.getPrototypeOf(value);
  if (chain !== null && chain !== (array ? Array.prototype : Object.prototype)) {
    throw new NotWireData("a non-plain prototype is not envelope data");
  }
  const built: object = array ? [] : Object.create(null) as object;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new NotWireData("an accessor property is code rather than envelope data");
    }
    if (!descriptor.enumerable) {
      continue;
    }
    if (typeof key === "symbol") {
      throw new NotWireData("a symbol-keyed property is not envelope data");
    }
    Object.defineProperty(built, key, wireDescriptor(copyMember(descriptor.value, depth + 1)));
  }
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value as number;
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(built, String(index))) {
        throw new NotWireData("a sparse array is not envelope data");
      }
    }
  }
  return Object.freeze(built);
}

export function readOwnWireValue(value: unknown): unknown {
  try {
    return copyMember(value, 0);
  } catch (error) {
    // What arrives here is EITHER this module's own refusal OR whatever a
    // caller's reflection trap threw, so the classification must be total.
    throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
      issues: [{ path: "", message: hasOwnBrand(error, NOT_WIRE_DATA_BRAND)
        ? (error as NotWireData).message : "reading the envelope as own data failed" }],
    });
  }
}

/** Local equivalent of the reference door's containedJudgement; no new edge. */
export function containedJudgement<T>(judge: () => T): T {
  try {
    return judge();
  } catch (error) {
    // BRAND, NOT `instanceof` (review round 4). `instanceof` walks the thrown
    // value's prototype chain, so a caller-supplied `Proxy` with a throwing
    // `getPrototypeOf` trap made the classification ITSELF throw and a bare
    // `RangeError` left this boundary. `hasOwnBrand` reads one own descriptor
    // and is total, so every path below ends in a typed refusal. An honest
    // refusal is re-thrown untouched, message, `code` and `details` intact.
    if (hasOwnBrand(error, ENVELOPE_REFUSAL_BRAND)) {
      throw error;
    }
    throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
      issues: [{ path: "", message: "the schema could not judge this value (its refusal could not be constructed)" }],
    });
  }
}

/**
 * THE WIRE BYTES — `JSON.stringify` restated over own data only (round 4).
 *
 * ## The route this closes
 *
 * `JSON.stringify` looks `toJSON` up on the VALUE, which means through its
 * prototype chain. The materialized tree's objects are null-prototype and were
 * therefore already immune, but its ARRAYS deliberately keep `Array.prototype`
 * (dropping it would cost `Symbol.iterator` and every array method, so a
 * delivered payload array could no longer be spread, iterated or mapped), and
 * `Array.prototype`'s own chain reaches `Object.prototype`. Measured at
 * `04c7bc9`, on an ACCEPTED envelope — the verdict did not change, only the
 * bytes, which is worse:
 *
 * ```text
 * payload [1, 2]     clean                       …"payload":[1,2]}
 *                    Object.prototype.toJSON     …"payload":"INJECTED"}
 *                    Array.prototype.toJSON      …"payload":"INJECTED"}
 * payload {a: 1}     (control) unaffected — the record object has no prototype
 * ```
 *
 * The second route is `bigint`, and it flips the VERDICT. `SerializeJSONProperty`
 * looks `toJSON` up for a value of type Object **or BigInt**, and `GetV` on a
 * bigint primitive walks `BigInt.prototype` → `Object.prototype`:
 *
 * ```text
 * payload {amount: 1n}   clean                     typed refusal, "not JSON-representable"
 *                        Object.prototype.toJSON   ACCEPTED, …"payload":{"amount":"INJECTED"}}
 * ```
 *
 * Shadowing the hijack point with an own `toJSON` on each materialized array was
 * the cheaper fix and was REJECTED for two reasons: it leaves the bigint route
 * open, and it is consumer-visible — `readPlainData` (`@polymarket-bot/risk`),
 * which the trader's event door runs on exactly this record, refuses a non-index
 * own property on an array, so the shadowed record came back
 * `EVENT_NOT_DATA: event.payload.list.toJSON: a non-index property on an array
 * is not record data`. The serializer below changes nothing about the delivered
 * record, and the same trader probe on an ordinary decoded envelope with array
 * payloads still returns `ok: true`.
 *
 * ## What it must reproduce
 *
 * ECMA-262 25.5.2 with no replacer and no indent, on the value space the door
 * materializes (null-prototype objects, arrays, and primitives): `QuoteJSONString`
 * escaping including lone surrogates, `ToString(Number)`, `undefined` omitted in
 * an object but written as `null` in an array, and the typed refusal for
 * `bigint`. `envelope-wire-bytes.test.ts` asserts byte-identity against
 * `JSON.stringify` of the same materialized tree over a generated corpus, in a
 * clean environment, and identity of the result with and without an inherited
 * `toJSON` on `Object.prototype` and on `Array.prototype`.
 */
export function encodeWireJson(value: unknown): string {
  const encoded = serializeWireValue(value, 0);
  if (encoded === undefined) {
    // Unreachable through `encodeEnvelope`, whose argument is always the
    // materialized envelope record. `JSON.stringify` answers `undefined` here,
    // which a function returning `string` may not do.
    throw new NotWireData("the value has no JSON representation");
  }
  return encoded;
}

/** `\uXXXX`, lowercase, as `UnicodeEscape` specifies. */
function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * `QuoteJSONString` (ECMA-262 25.5.2.2), for keys and string values alike.
 *
 * A well-formed surrogate PAIR is one code point and is emitted raw; a LONE
 * surrogate is escaped (the ES2019 well-formed-`JSON.stringify` rule). Runs of
 * unescaped code units are copied with one `slice`, so the common case does no
 * per-character concatenation.
 */
function quoteWireString(value: string): string {
  let out = "\"";
  let plainFrom = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escape: string;
    if (code === 0x22) escape = "\\\"";
    else if (code === 0x5c) escape = "\\\\";
    else if (code === 0x08) escape = "\\b";
    else if (code === 0x09) escape = "\\t";
    else if (code === 0x0a) escape = "\\n";
    else if (code === 0x0c) escape = "\\f";
    else if (code === 0x0d) escape = "\\r";
    else if (code < 0x20) escape = unicodeEscape(code);
    else if (code >= 0xd800 && code <= 0xdfff) {
      if (code <= 0xdbff && index + 1 < value.length) {
        const trailing = value.charCodeAt(index + 1);
        if (trailing >= 0xdc00 && trailing <= 0xdfff) {
          index += 1;
          continue;
        }
      }
      escape = unicodeEscape(code);
    } else continue;
    out += value.slice(plainFrom, index) + escape;
    plainFrom = index + 1;
  }
  return `${out}${value.slice(plainFrom)}"`;
}

/** The own DATA value of one property, or absence. Never invokes an accessor. */
function ownWireMember(container: object, key: string): { present: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) {
    return { present: false, value: undefined };
  }
  if (!Object.hasOwn(descriptor, "value")) {
    // Unreachable on a materialized tree, which `copyMember` built from data
    // descriptors only; refused rather than read, so it stays unreachable.
    throw new NotWireData("an accessor property is code rather than envelope data");
  }
  return { present: true, value: descriptor.value };
}

/** `SerializeJSONProperty`: the text of one value, or `undefined` for "no text". */
function serializeWireValue(value: unknown, depth: number): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return undefined;
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // `String(number)` is `Number::toString`, a specification operation on
      // the value itself — no method lookup, so no prototype is consulted.
      // A non-finite number is `null`, exactly as `SerializeJSONNumber` says.
      return Number.isFinite(value) ? String(value) : "null";
    case "string":
      return quoteWireString(value);
    case "bigint":
      // The existing typed refusal (`encodeEnvelope` renders it); `JSON.stringify`
      // reaches the same outcome by throwing a `TypeError`, but only AFTER
      // consulting `Object.prototype.toJSON` through `BigInt.prototype`.
      throw new NotWireData("a bigint has no JSON representation");
    case "object":
      break;
    default:
      // `JSON.stringify` OMITS a function or a symbol; `copyMember` refuses one
      // before it can reach here, and dropping recorded data silently is what
      // §8.3 forbids, so this restates the refusal rather than the omission.
      throw new NotWireData("an envelope must contain data, not executable or symbolic values");
  }
  if (depth >= MAX_WIRE_DEPTH) {
    // The same bound and the same comparison as `copyMember`, so every tree the
    // door materializes is a tree this encoder can emit, and a cycle in a value
    // that never went through the door terminates here instead of recursing.
    throw new NotWireData(`nested deeper than ${String(MAX_WIRE_DEPTH)} levels`);
  }
  const container = value as object;
  return Array.isArray(container)
    ? serializeWireArray(container, depth)
    : serializeWireObject(container, depth);
}

/** `SerializeJSONObject`: own enumerable string keys in order; `undefined` omitted. */
function serializeWireObject(container: object, depth: number): string {
  let out = "";
  for (const key of Object.keys(container)) {
    const member = ownWireMember(container, key);
    if (!member.present) continue;
    const encoded = serializeWireValue(member.value, depth + 1);
    if (encoded === undefined) continue;
    if (out !== "") out += ",";
    out += `${quoteWireString(key)}:${encoded}`;
  }
  return `{${out}}`;
}

/** `SerializeJSONArray`: `length` elements; a hole or `undefined` is `null`. */
function serializeWireArray(container: unknown[], depth: number): string {
  const length = Object.getOwnPropertyDescriptor(container, "length")?.value as number;
  let out = "";
  for (let index = 0; index < length; index += 1) {
    const member = ownWireMember(container, String(index));
    const encoded = member.present ? serializeWireValue(member.value, depth + 1) : undefined;
    if (index > 0) out += ",";
    out += encoded ?? "null";
  }
  return `[${out}]`;
}

function ownMemberOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}

function definition(schema: unknown): unknown {
  return ownMemberOf(ownMemberOf(schema, "_zod"), "def");
}

export const ORDERING_FORMAT_KEYS = ["eventId", "receivedAt", "gatewayEpoch", "ingestSeq"] as const;
type OrderingFormatKey = typeof ORDERING_FORMAT_KEYS[number];

type Predicate = (value: unknown) => boolean;

function unsupported(): never {
  throw new Error("unsupported envelope schema definition; review the own-data derivation");
}

/**
 * String formats whose own `pattern` has been VERIFIED to be the validator zod
 * runs. Everything else fails the load — because it has not been verified, not
 * because it is necessarily replaced.
 *
 * MEASURED against the pinned zod@4.4.3 (review round 4 corrected an earlier,
 * over-broad statement of this):
 *
 * - `$ZodCheckStringFormat` (`v4/core/checks.js`) installs the pattern test as
 *   `inst._zod.check ??= …`, and `$ZodStringFormat` (`v4/core/schemas.js`) runs
 *   that initialization FIRST. A format constructor that wants its own
 *   validator therefore ASSIGNS `inst._zod.check = …` AFTERWARDS, overwriting
 *   the pattern test;
 * - `ipv6` and `cidrv6` do exactly that, and their patterns are then never
 *   consulted (zod's own source comments `regexes.cidrv6` "not used for
 *   validation"). `base64` replaces the check with `isValidBase64`, which does
 *   not consult `regexes.base64` either. For these three the pattern really is
 *   decorative;
 * - `base64url` also replaces the check, but its replacement `isValidBase64URL`
 *   DOES test `regexes.base64url` and then requires a valid base64 decode as
 *   well. Its pattern is consulted and is strictly WEAKER than the validator —
 *   which is precisely why deriving from it would be fail-open;
 * - `email` (`$ZodEmail`) sets `def.pattern` and adds NO replacement, so its
 *   pattern IS its validator. It is excluded all the same: the pinned schema
 *   uses no `email`, so nothing here has ever had to verify it, and a schema
 *   that started using one should re-enter this analysis rather than inherit a
 *   permission granted by a blanket claim.
 *
 * Deriving from a pattern that is not the validator would be fail-open, so any
 * format outside this allowlist fails the load.
 */
const DERIVABLE_STRING_FORMATS: readonly string[] = Object.freeze(["regex", "datetime"]);

/** All constraint parameters come from own definitions, never mirrored literals. */
function deriveField(schema: unknown): Predicate {
  const def = definition(schema);
  const type = ownMemberOf(def, "type");
  if (type === "optional") {
    // The wrapper's own checks are never read below, so `.optional().refine(…)`
    // would derive fail-open. Only a bare wrapper may be unwrapped.
    const wrapping = ownMemberOf(def, "checks");
    if (wrapping !== undefined && (!Array.isArray(wrapping) || wrapping.length > 0)) unsupported();
    const inner = deriveField(ownMemberOf(def, "innerType"));
    return value => value === undefined || inner(value);
  }
  // The derivation never coerces, so a coercing def would make it stricter than
  // the schema it claims to restate.
  const coerce = ownMemberOf(def, "coerce");
  if (coerce !== undefined && coerce !== false) unsupported();
  const predicates: Predicate[] = [];
  if (type === "string") predicates.push(value => typeof value === "string");
  else if (type === "number") predicates.push(value => typeof value === "number" && Number.isFinite(value));
  else if (type === "enum") {
    const entries = ownMemberOf(def, "entries");
    if (typeof entries !== "object" || entries === null) unsupported();
    const values = Object.keys(entries).map(key => ownMemberOf(entries, key));
    // A numeric native enum also carries reverse-mapping keys, whose values are
    // the member names; accepting those would widen the derived membership.
    if (values.some(value => typeof value !== "string")) unsupported();
    predicates.push(value => values.includes(value));
  } else if (type !== "unknown") unsupported();

  const definitions: unknown[] = [def];
  const checks = ownMemberOf(def, "checks");
  if (checks !== undefined && !Array.isArray(checks)) unsupported();
  if (Array.isArray(checks)) {
    for (const key of Object.keys(checks)) definitions.push(definition(ownMemberOf(checks, key)));
  }
  for (const entry of definitions) {
    const check = ownMemberOf(entry, "check");
    if (check === undefined && entry === def) continue;
    if (check === "string_format") {
      const format = ownMemberOf(entry, "format");
      if (typeof format !== "string" || !DERIVABLE_STRING_FORMATS.includes(format)) unsupported();
      const pattern = ownMemberOf(entry, "pattern");
      if (!(pattern instanceof RegExp)) unsupported();
      // `g`/`y` change what `test` matches, so dropping them to get a reusable
      // copy would be fail-open (`/abc/y` would start accepting "xabc").
      if (/[gy]/u.test(pattern.flags)) unsupported();
      const copy = new RegExp(pattern.source, pattern.flags);
      predicates.push(value => typeof value === "string" && copy.test(value));
    } else if (check === "min_length" || check === "max_length") {
      const bound = ownMemberOf(entry, check === "min_length" ? "minimum" : "maximum");
      if (typeof bound !== "number") unsupported();
      predicates.push(value => typeof value === "string" &&
        (check === "min_length" ? value.length >= bound : value.length <= bound));
    } else if (check === "greater_than" || check === "less_than") {
      const bound = ownMemberOf(entry, "value");
      const inclusive = ownMemberOf(entry, "inclusive");
      if (typeof bound !== "number" || typeof inclusive !== "boolean") unsupported();
      predicates.push(value => typeof value === "number" && (check === "greater_than"
        ? (inclusive ? value >= bound : value > bound)
        : (inclusive ? value <= bound : value < bound)));
    } else if (check === "number_format" && ownMemberOf(entry, "format") === "safeint") {
      // safeint carries the safe-integer bounds by format, not numeric literals.
      predicates.push(value => Number.isSafeInteger(value));
    } else unsupported();
  }
  return value => predicates.every(predicate => predicate(value));
}

const envelopeDefinition = definition(UnknownPayloadEventEnvelopeSchema);
const shape = ownMemberOf(envelopeDefinition, "shape");
if (typeof shape !== "object" || shape === null) unsupported();
export const ENVELOPE_FIELD_KEYS = Object.freeze(Object.keys(shape));
const fields = Object.create(null) as Record<string, Predicate>;
for (const key of ENVELOPE_FIELD_KEYS) fields[key] = deriveField(ownMemberOf(shape, key));
Object.freeze(fields);

// The pinned schema has exactly one superRefine: envelopeProvenanceRefinement.
// A changed refinement inventory requires explicit review, not silent omission.
const refinements = ownMemberOf(envelopeDefinition, "checks");
if (!Array.isArray(refinements) || refinements.length !== 1 ||
    ownMemberOf(definition(ownMemberOf(refinements, "0")), "check") !== "custom" ||
    ownMemberOf(definition(ownMemberOf(envelopeDefinition, "catchall")), "type") !== "never") unsupported();

export function matchesEnvelopeField(key: string, value: unknown): boolean {
  return Object.hasOwn(fields, key) && fields[key]!(value);
}

export function matchesOrderingFormat(key: OrderingFormatKey, value: unknown): boolean {
  return matchesEnvelopeField(key, value);
}

/**
 * Exact restatement of the schema's sole refinement, on materialized data.
 *
 * KNOWN, DISCLOSED, FAIL-CLOSED RESIDUAL (review round 4; deliberately NOT
 * fixed here). For an ARRAY payload, an inherited `Object.prototype.venue =
 * "binance"` flips `validateEnvelope` from accept to a typed refusal: zod's
 * provenance refinement reads `payload.venue` through the array's retained
 * `Array.prototype` → `Object.prototype` chain, and it runs BEFORE this own-data
 * restatement gets a verdict of its own. The direction is safe — an honest
 * envelope is REFUSED, never a wrong value accepted — the refinement lives in a
 * frozen schema this package may not edit, and the only clean fix, giving the
 * materialized arrays a null prototype, would take `Symbol.iterator` and every
 * array method away from a delivered payload array. It is carried as an owned
 * residual rather than closed. This restatement itself reads own data only, so
 * it never reproduces the flip.
 */
export function matchesEnvelopeProvenance(own: Readonly<Record<string, unknown>>): boolean {
  const venue = ownMemberOf(ownMemberOf(own, "payload"), "venue");
  return venue === undefined || (typeof venue === "string" && venue === ownMemberOf(own, "source"));
}

export function enforceEnvelopeConstraints(own: Readonly<Record<string, unknown>>): void {
  for (const key of ENVELOPE_FIELD_KEYS) {
    if (!matchesEnvelopeField(key, ownMemberOf(own, key))) {
      throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
        issues: [{ path: key, message: "the own field does not match its schema constraints" }],
      });
    }
  }
  // DELIBERATE, SANCTIONED TIGHTENING — do not "fix" this back to the schema's
  // verdict. zod's strict-object unknown-key scan skips a top-level own
  // `__proto__` member (`handleCatchall`: `if (key === "__proto__") continue`),
  // so the schema ACCEPTS a wire envelope carrying `"__proto__": …` and silently
  // drops it. Silent dropping on the recording path is exactly what §8.3
  // forbids, so this restatement — the only layer that still sees the member —
  // refuses it. Pinned by envelope-data-refusals.test.ts.
  if (Object.keys(own).some(key => !Object.hasOwn(fields, key)) || !matchesEnvelopeProvenance(own)) {
    throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
      issues: [{ path: "", message: "the own envelope does not match its schema constraints" }],
    });
  }
}
