/**
 * `@polymarket-bot/polymarket-public/rtds` — the RTDS Chainlink TWAP adapter
 * (WP-100).
 *
 * A public, unauthenticated WebSocket client for Polymarket's real-time data
 * service, normalizing the 30-second and 60-second Chainlink TWAP streams into
 * the frozen `ReferenceTwapObserved` contract.
 *
 * ## Why a subpath rather than the package's main entry
 *
 * `../index.ts` is the CLOB market-data adapter's surface and belongs to
 * `WP-070`; this subtree is a second, independent venue surface in the same
 * package. Exporting it as `./rtds` keeps the two APIs separately importable and
 * leaves the merged package's entry point untouched.
 *
 * ## Scope
 *
 * The two TWAP topics, and nothing else. RTDS carries other channels; none is
 * modelled here, and an update on an unmodelled topic is a typed problem rather
 * than a guess.
 *
 * ## Dependencies
 *
 * `@polymarket-bot/domain` and `@polymarket-bot/decimal`, downward only. No
 * `@polymarket/client` (F6 grants the unified SDK exclusively to
 * `packages/polymarket-secure`) and no archived client (F7): the transport is
 * Node 24's native `WebSocket`, reached only through the injected port in
 * `../ports.ts`.
 *
 * ## Safety
 *
 * RTDS "relays Chainlink-computed mainnet TWAP updates without credentials".
 * There is no credential, signer, order, or authenticated call anywhere in this
 * subtree, and no interface here can carry one.
 */

export {
  DEFAULT_RTDS_TWAP_FEED_OPTIONS,
  RTDS_CHANNEL,
  RTDS_HEARTBEAT_INTERVAL_MS,
  RTDS_HEARTBEAT_REQUEST,
  RTDS_SUBSCRIBE_ACTION,
  RTDS_TWAP_TOPIC_BY_WINDOW,
  RTDS_TWAP_VALUE_DIVISOR,
  RTDS_TWAP_VALUE_SCALE_DECIMALS,
  RTDS_TWAP_WINDOWS,
  RTDS_TWAP_WINDOW_BY_TOPIC,
  RTDS_UPDATE_TYPE,
  RTDS_WEBSOCKET_URL,
  isTwapTopic,
  isTwapWindow,
  resolveRtdsTwapFeedOptions,
  rtdsTopicChannel,
} from "./config.js";
export type {
  RtdsTwapFeedOptions,
  RtdsTwapTopic,
  RtdsTwapWindowSeconds,
  RtdsTwapWindowSubscription,
} from "./config.js";

export {
  buildSubscribeFrame,
  buildSubscriptionEntry,
  buildSymbolFilter,
  decodeInboundRtdsFrame,
} from "./frames.js";
export type { InboundRtdsFrame, RtdsFrame, RtdsSubscriptionEntry } from "./frames.js";

export { RtdsEnvelopeSchema, RtdsTwapUpdatePayloadSchema, isUpdateEnvelope } from "./venue.js";
export type { RtdsEnvelope, RtdsTwapUpdatePayload } from "./venue.js";

export { normalizeFullAccuracyValue, normalizeRtdsInstant, shiftInstant } from "./values.js";
export type { VenueInstant } from "./values.js";

export { TwapObservationTracker } from "./observations.js";
export type {
  ObservationFacts,
  ObservationVerdict,
  TwapObservationTrackerOptions,
} from "./observations.js";

export { normalizeRtdsFrame } from "./normalize.js";
export type { RtdsNormalizationContext } from "./normalize.js";

export type {
  NormalizedRtdsEvent,
  NormalizedRtdsEventAny,
  NormalizedRtdsFeedEvent,
  NormalizedTwapObservation,
  RtdsEventProvenance,
  RtdsNormalization,
  RtdsObservationQuality,
  RtdsProblem,
  RtdsProblemCode,
  RtdsUnobservedInterval,
} from "./result.js";

export {
  FEED_DISCONNECT_REASONS,
  FEED_GAP_REASONS,
  rtdsDataQualityIncidentFromProblem,
  rtdsFeedConnected,
  rtdsFeedDisconnected,
  rtdsFeedGapDetected,
  rtdsFeedStale,
} from "./signals.js";
export type {
  FeedDisconnectReason,
  FeedGapReason,
  RtdsDataQualityIncidentInput,
  RtdsFeedConnectedInput,
  RtdsFeedDisconnectedInput,
  RtdsFeedGapDetectedInput,
  RtdsFeedStaleInput,
} from "./signals.js";

export { RTDS_GAP_ACKNOWLEDGEMENT_REJECTIONS, RtdsTwapFeed } from "./feed.js";
export type {
  RawRtdsFrame,
  RtdsGapAcknowledgement,
  RtdsGapAcknowledgementOutcome,
  RtdsGapAcknowledgementRejection,
  RtdsOpenGap,
  RtdsTwapFeedDependencies,
  RtdsTwapFeedHandlers,
  RtdsTwapFeedMetrics,
} from "./feed.js";
