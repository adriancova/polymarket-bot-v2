/**
 * `@polymarket-bot/oms` — the order management system and signed-order
 * persistence (WP-270; handoff §9.11; ADR-007).
 *
 * Layer 1 (`docs/contracts/dependency-direction.md` §2): depends only on
 * `@polymarket-bot/decimal`. No I/O, no clock, no randomness, no key, no
 * credential, no network. The venue (WP-260's secure adapter), the store
 * (migration 0005), the payload cipher (§15), the inventory (WP-300) and the
 * reconciliation coordinator (WP-290) are reached only through the injected
 * ports in `ports.ts`. Every test mocks them; nothing here can place a real
 * order. PAPER only: this package changes no run-mode default (ADR-010).
 *
 * The expected order hash is a STOPPED item: it is persisted as `null` and
 * never computed (see `order-manager.ts`, and the WP-270 handoff for the ADR
 * options).
 */

export const workspacePackageName = "@polymarket-bot/oms" as const;

export {
  OMS_REFUSAL_CODES,
  type EvidenceValue,
  type OmsRefusal,
  type OmsRefusalCode,
  type OmsResult,
} from "./refusals.js";

export {
  ATTEMPT_STATES,
  ATTEMPT_TRANSITIONS,
  ORDER_STATES,
  ORDER_TRANSITIONS,
  SETTLEMENT_STATES,
  SETTLEMENT_TRANSITIONS,
  TERMINAL_ORDER_STATES,
  TERMINAL_SETTLEMENT_STATES,
  isLegalAttemptTransition,
  isLegalOrderTransition,
  isLegalSettlementTransition,
  type AttemptState,
  type OrderState,
  type SettlementState,
} from "./states.js";

export type {
  AttemptRecord,
  CancelOutcome,
  EncryptedPayload,
  FillAllocationRecord,
  FillRecord,
  GroupRecord,
  IntentOrderLinkRecord,
  JsonValue,
  LimitOrderRequest,
  NotCanceledView,
  OmsReservationPort,
  OmsStore,
  OmsVenuePort,
  OrderEventRecord,
  OrderRecord,
  PayloadCipher,
  PlacementOutcome,
  PortResult,
  ReconciliationPurpose,
  ReconciliationRequest,
  ReconciliationRequester,
  RestoreSignedOrder,
  SignOutcome,
  SignedOrderHandle,
  SignedOrderIdentity,
  StoreSnapshot,
  StoreWrite,
  TradeSettlementRecord,
  VenueErrorView,
  VenueMode,
} from "./ports.js";

export {
  DOCUMENTED_NOT_CANCELED_REASONS,
  KNOWN_REJECTION_REASONS,
  classifyBatch,
  readCancelOutcome,
  readPlacementOutcome,
  readSignOutcome,
  type AcceptedStatus,
  type CancelClass,
  type PlacementClass,
  type SignClass,
} from "./outcomes.js";

export { AMOUNT_BASE_DECIMALS, MAX_ORDERS_PER_BATCH, SHARE_SIZE_DECIMALS, VENUE_FACTS, type VenueFact } from "./venue-facts.js";

export {
  conditionOfCancelOutcome,
  conditionOfPlacement,
  conditionOfPlacementOutcome,
  conditionsOfBatchOutcome,
  parseRestrictedModeConfiguration,
  RESTRICTED_MODE_CONFIGURATION_SCHEMA,
  RESTRICTED_MODE_FACTS,
  RestrictedModeTimeline,
  toOmsMode,
  VenueModeDetector,
  venueModeSource,
  withModeDetection,
  type CancelsEvidence,
  type Gate,
  type GateRefusalReason,
  type ModeBackoffPolicy,
  type ObservationFlag,
  type ObservationResult,
  type RestrictedModeConfiguration,
  type RestrictedVenueMode,
  type VenueCondition,
  type VenueModeSnapshot,
  type VenueOperation,
  type VenueSignal,
} from "./restricted-mode/index.js";

export {
  MAX_ATTRIBUTIONS_PER_ORDER,
  MAX_REQUEST_TOKEN_LENGTH,
  MAX_RETAINED_EVIDENCE,
  OrderManager,
  type AttemptView,
  type AttributionSpec,
  type FillReport,
  type GroupKind,
  type GroupSpec,
  type OmsAlert,
  type OrderManagerDependencies,
  type OrderObservation,
  type OrderTicket,
  type OrderView,
  type ReconciliationAnswer,
  type RetainedEvidenceView,
  type SaltGateView,
  type SettlementObservation,
  type Side,
  type SubmissionReport,
} from "./order-manager.js";

// WP-290: the reconciliation coordinator (handoff §9.17).
export * from "./reconciliation/index.js";
