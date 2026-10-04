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
 * pins became the per-frame digests and {@link FRAME_DECISIONS}.
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
 * RE-BASELINED BY `CADENCE-1` (ADR-026: at most one `onFeatures` evaluation
 * per market per 1 s of EVENT time, plus a 5 s heartbeat). The trader here is
 * the live composition, so it runs the PAPER cadence — there is no switch.
 * The pins are now {@link CADENCE_NORMALIZED_DECISIONS} /
 * {@link CADENCE_DECISIONS}: the sample's 2,000 burst envelopes span 3,345 ms
 * of recorded time (`receivedAt` 21:02:07.095Z to 21:02:10.440Z; the 2,001st,
 * the prepended `MarketOpened`, is stamped 39 minutes earlier), and at most one
 * evaluation per 1,000 ms of event time gives the trader 4 decisions where the
 * per-frame cadence made 928 (`CADENCE-1` r1, O09: this said "about 2.3 s",
 * which was wrong). Catch-up and paced give the SAME content: the cadence reads event
 * time only, never the processing time (ADR-026 D6-D7). The per-frame pins
 * are kept below as the record of what ADR-024's cadence decided; the
 * decision-by-decision relation to them, on the full burst, is the bench's
 * (`CADENCE-1` handoff).
 *
 * RE-PINNED BY `CKPT-1` (ADR-027: a checkpoint only after a decision that
 * changes the state, the status or the RNG, at the start, at the stop, or on a
 * 60 s event-time heartbeat). The DECISIONS are untouched — the same 4, the
 * same {@link CADENCE_NORMALIZED_DECISIONS} digest. "One checkpoint per
 * decision" no longer holds: the checkpoints are pinned by their own count,
 * {@link CKPT1_CHECKPOINTS}, and digest, {@link CKPT1_NORMALIZED_CHECKPOINTS}.
 * Measured on the candidate in both modes (the same bytes); that the remaining
 * checkpoint rows are base's rows at the same sequences, byte for byte, was
 * checked with the bench's `checkpoints.jsonl` (see the `CKPT-1` handoff). The
 * `CADENCE-1` checkpoint digest is kept below as the record.
 *
 * Docker: Testcontainers, its own containers, no skip. PAPER only.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EventBusUnavailableError, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { createPostgresPool, migrateUp } from "@polymarket-bot/storage-postgres";
import { createIsolatedDatabase } from "@polymarket-bot/storage-postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  H1_MARKET_ID,
  firstBaselineIndex,
  readEnvelope,
  readEnvelopes,
  withMarketOpened,
} from "./support/throughput/fixture.js";
import { runTraderThroughput, type ThroughputReport } from "./support/throughput/harness.js";
import { startReadyPostgresContainer, startReadyRedisContainer } from "./support/containers.js";

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
 * `CADENCE-1` retired its two digest pins — normalized decision digest
 * `1abc8596890c2d38b7aef25ca2b9ec9d36b8b19d5110f72029be509ce68634d4`, normalized
 * checkpoint digest `ef35b67257e603a2082c33f175619d91c054d9f16d77eb73056bcca15366cd83`
 * — as THROUGHPUT-2 retired base's; the count stays.
 */
const FRAME_DECISIONS = 928;
/** Base's decisions on the first event of a multi-event frame: the ones that are gone. */
const HALF_APPLIED_BASE_DECISIONS = 909;

/**
 * `CADENCE-1` (ADR-026): measured on the candidate with this harness and this
 * sample, in BOTH modes (the same bytes). See the module header.
 */
const CADENCE_DECISIONS = 4;
const CADENCE_NORMALIZED_DECISIONS = "5662980df21598ab1d9124ca676ad9c9fa48213c405196289c7c9b54db3ae820";
/**
 * `CADENCE-1`'s checkpoint pin — one checkpoint per decision, 4 — retired by
 * `CKPT-1` and kept as the record of what ADR-026 alone wrote.
 */
const CADENCE_NORMALIZED_CHECKPOINTS = "f2692145057e79755fc42dfeec031f7c0139c5c107292e68af2e419a7dc51925";

/**
 * `CKPT-1` (ADR-027): the checkpoints the same 4 decisions owe, and their
 * normalized digest, measured on the candidate in both modes.
 */
const CKPT1_CHECKPOINTS = 2;
const CKPT1_NORMALIZED_CHECKPOINTS = "f31a2a92d44ddffd87247f1c4fba9cbbb56a597f3aefe07f461d9b1c1d245fb3";

let postgres: Awaited<ReturnType<typeof startReadyPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startReadyRedisContainer>>;
let redisUrl: string;
let workRoot: string;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startReadyPostgresContainer(), startReadyRedisContainer()]);
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
  // One durable decision per evaluation, contiguous. `CKPT-1` re-pin: this
  // read "one checkpoint each"; under ADR-027 the checkpoints are those the
  // decisions owe — the first (START) at least, never more than one each.
  expect(report.durable.decisions).toBe(report.health.loop["decisionsPersisted"]);
  expect(report.durable.checkpoints).toBeGreaterThanOrEqual(1);
  expect(report.durable.checkpoints).toBeLessThanOrEqual(report.durable.decisions);
  expect(report.durable.checkpoints).toBe(CKPT1_CHECKPOINTS);
  expect(report.durable.distinctEvaluationSeqs).toBe(report.durable.decisions);
  expect(report.durable.minEvaluationSeq).toBe(0);
  expect(report.durable.maxEvaluationSeq).toBe(report.durable.decisions - 1);
  expect(report.health.loop["eventsAccepted"]).toBe(2_001);
}

describe("the throughput harness on the committed 2,000-event sample", () => {
  it("catch-up: consumes everything, one durable decision per evaluation, and decides at the ADR-026 cadence", async () => {
    const report = await run("catch-up", "catch-up");
    assertCompleteAndOnePerEvaluation(report);
    expect(report.durable.decisions).toBe(CADENCE_DECISIONS);
    // The per-frame record (ADR-024), kept: what this sample decided before ADR-026.
    expect(FRAME_DECISIONS + HALF_APPLIED_BASE_DECISIONS).toBe(BASE_DECISIONS);
    expect(report.durable.normalizedDecisionContentSha256).toBe(CADENCE_NORMALIZED_DECISIONS);
    expect(report.durable.normalizedCheckpointContentSha256).toBe(CKPT1_NORMALIZED_CHECKPOINTS);
    expect(CKPT1_NORMALIZED_CHECKPOINTS).not.toBe(CADENCE_NORMALIZED_CHECKPOINTS);
    // `CADENCE-1`: every owed market not evaluated at a close is counted, and
    // no event lay 5 s behind the cadence clock.
    expect(report.health.loop["evaluationsCoalesced"]).toBeGreaterThan(0);
    expect(report.health.loop["cadenceForwardJumpAlarms"]).toBe(0);
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
    // publication was spread in time (frame-atomic publication, ADR-024), and
    // the cadence reads event time only (ADR-026 D6-D7).
    expect(report.durable.decisions).toBe(CADENCE_DECISIONS);
    expect(report.durable.normalizedDecisionContentSha256).toBe(CADENCE_NORMALIZED_DECISIONS);
    expect(report.durable.normalizedCheckpointContentSha256).toBe(CKPT1_NORMALIZED_CHECKPOINTS);
    expect(report.framesSplit).toBe(0);
    // The sample's 2,000 burst envelopes span 3,345 ms of recorded time (it
    // said ~2.3 s until `CADENCE-1` r1, O09); a paced publication takes about
    // that long, so it took more than this 2,000 ms floor, and every event's
    // lag was measured.
    expect(report.publish.wallMs).toBeGreaterThan(2_000);
    expect(report.lag.count).toBe(2_001);
  }, 180_000);
});
