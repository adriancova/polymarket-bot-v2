/**
 * Worst-case lot construction — turns "portfolio + resting orders + this
 * intent" into the per-market holding lots `worst-case.ts` assesses.
 *
 * The measure is a PORTFOLIO measure (§9.8 "maximum contractual loss", "gross
 * capital committed"), so every market the account touches enters the lot set,
 * not only the markets the intent names. An intent that is individually tiny
 * still breaches the limit when the book behind it is already full — which is
 * the whole point of checking it here rather than per order.
 *
 * WHAT CONSUMES THE BOUND (workplan acceptance 1, restated on the risk side —
 * open orders and positions BOTH consume):
 *
 * - a position contributes its shares and its `costBasis`;
 * - a resting BUY order contributes `shares` and `price × shares` — it can fill
 *   at any moment, so it is counted as if it already had;
 * - the candidate intent's BUY legs contribute their shares and their bounded
 *   cost;
 * - resting SELL orders and SELL legs contribute NOTHING — assumed not to fill,
 *   which retains the exposed tokens and forgoes the proceeds. Both halves of
 *   that assumption overstate loss.
 *
 * UNASSIGNED SHARES. A `QUOTE` level names no outcome token (§7.7). Its bought
 * shares are placed on whichever token makes the market's worst verified
 * settlement value LOWER, evaluated per market with the same exact per-outcome
 * arithmetic the assessment uses. Never split, never averaged.
 */

import { addDecimal, compareDecimal, mulDecimal } from "@polymarket-bot/decimal";
import type { MoneyString, SharesString } from "@polymarket-bot/domain";

import type { IntentView } from "./intent-view.js";
import type { PortfolioView } from "./inputs.js";
import {
  settlementValueUnderOutcome,
  VERIFIED_TERMINAL_OUTCOMES,
  type MarketHoldingLot,
} from "./worst-case.js";

interface MutableLot {
  yesShares: SharesString;
  noShares: SharesString;
  unassignedShares: SharesString;
  committedCost: MoneyString;
}

function emptyLot(): MutableLot {
  return { yesShares: "0", noShares: "0", unassignedShares: "0", committedCost: "0" };
}

/** The lowest both-token settlement value over the three verified outcomes. */
function worstVerifiedValue(yesShares: SharesString, noShares: SharesString): MoneyString {
  let worst: MoneyString | undefined;
  for (const outcome of VERIFIED_TERMINAL_OUTCOMES) {
    const value = settlementValueUnderOutcome(yesShares, noShares, outcome);
    if (worst === undefined || compareDecimal(value, worst) < 0) {
      worst = value;
    }
  }
  // `VERIFIED_TERMINAL_OUTCOMES` is a non-empty literal tuple, so `worst` is
  // always assigned; the fallback keeps the function total without a cast.
  return worst ?? "0";
}

/**
 * Places unassigned shares on the token that settles WORSE for the holder.
 * Ties keep them on YES; the two values are equal, so the choice is immaterial.
 */
function assignUnassigned(lot: MutableLot): { yesShares: SharesString; noShares: SharesString } {
  if (compareDecimal(lot.unassignedShares, "0") === 0) {
    return { yesShares: lot.yesShares, noShares: lot.noShares };
  }
  const asYes = addDecimal(lot.yesShares, lot.unassignedShares);
  const asNo = addDecimal(lot.noShares, lot.unassignedShares);
  const yesAssignment = worstVerifiedValue(asYes, lot.noShares);
  const noAssignment = worstVerifiedValue(lot.yesShares, asNo);
  return compareDecimal(yesAssignment, noAssignment) <= 0
    ? { yesShares: asYes, noShares: lot.noShares }
    : { yesShares: lot.yesShares, noShares: asNo };
}

/**
 * Builds the lot set for `portfolio` with `view`'s BUY legs added.
 *
 * Returns `undefined` when any BUY leg has no bounded cost: an unbounded lot
 * set has no worst case, and inventing a price to close the gap is exactly the
 * kind of guess this package refuses to make. The caller turns that into
 * `RISK_WORST_CASE_UNBOUNDED`.
 */
export function buildWorstCaseLots(
  portfolio: PortfolioView,
  view: IntentView,
): readonly MarketHoldingLot[] | undefined {
  const lots = new Map<string, MutableLot>();
  const lotFor = (marketId: string): MutableLot => {
    const existing = lots.get(marketId);
    if (existing !== undefined) return existing;
    const created = emptyLot();
    lots.set(marketId, created);
    return created;
  };

  for (const position of portfolio.positions) {
    const lot = lotFor(position.marketId);
    if (position.side === "YES") {
      lot.yesShares = addDecimal(lot.yesShares, position.shares);
    } else {
      lot.noShares = addDecimal(lot.noShares, position.shares);
    }
    lot.committedCost = addDecimal(lot.committedCost, position.costBasis);
  }

  for (const order of portfolio.openOrders) {
    if (order.action !== "BUY") continue;
    const lot = lotFor(order.marketId);
    if (order.side === "YES") {
      lot.yesShares = addDecimal(lot.yesShares, order.shares);
    } else {
      lot.noShares = addDecimal(lot.noShares, order.shares);
    }
    lot.committedCost = addDecimal(lot.committedCost, mulDecimal(order.price, order.shares));
  }

  for (const leg of view.legs) {
    if (leg.action !== "BUY") continue;
    if (leg.boundedCost === undefined) return undefined;
    const lot = lotFor(leg.marketId);
    if (leg.side === "YES") {
      lot.yesShares = addDecimal(lot.yesShares, leg.shares);
    } else if (leg.side === "NO") {
      lot.noShares = addDecimal(lot.noShares, leg.shares);
    } else {
      lot.unassignedShares = addDecimal(lot.unassignedShares, leg.shares);
    }
    lot.committedCost = addDecimal(lot.committedCost, leg.boundedCost);
  }

  const built: MarketHoldingLot[] = [];
  for (const [marketId, lot] of lots) {
    const assigned = assignUnassigned(lot);
    built.push({
      marketId,
      yesShares: assigned.yesShares,
      noShares: assigned.noShares,
      committedCost: lot.committedCost,
    });
  }
  // Deterministic order: the assessment is additive, but a stable lot order
  // makes the per-market evidence on a refusal reproducible.
  built.sort((left, right) => (left.marketId < right.marketId ? -1 : left.marketId > right.marketId ? 1 : 0));
  return built;
}
