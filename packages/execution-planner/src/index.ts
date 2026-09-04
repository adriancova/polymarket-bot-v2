/**
 * `@polymarket-bot/execution-planner` — WP-190.
 *
 * The handoff §9.10 execution planner: converts approved intents into
 * IMMUTABLE execution plans — economic-leg selection that respects ACTUAL
 * unreserved inventory, exact tick-conforming prices with capped marketable
 * limits, slicing, cancel/replace hysteresis, deadline and escalation policy,
 * partial-fill handling, coordinated-basket leg-risk policy (a basket is
 * NEVER labeled atomic), labeled estimates, and reservation requirements
 * that must be applied before submission.
 *
 * Pure layer-1 logic (`docs/contracts/dependency-direction.md` §2): no I/O,
 * no clock, no network, no credential surface, no order placement — the
 * planner produces plan DATA; submission belongs to the OMS. Exact decimal
 * strings for every economic field; the planning instant, the book, the
 * versioned trading parameters and the inventory all arrive as caller data.
 *
 * The refusal vocabulary and the planning rule tables are documented in this
 * package's `README.md`.
 */

export {
  PLANNER_REFUSAL_CODES,
  PLANNER_REFUSAL_CODES_ARE_EXHAUSTIVE,
  PLANNER_REFUSAL_CODE_COUNT,
  isPlannerRefusalCode,
  plannerFailure,
  plannerOk,
  plannerRefusal,
} from "./refusals.js";
export type {
  PlannerRefusal,
  PlannerRefusalCode,
  PlannerRefusalDetails,
  PlannerResult,
} from "./refusals.js";

export {
  PLAN_PRIORITY_RANK,
  comparePlanPriority,
  sealExecutionPlan,
} from "./plan.js";
export type {
  BasketPlan,
  CancelPlan,
  ExecutionGroup,
  ExecutionPlan,
  LegSelection,
  LegSelectionChoice,
  LegSelectionReason,
  PartialFillHandling,
  PlacementPlan,
  PlanEstimates,
  PlanPriority,
  PlanProvenance,
  PlannedOrder,
  ReplaceHysteresis,
  ReservationRequirement,
} from "./plan.js";

export { buildExecutionPlan } from "./build.js";

export {
  MAX_EXECUTION_PLAN_ID_LENGTH,
  marketInputFor,
  readCancelPlanningInputs,
  readPlanningInputs,
} from "./inputs.js";
export type {
  CancelPlanningInputs,
  MarketBookInputs,
  MarketPlanningInput,
  PlanningInputs,
  PlanningPolicy,
  ScopeAttribution,
  SideInventory,
} from "./inputs.js";

export {
  APPROVED_INTENT_LINEAGES,
  APPROVED_INTENT_RECORD_KEYS,
  WORST_CASE_BASES,
  readApprovedCancel,
  readApprovedIntentRecord,
} from "./record.js";
export type { ApprovedIntentView } from "./record.js";

export { freeShares, oppositeSide, selectDecreaseLeg, selectIncreaseLeg } from "./leg.js";
export type { DecreaseLegInputs, IncreaseLegInputs, LegSelectionResult, SelectedLeg } from "./leg.js";

export {
  buyLimitPrice,
  positionPosture,
  reductionPosture,
  sellLimitPrice,
} from "./price.js";
export type { BuyPriceInputs, ExecutionPosture, PriceOutcome, SellPriceInputs } from "./price.js";

export { MAX_PLAN_SLICES, sliceShares } from "./slice.js";
export type { SliceResult } from "./slice.js";

export { ceilToTick, floorToTick, isOnTick, sliceDivision, tickTimes } from "./tick.js";

export {
  earlierInstant,
  instantMilliseconds,
  instantPlusMilliseconds,
  isExpired,
} from "./time.js";
