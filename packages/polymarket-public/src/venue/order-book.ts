/**
 * Wire schema for the public CLOB order-book REST reads.
 *
 * Endpoints (https://docs.polymarket.com/market-data/prices-order-books,
 * accessed 2026-08-27), both public and unauthenticated:
 *
 * - `GET https://clob.polymarket.com/book?token_id=<TOKEN_ID>`
 * - `POST https://clob.polymarket.com/books` with body
 *   `[{"token_id":"…"},{"token_id":"…"}]`, "Maximum 500 items per request"
 *
 * Verbatim from that page, and load-bearing for the normalizer: "Bids are
 * ordered by ascending price and asks by descending price, so the best bid and
 * ask are the last entries in their respective arrays. Each response also
 * includes a `hash` for the order-book state. Compare it with the previous
 * response's hash to determine whether the book changed between reads."
 *
 * ## Requiredness follows the REST contract, not the WebSocket's
 *
 * Round-1 review finding M1. This schema used to mark `min_order_size`,
 * `tick_size`, `neg_risk` and `hash` optional, on the reasoning that the
 * WebSocket `book` event marks the same-named fields optional. That reasoning
 * is not evidence about the REST wire contract, and both first-party sources
 * contradict it:
 *
 * - the official OpenAPI document for `GET /book` lists **all ten** properties
 *   of `OrderBookSummary` under `required`
 *   (https://docs.polymarket.com/api-reference/market-data/get-order-book.md,
 *   `/api-spec/clob-openapi.yaml`, retrieved read-only 2026-08-27);
 * - the SDK's `OrderBookSchema` requires `market`, `asset_id`, `bids`, `asks`,
 *   `min_order_size`, `tick_size`, `neg_risk` and `hash`
 *   (`packages/bindings/src/clob/order-book.ts` at the pinned commit).
 *
 * So requiredness is restored for the eight fields both sources require. Two
 * fields stay absence-tolerant, and the divergence from the OpenAPI is recorded
 * rather than assumed: `timestamp` and `last_trade_price`, which the SDK — a
 * first-party client written against this very endpoint — declares `.nullish()`.
 * A market that has never traded has no last trade price, and an inbound parser
 * that rejected the whole book over it would turn a recoverable snapshot into a
 * failed recovery. Absence maps to ABSENT, never to `"0"` (ADR-001 §8.1).
 *
 * ## Three deliberate departures in the VALUE form
 *
 * These loosen what a present value may look like. None of them loosens whether
 * the field must be there.
 *
 * 1. **`hash` is any non-empty string, not `/^[a-f0-9]{40}$/`.** The SDK types
 *    it as a 40-character SHA-1 hex digest, and the documentation's own
 *    TypeScript example prints one — but the API tab of the same page prints a
 *    64-character digest for the same field. The two published forms disagree,
 *    so pinning either would reject a documented response. The hash is carried
 *    opaquely and compared for equality only, which is exactly what the page
 *    says it is for. Emptiness is still rejected: an empty hash is not a hash.
 * 2. **`market` carries no byte-length bound in this schema.** ADR-002 §7 makes
 *    it binding that a runtime parser accepts any hex condition id the SDK's
 *    `ConditionIdResponseSchema` accepts, and that schema deliberately
 *    "validates hex syntax without constraining the condition ID byte length".
 *    This is the RAW WIRE form only: normalization caps a condition id at 200
 *    characters (`packages/domain`'s `MAX_IDENTIFIER_LENGTH`) and reports a
 *    longer one as an `INVALID_CONDITION_ID` problem, so the package does not
 *    accept "any length" end to end — see `./primitives.ts`
 *    (`VenueConditionIdSchema`) and README §4.1.
 * 3. **`tick_size` stays a decimal STRING.** The SDK pipes it through
 *    `DecimalStringSchema.transform(Number)` into an enum of six float
 *    literals. Converting an exact decimal to an IEEE-754 double is forbidden
 *    for economic values in this repository (ADR-001 §1, §4), and the literal
 *    enum would additionally reject any tick size the venue adds. It is
 *    required, as a decimal string, and normalized like every other decimal.
 *
 * `timestamp` additionally admits the epoch-like forms ADR-002 §7 requires an
 * adapter to accept, and `last_trade_price` additionally admits the wire empty
 * string as a spelling of absence. Every one of these is a row in
 * `test/contract/polymarket-public/sdk-anchor/`, where the SDK modifier, the
 * REST modifier and this package's modifier are recorded separately and each
 * divergence carries its dimension and its reason.
 *
 * ## A published contradiction this adapter does not resolve
 *
 * The OpenAPI describes `bids` as "sorted by price descending" and `asks` as
 * "sorted by price ascending"; the prose page quoted above says the opposite.
 * The normalizer imposes the domain's order on both sides rather than trusting
 * either (`../normalize/fields.ts`), so the contradiction cannot reach a
 * consumer — but it is why trusting the wire order was never an option.
 */

import { z } from "zod";

import {
  VenueBookLevelSchema,
  VenueConditionIdSchema,
  VenueDecimalStringSchema,
  VenueEpochLikeSchema,
  VenueOptionalDecimalStringSchema,
  VenueTokenIdSchema,
} from "./primitives.js";

/** One order-book summary as `GET /book` and `POST /books` serialize it. */
export const VenueOrderBookSchema = z.object({
  market: VenueConditionIdSchema,
  asset_id: VenueTokenIdSchema,
  // Required by the OpenAPI, `.nullish()` in the SDK — see this module's header.
  timestamp: VenueEpochLikeSchema.nullish(),
  hash: z.string().min(1),
  bids: z.array(VenueBookLevelSchema),
  asks: z.array(VenueBookLevelSchema),
  min_order_size: VenueDecimalStringSchema,
  tick_size: VenueDecimalStringSchema,
  neg_risk: z.boolean(),
  last_trade_price: VenueOptionalDecimalStringSchema,
});

/** The `POST /books` response: one summary per requested token id. */
export const VenueOrderBooksSchema = z.array(VenueOrderBookSchema);

export type VenueOrderBook = z.infer<typeof VenueOrderBookSchema>;

/** Outcome of parsing one order-book body. */
export type VenueOrderBookParseResult =
  | { readonly status: "parsed"; readonly book: VenueOrderBook }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

/** Parses one order-book body. */
export function parseVenueOrderBook(value: unknown): VenueOrderBookParseResult {
  const parsed = VenueOrderBookSchema.safeParse(value);
  return parsed.success
    ? { status: "parsed", book: parsed.data }
    : { status: "invalid", issues: formatIssues(parsed.error) };
}

/** Outcome of parsing a batch body. */
export type VenueOrderBooksParseResult =
  | { readonly status: "parsed"; readonly books: readonly VenueOrderBook[] }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

/** Parses a `POST /books` body. */
export function parseVenueOrderBooks(value: unknown): VenueOrderBooksParseResult {
  const parsed = VenueOrderBooksSchema.safeParse(value);
  return parsed.success
    ? { status: "parsed", books: parsed.data }
    : { status: "invalid", issues: formatIssues(parsed.error) };
}

function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}
