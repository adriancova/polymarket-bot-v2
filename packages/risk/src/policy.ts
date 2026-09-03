/**
 * Risk policy — the user-defined limit configuration the §9.8 pipeline
 * enforces.
 *
 * "Initial defaults should reflect user-defined caps rather than hardcoded
 * historical examples" (§9.7): every ECONOMIC limit here is required or
 * optional with NO invented default number. The only defaults are safety
 * floors and booleans:
 *
 * - `maxRunMode` defaults to `"PAPER"` (the untouchable repository maximum —
 *   `AGENTS.md` `MAX_RUN_MODE=PAPER`; nothing in this package raises it
 *   implicitly);
 * - `requireVerifiedSettlementForEntries` defaults `true` (§9.8 check 6);
 * - `economics.requirePositiveNetEdgeForEntries` defaults `true` (§9.8
 *   check 12); `economics.riskBuffer` defaults `"0"` (a zero buffer weakens
 *   nothing — the edge must still be strictly positive);
 * - `scenario.requiredKinds` defaults to ALL FOUR shock kinds (§9.8 primary
 *   measures: "scenario loss under spot, volatility, time, and liquidity
 *   shocks") — fail closed: an entry without every required scenario supplied
 *   is rejected.
 *
 * `limits.maxWorstCaseContractualLoss` is REQUIRED: the primary hard limit
 * (workplan acceptance 2) cannot be configured away.
 */

import { z } from "zod";

import {
  NonNegativeIntegerSchema,
  NonNegativeMoneyStringSchema,
  PositiveDecimalStringSchema,
  RunModeSchema,
} from "@polymarket-bot/domain";

import { FreshnessPolicySchema } from "./freshness.js";
import { readPlainData } from "./plain-data.js";
import { contained, riskFailure, riskOk, riskRefusal, type RiskResult } from "./result.js";

export const SCENARIO_KINDS = ["SPOT", "VOLATILITY", "TIME", "LIQUIDITY"] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

export const RiskPolicySchema = z.strictObject({
  maxRunMode: RunModeSchema.default("PAPER"),
  requireVerifiedSettlementForEntries: z.boolean().default(true),

  freshness: FreshnessPolicySchema,

  limits: z.strictObject({
    /** PRIMARY hard limit (§9.8 check 16; acceptance 2). Required. */
    maxWorstCaseContractualLoss: NonNegativeMoneyStringSchema,
    /** Optional cap on the verified-outcome measure (§9.8 "worst-case resolution PnL"). */
    maxWorstCaseResolutionLoss: NonNegativeMoneyStringSchema.optional(),
    maxOrderNotional: NonNegativeMoneyStringSchema.optional(),
    globalExposureCap: NonNegativeMoneyStringSchema.optional(),
    perInstanceExposureCap: NonNegativeMoneyStringSchema.optional(),
    perMarketExposureCap: NonNegativeMoneyStringSchema.optional(),
    perSeriesExposureCap: NonNegativeMoneyStringSchema.optional(),
    perUnderlyingExposureCap: NonNegativeMoneyStringSchema.optional(),
    perResolutionWindowExposureCap: NonNegativeMoneyStringSchema.optional(),
  }),

  scenario: z.strictObject({
    maxScenarioLoss: NonNegativeMoneyStringSchema,
    requiredKinds: z
      .array(z.enum(SCENARIO_KINDS))
      .readonly()
      .default([...SCENARIO_KINDS]),
  }),

  economics: z.strictObject({
    /** §9.8 check 11 "economic floor" — user-defined, applies to entries. */
    minOrderNotional: NonNegativeMoneyStringSchema.optional(),
    /** §9.8 check 12 risk buffer subtracted from the expected edge. */
    riskBuffer: NonNegativeMoneyStringSchema.default("0"),
    requirePositiveNetEdgeForEntries: z.boolean().default(true),
  }),

  participation: z.strictObject({
    /**
     * §9.8 check 13 v1 floor: a hard per-order share cap. Depth-fraction
     * participation belongs to the execution planner's slicing (§9.10,
     * WP-190) — documented in `README.md`.
     */
    maxOrderShares: PositiveDecimalStringSchema.optional(),
  }),

  rateLimit: z.strictObject({
    /** §9.8 check 19: entries need headroom strictly above this reserve. */
    safetyReserveRequests: NonNegativeIntegerSchema,
  }),

  timeToClose: z.strictObject({
    /** §9.8 check 20: entries are blocked at or under this many seconds to close. */
    entryCutoffSeconds: NonNegativeIntegerSchema,
  }),
});

export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

/**
 * Validates a caller-supplied policy; refuses rather than repairing.
 *
 * READ AS DATA BEFORE IT IS PARSED (review round 5, BLOCKER 3). A policy is a
 * caller-supplied `unknown`, and handing one straight to `safeParse` means `zod`
 * READS its properties — so a throwing getter on a required field escaped this
 * function as an exception. The materialized value is what the schema sees, and
 * the outer {@link contained} guard makes the typed-result promise structural
 * rather than a claim about having found every site.
 */
export function parseRiskPolicy(input: unknown): RiskResult<RiskPolicy> {
  return contained(
    () => {
      const read = readPlainData(input, "policy");
      if (!read.ok) {
        return riskFailure<RiskPolicy>(
          riskRefusal(
            "RISK_INPUT_INVALID",
            "the risk policy is not a data record: a configuration is a finite tree of plain own data, so hidden, inherited, computed or unreadable state is refused rather than inspected (fail closed)",
            { issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`) },
          ),
        );
      }
      const parsed = RiskPolicySchema.safeParse(read.value);
      if (!parsed.success) {
        return riskFailure<RiskPolicy>(
          riskRefusal("RISK_INPUT_INVALID", "risk policy failed validation", {
            issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          }),
        );
      }
      return riskOk(Object.freeze(parsed.data));
    },
    (thrown) =>
      riskFailure(
        riskRefusal(
          "RISK_INPUT_INVALID",
          "validating the risk policy failed unexpectedly; a policy that cannot be validated is not a usable policy (fail closed)",
          { thrown },
        ),
      ),
  );
}
