/**
 * The Market Data Gateway and Recorder — the WP-120 composition root.
 *
 * Assembles, per handoff §9.1: the venue adapters (WP-070/WP-080/WP-090),
 * envelope assignment (`gatewayEpoch`, `ingestSeq`, receipt stamps,
 * connection metadata — ADR-002), the WAL raw-frame recorder (WP-050), the
 * event-bus transport (WP-060), the universe-backed market directory
 * (WP-110), staleness surveillance, gap→snapshot→resync recovery, and
 * data-quality incident emission.
 *
 * The WP-100 RTDS Chainlink TWAP feed is no longer assembled: `RTDS-RETIRE`
 * (2026-10-05, ruling V3-C13) retired the producer, and the configuration
 * door refuses an `rtds` block with the dated reason (`./config.ts`,
 * `RTDS_RETIRED_REASON`). The adapter itself stays in
 * `@polymarket-bot/polymarket-public/rtds`, where it still reads recorded
 * RTDS data.
 *
 * Failure boundaries (§4.2), as wired here:
 *
 * - transport outage → `GatewayPublisher` halts publication terminally for
 *   this epoch, an incident is surfaced through the observer, and RECORDING
 *   CONTINUES: every feed driver's WAL path is independent of the publisher.
 * - WAL refusal/fault → PAGE incident, affected derived data unpublished; the
 *   feed-health stream keeps flowing so the outage is visible.
 * - WAL capacity (`maxTotalBytes`, ADR-028 D5) reached → recording stops and
 *   `GATEWAY_WAL_CAPACITY_REACHED` pages, once per episode: nothing is deleted
 *   or overwritten, and recording resumes when raw-WAL expiry frees room. A
 *   relief re-arms the page for the next episode (`WALCAP-1`).
 * - a trader deploy touches nothing here: this process owns no trader state.
 *
 * Everything impure is injected (`GatewayPorts`), so the whole gateway runs
 * in a test with manual clocks, scripted sockets, an in-memory filesystem,
 * and an in-memory transport — no network, no Docker (§12.4).
 */

import type { BinanceSocketFactory } from "@polymarket-bot/binance-adapter";
import { BinanceReferenceFeed, DEFAULT_RECONNECT_POLICY } from "@polymarket-bot/binance-adapter";
import type { CoinbaseSocketFactory } from "@polymarket-bot/coinbase-adapter";
import { CoinbaseConnectionManager } from "@polymarket-bot/coinbase-adapter";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";
import type {
  PublicHttpClient,
  PublicWebSocketFactory,
} from "@polymarket-bot/polymarket-public";
import {
  DEFAULT_PUBLIC_MARKET_FEED_OPTIONS,
  PublicBookSnapshotFetcher,
  PublicMarketFeed,
} from "@polymarket-bot/polymarket-public";
import type { WalFileSystem, WalWriterMetrics } from "@polymarket-bot/storage-wal";

import { AdmissionLedger, type AdmissionLedgerRecord } from "./admission-ledger.js";
import type { GatewayConfig } from "./config.js";
import { reviewedSeriesOf } from "./config.js";
import { ConnectionIdFactory } from "./connection-ids.js";
import { UniverseMarketDirectory, type UniverseDirectoryMetrics } from "./directory.js";
import type { DispatcherMetrics, DispatcherObserver } from "./dispatcher.js";
import { GatewayDispatcher } from "./dispatcher.js";
import type { DisposalFailure } from "./errors.js";
import { GatewayDisposalError, GatewayStateError } from "./errors.js";
import type { BinanceFeedDriverMetrics } from "./feeds/binance.js";
import { BinanceFeedDriver } from "./feeds/binance.js";
import type { CoinbaseFeedDriverMetrics } from "./feeds/coinbase.js";
import { CoinbaseFeedDriver } from "./feeds/coinbase.js";
import type { MarketLifecycleDriverMetrics } from "./feeds/market-lifecycle.js";
import { MarketLifecycleFeedDriver } from "./feeds/market-lifecycle.js";
import type { PolymarketFeedDriverMetrics } from "./feeds/polymarket.js";
import { PolymarketFeedDriver } from "./feeds/polymarket.js";
import type { SeriesAdmissionDriverMetrics } from "./feeds/series-admission.js";
import { SeriesAdmissionFeedDriver } from "./feeds/series-admission.js";
import type { IncidentRegistryMetrics } from "./incidents.js";
import { IncidentRegistry } from "./incidents.js";
import { GatewayJournal } from "./journal.js";
import { LifecycleLedger } from "./lifecycle-ledger.js";
import type {
  CancelScheduled,
  CleanupDeadline,
  GatewayClock,
  GatewayIdSource,
  GatewayLifetime,
  GatewayTimers,
  ReleaseLifetime,
} from "./ports.js";
import type {
  GatewayPublisherMetrics,
  PublicationHalt,
  PublicationHaltCause,
} from "./publisher.js";
import { GatewayPublisher } from "./publisher.js";
import { IngestSequencer } from "./sequencer.js";
import type { SubscriptionPlan } from "./subscription-plan.js";
import { planSubscriptions } from "./subscription-plan.js";
import { windowInternalMarketId, type ReviewedSeries } from "@polymarket-bot/universe";

/** Operational visibility, independent of the transport being reachable. */
export interface GatewayObserver extends DispatcherObserver {
  onPublicationHalted?(halt: PublicationHalt): void;
  onPublishRejected?(rejection: {
    readonly ingestSeq: string;
    readonly detail: string;
  }): void;
  onRecordingFailure?(failure: { readonly reason: string; readonly detail: string }): void;
  /**
   * One resource disposal failed (round 6, M-1 — evidence retention).
   *
   * Reported the MOMENT the failure is collected — during `stop()`'s
   * disposal or `create()`'s own failure-path cleanup — because the
   * aggregate `GatewayDisposalError` only exists if the disposal sequence
   * SETTLES: a sibling disposal that hangs (bounded by the composition's
   * cleanup deadline, which force-exits) would otherwise take every
   * already-collected failure with it, unobserved. `main.ts` and the probe
   * entry write these to stderr as `[disposal] …` lines.
   */
  onDisposalFailure?(failure: DisposalFailure): void;
}

/**
 * The page for reaching the WAL's `maxTotalBytes` (ADR-028 D5.3: "Recording
 * stops and a page fires"). Market-less, so a consumer taints the epoch
 * (ADR-023 D2 rule 4), which is right: the gateway is not recording.
 */
export const WAL_CAPACITY_REACHED_REASON_CODE = "GATEWAY_WAL_CAPACITY_REACHED";

/**
 * One PAGE incident reason code per halt cause.
 *
 * Every cause is terminal and every one costs the rest of the epoch's
 * publication, so the operator procedure is the same in all four cases (see
 * `infra/compose/data-gateway/README.md`); the codes differ so a dashboard can
 * separate an infrastructure outage from a gateway-side defect.
 */
const PUBLICATION_HALT_REASON_CODES: Readonly<Record<PublicationHaltCause, string>> = {
  EVENT_BUS_PUBLISH_QUEUE_FULL: "GATEWAY_PUBLISH_QUEUE_FULL",
  EVENT_BUS_UNAVAILABLE: "GATEWAY_TRANSPORT_UNAVAILABLE",
  GATEWAY_PUBLISH_ADMISSION_OVERFLOW: "GATEWAY_PUBLISH_ADMISSION_OVERFLOW",
  GATEWAY_PUBLISH_REJECTED: "GATEWAY_PUBLISH_REJECTED",
};

/** Everything impure the gateway needs, injected. */
export interface GatewayPorts {
  readonly clock: GatewayClock;
  readonly ids: GatewayIdSource;
  readonly timers: GatewayTimers;
  /**
   * Process-lifetime anchor (round-2 review R2-H5). Every timer above is
   * unref'd, so without this a running gateway whose feeds are all in
   * reconnect wait (and whose transport holds no socket) keeps NOTHING
   * referenced and the host process exits mid-recording. The gateway owns the
   * handle — acquired in `start()`, released exactly once in `stop()` — so
   * every composition that supplies the port gets liveness, not just
   * `main.ts`. Optional: test compositions inject a counting fake or nothing.
   */
  readonly lifetime?: GatewayLifetime;
  readonly walFileSystem: WalFileSystem;
  readonly transport: MarketEventTransport;
  readonly polymarketSocketFactory?: PublicWebSocketFactory;
  readonly polymarketHttpClient?: PublicHttpClient;
  readonly binanceSocketFactory?: BinanceSocketFactory;
  readonly coinbaseSocketFactory?: CoinbaseSocketFactory;
  readonly observer?: GatewayObserver;
  /**
   * `ROLLOVER-1` (ADR-030 Decision 2.1): the process's run mode, read from its
   * environment by the composition root (`main.ts`). Consulted ONLY by the
   * series-admission feed, which refuses to start unless it is `PAPER` or
   * `BACKTEST`; an absent value is refused too.
   */
  readonly runMode?: string;
}

/**
 * Options for {@link DataGateway.create} beyond the ports (round 5, M-2).
 *
 * `cleanupDeadline` brings `create()`'s internal post-open cleanup — the
 * journal close it awaits before rejecting — under the composition sequence's
 * cleanup hard-deadline. `runGatewaySequence` ALWAYS supplies it (derived
 * from the required `GatewayHost` effects); it is optional here only so
 * library and test callers of `create()` are not forced to fabricate a
 * process-exit capability — such a caller keeps the round-4 semantics, where
 * the await is bounded by `GatewayJournal.close()`'s non-rejecting contract
 * but not by a timer.
 */
export interface GatewayCreateOptions {
  readonly cleanupDeadline?: CleanupDeadline;
}

export interface GatewayMetrics {
  readonly gatewayEpoch: string;
  readonly wal: WalWriterMetrics;
  readonly publisher: GatewayPublisherMetrics;
  readonly dispatcher: DispatcherMetrics;
  readonly incidents: IncidentRegistryMetrics;
  readonly directory: UniverseDirectoryMetrics | undefined;
  readonly polymarket: PolymarketFeedDriverMetrics | undefined;
  readonly binance: BinanceFeedDriverMetrics | undefined;
  readonly coinbase: CoinbaseFeedDriverMetrics | undefined;
  /** The market lifecycle feed (`UNIV-4`), when configured. */
  readonly lifecycle: MarketLifecycleDriverMetrics | undefined;
  /** The series-admission feed (`ROLLOVER-1`), when configured. */
  readonly seriesAdmission: SeriesAdmissionDriverMetrics | undefined;
}

type GatewayState = "created" | "running" | "stopped";

export class DataGateway {
  readonly #config: GatewayConfig;
  readonly #ports: GatewayPorts;
  readonly #sequencer: IngestSequencer;
  readonly #journal: GatewayJournal;
  readonly #publisher: GatewayPublisher;
  readonly #dispatcher: GatewayDispatcher;
  readonly #plan: SubscriptionPlan;
  readonly #directory: UniverseMarketDirectory | undefined;
  readonly #lifecycleLedger: LifecycleLedger | undefined;
  readonly #admissionLedger: AdmissionLedger | undefined;

  #lifecycleDriver: MarketLifecycleFeedDriver | undefined;
  #admissionDriver: SeriesAdmissionFeedDriver | undefined;
  #polymarketFeed: PublicMarketFeed | undefined;
  #polymarketDriver: PolymarketFeedDriver | undefined;
  #binanceDriver: BinanceFeedDriver | undefined;
  #coinbaseManager: CoinbaseConnectionManager | undefined;
  #coinbaseDriver: CoinbaseFeedDriver | undefined;

  #state: GatewayState = "created";
  #cancelTick: CancelScheduled | undefined;
  /**
   * The owned, REFERENCED lifetime handle (R2-H5): held for exactly the
   * `running` state, released exactly once — in `stop()`'s `finally`, or on a
   * `start()` that throws mid-way (so a fatal startup path exits instead of
   * hanging on an orphaned handle).
   */
  #releaseLifetime: ReleaseLifetime | undefined;

  private constructor(args: {
    config: GatewayConfig;
    ports: GatewayPorts;
    sequencer: IngestSequencer;
    journal: GatewayJournal;
    publisher: GatewayPublisher;
    dispatcher: GatewayDispatcher;
    plan: SubscriptionPlan;
    directory: UniverseMarketDirectory | undefined;
    lifecycleLedger: LifecycleLedger | undefined;
    admissionLedger: AdmissionLedger | undefined;
  }) {
    this.#config = args.config;
    this.#ports = args.ports;
    this.#sequencer = args.sequencer;
    this.#journal = args.journal;
    this.#publisher = args.publisher;
    this.#dispatcher = args.dispatcher;
    this.#plan = args.plan;
    this.#directory = args.directory;
    this.#lifecycleLedger = args.lifecycleLedger;
    this.#admissionLedger = args.admissionLedger;
    this.#buildFeeds();
  }

  /** Builds the gateway: one epoch, one WAL directory, one publish stream. */
  static async create(
    config: GatewayConfig,
    ports: GatewayPorts,
    options: GatewayCreateOptions = {},
  ): Promise<DataGateway> {
    const gatewayEpoch = ports.ids.newUuid();
    const sequencer = new IngestSequencer(gatewayEpoch);
    const observer = ports.observer ?? {};

    // Late-bound so the journal/publisher callbacks can reach the dispatcher
    // that is constructed after them. A holder rather than a reassigned
    // binding: the callbacks close over the holder, and the one assignment
    // below fills it before any of them can fire.
    const late: { dispatcher?: GatewayDispatcher } = {};

    const journal = await GatewayJournal.open({
      walRootPath: config.wal.rootPath,
      fileSystem: ports.walFileSystem,
      clock: ports.clock,
      sequencer,
      ...(config.wal.queueCapacity === undefined
        ? {}
        : { queueCapacity: config.wal.queueCapacity }),
      ...(config.wal.queueMaxBytes === undefined
        ? {}
        : { queueMaxBytes: config.wal.queueMaxBytes }),
      ...(config.wal.maxSegmentBytes === undefined
        ? {}
        : { maxSegmentBytes: config.wal.maxSegmentBytes }),
      ...(config.wal.maxSegmentAgeMs === undefined
        ? {}
        : { maxSegmentAgeMs: config.wal.maxSegmentAgeMs }),
      ...(config.wal.fsyncIntervalMs === undefined
        ? {}
        : { fsyncIntervalMs: config.wal.fsyncIntervalMs }),
      ...(config.wal.fsyncByteThreshold === undefined
        ? {}
        : { fsyncByteThreshold: config.wal.fsyncByteThreshold }),
      ...(config.wal.maxTotalBytes === undefined
        ? {}
        : { maxTotalBytes: config.wal.maxTotalBytes }),
      onRecordingFailure: (failure) => {
        observer.onRecordingFailure?.(failure);
        // A writer FAULT (as opposed to a per-frame refusal, which the feed
        // drivers report per frame) is a PAGE incident of its own.
        if (failure.reason === "write-fault") {
          late.dispatcher?.openIncident({
            scope: "wal",
            reasonCode: "GATEWAY_WAL_WRITE_FAULT",
            severity: "PAGE",
            detail: failure.detail,
          });
        }
        // `WALCAP-1`: the cap gets its own page, beside the per-feed
        // `GATEWAY_WAL_FRAME_REFUSED`, because it stops every feed at once and
        // only expiry ends it. One incident per episode: the registry counts
        // the repeats while it is open.
        if (failure.reason === "capacity-exceeded") {
          late.dispatcher?.openIncident({
            scope: "wal",
            reasonCode: WAL_CAPACITY_REACHED_REASON_CODE,
            severity: "PAGE",
            detail:
              `${failure.detail}: new raw frames are refused and their market data is not published; ` +
              "nothing is deleted or overwritten, and recording resumes only when raw-WAL expiry frees room (ADR-028 D5)",
          });
        }
      },
      onCapacityRelieved: () => {
        // Expiry gave room back after the cap refused: the next time the cap
        // is reached is a new episode, and it pages again.
        late.dispatcher?.markIncidentClosed("wal", WAL_CAPACITY_REACHED_REASON_CODE);
      },
    });

    // R3-H1: `create()` is transactional over what IT acquires. The journal
    // above is the one real resource this method opens (an open WAL writer);
    // everything below is in-memory construction — but `#buildFeeds()` (run
    // by the constructor) throws on a configured feed whose port is missing,
    // and `planSubscriptions` throws on contradictory plans. If anything
    // after the journal opened throws, a close of the journal is INITIATED
    // (and awaited under the cleanup deadline) before the original error
    // escapes; a close that rejects or hangs may leave the journal's own
    // resources unreleased — the deadline bounds the process exit in that
    // case. Ownership of the journal transfers to the constructed gateway
    // exactly at `new DataGateway(...)` returning (its `stop()` closes it),
    // so this close cannot double with the gateway's own. `journal.close()`
    // is non-rejecting by contract (every writer operation runs on the serial
    // chain, which converts failures into the fault state), so the original
    // error is the one the caller sees — and since round 6 (L-1) the close is
    // guarded anyway: a rejection that breaks that contract is reported
    // through the observer instead of replacing the original error.
    // NOTE: the transport in `ports` is the
    // CALLER's to release when `create()` rejects — this method never
    // connected it and closing borrowed resources would break single
    // ownership (`run.ts` is that caller in the real process).
    //
    // Round 5 (M-2): that internal close was the ONE cleanup await on the
    // startup failure path outside the round-4 deadline — the sequence arms
    // its deadline only in ITS catch, which a never-settling `journal.close()`
    // here prevented from ever running, so a connected transport's referenced
    // handle held the "rejecting" process forever. The catch below therefore
    // arms the caller-supplied `cleanupDeadline` capability the moment the
    // failure path begins (never around the normal open above) and cancels it
    // only when the close COMPLETES: a close that hangs — or ever broke the
    // non-rejecting contract — ends in the deadline's logged, forced nonzero
    // exit instead of a wedge.
    try {
      const publisher = new GatewayPublisher({
        transport: ports.transport,
        stream: config.streamName,
        clock: ports.clock,
        maxQueueDepth: config.publisher.maxQueueDepth,
        maxQueueBytes: config.publisher.maxQueueBytes,
        onPublishRejected: (rejection) => {
          // Informational only: the halt that follows is what an operator acts
          // on, and it arrives through `onPublicationHalted` below. Round 1 wired
          // NOTHING here, so a non-outage rejection was invisible (review H3).
          observer.onPublishRejected?.(rejection);
        },
        onPublicationHalted: (halt) => {
          observer.onPublicationHalted?.(halt);
          // §8.3: a critical queue that cannot accept an event opens an
          // incident. The incident's own publication is suppressed while
          // halted; the observer callback above is the delivery that works.
          late.dispatcher?.openIncident({
            scope: "transport",
            reasonCode: PUBLICATION_HALT_REASON_CODES[halt.cause],
            severity: "PAGE",
            detail: `publication halted at ingestSeq ${halt.haltedAtIngestSeq}: ${halt.detail}; the WAL keeps recording`,
          });
        },
      });

      const dispatcher = new GatewayDispatcher({
        clock: ports.clock,
        ids: ports.ids,
        sequencer,
        publisher,
        incidents: new IncidentRegistry(),
        observer,
      });
      late.dispatcher = dispatcher;

      const directory =
        config.polymarket === undefined
          ? undefined
          : new UniverseMarketDirectory(config.markets, ports.clock);

      // UNIV-4: the lifecycle ledger is read BEFORE any feed is built, so the
      // lifecycle driver seeds every market's phase from what a previous
      // epoch emitted. It opens on the same filesystem port as the journal;
      // an unreadable ledger throws here and is handled by the transactional
      // path below (the journal is closed before the error escapes).
      const lifecycleLedger =
        config.lifecycle === undefined
          ? undefined
          : await LifecycleLedger.open({
              fileSystem: ports.walFileSystem,
              walRootPath: config.wal.rootPath,
            });

      // `ROLLOVER-1`: the admission ledger is read before any feed is built,
      // so the live windows are re-registered and re-attached at start.
      const admissionLedger =
        config.seriesAdmission === undefined
          ? undefined
          : await AdmissionLedger.open({
              fileSystem: ports.walFileSystem,
              walRootPath: config.wal.rootPath,
            });

      return new DataGateway({
        config,
        ports,
        sequencer,
        journal,
        publisher,
        dispatcher,
        plan: planSubscriptions(config),
        directory,
        lifecycleLedger,
        admissionLedger,
      });
    } catch (error) {
      const cancelDeadline = options.cleanupDeadline?.arm();
      try {
        await journal.close();
        cancelDeadline?.();
      } catch (closeError) {
        // Round 6 (L-1): a `journal.close()` that REJECTS — breaking its own
        // non-rejecting contract — must not mask the original construction
        // error (the round-6 probe: the caller saw the close rejection and
        // the post-open construction error was lost). The rejection is
        // reported as the disposal failure it is, and the deadline bracket
        // deliberately stays ARMED: a rejected close may still hold
        // resources (the round-4 design), so the supplied deadline — not
        // this rejection — bounds a wedged process.
        observer.onDisposalFailure?.({ resource: "wal-journal", error: closeError });
      }
      throw error;
    }
  }

  #buildFeeds(): void {
    const config = this.#config;
    const ports = this.#ports;

    if (config.polymarket !== undefined) {
      if (ports.polymarketSocketFactory === undefined || ports.polymarketHttpClient === undefined) {
        throw new GatewayStateError(
          "the Polymarket feed is configured but its socket factory or HTTP client port is missing",
        );
      }
      if (this.#directory === undefined) {
        throw new GatewayStateError("the Polymarket feed requires the universe directory");
      }
      const feedConfig = config.polymarket;
      const url = feedConfig.url ?? DEFAULT_PUBLIC_MARKET_FEED_OPTIONS.url;
      const fetcher = new PublicBookSnapshotFetcher({
        http: ports.polymarketHttpClient,
        directory: this.#directory,
        ...(feedConfig.snapshotBaseUrl === undefined
          ? {}
          : { baseUrl: feedConfig.snapshotBaseUrl }),
      });
      const driver = new PolymarketFeedDriver({
        feedId: feedConfig.feedId,
        endpoint: url,
        journal: this.#journal,
        dispatcher: this.#dispatcher,
        clock: ports.clock,
        timers: ports.timers,
        snapshotFetcher: fetcher,
        // `ROLLOVER-1`: a dispatched resolution, with its publication's
        // outcome, lets the admission feed tear the window down on its next
        // cycle once the resolution is PUBLISHED (ADR-030 Decision 4.4; r3,
        // R3-ASTRA-01).
        onMarketResolved: (resolution) => {
          this.#admissionDriver?.noteResolution(resolution);
        },
      });
      const connectionIds = new ConnectionIdFactory(feedConfig.feedId);
      const feed = new PublicMarketFeed(
        {
          clock: {
            nowMs: () => ports.clock.nowMs(),
            monotonicMs: () => Number(ports.clock.monotonicNs() / 1_000_000n),
          },
          timers: ports.timers,
          // `THROUGHPUT-1c` r6 (R6-H1): one socket message, one frame.
          webSocketFactory: driver.frameBoundedSocketFactory(ports.polymarketSocketFactory),
          directory: this.#directory,
          connectionId: () => connectionIds.next(),
        },
        {
          onEvent: (event) => {
            driver.onEvent(event);
          },
          onProblem: (problem) => {
            driver.onProblem(problem);
          },
          onRawFrame: (frame) => {
            driver.onRawFrame(frame);
          },
        },
        {
          feedId: feedConfig.feedId,
          url,
          ...(feedConfig.customFeatureEnabled === undefined
            ? {}
            : { customFeatureEnabled: feedConfig.customFeatureEnabled }),
          ...(feedConfig.maximumAssetsPerSubscriptionFrame === undefined
            ? {}
            : {
                maximumAssetsPerSubscriptionFrame:
                  feedConfig.maximumAssetsPerSubscriptionFrame,
              }),
          ...(feedConfig.heartbeatIntervalMs === undefined
            ? {}
            : { heartbeatIntervalMs: feedConfig.heartbeatIntervalMs }),
          ...(feedConfig.pongTimeoutMs === undefined
            ? {}
            : { pongTimeoutMs: feedConfig.pongTimeoutMs }),
          ...(feedConfig.stalenessCheckIntervalMs === undefined
            ? {}
            : { stalenessCheckIntervalMs: feedConfig.stalenessCheckIntervalMs }),
        },
      );
      driver.bind(feed);
      this.#polymarketFeed = feed;
      this.#polymarketDriver = driver;
    }

    if (config.lifecycle !== undefined) {
      if (ports.polymarketHttpClient === undefined) {
        throw new GatewayStateError(
          "the market lifecycle feed is configured but the Polymarket HTTP client port is missing",
        );
      }
      if (this.#lifecycleLedger === undefined) {
        throw new GatewayStateError("the market lifecycle feed requires its ledger");
      }
      const feedConfig = config.lifecycle;
      this.#lifecycleDriver = new MarketLifecycleFeedDriver({
        feedId: feedConfig.feedId,
        baseUrl: feedConfig.baseUrl,
        pollIntervalMs: feedConfig.pollIntervalMs,
        consecutiveFailureThreshold: feedConfig.consecutiveFailureThreshold,
        markets: config.markets,
        http: ports.polymarketHttpClient,
        journal: this.#journal,
        dispatcher: this.#dispatcher,
        clock: ports.clock,
        timers: ports.timers,
        ledger: this.#lifecycleLedger,
        // `ROLLOVER-1`: an admitted window's record is never "foreign" — its
        // internal id is the window's derived id, which certifies it.
        isAdmittedWindowRecord: (record) => {
          const id = record.internalMarketId;
          const openMs = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
          return Number.isSafeInteger(openMs) && windowInternalMarketId(record.conditionId, openMs) === id;
        },
      });
    }

    if (config.seriesAdmission !== undefined) {
      this.#buildSeriesAdmission(config.seriesAdmission);
    }

    if (config.binance !== undefined) {
      if (ports.binanceSocketFactory === undefined) {
        throw new GatewayStateError(
          "the Binance feed is configured but its socket factory port is missing",
        );
      }
      const feedConfig = config.binance;
      const reconnectPolicy =
        feedConfig.reconnect === undefined
          ? DEFAULT_RECONNECT_POLICY
          : {
              initialDelayMs: feedConfig.reconnect.initialDelayMs,
              maxDelayMs: feedConfig.reconnect.maxDelayMs,
              multiplier: feedConfig.reconnect.multiplier,
              ...(feedConfig.reconnect.maxAttempts === undefined
                ? {}
                : { maxAttempts: feedConfig.reconnect.maxAttempts }),
            };
      const feed = new BinanceReferenceFeed({
        feedId: feedConfig.feedId,
        subscriptions: this.#plan.binanceSubscriptions,
        stalenessThresholdMs: feedConfig.stalenessThresholdMs,
        ...(feedConfig.endpoint === undefined ? {} : { endpoint: feedConfig.endpoint }),
        reconnect: reconnectPolicy,
      });
      this.#binanceDriver = new BinanceFeedDriver({
        feedId: feedConfig.feedId,
        feed,
        socketFactory: ports.binanceSocketFactory,
        journal: this.#journal,
        dispatcher: this.#dispatcher,
        clock: ports.clock,
        timers: ports.timers,
        reconnectPolicy,
        unauthorizedEventEscalationThreshold: feedConfig.unauthorizedEventEscalationThreshold,
      });
    }

    if (config.coinbase !== undefined) {
      if (ports.coinbaseSocketFactory === undefined) {
        throw new GatewayStateError(
          "the Coinbase feed is configured but its socket factory port is missing",
        );
      }
      const feedConfig = config.coinbase;
      const driver = new CoinbaseFeedDriver({
        feedId: feedConfig.feedId,
        journal: this.#journal,
        dispatcher: this.#dispatcher,
        clock: this.#ports.clock,
        snapshotFailureEscalationThreshold: feedConfig.snapshotFailureEscalationThreshold,
        reconnectLoopEscalationThreshold: feedConfig.reconnectLoopEscalationThreshold,
      });
      const manager = new CoinbaseConnectionManager({
        feedId: feedConfig.feedId,
        productIds: this.#plan.coinbaseProductIds,
        socketFactory: driver.wrapSocketFactory(ports.coinbaseSocketFactory),
        timer: {
          schedule: (delayMs, run) => {
            const cancel = this.#ports.timers.setTimeout(run, delayMs);
            return { cancel };
          },
        },
        wallClock: {
          nowIso: () => new Date(this.#ports.clock.nowMs()).toISOString(),
        },
        monotonicClock: {
          nowNs: () => this.#ports.clock.monotonicNs(),
        },
        ...(feedConfig.stalenessThresholdMs === undefined
          ? {}
          : { stalenessThresholdMs: feedConfig.stalenessThresholdMs }),
        ...(feedConfig.stalenessPollIntervalMs === undefined
          ? {}
          : { stalenessPollIntervalMs: feedConfig.stalenessPollIntervalMs }),
        ...(feedConfig.endpoint === undefined ? {} : { endpoint: feedConfig.endpoint }),
        onOutput: (output) => {
          driver.onOutput(output);
        },
      });
      driver.bind(manager);
      this.#coinbaseManager = manager;
      this.#coinbaseDriver = driver;
    }
  }

  /**
   * `ROLLOVER-1`: the series-admission feed, bound to the directory, the market
   * feed and the lifecycle feed it attaches admitted windows to. Its
   * constructor refuses a run mode other than PAPER/BACKTEST, which fails
   * `create()` transactionally (ADR-030 Decision 2.1).
   */
  #buildSeriesAdmission(block: NonNullable<GatewayConfig["seriesAdmission"]>): void {
    const ports = this.#ports;
    if (ports.polymarketHttpClient === undefined) {
      throw new GatewayStateError("the series-admission feed is configured but the Polymarket HTTP client port is missing");
    }
    const directory = this.#directory;
    const ledger = this.#admissionLedger;
    if (directory === undefined || ledger === undefined || this.#lifecycleDriver === undefined) {
      throw new GatewayStateError("the series-admission feed requires the directory, its ledger and the lifecycle feed");
    }
    const series = reviewedSeriesOf(this.#config);
    for (const entry of series) this.#admittedSeries.set(entry.series.seriesId, entry.series);
    this.#admissionDriver = new SeriesAdmissionFeedDriver({
      feedId: block.feedId,
      gammaBaseUrl: block.gammaBaseUrl,
      clobBaseUrl: block.clobBaseUrl,
      // `V2-3`: the `/v2/resolutions` read's origin (`feeds/resolution-check.ts`).
      dataApiBaseUrl: block.dataApiBaseUrl,
      pollIntervalMs: block.pollIntervalMs,
      consecutiveFailureThreshold: block.consecutiveFailureThreshold,
      pageLimit: block.pageLimit,
      maximumPages: block.maximumPages,
      admissionLeadSeconds: block.admissionLeadSeconds,
      series,
      runMode: ports.runMode,
      http: ports.polymarketHttpClient,
      journal: this.#journal,
      dispatcher: this.#dispatcher,
      clock: ports.clock,
      timers: ports.timers,
      ledger,
      gatewayEpoch: this.#sequencer.gatewayEpoch,
      operatorRetirements: block.operatorRetirements ?? [],
      windows: {
        knows: (conditionId, tokenIds) => directory.knowsMarket(conditionId, tokenIds),
        register: (window) => directory.registerAdmittedWindow(window),
        attach: (record) => {
          this.#attachWindow(record);
        },
        detach: (record) => {
          this.#detachWindow(record);
        },
        forgetLifecycleRecord: async (internalMarketId) => {
          await this.#lifecycleLedger?.remove(internalMarketId);
        },
      },
    });
  }

  /** `ROLLOVER-1`: subscribes an admitted window's tokens and adds it to the lifecycle feed. */
  #attachWindow(record: AdmissionLedgerRecord): void {
    const window = record.window;
    const series = this.#admittedSeries.get(record.seriesId);
    if (window === undefined || series === undefined) return;
    this.#lifecycleDriver?.addMarket({
      internalMarketId: window.internalMarketId,
      conditionId: window.conditionId,
      yesTokenId: window.yesTokenId,
      noTokenId: window.noTokenId,
      seriesId: record.seriesId,
      gammaMarketId: window.gammaMarketId,
      parameters: {
        tickSize: window.tickSize,
        minimumOrderSize: series.parameters.minimumOrderSize,
        negRisk: series.parameters.negRisk,
        tradingDelaySeconds: series.parameters.catalogTradingDelaySeconds,
        status: "DISCOVERED",
        openTime: window.scheduledOpenAt,
        closeTime: window.scheduledCloseAt,
      },
      observedAt: record.judgedAt,
    });
    // Before `start()` the feed records the desired set only; after it, a
    // documented dynamic `subscribe` frame is sent and its gap is recovered
    // with an authoritative snapshot (`feeds/polymarket.ts`).
    if (this.#state === "running") this.#polymarketFeed?.subscribe([window.yesTokenId, window.noTokenId]);
    else this.#pendingWindowTokens.push(window.yesTokenId, window.noTokenId);
  }

  /** `ROLLOVER-1`: tears an admitted window down in this process (module header of `feeds/series-admission.ts`). */
  #detachWindow(record: AdmissionLedgerRecord): void {
    const window = record.window;
    if (window === undefined) return;
    if (this.#state === "running") this.#polymarketFeed?.unsubscribe([window.yesTokenId, window.noTokenId]);
    this.#lifecycleDriver?.removeMarket(window.internalMarketId);
    this.#directory?.releaseAdmittedWindow(window.internalMarketId);
  }

  /** `ROLLOVER-1`: admitted windows' tokens attached before `start()`, subscribed with the plan. */
  readonly #pendingWindowTokens: string[] = [];
  /** `ROLLOVER-1`: the reviewed series, by id (the admission feed's configuration). */
  readonly #admittedSeries = new Map<string, ReviewedSeries>();

  get gatewayEpoch(): string {
    return this.#sequencer.gatewayEpoch;
  }

  /**
   * Halts publication terminally, with no submission attempted (§4.2).
   *
   * The startup case: the transport was unreachable when the process came up.
   * Round 1 connected the transport BEFORE building the gateway and exited on
   * failure, so a recorder restarted while Redis was down recorded NOTHING —
   * the exact opposite of acceptance 4. `main.ts` now builds the gateway
   * regardless and calls this, which puts publication in the same terminal
   * halt (and opens the same PAGE incident) a mid-run outage would, while the
   * WAL and every public feed run untouched.
   */
  haltPublication(cause: PublicationHaltCause, detail: string): void {
    this.#publisher.haltPublication(cause, detail);
  }

  /**
   * Starts every configured feed and the gateway tick.
   *
   * The lifetime handle is acquired FIRST (R2-H5): every timer in this app is
   * unref'd, so a running gateway must be alive by ownership — from before the
   * first feed starts until `stop()` releases the handle — never by whichever
   * socket or reconnect timer happens to be in flight. Without this, a
   * recording-only process (transport halted at startup) whose feeds were all
   * waiting to reconnect exited 0 on its own, mid-recording.
   */
  start(): void {
    if (this.#state !== "created") {
      throw new GatewayStateError(`the gateway cannot start from state ${this.#state}`);
    }
    this.#state = "running";
    this.#releaseLifetime = this.#ports.lifetime?.acquire();
    try {
      if (this.#config.polymarket !== undefined && this.#config.lifecycle === undefined) {
        // UNIV-4 r1 (LOW-1): the lifecycle feed is opt-in, and a gateway that
        // records Polymarket markets without it reproduces closeout blocker
        // B10 — no `MarketOpened` is ever produced, every consumer stays
        // PENDING and §9.8 refuses every entry — with no signal at all. This
        // is that signal: a NOTIFY incident at start, in the stream and in the
        // operator's log, naming the block to configure.
        this.#dispatcher.openIncident({
          scope: "lifecycle",
          reasonCode: "GATEWAY_LIFECYCLE_FEED_ABSENT",
          severity: "NOTIFY",
          detail: `${String(this.#config.markets.length)} Polymarket market(s) are configured but no \`lifecycle\` feed is: MarketOpened/MarketClosing will never be produced, every consumer stays PENDING and every paper entry is refused (§9.8) — configure the \`lifecycle\` block (UNIV-4)`,
        });
      }
      if (this.#config.markets.length > 0 && this.#config.polymarket === undefined) {
        // THROUGHPUT-1b: the mirror image of the case above. H1 run 1's first
        // attempt configured a market (and its lifecycle feed) but no
        // `polymarket` block, so the gateway never subscribed to the CLOB
        // market channel: it recorded the lifecycle and the reference feeds,
        // produced ZERO order-book events, and nothing said so. The trader
        // then made no decision at all, because no feature snapshot could be
        // computed without a book. That configuration stays accepted (a
        // lifecycle- or reference-only gateway is legitimate), and is
        // announced here, at start, in the stream and in the operator's log.
        this.#dispatcher.openIncident({
          scope: "books",
          reasonCode: "GATEWAY_BOOK_FEED_ABSENT",
          severity: "NOTIFY",
          detail: `${String(this.#config.markets.length)} Polymarket market(s) are configured but no \`polymarket\` feed is: the gateway subscribes to no order book, so no BookSnapshot/BookLevelChanged is ever produced and a consumer that needs a book computes no feature snapshot — configure the \`polymarket\` block (for example {"feedId": "polymarket-market"}) to record books`,
        });
      }
      // `ROLLOVER-1`: the live, CONFIRMED admitted windows are re-attached
      // first, so their tokens join the initial subscription and the lifecycle
      // feed polls them from its first cycle.
      for (const record of this.#admissionDriver?.confirmedLiveWindows() ?? []) {
        this.#attachWindow(record);
      }
      if (this.#polymarketFeed !== undefined) {
        this.#polymarketFeed.subscribe([...this.#plan.polymarketTokenIds, ...this.#pendingWindowTokens]);
        this.#pendingWindowTokens.length = 0;
        this.#polymarketFeed.start();
      }
      this.#binanceDriver?.start();
      this.#coinbaseManager?.start();
      this.#lifecycleDriver?.start();
      this.#admissionDriver?.start();
      this.#scheduleTick();
    } catch (error) {
      // A start that throws must not leave a referenced handle behind: the
      // composition root's fatal path sets an exit code and returns, and an
      // orphaned handle would turn that into a silent hang.
      const release = this.#releaseLifetime;
      this.#releaseLifetime = undefined;
      release?.();
      throw error;
    }
  }

  /**
   * One gateway tick: WAL fsync/rotation cadence (the published data-loss
   * bound is only real if someone drives it — WP-050 known risk 7), Binance
   * staleness, and Coinbase reconnect-loop surveillance.
   */
  async tick(): Promise<void> {
    await this.#journal.tick();
    this.#binanceDriver?.tick();
    this.#coinbaseDriver?.tick();
  }

  #scheduleTick(): void {
    this.#cancelTick = this.#ports.timers.setInterval(() => {
      void this.tick();
    }, this.#config.tickIntervalMs);
  }

  /** Waits for in-flight publications and WAL drains to settle (tests, shutdown). */
  async settle(): Promise<void> {
    // An in-flight lifecycle poll may still journal and dispatch; it settles
    // first so the publisher and journal settles below see its work.
    await this.#admissionDriver?.settle();
    await this.#lifecycleDriver?.settle();
    await this.#publisher.settle();
    await this.#journal.settle();
  }

  /**
   * Stops everything, INITIATING every independent disposal even when one
   * fails or hangs (rounds 4 and 6).
   *
   * Round 4: the disposals below ran in one `try`, so a feed whose socket
   * `close()` threw synchronously — an in-repo ordering, since every feed
   * teardown ends in an unguarded `socket.close()` — abandoned every later
   * disposal, leaving the WAL journal open and the transport CONNECTED and
   * referenced. Round 4's isolation collected failures per resource but
   * still AWAITED the async disposals sequentially — so a disposal that
   * HUNG (never settled) serialized its siblings out of existence: a
   * never-settling `journal.close()` meant `transport.close()` was never
   * even called, and the collected failures never reached the aggregate
   * error because `stop()` itself could not settle (round 6, M-1).
   *
   * The rule now: each disposal is isolated (failures collected AND reported
   * through `observer.onDisposalFailure` the moment they are collected), the
   * awaited disposals are grouped into their independent resource families
   * and every family is INITIATED before anything is awaited, the lifetime
   * anchor is released in the `finally`, and a single `GatewayDisposalError`
   * naming every failed resource is thrown at the end when `stop()` settles.
   * A disposal that hangs stalls only `stop()`'s own completion — bounded by
   * the caller's cleanup deadline (`run.ts`), whose logged forced exit is
   * that hang's evidence — never a sibling family's cleanup.
   */
  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    const observer = this.#ports.observer ?? {};
    const failures: DisposalFailure[] = [];
    const collect = (resource: string, error: unknown): void => {
      failures.push({ resource, error });
      // Round 6 (M-1), evidence retention: report the failure the moment it
      // is collected. The aggregate error below only exists if stop()
      // SETTLES — a sibling disposal that hangs would otherwise carry every
      // already-collected failure into the deadline's forced exit, unseen.
      observer.onDisposalFailure?.({ resource, error });
    };
    const attempt = (resource: string, dispose: () => void): void => {
      try {
        dispose();
      } catch (error) {
        collect(resource, error);
      }
    };
    const attemptAsync = async (
      resource: string,
      dispose: () => Promise<void>,
    ): Promise<void> => {
      try {
        await dispose();
      } catch (error) {
        collect(resource, error);
      }
    };
    try {
      // The synchronous disposals first: none of these can hang (each is a
      // plain call that returns or throws), and stopping the producers
      // before the flushes below is genuinely ordered — a feed still running
      // could enqueue into the journal and publisher mid-disposal.
      attempt("gateway-tick", () => {
        this.#cancelTick?.();
        this.#cancelTick = undefined;
      });
      attempt("polymarket-driver", () => this.#polymarketDriver?.stop());
      attempt("polymarket-feed", () => this.#polymarketFeed?.stop());
      attempt("binance-driver", () => this.#binanceDriver?.stop());
      attempt("coinbase-manager", () => this.#coinbaseManager?.stop());
      attempt("lifecycle-driver", () => this.#lifecycleDriver?.stop());
      attempt("series-admission-driver", () => this.#admissionDriver?.stop());
      // Round 6 (M-1): the awaited disposals span exactly TWO independent
      // resource families, and BOTH are initiated here before anything is
      // awaited, so a never-settling disposal in one family cannot prevent
      // the other family's cleanup from ever being attempted. Finding of
      // fact on the ordering:
      //
      // - `journal.close()` and `transport.close()` share NO ordering
      //   requirement: the journal owns WAL/filesystem state, the transport
      //   owns the event-bus connection, and neither calls into the other.
      // - WITHIN the transport family the ordering is genuine: the
      //   publisher's admitted publications flush onto the connection
      //   (`publisher.settle()`) BEFORE it is severed — closing first would
      //   abort in-flight publishes.
      // - The journal needs no external settle: `GatewayJournal.close()`
      //   settles its own serial operation chain first (its contract).
      //
      // `attemptAsync` never rejects, so `Promise.all` has allSettled
      // semantics here: every settled failure is collected (and already
      // reported above), and a family that hangs stalls only stop()'s
      // completion — bounded by the caller's cleanup deadline — never a
      // sibling.
      // UNIV-4: the ledger's pending rewrites belong to the WAL family (same
      // filesystem, no ordering with the transport); they settle before the
      // journal closes so a lifecycle fact emitted this epoch is on disk.
      const walFamily = (async () => {
        await attemptAsync("series-admission-ledger", async () => {
          await this.#admissionDriver?.settle();
        });
        await attemptAsync("lifecycle-ledger", async () => {
          await this.#lifecycleDriver?.settle();
        });
        await attemptAsync("wal-journal", () => this.#journal.close());
      })();
      const transportFamily = (async () => {
        await attemptAsync("publisher-settle", () => this.#publisher.settle());
        await attemptAsync("event-bus-transport", () => this.#ports.transport.close());
      })();
      await Promise.all([walFamily, transportFamily]);
    } finally {
      // Released LAST, so the process stays referenced through the whole
      // shutdown sequence, and in a `finally`, so a failing close still lets
      // the process exit (with the composition root's error exit code) rather
      // than hang on the anchor. Exactly once: the state guard above makes a
      // second `stop()` return before reaching here, and the handle is cleared
      // before it is called.
      const release = this.#releaseLifetime;
      this.#releaseLifetime = undefined;
      release?.();
    }
    if (failures.length > 0) {
      throw new GatewayDisposalError(failures);
    }
  }

  metrics(): GatewayMetrics {
    return {
      gatewayEpoch: this.#sequencer.gatewayEpoch,
      wal: this.#journal.metrics(),
      publisher: this.#publisher.metrics(),
      dispatcher: this.#dispatcher.metrics(),
      incidents: this.#dispatcher.incidents.metrics(),
      directory: this.#directory?.metrics(),
      polymarket: this.#polymarketDriver?.metrics(),
      binance: this.#binanceDriver?.metrics(),
      coinbase: this.#coinbaseDriver?.metrics(),
      lifecycle: this.#lifecycleDriver?.metrics(),
      seriesAdmission: this.#admissionDriver?.metrics(),
    };
  }
}
