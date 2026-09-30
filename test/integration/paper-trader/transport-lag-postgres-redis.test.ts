/**
 * `THROUGHPUT-1a` — the trader's INPUT STREAM lag is visible, and it moves:
 * it RISES while the trader is paused and the market keeps publishing, and
 * FALLS once the trader catches up. Through real Redis (`packages/event-bus`),
 * the real durable composition (`assembleDurableTrader`, the real
 * `RedisMarketEventFeed` and `pump`, real PostgreSQL) and the real
 * `TransportLagSampler` on its own timer — read both from `loop.health()` and
 * from the health endpoint's served JSON.
 *
 * H1 run 1 ran three minutes behind the market with `consumerLag 0` on its
 * health surface (the ingest queue's lag). This file is the evidence that the
 * surface now says how far behind the STREAM the trader is.
 *
 * It also keeps the fail-closed path in view with the sampler attached:
 * retention removing events the trader has not read still halts GLOBAL
 * `TRANSPORT_RESYNC_REQUIRED` (ADR-003 §3.3), exactly as before, and nothing
 * is written after the halt.
 *
 * The events are the committed H1 sample (`test/fixtures/trader-throughput/`)
 * with `receivedAt` RE-STAMPED to the wall clock at publication — the
 * event-time lag is wall clock minus `receivedAt`, and a recorded instant from
 * 2026-09-29 would make it hours whatever the trader did. Nothing else of an
 * envelope changes. Docker: Testcontainers, no skip. PAPER only.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { EventBusUnavailableError, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { createDatabase, createPostgresPool, migrateUp, type PolymarketBotDatabase } from "@polymarket-bot/storage-postgres";
import { createIsolatedDatabase, startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import type { TransportHealth } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleDurableTrader, SystemPaperClock } from "../../../apps/trader/src/main.js";
import { RedisMarketEventFeed } from "../../../apps/trader/src/adapters/redis-feed.js";
import { pump } from "../../../apps/trader/src/pump.js";
import { TransportLagSampler } from "../../../apps/trader/src/transport-lag.js";
import { parseTraderConfig } from "../../../apps/trader/src/index.js";
import { H1_MARKET_ID, readEnvelope, readEnvelopes, remapMarketId, withMarketOpened } from "./support/throughput/fixture.js";
import { benchEnvironment, registerForBench } from "./support/throughput/harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../../fixtures/trader-throughput");

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startRedisContainer>>;
let redisUrl: string;
let workRoot: string;

beforeAll(async () => {
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
  workRoot = await mkdtemp(path.join(tmpdir(), "transport-lag-"));
}, 300_000);

afterAll(async () => {
  await Promise.all([postgres?.stop(), redis?.stop()]);
  if (workRoot !== undefined) await rm(workRoot, { recursive: true, force: true });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

interface Scenario {
  /** The test's own read connection to the scenario's database. */
  readonly db: PolymarketBotDatabase;
  readonly runId: string;
  readonly envelopes: readonly EventEnvelope<unknown>[];
  readonly publisher: RedisStreamsEventTransport;
  readonly stream: string;
  /** Publishes `envelopes[from, to)`, each re-stamped `receivedAt` = the wall clock now. */
  publish(from: number, to: number): Promise<void>;
  /** One pump iteration at a time, until `total` events were ingested or a halt. Answers the pump's last result. */
  pumpUntil(total: number): Promise<"COMPLETE" | "HALTED">;
  readonly sampler: TransportLagSampler;
  transport(): TransportHealth;
  readonly healthUrl: string;
  readonly trader: Extract<Awaited<ReturnType<typeof assembleDurableTrader>>, { ok: true }>["trader"];
  close(): Promise<void>;
}

/** Registers, assembles and subscribes the real durable trader; the sampler reads every 100 ms. */
async function scenario(label: string, retentionMaxEvents: number): Promise<Scenario> {
  const isolated = await createIsolatedDatabase(postgres.getConnectionUri(), `lag-${label}`);
  // The test's own pool, ended by close() directly: a Kysely instance that
  // never ran a query never acquired its pool, so destroying it would leave
  // the migration's connections open until the container stops.
  const pool = createPostgresPool({ connectionString: isolated.connectionString, maxConnections: 2 });
  await migrateUp(pool, { appliedBy: "throughput-1a-test" });
  const db = createDatabase(pool);
  const workDir = await mkdtemp(path.join(workRoot, `${label}-`));
  const completed = await registerForBench({
    databaseUrl: isolated.connectionString,
    templatePath: path.join(fixtures, "template.json"),
    workDir,
    instanceName: `transport-lag-${label}`,
    codeCommit: "throughput-1a-test",
    log: () => undefined,
  });
  const stream = uniqueStreamName(`lag-${label}`);
  const document = {
    ...completed,
    infrastructure: {
      ...(completed["infrastructure"] as Record<string, unknown>),
      eventStream: stream,
      consumerId: "trader-lag",
      retentionMaxEvents,
    },
  };
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) throw new Error(parsed.refusal.detail);
  const config = parsed.config;
  const marketId = config.markets[0]?.marketId ?? "";
  const runId = config.instances[0]?.runId ?? "";
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
    retention: { maxEvents: retentionMaxEvents },
  });
  const transportForTrader = await RedisStreamsEventTransport.connect({
    connection: { url: redisUrl },
    retention: { maxEvents: config.infrastructure.retentionMaxEvents },
  });
  const assembled = await assembleDurableTrader({
    env: benchEnvironment(isolated.connectionString),
    config,
    document,
    postgresUrl: isolated.connectionString,
    clock: new SystemPaperClock(),
    log: () => undefined,
    healthListen: { host: "127.0.0.1", port: 0 },
  });
  if (!assembled.ok) throw new Error(`assembly refused: ${String(assembled.code)}`);
  const { trader, store, healthServer } = assembled;
  const subscription = await transportForTrader.subscribe({ stream, consumerId: "trader-lag" });
  const feed = new RedisMarketEventFeed({ subscription, maxEvents: config.infrastructure.receiveBatchSize });
  // As `startup()` wires it, with a faster cadence so the test is quick.
  const sampler = new TransportLagSampler({ subscription, intervalMs: 100 });
  trader.health.attachTransport(sampler);
  sampler.start();

  let ingested = 0;
  return {
    db,
    runId,
    envelopes,
    publisher,
    stream,
    sampler,
    trader,
    healthUrl: healthServer?.url ?? "",
    async publish(from, to) {
      for (const envelope of envelopes.slice(from, to)) {
        await publisher.publish(stream, { ...envelope, receivedAt: new Date().toISOString() });
      }
    },
    async pumpUntil(total) {
      while (ingested < total) {
        const result = await pump({ loop: trader.loop, feed, halts: trader.halts, maxPolls: 1 });
        ingested += result.ingested;
        if (result.stopped === "HALTED") return "HALTED";
      }
      return "COMPLETE";
    },
    transport: () => trader.loop.health().transport,
    async close() {
      sampler.stop();
      await healthServer?.close();
      await feed.close();
      await store.close();
      await transportForTrader.close();
      await publisher.close();
      await pool.end();
    },
  };
}

/** Waits for the sampler's OWN timer to land a sample taken after this call. */
async function nextSample(run: Scenario): Promise<TransportHealth> {
  const before = run.transport().samples;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const now = run.transport();
    // Two samples later: the first may have been in flight before the call.
    if (now.samples >= before + 2) return now;
    if (Date.now() > deadline) {
      throw new Error(`no transport sample landed within 5 s (samples ${String(now.samples)}, failures ${String(now.sampleFailures)})`);
    }
    await sleep(20);
  }
}

describe("the input stream's lag on the health surface", () => {
  it("RISES while the trader is paused and the stream grows, and FALLS once it catches up", async () => {
    const run = await scenario("rise-fall", 100_000);
    try {
      // 1. Caught up: MarketOpened + 200 events published and consumed.
      await run.publish(0, 201);
      expect(await run.pumpUntil(201)).toBe("COMPLETE");
      const caughtUp = await nextSample(run);
      expect(caughtUp.attached).toBe(true);
      expect(caughtUp.entriesBehindHead).toBe(0);
      expect(caughtUp.headPosition).toBe(201);
      expect(caughtUp.consumerPosition).toBe(201);
      expect(caughtUp.committedPosition).toBe(201);
      expect(caughtUp.retentionMaxEvents).toBe(100_000);

      // 2. Paused: the stream grows by 500 and the trader reads nothing.
      await run.publish(201, 701);
      await sleep(1_200);
      const paused = await nextSample(run);
      expect(paused.entriesBehindHead).toBe(500);
      expect(paused.headPosition).toBe(701);
      expect(paused.consumerPosition).toBe(201);
      // The last PROCESSED event is from step 1, and it only gets older.
      expect(paused.eventTimeLagMs).not.toBeNull();
      expect(paused.eventTimeLagMs ?? 0).toBeGreaterThanOrEqual(1_200);

      // 3. Still paused, the stream keeps growing: both lags rise further.
      await run.publish(701, 1_001);
      const further = await nextSample(run);
      expect(further.entriesBehindHead).toBe(800);
      expect(further.eventTimeLagMs ?? 0).toBeGreaterThan(paused.eventTimeLagMs ?? 0);

      // The health ENDPOINT serves the same section.
      const served = JSON.parse(await get(run.healthUrl)) as { transport: TransportHealth };
      expect(served.transport.attached).toBe(true);
      expect(served.transport.entriesBehindHead).toBe(800);

      // 4. Resumed: the trader drains the 800, then one fresh event arrives.
      expect(await run.pumpUntil(1_001)).toBe("COMPLETE");
      await run.publish(1_001, 1_011);
      expect(await run.pumpUntil(1_011)).toBe("COMPLETE");
      const recovered = await nextSample(run);
      expect(recovered.entriesBehindHead).toBe(0);
      expect(recovered.headPosition).toBe(1_011);
      expect(recovered.committedPosition).toBe(1_011);
      expect(recovered.eventTimeLagMs ?? Number.POSITIVE_INFINITY).toBeLessThan(further.eventTimeLagMs ?? 0);
      expect(recovered.eventTimeLagMs ?? Number.POSITIVE_INFINITY).toBeLessThan(1_000);
      expect(recovered.sampleFailures).toBe(0);
      expect(run.trader.halts.anyHalt).toBe(false);
    } finally {
      await run.close();
    }
  }, 180_000);

  it("retention past the unread position still halts GLOBAL TRANSPORT_RESYNC_REQUIRED, and nothing is written after it", async () => {
    // A retention bound of 50 events; 200 are published while the trader is
    // paused after reading the first 20 — so 130 it never read are removed.
    const run = await scenario("resync", 50);
    try {
      await run.publish(0, 21);
      expect(await run.pumpUntil(21)).toBe("COMPLETE");
      await run.publish(21, 221);
      const behind = await nextSample(run);
      // The lag the operator now sees, past the retention bound it is measured against.
      expect(behind.entriesBehindHead).toBe(200);
      expect(behind.retentionMaxEvents).toBe(50);

      const count = async (table: "strategy.decisions" | "strategy.state_checkpoints"): Promise<number> => {
        const row = await run.db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("run_id", "=", run.runId)
          .executeTakeFirstOrThrow();
        return Number(row.n);
      };
      const decisionsBefore = await count("strategy.decisions");
      const checkpointsBefore = await count("strategy.state_checkpoints");
      expect(decisionsBefore).toBeGreaterThan(0);

      expect(await run.pumpUntil(221)).toBe("HALTED");
      const halts = run.trader.halts.records();
      expect(halts).toHaveLength(1);
      expect(halts[0]?.scope).toEqual({ kind: "GLOBAL" });
      expect(halts[0]?.code).toBe("TRANSPORT_RESYNC_REQUIRED");
      expect(halts[0]?.detail).toContain("retention-exceeded");
      expect(await count("strategy.decisions")).toBe(decisionsBefore);
      expect(await count("strategy.state_checkpoints")).toBe(checkpointsBefore);
    } finally {
      await run.close();
    }
  }, 180_000);
});
