/**
 * Normalized intent view — the one place an intent is turned into the legs the
 * §9.8 checks reason about.
 *
 * Every §7.7 intent shape is reduced to `(marketId, side?, action, shares,
 * boundedCost)` legs plus a DISPOSITION. Doing this once, here, is what keeps
 * the pipeline in `engine.ts` from re-deriving "how much does this cost" five
 * times with five slightly different answers.
 *
 * DISPOSITION is derived from the intent TYPE and, for a `POSITION`, from its
 * EFFECT ON THE SUPPLIED PORTFOLIO — never from a tag, a label, or anything
 * else the producer says about itself:
 *
 * | Type | Disposition | Why |
 * | --- | --- | --- |
 * | `CANCEL` | `CANCEL` | §6 invariant 13: "Safety cancellation outranks new order placement" |
 * | `REDUCE_POSITION` | `EXIT` | §7.7's dedicated reduction intent |
 * | `POSITION` resolving to a FULLY-COVERED SELL | `EXIT` | see {@link coveredReduction} — it commits nothing and can only shrink a confirmed holding |
 * | every other `POSITION`, and every `QUOTE` / `BASKET` | `ENTRY` | new risk, or risk this view cannot prove is not new |
 *
 * ## Why a covered reducing `POSITION` is an EXIT (RISK-2, GOV-2B blocker B2)
 *
 * THIS PARAGRAPH REPLACES ITS OWN OPPOSITE. It used to read: "A `POSITION`
 * intent whose delta happens to reduce a holding is therefore still classified
 * `ENTRY` and gets the STRICTER treatment. That is deliberate and fails closed
 * … A strategy that means 'exit' has `REDUCE_POSITION` for it." The GOV-2B
 * closeout audit established that the reasoning was wrong in both halves, and
 * the original text is quoted here rather than quietly deleted.
 *
 * 1. IT DID NOT FAIL CLOSED; IT FAILED SHUT. Entry treatment applies §9.8
 *    check 12, which needs an `expectedNetEdge` that a sale of tokens already
 *    held can never declare — so EVERY protective exit shaped as a `POSITION`
 *    was refused `RISK_EDGE_INPUTS_MISSING`, no realized round trip was
 *    reachable in the paper core, and a stop-loss could never execute. Refusing
 *    to place a NEW order is the safe direction; refusing to let a position OUT
 *    is the trap §6 invariant 12 and §9.9's `PROTECTED_REDUCE` ladder exist to
 *    prevent. (Entry treatment is perverse here in a second way: check 11b
 *    compares a pure sell's `boundedCost`, which is exactly `"0"` by the rule
 *    below, against `minOrderNotional` — so a configured economic floor refused
 *    every pure-sell `POSITION` unconditionally.)
 * 2. "A STRATEGY THAT MEANS EXIT HAS `REDUCE_POSITION`" IS NOT TRUE OF §7.7.
 *    `ReducePositionIntent.targetShares` is a per-market SELL-DOWN LEVEL:
 *    `packages/execution-planner`'s `buildReductionPlan` loops BOTH sides,
 *    sells the excess over that level on each, and reads only
 *    `minimumSellPrice`. It therefore cannot express a single-leg exit that
 *    BUYS (a complement-leg bracket closes by buying the token back), and it
 *    acts on inventory the emitting instance never created — which §6
 *    invariant 7 and ADR-006 §4 forbid. `REDUCE_POSITION` is the ACCOUNT-level
 *    instrument §9.9's incident controller reaches for; it is not the general
 *    spelling of "exit".
 *
 * WHAT THE RULE IS, EXACTLY. A `POSITION` is an `EXIT` when it resolves to a
 * SELL (a negative delta, in either `targetMode`) whose magnitude is FULLY
 * COVERED by the portfolio's confirmed holding of the same `(marketId, side)`.
 * Nothing else qualifies:
 *
 * - any BUY leg → `ENTRY`; a BUY commits new pUSD by definition;
 * - a SELL larger than the confirmed holding → `ENTRY`, and it also refuses
 *   with `RISK_SELL_EXCEEDS_INVENTORY` (§6 invariant 10);
 * - a zero delta → refused `RISK_ZERO_DELTA` before a disposition matters;
 * - `QUOTE` and `BASKET` are untouched. A `QUOTE` level names no outcome token
 *   (§7.7), so coverage is unprovable there; a `BASKET` is §7.7's coordinated
 *   OPENING instrument and declares its own `minimumLockedEdge`.
 *
 * WHY THAT RULE IS SOUND, in this package's OWN measures rather than by
 * appeal to the producer's narrative. A fully-covered SELL leg has
 * `boundedCost === "0"` and contributes no `buyShares`, and the worst case
 * assumes it does NOT fill (see CONSERVATIVE BOUNDING below), so the lot set
 * and `maximumContractualLoss` it is measured against are IDENTICAL to doing
 * nothing. Every check the `isEntry` guard skips — 11b economic floor, 12 net
 * edge, 13 participation, 14a allocator-verdict-present, 15 capacity, 19
 * rate-limit headroom, 20 time-to-close entry cutoff — is a check on NEW
 * COMMITTED RISK, and this intent commits none. The README's own stated
 * principle for those cells is "an exit REDUCES exposure", not "an exit is
 * typed `REDUCE_POSITION`"; deriving the disposition from the exposure effect
 * is that principle, applied directly.
 *
 * WHAT STILL APPLIES TO IT, and is the whole reason this is not a bypass:
 * checks 1–5 and 7b–11a, `RISK_SELL_EXCEEDS_INVENTORY`, an EXPLICIT allocator
 * refusal, the duplicate-intent guard, and — the one that matters most — §6
 * invariant 12's "no blind flatten": an exit into a stale or unsynchronized
 * book is still BLOCKED, with cancel-and-reconcile recommendations.
 *
 * DISCLOSED CONSEQUENCE, stated where the rule is made. The portfolio view is
 * the only positional input this package has, and it cannot distinguish a
 * bracket's protective SELL of a token it opened from a strategy ESTABLISHING
 * exposure by selling a token it already held (`static-bracket`'s complement
 * leg, under `PREFER_CHEAPEST_WITH_INVENTORY`, does exactly that). Both are
 * fully-covered sells, so both are now `EXIT`. That is deliberate: by the
 * measures §9.8 actually defines they ARE the same act, and a rule that
 * separated them could only do so by reading the producer's self-declaration —
 * the move `apps/trader/src/pipeline.ts` forbids. Gating a covered sale on its
 * DIRECTIONAL effect would need a net-directional-exposure measure §9.8 does
 * not define today; that is a contract-owner follow-up, not a disposition hack.
 *
 * WHAT IS NOT DERIVED FROM ANYTHING THE PRODUCER SAYS. Not `tags`, not the
 * presence or absence of `expectedNetEdge` (keying on that would hand any
 * entry exit treatment by omitting a field), not `urgency`, not
 * `liquidityPreference`. Only the parsed shape and the supplied portfolio.
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

/**
 * Is this SELL magnitude fully covered by the confirmed holding?
 *
 * The ONE predicate behind the `EXIT` disposition of a reducing `POSITION`
 * (see the module header). `shares` is always a positive magnitude here — a
 * zero delta is refused `RISK_ZERO_DELTA` before this is reached — so a `true`
 * answer also implies `held > 0`, and the "reduction on a market the portfolio
 * does not describe" case (`RISK_POSITION_STATE_UNKNOWN`, §6 invariant 12)
 * cannot be reached through this door.
 *
 * `<=`, not `<`: selling the entire confirmed holding is the ordinary close of
 * a position, and it leaves strictly less risk than holding it.
 */
function coveredReduction(shares: SharesString, held: SharesString): boolean {
  return compareDecimal(shares, held) <= 0;
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
        // THE DISPOSITION RULE (module header, "Why a covered reducing
        // POSITION is an EXIT"). Derived from the parsed shape and the
        // supplied portfolio only. An uncovered sell stays `ENTRY` and is
        // refused `RISK_SELL_EXCEEDS_INVENTORY` besides.
        if (coveredReduction(shares, held)) {
          disposition = "EXIT";
        }
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
