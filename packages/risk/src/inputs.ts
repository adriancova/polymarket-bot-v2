/**
 * Evaluation input views.
 *
 * Everything the §9.8 pipeline consumes arrives HERE, caller-supplied and
 * validated: this package reads no clock, opens no connection, and queries
 * nothing. A required view that is absent makes the affected check FAIL
 * CLOSED — unknown blocks, never permits.
 *
 * Two views are STRUCTURAL PORTS from `@polymarket-bot/capital-allocator`
 * (`allocation`, `exposures`): the two packages share layer 1 and
 * `docs/contracts/dependency-direction.md` §2.1 lists no edge between them,
 * so the shapes are mirrored structurally (loose objects — this package reads
 * the named fields and ignores the rest) and pinned by the compile-time
 * assignability test in `test/unit/risk/` (the WP-110 universe↔settlement
 * precedent, strengthened: the pin is `tsc`-checked, not source-text-parsed).
 */

import { z } from "zod";

import {
  CodeStringSchema,
  IntentSchema,
  InternalMarketIdSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  NonNegativeMoneyStringSchema,
  NonNegativeSharesStringSchema,
  OutcomeSideSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  RunModeSchema,
} from "@polymarket-bot/domain";

import { FreshnessObservationSchema } from "./freshness.js";
import { SCENARIO_KINDS } from "./policy.js";

/** Scope attribution for the §9.7 exposure dimensions (from the universe layer). */
export const ScopeAttributionSchema = z.strictObject({
  seriesKey: CodeStringSchema.optional(),
  underlyingKey: CodeStringSchema.optional(),
  resolutionWindowKey: CodeStringSchema.optional(),
});
export type ScopeAttribution = z.infer<typeof ScopeAttributionSchema>;

/** Per-market context. Absent optional fields mean UNKNOWN and fail closed. */
export const MarketContextSchema = z.strictObject({
  marketId: InternalMarketIdSchema,
  /** `UNKNOWN` is a legitimate, explicitly-stated ignorance. */
  status: z.enum(["ACTIVE", "CLOSE_ONLY", "HALTED", "UNKNOWN"]),
  tickSize: PositiveDecimalStringSchema.optional(),
  minimumOrderSize: PositiveDecimalStringSchema.optional(),
  parametersVersion: NonNegativeIntegerSchema.optional(),
  secondsToClose: NonNegativeIntegerSchema.optional(),
  /**
   * Structural echo of the universe readiness answer (WP-110
   * `evaluateMarketReadiness`): may model-dependent activation proceed?
   */
  settlement: z
    .looseObject({ modelDependentActivationAllowed: z.boolean() })
    .optional(),
  /** §9.8 check 8. Absent = unknown = fail closed. */
  bookSynchronized: z.boolean().optional(),
  scope: ScopeAttributionSchema.optional(),
});
export type MarketContext = z.infer<typeof MarketContextSchema>;

/** The strategy's own virtual position view (§6 invariant 7). */
export const PortfolioPositionSchema = z.strictObject({
  marketId: InternalMarketIdSchema,
  side: OutcomeSideSchema,
  shares: NonNegativeSharesStringSchema,
  costBasis: NonNegativeMoneyStringSchema,
});
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;

export const PortfolioOpenOrderSchema = z.strictObject({
  orderId: NonEmptyStringSchema,
  marketId: InternalMarketIdSchema,
  side: OutcomeSideSchema,
  action: z.enum(["BUY", "SELL"]),
  price: PriceStringSchema,
  shares: PositiveDecimalStringSchema,
});
export type PortfolioOpenOrder = z.infer<typeof PortfolioOpenOrderSchema>;

export const PortfolioViewSchema = z.strictObject({
  positions: z.array(PortfolioPositionSchema).readonly(),
  openOrders: z.array(PortfolioOpenOrderSchema).readonly(),
});
export type PortfolioView = z.infer<typeof PortfolioViewSchema>;

/**
 * STRUCTURAL PORT — one exposure entry as
 * `@polymarket-bot/capital-allocator` publishes it. Loose: the allocator adds
 * `combined`, which this package deliberately RECOMPUTES from the two
 * components rather than trusting.
 */
export const ExposureEntryViewSchema = z.looseObject({
  openOrderCommitted: NonNegativeMoneyStringSchema,
  positionCommitted: NonNegativeMoneyStringSchema,
});
export type ExposureEntryView = z.infer<typeof ExposureEntryViewSchema>;

/**
 * STRUCTURAL PORT — the allocator's whole exposure snapshot.
 *
 * THE SCOPE MAPS MAY BE SPARSE, AND SPARSE IS NOT ZERO. This schema cannot
 * express "complete for the scopes this evaluation will query" — the query set
 * is not known until the intent is normalized — so completeness is enforced
 * where it can be: `exposure-limits.ts` refuses
 * (`RISK_EXPOSURE_ENTRY_MISSING`) when a configured cap's queried key is absent
 * from its table, rather than reading the absence as zero exposure (review
 * round 1, BLOCKER 2). A caller states "this scope holds nothing" with an
 * EXPLICIT zero entry; `@polymarket-bot/capital-allocator`'s
 * `exposureSnapshotCovering` produces exactly that for a declared key set.
 *
 * `global` is REQUIRED: an account-wide total is always well defined, so its
 * absence is a malformed snapshot rather than an unqueried scope.
 */
export const ExposureSnapshotViewSchema = z.looseObject({
  global: ExposureEntryViewSchema,
  byStrategyInstance: z.record(z.string(), ExposureEntryViewSchema),
  byMarket: z.record(z.string(), ExposureEntryViewSchema),
  bySeries: z.record(z.string(), ExposureEntryViewSchema),
  byUnderlying: z.record(z.string(), ExposureEntryViewSchema),
  byResolutionWindow: z.record(z.string(), ExposureEntryViewSchema),
});
export type ExposureSnapshotView = z.infer<typeof ExposureSnapshotViewSchema>;

/**
 * STRUCTURAL PORT — the allocator's reservation verdict (§9.8 check 14:
 * balance, allowance, inventory, and reservations). Loose: the permitted arm
 * carries the reservation, which this package does not read.
 */
export const AllocationVerdictViewSchema = z.looseObject({
  permitted: z.boolean(),
  refusals: z
    .array(z.looseObject({ code: z.string() }))
    .readonly()
    .optional(),
});
export type AllocationVerdictView = z.infer<typeof AllocationVerdictViewSchema>;

/** One scenario's shocked marks (§9.8 check 17). Exact decimals only. */
export const ScenarioViewSchema = z.strictObject({
  scenarioId: CodeStringSchema,
  kind: z.enum(SCENARIO_KINDS),
  /** Shocked YES mark per market; NO is `1 − yes`, computed exactly. */
  marks: z
    .array(z.strictObject({ marketId: InternalMarketIdSchema, yesPrice: PriceStringSchema }))
    .readonly(),
});
export type ScenarioView = z.infer<typeof ScenarioViewSchema>;

export const RiskEvaluationInputSchema = z.strictObject({
  /** The §7.7 intent, validated against the frozen domain contract. */
  intent: IntentSchema,

  /** Caller-supplied evaluation instant (no clock in this package). */
  evaluatedAt: IsoTimestampSchema,

  /** The id the approved-intent record receives IF the intent is approved. */
  identifiers: z.strictObject({
    approvedIntentId: NonEmptyStringSchema,
  }),

  context: z.strictObject({
    runMode: RunModeSchema,
    strategyInstanceId: CodeStringSchema,
    /** §9.8 check 1, caller-computed for THIS intent. */
    runStatePermitsIntent: z.boolean(),
    strategyStatePermitsIntent: z.boolean(),
    /** §9.8 check 4; consulted only when the run mode places real orders. */
    venueEligibility: z
      .enum(["ELIGIBLE", "BLOCKED", "CLOSE_ONLY", "FAILED", "AMBIGUOUS"])
      .optional(),
  }),

  /** Context for every market the intent touches; a missing one fails closed. */
  markets: z.array(MarketContextSchema).readonly(),

  /** Caller-measured staleness (§9.8 check 7). */
  freshness: z.array(FreshnessObservationSchema).readonly(),

  portfolio: PortfolioViewSchema,

  /** §9.8 check 15 input; absent + configured cap = fail closed. */
  exposures: ExposureSnapshotViewSchema.optional(),

  /** §9.8 check 14 input; absent = fail closed. */
  allocation: AllocationVerdictViewSchema.optional(),

  scenarios: z.array(ScenarioViewSchema).readonly(),

  guards: z.strictObject({
    /**
     * Intent ids recently evaluated (§9.8 check 18 duplicate guard). The
     * caller states an EXPLICIT empty list when there are none.
     */
    recentIntentIds: z.array(NonEmptyStringSchema).readonly(),
  }),

  rateLimit: z.strictObject({
    /** Absent = unknown = entries fail closed (§9.8 check 19). */
    availableRequests: NonNegativeIntegerSchema.optional(),
  }),

  economics: z.strictObject({
    /** Estimated fees for the intended order(s). */
    feeEstimate: NonNegativeMoneyStringSchema.optional(),
    /** Estimated slippage cost. */
    slippageEstimate: NonNegativeMoneyStringSchema.optional(),
  }),
});
export type RiskEvaluationInput = z.infer<typeof RiskEvaluationInputSchema>;
