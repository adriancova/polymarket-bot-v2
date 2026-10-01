/**
 * `CONTROL-1` — `WP-240` r1 **M-3**, reproduced and pinned over REAL HTTP.
 *
 * ## The finding (read from code at `WP-240` r1; never reproduced until here)
 *
 * The forbidden-key refusal ran BEFORE authorization and AUDITED every
 * attempt. So an authenticated operator holding only `READ` could append one
 * `MODE_RAISE_ATTEMPT` record per request. The in-memory audit log refuses at
 * its bound rather than evicting, and the control plane audits before it
 * applies — so once the reader had filled the log, EVERY mutation was refused
 * `503 CONTROL_NOT_AUDITABLE`, the §14.1 kill switch included. `WP-240` r1
 * demonstrated it at `auditCapacity` 3 in five requests; `CLOSEOUT-2` I1 noted
 * it had been read from code and not reproduced.
 *
 * At base `98a814b` the first test below FAILS exactly that way (measured,
 * `CONTROL-1` handoff): the reader's three refusal records fill the log and
 * the authorized engage answers `503 CONTROL_NOT_AUDITABLE`.
 *
 * ## The invariant pinned here
 *
 * No request sequence from an actor without mutation authority can prevent an
 * authorized actor's kill-switch engage, or any other safety-direction action,
 * from being executed and audited. The randomized form, over every actor class
 * and the budget tiers, is `audit-budget-adversarial.test.ts`.
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

/** The five requests of the `WP-240` r1 demonstration, from a READ-only operator. */
const READER_MODE_RAISES: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ["POST", "/v1/kill-switch", { runMode: "LIVE", reason: "one" }],
  ["POST", "/v1/kill-switch/release", { allowRealOrders: true, reason: "two" }],
  ["POST", "/v1/strategies/sb-1/pause", { signer: "x", reason: "three" }],
  ["GET", "/v1/run-state", { maxRunMode: "LIVE" }],
  ["POST", "/v1/no-such-route", { liveMicroMaxOrderNotional: "1" }],
];

describe("M-3: a READ-only operator cannot disable the kill switch by filling the audit log", () => {
  it("after five mode-raise refusals from a reader, an authorized GLOBAL engage is EXECUTED and AUDITED (capacity 3)", async () => {
    served = await serveControlApi({ operators: OPERATORS, auditCapacity: 3 });
    const api = served;

    for (const [method, path, body] of READER_MODE_RAISES) {
      const refused = await api.call(method, path, { token: FAKE_READER_TOKEN, body });
      // Still refused BY NAME — the belt is unchanged for every caller.
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect((refused.json() as Record<string, unknown>)["code"]).toBe("CONTROL_MODE_RAISE_REFUSED");
    }

    const engage = await api.call("POST", "/v1/kill-switch", {
      token: FAKE_OPERATOR_TOKEN,
      body: { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "incident: halt everything" },
    });
    expect(engage.status).toBe(200);
    expect(api.controlPlane.killSwitches()).toHaveLength(1);

    // EXECUTED AND AUDITED: the engage is in the log, and it is the only record —
    // the reader wrote nothing.
    const records = api.audit.records();
    expect(records.map((record) => `${record.actor}|${record.action}|${record.outcome}`)).toEqual([
      "operator-a|KILL_SWITCH_ENGAGE|APPLIED",
    ]);
    expect((engage.json() as Record<string, unknown>)["auditRecordId"]).toBe(records[0]?.recordId);
  });

  it("the reader's attempts are still COUNTED, and the refusal says plainly that they were not audited", async () => {
    served = await serveControlApi({ operators: OPERATORS, auditCapacity: 3 });
    const api = served;
    let detail = "";
    for (const [method, path, body] of READER_MODE_RAISES) {
      const refused = await api.call(method, path, { token: FAKE_READER_TOKEN, body });
      detail = String((refused.json() as Record<string, unknown>)["detail"]);
    }
    // It must not CLAIM an audit that did not happen.
    expect(detail).not.toContain("has been audited");
    expect(detail).toContain("NOT audited");
    expect(api.audit.records()).toEqual([]);
    expect(api.controlPlane.modeRaiseAttemptsRefused).toBe(READER_MODE_RAISES.length);

    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_READER_TOKEN });
    expect(metrics.text).toContain(
      `control_mode_raise_attempts_refused_total ${String(READER_MODE_RAISES.length)}`,
    );
    expect(metrics.text).toContain("control_audit_records 0");
    expect(metrics.text).toContain("control_audit_append_failures_total 0");
  });
});
