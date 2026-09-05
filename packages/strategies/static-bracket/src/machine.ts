/**
 * The §13.3 state machine, as a typed transition function over an explicit
 * table — not implicit flag soup.
 *
 *     DORMANT -> ARMED -> ENTRY_PLANNED -> ENTRY_WORKING -> PARTIALLY_OPEN
 *             -> OPEN -> EXIT_PLANNED -> EXIT_WORKING -> CLOSED
 *     Any state: -> PAUSED, -> HALTED
 *     Working orders: -> CANCEL_PENDING -> CANCELED | REJECTED | SUBMISSION_UNKNOWN
 *
 * Two machines live here and they are separate on purpose: the INSTANCE machine
 * (where the strategy is in its bracket) and the WORKING-ORDER sub-machine
 * (what is known about one order the strategy asked for). §6 invariant 5 —
 * order state and settlement state are separate — has the same shape, and the
 * §13.3 sub-machine exists because "no response" is a third answer that neither
 * `CANCELED` nor `REJECTED` covers (§6 invariant 6).
 *
 * Everything about legality is DATA. {@link INSTANCE_TRANSITIONS} and
 * {@link ORDER_TRANSITIONS} are the whole specification; the transition
 * functions are total lookups over them, and an illegal transition is refused
 * BY NAME rather than ignored or silently self-looped. The test suite derives
 * its coverage from these exported tables, so a legal edge that no test
 * exercises and an illegal edge that does not refuse both fail the suite.
 *
 * §13.3's diagram lists states, not edges. Where an edge is an interpretation
 * rather than a quotation it is marked INTERPRETATION in the table below and
 * its basis is stated.
 */

import { bad, ok, type Outcome } from "./plain.js";

/** The nine bracket states plus the two out-of-band states (§13.3). */
export const INSTANCE_STATES = Object.freeze([
  "DORMANT",
  "ARMED",
  "ENTRY_PLANNED",
  "ENTRY_WORKING",
  "PARTIALLY_OPEN",
  "OPEN",
  "EXIT_PLANNED",
  "EXIT_WORKING",
  "CLOSED",
  "PAUSED",
  "HALTED",
] as const);
export type InstanceState = (typeof INSTANCE_STATES)[number];

/**
 * Every event that can move the instance machine. A trigger names a FACT the
 * strategy observed (a fill arrived, the market closed), never an action.
 */
export const INSTANCE_TRIGGERS = Object.freeze([
  "ARM",
  "ENTRY_TRIGGER_MET",
  "ENTRY_ORDER_WORKING",
  "ENTRY_ABANDONED",
  "ENTRY_PARTIAL_FILL",
  "ENTRY_FILL_COMPLETE",
  "ENTRY_ORDER_TERMINAL_UNFILLED",
  "ENTRY_ORDER_TERMINAL_PARTIAL",
  "EXIT_TRIGGER_MET",
  "EXIT_ORDER_WORKING",
  "EXIT_ABANDONED",
  "EXIT_PARTIAL_FILL",
  "EXIT_FILL_COMPLETE",
  "EXIT_ORDER_TERMINAL_UNFILLED",
  "POSITION_FLAT",
  "MARKET_CLOSED",
  "MARKET_RESOLVED",
  "REARM",
  "PAUSE",
  "RESUME",
  "HALT",
] as const);
export type InstanceTrigger = (typeof INSTANCE_TRIGGERS)[number];

/**
 * The symbolic target of `RESUME`: the state recorded when the instance paused.
 * A dynamic target is still a table row, so the machine stays fully data-driven.
 */
export const RESUME_TARGET = "@RESUME_TARGET" as const;

export interface InstanceTransition {
  readonly from: InstanceState;
  readonly trigger: InstanceTrigger;
  readonly to: InstanceState | typeof RESUME_TARGET;
  /** Why this edge exists: a §13.3 quotation, or a marked interpretation. */
  readonly basis: string;
}

const BRACKET_STATES: readonly InstanceState[] = Object.freeze([
  "DORMANT",
  "ARMED",
  "ENTRY_PLANNED",
  "ENTRY_WORKING",
  "PARTIALLY_OPEN",
  "OPEN",
  "EXIT_PLANNED",
  "EXIT_WORKING",
  "CLOSED",
]);

/**
 * States a paused instance may resume INTO. `PAUSED` (already paused), `HALTED`
 * (terminal) and `CLOSED` are excluded from being a resume target only when they
 * were never the pre-pause state; the rule enforced below is simply that the
 * recorded pre-pause state is a bracket state.
 */
export function isResumeTarget(state: InstanceState): boolean {
  return BRACKET_STATES.includes(state);
}

function pauseAndHaltEdges(): readonly InstanceTransition[] {
  const edges: InstanceTransition[] = [];
  for (const from of INSTANCE_STATES) {
    if (from !== "PAUSED" && from !== "HALTED") {
      edges.push({
        from,
        trigger: "PAUSE",
        to: "PAUSED",
        basis: "§13.3 'Any state: -> PAUSED'",
      });
    }
    if (from !== "HALTED") {
      edges.push({
        from,
        trigger: "HALT",
        to: "HALTED",
        basis: "§13.3 'Any state: -> HALTED'",
      });
    }
  }
  return edges;
}

/**
 * The instance transition table. EXHAUSTIVE: a `(from, trigger)` pair absent
 * from this table is illegal and refuses by name.
 */
export const INSTANCE_TRANSITIONS: readonly InstanceTransition[] = Object.freeze([
  {
    from: "DORMANT",
    trigger: "ARM",
    to: "ARMED",
    basis: "§13.3 'DORMANT -> ARMED'",
  },
  {
    from: "DORMANT",
    trigger: "MARKET_CLOSED",
    to: "CLOSED",
    basis: "INTERPRETATION: a market that closes before the instance ever armed is finished; §13.3 rule 5 makes end-of-market behaviour explicit",
  },
  {
    from: "ARMED",
    trigger: "ENTRY_TRIGGER_MET",
    to: "ENTRY_PLANNED",
    basis: "§13.3 'ARMED -> ENTRY_PLANNED'",
  },
  {
    from: "ARMED",
    trigger: "MARKET_CLOSED",
    to: "CLOSED",
    basis: "INTERPRETATION: end-of-market with no position (§13.3 rule 5)",
  },
  {
    from: "ARMED",
    trigger: "MARKET_RESOLVED",
    to: "CLOSED",
    basis: "INTERPRETATION: a resolved market cannot be entered (§7.4 MarketResolved)",
  },
  {
    from: "ENTRY_PLANNED",
    trigger: "ENTRY_ORDER_WORKING",
    to: "ENTRY_WORKING",
    basis: "§13.3 'ENTRY_PLANNED -> ENTRY_WORKING'",
  },
  {
    from: "ENTRY_PLANNED",
    trigger: "ENTRY_ABANDONED",
    to: "ARMED",
    basis: "INTERPRETATION: a planned entry that never became an order leaves the instance armed; no execution occurred, so §13.3 rule 3 does not count it",
  },
  {
    from: "ENTRY_PLANNED",
    trigger: "ENTRY_PARTIAL_FILL",
    to: "PARTIALLY_OPEN",
    basis: "INTERPRETATION: §8.1 does not guarantee that an order update precedes its fill; a confirmed fill is stronger evidence than a missing order update",
  },
  {
    from: "ENTRY_PLANNED",
    trigger: "ENTRY_FILL_COMPLETE",
    to: "OPEN",
    basis: "INTERPRETATION: as above, for a fill that completes the requested size",
  },
  {
    from: "ENTRY_PLANNED",
    trigger: "MARKET_CLOSED",
    to: "CLOSED",
    basis: "INTERPRETATION: end-of-market with no confirmed allocation (§13.3 rule 5)",
  },
  {
    from: "ENTRY_WORKING",
    trigger: "ENTRY_PARTIAL_FILL",
    to: "PARTIALLY_OPEN",
    basis: "§13.3 'ENTRY_WORKING -> PARTIALLY_OPEN' and rule 2",
  },
  {
    from: "ENTRY_WORKING",
    trigger: "ENTRY_FILL_COMPLETE",
    to: "OPEN",
    basis: "§13.3 'ENTRY_WORKING -> ... -> OPEN'",
  },
  {
    from: "ENTRY_WORKING",
    trigger: "ENTRY_ORDER_TERMINAL_UNFILLED",
    to: "ARMED",
    basis: "INTERPRETATION: an entry order that ended with no fill executed nothing (§13.3 rule 3), so the instance returns to ARMED under the reentry policy",
  },
  {
    from: "ENTRY_WORKING",
    trigger: "MARKET_CLOSED",
    to: "CLOSED",
    basis: "INTERPRETATION: end-of-market with no confirmed allocation (§13.3 rule 5)",
  },
  {
    from: "PARTIALLY_OPEN",
    trigger: "ENTRY_PARTIAL_FILL",
    to: "PARTIALLY_OPEN",
    basis: "§13.3 rule 1: each further fill enlarges the ACTUAL allocated size",
  },
  {
    from: "PARTIALLY_OPEN",
    trigger: "ENTRY_FILL_COMPLETE",
    to: "OPEN",
    basis: "§13.3 'PARTIALLY_OPEN -> OPEN'",
  },
  {
    from: "PARTIALLY_OPEN",
    trigger: "ENTRY_ORDER_TERMINAL_PARTIAL",
    to: "OPEN",
    basis: "INTERPRETATION: the entry order finished with a partial fill, so the allocated size is final and the position is fully open at that size (§13.3 rule 1)",
  },
  {
    from: "PARTIALLY_OPEN",
    trigger: "EXIT_TRIGGER_MET",
    to: "EXIT_PLANNED",
    basis: "§13.3 rule 2: a partial fill may create a proportional exit once allocated",
  },
  {
    from: "PARTIALLY_OPEN",
    trigger: "MARKET_RESOLVED",
    to: "CLOSED",
    basis: "INTERPRETATION: settlement ends the position (§9.3)",
  },
  {
    from: "PARTIALLY_OPEN",
    trigger: "POSITION_FLAT",
    to: "CLOSED",
    basis: "INTERPRETATION: an allocation that is entirely exited leaves nothing to manage",
  },
  {
    from: "OPEN",
    trigger: "EXIT_TRIGGER_MET",
    to: "EXIT_PLANNED",
    basis: "§13.3 'OPEN -> EXIT_PLANNED'",
  },
  {
    from: "OPEN",
    trigger: "POSITION_FLAT",
    to: "CLOSED",
    basis: "INTERPRETATION: an allocation that is entirely exited leaves nothing to manage",
  },
  {
    from: "OPEN",
    trigger: "MARKET_RESOLVED",
    to: "CLOSED",
    basis: "INTERPRETATION: settlement ends the position (§9.3); allowed only when the resolution-hold policy permitted the hold",
  },
  {
    from: "EXIT_PLANNED",
    trigger: "EXIT_ORDER_WORKING",
    to: "EXIT_WORKING",
    basis: "§13.3 'EXIT_PLANNED -> EXIT_WORKING'",
  },
  {
    from: "EXIT_PLANNED",
    trigger: "ENTRY_PARTIAL_FILL",
    to: "PARTIALLY_OPEN",
    basis: "INTERPRETATION: §13.3 rules 1 and 2 — a further ENTRY fill while a proportional exit rests enlarges the ACTUAL allocation, so the resting exit no longer matches it; the bracket returns to the open state and the exit is re-planned from the new allocation",
  },
  {
    from: "EXIT_PLANNED",
    trigger: "ENTRY_FILL_COMPLETE",
    to: "OPEN",
    basis: "INTERPRETATION: as above, for the fill that completes the requested entry size",
  },
  {
    from: "EXIT_PLANNED",
    trigger: "EXIT_ABANDONED",
    to: "OPEN",
    basis: "INTERPRETATION: a planned exit that never became an order leaves the position open",
  },
  {
    from: "EXIT_PLANNED",
    trigger: "EXIT_PARTIAL_FILL",
    to: "EXIT_WORKING",
    basis: "INTERPRETATION: a confirmed exit fill proves the order existed (§8.1 ordering)",
  },
  {
    from: "EXIT_PLANNED",
    trigger: "EXIT_FILL_COMPLETE",
    to: "CLOSED",
    basis: "INTERPRETATION: as above, for a fill that flattens the allocation",
  },
  {
    from: "EXIT_PLANNED",
    trigger: "MARKET_RESOLVED",
    to: "CLOSED",
    basis: "INTERPRETATION: settlement ends the position (§9.3)",
  },
  {
    from: "EXIT_WORKING",
    trigger: "EXIT_PARTIAL_FILL",
    to: "EXIT_WORKING",
    basis: "§6 invariant 10: partial fills are first-class on the exit too",
  },
  {
    from: "EXIT_WORKING",
    trigger: "ENTRY_PARTIAL_FILL",
    to: "PARTIALLY_OPEN",
    basis: "INTERPRETATION: §13.3 rules 1 and 2 — a further ENTRY fill while a proportional exit is working enlarges the ACTUAL allocation; the resting exit is stale and is re-planned from the new allocation",
  },
  {
    from: "EXIT_WORKING",
    trigger: "ENTRY_FILL_COMPLETE",
    to: "OPEN",
    basis: "INTERPRETATION: as above, for the fill that completes the requested entry size",
  },
  {
    from: "EXIT_WORKING",
    trigger: "EXIT_FILL_COMPLETE",
    to: "CLOSED",
    basis: "§13.3 'EXIT_WORKING -> CLOSED'",
  },
  {
    from: "EXIT_WORKING",
    trigger: "EXIT_ORDER_TERMINAL_UNFILLED",
    to: "OPEN",
    basis: "INTERPRETATION: an exit order that ended without flattening leaves the position open and re-plannable",
  },
  {
    from: "EXIT_WORKING",
    trigger: "MARKET_RESOLVED",
    to: "CLOSED",
    basis: "INTERPRETATION: settlement ends the position (§9.3)",
  },
  {
    from: "CLOSED",
    trigger: "REARM",
    to: "ARMED",
    basis: "INTERPRETATION: §13.2's reentry block (maximum_entries_per_market, cooldown_seconds) is meaningless without this edge; it is guarded by the ACTUAL execution count (§13.3 rule 3) and the cool-down",
  },
  {
    from: "PAUSED",
    trigger: "RESUME",
    to: RESUME_TARGET,
    basis: "INTERPRETATION: §13.3 states the edge into PAUSED; an instance that could never leave it would make the incident ladder one-way",
  },
  ...pauseAndHaltEdges(),
]);

export type InstanceTransitionResult =
  | { readonly ok: true; readonly to: InstanceState; readonly basis: string }
  | { readonly ok: false; readonly problem: string };

/**
 * The instance machine's only mover. TOTAL: an unlisted `(from, trigger)` pair
 * refuses by name and changes nothing.
 */
export function instanceTransition(
  from: InstanceState,
  trigger: InstanceTrigger,
  resumeTo: InstanceState | null,
): InstanceTransitionResult {
  for (const edge of INSTANCE_TRANSITIONS) {
    if (edge.from !== from || edge.trigger !== trigger) continue;
    if (edge.to !== RESUME_TARGET) {
      return { ok: true, to: edge.to, basis: edge.basis };
    }
    if (resumeTo === null) {
      return {
        ok: false,
        problem:
          "illegal transition PAUSED --RESUME--> (no recorded pre-pause state); a resume with " +
          "nowhere to return to is refused rather than guessed",
      };
    }
    if (!isResumeTarget(resumeTo)) {
      return {
        ok: false,
        problem:
          `illegal transition PAUSED --RESUME--> ${resumeTo}; only a bracket state may be ` +
          "resumed into",
      };
    }
    return { ok: true, to: resumeTo, basis: edge.basis };
  }
  return {
    ok: false,
    problem: `illegal transition ${from} --${trigger}--> (no such edge in the §13.3 machine)`,
  };
}

// ---------------------------------------------------------------------------
// The working-order sub-machine (§13.3 "Working orders")
// ---------------------------------------------------------------------------

/**
 * What the strategy knows about one order it asked for.
 *
 * `PENDING` is the state between emitting the intent and seeing any evidence of
 * an order. `SUBMISSION_UNKNOWN` is the §13.3 terminal-of-the-cancel-path and
 * also what a long silence becomes: §6 invariant 6 forbids treating it as a
 * rejection, so it is a state of its own from which the strategy takes no new
 * action until it is reconciled.
 */
export const ORDER_STATES = Object.freeze([
  "PENDING",
  "WORKING",
  "CANCEL_PENDING",
  "CANCELED",
  "REJECTED",
  "SUBMISSION_UNKNOWN",
  "FILLED",
  "EXPIRED",
] as const);
export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_TRIGGERS = Object.freeze([
  "OBSERVED_WORKING",
  "OBSERVED_PARTIALLY_FILLED",
  "OBSERVED_FILLED",
  "OBSERVED_CANCELED",
  "OBSERVED_REJECTED",
  "OBSERVED_EXPIRED",
  "CANCEL_REQUESTED",
  "SILENCE_EXCEEDED",
  "RECONCILED_WORKING",
] as const);
export type OrderTrigger = (typeof ORDER_TRIGGERS)[number];

export interface OrderTransition {
  readonly from: OrderState;
  readonly trigger: OrderTrigger;
  readonly to: OrderState;
  readonly basis: string;
}

/** Terminal order states: nothing moves out of them. */
export const TERMINAL_ORDER_STATES: readonly OrderState[] = Object.freeze([
  "CANCELED",
  "REJECTED",
  "FILLED",
  "EXPIRED",
]);

export const ORDER_TRANSITIONS: readonly OrderTransition[] = Object.freeze([
  { from: "PENDING", trigger: "OBSERVED_WORKING", to: "WORKING", basis: "the order appeared" },
  {
    from: "PENDING",
    trigger: "OBSERVED_PARTIALLY_FILLED",
    to: "WORKING",
    basis: "a fill proves the order exists (§8.1 ordering is not guaranteed)",
  },
  { from: "PENDING", trigger: "OBSERVED_FILLED", to: "FILLED", basis: "the order filled outright" },
  { from: "PENDING", trigger: "OBSERVED_CANCELED", to: "CANCELED", basis: "observed terminal" },
  { from: "PENDING", trigger: "OBSERVED_REJECTED", to: "REJECTED", basis: "observed terminal" },
  { from: "PENDING", trigger: "OBSERVED_EXPIRED", to: "EXPIRED", basis: "observed terminal" },
  {
    from: "PENDING",
    trigger: "SILENCE_EXCEEDED",
    to: "SUBMISSION_UNKNOWN",
    basis: "§6 invariant 6: an unknown submission is never treated as a rejection",
  },
  { from: "WORKING", trigger: "OBSERVED_WORKING", to: "WORKING", basis: "no change" },
  {
    from: "WORKING",
    trigger: "OBSERVED_PARTIALLY_FILLED",
    to: "WORKING",
    basis: "§6 invariant 10: a partial fill leaves the order working",
  },
  { from: "WORKING", trigger: "OBSERVED_FILLED", to: "FILLED", basis: "observed terminal" },
  { from: "WORKING", trigger: "OBSERVED_CANCELED", to: "CANCELED", basis: "observed terminal" },
  { from: "WORKING", trigger: "OBSERVED_REJECTED", to: "REJECTED", basis: "observed terminal" },
  { from: "WORKING", trigger: "OBSERVED_EXPIRED", to: "EXPIRED", basis: "observed terminal" },
  {
    from: "WORKING",
    trigger: "CANCEL_REQUESTED",
    to: "CANCEL_PENDING",
    basis: "§13.3 'Working orders: -> CANCEL_PENDING'",
  },
  {
    from: "CANCEL_PENDING",
    trigger: "OBSERVED_CANCELED",
    to: "CANCELED",
    basis: "§13.3 'CANCEL_PENDING -> CANCELED'",
  },
  {
    from: "CANCEL_PENDING",
    trigger: "OBSERVED_REJECTED",
    to: "REJECTED",
    basis: "§13.3 'CANCEL_PENDING -> REJECTED'",
  },
  {
    from: "CANCEL_PENDING",
    trigger: "SILENCE_EXCEEDED",
    to: "SUBMISSION_UNKNOWN",
    basis: "§13.3 'CANCEL_PENDING -> SUBMISSION_UNKNOWN'",
  },
  {
    from: "CANCEL_PENDING",
    trigger: "OBSERVED_FILLED",
    to: "FILLED",
    basis: "a cancel that lost the race leaves a filled order, which is a fact, not an error",
  },
  {
    from: "CANCEL_PENDING",
    trigger: "OBSERVED_PARTIALLY_FILLED",
    to: "CANCEL_PENDING",
    basis: "a fill during the cancel race does not resolve the cancel",
  },
  {
    from: "CANCEL_PENDING",
    trigger: "OBSERVED_EXPIRED",
    to: "EXPIRED",
    basis: "observed terminal",
  },
  {
    from: "SUBMISSION_UNKNOWN",
    trigger: "RECONCILED_WORKING",
    to: "WORKING",
    basis: "§6 invariant 6: reconciliation, not retry, resolves an unknown submission",
  },
  {
    from: "SUBMISSION_UNKNOWN",
    trigger: "OBSERVED_PARTIALLY_FILLED",
    to: "WORKING",
    basis: "a fill reconciles the unknown submission",
  },
  {
    from: "SUBMISSION_UNKNOWN",
    trigger: "OBSERVED_WORKING",
    to: "WORKING",
    basis: "the order was found",
  },
  {
    from: "SUBMISSION_UNKNOWN",
    trigger: "OBSERVED_FILLED",
    to: "FILLED",
    basis: "the order was found, filled",
  },
  {
    from: "SUBMISSION_UNKNOWN",
    trigger: "OBSERVED_CANCELED",
    to: "CANCELED",
    basis: "the order was found, canceled",
  },
  {
    from: "SUBMISSION_UNKNOWN",
    trigger: "OBSERVED_REJECTED",
    to: "REJECTED",
    basis: "the order was found, rejected",
  },
  {
    from: "SUBMISSION_UNKNOWN",
    trigger: "OBSERVED_EXPIRED",
    to: "EXPIRED",
    basis: "the order was found, expired",
  },
]);

export type OrderTransitionResult =
  | { readonly ok: true; readonly to: OrderState; readonly basis: string }
  | { readonly ok: false; readonly problem: string };

/** The sub-machine's only mover. TOTAL; an unlisted pair refuses by name. */
export function orderTransition(from: OrderState, trigger: OrderTrigger): OrderTransitionResult {
  for (const edge of ORDER_TRANSITIONS) {
    if (edge.from === from && edge.trigger === trigger) {
      return { ok: true, to: edge.to, basis: edge.basis };
    }
  }
  return {
    ok: false,
    problem: `illegal order transition ${from} --${trigger}--> (no such edge in the §13.3 sub-machine)`,
  };
}

export function isInstanceState(value: unknown): value is InstanceState {
  return typeof value === "string" && (INSTANCE_STATES as readonly string[]).includes(value);
}

export function isOrderState(value: unknown): value is OrderState {
  return typeof value === "string" && (ORDER_STATES as readonly string[]).includes(value);
}

/** Parses a persisted instance state, refusing an unknown value by name. */
export function readInstanceState(value: unknown, path: string): Outcome<InstanceState> {
  if (!isInstanceState(value)) {
    return bad(`${path} is not a §13.3 instance state`);
  }
  return ok(value);
}

/** Parses a persisted order state, refusing an unknown value by name. */
export function readOrderState(value: unknown, path: string): Outcome<OrderState> {
  if (!isOrderState(value)) {
    return bad(`${path} is not a §13.3 working-order state`);
  }
  return ok(value);
}
