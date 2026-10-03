/**
 * `@polymarket-bot/polymarket-secure` (WP-260): the secure unified-SDK adapter
 * and signer boundary. The ONLY package that may import `@polymarket/client`
 * (handoff §9.12; ADR-010 §4; `dependency-direction.md` F6).
 *
 * WHAT THIS ENTRY POINT EXPORTS
 * - the narrow interface (`SecureVenueClient` and its outcome types);
 * - the one factory, `createSecureVenueClient`, which runs the run-mode gate
 *   before anything else and refuses in every BACKTEST, PAPER, SHADOW or
 *   unrecognised (e.g. REPLAY) process (ADR-010 §3);
 * - the gate itself, for a composition root that wants to check early;
 * - the redacted error types and the log redactor.
 *
 * WHAT IT DOES NOT EXPORT: any way to construct a signer handle, any signer,
 * the SDK client, SDK types, or any code that reads an environment variable
 * or a key. This package holds no key and loads none. Test doubles live in
 * `@polymarket-bot/polymarket-secure/testing`. See `docs/runbooks/signer.md`.
 */

export const workspacePackageName = "@polymarket-bot/polymarket-secure" as const;

export {
  createSecureVenueClient,
  MAX_CANCEL_IDS_PER_REQUEST,
  MAX_ORDERS_PER_BATCH,
  type CancelMarketFilter,
  type CreateSecureVenueClientOptions,
  type LimitOrderRequest,
  type RateLimitObservation,
  type SecureVenueClient,
  type SignOutcome,
  type VenueAccountIdentity,
} from "./venue-client.js";
export {
  DOCUMENTED_NOT_CANCELED_REASONS,
  type AcceptedPlacementStatus,
  type CancelOutcome,
  type NotCanceledEntry,
  type PlacementOutcome,
  type PlacementRejectionReason,
  type PlacementUnknownReason,
  type QueryOutcome,
  type VenueOrderSnapshot,
} from "./outcomes.js";
export {
  createRateLimitBudget,
  DOCUMENTED_RATE_LIMIT_HEADERS,
  feedbackFromObservation,
  parseRateLimitConfiguration,
  parseRateLimitHeaders,
  PRIORITY_LADDER,
  RATE_LIMIT_CONFIGURATION_SCHEMA,
  RATE_LIMIT_VENUE_FACTS,
  RateLimitBudget,
  RateLimitConfigurationTimeline,
  signerBucketOfObservation,
  type BudgetEffect,
  type BudgetRefusal,
  type BudgetRequest,
  type BudgetResult,
  type BudgetView,
  type FeedbackFlag,
  type Grant,
  type GrantCompletion,
  type PollEvent,
  type PriorityClass,
  type RateLimitConfiguration,
  type RateLimitFeedback,
  type RequestDecision,
} from "./rate-limit/index.js";
export { SignedOrderEnvelope, type SignedOrderIdentity } from "./signed-order.js";
export { isSealedSignerHandle, SignerHandle, type SignerProvenance } from "./signer.js";
export {
  assertSignerGate,
  evaluateSignerGate,
  signerGateContextFromSafetyFlags,
  type SignerGateContext,
  type SignerGateVerdict,
} from "./run-mode-gate.js";
export {
  DOCUMENTED_VENUE_ERROR_CODES,
  SecureVenueError,
  SignerBoundaryRefusal,
  type CancelsAvailability,
  type RequestEffect,
  type SecureOperation,
  type SecureVenueErrorData,
  type SecureVenueErrorKind,
  type SignerRefusalReason,
} from "./errors.js";
export { isSensitiveKey, REDACTED, redactForLog } from "./redaction.js";
export * from "./user-stream/index.js";
