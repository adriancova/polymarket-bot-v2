/**
 * Account reconciliation, the coordinator's half (WP-290; handoff §9.17).
 * The break taxonomy and the append-only journal are `packages/ledger`'s
 * (`packages/ledger/src/reconciliation/`), reached here through structural
 * ports (`ports.ts`).
 */

export {
  MAX_POLICY_MS,
  MAX_RUNS_PER_RECONCILE,
  ReconciliationCoordinator,
  type CoordinatorStatus,
  type ReconcileReport,
  type RunReport,
} from "./coordinator.js";
export {
  MAX_LEGS_PER_TRADE,
  MAX_READ_ENTRIES,
  WALLET_MEMBER_STATES,
  orderStatusOf,
  tradeStatusOf,
  type ReadOutcome,
  type WalletMemberRead,
  type WalletMemberState,
} from "./door.js";
export { compareHolding, pendingDeltas, type HoldingVerdict, type PendingDelta } from "./holdings.js";
export {
  couldBelong,
  matchesExactly,
  resolveBySignedIdentity,
  type AttemptFacts,
  type IdentityVerdict,
  type PotentialOwner,
} from "./identity.js";
export {
  RECONCILED_WALLET_OPERATION_STATES,
  VENUE_ORDER_STATUSES,
  VENUE_TRADE_STATUSES,
  type AccountReadPort,
  type BreakClass as ReconciliationBreakClass,
  type BreakRule as ReconciliationBreakRule,
  type BreakScope as ReconciliationBreakScope,
  type FillIdentity,
  type HaltPort,
  type HaltRequest,
  type HoldingsPort,
  type JournalBreakView,
  type JournalInput,
  type JournalPortResult,
  type OmsReconciliationRequest,
  type ReconciledOms,
  type ReconciledUserStream,
  type ReconciledWalletOperations,
  type ReconciliationClock,
  type ReconciliationCoordinatorDependencies,
  type ReconciliationJournalPort,
  type ReconciliationPolicy,
  type ReconciliationTrigger,
  type StreamReconciliationRequest,
  type UnattributedBooking,
  type VenueOrderStatus,
  type VenueOrderView,
  type VenueTradeLeg,
  type VenueTradeStatus,
  type VenueTradeView,
  type WalletOperationEventView,
  type WalletOperationStateView,
  type WalletPortResult,
  type WalletReconciliationRequest,
} from "./ports.js";
export { isoFromEpochMs as reconciliationIsoFromEpochMs } from "./time.js";
