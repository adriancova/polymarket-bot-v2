/**
 * `TRDR-3` — the REAL `HttpTraderHealthSource` reads the trader's REAL health
 * server, and an exact decimal survives the whole path byte for byte.
 *
 * ## Why this file lives here
 *
 * `apps/control-api` may not import `apps/trader` (dependency-direction F10),
 * and `test/integration/paper-trader/**` aliases no control-api package. This
 * tree is the one place that aliases both (`trader-health-shape.test.ts`'s
 * precedent), so it is where the two halves of the seam meet IN-PROCESS:
 * `startTraderHealthServer` from `apps/trader/src/health-server.ts` on one
 * side, `HttpTraderHealthSource` + `readTraderHealthReport` +
 * `traderHealthSamples` + `renderExpositionFor` on the other. No stub on
 * either end. (The Testcontainers acceptance in
 * `test/integration/paper-trader/trader-health-endpoint-postgres.test.ts`
 * starts the same server through the real composition root and reads it with
 * `node:http`, for the reason above.)
 *
 * ## Acceptance (c): no float anywhere on the PnL path
 *
 * The realized PnL recorded into the trader's `RealizedPnlBook` is
 * `"0.1000000000000000055511151231257827"` — the exact decimal expansion of the
 * float64 nearest 0.1, a value float64 itself cannot hold — and a 20-digit
 * integer. Both come out of the rendered exposition as the same bytes, and
 * the exact sum the trader computed is the `addDecimal` result, not a float.
 */

import { request as httpRequest } from "node:http";

import { readTraderHealthReport, HttpTraderHealthSource, TraderHealthCache } from "@polymarket-bot/control-api";
import {
  PLATFORM_METRIC_FAMILIES,
  renderExpositionFor,
  traderHealthSamples,
} from "@polymarket-bot/observability";
import {
  HealthState,
  RealizedPnlBook,
  TRADER_HEALTH_BOUNDS,
  healthResponseBody,
  startTraderHealthServer,
  type HealthSnapshot,
  type RunningTraderHealthServer,
} from "@polymarket-bot/trader";
import { afterEach, describe, expect, it } from "vitest";

const UNREPRESENTABLE = "0.1000000000000000055511151231257827";
const TWENTY_DIGITS = "-12345678901234567890";
/** `addDecimal(addDecimal("0", "-12345678901234567890"), "0.1000000000000000055511151231257827")`, by hand. */
const EXACT_SUM = "-12345678901234567889.8999999999999999944488848768742173";

function realSnapshot(): { readonly state: HealthState; readonly snapshot: () => HealthSnapshot } {
  const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
  const book = new RealizedPnlBook();
  book.record({ instanceId: "sb-b", realizedPnl: UNREPRESENTABLE });
  book.record({ instanceId: "sb-a", realizedPnl: TWENTY_DIGITS });
  state.attachRealizedPnl(book);
  state.countAccounting("pnlRecords", 2);
  state.countLoop("eventsAccepted", 5);
  const snapshot = (): HealthSnapshot =>
    state.snapshot({
      asOf: "2026-09-16T00:00:20Z",
      halts: [],
      queues: [],
      seams: {
        fills: { remembered: 0, maximumRemembered: 1, admitted: 0, refused: 0, evictions: 0 },
        reservations: { open: 0, taken: 0, released: 0, reservedCollateral: "0" },
        cancels: { pending: 0, requested: 0, confirmed: 0, rejected: 0, silenceExceeded: 0 },
        orderViews: { emitted: 0, repeats: 0, tracked: 0 },
        allocator: { open: 0, applied: 0, released: 0, reservedCollateral: "0", refusalsByCode: {} },
      },
    });
  return { state, snapshot };
}

function raw(
  port: number,
  options: { readonly method: string; readonly path: string; readonly body?: string },
): Promise<{ readonly status: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers:
          options.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(options.body, "utf8")) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe("the REAL HttpTraderHealthSource against the trader's REAL health server (TRDR-3)", () => {
  let server: RunningTraderHealthServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reads the report through the door; realized PnL arrives as the exact bytes the trader wrote (acceptance c)", async () => {
    const { snapshot } = realSnapshot();
    const lines: string[] = [];
    server = await startTraderHealthServer({
      listen: { host: "127.0.0.1", port: 0 },
      snapshot,
      log: (line) => lines.push(line),
    });
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}/health`);

    const source = new HttpTraderHealthSource({ url: server.url, timeoutMs: 2000, maxBodyBytes: 4_194_304 });
    const cache = new TraderHealthCache(source);
    const read = await cache.refresh();
    expect(read.outcome === "OK" ? "OK" : `${read.outcome}: ${"detail" in read ? read.detail : ""}`).toBe("OK");
    expect(cache.available).toBe(true);
    expect(cache.current).toBe(true);
    const report = cache.last();
    expect(report).toBeDefined();
    if (report === undefined) return;

    // The door's output carries the trader's bytes, sorted by instance id.
    expect(report.accounting.realizedPnl.byInstance).toEqual({
      "sb-a": TWENTY_DIGITS,
      "sb-b": UNREPRESENTABLE,
    });
    expect(report.accounting.realizedPnl.account).toBe(EXACT_SUM);
    expect(report.loop.eventsAccepted).toBe(5);

    // …and so does the rendered exposition, as `_info` labels, value 1.
    const exposition = renderExpositionFor(PLATFORM_METRIC_FAMILIES, traderHealthSamples(report));
    expect(exposition).toContain(
      `trader_realized_pnl_info{instance_id="sb-a",exact_decimal="${TWENTY_DIGITS}"} 1`,
    );
    expect(exposition).toContain(
      `trader_realized_pnl_info{instance_id="sb-b",exact_decimal="${UNREPRESENTABLE}"} 1`,
    );
    expect(exposition).toContain(`trader_account_realized_pnl_info{exact_decimal="${EXACT_SUM}"} 1`);
    // The float round trips a value-typed metric would have taken.
    expect(String(Number(UNREPRESENTABLE))).toBe("0.1");
    expect(String(Number(TWENTY_DIGITS))).not.toBe(TWENTY_DIGITS);
    expect(server.counts.served).toBe(1);
    expect(lines).toEqual([]);
  });

  it("serves EXACTLY healthResponseBody(snapshot) as application/json, and the snapshot is taken per request", async () => {
    const { state, snapshot } = realSnapshot();
    server = await startTraderHealthServer({
      listen: { host: "127.0.0.1", port: 0 },
      snapshot,
      log: () => undefined,
    });
    const first = await raw(server.port, { method: "GET", path: "/health" });
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body).toBe(healthResponseBody(snapshot()));
    // A query string does not change the route, and the read is not cached.
    state.countLoop("eventsAccepted");
    const second = await raw(server.port, { method: "GET", path: "/health?anything=1" });
    expect(second.status).toBe(200);
    expect(second.body).toBe(healthResponseBody(snapshot()));
    expect(second.body).not.toBe(first.body);
    expect((JSON.parse(second.body) as { loop: { eventsAccepted: number } }).loop.eventsAccepted).toBe(6);
    // The door accepts what the wire carried.
    expect(readTraderHealthReport(JSON.parse(second.body)).ok).toBe(true);
  });

  it("refuses every other method and path with a fixed body that reflects nothing of the request", async () => {
    const { snapshot } = realSnapshot();
    server = await startTraderHealthServer({
      listen: { host: "127.0.0.1", port: 0 },
      snapshot,
      log: () => undefined,
    });
    const post = await raw(server.port, { method: "POST", path: "/health", body: '{"runMode":"LIVE"}' });
    expect(post.status).toBe(405);
    expect(post.headers["allow"]).toBe("GET");
    expect(post.body).toBe(
      '{"code":"TRADER_HEALTH_METHOD_NOT_ALLOWED","detail":"only GET /health is served; this endpoint accepts no mutation"}\n',
    );
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      expect((await raw(server.port, { method, path: "/health" })).status, method).toBe(405);
    }
    for (const path of ["/", "/health/", "/healthz", "/v1/health", "/metrics", "/health/../health"]) {
      const answer = await raw(server.port, { method: "GET", path });
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).toBe(
        '{"code":"TRADER_HEALTH_NO_SUCH_PATH","detail":"only GET /health is served"}\n',
      );
      expect(answer.body).not.toContain(path === "/" ? "healthz" : path);
    }
    // A GET carrying a body past the bound is refused 413 and the connection closed.
    const tooLarge = await raw(server.port, {
      method: "GET",
      path: "/health",
      body: "x".repeat(TRADER_HEALTH_BOUNDS.maxRequestBodyBytes + 1),
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers["connection"]).toBe("close");
    expect(tooLarge.body).toBe(
      '{"code":"TRADER_HEALTH_BODY_TOO_LARGE","detail":"a health read carries no body; more than 1024 bytes are refused and the connection is closed"}\n',
    );
    // …while a small body is discarded and the read is served.
    expect((await raw(server.port, { method: "GET", path: "/health", body: "x" })).status).toBe(200);
    // 1 POST + 5 methods + 6 paths + 1 oversized body.
    expect(server.counts.refused).toBe(13);
    expect(server.counts.failed).toBe(0);
    // The run mode the POST named changed nothing: there is no path that could.
    expect((JSON.parse((await raw(server.port, { method: "GET", path: "/health" })).body) as HealthSnapshot).runMode).toBe("PAPER");
  });

  it("answers 500 with the encoder's refusal kind when the snapshot is not plain, and the trader keeps serving", async () => {
    const lines: string[] = [];
    let poisoned = false;
    const { snapshot } = realSnapshot();
    // An `Array` subclass IS a `readonly HaltRecord[]` to the type system and
    // is NOT plain to the encoder (the `SER-3` species class): no cast needed
    // to reach the refusal path.
    class ForeignHalts extends Array<HealthSnapshot["halts"][number]> {}
    server = await startTraderHealthServer({
      listen: { host: "127.0.0.1", port: 0 },
      snapshot: () => (poisoned ? { ...snapshot(), halts: new ForeignHalts() } : snapshot()),
      log: (line) => lines.push(line),
    });
    poisoned = true;
    const failed = await raw(server.port, { method: "GET", path: "/health" });
    expect(failed.status).toBe(500);
    expect(failed.body).toBe(
      '{"code":"TRADER_HEALTH_UNAVAILABLE","detail":"the health snapshot could not be produced or encoded (NON_PLAIN at value.halts)"}\n',
    );
    expect(lines).toEqual(["health endpoint: the snapshot could not be served (NON_PLAIN at value.halts)"]);
    // The source reports it as data — an UNAVAILABLE read, counted — and the
    // server is still there for the next, plain snapshot.
    const cache = new TraderHealthCache(
      new HttpTraderHealthSource({ url: server.url, timeoutMs: 2000, maxBodyBytes: 4_194_304 }),
    );
    expect((await cache.refresh()).outcome).toBe("UNAVAILABLE");
    poisoned = false;
    expect((await cache.refresh()).outcome).toBe("OK");
    expect(server.counts.failed).toBe(2);
    expect(server.counts.served).toBe(1);
  });
});
