/**
 * Typed errors for the exact-decimal boundary (WP-020).
 *
 * Handoff §21 requires errors to be typed and observable. Every failure mode of
 * this package throws a subclass of {@link DecimalError} carrying a stable
 * `code` so callers can branch and metrics can label without string matching.
 */

export type DecimalErrorCode =
  | "DECIMAL_NOT_A_STRING"
  | "DECIMAL_EMPTY"
  | "DECIMAL_TOO_LONG"
  | "DECIMAL_SCIENTIFIC_NOTATION"
  | "DECIMAL_LEADING_PLUS"
  | "DECIMAL_MALFORMED"
  | "DECIMAL_NOT_CANONICAL"
  | "DECIMAL_OUT_OF_RANGE"
  | "DECIMAL_DIVISION_BY_ZERO"
  | "DECIMAL_INEXACT"
  | "DECIMAL_INVALID_TICK";

/** Base class for every error raised by `@polymarket-bot/decimal`. */
export class DecimalError extends Error {
  public readonly code: DecimalErrorCode;

  public constructor(code: DecimalErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * The supplied value is not a decimal string in the required form.
 *
 * Raised both by the strict canonical boundary check and by the lenient
 * normalizer when the input cannot be interpreted as a plain decimal number.
 */
export class InvalidDecimalStringError extends DecimalError {}

/** The value parsed but violated a contextual range constraint (for example price in `[0, 1]`). */
export class DecimalRangeError extends DecimalError {}

/** Division by an exact zero divisor. */
export class DecimalDivisionByZeroError extends DecimalError {}

/** An operation could not be represented exactly (for example a non-terminating quotient). */
export class DecimalInexactError extends DecimalError {}

/** A tick size was zero, negative, or otherwise unusable for modulo conformance. */
export class InvalidTickSizeError extends DecimalError {}
