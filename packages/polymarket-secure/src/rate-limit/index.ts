/**
 * Rate-limit budgets and response-header feedback (WP-310; handoff §9.12,
 * §9.13; ADR-007 §9). See `budget.ts` for the model, `configuration.ts` for
 * the snapshot schema, `headers.ts` for the documented headers, `units.ts`
 * for the units and the exactness bound, and `venue-facts.ts` for the
 * citations.
 *
 * PAPER only: nothing here performs I/O, reads a clock, holds a credential or
 * sends anything. It decides WHEN a request may be sent; the composition sends
 * it through the secure venue client and reports the answer back.
 */

export {
  createRateLimitBudget,
  RateLimitBudget,
  type BucketView,
  type BudgetDimension,
  type BudgetEffect,
  type BudgetKeyView,
  type BudgetRefusal,
  type BudgetRefusalCode,
  type BudgetRequest,
  type BudgetResult,
  type BudgetView,
  type Charge,
  type Grant,
  type GrantCompletion,
  type OperationWaitView,
  type PollEvent,
  type RequestDecision,
  type WaitBasis,
  type WindowBudgetView,
  type WindowView,
} from "./budget.js";
export {
  parseRateLimitConfiguration,
  PER_MILLE,
  RATE_LIMIT_CONFIGURATION_SCHEMA,
  RateLimitConfigurationTimeline,
  type BackoffPolicy,
  type ConfigurationResult,
  type ConfigurationSource,
  type IpEndpointClassConfig,
  type OperationConfig,
  type RateLimitConfiguration,
  type RateLimitPolicy,
  type SignerBucket,
  type SignerTierConfig,
  type SlidingWindowLimit,
  type SourceDocument,
  type TokenCostRule,
} from "./configuration.js";
export {
  DOCUMENTED_RATE_LIMIT_HEADERS,
  feedbackFromObservation,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_EARLY,
  HTTP_TOO_MANY_REQUESTS,
  parseRateLimitHeaders,
  signerBucketOfObservation,
  type FeedbackFlag,
  type RateLimitFeedback,
} from "./headers.js";
export {
  OPERATION_KINDS,
  PERMITTED_PRIORITIES,
  PRIORITY_LADDER,
  priorityRank,
  type OperationKind,
  type PriorityClass,
} from "./priority.js";
export { isExactTokenCount, MAX_TOKEN_MAGNITUDE, MILLI_PER_TOKEN, MS_PER_SECOND } from "./units.js";
export { PINNED_SDK, RATE_LIMIT_VENUE_FACTS, type RateLimitVenueFact } from "./venue-facts.js";
