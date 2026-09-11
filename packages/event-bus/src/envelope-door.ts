/**
 * Own-data boundary (ADR-020), following polymarket-public's wire-door.
 * D1/D3/D4: copy own enumerable data in key order, judge the copy, emit it frozen.
 * D2's shared arena is not importable on this package's dependency edges. The
 * field constraints are therefore re-derived from the frozen schema, and its
 * provenance refinement is enforced on own data independently of parse flags.
 * Containment covers parsing AND refusal rendering.
 * Arrays retain Array.prototype, as in the reference door (a separate class).
 */
import { UnknownPayloadEventEnvelopeSchema } from "@polymarket-bot/domain";

import { EventBusEnvelopeError } from "./errors.js";

export const MAX_WIRE_DEPTH = 16;

class NotWireData extends Error {}

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
    throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
      issues: [{ path: "", message: error instanceof NotWireData
        ? error.message : "reading the envelope as own data failed" }],
    });
  }
}

/** Local equivalent of the reference door's containedJudgement; no new edge. */
export function containedJudgement<T>(judge: () => T): T {
  try {
    return judge();
  } catch (error) {
    if (error instanceof EventBusEnvelopeError) {
      throw error;
    }
    throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
      issues: [{ path: "", message: "the schema could not judge this value (its refusal could not be constructed)" }],
    });
  }
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
 * String formats whose own `pattern` IS the validator zod runs.
 *
 * `$ZodCheckStringFormat` only installs the pattern test when no constructor
 * replaced `_zod.check` first; `ipv6`, `cidrv6`, `base64` and `base64url` do
 * replace it, leaving `pattern` decorative. Deriving from a decorative pattern
 * would be fail-open, so any format outside this allowlist fails the load.
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

/** Exact restatement of the schema's sole refinement, on materialized data. */
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
