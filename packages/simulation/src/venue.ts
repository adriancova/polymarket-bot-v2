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
 * What the immediate path leaves (SIM-1): FILLED when nothing remains; a FAK
 * remainder CANCELLED, keeping what filled (O1); a FOK that cannot fill whole
 * REJECTED with nothing filled, under both tiers (O2); a GTC or GTD remainder
 * REGISTERED to rest at its limit, whatever the planned style (O3). On a
 * delayed market the order is DELAYED — nothing filled — until the recorded
 * clock reaches `matchableAtNs`, when that same disposition applies (O5). So
 * every order this venue holds is TERMINAL or can still change: RESTING and
 * PARTIALLY_FILLED exactly when a resting record exists, DELAYED exactly when
 * a pending disposition does.
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
import { ownFrozenTree, readOwnPlainInput } from "./plain.js";
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
  type NotPlacedOrder,
  type PlacementPlanView,
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
import type { RateLimitBudget, RateLimitDecision } from "./rate-limit.js";
import {
  defineData,
  describeForRefusal,
  plainRecord,
  simulationRefusal,
  totally,
  totallyAsync,
  type SimulationRefusal,
  type SimulationResult,
} from "./refusals.js";
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
 * D-05 (`docs/venue/verified-2026-09-16.md`): "`post_orders` accepts between 1
 * and 15 signed orders per call", and the per-signer bucket admits a batch
 * all-or-nothing (venue report §8). A plan larger than this is several batches.
 * A VENUE FACT with a date; re-verify each phase (§1.2).
 */
const PLACE_BATCH_MAXIMUM_ORDERS = 15;

/** One planned order that passed the whole-plan pre-flight, with the policy's answers. */
interface PreflightedOrder {
  /** The execution group's market, exactly as the group names it. */
  readonly marketId: string;
  readonly planned: PlannedOrderView;
  readonly timeInForce: TimeInForce;
  readonly statedExpiryNs: bigint | undefined;
}

/** A resting registration, staged: it reaches `#resting` / `#bands` only at commit. */
interface StagedRest {
  readonly record: RestingRecord;
  /** The Tier-1 band; `undefined` under Tier 0. */
  readonly band: RestingFillBand | undefined;
}

/** The states an order can be TERMINAL in the moment it executes. */
type TerminalOnArrival = "FILLED" | "CANCELLED" | "REJECTED" | "EXPIRED";

/** What happens to an executed order: it is terminal, or its remainder rests. */
type Disposition =
  | { readonly kind: "TERMINAL"; readonly state: TerminalOnArrival }
  | { readonly kind: "RESTS"; readonly rest: StagedRest };

/**
 * A DELAYED order's already-computed outcome (O5; ADR-012 §5.1, D-18), applied
 * when the venue's recorded clock reaches `matchableAtNs` and not before.
 */
interface PendingDelayed {
  readonly simulatedOrderId: string;
  readonly matchableAtNs: bigint;
  /** Computed at submission against the book at `matchableAtNs`; booked at resolution. */
  readonly fills: readonly SimulatedFill[];
  readonly filledShares: string;
  readonly disposition: Disposition;
}

/**
 * A DELAYED order whose disposition could not be applied at `matchableAtNs`
 * (SIM-1 r1, `SIM1-R1-1`), held until a door that answers for recorded time
 * reports it — see `SimulatedVenue.#reportUnapplied`.
 */
interface UnappliedDisposition {
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly cause: SimulationRefusal;
}

/**
 * One order's execution, STAGED. Staging reads the book, the policy, the
 * model, the observed trades and (Tier 1) draws the seeded latency ONCE; it
 * writes none of the venue's state. `#commit` applies it.
 */
interface StagedOrder {
  readonly order: SimulatedOrder;
  /** Fills booked at commit. Empty for a DELAYED order, whose fills wait. */
  readonly fills: readonly SimulatedFill[];
  readonly rest: StagedRest | undefined;
  readonly pending: PendingDelayed | undefined;
}

/**
 * What one `submit` has done so far — kept OUTSIDE `#submitSync` so the
 * containment path can still report what a plan BOOKED before a throw (`PP-3`).
 */
interface PlacementProgress {
  planId: string;
  /** Every planned order id the plan let the venue read, in plan order, once. */
  plannedIds: readonly string[];
  readonly orders: SimulatedOrder[];
  readonly fills: SimulatedFill[];
  readonly bands: RestingFillBand[];
  readonly notPlaced: NotPlacedOrder[];
  /** The FIRST failure; `undefined` while everything has been placed. */
  cause: SimulationRefusal | undefined;
}

function newProgress(): PlacementProgress {
  return { planId: "", plannedIds: [], orders: [], fills: [], bands: [], notPlaced: [], cause: undefined };
}

function notPlacedFrom(plannedOrderId: string, refusal: SimulationRefusal): NotPlacedOrder {
  return { plannedOrderId, refusalCode: refusal.code, refusalMessage: refusal.message };
}

/**
 * The contained failure's class name a `SIMULATION_INTERNAL` refusal carries
 * in `details.failure` (`refusals.ts`'s `containedFailure`), as a suffix for a
 * refusal message; empty when there is none. Reads own data this package built.
 */
function describeCauseFailure(cause: SimulationRefusal): string {
  const failure: unknown = cause.details["failure"];
  return typeof failure === "string" ? ` [${failure}]` : "";
}

/**
 * A non-terminal order state: the order can still fill, expire, or be
 * cancelled (or, DELAYED, take its disposition). Shared by the market-scoped
 * cancel's targets and the account's open orders, so the two cannot disagree.
 */
function isLiveState(state: SimulatedOrder["state"]): boolean {
  return state === "ACCEPTED" || state === "DELAYED" || state === "RESTING" || state === "PARTIALLY_FILLED";
}

/**
 * Every planned order id a MATERIALIZED placement plan lets the venue read, in
 * plan order, each once — so a refusal can name what it did not place without
 * trusting the plan's shape (which the pre-flight has not validated yet).
 */
function readablePlannedOrderIds(plan: ExecutionPlanView): readonly string[] {
  if (plan.planKind === "CANCEL") return [];
  const groups: unknown = plan.groups;
  if (!Array.isArray(groups)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const group of groups as readonly unknown[]) {
    if (group === null || typeof group !== "object") continue;
    const orders: unknown = (group as { readonly orders?: unknown }).orders;
    if (!Array.isArray(orders)) continue;
    for (const planned of orders as readonly unknown[]) {
      if (planned === null || typeof planned !== "object") continue;
      const id: unknown = (planned as { readonly plannedOrderId?: unknown }).plannedOrderId;
      if (!isNonEmptyString(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
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

/**
 * The materialize policy for the venue doors whose records carry §7.1 instants.
 *
 * `ObservedTrade.monotonicNs` is a `bigint`, so the door that takes one must be
 * able to carry a `bigint` or it could not read a legitimate argument at all.
 * `queue.ts` names the same policy for the same reason; `plain.ts`'s
 * `MaterializePolicy` states why a `bigint` is the ONE primitive this relaxation
 * admits and why it adopts nothing.
 */
const RECORDED_INSTANTS_ARE_BIGINTS = Object.freeze({ bigintIsData: true });

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
  /** O5: DELAYED orders awaiting `matchableAtNs`, by order id. */
  readonly #pending = new Map<string, PendingDelayed>();
  /**
   * `SIM1-R1-1`: DELAYED dispositions that could not be applied, not yet
   * reported. Bounded by the DELAYED orders that failed since the last
   * `observe()` / `observeTrade()` answer, which drains it.
   */
  readonly #unapplied: UnappliedDisposition[] = [];
  #cash: string;
  #atEvent: RecordedEventIdentity | undefined;

  constructor(options: SimulatedVenueOptions) {
    this.#options = options;
    this.#cash = options.startingCash;
  }

  /**
   * Every fill this venue produced, in production order.
   *
   * A FROZEN COPY of the list, not the live one (round-4 review, MEDIUM-2's
   * class-member sweep). The previous version handed out `this.#fills` itself,
   * so a consumer — `runReplay` reads this getter to build the §12.4 bytes —
   * could `push` a fill the venue never produced into the venue's own ledger.
   * Each member is already an `ownFrozenTree`; only the container was live.
   */
  get fills(): readonly SimulatedFill[] {
    return Object.freeze([...this.#fills]);
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
   *
   * D1 (round-4 review, MEDIUM-1). The identity is a CALLER RECORD the venue
   * KEEPS: it is stamped onto every order, every fill and every account snapshot
   * this venue produces afterwards, and printed in the §12.4 bytes. The previous
   * version stored the caller's own object, so mutating `identity.ingestSeq`
   * after the call changed a later snapshot's recorded-event anchor from `"1"` to
   * `"999999"` — an outcome anchored to an event that never happened (§6
   * invariant 15) — and a getter-bearing identity was carried until D4's copier
   * hit it, making `queryAccountState` REJECT its promise. It is materialized
   * here, once, under the WIRE policy: a `RecordedEventIdentity` is four
   * PRIMITIVES (`README.md` §5 item 11 — a `bigint` is data only at the doors
   * whose records carry §7.1 nanoseconds, and this is not one).
   *
   * It ANSWERS now rather than returning `void`, because a refusal a caller
   * cannot see is not a refusal: `replay.ts` stops the run on one.
   *
   * SIM-1: positioning is also where recorded TIME reaches the venue's own
   * bookkeeping. At the venue clock's instant, every DELAYED order whose
   * window has closed takes its already-computed disposition (O5) and every
   * resting GTD order past its effective expiry expires (O4) — see `#sweep`.
   * Both are stamped with the event the venue has just been positioned at.
   *
   * SIM-1 r1 (`SIM1-R1-1`): a DELAYED disposition the venue could not APPLY
   * (its fill accounting failed) leaves that order REJECTED with nothing
   * booked, and this door then answers `ok: false`,
   * `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED`, naming it — AFTER positioning
   * the venue and sweeping everything else, so the venue's state is whole and
   * the caller is told. The answer also carries a failure an earlier cancel's
   * own sweep found and could not report (`#reportUnapplied`).
   */
  observe(identity: RecordedEventIdentity): SimulationResult<null> {
    return totally("positioning the simulated venue at a recorded event", () => {
      const read = readOwnPlainInput<RecordedEventIdentity>(
        identity,
        "the recorded event identity the venue is positioned at",
      );
      if (!read.ok) return read;
      const materialized = read.value;
      if (materialized === null || typeof materialized !== "object") {
        return simulationFailure(
          "SIMULATION_INPUT_INVALID",
          "a recorded event identity is a record (§7.1: gatewayEpoch, ingestSeq, receivedAt, datasetRowOrdinal)",
        );
      }
      const atEvent = ownFrozenTree<RecordedEventIdentity>(materialized);
      this.#atEvent = atEvent;
      this.#sweep(this.#options.clock.monotonicNs(), atEvent);
      return this.#reportUnapplied() ?? simulationOk(null);
    });
  }

  /**
   * Reports one OBSERVED trade to the venue's resting orders.
   *
   * This is how a resting order fills: §12.2 Tier 0 "maker orders fill on
   * touch/trade-through", and Tier 1 "decrement according to observed trades".
   * The trade is a recorded fact handed over by the run driver — the venue
   * neither reads a feed nor decides what a trade is.
   *
   * D1 (round-4 review, MEDIUM-1): the whole argument is materialized before
   * anything is validated or computed — see {@link SimulatedVenue.#observeTradeSync}
   * for exactly what that closed.
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

  /**
   * Submits one plan (§12.1). NEVER rejects: it answers a REFUSED result.
   *
   * D1 (round-4 review, MEDIUM-2's class-member sweep). The plan is a caller
   * DATA record — an id, a run mode, groups of planned orders, all primitives —
   * and it was read RAW. Measured at `d56e707`: a `limitPrice` accessor
   * answering `"0.5"` for `validatePlannedOrder` and `"0.99"` afterwards was
   * ACCEPTED, and the venue booked an order printing `limit=0.99` with a fill it
   * had never validated the price of (the plan's `limitPrice` was read four
   * times); and an `executionPlanId` accessor that THREW made `submit` REJECT
   * its promise, out of the one method in this class whose documented bound is
   * that it never does — because `#refuse` read the caller's plan again on the
   * refusal path, OUTSIDE the totality guard.
   *
   * So: the plan is materialized first, `#refuse` takes an already-read id
   * rather than the plan, and a plan that is not data is refused
   * `SIMULATION_INPUT_NOT_DATA` under an id of `""` — a plan whose id cannot be
   * read as data has no id this venue may quote.
   *
   * SIM-1, the user's ruling R3 — PER-ORDER RESULTS. A placement plan is
   * pre-flighted whole (nothing booked, no token spent, when it fails), then
   * admitted per batch of at most 15 orders all-or-nothing, and every order
   * that was booked is REPORTED, whatever happened to the rest: a plan that
   * books some orders and not others answers `accepted: false`,
   * `outcome: "PARTIAL"`, the booked orders (with their fills and bands) in
   * `orders`/`fills`/`bands`, and every other planned order in `notPlaced`
   * with its own refusal. That includes the containment path: a throw after
   * booking started still reports what was booked (`PP-3`).
   */
  async submit(plan: ExecutionPlanView): Promise<ExecutionResult> {
    const progress = newProgress();
    return await Promise.resolve(
      totallyResult(
        () => this.#submitSync(plan, progress),
        (refusal) => this.#refuseInProgress(progress, refusal),
      ),
    );
  }

  /**
   * Submits several plans in §6 invariant 13 order.
   *
   * `SAFETY_CANCEL` plans are scheduled ahead of `PLACEMENT` plans by WP-190's
   * own rank, and ties keep their given order (a stable sort), so the schedule
   * is deterministic for a fixed input.
   *
   * Its own read of the caller's plans is the PRIORITY, taken exactly once per
   * plan through a total guard (round-4 review, MEDIUM-2's class-member sweep).
   * A priority that cannot be read is not a credible `SAFETY_CANCEL`, so such a
   * plan schedules LAST and `submit` — which materializes it — refuses it; a
   * throwing accessor no longer escapes this method as a rejected promise.
   */
  async submitAll(plans: readonly ExecutionPlanView[]): Promise<readonly ExecutionResult[]> {
    const contained = await totallyAsync(
      "submitting a batch of plans to the simulated venue",
      async () => simulationOk(await this.#submitAllInner(plans)),
    );
    return contained.ok ? contained.value : Object.freeze([this.#refuse("", contained.refusal)]);
  }

  async #submitAllInner(
    plans: readonly ExecutionPlanView[],
  ): Promise<readonly ExecutionResult[]> {
    const offered = Array.isArray(plans) ? plans : [];
    const indexed = offered.map((plan, index) => ({
      plan,
      index,
      // ONE read of the caller's plan, contained: `undefined` when it could not
      // be read at all, which sorts after both real priorities.
      priority: readPlanPriority(plan),
    }));
    indexed.sort((left, right) => {
      const byPriority = comparePriorityOrUnknown(left.priority, right.priority);
      return byPriority !== 0 ? byPriority : left.index - right.index;
    });
    const results: ExecutionResult[] = [];
    for (const entry of indexed) {
      results.push(await this.submit(entry.plan));
    }
    // FROZEN: each result is already an `ownFrozenTree`; the list around them is
    // this venue's answer too, and a consumer that could splice a result into it
    // could report a submission this venue never made.
    return Object.freeze(results);
  }

  /**
   * Cancels (§12.1, §6 invariant 13). NEVER rejects.
   *
   * D1 and totality (round-4 review, MEDIUM-1 / MEDIUM-2): the command is a
   * caller DATA record (an id, a reason, a scope of ids), so it is materialized
   * before anything is read, and the whole step sits inside a totality guard. A
   * `scope` accessor that threw used to REJECT this promise. `CancelResult`
   * carries no refusal field, so a refusal is reported the way §6 invariant 13
   * requires the privileged path to report one: nothing cancelled, and the
   * reason travelling with the result in `notCancelled`.
   */
  async cancel(command: CancelCommand): Promise<CancelResult> {
    const contained = totally("cancelling at the simulated venue", () => {
      const read = readOwnPlainInput<CancelCommand>(command, "the cancel command");
      if (!read.ok) return read;
      const materialized = read.value;
      if (materialized === null || typeof materialized !== "object") {
        return simulationFailure<CancelResult>(
          "SIMULATION_INPUT_INVALID",
          "a cancel command is a record carrying an execution plan id, a reason and a scope",
        );
      }
      return simulationOk(this.#cancelSync(materialized));
    });
    return await Promise.resolve(
      contained.ok ? contained.value : refusedCancel(contained.refusal),
    );
  }

  /**
   * The simulated account state (§12.1). NEVER rejects.
   *
   * Round-4 review MEDIUM-1: this method REJECTED its promise with
   * `NotOwnPlainDataError` whenever the venue had been positioned at a
   * getter-bearing identity, because D4's copier met the caller's accessor while
   * emitting the snapshot. `observe` now materializes that identity, so THAT
   * ingress is closed — and the guard below is not decoration, because one
   * caller-supplied value still reaches the copier without a door in front of
   * it: `SimulatedVenueOptions.startingCash` is typed `string` but is whatever
   * the composition root constructed the venue with. `submit` refuses a
   * non-canonical balance by name (§6 invariant 1); this method has no refusal
   * channel to do that in, so it CONTAINS instead.
   *
   * `AccountSnapshot` is a §12.1 shape and carries no refusal field, so the
   * contained branch answers a snapshot that CANNOT be mistaken for a real one:
   * its `cashBalance` is not a decimal string, so every consumer's §6 invariant
   * 1 door refuses it rather than reading a fabricated balance, and its
   * positions and open orders are empty rather than partial. `README.md` §5
   * item 12 discloses it.
   */
  async queryAccountState(): Promise<AccountSnapshot> {
    const contained = totally("querying the simulated account state", () =>
      simulationOk(this.#accountSync()),
    );
    return await Promise.resolve(contained.ok ? contained.value : unreadableAccount());
  }

  // -------------------------------------------------------------------------

  /**
   * A refusal that booked NOTHING (R3's fully refused shape).
   *
   * `notPlaced` names every planned order the caller's plan let this venue
   * read, each with the refusal, so a consumer never has to infer "nothing
   * was placed" from an empty list. A plan whose orders cannot be read at all
   * (not data, no groups) is refused with `notPlaced: []`.
   */
  #refuse(
    executionPlanId: string,
    refusal: SimulationRefusal,
    notPlaced: readonly NotPlacedOrder[] = [],
  ): ExecutionResult {
    return ownFrozenTree<ExecutionResult>({
      executionPlanId: typeof executionPlanId === "string" ? executionPlanId : "",
      accepted: false,
      outcome: "REFUSED",
      orders: [],
      fills: [],
      bands: [],
      notCancelled: [],
      notPlaced,
      rateLimitModel: this.#options.rateLimits.modelKind,
      rateLimitDisclosure: this.#options.rateLimits.disclosure,
      refusalCode: refusal.code,
      refusalMessage: refusal.message,
      venueClass: "SIMULATED",
      planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
    });
  }

  /**
   * A placement plan's answer (R3), from what was BOOKED and what was NOT.
   *
   * - nothing refused: `accepted: true`, `outcome: "ACCEPTED"`;
   * - something booked and something refused: `accepted: false`,
   *   `outcome: "PARTIAL"`, `orders`/`fills`/`bands` list what WAS booked (it
   *   is working or done at this venue, and cash and positions already moved
   *   for its fills), `notPlaced` lists the rest, each with its own refusal;
   * - nothing booked: `accepted: false`, `outcome: "REFUSED"`.
   *
   * `refusalCode` is the FIRST failure's code — the cause — so a consumer that
   * reads only the code keeps reading the same codes a whole refusal always
   * carried.
   */
  #placementResult(progress: PlacementProgress): ExecutionResult {
    const cause = progress.cause;
    if (cause === undefined && progress.notPlaced.length === 0) {
      return ownFrozenTree<ExecutionResult>({
        executionPlanId: progress.planId,
        accepted: true,
        outcome: "ACCEPTED",
        orders: progress.orders,
        fills: progress.fills,
        bands: progress.bands,
        notCancelled: [],
        notPlaced: [],
        rateLimitModel: this.#options.rateLimits.modelKind,
        rateLimitDisclosure: this.#options.rateLimits.disclosure,
        venueClass: "SIMULATED",
        planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
      });
    }
    // Every path that lists a planned order as not placed records the cause
    // first; the fallback is the first listed refusal, never an invented one.
    const first = progress.notPlaced[0];
    const code = cause?.code ?? first?.refusalCode ?? "SIMULATION_INTERNAL";
    const message = cause?.message ?? first?.refusalMessage ?? "the plan was not fully placed";
    const partial = progress.orders.length > 0;
    return ownFrozenTree<ExecutionResult>({
      executionPlanId: progress.planId,
      accepted: false,
      outcome: partial ? "PARTIAL" : "REFUSED",
      orders: progress.orders,
      fills: progress.fills,
      bands: progress.bands,
      notCancelled: [],
      notPlaced: progress.notPlaced,
      rateLimitModel: this.#options.rateLimits.modelKind,
      rateLimitDisclosure: this.#options.rateLimits.disclosure,
      refusalCode: code,
      refusalMessage: partial
        ? `${String(progress.orders.length)} of ${String(progress.orders.length + progress.notPlaced.length)} planned order(s) were BOOKED and are listed in orders; the rest were not placed and are listed in notPlaced (R3). First failure: ${message}`
        : message,
      venueClass: "SIMULATED",
      planningDepthAwareness: PLANNING_DEPTH_AWARENESS,
    });
  }

  /**
   * The containment answer for a throw that escaped `#submitSync` (`PP-3`).
   *
   * Everything the plan had BOOKED before the throw is still listed — the
   * orders are in this venue's book and their fills already moved cash — and
   * every planned order not booked is listed as not placed with the contained
   * refusal. A throw before the plan could be read keeps the old shape: an
   * empty refusal under the id `""`.
   */
  #refuseInProgress(progress: PlacementProgress, refusal: SimulationRefusal): ExecutionResult {
    const listed = new Set<string>(progress.notPlaced.map((entry) => entry.plannedOrderId));
    for (const order of progress.orders) listed.add(order.plannedOrderId);
    for (const plannedOrderId of progress.plannedIds) {
      if (listed.has(plannedOrderId)) continue;
      listed.add(plannedOrderId);
      progress.notPlaced.push(notPlacedFrom(plannedOrderId, refusal));
    }
    if (progress.cause === undefined) progress.cause = refusal;
    if (progress.orders.length === 0) {
      return this.#refuse(progress.planId, refusal, progress.notPlaced);
    }
    return this.#placementResult(progress);
  }

  #submitSync(offered: ExecutionPlanView, progress: PlacementProgress): ExecutionResult {
    // D1 FIRST: see {@link SimulatedVenue.submit}. Everything below reads the
    // MATERIALIZED plan, so the order this venue books is the order it validated.
    const read = readOwnPlainInput<ExecutionPlanView>(offered, "the execution plan");
    if (!read.ok) return this.#refuse("", read.refusal);
    const plan = read.value;
    if (plan === null || typeof plan !== "object") {
      return this.#refuse("", simulationRefusal("SIMULATION_INPUT_INVALID", "a plan is a record"));
    }
    // Read ONCE, from the materialized tree, so every refusal below quotes the
    // same id the accepted result would have carried.
    const planId: string = typeof plan.executionPlanId === "string" ? plan.executionPlanId : "";
    progress.planId = planId;
    progress.plannedIds = readablePlannedOrderIds(plan);
    const refuseWhole = (refusal: SimulationRefusal): ExecutionResult =>
      this.#refuse(
        planId,
        refusal,
        progress.plannedIds.map((plannedOrderId) => notPlacedFrom(plannedOrderId, refusal)),
      );
    if (!(SIMULATED_RUN_MODES as readonly string[]).includes(plan.runMode)) {
      return refuseWhole(
        simulationRefusal(
          "SIMULATED_VENUE_RUN_MODE_REQUIRES_LIVE_SIGNER",
          `run mode ${String(plan.runMode)} requires a live signer and real orders (§11); a simulated venue may not serve it`,
          { runMode: String(plan.runMode) },
        ),
      );
    }
    if (plan.runMode !== this.#options.runMode) {
      return refuseWhole(
        simulationRefusal(
          "SIMULATED_VENUE_PLAN_UNSUPPORTED",
          `this venue serves ${this.#options.runMode} and the plan names ${plan.runMode}`,
          { venueRunMode: this.#options.runMode, planRunMode: plan.runMode },
        ),
      );
    }
    if (!isCanonicalDecimalString(this.#cash)) {
      return refuseWhole(
        simulationRefusal(
          "SIMULATION_INPUT_INVALID",
          "the venue's cash balance is not a canonical decimal string; every economic value it books is exact (§6 invariant 1)",
          { cashBalance: String(this.#cash) },
        ),
      );
    }
    const fees = readFeeScheduleSnapshot(this.#options.feeSnapshot);
    if (!fees.ok) return refuseWhole(fees.refusal);
    const atEvent = this.#atEvent;
    if (atEvent === undefined) {
      return refuseWhole(
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
        outcome: !failed ? "ACCEPTED" : result.cancelled.length > 0 ? "PARTIAL" : "REFUSED",
        orders: result.cancelled
          .map((id) => this.#orders.get(id))
          .filter((order): order is SimulatedOrder => order !== undefined),
        fills: [],
        bands: [],
        notCancelled: result.notCancelled,
        notPlaced: [],
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

    // --- R3 (1): the whole plan's LOCAL checks, before anything is booked ----
    //
    // Everything a live OMS can decide without the venue — the plan's shape,
    // every planned order's own validity, duplicate ids (within the plan and
    // against this venue's book), and the order type the policy states — is
    // decided for the WHOLE plan first. A plan that fails here spends no rate-
    // limit token and books nothing: nothing of it was ever sent.
    const preflight = this.#preflight(plan);
    if (!preflight.ok) {
      const failedAt = preflight.failedAt;
      const refusal = preflight.refusal;
      return this.#refuse(
        planId,
        refusal,
        progress.plannedIds.map((plannedOrderId) =>
          plannedOrderId === failedAt
            ? notPlacedFrom(plannedOrderId, refusal)
            : notPlacedFrom(
                plannedOrderId,
                simulationRefusal(
                  "SIMULATED_VENUE_ORDER_NOT_SUBMITTED",
                  `the plan failed its pre-flight check (${refusal.code}${failedAt === undefined ? "" : ` at planned order ${failedAt}`}), so none of its orders was sent: ${refusal.message}`,
                  { cause: refusal.code },
                ),
              ),
        ),
      );
    }

    // --- R3 (2): admission per BATCH of at most 15, all-or-nothing ----------
    //
    // D-05: `POST /orders` accepts 1 to 15 signed orders; the per-signer
    // bucket admits a batch "only when the bucket contains enough tokens for
    // every entry. Otherwise, the entire request is rejected and no entries are
    // processed" (venue report §8; ADR-012 §5.6: the simulator applies the same
    // budget model). So the plan is cut into batches in plan order and each
    // batch is admitted with ONE `admit(count)`.
    //
    // Inside an admitted batch every entry executes on its own — the venue's
    // batch response is per entry — so a failed entry refuses that entry only.
    // Once a batch had a failure (or was refused), the LATER batches are not
    // sent. That stop is this simulator's choice for a plan it cannot finish,
    // not a venue fact, and README §5 item 13 discloses it.
    for (let start = 0; start < preflight.entries.length; start += PLACE_BATCH_MAXIMUM_ORDERS) {
      const batch = preflight.entries.slice(start, start + PLACE_BATCH_MAXIMUM_ORDERS);
      const cause = progress.cause;
      if (cause !== undefined) {
        for (const entry of batch) {
          progress.notPlaced.push(
            notPlacedFrom(
              entry.planned.plannedOrderId,
              simulationRefusal(
                "SIMULATED_VENUE_ORDER_NOT_SUBMITTED",
                `not sent: an earlier batch of this plan failed (${cause.code}), and the venue sends no later batch of a plan it could not place whole`,
                { cause: cause.code },
              ),
            ),
          );
        }
        continue;
      }
      const admitted = totally("admitting a batch against the rate-limit budget", () =>
        simulationOk(
          this.#options.rateLimits.admit({
            kind: "PLACE",
            priority: "PLACEMENT",
            count: batch.length,
            atNs: this.#options.clock.monotonicNs(),
          }),
        ),
      );
      if (!admitted.ok || !admitted.value.admitted) {
        const refusal = !admitted.ok
          ? admitted.refusal
          : simulationRefusal(
              "SIMULATED_VENUE_RATE_LIMITED",
              admitted.value.reason ??
                "the rate-limit budget refused the placement (§9.13, ADR-012 §5.6)",
              { batchSize: batch.length, firstPlannedOrderId: batch[0]?.planned.plannedOrderId ?? "" },
            );
        for (const entry of batch) {
          progress.notPlaced.push(notPlacedFrom(entry.planned.plannedOrderId, refusal));
        }
        progress.cause = refusal;
        continue;
      }
      let batchFailure: SimulationRefusal | undefined;
      for (const entry of batch) {
        // STAGE, then COMMIT. Nothing a stage does touches this venue's book,
        // cash, positions or resting set, so a refusal OR a throw while
        // staging one order (contained here, per order: `PP-3`, `PP-17`)
        // leaves no trace of it, and the orders already committed stand.
        const staged = totally("executing one planned order at the simulated venue", () =>
          this.#stageOne(plan, entry, atEvent, fees.value),
        );
        if (!staged.ok) {
          progress.notPlaced.push(notPlacedFrom(entry.planned.plannedOrderId, staged.refusal));
          batchFailure ??= staged.refusal;
          continue;
        }
        this.#commit(staged.value);
        progress.orders.push(staged.value.order);
        for (const fill of staged.value.fills) progress.fills.push(fill);
        const band = staged.value.rest?.band;
        if (band !== undefined) progress.bands.push(band);
      }
      if (batchFailure !== undefined) progress.cause = batchFailure;
    }

    return this.#placementResult(progress);
  }

  /**
   * R3's pre-flight: the whole plan's LOCAL checks, in plan order.
   *
   * Reads the execution policy ONCE per planned order (its time-in-force and
   * its stated expiry) and hands both to the execution step, so a policy is
   * never asked the same question twice for one submission. A policy that
   * THROWS is contained here, per order: the plan fails pre-flight and nothing
   * is booked.
   */
  #preflight(
    plan: PlacementPlanView,
  ):
    | { readonly ok: true; readonly entries: readonly PreflightedOrder[] }
    | { readonly ok: false; readonly refusal: SimulationRefusal; readonly failedAt?: string } {
    if (!Array.isArray(plan.groups)) {
      return {
        ok: false,
        refusal: simulationRefusal("SIMULATION_INPUT_INVALID", "a placement plan carries execution groups"),
      };
    }
    const entries: PreflightedOrder[] = [];
    const inPlan = new Set<string>();
    for (const group of plan.groups) {
      if (group === null || typeof group !== "object" || !Array.isArray(group.orders)) {
        return {
          ok: false,
          refusal: simulationRefusal("SIMULATION_INPUT_INVALID", "an execution group carries planned orders"),
        };
      }
      for (const planned of group.orders) {
        const validated = validatePlannedOrder(planned);
        if (!validated.ok) {
          const named: unknown =
            planned !== null && typeof planned === "object" ? planned.plannedOrderId : undefined;
          return {
            ok: false,
            refusal: validated.refusal,
            ...(isNonEmptyString(named) ? { failedAt: named } : {}),
          };
        }
        const plannedOrderId = planned.plannedOrderId;
        if (inPlan.has(plannedOrderId) || this.#orders.has(plannedOrderId)) {
          return {
            ok: false,
            failedAt: plannedOrderId,
            refusal: simulationRefusal(
              "SIMULATED_VENUE_DUPLICATE_ORDER",
              "a planned order id was submitted twice; §6 invariant 6 makes an unknown submission a reconciliation question, never a silent retry",
              { plannedOrderId },
            ),
          };
        }
        inPlan.add(plannedOrderId);
        const policy = totally("reading the execution policy for one planned order", () =>
          simulationOk(this.#policyFor(planned)),
        );
        if (!policy.ok) return { ok: false, failedAt: plannedOrderId, refusal: policy.refusal };
        if ("refusal" in policy.value) {
          return { ok: false, failedAt: plannedOrderId, refusal: policy.value.refusal };
        }
        entries.push({
          marketId: group.marketId,
          planned,
          timeInForce: policy.value.timeInForce,
          statedExpiryNs: policy.value.statedExpiryNs,
        });
      }
    }
    return { ok: true, entries };
  }

  /** The order-type checks a live OMS makes before it sends anything. */
  #policyFor(
    planned: PlannedOrderView,
  ):
    | { readonly timeInForce: TimeInForce; readonly statedExpiryNs: bigint | undefined }
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
    return { timeInForce, statedExpiryNs: typeof statedExpiryNs === "bigint" ? statedExpiryNs : undefined };
  }

  /** Stages one pre-flighted order under the venue's tier. Touches no venue state. */
  #stageOne(
    plan: PlacementPlanView,
    entry: PreflightedOrder,
    atEvent: RecordedEventIdentity,
    feeSnapshot: FeeScheduleSnapshot,
  ): SimulationResult<StagedOrder> {
    return this.#options.model.tier === "TIER_0"
      ? this.#stageTier0(plan, entry, atEvent, feeSnapshot)
      : this.#stageTier1(plan, entry, atEvent, feeSnapshot);
  }

  // --- Tier 0 ---------------------------------------------------------------

  #stageTier0(
    plan: PlacementPlanView,
    entry: PreflightedOrder,
    atEvent: RecordedEventIdentity,
    feeSnapshot: FeeScheduleSnapshot,
  ): SimulationResult<StagedOrder> {
    const { planned, marketId, timeInForce, statedExpiryNs } = entry;
    const books = this.#options.books;
    if (books === undefined) {
      return simulationFailure(
        "SIMULATED_VENUE_PLAN_UNSUPPORTED",
        "a Tier-0 venue needs a book provider",
      );
    }
    const book = books.book({ marketId, side: planned.side });
    if (book === undefined) {
      return simulationFailure(
        "SIMULATED_VENUE_NO_BOOK",
        "no book state exists for the market and side the plan names; §6 invariant 12 refuses to act on unknown book state",
        { marketId, side: planned.side },
      );
    }

    const crossing = isCrossing(book, planned);
    if (!crossing.ok) return crossing;

    if (planned.executionStyle === "REST" && crossing.value && planned.postOnly) {
      return simulationOk(
        this.#stagedImmediate({
          plan,
          planned,
          marketId,
          tokenId: book.tokenId,
          fills: [],
          filledShares: "0",
          state: "REJECTED",
          atEvent,
        }),
      );
    }

    const restingFromNs = this.#options.clock.monotonicNs();
    if (planned.executionStyle === "REST" && !crossing.value) {
      const rest = this.#stageRest({
        plan,
        planned,
        marketId,
        tokenId: book.tokenId,
        book,
        restingFromNs,
        remainingShares: planned.shares,
        timeInForce,
        statedExpiryNs,
        feeSnapshot,
      });
      if (!rest.ok) return rest;
      return simulationOk(
        this.#stagedResting({ plan, planned, marketId, tokenId: book.tokenId, filledShares: "0", fills: [], rest: rest.value, atEvent }),
      );
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
    if (!outcome.ok) return outcome;
    const { fills, filledShares, remainingShares } = outcome.value;
    if (compareDecimal(remainingShares, "0") === 0) {
      return simulationOk(
        this.#stagedImmediate({ plan, planned, marketId, tokenId: book.tokenId, fills, filledShares, state: "FILLED", atEvent }),
      );
    }
    if (timeInForce === "FOK") {
      // O2 (`TERM-G`). FOK "Fills the entire order immediately or does not
      // fill any of it" (venue report §2.3; ADR-012 §5.3) — the same rule
      // `tier1Immediate` applies. The depth this order consumed is NOT booked:
      // no fill, no cash, no position, and the order is REJECTED with nothing
      // filled.
      return simulationOk(
        this.#stagedImmediate({ plan, planned, marketId, tokenId: book.tokenId, fills: [], filledShares: "0", state: "REJECTED", atEvent }),
      );
    }
    if (timeInForce === "FAK") {
      // O1 (`TERM-A`). FAK "Fills against the available liquidity immediately
      // and cancels any unfilled remainder" (venue report §2.3): the order is
      // TERMINAL — CANCELLED — and keeps the size it did fill. It used to be
      // left PARTIALLY_FILLED, which nothing ever moved again.
      return simulationOk(
        this.#stagedImmediate({ plan, planned, marketId, tokenId: book.tokenId, fills, filledShares, state: "CANCELLED", atEvent }),
      );
    }
    // O3 (`TERM-B`). A GTC or GTD remainder "remains active until it fills or
    // you cancel it" (GTD: until its expiration) — whatever the planned style.
    // It is REGISTERED to rest at its limit price, so it can fill from later
    // observed trades and can expire. Under Tier 0 a registered remainder fills
    // exactly as a REST order does (`tier0Maker`): on the first observed trade
    // at or through its limit, its WHOLE remaining size fills at the limit
    // price as a MAKER fill (maker fee from the snapshot), and the order becomes
    // FILLED with `filledShares` = what it took on arrival + that remainder.
    const rest = this.#stageRest({
      plan,
      planned,
      marketId,
      tokenId: book.tokenId,
      book,
      restingFromNs,
      remainingShares,
      timeInForce,
      statedExpiryNs,
      feeSnapshot,
    });
    if (!rest.ok) return rest;
    return simulationOk(
      this.#stagedResting({ plan, planned, marketId, tokenId: book.tokenId, filledShares, fills, rest: rest.value, atEvent }),
    );
  }

  // --- Tier 1 ---------------------------------------------------------------

  #stageTier1(
    plan: PlacementPlanView,
    entry: PreflightedOrder,
    atEvent: RecordedEventIdentity,
    feeSnapshot: FeeScheduleSnapshot,
  ): SimulationResult<StagedOrder> {
    const { planned, marketId, timeInForce, statedExpiryNs } = entry;
    const timeline = this.#options.timeline;
    const latencyModel = this.#options.latencyModel;
    const streams = this.#options.streams;
    const marketParameters = this.#options.marketParameters;
    if (timeline === undefined || latencyModel === undefined || streams === undefined || marketParameters === undefined) {
      return simulationFailure(
        "SIMULATED_VENUE_PLAN_UNSUPPORTED",
        "a Tier-1 venue needs a depth timeline, a latency model, seeded streams, and versioned market parameters",
      );
    }
    const market = marketParameters(marketId);
    if (market === undefined) {
      return simulationFailure(
        "SIMULATED_VENUE_PLAN_UNSUPPORTED",
        "no versioned market parameters are known for the instant being replayed; §6 invariant 9 requires historical runs to use historical parameters",
        { marketId },
      );
    }
    // Validated on the execution path, not merely offered: an empty distribution
    // must refuse here exactly as `readLatencyModel` intends, or "no latency
    // data" silently becomes "no latency" (round-1 review M6).
    const validatedLatency = readLatencyModel(latencyModel);
    if (!validatedLatency.ok) return validatedLatency;

    if (planned.executionStyle === "REST") {
      const latency = sampleLatency(validatedLatency.value, streams);
      const restingFromNs = addMilliseconds(this.#options.clock.monotonicNs(), latency.totalMs);
      const observed = timeline.bookAt({
        marketId,
        side: planned.side,
        monotonicNs: restingFromNs,
      });
      if (observed === undefined) {
        return simulationFailure(
          "SIMULATED_VENUE_NO_BOOK",
          "no recorded book state is known at the instant the order would rest; §6 invariant 12 refuses to act on unknown book state rather than resting against a stale one",
          { marketId, restingFromNs: restingFromNs.toString() },
        );
      }
      const crossing = isCrossing(observed.book, planned);
      if (!crossing.ok) return crossing;
      if (crossing.value && planned.postOnly) {
        return simulationOk(
          this.#stagedImmediate({
            plan,
            planned,
            marketId,
            tokenId: observed.book.tokenId,
            fills: [],
            filledShares: "0",
            state: "REJECTED",
            atEvent: observed.atEvent,
          }),
        );
      }
      if (!crossing.value) {
        const rest = this.#stageRest({
          plan,
          planned,
          marketId,
          tokenId: observed.book.tokenId,
          book: observed.book,
          restingFromNs,
          remainingShares: planned.shares,
          timeInForce,
          statedExpiryNs,
          feeSnapshot,
        });
        if (!rest.ok) return rest;
        return simulationOk(
          this.#stagedResting({
            plan,
            planned,
            marketId,
            tokenId: observed.book.tokenId,
            filledShares: "0",
            fills: [],
            rest: rest.value,
            atEvent: observed.atEvent,
          }),
        );
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
    if (!outcome.ok) return outcome;

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
      return simulationFailure(
        "SIMULATED_VENUE_NO_BOOK",
        "the venue cannot name the outcome token this order was for; the recorded timeline knows no book for the market and side, and an order booked under an empty token id names nothing",
        { marketId, side: planned.side },
      );
    }

    const executedAt = outcome.value.atEvent ?? atEvent;
    const matchableAtNs = BigInt(outcome.value.matchableAtNs);
    const disposition = outcome.value.remainderDisposition;
    const terminalState: TerminalOnArrival | undefined =
      disposition === "CANCELLED_BY_FAK"
        ? "CANCELLED"
        : disposition === "REJECTED_BY_FOK"
          ? "REJECTED"
          : disposition === "EXPIRED_BEFORE_MATCHING"
            ? "EXPIRED"
            : disposition === "RESTS" && compareDecimal(outcome.value.remainingShares, "0") > 0
              ? undefined
              : "FILLED";

    // O3: a GTC/GTD remainder rests at the instant it could match, whatever
    // the planned style (it used to rest only for a REST order).
    let settled: Disposition;
    if (terminalState === undefined) {
      const observed = timeline.bookAt({ marketId, side: planned.side, monotonicNs: matchableAtNs });
      if (observed === undefined) {
        return simulationFailure(
          "SIMULATED_VENUE_NO_BOOK",
          "no recorded book state is known at the instant the order's remainder would rest; §6 invariant 12 refuses to rest it against an unknown book",
          { marketId, matchableAtNs: matchableAtNs.toString() },
        );
      }
      const staged = this.#stageRest({
        plan,
        planned,
        marketId,
        tokenId,
        book: observed.book,
        restingFromNs: matchableAtNs,
        remainingShares: outcome.value.remainingShares,
        timeInForce,
        statedExpiryNs,
        feeSnapshot,
      });
      if (!staged.ok) return staged;
      settled = { kind: "RESTS", rest: staged.value };
    } else {
      settled = { kind: "TERMINAL", state: terminalState };
    }

    if (!outcome.value.delayedByMarket) {
      return simulationOk(
        settled.kind === "RESTS"
          ? this.#stagedResting({
              plan,
              planned,
              marketId,
              tokenId,
              filledShares: outcome.value.filledShares,
              fills: outcome.value.fills,
              rest: settled.rest,
              atEvent: executedAt,
            })
          : this.#stagedImmediate({
              plan,
              planned,
              marketId,
              tokenId,
              fills: outcome.value.fills,
              filledShares: outcome.value.filledShares,
              state: settled.state,
              atEvent: executedAt,
            }),
      );
    }

    // O5 (`TERM-D`), ADR-012 §5.1 / D-18: on a delayed market a marketable
    // order "is accepted but has not matched yet … no fills exist yet. Treat it
    // as a pending order rather than a fill". It is booked DELAYED with NOTHING
    // filled and NO fill applied, and its already-computed disposition waits
    // in `#pending` until this venue's clock reaches `matchableAtNs`
    // (`#sweep`): only then are its fills booked and its remainder settled
    // (CANCELLED for FAK, REJECTED for FOK, EXPIRED for a GTD past expiry,
    // registered to rest for GTC/GTD). Its state is anchored to the event it
    // was SUBMITTED at, not to the later book it will execute against.
    const delayed = this.#orderRecord({
      plan,
      planned,
      marketId,
      tokenId,
      filledShares: "0",
      state: "DELAYED",
      fillEstimateKind: "POINT",
      atEvent,
    });
    return simulationOk({
      order: delayed,
      fills: [],
      rest: undefined,
      pending: {
        simulatedOrderId: delayed.simulatedOrderId,
        matchableAtNs,
        fills: outcome.value.fills,
        filledShares: outcome.value.filledShares,
        disposition: settled,
      },
    });
  }

  // --- staged records ---------------------------------------------------------

  #orderRecord(input: {
    readonly plan: PlacementPlanView;
    readonly planned: PlannedOrderView;
    readonly marketId: string;
    readonly tokenId: string;
    readonly filledShares: string;
    readonly state: SimulatedOrder["state"];
    readonly fillEstimateKind: SimulatedOrder["fillEstimateKind"];
    readonly atEvent: RecordedEventIdentity;
  }): SimulatedOrder {
    return ownFrozenTree<SimulatedOrder>({
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
      state: input.state,
      postOnly: input.planned.postOnly,
      executionStyle: input.planned.executionStyle,
      fillEstimateKind: input.fillEstimateKind,
      atEvent: input.atEvent,
    });
  }

  /**
   * An order that is TERMINAL the moment it is booked: FILLED, CANCELLED (a
   * FAK remainder, keeping what it filled), REJECTED (a crossing postOnly, or
   * a FOK that could not fill whole — nothing filled), or EXPIRED (a GTD past
   * its effective expiry before it could match).
   */
  #stagedImmediate(input: {
    readonly plan: PlacementPlanView;
    readonly planned: PlannedOrderView;
    readonly marketId: string;
    readonly tokenId: string;
    readonly fills: readonly SimulatedFill[];
    readonly filledShares: string;
    readonly state: "FILLED" | "CANCELLED" | "REJECTED" | "EXPIRED";
    readonly atEvent: RecordedEventIdentity;
  }): StagedOrder {
    return {
      order: this.#orderRecord({ ...input, fillEstimateKind: "POINT" }),
      fills: input.fills,
      rest: undefined,
      pending: undefined,
    };
  }

  /**
   * An order whose remainder RESTS, registered at commit. The resting rule:
   * an order is RESTING or PARTIALLY_FILLED exactly when this venue holds its
   * resting record (it can still fill, expire, or be cancelled).
   */
  #stagedResting(input: {
    readonly plan: PlacementPlanView;
    readonly planned: PlannedOrderView;
    readonly marketId: string;
    readonly tokenId: string;
    readonly filledShares: string;
    readonly fills: readonly SimulatedFill[];
    readonly rest: StagedRest;
    readonly atEvent: RecordedEventIdentity;
  }): StagedOrder {
    return {
      order: this.#orderRecord({
        ...input,
        state: compareDecimal(input.filledShares, "0") > 0 ? "PARTIALLY_FILLED" : "RESTING",
        fillEstimateKind: input.rest.band === undefined ? "POINT" : "TIER_1_RESTING_BAND",
      }),
      fills: input.fills,
      rest: input.rest,
      pending: undefined,
    };
  }

  /**
   * Stages a resting registration: the queue ahead at placement, the stated
   * same-instant additions, the effective expiry and — under Tier 1 — the
   * §12.2 band. Reads the book, the policy, the queue parameters and the trades
   * already observed; WRITES NOTHING. The record reaches `#resting` only at
   * commit (O10, `PP-17`: a throw here can no longer leave a resting record
   * that no booked order owns).
   */
  #stageRest(input: {
    readonly plan: PlacementPlanView;
    readonly planned: PlannedOrderView;
    readonly marketId: string;
    readonly tokenId: string;
    readonly book: BookView;
    readonly restingFromNs: bigint;
    readonly remainingShares: string;
    readonly timeInForce: TimeInForce;
    readonly statedExpiryNs: bigint | undefined;
    readonly feeSnapshot: FeeScheduleSnapshot;
  }): SimulationResult<StagedRest> {
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

    if (this.#options.model.tier !== "TIER_1") return simulationOk({ record, band: undefined });
    const band = this.#bandFor(record, input.feeSnapshot);
    if (!band.ok) return band;
    return simulationOk({ record, band: band.value });
  }

  /**
   * Applies one staged order to the venue: its fills (cash, positions, the
   * fill list), the order itself, its resting record and band, or its pending
   * DELAYED disposition. Every value was computed while staging, and the cash
   * and position arithmetic is done into locals before anything is assigned
   * (`#applyFills`), so there is nothing left here that can fail half-way.
   */
  #commit(staged: StagedOrder): void {
    this.#applyFills(staged.fills);
    this.#orders.set(staged.order.simulatedOrderId, staged.order);
    if (staged.rest !== undefined) {
      this.#resting.set(staged.rest.record.simulatedOrderId, staged.rest.record);
      if (staged.rest.band !== undefined) this.#bands.set(staged.rest.record.simulatedOrderId, staged.rest.band);
    }
    if (staged.pending !== undefined) this.#pending.set(staged.pending.simulatedOrderId, staged.pending);
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

  /**
   * What the recorded clock reaching `nowNs` settles, at the event `atEvent`.
   *
   * 1. O5: every DELAYED order whose `matchableAtNs` has been reached takes its
   *    already-computed disposition — its fills are booked NOW (never before
   *    that instant: `TERM-D`), and its remainder is settled or registered to
   *    rest. In `(matchableAtNs, order id)` order, so a replay produces its
   *    fills in the same order every time (§12.4). A disposition that cannot
   *    be APPLIED leaves its order REJECTED with nothing booked, and is held
   *    for `#reportUnapplied` (SIM-1 r1, `SIM1-R1-1`); one order's failure
   *    does not stop the others.
   * 2. O4: every resting GTD order whose effective expiry has been reached
   *    EXPIRES — on ANY recorded event, not only on a trade in its own market
   *    and side (`VS-05b`): the venue expires a GTD order at its time whether
   *    or not anything trades, and a quiet market used to keep one working —
   *    and its capital held — for ever.
   *
   * Run from `observe()` (at the venue clock), from `observeTrade()` (at the
   * trade's recorded instant, BEFORE the trade is walked, so a remainder that
   * came to rest at this instant can fill from it) and before a cancel (so a
   * cancel never acts on a state the clock has already moved past).
   */
  #sweep(
    nowNs: bigint,
    atEvent: RecordedEventIdentity,
  ): { readonly fills: readonly SimulatedFill[]; readonly bands: readonly RestingFillBand[] } {
    const fills: SimulatedFill[] = [];
    const bands: RestingFillBand[] = [];
    if (this.#pending.size > 0) {
      const due = [...this.#pending.values()]
        .filter((pending) => pending.matchableAtNs <= nowNs)
        .sort((left, right) =>
          left.matchableAtNs < right.matchableAtNs
            ? -1
            : left.matchableAtNs > right.matchableAtNs
              ? 1
              : compareStrings(left.simulatedOrderId, right.simulatedOrderId),
        );
      for (const pending of due) {
        const existing = this.#orders.get(pending.simulatedOrderId);
        if (existing === undefined || existing.state !== "DELAYED") {
          // Unreachable: a pending entry exists exactly while its order is
          // DELAYED, and only this loop moves a DELAYED order. Dropped so a
          // stale entry cannot be applied over an order that moved on.
          this.#pending.delete(pending.simulatedOrderId);
          continue;
        }
        const settled = pending.disposition;
        const rest = settled.kind === "RESTS" ? settled.rest : undefined;
        // SIM-1 r1 (`SIM1-R1-1`): the pending entry is removed only once the
        // order has a FINAL answer. It used to be deleted BEFORE the commit,
        // so a commit that threw (its fill accounting refused an operand)
        // left the order DELAYED for ever — with nothing left to resolve it,
        // every cancel refused as "inside the window", and the trader's
        // reservation, allocator commitment and time-in-force held with it.
        const committed = totally("applying a DELAYED order's disposition at matchableAtNs", () => {
          const order = ownFrozenTree<SimulatedOrder>({
            ...existing,
            filledShares: pending.filledShares,
            state:
              settled.kind === "TERMINAL"
                ? settled.state
                : compareDecimal(pending.filledShares, "0") > 0
                  ? "PARTIALLY_FILLED"
                  : "RESTING",
            fillEstimateKind: rest?.band !== undefined ? "TIER_1_RESTING_BAND" : existing.fillEstimateKind,
            atEvent,
          });
          // All-or-nothing: `#applyFills` computes cash and positions into
          // locals and assigns last, and everything after it is a `Map.set`.
          this.#commit({ order, fills: pending.fills, rest, pending: undefined });
          return simulationOk(null);
        });
        if (committed.ok) {
          this.#pending.delete(pending.simulatedOrderId);
          for (const fill of pending.fills) fills.push(fill);
          if (rest?.band !== undefined) bands.push(rest.band);
          continue;
        }
        // The disposition cannot be applied, and the failure is handled HERE,
        // once, at `matchableAtNs` — never retried, because the venue decides
        // a delayed order at the end of its window, and an order kept DELAYED
        // past it is exactly the uncancellable, capital-holding state this
        // closes. D-18 (`docs/venue/verified-2026-09-16.md`): "If the market,
        // balance, allowance, or risk checks fail when the delay expires, the
        // order is rejected instead of matching." So: REJECTED, nothing
        // filled, and — the commit being all-or-nothing — no fill, no cash,
        // no position, no resting record and no band. The REJECTED state is
        // written BEFORE the entry is deleted, so a throw here leaves the
        // entry to be swept again rather than lost. Reported, not silent:
        // `#reportUnapplied`.
        this.#orders.set(
          pending.simulatedOrderId,
          ownFrozenTree<SimulatedOrder>({ ...existing, state: "REJECTED", filledShares: "0", atEvent }),
        );
        this.#pending.delete(pending.simulatedOrderId);
        this.#unapplied.push({
          simulatedOrderId: pending.simulatedOrderId,
          marketId: existing.marketId,
          cause: committed.refusal,
        });
      }
    }
    const expired = [...this.#resting.values()]
      .filter((record) => record.effectiveExpiryNs !== undefined && nowNs >= record.effectiveExpiryNs)
      .sort((left, right) => compareStrings(left.simulatedOrderId, right.simulatedOrderId));
    for (const record of expired) this.#expire(record, atEvent);
    return { fills, bands };
  }

  #observeTradeSync(offered: {
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
    // D1 FIRST (round-4 review, MEDIUM-1). This door read the CALLER'S OWN
    // record repeatedly — `price` three times, `shares` three, `monotonicNs`
    // six — so an accessor honest for the checks and lying afterwards was
    // validated as one trade and computed over as another. Measured at
    // `d56e707`, with a `price` answering `"0.46"` for
    // `isCanonicalDecimalString` and `"0.4"` after, against a 0.45-resting
    // order: Tier 1 answered `ok: true` with `filled=50` in BOTH `result.bands`
    // and `venue.restingBands()`, which the §12.4 `band` line then printed; and
    // the Tier-0 shape produced a MAKER fill that moved `cashBalance` from
    // `1000` to `995.5` and booked a 10-share position — from a trade whose
    // validated price was away from the resting price.
    //
    // The whole argument is materialized once, under
    // `RECORDED_INSTANTS_ARE_BIGINTS` (`monotonicNs` is §7.1 recorded
    // nanoseconds — `plain.ts`'s `MaterializePolicy`), and EVERY read below is
    // of the materialized tree. A hostile record is refused
    // `SIMULATION_INPUT_NOT_DATA` naming the argument, rather than reaching D4's
    // copier and coming back as `SIMULATION_INTERNAL` — the blame-the-package
    // shape round 3 closed at `tier0Immediate`.
    const read = readOwnPlainInput<{
      readonly marketId: string;
      readonly side: "YES" | "NO";
      readonly price: string;
      readonly shares: string;
      readonly monotonicNs: bigint;
      readonly atEvent: RecordedEventIdentity;
    }>(offered, "the observed trade", RECORDED_INSTANTS_ARE_BIGINTS);
    if (!read.ok) return read;
    const input = read.value;
    if (input === null || typeof input !== "object") {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade is a record carrying a market, a side, a price, a size and the recorded instant it printed at",
      );
    }
    // ONE READ PER FIELD, out of the materialized tree, into locals. Everything
    // below uses the locals, so there is no second read to disagree with a first
    // even if the materializer were ever weakened.
    const marketId: unknown = input.marketId;
    const side: unknown = input.side;
    const price: unknown = input.price;
    const shares: unknown = input.shares;
    const monotonicNs: unknown = input.monotonicNs;
    const atEvent = ownFrozenTree<RecordedEventIdentity>(
      input.atEvent as RecordedEventIdentity,
    );

    if (!isNonEmptyString(marketId) || (side !== "YES" && side !== "NO")) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade names a market and an outcome side",
      );
    }
    if (!isCanonicalDecimalString(price) || !isCanonicalDecimalString(shares)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade carries canonical decimal price and size (§6 invariant 1)",
        { price: describeForRefusal(price), shares: describeForRefusal(shares) },
      );
    }
    if (compareDecimal(shares, "0") <= 0) {
      return simulationFailure("SIMULATION_INPUT_INVALID", "an observed trade has positive size");
    }
    // The PRICE bound the queue door already enforces (round-3 review, NOTE-3),
    // enforced here too: the venue's own guard is what `queue.ts` says it no
    // longer depends on, and a non-positive price is not a price.
    if (compareDecimal(price, "0") <= 0) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade prints at a strictly positive price; the at-price / through-price comparison a maker fill turns on is not defined for a non-positive one",
        { price },
      );
    }
    if (typeof monotonicNs !== "bigint" || monotonicNs < 0n) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "an observed trade carries the recorded monotonic nanoseconds of the event that printed it (§7.1)",
      );
    }
    const fees = readFeeScheduleSnapshot(this.#options.feeSnapshot);
    if (!fees.ok) return fees;

    const key = positionKey({ marketId, side });
    const observed = this.#trades.get(key) ?? [];
    const last = observed[observed.length - 1];
    if (last !== undefined && monotonicNs < last.monotonicNs) {
      return simulationFailure(
        "REPLAY_CLOCK_NOT_MONOTONE",
        "an observed trade arrives earlier than one already reported for this market and side; replay follows recorded dispatch order (§8.4, §6 invariant 15) and a queue walk over an unordered list truncates silently",
        {
          marketId,
          previousMonotonicNs: last.monotonicNs.toString(),
          monotonicNs: monotonicNs.toString(),
        },
      );
    }
    const trade = ownFrozenTree<ObservedTrade>({
      price,
      shares,
      monotonicNs,
      atEvent,
    });
    observed.push(trade);
    this.#trades.set(key, observed);

    const produced: SimulatedFill[] = [];
    const updated: RestingFillBand[] = [];
    // O4 / O5: what this recorded instant settles — DELAYED orders whose
    // window has closed, GTD orders past their expiry — BEFORE the trade is
    // walked, so a remainder that came to rest at or before this instant can
    // fill from it.
    const swept = this.#sweep(monotonicNs, atEvent);
    for (const fill of swept.fills) produced.push(fill);
    for (const band of swept.bands) updated.push(band);
    // Ordered by a value-derived key: two resting orders must be visited in the
    // same order on every replay of the same dataset (§12.4).
    const records = [...this.#resting.values()]
      .filter((record) => record.marketId === marketId && record.side === side)
      .sort((left, right) => compareStrings(left.simulatedOrderId, right.simulatedOrderId));

    for (const record of records) {
      if (monotonicNs < record.restingFromNs) continue;
      // Kept although the sweep above already expired every record due at
      // this instant: an expiry is never skipped because of how it was reached.
      if (record.effectiveExpiryNs !== undefined && monotonicNs >= record.effectiveExpiryNs) {
        this.#expire(record, atEvent);
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
          observedTradePrice: price,
          feeSnapshot: fees.value,
          atEvent,
        });
        if (!outcome.ok) return outcome;
        if (outcome.value.trigger === "NONE") continue;
        this.#applyFills(outcome.value.fills);
        for (const fill of outcome.value.fills) produced.push(fill);
        const existing = this.#orders.get(record.simulatedOrderId);
        if (existing !== undefined) {
          this.#orders.set(
            record.simulatedOrderId,
            ownFrozenTree<SimulatedOrder>({
              ...existing,
              filledShares: addDecimal(existing.filledShares, outcome.value.filledShares),
              state: "FILLED",
              atEvent,
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

    // `SIM1-R1-1`: a DELAYED disposition this instant could not apply is
    // reported AFTER the trade was walked — the resting orders still fill
    // from it, and the fills it produced are in the venue's fill list.
    return this.#reportUnapplied() ?? simulationOk(ownFrozenTree({ fills: produced, bands: updated }));
  }

  /**
   * `SIM1-R1-1`: the answer for every DELAYED disposition the venue could not
   * apply and has not reported yet, or `undefined` when there is none. Drains
   * the list, so each failure is reported exactly once.
   *
   * Only `observe()` and `observeTrade()` report — the doors that answer for
   * recorded time and whose `SimulationResult` has a refusal channel. A
   * cancel's own sweep (`#cancelSync`) cannot report on a `CancelResult`, so a
   * failure it finds waits here for the next of those two doors; the order
   * itself reads REJECTED in every snapshot from the moment it failed.
   */
  #reportUnapplied<TValue>(): SimulationResult<TValue> | undefined {
    if (this.#unapplied.length === 0) return undefined;
    const failed = this.#unapplied.splice(0, this.#unapplied.length);
    return simulationFailure(
      "SIMULATED_VENUE_DISPOSITION_NOT_APPLIED",
      `the already-computed disposition of ${String(failed.length)} DELAYED order(s) could not be applied when the recorded clock reached matchableAtNs; each is REJECTED with nothing filled and nothing booked (venue report D-18: an order whose checks fail when the delay expires is rejected instead of matching): ` +
        failed
          .map(
            (entry) =>
              `${entry.simulatedOrderId} (market ${entry.marketId}): ${entry.cause.code} — ${entry.cause.message}` +
              describeCauseFailure(entry.cause),
          )
          .join("; "),
      {
        simulatedOrderIds: failed.map((entry) => entry.simulatedOrderId).join(","),
        marketIds: failed.map((entry) => entry.marketId).join(","),
        causes: failed.map((entry) => entry.cause.code).join(","),
      },
    );
  }

  /**
   * O4 (`TERM-C`): a resting GTD order past its effective expiry EXPIRES,
   * keeping the size it already filled. It used to move only a RESTING order,
   * so a GTD that partly filled on arrival was dropped from the resting set
   * but left PARTIALLY_FILLED — never able to fill again, never terminal.
   *
   * UNVERIFIED for the live adapter: the recorded venue order statuses
   * (`live`, `matched`, `delayed`, `unmatched`, and `CANCELED` on the user
   * channel; `docs/venue/verified-2026-09-16.md` §2.2) contain no EXPIRED, so
   * what the live venue reports for a partly filled GTD at its expiry is not
   * recorded. This simulator's state is EXPIRED with `filledShares` kept, the
   * same state it gives an unfilled GTD at expiry.
   */
  #expire(record: RestingRecord, atEvent: RecordedEventIdentity): void {
    const existing = this.#orders.get(record.simulatedOrderId);
    if (
      existing !== undefined &&
      (existing.state === "RESTING" || existing.state === "PARTIALLY_FILLED")
    ) {
      this.#orders.set(
        record.simulatedOrderId,
        ownFrozenTree<SimulatedOrder>({ ...existing, state: "EXPIRED", atEvent }),
      );
    }
    this.#resting.delete(record.simulatedOrderId);
  }

  /**
   * Books fills against cash and positions and appends them to the fill list.
   *
   * The arithmetic is done into LOCALS first and assigned last, so a failure
   * part-way through leaves the venue's cash, positions and fill list exactly
   * as they were (O10's all-or-nothing commit). The order of the arithmetic is
   * the order it always was — one fill after another — so every balance is the
   * same exact decimal.
   */
  #applyFills(fills: readonly SimulatedFill[]): void {
    if (fills.length === 0) return;
    let cash = this.#cash;
    const touched = new Map<string, { marketId: string; tokenId: string; side: "YES" | "NO"; shares: string }>();
    for (const fill of fills) {
      const notional = mulDecimal(fill.price, fill.shares);
      cash =
        fill.action === "BUY"
          ? subDecimal(subDecimal(cash, notional), fill.feeAmount)
          : subDecimal(addDecimal(cash, notional), fill.feeAmount);
      const key = positionKey({ marketId: fill.marketId, side: fill.side });
      const current = touched.get(key) ?? this.#positions.get(key);
      const delta = fill.action === "BUY" ? fill.shares : subDecimal("0", fill.shares);
      touched.set(
        key,
        current === undefined
          ? { marketId: fill.marketId, tokenId: fill.tokenId, side: fill.side, shares: delta }
          : { ...current, shares: addDecimal(current.shares, delta) },
      );
    }
    this.#cash = cash;
    for (const [key, position] of touched) this.#positions.set(key, position);
    for (const fill of fills) this.#fills.push(fill);
  }

  /**
   * The cancel step, over OWN data.
   *
   * Both callers hand it a materialized record: the public
   * {@link SimulatedVenue.cancel} materializes the caller's command, and
   * `#submitSync` builds one from the already-materialized plan. Its reads are
   * therefore of trees this package built — and the scope is still read ONCE,
   * defensively, because a materialized record can still be the wrong SHAPE and
   * `CancelResult` reports that the way §6 invariant 13 requires: nothing
   * cancelled, and the reason travelling with the result.
   *
   * What each scope targets, and what it is charged:
   *
   * - BY ID (`scope.orderIds`): exactly the ids named, charged one cancel token
   *   per id submitted (venue report §8: `DELETE /orders` costs "Number of
   *   submitted order IDs"). An id that is unknown, terminal, or DELAYED is
   *   named in `notCancelled` with its reason.
   * - BY MARKET (no `orderIds`), O6 (`VS-13`/`TERM-H`): the LIVE orders only —
   *   RESTING, PARTIALLY_FILLED, DELAYED — in the market named (every market
   *   when none is). Terminal history is not a target and is not charged: a
   *   sweep that cancelled every live order is a success whatever filled
   *   before it. With NO live target the cancel is a successful no-op: nothing
   *   is charged and it answers `cancelled: []`, `notCancelled: []`.
   */
  #cancelSync(command: CancelCommand): CancelResult {
    const cancelled: string[] = [];
    const notCancelled: { simulatedOrderId: string; reason: string }[] = [];
    const offeredScope: unknown = command.scope;
    if (offeredScope === null || typeof offeredScope !== "object") {
      return ownFrozenTree<CancelResult>({
        executionPlanId:
          typeof command.executionPlanId === "string" ? command.executionPlanId : "",
        cancelled: [],
        notCancelled: [
          {
            simulatedOrderId: "(no scope)",
            reason:
              "SIMULATION_INPUT_INVALID: a cancel command carries a scope naming order ids or a market; nothing was cancelled",
          },
        ],
        venueClass: "SIMULATED",
      });
    }
    // A cancel never acts on a state the recorded clock has already moved past:
    // a DELAYED order whose window has closed takes its disposition first. A
    // disposition that cannot be applied leaves its order REJECTED (so it is
    // "already REJECTED" below) and waits in `#unapplied` for the next
    // `observe()` / `observeTrade()` to report it (`SIM1-R1-1`).
    const atEvent = this.#atEvent;
    if (atEvent !== undefined) this.#sweep(this.#options.clock.monotonicNs(), atEvent);

    const scope = offeredScope as { readonly marketId?: string; readonly orderIds?: readonly string[] };
    const scopedOrderIds = scope.orderIds;
    const scopedMarketId = scope.marketId;
    const targets =
      scopedOrderIds ??
      [...this.#orders.values()]
        .filter((order) => (scopedMarketId === undefined ? true : order.marketId === scopedMarketId))
        .filter((order) => isLiveState(order.state))
        .map((order) => order.simulatedOrderId);

    const admitted: RateLimitDecision =
      targets.length === 0
        ? { admitted: true }
        : this.#options.rateLimits.admit({
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
      // O7 (`TERM-E`): every terminal state is final, REJECTED included. A
      // REJECTED order was never working; rewriting it CANCELLED rewrote the
      // run's history and reported a cancel that cancelled nothing.
      if (
        order.state === "FILLED" ||
        order.state === "CANCELLED" ||
        order.state === "EXPIRED" ||
        order.state === "REJECTED"
      ) {
        notCancelled.push({ simulatedOrderId: id, reason: `already ${order.state}` });
        continue;
      }
      // O5 / D-18: "During either delay, the order is pending and cannot be
      // canceled." The cancel is refused and the order is unchanged.
      if (order.state === "DELAYED") {
        notCancelled.push({
          simulatedOrderId: id,
          reason:
            "DELAYED: the order is pending in the market's trading-delay window and cannot be canceled (venue report D-18); it takes its disposition when the window closes",
        });
        continue;
      }
      // O8 (`TERM-I`): the order's `atEvent` is "the recorded event identity
      // this state was reached at", so a cancel re-stamps it with the event the
      // venue is positioned at — the one the cancel happened at.
      this.#orders.set(
        id,
        ownFrozenTree<SimulatedOrder>({ ...order, state: "CANCELLED", atEvent: atEvent ?? order.atEvent }),
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
      .filter((order) => isLiveState(order.state))
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
 * Reads one caller plan's PRIORITY, once, without letting it escape.
 *
 * {@link SimulatedVenue.submitAll} schedules on this value (§6 invariant 13) and
 * `submit` validates everything else, so this is the one caller read the batch
 * seam makes on its own. `undefined` means the read failed — a throwing accessor
 * or trap — and such a plan is scheduled LAST rather than being trusted with the
 * privileged rank it could not state.
 */
function readPlanPriority(plan: ExecutionPlanView): "SAFETY_CANCEL" | "PLACEMENT" | undefined {
  const read = totally("reading a plan's scheduling priority", () => {
    const priority: unknown = plan === null || typeof plan !== "object" ? undefined : plan.priority;
    return simulationOk(priority);
  });
  if (!read.ok) return undefined;
  return read.value === "SAFETY_CANCEL" || read.value === "PLACEMENT" ? read.value : undefined;
}

/** {@link comparePlanPriority}, with "the priority could not be read" sorting last. */
function comparePriorityOrUnknown(
  left: "SAFETY_CANCEL" | "PLACEMENT" | undefined,
  right: "SAFETY_CANCEL" | "PLACEMENT" | undefined,
): -1 | 0 | 1 {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return comparePlanPriority(left, right);
}

/**
 * The cancel result for a command that could not be read at all.
 *
 * `CancelResult` carries no refusal field, so the refusal is reported where §6
 * invariant 13 requires a privileged-path failure to be reported: nothing in
 * `cancelled`, and the reason travelling in `notCancelled`.
 */
function refusedCancel(refusal: SimulationRefusal): CancelResult {
  return ownFrozenTree<CancelResult>({
    executionPlanId: "",
    cancelled: [],
    notCancelled: [
      { simulatedOrderId: "(the command could not be read)", reason: `${refusal.code}: ${refusal.message}` },
    ],
    venueClass: "SIMULATED",
  });
}

/**
 * The account snapshot for a contained INTERNAL fault.
 *
 * Reached when a member of the snapshot is not own plain data — in practice, a
 * `startingCash` the composition root did not construct as a decimal string,
 * which is the one caller value this method has no door in front of. It is built
 * with `plainRecord`/`defineData` rather than through D4's copier, so the
 * failure path cannot fail the same way the path it contains did.
 *
 * `cashBalance` is deliberately NOT a decimal string: §6 invariant 1 makes every
 * economic value an exact decimal, so a consumer's own decimal door refuses this
 * one rather than reading a fabricated balance, and an empty `positions` cannot
 * be mistaken for a measured flat book because the balance beside it does not
 * parse. `README.md` §5 item 12 discloses the shape.
 */
function unreadableAccount(): AccountSnapshot {
  const snapshot = plainRecord();
  defineData(snapshot, "venueClass", "SIMULATED");
  defineData(snapshot, "cashBalance", "SIMULATION_INTERNAL_NO_ACCOUNT_STATE");
  defineData(snapshot, "positions", Object.freeze([]));
  defineData(snapshot, "openOrders", Object.freeze([]));
  defineData(snapshot, "atEvent", null);
  return Object.freeze(snapshot) as unknown as AccountSnapshot;
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
