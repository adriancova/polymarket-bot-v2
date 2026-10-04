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
 * 3b. **PostgreSQL SILENT** (frozen behind a proxy, sockets open) with Redis
 *    — `PROVENANCE-1` r1, `PROV1-R1-02`: the record answers `UNCONFIRMED` at
 *    its bound and its connection is destroyed, so `startup()` returns 75
 *    while PostgreSQL is still frozen (it used to wait for PostgreSQL to
 *    answer again).
 * 4. **Refusals and a halt, read as a window's evidence** — a risk policy
 *    that refuses the entry, then a Redis partition inside the window: the
 *    research worker's `postgresTraderEvidence` reads the refusal rows, the
 *    halt row and the instance's dispatch frontier back from what the real
 *    trader wrote.
 *
 * ## The process clock (`CO2-N1`, ADR-031; `TC-LOWS-1`, `CO2N1-R1-J2`)
 *
 * `startup()` builds its own `SystemPaperClock`, and ADR-031's entry guard
 * reads it at admission. Against the fixture's `2026-03-04` events the host
 * clock as-is is months late, so every entry here was ALSO refused
 * `RISK_FEATURES_STALE` and `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` — which is not
 * what this file tests (ADR-031 §1.8), and which made scenario 4's
 * `submissionsAccepted === 0` hold for a reason other than its risk limit.
 * While recorded events are published and settled ({@link publishAndSettle}),
 * every `SystemPaperClock` now reads the host clock RE-BASED to the first
 * event published (`support/host-clock.ts`, `rebaseSystemPaperClock`: the
 * prototype's `now()` only — not the global `Date`, so the database, the
 * transport and every bound measured here keep real time), as
 * `redis-outage-halts-postgres-redis.test.ts` does. The re-basing is restored
 * once the process is quiescent, before any fault. Scenario 4 now pins that
 * its entry is refused for its risk limit ALONE.
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
import { rebaseSystemPaperClock } from "./support/host-clock.js";
import {
  CONDITION_ID,
  documentFor,
  registerThroughTheRepositories,
  withFreshDatabase,
  type Registered,
} from "./support/registration.js";

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;
/**
 * ONE Redis for the file: no scenario stops it (an outage is a partition, the
 * freezable hop), and each has its own stream — so the suite starts as few
 * containers as it can (`TC-LOCAL-FLAKE`: Docker Desktop's port forwarding has
 * refused connections when many start at once).
 */
let redis: Awaited<ReturnType<typeof startRedisContainer>>;

beforeAll(async () => {
  postgres = await startPostgresContainer();
  redis = await startRedisContainer();
}, 300_000);

afterAll(async () => {
  await redis?.stop();
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

/**
 * Publishes and waits until the process's pump committed past every event
 * (quiescent: every write landed).
 *
 * `TC-LOWS-1` (`CO2N1-R1-J2`): meanwhile every `SystemPaperClock` reads the
 * host clock re-based to the first event published, so ADR-031's guard judges
 * the recorded entries at the run's real lag behind the recorded pace (see
 * the module header). Restored before this returns: every fault a scenario
 * injects afterwards meets the unmodified clock.
 */
async function publishAndSettle(
  publisher: RedisStreamsEventTransport,
  stream: string,
  consumerId: string,
  events: readonly IngestedEvent[],
  total: number,
): Promise<void> {
  const anchor = events[0]?.envelope.receivedAt;
  if (anchor === undefined) throw new Error("publishAndSettle needs at least one event");
  const rebased = rebaseSystemPaperClock(anchor);
  try {
    for (const event of events) await publisher.publish(stream, event.envelope);
    await waitFor(`the pump to commit past all ${String(total)} events`, 60_000, async () => {
      const metrics = await publisher.streamMetrics(stream);
      const lag = metrics.consumerLag.find((entry) => entry.consumerId === consumerId)?.lag;
      return metrics.publishedTotal === total && lag === 0 ? metrics : undefined;
    });
  } finally {
    rebased.restore();
  }
}

async function incidents(context: TestContext) {
  return await context.db.selectFrom("ops.incidents").selectAll().orderBy("incident_id").execute();
}

describe("every halt is written to ops.incidents before the process exits (PROVENANCE-1, OUT1-R1-HALT-NOT-DURABLE)", () => {
  it("TRANSPORT_RESYNC_REQUIRED: a restart finds that retention removed events it never read — the halt is an ops.incidents row, and the process exits 75", async () => {
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
  }, 240_000);

  it("STORE_UNAVAILABLE with the database ALIVE (a write it refuses): the halt record still lands, naming the refusal, and the process exits 75", async () => {
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
  }, 240_000);

  it("a PostgreSQL connection the server TERMINATES while the trader idles: GLOBAL STORE_UNAVAILABLE, the record lands, exit 75 (it was an uncaught 'error' event: exit 1, no halt)", async () => {
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
  }, 240_000);

  it("STORE_UNAVAILABLE with the database DOWN: the record cannot land; the process says so and exits 75 within the stated bound — fail closed, not weakened", async () => {
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
    }
  }, 300_000);

  it("PostgreSQL goes SILENT (frozen, sockets open) with Redis: the record answers UNCONFIRMED at its bound, its connection is destroyed, and startup() returns 75 while PostgreSQL is STILL frozen (PROV1-R1-02)", async () => {
    // Review r1 (`PROV1-R1-02`, reproduced by both reviewers): the record's
    // timer answered at the bound, but its connection stayed checked out, so
    // the store's close (`pool.end()`) waited for it and `startup()` returned
    // only once PostgreSQL answered again. Nothing was in flight here: the
    // trader is quiescent when both links go silent.
    await withFreshDatabase(postgres.getConnectionUri(), "prov-silent-db", async ({ connectionString, context }) => {
      const label = "prov-silent-db";
      const registered = await registerThroughTheRepositories(context, label);
      const stream = uniqueStreamName(label);
      const postgresHop = await startFreezableRedisProxy(connectionString);
      const redisHop = await startFreezableRedisProxy(redis.getConnectionUrl());
      const throughHop = new URL(connectionString);
      throughHop.hostname = "127.0.0.1";
      throughHop.port = new URL(postgresHop.url).port;
      const publisher = await connectPublisher(redis.getConnectionUrl());
      const run = runProcess(environment(redisHop.url, throughHop.toString(), label), documentOn(registered, label, stream));
      let thawed = false;
      try {
        const events = recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`);
        await publishAndSettle(publisher, stream, "trader-1", events, events.length);
        postgresHop.freeze();
        redisHop.freeze();
        const silentAt = Date.now();
        // One Redis bound to the halt, the record's bound, two QUIT bounds, a margin.
        const bound = 1_000 + HALT_RECORD_DEADLINE_MS + 2 * 1_000 + 3_000;
        const exited = await settleWithin(run.exit, bound);
        console.log(
          `[PROVENANCE-1 r1 measured, PostgreSQL silent] startup() ` +
            (exited === undefined ? `still pending after ${String(bound)} ms` : `returned +${String(exited.at - silentAt)} ms after the silence`),
        );
        expect(exited === undefined ? "STILL PENDING while PostgreSQL is frozen" : "returned", run.text()).toBe("returned");
        if (exited === undefined) throw new Error("unreachable");
        expect(exited.value, run.text()).toBe(EXIT_CODES.halted);
        expect(exitHealth(run).halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "TRANSPORT_UNAVAILABLE"]]);
        expect(run.text()).toContain(
          `HALT RECORD UNCONFIRMED: the database did not answer within ${String(HALT_RECORD_DEADLINE_MS)} ms; the halt's rows may or may not have been written`,
        );
        const halted = lineAt(run, "pump stopped: ").at;
        const recordLine = lineAt(run, "HALT RECORD UNCONFIRMED").at;
        expect(recordLine - halted).toBeLessThanOrEqual(HALT_RECORD_DEADLINE_MS + MARGIN_MS);
        // The record's connection is gone: the close waited on nothing of it.
        expect(exited.at - recordLine).toBeLessThanOrEqual(2 * 1_000 + MARGIN_MS);
        // Thawed only now. The destroyed connection never sent its COMMIT, so
        // nothing of the record lands afterwards: UNCONFIRMED meant "may or may
        // not", and here it is "not".
        postgresHop.thaw();
        redisHop.thaw();
        thawed = true;
        await sleep(1_000);
        expect(await incidents(context)).toEqual([]);
      } finally {
        if (!thawed) {
          postgresHop.thaw();
          redisHop.thaw();
        }
        await settleWithin(run.exit, 30_000);
        await postgresHop.close();
        await redisHop.close();
        await publisher.close();
      }
    });
  }, 240_000);
});

describe("refusals and halts, read back as a window's evidence by the research worker's own adapter (PROVENANCE-1)", () => {
  it("a refused entry is ops.risk_events rows; a halt inside the window is an ops.incidents row; the instance has a dispatch frontier", async () => {
    const hop = await startFreezableRedisProxy(redis.getConnectionUrl());
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
        const run = runProcess(environment(hop.url, connectionString, label), document);
        try {
          const events = recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`);
          await publishAndSettle(publisher, stream, "trader-1", events, events.length);
          await publisher.close();
          // The outage (a partition): the halt latches at the last event's instant, inside the window.
          hop.freeze();
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
          // `TC-LOWS-1` (`CO2N1-R1-J2`): judged at the re-based clock, the entry
          // is refused for its risk limit ALONE — not also `RISK_FEATURES_STALE`
          // and `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED`, as the months-late host clock
          // refused it — so `submissionsAccepted === 0` above is that limit's.
          expect(refusals.map((row) => row.reason_code)).toEqual(["RISK_WORST_CASE_LOSS_EXCEEDED"]);
          expect(health.risk.refusalsByCode).toEqual({ RISK_WORST_CASE_LOSS_EXCEEDED: 1 });

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
      await hop.close();
    }
  }, 240_000);
});
