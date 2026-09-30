/**
 * `THROUGHPUT-1a` — the trader-throughput benchmark's harness, driven on the
 * COMMITTED sample so it cannot rot.
 *
 * `tools/bench/trader-throughput/run.sh` bundles `support/throughput/` and runs
 * it against the full 100,000-event H1 burst, which is not committed (68.6 MB).
 * This file drives the SAME function, `runTraderThroughput`, on the first
 * 2,000 replayable envelopes of that burst (`test/fixtures/trader-throughput/`,
 * from the first authoritative `BookSnapshot`, index 332) plus the run's
 * `MarketOpened`: REGISTER-1's command into a fresh migrated database, real
 * Redis through `packages/event-bus`, the real durable composition
 * (`assembleDurableTrader`, `RedisMarketEventFeed`, `pump`) on real
 * PostgreSQL. Both modes run: catch-up (everything published first) and paced
 * (published at the recorded `receivedAt` spacing while the trader consumes).
 *
 * WHAT IT PINS. Every envelope consumed and committed, no halt; exactly one
 * durable decision per evaluation (`evaluation_seq` contiguous from 0, one
 * checkpoint per decision, the counts equal to the loop's own); and the
 * NORMALIZED durable content — every decision and checkpoint column except the
 * ids, the wall timestamps and the two values that hash over the ids — equal
 * to the digest measured on the base commit `051d058`
 * (see {@link BASE_DECISIONS}), so a change that alters what the trader
 * decides on this sample fails here.
 *
 * RE-BASELINED BY `THROUGHPUT-2` (ADR-024: one evaluation per venue frame). The
 * pins are now {@link FRAME_NORMALIZED_DECISIONS} / {@link FRAME_DECISIONS}.
 * How they relate to base, measured on one registered clone (`bf1ee89` against
 * the THROUGHPUT-2 candidate, `tools/bench/trader-throughput --limit 2000`): the
 * sample's 2,001 envelopes form 1,092 frames, 908 of them multi-event (905
 * two-token `price_change` frames, 3 multi-trade reference frames). Base made
 * 1,837 decisions; 909 of them were on the FIRST event of a multi-event frame
 * — a half-applied state — and are gone. The candidate's 928 decisions are
 * exactly base's other 928, each equal to base's decision at the same source
 * event in every exported column (feature snapshot address, state patch,
 * `evaluated_at` included) and each with base's checkpoint at that event; only
 * `evaluation_seq` / `checkpoint_seq` are renumbered. The base pins are kept
 * below as the record of what base decided. The digests are id-independent by
 * construction (`harness.ts` `durableContent`); the full-fixture comparison
 * with every column, feature snapshot addresses included, is the benchmark's
 * (`--registered`, see the handoff).
 *
 * Docker: Testcontainers, its own containers, no skip. PAPER only.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EventBusUnavailableError, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { createPostgresPool, migrateUp } from "@polymarket-bot/storage-postgres";
import { createIsolatedDatabase, startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  H1_MARKET_ID,
  firstBaselineIndex,
  readEnvelope,
  readEnvelopes,
  withMarketOpened,
} from "./support/throughput/fixture.js";
import { runTraderThroughput, type ThroughputReport } from "./support/throughput/harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../../fixtures/trader-throughput");

/**
 * Measured on the base commit `051d058` with this harness and this sample
 * (catch-up mode), before any THROUGHPUT-1a product change, and re-measured
 * unchanged on `bf1ee89` (THROUGHPUT-2's base): 1,837 decisions, normalized
 * decision digest `500b0f84d87b61f16ef9aea37f1652163c786b39677100b61c84bfedd2e370df`,
 * normalized checkpoint digest `14acc6afb7d3d6b9cdefe6b03f8ad0ab369008e835600b46c590fdcddf4f7645`.
 * `THROUGHPUT-2` retired those two digest pins (module header); the count stays.
 */
const BASE_DECISIONS = 1_837;

/**
 * `THROUGHPUT-2` (ADR-024): measured on the candidate with this harness and this
 * sample (catch-up mode). See the module header for how they derive from base.
 */
const FRAME_NORMALIZED_DECISIONS = "1abc8596890c2d38b7aef25ca2b9ec9d36b8b19d5110f72029be509ce68634d4";
const FRAME_NORMALIZED_CHECKPOINTS = "ef35b67257e603a2082c33f175619d91c054d9f16d77eb73056bcca15366cd83";
const FRAME_DECISIONS = 928;
/** Base's decisions on the first event of a multi-event frame: the ones that are gone. */
const HALF_APPLIED_BASE_DECISIONS = 909;

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startRedisContainer>>;
let redisUrl: string;
let workRoot: string;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgresContainer(), startRedisContainer()]);
  redisUrl = redis.getConnectionUrl();
  // `TC-LOCAL-FLAKE`: prove the fresh Redis answers before the run starts.
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
  workRoot = await mkdtemp(path.join(tmpdir(), "throughput-harness-"));
}, 300_000);

afterAll(async () => {
  await Promise.all([postgres?.stop(), redis?.stop()]);
  if (workRoot !== undefined) await rm(workRoot, { recursive: true, force: true });
});

async function sampleEnvelopes() {
  const burst = await readEnvelopes(path.join(fixtures, "burst-sample.jsonl"));
  // The committed sample already starts at the burst's first baseline.
  expect(firstBaselineIndex(burst)).toBe(0);
  return withMarketOpened(await readEnvelope(path.join(fixtures, "market-opened.json")), burst);
}

async function run(mode: "catch-up" | "paced", label: string): Promise<ThroughputReport> {
  const isolated = await createIsolatedDatabase(postgres.getConnectionUri(), `tp-${label}`);
  // Two connections: the migration runner holds its advisory lock on one.
  const pool = createPostgresPool({ connectionString: isolated.connectionString, maxConnections: 2 });
  try {
    await migrateUp(pool, { appliedBy: "throughput-1a-test" });
  } finally {
    await pool.end();
  }
  const workDir = await mkdtemp(path.join(workRoot, `${label}-`));
  return await runTraderThroughput({
    redisUrl,
    databaseUrl: isolated.connectionString,
    registration: { kind: "register", templatePath: path.join(fixtures, "template.json") },
    workDir,
    envelopes: await sampleEnvelopes(),
    recordedMarketId: H1_MARKET_ID,
    mode,
    stream: uniqueStreamName(`throughput-${label}`),
    consumerId: "trader-bench",
    retentionMaxEvents: 100_000,
    paceFrom: 1,
    codeCommit: "throughput-1a-test",
    log: () => undefined,
  });
}

function assertCompleteAndOnePerEvaluation(report: ThroughputReport): void {
  expect(report.halts).toEqual([]);
  expect(report.stopped).toBe("COMPLETE");
  expect(report.consumed).toBe(2_001);
  expect(report.events).toBe(2_001);
  // One durable decision per evaluation, contiguous, one checkpoint each.
  expect(report.durable.decisions).toBe(report.health.loop["decisionsPersisted"]);
  expect(report.durable.checkpoints).toBe(report.durable.decisions);
  expect(report.durable.distinctEvaluationSeqs).toBe(report.durable.decisions);
  expect(report.durable.minEvaluationSeq).toBe(0);
  expect(report.durable.maxEvaluationSeq).toBe(report.durable.decisions - 1);
  expect(report.health.loop["eventsAccepted"]).toBe(2_001);
}

describe("the throughput harness on the committed 2,000-event sample", () => {
  it("catch-up: consumes everything, one durable decision per evaluation, and decides once per venue frame", async () => {
    const report = await run("catch-up", "catch-up");
    assertCompleteAndOnePerEvaluation(report);
    expect(report.durable.decisions).toBe(FRAME_DECISIONS);
    expect(FRAME_DECISIONS + HALF_APPLIED_BASE_DECISIONS).toBe(BASE_DECISIONS);
    expect(report.durable.normalizedDecisionContentSha256).toBe(FRAME_NORMALIZED_DECISIONS);
    expect(report.durable.normalizedCheckpointContentSha256).toBe(FRAME_NORMALIZED_CHECKPOINTS);
    // Every event was still processed; the frames split across a batch: none.
    expect((report.health.loop["eventsProcessed"] ?? 0) + (report.health.loop["eventsRefused"] ?? 0)).toBe(2_001);
    expect(report.framesSplit).toBe(0);
    expect(report.lag.count).toBe(2_001);
    expect(report.eventsPerSecond).toBeGreaterThan(0);
  }, 180_000);

  it("paced: publishes at the recorded spacing while the trader consumes, with the same content", async () => {
    const report = await run("paced", "paced");
    assertCompleteAndOnePerEvaluation(report);
    // The same decisions as catch-up: the frames are the same however the
    // publication was spread in time (frame-atomic publication, ADR-024).
    expect(report.durable.normalizedDecisionContentSha256).toBe(FRAME_NORMALIZED_DECISIONS);
    expect(report.durable.normalizedCheckpointContentSha256).toBe(FRAME_NORMALIZED_CHECKPOINTS);
    expect(report.framesSplit).toBe(0);
    // The recorded spacing of the sample's 2,000 envelopes is ~2.3 s; the
    // publication took at least that, and every event's lag was measured.
    expect(report.publish.wallMs).toBeGreaterThan(2_000);
    expect(report.lag.count).toBe(2_001);
  }, 180_000);
});
