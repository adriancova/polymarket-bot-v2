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
  type PnlRecord,
  type PnlSnapshot,
  type PnlState,
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
  type DeterministicIdFactory,
  type PostingIdentity,
  type TraceLink,
} from "./accounting.js";
import { requestFor, type AllocatorGate } from "./allocation.js";
import { judgeBasketExecution } from "./basket-execution.js";
import {
  bookConfirmedAt,
  DeliverySessionLiveness,
  FrameCompletionGate,
  sessionKeyOf,
  type BookFreshnessBasis,
  type ConfirmedInstant,
} from "./book-freshness.js";
import {
  EvaluationCadenceClock,
  PAPER_EVALUATION_CADENCE,
  evaluationCadenceProblem,
  type CadenceAlarm,
  type EvaluationCadenceOption,
} from "./cadence.js";
import { CancelLedger } from "./cancels.js";
import {
  bookFreshnessBasisOf,
  bookFreshnessCeilingMsOf,
  type InstanceConfig,
  type MarketConfig,
  type TraderConfig,
} from "./config.js";
import { readEventEnvelope } from "./event-door.js";
import { FillDeduplicator } from "./fills.js";
import { sameFrame } from "./frames.js";
import { HeldAccounting, type AccountingChecks, type FoldHealth } from "./folds.js";
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
import { pnlSnapshotKey } from "./pnl-snapshot-key.js";
import type {
  Clock,
  DispatchPosition,
  GroupCommit,
  IngestedEvent,
  RiskRefusalRecord,
  TraderStore,
} from "./ports.js";
import type { DecisionRecord, DecisionTelemetry } from "@polymarket-bot/strategy-runtime";
import type { StrategyStateCheckpoint } from "@polymarket-bot/strategy-runtime";
import { buildStrategyFeatureView, projectFeatureValues } from "./projection.js";
import { BoundedQueue, type QueueMetrics } from "./queue.js";
import { ReferenceState } from "./reference-state.js";
import { ReservationBook } from "./reservations.js";
import { TRADER_RUN_MODE } from "./safety.js";
import { normalizeToStrictUtc } from "./time.js";
import type { Ledger, LedgerProjection } from "@polymarket-bot/ledger";

/**
 * The venue surface the loop drives.
 *
 * Structurally `packages/simulation`'s `SimulatedVenue`, reduced to the methods
 * the loop calls. Declared here rather than imported as the class so a live
 * adapter can satisfy it without inheriting from a simulator — which is the
 * whole point of §12.1.
 *
 * `submit` answers PER ORDER (SIM-1, the user's ruling R3): `orders` lists
 * every order the venue BOOKED for the plan — on a partial outcome as on a
 * full one — and `notPlaced` the planned orders it did not place. The loop
 * owns the first and releases the second (`#releaseRefusedPlacement`); an
 * order the venue holds that its answer did not list is the defensive
 * reconciliation path there.
 *
 * `observe` and `observeTrade` ANSWER, and the loop reads the answer (SIM-1
 * r1, `SIM1-R1-1`): a venue that could not be positioned at a recorded event,
 * or could not apply what recorded time settled — a DELAYED order's
 * disposition — says so with `ok: false` and a `refusal`, and the loop halts
 * (`#haltOnVenueObservation`). The refusal is optional in the type so a venue
 * that has nothing to say beyond `ok` still satisfies the port.
 *
 * SIM-2: THE LOOP READS NO HISTORY. It used to read the venue through
 * `ordersSnapshot()` — every order ever placed, copied and sorted — several
 * times per event, and through a `fills` index into a copy of every fill ever
 * produced; that made the venue unboundable and each event's cost grow with
 * the run. The port now carries exactly what the loop needs:
 *
 * - `fillsSince(sequence)`: the fills at or after an ABSOLUTE sequence, and
 *   the next one — a NON-destructive cursor, so a harvest that stops early (a
 *   store failure) re-reads the same batch (`IF-06`). A refusal (the cursor
 *   is older than the venue's retained window) HALTS the process;
 * - `orderById` / `orderByPlannedId`: one order, O(1). The loop iterates its
 *   OWN sets — the orders it owns, and the ones it knows the venue holds
 *   without owning them (`#heldUnowned`) — sorted with the order the venue's
 *   snapshot used (`compareVenueOrderIds`), and looks each one up. An order
 *   this process owns or holds that the venue no longer answers for is a
 *   LOUD miss (`#haltOnVenueMiss`);
 * - `acknowledgeTerminal(venueOrderId)` (SIM-2 r1, `SIM2-R1-1`): the loop is
 *   DONE with a terminal order — settled it, released it, and no basket watch
 *   still reads it. Until then the venue must keep answering for it, however
 *   many other orders end meanwhile: the loop keeps no copy of a terminal
 *   order of its own, and a venue that bounds its history may evict an order
 *   only after this call. SIM-1's carried requirement ("a terminal order stays
 *   visible to the loop until the loop has seen it") is this contract.
 *
 * The end-of-run HISTORY accessors (`ordersSnapshot()`, `fills`) stay on
 * `SimulatedVenue` for the harnesses that report a run; they are not on this
 * port, so the loop cannot drift back to them.
 */
export interface TraderVenue {
  observe(identity: {
    readonly gatewayEpoch: string;
    readonly ingestSeq: string;
    readonly receivedAt: string;
    readonly datasetRowOrdinal: number;
  }): { readonly ok: boolean; readonly refusal?: VenueObservationRefusal };
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
  }): {
    readonly ok: boolean;
    readonly value?: { readonly fills: readonly SimulatedFill[] };
    readonly refusal?: VenueObservationRefusal;
  };
  submit(plan: unknown): Promise<ExecutionResult>;
  /** SIM-2: the fills at or after an absolute sequence, and the next sequence. Non-destructive. */
  fillsSince(sequence: number):
    | {
        readonly ok: true;
        readonly value: { readonly fills: readonly SimulatedFill[]; readonly next: number };
      }
    | { readonly ok: false; readonly refusal: VenueObservationRefusal };
  /** SIM-2: one order by the VENUE's id — working or terminal — or `undefined`. */
  orderById(venueOrderId: string): SimulatedOrder | undefined;
  /** SIM-2: one order by the PLANNER's id, or `undefined` when the venue holds none. */
  orderByPlannedId(plannedOrderId: string): SimulatedOrder | undefined;
  /**
   * SIM-2 r1: the loop is done with this TERMINAL order; the venue may now
   * forget it (see this port's header). The answer, if any, is not read.
   */
  acknowledgeTerminal(venueOrderId: string): unknown;
}

/**
 * The order the venue's `ordersSnapshot()` used — `SimulatedVenue`'s
 * `compareStrings`: UTF-16 code units, locale-free — so iterating the loop's
 * OWN id sets visits orders in exactly the order the snapshot scans did
 * (`IF-07`). Insertion order is NOT that order: a plan of 11 or more slices
 * has ids `…:o0, …:o1, …:o10, …:o11, …:o2`, and evaluation order decides the
 * decision sequence, `ctx.orders()` and risk's `openOrders`.
 */
function compareVenueOrderIds(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A fresh array of `ids`, in venue order (see {@link compareVenueOrderIds}). */
function inVenueOrder(ids: Iterable<string>): string[] {
  return [...ids].sort(compareVenueOrderIds);
}

/** What a venue says when `observe` / `observeTrade` could not do what it was asked. */
export interface VenueObservationRefusal {
  readonly code: string;
  readonly message: string;
}

/**
 * The venue's refusal code for a DELAYED disposition it could not apply at
 * `matchableAtNs` (`packages/simulation`, SIM-1 r1). Named here as the one
 * `observeTrade` refusal the loop halts on; see `#haltOnVenueObservation`.
 */
const DISPOSITION_NOT_APPLIED = "SIMULATED_VENUE_DISPOSITION_NOT_APPLIED";

/** One BASKET plan the loop is still judging (SIM-1 r2, `SIM1-R2-1`; see `#watchBasket`). */
interface BasketWatch {
  readonly executionPlanId: string;
  readonly failurePolicy: string;
  /** Every market the basket's groups name, sorted: the halt's scopes. */
  readonly marketIds: readonly string[];
  readonly plannedCount: number;
  /** The VENUE's ids of the orders it BOOKED for the plan, in the answer's order. */
  readonly venueOrderIds: readonly string[];
  /** How many planned orders the venue did NOT place, and their description. */
  readonly notPlacedCount: number;
  readonly notPlacedDescribed: string;
  /** `"code: message"` when the venue's answer was not a whole acceptance. */
  readonly refusal: string | undefined;
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
  /**
   * `FOLD-1` — how often the loop checks its HELD ledger view (and, when
   * `pnl` is on, its held PnL streams) against a rebuild from zero
   * (`folds.ts`). Omitted: the PAPER cadence, `PAPER_ACCOUNTING_CHECKS` —
   * the ledger every 50 posted fills, no PnL check (user ruling F2). The test
   * and golden harnesses pass `EVERY_FILL_ACCOUNTING_CHECKS` in code
   * (orchestrator call O1). A programmatic option, never operator
   * configuration; the constructor refuses a cadence that is not a positive
   * safe integer.
   */
  readonly accountingChecks?: AccountingChecks;
  /**
   * `CADENCE-1` — the ADR-026 evaluation cadence (`cadence.ts`). Omitted: the
   * PAPER cadence, `PAPER_EVALUATION_CADENCE` (1,000 ms and 5,000 ms), which
   * every live-data run and every replay that is not a reproduction uses
   * (D1.5). The per-frame value 0 is accepted only with `reproduces` (D1.6):
   * the golden harnesses and a `backtest-cli run --reproduces` pass it IN
   * CODE. A programmatic option, never operator configuration; the
   * constructor refuses anything `evaluationCadenceProblem` refuses
   * (`createPaperTrader` refuses it by name first).
   */
  readonly evaluationCadence?: EvaluationCadenceOption;
  /**
   * `CADENCE-1` (ADR-026 D2.10) — told when a forward-jump alarm episode
   * starts or ends, so the composition root can log the line an operator's
   * pager watches (`main.ts`). Output only: nothing it does reaches a
   * decision, and a hook that throws is contained.
   */
  readonly onCadenceAlarm?: (alarm: CadenceAlarm) => void;
}

/**
 * `CoreLoop.health()`'s answer: a {@link HealthSnapshot} whose `TRDR-4` seams
 * and `FOLD-1` seam are always present. `HealthSnapshot` keeps them optional
 * only for holders of no loop (see `health.ts`, `SeamHealth.orders`).
 */
export type LoopHealthSnapshot = HealthSnapshot & {
  readonly seams: HealthSnapshot["seams"] & {
    readonly orders: OrderLifecycleMetrics;
    readonly retention: RetentionHealth;
    readonly folds: FoldHealth;
  };
};

/** What {@link CoreLoop.checkAccountingRebuild} answers. */
export interface AccountingRebuildCheck {
  /** `true` when the held ledger view — and every PnL stream checked — equals its rebuild. */
  readonly matched: boolean;
  /**
   * How many instances' PnL streams were compared, each over its WHOLE record
   * list (0 when the PnL check is off).
   */
  readonly pnlStreamsChecked: number;
}

/**
 * The per-order state `CoreLoop` holds, as sizes — `TRDR-4`'s observation
 * surface for the bounded-state claim. Every map is keyed by the VENUE's order
 * id, except `basketWatches` (keyed by execution plan id).
 */
export interface RetainedOrderState {
  /**
   * SIM-1 r2 (`SIM1-R2-1`): BASKET plans still WATCHED — some booked order
   * can still execute and none has ended short yet. A watch ends when its
   * basket halts or when every booked order is terminal.
   */
  readonly basketWatches: number;
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
  /**
   * SIM-2: planned orders the venue may HOLD that no instance owns — a refused
   * plan's held-but-unlisted orders, and the planned orders of a placement
   * whose answer never arrived — kept until each is seen terminal and
   * released. Keyed by the PLANNED order id.
   */
  readonly heldUnowned: number;
  /**
   * SIM-2 r1: venue orders a WATCHED basket still reads. The loop does not
   * acknowledge such an order to the venue — even once it is settled — until
   * its watch concludes, so the watch always finds every leg. Bounded by the
   * working baskets' orders.
   */
  readonly watchedOrders: number;
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

  /**
   * `DURABLE-1`: drains the DECISIONS only, leaving every checkpoint where it
   * is. The loop's durability boundary before a placement
   * ({@link CoreLoop}'s `#persistDecisionsBeforePlacement`) makes the pending
   * decisions durable there and then; the checkpoints stay for the flush that
   * always wrote them, so each is written with exactly the `capturedAt` it
   * always had (the flush's instant, which inside a venue frame is the
   * frame's last event, not the event a mid-frame callback fired at).
   */
  drainDecisions(): readonly { record: DecisionRecord; telemetry: DecisionTelemetry }[] {
    const decisions = this.#decisions;
    this.#decisions = [];
    return decisions;
  }

  get depth(): number {
    return this.#decisions.length + this.#checkpoints.length;
  }
}

/**
 * `THROUGHPUT-1a` — the group-commit bounds (see `CoreLoop` `#flushOutbox`).
 *
 * With a store that offers group commit, the decisions and checkpoints of
 * consecutive events are STAGED and committed together, one transaction per
 * batch, in ONE serialized chain (so the durable rows are always a prefix of
 * the run's). A commit is REQUESTED as soon as ANY of these holds:
 *
 * - COUNT: {@link GROUP_COMMIT_EARLY_START_EVENTS} events are staged;
 * - TIME: the oldest staged event was staged {@link GROUP_COMMIT_MAX_AGE_MS}
 *   ago or more (the loop's monotonic clock, checked at every event
 *   boundary);
 * - the drain ends.
 *
 * A requested commit starts when the one before it has settled, and takes
 * every row staged by then.
 *
 * The HARD bound: at most {@link GROUP_COMMIT_MAX_EVENTS} events are ever
 * staged. At that count the loop WAITS until everything staged is durable
 * before it evaluates another event — so a slow database slows the loop
 * instead of letting undurable decisions pile up. At any instant at most
 * `2 × GROUP_COMMIT_MAX_EVENTS` events have decisions that are not yet
 * durable (one committing batch, one staged).
 *
 * `THROUGHPUT-2` r1 (ADR-024 D5, `TP2-R1-M2`): the UNIT these bounds count is
 * one STAGING — one outbox flush that carried a decision or a checkpoint
 * (`GroupCommit.stagedEvents`). Before ADR-024 a flush followed each event,
 * so the unit was an event; the loop now flushes once per venue FRAME, so
 * every "event" in these bounds (COUNT, the hard bound, the `2 ×` window)
 * reads "frame": at most 128 frames staged, at most 256 frames with
 * decisions not yet durable. A frame of one event is an event, as before; a
 * longer frame is one unit however many events it holds (H1: 1.76 events
 * per frame on average, up to 65). What one unit holds in DECISIONS is not
 * wider than before: a frame's flush carries one decision per market it
 * owed (plus any lifecycle callback), as a lone event's flush does.
 *
 * And the loop WAITS until everything staged is durable:
 *
 * - at the end of a drain, unless the caller asked otherwise (the pump's
 *   pipelined path, which instead waits on `durabilityMark()` before it
 *   records the batch's stream position — so a quiet stream, whose every idle
 *   poll drains durably, commits at once);
 * - before another durable write (a fill's ledger postings and PnL snapshot)
 *   and before an intent is routed toward the venue — so nothing that depends
 *   on an earlier decision is written or submitted while that decision is not
 *   yet durable;
 * - at the hard bound above.
 */
export const GROUP_COMMIT_MAX_EVENTS = 128;
export const GROUP_COMMIT_MAX_AGE_MS = 50;
/**
 * Once this many events (frames since ADR-024: see above) are staged, a
 * commit is REQUESTED without waiting for it, and evaluation continues while the database works. Commits never overlap
 * one another (they form one chain), so batches become durable one at a time,
 * in stage order.
 */
export const GROUP_COMMIT_EARLY_START_EVENTS = 32;

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
  /**
   * `THROUGHPUT-1c` (ADR-023): the configured book-freshness basis and, under
   * `CONNECTION_CONFIRMED`, the per-delivery-session confirmations
   * (`book-freshness.ts`). Fed every consumed event, in stream order.
   */
  readonly #freshnessBasis: BookFreshnessBasis;
  /** ADR-023 D2 rule 6: the per-book ceiling on the last-change age (r1, X1). */
  readonly #freshnessCeilingMs: number | undefined;
  readonly #liveness = new DeliverySessionLiveness();
  /**
   * `THROUGHPUT-1c` r8 (R8-H1, ADR-023 D2.4): every consumed event reaches the
   * table above only through this gate, which holds a frame's confirmations
   * back until a later event of the same gateway epoch proves the frame
   * whole. No evaluation can take a confirmation from a frame this loop has
   * not applied in full, however the frame was published, batched or cut.
   */
  readonly #frameGate = new FrameCompletionGate(this.#liveness);

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
  /**
   * `executionPlanId -> the BASKET plan still WATCHED` (SIM-1 r2, `SIM1-R2-1`;
   * see `#watchBasket`). Holds a basket only while one of its booked orders
   * can still execute and none has ended short, so it is bounded by the
   * working baskets, as the maps above are by the working orders.
   */
  readonly #basketWatches = new Map<string, BasketWatch>();
  /**
   * SIM-2: `plannedOrderId -> the VENUE's order id (when known)` for orders
   * the venue may hold that NO instance owns. The loop no longer scans every
   * venue order at each harvest, so these — which `#releaseSettledReservations`
   * used to find by that scan, and which own nothing `#deliverOrderViews`
   * visits — are tracked here and released at the first harvest that sees
   * each one terminal. Two sources:
   *
   * - `#releaseRefusedPlacement`'s DEFENSIVE path (`TRDR-4`): a refused plan
   *   whose orders the venue holds without listing them as booked (venue id
   *   known);
   * - a placement whose `submit` THREW (`#submitPlan`): the venue may have
   *   booked any of its planned orders, and no answer said which (venue id
   *   unknown; looked up by planned id).
   *
   * An entry whose venue id is unknown is PROMOTED to the id the first lookup
   * that finds it answers (SIM-2 r1, `SIM2-R1-4`), so from then on a miss is
   * LOUD like any held order's. An entry leaves when its order is seen
   * terminal (and the venue is told it may forget it). It is bounded by those
   * orders; a planned order the venue never booked stays, which is what the
   * old scan did too (it found nothing to release, for ever).
   */
  readonly #heldUnowned = new Map<string, string | undefined>();
  /**
   * SIM-2 r1: the venue ids of every order a WATCHED basket still reads
   * (`#basketWatches`). A settled order in this set is NOT acknowledged to the
   * venue until its watch concludes (`#forgetWatch`): the watch must go on
   * finding every leg's terminal record, or it would read a forgotten leg as
   * "still working" and never conclude.
   */
  readonly #watchedOrders = new Set<string>();
  #settled = 0;
  #unownedFills = 0;
  #lateFillsAfterSettlement = 0;
  #settleMismatches = 0;

  /**
   * `FOLD-1`: the ledger, its HELD view, and the held PnL streams — together
   * (`folds.ts`). The ledger and its view have ONE writer,
   * `HeldAccounting.adopt`, so they cannot drift apart; the four projection
   * read sites read `view`, which is folded from zero only at construction and
   * by the rebuild checks.
   */
  readonly #held: HeldAccounting;
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
  /**
   * SIM-2: the venue fill SEQUENCE the next harvest reads from (`fillsSince`)
   * — an absolute position in the venue's fill stream, not an index into a
   * copy of it. Advanced only after a whole batch was booked.
   */
  #knownFills = 0;
  #seenArrivals = 0;
  #seenUnexplained = 0;
  /**
   * The §9.16 record stream per strategy instance, in production order.
   *
   * `FOLD-1`: kept WHOLE, but no longer folded from zero on every fill. The
   * PnL state each snapshot reads is HELD per instance and advanced with only
   * the new records (`folds.ts`, `HeldAccounting.advancePnl`); this list is
   * what a rebuild from zero reads — §6 invariant 8's rebuild, now RUN as a
   * check (every fill in the test harnesses; not in PAPER, user ruling F2) —
   * and what `pnlRecords()` returns. The records themselves come from
   * `buildFillPosting`, so they are the ledger's own derivation and not a
   * second accounting.
   *
   * NOT BOUNDED, and said so rather than implied: bounding it (and the
   * in-memory `Ledger`) is `LOOPMEM-FOLD` Option 4, deferred behind
   * `RECON2-DURABLE`. This loop is therefore NOT memory-bounded.
   */
  readonly #pnlRecords = new Map<string, PnlRecord[]>();
  /**
   * `SNAP-1`: the §9.16 snapshot rows STAGED per instance during ONE harvest —
   * computed at every booked fill exactly as base computed them, written once
   * by `#flushPnlSnapshots` before that harvest returns (so this is empty
   * between harvests). A later fill of the same instance REPLACES its entry
   * (deleted and re-inserted, so the map's order is the order of each
   * instance's LAST fill: the order base wrote the rows this keeps). At most
   * one entry per registered instance.
   */
  readonly #stagedSnapshots = new Map<string, readonly PnlSnapshot[]>();
  /**
   * `SNAP-1` r1: the `pnl_snapshots_scope_unique` identity
   * (`pnl-snapshot-key.ts`) of every row this process has INSERTED. A staged
   * row whose identity is here was written by an EARLIER harvest at the same
   * instant, so the flush REPLACES it; any other row is inserted and joins
   * this set. One entry per (instance, instant with a booked fill) — the same
   * order of growth as `#pnlRecords` (two records per fill), and, like it,
   * NOT bounded: instants may repeat in any order (`receivedAt` is the
   * gateway's per-event stamp), so no identity can be forgotten safely.
   */
  readonly #writtenSnapshotKeys = new Set<string>();
  /** Epoch-millisecond instants of this process's own submissions (§9.8 check 19). */
  #submissionInstants: number[] = [];
  /** `THROUGHPUT-1a`: when the oldest staged, uncommitted event was staged (monotonic ns). */
  #stagedSinceNs: bigint | undefined;
  /** `THROUGHPUT-1a`: the serialized chain of group commits (see `#requestCommit`). */
  #commitChain: Promise<void> = Promise.resolve();
  /** `THROUGHPUT-1a`: a commit is requested and has not started yet. */
  #commitRequested = false;
  /** `THROUGHPUT-1a`: a group commit failed; nothing is committed after it. */
  #groupCommitFailed = false;
  /**
   * `DURABLE-1` r1 (LOW-5): a decision or checkpoint was NOT made durable
   * although no group COMMIT failed — a staging failure, or a refused
   * per-row write. {@link durabilityMark} then answers `false`. Unlike
   * `#groupCommitFailed` it does not stop later commits: rows staged BEFORE
   * the failure still become durable (a prefix), as on base.
   */
  #durabilityLost = false;
  /**
   * `PROVENANCE-1`: refused intents not yet handed to the store — appended at
   * the risk seam's refusal (`#routeIntent`) and taken by the flush that ends
   * the event (`#flushOutbox`: staged with the event's rows, or written after
   * them) through `#takeRiskRefusals`, which hands over nothing once
   * durability is lost. Emptied by every flush; bounded by the event's own
   * evaluations (one record per refused intent of a decision), which the
   * bounded outbox already bounds.
   */
  #pendingRiskRefusals: RiskRefusalRecord[] = [];
  /**
   * `DURABLE-1`: the decision whose intents are being routed could not be
   * made durable at the boundary before its first placement. Every LATER
   * placement of the SAME decision is then refused at the boundary as well
   * (its CANCELs still route). Reset for each DECIDED outcome, so it never
   * outlives the decision it is about.
   */
  #routingUndurableDecision = false;
  /**
   * `THROUGHPUT-2` (ADR-024): the venue frame being applied — set by its first
   * event when the frame is longer than one, cleared by its closing event. It
   * never outlives a drain (see `drain`).
   */
  #frame: OpenFrame | undefined;
  /**
   * `CADENCE-1` (ADR-026): the evaluation cadence's clock — `now`, each
   * market's `last`, the markets still owed, the alarm episode. Moved only by
   * APPLIED events (`#processEvent`), and read only at a frame close.
   */
  readonly #cadence: EvaluationCadenceClock;
  /** `CADENCE-1`: the cadence this loop runs with, as it was handed in (for the run's artifact). */
  readonly #cadenceOption: EvaluationCadenceOption;

  constructor(options: CoreLoopOptions) {
    this.#options = options;
    const cadence: EvaluationCadenceOption = options.evaluationCadence ?? PAPER_EVALUATION_CADENCE;
    const cadenceProblem = evaluationCadenceProblem(cadence);
    if (cadenceProblem !== undefined) {
      throw new Error(`the core loop refuses its evaluation cadence: ${cadenceProblem}`);
    }
    this.#cadenceOption = Object.freeze({
      intervalMs: cadence.intervalMs,
      heartbeatMs: cadence.heartbeatMs,
      ...(cadence.reproduces === undefined ? {} : { reproduces: cadence.reproduces }),
    });
    this.#cadence = new EvaluationCadenceClock(this.#cadenceOption);
    this.#queue = new BoundedQueue<IngestedEvent>({
      name: "ingest",
      maximumDepth: options.config.queues.ingestMaximumDepth,
    });
    // `FOLD-1`: the ONE fold from zero outside the rebuild checks.
    this.#held = new HeldAccounting(options.ledger, options.accountingChecks ?? {});
    this.#cash = options.config.accounting.startingCash;
    this.#lastInstant = options.clock.now();
    this.#freshnessBasis = bookFreshnessBasisOf(options.config);
    this.#freshnessCeilingMs = bookFreshnessCeilingMsOf(options.config);
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
      basketWatches: this.#basketWatches.size,
      owners: this.#orderOwners.size,
      instanceOrderSets: this.#instanceOrders.size,
      instanceOrderIds,
      traceLookup: this.#orderTraces.size,
      bookedShares: this.#bookedShares.size,
      retiredUnsettled: this.#retired.size,
      orderViews: this.#orderViews.metrics().tracked,
      tombstones: this.#tombstones.size,
      heldUnowned: this.#heldUnowned.size,
      watchedOrders: this.#watchedOrders.size,
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
    return this.#held.ledger;
  }

  /**
   * `FOLD-1`: the HELD ledger view — the projection the loop's four read
   * sites read, advanced per posting rather than folded from zero. It is
   * frozen, and equals `projectLedger(ledger())` byte for byte and in Map
   * order; that equality is what {@link checkAccountingRebuild} and the
   * cadence checks verify. Published for the harnesses that pin it.
   */
  ledgerView(): LedgerProjection {
    return this.#held.view;
  }

  /**
   * `FOLD-1`: one instance's HELD PnL state — the fold of the records its
   * last snapshot or check folded (all of them, unless a refused record stops
   * the stream, when it is the state before that record) — or `undefined`
   * before its first snapshot or check. Between a fill whose store write
   * failed and the next snapshot or check it can be behind `pnlRecords()`,
   * as base's last snapshot was; a check catches it up before it compares.
   * Published for the harnesses that pin it.
   */
  pnlState(instanceId: string): PnlState | undefined {
    return this.#held.pnlState(instanceId);
  }

  /**
   * `FOLD-1` (user ruling F2): the rebuild check a run ends with — at
   * SHUTDOWN (`main.ts`, once the pump stops) and at the END OF A RUN (a
   * backtest's `runBacktest`, the test harnesses). Always checks the ledger
   * view; also every instance's PnL stream, over its WHOLE record list, when
   * the loop's cadence has `pnl` on.
   *
   * A mismatch is a GLOBAL `ACCOUNTING_REBUILD_MISMATCH` halt, exactly as on
   * the cadence; the answer says whether one was found. TOTAL: never throws.
   */
  checkAccountingRebuild(trigger: "SHUTDOWN" | "END_OF_RUN"): AccountingRebuildCheck {
    const at = trigger === "SHUTDOWN" ? "at shutdown" : "at the end of the run";
    const ledgerMatched = this.#checkLedgerRebuild(at, this.#lastInstant);
    const pnl = this.#held.pnlCheck ? this.#checkPnlRebuild(at, this.#lastInstant) : { matched: true, checked: 0 };
    return Object.freeze({ matched: ledgerMatched && pnl.matched, pnlStreamsChecked: pnl.checked });
  }

  /**
   * `CADENCE-1`: the evaluation cadence this loop runs with (ADR-026 D1) — the
   * two settings and, for a declared reproduction, what it reproduces. A
   * fresh frozen record; a run's artifact prints it.
   */
  evaluationCadence(): EvaluationCadenceOption {
    return this.#cadenceOption;
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
        folds: this.#held.health(),
      },
      // The cast narrows only what was supplied on the lines above: both
      // `TRDR-4` seams and the `FOLD-1` seam are passed, and
      // `HealthState.snapshot` carries every seam it is given.
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

  /**
   * Processes every queued event, in delivery order. Never sorts (§8.4).
   *
   * `THROUGHPUT-1a`: with a group-committing store, everything staged is
   * committed before this returns — so when the pump records the stream
   * position after a drain, every decision of the events before it is durable
   * (or a GLOBAL `STORE_UNAVAILABLE` halt is latched, and the pump records
   * nothing).
   */
  async drain(options: { readonly awaitDurable?: boolean } = {}): Promise<void> {
    for (;;) {
      const event = this.#queue.take();
      if (event === undefined) break;
      // `THROUGHPUT-2` (ADR-024): an event CLOSES its venue frame when the
      // next queued event belongs to another frame, or when nothing is queued
      // after it. The second half is the producers' obligation: a batch
      // handed to one drain should never end in the middle of a frame
      // (`frames.ts`; ADR-024 §2), so no frame is open across two drains.
      // One case cannot meet it: a single frame larger than the live feed's
      // batch is handed out in parts (`RedisMarketEventFeed.framesSplit`),
      // and each part closes here as if it were the frame. `THROUGHPUT-1c`
      // r8 (R8-H1): book freshness does NOT rely on this obligation. A
      // frame's session confirmations are used only once a later event of
      // its epoch has been processed (`#frameGate`), so a part closed here
      // cannot vouch for any book.
      const next = this.#queue.peek();
      const closesFrame = next === undefined || !sameFrame(event.envelope, next.envelope);
      await this.#processEvent(event, closesFrame);
    }
    // Only a group-committing store has anything staged; every other store's
    // drain returns exactly as it always did. `awaitDurable: false` (the
    // pump's pipelined path) requests the commit and returns at once; the
    // caller then waits on `durabilityMark()` before recording anything that
    // depends on the rows.
    const group = this.#options.store.groupCommit;
    if (group === undefined) return;
    if (options.awaitDurable === false) {
      if (group.stagedEvents > 0) this.#requestCommit(group);
      return;
    }
    await this.#commitStaged();
  }

  /**
   * One event, §8.1 steps 1-9.
   *
   * `THROUGHPUT-2` (ADR-024): `closesFrame` says whether this is the LAST event
   * of its venue frame (`drain`). A frame of ONE event — every reference tick,
   * trade, snapshot, lifecycle event and incident that arrived alone — takes
   * exactly the path it always took. An event of a LONGER frame updates every
   * piece of state exactly as before (steps 1-2: the door, the instant, the
   * venue's position, the basket judgement, the cancel sweep, the books, trades
   * and reference prices), but its `onFeatures` evaluations, the fill harvest
   * and the outbox flush wait for the frame's closing event, which evaluates
   * each market the frame touched ONCE, on the fully applied frame
   * ({@link CoreLoop.#closeFrame}). No event is skipped; only WHEN the
   * callback fires changes.
   */
  async #processEvent(event: IngestedEvent, closesFrame: boolean): Promise<void> {
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
      // A refused event that closes a frame still closes it: the events
      // before it were applied and are owed their evaluation.
      if (closesFrame) await this.#closeFrame();
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
      if (closesFrame) await this.#closeFrame();
      return;
    }
    this.#lastInstant = instant.instant;
    this.#lastEpochMs = instant.epochMs;
    this.#options.health.countLoop("eventsProcessed");
    // `CADENCE-1` (ADR-026 D2.1): the event is APPLIED — it passed the door and
    // its instant normalised — so it, and only it, moves the cadence clock.
    this.#observeCadence(instant.epochMs, instant.instant);
    // `THROUGHPUT-1c` (ADR-023 D5): every consumed event is offered to the
    // delivery-session table before anything else reads it, so a book
    // evaluated at this event's instant is vouched for by at most this event.
    this.#observeDeliverySession(envelope, instant.instant, instant.epochMs);

    // The venue is positioned at the recorded event before anything it produces
    // can be anchored (§6 invariant 15: no future venue timestamp). Its answer
    // is READ (SIM-1 r1, `SIM1-R1-1`): it used to be dropped, so a DELAYED
    // order the venue could not resolve stayed open — its reservation,
    // allocator commitment and time-in-force held — with nothing said.
    const positioned = this.#options.venue.observe(event.identity);
    if (!positioned.ok) this.#haltOnVenueObservation("observe", positioned.refusal, instant.instant);
    // SIM-1 r2 (`SIM1-R2-1`): `observe()` is where recorded time applies a
    // DELAYED order's disposition and a GTD's expiry, so a watched basket is
    // judged here — before this event evaluates any strategy.
    this.#judgeBasketWatches(instant.instant);

    // `THROUGHPUT-2` (ADR-024): an event inside a longer frame — not its
    // last, or its last with earlier events already applied — is applied now
    // and evaluated at the frame's close. A frame of one continues below,
    // exactly as every event did before.
    if (!closesFrame || this.#frame !== undefined) {
      await this.#applyWithinFrame(event, envelope, instant.instant, instant.epochMs);
      if (closesFrame) await this.#closeFrame();
      return;
    }

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
        if (this.#options.halts.isMarketHalted(marketId)) {
          this.#cadence.dropOwed(marketId);
          continue;
        }
        market.observeInstant(instant.instant, instant.epochMs);
        // `CADENCE-1` (ADR-026 D2): every market is owed; each is evaluated
        // only if the cadence allows it at this close, and stays owed if not.
        if (!this.#admitOwed(marketId)) continue;
        await this.#evaluateMarket(
          market,
          dispatchPositionOf(envelope),
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
    // `CADENCE-1` (ADR-026 D3.2): this event is the frame's last APPLIED event,
    // so it is the source of every carried-over or heartbeat evaluation its
    // close runs — even though it owes no configured market one.
    const applied: AppliedEventPosition = {
      source: dispatchPositionOf(envelope),
      instant: instant.instant,
      epochMs: instant.epochMs,
    };
    if (known.length === 0) {
      // ADR-024: an event that names no configured market harvests nothing
      // and flushes nothing — unless the cadence evaluated something at its
      // close, whose decisions and fills must be harvested and flushed as any
      // evaluation's are. At the per-frame value 0 that never happens.
      if (!(await this.#runCarriedPass(applied, new Set()))) return;
      await this.#harvestFills(instant.instant);
      await this.#flushOutbox();
      return;
    }

    // --- every cancel reaches a terminal fact (WP-220 obligation 10) -------
    this.#sweepCancels(instant.instant, instant.epochMs);

    // `CADENCE-1`: the markets this close has decided (evaluated or coalesced),
    // so each is decided at most once per close (ADR-026 D2.12).
    const decided = new Set<string>();
    for (const marketId of known) {
      const market = this.#options.markets.get(marketId);
      if (market === undefined) continue;
      market.observeInstant(instant.instant, instant.epochMs);
      const callback = this.#applyEvent(market, envelope, event, instant.instant, instant.epochMs);
      if (callback === undefined) continue;
      if (this.#options.halts.isMarketHalted(marketId)) {
        this.#cadence.dropOwed(marketId);
        continue;
      }
      // `CADENCE-1` (ADR-026, the ADR-024 D3 one-event row): every callback
      // other than `onFeatures` fires in place, as before (D4). The
      // `onFeatures` evaluation follows the cadence like any other frame's:
      // it runs here, in place, only if the cadence allows it at this close.
      if (callback.kind === "onFeatures") {
        if (!this.#cadence.perFrame) {
          if (decided.has(marketId)) continue;
          decided.add(marketId);
        }
        if (!this.#admitOwed(marketId)) continue;
      }
      // --- steps 3-9 -------------------------------------------------------
      await this.#evaluateMarket(market, dispatchPositionOf(envelope), callback, instant.instant, instant.epochMs);
    }
    // `CADENCE-1` (ADR-026 D2.12): then the carried-over and heartbeat
    // evaluations, in configured order, sourced at this event (D3.2).
    await this.#runCarriedPass(applied, decided);

    // --- fills the venue produced, plus their accounting -------------------
    await this.#harvestFills(instant.instant);

    // --- persist decisions and checkpoints (§4.2 halts on a store failure) --
    await this.#flushOutbox();
  }

  /**
   * `THROUGHPUT-2` (ADR-024) — step 2 for one event of a frame longer than one
   * event: EXACTLY the state updates the single-event path makes, in the same
   * order, with each `onFeatures` evaluation recorded as OWED rather than run.
   * A callback that is not `onFeatures` (a lifecycle transition) still fires
   * here, in place, as it always did: coalescing changes only when a market's
   * features are evaluated, never whether a lifecycle callback is delivered.
   */
  async #applyWithinFrame(
    event: IngestedEvent,
    envelope: EventEnvelopeOf,
    instant: string,
    epochMs: number,
  ): Promise<void> {
    const frame = (this.#frame ??= { owed: new Map(), harvestAt: undefined, lastApplied: undefined });
    // r1 (`TP2-R1-M1`): what an event contributes is recorded only where it
    // would have acted alone — an owed evaluation names THIS event, and the
    // harvest instant moves only for an event that reaches the harvest point.
    // An event for a market this trader does not run changes neither.
    const at: OwedEvaluation["at"] = { source: dispatchPositionOf(envelope), instant, epochMs };
    // `CADENCE-1` (ADR-026 D3.2): EVERY applied event of the frame — one for a
    // market this trader does not run included — is, while it is the latest,
    // the source of the close's carried-over and heartbeat evaluations.
    frame.lastApplied = at;

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
          observedAt: instant,
          observedAtEpochMs: epochMs,
        });
      }
      this.#sweepCancels(instant, epochMs);
      for (const [marketId, market] of this.#options.markets) {
        if (this.#options.halts.isMarketHalted(marketId)) continue;
        market.observeInstant(instant, epochMs);
        oweEvaluation(frame, marketId, market, at);
      }
      frame.harvestAt = instant;
      return;
    }

    const affected = affectedMarketIds(envelope.payload);
    const known = affected.filter((marketId) => this.#options.markets.has(marketId));
    if (known.length === 0) return;

    this.#sweepCancels(instant, epochMs);
    for (const marketId of known) {
      const market = this.#options.markets.get(marketId);
      if (market === undefined) continue;
      market.observeInstant(instant, epochMs);
      const callback = this.#applyEvent(market, envelope, event, instant, epochMs);
      if (callback === undefined) continue;
      if (this.#options.halts.isMarketHalted(marketId)) continue;
      if (callback.kind === "onFeatures") {
        oweEvaluation(frame, marketId, market, at);
        continue;
      }
      await this.#evaluateMarket(market, dispatchPositionOf(envelope), callback, instant, epochMs);
    }
    frame.harvestAt = instant;
  }

  /**
   * `THROUGHPUT-2` (ADR-024) — the frame's close: every market the frame owes
   * an `onFeatures` evaluation is evaluated ONCE, on the fully applied frame,
   * with — as its source event and instant — the LAST event of the frame that
   * owed THAT market an evaluation: exactly the event whose own evaluation of
   * that market base ran last. The markets are evaluated in the order of
   * those events (r1, `TP2-R1-M1`), so a frame's decisions are a subsequence
   * of the per-event cadence's, in its order. Then the fill harvest and the
   * outbox flush run, at the instant of the frame's last event that reached
   * the harvest point, as they do after a single event. A market halted
   * meanwhile is not evaluated (the same gate as always). A frame none of
   * whose events reached the harvest point (no configured market, no
   * reference price) harvests nothing, as each of those events alone would
   * not have.
   */
  async #closeFrame(): Promise<void> {
    const frame = this.#frame;
    if (frame === undefined) return;
    this.#frame = undefined;
    // `CADENCE-1` (ADR-026 D2.12): first the markets this frame owed, in the
    // order above, each only if the cadence allows it at this close...
    const decided = new Set<string>();
    for (const [marketId, owed] of frame.owed) {
      if (this.#options.halts.isMarketHalted(marketId)) {
        this.#cadence.dropOwed(marketId);
        continue;
      }
      decided.add(marketId);
      if (!this.#admitOwed(marketId)) continue;
      await this.#evaluateMarket(
        owed.market,
        owed.at.source,
        { kind: "onFeatures" },
        owed.at.instant,
        owed.at.epochMs,
      );
    }
    // ...then the carried-over and heartbeat evaluations, in configured order,
    // each sourced at the frame's last APPLIED event (D3.2). A frame with no
    // applied event has no `lastApplied` and evaluates nothing (D3.3) — and
    // such a frame is never opened: only an applied event opens one.
    let harvestAt = frame.harvestAt;
    if (frame.lastApplied !== undefined && (await this.#runCarriedPass(frame.lastApplied, decided))) {
      // The carried pass evaluated at the frame's last applied event, so that
      // event reached the harvest point: the harvest runs at its instant.
      harvestAt = frame.lastApplied.instant;
    }
    if (harvestAt === undefined) return;
    await this.#harvestFills(harvestAt);
    await this.#flushOutbox();
  }

  /**
   * `CADENCE-1` (ADR-026 D2.1, D2.10): one APPLIED event moves the cadence
   * clock; an event lying more than the alarm bound behind it is a
   * forward-jump alarm, counted, and an episode's start and end are told to
   * the composition root's hook. Never called for a refused event.
   */
  #observeCadence(epochMs: number, instant: string): void {
    const seen = this.#cadence.observeApplied(epochMs, instant);
    if (seen.alarmed) this.#options.health.countLoop("cadenceForwardJumpAlarms");
    const hook = this.#options.onCadenceAlarm;
    if (seen.transition === undefined || hook === undefined) return;
    try {
      hook(seen.transition);
    } catch {
      // Output only (see `CoreLoopOptions.onCadenceAlarm`): a log hook that
      // throws must not change what the loop does. The counter above moved.
    }
  }

  /**
   * `CADENCE-1` (ADR-026 D2.4-D2.6, D5.6): a market OWED at this close is
   * evaluated if the cadence allows it — its `last` becomes `t` — or else it
   * is COALESCED: counted once for this close, and carried, still owed, to a
   * later close. At the per-frame value 0 every owed market is evaluated.
   */
  #admitOwed(marketId: string): boolean {
    if (this.#cadence.due(marketId, true)) {
      this.#cadence.markEvaluated(marketId);
      return true;
    }
    this.#cadence.carry(marketId);
    this.#options.health.countLoop("evaluationsCoalesced");
    return false;
  }

  /**
   * `CADENCE-1` (ADR-026 D2.4, D2.7, D2.12, D3.2): after the markets the
   * closing frame owed, every OTHER configured market, in configured order —
   * the order a reference trade evaluates them in, each market's instances in
   * §8.2 order — is evaluated if the cadence allows it: a market still owed
   * from an earlier close once `t − last ≥ evaluationIntervalMs`, and any
   * market once `t − last ≥ evaluationHeartbeatMs`. Each such evaluation's
   * source and `evaluatedAt` are `applied`'s: the frame's last APPLIED event.
   * A market still owed and not allowed is coalesced again (counted for this
   * close). A halted market is not evaluated and its owed evaluation is
   * dropped (D2.11). Before the first evaluation, the cancels are swept at
   * `applied`'s instant, as before any evaluation an event triggers.
   *
   * Answers whether anything was evaluated. At the per-frame value 0 nothing
   * is carried and there is no heartbeat, so it evaluates nothing.
   */
  async #runCarriedPass(applied: AppliedEventPosition, decided: ReadonlySet<string>): Promise<boolean> {
    if (this.#cadence.perFrame) return false;
    const due: [string, MarketState][] = [];
    for (const [marketId, market] of this.#options.markets) {
      if (decided.has(marketId)) continue;
      if (this.#options.halts.isMarketHalted(marketId)) {
        this.#cadence.dropOwed(marketId);
        continue;
      }
      const carried = this.#cadence.isCarried(marketId);
      if (this.#cadence.due(marketId, carried)) {
        due.push([marketId, market]);
      } else if (carried) {
        this.#options.health.countLoop("evaluationsCoalesced");
      }
    }
    if (due.length === 0) return false;
    // --- every cancel reaches a terminal fact (WP-220 obligation 10) -------
    this.#sweepCancels(applied.instant, applied.epochMs);
    for (const [marketId, market] of due) {
      // An evaluation earlier in this pass, or the sweep, may have halted it.
      if (this.#options.halts.isMarketHalted(marketId)) {
        this.#cadence.dropOwed(marketId);
        continue;
      }
      this.#cadence.markEvaluated(marketId);
      await this.#evaluateMarket(market, applied.source, { kind: "onFeatures" }, applied.instant, applied.epochMs);
    }
    return true;
  }

  /**
   * SIM-1 r1 (`SIM1-R1-1`): the venue could not do what recorded time asked of
   * it — `observe` refused to position it, or a DELAYED order's disposition
   * could not be applied — so the process HALTS, GLOBAL, `VENUE_OBSERVATION_FAILED`
   * (§9.9 `RECONCILE_ACCOUNT`: the venue's account no longer answers for what
   * its model says happened). GLOBAL because the venue is ONE account: cash
   * every market draws on is exactly what a failed fill accounting could not
   * book.
   *
   * What the halt does NOT stop is the capital path. The venue reports such a
   * DELAYED order REJECTED with nothing booked, and `#deliverOrderViews`
   * releases a terminal order's reservation, allocator commitment and
   * time-in-force BEFORE its halt gate, so they come back at this event's
   * harvest; the view itself is suppressed — not an evaluation — and the order
   * is retired after the halt is released, as for every halt (R1).
   */
  #haltOnVenueObservation(
    door: "observe" | "observeTrade",
    refusal: VenueObservationRefusal | undefined,
    instant: string,
  ): void {
    this.#options.halts.halt(
      { kind: "GLOBAL" },
      "VENUE_OBSERVATION_FAILED",
      refusal === undefined
        ? `the venue's ${door} answered ok: false with no refusal`
        : `the venue's ${door} refused: ${refusal.code}: ${refusal.message}`,
      instant,
    );
  }

  /**
   * SIM-2: one order this process OWNS, looked up at the venue — or LOUD.
   *
   * An owned order was booked by the venue (`#ownBookedOrders` takes the
   * ids from its answer), and the loop has not ACKNOWLEDGED it (it does so
   * only after settling it), so the venue must still answer for it — a
   * venue that bounds its history holds every unacknowledged terminal order
   * (SIM-2 r1, `SIM2-R1-1`). One that cannot answer has lost state this
   * process relies on: it evicted the order anyway, or its order store
   * dropped it. That is never skipped silently (the old full-venue scans
   * would have skipped it without a word): the process HALTS, GLOBAL,
   * `VENUE_OBSERVATION_FAILED` (§9.9 `RECONCILE_ACCOUNT`), and the caller
   * treats the order as absent — nothing is released for it (fail closed).
   */
  #ownedOrder(venueOrderId: string, instant: string): SimulatedOrder | undefined {
    const order = this.#options.venue.orderById(venueOrderId);
    if (order === undefined) {
      this.#haltOnVenueMiss(
        `order ${venueOrderId}, which instance ${this.#orderOwners.get(venueOrderId) ?? "(none)"} owns`,
        instant,
      );
    }
    return order;
  }

  /** SIM-2: the venue no longer answers for state this process reads from it (see `#ownedOrder`). */
  #haltOnVenueMiss(what: string, instant: string): void {
    this.#options.halts.halt(
      { kind: "GLOBAL" },
      "VENUE_OBSERVATION_FAILED",
      `the venue no longer answers for ${what}, which this process has not acknowledged: ` +
        "evicted from its bounded history regardless, or never held. " +
        "This process reads no venue history, so it cannot rebuild the state it is missing; " +
        "reconcile the account (SIM-2)",
      instant,
    );
  }

  /**
   * SIM-2 r1 (`SIM2-R1-1`): tells the venue this process is DONE with a
   * terminal order — unless a watched basket still reads it, in which case
   * `#forgetWatch` acknowledges it when the watch concludes. The one place the
   * loop acknowledges: after `#settle`, after a held order's release, and at
   * a watch's end.
   */
  #acknowledgeIfDone(venueOrderId: string): void {
    if (this.#watchedOrders.has(venueOrderId)) return;
    this.#options.venue.acknowledgeTerminal(venueOrderId);
  }

  /**
   * Applies one event to local state and answers which callback it triggers.
   *
   * `undefined` means "state updated, no evaluation" — which is the honest
   * answer for an event that changes nothing a strategy reads.
   */
  #applyEvent(
    market: MarketState,
    envelope: {
      readonly eventType: string;
      readonly payload: unknown;
      readonly gatewayEpoch: string;
      readonly ingestSeq: string;
      readonly subscriptionGeneration?: number;
      readonly venueTimestamp?: string;
      readonly connectionId?: string;
      readonly source?: string;
    },
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
        this.#noteBookSession(market, envelope);
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
        this.#noteBookSession(market, envelope);
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
        const traded = this.#options.venue.observeTrade({
          marketId: market.config.marketId,
          side: tokenId === market.config.yesTokenId ? "YES" : "NO",
          price,
          shares: size,
          monotonicNs: this.#options.clock.monotonicNs(),
          atEvent: event.identity,
        });
        // SIM-1 r1: the one refusal read here is a DELAYED disposition the
        // venue could not apply at this trade's instant — the same failure
        // `observe()` reports, reached first by the trade. Every OTHER
        // `observeTrade` refusal is still unread (`VS-20`, not this package).
        if (!traded.ok && traded.refusal?.code === DISPOSITION_NOT_APPLIED) {
          this.#haltOnVenueObservation("observeTrade", traded.refusal, instant);
        }
        // SIM-1 r2 (`SIM1-R2-1`): the trade's instant can resolve a DELAYED
        // order too (a venue clock that lags the loop's), so a watched basket
        // is judged before the caller evaluates this market.
        this.#judgeBasketWatches(instant);
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

  /**
   * §8.1 steps 3-9 for one market's instances, in §8.2 order.
   *
   * `PROVENANCE-1`: `source` is the triggering event's dispatch position —
   * its own §7.1 `eventId`, `gatewayEpoch` and `ingestSeq` — and every
   * decision this evaluates carries all three (`#buildEvaluationInput`). It
   * used to be the `eventId` alone, so every persisted decision's
   * `gateway_epoch` and `ingest_seq` were NULL (`H1R1-PROVENANCE`).
   */
  async #evaluateMarket(
    market: MarketState,
    source: DispatchPosition,
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
        source,
      });
      const outcome = instance.runtime.evaluate(input);
      await this.#consumeOutcome(instance, market, outcome, source, instant, epochMs);
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
    // `THROUGHPUT-1c` (ADR-023 D5): the book section's `lastEventAt` is the
    // instant the book is vouched for — its last change under `LAST_CHANGE`
    // (exactly the pre-ADR-023 value), the confirmed instant under
    // `CONNECTION_CONFIRMED`. `quality.input_feed_ages` reports its age.
    const bookEventAt =
      this.#bookConfirmedAt(market, outcome, epochMs)?.iso ??
      market.bookFor(outcome).lastUpdate()?.receivedAt ??
      instant;
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
     * did: its `eventId`, `gatewayEpoch` and `ingestSeq` (`PROVENANCE-1`; it
     * was the `eventId` alone).
     *
     * `undefined` for a delivery the loop originates rather than an event —
     * an `onFill` or an `onOrderUpdate` — and the field is then OMITTED, not
     * blanked. `SourceEventRef` is "optional as a GROUP", and an empty string
     * is not a UUID: supplying one made the runtime refuse the evaluation with
     * `INPUT_INVALID`, so a fill was never delivered to the strategy at all.
     * The three values are the envelope's own, which the event door already
     * held to the frozen §7.1 contract (`UuidSchema`,
     * `UnsignedBigIntStringSchema`) — the same schemas the runtime's input
     * door applies to `sourceEvent`, so a position the door admitted is one
     * the runtime admits.
     */
    readonly source: DispatchPosition | undefined;
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
      ...(input.source === undefined
        ? {}
        : {
            sourceEvent: {
              eventId: input.source.eventId,
              gatewayEpoch: input.source.gatewayEpoch,
              ingestSeq: input.source.ingestSeq,
            },
          }),
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
   *
   * `FOLD-1`: the HELD view, which a posting advances before its ledger is
   * adopted (`HeldAccounting.adopt`), so the same holds without a fold here.
   */
  #positionView(instance: RegisteredInstance, instant: string): VirtualPositionView {
    const projection = this.#held.view;
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
   *
   * SIM-2: built from the instance's OWN order set, in venue order, one lookup
   * per order — O(its orders), not O(every order the venue ever held).
   */
  #orderViews_(instance: RegisteredInstance, instant: string): readonly StrategyOrderView[] {
    const owned = this.#instanceOrders.get(instance.instanceId);
    if (owned === undefined) return Object.freeze([]);
    const views: StrategyOrderView[] = [];
    for (const venueOrderId of inVenueOrder(owned)) {
      if (this.#retired.has(venueOrderId)) continue;
      const order = this.#ownedOrder(venueOrderId, instant);
      if (order === undefined) continue;
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

  /**
   * Handles one `EvaluationOutcome` and walks its intents through the pipeline.
   *
   * `source` is the triggering event's dispatch position, or `null` for an
   * evaluation the loop originates (`onFill`, `onOrderUpdate`), whose trace
   * and provenance records carry `""` as their source event id, as before.
   */
  async #consumeOutcome(
    instance: RegisteredInstance,
    market: MarketState,
    outcome: EvaluationOutcome,
    source: DispatchPosition | null,
    instant: string,
    epochMs: number,
  ): Promise<void> {
    const eventId = source?.eventId ?? "";
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
        this.#routingUndurableDecision = false;
        // `DURABLE-1` r1 (A01): cancels before placements — see `cancelsFirst`.
        for (const intent of cancelsFirst(outcome.record.decision.intents)) {
          await this.#routeIntent({
            instance,
            market,
            intent,
            eventId,
            source,
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
    /** `PROVENANCE-1`: the decision's triggering event, for a refusal's record. */
    readonly source: DispatchPosition | null;
    readonly featureSnapshotRef: string;
    readonly evaluationSeq: number;
    readonly instant: string;
    readonly epochMs: number;
  }): Promise<void> {
    if (input.instance.ownership !== "OWNER") {
      this.#options.health.countExecution("observeOnlyIntents");
      return;
    }
    // `DURABLE-1`: the decision that emitted this placement could not be made
    // durable (see below). Such a placement is REFUSED — never reserved,
    // planned or submitted — whatever the risk seam answers.
    let undurable = false;
    if (input.intent.type === "CANCEL") {
      // `THROUGHPUT-1a` (unchanged from base): with group commit, every
      // decision ALREADY STAGED — earlier events' — is durable before an
      // intent is routed toward the venue, as it was when each was written at
      // its own event. So this awaits the commit chain, including a commit
      // already in flight: a store that hangs on an EARLIER batch holds a
      // CANCEL here exactly as it did on base. A failed commit halts; a CANCEL
      // is still routed (§6 invariant 13: the risk seam never blocks one). A
      // store without group commit has nothing staged, and does not wait.
      //
      // `DURABLE-1`: a CANCEL does NOT add a wait for its OWN decision's
      // record. It places nothing — no allocation, no reservation, no fill,
      // no ledger posting — so no economic effect can precede that record,
      // and a safety exit gains no new store round trip. Its decision is
      // written by the flush that follows the callback, as always, and a
      // failure there halts. (A deviation from the literal §8.1 order for a
      // CANCEL only; see the DURABLE-1 handoff.)
      if (this.#options.store.groupCommit !== undefined) await this.#commitStaged();
    } else if (!(await this.#persistDecisionsBeforePlacement())) {
      // `DURABLE-1` (handoff §8.1, §6 invariants 3-4, WP-230 #4): the GLOBAL
      // `STORE_UNAVAILABLE` halt is latched. The intent goes on only as far
      // as the risk seam, which refuses it under that halt (§9.8 check 1,
      // `RISK_RUN_STATE_BLOCKS`) and COUNTS the refusal — a protective exit's
      // too, in `risk.refusedExits` (r1, finding LOW-4) — exactly as it counts
      // every placement refused under a halt. Nothing the allocator is asked
      // commits anything (`evaluate` "changes nothing"); the return after the
      // seam does not depend on its verdict.
      undurable = true;
    }
    // `CO2-N1` (ADR-031 R1): a PLACEMENT reads the process clock once, HERE —
    // after its decision is durable (so a slow commit counts as lag) and
    // before its risk input is built. A CANCEL reads nothing; its path is
    // unchanged (§6 invariant 13).
    const admission =
      input.intent.type === "CANCEL" ? undefined : this.#admissionMeasurements(input.epochMs);
    const approvedIntentId = this.#options.ids.next();
    const marketConfig = input.market.config;
    const projection = this.#held.view;
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
      // ADR-031 R4: from the later of the event instant and the process
      // instant (the event instant for a CANCEL, or an unreadable reading).
      secondsToClose: this.#secondsToClose(marketConfig, admission?.closeFromEpochMs ?? input.epochMs),
      bookSynchronized: input.market.bookFor(input.instance.direction).baseline() !== undefined,
      venueBookAgeMs: bookAgeMs,
      // ADR-031 R3/R5: the feature snapshot's age at admission is the lag;
      // `undefined` (an unreadable reading) is OMITTED, so check 7 refuses an
      // entry `RISK_FRESHNESS_UNKNOWN`. A CANCEL keeps the constant 0.
      featuresAgeMs: admission === undefined ? 0 : admission.featuresAgeMs,
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
      // `PROVENANCE-1`: the refusal is made durable with the event's other
      // rows (`#flushOutbox`), as `ops.risk_events` evidence (ADR-028
      // Decision 3.1) — unless durability is lost by then: a refusal under a
      // `STORE_UNAVAILABLE` halt (`DURABLE-1`'s undurable decision among
      // them) is the halt's own consequence, and nothing is written after the
      // failure the halt reports (`#takeRiskRefusals`).
      this.#pendingRiskRefusals.push(
        Object.freeze({
          runId: input.instance.runId,
          instanceId: input.instance.instanceId,
          marketId: input.instance.marketId,
          evaluationSeq: input.evaluationSeq,
          intentId: intentIdOf(input.intent),
          protectiveExit: isProtectiveExitIntent(input.intent),
          occurredAt: input.instant,
          refusals: Object.freeze(
            evaluation.refusals.map((refusal) =>
              Object.freeze({ code: refusal.code, message: refusal.message }),
            ),
          ),
          sourceEvent: input.source,
        }),
      );
      return;
    }
    // `DURABLE-1`: the belt. The halt the boundary latched makes the seam
    // refuse above; were it ever to approve, the placement is still refused.
    if (undurable) return;
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
        projection: this.#held.view,
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
    let result: ExecutionResult;
    try {
      result = await this.#options.venue.submit(input.plan);
    } catch (cause) {
      // SIM-2: a placement whose answer never arrived may have been booked in
      // whole or in part, and no answer says which. The harvest used to find
      // such orders by scanning every venue order and release them once
      // terminal; it scans nothing now, so they are TRACKED by planned id
      // (`#heldUnowned`) and released the same way. The failure itself still
      // propagates exactly as before.
      if (input.plan.planKind !== "CANCEL") {
        for (const group of placement.groups) {
          for (const order of group.orders) {
            if (!this.#heldUnowned.has(order.plannedOrderId)) this.#heldUnowned.set(order.plannedOrderId, undefined);
          }
        }
      }
      throw cause;
    }
    this.#absorbVenueAnswer(input, result, submissionAttemptId);
    // SIM-1 r3 (`SIM1-R3-1`): `submit` is one of the three doors through which
    // the venue's order state changes (with `observe()` and `observeTrade()`),
    // and the only one a STRATEGY opens — from an event's evaluation, an
    // `onFill` or an `onOrderUpdate` alike, every intent reaches the venue
    // here. A cancel (accepted, PARTIAL or refused) can leave a watched basket
    // short, so EVERY answer is followed by a judgement, before control goes
    // back to the decision's next intent (which the risk seam then refuses,
    // `runStatePermitsIntent` being `!anyHalt`) or to the harvest's next
    // delivery (which its halt gate suppresses). Free when nothing is watched.
    this.#judgeBasketWatches(input.instant);
  }

  /**
   * Settles one venue answer in this process's books — the cancel registry
   * for a CANCEL plan; ownership, the refused orders' release and the basket
   * watch for a placement — exactly as `#submitPlan` always did; it is its own
   * method so that every branch returns to the ONE judgement that follows it
   * (SIM-1 r3, `SIM1-R3-1`).
   */
  #absorbVenueAnswer(
    input: {
      readonly plan: ExecutionPlan;
      readonly instance: RegisteredInstance;
      readonly intent: Intent;
      readonly approvedIntentId: string;
      readonly evaluationSeq: number;
      readonly featureSnapshotRef: string;
      readonly eventId: string;
      readonly instant: string;
    },
    result: ExecutionResult,
    submissionAttemptId: string,
  ): void {
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
      // SIM-1, ruling R3 (2): whatever the venue says it BOOKED for this plan
      // is OWNED, exactly as on the accepted path below — owner, trace prefix,
      // provenance — so its fills are attributed and its views are delivered.
      // Only then is the rest of the plan settled.
      this.#ownBookedOrders(result.orders, input, submissionAttemptId);
      this.#releaseRefusedPlacement(input.plan, result, input.instant);
      this.#watchBasket(input.plan, result, input.instant);
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

    this.#ownBookedOrders(result.orders, input, submissionAttemptId);
    // SIM-1 r2 (`SIM1-R2-1`): `accepted` says every planned order was PLACED,
    // not that each EXECUTED — a booked FOK can be REJECTED, a FAK CANCELLED
    // short, a DELAYED order still pending — so an accepted basket is judged
    // from its orders' own outcomes too.
    this.#watchBasket(input.plan, result, input.instant);
  }

  /**
   * Registers ownership of orders the venue BOOKED for a plan: the owner, the
   * instance's order set, the booked-shares counter, the trace prefix (the
   * prunable fill-join lookup) and the append-only provenance record.
   *
   * ONE path for an accepted plan and for the booked part of a partly
   * executed one (SIM-1, ruling R3): an order the venue says it booked is an
   * order this process placed, whatever happened to the rest of its plan, so
   * it is owned the same way — its fills are attributed, its views delivered,
   * and it is retired and settled under `TRDR-4`'s rules like any other.
   */
  #ownBookedOrders(
    orders: readonly SimulatedOrder[],
    input: {
      readonly plan: ExecutionPlan;
      readonly instance: RegisteredInstance;
      readonly intent: Intent;
      readonly approvedIntentId: string;
      readonly evaluationSeq: number;
      readonly featureSnapshotRef: string;
      readonly eventId: string;
    },
    submissionAttemptId: string,
  ): void {
    for (const order of orders) {
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
   * A placement the venue did not WHOLLY accept: release what its REFUSED
   * orders reserved, keep what its BOOKED and HELD orders reserved, and halt
   * where nothing in this process can finish the plan.
   *
   * Review round 1, MEDIUM-4: the only release path used to be
   * `#deliverOrderViews`'s terminal-status arm, and a refused plan has no owned
   * order to deliver, so its reservation stayed taken FOREVER — `reserved` grew
   * monotonically, understating `availableCollateral` on the planning surface
   * and the unreserved balance on the strategy's `riskBudget`, until entries
   * starved with no visible cause. The venue said no; the capacity comes back.
   *
   * SIM-1, the user's ruling R3 — PER-ORDER RESULTS. The venue now reports
   * each planned order's outcome: `result.orders` lists what it BOOKED (on a
   * partial outcome as on a full one) and `result.notPlaced` what it did not.
   * The booked orders were made OWNED by the caller (`#ownBookedOrders`)
   * before this runs. Each planned order is then settled by its PLANNED order
   * id — the key the three release books use — in one of three ways:
   *
   * - BOOKED (listed in `result.orders`): owned and tracked like any accepted
   *   order. Its reservation, allocator commitment and time-in-force are KEPT
   *   and come back at the first harvest that sees it terminal (ADR-006 §9:
   *   never released before terminal).
   * - HELD but NOT LISTED — the venue's own order state holds an order under
   *   the id although its answer did not book it. `TRDR-4` round 1
   *   (TRDR4-R1), kept as the DEFENSIVE path: the real simulator no longer
   *   answers this way (it lists what it booked), but a venue that refuses
   *   while still holding orders — a live adapter whose answer is incomplete —
   *   can. Such an order is a reconciliation question (§6 invariant 6: an
   *   unknown submission is never a silent retry): no instance owns it, its
   *   entries are KEPT (released by `#releaseSettledReservations` at the
   *   harvest that sees it terminal — SIM-2: it is TRACKED in `#heldUnowned`
   *   for that, because the harvest no longer walks every venue order), a
   *   fill of its is booked UNATTRIBUTED (`#bookUnownedFill`), and its market
   *   is halted NOW — `UNATTRIBUTED_ACTIVITY`, whose §9.9 action is
   *   `RECONCILE_ACCOUNT`.
   * - NEITHER: the venue did not place it (it is in `notPlaced`, or the venue
   *   holds nothing under its id). Its reservation, allocator commitment and
   *   time-in-force are released NOW and counted
   *   (`reservationsReleasedOnRefusal`).
   *
   * A POSITION or REDUCE_POSITION plan that was partly booked raises NO halt:
   * every one of its orders is accounted for — booked and owned, or refused
   * and released — and the strategy sees the booked ones through the normal
   * delivery (`onOrderUpdate`, `ctx.orders()`) and re-plans from there.
   *
   * A BASKET plan that was partly booked HALTS every market it names
   * (`BASKET_PARTIALLY_EXECUTED`, `MANAGE_KNOWN_POSITIONS_ONLY`) — no longer
   * here but in `#watchBasket`, which the caller runs next and which judges an
   * ACCEPTED basket too (SIM-1 r2, `SIM1-R2-1`): a basket every order of which
   * was booked can still have executed only in part.
   */
  #releaseRefusedPlacement(
    plan: Exclude<ExecutionPlan, { readonly planKind: "CANCEL" }>,
    result: ExecutionResult,
    instant: string,
  ): void {
    const plannedOrderIds: string[] = [];
    for (const group of plan.groups) {
      for (const order of group.orders) plannedOrderIds.push(order.plannedOrderId);
    }
    const planned = new Set(plannedOrderIds);
    // Keyed by the PLANNED order id: the venue's `simulatedOrderId` is its own
    // id for the order and is only coincidentally equal in the simulator.
    const booked = new Set<string>();
    for (const order of result.orders) {
      if (planned.has(order.plannedOrderId)) booked.add(order.plannedOrderId);
    }
    // The DEFENSIVE path: what the venue's own order state holds for this plan
    // that its answer did not list as booked. SIM-2: one lookup per planned
    // order the answer did not book, instead of a scan of every venue order.
    const venueHeld = new Map<string, SimulatedOrder>();
    for (const plannedOrderId of plannedOrderIds) {
      if (booked.has(plannedOrderId)) continue;
      const order = this.#options.venue.orderByPlannedId(plannedOrderId);
      if (order !== undefined && order.plannedOrderId === plannedOrderId) venueHeld.set(plannedOrderId, order);
    }
    // …and TRACKED, so the harvest that sees each one terminal releases it.
    for (const order of venueHeld.values()) this.#heldUnowned.set(order.plannedOrderId, order.simulatedOrderId);
    const held = plannedOrderIds.flatMap((plannedOrderId) => {
      const order = venueHeld.get(plannedOrderId);
      return order === undefined ? [] : [order];
    });

    for (const plannedOrderId of plannedOrderIds) {
      if (booked.has(plannedOrderId) || venueHeld.has(plannedOrderId)) continue;
      if (this.#reservations.releaseForOrder(plannedOrderId)) {
        this.#options.health.countExecution("reservationsReleasedOnRefusal");
      }
      this.#options.allocator.release(plannedOrderId);
      this.#timeInForce.release(plannedOrderId);
    }

    const refusal = `${result.refusalCode ?? "VENUE_REFUSED"}: ${result.refusalMessage ?? "the venue refused the plan"}`;
    if (held.length > 0) {
      const described = held
        .map(
          (order) =>
            `${order.simulatedOrderId} (planned ${order.plannedOrderId}) ${order.state} ` +
            `${order.filledShares}/${order.requestedShares}`,
        )
        .join(", ");
      for (const marketId of [...new Set(held.map((order) => order.marketId))].sort()) {
        this.#options.halts.halt(
          { kind: "MARKET", marketId },
          "UNATTRIBUTED_ACTIVITY",
          `plan ${plan.executionPlanId} was refused (${refusal}), yet the venue holds ` +
            `${String(held.length)} of its ${String(plannedOrderIds.length)} planned orders that ` +
            `its answer did not list as booked — partly executed and then refused: ${described}. ` +
            "No instance owns them; their reservations, allocator commitments and time-in-force " +
            "are KEPT until each is terminal, and any fill of theirs is booked UNATTRIBUTED; " +
            "reconcile the account (§6 invariant 6, TRDR-4)",
          instant,
        );
      }
    }
  }

  /**
   * Starts judging a BASKET plan the venue booked anything of — SIM-1 r2
   * (`SIM1-R2-1`), the trader's side of the user's ruling R3 for baskets.
   *
   * THIS IS WHERE "BASKET" IS DETECTED: `plan.planKind === "BASKET"` on the
   * plan this process built. §7.7 makes basket execution "coordinated, not
   * assumed atomic", and the basket carries a `failurePolicy` (ABANDON /
   * PROTECTED_UNWIND / HOLD_FILLED_LEGS) for exactly the state in which its
   * legs did not all execute — but nothing in this process consumes it yet, so
   * the process stops deciding for the basket's markets rather than leave a
   * half-built basket for the strategy to re-plan as if it were a single
   * position: `BASKET_PARTIALLY_EXECUTED`, `MANAGE_KNOWN_POSITIONS_ONLY`.
   *
   * WHY NOT FROM `result.accepted` ALONE (the finding). `accepted` says every
   * planned order was PLACED. An order the venue booked can still end without
   * executing — a FOK that cannot fill whole is REJECTED (SIM-1 O2), a FAK's
   * remainder CANCELLED (O1) — or reach its outcome only later (a DELAYED
   * order at `matchableAtNs`, O5; a GTD at its expiry, O4). The basket is
   * therefore judged from EACH ORDER'S OWN outcome
   * ({@link judgeBasketExecution}): now, from the venue's answer; and, while
   * any of its orders can still execute, again after EVERY door through which
   * the venue's order state can change — right after `observe()` and after
   * `observeTrade()` (where DELAYED dispositions and expiries are applied), and
   * right after every `submit()` answer (`#submitPlan`: a cancel a strategy
   * emitted from an event's evaluation, an `onFill` or an `onOrderUpdate`,
   * whether the venue accepted it, cancelled part of it or refused it; SIM-1
   * r3, `SIM1-R3-1`) — plus once in the harvest before anything is delivered.
   * So the halt lands BEFORE the strategy is evaluated again for a market
   * whose basket has just gone short, and before the next intent of the same
   * decision is routed: that intent meets the risk seam's run-state check
   * (`runStatePermitsIntent` is `!anyHalt`), and the harvest's next delivery
   * meets its halt gate.
   *
   * WHAT THIS DOES NOT TOUCH. Ownership (`#ownBookedOrders` ran first) and the
   * release rules: a booked order keeps its reservation, allocator commitment
   * and time-in-force until the harvest that sees it terminal (ADR-006 §9), as
   * every order does; a halted market's deliveries are suppressed and its
   * terminal orders retired after the halt is released, as for every halt.
   */
  #watchBasket(plan: ExecutionPlan, result: ExecutionResult, instant: string): void {
    if (plan.planKind !== "BASKET") return;
    const planned = new Set<string>();
    for (const group of plan.groups) {
      for (const order of group.orders) planned.add(order.plannedOrderId);
    }
    const booked = result.orders.filter((order) => planned.has(order.plannedOrderId));
    // A basket the venue booked NOTHING of was released whole by
    // `#releaseRefusedPlacement` (or its orders are the defensive path's):
    // nothing of it is owned, so nothing is left to judge.
    if (booked.length === 0) return;
    const watch: BasketWatch = Object.freeze({
      executionPlanId: plan.executionPlanId,
      failurePolicy: plan.failurePolicy,
      marketIds: Object.freeze([...new Set(plan.groups.map((group) => group.marketId))].sort()),
      plannedCount: planned.size,
      venueOrderIds: Object.freeze(booked.map((order) => order.simulatedOrderId)),
      notPlacedCount: result.notPlaced.length,
      notPlacedDescribed: result.notPlaced
        .map((entry) => `${entry.plannedOrderId} (${entry.refusalCode})`)
        .join(", "),
      refusal: result.accepted
        ? undefined
        : `${result.refusalCode ?? "VENUE_REFUSED"}: ${result.refusalMessage ?? "the venue refused the plan"}`,
    });
    this.#judgeBasket(watch, new Map(booked.map((order) => [order.simulatedOrderId, order])), instant);
  }

  /**
   * Judges every WATCHED basket against the venue's order state now (see
   * `#watchBasket` for where and why this runs). Free when nothing is watched.
   */
  #judgeBasketWatches(instant: string): void {
    if (this.#basketWatches.size === 0) return;
    // SIM-2: the watched baskets' own booked orders, one lookup each — not a
    // scan of every order the venue ever held. Every one is still answered:
    // the loop acknowledges a watched order to the venue only after its
    // watch concludes (`#watchedOrders`, SIM-2 r1), even when it has settled
    // it. An id the venue cannot answer for anyway is a LOUD miss, and is
    // absent from the map, which `judgeBasketExecution` reads as "not in the
    // venue's order state" (still working: fail closed).
    const orders = new Map<string, SimulatedOrder>();
    for (const watch of this.#basketWatches.values()) {
      for (const venueOrderId of watch.venueOrderIds) {
        if (orders.has(venueOrderId)) continue;
        const order = this.#options.venue.orderById(venueOrderId);
        if (order === undefined) {
          this.#haltOnVenueMiss(`order ${venueOrderId}, which basket plan ${watch.executionPlanId} watches`, instant);
          continue;
        }
        orders.set(venueOrderId, order);
      }
    }
    for (const watch of [...this.#basketWatches.values()]) this.#judgeBasket(watch, orders, instant);
  }

  /**
   * One basket, one judgement: keep watching it while it can still execute
   * and nothing ended short; forget it once every booked order is terminal
   * with no halt needed (all FILLED, or nothing executed at all); HALT its
   * markets — once — when it executed only IN PART.
   */
  #judgeBasket(watch: BasketWatch, orders: ReadonlyMap<string, SimulatedOrder>, instant: string): void {
    const booked = watch.venueOrderIds.map((venueOrderId) => orders.get(venueOrderId));
    const verdict = judgeBasketExecution({ booked, notPlaced: watch.notPlacedCount });
    if (verdict.kind === "WORKING") {
      this.#basketWatches.set(watch.executionPlanId, watch);
      for (const venueOrderId of watch.venueOrderIds) this.#watchedOrders.add(venueOrderId);
      return;
    }
    this.#basketWatches.delete(watch.executionPlanId);
    this.#forgetWatch(watch);
    if (verdict.kind === "COMPLETE") return;

    const why: string[] = [];
    if (verdict.notAllPlaced) why.push(watch.refusal ?? "the venue did not place every planned order");
    if (verdict.endedShort.length > 0) {
      why.push(
        `${String(verdict.endedShort.length)} booked order(s) ended short of their size while part ` +
          "of the basket executed or can still execute",
      );
    }
    const bookedDescribed = watch.venueOrderIds
      .map((venueOrderId, index) => {
        const order = booked[index];
        return order === undefined
          ? `${venueOrderId} (not in the venue's order state)`
          : `${order.simulatedOrderId} (planned ${order.plannedOrderId}) ${order.state} ` +
              `${order.filledShares}/${order.requestedShares}`;
      })
      .join(", ");
    for (const marketId of watch.marketIds) {
      this.#options.halts.halt(
        { kind: "MARKET", marketId },
        "BASKET_PARTIALLY_EXECUTED",
        `basket plan ${watch.executionPlanId} (failurePolicy ${watch.failurePolicy}) was executed ` +
          `only IN PART (${why.join("; ")}): the venue booked ${String(watch.venueOrderIds.length)} ` +
          `of its ${String(watch.plannedCount)} planned orders — ${bookedDescribed}; not placed: ` +
          `${watch.notPlacedDescribed === "" ? "(none listed)" : watch.notPlacedDescribed}. The booked ` +
          "orders are OWNED and tracked, and keep their reservations until terminal; nothing in this " +
          "process consumes the basket's failurePolicy yet, so its markets halt for an operator " +
          "decision (§7.7 coordinated, not atomic; SIM-1 R3, SIM1-R2-1)",
        instant,
      );
    }
  }

  /**
   * SIM-2 r1: a watch has concluded, so its orders are no longer read for it.
   * An order this process has already SETTLED (no owner left) was held back
   * from acknowledgment for the watch (`#acknowledgeIfDone`), and is
   * acknowledged now; one still owned is acknowledged at its own settlement.
   */
  #forgetWatch(watch: BasketWatch): void {
    for (const venueOrderId of watch.venueOrderIds) {
      this.#watchedOrders.delete(venueOrderId);
      if (!this.#orderOwners.has(venueOrderId)) this.#acknowledgeIfDone(venueOrderId);
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
   * lookup misses — an order this process never placed (for example one a
   * venue HOLDS for a plan its answer called refused: `#releaseRefusedPlacement`'s
   * defensive path), a SETTLED
   * order, one evicted from the tombstone map, or an owner the registry does
   * not hold — is posted UNATTRIBUTED and halts its market through the ledger
   * projection (`#bookUnownedFill`). It used to be dropped here with a bare
   * `continue`, AFTER the deduplicator had spent its id: no posting, no
   * counter, no halt.
   *
   * SIM-2: the fills come from the venue's NON-destructive cursor
   * (`fillsSince`), read from `#knownFills`, which advances only where it
   * always did — after the whole batch — so a store failure's early return
   * re-reads the same batch next harvest (`IF-06`; the first fill is then
   * refused as a duplicate and the unbooked tail is booked). A cursor the
   * venue refuses — older than its retained window, so fills this process
   * never read are gone — HALTS the process and ends the harvest BEFORE any
   * release: nothing is given back while the fills that would replace it
   * with a position are unknown.
   *
   * `SNAP-1` (user ruling 2026-09-28, "one snapshot per instance per
   * instant"): each booked fill STAGES its instance's §9.16 snapshot
   * (`#stagePnlSnapshot`, computed exactly where and as base wrote it), and
   * the harvest WRITES the staged rows ONCE, at the end of its booking phase
   * (`#flushPnlSnapshots`) — on EVERY path out of it after a fill could have
   * been booked: the normal end and both store-failure early returns (the
   * venue-cursor refusal books nothing). That point is BEFORE the release,
   * the basket judgement and every delivery, so a failed snapshot write still
   * latches its GLOBAL halt before this harvest's `onFill` runs (the MEDIUM-1
   * gate above). This is the ONLY place a snapshot is written, and every event
   * runs at most one harvest (`#processEvent`'s two call sites are exclusive
   * branches); a LATER harvest at an instant already written for an instance
   * — a second event with the same `receivedAt` — REPLACES that row
   * (`SNAP-1` r1; `#flushPnlSnapshots`), so the instant's one row holds the
   * state after its last fill.
   */
  async #harvestFills(instant: string): Promise<void> {
    const page = this.#options.venue.fillsSince(this.#knownFills);
    if (!page.ok) {
      this.#options.halts.halt(
        { kind: "GLOBAL" },
        "VENUE_OBSERVATION_FAILED",
        `the venue could not answer the fills since sequence ${String(this.#knownFills)}: ` +
          `${page.refusal.code}: ${page.refusal.message}. Fills this process never read may be ` +
          "gone, so no reservation is released and the account must be reconciled (SIM-2, §6 invariant 7)",
        instant,
      );
      // `SNAP-1`: nothing is staged here — nothing was booked, and every
      // earlier harvest flushed before it returned.
      return;
    }
    const fills = page.value.fills;
    // `THROUGHPUT-1a`: every earlier decision is durable before this harvest
    // writes a ledger posting or a PnL snapshot — the commit order the per-row
    // path always had.
    if (fills.length > 0 && this.#options.store.groupCommit !== undefined) await this.#commitStaged();
    const booked: { instance: RegisteredInstance; fill: SimulatedFill }[] = [];
    for (const fill of fills) {
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
        if (unowned === "STORE_UNAVAILABLE") {
          // `SNAP-1`: the rows staged by the fills booked before this one are
          // written, as base had already written them.
          await this.#flushPnlSnapshots(instant);
          return;
        }
        continue;
      }

      // `FOLD-1`: the posting's APPENDED transactions are folded onto the held
      // ledger view before anything is adopted. A fold that fails is a failed
      // posting (stage `VIEW_FOLD`) and takes the SAME branch as `postFill`'s
      // own failures: nothing booked, the ledger and its view unmoved.
      const posted = this.#held.fold(
        postFill({
          ledger: this.#held.ledger,
          fill,
          claims: [
            { instanceId: instance.instanceId, runId: instance.runId, shares: fill.shares },
          ],
          identity: this.#options.posting,
          ids: this.#options.ids,
          tokenAssetId:
            this.#options.tokenAssetIds.get(`${fill.marketId}|${fill.side}`) ?? fill.tokenId,
        }),
      );
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
      // The ledger and its view, adopted together. The cadence's checks run
      // below, once this fill's PnL records have joined the stream.
      const checkDue = this.#held.adopt(posted);
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

      // `FOLD-1` (`FOLD1-R1-2`): the cadence's checks — the ledger, and every
      // PnL stream when `pnl` is on — at this due fill, BEFORE the store
      // writes, so the early return a store failure takes cannot skip them.
      if (checkDue) this.#runCadenceChecks(instant);

      for (const appended of posted.appended) {
        const written = await this.#options.store.appendLedgerTransaction(appended);
        if (!written.ok) {
          this.#options.halts.halt(
            { kind: "GLOBAL" },
            "STORE_UNAVAILABLE",
            `the ledger transaction could not be persisted: ${written.failure.detail}`,
            instant,
          );
          // `SNAP-1`: THIS fill staged nothing (its snapshot comes after its
          // postings, as in base); the rows staged by the fills booked before
          // it are written, as base had already written them.
          await this.#flushPnlSnapshots(instant);
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
      // truth — but a store failure IS, on §4.2's terms. `SNAP-1`: computed
      // HERE, per fill, and STAGED; written once, below.
      this.#stagePnlSnapshot(instance, fill, instant);

      booked.push({ instance, fill });
    }
    // `SNAP-1`: the harvest's ONE snapshot write per instance — after every
    // fill of the harvest is booked, before anything below releases, judges
    // or delivers (so a failed write halts before this harvest's `onFill`).
    await this.#flushPnlSnapshots(instant);
    this.#knownFills = page.value.next;

    // --- every order this harvest SETTLED gives its capacity back -----------
    // Between a fill's posting and its order's terminal release BOTH the new
    // position and the still-held reservation describe the same capital, and
    // §9.14 forbids double reservation. Running the release here — after every
    // fill of this harvest is in the ledger, before any evaluation reads the
    // account — closes the window in the fail-closed direction at both ends:
    // nothing is released before the position that replaces it exists.
    this.#releaseSettledReservations();
    // SIM-1 r2 (`SIM1-R2-1`): a cancel or a fill of this iteration can leave a
    // watched basket short; judged before anything below is delivered. Since
    // r3 (`SIM1-R3-1`) every venue door is judged at its own answer, so this
    // is the BACKSTOP: kept because the deliveries below evaluate strategies,
    // and a venue whose state moved some other way must not reach them first.
    this.#judgeBasketWatches(instant);

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
            "process does not own — never placed by it (for example an order a venue holds for a " +
            "plan its answer called refused, without listing it as booked), or settled and since evicted from " +
            "the tombstone map; posted UNATTRIBUTED (TRDR-4)";

    // `FOLD-1`: folded onto the held view before adoption, exactly as an
    // owned fill's posting is (`#harvestFills`).
    const posted = this.#held.fold(
      postFill({
        ledger: this.#held.ledger,
        fill,
        claims: [],
        identity: this.#options.posting,
        ids: this.#options.ids,
        tokenAssetId:
          this.#options.tokenAssetIds.get(`${fill.marketId}|${fill.side}`) ?? fill.tokenId,
      }),
    );
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
    // `FOLD-1` (`FOLD1-R1-2`): an unowned fill is a posted fill like any
    // other, so a due one runs EVERY check the cadence names — the PnL
    // streams too, though this fill adds no PnL record — before the store
    // writes and their early return.
    if (this.#held.adopt(posted)) this.#runCadenceChecks(instant);
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
   *
   * `FOLD-1`: reads the HELD view — and hands `haltOnLedgerProjection` the
   * WHOLE of it, as before, so which halts latch is unchanged (the queued
   * `FOLD-RELATCH` item is about exactly that whole-history read, and is not
   * this round's).
   */
  #readProjection(instant: string, notes?: ReadonlyMap<string, string>): void {
    const projection = this.#held.view;
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

  /**
   * `FOLD-1`: the checks a due posted fill runs — the held ledger view, and
   * every PnL stream when the cadence has `pnl` on. ONE place, called from
   * both posting sites (owned and unowned) before their store writes, so no
   * path that adopts a due fill can leave a check out (`FOLD1-R1-2`).
   */
  #runCadenceChecks(instant: string): void {
    const trigger = this.#cadenceTrigger();
    this.#checkLedgerRebuild(trigger, instant);
    if (this.#held.pnlCheck) this.#checkPnlRebuild(trigger, instant);
  }

  /** `FOLD-1`: how a cadence check names itself in a halt detail. */
  #cadenceTrigger(): string {
    return `after posted fill ${String(this.#held.fillsPosted)} (the check runs every ${String(this.#held.everyFills)})`;
  }

  /**
   * `FOLD-1` (user ruling F2): the held ledger view against
   * `projectLedger(ledger)` on serialized bytes. A mismatch is counted and is
   * a GLOBAL `ACCOUNTING_REBUILD_MISMATCH` halt — fail-closed, never silent —
   * and the held view is replaced by the rebuild (`folds.ts`). Answers
   * whether they matched.
   */
  #checkLedgerRebuild(trigger: string, instant: string): boolean {
    const mismatch = this.#held.checkLedger();
    if (mismatch === undefined) return true;
    this.#options.halts.halt(
      { kind: "GLOBAL" },
      "ACCOUNTING_REBUILD_MISMATCH",
      `the held ledger view differs from projectLedger(ledger) rebuilt from zero, ${trigger}: ` +
        `${mismatch.detail}. §6 invariant 8 requires the rebuild to equal the incremental state, so ` +
        "this process no longer trusts the positions it decides from; " +
        (mismatch.replaced ? "the view was replaced by the rebuild" : "the held view was kept") +
        " (FOLD-1)",
      instant,
    );
    return false;
  }

  /**
   * `FOLD-1`: every instance's PnL stream against `foldPnlRecords` over its
   * WHOLE record list, on serialized bytes — only when the cadence has `pnl`
   * on (the test and golden harnesses; user ruling F2 keeps it out of PAPER).
   * Covers every instance with records, and any held stream, so a stream a
   * failed store write left behind — or one no snapshot has opened yet — is
   * checked too: the check catches it up first (`HeldAccounting.checkPnl`,
   * `FOLD1-R1-1`). A mismatch is counted and is the same GLOBAL halt; the
   * stream is replaced by the rebuild.
   */
  #checkPnlRebuild(trigger: string, instant: string): { readonly matched: boolean; readonly checked: number } {
    let matched = true;
    let checked = 0;
    const instanceIds = new Set<string>(this.#held.pnlStreamIds());
    for (const [instanceId, records] of this.#pnlRecords) {
      if (records.length > 0) instanceIds.add(instanceId);
    }
    for (const instanceId of [...instanceIds].sort()) {
      checked += 1;
      const instance = this.#options.registry.get(instanceId);
      const mismatch = this.#held.checkPnl(
        instanceId,
        instance === undefined ? undefined : () => this.#pnlIdentity(instance),
        this.#pnlRecords.get(instanceId) ?? [],
      );
      if (mismatch === undefined) continue;
      matched = false;
      this.#options.halts.halt(
        { kind: "GLOBAL" },
        "ACCOUNTING_REBUILD_MISMATCH",
        `instance ${instanceId}'s held PnL state differs from foldPnlRecords over its records, rebuilt ` +
          `from zero, ${trigger}: ${mismatch.detail}. ` +
          (mismatch.replaced ? "The stream was replaced by the rebuild" : "The held stream was kept") +
          " (FOLD-1)",
        instant,
      );
    }
    return { matched, checked };
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
   * Owned or not — and that is load-bearing (`TRDR-4` round 1): it is the only
   * release of the entries `#releaseRefusedPlacement` KEPT for an order a
   * refused plan nonetheless left at the venue, which no instance owns and
   * `#deliverOrderViews` therefore never visits.
   *
   * SIM-2: it used to walk EVERY venue order ever placed, on every harvest —
   * O(history) per event, re-releasing every settled order as a no-op. It
   * now walks what this process can hold capital for: the orders it OWNS
   * (settled orders were released at their terminal harvest and are no
   * longer owned) and the ones it knows the venue holds WITHOUT an owner
   * (`#heldUnowned`: the TRDR-4 defensive path, and a placement whose answer
   * was lost), each looked up by id. A held entry is forgotten once its order
   * is seen terminal and released — and the venue is told it may forget the
   * order too (`acknowledgeTerminal`, SIM-2 r1). Releases are idempotent and
   * order-free, and every counter counts effective releases only, so the
   * numbers are the ones the full scan produced.
   *
   * Idempotent: a second call for the same order releases nothing and says so,
   * which is why `#deliverOrderViews` may keep its own call for orders that go
   * terminal without producing a fill (a cancel, an expiry, a rejection).
   */
  #releaseSettledReservations(): void {
    for (const venueOrderId of inVenueOrder(this.#orderOwners.keys())) {
      const order = this.#ownedOrder(venueOrderId, this.#lastInstant);
      if (order === undefined || !this.#isTerminalOrder(order)) continue;
      this.#reservations.releaseForOrder(order.plannedOrderId);
      this.#options.allocator.release(order.plannedOrderId);
      this.#timeInForce.release(order.plannedOrderId);
    }
    for (const plannedOrderId of inVenueOrder(this.#heldUnowned.keys())) {
      const venueOrderId = this.#heldUnowned.get(plannedOrderId);
      const order =
        venueOrderId === undefined
          ? this.#options.venue.orderByPlannedId(plannedOrderId)
          : this.#options.venue.orderById(venueOrderId);
      if (order === undefined) {
        // A HELD order the venue has answered for — listed for a refused
        // plan, or found once for a lost answer — and now cannot is a miss,
        // and loud; the hold is kept. A planned order of a LOST answer the
        // venue has never shown may never have been booked at all, so its
        // absence is not evidence of anything: it is kept, and released if the
        // venue ever shows it.
        if (venueOrderId !== undefined) {
          this.#haltOnVenueMiss(
            `order ${venueOrderId} (planned ${plannedOrderId}), which it holds without an owner`,
            this.#lastInstant,
          );
        }
        continue;
      }
      // SIM-2 r1 (`SIM2-R1-4`): the venue has now SHOWN this order, so it is
      // no longer "possibly never booked": the entry is promoted to its venue
      // id, and from here on its disappearance halts like any held order's.
      if (venueOrderId === undefined) this.#heldUnowned.set(plannedOrderId, order.simulatedOrderId);
      if (!this.#isTerminalOrder(order)) continue;
      this.#reservations.releaseForOrder(order.plannedOrderId);
      this.#options.allocator.release(order.plannedOrderId);
      this.#timeInForce.release(order.plannedOrderId);
      this.#heldUnowned.delete(plannedOrderId);
      this.#acknowledgeIfDone(order.simulatedOrderId);
    }
  }

  /** The trader's ONE terminal predicate, over a venue order (the SDK's terminal set). */
  #isTerminalOrder(order: SimulatedOrder): boolean {
    return isTerminalStatus(
      toStrategyOrderView(order, { marketId: order.marketId, placedAt: this.#lastInstant }).status,
    );
  }

  /** The §9.16 stream identity of one instance's VIRTUAL_STRATEGY PnL — the snapshot's, and a check's. */
  #pnlIdentity(instance: RegisteredInstance): PnlStreamIdentity {
    return {
      scope: "VIRTUAL_STRATEGY",
      environment: this.#options.config.environment,
      accountRef: this.#options.posting.accountRef,
      instanceId: instance.instanceId,
      runId: instance.runId,
      marketId: instance.marketId,
    };
  }

  /**
   * Folds this instance's §9.16 stream and STAGES the resulting snapshot rows
   * for the harvest's one write (`SNAP-1`; this method used to be
   * `#writePnlSnapshot` and wrote them here, once PER FILL).
   *
   * The MARK is the fill's own price — the last observed transaction in this
   * token, which is a fact rather than a model. §9.16's other marks (model,
   * liquidation) need inputs this process does not yet hold, and inventing one
   * would put a fabricated number into an accounting row.
   *
   * `FOLD-1`: the fold is the instance's HELD stream, advanced with only the
   * records it has not folded yet (`HeldAccounting.advancePnl`), where this
   * used to run `foldPnlRecords` over the whole stream on every fill. The rest
   * is as it was — the same early returns in the same order, the same marks —
   * and a refused record stops this instance's snapshots exactly as the
   * from-zero fold did: the held stream RETRIES FROM THE FAILURE POINT, so it
   * refuses on every later fill for as long as the from-zero fold would have
   * (user ruling F3 adds only the count, on `seams.folds.pnlRefusals`). The
   * stream is opened here on first use (unless a check opened it earlier,
   * which it can only do for an identity `packages/pnl` accepts), so an
   * identity `packages/pnl` refuses throws from exactly where it used to. The
   * cadence's checks no longer run here (`FOLD1-R1-2`): they run at the
   * posting site, before the store writes, so a mismatch's replacement is
   * still what the snapshot below reads.
   *
   * `SNAP-1`: ONLY the write moved. The advance, the early returns, the marks
   * and the computation are still per fill, at the same point, so FOLD-1's
   * per-fill checks and F3's counting see exactly what they saw. The rows
   * computed here REPLACE any rows this instance staged earlier in the
   * harvest, so what the harvest writes is the LAST per-fill computation —
   * byte for byte the row base wrote last at this instant. An early return
   * (a refused record, a refused computation) replaces nothing: the rows of
   * the instance's last fill that DID compute stay staged, exactly the last
   * row base had written.
   */
  #stagePnlSnapshot(instance: RegisteredInstance, fill: SimulatedFill, instant: string): void {
    const records = this.#pnlRecords.get(instance.instanceId);
    if (records === undefined || records.length === 0) return;
    this.#held.advancePnl(instance.instanceId, () => this.#pnlIdentity(instance), records);
    const folded = this.#held.completePnlState(instance.instanceId);
    if (folded === undefined) return;
    const tokenAssetId =
      this.#options.tokenAssetIds.get(`${fill.marketId}|${fill.side}`) ?? fill.tokenId;
    const snapshots = computePnlSnapshot(folded, {
      asOf: instant,
      marks: { [tokenAssetId]: { midpoint: fill.price } },
    });
    if (!snapshots.ok) return;
    this.#stagedSnapshots.delete(instance.instanceId);
    this.#stagedSnapshots.set(instance.instanceId, snapshots.value);
  }

  /**
   * `SNAP-1`: the harvest's ONE PnL-snapshot write — each staged instance's
   * rows, in the order of each instance's last fill. Called exactly once per
   * harvest, at the end of its booking phase (`#harvestFills`), so nothing is
   * ever left staged when a harvest returns — at the end of a run included.
   *
   * THE KEY. `accounting.pnl_snapshots_scope_unique` is `unique nulls not
   * distinct (scope, environment, account_ref, instance_id, market_id,
   * as_of)`: one row per instance per instant, and the user's ruling
   * (2026-09-28) is that the row holds the state after the LAST fill booked at
   * that instant. Within one harvest the staging already keeps only the last
   * fill's rows. ACROSS harvests: the loop's instant is the envelope's
   * `receivedAt`, and two EVENTS can carry the same one — the gateway stamps
   * each normalized event of a frame separately at millisecond precision, and
   * nothing here requires instants to increase — so a LATER harvest can stage
   * rows at an instant this instance already has a row at. That row must move
   * to the later state, and it must do so HERE, before this harvest's
   * deliveries (§4.2's MEDIUM-1 gate: a failed snapshot write halts before
   * the `onFill` of the fills it books). So each row's identity
   * (`pnlSnapshotKey`) decides the statement:
   *
   * - an identity this process INSERTED in an earlier flush is REPLACED
   *   (`store.replacePnlSnapshot`): the one row at that instant now holds the
   *   state after this harvest's last fill — the last fill at that instant so
   *   far;
   * - any other identity is INSERTED (`store.writePnlSnapshot`) and
   *   remembered (`#writtenSnapshotKeys`) — whatever its order relative to the
   *   instants written before: an earlier instant (a `receivedAt` that went
   *   backwards) is a distinct identity and gets its own row.
   *
   * A second row of ONE computation with an identity this flush already wrote
   * (one row per denomination, where the denomination is not in the key —
   * unreachable with one pUSD denomination) is a DISTINCT row, not a later
   * state: it is inserted, and the store refuses it, exactly as before — never
   * a silent overwrite of its sibling.
   *
   * HALTS. A halt latched earlier in the harvest (a refused posting, a
   * projection halt, a rebuild mismatch) does not stop the write: the books
   * stay truthful, as base wrote every booked fill's row whatever the halts.
   * A refused insert or replacement is the SAME GLOBAL `STORE_UNAVAILABLE`
   * base latched ("a PnL snapshot could not be persisted: …"), at this
   * harvest's instant, before its deliveries; that instance's remaining rows
   * are not attempted (base's `return`) and its staged rows are dropped, not
   * retried — base never retried a snapshot either. A refused insert leaves
   * its identity unwritten (the next harvest at that instant inserts it); a
   * refused replacement leaves the earlier row, which the next harvest at that
   * instant replaces. Every other staged instance is still attempted, as base
   * attempted every later fill's write.
   */
  async #flushPnlSnapshots(instant: string): Promise<void> {
    if (this.#stagedSnapshots.size === 0) return;
    const staged = [...this.#stagedSnapshots.values()];
    this.#stagedSnapshots.clear();
    const touched = new Set<string>();
    for (const rows of staged) {
      for (const snapshot of rows) {
        const key = pnlSnapshotKey(snapshot);
        const replace = this.#writtenSnapshotKeys.has(key) && !touched.has(key);
        touched.add(key);
        const written = replace
          ? await this.#options.store.replacePnlSnapshot(snapshot)
          : await this.#options.store.writePnlSnapshot(snapshot);
        if (!written.ok) {
          this.#options.halts.halt(
            { kind: "GLOBAL" },
            "STORE_UNAVAILABLE",
            `a PnL snapshot could not be persisted: ${written.failure.detail}`,
            instant,
          );
          break;
        }
        this.#writtenSnapshotKeys.add(key);
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
        source: undefined,
      }),
    );
    await this.#consumeOutcome(instance, market, outcome, null, instant, this.#lastEpochMs);
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
   * Every view is read from ONE boundary taken here, at the harvest boundary —
   * after every fill of this harvest was booked — and every retired order is
   * offered to `#settle` only after every delivery of the harvest has run, so
   * a cancel a delivery registered is visible to condition (d).
   *
   * SIM-2: the boundary is the orders this process OWNS — the only ones the
   * loop below ever delivered from the old `ordersSnapshot()` — read once
   * each, BEFORE any delivery runs (a delivery can submit or cancel, and the
   * boundary must not move under the loop), in venue order (`IF-07`: the
   * order the snapshot scan visited them in, so the evaluation order, the
   * decision sequence and `ctx.orders()` are unchanged). An order submitted
   * by a delivery is not in it, exactly as it was not in the snapshot.
   */
  async #deliverOrderViews(instant: string): Promise<void> {
    const boundary: SimulatedOrder[] = [];
    for (const venueOrderId of inVenueOrder(this.#orderOwners.keys())) {
      const order = this.#ownedOrder(venueOrderId, instant);
      if (order !== undefined) boundary.push(order);
    }
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
          source: undefined,
        }),
      );
      // R1: only a DECIDED outcome is an evaluation of the view. REFUSED (a
      // PAUSED runtime), CONTAINED (the callback failed; its state did not
      // move) and HALTED (persistence failed) all leave the order deliverable.
      if (terminal && outcome.kind === "DECIDED") this.#retired.add(order.simulatedOrderId);
      await this.#consumeOutcome(instance, market, outcome, null, instant, this.#lastEpochMs);
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
   * entry, the booked-shares counter and the retired flag. What remains is a
   * bounded tombstone naming the probable owner, so a fill that still arrives
   * is classified as late rather than unknown — and is booked UNATTRIBUTED
   * either way. SIM-2 r1: the venue is then told this process is done with
   * the order (`#acknowledgeIfDone` — unless a watched basket still reads it),
   * so a venue that bounds its history may now forget it, and not before.
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
    this.#acknowledgeIfDone(venueOrderId);
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
    const group = this.#options.store.groupCommit;
    if (group !== undefined) {
      this.#stageOutbox(group);
      // The hard bound (see GROUP_COMMIT_MAX_EVENTS): never more staged.
      if (group.stagedEvents >= GROUP_COMMIT_MAX_EVENTS) await this.#commitStaged();
      return;
    }
    const drained = this.#options.outbox.drain();
    for (const entry of drained.decisions) {
      const written = await this.#options.store.persistDecision(entry.record, entry.telemetry);
      if (!written.ok) {
        this.#durabilityLost = true;
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
        this.#durabilityLost = true;
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
    // `PROVENANCE-1`: the event's refused intents, after its decisions and
    // checkpoints. Never after a store failure this process has halted on.
    for (const refusal of this.#takeRiskRefusals()) {
      const written = await this.#options.store.persistRiskRefusal(refusal);
      if (!written.ok) {
        this.#durabilityLost = true;
        this.#options.halts.halt(
          { kind: "GLOBAL" },
          "STORE_UNAVAILABLE",
          `a risk refusal could not be persisted (${written.failure.kind}): ` +
            `${written.failure.detail}; ADR-028 Decision 3.1 pins a window by its refusals, so a ` +
            "refusal the store did not record is evidence lost, and the process makes no further " +
            "trading decision",
          this.#lastInstant,
        );
        return;
      }
    }
  }

  /**
   * `PROVENANCE-1` — the pending refused intents, handed over ONCE (the list
   * is emptied), or NONE once a decision or checkpoint could not be made
   * durable (`#durabilityLost`: a refused per-row write, or a refused
   * staging): a refusal made under that `STORE_UNAVAILABLE` halt —
   * `DURABLE-1`'s undurable decision's, refused at the risk seam under the
   * halt — is dropped, never written after the failure the halt reports. The
   * ONE gate both write paths take: the per-row flush (`#flushOutbox`) and
   * the group staging (`#stageOutbox`). After a failed group COMMIT
   * (`#groupCommitFailed`) a staging is never committed (`#requestCommit`),
   * so it needs no gate here.
   */
  #takeRiskRefusals(): readonly RiskRefusalRecord[] {
    const refusals = this.#pendingRiskRefusals;
    this.#pendingRiskRefusals = [];
    return this.#durabilityLost ? [] : refusals;
  }

  /**
   * `DURABLE-1` — the durability boundary before a NEW placement (handoff
   * §8.1: "persist DecisionResults → allocate capital → run risk checks →
   * create execution plans → … submit"; §6 invariants 3 and 4; ADR-005 §2).
   *
   * Every decision the outbox holds — INCLUDING the one whose intent is being
   * routed, which the runtime appended during this very callback — is made
   * durable before the caller allocates, reserves or submits anything:
   *
   * - with group commit, the pending decisions are STAGED (as one staging,
   *   exactly the rows `#stageOutbox` would have staged for them) and the
   *   loop waits until EVERYTHING staged is committed (`#commitStaged`), so
   *   the durable rows stay a prefix of the run's;
   * - without it, each pending decision is written by `persistDecision`, in
   *   evaluation order, exactly as `#flushOutbox` would have written it.
   *
   * Checkpoints are NOT drained here ({@link DecisionOutboxBuffer.drainDecisions}):
   * the flush that follows the callback writes them, with the instant it
   * always gave them. So the fix changes WHEN a decision row is written, never
   * WHAT is written.
   *
   * Answers `false` — with a GLOBAL `STORE_UNAVAILABLE` halt latched, the same
   * halt a failed flush latches — when the decisions are not durable. The
   * caller then refuses the placement (at the risk seam, under that halt,
   * counted; and regardless of its verdict) and makes no venue and no ledger
   * effect. On a per-row write or a
   * staging failure the rest of the outbox is dropped, as a failed flush
   * drops what it drained: nothing is written after the failure the halt
   * reports (a failed group COMMIT already guarantees that,
   * `#groupCommitFailed`).
   *
   * Free when the outbox holds no decision and nothing is staged: a decision
   * with several placement intents pays for this once. Once it has answered
   * `false` for a decision, it answers `false` for that decision's every later
   * placement without asking the store again (`#routingUndurableDecision`),
   * so the refusal never depends on the risk seam reading the halt.
   *
   * GROUP COMMIT SPLITS A DECISION FROM ITS EVENT'S CHECKPOINT (r1, LOW-3).
   * The decisions are staged here WITHOUT the checkpoints the outbox still
   * holds, so the decision rows commit in the transaction this boundary
   * awaits and the event's checkpoints in a LATER one (the flush stages them;
   * a crash between the two leaves a durable decision whose checkpoint is not).
   * Base staged an event's decisions and checkpoints as one staging. Keeping
   * them together would mean draining the checkpoints here, with an instant
   * that inside a venue frame is not the one they always had. Per-row stores
   * never wrote the two atomically. No production path restores from a
   * checkpoint (`restoreFrom` has no caller outside tests).
   */
  async #persistDecisionsBeforePlacement(): Promise<boolean> {
    if (this.#routingUndurableDecision) return false;
    const durable = await this.#persistPendingDecisions();
    if (!durable) this.#routingUndurableDecision = true;
    return durable;
  }

  async #persistPendingDecisions(): Promise<boolean> {
    const group = this.#options.store.groupCommit;
    const decisions = this.#options.outbox.drainDecisions();
    if (group !== undefined) {
      if (decisions.length > 0) {
        const staged = group.stage({ decisions, checkpoints: [], riskRefusals: [] });
        if (!staged.ok) {
          this.#durabilityLost = true;
          this.#options.outbox.drain();
          this.#options.halts.halt(
            { kind: "GLOBAL" },
            "STORE_UNAVAILABLE",
            `the decision that emitted a placement could not be staged for the durable store ` +
              `(${staged.failure.kind}): ${staged.failure.detail}; §6 invariant 3 requires the ` +
              "decision to be PERSISTED before its placement, so nothing is placed and the process " +
              "makes no further trading decision",
            this.#lastInstant,
          );
          return false;
        }
      }
      await this.#commitStaged();
      return !this.#groupCommitFailed;
    }
    for (const entry of decisions) {
      const written = await this.#options.store.persistDecision(entry.record, entry.telemetry);
      if (!written.ok) {
        this.#durabilityLost = true;
        this.#options.outbox.drain();
        this.#options.halts.halt(
          { kind: "GLOBAL" },
          "STORE_UNAVAILABLE",
          `a decision record could not be persisted (${written.failure.kind}): ` +
            `${written.failure.detail}; §6 invariant 3 requires the decision to be PERSISTED before ` +
            "its placement, so nothing is placed and the process makes no further trading decision",
          this.#lastInstant,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * `THROUGHPUT-1a` — the group-commit form of {@link #flushOutbox}: the
   * event's decisions and checkpoints are STAGED (no I/O), and a commit is
   * REQUESTED once a bound is reached (see {@link GROUP_COMMIT_MAX_EVENTS}).
   * A row the store cannot even stage (an unencodable document) halts HERE,
   * at this event.
   */
  #stageOutbox(group: GroupCommit): void {
    const drained = this.#options.outbox.drain();
    // `PROVENANCE-1`: the event's refused intents go in the SAME staging as
    // its remaining rows, so they commit in that batch's transaction, before
    // any later event's decision (the commit chain is in stage order).
    const riskRefusals = this.#takeRiskRefusals();
    if (drained.decisions.length === 0 && drained.checkpoints.length === 0 && riskRefusals.length === 0) return;
    const staged = group.stage({
      decisions: drained.decisions,
      checkpoints: drained.checkpoints.map((checkpoint) => ({ checkpoint, capturedAt: this.#lastInstant })),
      riskRefusals,
    });
    if (!staged.ok) {
      this.#durabilityLost = true;
      this.#options.halts.halt(
        { kind: "GLOBAL" },
        "STORE_UNAVAILABLE",
        `a decision record or strategy checkpoint could not be staged for the durable store ` +
          `(${staged.failure.kind}): ${staged.failure.detail}; §6 invariant 3 requires exactly one ` +
          "PERSISTED decision per callback, so the process makes no further trading decision",
        this.#lastInstant,
      );
      return;
    }
    const now = this.#options.clock.monotonicNs();
    if (this.#stagedSinceNs === undefined) this.#stagedSinceNs = now;
    if (
      group.stagedEvents >= GROUP_COMMIT_EARLY_START_EVENTS ||
      now - this.#stagedSinceNs >= BigInt(GROUP_COMMIT_MAX_AGE_MS) * 1_000_000n
    ) {
      this.#requestCommit(group);
    }
  }

  /**
   * `THROUGHPUT-1a` — requests a commit of everything staged, WITHOUT waiting
   * for it. Commits form ONE chain: each runs only after the previous one
   * settled, and takes every row staged by the time it starts — so batches
   * become durable one at a time, in stage order, and the durable rows are
   * always a prefix. At most one request is outstanding (not yet started): a
   * second request before the first starts adds nothing, since the first
   * will take the rows the second would have.
   */
  #requestCommit(group: GroupCommit): void {
    if (this.#commitRequested || this.#groupCommitFailed) return;
    this.#commitRequested = true;
    this.#commitChain = this.#commitChain.then(async () => {
      this.#commitRequested = false;
      await this.#runCommit(group);
    });
  }

  /**
   * `THROUGHPUT-1a` — every decision staged so far is durable once this
   * resolves `true`; `false` means a commit failed (and its GLOBAL
   * `STORE_UNAVAILABLE` halt is latched). A loop whose store does not
   * group-commit wrote every row at its event, and answers at once.
   *
   * `DURABLE-1` r1 (LOW-5): it also answers `false` once any decision or
   * checkpoint could not be staged, or (per-row) written — the rows the halt
   * reports never became durable, so "every decision is durable" is false.
   * Base answered `true` after a staging failure. The pump refuses to record
   * a position under any halt in either case (`settle`: `!durable ||
   * halts.anyHalt`), so its behaviour does not change; the mark is now true
   * to its word.
   *
   * The pump records the stream position of a batch only after this mark,
   * taken at the batch's end, resolved `true` (`apps/trader/src/pump.ts`).
   */
  durabilityMark(): Promise<boolean> {
    const group = this.#options.store.groupCommit;
    if (group === undefined) return Promise.resolve(!this.#groupCommitFailed && !this.#durabilityLost);
    if (group.stagedEvents > 0) this.#requestCommit(group);
    return this.#commitChain.then(() => !this.#groupCommitFailed && !this.#durabilityLost);
  }

  /** `THROUGHPUT-1a`: does this loop's store group-commit (see {@link durabilityMark})? */
  get groupCommits(): boolean {
    return this.#options.store.groupCommit !== undefined;
  }

  /**
   * `THROUGHPUT-1a` — makes EVERY staged decision durable and returns once it
   * is (or a halt is latched). Used before any other durable write and before
   * an intent is routed, and at the end of a durable drain. Free when the
   * store does not group-commit.
   */
  async #commitStaged(): Promise<void> {
    if (this.#options.store.groupCommit === undefined) return;
    await this.durabilityMark();
  }

  /**
   * One commit of everything staged NOW (the store takes the staged rows when
   * `commit` is called; later stages form the next batch). A failure is
   * §4.2's PostgreSQL boundary, exactly as a failed per-row write is: a GLOBAL
   * `STORE_UNAVAILABLE` halt and no retry — and no later commit either, so no
   * decision becomes durable after the failure the halt reports.
   */
  async #runCommit(group: GroupCommit): Promise<void> {
    if (this.#groupCommitFailed || group.stagedEvents === 0) return;
    this.#stagedSinceNs = undefined;
    let committed: Awaited<ReturnType<GroupCommit["commit"]>>;
    try {
      committed = await group.commit();
    } catch (cause) {
      // A store answers failures as data; one that throws is contained here
      // all the same, because this chain may be awaited only later and a
      // rejection nobody is waiting on yet must not escape the process.
      committed = {
        ok: false,
        failure: {
          kind: "UNAVAILABLE",
          detail: `the group commit threw: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      };
    }
    if (!committed.ok) {
      this.#groupCommitFailed = true;
      this.#options.halts.halt(
        { kind: "GLOBAL" },
        "STORE_UNAVAILABLE",
        `a group commit of decision records and strategy checkpoints could not be persisted ` +
          `(${committed.failure.kind}): ${committed.failure.detail}; §6 invariant 3 requires exactly ` +
          "one PERSISTED decision per callback, so the process makes no further trading decision",
        this.#lastInstant,
      );
    }
  }

  #positionsFor(
    instance: RegisteredInstance,
    marketConfig: MarketConfig,
    projection: LedgerProjection,
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
    // SIM-2: the instance's OWN orders, in venue order (`IF-07`: risk's
    // `openOrders` keep the order the snapshot scan gave them), one lookup each.
    for (const venueOrderId of inVenueOrder(owned)) {
      const order = this.#ownedOrder(venueOrderId, this.#lastInstant);
      if (order === undefined) continue;
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
    // `THROUGHPUT-1c` (ADR-023 D5): §9.8 check 7's `VENUE_BOOK` age is measured
    // from the instant the book is vouched for — under `LAST_CHANGE` exactly
    // the pre-ADR-023 value. Which book is measured (YES) is unchanged.
    const at =
      this.#bookConfirmedAt(market, "YES", epochMs)?.epochMs ??
      market.bookFor("YES").lastUpdate()?.receivedAtEpochMs;
    return at === undefined ? 0 : Math.max(0, epochMs - at);
  }

  /**
   * `THROUGHPUT-1c` (ADR-023): the instant one outcome's book is vouched for,
   * or `undefined` when its last update carries no receipt instant (callers
   * keep their pre-ADR-023 fallbacks).
   */
  #bookConfirmedAt(market: MarketState, outcome: "YES" | "NO", nowEpochMs: number): ConfirmedInstant | undefined {
    const lastUpdate = market.bookFor(outcome).lastUpdate();
    const lastChange =
      lastUpdate?.receivedAt !== undefined && lastUpdate.receivedAtEpochMs !== undefined
        ? { iso: lastUpdate.receivedAt, epochMs: lastUpdate.receivedAtEpochMs }
        : undefined;
    return bookConfirmedAt({
      basis: this.#freshnessBasis,
      lastChange,
      sessionKey: market.bookSession(outcome),
      marketHasActiveIncident: market.hasActiveIncident(),
      liveness: this.#liveness,
      nowEpochMs,
      processNowEpochMs: this.#processNowEpochMs(),
      maximumLastChangeAgeMs: this.#freshnessCeilingMs,
    });
  }

  /**
   * `THROUGHPUT-1c` r2 (X9, ADR-023 D7): the process clock, read ONLY under
   * `CONNECTION_CONFIRMED` and only to bound the extension (the process-lag
   * guard, `book-freshness.ts`). `LAST_CHANGE` reads no clock here. A reading
   * that does not normalise is `undefined`, which turns the extension off.
   */
  #processNowEpochMs(): number | undefined {
    if (this.#freshnessBasis !== "CONNECTION_CONFIRMED") return undefined;
    const reading = normalizeToStrictUtc(this.#options.clock.now());
    return reading.ok ? reading.epochMs : undefined;
  }

  /**
   * `THROUGHPUT-1c` (ADR-023 D2): offers one consumed event to the
   * delivery-session table, and applies rule 4 — a data-quality incident that
   * names NO market taints its gateway epoch, every session of it, for good.
   * Nothing is recorded under `LAST_CHANGE`, which reads none of it.
   *
   * r8 (R8-H1): the event goes through the frame gate, never straight to the
   * table. Its own confirmation is HELD until a later event of its epoch from
   * another frame is processed here; that later event first releases the
   * frames before it. So the evaluations of this event's own frame are
   * vouched for by earlier, proven frames only (`book-freshness.ts`).
   */
  #observeDeliverySession(envelope: EventEnvelopeOf, iso: string, epochMs: number): void {
    if (this.#freshnessBasis !== "CONNECTION_CONFIRMED") return;
    this.#frameGate.offer(envelope, { iso, epochMs });
    if (
      envelope.eventType === "DataQualityIncidentOpened" &&
      affectedMarketIds(envelope.payload).length === 0
    ) {
      this.#liveness.taintGatewayEpoch(envelope.gatewayEpoch);
    }
  }

  /**
   * `THROUGHPUT-1c` (ADR-023): records the delivery session of an update the
   * book just ACCEPTED, against the outcome its token names. Nothing is
   * recorded under `LAST_CHANGE`, which never reads it (ADR-023 D4; review
   * round 6, O-R6-I1).
   */
  #noteBookSession(
    market: MarketState,
    envelope: {
      readonly payload: unknown;
      readonly gatewayEpoch: string;
      readonly eventType: string;
      readonly connectionId?: string;
      readonly subscriptionGeneration?: number;
    },
  ): void {
    if (this.#freshnessBasis !== "CONNECTION_CONFIRMED") return;
    const outcome = market.outcomeOfToken(readString(envelope.payload, "tokenId"));
    if (outcome === undefined) return;
    market.noteBookSession(outcome, sessionKeyOf(envelope));
  }

  /**
   * `CO2-N1` (ADR-031, option (a), through existing inputs): one PLACEMENT's
   * admission measurements, from ONE reading of the process clock.
   *
   * WHY. Every other admission input is measured at the evaluation's EVENT
   * instant (`receivedAt`). A trader N seconds behind the stream would judge
   * an entry as of N seconds ago, and would admit one after the close (the
   * `CO2-N1` residual; `CLOSEOUT-2` N1). Option (a) supplies two existing §9.8
   * inputs from the process clock, and nothing else:
   *
   * - R2/R3: `featuresAgeMs` is the lag, `max(0, processNow − eventNow)` in
   *   whole milliseconds: the feature snapshot's age at admission. Check 7's
   *   features row judges ENTRIES only, so an `EXIT`'s verdict is unchanged
   *   (ADR-031 Q2, as ruled).
   * - R4: `secondsToClose` is measured from `max(eventNow, processNow)`.
   *   Check 20 judges ENTRIES only.
   * - R5: a reading that does not normalise to strict UTC is no measurement.
   *   The features age is `undefined` (OMITTED, so check 7 refuses an entry
   *   `RISK_FRESHNESS_UNKNOWN`), and seconds-to-close keeps the event instant.
   *
   * Both inputs can only ADD refusals: the lag is never negative, and the
   * close instant is never earlier than the event instant. So a process clock
   * BEHIND the event instant (lag 0) changes nothing, and in a replay that
   * positions its clock at each event (the backtest's `ReplayClock`) nothing
   * changes at all (R6). No configuration turns this off (R7).
   *
   * Book and reference ages, `evaluatedAt`, the request budget and every
   * strategy input stay on event time (R6). Under ADR-023's
   * `CONNECTION_CONFIRMED`, D7's own reading (`#processNowEpochMs`) is
   * separate and unchanged: this one never touches a book age.
   */
  #admissionMeasurements(eventEpochMs: number): {
    readonly featuresAgeMs: number | undefined;
    readonly closeFromEpochMs: number;
  } {
    const reading = normalizeToStrictUtc(this.#options.clock.now());
    if (!reading.ok) return { featuresAgeMs: undefined, closeFromEpochMs: eventEpochMs };
    return {
      featuresAgeMs: Math.max(0, reading.epochMs - eventEpochMs),
      closeFromEpochMs: Math.max(eventEpochMs, reading.epochMs),
    };
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

/** The door-read envelope `#processEvent` works on. */
type EventEnvelopeOf = Extract<ReturnType<typeof readEventEnvelope>, { readonly ok: true }>["envelope"];

/** `THROUGHPUT-2` (ADR-024): a venue frame between its first and its closing event. */
interface OpenFrame {
  /**
   * Markets owed ONE `onFeatures` evaluation at the close, in the order of the
   * events that last owed them (see {@link oweEvaluation}).
   */
  readonly owed: Map<string, OwedEvaluation>;
  /**
   * The instant of the frame's last event that reached the point where a lone
   * event harvests fills and flushes; `undefined` when none did.
   */
  harvestAt: string | undefined;
  /**
   * `CADENCE-1` (ADR-026 D3.2): the frame's last APPLIED event — the source of
   * the close's carried-over and heartbeat evaluations. Set by every applied
   * event, so defined from the frame's first.
   */
  lastApplied: AppliedEventPosition | undefined;
}

/** `CADENCE-1`: an applied event's dispatch position and instant (ADR-026 D3.2). */
type AppliedEventPosition = OwedEvaluation["at"];

/** One market's owed evaluation: the market, and the last frame event that owed it. */
interface OwedEvaluation {
  readonly market: MarketState;
  /**
   * `PROVENANCE-1`: `source` is that event's dispatch position (it was its
   * `eventId` alone), so the frame-close evaluation's decision carries the
   * same `(gatewayEpoch, ingestSeq)` the per-event cadence's would have.
   */
  readonly at: { readonly source: DispatchPosition; readonly instant: string; readonly epochMs: number };
}

/**
 * `THROUGHPUT-2` r1 (`TP2-R1-M1`): records that `at` owes `marketId` an
 * evaluation. A market owed again moves to the END of the order, keyed to
 * the later event: the close then evaluates each market at the last event
 * that owed it, in the order of those events — the order the per-event
 * cadence ran those same evaluations in.
 */
function oweEvaluation(
  frame: OpenFrame,
  marketId: string,
  market: MarketState,
  at: OwedEvaluation["at"],
): void {
  frame.owed.delete(marketId);
  frame.owed.set(marketId, { market, at });
}

const ZERO_UUID = "00000000-0000-7000-8000-000000000000";

/**
 * `PROVENANCE-1`: an envelope's dispatch position — a fresh frozen record of
 * its own §7.1 `eventId`, `gatewayEpoch` and `ingestSeq`, which the event
 * door has already held to the frozen contract. Copied, never derived, and
 * never the envelope itself (a decision or refusal record must not carry the
 * payload).
 */
function dispatchPositionOf(envelope: {
  readonly eventId: string;
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
}): DispatchPosition {
  return Object.freeze({
    eventId: envelope.eventId,
    gatewayEpoch: envelope.gatewayEpoch,
    ingestSeq: envelope.ingestSeq,
  });
}

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

/**
 * `DURABLE-1` r1 (finding A01): the order a DECIDED outcome's intents are
 * ROUTED in — every `CANCEL` first, then every placement, each group in the
 * order the strategy emitted it (a stable partition).
 *
 * A placement waits at the durability boundary for its decision's record
 * (`#persistDecisionsBeforePlacement`); a `CANCEL` does not. Routed in the
 * emitted order, a `CANCEL` listed AFTER a placement would queue behind that
 * wait — behind a store that is slow or hangs — although base routed it at
 * once. Routing the decision's cancels first means no cancel the strategy has
 * already emitted ever waits on its own decision's record.
 *
 * A list that is only cancels, only placements, or cancels-then-placements
 * (every list the shipped Static Bracket builds) routes exactly as before; the
 * array is returned as is. Only a list with a placement BEFORE a cancel is
 * reordered, and for it cancel-then-place is also the safer order: a cancel
 * that leaves a basket short halts at its answer, before the placement is
 * risk-checked (`SIM1-R3-1`), and a scoped cancel (by market, or everything)
 * no longer reaches the order the same decision has just placed.
 */
function cancelsFirst(intents: readonly Intent[]): readonly Intent[] {
  const firstPlacement = intents.findIndex((intent) => intent.type !== "CANCEL");
  if (firstPlacement === -1) return intents;
  if (!intents.slice(firstPlacement).some((intent) => intent.type === "CANCEL")) return intents;
  return [
    ...intents.filter((intent) => intent.type === "CANCEL"),
    ...intents.filter((intent) => intent.type !== "CANCEL"),
  ];
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
