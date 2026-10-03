/**
 * The authenticated user-stream adapter (WP-280; handoff §9.12). PAPER only.
 *
 * - {@link createUserStreamManager}: the subscription manager. WP-260's
 *   run-mode gate runs first; in PAPER it refuses, and no socket can open.
 * - {@link normalizeUserChannelFrame} / {@link normalizeUserChannelMessage}:
 *   pure normalization of raw user-channel messages into order and trade
 *   lifecycle events; unrecognized input is surfaced as unrecognized.
 * - {@link projectOrderEventForOms} / {@link projectTradeEventForOms}: the
 *   inputs of the OMS's observation, fill and settlement ports, fail-closed.
 * - {@link redactUserStreamPayload}: key-name-redacted copies of raw
 *   user-channel payloads (free text under a public key is not vetted).
 *
 * Every reconnect, and every detected gap, requests reconciliation. The
 * adapter offers no way to obtain events missed while disconnected, because
 * the venue offers none (`venue-facts.ts`).
 */

export {
  createUserStreamManager,
  MAX_CONSECUTIVE_AUTH_REJECTIONS,
  MAX_OVERFLOW_MARKETS,
  MAX_PENDING_RECONCILIATION_REQUESTS,
  MAX_SUBSCRIBED_MARKETS,
  RECONCILIATION_CAUSES,
  STREAM_LOSS_CAUSES,
  USER_STREAM_STATES,
  USER_STREAM_TRANSITIONS,
  UserStreamConfigurationError,
  type CreateUserStreamManagerOptions,
  type MarketChange,
  type ReconciliationCause,
  type StreamLossCause,
  type UserStreamConfigurationErrorCode,
  type UserStreamDiagnostics,
  type UserStreamListener,
  type UserStreamManager,
  type UserStreamOutput,
  type UserStreamReceipt,
  type UserStreamReconciliationRequest,
  type UserStreamState,
  type UserStreamTimers,
} from "./manager.js";
export {
  MAX_FRAME_CHARACTERS,
  MAX_LIST_ENTRIES,
  MAX_MESSAGES_PER_FRAME,
  normalizeUserChannelFrame,
  normalizeUserChannelMessage,
  type MakerLegAccount,
  type NormalizeOptions,
  type NormalizedMakerOrder,
  type NormalizedOrderEvent,
  type NormalizedTradeEvent,
  type UnrecognizedMessageReason,
  type UnrecognizedValueReason,
  type UserChannelMessage,
  type VenueInstant,
  type WireEnum,
} from "./normalize.js";
export {
  PROJECTION_SHORTFALLS,
  projectOrderEventForOms,
  projectTradeEventForOms,
  UNRECOGNIZED_ORDER_STATUS,
  type OmsFillReport,
  type OmsOrderObservation,
  type OmsSettlementObservation,
  type OrderProjection,
  type ProjectionShortfall,
  type TradeProjection,
} from "./oms-projection.js";
export { isUserStreamSensitiveKey, redactUserStreamPayload } from "./redaction.js";
export {
  USER_SOCKET_CLOSE_CAUSES,
  type AuthenticatedUserSocketPort,
  type UserSocketCloseCause,
  type UserSocketConnection,
  type UserSocketHandlers,
} from "./socket-port.js";
export {
  C3_MATCHED_NOT_BROADCASTED,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_STALE_AFTER_MS,
  ORDER_LIFECYCLE_TYPES,
  ORDER_TYPES,
  PING_INTERVAL_MS,
  RECONNECT_GUIDANCE,
  TRADER_SIDES,
  USER_CHANNEL_URL,
  USER_ORDER_STATUSES,
  USER_TRADE_STATUSES,
  type OrderLifecycleType,
  type OrderType,
  type TraderSide,
  type UserOrderStatus,
  type UserTradeStatus,
} from "./venue-facts.js";
