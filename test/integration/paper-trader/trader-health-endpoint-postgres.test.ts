/**
 * `TRDR-3` acceptance (a) — the REAL composition root serves its health over
 * the loopback, and the realized PnL it serves is the PnL engine's own value,
 * exact, after a round trip the durable store persisted (`GOV-2B` B5, code
 * half).
 *
 * ## What runs
 *
 * `assembleDurableTrader` — the process's own step 3b/4/4b — against a real
 * PostgreSQL (Testcontainers, as `BOOT-1`), with `healthListen` from the REAL
 * env door (`readHealthServerEnv` over `TRADER_HEALTH_BIND=127.0.0.1`,
 * `TRADER_HEALTH_PORT=0`). The registration act is `BOOT-1`'s, through the
 * `WP-040` repositories (`support/registration.ts`). The drive is `BOOT-1`'s
 * six events (entry: BUY 50 YES @ 0.34, one level) plus TWO more — a refreshed
 * YES book just before the close and `MarketClosing` inside
 * `exit_cutoff_before_close_seconds` — which is exactly what makes the Static
 * Bracket emit its `PROTECTED_REDUCE` exit (`test/e2e/support/scenario.ts`,
 * event 8; `RISK-2`), filling SELL 50 YES @ 0.32 against the bid.
 *
 * ## The number, derived from the fills (as the e2e golden's `-1.2` is)
 *
 * This fixture's fee schedule is taker `0`, maker `0`, so realized PnL is
 * proceeds minus cost: `50 × 0.32 − 50 × 0.34 = 16 − 17 = −1`. The test does
 * not assume that: it folds the venue's OWN fills with `@polymarket-bot/decimal`
 * (SELL proceeds minus BUY cost, exact) and asserts the served string equals
 * the fold, and separately that it equals the `realized_pnl` column of the
 * LAST `accounting.pnl_snapshots` row the store persisted. `Number(...)`
 * appears nowhere on the path or in the assertion.
 *
 * ## The clock (`CO2-N1`, ADR-031)
 *
 * The round trip's assembly used to take the host's `SystemPaperClock` as-is.
 * ADR-031's entry guard reads the trader's clock at admission, and against
 * the fixture's `2026-03-04` events that clock is months late: the entry was
 * refused and nothing round-tripped. The round trip now takes the same host
 * clock re-based to the fixture's first event (`support/host-clock.ts`): read
 * live, advancing in real time, so the lag is the real processing delay. The
 * two bind-refusal cases route no event and keep the clock as-is.
 *
 * ## Why the read is `node:http` here
 *
 * `test/integration/paper-trader/**` aliases no `apps/control-api` module, and
 * adding one would make a second tree that aliases two apps (the control-api
 * suite's own header calls itself "the ONLY place in the repository that
 * may"). So this file reads the served bytes with `node:http` and asserts they
 * are EXACTLY `healthResponseBody(trader.loop.health())`; the REAL
 * `HttpTraderHealthSource` is driven against the REAL health server in
 * `test/integration/control-api/trader-health-http-source.test.ts`, and the
 * SHIPPED control API's refresh in `health-refresh-wiring.test.ts` there.
 *
 * ## Docker
 *
 * Testcontainers, as `durable-trader-first-fill-postgres.test.ts`: its own
 * `beforeAll`, no `globalSetup`, no skip when Docker is absent. Throwaway
 * credentials; `environment` is `PAPER` throughout; no venue, no signer, no
 * real order; the endpoint binds `127.0.0.1` on an ephemeral port and is
 * closed afterwards.
 */

import { request as httpRequest } from "node:http";

import { addDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import { startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import {
  healthResponseBody,
  parseTraderConfig,
  readHealthServerEnv,
  type HealthSnapshot,
  type IngestedEvent,
} from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assembleDurableTrader,
  EXIT_CODES,
  SystemPaperClock,
} from "../../../apps/trader/src/main.js";
import {
  T_CLOSE,
  YES_TOKEN,
  ingested,
  recordedEvents,
  safeEnvironment,
} from "./support/fixture.js";
import { FIXTURE_FIRST_EVENT_AT, RebasedSystemPaperClock } from "./support/host-clock.js";
import {
  CONDITION_ID,
  documentFor,
  registerThroughTheRepositories,
  withFreshDatabase,
} from "./support/registration.js";

let container: Awaited<ReturnType<typeof startPostgresContainer>>;

beforeAll(async () => {
  container = await startPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

/**
 * The round trip: `BOOT-1`'s six events (entry), then the book refreshed just
 * before the close and `MarketClosing` 10 s before `T_CLOSE` — inside the
 * configured 20 s exit cutoff — so `final_policy: PROTECTED_REDUCE` fires.
 * Without the refreshed book the 12:00 snapshot is ~15 minutes old by the
 * close and `data_quality.on_stale_book` would fire first (the e2e scenario's
 * own note). `recordedEvents` resets the fixture's id counter, so the two
 * extra events mint ordinals 7 and 8.
 */
function roundTripEvents(marketId: string, conditionId: string): readonly IngestedEvent[] {
  const entry = recordedEvents(marketId, conditionId);
  return Object.freeze([
    ...entry,
    ingested(
      "BookSnapshot",
      {
        internalMarketId: marketId,
        tokenId: YES_TOKEN,
        bids: [
          { price: "0.32", size: "200" },
          { price: "0.31", size: "300" },
        ],
        asks: [{ price: "0.36", size: "40" }],
      },
      { receivedAt: "2026-03-04T12:14:49.000Z", ingestSeq: 7 },
    ),
    ingested(
      "MarketClosing",
      { internalMarketId: marketId, conditionId, closesAt: T_CLOSE },
      { receivedAt: "2026-03-04T12:14:50.000Z", ingestSeq: 8 },
    ),
  ]);
}

function get(url: string): Promise<{ readonly status: number; readonly contentType: string; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the REAL composition root serves its health endpoint, and realized PnL reaches it exactly (TRDR-3 acceptance a)", () => {
  it("registers, assembles with the endpoint, round-trips a bracket, and GET /health serves the PnL engine's own realized PnL", async () => {
    await withFreshDatabase(container.getConnectionUri(), "trdr3-health", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "trdr3-health");
      const document = documentFor(registered, "trdr3-health");
      const parsed = parseTraderConfig(document);
      if (!parsed.ok) throw new Error(parsed.refusal.issues.join("; "));

      // The REAL env door, over the two variables the process reads.
      const env = { ...safeEnvironment(), TRADER_HEALTH_BIND: "127.0.0.1", TRADER_HEALTH_PORT: "0" };
      const healthEnv = readHealthServerEnv(env);
      expect(healthEnv.ok).toBe(true);
      if (!healthEnv.ok || healthEnv.listen === undefined) throw new Error("the env door refused the loopback bind");

      const lines: string[] = [];
      const result = await assembleDurableTrader({
        env,
        config: parsed.config,
        document,
        postgresUrl: connectionString,
        // `CO2-N1` (ADR-031): the host's clock, re-based to the fixture's first event.
        clock: new RebasedSystemPaperClock(FIXTURE_FIRST_EVENT_AT),
        log: (line) => {
          lines.push(line);
        },
        healthListen: healthEnv.listen,
      });
      expect(result.ok ? "ok" : lines.join("\n")).toBe("ok");
      if (!result.ok) throw new Error("unreachable");
      const { trader, store, healthServer } = result;
      expect(healthServer).toBeDefined();
      if (healthServer === undefined) throw new Error("the endpoint was asked for and not started");
      expect(lines.join("\n")).toContain(`health endpoint: listening on ${healthServer.url}`);
      expect(healthServer.url).toBe(`http://127.0.0.1:${String(healthServer.port)}/health`);

      try {
        // --- before any event: served, and "no snapshot observed" -----------
        const fresh = await get(healthServer.url);
        expect(fresh.status).toBe(200);
        expect(fresh.contentType).toBe("application/json; charset=utf-8");
        const before = JSON.parse(fresh.body) as HealthSnapshot;
        expect(before.accounting.realizedPnl).toEqual({ byInstance: {}, account: null });
        expect(before.execution.fillsObserved).toBe(0);

        // --- the round trip, on the real loop ---------------------------------
        for (const event of roundTripEvents(registered.marketId, `${CONDITION_ID}-trdr3-health`)) {
          expect(trader.loop.ingest(event)).toBe(true);
        }
        await trader.loop.drain();

        const health = trader.loop.health();
        expect(health.halts).toEqual([]);
        expect(health.execution.fillsObserved).toBe(2);
        expect(health.risk.refusedExits).toBe(0);

        // --- the served bytes ARE the snapshot, encoded from own data ---------
        const served = await get(healthServer.url);
        expect(served.status).toBe(200);
        expect(served.body).toBe(healthResponseBody(trader.loop.health()));
        const report = JSON.parse(served.body) as HealthSnapshot;
        expect(healthServer.counts).toEqual({ served: 2, refused: 0, failed: 0 });

        // --- the number, derived from the fills -------------------------------
        // The venue is private to the composition root, so the fill legs are
        // read as the §9.16 TRADE records the loop retained — each one is
        // `buildFillPosting`'s own derivation of one fill (side, shares,
        // price), two fills, two §6 invariant 4 chains. SELL proceeds minus
        // BUY cost, folded exactly; fees are 0 in this fixture's schedule, so
        // this IS realized PnL.
        expect(trader.loop.traces()).toHaveLength(2);
        const legs = trader.loop
          .pnlRecords(registered.instanceId)
          .flatMap((record) => (record.kind === "TRADE" ? [record] : []));
        expect(legs.map((leg) => `${leg.side} ${leg.shares} @ ${leg.price}`)).toEqual([
          "BUY 50 @ 0.34",
          "SELL 50 @ 0.32",
        ]);
        let realized = "0";
        for (const leg of legs) {
          const notional = mulDecimal(leg.shares, leg.price);
          realized = leg.side === "SELL" ? addDecimal(realized, notional) : subDecimal(realized, notional);
        }
        // 50 × 0.32 − 50 × 0.34 = 16 − 17.
        expect(realized).toBe("-1");
        expect(report.accounting.realizedPnl).toEqual({
          byInstance: { [registered.instanceId]: realized },
          account: realized,
        });

        // --- and it is the value the durable store holds, byte for byte -------
        const rows = await context.db
          .selectFrom("accounting.pnl_snapshots")
          .select(["realized_pnl", "as_of", "instance_id"])
          .where("run_id", "=", registered.runId)
          .orderBy("as_of")
          .execute();
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.realized_pnl)).toEqual(["0", "-1"]);
        expect(rows[1]?.instance_id).toBe(registered.instanceId);
        expect(rows[1]?.realized_pnl).toBe(report.accounting.realizedPnl.account);
        expect(typeof rows[1]?.realized_pnl).toBe("string");
      } finally {
        await healthServer.close();
        await store.close();
      }

      // Closed: the port answers nothing.
      await expect(get(healthServer.url)).rejects.toThrow();
    });
  }, 120_000);

  it("REFUSES a non-loopback bind before any database is opened, with a typed code and exit 78", async () => {
    const env = { ...safeEnvironment(), TRADER_HEALTH_BIND: "0.0.0.0", TRADER_HEALTH_PORT: "9470" };
    const refused = readHealthServerEnv(env);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("TRADER_HEALTH_BIND_REFUSED");
    // …and the process's startup turns that into exit 78 before REDIS_URL or
    // DATABASE_URL are so much as read: `startup()` is driven here with an
    // unreachable pair and refuses on the bind first.
    const { startup } = await import("../../../apps/trader/src/main.js");
    const lines: string[] = [];
    const code = await startup({
      env: {
        ...env,
        TRADER_CONFIG_PATH: "/config.json",
        REDIS_URL: "redis://127.0.0.1:1",
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/nowhere",
      },
      readConfig: () => Promise.resolve(JSON.stringify(documentFor(
        { marketId: "018f4a7e-1111-7abc-8def-0123456789ab", definitionId: "", configId: "018f4a7e-4444-7abc-8def-0123456789ab", instanceId: "a18f4a7e-2222-7abc-8def-0123456789ab", runId: "018f4a7e-3333-7abc-8def-0123456789ab" },
        "refused",
      ))),
      log: (line) => {
        lines.push(line);
      },
    });
    expect(code).toBe(EXIT_CODES.configurationRefused);
    expect(lines.join("\n")).toContain("REFUSING TO START: TRADER_HEALTH_BIND_REFUSED");
    expect(lines.join("\n")).toContain("TRADER_HEALTH_BIND=0.0.0.0 is not one of 127.0.0.1, ::1, localhost");
    expect(lines.join("\n")).not.toContain("TRADER_REGISTRATION");
  }, 30_000);

  it("REFUSES TO START, closing the store, when the configured endpoint cannot bind (port in use)", async () => {
    await withFreshDatabase(container.getConnectionUri(), "trdr3-listen-failed", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "trdr3-listen-failed");
      const document = documentFor(registered, "trdr3-listen-failed");
      const parsed = parseTraderConfig(document);
      if (!parsed.ok) throw new Error(parsed.refusal.issues.join("; "));
      const env = safeEnvironment();

      // Occupy a loopback port with a first assembly, then ask a second for it.
      const first = await assembleDurableTrader({
        env,
        config: parsed.config,
        document,
        postgresUrl: connectionString,
        clock: new SystemPaperClock(),
        log: () => undefined,
        healthListen: { host: "127.0.0.1", port: 0 },
      });
      expect(first.ok).toBe(true);
      if (!first.ok || first.healthServer === undefined) throw new Error("the first assembly did not listen");
      try {
        const lines: string[] = [];
        const second = await assembleDurableTrader({
          env,
          config: parsed.config,
          document,
          postgresUrl: connectionString,
          clock: new SystemPaperClock(),
          log: (line) => {
            lines.push(line);
          },
          healthListen: { host: "127.0.0.1", port: first.healthServer.port },
        });
        expect(second.ok).toBe(false);
        if (second.ok) throw new Error("a second listener on one port assembled");
        expect(second.code).toBe(EXIT_CODES.configurationRefused);
        expect(lines.join("\n")).toContain("REFUSING TO START: TRADER_HEALTH_LISTEN_FAILED");
        expect(lines.join("\n")).toContain("EADDRINUSE");
      } finally {
        await first.healthServer.close();
        await first.store.close();
      }
    });
  }, 120_000);
});
