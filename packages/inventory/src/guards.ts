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
