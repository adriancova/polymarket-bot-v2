/**
 * Exact price computation — §9.10 "Select maker/taker policy", "Calculate
 * exact tick-conforming prices", "Calculate capped marketable limits for
 * immediate execution".
 *
 * THE POSTURE TABLE (deterministic; the intent's `liquidityPreference` is a
 * CONSTRAINT and its `urgency` is advice within it — the planner never
 * silently rewrites either field, it derives an execution posture):
 *
 * | liquidityPreference \ urgency | PASSIVE | NORMAL | AGGRESSIVE | IMMEDIATE |
 * | --- | --- | --- | --- | --- |
 * | `MAKER_ONLY`      | REST | REST | REST | REST |
 * | `MAKER_PREFERRED` | REST | REST | MARKETABLE | MARKETABLE |
 * | `TAKER_OK`        | REST | REST | MARKETABLE | MARKETABLE |
 * | `TAKER_ONLY`      | MARKETABLE | MARKETABLE | MARKETABLE | MARKETABLE |
 *
 * (`MAKER_PREFERRED` and `TAKER_OK` deliberately collapse: with only a best
 * bid/ask in the inputs there is nothing finer to distinguish them by, and
 * inventing a distinction would be venue behaviour this package must not
 * guess. `REDUCE_POSITION` carries only an urgency: NORMAL → REST,
 * AGGRESSIVE/IMMEDIATE → MARKETABLE.)
 *
 * PRICE RULES, all exact and all rounded toward the SAFE side (`tick.ts`):
 *
 * - REST BUY: join the best bid; cap at `floorToTick(maximumBuyPrice)`. With
 *   no bid, rest AT the floored cap (post-only protects against crossing).
 * - MARKETABLE BUY: `bestAsk + marketableSlippageTicks × tick`, capped at
 *   `floorToTick(maximumBuyPrice)`. With no ask, the floored cap IS the
 *   marketable limit. NEVER UNCAPPED: with neither a book side nor an intent
 *   cap there is no price protection, and the leg refuses
 *   (`PLAN_PRICE_PROTECTION_UNAVAILABLE`) — workplan acceptance 2.
 * - REST SELL: join the best ask; floor at `ceilToTick(minimumSellPrice)`.
 * - MARKETABLE SELL: `bestBid − marketableSlippageTicks × tick`, floored at
 *   `ceilToTick(minimumSellPrice)` and never below one tick.
 *
 * Every emitted price is checked to lie strictly inside (0, 1); a cap that
 * floors to zero or a sell floor that ceilings to 1 refuses
 * (`PLAN_PRICE_OUT_OF_RANGE`) rather than being nudged onto the grid.
 */

import { addDecimal, compareDecimal, subDecimal } from "@polymarket-bot/decimal";
import type {
  LiquidityPreference,
  PositionUrgency,
  ReductionUrgency,
} from "@polymarket-bot/domain";

import { plannerRefusal, type PlannerRefusal } from "./refusals.js";
import { ceilToTick, floorToTick, tickTimes } from "./tick.js";

export type ExecutionPosture = "REST" | "MARKETABLE_LIMIT";

/** The posture table above, as code. */
export function positionPosture(
  liquidityPreference: LiquidityPreference,
  urgency: PositionUrgency,
): ExecutionPosture {
  if (liquidityPreference === "MAKER_ONLY") return "REST";
  if (liquidityPreference === "TAKER_ONLY") return "MARKETABLE_LIMIT";
  return urgency === "AGGRESSIVE" || urgency === "IMMEDIATE" ? "MARKETABLE_LIMIT" : "REST";
}

/** `REDUCE_POSITION` posture: NORMAL rests, AGGRESSIVE/IMMEDIATE cross. */
export function reductionPosture(urgency: ReductionUrgency): ExecutionPosture {
  return urgency === "NORMAL" ? "REST" : "MARKETABLE_LIMIT";
}

export type PriceOutcome =
  | { readonly ok: true; readonly price: string }
  | { readonly ok: false; readonly refusal: PlannerRefusal };

function unprotected(context: Readonly<Record<string, unknown>>): PriceOutcome {
  return {
    ok: false,
    refusal: plannerRefusal(
      "PLAN_PRICE_PROTECTION_UNAVAILABLE",
      "no price bound is derivable for this leg (no usable book side and no intent price cap); an order without price protection is never planned (workplan acceptance 2)",
      context,
    ),
  };
}

function outOfRange(price: string, context: Readonly<Record<string, unknown>>): PriceOutcome {
  return {
    ok: false,
    refusal: plannerRefusal(
      "PLAN_PRICE_OUT_OF_RANGE",
      `the computed limit price "${price}" does not lie strictly inside (0, 1) on the tick grid; the protection cannot be honoured and is refused rather than nudged`,
      context,
    ),
  };
}

function checked(price: string | undefined, context: Readonly<Record<string, unknown>>): PriceOutcome {
  if (price === undefined) return unprotected(context);
  if (compareDecimal(price, "0") <= 0 || compareDecimal(price, "1") >= 0) {
    return outOfRange(price, context);
  }
  return { ok: true, price };
}

/** The tighter (lower) of a computed buy price and the intent's cap. */
function cappedBuy(computed: string | undefined, flooredCap: string | undefined): string | undefined {
  if (computed === undefined) return flooredCap;
  if (flooredCap === undefined) return computed;
  return compareDecimal(computed, flooredCap) <= 0 ? computed : flooredCap;
}

/** The tighter (higher) of a computed sell price and the intent's floor. */
function flooredSell(computed: string | undefined, ceiledFloor: string | undefined): string | undefined {
  if (computed === undefined) return ceiledFloor;
  if (ceiledFloor === undefined) return computed;
  return compareDecimal(computed, ceiledFloor) >= 0 ? computed : ceiledFloor;
}

export interface BuyPriceInputs {
  readonly posture: ExecutionPosture;
  readonly tickSize: string;
  readonly slippageTicks: number;
  readonly bestBid?: string;
  readonly bestAsk?: string;
  readonly maximumBuyPrice?: string;
}

/** The capped, tick-conforming BUY limit for one leg, or a typed refusal. */
export function buyLimitPrice(inputs: BuyPriceInputs): PriceOutcome {
  const context = {
    action: "BUY",
    posture: inputs.posture,
    tickSize: inputs.tickSize,
    ...(inputs.bestBid === undefined ? {} : { bestBid: inputs.bestBid }),
    ...(inputs.bestAsk === undefined ? {} : { bestAsk: inputs.bestAsk }),
    ...(inputs.maximumBuyPrice === undefined ? {} : { maximumBuyPrice: inputs.maximumBuyPrice }),
  };
  const flooredCap =
    inputs.maximumBuyPrice === undefined
      ? undefined
      : floorToTick(inputs.maximumBuyPrice, inputs.tickSize);
  if (inputs.maximumBuyPrice !== undefined && flooredCap === undefined) {
    return unprotected(context);
  }
  if (inputs.posture === "REST") {
    return checked(cappedBuy(inputs.bestBid, flooredCap), context);
  }
  const offset = tickTimes(inputs.tickSize, inputs.slippageTicks);
  const crossing =
    inputs.bestAsk === undefined || offset === undefined
      ? undefined
      : addDecimal(inputs.bestAsk, offset);
  return checked(cappedBuy(crossing, flooredCap), context);
}

export interface SellPriceInputs {
  readonly posture: ExecutionPosture;
  readonly tickSize: string;
  readonly slippageTicks: number;
  readonly bestBid?: string;
  readonly bestAsk?: string;
  readonly minimumSellPrice?: string;
}

/** The floored, tick-conforming SELL limit for one leg, or a typed refusal. */
export function sellLimitPrice(inputs: SellPriceInputs): PriceOutcome {
  const context = {
    action: "SELL",
    posture: inputs.posture,
    tickSize: inputs.tickSize,
    ...(inputs.bestBid === undefined ? {} : { bestBid: inputs.bestBid }),
    ...(inputs.bestAsk === undefined ? {} : { bestAsk: inputs.bestAsk }),
    ...(inputs.minimumSellPrice === undefined ? {} : { minimumSellPrice: inputs.minimumSellPrice }),
  };
  const ceiledFloor =
    inputs.minimumSellPrice === undefined
      ? undefined
      : ceilToTick(inputs.minimumSellPrice, inputs.tickSize);
  if (inputs.minimumSellPrice !== undefined && ceiledFloor === undefined) {
    return unprotected(context);
  }
  if (inputs.posture === "REST") {
    return checked(flooredSell(inputs.bestAsk, ceiledFloor), context);
  }
  const offset = tickTimes(inputs.tickSize, inputs.slippageTicks);
  let crossing: string | undefined;
  if (inputs.bestBid !== undefined && offset !== undefined) {
    const lowered = subDecimal(inputs.bestBid, offset);
    // A marketable sell may never go below one tick — the lowest legal price.
    crossing = compareDecimal(lowered, inputs.tickSize) < 0 ? inputs.tickSize : lowered;
  }
  return checked(flooredSell(crossing, ceiledFloor), context);
}
