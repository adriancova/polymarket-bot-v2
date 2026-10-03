/**
 * `CONTROL-1` r1 — `CONTROL1-J-M2`: an AUTHORIZED operator's refusal is
 * audited, wherever before the control plane it happens. Over REAL HTTP.
 *
 * ## The finding (both verifiers, reproduced at round-0 commit `3097d39`)
 *
 * With a healthy, empty log, an operator holding every grant was refused —
 * and NOTHING was written — for: a release with `authoritativeSnapshotApplied:
 * false` or without it (the schema's literal `true`, so the control plane's own
 * audited `CONTROL_RELEASE_EVIDENCE_MISSING` was unreachable over HTTP); an
 * engage with no reason, or a reason under three characters; a body field of
 * the wrong type; an `a%2Fb` route parameter; malformed JSON; an undeclared
 * body (`415`); an oversized one (`413`). The `415` was a REGRESSION of round
 * 0's L-3: at base `98a814b` an undeclared body reached the plane and was
 * audited — including a `text/plain` `{"runMode":"LIVE"}`, refused by name.
 *
 * ## What this file pins
 *
 * 1. Every one of those refusals, from an authorized operator, writes exactly
 *    ONE `REFUSED` record for the route's action, changes nothing, and answers
 *    the same status and code as before.
 * 2. The M-3 boundary is unmoved: the same requests from an anonymous caller,
 *    a READ-only operator, or an operator lacking the ROUTE's grant write
 *    nothing.
 * 3. A full ordinary tier leaves each refusal standing, counted `NOT_AUDITED`.
 * 4. An undeclared body naming a forbidden key is refused BY NAME again
 *    (`403`), audited for a mutation-grant holder and counted for a reader.
 * 5. `CONTROL-1b` r2 (closing `CONTROL1B-R2-J-L1`): the ONE authorized
 *    refusal that writes nothing — the control plane's GATED refusal, a
 *    protected mutation of a switch whose earlier protected append is still
 *    unsettled — offers no record, is counted `NOT_AUDITED`, and the README
 *    names it as write-nothing item 7 where it says every authorized refusal
 *    is audited.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FAKE_OPERATOR_TOKEN, FAKE_READER_TOKEN } from "@polymarket-bot/control-api/testing";
import type { AuditAppendResult, ControlAuditRecord, InMemoryControlAuditLog } from "@polymarket-bot/observability";

import { serveControlApi, type CallOptions, type ServedApi } from "./support/client.js";

// Read as TEXT, and spelled as `example-config-and-startup.test.ts` spells it
// (`CONTROL-1b` r3: a literal PATH to a file acceptance 3 does not read as code fails it).
const README = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "apps/control-api/README.md");

const STRATEGIST_TOKEN = "fake-paper-strategist-token-not-a-credential-r1-0003";

const OPERATORS = [
  {
    operatorId: "operator-a",
    token: FAKE_OPERATOR_TOKEN,
    grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] as const,
  },
  { operatorId: "reader-b", token: FAKE_READER_TOKEN, grants: ["READ"] as const },
  { operatorId: "strategist-c", token: STRATEGIST_TOKEN, grants: ["READ", "STRATEGY_CONTROL"] as const },
];

let served: ServedApi | undefined;

afterEach(async () => {
  await served?.server.close();
  served = undefined;
});

async function start(options: { auditCapacity?: number; auditSafetyReserve?: number } = {}): Promise<ServedApi> {
  served = await serveControlApi({ operators: OPERATORS, maxRequestBodyBytes: 512, ...options });
  served.controlPlane.register("sb-1", "2026-10-01T00:00:00.000Z");
  // A switch to release, so a release refusal is not merely "nothing engaged".
  await served.controlPlane.engageKillSwitch(
    { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" },
    {
      actor: "operator-a",
      at: "2026-10-01T00:00:00.000Z",
      auditRecordId: "01930000-0000-7000-8000-ffffffffffff",
      reason: "the switch the release cases try to release",
    },
  );
  return served;
}

const RELEASE = { scope: "GLOBAL", scopeRef: null, authoritativeSnapshotApplied: true, reason: "reconciled" };
const ENGAGE = { scope: "MARKET", scopeRef: "market-1", action: "FULL_HALT", reason: "incident" };

interface Case {
  readonly name: string;
  readonly path: string;
  readonly options: Omit<CallOptions, "token">;
  readonly status: number;
  readonly code: string;
  readonly action: string;
  readonly scope: string;
  readonly scopeRef: string | null;
  readonly stage: string;
}

/** Every refusal the verifiers measured as unaudited, from an AUTHORIZED operator. */
const CASES: readonly Case[] = [
  {
    name: "release with authoritativeSnapshotApplied: false",
    path: "/v1/kill-switch/release",
    options: { body: { ...RELEASE, authoritativeSnapshotApplied: false } },
    status: 400,
    code: "CONTROL_REQUEST_INVALID",
    action: "KILL_SWITCH_RELEASE",
    scope: "CONTROL_PLANE",
    scopeRef: null,
    stage: "REQUEST_BODY",
  },
  {
    name: "release with no evidence field",
    path: "/v1/kill-switch/release",
    options: { body: { scope: "GLOBAL", scopeRef: null, reason: "no evidence" } },
    status: 400,
    code: "CONTROL_REQUEST_INVALID",
    action: "KILL_SWITCH_RELEASE",
    scope: "CONTROL_PLANE",
    scopeRef: null,
    stage: "REQUEST_BODY",
  },
  {
    name: "engage with no reason",
    path: "/v1/kill-switch",
    options: { body: { scope: "MARKET", scopeRef: "market-1", action: "FULL_HALT" } },
    status: 400,
    code: "CONTROL_REQUEST_INVALID",
    action: "KILL_SWITCH_ENGAGE",
    scope: "CONTROL_PLANE",
    scopeRef: null,
    stage: "REQUEST_BODY",
  },
  {
    name: "engage with a one-character reason",
    path: "/v1/kill-switch",
    options: { body: { ...ENGAGE, reason: "x" } },
    status: 400,
    code: "CONTROL_REQUEST_INVALID",
    action: "KILL_SWITCH_ENGAGE",
    scope: "CONTROL_PLANE",
    scopeRef: null,
    stage: "REQUEST_BODY",
  },
  {
    name: "pause with a reason of the wrong type",
    path: "/v1/strategies/sb-1/pause",
    options: { body: { reason: 42 } },
    status: 400,
    code: "CONTROL_REQUEST_INVALID",
    action: "STRATEGY_PAUSE",
    scope: "STRATEGY_INSTANCE",
    scopeRef: "sb-1",
    stage: "REQUEST_BODY",
  },
  {
    name: "pause of a%2Fb",
    path: "/v1/strategies/a%2Fb/pause",
    options: { body: { reason: "slash" } },
    status: 400,
    code: "CONTROL_INVALID_ROUTE_PARAMETER",
    action: "STRATEGY_PAUSE",
    scope: "STRATEGY_INSTANCE",
    scopeRef: null,
    stage: "ROUTE_PARAMETER",
  },
  {
    name: "resume with a malformed escape",
    path: "/v1/strategies/%E0%A4%A/resume",
    options: { body: { reason: "malformed" } },
    status: 400,
    code: "CONTROL_INVALID_ROUTE_PARAMETER",
    action: "STRATEGY_RESUME",
    scope: "STRATEGY_INSTANCE",
    scopeRef: null,
    stage: "ROUTE_PARAMETER",
  },
  {
    name: "engage with malformed JSON",
    path: "/v1/kill-switch",
    options: { rawBody: '{"scope":' },
    status: 400,
    code: "CONTROL_BODY_NOT_JSON",
    action: "KILL_SWITCH_ENGAGE",
    scope: "CONTROL_PLANE",
    scopeRef: null,
    stage: "TRANSPORT",
  },
  {
    name: "engage declared text/plain",
    path: "/v1/kill-switch",
    options: { body: ENGAGE, contentType: "text/plain" },
    status: 415,
    code: "CONTROL_UNSUPPORTED_MEDIA_TYPE",
    action: "KILL_SWITCH_ENGAGE",
    scope: "CONTROL_PLANE",
    scopeRef: null,
    stage: "TRANSPORT",
  },
  {
    name: "release with no content type",
    path: "/v1/kill-switch/release",
    options: { body: RELEASE, contentType: null },
    status: 415,
    code: "CONTROL_UNSUPPORTED_MEDIA_TYPE",
    action: "KILL_SWITCH_RELEASE",
    scope: "CONTROL_PLANE",
    scopeRef: null,
    stage: "TRANSPORT",
  },
  {
    name: "pause with an oversized body",
    path: "/v1/strategies/sb-1/pause",
    options: { rawBody: JSON.stringify({ reason: "x".repeat(2048) }) },
    status: 413,
    code: "CONTROL_BODY_TOO_LARGE",
    action: "STRATEGY_PAUSE",
    scope: "STRATEGY_INSTANCE",
    scopeRef: "sb-1",
    stage: "TRANSPORT",
  },
];

function stateOf(api: ServedApi): string {
  return JSON.stringify({ strategies: api.controlPlane.strategies(), killSwitches: api.controlPlane.killSwitches() });
}

describe("CONTROL1-J-M2: every refusal of an AUTHORIZED request to a mutating route is audited — save write-nothing item 7, the GATED refusal (below)", () => {
  it.each(CASES)("$name → $status $code, ONE REFUSED $action record, nothing changed", async (testCase) => {
    const api = await start();
    const before = stateOf(api);
    const recordsBefore = api.audit.records().length;

    const response = await api.call("POST", testCase.path, { token: FAKE_OPERATOR_TOKEN, ...testCase.options });

    expect(response.status).toBe(testCase.status);
    expect((response.json() as Record<string, unknown>)["code"]).toBe(testCase.code);
    expect(stateOf(api)).toBe(before);
    const appended = api.audit.records().slice(recordsBefore);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      action: testCase.action,
      outcome: "REFUSED",
      actor: "operator-a",
      actorKind: "HUMAN",
      scope: testCase.scope,
      scopeRef: testCase.scopeRef,
      priorState: { refusedAt: testCase.stage, stateRead: "false" },
      resultingState: { refusedAt: testCase.stage, stateRead: "false", refusalCode: testCase.code },
    });
    // The reason names the route's TEMPLATE and the code — nothing the caller spelled.
    expect(appended[0]?.reason).toContain(`(${testCase.code})`);
    expect(appended[0]?.reason).not.toContain("%");
  });

  it("the release-without-evidence record NAMES the missing evidence (the plane's own check is unreachable over HTTP)", async () => {
    const api = await start();
    await api.call("POST", "/v1/kill-switch/release", {
      token: FAKE_OPERATOR_TOKEN,
      body: { ...RELEASE, authoritativeSnapshotApplied: false },
    });
    const record = api.audit.records().at(-1);
    expect(record?.action).toBe("KILL_SWITCH_RELEASE");
    const issues = (record?.resultingState as Record<string, unknown>)["refusalIssues"] as readonly string[];
    expect(issues.some((issue) => issue.startsWith("authoritativeSnapshotApplied"))).toBe(true);
    expect(api.controlPlane.killSwitches()).toHaveLength(1);
  });

  it("the record keeps a BOUNDED prefix of the issues, whatever the body carried", async () => {
    const api = await start();
    const crowded: Record<string, unknown> = { reason: "ok reason" };
    for (let index = 0; index < 30; index += 1) crowded[`k${String(index)}`] = index;
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", { token: FAKE_OPERATOR_TOKEN, body: crowded });
    expect(response.status).toBe(400);
    const document = api.audit.records().at(-1)?.resultingState as Record<string, unknown>;
    const issues = document["refusalIssues"] as readonly string[];
    expect(issues.length).toBeLessThanOrEqual(8);
    for (const issue of issues) expect(issue.length).toBeLessThanOrEqual(256);
    expect(typeof document["refusalIssueCount"]).toBe("string");
  });
});

describe("the M-3 boundary is unmoved: callers without the route's mutation grant write nothing", () => {
  it.each([
    ["an anonymous caller", undefined, 401],
    ["a READ-only operator", FAKE_READER_TOKEN, 403],
  ] as const)("%s, sending every case above, writes no record", async (_who, token, status) => {
    const api = await start();
    const recordsBefore = api.audit.records().length;
    for (const testCase of CASES) {
      const response = await api.call("POST", testCase.path, {
        ...(token === undefined ? {} : { token }),
        ...testCase.options,
      });
      // Authentication and authorization answer FIRST — the body's fate is not
      // disclosed to a caller who may not send it.
      expect(response.status, testCase.name).toBe(status);
    }
    expect(api.audit.records()).toHaveLength(recordsBefore);
  });

  it("an operator holding STRATEGY_CONTROL but not KILL_SWITCH is refused the kill-switch routes unaudited", async () => {
    const api = await start();
    const recordsBefore = api.audit.records().length;
    for (const testCase of CASES.filter((entry) => entry.path.startsWith("/v1/kill-switch"))) {
      const response = await api.call("POST", testCase.path, { token: STRATEGIST_TOKEN, ...testCase.options });
      expect(response.status, testCase.name).toBe(403);
      expect((response.json() as Record<string, unknown>)["code"], testCase.name).toBe("CONTROL_UNAUTHORIZED");
    }
    expect(api.audit.records()).toHaveLength(recordsBefore);
  });

  it("a READ route's transport refusal is answered after authorization and NOT audited", async () => {
    const api = await start();
    const recordsBefore = api.audit.records().length;
    const response = await api.call("GET", "/v1/run-state", {
      token: FAKE_OPERATOR_TOKEN,
      rawBody: "{}",
      contentType: "text/plain",
    });
    expect(response.status).toBe(415);
    expect(api.audit.records()).toHaveLength(recordsBefore);
    const anonymous = await api.call("GET", "/v1/run-state", { rawBody: "{}", contentType: "text/plain" });
    expect(anonymous.status).toBe(401);
  });
});

describe("a full ordinary tier: the refusal stands, counted NOT_AUDITED", () => {
  it("every case still answers its own status once the ordinary tier is full, and the metric says so", async () => {
    // Capacity 5, reserve 2: the ordinary tier is 1 record — the setup engage
    // fills it.
    const api = await start({ auditCapacity: 5, auditSafetyReserve: 2 });
    expect(api.audit.records()).toHaveLength(1);
    for (const testCase of CASES) {
      const response = await api.call("POST", testCase.path, { token: FAKE_OPERATOR_TOKEN, ...testCase.options });
      expect(response.status, testCase.name).toBe(testCase.status);
    }
    expect(api.audit.records()).toHaveLength(1);
    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="NOT_AUDITED"} 4');
    expect(metrics.text).toContain('control_mutations_total{action="KILL_SWITCH_RELEASE",outcome="NOT_AUDITED"} 3');
    expect(metrics.text).toContain('control_mutations_total{action="STRATEGY_PAUSE",outcome="NOT_AUDITED"} 3');
    expect(metrics.text).toContain('control_mutations_total{action="STRATEGY_RESUME",outcome="NOT_AUDITED"} 1');
    // …and the reserve is untouched: a new switch still engages.
    const engage = await api.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: ENGAGE });
    expect(engage.status).toBe(200);
  });
});

describe("an undeclared body naming a forbidden key is refused BY NAME again (the L-3 regression)", () => {
  it("a mutation-grant holder's text/plain {runMode} is 403 CONTROL_MODE_RAISE_REFUSED, audited and counted", async () => {
    const api = await start();
    const recordsBefore = api.audit.records().length;
    const response = await api.call("POST", "/v1/kill-switch", {
      token: STRATEGIST_TOKEN,
      rawBody: JSON.stringify({ runMode: "LIVE" }),
      contentType: "text/plain",
    });
    expect(response.status).toBe(403);
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_MODE_RAISE_REFUSED");
    expect(api.audit.records().slice(recordsBefore).map((record) => `${record.actor}|${record.action}|${record.outcome}`)).toEqual([
      "strategist-c|MODE_RAISE_ATTEMPT|REFUSED",
    ]);
    expect(api.controlPlane.modeRaiseAttemptsRefused).toBe(1);
  });

  it("a reader's, with no content type, is 403 by name and COUNTED, but writes nothing", async () => {
    const api = await start();
    const recordsBefore = api.audit.records().length;
    const response = await api.call("POST", "/v1/kill-switch", {
      token: FAKE_READER_TOKEN,
      rawBody: JSON.stringify({ config: { allowRealOrders: true } }),
      contentType: null,
    });
    expect(response.status).toBe(403);
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_MODE_RAISE_REFUSED");
    expect(api.audit.records()).toHaveLength(recordsBefore);
    expect(api.controlPlane.modeRaiseAttemptsRefused).toBe(1);
  });

  it("an undeclared body is never ACTED on, even when it parses and names nothing forbidden", async () => {
    const api = await start();
    const response = await api.call("POST", "/v1/kill-switch", {
      token: FAKE_OPERATOR_TOKEN,
      body: ENGAGE,
      contentType: "text/plain",
    });
    expect(response.status).toBe(415);
    expect(api.controlPlane.killSwitches().map((entry) => entry.scope)).toEqual(["GLOBAL"]);
  });
});

describe("CONTROL1B-R2-J-L1: write-nothing item 7 — the GATED refusal offers no record, and the README says so", () => {
  /** An inner sink that holds every APPLIED record unanswered until released, and counts every record it is OFFERED. */
  function stalledInner(): {
    readonly wrap: (log: InMemoryControlAuditLog) => { append(record: ControlAuditRecord): Promise<AuditAppendResult> };
    offered: number;
    stalling: boolean;
    release(): void;
  } {
    const held: (() => void)[] = [];
    const control = {
      offered: 0,
      stalling: true,
      wrap: (log: InMemoryControlAuditLog) => ({
        append: (record: ControlAuditRecord): Promise<AuditAppendResult> => {
          control.offered += 1;
          return control.stalling && record.outcome === "APPLIED"
            ? new Promise<AuditAppendResult>((resolveAppend) => {
                held.push(() => {
                  void log.append(record).then(resolveAppend);
                });
              })
            : log.append(record);
        },
      }),
      release: () => {
        control.stalling = false;
        for (const settle of held.splice(0)) settle();
      },
    };
    return control;
  }

  it("an authorized operator's retried halt, while its first append is unsettled: 503, NOTHING offered, counted NOT_AUDITED and not as an append failure", async () => {
    const inner = stalledInner();
    served = await serveControlApi({ operators: OPERATORS, auditInner: inner.wrap, auditAppendTimeoutMs: 50, auditCapacity: 16, auditSafetyReserve: 2 });
    const halt = { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "halt now" };
    const first = await served.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: halt });
    expect(first.status).toBe(503);
    expect(inner.offered).toBe(1);
    const recordsBefore = served.audit.records().length;

    const gated = await served.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: halt });
    expect(gated.status).toBe(503);
    const body = gated.json() as Record<string, unknown>;
    expect(body["code"]).toBe("CONTROL_NOT_AUDITABLE");
    expect(String(body["detail"])).toContain("WITHOUT an audit append");
    // Write-nothing item 7: no record OFFERED, none written, nothing engaged.
    expect(inner.offered).toBe(1);
    expect(served.audit.records()).toHaveLength(recordsBefore);
    expect(served.controlPlane.killSwitches()).toEqual([]);
    const metrics = await served.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).toContain('control_mutations_total{action="KILL_SWITCH_ENGAGE",outcome="NOT_AUDITED"} 2');
    // Only the FIRST attempt's append failed (by its bound); the gated one attempted none.
    expect(metrics.text).toContain("control_audit_append_failures_total 1");

    // Once the sink answers, the gate lifts and a halt is audited and applied.
    inner.release();
    await vi.waitFor(() => {
      expect(served?.controlPlane.unsettledAuditAppends).toBe(0);
    });
    const applied = await served.call("POST", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN, body: halt });
    expect(applied.status).toBe(200);
  });

  it("the README names the gated refusal as write-nothing item 7, where it says every authorized refusal is audited", () => {
    const readme = readFileSync(README, "utf8");
    const passage = readme.slice(readme.indexOf("REFUSALS are audited too"), readme.indexOf("What writes NOTHING, exhaustively"));
    expect(passage).toContain("save ONE, the gated");
    expect(passage).toContain("item 7 of the list below");
    const list = readme.slice(readme.indexOf("What writes NOTHING, exhaustively"), readme.indexOf("A mutation-grant holder's mode-raise attempt is the one thing"));
    expect(list).toContain("7. **the GATED refusal**");
    expect(list).toContain("WITHOUT offering any record to the sink");
    expect(readme).toContain("None of items 1–6 attempted a mutation");
    expect(readme).not.toContain("None of the six attempted");
  });
});
