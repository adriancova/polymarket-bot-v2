/**
 * `@polymarket-bot/capital-allocator` — WP-180.
 *
 * Commitment accounting for handoff §9.7: open orders and positions BOTH
 * consume limits; user-defined caps (global, per-strategy, per-scope) with
 * zero-defaulted live-micro caps; reservation lifecycle; v1 one-live-owner
 * conflict rejection with independent shadow accounting.
 *
 * Pure layer-1 logic (`docs/contracts/dependency-direction.md` §2): no I/O,
 * no clock, no network, no credential surface, exact decimal arithmetic only.
 */

export {
  CAPITAL_REFUSAL_CODES,
  CAPITAL_REFUSAL_CODES_ARE_EXHAUSTIVE,
  CAPITAL_REFUSAL_CODE_COUNT,
  capitalFailure,
  capitalOk,
  capitalRefusal,
  isCapitalRefusalCode,
} from "./refusals.js";
export type {
  CapitalRefusal,
  CapitalRefusalCode,
  CapitalRefusalDetails,
  CapitalResult,
} from "./refusals.js";

export {
  AllocatorCapsSchema,
  LIVE_MICRO_CAP_FIELDS,
  LIVE_MICRO_CAP_FLOOR,
  liveMicroCapRefusals,
  nonFloorLiveMicroCapFields,
  parseAllocatorCaps,
} from "./caps.js";
export type { AllocatorCaps, LiveMicroCapField } from "./caps.js";

export {
  AllocatorStateInputSchema,
  LiveOwnerSchema,
  OpenOrderCommitmentSchema,
  PositionHoldingSchema,
  ScopeAttributionSchema,
  createAllocatorState,
  heldSharesByKey,
  inventoryKey,
  reservedSharesByKey,
  withLiveOwner,
} from "./state.js";
export type {
  AllocatorState,
  AllocatorStateInput,
  AppliedReservation,
  LiveOwner,
  OpenOrderCommitment,
  PositionHolding,
  ScopeAttribution,
} from "./state.js";

export {
  EXPOSURE_ZERO,
  exposureSnapshot,
  exposureSnapshotCovering,
  shadowExposureSnapshot,
} from "./exposure.js";
export type { ExposureCoverage, ExposureEntry, ExposureSnapshot } from "./exposure.js";

export {
  ReservationRequestSchema,
  applyReservation,
  evaluateReservation,
  releaseReservation,
} from "./reserve.js";
export type { ReservationRequest, ReservationVerdict } from "./reserve.js";
