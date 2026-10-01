/**
 * The control plane — acceptance 2 proven at the level where it is TRUE BY
 * CONSTRUCTION, plus the §14.1 semantics.
 *
 * The central test is "a refusing audit sink stops the mutation": the state
 * must not move. Everything else in this suite is the vocabulary around it.
 */

import { describe, expect, it } from "vitest";

import {
  InMemoryControlAuditLog,
  type AuditAppendResult,
  type ControlAuditRecord,
  type ControlAuditSink,
} from "@polymarket-bot/observability";

import { ControlPlane, type MutationContext } from "./control-plane.js";

function plane(audit: ControlAuditSink): ControlPlane {
  return new ControlPlane({
    audit,
    runMode: "PAPER",
    maximumRunMode: "PAPER",
    repositoryMaximumRunMode: "PAPER",
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
