/**
 * Live safety (WP-320; handoff §9.18, §6 invariants 16 and 18, §9.9, §14.1;
 * ADR-008; ADR-033 D1–D4, D6): the fencing authority, the heartbeat health
 * lease, kill-switch enforcement, venue eligibility, the D6 lapse recovery,
 * the live gate and the submission fence.
 *
 * EXPOSED FOR A LIVE COMPOSITION ROOT; NOT WIRED INTO `main.ts`. Nothing in
 * this repository builds it, and it refuses every run-mode context that may
 * not submit real orders (a simulated mode, a mode above `MAX_RUN_MODE`, or
 * `ALLOW_REAL_ORDERS` not true). See `live-safety.ts`.
 */

export {
  createLiveSafety,
  COMPOSITION_PROVED_INPUTS,
  HEARTBEAT_STOP_SOURCES,
  LiveSafety,
  LiveSafetyConfigurationError,
  type CompositionProvedInput,
  type HeartbeatStopSource,
  type KillSwitchCancelPort,
  type LiveSafetyOptions,
  type LiveSafetyStatus,
} from "./live-safety.js";
export {
  readClosedOnly,
  readGeoblock,
  VenueEligibility,
  EligibilityConfigurationError,
  type ClosedOnlyPort,
  type ClosedOnlyReading,
  type EligibilityVerdict,
  type GeoblockPort,
  type GeoblockReading,
} from "./eligibility.js";
export { evaluateLiveGate, type GateDecision, type GateInputs, type GateRequest } from "./entry-gate.js";
export { fenceVenuePort, type FenceRefusals, type PlacementClassifier, type PlacementScope, type PlacementVenuePort } from "./fenced-venue.js";
export {
  assertLiveFencingContext,
  evaluateLiveFencingContext,
  FencingAuthority,
  FencingAuthorityConfigurationError,
  isLiveRunMode,
  LiveFencingRefusal,
  type AcquireResult,
  type Fence,
  type FenceCheck,
  type FenceLossReason,
  type FencingAuthorityOptions,
  type FencingLeasePort,
  type LiveFencingRefusalReason,
  type PermittedRunModeContext,
  type RenewResult,
  type RunModeContext,
} from "./fencing-authority.js";
export {
  EventLoopProbe,
  HEALTH_INPUTS,
  HealthLease,
  HealthLeaseConfigurationError,
  MAX_PROOF_AGE_MS,
  ProofBoard,
  type HealthFailure,
  type HealthInput,
  type HealthLeaseOptions,
  type HealthProofReading,
  type HealthProofSource,
  type HealthVerdict,
} from "./health-lease.js";
export {
  foldKillSwitchRows,
  KILL_SWITCH_ACTIONS,
  KILL_SWITCH_SCOPES,
  killSwitchEffects,
  KillSwitchMonitor,
  type CancelDirective,
  type EngagedSwitch,
  type KillSwitchAction,
  type KillSwitchEffects,
  type KillSwitchReader,
  type KillSwitchRow,
  type KillSwitchScope,
  type KillSwitchSnapshot,
} from "./kill-switch.js";
export { createPostgresKillSwitchReader, killSwitchLatestRowQueries } from "./kill-switch-postgres.js";
export { LapseRecovery, LapseRecoveryConfigurationError, VENUE_CANCELLATION_CHECK_INTERVAL_MS, type LapseRecoveryOptions } from "./lapse-recovery.js";
export { OmsProgressMonitor, type OmsStoreLike } from "./oms-progress.js";
export type {
  HeartbeatView,
  LiveSafetyAlerts,
  LiveSafetyJournal,
  LiveSafetyPage,
  LiveSafetyRecord,
  MonotonicClock,
  SafetyCoordinator,
  SafetyOms,
  SafetyOrderView,
  SafetyRunReport,
  SafetyTimers,
} from "./ports.js";
