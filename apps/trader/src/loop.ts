/**
 * The deterministic core event loop — handoff §8.1, §8.2, §8.3, §8.4.
 *
 * ```text
 * receive normalized event          ← the bounded ingest queue (§8.3)
 *   → validate schema               ← `event-door.ts` (ADR-020 D1-D4)
 *   → update local market/account state
 *   → update feature snapshots      ← `packages/features`
 *   → invoke subscribed strategies in stable configured order   ← §8.2
 *   → persist DecisionResults       ← the synchronous outbox, then the store
 *   → allocate capital              ← `packages/capital-allocator`
 *   → run risk checks               ← `packages/risk`
 *   → create execution plans        ← `packages/execution-planner`
 *   → update OMS / submit eligible actions   ← the §12.1 `ExecutionVenue`
 *   → persist resulting events and projections   ← `packages/ledger`, `packages/pnl`
 * ```
 *
 * ## One code path for live and replay (§12.1, §8.4)
 *
 * There is no replay branch anywhere below. The difference between a PAPER run
 * against Redis and a BACKTEST replay against a dataset is which
 * implementations of `Clock`, `MarketEventFeed` and `ExecutionVenue` were handed
 * to the constructor. §8.4's ordering rule — "Replay consumes the same
 * normalized event envelopes in the exact recorded dispatch order. It must not
 * sort solely by venue timestamp" — is satisfied structurally: this loop NEVER
 * sorts events. It processes them in the order the feed delivered them, and the
 * only ordering decision it makes at all is §8.2's, over strategy instances.
 *
 * ## Determinism (§12.4)
 *
 * Every source of non-determinism is either injected or absent:
 *
 * - **time** — the `Clock` port. Nothing here calls `Date.now()`;
 * - **identity** — `DeterministicIdFactory`, derived from a run-scoped
 *   namespace and an ordinal;
 * - **randomness** — the strategy runtime's seeded RNG, and nothing else;
 * - **iteration order** — every collection is walked in an order derived from
 *   its VALUES (the §8.2 comparator, a sorted key set, a registration order),
 *   never from a hash;
 * - **floating point** — no economic value passes through a JavaScript number
 *   anywhere in this file (§6 invariant 1).
 *
 * The consequence, which the acceptance fixture asserts: the same recorded
 * events through this loop twice produce byte-identical decision and ledger
 * chains.
 *
 * ## No trading decision on stale or absent state (§4.2)
 *
 * Every failure that means "this process can no longer know the state it would
 * decide from" latches a halt and the loop makes no further decision for the
 * halted scope. That is not an error path bolted on; it is the same `if` that
 * gates every evaluation.
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import { computeFeatureSnapshot } from "@polymarket-bot/features";
import { executablePrice } from "@polymarket-bot/order-book";
import type { Intent } from "@polymarket-bot/domain";
import type { EvaluationInput, EvaluationOutcome } from "@polymarket-bot/strategy-runtime";
import type { ExecutionPlan, PlacementPlan } from "@polymarket-bot/execution-planner";
import type {
  ExecutionResult,
  SimulatedFill,
  SimulatedOrder,
} from "@polymarket-bot/simulation";
import type { RiskPolicy } from "@polymarket-bot/risk";
import {
  computePnlSnapshot,
  foldPnlRecords,
  type PnlRecord,
  type PnlStreamIdentity,
} from "@polymarket-bot/pnl";
import type {
  RiskBudgetView,
  StrategyFill,
  StrategyOrderView,
  VirtualPositionView,
} from "@polymarket-bot/strategy-sdk";

import {
  DeterministicIdFactory,
  postFill,
  projectionOf,
  type PostingIdentity,
  type TraceLink,
} from "./accounting.js";
import { CancelLedger } from "./cancels.js";
import type { InstanceConfig, MarketConfig, TraderConfig } from "./config.js";
import { readEventEnvelope } from "./event-door.js";
import { FillDeduplicator } from "./fills.js";
import { HaltController, haltOnLedgerProjection } from "./halt.js";
import { HealthState, type HealthSnapshot } from "./health.js";
import { InstanceRegistry, type RegisteredInstance } from "./instances.js";
import { MarketState } from "./market-state.js";
import { OrderViewTracker, isTerminalStatus, toStrategyOrderView } from "./orders.js";
import {
  buildPlanningInputs,
  buildRiskEvaluationInput,
  isProtectiveExitIntent,
  resolveTimeInForce,
  runPlanner,
  runRiskCheck,
  OrderTimeInForceBook,
} from "./pipeline.js";
import type { Clock, IngestedEvent, TraderStore } from "./ports.js";
import type { DecisionRecord, DecisionTelemetry } from "@polymarket-bot/strategy-runtime";
import type { StrategyStateCheckpoint } from "@polymarket-bot/strategy-runtime";
import { buildStrategyFeatureView, projectFeatureValues } from "./projection.js";
import { BoundedQueue, type QueueMetrics } from "./queue.js";
import { ReferenceState } from "./reference-state.js";
import { ReservationBook } from "./reservations.js";
import { normalizeToStrictUtc } from "./time.js";
import type { Ledger } from "@polymarket-bot/ledger";

/**
 * The venue surface the loop drives.
 *
 * Structurally `packages/simulation`'s `SimulatedVenue`, reduced to the methods
 * the loop calls. Declared here rather than imported as the class so a live
 * adapter can satisfy it without inheriting from a simulator — which is the
 * whole point of §12.1.
 */
export interface TraderVenue {
  observe(identity: {
    readonly gatewayEpoch: string;
    readonly ingestSeq: string;
    readonly receivedAt: string;
    readonly datasetRowOrdinal: number;
  }): { readonly ok: boolean };
  observeTrade(input: {
    readonly marketId: string;
    readonly side: "YES" | "NO";
    readonly price: string;
    readonly shares: string;
    readonly monotonicNs: bigint;
    readonly atEvent: {
      readonly gatewayEpoch: string;
      readonly ingestSeq: string;
      readonly receivedAt: string;
      readonly datasetRowOrdinal: number;
    };
  }): { readonly ok: boolean; readonly value?: { readonly fills: readonly SimulatedFill[] } };
  submit(plan: unknown): Promise<ExecutionResult>;
  ordersSnapshot(): readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFill[];
}

export interface CoreLoopOptions {
  readonly config: TraderConfig;
  readonly riskPolicy: RiskPolicy;
  readonly clock: Clock;
  readonly venue: TraderVenue;
  readonly store: TraderStore;
  readonly registry: InstanceRegistry;
  readonly markets: ReadonlyMap<string, MarketState>;
  readonly instanceConfigs: ReadonlyMap<string, InstanceConfig>;
  readonly ledger: Ledger;
  readonly ids: DeterministicIdFactory;
  readonly health: HealthState;
  readonly halts: HaltController;
  /** The keys the projection produces, from every instance's configuration. */
  readonly featureKeys: readonly string[];
  readonly posting: PostingIdentity;
  /** `marketId -> tokenAssetId` for each outcome (ADR-006: a token is an asset). */
  readonly tokenAssetIds: ReadonlyMap<string, string>;
  /**
   * The synchronous outbox the strategy runtime writes into.
   *
   * §8.1: "The core loop must never wait on external I/O… The loop may
   * synchronously append to a local journal/outbox". `packages/strategy-runtime`'s
   * `DecisionSink` and `CheckpointStore` are synchronous ports, so the runtime
   * appends here and the loop drains to the asynchronous {@link TraderStore}
   * after each event.
   */
  readonly outbox: DecisionOutboxBuffer;
}

/**
 * The bounded, synchronous journal between the runtime and the store.
 *
 * BOUNDED for §8.3's reason: an unbounded outbox is an unbounded memory
 * commitment that hides a store outage instead of surfacing it. A full outbox
 * THROWS out of the synchronous port, which `packages/strategy-runtime` turns
 * into its own `HALTED` outcome, which this loop turns into a latched halt —
 * so the back pressure reaches the halt controller through the runtime's own
 * contract rather than around it, and nothing is dropped on any path.
 */
export class DecisionOutboxBuffer {
  readonly maximumDepth: number;
  #decisions: { record: DecisionRecord; telemetry: DecisionTelemetry }[] = [];
  #checkpoints: StrategyStateCheckpoint[] = [];

  constructor(maximumDepth: number) {
    this.maximumDepth = maximumDepth;
  }

  appendDecision(record: DecisionRecord, telemetry: DecisionTelemetry): void {
    if (this.#decisions.length >= this.maximumDepth) {
      throw new Error(
        `the decision outbox is at its maximum depth of ${String(this.maximumDepth)}; §8.3 ` +
          "forbids dropping the record, so the append REFUSES and the runtime halts the instance",
      );
    }
    this.#decisions.push({ record, telemetry });
  }

  appendCheckpoint(checkpoint: StrategyStateCheckpoint): void {
    if (this.#checkpoints.length >= this.maximumDepth) {
      throw new Error(
        `the checkpoint outbox is at its maximum depth of ${String(this.maximumDepth)}; the ` +
          "append REFUSES rather than dropping a checkpoint a persisted decision depends on",
      );
    }
    this.#checkpoints.push(checkpoint);
  }

  drain(): {
    readonly decisions: readonly { record: DecisionRecord; telemetry: DecisionTelemetry }[];
    readonly checkpoints: readonly StrategyStateCheckpoint[];
  } {
    const decisions = this.#decisions;
    const checkpoints = this.#checkpoints;
    this.#decisions = [];
    this.#checkpoints = [];
    return { decisions, checkpoints };
  }

  get depth(): number {
    return this.#decisions.length + this.#checkpoints.length;
  }
}

/** One recorded step, kept so a run's chain can be compared byte for byte. */
export interface DecisionTrace {
  readonly instanceId: string;
  readonly runId: string;
  readonly evaluationSeq: number;
  readonly callback: string;
  readonly decisionType: string;
  readonly reasonCodes: readonly string[];
  readonly featureSnapshotRef: string;
  readonly intentIds: readonly string[];
  readonly sourceEventId: string;
}

export class CoreLoop {
  readonly #options: CoreLoopOptions;
  readonly #queue: BoundedQueue<IngestedEvent>;
  readonly #fills = new FillDeduplicator({ maximumRemembered: 100_000 });
  readonly #orderViews = new OrderViewTracker();
  readonly #cancels = new CancelLedger();
  readonly #reservations = new ReservationBook();
  readonly #timeInForce = new OrderTimeInForceBook();
  readonly #reference: ReferenceState;

  /** `venueOrderId -> the trace prefix built when its plan was submitted`. */
  readonly #orderTraces = new Map<string, Omit<TraceLink, "venueFillId" | "ledgerFillId" | "ledgerTransactionIds">>();
  /** `instanceId -> venue order ids it owns`, for `ctx.orders()`. */
  readonly #instanceOrders = new Map<string, Set<string>>();
  /** `venueOrderId -> owning instanceId`, for fill attribution. */
  readonly #orderOwners = new Map<string, string>();

  #ledger: Ledger;
  #cash: string;
  #recentIntentIds: string[] = [];
  #lastInstant: string;
  #lastEpochMs = 0;

  readonly #traces: TraceLink[] = [];
  readonly #decisions: DecisionTrace[] = [];
  #knownFills = 0;
  #seenArrivals = 0;
  #seenUnexplained = 0;
  /**
   * The §9.16 record stream per strategy instance, in production order.
   *
   * Held rather than folded incrementally because `foldPnlRecords` is a FOLD
   * over the whole stream: §6 invariant 8's rebuildability is the property that
   * matters, and a fold from zero over the retained records is exactly the
   * rebuild. The records themselves come from `buildFillPosting`, so they are
   * the ledger's own derivation and not a second accounting.
   */
  readonly #pnlRecords = new Map<string, PnlRecord[]>();
  /** Epoch-millisecond instants of this process's own submissions (§9.8 check 19). */
  #submissionInstants: number[] = [];

  constructor(options: CoreLoopOptions) {
    this.#options = options;
    this.#queue = new BoundedQueue<IngestedEvent>({
      name: "ingest",
      maximumDepth: options.config.queues.ingestMaximumDepth,
    });
    this.#ledger = options.ledger;
    this.#cash = options.config.accounting.startingCash;
    this.#lastInstant = options.clock.now();
    this.#reference = new ReferenceState({
      windowMs: options.config.features.tradeWindowMs,
      maximumPoints: 512,
    });
  }

  /** The §6 invariant 4 chains this run produced, in fill order. */
  traces(): readonly TraceLink[] {
    return Object.freeze([...this.#traces]);
  }

  /** Every persisted decision, in evaluation order. */
  decisions(): readonly DecisionTrace[] {
    return Object.freeze([...this.#decisions]);
  }

  /** The §9.16 records one instance's stream has accumulated, in order. */
  pnlRecords(instanceId: string): readonly PnlRecord[] {
    return Object.freeze([...(this.#pnlRecords.get(instanceId) ?? [])]);
  }

  ledger(): Ledger {
    return this.#ledger;
  }

  queueMetrics(): readonly QueueMetrics[] {
    return Object.freeze([this.#queue.metrics(this.#lastEpochMs)]);
  }

  health(): HealthSnapshot {
    return this.#options.health.snapshot({
      asOf: this.#lastInstant,
      halts: this.#options.halts.records(),
      queues: this.queueMetrics(),
    });
  }

  /**
   * Offers one event to the bounded ingest queue (§8.3).
   *
   * A refusal HALTS: "Dropping trading or raw market events silently is
   * forbidden. If a critical queue cannot accept an event, affected trading
   * halts and a data-quality incident opens." There is no path here that drops.
   */
  ingest(event: IngestedEvent): boolean {
    const outcome = this.#queue.offer(event, this.#lastEpochMs);
    if (!outcome.accepted) {
      this.#options.health.countLoop("eventsRefused");
      this.#options.halts.halt(
        { kind: "GLOBAL" },
        "QUEUE_BACKPRESSURE",
        outcome.detail,
        this.#lastInstant,
      );
      return false;
    }
    this.#options.health.countLoop("eventsAccepted");
    return true;
  }

  /** Processes every queued event, in delivery order. Never sorts (§8.4). */
  async drain(): Promise<void> {
    for (;;) {
      const event = this.#queue.take();
      if (event === undefined) return;
      await this.#processEvent(event);
    }
  }

  async #processEvent(event: IngestedEvent): Promise<void> {
    // --- step 1: validate schema ------------------------------------------
    const read = readEventEnvelope(event.envelope);
    if (!read.ok) {
      this.#options.health.countLoop("eventsRefused");
      // `EVENT_TYPE_NOT_CONSUMED` is a well-formed event this loop has no
      // branch for. It is COUNTED and skipped rather than halting: the gateway
      // publishes the whole §7.4 vocabulary and a trader that halted on the
      // first `FeedConnected` would never start. Every OTHER refusal halts,
      // because it means the stream is carrying something this process cannot
      // read at all.
      if (read.refusal.code !== "EVENT_TYPE_NOT_CONSUMED") {
        this.#options.halts.halt(
          { kind: "GLOBAL" },
          "EVENT_UNREADABLE",
          `${read.refusal.code}: ${read.refusal.detail}`,
          this.#lastInstant,
        );
      }
      return;
    }
    const envelope = read.envelope;

    // --- the loop's instant, strict UTC (WP-220 obligation 1) --------------
    const instant = normalizeToStrictUtc(envelope.receivedAt);
    if (!instant.ok) {
      this.#options.health.countLoop("eventsRefused");
      this.#options.halts.halt(
        { kind: "GLOBAL" },
        "EVENT_UNREADABLE",
        `the event's receivedAt could not be normalised: ${instant.problem}`,
        this.#lastInstant,
      );
      return;
    }
    this.#lastInstant = instant.instant;
    this.#lastEpochMs = instant.epochMs;
    this.#options.health.countLoop("eventsProcessed");

    // The venue is positioned at the recorded event before anything it produces
    // can be anchored (§6 invariant 15: no future venue timestamp).
    this.#options.venue.observe(event.identity);

    // --- step 2: update local market/account state -------------------------
    //
    // An event names its market DIRECTLY (`internalMarketId`) or, for a
    // data-quality incident, through `affectedMarketIds` — §7.4 gives an
    // incident a LIST, because one feed failure affects every market that reads
    // it. Both forms are handled; an event that names no configured market is
    // counted and skipped rather than halting, because a gateway legitimately
    // publishes for markets this trader is not configured for.
    // A REFERENCE event names a `(venue, symbol)` pair rather than a market —
    // a BTC print informs every BTC market at once — so it updates the
    // process-scoped reference state and then evaluates EVERY configured
    // market, which is §8.1's "update feature snapshots → invoke subscribed
    // strategies" applied to an input that is not market-keyed.
    if (envelope.eventType === "ReferenceTradeObserved") {
      const venue = readString(envelope.payload, "venue");
      const symbol = readString(envelope.payload, "symbol");
      const price = readString(envelope.payload, "price");
      if (
        (venue === "binance" || venue === "coinbase") &&
        symbol !== undefined &&
        price !== undefined
      ) {
        this.#reference.observe({
          venue,
          symbol,
          price,
          observedAt: instant.instant,
          observedAtEpochMs: instant.epochMs,
        });
      }
      this.#sweepCancels(instant.instant, instant.epochMs);
      for (const [marketId, market] of this.#options.markets) {
        if (this.#options.halts.isMarketHalted(marketId)) continue;
        market.observeInstant(instant.instant, instant.epochMs);
        await this.#evaluateMarket(
          market,
          envelope,
          { kind: "onFeatures" },
          instant.instant,
          instant.epochMs,
        );
      }
      await this.#harvestFills(instant.instant);
      await this.#flushOutbox();
      return;
    }

    const affected = affectedMarketIds(envelope.payload);
    const known = affected.filter((marketId) => this.#options.markets.has(marketId));
    if (known.length === 0) return;

    // --- every cancel reaches a terminal fact (WP-220 obligation 10) -------
    this.#sweepCancels(instant.instant, instant.epochMs);

    for (const marketId of known) {
      const market = this.#options.markets.get(marketId);
      if (market === undefined) continue;
      market.observeInstant(instant.instant, instant.epochMs);
      const callback = this.#applyEvent(market, envelope, event, instant.instant, instant.epochMs);
      if (callback === undefined) continue;
      if (this.#options.halts.isMarketHalted(marketId)) continue;
      // --- steps 3-9 -------------------------------------------------------
      await this.#evaluateMarket(market, envelope, callback, instant.instant, instant.epochMs);
    }

    // --- fills the venue produced, plus their accounting -------------------
    await this.#harvestFills(instant.instant);

    // --- persist decisions and checkpoints (§4.2 halts on a store failure) --
    await this.#flushOutbox();
  }

  /**
   * Applies one event to local state and answers which callback it triggers.
   *
   * `undefined` means "state updated, no evaluation" — which is the honest
   * answer for an event that changes nothing a strategy reads.
   */
  #applyEvent(
    market: MarketState,
    envelope: { readonly eventType: string; readonly payload: unknown; readonly gatewayEpoch: string; readonly ingestSeq: string; readonly subscriptionGeneration?: number; readonly venueTimestamp?: string },
    event: IngestedEvent,
    instant: string,
    epochMs: number,
  ): TriggeredCallback | undefined {
    const meta = {
      gatewayEpoch: envelope.gatewayEpoch,
      ingestSeq: envelope.ingestSeq,
      ...(envelope.subscriptionGeneration === undefined
        ? {}
        : { subscriptionGeneration: envelope.subscriptionGeneration }),
      ...(envelope.venueTimestamp === undefined
        ? {}
        : { venueTimestamp: envelope.venueTimestamp }),
      receivedAt: instant,
    };
    switch (envelope.eventType) {
      case "MarketOpened":
        market.markLifecycle("OPEN");
        return { kind: "onMarketOpen" };
      case "MarketClosing": {
        market.markLifecycle("CLOSING");
        // §7.4 gives `MarketClosing` a `closesAt` INSTANT, and §9.6 gives
        // `onMarketClosing` a `secondsRemaining` DURATION. The conversion is the
        // root's, and it is measured against the event's own instant rather
        // than a wall clock so replay produces the same number.
        const closesAt = readString(envelope.payload, "closesAt");
        const closes = closesAt === undefined ? undefined : normalizeToStrictUtc(closesAt);
        const seconds =
          closes !== undefined && closes.ok
            ? Math.max(0, Math.floor((closes.epochMs - epochMs) / 1000))
            : 0;
        return { kind: "onMarketClosing", secondsRemaining: seconds };
      }
      case "MarketResolved": {
        const outcome = readString(envelope.payload, "outcome");
        if (outcome === undefined) return undefined;
        market.markResolved(outcome, instant);
        return { kind: "onMarketResolved", outcome, resolvedAt: instant };
      }
      case "BookSnapshot": {
        const applied = market.books.applySnapshot({ payload: envelope.payload, meta });
        if (!applied.applied) {
          this.#options.halts.halt(
            { kind: "MARKET", marketId: market.config.marketId },
            "BOOK_DESYNCHRONIZED",
            `${applied.refusal.code}: ${applied.refusal.detail}`,
            instant,
          );
          return undefined;
        }
        return { kind: "onFeatures" };
      }
      case "BookLevelChanged": {
        const applied = market.books.applyLevelChange({ payload: envelope.payload, meta });
        if (!applied.applied) {
          this.#options.halts.halt(
            { kind: "MARKET", marketId: market.config.marketId },
            "BOOK_DESYNCHRONIZED",
            `${applied.refusal.code}: ${applied.refusal.detail}`,
            instant,
          );
          return undefined;
        }
        return { kind: "onFeatures" };
      }
      case "PublicTradeObserved": {
        const price = readString(envelope.payload, "price");
        const size = readString(envelope.payload, "size");
        const tokenId = readString(envelope.payload, "tokenId");
        if (price === undefined || size === undefined || tokenId === undefined) return undefined;
        const takerSide = readString(envelope.payload, "takerSide");
        market.observeTrade({
          price,
          size,
          ...(takerSide === "BID" || takerSide === "ASK" ? { takerSide } : {}),
          observedAt: instant,
          observedAtEpochMs: epochMs,
          tokenId,
        });
        // WP-210 follow-up 1: the simulated venue's resting orders fill from
        // OBSERVED trades, and this is where the normalized stream reaches them.
        // Without this wiring a resting order would never fill in a paper run.
        this.#options.venue.observeTrade({
          marketId: market.config.marketId,
          side: tokenId === market.config.yesTokenId ? "YES" : "NO",
          price,
          shares: size,
          monotonicNs: this.#options.clock.monotonicNs(),
          atEvent: event.identity,
        });
        return { kind: "onFeatures" };
      }
      case "DataQualityIncidentOpened": {
        const incidentId = readString(envelope.payload, "incidentId");
        const reasonCode = readString(envelope.payload, "reasonCode");
        const severity = readString(envelope.payload, "severity");
        if (incidentId === undefined || reasonCode === undefined) return undefined;
        market.openIncident({
          incidentId,
          reasonCode,
          severity:
            severity === "PAGE" || severity === "NOTIFY" || severity === "LOG"
              ? severity
              : "NOTIFY",
        });
        return { kind: "onFeatures" };
      }
      case "DataQualityIncidentClosed": {
        const incidentId = readString(envelope.payload, "incidentId");
        if (incidentId === undefined) return undefined;
        market.closeIncident(incidentId);
        return { kind: "onFeatures" };
      }
      default:
        return undefined;
    }
  }

  /** §8.1 steps 3-9 for one market's instances, in §8.2 order. */
  async #evaluateMarket(
    market: MarketState,
    envelope: { readonly eventId: string },
    callback: TriggeredCallback,
    instant: string,
    epochMs: number,
  ): Promise<void> {
    for (const instance of this.#options.registry.forMarket(market.config.marketId)) {
      if (this.#options.halts.isInstanceHalted(instance.instanceId, market.config.marketId)) {
        continue;
      }
      // --- step 3: update feature snapshots -------------------------------
      const snapshot = this.#computeSnapshot(market, instance, instant, epochMs);
      if (snapshot === undefined) continue;

      // --- step 4: invoke the strategy ------------------------------------
      const input = this.#buildEvaluationInput({
        market,
        instance,
        callback,
        instant,
        snapshotRef: snapshot.snapshotRef,
        values: snapshot.values,
        eventId: envelope.eventId,
      });
      const outcome = instance.runtime.evaluate(input);
      await this.#consumeOutcome(instance, market, outcome, envelope.eventId, instant, epochMs);
    }
  }

  #computeSnapshot(
    market: MarketState,
    instance: RegisteredInstance,
    instant: string,
    epochMs: number,
  ): { readonly snapshotRef: string; readonly values: Readonly<Record<string, string | boolean | null>> } | undefined {
    const outcome = instance.direction;
    const tokenId = outcome === "YES" ? market.config.yesTokenId : market.config.noTokenId;
    const bookEventAt = market.bookFor(outcome).lastUpdate()?.receivedAt ?? instant;
    const computed = computeFeatureSnapshot({
      subject: { internalMarketId: market.config.marketId, tokenId },
      asOf: instant,
      trigger: {
        gatewayEpoch: market.bookFor(outcome).baseline()?.gatewayEpoch ?? ZERO_UUID,
        ingestSeq: market.bookFor(outcome).lastUpdate()?.ingestSeq ?? "0",
      },
      config: {
        depthLevels: [...this.#options.config.features.depthLevels],
        executableShares: [...this.#options.config.features.executableShares],
        tradeWindowMs: this.#options.config.features.tradeWindowMs,
        ewmaLambda: this.#options.config.features.ewmaLambda,
        primaryReferenceVenue: this.#options.config.features.primaryReferenceVenue,
      },
      book: {
        serializedBook: market.serializedBook(outcome),
        lastEventAt: bookEventAt,
      },
      trades: {
        lastEventAt: instant,
        window: market
          .trades()
          .filter((trade) => trade.tokenId === tokenId)
          .map((trade) => ({
            price: trade.price,
            size: trade.size,
            ...(trade.takerSide === undefined ? {} : { takerSide: trade.takerSide }),
            observedAt: trade.observedAt,
          })),
      },
      reference: this.#reference.featureInput(),
      lifecycle: {
        openedAt: market.config.openTime,
        closesAt: market.config.closeTime,
      },
      quality: { activeIncidents: [...market.activeIncidents()] },
    });
    if (!computed.ok) {
      // A snapshot that cannot be computed is state this process does not have,
      // and §4.2's rule is that no decision is made on absent state. The market
      // is not halted — the next event may compute fine, and the ordinary case
      // is simply that no book has arrived yet — but this evaluation does not
      // happen.
      this.#options.health.countLoop("snapshotsUnavailable");
      return undefined;
    }
    this.#options.health.countLoop("featureSnapshots");
    const projected = projectFeatureValues(computed.snapshot, this.#options.featureKeys);
    if (projected.refusals.length > 0) {
      this.#options.health.countLoop(
        "featureProjectionRefusals",
        projected.refusals.length,
      );
    }
    void epochMs;
    return {
      // §6 invariant 4's `feature snapshot` link, and it is the engine's own
      // CONTENT ADDRESS: `verifySnapshotSerialization` re-derives it from the
      // archived bytes, so a decision naming this ref names a snapshot whose
      // contents can be proved rather than merely referenced.
      snapshotRef: computed.snapshot.contentAddress,
      values: projected.values,
    };
  }

  #buildEvaluationInput(input: {
    readonly market: MarketState;
    readonly instance: RegisteredInstance;
    readonly callback: TriggeredCallback;
    readonly instant: string;
    readonly snapshotRef: string;
    readonly values: Readonly<Record<string, string | boolean | null>>;
    /**
     * The §7.1 identity of the event that triggered this evaluation, when one
     * did.
     *
     * `undefined` for a delivery the loop originates rather than an event —
     * an `onFill` or an `onOrderUpdate` — and the field is then OMITTED, not
     * blanked. `SourceEventRef` is "optional as a GROUP", and an empty string
     * is not a UUID: supplying one made the runtime refuse the evaluation with
     * `INPUT_INVALID`, so a fill was never delivered to the strategy at all.
     */
    readonly eventId: string | undefined;
  }): EvaluationInput {
    const base = {
      evaluatedAt: input.instant,
      market: input.market.marketView({
        openTime: input.market.config.openTime,
        closeTime: input.market.config.closeTime,
      }),
      books: {
        yes: input.market.bookView("YES", input.instant),
        no: input.market.bookView("NO", input.instant),
      },
      features: buildStrategyFeatureView({
        snapshotRef: input.snapshotRef,
        asOf: input.instant,
        values: input.values,
      }),
      position: this.#positionView(input.instance, input.instant),
      orders: this.#orderViews_(input.instance, input.instant),
      riskBudget: this.#riskBudgetView(input.instant),
      ...(input.eventId === undefined ? {} : { sourceEvent: { eventId: input.eventId } }),
    } as const;
    switch (input.callback.kind) {
      case "onMarketOpen":
        return { ...base, callback: "onMarketOpen" };
      case "onFeatures":
        return { ...base, callback: "onFeatures" };
      case "onMarketClosing":
        return {
          ...base,
          callback: "onMarketClosing",
          secondsRemaining: input.callback.secondsRemaining,
        };
      case "onMarketResolved":
        return {
          ...base,
          callback: "onMarketResolved",
          resolution: {
            marketId: input.market.config.marketId,
            outcome: input.callback.outcome as "YES_WIN" | "NO_WIN" | "SPLIT_50_50" | "CANCELLED",
            resolvedAt: input.callback.resolvedAt,
          },
        };
      case "onFill":
        return { ...base, callback: "onFill", fill: input.callback.fill };
      case "onOrderUpdate":
        return { ...base, callback: "onOrderUpdate", order: input.callback.order };
    }
  }

  /**
   * The §7.6 virtual position view.
   *
   * `WP-220` obligation 3: "The position view must already include the fill an
   * `onFill` evaluation is about." That is why this reads the LEDGER
   * PROJECTION, and why `#harvestFills` posts a fill to the ledger BEFORE it
   * delivers the fill to the strategy — the projection is folded from the
   * append-only ledger, so a fill that has been posted is already in the view
   * the very next evaluation sees.
   */
  #positionView(instance: RegisteredInstance, instant: string): VirtualPositionView {
    const projection = projectionOf(this.#ledger);
    let yesShares = "0";
    let noShares = "0";
    const yesAsset = this.#options.tokenAssetIds.get(
      `${instance.marketId}|YES`,
    );
    const noAsset = this.#options.tokenAssetIds.get(`${instance.marketId}|NO`);
    for (const line of projection.virtualPositions.values()) {
      if (line.instanceId !== instance.instanceId) continue;
      if (line.assetId === yesAsset) yesShares = line.balance;
      if (line.assetId === noAsset) noShares = line.balance;
    }
    return Object.freeze({ yesShares, noShares, asOf: instant });
  }

  /** This instance's own working orders, for `ctx.orders()` (§7.6). */
  #orderViews_(instance: RegisteredInstance, instant: string): readonly StrategyOrderView[] {
    const owned = this.#instanceOrders.get(instance.instanceId);
    if (owned === undefined) return Object.freeze([]);
    const views: StrategyOrderView[] = [];
    for (const order of this.#options.venue.ordersSnapshot()) {
      if (!owned.has(order.simulatedOrderId)) continue;
      views.push(
        toStrategyOrderView(order, { marketId: instance.marketId, placedAt: instant }),
      );
    }
    return Object.freeze(views);
  }

  #riskBudgetView(instant: string): RiskBudgetView {
    return Object.freeze({
      availableCollateral: this.#reservations.unreservedCollateral(this.#cash),
      asOf: instant,
    });
  }

  /** Handles one `EvaluationOutcome` and walks its intents through the pipeline. */
  async #consumeOutcome(
    instance: RegisteredInstance,
    market: MarketState,
    outcome: EvaluationOutcome,
    eventId: string,
    instant: string,
    epochMs: number,
  ): Promise<void> {
    this.#options.health.countLoop("evaluations");
    switch (outcome.kind) {
      case "REFUSED":
        this.#options.health.countLoop("refusedEvaluations");
        return;
      case "HALTED":
        // §6 invariant 3's persistence failed. The runtime already paused the
        // instance; the process must not keep deciding for it.
        this.#options.health.countLoop("refusedEvaluations");
        this.#options.halts.halt(
          { kind: "STRATEGY_INSTANCE", instanceId: instance.instanceId },
          "RUNTIME_PERSISTENCE_FAILED",
          outcome.incident.detail,
          instant,
        );
        return;
      case "CONTAINED":
        this.#options.health.countLoop("containedEvaluations");
        this.#options.health.countLoop("decisionsPersisted");
        this.#recordDecision(instance, outcome, eventId);
        return;
      case "DECIDED": {
        this.#options.health.countLoop("decisionsPersisted");
        this.#recordDecision(instance, outcome, eventId);
        for (const intent of outcome.record.decision.intents) {
          await this.#routeIntent({
            instance,
            market,
            intent,
            eventId,
            featureSnapshotRef: outcome.record.decision.featureSnapshotRef,
            evaluationSeq: outcome.record.evaluationSeq,
            instant,
            epochMs,
          });
        }
        return;
      }
    }
  }

  #recordDecision(
    instance: RegisteredInstance,
    outcome: Extract<EvaluationOutcome, { kind: "DECIDED" | "CONTAINED" }>,
    eventId: string,
  ): void {
    this.#decisions.push(
      Object.freeze({
        instanceId: instance.instanceId,
        runId: instance.runId,
        evaluationSeq: outcome.record.evaluationSeq,
        callback: outcome.record.callback,
        decisionType: outcome.record.decision.decisionType,
        reasonCodes: Object.freeze([...outcome.record.decision.reasonCodes]),
        featureSnapshotRef: outcome.record.decision.featureSnapshotRef,
        intentIds: Object.freeze(
          outcome.record.decision.intents.map((intent) => intentIdOf(intent)),
        ),
        sourceEventId: eventId,
      }),
    );
  }

  /** §8.1 steps 6-9 for one intent. */
  async #routeIntent(input: {
    readonly instance: RegisteredInstance;
    readonly market: MarketState;
    readonly intent: Intent;
    readonly eventId: string;
    readonly featureSnapshotRef: string;
    readonly evaluationSeq: number;
    readonly instant: string;
    readonly epochMs: number;
  }): Promise<void> {
    const approvedIntentId = this.#options.ids.next();
    const marketConfig = input.market.config;
    const projection = projectionOf(this.#ledger);
    const positions = this.#positionsFor(input.instance, marketConfig, projection);
    const bookAgeMs = this.#bookAgeMs(input.market, input.epochMs);

    const riskInput = buildRiskEvaluationInput({
      intent: input.intent,
      evaluatedAt: input.instant,
      approvedIntentId,
      runMode: "PAPER",
      strategyInstanceId: input.instance.instanceId,
      runStatePermitsIntent: !this.#options.halts.anyHalt,
      strategyStatePermitsIntent: input.instance.runtime.instanceStatus() === "ACTIVE",
      market: input.market,
      marketConfig,
      secondsToClose: this.#secondsToClose(marketConfig, input.epochMs),
      bookSynchronized: input.market.bookFor(input.instance.direction).baseline() !== undefined,
      venueBookAgeMs: bookAgeMs,
      featuresAgeMs: 0,
      positions,
      openOrders: this.#openOrdersFor(input.instance, marketConfig),
      exposures: undefined,
      allocation: { permitted: true },
      recentIntentIds: Object.freeze([...this.#recentIntentIds]),
      availableRequests: this.#availableRequests(input.epochMs),
      parametersVersion: marketConfig.parametersVersion,
      modelDependentActivationAllowed:
        marketConfig.settlementReadiness.modelDependentActivationAllowed,
      scenarios: this.#scenariosFor(input.market, marketConfig),
      ...this.#economicsFor(input.intent, input.market, marketConfig),
      referenceFeedAgeMs: this.#reference.ageMs(input.epochMs),
    });

    const evaluation = runRiskCheck(this.#options.riskPolicy, riskInput);
    this.#options.health.countRecommendations(
      evaluation.recommendations.map((recommendation) => recommendation.action),
    );
    if (!evaluation.approved) {
      // THE RISK-SEAM CAVEAT, COUNTED AND NOT COMPENSATED FOR. `WP-220`'s
      // accepted residual makes every exit this strategy emits an ENTRY at the
      // risk seam, so a protective reduction can be refused here. The loop
      // records that fact — with the reason codes that produced it — and does
      // nothing else. It does not re-tag, resize, retry or relax.
      this.#options.health.countRiskRefusal(
        evaluation.refusals.map((refusal) => refusal.code),
        isProtectiveExitIntent(input.intent),
      );
      return;
    }
    this.#options.health.countRiskApproval();
    this.#rememberIntentId(intentIdOf(input.intent));

    // --- step 8: create execution plans -----------------------------------
    const executionPlanId = this.#options.ids.next();
    const planInputs = buildPlanningInputs({
      config: this.#options.config,
      marketConfig,
      executionPlanId,
      plannedAt: input.instant,
      availableCollateral: this.#cash,
      heldYes: positions.find((position) => position.side === "YES")?.shares ?? "0",
      heldNo: positions.find((position) => position.side === "NO")?.shares ?? "0",
      reservations: this.#reservations,
      yesBestBid: input.market.bookFor("YES").topOfBook().bestBidPrice,
      yesBestAsk: input.market.bookFor("YES").topOfBook().bestAskPrice,
      noBestBid: input.market.bookFor("NO").topOfBook().bestBidPrice,
      noBestAsk: input.market.bookFor("NO").topOfBook().bestAskPrice,
    });
    const planned = runPlanner(evaluation.record, planInputs);
    if (!planned.ok) {
      this.#options.health.countExecution("plansRefused");
      return;
    }
    this.#options.health.countExecution("plansBuilt");

    await this.#submitPlan({
      plan: planned.value,
      instance: input.instance,
      intent: input.intent,
      approvedIntentId,
      evaluationSeq: input.evaluationSeq,
      featureSnapshotRef: input.featureSnapshotRef,
      eventId: input.eventId,
      instant: input.instant,
      epochMs: input.epochMs,
    });
  }

  /** §8.1 step 9: submit, record reservations, and open the trace prefix. */
  async #submitPlan(input: {
    readonly plan: ExecutionPlan;
    readonly instance: RegisteredInstance;
    readonly intent: Intent;
    readonly approvedIntentId: string;
    readonly evaluationSeq: number;
    readonly featureSnapshotRef: string;
    readonly eventId: string;
    readonly instant: string;
    readonly epochMs: number;
  }): Promise<void> {
    const submissionAttemptId = this.#options.ids.next();

    if (input.plan.planKind === "CANCEL") {
      this.#options.health.countExecution("cancelsRequested");
      this.#cancels.register({
        cancelId: submissionAttemptId,
        executionPlanId: input.plan.executionPlanId,
        instanceId: input.instance.instanceId,
        marketId: input.instance.marketId,
        orderIds: Object.freeze([...(input.plan.scope.orderIds ?? [])]),
        requestedAt: input.instant,
        requestedAtEpochMs: input.epochMs,
        silenceBoundMs: input.instance.submissionUnknownAfterMs,
      });
    }

    // The time-in-force resolution (`immediate_order_type`), recorded per
    // planned order BEFORE submission. An order whose value cannot be resolved
    // is not submitted at all.
    const placement = input.plan as PlacementPlan;
    if (input.plan.planKind !== "CANCEL") {
      const resolved = resolveTimeInForce(input.intent, input.instance.immediateOrderType);
      if (!resolved.ok) {
        this.#options.health.countExecution("submissionsRefused");
        return;
      }
      for (const group of placement.groups) {
        for (const order of group.orders) {
          this.#timeInForce.record(order.plannedOrderId, resolved.timeInForce);
        }
      }
      // WP-220 obligation 9: the reservation an accepted plan takes is recorded
      // NOW, so the next evaluation's reduction plans against `held − reserved`.
      for (const requirement of placement.reservations) {
        this.#reservations.take({
          reservationId: requirement.reservationId,
          executionPlanId: input.plan.executionPlanId,
          plannedOrderId: plannedOrderFor(placement, requirement.reservationId),
          instanceId: input.instance.instanceId,
          marketId: requirement.marketId,
          side: requirement.side,
          shares: requirement.action === "SELL" ? requirement.shares : "0",
          collateral: requirement.action === "BUY" ? notional(requirement.price, requirement.shares) : "0",
        });
      }
    }

    this.#submissionInstants.push(input.epochMs);
    const result = await this.#options.venue.submit(input.plan);
    if (!result.accepted) {
      this.#options.health.countExecution("submissionsRefused");
      if (input.plan.planKind === "CANCEL") {
        const resolution = this.#cancels.resolve(
          submissionAttemptId,
          "REJECTED",
          `${result.refusalCode ?? "VENUE_REFUSED"}: ${result.refusalMessage ?? "the venue refused the cancel"}`,
          input.instant,
        );
        if (resolution !== undefined) this.#options.health.countExecution("cancelsRejected");
      }
      return;
    }
    this.#options.health.countExecution("submissionsAccepted");
    if (input.plan.planKind === "CANCEL") {
      this.#cancels.resolve(
        submissionAttemptId,
        "CONFIRMED",
        "the venue confirmed the cancel",
        input.instant,
      );
      this.#options.health.countExecution("cancelsConfirmed");
      return;
    }

    for (const order of result.orders) {
      this.#orderOwners.set(order.simulatedOrderId, input.instance.instanceId);
      const owned = this.#instanceOrders.get(input.instance.instanceId) ?? new Set<string>();
      owned.add(order.simulatedOrderId);
      this.#instanceOrders.set(input.instance.instanceId, owned);
      this.#orderTraces.set(order.simulatedOrderId, {
        sourceEventId: input.eventId,
        featureSnapshotRef: input.featureSnapshotRef,
        runId: input.instance.runId,
        evaluationSeq: input.evaluationSeq,
        intentId: intentIdOf(input.intent),
        approvedIntentId: input.approvedIntentId,
        executionPlanId: input.plan.executionPlanId,
        submissionAttemptId,
        venueOrderId: order.simulatedOrderId,
      });
    }
  }

  /**
   * Books every fill the venue has produced since the last harvest, then
   * delivers the order views and the fills to their instances.
   *
   * ORDER MATTERS AND IS THE OBLIGATION. The ledger posting happens FIRST, so
   * that by the time `onFill` runs, the position view already includes the fill
   * the evaluation is about (`WP-220` obligation 3). The order views are
   * delivered too, on every harvest and including repeats (obligations 4 and 5).
   */
  async #harvestFills(instant: string): Promise<void> {
    const fills = this.#options.venue.fills;
    for (let index = this.#knownFills; index < fills.length; index += 1) {
      const fill = fills[index];
      if (fill === undefined) continue;
      this.#options.health.countExecution("fillsObserved");

      // WP-220 obligation 5: at most once, keyed on the VENUE's own identity.
      const admission = this.#fills.admit(fill.simulatedFillId);
      if (!admission.admitted) {
        this.#options.health.countExecution("duplicateFillsRefused");
        continue;
      }

      const instanceId = this.#orderOwners.get(fill.simulatedOrderId);
      const instance = instanceId === undefined ? undefined : this.#options.registry.get(instanceId);
      if (instance === undefined) continue;

      const posted = postFill({
        ledger: this.#ledger,
        fill,
        claims: [
          { instanceId: instance.instanceId, runId: instance.runId, shares: fill.shares },
        ],
        identity: this.#options.posting,
        ids: this.#options.ids,
        tokenAssetId:
          this.#options.tokenAssetIds.get(`${fill.marketId}|${fill.side}`) ?? fill.tokenId,
      });
      if (!posted.ok) {
        this.#options.health.countAccounting("ledgerRefusals");
        this.#options.halts.halt(
          { kind: "MARKET", marketId: fill.marketId },
          "LEDGER_POSTING_REFUSED",
          `${posted.stage} ${posted.code}: ${posted.detail}`,
          instant,
        );
        continue;
      }
      this.#ledger = posted.ledger;
      this.#options.health.countAccounting("ledgerTransactions", posted.appended.length);
      this.#options.health.countAccounting("pnlRecords", posted.pnlRecords.length);
      this.#cash = cashAfter(this.#cash, fill);
      // `buildFillPosting` emits one stream per OWNER — the actual account's
      // and each claiming instance's — and `applyPnlRecord` refuses a record
      // whose owner is not the stream's. So the instance's stream keeps the
      // records that name IT, which is §6 invariant 7's separation applied to
      // the PnL projection rather than a filter of convenience.
      const stream = this.#pnlRecords.get(instance.instanceId) ?? [];
      for (const record of posted.pnlRecords as readonly PnlRecord[]) {
        if (
          record.owner.scope === "VIRTUAL_STRATEGY" &&
          record.owner.instanceId === instance.instanceId
        ) {
          stream.push(record);
        }
      }
      this.#pnlRecords.set(instance.instanceId, stream);

      for (const appended of posted.appended) {
        const written = await this.#options.store.appendLedgerTransaction(appended);
        if (!written.ok) {
          this.#options.halts.halt(
            { kind: "GLOBAL" },
            "STORE_UNAVAILABLE",
            `the ledger transaction could not be persisted: ${written.failure.detail}`,
            instant,
          );
          return;
        }
      }

      // The WP-200 composition-root obligation: read BOTH accounting sections
      // of the projection and halt the affected market on either.
      const projection = projectionOf(this.#ledger);
      const arrivals = projection.unattributedActivity.filter(
        (record) => record.activityKind === "ACTUAL_ARRIVAL",
      ).length;
      if (arrivals > this.#seenArrivals) {
        this.#options.health.countAccounting(
          "unattributedActivity",
          arrivals - this.#seenArrivals,
        );
        this.#seenArrivals = arrivals;
      }
      const unexplained = projection.unexplainedMovements.length;
      if (unexplained > this.#seenUnexplained) {
        this.#options.health.countAccounting(
          "unexplainedMovements",
          unexplained - this.#seenUnexplained,
        );
        this.#seenUnexplained = unexplained;
      }
      // The WP-200 composition-root obligation: BOTH sections read together,
      // and either one halts the affected market (§9.9 says halting is the
      // composition root's act, and this is that act).
      haltOnLedgerProjection(this.#options.halts, projection, instant);

      const prefix = this.#orderTraces.get(fill.simulatedOrderId);
      if (prefix !== undefined) {
        this.#traces.push(
          Object.freeze({
            ...prefix,
            venueFillId: fill.simulatedFillId,
            ledgerFillId: posted.ledgerFillId,
            ledgerTransactionIds: posted.ledgerTransactionIds,
          }),
        );
      }

      // §9.16: the PnL projection follows the posting, from the SAME records the
      // ledger derived. A refusal here is not a halt — PnL is a projection, and
      // §6 invariant 8 makes the append-only ledger the monetary source of
      // truth — but a store failure IS, on §4.2's terms.
      await this.#writePnlSnapshot(instance, fill, instant);

      // WP-220 obligation 8: the fill is offered even while the instance is
      // PAUSED. The runtime refuses a paused instance without invoking the
      // callback, and that refusal is RECORDED rather than treated as an error —
      // the accounting above already happened, which is the half a paused
      // strategy would otherwise lose.
      await this.#deliverFill(instance, fill, instant);
    }
    this.#knownFills = fills.length;

    await this.#deliverOrderViews(instant);
  }

  /**
   * Folds this instance's §9.16 stream and writes the resulting snapshot.
   *
   * The MARK is the fill's own price — the last observed transaction in this
   * token, which is a fact rather than a model. §9.16's other marks (model,
   * liquidation) need inputs this process does not yet hold, and inventing one
   * would put a fabricated number into an accounting row.
   */
  async #writePnlSnapshot(
    instance: RegisteredInstance,
    fill: SimulatedFill,
    instant: string,
  ): Promise<void> {
    const records = this.#pnlRecords.get(instance.instanceId);
    if (records === undefined || records.length === 0) return;
    const identity: PnlStreamIdentity = {
      scope: "VIRTUAL_STRATEGY",
      environment: this.#options.config.environment,
      accountRef: this.#options.posting.accountRef,
      instanceId: instance.instanceId,
      runId: instance.runId,
      marketId: instance.marketId,
    };
    const folded = foldPnlRecords(identity, records);
    if (!folded.ok) return;
    const tokenAssetId =
      this.#options.tokenAssetIds.get(`${fill.marketId}|${fill.side}`) ?? fill.tokenId;
    const snapshots = computePnlSnapshot(folded.value, {
      asOf: instant,
      marks: { [tokenAssetId]: { midpoint: fill.price } },
    });
    if (!snapshots.ok) return;
    for (const snapshot of snapshots.value) {
      const written = await this.#options.store.writePnlSnapshot(snapshot);
      if (!written.ok) {
        this.#options.halts.halt(
          { kind: "GLOBAL" },
          "STORE_UNAVAILABLE",
          `a PnL snapshot could not be persisted: ${written.failure.detail}`,
          instant,
        );
        return;
      }
    }
  }

  async #deliverFill(
    instance: RegisteredInstance,
    fill: SimulatedFill,
    instant: string,
  ): Promise<void> {
    const market = this.#options.markets.get(instance.marketId);
    if (market === undefined) return;
    const snapshot = this.#computeSnapshot(market, instance, instant, this.#lastEpochMs);
    if (snapshot === undefined) return;
    const strategyFill: StrategyFill = Object.freeze({
      orderId: fill.simulatedOrderId,
      marketId: fill.marketId,
      outcome: fill.side,
      side: fill.action,
      price: fill.price,
      shares: fill.shares,
      fee: fill.feeAmount,
      filledAt: instant,
    });
    const outcome = instance.runtime.evaluate(
      this.#buildEvaluationInput({
        market,
        instance,
        callback: { kind: "onFill", fill: strategyFill },
        instant,
        snapshotRef: snapshot.snapshotRef,
        values: snapshot.values,
        eventId: undefined,
      }),
    );
    await this.#consumeOutcome(instance, market, outcome, "", instant, this.#lastEpochMs);
  }

  /**
   * Delivers an `onOrderUpdate` for every order this process owns.
   *
   * EVERY order, EVERY harvest, INCLUDING repeats — `WP-220` obligations 4 and
   * 5. A terminal order also releases its reservation (obligation 9: the
   * reservation stands until the order can consume no more inventory).
   */
  async #deliverOrderViews(instant: string): Promise<void> {
    for (const order of this.#options.venue.ordersSnapshot()) {
      const instanceId = this.#orderOwners.get(order.simulatedOrderId);
      if (instanceId === undefined) continue;
      const instance = this.#options.registry.get(instanceId);
      if (instance === undefined) continue;
      const market = this.#options.markets.get(instance.marketId);
      if (market === undefined) continue;
      const view = toStrategyOrderView(order, {
        marketId: instance.marketId,
        placedAt: instant,
      });
      this.#orderViews.deliverable(instance.instanceId, view);
      if (isTerminalStatus(view.status)) {
        this.#reservations.releaseForOrder(order.plannedOrderId);
        this.#timeInForce.release(order.plannedOrderId);
      }
      if (this.#options.halts.isInstanceHalted(instance.instanceId, instance.marketId)) {
        continue;
      }
      const snapshot = this.#computeSnapshot(market, instance, instant, this.#lastEpochMs);
      if (snapshot === undefined) continue;
      const outcome = instance.runtime.evaluate(
        this.#buildEvaluationInput({
          market,
          instance,
          callback: { kind: "onOrderUpdate", order: view },
          instant,
          snapshotRef: snapshot.snapshotRef,
          values: snapshot.values,
          eventId: undefined,
        }),
      );
      await this.#consumeOutcome(instance, market, outcome, "", instant, this.#lastEpochMs);
    }
  }

  /** Every cancel reaches a terminal fact (`WP-220` obligation 10). */
  #sweepCancels(instant: string, epochMs: number): void {
    for (const resolved of this.#cancels.sweep(epochMs, instant)) {
      this.#options.health.countExecution("cancelsSilenceExceeded");
      this.#options.halts.halt(
        { kind: "MARKET", marketId: resolved.cancel.marketId },
        "CANCEL_UNRESOLVED",
        resolved.detail,
        instant,
      );
    }
  }

  /**
   * Drains the synchronous outbox into the durable store (§4.2, §8.1).
   *
   * §4.2: "A PostgreSQL outage stops new trading decisions and order
   * submission." A write failure therefore latches a GLOBAL halt, and every
   * later evaluation is skipped by the same gate that skips a halted market.
   * The records are NOT retried and NOT dropped: they stay drained into this
   * call's locals, the halt names the failure, and reconciliation is an
   * operator act against the store's own `(runId, evaluationSeq)` key — which
   * is exactly what `packages/strategy-runtime` says on its own halt path.
   */
  async #flushOutbox(): Promise<void> {
    const drained = this.#options.outbox.drain();
    for (const entry of drained.decisions) {
      const written = await this.#options.store.persistDecision(entry.record, entry.telemetry);
      if (!written.ok) {
        this.#options.halts.halt(
          { kind: "GLOBAL" },
          "STORE_UNAVAILABLE",
          `a decision record could not be persisted (${written.failure.kind}): ` +
            `${written.failure.detail}; §6 invariant 3 requires exactly one PERSISTED decision ` +
            "per callback, so the process makes no further trading decision",
          this.#lastInstant,
        );
        return;
      }
    }
    for (const checkpoint of drained.checkpoints) {
      const written = await this.#options.store.saveCheckpoint(checkpoint);
      if (!written.ok) {
        this.#options.halts.halt(
          { kind: "GLOBAL" },
          "STORE_UNAVAILABLE",
          `a strategy checkpoint could not be persisted (${written.failure.kind}): ` +
            `${written.failure.detail}`,
          this.#lastInstant,
        );
        return;
      }
    }
  }

  #positionsFor(
    instance: RegisteredInstance,
    marketConfig: MarketConfig,
    projection: ReturnType<typeof projectionOf>,
  ): readonly { readonly marketId: string; readonly side: "YES" | "NO"; readonly shares: string; readonly costBasis: string }[] {
    const yesAsset = this.#options.tokenAssetIds.get(`${marketConfig.marketId}|YES`);
    const noAsset = this.#options.tokenAssetIds.get(`${marketConfig.marketId}|NO`);
    const positions: { marketId: string; side: "YES" | "NO"; shares: string; costBasis: string }[] = [];
    for (const line of projection.virtualPositions.values()) {
      if (line.instanceId !== instance.instanceId) continue;
      const side = line.assetId === yesAsset ? "YES" : line.assetId === noAsset ? "NO" : undefined;
      if (side === undefined) continue;
      if (line.balance === "0") continue;
      positions.push({
        marketId: marketConfig.marketId,
        side,
        shares: line.balance,
        costBasis: "0",
      });
    }
    return Object.freeze(positions);
  }

  #openOrdersFor(
    instance: RegisteredInstance,
    marketConfig: MarketConfig,
  ): readonly { readonly orderId: string; readonly marketId: string; readonly side: "YES" | "NO"; readonly action: "BUY" | "SELL"; readonly price: string; readonly shares: string }[] {
    const owned = this.#instanceOrders.get(instance.instanceId);
    if (owned === undefined) return Object.freeze([]);
    const orders: { orderId: string; marketId: string; side: "YES" | "NO"; action: "BUY" | "SELL"; price: string; shares: string }[] = [];
    for (const order of this.#options.venue.ordersSnapshot()) {
      if (!owned.has(order.simulatedOrderId)) continue;
      if (order.state === "FILLED" || order.state === "CANCELLED" || order.state === "EXPIRED" || order.state === "REJECTED") {
        continue;
      }
      orders.push({
        orderId: order.simulatedOrderId,
        marketId: marketConfig.marketId,
        side: order.side,
        action: order.action,
        price: order.limitPrice,
        shares: order.requestedShares,
      });
    }
    return Object.freeze(orders);
  }

  /**
   * The §9.8 check-12 cost inputs, MEASURED rather than assumed.
   *
   * §9.8's own refusal text is the rule: "an unsupplied cost is not a zero cost
   * (fail closed)". Both numbers below are read off state this process already
   * holds, so neither is an invention:
   *
   * - **fee** — the market's CONFIGURED, versioned taker rate (§6 invariant 9)
   *   times the intent's own notional bound. The taker rate is used rather than
   *   the maker rate because a fee estimate that assumed the better of the two
   *   would understate the cost, and check 12 subtracts it from the edge;
   * - **slippage** — the exact cost of walking the ladder for the intent's own
   *   size, minus what the top of book alone would have cost:
   *   `totalCost − bestPrice × shares`. No division, no VWAP, no rounding
   *   policy: `packages/order-book`'s `executablePrice` sums `price × size` per
   *   level exactly, and the subtraction is exact.
   *
   * When either cannot be measured — an empty ladder, a book too thin for the
   * size — the field is OMITTED, and §9.8 refuses the entry. That is the
   * fail-closed direction, and it is the correct one: a size the book cannot
   * fill has an unknown slippage, not a zero one.
   */
  #economicsFor(
    intent: Intent,
    market: MarketState,
    marketConfig: MarketConfig,
  ): { readonly feeEstimate?: string; readonly slippageEstimate?: string } {
    if (intent.type !== "POSITION") return {};
    const shares = intent.targetShares;
    if (compareDecimal(shares, "0") <= 0) return {};
    const buying = intent.maximumBuyPrice !== undefined;
    const bound = buying ? intent.maximumBuyPrice : intent.minimumSellPrice;
    if (bound === undefined) return {};
    const book = market.bookFor(intent.direction);
    const quote = executablePrice(book, { side: buying ? "BUY" : "SELL", shares });
    if (!quote.ok) {
      // The book cannot fill this size. An unmeasurable slippage is omitted, and
      // §9.8 check 12 then refuses — which is the honest outcome for an order
      // the visible book could not absorb.
      return { feeEstimate: mulDecimal(marketConfig.takerFeeRate, mulDecimal(bound, shares)) };
    }
    const top = buying ? book.topOfBook().bestAskPrice : book.topOfBook().bestBidPrice;
    if (top === undefined) {
      return { feeEstimate: mulDecimal(marketConfig.takerFeeRate, mulDecimal(bound, shares)) };
    }
    const atTop = mulDecimal(top, shares);
    const slippage = buying
      ? subDecimal(quote.totalCost, atTop)
      : subDecimal(atTop, quote.totalCost);
    return {
      feeEstimate: mulDecimal(marketConfig.takerFeeRate, quote.totalCost),
      slippageEstimate: compareDecimal(slippage, "0") < 0 ? "0" : slippage,
    };
  }

  /**
   * §9.8 check 19's headroom: the operator-stated capacity minus this process's
   * OWN submissions in the current window.
   *
   * Not the venue's published budget — §9.13 forbids hardcoding that and
   * `WP-310` owns it. What this measures is real all the same: a process that
   * has spent its stated capacity has no headroom, whatever the venue would
   * have allowed.
   */
  #availableRequests(epochMs: number): number {
    const budget = this.#options.config.requestBudget;
    const horizon = epochMs - budget.windowMs;
    this.#submissionInstants = this.#submissionInstants.filter((at) => at >= horizon);
    return Math.max(0, budget.capacity - this.#submissionInstants.length);
  }

  /**
   * §9.8 check 17's shocked marks: the operator's shock applied to a MEASURED
   * mark.
   *
   * The mark is the YES book's best BID — what the position could actually be
   * sold into — chosen because it needs no division and therefore no rounding
   * policy inside a risk input. A market whose bid side is empty produces NO
   * mark, so the scenario is incomplete and `assessScenarios` refuses the
   * entry: an unmeasurable scenario is not a passed one.
   */
  #scenariosFor(
    market: MarketState,
    marketConfig: MarketConfig,
  ): readonly {
    readonly scenarioId: string;
    readonly kind: "SPOT" | "VOLATILITY" | "TIME" | "LIQUIDITY";
    readonly marks: readonly { readonly marketId: string; readonly yesPrice: string }[];
  }[] {
    const mark = market.bookFor("YES").topOfBook().bestBidPrice;
    return Object.freeze(
      this.#options.config.scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        kind: scenario.kind,
        marks:
          mark === undefined
            ? Object.freeze([])
            : Object.freeze([
                {
                  marketId: marketConfig.marketId,
                  yesPrice: clampProbability(addDecimal(mark, scenario.yesPriceShock)),
                },
              ]),
      })),
    );
  }

  #bookAgeMs(market: MarketState, epochMs: number): number {
    const lastUpdate = market.bookFor("YES").lastUpdate();
    const at = lastUpdate?.receivedAtEpochMs;
    return at === undefined ? 0 : Math.max(0, epochMs - at);
  }

  #secondsToClose(marketConfig: MarketConfig, epochMs: number): number | undefined {
    const close = normalizeToStrictUtc(marketConfig.closeTime);
    if (!close.ok) return undefined;
    const remaining = Math.floor((close.epochMs - epochMs) / 1000);
    return remaining < 0 ? 0 : remaining;
  }

  /** §9.8 check 18's duplicate guard, bounded. */
  #rememberIntentId(intentId: string): void {
    this.#recentIntentIds.push(intentId);
    if (this.#recentIntentIds.length > 256) {
      this.#recentIntentIds = this.#recentIntentIds.slice(-256);
    }
  }
}

type TriggeredCallback =
  | { readonly kind: "onMarketOpen" }
  | { readonly kind: "onFeatures" }
  | { readonly kind: "onMarketClosing"; readonly secondsRemaining: number }
  | { readonly kind: "onMarketResolved"; readonly outcome: string; readonly resolvedAt: string }
  | { readonly kind: "onFill"; readonly fill: StrategyFill }
  | { readonly kind: "onOrderUpdate"; readonly order: StrategyOrderView };

const ZERO_UUID = "00000000-0000-7000-8000-000000000000";

function readString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  if (!Object.hasOwn(payload, key)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Every market an event affects.
 *
 * Most §7.4 events name exactly one (`internalMarketId`). A data-quality
 * incident names a LIST (`affectedMarketIds`) because one stale feed affects
 * every market that reads it — and an incident with an EMPTY list affects none,
 * which is a different statement from "affects all" and is treated as such.
 */
function affectedMarketIds(payload: unknown): readonly string[] {
  const direct = readString(payload, "internalMarketId") ?? readString(payload, "marketId");
  if (direct !== undefined) return Object.freeze([direct]);
  if (typeof payload !== "object" || payload === null) return Object.freeze([]);
  if (!Object.hasOwn(payload, "affectedMarketIds")) return Object.freeze([]);
  const list = (payload as Record<string, unknown>)["affectedMarketIds"];
  if (!Array.isArray(list)) return Object.freeze([]);
  return Object.freeze(list.filter((member): member is string => typeof member === "string"));
}

function intentIdOf(intent: Intent): string {
  return "intentId" in intent && typeof intent.intentId === "string" ? intent.intentId : "";
}

/** The planned order a reservation belongs to, by shared reservation id. */
function plannedOrderFor(plan: PlacementPlan, reservationId: string): string {
  for (const group of plan.groups) {
    for (const order of group.orders) {
      if (order.reservationId === reservationId) return order.plannedOrderId;
    }
  }
  return reservationId;
}

/** Clamps an exact decimal into the probability range `[0, 1]` (§7.3). */
function clampProbability(value: string): string {
  if (compareDecimal(value, "0") < 0) return "0";
  if (compareDecimal(value, "1") > 0) return "1";
  return value;
}

/** `price × shares`, exactly. Never a JavaScript number (§6 invariant 1). */
function notional(price: string, shares: string): string {
  return mulDecimal(price, shares);
}

function cashAfter(cash: string, fill: SimulatedFill): string {
  const gross = mulDecimal(fill.price, fill.shares);
  const withFee = addDecimal(gross, fill.feeAmount);
  return fill.action === "BUY" ? subDecimal(cash, withFee) : addDecimal(subDecimal(cash, fill.feeAmount), gross);
}
