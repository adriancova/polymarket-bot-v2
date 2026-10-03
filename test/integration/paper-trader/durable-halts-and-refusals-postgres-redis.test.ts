/**
 * `PROVENANCE-1` — halts and refusals are DURABLE, through the REAL process
 * path (`startup()`), a real PostgreSQL and a real Redis; and the research
 * worker's own read-only evidence adapter reads them back as a window's
 * evidence.
 *
 * `OUT1-R1-HALT-NOT-DURABLE`: before this round no halt reached PostgreSQL
 * (the redis-outage file covers `TRANSPORT_UNAVAILABLE`). This file adds:
 *
 * 1. **`TRANSPORT_RESYNC_REQUIRED`** — retention removed events the consumer
 *    never read (ADR-003 §3.3). The process halts, exits 75, and the halt is
 *    one `ops.incidents` row.
 * 2. **`STORE_UNAVAILABLE`, the database ALIVE** — a write the database
 *    refuses (a constraint added mid-run makes every decision insert fail).
 *    The halt record still lands, in its own table, and names the cause.
 * 3. **`STORE_UNAVAILABLE`, the database DOWN** — the failed dependency is
 *    the one the record is written to. The record cannot land; the process
 *    says so (`HALT RECORD NOT DURABLE`) and exits 75 regardless, within the
 *    stated bound: fail-closed exit is not weakened to get a row written.
 * 4. **Refusals and a halt, read as a window's evidence** — a risk policy
 *    that refuses the entry, then a Redis outage inside the window: the
 *    research worker's `postgresTraderEvidence` reads the refusal rows, the
 *    halt row and the instance's dispatch frontier back from what the real
 *    trader wrote.
 *
 * Docker: Testcontainers, no skip. PAPER only; no venue, no signer, no real
 * order; throwaway credentials that live only for the run.
 */

import { RedisStreamsEventTransport, EventBusUnavailableError } from "@polymarket-bot/event-bus";
import { startFreezableRedisProxy, startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { postgresTraderEvidence, type MarketWindow } from "@polymarket-bot/research-worker";
import { startPostgresContainer, type TestContext } from "@polymarket-bot/storage-postgres/testing";
import type { IngestedEvent, LoopHealthSnapshot } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXIT_CODES, REDIS_RESPONSE_TIMEOUT_ENV, startup } from "../../../apps/trader/src/main.js";
import { HALT_RECORD_DEADLINE_MS } from "../../../apps/trader/src/halt-record.js";
import {
  GATEWAY_EPOCH,
  T_CLOSE,
  T_OPEN,
  ingested,
  recordedEvents,
  riskPolicy,
  safeEnvironment,
} from "./support/fixture.js";
import {
  CONDITION_ID,
  documentFor,
  registerThroughTheRepositories,
  withFreshDatabase,
  type Registered,
} from "./support/registration.js";

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;

beforeAll(async () => {
  postgres = await startPostgresContainer();
}, 300_000);

afterAll(async () => {
  await postgres?.stop();
});

const MARGIN_MS = 1_000;

interface ProcessRun {
  readonly exit: Promise<number>;
  readonly lines: { readonly at: number; readonly line: string }[];
  text(): string;
}

function runProcess(env: Record<string, string | undefined>, document: Record<string, unknown>): ProcessRun {
  const lines: { at: number; line: string }[] = [];
  const exit = startup({
    env,
    readConfig: () => Promise.resolve(JSON.stringify(document)),
    log: (line) => {
      lines.push({ at: Date.now(), line });
    },
  });
  return { exit, lines, text: () => lines.map((entry) => entry.line).join("\n") };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(what: string, withinMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`gave up after ${String(withinMs)} ms waiting for ${what}`);
    await sleep(50);
  }
}

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ readonly value: T; readonly at: number } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ value, at: Date.now() })), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function exitHealth(run: ProcessRun): LoopHealthSnapshot {
  const entry = run.lines.find(({ line }) => line.startsWith("health: {"));
  if (entry === undefined) throw new Error(`startup() logged no exit health snapshot:\n${run.text()}`);
  return JSON.parse(entry.line.slice("health: ".length)) as LoopHealthSnapshot;
}

function lineAt(run: ProcessRun, prefix: string): { readonly at: number; readonly line: string } {
  const entry = run.lines.find(({ line }) => line.startsWith(prefix));
  if (entry === undefined) throw new Error(`startup() never logged "${prefix}":\n${run.text()}`);
  return entry;
}

async function connectPublisher(url: string, maxEvents = 10_000): Promise<RedisStreamsEventTransport> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await RedisStreamsEventTransport.connect({ connection: { url }, retention: { maxEvents } });
    } catch (failure) {
      if (!(failure instanceof EventBusUnavailableError)) throw failure;
      lastFailure = failure;
      await sleep(400);
    }
  }
  throw new Error(`a fresh Redis container never accepted a connection: ${String(lastFailure)}`);
}

function documentOn(
  registered: Registered,
  label: string,
  stream: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = documentFor(registered, label);
  return {
    ...base,
    infrastructure: { ...(base["infrastructure"] as Record<string, unknown>), eventStream: stream },
    ...overrides,
  };
}

function environment(redisUrl: string, databaseUrl: string, label: string): Record<string, string | undefined> {
  return {
    ...safeEnvironment(),
    TRADER_CONFIG_PATH: `/${label}.json`,
    REDIS_URL: redisUrl,
    DATABASE_URL: databaseUrl,
    [REDIS_RESPONSE_TIMEOUT_ENV]: "1000",
  };
}

/** Publishes and waits until the process's pump committed past every event (quiescent: every write landed). */
async function publishAndSettle(
  publisher: RedisStreamsEventTransport,
  stream: string,
  consumerId: string,
  events: readonly IngestedEvent[],
  total: number,
): Promise<void> {
  for (const event of events) await publisher.publish(stream, event.envelope);
  await waitFor(`the pump to commit past all ${String(total)} events`, 60_000, async () => {
    const metrics = await publisher.streamMetrics(stream);
    const lag = metrics.consumerLag.find((entry) => entry.consumerId === consumerId)?.lag;
    return metrics.publishedTotal === total && lag === 0 ? metrics : undefined;
  });
}

async function incidents(context: TestContext) {
  return await context.db.selectFrom("ops.incidents").selectAll().orderBy("incident_id").execute();
}

describe("every halt is written to ops.incidents before the process exits (PROVENANCE-1, OUT1-R1-HALT-NOT-DURABLE)", () => {
  it("TRANSPORT_RESYNC_REQUIRED: a restart finds that retention removed events it never read — the halt is an ops.incidents row, and the process exits 75", async () => {
    const redis = await startRedisContainer();
    try {
      await withFreshDatabase(postgres.getConnectionUri(), "prov-resync", async ({ connectionString, context }) => {
        const label = "prov-resync";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const document = documentOn(registered, label, stream);
        // A retention bound of 50 on the publisher.
        const publisher = await connectPublisher(redis.getConnectionUrl(), 50);
        const reference = (seq: number): IngestedEvent =>
          ingested(
            "ReferenceTradeObserved",
            { venue: "binance", symbol: "BTCUSDT", price: "100000", size: "0.5" },
            { receivedAt: "2026-03-04T11:59:00.000Z", ingestSeq: seq, source: "binance" },
          );
        try {
          // --- run 1: reads 20 events and records its position, then a partition halts it
          const hop = await startFreezableRedisProxy(redis.getConnectionUrl());
          try {
            const first = runProcess(environment(hop.url, connectionString, `${label}-1`), document);
            await publishAndSettle(publisher, stream, "trader-1", Array.from({ length: 20 }, (_, index) => reference(index + 1)), 20);
            hop.freeze();
            const exited = await settleWithin(first.exit, 60_000);
            expect(exited?.value, first.text()).toBe(EXIT_CODES.halted);
            expect(exitHealth(first).halts.map((halt) => halt.code)).toEqual(["TRANSPORT_UNAVAILABLE"]);
          } finally {
            await hop.close();
          }
          // --- while it is down: 100 more events, so retention removes 50 it never read
          for (let seq = 21; seq <= 120; seq += 1) await publisher.publish(stream, reference(seq).envelope);
        } finally {
          await publisher.close();
        }

        // --- run 2, the restart: it resumes at its recorded position and finds the gap
        const run = runProcess(environment(redis.getConnectionUrl(), connectionString, `${label}-2`), document);
        const exited = await settleWithin(run.exit, 60_000);
        expect(exited?.value, run.text()).toBe(EXIT_CODES.halted);
        const halts = exitHealth(run).halts;
        expect(halts.map((halt) => [halt.scope.kind, halt.code, halt.action])).toEqual([
          ["GLOBAL", "TRANSPORT_RESYNC_REQUIRED", "FULL_HALT"],
        ]);
        expect(halts[0]?.detail).toContain("retention removed 50 event(s)");
        // One row per run's halt: run 1's outage, then run 2's resync.
        const rows = await incidents(context);
        expect(rows.map((row) => row.failure_class)).toEqual(["TRANSPORT_UNAVAILABLE", "TRANSPORT_RESYNC_REQUIRED"]);
        expect(rows[1]).toMatchObject({
          incident_key: "TRADER_HALT:GLOBAL",
          environment: "PAPER",
          account_ref: "paper-account",
          severity: "PAGE",
          status: "OPEN",
          failure_class: "TRANSPORT_RESYNC_REQUIRED",
          action: "FULL_HALT",
          market_id: null,
          instance_id: registered.instanceId,
          detail: halts[0]?.detail,
        });
        expect(Date.parse(String(rows[1]?.opened_at))).toBe(Date.parse(halts[0]?.at ?? ""));
        expect(run.text()).toContain(
          "halt record: 1 row(s) written to ops.incidents for 1 halt(s) (GLOBAL TRANSPORT_RESYNC_REQUIRED)",
        );
        // Nothing was decided: reference prints before any book or open evaluate nothing.
        expect(await context.db.selectFrom("strategy.decisions").selectAll().execute()).toEqual([]);
      });
    } finally {
      await redis.stop();
    }
  }, 240_000);

  it("STORE_UNAVAILABLE with the database ALIVE (a write it refuses): the halt record still lands, naming the refusal, and the process exits 75", async () => {
    const redis = await startRedisContainer();
    try {
      await withFreshDatabase(postgres.getConnectionUri(), "prov-store-refused", async ({ connectionString, context }) => {
        const label = "prov-store-refused";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const publisher = await connectPublisher(redis.getConnectionUrl());
        const document = documentOn(registered, label, stream);
        const run = runProcess(environment(redis.getConnectionUrl(), connectionString, label), document);
        try {
          const events = recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`);
          await publishAndSettle(publisher, stream, "trader-1", events, events.length);
          // The database is up, and from now on refuses every new decision row.
          await context.pool.query(
            "alter table strategy.decisions add constraint provenance_probe_refuses check (false) not valid",
          );
          await publisher.publish(
            stream,
            ingested(
              "ReferenceTradeObserved",
              { venue: "binance", symbol: "BTCUSDT", price: "100200", size: "0.1" },
              { receivedAt: "2026-03-04T12:00:04.000Z", ingestSeq: 7, source: "binance" },
            ).envelope,
          );
          const exited = await settleWithin(run.exit, 60_000);
          expect(exited?.value, run.text()).toBe(EXIT_CODES.halted);
          const halts = exitHealth(run).halts;
          expect(halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
          const rows = await incidents(context);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            incident_key: "TRADER_HALT:GLOBAL",
            failure_class: "STORE_UNAVAILABLE",
            action: "FULL_HALT",
            instance_id: registered.instanceId,
            market_id: null,
          });
          expect(rows[0]?.detail).toContain("provenance_probe_refuses");
        } finally {
          await publisher.close();
        }
      });
    } finally {
      await redis.stop();
    }
  }, 240_000);

  it("a PostgreSQL connection the server TERMINATES while the trader idles: GLOBAL STORE_UNAVAILABLE, the record lands, exit 75 (it was an uncaught 'error' event: exit 1, no halt)", async () => {
    const redis = await startRedisContainer();
    try {
      await withFreshDatabase(postgres.getConnectionUri(), "prov-terminated", async ({ connectionString, context }) => {
        const label = "prov-terminated";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const publisher = await connectPublisher(redis.getConnectionUrl());
        const run = runProcess(environment(redis.getConnectionUrl(), connectionString, label), documentOn(registered, label, stream));
        try {
          const events = recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`);
          await publishAndSettle(publisher, stream, "trader-1", events, events.length);
          // The server ends the trader's pooled connections (a restart, an
          // operator's pg_terminate_backend, a dropped link look the same).
          const terminated = await context.pool.query<{ readonly n: number }>(
            "select count(pg_terminate_backend(pid))::int as n from pg_stat_activity " +
              "where datname = current_database() and application_name = 'polymarket-bot'",
          );
          expect(terminated.rows[0]?.n).toBeGreaterThanOrEqual(1);
          const exited = await settleWithin(run.exit, 60_000);
          expect(exited === undefined ? "STILL RUNNING" : "returned", run.text()).toBe("returned");
          expect(exited?.value, run.text()).toBe(EXIT_CODES.halted);
          const halts = exitHealth(run).halts;
          expect(halts.map((halt) => [halt.scope.kind, halt.code, halt.action])).toEqual([["GLOBAL", "STORE_UNAVAILABLE", "FULL_HALT"]]);
          expect(halts[0]?.detail).toContain("the PostgreSQL connection pool lost an idle connection");
          expect(halts[0]?.detail).toContain("terminating connection due to administrator command");
          expect(run.text()).toContain("STORE CONNECTION LOST: ");
          // The server is up, so the halt record lands (on a new connection).
          const rows = await incidents(context);
          expect(rows.map((row) => [row.failure_class, row.instance_id])).toEqual([["STORE_UNAVAILABLE", registered.instanceId]]);
          expect(run.text()).toContain("halt record: 1 row(s) written to ops.incidents for 1 halt(s) (GLOBAL STORE_UNAVAILABLE)");
        } finally {
          await publisher.close();
        }
      });
    } finally {
      await redis.stop();
    }
  }, 240_000);

  it("STORE_UNAVAILABLE with the database DOWN: the record cannot land; the process says so and exits 75 within the stated bound — fail closed, not weakened", async () => {
    const redis = await startRedisContainer();
    const own = await startPostgresContainer();
    let ownStopped = false;
    try {
      await withFreshDatabase(own.getConnectionUri(), "prov-store-down", async ({ connectionString, context }) => {
        const label = "prov-store-down";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const publisher = await connectPublisher(redis.getConnectionUrl());
        const run = runProcess(environment(redis.getConnectionUrl(), connectionString, label), documentOn(registered, label, stream));
        try {
          const events = recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`);
          await publishAndSettle(publisher, stream, "trader-1", events, events.length);
          await context.close();
          await own.stop();
          ownStopped = true;
          await publisher.publish(
            stream,
            ingested(
              "ReferenceTradeObserved",
              { venue: "binance", symbol: "BTCUSDT", price: "100200", size: "0.1" },
              { receivedAt: "2026-03-04T12:00:04.000Z", ingestSeq: 7, source: "binance" },
            ).envelope,
          );
          const exited = await settleWithin(run.exit, 120_000);
          expect(exited === undefined ? "STILL RUNNING" : "returned", run.text()).toBe("returned");
          if (exited === undefined) throw new Error("unreachable");
          expect(exited.value, run.text()).toBe(EXIT_CODES.halted);
          expect(exitHealth(run).halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
          // The record could not be written, and the process said so instead of waiting for it.
          expect(run.text()).toMatch(/HALT RECORD (NOT DURABLE|UNCONFIRMED): /u);
          expect(run.text()).not.toContain("halt record: ");
          // Bounded: from the halt to the return, at most the record's bound plus
          // two Redis QUIT bounds (T = 1000) and the margin.
          const halted = lineAt(run, "pump stopped: ").at;
          const recordLine = lineAt(run, "HALT RECORD ").at;
          console.log(
            `[PROVENANCE-1 measured, database down] halt record answered +${String(recordLine - halted)} ms after the ` +
              `halt line; startup() returned +${String(exited.at - halted)} ms after it`,
          );
          expect(recordLine - halted).toBeLessThanOrEqual(HALT_RECORD_DEADLINE_MS + MARGIN_MS);
          expect(exited.at - halted).toBeLessThanOrEqual(HALT_RECORD_DEADLINE_MS + 2 * 1_000 + 10_000 + MARGIN_MS);
        } finally {
          await publisher.close();
        }
      });
    } finally {
      if (!ownStopped) await own.stop();
      await redis.stop();
    }
  }, 300_000);
});

describe("refusals and halts, read back as a window's evidence by the research worker's own adapter (PROVENANCE-1)", () => {
  it("a refused entry is ops.risk_events rows; a halt inside the window is an ops.incidents row; the instance has a dispatch frontier", async () => {
    const redis = await startRedisContainer();
    let stopped = false;
    try {
      await withFreshDatabase(postgres.getConnectionUri(), "prov-evidence", async ({ connectionString, context }) => {
        const label = "prov-evidence";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const publisher = await connectPublisher(redis.getConnectionUrl());
        const policy = riskPolicy();
        // The entry risks 17; the limit is 1, so the real risk engine refuses it.
        const document = documentOn(registered, label, stream, {
          riskPolicy: { ...policy, limits: { ...(policy["limits"] as Record<string, unknown>), maxWorstCaseContractualLoss: "1" } },
        });
        const run = runProcess(environment(redis.getConnectionUrl(), connectionString, label), document);
        try {
          const events = recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`);
          await publishAndSettle(publisher, stream, "trader-1", events, events.length);
          await publisher.close();
          // The outage: the halt latches at the last event's instant, inside the window.
          await redis.stop();
          stopped = true;
          const exited = await settleWithin(run.exit, 60_000);
          expect(exited?.value, run.text()).toBe(EXIT_CODES.halted);
          const health = exitHealth(run);
          expect(health.risk.refusals).toBeGreaterThanOrEqual(1);
          expect(health.execution.submissionsAccepted).toBe(0);

          // --- the rows the real trader wrote -----------------------------------
          const refusals = await context.db.selectFrom("ops.risk_events").selectAll().orderBy("risk_event_id").execute();
          const counted = Object.values(health.risk.refusalsByCode).reduce((total, n) => total + n, 0);
          expect(refusals).toHaveLength(counted);
          const decisions = await context.db.selectFrom("strategy.decisions").selectAll().orderBy("evaluation_seq").execute();
          for (const row of refusals) {
            expect(row).toMatchObject({
              environment: "PAPER",
              account_ref: "paper-account",
              run_id: registered.runId,
              instance_id: registered.instanceId,
              market_id: registered.marketId,
              intent_id: null,
              check_code: "PRE_TRADE_RISK",
              outcome: "VETOED",
            });
            const measures = row.measures as Record<string, unknown>;
            const decision = decisions.find((candidate) => candidate.evaluation_seq === String(measures["evaluationSeq"]));
            expect(decision, "the refusal names a persisted decision").toBeDefined();
            expect(decision?.intent_count).toBeGreaterThan(0);
            expect(Date.parse(String(row.occurred_at))).toBe(Date.parse(String(decision?.evaluated_at)));
            expect([measures["gatewayEpoch"], measures["ingestSeq"]]).toEqual([decision?.gateway_epoch, decision?.ingest_seq]);
          }
          expect(refusals.map((row) => row.reason_code)).toContain("RISK_WORST_CASE_LOSS_EXCEEDED");

          // --- the research worker's own read-only adapter -----------------------
          const window: MarketWindow = {
            windowId: `window-${label}`,
            marketId: registered.marketId,
            conditionId: `${CONDITION_ID}-${label}`,
            gammaMarketId: null,
            tokenIds: ["111", "222"],
            windowStartMs: Date.parse(T_OPEN),
            windowEndMs: Date.parse(T_CLOSE),
            responsibleFromMs: Date.parse(T_OPEN) - 15 * 60 * 1000,
            responsibility: { kind: "trader", instanceIds: [registered.instanceId] },
          };
          const evidence = postgresTraderEvidence(context.db, { environment: "PAPER" });
          const read = await evidence.marketEvidence(window, [registered.instanceId]);
          expect(read.refusalsAtMs).toEqual(refusals.map((row) => Date.parse(String(row.occurred_at))));
          const halt = health.halts[0];
          expect(read.haltsAtMs).toEqual([Date.parse(halt?.at ?? "")]);
          expect(read.intents.length).toBeGreaterThanOrEqual(1);
          for (const intent of read.intents) {
            expect(intent.gatewayEpoch).toBe(GATEWAY_EPOCH);
            expect(intent.ingestSeq).not.toBeNull();
          }
          const frontiers = await evidence.dispatchFrontiers([registered.instanceId]);
          const maxSeq = String(Math.max(...decisions.filter((row) => row.ingest_seq !== null).map((row) => Number(row.ingest_seq))));
          expect(frontiers.get(registered.instanceId)).toEqual({
            byEpoch: new Map([[GATEWAY_EPOCH, maxSeq]]),
            completedEpochs: new Set(),
          });
        } finally {
          await publisher.close();
        }
      });
    } finally {
      if (!stopped) await redis.stop();
    }
  }, 240_000);
});
