/**
 * `@polymarket-bot/coinbase-adapter` — Coinbase reference feed (WP-090).
 *
 * WHAT THIS PACKAGE IS. It turns the public, unauthenticated Coinbase Advanced
 * Trade market-data WebSocket into the frozen domain reference contracts:
 * `ReferenceTradeObserved` from the `market_trades` channel and
 * `ReferenceTopOfBookChanged` from the `ticker` channel, plus the `Feed*` and
 * `DataQualityIncidentOpened` events that make gaps, duplicates, reconnects and
 * staleness first-class instead of silent.
 *
 * WHAT IT IS NOT. It is not a gateway: it assigns no `eventId`, `gatewayEpoch`
 * or `ingestSeq` (ADR-002 §2.1 gives those to `WP-120`) and publishes nothing.
 * It is not an order-book manager: the work plan scopes it to trades and top of
 * book, and full depth belongs elsewhere. It holds no configuration: every
 * parameter is a constructor argument, no environment variable is read, and no
 * configuration package is imported.
 *
 * DEPENDENCY DIRECTION (handoff §5.2, `docs/contracts/dependency-direction.md`).
 * Layer 2. It depends downward on `@polymarket-bot/domain` and
 * `@polymarket-bot/decimal`, plus `zod`. No same-layer edge, no app, no Redis,
 * no PostgreSQL, no SDK.
 *
 * NO CREDENTIAL, ANYWHERE. Only feeds that are publicly reachable without
 * authentication are used; `packages/coinbase-adapter/VENUE.md` cites the
 * documentation that says so. There is no code path that reads, stores, or
 * transmits a key, and the subscribe frames this package builds cannot carry a
 * `jwt`.
 *
 * VENUE FACTS ARE CITED, GAPS ARE NAMED. `venue-facts.ts` carries every
 * load-bearing claim with its URL and access date, every fact the documentation
 * does not settle, and the conservative behaviour chosen instead of a guess.
 */

export {
  COINBASE_ANOMALY_SEVERITY,
  type CoinbaseAnomaly,
  type CoinbaseAnomalyCode,
} from "./anomalies.js";

export {
  backoffDelayMs,
  CoinbaseConnectionManager,
  DEFAULT_COINBASE_BACKOFF,
  DEFAULT_STALENESS_POLL_INTERVAL_MS,
  type CoinbaseBackoff,
  type CoinbaseConnectionManagerOptions,
  type CoinbaseFeedOutput,
} from "./connection.js";

export {
  CoinbaseTopOfBookTracker,
  CoinbaseTradeDeduplicator,
  DEFAULT_TRADE_DEDUPE_CAPACITY,
  fingerprintTopOfBook,
  type CoinbaseTopOfBookTransition,
} from "./dedupe.js";

export {
  CoinbaseAdapterError,
  CoinbaseConfigurationError,
  CoinbaseStateError,
  CoinbaseTransportError,
  type CoinbaseAdapterErrorCode,
  type CoinbaseErrorDetails,
} from "./errors.js";

export {
  classifyFrame,
  type CoinbaseClassifiedFrame,
  type CoinbaseFrameRejection,
} from "./frames.js";

export {
  elapsedMs,
  type CoinbaseChannelStaleness,
  type CoinbaseFeedCounters,
  type CoinbaseFeedMetrics,
} from "./metrics.js";

export {
  normalizeTopOfBook,
  normalizeTrade,
  noteUnknownEventType,
  takerSideFromDocumentedMakerSide,
  type CoinbaseEnvelopeDraft,
  type CoinbaseNormalizationContext,
  type CoinbaseNormalizationNote,
  type CoinbaseNormalizationOutcome,
  type CoinbaseNormalizedEvent,
  type CoinbaseNormalizedTopOfBook,
  type CoinbaseNormalizedTrade,
  type CoinbaseTopOfBookVenueDetail,
  type CoinbaseTradeVenueDetail,
} from "./normalize.js";

export {
  nodeWebSocketFactory,
  systemMonotonicClock,
  systemTimer,
  systemWallClock,
} from "./node-runtime.js";

export type {
  CoinbaseRawFrame,
  CoinbaseSocket,
  CoinbaseSocketFactory,
  CoinbaseSocketListener,
  MonotonicClock,
  Timer,
  TimerHandle,
  WallClock,
} from "./ports.js";

export {
  CoinbaseCounterTracker,
  type CoinbaseCounterObservation,
} from "./sequence.js";

export {
  COINBASE_CONNECTION_CHANNEL,
  CoinbaseStreamProcessor,
  DEFAULT_STALENESS_THRESHOLD_MS,
  type CoinbaseFeedEvent,
  type CoinbaseIngestResult,
  type CoinbaseProcessorOutput,
  type CoinbaseStreamProcessorOptions,
} from "./stream-processor.js";

export {
  buildSubscribeFrame,
  buildUnsubscribeFrame,
  COINBASE_CHANNELS,
  COINBASE_DOC_CITATIONS,
  COINBASE_EVENT_TYPES,
  COINBASE_FACTS_VERIFIED_AT,
  COINBASE_LIVE_OBSERVATIONS,
  COINBASE_MARKET_DATA_CHANNELS,
  COINBASE_PUBLIC_MARKET_DATA_ENDPOINT,
  COINBASE_TRADE_SIDES,
  COINBASE_UNVERIFIED_ITEMS,
  findCitation,
  type CoinbaseChannel,
  type CoinbaseDocCitation,
  type CoinbaseEventType,
  type CoinbaseObservation,
  type CoinbaseTradeSide,
  type CoinbaseUnverifiedItem,
} from "./venue-facts.js";

export {
  CoinbaseFrameEnvelopeSchema,
  CoinbaseHeartbeatEventSchema,
  CoinbaseHeartbeatsFrameSchema,
  CoinbaseMarketTradeSchema,
  CoinbaseMarketTradesEventSchema,
  CoinbaseMarketTradesFrameSchema,
  CoinbaseTickerEventSchema,
  CoinbaseTickerFrameSchema,
  CoinbaseTickerSchema,
  describeParseFailure,
  type CoinbaseFrameEnvelope,
  type CoinbaseHeartbeatsFrame,
  type CoinbaseMarketTrade,
  type CoinbaseMarketTradesFrame,
  type CoinbaseTicker,
  type CoinbaseTickerFrame,
} from "./wire.js";
