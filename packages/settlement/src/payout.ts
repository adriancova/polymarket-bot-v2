/**
 * Outcome payouts — exact, per share, per outcome token.
 *
 * VENUE EVIDENCE (U-6 closed by WP-110; source
 * https://docs.polymarket.com/concepts/resolution, accessed 2026-08-28;
 * https://docs.polymarket.com/concepts/positions-tokens, accessed 2026-08-28).
 * Verbatim:
 *
 * - "**Winning tokens** become redeemable for $1.00 each"
 * - "**Losing tokens** become worthless ($0.00)"
 * - "**Unknown/50-50** | Neither outcome applicable (rare) | Market resolves
 *   50/50 — each token redeems for $0.50; disputer gets bond back + half of
 *   proposer's bond"
 * - "Outcome tokens are always fully backed. Every Yes/No pair in existence is
 *   backed by exactly `$1` of pUSD collateral locked in the CTF contract."
 *
 * The 50/50 outcome and its $0.50-per-token payout are therefore VERIFIED as of
 * 2026-08-28 and are no longer the handoff-asserted facts ADR-009 §5 described.
 * They remain a dated venue snapshot: handoff §1.2 requires re-verification at
 * each phase gate.
 *
 * `CANCELLED` is the exception and is deliberately NOT computed here. The
 * retrieved resolution documentation describes exactly three redemption
 * outcomes — winning, losing, and 50/50 — and documents no cancellation, void,
 * or refund path at all. `MarketOutcomeState` carries `CANCELLED` because §9.3
 * requires the state, but this package refuses to invent its payout
 * (`AGENTS.md`: "never silently invent venue behavior"); see the refusal code
 * `SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED`.
 *
 * ARITHMETIC: canonical decimal strings and exact multiplication only. `0.5` is
 * exactly representable in decimal and is NOT representable as a rounded
 * binary-floating-point product of an arbitrary share count, which is precisely
 * why §6 invariant 1 forbids `number` here.
 */

import { explainCanonicalDecimalString, mulDecimal, type DecimalString } from "@polymarket-bot/decimal";
import type { OutcomeSide } from "@polymarket-bot/domain";

import {
  settlementFailure,
  settlementOk,
  settlementRefusal,
  type SettlementRefusalDetails,
  type SettlementResult,
} from "./errors.js";
import { ownEmit } from "./spec-door.js";
import { isTerminalMarketOutcomeState, type MarketOutcomeState } from "./vocabulary.js";

/** "Winning tokens become redeemable for $1.00 each" (resolution doc, 2026-08-28). */
export const WINNING_TOKEN_PAYOUT_PER_SHARE: DecimalString = "1";

/** "Losing tokens become worthless ($0.00)" (resolution doc, 2026-08-28). */
export const LOSING_TOKEN_PAYOUT_PER_SHARE: DecimalString = "0";

/** "Market resolves 50/50 — each token redeems for $0.50" (resolution doc, 2026-08-28). */
export const SPLIT_50_50_PAYOUT_PER_SHARE: DecimalString = "0.5";

/** What one share of each outcome token redeems for. */
export interface OutcomePayoutPerShare {
  readonly yes: DecimalString;
  readonly no: DecimalString;
}

/**
 * D4 (ADR-020 §3): the three payout records are emitted with a NULL PROTOTYPE
 * and frozen.
 *
 * These are redemption values per share. A consumer reading a side this record
 * does not carry must read nothing rather than whatever `Object.prototype` says,
 * and the same record is attached to every {@link SettlementEvaluation}, where
 * an inherited `payoutPerShare` was measured answering for a `PENDING` market.
 */
const YES_WIN_PAYOUT: OutcomePayoutPerShare = ownEmit<OutcomePayoutPerShare>([
  ["yes", WINNING_TOKEN_PAYOUT_PER_SHARE],
  ["no", LOSING_TOKEN_PAYOUT_PER_SHARE],
]);

const NO_WIN_PAYOUT: OutcomePayoutPerShare = ownEmit<OutcomePayoutPerShare>([
  ["yes", LOSING_TOKEN_PAYOUT_PER_SHARE],
  ["no", WINNING_TOKEN_PAYOUT_PER_SHARE],
]);

const SPLIT_PAYOUT: OutcomePayoutPerShare = ownEmit<OutcomePayoutPerShare>([
  ["yes", SPLIT_50_50_PAYOUT_PER_SHARE],
  ["no", SPLIT_50_50_PAYOUT_PER_SHARE],
]);

/**
 * The non-terminal refusal's details, COMPOSED INSIDE A CONTAINMENT.
 *
 * ADR-020's 2026-09-06 amendment, measured on this function at base `c2c0733`:
 * {@link isTerminalMarketOutcomeState} is a `zod` parse, and `zod`'s issue
 * construction reads through the prototype chain. An inherited `_zod` made this
 * DETAIL throw `TypeError: Cannot read properties of undefined (reading 'has')`,
 * and an inherited `value` or `get` threw `Invalid property descriptor` (ADR-020
 * §1 class 8) — under either pollution variant, out of a function documented to
 * RETURN a refusal, and taking `evaluateSettlement` with it for every `PENDING`
 * threshold-by-date market.
 *
 * The refusal's CODE never depended on this call — the switch below already
 * decided — so a detail that cannot be computed is omitted rather than thrown.
 * ADR-020 §6 permits refusal COMPOSITION to vary; what may not vary is that a
 * verdict comes back at all.
 */
function nonTerminalDetails(outcome: MarketOutcomeState): SettlementRefusalDetails {
  try {
    return { outcome, terminal: isTerminalMarketOutcomeState(outcome) };
  } catch {
    return { outcome };
  }
}

/**
 * Per-share payout of a settled market, or the reason there is none.
 *
 * Refuses on every non-terminal state (`PENDING`, `PENDING_CLARIFICATION`,
 * `DISPUTED`): ADR-009 §4 — "a disputed market has no determined payoff", and a
 * function that returned a number for one would invite exactly the PnL the
 * ruling exists to prevent.
 */
export function payoutPerShare(
  outcome: MarketOutcomeState,
): SettlementResult<OutcomePayoutPerShare> {
  switch (outcome) {
    case "YES_WIN":
      return settlementOk(YES_WIN_PAYOUT);
    case "NO_WIN":
      return settlementOk(NO_WIN_PAYOUT);
    case "SPLIT_50_50":
      return settlementOk(SPLIT_PAYOUT);
    case "CANCELLED":
      return settlementFailure(
        settlementRefusal(
          "SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED",
          "the venue's resolution documentation (retrieved 2026-08-28) documents winning, losing, and 50/50 redemption and no cancellation path; this package will not invent a refund rule",
          { outcome },
        ),
      );
    default:
      return settlementFailure(
        settlementRefusal(
          "SETTLEMENT_OUTCOME_NOT_TERMINAL",
          `outcome state ${outcome} determines no payoff (ADR-009 §4: a dispute is an in-flight process, not an outcome)`,
          nonTerminalDetails(outcome),
        ),
      );
  }
}

/**
 * Exact settlement value of a share quantity at a per-share payout.
 *
 * @throws {InvalidDecimalStringError} when either operand is not canonical, and
 * {@link Error} when the share count is negative — a negative *quantity* here
 * would be a caller bug, not a settlement outcome (a short is modelled as the
 * other token, since every Yes/No pair is backed by exactly $1).
 */
export function settlementValue(
  shares: DecimalString,
  perShare: DecimalString,
): DecimalString {
  const problem = explainCanonicalDecimalString(shares, { range: "NON_NEGATIVE" });
  if (problem !== null) {
    throw new TypeError(`settlementValue(shares): ${problem}`);
  }
  return mulDecimal(shares, perShare);
}

/** Exact settlement value of a position, or the reason the payoff is undetermined. */
export function positionSettlementValue(
  outcome: MarketOutcomeState,
  side: OutcomeSide,
  shares: DecimalString,
): SettlementResult<DecimalString> {
  const payout = payoutPerShare(outcome);
  if (!payout.ok) {
    return payout;
  }
  const perShare = side === "YES" ? payout.value.yes : payout.value.no;
  return settlementOk(settlementValue(shares, perShare));
}
