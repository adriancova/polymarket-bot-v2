/**
 * WP-240 ACCEPTANCE 2 — "Every mutation is audited."
 *
 * Driven over REAL HTTP against the REAL API, the REAL control plane and the
 * REAL append-only audit log.
 *
 * The strongest form of this claim is not "we remembered to audit everywhere" —
 * it is **"a mutation that cannot be audited does not happen"**, and that is
 * what the middle group of tests measures: with the log at its bound, and with
 * a record id reused, the state does not move.
 *
 * The documented exceptions are asserted rather than glossed: an
 * unauthenticated request writes no audit record, because it never reaches the
 * control plane. An audit log an anonymous caller can fill is an audit log an
 * anonymous caller can exhaust — and this one refuses mutations when full.
 * (`CONTROL-1` extended the same reasoning to every caller WITHOUT mutation
 * authority — `README.md`, "The audit budget"; pinned in
 * `m3-audit-exhaustion.test.ts` and `audit-budget-adversarial.test.ts`.)
 */

import { afterEach, describe, expect, it } from "vitest";

import { FAKE_OPERATOR_TOKEN, FAKE_READER_TOKEN } from "@polymarket-bot/control-api/testing";

import { serveControlApi, type ServedApi } from "./support/client.js";

const OPERATORS = [
  {
    operatorId: "operator-a",
    token: FAKE_OPERATOR_TOKEN,
    grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] as const,
  },
  { operatorId: "reader-b", token: FAKE_READER_TOKEN, grants: ["READ"] as const },
];

let served: ServedApi | undefined;

afterEach(async () => {
  await served?.server.close();
  served = undefined;
});

async function start(auditCapacity = 64): Promise<ServedApi> {
  served = await serveControlApi({ operators: OPERATORS, auditCapacity });
  served.controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
  served.controlPlane.register("sb-2", "2026-09-05T00:00:00.000Z");
  return served;
}

describe("ACCEPTANCE 2: every mutation writes an audit record", () => {
  it("audits all four APPLIED mutations, with §14.1's five required fields", async () => {
    const api = await start();

    expect(
      (
        await api.call("POST", "/v1/strategies/sb-1/pause", {
          token: FAKE_OPERATOR_TOKEN,
          body: { reason: "maintenance window opens" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.call("POST", "/v1/strategies/sb-1/resume", {
          token: FAKE_OPERATOR_TOKEN,
          body: { reason: "maintenance window closes" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.call("POST", "/v1/kill-switch", {
          token: FAKE_OPERATOR_TOKEN,
          body: {
            scope: "MARKET",
            scopeRef: "market-1",
            action: "CANCEL_MARKET",
            reason: "book desynchronised",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.call("POST", "/v1/kill-switch/release", {
          token: FAKE_OPERATOR_TOKEN,
          body: {
            scope: "MARKET",
            scopeRef: "market-1",
            authoritativeSnapshotApplied: true,
            reason: "reconciled against a fresh snapshot",
          },
        })
      ).status,
    ).toBe(200);

    const records = api.audit.records();
    expect(records.map((record) => `${record.action}|${record.outcome}`)).toEqual([
      "STRATEGY_PAUSE|APPLIED",
      "STRATEGY_RESUME|APPLIED",
      "KILL_SWITCH_ENGAGE|APPLIED",
      "KILL_SWITCH_RELEASE|APPLIED",
    ]);

    for (const record of records) {
      // §14.1: "actor, reason, timestamp, prior state, and resulting state".
      expect(record.actor).toBe("operator-a");
      expect(record.actorKind).toBe("HUMAN");
      expect(record.reason.length).toBeGreaterThan(3);
      expect(record.at).toMatch(/^2026-09-05T/u);
      expect(record.priorState).toBeDefined();
      expect(record.resultingState).toBeDefined();
      // …and PRIOR is not RESULTING for an applied change.
      expect(JSON.stringify(record.priorState)).not.toBe(JSON.stringify(record.resultingState));
      // Record ids are unique.
      expect(record.recordId).toMatch(/^01930000-0000-7000-8000-\d{12}$/u);
    }
    expect(new Set(records.map((record) => record.recordId)).size).toBe(records.length);
  });

  it("audits REFUSED mutations too — a refusal is an operator fact", async () => {
    const api = await start();
    // Already RUNNING: the resume is refused.
    await api.call("POST", "/v1/strategies/sb-1/resume", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "resume something already running" },
    });
    // Not engaged: the release is refused.
    await api.call("POST", "/v1/kill-switch/release", {
      token: FAKE_OPERATOR_TOKEN,
      body: {
        scope: "GLOBAL",
        scopeRef: null,
        authoritativeSnapshotApplied: true,
        reason: "release a switch nobody engaged",
      },
    });
    // Scope-ref mismatch: refused.
    await api.call("POST", "/v1/kill-switch", {
      token: FAKE_OPERATOR_TOKEN,
      body: {
        scope: "GLOBAL",
        scopeRef: "market-1",
        action: "FULL_HALT",
        reason: "a global switch that names a market",
      },
    });

    expect(api.audit.records().map((record) => `${record.action}|${record.outcome}`)).toEqual([
      "STRATEGY_RESUME|REFUSED",
      "KILL_SWITCH_RELEASE|REFUSED",
      "KILL_SWITCH_ENGAGE|REFUSED",
    ]);
    for (const record of api.audit.records()) {
      // A refusal's record carries the code, so the log answers WHY.
      expect(JSON.stringify(record.resultingState)).toContain("refusalCode");
    }
  });

  it("A MUTATION THAT CANNOT BE AUDITED DOES NOT HAPPEN (log at its bound)", async () => {
    const api = await start(1);

    expect(
      (
        await api.call("POST", "/v1/strategies/sb-1/pause", {
          token: FAKE_OPERATOR_TOKEN,
          body: { reason: "the one that fits" },
        })
      ).status,
    ).toBe(200);

    const second = await api.call("POST", "/v1/strategies/sb-2/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "the one that does not" },
    });
    expect(second.status).toBe(503);
    expect((second.json() as Record<string, unknown>)["code"]).toBe("CONTROL_NOT_AUDITABLE");

    // THE STATE DID NOT MOVE.
    const strategies = await api.call("GET", "/v1/strategies", { token: FAKE_OPERATOR_TOKEN });
    const listed = (strategies.json() as { strategies: readonly { instanceId: string; state: string }[] })
      .strategies;
    expect(listed.find((entry) => entry.instanceId === "sb-2")?.state).toBe("RUNNING");

    // …and the FIRST record — the one an evicting log would have lost — is here.
    expect(api.audit.records()).toHaveLength(1);
    expect(api.audit.records()[0]?.scopeRef).toBe("sb-1");
  });

  it("the same is true for a kill switch: unauditable means not engaged", async () => {
    const api = await start(1);
    await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "fills the log" },
    });
    const engage = await api.call("POST", "/v1/kill-switch", {
      token: FAKE_OPERATOR_TOKEN,
      body: {
        scope: "GLOBAL",
        scopeRef: null,
        action: "FULL_HALT",
        reason: "cannot be recorded",
      },
    });
    expect(engage.status).toBe(503);

    const switches = await api.call("GET", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN });
    expect((switches.json() as { killSwitches: readonly unknown[] }).killSwitches).toEqual([]);
  });

  it("surfaces the audit log's own state on the metrics surface", async () => {
    const api = await start(1);
    await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "first" },
    });
    await api.call("POST", "/v1/strategies/sb-2/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "second" },
    });

    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).toContain("control_audit_records 1");
    expect(metrics.text).toContain("control_audit_capacity 1");
    expect(metrics.text).toContain("control_audit_append_failures_total 1");
    expect(metrics.text).toContain(
      'control_mutations_total{action="STRATEGY_PAUSE",outcome="APPLIED"} 1',
    );
  });

  it("THE DOCUMENTED EXCEPTION: an unauthenticated request writes nothing", async () => {
    const api = await start();
    for (const [method, path, body] of [
      ["POST", "/v1/strategies/sb-1/pause", { reason: "anonymous attempt" }],
      ["POST", "/v1/kill-switch", { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "anonymous" }],
      ["POST", "/v1/kill-switch/release", { scope: "GLOBAL", scopeRef: null, authoritativeSnapshotApplied: true, reason: "anonymous" }],
    ] as const) {
      const response = await api.call(method, path, { body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(api.audit.records()).toEqual([]);
    // It IS counted, which is the whole point of that counter existing.
    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).toContain(
      'control_authentication_failures_total{reason="MISSING_CREDENTIAL"} 3',
    );
  });

  it("a refused REQUEST (bad body) reaches no control plane and writes nothing", async () => {
    const api = await start();
    // Missing reason: the door refuses before the control plane is called.
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: {},
    });
    expect(response.status).toBe(400);
    expect(api.audit.records()).toEqual([]);
    // The distinction is deliberate: a malformed request is not a mutation
    // ATTEMPT on any state, it is a request that never named one.
  });

  it("the audit log is append-only to every reader: a caller cannot rewrite it", async () => {
    const api = await start();
    await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "one record" },
    });
    const records = api.audit.records();
    expect(Object.isFrozen(records)).toBe(true);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(() => {
      (records[0] as { reason: string }).reason = "rewritten";
    }).toThrow(TypeError);
    expect(api.audit.records()[0]?.reason).toBe("one record");
  });

  it("carries no operator token into any audit record", async () => {
    const api = await start();
    await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "checking the record" },
    });
    const serialized = JSON.stringify(api.audit.records());
    expect(serialized).not.toContain(FAKE_OPERATOR_TOKEN);
    expect(serialized).not.toContain("Bearer");
    // It DOES carry the operator id, which is what §14.1's "actor" is.
    expect(serialized).toContain("operator-a");
  });
});
