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

let sequence = 0;
function record(action: ControlAuditAction, outcome: ControlAuditOutcome): ControlAuditRecord {
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
    priorState: { engaged: "false" },
    resultingState: { engaged: "true" },
    at: "2026-10-01T00:00:00.000Z",
  };
}

const engage = (): ControlAuditRecord => record("KILL_SWITCH_ENGAGE", "APPLIED");
const pause = (): ControlAuditRecord => record("STRATEGY_PAUSE", "APPLIED");
const ordinary = (): ControlAuditRecord => record("MODE_RAISE_ATTEMPT", "REFUSED");

describe("the tier is read from the record's action and outcome", () => {
  it("classifies EVERY action × outcome pair, and only two pairs are protected", () => {
    const table: Record<string, string> = {};
    for (const action of CONTROL_AUDIT_ACTIONS) {
      for (const outcome of CONTROL_AUDIT_OUTCOMES) {
        table[`${action}|${outcome}`] = auditBudgetTier({ action, outcome });
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
