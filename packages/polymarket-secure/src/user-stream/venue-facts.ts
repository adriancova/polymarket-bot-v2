/**
 * The venue facts the user-stream adapter (WP-280) is built on, each with its
 * source. Nothing here is invented: where the venue documents nothing, the
 * constant is marked as a CLIENT CHOICE and says whose choice it copies.
 *
 * Sources (all recorded in the dated verification reports; this package makes
 * no network fetch):
 *
 * - `docs/venue/verified-2026-09-30.md` §4 and §W.4 (the user channel is
 *   UNCHANGED since VENUE-2), §11 (conflict C-3), §12 (U-2);
 * - `docs/venue/verified-2026-09-16.md` §4 (the verbatim user-channel
 *   statements S-D15/S-D16, the reconnect guidance, the C-3 evidence) and §6
 *   (fees);
 * - `docs/venue/verified-2026-08-24.md` §4 (the raw SDK wire schemas
 *   `UserOrderEventSchema` / `UserTradeEventSchema`, the wire value types);
 * - the pinned SDK `@polymarket/client` 0.11.0 and its `@polymarket/bindings`
 *   0.11.0 (`subscriptions/clob.ts`, `shared.ts`, read from the installed
 *   package's source maps), which the reports record as byte-identical to the
 *   2026-09-16 bodies (`verified-2026-09-30.md` §4);
 * - `docs/adr/ADR-002-event-envelope-and-ordering-semantics.md` (an adapter
 *   must accept either trade-status spelling on either layer, and must treat
 *   an unrecognized enumerated value as first-class UNKNOWN).
 */

/**
 * The authenticated user channel (`verified-2026-09-30.md` §W.4). THIS PACKAGE
 * NEVER DIALS IT: the channel is reached only through an injected
 * {@link AuthenticatedUserSocketPort}, and no binding of that port to a real
 * socket exists in the repository (PAPER only).
 */
export const USER_CHANNEL_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user" as const;

/**
 * "Send the text frame `PING` every 10 seconds; the server replies with
 * `PONG`." (S-D16 lines 346–348; S-D15 lines 206–250; `verified-2026-09-16.md` §4).
 */
export const PING_INTERVAL_MS = 10_000;
export const PING_FRAME = "PING" as const;
export const PONG_FRAME = "PONG" as const;

/**
 * CLIENT CHOICE, not a venue fact. The venue does not document what the
 * server does when a `PING` goes unanswered (register item U-2, still
 * undocumented, `verified-2026-09-30.md` §12, §W.5). This default copies the
 * pinned SDK's own client-side choice, `CLOB_HEARTBEAT_STALE_MS = 30_000`
 * (`websockets/heartbeat.ts`), which the report records as "a client-side
 * choice". It is configurable.
 */
export const DEFAULT_STALE_AFTER_MS = 30_000;

/** CLIENT CHOICES (no venue fact): how long to wait for the transport to open, and the reconnect backoff. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * `event_type: "order"` events carry `type` `PLACEMENT` | `UPDATE` |
 * `CANCELLATION` (S-D16, S-D15; SDK `UserOrderEventType`).
 */
export const ORDER_LIFECYCLE_TYPES = ["PLACEMENT", "UPDATE", "CANCELLATION"] as const;
export type OrderLifecycleType = (typeof ORDER_LIFECYCLE_TYPES)[number];

/**
 * Order statuses on the user channel: `LIVE`, `MATCHED`, `DELAYED`,
 * `UNMATCHED`, `CANCELED` (S-D16; SDK `UserOrderStatus`). The SDK types the
 * field `.nullish()`, so an order event may carry no status.
 */
export const USER_ORDER_STATUSES = ["LIVE", "MATCHED", "DELAYED", "UNMATCHED", "CANCELED"] as const;
export type UserOrderStatus = (typeof USER_ORDER_STATUSES)[number];

/**
 * Trade settlement statuses on the user channel: exactly `MATCHED`, `MINED`,
 * `CONFIRMED`, `RETRYING`, `FAILED` (user AsyncAPI S-D15 lines 680–685; the
 * order-lifecycle page S-D41 lines 108–114; the CLOB OpenAPI `Trade.status`
 * S-D56; handoff §9.11). `CONFIRMED` is terminal success and `FAILED`
 * terminal failure (SDK `TradeStatus` doc comment).
 */
export const USER_TRADE_STATUSES = ["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"] as const;
export type UserTradeStatus = (typeof USER_TRADE_STATUSES)[number];

/**
 * The prefixed spelling of a trade status. The SDK says "Trade statuses arrive
 * in two wire forms: REST endpoints serialize the raw prefixed constants
 * ("TRADE_STATUS_CONFIRMED") while the user websocket channel serializes plain
 * values ("CONFIRMED")", and normalizes both (`shared.ts` `TradeStatusSchema`).
 * ADR-002 rules that an adapter "must accept either spelling on either layer
 * and normalize once". Both spellings of the five statuses are accepted here,
 * and nothing else.
 */
export const TRADE_STATUS_PREFIX = "TRADE_STATUS_" as const;

/**
 * Conflict C-3 (`verified-2026-09-30.md` §11): `MATCHED_NOT_BROADCASTED` on the
 * user stream. One official source (the prose page S-D16) lists it; four do not
 * (the user AsyncAPI S-D15, the order-lifecycle page S-D41, the CLOB OpenAPI
 * `Trade.status` enum S-D56, and the SDK, whose `TradeStatus` comment reads
 * "`MatchedNotBroadcasted` currently appears only on trades read via REST, not
 * on user stream trade events" — unchanged in the pinned 0.11.0 bindings).
 * The report's position is that the REST-only modelling stands and the user
 * stream carries the five plain values.
 *
 * THIS ADAPTER'S HANDLING: on the user stream the lexeme (in either spelling)
 * is NOT one of the verified statuses, so it is surfaced as UNRECOGNIZED with
 * the reason `C3_REST_ONLY_STATUS_ON_STREAM`. It is never coerced to `MATCHED`
 * (a match that has not been broadcast is not evidence of the settlement
 * state `MATCHED` means here), it projects no settlement and no fill, and it
 * requests reconciliation. C-3 itself stays OPEN: it needs a documentation
 * re-fetch, which this PAPER-only, offline package cannot make.
 */
export const C3_MATCHED_NOT_BROADCASTED = "MATCHED_NOT_BROADCASTED" as const;

/** `trader_side` is `TAKER` | `MAKER` (S-D16, S-D15; SDK `z.union([z.literal('TAKER'), z.literal('MAKER')]).nullish()`). */
export const TRADER_SIDES = ["TAKER", "MAKER"] as const;
export type TraderSide = (typeof TRADER_SIDES)[number];

/**
 * Order types: the SDK `OrderType` enum has all four (`GTC`, `FOK`, `GTD`,
 * `FAK`). The user AsyncAPI lists three as an illustration ("e.g."), and the
 * report records "so nobody narrows `order_type` to three values from the
 * AsyncAPI" (`verified-2026-09-16.md` §4).
 */
export const ORDER_TYPES = ["GTC", "FOK", "GTD", "FAK"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/**
 * Reconnect guidance, verbatim (S-D16 lines 511–514; `verified-2026-09-16.md`
 * §4, re-verified `verified-2026-09-30.md` §4): the stream does not deliver
 * what was missed while disconnected, so every reconnect requests
 * reconciliation, and this adapter offers no way to obtain missed events.
 */
export const RECONNECT_GUIDANCE =
  "Real-time updates do not replace authoritative account reads or replay every change missed during a disconnection. " +
  "After reconnecting, fetch the account's open orders and recent trades from [Manage Orders], then resume applying new stream events from that refreshed state.";

/**
 * Fees. The fees page says "Makers are never charged fees. Only takers pay
 * fees." (S-D19 line 27, `verified-2026-09-16.md` §6). The same section
 * records drift D-13 (`verified-2026-09-16.md` §6, carried unchanged in
 * `verified-2026-09-30.md` §6, S-D23): the market object publishes a
 * per-market `feeSchedule { rate, exponent, takerOnly, rebateRate }`, where
 * `takerOnly` is documented as "When `true`, fees are charged to the taker side
 * only, and makers pay no fee." The blanket statement is therefore QUALIFIED
 * by a per-market flag. The reports do not show that a `takerOnly: false`
 * market exists; they do not rule one out either.
 *
 * THIS ADAPTER'S HANDLING. The user stream does not carry `takerOnly`, and it
 * carries a fee RATE (`fee_rate_bps`), never a fee AMOUNT; the fee rounding
 * direction is undocumented (U-16). So the adapter states a fee amount only
 * where no reading is needed: zero for a taker leg whose rate is exactly
 * zero. An own maker leg is never projected as a fill from the stream (the
 * shortfall `MAKER_FEE_NOT_ON_STREAM`, which requests reconciliation): a zero
 * maker fee is not established by the event. Projecting maker fills again
 * needs either the market's `feeSchedule` beside the event or an orchestrator
 * ruling that S-D19 controls.
 */
export const MAKER_FEE_IS_PER_MARKET = true as const;
