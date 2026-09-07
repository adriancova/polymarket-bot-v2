/**
 * Own-data boundary (ADR-020), following polymarket-public's wire-door.
 * D1/D3/D4: copy own enumerable data in key order, judge the copy, emit it frozen.
 * D2's shared arena is not importable on this package's dependency edges. The
 * measured ordering formats are therefore re-derived from the frozen schema;
 * other library checks/refinements remain library-dependent under ambient
 * control-field pollution. Containment covers parsing AND refusal rendering.
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

/** Pattern and length bounds come ONLY from the schema's own definitions. */
function deriveFormat(schema: unknown): (value: unknown) => boolean {
  const def = definition(schema);
  const checks = ownMemberOf(def, "checks");
  const definitions: unknown[] = [def];
  if (Array.isArray(checks)) {
    for (const key of Object.keys(checks)) {
      definitions.push(definition(ownMemberOf(checks, key)));
    }
  }
  const patterns: RegExp[] = [];
  let minimum = 0;
  let maximum = Infinity;
  for (const entry of definitions) {
    const pattern = ownMemberOf(entry, "pattern");
    if (pattern instanceof RegExp) {
      patterns.push(new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, "")));
    }
    const check = ownMemberOf(entry, "check");
    const min = ownMemberOf(entry, "minimum");
    const max = ownMemberOf(entry, "maximum");
    if (check === "min_length" && typeof min === "number") minimum = min;
    if (check === "max_length" && typeof max === "number") maximum = max;
  }
  // A moved library definition fails closed; the differential test pins that
  // each grammar is derivable, with non-vacuous positive and negative cases.
  return (value) => typeof value === "string" && patterns.length > 0 &&
    value.length >= minimum && value.length <= maximum &&
    patterns.every((pattern) => pattern.test(value));
}

const formats = Object.create(null) as Record<OrderingFormatKey, (value: unknown) => boolean>;
for (const key of ORDERING_FORMAT_KEYS) {
  formats[key] = deriveFormat(ownMemberOf(UnknownPayloadEventEnvelopeSchema.shape, key));
}

export function matchesOrderingFormat(key: OrderingFormatKey, value: unknown): boolean {
  return formats[key](value);
}
