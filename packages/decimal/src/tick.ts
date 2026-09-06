/**
 * Exact tick conformance — handoff §7.3 ("tick conformance is checked with
 * exact modulo arithmetic") and §16.2 ("no accepted order violates tick size").
 *
 * The check scales both operands to exact integers by the larger of their two
 * decimal-place counts and then takes an integer modulo. No floating point and
 * no division rounding is involved, so `isTickConformant("0.07", "0.01")` is
 * true where a `number`-based `0.07 % 0.01` is not.
 *
 * Tick *rounding* is intentionally not implemented here: which direction to
 * round is an execution-policy decision owned by the components that place
 * orders, not by the decimal foundation.
 *
 * Like `arithmetic.ts`, the two public entry points run inside {@link guarded}:
 * `times`, `pow`, `modulo` and the comparison below all read and write
 * `decimal.js` digit arrays at index names the array does not own, and at base
 * one property at such a name on `Object.prototype` could make a value that is
 * NOT on the tick grid look as though it were (see `prototype-guard.ts` for the
 * measurement). A tick check is a §16.2 safety gate, so it is guarded for the
 * same reason the arithmetic is.
 *
 * The same round-1 measurement found this module's worst shape: with a
 * non-configurable SET-ONLY accessor at `Array.prototype["0"]`,
 * `isTickConformant("0.37", "0.01")` answered `InvalidTickSizeError: tick size
 * must be strictly positive, received "0.01"` — a WRONG-TYPED refusal about a
 * tick size that is strictly positive, because the comparison itself had been
 * corrupted. That state is now refused with `HostilePrototypeError`
 * (`DECIMAL_HOSTILE_PROTOTYPE`) instead, so a tick verdict is never derived from
 * a corrupted comparison.
 */

import { Decimal } from "decimal.js";

import {
  assertCanonicalDecimalString,
  decimalPlaces,
  type DecimalString,
} from "./canonical.js";
import { InvalidTickSizeError } from "./errors.js";
import { guarded } from "./guarded.js";

const IntegerDecimal = Decimal.clone({
  defaults: true,
  precision: 1e9,
  rounding: Decimal.ROUND_HALF_EVEN,
  modulo: Decimal.ROUND_DOWN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
  minE: -9e15,
  maxE: 9e15,
  crypto: false,
});

function scaleToInteger(value: DecimalString, scale: number): Decimal {
  const scaled = new IntegerDecimal(value).times(new IntegerDecimal(10).pow(scale));
  if (!scaled.isInteger()) {
    // Unreachable for canonical inputs scaled by max(decimalPlaces); kept as a
    // hard invariant so a future change cannot silently introduce rounding.
    //
    // The code is `DECIMAL_INVALID_TICK`, matching the class. It carried
    // `DECIMAL_INEXACT` until the Wave 0 closeout L9 fix, which broke the one
    // property a stable `code` exists for: a caller branching on the class and
    // a metric labelling on the code must classify the same failure the same
    // way. Every `InvalidTickSizeError` in this package now carries
    // `DECIMAL_INVALID_TICK` (see `errors.ts` and `errors.test.ts`); the
    // specific cause stays in the message.
    throw new InvalidTickSizeError(
      "DECIMAL_INVALID_TICK",
      `tick conformance scaling did not produce an integer for "${value}"`,
    );
  }
  return scaled;
}

/**
 * True when `value` is an exact integer multiple of `tickSize`.
 *
 * @throws {InvalidTickSizeError} when `tickSize` is not strictly positive.
 */
export function isTickConformant(value: DecimalString, tickSize: DecimalString): boolean {
  return guarded(() => {
    const amount = assertCanonicalDecimalString(value, undefined, "isTickConformant(value)");
    const tick = assertCanonicalDecimalString(tickSize, undefined, "isTickConformant(tickSize)");
    if (new IntegerDecimal(tick).lessThanOrEqualTo(0)) {
      throw new InvalidTickSizeError(
        "DECIMAL_INVALID_TICK",
        `tick size must be strictly positive, received "${tick}"`,
      );
    }
    const scale = Math.max(decimalPlaces(amount), decimalPlaces(tick));
    return scaleToInteger(amount, scale).modulo(scaleToInteger(tick, scale)).isZero();
  });
}

/**
 * Assertion form of {@link isTickConformant}.
 *
 * @throws {InvalidTickSizeError} when the value is not on the tick grid.
 */
export function assertTickConformant(
  value: DecimalString,
  tickSize: DecimalString,
  label = "value",
): DecimalString {
  if (!isTickConformant(value, tickSize)) {
    throw new InvalidTickSizeError(
      "DECIMAL_INVALID_TICK",
      `${label}: "${value}" is not an exact multiple of tick size "${tickSize}"`,
    );
  }
  return value;
}
