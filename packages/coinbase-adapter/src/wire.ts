/**
 * The Coinbase wire format, as zod schemas.
 *
 * This is the venue edge. Everything here describes what Coinbase actually
 * sends; nothing here describes what the domain accepts. The two are
 * deliberately different (ADR-001 §3, ADR-002 §7):
 *
 *   * **These schemas are permissive about unknown keys.** The overview states
 *     that "New message types can be added at any time. Clients are expected to
 *     ignore messages they do not support" (`json-frames`), and the AsyncAPI
 *     document marks no property required. A strict object here would start
 *     rejecting live traffic the first time Coinbase adds a field. Strictness
 *     lives one layer up, in `packages/domain`, where a strict object protects
 *     *recorded* data.
 *   * **These schemas do not enumerate free-string vocabularies.** `side` and
 *     `events[].type` are documented with enumerations, but ADR-002 §7 requires a
 *     runtime parser to treat an unrecognized value as first-class UNKNOWN
 *     rather than assume the enumeration is closed. They are parsed as strings
 *     and classified in `normalize.ts`.
 *   * **These schemas never see a decimal.** Economic fields are parsed as
 *     strings and canonicalized with `normalizeDecimalString` before they reach
 *     a domain schema. `z.number()` appears only for `sequence_num` and
 *     `heartbeat_counter`, which are counters, not economics (ADR-001 §7).
 *
 * Nothing here throws: every schema is used through `safeParse`, and a failure
 * becomes a typed anomaly carrying the raw frame.
 */

import { z } from "zod";

/**
 * The fields every streamed message carries (`envelope-base`).
 *
 * `events` is optional, not because a market-data frame ever omits it, but
 * because the `subscriptions` acknowledgement's payload shape is UNVERIFIED
 * (U-CB-5) while its `sequence_num` still has to be counted. Requiring a key
 * the documentation never describes would turn a control frame into a false
 * shape error.
 */
export const CoinbaseFrameEnvelopeSchema = z.object({
  channel: z.string().min(1),
  /** Server send time, RFC 3339 (`envelope-base`). Distinct from receipt time. */
  timestamp: z.string().min(1),
  /**
   * Per-connection message counter (`envelope-base`, `sequence-gap-meaning`).
   *
   * `z.int()` bounds it to the safe-integer range: two "different" sequence
   * numbers above `Number.MAX_SAFE_INTEGER` are not distinct values, and gap
   * detection built on values that can silently collide would be worse than no
   * gap detection at all.
   */
  sequence_num: z.int(),
  events: z.array(z.unknown()).optional(),
});
export type CoinbaseFrameEnvelope = z.infer<typeof CoinbaseFrameEnvelopeSchema>;

/**
 * One public trade (`market-trades-shape`).
 *
 * `price` and `size` stay strings all the way to `normalizeDecimalString`; no
 * economic value is ever parsed as a JavaScript number (ADR-001 §7).
 * `side` is the documented MAKER side (`market-trades-maker-side`) and is parsed
 * as a free string, not an enum.
 */
export const CoinbaseMarketTradeSchema = z.object({
  trade_id: z.string().min(1),
  product_id: z.string().min(1),
  price: z.string(),
  size: z.string(),
  side: z.string(),
  /** Time the trade occurred, RFC 3339 (`market-trades-shape`). */
  time: z.string().min(1),
});
export type CoinbaseMarketTrade = z.infer<typeof CoinbaseMarketTradeSchema>;

export const CoinbaseMarketTradesEventSchema = z.object({
  type: z.string(),
  trades: z.array(CoinbaseMarketTradeSchema),
});

export const CoinbaseMarketTradesFrameSchema = CoinbaseFrameEnvelopeSchema.extend({
  events: z.array(CoinbaseMarketTradesEventSchema),
});
export type CoinbaseMarketTradesFrame = z.infer<typeof CoinbaseMarketTradesFrameSchema>;

/**
 * One ticker entry (`ticker-shape`).
 *
 * The four top-of-book fields are optional because `ticker_batch` is documented
 * as not providing best bid or ask (`ticker-batch-no-top-of-book`), and because
 * the AsyncAPI marks nothing required. Optional here means the KEY MAY BE
 * ABSENT. It does not mean an empty string or `null` is accepted: whether
 * Coinbase ever sends either is UNVERIFIED (U-CB-1), so a present-but-empty
 * value fails this schema and is surfaced as a typed anomaly rather than being
 * silently reinterpreted as absence. Absence and emptiness are different facts.
 */
export const CoinbaseTickerSchema = z.object({
  product_id: z.string().min(1),
  best_bid: z.string().min(1).optional(),
  best_ask: z.string().min(1).optional(),
  best_bid_quantity: z.string().min(1).optional(),
  best_ask_quantity: z.string().min(1).optional(),
});
export type CoinbaseTicker = z.infer<typeof CoinbaseTickerSchema>;

export const CoinbaseTickerEventSchema = z.object({
  type: z.string(),
  tickers: z.array(CoinbaseTickerSchema),
});

export const CoinbaseTickerFrameSchema = CoinbaseFrameEnvelopeSchema.extend({
  events: z.array(CoinbaseTickerEventSchema),
});
export type CoinbaseTickerFrame = z.infer<typeof CoinbaseTickerFrameSchema>;

/**
 * One heartbeat (`heartbeats`).
 *
 * `current_time` is NOT parsed as a timestamp. The documented example is
 * `"2023-06-23 20:31:56.121961769 +0000 UTC m=+91717.525857105"`, which is Go's
 * default `time.Time` rendering and not RFC 3339; feeding it to the repository's
 * ISO timestamp schema would fail, and reformatting it would be this package
 * inventing a conversion the venue never documented. The envelope `timestamp`,
 * which *is* RFC 3339, is the heartbeat's venue time.
 */
export const CoinbaseHeartbeatEventSchema = z.object({
  current_time: z.string().min(1),
  heartbeat_counter: z.int().nonnegative(),
});

export const CoinbaseHeartbeatsFrameSchema = CoinbaseFrameEnvelopeSchema.extend({
  events: z.array(CoinbaseHeartbeatEventSchema),
});
export type CoinbaseHeartbeatsFrame = z.infer<typeof CoinbaseHeartbeatsFrameSchema>;

/**
 * Renders a zod failure as one bounded line for an anomaly `detail`.
 *
 * Bounded because the detail ends up in `DetailStringSchema` (2000 characters)
 * and because an unbounded venue-controlled string in a log is a liability.
 */
export function describeParseFailure(error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  const suffix = error.issues.length > 5 ? ` (+${error.issues.length - 5} more)` : "";
  return `${issues}${suffix}`.slice(0, 1000);
}
