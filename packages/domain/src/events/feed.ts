/**
 * Feed health and data-quality events — handoff §7.4 (fourth block), §8.3, §9.1.
 *
 * These are the events that make gaps and staleness first-class rather than
 * silent: "dropping trading or raw market events silently is forbidden" (§8.3),
 * and a detected gap "requires a new authoritative snapshot before affected
 * markets resume" (§7.1).
 *
 * That gap invariant is UNCONDITIONAL, so the two fields that express it are
 * pinned to the literal `true` rather than typed as booleans: these contracts
 * cannot represent a gap that waives the snapshot requirement, or a
 * resynchronization that never applied one. See the field comments below.
 *
 * `severity` uses the §14.4 alert vocabulary (`LOG`, `NOTIFY`, `PAGE`) so an
 * incident routes to the right channel without a second mapping table.
 */

import { z } from "zod";

import { InternalMarketIdSchema } from "../identifiers.js";
import {
  CodeStringSchema,
  DetailStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
} from "../primitives.js";
import { INITIAL_SCHEMA_VERSION } from "../schema-version.js";
import { defineEventContract } from "./event-contract.js";

/** Alert routing severity (§14.4). */
export const IncidentSeveritySchema = z.enum(["LOG", "NOTIFY", "PAGE"]);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

const feedShape = {
  /** Stable feed identifier assigned by the gateway configuration. */
  feedId: CodeStringSchema,
  connectionId: NonEmptyStringSchema.optional(),
} as const;

export const FeedConnectedPayloadSchema = z.strictObject({
  feedId: CodeStringSchema,
  connectionId: NonEmptyStringSchema,
  /** Endpoint identifier. Never contains credentials. */
  endpoint: NonEmptyStringSchema,
  subscriptionGeneration: NonNegativeIntegerSchema,
  connectedAt: IsoTimestampSchema,
});

export const FeedDisconnectedPayloadSchema = z.strictObject({
  ...feedShape,
  disconnectedAt: IsoTimestampSchema,
  reasonCode: CodeStringSchema,
  detail: DetailStringSchema.optional(),
});

export const FeedStalePayloadSchema = z.strictObject({
  ...feedShape,
  detectedAt: IsoTimestampSchema,
  lastMessageAt: IsoTimestampSchema.optional(),
  stalenessMs: NonNegativeIntegerSchema,
});

export const FeedGapDetectedPayloadSchema = z.strictObject({
  ...feedShape,
  detectedAt: IsoTimestampSchema,
  reasonCode: CodeStringSchema,
  detail: DetailStringSchema.optional(),
  /**
   * Pinned to the literal `true`.
   *
   * §7.1 and §9.1 state the requirement unconditionally: "a restart or detected
   * gap requires a new authoritative snapshot before affected markets resume",
   * and the gateway must "resubscribe and obtain authoritative snapshots after
   * gaps". There is no such thing as a detected gap that does not require a
   * snapshot, so `z.boolean()` would have made the contract able to express a
   * document that violates the invariant — and a consumer branching on the flag
   * would then skip the snapshot. The field is kept (rather than dropped)
   * because it makes the obligation explicit in every recorded frame; it is
   * pinned so it can only ever record the obligation, never waive it.
   */
  requiresAuthoritativeSnapshot: z.literal(true),
  affectedMarketIds: z.array(InternalMarketIdSchema).readonly().optional(),
});

export const FeedResynchronizedPayloadSchema = z.strictObject({
  ...feedShape,
  resynchronizedAt: IsoTimestampSchema,
  subscriptionGeneration: NonNegativeIntegerSchema,
  /**
   * Pinned to the literal `true`.
   *
   * A resynchronization that did not apply an authoritative snapshot is not a
   * `FeedResynchronized` event: the feed reconnected, but the affected markets
   * are not safe to resume (§7.1, §9.1). That situation is a reconnection that
   * is still in the gap state, and it is recorded as `FeedConnected` (plus the
   * still-open `FeedGapDetected`/`DataQualityIncidentOpened`), not as a
   * resynchronization. Accepting `false` here would let the stream assert
   * recovery that did not happen.
   */
  authoritativeSnapshotApplied: z.literal(true),
});

export const DataQualityIncidentOpenedPayloadSchema = z.strictObject({
  incidentId: NonEmptyStringSchema,
  openedAt: IsoTimestampSchema,
  reasonCode: CodeStringSchema,
  severity: IncidentSeveritySchema,
  detail: DetailStringSchema.optional(),
  feedId: CodeStringSchema.optional(),
  affectedMarketIds: z.array(InternalMarketIdSchema).readonly().optional(),
});

export const DataQualityIncidentClosedPayloadSchema = z.strictObject({
  incidentId: NonEmptyStringSchema,
  closedAt: IsoTimestampSchema,
  resolutionCode: CodeStringSchema,
  detail: DetailStringSchema.optional(),
});

export const FeedConnectedContract = defineEventContract(
  "FeedConnected",
  INITIAL_SCHEMA_VERSION,
  FeedConnectedPayloadSchema,
);
export const FeedDisconnectedContract = defineEventContract(
  "FeedDisconnected",
  INITIAL_SCHEMA_VERSION,
  FeedDisconnectedPayloadSchema,
);
export const FeedStaleContract = defineEventContract(
  "FeedStale",
  INITIAL_SCHEMA_VERSION,
  FeedStalePayloadSchema,
);
export const FeedGapDetectedContract = defineEventContract(
  "FeedGapDetected",
  INITIAL_SCHEMA_VERSION,
  FeedGapDetectedPayloadSchema,
);
export const FeedResynchronizedContract = defineEventContract(
  "FeedResynchronized",
  INITIAL_SCHEMA_VERSION,
  FeedResynchronizedPayloadSchema,
);
export const DataQualityIncidentOpenedContract = defineEventContract(
  "DataQualityIncidentOpened",
  INITIAL_SCHEMA_VERSION,
  DataQualityIncidentOpenedPayloadSchema,
);
export const DataQualityIncidentClosedContract = defineEventContract(
  "DataQualityIncidentClosed",
  INITIAL_SCHEMA_VERSION,
  DataQualityIncidentClosedPayloadSchema,
);

export const FEED_CONTRACTS = [
  FeedConnectedContract,
  FeedDisconnectedContract,
  FeedStaleContract,
  FeedGapDetectedContract,
  FeedResynchronizedContract,
  DataQualityIncidentOpenedContract,
  DataQualityIncidentClosedContract,
] as const;

export type FeedConnectedPayload = z.infer<typeof FeedConnectedPayloadSchema>;
export type FeedDisconnectedPayload = z.infer<typeof FeedDisconnectedPayloadSchema>;
export type FeedStalePayload = z.infer<typeof FeedStalePayloadSchema>;
export type FeedGapDetectedPayload = z.infer<typeof FeedGapDetectedPayloadSchema>;
export type FeedResynchronizedPayload = z.infer<typeof FeedResynchronizedPayloadSchema>;
export type DataQualityIncidentOpenedPayload = z.infer<
  typeof DataQualityIncidentOpenedPayloadSchema
>;
export type DataQualityIncidentClosedPayload = z.infer<
  typeof DataQualityIncidentClosedPayloadSchema
>;
