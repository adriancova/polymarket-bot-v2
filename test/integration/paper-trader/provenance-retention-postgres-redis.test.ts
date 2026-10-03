/**
 * `PROVENANCE-1`, deliverable 4 — raw WAL expires WHERE A TRADER RUNS, end to
 * end, through the REAL composition roots on a real PostgreSQL:
 *
 * 1. the paper trader's own `startup()` (Redis feed, pump, PostgreSQL store)
 *    runs one market window, and its decisions carry their dispatch position;
 * 2. the research worker's `postgresTraderEvidence.dispatchFrontiers` returns
 *    a frontier for the instance, from those rows;
 * 3. the window does NOT classify before its durability grace has passed
 *    (the real `runStorageCycle`, dry run, its clock just after the window),
 *    and DOES once it has (the real `storageMain`, today);
 * 4. in that `execute` cycle, with the opt-in marker on a throwaway WAL root,
 *    a segment older than 72 h with no pin obligation EXPIRES — deleted, its
 *    receipt naming no pin;
 * 5. a segment under the window's FILL pin is KEPT: its exact frames are in
 *    the pin (kept forever, `keepUntil` null), extracted and verified before
 *    the raw file was released, as ADR-028 Decisions 2.4 and 3 require.
 *
 * This is `BURN-IN`'s criterion "raw expiry, pins and backups ran and were
 * verified" for raw expiry and pins, proven in-repo on fixtures — not on a
 * live run, and not for backups (B2 is `HOST-1`'s).
 *
 * WHY IT COULD NOT PASS BEFORE (`H1R1-PROVENANCE`): the trader wrote every
 * decision's `gateway_epoch` and `ingest_seq` as NULL, so
 * `dispatchFrontiers` returned no frontier, `classificationBlocker` refused
 * the window ("has no durable decision carrying a dispatch position"), and
 * the planner kept every segment the window could overlap — and every
 * segment naming its market — forever.
 *
 * THE FIXTURE. One gateway epoch, recorded by the REAL `WP-050` WAL writer
 * into a temporary directory, and the SAME timeline published to Redis as the
 * normalized events the gateway would dispatch: each raw frame takes one
 * `ingestSeq` and its event the next (a live gateway assigns every envelope
 * its own `ingestSeq` after the frame's, `frames.ts`). The market is the
 * registered one (`2026-03-04T12:00Z`-`12:15Z`, months older than 72 h):
 *
 * - stretch A, 10:00-10:10: reference prints only, far before the window —
 *   the segments with no pin obligation;
 * - stretch B, 11:59:58-12:15: the Static Bracket fixture's market (open, both
 *   books, an entry that fills) plus reference prints — the window;
 * - stretch C, 12:15-12:40: reference prints only — the trader keeps deciding
 *   on them, which carries its frontier past the window and its grace.
 *
 * Docker: Testcontainers (PostgreSQL, Redis), no skip. PAPER only; no venue,
 * no signer, no real order. The WAL root, object store and state directory
 * are throwaway temporary directories; nothing outside them is touched.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBusUnavailableError, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { startFreezableRedisProxy, startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import {
  NON_FILL_PIN_RETENTION_MS,
  postgresTraderEvidence,
  readPinRecord,
  runStorageCycle,
  storageMain,
  type BootClock,
  type MarketWindow,
} from "@polymarket-bot/research-worker";
import {
  EXPIRY_OPT_IN_MARKER_CONTENT,
  EXPIRY_OPT_IN_MARKER_FILE_NAME,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
  parseRetentionReceipt,
  readParquetObject,
} from "@polymarket-bot/storage-parquet";
import { manualClock } from "@polymarket-bot/storage-parquet/testing";
import { startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import type { IngestedEvent } from "@polymarket-bot/trader";
import { buildRawFrameRecord, nodeWalFileSystem, openWalWriter, type RawFrameRecord } from "@polymarket-bot/storage-wal";
import { createManualClock } from "@polymarket-bot/storage-wal/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXIT_CODES, REDIS_RESPONSE_TIMEOUT_ENV, startup } from "../../../apps/trader/src/main.js";
import {
  GATEWAY_EPOCH,
  NO_TOKEN,
  T_CLOSE,
  T_OPEN,
  YES_TOKEN,
  ingested,
  resetEventIds,
  riskPolicy,
  safeEnvironment,
} from "./support/fixture.js";
import { CONDITION_ID, documentFor, registerThroughTheRepositories, withFreshDatabase } from "./support/registration.js";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const OPEN_MS = Date.parse(T_OPEN);
const CLOSE_MS = Date.parse(T_CLOSE);
/** The storage command's defaults (`storage-config.ts`), stated so the arithmetic below is visible. */
const LEAD_IN_MS = 15 * MINUTE;
const GRACE_MS = 60 * 1000;
/** The registry's `responsibleFrom`: the trader can act before the window opens. */
const RESPONSIBLE_FROM_MS = OPEN_MS - 15 * MINUTE;
const STRETCH_A_END_MS = Date.parse("2026-03-04T10:10:00.000Z");

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;
/** ONE Redis for the file (each scenario has its own stream; an outage is a partition, never a stop). */
let redis: Awaited<ReturnType<typeof startRedisContainer>>;

beforeAll(async () => {
  postgres = await startPostgresContainer();
  redis = await startRedisContainer();
}, 300_000);

afterAll(async () => {
  await redis?.stop();
  await postgres?.stop();
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

async function connectPublisher(url: string): Promise<RedisStreamsEventTransport> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await RedisStreamsEventTransport.connect({ connection: { url }, retention: { maxEvents: 100_000 } });
    } catch (failure) {
      if (!(failure instanceof EventBusUnavailableError)) throw failure;
      lastFailure = failure;
      await sleep(400);
    }
  }
  throw new Error(`a fresh Redis container never accepted a connection: ${String(lastFailure)}`);
}

interface Timeline {
  readonly raws: readonly RawFrameRecord[];
  readonly events: readonly IngestedEvent[];
}

/** The gateway's two outputs, as one gateway epoch records and dispatches them. */
interface GatewayRecorder extends Timeline {
  /** A reference print: one raw frame, then its event. */
  readonly binance: (atMs: number, price: string) => void;
  /** A book snapshot: one raw frame, then its event. */
  readonly book: (
    atMs: number,
    tokenId: string,
    bids: readonly { price: string; size: string }[],
    asks: readonly { price: string; size: string }[],
  ) => void;
  /** The market's opening: an event with its own `ingestSeq`, from no market-data frame. */
  readonly opened: (atMs: number) => void;
}

/**
 * One gateway epoch's recorder: each raw frame takes one `ingestSeq` and its
 * event the next, from 1 (a live gateway assigns every envelope its own
 * `ingestSeq` after the frame's, `frames.ts`).
 */
function gatewayRecorder(gatewayEpoch: string, marketId: string, conditionId: string): GatewayRecorder {
  const raws: RawFrameRecord[] = [];
  const events: IngestedEvent[] = [];
  let seq = 0;
  const iso = (atMs: number): string => new Date(atMs).toISOString();
  // The fixture stamps its own epoch; another epoch's events carry theirs.
  const dispatched = (event: IngestedEvent): IngestedEvent =>
    gatewayEpoch === GATEWAY_EPOCH
      ? event
      : { envelope: { ...event.envelope, gatewayEpoch }, identity: { ...event.identity, gatewayEpoch } };
  return {
    raws,
    events,
    binance: (atMs, price) => {
      seq += 1;
      raws.push(
        buildRawFrameRecord({
          gatewayEpoch,
          ingestSeq: String(seq),
          source: "binance",
          endpoint: "wss://data-stream.binance.vision/stream",
          connectionId: "bn-1",
          subscriptionGeneration: 0,
          receivedAt: iso(atMs),
          receivedMonotonicNs: String(seq * 1_000_000),
          payloadUtf8: JSON.stringify({
            stream: "btcusdt@trade",
            data: { e: "trade", E: atMs, s: "BTCUSDT", t: seq, p: price, q: "0.25", T: atMs, m: false, M: true },
          }),
        }),
      );
      seq += 1;
      events.push(
        dispatched(
          ingested(
            "ReferenceTradeObserved",
            { venue: "binance", symbol: "BTCUSDT", price, size: "0.25" },
            { receivedAt: iso(atMs), ingestSeq: seq, source: "binance" },
          ),
        ),
      );
    },
    book: (atMs, tokenId, bids, asks) => {
      seq += 1;
      raws.push(
        buildRawFrameRecord({
          gatewayEpoch,
          ingestSeq: String(seq),
          source: "polymarket",
          endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
          connectionId: "pm-1",
          subscriptionGeneration: 0,
          receivedAt: iso(atMs),
          receivedMonotonicNs: String(seq * 1_000_000),
          payloadUtf8: JSON.stringify([
            { event_type: "book", market: conditionId, asset_id: tokenId, bids, asks, timestamp: String(atMs) },
          ]),
        }),
      );
      seq += 1;
      events.push(
        dispatched(
          ingested("BookSnapshot", { internalMarketId: marketId, tokenId, bids, asks }, { receivedAt: iso(atMs), ingestSeq: seq }),
        ),
      );
    },
    opened: (atMs) => {
      seq += 1;
      events.push(
        dispatched(
          ingested("MarketOpened", { internalMarketId: marketId, conditionId, openedAt: T_OPEN }, { receivedAt: iso(atMs), ingestSeq: seq }),
        ),
      );
    },
  };
}

const YES_BIDS = [
  { price: "0.32", size: "200" },
  { price: "0.31", size: "300" },
];
const YES_ASKS = [
  { price: "0.34", size: "200" },
  { price: "0.35", size: "300" },
];
const NO_BIDS = [{ price: "0.65", size: "200" }];
const NO_ASKS = [{ price: "0.66", size: "200" }];

/** The gateway's two outputs for one timeline: the raw frames it records and the events it dispatches. */
function timeline(marketId: string, conditionId: string): Timeline {
  resetEventIds();
  const { raws, events, binance, book, opened } = gatewayRecorder(GATEWAY_EPOCH, marketId, conditionId);

  // Stretch A: reference prints only, 10:00-10:10.
  for (let atMs = Date.parse("2026-03-04T10:00:00.000Z"); atMs <= STRETCH_A_END_MS; atMs += 20_000) binance(atMs, "99000");
  // Stretch B: the window — the fixture's market, an entry that fills, reference prints throughout.
  binance(OPEN_MS - 2_000, "100000");
  binance(OPEN_MS - 1_000, "100100");
  opened(OPEN_MS);
  book(OPEN_MS + 1_000, YES_TOKEN, YES_BIDS, YES_ASKS);
  book(OPEN_MS + 2_000, NO_TOKEN, NO_BIDS, NO_ASKS);
  book(OPEN_MS + 3_000, YES_TOKEN, YES_BIDS, YES_ASKS);
  // The venue re-sends each book periodically (a snapshot a minute here), so a
  // trader restarted mid-window has an authoritative book again (§7.1).
  const resend = (atMs: number): void => {
    if ((atMs - OPEN_MS) % MINUTE !== 0) return;
    book(atMs + 1, YES_TOKEN, YES_BIDS, YES_ASKS);
    book(atMs + 2, NO_TOKEN, NO_BIDS, NO_ASKS);
  };
  for (let atMs = OPEN_MS + 10_000; atMs < CLOSE_MS; atMs += 10_000) {
    binance(atMs, "100050");
    resend(atMs);
  }
  // Stretch C: reference prints (and the books) after the window, 12:15-12:40.
  for (let atMs = CLOSE_MS; atMs <= CLOSE_MS + 25 * MINUTE; atMs += 10_000) {
    binance(atMs, "100020");
    resend(atMs);
  }
  return { raws, events };
}

/**
 * Records the raw frames through the real WAL writer and seals the last
 * segment. It rotates on size (6 kB) and on age (5 minutes of the writer's
 * own clock, which follows the frames' receipt instants), as a recorder
 * does, so the gap between stretch A and the window closes a segment.
 */
async function recordWal(directoryPath: string, raws: readonly RawFrameRecord[]): Promise<void> {
  const first = raws[0];
  if (first === undefined) throw new Error("no frame");
  let previousMs = Date.parse(first.receivedAt);
  const clock = createManualClock({ startEpochMs: previousMs });
  const writer = await openWalWriter({
    directoryPath,
    gatewayEpoch: first.gatewayEpoch,
    fileSystem: nodeWalFileSystem(),
    clock,
    maxSegmentBytes: 6_000,
    maxSegmentAgeMs: 5 * MINUTE,
  });
  for (const raw of raws) {
    const atMs = Date.parse(raw.receivedAt);
    clock.advance(atMs - previousMs);
    previousMs = atMs;
    const result = writer.enqueue(raw);
    if (!result.accepted) throw new Error(`WAL writer refused a frame: ${result.reason}`);
    await writer.drain();
  }
  await writer.close();
}

async function segmentFiles(directoryPath: string): Promise<string[]> {
  return (await readdir(directoryPath)).filter((name) => name.endsWith(".wal.jsonl")).sort();
}

/** Runs the storage command's composition root with `env`, and returns its exit code and its one-line report. */
async function storageCommand(env: Record<string, string>): Promise<{ readonly code: number; readonly report: Record<string, unknown> }> {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const printed: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const code = await storageMain({ cycleLockTimeoutMs: 10_000, operatorPinLockTimeoutMs: 10_000 });
    const line = printed.find((candidate) => candidate.includes('"event":"storage-cycle"'));
    if (line === undefined) throw new Error(`the storage command printed no report:\n${printed.join("\n")}`);
    return { code, report: JSON.parse(line) as Record<string, unknown> };
  } finally {
    spy.mockRestore();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface SegmentVerdict {
  readonly segmentId: string;
  readonly eligible: boolean;
  readonly maxReceivedAt: string | null;
  readonly reasons: readonly string[];
}

type Scenario =
  /** The fixture's policy: the entry fills — a FILL pin, kept forever. */
  | "fill"
  /** The entry is refused by the real risk engine — a REFUSAL pin, kept 30 days. */
  | "refusal"
  /**
   * The entry is refused, AND the trader halts inside the window (a partition
   * at 12:05) and is RESTARTED as a new run of the same instance, which goes
   * on from its recorded stream position — a HALT pin, kept 30 days.
   */
  | "halt-and-restart";

const HALT_AT_MS = OPEN_MS + 5 * MINUTE;

/** The fixture's risk policy with the worst-case loss limit below the entry's 17. */
function refusingPolicy(): Record<string, unknown> {
  const policy = riskPolicy();
  return { ...policy, limits: { ...(policy["limits"] as Record<string, unknown>), maxWorstCaseContractualLoss: "1" } };
}

/** Runs the REAL `startup()` until the events it was given are committed, then partitions it; answers its log. */
async function runTraderThrough(input: {
  readonly redisUrl: string;
  readonly connectionString: string;
  readonly document: Record<string, unknown>;
  readonly label: string;
  readonly publisher: RedisStreamsEventTransport;
  readonly stream: string;
  readonly events: readonly IngestedEvent[];
  readonly publishedBefore: number;
}): Promise<readonly string[]> {
  const hop = await startFreezableRedisProxy(input.redisUrl);
  const lines: string[] = [];
  try {
    const exit = startup({
      env: {
        ...safeEnvironment(),
        TRADER_CONFIG_PATH: `/${input.label}.json`,
        REDIS_URL: hop.url,
        DATABASE_URL: input.connectionString,
        [REDIS_RESPONSE_TIMEOUT_ENV]: "1000",
      },
      readConfig: () => Promise.resolve(JSON.stringify(input.document)),
      log: (line) => {
        lines.push(line);
      },
    });
    for (const event of input.events) await input.publisher.publish(input.stream, event.envelope);
    const total = input.publishedBefore + input.events.length;
    await waitFor(`the trader to commit past all ${String(total)} events`, 120_000, async () => {
      const metrics = await input.publisher.streamMetrics(input.stream);
      const lag = metrics.consumerLag.find((entry) => entry.consumerId === "trader-1")?.lag;
      return metrics.publishedTotal === total && lag === 0 ? metrics : undefined;
    });
    // A running trader ends the only way it can: a halt (here a partition).
    hop.freeze();
    expect(await exit, lines.join("\n")).toBe(EXIT_CODES.halted);
    expect(lines.join("\n")).toContain("halt record: 1 row(s) written to ops.incidents");
    return lines;
  } finally {
    await hop.close();
  }
}

async function retentionScenario(scenario: Scenario): Promise<void> {
  const label = `prov-retention-${scenario}`;
  const root = await mkdtemp(join(tmpdir(), "pmb-provenance-1-"));
  const walRoot = join(root, "wal");
  try {
    await withFreshDatabase(postgres.getConnectionUri(), label, async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, label);
      const conditionId = `${CONDITION_ID}-${label}`;
      const { raws, events } = timeline(registered.marketId, conditionId);
      await recordWal(walRoot, raws);
      const recorded = await segmentFiles(walRoot);
      expect(recorded.length).toBeGreaterThanOrEqual(8);

      // --- 1. the paper trader, through startup(), runs the window ------------------
      const stream = uniqueStreamName(label);
      const base = documentFor(registered, label);
      const documentOf = (runId: string): Record<string, unknown> => {
        const named = documentFor(registered, label, { runId });
        return {
          ...named,
          infrastructure: { ...(base["infrastructure"] as Record<string, unknown>), eventStream: stream },
          ...(scenario === "fill" ? {} : { riskPolicy: refusingPolicy() }),
        };
      };
      const publisher = await connectPublisher(redis.getConnectionUrl());
      let runIds: readonly string[];
      try {
        if (scenario === "halt-and-restart") {
          const before = events.filter((event) => Date.parse(event.envelope.receivedAt) <= HALT_AT_MS);
          const after = events.slice(before.length);
          await runTraderThrough({
            redisUrl: redis.getConnectionUrl(),
            connectionString,
            document: documentOf(registered.runId),
            label: `${label}-1`,
            publisher,
            stream,
            events: before,
            publishedBefore: 0,
          });
          // The operator's restart: a NEW run of the same instance and config (BOOT-1).
          const restartRunId = await context.repositories.strategy.startRun({
            instanceId: registered.instanceId,
            definitionId: registered.definitionId,
            configId: registered.configId,
            environment: "PAPER",
            codeCommit: "provenance-1-restart",
            stateSchemaVersion: 1,
            runSeed: "424242",
          });
          await runTraderThrough({
            redisUrl: redis.getConnectionUrl(),
            connectionString,
            document: documentOf(restartRunId),
            label: `${label}-2`,
            publisher,
            stream,
            events: after,
            publishedBefore: before.length,
          });
          runIds = [registered.runId, restartRunId];
        } else {
          await runTraderThrough({
            redisUrl: redis.getConnectionUrl(),
            connectionString,
            document: documentOf(registered.runId),
            label,
            publisher,
            stream,
            events,
            publishedBefore: 0,
          });
          runIds = [registered.runId];
        }
      } finally {
        await publisher.close();
      }

      const decisions = await context.db
        .selectFrom("strategy.decisions")
        .selectAll()
        .where("instance_id", "=", registered.instanceId)
        .orderBy("decision_id")
        .execute();
      expect(new Set(decisions.map((row) => row.run_id))).toEqual(new Set(runIds));
      const byId = new Map(events.map((event) => [event.envelope.eventId, event.envelope]));
      const positioned = decisions.filter((row) => row.ingest_seq !== null);
      for (const row of decisions) {
        if (row.source_event_id === null) {
          expect([row.gateway_epoch, row.ingest_seq]).toEqual([null, null]);
          continue;
        }
        expect([row.gateway_epoch, row.ingest_seq]).toEqual([GATEWAY_EPOCH, byId.get(row.source_event_id)?.ingestSeq]);
      }
      // It evaluated through the window and kept deciding after it (stretch C).
      expect(positioned.some((row) => Date.parse(String(row.evaluated_at)) > CLOSE_MS + GRACE_MS)).toBe(true);
      expect(decisions.some((row) => row.decision_type === "enter")).toBe(true);
      const refusals = await context.db.selectFrom("ops.risk_events").selectAll().execute();
      const halts = await context.db.selectFrom("ops.incidents").selectAll().orderBy("incident_id").execute();
      if (scenario === "fill") expect(refusals).toEqual([]);
      else expect(refusals.length).toBeGreaterThanOrEqual(1);
      // One halt row per run: each run ended on its partition.
      expect(halts.map((row) => [row.failure_class, row.instance_id])).toEqual(
        runIds.map(() => ["TRANSPORT_UNAVAILABLE", registered.instanceId]),
      );
      if (scenario === "halt-and-restart") {
        expect(Date.parse(String(halts[0]?.opened_at))).toBeLessThanOrEqual(HALT_AT_MS);
        expect(Date.parse(String(halts[0]?.opened_at))).toBeGreaterThanOrEqual(OPEN_MS);
      }

      // --- 2. the research worker's own adapter returns a frontier -------------------
      const evidence = postgresTraderEvidence(context.db, { environment: "PAPER" });
      const frontiers = await evidence.dispatchFrontiers([registered.instanceId]);
      const maxSeq = positioned.reduce((max, row) => Math.max(max, Number(row.ingest_seq)), 0);
      expect(frontiers.get(registered.instanceId)).toEqual({
        byEpoch: new Map([[GATEWAY_EPOCH, String(maxSeq)]]),
        completedEpochs: new Set(),
      });

      const registry = join(root, "windows.json");
      const window = {
        windowId: `btc-updown-15m-${scenario}`,
        marketId: registered.marketId,
        conditionId,
        tokenIds: [YES_TOKEN, NO_TOKEN],
        windowStart: T_OPEN,
        windowEnd: T_CLOSE,
        responsibleFrom: new Date(RESPONSIBLE_FROM_MS).toISOString(),
        responsibility: { kind: "trader", instanceIds: [registered.instanceId] },
      };
      await writeFile(registry, JSON.stringify({ windowRegistryVersion: 1, windows: [window] }));

      // --- 3a. before the grace has passed: NOT classified, nothing released ---------
      const marketWindow: MarketWindow = {
        windowId: window.windowId,
        marketId: registered.marketId,
        conditionId,
        gammaMarketId: null,
        tokenIds: window.tokenIds,
        windowStartMs: OPEN_MS,
        windowEndMs: CLOSE_MS,
        responsibleFromMs: RESPONSIBLE_FROM_MS,
        responsibility: { kind: "trader", instanceIds: [registered.instanceId] },
      };
      const steady: BootClock = { bootId: async () => "boot", sinceBootMs: async () => 1_000 };
      const early = await runStorageCycle({
        walRootPath: walRoot,
        objectStore: fileSystemObjectStore(join(root, "early-objects")),
        fileSystem: nodeCompactionFileSystem(),
        clock: manualClock(CLOSE_MS + GRACE_MS / 2),
        bootClock: steady,
        evidence,
        loadWindows: async () => [marketWindow],
        loadOperatorPins: async () => [],
        settings: {
          retentionMs: 72 * HOUR,
          leadInMs: LEAD_IN_MS,
          durabilityGraceMs: GRACE_MS,
          pinBudgetBytesPerDay: 3_000_000_000,
          expiryStuckAfterMs: 6 * HOUR,
          walMaxTotalBytes: null,
          maxSegmentsPerDataset: 64,
          extractionBatchDelayMs: 0,
        },
        mode: "dry-run",
        deletion: null,
        stateDirectory: join(root, "early-state"),
      });
      expect(early.classifications).toMatchObject([
        { windowId: window.windowId, state: "unclassified", reason: "the durability grace after the window's end has not passed" },
      ]);
      expect(await segmentFiles(walRoot)).toEqual(recorded);

      // --- 3b + 4 + 5. the storage command, execute, today ----------------------------
      await writeFile(join(walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
      const objectStoreRoot = join(root, "objects");
      const { code, report } = await storageCommand({
        RESEARCH_WORKER_WAL_ROOT: walRoot,
        RESEARCH_WORKER_OBJECT_STORE_ROOT: objectStoreRoot,
        RESEARCH_WORKER_STATE_DIR: join(root, "state"),
        RESEARCH_WORKER_WINDOW_REGISTRY: registry,
        RESEARCH_WORKER_TRADER_DATABASE_URL: connectionString,
        RESEARCH_WORKER_TRADER_ENVIRONMENT: "PAPER",
        RESEARCH_WORKER_EXPIRY_MODE: "execute",
        RESEARCH_WORKER_EXTRACTION_BATCH_DELAY_MS: "0",
      });
      const shown = JSON.stringify(report, null, 2);
      expect(code, shown).toBe(0);
      expect(report["mode"]).toBe("execute");
      // 3b: classified once the grace has passed, with the strongest evidence class.
      const expectedClass = scenario === "fill" ? "fill" : scenario === "refusal" ? "refusal" : "halt";
      const classifications = report["classifications"] as readonly Record<string, unknown>[];
      expect(classifications).toHaveLength(1);
      expect(classifications[0], shown).toMatchObject({ windowId: window.windowId, state: "classified", pinClass: expectedClass });
      const counts = classifications[0]?.["evidenceCounts"] as Record<string, number>;
      expect(counts["intents"]).toBeGreaterThanOrEqual(1);
      expect((counts["fills"] ?? 0) >= 1).toBe(scenario === "fill");
      expect(counts["refusals"]).toBe(refusals.length);
      // Only a halt INSIDE the window's span is its evidence: a run that ended after the window is not.
      expect(counts["halts"]).toBe(scenario === "halt-and-restart" ? 1 : 0);

      const pins = report["pins"] as readonly Record<string, unknown>[];
      expect(pins).toHaveLength(1);
      const pinId = String(pins[0]?.["pinId"]);
      const keepUntil = scenario === "fill" ? null : new Date(CLOSE_MS + NON_FILL_PIN_RETENTION_MS).toISOString();
      expect(pins[0], shown).toMatchObject({ status: "extracted", pinClass: expectedClass, sourceEventsInside: true });
      expect(pins[0]?.["keepUntil"] === null ? null : Date.parse(String(pins[0]?.["keepUntil"]))).toBe(
        keepUntil === null ? null : Date.parse(keepUntil),
      );

      const expiry = report["expiry"] as { planId: string; deleted: string[]; failures: unknown[]; receiptObjectKey: string } | null;
      if (expiry === null) throw new Error(`no expiry ran:\n${shown}`);
      expect(expiry.failures).toEqual([]);
      const verdicts = report["segments"] as readonly SegmentVerdict[];

      // 4: stretch A's segments — older than 72 h, no window, no pin — expire; their receipts name no pin.
      const objectStore = fileSystemObjectStore(objectStoreRoot);
      const receipt = parseRetentionReceipt(JSON.parse(Buffer.from(await objectStore.get(expiry.receiptObjectKey)).toString("utf8")));
      const pinsOf = (segmentId: string): readonly string[] | undefined => {
        const deletion = receipt.deletedSegments.find((candidate) => candidate.segmentId === segmentId);
        return deletion?.basis === "expired-after-extract" ? deletion.pins.map((relied) => relied.pinId) : undefined;
      };
      const stretchA = verdicts.filter((verdict) => verdict.maxReceivedAt !== null && Date.parse(verdict.maxReceivedAt) <= STRETCH_A_END_MS);
      expect(stretchA.length).toBeGreaterThanOrEqual(1);
      for (const verdict of stretchA) {
        expect(verdict.eligible, JSON.stringify(verdict)).toBe(true);
        expect(expiry.deleted).toContain(verdict.segmentId);
        expect(pinsOf(verdict.segmentId)).toEqual([]);
      }
      const remaining = await segmentFiles(walRoot);
      for (const verdict of stretchA) expect(remaining).not.toContain(`${verdict.segmentId}.wal.jsonl`);

      // 5: every segment under the window's pin is kept — in the pin, frame for frame.
      const pin = await readPinRecord(objectStore, pinId);
      if (pin === null) throw new Error("the pin record is missing");
      expect(pin.pinClass).toBe(expectedClass);
      const pinned = pin.datasets.flatMap((dataset) => dataset.segmentIds);
      expect(pinned.length).toBeGreaterThanOrEqual(1);
      const rawsBySeq = new Map(raws.map((raw) => [raw.ingestSeq, raw]));
      const pinnedFrames: RawFrameRecord[] = [];
      for (const segmentId of pinned) {
        expect(stretchA.map((verdict) => verdict.segmentId)).not.toContain(segmentId);
        const dataset = pin.datasets.find((candidate) => candidate.segmentIds.includes(segmentId));
        if (dataset === undefined) throw new Error("unreachable");
        const objectKey = `${dataset.manifestObjectKey.replace(/manifest\.json$/u, "")}${segmentId}.parquet`;
        const rows = await readParquetObject(await objectStore.get(objectKey));
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.segmentId).toBe(segmentId);
          const original = rawsBySeq.get(row.record.ingestSeq);
          expect(original, `pinned frame ${row.record.ingestSeq} is not one the gateway recorded`).toBeDefined();
          expect(row.record.payloadUtf8).toBe(original?.payloadUtf8);
          expect(row.record.receivedAt).toBe(original?.receivedAt);
          pinnedFrames.push(row.record);
        }
        // A pinned segment the raw tier released was released ONLY with this pin named in its receipt.
        if (!remaining.includes(`${segmentId}.wal.jsonl`)) expect(pinsOf(segmentId)).toContain(pinId);
      }
      // The window's own market frames — every book frame inside the window — are in the pin.
      const books = raws
        .filter((raw) => raw.source === "polymarket" && Date.parse(raw.receivedAt) <= CLOSE_MS)
        .map((raw) => raw.ingestSeq);
      expect(books.length).toBeGreaterThanOrEqual(3);
      for (const seq of books) expect(pinnedFrames.map((frame) => frame.ingestSeq)).toContain(seq);
      const unpinned = receipt.deletedSegments.filter((deletion) => pinsOf(deletion.segmentId)?.length === 0).length;
      console.log(
        `[PROVENANCE-1 measured, retention, ${scenario}] ${String(recorded.length)} segment(s) recorded; ` +
          `${String(expiry.deleted.length)} expired: ${String(unpinned)} with no pin obligation ` +
          `(${String(stretchA.length)} of them before the window), ` +
          `${String(expiry.deleted.length - unpinned)} released into the verified ${expectedClass} pin; ` +
          `${String(pinned.length)} segment(s) held by the pin; ${String(remaining.length)} left in the raw WAL; ` +
          `evidence ${JSON.stringify(counts)}; frontier ${GATEWAY_EPOCH}:${String(maxSeq)}`,
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("raw WAL expires where a trader runs, through the real composition roots (PROVENANCE-1, deliverable 4)", () => {
  it("FILL: decisions carry dispatch positions; a frontier; classified only after the grace; an unpinned old segment expires; the fill pin keeps its segments forever", async () => {
    await retentionScenario("fill");
  }, 300_000);

  it("REFUSAL: the real risk engine refuses the entry; the window is pinned for its refusals (30 days) and its segments are kept in the pin", async () => {
    await retentionScenario("refusal");
  }, 300_000);

  it("HALT: a partition halts the trader inside the window and a new run of the instance carries on; the halt pins the window (30 days)", async () => {
    await retentionScenario("halt-and-restart");
  }, 300_000);
});

/** The gateway epoch that follows the fixture's when the first gateway stops (`PROV1-R1-01`). */
const LATER_EPOCH = "018f4a7e-5555-7abc-8def-00000000beef";
/** A recording an hour old: it keeps the sealed WAL past the window's range without ever expiring. */
const ANCHOR_EPOCH = "018f4a7e-5555-7abc-8def-00000000cafe";

describe("a window whose gateway epoch ENDS inside it classifies only once the run moved past the epoch (PROVENANCE-1 r1, PROV1-R1-01)", () => {
  it("EPOCH END: the entry's event is the epoch's last; while its fill's insert waits on a lock the window is NOT classified and its raw is kept; still not once the fill lands; it classifies as FILL (kept forever) once the run decides in the next epoch", async () => {
    // Review r1 (`PROV1-R1-01`, reproduced by both reviewers through these
    // same composition roots): the decision on the epoch's last event is made
    // durable BEFORE its placement (`DURABLE-1`), so it carried the frontier
    // past the epoch's last frame while that event's own fill was still being
    // written. The worker classified the window `intent` with no fill, pinned
    // it for 30 days and deleted its raw, and a fill pin could never be made
    // afterwards (its frames were gone).
    const label = "prov-retention-epoch-end";
    const root = await mkdtemp(join(tmpdir(), "pmb-provenance-1-r1-"));
    const walRoot = join(root, "wal");
    try {
      await withFreshDatabase(postgres.getConnectionUri(), label, async ({ connectionString, context }) => {
        const registered = await registerThroughTheRepositories(context, label);
        const conditionId = `${CONDITION_ID}-${label}`;
        // The first gateway stops right after the NO book, 12:00:02: the
        // event that arms the entry is its epoch's LAST, and the epoch ends
        // (its newest segment sealed by the shutdown) inside the window's range.
        const full = timeline(registered.marketId, conditionId);
        const cutoffMs = OPEN_MS + 2_000;
        const raws = full.raws.filter((raw) => Date.parse(raw.receivedAt) <= cutoffMs);
        const events = full.events.filter((event) => Date.parse(event.envelope.receivedAt) <= cutoffMs);
        const lastRaw = raws.at(-1)?.ingestSeq ?? "";
        const lastEvent = events.at(-1)?.envelope.ingestSeq ?? "";
        expect(Number(lastEvent)).toBe(Number(lastRaw) + 1);
        await recordWal(walRoot, raws);
        // A later recording, an hour old (younger than 72 h, so it never
        // expires here): the sealed, verified WAL is past the window's range
        // in every cycle below, so what holds the window back is the rule
        // under test, not a WAL that has not moved on.
        const anchor = gatewayRecorder(ANCHOR_EPOCH, registered.marketId, conditionId);
        anchor.binance(Date.now() - HOUR, "100040");
        await recordWal(join(walRoot, ANCHOR_EPOCH), anchor.raws);
        // The next gateway epoch, after the window's range: both books again,
        // then reference prints — what the trader consumes once it moves on.
        // Its frames reach the WAL when that gateway runs (below).
        const later = gatewayRecorder(LATER_EPOCH, registered.marketId, conditionId);
        later.book(CLOSE_MS + 2 * MINUTE, YES_TOKEN, YES_BIDS, YES_ASKS);
        later.book(CLOSE_MS + 2 * MINUTE + 1_000, NO_TOKEN, NO_BIDS, NO_ASKS);
        for (let step = 1; step <= 4; step += 1) later.binance(CLOSE_MS + 2 * MINUTE + step * 10_000, "100030");
        const recorded = await segmentFiles(walRoot);
        // The window's segments: every segment of the first epoch stamped inside the window's range.
        const windowSegments: string[] = [];
        for (const name of recorded) {
          const segmentRaws = await readFile(join(walRoot, name), "utf8");
          if (segmentRaws.includes(`"ingestSeq":"${lastRaw}"`)) windowSegments.push(name);
        }
        expect(windowSegments).toHaveLength(1);

        const registry = join(root, "windows.json");
        const windowId = "btc-updown-15m-epoch-end";
        await writeFile(
          registry,
          JSON.stringify({
            windowRegistryVersion: 1,
            windows: [
              {
                windowId,
                marketId: registered.marketId,
                conditionId,
                tokenIds: [YES_TOKEN, NO_TOKEN],
                windowStart: T_OPEN,
                windowEnd: T_CLOSE,
                responsibleFrom: new Date(RESPONSIBLE_FROM_MS).toISOString(),
                responsibility: { kind: "trader", instanceIds: [registered.instanceId] },
              },
            ],
          }),
        );
        await writeFile(join(walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
        const objectStoreRoot = join(root, "objects");
        const cycle = async (): Promise<{ readonly report: Record<string, unknown>; readonly classification: Record<string, unknown> }> => {
          const { code, report } = await storageCommand({
            RESEARCH_WORKER_WAL_ROOT: walRoot,
            RESEARCH_WORKER_OBJECT_STORE_ROOT: objectStoreRoot,
            RESEARCH_WORKER_STATE_DIR: join(root, "state"),
            RESEARCH_WORKER_WINDOW_REGISTRY: registry,
            RESEARCH_WORKER_TRADER_DATABASE_URL: connectionString,
            RESEARCH_WORKER_TRADER_ENVIRONMENT: "PAPER",
            RESEARCH_WORKER_EXPIRY_MODE: "execute",
            RESEARCH_WORKER_EXTRACTION_BATCH_DELAY_MS: "0",
          });
          expect(code, JSON.stringify(report, null, 2)).toBe(0);
          const classifications = report["classifications"] as readonly Record<string, unknown>[];
          expect(classifications).toHaveLength(1);
          return { report, classification: classifications[0] ?? {} };
        };
        const evidence = postgresTraderEvidence(context.db, { environment: "PAPER" });
        const notMovedOn = new RegExp(
          `has not moved past epoch ${GATEWAY_EPOCH}, which ended inside the window's range after ingestSeq ${lastRaw}`,
          "u",
        );

        const stream = uniqueStreamName(label);
        const base = documentFor(registered, label);
        const document = { ...base, infrastructure: { ...(base["infrastructure"] as Record<string, unknown>), eventStream: stream } };
        const hop = await startFreezableRedisProxy(redis.getConnectionUrl());
        const publisher = await connectPublisher(redis.getConnectionUrl());
        // The entry's fill is written to `accounting.ledger_transactions`: its
        // insert waits on this lock for as long as the test holds it.
        const lock = await context.pool.connect();
        let locked = true;
        await lock.query("begin");
        await lock.query("lock table accounting.ledger_transactions in share mode");
        const lines: string[] = [];
        const exit = startup({
          env: {
            ...safeEnvironment(),
            TRADER_CONFIG_PATH: `/${label}.json`,
            REDIS_URL: hop.url,
            DATABASE_URL: connectionString,
            [REDIS_RESPONSE_TIMEOUT_ENV]: "1000",
          },
          readConfig: () => Promise.resolve(JSON.stringify(document)),
          log: (line) => {
            lines.push(line);
          },
        });
        let stopped = false;
        let whilePending = "";
        try {
          for (const event of events) await publisher.publish(stream, event.envelope);
          await waitFor("the entry's fill insert to wait on the lock", 60_000, async () => {
            const waiting = await context.pool.query(
              "select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' " +
                "and query like '%ledger_transactions%'",
            );
            return waiting.rows.length > 0 ? true : undefined;
          });
          // The entry's decision IS durable, on the epoch's last event — past
          // its last frame; its fill is NOT.
          const entry = await context.db
            .selectFrom("strategy.decisions")
            .select(["gateway_epoch", "ingest_seq", "intent_count"])
            .where("instance_id", "=", registered.instanceId)
            .where("intent_count", ">", 0)
            .execute();
          expect(entry).toEqual([{ gateway_epoch: GATEWAY_EPOCH, ingest_seq: lastEvent, intent_count: expect.any(Number) }]);
          expect(await evidence.dispatchFrontiers([registered.instanceId])).toEqual(
            new Map([[registered.instanceId, { byEpoch: new Map([[GATEWAY_EPOCH, lastEvent]]), completedEpochs: new Set() }]]),
          );
          expect(await context.db.selectFrom("accounting.ledger_transactions").select("event_type").execute()).toEqual([]);

          // --- cycle 1, execute, while the fill is pending: NOT classified, the window's raw kept.
          const first = await cycle();
          expect(first.classification, JSON.stringify(first.report, null, 2)).toMatchObject({
            windowId,
            state: "unclassified",
            reason: expect.stringMatching(notMovedOn),
          });
          expect(first.report["pins"]).toEqual([]);
          for (const name of windowSegments) expect(await segmentFiles(walRoot)).toContain(name);
          whilePending = String(first.classification["state"]);
        } finally {
          if (locked) {
            locked = false;
            await lock.query("rollback");
            lock.release();
          }
        }
        try {
          await waitFor("the entry's fill to be durable", 60_000, async () => {
            const rows = await context.db
              .selectFrom("accounting.ledger_transactions")
              .select("event_type")
              .where("event_type", "=", "TRADE_PRINCIPAL")
              .execute();
            return rows.length > 0 ? rows : undefined;
          });
          // --- cycle 2: the fill is durable, but nothing shows the epoch's
          // last events were COMPLETED (a halt latched now would be stamped
          // at their instant): still not classified, the raw still kept.
          const second = await cycle();
          expect(second.classification).toMatchObject({ windowId, state: "unclassified", reason: expect.stringMatching(notMovedOn) });
          for (const name of windowSegments) expect(await segmentFiles(walRoot)).toContain(name);

          // --- the next gateway runs, and the trader moves on: it decides in the next epoch.
          await recordWal(join(walRoot, LATER_EPOCH), later.raws);
          for (const event of later.events) await publisher.publish(stream, event.envelope);
          await waitFor("a decision of the run in the next epoch", 60_000, async () => {
            const rows = await context.db
              .selectFrom("strategy.decisions")
              .select("ingest_seq")
              .where("instance_id", "=", registered.instanceId)
              .where("gateway_epoch", "=", LATER_EPOCH)
              .execute();
            return rows.length > 0 ? rows : undefined;
          });
          const frontier = (await evidence.dispatchFrontiers([registered.instanceId])).get(registered.instanceId);
          expect(frontier?.completedEpochs).toEqual(new Set([GATEWAY_EPOCH]));

          // --- cycle 3: classified FILL, kept forever; the window's frames are in the verified pin.
          const third = await cycle();
          const shown = JSON.stringify(third.report, null, 2);
          expect(third.classification, shown).toMatchObject({ windowId, state: "classified", pinClass: "fill" });
          const counts = third.classification["evidenceCounts"] as Record<string, number>;
          expect(counts["fills"]).toBeGreaterThanOrEqual(1);
          const pins = third.report["pins"] as readonly Record<string, unknown>[];
          expect(pins).toHaveLength(1);
          expect(pins[0], shown).toMatchObject({ status: "extracted", pinClass: "fill", keepUntil: null, sourceEventsInside: true });
          const pin = await readPinRecord(fileSystemObjectStore(objectStoreRoot), String(pins[0]?.["pinId"]));
          const pinned = pin?.datasets.flatMap((dataset) => dataset.segmentIds) ?? [];
          for (const name of windowSegments) expect(pinned).toContain(name.replace(/\.wal\.jsonl$/u, ""));
          console.log(
            `[PROVENANCE-1 r1 measured, epoch end] last raw ${lastRaw}, entry event ${lastEvent}; cycle 1 (fill pending): ` +
              `${whilePending}; cycle 2 (fill durable, run not moved on): ` +
              `${String(second.classification["state"])}; cycle 3 (run decided in ${LATER_EPOCH}): ` +
              `${String(third.classification["state"])} ${String(third.classification["pinClass"])}, ` +
              `${String(pinned.length)} segment(s) in the pin`,
          );
        } finally {
          hop.freeze();
          expect(await exit, lines.join("\n")).toBe(EXIT_CODES.halted);
          stopped = true;
          await hop.close();
          await publisher.close();
        }
        expect(stopped).toBe(true);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
