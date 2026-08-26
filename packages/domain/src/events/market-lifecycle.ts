/**
 * Normalized market lifecycle events — handoff §7.4 (first block) and §9.2.
 *
 * Payloads are deliberately minimal: they carry the identifiers and the
 * versioned parameters a consumer needs, not a copy of the venue's raw
 * metadata. Raw frames are preserved by the recorder (§9.1), and the venue's
 * own field names are volatile venue facts (§1.2) that these contracts do not
 * freeze.
 *
 * Every market parameter change carries a version, because "market rules,
 * settlement specs, fee schedules, tick sizes, minimum sizes, and delays are
 * versioned. Historical runs use historical parameters" (§6 invariant 9).
 */

import { z } from "zod";

import { PositiveDecimalStringSchema } from "../decimals.js";
import { ConditionIdSchema, InternalMarketIdSchema, TokenIdSchema } from "../identifiers.js";
import {
  CodeStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
} from "../primitives.js";
import { INITIAL_SCHEMA_VERSION } from "../schema-version.js";
import { defineEventContract } from "./event-contract.js";

const marketReferenceShape = {
  internalMarketId: InternalMarketIdSchema,
  conditionId: ConditionIdSchema,
} as const;

/** Monotonic version of a versioned market parameter set (§6 invariant 9). */
const VersionSchema = PositiveIntegerSchema;

/** Names of the fields that changed, so consumers can react selectively. */
const ChangedFieldsSchema = z.array(CodeStringSchema).min(1).readonly();

/** Required settlement outcome states (§9.3). */
export const MarketOutcomeStateSchema = z.enum([
  "YES_WIN",
  "NO_WIN",
  "SPLIT_50_50",
  "CANCELLED",
  "DISPUTED",
  "PENDING",
  "PENDING_CLARIFICATION",
]);
export type MarketOutcomeState = z.infer<typeof MarketOutcomeStateSchema>;

export const MarketDiscoveredPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  yesTokenId: TokenIdSchema,
  noTokenId: TokenIdSchema,
  /** Stable series grouping such as `btc-15m-updown` (§9.2). Bound by configuration. */
  seriesId: CodeStringSchema.optional(),
  metadataVersion: VersionSchema,
});

export const MarketMetadataChangedPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  metadataVersion: VersionSchema,
  previousMetadataVersion: VersionSchema.optional(),
  changedFields: ChangedFieldsSchema,
});

export const MarketRulesChangedPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  rulesVersionId: NonEmptyStringSchema,
  previousRulesVersionId: NonEmptyStringSchema.optional(),
  changedFields: ChangedFieldsSchema,
});

export const MarketOpenedPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  openedAt: IsoTimestampSchema,
});

export const MarketClosingPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  closesAt: IsoTimestampSchema,
});

export const MarketResolvedPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  outcome: MarketOutcomeStateSchema,
  resolvedAt: IsoTimestampSchema,
  rulesVersionId: NonEmptyStringSchema.optional(),
});

export const MarketClarificationObservedPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  clarificationId: NonEmptyStringSchema,
  observedAt: IsoTimestampSchema,
  rulesVersionId: NonEmptyStringSchema.optional(),
});

export const TradingParametersChangedPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  parametersVersion: VersionSchema,
  previousParametersVersion: VersionSchema.optional(),
  /** Exact decimal price increment; never a JavaScript number. */
  tickSize: PositiveDecimalStringSchema,
  /** Exact decimal minimum order size; never a JavaScript number. */
  minimumOrderSize: PositiveDecimalStringSchema,
});

export const MarketDiscoveredContract = defineEventContract(
  "MarketDiscovered",
  INITIAL_SCHEMA_VERSION,
  MarketDiscoveredPayloadSchema,
);
export const MarketMetadataChangedContract = defineEventContract(
  "MarketMetadataChanged",
  INITIAL_SCHEMA_VERSION,
  MarketMetadataChangedPayloadSchema,
);
export const MarketRulesChangedContract = defineEventContract(
  "MarketRulesChanged",
  INITIAL_SCHEMA_VERSION,
  MarketRulesChangedPayloadSchema,
);
export const MarketOpenedContract = defineEventContract(
  "MarketOpened",
  INITIAL_SCHEMA_VERSION,
  MarketOpenedPayloadSchema,
);
export const MarketClosingContract = defineEventContract(
  "MarketClosing",
  INITIAL_SCHEMA_VERSION,
  MarketClosingPayloadSchema,
);
export const MarketResolvedContract = defineEventContract(
  "MarketResolved",
  INITIAL_SCHEMA_VERSION,
  MarketResolvedPayloadSchema,
);
export const MarketClarificationObservedContract = defineEventContract(
  "MarketClarificationObserved",
  INITIAL_SCHEMA_VERSION,
  MarketClarificationObservedPayloadSchema,
);
export const TradingParametersChangedContract = defineEventContract(
  "TradingParametersChanged",
  INITIAL_SCHEMA_VERSION,
  TradingParametersChangedPayloadSchema,
);

export const MARKET_LIFECYCLE_CONTRACTS = [
  MarketDiscoveredContract,
  MarketMetadataChangedContract,
  MarketRulesChangedContract,
  MarketOpenedContract,
  MarketClosingContract,
  MarketResolvedContract,
  MarketClarificationObservedContract,
  TradingParametersChangedContract,
] as const;

export type MarketDiscoveredPayload = z.infer<typeof MarketDiscoveredPayloadSchema>;
export type MarketMetadataChangedPayload = z.infer<typeof MarketMetadataChangedPayloadSchema>;
export type MarketRulesChangedPayload = z.infer<typeof MarketRulesChangedPayloadSchema>;
export type MarketOpenedPayload = z.infer<typeof MarketOpenedPayloadSchema>;
export type MarketClosingPayload = z.infer<typeof MarketClosingPayloadSchema>;
export type MarketResolvedPayload = z.infer<typeof MarketResolvedPayloadSchema>;
export type MarketClarificationObservedPayload = z.infer<
  typeof MarketClarificationObservedPayloadSchema
>;
export type TradingParametersChangedPayload = z.infer<
  typeof TradingParametersChangedPayloadSchema
>;
