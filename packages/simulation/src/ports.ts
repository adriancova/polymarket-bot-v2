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
 * simulated venue implements this interface. It is NOT all the simulated venue
 * exposes, and this paragraph used to say it was ("with nothing added to it";
 * SIM-2, `IF-02`): `SimulatedVenue` also takes the recorded stream it is TOLD
 * about (`observe`, `observeTrade`), and the trader's `TraderVenue` port reads
 * venue state between events through a fill cursor and order lookups
 * (`fillsSince`, `orderById`, `orderByPlannedId`), and tells it when it is
 * done with a terminal order (`acknowledgeTerminal`, SIM-2 r1) — members a
 * live adapter will have to answer from its own user channel and order store
 * (the last may be a no-op for a venue that forgets nothing). The rest of
 * the class (`submitAll`, the history accessors, `retention`) is
 * simulator-only. **No method here can carry a credential, a signer, a venue
 * URL, or a network handle**, and none of the implementations in this package
 * has one.
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
 * pin. The real values meet these interfaces in the shared trading core
 * (`packages/trading-core`, which §2.1 row S15 lets consume this package —
 * ADR-022) and in the two composition roots that build that core
 * (`apps/trader`, and `apps/backtest-cli` from `BACKTEST-2` on); this package
 * still imports none of those same-layer packages.
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

/**
 * A simulated order's lifecycle state.
 *
 * TERMINAL: `FILLED`, `CANCELLED`, `EXPIRED`, `REJECTED` — no transition
 * leaves one (a cancel of one answers `notCancelled: "already <state>"`).
 * LIVE: `RESTING` and `PARTIALLY_FILLED` exactly when the venue holds the
 * order's resting record (it can still fill, expire or be cancelled), and
 * `DELAYED` while a marketable order waits out its market's trading delay
 * (ADR-012 §5.1, D-18: pending, not cancellable, nothing filled yet).
 * `ACCEPTED` is part of the vocabulary and is not produced by this venue.
 */
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
  /**
   * How this order's filled quantity is estimated.
   *
   * - `"POINT"` — `filledShares` IS the model's answer.
   * - `"TIER_1_RESTING_BAND"` — a Tier-1 resting order. §12.2 and ADR-012 §1
   *   make its estimate a BAND, so there is no honest single number to put in
   *   `filledShares`: it holds the point-precise quantity actually booked
   *   against cash and inventory (`"0"` for such an order), and the estimate is
   *   the band on the {@link ExecutionResult}. A consumer that reads
   *   `filledShares` for one of these and stops has quoted a band member it was
   *   never given — this field is how it can tell.
   */
  readonly fillEstimateKind: "POINT" | "TIER_1_RESTING_BAND";
  /**
   * The recorded event identity this state was reached at. Never a wall clock.
   * Re-stamped on every transition: a maker fill, an expiry, a DELAYED order's
   * resolution, and (SIM-1, O8) a cancel.
   */
  readonly atEvent: RecordedEventIdentity;
}

/** The recorded identity of the event a simulated outcome is anchored to. */
export interface RecordedEventIdentity {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly receivedAt: string;
  readonly datasetRowOrdinal: number;
}

/**
 * One planned order a PLACEMENT plan did NOT place, and why (SIM-1, ruling R3).
 *
 * Mirrors {@link ExecutionResult.notCancelled} for the placement side, and the
 * venue's own per-entry batch response (`POST /orders` answers one entry per
 * signed order; venue report §2.2 / §9). The refusal is the ORDER's own: the
 * cause for the order that failed, and `SIMULATED_VENUE_ORDER_NOT_SUBMITTED`
 * for one that was never sent because another part of its plan failed first.
 */
export interface NotPlacedOrder {
  readonly plannedOrderId: string;
  readonly refusalCode: string;
  readonly refusalMessage: string;
}

/**
 * §12.1 `ExecutionResult`.
 *
 * SIM-1, the user's ruling R3 — PER-ORDER RESULTS. A multi-order plan can take
 * effect IN PART (§7.7: "Basket execution is coordinated, not assumed
 * atomic"; a plan of more than 15 orders is several venue batches, D-05), so
 * the answer reports each planned order's outcome:
 *
 * | `outcome` | `accepted` | `orders` / `fills` / `bands` | `notPlaced` | `refusalCode` |
 * | --- | --- | --- | --- | --- |
 * | `"ACCEPTED"` | `true` | every order booked | `[]` | absent |
 * | `"PARTIAL"` | `false` | the orders that WERE booked — working or done at the venue, their fills already applied | every other planned order, each with its own refusal | the FIRST failure's code |
 * | `"REFUSED"` | `false` | `[]` | every planned order the plan let the venue read | the cause |
 *
 * The fully accepted and fully refused shapes are the ones this interface
 * always had, plus the two new fields. For a CANCEL plan `notPlaced` is `[]`;
 * `outcome` is `"PARTIAL"` when it cancelled some of its targets and not
 * others (`orders` lists the cancelled ones, `notCancelled` the rest).
 *
 * PLACED IS NOT EXECUTED (SIM-1 r2, `SIM1-R2-1`). For a placement plan,
 * `accepted` / `"ACCEPTED"` says every planned order was PLACED — booked at
 * this venue — and NOTHING about how each one then executed. A booked order
 * can end at once without executing (O2: a FOK that cannot fill whole is
 * booked `REJECTED` with nothing filled; O1: a FAK's unfilled remainder is
 * `CANCELLED`), and on a delayed market it is booked `DELAYED` and reaches its
 * outcome only at `matchableAtNs` (O5). A consumer that needs every order to
 * have EXECUTED — a basket, whose legs are coordinated but not atomic (§7.7)
 * — must read each listed order's `state` and `filledShares`, now and as they
 * change, not this flag (the trader does: `apps/trader/src/basket-execution.ts`).
 */
export interface ExecutionResult {
  readonly executionPlanId: string;
  /**
   * `true` only when the WHOLE plan was placed: for a placement plan, every
   * planned order was BOOKED (each order's own `state` says whether it then
   * executed); for a CANCEL plan, every target was cancelled.
   */
  readonly accepted: boolean;
  /** Whether the plan was placed wholly, in part, or not at all (R3); see `accepted`. */
  readonly outcome: "ACCEPTED" | "PARTIAL" | "REFUSED";
  /**
   * The orders this submission BOOKED — on every outcome, including a partial
   * one and a contained internal fault. An order listed here exists at the
   * venue; a consumer that owns orders must own these.
   */
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFillLike[];
  /**
   * The Tier-1 RESTING estimates this submission produced (§12.2, ADR-012 §1).
   *
   * A resting order under Tier 1 has no point-precise fill: its estimate is the
   * optimistic/base/conservative BAND, and the band is where it is reported. An
   * empty array means the submission produced no resting Tier-1 order — never
   * that a resting estimate was collapsed to a number.
   */
  readonly bands: readonly RestingFillBandLike[];
  /**
   * Orders a CANCEL plan did not cancel, and why.
   *
   * §6 invariant 13 makes safety cancellation the privileged path; a cancel that
   * cancelled nothing must not read as a success at this seam. `accepted` is
   * `false` whenever this is non-empty (round-1 review M8).
   */
  readonly notCancelled: readonly { readonly simulatedOrderId: string; readonly reason: string }[];
  /**
   * The planned orders a PLACEMENT plan did not place, each with its own
   * refusal (R3). `[]` exactly when every planned order was booked, and always
   * `[]` for a CANCEL plan.
   */
  readonly notPlaced: readonly NotPlacedOrder[];
  /**
   * Whether a venue rate-limit budget was actually modelled for this result
   * (§9.13, ADR-012 §5.6). `"NOT_MODELED"` states the absence rather than
   * implying an unlimited venue; {@link rateLimitDisclosure} says why.
   */
  readonly rateLimitModel: "MODELED" | "NOT_MODELED";
  readonly rateLimitDisclosure: string;
  /**
   * Present when the plan was not WHOLLY placed; `accepted` is then
   * `false`. On a `"PARTIAL"` outcome it is the first failure's code, and
   * `orders` still lists what was booked. Absent for a wholly placed plan even
   * when a booked order then executed nothing (see `accepted`).
   */
  readonly refusalCode?: string;
  readonly refusalMessage?: string;
  /** Always `"SIMULATED"`. There is no other value (ADR-012 §2 item 3). */
  readonly venueClass: "SIMULATED";
  readonly planningDepthAwareness: PlanningDepthAwareness;
}

/**
 * The part of a Tier-1 resting band an `ExecutionResult` exposes.
 *
 * The full record is {@link ../queue.js}'s `RestingFillBand`; it is mirrored
 * here for the same reason the other shapes are — `ports.ts` is the seam, and
 * the seam names shapes rather than importing them upward. The three scenarios
 * are all present, because ADR-012 §1 forbids quoting one of them alone.
 */
export interface RestingFillBandLike {
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly restingPrice: string;
  readonly queueModelVersion: string;
  readonly optimistic: { readonly scenario: "OPTIMISTIC"; readonly filledShares: string };
  readonly base: { readonly scenario: "BASE"; readonly filledShares: string };
  readonly conservative: { readonly scenario: "CONSERVATIVE"; readonly filledShares: string };
  readonly bandBasis: "OPTIMISTIC_BASE_CONSERVATIVE_CANCELLATION_ASSUMPTIONS";
  readonly quotationRule: "REPORT_THE_BAND_NEVER_ONE_MEMBER";
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
 * a later work package behind the SAME three methods — and, because the trader
 * drives its venue through `apps/trader`'s `TraderVenue` port rather than this
 * interface alone, it will also answer that port's observation, fill-cursor
 * and order-lookup members (see this file's header; SIM-2, `IF-02`).
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
