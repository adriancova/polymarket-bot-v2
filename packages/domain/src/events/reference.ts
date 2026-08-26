/**
 * Normalized reference-feed events — handoff §7.4 (third block) and §3.1
 * (Binance, Coinbase, and Chainlink TWAP through Polymarket RTDS).
 *
 * Reference prices are spot prices on an external venue, NOT Polymarket
 * outcome-token probabilities, so they are non-negative decimals rather than
 * `PriceString` values constrained to `[0, 1]`. They are still exact decimal
 * strings: no economic value is ever a JavaScript number.
 */

import { z } from "zod";

import { NonNegativeDecimalStringSchema, PositiveDecimalStringSchema } from "../decimals.js";
import { BookSideSchema } from "../identifiers.js";
import {
  CodeStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
} from "../primitives.js";
import { INITIAL_SCHEMA_VERSION } from "../schema-version.js";
import { defineEventContract } from "./event-contract.js";

/** Reference data venue. Kept separate from the envelope `source` enum on purpose. */
export const ReferenceVenueSchema = z.enum(["binance", "coinbase", "rtds"]);
export type ReferenceVenue = z.infer<typeof ReferenceVenueSchema>;

const referenceShape = {
  venue: ReferenceVenueSchema,
  /** Venue-native instrument symbol, kept opaque (a volatile venue fact, §1.2). */
  symbol: NonEmptyStringSchema,
} as const;

export const ReferenceTradeObservedPayloadSchema = z.strictObject({
  ...referenceShape,
  price: PositiveDecimalStringSchema,
  size: PositiveDecimalStringSchema,
  takerSide: BookSideSchema.optional(),
  venueTradeId: NonEmptyStringSchema.optional(),
});

export const ReferenceTopOfBookChangedPayloadSchema = z.strictObject({
  ...referenceShape,
  bidPrice: PositiveDecimalStringSchema.optional(),
  bidSize: NonNegativeDecimalStringSchema.optional(),
  askPrice: PositiveDecimalStringSchema.optional(),
  askSize: NonNegativeDecimalStringSchema.optional(),
});

export const ReferenceTwapObservedPayloadSchema = z.strictObject({
  ...referenceShape,
  /** Oracle or feed identifier the TWAP was published under. */
  feedId: CodeStringSchema,
  value: NonNegativeDecimalStringSchema,
  windowSeconds: PositiveIntegerSchema,
  windowStartAt: IsoTimestampSchema,
  windowEndAt: IsoTimestampSchema,
});

export const ReferenceTradeObservedContract = defineEventContract(
  "ReferenceTradeObserved",
  INITIAL_SCHEMA_VERSION,
  ReferenceTradeObservedPayloadSchema,
);
export const ReferenceTopOfBookChangedContract = defineEventContract(
  "ReferenceTopOfBookChanged",
  INITIAL_SCHEMA_VERSION,
  ReferenceTopOfBookChangedPayloadSchema,
);
export const ReferenceTwapObservedContract = defineEventContract(
  "ReferenceTwapObserved",
  INITIAL_SCHEMA_VERSION,
  ReferenceTwapObservedPayloadSchema,
);

export const REFERENCE_CONTRACTS = [
  ReferenceTradeObservedContract,
  ReferenceTopOfBookChangedContract,
  ReferenceTwapObservedContract,
] as const;

export type ReferenceTradeObservedPayload = z.infer<typeof ReferenceTradeObservedPayloadSchema>;
export type ReferenceTopOfBookChangedPayload = z.infer<
  typeof ReferenceTopOfBookChangedPayloadSchema
>;
export type ReferenceTwapObservedPayload = z.infer<typeof ReferenceTwapObservedPayloadSchema>;
