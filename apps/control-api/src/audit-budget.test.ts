/**
 * The audit budget (`CONTROL-1`, closing `WP-240` r1 M-3): three tiers over one
 * capacity, admitted from the RECORD, never from a request.
 *
 * Each block pins one guard the module header states; the `CONTROL-1` handoff's
 * mutation table removes each guard and names the test here that fails.
 */

import { describe, expect, it } from "vitest";

import {
  CONTROL_AUDIT_ACTIONS,
  CONTROL_AUDIT_OUTCOMES,
  InMemoryControlAuditLog,
  type AuditAppendResult,
  type AuditStateDocument,
  type ControlAuditAction,
  type ControlAuditOutcome,
  type ControlAuditRecord,
  type ControlAuditSink,
} from "@polymarket-bot/observability";

import {
  SafetyReservedAuditSink,
  auditBudgetProblem,
  auditBudgetTier,
  createBudgetedAuditLog,
} from "./audit-budget.js";

/** The documents the control plane writes for the state change each action makes when it STRENGTHENS. */
const SWITCH_ABSENT: AuditStateDocument = { engaged: "false", scope: "GLOBAL", scopeRef: null };
const switchAt = (action: string): AuditStateDocument => ({
  engaged: "true",
  scope: "GLOBAL",
  scopeRef: null,
  action,
  reason: "a stated reason",
  since: "2026-10-01T00:00:00.000Z",
  actor: "operator-a",
});
const instanceIn = (state: string): AuditStateDocument => ({
  instanceId: "sb-1",
  state,
  reason: "a stated reason",
  since: "2026-10-01T00:00:00.000Z",
  actor: "operator-a",
});

let sequence = 0;
function record(
  action: ControlAuditAction,
  outcome: ControlAuditOutcome,
  priorState: AuditStateDocument = SWITCH_ABSENT,
  resultingState: AuditStateDocument = switchAt("FULL_HALT"),
): ControlAuditRecord {
  sequence += 1;
  return {
    recordId: `01930000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    action,
    outcome,
    actor: "operator-a",
    actorKind: "HUMAN",
    scope: "GLOBAL",
    scopeRef: null,
    reason: "a stated reason",
    priorState,
    resultingState,
    at: "2026-10-01T00:00:00.000Z",
  };
}

const engage = (): ControlAuditRecord => record("KILL_SWITCH_ENGAGE", "APPLIED");
const pause = (): ControlAuditRecord =>
  record("STRATEGY_PAUSE", "APPLIED", instanceIn("RUNNING"), instanceIn("PAUSED"));
const ordinary = (): ControlAuditRecord => record("MODE_RAISE_ATTEMPT", "REFUSED");

describe("the tier is read from the record's action and outcome", () => {
  it("classifies EVERY action × outcome pair, and only two pairs are protected", () => {
    // Each pair carries the documents of the strengthening change its action
    // makes — a new switch, a RUNNING → PAUSED instance — so the table isolates
    // the action and the outcome.
    const strengthening = (action: ControlAuditAction): readonly [AuditStateDocument, AuditStateDocument] =>
      action === "STRATEGY_PAUSE"
        ? [instanceIn("RUNNING"), instanceIn("PAUSED")]
        : action === "STRATEGY_RESUME"
          ? [instanceIn("PAUSED"), instanceIn("RUNNING")]
          : [SWITCH_ABSENT, switchAt("FULL_HALT")];
    const table: Record<string, string> = {};
    for (const action of CONTROL_AUDIT_ACTIONS) {
      for (const outcome of CONTROL_AUDIT_OUTCOMES) {
        const [priorState, resultingState] = strengthening(action);
        table[`${action}|${outcome}`] = auditBudgetTier({ action, outcome, priorState, resultingState });
      }
    }
    expect(table).toEqual({
      "STRATEGY_PAUSE|APPLIED": "SAFETY_DIRECTION",
      "STRATEGY_PAUSE|REFUSED": "ORDINARY",
      "STRATEGY_RESUME|APPLIED": "ORDINARY",
      "STRATEGY_RESUME|REFUSED": "ORDINARY",
      "KILL_SWITCH_ENGAGE|APPLIED": "KILL_SWITCH_ENGAGE",
      "KILL_SWITCH_ENGAGE|REFUSED": "ORDINARY",
      "KILL_SWITCH_RELEASE|APPLIED": "ORDINARY",
      "KILL_SWITCH_RELEASE|REFUSED": "ORDINARY",
      "MODE_RAISE_ATTEMPT|APPLIED": "ORDINARY",
      "MODE_RAISE_ATTEMPT|REFUSED": "ORDINARY",
    });
  });
});

describe("CONTROL-1 r1 (CONTROL1-J-M1): a protected tier is EARNED by the change the record shows", () => {
  const engageTier = (prior: AuditStateDocument, resulting: AuditStateDocument): string =>
    auditBudgetTier({ action: "KILL_SWITCH_ENGAGE", outcome: "APPLIED", priorState: prior, resultingState: resulting });

  it("a switch engaged where none was is a KILL_SWITCH_ENGAGE record, at every action", () => {
    for (const action of ["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY", "FULL_HALT"]) {
      expect(engageTier(SWITCH_ABSENT, switchAt(action)), action).toBe("KILL_SWITCH_ENGAGE");
    }
  });

  it("an escalation to FULL_HALT is a KILL_SWITCH_ENGAGE record", () => {
    for (const from of ["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY"]) {
      expect(engageTier(switchAt(from), switchAt("FULL_HALT")), from).toBe("KILL_SWITCH_ENGAGE");
    }
  });

  it("a REPEAT is ORDINARY, at every action — a no-op cannot spend the reserve", () => {
    for (const action of ["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY", "FULL_HALT"]) {
      expect(engageTier(switchAt(action), switchAt(action)), action).toBe("ORDINARY");
    }
  });

  it("a change AWAY from FULL_HALT is ORDINARY — a weakening cannot spend the reserve", () => {
    for (const to of ["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY"]) {
      expect(engageTier(switchAt("FULL_HALT"), switchAt(to)), to).toBe("ORDINARY");
    }
  });

  it("a change between two actions §14.1 does not order is ORDINARY", () => {
    const unordered = ["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY"];
    for (const from of unordered) {
      for (const to of unordered) {
        if (from !== to) expect(engageTier(switchAt(from), switchAt(to)), `${from} → ${to}`).toBe("ORDINARY");
      }
    }
  });

  it("an unreadable document earns nothing", () => {
    expect(engageTier(null, switchAt("FULL_HALT"))).toBe("ORDINARY");
    expect(engageTier("engaged", switchAt("FULL_HALT"))).toBe("ORDINARY");
    expect(engageTier(SWITCH_ABSENT, SWITCH_ABSENT)).toBe("ORDINARY");
    expect(engageTier({ engaged: "true" }, switchAt("FULL_HALT"))).toBe("ORDINARY");
    expect(engageTier([SWITCH_ABSENT], switchAt("FULL_HALT"))).toBe("ORDINARY");
    // A prior that names an action but does not say the switch was engaged is
    // not an escalation either.
    expect(engageTier({ engaged: "maybe", action: "HALT_NEW_ENTRIES" }, switchAt("FULL_HALT"))).toBe("ORDINARY");
    expect(engageTier({ action: "HALT_NEW_ENTRIES" }, switchAt("FULL_HALT"))).toBe("ORDINARY");
  });

  it("only a RUNNING → PAUSED pause is a SAFETY_DIRECTION record", () => {
    const pauseTier = (prior: AuditStateDocument, resulting: AuditStateDocument): string =>
      auditBudgetTier({ action: "STRATEGY_PAUSE", outcome: "APPLIED", priorState: prior, resultingState: resulting });
    expect(pauseTier(instanceIn("RUNNING"), instanceIn("PAUSED"))).toBe("SAFETY_DIRECTION");
    expect(pauseTier(instanceIn("PAUSED"), instanceIn("PAUSED"))).toBe("ORDINARY");
    expect(pauseTier({ known: "false", instanceId: "sb-1" }, instanceIn("PAUSED"))).toBe("ORDINARY");
    expect(pauseTier(instanceIn("RUNNING"), instanceIn("RUNNING"))).toBe("ORDINARY");
  });

  it("through the sink: once the ordinary tier is full, a repeat or a weakening engage is REFUSED while an escalation and a new switch still fit", async () => {
    const { log, sink } = createBudgetedAuditLog({ capacity: 6, safetyReserve: 2 });
    for (let index = 0; index < 2; index += 1) expect((await sink.append(ordinary())).ok).toBe(true);
    // The ordinary tier (C − 2R = 2) is full.
    const repeat = record("KILL_SWITCH_ENGAGE", "APPLIED", switchAt("HALT_NEW_ENTRIES"), switchAt("HALT_NEW_ENTRIES"));
    const weakening = record("KILL_SWITCH_ENGAGE", "APPLIED", switchAt("FULL_HALT"), switchAt("CANCEL_ALL"));
    const unordered = record("KILL_SWITCH_ENGAGE", "APPLIED", switchAt("CANCEL_ALL"), switchAt("HALT_NEW_ENTRIES"));
    for (const refused of [repeat, weakening, unordered]) {
      expect(await sink.append(refused)).toMatchObject({ ok: false, code: "AUDIT_CAPACITY_EXHAUSTED" });
    }
    const escalation = record("KILL_SWITCH_ENGAGE", "APPLIED", switchAt("HALT_NEW_ENTRIES"), switchAt("FULL_HALT"));
    expect((await sink.append(escalation)).ok).toBe(true);
    expect((await sink.append(engage())).ok).toBe(true);
    expect(log.size).toBe(4);
  });
});

describe("the limits", () => {
  it("are C, C − R and C − 2R", () => {
    const { sink } = createBudgetedAuditLog({ capacity: 10, safetyReserve: 3 });
    expect(sink.limitFor("KILL_SWITCH_ENGAGE")).toBe(10);
    expect(sink.limitFor("SAFETY_DIRECTION")).toBe(7);
    expect(sink.limitFor("ORDINARY")).toBe(4);
  });

  it("ORDINARY records stop at C − 2R; the rest of the log is untouched", async () => {
    const { log, sink } = createBudgetedAuditLog({ capacity: 10, safetyReserve: 3 });
    const results: AuditAppendResult[] = [];
    for (let index = 0; index < 8; index += 1) results.push(await sink.append(ordinary()));
    expect(results.filter((result) => result.ok)).toHaveLength(4);
    expect(results.slice(4).every((result) => !result.ok && result.code === "AUDIT_CAPACITY_EXHAUSTED")).toBe(true);
    expect(log.size).toBe(4);
    expect(sink.admitted).toBe(4);
  });

  it("a SAFETY_DIRECTION record may use the next R, and no more", async () => {
    const { log, sink } = createBudgetedAuditLog({ capacity: 10, safetyReserve: 3 });
    for (let index = 0; index < 4; index += 1) await sink.append(ordinary());
    const pauses: AuditAppendResult[] = [];
    for (let index = 0; index < 5; index += 1) pauses.push(await sink.append(pause()));
    expect(pauses.map((result) => result.ok)).toEqual([true, true, true, false, false]);
    expect(log.size).toBe(7);
  });

  it("only a KILL_SWITCH_ENGAGE record may use the last R", async () => {
    const { log, sink } = createBudgetedAuditLog({ capacity: 10, safetyReserve: 3 });
    for (let index = 0; index < 4; index += 1) await sink.append(ordinary());
    for (let index = 0; index < 3; index += 1) await sink.append(pause());
    // The safety tier is full: neither an ordinary record nor a pause gets in…
    expect((await sink.append(ordinary())).ok).toBe(false);
    expect((await sink.append(pause())).ok).toBe(false);
    // …and three engages do.
    const engages: AuditAppendResult[] = [];
    for (let index = 0; index < 4; index += 1) engages.push(await sink.append(engage()));
    expect(engages.map((result) => result.ok)).toEqual([true, true, true, false]);
    expect(log.size).toBe(10);
  });

  it("protected records consume the ORDINARY tier first, like any other record", async () => {
    const { sink } = createBudgetedAuditLog({ capacity: 10, safetyReserve: 3 });
    for (let index = 0; index < 4; index += 1) expect((await sink.append(engage())).ok).toBe(true);
    // Four engages used the ordinary room; an ordinary record now finds none.
    expect((await sink.append(ordinary())).ok).toBe(false);
  });

  it("reserve 0 is WP-240's single bound: every tier stops at C", async () => {
    const { sink } = createBudgetedAuditLog({ capacity: 2, safetyReserve: 0 });
    expect((await sink.append(ordinary())).ok).toBe(true);
    expect((await sink.append(ordinary())).ok).toBe(true);
    expect((await sink.append(engage())).ok).toBe(false);
  });

  it("the refusal names the tier, the count and the reserve", async () => {
    const { sink } = createBudgetedAuditLog({ capacity: 3, safetyReserve: 1 });
    await sink.append(ordinary());
    const refused = await sink.append(ordinary());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.detail).toContain("ORDINARY tier is full (1 of 3 records; this tier may fill it to 1)");
    expect(refused.detail).toContain("reserved for kill-switch engages");
  });
});

describe("what is counted", () => {
  it("counts only appends the INNER sink accepted: an inner refusal frees the slot", async () => {
    // The inner log refuses a reused record id; the budget must not count it.
    // Capacity 5, reserve 1: the ordinary tier holds 3.
    const { log, sink } = createBudgetedAuditLog({ capacity: 5, safetyReserve: 1 });
    const first = ordinary();
    expect((await sink.append(first)).ok).toBe(true);
    const reused = await sink.append(first);
    expect(reused).toMatchObject({ ok: false, code: "AUDIT_RECORD_ID_REUSED" });
    expect(sink.admitted).toBe(1);
    expect(log.size).toBe(1);
    // The refused reuse took no slot: exactly two more ordinary records fit.
    expect((await sink.append(ordinary())).ok).toBe(true);
    expect((await sink.append(ordinary())).ok).toBe(true);
    expect((await sink.append(ordinary())).ok).toBe(false);
    expect(log.size).toBe(3);
  });

  it("an inner sink that THROWS is reported unavailable and its slot released", async () => {
    let throwing = true;
    const inner: ControlAuditSink = {
      append: () => {
        if (throwing) throw new Error("sink exploded");
        return Promise.resolve({ ok: true });
      },
    };
    const sink = new SafetyReservedAuditSink(inner, { capacity: 3, safetyReserve: 1 });
    expect(await sink.append(ordinary())).toMatchObject({
      ok: false,
      code: "AUDIT_SINK_UNAVAILABLE",
    });
    throwing = false;
    expect((await sink.append(ordinary())).ok).toBe(true);
    expect(sink.admitted).toBe(1);
  });

  it("CONCURRENT appends cannot overshoot a tier: an in-flight append holds its slot", async () => {
    // An inner sink that resolves only when released, so many appends are in
    // flight at once — the shape a durable sink has.
    const releases: (() => void)[] = [];
    const inner: ControlAuditSink = {
      append: () =>
        new Promise<AuditAppendResult>((resolve) => {
          releases.push(() => resolve({ ok: true }));
        }),
    };
    const sink = new SafetyReservedAuditSink(inner, { capacity: 5, safetyReserve: 2 });
    const pending = Array.from({ length: 6 }, () => sink.append(ordinary()));
    // Only ONE may reach the inner sink: C − 2R = 1.
    await Promise.resolve();
    expect(releases).toHaveLength(1);
    for (const release of releases) release();
    const results = await Promise.all(pending);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(sink.admitted).toBe(1);
  });
});

describe("an unusable budget is refused at construction", () => {
  it.each([
    [{ capacity: 0, safetyReserve: 0 }, "positive safe integer"],
    [{ capacity: 1.5, safetyReserve: 0 }, "positive safe integer"],
    [{ capacity: 4, safetyReserve: -1 }, "non-negative safe integer"],
    [{ capacity: 4, safetyReserve: 2 }, "twice the reserve must be below the capacity"],
    [{ capacity: 1, safetyReserve: 1 }, "twice the reserve must be below the capacity"],
  ])("%j", (options, message) => {
    expect(auditBudgetProblem(options)).toContain(message);
    expect(() => new SafetyReservedAuditSink(new InMemoryControlAuditLog(8), options)).toThrow(RangeError);
    expect(() => createBudgetedAuditLog(options)).toThrow(RangeError);
  });

  it("the composition's log and budget share ONE capacity", () => {
    const { log, sink } = createBudgetedAuditLog({ capacity: 12, safetyReserve: 2 });
    expect(log.capacity).toBe(12);
    expect(sink.capacity).toBe(12);
    expect(sink.safetyReserve).toBe(2);
  });
});
