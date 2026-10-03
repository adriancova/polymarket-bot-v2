/**
 * Matching-engine restricted modes (WP-310 deliverable 3): the 425 restart,
 * post-only and cancel-only / disabled trading, detected from classified
 * venue answers, with backoff by kind, feeding the OMS's `venueMode`. See
 * `detector.ts`.
 *
 * Layer 1, PAPER only: no clock, no I/O, no key. The composition injects a
 * clock into {@link venueModeSource} and {@link withModeDetection}.
 */

export {
  parseRestrictedModeConfiguration,
  RESTRICTED_MODE_CONFIGURATION_SCHEMA,
  RestrictedModeTimeline,
  type ModeBackoffPolicy,
  type RestrictedModeConfiguration,
  type RestrictedModeConfigurationResult,
  type RestrictedModeSource,
} from "./configuration.js";
export {
  MS_PER_SECOND,
  toOmsMode,
  VenueModeDetector,
  type CancelsEvidence,
  type Gate,
  type GateRefusalReason,
  type ObservationFlag,
  type ObservationResult,
  type RestrictedVenueMode,
  type VenueModeSnapshot,
} from "./detector.js";
export { RESTRICTED_MODE_FACTS } from "./facts.js";
export {
  conditionOfCancelOutcome,
  conditionOfPlacement,
  conditionOfPlacementOutcome,
  conditionsOfBatchOutcome,
  type VenueCondition,
  type VenueOperation,
  type VenueSignal,
} from "./signals.js";
export { venueModeSource, withModeDetection } from "./venue-port.js";
