/**
 * `@polymarket-bot/data-gateway` — the Market Data Gateway and Recorder
 * (WP-120, handoff §0.1 first deliverable, §9.1).
 *
 * An independent layer-3 process that records public market data to the WAL,
 * publishes normalized §7.1 envelopes through the WP-060 transport, and keeps
 * running across trader deploys (§4.2). It holds NO credential, NO signer, NO
 * wallet, and NO order path: every feed it consumes is public and
 * unauthenticated, and the configuration schema cannot represent
 * authentication material (`./config.ts`).
 *
 * `./system.ts` is the only impure module, imported only by the composition
 * roots (`./main.ts` and the dev-only R3-H1 probe entry under `./testing`);
 * everything else is driven through injected ports (§12.4).
 */

export { DataGateway, WAL_CAPACITY_REACHED_REASON_CODE } from "./gateway.js";
export type {
  GatewayCreateOptions,
  GatewayMetrics,
  GatewayObserver,
  GatewayPorts,
} from "./gateway.js";

export {
  GAMMA_MARKETS_RATE_LIMIT_PER_10S,
  GatewayConfigSchema,
  HostProfileSchema,
  LAPTOP_PAPER_HOST_PROFILE,
  LIFECYCLE_MAX_BUDGET_SHARE_PERCENT,
  LifecycleFeedConfigSchema,
  lifecycleRequestBudgetPer10s,
  lifecycleRequestsPer10s,
  MIN_LIFECYCLE_POLL_INTERVAL_MS,
  parseGatewayConfig,
  RTDS_RETIRED_ON,
  RTDS_RETIRED_REASON,
  RTDS_RETIRED_RULING,
} from "./config.js";
export type { GatewayConfig, MarketConfig } from "./config.js";

export { planSubscriptions } from "./subscription-plan.js";
export type { SubscriptionPlan } from "./subscription-plan.js";

export { IngestSequencer } from "./sequencer.js";
export { ConnectionIdFactory } from "./connection-ids.js";
export { GatewayJournal } from "./journal.js";
export type { RawFrameInput, RecordOutcome } from "./journal.js";
export {
  DEFAULT_PUBLISH_QUEUE_MAX_BYTES,
  DEFAULT_PUBLISH_QUEUE_MAX_DEPTH,
  GatewayPublisher,
} from "./publisher.js";
export type {
  GatewayPublisherMetrics,
  PublicationHalt,
  PublicationHaltCause,
  PublishOutcome,
} from "./publisher.js";
export { UnavailableEventTransport } from "./unavailable-transport.js";
export { GatewayDispatcher } from "./dispatcher.js";
export type { DispatcherMetrics, DispatcherObserver } from "./dispatcher.js";
export { IncidentRegistry, GATEWAY_INTERNAL_CHANNEL } from "./incidents.js";
export type { IncidentRegistryMetrics, OpenIncidentOutcome } from "./incidents.js";
export { completeEnvelope, rawFrameCausationId } from "./envelope.js";
export type { CompletedEnvelope, EnvelopeAssignment, EnvelopeDraft } from "./envelope.js";
export { UniverseMarketDirectory } from "./directory.js";
export type { UniverseDirectoryMetrics } from "./directory.js";

export { PolymarketFeedDriver } from "./feeds/polymarket.js";
export type { PolymarketFeedDriverMetrics } from "./feeds/polymarket.js";
// `RtdsFeedDriver` was removed by `RTDS-RETIRE` (2026-10-05, ruling V3-C13):
// the gateway no longer produces RTDS data (`./config.ts`, `RTDS_RETIRED_REASON`).
export { BinanceFeedDriver } from "./feeds/binance.js";
export type { BinanceFeedDriverMetrics } from "./feeds/binance.js";
export { CoinbaseFeedDriver, RecordingCoinbaseSocketFactory } from "./feeds/coinbase.js";
export type { CoinbaseFeedDriverMetrics } from "./feeds/coinbase.js";
export { MarketLifecycleFeedDriver } from "./feeds/market-lifecycle.js";
export type { LifecyclePhase, MarketLifecycleDriverMetrics } from "./feeds/market-lifecycle.js";
export { SeriesAdmissionFeedDriver, admissionPayloads, incidentReferenceId } from "./feeds/series-admission.js";
export type {
  AdmittedSeries,
  AdmittedWindowSink,
  SeriesAdmissionDriverMetrics,
  SeriesAdmissionDriverOptions,
} from "./feeds/series-admission.js";
export {
  ADMISSION_LEDGER_FILE_NAME,
  ADMISSION_LEDGER_RETENTION_MS,
  ADMISSION_LEDGER_SCHEMA_VERSION,
  AdmissionLedger,
} from "./admission-ledger.js";
export type { AdmissionLedgerRecord, AdmittedWindowRecord } from "./admission-ledger.js";
export { gatewayRunMode, REPOSITORY_DEFAULT_RUN_MODE } from "./run-mode.js";
export {
  LIFECYCLE_LEDGER_FILE_NAME,
  LIFECYCLE_LEDGER_SCHEMA_VERSION,
  LifecycleLedger,
} from "./lifecycle-ledger.js";
export type { LifecycleLedgerRecord, OpenedAtOrigin } from "./lifecycle-ledger.js";

export {
  GatewayConfigurationError,
  GatewayDisposalError,
  GatewayEnvelopeRejectedError,
  GatewayError,
  GatewayPublicationHaltedError,
  GatewayRecordingError,
  GatewayStateError,
} from "./errors.js";
export type { DisposalFailure, GatewayErrorCode } from "./errors.js";

export { isoFromMs, takeReceipt } from "./ports.js";
export type {
  CancelCleanupDeadline,
  CancelScheduled,
  CleanupDeadline,
  GatewayClock,
  GatewayIdSource,
  GatewayLifetime,
  GatewayReceipt,
  GatewayTimers,
  ReleaseLifetime,
} from "./ports.js";
