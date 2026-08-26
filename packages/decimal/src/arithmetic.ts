/**
 * Exact decimal arithmetic — handoff §2 ("exact decimal arithmetic internally")
 * and §6 invariant 1 ("no binary floating point for economics").
 *
 * Every function takes canonical decimal strings and returns a canonical
 * decimal string. No economic value is ever converted to a JavaScript `number`:
 * inputs are parsed by `decimal.js` directly from their string form, and
 * results are rendered with `toFixed()` (fixed-point, never exponential) before
 * being canonicalized again. Passing a `number` throws.
 *
 * ## Precision and rounding (explicit, never implicit)
 *
 * - Addition, subtraction and multiplication are configured at
 *   {@link EXACT_PRECISION} significant digits. Because a boundary value is at
 *   most {@link MAX_DECIMAL_STRING_LENGTH} characters, the exact result of any
 *   of these operations needs at most a few thousand significant digits, so
 *   these operations are always exact — rounding cannot occur. A defensive
 *   check raises {@link DecimalInexactError} instead of returning a silently
 *   rounded value if that bound is ever breached.
 * - Division is the only operation that can be inexact. {@link divDecimal}
 *   rounds to {@link DIVISION_PRECISION} significant digits using
 *   {@link DIVISION_ROUNDING} (ROUND_HALF_EVEN, i.e. banker's rounding), and
 *   both are overridable per call. {@link divDecimalExact} refuses to round: it
 *   throws when the quotient does not terminate within
 *   {@link EXACT_DIVISION_PROBE_PRECISION} significant digits.
 * - Money rounding rules (fees, payouts, tick rounding) are deliberately NOT
 *   defined here. They belong to the components that own those rules, which
 *   must pass an explicit rounding mode.
 */

// Named import: `decimal.js` ships one `.d.ts` that TypeScript resolves as
// CommonJS under `NodeNext`, so a default import would bind the module
// namespace rather than the class. The named export exists in both the CJS and
// ESM builds and in the type definitions.
import { Decimal } from "decimal.js";

import {
  MAX_DECIMAL_STRING_LENGTH,
  assertCanonicalDecimalString,
  normalizeDecimalString,
  type DecimalString,
} from "./canonical.js";
import { DecimalDivisionByZeroError, DecimalInexactError } from "./errors.js";

/**
 * Working precision for exact operations (`decimal.js` maximum).
 *
 * See the module header: with bounded inputs this makes addition, subtraction
 * and multiplication exact.
 */
export const EXACT_PRECISION = 1e9;

/** Default significant digits for {@link divDecimal}. Matches IEEE 754 decimal128. */
export const DIVISION_PRECISION = 34;

/** Default rounding for {@link divDecimal}: ROUND_HALF_EVEN (banker's rounding). */
export const DIVISION_ROUNDING: Decimal.Rounding = Decimal.ROUND_HALF_EVEN;

/**
 * Significant digits used to probe whether a quotient terminates.
 *
 * {@link divDecimalExact} throws rather than returning a rounded value, so a
 * bounded probe is safe: an exact quotient that needed more digits than this
 * produces a typed error, never a silently rounded number.
 */
export const EXACT_DIVISION_PROBE_PRECISION = 200;

const BASE_CONFIG: Decimal.Config = {
  defaults: true,
  rounding: Decimal.ROUND_HALF_EVEN,
  modulo: Decimal.ROUND_DOWN,
  // Force plain (non-exponential) rendering across the whole representable range.
  toExpNeg: -9e15,
  toExpPos: 9e15,
  minE: -9e15,
  maxE: 9e15,
  crypto: false,
};

/** Constructor used for exact operations. */
const ExactDecimal = Decimal.clone({ ...BASE_CONFIG, precision: EXACT_PRECISION });

/** Constructor used for the default rounding division. */
const DivisionDecimal = Decimal.clone({
  ...BASE_CONFIG,
  precision: DIVISION_PRECISION,
  rounding: DIVISION_ROUNDING,
});

/** Constructor used to probe exact division. */
const ProbeDecimal = Decimal.clone({
  ...BASE_CONFIG,
  precision: EXACT_DIVISION_PROBE_PRECISION,
});

function toExact(value: unknown, label: string): Decimal {
  return new ExactDecimal(assertCanonicalDecimalString(value, undefined, label));
}

function render(value: Decimal, operation: string): DecimalString {
  if (!value.isFinite()) {
    throw new DecimalInexactError(
      "DECIMAL_INEXACT",
      `${operation}: result is not a finite decimal`,
    );
  }
  if (value.sd() >= EXACT_PRECISION) {
    throw new DecimalInexactError(
      "DECIMAL_INEXACT",
      `${operation}: result exceeds the exact working precision of ${String(EXACT_PRECISION)} significant digits`,
    );
  }
  const fixed = value.toFixed();
  if (fixed.length > MAX_DECIMAL_STRING_LENGTH) {
    throw new DecimalInexactError(
      "DECIMAL_INEXACT",
      `${operation}: result exceeds the maximum decimal string length of ${String(MAX_DECIMAL_STRING_LENGTH)} characters`,
    );
  }
  return normalizeDecimalString(fixed, undefined, operation);
}

/** Exact addition. `addDecimal("0.1", "0.2") === "0.3"`. */
export function addDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return render(toExact(a, "addDecimal(a)").plus(toExact(b, "addDecimal(b)")), "addDecimal");
}

/** Exact subtraction. */
export function subDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return render(toExact(a, "subDecimal(a)").minus(toExact(b, "subDecimal(b)")), "subDecimal");
}

/** Exact multiplication. */
export function mulDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return render(toExact(a, "mulDecimal(a)").times(toExact(b, "mulDecimal(b)")), "mulDecimal");
}

export interface DivisionOptions {
  /** Significant digits of the quotient. Defaults to {@link DIVISION_PRECISION}. */
  readonly precision?: number;
  /** Rounding mode. Defaults to {@link DIVISION_ROUNDING} (ROUND_HALF_EVEN). */
  readonly rounding?: Decimal.Rounding;
}

/**
 * Division with an explicit, documented rounding contract.
 *
 * @throws {DecimalDivisionByZeroError} when the divisor is exactly zero.
 */
export function divDecimal(
  a: DecimalString,
  b: DecimalString,
  options?: DivisionOptions,
): DecimalString {
  const dividend = assertCanonicalDecimalString(a, undefined, "divDecimal(a)");
  const divisor = assertCanonicalDecimalString(b, undefined, "divDecimal(b)");
  if (new ExactDecimal(divisor).isZero()) {
    throw new DecimalDivisionByZeroError(
      "DECIMAL_DIVISION_BY_ZERO",
      `divDecimal: division by zero (${dividend} / ${divisor})`,
    );
  }
  const Ctor =
    options === undefined || (options.precision === undefined && options.rounding === undefined)
      ? DivisionDecimal
      : Decimal.clone({
          ...BASE_CONFIG,
          precision: options.precision ?? DIVISION_PRECISION,
          rounding: options.rounding ?? DIVISION_ROUNDING,
        });
  return render(new Ctor(dividend).div(divisor), "divDecimal");
}

/**
 * Division that refuses to round.
 *
 * @throws {DecimalDivisionByZeroError} when the divisor is exactly zero.
 * @throws {DecimalInexactError} when the quotient does not terminate within
 *   {@link EXACT_DIVISION_PROBE_PRECISION} significant digits.
 */
export function divDecimalExact(a: DecimalString, b: DecimalString): DecimalString {
  const dividend = assertCanonicalDecimalString(a, undefined, "divDecimalExact(a)");
  const divisor = assertCanonicalDecimalString(b, undefined, "divDecimalExact(b)");
  if (new ExactDecimal(divisor).isZero()) {
    throw new DecimalDivisionByZeroError(
      "DECIMAL_DIVISION_BY_ZERO",
      `divDecimalExact: division by zero (${dividend} / ${divisor})`,
    );
  }
  const quotient = new ProbeDecimal(dividend).div(divisor);
  const roundTrip = new ExactDecimal(quotient.toFixed()).times(new ExactDecimal(divisor));
  if (!roundTrip.equals(new ExactDecimal(dividend))) {
    throw new DecimalInexactError(
      "DECIMAL_INEXACT",
      `divDecimalExact: ${dividend} / ${divisor} is not exactly representable within ${String(EXACT_DIVISION_PROBE_PRECISION)} significant digits`,
    );
  }
  return render(quotient, "divDecimalExact");
}

/** Exact three-way comparison. Returns `-1`, `0`, or `1`. */
export function compareDecimal(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const result = toExact(a, "compareDecimal(a)").cmp(toExact(b, "compareDecimal(b)"));
  return result < 0 ? -1 : result > 0 ? 1 : 0;
}

/**
 * Exact numeric equality.
 *
 * Note that canonical strings compare equal with `===` as well; this helper
 * exists so callers never have to decide whether a value was canonicalized.
 */
export function equalsDecimal(a: DecimalString, b: DecimalString): boolean {
  return compareDecimal(a, b) === 0;
}

/** Exact negation. `negateDecimal("0")` is `"0"` (canonical zero is unsigned). */
export function negateDecimal(value: DecimalString): DecimalString {
  return render(toExact(value, "negateDecimal(value)").negated(), "negateDecimal");
}

/** Exact absolute value. */
export function absDecimal(value: DecimalString): DecimalString {
  return render(toExact(value, "absDecimal(value)").abs(), "absDecimal");
}

/** True when the value is exactly zero. */
export function isZeroDecimal(value: DecimalString): boolean {
  return toExact(value, "isZeroDecimal(value)").isZero();
}

/** True when the value is strictly negative. */
export function isNegativeDecimal(value: DecimalString): boolean {
  const parsed = toExact(value, "isNegativeDecimal(value)");
  return parsed.isNegative() && !parsed.isZero();
}
