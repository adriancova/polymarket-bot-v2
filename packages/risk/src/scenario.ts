/**
 * Scenario loss — handoff §9.8 check 17 and the primary measure "scenario loss
 * under spot, volatility, time, and liquidity shocks".
 *
 * A scenario is a set of SHOCKED YES MARKS, one per market, supplied by the
 * caller. This module marks the same lot set the worst-case assessment uses
 * against those marks and reports the largest loss across the supplied
 * scenarios. It shocks nothing itself — the shock model belongs to whatever
 * component owns market structure, and inventing one here would put a made-up
 * volatility assumption inside a hard limit.
 *
 * Both tokens are marked, exactly: a NO share is worth `1 − yesMark`, because a
 * YES/NO pair redeems for exactly `1` (WP-110 payoff semantics — the same
 * both-token, per-outcome arithmetic `worst-case.ts` documents).
 *
 * FAIL CLOSED, two ways:
 *
 * 1. a required shock kind with no supplied scenario blocks (`RISK_SCENARIO_MISSING`);
 * 2. anything above the configured limit blocks (`RISK_SCENARIO_LOSS_EXCEEDED`).
 *
 * AN UNMARKED LOT IS VALUED AT `0` (C1-RISK, SCENARIO-17; the user's ruling,
 * 2026-10-08, recorded in ADR-030 Rule 8 item 2). A scenario with no mark for a
 * market the account holds counts that lot's whole committed cost as loss: the
 * contractual floor §9.8 check 16 already uses. So a missing mark never
 * understates the loss, and it no longer refuses on its own. (Until C1-RISK it
 * refused `RISK_SCENARIO_MARKS_INCOMPLETE`, which blocked every entry while any
 * held window's YES book had no bid.)
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import type { MoneyString } from "@polymarket-bot/domain";

import { deepFreeze } from "./guards.js";
import type { ScenarioView } from "./inputs.js";
import type { ScenarioKind } from "./policy.js";
import type { MarketHoldingLot } from "./worst-case.js";

export interface ScenarioOutcome {
  readonly scenarioId: string;
  readonly kind: ScenarioKind;
  /** Committed cost minus marked value (an unmarked lot is valued at `0`). Positive is a loss. */
  readonly loss: MoneyString;
}

export interface ScenarioAssessment {
  readonly outcomes: readonly ScenarioOutcome[];
  /** The largest loss across the supplied scenarios, or `undefined` when none was supplied. */
  readonly worstLoss: MoneyString | undefined;
  readonly worstScenarioId: string | undefined;
  /** Required kinds with no supplied scenario. */
  readonly missingKinds: readonly ScenarioKind[];
}

/** Marks one scenario against the lot set. */
function evaluateScenario(
  scenario: ScenarioView,
  lots: readonly MarketHoldingLot[],
): ScenarioOutcome {
  const marks = new Map(scenario.marks.map((mark) => [mark.marketId, mark.yesPrice]));
  let committedCost: MoneyString = "0";
  let markedValue: MoneyString = "0";

  for (const lot of lots) {
    committedCost = addDecimal(committedCost, lot.committedCost);
    const yesMark = marks.get(lot.marketId);
    // Unmarked: valued at the contractual floor `0`, so its whole committed
    // cost counts as loss (see the module header).
    if (yesMark === undefined) continue;
    const noMark = subDecimal("1", yesMark);
    markedValue = addDecimal(
      markedValue,
      addDecimal(mulDecimal(lot.yesShares, yesMark), mulDecimal(lot.noShares, noMark)),
    );
  }

  return {
    scenarioId: scenario.scenarioId,
    kind: scenario.kind,
    loss: subDecimal(committedCost, markedValue),
  };
}

/**
 * Assesses every supplied scenario against `lots` and reports what is missing.
 *
 * `requiredKinds` comes from policy; a kind with no scenario is reported rather
 * than skipped, so the caller can refuse instead of silently checking less.
 */
export function assessScenarios(
  scenarios: readonly ScenarioView[],
  lots: readonly MarketHoldingLot[],
  requiredKinds: readonly ScenarioKind[],
): ScenarioAssessment {
  const outcomes = scenarios.map((scenario) => evaluateScenario(scenario, lots));

  const suppliedKinds = new Set(scenarios.map((scenario) => scenario.kind));
  const missingKinds = requiredKinds.filter((kind) => !suppliedKinds.has(kind));

  let worstLoss: MoneyString | undefined;
  let worstScenarioId: string | undefined;
  for (const outcome of outcomes) {
    if (worstLoss === undefined || compareDecimal(outcome.loss, worstLoss) > 0) {
      worstLoss = outcome.loss;
      worstScenarioId = outcome.scenarioId;
    }
  }

  return deepFreeze({
    outcomes,
    worstLoss,
    worstScenarioId,
    missingKinds,
  });
}
