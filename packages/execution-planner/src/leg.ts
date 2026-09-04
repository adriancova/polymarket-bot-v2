/**
 * The economic-leg selector — §9.10 "Select economic leg while respecting
 * actual available inventory" (workplan acceptance 1).
 *
 * On a binary market, increasing exposure to outcome D has two venue
 * expressions: BUY the D token, or SELL the opposite token O you already
 * hold. Per share of exposure they cost exactly `price(D ask side)` and
 * `1 − price(O bid side)` respectively, so the selector prices BOTH legs
 * under the intent's posture and takes the cheaper — **but a SELL leg is
 * feasible only up to the instance's ACTUAL unreserved holdings**
 * (`held − reserved`, §6 invariant 10: confirmed actual allocation, never
 * requested size). Inventory the account does not own is never planned;
 * there is no partial mixing of legs in v1 (one leg per plan keeps the
 * §9.10 hierarchy one-dimensional and the fallback explicit).
 *
 * WHEN INVENTORY FORCES THE FALLBACK, THE PLAN SAYS SO: `reason:
 * "INVENTORY_FALLBACK"` records that the cheaper leg existed and was not
 * available, so the provenance of the economics is auditable.
 *
 * DECREASING exposure plans exactly one venue expression: SELL the D token
 * you actually hold. Buying the opposite token also lowers net exposure but
 * is a HEDGE — it commits new collateral and changes worst-case structure —
 * and a planner that substitutes a hedge for an exit is originating a
 * trading decision it has no authority to make (§2: strategies decide,
 * planners express). A sell-down that exceeds free inventory REFUSES
 * (`PLAN_INVENTORY_INSUFFICIENT`) rather than silently downsizing: §7.7's
 * "a risk veto never silently mutates an intent" rule names the correct
 * remedy — a new, linked, smaller record (`resizeApprovedIntent`) — and a
 * caller whose shares are trapped under open orders should cancel those
 * first (§6 invariant 13 makes that cancel schedulable ahead of anything
 * this package plans).
 */

import { compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import type { OutcomeSide } from "@polymarket-bot/domain";

import type { MarketPlanningInput } from "./inputs.js";
import type { LegSelection } from "./plan.js";
import {
  buyLimitPrice,
  sellLimitPrice,
  type ExecutionPosture,
  type PriceOutcome,
} from "./price.js";
import { plannerRefusal, type PlannerRefusal } from "./refusals.js";

/** The opposite outcome token. */
export function oppositeSide(side: OutcomeSide): OutcomeSide {
  return side === "YES" ? "NO" : "YES";
}

/** `held − reserved` for one side — the ONLY inventory a plan may spend. */
export function freeShares(market: MarketPlanningInput, side: OutcomeSide): string {
  const inventory = side === "YES" ? market.inventory.yes : market.inventory.no;
  return subDecimal(inventory.held, inventory.reserved);
}

function bookSide(market: MarketPlanningInput, side: OutcomeSide): {
  readonly bestBid?: string;
  readonly bestAsk?: string;
} {
  const book = market.book;
  if (book === undefined) return {};
  if (side === "YES") {
    return {
      ...(book.yesBestBid === undefined ? {} : { bestBid: book.yesBestBid }),
      ...(book.yesBestAsk === undefined ? {} : { bestAsk: book.yesBestAsk }),
    };
  }
  return {
    ...(book.noBestBid === undefined ? {} : { bestBid: book.noBestBid }),
    ...(book.noBestAsk === undefined ? {} : { bestAsk: book.noBestAsk }),
  };
}

export interface SelectedLeg {
  readonly selection: LegSelection;
  readonly limitPrice: string;
}

export type LegSelectionResult =
  | { readonly ok: true; readonly value: SelectedLeg }
  | { readonly ok: false; readonly refusals: readonly PlannerRefusal[] };

export interface IncreaseLegInputs {
  readonly market: MarketPlanningInput;
  readonly direction: OutcomeSide;
  readonly shares: string;
  readonly posture: ExecutionPosture;
  readonly slippageTicks: number;
  readonly maximumBuyPrice?: string;
  readonly availableCollateral: string;
}

/**
 * Chooses BUY-direction versus SELL-opposite for an exposure INCREASE.
 * Feasibility is checked per leg (price protection derivable; collateral for
 * a buy; ACTUAL free inventory for a sell), then the cheaper per-share
 * exposure cost wins; ties go to BUY_DIRECTION (it leaves inventory intact).
 */
export function selectIncreaseLeg(inputs: IncreaseLegInputs): LegSelectionResult {
  const direction = inputs.direction;
  const opposite = oppositeSide(direction);
  const directionBook = bookSide(inputs.market, direction);
  const oppositeBook = bookSide(inputs.market, opposite);

  const buyPrice: PriceOutcome = buyLimitPrice({
    posture: inputs.posture,
    tickSize: inputs.market.tickSize,
    slippageTicks: inputs.slippageTicks,
    ...directionBook,
    ...(inputs.maximumBuyPrice === undefined ? {} : { maximumBuyPrice: inputs.maximumBuyPrice }),
  });
  // The opposite-leg sell carries no intent floor: the intent's own
  // protection for this exposure is `maximumBuyPrice`, expressed on the sell
  // side as the floor `1 − maximumBuyPrice` — selling opposite BELOW that
  // floor would buy exposure above the strategy's cap.
  const oppositeFloor =
    inputs.maximumBuyPrice === undefined ? undefined : subDecimal("1", inputs.maximumBuyPrice);
  const sellPrice: PriceOutcome = sellLimitPrice({
    posture: inputs.posture,
    tickSize: inputs.market.tickSize,
    slippageTicks: inputs.slippageTicks,
    ...oppositeBook,
    ...(oppositeFloor === undefined ? {} : { minimumSellPrice: oppositeFloor }),
  });

  // --- feasibility ----------------------------------------------------------
  const refusals: PlannerRefusal[] = [];
  let buyFeasible = buyPrice.ok;
  let buyCost: string | undefined;
  if (buyPrice.ok) {
    buyCost = mulDecimal(buyPrice.price, inputs.shares);
    if (compareDecimal(buyCost, inputs.availableCollateral) > 0) {
      buyFeasible = false;
      refusals.push(
        plannerRefusal(
          "PLAN_COLLATERAL_INSUFFICIENT",
          "the buy leg's worst-case cost exceeds available (unreserved) collateral",
          { limitPrice: buyPrice.price, shares: inputs.shares, worstCaseCost: buyCost, availableCollateral: inputs.availableCollateral },
        ),
      );
    }
  } else {
    refusals.push(buyPrice.refusal);
  }

  const freeOpposite = freeShares(inputs.market, opposite);
  const oppositeInventoryCovers = compareDecimal(freeOpposite, inputs.shares) >= 0;
  let sellFeasible = sellPrice.ok && oppositeInventoryCovers;
  if (sellPrice.ok && !oppositeInventoryCovers) {
    // Not a refusal on its own — the buy leg may still carry the intent. It
    // becomes evidence only if NOTHING is feasible.
    sellFeasible = false;
  }

  // --- selection ------------------------------------------------------------
  if (buyFeasible && buyPrice.ok) {
    const buyExposure = buyPrice.price;
    if (sellFeasible && sellPrice.ok) {
      const sellExposure = subDecimal("1", sellPrice.price);
      if (compareDecimal(sellExposure, buyExposure) < 0) {
        return selected("SELL_OPPOSITE", opposite, "SELL", sellExposure, sellPrice.price, "CHEAPER_EXPOSURE");
      }
      return selected("BUY_DIRECTION", direction, "BUY", buyExposure, buyPrice.price, "DIRECT");
    }
    if (sellPrice.ok && !oppositeInventoryCovers) {
      const sellExposure = subDecimal("1", sellPrice.price);
      if (compareDecimal(sellExposure, buyExposure) < 0) {
        // The cheaper leg exists but the account does not own the inventory
        // to express it — acceptance 1's central case, recorded as such.
        return selected("BUY_DIRECTION", direction, "BUY", buyExposure, buyPrice.price, "INVENTORY_FALLBACK");
      }
    }
    return selected("BUY_DIRECTION", direction, "BUY", buyExposure, buyPrice.price, "DIRECT");
  }
  if (sellFeasible && sellPrice.ok) {
    const sellExposure = subDecimal("1", sellPrice.price);
    return selected("SELL_OPPOSITE", opposite, "SELL", sellExposure, sellPrice.price, "ONLY_FEASIBLE");
  }
  if (sellPrice.ok && !oppositeInventoryCovers) {
    refusals.push(
      plannerRefusal(
        "PLAN_INVENTORY_INSUFFICIENT",
        "the sell-opposite leg needs more unreserved opposite-token shares than the instance actually holds (§6 invariant 10: actual allocation, never requested size)",
        { side: opposite, requestedShares: inputs.shares, freeShares: freeOpposite },
      ),
    );
  } else if (!sellPrice.ok) {
    refusals.push(sellPrice.refusal);
  }
  return { ok: false, refusals };
}

function selected(
  choice: LegSelection["selected"],
  side: OutcomeSide,
  action: "BUY" | "SELL",
  effectiveExposurePrice: string,
  limitPrice: string,
  reason: LegSelection["reason"],
): LegSelectionResult {
  return {
    ok: true,
    value: {
      selection: { selected: choice, side, action, effectiveExposurePrice, reason },
      limitPrice,
    },
  };
}

export interface DecreaseLegInputs {
  readonly market: MarketPlanningInput;
  readonly direction: OutcomeSide;
  readonly shares: string;
  readonly posture: ExecutionPosture;
  readonly slippageTicks: number;
  readonly minimumSellPrice?: string;
}

/**
 * Prices the SELL-direction leg for an exposure DECREASE, against ACTUAL free
 * inventory. Refuses — never downsizes — when the holdings do not cover it
 * (module header).
 */
export function selectDecreaseLeg(inputs: DecreaseLegInputs): LegSelectionResult {
  const free = freeShares(inputs.market, inputs.direction);
  if (compareDecimal(inputs.shares, free) > 0) {
    return {
      ok: false,
      refusals: [
        plannerRefusal(
          "PLAN_INVENTORY_INSUFFICIENT",
          "the sell-down exceeds the instance's unreserved holdings; the planner never downsizes silently — a smaller exit is a new linked approved-intent record (§7.7 resize), and shares trapped under open orders are freed by cancelling those orders first (§6 invariant 13)",
          {
            side: inputs.direction,
            requestedShares: inputs.shares,
            freeShares: free,
            held: (inputs.direction === "YES" ? inputs.market.inventory.yes : inputs.market.inventory.no).held,
            reserved: (inputs.direction === "YES" ? inputs.market.inventory.yes : inputs.market.inventory.no).reserved,
          },
        ),
      ],
    };
  }
  const price = sellLimitPrice({
    posture: inputs.posture,
    tickSize: inputs.market.tickSize,
    slippageTicks: inputs.slippageTicks,
    ...bookSide(inputs.market, inputs.direction),
    ...(inputs.minimumSellPrice === undefined ? {} : { minimumSellPrice: inputs.minimumSellPrice }),
  });
  if (!price.ok) return { ok: false, refusals: [price.refusal] };
  const exposure = subDecimal("1", price.price);
  return selected("SELL_DIRECTION", inputs.direction, "SELL", exposure, price.price, "DIRECT");
}
