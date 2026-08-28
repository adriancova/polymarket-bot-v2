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
 * ## Three deliberate departures from the SDK's `OrderBookSchema`
 *
 * The SDK's REST schema (`packages/bindings/src/clob/order-book.ts` at the
 * pinned commit) is stricter than the wire in three ways this adapter does not
 * copy. Each is recorded so the divergence is a decision, not an oversight.
 *
 * 1. **`hash` is any string here, not `/^[a-f0-9]{40}$/`.** The SDK types it as
 *    a 40-character SHA-1 hex digest, and the documentation's own TypeScript
 *    example prints one — but the API tab of the same page prints a 64-character
 *    digest for the same field. The two published forms disagree, so pinning
 *    either would reject a documented response. The hash is carried opaquely and
 *    compared for equality only, which is exactly what the page says it is for.
 * 2. **`market` carries no byte-length bound.** ADR-002 §7 makes it binding
 *    that a runtime parser accepts any hex condition id the SDK's
 *    `ConditionIdResponseSchema` accepts, and that schema deliberately
 *    "validates hex syntax without constraining the condition ID byte length".
 * 3. **`tick_size` stays a decimal STRING.** The SDK pipes it through
 *    `DecimalStringSchema.transform(Number)` into an enum of six float
 *    literals. Converting an exact decimal to an IEEE-754 double is forbidden
 *    for economic values in this repository (ADR-001 §1, §4), and the literal
 *    enum would additionally reject any tick size the venue adds. It is parsed
 *    as an optional decimal and normalized like every other decimal.
 *
 * Everything the SDK marks required and this adapter marks optional is marked
 * so because the SDK requires more of this response than the WebSocket `book`
 * event requires of its own — `min_order_size`, `tick_size`, `neg_risk` and
 * `hash` are `.nullish()`-equivalent there. Accepting the looser shape on both
 * paths keeps one book model instead of two.
 */

import { z } from "zod";

import {
  VenueBookLevelSchema,
  VenueConditionIdSchema,
  VenueEpochLikeSchema,
  VenueOptionalDecimalStringSchema,
  VenueTokenIdSchema,
} from "./primitives.js";

/** One order-book summary as `GET /book` and `POST /books` serialize it. */
export const VenueOrderBookSchema = z.object({
  market: VenueConditionIdSchema,
  asset_id: VenueTokenIdSchema,
  timestamp: VenueEpochLikeSchema.nullish(),
  hash: z.string().nullish(),
  bids: z.array(VenueBookLevelSchema),
  asks: z.array(VenueBookLevelSchema),
  min_order_size: VenueOptionalDecimalStringSchema,
  tick_size: VenueOptionalDecimalStringSchema,
  neg_risk: z.boolean().nullish(),
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
