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
 * gates every evaluation — and there are exactly FOUR of them, listed here so
 * the claim can be checked rather than believed:
 *
 * | Gate | Where |
 * | --- | --- |
 * | a halted MARKET is not evaluated | `#processEvent`, `#evaluateMarket` |
 * | a halted INSTANCE is not evaluated | `#evaluateMarket` |
 * | a halted instance is not delivered a FILL | `#harvestFills` |
 * | a halted instance is not delivered an ORDER VIEW | `#deliverOrderViews` |
 *
 * The ACCOUNTING is not gated and must not be: the ledger posting, the cash
 * update, the PnL fold and the trace record all happen for a halted scope too,
 * because the money moved and §6 invariant 8 makes the append-only ledger the
 * source of truth whatever this process's own state is. The books stay
 * truthful; the strategy does not act.
 *
 * > **Corrected 2026-09-05 (remediation round 1).** The third row was NOT true
 * > at the reviewed tip: a fill whose own iteration latched a halt — a refused
 * > ledger projection, a failed PnL write — was still delivered to the
 * > strategy, and the `exit` decision it produced was persisted AFTER a
 * > GLOBAL/FULL_HALT (review round 1, MEDIUM-1).
 */

import {
  addDecimal,
  compareDecimal,
  isCanonicalDecimalString,
  mulDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";
import { computeFeatureSnapshot } from "@polymarket-bot/features";
import { executablePrice } from "@polymarket-bot/order-book";
import type { Intent } from "@polymarket-bot/domain";
import type { EvaluationInput, EvaluationOutcome } from "@polymarket-bot/strategy-runtime";
import type { ExecutionPlan, PlacementPlan } from "@polymarket-bot/execution-planner";
import type {
  ExecutionResult,
  SimulatedFill,
  SimulatedOrder,
  TimeInForce,
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
  postFill,
  projectionOf,
  type DeterministicIdFactory,
  type PostingIdentity,
  type TraceLink,
} from "./accounting.js";
import { requestFor, type AllocatorGate } from "./allocation.js";
import { CancelLedger } from "./cancels.js";
import type { InstanceConfig, MarketConfig, TraderConfig } from "./config.js";
import { readEventEnvelope } from "./event-door.js";
import { FillDeduplicator } from "./fills.js";
import { haltOnLedgerProjection, type HaltController } from "./halt.js";
import type { HealthSnapshot, HealthState } from "./health.js";
import type { InstanceRegistry, RegisteredInstance } from "./instances.js";
import type { MarketState } from "./market-state.js";
import {
  DEFAULT_RETENTION,
  OrderTombstones,
  RetentionLog,
  UNREADABLE_BOOKED_SHARES,
  settlementBlocker,
  type OrderLifecycleMetrics,
  type RetentionBounds,
  type RetentionHealth,
} from "./order-lifecycle.js";
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
import { TRADER_RUN_MODE } from "./safety.js";
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
  /**
   * The §9.7 capital allocator, assembled by the composition root.
   *
   * REQUIRED, and deliberately so (review round 1, HIGH-1): §8.1 puts
   * "allocate capital" between the persisted decision and the risk checks, and
   * §9.8 check 14 fails closed without the verdict it produces. A loop that
   * could be constructed without one is a loop that can fabricate the verdict.
   */
  readonly allocator: AllocatorGate;
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
  /**
   * `TRDR-4` — the bounds of the loop's three in-process audit logs and of its
   * settled-order tombstone map. Every field is optional and defaults to
   * {@link DEFAULT_RETENTION} (argued there from the scoping census's sizes);
   * each must be a positive safe integer, and the constructor refuses anything
   * else. An eviction is counted on `seams.retention` / `seams.orders`.
   */
  readonly retention?: RetentionBounds;
}

/**
 * `CoreLoop.health()`'s answer: a {@link HealthSnapshot} whose `TRDR-4` seams
 * are always present. `HealthSnapshot` keeps them optional only for holders of
 * no loop (see `health.ts`, `SeamHealth.orders`).
 */
export type LoopHealthSnapshot = HealthSnapshot & {
  readonly seams: HealthSnapshot["seams"] & {
    readonly orders: OrderLifecycleMetrics;
    readonly retention: RetentionHealth;
  };
};

/**
 * The per-order state `CoreLoop` holds, as sizes — `TRDR-4`'s observation
 * surface for the bounded-state claim. Every map is keyed by the VENUE's order
 * id.
 */
export interface RetainedOrderState {
  /** `#orderOwners` — venue order id → owning instance. */
  readonly owners: number;
  /** `#instanceOrders` — how many instances still hold an order set. */
  readonly instanceOrderSets: number;
  /** `#instanceOrders` — the venue order ids across every instance's set. */
  readonly instanceOrderIds: number;
  /** `#orderTraces` — the prunable fill-join LOOKUP (not the provenance log). */
  readonly traceLookup: number;
  /** `#bookedShares` — the per-order booked-fill counter. */
  readonly bookedShares: number;
  /** Orders retired under R1 but not yet settled. */
  readonly retiredUnsettled: number;
  /** `OrderViewTracker` — orders whose last delivered view is remembered. */
  readonly orderViews: number;
  /** The settled-order tombstone map (bounded). */
  readonly tombstones: number;
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
  /** Keyed by PLANNED order id (`reservations.ts`). */
  readonly #reservations = new ReservationBook();
  /** Keyed by PLANNED order id (`pipeline.ts`). */
  readonly #timeInForce = new OrderTimeInForceBook();
  readonly #reference: ReferenceState;

  // --- the per-order state (`TRDR-4`) ---------------------------------------
  //
  // TWO KEYS, and each map uses its own. The maps below are keyed by the
  // VENUE's order id — for `SimulatedVenue`, `SimulatedOrder.simulatedOrderId`
  // — because that is what a fill and an order view name. The three RELEASE
  // books (`#reservations`, the allocator, `#timeInForce`) are keyed by the
  // PLANNER's `plannedOrderId`, because they are taken before the venue has
  // assigned anything. The simulator happens to make the two equal
  // (`venue.ts`), a real venue will not, and nothing here relies on it.
  //
  // Every entry below is created at SUBMISSION and deleted only at SETTLEMENT
  // (`#settle`): a terminal order, observed at a harvest boundary, whose booked
  // fill shares equal the venue's `filledShares`, retired under R1, with no
  // pending cancel naming it. A settled order leaves a bounded tombstone.

  /**
   * `venueOrderId -> the trace prefix built when its plan was submitted` — the
   * prunable LOOKUP a fill is joined through. The append-only PROVENANCE LOG
   * that backs {@link CoreLoop.orderProvenance} is `#provenance`, separately.
   */
  readonly #orderTraces = new Map<string, Omit<TraceLink, "venueFillId" | "ledgerFillId" | "ledgerTransactionIds">>();
  /** `instanceId -> venue order ids it owns and has not settled`, for `ctx.orders()`. */
  readonly #instanceOrders = new Map<string, Set<string>>();
  /** `venueOrderId -> owning instanceId`, for fill attribution and delivery. */
  readonly #orderOwners = new Map<string, string>();
  /** `venueOrderId -> the fill shares BOOKED for it`, an exact decimal (condition (b)). */
  readonly #bookedShares = new Map<string, string>();
  /** Venue order ids RETIRED under R1 and not yet settled. */
  readonly #retired = new Set<string>();
  /** Venue order ids whose settlement mismatch has been COUNTED (once per order). */
  readonly #mismatched = new Set<string>();
  /** `venueOrderId -> instanceId` for SETTLED orders, bounded. */
  readonly #tombstones: OrderTombstones;
  #settled = 0;
  #unownedFills = 0;
  #lateFillsAfterSettlement = 0;
  #settleMismatches = 0;

  #ledger: Ledger;
  #cash: string;
  #recentIntentIds: string[] = [];
  #lastInstant: string;
  #lastEpochMs = 0;

  /** The §6 invariant 4 chains, in fill order — bounded retention (`TRDR-4`). */
  readonly #traces: RetentionLog<TraceLink>;
  /** Every persisted decision, in evaluation order — bounded retention (`TRDR-4`). */
  readonly #decisions: RetentionLog<DecisionTrace>;
  /**
   * Every accepted order's trace prefix, APPEND-ONLY, in submission order —
   * bounded retention (`TRDR-4`). Split from the prunable `#orderTraces`
   * lookup so settling an order never shortens the provenance record.
   */
  readonly #provenance: RetentionLog<
    Readonly<Omit<TraceLink, "venueFillId" | "ledgerFillId" | "ledgerTransactionIds">>
  >;
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
   *
   * NOT BOUNDED by `TRDR-4`, and said so rather than implied: bounding it needs
   * a snapshot-plus-tail fold that stays byte-identical (§6 invariant 8,
   * §12.4), which is the queued `LOOPMEM-FOLD` item. The in-memory `Ledger` is
   * unbounded for the same reason. This loop is therefore NOT memory-bounded.
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
    const retention = options.retention ?? {};
    this.#decisions = new RetentionLog({
      name: "decision",
      maximumRetained: retention.decisions ?? DEFAULT_RETENTION.decisions,
    });
    this.#traces = new RetentionLog({
      name: "trace",
      maximumRetained: retention.traces ?? DEFAULT_RETENTION.traces,
    });
    this.#provenance = new RetentionLog({
      name: "order provenance",
      maximumRetained: retention.provenance ?? DEFAULT_RETENTION.provenance,
    });
    this.#tombstones = new OrderTombstones({
      maximumRemembered: retention.tombstones ?? DEFAULT_RETENTION.tombstones,
    });
  }

  /**
   * The §6 invariant 4 chains this run produced, in fill order.
   *
   * `TRDR-4`: the RETAINED WINDOW — the newest `maximumRetained` chains, oldest
   * first; `seams.retention.traces.evicted` counts what fell out of it. The
   * default bound is far above every fixture, so no fixture sees an eviction.
   */
  traces(): readonly TraceLink[] {
    return Object.freeze(this.#traces.entries());
  }

  /**
   * Every order's §6 invariant 4 trace PREFIX — event, feature snapshot,
   * decision, intent, approved intent, plan, submission attempt and venue order
   * — as recorded at SUBMISSION, in submission order, whether the order later
   * filled or not.
   *
   * Published because {@link traces} holds a chain only once a FILL completes
   * it, so an order that rested and was withdrawn unfilled appears there not at
   * all; this is the record that names such an order's origin by id
   * (`RECON-2`). Read-only: each entry is a fresh frozen copy in a fresh frozen
   * list, so nothing a caller does to the answer reaches the loop.
   *
   * `TRDR-4`: read from the APPEND-ONLY provenance log, which settling an order
   * never touches, and it returns the RETAINED WINDOW — the newest
   * `maximumRetained` records, oldest first; `seams.retention.provenance`
   * counts evictions. The default bound is far above every fixture.
   */
  orderProvenance(): readonly Readonly<
    Omit<TraceLink, "venueFillId" | "ledgerFillId" | "ledgerTransactionIds">
  >[] {
    return Object.freeze(
      this.#provenance.entries().map((prefix) => Object.freeze({ ...prefix })),
    );
  }

  /**
   * Every persisted decision, in evaluation order.
   *
   * `TRDR-4`: the RETAINED WINDOW — the newest `maximumRetained` decisions,
   * oldest first; `seams.retention.decisions.evicted` counts what fell out.
   * The durable store receives every decision regardless (the outbox), so a
   * bound here shortens only this in-process accessor.
   */
  decisions(): readonly DecisionTrace[] {
    return Object.freeze(this.#decisions.entries());
  }

  /**
   * The sizes of the loop's per-order maps (`TRDR-4`). Read-only numbers; the
   * observation surface for "the per-order state tracks WORKING orders, not
   * history" — see {@link RetainedOrderState}.
   */
  retainedOrderState(): RetainedOrderState {
    let instanceOrderIds = 0;
    for (const owned of this.#instanceOrders.values()) instanceOrderIds += owned.size;
    return Object.freeze({
      owners: this.#orderOwners.size,
      instanceOrderSets: this.#instanceOrders.size,
      instanceOrderIds,
      traceLookup: this.#orderTraces.size,
      bookedShares: this.#bookedShares.size,
      retiredUnsettled: this.#retired.size,
      orderViews: this.#orderViews.metrics().tracked,
      tombstones: this.#tombstones.size,
    });
  }

  /** The §9.16 records one instance's stream has accumulated, in order. */
  pnlRecords(instanceId: string): readonly PnlRecord[] {
    return Object.freeze([...(this.#pnlRecords.get(instanceId) ?? [])]);
  }

  /**
   * The exact capital one held position cost — §9.7's "capital already spent".
   *
   * Published because it is the number BOTH the §9.7 exposure table and the
   * §9.8 worst-case builder consume, and an operational surface that could not
   * read it could not tell a position that consumed nothing from a book that
   * forgot what it paid.
   */
  costBasisOf(instanceId: string, marketId: string, side: "YES" | "NO"): string {
    return this.#options.allocator.costBasisOf(instanceId, marketId, side);
  }

  /**
   * The venue's `ExecutionPolicy.timeInForceFor` answer for one planned order.
   *
   * Published because the venue asks the COMPOSITION ROOT for it — "a silently
   * assumed FAK would change every unfilled remainder's fate" — and the answer
   * is recorded here, at plan time, from the emitting intent's own tag. A venue
   * policy that reads this cannot invent one: an order whose value was never
   * recorded answers `undefined`, and the policy must refuse rather than guess.
   */
  timeInForceFor(plannedOrderId: string): TimeInForce | undefined {
    return this.#timeInForce.get(plannedOrderId);
  }

  ledger(): Ledger {
    return this.#ledger;
  }

  queueMetrics(): readonly QueueMetrics[] {
    return Object.freeze([this.#queue.metrics(this.#lastEpochMs)]);
  }

  /**
   * The whole health surface, including the SEAMS' own counters.
   *
   * Review round 1, MEDIUM-2: every seam below already published a `metrics()`
   * and none of them had a caller outside its own unit test, so the claims that
   * rested on them ("`evictions > 0` on the health surface says so") were
   * false. This method is the caller.
   */
  health(): LoopHealthSnapshot {
    const orders: OrderLifecycleMetrics = Object.freeze({
      tracked: this.#orderOwners.size,
      settled: this.#settled,
      ...this.#tombstones.metrics(),
      unownedFills: this.#unownedFills,
      lateFillsAfterSettlement: this.#lateFillsAfterSettlement,
      settleMismatches: this.#settleMismatches,
    });
    const retention: RetentionHealth = Object.freeze({
      decisions: this.#decisions.metrics(),
      traces: this.#traces.metrics(),
      provenance: this.#provenance.metrics(),
    });
    return this.#options.health.snapshot({
      asOf: this.#lastInstant,
      halts: this.#options.halts.records(),
      queues: this.queueMetrics(),
      seams: {
        fills: this.#fills.metrics(),
        reservations: this.#reservations.metrics(),
        cancels: this.#cancels.metrics(),
        orderViews: this.#orderViews.metrics(),
        allocator: this.#options.allocator.metrics(),
        orders,
        retention,
      },
      // The cast narrows only what was supplied on the line above: both
      // `TRDR-4` seams are passed, and `HealthState.snapshot` carries every
      // seam it is given.
    }) as LoopHealthSnapshot;
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

  /**
   * This instance's own working orders, for `ctx.orders()` (§7.6).
   *
   * `TRDR-4` (ruling R1): its WORKING orders plus its terminal orders that are
   * not yet RETIRED — a terminal order stays visible here until one delivery of
   * its terminal view was evaluated (so an immediate order that is terminal
   * before any tick is still seen), and is excluded from then on. Until R1 this
   * returned every order the instance had ever placed, terminal ones included,
   * contradicting the SDK's "one of this instance's own working orders".
   */
  #orderViews_(instance: RegisteredInstance, instant: string): readonly StrategyOrderView[] {
    const owned = this.#instanceOrders.get(instance.instanceId);
    if (owned === undefined) return Object.freeze([]);
    const views: StrategyOrderView[] = [];
    for (const order of this.#options.venue.ordersSnapshot()) {
      if (!owned.has(order.simulatedOrderId)) continue;
      if (this.#retired.has(order.simulatedOrderId)) continue;
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
    this.#decisions.append(
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

  /**
   * §8.1 steps 6-9 for one intent.
   *
   * ## The ownership gate (review round 2, HIGH-1)
   *
   * §6 invariant 11: "One active live strategy owns a market in v1. **Other
   * strategies may observe or run in shadow mode.**" ADR-011 §1 spells out what
   * the second half means for a process, and §5 spells out its observable
   * consequence:
   *
   * > "Shadow instances still consume resources. They evaluate, produce
   * > decisions, and write records; **they do not consume venue rate limits,
   * > because they submit nothing.**"
   *
   * A non-`OWNER` instance therefore stops HERE, before an approved-intent id
   * is minted. Everything §8.1 puts BEFORE this point still happens for it — it
   * is evaluated in its §8.2 position, its `DecisionResult` is persisted, its
   * intents are recorded on the decision — and everything after it does not: no
   * allocator commitment, no risk approval, no plan, no order, no fill, no
   * ledger posting, no cash movement.
   *
   * WHY OBSERVE-ONLY RATHER THAN A SHADOW BOOK. ADR-011 §1 describes `SHADOW`
   * as "live data, simulated execution, **independent accounting**", and this
   * process has no second book to be independent of the first: one `#cash`, one
   * `Ledger`, one `SimulatedVenue`, shared by every instance. Routing a
   * non-owner's intent into them and calling the result "shadow" is what
   * produced HIGH-1 — the caps, the collateral check and ADR-011's own
   * ownership gate were all evaluated against a book the order did not execute
   * against. Until a genuinely separate book exists, the truthful reading of
   * invariant 11 with the machinery this process has is the one ADR-011 §5
   * already states: a shadow instance submits nothing.
   *
   * The counted refusal is deliberate. A silently dropped intent is
   * indistinguishable from a strategy that emitted none, and an operator who
   * configured `ownership: "SHADOW"` expecting fills is entitled to see the
   * number of intents this process declined to route.
   */
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
    if (input.instance.ownership !== "OWNER") {
      this.#options.health.countExecution("observeOnlyIntents");
      return;
    }
    const approvedIntentId = this.#options.ids.next();
    const marketConfig = input.market.config;
    const projection = projectionOf(this.#ledger);
    const positions = this.#positionsFor(input.instance, marketConfig, projection);
    const bookAgeMs = this.#bookAgeMs(input.market, input.epochMs);

    // --- step 6: ALLOCATE CAPITAL (§8.1, §9.7) ------------------------------
    // Before the risk checks, exactly where §8.1 puts it, and with the REAL
    // caps this process parsed at startup. Its verdict is handed to §9.8
    // check 14 unaltered — the loop does not read it, does not repair it and
    // has no branch on it.
    const allocation = this.#options.allocator.evaluate({
      intent: input.intent,
      instanceId: input.instance.instanceId,
      accountingMode: SHARED_BOOK_ACCOUNTING_MODE,
      liveOwners: this.#liveOwners(),
      projection,
      availableCollateral: this.#cash,
      approvedIntentId,
      heldShares: (marketId, side) =>
        marketId === marketConfig.marketId
          ? (positions.find((position) => position.side === side)?.shares ?? "0")
          : "0",
    });

    const riskInput = buildRiskEvaluationInput({
      intent: input.intent,
      evaluatedAt: input.instant,
      approvedIntentId,
      // §11 / ADR-010: the ONE mode `safety.ts` lets this process start in. The
      // constant rather than a literal (review round 2, note N4) so the mode the
      // risk engine judges against and the mode the startup gate enforced are
      // the same symbol — a literal here could drift from the gate silently.
      runMode: TRADER_RUN_MODE,
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
      exposures: allocation.exposures,
      allocation: allocation.verdict,
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
    // §9.8 check 18's duplicate guard remembers the ids it can. A `CANCEL` has
    // NO `intentId` — §7.7 gives it none — so `intentIdOf` answers `""` for one,
    // and there is nothing to remember.
    //
    // RISK-2: this line used to push that `""` unconditionally.
    // `packages/risk` types `guards.recentIntentIds` as an array of NON-EMPTY
    // strings, so the FIRST approved safety cancellation poisoned the list and
    // every later evaluation in the process — entry, exit, cancel alike — was
    // refused `RISK_INPUT_INVALID` at the input door. It stayed invisible until
    // RISK-2 let a protective exit through the risk seam at all: only then did
    // this process reach a cancel-then-replace and evaluate anything after it.
    //
    // FIXED AT THE CALLER, DELIBERATELY. The door is right and must not widen:
    // the guard compares this list against `intent.intentId`, so admitting `""`
    // would make check 18 match ID-LESS intents against each other — and the
    // id-less intents are the CANCELs, which §6 invariant 13 says may never be
    // blocked. `test/unit/risk/engine.test.ts` pins the door's refusal.
    const rememberableIntentId = intentIdOf(input.intent);
    if (rememberableIntentId !== "") this.#rememberIntentId(rememberableIntentId);

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
      // --- §9.10: RESERVE BEFORE SUBMISSION, in BOTH books -----------------
      // `ReservationBook` holds the inventory the next PLAN may not use
      // (`WP-220` obligation 9, so the next evaluation's reduction plans
      // against `held − reserved`); the ALLOCATOR holds the §9.7 commitment
      // every cap compares against. Both are keyed on the planned order, both
      // are taken here, and both are released at the same two moments.
      const allocatorEntries = placement.reservations.map((requirement) => ({
        plannedOrderId: plannedOrderFor(placement, requirement.reservationId),
        request: requestFor({
          reservationId: requirement.reservationId,
          instanceId: input.instance.instanceId,
          accountingMode: SHARED_BOOK_ACCOUNTING_MODE,
          leg: {
            marketId: requirement.marketId,
            side: requirement.side,
            action: requirement.action,
            price: requirement.price,
            shares: requirement.shares,
          },
          market: this.#options.allocator.marketOf(requirement.marketId),
        }),
      }));
      const reserved = this.#options.allocator.applyForPlan({
        entries: allocatorEntries,
        liveOwners: this.#liveOwners(),
        projection: projectionOf(this.#ledger),
        availableCollateral: this.#cash,
      });
      if (!reserved.ok) {
        // §9.10 is "reserve BEFORE submission", so a reservation the allocator
        // refuses is a plan that is NOT submitted. Nothing was applied — the
        // gate applies a plan's legs all or none — so no RESERVATION needs
        // releasing. The refusal CODES are counted by the gate itself
        // (`seams.allocator.refusalsByCode`), so this process has exactly one
        // authority on what the allocator said.
        //
        // `TRDR-4`: the TIME-IN-FORCE entries recorded above DO need releasing.
        // They were recorded per planned order before the allocator was asked,
        // and these planned orders never reach the venue — so no terminal view
        // will ever release them, and every refused plan used to leak one
        // entry per planned order into `#timeInForce` for the life of the
        // process. Keyed by the PLANNED order id, as they were recorded.
        for (const group of placement.groups) {
          for (const order of group.orders) {
            this.#timeInForce.release(order.plannedOrderId);
          }
        }
        this.#options.health.countExecution("allocationsRefused");
        return;
      }
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
        return;
      }
      this.#releaseRefusedPlacement(placement, result, input.instant);
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
      // Every per-order entry is keyed by the VENUE's order id (see the field
      // comments), created here and deleted only by `#settle`.
      this.#orderOwners.set(order.simulatedOrderId, input.instance.instanceId);
      const owned = this.#instanceOrders.get(input.instance.instanceId) ?? new Set<string>();
      owned.add(order.simulatedOrderId);
      this.#instanceOrders.set(input.instance.instanceId, owned);
      this.#bookedShares.set(order.simulatedOrderId, "0");
      const prefix = Object.freeze({
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
      // The prunable fill-join LOOKUP, and the append-only PROVENANCE LOG: the
      // same prefix, two lifetimes (`TRDR-4`).
      this.#orderTraces.set(order.simulatedOrderId, prefix);
      this.#provenance.append(prefix);
    }
  }

  /**
   * A REFUSED placement returns what it reserved — for every planned order the
   * venue does NOT hold — and keeps it for every order the venue DOES hold.
   *
   * Review round 1, MEDIUM-4: the only release path used to be
   * `#deliverOrderViews`'s terminal-status arm, and a refused plan has no owned
   * order to deliver, so its reservation stayed taken FOREVER — `reserved` grew
   * monotonically, understating `availableCollateral` on the planning surface
   * and the unreserved balance on the strategy's `riskBudget`, until entries
   * starved with no visible cause. The venue said no; the capacity comes back.
   *
   * `TRDR-4` round 1 (finding TRDR4-R1): a refusal is NOT proof that nothing
   * was placed, and releasing EVERY planned order's entries freed the capital,
   * the inventory and the time-in-force of an order still WORKING at the venue
   * — which ADR-006 §9 forbids (never released before terminal). The
   * simulator books a plan's orders one at a time and, when a later one fails
   * (its rate-limit budget, a duplicate id, an execution refusal —
   * `SimulatedVenue`'s `#submitSync`), refuses the WHOLE plan with
   * `orders: []` while the earlier orders stay in its book: RESTING,
   * PARTIALLY_FILLED, or already terminal. A real venue can answer the same
   * way. So each planned order is looked up in the venue's OWN order state (and
   * in the refused answer's `orders`), by its PLANNED order id — the key all
   * three books use:
   *
   * - the venue holds NO order under that id: it was never placed, and its
   *   reservation, allocator commitment and time-in-force are released now;
   * - the venue HOLDS one, in any state: all three are KEPT. The harvest-
   *   boundary release (`#releaseSettledReservations`, which walks every venue
   *   order, owned or not) returns them at the first harvest that sees the
   *   order terminal, after that harvest's fills are booked — the same rule
   *   and the same moment as for an owned order, so nothing is released before
   *   terminal and nothing before the position that replaces it exists.
   *
   * And a plan the venue PARTLY EXECUTED is a reconciliation question (§6
   * invariant 6: an unknown submission is never a silent retry). The answer
   * named no order, so no instance owns the held ones: no owner entry, no
   * `onOrderUpdate`, no `ctx.orders()` view, and a fill of theirs is booked
   * UNATTRIBUTED (`#bookUnownedFill`). The market each held order trades is
   * halted NOW — `UNATTRIBUTED_ACTIVITY`, whose §9.9 action is
   * `RECONCILE_ACCOUNT` — before any later decision of this iteration can plan
   * against it, rather than waiting for a fill that a resting order may never
   * produce. Nothing is dropped and nothing is attributed.
   */
  #releaseRefusedPlacement(
    placement: PlacementPlan,
    result: ExecutionResult,
    instant: string,
  ): void {
    const plannedOrderIds: string[] = [];
    for (const group of placement.groups) {
      for (const order of group.orders) plannedOrderIds.push(order.plannedOrderId);
    }
    const planned = new Set(plannedOrderIds);
    // Keyed by the PLANNED order id: the venue's `simulatedOrderId` is its own
    // id for the order and is only coincidentally equal in the simulator. Both
    // sources count as evidence the venue holds an order — the refused answer's
    // own `orders` (empty from the simulator's `#refuse`, but a venue may list
    // what it did book) and the venue's order state, which is read last so its
    // fresher view wins — because keeping an entry is the fail-closed side.
    const venueHeld = new Map<string, SimulatedOrder>();
    for (const order of [...result.orders, ...this.#options.venue.ordersSnapshot()]) {
      if (planned.has(order.plannedOrderId)) venueHeld.set(order.plannedOrderId, order);
    }
    const held = plannedOrderIds.flatMap((plannedOrderId) => {
      const order = venueHeld.get(plannedOrderId);
      return order === undefined ? [] : [order];
    });

    for (const plannedOrderId of plannedOrderIds) {
      if (venueHeld.has(plannedOrderId)) continue;
      if (this.#reservations.releaseForOrder(plannedOrderId)) {
        this.#options.health.countExecution("reservationsReleasedOnRefusal");
      }
      this.#options.allocator.release(plannedOrderId);
      this.#timeInForce.release(plannedOrderId);
    }
    if (held.length === 0) return;

    const described = held
      .map(
        (order) =>
          `${order.simulatedOrderId} (planned ${order.plannedOrderId}) ${order.state} ` +
          `${order.filledShares}/${order.requestedShares}`,
      )
      .join(", ");
    const refusal = `${result.refusalCode ?? "VENUE_REFUSED"}: ${result.refusalMessage ?? "the venue refused the plan"}`;
    for (const marketId of [...new Set(held.map((order) => order.marketId))].sort()) {
      this.#options.halts.halt(
        { kind: "MARKET", marketId },
        "UNATTRIBUTED_ACTIVITY",
        `plan ${placement.executionPlanId} was refused (${refusal}), yet the venue holds ` +
          `${String(held.length)} of its ${String(plannedOrderIds.length)} planned orders — ` +
          `partly executed and then refused: ${described}. No instance owns them; their ` +
          "reservations, allocator commitments and time-in-force are KEPT until each is " +
          "terminal, and any fill of theirs is booked UNATTRIBUTED; reconcile the account " +
          "(§6 invariant 6, TRDR-4)",
        instant,
      );
    }
  }

  /**
   * Books every fill the venue has produced since the last harvest, then
   * delivers the order views and the fills to their instances.
   *
   * ORDER MATTERS AND IS THE OBLIGATION. EVERY fill of this harvest is booked
   * FIRST, so that by the time any `onFill` runs the position view already
   * includes the fill the evaluation is about (`WP-220` obligation 3) — and, if
   * two fills arrive together, both of them. The order views are delivered
   * last, under ruling R1 (obligations 4 and 5; see `#deliverOrderViews`).
   *
   * A FILL IS NEVER SKIPPED (`TRDR-4`, §6 invariant 7). A fill whose owner
   * lookup misses — an order this process never placed (for example the early
   * order of a plan the venue partly executed and then refused), a SETTLED
   * order, one evicted from the tombstone map, or an owner the registry does
   * not hold — is posted UNATTRIBUTED and halts its market through the ledger
   * projection (`#bookUnownedFill`). It used to be dropped here with a bare
   * `continue`, AFTER the deduplicator had spent its id: no posting, no
   * counter, no halt.
   */
  async #harvestFills(instant: string): Promise<void> {
    const fills = this.#options.venue.fills;
    const booked: { instance: RegisteredInstance; fill: SimulatedFill }[] = [];
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

      const ownerId = this.#orderOwners.get(fill.simulatedOrderId);
      const instance = ownerId === undefined ? undefined : this.#options.registry.get(ownerId);
      if (instance === undefined) {
        const unowned = await this.#bookUnownedFill(fill, ownerId, instant);
        if (unowned === "STORE_UNAVAILABLE") return;
        continue;
      }

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
      this.#countBookedShares(fill);
      this.#options.health.countAccounting("ledgerTransactions", posted.appended.length);
      this.#options.health.countAccounting("pnlRecords", posted.pnlRecords.length);
      this.#cash = cashAfter(this.#cash, fill);
      // §9.7's position exposure is "capital already spent", and this is the
      // only place that number can be folded: the ledger projection carries
      // balances, not lots. FIFO, exact, no division (`allocation.ts`).
      this.#options.allocator.observeFill(instance.instanceId, fill);
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
      this.#readProjection(instant);

      this.#traceFill(fill, posted.ledgerFillId, posted.ledgerTransactionIds);

      // §9.16: the PnL projection follows the posting, from the SAME records the
      // ledger derived. A refusal here is not a halt — PnL is a projection, and
      // §6 invariant 8 makes the append-only ledger the monetary source of
      // truth — but a store failure IS, on §4.2's terms.
      await this.#writePnlSnapshot(instance, fill, instant);

      booked.push({ instance, fill });
    }
    this.#knownFills = fills.length;

    // --- every order this harvest SETTLED gives its capacity back -----------
    // Between a fill's posting and its order's terminal release BOTH the new
    // position and the still-held reservation describe the same capital, and
    // §9.14 forbids double reservation. Running the release here — after every
    // fill of this harvest is in the ledger, before any evaluation reads the
    // account — closes the window in the fail-closed direction at both ends:
    // nothing is released before the position that replaces it exists.
    this.#releaseSettledReservations();

    for (const delivery of booked) {
      // --- WP-220 obligation 8, and the §4.2 gate it stops at ---------------
      //
      // The fill is offered even while the instance is PAUSED: the runtime
      // refuses a paused instance without invoking the callback, and that
      // refusal is RECORDED rather than treated as an error — the accounting
      // above already happened, which is the half a paused strategy would
      // otherwise lose.
      //
      // A HALTED SCOPE IS A DIFFERENT FACT (review round 1, MEDIUM-1). The
      // posting above is unconditional — the money moved, and §6 invariant 8
      // makes the ledger the source of truth whatever this process's own state
      // is — but §4.2's rule is that a process which can no longer know its
      // state MAKES NO TRADING DECISION for the halted scope. At the reviewed
      // tip a halt latched EARLIER IN THIS SAME ITERATION (a refused ledger
      // projection, a failed PnL write) did not stop the delivery: the strategy
      // was evaluated and an `exit` decision was persisted AFTER a
      // GLOBAL/FULL_HALT. The books stay truthful; the strategy does not act.
      if (
        this.#options.halts.isInstanceHalted(
          delivery.instance.instanceId,
          delivery.instance.marketId,
        )
      ) {
        this.#options.health.countLoop("deliveriesSuppressedByHalt");
        continue;
      }
      await this.#deliverFill(delivery.instance, delivery.fill, instant);
    }

    await this.#deliverOrderViews(instant);
  }

  /**
   * Books a fill whose owner lookup MISSED — `TRDR-4` item 3, §6 invariant 7:
   * "Unexplained activity goes to `UNATTRIBUTED` and halts the affected market."
   *
   * The fill is posted with NO claims, so `packages/ledger`'s `allocateFill`
   * places all of it in `UNATTRIBUTED` with `haltRequired: true`; the
   * projection then carries an `ACTUAL_ARRIVAL`, and `haltOnLedgerProjection`
   * latches the existing MARKET `UNATTRIBUTED_ACTIVITY` halt
   * (`RECONCILE_ACCOUNT`). The money moved at the venue, so the account side
   * (the ledger, `#cash`, the store) follows it exactly as for an owned fill.
   *
   * WHAT IS NOT DONE, deliberately. The fill is attributed to NO instance —
   * not even the one a tombstone names, whose track is settled and whose trace
   * prefix is gone (§6 invariant 4); the tombstone only puts the PROBABLE owner
   * into the halt detail. No allocator cost basis, no instance PnL stream, no
   * `onFill`. The operator's remedy is a reattribution transaction, which does
   * not re-raise the halt (`halt.ts`).
   *
   * Counted: `seams.orders.unownedFills`, plus `lateFillsAfterSettlement` when
   * a tombstone matched.
   */
  async #bookUnownedFill(
    fill: SimulatedFill,
    ownerId: string | undefined,
    instant: string,
  ): Promise<"BOOKED" | "REFUSED" | "STORE_UNAVAILABLE"> {
    const probableOwner =
      ownerId === undefined ? this.#tombstones.probableOwner(fill.simulatedOrderId) : undefined;
    this.#unownedFills += 1;
    if (probableOwner !== undefined) this.#lateFillsAfterSettlement += 1;
    const why =
      ownerId !== undefined
        ? `fill ${fill.simulatedFillId} names order ${fill.simulatedOrderId}, whose owner ` +
          `${ownerId} is not a registered instance; posted UNATTRIBUTED (TRDR-4)`
        : probableOwner !== undefined
          ? `fill ${fill.simulatedFillId} arrived AFTER order ${fill.simulatedOrderId} was ` +
            `settled; its tombstone names instance ${probableOwner} as the PROBABLE owner, and ` +
            "the fill is NOT attributed to it; posted UNATTRIBUTED (TRDR-4)"
          : `fill ${fill.simulatedFillId} names order ${fill.simulatedOrderId}, which this ` +
            "process does not own — never placed by it (for example the early order of a plan " +
            "the venue partly executed and then refused), or settled and since evicted from " +
            "the tombstone map; posted UNATTRIBUTED (TRDR-4)";

    const posted = postFill({
      ledger: this.#ledger,
      fill,
      claims: [],
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
        `${posted.stage} ${posted.code}: ${posted.detail}; ${why}`,
        instant,
      );
      return "REFUSED";
    }
    this.#ledger = posted.ledger;
    this.#countBookedShares(fill);
    this.#options.health.countAccounting("ledgerTransactions", posted.appended.length);
    this.#options.health.countAccounting("pnlRecords", posted.pnlRecords.length);
    this.#cash = cashAfter(this.#cash, fill);

    for (const appended of posted.appended) {
      const written = await this.#options.store.appendLedgerTransaction(appended);
      if (!written.ok) {
        this.#options.halts.halt(
          { kind: "GLOBAL" },
          "STORE_UNAVAILABLE",
          `the ledger transaction could not be persisted: ${written.failure.detail}`,
          instant,
        );
        return "STORE_UNAVAILABLE";
      }
    }

    this.#readProjection(
      instant,
      new Map(posted.ledgerTransactionIds.map((transactionId) => [transactionId, why])),
    );
    // A trace prefix survives only for an owner the registry does not hold
    // (the order is still tracked); a settled or unknown order has none.
    this.#traceFill(fill, posted.ledgerFillId, posted.ledgerTransactionIds);
    return "BOOKED";
  }

  /**
   * The `WP-200` composition-root obligation: read BOTH accounting sections of
   * the ledger projection, count what is new, and halt the affected market on
   * either (§9.9 says halting is the composition root's act, and this is that
   * act). `notes` names what the projection cannot know (an unowned fill's
   * probable owner) for the halt detail.
   */
  #readProjection(instant: string, notes?: ReadonlyMap<string, string>): void {
    const projection = projectionOf(this.#ledger);
    const arrivals = projection.unattributedActivity.filter(
      (record) => record.activityKind === "ACTUAL_ARRIVAL",
    ).length;
    if (arrivals > this.#seenArrivals) {
      this.#options.health.countAccounting("unattributedActivity", arrivals - this.#seenArrivals);
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
    haltOnLedgerProjection(this.#options.halts, projection, instant, notes);
  }

  /** Completes a fill's §6 invariant 4 chain from its order's prefix, when one is held. */
  #traceFill(
    fill: SimulatedFill,
    ledgerFillId: string,
    ledgerTransactionIds: readonly string[],
  ): void {
    const prefix = this.#orderTraces.get(fill.simulatedOrderId);
    if (prefix === undefined) return;
    this.#traces.append(
      Object.freeze({
        ...prefix,
        venueFillId: fill.simulatedFillId,
        ledgerFillId,
        ledgerTransactionIds,
      }),
    );
  }

  /**
   * Adds a BOOKED fill to its order's counter — settlement condition (b). Only
   * a still-tracked order has a counter; exact decimal arithmetic.
   *
   * TOTAL: a quantity that is not a canonical decimal (which `addDecimal`
   * would throw on) turns the counter UNREADABLE for good, so the order can
   * never prove (b), is never pruned, and its mismatch is counted.
   */
  #countBookedShares(fill: SimulatedFill): void {
    const booked = this.#bookedShares.get(fill.simulatedOrderId);
    if (booked === undefined) return;
    this.#bookedShares.set(
      fill.simulatedOrderId,
      isCanonicalDecimalString(booked) && isCanonicalDecimalString(fill.shares)
        ? addDecimal(booked, fill.shares)
        : UNREADABLE_BOOKED_SHARES,
    );
  }

  /**
   * Releases both reservation books for every order that has reached a terminal
   * state.
   *
   * EVERY venue order, owned or not — and that is load-bearing (`TRDR-4` round
   * 1): it is the only release of the entries `#releaseRefusedPlacement` KEPT
   * for an order a refused plan nonetheless left at the venue, which no
   * instance owns and `#deliverOrderViews` therefore never visits.
   *
   * Idempotent: a second call for the same order releases nothing and says so,
   * which is why `#deliverOrderViews` may keep its own call for orders that go
   * terminal without producing a fill (a cancel, an expiry, a rejection).
   */
  #releaseSettledReservations(): void {
    for (const order of this.#options.venue.ordersSnapshot()) {
      const view = toStrategyOrderView(order, {
        marketId: order.marketId,
        placedAt: this.#lastInstant,
      });
      if (!isTerminalStatus(view.status)) continue;
      this.#reservations.releaseForOrder(order.plannedOrderId);
      this.#options.allocator.release(order.plannedOrderId);
      this.#timeInForce.release(order.plannedOrderId);
    }
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
   * Delivers `onOrderUpdate` for the orders this process owns, then SETTLES the
   * retired ones — `WP-220` obligations 4 and 5 under the user's ruling R1
   * (`TRDR-4`, 2026-09-26).
   *
   * This docstring used to say "EVERY order, EVERY harvest, INCLUDING
   * repeats", and the loop did exactly that for the life of the process, so
   * per-event evaluations, persisted decisions and checkpoints grew with every
   * order ever placed. The rule now:
   *
   * - a WORKING order's view is delivered on EVERY harvest, repeats included
   *   (a cancel race's `OPEN` view still reaches the strategy);
   * - a TERMINAL order's view is delivered until ONE delivery was EVALUATED —
   *   the runtime answered `DECIDED`. A delivery the §4.2 halt gate suppressed,
   *   one whose snapshot could not be computed, or a runtime answer other than
   *   `DECIDED` (`REFUSED` for a PAUSED instance, `CONTAINED`, `HALTED`) is NOT
   *   an evaluation and does not count, so the view comes again next harvest;
   * - after that evaluation the order is RETIRED: never delivered again, and
   *   out of `ctx.orders()`;
   * - a terminal order releases its reservation, its allocator commitment and
   *   its time-in-force at the first harvest that sees it terminal
   *   (obligation 9: the reservation stands until the order can consume no
   *   more inventory) — unchanged, and never before terminal (ADR-006 §9).
   *
   * Every view is read from ONE `ordersSnapshot()` taken here, at the harvest
   * boundary — after every fill of this harvest was booked — and every retired
   * order is offered to `#settle` only after every delivery of the harvest has
   * run, so a cancel a delivery registered is visible to condition (d).
   */
  async #deliverOrderViews(instant: string): Promise<void> {
    const boundary = this.#options.venue.ordersSnapshot();
    for (const order of boundary) {
      const instanceId = this.#orderOwners.get(order.simulatedOrderId);
      if (instanceId === undefined) continue;
      // R1: a retired order is never delivered again.
      if (this.#retired.has(order.simulatedOrderId)) continue;
      const instance = this.#options.registry.get(instanceId);
      if (instance === undefined) continue;
      const market = this.#options.markets.get(instance.marketId);
      if (market === undefined) continue;
      const view = toStrategyOrderView(order, {
        marketId: instance.marketId,
        placedAt: instant,
      });
      this.#orderViews.deliverable(instance.instanceId, view);
      const terminal = isTerminalStatus(view.status);
      if (terminal) {
        // BOTH books, at the same moment and on the same key: the order can
        // consume no more inventory and commit no more capital (`allocation.ts`
        // §"The two reservation books"). Keyed by the PLANNED order id.
        this.#reservations.releaseForOrder(order.plannedOrderId);
        this.#options.allocator.release(order.plannedOrderId);
        this.#timeInForce.release(order.plannedOrderId);
      }
      if (this.#options.halts.isInstanceHalted(instance.instanceId, instance.marketId)) {
        // Suppressed, so NOT an evaluation: a terminal view comes again.
        this.#options.health.countLoop("deliveriesSuppressedByHalt");
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
      // R1: only a DECIDED outcome is an evaluation of the view. REFUSED (a
      // PAUSED runtime), CONTAINED (the callback failed; its state did not
      // move) and HALTED (persistence failed) all leave the order deliverable.
      if (terminal && outcome.kind === "DECIDED") this.#retired.add(order.simulatedOrderId);
      await this.#consumeOutcome(instance, market, outcome, "", instant, this.#lastEpochMs);
    }

    for (const order of boundary) {
      if (this.#retired.has(order.simulatedOrderId)) this.#settle(order);
    }
  }

  /**
   * Settles one retired order and prunes its per-order state (`TRDR-4`).
   *
   * Only when ALL of (a)-(d) hold ({@link settlementBlocker}): (a) terminal in
   * the view read at this harvest boundary; (b) the fill shares BOOKED for it
   * equal that view's `filledShares`; (c) retired under R1; (d) no pending
   * cancel names it. A (b) mismatch is COUNTED once per order and the order is
   * never pruned while it lasts — a booked-shares shortfall is exactly the
   * state in which a later fill still needs its owner.
   *
   * What is deleted, each by its own key (the VENUE order id): the owner
   * entry, the fill-join LOOKUP entry (never the provenance log), the id in the
   * instance's order set (and the set when empty), the order-view tracker's
   * entry, the booked-shares counter, and the retired flag. What remains is a
   * bounded tombstone naming the probable owner, so a fill that still arrives
   * is classified as late rather than unknown — and is booked UNATTRIBUTED
   * either way.
   */
  #settle(order: SimulatedOrder): void {
    const venueOrderId = order.simulatedOrderId;
    const instanceId = this.#orderOwners.get(venueOrderId);
    if (instanceId === undefined) return;
    const view = toStrategyOrderView(order, { marketId: order.marketId, placedAt: this.#lastInstant });
    const blocker = settlementBlocker({
      terminal: isTerminalStatus(view.status),
      bookedShares: this.#bookedShares.get(venueOrderId) ?? "0",
      filledShares: view.filledShares,
      retired: this.#retired.has(venueOrderId),
      cancelPending: this.#cancelPendingFor(venueOrderId, order.marketId),
    });
    if (blocker === "BOOKED_SHARES_MISMATCH") {
      if (!this.#mismatched.has(venueOrderId)) {
        this.#mismatched.add(venueOrderId);
        this.#settleMismatches += 1;
      }
      return;
    }
    if (blocker !== undefined) return;

    this.#orderOwners.delete(venueOrderId);
    this.#orderTraces.delete(venueOrderId);
    const owned = this.#instanceOrders.get(instanceId);
    if (owned !== undefined) {
      owned.delete(venueOrderId);
      if (owned.size === 0) this.#instanceOrders.delete(instanceId);
    }
    this.#orderViews.forget(venueOrderId);
    this.#bookedShares.delete(venueOrderId);
    this.#retired.delete(venueOrderId);
    this.#mismatched.delete(venueOrderId);
    this.#tombstones.remember(venueOrderId, instanceId);
    this.#settled += 1;
  }

  /**
   * Condition (d): does a still-pending cancel name this order?
   *
   * A cancel names orders by the VENUE's id (`ctx.orders()`'s `orderId`, which
   * the planner carries into the plan's scope). A pending cancel with NO order
   * ids is a scope-wide request for its market (§7.7: "cancel everything in
   * scope"), and it is read as naming every order of that market — the
   * conservative reading, which only ever delays a settlement.
   */
  #cancelPendingFor(venueOrderId: string, marketId: string): boolean {
    return this.#cancels
      .pending()
      .some((cancel) =>
        cancel.orderIds.length === 0
          ? cancel.marketId === marketId
          : cancel.orderIds.includes(venueOrderId),
      );
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
      const written = await this.#options.store.saveCheckpoint(checkpoint, this.#lastInstant);
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
        // The EXACT capital this position cost, folded FIFO from the fills this
        // process booked (`allocation.ts`). It was `"0"` at the reviewed tip,
        // which told `packages/risk`'s worst-case builder that every held
        // position had consumed nothing — the same understatement review round
        // 1 found on the allocator side.
        costBasis: this.#options.allocator.costBasisOf(
          instance.instanceId,
          marketConfig.marketId,
          side,
        ),
      });
    }
    return Object.freeze(positions);
  }

  /**
   * The §9.7 live-ownership table, from the registry that enforces it.
   *
   * ADR-011 permits one live owner per market and `InstanceRegistry.register`
   * refuses a second at startup, so this is a READ of that decision rather than
   * a second one. A market with no owner is ABSENT, not defaulted: the
   * allocator refuses a LIVE commitment on an unowned market by name
   * (`CAPITAL_LIVE_OWNERSHIP_MISSING`), which is the fail-closed direction.
   */
  #liveOwners(): readonly { readonly marketId: string; readonly strategyInstanceId: string }[] {
    const owners: { marketId: string; strategyInstanceId: string }[] = [];
    for (const marketId of [...this.#options.markets.keys()].sort()) {
      const owner = this.#options.registry.ownerOf(marketId);
      if (owner === undefined) continue;
      owners.push({ marketId, strategyInstanceId: owner });
    }
    return Object.freeze(owners);
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

/**
 * The §9.7 accounting mode every commitment this process makes is booked under.
 *
 * **A CONSTANT, and review round 2's HIGH-1 is why.** At the r1 tip this was a
 * function of the emitting instance's ownership — `OWNER → LIVE`,
 * `SHADOW → SHADOW` — with a docstring claiming a SHADOW instance's commitments
 * "never touch live collateral, inventory or caps". That claim was MEASURED
 * FALSE on all three: `packages/capital-allocator`'s SHADOW arm skips the entire
 * LIVE block (the ADR-011 ownership gate, the live-micro fence and the
 * collateral/inventory sufficiency checks) and compares caps against that
 * instance's own shadow book, while THIS process went on to plan the order
 * (`pipeline.ts` states `accountingMode: "LIVE"` for the planner), submit it to
 * the one `SimulatedVenue`, debit the one `#cash` and book it to the one
 * `Ledger`. With `globalAccountCap: "20"` and two markets, an OWNER pair filled
 * once and refused the second `CAPITAL_GLOBAL_CAP_EXCEEDED`; flipping the second
 * instance to `SHADOW` filled BOTH — 34 pUSD committed, zero allocator refusals,
 * on a market whose `ownerOf` was `undefined`.
 *
 * This process has exactly ONE book. `#cash`, the `Ledger` and the venue are
 * shared by every instance, so a commitment that reaches them is a real
 * commitment against the real account whatever instance it is ATTRIBUTED to,
 * and it is evaluated as one. `SHADOW` is the allocator's independent-shadow-
 * accounting arm (§9.7) and belongs to a caller that HAS a separate book; this
 * one does not, so it never asks for it. The instances that would have used it
 * do not reach here at all — see `CoreLoop`'s `#routeIntent` ownership
 * gate, which is the primary remedy; this constant is the SECOND layer ADR-011
 * §1 asks for ("Enforcement is layered, so a bug in one layer does not create
 * real exposure"): anything that does reach the allocator is judged LIVE, so a
 * non-owner commitment meets `CAPITAL_LIVE_OWNERSHIP_MISSING` or
 * `CAPITAL_LIVE_OWNERSHIP_CONFLICT` rather than a book of its own.
 */
const SHARED_BOOK_ACCOUNTING_MODE = "LIVE" as const;

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
