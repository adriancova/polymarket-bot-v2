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
import { readPlainData, withSchemaDefaults, type SchemaDefault } from "./plain-data.js";
import { contained, riskFailure, riskOk, riskRefusal, type RiskResult } from "./result.js";
import { prototypeFreeParser } from "./schema-arena.js";

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
 * EVERY value this schema supplies when the caller omits the field.
 *
 * WHY A TABLE AND NOT THE PARSE OUTPUT (review round 7). A `.default()` is the
 * one part of a validated policy that does not come from the caller, so it is
 * the one part {@link parseRiskPolicy} cannot take from the materialized read —
 * and taking it from `zod`'s output is what proposition 5 in `plain-data.ts`
 * forbids, for a measured reason. With a single get-only accessor on
 * `Object.prototype`, `zod` fails to assign its own default, the key is not own
 * in the output, and the later read of it walks the chain to the attacker's
 * value. At the round-6 tip that silently disabled real checks:
 *
 * ```text
 * get-only Object.prototype.requireVerifiedSettlementForEntries
 *   → §9.8 check 6 skipped; an entry with unverified settlement was APPROVED
 * get-only Object.prototype.requirePositiveNetEdgeForEntries
 *   → §9.8 check 12 skipped; an entry with a NEGATIVE net edge was APPROVED
 * get-only Object.prototype.maxRunMode
 *   → §9.8 check 2 gone; a LIVE run mode no longer exceeded the maximum
 * ```
 *
 * The table is bound to the schema by `test/unit/risk/schema-output.test.ts`:
 * every `.default()` in `RiskPolicySchema` must appear here with the same value,
 * and an entry here that the schema does not declare fails too. Adding a default
 * to the schema without adding it here does not compile past that test.
 */
export const RISK_POLICY_DEFAULTS: readonly SchemaDefault[] = Object.freeze([
  { path: Object.freeze(["maxRunMode"]), value: "PAPER" },
  { path: Object.freeze(["requireVerifiedSettlementForEntries"]), value: true },
  { path: Object.freeze(["scenario", "requiredKinds"]), value: [...SCENARIO_KINDS] },
  { path: Object.freeze(["economics", "riskBuffer"]), value: "0" },
  { path: Object.freeze(["economics", "requirePositiveNetEdgeForEntries"]), value: true },
] as const);

/**
 * The door's parsing copy of {@link RiskPolicySchema} (review round 8).
 *
 * Same validation, node for node — see `schema-arena.ts` — assembled onto
 * containers with NO PROTOTYPE, with a parse context that has none either. An
 * inherited SETTER can no longer be invoked while the library builds an output
 * this door discards, and an inherited `skipChecks` can no longer turn the
 * library's format checks into no-ops.
 */
const RiskPolicyParser = prototypeFreeParser(RiskPolicySchema);

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
      const parsed = RiskPolicyParser.safeParse(read.value);
      if (!parsed.success) {
        return riskFailure<RiskPolicy>(
          riskRefusal("RISK_INPUT_INVALID", "risk policy failed validation", {
            issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          }),
        );
      }
      // THE VALIDATED POLICY IS THE MATERIALIZED TREE (review round 7). The
      // parse answered the QUESTION; its output object is not read. `read.value`
      // is own data with no prototype, so an ABSENT OPTIONAL LIMIT
      // (`limits.perMarketExposureCap`, `economics.minOrderNotional`,
      // `participation.maxOrderShares`) stays absent for every read downstream
      // instead of being answered by `Object.prototype`, and a limit the caller
      // DID configure can no longer vanish in the library's output assembly.
      // The schema's own defaults are applied from the declared table, because
      // they are the one part of the answer the caller did not supply.
      const defaulted = withSchemaDefaults(read.value, RISK_POLICY_DEFAULTS);
      if (!defaulted.ok) {
        return riskFailure<RiskPolicy>(
          riskRefusal(
            "RISK_INPUT_INVALID",
            "a policy default could not be applied to the validated policy, so a safety default would be missing rather than enforced (fail closed)",
            { unfilled: [...defaulted.unfilled] },
          ),
        );
      }
      return riskOk(Object.freeze(defaulted.value as RiskPolicy));
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
