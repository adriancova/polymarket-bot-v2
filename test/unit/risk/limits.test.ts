/**
 * The two limit modules in isolation: exposure caps (§9.8 check 15) and
 * scenario loss (§9.8 check 17).
 *
 * Testing them directly, rather than only through the pipeline, is what pins
 * the arithmetic: a pipeline test proves "something refused", these prove the
 * exact projected value and the exact scenario loss.
 */

import { describe, expect, it } from "vitest";

import {
  assessScenarios,
  checkExposureLimits,
  parseRiskPolicy,
  type MarketHoldingLot,
} from "../../../packages/risk/src/index.js";
import { MARKET_A, MARKET_B, exposureEntry, exposureSnapshot } from "./fixtures.js";

function limitsOf(overrides: Record<string, string>) {
  const parsed = parseRiskPolicy({
    freshness: { venueBookMaxAgeMs: 1, referenceFeedMaxAgeMs: 1, featuresMaxAgeMs: 1 },
    limits: { maxWorstCaseContractualLoss: "10000", ...overrides },
    scenario: { maxScenarioLoss: "10000" },
    economics: {},
    participation: {},
    rateLimit: { safetyReserveRequests: 0 },
    timeToClose: { entryCutoffSeconds: 0 },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
  return parsed.value.limits;
}

const probe = {
  strategyInstanceId: "strat-a",
  perMarketContribution: new Map([[MARKET_A, "10"]]),
  scopeByMarket: new Map([[MARKET_A, { seriesKey: "s", underlyingKey: "u", resolutionWindowKey: "w" }]]),
  totalContribution: "10",
};

describe("checkExposureLimits", () => {
  it("passes silently when no cap is configured, even with no snapshot", () => {
    expect(checkExposureLimits(limitsOf({}), undefined, probe)).toEqual([]);
  });

  it("blocks when a cap is configured and no snapshot was supplied", () => {
    const refusals = checkExposureLimits(limitsOf({ globalExposureCap: "1000" }), undefined, probe);
    expect(refusals.map((r) => r.code)).toEqual(["RISK_EXPOSURE_SNAPSHOT_MISSING"]);
  });

  it("adds the contribution to the CURRENT exposure and compares exactly at the boundary", () => {
    const atCap = checkExposureLimits(
      limitsOf({ globalExposureCap: "100" }),
      exposureSnapshot({ global: exposureEntry("50", "40") }) as never,
      probe,
    );
    // 50 + 40 + 10 = 100, exactly at the cap: permitted.
    expect(atCap).toEqual([]);

    const overCap = checkExposureLimits(
      limitsOf({ globalExposureCap: "100" }),
      exposureSnapshot({ global: exposureEntry("50", "40.01") }) as never,
      probe,
    );
    expect(overCap.map((r) => r.code)).toEqual(["RISK_GLOBAL_EXPOSURE_EXCEEDED"]);
    expect(overCap[0]?.details["projected"]).toBe("100.01");
  });

  it("reports EVERY breach rather than only the first", () => {
    const refusals = checkExposureLimits(
      limitsOf({ globalExposureCap: "1", perMarketExposureCap: "1", perSeriesExposureCap: "1" }),
      exposureSnapshot({}) as never,
      probe,
    );
    expect(refusals.map((r) => r.code).sort()).toEqual([
      "RISK_GLOBAL_EXPOSURE_EXCEEDED",
      "RISK_MARKET_EXPOSURE_EXCEEDED",
      "RISK_SERIES_EXPOSURE_EXCEEDED",
    ]);
  });

  it("aggregates several markets sharing one scope key before comparing", () => {
    const refusals = checkExposureLimits(
      limitsOf({ perUnderlyingExposureCap: "15" }),
      exposureSnapshot({}) as never,
      {
        strategyInstanceId: "strat-a",
        perMarketContribution: new Map([
          [MARKET_A, "10"],
          [MARKET_B, "10"],
        ]),
        scopeByMarket: new Map([
          [MARKET_A, { underlyingKey: "BTC" }],
          [MARKET_B, { underlyingKey: "BTC" }],
        ]),
        totalContribution: "20",
      },
    );
    expect(refusals.map((r) => r.code)).toEqual(["RISK_UNDERLYING_EXPOSURE_EXCEEDED"]);
    expect(refusals[0]?.details["contribution"]).toBe("20");
    expect(refusals[0]?.details["key"]).toBe("BTC");
  });

  it("fails closed on a market it cannot attribute to a configured scope", () => {
    const refusals = checkExposureLimits(
      limitsOf({ perSeriesExposureCap: "1000000" }),
      exposureSnapshot({}) as never,
      {
        ...probe,
        scopeByMarket: new Map([[MARKET_A, undefined]]),
      },
    );
    expect(refusals.map((r) => r.code)).toEqual(["RISK_SCOPE_KEY_MISSING"]);
  });
});

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

  it("excludes a partially-marked scenario from the worst-loss selection and names it", () => {
    const assessment = assessScenarios(
      [
        { scenarioId: "partial", kind: "SPOT", marks: [] },
        { scenarioId: "full", kind: "TIME", marks: [{ marketId: MARKET_A, yesPrice: "0.4" }] },
      ],
      lots,
      ["SPOT", "TIME"],
    );
    expect([...assessment.incompleteScenarioIds]).toEqual(["partial"]);
    expect(assessment.worstScenarioId).toBe("full");
    expect(assessment.worstLoss).toBe("10");
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
