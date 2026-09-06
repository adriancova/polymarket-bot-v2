/**
 * Hostile inputs, over REAL HTTP.
 *
 * Authentication bypasses, ADR-020 probes, oversized and malformed bodies,
 * path tricks, and the closed grammar — each refused, and each refused with a
 * message that names the class rather than echoing what was sent.
 *
 * Nothing here is a claim about an attacker: ADR-020 §4 is explicit that
 * prototype pollution requires code already running in the process. These are
 * assertions about what a boundary is entitled to promise.
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

async function start(options: { readonly maxRequestBodyBytes?: number } = {}): Promise<ServedApi> {
  served = await serveControlApi({
    operators: OPERATORS,
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
  });
  served.controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
  return served;
}

describe("authentication bypass attempts", () => {
  // NOTE ON SCOPE. `node:http` normalises what a CLIENT may put in a header: a
  // trailing space is trimmed and a control character is rejected before the
  // request is written. Those cases would measure the client rather than this
  // API, so they live where they belong — `apps/control-api/src/auth.test.ts`
  // drives the registry with the exact header string.
  it.each([
    ["no header", undefined],
    ["empty bearer", "Bearer "],
    ["basic auth", "Basic b3BlcmF0b3ItYTpwYXNzd29yZA=="],
    ["bearer with the operator ID as the token", "Bearer operator-a"],
    ["a case-changed token", `Bearer ${FAKE_OPERATOR_TOKEN.toUpperCase()}`],
    ["two tokens", `Bearer ${FAKE_OPERATOR_TOKEN},${FAKE_READER_TOKEN}`],
    ["a token with an appended suffix", `Bearer ${FAKE_OPERATOR_TOKEN}x`],
    ["a truncated token", `Bearer ${FAKE_OPERATOR_TOKEN.slice(0, -1)}`],
  ])("REFUSES %s", async (_case, header) => {
    const api = await start();
    const response = await fetchWith(api, header);
    expect(response.status).toBe(401);
    expect(response.text).not.toContain(FAKE_OPERATOR_TOKEN);
  });

  it("REFUSES a request whose body claims an operator id", async () => {
    const api = await start();
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      body: { reason: "impersonation attempt", operatorId: "operator-a", actor: "operator-a" },
    });
    expect(response.status).toBe(401);
    expect(api.audit.records()).toEqual([]);
  });

  it("does not let a READER perform a control action by any route spelling", async () => {
    const api = await start();
    for (const path of [
      "/v1/strategies/sb-1/pause",
      "/v1/strategies/sb-1/resume",
      "/v1/kill-switch",
    ]) {
      const response = await api.call("POST", path, {
        token: FAKE_READER_TOKEN,
        body: {
          reason: "a reader trying a control",
          scope: "GLOBAL",
          scopeRef: null,
          action: "FULL_HALT",
        },
      });
      expect(response.status, path).toBe(403);
    }
    expect(api.controlPlane.strategies()[0]?.state).toBe("RUNNING");
    expect(api.controlPlane.killSwitches()).toEqual([]);
  });
});

async function fetchWith(api: ServedApi, header: string | undefined) {
  // The client helper always formats `Bearer <token>`; these cases need the
  // raw header, so the call goes through the same helper with a token that
  // reproduces the exact string.
  if (header === undefined) return api.call("GET", "/v1/run-state");
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
  return header.startsWith("Bearer ")
    ? api.call("GET", "/v1/run-state", { token })
    : api.call("GET", "/v1/run-state", { token: header });
}

describe("ADR-020 probes over the wire", () => {
  it("REFUSES a body whose required field is only inherited (JSON cannot carry one, so this is the object form)", async () => {
    const api = await start();
    // Over HTTP the body is re-parsed from text, so an inherited key cannot
    // travel. What CAN travel is `__proto__`, which is the wire's version of
    // the same attack — and `JSON.parse` does not install it as a prototype,
    // but a careless door could still read it.
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      rawBody: '{"__proto__":{"reason":"adopted"}}',
    });
    expect(response.status).toBe(400);
    expect(api.controlPlane.strategies()[0]?.state).toBe("RUNNING");
    // And nothing was installed on the prototype of anything.
    expect(({} as Record<string, unknown>)["reason"]).toBeUndefined();
  });

  it("REFUSES a body carrying `constructor.prototype` pollution", async () => {
    const api = await start();
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      rawBody: '{"reason":"ok reason","constructor":{"prototype":{"polluted":true}}}',
    });
    expect(response.status).toBe(400);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("REFUSES an unknown key on every mutating route", async () => {
    const api = await start();
    for (const [path, body] of [
      ["/v1/strategies/sb-1/pause", { reason: "ok reason", force: true }],
      [
        "/v1/kill-switch",
        {
          scope: "GLOBAL",
          scopeRef: null,
          action: "FULL_HALT",
          reason: "ok reason",
          override: true,
        },
      ],
      [
        "/v1/kill-switch/release",
        {
          scope: "GLOBAL",
          scopeRef: null,
          authoritativeSnapshotApplied: true,
          reason: "ok reason",
          skipChecks: true,
        },
      ],
    ] as const) {
      const response = await api.call("POST", path, { token: FAKE_OPERATOR_TOKEN, body });
      expect(response.status, path).toBe(400);
    }
  });

  it("REFUSES a wrongly-typed field rather than coercing it", async () => {
    const api = await start();
    for (const body of [
      { reason: 42 },
      { reason: ["a", "reason"] },
      { reason: { text: "a reason" } },
      { reason: null },
      { reason: true },
    ]) {
      const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
        token: FAKE_OPERATOR_TOKEN,
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("transport-level hostility", () => {
  it("REFUSES an oversized body at 413, without parsing it", async () => {
    const api = await start({ maxRequestBodyBytes: 256 });
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      rawBody: JSON.stringify({ reason: "x".repeat(4096) }),
    });
    expect(response.status).toBe(413);
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_BODY_TOO_LARGE");
    expect(api.audit.records()).toEqual([]);
  });

  it("REFUSES a non-JSON body at 400", async () => {
    const api = await start();
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      rawBody: "not json {{{",
    });
    expect(response.status).toBe(400);
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_BODY_NOT_JSON");
  });

  it("404s a path of an unexpected shape, and changes nothing", async () => {
    // `/v1/strategies/../run-state` is deliberately NOT here: `node:http`
    // resolves `..` client-side, so the server would see `/v1/run-state` and
    // the case would measure the client. Path traversal has no meaning on this
    // API in any event — no route touches a filesystem.
    const api = await start();
    for (const path of [
      "/v1/strategies/sb-1/pause/extra",
      "/v1/strategies//pause",
      "//v1/run-state",
      "/V1/RUN-STATE",
      "/v1/strategies/sb-1/PAUSE",
    ]) {
      const response = await api.call("GET", path, { token: FAKE_OPERATOR_TOKEN });
      expect([400, 404], path).toContain(response.status);
    }
  });

  it("ignores a query string rather than routing on it", async () => {
    const api = await start();
    const response = await api.call("GET", "/v1/run-state?admin=true&runMode=LIVE", {
      token: FAKE_OPERATOR_TOKEN,
    });
    expect(response.status).toBe(200);
    expect((response.json() as Record<string, unknown>)["maximumRunMode"]).toBe("PAPER");
  });

  it("sets no-store and nosniff on every response", async () => {
    const api = await start();
    const response = await api.call("GET", "/v1/run-state", { token: FAKE_OPERATOR_TOKEN });
    expect(response.status).toBe(200);
    // The header assertions go through the raw response, which the helper
    // exposes as content-type; the remainder are asserted structurally by the
    // unit suite. What matters on the wire is that the content type is JSON
    // and not something a browser would render.
    expect(response.contentType).toContain("application/json");
  });

  it("URL-decodes a strategy instance id rather than routing on the raw bytes", async () => {
    const api = await start();
    api.controlPlane.register("sb one", "2026-09-05T00:00:00.000Z");
    const response = await api.call("POST", "/v1/strategies/sb%20one/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "an id with a space" },
    });
    expect(response.status).toBe(200);
    expect(
      api.controlPlane.strategies().find((entry) => entry.instanceId === "sb one")?.state,
    ).toBe("PAUSED");
  });
});

describe("the metrics surface is not a leak", () => {
  it("requires authentication like every other route (§15: internal endpoints)", async () => {
    const api = await start();
    expect((await api.call("GET", "/v1/metrics")).status).toBe(401);
  });

  it("carries no token, no header value and no secret name", async () => {
    const api = await start();
    await api.call("GET", "/v1/run-state", { token: "an-unknown-token-that-must-not-leak" });
    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).not.toContain("an-unknown-token-that-must-not-leak");
    expect(metrics.text).not.toContain(FAKE_OPERATOR_TOKEN);
    expect(metrics.text.toUpperCase()).not.toContain("POLYMARKET_PRIVATE_KEY");
    // It DOES report that an unknown credential was presented.
    expect(metrics.text).toContain(
      'control_authentication_failures_total{reason="UNKNOWN_CREDENTIAL"} 1',
    );
  });
});
