/**
 * Worst-case contractual loss — THE PRIMARY RISK MEASURE (handoff §9.8:
 * "maximum contractual loss" and "worst-case resolution PnL" head the primary
 * measures; "Model-derived delta/gamma are secondary analytics, not the
 * primary hard limit". Workplan WP-180 acceptance 2: "Worst-case contractual
 * loss is primary").
 *
 * SETTLEMENT PAYOFF SEMANTICS (both-token, per-outcome), grounded in WP-110
 * (`packages/settlement/src/payout.ts`, venue-verified 2026-08-28 from
 * https://docs.polymarket.com/concepts/resolution):
 *
 * - `YES_WIN`:     one YES share redeems `"1"`,   one NO share `"0"`;
 * - `NO_WIN`:      one YES share redeems `"0"`,   one NO share `"1"`;
 * - `SPLIT_50_50`: each share of EITHER token redeems exactly `"0.5"`.
 *
 * THE `CANCELLED` OUTCOME IS NEVER VALUED. The venue documents no
 * cancellation/void/refund mechanic (WP-110 U-6 pass; register row U-10
 * "cancellation/void resolution mechanics and payout" — UNVERIFIED), and
 * `packages/settlement` refuses `payoutPerShare("CANCELLED")` with
 * `SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED`. This module invents no payout
 * either. Instead the unverified outcome is BOUNDED: an outcome token is an
 * asset — no redemption path can charge its holder — so every unverified
 * redemption is ≥ 0, and the worst case over ALL possible terminal outcomes
 * is therefore bounded by a ZERO-REDEMPTION FLOOR. That yields the two
 * measures this module computes, both exact:
 *
 * - `maximumContractualLoss` (PRIMARY, binding): committed cost minus the
 *   zero floor — the most that can be contractually lost across every
 *   terminal outcome including the unverified one. Deliberately conservative:
 *   a fully hedged YES/NO pair is NOT credited its verified hedge value here,
 *   because crediting it would rely on a cancellation payout the venue does
 *   not document. Never underestimates; never permits on unknowns.
 * - `worstCaseResolutionLoss`: committed cost minus the per-market minimum
 *   settlement value over the three VERIFIED terminal outcomes (both tokens,
 *   each outcome evaluated exactly). This is §9.8's "worst-case resolution
 *   PnL" and is where the per-outcome payoff arithmetic binds.
 *
 * CONSERVATIVE SIMPLIFICATIONS (each overstates loss, never understates):
 * open BUY orders are assumed to fill at their limit price (they can); open
 * SELL orders are assumed NOT to fill (retaining the exposed tokens and
 * forgoing the proceeds); an entry intent is assumed to fill fully at its
 * price/cost bound.
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import type { MoneyString, SharesString } from "@polymarket-bot/domain";

import { deepFreeze } from "./guards.js";

/**
 * Verified per-share payouts, mirroring `packages/settlement/src/payout.ts`
 * (no workspace edge may exist between the two layer-1 packages —
 * `dependency-direction.md` §2.1; the cross-package pin test in
 * `test/unit/risk/` compares these constants against WP-110's exports so a
 * settlement-side change fails this package's suite).
 */
export const WINNING_TOKEN_PAYOUT_PER_SHARE = "1";
export const LOSING_TOKEN_PAYOUT_PER_SHARE = "0";
export const SPLIT_50_50_PAYOUT_PER_SHARE = "0.5";

/** The three venue-verified terminal outcomes (WP-110, 2026-08-28). */
export const VERIFIED_TERMINAL_OUTCOMES = ["YES_WIN", "NO_WIN", "SPLIT_50_50"] as const;
export type VerifiedTerminalOutcome = (typeof VERIFIED_TERMINAL_OUTCOMES)[number];

/** How the unverified `CANCELLED` outcome enters the bound. The only value. */
export const CANCELLED_OUTCOME_TREATMENT = "ZERO_REDEMPTION_FLOOR_UNVERIFIED_U10" as const;

/** One market's holdings for the worst-case computation. */
export interface MarketHoldingLot {
  readonly marketId: string;
  /** Total YES shares held (positions plus assumed-filled buy orders/intent). */
  readonly yesShares: SharesString;
  readonly noShares: SharesString;
  /** Exact pUSD committed to this market (cost basis + bounded order/intent cost). */
  readonly committedCost: MoneyString;
}

export interface PerOutcomeSettlementValue {
  readonly YES_WIN: MoneyString;
  readonly NO_WIN: MoneyString;
  readonly SPLIT_50_50: MoneyString;
}

export interface MarketWorstCase {
  readonly marketId: string;
  readonly yesShares: SharesString;
  readonly noShares: SharesString;
  readonly committedCost: MoneyString;
  /** Both-token settlement value under EACH verified terminal outcome. */
  readonly perOutcomeSettlementValue: PerOutcomeSettlementValue;
  readonly worstVerifiedOutcome: VerifiedTerminalOutcome;
  readonly worstVerifiedValue: MoneyString;
}

export interface WorstCaseAssessment {
  /** Exact total pUSD committed across markets (§9.8 "gross capital committed"). */
  readonly committedCost: MoneyString;
  readonly perMarket: readonly MarketWorstCase[];
  /**
   * PRIMARY bound: loss if every held token redeems at the zero floor —
   * covers the unverified CANCELLED outcome without valuing it (U-10).
   */
  readonly maximumContractualLoss: MoneyString;
  /**
   * §9.8 "worst-case resolution PnL", as a loss (may be negative = guaranteed
   * profit): committed cost − Σ per-market worst VERIFIED outcome value.
   */
  readonly worstCaseResolutionLoss: MoneyString;
  readonly cancelledOutcomeTreatment: typeof CANCELLED_OUTCOME_TREATMENT;
}

/** Both-token settlement value of one market's holdings under one outcome. */
export function settlementValueUnderOutcome(
  yesShares: SharesString,
  noShares: SharesString,
  outcome: VerifiedTerminalOutcome,
): MoneyString {
  switch (outcome) {
    case "YES_WIN":
      return addDecimal(
        mulDecimal(yesShares, WINNING_TOKEN_PAYOUT_PER_SHARE),
        mulDecimal(noShares, LOSING_TOKEN_PAYOUT_PER_SHARE),
      );
    case "NO_WIN":
      return addDecimal(
        mulDecimal(yesShares, LOSING_TOKEN_PAYOUT_PER_SHARE),
        mulDecimal(noShares, WINNING_TOKEN_PAYOUT_PER_SHARE),
      );
    case "SPLIT_50_50":
      return mulDecimal(addDecimal(yesShares, noShares), SPLIT_50_50_PAYOUT_PER_SHARE);
  }
}

/** Assesses worst-case loss over a set of per-market holding lots. */
export function assessWorstCase(lots: readonly MarketHoldingLot[]): WorstCaseAssessment {
  let committedCost: MoneyString = "0";
  let worstVerifiedTotal: MoneyString = "0";
  const perMarket: MarketWorstCase[] = [];

  for (const lot of lots) {
    committedCost = addDecimal(committedCost, lot.committedCost);
    const perOutcome: PerOutcomeSettlementValue = {
      YES_WIN: settlementValueUnderOutcome(lot.yesShares, lot.noShares, "YES_WIN"),
      NO_WIN: settlementValueUnderOutcome(lot.yesShares, lot.noShares, "NO_WIN"),
      SPLIT_50_50: settlementValueUnderOutcome(lot.yesShares, lot.noShares, "SPLIT_50_50"),
    };
    let worstOutcome: VerifiedTerminalOutcome = "YES_WIN";
    let worstValue = perOutcome.YES_WIN;
    for (const outcome of VERIFIED_TERMINAL_OUTCOMES) {
      if (compareDecimal(perOutcome[outcome], worstValue) < 0) {
        worstOutcome = outcome;
        worstValue = perOutcome[outcome];
      }
    }
    worstVerifiedTotal = addDecimal(worstVerifiedTotal, worstValue);
    perMarket.push({
      marketId: lot.marketId,
      yesShares: lot.yesShares,
      noShares: lot.noShares,
      committedCost: lot.committedCost,
      perOutcomeSettlementValue: perOutcome,
      worstVerifiedOutcome: worstOutcome,
      worstVerifiedValue: worstValue,
    });
  }

  return deepFreeze({
    committedCost,
    perMarket,
    // Zero floor: every unverified redemption is ≥ 0, so no terminal outcome
    // can lose more than everything committed. Never valued, only bounded.
    maximumContractualLoss: committedCost,
    worstCaseResolutionLoss: subDecimal(committedCost, worstVerifiedTotal),
    cancelledOutcomeTreatment: CANCELLED_OUTCOME_TREATMENT,
  });
}
