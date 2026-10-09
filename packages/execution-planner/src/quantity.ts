/**
 * THE QUANTIZER: one executable quantity per planned order (ADR-034 D2;
 * `CO3-N1`).
 *
 * WHY THIS EXISTS. The venue signs an order's input quantity on a 0.01 grid
 * ("Size decimals" is 2 for every tick size: `docs/venue/verified-2026-10-06.md`
 * F-99, F-101), and the SDK floors anything finer before it signs. Before this
 * module, nothing upstream quantized, so an off-grid request reached the OMS
 * unrounded, was signed rounded, and reconciliation compared the two (the
 * closeout's probe E01). D2.2 decides that the planner quantizes ONCE, here,
 * and that every party downstream (the OMS ticket door, the Static Bracket
 * configuration door, the signing adapter) only CHECKS the grid and never
 * rounds.
 *
 * THE RULES (D2.1 to D2.3):
 *
 * - **The grid** comes from the documented precision table, keyed by the
 *   market's tick size ({@link VENUE_PRECISION_TABLE}; A F-99). An unknown
 *   tick size is refused (`PLAN_TICK_SIZE_UNSUPPORTED`), as the SDK refuses it
 *   ("Unsupported tick size"; A F-101).
 * - **Down, never up.** A requested quantity is FLOORED to the grid; the part
 *   below it is recorded as an unexecutable remainder with the reason
 *   `SUB_GRID`. Flooring only shrinks what risk approved; rounding up would
 *   exceed the approval.
 * - **Zero is refused.** A quantity that floors to 0 is refused
 *   `PLAN_BELOW_MINIMUM_ORDER_SIZE`, as a too-small order always was.
 * - **The minimum** (`min_order_size`, C-7's share reading, D2.3) is compared
 *   with the executable shares of a limit order or a FAK/FOK SELL, and with
 *   the SIGNED SHARE SIDE of a FAK/FOK BUY: `ceil` at the tick's Amount
 *   decimals of `collateralTarget ÷ limitPrice` (A F-101, F-105).
 *
 * THE COLLATERAL INPUT. A FAK or FOK BUY's input quantity is pUSD (A F-82,
 * F-84), on the same 0.01 grid. {@link quantizeOrderQuantity} accepts it
 * (`unit: "COLLATERAL"`) and {@link collateralBuySignedShares} computes its
 * signed share side. ADR-034 round `OMS-QTY` builds and tests both, but no
 * planner path produces a collateral target yet: D4.1's conversion and its
 * wiring arrive with `TIF-COLLATERAL` (R3), which owns FAK and FOK.
 *
 * MECHANISM. Exact: canonical decimal strings are scaled to `BigInt`s and back
 * (the same primitive as `tick.ts`); there is no `Number` and no floating
 * point anywhere on an economic value (ADR-001). Every function is TOTAL: an
 * unreadable input is a typed refusal, never an exception.
 */

import {
  compareDecimal,
  decimalPlaces,
  isCanonicalDecimalString,
  mulDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";

import { plannerFailure, plannerRefusal, type PlannerResult } from "./refusals.js";

/** One row of the venue's precision table (A F-99). */
export interface VenuePrecision {
  /** The market's tick size, as a canonical decimal string. */
  readonly tickSize: string;
  /** Decimals of a price on this tick grid. */
  readonly priceDecimals: number;
  /** Decimals of an order's INPUT quantity: shares (limit orders, FAK/FOK SELLs) or pUSD (FAK/FOK BUYs). */
  readonly sizeDecimals: number;
  /** Decimals of the computed side (a limit quote, or a FAK/FOK BUY's shares). */
  readonly amountDecimals: number;
}

/**
 * The documented precision table, verbatim (`docs/venue/verified-2026-10-06.md`
 * F-99: S-D01 lines 258-265), which the pinned SDK applies (F-101:
 * `resolveRoundingConfig`, `size: 2` for each of the six ticks; `amount` 3,
 * 4, 5, 6, 5, 6). `test/unit/execution-planner/quantity.test.ts` pins every
 * row against the report's text.
 */
export const VENUE_PRECISION_TABLE: readonly VenuePrecision[] = Object.freeze([
  Object.freeze({ tickSize: "0.1", priceDecimals: 1, sizeDecimals: 2, amountDecimals: 3 }),
  Object.freeze({ tickSize: "0.01", priceDecimals: 2, sizeDecimals: 2, amountDecimals: 4 }),
  Object.freeze({ tickSize: "0.005", priceDecimals: 3, sizeDecimals: 2, amountDecimals: 5 }),
  Object.freeze({ tickSize: "0.0025", priceDecimals: 4, sizeDecimals: 2, amountDecimals: 6 }),
  Object.freeze({ tickSize: "0.001", priceDecimals: 3, sizeDecimals: 2, amountDecimals: 5 }),
  Object.freeze({ tickSize: "0.0001", priceDecimals: 4, sizeDecimals: 2, amountDecimals: 6 }),
]);

/** The table row for `tickSize`, or `undefined` for a tick size the venue does not document. */
export function venuePrecisionFor(tickSize: string): VenuePrecision | undefined {
  if (typeof tickSize !== "string" || !isCanonicalDecimalString(tickSize)) return undefined;
  return VENUE_PRECISION_TABLE.find((row) => row.tickSize === tickSize);
}

/** The input-quantity grid of `tickSize` (`"0.01"` for every documented tick), or `undefined`. */
export function sizeGridFor(tickSize: string): string | undefined {
  const precision = venuePrecisionFor(tickSize);
  return precision === undefined ? undefined : gridOf(precision.sizeDecimals);
}

/** `10^-decimals` as a canonical decimal string. */
function gridOf(decimals: number): string {
  return decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
}

/** A canonical decimal's exact `numerator / 10^scale`, or `undefined` for a non-canonical or negative value. */
function rational(value: string): { readonly numerator: bigint; readonly scale: number } | undefined {
  if (typeof value !== "string" || !isCanonicalDecimalString(value) || value.startsWith("-")) return undefined;
  const dot = value.indexOf(".");
  const whole = dot === -1 ? value : value.slice(0, dot);
  const fraction = dot === -1 ? "" : value.slice(dot + 1);
  return { numerator: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** True when `value` is a canonical, positive decimal on the `decimals` grid (an exact multiple of `10^-decimals`). */
function isOnDecimalGrid(value: string, decimals: number): boolean {
  if (typeof value !== "string" || !isCanonicalDecimalString(value) || value.startsWith("-")) return false;
  return decimalPlaces(value) <= decimals;
}

/** True when `quantity` is a canonical non-negative decimal on the input-quantity grid of `tickSize`. */
export function isOnSizeGrid(quantity: string, tickSize: string): boolean {
  const precision = venuePrecisionFor(tickSize);
  return precision !== undefined && isOnDecimalGrid(quantity, precision.sizeDecimals);
}

/** What an order's input quantity is denominated in (D2.1). */
export type QuantityUnit = "SHARES" | "COLLATERAL";

/** The only reason the quantizer records a remainder (D2.3). `SUB_MINIMUM` is D4.3's, and R3's. */
export type UnexecutableReason = "SUB_GRID";

/** One quantized input quantity. `requested = executable + unexecutableRemainder`, exactly. */
export interface QuantizedQuantity {
  readonly unit: QuantityUnit;
  readonly tickSize: string;
  /** What was asked for. */
  readonly requested: string;
  /** The requested quantity floored to the grid: what is reserved, ticketed, signed and booked (D2.5). */
  readonly executable: string;
  /** `requested − executable`: in `[0, grid)`. `"0"` when the request was on the grid. */
  readonly unexecutableRemainder: string;
  /** `SUB_GRID` when the remainder is positive; `null` when it is zero. */
  readonly reason: UnexecutableReason | null;
}

/**
 * THE QUANTIZER (D2.2): floors one requested input quantity to the venue's
 * grid for `tickSize`, and records the remainder. Refuses an unknown tick size
 * (`PLAN_TICK_SIZE_UNSUPPORTED`), a quantity that is not a canonical positive
 * decimal (`PLAN_INPUT_INVALID`), and a quantity that floors to zero
 * (`PLAN_BELOW_MINIMUM_ORDER_SIZE`). Never rounds up.
 */
export function quantizeOrderQuantity(input: {
  readonly requested: string;
  readonly unit: QuantityUnit;
  readonly tickSize: string;
}): PlannerResult<QuantizedQuantity> {
  const { requested, unit, tickSize } = input;
  const precision = venuePrecisionFor(tickSize);
  if (precision === undefined) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_TICK_SIZE_UNSUPPORTED",
        "the market's tick size is not in the venue's documented precision table, so its order grid is unknown; the SDK refuses it too (ADR-034 D2.1)",
        { tickSize, documented: VENUE_PRECISION_TABLE.map((row) => row.tickSize) },
      ),
    );
  }
  const parts = rational(requested);
  if (unit !== "SHARES" && unit !== "COLLATERAL") {
    return plannerFailure(plannerRefusal("PLAN_INPUT_INVALID", "an order quantity's unit must be SHARES or COLLATERAL", { unit }));
  }
  if (parts === undefined || parts.numerator <= 0n) {
    return plannerFailure(
      plannerRefusal("PLAN_INPUT_INVALID", "an order quantity must be a canonical positive decimal string", { requested, unit }),
    );
  }
  const grid = gridOf(precision.sizeDecimals);
  let executable: string;
  if (parts.scale <= precision.sizeDecimals) {
    executable = requested;
  } else {
    // floor(requested / grid) grid units, exactly: drop the digits below the grid.
    const units = parts.numerator / 10n ** BigInt(parts.scale - precision.sizeDecimals);
    executable = mulDecimal(grid, units.toString());
  }
  if (compareDecimal(executable, "0") <= 0) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_BELOW_MINIMUM_ORDER_SIZE",
        "the quantity floors to zero on the venue's grid; nothing executable remains (ADR-034 D2.3)",
        { requested, unit, grid },
      ),
    );
  }
  const unexecutableRemainder = subDecimal(requested, executable);
  return {
    ok: true,
    value: Object.freeze({
      unit,
      tickSize,
      requested,
      executable,
      unexecutableRemainder,
      reason: compareDecimal(unexecutableRemainder, "0") > 0 ? "SUB_GRID" : null,
    }),
  };
}

/**
 * The signed share side of a collateral-targeted FAK or FOK BUY (D2.3, D2.4's
 * table): `ceil` at the tick's Amount decimals of `collateralTarget ÷
 * limitPrice`, the SDK's protected rounding (`computeMarketOrderAmounts` with
 * a `maxPrice`, `divideAmountByPrice` rounding up; A F-101). The target must
 * already be on the grid; this function never quantizes it.
 */
export function collateralBuySignedShares(input: {
  readonly collateralTarget: string;
  readonly limitPrice: string;
  readonly tickSize: string;
}): PlannerResult<string> {
  const precision = venuePrecisionFor(input.tickSize);
  if (precision === undefined) {
    return plannerFailure(
      plannerRefusal("PLAN_TICK_SIZE_UNSUPPORTED", "the market's tick size is not in the venue's documented precision table", {
        tickSize: input.tickSize,
      }),
    );
  }
  const target = rational(input.collateralTarget);
  const price = rational(input.limitPrice);
  if (
    target === undefined ||
    target.numerator <= 0n ||
    !isOnDecimalGrid(input.collateralTarget, precision.sizeDecimals) ||
    price === undefined ||
    price.numerator <= 0n ||
    compareDecimal(input.limitPrice, "1") >= 0
  ) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_INPUT_INVALID",
        "a collateral target must be a positive decimal on the venue's grid, and its limit price a decimal strictly inside (0, 1)",
        { collateralTarget: input.collateralTarget, limitPrice: input.limitPrice },
      ),
    );
  }
  // shares = target ÷ price, in units of 10^-amountDecimals, rounded UP:
  //   (t / 10^ts) / (p / 10^ps) × 10^ad = t × 10^(ps + ad) / (p × 10^ts).
  const numerator = target.numerator * 10n ** BigInt(price.scale + precision.amountDecimals);
  const denominator = price.numerator * 10n ** BigInt(target.scale);
  const quotient = numerator / denominator;
  const units = numerator % denominator === 0n ? quotient : quotient + 1n;
  return { ok: true, value: mulDecimal(gridOf(precision.amountDecimals), units.toString()) };
}

/** What an order's minimum is judged on (D2.3, the share reading of C-7). */
export type MinimumBasis =
  | { readonly kind: "SHARES"; readonly executableShares: string }
  | { readonly kind: "COLLATERAL_BUY"; readonly collateralTarget: string; readonly limitPrice: string };

/**
 * D2.3's minimum check: the quantity compared with `min_order_size` is the
 * executable shares of a limit order or a FAK/FOK SELL, and the signed share
 * side of a FAK/FOK BUY. Below the minimum is refused
 * `PLAN_BELOW_MINIMUM_ORDER_SIZE`. Returns the compared share quantity.
 */
export function checkMinimumOrderSize(
  basis: MinimumBasis,
  minimumOrderSize: string,
  tickSize: string,
): PlannerResult<string> {
  let compared: string;
  if (basis.kind === "SHARES") {
    compared = basis.executableShares;
  } else {
    const signed = collateralBuySignedShares({
      collateralTarget: basis.collateralTarget,
      limitPrice: basis.limitPrice,
      tickSize,
    });
    if (!signed.ok) return signed;
    compared = signed.value;
  }
  if (compareDecimal(compared, minimumOrderSize) < 0) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_BELOW_MINIMUM_ORDER_SIZE",
        "the executable size is below the market's minimum order size; the venue would reject it, and resizing the intent is not this package's decision",
        { basis: basis.kind, comparedShares: compared, minimumOrderSize },
      ),
    );
  }
  return { ok: true, value: compared };
}
