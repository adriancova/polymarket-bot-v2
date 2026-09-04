/**
 * Fixtures for the WP-190 execution-planner suite.
 *
 * THE APPROVED-INTENT RECORDS ARE REAL: every record fed to the planner here
 * is minted by `packages/risk`'s own `evaluateIntent` (or descended from one
 * via `resizeApprovedIntent`) over WP-180's own test fixtures — so the suite
 * consumes WP-180's output exactly as it is shaped at `98a6cc1`, and a drift
 * in that shape fails THIS suite rather than being papered over by a private
 * copy. Importing both packages from the test tree declares no workspace
 * edge (`test/unit/risk/ports.test.ts` precedent, asserted again in this
 * package's `ports.test.ts`).
 *
 * Baseline arithmetic (all exact, chosen for hand-checkable numbers):
 * book YES 0.48/0.50, NO 0.50/0.52 on tick 0.01; a NORMAL TAKER_OK BUY of
 * 100 YES capped at 0.50 rests at 0.48, costs at worst 48, and slices
 * [60, 40] under `maxSliceShares: "60"` with minimum order size 5.
 */

import {
  evaluateIntent,
  resizeApprovedIntent,
  type ApprovedIntentRecord,
} from "../../../packages/risk/src/index.js";
import {
  EVALUATED_AT,
  VALID_UNTIL,
  INSTANCE,
  MARKET_A,
  MARKET_B,
  allScenarios,
  cancelIntent,
  entryInput,
  exitInput,
  market as riskMarket,
  position,
  positionIntent,
  riskPolicy,
  type EvaluationInputFixture,
} from "../risk/fixtures.js";

export {
  EVALUATED_AT,
  VALID_UNTIL,
  INSTANCE,
  MARKET_A,
  MARKET_B,
  cancelIntent,
  position,
  positionIntent,
};

/** A canonical lowercase UUIDv7 plan id (ADR-016 §2 compliant). */
export const PLAN_ID = "01890000-0000-7000-8000-0000000000aa";

/** Mints a REAL approved-intent record through the risk engine, or throws. */
export function approvedRecordFor(input: EvaluationInputFixture): ApprovedIntentRecord {
  const evaluation = evaluateIntent(riskPolicy(), input);
  if (!evaluation.approved) {
    throw new Error(
      `fixture expected approval, got refusals: ${JSON.stringify(
        evaluation.refusals.map((refusal) => refusal.code),
      )}`,
    );
  }
  return evaluation.record;
}

/**
 * A real approved POSITION record (BUY 100 YES, cap 0.5, NORMAL/TAKER_OK).
 * A sell-delta needs the RISK-side portfolio to hold the position too
 * (§9.8 check 14 fires there first), so `positions` feeds risk's own view.
 */
export function approvedPosition(
  intentOverrides: Record<string, unknown> = {},
  positions?: Array<Record<string, unknown>>,
): ApprovedIntentRecord {
  const input = entryInput();
  input.intent = positionIntent(intentOverrides);
  if (positions !== undefined) input.portfolio.positions = positions;
  return approvedRecordFor(input);
}

/** A real approved REDUCE_POSITION record over a held 100-YES position. */
export function approvedReduction(
  intentOverrides: Record<string, unknown> = {},
): ApprovedIntentRecord {
  const input = exitInput();
  input.intent = { ...input.intent, ...intentOverrides };
  return approvedRecordFor(input);
}

/** A real approved CANCEL record (§6 invariant 13: cancels are approvable). */
export function approvedCancel(intentOverrides: Record<string, unknown> = {}): ApprovedIntentRecord {
  const input = entryInput();
  input.intent = cancelIntent(intentOverrides);
  return approvedRecordFor(input);
}

/** A §7.7 basket intent over MARKET_A (one bounded buying leg). */
export function basketIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "BASKET",
    intentId: "intent-basket-1",
    legs: [
      { marketId: MARKET_A, direction: "YES", targetShares: "50", maximumBuyPrice: "0.5" },
    ],
    maximumCombinedCost: "30",
    minimumLockedEdge: "1",
    legRiskLimit: "30",
    failurePolicy: "ABANDON",
    validUntil: VALID_UNTIL,
    ...overrides,
  };
}

/**
 * A real approved BASKET record. `options.marketIds` widens the RISK-side
 * market contexts and scenario marks to every market the legs trade;
 * `options.positions` feeds risk's portfolio for selling legs (check 14).
 */
export function approvedBasket(
  intentOverrides: Record<string, unknown> = {},
  options: { marketIds?: readonly string[]; positions?: Array<Record<string, unknown>> } = {},
): ApprovedIntentRecord {
  const input = entryInput();
  input.intent = basketIntent(intentOverrides);
  if (options.marketIds !== undefined) {
    input.markets = options.marketIds.map((marketId) => riskMarket({ marketId }));
    input.scenarios = allScenarios("0.4", options.marketIds);
    input.freshness = [
      ...options.marketIds.map((marketId) => ({ feed: "VENUE_BOOK", marketId, ageMs: 100 })),
      { feed: "REFERENCE_FEED", ageMs: 100 },
      { feed: "FEATURES", ageMs: 100 },
    ];
  }
  if (options.positions !== undefined) input.portfolio.positions = options.positions;
  return approvedRecordFor(input);
}

/** A real RESIZED record descended from an approved POSITION record. */
export function resizedPosition(newTargetShares = "40"): ApprovedIntentRecord {
  const original = approvedPosition();
  const resized = resizeApprovedIntent(original, {
    approvedIntentId: "approved-1-resized",
    resizedAt: EVALUATED_AT,
    newTargetShares,
    reason: "risk reduction",
  });
  if (!resized.ok) {
    throw new Error(`fixture resize refused: ${JSON.stringify(resized.refusals.map((r) => r.code))}`);
  }
  return resized.value;
}

export interface PlanningInputsFixture {
  executionPlanId: string;
  plannedAt: string;
  accountingMode: string;
  availableCollateral: string;
  markets: Array<Record<string, unknown>>;
  policy: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

/** One market's planning input, mutable for per-test deltas. */
export function marketInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    marketId: MARKET_A,
    tickSize: "0.01",
    minimumOrderSize: "5",
    // Arbitrary TEST rates: fee facts are caller data, never venue claims.
    makerFeeRate: "0",
    takerFeeRate: "0.01",
    book: { yesBestBid: "0.48", yesBestAsk: "0.5", noBestBid: "0.5", noBestAsk: "0.52" },
    inventory: {
      yes: { held: "0", reserved: "0" },
      no: { held: "0", reserved: "0" },
    },
    ...overrides,
  };
}

/** The fully-valid planning-inputs baseline. */
export function planningInputs(overrides: Partial<PlanningInputsFixture> = {}): PlanningInputsFixture {
  return {
    executionPlanId: PLAN_ID,
    plannedAt: EVALUATED_AT,
    accountingMode: "LIVE",
    availableCollateral: "1000",
    markets: [marketInput()],
    policy: {
      maxSliceShares: "60",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 2,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 30000,
      maxPlanLifetimeMs: 600000,
    },
    scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
    ...overrides,
  };
}

/** Collects refusal codes from a planner failure result. */
export function planCodesOf(result: {
  readonly ok: boolean;
  readonly refusals?: readonly { readonly code: string }[];
}): string[] {
  if (result.ok || result.refusals === undefined) return [];
  return result.refusals.map((refusal) => refusal.code);
}
