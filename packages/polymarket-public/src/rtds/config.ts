/**
 * Endpoint, topics and tunables for the RTDS Chainlink TWAP feed (WP-100).
 *
 * Everything here is a **configuration snapshot with a source and an access
 * date**, not a constant (handoff §9.13, §1.2). Every value is overridable.
 *
 * ## What the venue documents
 *
 * Source: https://docs.polymarket.com/market-data/chainlink-twap (re-fetched
 * 2026-08-28 for this package; the frozen baseline is
 * `docs/venue/verified-2026-08-24.md` §10.3).
 *
 * - the RTDS address, `wss://ws-live-data.polymarket.com`, for clients that
 *   "need lower-level control" — this adapter is one, because F6 grants
 *   `@polymarket/client` exclusively to `packages/polymarket-secure`;
 * - exactly two TWAP topics, in a published table: 30 seconds →
 *   `crypto_prices_twap_thirty`, 60 seconds → `crypto_prices_twap_sixty`;
 * - the subscribe frame `{"action": "subscribe", "subscriptions": [{"topic":
 *   ..., "type": "update", "filters": "{\"symbol\":\"btc/usd\"}"}]}`, with
 *   `filters` OPTIONAL: "Omit it to receive every available symbol. If you need
 *   several symbols for one window, omit filters and filter updates by
 *   payload.symbol in your application";
 * - the heartbeat: "RTDS uses an application-level heartbeat. Send the text
 *   frame PING every 5 seconds to maintain the connection" — the CLIENT sends
 *   it, and no server reply is documented;
 * - "Subscriptions start with the next update. There is no snapshot, history,
 *   or replay after a disconnect" and "Direct clients must reconnect and
 *   resubscribe after a disconnect".
 *
 * ## What it does NOT document, and is therefore NOT assumed here
 *
 * - **RTDS-U1 — the publication cadence.** Verbatim: "The 30-second and
 *   60-second values are lookback windows, not publication cadences", and
 *   "never infer the window from update frequency". The page instead instructs
 *   the consumer to "define a freshness threshold and a fallback for report
 *   gaps". {@link DEFAULT_RTDS_TWAP_FEED_OPTIONS.updateStalenessMs} is
 *   therefore an OPERATOR POLICY, clearly labelled as such — it is not a venue
 *   fact, and this client does not treat a quiet feed as a dead socket by
 *   default (see {@link RtdsTwapFeedOptions.reconnectWhenStale}).
 * - **RTDS-U2 — any server-side heartbeat reply or timeout.** The page
 *   documents the client's `PING` and nothing coming back. This feed therefore
 *   never waits for a `PONG`, and a bare `PONG`/`PING` text frame is reported
 *   once per connection as an undocumented observation rather than being
 *   silently consumed as if the reply were specified.
 * - **RTDS-U3 — a dynamic unsubscribe or subscription-change action.** Only
 *   `"action": "subscribe"` is documented. The subscription set of a feed is
 *   therefore fixed at construction and re-sent on every (re)connect; a caller
 *   that needs a different set constructs a new feed. Inventing an
 *   `"unsubscribe"` action would be asserting venue behaviour nobody verified.
 * - **RTDS-U4 — the set of available symbols.** No enumeration is published
 *   ("Omit a symbol filter to receive every available pair"), so no symbol list
 *   is hard-coded and no inbound symbol is rejected for not being on one.
 *
 * ## Credentials
 *
 * There are none. RTDS "relays Chainlink-computed mainnet TWAP updates without
 * credentials"; the credentialed Chainlink Data Streams path described further
 * down the same page is deliberately NOT implemented here — no key, header,
 * signer or wallet is representable anywhere on this path.
 */

import { PublicMarketConfigurationError } from "../errors.js";

/** RTDS WebSocket address (accessed 2026-08-28). */
export const RTDS_WEBSOCKET_URL = "wss://ws-live-data.polymarket.com";

/** The two documented lookback windows, in seconds. */
export const RTDS_TWAP_WINDOWS = [30, 60] as const;

/** A lookback window the TWAP feed publishes. */
export type RtdsTwapWindowSeconds = (typeof RTDS_TWAP_WINDOWS)[number];

/** The published window → topic table. */
export const RTDS_TWAP_TOPIC_BY_WINDOW = {
  30: "crypto_prices_twap_thirty",
  60: "crypto_prices_twap_sixty",
} as const satisfies Record<RtdsTwapWindowSeconds, string>;

/** An RTDS topic this adapter models. */
export type RtdsTwapTopic = (typeof RTDS_TWAP_TOPIC_BY_WINDOW)[RtdsTwapWindowSeconds];

/** The inverse table, so a topic on the wire resolves to its window. */
export const RTDS_TWAP_WINDOW_BY_TOPIC = {
  crypto_prices_twap_thirty: 30,
  crypto_prices_twap_sixty: 60,
} as const satisfies Record<RtdsTwapTopic, RtdsTwapWindowSeconds>;

/** The documented subscription `action`. No other action is modelled (RTDS-U3). */
export const RTDS_SUBSCRIBE_ACTION = "subscribe";

/** The documented subscription and update `type`. */
export const RTDS_UPDATE_TYPE = "update";

/** `sourceChannel` for anything read from the RTDS socket. */
export const RTDS_CHANNEL = "rtds:crypto-twap-ws";

/**
 * `sourceChannel` for an update that reached the point of naming its topic.
 *
 * The topic IS the window (see {@link RTDS_TWAP_WINDOW_BY_TOPIC}), so putting it
 * in the channel makes the window explicit in the provenance chain as well as
 * in the payload (work-plan `WP-100` acceptance 1).
 */
export function rtdsTopicChannel(topic: string): string {
  return `rtds:${topic}`;
}

/** Documented client heartbeat: "Send the text frame PING every 5 seconds". */
export const RTDS_HEARTBEAT_INTERVAL_MS = 5_000;

/** The heartbeat frame is the literal text `PING`. */
export const RTDS_HEARTBEAT_REQUEST = "PING";

/**
 * The exact fixed-point scale of `full_accuracy_value`.
 *
 * Verbatim (accessed 2026-08-28): "full_accuracy_value is the exact signed E18
 * fixed-point value. Divide it by 10^18 with integer or decimal arithmetic. The
 * numeric value is provided only for display convenience."
 *
 * The frozen report §10.3 records `full_accuracy_value` as a "string integer"
 * and does NOT state the scale; the current page does. Recorded as drift D-1 in
 * `docs/handoffs/WP-100.md` — the report is not silently amended, and the
 * current official page controls the venue fact (`AGENTS.md` authority order).
 */
export const RTDS_TWAP_VALUE_SCALE_DECIMALS = 18;

/** `10 ** 18` as a canonical decimal string, for exact division. */
export const RTDS_TWAP_VALUE_DIVISOR = "1000000000000000000";

/** One window's subscription request. */
export interface RtdsTwapWindowSubscription {
  /** 30 or 60 — the only windows the feed publishes. */
  readonly windowSeconds: RtdsTwapWindowSeconds;
  /**
   * Symbols wanted for this window, lowercase and slash-delimited (`btc/usd`).
   *
   * The venue's own rule decides what goes on the wire, and this client follows
   * it exactly:
   *
   * - **absent or empty** → `filters` is OMITTED, which the page defines as
   *   "receive every available symbol";
   * - **exactly one** → `filters` carries the compact JSON form
   *   `{"symbol":"btc/usd"}`, "with one lowercase symbol and no spaces";
   * - **more than one** → `filters` is OMITTED, because the page says so:
   *   "If you need several symbols for one window, omit filters and filter
   *   updates by payload.symbol in your application."
   *
   * In the third case the socket really does deliver every symbol, and this
   * adapter PUBLISHES every one of them: dropping an update because the caller
   * did not name its symbol would be a silent drop of valid venue data (§8.3).
   * The "filter in your application" step belongs to the subscription planner
   * (`WP-120`), which knows which series it wants; `symbol` is explicit on every
   * event, so the filter is a one-line predicate there.
   */
  readonly symbols?: readonly string[];
}

/** Tunables for the RTDS TWAP feed. */
export interface RtdsTwapFeedOptions {
  /** RTDS address. Overridable for a local double. */
  readonly url: string;
  /** Stable feed id carried by every `Feed*` event (`CodeString`). */
  readonly feedId: string;
  /**
   * The windows and symbols this feed subscribes to on every (re)connect.
   *
   * Fixed for the lifetime of the feed: RTDS documents no dynamic subscription
   * change (RTDS-U3). At least one entry is required — a feed subscribing to
   * nothing would sit on an open socket forever, and would make the gap
   * bookkeeping ambiguous for no benefit.
   */
  readonly subscriptions: readonly RtdsTwapWindowSubscription[];
  /** Client `PING` cadence, in milliseconds. Documented as 5 000. */
  readonly heartbeatIntervalMs: number;
  /**
   * How long without a published TWAP update before `FeedStale` is emitted.
   *
   * **OPERATOR POLICY, NOT A VENUE FACT (RTDS-U1).** The publication cadence is
   * explicitly undocumented and the page tells the consumer to "define a
   * freshness threshold" of its own. The default below is a conservative
   * starting point, not a claim about how often the venue publishes.
   */
  readonly updateStalenessMs: number;
  /** How often the staleness watchdog runs. */
  readonly stalenessCheckIntervalMs: number;
  /**
   * Whether a stale feed is closed so the reconnect path runs.
   *
   * **Defaults to `false`, unlike the CLOB market feed**, and the difference is
   * a venue fact rather than a preference: the market channel has a documented
   * server `PONG`, so silence there means the socket is not demonstrably alive.
   * RTDS documents no reply at all (RTDS-U2) and no cadence (RTDS-U1), so
   * silence here is indistinguishable from a quiet market. Closing a healthy
   * socket on that evidence would be inferring a cadence the page forbids
   * inferring. `FeedStale` is emitted either way, because staleness is data.
   */
  readonly reconnectWhenStale: boolean;
  /** First reconnect backoff step, in milliseconds. */
  readonly reconnectBaseDelayMs: number;
  /** Ceiling on the reconnect backoff, in milliseconds. */
  readonly reconnectMaximumDelayMs: number;
  /**
   * How many recent observation instants are remembered per series, for
   * duplicate detection.
   *
   * Bounded on purpose: an unbounded memory of every observation the process
   * ever saw is a leak. The consequence of the bound is stated where it is
   * enforced (`./observations.ts`): a duplicate older than the window is no
   * longer recognized as one and is published as a late observation.
   */
  readonly duplicateWindowPerSeries: number;
  /**
   * How many `(topic, symbol)` series are tracked at once.
   *
   * Bounded because no symbol enumeration is published (RTDS-U4), so the key
   * space is untrusted. The consequence of the bound is stated where it is
   * enforced (`./observations.ts`): the least-recently-updated series is
   * evicted and counted, and a re-appearing series reports its next observation
   * as the first one this adapter instance knows of.
   */
  readonly maxTrackedSeries: number;
}

/**
 * Defaults.
 *
 * | Field | Value | Source |
 * | --- | --- | --- |
 * | `url` | `wss://ws-live-data.polymarket.com` | docs, accessed 2026-08-28 |
 * | `subscriptions` | both windows, no symbol filter | docs: "Omit it to receive every available symbol" |
 * | `heartbeatIntervalMs` | 5 000 | docs: "Send the text frame PING every 5 seconds" |
 * | `updateStalenessMs` | 60 000 | **operator policy** (RTDS-U1: cadence undocumented) |
 * | `stalenessCheckIntervalMs` | 5 000 | operator policy |
 * | `reconnectWhenStale` | `false` | RTDS-U1/U2 — see the field comment |
 * | `reconnectBaseDelayMs` | 250 | official SDK `RECONNECT_BASE_DELAY_MS` (CLOB), applied as policy |
 * | `reconnectMaximumDelayMs` | 30 000 | official SDK `RECONNECT_MAX_DELAY_MS` (CLOB), applied as policy |
 * | `duplicateWindowPerSeries` | 64 | this client's bound; no venue meaning |
 * | `maxTrackedSeries` | 256 | this client's bound; no venue meaning |
 *
 * The two reconnect constants are the CLOB SDK's, reused so this repository has
 * one backoff shape rather than two. Polymarket publishes no reconnect policy
 * for RTDS, so they are a policy choice here, not an RTDS venue fact.
 */
export const DEFAULT_RTDS_TWAP_FEED_OPTIONS = {
  url: RTDS_WEBSOCKET_URL,
  feedId: "polymarket-rtds-twap",
  subscriptions: [{ windowSeconds: 30 }, { windowSeconds: 60 }],
  heartbeatIntervalMs: RTDS_HEARTBEAT_INTERVAL_MS,
  updateStalenessMs: 60_000,
  stalenessCheckIntervalMs: 5_000,
  reconnectWhenStale: false,
  reconnectBaseDelayMs: 250,
  reconnectMaximumDelayMs: 30_000,
  duplicateWindowPerSeries: 64,
  maxTrackedSeries: 256,
} as const satisfies RtdsTwapFeedOptions;

const CODE_STRING_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;

/**
 * The form a symbol must take in an outbound `filters` value.
 *
 * Enforced on the REQUEST side only, and only because the page is explicit
 * about it: "filters must use the exact compact JSON form shown above, with one
 * lowercase symbol and no spaces". A malformed filter would silently subscribe
 * to nothing, which is the worst possible failure mode for a market-data feed.
 *
 * It is deliberately NOT applied to inbound `payload.symbol`: no symbol
 * enumeration or grammar is published for updates (RTDS-U4), so an inbound
 * symbol is validated against the domain's own bound and nothing else.
 */
const OUTBOUND_SYMBOL_PATTERN = /^[a-z0-9]+(?:\/[a-z0-9]+)+$/u;

/** Validates and completes a partial option set. Fails loudly at construction. */
export function resolveRtdsTwapFeedOptions(
  overrides: Partial<RtdsTwapFeedOptions> = {},
): RtdsTwapFeedOptions {
  const options: RtdsTwapFeedOptions = {
    ...DEFAULT_RTDS_TWAP_FEED_OPTIONS,
    ...overrides,
  };

  if (options.url.trim() === "") {
    throw new PublicMarketConfigurationError("the RTDS WebSocket url must not be empty");
  }
  if (!CODE_STRING_PATTERN.test(options.feedId) || options.feedId.length > 64) {
    throw new PublicMarketConfigurationError(
      "feedId must be a bounded alphanumeric code, because it is carried on every Feed* event",
      { feedId: options.feedId },
    );
  }
  requirePositive(options.heartbeatIntervalMs, "heartbeatIntervalMs");
  requirePositive(options.updateStalenessMs, "updateStalenessMs");
  requirePositive(options.stalenessCheckIntervalMs, "stalenessCheckIntervalMs");
  requirePositive(options.reconnectBaseDelayMs, "reconnectBaseDelayMs");
  requirePositive(options.reconnectMaximumDelayMs, "reconnectMaximumDelayMs");
  if (options.reconnectMaximumDelayMs < options.reconnectBaseDelayMs) {
    throw new PublicMarketConfigurationError(
      "reconnectMaximumDelayMs must be at least reconnectBaseDelayMs",
      {
        reconnectBaseDelayMs: options.reconnectBaseDelayMs,
        reconnectMaximumDelayMs: options.reconnectMaximumDelayMs,
      },
    );
  }
  if (
    !Number.isSafeInteger(options.duplicateWindowPerSeries) ||
    options.duplicateWindowPerSeries < 1
  ) {
    throw new PublicMarketConfigurationError(
      "duplicateWindowPerSeries must be a positive integer",
      { duplicateWindowPerSeries: options.duplicateWindowPerSeries },
    );
  }
  if (!Number.isSafeInteger(options.maxTrackedSeries) || options.maxTrackedSeries < 1) {
    throw new PublicMarketConfigurationError("maxTrackedSeries must be a positive integer", {
      maxTrackedSeries: options.maxTrackedSeries,
    });
  }
  validateSubscriptions(options.subscriptions);
  return options;
}

function validateSubscriptions(
  subscriptions: readonly RtdsTwapWindowSubscription[],
): void {
  if (subscriptions.length === 0) {
    throw new PublicMarketConfigurationError(
      "at least one window subscription is required; RTDS documents no dynamic subscription change (RTDS-U3), so an empty feed can never start receiving anything",
    );
  }
  const seen = new Set<number>();
  for (const subscription of subscriptions) {
    if (!isTwapWindow(subscription.windowSeconds)) {
      throw new PublicMarketConfigurationError(
        "windowSeconds must be 30 or 60; the feed publishes exactly two lookback windows",
        { windowSeconds: subscription.windowSeconds },
      );
    }
    if (seen.has(subscription.windowSeconds)) {
      throw new PublicMarketConfigurationError(
        "each window may be subscribed at most once; two entries for one window would send two frames for the same topic",
        { windowSeconds: subscription.windowSeconds },
      );
    }
    seen.add(subscription.windowSeconds);
    for (const symbol of subscription.symbols ?? []) {
      if (!OUTBOUND_SYMBOL_PATTERN.test(symbol)) {
        throw new PublicMarketConfigurationError(
          'a requested symbol must be lowercase and slash-delimited, such as "btc/usd"; the venue requires the exact compact filter form and a malformed one subscribes to nothing',
          { windowSeconds: subscription.windowSeconds, symbol },
        );
      }
    }
  }
}

/** Whether a number is one of the two published windows. */
export function isTwapWindow(value: number): value is RtdsTwapWindowSeconds {
  return (RTDS_TWAP_WINDOWS as readonly number[]).includes(value);
}

/** Whether a string is one of the two published topics. */
export function isTwapTopic(value: string): value is RtdsTwapTopic {
  return Object.hasOwn(RTDS_TWAP_WINDOW_BY_TOPIC, value);
}

function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PublicMarketConfigurationError(`${field} must be a positive number`, {
      [field]: value,
    });
  }
}
