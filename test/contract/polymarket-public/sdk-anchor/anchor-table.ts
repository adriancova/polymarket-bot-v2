/**
 * The SDK anchor table — register item R-2.
 *
 * `docs/contracts/protected-contracts.md` §8.1 records R-2 as open and assigns
 * it to this work package "for the venue-adjacent schemas it owns":
 *
 * > **Hand-transcribed stand-in schemas are load-bearing.** `WP-000`'s
 * > `checks.ts` transcribes official SDK schemas by hand; a transcription error
 * > is a silent verification error.
 *
 * A prose promise that "these schemas match the SDK" is exactly the thing R-2
 * says is not good enough, because nobody checks it. This table is the check.
 * It records, for every field of every venue schema this package owns, the
 * modifier the official SDK declares for it, together with a commit permalink
 * to the line that declares it. `anchor.test.ts` then does three things with
 * it, and each one turns a transcription mistake into a failing test:
 *
 * 1. **Completeness.** Every key of the package's zod schema must appear in
 *    this table, and every entry in this table must appear in the schema. A
 *    field transcribed into the schema but never anchored, or anchored but
 *    dropped from the schema, fails.
 * 2. **Field count against the SDK.** Each anchor carries `sdkFieldCount`, the
 *    number of fields counted in the SDK source at the pinned commit on the
 *    date in this header. A field added to both the schema and the table
 *    without re-reading the SDK changes the count and fails, which forces the
 *    re-read to be recorded rather than assumed.
 * 3. **Behaviour, not text.** Every modifier is exercised as an accept/reject
 *    vector against the real parser: a `required` field must make the event
 *    fail when omitted; a `.nullish()` field must accept `null` AND absence; an
 *    optional decimal must additionally accept the wire empty string. A
 *    modifier transcribed wrongly changes observable behaviour and fails.
 *
 * That is what makes transcription no longer silently load-bearing: it is still
 * a transcription, but every claim it makes is executable.
 *
 * ## Sources
 *
 * All at reference commit `7fdbed42484b5d279c71aa36d3757d18968260da`, the
 * commit `docs/venue/verified-2026-08-24.md` §1 pins. Fields were counted from
 * these files, re-read read-only and unauthenticated on **2026-08-27**:
 *
 * - `packages/bindings/src/subscriptions/clob.ts` — the seven market-channel
 *   event schemas and `PriceChangeSchema`
 * - `packages/bindings/src/shared.ts` — `OptionalDecimalStringSchema`,
 *   `EpochMillisecondsStringSchema`, `TokenIdSchema`, `DecimalStringSchema`,
 *   `ConditionIdSchema` / `ConditionIdResponseSchema`, `OrderSideSchema`
 * - `packages/bindings/src/clob/order-book.ts` — `OrderBookSchema`
 */

export const SDK_REFERENCE_COMMIT = "7fdbed42484b5d279c71aa36d3757d18968260da";

const SDK_BASE = `https://github.com/Polymarket/ts-sdk/blob/${SDK_REFERENCE_COMMIT}/packages/bindings/src`;

const CLOB_SUBSCRIPTIONS = `${SDK_BASE}/subscriptions/clob.ts`;
const ORDER_BOOK = `${SDK_BASE}/clob/order-book.ts`;

/**
 * The modifier the SDK declares for a field, and therefore the acceptance
 * behaviour this package's parser must exhibit.
 */
export type SdkFieldModifier =
  /** No modifier: the key must be present with a valid value. */
  | "required"
  /** `z.literal(...)`: the discriminator. Present and exact. */
  | "literal"
  /** `.nullish()`: the key may be absent, or present and `null`. */
  | "nullish"
  /** `z.array(...).nullish()`: absent, `null`, or an array. */
  | "nullish-array"
  /**
   * `OptionalDecimalStringSchema` — `z.preprocess(emptyStringToNull,
   * DecimalStringSchema.nullish())`. Absent, `null`, OR the wire empty string.
   */
  | "optional-decimal";

export interface SdkFieldAnchor {
  readonly field: string;
  readonly modifier: SdkFieldModifier;
  /** A value the SDK accepts, used to build a minimal valid event. */
  readonly sample: unknown;
  /** Permalink to the SDK source that declares the modifier. */
  readonly citation: string;
  /**
   * Why this package is deliberately looser than the SDK for this field.
   *
   * Present only where the divergence is intentional; the behavioural driver
   * then checks the looser rule this package intends, not the SDK's. A
   * divergence with no recorded reason would be indistinguishable from a
   * transcription mistake, which is the whole point of R-2.
   */
  readonly sdkDivergence?: string;
}

export interface SdkSchemaAnchor {
  /** The SDK export this schema is transcribed from. */
  readonly schema: string;
  /** The package export it is transcribed into. */
  readonly localSchema: string;
  readonly citation: string;
  /** Field count read from the SDK source on the date in this module's header. */
  readonly sdkFieldCount: number;
  readonly fields: readonly SdkFieldAnchor[];
  /**
   * Places an anchored object into a complete wire event.
   *
   * Identity for a top-level event; for a nested schema it wraps the object in
   * its parent, so a nested required field can be tested through the real
   * entry point rather than through a private schema.
   */
  readonly embed: (value: Record<string, unknown>) => unknown;
}

const CONDITION_ID = "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75";
const TOKEN_ID =
  "107505882767731489358349912513945399560393482969656700824895970500493757150417";
const OTHER_TOKEN_ID =
  "7305630249804085635496399869905769372294302716159034447326228509068694952392";
const EPOCH_MS = "1782753357257";

const identity = (value: Record<string, unknown>): unknown => value;

/** `MarketBookEventSchema` — 11 fields. */
const bookAnchor: SdkSchemaAnchor = {
  schema: "MarketBookEventSchema",
  localSchema: "MarketBookEventSchema",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 11,
  embed: identity,
  fields: [
    { field: "event_type", modifier: "literal", sample: "book", citation: CLOB_SUBSCRIPTIONS },
    { field: "market", modifier: "required", sample: CONDITION_ID, citation: CLOB_SUBSCRIPTIONS },
    { field: "asset_id", modifier: "required", sample: TOKEN_ID, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "bids",
      modifier: "required",
      sample: [{ price: "0.08", size: "1" }],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "asks",
      modifier: "required",
      sample: [{ price: "0.09", size: "2" }],
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "hash", modifier: "nullish", sample: "0xabc123", citation: CLOB_SUBSCRIPTIONS },
    { field: "timestamp", modifier: "nullish", sample: EPOCH_MS, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "min_order_size",
      modifier: "optional-decimal",
      sample: "5",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "tick_size",
      modifier: "optional-decimal",
      sample: "0.01",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "neg_risk", modifier: "nullish", sample: false, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "last_trade_price",
      modifier: "optional-decimal",
      sample: "0.09",
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `MarketPriceChangeEventSchema` — 4 fields. */
const priceChangeAnchor: SdkSchemaAnchor = {
  schema: "MarketPriceChangeEventSchema",
  localSchema: "MarketPriceChangeEventSchema",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 4,
  embed: identity,
  fields: [
    {
      field: "event_type",
      modifier: "literal",
      sample: "price_change",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "market", modifier: "required", sample: CONDITION_ID, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "price_changes",
      modifier: "required",
      sample: [
        {
          asset_id: TOKEN_ID,
          price: "0.08",
          size: "1",
          side: "BUY",
          hash: "56621a121a47ed9333273e21c83b660cff37ae50",
          best_bid: "0.08",
          best_ask: "0.09",
        },
      ],
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "timestamp", modifier: "nullish", sample: EPOCH_MS, citation: CLOB_SUBSCRIPTIONS },
  ],
};

/** `PriceChangeSchema` (nested in `price_changes`) — 7 fields. */
const priceChangeEntryAnchor: SdkSchemaAnchor = {
  schema: "PriceChangeSchema",
  localSchema: "MarketPriceChangeEntrySchema",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 7,
  embed: (value) => ({
    event_type: "price_change",
    market: CONDITION_ID,
    price_changes: [value],
    timestamp: EPOCH_MS,
  }),
  fields: [
    { field: "asset_id", modifier: "required", sample: TOKEN_ID, citation: CLOB_SUBSCRIPTIONS },
    { field: "price", modifier: "required", sample: "0.08", citation: CLOB_SUBSCRIPTIONS },
    { field: "size", modifier: "required", sample: "33343.4", citation: CLOB_SUBSCRIPTIONS },
    { field: "side", modifier: "required", sample: "BUY", citation: CLOB_SUBSCRIPTIONS },
    {
      field: "hash",
      modifier: "nullish",
      sample: "56621a121a47ed9333273e21c83b660cff37ae50",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "best_bid",
      modifier: "optional-decimal",
      sample: "0.08",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "best_ask",
      modifier: "optional-decimal",
      sample: "0.09",
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `MarketLastTradePriceEventSchema` — 9 fields. */
const lastTradeAnchor: SdkSchemaAnchor = {
  schema: "MarketLastTradePriceEventSchema",
  localSchema: "MarketLastTradePriceEventSchema",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 9,
  embed: identity,
  fields: [
    {
      field: "event_type",
      modifier: "literal",
      sample: "last_trade_price",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "market", modifier: "required", sample: CONDITION_ID, citation: CLOB_SUBSCRIPTIONS },
    { field: "asset_id", modifier: "required", sample: TOKEN_ID, citation: CLOB_SUBSCRIPTIONS },
    { field: "price", modifier: "required", sample: "0.08", citation: CLOB_SUBSCRIPTIONS },
    {
      field: "size",
      modifier: "optional-decimal",
      sample: "219.217767",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "fee_rate_bps",
      modifier: "optional-decimal",
      sample: "0",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "side", modifier: "required", sample: "SELL", citation: CLOB_SUBSCRIPTIONS },
    { field: "timestamp", modifier: "nullish", sample: EPOCH_MS, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "transaction_hash",
      modifier: "nullish",
      sample: "0xeeefff",
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `MarketTickSizeChangeEventSchema` — 6 fields. */
const tickSizeAnchor: SdkSchemaAnchor = {
  schema: "MarketTickSizeChangeEventSchema",
  localSchema: "MarketTickSizeChangeEventSchema",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 6,
  embed: identity,
  fields: [
    {
      field: "event_type",
      modifier: "literal",
      sample: "tick_size_change",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "market", modifier: "required", sample: CONDITION_ID, citation: CLOB_SUBSCRIPTIONS },
    { field: "asset_id", modifier: "required", sample: TOKEN_ID, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "old_tick_size",
      modifier: "optional-decimal",
      sample: "0.01",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "new_tick_size",
      modifier: "required",
      sample: "0.001",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "timestamp", modifier: "nullish", sample: EPOCH_MS, citation: CLOB_SUBSCRIPTIONS },
  ],
};

/** `MarketBestBidAskEventSchema` — 7 fields. */
const bestBidAskAnchor: SdkSchemaAnchor = {
  schema: "MarketBestBidAskEventSchema",
  localSchema: "MarketBestBidAskEventSchema",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 7,
  embed: identity,
  fields: [
    {
      field: "event_type",
      modifier: "literal",
      sample: "best_bid_ask",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "market", modifier: "required", sample: CONDITION_ID, citation: CLOB_SUBSCRIPTIONS },
    { field: "asset_id", modifier: "required", sample: TOKEN_ID, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "best_bid",
      modifier: "optional-decimal",
      sample: "0.08",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "best_ask",
      modifier: "optional-decimal",
      sample: "0.09",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "spread",
      modifier: "optional-decimal",
      sample: "0.01",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "timestamp", modifier: "nullish", sample: EPOCH_MS, citation: CLOB_SUBSCRIPTIONS },
  ],
};

/** `NewMarketEventSchema` — 22 fields. */
const newMarketAnchor: SdkSchemaAnchor = {
  schema: "NewMarketEventSchema",
  localSchema: "NewMarketEventSchema",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 22,
  embed: identity,
  fields: [
    {
      field: "event_type",
      modifier: "literal",
      sample: "new_market",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "id", modifier: "required", sample: "123456", citation: CLOB_SUBSCRIPTIONS },
    {
      field: "question",
      modifier: "nullish",
      sample: "Will the US confirm that aliens exist before 2027?",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "market", modifier: "required", sample: CONDITION_ID, citation: CLOB_SUBSCRIPTIONS },
    { field: "slug", modifier: "nullish", sample: "a-slug", citation: CLOB_SUBSCRIPTIONS },
    {
      field: "description",
      modifier: "nullish",
      sample: "a description",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "assets_ids",
      modifier: "nullish-array",
      sample: [TOKEN_ID, OTHER_TOKEN_ID],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "outcomes",
      modifier: "nullish-array",
      sample: ["Yes", "No"],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "event_message",
      modifier: "nullish",
      sample: { id: "event-1" },
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "timestamp", modifier: "nullish", sample: EPOCH_MS, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "tags",
      modifier: "nullish-array",
      sample: ["stocks"],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "condition_id",
      modifier: "nullish",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "active", modifier: "nullish", sample: true, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "clob_token_ids",
      modifier: "nullish-array",
      sample: [TOKEN_ID],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "sports_market_type",
      modifier: "nullish",
      sample: "spread",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "line",
      modifier: "optional-decimal",
      sample: "2.5",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "game_start_time",
      modifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "order_price_min_tick_size",
      modifier: "optional-decimal",
      sample: "0.01",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "group_item_title",
      modifier: "nullish",
      sample: "NVDA above $240",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "taker_base_fee",
      modifier: "optional-decimal",
      sample: "0",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "fees_enabled", modifier: "nullish", sample: true, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "fee_schedule",
      modifier: "nullish",
      sample: { anything: true },
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `MarketResolvedEventSchema` — 9 fields. */
const marketResolvedAnchor: SdkSchemaAnchor = {
  schema: "MarketResolvedEventSchema",
  localSchema: "MarketResolvedEventSchema",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 9,
  embed: identity,
  fields: [
    {
      field: "event_type",
      modifier: "literal",
      sample: "market_resolved",
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "id", modifier: "required", sample: "123456", citation: CLOB_SUBSCRIPTIONS },
    { field: "market", modifier: "required", sample: CONDITION_ID, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "assets_ids",
      modifier: "nullish-array",
      sample: [TOKEN_ID, OTHER_TOKEN_ID],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "winning_asset_id",
      modifier: "nullish",
      sample: TOKEN_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "winning_outcome", modifier: "nullish", sample: "Yes", citation: CLOB_SUBSCRIPTIONS },
    {
      field: "event_message",
      modifier: "nullish",
      sample: { id: "event-1" },
      citation: CLOB_SUBSCRIPTIONS,
    },
    { field: "timestamp", modifier: "nullish", sample: EPOCH_MS, citation: CLOB_SUBSCRIPTIONS },
    {
      field: "tags",
      modifier: "nullish-array",
      sample: ["stocks"],
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** Every market-channel anchor. */
export const MARKET_EVENT_ANCHORS: readonly SdkSchemaAnchor[] = [
  bookAnchor,
  priceChangeAnchor,
  priceChangeEntryAnchor,
  lastTradeAnchor,
  tickSizeAnchor,
  bestBidAskAnchor,
  newMarketAnchor,
  marketResolvedAnchor,
];

/**
 * `OrderBookSchema` — 10 fields.
 *
 * Three fields are DELIBERATELY looser here than in the SDK, and the divergence
 * is recorded rather than hidden. `packages/polymarket-public/src/venue/order-book.ts`
 * carries the reasoning; in short: the SDK's 40-hex `hash` rejects the venue's
 * own published 64-hex example, its `ConditionIdSchema` byte-length bound is a
 * narrowing ADR-002 §7 forbids a runtime parser from inheriting, and its
 * `tick_size` conversion to a float literal is forbidden for economic values by
 * ADR-001. Those carry `sdkDivergence` so the behavioural driver checks the
 * looser rule this package intends, not the SDK's.
 */
export const ORDER_BOOK_ANCHOR: SdkSchemaAnchor = {
  schema: "OrderBookSchema",
  localSchema: "VenueOrderBookSchema",
  citation: ORDER_BOOK,
  sdkFieldCount: 10,
  embed: identity,
  fields: [
    {
      field: "market",
      modifier: "required",
      sample: CONDITION_ID,
      citation: ORDER_BOOK,
      sdkDivergence: "SDK bounds it to 31/32 bytes; ADR-002 §7 forbids inheriting that narrowing",
    },
    { field: "asset_id", modifier: "required", sample: TOKEN_ID, citation: ORDER_BOOK },
    { field: "timestamp", modifier: "nullish", sample: EPOCH_MS, citation: ORDER_BOOK },
    {
      field: "bids",
      modifier: "required",
      sample: [{ price: "0.01", size: "1" }],
      citation: ORDER_BOOK,
    },
    {
      field: "asks",
      modifier: "required",
      sample: [{ price: "0.99", size: "1" }],
      citation: ORDER_BOOK,
    },
    {
      field: "min_order_size",
      modifier: "optional-decimal",
      sample: "5",
      citation: ORDER_BOOK,
      sdkDivergence: "SDK requires it; the WebSocket book event marks the same field optional",
    },
    {
      field: "tick_size",
      modifier: "optional-decimal",
      sample: "0.01",
      citation: ORDER_BOOK,
      sdkDivergence: "SDK converts it to a float literal enum; ADR-001 forbids a float here",
    },
    {
      field: "neg_risk",
      modifier: "nullish",
      sample: false,
      citation: ORDER_BOOK,
      sdkDivergence: "SDK requires it; the WebSocket book event marks the same field nullish",
    },
    {
      field: "last_trade_price",
      modifier: "optional-decimal",
      sample: "0.090",
      citation: ORDER_BOOK,
    },
    {
      field: "hash",
      modifier: "nullish",
      sample: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      citation: ORDER_BOOK,
      sdkDivergence:
        "SDK pins 40 lowercase hex; the venue's own API example prints 64, so neither is pinned",
    },
  ],
};
