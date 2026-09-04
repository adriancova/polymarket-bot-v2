/**
 * Risk policy: what defaults exist, what has none, and what cannot be relaxed.
 *
 * §9.7: "Initial defaults should reflect user-defined caps rather than
 * hardcoded historical examples." The tests below assert the shape of that
 * rule — no invented economic number anywhere, and the only defaults are safety
 * floors (`PAPER`, `true`, `"0"`, all four shock kinds).
 */

import { describe, expect, it } from "vitest";

import {
  PRIMARY_RISK_REASON_CODES,
  SCENARIO_KINDS,
  isPrimaryRiskReasonCode,
  isRiskReasonCode,
  parseRiskPolicy,
  riskFailure,
  riskOk,
  riskRefusal,
} from "../../../packages/risk/src/index.js";

const minimal = {
  freshness: { venueBookMaxAgeMs: 1000, referenceFeedMaxAgeMs: 2000, featuresMaxAgeMs: 2000 },
  limits: { maxWorstCaseContractualLoss: "100" },
  scenario: { maxScenarioLoss: "100" },
  economics: {},
  participation: {},
  rateLimit: { safetyReserveRequests: 5 },
  timeToClose: { entryCutoffSeconds: 60 },
};

describe("parseRiskPolicy", () => {
  it("defaults maxRunMode to PAPER — the untouchable repository maximum", () => {
    const parsed = parseRiskPolicy(minimal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.maxRunMode).toBe("PAPER");
  });

  it("defaults the safety booleans and the risk buffer, and nothing else", () => {
    const parsed = parseRiskPolicy(minimal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.requireVerifiedSettlementForEntries).toBe(true);
    expect(parsed.value.economics.requirePositiveNetEdgeForEntries).toBe(true);
    expect(parsed.value.economics.riskBuffer).toBe("0");
    // No invented economic caps.
    expect(parsed.value.economics.minOrderNotional).toBeUndefined();
    expect(parsed.value.participation.maxOrderShares).toBeUndefined();
    expect(parsed.value.limits.globalExposureCap).toBeUndefined();
    expect(parsed.value.limits.maxOrderNotional).toBeUndefined();
  });

  it("requires ALL FOUR shock kinds by default (§9.8 primary measures)", () => {
    const parsed = parseRiskPolicy(minimal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.value.scenario.requiredKinds]).toEqual([...SCENARIO_KINDS]);
    expect([...SCENARIO_KINDS]).toEqual(["SPOT", "VOLATILITY", "TIME", "LIQUIDITY"]);
  });

  it("refuses a policy with no primary worst-case limit — it cannot be configured away", () => {
    const parsed = parseRiskPolicy({ ...minimal, limits: {} });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals[0]?.code).toBe("RISK_INPUT_INVALID");
  });

  it("refuses a float where an exact decimal string is required (§6 invariant 1)", () => {
    const parsed = parseRiskPolicy({ ...minimal, limits: { maxWorstCaseContractualLoss: 100 } });
    expect(parsed.ok).toBe(false);
  });

  it("refuses a non-canonical decimal spelling", () => {
    const parsed = parseRiskPolicy({
      ...minimal,
      limits: { maxWorstCaseContractualLoss: "1e2" },
    });
    expect(parsed.ok).toBe(false);
  });

  it("refuses an unknown field rather than ignoring it", () => {
    const parsed = parseRiskPolicy({ ...minimal, unexpected: true });
    expect(parsed.ok).toBe(false);
  });

  it("refuses a negative limit", () => {
    const parsed = parseRiskPolicy({
      ...minimal,
      limits: { maxWorstCaseContractualLoss: "-1" },
    });
    expect(parsed.ok).toBe(false);
  });

  it("returns a frozen policy", () => {
    const parsed = parseRiskPolicy(minimal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.isFrozen(parsed.value)).toBe(true);
  });
});

describe("the primary/secondary split in the vocabulary", () => {
  it("names only the worst-case measures as primary", () => {
    expect([...PRIMARY_RISK_REASON_CODES]).toEqual([
      "RISK_WORST_CASE_LOSS_EXCEEDED",
      "RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED",
      "RISK_WORST_CASE_UNBOUNDED",
      "RISK_BASKET_LEG_UNBOUNDED",
    ]);
  });

  it("every primary code is also a member of the full vocabulary", () => {
    for (const code of PRIMARY_RISK_REASON_CODES) {
      expect(isRiskReasonCode(code)).toBe(true);
    }
  });

  it("a secondary code is not primary, and an unknown string is neither", () => {
    expect(isPrimaryRiskReasonCode("RISK_SCENARIO_LOSS_EXCEEDED")).toBe(false);
    expect(isPrimaryRiskReasonCode("NOT_A_CODE")).toBe(false);
    expect(isRiskReasonCode("NOT_A_CODE")).toBe(false);
  });
});

describe("typed results", () => {
  it("a refusal is frozen data carrying its evidence", () => {
    const refusal = riskRefusal("RISK_INPUT_INVALID", "why", { field: "x" });
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(Object.isFrozen(refusal.details)).toBe(true);
    expect(refusal.details["field"]).toBe("x");
  });

  it("riskOk and riskFailure discriminate on `ok`", () => {
    expect(riskOk("value")).toEqual({ ok: true, value: "value" });
    const failure = riskFailure(riskRefusal("RISK_INPUT_INVALID", "why"));
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.refusals).toHaveLength(1);
  });
});
