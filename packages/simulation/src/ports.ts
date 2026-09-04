/**
 * The handoff §12.1 swappable-infrastructure interfaces, and the STRUCTURAL
 * mirrors of the shapes this package consumes from same-layer packages.
 *
 * §12.1 fixes three interfaces and one rule:
 *
 * ```ts
 * interface Clock { now(): string; monotonicNs(): bigint; }
 * interface MarketEventSource { events(): AsyncIterable<EventEnvelope<unknown>>; }
 * interface ExecutionVenue {
 *   submit(plan: ExecutionPlan): Promise<ExecutionResult>;
 *   cancel(command: CancelCommand): Promise<CancelResult>;
 *   queryAccountState(): Promise<AccountSnapshot>;
 * }
 * ```
 *
 * "Everything between event input and the `ExecutionVenue` interface is shared"
 * — so this file is the seam between the live and simulated paths, and the
 * simulated venue implements exactly this interface with nothing added to it.
 * **No method here can carry a credential, a signer, a venue URL, or a network
 * handle**, and none of the implementations in this package has one.
 *
 * ## Why the plan/book/ledger shapes are mirrored rather than imported
 *
 * `packages/simulation` is layer 1 (`docs/contracts/dependency-direction.md`
 * §2). `packages/execution-planner`, `packages/order-book` and `packages/ledger`
 * are also layer 1, and §2.1's table of permitted same-layer edges does not list
 * an edge to any of them — an unlisted same-layer edge is F13. `packages/storage-*`
 * are layer 2, and a layer-1 → layer-2 edge is F12 (upward), always forbidden.
 *
 * So the shapes below are declared here STRUCTURALLY and pinned to the real
 * packages by root-level tests (`test/unit/simulation/ports.test.ts`), which is
 * the WP-190 `ports.test.ts` precedent: a root test importing the real package
 * creates no workspace edge, and a field added or removed upstream fails the
 * pin. The composition root (`apps/backtest-cli`, later `apps/trader`) is the
 * only place where the real values meet these interfaces.
 */

import type { Clock } from "./clock.js";

export type { Clock } from "./clock.js";

// ---------------------------------------------------------------------------
// Event envelope (§7.1), structurally
// ---------------------------------------------------------------------------

/**
 * The §7.1 envelope, structurally.
 *
 * Mirrors `packages/domain`'s hand-written `EventEnvelope<TPayload>` exactly;
 * `test/unit/simulation/ports.test.ts` pins it against the frozen declaration
 * in both directions.
 */
export type EventEnvelope<TPayload> = {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  source: "polymarket" | "binance" | "coinbase" | "rtds" | "internal";
  sourceChannel: string;

  venueTimestamp?: string;
  receivedAt: string;
  receivedMonotonicNs: string;

  gatewayEpoch: string;
  ingestSeq: string;
  connectionId?: string;
  subscriptionGeneration?: number;

  rawSegmentId?: string;
  rawRecordOffset?: string;
  correlationId?: string;
  causationId?: string;

  payload: TPayload;
};

/** §12.1 `MarketEventSource`. */
export interface MarketEventSource {
  events(): AsyncIterable<EventEnvelope<unknown>>;
}

// ---------------------------------------------------------------------------
// Execution plan (§9.10 / WP-190), structurally
// ---------------------------------------------------------------------------

/** §11 run modes. Mirrors `packages/domain`'s `RunMode`. */
export type RunMode =
  | "BACKTEST"
  | "PAPER"
  | "SHADOW"
  | "EXECUTION_PROBE"
  | "LIVE_MICRO"
  | "LIVE";

/**
 * The run modes a SIMULATED venue may serve (§11: "Execution — Simulated").
 *
 * `EXECUTION_PROBE`, `LIVE_MICRO` and `LIVE` require a live signer and real
 * orders; a simulated venue that accepted one would be pretending to be a venue.
 */
export const SIMULATED_RUN_MODES = ["BACKTEST", "PAPER", "SHADOW"] as const;
export type SimulatedRunMode = (typeof SIMULATED_RUN_MODES)[number];

/** WP-190 `PlanPriority`. §6 invariant 13: safety cancellation outranks placement. */
export type PlanPriority = "SAFETY_CANCEL" | "PLACEMENT";

/** WP-190 `PLAN_PRIORITY_RANK`, mirrored. Lower rank schedules first. */
export const PLAN_PRIORITY_RANK: Readonly<Record<PlanPriority, number>> = Object.freeze({
  SAFETY_CANCEL: 0,
  PLACEMENT: 1,
});

/** WP-190 `PlannedOrder`. */
export interface PlannedOrderView {
  readonly plannedOrderId: string;
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly shares: string;
  readonly postOnly: boolean;
  readonly executionStyle: "REST" | "MARKETABLE_LIMIT";
  readonly reservationId: string;
}

/** WP-190 `ExecutionGroup`. */
export interface ExecutionGroupView {
  readonly executionGroupId: string;
  readonly marketId: string;
  readonly tickSize: string;
  readonly minimumOrderSize: string;
  readonly orders: readonly PlannedOrderView[];
}

/** WP-190 `PartialFillHandling`. §6 invariant 10: partial fills are first-class. */
export interface PartialFillHandlingView {
  readonly policy: "REJECT" | "ACCEPT_ANY" | "ACCEPT_MINIMUM";
  readonly minimumFillShares?: string;
}

/**
 * The part of a WP-190 plan a SIMULATED VENUE reads.
 *
 * Deliberately narrower than the full `ExecutionPlan`: a venue submits orders
 * and cancels; it does not re-derive leg selection, estimates, reservations, or
 * risk provenance. `ports.test.ts` pins these fields against the real
 * `PlacementPlan` / `BasketPlan` / `CancelPlan` so a rename upstream fails.
 */
export interface PlacementPlanView {
  readonly executionPlanId: string;
  readonly strategyInstanceId: string;
  readonly runMode: RunMode;
  readonly plannedAt: string;
  readonly deadline: string;
  readonly planKind: "POSITION" | "REDUCE_POSITION" | "BASKET";
  readonly priority: "PLACEMENT";
  readonly priceProtection: { readonly mode: "CAPPED_LIMIT_ORDERS_ONLY" };
  readonly escalation: { readonly atDeadline: "CANCEL_REMAINING" };
  readonly partialFill: PartialFillHandlingView;
  readonly groups: readonly ExecutionGroupView[];
}

/** The part of a WP-190 `CancelPlan` a simulated venue reads. */
export interface CancelPlanView {
  readonly executionPlanId: string;
  readonly strategyInstanceId: string;
  readonly runMode: RunMode;
  readonly plannedAt: string;
  readonly deadline: string;
  readonly planKind: "CANCEL";
  readonly priority: "SAFETY_CANCEL";
  readonly priceProtection: { readonly mode: "NO_NEW_ORDERS" };
  readonly escalation: { readonly atDeadline: "ESCALATE_TO_RECONCILIATION" };
  readonly scope: { readonly marketId?: string; readonly orderIds?: readonly string[] };
  readonly reason: string;
}

/** WP-190 `ExecutionPlan`, as a simulated venue sees it. */
export type ExecutionPlanView = PlacementPlanView | CancelPlanView;

/** §6 invariant 13 scheduling comparison. Negative means `left` schedules first. */
export function comparePlanPriority(left: PlanPriority, right: PlanPriority): -1 | 0 | 1 {
  const a = PLAN_PRIORITY_RANK[left];
  const b = PLAN_PRIORITY_RANK[right];
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Book (§9.4 / WP-150), structurally
// ---------------------------------------------------------------------------

/** WP-150 `BookLevelView`. */
export interface BookLevelView {
  readonly price: string;
  readonly size: string;
}

/** WP-150 `TopOfBook`. Absent fields mean that side is empty. */
export interface TopOfBookView {
  readonly bestBidPrice?: string;
  readonly bestBidSize?: string;
  readonly bestAskPrice?: string;
  readonly bestAskSize?: string;
  readonly spread?: string;
}

/**
 * The book surface a fill model reads.
 *
 * `ladder(side)` returns the aggregated levels best-first — WP-150's
 * `OutcomeTokenBook.bids()` / `.asks()` shape. A simulated venue consumes DEPTH
 * (§12.2 Tier 0 "observed top/depth"), which is precisely the input the PLANNER
 * did not have: WP-190 `follow_up` 1 records that planning inputs carry only
 * top-of-book. See {@link PLANNING_DEPTH_AWARENESS}.
 */
export interface BookView {
  readonly internalMarketId: string;
  readonly tokenId: string;
  top(): TopOfBookView;
  ladder(side: "BID" | "ASK"): readonly BookLevelView[];
}

/**
 * What the plan's prices were computed from, recorded on every venue result.
 *
 * WP-190 `follow_up` 1 (deferred, disclosed at `src/slice.ts:27`): "planning
 * inputs carry only top-of-book, so participation-limit slicing cannot see book
 * depth." A simulated venue that consumed depth and then reported the outcome
 * without this label would let a reader believe the plan participated in depth
 * it never saw. The label travels with every result so it cannot be lost.
 */
export const PLANNING_DEPTH_AWARENESS = "TOP_OF_BOOK_ONLY" as const;
export type PlanningDepthAwareness = typeof PLANNING_DEPTH_AWARENESS;

// ---------------------------------------------------------------------------
// Ledger (§9.15 / WP-200), structurally
// ---------------------------------------------------------------------------

/**
 * WP-200 `FillFact` — the fill a ledger fold consumes (`packages/ledger`
 * `allocation.ts` at `7e75f9a`), mirrored STRUCTURALLY.
 *
 * A simulated fill is convertible to exactly this shape and to nothing wider,
 * which is what makes the ledger a real consumer of simulated output without a
 * package edge (`packages/ledger` is the same layer and no §2.1 row permits an
 * edge). `test/unit/simulation/ports.test.ts` pins it by folding a converted
 * simulated fill through the REAL `allocateFill`, so a field added or removed
 * upstream fails that suite.
 *
 * The fields a simulated fill does NOT have — the ledger's own identity, the
 * account, and the two asset ids (ADR-006 §7 rule 1: "there is no implicit
 * 'cash' asset") — are caller-supplied to {@link ../fill-model.js#toFillFact}
 * rather than invented by the simulator.
 */
export interface FillFactView {
  readonly fillId: string;
  readonly marketId: string;
  readonly environment: RunMode;
  readonly accountRef: string;
  readonly tokenAssetId: string;
  readonly denominationAssetId: string;
  readonly side: "BUY" | "SELL";
  readonly shares: string;
  readonly price: string;
  readonly feeAmount?: string;
  readonly feeScheduleVersionRef?: string;
  readonly source: EventEnvelope<unknown>["source"];
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Execution venue (§12.1)
// ---------------------------------------------------------------------------

/** A simulated order's lifecycle state. */
export type SimulatedOrderState =
  | "ACCEPTED"
  | "DELAYED"
  | "RESTING"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "REJECTED";

/** One simulated order, as the venue knows it. */
export interface SimulatedOrder {
  readonly simulatedOrderId: string;
  readonly plannedOrderId: string;
  readonly executionPlanId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly requestedShares: string;
  readonly filledShares: string;
  readonly state: SimulatedOrderState;
  readonly postOnly: boolean;
  readonly executionStyle: "REST" | "MARKETABLE_LIMIT";
  /** The recorded event identity this state was reached at. Never a wall clock. */
  readonly atEvent: RecordedEventIdentity;
}

/** The recorded identity of the event a simulated outcome is anchored to. */
export interface RecordedEventIdentity {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly receivedAt: string;
  readonly datasetRowOrdinal: number;
}

/** §12.1 `ExecutionResult`. */
export interface ExecutionResult {
  readonly executionPlanId: string;
  readonly accepted: boolean;
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFillLike[];
  /** Present when the venue refused; `accepted` is then `false`. */
  readonly refusalCode?: string;
  readonly refusalMessage?: string;
  /** Always `"SIMULATED"`. There is no other value (ADR-012 §2 item 3). */
  readonly venueClass: "SIMULATED";
  readonly planningDepthAwareness: PlanningDepthAwareness;
}

/** §12.1 `CancelCommand`. */
export interface CancelCommand {
  readonly executionPlanId: string;
  readonly reason: string;
  readonly scope: { readonly marketId?: string; readonly orderIds?: readonly string[] };
  /** §6 invariant 13. A cancel is always `SAFETY_CANCEL` at this venue. */
  readonly priority: "SAFETY_CANCEL";
}

/** §12.1 `CancelResult`. */
export interface CancelResult {
  readonly executionPlanId: string;
  readonly cancelled: readonly string[];
  readonly notCancelled: readonly { readonly simulatedOrderId: string; readonly reason: string }[];
  readonly venueClass: "SIMULATED";
}

/** §12.1 `AccountSnapshot`. Simulated balances; never a wallet read. */
export interface AccountSnapshot {
  readonly venueClass: "SIMULATED";
  readonly cashBalance: string;
  readonly positions: readonly {
    readonly marketId: string;
    readonly tokenId: string;
    readonly side: "YES" | "NO";
    readonly shares: string;
  }[];
  readonly openOrders: readonly SimulatedOrder[];
  /**
   * The recorded event the snapshot is taken at, or `null` before the venue has
   * been positioned at one. A fabricated identity would name an event that never
   * happened (§6 invariant 15).
   */
  readonly atEvent: RecordedEventIdentity | null;
}

/**
 * §12.1 `ExecutionVenue` — the seam between the shared core and the venue.
 *
 * The simulated implementation of this interface holds no credential, opens no
 * socket, signs nothing, and places no order. A live implementation arrives in
 * a later work package behind the SAME three methods.
 */
export interface ExecutionVenue {
  submit(plan: ExecutionPlanView): Promise<ExecutionResult>;
  cancel(command: CancelCommand): Promise<CancelResult>;
  queryAccountState(): Promise<AccountSnapshot>;
}

/**
 * The evidence class every simulated fill carries.
 *
 * ADR-012 §2 item 1: "A paper or backtest fill is never evidence about real fill
 * quality"; item 3: "No component may label a simulated fill as real." The
 * literal type below is the enforcement: a simulated fill is not assignable to
 * anything that expects observed venue evidence, because there is no other
 * member of this union.
 */
export const SIMULATED_EVIDENCE_CLASS = "SIMULATED_NOT_REAL_EVIDENCE" as const;
export type SimulatedEvidenceClass = typeof SIMULATED_EVIDENCE_CLASS;

/**
 * The minimum shape a simulated fill has, as the venue interface sees it.
 *
 * The full record is {@link ../fill-model.js}'s `SimulatedFill`; this is the
 * part `ExecutionResult` exposes. Both carry {@link SIMULATED_EVIDENCE_CLASS}.
 */
export interface SimulatedFillLike {
  readonly simulatedFillId: string;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
  readonly feeAmount: string;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly evidenceClass: SimulatedEvidenceClass;
  readonly fillModelVersion: string;
  readonly atEvent: RecordedEventIdentity;
}

/** A clock this package produced. Re-exported so a consumer needs one import. */
export type ReplayClockPort = Clock;
