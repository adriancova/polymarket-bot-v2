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
  | "DECIMAL_TRAILING_POINT"
  | "DECIMAL_MISSING_INTEGER_PART"
  | "DECIMAL_MALFORMED"
  | "DECIMAL_NOT_CANONICAL"
  | "DECIMAL_OUT_OF_RANGE"
  | "DECIMAL_INVALID_PRECISION"
  | "DECIMAL_INVALID_OPTIONS"
  | "DECIMAL_DIVISION_BY_ZERO"
  | "DECIMAL_INEXACT"
  | "DECIMAL_INVALID_TICK"
  | "DECIMAL_HOSTILE_PROTOTYPE";

/**
 * Which code each subclass may carry.
 *
 * Wave 0 closeout finding L9 found one site where a class and its code
 * disagreed (`InvalidTickSizeError` thrown with `"DECIMAL_INEXACT"`), which
 * defeats the whole point of a stable `code`: a caller that branches on the
 * class and a metric that labels on the code would classify the same failure
 * two different ways. The pairing is now stated here and asserted in
 * `errors.test.ts`.
 *
 * | Class | Codes |
 * | --- | --- |
 * | `InvalidDecimalStringError` | every shape/grammar code (`DECIMAL_NOT_A_STRING` … `DECIMAL_NOT_CANONICAL`) |
 * | `DecimalRangeError` | `DECIMAL_OUT_OF_RANGE`, `DECIMAL_INVALID_PRECISION`, `DECIMAL_INVALID_OPTIONS` |
 * | `DecimalDivisionByZeroError` | `DECIMAL_DIVISION_BY_ZERO` |
 * | `DecimalInexactError` | `DECIMAL_INEXACT` |
 * | `InvalidTickSizeError` | `DECIMAL_INVALID_TICK` |
 * | `HostilePrototypeError` | `DECIMAL_HOSTILE_PROTOTYPE` |
 */

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

/**
 * A numeric input violated a declared range.
 *
 * Two distinct codes ride on this class and callers should branch on the code,
 * not only on the class:
 *
 * - `DECIMAL_OUT_OF_RANGE` — an *economic value* parsed as a canonical decimal
 *   but breached a contextual constraint (for example a price outside `[0, 1]`).
 *   This is a data fact about a venue value.
 * - `DECIMAL_INVALID_PRECISION` — a *caller argument* was outside its permitted
 *   range: `divDecimal`'s `precision` option must be an integer in
 *   `[1, EXACT_PRECISION]`. This is a programming error in the caller, not a
 *   statement about any decimal value, and in particular it is NOT an
 *   inexactness (Wave 0 closeout finding L9: it previously raised
 *   {@link DecimalInexactError}, which is documented to mean a result could not
 *   be represented exactly and would have mislabeled a bad argument as a
 *   precision loss).
 * - `DECIMAL_INVALID_OPTIONS` — a *caller argument* that is not usable data at
 *   all: `divDecimal`'s `options` was not an object, one of its fields was an
 *   accessor rather than data, its descriptor could not be read, or `rounding`
 *   was not one of the nine `decimal.js` rounding modes. Added by `WP-020-FU1`
 *   (`GOV-2A` follow-up 5) because at base every one of those escaped this
 *   package's taxonomy as a bare `TypeError` or as `decimal.js`'s own
 *   `Error("[DecimalError] Invalid argument: …")`, which no caller can branch
 *   on and no metric can label.
 */
export class DecimalRangeError extends DecimalError {}

/** Division by an exact zero divisor. */
export class DecimalDivisionByZeroError extends DecimalError {}

/**
 * An operation's RESULT could not be represented exactly — a non-terminating
 * quotient, a result beyond the exact working precision, or a result longer
 * than `MAX_DECIMAL_STRING_LENGTH` characters. Always carries
 * `DECIMAL_INEXACT`.
 *
 * It never reports a malformed argument; those raise
 * {@link InvalidDecimalStringError} or {@link DecimalRangeError}.
 */
export class DecimalInexactError extends DecimalError {}

/**
 * A tick size was zero, negative, or otherwise unusable for modulo conformance,
 * or a value was not on the tick grid. Always carries `DECIMAL_INVALID_TICK`
 * (Wave 0 closeout finding L9 fixed the one site that carried
 * `DECIMAL_INEXACT`).
 */
export class InvalidTickSizeError extends DecimalError {}

/**
 * The PROCESS's prototype chain is in a state this package refuses to compute
 * in. Always carries `DECIMAL_HOSTILE_PROTOTYPE`.
 *
 * It says nothing about the caller's arguments. `decimal.js` reads its digit
 * arrays where they have holes and writes to indices they do not own yet, so an
 * array-index-named property on `Object.prototype` or `Array.prototype` changes
 * what arithmetic MEANS (`prototype-guard.ts` carries the measurement).
 * `withNeutralIndexNames` normally removes that state for the duration of one
 * operation, but a NON-CONFIGURABLE read-only data property or accessor at an
 * index name on `Array.prototype` can be neither redefined nor shadowed — there
 * is no lower link. Round 0 ran the operation anyway; `WP-020-FU1` review round
 * 1 finding M1 measured what that produced:
 *
 * ```text
 * Array.prototype["0"] = non-configurable get/set pair
 *   addDecimal("100", "-100")  "0" -> "9"      FABRICATED
 *   addDecimal("1", "2")       "3" -> "990"    FABRICATED
 * Array.prototype["0"] = non-configurable set-only accessor
 *   mulDecimal("2", "3")       "6" -> "0"      FABRICATED
 *   compareDecimal("5", "4")     1 -> 0        FABRICATED (five equals four)
 * ```
 *
 * This class is that refusal. It is AVAILABILITY, never permission: no value is
 * produced, nothing is admitted, and the message names the offending intrinsic
 * and index so an operator can find the code that corrupted the realm.
 *
 * It is UNREACHABLE from a clean process by construction — a non-configurable
 * property cannot be installed by an argument, only by in-process code that has
 * permanently corrupted an intrinsic — so it is exercised in child processes by
 * `test/unit/decimal/unneutralizable-shapes.test.ts` rather than in the
 * in-process taxonomy sweep, which `errors.test.ts` records at its site.
 */
export class HostilePrototypeError extends DecimalError {}
