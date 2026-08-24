/**
 * WP-000 venue verification check catalog.
 *
 * Enumerates the venue facts that handoff SS1.2 requires re-verifying at the
 * start of every implementation phase, maps each to its section in the frozen
 * verification report and to the sanitized fixture files that cover it, and
 * declares a source-specific payload schema per fixture.
 *
 * `kind: "fixture"` checks are structurally validated against local fixture
 * files. `kind: "documented"` checks have no meaningful local fixture (for
 * example the SDK ruling); they are validated against the frozen report file
 * (section presence) and are reported as DOCUMENTED, never as vacuous PASS.
 */
import type { PayloadSchema } from "./fixtures.js";

export const VERIFICATION_REPORT_PATH = "docs/venue/verified-2026-08-24.md";

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
      transactionsHashes: { type: "array", optional: true },
      tradeIDs: { type: "array", optional: true },
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
      bids: { type: "array" },
      asks: { type: "array" },
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
      price_changes: { type: "array" },
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
      old_tick_size: { type: "decimal-string" },
      new_tick_size: { type: "decimal-string" },
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
      price: { type: "decimal-string" },
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
      best_bid: { type: "decimal-string" },
      best_ask: { type: "decimal-string" },
      spread: { type: "decimal-string", optional: true },
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
      assets_ids: { type: "array" },
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
      price: { type: "decimal-string" },
      outcome: { type: "string" },
      status: {
        type: "string",
        enum: ["LIVE", "MATCHED", "DELAYED", "UNMATCHED", "CANCELED"],
      },
      timestamp: { type: "string" },
    },
  },
  {
    id: "user-ws-trade-settlement",
    title:
      "User channel trade settlement states (MATCHED_NOT_BROADCASTED/MATCHED/MINED/CONFIRMED/RETRYING/FAILED)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["user-ws/trade-settlement.json"],
    payloadSchema: {
      event_type: { type: "string", enum: ["trade"] },
      id: { type: "string" },
      taker_order_id: { type: "string" },
      market: { type: "string" },
      asset_id: { type: "string" },
      side: { type: "string", enum: SIDE },
      size: { type: "decimal-string" },
      price: { type: "decimal-string" },
      status: {
        type: "string",
        enum: [
          "MATCHED_NOT_BROADCASTED",
          "MATCHED",
          "MINED",
          "CONFIRMED",
          "RETRYING",
          "FAILED",
        ],
      },
      maker_orders: { type: "array" },
      trader_side: { type: "string", enum: ["TAKER", "MAKER"] },
      timestamp: { type: "string" },
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
      tiers: { type: "array", optional: true },
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
      body: { type: "object", optional: true },
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
      payload: { type: "object", optional: true },
    },
  },
] as const;
