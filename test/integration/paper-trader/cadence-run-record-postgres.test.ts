/**
 * `CADENCE-1` — the run record that pins the evaluation cadence (work-plan
 * acceptance 11; ADR-026 D1.4-D1.5), through the process's own assembly
 * (`assembleDurableTrader`) against a real PostgreSQL.
 *
 * The record is the run's `strategy.runs` row: `evaluation_interval_ms` and
 * `evaluation_heartbeat_ms` (migration 0010). The trader's startup
 * registration check (`adapters/postgres-registration.ts`) refuses a run whose
 * row pins anything but 1,000 / 5,000 — the per-frame 0 / 0 a reproduction
 * may record, another pair, or NULL (a run recorded under ADR-024) — as
 * `TRADER_REGISTRATION_MISMATCH`, exit 78, naming the row and the values; a
 * row that pins 1,000 / 5,000 assembles, and the core runs exactly that
 * cadence. REGISTER-1's command writes 1,000 / 5,000 (its own test,
 * `register-command-postgres.test.ts`, reads the row back).
 *
 * Docker: Testcontainers, its own `beforeAll`, no skip. PAPER only; no venue,
 * no signer, no real order.
 */

import { startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import { parseTraderConfig } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleDurableTrader, EXIT_CODES } from "../../../apps/trader/src/main.js";
import { ingested, safeEnvironment } from "./support/fixture.js";
import { FIXTURE_FIRST_EVENT_AT, RebasedSystemPaperClock } from "./support/host-clock.js";
import { RUN_SEED, documentFor, registerThroughTheRepositories, withFreshDatabase } from "./support/registration.js";

let container: Awaited<ReturnType<typeof startPostgresContainer>>;

beforeAll(async () => {
  container = await startPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

async function assemble(document: Record<string, unknown>, postgresUrl: string) {
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
  const lines: string[] = [];
  const result = await assembleDurableTrader({
    env: safeEnvironment(),
    config: parsed.config,
    document,
    postgresUrl,
    clock: new RebasedSystemPaperClock(FIXTURE_FIRST_EVENT_AT),
    log: (line) => {
      lines.push(line);
    },
  });
  return { result, log: lines.join("\n") };
}

describe("CADENCE-1: the run row pins the evaluation cadence, and a PAPER trader runs exactly 1,000 / 5,000", () => {
  it("a row pinning 1,000 / 5,000 assembles, and the core runs that cadence", async () => {
    await withFreshDatabase(container.getConnectionUri(), "cadence-paper", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "cadence-paper");
      const row = await context.db
        .selectFrom("strategy.runs")
        .select(["evaluation_interval_ms", "evaluation_heartbeat_ms"])
        .where("run_id", "=", registered.runId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ evaluation_interval_ms: 1000, evaluation_heartbeat_ms: 5000 });
      const { result, log } = await assemble(documentFor(registered, "cadence-paper"), connectionString);
      expect(result.ok ? "ok" : log).toBe("ok");
      if (!result.ok) return;
      expect(result.trader.loop.evaluationCadence()).toEqual({ intervalMs: 1000, heartbeatMs: 5000 });
      await result.store.close();
    });
  }, 120_000);

  // `CADENCE-1` r1 (O03): the process's own assembly wires the forward-jump
  // alarm to the log line HOST-1 pages on (`main.ts` `onCadenceAlarm`). Three
  // applied events for a market this trader does not run: one stamped an hour
  // ahead, one an hour behind it (beyond the 5,000 ms bound: RAISED), and one
  // within the bound (CLEARED).
  it("a forward jump in event time logs the PAGE line once, and the end of the episode once", async () => {
    await withFreshDatabase(container.getConnectionUri(), "cadence-page", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "cadence-page");
      const lines: string[] = [];
      const parsed = parseTraderConfig(documentFor(registered, "cadence-page"));
      if (!parsed.ok) throw new Error(parsed.refusal.code);
      const result = await assembleDurableTrader({
        env: safeEnvironment(),
        config: parsed.config,
        document: documentFor(registered, "cadence-page"),
        postgresUrl: connectionString,
        clock: new RebasedSystemPaperClock(FIXTURE_FIRST_EVENT_AT),
        log: (line) => {
          lines.push(line);
        },
      });
      expect(result.ok ? "ok" : lines.join("\n")).toBe("ok");
      if (!result.ok) return;
      const unknownMarket = "018f4a7e-dddd-7abc-8def-0123456789ab";
      const book = (receivedAt: string, ingestSeq: number) =>
        ingested(
          "BookSnapshot",
          { internalMarketId: unknownMarket, tokenId: "999", bids: [{ price: "0.4", size: "10" }], asks: [] },
          { receivedAt, ingestSeq },
        );
      for (const event of [
        book("2026-03-04T13:00:00.000Z", 1),
        book("2026-03-04T12:00:01.000Z", 2),
        book("2026-03-04T12:59:58.000Z", 3),
      ]) {
        expect(result.trader.loop.ingest(event)).toBe(true);
      }
      await result.trader.loop.drain();
      const paged = lines.filter((line) => line.startsWith("CADENCE CLOCK FORWARD JUMP: "));
      expect(paged).toHaveLength(1);
      expect(paged[0]).toContain("2026-03-04T12:00:01Z");
      expect(paged[0]).toContain("2026-03-04T13:00:00Z");
      expect(lines.filter((line) => line.startsWith("CADENCE CLOCK CAUGHT UP: "))).toHaveLength(1);
      expect(result.trader.loop.health().loop.cadenceForwardJumpAlarms).toBe(1);
      await result.store.close();
    });
  }, 120_000);

  for (const [label, cadence, shown] of [
    ["the per-frame 0 / 0 a reproduction records", { intervalMs: 0, heartbeatMs: 0 }, "evaluation_interval_ms 0 and evaluation_heartbeat_ms 0"],
    ["another pair", { intervalMs: 2000, heartbeatMs: 10000 }, "evaluation_interval_ms 2000 and evaluation_heartbeat_ms 10000"],
  ] as const) {
    it(`REFUSES a row pinning ${label}: TRADER_REGISTRATION_MISMATCH, exit 78, naming the row and its values`, async () => {
      await withFreshDatabase(container.getConnectionUri(), `cadence-${String(cadence.intervalMs)}`, async ({ connectionString, context }) => {
        const registered = await registerThroughTheRepositories(context, `cadence-${String(cadence.intervalMs)}`, {
          evaluationCadence: cadence,
        });
        const { result, log } = await assemble(documentFor(registered, `cadence-${String(cadence.intervalMs)}`), connectionString);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("a run pinning another cadence assembled");
        expect(result.code).toBe(EXIT_CODES.configurationRefused);
        expect(log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
        expect(log).toContain(`strategy.runs ${registered.runId}: the row pins ${shown}`);
        expect(log).toContain("uses exactly 1000 and 5000 (ADR-026 D1.5)");
        // Fail CLOSED: nothing was written on the way to the refusal.
        expect(await context.db.selectFrom("strategy.decisions").selectAll().execute()).toHaveLength(0);
      });
    }, 120_000);
  }

  it("REFUSES a row recorded under ADR-024 (NULL): a new run must record the cadence", async () => {
    await withFreshDatabase(container.getConnectionUri(), "cadence-null", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "cadence-null");
      // A run row as every writer before migration 0010 wrote it: no cadence columns.
      const inserted = await context.pool.query<{ run_id: string }>(
        `insert into strategy.runs (instance_id, definition_id, config_id, environment, code_commit,
                                    state_schema_version, run_seed)
         values ($1, $2, $3, 'PAPER', 'pre-0010-writer', 1, $4) returning run_id`,
        [registered.instanceId, registered.definitionId, registered.configId, RUN_SEED],
      );
      const legacyRun = inserted.rows[0]?.run_id ?? "";
      const { result, log } = await assemble(documentFor(registered, "cadence-null", { runId: legacyRun }), connectionString);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a run recorded under ADR-024 assembled");
      expect(log).toContain("TRADER_REGISTRATION_MISMATCH");
      expect(log).toContain(
        `strategy.runs ${legacyRun}: the row pins evaluation_interval_ms NULL (a run recorded under ADR-024, before migration 0010)`,
      );
    });
  }, 120_000);
});
