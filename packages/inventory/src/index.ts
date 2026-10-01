/**
 * `@polymarket-bot/inventory` — collateral inventory and wallet operations
 * (WP-300; handoff §9.14, §10.5, §10.7; ADR-006 §7-§9).
 *
 * Layer 1 (`docs/contracts/dependency-direction.md` §2): depends only on
 * `@polymarket-bot/decimal` and `@polymarket-bot/domain`. No I/O, no clock, no
 * randomness, no key, no RPC endpoint, no credential. Wallet operations leave
 * the package only through the injected `WalletOperationExecutor` port.
 *
 * There is no bridge, deposit, withdrawal or transfer path (§9.14 "No
 * autonomous deposit, withdrawal, or bridge behavior in v1");
 * `test/unit/inventory/no-bridge-or-withdrawal.test.ts` pins it.
 */

export const workspacePackageName = "@polymarket-bot/inventory" as const;

export {
  INVENTORY_REFUSAL_CODES,
  type EvidenceValue,
  type InventoryRefusal,
  type InventoryRefusalCode,
  type InventoryResult,
} from "./refusals.js";

export { MAX_IDENTIFIER_LENGTH } from "./guards.js";

export {
  AssetRegistry,
  type AssetKind,
  type AssetRegistration,
  type AssetRole,
  type OutcomePair,
  type OutcomeTokenSide,
} from "./assets.js";

export {
  InventoryBook,
  type ActualObservation,
  type InventoryLineView,
  type InvariantViolation,
  type LineBlock,
  type PendingDirection,
  type PendingSettlement,
  type PendingView,
  type ReservationStatus,
  type ReservationView,
  type ReserveRequest,
} from "./inventory-book.js";

export {
  ReservationService,
  type InventoryJournalEvent,
  type ReservationJournal,
} from "./reservation-service.js";

export {
  buildOrderReservation,
  reserveForOrder,
  type OrderReservationRequest,
  type OrderSide,
} from "./order-reservations.js";

export {
  isLegalWalletTransition,
  TERMINAL_WALLET_OPERATION_STATES,
  WALLET_OPERATION_STATES,
  WALLET_OPERATION_TRANSITIONS,
  WALLET_OPERATION_TYPES,
  WALLET_OPERATION_UNKNOWN_TRIGGER,
  type WalletOperationState,
  type WalletOperationType,
} from "./wallet-operations.js";

export {
  ApprovalTracker,
  type ApprovalStandard,
  type ConfirmedApproval,
  type ReadinessVerdict,
} from "./approvals.js";

export {
  classifyObservation,
  classifySubmit,
  WALLET_PLAN_KEYS,
  WalletOperationManager,
  type ReconciliationRequest,
  type ReconciliationRequester,
  type ReconciliationTrigger,
  type WalletOperationEvent,
  type WalletOperationExecutor,
  type WalletOperationPlan,
  type WalletOperationSubmission,
  type WalletOperationView,
} from "./wallet-operation-manager.js";

export {
  APPROVAL_SPENDER_ROLES,
  CLOB_ALLOWANCE_SYNC_CITATION,
  documentedContractAt,
  DOCUMENTED_VENUE_CONTRACTS,
  isDocumentedApprovalSpender,
  PUSD_DECIMALS,
  VENUE_FACTS_SOURCE,
  type DocumentedVenueContract,
  type VenueContractRole,
} from "./venue-facts.js";
