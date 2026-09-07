/**
 * Normalized intent view — the one place an intent is turned into the legs the
 * §9.8 checks reason about.
 *
 * Every §7.7 intent shape is reduced to `(marketId, side?, action, shares,
 * boundedCost)` legs plus a DISPOSITION. Doing this once, here, is what keeps
 * the pipeline in `engine.ts` from re-deriving "how much does this cost" five
 * times with five slightly different answers.
 *
 * DISPOSITION is derived from the intent TYPE alone:
 *
 * | Type | Disposition | Why |
 * | --- | --- | --- |
 * | `CANCEL` | `CANCEL` | §6 invariant 13: "Safety cancellation outranks new order placement" |
 * | `REDUCE_POSITION` | `EXIT` | §7.7's dedicated reduction intent |
 * | `POSITION`, `QUOTE`, `BASKET` | `ENTRY` | everything else is treated as new risk |
 *
 * A `POSITION` intent whose delta happens to reduce a holding is therefore
 * still classified `ENTRY` and gets the STRICTER treatment. That is deliberate
 * and fails closed: entry treatment can only refuse more, and refusing to place
 * a new order is the safe direction (§6 invariant 12 — the mandated response to
 * unknown state is cancel-and-reconcile, not act). A strategy that means "exit"
 * has `REDUCE_POSITION` for it. Recorded as an assumption in
 * `docs/handoffs/WP-180.md`.
 *
 * CONSERVATIVE BOUNDING (each choice overstates risk, never understates):
 *
 * - A BUY leg's cost is bounded by the TIGHTEST ceiling the intent supplies
 *   (`maximumTotalCost` and/or `maximumBuyPrice × shares`); when the intent
 *   supplies NO ceiling the cost is `undefined` — UNBOUNDED — and the caller
 *   fails closed rather than guessing a price.
 * - A SELL leg commits no new pUSD and is assumed NOT to fill, so it neither
 *   reduces committed cost nor releases tokens in the worst case.
 * - A `QUOTE` intent's levels carry no outcome token (§7.7's `QuoteLevel` is
 *   price + size only), so its bought shares are UNASSIGNED and the worst-case
 *   builder places them on whichever token settles worse.
 */

import {
  absDecimal,
  addDecimal,
  compareDecimal,
  mulDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";
import type {
  Intent,
  MoneyString,
  OutcomeSide,
  PriceString,
  SharesString,
} from "@polymarket-bot/domain";

import { deepFreeze } from "./guards.js";
import type { PortfolioView } from "./inputs.js";
import { appendData } from "./plain-data.js";
import { riskRefusal, type RiskRefusal } from "./result.js";

/** How the pipeline treats this intent. See the module header table. */
export type IntentDisposition = "ENTRY" | "EXIT" | "CANCEL";

/** One normalized leg of an intent. */
export interface IntentLeg {
  readonly marketId: string;
  /**
   * The outcome token, when the intent names one. `undefined` means the shape
   * does not carry a token (a `QUOTE` level) and the worst case must assume
   * the worse assignment.
   */
  readonly side: OutcomeSide | undefined;
  readonly action: "BUY" | "SELL";
  /** Magnitude, always non-negative. */
  readonly shares: SharesString;
  /** The limit price, when the intent bounds one. */
  readonly limitPrice: PriceString | undefined;
  /**
   * The tightest pUSD ceiling this leg can cost, or `undefined` when the
   * intent bounds none. SELL legs are exactly `"0"`.
   */
  readonly boundedCost: MoneyString | undefined;
}

export interface IntentView {
  readonly disposition: IntentDisposition;
  /** §7.7 gives `CANCEL` and `REDUCE_POSITION` no `intentId`. */
  readonly intentId: string | undefined;
  /** `validUntil`, for the shapes that carry one. */
  readonly validUntil: string | undefined;
  readonly marketIds: readonly string[];
  readonly legs: readonly IntentLeg[];
  /**
   * Σ of every leg's `boundedCost`, or `undefined` when ANY leg is unbounded.
   * `undefined` is the fail-closed signal, not a zero.
   */
  readonly boundedCost: MoneyString | undefined;
  /** Σ of every BUY leg's shares (the size the participation limit sees). */
  readonly buyShares: SharesString;
}

/** Total shares this portfolio holds of one market's token. */
export function heldShares(
  portfolio: PortfolioView,
  marketId: string,
  side: OutcomeSide,
): SharesString {
  let held: SharesString = "0";
  for (const position of portfolio.positions) {
    if (position.marketId === marketId && position.side === side) {
      held = addDecimal(held, position.shares);
    }
  }
  return held;
}

/** The tighter of two optional ceilings; `undefined` when both are absent. */
function tightest(
  left: MoneyString | undefined,
  right: MoneyString | undefined,
): MoneyString | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return compareDecimal(left, right) <= 0 ? left : right;
}

function sellLeg(
  marketId: string,
  side: OutcomeSide | undefined,
  shares: SharesString,
  limitPrice: PriceString | undefined,
): IntentLeg {
  return { marketId, side, action: "SELL", shares, limitPrice, boundedCost: "0" };
}

/**
 * Normalizes an intent into legs, or the refusals that make it un-normalizable.
 *
 * The only refusal codes this function emits are the ones that are properties
 * of the INTENT SHAPE itself: a zero-delta position (nothing to do) and a
 * basket leg with no price ceiling (nothing bounds it).
 */
export function buildIntentView(
  intent: Intent,
  portfolio: PortfolioView,
): { readonly view: IntentView; readonly refusals: readonly RiskRefusal[] } {
  const refusals: RiskRefusal[] = [];
  const legs: IntentLeg[] = [];
  let disposition: IntentDisposition = "ENTRY";
  let intentId: string | undefined;
  let validUntil: string | undefined;
  let marketIds: string[] = [];

  switch (intent.type) {
    case "CANCEL": {
      disposition = "CANCEL";
      marketIds = intent.marketId === undefined ? [] : [intent.marketId];
      break;
    }
    case "REDUCE_POSITION": {
      disposition = "EXIT";
      marketIds = [intent.marketId];
      // A reduction sells down toward `targetShares`; the reduction leg is a
      // SELL of the excess on each side the portfolio holds. Assumed not to
      // fill for worst-case purposes, so it never lowers the bound.
      for (const side of ["YES", "NO"] as const) {
        const held = heldShares(portfolio, intent.marketId, side);
        const excess = subtractFloorZero(held, absDecimal(intent.targetShares));
        if (compareDecimal(excess, "0") > 0) {
          appendData(legs, sellLeg(intent.marketId, side, excess, intent.minimumSellPrice));
        }
      }
      break;
    }
    case "POSITION": {
      intentId = intent.intentId;
      validUntil = intent.validUntil;
      marketIds = [intent.marketId];
      const held = heldShares(portfolio, intent.marketId, intent.direction);
      const delta =
        intent.targetMode === "DELTA"
          ? intent.targetShares
          : subDecimal(intent.targetShares, held);
      if (compareDecimal(delta, "0") === 0) {
        appendData(
          refusals,
          riskRefusal(
            "RISK_ZERO_DELTA",
            "the position intent resolves to a zero share delta; there is nothing to execute",
            { marketId: intent.marketId, targetMode: intent.targetMode, held },
          ),
        );
        break;
      }
      const shares = absDecimal(delta);
      if (compareDecimal(delta, "0") > 0) {
        const byPrice =
          intent.maximumBuyPrice === undefined
            ? undefined
            : mulDecimal(intent.maximumBuyPrice, shares);
        appendData(legs, {
          marketId: intent.marketId,
          side: intent.direction,
          action: "BUY",
          shares,
          limitPrice: intent.maximumBuyPrice,
          boundedCost: tightest(byPrice, intent.maximumTotalCost),
        });
      } else {
        appendData(
          legs,
          sellLeg(intent.marketId, intent.direction, shares, intent.minimumSellPrice),
        );
      }
      break;
    }
    case "QUOTE": {
      intentId = intent.intentId;
      marketIds = [intent.marketId];
      for (const bid of intent.bids) {
        if (compareDecimal(bid.shares, "0") === 0) continue;
        appendData(legs, {
          marketId: intent.marketId,
          // §7.7's `QuoteLevel` names no outcome token — see the module header.
          side: undefined,
          action: "BUY",
          shares: bid.shares,
          limitPrice: bid.price,
          boundedCost: mulDecimal(bid.price, bid.shares),
        });
      }
      for (const ask of intent.asks) {
        if (compareDecimal(ask.shares, "0") === 0) continue;
        appendData(legs, sellLeg(intent.marketId, undefined, ask.shares, ask.price));
      }
      break;
    }
    case "BASKET": {
      intentId = intent.intentId;
      validUntil = intent.validUntil;
      marketIds = [...new Set(intent.legs.map((leg) => leg.marketId))];
      for (const leg of intent.legs) {
        const shares = absDecimal(leg.targetShares);
        if (compareDecimal(shares, "0") === 0) continue;
        if (compareDecimal(leg.targetShares, "0") > 0) {
          if (leg.maximumBuyPrice === undefined) {
            appendData(
              refusals,
              riskRefusal(
                "RISK_BASKET_LEG_UNBOUNDED",
                "a buying basket leg carries no maximumBuyPrice, so its contractual cost is unbounded (§9.10: a coordinated basket is not atomic — each leg's own risk must be bounded)",
                { marketId: leg.marketId, direction: leg.direction, targetShares: leg.targetShares },
              ),
            );
            continue;
          }
          appendData(legs, {
            marketId: leg.marketId,
            side: leg.direction,
            action: "BUY",
            shares,
            limitPrice: leg.maximumBuyPrice,
            boundedCost: mulDecimal(leg.maximumBuyPrice, shares),
          });
          continue;
        }
        appendData(legs, sellLeg(leg.marketId, leg.direction, shares, leg.minimumSellPrice));
      }
      break;
    }
  }

  let boundedCost: MoneyString | undefined = "0";
  let buyShares: SharesString = "0";
  for (const leg of legs) {
    if (leg.action === "BUY") {
      buyShares = addDecimal(buyShares, leg.shares);
    }
    if (boundedCost === undefined) continue;
    boundedCost = leg.boundedCost === undefined ? undefined : addDecimal(boundedCost, leg.boundedCost);
  }
  // A basket's own `maximumCombinedCost` is a second, always-present ceiling.
  if (intent.type === "BASKET") {
    boundedCost = tightest(boundedCost, intent.maximumCombinedCost);
  }

  return {
    view: deepFreeze({
      disposition,
      intentId,
      validUntil,
      marketIds,
      legs,
      boundedCost,
      buyShares,
    }),
    refusals: deepFreeze(refusals),
  };
}

/** `left − right`, floored at `"0"` (a magnitude, never negative). */
function subtractFloorZero(left: SharesString, right: SharesString): SharesString {
  return compareDecimal(left, right) <= 0 ? "0" : subDecimal(left, right);
}
