/**
 * The simulated execution venue (§12.1, §11).
 *
 * §12.1: "Everything between event input and the `ExecutionVenue` interface is
 * shared." This class implements exactly that interface —
 * `submit` / `cancel` / `queryAccountState` — and adds nothing to it, so the
 * live adapter that arrives later is a drop-in behind the same three methods and
 * the whole core loop above it is unchanged.
 *
 * SAFETY, and it is structural rather than a promise:
 *
 * - This file contains no URL, no socket, no HTTP client, no signer, no key, and
 *   no credential, and none of its types has a field that could carry one.
 * - `submit` REFUSES a plan whose `runMode` is `EXECUTION_PROBE`, `LIVE_MICRO`
 *   or `LIVE` by name (`SIMULATED_VENUE_RUN_MODE_REQUIRES_LIVE_SIGNER`). §11
 *   gives those three a live signer and real orders; a simulated venue that
 *   accepted one would be pretending to be a venue, which is precisely what
 *   ADR-012 §2 item 3 forbids.
 * - Every result carries `venueClass: "SIMULATED"` and every fill carries
 *   `evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"`.
 *
 * §6 invariant 13 — "Safety cancellation outranks new order placement.
 * Rate-limit scheduling reflects this priority" — is implemented in
 * {@link SimulatedVenue.submitAll}: plans are scheduled by
 * {@link ../ports.js#comparePlanPriority}, which is WP-190's own rank, and the
 * cancel budget is a separate bucket from the placement budget
 * ({@link ../rate-limit.js}).
 *
 * TIME. The venue reads no clock of its own. It is told which recorded event it
 * is at, via {@link SimulatedVenue.observe}, and every state it produces is
 * anchored to that recorded identity rather than to a wall clock.
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";

import type { FeeScheduleSnapshot } from "./fees.js";
import type { FillModelIdentity, SimulatedFill } from "./fill-model.js";
import type { LatencyModel } from "./latency.js";
import { ownFrozenTree } from "./plain.js";
import {
  PLANNING_DEPTH_AWARENESS,
  SIMULATED_RUN_MODES,
  comparePlanPriority,
  type AccountSnapshot,
  type BookView,
  type CancelCommand,
  type CancelResult,
  type Clock,
  type ExecutionPlanView,
  type ExecutionResult,
  type ExecutionVenue,
  type PlannedOrderView,
  type RecordedEventIdentity,
  type SimulatedOrder,
  type SimulatedRunMode,
} from "./ports.js";
import type { RateLimitBudget } from "./rate-limit.js";
import { simulationRefusal, type SimulationRefusal } from "./refusals.js";
import type { SeededStreams } from "./seed.js";
import { tier0Immediate } from "./tier0.js";
import { tier1Immediate, type DepthTimeline, type MarketExecutionParameters, type TimeInForce } from "./tier1.js";

/** Where the venue gets a book for the Tier-0 path. */
export interface MarketBookProvider {
  book(input: { readonly marketId: string; readonly side: "YES" | "NO" }): BookView | undefined;
}

/** The venue's execution policy for one planned order. */
export interface ExecutionPolicy {
  /**
   * The time-in-force to simulate for a planned order.
   *
   * WP-190's `PlannedOrder` carries `executionStyle` and `postOnly` but no
   * time-in-force — the planner does not choose one. So the venue asks the
   * composition root rather than assuming a default: a silently assumed `FAK`
   * would change every unfilled remainder's fate.
   */
  timeInForceFor(order: PlannedOrderView): TimeInForce;
  /** The stated GTD expiry, in recorded monotonic nanoseconds, when GTD. */
  statedExpiryNsFor(order: PlannedOrderView): bigint | undefined;
}

/** Construction inputs. Everything is injected; nothing is defaulted. */
export interface SimulatedVenueOptions {
  readonly clock: Clock;
  readonly runMode: SimulatedRunMode;
  readonly model: FillModelIdentity;
  readonly feeSnapshot: FeeScheduleSnapshot;
  readonly rateLimits: RateLimitBudget;
  readonly policy: ExecutionPolicy;
  readonly startingCash: string;
  /** Required for a Tier-0 venue. */
  readonly books?: MarketBookProvider;
  /** Required for a Tier-1 venue. */
  readonly timeline?: DepthTimeline;
  /** Required for a Tier-1 venue. */
  readonly latencyModel?: LatencyModel;
  /** Required for a Tier-1 venue. */
  readonly streams?: SeededStreams;
  /** Versioned per-market parameters for the instant replayed (§6 invariant 9). */
  readonly marketParameters?: (marketId: string) => MarketExecutionParameters | undefined;
}

interface PositionKey {
  readonly marketId: string;
  readonly side: "YES" | "NO";
}

/**
 * A total, locale-independent string comparison.
 *
 * `localeCompare` depends on the host's ICU data, which is exactly the kind of
 * environment dependence a §12.4 byte-identical claim must not have.
 */
function compareStrings(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positionKey(key: PositionKey): string {
  // A unit separator, so a market id that happens to end in "YES" cannot forge
  // a collision with a different market's key.
  return `${key.marketId}\u001f${key.side}`;
}

/** The §12.1 `ExecutionVenue`, simulated. */
export class SimulatedVenue implements ExecutionVenue {
  readonly #options: SimulatedVenueOptions;
  readonly #orders = new Map<string, SimulatedOrder>();
  readonly #positions = new Map<string, { marketId: string; tokenId: string; side: "YES" | "NO"; shares: string }>();
  readonly #fills: SimulatedFill[] = [];
  #cash: string;
  #atEvent: RecordedEventIdentity | undefined;

  constructor(options: SimulatedVenueOptions) {
    this.#options = options;
    this.#cash = options.startingCash;
  }

  /** Every fill this venue produced, in production order. */
  get fills(): readonly SimulatedFill[] {
    return this.#fills;
  }

  /** The recorded event the venue is currently positioned at. */
  get atEvent(): RecordedEventIdentity | undefined {
    return this.#atEvent;
  }

  /**
   * Every order this venue knows, ordered by id.
   *
   * Ordered by a value-derived key rather than by `Map` insertion order, so the
   * §12.4 serialization does not depend on the order the plans were built in.
   */
  ordersSnapshot(): readonly SimulatedOrder[] {
    return [...this.#orders.values()].sort((left, right) =>
      compareStrings(left.simulatedOrderId, right.simulatedOrderId),
    );
  }

  /**
   * Positions the venue at a recorded event.
   *
   * Called by the run driver for every delivered event. The venue has no clock
   * of its own and no way to advance itself.
   */
  observe(identity: RecordedEventIdentity): void {
    this.#atEvent = identity;
  }

  async submit(plan: ExecutionPlanView): Promise<ExecutionResult> {
    return await Promise.resolve(this.#submitSync(plan));
  }

  /**
   * Submits several plans in §6 invariant 13 order.
   *
   * `SAFETY_CANCEL` plans are scheduled ahead of `PLACEMENT` plans by WP-190's
   * own rank, and ties keep their given order (a stable sort), so the schedule
   * is deterministic for a fixed input.
   */
  async submitAll(plans: readonly ExecutionPlanView[]): Promise<readonly ExecutionResult[]> {
    const indexed = plans.map((plan, index) => ({ plan, index }));
    indexed.sort((left, right) => {
      const byPriority = comparePlanPriority(left.plan.priority, right.plan.priority);
      return byPriority !== 0 ? byPriority : left.index - right.index;
    });
    const results: ExecutionResult[] = [];
    for (const entry of indexed) {
      results.push(await this.submit(entry.plan));
    }
    return results;
  }

  async cancel(command: CancelCommand): Promise<CancelResult> {
    return await Promise.resolve(this.#cancelSync(command));
  }

  async queryAccountState(): Promise<AccountSnapshot> {
    return await Promise.resolve(this.#accountSync());
  }

  // -------------------------------------------------------------------------

  #refuse(plan: ExecutionPlanView, refusal: SimulationRefusal): ExecutionResult {
    return ownFrozenTree<ExecutionResult>({
      executionPlanId: plan.executionPlanId,
      accepted: false,
      orders: [],
      fills: [],
      refusalCode: refusal.code,
      refusalMessage: refusal.message,
      venueClass: "SIMULATED",
      planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
    });
  }

  #submitSync(plan: ExecutionPlanView): ExecutionResult {
    if (!(SIMULATED_RUN_MODES as readonly string[]).includes(plan.runMode)) {
      return this.#refuse(
        plan,
        simulationRefusal(
          "SIMULATED_VENUE_RUN_MODE_REQUIRES_LIVE_SIGNER",
          `run mode ${plan.runMode} requires a live signer and real orders (§11); a simulated venue may not serve it`,
          { runMode: plan.runMode },
        ),
      );
    }
    if (plan.runMode !== this.#options.runMode) {
      return this.#refuse(
        plan,
        simulationRefusal(
          "SIMULATED_VENUE_PLAN_UNSUPPORTED",
          `this venue serves ${this.#options.runMode} and the plan names ${plan.runMode}`,
          { venueRunMode: this.#options.runMode, planRunMode: plan.runMode },
        ),
      );
    }
    const atEvent = this.#atEvent;
    if (atEvent === undefined) {
      return this.#refuse(
        plan,
        simulationRefusal(
          "SIMULATED_VENUE_NO_BOOK",
          "the venue has not been positioned at any recorded event, so nothing it produced could be anchored to one",
        ),
      );
    }

    if (plan.planKind === "CANCEL") {
      const result = this.#cancelSync({
        executionPlanId: plan.executionPlanId,
        reason: plan.reason,
        scope: plan.scope,
        priority: "SAFETY_CANCEL",
      });
      return ownFrozenTree<ExecutionResult>({
        executionPlanId: plan.executionPlanId,
        accepted: true,
        orders: result.cancelled
          .map((id) => this.#orders.get(id))
          .filter((order): order is SimulatedOrder => order !== undefined),
        fills: [],
        venueClass: "SIMULATED",
        planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
      });
    }

    const orders: SimulatedOrder[] = [];
    const fills: SimulatedFill[] = [];
    for (const group of plan.groups) {
      for (const planned of group.orders) {
        if (this.#orders.has(planned.plannedOrderId)) {
          return this.#refuse(
            plan,
            simulationRefusal(
              "SIMULATED_VENUE_DUPLICATE_ORDER",
              "a planned order id was submitted twice; §6 invariant 6 makes an unknown submission a reconciliation question, never a silent retry",
              { plannedOrderId: planned.plannedOrderId },
            ),
          );
        }
        const admitted = this.#options.rateLimits.admit({
          kind: "PLACE",
          priority: "PLACEMENT",
          count: 1,
          atNs: this.#options.clock.monotonicNs(),
        });
        if (!admitted.admitted) {
          return this.#refuse(
            plan,
            simulationRefusal(
              "SIMULATED_VENUE_RATE_LIMITED",
              admitted.reason ??
                "the rate-limit budget refused the placement (§9.13, ADR-012 §5.6)",
              { plannedOrderId: planned.plannedOrderId },
            ),
          );
        }
        const executed = this.#executeOne(plan, group.marketId, planned, atEvent);
        if ("refusal" in executed) return this.#refuse(plan, executed.refusal);
        orders.push(executed.order);
        for (const fill of executed.fills) fills.push(fill);
      }
    }

    return ownFrozenTree<ExecutionResult>({
      executionPlanId: plan.executionPlanId,
      accepted: true,
      orders,
      fills,
      venueClass: "SIMULATED",
      planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
    });
  }

  #executeOne(
    plan: ExecutionPlanView,
    marketId: string,
    planned: PlannedOrderView,
    atEvent: RecordedEventIdentity,
  ): { readonly order: SimulatedOrder; readonly fills: readonly SimulatedFill[] } | { readonly refusal: SimulationRefusal } {
    const model = this.#options.model;
    if (model.tier === "TIER_0") {
      const books = this.#options.books;
      if (books === undefined) {
        return {
          refusal: simulationRefusal(
            "SIMULATED_VENUE_PLAN_UNSUPPORTED",
            "a Tier-0 venue needs a book provider",
          ),
        };
      }
      const book = books.book({ marketId, side: planned.side });
      if (book === undefined) {
        return {
          refusal: simulationRefusal(
            "SIMULATED_VENUE_NO_BOOK",
            "no book state exists for the market and side the plan names; §6 invariant 12 refuses to act on unknown book state",
            { marketId, side: planned.side },
          ),
        };
      }
      const outcome = tier0Immediate({
        model,
        book,
        simulatedOrderId: planned.plannedOrderId,
        marketId,
        side: planned.side,
        action: planned.action,
        limitPrice: planned.limitPrice,
        shares: planned.shares,
        feeSnapshot: this.#options.feeSnapshot,
        atEvent,
      });
      if (!outcome.ok) return { refusal: outcome.refusal };
      return this.#book(plan, planned, marketId, book.tokenId, outcome.value.fills, outcome.value.filledShares, outcome.value.remainingShares, atEvent, "RESTS");
    }

    const timeline = this.#options.timeline;
    const latencyModel = this.#options.latencyModel;
    const streams = this.#options.streams;
    const marketParameters = this.#options.marketParameters;
    if (timeline === undefined || latencyModel === undefined || streams === undefined || marketParameters === undefined) {
      return {
        refusal: simulationRefusal(
          "SIMULATED_VENUE_PLAN_UNSUPPORTED",
          "a Tier-1 venue needs a depth timeline, a latency model, seeded streams, and versioned market parameters",
        ),
      };
    }
    const market = marketParameters(marketId);
    if (market === undefined) {
      return {
        refusal: simulationRefusal(
          "SIMULATED_VENUE_PLAN_UNSUPPORTED",
          "no versioned market parameters are known for the instant being replayed; §6 invariant 9 requires historical runs to use historical parameters",
          { marketId },
        ),
      };
    }
    const timeInForce = this.#options.policy.timeInForceFor(planned);
    const statedExpiryNs = this.#options.policy.statedExpiryNsFor(planned);
    const outcome = tier1Immediate({
      model,
      timeline,
      latencyModel,
      streams,
      simulatedOrderId: planned.plannedOrderId,
      marketId,
      side: planned.side,
      action: planned.action,
      limitPrice: planned.limitPrice,
      shares: planned.shares,
      timeInForce,
      postOnly: planned.postOnly,
      submittedAtNs: this.#options.clock.monotonicNs(),
      ...(statedExpiryNs === undefined ? {} : { statedExpiryNs }),
      market,
      feeSnapshot: this.#options.feeSnapshot,
    });
    if (!outcome.ok) return { refusal: outcome.refusal };
    const tokenId = outcome.value.tokenId ?? "";
    const disposition = outcome.value.remainderDisposition;
    return this.#book(
      plan,
      planned,
      marketId,
      tokenId,
      outcome.value.fills,
      outcome.value.filledShares,
      outcome.value.remainingShares,
      outcome.value.atEvent ?? atEvent,
      disposition === "CANCELLED_BY_FAK"
        ? "CANCELLED"
        : disposition === "REJECTED_BY_FOK"
          ? "REJECTED"
          : disposition === "EXPIRED_BEFORE_MATCHING"
            ? "EXPIRED"
            : "RESTS",
      outcome.value.delayedByMarket,
    );
  }

  #book(
    plan: ExecutionPlanView,
    planned: PlannedOrderView,
    marketId: string,
    tokenId: string,
    fills: readonly SimulatedFill[],
    filledShares: string,
    remainingShares: string,
    atEvent: RecordedEventIdentity,
    remainderState: "RESTS" | "CANCELLED" | "REJECTED" | "EXPIRED",
    delayedByMarket = false,
  ): { readonly order: SimulatedOrder; readonly fills: readonly SimulatedFill[] } {
    for (const fill of fills) {
      this.#applyFill(fill);
      this.#fills.push(fill);
    }
    const complete = compareDecimal(remainingShares, "0") === 0;
    // ADR-012 §5.1 / venue report §2.2: on a delayed market a marketable order
    // "is accepted but has not matched yet … Treat it as a pending order rather
    // than a fill", so an unfilled order on such a market is DELAYED, not
    // REJECTED and not RESTING.
    const state: SimulatedOrder["state"] = complete
      ? "FILLED"
      : compareDecimal(filledShares, "0") > 0
        ? "PARTIALLY_FILLED"
        : delayedByMarket
          ? "DELAYED"
          : remainderState === "RESTS"
            ? "RESTING"
            : remainderState;

    const order = ownFrozenTree<SimulatedOrder>({
      simulatedOrderId: planned.plannedOrderId,
      plannedOrderId: planned.plannedOrderId,
      executionPlanId: plan.executionPlanId,
      marketId,
      tokenId,
      side: planned.side,
      action: planned.action,
      limitPrice: planned.limitPrice,
      requestedShares: planned.shares,
      filledShares,
      state,
      postOnly: planned.postOnly,
      executionStyle: planned.executionStyle,
      atEvent,
    });
    this.#orders.set(order.simulatedOrderId, order);
    return { order, fills };
  }

  #applyFill(fill: SimulatedFill): void {
    const notional = mulDecimal(fill.price, fill.shares);
    this.#cash =
      fill.action === "BUY"
        ? subDecimal(subDecimal(this.#cash, notional), fill.feeAmount)
        : subDecimal(addDecimal(this.#cash, notional), fill.feeAmount);
    const key = positionKey({ marketId: fill.marketId, side: fill.side });
    const current = this.#positions.get(key);
    const delta = fill.action === "BUY" ? fill.shares : subDecimal("0", fill.shares);
    if (current === undefined) {
      this.#positions.set(key, {
        marketId: fill.marketId,
        tokenId: fill.tokenId,
        side: fill.side,
        shares: delta,
      });
      return;
    }
    current.shares = addDecimal(current.shares, delta);
  }

  #cancelSync(command: CancelCommand): CancelResult {
    const cancelled: string[] = [];
    const notCancelled: { simulatedOrderId: string; reason: string }[] = [];
    const targets =
      command.scope.orderIds ??
      [...this.#orders.values()]
        .filter((order) =>
          command.scope.marketId === undefined ? true : order.marketId === command.scope.marketId,
        )
        .map((order) => order.simulatedOrderId);

    const admitted = this.#options.rateLimits.admit({
      kind: "CANCEL",
      // §6 invariant 13: a cancel is always SAFETY_CANCEL at this venue, and it
      // draws on the cancel bucket, so placement traffic cannot starve it.
      priority: "SAFETY_CANCEL",
      count: targets.length,
      atNs: this.#options.clock.monotonicNs(),
    });

    for (const id of [...targets].sort()) {
      const order = this.#orders.get(id);
      if (order === undefined) {
        notCancelled.push({ simulatedOrderId: id, reason: "SIMULATED_VENUE_UNKNOWN_ORDER" });
        continue;
      }
      if (!admitted.admitted) {
        notCancelled.push({
          simulatedOrderId: id,
          reason: admitted.reason ?? "SIMULATED_VENUE_RATE_LIMITED",
        });
        continue;
      }
      if (order.state === "FILLED" || order.state === "CANCELLED" || order.state === "EXPIRED") {
        notCancelled.push({ simulatedOrderId: id, reason: `already ${order.state}` });
        continue;
      }
      this.#orders.set(
        id,
        ownFrozenTree<SimulatedOrder>({ ...order, state: "CANCELLED" }),
      );
      cancelled.push(id);
    }

    return ownFrozenTree<CancelResult>({
      executionPlanId: command.executionPlanId,
      cancelled,
      notCancelled,
      venueClass: "SIMULATED",
    });
  }

  #accountSync(): AccountSnapshot {
    const atEvent = this.#atEvent ?? null;
    const positions = [...this.#positions.values()]
      .filter((position) => compareDecimal(position.shares, "0") !== 0)
      .sort((left, right) => compareStrings(positionKey(left), positionKey(right)))
      .map((position) => ({
        marketId: position.marketId,
        tokenId: position.tokenId,
        side: position.side,
        shares: position.shares,
      }));
    const openOrders = [...this.#orders.values()]
      .filter(
        (order) =>
          order.state === "RESTING" || order.state === "PARTIALLY_FILLED" || order.state === "DELAYED",
      )
      .sort((left, right) => compareStrings(left.simulatedOrderId, right.simulatedOrderId));
    return ownFrozenTree<AccountSnapshot>({
      venueClass: "SIMULATED",
      cashBalance: this.#cash,
      positions,
      openOrders,
      atEvent,
    });
  }
}
