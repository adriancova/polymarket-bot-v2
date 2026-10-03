/**
 * Input readers for `@polymarket-bot/inventory`.
 *
 * Caller data is read by OWN DATA PROPERTY only: an inherited property, an
 * accessor or a non-object is "absent", never a value (the ADR-020 lesson: a
 * field that is not the caller's own data is not the caller's data). Every
 * accepted value is copied out as a primitive at the door, so a caller that
 * mutates its object afterwards cannot change what was validated.
 *
 * Amounts are canonical decimal strings (§6 invariant 1; ADR-001). A `number`
 * is never an amount.
 *
 * EVIDENCE IS READ ONCE (WP300B-R1-01, WP300B-R1-02; WP-300c). Evidence about a
 * wallet operation (an observation, a reconciliation answer, the executor's
 * answer) is read field by field with {@link readField}, ONCE, at the door,
 * and every decision is taken on that snapshot: a Proxy whose traps answer
 * differently on a second read never gets one. A field that is present but is
 * not the caller's own data (an accessor, an inherited property, or one whose
 * read throws) is not "absent" there: it is OPAQUE, and the manager reads the
 * evidence carrying it as unrecognised (fail closed), never as evidence that
 * names nothing. (Plans and other inputs keep the "absent" reading above.)
 */

import { compareDecimal, isCanonicalDecimalString, type DecimalString } from "@polymarket-bot/decimal";

/** Own enumerable-or-not DATA property, or `undefined`. Never runs a getter. */
export function ownData(source: unknown, key: string): unknown {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * One field of caller evidence, as it read at the door:
 * - `ABSENT`: no own property, and none inherited (or the source is not an
 *   object);
 * - `DATA`: an own data property, enumerable or not; its value, copied out;
 * - `OPAQUE`: present, but not the caller's own data — an accessor (its getter
 *   is never run), an inherited property, or a property whose read threw (a
 *   hostile Proxy trap, a revoked Proxy). It has no value.
 */
export type FieldRead =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "DATA"; readonly value: unknown }
  | { readonly kind: "OPAQUE"; readonly why: "accessor" | "inherited" | "unreadable" };

const ABSENT: FieldRead = Object.freeze({ kind: "ABSENT" });

/**
 * Read one field of caller evidence, exactly once (see the header, "EVIDENCE
 * IS READ ONCE"): one `[[GetOwnProperty]]` (a Proxy's `getOwnPropertyDescriptor`
 * trap) and, only when there is no own property, one `[[HasProperty]]` (its
 * `has` trap) to tell an inherited property from an absent one. It never runs
 * a getter and never throws: a read that throws is OPAQUE. Callers read each
 * field once and decide on the result, never on the source again.
 */
export function readField(source: unknown, key: string): FieldRead {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) return ABSENT;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    return Object.freeze({ kind: "OPAQUE", why: "unreadable" });
  }
  if (descriptor !== undefined) {
    // A descriptor returned by Object.getOwnPropertyDescriptor is a fresh ordinary object: reading it is stable.
    return "value" in descriptor
      ? Object.freeze({ kind: "DATA", value: descriptor.value })
      : Object.freeze({ kind: "OPAQUE", why: "accessor" });
  }
  let inherited: boolean;
  try {
    inherited = key in source;
  } catch {
    return Object.freeze({ kind: "OPAQUE", why: "unreadable" });
  }
  return inherited ? Object.freeze({ kind: "OPAQUE", why: "inherited" }) : ABSENT;
}

/**
 * The longest identifier (reservation, pending, hold, holder, account, asset
 * or operation id) this package accepts. Derived identifiers are checked
 * against the same bound before anything depends on them (WP300-R2-03).
 */
export const MAX_IDENTIFIER_LENGTH = 512;

/** A non-empty string no longer than {@link MAX_IDENTIFIER_LENGTH}. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

/** A non-empty string own data property, or `undefined`. */
export function ownNonEmptyString(source: unknown, key: string): string | undefined {
  const value = ownData(source, key);
  return isIdentifier(value) ? value : undefined;
}

/** A canonical, strictly positive decimal string own data property, or `undefined`. */
export function ownPositiveAmount(source: unknown, key: string): DecimalString | undefined {
  const value = ownData(source, key);
  return isPositiveAmount(value) ? value : undefined;
}

/** A canonical, non-negative decimal string own data property, or `undefined`. */
export function ownNonNegativeAmount(source: unknown, key: string): DecimalString | undefined {
  const value = ownData(source, key);
  return isCanonicalDecimalString(value, { range: "NON_NEGATIVE" }) ? value : undefined;
}

export function isPositiveAmount(value: unknown): value is DecimalString {
  return isCanonicalDecimalString(value, { range: "POSITIVE" });
}

/** `a >= b` over canonical decimal strings. */
export function atLeast(a: DecimalString, b: DecimalString): boolean {
  return compareDecimal(a, b) >= 0;
}

/**
 * A collision-free composite map key: each part is length-prefixed, so no
 * choice of separator characters inside a part can make two different tuples
 * produce the same key. Deliberately not `JSON.stringify` (SER-0: an inherited
 * `toJSON` can collapse keys).
 */
export function compositeKey(...parts: readonly string[]): string {
  let key = "";
  for (const part of parts) key += `${part.length}:${part};`;
  return key;
}
