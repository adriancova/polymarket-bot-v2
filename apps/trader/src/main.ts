/**
 * The paper trader's process entry point.
 *
 * This is the ONLY file in the package that touches `process` — the
 * environment, the exit code, the signal handlers. Everything else takes what
 * it needs as an argument, which is what makes the whole system testable
 * without an ambient environment and what keeps §6 invariant 17's check
 * (`safety.ts`) a pure function of a record.
 *
 * ## The startup sequence, and why nothing may move ahead of step 1
 *
 * ```text
 * 1. checkPaperTraderSafety(env)        ← §6 invariant 17, §15, ADR-010
 * 2. read and parse the configuration    ← ADR-020 D1-D4
 * 2b. readHealthServerEnv(env)           ← TRDR-3: loopback-only, or no endpoint, stated
 * 2c. readRedisResponseTimeout(env)      ← OUTAGE-1: the Redis outage bound, stated
 * 3. construct the infrastructure        ← Redis (refused with 69 if unreachable), PostgreSQL
 * 3b. verifyRegisteredRows(db, config)   ← BOOT-1: the rows every durable write references
 * 4. the simulated venue, then
 *    createPaperTrader(...)              ← the composition root
 * 4b. startTraderHealthServer(...)       ← TRDR-3: GET /health over the loopback, if configured
 * 5. pump                                ← §8.1's outer loop
 * 5b. checkAccountingRebuild("SHUTDOWN") ← FOLD-1: §6 invariant 8's rebuild, run once the pump stops
 * 5c. recordHaltsBeforeExit(...)         ← PROVENANCE-1: every latched halt to ops.incidents, bounded
 * ```
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
 * PostgreSQL close that follows does not wait on it. Nothing trades after the
 * halt either way; the record is for the operator and the research worker
 * afterwards.
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
  RedisStreamsEventTransport,
  type EventSubscription,
} from "@polymarket-bot/event-bus";
import { createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";

import { verifyRegisteredRows } from "./adapters/postgres-registration.js";
import { PostgresTraderStore } from "./adapters/postgres-store.js";
import { RedisMarketEventFeed } from "./adapters/redis-feed.js";
import { parseTraderConfig, type TraderConfig } from "@polymarket-bot/trading-core";
import { RealizedPnlBook } from "@polymarket-bot/trading-core";
import {
  readHealthServerEnv,
  startTraderHealthServer,
  type HealthListen,
  type RunningTraderHealthServer,
} from "./health-server.js";
import { HALT_RECORD_DEADLINE_MS, recordHaltsBeforeExit } from "./halt-record.js";
import { observeRealizedPnl } from "./pnl-observation.js";
import type { Clock } from "@polymarket-bot/trading-core";
import { pump } from "./pump.js";
import { TransportLagSampler } from "./transport-lag.js";
import { checkPaperTraderSafety } from "@polymarket-bot/trading-core";
import { createPaperTrader, type PaperTrader } from "@polymarket-bot/trading-core";
import { createExecutionPolicy, type VenueWiring } from "@polymarket-bot/trading-core";
import { buildSimulatedVenue } from "@polymarket-bot/trading-core";

export { createExecutionPolicy, type VenueWiring };

/** What the process exits with, so an operator can script against it. */
export const EXIT_CODES = Object.freeze({
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
});

export interface StartupPorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readConfig: (path: string) => Promise<string>;
  readonly log: (line: string) => void;
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
      `QUIT) plus the durable halt record (at most ${String(HALT_RECORD_DEADLINE_MS)} ms; a connection ` +
      "that has not answered by then is destroyed) and the PostgreSQL close (§4.2)",
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

  // `connect` rather than a constructor: the transport validates its retention
  // bound and opens its connection in one act, so a bad bound is a startup
  // refusal rather than a first-publish surprise (ADR-003: "Retention size is a
  // safety parameter, not a tuning knob").
  //
  // `OUTAGE-1` (`B1-R1-REDIS-UNCAUGHT`): contained. An unreachable Redis used
  // to escape this function as an uncaught `EventBusUnavailableError`.
  const redisEndpoint = describeEndpoint(redisUrl);
  let transport: RedisStreamsEventTransport;
  try {
    transport = await RedisStreamsEventTransport.connect({
      connection: { url: redisUrl, responseTimeoutMs },
      retention: { maxEvents: config.infrastructure.retentionMaxEvents },
    });
  } catch (cause) {
    if (cause instanceof EventBusConfigurationError) {
      ports.log(
        `REFUSING TO START: TRADER_REDIS_URL_REFUSED: the event transport refused its settings ` +
          `(REDIS_URL ${redisEndpoint}, retentionMaxEvents ` +
          `${String(config.infrastructure.retentionMaxEvents)}); nothing was connected`,
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

  const result = await pump({
    loop: trader.loop,
    feed,
    halts: trader.halts,
    maxPolls: Number.MAX_SAFE_INTEGER,
  });

  // `FOLD-1` (user ruling F2): the SHUTDOWN rebuild check. The loop's held
  // ledger view is compared with `projectLedger(ledger)` on serialized bytes
  // (it also ran every 50 posted fills). A mismatch latches a GLOBAL
  // `ACCOUNTING_REBUILD_MISMATCH` halt — logged below with every other halt —
  // and the process exits `halted`, never `ok`.
  const rebuild = trader.loop.checkAccountingRebuild("SHUTDOWN");
  const health = trader.loop.health();
  ports.log(`pump stopped: ${result.stopped} after ${String(result.polls)} poll(s)`);
  ports.log(
    rebuild.matched
      ? "accounting rebuild check at shutdown: the held ledger view equals its rebuild from zero"
      : "accounting rebuild check at shutdown: MISMATCH — the held accounting state differs from " +
          "its rebuild from zero (see the ACCOUNTING_REBUILD_MISMATCH halt)",
  );
  for (const halt of health.halts) {
    ports.log(`HALT ${halt.scope.kind} ${halt.code} (${halt.action}): ${halt.detail}`);
  }
  ports.log(`health: ${JSON.stringify(health)}`);

  // `PROVENANCE-1` (`OUT1-R1-HALT-NOT-DURABLE`): every latched halt, written
  // to `ops.incidents` BEFORE anything is closed, bounded, and never changing
  // the exit code below (`halt-record.ts`).
  await recordHaltsBeforeExit({
    halts: health.halts,
    config,
    write: (rows, deadlineMs) => store.recordHalts(rows, deadlineMs),
    log: ports.log,
  });

  transportLag.stop();
  await healthServer?.close();
  await feed.close();
  await store.close();
  await transport.close();
  return result.stopped === "HALTED" || !rebuild.matched ? EXIT_CODES.halted : EXIT_CODES.ok;
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
      `${String(config.instances.length)} instance(s) and their run(s) exist and agree with ` +
      "the configuration",
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
    idNamespace: config.instances.map((instance) => instance.runId).join("|"),
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
  return { ok: true, trader: created.trader, store, healthServer };
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
  process.exitCode = await startup({
    env: process.env,
    readConfig: async (path) => await readFile(path, "utf8"),
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}
/* c8 ignore stop */
