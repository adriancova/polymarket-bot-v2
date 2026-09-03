/**
 * `@polymarket-bot/pnl` — the PnL engine (WP-200, §9.16).
 *
 * What this package owns:
 *
 * - **The §9.16 measures**: gross trading PnL, core net PnL excluding
 *   discretionary rewards, all-in PnL including REALIZED rewards, realized
 *   PnL, unrealized PnL at midpoint / model / liquidation value, worst-case
 *   resolution PnL, fees paid, reward estimates, realized rewards, and
 *   capital committed — computed per OWNER and per DENOMINATION ASSET.
 * - **The separation of realized from unrealized**: the fold accumulates only
 *   realized facts; unrealized value is computed at snapshot time from open
 *   lots and caller-supplied marks, so the two cannot mix by construction.
 * - **The rule the handoff states verbatim**: "Reward estimates are never
 *   booked as realized." A `REWARD_ESTIMATE` record has no settlement-evidence
 *   field to state, and folding one moves the estimate buckets and nothing
 *   else. Only a `REWARD_PAYOUT` — which REQUIRES the ledger transaction id of
 *   the observed payout — realizes a reward.
 * - **Fee and reward schedule versioning** (§9.16 "versioned per market where
 *   available"): every fee and reward carries its schedule/program version
 *   reference where the caller has one, and the snapshot reports the totals
 *   broken down by it. A missing version is reported as the empty version key,
 *   never invented.
 *
 * PERSISTENCE BOUNDARY (recorded WP-200 decision): this is layer 1 — it owns
 * computation and typed records, never a connection. §10.5's `pnl_snapshots`
 * table is the persistence binding target; the composition root writes
 * `PnlSnapshot` rows through `packages/storage-postgres` (layer 2). Nothing
 * here imports it (dependency direction §2/F12).
 *
 * DEPENDENCY DIRECTION (`docs/contracts/dependency-direction.md`): layer 1,
 * depending downward on `@polymarket-bot/domain`, `@polymarket-bot/decimal`,
 * and `zod`. No I/O, no clock, no randomness: `asOf` timestamps and marks are
 * caller-supplied, and identifiers are caller-minted and validated (lowercase
 * canonical only; ADR-016 §2 refuses a non-canonical spelling carrying the raw
 * value). It does NOT import `@polymarket-bot/ledger` — the two are the same
 * layer and no §2.1 row permits the edge; the agreement between
 * `buildFillPosting`'s output and these input schemas is structural and is
 * pinned by the cross-package suite in `test/unit/ledger/`.
 *
 * SAFETY: no credential, signer, order path, or network surface exists here or
 * is representable in these interfaces. Exact decimal strings everywhere; no
 * economic value ever passes through a JavaScript number.
 */

export {
  PnlConfigurationError,
  pnlFailure,
  pnlOk,
  pnlRefusal,
} from "./refusals.js";
export type {
  PnlRefusal,
  PnlRefusalCode,
  PnlRefusalDetails,
  PnlResult,
} from "./refusals.js";

export {
  PnlCostBasisInjectionRecordSchema,
  PnlFeeRecordSchema,
  PnlOwnerSchema,
  PnlRealizationRecordSchema,
  PnlRecordSchema,
  PnlRewardEstimateRecordSchema,
  PnlRewardPayoutRecordSchema,
  PnlRewardProgramSchema,
  PnlSettlementStateSchema,
  PnlTradeRecordSchema,
  PnlTradeReversalRecordSchema,
} from "./records.js";
export type {
  PnlCostBasisInjectionRecord,
  PnlFeeRecord,
  PnlOwner,
  PnlRealizationRecord,
  PnlRecord,
  PnlRewardEstimateRecord,
  PnlRewardPayoutRecord,
  PnlTradeRecord,
  PnlTradeReversalRecord,
} from "./records.js";

export {
  applyPnlRecord,
  emptyPnlState,
  foldPnlRecords,
  pnlCompositeKey,
} from "./state.js";
export type { OpenLot, PnlState } from "./state.js";

export { PnlMarkSchema, PnlSnapshotInputSchema, computePnlSnapshot } from "./snapshot.js";
export type { PnlSnapshot, PnlSnapshotInput } from "./snapshot.js";

export {
  PNL_SNAPSHOT_SERIALIZATION_DOMAIN,
  PNL_STATE_SERIALIZATION_DOMAIN,
  serializePnlSnapshots,
  serializePnlState,
  serializeRealizedPnl,
} from "./serialize.js";
