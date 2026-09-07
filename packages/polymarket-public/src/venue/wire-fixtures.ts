/**
 * Honest wire payloads for the two boundary suites in this directory.
 *
 * These are hand-built, documentation-shaped examples — one per wire shape —
 * used by `./venue-fields.test.ts` (the schema-derived table differential) and
 * `./prototype-boundary.test.ts` (the declared-key pollution sweep). They are
 * deliberately NOT the frozen `test/fixtures/venue/` catalogue: those are
 * `WP-000`'s sanitized venue snapshots and belong to the contract suite, which
 * drives them through the real entry points. What these need instead is *every
 * declared key present at once*, so a per-key sweep has a cell for each one —
 * a property the frozen examples do not have and should not be edited to have.
 *
 * Not exported from the package (`../index.ts` does not re-export this module):
 * it is colocated test data, not part of the adapter's surface.
 */

/** A documentation-shaped condition id. */
export const MARKET = "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75";

/** A documentation-shaped token id. */
export const ASSET =
  "107505882767731489358349912513945399560393482969656700824895970500493757150417";

export const BOOK_EVENT: Record<string, unknown> = {
  event_type: "book",
  market: MARKET,
  asset_id: ASSET,
  bids: [{ price: "0.01", size: "1" }],
  asks: [{ price: "0.99", size: "1" }],
  hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  timestamp: "1782753357257",
  min_order_size: "5",
  tick_size: "0.01",
  neg_risk: false,
  last_trade_price: "0.090",
};

export const PRICE_CHANGE_ENTRY: Record<string, unknown> = {
  asset_id: ASSET,
  price: "0.42",
  size: "17",
  side: "BUY",
  hash: "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  best_bid: "0.41",
  best_ask: "0.43",
};

export const PRICE_CHANGE_EVENT: Record<string, unknown> = {
  event_type: "price_change",
  market: MARKET,
  price_changes: [PRICE_CHANGE_ENTRY],
  timestamp: "1782753357257",
};

export const LAST_TRADE_EVENT: Record<string, unknown> = {
  event_type: "last_trade_price",
  market: MARKET,
  asset_id: ASSET,
  price: "0.42",
  size: "17",
  fee_rate_bps: "0",
  side: "SELL",
  timestamp: "1782753357257",
  transaction_hash: "0xabc",
};

export const TICK_SIZE_EVENT: Record<string, unknown> = {
  event_type: "tick_size_change",
  market: MARKET,
  asset_id: ASSET,
  old_tick_size: "0.01",
  new_tick_size: "0.001",
  timestamp: "1782753357257",
};

export const BEST_BID_ASK_EVENT: Record<string, unknown> = {
  event_type: "best_bid_ask",
  market: MARKET,
  asset_id: ASSET,
  best_bid: "0.41",
  best_ask: "0.43",
  spread: "0.02",
  timestamp: "1782753357257",
};

export const EVENT_MESSAGE: Record<string, unknown> = {
  id: "evt-1",
  ticker: "TICK",
  slug: "slug",
  title: "Title",
  description: "Description",
};

export const NEW_MARKET_EVENT: Record<string, unknown> = {
  event_type: "new_market",
  id: "mkt-1",
  question: "Will it?",
  market: MARKET,
  slug: "will-it",
  description: "a market",
  assets_ids: [ASSET],
  outcomes: ["Yes", "No"],
  event_message: EVENT_MESSAGE,
  timestamp: "1782753357257",
  tags: ["tag"],
  condition_id: MARKET,
  active: true,
  clob_token_ids: [ASSET],
  sports_market_type: "moneyline",
  line: "1.5",
  game_start_time: "1782753357257",
  order_price_min_tick_size: "0.01",
  group_item_title: "group",
  taker_base_fee: "0",
  fees_enabled: false,
  fee_schedule: { tier: "a" },
};

export const MARKET_RESOLVED_EVENT: Record<string, unknown> = {
  event_type: "market_resolved",
  id: "mkt-1",
  market: MARKET,
  assets_ids: [ASSET],
  winning_asset_id: ASSET,
  winning_outcome: "Yes",
  event_message: EVENT_MESSAGE,
  timestamp: "1782753357257",
  tags: ["tag"],
};

/** The REST body, with all ten declared keys present. */
export const ORDER_BOOK: Record<string, unknown> = {
  market: MARKET,
  asset_id: ASSET,
  timestamp: "1782753357257",
  hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  bids: [{ price: "0.01", size: "1" }],
  asks: [{ price: "0.99", size: "1" }],
  min_order_size: "5",
  tick_size: "0.01",
  neg_risk: false,
  last_trade_price: "0.090",
};

/** Every modelled market event, in the union's declaration order. */
export const MARKET_EVENT_FIXTURES: readonly (readonly [string, Record<string, unknown>])[] = [
  ["book", BOOK_EVENT],
  ["price_change", PRICE_CHANGE_EVENT],
  ["last_trade_price", LAST_TRADE_EVENT],
  ["tick_size_change", TICK_SIZE_EVENT],
  ["best_bid_ask", BEST_BID_ASK_EVENT],
  ["new_market", NEW_MARKET_EVENT],
  ["market_resolved", MARKET_RESOLVED_EVENT],
];

/**
 * A marked, type-plausible value for `key`, so an ADOPTION is visible in the
 * answer rather than inferred from a status.
 */
export function poisonFor(key: string, honest: unknown): unknown {
  if (key === "event_type") return honest;
  if (typeof honest === "string") return "POLLUTED";
  if (typeof honest === "boolean") return !honest;
  if (typeof honest === "number") return 424_242;
  if (Array.isArray(honest)) {
    const first: unknown = honest[0];
    if (first !== null && typeof first === "object") {
      return [{ ...(first as Record<string, unknown>), price: "0.77", size: "POLLUTED" }];
    }
    return ["POLLUTED"];
  }
  if (honest !== null && typeof honest === "object") {
    return { ...(honest as Record<string, unknown>), id: "POLLUTED" };
  }
  return "POLLUTED";
}
