/**
 * Exact tick-grid arithmetic — handoff §7.3 ("tick conformance is checked with
 * exact modulo arithmetic") and §9.10 ("Calculate exact tick-conforming
 * prices").
 *
 * `@polymarket-bot/decimal` deliberately does not implement tick ROUNDING:
 * "which direction to round is an execution-policy decision owned by the
 * components that place orders" (`packages/decimal/src/tick.ts`). This package
 * is that component, so the direction policy lives here and is one rule:
 * **round toward the SAFE side** — a BUY cap rounds DOWN, a SELL floor rounds
 * UP — so grid conformance can only tighten price protection, never loosen it.
 *
 * MECHANISM. Both operands are scaled to exact integers by the larger of their
 * decimal-place counts (pure string arithmetic on canonical decimal strings —
 * no `Number`, no floating point) and the quotient/remainder are taken with
 * `BigInt`, which is exact by definition. The result is rebuilt with
 * `mulDecimal` so every emitted price is a canonical decimal string. `BigInt`
 * is also deliberately a DIFFERENT primitive from `decimal.js`, so the test
 * suite can cross-check this module against `isTickConformant` without the
 * oracle sharing the implementation's arithmetic.
 *
 * TOTALITY: every function returns `undefined` for a value it cannot read as a
 * canonical decimal, and the callers turn that into a typed refusal. Inputs
 * are validated upstream, so `undefined` is a defence, not a code path.
 */

import {
  decimalPlaces,
  isCanonicalDecimalString,
  mulDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";

/** `value × 10^places` as an exact `BigInt`, or `undefined` if unreadable. */
function scaledInteger(value: string, places: number): bigint | undefined {
  if (!isCanonicalDecimalString(value)) return undefined;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  if (fracPart.length > places) return undefined;
  const digits = intPart + fracPart.padEnd(places, "0");
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

/** Both values scaled to one exact integer grid, or `undefined`. */
function scaledPair(
  value: string,
  tick: string,
): { readonly a: bigint; readonly t: bigint } | undefined {
  if (!isCanonicalDecimalString(value) || !isCanonicalDecimalString(tick)) return undefined;
  const places = Math.max(decimalPlaces(value), decimalPlaces(tick));
  const a = scaledInteger(value, places);
  const t = scaledInteger(tick, places);
  if (a === undefined || t === undefined || t <= 0n) return undefined;
  return { a, t };
}

/** Exact `count × tick` as a canonical decimal string. */
export function tickTimes(tick: string, count: number): string | undefined {
  if (!Number.isSafeInteger(count) || count < 0 || !isCanonicalDecimalString(tick)) {
    return undefined;
  }
  return mulDecimal(tick, String(count));
}

/** True when `value` is an exact non-negative multiple of `tick`. */
export function isOnTick(value: string, tick: string): boolean {
  const pair = scaledPair(value, tick);
  if (pair === undefined || pair.a < 0n) return false;
  return pair.a % pair.t === 0n;
}

/**
 * The largest tick multiple `≤ value` (the BUY-side safe rounding).
 * Requires `value ≥ 0`; already-conformant values come back byte-identical.
 */
export function floorToTick(value: string, tick: string): string | undefined {
  const pair = scaledPair(value, tick);
  if (pair === undefined || pair.a < 0n) return undefined;
  if (pair.a % pair.t === 0n) return value;
  return mulDecimal(tick, (pair.a / pair.t).toString());
}

/**
 * The smallest tick multiple `≥ value` (the SELL-side safe rounding).
 * Requires `value ≥ 0`; already-conformant values come back byte-identical.
 */
export function ceilToTick(value: string, tick: string): string | undefined {
  const pair = scaledPair(value, tick);
  if (pair === undefined || pair.a < 0n) return undefined;
  if (pair.a % pair.t === 0n) return value;
  return mulDecimal(tick, (pair.a / pair.t + 1n).toString());
}

/**
 * How many whole slices of size `sliceShares` fit in `totalShares`, plus the
 * exact remainder as a canonical decimal string — the integer half of §9.10
 * slicing, computed exactly. The remainder is rebuilt with `mulDecimal` and
 * `subDecimal` so no scaled integer leaks to a caller.
 */
export function sliceDivision(
  totalShares: string,
  sliceShares: string,
): { readonly fullSlices: bigint; readonly remainder: string } | undefined {
  const pair = scaledPair(totalShares, sliceShares);
  if (pair === undefined || pair.a < 0n) return undefined;
  const fullSlices = pair.a / pair.t;
  const covered = mulDecimal(sliceShares, fullSlices.toString());
  return { fullSlices, remainder: subDecimal(totalShares, covered) };
}
