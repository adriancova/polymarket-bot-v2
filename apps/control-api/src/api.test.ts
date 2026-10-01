/**
 * The handler seam: the order of operations, the refusals, and the surfaces.
 *
 * These drive the REAL `ControlApi` over the REAL control plane and the REAL
 * append-only audit log. Only the trader health SOURCE is a stand-in, for the
 * reason `health-source.ts` states.
 */

import { describe, expect, it } from "vitest";

import {
  CONTROL_API_ROUTE_TABLE,
  CONTROL_API_ROUTES,
  ControlApi,
  MODE_RAISE_REASON_MAX_PATH,
  MUTATION_GRANTS,
  holdsMutationAuthority,
  type ApiRequest,
  type ApiResponse,
} from "./api.js";
import { OperatorRegistry } from "./auth.js";
import { ControlPlane, REFUSAL_AUDIT_MAX_ISSUES, REFUSAL_AUDIT_MAX_TEXT } from "./control-plane.js";
import { InMemoryTraderHealthSource, TraderHealthCache } from "./health-source.js";
import {
  FAKE_OPERATOR_TOKEN,
  FAKE_READER_TOKEN,
  ScriptedEnvironment,
  bearer,
  createHarness,
  healthDocument,
} from "./testing/index.js";

function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: "GET",
    path: "/v1/run-state",
    authorization: bearer(FAKE_OPERATOR_TOKEN),
    body: undefined,
    ...overrides,
  };
}

function parse(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("the route inventory", () => {
  it("serves exactly the declared routes, and nothing that trades or signs", () => {
    const joined = CONTROL_API_ROUTES.join("\n").toLowerCase();
    for (const forbidden of ["run-mode", "runmode", "signer", "wallet", "order", "submit", "live"]) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
    expect(CONTROL_API_ROUTES).toContain("GET /v1/run-state");
    expect(CONTROL_API_ROUTES).toContain("POST /v1/kill-switch");
  });

  it("CONTROL-1 (L-5): the listed routes ARE the router's — every one dispatches, under its own grant", async () => {
    // The list is derived from the table the router reads, so they cannot
    // disagree; this pins that the table is complete in the other direction —
    // every listed route reaches a handler (never 404/405) — and that each
    // route's grant is the one it enforces.
    expect(CONTROL_API_ROUTES).toEqual(CONTROL_API_ROUTE_TABLE.map((route) => `${route.method} ${route.path}`));
    expect(new Set(CONTROL_API_ROUTES).size).toBe(CONTROL_API_ROUTES.length);
    expect(CONTROL_API_ROUTES).toHaveLength(9);
    for (const route of CONTROL_API_ROUTE_TABLE) {
      const path = route.path.replace(":instanceId", "sb-1");
      const body = route.method === "GET" ? undefined : { reason: "ok reason" };
      const { api, controlPlane } = createHarness({
        operators: [{ operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: [route.grant] }],
      });
      controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
      const allowed = await api.handle(request({ method: route.method, path, body }));
      expect([404, 405, 401, 403], `${route.method} ${route.path}`).not.toContain(allowed.status);

      // …and without that grant the same request is refused 403 UNAUTHORIZED.
      const others = (["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] as const).filter((grant) => grant !== route.grant);
      const denied = createHarness({
        operators: [{ operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: others }],
      });
      const refused = await denied.api.handle(request({ method: route.method, path, body }));
      expect(refused.status, `${route.method} ${route.path} without ${route.grant}`).toBe(403);
      expect(parse(refused)["code"]).toBe("CONTROL_UNAUTHORIZED");
    }
  });

  it("CONTROL-1: the mutation grants are DERIVED from the mutating routes", () => {
    expect(MUTATION_GRANTS).toEqual(["KILL_SWITCH", "STRATEGY_CONTROL"]);
    expect(
      CONTROL_API_ROUTE_TABLE.filter((route) => route.mutates).map((route) => route.method),
    ).toEqual(["POST", "POST", "POST", "POST"]);
    expect(holdsMutationAuthority({ operatorId: "r", grants: ["READ"] })).toBe(false);
    expect(holdsMutationAuthority({ operatorId: "s", grants: ["READ", "STRATEGY_CONTROL"] })).toBe(true);
    expect(holdsMutationAuthority({ operatorId: "k", grants: ["KILL_SWITCH"] })).toBe(true);
  });

  it("CONTROL-1 (L-4): a known path under the wrong method is 405 with Allow; an unknown path is 404", async () => {
    const { api } = createHarness();
    const cases: readonly (readonly [string, string, number, string | undefined])[] = [
      ["POST", "/v1/run-state", 405, "GET"],
      ["DELETE", "/v1/kill-switch", 405, "GET, POST"],
      ["PUT", "/v1/kill-switch", 405, "GET, POST"],
      ["GET", "/v1/kill-switch/release", 405, "POST"],
      ["GET", "/v1/strategies/sb-1/pause", 405, "POST"],
      ["DELETE", "/v1/strategies/sb-1/resume", 405, "POST"],
      ["POST", "/v1/metrics", 405, "GET"],
      ["HEAD", "/v1/health", 405, "GET"],
      ["GET", "/v1/nope", 404, undefined],
      ["POST", "/v1/strategies/sb-1/stop", 404, undefined],
      ["POST", "/v1/strategies//pause", 404, undefined],
      ["GET", "/V1/RUN-STATE", 404, undefined],
      ["GET", "/v1/run-state/", 404, undefined],
    ];
    for (const [method, path, status, allow] of cases) {
      const response = await api.handle(request({ method, path }));
      expect(response.status, `${method} ${path}`).toBe(status);
      expect(response.allow, `${method} ${path}`).toBe(allow);
      expect(parse(response)["code"]).toBe(status === 405 ? "CONTROL_METHOD_NOT_ALLOWED" : "CONTROL_NO_SUCH_ROUTE");
    }
  });

  it("404s an unknown route, naming what it does serve", async () => {
    const { api } = createHarness();
    const response = await api.handle(request({ path: "/v1/nope" }));
    expect(response.status).toBe(404);
    expect(parse(response)["code"]).toBe("CONTROL_NO_SUCH_ROUTE");
    expect(String(parse(response)["detail"])).toContain("nothing that places an order");
  });
});

describe("STEP 1 — authentication happens before anything else", () => {
  it("401s an anonymous request to every route, read or write", async () => {
    const { api, audit } = createHarness();
    for (const route of [
      { method: "GET", path: "/v1/run-state" },
      { method: "GET", path: "/v1/metrics" },
      { method: "POST", path: "/v1/kill-switch" },
      { method: "POST", path: "/v1/strategies/sb-1/pause" },
    ]) {
      const response = await api.handle(
        request({ ...route, authorization: undefined, body: { reason: "trying" } }),
      );
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
    }
    // AND it wrote nothing: an anonymous caller cannot fill the audit log.
    expect(audit.records()).toEqual([]);
    expect(api.authenticationFailures()).toEqual({ MISSING_CREDENTIAL: 4 });
  });

  it("401s an unknown token and never echoes it", async () => {
    const { api } = createHarness();
    const presented = "a-token-that-must-not-be-echoed-anywhere";
    const response = await api.handle(request({ authorization: bearer(presented) }));
    expect(response.status).toBe(401);
    expect(response.body).not.toContain(presented);
    expect(api.authenticationFailures()).toEqual({ UNKNOWN_CREDENTIAL: 1 });
  });
});

describe("ACCEPTANCE 1 — a mode raise is refused by name and audited", () => {
  it.each([
    ["runMode", { runMode: "LIVE", reason: "please" }],
    ["maxRunMode", { maxRunMode: "LIVE", reason: "please" }],
    ["allowRealOrders", { allowRealOrders: true, reason: "please" }],
    ["liveMicroMaxOrderNotional", { liveMicroMaxOrderNotional: "100", reason: "please" }],
    ["signer", { signer: "0xabc", reason: "please" }],
    ["nested", { config: { runMode: "LIVE" }, reason: "please" }],
  ])("REFUSES a body naming %s, on a control route", async (_name, body) => {
    const { api, controlPlane, audit } = createHarness();
    const response = await api.handle(
      request({ method: "POST", path: "/v1/strategies/sb-1/pause", body }),
    );
    expect(response.status).toBe(403);
    const problem = parse(response);
    expect(problem["code"]).toBe("CONTROL_MODE_RAISE_REFUSED");
    expect(String(problem["detail"])).toContain("is refused by name");
    // AUDITED.
    expect(audit.records()).toHaveLength(1);
    expect(audit.records()[0]).toMatchObject({
      action: "MODE_RAISE_ATTEMPT",
      outcome: "REFUSED",
    });
    expect(controlPlane.modeRaiseAttemptsRefused).toBe(1);
    // …and NOTHING changed.
    expect(controlPlane.runState().maximumRunMode).toBe("PAPER");
    expect(controlPlane.strategies()).toEqual([]);
  });

  it("refuses a mode-raise attempt BEFORE checking authorization, and AUDITS it for a caller with a mutation grant", async () => {
    // An operator holding STRATEGY_CONTROL but not KILL_SWITCH, on the
    // kill-switch route. The interesting fact is the attempted mode raise, so
    // that is what is answered and recorded — not the missing grant.
    const { api, audit } = createHarness({
      operators: [
        { operatorId: "strategist-c", token: FAKE_OPERATOR_TOKEN, grants: ["READ", "STRATEGY_CONTROL"] },
      ],
    });
    const response = await api.handle(
      request({
        method: "POST",
        path: "/v1/kill-switch",
        body: { runMode: "LIVE", reason: "please" },
      }),
    );
    expect(parse(response)["code"]).toBe("CONTROL_MODE_RAISE_REFUSED");
    expect(String(parse(response)["detail"])).toContain("the attempt has been audited.");
    expect(audit.records()[0]).toMatchObject({ action: "MODE_RAISE_ATTEMPT", actor: "strategist-c" });
    expect(api.authorizationFailures()).toEqual({});
  });

  it("CONTROL-1 (M-3): a READ-only caller's attempt is refused by name and COUNTED, but writes NO audit record", async () => {
    const { api, audit, controlPlane } = createHarness();
    const response = await api.handle(
      request({
        method: "POST",
        path: "/v1/strategies/sb-1/pause",
        authorization: bearer(FAKE_READER_TOKEN),
        body: { runMode: "LIVE", reason: "please" },
      }),
    );
    expect(response.status).toBe(403);
    expect(parse(response)["code"]).toBe("CONTROL_MODE_RAISE_REFUSED");
    expect(String(parse(response)["detail"])).toContain("is refused by name");
    expect(String(parse(response)["detail"])).toContain("NOT audited");
    expect(String(parse(response)["detail"])).not.toContain("has been audited");
    expect(parse(response)["issues"]).toEqual(["runMode"]);
    expect(audit.records()).toEqual([]);
    expect(controlPlane.modeRaiseAttemptsRefused).toBe(1);
  });

  it("CONTROL-1: a mutation-authorized caller's refusal does not CLAIM an audit the budget refused", async () => {
    // Capacity 1, reserve 0: one ordinary record fills the log.
    const { api, audit } = createHarness({ auditCapacity: 1 });
    await api.handle(request({ method: "POST", path: "/v1/kill-switch", body: { runMode: "LIVE", reason: "one" } }));
    const second = await api.handle(
      request({ method: "POST", path: "/v1/kill-switch", body: { runMode: "LIVE", reason: "two" } }),
    );
    expect(second.status).toBe(403);
    expect(String(parse(second)["detail"])).toContain("could NOT be audited (CONTROL_NOT_AUDITABLE)");
    expect(String(parse(second)["detail"])).not.toContain("has been audited");
    expect(audit.records()).toHaveLength(1);
  });

  it("reports the run state read-only, stating that it is not writable", async () => {
    const { api } = createHarness();
    const response = await api.handle(request({ path: "/v1/run-state" }));
    expect(response.status).toBe(200);
    expect(parse(response)).toEqual({
      runMode: "PAPER",
      maximumRunMode: "PAPER",
      repositoryMaximumRunMode: "PAPER",
      allowRealOrders: false,
      runModeIsWritable: false,
      signerLoaded: false,
    });
  });

  it("has no route that would CHANGE the run state (405: the path is served for GET only)", async () => {
    const { api } = createHarness();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await api.handle(
        request({ method, path: "/v1/run-state", body: { reason: "trying" } }),
      );
      // `CONTROL-1` (L-4): a known path under the wrong method is a 405 naming
      // what IS served there — still "this cannot be done", now said precisely.
      expect(response.status, method).toBe(405);
      expect(parse(response)["code"]).toBe("CONTROL_METHOD_NOT_ALLOWED");
      expect(response.allow, method).toBe("GET");
    }
  });
});

describe("§15 — explicit authorization", () => {
  it("403s an operator lacking the route's grant, and counts it", async () => {
    const { api } = createHarness();
    const pause = await api.handle(
      request({
        method: "POST",
        path: "/v1/strategies/sb-1/pause",
        authorization: bearer(FAKE_READER_TOKEN),
        body: { reason: "maintenance window" },
      }),
    );
    expect(pause.status).toBe(403);
    expect(parse(pause)["code"]).toBe("CONTROL_UNAUTHORIZED");

    const engage = await api.handle(
      request({
        method: "POST",
        path: "/v1/kill-switch",
        authorization: bearer(FAKE_READER_TOKEN),
        body: { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "stop" },
      }),
    );
    expect(engage.status).toBe(403);
    expect(api.authorizationFailures()).toEqual({ KILL_SWITCH: 1, STRATEGY_CONTROL: 1 });
  });

  it("lets a reader read", async () => {
    const { api } = createHarness();
    for (const path of ["/v1/run-state", "/v1/strategies", "/v1/kill-switch", "/v1/health"]) {
      const response = await api.handle(
        request({ path, authorization: bearer(FAKE_READER_TOKEN) }),
      );
      expect(response.status, path).toBe(200);
    }
  });
});

describe("strategy controls", () => {
  it("pauses and resumes, auditing each", async () => {
    const { api, controlPlane, audit } = createHarness();
    controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");

    const paused = await api.handle(
      request({
        method: "POST",
        path: "/v1/strategies/sb-1/pause",
        body: { reason: "maintenance window" },
      }),
    );
    expect(paused.status).toBe(200);
    expect(controlPlane.strategies()[0]?.state).toBe("PAUSED");

    const resumed = await api.handle(
      request({
        method: "POST",
        path: "/v1/strategies/sb-1/resume",
        body: { reason: "maintenance complete" },
      }),
    );
    expect(resumed.status).toBe(200);
    expect(controlPlane.strategies()[0]?.state).toBe("RUNNING");

    expect(audit.records().map((record) => record.action)).toEqual([
      "STRATEGY_PAUSE",
      "STRATEGY_RESUME",
    ]);
    // The response names the audit record, so an operator can find it.
    expect(parse(paused)["auditRecordId"]).toBe(audit.records()[0]?.recordId);
  });

  it("REFUSES a request with no reason: §14.1 requires one — and AUDITS the refusal (CONTROL-1 r1)", async () => {
    const { api, audit, controlPlane } = createHarness();
    controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
    const response = await api.handle(
      request({ method: "POST", path: "/v1/strategies/sb-1/pause", body: {} }),
    );
    expect(response.status).toBe(400);
    expect(parse(response)["code"]).toBe("CONTROL_REQUEST_INVALID");
    // `CONTROL1-J-M2`: the caller authenticated and holds STRATEGY_CONTROL, so
    // its refusal is an operator fact — recorded, and nothing changed.
    expect(audit.records()).toHaveLength(1);
    expect(audit.records()[0]).toMatchObject({
      action: "STRATEGY_PAUSE",
      outcome: "REFUSED",
      actor: "operator-a",
      scope: "STRATEGY_INSTANCE",
      scopeRef: "sb-1",
      priorState: { refusedAt: "REQUEST_BODY", stateRead: "false" },
      resultingState: { refusedAt: "REQUEST_BODY", refusalCode: "CONTROL_REQUEST_INVALID" },
    });
    expect(controlPlane.strategies()[0]?.state).toBe("RUNNING");
  });

  it("REFUSES an unknown key in the body: the grammar is closed", async () => {
    const { api } = createHarness();
    const response = await api.handle(
      request({
        method: "POST",
        path: "/v1/strategies/sb-1/pause",
        body: { reason: "ok reason", force: true },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("409s a pause of an already-paused instance", async () => {
    const { api, controlPlane } = createHarness();
    controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
    await api.handle(
      request({ method: "POST", path: "/v1/strategies/sb-1/pause", body: { reason: "once" } }),
    );
    const again = await api.handle(
      request({ method: "POST", path: "/v1/strategies/sb-1/pause", body: { reason: "twice" } }),
    );
    expect(again.status).toBe(409);
    expect(parse(again)["code"]).toBe("CONTROL_ALREADY_IN_STATE");
  });
});

describe("CONTROL-1: the strategy route parameter goes through its own door", () => {
  it.each(["%E0%A4%A", "%ZZ", "%"])("L-1: answers 400, not a contained 500, for the malformed escape %s", async (raw) => {
    const { api, audit } = createHarness();
    const response = await api.handle(
      request({ method: "POST", path: `/v1/strategies/${raw}/pause`, body: { reason: "malformed" } }),
    );
    expect(response.status).toBe(400);
    expect(parse(response)["code"]).toBe("CONTROL_INVALID_ROUTE_PARAMETER");
    // `CONTROL-1` r1 (CONTROL1-J-M2): an AUTHORIZED caller's refusal is audited —
    // against no scopeRef, since the id never passed its door.
    expect(audit.records()).toHaveLength(1);
    expect(audit.records()[0]).toMatchObject({
      action: "STRATEGY_PAUSE",
      outcome: "REFUSED",
      scope: "STRATEGY_INSTANCE",
      scopeRef: null,
      resultingState: { refusedAt: "ROUTE_PARAMETER", refusalCode: "CONTROL_INVALID_ROUTE_PARAMETER" },
    });
  });

  it("L-2: refuses an id whose %2F decodes to '/' — its refusal is audited with NO scopeRef, never 'a/b'", async () => {
    const { api, audit, controlPlane } = createHarness();
    const response = await api.handle(
      request({ method: "POST", path: "/v1/strategies/a%2Fb/pause", body: { reason: "slash" } }),
    );
    expect(response.status).toBe(400);
    expect(parse(response)["code"]).toBe("CONTROL_INVALID_ROUTE_PARAMETER");
    expect(audit.records().map((record) => record.scopeRef)).toEqual([null]);
    expect(JSON.stringify(audit.records())).not.toContain("a/b");
    expect(controlPlane.strategies()).toEqual([]);
  });

  it("authorizes BEFORE reading the parameter: a reader learns only that it is unauthorized", async () => {
    const { api } = createHarness();
    const response = await api.handle(
      request({
        method: "POST",
        path: "/v1/strategies/%ZZ/pause",
        authorization: bearer(FAKE_READER_TOKEN),
        body: { reason: "malformed" },
      }),
    );
    expect(response.status).toBe(403);
    expect(parse(response)["code"]).toBe("CONTROL_UNAUTHORIZED");
  });

  it("M-1 through the API: an unknown instance is 409 CONTROL_UNKNOWN_INSTANCE", async () => {
    const { api, controlPlane } = createHarness();
    const response = await api.handle(
      request({ method: "POST", path: "/v1/strategies/never-registered/pause", body: { reason: "unknown" } }),
    );
    expect(response.status).toBe(409);
    expect(parse(response)["code"]).toBe("CONTROL_UNKNOWN_INSTANCE");
    expect(controlPlane.strategies()).toEqual([]);
  });

  it("L-8: a flood of distinct unknown ids adds no instance and no metric series", async () => {
    const { api } = createHarness({ auditCapacity: 1_000 });
    const before = (await api.handle(request({ path: "/v1/metrics" }))).body;
    for (let index = 0; index < 300; index += 1) {
      await api.handle(
        request({ method: "POST", path: `/v1/strategies/flood-${String(index)}/pause`, body: { reason: "flood" } }),
      );
    }
    const after = (await api.handle(request({ path: "/v1/metrics" }))).body;
    const series = (body: string): readonly string[] =>
      body
        .split("\n")
        .filter((line) => line.startsWith("control_strategy"))
        .map((line) => line.replace(/ \d+$/u, ""));
    expect(series(after)).toEqual(series(before));
    expect(after).not.toContain("flood-");
    expect(after).toContain('control_strategy_instances{state="RUNNING"} 0');
  });
});

describe("§14.1 kill-switch controls", () => {
  it("engages and releases, with the release requiring evidence", async () => {
    const { api, controlPlane } = createHarness();

    const engaged = await api.handle(
      request({
        method: "POST",
        path: "/v1/kill-switch",
        body: {
          scope: "MARKET",
          scopeRef: "market-1",
          action: "CANCEL_MARKET",
          reason: "book desynchronised",
        },
      }),
    );
    expect(engaged.status).toBe(200);
    expect(controlPlane.killSwitches()).toHaveLength(1);

    const withoutEvidence = await api.handle(
      request({
        method: "POST",
        path: "/v1/kill-switch/release",
        body: { scope: "MARKET", scopeRef: "market-1", reason: "just do it" },
      }),
    );
    expect(withoutEvidence.status).toBe(400);
    expect(controlPlane.killSwitches()).toHaveLength(1);

    const falseEvidence = await api.handle(
      request({
        method: "POST",
        path: "/v1/kill-switch/release",
        body: {
          scope: "MARKET",
          scopeRef: "market-1",
          authoritativeSnapshotApplied: false,
          reason: "just do it",
        },
      }),
    );
    expect(falseEvidence.status).toBe(400);
    expect(controlPlane.killSwitches()).toHaveLength(1);

    const released = await api.handle(
      request({
        method: "POST",
        path: "/v1/kill-switch/release",
        body: {
          scope: "MARKET",
          scopeRef: "market-1",
          authoritativeSnapshotApplied: true,
          reason: "reconciled against a fresh snapshot",
        },
      }),
    );
    expect(released.status).toBe(200);
    expect(controlPlane.killSwitches()).toEqual([]);
  });

  it("REFUSES a scope or action outside §14.1's vocabulary", async () => {
    const { api } = createHarness();
    for (const body of [
      { scope: "EVERYTHING", scopeRef: null, action: "FULL_HALT", reason: "stop it" },
      { scope: "GLOBAL", scopeRef: null, action: "SELL_EVERYTHING", reason: "stop it" },
    ]) {
      const response = await api.handle(
        request({ method: "POST", path: "/v1/kill-switch", body }),
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("409s a GLOBAL switch that names a scope reference (§10.6)", async () => {
    const { api } = createHarness();
    const response = await api.handle(
      request({
        method: "POST",
        path: "/v1/kill-switch",
        body: { scope: "GLOBAL", scopeRef: "market-1", action: "FULL_HALT", reason: "stop it" },
      }),
    );
    expect(response.status).toBe(409);
    expect(parse(response)["code"]).toBe("CONTROL_SCOPE_REF_MISMATCH");
  });
});

describe("the audit surface under pressure", () => {
  it("503s a mutation the audit log cannot record, and leaves the state alone", async () => {
    const { api, controlPlane } = createHarness({ auditCapacity: 1 });
    controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
    controlPlane.register("sb-2", "2026-09-05T00:00:00.000Z");

    expect(
      (
        await api.handle(
          request({ method: "POST", path: "/v1/strategies/sb-1/pause", body: { reason: "one" } }),
        )
      ).status,
    ).toBe(200);

    const second = await api.handle(
      request({ method: "POST", path: "/v1/strategies/sb-2/pause", body: { reason: "two" } }),
    );
    expect(second.status).toBe(503);
    expect(parse(second)["code"]).toBe("CONTROL_NOT_AUDITABLE");
    expect(controlPlane.strategies().find((entry) => entry.instanceId === "sb-2")?.state).toBe(
      "RUNNING",
    );
  });
});

describe("the health read", () => {
  it("says plainly when no report has arrived, and why", async () => {
    const { api } = createHarness();
    const response = await api.handle(request({ path: "/v1/health" }));
    const body = parse(response);
    expect(body["available"]).toBe(false);
    expect(body["report"]).toBeNull();
    expect(String(body["note"])).toContain("composition obligation");
  });

  it("returns the report verbatim, with exact decimals as strings", async () => {
    const { api, health, healthSource } = createHarness();
    healthSource.set(healthDocument());
    await health.refresh();

    const body = parse(await api.handle(request({ path: "/v1/health" })));
    expect(body["available"]).toBe(true);
    const report = body["report"] as Record<string, unknown>;
    const seams = report["seams"] as Record<string, Record<string, unknown>>;
    expect(seams["reservations"]?.["reservedCollateral"]).toBe("12.50");
    expect(typeof seams["reservations"]?.["reservedCollateral"]).toBe("string");
    expect(String(report["riskSeamCaveat"])).toContain("WP-220");
  });
});

describe("the metrics surface", () => {
  it("renders control-plane families even with no trader report", async () => {
    const { api } = createHarness();
    const response = await api.handle(request({ path: "/v1/metrics" }));
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/plain");
    expect(response.body).toContain("control_trader_health_available 0");
    expect(response.body).toContain(
      'control_run_mode_info{run_mode="PAPER",maximum_run_mode="PAPER",repository_maximum_run_mode="PAPER"} 1',
    );
    expect(response.body).toContain("control_allow_real_orders 0");
    // No trader report: no trader_* series at all, rather than zeros.
    expect(response.body).not.toContain("trader_events_accepted_total");
  });

  it("renders the trader families once a report has passed the door", async () => {
    const { api, health, healthSource } = createHarness();
    healthSource.set(healthDocument());
    await health.refresh();

    const body = (await api.handle(request({ path: "/v1/metrics" }))).body;
    expect(body).toContain("control_trader_health_available 1");
    expect(body).toContain("trader_observe_only_intents_total 2");
    expect(body).toContain('trader_risk_refused_exits_by_code_total{code="RISK_NO_NET_EDGE"} 1');
    expect(body).toContain("trader_risk_seam_caveat_active 1");
    expect(body).toContain(
      'trader_seam_reservations_reserved_collateral_info{exact_decimal="12.50"} 1',
    );
  });

  it("counts mutations by action and outcome", async () => {
    const { api, controlPlane, health, healthSource } = createHarness();
    healthSource.set(healthDocument());
    await health.refresh();
    controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
    await api.handle(
      request({ method: "POST", path: "/v1/strategies/sb-1/pause", body: { reason: "one" } }),
    );
    await api.handle(request({ method: "POST", path: "/v1/strategies/sb-1/pause", body: { reason: "two" } }));

    const body = (await api.handle(request({ path: "/v1/metrics" }))).body;
    expect(body).toContain('control_mutations_total{action="STRATEGY_PAUSE",outcome="APPLIED"} 1');
    expect(body).toContain('control_mutations_total{action="STRATEGY_PAUSE",outcome="REFUSED"} 1');
    expect(body).toContain("control_audit_records 2");
    expect(body).toContain("control_audit_capacity 64");
  });

  it("is deterministic: two renders of one state are byte-identical", async () => {
    const { api, health, healthSource } = createHarness();
    healthSource.set(healthDocument());
    await health.refresh();
    const once = (await api.handle(request({ path: "/v1/metrics" }))).body;
    const twice = (await api.handle(request({ path: "/v1/metrics" }))).body;
    expect(once).toBe(twice);
  });

  it("carries no operator token anywhere in the exposition", async () => {
    const { api } = createHarness();
    const body = (await api.handle(request({ path: "/v1/metrics" }))).body;
    expect(body).not.toContain(FAKE_OPERATOR_TOKEN);
    expect(body).not.toContain(FAKE_READER_TOKEN);
    expect(body).not.toContain("Bearer");
  });
});

describe("totality", () => {
  it("answers every method/path combination without throwing", async () => {
    const { api } = createHarness();
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", ""]) {
      for (const path of ["", "/", "/v1", "/v1/strategies//pause", "/v1/kill-switch", "/../.."]) {
        for (const body of [undefined, null, 1, "x", [], { reason: "ok reason" }]) {
          const response = await api.handle(request({ method, path, body }));
          expect(typeof response.status, `${method} ${path}`).toBe("number");
        }
      }
    }
  });
});

describe("CONTROL-1b (follow-up 3b): a mode-raise attempt's audit record is bounded at the API too", () => {
  /** Distinct spellings of `runMode` — each a key the by-name refusal finds. */
  function caseVariants(count: number): readonly string[] {
    const out: string[] = [];
    for (let mask = 0; out.length < count; mask += 1) {
      out.push([..."runmode"].map((c, index) => ((mask >> index) & 1 ? c.toUpperCase() : c)).join(""));
    }
    return out;
  }

  it("keeps a bounded path and at most eight keys, then says how many more; the 403 still names them all", async () => {
    const { api, audit } = createHarness();
    const keys = caseVariants(20);
    const body: Record<string, unknown> = { reason: "ok reason" };
    for (const key of keys) body[key] = "LIVE";
    const path = `/v1/${"p".repeat(5_000)}`;
    const response = await api.handle(request({ method: "POST", path, body }));
    expect(response.status).toBe(403);
    expect(parse(response)["issues"]).toHaveLength(20);

    const record = audit.records()[0];
    expect(record?.action).toBe("MODE_RAISE_ATTEMPT");
    expect(record?.reason.length).toBeLessThanOrEqual(REFUSAL_AUDIT_MAX_TEXT);
    expect(record?.reason).toMatch(/^request to POST \/v1\/p+… named /u);
    expect(record?.reason).toContain(` and ${String(20 - REFUSAL_AUDIT_MAX_ISSUES)} more`);
    expect(record?.reason).not.toContain("p".repeat(MODE_RAISE_REASON_MAX_PATH));
    const document = record?.resultingState as Record<string, unknown>;
    expect(document["attemptedKeys"]).toEqual([...keys].sort().slice(0, REFUSAL_AUDIT_MAX_ISSUES));
    expect(document["attemptedKeyCount"]).toBe("20");
  });

  it("an ordinary attempt's reason is unchanged: the method, the path and every key", async () => {
    const { api, audit } = createHarness();
    await api.handle(request({ method: "POST", path: "/v1/kill-switch", body: { runMode: "LIVE", allowRealOrders: true, reason: "x" } }));
    expect(audit.records()[0]?.reason).toBe("request to POST /v1/kill-switch named allowRealOrders, runMode");
  });

  it("an audit record the sink did not confirm within the bound is answered 'NOT confirmed … may still land', never 'audited'", async () => {
    const environment = new ScriptedEnvironment();
    const controlPlane = new ControlPlane({
      audit: { append: () => new Promise(() => undefined) },
      runMode: "PAPER",
      maximumRunMode: "PAPER",
      repositoryMaximumRunMode: "PAPER",
      auditAppendTimeoutMs: 20,
      auditRecordSource: environment,
    });
    const api = new ControlApi({
      operators: new OperatorRegistry([
        { operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] },
      ]),
      controlPlane,
      health: new TraderHealthCache(new InMemoryTraderHealthSource()),
      environment,
      auditCapacity: 8,
      auditSize: () => 0,
    });
    const response = await api.handle(request({ method: "POST", path: "/v1/kill-switch", body: { runMode: "LIVE", reason: "x" } }));
    expect(response.status).toBe(403);
    const detail = String(parse(response)["detail"]);
    expect(detail).toContain("its audit record was NOT confirmed within the append bound (CONTROL_NOT_AUDITABLE)");
    expect(detail).toContain("may still land");
    expect(detail).not.toContain("has been audited");

    // And a mutation over the same stalled sink is a 503 with the state unmoved.
    const engage = await api.handle(
      request({ method: "POST", path: "/v1/kill-switch", body: { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "halt now" } }),
    );
    expect(engage.status).toBe(503);
    expect(parse(engage)["code"]).toBe("CONTROL_NOT_AUDITABLE");
    expect(controlPlane.killSwitches()).toEqual([]);
  });
});
