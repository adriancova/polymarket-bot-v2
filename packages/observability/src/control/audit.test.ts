/**
 * The append-only audit log: append-once, bounded, refusing rather than
 * dropping, and immutable to its readers.
 */

import { describe, expect, it } from "vitest";

import {
  CONTROL_AUDIT_ACTIONS,
  CONTROL_AUDIT_OUTCOMES,
  InMemoryControlAuditLog,
  type ControlAuditRecord,
} from "./audit.js";

function record(overrides: Partial<ControlAuditRecord> = {}): ControlAuditRecord {
  return {
    recordId: "01930000-0000-7000-8000-000000000001",
    action: "STRATEGY_PAUSE",
    outcome: "APPLIED",
    actor: "operator-a",
    actorKind: "HUMAN",
    scope: "STRATEGY_INSTANCE",
    scopeRef: "sb-1",
    reason: "maintenance window",
    priorState: { state: "RUNNING" },
    resultingState: { state: "PAUSED" },
    at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("the control audit vocabulary", () => {
  it("is closed and matches §14.1's shape", () => {
    expect([...CONTROL_AUDIT_ACTIONS]).toEqual([
      "STRATEGY_PAUSE",
      "STRATEGY_RESUME",
      "KILL_SWITCH_ENGAGE",
      "KILL_SWITCH_RELEASE",
      "MODE_RAISE_ATTEMPT",
    ]);
    expect([...CONTROL_AUDIT_OUTCOMES]).toEqual(["APPLIED", "REFUSED"]);
  });

  it("makes §14.1's five required fields non-optional at the type level", () => {
    // Each line below would be a compile error if the field were optional or
    // nullable; the assertions are the runtime half.
    const written = record();
    expect(written.actor).not.toBe("");
    expect(written.reason).not.toBe("");
    expect(written.at).not.toBe("");
    expect(written.priorState).toBeDefined();
    expect(written.resultingState).toBeDefined();
  });
});

describe("InMemoryControlAuditLog", () => {
  it("refuses a capacity that is not a positive safe integer", () => {
    expect(() => new InMemoryControlAuditLog(0)).toThrow(RangeError);
    expect(() => new InMemoryControlAuditLog(-1)).toThrow(RangeError);
    expect(() => new InMemoryControlAuditLog(1.5)).toThrow(RangeError);
  });

  it("appends in order and reports its size", async () => {
    const log = new InMemoryControlAuditLog(4);
    expect(await log.append(record({ recordId: "a" }))).toEqual({ ok: true });
    expect(await log.append(record({ recordId: "b", action: "STRATEGY_RESUME" }))).toEqual({
      ok: true,
    });
    expect(log.size).toBe(2);
    expect(log.records().map((entry) => entry.recordId)).toEqual(["a", "b"]);
  });

  it("APPEND-ONCE: refuses a reused record id rather than overwriting evidence", async () => {
    const log = new InMemoryControlAuditLog(4);
    await log.append(record({ recordId: "a" }));
    const second = await log.append(record({ recordId: "a", reason: "different reason" }));
    expect(second).toMatchObject({ ok: false, code: "AUDIT_RECORD_ID_REUSED" });
    expect(log.records()).toHaveLength(1);
    expect(log.records()[0]?.reason).toBe("maintenance window");
  });

  it("REFUSES at the bound — it never evicts the oldest record", async () => {
    const log = new InMemoryControlAuditLog(2);
    await log.append(record({ recordId: "a" }));
    await log.append(record({ recordId: "b" }));
    const third = await log.append(record({ recordId: "c" }));
    expect(third).toMatchObject({ ok: false, code: "AUDIT_CAPACITY_EXHAUSTED" });
    // The FIRST record — the one an evicting log would have lost — is still here.
    expect(log.records().map((entry) => entry.recordId)).toEqual(["a", "b"]);
    expect(log.capacity).toBe(2);
  });

  it("hands back a frozen copy: a caller cannot mutate, truncate or reorder the log", async () => {
    const log = new InMemoryControlAuditLog(4);
    await log.append(record({ recordId: "a" }));
    const records = log.records();
    expect(Object.isFrozen(records)).toBe(true);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(() => {
      (records as ControlAuditRecord[]).push(record({ recordId: "b" }));
    }).toThrow(TypeError);
    expect(() => {
      (records[0] as { reason: string }).reason = "rewritten";
    }).toThrow(TypeError);
    expect(log.records()).toHaveLength(1);
    expect(log.records()[0]?.reason).toBe("maintenance window");
  });

  it("records BOTH outcomes — a refused mutation is an operator fact too", async () => {
    const log = new InMemoryControlAuditLog(4);
    await log.append(
      record({
        recordId: "a",
        action: "MODE_RAISE_ATTEMPT",
        outcome: "REFUSED",
        scope: "CONTROL_PLANE",
        scopeRef: null,
        priorState: { maximumRunMode: "PAPER" },
        resultingState: { maximumRunMode: "PAPER", refused: "true" },
      }),
    );
    expect(log.records()[0]).toMatchObject({
      action: "MODE_RAISE_ATTEMPT",
      outcome: "REFUSED",
      scopeRef: null,
    });
  });
});
