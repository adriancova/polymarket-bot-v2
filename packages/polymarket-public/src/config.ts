/**
 * Endpoints and tunables for the public market feed.
 *
 * Everything here is a **configuration snapshot with a source and an access
 * date**, not a constant (handoff §9.13, §1.2). Endpoints and cadences are
 * re-verified at each phase gate; a caller may override every one of them.
 *
 * ## What is documented, and what is not
 *
 * Documented (https://docs.polymarket.com/api-reference/wss/market.md and
 * https://docs.polymarket.com/market-data/realtime-data, both accessed
 * 2026-08-27):
 *
 * - the market WebSocket address, `wss://ws-subscriptions-clob.polymarket.com/ws/market`;
 * - the subscribe frame `{"assets_ids": [...], "type": "market"}`, the optional
 *   `custom_feature_enabled`, `initial_dump` (default `true`) and `level`
 *   (`1 | 2 | 3`, default `2`) fields, and the dynamic
 *   `{"operation": "subscribe" | "unsubscribe", "assets_ids": [...]}` frames;
 * - the application-level heartbeat: "Send PING every 10 seconds to keep the
 *   connection alive", to which the server replies `PONG`;
 * - the REST book reads `GET /book?token_id=…` and `POST /books`, the latter
 *   with a documented "Maximum 500 items per request".
 *
 * NOT documented, and therefore NOT assumed here:
 *
 * - **U-2 — what the server does when the client misses a `PING`.** No timeout
 *   and no close code is published. This client therefore detects staleness on
 *   its OWN side and says so, rather than modelling a server rule it cannot
 *   see. {@link DEFAULT_PUBLIC_MARKET_FEED_OPTIONS.pongTimeoutMs} is the
 *   official SDK's own client-side threshold (`CLOB_HEARTBEAT_STALE_MS`,
 *   30 000 ms, at the pinned commit) — evidence of what the SDK considers a
 *   dead connection, not evidence of a server behaviour.
 * - **U-3 — the maximum `assets_ids` per subscription.** No limit is published.
 *   {@link PublicMarketFeedOptions.maximumAssetsPerSubscriptionFrame} is
 *   therefore `undefined` by default: this client imposes no limit of its own,
 *   and it does not claim that none exists. An operator who learns the real
 *   bound sets it; the subscription manager chunks accordingly.
 */

import { PublicMarketConfigurationError } from "./errors.js";

/** Public market WebSocket address (accessed 2026-08-27). */
export const POLYMARKET_MARKET_WEBSOCKET_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/** Public CLOB REST origin serving `/book` and `/books` (accessed 2026-08-27). */
export const POLYMARKET_CLOB_REST_BASE_URL = "https://clob.polymarket.com";

/** `sourceChannel` for events read from the market WebSocket. */
export const MARKET_WEBSOCKET_CHANNEL = "polymarket:market-ws";

/** `sourceChannel` for events built from a REST book read. */
export const CLOB_BOOK_REST_CHANNEL = "polymarket:clob-book-rest";

/** Documented client heartbeat cadence: "Send PING every 10 seconds". */
export const MARKET_HEARTBEAT_INTERVAL_MS = 10_000;

/** The heartbeat frame is the literal text `PING`; the server replies `PONG`. */
export const MARKET_HEARTBEAT_REQUEST = "PING";
export const MARKET_HEARTBEAT_RESPONSE = "PONG";

/**
 * Documented batch bound: "Maximum 500 items per request" for `POST /books`.
 *
 * Unlike U-3 this one IS published, so it is enforced rather than left open.
 */
export const MAXIMUM_BOOKS_PER_BATCH_REQUEST = 500;

/** Tunables for the market feed. Every field has a documented or cited default. */
export interface PublicMarketFeedOptions {
  /** WebSocket address. Overridable for a staging endpoint or a local double. */
  readonly url: string;
  /** Stable feed id carried by every `Feed*` event (`CodeString`). */
  readonly feedId: string;
  /** Client `PING` cadence, in milliseconds. */
  readonly heartbeatIntervalMs: number;
  /**
   * How long without a `PONG` before the feed is reported stale.
   *
   * Client-side only — see the U-2 note in this module's header.
   */
  readonly pongTimeoutMs: number;
  /** How often the staleness watchdog runs. */
  readonly stalenessCheckIntervalMs: number;
  /**
   * Whether a stale connection is closed so the reconnect path runs.
   *
   * Default `true`, matching the SDK's own watchdog, which closes the socket
   * and "let[s] the normal close path reconnect and resubscribe active
   * handles". A caller that wants staleness reported but not acted on sets
   * `false`; the `FeedStale` event is emitted either way, because staleness is
   * surfaced as data.
   */
  readonly reconnectWhenStale: boolean;
  /** First reconnect backoff step, in milliseconds. */
  readonly reconnectBaseDelayMs: number;
  /** Ceiling on the reconnect backoff, in milliseconds. */
  readonly reconnectMaximumDelayMs: number;
  /**
   * Client-imposed cap on `assets_ids` per subscription frame.
   *
   * `undefined` means "no cap", which is NOT a claim that the venue has none —
   * see the U-3 note in this module's header.
   */
  readonly maximumAssetsPerSubscriptionFrame?: number;
  /**
   * Request `best_bid_ask`, `new_market` and `market_resolved` by sending
   * `custom_feature_enabled: true`.
   */
  readonly customFeatureEnabled: boolean;
  /**
   * Ask the server for an initial book snapshot on subscribe.
   *
   * Documented as defaulting to `true` server-side. It is sent explicitly so
   * the behaviour does not depend on a server default that may change, and it
   * stays `true` because a feed that starts without a snapshot has nothing
   * authoritative to apply its first price change to (§9.4).
   */
  readonly initialDump: boolean;
}

/**
 * Defaults, each traceable to a documented value or a cited SDK constant.
 *
 * | Field | Value | Source |
 * | --- | --- | --- |
 * | `heartbeatIntervalMs` | 10 000 | docs: "Send PING every 10 seconds" |
 * | `pongTimeoutMs` | 30 000 | SDK `CLOB_HEARTBEAT_STALE_MS` at the pinned commit |
 * | `stalenessCheckIntervalMs` | 5 000 | SDK `HEARTBEAT_WATCHDOG_INTERVAL_MS` |
 * | `reconnectBaseDelayMs` | 250 | SDK `RECONNECT_BASE_DELAY_MS` |
 * | `reconnectMaximumDelayMs` | 30 000 | SDK `RECONNECT_MAX_DELAY_MS` |
 * | `initialDump` | `true` | docs: "Defaults to true" |
 */
export const DEFAULT_PUBLIC_MARKET_FEED_OPTIONS = {
  url: POLYMARKET_MARKET_WEBSOCKET_URL,
  feedId: "polymarket-market",
  heartbeatIntervalMs: MARKET_HEARTBEAT_INTERVAL_MS,
  pongTimeoutMs: 30_000,
  stalenessCheckIntervalMs: 5_000,
  reconnectWhenStale: true,
  reconnectBaseDelayMs: 250,
  reconnectMaximumDelayMs: 30_000,
  customFeatureEnabled: false,
  initialDump: true,
} as const satisfies PublicMarketFeedOptions;

const CODE_STRING_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;

/**
 * Validates and completes a partial option set.
 *
 * Fails loudly at construction rather than at the first heartbeat: a
 * non-positive interval or an empty endpoint is a deployment error, and a feed
 * that starts with one and misbehaves an hour later is far harder to diagnose.
 */
export function resolvePublicMarketFeedOptions(
  overrides: Partial<PublicMarketFeedOptions> = {},
): PublicMarketFeedOptions {
  const options: PublicMarketFeedOptions = {
    ...DEFAULT_PUBLIC_MARKET_FEED_OPTIONS,
    ...overrides,
  };

  if (options.url.trim() === "") {
    throw new PublicMarketConfigurationError("the market WebSocket url must not be empty");
  }
  if (!CODE_STRING_PATTERN.test(options.feedId) || options.feedId.length > 64) {
    throw new PublicMarketConfigurationError(
      "feedId must be a bounded alphanumeric code, because it is carried on every Feed* event",
      { feedId: options.feedId },
    );
  }
  requirePositive(options.heartbeatIntervalMs, "heartbeatIntervalMs");
  requirePositive(options.pongTimeoutMs, "pongTimeoutMs");
  requirePositive(options.stalenessCheckIntervalMs, "stalenessCheckIntervalMs");
  requirePositive(options.reconnectBaseDelayMs, "reconnectBaseDelayMs");
  requirePositive(options.reconnectMaximumDelayMs, "reconnectMaximumDelayMs");

  if (options.pongTimeoutMs <= options.heartbeatIntervalMs) {
    throw new PublicMarketConfigurationError(
      "pongTimeoutMs must exceed heartbeatIntervalMs, or the feed reports itself stale between two heartbeats",
      {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        pongTimeoutMs: options.pongTimeoutMs,
      },
    );
  }
  if (options.reconnectMaximumDelayMs < options.reconnectBaseDelayMs) {
    throw new PublicMarketConfigurationError(
      "reconnectMaximumDelayMs must be at least reconnectBaseDelayMs",
      {
        reconnectBaseDelayMs: options.reconnectBaseDelayMs,
        reconnectMaximumDelayMs: options.reconnectMaximumDelayMs,
      },
    );
  }
  const cap = options.maximumAssetsPerSubscriptionFrame;
  if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1)) {
    throw new PublicMarketConfigurationError(
      "maximumAssetsPerSubscriptionFrame must be a positive integer when set; leave it unset to impose no client-side cap (venue item U-3)",
      { maximumAssetsPerSubscriptionFrame: cap },
    );
  }
  return options;
}

function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PublicMarketConfigurationError(`${field} must be a positive number`, {
      [field]: value,
    });
  }
}
