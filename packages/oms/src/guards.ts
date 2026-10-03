/**
 * Input readers for `@polymarket-bot/oms`.
 *
 * EVERY FOREIGN VALUE IS READ ONCE, AT THE DOOR (the WP-300b lesson). Caller
 * input, port answers and venue evidence are read field by field with
 * {@link readField}: one own-property read per field, never a getter, never an
 * inherited property, and nothing thrown escapes. Each accepted value is copied
 * out as a primitive (or a frozen plain copy), and every decision is taken on
 * that copy. A field that is present but is not the source's own data (an
 * accessor, an inherited property, a read that throws) is OPAQUE: evidence
 * carrying one is unrecognised and handled fail-closed, never as "absent".
 *
 * Amounts are canonical decimal strings (§6 invariant 1; ADR-001). A `number`
 * is never an amount.
 */

import { isCanonicalDecimalString, type DecimalString } from "@polymarket-bot/decimal";

export type FieldRead =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "DATA"; readonly value: unknown }
  | { readonly kind: "OPAQUE" };

const ABSENT: FieldRead = Object.freeze({ kind: "ABSENT" });
const OPAQUE: FieldRead = Object.freeze({ kind: "OPAQUE" });

/** One field, read exactly once. Never runs a getter; never throws. */
export function readField(source: unknown, key: string): FieldRead {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) return ABSENT;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    return OPAQUE;
  }
  if (descriptor !== undefined) {
    return "value" in descriptor ? Object.freeze({ kind: "DATA", value: descriptor.value }) : OPAQUE;
  }
  let inherited: boolean;
  try {
    inherited = key in source;
  } catch {
    return OPAQUE;
  }
  return inherited ? OPAQUE : ABSENT;
}

/** The value of an own data field, or `undefined` for ABSENT and OPAQUE alike (plain inputs only). */
export function ownData(source: unknown, key: string): unknown {
  const read = readField(source, key);
  return read.kind === "DATA" ? read.value : undefined;
}

/**
 * Read a set of fields once. `undefined` when any field is OPAQUE; an ABSENT
 * field reads as `undefined` in the record. Used for evidence, where an opaque
 * field makes the whole record unrecognised.
 */
export function readFields<K extends string>(source: unknown, keys: readonly K[]): Readonly<Record<K, unknown>> | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const out = {} as Record<K, unknown>;
  for (const key of keys) {
    const read = readField(source, key);
    if (read.kind === "OPAQUE") return undefined;
    out[key] = read.kind === "DATA" ? read.value : undefined;
  }
  return Object.freeze(out);
}

/**
 * Copy an array's entries from own DATA properties, once, index by index. No
 * method of the foreign array (an iterator, `map`, a species constructor) runs.
 * `undefined` for a non-array, a length outside `0..max`, a hole, an accessor
 * entry or any reflection failure.
 */
export function readArray(value: unknown, max: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthRead = readField(value, "length");
    if (lengthRead.kind !== "DATA") return undefined;
    const length = lengthRead.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > max) return undefined;
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = readField(value, String(index));
      if (entry.kind !== "DATA") return undefined;
      out.push(entry.value);
    }
    return Object.freeze(out);
  } catch {
    return undefined;
  }
}

/** The database `internal.identifier` domain: 1..200 characters (migration 0001). */
export const MAX_IDENTIFIER_LENGTH = 200;

/** A non-empty string of at most {@link MAX_IDENTIFIER_LENGTH} characters, with no control character. */
export function isIdentifier(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** The database `internal.code` domain (migration 0001). */
const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;

export function isCode(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value);
}

/** The database `internal.uuid_v7` domain: version nibble 7, variant 8/9/a/b (migration 0001). */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

/** The database `internal.token_id` domain: a canonical unsigned decimal integer string, at most 200 characters. */
const TOKEN_ID = /^(?:0|[1-9][0-9]{0,199})$/u;

export function isTokenId(value: unknown): value is string {
  return typeof value === "string" && TOKEN_ID.test(value);
}

export function isPositiveAmount(value: unknown): value is DecimalString {
  return isCanonicalDecimalString(value, { range: "POSITIVE" });
}

export function isNonNegativeAmount(value: unknown): value is DecimalString {
  return isCanonicalDecimalString(value, { range: "NON_NEGATIVE" });
}

/** A limit price strictly between 0 and 1 (a probability price; the secure adapter refuses 0 and 1 too). */
export function isOpenUnitPrice(value: unknown): value is DecimalString {
  return typeof value === "string" && /^0\.[0-9]*[1-9]$/u.test(value) && isCanonicalDecimalString(value, { range: "UNIT_INTERVAL" });
}

/** A fill price in the closed unit interval (a venue fact about a trade, validated against the limit separately). */
export function isUnitPrice(value: unknown): value is DecimalString {
  return isCanonicalDecimalString(value, { range: "UNIT_INTERVAL" });
}

/**
 * A collision-free composite key: each part is length-prefixed, so no choice
 * of characters inside a part can make two different tuples collide. Never
 * `JSON.stringify` (SER-0: an inherited `toJSON` can collapse keys).
 */
export function compositeKey(...parts: readonly string[]): string {
  let key = "";
  for (const part of parts) key += `${String(part.length)}:${part};`;
  return key;
}

/**
 * A canonical JSON rendering of a flat record of strings, finite numbers and
 * booleans: own data keys only, sorted, no `toJSON`, no inherited key. Returns
 * `undefined` for anything else. Used to hand the signed payload to the cipher
 * byte-stably and to compare a decrypted payload with the original.
 */
export function canonicalFlatJson(record: unknown): string | undefined {
  try {
    if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
    const prototype: unknown = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== "string") return undefined;
      keys.push(key);
    }
    keys.sort();
    let out = "{";
    let first = true;
    for (const key of keys) {
      const read = readField(record, key);
      if (read.kind !== "DATA") return undefined;
      const value = read.value;
      let rendered: string;
      if (typeof value === "string") rendered = quote(value);
      else if (typeof value === "boolean") rendered = value ? "true" : "false";
      else if (typeof value === "number" && Number.isFinite(value)) rendered = String(value);
      else return undefined;
      out += `${first ? "" : ","}${quote(key)}:${rendered}`;
      first = false;
    }
    return `${out}}`;
  } catch {
    return undefined;
  }
}

/** A JSON string literal, built without `JSON.stringify` (no prototype lookup can intervene). */
function quote(text: string): string {
  let out = '"';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += character;
  }
  return `${out}"`;
}

/**
 * Parse a flat JSON object of strings, finite numbers and booleans (the shape
 * {@link canonicalFlatJson} produces). `JSON.parse` defines own data
 * properties only (a `"__proto__"` key stays an own key) and is given no
 * reviver; the result is then checked to be flat. Anything else is `undefined`.
 */
export function parseFlatJson(text: unknown): Readonly<Record<string, string | number | boolean>> | undefined {
  if (typeof text !== "string" || text.length > 1_000_000) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const plain: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(parsed)) {
    const read = readField(parsed, key);
    if (read.kind !== "DATA") return undefined;
    const value = read.value;
    if (typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
      return undefined;
    }
    Object.defineProperty(plain, key, { value, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(plain);
}
