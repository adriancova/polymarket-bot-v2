/**
 * `THROUGHPUT-1a` — GROUP COMMIT survives a SIGKILL mid-batch. The REAL trader
 * PROCESS (its shipped esbuild bundle, `startup()`), real Redis, real
 * PostgreSQL.
 *
 * ## The scenario
 *
 * 1. A REFERENCE run: one trader process, a fresh database, the committed H1
 *    sample (`MarketOpened` + 2,000 envelopes) published whole and consumed
 *    whole — the durable rows an uninterrupted run makes.
 * 2. The CRASH run, on another fresh database: batch A (`MarketOpened` + the
 *    first 460 envelopes) is published and consumed until the process has
 *    RECORDED its stream position at the end of A. Then the test takes an
 *    EXCLUSIVE lock on `strategy.decisions`, publishes batch B (the rest), and
 *    waits until the trader's group commit is BLOCKED on that lock
 *    (`pg_stat_activity`) — the process is mid-batch: B's decisions are made
 *    and staged, their commit is in flight, nothing of B is durable. The
 *    process is killed with SIGKILL, and its blocked session is terminated
 *    (so its transaction dies with it, as a crashed host's would).
 *
 * ## What must hold after the crash
 *
 * - NO GAP, NO DUPLICATE: the crashed run's decisions carry
 *   `evaluation_seq` 0…k−1 with nothing missing, one checkpoint for each,
 *   and nothing of the in-flight batch;
 * - EQUAL TO THE UNINTERRUPTED RUN: those k decisions and k checkpoints are,
 *   column for column (ids and wall timestamps aside), the reference run's
 *   first k;
 * - THE POSITION AGREES: the consumer position stored in Redis is exactly the
 *   end of A — never past a decision that is not durable. Every event before
 *   it has its decision durable.
 *
 * ## The restart
 *
 * Restarting the SAME run is refused (`BOOT-1`: a run with decisions is not
 * resumable, exit 78) — the recovery contract today, unchanged. A NEW run for
 * the same instance (`startRun`, as that refusal instructs) resumes from the
 * stored position: it decides exactly the events after it — every one of
 * them, and none before it.
 *
 * NON-VACUITY: with the pump changed to record a batch's position BEFORE its
 * decisions are durable, this file fails (the stored position runs past the
 * durable rows) — the planted-bug run is recorded in the THROUGHPUT-1a
 * handoff.
 *
 * Docker: Testcontainers, its own containers, no skip. PAPER only.
 */

import { spawn, type ChildProcess, execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { EventBusUnavailableError, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { createDatabase, createPostgresPool, createRepositories, migrateUp } from "@polymarket-bot/storage-postgres";
import { createIsolatedDatabase, startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { H1_MARKET_ID, readEnvelope, readEnvelopes, remapMarketId, withMarketOpened } from "./support/throughput/fixture.js";
import { benchEnvironment, registerForBench } from "./support/throughput/harness.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const fixtures = path.resolve(here, "../../fixtures/trader-throughput");

/** Batch A: `MarketOpened` + the sample's first 460 envelopes (B opens on a book snapshot pair). */
const BATCH_A = 461;

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startRedisContainer>>;
let redisUrl: string;
let workRoot: string;
let bundle: string;
const children = new Set<ChildProcess>();

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), "group-commit-crash-"));
  bundle = path.join(workRoot, "main.mjs");
  // The trader's own bundle, built with its own esbuild and flags (`apps/trader` "build").
  await execFileAsync(
    path.join(repoRoot, "apps/trader/node_modules/.bin/esbuild"),
    [
      "src/main.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--banner:js=import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
      `--outfile=${bundle}`,
      "--log-level=warning",
    ],
    { cwd: path.join(repoRoot, "apps/trader") },
  );
  [postgres, redis] = await Promise.all([startPostgresContainer(), startRedisContainer()]);
  redisUrl = redis.getConnectionUrl();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const probe = await RedisStreamsEventTransport.connect({ connection: { url: redisUrl }, retention: { maxEvents: 10 } });
      await probe.close();
      break;
    } catch (failure) {
      if (!(failure instanceof EventBusUnavailableError) || attempt >= 5) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}, 300_000);

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([postgres?.stop(), redis?.stop()]);
  if (workRoot !== undefined) await rm(workRoot, { recursive: true, force: true });
});

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

interface Scenario {
  readonly databaseUrl: string;
  readonly document: Record<string, unknown>;
  readonly envelopes: readonly EventEnvelope<unknown>[];
  readonly stream: string;
  readonly runId: string;
  readonly publisher: RedisStreamsEventTransport;
}

async function scenario(label: string): Promise<Scenario> {
  const isolated = await createIsolatedDatabase(postgres.getConnectionUri(), `gc-${label}`);
  const pool = createPostgresPool({ connectionString: isolated.connectionString, maxConnections: 2 });
  try {
    await migrateUp(pool, { appliedBy: "throughput-1a-test" });
  } finally {
    await pool.end();
  }
  const workDir = await mkdtemp(path.join(workRoot, `${label}-`));
  const completed = await registerForBench({
    databaseUrl: isolated.connectionString,
    templatePath: path.join(fixtures, "template.json"),
    workDir,
    instanceName: `group-commit-${label}`,
    codeCommit: "throughput-1a-test",
    log: () => undefined,
  });
  const stream = uniqueStreamName(`gc-${label}`);
  const document: Record<string, unknown> = {
    ...completed,
    infrastructure: {
      ...(completed["infrastructure"] as Record<string, unknown>),
      eventStream: stream,
      consumerId: "trader-gc",
      retentionMaxEvents: 100_000,
    },
  };
  const marketId = ((document["markets"] as Record<string, unknown>[])[0] ?? {})["marketId"] as string;
  const runId = ((document["instances"] as Record<string, unknown>[])[0] ?? {})["runId"] as string;
  const envelopes = remapMarketId(
    withMarketOpened(
      await readEnvelope(path.join(fixtures, "market-opened.json")),
      await readEnvelopes(path.join(fixtures, "burst-sample.jsonl")),
    ),
    H1_MARKET_ID,
    marketId,
  );
  const publisher = await RedisStreamsEventTransport.connect({
    connection: { url: redisUrl },
    retention: { maxEvents: 100_000 },
  });
  return { databaseUrl: isolated.connectionString, document, envelopes, stream, runId, publisher };
}

interface Process {
  readonly child: ChildProcess;
  readonly exit: Promise<number | null>;
  output(): string;
}

async function startTrader(run: Scenario, document: Record<string, unknown>, label: string): Promise<Process> {
  const configPath = path.join(workRoot, `${label}-${String(Date.now())}.json`);
  await writeFile(configPath, JSON.stringify(document));
  const child = spawn(process.execPath, [bundle], {
    env: {
      ...benchEnvironment(run.databaseUrl),
      REDIS_URL: redisUrl,
      TRADER_CONFIG_PATH: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  return { child, exit, output: () => Buffer.concat(chunks).toString("utf8") };
}

async function publish(run: Scenario, from: number, to: number): Promise<void> {
  for (const envelope of run.envelopes.slice(from, to)) await run.publisher.publish(run.stream, envelope);
}

/** The consumer position the trader RECORDED in Redis (publication ordinal), or undefined before any. */
async function recordedPosition(run: Scenario): Promise<number | undefined> {
  const metrics = await run.publisher.streamMetrics(run.stream);
  const entry = metrics.consumerLag.find((lag) => lag.consumerId === "trader-gc");
  return entry === undefined ? undefined : metrics.publishedTotal - entry.lag;
}

async function waitForPosition(run: Scenario, position: number, withinMs = 60_000): Promise<void> {
  await waitFor(`the recorded position to reach ${String(position)}`, withinMs, async () =>
    (await recordedPosition(run)) === position ? true : undefined,
  );
}

interface DurableRows {
  readonly decisions: Record<string, unknown>[];
  readonly checkpoints: Record<string, unknown>[];
}

/** Every decision and checkpoint of a run, ids replaced by placeholders, wall timestamps dropped. */
async function durableRows(databaseUrl: string, runId: string, ids: readonly string[]): Promise<DurableRows> {
  const pool = createPostgresPool({ connectionString: databaseUrl, maxConnections: 1 });
  try {
    const normalize = (row: Record<string, unknown>): Record<string, unknown> => {
      let text = JSON.stringify(row);
      ids.forEach((id, index) => {
        text = text.split(id).join(`<id${String(index)}>`);
      });
      return JSON.parse(text) as Record<string, unknown>;
    };
    const decisions = await pool.query<Record<string, unknown>>(
      `select evaluation_seq::text as seq, callback::text as callback, decision_type::text as decision_type,
              reason_codes, model_outputs::text as model_outputs, state_patch::text as state_patch,
              next_wakeup_at::text as next_wakeup_at, source_event_id::text as source_event_id,
              intent_count, evaluated_at::text as evaluated_at
         from strategy.decisions d where d.run_id = $1 order by d.evaluation_seq`,
      [runId],
    );
    const checkpoints = await pool.query<Record<string, unknown>>(
      `select checkpoint_seq::text as seq, state::text as state, captured_at::text as captured_at
         from strategy.state_checkpoints c where c.run_id = $1 order by c.checkpoint_seq`,
      [runId],
    );
    return { decisions: decisions.rows.map(normalize), checkpoints: checkpoints.rows.map(normalize) };
  } finally {
    await pool.end();
  }
}

function mintedIds(document: Record<string, unknown>): string[] {
  const market = (document["markets"] as Record<string, unknown>[])[0] ?? {};
  const instance = (document["instances"] as Record<string, unknown>[])[0] ?? {};
  return [market["marketId"], instance["instanceId"], instance["runId"], instance["configId"]].filter(
    (value): value is string => typeof value === "string",
  );
}

describe("group commit survives a SIGKILL mid-batch (THROUGHPUT-1a)", () => {
  it("the durable rows are an uninterrupted run's prefix, the stored position agrees, and a new run resumes exactly after it", async () => {
    // --- 1. the uninterrupted reference ----------------------------------------
    const reference = await scenario("reference");
    const referenceProcess = await startTrader(reference, reference.document, "reference");
    await publish(reference, 0, reference.envelopes.length);
    await waitForPosition(reference, reference.envelopes.length, 120_000);
    referenceProcess.child.kill("SIGKILL");
    await referenceProcess.exit;
    const referenceRows = await durableRows(reference.databaseUrl, reference.runId, mintedIds(reference.document));
    expect(referenceRows.decisions.length).toBeGreaterThan(1_000);
    await reference.publisher.close();

    // --- 2. the crash run: A consumed and recorded, B in flight -----------------
    const crash = await scenario("crash");
    const crashProcess = await startTrader(crash, crash.document, "crash");
    await publish(crash, 0, BATCH_A);
    await waitForPosition(crash, BATCH_A);
    const lockPool = createPostgresPool({ connectionString: crash.databaseUrl, maxConnections: 2 });
    const lock = await lockPool.connect();
    let terminated = 0;
    try {
      await lock.query("begin");
      await lock.query("lock table strategy.decisions in exclusive mode");
      await publish(crash, BATCH_A, crash.envelopes.length);
      // The trader's group commit, blocked on the lock: mid-batch.
      const blocked = await waitFor("the trader's commit to block on the lock", 60_000, async () => {
        const rows = await lockPool.query<{ pid: number }>(
          `select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
             and pid <> pg_backend_pid()`,
        );
        return rows.rows.length > 0 ? rows.rows.map((row) => row.pid) : undefined;
      });
      crashProcess.child.kill("SIGKILL");
      await crashProcess.exit;
      for (const pid of blocked) {
        const result = await lockPool.query<{ ok: boolean }>("select pg_terminate_backend($1) as ok", [pid]);
        if (result.rows[0]?.ok === true) terminated += 1;
      }
    } finally {
      await lock.query("rollback");
      lock.release();
      await lockPool.end();
    }
    expect(terminated).toBeGreaterThan(0);

    const crashed = await durableRows(crash.databaseUrl, crash.runId, mintedIds(crash.document));
    const k = crashed.decisions.length;
    // No gap, no duplicate: 0…k−1, one checkpoint per decision.
    expect(crashed.decisions.map((row) => row["seq"])).toEqual(Array.from({ length: k }, (_, index) => String(index)));
    expect(crashed.checkpoints.map((row) => row["seq"])).toEqual(Array.from({ length: k }, (_, index) => String(index)));
    // Equal to the uninterrupted run, column for column.
    expect(crashed.decisions).toEqual(referenceRows.decisions.slice(0, k));
    expect(crashed.checkpoints).toEqual(referenceRows.checkpoints.slice(0, k));
    // Nothing of the in-flight batch B is durable, and every event of A is.
    const aEvents = new Set(crash.envelopes.slice(0, BATCH_A).map((envelope) => envelope.eventId));
    const referenceA = referenceRows.decisions.filter((row) => aEvents.has(String(row["source_event_id"])));
    expect(k).toBe(referenceA.length);
    // The stored position agrees: exactly the end of A, never past a decision that is not durable.
    expect(await recordedPosition(crash)).toBe(BATCH_A);

    // --- 3. restart ---------------------------------------------------------------
    const sameRun = await startTrader(crash, crash.document, "restart-same-run");
    expect(await sameRun.exit, sameRun.output()).toBe(78);
    expect(sameRun.output()).toContain("TRADER_REGISTRATION_RUN_NOT_RESUMABLE");

    const database = createDatabase(createPostgresPool({ connectionString: crash.databaseUrl, maxConnections: 1 }));
    let newRunId: string;
    try {
      const instance = (crash.document["instances"] as Record<string, unknown>[])[0] ?? {};
      const row = await database
        .selectFrom("strategy.instances")
        .select(["definition_id"])
        .where("instance_id", "=", String(instance["instanceId"]))
        .executeTakeFirstOrThrow();
      newRunId = await createRepositories(database).strategy.startRun({
        instanceId: String(instance["instanceId"]),
        definitionId: row.definition_id,
        configId: String(instance["configId"]),
        environment: "PAPER",
        codeCommit: "throughput-1a-test-restart",
        stateSchemaVersion: 1,
        runSeed: String(instance["runSeed"]),
      });
    } finally {
      await database.destroy();
    }
    const resumedDocument = {
      ...crash.document,
      instances: (crash.document["instances"] as Record<string, unknown>[]).map((instance) => ({ ...instance, runId: newRunId })),
    };
    const resumed = await startTrader(crash, resumedDocument, "restart-new-run");
    await waitForPosition(crash, crash.envelopes.length, 120_000);
    resumed.child.kill("SIGKILL");
    await resumed.exit;

    const resumedRows = await durableRows(crash.databaseUrl, newRunId, mintedIds(resumedDocument));
    const bEvents = new Set(crash.envelopes.slice(BATCH_A).map((envelope) => envelope.eventId));
    const resumedSources = resumedRows.decisions.map((row) => String(row["source_event_id"]));
    // It decides after the stored position only — and every event there the reference decided.
    expect(resumedSources.every((id) => bEvents.has(id))).toBe(true);
    const referenceB = referenceRows.decisions
      .filter((row) => bEvents.has(String(row["source_event_id"])))
      .map((row) => String(row["source_event_id"]));
    expect(resumedSources).toEqual(referenceB);
    await crash.publisher.close();
  }, 300_000);
});
