/**
 * IS THE §13.3 TRANSITION TABLE CLOSED OVER WHAT THE CODE ACTUALLY DOES?
 *
 * `machine.test.ts` derives its coverage FROM the table: it walks every listed
 * edge and asserts every unlisted pair refuses. That is a good property and it
 * is structurally incapable of finding a MISSING edge — a `(from, trigger)` pair
 * the code takes but the table omits simply becomes one more complement row
 * asserted to refuse, and the suite goes green while the shipped strategy halts.
 *
 * Review round 1 found four such pairs, two of them on live routes: an entry
 * order that reached a terminal venue state before it was ever seen resting (the
 * §13.2 example's most ordinary failure — an aggressive FAK that finds no
 * liquidity) halted the instance, and an exit order the OMS reported CANCELED
 * halted it with an OPEN POSITION and zero intents, so the stop never fired
 * again.
 *
 * This file closes the loop from the other side, five ways:
 *
 * 1. **A bounded state sweep** through the SHIPPED callback: every reachable
 *    combination of bracket state, entry-order state, exit-order state,
 *    allocation and economic leg must produce a decision, never a halt.
 * 2. **A call-site inventory**, checked against the source: every `move()` in
 *    `decide.ts` carries a `// MOVE-SITE: <name> TRIGGERS: ...` marker, the
 *    inventory below names the triggers and the `from` states each site can
 *    reach, and every pair a site can reach must exist in the table (or be an
 *    explicitly declared, reasoned refusal). Review round 2 showed the census
 *    could be evaded two ways — an ALIASED call (`const step = move;`) is
 *    invisible to a textual `move(` count, and the inventory's `required` list
 *    is a hand-written literal that can be emptied — so the identifier is now
 *    forbidden to appear anywhere except immediately before a `(`, and the
 *    trigger list is declared at the call site and cross-checked BOTH against
 *    the inventory and against the literals the call really passes.
 * 3. **§6 invariant 13**, re-verified over the same sweep now that the exit
 *    states have self-edges: no decision may both cancel and place, and no
 *    replacement may be planned while a cancel is unconfirmed.
 * 4. **Repeated order views over TERMINAL tracked orders**, which review round 2
 *    found halting the instance permanently with an open position. Terminal
 *    states have no outgoing edge and must not gain one; the VIEW is absorbed
 *    instead.
 * 5. **Order views over NON-TERMINAL tracked orders** — the complement round 2
 *    recorded and did not close. An `OPEN` view (or any status this package
 *    cannot interpret) for an order whose cancel is in flight halted the
 *    instance while it held the position; review round 3 reproduced it through
 *    the real runtime and sanctioned ONE machine row for it. The whole
 *    `(non-terminal track state × view status)` space is swept here.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  INSTANCE_STATES,
  INSTANCE_TRANSITIONS,
  INSTANCE_TRIGGERS,
  ORDER_STATES,
  ORDER_TRANSITIONS,
  ORDER_TRIGGERS,
  REASONS,
  TERMINAL_ORDER_STATES,
  orderTransition,
  staticBracketParamsSchema,
  staticBracketStrategy,
  type ExitRole,
  type InstanceState,
  type InstanceTrigger,
  type OrderState,
  type OrderTrack,
  type StaticBracketState,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import type { DecisionResult } from "../../../../packages/domain/src/index.js";
import {
  STOP_KEY,
  T_NOW,
  baseConfig,
  configWith,
  context,
  parsedParams,
  stateWith,
} from "./helpers.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DECIDE_SOURCE = join(
  REPO_ROOT,
  "packages/strategies/static-bracket/src/decide.ts",
);

const NOW_MS = Date.parse(T_NOW);

function params(config: Record<string, unknown> = baseConfig()) {
  return parsedParams(staticBracketParamsSchema, config);
}

// ---------------------------------------------------------------------------
// 1. The bounded sweep
// ---------------------------------------------------------------------------

const SWEEP_ORDER_STATES: readonly (OrderState | null)[] = [null, ...ORDER_STATES];
/** Every bracket state a live instance can be in. HALTED holds by design. */
const SWEEP_INSTANCE_STATES: readonly InstanceState[] = INSTANCE_STATES.filter(
  (state) => state !== "HALTED",
);

/**
 * `BRACKET-1a`: the exit slot holds one of TWO roles — a take-profit, or the
 * protective reduction that now has a track of its own — and the ladder treats
 * them differently (a live reduction is held, never withdrawn, re-sized or
 * cancelled by take-profit maintenance). Every sweep in this file therefore
 * runs each exit-order shape in BOTH roles, so the stale-data gate, the
 * no-halt property and §6 invariant 13 are proved over reduction-role tracks
 * too, not only over the take-profit shape they were first written for.
 */
const SWEEP_EXIT_ROLES: readonly ExitRole[] = ["TAKE_PROFIT", "PROTECTED_REDUCE"];

interface Shape {
  readonly instanceState: InstanceState;
  readonly entryState: OrderState | null;
  readonly exitState: OrderState | null;
  readonly allocated: string;
  readonly leg: "YES" | "NO";
  readonly exitRole: ExitRole;
}

function track(
  kind: "ENTRY" | "EXIT",
  state: OrderState,
  shape: Shape,
): OrderTrack {
  const complement = shape.leg === "YES" ? false : true;
  const entrySide = complement ? "SELL" : "BUY";
  const reduction = shape.exitRole === "PROTECTED_REDUCE";
  return {
    kind,
    intentId:
      kind === "ENTRY" ? "sb-entry-0" : reduction ? "sb-protected-reduce-1" : "sb-take-profit-1",
    orderId: kind === "ENTRY" ? "order-1" : "order-2",
    state,
    outcome: shape.leg,
    side: kind === "ENTRY" ? entrySide : entrySide === "BUY" ? "SELL" : "BUY",
    limitPrice:
      kind === "ENTRY"
        ? complement
          ? "0.65"
          : "0.35"
        : reduction
          ? complement
            ? "0.74"
            : "0.26"
          : "0.5",
    requestedShares: "50",
    filledShares: kind === "ENTRY" ? shape.allocated : "0",
    viewFilledShares: kind === "ENTRY" ? shape.allocated : "0",
    placedAtMs: NOW_MS,
    escalated: true,
  };
}

function stateFor(shape: Shape): StaticBracketState {
  const open = shape.allocated !== "0";
  return stateWith({
    instanceState: shape.instanceState,
    resumeTo: shape.instanceState === "PAUSED" ? "OPEN" : null,
    allocatedShares: shape.allocated,
    allocatedCost: open ? "17.5" : "0",
    legOutcome: open ? shape.leg : null,
    legBaselineShares: open && shape.leg === "NO" ? "100" : "0",
    entriesExecuted: open ? 1 : 0,
    openedAtMs: open ? NOW_MS - 1000 : null,
    entryOrder: shape.entryState === null ? null : track("ENTRY", shape.entryState, shape),
    exitOrder: shape.exitState === null ? null : track("EXIT", shape.exitState, shape),
  });
}

function viewsFor(shape: Shape): Record<string, unknown> {
  // The position view agrees with the bracket, so the sweep exercises the
  // machine rather than the reconciliation branch.
  return shape.leg === "YES"
    ? { yesShares: shape.allocated }
    : { noShares: shape.allocated === "0" ? "100" : "50" };
}

function* shapes(): Generator<Shape> {
  for (const instanceState of SWEEP_INSTANCE_STATES) {
    for (const entryState of SWEEP_ORDER_STATES) {
      for (const exitState of SWEEP_ORDER_STATES) {
        for (const allocated of ["0", "50"]) {
          for (const leg of ["YES", "NO"] as const) {
            for (const exitRole of SWEEP_EXIT_ROLES) {
              yield { instanceState, entryState, exitState, allocated, leg, exitRole };
            }
          }
        }
      }
    }
  }
}

function label(shape: Shape): string {
  return `${shape.instanceState}/${String(shape.entryState)}/${String(shape.exitState)}/${
    shape.allocated
  }/${shape.leg}/${shape.exitRole}`;
}

/**
 * The state a decision leaves behind.
 *
 * `render` omits `statePatch` when the state did not change (§7.5 makes it
 * optional), so chaining evaluations means carrying the previous document
 * forward rather than assuming a patch is always there.
 */
function nextState(previous: StaticBracketState, decision: DecisionResult): StaticBracketState {
  return decision.statePatch === undefined
    ? previous
    : (decision.statePatch as unknown as StaticBracketState);
}

const PREFERRING = configWith({
  "entry.economic_leg_policy": "PREFER_CHEAPEST_WITH_INVENTORY",
});

describe("the §13.3 machine is CLOSED over the shapes the code can reach", () => {
  it("never halts on any reachable (bracket, entry order, exit order, allocation, leg)", () => {
    const halted: string[] = [];
    let evaluated = 0;
    for (const shape of shapes()) {
      evaluated += 1;
      const decision = staticBracketStrategy.onFeatures(
        context(params(PREFERRING), stateFor(shape), viewsFor(shape)),
      );
      if (decision.reasonCodes.includes(REASONS.halted)) {
        halted.push(
          `${label(shape)}: ${String(
            (decision.statePatch as Record<string, unknown>)["haltReason"],
          )}`,
        );
      }
    }
    // 10 bracket states x 9 entry-order states x 9 exit-order states
    // x 2 allocations x 2 legs x 2 exit roles (`BRACKET-1a`: 3240 before the
    // protective reduction had a track to put in the exit slot).
    expect(evaluated).toBe(6480);
    expect(halted).toEqual([]);
  });

  it("never halts with the stop deep in the money either", () => {
    // The route that mattered most: a halt with an OPEN position and the stop
    // satisfied abandoned the position permanently.
    const halted: string[] = [];
    for (const shape of shapes()) {
      if (shape.allocated === "0") continue;
      const decision = staticBracketStrategy.onFeatures(
        context(params(PREFERRING), stateFor(shape), {
          ...viewsFor(shape),
          features: { [STOP_KEY]: "0.1" },
        }),
      );
      if (decision.reasonCodes.includes(REASONS.halted)) halted.push(label(shape));
    }
    expect(halted).toEqual([]);
  });

  it("never TRANSITIONS into ARMED while a confirmed allocation is on the books", () => {
    // Re-arming with an allocation still recorded would let the instance enter
    // again on top of a position it already holds. Only a transition out of a
    // state that has ALREADY PROGRESSED counts: a hand-written document that is
    // DORMANT or ARMED while carrying an allocation is incoherent input (the
    // fresh document allocates nothing), and §13.3's own `DORMANT -> ARMED` is
    // right to fire regardless. The risk caps — not the machine — are what
    // answer those, which the next assertion pins.
    const leaked: string[] = [];
    for (const shape of shapes()) {
      if (shape.allocated === "0") continue;
      if (shape.instanceState === "ARMED" || shape.instanceState === "DORMANT") continue;
      const before = stateFor(shape);
      const decision = staticBracketStrategy.onFeatures(
        context(params(PREFERRING), before, viewsFor(shape)),
      );
      const after = nextState(before, decision);
      if (after.instanceState === "ARMED" && after.allocatedShares !== "0") {
        leaked.push(`${label(shape)} -> ${after.instanceState}`);
      }
    }
    expect(leaked).toEqual([]);
  });

  it("the stale-data gate still precedes EVERY path, including the new ones", () => {
    // §13.3 rule 4: "a stop on stale data is forbidden; incident policy applies
    // first". The remediation added a terminal-order settlement step inside
    // planExit and a new entry-terminal branch; both sit BEHIND the gate, and
    // this sweeps the whole shape space with a book the strategy must refuse to
    // act on. Nothing position-changing may come out — not an entry, not a
    // take-profit, not a reduction — however deep the stop is in the money.
    const acted: string[] = [];
    const STALE = "2026-03-04T12:04:00.000Z"; // 60s old against a 2000ms bound.
    for (const shape of shapes()) {
      const decision = staticBracketStrategy.onFeatures(
        context(params(PREFERRING), stateFor(shape), {
          ...viewsFor(shape),
          features: { [STOP_KEY]: "0.1" },
          yes: { bids: [["0.34", "2000"]], asks: [["0.35", "2000"]], asOf: STALE },
          no: { bids: [["0.64", "2000"]], asks: [["0.66", "2000"]], asOf: STALE },
        }),
      );
      if (places(decision) > 0) acted.push(`${label(shape)}: ${decision.decisionType}`);
      if (!decision.reasonCodes.includes(REASONS.staleBook)) {
        acted.push(`${label(shape)}: gate not reported`);
      }
    }
    expect(acted).toEqual([]);
  });

  it("an incoherent ARMED-with-allocation document is REFUSED, never entered on top of", () => {
    // §13.2's own risk and reentry blocks are the backstop for a state document
    // that claims ARMED while an allocation is recorded: the entry count is
    // spent, and the position projection is held + size, so either bound
    // refuses. What matters is that no position-changing intent comes out.
    for (const leg of ["YES", "NO"] as const) {
      const shape: Shape = {
        instanceState: "ARMED",
        entryState: null,
        exitState: null,
        allocated: "50",
        leg,
        exitRole: "TAKE_PROFIT",
      };
      const decision = staticBracketStrategy.onFeatures(
        context(params(PREFERRING), stateFor(shape), { yesShares: "50" }),
      );
      expect(decision.decisionType, label(shape)).toBe("hold");
      expect(decision.intents).toHaveLength(0);
      expect(
        decision.reasonCodes.some(
          (code) => code === REASONS.refusedPositionCap || code === REASONS.refusedMaxEntries,
        ),
        `${label(shape)}: ${decision.reasonCodes.join(",")}`,
      ).toBe(true);
    }
  });

  it("an ARMED instance with an order IN FLIGHT refuses structurally, not by arithmetic", () => {
    // NOTE-2. Before the guard, every ARMED shape carrying a live order was
    // refused by the §13.2 example's risk and reentry bounds — the position
    // projection is `held + size` and the entry count is spent. That is an
    // arithmetic coincidence of one configuration: give both bounds slack and
    // the instance would have entered on top of an order already in flight.
    const roomy = configWith({
      "risk.maximum_position_shares": "10000",
      "risk.maximum_contractual_loss": "10000",
      "entry.maximum_total_cost": "10000",
      "reentry.maximum_entries_per_market": 9,
    });
    for (const orderState of ["PENDING", "WORKING", "CANCEL_PENDING"] as const) {
      for (const kind of ["ENTRY", "EXIT"] as const) {
        for (const exitRole of SWEEP_EXIT_ROLES) {
          const shape: Shape = {
            instanceState: "ARMED",
            entryState: kind === "ENTRY" ? orderState : null,
            exitState: kind === "EXIT" ? orderState : null,
            allocated: "0",
            leg: "YES",
            exitRole,
          };
          const decision = staticBracketStrategy.onFeatures(
            context(params(roomy), stateFor(shape), {
              yesShares: "0",
              features: { "polymarket.executable_buy_price@50": "0.3" },
            }),
          );
          expect(decision.decisionType, label(shape)).toBe("hold");
          expect(decision.intents, label(shape)).toHaveLength(0);
          expect(decision.reasonCodes, label(shape)).toContain(REASONS.refusedOrderInFlight);
        }
      }
    }
    // Discrimination: with NOTHING in flight the same roomy configuration DOES
    // enter, so the refusal above is the guard and not the fixture.
    const clear = staticBracketStrategy.onFeatures(
      context(
        params(roomy),
        stateFor({
          instanceState: "ARMED",
          entryState: null,
          exitState: null,
          allocated: "0",
          leg: "YES",
          exitRole: "TAKE_PROFIT",
        }),
        { yesShares: "0", features: { "polymarket.executable_buy_price@50": "0.3" } },
      ),
    );
    expect(clear.decisionType).toBe("enter");
  });
});

// ---------------------------------------------------------------------------
// 2. The call-site inventory
// ---------------------------------------------------------------------------

/**
 * Every `move()` call site in `decide.ts`, by its `// MOVE-SITE:` marker.
 *
 * Each site declares the `(from, trigger)` pairs it can actually form — read off
 * its callers and its own guards, not guessed — split two ways:
 *
 * - `required`: the pairs whose absence from the table would HALT or STRAND the
 *   instance. Every one of these must exist. This is the check the
 *   table-derived suite structurally cannot make.
 * - `tolerated`: pairs the site can also form, whose refusal is the designed
 *   answer (a fill that does not fit the bracket's picture of itself reconciles
 *   under §6 invariant 12) or is handled without a halt. Every one of these must
 *   be ABSENT from the table — so a pair that quietly becomes legal has to be
 *   promoted here rather than drifting.
 */
interface MovePair {
  readonly from: InstanceState;
  readonly trigger: InstanceTrigger;
}

interface MoveSite {
  readonly name: string;
  readonly required: readonly MovePair[];
  readonly tolerated: readonly MovePair[];
  readonly why: string;
}

const BRACKET: readonly InstanceState[] = [
  "DORMANT",
  "ARMED",
  "ENTRY_PLANNED",
  "ENTRY_WORKING",
  "PARTIALLY_OPEN",
  "OPEN",
  "EXIT_PLANNED",
  "EXIT_WORKING",
  "CLOSED",
];

function cross(
  froms: readonly InstanceState[],
  triggers: readonly InstanceTrigger[],
): readonly MovePair[] {
  return froms.flatMap((from) => triggers.map((trigger) => ({ from, trigger })));
}

function except(
  all: readonly InstanceState[],
  removed: readonly InstanceState[],
): readonly InstanceState[] {
  return all.filter((state) => !removed.includes(state));
}

const EXIT_HOSTS: readonly InstanceState[] = [
  "PARTIALLY_OPEN",
  "OPEN",
  "EXIT_PLANNED",
  "EXIT_WORKING",
];

const MOVE_SITES: readonly MoveSite[] = [
  {
    name: "syncPlannedToWorking",
    required: [
      { from: "ENTRY_PLANNED", trigger: "ENTRY_ORDER_WORKING" },
      { from: "EXIT_PLANNED", trigger: "EXIT_ORDER_WORKING" },
    ],
    tolerated: [],
    why: "guarded by an explicit instanceState check that pairs each trigger with one state",
  },
  {
    name: "incidentPause",
    required: cross(BRACKET, ["PAUSE"]),
    tolerated: [],
    why: "the data-quality branch returns early when the instance is already PAUSED",
  },
  {
    name: "resume",
    required: [{ from: "PAUSED", trigger: "RESUME" }],
    tolerated: [],
    why: "guarded by instanceState === PAUSED",
  },
  {
    name: "marketClosed",
    required: cross(["DORMANT", "ARMED", "ENTRY_PLANNED", "ENTRY_WORKING"], ["MARKET_CLOSED"]),
    tolerated: cross(
      ["PARTIALLY_OPEN", "OPEN", "EXIT_PLANNED", "EXIT_WORKING", "CLOSED"],
      ["MARKET_CLOSED"],
    ),
    why: "guarded by !hasAllocation; a bracket state with a spent allocation reaches it and holds with SB.MARKET_CLOSED without transitioning",
  },
  {
    name: "arm",
    required: [{ from: "DORMANT", trigger: "ARM" }],
    tolerated: [],
    why: "the DORMANT case of the ladder switch",
  },
  {
    name: "entryTriggerMet",
    required: [{ from: "ARMED", trigger: "ENTRY_TRIGGER_MET" }],
    tolerated: [],
    why: "planEntry is reached only from the ARMED case of the ladder switch",
  },
  {
    name: "entryAbandoned",
    required: cross(
      ["ENTRY_PLANNED", "ENTRY_WORKING"],
      ["ENTRY_ABANDONED", "ENTRY_ORDER_TERMINAL_PARTIAL"],
    ),
    tolerated: [],
    why: "planEntryOrderManagement handles exactly these two states, and picks the trigger by whether a confirmed allocation exists",
  },
  {
    name: "entryTerminalUnfilled",
    required: cross(["ENTRY_PLANNED", "ENTRY_WORKING"], ["ENTRY_ORDER_TERMINAL_UNFILLED"]),
    tolerated: cross(
      except(BRACKET, ["ENTRY_PLANNED", "ENTRY_WORKING"]),
      ["ENTRY_ORDER_TERMINAL_UNFILLED"],
    ),
    why: "a terminal entry with no folded fill and no view evidence; only the two entry states occur in practice, and settleTerminalOrder clears the track either way",
  },
  {
    name: "entryTerminalPartial",
    required: cross(
      ["ENTRY_PLANNED", "ENTRY_WORKING", "PARTIALLY_OPEN"],
      ["ENTRY_ORDER_TERMINAL_PARTIAL"],
    ),
    tolerated: cross(
      except(BRACKET, ["ENTRY_PLANNED", "ENTRY_WORKING", "PARTIALLY_OPEN"]),
      ["ENTRY_ORDER_TERMINAL_PARTIAL"],
    ),
    why: "guarded by an explicit instanceState check on exactly these three states",
  },
  {
    name: "exitTerminal",
    required: [
      { from: "EXIT_PLANNED", trigger: "EXIT_ABANDONED" },
      { from: "EXIT_WORKING", trigger: "EXIT_ORDER_TERMINAL_UNFILLED" },
    ],
    tolerated: [
      { from: "EXIT_WORKING", trigger: "EXIT_ABANDONED" },
      { from: "EXIT_PLANNED", trigger: "EXIT_ORDER_TERMINAL_UNFILLED" },
    ],
    why: "the trigger is chosen BY instanceState and is null outside these two, so only the paired combinations are ever formed",
  },
  {
    name: "bracketFinished",
    required: [
      { from: "EXIT_PLANNED", trigger: "EXIT_FILL_COMPLETE" },
      { from: "EXIT_WORKING", trigger: "EXIT_FILL_COMPLETE" },
      { from: "PARTIALLY_OPEN", trigger: "POSITION_FLAT" },
      { from: "OPEN", trigger: "POSITION_FLAT" },
    ],
    tolerated: [
      { from: "PARTIALLY_OPEN", trigger: "EXIT_FILL_COMPLETE" },
      { from: "OPEN", trigger: "EXIT_FILL_COMPLETE" },
      { from: "EXIT_PLANNED", trigger: "POSITION_FLAT" },
      { from: "EXIT_WORKING", trigger: "POSITION_FLAT" },
    ],
    why: "planExit picks the trigger by state, so only the paired combinations are formed",
  },
  {
    name: "takeProfitPlaced",
    required: cross(EXIT_HOSTS, ["EXIT_TRIGGER_MET"]),
    tolerated: [],
    why: "reached from planExit's four states and from applyEntryFill, which has already moved into PARTIALLY_OPEN or OPEN",
  },
  {
    name: "protectedReduce",
    required: cross(EXIT_HOSTS, ["EXIT_TRIGGER_MET"]),
    tolerated: [],
    why: "as above, through the stop, the holding timeout and the final policy; since BRACKET-1a the move also writes the reduction's order track (D1) — same site, same pairs",
  },
  {
    name: "reduceStillLive",
    required: cross(["PARTIALLY_OPEN", "OPEN"], ["EXIT_TRIGGER_MET"]),
    tolerated: [],
    why: "BRACKET-1a D4: a late ENTRY fill moved the bracket out of the exit states while its own protective reduction is live; holdForLiveReduce re-takes EXIT_TRIGGER_MET so the reduction's fill still folds. Guarded by an explicit instanceState check on exactly these two states",
  },
  {
    name: "exitIntentExpired",
    required: [{ from: "EXIT_PLANNED", trigger: "EXIT_ABANDONED" }],
    tolerated: [],
    why: "BRACKET-1a ruling R2: a protective reduction never named by a view or a fill, past its own validUntil, is retired through the existing 'planned exit that never became an order' edge. Guarded by instanceState === EXIT_PLANNED; any other state only clears the track",
  },
  {
    name: "reconcilePause",
    required: cross(BRACKET, ["PAUSE"]),
    tolerated: [],
    why: "an instance that is already PAUSED returns before this site",
  },
  {
    name: "rearm",
    required: [{ from: "CLOSED", trigger: "REARM" }],
    tolerated: [],
    why: "planRearm is the CLOSED case of the ladder switch",
  },
  {
    name: "entryFill",
    required: cross(
      ["ENTRY_PLANNED", "ENTRY_WORKING", "PARTIALLY_OPEN", "EXIT_PLANNED", "EXIT_WORKING"],
      ["ENTRY_PARTIAL_FILL", "ENTRY_FILL_COMPLETE"],
    ),
    tolerated: cross(
      ["DORMANT", "ARMED", "OPEN", "CLOSED"],
      ["ENTRY_PARTIAL_FILL", "ENTRY_FILL_COMPLETE"],
    ),
    why: "an entry fill that does not fit the bracket's picture of itself is a DESIGNED refusal: refuseTransition reconciles under §6 invariant 12 rather than transitioning or halting",
  },
  {
    name: "exitFill",
    required: cross(
      ["EXIT_PLANNED", "EXIT_WORKING"],
      ["EXIT_PARTIAL_FILL", "EXIT_FILL_COMPLETE"],
    ),
    tolerated: cross(
      except(BRACKET, ["EXIT_PLANNED", "EXIT_WORKING"]),
      ["EXIT_PARTIAL_FILL", "EXIT_FILL_COMPLETE"],
    ),
    why: "as above, for an exit fill",
  },
  {
    name: "marketResolved",
    required: cross(
      ["ARMED", "PARTIALLY_OPEN", "OPEN", "EXIT_PLANNED", "EXIT_WORKING"],
      ["MARKET_RESOLVED"],
    ),
    tolerated: cross(["DORMANT", "ENTRY_PLANNED", "ENTRY_WORKING", "CLOSED"], ["MARKET_RESOLVED"]),
    why: "graceful: an unlisted pair records SB.CLOSED without transitioning",
  },
];

/**
 * One `// MOVE-SITE: <name> TRIGGERS: <T> <T> ...` marker, as written in the
 * shipped source, with the line it sits on.
 *
 * FORCING FINDING r2-L3: the marker used to carry only a name, so the two
 * halves of the census — the source and the hand-written {@link MOVE_SITES}
 * table — could drift apart with nothing to notice it. The trigger list is now
 * declared AT the call site, checked against the table, AND checked against the
 * literals the call site actually passes.
 */
interface Marker {
  readonly name: string;
  readonly triggers: readonly string[];
  readonly line: number;
}

function decideSource(): string {
  return readFileSync(DECIDE_SOURCE, "utf8");
}

/**
 * `decide.ts` with every comment blanked out, line count preserved.
 *
 * The identifier census below is about CODE: the module's prose says "move"
 * in the ordinary English sense in several places, and a scan that could not
 * tell the two apart would either be noisy or would have to be weakened until
 * it stopped catching the thing it exists to catch. Newlines are preserved so
 * reported line numbers stay true.
 *
 * RESIDUAL, stated rather than hidden: this is a lexical stripper, not a
 * parser. It does not know about `move` inside a string literal or a template
 * — which would be an odd way to smuggle a call, since the identifier would
 * still have to be referenced somewhere to be used — and it does not know
 * about regular-expression literals. The demonstrated evasion (`const step =
 * move;` plus an aliased call) is closed; a determined author with commit
 * access to this file can always evade any test in it.
 */
function decideCode(): string {
  const source = decideSource();
  let out = "";
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - index);
      index = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/gu, " ");
      index = stop;
      continue;
    }
    out += source[index] as string;
    index += 1;
  }
  return out;
}

function markers(): Marker[] {
  const lines = decideSource().split("\n");
  const found: Marker[] = [];
  for (const [index, text] of lines.entries()) {
    const match = /\/\/ MOVE-SITE: (\w+) TRIGGERS: ([A-Z_ ]+)$/u.exec(text.trimEnd());
    if (match === null) continue;
    found.push({
      name: match[1] as string,
      triggers: (match[2] as string).trim().split(/\s+/u),
      line: index,
    });
  }
  return found;
}

function markersInSource(): string[] {
  return markers().map((marker) => marker.name);
}

function tableHas(from: InstanceState, trigger: InstanceTrigger): boolean {
  return INSTANCE_TRANSITIONS.some((edge) => edge.from === from && edge.trigger === trigger);
}

describe("the shape of the two machines is pinned", () => {
  it("declares 11 instance states, 21 triggers and 63 instance edges", () => {
    // The counts are load-bearing for the completion record: an edge added or
    // removed without a review is exactly the class of change this file exists
    // to make visible.
    //
    // 63 = 44 declared rows + 19 generated PAUSE/HALT edges (PAUSE from the 9
    // states that are neither PAUSED nor HALTED; HALT from all 10 non-HALTED
    // states). Six of the 44 were added by the review-round-1 remediation.
    expect(INSTANCE_STATES).toHaveLength(11);
    expect(INSTANCE_TRIGGERS).toHaveLength(21);
    expect(INSTANCE_TRANSITIONS).toHaveLength(63);
    expect(INSTANCE_TRANSITIONS.filter((edge) => edge.trigger === "PAUSE")).toHaveLength(9);
    expect(INSTANCE_TRANSITIONS.filter((edge) => edge.trigger === "HALT")).toHaveLength(10);
    expect(new Set(INSTANCE_TRIGGERS).size).toBe(INSTANCE_TRIGGERS.length);
  });

  it("declares 8 order states, 9 order triggers and 28 order edges", () => {
    // FORCING FINDING r3-B1: 27 -> 28. The review-round-3 remediation added
    // exactly one row — `CANCEL_PENDING --OBSERVED_WORKING--> CANCEL_PENDING` —
    // and this pin is the one existing assertion it was allowed to move. No
    // order STATE and no order TRIGGER was added, and the instance table is
    // untouched at 11 / 21 / 63.
    expect(ORDER_STATES).toHaveLength(8);
    expect(ORDER_TRIGGERS).toHaveLength(9);
    expect(ORDER_TRANSITIONS).toHaveLength(28);
    expect(TERMINAL_ORDER_STATES).toHaveLength(4);
    // Terminal means terminal: no edge leaves one, not even a self-loop. A fill
    // that arrives for an already-terminal order updates the ALLOCATION through
    // `foldFillIntoOrder`, never the order's state (§6 invariant 5).
    for (const edge of ORDER_TRANSITIONS) {
      expect(
        (TERMINAL_ORDER_STATES as readonly string[]).includes(edge.from),
        `${edge.from} --${edge.trigger}--> leaves a terminal state`,
      ).toBe(false);
    }
  });

  it("the ONE row r3-B1 added is the cancel-race self-edge, and it resolves nothing", () => {
    // The sanctioned fix, asserted as data. `OPEN` is the only status the SDK
    // lets a root report for an order whose cancel is in flight (there is no
    // CANCEL_PENDING status in `strategy-sdk`'s `StrategyOrderStatus`), and §6
    // invariant 6 maps every status this package cannot interpret onto
    // `OBSERVED_WORKING` — so the trigger is ordinary traffic, not an anomaly.
    const edge = ORDER_TRANSITIONS.find(
      (candidate) => candidate.from === "CANCEL_PENDING" && candidate.trigger === "OBSERVED_WORKING",
    );
    expect(edge, "CANCEL_PENDING --OBSERVED_WORKING--> must exist").toBeDefined();
    expect(edge?.to).toBe("CANCEL_PENDING");
    expect(edge?.basis).toBe(
      "a still-working view during the cancel race does not resolve the cancel",
    );
    // It is a SELF-edge, exactly like the partial-fill row beside it: the cancel
    // stays unresolved, so nothing downstream may read it as a confirmation.
    const moved = orderTransition("CANCEL_PENDING", "OBSERVED_WORKING");
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.to).toBe("CANCEL_PENDING");
    // And the inconsistency it closes: the sibling state already had this row.
    const sibling = ORDER_TRANSITIONS.find(
      (candidate) =>
        candidate.from === "SUBMISSION_UNKNOWN" && candidate.trigger === "OBSERVED_WORKING",
    );
    expect(sibling?.to).toBe("WORKING");
    // The cancel path still terminates only on evidence: the three §13.3
    // terminals plus the fill that lost the race.
    const leaving = ORDER_TRANSITIONS.filter(
      (candidate) => candidate.from === "CANCEL_PENDING" && candidate.to !== "CANCEL_PENDING",
    ).map((candidate) => candidate.to);
    expect([...leaving].sort()).toEqual(["CANCELED", "EXPIRED", "FILLED", "REJECTED", "SUBMISSION_UNKNOWN"]);
  });

  it("has no duplicate (from, trigger) row, so the table is a function", () => {
    const seen = new Set<string>();
    for (const edge of INSTANCE_TRANSITIONS) {
      const key = `${edge.from}/${edge.trigger}`;
      expect(seen.has(key), `duplicate row ${key}`).toBe(false);
      seen.add(key);
    }
    const orderSeen = new Set<string>();
    for (const edge of ORDER_TRANSITIONS) {
      const key = `${edge.from}/${edge.trigger}`;
      expect(orderSeen.has(key), `duplicate order row ${key}`).toBe(false);
      orderSeen.add(key);
    }
  });

  it("gives every edge a basis that is a §13.3 quotation or a marked INTERPRETATION", () => {
    for (const edge of INSTANCE_TRANSITIONS) {
      expect(edge.basis, `${edge.from} --${edge.trigger}-->`).toMatch(/INTERPRETATION|§/u);
    }
  });
});

describe("every move() call site names a pair the table contains", () => {
  it("has real source to scan, and a marker for every move() call", () => {
    const source = decideSource();
    expect(source.length).toBeGreaterThan(1000);
    // Count `move(` calls that are not `moveOrder(` and not the definition.
    const calls = [...source.matchAll(/(?<![\w.])move\(/gu)].length;
    const definition = 1;
    expect(markersInSource()).toHaveLength(calls - definition);
  });

  it("`move` is never ALIASED, passed as a value, or re-exported", () => {
    // FORCING FINDING r2-L3, the demonstrated evasion. The count above is a
    // TEXTUAL census of `move(` call sites, so `const step = move;` followed by
    // `step(state, "PAUSE", ...)` adds a real, unmarked transition to the
    // shipped strategy and leaves this file entirely green — reproduced at
    // 293a640 with 21/21 passing.
    //
    // The rule that closes it: every whole-word occurrence of the identifier
    // `move` in `decide.ts` must be immediately followed by `(`. That admits
    // the declaration and every direct call, and rejects `= move`, `move,`,
    // `(move)`, `move as`, `export { move }` and `[move]` alike — every way of
    // getting a reference to the function without calling it by name.
    const code = decideCode();
    const offenders: string[] = [];
    for (const match of code.matchAll(/(?<![\w.$])move(?![\w$])/gu)) {
      const at = (match.index ?? 0) + "move".length;
      if (code[at] === "(") continue;
      const line = code.slice(0, match.index ?? 0).split("\n").length;
      offenders.push(`line ${String(line)}: ${code.slice(match.index ?? 0, at + 12).trim()}`);
    }
    expect(offenders, "move() may only ever be CALLED, by name").toEqual([]);
    // The check has content: it really does see the code, and it really does
    // reject the evasion when it is present.
    expect([...code.matchAll(/(?<![\w.$])move\(/gu)].length).toBeGreaterThan(15);
    const evaded = `${code}\n  const step = move;\n  step(state, "PAUSE");\n`;
    const caught = [...evaded.matchAll(/(?<![\w.$])move(?![\w$])/gu)].filter(
      (match) => evaded[(match.index ?? 0) + "move".length] !== "(",
    );
    expect(caught, "the alias evasion is what this check exists to reject").toHaveLength(1);
  });

  it("no MEMBER call named `move`, and `./machine.js` is imported by NAME only", () => {
    // FORCING FINDING r3-L2, and the third demonstrated evasion of this census.
    // Both checks above deliberately exclude an occurrence preceded by `.`
    // (`(?<![\w.$])`), because `moveOrder` and English prose would otherwise be
    // noise — which leaves one idiomatic hole wide open:
    //
    //     import * as machineNs from "./machine.js";
    //     ... machineNs.move(state, "RESUME")
    //
    // REPRODUCED at e316782 with a `move` helper added to `machine.ts`: the
    // whole file stayed green (27/27), the package suite stayed green (299/299)
    // when the smuggled transition was behaviour-neutral, and `tsc --noEmit`
    // passed — an unmarked, uncensused transition site in the shipped strategy.
    //
    // Two rules close it, both on `decide.ts`:
    //
    // 1. no MEMBER access named `move` may be CALLED — `anything.move(` is
    //    rejected outright, whatever the namespace is called;
    // 2. the import of `./machine.js` must be a plain NAMED import: no
    //    `import * as ns`, no `as` renaming (which would let a named import be
    //    smuggled in under another identifier and escape rule 1 anyway).
    //
    // RESIDUAL, stated rather than hidden: this is still lexical, not a parser.
    // It does not see a member access built at run time (`ns["mo" + "ve"](...)`)
    // and it does not read the other modules. An author with commit access to
    // this file can always evade any test in it; what this closes is the
    // idiomatic, review-invisible route.
    const code = decideCode();

    const members = [...code.matchAll(/\.\s*move\s*\(/gu)].map((match) => {
      const line = code.slice(0, match.index ?? 0).split("\n").length;
      return `line ${String(line)}: ${match[0].trim()}`;
    });
    expect(members, "a member call named `move` bypasses the whole census").toEqual([]);

    const imports = [...code.matchAll(/import(?![\w$])([^;]*?)from\s*"\.\/machine\.js"/gu)];
    expect(imports, "decide.ts must import ./machine.js exactly once").toHaveLength(1);
    const clause = (imports[0]?.[1] ?? "").trim();
    expect(clause.startsWith("{"), `namespace or default import of ./machine.js: ${clause}`).toBe(
      true,
    );
    expect(clause.includes("*"), `namespace import of ./machine.js: ${clause}`).toBe(false);
    expect(
      /(?<![\w$])as(?![\w$])/u.test(clause),
      `renamed import of ./machine.js: ${clause}`,
    ).toBe(false);

    // The two checks have content: each really does reject the reproduction.
    const withNamespace = `import * as machineNs from "./machine.js";\n${code}\n  machineNs.move(state, "RESUME");\n`;
    expect([...withNamespace.matchAll(/\.\s*move\s*\(/gu)]).toHaveLength(1);
    const smuggled = [
      ...withNamespace.matchAll(/import(?![\w$])([^;]*?)from\s*"\.\/machine\.js"/gu),
    ].map((match) => match[1]?.trim() ?? "");
    expect(smuggled.some((entry) => entry.includes("*"))).toBe(true);
    // ...and a renamed named-import is caught by the same clause rule.
    const renamed = 'import { instanceTransition as go } from "./machine.js";';
    const renamedClause = (
      [...renamed.matchAll(/import(?![\w$])([^;]*?)from\s*"\.\/machine\.js"/gu)][0]?.[1] ?? ""
    ).trim();
    expect(/(?<![\w$])as(?![\w$])/u.test(renamedClause)).toBe(true);
  });

  it("every marker DECLARES the triggers its site passes, and the table agrees", () => {
    // FORCING FINDING r2-L3, the second half: `MOVE_SITES.required` is a
    // hand-written literal, and emptying one site's list left 21/21 green while
    // the code could still form the pairs. Two independent checks now bracket
    // it — the table against the marker, and the marker against the string
    // literals the call site really passes.
    const byName = new Map(markers().map((marker) => [marker.name, marker]));
    const lines = decideSource().split("\n");
    for (const site of MOVE_SITES) {
      const marker = byName.get(site.name);
      expect(marker, `${site.name} has a marker`).toBeDefined();
      if (marker === undefined) continue;

      // (a) the marker and the inventory name the same trigger set.
      const declared = [...new Set(marker.triggers)].sort();
      const tabled = [
        ...new Set([...site.required, ...site.tolerated].map((pair) => pair.trigger)),
      ].sort();
      expect(declared, `${site.name}: marker vs inventory`).toEqual(tabled);

      // (b) every declared trigger really appears as a string literal in the
      // window around the call — the trigger is either the literal argument or
      // the ternary/const just above it, so a marker that claims a trigger the
      // code does not pass fails here.
      const window = lines.slice(Math.max(0, marker.line - 20), marker.line + 20).join("\n");
      for (const trigger of declared) {
        expect(
          window.includes(`"${trigger}"`),
          `${site.name}: declares ${trigger}, which no literal near the call site passes`,
        ).toBe(true);
      }
    }
  });

  it("the inventory names exactly the markers in the source, with no drift", () => {
    expect([...markersInSource()].sort()).toEqual(
      MOVE_SITES.map((site) => site.name).sort(),
    );
  });

  it("names only real triggers and real states", () => {
    for (const site of MOVE_SITES) {
      for (const pair of [...site.required, ...site.tolerated]) {
        expect(
          (INSTANCE_TRIGGERS as readonly string[]).includes(pair.trigger),
          `${site.name} names ${pair.trigger}`,
        ).toBe(true);
        expect(
          (INSTANCE_STATES as readonly string[]).includes(pair.from),
          `${site.name} names ${pair.from}`,
        ).toBe(true);
      }
    }
  });

  it("every REQUIRED (from, trigger) exists in the table — the missing-edge check", () => {
    const missing: string[] = [];
    for (const site of MOVE_SITES) {
      for (const pair of site.required) {
        if (!tableHas(pair.from, pair.trigger)) {
          missing.push(`${site.name}: ${pair.from} --${pair.trigger}-->`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every TOLERATED pair is genuinely absent, so nothing drifts into legality unnoticed", () => {
    const drifted: string[] = [];
    for (const site of MOVE_SITES) {
      for (const pair of site.tolerated) {
        if (tableHas(pair.from, pair.trigger)) {
          drifted.push(`${site.name}: ${pair.from} --${pair.trigger}--> is now legal`);
        }
      }
    }
    expect(drifted).toEqual([]);
  });

  it("no site declares the same pair both required and tolerated", () => {
    for (const site of MOVE_SITES) {
      const required = new Set(site.required.map((pair) => `${pair.from}/${pair.trigger}`));
      for (const pair of site.tolerated) {
        expect(required.has(`${pair.from}/${pair.trigger}`), `${site.name}`).toBe(false);
      }
    }
  });

  it("the four edges review round 1 found missing are present, with a stated basis", () => {
    const required: readonly (readonly [InstanceState, InstanceTrigger])[] = [
      ["ENTRY_PLANNED", "ENTRY_ORDER_TERMINAL_UNFILLED"],
      ["ENTRY_PLANNED", "ENTRY_ORDER_TERMINAL_PARTIAL"],
      ["ENTRY_WORKING", "ENTRY_ABANDONED"],
      ["EXIT_PLANNED", "EXIT_TRIGGER_MET"],
      ["EXIT_WORKING", "EXIT_TRIGGER_MET"],
    ];
    for (const [from, trigger] of required) {
      const edge = INSTANCE_TRANSITIONS.find(
        (candidate) => candidate.from === from && candidate.trigger === trigger,
      );
      expect(edge, `${from} --${trigger}--> must exist`).toBeDefined();
      // Every edge that is not a §13.3 quotation must say so in its own words.
      expect(edge?.basis ?? "").toMatch(/INTERPRETATION|§13\.3/u);
      expect((edge?.basis ?? "").length).toBeGreaterThan(60);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. §6 invariant 13, re-verified with the new exit self-edges
// ---------------------------------------------------------------------------

function cancels(decision: DecisionResult): number {
  return decision.intents.filter((intent) => intent.type === "CANCEL").length;
}

function places(decision: DecisionResult): number {
  return decision.intents.filter(
    (intent) => intent.type === "POSITION" || intent.type === "REDUCE_POSITION",
  ).length;
}

describe("§6 invariant 13 — safety cancellation outranks new placement", () => {
  it("no decision in the whole sweep both cancels and places", () => {
    const offenders: string[] = [];
    for (const shape of shapes()) {
      for (const features of [undefined, { [STOP_KEY]: "0.1" }]) {
        const decision = staticBracketStrategy.onFeatures(
          context(params(PREFERRING), stateFor(shape), {
            ...viewsFor(shape),
            ...(features === undefined ? {} : { features }),
          }),
        );
        if (cancels(decision) > 0 && places(decision) > 0) offenders.push(label(shape));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("refuses to replace a take-profit while its cancel is unconfirmed", () => {
    // The exit self-edges made EXIT_PLANNED --EXIT_TRIGGER_MET--> legal. That
    // edge must NOT become a licence to place a replacement over an unconfirmed
    // cancel — before the remediation, the only thing preventing it was the halt
    // the missing edge caused, which is not a safety mechanism.
    for (const orderState of ["PENDING", "CANCEL_PENDING"] as const) {
      const state = stateWith({
        instanceState: "EXIT_PLANNED",
        allocatedShares: "50",
        allocatedCost: "17.5",
        legOutcome: "YES",
        entriesExecuted: 1,
        openedAtMs: NOW_MS - 1000,
        exitOrder: {
          kind: "EXIT",
          intentId: "sb-take-profit-1",
          orderId: "order-2",
          state: orderState,
          outcome: "YES",
          side: "SELL",
          limitPrice: "0.5",
          // The allocation has GROWN since this order was placed, so the
          // strategy wants a bigger one — and may not have it yet.
          requestedShares: "20",
          filledShares: "0",
          viewFilledShares: "0",
          placedAtMs: NOW_MS - 500,
          escalated: false,
        },
      });
      const decision = staticBracketStrategy.onFeatures(
        context(params(), state, { yesShares: "50" }),
      );
      expect(places(decision), `${orderState}: no placement`).toBe(0);
      expect(cancels(decision), `${orderState}: no second cancel`).toBe(0);
      expect(decision.reasonCodes).toContain(REASONS.awaitingCancel);
      expect(decision.reasonCodes).not.toContain(REASONS.halted);
    }
  });

  it("a stop while an exit is RESTING cancels first and reduces only afterwards", () => {
    const resting = stateWith({
      instanceState: "EXIT_WORKING",
      allocatedShares: "50",
      allocatedCost: "17.5",
      legOutcome: "YES",
      entriesExecuted: 1,
      openedAtMs: NOW_MS - 1000,
      exitOrder: {
        kind: "EXIT",
        intentId: "sb-take-profit-1",
        orderId: "order-2",
        state: "WORKING",
        outcome: "YES",
        side: "SELL",
        limitPrice: "0.5",
        requestedShares: "50",
        filledShares: "0",
        viewFilledShares: "0",
        placedAtMs: NOW_MS - 500,
        escalated: false,
      },
    });
    const views = { yesShares: "50", features: { [STOP_KEY]: "0.1" } };
    const first = staticBracketStrategy.onFeatures(context(params(), resting, views));
    expect(cancels(first)).toBe(1);
    expect(places(first)).toBe(0);
    expect(first.reasonCodes).toContain(REASONS.safetyCancel);
    const afterCancel = nextState(resting, first);

    // The cancel is in flight: still no reduction, and no second cancel.
    const second = staticBracketStrategy.onFeatures(context(params(), afterCancel, views));
    expect(places(second)).toBe(0);
    expect(cancels(second)).toBe(0);
    expect(second.reasonCodes).toContain(REASONS.awaitingCancel);
    const stillPending = nextState(afterCancel, second);

    // Once the venue confirms the cancel, the reduction is emitted.
    const confirmed = staticBracketStrategy.onOrderUpdate(
      context(params(), stillPending, views),
      {
        orderId: "order-2",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "SELL",
        price: "0.5",
        requestedShares: "50",
        filledShares: "0",
        status: "CANCELED",
        placedAt: T_NOW,
      } as never,
    );
    expect(confirmed.reasonCodes).not.toContain(REASONS.halted);
    const third = staticBracketStrategy.onFeatures(
      context(params(), nextState(stillPending, confirmed), views),
    );
    expect(third.decisionType).toBe("reduce");
    expect(places(third)).toBe(1);
    expect(cancels(third)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Repeated order views over TERMINAL tracked orders (r2-H1)
// ---------------------------------------------------------------------------

/**
 * NOTHING PROMISES AT-MOST-ONCE DELIVERY OF AN ORDER VIEW.
 *
 * §8.1 orders a view and its fill not at all, §9.6 promises no de-duplication,
 * and the sub-machine already tolerates a repeated `WORKING` view with its own
 * self-edge. A repeated TERMINAL view had no such tolerance: asking a terminal
 * state for an outgoing edge is illegal by construction, `planOrderUpdate`
 * halted on the refusal, and the instance was left holding the position with
 * the stop, the holding timeout and the close cutoff all dead behind
 * `planTick`'s halt short-circuit. Reproduced at 293a640: all 168 shapes below
 * halted, and the awaiting-fill posture (which deliberately KEEPS a terminal
 * entry track while it waits for the fill stream) made the window unbounded.
 */
const TERMINAL_TRACK_STATES = TERMINAL_ORDER_STATES;
/** Every status an SDK view can carry, plus one the strategy cannot interpret. */
const VIEW_STATUSES: readonly string[] = [
  "OPEN",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "SOMETHING_NEW",
];

function terminalTrack(kind: "ENTRY" | "EXIT", state: OrderState): OrderTrack {
  return {
    kind,
    intentId: kind === "ENTRY" ? "sb-entry-0" : "sb-take-profit-1",
    orderId: "order-1",
    state,
    outcome: "YES",
    side: kind === "ENTRY" ? "BUY" : "SELL",
    limitPrice: kind === "ENTRY" ? "0.35" : "0.5",
    requestedShares: "50",
    filledShares: "0",
    viewFilledShares: "50",
    placedAtMs: NOW_MS,
    escalated: true,
  };
}

describe("a REPEATED view for a terminal tracked order is absorbed, never halted", () => {
  it("no shape of (kind, terminal state, view status, bracket state, evidence) halts", () => {
    const halted: string[] = [];
    const offenders: string[] = [];
    let evaluated = 0;
    for (const kind of ["ENTRY", "EXIT"] as const) {
      for (const trackState of TERMINAL_TRACK_STATES) {
        for (const status of VIEW_STATUSES) {
          for (const instanceState of [
            "ENTRY_PLANNED",
            "ENTRY_WORKING",
            "PARTIALLY_OPEN",
            "OPEN",
            "EXIT_PLANNED",
            "EXIT_WORKING",
          ] as const) {
            for (const viewFilled of ["0", "25", "50"]) {
              evaluated += 1;
              const track = terminalTrack(kind, trackState);
              const state = stateWith({
                instanceState,
                legOutcome: "YES",
                allocatedShares: "50",
                allocatedCost: "17.5",
                entriesExecuted: 1,
                openedAtMs: NOW_MS - 1000,
                ...(kind === "ENTRY" ? { entryOrder: track } : { exitOrder: track }),
              });
              const decision = staticBracketStrategy.onOrderUpdate(
                context(params(), state, { yesShares: "50" }),
                {
                  orderId: "order-1",
                  marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
                  outcome: "YES",
                  side: kind === "ENTRY" ? "BUY" : "SELL",
                  price: kind === "ENTRY" ? "0.35" : "0.5",
                  requestedShares: "50",
                  filledShares: viewFilled,
                  status,
                  placedAt: T_NOW,
                } as never,
              );
              if (decision.reasonCodes.includes(REASONS.halted)) {
                halted.push(`${kind}/${trackState}/${status}/${instanceState}/${viewFilled}`);
              }
              // §6 invariant 13 over the WIDENED surface: absorbing a view may
              // not become a route to a placement, alone or beside a cancel.
              if (cancels(decision) > 0 && places(decision) > 0) {
                offenders.push(`${kind}/${trackState}/${status}/${instanceState}/${viewFilled}`);
              }
            }
          }
        }
      }
    }
    // 2 kinds x 4 terminal states x 7 statuses x 6 bracket states x 3 evidence.
    expect(evaluated).toBe(1008);
    expect(halted).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it("absorbs the repeat rather than transitioning, and keeps the better evidence", () => {
    // The concrete route: a FILLED view, then the SAME view again. The first
    // moves the track to FILLED and puts the instance into the awaiting-fill
    // posture; the second used to halt it.
    const state = stateWith({
      instanceState: "ENTRY_WORKING",
      legOutcome: "YES",
      entryOrder: {
        kind: "ENTRY",
        intentId: "sb-entry-0",
        orderId: "order-1",
        state: "WORKING",
        outcome: "YES",
        side: "BUY",
        limitPrice: "0.35",
        requestedShares: "50",
        filledShares: "0",
        viewFilledShares: "0",
        placedAtMs: NOW_MS,
        escalated: true,
      },
    });
    const view = {
      orderId: "order-1",
      marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
      outcome: "YES",
      side: "BUY",
      price: "0.35",
      requestedShares: "50",
      filledShares: "50",
      status: "FILLED",
      placedAt: T_NOW,
    };
    const first = staticBracketStrategy.onOrderUpdate(context(params(), state, {}), view as never);
    expect(first.reasonCodes).not.toContain(REASONS.halted);
    const afterFirst = nextState(state, first);
    expect((afterFirst.entryOrder as OrderTrack).state).toBe("FILLED");
    expect(first.reasonCodes).toContain(REASONS.awaitingFillAllocation);

    const second = staticBracketStrategy.onOrderUpdate(
      context(params(), afterFirst, {}),
      view as never,
    );
    expect(second.reasonCodes).not.toContain(REASONS.halted);
    expect(second.reasonCodes).toContain(REASONS.terminalOrderViewAbsorbed);
    // Still awaiting the fill, still terminal, still no allocation from a view.
    expect(second.reasonCodes).toContain(REASONS.awaitingFillAllocation);
    const afterSecond = nextState(afterFirst, second);
    expect((afterSecond.entryOrder as OrderTrack).state).toBe("FILLED");
    expect((afterSecond.entryOrder as OrderTrack).filledShares).toBe("0");
    expect(afterSecond.allocatedShares).toBe("0");
    expect(afterSecond.haltReason).toBeNull();

    // A LATER view reporting MORE executed size improves the evidence; one
    // reporting less never rolls it back.
    const more = staticBracketStrategy.onOrderUpdate(
      context(params(), afterSecond, {}),
      { ...view, filledShares: "50" } as never,
    );
    expect((nextState(afterSecond, more).entryOrder as OrderTrack).viewFilledShares).toBe("50");
    const fewer = staticBracketStrategy.onOrderUpdate(
      context(params(), afterSecond, {}),
      { ...view, filledShares: "10" } as never,
    );
    expect((nextState(afterSecond, fewer).entryOrder as OrderTrack).viewFilledShares).toBe("50");
  });

  it("and the exits still work afterwards — the halt's real cost", () => {
    // What the halt actually did: the position stayed on the books and every
    // protection was dead. After the absorption the stop still fires.
    //
    // `BRACKET-1a` (D6) — the fixture, not the claim, moved. This used to use
    // `terminalTrack`'s evidence as it is (`viewFilledShares "50"`, nothing
    // folded): an exit order the venue says SOLD 50 whose fill has not been
    // delivered. Firing a 50-share stop on top of that is exactly the oversell
    // intent D6 closes (scoping probe P4d), so the stop now waits for the fill —
    // asserted as the second half below. The route this test exists for, "no
    // halt, and the stop still fires", is an exit order that ended having
    // executed NOTHING.
    const track: OrderTrack = { ...terminalTrack("EXIT", "CANCELED"), viewFilledShares: "0" };
    const state = stateWith({
      instanceState: "EXIT_WORKING",
      legOutcome: "YES",
      allocatedShares: "50",
      allocatedCost: "17.5",
      entriesExecuted: 1,
      openedAtMs: NOW_MS - 1000,
      exitOrder: track,
    });
    const views = { yesShares: "50", features: { [STOP_KEY]: "0.1" } };
    const repeated = staticBracketStrategy.onOrderUpdate(context(params(), state, views), {
      orderId: "order-1",
      marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
      outcome: "YES",
      side: "SELL",
      price: "0.5",
      requestedShares: "50",
      filledShares: "0",
      status: "CANCELED",
      placedAt: T_NOW,
    } as never);
    expect(repeated.reasonCodes).not.toContain(REASONS.halted);
    const stopped = staticBracketStrategy.onFeatures(
      context(params(), nextState(state, repeated), views),
    );
    expect(stopped.decisionType).toBe("reduce");
    expect(places(stopped)).toBe(1);

    // …and with the venue's evidence of 50 executed and unfolded, the same
    // evaluation is not halted either — it WAITS for the fill (D6), placing
    // nothing, rather than sizing a reduction from an allocation that is short.
    const executed = stateWith({ ...state, exitOrder: terminalTrack("EXIT", "CANCELED") });
    const waiting = staticBracketStrategy.onFeatures(context(params(), executed, views));
    expect(waiting.reasonCodes).not.toContain(REASONS.halted);
    expect(waiting.reasonCodes).toContain(REASONS.awaitingFillAllocation);
    expect(places(waiting)).toBe(0);
    expect(cancels(waiting)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The NON-TERMINAL half of the same surface (r3-B1)
// ---------------------------------------------------------------------------

/**
 * THE COMPLEMENT OF THE SWEEP ABOVE, WHICH ROUND 2 LEFT OPEN AND RECORDED.
 *
 * Round 2 closed the repeated view over a TERMINAL tracked order and wrote down
 * what it did not close: `track CANCEL_PENDING + view status OPEN` and the same
 * with an unrecognised status still HALTED — 2 of the 28
 * `(non-terminal track state × view status)` shapes, REPRODUCED again at
 * e316782 by this round before the fix (the other 26 never halted).
 *
 * Round 3 confirmed the route is ordinary traffic rather than an anomaly:
 * `strategy-sdk`'s `StrategyOrderStatus` has no CANCEL_PENDING member, so `OPEN`
 * is the only status a root can report for an order whose cancel is in flight,
 * and §6 invariant 6 sends every status this package cannot interpret to the
 * same trigger. The answer is the sanctioned machine row
 * `CANCEL_PENDING --OBSERVED_WORKING--> CANCEL_PENDING`, which resolves nothing
 * and licenses nothing (asserted as data above, and as behaviour below).
 */
const NON_TERMINAL_TRACK_STATES: readonly OrderState[] = ORDER_STATES.filter(
  (state) => !(TERMINAL_ORDER_STATES as readonly string[]).includes(state),
);

describe("a view for a NON-TERMINAL tracked order never halts either (r3-B1)", () => {
  it("sweeps every (non-terminal track state × view status) shape with ZERO halts", () => {
    const halted: string[] = [];
    const offenders: string[] = [];
    let evaluated = 0;
    for (const trackState of NON_TERMINAL_TRACK_STATES) {
      for (const status of VIEW_STATUSES) {
        evaluated += 1;
        const track: OrderTrack = {
          ...terminalTrack("EXIT", "CANCELED"),
          state: trackState,
          viewFilledShares: "0",
        };
        const state = stateWith({
          instanceState: "EXIT_WORKING",
          legOutcome: "YES",
          allocatedShares: "50",
          allocatedCost: "17.5",
          entriesExecuted: 1,
          openedAtMs: NOW_MS - 1000,
          exitOrder: track,
        });
        const decision = staticBracketStrategy.onOrderUpdate(
          context(params(), state, { yesShares: "50" }),
          {
            orderId: "order-1",
            marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
            outcome: "YES",
            side: "SELL",
            price: "0.5",
            requestedShares: "50",
            filledShares: "0",
            status,
            placedAt: T_NOW,
          } as never,
        );
        if (decision.reasonCodes.includes(REASONS.halted)) {
          halted.push(`${trackState}/${status}`);
        }
        // §6 invariant 13 over the widened surface: absorbing the cancel race
        // may not become a route to a placement, alone or beside a cancel.
        if (places(decision) > 0 || (cancels(decision) > 0 && places(decision) > 0)) {
          offenders.push(`${trackState}/${status}`);
        }
      }
    }
    // 4 non-terminal track states x 7 view statuses.
    expect(evaluated).toBe(28);
    // Was `["CANCEL_PENDING/OPEN", "CANCEL_PENDING/SOMETHING_NEW"]` at e316782.
    expect(halted).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it("the cancel race stays a cancel race: a working view resolves nothing", () => {
    // The self-edge must not be readable as a confirmation. After an `OPEN`
    // view for an order whose cancel is in flight the track is STILL
    // CANCEL_PENDING, the instance still holds its allocation, and the next
    // evaluation still refuses to place — SB.AWAITING_CANCEL_CONFIRMATION.
    for (const status of ["OPEN", "PARTIALLY_FILLED", "whatever"]) {
      const track: OrderTrack = {
        ...terminalTrack("EXIT", "CANCELED"),
        state: "CANCEL_PENDING",
        viewFilledShares: "0",
      };
      const state = stateWith({
        instanceState: "EXIT_WORKING",
        legOutcome: "YES",
        allocatedShares: "50",
        allocatedCost: "17.5",
        entriesExecuted: 1,
        openedAtMs: NOW_MS - 1000,
        exitOrder: track,
      });
      const views = { yesShares: "50", features: { [STOP_KEY]: "0.1" } };
      const raced = staticBracketStrategy.onOrderUpdate(context(params(), state, views), {
        orderId: "order-1",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "SELL",
        price: "0.5",
        requestedShares: "50",
        filledShares: "0",
        status,
        placedAt: T_NOW,
      } as never);
      expect(raced.reasonCodes, status).not.toContain(REASONS.halted);
      const after = nextState(state, raced);
      expect((after.exitOrder as OrderTrack).state, status).toBe("CANCEL_PENDING");
      expect(after.allocatedShares, status).toBe("50");
      expect(after.instanceState, status).toBe("EXIT_WORKING");

      // §6 invariant 13 on the very next evaluation, with the stop deep in the
      // money: no reduction, and no SECOND cancel for the cancel already sent.
      const next = staticBracketStrategy.onFeatures(context(params(), after, views));
      expect(places(next), status).toBe(0);
      expect(cancels(next), status).toBe(0);
      expect(next.reasonCodes, status).toContain(REASONS.awaitingCancel);
      expect(next.reasonCodes, status).not.toContain(REASONS.halted);
    }
  });

  it("neither planTakeProfit nor planProtectedReduce places over the widened surface", () => {
    // §6 invariant 13 asserted on BOTH exit builders, on both economic legs and
    // in both exit-hosting bracket states, with an unresolved cancel in flight.
    // The take-profit path is reached with the stop quiet; the protected-reduce
    // path with the stop deep in the money.
    for (const leg of ["YES", "NO"] as const) {
      for (const instanceState of ["EXIT_PLANNED", "EXIT_WORKING"] as const) {
        for (const stop of [undefined, { [STOP_KEY]: "0.1" }]) {
          const complement = leg === "NO";
          const track: OrderTrack = {
            kind: "EXIT",
            intentId: "sb-take-profit-1",
            orderId: "order-2",
            state: "CANCEL_PENDING",
            outcome: leg,
            side: complement ? "BUY" : "SELL",
            limitPrice: "0.5",
            // Deliberately STALE: the allocation has moved, so the take-profit
            // path wants to replace this order and must not be allowed to.
            requestedShares: "20",
            filledShares: "0",
            viewFilledShares: "0",
            placedAtMs: NOW_MS - 500,
            escalated: false,
          };
          const state = stateWith({
            instanceState,
            legOutcome: leg,
            allocatedShares: "50",
            allocatedCost: "17.5",
            legBaselineShares: complement ? "100" : "0",
            entriesExecuted: 1,
            openedAtMs: NOW_MS - 1000,
            exitOrder: track,
          });
          const label = `${leg}/${instanceState}/${stop === undefined ? "quiet" : "stop"}`;
          const decision = staticBracketStrategy.onFeatures(
            context(params(PREFERRING), state, {
              ...(complement ? { noShares: "50" } : { yesShares: "50" }),
              ...(stop === undefined ? {} : { features: stop }),
            }),
          );
          expect(places(decision), label).toBe(0);
          expect(cancels(decision), label).toBe(0);
          expect(decision.reasonCodes, label).toContain(REASONS.awaitingCancel);
          expect(decision.reasonCodes, label).not.toContain(REASONS.halted);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The two live routes review round 1 reproduced, as named regressions
// ---------------------------------------------------------------------------

describe("the two halting routes review round 1 reproduced", () => {
  it("ENTRY_PLANNED + a REJECTED order view returns to ARMED, not HALTED", () => {
    const state = stateWith({
      instanceState: "ENTRY_PLANNED",
      entryOrder: {
        kind: "ENTRY",
        intentId: "sb-entry-0",
        orderId: null,
        state: "PENDING",
        outcome: "YES",
        side: "BUY",
        limitPrice: "0.35",
        requestedShares: "50",
        filledShares: "0",
        viewFilledShares: "0",
        placedAtMs: NOW_MS,
        escalated: true,
      },
    });
    const decision = staticBracketStrategy.onFeatures(
      context(params(), state, {
        orders: [
          {
            orderId: "order-1",
            marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
            outcome: "YES",
            side: "BUY",
            price: "0.35",
            requestedShares: "50",
            filledShares: "0",
            status: "REJECTED",
            placedAt: T_NOW,
          } as never,
        ],
      }),
    );
    expect(decision.reasonCodes).not.toContain(REASONS.halted);
    expect(decision.reasonCodes).toContain(REASONS.entryOrderTerminal);
    const patch = decision.statePatch as Record<string, unknown>;
    expect(patch["instanceState"]).toBe("ARMED");
    expect(patch["entryOrder"]).toBeNull();
    expect(patch["haltReason"]).toBeNull();
  });

  it("EXIT_PLANNED + a CANCELED order view still lets the stop fire, in the same evaluation", () => {
    const state = stateWith({
      instanceState: "EXIT_PLANNED",
      allocatedShares: "50",
      allocatedCost: "17.5",
      legOutcome: "YES",
      entriesExecuted: 1,
      openedAtMs: NOW_MS - 1000,
      exitOrder: {
        kind: "EXIT",
        intentId: "sb-take-profit-1",
        orderId: null,
        state: "PENDING",
        outcome: "YES",
        side: "SELL",
        limitPrice: "0.5",
        requestedShares: "50",
        filledShares: "0",
        viewFilledShares: "0",
        placedAtMs: NOW_MS,
        escalated: false,
      },
    });
    const decision = staticBracketStrategy.onFeatures(
      context(params(), state, {
        yesShares: "50",
        features: { [STOP_KEY]: "0.1" },
        orders: [
          {
            orderId: "order-9",
            marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
            outcome: "YES",
            side: "SELL",
            price: "0.5",
            requestedShares: "50",
            filledShares: "0",
            status: "CANCELED",
            placedAt: T_NOW,
          } as never,
        ],
      }),
    );
    expect(decision.reasonCodes).not.toContain(REASONS.halted);
    expect(decision.decisionType).toBe("reduce");
    expect(decision.reasonCodes).toContain(REASONS.stopTriggered);
    expect(places(decision)).toBe(1);
  });
});
