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
 *
 * ## UNVERIFIED — conflict C-1 / unverified item U-1
 *
 * The sentence above is the handoff §23 architectural ASSUMPTION, retained
 * provisionally under handoff §1.1's conflict procedure. It is NOT a verified
 * venue fact: the official market-channel documentation types
 * `price_change.size` as a `DecimalString` and states neither
 * absolute-versus-delta semantics nor that `size: "0"` removes a level
 * (`docs/venue/verified-2026-08-24.md` §3, conflict C-1 in §11, unverified item
 * U-1 in §12; ADR-002 §8).
 *
 * Consequences, so no reader mistakes provisional wording for settled behavior:
 *
 * - `WP-070` MUST confirm the semantics against the official SDK's
 *   book-maintenance code and/or live observation BEFORE `WP-150` treats them as
 *   truth. Until then no component may claim they are verified, and the
 *   simulator inherits the same uncertainty (ADR-012).
 * - If confirmation shows DELTA semantics instead, the fix is a NEW
 *   `schemaVersion` for the affected book contracts under ADR-002 §8.4 — never a
 *   reinterpretation of recorded v1 data, and never an in-place redefinition of
 *   these payloads.
 * - Anything reconstructing depth from these events is building on a
 *   provisional reading of the venue (ADR-002 Consequences).
 *
 * This block is a COMMENT ONLY. It records status that already binds via
 * ADR-002 §8 and `docs/contracts/protected-contracts.md` §8; it changes no
 * schema, type, or runtime behavior, so `schemaVersion` is unchanged (ADR-002
 * §3 ties a version bump to a change in the EMITTED FIELD SET).
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
  /**
   * Absolute resulting size at this price; `"0"` removes the level.
   *
   * UNVERIFIED (C-1 / U-1): this is the handoff §23 assumption, not a
   * documented venue fact. `WP-070` must confirm it; delta semantics would be
   * corrected by a new `schemaVersion` under ADR-002 §8.4. See the module
   * header.
   */
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
