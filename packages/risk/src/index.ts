/**
 * `@polymarket-bot/risk` — WP-180.
 *
 * The handoff §9.8 pre-trade risk-policy engine: twenty checks in the order
 * §9.8 lists them, with WORST-CASE CONTRACTUAL LOSS as the primary hard limit
 * (grounded in WP-110's venue-verified settlement payoffs; the unverified
 * `CANCELLED` outcome is floor-bounded, never valued — register row U-10).
 * Structured, package-owned reason codes on every rejection; approved-intent
 * records with resize-as-a-new-record lineage (§7.7); and typed incident action
 * RECOMMENDATIONS for the §9.9 controller, which is a later package.
 *
 * Pure layer-1 logic (`docs/contracts/dependency-direction.md` §2): no I/O, no
 * clock, no network, no credential surface, no order-placement surface, and
 * exact decimal arithmetic for every monetary and size value. Staleness arrives
 * as caller-supplied measurements; nothing here reads a clock.
 *
 * The full reason-code vocabulary and the entry/exit/cancel check matrix are
 * documented in this package's `README.md`.
 */

export {
  PRIMARY_RISK_REASON_CODES,
  RISK_REASON_CODES,
  isPrimaryRiskReasonCode,
  isRiskReasonCode,
} from "./reasons.js";
export type { PrimaryRiskReasonCode, RiskReasonCode } from "./reasons.js";

export { riskFailure, riskOk, riskRefusal } from "./result.js";
export type { RiskRefusal, RiskRefusalDetails, RiskResult } from "./result.js";

export { RiskPolicySchema, SCENARIO_KINDS, parseRiskPolicy } from "./policy.js";
export type { RiskPolicy, ScenarioKind } from "./policy.js";

export {
  FRESHNESS_FEEDS,
  FreshnessObservationSchema,
  FreshnessPolicySchema,
  assessFreshness,
  blocksAsStale,
} from "./freshness.js";
export type {
  FreshnessAssessment,
  FreshnessFeed,
  FreshnessFinding,
  FreshnessObservation,
  FreshnessPolicy,
  FreshnessStatus,
} from "./freshness.js";

export {
  AllocationVerdictViewSchema,
  ExposureEntryViewSchema,
  ExposureSnapshotViewSchema,
  MarketContextSchema,
  PortfolioOpenOrderSchema,
  PortfolioPositionSchema,
  PortfolioViewSchema,
  RiskEvaluationInputSchema,
  ScenarioViewSchema,
  ScopeAttributionSchema,
} from "./inputs.js";
export type {
  AllocationVerdictView,
  ExposureEntryView,
  ExposureSnapshotView,
  MarketContext,
  PortfolioOpenOrder,
  PortfolioPosition,
  PortfolioView,
  RiskEvaluationInput,
  ScenarioView,
  ScopeAttribution,
} from "./inputs.js";

export {
  CANCELLED_OUTCOME_TREATMENT,
  LOSING_TOKEN_PAYOUT_PER_SHARE,
  SPLIT_50_50_PAYOUT_PER_SHARE,
  VERIFIED_TERMINAL_OUTCOMES,
  WINNING_TOKEN_PAYOUT_PER_SHARE,
  assessWorstCase,
  settlementValueUnderOutcome,
} from "./worst-case.js";
export type {
  MarketHoldingLot,
  MarketWorstCase,
  PerOutcomeSettlementValue,
  VerifiedTerminalOutcome,
  WorstCaseAssessment,
} from "./worst-case.js";

export { buildWorstCaseLots } from "./lots.js";

export { assessScenarios } from "./scenario.js";
export type { ScenarioAssessment, ScenarioOutcome } from "./scenario.js";

export { buildIntentView, heldShares } from "./intent-view.js";
export type { IntentDisposition, IntentLeg, IntentView } from "./intent-view.js";

export { checkExposureLimits } from "./exposure-limits.js";
export type { ExposureProbe } from "./exposure-limits.js";

export { ResizeRequestSchema, resizeApprovedIntent } from "./approved-intent.js";
export type {
  ApprovedIntentLineage,
  ApprovedIntentRecord,
  ResizeRequest,
  WorstCaseBasis,
} from "./approved-intent.js";

export {
  INCIDENT_ACTION_LADDER,
  INCIDENT_FAILURE_CLASSES,
  recommendIncidentActions,
} from "./recommendations.js";
export type {
  IncidentAction,
  IncidentActionRecommendation,
  IncidentFailureClass,
  RecommendationOrdersScope,
} from "./recommendations.js";

export { instantMilliseconds, isExpired } from "./time.js";

export { evaluateIntent } from "./engine.js";
export type { RiskEvaluation } from "./engine.js";
