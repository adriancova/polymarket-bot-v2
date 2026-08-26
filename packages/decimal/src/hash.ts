/**
 * Deterministic canonical hashing of decimal values — handoff §7.3
 * ("normalize redundant leading/trailing zeros before hashing").
 *
 * The hash is a pure computation over the canonical string form:
 *
 * ```text
 * value → normalizeHashableDecimalString(value) → domain-separated preimage → SHA-256 hex
 * ```
 *
 * ## Hash-input grammar
 *
 * Hashing uses its OWN input grammar
 * ({@link normalizeHashableDecimalString}), not the lenient venue-input
 * normalizer. §7.3 sanctions exactly one relaxation before hashing —
 * "normalize redundant leading/trailing zeros" — while its other prohibitions
 * are unconditional. So the hash accepts:
 *
 * - the canonical form (`"1.5"`, `"0"`, `"-1.23"`);
 * - redundant leading zeros (`"01.5"`, `"000123"`);
 * - trailing fractional zeros (`"1.50"`, `"1.500000"`);
 * - signed and padded zero (`"-0"`, `"0.0"`, `"-0.000"`);
 *
 * and rejects every §7.3-forbidden form:
 *
 * - a leading `+` (`"+1.5"`, `"+0"`);
 * - a trailing decimal point (`"1."`);
 * - an omitted integer part (`".5"`, `"-.5"`);
 * - scientific notation (`"1e5"`, `"1E-5"`);
 * - any non-string, including a JavaScript `number`.
 *
 * Venue wire values that use a forbidden spelling must be canonicalized
 * explicitly, in the adapter that owns the wire format, with
 * `normalizeDecimalString` — the hashing path never does it silently.
 *
 * ## Consequences the tests pin down
 *
 * - Every *accepted* spelling of the same number (`"1.5"`, `"1.50"`, `"01.5"`)
 *   produces the same digest, because they normalize to the same canonical
 *   string.
 * - `"0"`, `"-0"`, and `"0.000"` all hash as canonical zero `"0"`.
 * - Distinct canonical values produce distinct digests in every sampled case.
 *   SHA-256 is collision-*resistant*, not collision-free: no test can prove the
 *   absence of collisions, and the property test provides sampled evidence
 *   rather than a proof.
 *
 * `node:crypto` is used for SHA-256. It is a pure, synchronous computation with
 * no I/O, which is why this package (a leaf of the dependency graph) may use it;
 * `@polymarket-bot/domain` still imports no Node built-ins at all.
 */

import { createHash } from "node:crypto";

import {
  normalizeHashableDecimalString,
  type DecimalString,
  type DecimalStringConstraints,
} from "./canonical.js";

/**
 * Domain-separation tag mixed into every decimal hash preimage.
 *
 * Makes it computationally infeasible for a decimal digest to coincide with a
 * digest computed over some other kind of payload that happens to serialize to
 * the same characters. The trailing version segment must be bumped (with an
 * ADR) if the preimage format or the hash-input grammar ever changes, because
 * persisted hashes would otherwise silently change meaning.
 */
export const CANONICAL_DECIMAL_HASH_DOMAIN = "polymarket-bot/decimal/v1";

/**
 * Exact bytes that are hashed. Exposed so tests and audits can reproduce a hash
 * by hand:
 *
 * ```text
 * printf 'polymarket-bot/decimal/v1:1.5' | sha256sum
 * ```
 *
 * @throws {InvalidDecimalStringError} when `value` is not a legal hash input.
 * @throws {DecimalRangeError} when the normalized value violates `constraints`.
 */
export function canonicalDecimalPreimage(
  value: unknown,
  constraints?: DecimalStringConstraints,
): string {
  const canonical: DecimalString = normalizeHashableDecimalString(
    value,
    constraints,
    "canonicalDecimalPreimage(value)",
  );
  return `${CANONICAL_DECIMAL_HASH_DOMAIN}:${canonical}`;
}

/**
 * Deterministic SHA-256 (lowercase hex) of a decimal value's canonical form.
 *
 * Normalizes redundant leading/trailing zeros and signed zero first, so the
 * digest is a function of the numeric value rather than of that formatting. It
 * does NOT accept the spellings §7.3 forbids — see the module header.
 */
export function canonicalDecimalHash(
  value: unknown,
  constraints?: DecimalStringConstraints,
): string {
  return createHash("sha256").update(canonicalDecimalPreimage(value, constraints), "utf8").digest("hex");
}
