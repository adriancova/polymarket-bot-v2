/**
 * WP-000 venue verification check catalog.
 *
 * Enumerates the venue facts that handoff SS1.2 requires re-verifying at the
 * start of every implementation phase, maps each to its section in the frozen
 * verification report and to the sanitized fixture files that cover it.
 *
 * `kind: "fixture"` checks are structurally validated against local fixture
 * files. `kind: "documented"` checks are facts recorded in the report that
 * have no meaningful local fixture (for example the SDK ruling); they are
 * never validated over the network by this tool.
 */

export const VERIFICATION_REPORT_PATH = "docs/venue/verified-2026-08-24.md";

export interface VenueCheck {
  readonly id: string;
  readonly title: string;
  readonly reportSection: string;
  readonly kind: "fixture" | "documented";
  /** Fixture paths relative to test/fixtures/venue. */
  readonly fixtures: readonly string[];
  /** Payload keys every example in each fixture must carry. */
  readonly requiredPayloadKeys: readonly string[];
}

export const VENUE_CHECKS: readonly VenueCheck[] = [
  {
    id: "sdk-and-runtime",
    title:
      "Unified SDK @polymarket/client on Node >=24; archived CLOB clients rejected",
    reportSection: "1",
    kind: "documented",
    fixtures: [],
    requiredPayloadKeys: [],
  },
  {
    id: "order-schemas-and-types",
    title:
      "Order request/response schemas; GTC/GTD/FOK/FAK and expiration rules; delayed responses",
    reportSection: "2",
    kind: "fixture",
    fixtures: ["orders/order-responses.json"],
    requiredPayloadKeys: [
      "success",
      "errorMsg",
      "orderID",
      "status",
      "makingAmount",
      "takingAmount",
      "transactionsHashes",
      "tradeIDs",
    ],
  },
  {
    id: "market-ws-book",
    title: "Market channel book snapshot",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/book-snapshot.json"],
    requiredPayloadKeys: [
      "event_type",
      "market",
      "asset_id",
      "timestamp",
      "bids",
      "asks",
    ],
  },
  {
    id: "market-ws-price-change",
    title:
      "Market channel price change (absolute-size zero-removal example is UNVERIFIED, conflict C-1)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/price-change.json"],
    requiredPayloadKeys: ["event_type", "market", "price_changes", "timestamp"],
  },
  {
    id: "market-ws-tick-size",
    title: "Market channel tick-size change (dynamic tick size)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/tick-size-change.json"],
    requiredPayloadKeys: [
      "event_type",
      "market",
      "asset_id",
      "old_tick_size",
      "new_tick_size",
      "timestamp",
    ],
  },
  {
    id: "market-ws-last-trade",
    title: "Market channel last trade price",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/last-trade-price.json"],
    requiredPayloadKeys: [
      "event_type",
      "market",
      "asset_id",
      "price",
      "size",
      "side",
      "timestamp",
    ],
  },
  {
    id: "market-ws-best-bid-ask",
    title: "Market channel best bid/ask (enhanced)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/best-bid-ask.json"],
    requiredPayloadKeys: [
      "event_type",
      "market",
      "asset_id",
      "best_bid",
      "best_ask",
      "timestamp",
    ],
  },
  {
    id: "market-ws-lifecycle",
    title: "Market channel lifecycle events (new_market, market_resolved)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/lifecycle.json"],
    requiredPayloadKeys: ["event_type", "market", "assets_ids", "timestamp"],
  },
  {
    id: "user-ws-order-lifecycle",
    title:
      "User channel order lifecycle (PLACEMENT/UPDATE/CANCELLATION; LIVE/MATCHED/DELAYED/UNMATCHED/CANCELED)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["user-ws/order-lifecycle.json"],
    requiredPayloadKeys: [
      "event_type",
      "type",
      "id",
      "owner",
      "market",
      "asset_id",
      "side",
      "original_size",
      "size_matched",
      "price",
      "status",
      "timestamp",
    ],
  },
  {
    id: "user-ws-trade-settlement",
    title:
      "User channel trade settlement states (MATCHED/MINED/CONFIRMED/RETRYING/FAILED)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["user-ws/trade-settlement.json"],
    requiredPayloadKeys: [
      "event_type",
      "id",
      "taker_order_id",
      "market",
      "asset_id",
      "side",
      "size",
      "price",
      "status",
      "maker_orders",
      "trader_side",
      "timestamp",
    ],
  },
  {
    id: "heartbeat",
    title: "Order heartbeat protocol (POST /v1/heartbeats, 5s cadence, 10s timeout)",
    reportSection: "5",
    kind: "fixture",
    fixtures: ["heartbeat/heartbeat.json"],
    requiredPayloadKeys: ["heartbeat_id"],
  },
  {
    id: "fees-and-rewards",
    title: "Fee and reward parameter snapshots (taker fees, maker/taker rebates, liquidity rewards)",
    reportSection: "6",
    kind: "fixture",
    fixtures: ["fees/fee-reward-parameters.json"],
    requiredPayloadKeys: ["effective_date"],
  },
  {
    id: "per-market-parameters",
    title:
      "Per-market trading parameters (dynamic tick size, min size, negRisk, secondsDelay)",
    reportSection: "7",
    kind: "documented",
    fixtures: [],
    requiredPayloadKeys: [],
  },
  {
    id: "rate-limits",
    title: "IP and per-signer rate limits as configuration snapshots",
    reportSection: "8",
    kind: "fixture",
    fixtures: ["rate-limits/rate-limits.json"],
    requiredPayloadKeys: [],
  },
  {
    id: "restricted-modes",
    title: "Matching-engine restricted modes (HTTP 425 restart, cancel-only, post-only)",
    reportSection: "9",
    kind: "fixture",
    fixtures: ["orders/restricted-modes.json"],
    requiredPayloadKeys: ["http_status", "body"],
  },
  {
    id: "geoblock",
    title: "Geographic restriction check responses",
    reportSection: "10.1",
    kind: "fixture",
    fixtures: ["geoblock/geoblock.json"],
    requiredPayloadKeys: ["blocked", "ip", "country", "region"],
  },
  {
    id: "position-operations",
    title: "CTF split/merge/redeem workflows and position-id derivation",
    reportSection: "10.2",
    kind: "fixture",
    fixtures: ["positions/split-merge-redeem.json"],
    requiredPayloadKeys: ["operation", "description"],
  },
  {
    id: "chainlink-twap-rtds",
    title: "Chainlink TWAP over RTDS (30s/60s windows, no replay after disconnect)",
    reportSection: "10.3",
    kind: "fixture",
    fixtures: ["rtds/twap-update.json"],
    requiredPayloadKeys: [],
  },
] as const;
