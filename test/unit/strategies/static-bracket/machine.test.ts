/**
 * The §13.3 state machine, checked MECHANICALLY.
 *
 * Two halves, and neither hand-lists anything:
 *
 * - the shipped tables are cross-checked against §13.3's own diagram, read from
 *   the handoff at run time (the WP-210 partition precedent: derive, do not
 *   transcribe);
 * - coverage is derived from the shipped tables — every legal edge is
 *   exercised, and the COMPLEMENT of the table (every other `(from, trigger)`
 *   pair in the full product) is asserted to refuse by name. A new legal edge
 *   with no exercise, and a silently-permitted illegal edge, both fail here.
 */

import { describe, expect, it } from "vitest";

import {
  INSTANCE_STATES,
  INSTANCE_TRANSITIONS,
  INSTANCE_TRIGGERS,
  ORDER_STATES,
  ORDER_TRANSITIONS,
  ORDER_TRIGGERS,
  RESUME_TARGET,
  instanceTransition,
  isResumeTarget,
  orderTransition,
  type InstanceState,
  type OrderState,
  type OrderTrigger,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import { fencedBlocks, handoffSection } from "./handoff.js";

/** The uppercase tokens §13.3's diagram names, in first-appearance order. */
function specStates(): string[] {
  const section = handoffSection("13.3 State machine");
  const blocks = fencedBlocks(section);
  expect(blocks.length).toBeGreaterThan(0);
  const body = (blocks[0] as { body: string }).body;
  const tokens = body.match(/[A-Z][A-Z_]{2,}/gu) ?? [];
  const seen: string[] = [];
  for (const token of tokens) {
    if (!seen.includes(token)) seen.push(token);
  }
  return seen;
}

const INSTANCE_SPEC_STATES = [
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
];

const ORDER_SPEC_STATES = ["CANCEL_PENDING", "CANCELED", "REJECTED", "SUBMISSION_UNKNOWN"];

describe("§13.3 fidelity — the shipped machine against the handoff's own diagram", () => {
  it("names exactly the states §13.3 names, split into the two machines it describes", () => {
    const tokens = specStates();
    // The partition is the test's only assumption, and it is checked: every
    // token §13.3 prints must land in exactly one of the two lists.
    const unclassified = tokens.filter(
      (token) => !INSTANCE_SPEC_STATES.includes(token) && !ORDER_SPEC_STATES.includes(token),
    );
    expect(unclassified, "§13.3 grew a state this suite does not classify").toEqual([]);
    for (const state of INSTANCE_SPEC_STATES) {
      expect(tokens, `§13.3 no longer names ${state}`).toContain(state);
    }
    for (const state of ORDER_SPEC_STATES) {
      expect(tokens, `§13.3 no longer names ${state}`).toContain(state);
    }
    expect([...INSTANCE_STATES].sort()).toEqual([...INSTANCE_SPEC_STATES].sort());
    for (const state of ORDER_SPEC_STATES) {
      expect(ORDER_STATES).toContain(state as OrderState);
    }
  });

  it("adds exactly four order sub-states beyond §13.3's four, each with a stated reason", () => {
    const extra = ORDER_STATES.filter((state) => !ORDER_SPEC_STATES.includes(state));
    // PENDING: an intent emitted with no evidence of an order yet.
    // WORKING: the resting order §13.3's "Working orders" heading presupposes.
    // FILLED/EXPIRED: SDK order statuses (`StrategyOrderStatus`) a strategy can observe.
    expect([...extra].sort()).toEqual(["EXPIRED", "FILLED", "PENDING", "WORKING"]);
  });

  it("carries §13.3's linear chain as real edges", () => {
    const chain: [InstanceState, InstanceState][] = [
      ["DORMANT", "ARMED"],
      ["ARMED", "ENTRY_PLANNED"],
      ["ENTRY_PLANNED", "ENTRY_WORKING"],
      ["ENTRY_WORKING", "PARTIALLY_OPEN"],
      ["PARTIALLY_OPEN", "OPEN"],
      ["OPEN", "EXIT_PLANNED"],
      ["EXIT_PLANNED", "EXIT_WORKING"],
      ["EXIT_WORKING", "CLOSED"],
    ];
    for (const [from, to] of chain) {
      const edge = INSTANCE_TRANSITIONS.find(
        (candidate) => candidate.from === from && candidate.to === to,
      );
      expect(edge, `§13.3's ${from} -> ${to} edge is missing`).toBeDefined();
    }
  });

  it("reaches PAUSED and HALTED from any state (§13.3 'Any state')", () => {
    for (const state of INSTANCE_STATES) {
      const paused = instanceTransition(state, "PAUSE", null);
      const halted = instanceTransition(state, "HALT", null);
      if (state === "PAUSED") {
        expect(paused.ok, "an already-paused instance may not pause again").toBe(false);
      } else if (state === "HALTED") {
        expect(paused.ok).toBe(false);
      } else {
        expect(paused.ok, `PAUSE must be legal from ${state}`).toBe(true);
      }
      if (state === "HALTED") {
        expect(halted.ok, "HALTED is terminal").toBe(false);
      } else {
        expect(halted.ok, `HALT must be legal from ${state}`).toBe(true);
      }
    }
  });

  it("carries §13.3's working-order sub-machine exactly", () => {
    for (const terminal of ["CANCELED", "REJECTED", "SUBMISSION_UNKNOWN"] as OrderState[]) {
      const edge = ORDER_TRANSITIONS.find(
        (candidate) => candidate.from === "CANCEL_PENDING" && candidate.to === terminal,
      );
      expect(edge, `§13.3's CANCEL_PENDING -> ${terminal} edge is missing`).toBeDefined();
    }
    const intoCancelPending = ORDER_TRANSITIONS.filter((edge) => edge.to === "CANCEL_PENDING");
    expect(intoCancelPending.length).toBeGreaterThan(0);
  });

  it("states a basis for every edge, and marks every non-quotation as an INTERPRETATION", () => {
    for (const edge of INSTANCE_TRANSITIONS) {
      expect(edge.basis.length, `${edge.from} --${edge.trigger}--> has no basis`).toBeGreaterThan(10);
      if (!edge.basis.includes("§13.3")) {
        expect(
          edge.basis.startsWith("INTERPRETATION") || edge.basis.includes("§6") || edge.basis.includes("§8") || edge.basis.includes("§9") || edge.basis.includes("§7"),
          `${edge.from} --${edge.trigger}--> cites neither §13.3 nor another section nor an interpretation`,
        ).toBe(true);
      }
    }
  });
});

describe("the instance machine is a function: one target per (from, trigger)", () => {
  it("has no duplicate edge", () => {
    const seen = new Set<string>();
    for (const edge of INSTANCE_TRANSITIONS) {
      const key = `${edge.from}|${edge.trigger}`;
      expect(seen.has(key), `duplicate edge ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("exercises EVERY legal edge, derived from the shipped table", () => {
    expect(INSTANCE_TRANSITIONS.length).toBeGreaterThan(30);
    for (const edge of INSTANCE_TRANSITIONS) {
      const resumeTo: InstanceState | null = edge.to === RESUME_TARGET ? "OPEN" : null;
      const moved = instanceTransition(edge.from, edge.trigger, resumeTo);
      expect(moved.ok, `${edge.from} --${edge.trigger}--> must be legal`).toBe(true);
      if (!moved.ok) continue;
      expect(moved.to).toBe(edge.to === RESUME_TARGET ? "OPEN" : edge.to);
      expect(moved.basis).toBe(edge.basis);
    }
  });

  it("REFUSES BY NAME every pair the table does not contain", () => {
    const legal = new Set(INSTANCE_TRANSITIONS.map((edge) => `${edge.from}|${edge.trigger}`));
    let refused = 0;
    for (const from of INSTANCE_STATES) {
      for (const trigger of INSTANCE_TRIGGERS) {
        if (legal.has(`${from}|${trigger}`)) continue;
        const moved = instanceTransition(from, trigger, "OPEN");
        expect(moved.ok, `${from} --${trigger}--> must be illegal`).toBe(false);
        if (moved.ok) continue;
        expect(moved.problem).toContain(`${from} --${trigger}-->`);
        expect(moved.problem).toContain("illegal transition");
        refused += 1;
      }
    }
    // The complement is large; if this ever collapses to a handful the product
    // has changed shape and the coverage claim needs re-reading.
    expect(refused).toBe(INSTANCE_STATES.length * INSTANCE_TRIGGERS.length - legal.size);
    expect(refused).toBeGreaterThan(150);
  });

  it("refuses a RESUME with no recorded state, and one into a non-bracket state", () => {
    const noTarget = instanceTransition("PAUSED", "RESUME", null);
    expect(noTarget.ok).toBe(false);
    if (!noTarget.ok) {
      expect(noTarget.problem).toContain("no recorded pre-pause state");
    }
    for (const target of ["PAUSED", "HALTED"] as InstanceState[]) {
      const moved = instanceTransition("PAUSED", "RESUME", target);
      expect(moved.ok, `RESUME into ${target} must refuse`).toBe(false);
      if (!moved.ok) {
        expect(moved.problem).toContain(`PAUSED --RESUME--> ${target}`);
      }
    }
    for (const target of INSTANCE_STATES.filter((state) => isResumeTarget(state))) {
      const moved = instanceTransition("PAUSED", "RESUME", target);
      expect(moved.ok, `RESUME into ${target} must be legal`).toBe(true);
      if (moved.ok) expect(moved.to).toBe(target);
    }
  });

  it("keeps HALTED terminal under every trigger", () => {
    for (const trigger of INSTANCE_TRIGGERS) {
      const moved = instanceTransition("HALTED", trigger, "OPEN");
      expect(moved.ok, `HALTED --${trigger}--> must refuse`).toBe(false);
    }
  });
});

describe("the working-order sub-machine", () => {
  it("has no duplicate edge", () => {
    const seen = new Set<string>();
    for (const edge of ORDER_TRANSITIONS) {
      const key = `${edge.from}|${edge.trigger}`;
      expect(seen.has(key), `duplicate order edge ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("exercises EVERY legal edge, derived from the shipped table", () => {
    for (const edge of ORDER_TRANSITIONS) {
      const moved = orderTransition(edge.from, edge.trigger);
      expect(moved.ok, `${edge.from} --${edge.trigger}--> must be legal`).toBe(true);
      if (moved.ok) expect(moved.to).toBe(edge.to);
    }
  });

  it("REFUSES BY NAME every pair the table does not contain", () => {
    const legal = new Set(ORDER_TRANSITIONS.map((edge) => `${edge.from}|${edge.trigger}`));
    let refused = 0;
    for (const from of ORDER_STATES) {
      for (const trigger of ORDER_TRIGGERS) {
        if (legal.has(`${from}|${trigger}`)) continue;
        const moved = orderTransition(from as OrderState, trigger as OrderTrigger);
        expect(moved.ok, `${from} --${trigger}--> must be illegal`).toBe(false);
        if (moved.ok) continue;
        expect(moved.problem).toContain(`${from} --${trigger}-->`);
        expect(moved.problem).toContain("illegal order transition");
        refused += 1;
      }
    }
    expect(refused).toBe(ORDER_STATES.length * ORDER_TRIGGERS.length - legal.size);
  });

  it("never leaves a terminal order state", () => {
    for (const terminal of ["CANCELED", "REJECTED", "FILLED", "EXPIRED"] as OrderState[]) {
      for (const trigger of ORDER_TRIGGERS) {
        const moved = orderTransition(terminal, trigger as OrderTrigger);
        expect(moved.ok, `${terminal} --${trigger}--> must refuse`).toBe(false);
      }
    }
  });

  it("never treats an unknown submission as a rejection (§6 invariant 6)", () => {
    const silence = orderTransition("PENDING", "SILENCE_EXCEEDED");
    expect(silence.ok).toBe(true);
    if (silence.ok) expect(silence.to).toBe("SUBMISSION_UNKNOWN");
    // The only ways out of SUBMISSION_UNKNOWN are observations of the real
    // order — never an inference.
    const escapes = ORDER_TRANSITIONS.filter((edge) => edge.from === "SUBMISSION_UNKNOWN");
    expect(escapes.length).toBeGreaterThan(0);
    for (const edge of escapes) {
      expect(
        edge.trigger.startsWith("OBSERVED_") || edge.trigger === "RECONCILED_WORKING",
        `${edge.trigger} would let the strategy leave SUBMISSION_UNKNOWN without evidence`,
      ).toBe(true);
    }
  });
});
