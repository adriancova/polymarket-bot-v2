/**
 * Scenario loss (§9.8 check 17) in isolation.
 *
 * Testing it directly, rather than only through the pipeline, is what pins
 * the arithmetic: a pipeline test proves "something refused", these prove the
 * exact scenario loss.
 *
 * C1-RISK (2026-10-08) deleted the exposure-cap half of this suite with
 * `exposure-limits.ts`: the capital allocator is the only exposure-cap
 * authority, and its caps are pinned in `packages/capital-allocator` and in
 * `packages/trading-core/src/allocation.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { assessScenarios, type MarketHoldingLot } from "../../../packages/risk/src/index.js";
import { MARKET_A, MARKET_B } from "./fixtures.js";

describe("assessScenarios", () => {
  const lots: readonly MarketHoldingLot[] = [
    { marketId: MARKET_A, yesShares: "100", noShares: "0", committedCost: "50" },
  ];

  it("marks both tokens exactly: a NO share is worth 1 − yesMark", () => {
    const assessment = assessScenarios(
      [{ scenarioId: "s", kind: "SPOT", marks: [{ marketId: MARKET_A, yesPrice: "0.25" }] }],
      [{ marketId: MARKET_A, yesShares: "100", noShares: "40", committedCost: "50" }],
      ["SPOT"],
    );
    // 100 × 0.25 + 40 × 0.75 = 25 + 30 = 55 → a gain of 5, i.e. a loss of −5.
    expect(assessment.outcomes[0]?.loss).toBe("-5");
    expect(assessment.worstLoss).toBe("-5");
  });

  it("selects the WORST fully-marked scenario", () => {
    const assessment = assessScenarios(
      [
        { scenarioId: "mild", kind: "SPOT", marks: [{ marketId: MARKET_A, yesPrice: "0.45" }] },
        { scenarioId: "harsh", kind: "TIME", marks: [{ marketId: MARKET_A, yesPrice: "0.05" }] },
      ],
      lots,
      ["SPOT", "TIME"],
    );
    expect(assessment.worstScenarioId).toBe("harsh");
    expect(assessment.worstLoss).toBe("45");
  });

  it("reports a required kind that was not supplied", () => {
    const assessment = assessScenarios(
      [{ scenarioId: "s", kind: "SPOT", marks: [{ marketId: MARKET_A, yesPrice: "0.4" }] }],
      lots,
      ["SPOT", "LIQUIDITY"],
    );
    expect([...assessment.missingKinds]).toEqual(["LIQUIDITY"]);
  });

  it("C1-RISK: values an UNMARKED lot at 0, so its whole committed cost counts as loss", () => {
    const assessment = assessScenarios(
      [
        { scenarioId: "partial", kind: "SPOT", marks: [] },
        { scenarioId: "full", kind: "TIME", marks: [{ marketId: MARKET_A, yesPrice: "0.4" }] },
      ],
      lots,
      ["SPOT", "TIME"],
    );
    // Unmarked: 50 − 0 = 50, the contractual floor check 16 uses. Marked: 50 − 40 = 10.
    expect(assessment.outcomes.map((outcome) => outcome.loss)).toEqual(["50", "10"]);
    expect(assessment.worstScenarioId).toBe("partial");
    expect(assessment.worstLoss).toBe("50");
  });

  it("C1-RISK: marks the markets it can and floors only the ones it cannot", () => {
    const assessment = assessScenarios(
      [{ scenarioId: "one", kind: "SPOT", marks: [{ marketId: MARKET_A, yesPrice: "0.4" }] }],
      [
        { marketId: MARKET_A, yesShares: "100", noShares: "0", committedCost: "50" },
        { marketId: MARKET_B, yesShares: "0", noShares: "20", committedCost: "7" },
      ],
      ["SPOT"],
    );
    // (50 + 7) − 100 × 0.4 = 17: MARKET_B's 20 NO add no value.
    expect(assessment.worstLoss).toBe("17");
  });

  it("reports no worst loss at all when nothing usable was supplied", () => {
    const assessment = assessScenarios([], lots, ["SPOT"]);
    expect(assessment.worstLoss).toBeUndefined();
    expect(assessment.worstScenarioId).toBeUndefined();
    expect([...assessment.missingKinds]).toEqual(["SPOT"]);
  });

  it("returns a frozen assessment", () => {
    expect(Object.isFrozen(assessScenarios([], lots, []))).toBe(true);
  });
});
