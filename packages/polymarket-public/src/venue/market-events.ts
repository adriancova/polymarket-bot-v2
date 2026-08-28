/**
 * Raw wire schemas for the public market WebSocket channel.
 *
 * Endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/market`. This
 * channel is PUBLIC and unauthenticated — no credential appears anywhere in
 * this package.
 *
 * Field-by-field these mirror the official SDK bindings at the pinned reference
 * commit `7fdbed42484b5d279c71aa36d3757d18968260da`
 * (`packages/bindings/src/subscriptions/clob.ts`), with the ADR-002 §7
 * relaxations described in `./primitives.ts`. The anchor table in
 * `test/contract/polymarket-public/sdk-anchor/` pins that correspondence
 * behaviourally (register item R-2).
 *
 * Two shapes deliberately differ from the SDK, both in the "accept more"
 * direction, and both because the SDK's choice would discard real data:
 *
 * - `side` keeps an unrecognized value instead of rejecting the event, so the
 *   normalizer can report it as first-class UNKNOWN (ADR-002 §7).
 * - `event_type` values this package does not model are reported as an unknown
 *   event type rather than failing the whole frame, because the venue adds
 *   events (`best_bid_ask`, `new_market`, `market_resolved` were themselves
 *   later additions gated behind `custom_feature_enabled`).
 */

import { z } from "zod";

import {
  VenueBookLevelSchema,
  VenueConditionIdSchema,
  VenueDecimalStringSchema,
  VenueEpochLikeSchema,
  VenueOptionalDecimalStringSchema,
  VenueSideSchema,
  VenueTokenIdSchema,
} from "./primitives.js";

/**
 * `book` — "Full orderbook snapshot sent on subscribe or after a trade"
 * (https://docs.polymarket.com/api-reference/wss/market.md, accessed
 * 2026-08-27). `hash` there is "Hash of the orderbook content" and each level's
 * `size` is the "Total size at this price level".
 */
export const MarketBookEventSchema = z.object({
  event_type: z.literal("book"),
  market: VenueConditionIdSchema,
  asset_id: VenueTokenIdSchema,
  bids: z.array(VenueBookLevelSchema),
  asks: z.array(VenueBookLevelSchema),
  hash: z.string().nullish(),
  timestamp: VenueEpochLikeSchema.nullish(),
  min_order_size: VenueOptionalDecimalStringSchema,
  tick_size: VenueOptionalDecimalStringSchema,
  neg_risk: z.boolean().nullish(),
  last_trade_price: VenueOptionalDecimalStringSchema,
});

/**
 * One entry of a batched `price_change`.
 *
 * `size` is documented as the "New aggregate size (0 means level removed)" and
 * `hash` as the "Hash of the order that caused this change" — note that this is
 * an ORDER hash, not a book hash, which is why the normalizer does not put it
 * in `BookLevelChanged.venueBookHash`.
 */
export const MarketPriceChangeEntrySchema = z.object({
  asset_id: VenueTokenIdSchema,
  price: VenueDecimalStringSchema,
  size: VenueDecimalStringSchema,
  side: VenueSideSchema,
  hash: z.string().nullish(),
  best_bid: VenueOptionalDecimalStringSchema,
  best_ask: VenueOptionalDecimalStringSchema,
});

/** `price_change` — "Delta update to orderbook price levels when an order is placed or cancelled". */
export const MarketPriceChangeEventSchema = z.object({
  event_type: z.literal("price_change"),
  market: VenueConditionIdSchema,
  price_changes: z.array(MarketPriceChangeEntrySchema),
  timestamp: VenueEpochLikeSchema.nullish(),
});

/**
 * `last_trade_price` — "Trade execution event".
 *
 * `side` is documented "From taker's perspective", which is what licenses the
 * mapping onto the domain's `PublicTradeObserved.takerSide`.
 */
export const MarketLastTradePriceEventSchema = z.object({
  event_type: z.literal("last_trade_price"),
  market: VenueConditionIdSchema,
  asset_id: VenueTokenIdSchema,
  price: VenueDecimalStringSchema,
  size: VenueOptionalDecimalStringSchema,
  fee_rate_bps: VenueOptionalDecimalStringSchema,
  side: VenueSideSchema,
  timestamp: VenueEpochLikeSchema.nullish(),
  transaction_hash: z.string().nullish(),
});

/** `tick_size_change` — "Market tick size update when price approaches limits". */
export const MarketTickSizeChangeEventSchema = z.object({
  event_type: z.literal("tick_size_change"),
  market: VenueConditionIdSchema,
  asset_id: VenueTokenIdSchema,
  old_tick_size: VenueOptionalDecimalStringSchema,
  new_tick_size: VenueDecimalStringSchema,
  timestamp: VenueEpochLikeSchema.nullish(),
});

/** `best_bid_ask` — top of book; requires `custom_feature_enabled: true`. */
export const MarketBestBidAskEventSchema = z.object({
  event_type: z.literal("best_bid_ask"),
  market: VenueConditionIdSchema,
  asset_id: VenueTokenIdSchema,
  best_bid: VenueOptionalDecimalStringSchema,
  best_ask: VenueOptionalDecimalStringSchema,
  spread: VenueOptionalDecimalStringSchema,
  timestamp: VenueEpochLikeSchema.nullish(),
});

/** Parent-event metadata carried by both lifecycle events. */
export const MarketEventMessageSchema = z.object({
  id: z.string(),
  ticker: z.string().nullish(),
  slug: z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});

/**
 * `new_market` — market creation; requires `custom_feature_enabled: true`.
 *
 * `id` and `market` are the only required fields in the SDK schema, so this
 * event is validated as its own shape rather than as one all-optional union
 * with `market_resolved` (`docs/venue/verified-2026-08-24.md` §4).
 */
export const NewMarketEventSchema = z.object({
  event_type: z.literal("new_market"),
  id: z.string(),
  question: z.string().nullish(),
  market: VenueConditionIdSchema,
  slug: z.string().nullish(),
  description: z.string().nullish(),
  assets_ids: z.array(VenueTokenIdSchema).nullish(),
  outcomes: z.array(z.string()).nullish(),
  event_message: MarketEventMessageSchema.nullish(),
  timestamp: VenueEpochLikeSchema.nullish(),
  tags: z.array(z.string()).nullish(),
  condition_id: z.string().nullish(),
  active: z.boolean().nullish(),
  clob_token_ids: z.array(z.string()).nullish(),
  sports_market_type: z.string().nullish(),
  line: VenueOptionalDecimalStringSchema,
  game_start_time: VenueEpochLikeSchema.nullish(),
  order_price_min_tick_size: VenueOptionalDecimalStringSchema,
  group_item_title: z.string().nullish(),
  taker_base_fee: VenueOptionalDecimalStringSchema,
  fees_enabled: z.boolean().nullish(),
  fee_schedule: z.unknown().nullish(),
});

/** `market_resolved` — market resolution; requires `custom_feature_enabled: true`. */
export const MarketResolvedEventSchema = z.object({
  event_type: z.literal("market_resolved"),
  id: z.string(),
  market: VenueConditionIdSchema,
  assets_ids: z.array(VenueTokenIdSchema).nullish(),
  winning_asset_id: VenueTokenIdSchema.nullish(),
  winning_outcome: z.string().nullish(),
  event_message: MarketEventMessageSchema.nullish(),
  timestamp: VenueEpochLikeSchema.nullish(),
  tags: z.array(z.string()).nullish(),
});

/** The seven market-channel events this adapter models. */
export const MarketEventSchema = z.discriminatedUnion("event_type", [
  MarketBookEventSchema,
  MarketPriceChangeEventSchema,
  MarketLastTradePriceEventSchema,
  MarketTickSizeChangeEventSchema,
  MarketBestBidAskEventSchema,
  NewMarketEventSchema,
  MarketResolvedEventSchema,
]);

export type MarketBookEvent = z.infer<typeof MarketBookEventSchema>;
export type MarketPriceChangeEntry = z.infer<typeof MarketPriceChangeEntrySchema>;
export type MarketPriceChangeEvent = z.infer<typeof MarketPriceChangeEventSchema>;
export type MarketLastTradePriceEvent = z.infer<typeof MarketLastTradePriceEventSchema>;
export type MarketTickSizeChangeEvent = z.infer<typeof MarketTickSizeChangeEventSchema>;
export type MarketBestBidAskEvent = z.infer<typeof MarketBestBidAskEventSchema>;
export type NewMarketEvent = z.infer<typeof NewMarketEventSchema>;
export type MarketResolvedEvent = z.infer<typeof MarketResolvedEventSchema>;
export type MarketEvent = z.infer<typeof MarketEventSchema>;

/** The `event_type` values this adapter models, in declaration order. */
export const MODELLED_MARKET_EVENT_TYPES = [
  "book",
  "price_change",
  "last_trade_price",
  "tick_size_change",
  "best_bid_ask",
  "new_market",
  "market_resolved",
] as const;

export type ModelledMarketEventType = (typeof MODELLED_MARKET_EVENT_TYPES)[number];

/** Outcome of parsing one wire value from the market channel. */
export type MarketEventParseResult =
  | { readonly status: "parsed"; readonly event: MarketEvent }
  /** A well-formed object whose `event_type` this adapter does not model. */
  | { readonly status: "unknown-event-type"; readonly eventType: string }
  /** Not an object, or an `event_type` field that is missing or not a string. */
  | { readonly status: "unrecognized" }
  /** A modelled event type whose payload failed validation. */
  | {
      readonly status: "invalid";
      readonly eventType: ModelledMarketEventType;
      readonly issues: readonly string[];
    };

function isModelledEventType(value: string): value is ModelledMarketEventType {
  return (MODELLED_MARKET_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Parses one wire value.
 *
 * Splitting "unknown event type" from "invalid payload" matters: the first is
 * routine venue evolution and must not raise an incident every time the venue
 * ships a feature, while the second means a modelled contract no longer matches
 * the wire and an operator has to look.
 */
export function parseMarketEvent(value: unknown): MarketEventParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "unrecognized" };
  }
  const eventType = (value as Record<string, unknown>)["event_type"];
  if (typeof eventType !== "string") {
    return { status: "unrecognized" };
  }
  if (!isModelledEventType(eventType)) {
    return { status: "unknown-event-type", eventType };
  }
  const parsed = MarketEventSchema.safeParse(value);
  if (parsed.success) {
    return { status: "parsed", event: parsed.data };
  }
  return {
    status: "invalid",
    eventType,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    ),
  };
}
