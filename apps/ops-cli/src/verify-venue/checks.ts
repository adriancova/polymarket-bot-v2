/**
 * WP-000 venue verification check catalog.
 *
 * Enumerates the venue facts that handoff SS1.2 requires re-verifying at the
 * start of every implementation phase, maps each to its section in the frozen
 * verification report and to the sanitized fixture files that cover it, and
 * declares a source-specific, recursively nested payload schema per fixture.
 *
 * Raw wire schemas follow the official unified SDK bindings
 * (github.com/Polymarket/ts-sdk, packages/bindings/src, reference commit
 * 7fdbed42484b5d279c71aa36d3757d18968260da, retrieved 2026-08-24).
 *
 * `kind: "fixture"` checks are structurally validated against local fixture
 * files. `kind: "documented"` checks have no meaningful local fixture (for
 * example the SDK ruling); they are validated against the frozen report file
 * (section presence WITH official evidence) and are reported as DOCUMENTED,
 * never as vacuous PASS.
 */
import type { FieldSpec, PayloadSchema } from "./fixtures.js";

export const VERIFICATION_REPORT_PATH = "docs/venue/verified-2026-08-24.md";

/** Official SDK reference commit the raw schemas were verified against. */
export const SDK_REFERENCE_COMMIT =
  "7fdbed42484b5d279c71aa36d3757d18968260da";

export interface VenueCheck {
  readonly id: string;
  readonly title: string;
  readonly reportSection: string;
  readonly kind: "fixture" | "documented";
  /** Fixture paths relative to test/fixtures/venue. */
  readonly fixtures: readonly string[];
  /** Source-specific payload schema every example in each fixture must meet. */
  readonly payloadSchema: PayloadSchema;
}

const SIDE = ["BUY", "SELL"] as const;

/** Book level: {price, size} with canonical decimal strings, price in [0,1]. */
const BOOK_LEVEL: FieldSpec = {
  type: "array",
  items: {
    type: "object",
    fields: {
      price: { type: "price-string" },
      size: { type: "decimal-string" },
    },
  },
};

/**
 * Raw user-channel trade maker order, per the official SDK
 * TradeMakerOrderSchema (packages/bindings/src/subscriptions/clob.ts at the
 * reference commit): order_id, owner, matched_amount, price, asset_id, side
 * required; maker_address, fee_rate_bps, outcome, outcome_index nullish.
 */
const TRADE_MAKER_ORDER: FieldSpec = {
  type: "object",
  fields: {
    order_id: { type: "string" },
    owner: { type: "string" },
    maker_address: { type: "string", optional: true },
    matched_amount: { type: "decimal-string" },
    price: { type: "price-string" },
    fee_rate_bps: { type: "decimal-string", optional: true },
    asset_id: { type: "string" },
    outcome: { type: "string", optional: true },
    outcome_index: { type: "number", optional: true },
    side: { type: "string", enum: SIDE },
  },
};

/**
 * User-channel wire statuses serialize as plain values (SDK shared.ts:
 * REST endpoints serialize the prefixed constants while the user websocket
 * channel serializes plain values). MatchedNotBroadcasted appears only on
 * REST trades, not on user-stream events (SDK TradeStatus note; conflict
 * C-3 in the report).
 */
const USER_STREAM_TRADE_STATUS = [
  "MATCHED",
  "MINED",
  "CONFIRMED",
  "RETRYING",
  "FAILED",
] as const;

const REST_TRADE_STATUS = [
  "TRADE_STATUS_MATCHED_NOT_BROADCASTED",
  "TRADE_STATUS_MATCHED",
  "TRADE_STATUS_MINED",
  "TRADE_STATUS_CONFIRMED",
  "TRADE_STATUS_RETRYING",
  "TRADE_STATUS_FAILED",
] as const;

export const VENUE_CHECKS: readonly VenueCheck[] = [
  {
    id: "sdk-and-runtime",
    title:
      "Unified SDK @polymarket/client on Node >=24; archived CLOB clients rejected",
    reportSection: "1",
    kind: "documented",
    fixtures: [],
    payloadSchema: {},
  },
  {
    id: "order-schemas-and-types",
    title:
      "Order request/response schemas; GTC/GTD/FOK/FAK and expiration rules; delayed responses",
    reportSection: "2",
    kind: "fixture",
    fixtures: ["orders/order-responses.json"],
    payloadSchema: {
      success: { type: "boolean" },
      errorMsg: { type: "string" },
      orderID: { type: "string" },
      status: {
        type: "string",
        enum: ["live", "matched", "delayed", "unmatched", ""],
      },
      makingAmount: { type: "string" },
      takingAmount: { type: "string" },
      transactionsHashes: {
        type: "array",
        optional: true,
        items: { type: "string" },
      },
      tradeIDs: { type: "array", optional: true, items: { type: "string" } },
    },
  },
  {
    id: "market-ws-book",
    title: "Market channel book snapshot",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/book-snapshot.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["book"] },
      market: { type: "string" },
      asset_id: { type: "string" },
      timestamp: { type: "string" },
      hash: { type: "string", optional: true },
      bids: BOOK_LEVEL,
      asks: BOOK_LEVEL,
    },
  },
  {
    id: "market-ws-price-change",
    title:
      "Market channel price change (absolute-size zero-removal example is UNVERIFIED, conflict C-1)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/price-change.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["price_change"] },
      market: { type: "string" },
      price_changes: {
        type: "array",
        items: {
          type: "object",
          fields: {
            asset_id: { type: "string" },
            price: { type: "price-string" },
            size: { type: "decimal-string" },
            side: { type: "string", enum: SIDE },
            hash: { type: "string", optional: true },
            best_bid: { type: "price-string", optional: true },
            best_ask: { type: "price-string", optional: true },
          },
        },
      },
      timestamp: { type: "string" },
    },
  },
  {
    id: "market-ws-tick-size",
    title: "Market channel tick-size change (dynamic tick size)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/tick-size-change.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["tick_size_change"] },
      market: { type: "string" },
      asset_id: { type: "string" },
      old_tick_size: { type: "price-string" },
      new_tick_size: { type: "price-string" },
      timestamp: { type: "string" },
    },
  },
  {
    id: "market-ws-last-trade",
    title: "Market channel last trade price",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/last-trade-price.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["last_trade_price"] },
      market: { type: "string" },
      asset_id: { type: "string" },
      price: { type: "price-string" },
      size: { type: "decimal-string" },
      fee_rate_bps: { type: "decimal-string", optional: true },
      side: { type: "string", enum: SIDE },
      timestamp: { type: "string" },
      transaction_hash: { type: "string", optional: true },
    },
  },
  {
    id: "market-ws-best-bid-ask",
    title: "Market channel best bid/ask (enhanced)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/best-bid-ask.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["best_bid_ask"] },
      market: { type: "string" },
      asset_id: { type: "string" },
      best_bid: { type: "price-string" },
      best_ask: { type: "price-string" },
      spread: { type: "price-string", optional: true },
      timestamp: { type: "string" },
    },
  },
  {
    id: "market-ws-lifecycle",
    title: "Market channel lifecycle events (new_market, market_resolved)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/lifecycle.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["new_market", "market_resolved"] },
      market: { type: "string" },
      assets_ids: { type: "array", items: { type: "string" } },
      timestamp: { type: "string" },
    },
  },
  {
    id: "user-ws-order-lifecycle",
    title:
      "User channel order lifecycle (PLACEMENT/UPDATE/CANCELLATION; LIVE/MATCHED/DELAYED/UNMATCHED/CANCELED)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["user-ws/order-lifecycle.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["order"] },
      type: { type: "string", enum: ["PLACEMENT", "UPDATE", "CANCELLATION"] },
      id: { type: "string" },
      owner: { type: "string" },
      market: { type: "string" },
      asset_id: { type: "string" },
      side: { type: "string", enum: SIDE },
      original_size: { type: "decimal-string" },
      size_matched: { type: "decimal-string" },
      price: { type: "price-string" },
      outcome: { type: "string", optional: true },
      status: {
        type: "string",
        enum: ["LIVE", "MATCHED", "DELAYED", "UNMATCHED", "CANCELED"],
        optional: true,
      },
      timestamp: { type: "string" },
    },
  },
  {
    id: "user-ws-trade-settlement",
    title:
      "User channel RAW trade events per official SDK UserTradeEventSchema (plain wire statuses; MATCHED_NOT_BROADCASTED is REST-only, C-3)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["user-ws/trade-settlement.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["trade"] },
      type: { type: "string", enum: ["TRADE"] },
      id: { type: "string" },
      taker_order_id: { type: "string" },
      market: { type: "string" },
      asset_id: { type: "string" },
      side: { type: "string", enum: SIDE },
      size: { type: "decimal-string" },
      fee_rate_bps: { type: "decimal-string", optional: true },
      price: { type: "price-string" },
      status: { type: "string", enum: USER_STREAM_TRADE_STATUS },
      match_time: { type: "string", optional: true },
      last_update: { type: "string", optional: true },
      outcome: { type: "string", optional: true },
      owner: { type: "string" },
      trade_owner: { type: "string", optional: true },
      maker_address: { type: "string", optional: true },
      transaction_hash: { type: "string", optional: true },
      bucket_index: { type: "number", optional: true },
      maker_orders: { type: "array", optional: true, items: TRADE_MAKER_ORDER },
      trader_side: { type: "string", enum: ["TAKER", "MAKER"], optional: true },
      timestamp: { type: "string" },
    },
  },
  {
    id: "rest-trade-settlement",
    title:
      "REST trade reads with prefixed TRADE_STATUS_* constants incl. MATCHED_NOT_BROADCASTED (REST-only per SDK, C-3)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["orders/rest-trades.json"],
    payloadSchema: {
      id: { type: "string" },
      taker_order_id: { type: "string", optional: true },
      market: { type: "string" },
      asset_id: { type: "string" },
      side: { type: "string", enum: SIDE },
      size: { type: "decimal-string" },
      price: { type: "price-string" },
      status: { type: "string", enum: REST_TRADE_STATUS },
      owner: { type: "string" },
      maker_orders: { type: "array", optional: true, items: TRADE_MAKER_ORDER },
      trader_side: { type: "string", enum: ["TAKER", "MAKER"], optional: true },
      transaction_hash: { type: "string", optional: true },
    },
  },
  {
    id: "heartbeat",
    title:
      "Order heartbeat protocol (POST /v1/heartbeats; empty-ID bootstrap; ID rotation; 5s cadence, 10s timeout)",
    reportSection: "5",
    kind: "fixture",
    fixtures: ["heartbeat/heartbeat.json"],
    payloadSchema: {
      heartbeat_id: { type: "string" },
      error_msg: { type: "string", optional: true },
    },
  },
  {
    id: "fees-and-rewards",
    title:
      "Fee and reward parameter snapshots (taker fees, maker/taker rebates, liquidity rewards)",
    reportSection: "6",
    kind: "fixture",
    fixtures: ["fees/fee-reward-parameters.json"],
    payloadSchema: {
      effective_date: { type: "string" },
    },
  },
  {
    id: "per-market-parameters",
    title:
      "Per-market trading parameters (dynamic tick size, min size, negRisk, secondsDelay)",
    reportSection: "7",
    kind: "documented",
    fixtures: [],
    payloadSchema: {},
  },
  {
    id: "rate-limits",
    title: "IP and per-signer rate limits as configuration snapshots",
    reportSection: "8",
    kind: "fixture",
    fixtures: ["rate-limits/rate-limits.json"],
    payloadSchema: {
      headers: { type: "object", optional: true },
      effective_date: { type: "string", optional: true },
      tiers: {
        type: "array",
        optional: true,
        items: {
          type: "object",
          fields: {
            tier: { type: "string" },
            volume_30d_usd: { type: "decimal-string" },
            order_tokens_per_s: { type: "number" },
            order_burst: { type: "number" },
            cancel_tokens_per_s: { type: "number" },
            cancel_burst: { type: "number" },
          },
        },
      },
      limits_per_10s: { type: "object", optional: true },
      trading_dual_limits: { type: "object", optional: true },
    },
  },
  {
    id: "restricted-modes",
    title:
      "Matching-engine restricted modes (HTTP 425 restart, cancel-only, post-only)",
    reportSection: "9",
    kind: "fixture",
    fixtures: ["orders/restricted-modes.json"],
    payloadSchema: {
      http_status: { type: "number" },
      headers: { type: "object", optional: true },
      body: {
        type: "object",
        optional: true,
        fields: {
          error: { type: "string" },
          code: { type: "string", optional: true },
          retry_after_seconds: { type: "number", optional: true },
        },
      },
    },
  },
  {
    id: "geoblock",
    title: "Geographic restriction check responses",
    reportSection: "10.1",
    kind: "fixture",
    fixtures: ["geoblock/geoblock.json"],
    payloadSchema: {
      blocked: { type: "boolean" },
      ip: { type: "string" },
      country: { type: "string" },
      region: { type: "string" },
    },
  },
  {
    id: "position-operations",
    title:
      "CTF split/merge/redeem workflows, contract addresses, and position-id derivation",
    reportSection: "10.2",
    kind: "fixture",
    fixtures: ["positions/split-merge-redeem.json"],
    payloadSchema: {
      operation: {
        type: "string",
        enum: [
          "contract-addresses",
          "split",
          "merge",
          "redeem",
          "derive-position-id",
          "neg-risk-convert",
        ],
      },
      description: { type: "string" },
      contracts: { type: "object", optional: true },
      request: {
        type: "object",
        optional: true,
        fields: {
          collateralToken: { type: "string" },
          parentCollectionId: { type: "string" },
          conditionId: { type: "string" },
          partition: { type: "array", optional: true, items: { type: "number" } },
          indexSets: { type: "array", optional: true, items: { type: "number" } },
          amount: { type: "decimal-string", optional: true },
        },
      },
      transaction_outcome: {
        type: "object",
        optional: true,
        fields: {
          transactionHash: { type: "string" },
          transactionId: { type: "string" },
        },
      },
    },
  },
  {
    id: "chainlink-twap-rtds",
    title:
      "Chainlink TWAP over RTDS (30s/60s windows, no replay after disconnect)",
    reportSection: "10.3",
    kind: "fixture",
    fixtures: ["rtds/twap-update.json"],
    payloadSchema: {
      action: { type: "string", enum: ["subscribe"], optional: true },
      topic: {
        type: "string",
        enum: ["crypto_prices_twap_thirty", "crypto_prices_twap_sixty"],
        optional: true,
      },
      type: { type: "string", enum: ["update"], optional: true },
      payload: {
        type: "object",
        optional: true,
        fields: {
          symbol: { type: "string" },
          value: { type: "number" },
          full_accuracy_value: { type: "decimal-string" },
          timestamp: { type: "number" },
          window_s: { type: "number" },
        },
      },
    },
  },
] as const;
