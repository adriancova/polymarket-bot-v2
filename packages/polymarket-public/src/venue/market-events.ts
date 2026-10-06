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
 *
 * ## {@link parseMarketEvent} goes through a prototype-free door (`CLOB-1`)
 *
 * `./wire-door.ts` states which of ADR-020's D1-D4 this package performs and
 * what it measured; `./prototype-boundary.test.ts` holds the regressions. The
 * short form: the frame is materialized from own descriptors before anything
 * reads a key, the event type is read from that tree by this module rather
 * than by the library, every judgement runs inside a containment, and the
 * emitted event is projected from the tree onto a null prototype using the
 * `*_FIELDS` tables below — which `./venue-fields.test.ts` re-derives from the
 * schemas they mirror.
 *
 * ## Polymarket Protocol V2 (`V2-2`, 2026-10-05; plan rows A11, A12)
 *
 * The market channel serves a V2 position id like any asset id, subscribed by
 * `assets_ids` (`docs/venue/verified-2026-10-05.md` F-60, F-62). Its `book`
 * event carries `"version":"v2"`, which the channel reference does not
 * document (C-21, U-39). The `book` projection emits declared fields only, so
 * the key is never read and a V2 `book` normalizes exactly as its V1 shape
 * does. Identity comes from `asset_id` alone (`../normalize/market-events.ts`),
 * so the 32-byte `market` the V2 frame was observed carrying never has to
 * match the catalogue's condition id width. Every other V2 event type is
 * unobserved (U-38) and decoded by the unchanged schemas below; `V2-3` owns
 * `market_resolved` for V2 (A13). The contract suite pins the V2 capture
 * (`test/contract/polymarket-public/market-ws-fixtures.test.ts`).
 */

import { z } from "zod";

import {
  VENUE_BOOK_LEVEL_FIELDS,
  VenueBookLevelSchema,
  VenueConditionIdSchema,
  VenueDecimalStringSchema,
  VenueEpochLikeSchema,
  VenueOptionalDecimalStringSchema,
  VenueSideSchema,
  VenueTokenIdSchema,
} from "./primitives.js";
import {
  type WireFields,
  type WireJudge,
  containedJudgement,
  isOwnWireRecord,
  ownResult,
  ownStringMember,
  projectDeclaredFields,
  readOwnWireValue,
  restatedFieldFailures,
} from "./wire-door.js";

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
 * {@link MarketBookEventSchema}'s declared fields, for the D3 projection in
 * `./wire-door.ts`.
 *
 * `./venue-fields.test.ts` re-derives this table's key list, key ORDER,
 * requiredness (`isOptional()`) and the two transform rules (by node identity
 * against `VenueOptionalDecimalStringSchema` / `VenueSideSchema`) from the
 * schema above, and differences the door against the raw schema over the whole
 * declared-key matrix. A field added, reordered, re-modified or re-typed
 * without a matching row here fails the suite.
 */
export const MARKET_BOOK_EVENT_FIELDS: WireFields = [
  { key: "event_type", required: true, rule: "verbatim" },
  { key: "market", required: true, rule: "verbatim" },
  { key: "asset_id", required: true, rule: "verbatim" },
  { key: "bids", required: true, rule: { objectArray: VENUE_BOOK_LEVEL_FIELDS } },
  { key: "asks", required: true, rule: { objectArray: VENUE_BOOK_LEVEL_FIELDS } },
  { key: "hash", required: false, rule: "verbatim" },
  { key: "timestamp", required: false, rule: "verbatim" },
  { key: "min_order_size", required: false, rule: "optional-decimal" },
  { key: "tick_size", required: false, rule: "optional-decimal" },
  { key: "neg_risk", required: false, rule: "verbatim" },
  { key: "last_trade_price", required: false, rule: "optional-decimal" },
];

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

/** {@link MarketPriceChangeEntrySchema}'s declared fields (see the book table). */
export const MARKET_PRICE_CHANGE_ENTRY_FIELDS: WireFields = [
  { key: "asset_id", required: true, rule: "verbatim" },
  { key: "price", required: true, rule: "verbatim" },
  { key: "size", required: true, rule: "verbatim" },
  { key: "side", required: true, rule: "side" },
  { key: "hash", required: false, rule: "verbatim" },
  { key: "best_bid", required: false, rule: "optional-decimal" },
  { key: "best_ask", required: false, rule: "optional-decimal" },
];

/** `price_change` — "Delta update to orderbook price levels when an order is placed or cancelled". */
export const MarketPriceChangeEventSchema = z.object({
  event_type: z.literal("price_change"),
  market: VenueConditionIdSchema,
  price_changes: z.array(MarketPriceChangeEntrySchema),
  timestamp: VenueEpochLikeSchema.nullish(),
});

/** {@link MarketPriceChangeEventSchema}'s declared fields (see the book table). */
export const MARKET_PRICE_CHANGE_EVENT_FIELDS: WireFields = [
  { key: "event_type", required: true, rule: "verbatim" },
  { key: "market", required: true, rule: "verbatim" },
  {
    key: "price_changes",
    required: true,
    rule: { objectArray: MARKET_PRICE_CHANGE_ENTRY_FIELDS },
  },
  { key: "timestamp", required: false, rule: "verbatim" },
];

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

/** {@link MarketLastTradePriceEventSchema}'s declared fields (see the book table). */
export const MARKET_LAST_TRADE_PRICE_EVENT_FIELDS: WireFields = [
  { key: "event_type", required: true, rule: "verbatim" },
  { key: "market", required: true, rule: "verbatim" },
  { key: "asset_id", required: true, rule: "verbatim" },
  { key: "price", required: true, rule: "verbatim" },
  { key: "size", required: false, rule: "optional-decimal" },
  { key: "fee_rate_bps", required: false, rule: "optional-decimal" },
  { key: "side", required: true, rule: "side" },
  { key: "timestamp", required: false, rule: "verbatim" },
  { key: "transaction_hash", required: false, rule: "verbatim" },
];

/** `tick_size_change` — "Market tick size update when price approaches limits". */
export const MarketTickSizeChangeEventSchema = z.object({
  event_type: z.literal("tick_size_change"),
  market: VenueConditionIdSchema,
  asset_id: VenueTokenIdSchema,
  old_tick_size: VenueOptionalDecimalStringSchema,
  new_tick_size: VenueDecimalStringSchema,
  timestamp: VenueEpochLikeSchema.nullish(),
});

/** {@link MarketTickSizeChangeEventSchema}'s declared fields (see the book table). */
export const MARKET_TICK_SIZE_CHANGE_EVENT_FIELDS: WireFields = [
  { key: "event_type", required: true, rule: "verbatim" },
  { key: "market", required: true, rule: "verbatim" },
  { key: "asset_id", required: true, rule: "verbatim" },
  { key: "old_tick_size", required: false, rule: "optional-decimal" },
  { key: "new_tick_size", required: true, rule: "verbatim" },
  { key: "timestamp", required: false, rule: "verbatim" },
];

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

/** {@link MarketBestBidAskEventSchema}'s declared fields (see the book table). */
export const MARKET_BEST_BID_ASK_EVENT_FIELDS: WireFields = [
  { key: "event_type", required: true, rule: "verbatim" },
  { key: "market", required: true, rule: "verbatim" },
  { key: "asset_id", required: true, rule: "verbatim" },
  { key: "best_bid", required: false, rule: "optional-decimal" },
  { key: "best_ask", required: false, rule: "optional-decimal" },
  { key: "spread", required: false, rule: "optional-decimal" },
  { key: "timestamp", required: false, rule: "verbatim" },
];

/** Parent-event metadata carried by both lifecycle events. */
export const MarketEventMessageSchema = z.object({
  id: z.string(),
  ticker: z.string().nullish(),
  slug: z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});

/** {@link MarketEventMessageSchema}'s declared fields (see the book table). */
export const MARKET_EVENT_MESSAGE_FIELDS: WireFields = [
  { key: "id", required: true, rule: "verbatim" },
  { key: "ticker", required: false, rule: "verbatim" },
  { key: "slug", required: false, rule: "verbatim" },
  { key: "title", required: false, rule: "verbatim" },
  { key: "description", required: false, rule: "verbatim" },
];

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

/**
 * {@link NewMarketEventSchema}'s declared fields (see the book table).
 *
 * `fee_schedule` is `z.unknown()`, so it is projected VERBATIM at every depth —
 * the schema imposes no shape on it, and a projection that stripped keys the
 * schema never declared would drop venue data the adapter is supposed to carry
 * opaquely. The differential in `./venue-fields.test.ts` covers exactly that:
 * an unknown key injected inside `fee_schedule` survives both the door and the
 * raw schema, while one injected inside `event_message` survives neither.
 */
export const NEW_MARKET_EVENT_FIELDS: WireFields = [
  { key: "event_type", required: true, rule: "verbatim" },
  { key: "id", required: true, rule: "verbatim" },
  { key: "question", required: false, rule: "verbatim" },
  { key: "market", required: true, rule: "verbatim" },
  { key: "slug", required: false, rule: "verbatim" },
  { key: "description", required: false, rule: "verbatim" },
  { key: "assets_ids", required: false, rule: "verbatim" },
  { key: "outcomes", required: false, rule: "verbatim" },
  { key: "event_message", required: false, rule: { object: MARKET_EVENT_MESSAGE_FIELDS } },
  { key: "timestamp", required: false, rule: "verbatim" },
  { key: "tags", required: false, rule: "verbatim" },
  { key: "condition_id", required: false, rule: "verbatim" },
  { key: "active", required: false, rule: "verbatim" },
  { key: "clob_token_ids", required: false, rule: "verbatim" },
  { key: "sports_market_type", required: false, rule: "verbatim" },
  { key: "line", required: false, rule: "optional-decimal" },
  { key: "game_start_time", required: false, rule: "verbatim" },
  { key: "order_price_min_tick_size", required: false, rule: "optional-decimal" },
  { key: "group_item_title", required: false, rule: "verbatim" },
  { key: "taker_base_fee", required: false, rule: "optional-decimal" },
  { key: "fees_enabled", required: false, rule: "verbatim" },
  { key: "fee_schedule", required: false, rule: "verbatim" },
];

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

/** {@link MarketResolvedEventSchema}'s declared fields (see the book table). */
export const MARKET_RESOLVED_EVENT_FIELDS: WireFields = [
  { key: "event_type", required: true, rule: "verbatim" },
  { key: "id", required: true, rule: "verbatim" },
  { key: "market", required: true, rule: "verbatim" },
  { key: "assets_ids", required: false, rule: "verbatim" },
  { key: "winning_asset_id", required: false, rule: "verbatim" },
  { key: "winning_outcome", required: false, rule: "verbatim" },
  { key: "event_message", required: false, rule: { object: MARKET_EVENT_MESSAGE_FIELDS } },
  { key: "timestamp", required: false, rule: "verbatim" },
  { key: "tags", required: false, rule: "verbatim" },
];

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

/** One modelled event's judge and its declared-field projection. */
interface ModelledMarketEvent {
  readonly schema: WireJudge;
  readonly fields: WireFields;
}

/**
 * The per-type judge the door routes to, instead of {@link MarketEventSchema}.
 *
 * The union is still exported and still anchored — it is the package's
 * statement of what the market channel carries — but the DOOR does not parse
 * through it, and that is the whole of the first measured defeat. A
 * `discriminatedUnion` builds its `propValues` map lazily on the first parse,
 * and that build reads the discriminator name through the prototype chain: at
 * base `989d41d`, an inherited `event_type` turned `parseMarketEvent` into a
 * function that threw `TypeError: propValues[key].add is not a function`
 * instead of returning a {@link MarketEventParseResult}. The door reads the
 * discriminator itself, from the materialized tree, and hands the frame to the
 * one member schema that discriminator names — so the union's lazy build is
 * never on the door's path at all.
 *
 * Routing to the member rather than the union does not change the refusal
 * TEXT: `zod`'s discriminated union delegates to the matched member and reports
 * that member's issues with the same paths (measured across the payload family
 * in `./venue-fields.test.ts`, which differences every declared-key cell of
 * every event against the raw union).
 */
const MODELLED_MARKET_EVENTS: Readonly<Record<ModelledMarketEventType, ModelledMarketEvent>> = {
  book: { schema: MarketBookEventSchema, fields: MARKET_BOOK_EVENT_FIELDS },
  price_change: {
    schema: MarketPriceChangeEventSchema,
    fields: MARKET_PRICE_CHANGE_EVENT_FIELDS,
  },
  last_trade_price: {
    schema: MarketLastTradePriceEventSchema,
    fields: MARKET_LAST_TRADE_PRICE_EVENT_FIELDS,
  },
  tick_size_change: {
    schema: MarketTickSizeChangeEventSchema,
    fields: MARKET_TICK_SIZE_CHANGE_EVENT_FIELDS,
  },
  best_bid_ask: {
    schema: MarketBestBidAskEventSchema,
    fields: MARKET_BEST_BID_ASK_EVENT_FIELDS,
  },
  new_market: { schema: NewMarketEventSchema, fields: NEW_MARKET_EVENT_FIELDS },
  market_resolved: {
    schema: MarketResolvedEventSchema,
    fields: MARKET_RESOLVED_EVENT_FIELDS,
  },
};

/**
 * Parses one wire value, through the prototype-free door in `./wire-door.ts`.
 *
 * Splitting "unknown event type" from "invalid payload" matters: the first is
 * routine venue evolution and must not raise an incident every time the venue
 * ships a feature, while the second means a modelled contract no longer matches
 * the wire and an operator has to look.
 *
 * TOTAL, and now true rather than aspirational: every judgement runs inside
 * `containedJudgement`, so the base measurement — an escaping `TypeError` from
 * a function whose return type is {@link MarketEventParseResult} — cannot
 * recur, whatever the ambient prototype state. A value this door cannot read as
 * venue data is `unrecognized`, which is the same verdict the clean-missing
 * frame gets: fail closed, and never a throw.
 */
export function parseMarketEvent(value: unknown): MarketEventParseResult {
  // D1 — materialize from own descriptors before anything reads a key.
  const read = readOwnWireValue(value);
  if (!read.ok || !isOwnWireRecord(read.value)) {
    return ownResult<MarketEventParseResult>({ status: "unrecognized" });
  }
  const frame = read.value;
  // D3 for the field that ROUTES: read from the tree, not through a chain.
  const eventType = ownStringMember(frame, "event_type");
  if (eventType === undefined) {
    return ownResult<MarketEventParseResult>({ status: "unrecognized" });
  }
  if (!isModelledEventType(eventType)) {
    return ownResult<MarketEventParseResult>({ status: "unknown-event-type", eventType });
  }
  const modelled = MODELLED_MARKET_EVENTS[eventType];
  const judged = containedJudgement(modelled.schema, frame);
  if (!judged.ok) {
    return ownResult<MarketEventParseResult>({
      status: "invalid",
      eventType,
      issues: judged.issues,
    });
  }
  // D2 compensation: the presence re-statement, on the door's own reads. In a
  // clean process the schema has already refused everything this can catch.
  const restated = restatedFieldFailures(modelled.fields, frame);
  if (restated.length > 0) {
    return ownResult<MarketEventParseResult>({
      status: "invalid",
      eventType,
      issues: restated,
    });
  }
  // D3 + D4 — the emitted event is built from the tree, onto a null prototype.
  return ownResult<MarketEventParseResult>({
    status: "parsed",
    event: projectDeclaredFields(modelled.fields, frame) as unknown as MarketEvent,
  });
}
