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
 * ## CONFIRMED — conflict C-1 / unverified item U-1 are CLOSED (2026-08-28)
 *
 * The sentence above began as the handoff §23 architectural ASSUMPTION, retained
 * provisionally under handoff §1.1's conflict procedure while
 * `docs/venue/verified-2026-08-24.md` §3 recorded the documentation gap
 * (conflict C-1 in §11, unverified item U-1 in §12). It is now a CONFIRMED venue
 * fact, ratified by ADR-013:
 *
 * - Current official Polymarket documentation
 *   (`https://docs.polymarket.com/api-reference/wss/market`, retrieved
 *   2026-08-27 by `WP-070` and re-verified 2026-08-28 by the contract-owner
 *   round) defines `price_change.size` as "New aggregate size (0 means level
 *   removed)", the operation as "Delta update to orderbook price levels when an
 *   order is placed or cancelled", and `book` as a "Full orderbook snapshot sent
 *   on subscribe or after a trade" whose level `size` is the "Total size at this
 *   price level".
 * - "Delta" names WHICH LEVELS are reported, not the arithmetic: a consumer
 *   REPLACES the size at the named level and never adds to or subtracts from a
 *   previous size. `"0"` deletes the level.
 * - `WP-150` may treat these semantics as truth (ADR-002 §8, as amended
 *   2026-08-28), and ADR-012 §5.8's inherited uncertainty is discharged.
 *
 * Three obligations survive the confirmation:
 *
 * - It is DOCUMENTARY, not observational. No live observation was made, and
 *   nothing here may be cited as observed venue behavior (ADR-013 §5).
 * - If evidence ever shows DELTA arithmetic instead, the fix is a NEW
 *   `schemaVersion` for the affected book contracts under ADR-002 §8.4 — never a
 *   reinterpretation of recorded v1 data, and never an in-place redefinition of
 *   these payloads.
 * - The fact stays volatile (handoff §1.2). The next dated verification report
 *   re-verifies it and must add the citing page to its source index, which the
 *   frozen 2026-08-24 report does not contain (ADR-013 §6).
 *
 * This block is a COMMENT ONLY. It records status that binds via ADR-013,
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
   * CONFIRMED (C-1 / U-1 closed, 2026-08-28, ADR-013): current official
   * documentation defines `price_change.size` as "New aggregate size (0 means
   * level removed)". REPLACE the level's size with this value; never add or
   * subtract. Contrary evidence would be corrected by a new `schemaVersion`
   * under ADR-002 §8.4, never by reinterpreting recorded data. See the module
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
