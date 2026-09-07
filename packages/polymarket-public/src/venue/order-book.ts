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
 *
 * ## Both parsers go through a prototype-free door (`CLOB-1`)
 *
 * `./wire-door.ts` states which of ADR-020's D1-D4 this package performs and
 * what it measured; `./prototype-boundary.test.ts` holds the regressions.
 * `docs/contracts/schema-boundary.md` §3 measured the defeat this closes:
 * `hash` deleted was refused clean, an INHERITED `hash` parsed as
 * `"INVENTED"`, and an inherited `tick_size` put `"0.99"` — an economic
 * parameter — into the recorded book. Requiredness above is therefore now
 * enforced twice: by the schema, and by the door's own read of the
 * materialized tree ({@link VENUE_ORDER_BOOK_FIELDS}).
 */

import { z } from "zod";

import {
  VENUE_BOOK_LEVEL_FIELDS,
  VenueBookLevelSchema,
  VenueConditionIdSchema,
  VenueDecimalStringSchema,
  VenueEpochLikeSchema,
  VenueOptionalDecimalStringSchema,
  VenueTokenIdSchema,
} from "./primitives.js";
import {
  type OwnWireRecord,
  type WireFields,
  containedJudgement,
  isOwnWireRecord,
  ownResult,
  projectDeclaredFields,
  readOwnWireValue,
  restatedFieldFailures,
} from "./wire-door.js";

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

/**
 * {@link VenueOrderBookSchema}'s declared fields, for the D3 projection in
 * `./wire-door.ts`.
 *
 * This is the table the second measured defeat is about. At base `989d41d` a
 * body with `hash` deleted was refused clean, yet under an inherited `hash` it
 * parsed with `hash:"INVENTED"`, and under an inherited `tick_size` with
 * `tick_size:"0.99"` — an economic parameter, fabricated into a recorded book.
 * All ten declared cells behaved that way, on the single AND the batch door.
 * The door now builds the emitted book from these rows, reading the
 * materialized tree; `./venue-fields.test.ts` re-derives the rows from the
 * schema so a modifier change cannot land here unnoticed.
 *
 * `hash` carries the one re-stated BOUND: `z.string().min(1)` is the only
 * `.min()` on either payload family, and it is a FORMAT check, so it is the one
 * thing an inherited `skipChecks` would switch off on this body. "An empty hash
 * is not a hash" (this module's header), so the door says so itself.
 */
export const VENUE_ORDER_BOOK_FIELDS: WireFields = [
  { key: "market", required: true, rule: "verbatim" },
  { key: "asset_id", required: true, rule: "verbatim" },
  { key: "timestamp", required: false, rule: "verbatim" },
  { key: "hash", required: true, rule: "verbatim", nonEmpty: true },
  { key: "bids", required: true, rule: { objectArray: VENUE_BOOK_LEVEL_FIELDS } },
  { key: "asks", required: true, rule: { objectArray: VENUE_BOOK_LEVEL_FIELDS } },
  { key: "min_order_size", required: true, rule: "verbatim" },
  { key: "tick_size", required: true, rule: "verbatim" },
  { key: "neg_risk", required: true, rule: "verbatim" },
  { key: "last_trade_price", required: false, rule: "optional-decimal" },
];

/** The `POST /books` response: one summary per requested token id. */
export const VenueOrderBooksSchema = z.array(VenueOrderBookSchema);

export type VenueOrderBook = z.infer<typeof VenueOrderBookSchema>;

/** Outcome of parsing one order-book body. */
export type VenueOrderBookParseResult =
  | { readonly status: "parsed"; readonly book: VenueOrderBook }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

/**
 * Parses one order-book body, through the prototype-free door.
 *
 * TOTAL: a body this door cannot read as venue data, and a refusal `zod` cannot
 * construct, both come back as `invalid` rather than as a throw (ADR-020's
 * 2026-09-06 amendment).
 */
export function parseVenueOrderBook(value: unknown): VenueOrderBookParseResult {
  // D1.
  const read = readOwnWireValue(value);
  if (!read.ok) {
    return invalidBook([`<root>: ${read.detail}`]);
  }
  const judged = containedJudgement(VenueOrderBookSchema, read.value);
  if (!judged.ok) {
    return invalidBook(judged.issues);
  }
  if (!isOwnWireRecord(read.value)) {
    // Unreachable while the schema is an object schema; kept because the door
    // may not depend on the library having run to know what it is holding.
    return invalidBook(["<root>: Invalid input: expected object"]);
  }
  // D2 compensation.
  const restated = restatedFieldFailures(VENUE_ORDER_BOOK_FIELDS, read.value);
  if (restated.length > 0) {
    return invalidBook(restated);
  }
  // D3 + D4.
  return ownResult<VenueOrderBookParseResult>({
    status: "parsed",
    book: projectBook(read.value),
  });
}

/** Outcome of parsing a batch body. */
export type VenueOrderBooksParseResult =
  | { readonly status: "parsed"; readonly books: readonly VenueOrderBook[] }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

/** Parses a `POST /books` body, through the same door, element by element. */
export function parseVenueOrderBooks(value: unknown): VenueOrderBooksParseResult {
  // D1.
  const read = readOwnWireValue(value);
  if (!read.ok) {
    return invalidBooks([`<root>: ${read.detail}`]);
  }
  const judged = containedJudgement(VenueOrderBooksSchema, read.value);
  if (!judged.ok) {
    return invalidBooks(judged.issues);
  }
  if (!Array.isArray(read.value)) {
    return invalidBooks(["<root>: Invalid input: expected array"]);
  }
  const entries: readonly unknown[] = read.value;
  // D2 compensation, per element, with the batch's own index in the path.
  const restated: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry: unknown = entries[index];
    if (!isOwnWireRecord(entry)) {
      restated.push(`${String(index)}: Invalid input: expected object`);
      continue;
    }
    for (const failure of restatedFieldFailures(VENUE_ORDER_BOOK_FIELDS, entry)) {
      restated.push(`${String(index)}.${failure}`);
    }
  }
  if (restated.length > 0) {
    return invalidBooks(restated);
  }
  // D3 + D4.
  const books: VenueOrderBook[] = [];
  for (const entry of entries) {
    books.push(projectBook(entry as OwnWireRecord));
  }
  return ownResult<VenueOrderBooksParseResult>({ status: "parsed", books });
}

function projectBook(record: OwnWireRecord): VenueOrderBook {
  return projectDeclaredFields(VENUE_ORDER_BOOK_FIELDS, record) as unknown as VenueOrderBook;
}

function invalidBook(issues: readonly string[]): VenueOrderBookParseResult {
  return ownResult<VenueOrderBookParseResult>({ status: "invalid", issues });
}

function invalidBooks(issues: readonly string[]): VenueOrderBooksParseResult {
  return ownResult<VenueOrderBooksParseResult>({ status: "invalid", issues });
}
