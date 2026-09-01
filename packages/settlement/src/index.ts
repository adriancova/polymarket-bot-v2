/**
 * `@polymarket-bot/settlement` — settlement specifications and payoff models
 * (WP-110, handoff §9.3, ADR-009).
 *
 * What this package owns:
 *
 * - the §9.3 `SettlementSpec` structure, validated as a strict Zod contract,
 *   including the rule that makes a spec usable at all (`verified_by` /
 *   `verified_at`);
 * - the four §9.3 payoff models, the total compatibility matrix that selects
 *   one from a spec, and the refusal that keeps a terminal-spot model away from
 *   a TWAP-settled market;
 * - the outcome-state payouts, exact to the decimal, including the 50/50 case;
 * - the model-dependent activation verdict the universe layer consumes.
 *
 * DEPENDENCY DIRECTION (`docs/contracts/dependency-direction.md`): layer 1. It
 * depends downward on `@polymarket-bot/domain` and `@polymarket-bot/decimal`
 * and on `zod`, and on nothing else — no adapter, no storage, no transport, and
 * (deliberately) not on `@polymarket-bot/universe`, which is the same layer.
 *
 * PURITY: no I/O, no clock, no randomness, no state. Every function is a pure
 * function of its arguments, which is what lets a replayed settlement reproduce
 * a live one exactly (§12.4).
 */

export {
  SettlementError,
  SettlementSpecValidationError,
  settlementFailure,
  settlementOk,
  settlementRefusal,
} from "./errors.js";
export type {
  SettlementRefusal,
  SettlementRefusalCode,
  SettlementRefusalDetails,
  SettlementResult,
} from "./errors.js";

export {
  ComparisonOperatorSchema,
  COMPARISON_OPERATORS,
  MarketOutcomeStateSchema,
  ObservationTypeSchema,
  OBSERVATION_TYPES,
  PayoffModelIdSchema,
  PAYOFF_MODEL_IDS,
  TerminalMarketOutcomeStateSchema,
  VerificationStatusSchema,
  isTerminalMarketOutcomeState,
} from "./vocabulary.js";
export type {
  ComparisonOperator,
  MarketOutcomeState,
  ObservationType,
  PayoffModelId,
  TerminalMarketOutcomeState,
  VerificationStatus,
} from "./vocabulary.js";

export {
  PLACEHOLDER_RULE_PREFIXES,
  PLACEHOLDER_RULE_TEXTS,
  RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24,
  placeholderRuleTextReason,
  SettlementRuleTextSchema,
  SettlementSpecSchema,
  SettlementVerificationSchema,
  isReviewedSettlementSpec,
  parseSettlementSpec,
  safeParseSettlementSpec,
  settlementSpecReviewBlockers,
} from "./spec.js";
export type {
  SettlementReviewContext,
  SettlementSpec,
  SettlementVerification,
} from "./spec.js";

export {
  checkPayoffModelCompatibility,
  isCompatiblePayoffModel,
  observationTypesForPayoffModel,
  payoffModelRequirements,
  payoffModelsForObservationType,
} from "./models/compatibility.js";
export type {
  ConstrainedSpecField,
  PayoffModelFieldRequirements,
  PayoffModelSpecView,
} from "./models/compatibility.js";

export {
  evaluateSettlement,
  satisfiesComparison,
  selectPayoffModel,
} from "./models/registry.js";
export type { ComparisonEvaluation, SettlementEvaluation } from "./models/registry.js";

export {
  ObservedExtremeKindSchema,
  ReferenceOpenUpDownObservationSchema,
  SettlementObservationSchema,
  TerminalSpotObservationSchema,
  ThresholdByDateObservationSchema,
  TwapObservationSchema,
} from "./observation.js";
export type {
  ObservedExtremeKind,
  ReferenceOpenUpDownObservation,
  SettlementObservation,
  TerminalSpotObservation,
  ThresholdByDateObservation,
  TwapObservation,
} from "./observation.js";

export {
  LOSING_TOKEN_PAYOUT_PER_SHARE,
  SPLIT_50_50_PAYOUT_PER_SHARE,
  WINNING_TOKEN_PAYOUT_PER_SHARE,
  payoutPerShare,
  positionSettlementValue,
  settlementValue,
} from "./payout.js";
export type { OutcomePayoutPerShare } from "./payout.js";

export {
  ACTIVATION_PERMITTED_STATUS,
  SETTLEMENT_ACTIVATION_STATUSES,
  classifySettlementActivation,
} from "./activation.js";
export type {
  SettlementActivationInput,
  SettlementActivationStatus,
  SettlementActivationVerdict,
} from "./activation.js";

export { instantMilliseconds, isAtOrAfter, isBefore } from "./time.js";
