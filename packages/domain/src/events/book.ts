/**
 * Normalized book events — handoff §7.4 (second block) and §9.4.
 *
 * §9.4 is explicit: "The implementation must not invent a venue sequence
 * number. It may use internal ingest order, venue timestamps, and venue-provided
 * hashes." These payloads therefore carry no synthetic sequence field. Ordering
 * comes from `gatewayEpoch + ingestSeq` on the envelope (§7.1), and
 * `venueBookHash` is optional because not every venue supplies one.
 *
 * Level changes carry ABSOLUTE sizes, matching §9.4 ("apply snapshots and
 * absolute-size price changes exactly as documented by the venue"). A size of
 * `"0"` removes the level.
 */

import { z } from "zod";

import {
  NonNegativeSharesStringSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
} from "../decimals.js";
import {
  BookSideSchema,
  InternalMarketIdSchema,
  TokenIdSchema,
} from "../identifiers.js";
import { NonEmptyStringSchema } from "../primitives.js";
import { INITIAL_SCHEMA_VERSION } from "../schema-version.js";
import { defineEventContract } from "./event-contract.js";

const bookReferenceShape = {
  internalMarketId: InternalMarketIdSchema,
  /** Books are maintained independently per outcome token (§9.4). */
  tokenId: TokenIdSchema,
} as const;

/** One aggregated price level. Prices are probabilities in `[0, 1]`. */
export const BookLevelSchema = z.strictObject({
  price: PriceStringSchema,
  size: NonNegativeSharesStringSchema,
});
export type BookLevel = z.infer<typeof BookLevelSchema>;

export const BookSnapshotPayloadSchema = z.strictObject({
  ...bookReferenceShape,
  /** Descending by price. Ordering is validated by the book component, not here. */
  bids: z.array(BookLevelSchema).readonly(),
  /** Ascending by price. */
  asks: z.array(BookLevelSchema).readonly(),
  /** Venue-provided hash when the venue supplies one (§9.4). */
  venueBookHash: NonEmptyStringSchema.optional(),
});

export const BookLevelChangedPayloadSchema = z.strictObject({
  ...bookReferenceShape,
  side: BookSideSchema,
  price: PriceStringSchema,
  /** Absolute resulting size at this price; `"0"` removes the level. */
  size: NonNegativeSharesStringSchema,
  venueBookHash: NonEmptyStringSchema.optional(),
});

export const BestBidAskChangedPayloadSchema = z.strictObject({
  ...bookReferenceShape,
  /** Absent when that side of the book is empty. */
  bestBidPrice: PriceStringSchema.optional(),
  bestBidSize: NonNegativeSharesStringSchema.optional(),
  bestAskPrice: PriceStringSchema.optional(),
  bestAskSize: NonNegativeSharesStringSchema.optional(),
});

export const PublicTradeObservedPayloadSchema = z.strictObject({
  ...bookReferenceShape,
  price: PriceStringSchema,
  size: PositiveDecimalStringSchema,
  /** Taker side when the venue reports it. */
  takerSide: BookSideSchema.optional(),
  venueTradeId: NonEmptyStringSchema.optional(),
});

export const BookSnapshotContract = defineEventContract(
  "BookSnapshot",
  INITIAL_SCHEMA_VERSION,
  BookSnapshotPayloadSchema,
);
export const BookLevelChangedContract = defineEventContract(
  "BookLevelChanged",
  INITIAL_SCHEMA_VERSION,
  BookLevelChangedPayloadSchema,
);
export const BestBidAskChangedContract = defineEventContract(
  "BestBidAskChanged",
  INITIAL_SCHEMA_VERSION,
  BestBidAskChangedPayloadSchema,
);
export const PublicTradeObservedContract = defineEventContract(
  "PublicTradeObserved",
  INITIAL_SCHEMA_VERSION,
  PublicTradeObservedPayloadSchema,
);

export const BOOK_CONTRACTS = [
  BookSnapshotContract,
  BookLevelChangedContract,
  BestBidAskChangedContract,
  PublicTradeObservedContract,
] as const;

export type BookSnapshotPayload = z.infer<typeof BookSnapshotPayloadSchema>;
export type BookLevelChangedPayload = z.infer<typeof BookLevelChangedPayloadSchema>;
export type BestBidAskChangedPayload = z.infer<typeof BestBidAskChangedPayloadSchema>;
export type PublicTradeObservedPayload = z.infer<typeof PublicTradeObservedPayloadSchema>;
