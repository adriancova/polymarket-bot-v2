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
 *   `evaluation_seq` 0…k−1 with nothing missing, and nothing of the
 *   in-flight batch;
 * - EQUAL TO THE UNINTERRUPTED RUN: those k decisions are, column for column
 *   (ids and wall timestamps aside), the reference run's first k, and the
 *   crashed run's checkpoints are exactly the reference run's checkpoints of
 *   those k decisions. (`CKPT-1`, ADR-027: this said "one checkpoint for
 *   each" and "k checkpoints". A checkpoint now follows only a decision that
 *   changes the state, the status or the RNG, or starts, stops or heartbeats
 *   the instance — on this sample 2 of the reference run's 4 decisions — so
 *   the crashed prefix holds the reference's checkpoints whose sequence is
 *   below k, and a decision and its checkpoint commit in one transaction.)
 * - THE POSITION AGREES: the consumer position stored in Redis is never
 *   before the end of A and never past a decision that is not durable. Every
 *   event before it has its decision durable. (`CADENCE-1`: it was exactly
 *   the end of A while every frame decided; under ADR-026 B's first frames
 *   are coalesced and decide nothing, so the position may be recorded inside
 *   B, up to the first batch that holds a decision.)
 *
 * ## The restart
 *
 * Restarting the SAME run is refused (`BOOT-1`: a run with decisions is not
 * resumable, exit 78) — the recovery contract today, unchanged. A NEW run for
 * the same instance (`startRun`, as that refusal instructs) resumes from the
 * stored position: it decides exactly the events after it — every one of
 * them, and none before it.
 *
 * `CADENCE-1` (ADR-026 D2.3): "every one of them" now means what a NEW run
 * decides there. The evaluation cadence is a run's own — `last` is "the value
 * of `now` at the market's last `onFeatures` evaluation in this run" — so the
 * new run starts with no `last`, and over the events after the position it
 * decides exactly what a FRESH run fed only those events decides (computed
 * in-process below, through the same core), not what the uninterrupted run
 * decided there with A's cadence state behind it. Everything before the
 * restart — the prefix, the position, the frame boundary — is unchanged.
 *
 * `THROUGHPUT-2` (ADR-024): every publication here is frame-atomic, as the
 * gateway's is, and the file pins that the stored position is a frame
 * boundary although the crash came while the feed's 128-entry reads were
 * cutting two-token frames — the mid-frame case: the partial frame was never
 * handed to the loop, its position never recorded, and the new run re-reads
 * it whole and decides exactly what the uninterrupted run decided after A.
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
import { uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { createDatabase, createPostgresPool, createRepositories, migrateUp } from "@polymarket-bot/storage-postgres";
import { createIsolatedDatabase } from "@polymarket-bot/storage-postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PAPER_EVALUATION_CADENCE,
  buildSimulatedVenue,
  createPaperTrader,
  parseTraderConfig,
  sameFrame,
} from "@polymarket-bot/trader";
import { ManualClock, MemoryTraderStore } from "@polymarket-bot/trader/testing";

import { H1_MARKET_ID, readEnvelope, readEnvelopes, remapMarketId, withMarketOpened } from "./support/throughput/fixture.js";
import { benchEnvironment, registerForBench } from "./support/throughput/harness.js";
import { startReadyPostgresContainer, startReadyRedisContainer } from "./support/containers.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const fixtures = path.resolve(here, "../../fixtures/trader-throughput");

/**
 * `CADENCE-1` (ADR-026): the durable decisions an uninterrupted run makes on
 * the sample at the PAPER cadence — see
 * `throughput-bench-harness-postgres-redis.test.ts`, which pins the same.
 */
const CADENCE_DECISIONS = 4;

/** Batch A: `MarketOpened` + the sample's first 460 envelopes (B opens on a book snapshot pair). */
const BATCH_A = 461;

let postgres: Awaited<ReturnType<typeof startReadyPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startReadyRedisContainer>>;
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
  [postgres, redis] = await Promise.all([startReadyPostgresContainer(), startReadyRedisContainer()]);
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

/**
 * `THROUGHPUT-2` (ADR-024): published as the gateway publishes — every raw
 * frame (a run of consecutive envelopes sharing a `causationId`) in ONE
 * atomic `publishBatch` call — so the trader's feed can close a frame at a
 * short read. `from`/`to` must fall on frame boundaries (asserted).
 */
async function publish(run: Scenario, from: number, to: number): Promise<void> {
  expect(onFrameBoundary(run.envelopes, from) && onFrameBoundary(run.envelopes, to)).toBe(true);
  for (let start = from; start < to; ) {
    let end = start + 1;
    while (end < to && sameFrame(run.envelopes[start], run.envelopes[end])) end += 1;
    const frame = run.envelopes.slice(start, end);
    const result = await run.publisher.publishBatch(run.stream, frame);
    expect(result.failure).toBeUndefined();
    expect(result.receipts).toHaveLength(frame.length);
    start = end;
  }
}

/**
 * `CADENCE-1`: `publish`, but in as FEW transport calls as possible — runs of
 * whole frames of at most 1,024 envelopes (the transport's one-call limit) —
 * so a reader sees B's first 128 entries at once. Still frame-atomic: no
 * frame is ever split across two calls (ADR-024 D2.1).
 */
async function publishInWholeFrameRuns(run: Scenario, from: number, to: number): Promise<void> {
  expect(onFrameBoundary(run.envelopes, from) && onFrameBoundary(run.envelopes, to)).toBe(true);
  for (let start = from; start < to; ) {
    let end = Math.min(start + 1_024, to);
    while (end > start + 1 && !onFrameBoundary(run.envelopes, end)) end -= 1;
    const result = await run.publisher.publishBatch(run.stream, run.envelopes.slice(start, end));
    expect(result.failure).toBeUndefined();
    expect(result.receipts).toHaveLength(end - start);
    start = end;
  }
}

/** Is `index` a frame boundary: no frame has events on both sides of it? */
function onFrameBoundary(envelopes: readonly EventEnvelope<unknown>[], index: number): boolean {
  return index <= 0 || index >= envelopes.length || !sameFrame(envelopes[index - 1], envelopes[index]);
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

/**
 * `CADENCE-1` (ADR-026 D2.3): the source events a FRESH run of `document` —
 * the same core, the PAPER cadence, no history — decides at over `envelopes`,
 * fed frame by frame as the trader's feed hands frames out (never split). In
 * process, over the in-memory store: only the cadence decides WHICH events
 * are evaluated, and it reads event time only (D6).
 */
async function freshRunSources(
  document: Record<string, unknown>,
  envelopes: readonly EventEnvelope<unknown>[],
): Promise<string[]> {
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
  const clock = new ManualClock(envelopes[0]?.receivedAt ?? "2026-09-29T21:00:00Z");
  const built = buildSimulatedVenue({ clock, settings: parsed.config.simulation });
  if (!built.ok) throw new Error(built.refusal.message);
  const created = createPaperTrader({
    env: benchEnvironment("postgres://unused"),
    config: document,
    clock,
    venue: built.venue,
    store: new MemoryTraderStore(),
    idNamespace: "cadence-1-fresh-run",
    evaluationCadence: PAPER_EVALUATION_CADENCE,
  });
  if (!created.ok) throw new Error(`${created.refusal.code}: ${created.refusal.issues.join("; ")}`);
  built.wiring.trader = created.trader;
  const loop = created.trader.loop;
  for (let start = 0; start < envelopes.length; ) {
    let end = start + 1;
    while (end < envelopes.length && sameFrame(envelopes[start], envelopes[end])) end += 1;
    for (const [offset, envelope] of envelopes.slice(start, end).entries()) {
      loop.ingest({
        envelope,
        identity: {
          gatewayEpoch: envelope.gatewayEpoch,
          ingestSeq: envelope.ingestSeq,
          receivedAt: envelope.receivedAt,
          datasetRowOrdinal: start + offset,
        },
      });
    }
    await loop.drain();
    start = end;
  }
  expect(created.trader.halts.anyHalt).toBe(false);
  return loop.decisions().map((decision) => decision.sourceEventId);
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
    // `CADENCE-1` (ADR-026): at most one evaluation per market per 1 s of event
    // time — the sample's CADENCE_DECISIONS
    // (`throughput-bench-harness-postgres-redis.test.ts` pins the same count;
    // per frame (ADR-024) it was 928, per event 1,837, and this line read
    // "> 1,000").
    expect(referenceRows.decisions.length).toBe(CADENCE_DECISIONS);
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
      // `CADENCE-1` (ADR-026): B in whole-frame RUNS, so the trader's first
      // read of B is a full 128-entry batch, and it holds B's first decision
      // (the cadence evaluates at most once per 1 s of event time, so B's
      // first ~60 envelopes are coalesced and decide nothing — read alone,
      // their batch would be durable at once and its position recorded past
      // the end of A, mid-book, where no new run could resume).
      await publishInWholeFrameRuns(crash, BATCH_A, crash.envelopes.length);
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
    // No gap, no duplicate: 0…k−1.
    expect(crashed.decisions.map((row) => row["seq"])).toEqual(Array.from({ length: k }, (_, index) => String(index)));
    // Equal to the uninterrupted run, column for column. `CKPT-1` re-pin
    // (ADR-027): the checkpoints are the reference's checkpoints of the first
    // k decisions — no longer one per decision (the reference holds fewer
    // checkpoints than decisions; see the header).
    expect(crashed.decisions).toEqual(referenceRows.decisions.slice(0, k));
    expect(referenceRows.checkpoints.length).toBeLessThan(referenceRows.decisions.length);
    expect(crashed.checkpoints).toEqual(referenceRows.checkpoints.filter((row) => Number(row["seq"]) < k));
    expect(crashed.checkpoints.length).toBeGreaterThan(0);
    // The stored position agrees: never before the end of A, and never past a
    // decision that is not durable. `CADENCE-1` (ADR-026): it may now lie
    // INSIDE B — B's first frames, within 1 s of event time of A's last
    // evaluation, are coalesced and decide nothing, so their batches are
    // durable at once and their position is recorded; the first batch with a
    // decision is the one whose commit the lock holds. (Per frame, every
    // frame decided, and the position stopped exactly at the end of A.)
    const position = (await recordedPosition(crash)) ?? -1;
    expect(position).toBeGreaterThanOrEqual(BATCH_A);
    expect(position).toBeLessThan(crash.envelopes.length);
    // With B published in whole-frame runs, the first batch of B holds its
    // first decision, so the position is exactly the end of A.
    expect(position).toBe(BATCH_A);
    // Every decision of an event before the position is durable, and nothing
    // of the in-flight rest is.
    const beforePosition = new Set(crash.envelopes.slice(0, position).map((envelope) => envelope.eventId));
    const referenceBefore = referenceRows.decisions.filter((row) => beforePosition.has(String(row["source_event_id"])));
    expect(k).toBe(referenceBefore.length);
    expect(k).toBeLessThan(referenceRows.decisions.length);
    // `THROUGHPUT-2` (ADR-024 D5): and never inside a venue frame. The trader
    // was killed mid-B with B's frames read in 128-entry batches — whose
    // boundaries cut two-token frames (checked below), so the feed was
    // carrying partial frames — and the position it had recorded is still a
    // frame boundary: a restart re-reads every frame whole.
    expect(onFrameBoundary(crash.envelopes, position)).toBe(true);
    const receiveBatch = Number(
      (crash.document["infrastructure"] as Record<string, unknown>)["receiveBatchSize"],
    );
    const cutFrames = Array.from({ length: Math.floor((crash.envelopes.length - BATCH_A) / receiveBatch) }, (_, n) =>
      BATCH_A + (n + 1) * receiveBatch,
    ).filter((boundary) => !onFrameBoundary(crash.envelopes, boundary));
    expect(cutFrames.length).toBeGreaterThan(0);

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
        // `CADENCE-1` (ADR-026 D1.4-D1.5): the cadence every live run records.
        evaluationIntervalMs: 1000,
        evaluationHeartbeatMs: 5000,
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
    const afterPosition = new Set(crash.envelopes.slice(position).map((envelope) => envelope.eventId));
    const resumedSources = resumedRows.decisions.map((row) => String(row["source_event_id"]));
    // It decides after the stored position only — and, `CADENCE-1` (ADR-026
    // D2.3), at exactly the events a FRESH run fed only those events decides
    // at: a new run's cadence has no `last` (see the module header).
    expect(resumedSources.length).toBeGreaterThan(0);
    expect(resumedSources.every((id) => afterPosition.has(id))).toBe(true);
    expect(resumedSources).toEqual(await freshRunSources(resumedDocument, crash.envelopes.slice(position)));
    await crash.publisher.close();
  }, 300_000);
});
