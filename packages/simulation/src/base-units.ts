/**
 * Integer base units and the documented maker-fill formula (V2-10; F-63, F-73).
 *
 * ## The venue facts, verbatim (`docs/venue/verified-2026-10-05.md`)
 *
 * F-73 (S-D04 lines 55-56): "Six-decimal base units: `1_000_000` is one pUSD or
 * one share."
 *
 * F-63 (S-D02 lines 135-149):
 *
 * > "If you calculate fills yourself, use integer base units and the maker's
 * > signed amounts for each maker fill:"
 * > `counterAmount = floor(makerAssetFill × takerAmount / makerAmount)`
 * >
 * > "`makerAssetFill` is collateral for a BUY and shares for a SELL. ExchangeV3
 * > reduces a BUY's remaining collateral budget by the amount actually spent.
 * > CLOB GTC/GTD BUY targets are shares; FOK/FAK BUY targets are collateral."
 * >
 * > "Reconcile fills and fees separately: BUY fees add to collateral spend;
 * > SELL fees are deducted from proceeds."
 *
 * {@link counterAmount} is that formula and nothing else: bigints in, a bigint
 * out, `/` on non-negative bigints being exactly `floor`. No binary float
 * touches it (ADR-001; handoff §6 invariant 1).
 *
 * ## What this module adds to the facts, each an INFERENCE it states
 *
 * 1. **A recorded book level is ONE maker order signed at exactly its price.**
 *    A recorded level carries an aggregate size at a price; it does not carry
 *    any maker's `makerAmount`/`takerAmount`. The simulator therefore takes the
 *    level's PRICE as the maker's signed ratio: a maker SELL at `p = a / 10^k`
 *    signs `makerAmount : takerAmount = 10^k : a` (shares : pUSD), a maker BUY
 *    `a : 10^k` (pUSD : shares). That is the ratio of every order whose
 *    `size × price` is a whole number of base units, which the SDK's own
 *    limit-order amounts are for any size of at most two decimals (SDK 0.11.0,
 *    INF). A level that is really several maker orders is floored once here
 *    and once per order at the venue, so a BUY taking it pays the venue up to
 *    one base unit LESS per additional order than this model charges: the
 *    model errs against us. Our own resting order is a maker too, signed at
 *    its limit price.
 * 2. **Which maker-asset fill a target selects** is not documented; F-63 gives
 *    only the counter of a fill once it is chosen. The choices, all in whole
 *    base units and all flooring, so no target is ever exceeded:
 *    - a maker SELL (shares) filled for a SHARE quantity: that quantity,
 *      floored to whole base units;
 *    - a maker SELL filled from a COLLATERAL budget (a FOK/FAK BUY):
 *      `floor(budget × makerAmount / takerAmount)`, the shares the budget buys
 *      at the maker's price, capped at the level's size;
 *    - a maker BUY (pUSD) filled for a SHARE quantity (our SELL, or a taker's
 *      SELL against our resting BUY): `floor(shares × price)`, the collateral
 *      those shares are worth at the maker's price. The shares that then move
 *      are F-63's counter of it, which is exactly the quantity asked whenever
 *      `shares × price` is a whole number of base units, and otherwise up to
 *      `ceil(1 / price)` base units fewer.
 * 3. **A quantity finer than one base unit is floored** before it is filled:
 *    a fill moves whole base units (F-73). Rounding up would fill a fraction no
 *    order could have signed.
 */

import { isCanonicalDecimalString } from "@polymarket-bot/decimal";

import { describeForRefusal, simulationFailure, simulationOk, totally, type SimulationResult } from "./refusals.js";

/** F-73: "`1_000_000` is one pUSD or one share." */
export const BASE_UNITS_PER_WHOLE = 1_000_000n;

/** F-73's six decimals, as the count of fractional digits one base unit has. */
export const BASE_UNIT_DECIMAL_PLACES = 6;

/**
 * F-63, verbatim: `counterAmount = floor(makerAssetFill × takerAmount / makerAmount)`.
 *
 * All three arguments are integer base units (or, for the two signed amounts,
 * any pair in the maker's signed ratio). Total: anything other than three
 * bigints, a negative fill or amount, or a non-positive `makerAmount` (the
 * formula divides by it) is a typed refusal, never a `RangeError`.
 */
export function counterAmount(
  makerAssetFill: bigint,
  makerAmount: bigint,
  takerAmount: bigint,
): SimulationResult<bigint> {
  if (typeof makerAssetFill !== "bigint" || typeof makerAmount !== "bigint" || typeof takerAmount !== "bigint") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "F-63's counter amount is computed in integer base units: makerAssetFill, makerAmount and takerAmount are bigints",
      {
        makerAssetFill: describeForRefusal(makerAssetFill),
        makerAmount: describeForRefusal(makerAmount),
        takerAmount: describeForRefusal(takerAmount),
      },
    );
  }
  if (makerAssetFill < 0n || takerAmount < 0n || makerAmount <= 0n) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "F-63's counter amount needs a non-negative fill and taker amount and a strictly positive maker amount (the formula divides by it)",
      {
        makerAssetFill: makerAssetFill.toString(),
        makerAmount: makerAmount.toString(),
        takerAmount: takerAmount.toString(),
      },
    );
  }
  // Non-negative operands: bigint division truncates toward zero, which IS floor.
  return simulationOk((makerAssetFill * takerAmount) / makerAmount);
}

/**
 * The ONE documented conversion of a FOK or FAK BUY's size to its collateral
 * target (V2-10; F-63: "FOK/FAK BUY targets are collateral"): the planned size
 * in shares times the order's LIMIT price, floored to whole base units.
 *
 * The limit price is the price the strategy's share size was sized at, so the
 * target is the most the order may spend before fees; flooring never spends a
 * fraction of a base unit the strategy did not budget. A target that floors to
 * zero is refused: an order that may spend nothing is not an order.
 */
export function collateralTargetAtLimitPrice(
  shares: string,
  limitPrice: string,
): SimulationResult<string> {
  return totally("converting a FOK/FAK BUY's share size to its collateral target", () => {
    if (!isCanonicalDecimalString(shares) || !isCanonicalDecimalString(limitPrice)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a size and a limit price are canonical decimal strings (§6 invariant 1)",
        { shares: describeForRefusal(shares), limitPrice: describeForRefusal(limitPrice) },
      );
    }
    const size = exactRatio(shares);
    const price = exactRatio(limitPrice);
    if (size.numerator <= 0n || price.numerator <= 0n) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a FOK/FAK BUY's size and limit price are strictly positive",
        { shares, limitPrice },
      );
    }
    const target =
      (size.numerator * price.numerator * BASE_UNITS_PER_WHOLE) / (size.denominator * price.denominator);
    if (target <= 0n) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "the FOK/FAK BUY's collateral target (size × limit price, floored to whole base units, F-73) is zero",
        { shares, limitPrice },
      );
    }
    return simulationOk(fromBaseUnits(target));
  });
}

// ---------------------------------------------------------------------------
// The maker fill, both legs
// ---------------------------------------------------------------------------

/** The side of the MAKER order a fill executed: the counterparty when we take, us when we rest. */
export type MakerSide = "BUY" | "SELL";

/** What one maker fill moved, both legs, as canonical decimals of whole base units. */
export interface MakerFillLegs {
  /** Shares that changed hands. */
  readonly shares: string;
  /** pUSD that changed hands, before any fee (F-63: fills and fees reconcile separately). */
  readonly collateral: string;
}

/**
 * The legs of one maker fill selected by a SHARE quantity (inference 2 of the
 * module header). Internal: its callers validated `price` (strictly positive)
 * and `shares` (non-negative) as canonical decimals first.
 */
export function makerFillForShares(makerSide: MakerSide, price: string, shares: string): SimulationResult<MakerFillLegs> {
  const ratio = exactRatio(price);
  const wanted = floorToBaseUnits(shares);
  if (makerSide === "SELL") {
    // The maker's asset is shares: the fill IS the share quantity, and the
    // collateral is F-63's counter at `makerAmount : takerAmount = 10^k : a`.
    const collateral = counterAmount(wanted, ratio.denominator, ratio.numerator);
    if (!collateral.ok) return collateral;
    return simulationOk({ shares: fromBaseUnits(wanted), collateral: fromBaseUnits(collateral.value) });
  }
  // The maker's asset is pUSD: its fill is what the shares are worth at its
  // price, floored, and the shares that move are F-63's counter of THAT at
  // `makerAmount : takerAmount = a : 10^k`.
  const makerAssetFill = (wanted * ratio.numerator) / ratio.denominator;
  const shareLeg = counterAmount(makerAssetFill, ratio.numerator, ratio.denominator);
  if (!shareLeg.ok) return shareLeg;
  return simulationOk({ shares: fromBaseUnits(shareLeg.value), collateral: fromBaseUnits(makerAssetFill) });
}

/** The legs of one maker SELL filled from a collateral budget, and whether the budget bound it. */
export interface BudgetedMakerFill extends MakerFillLegs {
  /** `true` when the budget, not the level's size, decided the fill. */
  readonly boundByBudget: boolean;
}

/**
 * The legs of one maker SELL filled from a COLLATERAL budget: a FOK/FAK BUY
 * taking an ask level (inference 2 of the module header). The shares are what
 * the budget buys at the maker's price, floored and capped at the level's
 * size; the collateral is F-63's counter of those shares, which is what
 * "ExchangeV3 reduces a BUY's remaining collateral budget by" (F-63). Internal:
 * its callers validated every operand as a canonical decimal, the price
 * strictly positive and the other two non-negative.
 */
export function makerSellForBudget(
  price: string,
  budget: string,
  levelShares: string,
): SimulationResult<BudgetedMakerFill> {
  const ratio = exactRatio(price);
  const budgetUnits = floorToBaseUnits(budget);
  const levelUnits = floorToBaseUnits(levelShares);
  const affordable = (budgetUnits * ratio.denominator) / ratio.numerator;
  const boundByBudget = affordable <= levelUnits;
  const makerAssetFill = boundByBudget ? affordable : levelUnits;
  const collateral = counterAmount(makerAssetFill, ratio.denominator, ratio.numerator);
  if (!collateral.ok) return collateral;
  return simulationOk({
    shares: fromBaseUnits(makerAssetFill),
    collateral: fromBaseUnits(collateral.value),
    boundByBudget,
  });
}

// ---------------------------------------------------------------------------
// Exact conversions
// ---------------------------------------------------------------------------

/** A canonical decimal as the exact rational `numerator / denominator`, `denominator = 10^places`. */
interface ExactRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * Reads a CANONICAL decimal string (`-? (0 | [1-9][0-9]*) (. [0-9]+)?`) as an
 * exact rational. Internal: every caller has run `isCanonicalDecimalString`.
 */
function exactRatio(value: string): ExactRatio {
  const negative = value.startsWith("-");
  const magnitude = negative ? value.slice(1) : value;
  const dot = magnitude.indexOf(".");
  const integerDigits = dot < 0 ? magnitude : magnitude.slice(0, dot);
  const fractionDigits = dot < 0 ? "" : magnitude.slice(dot + 1);
  const digits = BigInt(`${integerDigits}${fractionDigits}`);
  return {
    numerator: negative ? -digits : digits,
    denominator: 10n ** BigInt(fractionDigits.length),
  };
}

/**
 * `floor(value × 10^6)` for a canonical NON-NEGATIVE decimal: the whole base
 * units it holds (inference 3 of the module header). Exact for a value of at
 * most six decimals, in which case {@link fromBaseUnits} returns it unchanged.
 */
export function floorToBaseUnits(value: string): bigint {
  const ratio = exactRatio(value);
  return (ratio.numerator * BASE_UNITS_PER_WHOLE) / ratio.denominator;
}

/** Whole base units as the canonical decimal string they denote. Exact. */
export function fromBaseUnits(units: bigint): string {
  const negative = units < 0n;
  const magnitude = (negative ? -units : units).toString().padStart(BASE_UNIT_DECIMAL_PLACES + 1, "0");
  const integerDigits = magnitude.slice(0, magnitude.length - BASE_UNIT_DECIMAL_PLACES);
  const fractionDigits = magnitude.slice(magnitude.length - BASE_UNIT_DECIMAL_PLACES).replace(/0+$/u, "");
  const text = fractionDigits === "" ? integerDigits : `${integerDigits}.${fractionDigits}`;
  if (text === "0") return "0";
  return negative ? `-${text}` : text;
}
