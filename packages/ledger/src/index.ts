/**
 * `@polymarket-bot/ledger` — append-only accounting ledger (WP-200, §9.15).
 *
 * What this package owns:
 *
 * - **The ledger rule**: immutable, append-only transactions in which every
 *   transaction balances to zero PER ASSET using explicit external-clearing
 *   accounts — refused on imbalance, never adjusted (§9.15, §10.7, ADR-006).
 * - **The §9.15 scope and event vocabulary**, token-identical to the WP-040
 *   `accounting` schema enums so a composition root binds records to tables
 *   with no mapping layer.
 * - **Fill allocation**: partition of an actual fill quantity across strategy
 *   instances, with any shortfall landing in an EXPLICIT `UNATTRIBUTED`
 *   scope carrying an unwaivable `haltRequired: true` (§6 invariant 7).
 * - **Rebuildable projections**: balances, actual and virtual positions, and
 *   unattributed exposure, folded from the ledger; a rebuild from zero equals
 *   the incremental state byte-for-byte (§6 invariant 8).
 *
 * PERSISTENCE BOUNDARY (recorded WP-200 decision): this is layer 1 — it owns
 * rules and typed records, never a connection. §10.5's `accounting` tables
 * (shipped by WP-040 in `packages/storage-postgres`) are the persistence
 * binding target; the composition root writes appended transactions through
 * that package. Nothing here imports it (dependency direction §2/F12).
 *
 * DEPENDENCY DIRECTION (`docs/contracts/dependency-direction.md`): layer 1,
 * depending downward on `@polymarket-bot/domain`, `@polymarket-bot/decimal`,
 * and `zod`. This package is purity-restricted (F14): no I/O, no clock, no
 * randomness, no module-loading capability — identifiers are caller-minted
 * and validated (lowercase canonical only; ADR-016 refusal carrying the raw
 * value). It does not import `@polymarket-bot/pnl` (same layer, no §2.1
 * row); the PnL bridge is structural.
 *
 * SAFETY: no credential, signer, order path, or network surface exists here
 * or is representable in these interfaces. Exact decimal strings everywhere;
 * no economic value ever passes through a JavaScript number.
 */

export {
  LedgerConfigurationError,
  ledgerFailure,
  ledgerOk,
  ledgerRefusal,
} from "./refusals.js";
export type {
  LedgerRefusal,
  LedgerRefusalCode,
  LedgerRefusalDetails,
  LedgerResult,
} from "./refusals.js";

export {
  ASSET_KINDS,
  ATTRIBUTION_SCOPES,
  AssetKindSchema,
  LEDGER_EVENT_TYPES,
  LEDGER_SCOPES,
  LedgerEventTypeSchema,
  LedgerScopeSchema,
  REWARD_PROGRAM_TYPES,
  RewardProgramTypeSchema,
  TRADE_SETTLEMENT_STATES,
  TradeSettlementStateSchema,
} from "./vocabulary.js";
export type {
  AssetKind,
  LedgerEventType,
  LedgerScope,
  RewardProgramType,
  TradeSettlementState,
} from "./vocabulary.js";

export {
  LedgerEntryInputSchema,
  LedgerTransactionInputSchema,
  Sha256HexSchema,
  validateTransactionInput,
} from "./transaction.js";
export type {
  AppendedLedgerTransaction,
  LedgerEntryInput,
  LedgerTransactionInput,
} from "./transaction.js";

export {
  attributionBucketKey,
  attributionBuckets,
  checkAttributionParity,
  checkPerAssetBalance,
  isExactNegation,
  legDeltas,
  legKey,
  netByAsset,
} from "./balance.js";
export type { AttributionBucket } from "./balance.js";

export { Ledger } from "./ledger.js";
export type { LedgerAppendSuccess } from "./ledger.js";

export {
  LEDGER_PROJECTION_SERIALIZATION_DOMAIN,
  LEDGER_SERIALIZATION_DOMAIN,
  actualPositions,
  applyTransaction,
  auditAttributionPartition,
  balanceLineKey,
  balancesOfScope,
  emptyProjection,
  projectLedger,
  serializeLedger,
  serializeProjection,
  unattributedExposure,
  virtualPositionKey,
  virtualPositions,
} from "./projections.js";
export type {
  AttributionPartitionViolation,
  BalanceLine,
  LedgerProjection,
  UnattributedActivityRecord,
  UnattributedExposureLine,
  UnexplainedActualMovementRecord,
  VirtualPositionLine,
} from "./projections.js";

export { AllocationClaimSchema, FillFactSchema, allocateFill } from "./allocation.js";
export type {
  AllocationClaim,
  FillAllocation,
  FillAllocationResult,
  FillFact,
  UnattributedAllocation,
} from "./allocation.js";

export {
  FillPostingIdsSchema,
  PostingAccountsSchema,
  buildFillPosting,
} from "./fill-posting.js";
export type {
  FillPosting,
  FillPostingIds,
  PnlFeeRecord,
  PnlOwner,
  PnlTradeRecord,
  PostingAccounts,
} from "./fill-posting.js";

// WP-290: account reconciliation's ledger half (break taxonomy, append-only
// journal, holdings and UNATTRIBUTED corrections; handoff §9.17, §10.6).
export * from "./reconciliation/index.js";
