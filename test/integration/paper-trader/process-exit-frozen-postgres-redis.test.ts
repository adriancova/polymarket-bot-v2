/**
 * `TC-LOWS-1` (`PROV1-R2-L2`) — the SHIPPED process (its esbuild bundle,
 * built here with `apps/trader`'s own esbuild and flags) EXITS within a bound
 * after `startup()` returns, against a FROZEN PostgreSQL. Real PostgreSQL,
 * real Redis, each behind a freezable hop (sockets open, no byte forwarded:
 * what a paused server or a partition looks like from the client).
 *
 * ## Why a process, and not `startup()`
 *
 * `durable-halts-and-refusals-postgres-redis.test.ts` (3b, SILENT) proves that
 * `startup()` RETURNS 75 while PostgreSQL is frozen. A return is not an exit:
 * the pool's close ends each idle connection with a Terminate and a
 * half-close, and a socket whose peer never answers kept the process alive
 * (`PROVENANCE-1` r2, measured with `docker pause`). Only a process can show
 * that it exits, so this file runs the bundle the operator runs.
 *
 * ## Where the half-closed socket comes from (measured while writing this file)
 *
 * The trader's pool holds ONE connection in these runs (`pg_stat_activity`
 * after the settle: one idle `polymarket-bot` session): its writes are
 * sequential. When PostgreSQL freezes BEFORE the halt, the halt record checks
 * that one connection out, and at its bound DESTROYS it (`PROVENANCE-1` r1),
 * so the pool's close has nothing left to half-close. The L2 shape needs an
 * idle connection the pool ENDS: PostgreSQL that freezes AFTER the record
 * landed and before the store's close. That window is real: the close comes
 * after `feed.close()`, which waits up to one Redis bound for its courtesy
 * `QUIT` on the frozen Redis.
 *
 * ## The scenarios
 *
 * 0. **Nothing holds the process** (a startup refusal, 78): it exits at once,
 *    on its own, with no forced line — the shell's grace timer holds nothing.
 * 1. **The L2 shape.** Redis freezes; the pump halts `TRANSPORT_UNAVAILABLE`;
 *    the halt record is WRITTEN (PostgreSQL alive) and logged; PostgreSQL
 *    freezes at that line; the store's close ends the record's idle
 *    connection, half-closed, against the frozen server. `startup()` returns
 *    75 and the process, held by that socket, logs `PROCESS EXIT FORCED` and
 *    exits 75 within `PROCESS_EXIT_GRACE_MS` (plus the closes' Redis bounds)
 *    — PostgreSQL STILL frozen. That the PostgreSQL socket is among what
 *    holds it is READ, not inferred (`TC-LOWS-1` r1, `TCL1-R1-03`): Redis is
 *    frozen too, and the forced line names only handle types, so the
 *    process's own socket table (`support/held-sockets.ts`) is sampled until
 *    the exit, and its last reading — taken after `startup()` returned —
 *    must hold a connection to the PostgreSQL hop in `FIN_WAIT2`: half-closed
 *    by the client, never answered. Thawed afterwards, the record the process
 *    saw acknowledged is in `ops.incidents`, and every decision it counted as
 *    persisted is in `strategy.decisions`.
 * 2. **PostgreSQL and Redis frozen together.** The halt record answers
 *    `UNCONFIRMED` at its bound, `startup()` returns 75, and the process exits
 *    75 within the same bound. What holds it after the return is the frozen
 *    Redis hop's two half-closed sockets, which `ioredis` drops about two
 *    seconds after the return (measured), so the exit is forced at the grace
 *    — logged, not pinned, because it rests on that library's timing.
 *    Thawed afterwards, nothing of the record lands, as before this round.
 * 3. **Redis frozen, PostgreSQL alive** (the control). The record is written,
 *    the process exits 75 within the bound, and the rows are there after the
 *    exit. Measured: this process too is held by the frozen Redis hop's
 *    sockets after `startup()` returns, and its exit is forced (logged).
 *
 * The scenario is the fixture's own, shifted so that its last event is one
 * minute before the host's now (`support/host-clock.ts`, `shiftScenario`,
 * ADR-031 T4's method): the bundle runs the unmodified `SystemPaperClock`,
 * and its entry is judged at a real lag inside the bound, so it fills.
 *
 * NON-VACUITY: with the shell's `exitAfterStartup` call removed (the shell
 * before this round), scenario 1 fails: the process is still running at the
 * bound, held by the half-closed PostgreSQL socket. With the shell's grace
 * timer referenced (no `unref()`), scenario 0 fails. With PostgreSQL never
 * frozen in scenario 1 — the race the scenario could lose under load — the
 * frozen Redis alone still forces the exit, and only the socket-table
 * reading fails. Recorded in the `TC-LOWS-1` handoffs (r0, r1).
 *
 * Docker: Testcontainers, its own containers, no skip. PAPER only; no venue,
 * no signer, no real order; throwaway credentials that live only for the run.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EventBusUnavailableError, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { startFreezableRedisProxy, startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { startPostgresContainer, type TestContext } from "@polymarket-bot/storage-postgres/testing";
import type { IngestedEvent, LoopHealthSnapshot } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HALT_RECORD_DEADLINE_MS } from "../../../apps/trader/src/halt-record.js";
import { EXIT_CODES, REDIS_RESPONSE_TIMEOUT_ENV } from "../../../apps/trader/src/main.js";
import { PROCESS_EXIT_GRACE_MS } from "../../../apps/trader/src/process-exit.js";
import { recordedEvents, safeEnvironment } from "./support/fixture.js";
import { lastHeldSocketsBefore } from "./support/held-sockets.js";
import { shiftScenario } from "./support/host-clock.js";
import {
  CONDITION_ID,
  documentFor,
  registerThroughTheRepositories,
  withFreshDatabase,
  type Registered,
} from "./support/registration.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/** The Redis bound the processes run under (`TRADER_REDIS_RESPONSE_TIMEOUT_MS`). */
const REDIS_BOUND_MS = 1_000;
/** For a loaded host (`CI-FLAKE-STALL-BOUND` precedent). */
const MARGIN_MS = 4_000;
/**
 * From the silence to the exit: the halt, the record, two QUIT bounds, the
 * exit's own grace (the log here keeps up, so the forced line is out at once).
 */
const SILENCE_TO_EXIT_MS = REDIS_BOUND_MS + HALT_RECORD_DEADLINE_MS + 2 * REDIS_BOUND_MS + PROCESS_EXIT_GRACE_MS + MARGIN_MS;

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startRedisContainer>>;
let workRoot: string;
let bundle: string;
const children = new Set<ChildProcess>();

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), "tc-lows-1-exit-"));
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
}, 300_000);

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([redis?.stop(), postgres?.stop()]);
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

async function connectPublisher(url: string): Promise<RedisStreamsEventTransport> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await RedisStreamsEventTransport.connect({ connection: { url }, retention: { maxEvents: 10_000 } });
    } catch (failure) {
      if (!(failure instanceof EventBusUnavailableError)) throw failure;
      lastFailure = failure;
      await sleep(400);
    }
  }
  throw new Error(`a fresh Redis container never accepted a connection: ${String(lastFailure)}`);
}

interface TraderProcess {
  readonly pid: number;
  /** Settles with the exit code and the instant of the exit. */
  readonly exit: Promise<{ readonly code: number | null; readonly at: number }>;
  /** Every stderr line, with the instant it arrived here. */
  readonly lines: { readonly at: number; readonly line: string }[];
  text(): string;
}

async function startTrader(label: string, document: Record<string, unknown>, env: Record<string, string | undefined>): Promise<TraderProcess> {
  const configPath = path.join(workRoot, `${label}.json`);
  await writeFile(configPath, JSON.stringify(document));
  const child = spawn(process.execPath, [bundle], {
    env: { ...env, TRADER_CONFIG_PATH: configPath, [REDIS_RESPONSE_TIMEOUT_ENV]: String(REDIS_BOUND_MS) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  const lines: { at: number; line: string }[] = [];
  let partial = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const at = Date.now();
    partial += chunk.toString("utf8");
    const parts = partial.split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) lines.push({ at, line });
  });
  const exit = new Promise<{ code: number | null; at: number }>((resolve) => {
    child.on("exit", (code) => {
      children.delete(child);
      resolve({ code, at: Date.now() });
    });
  });
  if (child.pid === undefined) throw new Error("the trader process did not start");
  return { pid: child.pid, exit, lines, text: () => lines.map((entry) => entry.line).join("\n") };
}

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function lineAt(run: TraderProcess, prefix: string): { readonly at: number; readonly line: string } {
  const entry = run.lines.find(({ line }) => line.startsWith(prefix));
  if (entry === undefined) throw new Error(`the process never logged "${prefix}":\n${run.text()}`);
  return entry;
}

function exitHealth(run: TraderProcess): LoopHealthSnapshot {
  return JSON.parse(lineAt(run, "health: {").line.slice("health: ".length)) as LoopHealthSnapshot;
}

/** The fixture's scenario, its last event one minute before the host's now, on its own stream. */
function shiftedScenario(registered: Registered, label: string, stream: string) {
  const recorded = recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`);
  const last = recorded.at(-1);
  if (last === undefined) throw new Error("the fixture lost its events");
  const deltaMs = Date.now() - 60_000 - Date.parse(last.envelope.receivedAt);
  const shifted = shiftScenario(recorded, documentFor(registered, label), deltaMs);
  const document = {
    ...shifted.document,
    infrastructure: { ...(shifted.document["infrastructure"] as Record<string, unknown>), eventStream: stream },
  };
  return { events: shifted.events, document };
}

/** Publishes and waits until the process's pump committed past every event (quiescent: every write landed). */
async function publishAndSettle(publisher: RedisStreamsEventTransport, stream: string, events: readonly IngestedEvent[]): Promise<void> {
  for (const event of events) await publisher.publish(stream, event.envelope);
  await waitFor(`the pump to commit past all ${String(events.length)} events`, 60_000, async () => {
    const metrics = await publisher.streamMetrics(stream);
    const lag = metrics.consumerLag.find((entry) => entry.consumerId === "trader-1")?.lag;
    return metrics.publishedTotal === events.length && lag === 0 ? metrics : undefined;
  });
}

/** `connectionString`, through the freezable hop at `hopUrl` (same credentials and database). */
function throughHop(connectionString: string, hopUrl: string): string {
  const through = new URL(connectionString);
  through.hostname = "127.0.0.1";
  through.port = new URL(hopUrl).port;
  return through.toString();
}

async function incidents(context: TestContext) {
  return await context.db.selectFrom("ops.incidents").selectAll().orderBy("incident_id").execute();
}

describe("the shipped process exits within a bound once startup() has returned (TC-LOWS-1, PROV1-R2-L2)", () => {
  it("nothing holds the process — a startup refusal (78, no configuration path): it exits at once, on its own, with no forced line (the shell's grace timer holds nothing)", async () => {
    const child = spawn(process.execPath, [bundle], { env: safeEnvironment(), stdio: ["ignore", "ignore", "pipe"] });
    children.add(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const startedAt = Date.now();
    const exited = await settleWithin(
      new Promise<{ readonly code: number | null; readonly at: number }>((resolve) => {
        child.on("exit", (code) => {
          children.delete(child);
          resolve({ code, at: Date.now() });
        });
      }),
      30_000,
    );
    expect(exited === undefined ? "STILL RUNNING" : "exited", stderr).toBe("exited");
    if (exited === undefined) throw new Error("unreachable");
    expect(exited.code, stderr).toBe(EXIT_CODES.configurationRefused);
    expect(stderr).toContain("REFUSING TO START: TRADER_CONFIG_PATH");
    expect(stderr).not.toContain("PROCESS EXIT FORCED");
    console.log(`[TC-LOWS-1 measured, nothing held] the refused process exited +${String(exited.at - startedAt)} ms after its spawn`);
  }, 60_000);

  it("the L2 shape — PostgreSQL freezes after the halt record LANDED, before the store's close: the pool's ended connection is half-closed against it, and the process says so and EXITS 75 within the bound; the acknowledged record is durable", async () => {
    await withFreshDatabase(postgres.getConnectionUri(), "exit-l2", async ({ connectionString, context }) => {
      const label = "exit-l2";
      const registered = await registerThroughTheRepositories(context, label);
      const stream = uniqueStreamName(label);
      const { events, document } = shiftedScenario(registered, label, stream);
      const postgresHop = await startFreezableRedisProxy(connectionString);
      const redisHop = await startFreezableRedisProxy(redis.getConnectionUrl());
      const publisher = await connectPublisher(redis.getConnectionUrl());
      let thawed = false;
      try {
        const run = await startTrader(label, document, {
          ...safeEnvironment(),
          REDIS_URL: redisHop.url,
          DATABASE_URL: throughHop(connectionString, postgresHop.url),
        });
        await publishAndSettle(publisher, stream, events);
        redisHop.freeze();
        // The record lands (PostgreSQL alive); PostgreSQL freezes at its line,
        // while `feed.close()` waits on the frozen Redis — before the store's close.
        const record = await waitFor("the halt record's line", 30_000, () =>
          Promise.resolve(run.lines.find(({ line }) => line.startsWith("halt record: "))),
        );
        postgresHop.freeze();
        const frozenAt = Date.now();
        // `TCL1-R1-03`: what the process holds, read until it exits.
        const heldAtExit = lastHeldSocketsBefore(run.pid, run.exit);
        expect(record.line).toBe("halt record: 1 row(s) written to ops.incidents for 1 halt(s) (GLOBAL TRANSPORT_UNAVAILABLE)");
        const bound = 2 * REDIS_BOUND_MS + PROCESS_EXIT_GRACE_MS + MARGIN_MS;
        const exited = await settleWithin(run.exit, bound);
        console.log(
          "[TC-LOWS-1 measured, PostgreSQL frozen after the record] the process " +
            (exited === undefined
              ? `was STILL RUNNING ${String(bound)} ms after PostgreSQL froze`
              : `exited ${String(exited.code)} +${String(exited.at - frozenAt)} ms after PostgreSQL froze`),
        );
        expect(exited === undefined ? "STILL RUNNING while PostgreSQL is frozen" : "exited", run.text()).toBe("exited");
        if (exited === undefined) throw new Error("unreachable");
        expect(exited.code, run.text()).toBe(EXIT_CODES.halted);
        const health = exitHealth(run);
        expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
        expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "TRANSPORT_UNAVAILABLE"]]);
        const forced = lineAt(run, "PROCESS EXIT FORCED: ");
        expect(forced.line).toContain(`startup() returned ${String(EXIT_CODES.halted)} ${String(PROCESS_EXIT_GRACE_MS)} ms ago`);
        expect(forced.line).toMatch(/still held open by [^:]*TCPSocketWrap/u);
        console.log(`[TC-LOWS-1 measured] ${forced.line.slice(0, 170)}…`);
        // `TCL1-R1-03`: one of those sockets is PostgreSQL's — the pool's
        // ended idle connection, half-closed (`FIN_WAIT2`) against the frozen
        // hop. The reading is the last one before the exit, and was taken less
        // than the grace before it: after `startup()` returned (the exit was
        // forced, so it came at least the grace after the return).
        const held = await heldAtExit;
        const postgresHopPort = Number(new URL(postgresHop.url).port);
        console.log(
          `[TC-LOWS-1 measured] the process's TCP sockets ${held === undefined ? "were never read" : `${String(exited.at - held.at)} ms before its exit: ${JSON.stringify(held.sockets)}`} (PostgreSQL hop port ${String(postgresHopPort)})`,
        );
        if (held === undefined) throw new Error("the process's socket table was never read while it ran");
        expect(exited.at - held.at).toBeLessThan(PROCESS_EXIT_GRACE_MS);
        expect(
          held.sockets.filter((socket) => socket.remotePort === postgresHopPort).map((socket) => socket.state),
          "a connection to the frozen PostgreSQL, half-closed by the process and never answered",
        ).toContain("FIN_WAIT2");
        // Thawed only now. The record the process saw acknowledged is durable,
        // and so is every decision it counted as persisted.
        postgresHop.thaw();
        redisHop.thaw();
        thawed = true;
        const rows = await incidents(context);
        expect(rows.map((row) => [row.failure_class, row.instance_id])).toEqual([["TRANSPORT_UNAVAILABLE", registered.instanceId]]);
        const decisions = await context.db
          .selectFrom("strategy.decisions")
          .select(["evaluation_seq"])
          .where("run_id", "=", registered.runId)
          .execute();
        expect(decisions).toHaveLength(health.loop.decisionsPersisted);
      } finally {
        if (!thawed) {
          postgresHop.thaw();
          redisHop.thaw();
        }
        await postgresHop.close();
        await redisHop.close();
        await publisher.close();
      }
    });
  }, 240_000);

  it("PostgreSQL and Redis frozen TOGETHER: the record answers UNCONFIRMED, startup() returns 75, and the process exits 75 within the bound — PostgreSQL still frozen; nothing of the record lands afterwards", async () => {
    await withFreshDatabase(postgres.getConnectionUri(), "exit-frozen", async ({ connectionString, context }) => {
      const label = "exit-frozen";
      const registered = await registerThroughTheRepositories(context, label);
      const stream = uniqueStreamName(label);
      const { events, document } = shiftedScenario(registered, label, stream);
      const postgresHop = await startFreezableRedisProxy(connectionString);
      const redisHop = await startFreezableRedisProxy(redis.getConnectionUrl());
      const publisher = await connectPublisher(redis.getConnectionUrl());
      let thawed = false;
      try {
        const run = await startTrader(label, document, {
          ...safeEnvironment(),
          REDIS_URL: redisHop.url,
          DATABASE_URL: throughHop(connectionString, postgresHop.url),
        });
        await publishAndSettle(publisher, stream, events);
        postgresHop.freeze();
        redisHop.freeze();
        const silentAt = Date.now();
        const exited = await settleWithin(run.exit, SILENCE_TO_EXIT_MS);
        console.log(
          "[TC-LOWS-1 measured, PostgreSQL and Redis frozen together] the process " +
            (exited === undefined
              ? `was STILL RUNNING ${String(SILENCE_TO_EXIT_MS)} ms after the silence`
              : `exited ${String(exited.code)} +${String(exited.at - silentAt)} ms after the silence`),
        );
        expect(exited === undefined ? "STILL RUNNING while PostgreSQL is frozen" : "exited", run.text()).toBe("exited");
        if (exited === undefined) throw new Error("unreachable");
        expect(exited.code, run.text()).toBe(EXIT_CODES.halted);
        const health = exitHealth(run);
        expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
        expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "TRANSPORT_UNAVAILABLE"]]);
        const record = lineAt(run, "HALT RECORD UNCONFIRMED: ");
        // Forced or not depends on when `ioredis` drops the frozen hop's
        // sockets (measured: about a second after the grace): logged, not pinned.
        console.log(`[TC-LOWS-1 measured] exit ${run.text().includes("PROCESS EXIT FORCED: ") ? "forced" : "on its own"}`);
        // Bounded from the record's answer: two QUIT bounds for the closes, then the exit's own bound.
        expect(exited.at - record.at).toBeLessThanOrEqual(2 * REDIS_BOUND_MS + PROCESS_EXIT_GRACE_MS + MARGIN_MS);
        // Thawed only now: the record's connection was destroyed at its bound,
        // so nothing of it lands afterwards — exactly as before this round.
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
        await postgresHop.close();
        await redisHop.close();
        await publisher.close();
      }
    });
  }, 240_000);

  it("the control — Redis frozen, PostgreSQL ALIVE throughout: the halt record is written, the process exits 75 within the bound, and every acknowledged write is still there after the exit", async () => {
    await withFreshDatabase(postgres.getConnectionUri(), "exit-control", async ({ connectionString, context }) => {
      const label = "exit-control";
      const registered = await registerThroughTheRepositories(context, label);
      const stream = uniqueStreamName(label);
      const { events, document } = shiftedScenario(registered, label, stream);
      const redisHop = await startFreezableRedisProxy(redis.getConnectionUrl());
      const publisher = await connectPublisher(redis.getConnectionUrl());
      try {
        const run = await startTrader(label, document, {
          ...safeEnvironment(),
          REDIS_URL: redisHop.url,
          DATABASE_URL: connectionString,
        });
        await publishAndSettle(publisher, stream, events);
        redisHop.freeze();
        const silentAt = Date.now();
        const exited = await settleWithin(run.exit, SILENCE_TO_EXIT_MS);
        console.log(
          "[TC-LOWS-1 measured, Redis frozen, PostgreSQL alive] the process " +
            (exited === undefined
              ? `was STILL RUNNING ${String(SILENCE_TO_EXIT_MS)} ms after the silence`
              : `exited ${String(exited.code)} +${String(exited.at - silentAt)} ms after the silence, ` +
                (run.text().includes("PROCESS EXIT FORCED: ") ? "forced" : "on its own")),
        );
        expect(exited === undefined ? "STILL RUNNING" : "exited", run.text()).toBe("exited");
        if (exited === undefined) throw new Error("unreachable");
        expect(exited.code, run.text()).toBe(EXIT_CODES.halted);
        const health = exitHealth(run);
        expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
        expect(run.text()).toContain(
          "halt record: 1 row(s) written to ops.incidents for 1 halt(s) (GLOBAL TRANSPORT_UNAVAILABLE)",
        );
        const rows = await incidents(context);
        expect(rows.map((row) => [row.failure_class, row.instance_id])).toEqual([["TRANSPORT_UNAVAILABLE", registered.instanceId]]);
        const decisions = await context.db
          .selectFrom("strategy.decisions")
          .select(["evaluation_seq"])
          .where("run_id", "=", registered.runId)
          .execute();
        expect(decisions).toHaveLength(health.loop.decisionsPersisted);
      } finally {
        redisHop.thaw();
        await redisHop.close();
        await publisher.close();
      }
    });
  }, 240_000);
});
