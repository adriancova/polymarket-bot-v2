/**
 * The Static Bracket decision logic: pure functions from (params, state,
 * observation, event) to one plan.
 *
 * A plan is what a callback will return as its single `DecisionResult` (§7.5):
 * a decision type, reason codes, zero or more INTENTS, the next state document,
 * and an optional wake-up time. Nothing here places an order, cancels one, or
 * reads anything the context did not hand over.
 *
 * THE LADDER, in the order every evaluation applies it. The order is the
 * safety argument, so it is stated once here and followed everywhere:
 *
 *  1. **HALTED short-circuits.** A halted instance holds and does nothing else.
 *  2. **Data quality first (§13.3 rule 4, §9.9).** A stale book or an active
 *     data-quality incident PAUSES the instance and cancels resting orders. No
 *     stop, no protected reduce, no entry may be evaluated in this branch —
 *     "a stop on stale data is forbidden; incident policy applies first". When
 *     the stop trigger WOULD have fired, the plan says so with
 *     `SB.STOP_SUPPRESSED_STALE_DATA` and still emits no reduction.
 *  3. **Resume** once data is healthy again, into the recorded pre-pause state.
 *  4. **Position agreement before any position-changing exit (§6 invariant
 *     12).** A protected reduction is emitted only when the virtual position
 *     equals the strategy's own confirmed allocation. A disagreement cancels
 *     and reconciles instead of flattening.
 *  5. **End of market**, then **stop**, then **holding timeout**, then
 *     **take-profit maintenance** — the exits, most urgent first.
 *  6. **Entry**, last, and only from ARMED.
 *
 * Every economic comparison is exact-decimal (`economics.ts`); the strategy
 * performs no division and no floating-point arithmetic.
 */

import type { Intent } from "@polymarket-bot/strategy-sdk";

import {
  ZERO,
  add,
  compare,
  complement,
  greaterOrEqual,
  isZero,
  lessOrEqual,
  mul,
  onTickGrid,
  readPrice,
  sub,
} from "./economics.js";
import { readFeatureFlag, readFeatureScalar } from "./features.js";
import {
  TERMINAL_ORDER_STATES,
  instanceTransition,
  orderTransition,
  type InstanceTrigger,
  type OrderState,
  type OrderTrigger,
} from "./machine.js";
import {
  askDepthUpTo,
  bidDepthDownTo,
  heldShares,
  walkForSize,
  type Observation,
  type TrackedOrderView,
} from "./observe.js";
import type { StaticBracketParams } from "./params.js";
import { ok, type Outcome } from "./plain.js";
import { REASONS, TAGS, legTag, orderTypeTag } from "./reasons.js";
import {
  withState,
  type OrderTrack,
  type Outcome2,
  type StaticBracketState,
} from "./state.js";
import { formatInstantMs } from "./time.js";

export type DecisionType = "enter" | "exit" | "quote" | "hold" | "skip" | "cancel" | "reduce";

export interface Plan {
  readonly state: StaticBracketState;
  readonly decisionType: DecisionType;
  readonly reasons: readonly string[];
  readonly intents: readonly Intent[];
  readonly modelOutputs: Readonly<Record<string, string | boolean | null>> | null;
  readonly nextWakeupAtMs: number | null;
}

function plan(
  state: StaticBracketState,
  decisionType: DecisionType,
  reasons: readonly string[],
  intents: readonly Intent[] = [],
  modelOutputs: Readonly<Record<string, string | boolean | null>> | null = null,
  nextWakeupAtMs: number | null = null,
): Plan {
  return { state, decisionType, reasons, intents, modelOutputs, nextWakeupAtMs };
}

// ---------------------------------------------------------------------------
// State-machine helpers
// ---------------------------------------------------------------------------

/**
 * Applies one instance transition. An ILLEGAL transition does not silently
 * self-loop: the instance halts, because a machine that took an edge its own
 * table does not contain is a machine whose state no longer describes reality.
 */
function move(
  state: StaticBracketState,
  trigger: InstanceTrigger,
  changes: Partial<StaticBracketState> = {},
): Outcome<StaticBracketState> {
  const moved = instanceTransition(state.instanceState, trigger, state.resumeTo);
  if (!moved.ok) {
    return { ok: false, problem: moved.problem };
  }
  return ok(withState(state, { ...changes, instanceState: moved.to }));
}

function moveOrder(track: OrderTrack, trigger: OrderTrigger): Outcome<OrderTrack> {
  const moved = orderTransition(track.state, trigger);
  if (!moved.ok) {
    return { ok: false, problem: moved.problem };
  }
  return ok(Object.freeze({ ...track, state: moved.to }));
}

/**
 * Folds a CONFIRMED FILL into a tracked order.
 *
 * §6 invariant 5 keeps ORDER STATE and SETTLEMENT STATE separate, and this is
 * where that distinction earns its keep. A fill arriving for an order the venue
 * has already reported terminal is not a contradiction and is not an illegal
 * transition: §8.1 gives no ordering between an order view and the fill it
 * describes, so the ordinary case of an aggressive order is a `FILLED` view and
 * then its fill. The ALLOCATION is updated; the order's own state is already
 * final and stays where it is.
 *
 * While the order is still live the sub-machine decides, exactly as before.
 */
function foldFillIntoOrder(track: OrderTrack, trigger: OrderTrigger): Outcome<OrderTrack> {
  if (TERMINAL_ORDER_STATES.includes(track.state)) {
    return ok(Object.freeze({ ...track }));
  }
  return moveOrder(track, trigger);
}

/**
 * Keeps the BRACKET machine in step with the ORDER sub-machine.
 *
 * §13.3 draws `ENTRY_PLANNED -> ENTRY_WORKING` and `EXIT_PLANNED ->
 * EXIT_WORKING` as real edges, and they mean exactly one thing: the order the
 * instance planned is now known to be resting. That fact arrives through the
 * sub-machine, so this is where the two are joined — without it those two
 * §13.3 edges would exist in the table and never be taken, which is the kind of
 * gap a transition table is supposed to make visible.
 */
function syncPlannedToWorking(
  state: StaticBracketState,
  kind: "ENTRY" | "EXIT",
): StaticBracketState {
  const track = kind === "ENTRY" ? state.entryOrder : state.exitOrder;
  if (track === null || track.state !== "WORKING") return state;
  const expected = kind === "ENTRY" ? "ENTRY_PLANNED" : "EXIT_PLANNED";
  if (state.instanceState !== expected) return state;
  // MOVE-SITE: syncPlannedToWorking
  const moved = move(state, kind === "ENTRY" ? "ENTRY_ORDER_WORKING" : "EXIT_ORDER_WORKING");
  return moved.ok ? moved.value : state;
}

function halted(state: StaticBracketState, detail: string, intents: readonly Intent[]): Plan {
  const moved = instanceTransition(state.instanceState, "HALT", state.resumeTo);
  const next = withState(state, {
    instanceState: moved.ok ? moved.to : "HALTED",
    haltReason: detail.slice(0, 500),
  });
  return plan(next, "cancel", [REASONS.halted], intents);
}

/** The working order the strategy currently has, if any. */
function workingOrders(state: StaticBracketState): readonly OrderTrack[] {
  const tracked: OrderTrack[] = [];
  if (state.entryOrder !== null && isLive(state.entryOrder.state)) tracked.push(state.entryOrder);
  if (state.exitOrder !== null && isLive(state.exitOrder.state)) tracked.push(state.exitOrder);
  return tracked;
}

function isLive(orderState: OrderState): boolean {
  return orderState === "PENDING" || orderState === "WORKING" || orderState === "CANCEL_PENDING";
}

// ---------------------------------------------------------------------------
// Intent construction
// ---------------------------------------------------------------------------

function intentId(state: StaticBracketState, kind: string, marketId: string): string {
  // Deterministic and unique per instance: the sequence is part of the state
  // document, so a replay of the same decisions produces the same ids.
  return `sb-${kind}-${String(state.intentSequence)}-${marketId}`.slice(0, 200);
}

function cancelIntent(marketId: string, orderIds: readonly string[], reason: string): Intent {
  const known = orderIds.filter((id) => id.length > 0);
  const base = { type: "CANCEL" as const, marketId, reason: reason.slice(0, 2000) };
  return known.length > 0 ? { ...base, orderIds: Object.freeze([...known]) } : base;
}

// ---------------------------------------------------------------------------
// Data quality (§13.3 rule 4; §9.9)
// ---------------------------------------------------------------------------

export interface DataQuality {
  readonly healthy: boolean;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly bookAgeMs: number;
}

/**
 * Assesses whether this evaluation may act on market data at all.
 *
 * Two independent conditions, both configured:
 *
 * - the traded book's age (`now - book.asOf`) against `maximum_book_age_ms`;
 * - the configured data-quality incident flag, which is the strategy's view of
 *   §9.5's "active data-quality incident flags".
 *
 * An UNUSABLE incident flag (absent key, wrong type) counts as an incident. The
 * fail-safe direction is deliberate: the cost of a false incident is a missed
 * trade; the cost of a false all-clear is an aggressive order against a book
 * nobody can vouch for.
 */
export function assessDataQuality(
  params: StaticBracketParams,
  observation: Observation,
  leg: Outcome2,
): DataQuality {
  const bookAgeMs = observation.nowMs - observation.books[leg].asOfMs;
  if (bookAgeMs > params.data_quality.maximum_book_age_ms) {
    return {
      healthy: false,
      reason: REASONS.staleBook,
      detail: `book age ${String(bookAgeMs)}ms exceeds ${String(params.data_quality.maximum_book_age_ms)}ms`,
      bookAgeMs,
    };
  }
  const flag = readFeatureFlag(observation.features, params.data_quality.incident_feature_key);
  if (flag.kind === "UNUSABLE") {
    return {
      healthy: false,
      reason: REASONS.dataQualityIncident,
      detail: flag.problem,
      bookAgeMs,
    };
  }
  if (flag.kind === "ABSENT") {
    return {
      healthy: false,
      reason: REASONS.dataQualityIncident,
      detail: "the data-quality flag is absent, which is not an all-clear",
      bookAgeMs,
    };
  }
  if (flag.value) {
    return {
      healthy: false,
      reason: REASONS.dataQualityIncident,
      detail: "an active data-quality incident is flagged for this market",
      bookAgeMs,
    };
  }
  return { healthy: true, reason: null, detail: null, bookAgeMs };
}

/**
 * The incident branch: PAUSE and cancel. Never a reduction, never an entry.
 *
 * `suppressedStop` records that a stop trigger was satisfied by the prices this
 * evaluation could see, and was NOT acted on. That is §13.3 rule 4 made
 * visible: without it, "no stop fired" and "a stop was forbidden" look the same
 * in the decision log.
 */
function incidentPlan(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  quality: DataQuality,
  suppressedStop: boolean,
): Plan {
  const reasons: string[] = [REASONS.incidentPolicyFirst];
  if (quality.reason !== null) reasons.push(quality.reason);
  if (suppressedStop) {
    reasons.push(REASONS.stopSuppressedStaleData, REASONS.noBlindFlatten);
  }
  const live = workingOrders(state);
  const alreadyPaused = state.instanceState === "PAUSED";
  if (alreadyPaused) {
    reasons.push(REASONS.paused);
    return plan(
      withState(state, { lastIncident: quality.detail }),
      "hold",
      reasons,
      [],
      { bookAgeMs: String(quality.bookAgeMs), staleOrIncident: true },
    );
  }
  const intents: Intent[] = [];
  let next = state;
  if (live.length > 0) {
    // §6 invariant 13: safety cancellation outranks new order placement.
    intents.push(
      cancelIntent(
        observation.market.marketId,
        live.map((order) => order.orderId ?? ""),
        `static-bracket incident policy: ${quality.detail ?? "unusable market data"}`,
      ),
    );
    reasons.push(REASONS.safetyCancel);
    for (const order of live) {
      if (order.state !== "WORKING") continue;
      const moved = moveOrder(order, "CANCEL_REQUESTED");
      if (!moved.ok) continue;
      next =
        order.kind === "ENTRY"
          ? withState(next, { entryOrder: moved.value })
          : withState(next, { exitOrder: moved.value });
    }
  }
  // MOVE-SITE: incidentPause
  const paused = move(next, "PAUSE", {
    resumeTo: state.instanceState,
    lastIncident: quality.detail,
  });
  if (!paused.ok) {
    return halted(next, paused.problem, intents);
  }
  reasons.push(REASONS.paused);
  return plan(
    paused.value,
    intents.length > 0 ? "cancel" : "hold",
    reasons,
    intents,
    { bookAgeMs: String(quality.bookAgeMs), staleOrIncident: true },
    // Ask to be woken when the book could plausibly be fresh again.
    observation.nowMs + params.data_quality.maximum_book_age_ms,
  );
}

// ---------------------------------------------------------------------------
// The tick ladder
// ---------------------------------------------------------------------------

export interface TickContext {
  readonly params: StaticBracketParams;
  readonly state: StaticBracketState;
  readonly observation: Observation;
  /** Seconds to close supplied by `onMarketClosing`, otherwise derived. */
  readonly closingSecondsRemaining: number | null;
}

/** The instance's own leg: the allocated one, or the configured direction. */
export function currentLeg(params: StaticBracketParams, state: StaticBracketState): Outcome2 {
  return state.legOutcome ?? params.market_selector.direction;
}

/**
 * How this bracket's exposure is HELD, and therefore how it must be UNWOUND.
 *
 * {@link chooseLeg} produces exactly two shapes and no others:
 *
 * - the DIRECT leg BUYS the configured `market_selector.direction` token;
 * - the COMPLEMENT leg SELLS the other token, which the instance already owns.
 *
 * The leg is therefore a total function of the traded token: a bracket whose
 * `legOutcome` is the configured direction was entered by BUYING, and one whose
 * `legOutcome` is the other token was entered by SELLING. Nothing else has to be
 * remembered, and there is no state in which the two disagree.
 *
 * EVERY exit derives its side and its price from here. A complement-leg bracket
 * is CLOSED BY BUYING THE SAME TOKEN BACK, and its executable prices are the
 * complements of the configured, direction-denominated ones — because "one YES
 * and one NO pay exactly 1 between them" is the only relation this package uses
 * (`economics.ts`). Emitting the configured price on the complement leg would
 * sell MORE of the token the instance is already short, which is not an exit at
 * all: it is a second entry at double the size.
 */
export interface LegPosture {
  /** The outcome token this bracket trades. */
  readonly leg: Outcome2;
  /** How the exposure was established. */
  readonly entrySide: "BUY" | "SELL";
  /** How it must be unwound: always the opposite of {@link entrySide}. */
  readonly exitSide: "BUY" | "SELL";
  /** True when the leg is the configured direction's complement. */
  readonly complementLeg: boolean;
}

export function legPosture(params: StaticBracketParams, state: StaticBracketState): LegPosture {
  const leg = currentLeg(params, state);
  const complementLeg = leg !== params.market_selector.direction;
  return Object.freeze({
    leg,
    entrySide: complementLeg ? "SELL" : "BUY",
    exitSide: complementLeg ? "BUY" : "SELL",
    complementLeg,
  });
}

/**
 * A configured, DIRECTION-denominated exit price, re-expressed as the price the
 * chosen leg actually executes at.
 *
 * `exit.take_profit.price` and `exit.stop.minimum_sell_price` are written in the
 * configured direction's terms (§13.2's example configures a YES bracket and
 * names YES prices). On the direct leg that is already the executable price. On
 * the complement leg the same economic level is `1 - price`, and the intent
 * carries it as a MAXIMUM BUY price rather than a minimum sell price.
 */
function executableExitPrice(posture: LegPosture, configured: string): Outcome<string> {
  return posture.complementLeg ? complement(configured, "complement exit price") : ok(configured);
}

/**
 * This instance's OWN exposure, in shares of the traded leg, signed so that a
 * larger number always means "more of the bracket is on".
 *
 * `legBaselineShares` is what the instance held of the leg token before its
 * first entry fill, so the subtraction removes inventory this bracket did not
 * create — §6 invariant 7's separation of actual account state from virtual
 * strategy attribution, applied at the only place this package compares them.
 *
 * For a DIRECT bracket with no prior holding the baseline is zero and this is
 * exactly the pre-remediation `heldShares(observation, leg)`.
 */
function legExposure(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
): Outcome<string> {
  const posture = legPosture(params, state);
  const held = heldShares(observation, posture.leg);
  return posture.entrySide === "BUY"
    ? sub(held, state.legBaselineShares, "leg exposure")
    : sub(state.legBaselineShares, held, "leg exposure");
}

/**
 * The whole per-evaluation ladder. Used by `onFeatures`, `onTimer`,
 * `onMarketOpen` and `onStart`, so every callback applies the same rules in the
 * same order and no path can skip the data-quality gate.
 */
export function planTick(input: TickContext): Plan {
  const { params, state, observation } = input;
  if (state.instanceState === "HALTED") {
    return plan(state, "hold", [REASONS.halted]);
  }
  const leg = currentLeg(params, state);
  const quality = assessDataQuality(params, observation, leg);

  if (!quality.healthy) {
    const wouldStop = stopTriggerSatisfied(params, observation);
    const holding = hasAllocation(state);
    return incidentPlan(params, state, observation, quality, holding && wouldStop === true);
  }

  let current = state;
  const resumeReasons: string[] = [];
  if (current.instanceState === "PAUSED") {
    // MOVE-SITE: resume
    const resumed = move(current, "RESUME", { resumeTo: null, lastIncident: null });
    if (!resumed.ok) {
      return halted(current, resumed.problem, []);
    }
    current = resumed.value;
    resumeReasons.push(REASONS.resumed);
  }

  const timeToCloseMs =
    input.closingSecondsRemaining !== null
      ? input.closingSecondsRemaining * 1000
      : observation.market.closeTimeMs === null
        ? null
        : observation.market.closeTimeMs - observation.nowMs;

  // The market is over: end-of-market behaviour is an explicit policy (§13.3
  // rule 5) and is applied in `planClosing`; here the only question is whether
  // the bracket is finished.
  if (timeToCloseMs !== null && timeToCloseMs <= 0 && !hasAllocation(current)) {
    // MOVE-SITE: marketClosed
    const closed = move(current, "MARKET_CLOSED", { closedAtMs: observation.nowMs });
    if (closed.ok) {
      return plan(closed.value, "hold", [...resumeReasons, REASONS.marketClosed]);
    }
    return plan(current, "hold", [...resumeReasons, REASONS.marketClosed]);
  }

  switch (current.instanceState) {
    case "DORMANT": {
      // MOVE-SITE: arm
      const armed = move(current, "ARM");
      if (!armed.ok) return halted(current, armed.problem, []);
      return plan(armed.value, "hold", [...resumeReasons, REASONS.armed]);
    }
    case "ARMED":
      return planEntry(params, current, observation, timeToCloseMs, resumeReasons);
    case "ENTRY_PLANNED":
    case "ENTRY_WORKING":
      return planEntryOrderManagement(params, current, observation, timeToCloseMs, resumeReasons);
    case "PARTIALLY_OPEN":
    case "OPEN":
    case "EXIT_PLANNED":
    case "EXIT_WORKING":
      return planExit(params, current, observation, timeToCloseMs, resumeReasons);
    case "CLOSED":
      return planRearm(params, current, observation, resumeReasons);
    default:
      return plan(current, "hold", [...resumeReasons, REASONS.idle]);
  }
}

function hasAllocation(state: StaticBracketState): boolean {
  return !isZero(openShares(state));
}

/** Confirmed allocation not yet exited — the ONLY size an exit may name. */
export function openShares(state: StaticBracketState): string {
  const remaining = sub(state.allocatedShares, state.exitedShares, "open shares");
  return remaining.ok ? remaining.value : ZERO;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** The economic leg an entry may use, priced from the book this tick saw. */
export interface LegQuote {
  readonly leg: Outcome2;
  readonly side: "BUY" | "SELL";
  /** Exact money this leg costs to establish `size` shares of exposure. */
  readonly cost: string;
  /** Worst price consumed on this leg. */
  readonly worstPrice: string;
  /** The limit price the intent carries. */
  readonly limitPrice: string;
}

/**
 * Prices both economic legs and picks the cheaper one (§13.4 "YES/NO economic-
 * leg comparison with and without inventory"; §9.10 "select economic leg while
 * respecting actual available inventory").
 *
 * - The DIRECT leg buys the configured outcome token by consuming its asks.
 * - The COMPLEMENT leg sells the other outcome token by consuming its bids, and
 *   is considered ONLY when the instance already holds at least `size` shares of
 *   it. Selling inventory it owns needs no assumption about minting, splitting
 *   or short selling, and this package asserts none.
 * - The comparison is on exact TOTAL money for the same size: the complement
 *   leg's equivalent cost is `size - proceeds`, because one YES and one NO pay
 *   exactly 1 between them.
 * - A tie goes to the DIRECT leg, deterministically.
 */
export function chooseLeg(
  params: StaticBracketParams,
  observation: Observation,
  size: string,
): Outcome<{ readonly quote: LegQuote; readonly reasons: readonly string[] }> {
  const direction = params.market_selector.direction;
  const complementLeg: Outcome2 = direction === "YES" ? "NO" : "YES";
  const directWalk = walkForSize(observation.books[direction].asks, size);
  if (!directWalk.ok) return directWalk;

  let direct: LegQuote | null = null;
  if (directWalk.value.outcome === "CONSUMED") {
    direct = {
      leg: direction,
      side: "BUY",
      cost: directWalk.value.totalMoney,
      worstPrice: directWalk.value.worstPrice,
      limitPrice: params.entry.execution.maximum_buy_price,
    };
  }

  if (params.entry.economic_leg_policy === "DIRECT_ONLY") {
    if (direct === null) {
      return { ok: false, problem: "insufficient ask depth on the direct leg" };
    }
    return ok({ quote: direct, reasons: [REASONS.entryLegDirect] });
  }

  const inventory = heldShares(observation, complementLeg);
  const enoughInventory = greaterOrEqual(inventory, size, "complement inventory");
  if (!enoughInventory.ok) return enoughInventory;
  if (!enoughInventory.value) {
    if (direct === null) {
      return { ok: false, problem: "insufficient ask depth on the direct leg" };
    }
    return ok({
      quote: direct,
      reasons: [REASONS.entryLegComplementUnavailable, REASONS.entryLegDirect],
    });
  }

  const complementWalk = walkForSize(observation.books[complementLeg].bids, size);
  if (!complementWalk.ok) return complementWalk;
  if (complementWalk.value.outcome !== "CONSUMED") {
    if (direct === null) {
      return { ok: false, problem: "insufficient depth on both legs" };
    }
    return ok({ quote: direct, reasons: [REASONS.entryLegDirect] });
  }
  const equivalentCost = sub(size, complementWalk.value.totalMoney, "complement leg cost");
  if (!equivalentCost.ok) return equivalentCost;
  const complementFloor = complement(
    params.entry.execution.maximum_buy_price,
    "complement floor",
  );
  if (!complementFloor.ok) return complementFloor;
  const complementQuote: LegQuote = {
    leg: complementLeg,
    side: "SELL",
    cost: equivalentCost.value,
    worstPrice: complementWalk.value.worstPrice,
    limitPrice: complementFloor.value,
  };
  if (direct === null) {
    return ok({ quote: complementQuote, reasons: [REASONS.entryLegComplement] });
  }
  const ordering = compare(complementQuote.cost, direct.cost, "leg comparison");
  if (!ordering.ok) return ordering;
  if (ordering.value < 0) {
    return ok({ quote: complementQuote, reasons: [REASONS.entryLegComplement] });
  }
  return ok({ quote: direct, reasons: [REASONS.entryLegDirect] });
}

function planEntry(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  timeToCloseMs: number | null,
  carried: readonly string[],
): Plan {
  const reasons = [...carried];

  if (state.entriesExecuted >= params.reentry.maximum_entries_per_market) {
    return plan(state, "hold", [...reasons, REASONS.refusedMaxEntries]);
  }
  if (state.closedAtMs !== null) {
    const elapsed = observation.nowMs - state.closedAtMs;
    if (elapsed < params.reentry.cooldown_seconds * 1000) {
      return plan(
        state,
        "hold",
        [...reasons, REASONS.refusedCooldown],
        [],
        null,
        state.closedAtMs + params.reentry.cooldown_seconds * 1000,
      );
    }
  }
  if (timeToCloseMs !== null && timeToCloseMs <= params.exit.entry_cutoff_before_close_seconds * 1000) {
    return plan(state, "hold", [...reasons, REASONS.refusedEntryCutoff]);
  }

  // The trigger is a FEATURE (§13.2 trigger_basis), read by the configured key.
  const triggerRead = readFeatureScalar(observation.features, params.entry.trigger_feature_key);
  if (triggerRead.kind === "UNUSABLE") {
    return plan(state, "hold", [...reasons, REASONS.refusedTriggerUnusable]);
  }
  if (triggerRead.kind === "ABSENT") {
    return plan(state, "hold", [...reasons, REASONS.refusedTriggerAbsent]);
  }
  const triggerPrice = readPrice(triggerRead.value, "entry trigger");
  if (!triggerPrice.ok) {
    return plan(state, "hold", [...reasons, REASONS.refusedTriggerUnusable]);
  }
  const triggered = lessOrEqual(triggerPrice.value, params.entry.trigger_price_lte, "entry trigger");
  if (!triggered.ok) {
    return plan(state, "hold", [...reasons, REASONS.refusedTriggerUnusable]);
  }
  if (!triggered.value) {
    return plan(state, "hold", [...reasons, REASONS.entryTriggerNotMet], [], {
      trigger: triggerPrice.value,
      triggerThreshold: params.entry.trigger_price_lte,
    });
  }
  reasons.push(REASONS.entryTriggerMet);

  const size = params.entry.size_shares;

  // Minimum order size and the tick grid are market facts, checked first
  // because they are the cheapest and are unconditional.
  const aboveMinimum = greaterOrEqual(size, observation.market.minimumOrderSize, "minimum size");
  if (!aboveMinimum.ok || !aboveMinimum.value) {
    return plan(state, "hold", [...reasons, REASONS.refusedMinimumOrderSize]);
  }

  const aggressive = params.entry.execution.convert_to_aggressive_after_ms === 0;
  const legChoice = aggressive
    ? chooseLeg(params, observation, size)
    : ok({
        quote: passiveQuote(params, size),
        reasons: [REASONS.entryLegDirect] as readonly string[],
      });
  if (!legChoice.ok) {
    return plan(state, "hold", [...reasons, REASONS.refusedParticipation], [], {
      depthProblem: legChoice.problem,
    });
  }
  const quote = legChoice.value.quote;
  reasons.push(...legChoice.value.reasons);

  const tickOk = onTickGrid(quote.limitPrice, observation.market.tickSize, "entry limit");
  if (!tickOk.ok || !tickOk.value) {
    return plan(state, "hold", [...reasons, REASONS.refusedTickGrid], [], {
      limitPrice: quote.limitPrice,
      tickSize: observation.market.tickSize,
    });
  }

  const guard = applyEntryCaps(params, observation, state, quote, size);
  if (guard !== null) {
    return plan(state, "hold", [...reasons, guard.reason], [], guard.outputs);
  }

  const edge = expectedNetEdge(params, quote.cost, size);
  if (!edge.ok) {
    return plan(state, "hold", [...reasons, REASONS.internalRefusal]);
  }
  const edgeSufficient = greaterOrEqual(
    edge.value,
    params.entry.economics.minimum_expected_net_edge,
    "expected net edge",
  );
  if (!edgeSufficient.ok) {
    return plan(state, "hold", [...reasons, REASONS.internalRefusal]);
  }
  if (!edgeSufficient.value) {
    return plan(state, "hold", [...reasons, REASONS.refusedEdge], [], {
      expectedNetEdge: edge.value,
      minimumExpectedNetEdge: params.entry.economics.minimum_expected_net_edge,
    });
  }

  const validUntil = formatInstantMs(
    observation.nowMs + params.entry.execution.order_validity_ms,
    "validUntil",
  );
  if (!validUntil.ok) {
    return plan(state, "hold", [...reasons, REASONS.internalRefusal]);
  }

  const id = intentId(state, "entry", observation.market.marketId);
  const targetShares = quote.side === "BUY" ? size : `-${size}`;
  const intent: Intent = {
    type: "POSITION",
    intentId: id,
    marketId: observation.market.marketId,
    direction: quote.leg,
    targetMode: "DELTA",
    targetShares,
    ...(quote.side === "BUY"
      ? { maximumBuyPrice: quote.limitPrice, maximumTotalCost: params.entry.maximum_total_cost }
      : { minimumSellPrice: quote.limitPrice }),
    urgency: aggressive ? "IMMEDIATE" : "PASSIVE",
    liquidityPreference: params.entry.execution.liquidity_preference,
    partialFillPolicy: params.entry.execution.partial_fill_policy,
    ...(params.entry.execution.partial_fill_policy === "ACCEPT_MINIMUM"
      ? { minimumFillShares: params.entry.execution.minimum_fill_shares }
      : {}),
    validUntil: validUntil.value,
    expectedNetEdge: edge.value,
    tags: Object.freeze([
      TAGS.strategy,
      TAGS.entry,
      legTag(quote.leg),
      orderTypeTag(params.entry.execution.immediate_order_type),
    ]),
  };

  const track: OrderTrack = Object.freeze({
    kind: "ENTRY",
    intentId: id,
    orderId: null,
    state: "PENDING" as OrderState,
    outcome: quote.leg,
    side: quote.side,
    limitPrice: quote.limitPrice,
    requestedShares: size,
    filledShares: ZERO,
    viewFilledShares: ZERO,
    placedAtMs: observation.nowMs,
    escalated: aggressive,
  });
  // MOVE-SITE: entryTriggerMet
  const moved = move(state, "ENTRY_TRIGGER_MET", {
    entryOrder: track,
    intentSequence: state.intentSequence + 1,
    legOutcome: quote.leg,
  });
  if (!moved.ok) {
    return halted(state, moved.problem, []);
  }
  reasons.push(REASONS.entryIntentEmitted);
  return plan(
    moved.value,
    "enter",
    reasons,
    [intent],
    {
      trigger: triggerPrice.value,
      entryCost: quote.cost,
      worstPrice: quote.worstPrice,
      expectedNetEdge: edge.value,
    },
    observation.nowMs + params.entry.execution.submission_unknown_after_ms,
  );
}

/** The resting entry quote when the configuration asks for a maker order. */
function passiveQuote(params: StaticBracketParams, size: string): LegQuote {
  const cost = mul(params.entry.execution.passive_price, size, "passive cost");
  return {
    leg: params.market_selector.direction,
    side: "BUY",
    cost: cost.ok ? cost.value : ZERO,
    worstPrice: params.entry.execution.passive_price,
    limitPrice: params.entry.execution.passive_price,
  };
}

interface CapRefusal {
  readonly reason: string;
  readonly outputs: Readonly<Record<string, string | boolean | null>>;
}

/**
 * The §13.2 `risk` block, applied as REFUSALS rather than as resizers.
 *
 * A Static Bracket trades a fixed configured size; silently shrinking an order
 * to fit a cap would make the emitted intent something the operator never
 * configured, and §7.7 is explicit that a resize is a new record linked to the
 * original rather than a mutation. So every cap here answers yes or no.
 */
function applyEntryCaps(
  params: StaticBracketParams,
  observation: Observation,
  state: StaticBracketState,
  quote: LegQuote,
  size: string,
): CapRefusal | null {
  // `maximum_position_shares` caps the DIRECTIONAL exposure this instance will
  // hold, not the inventory of whichever token the chosen leg happens to
  // trade. The two legs are two execution routes to the same exposure — that
  // is what makes an economic-leg comparison meaningful — so the projection is
  // the same for both: what the instance already holds in the configured
  // direction, plus the size it is about to establish. Measuring the
  // COMPLEMENT leg's inventory instead would refuse an entry precisely because
  // the instance had the inventory that made the cheaper leg available.
  const held = heldShares(observation, params.market_selector.direction);
  const projected = add(held, size, "projected position");
  if (!projected.ok) {
    return { reason: REASONS.internalRefusal, outputs: { problem: projected.problem } };
  }
  const withinPosition = lessOrEqual(
    projected.value,
    params.risk.maximum_position_shares,
    "maximum position",
  );
  if (!withinPosition.ok || !withinPosition.value) {
    return {
      reason: REASONS.refusedPositionCap,
      outputs: { projectedShares: projected.value, cap: params.risk.maximum_position_shares },
    };
  }
  const withinCost = lessOrEqual(quote.cost, params.entry.maximum_total_cost, "maximum total cost");
  if (!withinCost.ok || !withinCost.value) {
    return {
      reason: REASONS.refusedCostCap,
      outputs: { cost: quote.cost, cap: params.entry.maximum_total_cost },
    };
  }
  // Worst-case contractual loss for a long outcome-token position is bounded by
  // what was paid for it, because an outcome payout is never negative. This is
  // a BOUND, not a payoff model; §9.3 owns payoff models and this package
  // asserts nothing about any series' settlement rules.
  const withinLoss = lessOrEqual(
    quote.cost,
    params.risk.maximum_contractual_loss,
    "maximum contractual loss",
  );
  if (!withinLoss.ok || !withinLoss.value) {
    return {
      reason: REASONS.refusedContractualLoss,
      outputs: { worstCaseLoss: quote.cost, cap: params.risk.maximum_contractual_loss },
    };
  }
  // Slippage: what the worst consumed price costs above the trigger threshold,
  // over the whole size. Exact, and zero when the whole size fills at or better
  // than the threshold.
  const slippage = slippageMoney(params, quote, size);
  if (!slippage.ok) {
    return { reason: REASONS.internalRefusal, outputs: { problem: slippage.problem } };
  }
  const withinSlippage = lessOrEqual(slippage.value, params.risk.maximum_slippage, "maximum slippage");
  if (!withinSlippage.ok || !withinSlippage.value) {
    return {
      reason: REASONS.refusedSlippage,
      outputs: { slippage: slippage.value, cap: params.risk.maximum_slippage },
    };
  }
  // Book participation: the configured size against the depth actually resting
  // at or better than the limit on the side this leg consumes.
  const depth =
    quote.side === "BUY"
      ? askDepthUpTo(observation.books[quote.leg], quote.limitPrice)
      : bidDepthDownTo(observation.books[quote.leg], quote.limitPrice);
  if (!depth.ok) {
    return { reason: REASONS.internalRefusal, outputs: { problem: depth.problem } };
  }
  const allowed = mul(params.risk.maximum_book_participation, depth.value, "participation");
  if (!allowed.ok) {
    return { reason: REASONS.internalRefusal, outputs: { problem: allowed.problem } };
  }
  const withinParticipation = lessOrEqual(size, allowed.value, "participation");
  if (!withinParticipation.ok || !withinParticipation.value) {
    return {
      reason: REASONS.refusedParticipation,
      outputs: { depth: depth.value, allowedShares: allowed.value },
    };
  }
  return null;
}

function slippageMoney(
  params: StaticBracketParams,
  quote: LegQuote,
  size: string,
): Outcome<string> {
  // ONE reference for BOTH legs: `trigger_price_lte * size`, the money the
  // configured threshold says this exposure should cost.
  //
  // `LegQuote.cost` is already YES-EQUIVALENT money on both legs — `chooseLeg`
  // records the complement leg's cost as `size - proceeds` precisely so the two
  // legs are comparable — so complementing the reference for the SELL leg would
  // measure a direction-denominated cost against a complement-denominated
  // price. The correct sell-leg measure, `(1 - t) * size - proceeds`, reduces
  // algebraically to `cost - t * size`: the same expression, with the same
  // reference. Complementing it made an identically-priced complement leg pass a
  // cap the direct leg failed.
  const referenceCost = mul(params.entry.trigger_price_lte, size, "slippage reference cost");
  if (!referenceCost.ok) return referenceCost;
  const excess = sub(quote.cost, referenceCost.value, "slippage");
  if (!excess.ok) return excess;
  const sign = compare(excess.value, ZERO, "slippage");
  if (!sign.ok) return sign;
  return ok(sign.value <= 0 ? ZERO : excess.value);
}

/**
 * Expected net edge, in money, over the whole configured size:
 *
 *     takeProfitPrice * size - entryCost - (entryFee + exitFee) * size
 *
 * The fee rates are CONFIGURED (`entry.economics`); this package asserts no
 * venue fee schedule, which is a versioned venue fact owned elsewhere
 * (§6 invariant 9).
 */
export function expectedNetEdge(
  params: StaticBracketParams,
  entryCost: string,
  size: string,
): Outcome<string> {
  const proceeds = mul(params.exit.take_profit.price, size, "expected proceeds");
  if (!proceeds.ok) return proceeds;
  const feeRate = add(
    params.entry.economics.entry_fee_per_share,
    params.entry.economics.exit_fee_per_share,
    "fee rate",
  );
  if (!feeRate.ok) return feeRate;
  const fees = mul(feeRate.value, size, "fees");
  if (!fees.ok) return fees;
  const gross = sub(proceeds.value, entryCost, "gross edge");
  if (!gross.ok) return gross;
  return sub(gross.value, fees.value, "net edge");
}

// ---------------------------------------------------------------------------
// Entry order management
// ---------------------------------------------------------------------------

function planEntryOrderManagement(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  timeToCloseMs: number | null,
  carried: readonly string[],
): Plan {
  const reasons = [...carried];
  const track = state.entryOrder;
  if (track === null) {
    // A planned entry with nothing tracked cannot be managed. WHICH edge that is
    // depends on whether anything was allocated: with no confirmed allocation
    // nothing executed and the entry is abandoned (§13.3 rule 3 does not count
    // it); with an allocation on the books it is NOT an abandonment, and saying
    // so would return the instance to ARMED holding a position it could then
    // enter on top of. The allocation is final at its confirmed size, which is
    // the ENTRY_ORDER_TERMINAL_PARTIAL edge.
    const trigger: InstanceTrigger = isZero(openShares(state))
      ? "ENTRY_ABANDONED"
      : "ENTRY_ORDER_TERMINAL_PARTIAL";
    // MOVE-SITE: entryAbandoned
    const moved = move(state, trigger);
    return moved.ok
      ? plan(moved.value, "hold", [...reasons, REASONS.entryOrderTerminal])
      : halted(state, moved.problem, []);
  }

  // Adopt an order id if the OMS has surfaced one for our leg and side.
  const adopted = adoptOrder(state, observation, "ENTRY");
  const current = syncPlannedToWorking(
    adopted === null ? state : withState(state, { entryOrder: adopted }),
    "ENTRY",
  );

  // An order the OMS reports as already terminal is settled HERE, through the
  // one routine that knows the bracket transition — never left to fall through
  // to a state the machine has no edge out of.
  const settled = settleTerminalOrder(current, "ENTRY");
  if (settled !== null) {
    return plan(settled.state, "hold", [...reasons, ...settled.reasons]);
  }

  const live = current.entryOrder as OrderTrack;

  if (live.state === "PENDING") {
    const silentMs = observation.nowMs - live.placedAtMs;
    if (silentMs >= params.entry.execution.submission_unknown_after_ms) {
      const moved = moveOrder(live, "SILENCE_EXCEEDED");
      if (moved.ok) {
        // §6 invariant 6: unknown is NEVER a rejection. No re-entry, no cancel
        // by id we do not have, no aggressive replacement — hold and wait for
        // reconciliation.
        return plan(
          withState(current, { entryOrder: moved.value }),
          "hold",
          [...reasons, REASONS.entrySubmissionUnknown, REASONS.entryAwaitingReconciliation],
          [],
          { submissionUnknown: true },
        );
      }
    }
    return plan(
      current,
      "hold",
      [...reasons, REASONS.entryAwaitingReconciliation],
      [],
      null,
      live.placedAtMs + params.entry.execution.submission_unknown_after_ms,
    );
  }

  if (live.state === "SUBMISSION_UNKNOWN") {
    return plan(current, "hold", [
      ...reasons,
      REASONS.entrySubmissionUnknown,
      REASONS.entryAwaitingReconciliation,
    ]);
  }

  if (live.state === "WORKING") {
    // The market's tick size may change while an order rests (§13.4). A resting
    // price that is no longer on the grid cannot be amended by a strategy: it
    // cancels, and the next evaluation re-plans on the new grid.
    const onGrid = onTickGrid(live.limitPrice, observation.market.tickSize, "resting price");
    if (onGrid.ok && !onGrid.value) {
      return cancelEntry(
        current,
        observation,
        [...reasons, REASONS.tickSizeChanged],
        `resting price ${live.limitPrice} is no longer on the ${observation.market.tickSize} tick grid`,
      );
    }
    // Entry cutoff reached while resting: withdraw rather than carry an order
    // into the close.
    if (timeToCloseMs !== null && timeToCloseMs <= params.exit.entry_cutoff_before_close_seconds * 1000) {
      return cancelEntry(
        current,
        observation,
        [...reasons, REASONS.refusedEntryCutoff],
        "entry cutoff reached while the entry order was resting",
      );
    }
    // MAKER_PREFERRED escalation (§13.2 convert_to_aggressive_after_ms).
    if (
      !live.escalated &&
      params.entry.execution.convert_to_aggressive_after_ms > 0 &&
      observation.nowMs - live.placedAtMs >= params.entry.execution.convert_to_aggressive_after_ms
    ) {
      return cancelEntry(
        current,
        observation,
        [...reasons, REASONS.entryEscalated],
        "converting the resting entry to an aggressive order",
        true,
      );
    }
    return plan(
      current,
      "hold",
      [...reasons, REASONS.entryOrderWorking],
      [],
      null,
      live.escalated
        ? null
        : live.placedAtMs + params.entry.execution.convert_to_aggressive_after_ms,
    );
  }

  // Every remaining order state is terminal and was settled above, so this is
  // unreachable in practice; it holds rather than inventing a transition.
  return plan(current, "hold", [...reasons, REASONS.entryOrderWorking]);
}

/**
 * Cancels the working entry order. When `escalate` is set, the replacement is
 * planned on a later evaluation — never in the same decision as the cancel,
 * because §6 invariant 13 makes a safety cancel outrank a new placement and a
 * simultaneous replace would double the exposure if the cancel lost the race.
 */
function cancelEntry(
  state: StaticBracketState,
  observation: Observation,
  reasons: readonly string[],
  detail: string,
  escalate = false,
): Plan {
  const track = state.entryOrder;
  if (track === null) {
    return plan(state, "hold", reasons);
  }
  const moved = moveOrder(track, "CANCEL_REQUESTED");
  if (!moved.ok) {
    return halted(state, moved.problem, []);
  }
  const next = withState(state, {
    entryOrder: Object.freeze({ ...moved.value, escalated: escalate ? true : track.escalated }),
  });
  return plan(next, "cancel", [...reasons, REASONS.safetyCancel], [
    cancelIntent(
      observation.market.marketId,
      [track.orderId ?? ""],
      `static-bracket: ${detail}`,
    ),
  ]);
}

/**
 * Finds an order view that belongs to a tracked intent.
 *
 * Matching is by leg and side, with the lexicographically smallest order id
 * winning a tie, so the choice is deterministic and independent of the order in
 * which the composition root lists orders.
 *
 * It records `viewFilledShares` as well as the id and the sub-machine state. An
 * adopted order may be terminal on arrival, and whether it EXECUTED anything is
 * the difference between returning the instance to ARMED and waiting for a fill
 * that is already on its way (§8.1). Adoption is not where that is decided —
 * {@link settleTerminalOrder} is — but it is where the evidence is captured.
 */
function adoptOrder(
  state: StaticBracketState,
  observation: Observation,
  kind: "ENTRY" | "EXIT",
): OrderTrack | null {
  const track = kind === "ENTRY" ? state.entryOrder : state.exitOrder;
  if (track === null || track.orderId !== null) return null;
  const other = kind === "ENTRY" ? state.exitOrder : state.entryOrder;
  const taken = other?.orderId ?? null;
  for (const view of observation.orders) {
    if (view.orderId === taken) continue;
    if (view.outcome !== track.outcome || view.side !== track.side) continue;
    const moved = orderTransition(track.state, statusTrigger(view.status));
    return Object.freeze({
      ...track,
      orderId: view.orderId,
      state: moved.ok ? moved.to : track.state,
      viewFilledShares: view.filledShares,
    });
  }
  return null;
}

/** What settling one terminal tracked order did to the bracket. */
interface Settlement {
  readonly state: StaticBracketState;
  readonly reasons: readonly string[];
}

/**
 * The ONE place a tracked order's arrival in a terminal state is turned into a
 * bracket transition.
 *
 * Two callers reach it — the per-evaluation ladder (an order the OMS listed as
 * already terminal) and `onOrderUpdate` (an order that just became terminal) —
 * and they must agree, because a terminal order settled on one path and not the
 * other is how a bracket ends up in a `(bracket state, order state)` pair the
 * §13.3 machine has no edge out of. Before this existed, an order adopted
 * straight into `REJECTED` from `ENTRY_PLANNED` reached
 * `ENTRY_PLANNED --ENTRY_ORDER_TERMINAL_UNFILLED-->`, which the table did not
 * contain, and the instance HALTED on the §13.2 example's most ordinary failure.
 *
 * `null` means the tracked order is absent or still live: nothing to settle.
 *
 * THE ENTRY CASE HAS THREE OUTCOMES, not two:
 *
 * 1. A fill has been FOLDED (`filledShares > 0`) — the allocation is real and
 *    final at that size, so the bracket opens at it.
 * 2. Nothing folded, but an ORDER VIEW reported a filled size
 *    (`viewFilledShares > 0`) — §8.1 guarantees no ordering between a view and
 *    its fill, so this is an execution whose fill has not arrived yet. The
 *    instance does NOT return to ARMED (that would discard a real execution and
 *    let the very next evaluation enter again, doubling the position): it keeps
 *    the order tracked and waits for the fill stream. The exit is still sized
 *    only from the fold when that fill lands — §13.3 rule 1 is not relaxed by
 *    this, and the view's number never becomes an allocation.
 * 3. Nothing folded and no evidence — nothing executed (§13.3 rule 3), so the
 *    instance returns to ARMED under the reentry policy.
 */
function settleTerminalOrder(
  state: StaticBracketState,
  kind: "ENTRY" | "EXIT",
): Settlement | null {
  const track = kind === "ENTRY" ? state.entryOrder : state.exitOrder;
  if (track === null || isLive(track.state) || track.state === "SUBMISSION_UNKNOWN") {
    return null;
  }

  if (kind === "ENTRY") {
    const folded = !isZero(track.filledShares);
    if (!folded && !isZero(track.viewFilledShares)) {
      return {
        state,
        reasons: [REASONS.entryOrderTerminal, REASONS.awaitingFillAllocation],
      };
    }
    if (!folded) {
      // MOVE-SITE: entryTerminalUnfilled
      const moved = move(state, "ENTRY_ORDER_TERMINAL_UNFILLED", { entryOrder: null });
      return {
        state: moved.ok ? moved.value : withState(state, { entryOrder: null }),
        reasons: [REASONS.entryOrderTerminal],
      };
    }
    if (
      state.instanceState === "PARTIALLY_OPEN" ||
      state.instanceState === "ENTRY_PLANNED" ||
      state.instanceState === "ENTRY_WORKING"
    ) {
      // MOVE-SITE: entryTerminalPartial
      const moved = move(state, "ENTRY_ORDER_TERMINAL_PARTIAL", { entryOrder: null });
      if (moved.ok) {
        return { state: moved.value, reasons: [REASONS.entryOrderTerminal] };
      }
    }
    return {
      state: withState(state, { entryOrder: null }),
      reasons: [REASONS.entryOrderTerminal],
    };
  }

  const cleared = withState(state, { exitOrder: null });
  const trigger: InstanceTrigger | null =
    state.instanceState === "EXIT_PLANNED"
      ? "EXIT_ABANDONED"
      : state.instanceState === "EXIT_WORKING"
        ? "EXIT_ORDER_TERMINAL_UNFILLED"
        : null;
  if (trigger !== null && !isZero(openShares(state))) {
    // The exit order is gone and the allocation is not: the position is open
    // again and re-plannable. The trigger differs by state because the §13.3
    // table names a different edge out of each.
    // MOVE-SITE: exitTerminal
    const moved = move(cleared, trigger);
    if (moved.ok) {
      return { state: moved.value, reasons: [REASONS.exitOrderTerminal] };
    }
  }
  return { state: cleared, reasons: [REASONS.exitOrderTerminal] };
}

/** Maps an SDK order status onto a sub-machine trigger. */
export function statusTrigger(status: string): OrderTrigger {
  switch (status) {
    case "OPEN":
      return "OBSERVED_WORKING";
    case "PARTIALLY_FILLED":
      return "OBSERVED_PARTIALLY_FILLED";
    case "FILLED":
      return "OBSERVED_FILLED";
    case "CANCELED":
      return "OBSERVED_CANCELED";
    case "REJECTED":
      return "OBSERVED_REJECTED";
    case "EXPIRED":
      return "OBSERVED_EXPIRED";
    default:
      // An unrecognized status is NOT read as a terminal state: §6 invariant 6's
      // reasoning applies to anything the strategy cannot interpret.
      return "OBSERVED_WORKING";
  }
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

/**
 * Is the configured stop trigger satisfied by what this evaluation can see?
 *
 * `null` means the question could not be answered (an unusable or absent
 * feature). The caller must treat `null` as "not triggered" for acting, and as
 * meaningful for reporting: a stop that cannot be evaluated is not a stop that
 * did not fire. A stop that cannot be READ MUST NEVER REDUCE: an absent, null
 * or wrong-typed stop feature answers `null`, never `true`.
 *
 * THE TRIGGER IS DIRECTION-DENOMINATED ON BOTH LEGS. INTERPRETATION, and the
 * reasoning is the same one §13.2 already applies to `entry.trigger_price_lte`:
 * that threshold is compared against the configured trigger feature and the
 * economic leg is chosen AFTERWARDS, without re-expressing the threshold, so a
 * configured price in this grammar means a price in `market_selector.direction`
 * terms. `exit.stop.trigger_price_lte` is read the same way. The composition
 * root owns the projection from a structured feature to the configured key
 * (`features.ts`), and this package refuses to guess which outcome's book a
 * projected key reads; what it fixes is that whatever the key reports is
 * compared in the CONFIGURED DIRECTION's terms on both legs. Only the
 * EXECUTABLE prices — the take-profit limit and the reduction floor — are
 * re-expressed per leg, by {@link executableExitPrice}.
 */
export function stopTriggerSatisfied(
  params: StaticBracketParams,
  observation: Observation,
): boolean | null {
  if (!params.exit.stop.enabled) return false;
  const read = readFeatureScalar(observation.features, params.exit.stop.trigger_feature_key);
  if (read.kind !== "VALUE") return null;
  const price = readPrice(read.value, "stop trigger");
  if (!price.ok) return null;
  const triggered = lessOrEqual(price.value, params.exit.stop.trigger_price_lte, "stop trigger");
  return triggered.ok ? triggered.value : null;
}

/**
 * §6 invariant 12, as a precondition, in two strengths because the two exit
 * shapes need different things to be true:
 *
 * - `positionAgrees` (EQUALITY) gates a REDUCE_POSITION to flat. That intent
 *   acts on the whole position, so flattening while the virtual position
 *   disagrees with the confirmed allocation would either sell shares the
 *   instance never allocated or believe it closed something it did not.
 * - `positionCovers` (AT LEAST) gates the DELTA-sized take-profit, whose size
 *   comes from the instance's own allocation. Unwinding N of an exposure of N or
 *   more is safe; unwinding N of an exposure of less is not.
 *
 * Both are measured on {@link legExposure} — the instance's OWN exposure, net of
 * the inventory the bracket started from — and NOT on the raw holding. That is
 * what makes them mean the same thing on both economic legs: a complement-leg
 * bracket is SHORT the token it trades against an inventory it did not create,
 * so "held >= the size we are about to trade" would be answered by that
 * inventory rather than by the bracket, and would wave through an exit for a
 * short that does not exist.
 *
 * Both read the position view supplied WITH the evaluation. §8.1 orders the
 * loop "update local market/account state -> update feature snapshots -> invoke
 * subscribed strategies", so the view an `onFill` evaluation sees must already
 * include that fill. That is a composition-root obligation (WP-230), recorded
 * in this package's README: a wiring that lags the position behind the fill
 * stream will see this gate refuse exits it should have allowed.
 */
function positionAgrees(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
): Outcome<boolean> {
  const expected = openShares(state);
  const exposure = legExposure(params, state, observation);
  if (!exposure.ok) return exposure;
  const ordering = compare(exposure.value, expected, "position agreement");
  if (!ordering.ok) return ordering;
  return ok(ordering.value === 0);
}

function positionCovers(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
): Outcome<boolean> {
  const expected = openShares(state);
  const exposure = legExposure(params, state, observation);
  if (!exposure.ok) return exposure;
  const ordering = compare(exposure.value, expected, "position coverage");
  if (!ordering.ok) return ordering;
  return ok(ordering.value >= 0);
}

function planExit(
  params: StaticBracketParams,
  incoming: StaticBracketState,
  observation: Observation,
  timeToCloseMs: number | null,
  carried: readonly string[],
): Plan {
  const reasons = [...carried];
  // Adopt an exit order the OMS has surfaced, and let the bracket follow the
  // sub-machine into EXIT_WORKING (§13.3's own edge).
  const adopted = adoptOrder(incoming, observation, "EXIT");
  const synced = syncPlannedToWorking(
    adopted === null ? incoming : withState(incoming, { exitOrder: adopted }),
    "EXIT",
  );
  // An exit order the OMS reports as already terminal is settled BEFORE the
  // ladder rather than after it, and the ladder then runs on the settled state
  // in the SAME evaluation. Deferring it to the next evaluation would delay a
  // stop by a tick; halting on it — which is what an unsettled terminal order
  // used to do — abandoned the position permanently.
  const settlement = settleTerminalOrder(synced, "EXIT");
  const state = settlement === null ? synced : settlement.state;
  if (settlement !== null) reasons.push(...settlement.reasons);
  const leg = currentLeg(params, state);
  const open = openShares(state);

  if (isZero(open)) {
    // Nothing is held: the bracket is finished. The trigger differs by state so
    // that every edge taken is one the §13.3 table actually contains.
    const trigger: InstanceTrigger =
      state.instanceState === "EXIT_PLANNED" || state.instanceState === "EXIT_WORKING"
        ? "EXIT_FILL_COMPLETE"
        : "POSITION_FLAT";
    // MOVE-SITE: bracketFinished
    const moved = move(state, trigger, {
      closedAtMs: observation.nowMs,
      exitOrder: null,
    });
    if (moved.ok) {
      return plan(moved.value, "hold", [...reasons, REASONS.closed]);
    }
    return plan(state, "hold", [...reasons, REASONS.idle]);
  }

  // 1. End of market: the explicit configured policy (§13.3 rule 5).
  if (timeToCloseMs !== null && timeToCloseMs <= params.exit.exit_cutoff_before_close_seconds * 1000) {
    return planFinalPolicy(params, state, observation, [...reasons, REASONS.exitCutoff], leg, open);
  }

  // 2. Stop.
  const stopped = stopTriggerSatisfied(params, observation);
  if (stopped === true) {
    return planProtectedReduce(
      params,
      state,
      observation,
      [...reasons, REASONS.stopTriggered],
      leg,
      open,
      "stop trigger",
    );
  }

  // 3. Holding timeout.
  if (
    state.openedAtMs !== null &&
    observation.nowMs - state.openedAtMs >= params.exit.maximum_holding_seconds * 1000
  ) {
    return planProtectedReduce(
      params,
      state,
      observation,
      [...reasons, REASONS.holdingTimeout],
      leg,
      open,
      "maximum holding time",
    );
  }

  // 4. Take-profit maintenance, sized to the ACTUAL allocation.
  return planTakeProfit(params, state, observation, reasons, leg, open);
}

/**
 * The take-profit exit. Its size is the confirmed allocation minus what has
 * already exited — §13.3 rule 1, "exit size equals actual allocated filled
 * size" — and never the requested entry size.
 *
 * When the allocation GROWS while a take-profit rests, the resting order is
 * canceled first and replaced on a later evaluation. Cancel-then-replace, never
 * both in one decision: §6 invariant 13.
 *
 * ITS SIDE IS THE ENTRY'S OPPOSITE. A direct-leg bracket bought the token and
 * takes profit by SELLING it at `exit.take_profit.price`. A complement-leg
 * bracket SOLD a token it owned and takes profit by BUYING THAT TOKEN BACK, at
 * the complement of the same configured price. Both reduce the bracket's
 * exposure toward zero; neither can enlarge it (see {@link LegPosture}).
 */
function planTakeProfit(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
  leg: Outcome2,
  open: string,
): Plan {
  const reasons = [...carried];
  const existing = state.exitOrder;
  if (existing !== null && isLive(existing.state)) {
    const matches = compare(existing.requestedShares, open, "take-profit size");
    if (!matches.ok) {
      return halted(state, matches.problem, []);
    }
    if (matches.value === 0) {
      return plan(state, "hold", [...reasons, REASONS.exitOrderWorking]);
    }
    if (existing.state !== "WORKING") {
      // §6 invariant 13, ON PURPOSE and not as a side effect of a halt: a cancel
      // is already in flight (CANCEL_PENDING) or the order has never been seen
      // (PENDING). Either way no replacement may be placed until the withdrawal
      // is confirmed, so the instance holds and says what it is waiting for.
      return plan(state, "hold", [
        ...reasons,
        REASONS.exitOrderWorking,
        REASONS.awaitingCancel,
      ]);
    }
    const moved = moveOrder(existing, "CANCEL_REQUESTED");
    if (!moved.ok) {
      return halted(state, moved.problem, []);
    }
    return plan(
      withState(state, { exitOrder: moved.value }),
      "cancel",
      [...reasons, REASONS.takeProfitReplaced, REASONS.safetyCancel],
      [
        cancelIntent(
          observation.market.marketId,
          [existing.orderId ?? ""],
          `static-bracket: allocation changed from ${existing.requestedShares} to ${open}`,
        ),
      ],
    );
  }

  const covered = positionCovers(params, state, observation);
  if (!covered.ok) {
    return halted(state, covered.problem, []);
  }
  if (!covered.value) {
    return reconcilePlan(state, observation, reasons, leg);
  }

  const posture = legPosture(params, state);
  const limitPrice = executableExitPrice(posture, params.exit.take_profit.price);
  if (!limitPrice.ok) {
    return plan(state, "hold", [...reasons, REASONS.internalRefusal]);
  }
  const validUntil = formatInstantMs(
    observation.nowMs + params.entry.execution.order_validity_ms,
    "validUntil",
  );
  if (!validUntil.ok) {
    return plan(state, "hold", [...reasons, REASONS.internalRefusal]);
  }
  const id = intentId(state, "take-profit", observation.market.marketId);
  const intent: Intent = {
    type: "POSITION",
    intentId: id,
    marketId: observation.market.marketId,
    direction: leg,
    targetMode: "DELTA",
    // The DELTA's sign is the exit side: a direct bracket sells what it bought,
    // a complement bracket buys back what it sold. |delta| is the confirmed open
    // allocation and never more, so an exit can only shrink the exposure.
    targetShares: posture.exitSide === "SELL" ? `-${open}` : open,
    ...(posture.exitSide === "SELL"
      ? { minimumSellPrice: limitPrice.value }
      : { maximumBuyPrice: limitPrice.value }),
    urgency: "PASSIVE",
    liquidityPreference: params.exit.take_profit.liquidity_preference,
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: validUntil.value,
    tags: Object.freeze([TAGS.strategy, TAGS.takeProfit, legTag(leg)]),
  };
  const track: OrderTrack = Object.freeze({
    kind: "EXIT",
    intentId: id,
    orderId: null,
    state: "PENDING" as OrderState,
    outcome: leg,
    side: posture.exitSide,
    limitPrice: limitPrice.value,
    requestedShares: open,
    filledShares: ZERO,
    viewFilledShares: ZERO,
    placedAtMs: observation.nowMs,
    escalated: false,
  });
  // MOVE-SITE: takeProfitPlaced
  const moved = move(state, "EXIT_TRIGGER_MET", {
    exitOrder: track,
    intentSequence: state.intentSequence + 1,
  });
  if (!moved.ok) {
    return halted(state, moved.problem, []);
  }
  return plan(
    moved.value,
    "exit",
    [...reasons, REASONS.takeProfitPlaced, REASONS.exitProportional],
    [intent],
    {
      exitShares: open,
      allocatedShares: state.allocatedShares,
      exitSide: posture.exitSide,
      exitLimitPrice: limitPrice.value,
    },
  );
}

/**
 * A protected reduction (§9.9 `PROTECTED_REDUCE`): flatten this instance's
 * allocation under the configured price floor.
 *
 * `exit.stop.minimum_sell_price` and `exit.stop.urgency` are the floor and the
 * urgency of EVERY protected reduction this strategy emits — the stop trigger,
 * the holding timeout, and the end-of-market policy — while
 * `exit.stop.enabled` switches only the price TRIGGER. That is why those two
 * fields are required even when the stop trigger is disabled: a reduction
 * without a stated floor would be a blind market sale.
 *
 * ON THE COMPLEMENT LEG THE REDUCTION IS A BUY-BACK. The instance's attributed
 * position is the same in both cases — `open` shares of exposure in the
 * configured direction — and `targetShares: "0"` means the same thing in both:
 * flatten it. What differs is the executable side, and §7.7 gives
 * `ReducePositionIntent` both a `minimumSellPrice` and a `maximumBuyPrice` for
 * exactly that reason. A direct bracket sells its token no cheaper than
 * `exit.stop.minimum_sell_price`; a complement bracket buys its token back no
 * dearer than the complement of that floor, which is the same economic level.
 * Carrying the raw floor as a `minimumSellPrice` on a complement bracket would
 * describe selling still more of a token the instance is already short.
 */
function planProtectedReduce(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
  leg: Outcome2,
  open: string,
  cause: string,
): Plan {
  const reasons = [...carried];
  // Safety cancellation outranks new placement (§6 invariant 13): withdraw the
  // resting orders before asking for a reduction, and do not ask until the
  // withdrawal is confirmed.
  const withdrawal = withdrawResting(
    state,
    observation,
    reasons,
    `withdrawing resting orders before a protected reduction (${cause})`,
  );
  if (withdrawal !== null) {
    return withdrawal;
  }

  const agreed = positionAgrees(params, state, observation);
  if (!agreed.ok) {
    return halted(state, agreed.problem, []);
  }
  if (!agreed.value) {
    return reconcilePlan(state, observation, reasons, leg);
  }

  const posture = legPosture(params, state);
  const floor = executableExitPrice(posture, params.exit.stop.minimum_sell_price);
  if (!floor.ok) {
    return plan(state, "hold", [...reasons, REASONS.internalRefusal]);
  }
  const intent: Intent = {
    type: "REDUCE_POSITION",
    marketId: observation.market.marketId,
    targetShares: ZERO,
    urgency: params.exit.stop.urgency,
    ...(posture.exitSide === "SELL"
      ? { minimumSellPrice: floor.value }
      : { maximumBuyPrice: floor.value }),
    reason:
      `static-bracket protected reduce (${cause}): leg=${leg} side=${posture.exitSide} ` +
      `allocated=${open}`.slice(0, 2000),
  };
  // MOVE-SITE: protectedReduce
  const moved = move(state, "EXIT_TRIGGER_MET", { intentSequence: state.intentSequence + 1 });
  if (!moved.ok) {
    return halted(state, moved.problem, []);
  }
  return plan(
    moved.value,
    "reduce",
    [...reasons, REASONS.exitProportional, REASONS.finalProtectedReduce],
    [intent],
    { exitShares: open, floor: floor.value, exitSide: posture.exitSide },
  );
}

/**
 * Withdraws whatever this instance has resting, and answers `null` only when
 * there is nothing left to withdraw.
 *
 * The three cases are kept apart on purpose:
 *
 * - a WORKING order is cancelled now, and the order moves to `CANCEL_PENDING`;
 * - an order whose cancel is ALREADY pending (or which has never been seen) is
 *   not cancelled again — the instance holds and says it is waiting. Re-sending
 *   a cancel for an in-flight cancel adds venue traffic and, worse, makes the
 *   decision log read as though a new safety action had been taken;
 * - nothing resting answers `null`, which is the caller's licence to act.
 */
function withdrawResting(
  state: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
  detail: string,
): Plan | null {
  const live = workingOrders(state);
  if (live.length === 0) return null;
  const cancellable = live.filter((order) => order.state === "WORKING");
  if (cancellable.length === 0) {
    return plan(state, "hold", [...carried, REASONS.awaitingCancel]);
  }
  let next = state;
  for (const order of cancellable) {
    const moved = moveOrder(order, "CANCEL_REQUESTED");
    if (!moved.ok) continue;
    next =
      order.kind === "ENTRY"
        ? withState(next, { entryOrder: moved.value })
        : withState(next, { exitOrder: moved.value });
  }
  return plan(next, "cancel", [...carried, REASONS.safetyCancel], [
    cancelIntent(
      observation.market.marketId,
      cancellable.map((order) => order.orderId ?? ""),
      `static-bracket: ${detail}`,
    ),
  ]);
}

/** End-of-market behaviour: the explicit configured policy (§13.3 rule 5). */
function planFinalPolicy(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
  leg: Outcome2,
  open: string,
): Plan {
  const reasons = [...carried];
  switch (params.exit.final_policy) {
    case "PROTECTED_REDUCE":
      return planProtectedReduce(
        params,
        state,
        observation,
        [...reasons, REASONS.resolutionHoldDisallowed],
        leg,
        open,
        "exit cutoff before close",
      );
    case "HOLD_TO_RESOLUTION": {
      // Permitted only because `allow_resolution_hold` is true; the
      // configuration grammar refuses the contradictory combination outright.
      const held = [...reasons, REASONS.finalHoldToResolution, REASONS.resolutionHoldAllowed];
      const withdrawal = withdrawResting(
        state,
        observation,
        held,
        "holding to resolution, withdrawing resting orders",
      );
      return withdrawal ?? plan(state, "hold", held);
    }
    default: {
      const cancelOnly = [...reasons, REASONS.finalCancelOnly];
      const withdrawal = withdrawResting(
        state,
        observation,
        cancelOnly,
        "end-of-market cancel-only policy",
      );
      return withdrawal ?? plan(state, "hold", cancelOnly);
    }
  }
}

/**
 * The no-blind-flatten branch (§6 invariant 12): cancel, record the
 * disagreement, pause, and wait for reconciliation. No position action.
 */
function reconcilePlan(
  state: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
  leg: Outcome2,
): Plan {
  const reasons = [...carried, REASONS.positionMismatch, REASONS.noBlindFlatten];
  const live = workingOrders(state);
  const intents: Intent[] =
    live.length > 0
      ? [
          cancelIntent(
            observation.market.marketId,
            live.map((order) => order.orderId ?? ""),
            "static-bracket: virtual position disagrees with confirmed allocation; reconciling",
          ),
        ]
      : [];
  let next = state;
  for (const order of live) {
    if (order.state !== "WORKING") continue;
    const moved = moveOrder(order, "CANCEL_REQUESTED");
    if (!moved.ok) continue;
    next =
      order.kind === "ENTRY"
        ? withState(next, { entryOrder: moved.value })
        : withState(next, { exitOrder: moved.value });
  }
  // An instance that is ALREADY paused does not pause again: §13.3 draws no
  // PAUSED -> PAUSED edge, and re-recording `resumeTo` as PAUSED would leave the
  // instance with nowhere legal to resume into. It records the incident and
  // stays where it is, exactly as the data-quality branch does.
  if (next.instanceState === "PAUSED") {
    return plan(
      withState(next, { lastIncident: "position mismatch" }),
      intents.length > 0 ? "cancel" : "hold",
      [...reasons, REASONS.paused],
      intents,
      { expectedShares: openShares(state), heldShares: heldShares(observation, leg) },
    );
  }
  // MOVE-SITE: reconcilePause
  const paused = move(next, "PAUSE", {
    resumeTo: state.instanceState,
    lastIncident: "position mismatch",
  });
  if (!paused.ok) {
    return halted(next, paused.problem, intents);
  }
  return plan(
    paused.value,
    intents.length > 0 ? "cancel" : "hold",
    [...reasons, REASONS.paused],
    intents,
    { expectedShares: openShares(state), heldShares: heldShares(observation, leg) },
  );
}

// ---------------------------------------------------------------------------
// Re-entry
// ---------------------------------------------------------------------------

/**
 * Re-arming after a finished bracket (§13.2 `reentry`).
 *
 * WHAT IS PER-BRACKET AND WHAT IS PER-MARKET is the whole content of this
 * function, and getting it wrong is not a cosmetic error:
 *
 * - PER-BRACKET, and therefore RESET: the confirmed allocation and its cost, the
 *   exited size, the traded leg and the inventory baseline it was measured
 *   against, the holding clock, and both tracked orders. A bracket that
 *   inherited the previous one's allocation would never see a "first fill"
 *   again, so `entriesExecuted` would stop counting and
 *   `maximum_entries_per_market` would bound nothing (§13.3 rule 3); one that
 *   inherited `openedAtMs` would be force-exited by
 *   `maximum_holding_seconds` measured from a bracket that already closed.
 * - PER-MARKET, and therefore CARRIED: `entriesExecuted` (§13.3 rule 3 counts
 *   executions per MARKET), `closedAtMs` (the cool-down anchor), and
 *   `intentSequence` (the id source must stay monotone across the whole
 *   instance, or two brackets would emit the same intent id).
 */
function planRearm(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
): Plan {
  const reasons = [...carried];
  if (state.entriesExecuted >= params.reentry.maximum_entries_per_market) {
    return plan(state, "hold", [...reasons, REASONS.refusedMaxEntries]);
  }
  if (state.closedAtMs !== null) {
    const elapsed = observation.nowMs - state.closedAtMs;
    if (elapsed < params.reentry.cooldown_seconds * 1000) {
      return plan(
        state,
        "hold",
        [...reasons, REASONS.refusedCooldown],
        [],
        null,
        state.closedAtMs + params.reentry.cooldown_seconds * 1000,
      );
    }
  }
  // MOVE-SITE: rearm
  const moved = move(state, "REARM", {
    entryOrder: null,
    exitOrder: null,
    allocatedShares: ZERO,
    allocatedCost: ZERO,
    exitedShares: ZERO,
    legOutcome: null,
    legBaselineShares: ZERO,
    openedAtMs: null,
  });
  if (!moved.ok) {
    return plan(state, "hold", [...reasons, REASONS.idle]);
  }
  return plan(moved.value, "hold", [...reasons, REASONS.rearmed]);
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export interface ConfirmedFill {
  readonly orderId: string;
  readonly outcome: Outcome2;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
}

/**
 * One confirmed fill (§9.6 `StrategyFill`).
 *
 * ALLOCATION IS FOLDED ONLY HERE. `StrategyOrderView.filledShares` may run
 * ahead of the fill stream, and sizing an exit from it would name shares no
 * confirmed fill has allocated. §6 invariant 10 and §13.3 rule 1 both say the
 * exit quantity comes from confirmed actual allocation, so this fold is the only
 * writer of `allocatedShares` and `exitedShares`.
 */
export function planFill(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  fill: ConfirmedFill,
): Plan {
  if (state.instanceState === "HALTED") {
    return plan(state, "hold", [REASONS.halted]);
  }
  const entry = state.entryOrder;
  const exit = state.exitOrder;
  const isEntryFill =
    entry !== null &&
    (entry.orderId === fill.orderId ||
      (entry.orderId === null && fill.side === entry.side && fill.outcome === entry.outcome));
  const isExitFill =
    exit !== null &&
    (exit.orderId === fill.orderId ||
      (exit.orderId === null && fill.side === exit.side && fill.outcome === exit.outcome));

  if (isEntryFill && entry !== null) {
    return applyEntryFill(params, state, observation, fill, entry);
  }
  if (isExitFill && exit !== null) {
    return applyExitFill(params, state, observation, fill, exit);
  }
  // A fill the strategy cannot attribute to one of its own intents is exactly
  // the §6 invariant 7 case: unexplained activity. It is recorded and the
  // instance pauses rather than folding it into an allocation it did not ask
  // for.
  return reconcilePlan(state, observation, [REASONS.unattributedFill], currentLeg(params, state));
}

/**
 * An illegal transition observed while folding a FILL is not treated as a code
 * bug: it means the strategy's picture of its own position and the events it is
 * being handed disagree. §6 invariant 12's prescription for exactly that is
 * cancel and reconcile, so the instance pauses rather than halting or guessing.
 */
function refuseTransition(
  state: StaticBracketState,
  observation: Observation,
  leg: Outcome2,
): Plan {
  return reconcilePlan(state, observation, [REASONS.illegalTransition], leg);
}

function applyEntryFill(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  fill: ConfirmedFill,
  entry: OrderTrack,
): Plan {
  const money = mul(fill.price, fill.shares, "fill cost");
  if (!money.ok) return halted(state, money.problem, []);
  const allocated = add(state.allocatedShares, fill.shares, "allocated shares");
  if (!allocated.ok) return halted(state, allocated.problem, []);
  const cost = add(state.allocatedCost, money.value, "allocated cost");
  if (!cost.ok) return halted(state, cost.problem, []);
  const filled = add(entry.filledShares, fill.shares, "order fill");
  if (!filled.ok) return halted(state, filled.problem, []);

  const complete = greaterOrEqual(filled.value, entry.requestedShares, "fill completeness");
  if (!complete.ok) return halted(state, complete.problem, []);

  const orderMoved = foldFillIntoOrder(
    Object.freeze({
      ...entry,
      orderId: entry.orderId ?? fill.orderId,
      filledShares: filled.value,
    }),
    complete.value ? "OBSERVED_FILLED" : "OBSERVED_PARTIALLY_FILLED",
  );
  if (!orderMoved.ok) return refuseTransition(state, observation, fill.outcome);

  // §13.3 rule 3: maximum entries count actual EXECUTIONS. One entry order that
  // fills in five pieces is one execution, counted at its first fill. The test
  // is the CURRENT bracket's allocation, which `planRearm` resets — a counter
  // anchored on an allocation that outlived its bracket would stop counting
  // after the first one and leave `maximum_entries_per_market` unenforced.
  const firstFill = isZero(state.allocatedShares);

  // The inventory this bracket started from, recorded once, at the first fill.
  // §8.1 orders "update local market/account state -> ... -> invoke subscribed
  // strategies", so the position view of a fill evaluation already includes that
  // fill; subtracting the confirmed allocation from it recovers what was held
  // before. A composition root that lags the position behind the fill stream
  // makes this baseline low by the lag, which makes the exit gates REFUSE and
  // reconcile — the fail-closed direction.
  const baseline = firstFill
    ? entry.side === "BUY"
      ? sub(heldShares(observation, fill.outcome), allocated.value, "leg baseline")
      : add(heldShares(observation, fill.outcome), allocated.value, "leg baseline")
    : ok(state.legBaselineShares);
  if (!baseline.ok) return halted(state, baseline.problem, []);

  const changes: Partial<StaticBracketState> = {
    entryOrder: orderMoved.value,
    allocatedShares: allocated.value,
    allocatedCost: cost.value,
    legOutcome: fill.outcome,
    legBaselineShares: baseline.value,
    openedAtMs: state.openedAtMs ?? observation.nowMs,
    entriesExecuted: firstFill ? state.entriesExecuted + 1 : state.entriesExecuted,
  };
  // MOVE-SITE: entryFill
  const moved = move(
    state,
    complete.value ? "ENTRY_FILL_COMPLETE" : "ENTRY_PARTIAL_FILL",
    changes,
  );
  if (!moved.ok) {
    return refuseTransition(state, observation, fill.outcome);
  }
  const reasons = [REASONS.allocated];
  // The proportional exit is created only AFTER the allocation is recorded
  // (§13.3 rule 2), and only from a state where an exit is legal.
  const leg = fill.outcome;
  const open = openShares(moved.value);
  const quality = assessDataQuality(params, observation, leg);
  if (!quality.healthy) {
    return incidentPlan(params, moved.value, observation, quality, false);
  }
  return planTakeProfit(params, moved.value, observation, reasons, leg, open);
}

function applyExitFill(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  fill: ConfirmedFill,
  exit: OrderTrack,
): Plan {
  const exited = add(state.exitedShares, fill.shares, "exited shares");
  if (!exited.ok) return halted(state, exited.problem, []);
  const filled = add(exit.filledShares, fill.shares, "order fill");
  if (!filled.ok) return halted(state, filled.problem, []);
  const remaining = sub(state.allocatedShares, exited.value, "open shares");
  if (!remaining.ok) return halted(state, remaining.problem, []);
  const flat = isZero(remaining.value);
  const orderMoved = foldFillIntoOrder(
    Object.freeze({
      ...exit,
      orderId: exit.orderId ?? fill.orderId,
      filledShares: filled.value,
    }),
    flat ? "OBSERVED_FILLED" : "OBSERVED_PARTIALLY_FILLED",
  );
  if (!orderMoved.ok) return refuseTransition(state, observation, currentLeg(params, state));
  const changes: Partial<StaticBracketState> = {
    exitOrder: flat ? null : orderMoved.value,
    exitedShares: exited.value,
    ...(flat ? { closedAtMs: observation.nowMs } : {}),
  };
  // MOVE-SITE: exitFill
  const moved = move(state, flat ? "EXIT_FILL_COMPLETE" : "EXIT_PARTIAL_FILL", changes);
  if (!moved.ok) {
    return refuseTransition(state, observation, currentLeg(params, state));
  }
  return plan(moved.value, "hold", flat ? [REASONS.exitFilled, REASONS.closed] : [REASONS.exitFilled]);
}

// ---------------------------------------------------------------------------
// Order updates
// ---------------------------------------------------------------------------

export function planOrderUpdate(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  view: TrackedOrderView,
): Plan {
  if (state.instanceState === "HALTED") {
    return plan(state, "hold", [REASONS.halted]);
  }
  const kind = attributeOrder(state, view);
  if (kind === null) {
    return plan(state, "hold", [REASONS.idle]);
  }
  const track = kind === "ENTRY" ? (state.entryOrder as OrderTrack) : (state.exitOrder as OrderTrack);
  const moved = moveOrder(
    // `viewFilledShares` is EVIDENCE, not allocation: it records that the venue
    // says something executed, so a terminal order can be told apart from one
    // that executed nothing (§8.1 gives no ordering between a view and its
    // fill). The exit is still sized from the fold alone (§13.3 rule 1).
    Object.freeze({
      ...track,
      orderId: track.orderId ?? view.orderId,
      viewFilledShares: view.filledShares,
    }),
    statusTrigger(view.status),
  );
  if (!moved.ok) {
    // An illegal sub-machine transition means the strategy's picture of its own
    // order is wrong. It does not guess: it halts.
    return halted(state, moved.problem, []);
  }
  const reconciled = track.state === "SUBMISSION_UNKNOWN" && moved.value.state !== "SUBMISSION_UNKNOWN";
  const updated =
    kind === "ENTRY"
      ? withState(state, { entryOrder: moved.value })
      : withState(state, { exitOrder: moved.value });
  const next = syncPlannedToWorking(updated, kind);

  const reasons = [
    kind === "ENTRY" ? REASONS.entryOrderWorking : REASONS.exitOrderWorking,
    ...(reconciled ? [REASONS.entryReconciled] : []),
  ];

  // A terminal order changes the bracket state, and that is decided by the tick
  // ladder so the transition rules live in exactly one place.
  const terminal =
    moved.value.state === "CANCELED" ||
    moved.value.state === "REJECTED" ||
    moved.value.state === "EXPIRED" ||
    moved.value.state === "FILLED";
  if (!terminal) {
    return plan(next, "hold", reasons);
  }
  return finishOrder(next, kind, reasons);
}

function attributeOrder(
  state: StaticBracketState,
  view: TrackedOrderView,
): "ENTRY" | "EXIT" | null {
  const entry = state.entryOrder;
  const exit = state.exitOrder;
  if (entry !== null && entry.orderId === view.orderId) return "ENTRY";
  if (exit !== null && exit.orderId === view.orderId) return "EXIT";
  if (entry !== null && entry.orderId === null && entry.outcome === view.outcome && entry.side === view.side) {
    return "ENTRY";
  }
  if (exit !== null && exit.orderId === null && exit.outcome === view.outcome && exit.side === view.side) {
    return "EXIT";
  }
  return null;
}

/**
 * Moves the bracket on when a tracked order reaches a terminal state.
 *
 * It delegates to {@link settleTerminalOrder} so `onOrderUpdate` and the
 * per-evaluation ladder cannot disagree about what a terminal order means.
 */
function finishOrder(
  state: StaticBracketState,
  kind: "ENTRY" | "EXIT",
  carried: readonly string[],
): Plan {
  const settled = settleTerminalOrder(state, kind);
  if (settled === null) {
    return plan(state, "hold", [...carried]);
  }
  return plan(settled.state, "hold", [...carried, ...settled.reasons]);
}

// ---------------------------------------------------------------------------
// Closing and resolution
// ---------------------------------------------------------------------------

export function planClosing(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  secondsRemaining: number,
): Plan {
  return planTick({
    params,
    state,
    observation,
    closingSecondsRemaining: secondsRemaining,
  });
}

/**
 * The market resolved. Whether the strategy INTENDED to be holding is the
 * explicit `allow_resolution_hold` policy, and the decision records which case
 * this was — a permitted hold or an unintended one.
 */
export function planResolved(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
): Plan {
  const open = openShares(state);
  const reasons: string[] = [];
  if (!isZero(open)) {
    reasons.push(REASONS.resolvedWhileOpen);
    reasons.push(
      params.exit.allow_resolution_hold
        ? REASONS.resolutionHoldAllowed
        : REASONS.resolutionHoldDisallowed,
    );
  }
  // MOVE-SITE: marketResolved
  const moved = move(state, "MARKET_RESOLVED", {
    closedAtMs: observation.nowMs,
    entryOrder: null,
    exitOrder: null,
  });
  if (!moved.ok) {
    return plan(state, "hold", [...reasons, REASONS.closed]);
  }
  return plan(moved.value, "hold", [...reasons, REASONS.closed]);
}

/**
 * The run is stopping. Safety cancellation outranks everything (§6 invariant
 * 13), so a stopping instance withdraws its resting orders and takes no
 * position action whatsoever.
 */
export function planStop(
  state: StaticBracketState,
  observation: Observation,
  reason: string,
): Plan {
  const live = workingOrders(state);
  const intents: Intent[] =
    live.length > 0
      ? [
          cancelIntent(
            observation.market.marketId,
            live.map((order) => order.orderId ?? ""),
            `static-bracket stopping: ${reason}`,
          ),
        ]
      : [];
  let next = state;
  for (const order of live) {
    if (order.state !== "WORKING") continue;
    const moved = moveOrder(order, "CANCEL_REQUESTED");
    if (!moved.ok) continue;
    next =
      order.kind === "ENTRY"
        ? withState(next, { entryOrder: moved.value })
        : withState(next, { exitOrder: moved.value });
  }
  return plan(
    next,
    intents.length > 0 ? "cancel" : "hold",
    intents.length > 0 ? [REASONS.stopped, REASONS.safetyCancel] : [REASONS.stopped],
    intents,
  );
}

