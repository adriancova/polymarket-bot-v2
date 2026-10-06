/**
 * `TRADER-SIGNALS` — the SHIPPED process (its esbuild bundle, built here with
 * `apps/trader`'s own esbuild and flags, as ADR-018 ships it) stops in order on
 * SIGTERM and SIGINT, against real PostgreSQL and Redis.
 *
 * ## Why a process
 *
 * The handlers are installed by `main.ts`'s process shell, which runs only in
 * the bundle (`import.meta.url.endsWith("/main.mjs")`). Only a process can
 * receive a signal, and only the bundle is what the operator runs.
 * `apps/trader/src/graceful-stop-sequence.test.ts` pins the ORDER of the stop
 * with fakes; this file pins that the shipped artefact does it with real
 * stores, and exits with the documented codes.
 *
 * ## The scenarios
 *
 * Each runs the fixture's scenario, shifted so that its last event is one
 * minute before the host's now (`support/host-clock.ts`; the entry fills), on
 * a fresh database and its own stream, and waits until the pump has committed
 * past every event before it signals.
 *
 * 1. **SIGTERM** and 2. **SIGINT**: exit 0. The log shows `STOP REQUESTED`,
 *    `pump stopped: STOPPED`, the SHUTDOWN rebuild check's matched line, no
 *    HALT line, and `trader stopped: exit 0`. Afterwards: every decision the
 *    process counted as persisted is in `strategy.decisions`, the stream
 *    position is recorded past every event, `ops.incidents` is empty, and
 *    the run row is still `RUNNING` — a stop records nothing new.
 * 3. **A halt in progress**: Redis freezes, the pump halts
 *    `TRANSPORT_UNAVAILABLE`, and SIGTERM arrives while the halt's own
 *    shutdown is closing. The exit stays 75, the halt is in `ops.incidents`,
 *    and the last line says the stop cleared nothing.
 * 4. **A second signal**: Redis freezes so the stop cannot finish (the
 *    pump's poll waits on it), SIGTERM, then SIGINT: exit 130 at once, with
 *    one `SHUTDOWN FORCED` line naming where the stop was.
 * 5. **The deadline**: the same frozen stop with
 *    `TRADER_SHUTDOWN_DEADLINE_MS=1000`: exit 124 about a second after
 *    SIGTERM, with one `SHUTDOWN DEADLINE EXCEEDED` line.
 *
 * NON-VACUITY. With the shell's `installGracefulStop` removed, scenarios 1
 * and 2 end by the signal itself (no exit code, no SHUTDOWN line), and 3 to 5
 * fail the same way. With `stopRequested` dropped from the pump, the process
 * never stops on its own, and 1 and 2 meet the deadline instead (124).
 * Recorded in the `TRADER-SIGNALS` handoff.
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
import { startFreezableRedisProxy, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import type { IngestedEvent, LoopHealthSnapshot } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SHUTDOWN_DEADLINE_ENV } from "../../../apps/trader/src/graceful-stop.js";
import { EXIT_CODES, REDIS_RESPONSE_TIMEOUT_ENV } from "../../../apps/trader/src/main.js";
import { recordedEvents, safeEnvironment } from "./support/fixture.js";
import { shiftScenario } from "./support/host-clock.js";
import { CONDITION_ID, documentFor, registerThroughTheRepositories, withFreshDatabase, type Registered } from "./support/registration.js";
import { startReadyPostgresContainer, startReadyRedisContainer } from "./support/containers.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/** The consumer the fixture's configuration names. */
const CONSUMER_ID = "trader-1";
/** For a loaded host (`CI-FLAKE-STALL-BOUND` precedent). */
const MARGIN_MS = 4_000;

let postgres: Awaited<ReturnType<typeof startReadyPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startReadyRedisContainer>>;
let workRoot: string;
let bundle: string;
const children = new Set<ChildProcess>();

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), "trader-signals-"));
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
    await sleep(25);
  }
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

interface Exit {
  readonly code: number | null;
  /** The signal that ENDED the process, if one did (it must not: every stop here exits by itself). */
  readonly signal: NodeJS.Signals | null;
  readonly at: number;
}

interface TraderProcess {
  readonly child: ChildProcess;
  readonly exit: Promise<Exit>;
  readonly lines: { readonly at: number; readonly line: string }[];
  text(): string;
  /** Sends `signal` and answers the instant it was sent. */
  send(signal: "SIGTERM" | "SIGINT"): number;
}

async function startTrader(label: string, document: Record<string, unknown>, env: Record<string, string | undefined>): Promise<TraderProcess> {
  const configPath = path.join(workRoot, `${label}.json`);
  await writeFile(configPath, JSON.stringify(document));
  const child = spawn(process.execPath, [bundle], {
    env: { ...env, TRADER_CONFIG_PATH: configPath },
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
  const exit = new Promise<Exit>((resolve) => {
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolve({ code, signal, at: Date.now() });
    });
  });
  return {
    child,
    exit,
    lines,
    text: () => lines.map((entry) => entry.line).join("\n"),
    send: (signal) => {
      const at = Date.now();
      child.kill(signal);
      return at;
    },
  };
}

function lineAt(run: TraderProcess, prefix: string): { readonly at: number; readonly line: string } {
  const entry = run.lines.find(({ line }) => line.startsWith(prefix));
  if (entry === undefined) throw new Error(`the process never logged "${prefix}":\n${run.text()}`);
  return entry;
}

async function untilLine(run: TraderProcess, prefix: string, withinMs = 60_000): Promise<{ readonly at: number; readonly line: string }> {
  return await waitFor(`the line "${prefix}"`, withinMs, () => Promise.resolve(run.lines.find(({ line }) => line.startsWith(prefix))));
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

/** Publishes and waits until the process's pump has recorded its position past every event. */
async function publishAndSettle(publisher: RedisStreamsEventTransport, stream: string, events: readonly IngestedEvent[]): Promise<void> {
  for (const event of events) await publisher.publish(stream, event.envelope);
  await waitFor(`the pump to commit past all ${String(events.length)} events`, 60_000, async () => {
    const metrics = await publisher.streamMetrics(stream);
    const lag = metrics.consumerLag.find((entry) => entry.consumerId === CONSUMER_ID)?.lag;
    return metrics.publishedTotal === events.length && lag === 0 ? metrics : undefined;
  });
}

async function decisionsOf(context: TestContext, runId: string): Promise<number> {
  const rows = await context.db.selectFrom("strategy.decisions").select(["evaluation_seq"]).where("run_id", "=", runId).execute();
  return rows.length;
}

async function incidentsOf(context: TestContext) {
  return await context.db.selectFrom("ops.incidents").select(["failure_class", "instance_id"]).orderBy("incident_id").execute();
}

describe("the shipped trader stops in order on SIGTERM and SIGINT (TRADER-SIGNALS)", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s after a paper fill: the pump stops, the SHUTDOWN check matches and is logged, everything closes, exit 0 — and nothing acknowledged is lost",
    async (signal) => {
      const label = `stop-${signal.toLowerCase()}`;
      await withFreshDatabase(postgres.getConnectionUri(), label, async ({ connectionString, context }) => {
        const registered = await registerThroughTheRepositories(context, label);
        const stream = uniqueStreamName(label);
        const { events, document } = shiftedScenario(registered, label, stream);
        const publisher = await connectPublisher(redis.getConnectionUrl());
        try {
          const run = await startTrader(label, document, {
            ...safeEnvironment(),
            REDIS_URL: redis.getConnectionUrl(),
            DATABASE_URL: connectionString,
          });
          await untilLine(run, "graceful stop: SIGINT or SIGTERM stops the trader in order");
          await publishAndSettle(publisher, stream, events);
          const sentAt = run.send(signal);
          const exited = await settleWithin(run.exit, 8_000 + MARGIN_MS);
          expect(exited === undefined ? "STILL RUNNING" : "exited", run.text()).toBe("exited");
          if (exited === undefined) throw new Error("unreachable");
          console.log(`[TRADER-SIGNALS measured] ${signal}: the process exited ${String(exited.code)} +${String(exited.at - sentAt)} ms after the signal`);
          // It EXITED, with a code — the signal did not end it.
          expect(exited.signal, run.text()).toBeNull();
          expect(exited.code, run.text()).toBe(EXIT_CODES.ok);

          // The log, in order.
          const requested = lineAt(run, "STOP REQUESTED: ");
          expect(requested.line).toMatch(new RegExp(`^STOP REQUESTED: ${signal} received during the pump \\(`, "u"));
          const pumpStopped = lineAt(run, "pump stopped: ");
          expect(pumpStopped.line).toMatch(
            new RegExp(`^pump stopped: STOPPED after \\d+ poll\\(s\\), ${String(events.length)} event\\(s\\) ingested: ${signal} was requested`, "u"),
          );
          const check = lineAt(run, "accounting rebuild check at shutdown: ");
          expect(check.line).toBe("accounting rebuild check at shutdown: the held ledger view equals its rebuild from zero");
          const stopped = lineAt(run, "trader stopped: ");
          expect(stopped.line).toBe(
            `trader stopped: exit 0 — a clean stop on ${signal}: no halt is latched and the SHUTDOWN rebuild check ` +
              "matched; everything opened was closed",
          );
          const order = [requested, pumpStopped, check, stopped].map((entry) => run.lines.indexOf(entry));
          expect([...order].sort((left, right) => left - right)).toStrictEqual(order);
          expect(run.text()).not.toMatch(/^HALT /mu);
          expect(run.text()).not.toContain("CLOSE FAILED");
          expect(run.text()).not.toContain("PROCESS EXIT FORCED");
          expect(run.text()).not.toContain("SHUTDOWN FORCED");
          expect(run.text()).not.toContain("SHUTDOWN DEADLINE EXCEEDED");

          // Not vacuous: the run filled, so the check compared a ledger with postings.
          const health = exitHealth(run);
          expect(health.halts).toStrictEqual([]);
          expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);

          // Nothing acknowledged was lost, and the position is recorded past every event.
          expect(await decisionsOf(context, registered.runId)).toBe(health.loop.decisionsPersisted);
          const metrics = await publisher.streamMetrics(stream);
          expect(metrics.consumerLag.find((entry) => entry.consumerId === CONSUMER_ID)?.lag).toBe(0);
          // What a stop records: nothing new — no incident, and the run row untouched.
          expect(await incidentsOf(context)).toStrictEqual([]);
          const runRow = await context.db
            .selectFrom("strategy.runs")
            .select(["status", "ended_at"])
            .where("run_id", "=", registered.runId)
            .executeTakeFirstOrThrow();
          expect(runRow).toStrictEqual({ status: "RUNNING", ended_at: null });
        } finally {
          await publisher.close();
        }
      });
    },
    240_000,
  );

  it("a HALT in progress stays a halt: Redis freezes, the pump halts, SIGTERM lands during the halt's own shutdown — exit 75, the halt recorded, never 0", async () => {
    const label = "stop-during-halt";
    // Each frozen connection's courtesy QUIT waits this bound, so the halt's
    // shutdown has two such waits for the signal to land in.
    const redisBoundMs = 3_000;
    await withFreshDatabase(postgres.getConnectionUri(), label, async ({ connectionString, context }) => {
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
          [REDIS_RESPONSE_TIMEOUT_ENV]: String(redisBoundMs),
        });
        await publishAndSettle(publisher, stream, events);
        redisHop.freeze();
        await untilLine(run, "HALT GLOBAL TRANSPORT_UNAVAILABLE", 30_000);
        run.send("SIGTERM");
        const exited = await settleWithin(run.exit, 4 * redisBoundMs + 8_000 + MARGIN_MS);
        expect(exited === undefined ? "STILL RUNNING" : "exited", run.text()).toBe("exited");
        if (exited === undefined) throw new Error("unreachable");
        expect(exited.signal, run.text()).toBeNull();
        expect(exited.code, run.text()).toBe(EXIT_CODES.halted);
        // The signal arrived during the halt's shutdown, and said so; the stop cleared nothing.
        const requested = lineAt(run, "STOP REQUESTED: SIGTERM received during ");
        console.log(`[TRADER-SIGNALS measured] ${requested.line.slice(0, 140)}…`);
        expect(requested.line).toMatch(/^STOP REQUESTED: SIGTERM received during the (halt record|closes) /u);
        expect(requested.line).toContain("1 halt(s) are latched (GLOBAL TRANSPORT_UNAVAILABLE), so the exit stays non-zero. ");
        expect(lineAt(run, "pump stopped: ").line).toMatch(/^pump stopped: HALTED after \d+ poll\(s\)$/u);
        expect(lineAt(run, "trader stopped: ").line).toMatch(
          /^trader stopped: exit 75 — halted: 1 halt\(s\) latched \(the HALT lines above\); the stop SIGTERM requested clears no halt, so this is not a clean stop; /u,
        );
        expect(lineAt(run, "accounting rebuild check at shutdown: ").line).toBe(
          "accounting rebuild check at shutdown: the held ledger view equals its rebuild from zero",
        );
        expect(await incidentsOf(context)).toStrictEqual([{ failure_class: "TRANSPORT_UNAVAILABLE", instance_id: registered.instanceId }]);
      } finally {
        redisHop.thaw();
        await redisHop.close();
        await publisher.close();
      }
    });
  }, 240_000);

  it("a SECOND signal during a stop that cannot finish (Redis frozen): exit 130 at once, with one SHUTDOWN FORCED line naming where the stop was", async () => {
    const label = "stop-forced";
    await withFreshDatabase(postgres.getConnectionUri(), label, async ({ connectionString, context }) => {
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
          // Long enough that the pump's in-flight poll outlasts the test's two signals.
          [REDIS_RESPONSE_TIMEOUT_ENV]: "20000",
        });
        await publishAndSettle(publisher, stream, events);
        redisHop.freeze();
        // Every poll is answered in milliseconds; this one is now in flight and unanswered.
        await sleep(300);
        run.send("SIGTERM");
        await untilLine(run, "STOP REQUESTED: SIGTERM", 10_000);
        await sleep(200);
        const secondAt = run.send("SIGINT");
        const exited = await settleWithin(run.exit, MARGIN_MS);
        expect(exited === undefined ? "STILL RUNNING" : "exited", run.text()).toBe("exited");
        if (exited === undefined) throw new Error("unreachable");
        console.log(`[TRADER-SIGNALS measured] a second signal: exit ${String(exited.code)} +${String(exited.at - secondAt)} ms after it`);
        expect(exited.signal, run.text()).toBeNull();
        expect(exited.code, run.text()).toBe(EXIT_CODES.shutdownForced);
        expect(lineAt(run, "SHUTDOWN FORCED: ").line).toMatch(
          /^SHUTDOWN FORCED: a second stop signal, SIGINT, arrived \d+ ms after the first \(SIGTERM\), during the pump \(the batch in hand finishing its durable writes and recording its stream position\)\. The process exits 130 now, without finishing the stop: .* No halt was latched$/u,
        );
        // The stop did not finish: no check line, no last line.
        expect(run.text()).not.toContain("accounting rebuild check at shutdown");
        expect(run.text()).not.toContain("trader stopped: ");
        // Everything acknowledged before the freeze is durable.
        expect(await decisionsOf(context, registered.runId)).toBeGreaterThan(0);
      } finally {
        redisHop.thaw();
        await redisHop.close();
        await publisher.close();
      }
    });
  }, 240_000);

  it(`the DEADLINE: a stop that cannot finish (Redis frozen) with ${SHUTDOWN_DEADLINE_ENV}=1000 exits 124 about a second after SIGTERM, saying where it was`, async () => {
    const label = "stop-deadline";
    const deadlineMs = 1_000;
    await withFreshDatabase(postgres.getConnectionUri(), label, async ({ connectionString, context }) => {
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
          [REDIS_RESPONSE_TIMEOUT_ENV]: "20000",
          [SHUTDOWN_DEADLINE_ENV]: String(deadlineMs),
        });
        expect((await untilLine(run, "graceful stop: ")).line).toContain(`within ${String(deadlineMs)} ms (${SHUTDOWN_DEADLINE_ENV})`);
        await publishAndSettle(publisher, stream, events);
        redisHop.freeze();
        await sleep(300);
        const sentAt = run.send("SIGTERM");
        const exited = await settleWithin(run.exit, deadlineMs + MARGIN_MS);
        expect(exited === undefined ? "STILL RUNNING" : "exited", run.text()).toBe("exited");
        if (exited === undefined) throw new Error("unreachable");
        console.log(`[TRADER-SIGNALS measured] the deadline: exit ${String(exited.code)} +${String(exited.at - sentAt)} ms after SIGTERM`);
        expect(exited.signal, run.text()).toBeNull();
        expect(exited.code, run.text()).toBe(EXIT_CODES.shutdownDeadlineExceeded);
        expect(exited.at - sentAt).toBeGreaterThanOrEqual(deadlineMs - 50);
        expect(lineAt(run, "SHUTDOWN DEADLINE EXCEEDED: ").line).toMatch(
          new RegExp(
            `^SHUTDOWN DEADLINE EXCEEDED: the stop SIGTERM requested had not finished ${String(deadlineMs)} ms later \\(${SHUTDOWN_DEADLINE_ENV}\\); ` +
              "it was in the pump \\(the batch in hand finishing its durable writes and recording its stream position\\)\\. The process exits 124 now, " +
              ".* No halt was latched$",
            "u",
          ),
        );
        expect(run.text()).not.toContain("trader stopped: ");
      } finally {
        redisHop.thaw();
        await redisHop.close();
        await publisher.close();
      }
    });
  }, 240_000);
});
