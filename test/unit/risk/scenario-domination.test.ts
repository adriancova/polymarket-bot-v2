/**
 * C1-RISK (SCENARIO-17): check 16 dominates check 17 whenever
 * `maxScenarioLoss >= maxWorstCaseContractualLoss`.
 *
 * Why it holds for every input the schemas admit. Every lot is non-negative
 * (positions, unbooked BUYs, resting BUYs and the intent's BUY legs), every
 * mark is in `[0, 1]`, and an UNMARKED lot is valued at `0` (its full
 * committed cost, the contractual floor check 16 uses). So a scenario's loss
 * `C − Σ(yes·m + no·(1 − m))` is at most `C`, the committed cost check 16
 * compares, and the CAP-1 booked-only figure is at most `C` too. A scenario
 * loss above `maxScenarioLoss` is therefore above `maxWorstCaseContractualLoss`.
 *
 * The pin: over generated portfolios, intents and marks (with markets left
 * unmarked on purpose), whenever check 16 passes, check 17 refuses nothing.
 * No rule orders the two limits (the user's ruling, 2026-10-08): a tighter
 * `maxScenarioLoss` stays a legitimate configuration, and this pin says
 * nothing about it.
 */

import { describe, expect, it } from "vitest";

import { evaluateIntent } from "../../../packages/risk/src/index.js";
import {
  MARKET_A,
  MARKET_B,
  codesOf,
  entryInput,
  positionIntent,
  riskPolicy,
  type ScenarioFixture,
} from "./fixtures.js";

/** Deterministic generator (mulberry32), so a failure reproduces exactly. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer count of hundredths, as a canonical exact decimal string. */
function hundredths(count: number): string {
  const whole = Math.floor(count / 100);
  const fraction = count % 100;
  if (fraction === 0) return String(whole);
  const digits = String(fraction).padStart(2, "0").replace(/0$/u, "");
  return `${String(whole)}.${digits}`;
}

const CHECK_17_CODES = [
  "RISK_SCENARIO_LOSS_EXCEEDED",
  "RISK_SCENARIO_MISSING",
  // Deleted by C1-RISK; listed so the pin also fails if it ever comes back.
  "RISK_SCENARIO_MARKS_INCOMPLETE",
];

describe("C1-RISK: check 16 dominates check 17 when maxScenarioLoss >= maxWorstCaseContractualLoss", () => {
  it("whenever check 16 passes, check 17 never refuses — unmarked markets included", () => {
    const random = generator(20261008);
    const int = (bound: number): number => Math.floor(random() * bound);
    const markets = [MARKET_A, MARKET_B] as const;
    const sides = ["YES", "NO"] as const;

    let checked = 0;
    let checkedWithUnmarked = 0;
    for (let index = 0; index < 1_500; index += 1) {
      const worstCaseLimitHundredths = int(40_000);
      const policy = riskPolicy({
        limits: { maxWorstCaseContractualLoss: hundredths(worstCaseLimitHundredths) },
        scenario: {
          maxScenarioLoss: hundredths(worstCaseLimitHundredths + int(3) * int(2_000)),
        },
      });

      const input = entryInput();
      input.intent = positionIntent({
        targetShares: String(1 + int(200)),
        maximumBuyPrice: hundredths(1 + int(99)),
        direction: sides[int(2)],
      });
      input.portfolio.positions = Array.from({ length: int(4) }, () => ({
        marketId: markets[int(2)],
        side: sides[int(2)],
        shares: String(int(200)),
        costBasis: hundredths(int(10_000)),
      }));
      input.portfolio.openOrders = Array.from({ length: int(3) }, (_, order) => ({
        orderId: `o-${String(order)}`,
        marketId: markets[int(2)],
        side: sides[int(2)],
        action: "BUY",
        price: hundredths(1 + int(99)),
        shares: String(1 + int(100)),
      }));
      (input as unknown as Record<string, unknown>)["unbookedFills"] = Array.from(
        { length: int(3) },
        () => ({
          marketId: markets[int(2)],
          side: sides[int(2)],
          shares: String(int(100)),
          debit: hundredths(int(5_000)),
        }),
      );
      // Each kind marks a random subset of the two markets: often one of them
      // is left UNMARKED, which is the case C1-RISK changes.
      let anyUnmarked = false;
      input.scenarios = (["SPOT", "VOLATILITY", "TIME", "LIQUIDITY"] as const).map(
        (kind): ScenarioFixture => {
          const marks = markets
            .filter(() => random() < 0.7)
            .map((marketId) => ({ marketId, yesPrice: hundredths(int(101)) }));
          if (marks.length < markets.length) anyUnmarked = true;
          return { scenarioId: `scen-${kind.toLowerCase()}`, kind, marks };
        },
      );

      const codes = codesOf(evaluateIntent(policy, input));
      expect(codes).not.toContain("RISK_INPUT_INVALID");
      if (codes.includes("RISK_WORST_CASE_LOSS_EXCEEDED")) continue;
      checked += 1;
      if (anyUnmarked) checkedWithUnmarked += 1;
      for (const code of CHECK_17_CODES) {
        expect(codes, `case ${String(index)}`).not.toContain(code);
      }
    }
    // The pin is only as good as the cases it reached.
    expect(checked).toBeGreaterThan(100);
    expect(checkedWithUnmarked).toBeGreaterThan(50);
  });
});
