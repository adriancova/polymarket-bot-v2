/**
 * The control plane — acceptance 2 proven at the level where it is TRUE BY
 * CONSTRUCTION, plus the §14.1 semantics.
 *
 * The central test is "a refusing audit sink stops the mutation": the state
 * must not move. Everything else in this suite is the vocabulary around it.
 */

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryControlAuditLog,
  type AuditAppendResult,
  type ControlAuditRecord,
  type ControlAuditSink,
} from "@polymarket-bot/observability";

import { SafetyReservedAuditSink } from "./audit-budget.js";
import {
  AUDIT_APPEND_TIMEOUT_MAX_MS,
  AUDIT_APPEND_TIMEOUT_MS,
  CONTROL_PLANE_VOID_ACTOR,
  ControlPlane,
  REFUSAL_AUDIT_MAX_ISSUES,
  REFUSAL_AUDIT_MAX_TEXT,
  type ControlPlaneOptions,
  type MutationContext,
} from "./control-plane.js";

function plane(
  audit: ControlAuditSink,
  options: Pick<ControlPlaneOptions, "auditAppendTimeoutMs" | "auditRecordSource"> = {},
): ControlPlane {
  return new ControlPlane({
    audit,
    runMode: "PAPER",
    maximumRunMode: "PAPER",
    repositoryMaximumRunMode: "PAPER",
    ...options,
  });
}

let sequence = 0;
function context(overrides: Partial<MutationContext> = {}): MutationContext {
  sequence += 1;
  return {
    actor: "operator-a",
    at: `2026-09-05T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    auditRecordId: `01930000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    reason: "a stated reason",
    ...overrides,
  };
}

/** A sink that refuses everything. Nothing may be applied through it. */
class RefusingSink implements ControlAuditSink {
  readonly seen: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): Promise<AuditAppendResult> {
    this.seen.push(record);
    return Promise.resolve({
      ok: false,
      code: "AUDIT_SINK_UNAVAILABLE",
      detail: "the durable sink is unreachable in this test",
    });
  }
}

describe("run state", () => {
  it("reports the ceiling and states, on the wire, that it is not writable", () => {
    expect(plane(new InMemoryControlAuditLog(8)).runState()).toEqual({
      runMode: "PAPER",
      maximumRunMode: "PAPER",
      repositoryMaximumRunMode: "PAPER",
      allowRealOrders: false,
      runModeIsWritable: false,
      signerLoaded: false,
    });
  });

  it("exposes NO method that changes a run mode", () => {
    // A structural assertion: the class's own surface. A future method named
    // for a run mode fails here before it reaches a reviewer.
    const surface = [
      ...Object.getOwnPropertyNames(ControlPlane.prototype),
      ...Object.getOwnPropertyNames(plane(new InMemoryControlAuditLog(8))),
    ].map((name) => name.toLowerCase());
    for (const forbidden of ["setrunmode", "raisemode", "setmaximumrunmode", "allowrealorders"]) {
      expect(surface, forbidden).not.toContain(forbidden);
    }
  });
});

describe("ACCEPTANCE 2: audit first, then apply", () => {
  it("writes an audit record for an APPLIED pause, carrying all five §14.1 fields", async () => {
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");

    const result = await control.pauseStrategy("sb-1", context({ reason: "maintenance" }));
    expect(result.ok).toBe(true);

    expect(audit.records()).toHaveLength(1);
    const record = audit.records()[0];
    expect(record).toMatchObject({
      action: "STRATEGY_PAUSE",
      outcome: "APPLIED",
      actor: "operator-a",
      actorKind: "HUMAN",
      scope: "STRATEGY_INSTANCE",
      scopeRef: "sb-1",
      reason: "maintenance",
    });
    expect(record?.priorState).toMatchObject({ state: "RUNNING" });
    expect(record?.resultingState).toMatchObject({ state: "PAUSED" });
    expect(record?.at).toMatch(/^2026-09-05T/u);
  });

  it("A REFUSING SINK STOPS THE MUTATION: the state does not move", async () => {
    const sink = new RefusingSink();
    const control = plane(sink);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");

    const result = await control.pauseStrategy("sb-1", context());
    expect(result).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
    // The state is unchanged — this is the whole property.
    expect(control.strategies()[0]?.state).toBe("RUNNING");
    // …and the attempt was OFFERED to the sink before being abandoned.
    expect(sink.seen).toHaveLength(1);
    expect(control.auditAppendFailures).toBe(1);
  });

  it("A FULL AUDIT LOG STOPS THE MUTATION, and does not evict evidence", async () => {
    const audit = new InMemoryControlAuditLog(1);
    const control = plane(audit);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    control.register("sb-2", "2026-09-05T00:00:00.000Z");

    expect((await control.pauseStrategy("sb-1", context())).ok).toBe(true);
    const second = await control.pauseStrategy("sb-2", context());
    expect(second).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });

    expect(control.strategies().find((entry) => entry.instanceId === "sb-2")?.state).toBe(
      "RUNNING",
    );
    // The FIRST record — the one an evicting log would have lost — is still here.
    expect(audit.records()).toHaveLength(1);
    expect(audit.records()[0]?.scopeRef).toBe("sb-1");
  });

  it("audits a REFUSED mutation too", async () => {
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");

    // Already RUNNING; a resume is a no-op and is refused.
    const result = await control.resumeStrategy("sb-1", context());
    expect(result).toMatchObject({ ok: false, code: "CONTROL_ALREADY_IN_STATE" });
    expect(audit.records()).toHaveLength(1);
    expect(audit.records()[0]).toMatchObject({
      action: "STRATEGY_RESUME",
      outcome: "REFUSED",
    });
    expect(audit.records()[0]?.resultingState).toMatchObject({
      refusalCode: "CONTROL_ALREADY_IN_STATE",
    });
  });

  it("audits EVERY mutating method — none has an unaudited path", async () => {
    const audit = new InMemoryControlAuditLog(32);
    const control = plane(audit);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");

    await control.pauseStrategy("sb-1", context());
    await control.resumeStrategy("sb-1", context());
    await control.engageKillSwitch(
      { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" },
      context(),
    );
    await control.releaseKillSwitch(
      {
        scope: "GLOBAL",
        scopeRef: null,
        release: { authoritativeSnapshotApplied: true, reason: "reconciled" },
      },
      context(),
    );
    await control.refuseModeRaise(["runMode"], context());

    expect(audit.records().map((record) => `${record.action}|${record.outcome}`)).toEqual([
      "STRATEGY_PAUSE|APPLIED",
      "STRATEGY_RESUME|APPLIED",
      "KILL_SWITCH_ENGAGE|APPLIED",
      "KILL_SWITCH_RELEASE|APPLIED",
      "MODE_RAISE_ATTEMPT|REFUSED",
    ]);
  });

  it("registration is NOT a mutation and writes nothing", async () => {
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    control.register("sb-2", "2026-09-05T00:00:00.000Z");
    control.register("sb-1", "2026-09-05T00:00:05.000Z");
    expect(audit.records()).toEqual([]);
    expect(control.strategies().map((entry) => entry.instanceId)).toEqual(["sb-1", "sb-2"]);
    // A repeat registration does not reset the instance's own record.
    expect(control.strategies()[0]?.since).toBe("2026-09-05T00:00:00.000Z");
    await Promise.resolve();
  });
});

describe("CONTROL-1 (M-1): an instance the control plane never knew is REFUSED, not fabricated", () => {
  it.each([
    ["pause", "STRATEGY_PAUSE"],
    ["resume", "STRATEGY_RESUME"],
  ] as const)("refuses a %s of an unregistered instance, audits the refusal, and inserts nothing", async (verb, action) => {
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    const result =
      verb === "pause"
        ? await control.pauseStrategy("never-registered", context())
        : await control.resumeStrategy("never-registered", context());
    expect(result).toMatchObject({ ok: false, code: "CONTROL_UNKNOWN_INSTANCE" });
    expect(control.strategies()).toEqual([]);
    expect(audit.records()).toHaveLength(1);
    expect(audit.records()[0]).toMatchObject({
      action,
      outcome: "REFUSED",
      scope: "STRATEGY_INSTANCE",
      scopeRef: "never-registered",
    });
    expect(audit.records()[0]?.priorState).toEqual({ known: "false", instanceId: "never-registered" });
    expect(audit.records()[0]?.resultingState).toMatchObject({
      known: "false",
      refusalCode: "CONTROL_UNKNOWN_INSTANCE",
    });
  });

  it("an unknown id never grows the instance map, however many are tried (L-8)", async () => {
    const control = plane(new InMemoryControlAuditLog(1_000));
    for (let index = 0; index < 200; index += 1) {
      await control.pauseStrategy(`unknown-${String(index)}`, context());
    }
    expect(control.strategies()).toEqual([]);
  });
});

describe("CONTROL-1 (L-6): an unauditable mutation is counted NOT_AUDITED, never APPLIED", () => {
  it("counts the refused append under its own outcome", async () => {
    const control = plane(new RefusingSink());
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    await control.pauseStrategy("sb-1", context());
    await control.engageKillSwitch({ scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }, context());
    expect(control.mutationCounts()).toEqual([
      { action: "KILL_SWITCH_ENGAGE", outcome: "NOT_AUDITED", count: 1 },
      { action: "STRATEGY_PAUSE", outcome: "NOT_AUDITED", count: 1 },
    ]);
    expect(control.auditAppendFailures).toBe(2);
    expect(control.killSwitches()).toEqual([]);
  });
});

describe("CONTROL-1 (M-3): the mode-raise record says whether it was written", () => {
  it("returns audited: true when the sink accepted the record", async () => {
    const control = plane(new InMemoryControlAuditLog(8));
    expect(await control.refuseModeRaise(["runMode"], context())).toEqual({ audited: true });
  });

  it("returns audited: false, with the refusal, when the sink refused it — and still counts the attempt", async () => {
    const control = plane(new RefusingSink());
    const outcome = await control.refuseModeRaise(["runMode"], context());
    expect(outcome).toMatchObject({ audited: false, code: "CONTROL_NOT_AUDITABLE" });
    expect(control.modeRaiseAttemptsRefused).toBe(1);
  });

  it("countModeRaiseWithoutAudit counts and writes NOTHING", () => {
    const sink = new RefusingSink();
    const control = plane(sink);
    control.countModeRaiseWithoutAudit();
    control.countModeRaiseWithoutAudit();
    expect(control.modeRaiseAttemptsRefused).toBe(2);
    expect(sink.seen).toEqual([]);
    expect(control.mutationCounts()).toEqual([]);
  });
});

describe("ACCEPTANCE 1: a mode-raise attempt is recorded and changes nothing", () => {
  it("records the attempt, names the keys, and leaves the ceiling alone", async () => {
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    const before = control.runState();

    await control.refuseModeRaise(["runMode", "allowRealOrders"], context());

    expect(control.runState()).toEqual(before);
    expect(control.modeRaiseAttemptsRefused).toBe(1);
    const record = audit.records()[0];
    expect(record).toMatchObject({
      action: "MODE_RAISE_ATTEMPT",
      outcome: "REFUSED",
      scope: "CONTROL_PLANE",
      scopeRef: null,
    });
    expect(record?.resultingState).toMatchObject({
      maximumRunMode: "PAPER",
      attemptedKeys: ["runMode", "allowRealOrders"],
    });
    // The prior and resulting ceilings are identical: nothing changed.
    expect(record?.priorState).toMatchObject({ maximumRunMode: "PAPER" });
  });
});

describe("§14.1 kill-switch semantics", () => {
  it("engages, lists and releases a scoped switch", async () => {
    const audit = new InMemoryControlAuditLog(16);
    const control = plane(audit);

    const engaged = await control.engageKillSwitch(
      { scope: "MARKET", scopeRef: "market-1", action: "CANCEL_MARKET" },
      context({ reason: "book desynchronised" }),
    );
    expect(engaged.ok).toBe(true);
    expect(control.killSwitches()).toEqual([
      {
        scope: "MARKET",
        scopeRef: "market-1",
        action: "CANCEL_MARKET",
        reason: "book desynchronised",
        since: expect.any(String) as unknown as string,
        actor: "operator-a",
      },
    ]);

    const released = await control.releaseKillSwitch(
      {
        scope: "MARKET",
        scopeRef: "market-1",
        release: { authoritativeSnapshotApplied: true, reason: "reconciled" },
      },
      context(),
    );
    expect(released.ok).toBe(true);
    expect(control.killSwitches()).toEqual([]);
  });

  it("REFUSES a GLOBAL switch that names a scope reference (§10.6 CHECK)", async () => {
    const control = plane(new InMemoryControlAuditLog(8));
    const result = await control.engageKillSwitch(
      { scope: "GLOBAL", scopeRef: "market-1", action: "FULL_HALT" },
      context(),
    );
    expect(result).toMatchObject({ ok: false, code: "CONTROL_SCOPE_REF_MISMATCH" });
    expect(control.killSwitches()).toEqual([]);
  });

  it.each(["ACCOUNT", "MARKET", "STRATEGY_INSTANCE"] as const)(
    "REFUSES a %s switch with no scope reference",
    async (scope) => {
      const control = plane(new InMemoryControlAuditLog(8));
      const result = await control.engageKillSwitch(
        { scope, scopeRef: null, action: "HALT_NEW_ENTRIES" },
        context(),
      );
      expect(result).toMatchObject({ ok: false, code: "CONTROL_SCOPE_REF_MISMATCH" });
    },
  );

  it("REFUSES a release with no evidence — and audits the attempt", async () => {
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    await control.engageKillSwitch(
      { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" },
      context(),
    );
    const result = await control.releaseKillSwitch(
      {
        scope: "GLOBAL",
        scopeRef: null,
        release: { authoritativeSnapshotApplied: false as unknown as true, reason: "just do it" },
      },
      context(),
    );
    expect(result).toMatchObject({ ok: false, code: "CONTROL_RELEASE_EVIDENCE_MISSING" });
    // Still engaged: a release without evidence releases nothing.
    expect(control.killSwitches()).toHaveLength(1);
    expect(audit.records().at(-1)).toMatchObject({
      action: "KILL_SWITCH_RELEASE",
      outcome: "REFUSED",
    });
  });

  it("REFUSES releasing a switch that is not engaged", async () => {
    const control = plane(new InMemoryControlAuditLog(8));
    const result = await control.releaseKillSwitch(
      {
        scope: "ACCOUNT",
        scopeRef: "account-1",
        release: { authoritativeSnapshotApplied: true, reason: "reconciled" },
      },
      context(),
    );
    expect(result).toMatchObject({ ok: false, code: "CONTROL_NOT_ENGAGED" });
  });

  it("keeps two switches at different scopes independent", async () => {
    const control = plane(new InMemoryControlAuditLog(16));
    await control.engageKillSwitch(
      { scope: "MARKET", scopeRef: "market-1", action: "CANCEL_MARKET" },
      context(),
    );
    await control.engageKillSwitch(
      { scope: "MARKET", scopeRef: "market-2", action: "HALT_NEW_ENTRIES" },
      context(),
    );
    expect(control.killSwitches()).toHaveLength(2);
    await control.releaseKillSwitch(
      {
        scope: "MARKET",
        scopeRef: "market-1",
        release: { authoritativeSnapshotApplied: true, reason: "reconciled" },
      },
      context(),
    );
    expect(control.killSwitches().map((entry) => entry.scopeRef)).toEqual(["market-2"]);
  });
});

describe("determinism", () => {
  it("two identical sequences produce identical audit logs", async () => {
    const run = async (): Promise<readonly ControlAuditRecord[]> => {
      const audit = new InMemoryControlAuditLog(16);
      const control = plane(audit);
      control.register("sb-1", "2026-09-05T00:00:00.000Z");
      const fixed: MutationContext = {
        actor: "operator-a",
        at: "2026-09-05T00:00:01.000Z",
        auditRecordId: "01930000-0000-7000-8000-000000000001",
        reason: "fixed",
      };
      await control.pauseStrategy("sb-1", fixed);
      return audit.records();
    };
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it("sorts strategies and kill switches so a snapshot is stable", async () => {
    const control = plane(new InMemoryControlAuditLog(16));
    control.register("sb-z", "2026-09-05T00:00:00.000Z");
    control.register("sb-a", "2026-09-05T00:00:00.000Z");
    expect(control.strategies().map((entry) => entry.instanceId)).toEqual(["sb-a", "sb-z"]);

    await control.engageKillSwitch(
      { scope: "MARKET", scopeRef: "z", action: "CANCEL_MARKET" },
      context(),
    );
    await control.engageKillSwitch(
      { scope: "ACCOUNT", scopeRef: "a", action: "FULL_HALT" },
      context(),
    );
    expect(control.killSwitches().map((entry) => entry.scope)).toEqual(["ACCOUNT", "MARKET"]);
  });
});

describe("CONTROL-1 r1 (CONTROL1-J-M1): an engage never repeats and never weakens", () => {
  const GLOBAL = { scope: "GLOBAL", scopeRef: null } as const;

  it("REFUSES an identical re-engage CONTROL_ALREADY_IN_STATE, audited as a refusal, the switch untouched", async () => {
    const audit = new InMemoryControlAuditLog(16);
    const control = plane(audit);
    expect((await control.engageKillSwitch({ ...GLOBAL, action: "HALT_NEW_ENTRIES" }, context({ reason: "first" }))).ok).toBe(true);
    const again = await control.engageKillSwitch({ ...GLOBAL, action: "HALT_NEW_ENTRIES" }, context({ reason: "again" }));
    expect(again).toMatchObject({ ok: false, code: "CONTROL_ALREADY_IN_STATE" });
    expect(control.killSwitches()).toEqual([expect.objectContaining({ action: "HALT_NEW_ENTRIES", reason: "first" })]);
    expect(audit.records().map((record) => `${record.action}|${record.outcome}`)).toEqual([
      "KILL_SWITCH_ENGAGE|APPLIED",
      "KILL_SWITCH_ENGAGE|REFUSED",
    ]);
  });

  it.each(["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY"] as const)(
    "REFUSES moving a FULL_HALT to %s: CONTROL_ENGAGE_WOULD_WEAKEN, pointing at the release",
    async (weaker) => {
      const audit = new InMemoryControlAuditLog(16);
      const control = plane(audit);
      await control.engageKillSwitch({ ...GLOBAL, action: "FULL_HALT" }, context());
      const result = await control.engageKillSwitch({ ...GLOBAL, action: weaker }, context());
      expect(result).toMatchObject({ ok: false, code: "CONTROL_ENGAGE_WOULD_WEAKEN" });
      if (!result.ok) expect(result.detail).toContain("/v1/kill-switch/release");
      expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
      expect(audit.records().at(-1)).toMatchObject({ action: "KILL_SWITCH_ENGAGE", outcome: "REFUSED" });
    },
  );

  it("APPLIES an escalation to FULL_HALT, and a change between two unordered actions", async () => {
    const control = plane(new InMemoryControlAuditLog(16));
    await control.engageKillSwitch({ ...GLOBAL, action: "HALT_NEW_ENTRIES" }, context());
    expect((await control.engageKillSwitch({ ...GLOBAL, action: "CANCEL_ALL" }, context())).ok).toBe(true);
    expect((await control.engageKillSwitch({ ...GLOBAL, action: "FULL_HALT" }, context())).ok).toBe(true);
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
  });

  it("a weaker action after a RELEASE is a new switch, applied", async () => {
    const control = plane(new InMemoryControlAuditLog(16));
    await control.engageKillSwitch({ ...GLOBAL, action: "FULL_HALT" }, context());
    await control.releaseKillSwitch(
      { ...GLOBAL, release: { authoritativeSnapshotApplied: true, reason: "reconciled" } },
      context(),
    );
    expect((await control.engageKillSwitch({ ...GLOBAL, action: "HALT_NEW_ENTRIES" }, context())).ok).toBe(true);
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["HALT_NEW_ENTRIES"]);
  });

  it("the same action at ANOTHER scope is a new switch, not a repeat", async () => {
    const control = plane(new InMemoryControlAuditLog(16));
    await control.engageKillSwitch({ scope: "MARKET", scopeRef: "m-1", action: "FULL_HALT" }, context());
    expect((await control.engageKillSwitch({ scope: "MARKET", scopeRef: "m-2", action: "FULL_HALT" }, context())).ok).toBe(true);
    expect(control.killSwitches()).toHaveLength(2);
  });
});

/** A sink whose appends settle only after a macrotask — the shape a durable sink has. */
class SlowSink implements ControlAuditSink {
  readonly records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): Promise<AuditAppendResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        this.records.push(record);
        resolve({ ok: true });
      }, 1);
    });
  }
}

describe("CONTROL-1 r1 (CONTROL1-J-L2): mutations of one state key are serialized", () => {
  it("ten CONCURRENT pauses of one instance: exactly ONE is applied, nine are CONTROL_ALREADY_IN_STATE", async () => {
    const sink = new SlowSink();
    const control = plane(sink);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    const results = await Promise.all(Array.from({ length: 10 }, () => control.pauseStrategy("sb-1", context())));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "CONTROL_ALREADY_IN_STATE")).toHaveLength(9);
    const applied = sink.records.filter((record) => record.outcome === "APPLIED");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.priorState).toMatchObject({ state: "RUNNING" });
    expect(control.mutationsInFlight).toBe(0);
  });

  it("ten CONCURRENT identical engages: exactly ONE is applied", async () => {
    const sink = new SlowSink();
    const control = plane(sink);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        control.engageKillSwitch({ scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }, context()),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(sink.records.filter((record) => record.outcome === "APPLIED")).toHaveLength(1);
    expect(control.mutationsInFlight).toBe(0);
  });

  it("a pause and a resume sent together apply IN ARRIVAL ORDER, each against the state the other left", async () => {
    const sink = new SlowSink();
    const control = plane(sink);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    const [paused, resumed] = await Promise.all([
      control.pauseStrategy("sb-1", context()),
      control.resumeStrategy("sb-1", context()),
    ]);
    expect(paused.ok && resumed.ok).toBe(true);
    expect(sink.records.map((record) => `${String((record.priorState as Record<string, unknown>)["state"])}→${String((record.resultingState as Record<string, unknown>)["state"])}`)).toEqual([
      "RUNNING→PAUSED",
      "PAUSED→RUNNING",
    ]);
  });

  it("a slow append for one instance does NOT queue a kill-switch engage behind it (keys are independent)", async () => {
    const releases: (() => void)[] = [];
    const sink: ControlAuditSink = {
      append: (record) =>
        record.scopeRef === "sb-slow"
          ? new Promise<AuditAppendResult>((resolve) => {
              releases.push(() => resolve({ ok: true }));
            })
          : Promise.resolve({ ok: true }),
    };
    const control = plane(sink);
    control.register("sb-slow", "2026-09-05T00:00:00.000Z");
    const pending = control.pauseStrategy("sb-slow", context());
    const engaged = await control.engageKillSwitch({ scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }, context());
    expect(engaged.ok).toBe(true);
    expect(control.killSwitches()).toHaveLength(1);
    expect(control.mutationsInFlight).toBe(1);
    for (const release of releases) release();
    expect((await pending).ok).toBe(true);
    expect(control.mutationsInFlight).toBe(0);
  });

  it("an unknown id leaves no lock behind, however many are tried", async () => {
    const control = plane(new InMemoryControlAuditLog(1_000));
    await Promise.all(Array.from({ length: 50 }, (_, index) => control.pauseStrategy(`ghost-${String(index)}`, context())));
    expect(control.mutationsInFlight).toBe(0);
  });

  it("a sink that THROWS does not wedge its key", async () => {
    let throwing = true;
    const sink: ControlAuditSink = {
      append: () => {
        if (throwing) return Promise.reject(new Error("sink exploded"));
        return Promise.resolve({ ok: true });
      },
    };
    const control = plane(sink);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    await expect(control.pauseStrategy("sb-1", context())).rejects.toThrow("sink exploded");
    throwing = false;
    expect((await control.pauseStrategy("sb-1", context())).ok).toBe(true);
    expect(control.mutationsInFlight).toBe(0);
  });
});

describe("CONTROL-1 r1 (CONTROL1-J-M2): refuseRequest records a refusal before the plane, bounded", () => {
  it("writes one REFUSED record that reads no state and changes nothing", async () => {
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    const outcome = await control.refuseRequest(
      "STRATEGY_PAUSE",
      { scope: "STRATEGY_INSTANCE", scopeRef: "sb-1" },
      "REQUEST_BODY",
      { code: "CONTROL_REQUEST_INVALID", detail: "the strategy control request failed its schema", issues: ["reason: required"] },
      context(),
    );
    expect(outcome).toEqual({ audited: true });
    expect(control.strategies()[0]?.state).toBe("RUNNING");
    expect(audit.records()[0]).toMatchObject({
      action: "STRATEGY_PAUSE",
      outcome: "REFUSED",
      scope: "STRATEGY_INSTANCE",
      scopeRef: "sb-1",
      priorState: { refusedAt: "REQUEST_BODY", stateRead: "false" },
      resultingState: {
        refusedAt: "REQUEST_BODY",
        stateRead: "false",
        refusalCode: "CONTROL_REQUEST_INVALID",
        refusalIssues: ["reason: required"],
        refusalIssueCount: "1",
      },
    });
    expect(control.mutationCounts()).toEqual([{ action: "STRATEGY_PAUSE", outcome: "REFUSED", count: 1 }]);
  });

  it("keeps at most 8 issues of at most 256 characters, as an ORDINARY array whatever species it was handed", async () => {
    class Issues extends Array<string> {}
    const many = new Issues();
    for (let index = 0; index < 40; index += 1) many.push(`k${String(index)}: ${"x".repeat(1_000)}`);
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    await control.refuseRequest(
      "KILL_SWITCH_ENGAGE",
      { scope: "CONTROL_PLANE", scopeRef: null },
      "REQUEST_BODY",
      { code: "CONTROL_REQUEST_INVALID", detail: "d".repeat(5_000), issues: many },
      context(),
    );
    const document = audit.records()[0]?.resultingState as Record<string, unknown>;
    const issues = document["refusalIssues"] as readonly string[];
    expect(issues).toHaveLength(8);
    expect(Object.getPrototypeOf(issues)).toBe(Array.prototype);
    for (const issue of issues) expect(issue.length).toBeLessThanOrEqual(256);
    expect((document["refusalDetail"] as string).length).toBeLessThanOrEqual(256);
    expect(document["refusalIssueCount"]).toBe("40");
  });

  it("a refused append is counted NOT_AUDITED and reported, and nothing changes", async () => {
    const control = plane(new RefusingSink());
    const outcome = await control.refuseRequest(
      "KILL_SWITCH_RELEASE",
      { scope: "CONTROL_PLANE", scopeRef: null },
      "TRANSPORT",
      { code: "CONTROL_BODY_NOT_JSON", detail: "the request body is not JSON", issues: [] },
      context(),
    );
    expect(outcome).toMatchObject({ audited: false, code: "CONTROL_NOT_AUDITABLE" });
    expect(control.mutationCounts()).toEqual([{ action: "KILL_SWITCH_RELEASE", outcome: "NOT_AUDITED", count: 1 }]);
  });
});

// --- CONTROL-1b ------------------------------------------------------------

/**
 * A sink whose GATED appends wait until the test settles them; every other
 * append, and a gated one settled with `land()`, goes to {@link GatedSink.log}.
 * The shape a durable sink has when it stalls, answers late, or fails late.
 */
class GatedSink implements ControlAuditSink {
  readonly log = new InMemoryControlAuditLog(1_000);
  readonly offered: ControlAuditRecord[] = [];
  readonly held: {
    readonly record: ControlAuditRecord;
    land(): void;
    refuse(): void;
    fail(): void;
  }[] = [];

  constructor(private readonly gated: (record: ControlAuditRecord) => boolean) {}

  append(record: ControlAuditRecord): Promise<AuditAppendResult> {
    this.offered.push(record);
    if (!this.gated(record)) return this.log.append(record);
    return new Promise<AuditAppendResult>((resolve, reject) => {
      this.held.push({
        record,
        land: () => {
          void this.log.append(record).then(resolve);
        },
        refuse: () => {
          resolve({ ok: false, code: "AUDIT_SINK_UNAVAILABLE", detail: "refused late in this test" });
        },
        fail: () => {
          reject(new Error("the sink failed late in this test"));
        },
      });
    });
  }
}

const sleep = (ms: number): Promise<"STILL WAITING"> =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve("STILL WAITING");
    }, ms);
  });

/** A scripted record source, so a void record's instant and id are known. */
function recordSource(): { now(): string; nextAuditRecordId(): string } {
  let calls = 0;
  return {
    now: () => `2026-10-01T00:00:${String(calls).padStart(2, "0")}.000Z`,
    nextAuditRecordId: () => {
      calls += 1;
      return `01930000-0000-7000-9000-${String(calls).padStart(12, "0")}`;
    },
  };
}

function documentOf(record: ControlAuditRecord | undefined, side: "priorState" | "resultingState"): Record<string, unknown> {
  return (record?.[side] ?? {}) as Record<string, unknown>;
}

describe("CONTROL-1b (CONTROL1-R2-J-L2): the kill-switch lock key is the SWITCH — every operation on it, nothing narrower or wider", () => {
  const S1 = { scope: "MARKET", scopeRef: "s1" } as const;

  it("FULL_HALT and HALT_NEW_ENTRIES sent together to one switch serialize: one escalation, one CONTROL_ENGAGE_WOULD_WEAKEN (X13)", async () => {
    const sink = new SlowSink();
    const control = plane(sink);
    const [first, second] = await Promise.all([
      control.engageKillSwitch({ ...S1, action: "FULL_HALT" }, context()),
      control.engageKillSwitch({ ...S1, action: "HALT_NEW_ENTRIES" }, context()),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "CONTROL_ENGAGE_WOULD_WEAKEN" });
    // Locked per scope AND action, both read "no switch" and both applied: the
    // FULL_HALT was silently relaxed and two APPLIED records claimed the reserve.
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
    expect(sink.records.filter((record) => record.outcome === "APPLIED")).toHaveLength(1);
  });

  it("…and in the other order, the second engage reads the FIRST one's switch as its prior (X13)", async () => {
    const sink = new SlowSink();
    const control = plane(sink);
    const [first, second] = await Promise.all([
      control.engageKillSwitch({ ...S1, action: "HALT_NEW_ENTRIES" }, context()),
      control.engageKillSwitch({ ...S1, action: "FULL_HALT" }, context()),
    ]);
    expect(first.ok && second.ok).toBe(true);
    const applied = sink.records.filter((record) => record.outcome === "APPLIED");
    expect(applied.map((record) => documentOf(record, "priorState")["action"] ?? "none")).toEqual([
      "none",
      "HALT_NEW_ENTRIES",
    ]);
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
  });

  it("an escalation and a RELEASE sent together serialize: the release records the switch it really released (X14)", async () => {
    const sink = new SlowSink();
    const control = plane(sink);
    await control.engageKillSwitch({ ...S1, action: "HALT_NEW_ENTRIES" }, context());
    const [escalated, released] = await Promise.all([
      control.engageKillSwitch({ ...S1, action: "FULL_HALT" }, context()),
      control.releaseKillSwitch({ ...S1, release: { authoritativeSnapshotApplied: true, reason: "reconciled" } }, context()),
    ]);
    expect(escalated.ok).toBe(true);
    expect(released.ok && released.value.released.action).toBe("FULL_HALT");
    const release = sink.records.find((record) => record.action === "KILL_SWITCH_RELEASE");
    // With its own lock, the release read the stale HALT_NEW_ENTRIES and
    // recorded a release of a switch that had already been escalated.
    expect(documentOf(release, "priorState")["action"]).toBe("FULL_HALT");
    expect(control.killSwitches()).toEqual([]);
  });

  it("…and a release then an engage: the engage reads the released switch as ABSENT (X14)", async () => {
    const sink = new SlowSink();
    const control = plane(sink);
    await control.engageKillSwitch({ ...S1, action: "HALT_NEW_ENTRIES" }, context());
    const [released, engaged] = await Promise.all([
      control.releaseKillSwitch({ ...S1, release: { authoritativeSnapshotApplied: true, reason: "reconciled" } }, context()),
      control.engageKillSwitch({ ...S1, action: "FULL_HALT" }, context()),
    ]);
    expect(released.ok && engaged.ok).toBe(true);
    const engage = sink.records.filter((record) => record.action === "KILL_SWITCH_ENGAGE").at(-1);
    expect(documentOf(engage, "priorState")["engaged"]).toBe("false");
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
  });

  it("DIFFERENT switches do not wait on each other: another ref, another scope at the same ref, GLOBAL, and an instance spelled like the switch", async () => {
    const sink = new GatedSink((record) => record.scope === "MARKET" && record.scopeRef === "m-1");
    const control = plane(sink, { auditAppendTimeoutMs: AUDIT_APPEND_TIMEOUT_MAX_MS });
    control.register("MARKET:m-1", "2026-09-05T00:00:00.000Z");
    const stalled = control.engageKillSwitch({ scope: "MARKET", scopeRef: "m-1", action: "FULL_HALT" }, context());
    const others = Promise.all([
      control.engageKillSwitch({ scope: "MARKET", scopeRef: "m-2", action: "FULL_HALT" }, context()),
      control.engageKillSwitch({ scope: "ACCOUNT", scopeRef: "m-1", action: "FULL_HALT" }, context()),
      control.engageKillSwitch({ scope: "GLOBAL", scopeRef: null, action: "HALT_NEW_ENTRIES" }, context()),
      control.pauseStrategy("MARKET:m-1", context()),
    ]);
    const settled = await Promise.race([others, sleep(1_000)]);
    expect(settled, "a different switch queued behind MARKET m-1").not.toBe("STILL WAITING");
    expect((await others).every((result) => result.ok)).toBe(true);
    expect(control.mutationsInFlight).toBe(1);
    for (const held of sink.held) held.land();
    expect((await stalled).ok).toBe(true);
    expect(control.mutationsInFlight).toBe(0);
  });
});

describe("CONTROL-1b (follow-up 3a): an audit append is BOUNDED", () => {
  it("defaults to AUDIT_APPEND_TIMEOUT_MS and refuses a bound outside 1 to AUDIT_APPEND_TIMEOUT_MAX_MS at construction", () => {
    expect(plane(new InMemoryControlAuditLog(8)).auditAppendTimeoutMs).toBe(AUDIT_APPEND_TIMEOUT_MS);
    expect(AUDIT_APPEND_TIMEOUT_MS).toBe(5_000);
    expect(plane(new InMemoryControlAuditLog(8), { auditAppendTimeoutMs: 1 }).auditAppendTimeoutMs).toBe(1);
    for (const bad of [0, -1, 1.5, AUDIT_APPEND_TIMEOUT_MAX_MS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => plane(new InMemoryControlAuditLog(8), { auditAppendTimeoutMs: bad }), String(bad)).toThrow(RangeError);
    }
    // `CONTROL-1b` r1 (J-L1): whether a late APPLIED record is voided is visible on the plane.
    expect(plane(new InMemoryControlAuditLog(8)).voidsLateAppliedRecords).toBe(false);
    expect(plane(new InMemoryControlAuditLog(8), { auditRecordSource: recordSource() }).voidsLateAppliedRecords).toBe(true);
  });

  it("a sink that never answers: refused CONTROL_NOT_AUDITABLE once the bound expires, state unmoved, lock released, counted NOT_AUDITED", async () => {
    const sink = new GatedSink(() => true);
    const control = plane(sink, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    const result = await control.pauseStrategy("sb-1", context());
    expect(result).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
    expect(!result.ok && result.detail).toContain("25 ms append bound");
    expect(control.strategies()[0]?.state).toBe("RUNNING");
    expect(control.mutationsInFlight).toBe(0);
    expect(control.unsettledAuditAppends).toBe(1);
    expect(control.auditAppendFailures).toBe(1);
    expect(control.mutationCounts()).toEqual([{ action: "STRATEGY_PAUSE", outcome: "NOT_AUDITED", count: 1 }]);
    // The record was OFFERED, escaped, before the bound expired.
    expect(sink.offered).toHaveLength(1);
    expect(sink.log.records()).toEqual([]);
  });

  it("the mutation queued behind a stalled one runs when the bound expires — the lock is released, not held for the sink", async () => {
    // `CONTROL-1b` r1: the queued mutations write ORDINARY records. A queued
    // second PAUSE of the stalled instance is refused by the J-M1 gate instead
    // (the block below); at round 0 this test queued one and saw it applied.
    const firstId = "01930000-0000-7000-8000-00000000f001";
    const sink = new GatedSink((record) => record.recordId === firstId);
    const control = plane(sink, { auditAppendTimeoutMs: 25 });
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    const [first, second] = await Promise.all([
      control.pauseStrategy("sb-1", context({ auditRecordId: firstId })),
      control.resumeStrategy("sb-1", context()),
    ]);
    expect(first).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
    // The resume RAN while the pause's append was still unsettled, and its record landed.
    expect(second).toMatchObject({ ok: false, code: "CONTROL_ALREADY_IN_STATE" });
    expect(control.unsettledAuditAppends).toBe(1);
    expect(sink.log.records().map((record) => `${record.action}/${record.outcome}`)).toEqual(["STRATEGY_RESUME/REFUSED"]);

    // …and a queued mutation that APPLIES: a release stalls, the escalation behind it is applied.
    const releaseId = "01930000-0000-7000-8000-00000000f002";
    const switchSink = new GatedSink((record) => record.recordId === releaseId);
    const switches = plane(switchSink, { auditAppendTimeoutMs: 25 });
    const target = { scope: "MARKET", scopeRef: "q-1" } as const;
    expect((await switches.engageKillSwitch({ ...target, action: "HALT_NEW_ENTRIES" }, context())).ok).toBe(true);
    const [released, escalated] = await Promise.all([
      switches.releaseKillSwitch(
        { ...target, release: { authoritativeSnapshotApplied: true, reason: "reconciled" } },
        context({ auditRecordId: releaseId }),
      ),
      switches.engageKillSwitch({ ...target, action: "FULL_HALT" }, context()),
    ]);
    expect(released).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
    expect(escalated.ok).toBe(true);
    expect(switches.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
  });

  it("a LATE SUCCESS never applies: the APPLIED record that landed is VOIDED by a REFUSED record naming it", async () => {
    let gating = true;
    const sink = new GatedSink((record) => gating && record.outcome === "APPLIED");
    const control = plane(sink, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    const engaged = await control.engageKillSwitch({ scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }, context());
    expect(engaged).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
    expect(control.killSwitches()).toEqual([]);

    sink.held[0]?.land();
    await vi.waitFor(() => {
      expect(sink.log.records()).toHaveLength(2);
    });
    // STILL not applied — nothing on the late path can apply.
    expect(control.killSwitches()).toEqual([]);
    const [late, voided] = sink.log.records();
    expect(late).toMatchObject({ action: "KILL_SWITCH_ENGAGE", outcome: "APPLIED", actor: "operator-a" });
    expect(voided).toMatchObject({
      recordId: "01930000-0000-7000-9000-000000000001",
      at: "2026-10-01T00:00:00.000Z",
      action: "KILL_SWITCH_ENGAGE",
      outcome: "REFUSED",
      actor: CONTROL_PLANE_VOID_ACTOR,
      actorKind: "AUTOMATED",
      scope: "GLOBAL",
      scopeRef: null,
    });
    expect(voided?.priorState).toEqual(late?.priorState);
    expect(documentOf(voided, "resultingState")).toMatchObject({
      ...documentOf(late, "priorState"),
      voidsRecordId: late?.recordId,
      voidsOutcome: "APPLIED",
      voidsActor: "operator-a",
      refusalCode: "CONTROL_NOT_AUDITABLE",
    });
    expect(voided?.reason).toContain(`VOID of audit record ${late?.recordId ?? ""}`);
    expect(control.unsettledAuditAppends).toBe(0);
    expect(control.mutationCounts()).toEqual([
      { action: "KILL_SWITCH_ENGAGE", outcome: "LANDED_LATE", count: 1 },
      { action: "KILL_SWITCH_ENGAGE", outcome: "NOT_AUDITED", count: 1 },
      { action: "KILL_SWITCH_ENGAGE", outcome: "VOIDED", count: 1 },
    ]);

    // A real engage afterwards, answered in time, is the only one in effect.
    gating = false;
    const again = await control.engageKillSwitch({ scope: "GLOBAL", scopeRef: null, action: "HALT_NEW_ENTRIES" }, context());
    expect(again.ok).toBe(true);
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["HALT_NEW_ENTRIES"]);
  });

  it("a late REFUSAL of the append, or a late THROW, lands nothing, voids nothing, and leaves no rejection behind", async () => {
    const sink = new GatedSink((record) => record.outcome === "APPLIED");
    const control = plane(sink, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    control.register("sb-2", "2026-09-05T00:00:00.000Z");
    expect((await control.pauseStrategy("sb-1", context())).ok).toBe(false);
    expect((await control.pauseStrategy("sb-2", context())).ok).toBe(false);
    expect(control.unsettledAuditAppends).toBe(2);
    sink.held[0]?.refuse();
    sink.held[1]?.fail();
    await vi.waitFor(() => {
      expect(control.unsettledAuditAppends).toBe(0);
    });
    expect(sink.log.records()).toEqual([]);
    expect(control.strategies().map((entry) => entry.state)).toEqual(["RUNNING", "RUNNING"]);
    expect(control.mutationCounts()).toEqual([{ action: "STRATEGY_PAUSE", outcome: "NOT_AUDITED", count: 2 }]);
  });

  it("a sink that breaks the port and answers LATE with a non-result leaves no rejection behind, and voids nothing", async () => {
    const held: ((value: AuditAppendResult) => void)[] = [];
    const control = plane(
      { append: () => new Promise<AuditAppendResult>((resolve) => held.push(resolve)) },
      { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() },
    );
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    expect((await control.pauseStrategy("sb-1", context())).ok).toBe(false);
    held[0]?.(undefined as unknown as AuditAppendResult);
    await vi.waitFor(() => {
      expect(control.unsettledAuditAppends).toBe(0);
    });
    expect(control.strategies()[0]?.state).toBe("RUNNING");
    expect(control.mutationCounts()).toEqual([{ action: "STRATEGY_PAUSE", outcome: "NOT_AUDITED", count: 1 }]);
  });

  it("…and when the VOID's own append answers with a non-result, the late record stays counted and unvoided, with no rejection", async () => {
    const held: ((value: AuditAppendResult) => void)[] = [];
    const control = plane(
      { append: () => new Promise<AuditAppendResult>((resolve) => held.push(resolve)) },
      { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() },
    );
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    expect((await control.pauseStrategy("sb-1", context())).ok).toBe(false);
    held[0]?.({ ok: true });
    await vi.waitFor(() => {
      expect(held).toHaveLength(2);
    });
    held[1]?.(undefined as unknown as AuditAppendResult);
    await sleep(10);
    expect(control.mutationCounts()).toEqual([
      { action: "STRATEGY_PAUSE", outcome: "LANDED_LATE", count: 1 },
      { action: "STRATEGY_PAUSE", outcome: "NOT_AUDITED", count: 1 },
    ]);
  });

  it("a REFUSED record that lands late is a true record of a refusal: it is not voided", async () => {
    const sink = new GatedSink((record) => record.outcome === "REFUSED");
    const control = plane(sink, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    expect(await control.pauseStrategy("ghost", context())).toMatchObject({ ok: false, code: "CONTROL_UNKNOWN_INSTANCE" });
    sink.held[0]?.land();
    await vi.waitFor(() => {
      expect(control.unsettledAuditAppends).toBe(0);
    });
    expect(sink.log.records().map((record) => record.outcome)).toEqual(["REFUSED"]);
    expect(control.mutationCounts()).toEqual([{ action: "STRATEGY_PAUSE", outcome: "NOT_AUDITED", count: 1 }]);
  });

  it("with NO record source a late APPLIED record is counted LANDED_LATE and left unvoided — visible, not silent", async () => {
    const sink = new GatedSink((record) => record.outcome === "APPLIED");
    const control = plane(sink, { auditAppendTimeoutMs: 25 });
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    await control.pauseStrategy("sb-1", context());
    sink.held[0]?.land();
    await vi.waitFor(() => {
      expect(control.unsettledAuditAppends).toBe(0);
    });
    expect(sink.log.records().map((record) => record.outcome)).toEqual(["APPLIED"]);
    expect(control.strategies()[0]?.state).toBe("RUNNING");
    expect(control.mutationCounts()).toContainEqual({ action: "STRATEGY_PAUSE", outcome: "LANDED_LATE", count: 1 });
    expect(control.mutationCounts().some((entry) => entry.outcome === "VOIDED")).toBe(false);
  });

  it("a void the sink REFUSES leaves the late record counted LANDED_LATE without VOIDED", async () => {
    const sink = new GatedSink((record) => record.outcome === "APPLIED");
    const refusing: ControlAuditSink = {
      append: (record) =>
        record.actor === CONTROL_PLANE_VOID_ACTOR
          ? Promise.resolve({ ok: false, code: "AUDIT_CAPACITY_EXHAUSTED", detail: "full in this test" })
          : sink.append(record),
    };
    const control = plane(refusing, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    await control.pauseStrategy("sb-1", context());
    sink.held[0]?.land();
    await vi.waitFor(() => {
      expect(control.mutationCounts()).toContainEqual({ action: "STRATEGY_PAUSE", outcome: "LANDED_LATE", count: 1 });
    });
    await sleep(10);
    expect(control.mutationCounts().some((entry) => entry.outcome === "VOIDED")).toBe(false);
  });

  it("an append answered in time leaves NO timer behind", async () => {
    vi.useFakeTimers();
    try {
      const control = plane(new InMemoryControlAuditLog(8));
      control.register("sb-1", "2026-09-05T00:00:00.000Z");
      expect((await control.pauseStrategy("sb-1", context())).ok).toBe(true);
      await control.refuseModeRaise(["runMode"], context());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sink that throws SYNCHRONOUSLY or rejects inside the bound still rejects the mutation, as at CONTROL-1", async () => {
    const control = plane({
      append: () => {
        throw new Error("sink threw synchronously");
      },
    });
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    await expect(control.pauseStrategy("sb-1", context())).rejects.toThrow("sink threw synchronously");
    expect(control.strategies()[0]?.state).toBe("RUNNING");
    expect(control.mutationsInFlight).toBe(0);
  });

  it("behind the audit budget: timed-out ORDINARY appends keep only ordinary slots and never reach the kill-switch reserve", async () => {
    // C = 7, R = 2: ordinary up to 3, safety-direction up to 5, a strengthening engage up to 7.
    const inner = new GatedSink((record) => record.outcome === "REFUSED" || record.scopeRef === "late");
    const budget = new SafetyReservedAuditSink(inner, { capacity: 7, safetyReserve: 2 });
    const control = plane(budget, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    const refuse = (): Promise<unknown> =>
      control.refuseRequest(
        "KILL_SWITCH_ENGAGE",
        { scope: "CONTROL_PLANE", scopeRef: null },
        "REQUEST_BODY",
        { code: "CONTROL_REQUEST_INVALID", detail: "d", issues: [] },
        context(),
      );
    for (let index = 0; index < 3; index += 1) {
      expect(await refuse()).toMatchObject({ audited: false, unconfirmed: true });
    }
    // The ordinary tier is held by three appends that may still land…
    expect(await refuse()).toMatchObject({ audited: false, unconfirmed: false });
    // …and the reserve is untouched: a new switch still engages.
    expect((await control.engageKillSwitch({ scope: "MARKET", scopeRef: "m-1", action: "FULL_HALT" }, context())).ok).toBe(true);
    for (const held of inner.held) held.land();
    await vi.waitFor(() => {
      expect(budget.admitted).toBe(4);
    });

    // A STRENGTHENING engage that times out and lands late spends ONE reserved
    // record for good; its void is ordinary, and the ordinary tier is full.
    const late = await control.engageKillSwitch({ scope: "MARKET", scopeRef: "late", action: "FULL_HALT" }, context());
    expect(late).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
    inner.held.at(-1)?.land();
    await vi.waitFor(() => {
      expect(budget.admitted).toBe(5);
    });
    await sleep(10);
    expect(control.killSwitches().map((entry) => entry.scopeRef)).toEqual(["m-1"]);
    expect(control.mutationCounts()).toContainEqual({ action: "KILL_SWITCH_ENGAGE", outcome: "LANDED_LATE", count: 1 });
    expect(control.mutationCounts().some((entry) => entry.outcome === "VOIDED")).toBe(false);
  });
});

describe("CONTROL-1b r1 (CONTROL1B-R1-J-M1): at most ONE unsettled protected append per switch or instance", () => {
  const GLOBAL_HALT = { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" } as const;
  const refuseOrdinary = (control: ControlPlane): Promise<unknown> =>
    control.refuseRequest(
      "STRATEGY_PAUSE",
      { scope: "STRATEGY_INSTANCE", scopeRef: "sb-x" },
      "REQUEST_BODY",
      { code: "CONTROL_REQUEST_INVALID", detail: "d", issues: [] },
      context(),
    );

  it("the verifiers' reproduction: retrying ONE timed-out GLOBAL FULL_HALT through a stall spends ONE reserved record, and once the sink answers the halt ENGAGES", async () => {
    // C = 10, R = 2: ordinary to 6, safety-direction to 8, a strengthening
    // engage to 10. Six ordinary records landed first, as in the reproduction.
    let stalling = false;
    const inner = new GatedSink((record) => stalling && record.outcome === "APPLIED");
    const budget = new SafetyReservedAuditSink(inner, { capacity: 10, safetyReserve: 2 });
    const control = plane(budget, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    for (let index = 0; index < 6; index += 1) expect(await refuseOrdinary(control)).toEqual({ audited: true });
    expect(budget.admitted).toBe(6);

    stalling = true;
    const first = await control.engageKillSwitch(GLOBAL_HALT, context());
    expect(first).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
    expect(!first.ok && first.detail).toContain("25 ms append bound");
    // The 503 promises a void only conditionally: a void is ordinary (J-M1).
    expect(!first.ok && first.detail).toContain("when the sink and the audit budget admit one");
    // Four retries during the stall: each refused WITHOUT an append.
    for (let retry = 0; retry < 4; retry += 1) {
      const again = await control.engageKillSwitch(GLOBAL_HALT, context());
      expect(again, `retry ${String(retry)}`).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
      expect(!again.ok && again.detail, `retry ${String(retry)}`).toContain("is UNSETTLED");
    }
    expect(inner.offered.filter((record) => record.outcome === "APPLIED")).toHaveLength(1);
    expect(control.unsettledAuditAppends).toBe(1);
    // A gated refusal attempted no append, so it is counted NOT_AUDITED but is
    // not an audit-append FAILURE: only the timed-out one is.
    expect(control.auditAppendFailures).toBe(1);

    // The sink recovers: the one held engage lands, and its void is refused
    // (a void is ordinary, and the ordinary tier is full) — visible as
    // LANDED_LATE without VOIDED.
    stalling = false;
    inner.held[0]?.land();
    await vi.waitFor(() => {
      expect(control.unsettledAuditAppends).toBe(0);
    });
    await sleep(10);
    expect(budget.admitted).toBe(7);
    expect(control.killSwitches()).toEqual([]);

    // At round 0 four late APPLIED records filled the reserve and this was 503.
    const engaged = await control.engageKillSwitch(GLOBAL_HALT, context());
    expect(engaged.ok).toBe(true);
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
    expect(budget.admitted).toBe(8);
    // …and a repeat is the ordinary refusal a real halt's repeat is.
    expect(await control.engageKillSwitch(GLOBAL_HALT, context())).toMatchObject({ code: "CONTROL_ALREADY_IN_STATE" });
    // NOT_AUDITED: the timed-out engage, the four gated retries, and the
    // repeat's refusal record (refused by the full ordinary tier).
    const counts = control.mutationCounts().filter((entry) => entry.action === "KILL_SWITCH_ENGAGE");
    expect(counts).toEqual([
      { action: "KILL_SWITCH_ENGAGE", outcome: "APPLIED", count: 1 },
      { action: "KILL_SWITCH_ENGAGE", outcome: "LANDED_LATE", count: 1 },
      { action: "KILL_SWITCH_ENGAGE", outcome: "NOT_AUDITED", count: 6 },
    ]);
  });

  it("the gate is per SWITCH and per PROTECTED record: another switch engages, an ordinary refusal of the same switch is written, and a late FAILURE lifts it", async () => {
    let stalling = true;
    const sink = new GatedSink((record) => stalling && record.scope === "GLOBAL" && record.outcome === "APPLIED");
    const control = plane(sink, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    expect(await control.engageKillSwitch(GLOBAL_HALT, context())).toMatchObject({ code: "CONTROL_NOT_AUDITABLE" });

    // Another action at the SAME switch is a strengthening engage too: gated, nothing offered.
    const offeredBefore = sink.offered.length;
    const other = await control.engageKillSwitch({ ...GLOBAL_HALT, action: "HALT_NEW_ENTRIES" }, context());
    expect(!other.ok && other.detail).toContain("is UNSETTLED");
    expect(sink.offered).toHaveLength(offeredBefore);
    // A DIFFERENT switch is not gated.
    expect((await control.engageKillSwitch({ scope: "MARKET", scopeRef: "m-1", action: "FULL_HALT" }, context())).ok).toBe(true);
    // An ORDINARY record of the same switch is written: a release of a switch nobody engaged.
    expect(
      await control.releaseKillSwitch(
        { scope: "GLOBAL", scopeRef: null, release: { authoritativeSnapshotApplied: true, reason: "r" } },
        context(),
      ),
    ).toMatchObject({ code: "CONTROL_NOT_ENGAGED" });
    expect(sink.log.records().at(-1)).toMatchObject({ action: "KILL_SWITCH_RELEASE", outcome: "REFUSED", scope: "GLOBAL" });

    // The sink answers the held engage with a FAILURE: nothing landed, and the gate lifts.
    stalling = false;
    sink.held[0]?.fail();
    await vi.waitFor(() => {
      expect(control.unsettledAuditAppends).toBe(0);
    });
    expect((await control.engageKillSwitch(GLOBAL_HALT, context())).ok).toBe(true);
    expect(control.killSwitches().map((entry) => `${entry.scope}:${entry.action}`)).toEqual([
      "GLOBAL:FULL_HALT",
      "MARKET:FULL_HALT",
    ]);
  });

  it("an ESCALATION that timed out gates the next escalation of that switch; an unordered change of it is ordinary and applies", async () => {
    let stalling = false;
    const target = { scope: "MARKET", scopeRef: "e-1" } as const;
    const sink = new GatedSink((record) => stalling && record.outcome === "APPLIED");
    const control = plane(sink, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    expect((await control.engageKillSwitch({ ...target, action: "HALT_NEW_ENTRIES" }, context())).ok).toBe(true);
    stalling = true;
    expect(await control.engageKillSwitch({ ...target, action: "FULL_HALT" }, context())).toMatchObject({
      code: "CONTROL_NOT_AUDITABLE",
    });
    const retried = await control.engageKillSwitch({ ...target, action: "FULL_HALT" }, context());
    expect(!retried.ok && retried.detail).toContain("is UNSETTLED");
    expect(sink.held).toHaveLength(1);
    // HALT_NEW_ENTRIES -> CANCEL_ALL is a change between two unordered actions:
    // an ORDINARY record, so the gate does not apply (it is offered, and held).
    expect(await control.engageKillSwitch({ ...target, action: "CANCEL_ALL" }, context())).toMatchObject({
      code: "CONTROL_NOT_AUDITABLE",
    });
    expect(sink.held).toHaveLength(2);
    stalling = false;
    for (const held of sink.held) held.refuse();
    await vi.waitFor(() => {
      expect(control.unsettledAuditAppends).toBe(0);
    });
    expect((await control.engageKillSwitch({ ...target, action: "FULL_HALT" }, context())).ok).toBe(true);
    expect(control.killSwitches().map((entry) => entry.action)).toEqual(["FULL_HALT"]);
  });

  it("a halting PAUSE that timed out gates the next pause of that instance — not a resume, not another instance — until the sink answers", async () => {
    let stalling = true;
    const sink = new GatedSink((record) => stalling && record.scopeRef === "sb-1" && record.outcome === "APPLIED");
    const control = plane(sink, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    control.register("sb-1", "2026-09-05T00:00:00.000Z");
    control.register("sb-2", "2026-09-05T00:00:00.000Z");
    expect(await control.pauseStrategy("sb-1", context())).toMatchObject({ code: "CONTROL_NOT_AUDITABLE" });
    const retried = await control.pauseStrategy("sb-1", context());
    expect(!retried.ok && retried.detail).toContain("strategy instance is UNSETTLED");
    expect(sink.held).toHaveLength(1);
    expect(await control.resumeStrategy("sb-1", context())).toMatchObject({ code: "CONTROL_ALREADY_IN_STATE" });
    expect((await control.pauseStrategy("sb-2", context())).ok).toBe(true);

    stalling = false;
    sink.held[0]?.land();
    await vi.waitFor(() => {
      expect(control.mutationCounts()).toContainEqual({ action: "STRATEGY_PAUSE", outcome: "VOIDED", count: 1 });
    });
    expect((await control.pauseStrategy("sb-1", context())).ok).toBe(true);
    expect(control.strategies().map((entry) => entry.state)).toEqual(["PAUSED", "PAUSED"]);
  });
});

describe("CONTROL-1b (follow-up 3b): a mode-raise record is BOUNDED like every other refusal record", () => {
  it("keeps at most 8 keys of at most 256 code units, as an ORDINARY array, and says how many there were", async () => {
    class Keys extends Array<string> {}
    const keys = new Keys();
    for (let index = 0; index < 40; index += 1) keys.push(`runMode${"x".repeat(index * 20)}`);
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    const outcome = await control.refuseModeRaise(keys, context({ reason: `request to POST /${"p".repeat(10_000)}` }));
    expect(outcome).toEqual({ audited: true });
    const record = audit.records()[0];
    const document = documentOf(record, "resultingState");
    const attempted = document["attemptedKeys"] as readonly string[];
    expect(attempted).toHaveLength(REFUSAL_AUDIT_MAX_ISSUES);
    expect(Object.getPrototypeOf(attempted)).toBe(Array.prototype);
    for (const key of attempted) expect(key.length).toBeLessThanOrEqual(REFUSAL_AUDIT_MAX_TEXT);
    expect(document["attemptedKeyCount"]).toBe("40");
    expect(record?.reason.length).toBeLessThanOrEqual(REFUSAL_AUDIT_MAX_TEXT);
    expect(record?.reason.endsWith("…")).toBe(true);
  });

  it("eight keys or fewer: the document is byte-identical to the one CONTROL-1 wrote (no count, the same keys)", async () => {
    const audit = new InMemoryControlAuditLog(8);
    const control = plane(audit);
    const eight = ["runMode", "allowRealOrders", "mode", "signer", "wallet", "secret", "apiKey", "mnemonic"];
    await control.refuseModeRaise(eight, context({ reason: "request to POST /v1/kill-switch named runMode" }));
    expect(JSON.stringify(audit.records()[0]?.resultingState)).toBe(
      JSON.stringify({
        runMode: "PAPER",
        maximumRunMode: "PAPER",
        repositoryMaximumRunMode: "PAPER",
        allowRealOrders: "false",
        runModeIsWritable: "false",
        signerLoaded: "false",
        attemptedKeys: eight,
      }),
    );
    expect(audit.records()[0]?.reason).toBe("request to POST /v1/kill-switch named runMode");
  });
});

describe("CONTROL-1b (follow-up 3c): every record reaches the sink ESCAPED, once", () => {
  const HOSTILE = "a\u0000b\uD800c\u202Ed\u001B[2Je\u2028f";
  const ESCAPED = "a\\u{0}b\\u{D800}c\\u{202E}d\\u{1B}[2Je\\u{2028}f";

  it("a refusal's code, detail, issues and the record's reason: NUL, a lone surrogate, U+202E, ESC and U+2028 become visible escapes", async () => {
    const sink = new GatedSink(() => false);
    const control = plane(sink);
    await control.refuseRequest(
      "STRATEGY_PAUSE",
      { scope: "STRATEGY_INSTANCE", scopeRef: null },
      "REQUEST_BODY",
      { code: `CODE${HOSTILE}`, detail: HOSTILE, issues: [`${HOSTILE}: Unrecognized key`] },
      context({ reason: HOSTILE }),
    );
    const record = sink.offered[0];
    expect(record?.reason).toBe(ESCAPED);
    expect(documentOf(record, "resultingState")).toMatchObject({
      refusalCode: `CODE${ESCAPED}`,
      refusalDetail: ESCAPED,
      refusalIssues: [`${ESCAPED}: Unrecognized key`],
    });
    // What a durable sink would hand `jsonb`: no NUL escape, no lone-surrogate escape.
    const json = JSON.stringify(record);
    expect(json).not.toMatch(/\\u0000|\\ud[89a-f][0-9a-f]{2}/iu);
    expect(json).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it("an APPLIED engage with such bytes in its reason and scopeRef is APPLIED; its record is escaped, its state keeps the operator's text", async () => {
    const sink = new GatedSink(() => false);
    const control = plane(sink);
    const result = await control.engageKillSwitch(
      { scope: "MARKET", scopeRef: `m${HOSTILE}`, action: "FULL_HALT" },
      context({ reason: HOSTILE }),
    );
    expect(result.ok).toBe(true);
    expect(control.killSwitches()[0]).toMatchObject({ scopeRef: `m${HOSTILE}`, reason: HOSTILE });
    const record = sink.log.records()[0];
    expect(record).toMatchObject({ outcome: "APPLIED", scopeRef: `m${ESCAPED}`, reason: ESCAPED });
    expect(documentOf(record, "resultingState")).toMatchObject({ scopeRef: `m${ESCAPED}`, reason: ESCAPED });
  });

  it("a VOID record goes through the same chokepoint: its prior state — the operator's hostile reason — is escaped exactly as the record it voids", async () => {
    let gating = false;
    const sink = new GatedSink((record) => gating && record.outcome === "APPLIED");
    const control = plane(sink, { auditAppendTimeoutMs: 25, auditRecordSource: recordSource() });
    const market = { scope: "MARKET", scopeRef: "m-1" } as const;
    expect((await control.engageKillSwitch({ ...market, action: "HALT_NEW_ENTRIES" }, context({ reason: HOSTILE }))).ok).toBe(true);
    gating = true;
    expect((await control.engageKillSwitch({ ...market, action: "FULL_HALT" }, context())).ok).toBe(false);
    sink.held[0]?.land();
    await vi.waitFor(() => {
      expect(sink.log.records()).toHaveLength(3);
    });
    const [, late, voided] = sink.log.records();
    expect(documentOf(late, "priorState")["reason"]).toBe(ESCAPED);
    expect(voided?.actor).toBe(CONTROL_PLANE_VOID_ACTOR);
    // Escaped ONCE: equal to what the sink holds for the voided record, not escaped again.
    expect(voided?.priorState).toEqual(late?.priorState);
    expect(documentOf(voided, "resultingState")["reason"]).toBe(ESCAPED);
    expect(JSON.stringify(voided)).not.toMatch(/\\u0000|\\ud[89a-f][0-9a-f]{2}/iu);
  });

  it("a bound never splits a surrogate pair, and is measured on the STORED text", async () => {
    const sink = new GatedSink(() => false);
    const control = plane(sink);
    const issue = `${"a".repeat(REFUSAL_AUDIT_MAX_TEXT - 2)}\u{1F600}tail`;
    const escapes = "\u0000".repeat(400);
    await control.refuseRequest(
      "STRATEGY_PAUSE",
      { scope: "STRATEGY_INSTANCE", scopeRef: null },
      "REQUEST_BODY",
      { code: "CONTROL_REQUEST_INVALID", detail: escapes, issues: [issue] },
      context(),
    );
    const document = documentOf(sink.offered[0], "resultingState");
    const [kept] = document["refusalIssues"] as readonly string[];
    expect(kept).toBe(`${"a".repeat(REFUSAL_AUDIT_MAX_TEXT - 2)}…`);
    expect(kept?.length).toBeLessThanOrEqual(REFUSAL_AUDIT_MAX_TEXT);
    expect(kept).not.toMatch(/\p{Cs}/u);
    const detail = document["refusalDetail"] as string;
    expect(detail.length).toBeLessThanOrEqual(REFUSAL_AUDIT_MAX_TEXT);
    expect(detail).toBe(`${"\\u{0}".repeat(Math.floor((REFUSAL_AUDIT_MAX_TEXT - 1) / 5))}…`);
  });
});
