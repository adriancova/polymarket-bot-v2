/**
 * `CONTROL-1` — `WP-240` r1's owned LOWs, pinned over REAL HTTP.
 *
 * Each `describe` is one finding; each was measured at base `98a814b` with the
 * same request (`CONTROL-1` handoff, "reproductions"):
 *
 * - **L-1** `POST /v1/strategies/%E0%A4%A/pause` answered `500
 *   CONTROL_INTERNAL_ERROR` (`decodeURIComponent` threw outside any door).
 * - **L-2** `POST /v1/strategies/a%2Fb/pause` answered `200` and audited the
 *   `scopeRef` `a/b`.
 * - **L-3** a body declared `text/plain`, or with no content type at all, was
 *   parsed as JSON and acted on. (`CONTROL-1` r1 moved the 415's ANSWER behind
 *   authorization, so an authorized operator's refusal is audited —
 *   `authorized-refusals-audited.test.ts`.)
 * - **L-4** `POST /v1/run-state` answered `404 CONTROL_NO_SUCH_ROUTE`.
 * - **L-6** `NOT_AUDITED` was never asserted on the wire (`WP-240` r1's
 *   mutation M5 survived every unit test).
 * - **L-9** the server ran on Node's default timeouts (five minutes for a
 *   request), set nowhere in this package.
 *
 * L-5 (the route list) and L-8 (instance-map growth) are pinned at the
 * handler seam in `apps/control-api/src/api.test.ts`, where the router and the
 * metrics surface are both in reach.
 */

import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CONTROL_HTTP_TIMEOUTS, isJsonContentType } from "@polymarket-bot/control-api";
import { FAKE_OPERATOR_TOKEN } from "@polymarket-bot/control-api/testing";

import { serveControlApi, type ServedApi, type ServeOptions } from "./support/client.js";

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

async function start(options: ServeOptions = {}): Promise<ServedApi> {
  served = await serveControlApi({ operators: OPERATORS, ...options });
  served.controlPlane.register("sb-1", "2026-09-05T00:00:00.000Z");
  return served;
}

describe("L-1: a malformed route parameter is a 400, not a contained 500", () => {
  it.each(["%E0%A4%A", "%ZZ", "sb-%G1"])("POST /v1/strategies/%s/pause → 400", async (raw) => {
    const api = await start();
    const response = await api.call("POST", `/v1/strategies/${raw}/pause`, {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "a malformed id" },
    });
    expect(response.status).toBe(400);
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_INVALID_ROUTE_PARAMETER");
    // `CONTROL-1` r1 (CONTROL1-J-M2): the authorized operator's refusal is
    // audited, against NO scopeRef — the id never passed its door.
    expect(api.audit.records().map((record) => `${record.action}|${record.outcome}|${String(record.scopeRef)}`)).toEqual([
      "STRATEGY_PAUSE|REFUSED|null",
    ]);
  });
});

describe("L-2: %2F cannot re-admit '/' into an instance id or an audit scopeRef", () => {
  it("POST /v1/strategies/a%2Fb/pause → 400, audited with NO scopeRef (never 'a/b'), nothing inserted", async () => {
    const api = await start();
    api.controlPlane.register("a", "2026-09-05T00:00:00.000Z");
    const response = await api.call("POST", "/v1/strategies/a%2Fb/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "an id with a slash" },
    });
    expect(response.status).toBe(400);
    expect(String((response.json() as Record<string, unknown>)["detail"])).toContain("'/'");
    expect(api.audit.records().map((record) => record.scopeRef)).toEqual([null]);
    expect(JSON.stringify(api.audit.records())).not.toContain("a/b");
    expect(api.controlPlane.strategies().every((entry) => !entry.instanceId.includes("/"))).toBe(true);
    expect(api.controlPlane.strategies().map((entry) => `${entry.instanceId}:${entry.state}`)).toEqual([
      "a:RUNNING",
      "sb-1:RUNNING",
    ]);
  });

  it("a %00 is refused too — PostgreSQL text cannot hold it", async () => {
    const api = await start();
    const response = await api.call("POST", "/v1/strategies/sb%00/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "an id with a NUL" },
    });
    expect(response.status).toBe(400);
  });
});

describe("L-3: a body must be declared application/json", () => {
  it.each([
    ["no content type", null],
    ["text/plain", "text/plain"],
    ["a form", "application/x-www-form-urlencoded"],
    ["a non-UTF-8 charset", "application/json; charset=latin1"],
    ["a lookalike media type", "application/jsonx"],
    ["an unknown parameter", "application/json; boundary=x"],
  ])("REFUSES a body with %s at 415, before acting", async (_case, contentType) => {
    const api = await start();
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "an undeclared body" },
      contentType,
    });
    expect(response.status).toBe(415);
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_UNSUPPORTED_MEDIA_TYPE");
    expect(api.controlPlane.strategies()[0]?.state).toBe("RUNNING");
    // `CONTROL-1` r1 (CONTROL1-J-M2): the 415 is answered after authorization,
    // and the authorized operator's refusal is audited.
    expect(api.audit.records().map((record) => `${record.action}|${record.outcome}|${String(record.scopeRef)}`)).toEqual([
      "STRATEGY_PAUSE|REFUSED|sb-1",
    ]);
    expect(api.audit.records()[0]?.resultingState).toMatchObject({
      refusedAt: "TRANSPORT",
      refusalCode: "CONTROL_UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it.each([
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
    'application/json; charset="utf-8"',
  ])("ACCEPTS %s", async (contentType) => {
    const api = await start();
    const response = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "a declared body" },
      contentType,
    });
    expect(response.status).toBe(200);
  });

  it("a body-less request needs no content type", async () => {
    const api = await start();
    const response = await api.call("GET", "/v1/run-state", { token: FAKE_OPERATOR_TOKEN, contentType: null });
    expect(response.status).toBe(200);
  });

  it("the predicate is total over strange header values", () => {
    for (const value of [undefined, "", ";", "application/json;", "application/json; =utf-8", "application/json; charset"]) {
      expect(() => isJsonContentType(value)).not.toThrow();
    }
    expect(isJsonContentType("application/json;")).toBe(true);
    expect(isJsonContentType("application/json; charset")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe("L-4: 405 with an Allow header, on the wire", () => {
  it("POST /v1/run-state → 405 Allow: GET", async () => {
    const api = await start();
    const response = await api.call("POST", "/v1/run-state", {
      token: FAKE_OPERATOR_TOKEN,
      body: { reason: "a write to a read" },
    });
    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe("GET");
    expect((response.json() as Record<string, unknown>)["code"]).toBe("CONTROL_METHOD_NOT_ALLOWED");
  });

  it("DELETE /v1/kill-switch → 405 Allow: GET, POST; an unknown path stays 404 with no Allow", async () => {
    const api = await start();
    const wrongMethod = await api.call("DELETE", "/v1/kill-switch", { token: FAKE_OPERATOR_TOKEN });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers["allow"]).toBe("GET, POST");
    const unknown = await api.call("GET", "/v1/nothing-here", { token: FAKE_OPERATOR_TOKEN });
    expect(unknown.status).toBe(404);
    expect(unknown.headers["allow"]).toBeUndefined();
  });

  it("every response still carries no-store and nosniff", async () => {
    const api = await start();
    for (const [method, path] of [
      ["GET", "/v1/run-state"],
      ["POST", "/v1/run-state"],
      ["GET", "/v1/nothing-here"],
    ] as const) {
      const response = await api.call(method, path, { token: FAKE_OPERATOR_TOKEN });
      expect(response.headers["cache-control"], `${method} ${path}`).toBe("no-store");
      expect(response.headers["x-content-type-options"], `${method} ${path}`).toBe("nosniff");
    }
  });
});

describe("L-6: NOT_AUDITED reaches the wire, and APPLIED does not absorb it", () => {
  it("a pause the full log cannot record is counted NOT_AUDITED on /v1/metrics", async () => {
    const api = await start({ auditCapacity: 1 });
    api.controlPlane.register("sb-2", "2026-09-05T00:00:00.000Z");
    expect(
      (await api.call("POST", "/v1/strategies/sb-1/pause", { token: FAKE_OPERATOR_TOKEN, body: { reason: "fits" } }))
        .status,
    ).toBe(200);
    expect(
      (
        await api.call("POST", "/v1/strategies/sb-2/pause", {
          token: FAKE_OPERATOR_TOKEN,
          body: { reason: "does not fit" },
        })
      ).status,
    ).toBe(503);

    const metrics = await api.call("GET", "/v1/metrics", { token: FAKE_OPERATOR_TOKEN });
    expect(metrics.text).toContain('control_mutations_total{action="STRATEGY_PAUSE",outcome="APPLIED"} 1');
    expect(metrics.text).toContain('control_mutations_total{action="STRATEGY_PAUSE",outcome="NOT_AUDITED"} 1');
    expect(metrics.text).not.toContain('control_mutations_total{action="STRATEGY_PAUSE",outcome="APPLIED"} 2');
    expect(metrics.text).toContain("control_audit_append_failures_total 1");
  });
});

describe("L-9: the server's timeouts are explicit, and enforced", () => {
  it("the shipped timeouts are this package's constants, read back from the listening server", async () => {
    const api = await start();
    expect(api.server.timeouts).toEqual({
      headersTimeoutMs: CONTROL_HTTP_TIMEOUTS.headersTimeoutMs,
      requestTimeoutMs: CONTROL_HTTP_TIMEOUTS.requestTimeoutMs,
      keepAliveTimeoutMs: CONTROL_HTTP_TIMEOUTS.keepAliveTimeoutMs,
    });
    expect(CONTROL_HTTP_TIMEOUTS).toEqual({
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      keepAliveTimeoutMs: 5_000,
      connectionsCheckingIntervalMs: 1_000,
    });
    // Node's defaults are 60 s and 300 s; these are explicit and tighter.
    expect(CONTROL_HTTP_TIMEOUTS.requestTimeoutMs).toBeLessThan(300_000);
  });

  /** Opens a raw socket, writes `bytes`, and resolves with what came back and when the server hung up. */
  function dribble(port: number, bytes: string): Promise<{ readonly answer: string; readonly closedAfterMs: number }> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const chunks: Buffer[] = [];
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(bytes);
      });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => {
        resolve({ answer: Buffer.concat(chunks).toString("utf8"), closedAfterMs: Date.now() - startedAt });
      });
      setTimeout(() => {
        socket.destroy();
      }, 10_000).unref();
    });
  }

  const SHORT = {
    headersTimeoutMs: 300,
    requestTimeoutMs: 600,
    keepAliveTimeoutMs: 1_000,
    connectionsCheckingIntervalMs: 50,
  } as const;

  it("a client that never finishes its headers is answered 408 and disconnected within the bound", async () => {
    const api = await start({ timeouts: SHORT });
    const port = Number(new URL(api.url).port);
    const { answer, closedAfterMs } = await dribble(port, "GET /v1/run-state HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    expect(answer).toContain("408");
    expect(closedAfterMs).toBeGreaterThanOrEqual(SHORT.headersTimeoutMs - 50);
    expect(closedAfterMs).toBeLessThan(5_000);
  });

  it("a client that never finishes its body is answered 408 within the request bound, and nothing is acted on", async () => {
    const api = await start({ timeouts: SHORT });
    const port = Number(new URL(api.url).port);
    const { answer, closedAfterMs } = await dribble(
      port,
      "POST /v1/strategies/sb-1/pause HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
        `Authorization: Bearer ${FAKE_OPERATOR_TOKEN}\r\nContent-Type: application/json\r\n` +
        'Content-Length: 200\r\n\r\n{"reason":',
    );
    expect(answer).toContain("408");
    expect(closedAfterMs).toBeLessThan(5_000);
    expect(api.controlPlane.strategies()[0]?.state).toBe("RUNNING");
    expect(api.audit.records()).toEqual([]);
  });
});
