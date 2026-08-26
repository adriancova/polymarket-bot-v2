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

/**
 * Required settlement outcome states (§9.3).
 *
 * This is the full state vocabulary of a market's settlement, including the
 * non-terminal states. It is the right type for "what state is this market in
 * right now" — the settlement/catalog layer and the payoff models. It is NOT
 * the right type for `MarketResolved`; see
 * {@link TerminalMarketOutcomeStateSchema}.
 */
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

/**
 * The terminal subset of {@link MarketOutcomeStateSchema}: the states in which
 * a market's payoff is determined and positions can be settled.
 *
 * RULING ON `DISPUTED` — excluded. A dispute is an in-flight process, not an
 * outcome: a disputed market has no determined payoff, so a `MarketResolved`
 * carrying `DISPUTED` would assert a resolution that has not happened and would
 * let a downstream settlement consumer try to compute a payoff from it. When
 * the dispute concludes, the market resolves to one of the four terminal states
 * and `MarketResolved` is emitted then. The dispute itself remains fully
 * observable: it is market *state* (`MarketOutcomeStateSchema`, owned by the
 * catalog/settlement layer), and the events that carry it are
 * `MarketClarificationObserved` and `DataQualityIncidentOpened`. `PENDING` and
 * `PENDING_CLARIFICATION` are excluded for the same reason, more obviously.
 *
 * `CANCELLED` is included: a cancelled market is terminal and its payoff (a
 * refund) is determined.
 */
export const TerminalMarketOutcomeStateSchema = z.enum([
  "YES_WIN",
  "NO_WIN",
  "SPLIT_50_50",
  "CANCELLED",
]);
export type TerminalMarketOutcomeState = z.infer<typeof TerminalMarketOutcomeStateSchema>;

/** The non-terminal settlement states, exported so consumers can branch explicitly. */
export const NON_TERMINAL_MARKET_OUTCOME_STATES = [
  "DISPUTED",
  "PENDING",
  "PENDING_CLARIFICATION",
] as const satisfies readonly MarketOutcomeState[];

/** Whether a settlement state determines a payoff. */
export function isTerminalMarketOutcomeState(
  value: MarketOutcomeState,
): value is TerminalMarketOutcomeState {
  return TerminalMarketOutcomeStateSchema.safeParse(value).success;
}

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
  /**
   * Terminal states only. `MarketResolved` asserts that the payoff is
   * determined, so `PENDING`, `PENDING_CLARIFICATION`, and `DISPUTED` are not
   * valid values — see {@link TerminalMarketOutcomeStateSchema}.
   */
  outcome: TerminalMarketOutcomeStateSchema,
  resolvedAt: IsoTimestampSchema,
  rulesVersionId: NonEmptyStringSchema.optional(),
});

export const MarketClarificationObservedPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  clarificationId: NonEmptyStringSchema,
  observedAt: IsoTimestampSchema,
  rulesVersionId: NonEmptyStringSchema.optional(),
});

/**
 * The categories of versioned trading parameter §9.2 requires the catalog to
 * store and version: "tick size, minimum size, `negRisk`, fee schedule, trading
 * delay, open/close timestamps".
 *
 * This is a *vocabulary of what changed*, not a copy of the values. The full
 * parameter snapshot lives in the catalog layer and is addressed by
 * `parameterVersionRef`; encoding a fee schedule or a `negRisk` shape here
 * would freeze a volatile venue fact (§1.2) before WP-000 has produced the
 * evidence for it.
 */
export const TradingParameterKindSchema = z.enum([
  "tick_size",
  "minimum_order_size",
  "fee_schedule",
  "trading_delay",
  "neg_risk",
  "status",
]);
export type TradingParameterKind = z.infer<typeof TradingParameterKindSchema>;

export const TradingParametersChangedPayloadSchema = z.strictObject({
  ...marketReferenceShape,
  /** Monotonic ordinal of the parameter set, for ordering and comparison (§6 invariant 9). */
  parametersVersion: VersionSchema,
  previousParametersVersion: VersionSchema.optional(),
  /**
   * Opaque handle to the full versioned parameter snapshot held by the catalog.
   *
   * The architecture versions more than tick size and minimum size — fees,
   * trading delay, and `negRisk` are versioned too (§9.2) — but their exact
   * shapes are volatile venue facts (§1.2) that WP-020 must not invent. This
   * event therefore names *which* categories changed and points at the
   * authoritative snapshot; a consumer that needs a value resolves the ref.
   * Deliberately unstructured beyond "non-empty bounded string": the catalog
   * owns the addressing scheme.
   */
  parameterVersionRef: NonEmptyStringSchema,
  /** Non-empty: an event that changed nothing is not a change event. */
  changedParameters: z.array(TradingParameterKindSchema).min(1).readonly(),

  /**
   * Convenience detail for the two parameters nearly every consumer needs
   * (order sizing and tick rounding) without a catalog round trip. OPTIONAL:
   * a change to, say, the fee schedule alone need not restate them, and a
   * producer that cannot supply them must omit them rather than guess.
   * `parameterVersionRef` remains the authoritative source.
   */
  tickSize: PositiveDecimalStringSchema.optional(),
  /** See {@link TradingParametersChangedPayloadSchema} `tickSize`. */
  minimumOrderSize: PositiveDecimalStringSchema.optional(),
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
export type MarketResolvedOutcome = TerminalMarketOutcomeState;
