/**
 * Canonical decimal strings — handoff §7.3.
 *
 * Every economic value (price, size, fee, balance, PnL) crosses an API or
 * persistence boundary as a *canonical decimal string*. JavaScript `number` is
 * never used, so no binary floating point can enter the system through this
 * module: all canonicalization below is pure string manipulation.
 *
 * Canonical grammar (the ONLY form accepted at a boundary):
 *
 * ```text
 * canonical    := "-"? integerPart ( "." fractionPart )?
 * integerPart  := "0" | [1-9] [0-9]*
 * fractionPart := [0-9]* [1-9]
 * ```
 *
 * with the extra rule that canonical zero is exactly `"0"` (never `"-0"`).
 *
 * This encodes handoff §7.3 literally:
 *
 * - No scientific notation (`"1e5"` is rejected).
 * - No leading `+` (`"+1"` is rejected).
 * - Canonical zero is `"0"` (`"-0"`, `"0.0"`, `"00"` are rejected).
 * - No trailing decimal point (`"1."` is rejected).
 * - Redundant leading/trailing zeros are normalized away before hashing
 *   (`"01.50"` is rejected at the boundary and normalizes to `"1.5"`).
 * - Price is constrained to `[0, 1]` where the context requires it.
 *
 * STRICT BOUNDARY DECISION (WP-020, documented in `docs/contracts/domain.md`):
 * schemas accept ONLY the canonical form. Venue payloads that use a legal but
 * non-canonical spelling (`"+1.5"`, `"1.50"`, `"01.5"`, `"-0"`) must be passed
 * through {@link normalizeDecimalString} inside the adapter that owns the venue
 * wire format, before a domain contract ever sees them. This keeps exactly one
 * representation of a value inside the system, so equality, map keys, database
 * uniqueness, and canonical hashes all agree.
 *
 * THREE GRAMMARS, DELIBERATELY DISTINCT:
 *
 * | Grammar | Entry point | Accepts |
 * | --- | --- | --- |
 * | canonical | {@link assertCanonicalDecimalString} | the canonical form only |
 * | hash input | {@link normalizeHashableDecimalString} | canonical + redundant leading/trailing zeros + signed zero |
 * | venue input | {@link normalizeDecimalString} | the above plus `"+1.5"`, `"1."`, `".5"` |
 *
 * The hash-input grammar exists because §7.3 sanctions exactly one relaxation
 * before hashing ("normalize redundant leading/trailing zeros"); the leading-`+`
 * and trailing-decimal-point prohibitions are unconditional and must therefore
 * hold on the hashing path too. Only `normalizeDecimalString`, which is scoped
 * to adapter wire formats, may be more permissive.
 */

import {
  DecimalRangeError,
  InvalidDecimalStringError,
  type DecimalErrorCode,
} from "./errors.js";

/** A decimal number in canonical string form. Never a JavaScript `number`. */
export type DecimalString = string;

/**
 * Contextual range constraint applied after the canonical form is verified.
 *
 * `UNIT_INTERVAL` implements the §7.3 rule "price must be in `[0, 1]` where
 * context requires".
 */
export type DecimalRange = "ANY" | "NON_NEGATIVE" | "POSITIVE" | "UNIT_INTERVAL";

export interface DecimalStringConstraints {
  /** Defaults to `"ANY"`. */
  readonly range?: DecimalRange;
}

/**
 * Hard upper bound on the length of an accepted decimal string.
 *
 * Purely a pathological-input guard for a process that parses untrusted venue
 * frames; every real economic value in this system is far shorter (a USDC
 * amount with 6 decimals and 15 integer digits is 22 characters). Breaching it
 * raises a typed error — it never silently truncates or rounds.
 */
export const MAX_DECIMAL_STRING_LENGTH = 1024;

/** Canonical form, as documented in the module header. `"-0"` is excluded separately. */
const CANONICAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

/**
 * Lenient input form accepted by {@link normalizeDecimalString} only.
 *
 * Allows a leading `+`, redundant leading zeros, trailing fractional zeros, an
 * omitted integer part (`".5"`), and an empty fraction after the point (`"1."`).
 * It still rejects scientific notation, whitespace, and anything that is not a
 * plain decimal numeral.
 */
const LENIENT_PATTERN = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;

/**
 * Hash-input form — the ONLY spellings {@link normalizeHashableDecimalString}
 * (and therefore the canonical hash) accepts.
 *
 * §7.3 permits exactly one relaxation before hashing: "normalize redundant
 * leading/trailing zeros before hashing". Every other §7.3 prohibition is
 * unconditional and applies to hash input as much as to a boundary value, so
 * this grammar allows redundant leading zeros (`"01.5"`), trailing fractional
 * zeros (`"1.50"`), and signed zero (`"-0.000"`), and REJECTS:
 *
 * - a leading `+` (`"+1.5"`) — §7.3 "no leading `+`";
 * - a trailing decimal point (`"1."`) — §7.3 "no trailing decimal point";
 * - an omitted integer part (`".5"`) — not a §7.3 form at all;
 * - scientific notation (`"1e5"`) — §7.3 "no scientific notation";
 * - anything that is not a string.
 *
 * This is deliberately NARROWER than {@link normalizeDecimalString}, which is
 * the venue-input normalizer and may accept spellings a venue actually emits.
 * A hash is a persisted, load-bearing identity; silently accepting a spelling
 * §7.3 forbids would make the forbidden form reachable through the hashing path.
 */
const HASH_INPUT_PATTERN = /^-?[0-9]+(?:\.[0-9]+)?$/u;

interface DecimalProblem {
  readonly code: DecimalErrorCode;
  readonly message: string;
}

function problem(code: DecimalErrorCode, message: string): DecimalProblem {
  return { code, message };
}

function describeShape(value: unknown): DecimalProblem | null {
  if (typeof value !== "string") {
    return problem(
      "DECIMAL_NOT_A_STRING",
      `expected a canonical decimal string, received ${typeof value} (economic values must never be JavaScript numbers)`,
    );
  }
  if (value.length === 0) {
    return problem("DECIMAL_EMPTY", "expected a canonical decimal string, received an empty string");
  }
  if (value.length > MAX_DECIMAL_STRING_LENGTH) {
    return problem(
      "DECIMAL_TOO_LONG",
      `decimal string exceeds the maximum accepted length of ${String(MAX_DECIMAL_STRING_LENGTH)} characters`,
    );
  }
  if (/[eE]/.test(value)) {
    return problem(
      "DECIMAL_SCIENTIFIC_NOTATION",
      `scientific notation is not accepted: "${value}"`,
    );
  }
  return null;
}

/** Splits a canonical (or already-validated lenient) numeral into its parts. */
function split(value: string): { sign: "" | "-"; integer: string; fraction: string } {
  const negative = value.startsWith("-");
  const signless = negative || value.startsWith("+") ? value.slice(1) : value;
  const point = signless.indexOf(".");
  if (point < 0) {
    return { sign: negative ? "-" : "", integer: signless, fraction: "" };
  }
  return {
    sign: negative ? "-" : "",
    integer: signless.slice(0, point),
    fraction: signless.slice(point + 1),
  };
}

function describeRange(
  canonical: string,
  constraints: DecimalStringConstraints | undefined,
): DecimalProblem | null {
  const range = constraints?.range ?? "ANY";
  if (range === "ANY") {
    return null;
  }
  const negative = canonical.startsWith("-");
  const isZero = canonical === "0";

  if (range === "NON_NEGATIVE" && negative) {
    return problem("DECIMAL_OUT_OF_RANGE", `expected a value >= 0, received "${canonical}"`);
  }
  if (range === "POSITIVE" && (negative || isZero)) {
    return problem("DECIMAL_OUT_OF_RANGE", `expected a value > 0, received "${canonical}"`);
  }
  if (range === "UNIT_INTERVAL") {
    if (negative) {
      return problem(
        "DECIMAL_OUT_OF_RANGE",
        `expected a value in [0, 1], received "${canonical}"`,
      );
    }
    // On a canonical non-negative numeral the integer part is already free of
    // redundant leading zeros, so `x <= 1` iff the integer part is "0" or the
    // whole value is exactly "1". No arithmetic (and therefore no rounding) is
    // required to decide this.
    const { integer } = split(canonical);
    if (integer !== "0" && canonical !== "1") {
      return problem(
        "DECIMAL_OUT_OF_RANGE",
        `expected a value in [0, 1], received "${canonical}"`,
      );
    }
  }
  return null;
}

function describeCanonical(
  value: unknown,
  constraints: DecimalStringConstraints | undefined,
): DecimalProblem | null {
  const shape = describeShape(value);
  if (shape !== null) {
    return shape;
  }
  const text = value as string;
  if (text.startsWith("+")) {
    return problem("DECIMAL_LEADING_PLUS", `a leading "+" is not accepted: "${text}"`);
  }
  if (!CANONICAL_PATTERN.test(text)) {
    return problem(
      "DECIMAL_NOT_CANONICAL",
      `"${text}" is not a canonical decimal string (canonical form has no leading zeros, no trailing fractional zeros, and no trailing decimal point)`,
    );
  }
  if (text === "-0") {
    return problem("DECIMAL_NOT_CANONICAL", 'canonical zero is "0", not "-0"');
  }
  return describeRange(text, constraints);
}

/**
 * Returns `null` when `value` is a canonical decimal string satisfying
 * `constraints`, otherwise a human-readable explanation.
 *
 * Used by the Zod boundary schemas in `@polymarket-bot/domain` so that schema
 * validation and direct validation cannot drift apart.
 */
export function explainCanonicalDecimalString(
  value: unknown,
  constraints?: DecimalStringConstraints,
): string | null {
  return describeCanonical(value, constraints)?.message ?? null;
}

/** Strict boundary predicate: true only for the canonical form. */
export function isCanonicalDecimalString(
  value: unknown,
  constraints?: DecimalStringConstraints,
): value is DecimalString {
  return describeCanonical(value, constraints) === null;
}

/**
 * Strict boundary assertion.
 *
 * @throws {InvalidDecimalStringError} when the value is not canonical.
 * @throws {DecimalRangeError} when the value is canonical but out of range.
 */
export function assertCanonicalDecimalString(
  value: unknown,
  constraints?: DecimalStringConstraints,
  label = "value",
): DecimalString {
  const found = describeCanonical(value, constraints);
  if (found === null) {
    return value as DecimalString;
  }
  const message = `${label}: ${found.message}`;
  throw found.code === "DECIMAL_OUT_OF_RANGE"
    ? new DecimalRangeError(found.code, message)
    : new InvalidDecimalStringError(found.code, message);
}

function canonicalizeParts(sign: "" | "-", integerRaw: string, fractionRaw: string): string {
  const integer = integerRaw.replace(/^0+(?=[0-9])/, "");
  const fraction = fractionRaw.replace(/0+$/, "");
  const normalizedInteger = integer.length === 0 ? "0" : integer;
  if (normalizedInteger === "0" && fraction.length === 0) {
    // Canonical zero drops the sign: "-0", "-0.000", and "0" are one value.
    return "0";
  }
  return fraction.length === 0
    ? `${sign}${normalizedInteger}`
    : `${sign}${normalizedInteger}.${fraction}`;
}

function describeNormalization(
  value: unknown,
  constraints: DecimalStringConstraints | undefined,
): { canonical: string } | DecimalProblem {
  const shape = describeShape(value);
  if (shape !== null) {
    return shape;
  }
  const text = value as string;
  if (!LENIENT_PATTERN.test(text)) {
    return problem(
      "DECIMAL_MALFORMED",
      `"${text}" is not a plain decimal numeral and cannot be normalized`,
    );
  }
  const { sign, integer, fraction } = split(text);
  const canonical = canonicalizeParts(sign, integer, fraction);
  if (canonical.length > MAX_DECIMAL_STRING_LENGTH) {
    return problem(
      "DECIMAL_TOO_LONG",
      `normalized decimal string exceeds the maximum accepted length of ${String(MAX_DECIMAL_STRING_LENGTH)} characters`,
    );
  }
  const range = describeRange(canonical, constraints);
  return range ?? { canonical };
}

/**
 * Normalizes a *venue-supplied* decimal spelling into canonical form.
 *
 * This is the only sanctioned entry point for non-canonical input. It accepts
 * a leading `+`, redundant leading zeros, trailing fractional zeros, `"-0"`
 * spellings, an omitted integer part (`".5"` → `"0.5"`), and an empty fraction
 * (`"1."` → `"1"`). It still rejects scientific notation, whitespace, empty
 * strings, `"NaN"`, `"Infinity"`, and any non-string input.
 *
 * @throws {InvalidDecimalStringError} when the input is not a plain numeral.
 * @throws {DecimalRangeError} when the normalized value is out of range.
 */
export function normalizeDecimalString(
  value: unknown,
  constraints?: DecimalStringConstraints,
  label = "value",
): DecimalString {
  const outcome = describeNormalization(value, constraints);
  if ("canonical" in outcome) {
    return outcome.canonical;
  }
  const message = `${label}: ${outcome.message}`;
  throw outcome.code === "DECIMAL_OUT_OF_RANGE"
    ? new DecimalRangeError(outcome.code, message)
    : new InvalidDecimalStringError(outcome.code, message);
}

export type NormalizationResult =
  | { readonly ok: true; readonly value: DecimalString }
  | { readonly ok: false; readonly code: DecimalErrorCode; readonly message: string };

/** Non-throwing variant of {@link normalizeDecimalString} for adapter hot paths. */
export function tryNormalizeDecimalString(
  value: unknown,
  constraints?: DecimalStringConstraints,
): NormalizationResult {
  const outcome = describeNormalization(value, constraints);
  return "canonical" in outcome
    ? { ok: true, value: outcome.canonical }
    : { ok: false, code: outcome.code, message: outcome.message };
}

function describeHashInput(
  value: unknown,
  constraints: DecimalStringConstraints | undefined,
): { canonical: string } | DecimalProblem {
  const shape = describeShape(value);
  if (shape !== null) {
    return shape;
  }
  const text = value as string;
  if (text.startsWith("+")) {
    return problem(
      "DECIMAL_LEADING_PLUS",
      `a leading "+" is not accepted as hash input: "${text}"`,
    );
  }
  if (text.endsWith(".")) {
    return problem(
      "DECIMAL_TRAILING_POINT",
      `a trailing decimal point is not accepted as hash input: "${text}"`,
    );
  }
  if (/^-?\./u.test(text)) {
    return problem(
      "DECIMAL_MISSING_INTEGER_PART",
      `the integer part may not be omitted in hash input: "${text}"`,
    );
  }
  if (!HASH_INPUT_PATTERN.test(text)) {
    return problem(
      "DECIMAL_MALFORMED",
      `"${text}" is not a hashable decimal numeral (only redundant leading/trailing zeros and a signed zero may be normalized before hashing)`,
    );
  }
  const { sign, integer, fraction } = split(text);
  const canonical = canonicalizeParts(sign, integer, fraction);
  if (canonical.length > MAX_DECIMAL_STRING_LENGTH) {
    return problem(
      "DECIMAL_TOO_LONG",
      `normalized decimal string exceeds the maximum accepted length of ${String(MAX_DECIMAL_STRING_LENGTH)} characters`,
    );
  }
  const range = describeRange(canonical, constraints);
  return range ?? { canonical };
}

/**
 * Returns `null` when `value` is a legal hash input, otherwise an explanation.
 *
 * See {@link normalizeHashableDecimalString} for the grammar.
 */
export function explainHashableDecimalString(
  value: unknown,
  constraints?: DecimalStringConstraints,
): string | null {
  const outcome = describeHashInput(value, constraints);
  return "canonical" in outcome ? null : outcome.message;
}

/** Predicate form of {@link explainHashableDecimalString}. */
export function isHashableDecimalString(
  value: unknown,
  constraints?: DecimalStringConstraints,
): value is DecimalString {
  return explainHashableDecimalString(value, constraints) === null;
}

/**
 * Normalizes a decimal string for *hashing*, under the §7.3 hash-input grammar.
 *
 * Accepts the canonical form plus the one relaxation §7.3 sanctions before
 * hashing — redundant leading zeros, trailing fractional zeros, and signed zero
 * — and rejects every form §7.3 forbids: a leading `+`, a trailing decimal
 * point, an omitted integer part, scientific notation, and non-strings.
 *
 * This is intentionally stricter than {@link normalizeDecimalString}. Use the
 * latter to canonicalize venue wire values; use this one for anything whose
 * digest is persisted.
 *
 * @throws {InvalidDecimalStringError} when the input is not a legal hash input.
 * @throws {DecimalRangeError} when the normalized value is out of range.
 */
export function normalizeHashableDecimalString(
  value: unknown,
  constraints?: DecimalStringConstraints,
  label = "value",
): DecimalString {
  const outcome = describeHashInput(value, constraints);
  if ("canonical" in outcome) {
    return outcome.canonical;
  }
  const message = `${label}: ${outcome.message}`;
  throw outcome.code === "DECIMAL_OUT_OF_RANGE"
    ? new DecimalRangeError(outcome.code, message)
    : new InvalidDecimalStringError(outcome.code, message);
}

/** Number of fractional digits of a canonical decimal string (`"1.25"` → 2). */
export function decimalPlaces(value: DecimalString): number {
  const canonical = assertCanonicalDecimalString(value);
  const point = canonical.indexOf(".");
  return point < 0 ? 0 : canonical.length - point - 1;
}

/** Number of significant digits of a canonical decimal string (`"0.0250"` is not canonical; `"0.025"` → 2). */
export function significantDigits(value: DecimalString): number {
  const canonical = assertCanonicalDecimalString(value);
  if (canonical === "0") {
    return 0;
  }
  const { integer, fraction } = split(canonical);
  const digits = (integer === "0" ? "" : integer) + fraction;
  return digits.replace(/^0+/, "").length;
}
