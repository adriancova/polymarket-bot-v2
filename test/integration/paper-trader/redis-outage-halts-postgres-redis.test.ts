/**
 * `OUTAGE-1` — §4.2 "A Redis outage stops publication and therefore halts
 * trading", through the REAL process path: `startup()` itself, a real
 * PostgreSQL, and a real Redis container that this file STOPS mid-run.
 *
 * ## What was true before this round (`BOOT1-R7`, reproduced)
 *
 * With the rows registered, the six fixture events published and the Redis
 * container stopped at t≈3.8 s, `startup()` was STILL RUNNING 90 s later. The
 * `ioredis` debug trace showed why. After `docker stop`, reconnections were
 * accepted at the TCP level and then died in the handshake (EPIPE). Each
 * accepted one reset the client's command queue, which left the stream-state
 * read the pump was awaiting parked in the resend-on-reconnect queue. The
 * client's `maxRetriesPerRequest` flush never touches that queue. It fired
 * twice, and the pump stayed blocked. The subscription's own connection sat in
 * a half-open handshake that never closed. §4.2's halt was evidenced only
 * against the in-memory feed (`acceptance-4-infrastructure-halts.test.ts`).
 *
 * ## What this file proves
 *
 * 1. **The outage halts, within the bound, and the process exits 75.** The
 *    trader decides and fills on the six events. Then the container is
 *    stopped. The pump latches GLOBAL `TRANSPORT_UNAVAILABLE` (`FULL_HALT`) and
 *    `startup()` returns `EXIT_CODES.halted`, both measured against the bound
 *    `main.ts` states. With T = `TRADER_REDIS_RESPONSE_TIMEOUT_MS` (default
 *    5000):
 *    - the halt within T of the first command the outage leaves unanswered;
 *    - the return within 3T of it.
 *
 *    That command is sent no later than the moment `stop()` returns, so both
 *    are measured from there. Each assertion adds a 1 s margin for the
 *    PostgreSQL close, the shutdown rebuild check and scheduling, none of which
 *    waits on Redis.
 * 2. **Nothing trades after it.** Comparing a GET /health read before the stop
 *    with the snapshot `startup()` logs at exit, the evaluations, persisted
 *    decisions, built plans, submissions, fills and ledger transactions are all
 *    UNCHANGED. So are the durable rows in PostgreSQL. The last durable writes
 *    — the entry decision, its checkpoints, the fill's ledger transactions and
 *    PnL snapshot — read back as they were written.
 * 3. **An idle stream is not an outage.** With T configured to 1 s and nothing
 *    published, the process idles for five bounds without halting (the
 *    endpoint still reports healthy with no halt). Stopping the container then
 *    halts it within the CONFIGURED bound, which is the "configurable" half of
 *    the claim.
 * 4. **A PARTITION halts too, not only a stopped server.** A stopped container
 *    closes its sockets, and the client sees it. A partition, or a paused
 *    server (`docker pause`), closes nothing: the sockets stay open, a new
 *    connection is still accepted, and nothing is answered. The trader is put
 *    behind a hop that goes silent that way (`startFreezableRedisProxy`)
 *    after it has decided and filled. It halts within the configured bound
 *    and exits within 3T. The 3T is reached here, not merely allowed: both
 *    connections still report ready, so each is offered its bounded QUIT.
 *    Nothing is traded or written after the halt.
 * 5. **A subscription the transport refuses is a refusal, not a crash.**
 *
 * ## What it does NOT prove (disclosed)
 *
 * - **The halt is not read back from PostgreSQL**, because the trader writes
 *   no halt row anywhere. The `TraderStore` port has no halt write
 *   (`packages/trading-core/src/ports.ts`), and `ops.risk_events` /
 *   `ops.incidents` have no writer in `apps/trader`. The halt is read from the
 *   process's own exit snapshot and its HALT line. Its durable consequence —
 *   no row written after it — is read from PostgreSQL. A durable halt record
 *   is a store-port change outside `OUTAGE-1`'s grant; it is reported, not
 *   invented here.
 * - "No order after the outage" is shown on the process's own counters and
 *   the durable rows. The paper process persists no `execution.orders` row at
 *   all (`RECON2-DURABLE`), so there is no order table to read.
 * - It is not a soak and not live evidence.
 *
 * ## Docker
 *
 * Testcontainers, as the other container files. PostgreSQL is shared by the
 * file (`beforeAll`). Each outage scenario starts its OWN Redis, because it
 * stops it. There is no `globalSetup` and no skip when Docker is absent.
 * Throwaway credentials that live only for the run (§0.2, ADR-010). The
 * `environment` is `PAPER` throughout; there is no venue, no signer and no real
 * order.
 *
 * `TC-LOCAL-FLAKE`: a fresh container's first connect has been seen to fail
 * locally ("Connection is closed"). Each scenario therefore proves its Redis
 * answers — a bounded retry of the PUBLISHER's connect — before the process
 * under test is started, so the process's own connect never meets a server
 * that is still coming up.
 */

import { request as httpRequest } from "node:http";

import {
  DEFAULT_RESPONSE_TIMEOUT_MS,
  EventBusUnavailableError,
  RedisStreamsEventTransport,
} from "@polymarket-bot/event-bus";
import {
  startFreezableRedisProxy,
  startRedisContainer,
  uniqueStreamName,
  writeStoredCheckpoint,
} from "@polymarket-bot/event-bus/testing";
import { startPostgresContainer, type TestContext } from "@polymarket-bot/storage-postgres/testing";
import type { LoopHealthSnapshot } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXIT_CODES, REDIS_RESPONSE_TIMEOUT_ENV, startup } from "../../../apps/trader/src/main.js";
import { recordedEvents, safeEnvironment } from "./support/fixture.js";
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

/** Scheduling margin on every timing assertion (see the header). */
const MARGIN_MS = 1_000;

// ---------------------------------------------------------------------------
// The process under test, and what it said
// ---------------------------------------------------------------------------

interface LoggedLine {
  readonly at: number;
  readonly line: string;
}

interface ProcessRun {
  /** `startup()`'s own promise: the exit code the process would set. */
  readonly exit: Promise<number>;
  readonly lines: LoggedLine[];
  text(): string;
}

/** Runs the REAL `startup()` on a document and an environment, recording each line with its instant. */
function runProcess(env: Record<string, string | undefined>, document: Record<string, unknown>): ProcessRun {
  const lines: LoggedLine[] = [];
  const exit = startup({
    env,
    readConfig: () => Promise.resolve(JSON.stringify(document)),
    log: (line) => {
      lines.push({ at: Date.now(), line });
    },
  });
  return { exit, lines, text: () => lines.map((entry) => entry.line).join("\n") };
}

/** Resolves with the settled value and its instant, or `undefined` if `ms` pass first. */
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ readonly value: T; readonly at: number } | undefined> {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until it answers, or fails naming what it waited for. */
async function waitFor<T>(what: string, withinMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`gave up after ${String(withinMs)} ms waiting for ${what}`);
    await sleep(50);
  }
}

function get(url: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** The URL the process's health endpoint states it is listening on. */
async function healthUrlOf(run: ProcessRun): Promise<string> {
  return await waitFor("the health endpoint to listen", 60_000, async () => {
    for (const { line } of run.lines) {
      const match = /health endpoint: listening on (http:\/\/\S+)/u.exec(line);
      if (match?.[1] !== undefined) return match[1];
    }
    return undefined;
  });
}

async function readHealth(url: string): Promise<LoopHealthSnapshot> {
  const response = await get(url);
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as LoopHealthSnapshot;
}

/** The snapshot `startup()` logs as it exits (`health: {…}`). */
function exitHealth(run: ProcessRun): LoopHealthSnapshot {
  const entry = run.lines.find(({ line }) => line.startsWith("health: {"));
  if (entry === undefined) throw new Error(`startup() logged no exit health snapshot:\n${run.text()}`);
  return JSON.parse(entry.line.slice("health: ".length)) as LoopHealthSnapshot;
}

function lineAt(run: ProcessRun, prefix: string): LoggedLine {
  const entry = run.lines.find(({ line }) => line.startsWith(prefix));
  if (entry === undefined) throw new Error(`startup() never logged "${prefix}":\n${run.text()}`);
  return entry;
}

/** The counters that move when the process evaluates, decides, plans, submits or books. */
function tradingCounters(health: LoopHealthSnapshot): Record<string, number> {
  return {
    eventsProcessed: health.loop.eventsProcessed,
    evaluations: health.loop.evaluations,
    decisionsPersisted: health.loop.decisionsPersisted,
    plansBuilt: health.execution.plansBuilt,
    submissionsAccepted: health.execution.submissionsAccepted,
    submissionsRefused: health.execution.submissionsRefused,
    fillsObserved: health.execution.fillsObserved,
    ledgerTransactions: health.accounting.ledgerTransactions,
  };
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

/**
 * A publisher connected to a FRESH container, retried a bounded number of
 * times (`TC-LOCAL-FLAKE`). Its success is the readiness proof for the
 * process started after it.
 */
async function connectPublisher(url: string): Promise<RedisStreamsEventTransport> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await RedisStreamsEventTransport.connect({
        connection: { url },
        retention: { maxEvents: 10_000 },
      });
    } catch (failure) {
      if (!(failure instanceof EventBusUnavailableError)) throw failure;
      lastFailure = failure;
      await sleep(400);
    }
  }
  throw new Error(`a fresh Redis container never accepted a connection: ${String(lastFailure)}`);
}

/** The fixture document, naming the registered rows and a per-scenario stream. */
function documentOn(registered: Registered, label: string, stream: string): Record<string, unknown> {
  const base = documentFor(registered, label);
  return {
    ...base,
    infrastructure: { ...(base["infrastructure"] as Record<string, unknown>), eventStream: stream },
  };
}

/** Everything the run wrote to PostgreSQL, as counts plus the rows asserted below. */
async function durableRows(context: TestContext, registered: Registered) {
  const decisions = await context.db
    .selectFrom("strategy.decisions")
    .selectAll()
    .where("run_id", "=", registered.runId)
    .orderBy("evaluation_seq")
    .execute();
  const checkpoints = await context.db
    .selectFrom("strategy.state_checkpoints")
    .selectAll()
    .where("run_id", "=", registered.runId)
    .orderBy("checkpoint_seq")
    .execute();
  const transactions = await context.db
    .selectFrom("accounting.ledger_transactions")
    .selectAll()
    .where("market_id", "=", registered.marketId)
    .orderBy("ledger_transaction_id")
    .execute();
  const entries =
    transactions.length === 0
      ? []
      : await context.db
          .selectFrom("accounting.ledger_entries")
          .selectAll()
          .where(
            "ledger_transaction_id",
            "in",
            transactions.map((row) => row.ledger_transaction_id),
          )
          .execute();
  const snapshots = await context.db
    .selectFrom("accounting.pnl_snapshots")
    .selectAll()
    .where("run_id", "=", registered.runId)
    .execute();
  return { decisions, checkpoints, transactions, entries, snapshots };
}

interface Settled {
  readonly health: LoopHealthSnapshot;
  readonly rows: Awaited<ReturnType<typeof durableRows>>;
}

/**
 * Publishes the six fixture events and waits until the process has processed
 * them AND every durable write its counters promise has landed. It asserts the
 * run decided an entry and filled it, so an outage after this point has
 * something to not trade after.
 */
async function publishSixAndSettle(options: {
  readonly publisher: RedisStreamsEventTransport;
  readonly stream: string;
  readonly label: string;
  readonly healthUrl: string;
  readonly context: TestContext;
  readonly registered: Registered;
}): Promise<Settled> {
  const { publisher, stream, label, healthUrl, context, registered } = options;
  for (const event of recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`)) {
    await publisher.publish(stream, event.envelope);
  }
  const settled = await waitFor("the six events to be processed and every write to land", 60_000, async () => {
    const health = await readHealth(healthUrl);
    if (health.loop.eventsProcessed !== 6) return undefined;
    const rows = await durableRows(context, registered);
    // Every durable write the counters promise has landed.
    if (rows.decisions.length !== health.loop.decisionsPersisted) return undefined;
    if (rows.transactions.length !== health.accounting.ledgerTransactions) return undefined;
    return { health, rows };
  });
  expect(settled.health.halts).toEqual([]);
  expect(settled.health.healthy).toBe(true);
  expect(settled.health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
  expect(settled.rows.decisions.some((row) => row.decision_type === "enter")).toBe(true);
  expect(settled.rows.transactions.length).toBeGreaterThanOrEqual(2);
  expect(settled.rows.snapshots.length).toBe(settled.health.execution.fillsObserved);
  return settled;
}

/**
 * Nothing traded after the halt (the process's own counters at exit equal
 * those read before the outage), nothing written after it, and the last
 * durable writes read back as they were.
 */
async function expectNothingTradedOrWrittenAfter(
  run: ProcessRun,
  context: TestContext,
  registered: Registered,
  before: Settled,
): Promise<void> {
  expect(tradingCounters(exitHealth(run))).toEqual(tradingCounters(before.health));

  const rows = await durableRows(context, registered);
  expect(rows.decisions.map((row) => [row.evaluation_seq, row.decision_type])).toEqual(
    before.rows.decisions.map((row) => [row.evaluation_seq, row.decision_type]),
  );
  expect(rows.checkpoints.map((row) => [row.checkpoint_seq, row.state_hash])).toEqual(
    before.rows.checkpoints.map((row) => [row.checkpoint_seq, row.state_hash]),
  );
  expect(rows.transactions.map((row) => row.ledger_transaction_id)).toEqual(
    before.rows.transactions.map((row) => row.ledger_transaction_id),
  );
  expect(rows.entries.length).toBe(before.rows.entries.length);
  expect(rows.snapshots.map((row) => row.realized_pnl)).toEqual(
    before.rows.snapshots.map((row) => row.realized_pnl),
  );
  for (const row of rows.entries) expect(typeof row.amount).toBe("string");
}

/** The exit snapshot's halts, as [scope, code, action] triples. */
function haltTriples(run: ProcessRun): string[][] {
  return exitHealth(run).halts.map((halt) => [halt.scope.kind, halt.code, halt.action]);
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

describe("a Redis outage mid-run HALTS the durable trader within the stated bound (OUTAGE-1, BOOT1-R7)", () => {
  it("decides and fills, then — the container stopped — latches GLOBAL TRANSPORT_UNAVAILABLE and startup() exits 75 within the default bound, trading nothing and writing nothing after it", async () => {
    const redis = await startRedisContainer();
    let stopped = false;
    try {
      await withFreshDatabase(postgres.getConnectionUri(), "outage-default", async ({ connectionString, context }) => {
        const label = "outage-default";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const publisher = await connectPublisher(redis.getConnectionUrl());

        // The DEFAULT bound: the variable is not set.
        const run = runProcess(
          {
            ...safeEnvironment(),
            TRADER_CONFIG_PATH: "/outage-default.json",
            REDIS_URL: redis.getConnectionUrl(),
            DATABASE_URL: connectionString,
            TRADER_HEALTH_BIND: "127.0.0.1",
            TRADER_HEALTH_PORT: "0",
          },
          documentOn(registered, label, stream),
        );
        // The documented default, as a literal: the timing below must not depend
        // on the mechanism under test (with the base transport restored this
        // test must fail by the hang, not by arithmetic on a missing export).
        // It is pinned equal to the transport's own constant after the outage.
        const bound = 5_000;
        try {
          const healthUrl = await healthUrlOf(run);

          // --- the run: six events through Redis, an entry decided and filled -----
          const before = await publishSixAndSettle({ publisher, stream, label, healthUrl, context, registered });
          await publisher.close();

          // --- the outage ---------------------------------------------------------
          const stopStarted = Date.now();
          await redis.stop();
          stopped = true;
          const stopReturned = Date.now();
          const exited = await settleWithin(run.exit, 3 * bound + MARGIN_MS + 60_000);
          expect(
            exited === undefined ? "STILL RUNNING" : "returned",
            `startup() had not returned ${String(3 * bound + MARGIN_MS + 60_000)} ms after the Redis ` +
              "container was stopped — BOOT1-R7: the process hangs on the outage instead of halting",
          ).toBe("returned");
          if (exited === undefined) throw new Error("unreachable");

          // --- within the bound, measured -----------------------------------------
          const pumpStopped = lineAt(run, "pump stopped: ");
          const haltLatency = pumpStopped.at - stopReturned;
          const exitLatency = exited.at - stopReturned;
          console.log(
            `[OUTAGE-1 measured, default bound T=${String(bound)} ms] stop() took ` +
              `${String(stopReturned - stopStarted)} ms; after stop() returned: pump halted at ` +
              `+${String(haltLatency)} ms (bound T + margin = ${String(bound + MARGIN_MS)}), ` +
              `startup() returned at +${String(exitLatency)} ms (bound 3T + margin = ` +
              `${String(3 * bound + MARGIN_MS)})`,
          );
          expect(haltLatency).toBeLessThanOrEqual(bound + MARGIN_MS);
          expect(exitLatency).toBeLessThanOrEqual(3 * bound + MARGIN_MS);
          // The stated split: at most one bound per connection's courtesy QUIT after the halt.
          expect(exitLatency - haltLatency).toBeLessThanOrEqual(2 * bound + MARGIN_MS);

          // --- the halt: latched, GLOBAL, FULL_HALT, the infrastructure code -------
          expect(exited.value).toBe(EXIT_CODES.halted);
          expect(pumpStopped.line).toMatch(/^pump stopped: HALTED after \d+ poll\(s\)$/u);
          const after = exitHealth(run);
          expect(after.healthy).toBe(false);
          expect(after.halts.map((halt) => [halt.scope.kind, halt.code, halt.action])).toEqual([
            ["GLOBAL", "TRANSPORT_UNAVAILABLE", "FULL_HALT"],
          ]);
          const halt = after.halts[0];
          expect(halt?.detail).toContain("the event transport is unavailable");
          expect(halt?.detail).toContain("caused by");
          expect(run.text()).toContain("HALT GLOBAL TRANSPORT_UNAVAILABLE (FULL_HALT): ");

          // --- nothing traded after it, nothing written; the last writes read back -
          await expectNothingTradedOrWrittenAfter(run, context, registered, before);

          // --- the bound it ran under was the default, and the process said so ------
          expect(DEFAULT_RESPONSE_TIMEOUT_MS).toBe(bound);
          expect(run.text()).toContain(
            `event transport bound: every Redis command must answer within ${String(bound)} ms ` +
              `(${REDIS_RESPONSE_TIMEOUT_ENV} unset; the default)`,
          );
        } finally {
          // A run that did not return (the pre-fix behaviour) is abandoned here
          // with its failure already recorded; its connections die with the
          // container and the database.
          await publisher.close();
        }
      });
    } finally {
      if (!stopped) await redis.stop();
    }
  }, 240_000);

  it("an IDLE stream for five bounds is not an outage; the container stopped, it halts within the CONFIGURED bound", async () => {
    const redis = await startRedisContainer();
    let stopped = false;
    try {
      await withFreshDatabase(postgres.getConnectionUri(), "outage-idle", async ({ connectionString, context }) => {
        const label = "outage-idle";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const publisher = await connectPublisher(redis.getConnectionUrl());
        await publisher.close();

        const bound = 1_000;
        const run = runProcess(
          {
            ...safeEnvironment(),
            TRADER_CONFIG_PATH: "/outage-idle.json",
            REDIS_URL: redis.getConnectionUrl(),
            DATABASE_URL: connectionString,
            TRADER_HEALTH_BIND: "127.0.0.1",
            TRADER_HEALTH_PORT: "0",
            [REDIS_RESPONSE_TIMEOUT_ENV]: String(bound),
          },
          documentOn(registered, label, stream),
        );
        const healthUrl = await healthUrlOf(run);
        expect(run.text()).toContain(
          `event transport bound: every Redis command must answer within ${String(bound)} ms ` +
            `(${REDIS_RESPONSE_TIMEOUT_ENV}); a Redis outage latches`,
        );

        // --- idle: nothing published, Redis up, five bounds long -----------------
        const idleFor = 5 * bound;
        const early = await settleWithin(run.exit, idleFor);
        expect(
          early === undefined ? "still running" : `exited ${String(early.value)}`,
          `an idle stream ended the process:\n${run.text()}`,
        ).toBe("still running");
        const idle = await readHealth(healthUrl);
        expect(idle.halts).toEqual([]);
        expect(idle.healthy).toBe(true);
        expect(idle.loop.eventsProcessed).toBe(0);

        // --- the outage, under the configured bound --------------------------------
        await redis.stop();
        stopped = true;
        const stopReturned = Date.now();
        const exited = await settleWithin(run.exit, 3 * bound + MARGIN_MS + 60_000);
        expect(
          exited === undefined ? "STILL RUNNING" : "returned",
          "startup() had not returned after the idle process's Redis container was stopped — " +
            "BOOT1-R7: the process hangs on the outage instead of halting",
        ).toBe("returned");
        if (exited === undefined) throw new Error("unreachable");
        const haltLatency = lineAt(run, "pump stopped: ").at - stopReturned;
        const exitLatency = exited.at - stopReturned;
        console.log(
          `[OUTAGE-1 measured, configured bound T=${String(bound)} ms] idle ${String(idleFor)} ms ` +
            `without a halt; after stop() returned: pump halted at +${String(haltLatency)} ms ` +
            `(bound ${String(bound + MARGIN_MS)}), startup() returned at +${String(exitLatency)} ms ` +
            `(bound ${String(3 * bound + MARGIN_MS)})`,
        );
        expect(haltLatency).toBeLessThanOrEqual(bound + MARGIN_MS);
        expect(exitLatency).toBeLessThanOrEqual(3 * bound + MARGIN_MS);
        // The stated split: at most one bound per connection's courtesy QUIT after the halt.
        expect(exitLatency - haltLatency).toBeLessThanOrEqual(2 * bound + MARGIN_MS);
        expect(exited.value).toBe(EXIT_CODES.halted);
        expect(exitHealth(run).halts.map((halt) => [halt.scope.kind, halt.code, halt.action])).toEqual([
          ["GLOBAL", "TRANSPORT_UNAVAILABLE", "FULL_HALT"],
        ]);
        // Nothing was decided at any point: the stream never carried an event.
        expect((await durableRows(context, registered)).decisions).toHaveLength(0);
      });
    } finally {
      if (!stopped) await redis.stop();
    }
  }, 240_000);

  it("decides and fills, then — a PARTITION: the server silent, no socket closed (the docker-pause shape) — latches GLOBAL TRANSPORT_UNAVAILABLE and exits 75 within the configured bound", async () => {
    const redis = await startRedisContainer();
    try {
      await withFreshDatabase(postgres.getConnectionUri(), "outage-partition", async ({ connectionString, context }) => {
        const label = "outage-partition";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        // The publisher reaches the container directly; only the process under
        // test is behind the hop that goes silent.
        const publisher = await connectPublisher(redis.getConnectionUrl());
        const hop = await startFreezableRedisProxy(redis.getConnectionUrl());

        const bound = 1_000;
        const run = runProcess(
          {
            ...safeEnvironment(),
            TRADER_CONFIG_PATH: "/outage-partition.json",
            REDIS_URL: hop.url,
            DATABASE_URL: connectionString,
            TRADER_HEALTH_BIND: "127.0.0.1",
            TRADER_HEALTH_PORT: "0",
            [REDIS_RESPONSE_TIMEOUT_ENV]: String(bound),
          },
          documentOn(registered, label, stream),
        );
        try {
          const healthUrl = await healthUrlOf(run);
          const before = await publishSixAndSettle({ publisher, stream, label, healthUrl, context, registered });

          // --- the partition ------------------------------------------------------
          hop.freeze();
          const frozenAt = Date.now();
          const exited = await settleWithin(run.exit, 3 * bound + MARGIN_MS + 60_000);
          expect(
            exited === undefined ? "STILL RUNNING" : "returned",
            "startup() had not returned after the partition — the process hangs on a silent server " +
              `instead of halting:\n${run.text()}`,
          ).toBe("returned");
          if (exited === undefined) throw new Error("unreachable");

          const pumpStopped = lineAt(run, "pump stopped: ");
          const haltLatency = pumpStopped.at - frozenAt;
          const exitLatency = exited.at - frozenAt;
          console.log(
            `[OUTAGE-1 measured, partition, configured bound T=${String(bound)} ms] after the freeze: ` +
              `pump halted at +${String(haltLatency)} ms (bound T + margin = ${String(bound + MARGIN_MS)}), ` +
              `startup() returned at +${String(exitLatency)} ms (bound 3T + margin = ` +
              `${String(3 * bound + MARGIN_MS)})`,
          );
          expect(haltLatency).toBeLessThanOrEqual(bound + MARGIN_MS);
          expect(exitLatency).toBeLessThanOrEqual(3 * bound + MARGIN_MS);
          // The stated split: at most one bound per connection's courtesy QUIT after the halt.
          expect(exitLatency - haltLatency).toBeLessThanOrEqual(2 * bound + MARGIN_MS);

          expect(exited.value).toBe(EXIT_CODES.halted);
          expect(haltTriples(run)).toEqual([["GLOBAL", "TRANSPORT_UNAVAILABLE", "FULL_HALT"]]);
          const detail = exitHealth(run).halts[0]?.detail ?? "";
          // The operator reads WHY: the transport's own deadline, not only the wrapper.
          expect(detail).toMatch(/Command timed out|no reply to a read within/u);

          await expectNothingTradedOrWrittenAfter(run, context, registered, before);
        } finally {
          await hop.close();
          await publisher.close();
        }
      });
    } finally {
      await redis.stop();
    }
  }, 240_000);
});

describe("Redis refusals at startup are documented refusals, not crashes (OUTAGE-1, B1-R1-REDIS-UNCAUGHT)", () => {
  it("a subscription the transport refuses (a stored position it did not write) is TRADER_EVENT_SUBSCRIPTION_REFUSED, exit 78, with everything it opened closed", async () => {
    const redis = await startRedisContainer();
    try {
      await withFreshDatabase(postgres.getConnectionUri(), "outage-subscribe", async ({ connectionString, context }) => {
        const label = "outage-subscribe";
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const publisher = await connectPublisher(redis.getConnectionUrl());
        await publisher.close();
        const document = documentOn(registered, label, stream);
        const infrastructure = document["infrastructure"] as { readonly consumerId: string };
        // A stored position this transport never issued: ADR-003 §3.4 makes it a
        // refusal, never a quiet reposition.
        await writeStoredCheckpoint({
          url: redis.getConnectionUrl(),
          stream,
          consumerId: infrastructure.consumerId,
          token: "not-a-token-this-transport-issued",
        });

        const run = runProcess(
          {
            ...safeEnvironment(),
            TRADER_CONFIG_PATH: "/outage-subscribe.json",
            REDIS_URL: redis.getConnectionUrl(),
            DATABASE_URL: connectionString,
            TRADER_HEALTH_BIND: "127.0.0.1",
            TRADER_HEALTH_PORT: "0",
          },
          document,
        );
        const code = await run.exit;
        expect(code).toBe(EXIT_CODES.configurationRefused);
        expect(run.text()).toContain("REFUSING TO START: TRADER_EVENT_SUBSCRIPTION_REFUSED");
        expect(run.text()).toContain("EventBusCheckpointError");
        expect(run.text()).not.toContain("pump stopped");
        // The health endpoint it had opened is closed again.
        const healthUrl = await healthUrlOf(run);
        await expect(get(healthUrl)).rejects.toThrow();
        expect((await durableRows(context, registered)).decisions).toHaveLength(0);
      });
    } finally {
      await redis.stop();
    }
  }, 240_000);
});
