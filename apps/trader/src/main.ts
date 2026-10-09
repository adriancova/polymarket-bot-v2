/**
 * The paper trader's process entry point.
 *
 * This is the ONLY file in the package that touches `process` — the
 * environment, the exit code, the SIGINT and SIGTERM handlers. Everything
 * else takes what it needs as an argument, which is what makes the whole
 * system testable without an ambient environment and what keeps §6
 * invariant 17's check (`safety.ts`) a pure function of a record. The
 * handlers are installed by the process shell at the bottom of this file and
 * live in `graceful-stop.ts`, which is handed `process` (`TRADER-SIGNALS`;
 * before that round this sentence named "the signal handlers" and there were
 * none, so Ctrl-C killed the process outright).
 *
 * ## The startup sequence, and why nothing may move ahead of step 1
 *
 * ```text
 * 0. installGracefulStop(...)            ← TRADER-SIGNALS (the shell): SIGINT/SIGTERM request a stop
 * 1. checkPaperTraderSafety(env)        ← §6 invariant 17, §15, ADR-010
 * 2. read and parse the configuration    ← ADR-020 D1-D4
 * 2b. readHealthServerEnv(env)           ← TRDR-3: loopback-only, or no endpoint, stated
 * 2c. readRedisResponseTimeout(env)      ← OUTAGE-1: the Redis outage bound, stated
 * 2d. readShutdownDeadline(env)          ← TRADER-SIGNALS: the stop's deadline, stated
 * 3. construct the infrastructure        ← Redis (refused with 69 if unreachable), PostgreSQL
 * 3b. verifyRegisteredRows(db, config)   ← BOOT-1: the rows every durable write references
 * 4. the simulated venue, then
 *    createPaperTrader(...)              ← the composition root
 * 4b. startTraderHealthServer(...)       ← TRDR-3: GET /health over the loopback, if configured
 * 5. pump                                ← §8.1's outer loop, until a halt or a requested stop
 * 5b. checkAccountingRebuild("SHUTDOWN") ← FOLD-1: §6 invariant 8's rebuild, run once the pump stops
 * 5c. recordHaltsBeforeExit(...)         ← PROVENANCE-1: every latched halt to ops.incidents, bounded
 * 5d. close, in the reverse order of opening
 * 6. exitAfterStartup(code, ...)          ← TC-LOWS-1: the process exits with that code, bounded
 * ```
 *
 * Step 0 installs handlers and nothing else: it reads no environment and
 * opens nothing, so step 1 is still the first thing that DECIDES anything.
 * Steps 5 to 5d are {@link runUntilStopped}.
 *
 * Step 1 runs on the ENVIRONMENT RECORD before a configuration file is opened,
 * before a Redis connection is attempted and before a database pool exists. §6
 * invariant 17 says "startup validation rejects this configuration", and a
 * process that had already connected to something would have moved before the
 * validation it is subject to.
 *
 * ## Step 3b, and why the process refuses rather than registers (`BOOT-1`, B9)
 *
 * Steps 3b and 4 are {@link assembleDurableTrader}, which `startup` calls and
 * which the Testcontainers acceptance test
 * (`test/integration/paper-trader/durable-trader-first-fill-postgres.test.ts`)
 * calls with a real database — the factoring exists because `startup()` as
 * written pumps until a halt and needs a Redis stream, so a test that must
 * regain control after a fill cannot invoke it as-is. Everything from the
 * durable store to the wired trader is the SAME function on both paths.
 *
 * Before `BOOT-1` this file built the pool and the store and nothing else, and
 * the assembled trader GLOBAL-halted on its first decision against the
 * migrated-but-unseeded database it had just connected to:
 * `strategy.decisions.run_id` is a NOT NULL foreign key into a table nothing in
 * this app writes. The check reads the `catalog.markets`, `strategy.instances`
 * and `strategy.runs` rows the configuration names and REFUSES TO START if any
 * is absent or disagrees with the configuration; it creates none of them, for
 * the per-table reasons set out in `adapters/postgres-registration.ts`. The
 * refusal is a logged list and an exit code, never a degraded start.
 *
 * ## Step 4b, and why the health endpoint listens exactly there (`TRDR-3`)
 *
 * The health endpoint (`health-server.ts`) is started INSIDE
 * {@link assembleDurableTrader}, after `createPaperTrader` has returned and
 * before this function pumps. Not earlier: a process that is about to refuse —
 * an unsafe environment, an unregistered run, a refused fee snapshot — has
 * nothing to report and must not leave a port open while it says so, and the
 * snapshot function it serves does not exist until the trader does. Not later:
 * `pump` returns only at a halt, and an operator reads health DURING the run.
 * The endpoint is optional — both `TRADER_HEALTH_BIND` and `TRADER_HEALTH_PORT`
 * unset is "no endpoint", logged as such at step 2b — and when configured it
 * binds loopback only, serves `GET /health` only, and is closed on every path
 * out of this function.
 *
 * Step 2b runs BEFORE any infrastructure is opened: a refused bind host is a
 * configuration refusal (exit 78), and a process that had already connected
 * to Redis would have moved before the validation it is subject to.
 *
 * The same assembly wraps the durable store with `pnl-observation.ts` and
 * attaches the resulting `RealizedPnlBook` to the trader's health state, so
 * the snapshot the endpoint serves carries `accounting.realizedPnl` — the PnL
 * engine's own value, observed at the store port.
 *
 * ## The Redis boundary, at startup and mid-run (`OUTAGE-1`)
 *
 * §4.2: "A Redis outage stops publication and therefore halts trading." Two
 * halves, both measured before this round and neither held:
 *
 * - **Unreachable at startup** (`B1-R1-REDIS-UNCAUGHT`). `connect` rejected
 *   with an uncaught `EventBusUnavailableError`: a stack trace and exit 1,
 *   against this function's own "Never throws". It is now a logged
 *   `REFUSING TO START: TRADER_REDIS_UNAVAILABLE` and
 *   {@link EXIT_CODES.infrastructureUnavailable} (69), the PostgreSQL
 *   boundary's code, because the remedy is the same class: nothing in the
 *   document is wrong, a dependency is unreachable. It is refused before any
 *   database pool exists. A URL the transport refuses outright (a wrong
 *   scheme) is a configuration refusal instead (`TRADER_REDIS_URL_REFUSED`,
 *   78). A subscription the transport refuses is the same pair:
 *   unreachable → 69, anything else → `TRADER_EVENT_SUBSCRIPTION_REFUSED`, 78.
 * - **An outage mid-run** (`BOOT1-R7`). The process HUNG: with the container
 *   stopped under the real `startup()`, the pump's `receive` was still pending
 *   90 s later (reproduced by `OUTAGE-1` before the fix). The cause is in the
 *   Redis client, and so is the fix (`packages/event-bus`
 *   `responseTimeoutMs`). This file states the bound and passes it:
 *   `TRADER_REDIS_RESPONSE_TIMEOUT_MS` (T; default 5000, accepted
 *   100…60000, anything else a refusal before anything is opened). The pump
 *   latches GLOBAL `TRANSPORT_UNAVAILABLE` (`FULL_HALT`) within T of the
 *   first Redis command the outage leaves unanswered. `startup()` then
 *   returns {@link EXIT_CODES.halted} (75) within 3T of that command: T for
 *   the halt, plus at most T for each of the two connections' courtesy
 *   `QUIT`, which is sent only to a connection that still reports itself
 *   ready. Add the PostgreSQL close and the shutdown rebuild check, neither
 *   of which waits on Redis. An idle stream never trips it: an idle poll is
 *   answered in milliseconds.
 *
 * ## The durable halt record (`PROVENANCE-1`)
 *
 * Once the pump has stopped on a halt (and the shutdown rebuild check has
 * run, which can latch one more), every latched halt is written to
 * `ops.incidents` before anything is closed (`halt-record.ts`). The write is
 * bounded by `HALT_RECORD_DEADLINE_MS` and never changes the exit code: a
 * database that refuses it, or does not answer within the bound, is logged
 * (`HALT RECORD NOT DURABLE` / `UNCONFIRMED`) and the process still exits
 * {@link EXIT_CODES.halted}. The write's own connection is destroyed at the
 * bound (`PostgresTraderStore.recordHalts`; `PROVENANCE-1` r1), so the
 * PostgreSQL close that follows does not wait on it. A connection the pool is
 * still OPENING at the bound is not the write's yet, and is not destroyed
 * then: the pool's own connection timeout (`createPostgresPool`, 10,000 ms by
 * default) ends it, and the PostgreSQL close waits for that (`PROV1-R2-L3`,
 * measured: `startup()` returned 12,005 ms after the halt). Nothing trades
 * after the halt either way; the record is for the operator and the research
 * worker afterwards.
 *
 * ## The process exit (`TC-LOWS-1`, `PROV1-R2-L2`)
 *
 * `startup()` returning is not the process exiting. On a frozen PostgreSQL
 * the pool's close leaves its ended idle connections half-closed, and a
 * socket whose peer never answers kept the process alive after `startup()`
 * had returned 75. The process shell below now hands the code to
 * `exitAfterStartup` (`process-exit.ts`): the process exits on its own when
 * nothing holds it, and otherwise logs `PROCESS EXIT FORCED: …` and exits
 * with the same code `PROCESS_EXIT_GRACE_MS` (1,000 ms) after `startup()`
 * returned — from that line's own write callback, so never ahead of a line
 * already logged: the `HALT …` and `HALT RECORD …` lines reach the log first,
 * and a log that is not taking lines holds the exit until it does
 * (`TC-LOWS-1` r1, `TCL1-R1-01`). It runs only once every durable outcome is
 * final, so no acknowledged write and no halt record is lost by it (the
 * reasoning is in that module's header).
 *
 * ## The graceful stop (`TRADER-SIGNALS`)
 *
 * SIGINT or SIGTERM REQUESTS a stop (`graceful-stop.ts`, whose header has the
 * whole design). The pump reads no new batch, and the batch in hand finishes
 * its durable writes and records its position (`pump.ts`); then steps 5b to
 * 5d run exactly as after a halt: the SHUTDOWN rebuild check, reported as
 * before; the halt record, when a halt is latched; and the closes, in the
 * reverse order of opening — the transport-lag sampler, the event
 * subscription, the health endpoint, the PostgreSQL pool, the Redis
 * transport. There is no separate metrics listener: the health endpoint is
 * this process's only HTTP surface. A close that fails is logged
 * (`CLOSE FAILED: …`) and the next one still runs.
 *
 * The exit ({@link exitCodeAfterStop}): `0` only when no halt is latched and
 * the check matched; {@link EXIT_CODES.halted} (75) when any halt is latched,
 * the signal notwithstanding — a halt stays a halt; and
 * {@link EXIT_CODES.shutdownCheckFailed} (70) when the check failed, whatever
 * stopped the pump. A second signal exits
 * {@link EXIT_CODES.shutdownForced} (130) at once, and a stop that has not
 * finished within `TRADER_SHUTDOWN_DEADLINE_MS` (default 8,000 ms; why, in
 * `graceful-stop.ts`) exits {@link EXIT_CODES.shutdownDeadlineExceeded}
 * (124). Each of those says why, in one line.
 *
 * WHAT A STOP RECORDS. Nothing durable that a halt exit did not already
 * record: the halt record when a halt is latched, and no row otherwise. In
 * particular this process does not write its run's `strategy.runs.status`
 * (`RUNNING` / `STOPPED` / `FAILED`) on any exit, before this round or after
 * it: the row stays `RUNNING`, so a stop cannot mark a halted run as cleanly
 * completed, and `BOOT-1` already refuses to resume a run that holds
 * decisions, so the next start is a new run either way. The stop's outcome is
 * its exit code and its log: `pump stopped: STOPPED` (a new value of the
 * pump's result, not a new run status) and the last line,
 * `trader stopped: exit <code> — …`.
 *
 * ## The evaluation cadence (`CADENCE-1`, ADR-026)
 *
 * The trader evaluates each market's `onFeatures` at most once per 1,000 ms of
 * EVENT time, plus a 5,000 ms heartbeat (`packages/trading-core` `cadence.ts`).
 * Both settings are pinned in each run's `strategy.runs` row (migration 0010):
 * step 3b refuses a run row that records anything but 1,000 / 5,000 — 0, NULL
 * or another value — and step 4 then runs the core with exactly those values.
 * No environment variable or configuration field can change them (ADR-026
 * D1.5: other values need a new ruling).
 *
 * A far-future event stamp holds every `onFeatures` evaluation until the event
 * clock has moved on (ADR-026 D2.10). The core counts each event that lies
 * more than 5,000 ms behind its event clock (`cadenceForwardJumpAlarms`), and
 * this file logs ONE line when such an episode starts —
 * `CADENCE CLOCK FORWARD JUMP: …`, the line an operator's pager watches, as it
 * watches `HALT RECORD NOT DURABLE` — and one when it ends,
 * `CADENCE CLOCK CAUGHT UP: …`.
 *
 * ## The two-phase venue wiring, and why it is not a smell
 *
 * The simulated venue asks the composition root two questions it cannot answer
 * itself: what BOOK a market has (§12.2's Tier-0 depth) and what TIME-IN-FORCE a
 * planned order carries (`ExecutionPolicy.timeInForceFor` — "a silently assumed
 * `FAK` would change every unfilled remainder's fate"). Both answers live inside
 * the trader the venue is a constructor argument to.
 *
 * So the venue is built against a HOLDER that the trader fills immediately
 * after construction. The alternative — letting the venue default either answer
 * — is the one thing `packages/simulation` explicitly refuses to do, and the
 * holder is unset for exactly the window in which no event has been processed
 * and therefore no plan can exist.
 *
 * ## Safety, restated where an operator will read it
 *
 * There is no signer here, no venue client, no credential, and no code path
 * that could place a real order. The only `ExecutionVenue` this process can be
 * given is `packages/simulation`'s, which refuses `EXECUTION_PROBE`,
 * `LIVE_MICRO` and `LIVE` **by name**; `safety.ts` refuses to start under a
 * raised `MAX_RUN_MODE`, under a run mode that would need a signer, or in an
 * environment that so much as references a production secret NAME.
 */

import { readFile } from "node:fs/promises";

import {
  DEFAULT_RESPONSE_TIMEOUT_MS,
  EventBusConfigurationError,
  EventBusUnavailableError,
  MAX_RETENTION_EVENTS,
  RedisStreamsEventTransport,
  type EventSubscription,
} from "@polymarket-bot/event-bus";
import { DEFAULT_CONNECTION_TIMEOUT_MS, createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";

import { verifyRegisteredRows } from "./adapters/postgres-registration.js";
import { PostgresTraderStore } from "./adapters/postgres-store.js";
import { RedisMarketEventFeed } from "./adapters/redis-feed.js";
import {
  bookFreshnessBasisOf,
  marketChannelFeedIdOf,
  parseTraderConfig,
  type TraderConfig,
} from "@polymarket-bot/trading-core";
import { RealizedPnlBook } from "@polymarket-bot/trading-core";
import {
  readHealthServerEnv,
  startTraderHealthServer,
  type HealthListen,
  type RunningTraderHealthServer,
} from "./health-server.js";
import { HALT_RECORD_DEADLINE_MS, recordHaltsBeforeExit, resolveSupersededHalts } from "./halt-record.js";
import { PROCESS_EXIT_GRACE_MS, exitAfterStartup, processExitPorts } from "./process-exit.js";
import {
  SHUTDOWN_DEADLINE_ENV,
  SHUTDOWN_DEADLINE_EXIT_CODE,
  SHUTDOWN_FORCED_EXIT_CODE,
  gracefulStopPorts,
  installGracefulStop,
  readShutdownDeadline,
  type StopRequest,
  type StopSignal,
} from "./graceful-stop.js";
import { observeRealizedPnl } from "./pnl-observation.js";
import type { Clock, MarketEventFeed } from "@polymarket-bot/trading-core";
import { pump, type PumpResult } from "./pump.js";
import { TransportLagSampler } from "./transport-lag.js";
import { checkPaperTraderSafety } from "@polymarket-bot/trading-core";
import { createPaperTrader, type PaperTrader } from "@polymarket-bot/trading-core";
import { createExecutionPolicy, type VenueWiring } from "@polymarket-bot/trading-core";
import { PAPER_EVALUATION_CADENCE, type CadenceAlarm } from "@polymarket-bot/trading-core";
import type { AdmissionNotice } from "@polymarket-bot/trading-core";
import { buildSimulatedVenue } from "@polymarket-bot/trading-core";

export { createExecutionPolicy, type VenueWiring };

/**
 * What the process exits with, so an operator can script against it.
 *
 * `TRADER-SIGNALS` added the last three. When more than one applies, the
 * order is: a forced or late exit (130, 124) ends the process before
 * `startup()` returns, so its code is the one reported, even when a halt is
 * latched — its one line then names every latched halt, so a halt is never
 * hidden and the exit is never 0; otherwise `shutdownCheckFailed` (70) over
 * `halted` (75) over `ok` (0) ({@link exitCodeAfterStop}).
 */
export const EXIT_CODES = Object.freeze({
  /**
   * The pump stopped with no halt latched and the SHUTDOWN rebuild check
   * matched: since `TRADER-SIGNALS`, a requested stop (SIGINT or SIGTERM)
   * that finished in order.
   */
  ok: 0,
  /** The environment is unsafe (§6 invariant 17, §15, ADR-010). */
  unsafeEnvironment: 78,
  /** The configuration was refused. */
  configurationRefused: 78,
  /**
   * A halt latched: no further trading decision will be made (§4.2).
   *
   * `OUTAGE-1`: also the exit of a Redis outage MID-RUN, within the bound
   * `TRADER_REDIS_RESPONSE_TIMEOUT_MS` states (see the module header).
   */
  halted: 75,
  /**
   * The database could not answer the startup registration check (`BOOT-1`).
   *
   * `sysexits` EX_UNAVAILABLE. Distinct from `configurationRefused` because
   * the operator's remedy differs — nothing in the document is wrong, the
   * store is unreachable — and distinct from `halted` because no halt latched:
   * the process never started.
   *
   * `OUTAGE-1`: also the event transport (Redis) unreachable at startup
   * (`TRADER_REDIS_UNAVAILABLE`), for the same reason and with the same
   * remedy class.
   */
  infrastructureUnavailable: 69,
  /**
   * `TRADER-SIGNALS`: the `FOLD-1` SHUTDOWN rebuild check failed — the held
   * ledger view (or a PnL stream) differs from its rebuild from zero, §6
   * invariant 8. The check has latched a GLOBAL
   * `ACCOUNTING_REBUILD_MISMATCH` halt, so this is a halt exit too, but a
   * DISTINCT one: the run's in-memory accounting is not to be trusted, which
   * is a defect to report, not an outage to wait out.
   *
   * `sysexits` EX_SOFTWARE ("an internal software error has been detected").
   * It takes precedence over {@link EXIT_CODES.halted} whatever stopped the
   * pump — a halt, or a requested stop — so a script that sees 75 knows the
   * check matched. (Before this round a failed check exited 75; nothing
   * pinned that.)
   */
  shutdownCheckFailed: 70,
  /**
   * `TRADER-SIGNALS`: a requested stop did not finish within
   * `TRADER_SHUTDOWN_DEADLINE_MS` (default 8,000 ms), and the process exited
   * without finishing it, after one `SHUTDOWN DEADLINE EXCEEDED: …` line
   * naming where it was (`graceful-stop.ts`). 124 is the code `timeout(1)`
   * exits with when its command times out.
   */
  shutdownDeadlineExceeded: SHUTDOWN_DEADLINE_EXIT_CODE,
  /**
   * `TRADER-SIGNALS`: a second SIGINT or SIGTERM arrived while a requested
   * stop was under way, and the process exited at once without finishing it,
   * after one `SHUTDOWN FORCED: …` line (`graceful-stop.ts`). 130 is 128 + 2
   * (SIGINT): what a shell reports for a process Ctrl-C ended, used for a
   * second SIGTERM too.
   */
  shutdownForced: SHUTDOWN_FORCED_EXIT_CODE,
});

export interface StartupPorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readConfig: (path: string) => Promise<string>;
  readonly log: (line: string) => void;
  /**
   * `TRADER-SIGNALS`: the stop SIGINT and SIGTERM request (the shell's
   * `installGracefulStop`). Absent, as in a test that calls `startup()`
   * directly, no stop can be requested and the pump runs until a halt.
   */
  readonly stop?: StopRequest;
}

/**
 * Runs the startup sequence and reports an exit code. Never throws.
 *
 * Exported and parameterised so the entry-point behaviour is testable without
 * spawning a process or reading an ambient environment.
 *
 * "NEVER THROWS", PRECISELY (review round 1, MEDIUM-3). Every refusal below is
 * a logged line and an {@link EXIT_CODES} value. There is exactly ONE `throw`
 * reachable from this file — {@link createExecutionPolicy}'s unresolvable
 * time-in-force — and it is not thrown on this call stack: the venue invokes
 * the policy inside its own `totallyResult` boundary and answers a refused
 * `ExecutionResult`. `main.test.ts` drives that through a real `SimulatedVenue`
 * and asserts the refusal rather than the exception.
 */
export async function startup(ports: StartupPorts): Promise<number> {
  // --- 1. SAFETY, before anything is read, opened or connected -------------
  const safety = checkPaperTraderSafety(ports.env);
  if (!safety.ok) {
    ports.log(
      "REFUSING TO START: the environment is not safe for a PAPER trader " +
        "(§6 invariant 17, §15, ADR-010 §1). No configuration was read and no " +
        "connection was attempted.",
    );
    for (const violation of safety.violations) {
      ports.log(`  ${violation.code}: ${violation.detail}`);
    }
    return EXIT_CODES.unsafeEnvironment;
  }
  ports.log(`safety: OK — run mode ${safety.runMode}, ceiling PAPER, real orders disabled`);

  // --- 2. the configuration document ---------------------------------------
  const configured = await readConfiguration(ports);
  if (!configured.ok) return configured.code;
  const config = configured.config;
  ports.log(
    `configuration: OK — ${String(config.markets.length)} market(s), ` +
      `${String(config.instances.length)} instance(s), environment ${config.environment}`,
  );
  // `ROLLOVER-1` (ADR-030): the series-bound instances and the series they
  // trade, on a line of their own so the line above reads as it always did.
  if (config.seriesInstances !== undefined || config.series !== undefined) {
    ports.log(
      `configuration: ${String(config.seriesInstances?.length ?? 0)} series-bound instance(s) over ` +
        `${String(config.series?.length ?? 0)} reviewed series; each window is traded only once ` +
        "this trader re-judges its admission against the review its run pins",
    );
  }

  // --- 2b. the health endpoint's bind, before anything is opened -----------
  const healthEnv = readHealthServerEnv(ports.env);
  if (!healthEnv.ok) {
    ports.log(`REFUSING TO START: ${healthEnv.refusal.code}: ${healthEnv.refusal.detail}`);
    for (const issue of healthEnv.refusal.issues) ports.log(`  ${issue}`);
    return EXIT_CODES.configurationRefused;
  }
  const healthListen = healthEnv.listen;
  ports.log(
    healthListen === undefined
      ? "health endpoint: NOT configured (TRADER_HEALTH_BIND and TRADER_HEALTH_PORT are unset); " +
          "no HTTP surface will be bound and a control API's http health source has nothing to read"
      : `health endpoint: will serve GET /health on ${healthListen.host}:${String(healthListen.port)} ` +
          "(loopback only, read only) once the trader is assembled",
  );

  // --- 2c. the Redis outage bound (OUTAGE-1), before anything is opened -----
  const redisBound = readRedisResponseTimeout(ports.env);
  if (!redisBound.ok) {
    ports.log(`REFUSING TO START: ${redisBound.refusal.code}: ${redisBound.refusal.detail}`);
    return EXIT_CODES.configurationRefused;
  }
  const responseTimeoutMs = redisBound.responseTimeoutMs;
  ports.log(
    `event transport bound: every Redis command must answer within ${String(responseTimeoutMs)} ms ` +
      `(${REDIS_RESPONSE_TIMEOUT_ENV}${redisBound.defaulted ? ` unset; the default` : ""}); a Redis ` +
      "outage latches a GLOBAL TRANSPORT_UNAVAILABLE halt within that bound of the first command it " +
      `leaves unanswered, and the process exits ${String(EXIT_CODES.halted)} at most ` +
      `${String(2 * responseTimeoutMs)} ms after the halt (one bound for each connection's courtesy ` +
      "QUIT) plus the durable halt record, the PostgreSQL close and " +
      `${String(PROCESS_EXIT_GRACE_MS)} ms for the process to exit. The record answers within ` +
      `${String(HALT_RECORD_DEADLINE_MS)} ms: at that bound it reports UNCONFIRMED and destroys the ` +
      "connection it holds; a connection the pool is still opening then is ended only by the pool's " +
      `${String(DEFAULT_CONNECTION_TIMEOUT_MS)} ms connection timeout, which the PostgreSQL close waits ` +
      "for. A process that a silent peer still holds open once that grace has passed is exited by " +
      "force, as soon as every line it logged has reached the log (§4.2)",
  );

  // --- 2d. the stop's deadline (TRADER-SIGNALS), before anything is opened ---
  const stopDeadline = readShutdownDeadline(ports.env);
  if (!stopDeadline.ok) {
    ports.log(`REFUSING TO START: ${stopDeadline.refusal.code}: ${stopDeadline.refusal.detail}`);
    return EXIT_CODES.configurationRefused;
  }
  ports.stop?.useDeadline(stopDeadline.deadlineMs);
  ports.log(
    "graceful stop: SIGINT or SIGTERM stops the trader in order — the pump reads no new batch, the batch in " +
      "hand finishes its durable writes, the SHUTDOWN rebuild check runs, every latched halt is recorded and " +
      `everything opened is closed — and it exits ${String(EXIT_CODES.ok)} (${String(EXIT_CODES.halted)} with a ` +
      `halt latched, ${String(EXIT_CODES.shutdownCheckFailed)} if the check fails). A stop not finished within ` +
      `${String(stopDeadline.deadlineMs)} ms (${SHUTDOWN_DEADLINE_ENV}${stopDeadline.defaulted ? " unset; the default" : ""}) ` +
      `exits ${String(EXIT_CODES.shutdownDeadlineExceeded)}, and a second signal exits ` +
      `${String(EXIT_CODES.shutdownForced)} at once`,
  );

  // --- 3. infrastructure ----------------------------------------------------
  const redisUrl = ports.env["REDIS_URL"];
  const postgresUrl = ports.env["DATABASE_URL"];
  if (redisUrl === undefined || redisUrl === "" || postgresUrl === undefined || postgresUrl === "") {
    ports.log(
      "REFUSING TO START: REDIS_URL and DATABASE_URL are both required and neither is " +
        "defaulted. §4.2 makes each of them a trading-halt boundary, and a process that " +
        "guessed an endpoint would be deciding which boundary it was inside.",
    );
    return EXIT_CODES.configurationRefused;
  }

  // `connect` rather than a constructor: the transport validates its settings
  // and opens its connection in one act, so a bad setting is a startup
  // refusal rather than a first-read surprise.
  //
  // CONSUMER ONLY (C1-RISK, OPS-07, 2026-10-08). The transport requires a
  // retention bound and applies it only when it PUBLISHES, which this process
  // never does: the stream's retention is the data gateway's
  // (`GATEWAY_RETENTION_EVENTS`). So the event bus's own ceiling is passed —
  // a number that trims nothing here — and nothing reports it as the stream's
  // retention. The trader's `infrastructure.retentionMaxEvents` knob, which
  // did both, is gone.
  //
  // `OUTAGE-1` (`B1-R1-REDIS-UNCAUGHT`): contained. An unreachable Redis used
  // to escape this function as an uncaught `EventBusUnavailableError`.
  const redisEndpoint = describeEndpoint(redisUrl);
  let transport: RedisStreamsEventTransport;
  try {
    transport = await RedisStreamsEventTransport.connect({
      connection: { url: redisUrl, responseTimeoutMs },
      retention: { maxEvents: MAX_RETENTION_EVENTS },
    });
  } catch (cause) {
    if (cause instanceof EventBusConfigurationError) {
      ports.log(
        `REFUSING TO START: TRADER_REDIS_URL_REFUSED: the event transport refused its settings ` +
          `(REDIS_URL ${redisEndpoint}); nothing was connected`,
      );
      ports.log(`  ${describeError(cause)}`);
      return EXIT_CODES.configurationRefused;
    }
    ports.log(
      `REFUSING TO START: TRADER_REDIS_UNAVAILABLE: the event transport (Redis) at ` +
        `${redisEndpoint} could not be reached. §4.2 makes Redis a trading-halt boundary, so ` +
        "the process refuses rather than starts without it (fail closed). No database connection " +
        "was opened and no row was read",
    );
    ports.log(`  ${describeError(cause)}`);
    return EXIT_CODES.infrastructureUnavailable;
  }
  ports.log(`event transport: connected to ${redisEndpoint}`);

  // --- 3b + 4. the durable store, the registration check, the venue, the root
  const assembled = await assembleDurableTrader({
    env: ports.env,
    config,
    document: configured.document,
    postgresUrl,
    clock: new SystemPaperClock(),
    log: ports.log,
    ...(healthListen === undefined ? {} : { healthListen }),
  });
  if (!assembled.ok) {
    await transport.close();
    return assembled.code;
  }
  const { store, trader, healthServer } = assembled;

  // --- 5. the pump ----------------------------------------------------------
  // `OUTAGE-1`: the subscription is Redis too, and is contained the same way.
  // A refusal here closes everything opened above before it returns.
  let subscription: EventSubscription<unknown>;
  try {
    subscription = await transport.subscribe({
      stream: config.infrastructure.eventStream,
      consumerId: config.infrastructure.consumerId,
    });
  } catch (cause) {
    const unavailable = cause instanceof EventBusUnavailableError;
    ports.log(
      unavailable
        ? `REFUSING TO START: TRADER_REDIS_UNAVAILABLE: the event transport (Redis) at ` +
            `${redisEndpoint} stopped answering while the subscription to ` +
            `${config.infrastructure.eventStream} was opened (§4.2, fail closed); nothing was ` +
            "consumed and no decision was made"
        : `REFUSING TO START: TRADER_EVENT_SUBSCRIPTION_REFUSED: the event transport refused the ` +
            `subscription of consumer ${config.infrastructure.consumerId} to ` +
            `${config.infrastructure.eventStream} (for example a stored position it cannot resume ` +
            "from, which ADR-003 §3.3/§3.4 make a refusal rather than a reposition); nothing was " +
            "consumed and no decision was made",
    );
    ports.log(`  ${describeError(cause)}`);
    await healthServer?.close();
    await store.close();
    await transport.close();
    return unavailable ? EXIT_CODES.infrastructureUnavailable : EXIT_CODES.configurationRefused;
  }
  const feed = new RedisMarketEventFeed({
    subscription,
    maxEvents: config.infrastructure.receiveBatchSize,
  });
  // `THROUGHPUT-1a`: the stream-side lag on the health surface (`transport`),
  // sampled off the pump's path at a bounded cadence (`transport-lag.ts`).
  const transportLag = new TransportLagSampler({ subscription });
  trader.health.attachTransport(transportLag);
  transportLag.start();
  ports.log(
    `transport lag: the stream head and this consumer's position are sampled every ` +
      `${String(transportLag.intervalMs)} ms from the subscription's own metrics, off the pump's ` +
      "path; the health endpoint reports them with the event-time lag under `transport`",
  );

  // --- 5 to 5d. the pump, until a halt or a requested stop, then the stop --
  return await runUntilStopped({
    trader,
    config,
    // In the order startup opened them; they are closed in the reverse order.
    opened: { transport, store, healthServer, feed, transportLag },
    log: ports.log,
    ...(ports.stop === undefined ? {} : { stop: ports.stop }),
  });
}

/**
 * What `startup()` opened before the pump, named in the order it opened them
 * (`TRADER-SIGNALS`). {@link runUntilStopped} closes them in the reverse
 * order. Each is the narrowest surface the stop uses, so a test can hand in
 * recording fakes.
 */
export interface OpenedResources {
  /** 1 (step 3). The event transport's Redis connection. */
  readonly transport: { close(): Promise<void> };
  /** 2 (step 3b). The durable store, which owns the PostgreSQL pool and writes the halt record. */
  readonly store: Pick<PostgresTraderStore, "recordHalts" | "close">;
  /** 3 (step 4b). The health endpoint's listener, when one was configured. */
  readonly healthServer: Pick<RunningTraderHealthServer, "close"> | undefined;
  /** 4 (step 5). The feed the pump reads, which owns the subscription's Redis connection. */
  readonly feed: MarketEventFeed;
  /** 5 (step 5). The transport-lag sampler's timer. */
  readonly transportLag: Pick<TransportLagSampler, "stop">;
}

export interface RunUntilStoppedOptions {
  readonly trader: Pick<PaperTrader, "loop" | "halts">;
  /** What the halt record names: the account and every instance. */
  readonly config: Pick<TraderConfig, "accounting" | "instances" | "seriesInstances">;
  readonly opened: OpenedResources;
  readonly log: (line: string) => void;
  /** The stop SIGINT and SIGTERM request; absent, the pump runs until a halt. */
  readonly stop?: StopRequest;
}

/**
 * Steps 5 to 5d: the pump, until a halt latches or a stop is requested; then
 * the SHUTDOWN rebuild check, the halt record and the closes; then the exit
 * code. The SAME sequence whatever stopped the pump (`TRADER-SIGNALS`; see
 * the module header). Never throws: a close that throws is logged and the
 * next close still runs.
 *
 * It tells `stop` which phase it is in, so a forced or late exit can say
 * where the stop was (`graceful-stop.ts`).
 */
export async function runUntilStopped(options: RunUntilStoppedOptions): Promise<number> {
  const { trader, config, opened, log, stop } = options;

  // --- 5. the pump ----------------------------------------------------------
  stop?.watchHalts(() => trader.halts.records().map((halt) => `${halt.scope.kind} ${halt.code}`));
  stop?.enter("PUMP");
  const result = await pump({
    loop: trader.loop,
    feed: opened.feed,
    halts: trader.halts,
    maxPolls: Number.MAX_SAFE_INTEGER,
    ...(stop === undefined ? {} : { stopRequested: () => stop.signal !== undefined }),
  });

  // --- 5b. `FOLD-1` (user ruling F2): the SHUTDOWN rebuild check. The loop's
  // held ledger view is compared with `projectLedger(ledger)` on serialized
  // bytes (it also ran every 50 posted fills). A mismatch latches a GLOBAL
  // `ACCOUNTING_REBUILD_MISMATCH` halt — logged below with every other halt —
  // and the process exits `shutdownCheckFailed`, never `ok`.
  const rebuild = trader.loop.checkAccountingRebuild("SHUTDOWN");
  const health = trader.loop.health();
  log(pumpStoppedLine(result, stop?.signal));
  log(
    rebuild.matched
      ? "accounting rebuild check at shutdown: the held ledger view equals its rebuild from zero"
      : "accounting rebuild check at shutdown: MISMATCH — the held accounting state differs from " +
          "its rebuild from zero (see the ACCOUNTING_REBUILD_MISMATCH halt)",
  );
  for (const halt of health.halts) {
    log(`HALT ${halt.scope.kind} ${halt.code}: ${halt.detail}`);
  }
  log(`health: ${JSON.stringify(health)}`);
  // `C1-HALTS` (BOOK-WAITS): per market, the book refusals counted (benign)
  // or waited out (divergence), and the books still waiting for a snapshot.
  log(`book refusals: ${JSON.stringify(trader.loop.bookRefusals())}`);

  // --- 5c. `PROVENANCE-1` (`OUT1-R1-HALT-NOT-DURABLE`): every latched halt,
  // written to `ops.incidents` BEFORE anything is closed, bounded, and never
  // changing the exit code below (`halt-record.ts`).
  stop?.enter("HALT_RECORD");
  await recordHaltsBeforeExit({
    halts: health.halts,
    config,
    write: (rows, deadlineMs) => opened.store.recordHalts(rows, deadlineMs),
    log,
  });

  // --- 5d. the closes, in the REVERSE order of opening (`TRADER-SIGNALS`).
  const failedCloses: string[] = [];
  const close = async (what: string, act: () => Promise<void> | void): Promise<void> => {
    stop?.enter("CLOSING", what);
    try {
      await act();
    } catch (cause) {
      failedCloses.push(what);
      log(`CLOSE FAILED: ${what}: ${describeError(cause)}; the stop goes on to the next close`);
    }
  };
  await close("the transport-lag sampler", () => {
    opened.transportLag.stop();
  });
  await close("the event subscription", () => opened.feed.close());
  const healthServer = opened.healthServer;
  if (healthServer !== undefined) await close("the health endpoint", () => healthServer.close());
  await close("the PostgreSQL pool", () => opened.store.close());
  await close("the Redis transport", () => opened.transport.close());

  // A halt latched after the snapshot above (the pool's error handler can
  // latch one while it closes) was not in the record; it still decides the
  // exit, and is logged here so it is not silent.
  const latched = trader.halts.records();
  const recorded = new Set(health.halts.map(haltIdentity));
  for (const halt of latched) {
    if (recorded.has(haltIdentity(halt))) continue;
    log(
      `HALT ${halt.scope.kind} ${halt.code}: ${halt.detail} ` +
        "(latched during the stop, after the halt record was written; it is not in ops.incidents)",
    );
  }
  const code = exitCodeAfterStop({
    pumpStopped: result.stopped,
    rebuildMatched: rebuild.matched,
    haltsLatched: latched.length,
  });
  log(traderStoppedLine(code, { signal: stop?.signal, haltsLatched: latched.length, failedCloses }));
  return code;
}

/**
 * The exit code once the pump has stopped and the stop has run
 * (`TRADER-SIGNALS`): {@link EXIT_CODES.shutdownCheckFailed} over
 * {@link EXIT_CODES.halted} over {@link EXIT_CODES.ok}. FAIL CLOSED: `ok`
 * needs the check to have matched AND no halt latched AND the pump not to
 * have stopped on a halt; a requested stop clears nothing.
 */
export function exitCodeAfterStop(outcome: {
  readonly pumpStopped: PumpResult["stopped"];
  readonly rebuildMatched: boolean;
  readonly haltsLatched: number;
}): number {
  if (!outcome.rebuildMatched) return EXIT_CODES.shutdownCheckFailed;
  if (outcome.pumpStopped === "HALTED" || outcome.haltsLatched > 0) return EXIT_CODES.halted;
  return EXIT_CODES.ok;
}

/** One latched halt, by value: the controller keeps one record per scope. */
function haltIdentity(halt: { readonly scope: unknown; readonly code: string }): string {
  return JSON.stringify([halt.scope, halt.code]);
}

/** `pump stopped: …`, as before for a halt; with what the stop did for a requested one. */
function pumpStoppedLine(result: PumpResult, signal: StopSignal | undefined): string {
  const line = `pump stopped: ${result.stopped} after ${String(result.polls)} poll(s)`;
  if (result.stopped !== "STOPPED") return line;
  return (
    `${line}, ${String(result.ingested)} event(s) ingested: ${signal ?? "a stop"} was requested, so no batch ` +
    "was read after it, and the batch in hand finished its durable writes and recorded its position first"
  );
}

/** The stop's last line: the exit code, and why. Exported for its test. */
export function traderStoppedLine(
  code: number,
  context: { readonly signal: StopSignal | undefined; readonly haltsLatched: number; readonly failedCloses: readonly string[] },
): string {
  const closes =
    context.failedCloses.length === 0
      ? "everything opened was closed"
      : `${String(context.failedCloses.length)} close(s) failed (${context.failedCloses.join(", ")}; logged above)`;
  switch (code) {
    case EXIT_CODES.ok:
      return (
        `trader stopped: exit ${String(code)} — a clean stop${context.signal === undefined ? "" : ` on ${context.signal}`}: ` +
        `no halt is latched and the SHUTDOWN rebuild check matched; ${closes}`
      );
    case EXIT_CODES.shutdownCheckFailed:
      return (
        `trader stopped: exit ${String(code)} — the SHUTDOWN rebuild check FAILED (ACCOUNTING_REBUILD_MISMATCH, ` +
        "§6 invariant 8): the held accounting state differs from its rebuild from zero, so this run's accounting " +
        `is not to be trusted; ${String(context.haltsLatched)} halt(s) latched in all; ${closes}`
      );
    default:
      return (
        `trader stopped: exit ${String(code)} — halted: ${String(context.haltsLatched)} halt(s) latched (the HALT ` +
        `lines above)${context.signal === undefined ? "" : `; the stop ${context.signal} requested clears no halt, so this is not a clean stop`}; ${closes}`
      );
  }
}

export interface DurableTraderOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The configuration, already through its door (`readConfiguration`). */
  readonly config: TraderConfig;
  /** The same configuration, unparsed — `createPaperTrader` runs the door itself. */
  readonly document: unknown;
  /** `DATABASE_URL`. The pool is built here, exactly as the process builds it. */
  readonly postgresUrl: string;
  /** The §12.1 clock: {@link SystemPaperClock} for the process, a port for a test. */
  readonly clock: Clock;
  readonly log: (line: string) => void;
  /**
   * Where the health endpoint listens, as {@link readHealthServerEnv} accepted
   * it. Absent means no endpoint (`TRDR-3`).
   */
  readonly healthListen?: HealthListen;
}

export type DurableTraderResult =
  | {
      readonly ok: true;
      readonly trader: PaperTrader;
      /** The store the trader writes through. The caller closes it. */
      readonly store: PostgresTraderStore;
      /** The health endpoint, when one was asked for. The caller closes it. */
      readonly healthServer: RunningTraderHealthServer | undefined;
    }
  | { readonly ok: false; readonly code: number };

/**
 * Steps 3b and 4 of the startup sequence: the durable store, the `BOOT-1`
 * registration check, the simulated venue and the composition root. Never
 * throws; a refusal is a logged list and an {@link EXIT_CODES} value.
 *
 * Called by {@link startup} with the process's clock and by the Testcontainers
 * acceptance test with a real database, so the path a test proves survives
 * its first fill is the path the process runs (see the module header).
 *
 * OWNERSHIP. This function opens the database handle from `postgresUrl` and
 * hands it back inside `store` on success; on a refusal it closes what it
 * opened before returning, so a caller that receives `ok: false` holds nothing.
 *
 * THE ORDER IS THE POINT. The safety posture is checked FIRST, in this
 * function, before a pool exists — not only in `startup`. The first round of
 * `BOOT-1` relied on `startup()` having run `checkPaperTraderSafety` before
 * calling here, and the adversarial review (R4) measured what that was worth
 * for the EXPORTED seam: with `MAX_RUN_MODE=LIVE, RUN_MODE=LIVE,
 * ALLOW_REAL_ORDERS=true` against an unseeded database, this function logged
 * `TRADER_REGISTRATION_MISSING` — the `select`s had run — rather than refusing
 * the environment. The module header's own principle ("a process that had
 * already connected to something would have moved before the validation it is
 * subject to") therefore applies to every caller of this function, and the
 * check is pure and cheap, so it runs here too; `createPaperTrader` runs it a
 * third time on the same record. Then the registration check runs BEFORE the
 * venue and the trader exist — nothing that could write has been constructed
 * when the database is asked whether the writes would land.
 */
export async function assembleDurableTrader(
  options: DurableTraderOptions,
): Promise<DurableTraderResult> {
  const { config, log } = options;

  // --- 1 (again). SAFETY, before a pool exists (BOOT-1 r1, review R4) ------
  const safety = checkPaperTraderSafety(options.env);
  if (!safety.ok) {
    log(
      "REFUSING TO START: TRADER_UNSAFE_ENVIRONMENT: the environment is not safe for a PAPER " +
        "trader (§6 invariant 17, §15, ADR-010 §1); no database connection was attempted " +
        "and no row was read",
    );
    for (const violation of safety.violations) log(`  ${violation.code}: ${violation.detail}`);
    return { ok: false, code: EXIT_CODES.unsafeEnvironment };
  }

  const pool = createPostgresPool({ connectionString: options.postgresUrl });
  // `PROVENANCE-1`: node-postgres re-emits an IDLE pooled connection's error
  // (the server terminated it: a restart, `pg_terminate_backend`, a dropped
  // link) on the pool, and an 'error' event nobody listens to is an uncaught
  // exception — measured: the process died with exit 1, before any halt was
  // latched or logged. It is a PostgreSQL outage (§4.2), so once the trader
  // exists it latches GLOBAL `STORE_UNAVAILABLE` like any failed write, the
  // pump stops, and the process exits `halted` (75) after trying to record
  // the halt. Before the trader exists it is logged; the registration check's
  // own query then meets the outage and refuses.
  let onPoolError = (error: Error): void => {
    log(`STORE CONNECTION LOST before the trader was assembled: ${describeError(error)}`);
  };
  pool.on("error", (error: Error) => {
    onPoolError(error);
  });
  const database = createDatabase(pool);
  const store = new PostgresTraderStore({
    db: database,
    // §7.5's contract version, as `strategy.definitions` pins it.
    decisionContractVersion: 1,
    // `PROVENANCE-1`: the account its `ops.risk_events` rows name.
    accountRef: config.accounting.accountRef,
    // `PROVENANCE-1` r1 (`PROV1-R1-02`): the halt record checks its one
    // connection out of the pool itself, so it can destroy it at its bound.
    pool,
  });
  // The realized-PnL book the health surface reads (`TRDR-3`): every PnL
  // snapshot the store ACCEPTS is recorded here by the decorator the trader is
  // handed below, and the book is attached to the health state once the
  // trader exists. `store` itself stays the handle the caller closes.
  const realizedPnl = new RealizedPnlBook();
  const observedStore = observeRealizedPnl(store, realizedPnl);

  // --- 3b. the registration check (BOOT-1) ---------------------------------
  const registered = await verifyRegisteredRows(database, config);
  if (!registered.ok) {
    log(`REFUSING TO START: ${registered.refusal.code}: ${registered.refusal.detail}`);
    for (const issue of registered.refusal.issues) log(`  ${issue}`);
    await store.close();
    return {
      ok: false,
      code:
        registered.refusal.code === "TRADER_REGISTRATION_UNREADABLE"
          ? EXIT_CODES.infrastructureUnavailable
          : EXIT_CODES.configurationRefused,
    };
  }
  log(
    `registration: OK — ${String(config.markets.length)} market(s), ` +
      `${String(config.instances.length + (config.seriesInstances?.length ?? 0))} instance(s) and their run(s) exist and agree with ` +
      "the configuration",
  );
  // `C1-HALTS` (TAINT): the feed whose market-less incidents switch the
  // CONNECTION_CONFIRMED extension off for an epoch (ADR-023 rule 4).
  log(
    bookFreshnessBasisOf(config) === "CONNECTION_CONFIRMED"
      ? `book freshness: CONNECTION_CONFIRMED; a market-less incident from feed ` +
          `${JSON.stringify(marketChannelFeedIdOf(config))} (or from no feed) taints its gateway epoch — it must ` +
          "be the data gateway's polymarket.feedId"
      : "book freshness: LAST_CHANGE",
  );

  // The simulated venue, built by the core's ONE venue builder (`BACKTEST-2`,
  // ADR-022 D5) — the construction that used to stand here, moved, so the
  // backtest executable and every test harness build exactly this venue. It
  // is built against a HOLDER (`built.wiring`) the trader fills the instant it
  // exists; see the module header for why the venue may not answer either
  // question itself.
  const built = buildSimulatedVenue({
    clock: options.clock,
    settings: config.simulation,
    log,
  });
  if (!built.ok) {
    log(
      `REFUSING TO START: the configured fee snapshot was refused by the simulator ` +
        `(${built.refusal.code}: ${built.refusal.message}); a run without a valid fee snapshot ` +
        "cannot charge a fee (§6 invariant 9)",
    );
    await store.close();
    return { ok: false, code: EXIT_CODES.configurationRefused };
  }
  const { venue, wiring } = built;

  // --- 4. the composition root ---------------------------------------------
  // `venue` is handed over UNCAST (`BOOT-1`): `TRDR-2` measured that
  // `SimulatedVenue` satisfies the `TraderVenue` port as written, and registered
  // the `as unknown as` this line used to carry only because `main.ts` was
  // outside its grant. The compiler now checks the seam, so the first drift
  // between the venue and the port is a typecheck failure rather than silence.
  const created = createPaperTrader({
    env: options.env,
    config: options.document,
    clock: options.clock,
    venue,
    store: observedStore,
    // `ROLLOVER-1`: every run this process executes, series-bound ones included.
    idNamespace: [...config.instances, ...(config.seriesInstances ?? [])].map((instance) => instance.runId).join("|"),
    // `CADENCE-1` (ADR-026 D1.4-D1.5): exactly the cadence step 3b verified
    // every configured run's `strategy.runs` row pins. Never a reproduction.
    evaluationCadence: PAPER_EVALUATION_CADENCE,
    onCadenceAlarm: (alarm) => {
      log(cadenceAlarmLine(alarm));
    },
    // `ROLLOVER-1` (ADR-030): every series-window admission, refusal and
    // teardown is an operator line.
    onAdmission: (notice) => {
      log(admissionLine(notice));
    },
  });
  if (!created.ok) {
    log(`REFUSING TO START: ${created.refusal.code}: ${created.refusal.detail}`);
    for (const issue of created.refusal.issues) log(`  ${issue}`);
    await store.close();
    return { ok: false, code: EXIT_CODES.configurationRefused };
  }
  wiring.trader = created.trader;
  onPoolError = (error) => {
    const detail =
      `the PostgreSQL connection pool lost an idle connection (${describeError(error)}); §4.2 makes a ` +
      "PostgreSQL outage a trading halt — no decision may be made while the durable store may be unreachable";
    log(`STORE CONNECTION LOST: ${detail}`);
    created.trader.halts.halt({ kind: "GLOBAL" }, "STORE_UNAVAILABLE", detail, created.trader.loop.health().asOf);
  };
  created.trader.health.attachRealizedPnl(realizedPnl);
  for (const row of created.trader.manifest) {
    log(
      `manifest: ${String(row.position)} ${row.instanceId} ${row.ownership} ` +
        `priority=${String(row.evaluationPriority)} market=${row.marketId}`,
    );
  }

  // --- 4b. the health endpoint, last: nothing listens until the process has
  // proven it may run, and nothing it serves exists before this line.
  let healthServer: RunningTraderHealthServer | undefined;
  if (options.healthListen !== undefined) {
    try {
      healthServer = await startTraderHealthServer({
        listen: options.healthListen,
        snapshot: () => created.trader.loop.health(),
        log,
      });
    } catch (cause) {
      log(
        "REFUSING TO START: TRADER_HEALTH_LISTEN_FAILED: the health endpoint could not bind " +
          `${options.healthListen.host}:${String(options.healthListen.port)} ` +
          `(${cause instanceof Error ? cause.message : String(cause)}); a configured endpoint ` +
          "that cannot listen is a configuration this process refuses rather than a feature it drops",
      );
      await store.close();
      return { ok: false, code: EXIT_CODES.configurationRefused };
    }
    log(
      `health endpoint: listening on ${healthServer.url} — GET only, loopback only, no mutation; ` +
        "point a control API's traderHealth.http at this URL",
    );
  }
  // `C1-HALTS` (HALT-PAGES): the run has started — every refusal above has
  // passed — and it is a new run of each instance (BOOT-1), so it supersedes
  // their earlier infrastructure halt rows. Never refuses the start.
  await resolveSupersededHalts(
    database,
    [...config.instances, ...(config.seriesInstances ?? [])].map((instance) => ({
      instanceId: instance.instanceId,
      runId: instance.runId,
    })),
    log,
  );
  return { ok: true, trader: created.trader, store, healthServer };
}

/**
 * `CADENCE-1` (ADR-026 D2.10): the log line for a forward-jump alarm episode.
 * A `RAISED` line is the PAGE line (`CADENCE CLOCK FORWARD JUMP:`); the
 * `CLEARED` line says the episode ended. Exported for its test.
 */
export function cadenceAlarmLine(alarm: CadenceAlarm): string {
  if (alarm.kind === "RAISED") {
    return (
      `CADENCE CLOCK FORWARD JUMP: an applied event stamped ${alarm.eventAt} lies ${String(alarm.behindMs)} ms ` +
      `behind the evaluation cadence's event clock (${alarm.clockAt}), beyond the ${String(alarm.boundMs)} ms ` +
      "alarm bound. No market's onFeatures is evaluated — so no stop decided in onFeatures runs — until event " +
      "time has moved past that clock by the interval; fills, order updates and lifecycle callbacks still " +
      "fire (ADR-026 D2.10). Page: check the gateway's receipt clock"
    );
  }
  return (
    `CADENCE CLOCK CAUGHT UP: an applied event stamped ${alarm.eventAt} lies ${String(alarm.behindMs)} ms ` +
    `behind the evaluation cadence's event clock (${alarm.clockAt}), within the ${String(alarm.boundMs)} ms ` +
    "alarm bound; the forward-jump alarm episode has ended (ADR-026 D2.10)"
  );
}

/** The environment variable that states the Redis outage bound (`OUTAGE-1`). */
export const REDIS_RESPONSE_TIMEOUT_ENV = "TRADER_REDIS_RESPONSE_TIMEOUT_MS";

/**
 * The accepted range for {@link REDIS_RESPONSE_TIMEOUT_ENV}, in milliseconds.
 *
 * The floor keeps a garbage-collection pause from reading as an outage. The
 * ceiling keeps the bound in seconds: a process that waits a minute on a dead
 * transport has spent that minute looking alive while deciding nothing.
 */
export const REDIS_RESPONSE_TIMEOUT_RANGE = Object.freeze({ minimumMs: 100, maximumMs: 60_000 });

export type RedisResponseTimeoutResult =
  | {
      readonly ok: true;
      readonly responseTimeoutMs: number;
      /** `true` when the variable was unset and the transport's default applies. */
      readonly defaulted: boolean;
    }
  | {
      readonly ok: false;
      readonly refusal: { readonly code: "TRADER_REDIS_RESPONSE_TIMEOUT_REFUSED"; readonly detail: string };
    };

/**
 * Reads {@link REDIS_RESPONSE_TIMEOUT_ENV}. TOTAL: never throws.
 *
 * Unset (or empty) is the transport's own default, `DEFAULT_RESPONSE_TIMEOUT_MS`
 * (5000), so the process never runs WITHOUT a bound. A set value must be a
 * canonical decimal integer inside {@link REDIS_RESPONSE_TIMEOUT_RANGE}.
 * Anything else is refused rather than clamped, because a clamped bound is one
 * nobody chose. Read as an OWN property only, as `health-server.ts` reads its
 * variables.
 */
export function readRedisResponseTimeout(
  env: Readonly<Record<string, string | undefined>>,
): RedisResponseTimeoutResult {
  const descriptor = Object.hasOwn(env, REDIS_RESPONSE_TIMEOUT_ENV)
    ? Object.getOwnPropertyDescriptor(env, REDIS_RESPONSE_TIMEOUT_ENV)
    : undefined;
  const raw: unknown = descriptor?.value;
  if (raw === undefined || raw === "") {
    return { ok: true, responseTimeoutMs: DEFAULT_RESPONSE_TIMEOUT_MS, defaulted: true };
  }
  const { minimumMs, maximumMs } = REDIS_RESPONSE_TIMEOUT_RANGE;
  const value = typeof raw === "string" && /^[1-9]\d{0,5}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= minimumMs && value <= maximumMs)) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_REDIS_RESPONSE_TIMEOUT_REFUSED",
        detail:
          `${REDIS_RESPONSE_TIMEOUT_ENV}=${typeof raw === "string" ? JSON.stringify(raw) : typeof raw} ` +
          `is not an integer number of milliseconds in [${String(minimumMs)}, ${String(maximumMs)}]; ` +
          "it bounds how long the process may wait on an unanswering Redis before it halts (§4.2), " +
          "and a bound the operator did not state correctly is refused rather than guessed",
      },
    };
  }
  return { ok: true, responseTimeoutMs: value, defaulted: false };
}

/**
 * A connection URL as `scheme://host:port`, for a log line.
 *
 * Never the userinfo: a `REDIS_URL` may carry an account and a secret, and a
 * refusal an operator pastes into a ticket must not carry either.
 */
function describeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "(a value that is not a URL)";
  }
}

/** An error and its cause chain, one line, bounded (a cyclic chain cannot grow it). */
function describeError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const own = `${error.name}: ${error.message}`;
  if (error.cause === undefined || depth >= 2) return own;
  return `${own}; caused by ${describeError(error.cause, depth + 1)}`;
}

type ReadConfigurationResult =
  | { readonly ok: true; readonly config: TraderConfig; readonly document: unknown }
  | { readonly ok: false; readonly code: number };

async function readConfiguration(ports: StartupPorts): Promise<ReadConfigurationResult> {
  const path = ports.env["TRADER_CONFIG_PATH"];
  if (path === undefined || path === "") {
    ports.log(
      "REFUSING TO START: TRADER_CONFIG_PATH names the operator configuration document and " +
        "has no default — every setting in it is required, and a defaulted safety bound is a " +
        "bound nobody chose.",
    );
    return { ok: false, code: EXIT_CODES.configurationRefused };
  }
  let text: string;
  try {
    text = await ports.readConfig(path);
  } catch (cause) {
    ports.log(
      `REFUSING TO START: the configuration at ${path} could not be read ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
    return { ok: false, code: EXIT_CODES.configurationRefused };
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (cause) {
    ports.log(
      `REFUSING TO START: the configuration at ${path} is not JSON ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
    return { ok: false, code: EXIT_CODES.configurationRefused };
  }
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) {
    ports.log(`REFUSING TO START: ${parsed.refusal.code}: ${parsed.refusal.detail}`);
    for (const issue of parsed.refusal.issues) ports.log(`  ${issue}`);
    return { ok: false, code: EXIT_CODES.configurationRefused };
  }
  return { ok: true, config: parsed.config, document };
}

/**
 * The §12.1 `Clock` for a LIVE paper run.
 *
 * A `PAPER` run consumes live data (§11), so its clock is the host's — and that
 * is exactly why the clock is a PORT: the same loop under `BACKTEST` takes
 * `packages/simulation`'s `ReplayClock` instead and becomes byte-deterministic
 * without a line changing above it (§12.1, §12.4).
 *
 * `now()` answers the canonical strict-UTC form the strategy requires
 * (`time.ts`), so no conversion happens downstream.
 */
export class SystemPaperClock implements Clock {
  now(): string {
    return new Date().toISOString().replace(/\.000Z$/u, "Z");
  }

  monotonicNs(): bigint {
    return process.hrtime.bigint();
  }
}

/* c8 ignore start — the process shell, exercised by running the process. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith("/main.mjs");
if (invokedDirectly) {
  // `TRADER-SIGNALS` (step 0): SIGINT and SIGTERM request a graceful stop from
  // here on, instead of ending the process (`graceful-stop.ts`). Installed
  // before `startup()` reads anything; it reads and opens nothing itself.
  const stop = installGracefulStop(gracefulStopPorts(process));
  const code = await startup({
    env: process.env,
    readConfig: async (path) => await readFile(path, "utf8"),
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
    stop,
  });
  // `TC-LOWS-1` (`PROV1-R2-L2`): the process EXITS with that code within a
  // bound, even when a peer that never answers holds a socket open, and never
  // ahead of a line already logged (`process-exit.ts`; see "The process exit"
  // above). `process` is handed over here, the one file that touches it.
  // `TRADER-SIGNALS`: `finish` cancels the stop's deadline and hands the
  // signals back to Node; it answers `false` only when a forced exit (130 or
  // 124) is already under way, which then exits on its own.
  if (stop.finish()) exitAfterStartup(code, processExitPorts(process));
}
/* c8 ignore stop */

/**
 * `ROLLOVER-1`: one operator line per series-window admission, refusal or
 * teardown (ADR-030). A refusal is the trader's own re-judge saying no: the
 * window is not traded (fail closed), and the line names why.
 */
export function admissionLine(notice: AdmissionNotice): string {
  switch (notice.kind) {
    case "ADMITTED":
      return (
        `[admission] ADMITTED window ${notice.window.marketId} of ${notice.window.seriesId} ` +
        `(${notice.window.windowTitle}; ${notice.window.openAt}..${notice.window.closeAt}; tick ${notice.window.tickSize})`
      );
    case "REFUSED":
      return `[admission] REFUSED ${notice.code} window ${notice.marketId ?? "(unidentified)"}: ${notice.detail}`;
    case "TORN_DOWN":
      return notice.reason === "RESOLVED_UNHANDLED"
        ? `[admission] TORN DOWN window ${notice.window.marketId} (${notice.reason}): it resolved, but its onMarketResolved was suppressed by a halt or skipped for an instance, so the resolution was NOT handled by its strategy; its ledger rows stay`
        : `[admission] TORN DOWN window ${notice.window.marketId} (${notice.reason}); its ledger rows stay`;
    case "HELD_UNRESOLVED":
      return (
        `[admission] HELD window ${notice.window.marketId}: unresolved ${String(notice.window.unresolvedTeardownSeconds)} s ` +
        `after its close ${notice.window.closeAt} and it still holds inventory, so it is kept until its resolution is handled (ADR-030 Decision 4.4); ` +
        `it keeps its cap slot meanwhile (Decision 1.8), so its series admits no window in its place. ` +
        `If its resolution never reached the gateway, the gateway's operator retirement frees the gateway's slot, not this one: a new run does`
      );
  }
}
