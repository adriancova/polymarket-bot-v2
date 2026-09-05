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
 *
 * ## Inexactness versus a bad argument
 *
 * {@link DecimalInexactError} means a RESULT could not be represented exactly.
 * A caller argument that is out of range — {@link divDecimal}'s `precision`
 * option — raises {@link DecimalRangeError} with code
 * `DECIMAL_INVALID_PRECISION` instead, and a division option that is not usable
 * data at all raises the same class with `DECIMAL_INVALID_OPTIONS`. The first
 * two were conflated until the Wave 0 closeout L9 fix; no arithmetic result
 * changed then, and none changes now.
 *
 * ## Ambient prototype state (`WP-020-FU1`)
 *
 * Every operation below runs inside {@link withNeutralIndexNames}. `decimal.js`
 * reads and writes its digit arrays at index names the array does not own, and
 * both operations consult `Object.prototype`; one property at an array-index
 * name there made `addDecimal("100", "-100")` answer `"9"` and
 * `divDecimal("1", "3")` answer `3.3333…` at base. The guard removes that
 * ambient state for the duration of one operation and restores it exactly;
 * `packages/decimal/src/prototype-guard.ts` carries the full measurement, the
 * root cause in the library, and the residual it does not cover. In an honest
 * process the guard mutates nothing, so results are byte-identical to base by
 * construction rather than by test.
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
import {
  DecimalDivisionByZeroError,
  DecimalInexactError,
  DecimalRangeError,
} from "./errors.js";
import { withNeutralIndexNames } from "./prototype-guard.js";

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

/**
 * Constructor used for a division with EXPLICIT precision/rounding — cloned
 * HERE, at module load, exactly like the three above.
 *
 * WHY IT EXISTS (`GOV-2A` follow-up 5). `divDecimal` used to call
 * `Decimal.clone({…})` per call when the caller supplied options.
 * `Decimal.clone` builds a fresh constructor by ASSIGNING to it — including
 * `Decimal.config = Decimal.set = config` — and an assignment consults the
 * prototype chain for an inherited setter, so with a get-only
 * `Object.prototype.set` the explicit-options path answered
 *
 * ```text
 * executablePrice(book, { side, shares, division })
 *   → TypeError: Cannot set property set of #<Object> which has only a getter
 * ```
 *
 * (`GOV-2A` probe J1/J2, reproduced at base `b4ce0aa`) — an untyped throw out
 * of a monetary function, from a boundary the caller had done nothing wrong at.
 * The default path was immune only because its constructor was cloned at module
 * load, in a process nobody had polluted yet. Now BOTH paths are, and the two
 * per-call settings are written onto this constructor's OWN, writable
 * `precision`/`rounding` properties, which shadow anything inherited.
 *
 * Reused rather than re-cloned per call, which is safe because a division runs
 * to completion before the next one starts: `decimal.js` reads `precision` and
 * `rounding` synchronously inside `div`, invokes no callback, and nothing in
 * this module is asynchronous or re-entrant. Both fields are written on every
 * explicit call, so no earlier call's setting can be inherited by a later one.
 */
const ExplicitDivisionDecimal = Decimal.clone({
  ...BASE_CONFIG,
  precision: DIVISION_PRECISION,
  rounding: DIVISION_ROUNDING,
});

/** The two settings the explicit path writes, as the writable properties they are. */
interface MutableDivisionSettings {
  precision: number;
  rounding: Decimal.Rounding;
}

const explicitDivisionSettings = ExplicitDivisionDecimal as MutableDivisionSettings;

/** The highest `decimal.js` ROUNDING mode (`ROUND_HALF_FLOOR`). `9` is a modulo mode. */
const MAX_ROUNDING = 8;

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
  return withNeutralIndexNames(() =>
    render(toExact(a, "addDecimal(a)").plus(toExact(b, "addDecimal(b)")), "addDecimal"),
  );
}

/** Exact subtraction. */
export function subDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return withNeutralIndexNames(() =>
    render(toExact(a, "subDecimal(a)").minus(toExact(b, "subDecimal(b)")), "subDecimal"),
  );
}

/** Exact multiplication. */
export function mulDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return withNeutralIndexNames(() =>
    render(toExact(a, "mulDecimal(a)").times(toExact(b, "mulDecimal(b)")), "mulDecimal"),
  );
}

export interface DivisionOptions {
  /** Significant digits of the quotient. Defaults to {@link DIVISION_PRECISION}. */
  readonly precision?: number;
  /** Rounding mode. Defaults to {@link DIVISION_ROUNDING} (ROUND_HALF_EVEN). */
  readonly rounding?: Decimal.Rounding;
}

/** What a division will actually be computed with, after the options are read. */
interface ResolvedDivision {
  readonly precision: number;
  readonly rounding: Decimal.Rounding;
  /** False when the caller supplied nothing: the documented defaults, unchanged. */
  readonly explicit: boolean;
}

const DEFAULT_DIVISION: ResolvedDivision = Object.freeze({
  precision: DIVISION_PRECISION,
  rounding: DIVISION_ROUNDING,
  explicit: false,
});

/**
 * Describes an option value for a refusal message WITHOUT COERCING IT.
 *
 * `String(value)` invokes `@@toPrimitive`/`toString`, which is caller code, and
 * throws outright on a symbol. The refusal text is evidence; building it must
 * not be a second way for the same call to fail (`packages/risk`'s
 * `describeValue`, review round 5).
 */
function describeOption(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
    case "boolean":
    case "bigint":
      return `${value}`;
    case "string":
      return `"${value}"`;
    case "symbol":
      return "a symbol";
    case "function":
      return "a function";
    case "undefined":
      return "undefined";
    default:
      return "an object";
  }
}

/**
 * The OWN DATA value of one division option, or `undefined` when it is absent.
 *
 * NOT `options.precision` (`WP-020-FU1`, from `GOV-2A` follow-up 5). A dotted
 * read is `Get`: it walks the prototype chain, so "the caller did not ask for a
 * precision" and "nobody has put `precision` on `Object.prototype`" were the
 * same question — and the difference changes a MONETARY value. Measured at base
 * `b4ce0aa`, with an empty explicit options object and nothing else:
 *
 * ```text
 * Object.prototype.precision = 2 (non-enumerable data)
 *   divDecimal("2", "3", {})  "0.6666666666666666666666666666666667" -> "0.67"
 * ```
 *
 * The value is taken from the DESCRIPTOR, so an accessor is refused rather than
 * invoked: a getter is code, it can throw out of this function, and it can
 * answer differently on a second read.
 */
function ownOptionValue(options: object, name: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(options, name);
  } catch {
    throw new DecimalRangeError(
      "DECIMAL_INVALID_OPTIONS",
      `divDecimal: the division options could not be read (the "${name}" descriptor threw)`,
    );
  }
  if (descriptor === undefined) return undefined;
  // `Object.hasOwn`, not `"value" in descriptor`: `in` answers for an INHERITED
  // name, so an `Object.prototype.value` would make every ACCESSOR descriptor
  // read as a data descriptor (`packages/risk`'s `ownDataValue`, round 6).
  if (!Object.hasOwn(descriptor, "value")) {
    throw new DecimalRangeError(
      "DECIMAL_INVALID_OPTIONS",
      `divDecimal: division options must be plain data, but "${name}" is an accessor property`,
    );
  }
  return descriptor.value;
}

/**
 * Reads and validates {@link DivisionOptions}, own-property only.
 *
 * The documented defaults are unchanged (`docs/contracts/domain.md`): absent
 * options, `undefined`/`null` options, and an options object that declares
 * neither field all divide at {@link DIVISION_PRECISION} significant digits
 * with {@link DIVISION_ROUNDING}. What changed is that a MALFORMED option is
 * now this package's typed refusal instead of `decimal.js`'s untyped
 * `Error("[DecimalError] Invalid argument: rounding: 99")`, which escaped the
 * package's error taxonomy entirely at base.
 */
function resolveDivisionOptions(options: DivisionOptions | undefined): ResolvedDivision {
  if (options === undefined || options === null) return DEFAULT_DIVISION;
  if (typeof options !== "object") {
    throw new DecimalRangeError(
      "DECIMAL_INVALID_OPTIONS",
      `divDecimal: division options must be an object, received ${describeOption(options)}`,
    );
  }
  const precision = ownOptionValue(options, "precision");
  const rounding = ownOptionValue(options, "rounding");
  if (precision === undefined && rounding === undefined) return DEFAULT_DIVISION;
  if (
    precision !== undefined &&
    (typeof precision !== "number" ||
      !Number.isInteger(precision) ||
      precision < 1 ||
      precision > EXACT_PRECISION)
  ) {
    // ARGUMENT validation, not an inexactness: the caller asked for a
    // precision this package cannot honour. Raising `DecimalInexactError` here
    // (as this did until the Wave 0 closeout L9 fix) told a caller that a
    // RESULT could not be represented exactly, which is a different fact and
    // would be metered under the wrong label.
    throw new DecimalRangeError(
      "DECIMAL_INVALID_PRECISION",
      `divDecimal: precision must be an integer in [1, ${String(EXACT_PRECISION)}], received ${describeOption(precision)}`,
    );
  }
  if (
    rounding !== undefined &&
    (typeof rounding !== "number" ||
      !Number.isInteger(rounding) ||
      rounding < 0 ||
      rounding > MAX_ROUNDING)
  ) {
    throw new DecimalRangeError(
      "DECIMAL_INVALID_OPTIONS",
      `divDecimal: rounding must be an integer in [0, ${String(MAX_ROUNDING)}] (a decimal.js rounding mode), received ${describeOption(rounding)}`,
    );
  }
  return {
    precision: precision ?? DIVISION_PRECISION,
    rounding: (rounding ?? DIVISION_ROUNDING) as Decimal.Rounding,
    explicit: true,
  };
}

/**
 * Division with an explicit, documented rounding contract.
 *
 * @throws {DecimalDivisionByZeroError} when the divisor is exactly zero.
 * @throws {DecimalRangeError} (`DECIMAL_INVALID_PRECISION`) when the requested
 *   `precision` is not an integer in `[1, EXACT_PRECISION]`.
 * @throws {DecimalRangeError} (`DECIMAL_INVALID_OPTIONS`) when `options` is not
 *   a readable object of own data properties, or `rounding` is not one of the
 *   nine `decimal.js` rounding modes.
 */
export function divDecimal(
  a: DecimalString,
  b: DecimalString,
  options?: DivisionOptions,
): DecimalString {
  return withNeutralIndexNames(() => {
    const dividend = assertCanonicalDecimalString(a, undefined, "divDecimal(a)");
    const divisor = assertCanonicalDecimalString(b, undefined, "divDecimal(b)");
    if (new ExactDecimal(divisor).isZero()) {
      throw new DecimalDivisionByZeroError(
        "DECIMAL_DIVISION_BY_ZERO",
        `divDecimal: division by zero (${dividend} / ${divisor})`,
      );
    }
    const resolved = resolveDivisionOptions(options);
    if (!resolved.explicit) {
      return render(new DivisionDecimal(dividend).div(divisor), "divDecimal");
    }
    explicitDivisionSettings.precision = resolved.precision;
    explicitDivisionSettings.rounding = resolved.rounding;
    return render(new ExplicitDivisionDecimal(dividend).div(divisor), "divDecimal");
  });
}

/**
 * Division that refuses to round.
 *
 * @throws {DecimalDivisionByZeroError} when the divisor is exactly zero.
 * @throws {DecimalInexactError} when the quotient does not terminate within
 *   {@link EXACT_DIVISION_PROBE_PRECISION} significant digits.
 */
export function divDecimalExact(a: DecimalString, b: DecimalString): DecimalString {
  return withNeutralIndexNames(() => {
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
  });
}

/** Exact three-way comparison. Returns `-1`, `0`, or `1`. */
export function compareDecimal(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  return withNeutralIndexNames(() => {
    const result = toExact(a, "compareDecimal(a)").cmp(toExact(b, "compareDecimal(b)"));
    return result < 0 ? -1 : result > 0 ? 1 : 0;
  });
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
  return withNeutralIndexNames(() =>
    render(toExact(value, "negateDecimal(value)").negated(), "negateDecimal"),
  );
}

/** Exact absolute value. */
export function absDecimal(value: DecimalString): DecimalString {
  return withNeutralIndexNames(() =>
    render(toExact(value, "absDecimal(value)").abs(), "absDecimal"),
  );
}

/** True when the value is exactly zero. */
export function isZeroDecimal(value: DecimalString): boolean {
  return withNeutralIndexNames(() => toExact(value, "isZeroDecimal(value)").isZero());
}

/** True when the value is strictly negative. */
export function isNegativeDecimal(value: DecimalString): boolean {
  return withNeutralIndexNames(() => {
    const parsed = toExact(value, "isNegativeDecimal(value)");
    return parsed.isNegative() && !parsed.isZero();
  });
}
