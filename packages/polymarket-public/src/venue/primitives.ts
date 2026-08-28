/**
 * Wire primitives for the public Polymarket market channel and CLOB book REST.
 *
 * These schemas parse the RAW venue wire form. They are deliberately as
 * permissive as the official SDK's own bindings and no more: this is the layer
 * ADR-002 §7 calls "the adapter", the component that owns the wire format, and
 * a parser that is stricter than the venue drops real traffic.
 *
 * ## Anchoring (register item R-2, `docs/contracts/protected-contracts.md` §8.1)
 *
 * Every schema below is transcribed from the official unified SDK at the pinned
 * reference commit `7fdbed42484b5d279c71aa36d3757d18968260da`
 * (`docs/venue/verified-2026-08-24.md` §1). Transcription alone is not
 * trustworthy — R-2 exists precisely because a hand transcription nobody checks
 * is a silent verification error. The anchoring is therefore behavioural, not
 * textual: `test/contract/polymarket-public/sdk-anchor/` holds a field-by-field
 * table of the SDK's declared modifier for every field of every market-channel
 * schema, each row carrying its commit permalink, and the contract suite
 *
 *   1. compares the anchor table's field set against this module's schemas, so
 *      a field omitted here fails a test rather than passing silently, and
 *   2. drives an accept/reject vector per row (`null` for `.nullish()`, `""`
 *      for an optional decimal, omission for a required field), so a modifier
 *      transcribed wrongly changes observable behaviour and fails.
 *
 * ## Fixture-only narrowings that are NOT inherited (ADR-002 §7)
 *
 * - `null` is accepted wherever the SDK declares `.nullish()`, and mapped to
 *   ABSENT before the domain boundary (never to `"0"`, never to `""`).
 * - The wire empty string `""` is an accepted value for an optional decimal —
 *   the SDK comment is verbatim: "The websocket serializes absent optional
 *   decimals as an empty string (for example `fee_rate_bps` on a trade with no
 *   fee, or `best_bid`/`best_ask` when there is none)".
 * - A condition id carries no byte-length bound **in these wire schemas**. The
 *   `WP-000` fixture catalogue narrows it to 31/32 bytes; the SDK's
 *   `ConditionIdResponseSchema` "validates hex syntax without constraining the
 *   condition ID byte length", and neither narrowing is inherited here. That is
 *   a statement about THIS layer and nothing more — see
 *   {@link VenueConditionIdSchema} for the end-to-end behaviour, which is
 *   capped. This file previously said the venue's length "is what a runtime
 *   parser must do", which round-1 finding M2 had already withdrawn from the
 *   README, the handoff, the normalizer and the tests, and round-2 finding M1
 *   found still standing here.
 * - Unknown object keys are IGNORED, not rejected. Every SDK schema here is a
 *   `z.object`, not a strict object: the venue adds fields without warning and
 *   rejecting an event because it grew a key would drop real data. (The domain
 *   contracts stay strict — that is a different boundary, ADR-002 §3.)
 * - Enumerations that the SDK types as free strings are surfaced as first-class
 *   UNKNOWN by the normalizer rather than rejected here.
 */

import { z } from "zod";

/**
 * `isHexString` from the SDK's `@polymarket/types`, verbatim:
 * `/^0x[a-fA-F0-9]+$/`.
 *
 * Source: `packages/types/src/hex.ts` at the pinned commit.
 */
const HEX_STRING_PATTERN = /^0x[a-fA-F0-9]+$/u;

/** Digit-string epoch, matching the SDK's `/^\d+$/` guard. */
const DIGITS_PATTERN = /^\d+$/u;

/**
 * `TokenIdSchema` — `z.string().transform(toTokenId)` in the SDK: ANY string.
 *
 * The SDK applies no numeric shape at the wire layer, so neither does this. The
 * repository's `TokenId` (a canonical unsigned integer string) is a *domain*
 * constraint; `normalizeVenueTokenId` applies it on the way out, and a token id
 * that cannot satisfy it becomes a reported problem rather than a silent drop.
 */
export const VenueTokenIdSchema = z.string();

/**
 * A condition id as the venue serializes it, with NO byte-length bound.
 *
 * The market-channel schemas type `market` as a bare `z.string()`; the REST
 * order-book schema types it `ConditionIdSchema` (31/32 bytes). This RAW WIRE
 * schema accepts the looser of the two, following ADR-002 §7: "A runtime parser
 * must accept any hex condition id the SDK accepts."
 *
 * ## What this schema does NOT say about the package
 *
 * It is not a package-level acceptance claim, and round-2 finding M1 is that
 * this module used to read like one. Normalization applies a bound the wire
 * layer does not: `normalizeVenueConditionId` (`../normalize/values.ts`)
 * reports a condition id longer than **200 characters** — `MAX_IDENTIFIER_LENGTH`
 * in the frozen `packages/domain`, which `ConditionIdSchema` and therefore every
 * emitted payload enforces — as a typed `INVALID_CONDITION_ID` problem carrying
 * the raw value. So end to end this package accepts any hex length **up to 200
 * characters**, which is the honest statement the README (§4.1), the handoff,
 * the normalizer and `test/contract/polymarket-public/narrowings.test.ts` all
 * make, and `docs/contracts/protected-contracts.md` §9 is discharged in
 * substance rather than literally. Reconciling the two is a contract-owner
 * decision; `packages/domain` is frozen and outside this package's paths.
 */
export const VenueConditionIdSchema = z.string();

/** Hex syntax exactly as `ConditionIdResponseSchema` validates it. */
export function isVenueHexString(value: string): boolean {
  return HEX_STRING_PATTERN.test(value);
}

/**
 * `DecimalStringSchema` — `z.string().transform(toDecimalString)`.
 *
 * No canonicalization at the wire layer: the venue publishes non-canonical
 * spellings (the official order-book example prints `"last_trade_price":
 * "0.090"`), and canonicalization belongs to `normalizeVenueDecimal`, which
 * uses `@polymarket-bot/decimal` so the adapter and the domain boundary can
 * never disagree about what canonical means (ADR-001 §3).
 */
export const VenueDecimalStringSchema = z.string();

/**
 * `OptionalDecimalStringSchema` —
 * `z.preprocess(emptyStringToNull, DecimalStringSchema.nullish())`.
 *
 * Accepts the value, the wire empty string, `null`, and absence; yields
 * `string | null | undefined`. The distinction between `""`, `null` and absent
 * is deliberately erased HERE, at the wire layer, because past the adapter they
 * are one fact — *absent* (ADR-001 §8.1).
 */
export const VenueOptionalDecimalStringSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().nullish(),
);

/**
 * `EpochMillisecondsStringSchema` — `z.string().regex(/^\d+$/)`.
 *
 * Used by every market-channel `timestamp`. Widened below by
 * {@link VenueEpochLikeSchema} for the forms ADR-002 §7 requires an adapter to
 * accept.
 */
export const VenueEpochMillisecondsStringSchema = z.string().regex(DIGITS_PATTERN);

/**
 * Every epoch-like form the SDK accepts, per ADR-002 §7 ("An adapter must
 * accept every form the SDK accepts, including the date-like string").
 *
 * The three branches and their SDK sources:
 *
 * | Input | Source |
 * | --- | --- |
 * | digit string | `EpochMillisecondsStringSchema` (milliseconds) |
 * | integer number | `EpochMillisecondsLikeSchema` inside `EpochLikeToIsoDateTimeStringSchema` |
 * | any other string | `DateLikeStringToIsoDateTimeStringSchema` |
 *
 * Interpretation is left to `normalizeVenueInstant`; this schema only decides
 * what shapes are admissible.
 */
export const VenueEpochLikeSchema = z.union([z.string(), z.number().int()]);

/**
 * `NormalizedOrderSideSchema` — `z.preprocess(uppercase, OrderSideSchema)`.
 *
 * The SDK upper-cases before matching `BUY`/`SELL`. It then REJECTS anything
 * else; this adapter keeps the value instead, because ADR-002 §7 requires an
 * unrecognized free-string side to be first-class UNKNOWN — reported and
 * preserved — rather than a parse failure that discards the whole frame.
 */
export const VenueSideSchema = z
  .string()
  .transform((value) => value.toUpperCase());

/** A book level: `{ price: DecimalString, size: DecimalString }`, both required. */
export const VenueBookLevelSchema = z.object({
  price: VenueDecimalStringSchema,
  size: VenueDecimalStringSchema,
});

export type VenueBookLevel = z.infer<typeof VenueBookLevelSchema>;

/** Value produced by {@link VenueOptionalDecimalStringSchema}. */
export type VenueOptionalDecimal = string | null | undefined;

/** Value admitted by {@link VenueEpochLikeSchema}. */
export type VenueEpochLike = z.infer<typeof VenueEpochLikeSchema>;
