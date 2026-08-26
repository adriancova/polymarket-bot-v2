/**
 * Deterministic canonical hashing of decimal values — handoff §7.3
 * ("normalize redundant leading/trailing zeros before hashing").
 *
 * The hash is a pure computation over the canonical string form:
 *
 * ```text
 * value → normalizeDecimalString(value) → domain-separated preimage → SHA-256 hex
 * ```
 *
 * Consequences that the property tests pin down:
 *
 * - Every spelling of the same number (`"1.5"`, `"1.50"`, `"01.5"`, `"+1.5"`)
 *   produces the same hash, because they normalize to the same canonical string.
 * - `"0"`, `"-0"`, `"0.000"` and `"+0"` all hash as canonical zero `"0"`.
 * - Different numbers never share a hash (SHA-256 preimages differ).
 *
 * `node:crypto` is used for SHA-256. It is a pure, synchronous computation with
 * no I/O, which is why this package (a leaf of the dependency graph) may use it;
 * `@polymarket-bot/domain` still imports no Node built-ins at all.
 */

import { createHash } from "node:crypto";

import {
  normalizeDecimalString,
  type DecimalString,
  type DecimalStringConstraints,
} from "./canonical.js";

/**
 * Domain-separation tag mixed into every decimal hash preimage.
 *
 * Prevents a decimal hash from ever colliding with a hash computed over some
 * other kind of payload that happens to serialize to the same characters. The
 * trailing version segment must be bumped (with an ADR) if the preimage format
 * ever changes, because persisted hashes would otherwise silently change
 * meaning.
 */
export const CANONICAL_DECIMAL_HASH_DOMAIN = "polymarket-bot/decimal/v1";

/** Exact bytes that are hashed. Exposed so tests and audits can reproduce a hash by hand. */
export function canonicalDecimalPreimage(
  value: unknown,
  constraints?: DecimalStringConstraints,
): string {
  const canonical: DecimalString = normalizeDecimalString(
    value,
    constraints,
    "canonicalDecimalPreimage(value)",
  );
  return `${CANONICAL_DECIMAL_HASH_DOMAIN}:${canonical}`;
}

/**
 * Deterministic SHA-256 (lowercase hex) of a decimal value's canonical form.
 *
 * Accepts non-canonical spellings and normalizes them first, so the hash is a
 * function of the numeric value rather than of its formatting.
 */
export function canonicalDecimalHash(
  value: unknown,
  constraints?: DecimalStringConstraints,
): string {
  return createHash("sha256").update(canonicalDecimalPreimage(value, constraints), "utf8").digest("hex");
}
