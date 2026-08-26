/**
 * Normalized reference-feed events — handoff §7.4 (third block) and §3.1
 * (Binance, Coinbase, and Chainlink TWAP through Polymarket RTDS).
 *
 * Reference prices are spot prices on an external venue, NOT Polymarket
 * outcome-token probabilities, so they are non-negative decimals rather than
 * `PriceString` values constrained to `[0, 1]`. They are still exact decimal
 * strings: no economic value is ever a JavaScript number.
 *
 * PROVENANCE. The envelope `source` (§7.1) is the authoritative record of where
 * an event came from — it is what the gateway assigns alongside `gatewayEpoch`,
 * `ingestSeq`, and the connection metadata, and what the raw-frame record ties
 * back to. The payload `venue` here is a *restatement* of that fact for
 * consumers that hold a payload without its envelope, so it is drawn from the
 * same §7.1 vocabulary and must agree with the envelope. Use
 * `assertEnvelopePayloadProvenance` (`../provenance.js`) at the boundary where
 * the two are known together; a mismatch is a gateway normalization bug, not
 * something to record as if it were consistent.
 */

import { z } from "zod";

import { NonNegativeDecimalStringSchema, PositiveDecimalStringSchema } from "../decimals.js";
import type { EventSourceSchema } from "../envelope.js";
import { BookSideSchema } from "../identifiers.js";
import {
  CodeStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
} from "../primitives.js";
import { INITIAL_SCHEMA_VERSION } from "../schema-version.js";
import { defineEventContract } from "./event-contract.js";

/**
 * Reference data venues: the strict subset of the §7.1 envelope `source`
 * vocabulary that can originate a reference event (§3.1 — Binance, Coinbase,
 * and Chainlink TWAP through Polymarket RTDS).
 *
 * Derived from `EventSourceSchema.options` (rather than written out
 * independently) so the two vocabularies cannot drift: a payload `venue` is
 * always a legal envelope `source`, which is what makes the equality check in
 * `assertEnvelopePayloadProvenance` meaningful. No mapping table is invented —
 * these are the same tokens the handoff already defines.
 */
export const REFERENCE_VENUES = ["binance", "coinbase", "rtds"] as const satisfies readonly z.infer<
  typeof EventSourceSchema
>[];

export const ReferenceVenueSchema = z.enum(REFERENCE_VENUES);
export type ReferenceVenue = z.infer<typeof ReferenceVenueSchema>;

const referenceShape = {
  /** Restates the envelope `source`; the envelope is authoritative (§7.1). */
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
