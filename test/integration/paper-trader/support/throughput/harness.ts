/**
 * `THROUGHPUT-1a` — the trader-throughput benchmark harness.
 *
 * Replays a recorded burst through REAL Redis into the REAL durable trader on
 * REAL PostgreSQL, and measures what H1 run 1 could not see: events per second,
 * decisions per second, and each event's lag from its publication to the
 * trader's durable commit.
 *
 * ## What is real, and the one thing that is arranged
 *
 * Everything on the measured path is the process's own code, called the way
 * `apps/trader/src/main.ts` `startup()` calls it:
 *
 * 1. `RedisStreamsEventTransport.connect` with the document's retention;
 * 2. `assembleDurableTrader` — the real `PostgresTraderStore`, the `BOOT-1`
 *    registration check, the simulated venue and `createPaperTrader`, with the
 *    process's own `SystemPaperClock`;
 * 3. `transport.subscribe` as the document's consumer, then the real
 *    `RedisMarketEventFeed` with the document's `receiveBatchSize`;
 * 4. the real `pump`, with `startup()`'s `maxPolls` (`Number.MAX_SAFE_INTEGER`).
 *
 * The arrangements, neither of which changes what the pump does:
 *
 * - `startup()` pumps until a halt and cannot return when the fixture is
 *   exhausted, so the harness passes `untilIdle: true` — the pump returns at
 *   its first EMPTY poll, after it has drained and recorded everything before
 *   it — and calls `pump` again until every published event has its position
 *   recorded. Inside a call the pump is the process's own loop (poll, ingest,
 *   drain, durability, position, halt checks); an extra empty poll per return
 *   is the only difference, and a halt ends the run as it ends the process.
 * - the feed is wrapped in {@link PositionLog}, which passes every call
 *   through unchanged and logs when each position was recorded.
 *
 * Nothing on the measured path is skipped, stubbed or filtered.
 *
 * Registration goes through REGISTER-1's command (`runRegisterCommand`) with
 * the H1 template, into a FRESH database; the fixture's `internalMarketId` is
 * rewritten to the minted market id (`fixture.ts`). The completed document's
 * stream, consumer and retention are then set for the run.
 *
 * ## Lag, on one clock
 *
 * The publisher records when each `publish` resolved; {@link PositionLog}
 * records when the trader recorded a stream position covering the event —
 * which the pump does only once every decision of the events before it is
 * durable. An event's lag is the second minus the first. Both are host epoch
 * milliseconds (`preciseNowMs`), so no clock skew between the host and the
 * containers enters the number.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import path from "node:path";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { createPostgresPool } from "@polymarket-bot/storage-postgres";

import { assembleDurableTrader, SystemPaperClock } from "../../../../../apps/trader/src/main.js";
import { RedisMarketEventFeed } from "../../../../../apps/trader/src/adapters/redis-feed.js";
import { pump } from "../../../../../apps/trader/src/pump.js";
import { runRegisterCommand } from "../../../../../apps/trader/src/register/main.js";
import { parseTraderConfig, type FeedMark, type MarketEventFeed } from "../../../../../apps/trader/src/index.js";
import { remapMarketId } from "./fixture.js";
import { preciseNowMs, publishEnvelopes, type PublishLog, type PublishMode } from "./publisher.js";

/** A PAPER-only environment: the posture every process in this repository runs under. */
export function benchEnvironment(databaseUrl: string): Record<string, string> {
  return {
    MAX_RUN_MODE: "PAPER",
    RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    DATABASE_URL: databaseUrl,
  };
}

export interface ThroughputRunOptions {
  readonly redisUrl: string;
  /**
   * A fresh database with every migration applied: nothing registered
   * (`registration.kind === "register"`), or a clone of the database the
   * `registered` document was completed against.
   */
  readonly databaseUrl: string;
  /**
   * `register`: REGISTER-1's command registers the template's market,
   * instance and run into `databaseUrl` (the default path). `registered`: the
   * rows already exist (the database is a clone of a registered one), and
   * this is the document the command completed — so two runs share every
   * minted id and their durable content compares byte for byte, feature
   * snapshot addresses included (the snapshot's subject names the market).
   */
  readonly registration:
    | { readonly kind: "register"; readonly templatePath: string }
    | { readonly kind: "registered"; readonly document: Record<string, unknown> };
  /** Where the completed document and the per-run artifacts are written. */
  readonly workDir: string;
  /** `MarketOpened` then the burst, as recorded (NOT yet remapped). */
  readonly envelopes: readonly EventEnvelope<unknown>[];
  /** The market id the recorded envelopes name. */
  readonly recordedMarketId: string;
  readonly mode: PublishMode;
  readonly stream: string;
  readonly consumerId: string;
  /** The stream's retention bound, for the publisher and the trader's document. */
  readonly retentionMaxEvents: number;
  /** Index of the first paced envelope (1: after the prepended `MarketOpened`). */
  readonly paceFrom: number;
  /**
   * Paced mode: starts a publisher once the trader is subscribed. The CLI
   * passes one that runs in a SEPARATE process (the gateway is one); a test may
   * publish in-process. Absent: an in-process publisher.
   */
  readonly startPacedPublisher?: (input: {
    readonly stream: string;
    readonly envelopes: readonly EventEnvelope<unknown>[];
    readonly retentionMaxEvents: number;
  }) => Promise<PublishLog>;
  /** Write a V8 CPU profile of the measured window here. */
  readonly cpuProfileDir?: string;
  /** Write the durable decision content, one JSON line per `evaluation_seq`, here. */
  readonly decisionsOut?: string;
  /** Write the durable checkpoint content, one JSON line per `checkpoint_seq`, here. */
  readonly checkpointsOut?: string;
  readonly codeCommit: string;
  readonly log: (line: string) => void;
}

export interface LagSummary {
  readonly count: number;
  readonly maxMs: number;
  readonly p99Ms: number;
  readonly p50Ms: number;
}

export interface ThroughputReport {
  readonly mode: PublishMode;
  readonly events: number;
  readonly consumed: number;
  readonly stopped: "COMPLETE" | "HALTED";
  readonly wallMs: number;
  /** CPU time (user + system) this process spent in the measured window, in ms. */
  readonly cpuMs: number;
  readonly eventsPerSecond: number;
  readonly decisionsPerSecond: number;
  readonly lag: LagSummary;
  readonly publish: {
    readonly wallMs: number;
    readonly maxScheduleSlipMs: number;
  };
  readonly polls: number;
  readonly idlePolls: number;
  /**
   * `THROUGHPUT-2`: how many times the feed had to hand out one frame across
   * two batches because it filled a whole batch (`RedisMarketEventFeed.framesSplit`).
   */
  readonly framesSplit: number;
  readonly halts: readonly { readonly scope: string; readonly code: string; readonly detail: string }[];
  readonly durable: {
    readonly decisions: number;
    readonly checkpoints: number;
    readonly distinctEvaluationSeqs: number;
    readonly minEvaluationSeq: number | null;
    readonly maxEvaluationSeq: number | null;
    readonly xactCommitDelta: number;
    readonly decisionContentSha256: string;
    readonly checkpointContentSha256: string;
    readonly normalizedDecisionContentSha256: string;
    readonly normalizedCheckpointContentSha256: string;
  };
  /** The trader's own counters at shutdown: `loop`, `risk` and `execution`, as its health reports them. */
  readonly health: {
    readonly loop: Readonly<Record<string, number>>;
    readonly risk: Readonly<Record<string, unknown>>;
    readonly execution: Readonly<Record<string, number>>;
  };
  readonly runId: string;
  readonly cpuProfile: string | null;
}

/**
 * The real feed, OBSERVED: every call is passed through unchanged, and each
 * recorded position is logged with the host time it was recorded and how many
 * events it covers — which is when those events' decisions were durable AND
 * their position recorded, the instant the lag is measured to. No event,
 * batch or answer is altered.
 */
class PositionLog implements MarketEventFeed {
  readonly recorded: { readonly atMs: number; readonly through: number }[] = [];
  readonly #inner: MarketEventFeed;
  readonly #marked = new WeakMap<FeedMark, number>();
  #delivered = 0;

  constructor(inner: MarketEventFeed) {
    this.#inner = inner;
  }

  async poll(): ReturnType<MarketEventFeed["poll"]> {
    const batch = await this.#inner.poll();
    if (batch.ok) this.#delivered += batch.value.length;
    return batch;
  }

  mark(): FeedMark | undefined {
    const mark = this.#inner.mark?.();
    if (mark !== undefined) this.#marked.set(mark, this.#delivered);
    return mark;
  }

  async commit(upTo?: FeedMark): ReturnType<MarketEventFeed["commit"]> {
    const through = upTo === undefined ? this.#delivered : (this.#marked.get(upTo) ?? 0);
    const committed = await this.#inner.commit(upTo);
    if (committed.ok) this.recorded.push({ atMs: preciseNowMs(), through });
    return committed;
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

function summarizeLag(lags: readonly number[]): LagSummary {
  const sorted = [...lags].sort((left, right) => left - right);
  return {
    count: sorted.length,
    maxMs: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0),
    p99Ms: percentile(sorted, 99),
    p50Ms: percentile(sorted, 50),
  };
}

/**
 * REGISTER-1's command, in-process, with a registration template (the H1
 * `template.json`). Returns the completed document the command wrote.
 */
export async function registerForBench(options: {
  readonly databaseUrl: string;
  readonly templatePath: string;
  readonly workDir: string;
  readonly instanceName: string;
  readonly codeCommit: string;
  readonly log: (line: string) => void;
}): Promise<Record<string, unknown>> {
  const out = path.join(options.workDir, "trader.config.json");
  const code = await runRegisterCommand({
    argv: [
      "--template",
      options.templatePath,
      "--out",
      out,
      "--instance-name",
      options.instanceName,
      "--question-title",
      "Bitcoin Up or Down - September 29, 5:00PM-5:15PM ET (THROUGHPUT-1a bench)",
      "--neg-risk",
      "false",
      "--trading-delay-seconds",
      "0",
      "--lifecycle-state",
      "OPEN",
      "--yes-label",
      "Up",
      "--no-label",
      "Down",
      "--code-commit",
      options.codeCommit,
      "--created-by",
      "throughput-1a-bench",
    ],
    env: benchEnvironment(options.databaseUrl),
    log: (line) => {
      options.log(`[register] ${line}`);
    },
    print: () => undefined,
    nowMs: () => Date.now(),
  });
  if (code !== 0) throw new Error(`the registration command exited ${String(code)}`);
  return JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
}

function mintedMarketId(document: Record<string, unknown>): string {
  const markets = document["markets"];
  if (!Array.isArray(markets) || markets.length !== 1) throw new Error("the completed document names no single market");
  const marketId = (markets[0] as Record<string, unknown>)["marketId"];
  if (typeof marketId !== "string") throw new Error("the completed document's market has no marketId");
  return marketId;
}

/**
 * The ids registration minted, each with the placeholder the NORMALIZED
 * content digest writes in its place (`durableContent`).
 */
function mintedIds(document: Record<string, unknown>): readonly (readonly [string, string])[] {
  const instance = (document["instances"] as Record<string, unknown>[] | undefined)?.[0] ?? {};
  const pairs: [string, string][] = [[mintedMarketId(document), "<marketId>"]];
  for (const key of ["instanceId", "runId", "configId"]) {
    const value = instance[key];
    if (typeof value === "string") pairs.push([value, `<${key}>`]);
  }
  return pairs;
}

function runIdOf(document: Record<string, unknown>): string {
  const instances = document["instances"];
  if (!Array.isArray(instances) || instances.length !== 1) throw new Error("the completed document names no single instance");
  const runId = (instances[0] as Record<string, unknown>)["runId"];
  if (typeof runId !== "string") throw new Error("the completed document's instance has no runId");
  return runId;
}

/** Starts the V8 sampling profiler, if asked; answers a stop function that writes the profile. */
async function startProfiler(dir: string | undefined, label: string): Promise<() => Promise<string | null>> {
  if (dir === undefined) return async () => await Promise.resolve(null);
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  // 250 µs: four times finer than node's --cpu-prof default, still ~1% overhead.
  await session.post("Profiler.setSamplingInterval", { interval: 250 });
  await session.post("Profiler.start");
  return async () => {
    const { profile } = await session.post("Profiler.stop");
    session.disconnect();
    const file = path.join(dir, `${label}-${String(Date.now())}.cpuprofile`);
    await writeFile(file, JSON.stringify(profile));
    return file;
  };
}

/** Runs one benchmark. Throws only on a harness failure; a trader halt is a result. */
export async function runTraderThroughput(options: ThroughputRunOptions): Promise<ThroughputReport> {
  const { log } = options;

  // --- registration, then the document for this run -------------------------
  const completed =
    options.registration.kind === "registered"
      ? options.registration.document
      : await registerForBench({
          databaseUrl: options.databaseUrl,
          templatePath: options.registration.templatePath,
          workDir: options.workDir,
          instanceName: `throughput-bench-${options.stream}`,
          codeCommit: options.codeCommit,
          log,
        });
  const document: Record<string, unknown> = {
    ...completed,
    infrastructure: {
      ...(completed["infrastructure"] as Record<string, unknown>),
      eventStream: options.stream,
      consumerId: options.consumerId,
      retentionMaxEvents: options.retentionMaxEvents,
    },
  };
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) throw new Error(`the completed document was refused: ${parsed.refusal.detail}`);
  const config = parsed.config;
  const runId = runIdOf(document);
  const envelopes = remapMarketId(options.envelopes, options.recordedMarketId, mintedMarketId(document));
  log(
    `registered run ${runId}; ${String(envelopes.length)} envelopes for market ${mintedMarketId(document)}; ` +
      `receiveBatchSize ${String(config.infrastructure.receiveBatchSize)}, retention ${String(options.retentionMaxEvents)}`,
  );

  // --- the process's own infrastructure --------------------------------------
  const transport = await RedisStreamsEventTransport.connect({
    connection: { url: options.redisUrl },
    retention: { maxEvents: config.infrastructure.retentionMaxEvents },
  });
  const stats = createPostgresPool({ connectionString: options.databaseUrl, maxConnections: 1 });

  try {
    // Catch-up: the whole burst is in the stream before the trader subscribes.
    let catchUpLog: PublishLog | undefined;
    if (options.mode === "catch-up") {
      catchUpLog = await publishEnvelopes({ transport, stream: options.stream, envelopes, mode: "catch-up" });
      log(
        `published ${String(envelopes.length)} envelopes in ${(catchUpLog.finishedAtMs - catchUpLog.startedAtMs).toFixed(0)} ms ` +
          `(last ordinal ${String(catchUpLog.lastSequence)})`,
      );
    }

    const assembled = await assembleDurableTrader({
      env: benchEnvironment(options.databaseUrl),
      config,
      document,
      postgresUrl: options.databaseUrl,
      clock: new SystemPaperClock(),
      log: (line) => {
        log(`[trader] ${line}`);
      },
    });
    if (!assembled.ok) throw new Error(`the durable trader refused to assemble (exit ${String(assembled.code)})`);
    const { trader, store } = assembled;
    const subscription = await transport.subscribe({
      stream: config.infrastructure.eventStream,
      consumerId: config.infrastructure.consumerId,
    });
    const feed = new RedisMarketEventFeed({ subscription, maxEvents: config.infrastructure.receiveBatchSize });

    const xactBefore = await xactCommit(stats);

    // Paced: the publisher starts only once the trader is subscribed.
    let pacedLog: Promise<PublishLog> | undefined;
    if (options.mode === "paced") {
      const start =
        options.startPacedPublisher ??
        (async (input: { readonly stream: string; readonly envelopes: readonly EventEnvelope<unknown>[] }) =>
          await publishEnvelopes({
            transport,
            stream: input.stream,
            envelopes: input.envelopes,
            mode: "paced",
            paceFrom: options.paceFrom,
          }));
      pacedLog = start({ stream: options.stream, envelopes, retentionMaxEvents: options.retentionMaxEvents });
    }

    // --- the measured window -----------------------------------------------
    // The process's own pump, run until its first idle poll (`untilIdle`) and
    // called again while events remain: every call is the process's loop, and
    // it returns only on an idle poll (which records every durable position
    // first) or a halt. The feed is observed, not replaced (`PositionLog`).
    const stopProfiler = await startProfiler(options.cpuProfileDir, `trader-${options.mode}`);
    const positions = new PositionLog(feed);
    let consumed = 0;
    let polls = 0;
    let idlePolls = 0;
    let stopped: "COMPLETE" | "HALTED" = "COMPLETE";
    const startedAtMs = preciseNowMs();
    const cpuBefore = process.cpuUsage();
    while (consumed < envelopes.length) {
      const result = await pump({
        loop: trader.loop,
        feed: positions,
        halts: trader.halts,
        maxPolls: Number.MAX_SAFE_INTEGER,
        untilIdle: true,
      });
      polls += result.polls;
      consumed += result.ingested;
      if (result.stopped === "IDLE") idlePolls += 1;
      if (result.stopped === "HALTED") {
        stopped = "HALTED";
        break;
      }
    }
    const finishedAtMs = preciseNowMs();
    const cpu = process.cpuUsage(cpuBefore);
    const commits = positions.recorded;
    const cpuProfile = await stopProfiler();

    const publishLog = catchUpLog ?? (pacedLog === undefined ? undefined : await pacedLog);

    // --- the process's own shutdown ------------------------------------------
    trader.loop.checkAccountingRebuild("SHUTDOWN");
    const health = trader.loop.health();
    await feed.close();
    await store.close();

    // --- measurements --------------------------------------------------------
    const lags: number[] = [];
    if (publishLog !== undefined) {
      let from = 0;
      for (const commit of commits) {
        for (let index = from; index < commit.through; index += 1) {
          const publishedAt = publishLog.publishedAtMs[index];
          if (publishedAt !== undefined) lags.push(commit.atMs - publishedAt);
        }
        from = Math.max(from, commit.through);
      }
    }
    // pg_stat_database is flushed by each backend at most once a second.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const xactAfter = await xactCommit(stats);
    const durable = await durableContent(stats, runId, mintedIds(document), options.decisionsOut, options.checkpointsOut);
    const wallMs = finishedAtMs - startedAtMs;

    return {
      mode: options.mode,
      events: envelopes.length,
      consumed,
      stopped,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      eventsPerSecond: consumed / (wallMs / 1000),
      decisionsPerSecond: durable.decisions / (wallMs / 1000),
      lag: summarizeLag(lags),
      publish: {
        wallMs: publishLog === undefined ? 0 : publishLog.finishedAtMs - publishLog.startedAtMs,
        maxScheduleSlipMs: publishLog?.maxScheduleSlipMs ?? 0,
      },
      polls,
      idlePolls,
      framesSplit: feed.framesSplit,
      halts: health.halts.map((halt) => ({ scope: halt.scope.kind, code: halt.code, detail: halt.detail })),
      durable: { ...durable, xactCommitDelta: xactAfter - xactBefore },
      health: {
        loop: { ...health.loop },
        risk: { ...health.risk },
        execution: { ...health.execution },
      },
      runId,
      cpuProfile,
    };
  } finally {
    await transport.close();
    await stats.end();
  }
}

type Pool = ReturnType<typeof createPostgresPool>;

async function xactCommit(pool: Pool): Promise<number> {
  const result = await pool.query<{ xact_commit: string }>(
    "select xact_commit::text from pg_stat_database where datname = current_database()",
  );
  return Number(result.rows[0]?.xact_commit ?? "0");
}

/**
 * The durable decision and checkpoint content of one run, per sequence, with
 * the ids and wall timestamps (`decision_id`, `recorded_at`,
 * `evaluation_duration_us`) excluded, hashed — and written one JSON line per
 * `evaluation_seq` when asked, for the base-versus-candidate comparison.
 */
async function durableContent(
  pool: Pool,
  runId: string,
  ids: readonly (readonly [string, string])[],
  out: string | undefined,
  checkpointsOut: string | undefined,
): Promise<{
  readonly decisions: number;
  readonly checkpoints: number;
  readonly distinctEvaluationSeqs: number;
  readonly minEvaluationSeq: number | null;
  readonly maxEvaluationSeq: number | null;
  readonly decisionContentSha256: string;
  readonly checkpointContentSha256: string;
  readonly normalizedDecisionContentSha256: string;
  readonly normalizedCheckpointContentSha256: string;
}> {
  const decisions = await pool.query<Record<string, unknown>>(
    `select evaluation_seq::text as evaluation_seq, callback::text as callback,
            decision_type::text as decision_type, reason_codes, feature_snapshot_ref,
            model_outputs::text as model_outputs, state_patch::text as state_patch,
            to_char(next_wakeup_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as next_wakeup_at,
            source_event_id::text as source_event_id, intent_count,
            to_char(evaluated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as evaluated_at
       from strategy.decisions d where d.run_id = $1 order by d.evaluation_seq`,
    [runId],
  );
  const checkpoints = await pool.query<Record<string, unknown>>(
    `select checkpoint_seq::text as checkpoint_seq, state_schema_version, state_hash,
            state::text as state,
            to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as captured_at
       from strategy.state_checkpoints c where c.run_id = $1 order by c.checkpoint_seq`,
    [runId],
  );
  // RAW: every column above, byte for byte — comparable between runs that
  // share their minted ids (a `registered` clone). NORMALIZED: the minted ids
  // replaced by placeholders and the two values that HASH over them dropped
  // (`feature_snapshot_ref`, whose snapshot subject names the market, and
  // `state_hash`) — comparable between any two runs of the same fixture.
  const normalize = (row: Record<string, unknown>, drop: string): string => {
    let line = JSON.stringify({ ...row, [drop]: undefined });
    for (const [id, placeholder] of ids) line = line.split(id).join(placeholder);
    return line;
  };
  const decisionHash = createHash("sha256");
  const normalizedDecisionHash = createHash("sha256");
  const lines: string[] = [];
  const seqs = new Set<string>();
  for (const row of decisions.rows) {
    const line = JSON.stringify(row);
    decisionHash.update(line).update("\n");
    normalizedDecisionHash.update(normalize(row, "feature_snapshot_ref")).update("\n");
    seqs.add(String(row["evaluation_seq"]));
    if (out !== undefined) lines.push(line);
  }
  const checkpointHash = createHash("sha256");
  const normalizedCheckpointHash = createHash("sha256");
  const checkpointLines: string[] = [];
  for (const row of checkpoints.rows) {
    const line = JSON.stringify(row);
    checkpointHash.update(line).update("\n");
    normalizedCheckpointHash.update(normalize(row, "state_hash")).update("\n");
    if (checkpointsOut !== undefined) checkpointLines.push(line);
  }
  if (checkpointsOut !== undefined) await writeFile(checkpointsOut, checkpointLines.join("\n") + "\n");
  if (out !== undefined) await writeFile(out, lines.join("\n") + "\n");
  const first = decisions.rows[0];
  const last = decisions.rows[decisions.rows.length - 1];
  return {
    decisions: decisions.rows.length,
    checkpoints: checkpoints.rows.length,
    distinctEvaluationSeqs: seqs.size,
    minEvaluationSeq: first === undefined ? null : Number(first["evaluation_seq"]),
    maxEvaluationSeq: last === undefined ? null : Number(last["evaluation_seq"]),
    decisionContentSha256: decisionHash.digest("hex"),
    checkpointContentSha256: checkpointHash.digest("hex"),
    normalizedDecisionContentSha256: normalizedDecisionHash.digest("hex"),
    normalizedCheckpointContentSha256: normalizedCheckpointHash.digest("hex"),
  };
}
