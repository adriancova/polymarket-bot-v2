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
 *
 * ## What round 1 changed, and why
 *
 * Review finding M1: the first version of this table recorded ONE modifier per
 * field — the modifier this package declares — and called it the SDK's. Where
 * the two differed, the behavioural driver therefore asserted the local
 * behaviour and reported it as agreement with the SDK: the table proved the
 * divergence instead of detecting it. Four REST fields the official API and the
 * SDK both declare `required` parsed happily when omitted, and nothing failed.
 *
 * So every row now records the modifiers **separately**:
 *
 * - {@link SdkFieldAnchor.sdkModifier} — what the official SDK declares, at the
 *   pinned commit, with a permalink;
 * - {@link SdkFieldAnchor.restModifier} — for a REST schema, what the official
 *   OpenAPI document declares, with its own citation. A wire contract is the
 *   venue's, not its client library's;
 * - {@link SdkFieldAnchor.localModifier} — what this package declares.
 *
 * and every difference must name its **dimension** and its **reason**:
 *
 * - `presence` — whether the key may be absent or `null` at all. Loosening this
 *   is how a required field silently becomes optional, which is the failure M1
 *   found.
 * - `value-form` — what a PRESENT value may look like: a hex length, a float
 *   enum, an epoch spelling, an enumeration the venue may extend. ADR-001 and
 *   ADR-002 §7 mandate several of these; none of them licenses absence, and the
 *   driver holds the two dimensions apart so a value-form reason can no longer
 *   be spent on a presence change.
 *
 * ## What `anchor.test.ts` does with each row
 *
 * 1. **Completeness, both directions.** Every key of the package's zod schema
 *    must appear in the table and vice versa, read at runtime from
 *    `schema.shape`. Plus: every object schema the package EXPORTS must be
 *    anchored, which is what closes M1(a) — `VenueBookLevelSchema` and
 *    `MarketEventMessageSchema` were exported, load-bearing, and unanchored.
 * 2. **Field count against the SDK.** `sdkFieldCount` is the number counted in
 *    the SDK source at the pinned commit, so adding a field to both the schema
 *    and the table without re-reading the SDK fails.
 * 3. **The local modifier, as behaviour**, through the real entry point.
 * 4. **The SDK/REST modifier, as behaviour**: everything the stricter source
 *    accepts must parse here (an adapter may not be stricter than the venue),
 *    and everything it REQUIRES must either be required here too or carry a
 *    recorded `presence` divergence.
 * 5. **Value-form divergences must be executable**: each carries at least one
 *    `localOnlyValue` — a value the SDK's own value form rejects — which must
 *    parse here. A value-form reason with no vector, or a vector with no
 *    reason, fails.
 * 6. **Citation hygiene.** Every citation embeds the pinned commit or an
 *    official documentation URL with a retrieval date; a mutable `blob/main`
 *    link is rejected.
 *
 * ## Sources
 *
 * SDK: reference commit `7fdbed42484b5d279c71aa36d3757d18968260da`, the commit
 * `docs/venue/verified-2026-08-24.md` §1 pins. Fields were counted from these
 * files, re-read read-only and unauthenticated on **2026-08-27** (round 1
 * re-read the same day, which is where the modifiers below now come from):
 *
 * - `packages/bindings/src/subscriptions/clob.ts` — the seven market-channel
 *   event schemas, `PriceChangeSchema`, `OrderBookLevelSchema`,
 *   `MarketEventMessageSchema`, `NormalizedOrderSideSchema`
 * - `packages/bindings/src/shared.ts` — `OptionalDecimalStringSchema`,
 *   `EpochMillisecondsStringSchema`, `TokenIdSchema`, `DecimalStringSchema`,
 *   `ConditionIdSchema` / `ConditionIdResponseSchema`, `OrderSideSchema`,
 *   `TickSizeValueSchema`
 * - `packages/bindings/src/clob/order-book.ts` — `OrderBookSchema`
 *
 * Venue: `https://docs.polymarket.com/api-reference/market-data/get-order-book.md`
 * (the `GET /book` OpenAPI document, `OrderBookSummary` and `OrderSummary`),
 * retrieved read-only and unauthenticated on **2026-08-27**.
 */

export const SDK_REFERENCE_COMMIT = "7fdbed42484b5d279c71aa36d3757d18968260da";

const SDK_BASE = `https://github.com/Polymarket/ts-sdk/blob/${SDK_REFERENCE_COMMIT}/packages/bindings/src`;

const CLOB_SUBSCRIPTIONS = `${SDK_BASE}/subscriptions/clob.ts`;
const ORDER_BOOK = `${SDK_BASE}/clob/order-book.ts`;

/** The official REST contract for the book endpoints, with its retrieval date. */
export const REST_BOOK_SPEC =
  "https://docs.polymarket.com/api-reference/market-data/get-order-book.md#OrderBookSummary (retrieved 2026-08-27)";

/**
 * The modifier a source declares for a field, and therefore the acceptance
 * behaviour it prescribes.
 */
export type FieldModifier =
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

/** Which axis of a schema a divergence moves. */
export type DivergenceDimension =
  /** Whether the key may be absent or `null`. */
  | "presence"
  /** What a present value may look like. */
  | "value-form";

/** One recorded, reasoned difference between a source and this package. */
export interface RecordedDivergence {
  readonly dimension: DivergenceDimension;
  /** Which source this package departs from. */
  readonly from: "sdk" | "rest-openapi";
  /** Why. A divergence with no reason is a transcription mistake in disguise. */
  readonly reason: string;
  /** The rule or evidence that licenses it. */
  readonly authority: string;
}

export interface SdkFieldAnchor {
  readonly field: string;
  /** What the official SDK declares at the pinned commit. */
  readonly sdkModifier: FieldModifier;
  /** What the official REST OpenAPI declares. REST anchors only. */
  readonly restModifier?: FieldModifier;
  /** What THIS package declares. */
  readonly localModifier: FieldModifier;
  /** A value the SDK accepts, used to build a minimal valid event. */
  readonly sample: unknown;
  /** Permalink to the SDK source that declares the modifier. */
  readonly citation: string;
  /** Citation for {@link restModifier}. */
  readonly restCitation?: string;
  /**
   * Values this package accepts that the stricter source's VALUE form rejects.
   *
   * The executable half of a `value-form` divergence: without one, "we are
   * deliberately looser here" is a claim no test makes.
   */
  readonly localOnlyValues?: readonly unknown[];
  /** Every recorded difference, by dimension. */
  readonly divergences?: readonly RecordedDivergence[];
}

/** Which layer an anchored schema belongs to, and therefore how it is parsed. */
export type AnchorLayer =
  /** A top-level market-channel event. */
  | "market-event"
  /** A schema nested inside a market-channel event. */
  | "market-event-nested"
  /** The REST order-book summary. */
  | "rest-book";

export interface SdkSchemaAnchor {
  /** The SDK export this schema is transcribed from. */
  readonly schema: string;
  /** The package export it is transcribed into. */
  readonly localSchema: string;
  readonly layer: AnchorLayer;
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

/**
 * `timestamp` everywhere: the SDK pins the digit-string spelling, this package
 * accepts every epoch-like form.
 *
 * `EpochMillisecondsStringSchema` is `z.string().regex(/^\d+$/)`. ADR-002 §7
 * makes it binding that "an adapter must accept every form the SDK accepts,
 * including the date-like string" — the forms
 * `EpochLikeToIsoDateTimeStringSchema` admits. The wire layer therefore admits
 * the SHAPE (string or integer) and `normalizeVenueInstant` judges the value,
 * reporting an unusable one as a typed `INVALID_TIMESTAMP` problem instead of
 * failing the whole frame.
 */
const EPOCH_LIKE_DIVERGENCE: RecordedDivergence = {
  dimension: "value-form",
  from: "sdk",
  reason:
    "the SDK's market-channel timestamp is a digit string only; this parser also admits the integer and date-like forms its own EpochLikeToIsoDateTimeStringSchema accepts, and defers judging the value to normalizeVenueInstant so an unusable timestamp is a reported problem rather than a discarded frame",
  authority: "ADR-002 §7 (epoch-like forms); docs/contracts/protected-contracts.md §9",
};

const EPOCH_LIKE_VALUES: readonly unknown[] = [1782753357257, "2026-06-29"];

/**
 * `side`: the SDK rejects anything outside `BUY`/`SELL`; this package keeps it.
 *
 * ADR-002 §7: "A runtime parser must treat an unrecognized value as first-class
 * UNKNOWN — routed to `DataQualityIncidentOpened` and preserved raw — rather
 * than assuming the enumeration is exhaustive."
 */
const SIDE_DIVERGENCE: RecordedDivergence = {
  dimension: "value-form",
  from: "sdk",
  reason:
    "the SDK's NormalizedOrderSideSchema upper-cases and then rejects anything outside the BUY/SELL enum, which would discard the whole event; this parser keeps the value so the normalizer can report it as first-class UNKNOWN with the raw frame attached",
  authority: "ADR-002 §7 (unrecognized free-string values)",
};

/** `MarketBookEventSchema` — 11 fields. */
const bookAnchor: SdkSchemaAnchor = {
  schema: "MarketBookEventSchema",
  localSchema: "MarketBookEventSchema",
  layer: "market-event",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 11,
  embed: identity,
  fields: [
    {
      field: "event_type",
      sdkModifier: "literal",
      localModifier: "literal",
      sample: "book",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "market",
      sdkModifier: "required",
      localModifier: "required",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "asset_id",
      sdkModifier: "required",
      localModifier: "required",
      sample: TOKEN_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "bids",
      sdkModifier: "required",
      localModifier: "required",
      sample: [{ price: "0.08", size: "1" }],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "asks",
      sdkModifier: "required",
      localModifier: "required",
      sample: [{ price: "0.09", size: "2" }],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "hash",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "0xabc123",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "timestamp",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: EPOCH_LIKE_VALUES,
      divergences: [EPOCH_LIKE_DIVERGENCE],
    },
    {
      field: "min_order_size",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "5",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "tick_size",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.01",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "neg_risk",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: false,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "last_trade_price",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.09",
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `OrderBookLevelSchema` (nested in `bids`/`asks`, both layers) — 2 fields. */
const bookLevelAnchor: SdkSchemaAnchor = {
  schema: "OrderBookLevelSchema",
  localSchema: "VenueBookLevelSchema",
  layer: "market-event-nested",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 2,
  embed: (value) => ({
    event_type: "book",
    market: CONDITION_ID,
    asset_id: TOKEN_ID,
    bids: [value],
    asks: [],
  }),
  fields: [
    {
      field: "price",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: "0.08",
      citation: CLOB_SUBSCRIPTIONS,
      restCitation: REST_BOOK_SPEC,
    },
    {
      field: "size",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: "1",
      citation: CLOB_SUBSCRIPTIONS,
      restCitation: REST_BOOK_SPEC,
    },
  ],
};

/** `MarketPriceChangeEventSchema` — 4 fields. */
const priceChangeAnchor: SdkSchemaAnchor = {
  schema: "MarketPriceChangeEventSchema",
  localSchema: "MarketPriceChangeEventSchema",
  layer: "market-event",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 4,
  embed: identity,
  fields: [
    {
      field: "event_type",
      sdkModifier: "literal",
      localModifier: "literal",
      sample: "price_change",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "market",
      sdkModifier: "required",
      localModifier: "required",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "price_changes",
      sdkModifier: "required",
      localModifier: "required",
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
    {
      field: "timestamp",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: EPOCH_LIKE_VALUES,
      divergences: [EPOCH_LIKE_DIVERGENCE],
    },
  ],
};

/** `PriceChangeSchema` (nested in `price_changes`) — 7 fields. */
const priceChangeEntryAnchor: SdkSchemaAnchor = {
  schema: "PriceChangeSchema",
  localSchema: "MarketPriceChangeEntrySchema",
  layer: "market-event-nested",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 7,
  embed: (value) => ({
    event_type: "price_change",
    market: CONDITION_ID,
    price_changes: [value],
    timestamp: EPOCH_MS,
  }),
  fields: [
    {
      field: "asset_id",
      sdkModifier: "required",
      localModifier: "required",
      sample: TOKEN_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "price",
      sdkModifier: "required",
      localModifier: "required",
      sample: "0.08",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "size",
      sdkModifier: "required",
      localModifier: "required",
      sample: "33343.4",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "side",
      sdkModifier: "required",
      localModifier: "required",
      sample: "BUY",
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: ["MIDDLE"],
      divergences: [SIDE_DIVERGENCE],
    },
    {
      field: "hash",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "56621a121a47ed9333273e21c83b660cff37ae50",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "best_bid",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.08",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "best_ask",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.09",
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `MarketLastTradePriceEventSchema` — 9 fields. */
const lastTradeAnchor: SdkSchemaAnchor = {
  schema: "MarketLastTradePriceEventSchema",
  localSchema: "MarketLastTradePriceEventSchema",
  layer: "market-event",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 9,
  embed: identity,
  fields: [
    {
      field: "event_type",
      sdkModifier: "literal",
      localModifier: "literal",
      sample: "last_trade_price",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "market",
      sdkModifier: "required",
      localModifier: "required",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "asset_id",
      sdkModifier: "required",
      localModifier: "required",
      sample: TOKEN_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "price",
      sdkModifier: "required",
      localModifier: "required",
      sample: "0.08",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "size",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "219.217767",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "fee_rate_bps",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "side",
      sdkModifier: "required",
      localModifier: "required",
      sample: "SELL",
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: ["MIDDLE"],
      divergences: [SIDE_DIVERGENCE],
    },
    {
      field: "timestamp",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: EPOCH_LIKE_VALUES,
      divergences: [EPOCH_LIKE_DIVERGENCE],
    },
    {
      field: "transaction_hash",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "0xeeefff",
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `MarketTickSizeChangeEventSchema` — 6 fields. */
const tickSizeAnchor: SdkSchemaAnchor = {
  schema: "MarketTickSizeChangeEventSchema",
  localSchema: "MarketTickSizeChangeEventSchema",
  layer: "market-event",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 6,
  embed: identity,
  fields: [
    {
      field: "event_type",
      sdkModifier: "literal",
      localModifier: "literal",
      sample: "tick_size_change",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "market",
      sdkModifier: "required",
      localModifier: "required",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "asset_id",
      sdkModifier: "required",
      localModifier: "required",
      sample: TOKEN_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "old_tick_size",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.01",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "new_tick_size",
      sdkModifier: "required",
      localModifier: "required",
      sample: "0.001",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "timestamp",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: EPOCH_LIKE_VALUES,
      divergences: [EPOCH_LIKE_DIVERGENCE],
    },
  ],
};

/** `MarketBestBidAskEventSchema` — 7 fields. */
const bestBidAskAnchor: SdkSchemaAnchor = {
  schema: "MarketBestBidAskEventSchema",
  localSchema: "MarketBestBidAskEventSchema",
  layer: "market-event",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 7,
  embed: identity,
  fields: [
    {
      field: "event_type",
      sdkModifier: "literal",
      localModifier: "literal",
      sample: "best_bid_ask",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "market",
      sdkModifier: "required",
      localModifier: "required",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "asset_id",
      sdkModifier: "required",
      localModifier: "required",
      sample: TOKEN_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "best_bid",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.08",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "best_ask",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.09",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "spread",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.01",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "timestamp",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: EPOCH_LIKE_VALUES,
      divergences: [EPOCH_LIKE_DIVERGENCE],
    },
  ],
};

/** `MarketEventMessageSchema` (nested in both lifecycle events) — 5 fields. */
const eventMessageAnchor: SdkSchemaAnchor = {
  schema: "MarketEventMessageSchema",
  localSchema: "MarketEventMessageSchema",
  layer: "market-event-nested",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 5,
  embed: (value) => ({
    event_type: "new_market",
    id: "123456",
    market: CONDITION_ID,
    event_message: value,
  }),
  fields: [
    {
      field: "id",
      sdkModifier: "required",
      localModifier: "required",
      sample: "event-1",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "ticker",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "NVDA",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "slug",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "a-slug",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "title",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "a title",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "description",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "a description",
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `NewMarketEventSchema` — 22 fields. */
const newMarketAnchor: SdkSchemaAnchor = {
  schema: "NewMarketEventSchema",
  localSchema: "NewMarketEventSchema",
  layer: "market-event",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 22,
  embed: identity,
  fields: [
    {
      field: "event_type",
      sdkModifier: "literal",
      localModifier: "literal",
      sample: "new_market",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "id",
      sdkModifier: "required",
      localModifier: "required",
      sample: "123456",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "question",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "Will the US confirm that aliens exist before 2027?",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "market",
      sdkModifier: "required",
      localModifier: "required",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "slug",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "a-slug",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "description",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "a description",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "assets_ids",
      sdkModifier: "nullish-array",
      localModifier: "nullish-array",
      sample: [TOKEN_ID, OTHER_TOKEN_ID],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "outcomes",
      sdkModifier: "nullish-array",
      localModifier: "nullish-array",
      sample: ["Yes", "No"],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "event_message",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: { id: "event-1" },
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "timestamp",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: EPOCH_LIKE_VALUES,
      divergences: [EPOCH_LIKE_DIVERGENCE],
    },
    {
      field: "tags",
      sdkModifier: "nullish-array",
      localModifier: "nullish-array",
      sample: ["stocks"],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "condition_id",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: ["0xabc", `0x${"d".repeat(96)}`],
      divergences: [
        {
          dimension: "value-form",
          from: "sdk",
          reason:
            "the SDK types this field ConditionIdSchema, which refuses anything but a 31/32-byte hex string; ADR-002 §7 makes it binding that a runtime parser accept any hex condition id ConditionIdResponseSchema accepts, which 'validates hex syntax without constraining the condition ID byte length'",
          authority: "ADR-002 §7; docs/contracts/protected-contracts.md §9",
        },
      ],
    },
    {
      field: "active",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: true,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "clob_token_ids",
      sdkModifier: "nullish-array",
      localModifier: "nullish-array",
      sample: [TOKEN_ID],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "sports_market_type",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "spread",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "line",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "2.5",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "game_start_time",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: ["not-a-date"],
      divergences: [
        {
          dimension: "value-form",
          from: "sdk",
          reason:
            "the SDK pipes this through DateLikeToIsoDateTimeStringSchema, which rejects a string it cannot read as a date; this wire layer admits the shape and lets normalizeVenueInstant judge the value, so an unreadable game start time is a reported problem rather than a discarded market announcement",
          authority: "ADR-002 §7 (epoch-like forms); §8.3 (no silent drops)",
        },
      ],
    },
    {
      field: "order_price_min_tick_size",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0.01",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "group_item_title",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "NVDA above $240",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "taker_base_fee",
      sdkModifier: "optional-decimal",
      localModifier: "optional-decimal",
      sample: "0",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "fees_enabled",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: true,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "fee_schedule",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: { anything: true },
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** `MarketResolvedEventSchema` — 9 fields. */
const marketResolvedAnchor: SdkSchemaAnchor = {
  schema: "MarketResolvedEventSchema",
  localSchema: "MarketResolvedEventSchema",
  layer: "market-event",
  citation: CLOB_SUBSCRIPTIONS,
  sdkFieldCount: 9,
  embed: identity,
  fields: [
    {
      field: "event_type",
      sdkModifier: "literal",
      localModifier: "literal",
      sample: "market_resolved",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "id",
      sdkModifier: "required",
      localModifier: "required",
      sample: "123456",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "market",
      sdkModifier: "required",
      localModifier: "required",
      sample: CONDITION_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "assets_ids",
      sdkModifier: "nullish-array",
      localModifier: "nullish-array",
      sample: [TOKEN_ID, OTHER_TOKEN_ID],
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "winning_asset_id",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: TOKEN_ID,
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "winning_outcome",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: "Yes",
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "event_message",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: { id: "event-1" },
      citation: CLOB_SUBSCRIPTIONS,
    },
    {
      field: "timestamp",
      sdkModifier: "nullish",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: CLOB_SUBSCRIPTIONS,
      localOnlyValues: EPOCH_LIKE_VALUES,
      divergences: [EPOCH_LIKE_DIVERGENCE],
    },
    {
      field: "tags",
      sdkModifier: "nullish-array",
      localModifier: "nullish-array",
      sample: ["stocks"],
      citation: CLOB_SUBSCRIPTIONS,
    },
  ],
};

/** Every market-channel anchor, including the nested schemas. */
export const MARKET_EVENT_ANCHORS: readonly SdkSchemaAnchor[] = [
  bookAnchor,
  bookLevelAnchor,
  priceChangeAnchor,
  priceChangeEntryAnchor,
  lastTradeAnchor,
  tickSizeAnchor,
  bestBidAskAnchor,
  eventMessageAnchor,
  newMarketAnchor,
  marketResolvedAnchor,
];

/**
 * `OrderBookSchema` — 10 fields, anchored to TWO sources.
 *
 * The SDK column is the pinned `packages/bindings/src/clob/order-book.ts`; the
 * REST column is the venue's own OpenAPI document, which is the actual wire
 * contract. They agree that eight of the ten fields are required, and this
 * package now agrees with both (round-1 finding M1). The three value-form
 * relaxations — the hash length, the condition-id bound, the decimal-string
 * tick size — each carry their dimension, their reason and a vector that proves
 * the relaxation is real. The two presence divergences from the OpenAPI are
 * where the SDK is looser than the spec, and they name the SDK as the evidence.
 */
export const ORDER_BOOK_ANCHOR: SdkSchemaAnchor = {
  schema: "OrderBookSchema",
  localSchema: "VenueOrderBookSchema",
  layer: "rest-book",
  citation: ORDER_BOOK,
  sdkFieldCount: 10,
  embed: identity,
  fields: [
    {
      field: "market",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: CONDITION_ID,
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
      localOnlyValues: ["0xabc", `0x${"d".repeat(96)}`],
      divergences: [
        {
          dimension: "value-form",
          from: "sdk",
          reason:
            "the SDK bounds the condition id to 31/32 bytes; ADR-002 §7 forbids a runtime parser from inheriting that narrowing, because ConditionIdResponseSchema — the SDK's own response-side schema — 'validates hex syntax without constraining the condition ID byte length'",
          authority: "ADR-002 §7; docs/contracts/protected-contracts.md §9",
        },
      ],
    },
    {
      field: "asset_id",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: TOKEN_ID,
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
    },
    {
      field: "timestamp",
      sdkModifier: "nullish",
      restModifier: "required",
      localModifier: "nullish",
      sample: EPOCH_MS,
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
      localOnlyValues: EPOCH_LIKE_VALUES,
      divergences: [
        {
          dimension: "presence",
          from: "rest-openapi",
          reason:
            "the OpenAPI lists timestamp under `required`, but the SDK's own client for this endpoint declares it `.nullish()`; the looser of two first-party readings is the safe one for an INBOUND parser, and an absent timestamp maps to ABSENT rather than to an epoch zero. A snapshot is still emitted, without a venueTimestamp",
          authority:
            "SDK OrderBookSchema at the pinned commit; ADR-001 §8.1 (absence is not a value)",
        },
        EPOCH_LIKE_DIVERGENCE,
      ],
    },
    {
      field: "bids",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: [{ price: "0.01", size: "1" }],
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
    },
    {
      field: "asks",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: [{ price: "0.99", size: "1" }],
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
    },
    {
      field: "min_order_size",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: "5",
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
    },
    {
      field: "tick_size",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: "0.01",
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
      localOnlyValues: ["0.02", "0.5"],
      divergences: [
        {
          dimension: "value-form",
          from: "sdk",
          reason:
            "the SDK converts the decimal string to a float and pins it to six IEEE-754 literals; ADR-001 forbids representing an economic value as a float anywhere in this repository, and the literal enum would additionally reject any tick size the venue adds. The value stays an exact decimal string and is normalized like every other decimal",
          authority: "ADR-001 §1, §4 (exact decimal representation)",
        },
      ],
    },
    {
      field: "neg_risk",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: false,
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
    },
    {
      field: "last_trade_price",
      sdkModifier: "nullish",
      restModifier: "required",
      localModifier: "optional-decimal",
      sample: "0.090",
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
      localOnlyValues: [""],
      divergences: [
        {
          dimension: "presence",
          from: "rest-openapi",
          reason:
            "the OpenAPI lists last_trade_price under `required`, but the SDK declares it `.nullish()` and a market that has never traded has no last trade price; rejecting the whole book over it would turn a recoverable snapshot into a failed recovery. Absence maps to ABSENT, never to '0'",
          authority:
            "SDK OrderBookSchema at the pinned commit; ADR-001 §8.1 (an absent price is not zero)",
        },
        {
          dimension: "value-form",
          from: "sdk",
          reason:
            "the wire empty string is additionally accepted as a spelling of absence, because the SDK's own OptionalDecimalStringSchema documents that this venue 'serializes absent optional decimals as an empty string'; it widens how absence may be SPELLED and never whether the field may be missing",
          authority: "ADR-001 §8.1; the SDK's OptionalDecimalStringSchema comment",
        },
      ],
    },
    {
      field: "hash",
      sdkModifier: "required",
      restModifier: "required",
      localModifier: "required",
      sample: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      citation: ORDER_BOOK,
      restCitation: REST_BOOK_SPEC,
      // The 64-character digest the API tab of the same page prints, which the
      // SDK's 40-hex pattern rejects.
      localOnlyValues: [
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      ],
      divergences: [
        {
          dimension: "value-form",
          from: "sdk",
          reason:
            "the SDK pins 40 lowercase hex characters and the documentation's TypeScript tab prints one, but the API tab of the same page prints a 64-character digest for the same field; the two published forms disagree, so neither length is pinned. The value is carried opaquely and compared only for equality, which is what the page says it is for. An EMPTY hash is still rejected",
          authority:
            "https://docs.polymarket.com/market-data/prices-order-books (retrieved 2026-08-27), whose two tabs disagree",
        },
      ],
    },
  ],
};

/** Every anchor in the table. */
export const ALL_ANCHORS: readonly SdkSchemaAnchor[] = [
  ...MARKET_EVENT_ANCHORS,
  ORDER_BOOK_ANCHOR,
];
