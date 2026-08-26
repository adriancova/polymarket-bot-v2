/**
 * Feed health and data-quality events — handoff §7.4 (fourth block), §8.3, §9.1.
 *
 * These are the events that make gaps and staleness first-class rather than
 * silent: "dropping trading or raw market events silently is forbidden" (§8.3),
 * and a detected gap "requires a new authoritative snapshot before affected
 * markets resume" (§7.1).
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
   * A gap requires a new authoritative snapshot before affected markets resume
   * (§7.1). Recorded explicitly so a consumer cannot forget the requirement.
   */
  requiresAuthoritativeSnapshot: z.boolean(),
  affectedMarketIds: z.array(InternalMarketIdSchema).readonly().optional(),
});

export const FeedResynchronizedPayloadSchema = z.strictObject({
  ...feedShape,
  resynchronizedAt: IsoTimestampSchema,
  subscriptionGeneration: NonNegativeIntegerSchema,
  authoritativeSnapshotApplied: z.boolean(),
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
