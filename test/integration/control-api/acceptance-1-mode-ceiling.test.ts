/**
 * WP-240 ACCEPTANCE 1 — "Control API cannot raise mode above process maximum."
 *
 * Driven over REAL HTTP against the REAL API. The claim has three parts and
 * each has its own test here:
 *
 * 1. **Unrepresentable.** No route accepts a run mode. Every method against
 *    `/v1/run-state` other than `GET` is a 404, and every control body naming a
 *    mode-raising key is refused before it reaches a handler.
 * 2. **Refused by name**, with a message that says what was refused and why.
 * 3. **Audited**, as a `MODE_RAISE_ATTEMPT` record whose prior and resulting
 *    ceilings are identical — the record of an attempt that changed nothing.
 *
 * The startup half (a deployment trying to raise `MAX_RUN_MODE`) is
 * `apps/control-api/src/safety.test.ts`; it is a pure function of an
 * environment record and needs no server.
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

async function start(): Promise<ServedApi> {
  served = await serveControlApi({ operators: OPERATORS });
  return served;
}

describe("ACCEPTANCE 1: the run-mode ceiling is not writable through this API", () => {
  it("reports the ceiling read-only and says so on the wire", async () => {
    const api = await start();
    const response = await api.call("GET", "/v1/run-state", { token: FAKE_OPERATOR_TOKEN });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      runMode: "PAPER",
      maximumRunMode: "PAPER",
      repositoryMaximumRunMode: "PAPER",
      allowRealOrders: false,
      runModeIsWritable: false,
      signerLoaded: false,
    });
  });

  it("UNREPRESENTABLE: no write method on the run-state route exists at all", async () => {
    const api = await start();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await api.call(method, "/v1/run-state", {
        token: FAKE_OPERATOR_TOKEN,
        body: { runMode: "LIVE" },
      });
      // 403 (the mode-raise refusal fires first) or 404 (no such route) — both
      // are "this cannot be done"; what must NOT happen is a 2xx.
      expect([403, 404], method).toContain(response.status);
      expect(api.controlPlane.runState().maximumRunMode).toBe("PAPER");
    }
  });

  it.each([
    ["runMode", { runMode: "LIVE", reason: "please let me" }],
    ["max_run_mode", { max_run_mode: "LIVE", reason: "please let me" }],
    ["allowRealOrders", { allowRealOrders: true, reason: "please let me" }],
    ["liveMicroMaxOrderNotional", { liveMicroMaxOrderNotional: "100", reason: "please let me" }],
    ["liveMicroMaxAccountExposure", { liveMicroMaxAccountExposure: "100", reason: "please let me" }],
    ["signer", { signer: "0xdeadbeef", reason: "please let me" }],
    ["privateKey", { privateKey: "0xdeadbeef", reason: "please let me" }],
    ["nested runMode", { config: { deeper: { runMode: "LIVE" } }, reason: "please let me" }],
  ])("REFUSES BY NAME a control request carrying %s, and AUDITS it", async (_case, body) => {
    const api = await start();
    const response = await api.call("POST", "/v1/kill-switch", {
      token: FAKE_OPERATOR_TOKEN,
      body,
    });

    expect(response.status).toBe(403);
    const problem = response.json() as Record<string, unknown>;
    expect(problem["code"]).toBe("CONTROL_MODE_RAISE_REFUSED");
    expect(String(problem["detail"])).toContain("is refused by name");
    expect((problem["issues"] as readonly string[]).length).toBeGreaterThan(0);

    // AUDITED, and the record says nothing changed.
    const record = api.audit.records().at(-1);
    expect(record).toMatchObject({
      action: "MODE_RAISE_ATTEMPT",
      outcome: "REFUSED",
      actor: "operator-a",
      scope: "CONTROL_PLANE",
    });
    expect(record?.priorState).toMatchObject({ maximumRunMode: "PAPER" });
    expect(record?.resultingState).toMatchObject({ maximumRunMode: "PAPER" });

    // And the ceiling is where it was.
    expect(api.controlPlane.runState()).toMatchObject({
      maximumRunMode: "PAPER",
      allowRealOrders: false,
      runModeIsWritable: false,
    });
  });

  it("counts refused attempts on the metrics surface", async () => {
    const api = await start();
    await api.call("POST", "/v1/kill-switch", {
      token: FAKE_OPERATOR_TOKEN,
      body: { runMode: "LIVE", reason: "one" },
    });
    await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { allowRealOrders: true, reason: "two" },
    });

    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).toContain("control_mode_raise_attempts_refused_total 2");
    expect(metrics.text).toContain("control_allow_real_orders 0");
  });

  it("records an unauthorized operator's attempt too — the attempt is the fact", async () => {
    const api = await start();
    const response = await api.call("POST", "/v1/kill-switch", {
      token: FAKE_READER_TOKEN,
      body: { runMode: "LIVE", scope: "GLOBAL", action: "FULL_HALT", reason: "please" },
    });
    expect(response.status).toBe(403);
    expect((response.json() as Record<string, unknown>)["code"]).toBe(
      "CONTROL_MODE_RAISE_REFUSED",
    );
    expect(api.audit.records().at(-1)).toMatchObject({
      action: "MODE_RAISE_ATTEMPT",
      actor: "reader-b",
    });
  });

  it("does NOT refuse an ordinary request whose REASON mentions live or a signer", async () => {
    // Refusing on values would make a legitimate operator note unwritable.
    const api = await start();
    const response = await api.call("POST", "/v1/kill-switch", {
      token: FAKE_OPERATOR_TOKEN,
      body: {
        scope: "GLOBAL",
        scopeRef: null,
        action: "FULL_HALT",
        reason: "halting: we are NOT going live and no signer exists",
      },
    });
    expect(response.status).toBe(200);
    expect(api.controlPlane.killSwitches()).toHaveLength(1);
  });

  it("has no route anywhere whose path names a mode, a signer or a wallet", async () => {
    const api = await start();
    for (const path of [
      "/v1/run-mode",
      "/v1/mode",
      "/v1/signer",
      "/v1/wallet",
      "/v1/orders",
      "/v1/live",
      "/v1/config",
    ]) {
      for (const method of ["GET", "POST", "PUT"]) {
        const response = await api.call(method, path, {
          token: FAKE_OPERATOR_TOKEN,
          body: method === "GET" ? undefined : { reason: "trying it on" },
        });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
  });
});
