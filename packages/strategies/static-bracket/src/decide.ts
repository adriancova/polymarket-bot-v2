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
 *     and reconciles instead of flattening. EVERY exit — take-profit and
 *     protected reduction alike — is a `POSITION` DELTA naming this bracket's
 *     own leg and no more than its own confirmed open allocation; see
 *     {@link planProtectedReduce} for why a §7.7 `REDUCE_POSITION`, whose
 *     `targetShares` is a per-side sell-down level for the WHOLE market, cannot
 *     express what a strategy that owns a slice of a market means.
 *  5. **End of market**, then **stop**, then **holding timeout**, then
 *     **take-profit maintenance** — the exits, most urgent first. Before them,
 *     an exit order the venue reports terminal is settled (and, while a view
 *     reports more executed than has been folded, WAITED on), and a protective
 *     reduction whose own intent provably expired unanswered is retired. While
 *     this bracket's own protective reduction is live every exit branch HOLDS:
 *     it is never re-emitted, re-sized or cancelled by the ladder
 *     (`BRACKET-1a`; see {@link holdForLiveReduce}).
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
import { bad, ok, type Outcome } from "./plain.js";
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
  // MOVE-SITE: syncPlannedToWorking TRIGGERS: ENTRY_ORDER_WORKING EXIT_ORDER_WORKING
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

// ---------------------------------------------------------------------------
// The role of an EXIT track (`BRACKET-1a`, D2)
// ---------------------------------------------------------------------------

/**
 * The two kinds of EXIT intent this strategy mints. {@link intentId} is called
 * with exactly these kinds, so the prefix every exit intent id carries and the
 * role {@link exitRole} reads back from it come from ONE constant and cannot
 * drift apart.
 */
const EXIT_INTENT_KINDS = Object.freeze({
  TAKE_PROFIT: "take-profit",
  PROTECTED_REDUCE: "protected-reduce",
} as const);

/**
 * What an EXIT order track is FOR.
 *
 * - `TAKE_PROFIT` — the resting maker exit {@link planTakeProfit} places and
 *   re-sizes. It is maintenance: it may be cancelled and replaced when the
 *   allocation moves, and it is withdrawn before a protective reduction.
 * - `PROTECTED_REDUCE` — the protective reduction {@link planProtectedReduce}
 *   places for the stop, the holding timeout or the close cutoff. It is
 *   STICKY (the user's ruling R3): once placed it runs to completion or to a
 *   terminal state; nothing in this package cancels it except the safety paths
 *   that cancel everything (data-quality incident, position reconciliation,
 *   `onStop`).
 */
export type ExitRole = keyof typeof EXIT_INTENT_KINDS;

/** The minted intent-id prefix of each exit role — `sb-<kind>-`. */
export const EXIT_ROLE_PREFIXES: Readonly<Record<ExitRole, string>> = Object.freeze({
  TAKE_PROFIT: `sb-${EXIT_INTENT_KINDS.TAKE_PROFIT}-`,
  PROTECTED_REDUCE: `sb-${EXIT_INTENT_KINDS.PROTECTED_REDUCE}-`,
});

/**
 * The role of an EXIT track, read from the strategy-minted prefix of its
 * `intentId`.
 *
 * WHY THE PREFIX AND NOT A FIELD. Both exits share the one `exitOrder` slot and
 * the §9.6 state document already records the intent id the strategy minted.
 * An explicit role field would change the document's shape — a
 * `STATIC_BRACKET_STATE_SCHEMA_VERSION` bump, and §9.6 then requires a new run —
 * to store a fact the document already holds. The price is that the role is
 * tied to the minted id FORMAT, which is why the format and this reader share
 * {@link EXIT_INTENT_KINDS}, and why a prefix this package did not mint is
 * REFUSED here rather than guessed: an unknown role would decide whether the
 * ladder may cancel the order, and a guess in either direction is wrong in one
 * of them.
 *
 * Refused (never defaulted): an ENTRY track, and an EXIT track whose id carries
 * no minted exit prefix — or, which the prefixes' disjointness rules out and
 * the pin in `bracket-1a-reduce-track.test.ts` asserts, more than one.
 */
export function exitRole(track: OrderTrack): Outcome<ExitRole> {
  if (track.kind !== "EXIT") {
    return bad(`an ${track.kind} track has no exit role (intent ${track.intentId})`);
  }
  const roles = (Object.keys(EXIT_ROLE_PREFIXES) as ExitRole[]).filter((role) =>
    track.intentId.startsWith(EXIT_ROLE_PREFIXES[role]),
  );
  const [role] = roles;
  if (roles.length !== 1 || role === undefined) {
    return bad(
      `the exit track's intent id ${JSON.stringify(track.intentId.slice(0, 80))} carries ` +
        `${roles.length === 0 ? "no" : "more than one"} minted exit prefix ` +
        `(${Object.values(EXIT_ROLE_PREFIXES).join(", ")}); its role is refused, not guessed`,
    );
  }
  return ok(role);
}

/**
 * The refusal an EXIT track with an unreadable role produces, or `null`.
 *
 * Every evaluation that reads roles ({@link planTick}, {@link planFill},
 * {@link planOrderUpdate}) asks this FIRST and halts on a refusal, so the helpers
 * below — {@link isProtectedReduce} and everything built on it — only ever see
 * a track whose role was proved. A halted instance takes no action (§6
 * invariant 12's direction): it cannot tell whether the order it holds may be
 * cancelled.
 */
function refusedExitRole(state: StaticBracketState): string | null {
  if (state.exitOrder === null) return null;
  const role = exitRole(state.exitOrder);
  return role.ok ? null : role.problem;
}

/** True for an EXIT track whose PROVED role is `PROTECTED_REDUCE`. */
function isProtectedReduce(track: OrderTrack | null): boolean {
  if (track === null || track.kind !== "EXIT") return false;
  const role = exitRole(track);
  return role.ok && role.value === "PROTECTED_REDUCE";
}

/**
 * The order states in which a protective reduction is still this bracket's
 * business: it may yet execute (PENDING, SUBMISSION_UNKNOWN, WORKING — partly
 * filled included), or a safety cancel of it is unconfirmed (CANCEL_PENDING).
 */
const REDUCE_LIVE_STATES: readonly OrderState[] = Object.freeze([
  "PENDING",
  "SUBMISSION_UNKNOWN",
  "WORKING",
  "CANCEL_PENDING",
]);

/** This bracket's own live protective reduction, if it has one (D3). */
function liveReduce(state: StaticBracketState): OrderTrack | null {
  const track = state.exitOrder;
  if (track === null || !isProtectedReduce(track)) return null;
  return REDUCE_LIVE_STATES.includes(track.state) ? track : null;
}

/**
 * True when NO order view and NO fill has ever named this track: it has no
 * venue order id (a LIVE view or a fill would have given it one — D5 and
 * {@link applyExitFill}), no confirmed fill and no view-reported fill.
 */
function neverNamed(track: OrderTrack): boolean {
  return track.orderId === null && isZero(track.filledShares) && isZero(track.viewFilledShares);
}

/** The instant a tracked intent's own `validUntil` names, as it was minted. */
function intentValidUntilMs(params: StaticBracketParams, track: OrderTrack): number {
  return track.placedAtMs + params.entry.execution.order_validity_ms;
}

/**
 * True while an ENTRY execution the venue has REPORTED is not yet FOLDED: the
 * entry track's view evidence (`viewFilledShares`) is ahead of its confirmed
 * fills (`filledShares`). §8.1 orders nothing between a view and its fill, so
 * this is an execution whose fill is on its way (`BRACKET-1a` r1, finding
 * BR1-H1).
 *
 * Three rules rest on it, all so that the awaited fill FOLDS when it lands:
 *
 * 1. {@link settleTerminalOrder} keeps a terminal entry track while it holds,
 *    so the late fill still matches it BY ORDER ID.
 * 2. No path in this file certifies the bracket CLOSED while it holds
 *    ({@link applyExitFill}, {@link planExit}, {@link planTick}'s market-closed
 *    shortcut): a bracket that has sold everything it has FOLDED has not sold
 *    everything it BOUGHT.
 * 3. The settlement of an exit ({@link settleTerminalOrder},
 *    {@link retireExpiredReduce}) does not move the bracket into `OPEN` while
 *    it holds, because §13.3 folds an entry fill out of the entry states,
 *    `PARTIALLY_OPEN` and the exit states — never out of `OPEN`.
 *
 * Before r1 the entry track was cleared as soon as anything had been folded,
 * the late fill matched no track, and once the reduction's own fill was
 * attributed (D1) the bracket reached a false CLOSED with shares still held.
 *
 * An incomparable pair is read the fail-safe way, as D6 reads the exit's:
 * waiting names nothing, closing on an allocation that may be short does.
 */
function entryExecutionUnfolded(state: StaticBracketState): boolean {
  const entry = state.entryOrder;
  if (entry === null) return false;
  const ordering = compare(entry.viewFilledShares, entry.filledShares, "entry fill evidence");
  return !ordering.ok || ordering.value > 0;
}

/**
 * The venue order type EVERY exit this strategy emits states for itself
 * (`RISK-2`, found only once GOV-2B blocker B2 stopped refusing these intents).
 *
 * THIS IS NOT THE DISPOSITION FIX, AND IT IS NOT A DISPOSITION SIGNAL.
 * `RISK-2` chose design (b): a protective reduction is recognized as an EXIT
 * CONSUMER-SIDE, inside `packages/risk`, from the parsed intent shape and the
 * supplied portfolio view (`intent-view.ts`, "Why a covered reducing POSITION
 * is an EXIT"). This strategy still emits `POSITION`, exactly as before —
 * design (a) was REJECTED, for the reasons {@link planProtectedReduce}'s header
 * already reproduced end to end. `packages/risk` never reads a tag's CONTENT —
 * the single place the word occurs there is `approved-intent.ts`'s
 * `NON_IDENTITY_KEYS`, a key-NAME exclusion from ADR-016 §2 identity checking —
 * so nothing below can make an intent an exit, and adding or removing this tag
 * changes no risk verdict. Its ONLY reader is a composition root's
 * `resolveTimeInForce`, which maps
 * `sb.order-type:` to a venue TIME-IN-FORCE and nothing else;
 * `apps/trader/src/pipeline.ts`'s rule that a composition root may never
 * re-derive DISPOSITION from tags is untouched and still right.
 *
 * It is here because clearing B2 exposed a SECOND, independent defect that B2
 * had been masking. With the exits finally reaching the venue, the venue
 * refused them for an unrelated reason — the wrong order type — so no exit
 * could be submitted either. The two fixes live in different packages because
 * the two defects do.
 *
 * WHY AN EXIT HAS TO SAY THIS AT ALL. A composition root resolves an intent's
 * time-in-force from the `sb.order-type:` tag FIRST and the instance's
 * configured `immediate_order_type` second. Until now only the ENTRY carried
 * the tag, so both exits fell through to the entry's `immediate_order_type` —
 * and §13.2's own example configures that `FAK`. §9.10's posture table makes a
 * `MAKER_ONLY` take-profit `REST`, and a `FAK` order cannot rest (venue report
 * §2.3: it cancels its remainder), so the simulated venue refused the
 * take-profit's submission outright with `SIMULATED_VENUE_PLAN_UNSUPPORTED`.
 * The same collision hits a `PROTECTED_REDUCE` configured `exit.stop.urgency:
 * NORMAL`, which §9.10 also plans `REST`. An order type the ENTRY configured
 * for an IMMEDIATE crossing is not a fact about an exit, and the intent is the
 * only place that can say so.
 *
 * WHY `GTC`, AND WHY THAT NEEDS NO POSTURE TEST HERE. `GTC` is correct under
 * BOTH postures, so this file does not replicate §9.10's table to pick one:
 *
 * - planned `REST` (the take-profit; a `NORMAL` reduction): the order rests,
 *   which only `GTC` and `GTD` can do. `GTD` is not available — it must state
 *   an expiration (venue report §2.3, ADR-012 §5.2's one-minute early expiry)
 *   and no composition root in this repository supplies one.
 * - planned `MARKETABLE_LIMIT` (an `AGGRESSIVE` or `IMMEDIATE` reduction): the
 *   order crosses what it can and the REMAINDER RESTS instead of being
 *   abandoned. For a protective reduction that is strictly better than `FAK`:
 *   §6 invariant 10 sizes the exit from the confirmed allocation and
 *   `partialFillPolicy: ACCEPT_ANY` treats any partial as progress, so an
 *   unfilled remainder should keep working rather than leave the position open.
 *   It stays BOUNDED without this file doing anything: the plan carries the
 *   intent's `validUntil` as its deadline, under `escalation.atDeadline:
 *   CANCEL_REMAINING`.
 *
 * NOT IN SCOPE, AND REPORTED RATHER THAN FIXED HERE: {@link planEntry} tags
 * `immediate_order_type` unconditionally, so a PASSIVE entry
 * (`convert_to_aggressive_after_ms > 0`, planned `REST`) collides the same way.
 * That path is not the one B2 blocked, and choosing a passive entry's order
 * type is an entry-side decision this round does not own.
 */
const EXIT_ORDER_TYPE = "GTC";

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
  // MOVE-SITE: incidentPause TRIGGERS: PAUSE
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
  const roleProblem = refusedExitRole(state);
  if (roleProblem !== null) {
    return halted(state, roleProblem, []);
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
    // MOVE-SITE: resume TRIGGERS: RESUME
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
  // the bracket is finished. It is NOT while an entry execution the venue
  // reported is still unfolded (`BRACKET-1a` r1, BR1-H1): "no allocation" then
  // means "not yet delivered", and the ladder below waits for the fill instead.
  if (
    timeToCloseMs !== null &&
    timeToCloseMs <= 0 &&
    !hasAllocation(current) &&
    !entryExecutionUnfolded(current)
  ) {
    // MOVE-SITE: marketClosed TRIGGERS: MARKET_CLOSED
    const closed = move(current, "MARKET_CLOSED", { closedAtMs: observation.nowMs });
    if (closed.ok) {
      return plan(closed.value, "hold", [...resumeReasons, REASONS.marketClosed]);
    }
    return plan(current, "hold", [...resumeReasons, REASONS.marketClosed]);
  }

  switch (current.instanceState) {
    case "DORMANT": {
      // MOVE-SITE: arm TRIGGERS: ARM
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

  // STRUCTURAL, not economic: an instance with an order still in flight has
  // already asked the venue for something and may not ask again. The §13.2 risk
  // and reentry bounds happen to refuse these shapes too — the position
  // projection is `held + size` and the entry count is spent — but that is an
  // arithmetic coincidence of the example configuration, and a configuration
  // with slack in both would have entered on top of a live order.
  if (workingOrders(state).length > 0) {
    return plan(state, "hold", [...reasons, REASONS.refusedOrderInFlight]);
  }

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
  // MOVE-SITE: entryTriggerMet TRIGGERS: ENTRY_TRIGGER_MET
  const moved = move(state, "ENTRY_TRIGGER_MET", {
    entryOrder: track,
    intentSequence: state.intentSequence + 1,
    legOutcome: quote.leg,
    // THE INVENTORY THIS BRACKET STARTS FROM, OBSERVED — not derived later.
    // See {@link legExposure}. This bracket has filled nothing yet (a plan is
    // refused while any order of this instance is live, and `planRearm` resets
    // the state), so whatever the instance's OWN virtual view holds of this leg
    // right now is exactly the inventory the bracket did not create.
    legBaselineShares: heldShares(observation, quote.leg),
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
    // MOVE-SITE: entryAbandoned TRIGGERS: ENTRY_ABANDONED ENTRY_ORDER_TERMINAL_PARTIAL
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
 *
 * AN ID-LESS PROTECTIVE REDUCTION ADOPTS ONLY A LIVE VIEW (`BRACKET-1a`, D5).
 * Leg and side cannot tell two exits of the same bracket apart: the
 * take-profit a reduction replaced has the same outcome and the same side, and
 * §8.1 plus obligation 5 let a root deliver — and `ctx.orders()` keep listing —
 * that take-profit's TERMINAL view after the reduction was planned. Adopting
 * it would settle the reduction as "cancelled" on the old order's evidence,
 * clear its track, and leave the reduction's own fill unattributable — the
 * pause residual 5 was, reached by another route (scoping probe P2d). A
 * reduction therefore learns its venue order id only from a view that shows
 * the order ALIVE (`OPEN` / `PARTIALLY_FILLED`) or from its first fill
 * ({@link applyExitFill}); from then on exact-id matching settles its terminal
 * views. A reduction that dies before it is ever seen alive and never fills is
 * retired by its own `validUntil` instead ({@link retireExpiredReduce}).
 * TAKE_PROFIT tracks keep the adoption they always had.
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
  const liveViewsOnly = kind === "EXIT" && isProtectedReduce(track);
  for (const view of observation.orders) {
    if (view.orderId === taken) continue;
    if (view.outcome !== track.outcome || view.side !== track.side) continue;
    if (liveViewsOnly && !isLiveViewStatus(view.status)) continue;
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
  /**
   * True when the order is terminal but a view reported more executed than the
   * fill stream has delivered: the track is KEPT and the instance must wait for
   * the fill rather than act on the settled state (the entry's posture since
   * review round 1; the exit's since `BRACKET-1a` D6).
   */
  readonly awaitingFill?: boolean;
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
 * 1. An ORDER VIEW reported MORE executed than has been folded
 *    (`viewFilledShares > filledShares`, {@link entryExecutionUnfolded}) — §8.1
 *    guarantees no ordering between a view and its fill, so this is an
 *    execution whose fill has not arrived yet. The track is KEPT and the
 *    instance waits for the fill stream. With nothing folded the instance does
 *    NOT return to ARMED (that would discard a real execution and let the very
 *    next evaluation enter again, doubling the position). With SOME folded —
 *    the case this rule used to miss (`BRACKET-1a` r1, BR1-H1: it waited only
 *    when NOTHING was folded) — clearing the track left the rest of the fill
 *    matching no track, and the bracket later closed on the folded part while
 *    still holding the rest. The exit is still sized only from the fold when
 *    that fill lands — §13.3 rule 1 is not relaxed by this, and the view's
 *    number never becomes an allocation.
 * 2. Everything the view reported is folded, and a fill has been FOLDED
 *    (`filledShares > 0`) — the allocation is real and final at that size, so
 *    the bracket opens at it.
 * 3. Nothing folded and no evidence — nothing executed (§13.3 rule 3), so the
 *    instance returns to ARMED under the reentry policy.
 *
 * THE EXIT CASE WAITS FOR THE FOLD TOO (`BRACKET-1a`, D6). An exit order the
 * venue reports terminal with MORE executed (`viewFilledShares`) than the fill
 * stream has delivered (`filledShares`) is an execution whose fill is on its
 * way — §8.1 again. Clearing the track at once, as this branch used to, did one
 * of three wrong things depending on the position view (scoping probes P4c and
 * P4d): with a view that already reflects the sale, `positionAgrees` failed and
 * the instance PAUSED, and the late fill — matching no track — was never folded,
 * so the pause was permanent; with a view that lags it, the next protective
 * reduction named the WHOLE allocation, more than was left (an oversell
 * intent); and with an id-less reduction tracked, the late fill would have been
 * folded into the WRONG order. So the track is KEPT, the instance holds with
 * `SB.AWAITING_FILL_ALLOCATION`, the late fill folds by its order id, and the
 * next evaluation settles the order on a fold that agrees with the venue. The
 * view's number still never becomes an allocation (§13.3 rule 1).
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
    if (entryExecutionUnfolded(state)) {
      return {
        state,
        reasons: [REASONS.entryOrderTerminal, REASONS.awaitingFillAllocation],
        awaitingFill: true,
      };
    }
    const folded = !isZero(track.filledShares);
    if (!folded) {
      // MOVE-SITE: entryTerminalUnfilled TRIGGERS: ENTRY_ORDER_TERMINAL_UNFILLED
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
      // MOVE-SITE: entryTerminalPartial TRIGGERS: ENTRY_ORDER_TERMINAL_PARTIAL
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

  const outrun = compare(track.viewFilledShares, track.filledShares, "exit fill evidence");
  if (!outrun.ok || outrun.value > 0) {
    // An incomparable pair is read the fail-safe way too: waiting names nothing,
    // acting on an allocation that may be short does.
    return {
      state,
      reasons: [REASONS.exitOrderTerminal, REASONS.awaitingFillAllocation],
      awaitingFill: true,
    };
  }

  const cleared = withState(state, { exitOrder: null });
  const trigger: InstanceTrigger | null =
    state.instanceState === "EXIT_PLANNED"
      ? "EXIT_ABANDONED"
      : state.instanceState === "EXIT_WORKING"
        ? "EXIT_ORDER_TERMINAL_UNFILLED"
        : null;
  if (trigger !== null && !isZero(openShares(state)) && !entryExecutionUnfolded(state)) {
    // The exit order is gone and the allocation is not: the position is open
    // again and re-plannable. The trigger differs by state because the §13.3
    // table names a different edge out of each.
    //
    // NOT while an entry execution is unfolded (`BRACKET-1a` r1, BR1-H1): §13.3
    // has no edge that folds an entry fill out of `OPEN` (the census classes it
    // a designed refusal), so moving there would turn the awaited late fill into
    // an ILLEGAL_TRANSITION pause with the shares unfolded. The track is cleared
    // and the bracket stays in its exit state, whose own ENTRY_PARTIAL_FILL /
    // ENTRY_FILL_COMPLETE edges fold that fill; the ladder re-plans from there
    // with the same edges it uses from `OPEN` (EXIT_TRIGGER_MET).
    // MOVE-SITE: exitTerminal TRIGGERS: EXIT_ABANDONED EXIT_ORDER_TERMINAL_UNFILLED
    const moved = move(cleared, trigger);
    if (moved.ok) {
      return { state: moved.value, reasons: [REASONS.exitOrderTerminal] };
    }
  }
  return { state: cleared, reasons: [REASONS.exitOrderTerminal] };
}

/**
 * The statuses a view carries while its order can still execute. Only these
 * may name an id-less protective reduction (D5); an unrecognised status is not
 * proof of life and does not.
 */
function isLiveViewStatus(status: string): boolean {
  return status === "OPEN" || status === "PARTIALLY_FILLED";
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
 * - `positionAgrees` (EQUALITY) gates the PROTECTED REDUCTION. That exit is the
 *   last action the bracket takes before abandoning the position, and it is
 *   taken under duress (a stop, a timeout, a close), so it demands that the
 *   virtual position and the confirmed allocation say the same number. A
 *   disagreement cancels and reconciles instead.
 * - `positionCovers` (AT LEAST) gates the take-profit, whose size comes from the
 *   instance's own allocation. Unwinding N of an exposure of N or more is safe;
 *   unwinding N of an exposure of less is not.
 *
 * Both are measured on {@link legExposure} — the instance's OWN exposure, net of
 * the inventory the bracket started from — and NOT on the raw holding. That is
 * what makes them mean the same thing on both economic legs: a complement-leg
 * bracket is SHORT the token it trades against an inventory it did not create,
 * so "held >= the size we are about to trade" would be answered by that
 * inventory rather than by the bracket, and would wave through an exit for a
 * short that does not exist.
 *
 * WHAT A LAGGING POSITION VIEW DOES TO EACH GATE, IN BOTH DIRECTIONS. Both read
 * the position view supplied WITH the evaluation, and §8.1 orders the loop
 * "update local market/account state -> update feature snapshots -> invoke
 * subscribed strategies", so an `onFill` evaluation's view must already include
 * that fill (a composition-root obligation, WP-230, recorded in this package's
 * README). When it does not:
 *
 * - a view that lags the FIRST entry fill records a LOW `legBaselineShares`,
 *   which makes every later `legExposure` read HIGH by the lag. `positionAgrees`
 *   then fails (it wants equality) and refuses — fail-closed. `positionCovers`
 *   is satisfied by the inflated measurement, which is the OVER-PERMISSIVE
 *   direction and is why the raw check below exists;
 * - a view that lags a LATER fill reads `legExposure` LOW, and both gates refuse
 *   — fail-closed, at the cost of a delayed exit.
 *
 * The raw check is the second half of `positionCovers`: a SELL-side exit also
 * requires the RAW holding of the traded leg to cover the shares it is about to
 * sell, because no bookkeeping makes it possible to sell shares that are not
 * there. A BUY-side (complement) exit has no such requirement — it spends
 * collateral, not shares — so the raw check is not applied to it, and no
 * legitimate flow is narrowed: a direct bracket that really holds its
 * allocation passes it by construction.
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
  if (ordering.value < 0) return ok(false);
  const posture = legPosture(params, state);
  if (posture.exitSide !== "SELL") return ok(true);
  const held = compare(
    heldShares(observation, posture.leg),
    expected,
    "raw holding coverage",
  );
  if (!held.ok) return held;
  return ok(held.value >= 0);
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
  if (settlement !== null && settlement.awaitingFill === true) {
    // D6: the venue says the exit executed more than the fill stream has
    // delivered. No exit may be sized until that fill is folded — neither a
    // replacement nor a protective reduction — so the ladder does not run.
    //
    // And the bracket must be in a state that FOLDS that fill (`BRACKET-1a` r2,
    // finding BR2-H1). A late ENTRY fill moves it out of the exit states; on
    // healthy data {@link planTakeProfit}'s own D6 hold walks it back, but on
    // stale data {@link applyEntryFill} takes the incident branch instead and
    // PAUSES with `resumeTo` `OPEN`/`PARTIALLY_OPEN`. The RESUME lands there
    // and reaches this line in the same evaluation. Returning here unmoved left
    // the bracket in `OPEN`, where the awaited exit fill was refused as an
    // illegal transition — PAUSED, the fill discarded, and every later
    // evaluation waiting for it again. So this hold walks back too, through the
    // same helper and the same existing edge ({@link reenterExitStates}).
    const back = reenterExitStates(settlement.state);
    if (!back.ok) {
      return halted(settlement.state, back.problem, []);
    }
    return plan(back.value, "hold", [...reasons, ...settlement.reasons]);
  }
  const settled = settlement === null ? synced : settlement.state;
  if (settlement !== null) reasons.push(...settlement.reasons);
  // R2: a protective reduction that nothing ever named and whose own intent
  // has expired is retired here, before the ladder, which may then re-plan it.
  const retirement = retireExpiredReduce(params, settled, observation);
  const state = retirement === null ? settled : retirement.state;
  if (retirement !== null) reasons.push(...retirement.reasons);
  const leg = currentLeg(params, state);
  const open = openShares(state);

  if (isZero(open)) {
    if (entryExecutionUnfolded(state)) {
      // BR1-H1: everything FOLDED has exited, but the venue reported more of the
      // entry than the fill stream has delivered. The bracket is not finished —
      // closing it here would certify a flat book over shares still held (the
      // paused-fold-then-resume route reached exactly that). Wait for the fill.
      return plan(state, "hold", [...reasons, REASONS.awaitingFillAllocation]);
    }
    // Nothing is held: the bracket is finished. The trigger differs by state so
    // that every edge taken is one the §13.3 table actually contains.
    const trigger: InstanceTrigger =
      state.instanceState === "EXIT_PLANNED" || state.instanceState === "EXIT_WORKING"
        ? "EXIT_FILL_COMPLETE"
        : "POSITION_FLAT";
    // MOVE-SITE: bracketFinished TRIGGERS: EXIT_FILL_COMPLETE POSITION_FLAT
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
      REASONS.protectedReduce,
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
      REASONS.protectedReduce,
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
 *
 * `BRACKET-1a` (D4), three rules this maintenance now keeps:
 *
 * - IT NEVER TOUCHES A LIVE PROTECTIVE REDUCTION (ruling R3, the sticky
 *   reduce). This function is reached with one live when a stop that placed it
 *   has cleared, or when a late ENTRY fill arrives after it was placed
 *   ({@link applyEntryFill}). Treating it as a take-profit cancelled it as
 *   `SB.TAKE_PROFIT_REPLACED` the moment its size stopped matching (scoping
 *   probe P5a). It holds instead, and an allocation that grew meanwhile is
 *   planned once the reduction has settled — still gated by the position
 *   checks.
 * - A TAKE-PROFIT IS COMPARED BY WHAT IT STILL HAS TO SELL. Its own partial
 *   fill leaves `requestedShares` ahead of `open` by exactly what it sold, so
 *   comparing `requestedShares` with `open` cancelled and replaced a
 *   correctly-sized order after every partial fill (probe P4a). The remainder
 *   `requestedShares − filledShares` is the resting size, and that is what
 *   must match.
 * - AN EXIT STILL AWAITING ITS FILL IS NEVER OVERWRITTEN. The exit slot holds
 *   one track; replacing a terminal track whose view reported more executed
 *   than has been folded (D6) would drop the one record the late fill can be
 *   attributed to. And because this function is then reached only from
 *   {@link applyEntryFill} (a late ENTRY fill; {@link planExit} returns on D6
 *   before its ladder), the bracket is walked back into the exit states
 *   ({@link reenterExitStates}) so that awaited exit fill still folds —
 *   `BRACKET-1a` r1: from `OPEN` it was refused as an illegal transition and
 *   PAUSED the instance with the sale unfolded. ({@link planExit}'s own D6
 *   return walks back the same way since r2, for the late entry fill that
 *   landed on stale data and so reached a PAUSE instead of this function.)
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
  const reduce = liveReduce(state);
  if (reduce !== null) {
    return holdForLiveReduce(params, state, observation, reasons, reduce);
  }
  const existing = state.exitOrder;
  if (existing !== null && !isLive(existing.state)) {
    const settlement = settleTerminalOrder(state, "EXIT");
    if (settlement !== null && settlement.awaitingFill === true) {
      const back = reenterExitStates(state);
      if (!back.ok) {
        return halted(state, back.problem, []);
      }
      return plan(back.value, "hold", [...reasons, ...settlement.reasons]);
    }
  }
  if (existing !== null && isLive(existing.state)) {
    const remaining = sub(existing.requestedShares, existing.filledShares, "take-profit remainder");
    if (!remaining.ok) {
      return halted(state, remaining.problem, []);
    }
    const matches = compare(remaining.value, open, "take-profit size");
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
          `static-bracket: allocation changed from ${remaining.value} to ${open}`,
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
  const id = intentId(state, EXIT_INTENT_KINDS.TAKE_PROFIT, observation.market.marketId);
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
    tags: Object.freeze([
      TAGS.strategy,
      TAGS.takeProfit,
      legTag(leg),
      orderTypeTag(EXIT_ORDER_TYPE),
    ]),
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
  // MOVE-SITE: takeProfitPlaced TRIGGERS: EXIT_TRIGGER_MET
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
 * A protected reduction (§9.9 `PROTECTED_REDUCE`): unwind this instance's OWN
 * allocation, on its OWN leg, under the configured price floor.
 *
 * `exit.stop.minimum_sell_price` and `exit.stop.urgency` are the floor and the
 * urgency of EVERY protected reduction this strategy emits — the stop trigger,
 * the holding timeout, and the end-of-market policy — while
 * `exit.stop.enabled` switches only the price TRIGGER. That is why those two
 * fields are required even when the stop trigger is disabled: a reduction
 * without a stated floor would be a blind market sale.
 *
 * WHY THIS IS A `POSITION` DELTA AND NOT A `REDUCE_POSITION`. §7.7's
 * `ReducePositionIntent` carries a `targetShares` that is a per-side SELL-DOWN
 * LEVEL for the whole market — `packages/execution-planner`'s
 * `buildReductionPlan` loops BOTH sides, sells the excess over that level on
 * each, and reads only `minimumSellPrice`. That instrument cannot express what
 * this strategy means, in two ways that were both reproduced end to end through
 * the merged planner:
 *
 * 1. ON THE COMPLEMENT LEG IT IS THE WRONG DIRECTION. A complement bracket
 *    established exposure by SELLING a token it owned, so its exit BUYS that
 *    token back; a reduction to a level can only SELL. The planner turned the
 *    complement stop into `SELL 50 NO` — a second entry at double the size —
 *    and silently dropped the `maximumBuyPrice` the intent carried, because
 *    the reduce path never reads it.
 * 2. ON EITHER LEG IT NAMES SHARES THIS BRACKET NEVER CREATED. The level
 *    applies to every side actually held, so a bracket holding inventory it did
 *    not open — the ordinary case under
 *    `PREFER_CHEAPEST_WITH_INVENTORY` — had that inventory sold too (a direct
 *    YES bracket holding 100 NO planned `SELL 50 YES` AND `SELL 100 NO`). §6
 *    invariant 7 separates actual account state from virtual strategy
 *    attribution, and §13.3 rule 1 sizes an exit from the confirmed allocation:
 *    an instance that owns a slice of a market may not act on the whole of it.
 *
 * A `POSITION` DELTA says exactly what is meant and nothing more: this leg,
 * this many shares, this side, this price bound. It is the same shape
 * {@link planTakeProfit} already emits, so both exits are read the same way.
 *
 * WHAT THE SHAPE CHANGE COSTS, STATED WHERE IT IS MADE (carried in full in this
 * package's README):
 *
 * 1. A DELTA RE-EMITTED WOULD COMPOUND — AND THE REDUCTION'S OWN ORDER TRACK IS
 *    WHAT CONTAINS IT (`BRACKET-1a`). A `REDUCE_POSITION`'s `targetShares` is a
 *    LEVEL, so re-planning "sell down to 0" on five consecutive evaluations
 *    collapsed to one action; a DELTA does not — five evaluations would plan
 *    five times the allocation. Until `BRACKET-1a` this function created NO
 *    order track (the reason given was that there is no venue order id to track
 *    until the OMS answers, which {@link planTakeProfit} had never needed), so
 *    every ladder evaluation before the fill re-emitted the whole reduction, and
 *    the reduction's own fill matched no track and PAUSED the instance
 *    (`RISK-2` residual 5). Now the reduction is tracked exactly as the
 *    take-profit is — `PENDING`, `orderId: null` until a LIVE view or its first
 *    fill names it — and while it is live every evaluation HOLDS
 *    (`SB.EXIT_ORDER_WORKING`, {@link holdForLiveReduce}): no second intent and
 *    no cancel of it. What is left of the old containment is the BACKSTOP it
 *    always was: §9.10's "reserve collateral/inventory before submission"
 *    (`RESERVE_BEFORE_SUBMISSION` on every plan), whose reservation refuses a
 *    second sale of the same inventory with `PLAN_INVENTORY_INSUFFICIENT`. It
 *    is now reached only by the one re-plan per validity window ruling R2 allows
 *    ({@link retireExpiredReduce}), each gated by `positionAgrees`.
 * 2. SUPERSEDED (`RISK-2`, `133eac1`) — "THE RISK SEAM READS IT AS AN ENTRY".
 *    This disclosure said `packages/risk` derives disposition from the intent
 *    TYPE alone, so a protective reduction got entry treatment and was refused.
 *    That has been false since `RISK-2`: a `POSITION` resolving to a SELL fully
 *    covered by the instance's confirmed holding is an `EXIT` at the seam,
 *    decided from the intent SHAPE and the supplied portfolio, never from a tag.
 *    The heading is kept only so a reader who met the old text can see what
 *    changed.
 *
 * THE POLICIES A PLACED REDUCTION FOLLOWS (`BRACKET-1a`, the user's rulings R2
 * and R3; stated in the README's "Protective reduction" section):
 *
 * - STICKY (R3). Once placed — by the stop, the holding timeout or the close
 *   cutoff — it runs to completion or to a terminal state. A stop that clears,
 *   a take-profit re-plan, a later cause: none of them cancels, re-sizes or
 *   re-prices it. There is NO exit escalation: a resting remainder keeps its
 *   floor. Only the safety paths that withdraw everything (a data-quality
 *   incident, a position reconciliation, `onStop`) cancel it.
 * - NO ANSWER (R2). A reduction nothing has answered becomes
 *   `SUBMISSION_UNKNOWN` after `submission_unknown_after_ms`, reported as the
 *   entry reports it (§6 invariant 6: unknown is never a rejection). It is
 *   retired only once its OWN `validUntil` has passed AND no view and no fill
 *   ever named it (`SB.EXIT_INTENT_EXPIRED`) — the one condition under which
 *   the intent is provably dead — and the ladder may then plan one reduction
 *   for the new validity window.
 *
 * INTERPRETATION — the fields `PositionIntent` requires and
 * `ReducePositionIntent` does not have:
 *
 * - `urgency`: carried VERBATIM. §7.7's `ReductionUrgency`
 *   (`NORMAL | AGGRESSIVE | IMMEDIATE`) is a strict subset of `PositionUrgency`,
 *   so no value is invented or lost.
 * - `liquidityPreference`: `TAKER_OK`, chosen because §9.10's posture table
 *   makes `positionPosture(TAKER_OK, u)` equal `reductionPosture(u)` for every
 *   one of the three reduction urgencies — the reduction executes exactly as it
 *   would have. `MAKER_ONLY` would rest a protective exit; `TAKER_ONLY` would
 *   cross even at `NORMAL`.
 * - `partialFillPolicy`: `ACCEPT_ANY`, which is the rule the planner states for
 *   a reduction in its own words — any partial reduction is progress toward the
 *   target (§6 invariant 10).
 * - `validUntil`: `entry.execution.order_validity_ms` from now, the same
 *   horizon every other intent this strategy emits carries.
 *
 * WHAT IS LOST: `ReducePositionIntent.reason`, a free-text field with no
 * counterpart on `PositionIntent`. The cause is preserved where this package
 * already puts machine-readable causes — the decision's `reasonCodes`
 * (`SB.STOP_TRIGGERED`, `SB.HOLDING_TIMEOUT`, `SB.EXIT_CUTOFF`) and its
 * `modelOutputs.reduceCause` — and in the `sb.protected-reduce` tag on the
 * intent itself.
 */
function planProtectedReduce(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
  leg: Outcome2,
  open: string,
  cause: string,
  reduceCode: typeof REASONS.protectedReduce | typeof REASONS.finalProtectedReduce,
): Plan {
  const reasons = [...carried];
  // D3: this bracket's OWN reduction, already placed and still live, is
  // recognised BEFORE anything is withdrawn. Without this the ladder re-emitted
  // the whole reduction on every evaluation until it filled (scoping probe
  // P1b) — or, with a track and nothing else, cancelled its own working order
  // as a "resting order to withdraw" (probe P2a). Neither: it holds.
  const own = liveReduce(state);
  if (own !== null) {
    return holdForLiveReduce(params, state, observation, reasons, own);
  }
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
  const validUntil = formatInstantMs(
    observation.nowMs + params.entry.execution.order_validity_ms,
    "validUntil",
  );
  if (!validUntil.ok) {
    return plan(state, "hold", [...reasons, REASONS.internalRefusal]);
  }
  const id = intentId(state, EXIT_INTENT_KINDS.PROTECTED_REDUCE, observation.market.marketId);
  const intent: Intent = {
    type: "POSITION",
    intentId: id,
    marketId: observation.market.marketId,
    direction: leg,
    targetMode: "DELTA",
    // The DELTA's sign is the exit side and |delta| is the confirmed open
    // allocation: a direct bracket sells back what it bought, a complement
    // bracket buys back what it sold, and neither can name a share more.
    targetShares: posture.exitSide === "SELL" ? `-${open}` : open,
    ...(posture.exitSide === "SELL"
      ? { minimumSellPrice: floor.value }
      : { maximumBuyPrice: floor.value }),
    urgency: params.exit.stop.urgency,
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: validUntil.value,
    tags: Object.freeze([
      TAGS.strategy,
      TAGS.protectedReduce,
      legTag(leg),
      orderTypeTag(EXIT_ORDER_TYPE),
    ]),
  };
  // D1: the reduction is TRACKED, in exactly the shape {@link planTakeProfit}
  // gives a take-profit: PENDING and id-less until a LIVE view or its first
  // fill names it (D5), sized to the open allocation it names. Its fill then
  // folds through {@link applyExitFill} like any exit fill —
  // `EXIT_PLANNED | EXIT_WORKING --EXIT_FILL_COMPLETE--> CLOSED` — so no new
  // machine edge exists for it.
  const track: OrderTrack = Object.freeze({
    kind: "EXIT",
    intentId: id,
    orderId: null,
    state: "PENDING" as OrderState,
    outcome: leg,
    side: posture.exitSide,
    limitPrice: floor.value,
    requestedShares: open,
    filledShares: ZERO,
    viewFilledShares: ZERO,
    placedAtMs: observation.nowMs,
    escalated: false,
  });
  // MOVE-SITE: protectedReduce TRIGGERS: EXIT_TRIGGER_MET
  const moved = move(state, "EXIT_TRIGGER_MET", {
    exitOrder: track,
    intentSequence: state.intentSequence + 1,
  });
  if (!moved.ok) {
    return halted(state, moved.problem, []);
  }
  // D8: `SB.FINAL_PROTECTED_REDUCE` names the END-OF-MARKET policy only; a
  // stop or a holding timeout reports `SB.PROTECTED_REDUCE`.
  return plan(
    moved.value,
    "reduce",
    [...reasons, REASONS.exitProportional, reduceCode],
    [intent],
    {
      exitShares: open,
      floor: floor.value,
      exitSide: posture.exitSide,
      reduceCause: cause.slice(0, 200),
    },
  );
}

/**
 * Walks a bracket that still OWES an exit fill back into the exit states, or
 * leaves it where it is.
 *
 * An exit order of this bracket that can still produce a fill — a live
 * protective reduction ({@link holdForLiveReduce}), or a terminal exit whose
 * view reported more executed than is folded (D6: {@link planTakeProfit}'s
 * hold, and since `BRACKET-1a` r2 {@link planExit}'s own) — must have its fill
 * folded, and the only §13.3 edges that fold an exit fill leave
 * `EXIT_PLANNED`/`EXIT_WORKING`. A late ENTRY fill moves the instance out of
 * those states ({@link applyEntryFill} takes `ENTRY_PARTIAL_FILL` /
 * `ENTRY_FILL_COMPLETE` into `PARTIALLY_OPEN`/`OPEN`) — directly on healthy
 * data, or on stale data through a data-quality PAUSE whose `resumeTo` names
 * that state, so the RESUME lands there (finding BR2-H1) — and from `OPEN` the
 * exit's fill would be refused as an illegal transition and PAUSE the instance
 * on its own exit, with the sale unfolded. So each EVALUATION that holds for
 * an owed exit calls this — {@link holdForLiveReduce}, {@link planTakeProfit}'s
 * D6 hold and {@link planExit}'s — and the bracket re-takes the existing
 * `EXIT_TRIGGER_MET` edge — an exit cause did fire, and its order is still owed
 * — and {@link syncPlannedToWorking} follows a working order into
 * `EXIT_WORKING`. No new machine edge: `PARTIALLY_OPEN|OPEN --EXIT_TRIGGER_MET-->
 * EXIT_PLANNED` is the edge every exit placement takes.
 *
 * In any other state it answers the state unchanged.
 */
function reenterExitStates(state: StaticBracketState): Outcome<StaticBracketState> {
  if (state.instanceState !== "PARTIALLY_OPEN" && state.instanceState !== "OPEN") {
    return ok(state);
  }
  // MOVE-SITE: exitStillOwed TRIGGERS: EXIT_TRIGGER_MET
  const moved = move(state, "EXIT_TRIGGER_MET");
  if (!moved.ok) return moved;
  return ok(syncPlannedToWorking(moved.value, "EXIT"));
}

/**
 * What every evaluation does while this bracket's own protective reduction is
 * live (`BRACKET-1a`, D3/D4, rulings R2 and R3): it HOLDS. No second
 * reduction, no cancel of this one, no take-profit beside it.
 *
 * BACK INTO THE EXIT STATES FIRST ({@link reenterExitStates}). A late ENTRY
 * fill after the reduction was placed moves the instance to
 * `PARTIALLY_OPEN`/`OPEN`, and the reduction's own fill must still fold. The
 * grown allocation is planned only after the reduction settles, by the
 * ordinary ladder, under the ordinary position checks.
 *
 * THEN, BY THE ORDER'S STATE:
 *
 * - `WORKING` (partly filled included): `SB.EXIT_ORDER_WORKING`.
 * - `PENDING`: the same, until `submission_unknown_after_ms` of silence; then
 *   `PENDING --SILENCE_EXCEEDED--> SUBMISSION_UNKNOWN`, reported exactly as the
 *   entry reports it (`modelOutputs.submissionUnknown: true`,
 *   `SB.AWAITING_RECONCILIATION`) — §6 invariant 6, unknown is never a
 *   rejection, so nothing is re-sent.
 * - `SUBMISSION_UNKNOWN`: held, and reported, until a view or a fill names it
 *   or its intent's own `validUntil` passes ({@link retireExpiredReduce}).
 * - `CANCEL_PENDING` (a data-quality incident or a reconciliation cancelled
 *   it): held until the venue confirms — `SB.AWAITING_CANCEL_CONFIRMATION` —
 *   and never cancelled again.
 */
function holdForLiveReduce(
  params: StaticBracketParams,
  incoming: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
  reduce: OrderTrack,
): Plan {
  const back = reenterExitStates(incoming);
  if (!back.ok) {
    return halted(incoming, back.problem, []);
  }
  const state = back.value;
  const reasons = [...carried, REASONS.exitOrderWorking];
  const silenceBoundMs = reduce.placedAtMs + params.entry.execution.submission_unknown_after_ms;
  // The first instant the retirement rule could apply: strictly after the
  // intent's own `validUntil`.
  const retirableAtMs = intentValidUntilMs(params, reduce) + 1;
  switch (reduce.state) {
    case "PENDING": {
      if (observation.nowMs >= silenceBoundMs) {
        const moved = moveOrder(reduce, "SILENCE_EXCEEDED");
        if (moved.ok) {
          return plan(
            withState(state, { exitOrder: moved.value }),
            "hold",
            [...reasons, REASONS.exitSubmissionUnknown, REASONS.entryAwaitingReconciliation],
            [],
            { submissionUnknown: true },
            retirableAtMs,
          );
        }
      }
      return plan(state, "hold", reasons, [], null, silenceBoundMs);
    }
    case "SUBMISSION_UNKNOWN":
      return plan(
        state,
        "hold",
        [...reasons, REASONS.exitSubmissionUnknown, REASONS.entryAwaitingReconciliation],
        [],
        null,
        neverNamed(reduce) ? retirableAtMs : null,
      );
    case "CANCEL_PENDING":
      return plan(state, "hold", [...reasons, REASONS.awaitingCancel]);
    default:
      return plan(state, "hold", reasons);
  }
}

/**
 * Retires a protective reduction whose intent is PROVABLY DEAD (ruling R2), or
 * answers `null`.
 *
 * All four must hold, and each is checked:
 *
 * 1. the track is this bracket's PROTECTED_REDUCE (a take-profit is never
 *    retired this way);
 * 2. it is `PENDING` or `SUBMISSION_UNKNOWN` — nothing has shown it working;
 * 3. NO order view and NO fill has EVER named it ({@link neverNamed}): no venue
 *    order id, no confirmed fill, no view-reported fill. A track that anything
 *    named is never retired by expiry, whatever its state;
 * 4. its OWN `validUntil` — `placedAtMs + order_validity_ms`, exactly as the
 *    intent carried it — is STRICTLY in the past.
 *
 * WHY THAT IS SAFE (and not §6 invariant 6's "unknown treated as rejection").
 * After `validUntil` nothing can turn the intent into an order any more: the
 * risk engine refuses an intent whose `validUntil` is before the evaluation
 * instant (`packages/risk/src/engine.ts:238-248`, `RISK_INTENT_EXPIRED`) and the
 * planner refuses one whose `validUntil` is not after the planning instant
 * (`packages/execution-planner/src/build.ts:196-213`, `PLAN_INTENT_EXPIRED`).
 * So either no order exists, or one was booked before then — and a booked order
 * appears in `ctx.orders()` before its intent's `validUntil` passes (the
 * composition-root obligation this rule rests on, README obligation 11): a
 * live one is ADOPTED by {@link planExit} before this function runs, and a
 * terminal one either executed — and its fill named the track — or did not,
 * in which case it is dead too. The loop's reservation stays the backstop, and
 * the re-plan the ladder may then make is still gated by `positionAgrees`,
 * which a sale booked but not yet delivered would already fail.
 *
 * The bracket leaves `EXIT_PLANNED` by §13.3's existing `EXIT_ABANDONED` edge —
 * "a planned exit that never became an order leaves the position open" —
 * which is exactly this fact. In any other bracket state the track is only
 * cleared, as {@link settleTerminalOrder} does for a terminal exit.
 */
function retireExpiredReduce(
  params: StaticBracketParams,
  state: StaticBracketState,
  observation: Observation,
): Settlement | null {
  const track = state.exitOrder;
  if (track === null || !isProtectedReduce(track)) return null;
  if (track.state !== "PENDING" && track.state !== "SUBMISSION_UNKNOWN") return null;
  if (!neverNamed(track)) return null;
  if (observation.nowMs <= intentValidUntilMs(params, track)) return null;
  const cleared = withState(state, { exitOrder: null });
  // As in {@link settleTerminalOrder}: not into `OPEN` while an entry execution
  // is unfolded (BR1-H1) — the late entry fill folds only from the exit states.
  if (state.instanceState === "EXIT_PLANNED" && !entryExecutionUnfolded(state)) {
    // MOVE-SITE: exitIntentExpired TRIGGERS: EXIT_ABANDONED
    const moved = move(cleared, "EXIT_ABANDONED");
    if (moved.ok) {
      return { state: moved.value, reasons: [REASONS.exitIntentExpired] };
    }
  }
  return { state: cleared, reasons: [REASONS.exitIntentExpired] };
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
 *
 * It withdraws the ENTRY track and a TAKE_PROFIT track, never this bracket's
 * own protective reduction (`BRACKET-1a`, D3; ruling R3). Every caller
 * recognises a live reduction FIRST and holds through
 * {@link holdForLiveReduce}: {@link planProtectedReduce}, and — since
 * `BRACKET-1a` r1, finding BR1-M1 — the two final policies that also call here
 * (`HOLD_TO_RESOLUTION`, `CANCEL_ONLY`), which used to return their own plain
 * hold and so skipped ruling R2's silence transition and D3's
 * `SB.EXIT_ORDER_WORKING` for a reduction placed before the cutoff. The filter
 * below is the backstop, not the mechanism.
 */
function withdrawResting(
  state: StaticBracketState,
  observation: Observation,
  carried: readonly string[],
  detail: string,
): Plan | null {
  const live = workingOrders(state).filter((order) => !isProtectedReduce(order));
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

/**
 * End-of-market behaviour: the explicit configured policy (§13.3 rule 5).
 *
 * A protective reduction placed BEFORE the cutoff (by the stop or the holding
 * timeout) is sticky under every policy (ruling R3), and it is held the ONE way
 * a live reduction is held everywhere else — {@link holdForLiveReduce}, with
 * the policy's own codes carried — so ruling R2's silence transition
 * (`SUBMISSION_UNKNOWN`, reported as the entry reports it) and D3's
 * `SB.EXIT_ORDER_WORKING` apply under `HOLD_TO_RESOLUTION` and `CANCEL_ONLY`
 * exactly as under `PROTECTED_REDUCE` (`BRACKET-1a` r1, finding BR1-M1). Once
 * such a reduction is retired by R2, `HOLD_TO_RESOLUTION` and `CANCEL_ONLY` do
 * not re-plan it: neither policy places a reduction.
 */
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
        REASONS.finalProtectedReduce,
      );
    case "HOLD_TO_RESOLUTION": {
      // Permitted only because `allow_resolution_hold` is true; the
      // configuration grammar refuses the contradictory combination outright.
      const held = [...reasons, REASONS.finalHoldToResolution, REASONS.resolutionHoldAllowed];
      const own = liveReduce(state);
      if (own !== null) {
        return holdForLiveReduce(params, state, observation, held, own);
      }
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
      const own = liveReduce(state);
      if (own !== null) {
        return holdForLiveReduce(params, state, observation, cancelOnly, own);
      }
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
  // MOVE-SITE: reconcilePause TRIGGERS: PAUSE
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
  // MOVE-SITE: rearm TRIGGERS: REARM
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
  const roleProblem = refusedExitRole(state);
  if (roleProblem !== null) {
    return halted(state, roleProblem, []);
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

/**
 * A CONFIRMED fill that arrives while the instance is PAUSED.
 *
 * THE FOLD IS SETTLEMENT ACCOUNTING, NOT A STATE TRANSITION. §6 invariant 5
 * keeps order state and settlement state apart, and §6 invariant 10 with §13.3
 * rule 1 make the confirmed allocation the only thing an exit may be sized
 * from. §13.3 draws no edge out of `PAUSED` for a fill — correctly, because a
 * paused instance must take no action — but a fill is not an action: it is a
 * fact about money that has already moved. Consulting the machine first
 * therefore refused the fill and left the instance recording an allocation of
 * zero while it really held the position, which is precisely the state §6
 * invariant 12 exists to prevent it from acting on.
 *
 * So the fold is applied and the instance STAYS PAUSED: same
 * `instanceState`, same `resumeTo`, no transition, no intent, no exit sizing.
 * The fold remains the single writer of `allocatedShares` and `exitedShares`,
 * and replay is deterministic because nothing here depends on when the
 * evaluation happened. When the data-quality condition clears, {@link planTick}
 * resumes into `resumeTo` and the ordinary ladder sizes the exit from the
 * allocation this fold recorded.
 *
 * INTERPRETATION: the alternative — holding the fill for replay on resume —
 * would need a queue in the state document and would make the allocation
 * depend on the order in which a resume and a fill happened to interleave. One
 * fold, applied once, at the moment the fill is confirmed, is the version that
 * keeps §6 invariant 8's rebuildability honest.
 */
function pausedFold(
  state: StaticBracketState,
  changes: Partial<StaticBracketState>,
  carried: readonly string[],
): Plan {
  return plan(withState(state, changes), "hold", [
    ...carried,
    REASONS.fillFoldedWhilePaused,
    REASONS.paused,
  ]);
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

  // `legBaselineShares` IS NOT WRITTEN HERE. It is OBSERVED when the entry is
  // planned ({@link planEntry}), which is the last instant at which this
  // bracket is guaranteed to have filled nothing.
  //
  // IT USED TO BE DERIVED HERE, AND THAT WAS THE DEFECT (`RISK-2`; found only
  // once the exits could reach the venue at all). The code read:
  //
  //     const baseline = firstFill
  //       ? entry.side === "BUY"
  //         ? sub(heldShares(observation, fill.outcome), allocated.value, …)
  //         : add(heldShares(observation, fill.outcome), allocated.value, …)
  //       : ok(state.legBaselineShares);
  //
  // and its comment justified the subtraction by §8.1's "update local
  // market/account state -> … -> invoke subscribed strategies", concluding that
  // a composition root which LAGGED the position behind the fill stream would
  // only make the baseline low "which makes the exit gates REFUSE and reconcile
  // — the fail-closed direction". It considered one direction and missed the
  // one the contract actually mandates. `WP-220` obligation 3 requires the view
  // to include the fill an `onFill` is about "AND, IF TWO FILLS ARRIVE
  // TOGETHER, BOTH OF THEM" (`apps/trader/src/loop.ts` `#harvestFills`, which
  // books every fill of a harvest before delivering any of them). So at the
  // FIRST `onFill` of a batched harvest the view LEADS: it already holds the
  // whole batch, while `allocated` counts only the fill being delivered.
  //
  // Measured, in the paper end-to-end scenario: one 50-share entry filled
  // 30 @ 0.34 then 20 @ 0.35 in a single harvest, so the first `onFill` saw a
  // view of 50 and subtracted 30, recording `legBaselineShares "20"` for a
  // bracket that started from nothing. `legExposure` was then understated by 20
  // FOREVER — 30 against an `openShares` of 50 — and `positionAgrees`, which
  // demands equality, refused the protective reduction as `SB.POSITION_MISMATCH`
  // / `SB.NO_BLIND_FLATTEN` and PAUSED the instance holding a position it could
  // no longer exit. That is not the fail-closed direction; it is the trap.
  //
  // Observing the baseline instead of deriving it removes the dependence on
  // fill-delivery batching entirely, and it needs no subtraction to be correct
  // on either leg.
  const changes: Partial<StaticBracketState> = {
    entryOrder: orderMoved.value,
    allocatedShares: allocated.value,
    allocatedCost: cost.value,
    legOutcome: fill.outcome,
    openedAtMs: state.openedAtMs ?? observation.nowMs,
    entriesExecuted: firstFill ? state.entriesExecuted + 1 : state.entriesExecuted,
  };
  if (state.instanceState === "PAUSED") {
    return pausedFold(state, changes, [REASONS.allocated]);
  }
  // MOVE-SITE: entryFill TRIGGERS: ENTRY_FILL_COMPLETE ENTRY_PARTIAL_FILL
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
  // `BRACKET-1a` r1, BR1-H1: FLAT (every folded share has exited) is not
  // FINISHED while the venue has reported more of the entry than the fill
  // stream has delivered. Such a fold does not certify CLOSED: it takes the
  // bracket's partial-fill edge, keeps the exit track (so its own terminal view
  // still settles it by id), records no cool-down anchor, and says what it is
  // waiting for. The late entry fill then folds from the exit states, and the
  // ordinary ladder exits what it added.
  const closes = flat && !entryExecutionUnfolded(state);
  const changes: Partial<StaticBracketState> = {
    exitOrder: closes ? null : orderMoved.value,
    exitedShares: exited.value,
    ...(closes ? { closedAtMs: observation.nowMs } : {}),
  };
  if (state.instanceState === "PAUSED") {
    // `closedAtMs` is deliberately NOT recorded here: it is the cool-down
    // anchor, and a bracket that has not reached CLOSED has not started
    // cooling down. The resume path sets it when it takes the edge.
    return pausedFold(
      state,
      { exitOrder: changes.exitOrder ?? null, exitedShares: exited.value },
      [REASONS.exitFilled],
    );
  }
  // MOVE-SITE: exitFill TRIGGERS: EXIT_FILL_COMPLETE EXIT_PARTIAL_FILL
  const moved = move(state, closes ? "EXIT_FILL_COMPLETE" : "EXIT_PARTIAL_FILL", changes);
  if (!moved.ok) {
    return refuseTransition(state, observation, currentLeg(params, state));
  }
  return plan(
    moved.value,
    "hold",
    closes
      ? [REASONS.exitFilled, REASONS.closed]
      : flat
        ? [REASONS.exitFilled, REASONS.awaitingFillAllocation]
        : [REASONS.exitFilled],
  );
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
  const roleProblem = refusedExitRole(state);
  if (roleProblem !== null) {
    return halted(state, roleProblem, []);
  }
  const kind = attributeOrder(state, view);
  if (kind === null) {
    return plan(state, "hold", [REASONS.idle]);
  }
  const track = kind === "ENTRY" ? (state.entryOrder as OrderTrack) : (state.exitOrder as OrderTrack);
  const absorbed = absorbTerminalView(state, kind, track, view);
  if (absorbed !== null) {
    return absorbed;
  }
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
    // An exit can be SUBMISSION_UNKNOWN since `BRACKET-1a` (a protective
    // reduction nobody answered, ruling R2), so a reconciliation names its kind.
    ...(reconciled ? [kind === "ENTRY" ? REASONS.entryReconciled : REASONS.exitReconciled] : []),
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

/**
 * A REPEATED view for an order this instance already tracks as TERMINAL.
 *
 * §8.1 orders nothing between an order view and the fill it describes, and
 * nothing in §9.6 or the SDK promises at-most-once delivery of a view; the
 * sub-machine already tolerates a repeated `WORKING` view with its own
 * `WORKING --OBSERVED_WORKING--> WORKING` self-edge. A terminal state, by
 * contrast, correctly has NO outgoing edge — so asking the sub-machine to move
 * out of one made an ordinary second `FILLED` message HALT the instance, with
 * the position still on the books and the stop, the timeout and the close
 * cutoff all dead behind {@link planTick}'s halt short-circuit.
 *
 * The answer is to ABSORB the view rather than to widen the machine (which
 * would make "terminal" mean something weaker for every reader of the table):
 *
 * - the sub-machine is NOT consulted, so no illegal move and no halt;
 * - the view's `filledShares` is folded as EVIDENCE when it reports MORE than
 *   the evidence already recorded, and never as allocation (§13.3 rule 1 — the
 *   exit is still sized only from confirmed fills, `foldFillIntoOrder`);
 * - the terminal order is then settled through the one routine that owns that
 *   decision, exactly as an evaluation would (it is idempotent: a bracket that
 *   has already left the entry states neither transitions again nor loses the
 *   allocation).
 *
 * `null` means the track is not terminal and the ordinary path applies.
 */
function absorbTerminalView(
  state: StaticBracketState,
  kind: "ENTRY" | "EXIT",
  track: OrderTrack,
  view: TrackedOrderView,
): Plan | null {
  if (!TERMINAL_ORDER_STATES.includes(track.state)) return null;
  const better = compare(view.filledShares, track.viewFilledShares, "order view evidence");
  const evidence = better.ok && better.value > 0 ? view.filledShares : track.viewFilledShares;
  const updated = Object.freeze({
    ...track,
    orderId: track.orderId ?? view.orderId,
    viewFilledShares: evidence,
  });
  const next =
    kind === "ENTRY"
      ? withState(state, { entryOrder: updated })
      : withState(state, { exitOrder: updated });
  return finishOrder(next, kind, [
    kind === "ENTRY" ? REASONS.entryOrderWorking : REASONS.exitOrderWorking,
    REASONS.terminalOrderViewAbsorbed,
  ]);
}

/**
 * Which tracked order an `onOrderUpdate` view is about: by exact venue order id
 * first, then — for a track that has no id yet — by leg and side.
 *
 * The id-less match is exactly {@link adoptOrder}'s, including its one
 * restriction (`BRACKET-1a`, D5): an id-less PROTECTIVE REDUCTION is named only
 * by a view that shows the order alive. A terminal view of an order it has
 * never been linked to — the replaced take-profit's `CANCELED`, redelivered —
 * is not its evidence, and attributing it cleared the reduction's track and
 * left its own fill unattributed (scoping probe P2d).
 */
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
    if (isProtectedReduce(exit) && !isLiveViewStatus(view.status)) return null;
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
  // MOVE-SITE: marketResolved TRIGGERS: MARKET_RESOLVED
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

