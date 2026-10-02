/**
 * `CONTROL-1b` over REAL HTTP: the durable-audit-sink prerequisites
 * (`docs/handoffs/CONTROL-1.md` follow-up 3) and the kill-switch lock key
 * (`CONTROL1-R2-J-L2`), through the real server, API, control plane, audit
 * budget and append-only log.
 *
 * - **3a, the append bound.** A sink that stalls is answered `503
 *   CONTROL_NOT_AUDITABLE` within the bound, the switch is not engaged, and an
 *   APPLIED record that lands afterwards is VOIDED — never applied. Since
 *   `CONTROL-1b` r1 (`CONTROL1B-R1-J-M1`), retrying that halt while its append
 *   is unsettled is refused WITHOUT an append, so the retries cannot spend the
 *   kill-switch reserve, and once the sink answers the halt engages.
 * - **3b, bounded mode-raise records.** An 8 KiB path and fifty key spellings
 *   write a record of the same size as any other refusal's.
 * - **3c, refusal bytes.** The joint INFO `CONTROL1-R2-J-I2` reproduced: an
 *   unknown body key holding NUL and U+202E is refused `400`, and its audited
 *   record holds visible escapes, never the bytes `jsonb` refuses.
 *
 * The characters under test are built from code points, so this file holds
 * none of them raw.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTROL_PLANE_VOID_ACTOR,
  REFUSAL_AUDIT_MAX_ISSUES,
  REFUSAL_AUDIT_MAX_TEXT,
} from "@polymarket-bot/control-api";
import { FAKE_OPERATOR_TOKEN } from "@polymarket-bot/control-api/testing";
import type { AuditAppendResult, ControlAuditRecord, InMemoryControlAuditLog } from "@polymarket-bot/observability";

import { serveControlApi, type ServeOptions, type ServedApi } from "./support/client.js";

const NUL = String.fromCodePoint(0);
const RLO = String.fromCodePoint(0x202e);

const OPERATOR = { operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] } as const;

const served: ServedApi[] = [];
async function start(options: ServeOptions = {}): Promise<ServedApi> {
  const api = await serveControlApi({ operators: [OPERATOR], ...options });
  served.push(api);
  return api;
}
afterEach(async () => {
  for (const api of served.splice(0)) await api.server.close();
});

function documentOf(record: ControlAuditRecord | undefined): Record<string, unknown> {
  return (record?.resultingState ?? {}) as Record<string, unknown>;
}

describe("CONTROL-1b 3c over HTTP: refusal bytes are safe for jsonb (CONTROL1-R2-J-I2)", () => {
  it("an unknown key holding NUL and U+202E is refused 400, and its record holds escapes — no NUL, no U+202E", async () => {
    const api = await start();
    const key = `${NUL}k${RLO}`;
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "ok reason", [key]: 1 },
    });
    expect(response.status).toBe(400);
    // The caller is told its own bytes back; the AUDIT holds their escapes.
    expect(response.text).toContain("\\u0000k");
    const record = api.audit.records().at(-1);
    expect(record).toMatchObject({ action: "STRATEGY_PAUSE", outcome: "REFUSED", scopeRef: "sb-1" });
    const issues = documentOf(record)["refusalIssues"] as readonly string[];
    expect(issues.some((issue) => issue.includes("\\u{0}k\\u{202E}")), JSON.stringify(issues)).toBe(true);
    const stored = JSON.stringify(record);
    expect(stored).not.toContain("\\u0000");
    expect(stored.includes(NUL) || stored.includes(RLO)).toBe(false);
  });

  it("an APPLIED engage whose reason and scopeRef hold the same bytes is applied; its record is escaped, its state is the operator's", async () => {
    const api = await start();
    const response = await api.call("POST", "/v1/kill-switch", {
      token: FAKE_OPERATOR_TOKEN,
      body: { scope: "MARKET", scopeRef: `m${RLO}1`, action: "FULL_HALT", reason: `halt${NUL}now` },
    });
    expect(response.status).toBe(200);
    expect(api.controlPlane.killSwitches()[0]).toMatchObject({ scopeRef: `m${RLO}1`, reason: `halt${NUL}now` });
    expect(api.audit.records().at(-1)).toMatchObject({
      outcome: "APPLIED",
      scopeRef: "m\\u{202E}1",
      reason: "halt\\u{0}now",
    });
  });
});

describe("CONTROL-1b 3b over HTTP: a mode-raise attempt's record is bounded", () => {
  it("an 8 KiB path and fifty spellings of runMode write a record no larger than any refusal's", async () => {
    const api = await start();
    const body: Record<string, unknown> = { reason: "ok reason" };
    for (let mask = 0; mask < 50; mask += 1) {
      body[[..."runmode"].map((c, index) => ((mask >> index) & 1 ? c.toUpperCase() : c)).join("")] = "LIVE";
    }
    const response = await api.call("POST", `/v1/${"p".repeat(8_192)}`, { token: FAKE_OPERATOR_TOKEN, body });
    expect(response.status).toBe(403);
    const record = api.audit.records().at(-1);
    expect(record?.action).toBe("MODE_RAISE_ATTEMPT");
    expect(record?.reason.length).toBeLessThanOrEqual(REFUSAL_AUDIT_MAX_TEXT);
    expect(record?.reason).toContain(` and ${String(50 - REFUSAL_AUDIT_MAX_ISSUES)} more`);
    expect(documentOf(record)["attemptedKeys"]).toHaveLength(REFUSAL_AUDIT_MAX_ISSUES);
    expect(documentOf(record)["attemptedKeyCount"]).toBe("50");
    expect(JSON.stringify(record).length).toBeLessThan(2_048);
  });
});

/** An inner sink that holds APPLIED records while `stalling`, and lands them on `land()`. */
function stallingInner(): {
  readonly wrap: (log: InMemoryControlAuditLog) => { append(record: ControlAuditRecord): Promise<AuditAppendResult> };
  stalling: boolean;
  land(): void;
} {
  const held: (() => void)[] = [];
  const control = {
    stalling: true,
    wrap: (log: InMemoryControlAuditLog) => ({
      append: (record: ControlAuditRecord): Promise<AuditAppendResult> =>
        control.stalling && record.outcome === "APPLIED"
          ? new Promise<AuditAppendResult>((resolve) => {
              held.push(() => {
                void log.append(record).then(resolve);
              });
            })
          : log.append(record),
    }),
    land: () => {
      for (const settle of held.splice(0)) settle();
    },
  };
  return control;
}

describe("CONTROL-1b 3a over HTTP: an audit append is bounded", () => {
  it("a stalled sink: the engage is 503 within the bound, nothing is engaged, and the record that lands late is VOIDED", async () => {
    const inner = stallingInner();
    const api = await start({ auditInner: inner.wrap, auditAppendTimeoutMs: 100, auditCapacity: 16, auditSafetyReserve: 2 });
    const halt = { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "halt now" };
    const started = Date.now();
    const refused = await api.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: halt });
    expect(refused.status).toBe(503);
    expect((refused.json() as Record<string, unknown>)["code"]).toBe("CONTROL_NOT_AUDITABLE");
    expect(Date.now() - started).toBeLessThan(5_000);
    const listed = await api.call("GET", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN });
    expect((listed.json() as { killSwitches: unknown[] }).killSwitches).toEqual([]);

    inner.land();
    await vi.waitFor(() => {
      expect(api.audit.records()).toHaveLength(2);
    });
    const [late, voided] = api.audit.records();
    expect(late).toMatchObject({ action: "KILL_SWITCH_ENGAGE", outcome: "APPLIED" });
    expect(voided).toMatchObject({ action: "KILL_SWITCH_ENGAGE", outcome: "REFUSED", actor: CONTROL_PLANE_VOID_ACTOR });
    expect(documentOf(voided)["voidsRecordId"]).toBe(late?.recordId);
    const still = await api.call("GET", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN });
    expect((still.json() as { killSwitches: unknown[] }).killSwitches).toEqual([]);

    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="NOT_AUDITED"} 1');
    expect(metrics.text).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="LANDED_LATE"} 1');
    expect(metrics.text).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="VOIDED"} 1');

    // The sink recovers: the same halt is applied, once, and is in force.
    inner.stalling = false;
    const applied = await api.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: halt });
    expect(applied.status).toBe(200);
    const engaged = await api.call("GET", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN });
    expect((engaged.json() as { killSwitches: { action: string }[] }).killSwitches.map((entry) => entry.action)).toEqual([
      "FULL_HALT",
    ]);
  });
});

describe("CONTROL-1b r1 (CONTROL1B-R1-J-M1) over HTTP: retrying a stalled halt cannot spend the reserve", () => {
  it("the verifiers' reproduction: five GLOBAL FULL_HALTs through a stall offer ONE append; once the sink answers, the halt is 200 and in force", async () => {
    // C = 10, R = 2, six ordinary records first — the joint report's setup.
    const inner = stallingInner();
    inner.stalling = false;
    const api = await start({ auditInner: inner.wrap, auditAppendTimeoutMs: 100, auditCapacity: 10, auditSafetyReserve: 2 });
    for (let index = 0; index < 6; index += 1) {
      const refused = await api.call("POST", `/v1/strategies/ghost-${String(index)}/pause`, {
        token: FAKE_OPERATOR_TOKEN,
        body: { reason: "fill the ordinary tier" },
      });
      expect((refused.json() as Record<string, unknown>)["code"]).toBe("CONTROL_UNKNOWN_INSTANCE");
    }
    expect(api.auditBudget.admitted).toBe(6);

    inner.stalling = true;
    const halt = { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "halt now" };
    const details: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await api.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: halt });
      expect(refused.status, `attempt ${String(attempt)}`).toBe(503);
      details.push(String((refused.json() as Record<string, unknown>)["detail"]));
    }
    expect(details[0]).toContain("100 ms append bound");
    for (const detail of details.slice(1)) expect(detail).toContain("is UNSETTLED");

    inner.stalling = false;
    inner.land();
    await vi.waitFor(() => {
      expect(api.controlPlane.unsettledAuditAppends).toBe(0);
    });
    // One late APPLIED record landed (and its void, ordinary, was refused: the tier is full).
    expect(api.audit.records().filter((record) => record.outcome === "APPLIED")).toHaveLength(1);
    expect(api.auditBudget.admitted).toBe(7);

    // At round 0 four late records filled the reserve and this was 503.
    const applied = await api.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: halt });
    expect(applied.status).toBe(200);
    const engaged = await api.call("GET", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN });
    expect((engaged.json() as { killSwitches: { action: string }[] }).killSwitches.map((entry) => entry.action)).toEqual([
      "FULL_HALT",
    ]);
    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="NOT_AUDITED"} 5');
    expect(metrics.text).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="LANDED_LATE"} 1');
    expect(metrics.text).toContain("control_audit_append_failures_total 1");
  });
});

describe("CONTROL-1b (CONTROL1-R2-J-L2) over HTTP: operations on one switch serialize", () => {
  /**
   * A durable-shaped inner sink: every append settles 25 ms later — long enough
   * that two requests sent together over the socket really do overlap inside
   * the control plane (at 2 ms they mostly did not, and a release with its own
   * lock went unseen over HTTP; the unit pins are the deterministic ones).
   */
  const slow = (log: InMemoryControlAuditLog) => ({
    append: (record: ControlAuditRecord): Promise<AuditAppendResult> =>
      new Promise((resolve) => {
        setTimeout(() => {
          void log.append(record).then(resolve);
        }, 25);
      }),
  });

  it("two different engages sent together: every APPLIED engage's prior is the state the previous one left", async () => {
    const api = await start({ auditInner: slow, auditCapacity: 256 });
    for (let round = 0; round < 8; round += 1) {
      const target = { scope: "MARKET", scopeRef: `s-${String(round)}` };
      const statuses = await Promise.all(
        (["FULL_HALT", "HALT_NEW_ENTRIES"] as const).map(async (action) =>
          (await api.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: { ...target, action, reason: "race" } })).status,
        ),
      );
      // FULL_HALT first: one 200 and one 409 (would weaken). The other order: two 200s.
      expect([[200, 409], [200, 200]]).toContainEqual(statuses);
      const applied = api.audit
        .records()
        .filter((record) => record.scopeRef === target.scopeRef && record.outcome === "APPLIED");
      const priors = applied.map((record) => (record.priorState as Record<string, unknown>)["engaged"]);
      // Serialized, at most the FIRST applied engage found no switch.
      expect(priors.filter((engaged) => engaged === "false"), JSON.stringify(priors)).toHaveLength(1);
      expect(
        api.controlPlane.killSwitches().find((entry) => entry.scopeRef === target.scopeRef)?.action,
      ).toBe("FULL_HALT");
    }
  });

  it("an escalation and a release sent together: the release's record names the switch it really released", async () => {
    const api = await start({ auditInner: slow, auditCapacity: 256 });
    for (let round = 0; round < 8; round += 1) {
      const target = { scope: "MARKET", scopeRef: `r-${String(round)}` };
      await api.call("POST", "/v1/kill-switch", {
        token: FAKE_OPERATOR_TOKEN,
        body: { ...target, action: "HALT_NEW_ENTRIES", reason: "first" },
      });
      const answers = await Promise.all([
        api.call("POST", "/v1/kill-switch", {
          token: FAKE_OPERATOR_TOKEN,
          body: { ...target, action: "FULL_HALT", reason: "escalate" },
        }),
        api.call("POST", "/v1/kill-switch/release", {
          token: FAKE_OPERATOR_TOKEN,
          body: { ...target, authoritativeSnapshotApplied: true, reason: "reconciled" },
        }),
      ]);
      // Both are served in either order: the race is real only if both act.
      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      const records = api.audit.records().filter((record) => record.scopeRef === target.scopeRef && record.outcome === "APPLIED");
      // Replaying the APPLIED records in order reproduces every prior they claim.
      let state: string | undefined;
      for (const record of records) {
        const prior = record.priorState as Record<string, unknown>;
        expect(prior["engaged"] === "true" ? prior["action"] : undefined, JSON.stringify(record)).toBe(state);
        state = record.action === "KILL_SWITCH_RELEASE" ? undefined : String((record.resultingState as Record<string, unknown>)["action"]);
      }
      expect(api.controlPlane.killSwitches().find((entry) => entry.scopeRef === target.scopeRef)?.action).toBe(state);
    }
  });
});
