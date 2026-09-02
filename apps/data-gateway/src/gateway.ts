/**
 * The Market Data Gateway and Recorder — the WP-120 composition root.
 *
 * Assembles, per handoff §9.1: the venue adapters (WP-070/WP-080/WP-090/
 * WP-100), envelope assignment (`gatewayEpoch`, `ingestSeq`, receipt stamps,
 * connection metadata — ADR-002), the WAL raw-frame recorder (WP-050), the
 * event-bus transport (WP-060), the universe-backed market directory
 * (WP-110), staleness surveillance, gap→snapshot→resync recovery, and
 * data-quality incident emission.
 *
 * Failure boundaries (§4.2), as wired here:
 *
 * - transport outage → `GatewayPublisher` halts publication terminally for
 *   this epoch, an incident is surfaced through the observer, and RECORDING
 *   CONTINUES: every feed driver's WAL path is independent of the publisher.
 * - WAL refusal/fault → PAGE incident, affected derived data unpublished; the
 *   feed-health stream keeps flowing so the outage is visible.
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
import { RtdsTwapFeed, RTDS_WEBSOCKET_URL } from "@polymarket-bot/polymarket-public/rtds";
import type { WalFileSystem, WalWriterMetrics } from "@polymarket-bot/storage-wal";

import type { GatewayConfig } from "./config.js";
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
import type { PolymarketFeedDriverMetrics } from "./feeds/polymarket.js";
import { PolymarketFeedDriver } from "./feeds/polymarket.js";
import type { RtdsFeedDriverMetrics } from "./feeds/rtds.js";
import { RtdsFeedDriver } from "./feeds/rtds.js";
import type { IncidentRegistryMetrics } from "./incidents.js";
import { IncidentRegistry } from "./incidents.js";
import { GatewayJournal } from "./journal.js";
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

/** Operational visibility, independent of the transport being reachable. */
export interface GatewayObserver extends DispatcherObserver {
  onPublicationHalted?(halt: PublicationHalt): void;
  onPublishRejected?(rejection: {
    readonly ingestSeq: string;
    readonly detail: string;
  }): void;
  onRecordingFailure?(failure: { readonly reason: string; readonly detail: string }): void;
}

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
  readonly rtdsSocketFactory?: PublicWebSocketFactory;
  readonly binanceSocketFactory?: BinanceSocketFactory;
  readonly coinbaseSocketFactory?: CoinbaseSocketFactory;
  readonly observer?: GatewayObserver;
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
  readonly rtds: RtdsFeedDriverMetrics | undefined;
  readonly binance: BinanceFeedDriverMetrics | undefined;
  readonly coinbase: CoinbaseFeedDriverMetrics | undefined;
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

  #polymarketFeed: PublicMarketFeed | undefined;
  #polymarketDriver: PolymarketFeedDriver | undefined;
  #rtdsFeed: RtdsTwapFeed | undefined;
  #rtdsDriver: RtdsFeedDriver | undefined;
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
  }) {
    this.#config = args.config;
    this.#ports = args.ports;
    this.#sequencer = args.sequencer;
    this.#journal = args.journal;
    this.#publisher = args.publisher;
    this.#dispatcher = args.dispatcher;
    this.#plan = args.plan;
    this.#directory = args.directory;
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
      },
    });

    // R3-H1: `create()` is transactional over what IT acquires. The journal
    // above is the one real resource this method opens (an open WAL writer);
    // everything below is in-memory construction — but `#buildFeeds()` (run
    // by the constructor) throws on a configured feed whose port is missing,
    // and `planSubscriptions` throws on contradictory plans. If anything
    // after the journal opened throws, the journal is closed before the error
    // escapes, so a caller that sees `create()` reject holds NO acquired
    // resource. Ownership of the journal transfers to the constructed gateway
    // exactly at `new DataGateway(...)` returning (its `stop()` closes it),
    // so this close cannot double with the gateway's own. `journal.close()`
    // is non-rejecting by contract (every writer operation runs on the serial
    // chain, which converts failures into the fault state), so the original
    // error is the one the caller sees. NOTE: the transport in `ports` is the
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

      return new DataGateway({
        config,
        ports,
        sequencer,
        journal,
        publisher,
        dispatcher,
        plan: planSubscriptions(config),
        directory,
      });
    } catch (error) {
      const cancelDeadline = options.cleanupDeadline?.arm();
      await journal.close();
      cancelDeadline?.();
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
      });
      const connectionIds = new ConnectionIdFactory(feedConfig.feedId);
      const feed = new PublicMarketFeed(
        {
          clock: {
            nowMs: () => ports.clock.nowMs(),
            monotonicMs: () => Number(ports.clock.monotonicNs() / 1_000_000n),
          },
          timers: ports.timers,
          webSocketFactory: ports.polymarketSocketFactory,
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

    if (config.rtds !== undefined) {
      if (ports.rtdsSocketFactory === undefined) {
        throw new GatewayStateError(
          "the RTDS feed is configured but its socket factory port is missing",
        );
      }
      const feedConfig = config.rtds;
      const url = feedConfig.url ?? RTDS_WEBSOCKET_URL;
      const driver = new RtdsFeedDriver({
        feedId: feedConfig.feedId,
        endpoint: url,
        journal: this.#journal,
        dispatcher: this.#dispatcher,
        clock: ports.clock,
        plannedSymbols: this.#plan.rtdsPlannedSymbols,
        maxObservationAgeMs: feedConfig.maxObservationAgeMs,
      });
      const connectionIds = new ConnectionIdFactory(feedConfig.feedId);
      const feed = new RtdsTwapFeed(
        {
          clock: {
            nowMs: () => ports.clock.nowMs(),
            monotonicMs: () => Number(ports.clock.monotonicNs() / 1_000_000n),
          },
          timers: ports.timers,
          webSocketFactory: ports.rtdsSocketFactory,
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
          subscriptions: this.#plan.rtdsSubscriptions,
          ...(feedConfig.updateStalenessMs === undefined
            ? {}
            : { updateStalenessMs: feedConfig.updateStalenessMs }),
          ...(feedConfig.stalenessCheckIntervalMs === undefined
            ? {}
            : { stalenessCheckIntervalMs: feedConfig.stalenessCheckIntervalMs }),
        },
      );
      driver.bind(feed);
      this.#rtdsFeed = feed;
      this.#rtdsDriver = driver;
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
      if (this.#polymarketFeed !== undefined) {
        this.#polymarketFeed.subscribe(this.#plan.polymarketTokenIds);
        this.#polymarketFeed.start();
      }
      this.#rtdsFeed?.start();
      this.#binanceDriver?.start();
      this.#coinbaseManager?.start();
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
    await this.#publisher.settle();
    await this.#journal.settle();
  }

  /**
   * Stops everything, attempting EVERY disposal even when one fails (round 4).
   *
   * Before this round, the disposals below ran in one `try`: a feed whose
   * socket `close()` threw synchronously — an in-repo ordering, since every
   * feed teardown ends in an unguarded `socket.close()` — abandoned every
   * later disposal, leaving the WAL journal open and the transport CONNECTED
   * and referenced. On the fatal-startup and signal paths that referenced
   * transport is exactly what wedges the "exiting" process.
   *
   * Per-resource isolation: each disposal is attempted, failures are
   * collected, all resources are released, the lifetime anchor is released in
   * the `finally`, and a single `GatewayDisposalError` naming every failed
   * resource is thrown at the end (callers log it; the error never means a
   * disposal was skipped).
   */
  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    const failures: DisposalFailure[] = [];
    const attempt = (resource: string, dispose: () => void): void => {
      try {
        dispose();
      } catch (error) {
        failures.push({ resource, error });
      }
    };
    const attemptAsync = async (
      resource: string,
      dispose: () => Promise<void>,
    ): Promise<void> => {
      try {
        await dispose();
      } catch (error) {
        failures.push({ resource, error });
      }
    };
    try {
      attempt("gateway-tick", () => {
        this.#cancelTick?.();
        this.#cancelTick = undefined;
      });
      attempt("polymarket-driver", () => this.#polymarketDriver?.stop());
      attempt("polymarket-feed", () => this.#polymarketFeed?.stop());
      attempt("rtds-feed", () => this.#rtdsFeed?.stop());
      attempt("binance-driver", () => this.#binanceDriver?.stop());
      attempt("coinbase-manager", () => this.#coinbaseManager?.stop());
      await attemptAsync("settle", () => this.settle());
      await attemptAsync("wal-journal", () => this.#journal.close());
      await attemptAsync("event-bus-transport", () => this.#ports.transport.close());
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
      rtds: this.#rtdsDriver?.metrics(),
      binance: this.#binanceDriver?.metrics(),
      coinbase: this.#coinbaseDriver?.metrics(),
    };
  }
}
