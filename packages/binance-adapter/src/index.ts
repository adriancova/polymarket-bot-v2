/**
 * `@polymarket-bot/binance-adapter` — Binance public reference feed (WP-080).
 *
 * WHAT IT DOES. Normalizes the two required Binance public streams —
 * `<symbol>@trade` and `<symbol>@bookTicker` — into the frozen domain events
 * `ReferenceTradeObserved` and `ReferenceTopOfBookChanged`, manages the
 * connection lifecycle with explicit subscription generations and feed-status
 * events, classifies duplicates and out-of-order updates against documented
 * venue ids, and exposes staleness as typed values.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 * - **Assign `gatewayEpoch`, `ingestSeq`, or `eventId`.** They are gateway
 *   property (§9.1, ADR-002 §1/§2.1); an adapter that filled them in would be
 *   inventing a position in a total order. See `./emission.ts`.
 * - **Own a socket, a timer, or a clock.** Everything is driven by the caller
 *   with an injected stamp, which is what makes a recorded run replayable
 *   (§12.4). See `./connection.ts`.
 * - **Read configuration.** No environment variable, no file, no
 *   `@polymarket-bot/config` import — every knob is a constructor argument (the
 *   `WP-080` acceptance criterion "Adapter never reads strategy configuration
 *   directly", asserted by a contract test that scans this source tree).
 * - **Maintain full order-book depth.** The work plan scopes this package to
 *   trades and top of book. `<symbol>@depth` needs a REST snapshot and the
 *   venue's documented buffering procedure, which is a different package.
 * - **Hold a credential.** Every endpoint accepted here is public market data,
 *   and the one Binance market-data endpoint that requires an API key is refused
 *   by construction (`./venue.ts`).
 *
 * DEPENDENCY DIRECTION. Layer 2 (`docs/contracts/dependency-direction.md` §2).
 * Its only workspace edges are downward, to `@polymarket-bot/domain` and
 * `@polymarket-bot/decimal`; it imports no other adapter, no transport, and no
 * application module.
 *
 * VENUE FACTS. Every load-bearing claim about Binance is quoted and cited in
 * `./venue.ts`, with its access date; everything the documentation does not state
 * is enumerated in `BINANCE_UNVERIFIED` and handled conservatively rather than
 * assumed.
 */

export {
  assertReconnectPolicy,
  nextReconnectDelayMs,
  DEFAULT_RECONNECT_POLICY,
  MIN_AVERAGE_RECONNECT_SPACING_MS,
  NO_DIRECTIVE,
} from "./connection.js";
export type {
  BinanceSocket,
  BinanceSocketEvent,
  BinanceSocketFactory,
  BinanceSocketRequest,
  ConnectionDirective,
  FeedConnectionState,
  ReconnectPolicy,
} from "./connection.js";

export { BINANCE_EVENT_SOURCE, buildEmission } from "./emission.js";
export type { AdapterEmission, EmissionInput, EmissionProvenance } from "./emission.js";

export {
  BinanceAdapterError,
  BinanceConfigurationError,
  BinanceDecimalError,
  BinancePayloadError,
  BinanceStateError,
  BinanceTimestampError,
} from "./errors.js";
export type { BinanceAdapterErrorCode, BinanceAdapterErrorDetails } from "./errors.js";

export {
  BINANCE_CONNECTION_CHANNEL,
  BinanceReferenceFeed,
} from "./feed.js";
export type {
  BinanceReferenceFeedOptions,
  FeedOutcome,
  FrameClassification,
  FrameOutcome,
} from "./feed.js";

export {
  BinanceBookTickerPayloadSchema,
  BinanceCombinedEnvelopeSchema,
  BinanceControlErrorSchema,
  BinanceControlResponseSchema,
  BinanceServerShutdownPayloadSchema,
  BinanceTradePayloadSchema,
  decodeFrame,
  rawExcerpt,
  MAX_FRAME_BYTES,
  MAX_RAW_EXCERPT_LENGTH,
  NORMALIZABLE_FRAME_KINDS,
} from "./frames.js";
export type {
  DecodedBookTickerFrame,
  DecodedControlErrorFrame,
  DecodedControlResponseFrame,
  DecodedFrame,
  DecodedMalformedFrame,
  DecodedServerShutdownFrame,
  DecodedTradeFrame,
  DecodedUnknownFrame,
  MalformedFrameReason,
} from "./frames.js";

export {
  BINANCE_REASON_CODES,
  dataQualityIncidentOpened,
  feedConnected,
  feedDisconnected,
  feedGapDetected,
  feedStale,
} from "./incidents.js";
export type { BinanceReasonCode, FeedStatusContext } from "./incidents.js";

export { computeFeedMetrics } from "./metrics.js";
export type {
  BinanceConnectionCounters,
  BinanceFeedMetrics,
  BinanceFrameCounters,
  BinanceStreamMetrics,
  FeedMetricsInput,
} from "./metrics.js";

export {
  normalizeBookTicker,
  normalizeTrade,
  takerSideFor,
  TAKER_SIDE_CONVENTIONS,
} from "./normalize.js";
export type {
  NormalizationContext,
  NormalizationFailure,
  NormalizationRejected,
  NormalizedTopOfBook,
  NormalizedTrade,
  TakerSideConvention,
} from "./normalize.js";

export {
  bookTickerIdentity,
  SequenceTracker,
  tradeIdentity,
} from "./sequence.js";
export type { SequenceObservation, SequenceOutcome, SequenceState } from "./sequence.js";

export {
  assertValidSymbol,
  buildCombinedStreamUrl,
  buildRawStreamUrl,
  resolveSubscriptions,
  streamNameFor,
  MAX_SYMBOL_LENGTH,
} from "./streams.js";
export type {
  BinanceStreamSubscription,
  BuiltStreamUrl,
  ResolvedStreamSubscription,
  StreamUrlOptions,
} from "./streams.js";

export {
  elapsedMsBetween,
  systemClock,
  venueEpochToIso,
  venueToReceiptLagMs,
} from "./time.js";
export type { Clock, ReceiptStamp } from "./time.js";

export {
  BINANCE_BOOK_TICKER_STREAM_SUFFIX,
  BINANCE_COMBINED_STREAM_PATH,
  BINANCE_DEFAULT_ENDPOINT,
  BINANCE_DEFAULT_TIME_UNIT,
  BINANCE_FACTS_VERIFIED_AT,
  BINANCE_FRAMING_RULING,
  BINANCE_LIMITS,
  BINANCE_PUBLIC_STREAM_ENDPOINTS,
  BINANCE_RAW_STREAM_PATH,
  BINANCE_SBE_ENDPOINT_HOST,
  BINANCE_SERVER_SHUTDOWN_EVENT_TYPE,
  BINANCE_STREAM_SUFFIXES,
  BINANCE_TIME_UNIT_QUERY_PARAM,
  BINANCE_TIME_UNITS,
  BINANCE_TRADE_EVENT_TYPE,
  BINANCE_TRADE_STREAM_SUFFIX,
  BINANCE_UNVERIFIED,
  explainNonPublicEndpoint,
} from "./venue.js";
export type {
  BinancePublicStreamEndpoint,
  BinanceStreamSuffix,
  BinanceTimeUnit,
} from "./venue.js";

export {
  createWebSocketFactory,
  decodeMessageData,
  resolveGlobalWebSocket,
} from "./websocket.js";
export type { WebSocketConstructor, WebSocketLike } from "./websocket.js";
