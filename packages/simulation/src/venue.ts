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
 * {@link ./ports.js#comparePlanPriority}, which is WP-190's own rank, and the
 * cancel budget is a separate bucket from the placement budget
 * ({@link ./rate-limit.js}). A cancel that cancelled NOTHING is reported as
 * `accepted: false` with the failures named, because at this seam a silent
 * success on the privileged path is the worst possible answer.
 *
 * TIME. The venue reads no clock of its own. It is told which recorded event it
 * is at, via {@link SimulatedVenue.observe}, and every state it produces is
 * anchored to that recorded identity rather than to a wall clock.
 *
 * ## What an order's `executionStyle` decides (round-1 review, HIGH-2)
 *
 * An earlier version of this venue executed EVERY planned order as an immediate
 * marketable take, so a `REST` order never rested, a crossing `postOnly` order
 * was filled as a TAKER — which the venue would have rejected — and the §12.2
 * Tier-1 resting band was unreachable through the §12.1 seam. The routing is now:
 *
 * | style | crossing? | `postOnly` | what happens |
 * | --- | --- | --- | --- |
 * | `REST` | yes | yes | **REJECTED**, unfilled (venue report §2.3, ADR-012 §5.3) |
 * | `REST` | yes | no | matches immediately: a crossing limit order is marketable |
 * | `REST` | no | either | **RESTS**: Tier 0 fills on touch/trade-through, Tier 1 reports the BAND |
 * | `MARKETABLE_LIMIT` | — | must be false | the immediate path (FAK/FOK/limit semantics) |
 *
 * A resting order is filled by OBSERVED trades, handed to
 * {@link SimulatedVenue.observeTrade} by the run driver — the same recorded
 * events that move the clock. Tier 0 grants the whole remaining size on touch or
 * trade-through (§12.2); Tier 1 produces the optimistic/base/conservative band
 * ({@link ./queue.js}) and books NO point-precise fill, because ADR-012 §1 says
 * a Tier-1 result quoted as a single number has already violated the ADR.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, mulDecimal, subDecimal } from "@polymarket-bot/decimal";

import { addMilliseconds } from "./clock.js";
import { readFeeScheduleSnapshot, type FeeScheduleSnapshot } from "./fees.js";
import { sizeAtPrice, type FillModelIdentity, type SimulatedFill } from "./fill-model.js";
import { isNonEmptyString } from "./grammar.js";
import { readLatencyModel, sampleLatency, type LatencyModel } from "./latency.js";
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
import {
  readQueueModelParameters,
  readSameInstantAdditions,
  simulateResting,
  type ObservedTrade,
  type QueueModelParameters,
  type RestingFillBand,
  type SameInstantAdditions,
} from "./queue.js";
import type { RateLimitBudget } from "./rate-limit.js";
import { simulationRefusal, totally, type SimulationRefusal, type SimulationResult } from "./refusals.js";
import { simulationFailure, simulationOk } from "./refusals.js";
import type { SeededStreams } from "./seed.js";
import { tier0Immediate, tier0Maker } from "./tier0.js";
import {
  GTD_EARLY_EXPIRY_MS,
  tier1Immediate,
  type DepthTimeline,
  type MarketExecutionParameters,
  type TimeInForce,
} from "./tier1.js";

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
  /**
   * What the root OBSERVED about size added at the order's price in the same
   * recorded instant it was placed.
   *
   * The CONSERVATIVE queue scenario assumes we sit behind it ({@link
   * ./queue.js}). A book snapshot is an AGGREGATE per level, so the venue cannot
   * derive this from the book alone; the composition root states it.
   *
   * It answers a TAGGED value, not a quantity (round-2 review, L4): the previous
   * `"0"` meant both "we looked and saw nothing added" and "we did not look",
   * and only the first supports calling the conservative arm conservative. The
   * answer travels onto the band and into its §12.4 bytes, so a run that never
   * looked is visible in the artifact. There is still no default: a root that
   * states neither is refused.
   */
  sameInstantAdditionsFor(order: PlannedOrderView): SameInstantAdditions;
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
  /** Required for a Tier-1 venue that rests orders (§12.2 resting scenarios). */
  readonly queueParameters?: QueueModelParameters;
}

interface PositionKey {
  readonly marketId: string;
  readonly side: "YES" | "NO";
}

/** One order this venue is holding on the book. */
interface RestingRecord {
  readonly simulatedOrderId: string;
  readonly executionPlanId: string;
  readonly planned: PlannedOrderView;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly restingPrice: string;
  readonly restingFromNs: bigint;
  /** Effective expiry (stated minus GTD's 60 s), when the order is GTD. */
  readonly effectiveExpiryNs: bigint | undefined;
  readonly sameInstantAdditions: SameInstantAdditions;
  readonly queueAheadAtPlacement: string;
  remainingShares: string;
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
  return `${key.marketId}${key.side}`;
}

/** The §12.1 `ExecutionVenue`, simulated. */
export class SimulatedVenue implements ExecutionVenue {
  readonly #options: SimulatedVenueOptions;
  readonly #orders = new Map<string, SimulatedOrder>();
  readonly #positions = new Map<string, { marketId: string; tokenId: string; side: "YES" | "NO"; shares: string }>();
  readonly #fills: SimulatedFill[] = [];
  readonly #resting = new Map<string, RestingRecord>();
  readonly #bands = new Map<string, RestingFillBand>();
  readonly #trades = new Map<string, ObservedTrade[]>();
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
   * Every Tier-1 resting BAND this venue currently holds, ordered by order id.
   *
   * The band is the whole estimate for a Tier-1 resting order (§12.2, ADR-012
   * §1); there is no point-estimate accessor beside it.
   */
  restingBands(): readonly RestingFillBand[] {
    return [...this.#bands.values()].sort((left, right) =>
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

  /**
   * Reports one OBSERVED trade to the venue's resting orders.
   *
   * This is how a resting order fills: §12.2 Tier 0 "maker orders fill on
   * touch/trade-through", and Tier 1 "decrement according to observed trades".
   * The trade is a recorded fact handed over by the run driver — the venue
   * neither reads a feed nor decides what a trade is.
   */
  observeTrade(input: {
    readonly marketId: string;
    readonly side: "YES" | "NO";
    readonly price: string;
    readonly shares: string;
    readonly monotonicNs: bigint;
    readonly atEvent: RecordedEventIdentity;
  }): SimulationResult<{
    readonly fills: readonly SimulatedFill[];
    readonly bands: readonly RestingFillBand[];
  }> {
    return totally("observing a trade at the simulated venue", () => this.#observeTradeSync(input));
  }

  async submit(plan: ExecutionPlanView): Promise<ExecutionResult> {
    return await Promise.resolve(
      totallyResult(
        () => this.#submitSync(plan),
        (refusal) => this.#refuse(plan, refusal),
      ),
    );
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
      executionPlanId: typeof plan?.executionPlanId === "string" ? plan.executionPlanId : "",
      accepted: false,
      orders: [],
      fills: [],
      bands: [],
      notCancelled: [],
      rateLimitModel: this.#options.rateLimits.modelKind,
      rateLimitDisclosure: this.#options.rateLimits.disclosure,
      refusalCode: refusal.code,
      refusalMessage: refusal.message,
      venueClass: "SIMULATED",
      planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
    });
  }

  #submitSync(plan: ExecutionPlanView): ExecutionResult {
    if (plan === null || typeof plan !== "object") {
      return this.#refuse(plan, simulationRefusal("SIMULATION_INPUT_INVALID", "a plan is a record"));
    }
    if (!(SIMULATED_RUN_MODES as readonly string[]).includes(plan.runMode)) {
      return this.#refuse(
        plan,
        simulationRefusal(
          "SIMULATED_VENUE_RUN_MODE_REQUIRES_LIVE_SIGNER",
          `run mode ${String(plan.runMode)} requires a live signer and real orders (§11); a simulated venue may not serve it`,
          { runMode: String(plan.runMode) },
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
    if (!isCanonicalDecimalString(this.#cash)) {
      return this.#refuse(
        plan,
        simulationRefusal(
          "SIMULATION_INPUT_INVALID",
          "the venue's cash balance is not a canonical decimal string; every economic value it books is exact (§6 invariant 1)",
          { cashBalance: String(this.#cash) },
        ),
      );
    }
    const fees = readFeeScheduleSnapshot(this.#options.feeSnapshot);
    if (!fees.ok) return this.#refuse(plan, fees.refusal);
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
      // §6 invariant 13: this is the privileged path. A cancel that cancelled
      // nothing is NOT an accepted plan, and the failures travel with the
      // result rather than being dropped at the seam (round-1 review M8).
      const failed = result.notCancelled.length > 0;
      return ownFrozenTree<ExecutionResult>({
        executionPlanId: plan.executionPlanId,
        accepted: !failed,
        orders: result.cancelled
          .map((id) => this.#orders.get(id))
          .filter((order): order is SimulatedOrder => order !== undefined),
        fills: [],
        bands: [],
        notCancelled: result.notCancelled,
        rateLimitModel: this.#options.rateLimits.modelKind,
        rateLimitDisclosure: this.#options.rateLimits.disclosure,
        ...(failed
          ? {
              refusalCode: "SIMULATED_VENUE_CANCEL_INCOMPLETE",
              refusalMessage: `${String(result.notCancelled.length)} order(s) named by a SAFETY_CANCEL plan were not cancelled; §6 invariant 13 makes this the privileged path and its failure is never silent`,
            }
          : {}),
        venueClass: "SIMULATED",
        planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
      });
    }

    if (!Array.isArray(plan.groups)) {
      return this.#refuse(
        plan,
        simulationRefusal("SIMULATION_INPUT_INVALID", "a placement plan carries execution groups"),
      );
    }

    const orders: SimulatedOrder[] = [];
    const fills: SimulatedFill[] = [];
    const bands: RestingFillBand[] = [];
    for (const group of plan.groups) {
      if (group === null || typeof group !== "object" || !Array.isArray(group.orders)) {
        return this.#refuse(
          plan,
          simulationRefusal("SIMULATION_INPUT_INVALID", "an execution group carries planned orders"),
        );
      }
      for (const planned of group.orders) {
        const validated = validatePlannedOrder(planned);
        if (!validated.ok) return this.#refuse(plan, validated.refusal);
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
        const executed = this.#executeOne(plan, group.marketId, planned, atEvent, fees.value);
        if ("refusal" in executed) return this.#refuse(plan, executed.refusal);
        orders.push(executed.order);
        for (const fill of executed.fills) fills.push(fill);
        if (executed.band !== undefined) bands.push(executed.band);
      }
    }

    return ownFrozenTree<ExecutionResult>({
      executionPlanId: plan.executionPlanId,
      accepted: true,
      orders,
      fills,
      bands,
      notCancelled: [],
      rateLimitModel: this.#options.rateLimits.modelKind,
      rateLimitDisclosure: this.#options.rateLimits.disclosure,
      venueClass: "SIMULATED",
      planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
    });
  }

  #executeOne(
    plan: ExecutionPlanView,
    marketId: string,
    planned: PlannedOrderView,
    atEvent: RecordedEventIdentity,
    feeSnapshot: FeeScheduleSnapshot,
  ):
    | {
        readonly order: SimulatedOrder;
        readonly fills: readonly SimulatedFill[];
        readonly band?: RestingFillBand;
      }
    | { readonly refusal: SimulationRefusal } {
    const timeInForce = this.#options.policy.timeInForceFor(planned);
    if (timeInForce !== "GTC" && timeInForce !== "GTD" && timeInForce !== "FAK" && timeInForce !== "FOK") {
      return {
        refusal: simulationRefusal(
          "SIMULATED_VENUE_PLAN_UNSUPPORTED",
          "the venue simulates the four order types the venue report §2.3 documents: GTC, GTD, FAK and FOK",
          { offered: String(timeInForce) },
        ),
      };
    }
    if (planned.postOnly && planned.executionStyle !== "REST") {
      return {
        refusal: simulationRefusal(
          "SIMULATED_VENUE_PLAN_UNSUPPORTED",
          "postOnly applies only to resting limit types (venue report §2.3, ADR-012 §5.3), and this order is planned as marketable",
          { plannedOrderId: planned.plannedOrderId, executionStyle: planned.executionStyle },
        ),
      };
    }
    if (planned.executionStyle === "REST" && (timeInForce === "FAK" || timeInForce === "FOK")) {
      return {
        refusal: simulationRefusal(
          "SIMULATED_VENUE_PLAN_UNSUPPORTED",
          "a FAK or FOK order does not rest (venue report §2.3): FAK cancels its remainder and FOK is all-or-nothing, so neither can serve an order planned to REST",
          { plannedOrderId: planned.plannedOrderId, timeInForce },
        ),
      };
    }

    const statedExpiryNs = this.#options.policy.statedExpiryNsFor(planned);
    if (timeInForce === "GTD" && typeof statedExpiryNs !== "bigint") {
      return {
        refusal: simulationRefusal(
          "SIMULATED_VENUE_PLAN_UNSUPPORTED",
          "a GTD order must state its expiration",
          { plannedOrderId: planned.plannedOrderId },
        ),
      };
    }

    return this.#options.model.tier === "TIER_0"
      ? this.#executeTier0(plan, marketId, planned, atEvent, feeSnapshot, timeInForce, statedExpiryNs)
      : this.#executeTier1(plan, marketId, planned, atEvent, feeSnapshot, timeInForce, statedExpiryNs);
  }

  // --- Tier 0 ---------------------------------------------------------------

  #executeTier0(
    plan: ExecutionPlanView,
    marketId: string,
    planned: PlannedOrderView,
    atEvent: RecordedEventIdentity,
    feeSnapshot: FeeScheduleSnapshot,
    timeInForce: TimeInForce,
    statedExpiryNs: bigint | undefined,
  ):
    | { readonly order: SimulatedOrder; readonly fills: readonly SimulatedFill[] }
    | { readonly refusal: SimulationRefusal } {
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

    const crossing = isCrossing(book, planned);
    if (!crossing.ok) return { refusal: crossing.refusal };

    if (planned.executionStyle === "REST" && crossing.value && planned.postOnly) {
      return this.#rejectCrossingPostOnly(plan, planned, marketId, book.tokenId, atEvent);
    }

    if (planned.executionStyle === "REST" && !crossing.value) {
      const registered = this.#rest({
        plan,
        planned,
        marketId,
        tokenId: book.tokenId,
        book,
        restingFromNs: this.#options.clock.monotonicNs(),
        remainingShares: planned.shares,
        filledShares: "0",
        timeInForce,
        statedExpiryNs,
        atEvent,
        feeSnapshot,
        previousFills: [],
      });
      if (!registered.ok) return { refusal: registered.refusal };
      return registered.value;
    }

    // Marketable: the immediate path, either because the plan said so or because
    // a crossing non-postOnly limit order matches on arrival.
    const outcome = tier0Immediate({
      model: this.#options.model,
      book,
      simulatedOrderId: planned.plannedOrderId,
      marketId,
      side: planned.side,
      action: planned.action,
      limitPrice: planned.limitPrice,
      shares: planned.shares,
      feeSnapshot,
      atEvent,
    });
    if (!outcome.ok) return { refusal: outcome.refusal };
    if (
      planned.executionStyle === "REST" &&
      compareDecimal(outcome.value.remainingShares, "0") > 0
    ) {
      const registered = this.#rest({
        plan,
        planned,
        marketId,
        tokenId: book.tokenId,
        book,
        restingFromNs: this.#options.clock.monotonicNs(),
        remainingShares: outcome.value.remainingShares,
        filledShares: outcome.value.filledShares,
        timeInForce,
        statedExpiryNs,
        atEvent,
        feeSnapshot,
        previousFills: outcome.value.fills,
      });
      if (!registered.ok) return { refusal: registered.refusal };
      return registered.value;
    }
    return this.#book({
      plan,
      planned,
      marketId,
      tokenId: book.tokenId,
      fills: outcome.value.fills,
      filledShares: outcome.value.filledShares,
      remainingShares: outcome.value.remainingShares,
      atEvent,
      remainderState: timeInForce === "FAK" ? "CANCELLED" : "RESTS",
      fillEstimateKind: "POINT",
    });
  }

  // --- Tier 1 ---------------------------------------------------------------

  #executeTier1(
    plan: ExecutionPlanView,
    marketId: string,
    planned: PlannedOrderView,
    atEvent: RecordedEventIdentity,
    feeSnapshot: FeeScheduleSnapshot,
    timeInForce: TimeInForce,
    statedExpiryNs: bigint | undefined,
  ):
    | {
        readonly order: SimulatedOrder;
        readonly fills: readonly SimulatedFill[];
        readonly band?: RestingFillBand;
      }
    | { readonly refusal: SimulationRefusal } {
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
    // Validated on the execution path, not merely offered: an empty distribution
    // must refuse here exactly as `readLatencyModel` intends, or "no latency
    // data" silently becomes "no latency" (round-1 review M6).
    const validatedLatency = readLatencyModel(latencyModel);
    if (!validatedLatency.ok) return { refusal: validatedLatency.refusal };

    if (planned.executionStyle === "REST") {
      const latency = sampleLatency(validatedLatency.value, streams);
      const restingFromNs = addMilliseconds(this.#options.clock.monotonicNs(), latency.totalMs);
      const observed = timeline.bookAt({
        marketId,
        side: planned.side,
        monotonicNs: restingFromNs,
      });
      if (observed === undefined) {
        return {
          refusal: simulationRefusal(
            "SIMULATED_VENUE_NO_BOOK",
            "no recorded book state is known at the instant the order would rest; §6 invariant 12 refuses to act on unknown book state rather than resting against a stale one",
            { marketId, restingFromNs: restingFromNs.toString() },
          ),
        };
      }
      const crossing = isCrossing(observed.book, planned);
      if (!crossing.ok) return { refusal: crossing.refusal };
      if (crossing.value && planned.postOnly) {
        return this.#rejectCrossingPostOnly(
          plan,
          planned,
          marketId,
          observed.book.tokenId,
          observed.atEvent,
        );
      }
      if (!crossing.value) {
        const registered = this.#rest({
          plan,
          planned,
          marketId,
          tokenId: observed.book.tokenId,
          book: observed.book,
          restingFromNs,
          remainingShares: planned.shares,
          filledShares: "0",
          timeInForce,
          statedExpiryNs,
          atEvent: observed.atEvent,
          feeSnapshot,
          previousFills: [],
        });
        if (!registered.ok) return { refusal: registered.refusal };
        return registered.value;
      }
      // A crossing, non-postOnly limit order matches on arrival: it is
      // marketable in fact, whatever the plan intended, and falls through to the
      // immediate path below.
    }

    const outcome = tier1Immediate({
      model: this.#options.model,
      timeline,
      latencyModel: validatedLatency.value,
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
      feeSnapshot,
    });
    if (!outcome.ok) return { refusal: outcome.refusal };

    // L5: an order that never reached a book (a GTD past its effective expiry)
    // still belongs to an outcome token, and booking it under `""` names no
    // token at all. The identity comes from the recorded timeline, and when the
    // timeline knows no book for this market and side the venue refuses rather
    // than inventing one.
    let tokenId = outcome.value.tokenId;
    if (tokenId === null) {
      const known = timeline.bookAt({
        marketId,
        side: planned.side,
        monotonicNs: this.#options.clock.monotonicNs(),
      });
      tokenId = known?.book.tokenId ?? null;
    }
    if (tokenId === null || !isNonEmptyString(tokenId)) {
      return {
        refusal: simulationRefusal(
          "SIMULATED_VENUE_NO_BOOK",
          "the venue cannot name the outcome token this order was for; the recorded timeline knows no book for the market and side, and an order booked under an empty token id names nothing",
          { marketId, side: planned.side },
        ),
      };
    }

    const disposition = outcome.value.remainderDisposition;
    if (
      planned.executionStyle === "REST" &&
      disposition === "RESTS" &&
      compareDecimal(outcome.value.remainingShares, "0") > 0
    ) {
      const observed = timeline.bookAt({
        marketId,
        side: planned.side,
        monotonicNs: BigInt(outcome.value.matchableAtNs),
      });
      if (observed !== undefined) {
        const registered = this.#rest({
          plan,
          planned,
          marketId,
          tokenId,
          book: observed.book,
          restingFromNs: BigInt(outcome.value.matchableAtNs),
          remainingShares: outcome.value.remainingShares,
          filledShares: outcome.value.filledShares,
          timeInForce,
          statedExpiryNs,
          atEvent: outcome.value.atEvent ?? atEvent,
          feeSnapshot,
          previousFills: outcome.value.fills,
        });
        if (!registered.ok) return { refusal: registered.refusal };
        return registered.value;
      }
    }

    return this.#book({
      plan,
      planned,
      marketId,
      tokenId,
      fills: outcome.value.fills,
      filledShares: outcome.value.filledShares,
      remainingShares: outcome.value.remainingShares,
      atEvent: outcome.value.atEvent ?? atEvent,
      remainderState:
        disposition === "CANCELLED_BY_FAK"
          ? "CANCELLED"
          : disposition === "REJECTED_BY_FOK"
            ? "REJECTED"
            : disposition === "EXPIRED_BEFORE_MATCHING"
              ? "EXPIRED"
              : "RESTS",
      delayedByMarket: outcome.value.delayedByMarket,
      fillEstimateKind: "POINT",
    });
  }

  // --- resting --------------------------------------------------------------

  /**
   * A crossing `postOnly` order is REJECTED, unfilled.
   *
   * `docs/venue/verified-2026-08-24.md` §2.3 / ADR-012 §5.3: `postOnly` applies
   * only to resting limit types, and its whole purpose is that the order never
   * takes. Filling one — which this venue used to do — reports liquidity the
   * venue would have refused to give.
   */
  #rejectCrossingPostOnly(
    plan: ExecutionPlanView,
    planned: PlannedOrderView,
    marketId: string,
    tokenId: string,
    atEvent: RecordedEventIdentity,
  ): { readonly order: SimulatedOrder; readonly fills: readonly SimulatedFill[] } {
    return this.#book({
      plan,
      planned,
      marketId,
      tokenId,
      fills: [],
      filledShares: "0",
      remainingShares: planned.shares,
      atEvent,
      remainderState: "REJECTED",
      fillEstimateKind: "POINT",
    });
  }

  #rest(input: {
    readonly plan: ExecutionPlanView;
    readonly planned: PlannedOrderView;
    readonly marketId: string;
    readonly tokenId: string;
    readonly book: BookView;
    readonly restingFromNs: bigint;
    readonly remainingShares: string;
    readonly filledShares: string;
    readonly timeInForce: TimeInForce;
    readonly statedExpiryNs: bigint | undefined;
    readonly atEvent: RecordedEventIdentity;
    readonly feeSnapshot: FeeScheduleSnapshot;
    readonly previousFills: readonly SimulatedFill[];
  }): SimulationResult<{
    readonly order: SimulatedOrder;
    readonly fills: readonly SimulatedFill[];
    readonly band?: RestingFillBand;
  }> {
    const { planned } = input;
    // §12.2 "estimate quantity ahead at placement": the AGGREGATE size observed
    // at our price, which is a recorded fact (ADR-013), never a queue-position
    // heuristic and never an invented venue ordinal (ADR-012 §5.9, §9.4).
    const ownLadder = input.book.ladder(planned.action === "BUY" ? "BID" : "ASK");
    const queueAhead = sizeAtPrice(ownLadder, planned.limitPrice);
    if (!queueAhead.ok) return queueAhead;
    // KEPT, and now tagged (round-2 review, L4 / MEDIUM-2): the venue validates
    // what its policy answered before the quantity reaches the queue model, and
    // the queue model validates it AGAIN at its own door, because that is where
    // the derivation that depends on it is written down.
    const additions = readSameInstantAdditions(
      this.#options.policy.sameInstantAdditionsFor(planned),
    );
    if (!additions.ok) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        `the execution policy must state what it observed about same-instant additions at our price ("NOT_OBSERVED", or { observedShares }): ${additions.refusal.message}`,
        { plannedOrderId: planned.plannedOrderId },
      );
    }

    const effectiveExpiryNs =
      input.timeInForce === "GTD" && input.statedExpiryNs !== undefined
        ? // ADR-012 §5.2 / venue report §2.3: "GTD orders expire one minute
          // before their stated expiration as a security threshold."
          addMilliseconds(input.statedExpiryNs, -GTD_EARLY_EXPIRY_MS)
        : undefined;

    const record: RestingRecord = {
      simulatedOrderId: planned.plannedOrderId,
      executionPlanId: input.plan.executionPlanId,
      planned,
      marketId: input.marketId,
      tokenId: input.tokenId,
      side: planned.side,
      action: planned.action,
      restingPrice: planned.limitPrice,
      restingFromNs: input.restingFromNs,
      effectiveExpiryNs,
      sameInstantAdditions: additions.value,
      queueAheadAtPlacement: queueAhead.value,
      remainingShares: input.remainingShares,
    };
    this.#resting.set(record.simulatedOrderId, record);

    const isTier1 = this.#options.model.tier === "TIER_1";
    let band: RestingFillBand | undefined;
    if (isTier1) {
      const computed = this.#bandFor(record, input.feeSnapshot);
      if (!computed.ok) {
        this.#resting.delete(record.simulatedOrderId);
        return computed;
      }
      band = computed.value;
      this.#bands.set(record.simulatedOrderId, band);
    }

    const booked = this.#book({
      plan: input.plan,
      planned,
      marketId: input.marketId,
      tokenId: input.tokenId,
      fills: input.previousFills,
      filledShares: input.filledShares,
      remainingShares: input.remainingShares,
      atEvent: input.atEvent,
      remainderState: "RESTS",
      fillEstimateKind: isTier1 ? "TIER_1_RESTING_BAND" : "POINT",
    });
    return simulationOk(band === undefined ? booked : { ...booked, band });
  }

  /** Recomputes one resting order's §12.2 band from the trades observed so far. */
  #bandFor(
    record: RestingRecord,
    feeSnapshot: FeeScheduleSnapshot,
  ): SimulationResult<RestingFillBand> {
    const parameters = this.#options.queueParameters;
    if (parameters === undefined) {
      return simulationFailure(
        "FILL_MODEL_PARAMETERS_UNPINNED",
        "a Tier-1 venue that rests orders needs the §12.2 queue-model parameters, pinned per run (§12.5); without them there is no band and a resting Tier-1 order has no honest estimate",
        { simulatedOrderId: record.simulatedOrderId },
      );
    }
    const read = readQueueModelParameters(parameters);
    if (!read.ok) return read;
    const observed = this.#trades.get(positionKey({ marketId: record.marketId, side: record.side })) ?? [];
    const trades =
      record.effectiveExpiryNs === undefined
        ? observed
        : observed.filter((trade) => trade.monotonicNs < (record.effectiveExpiryNs ?? 0n));
    return simulateResting({
      model: this.#options.model,
      order: {
        simulatedOrderId: record.simulatedOrderId,
        marketId: record.marketId,
        tokenId: record.tokenId,
        side: record.side,
        action: record.action,
        restingPrice: record.restingPrice,
        shares: record.remainingShares,
        queueAheadAtPlacement: record.queueAheadAtPlacement,
        sameInstantAdditions: record.sameInstantAdditions,
        restingFromNs: record.restingFromNs,
      },
      trades,
      parameters: read.value,
      feeSnapshot,
    });
  }

  #observeTradeSync(input: {
    readonly marketId: string;
    readonly side: "YES" | "NO";
    readonly price: string;
    readonly shares: string;
    readonly monotonicNs: bigint;
    readonly atEvent: RecordedEventIdentity;
  }): SimulationResult<{
    readonly fills: readonly SimulatedFill[];
    readonly bands: readonly RestingFillBand[];
  }> {
    if (!isNonEmptyString(input.marketId) || (input.side !== "YES" && input.side !== "NO")) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade names a market and an outcome side",
      );
    }
    if (!isCanonicalDecimalString(input.price) || !isCanonicalDecimalString(input.shares)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade carries canonical decimal price and size (§6 invariant 1)",
        { price: String(input.price), shares: String(input.shares) },
      );
    }
    if (compareDecimal(input.shares, "0") <= 0) {
      return simulationFailure("SIMULATION_INPUT_INVALID", "an observed trade has positive size");
    }
    if (typeof input.monotonicNs !== "bigint" || input.monotonicNs < 0n) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade carries the recorded monotonic nanoseconds of the event that printed it (§7.1)",
      );
    }
    const fees = readFeeScheduleSnapshot(this.#options.feeSnapshot);
    if (!fees.ok) return fees;

    const key = positionKey({ marketId: input.marketId, side: input.side });
    const observed = this.#trades.get(key) ?? [];
    const last = observed[observed.length - 1];
    if (last !== undefined && input.monotonicNs < last.monotonicNs) {
      return simulationFailure(
        "REPLAY_CLOCK_NOT_MONOTONE",
        "an observed trade arrives earlier than one already reported for this market and side; replay follows recorded dispatch order (§8.4, §6 invariant 15) and a queue walk over an unordered list truncates silently",
        {
          marketId: input.marketId,
          previousMonotonicNs: last.monotonicNs.toString(),
          monotonicNs: input.monotonicNs.toString(),
        },
      );
    }
    const trade = ownFrozenTree<ObservedTrade>({
      price: input.price,
      shares: input.shares,
      monotonicNs: input.monotonicNs,
      atEvent: input.atEvent,
    });
    observed.push(trade);
    this.#trades.set(key, observed);

    const produced: SimulatedFill[] = [];
    const updated: RestingFillBand[] = [];
    // Ordered by a value-derived key: two resting orders must be visited in the
    // same order on every replay of the same dataset (§12.4).
    const records = [...this.#resting.values()]
      .filter((record) => record.marketId === input.marketId && record.side === input.side)
      .sort((left, right) => compareStrings(left.simulatedOrderId, right.simulatedOrderId));

    for (const record of records) {
      if (input.monotonicNs < record.restingFromNs) continue;
      if (record.effectiveExpiryNs !== undefined && input.monotonicNs >= record.effectiveExpiryNs) {
        this.#expire(record, input.atEvent);
        continue;
      }
      if (this.#options.model.tier === "TIER_0") {
        const outcome = tier0Maker({
          model: this.#options.model,
          simulatedOrderId: record.simulatedOrderId,
          marketId: record.marketId,
          tokenId: record.tokenId,
          side: record.side,
          action: record.action,
          restingPrice: record.restingPrice,
          remainingShares: record.remainingShares,
          observedTradePrice: input.price,
          feeSnapshot: fees.value,
          atEvent: input.atEvent,
        });
        if (!outcome.ok) return outcome;
        if (outcome.value.trigger === "NONE") continue;
        for (const fill of outcome.value.fills) {
          this.#applyFill(fill);
          this.#fills.push(fill);
          produced.push(fill);
        }
        const existing = this.#orders.get(record.simulatedOrderId);
        if (existing !== undefined) {
          this.#orders.set(
            record.simulatedOrderId,
            ownFrozenTree<SimulatedOrder>({
              ...existing,
              filledShares: addDecimal(existing.filledShares, outcome.value.filledShares),
              state: "FILLED",
              atEvent: input.atEvent,
            }),
          );
        }
        record.remainingShares = outcome.value.remainingShares;
        this.#resting.delete(record.simulatedOrderId);
        continue;
      }
      const band = this.#bandFor(record, fees.value);
      if (!band.ok) return band;
      this.#bands.set(record.simulatedOrderId, band.value);
      updated.push(band.value);
    }

    return simulationOk(ownFrozenTree({ fills: produced, bands: updated }));
  }

  #expire(record: RestingRecord, atEvent: RecordedEventIdentity): void {
    const existing = this.#orders.get(record.simulatedOrderId);
    if (existing !== undefined && existing.state === "RESTING") {
      this.#orders.set(
        record.simulatedOrderId,
        ownFrozenTree<SimulatedOrder>({ ...existing, state: "EXPIRED", atEvent }),
      );
    }
    this.#resting.delete(record.simulatedOrderId);
  }

  #book(input: {
    readonly plan: ExecutionPlanView;
    readonly planned: PlannedOrderView;
    readonly marketId: string;
    readonly tokenId: string;
    readonly fills: readonly SimulatedFill[];
    readonly filledShares: string;
    readonly remainingShares: string;
    readonly atEvent: RecordedEventIdentity;
    readonly remainderState: "RESTS" | "CANCELLED" | "REJECTED" | "EXPIRED";
    readonly fillEstimateKind: SimulatedOrder["fillEstimateKind"];
    readonly delayedByMarket?: boolean;
  }): { readonly order: SimulatedOrder; readonly fills: readonly SimulatedFill[] } {
    for (const fill of input.fills) {
      this.#applyFill(fill);
      this.#fills.push(fill);
    }
    const complete = compareDecimal(input.remainingShares, "0") === 0;
    // ADR-012 §5.1 / venue report §2.2: on a delayed market a marketable order
    // "is accepted but has not matched yet … Treat it as a pending order rather
    // than a fill", so an unfilled order on such a market is DELAYED, not
    // REJECTED and not RESTING.
    const state: SimulatedOrder["state"] =
      input.remainderState === "REJECTED" && compareDecimal(input.filledShares, "0") === 0
        ? "REJECTED"
        : complete
          ? "FILLED"
          : compareDecimal(input.filledShares, "0") > 0
            ? "PARTIALLY_FILLED"
            : input.delayedByMarket === true
              ? "DELAYED"
              : input.remainderState === "RESTS"
                ? "RESTING"
                : input.remainderState;

    const order = ownFrozenTree<SimulatedOrder>({
      simulatedOrderId: input.planned.plannedOrderId,
      plannedOrderId: input.planned.plannedOrderId,
      executionPlanId: input.plan.executionPlanId,
      marketId: input.marketId,
      tokenId: input.tokenId,
      side: input.planned.side,
      action: input.planned.action,
      limitPrice: input.planned.limitPrice,
      requestedShares: input.planned.shares,
      filledShares: input.filledShares,
      state,
      postOnly: input.planned.postOnly,
      executionStyle: input.planned.executionStyle,
      fillEstimateKind: input.fillEstimateKind,
      atEvent: input.atEvent,
    });
    this.#orders.set(order.simulatedOrderId, order);
    return { order, fills: input.fills };
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
      this.#resting.delete(id);
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

/**
 * Whether a planned order would cross the opposing side of the observed book.
 *
 * A BUY crosses when the best ASK is at or below its limit; a SELL crosses when
 * the best BID is at or above it. An empty opposing side cannot be crossed.
 */
function isCrossing(book: BookView, planned: PlannedOrderView): SimulationResult<boolean> {
  const opposing = book.ladder(planned.action === "BUY" ? "ASK" : "BID");
  if (!Array.isArray(opposing)) {
    return simulationFailure(
      "SIMULATED_VENUE_NO_BOOK",
      "the book did not answer with a ladder for the opposing side",
    );
  }
  const best = opposing[0];
  if (best === undefined) return simulationOk(false);
  if (!isCanonicalDecimalString(best.price)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the best opposing level carries a non-canonical price (§6 invariant 1)",
      { offered: String(best.price) },
    );
  }
  return simulationOk(
    planned.action === "BUY"
      ? compareDecimal(best.price, planned.limitPrice) <= 0
      : compareDecimal(best.price, planned.limitPrice) >= 0,
  );
}

/** Validates one planned order before any arithmetic touches it. */
function validatePlannedOrder(planned: PlannedOrderView): SimulationResult<PlannedOrderView> {
  if (planned === null || typeof planned !== "object") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a planned order is a record");
  }
  if (!isNonEmptyString(planned.plannedOrderId)) {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a planned order names itself");
  }
  if (planned.side !== "YES" && planned.side !== "NO") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a planned order's side is YES or NO", {
      plannedOrderId: planned.plannedOrderId,
      offered: String(planned.side),
    });
  }
  if (planned.action !== "BUY" && planned.action !== "SELL") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a planned order's action is BUY or SELL", {
      plannedOrderId: planned.plannedOrderId,
      offered: String(planned.action),
    });
  }
  if (planned.executionStyle !== "REST" && planned.executionStyle !== "MARKETABLE_LIMIT") {
    return simulationFailure(
      "SIMULATED_VENUE_PLAN_UNSUPPORTED",
      "a planned order's execution style is REST or MARKETABLE_LIMIT (WP-190); the venue routes on it and will not guess",
      { plannedOrderId: planned.plannedOrderId, offered: String(planned.executionStyle) },
    );
  }
  if (typeof planned.postOnly !== "boolean") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a planned order states whether it is postOnly",
      { plannedOrderId: planned.plannedOrderId },
    );
  }
  if (!isCanonicalDecimalString(planned.limitPrice) || !isCanonicalDecimalString(planned.shares)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a planned order's limit price and size are canonical decimal strings (§6 invariant 1)",
      {
        plannedOrderId: planned.plannedOrderId,
        limitPrice: String(planned.limitPrice),
        shares: String(planned.shares),
      },
    );
  }
  if (compareDecimal(planned.shares, "0") <= 0) {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a planned order's size is positive", {
      plannedOrderId: planned.plannedOrderId,
    });
  }
  return simulationOk(planned);
}

/**
 * Runs a synchronous venue step, turning an unexpected throw into a refusal.
 *
 * `submit` returns an `ExecutionResult`, not a `SimulationResult`, so ADR-020
 * §6's "no throw escapes" has to be honoured by producing a REFUSED result
 * rather than by rejecting the promise — which is what the round-1 review found
 * it doing.
 */
function totallyResult(
  compute: () => ExecutionResult,
  refuse: (refusal: SimulationRefusal) => ExecutionResult,
): ExecutionResult {
  const outcome = totally("submitting a plan to the simulated venue", () =>
    simulationOk(compute()),
  );
  return outcome.ok ? outcome.value : refuse(outcome.refusal);
}
