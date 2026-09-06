/**
 * The handler seam: the order of operations, the refusals, and the surfaces.
 *
 * These drive the REAL `ControlApi` over the REAL control plane and the REAL
 * append-only audit log. Only the trader health SOURCE is a stand-in, for the
 * reason `health-source.ts` states.
 */

import { describe, expect, it } from "vitest";

import { CONTROL_API_ROUTES, type ApiRequest, type ApiResponse } from "./api.js";
import {
  FAKE_OPERATOR_TOKEN,
  FAKE_READER_TOKEN,
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

  it("refuses a mode-raise attempt BEFORE checking authorization", async () => {
    // A reader with no STRATEGY_CONTROL grant. The interesting fact is the
    // attempted mode raise, so that is what gets recorded.
    const { api, audit } = createHarness();
    const response = await api.handle(
      request({
        method: "POST",
        path: "/v1/strategies/sb-1/pause",
        authorization: bearer(FAKE_READER_TOKEN),
        body: { runMode: "LIVE", reason: "please" },
      }),
    );
    expect(parse(response)["code"]).toBe("CONTROL_MODE_RAISE_REFUSED");
    expect(audit.records()[0]).toMatchObject({ action: "MODE_RAISE_ATTEMPT", actor: "reader-b" });
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

  it("has no route that would CHANGE the run state", async () => {
    const { api } = createHarness();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await api.handle(
        request({ method, path: "/v1/run-state", body: { reason: "trying" } }),
      );
      expect(response.status, method).toBe(404);
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

  it("REFUSES a request with no reason: §14.1 requires one", async () => {
    const { api, audit } = createHarness();
    const response = await api.handle(
      request({ method: "POST", path: "/v1/strategies/sb-1/pause", body: {} }),
    );
    expect(response.status).toBe(400);
    expect(parse(response)["code"]).toBe("CONTROL_REQUEST_INVALID");
    expect(audit.records()).toEqual([]);
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
