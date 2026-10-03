/**
 * `CONTROL-1` — `WP-240` r1 **M-1**, reproduced and pinned over REAL HTTP.
 *
 * ## The finding
 *
 * Pausing a strategy instance the control plane had never known answered
 * `200 PAUSED`. The shipped composition (`main.ts`) never calls `register()`,
 * so EVERY instance is unknown to it, and `#setStrategyState` synthesized a
 * fabricated prior ("not previously known to the control plane", `RUNNING`)
 * and applied a change to it. That contradicts the package's own release-path
 * rule: releasing a kill switch nobody engaged is refused `CONTROL_NOT_ENGAGED`
 * because "answering 'released' here would let an operator mistake an
 * acknowledgement of a switch that never existed for a recovery". A `200
 * PAUSED` for an instance nothing runs is the same mistake in the other
 * direction: an operator reads it as a halt that took effect.
 *
 * ## The rule this file pins
 *
 * An unknown instance is REFUSED, the way an unengaged switch is: `409
 * CONTROL_UNKNOWN_INSTANCE`, audited as `REFUSED` with the refusal code (the
 * caller holds `STRATEGY_CONTROL`, so the refusal is an operator fact), and
 * nothing is inserted into the control plane's state.
 *
 * At base `98a814b` the first two tests here FAIL (measured, `CONTROL-1`
 * handoff): the pause answers `200` and `/v1/strategies` lists the fabricated
 * instance as `PAUSED`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { FAKE_OPERATOR_TOKEN } from "@polymarket-bot/control-api/testing";

import { serveControlApi, type ServedApi } from "./support/client.js";

const OPERATORS = [
  {
    operatorId: "operator-a",
    token: FAKE_OPERATOR_TOKEN,
    grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] as const,
  },
];

let served: ServedApi | undefined;

afterEach(async () => {
  await served?.server.close();
  served = undefined;
});

describe("M-1: an instance the control plane has never known is refused, not fabricated", () => {
  it("REFUSES a pause of an unregistered instance (409 CONTROL_UNKNOWN_INSTANCE), and inserts nothing", async () => {
    served = await serveControlApi({ operators: OPERATORS });
    const api = served;

    const response = await api.call("POST", "/v1/strategies/never-registered/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "halt an instance nobody registered" },
    });
    expect(response.status).toBe(409);
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_UNKNOWN_INSTANCE");

    // NOTHING was inserted: the read surface does not list a fabricated instance.
    const listed = await api.call("GET", "/v1/strategies", { token: FAKE_OPERATOR_TOKEN });
    expect((listed.json() as { strategies: readonly unknown[] }).strategies).toEqual([]);
    expect(api.controlPlane.strategies()).toEqual([]);

    // AUDITED as a refusal, with the code, like the release path's NOT_ENGAGED.
    const records = api.audit.records();
    expect(records.map((record) => `${record.action}|${record.outcome}`)).toEqual([
      "STRATEGY_PAUSE|REFUSED",
    ]);
    expect(records[0]).toMatchObject({
      actor: "operator-a",
      scope: "STRATEGY_INSTANCE",
      scopeRef: "never-registered",
    });
    expect(records[0]?.resultingState).toMatchObject({ refusalCode: "CONTROL_UNKNOWN_INSTANCE" });
    // The prior state says the instance was NOT known — no fabricated RUNNING.
    expect(records[0]?.priorState).toMatchObject({ known: "false", instanceId: "never-registered" });
    expect(JSON.stringify(records[0]?.priorState)).not.toContain("RUNNING");
  });

  it("REFUSES a resume of an unregistered instance the same way", async () => {
    served = await serveControlApi({ operators: OPERATORS });
    const api = served;
    const response = await api.call("POST", "/v1/strategies/never-registered/resume", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "resume an instance nobody registered" },
    });
    expect(response.status).toBe(409);
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_UNKNOWN_INSTANCE");
    expect(api.controlPlane.strategies()).toEqual([]);
    expect(api.audit.records().map((record) => `${record.action}|${record.outcome}`)).toEqual([
      "STRATEGY_RESUME|REFUSED",
    ]);
  });

  it("a REGISTERED instance still pauses and resumes (the rule refuses only the unknown)", async () => {
    served = await serveControlApi({ operators: OPERATORS });
    const api = served;
    api.controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
    const paused = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "a known instance" },
    });
    expect(paused.status).toBe(200);
    expect(api.controlPlane.strategies().map((entry) => `${entry.instanceId}:${entry.state}`)).toEqual([
      "sb-1:PAUSED",
    ]);
  });
});
