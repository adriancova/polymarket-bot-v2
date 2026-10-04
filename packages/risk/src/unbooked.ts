/**
 * `CAP-1` — the monotone rule for the filled-but-unbooked input (orchestrator
 * ruling, 2026-10-04: "it may only make risk more conservative").
 *
 * `lots.ts` counts a filled-but-unbooked BUY (`inputs.ts`,
 * `UnbookedFillExposureSchema`) EXACTLY as a booked position of the same side
 * and token. For §9.8 check 16's PRIMARY measure that is monotone by
 * construction: `maximumContractualLoss` is the lot set's committed cost, and
 * an entry only adds its non-negative debit to it.
 *
 * THE TWO MEASURES THAT ARE NOT. Both CREDIT the value of what is held, so a
 * holding added to the lot set can LOWER them:
 *
 * - check 17: a scenario's loss is `cost − Σ shares × mark`, so a fill bought
 *   BELOW a shocked mark adds `shares × (price − mark) < 0`;
 * - check 16's secondary limit (`maxWorstCaseResolutionLoss`): a YES fill
 *   against a held NO forms a pair that redeems `1` under every verified
 *   outcome, so it can lower the worst-case resolution loss.
 *
 * For a BOOKED position that credit is the measure's own definition, and it is
 * unchanged. For an UNBOOKED fill it would let a fill the ledger has not booked
 * make the account look SAFER than its booked state, which the ruling forbids.
 * So each of these two measures, AS CHECKS 16 AND 17 COMPARE IT, is the
 * GREATER of its value with the unbooked fills and its value without them —
 * the booked-only measure, which is exactly what both checks measured before
 * `CAP-1`. With nothing unbooked the two are one lot set and the answer is
 * byte-identical to the booked-only measure.
 *
 * What the evaluation REPORTS (`worstCase`, `scenario`) is the assessment WITH
 * the unbooked fills — the account as it is about to be booked. Only the
 * compared figure is guarded, and a refusal's details carry that figure.
 */

import { compareDecimal } from "@polymarket-bot/decimal";
import type { MoneyString } from "@polymarket-bot/domain";

import type { ScenarioAssessment } from "./scenario.js";

/**
 * The figure a check compares: `withUnbooked`, unless the booked-only measure
 * is GREATER — an unbooked fill may raise a loss measure, never lower one.
 */
export function notBelowBookedOnly(withUnbooked: MoneyString, bookedOnly: MoneyString): MoneyString {
  return compareDecimal(withUnbooked, bookedOnly) < 0 ? bookedOnly : withUnbooked;
}

/** The worst scenario loss check 17 compares, and the scenario it came from. */
export interface ComparedScenarioLoss {
  readonly worstLoss: MoneyString | undefined;
  readonly worstScenarioId: string | undefined;
}

/**
 * Check 17's compared worst loss: the worst over the scenarios usable WITH the
 * unbooked fills, never below the booked-only worst.
 *
 * When NO scenario can mark the lot set with the unbooked fills (one sits in a
 * market no scenario marks), the booked-only worst is compared as it was — so
 * a `RISK_SCENARIO_LOSS_EXCEEDED` the booked-only measure earns is never
 * traded for the `RISK_SCENARIO_MARKS_INCOMPLETE` the unmarked lot adds: both
 * refuse. `undefined` only when neither lot set can be marked at all.
 */
export function comparedScenarioLoss(
  withUnbooked: ScenarioAssessment,
  bookedOnly: ScenarioAssessment,
): ComparedScenarioLoss {
  const measured = withUnbooked.worstLoss;
  const floor = bookedOnly.worstLoss;
  if (measured === undefined) return { worstLoss: floor, worstScenarioId: bookedOnly.worstScenarioId };
  if (floor !== undefined && compareDecimal(floor, measured) > 0) {
    return { worstLoss: floor, worstScenarioId: bookedOnly.worstScenarioId };
  }
  return { worstLoss: measured, worstScenarioId: withUnbooked.worstScenarioId };
}
