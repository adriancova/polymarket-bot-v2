/**
 * The PostgreSQL fencing lease's lifecycle (WP-320 deliverable 1; handoff
 * §9.18; ADR-008 §1–§2). See `lease-store.ts`.
 */

export {
  createFencingLeaseStore,
  FENCING_HEARTBEAT_ID_MAX_LENGTH,
  FENCING_IDENTIFIER_MAX_LENGTH,
  FENCING_LEASE_MAX_TTL_MS,
  FENCING_LEASE_MIN_TTL_MS,
  FENCING_REASON_MAX_LENGTH,
  FencingLeaseInputError,
  type AcquireFencingLeaseInput,
  type FencingAcquireOutcome,
  type FencingGrant,
  type FencingLeaseRef,
  type FencingLeaseStore,
  type FencingLeaseView,
  type FencingRenewOutcome,
} from "./lease-store.js";
