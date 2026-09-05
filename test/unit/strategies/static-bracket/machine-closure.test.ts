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
 * This file closes the loop from the other side, three ways:
 *
 * 1. **A bounded state sweep** through the SHIPPED callback: every reachable
 *    combination of bracket state, entry-order state, exit-order state,
 *    allocation and economic leg must produce a decision, never a halt.
 * 2. **A call-site inventory**, checked against the source: every `move()` in
 *    `decide.ts` carries a `// MOVE-SITE:` marker, the inventory below names the
 *    triggers and the `from` states each site can reach, and every pair a site
 *    can reach must exist in the table (or be an explicitly declared,
 *    reasoned refusal).
 * 3. **§6 invariant 13**, re-verified over the same sweep now that the exit
 *    states have self-edges: no decision may both cancel and place, and no
 *    replacement may be planned while a cancel is unconfirmed.
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
  staticBracketParamsSchema,
  staticBracketStrategy,
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

interface Shape {
  readonly instanceState: InstanceState;
  readonly entryState: OrderState | null;
  readonly exitState: OrderState | null;
  readonly allocated: string;
  readonly leg: "YES" | "NO";
}

function track(
  kind: "ENTRY" | "EXIT",
  state: OrderState,
  shape: Shape,
): OrderTrack {
  const complement = shape.leg === "YES" ? false : true;
  const entrySide = complement ? "SELL" : "BUY";
  return {
    kind,
    intentId: kind === "ENTRY" ? "sb-entry-0" : "sb-take-profit-1",
    orderId: kind === "ENTRY" ? "order-1" : "order-2",
    state,
    outcome: shape.leg,
    side: kind === "ENTRY" ? entrySide : entrySide === "BUY" ? "SELL" : "BUY",
    limitPrice: kind === "ENTRY" ? (complement ? "0.65" : "0.35") : complement ? "0.5" : "0.5",
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
            yield { instanceState, entryState, exitState, allocated, leg };
          }
        }
      }
    }
  }
}

function label(shape: Shape): string {
  return `${shape.instanceState}/${String(shape.entryState)}/${String(shape.exitState)}/${
    shape.allocated
  }/${shape.leg}`;
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
    // x 2 allocations x 2 legs.
    expect(evaluated).toBe(3240);
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
    why: "as above, through the stop, the holding timeout and the final policy",
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

function markersInSource(): string[] {
  const source = readFileSync(DECIDE_SOURCE, "utf8");
  const found = [...source.matchAll(/\/\/ MOVE-SITE: (\w+)/gu)].map((match) => match[1] as string);
  return found;
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

  it("declares 8 order states, 9 order triggers and 27 order edges", () => {
    expect(ORDER_STATES).toHaveLength(8);
    expect(ORDER_TRIGGERS).toHaveLength(9);
    expect(ORDER_TRANSITIONS).toHaveLength(27);
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

  it("has no duplicate (from, trigger) row, so the table is a function", () => {
    const seen = new Set<string>();
    for (const edge of INSTANCE_TRANSITIONS) {
      const key = `${edge.from}/${edge.trigger}`;
      expect(seen.has(key), `duplicate row ${key}`).toBe(false);
      seen.add(key);
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
    const source = readFileSync(DECIDE_SOURCE, "utf8");
    expect(source.length).toBeGreaterThan(1000);
    // Count `move(` calls that are not `moveOrder(` and not the definition.
    const calls = [...source.matchAll(/(?<![\w.])move\(/gu)].length;
    const definition = 1;
    expect(markersInSource()).toHaveLength(calls - definition);
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
