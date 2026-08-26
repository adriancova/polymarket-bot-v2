/**
 * Intent types — handoff §7.7.
 *
 * Strategies emit intents; risk, allocation, execution planning, the OMS, and
 * the venue adapters own orders (§2). "A risk veto never silently mutates an
 * intent. A resize creates a new approved-intent record linked to the original"
 * (§7.7) — which is why nothing in this module is mutable and every intent is
 * validated as a strict object.
 *
 * Field names, optionality, and enum values are reproduced exactly from §7.7.
 * Two shapes referenced by §7.7 are not themselves specified there —
 * `QuoteLevel` and `BasketLeg`. They are defined below with the minimum fields
 * their parent intent requires, and are flagged in `docs/contracts/domain.md`
 * and in the WP-020 handoff as inferred rather than specified.
 */

import { z } from "zod";

import {
  MoneyStringSchema,
  NonNegativeMoneyStringSchema,
  NonNegativeSharesStringSchema,
  PriceStringSchema,
  ProbabilityStringSchema,
  SharesStringSchema,
} from "./decimals.js";
import {
  IntentIdSchema,
  InternalMarketIdSchema,
  OutcomeSideSchema,
  VenueOrderIdSchema,
} from "./identifiers.js";
import {
  DetailStringSchema,
  IsoTimestampSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  TagSchema,
} from "./primitives.js";

/** Intent discriminator values (§7.7). */
export const IntentTypeSchema = z.enum([
  "POSITION",
  "QUOTE",
  "BASKET",
  "CANCEL",
  "REDUCE_POSITION",
]);
export type IntentType = z.infer<typeof IntentTypeSchema>;

export const PositionTargetModeSchema = z.enum(["DELTA", "ABSOLUTE"]);
export const PositionUrgencySchema = z.enum([
  "PASSIVE",
  "NORMAL",
  "AGGRESSIVE",
  "IMMEDIATE",
]);
export const LiquidityPreferenceSchema = z.enum([
  "MAKER_ONLY",
  "MAKER_PREFERRED",
  "TAKER_OK",
  "TAKER_ONLY",
]);
export const PartialFillPolicySchema = z.enum(["REJECT", "ACCEPT_ANY", "ACCEPT_MINIMUM"]);
/** Reduction urgency (§7.7) — deliberately narrower than {@link PositionUrgencySchema}. */
export const ReductionUrgencySchema = z.enum(["NORMAL", "AGGRESSIVE", "IMMEDIATE"]);
export const BasketFailurePolicySchema = z.enum([
  "ABANDON",
  "PROTECTED_UNWIND",
  "HOLD_FILLED_LEGS",
]);

export type PositionTargetMode = z.infer<typeof PositionTargetModeSchema>;
export type PositionUrgency = z.infer<typeof PositionUrgencySchema>;
export type LiquidityPreference = z.infer<typeof LiquidityPreferenceSchema>;
export type PartialFillPolicy = z.infer<typeof PartialFillPolicySchema>;
export type ReductionUrgency = z.infer<typeof ReductionUrgencySchema>;
export type BasketFailurePolicy = z.infer<typeof BasketFailurePolicySchema>;

/** §7.7 position intent. */
export const PositionIntentSchema = z.strictObject({
  type: z.literal("POSITION"),
  intentId: IntentIdSchema,
  marketId: InternalMarketIdSchema,
  direction: OutcomeSideSchema,
  targetMode: PositionTargetModeSchema,
  /** May be negative in `DELTA` mode. */
  targetShares: SharesStringSchema,

  maximumBuyPrice: PriceStringSchema.optional(),
  minimumSellPrice: PriceStringSchema.optional(),
  maximumTotalCost: NonNegativeMoneyStringSchema.optional(),

  urgency: PositionUrgencySchema,
  liquidityPreference: LiquidityPreferenceSchema,
  partialFillPolicy: PartialFillPolicySchema,
  minimumFillShares: NonNegativeSharesStringSchema.optional(),
  validUntil: IsoTimestampSchema,

  expectedProbability: ProbabilityStringSchema.optional(),
  expectedNetEdge: MoneyStringSchema.optional(),
  tags: z.array(TagSchema).readonly(),
});

/**
 * One quoted level of a {@link QuoteIntentSchema}.
 *
 * INFERRED SHAPE: §7.7 references `QuoteLevel` without defining it. A quote
 * level is the minimum a maker order needs — a price on the tick grid and a
 * size. Requires an ADR to extend.
 */
export const QuoteLevelSchema = z.strictObject({
  price: PriceStringSchema,
  shares: NonNegativeSharesStringSchema,
});

/** §7.7 quote intent. Quotes are always post-only. */
export const QuoteIntentSchema = z.strictObject({
  type: z.literal("QUOTE"),
  intentId: IntentIdSchema,
  marketId: InternalMarketIdSchema,
  bids: z.array(QuoteLevelSchema).readonly(),
  asks: z.array(QuoteLevelSchema).readonly(),
  /** Literally `true` in §7.7: a quote intent may never cross the book. */
  postOnly: z.literal(true),
  /** A duration, not an economic value, so a JavaScript integer is correct here. */
  quoteLifetimeMs: PositiveIntegerSchema,
  /** A tick count, not an economic value. */
  replaceThresholdTicks: NonNegativeIntegerSchema,
  maximumInventory: NonNegativeSharesStringSchema,
  tags: z.array(TagSchema).readonly(),
});

/**
 * One leg of a {@link BasketIntentSchema}.
 *
 * INFERRED SHAPE: §7.7 references `BasketLeg` without defining it. The fields
 * mirror the position-intent fields a coordinated leg needs. Requires an ADR to
 * extend.
 */
export const BasketLegSchema = z.strictObject({
  marketId: InternalMarketIdSchema,
  direction: OutcomeSideSchema,
  targetShares: SharesStringSchema,
  maximumBuyPrice: PriceStringSchema.optional(),
  minimumSellPrice: PriceStringSchema.optional(),
});

/** §7.7 coordinated basket intent. Execution is coordinated, not atomic. */
export const BasketIntentSchema = z.strictObject({
  type: z.literal("BASKET"),
  intentId: IntentIdSchema,
  legs: z.array(BasketLegSchema).readonly(),
  maximumCombinedCost: NonNegativeMoneyStringSchema,
  minimumLockedEdge: MoneyStringSchema,
  legRiskLimit: NonNegativeMoneyStringSchema,
  failurePolicy: BasketFailurePolicySchema,
  validUntil: IsoTimestampSchema,
});

/**
 * §7.7 cancel intent.
 *
 * Both `marketId` and `orderIds` are optional in §7.7; an intent with neither
 * is a request to cancel everything in scope, which is what the kill-switch
 * ladder (§14.1) needs. `reason` stays required.
 */
export const CancelIntentSchema = z.strictObject({
  type: z.literal("CANCEL"),
  marketId: InternalMarketIdSchema.optional(),
  orderIds: z.array(VenueOrderIdSchema).readonly().optional(),
  reason: DetailStringSchema,
});

/** §7.7 reduction intent. */
export const ReducePositionIntentSchema = z.strictObject({
  type: z.literal("REDUCE_POSITION"),
  marketId: InternalMarketIdSchema,
  targetShares: SharesStringSchema,
  urgency: ReductionUrgencySchema,
  minimumSellPrice: PriceStringSchema.optional(),
  maximumBuyPrice: PriceStringSchema.optional(),
  reason: DetailStringSchema,
});

/** Any §7.7 intent, discriminated on `type`. */
export const IntentSchema = z.discriminatedUnion("type", [
  PositionIntentSchema,
  QuoteIntentSchema,
  BasketIntentSchema,
  CancelIntentSchema,
  ReducePositionIntentSchema,
]);

export type PositionIntent = z.infer<typeof PositionIntentSchema>;
export type QuoteLevel = z.infer<typeof QuoteLevelSchema>;
export type QuoteIntent = z.infer<typeof QuoteIntentSchema>;
export type BasketLeg = z.infer<typeof BasketLegSchema>;
export type BasketIntent = z.infer<typeof BasketIntentSchema>;
export type CancelIntent = z.infer<typeof CancelIntentSchema>;
export type ReducePositionIntent = z.infer<typeof ReducePositionIntentSchema>;
export type Intent = z.infer<typeof IntentSchema>;
