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
 * 3. construct the infrastructure        ← Redis, PostgreSQL
 * 3b. verifyRegisteredRows(db, config)   ← BOOT-1: the rows every durable write references
 * 4. the simulated venue, then
 *    createPaperTrader(...)              ← the composition root
 * 5. pump                                ← §8.1's outer loop
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

import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type PlannedOrderView,
  type TimeInForce,
} from "@polymarket-bot/simulation";
import { createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";

import { verifyRegisteredRows } from "./adapters/postgres-registration.js";
import { PostgresTraderStore } from "./adapters/postgres-store.js";
import { RedisMarketEventFeed } from "./adapters/redis-feed.js";
import { parseTraderConfig, type TraderConfig } from "./config.js";
import type { Clock } from "./ports.js";
import { pump } from "./pump.js";
import { checkPaperTraderSafety } from "./safety.js";
import { createPaperTrader, type PaperTrader } from "./trader.js";

/** What the process exits with, so an operator can script against it. */
export const EXIT_CODES = Object.freeze({
  ok: 0,
  /** The environment is unsafe (§6 invariant 17, §15, ADR-010). */
  unsafeEnvironment: 78,
  /** The configuration was refused. */
  configurationRefused: 78,
  /** A halt latched: no further trading decision will be made (§4.2). */
  halted: 75,
  /**
   * The database could not answer the startup registration check (`BOOT-1`).
   *
   * `sysexits` EX_UNAVAILABLE. Distinct from `configurationRefused` because
   * the operator's remedy differs — nothing in the document is wrong, the
   * store is unreachable — and distinct from `halted` because no halt latched:
   * the process never started.
   */
  infrastructureUnavailable: 69,
});

export interface StartupPorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readConfig: (path: string) => Promise<string>;
  readonly log: (line: string) => void;
}

/** The holder the venue's policy reads. See the module header. */
export interface VenueWiring {
  trader: PaperTrader | undefined;
}

/**
 * The §12.1 `ExecutionPolicy` this process gives the simulated venue.
 *
 * Extracted and exported so its ONE unresolvable case can be driven directly
 * (review round 1, MEDIUM-3): the reviewed tip left a bare `throw` here under a
 * `startup()` docstring that says "Never throws", with a comment asserting the
 * branch was unreachable and nothing exercising it either way.
 *
 * THE THROW STAYS, AND IT IS CONTAINED. `timeInForceFor` must answer a
 * `TimeInForce`; there is no refusal channel and no safe value — "a silently
 * assumed FAK would change every unfilled remainder's fate" is the seam's own
 * rule. The containment is `SimulatedVenue.submit`'s: it runs the policy inside
 * `totallyResult`, so a throw becomes a REFUSED `ExecutionResult` carrying a
 * `SIMULATION_*` code, which the loop counts as `submissionsRefused`. It never
 * reaches `startup`, and `apps/trader/src/main.test.ts` drives exactly that
 * path through a real `SimulatedVenue` rather than asserting it.
 *
 * What was genuinely missing is now here too: the process LOGS the unresolved
 * order, so a refusal an operator sees on the venue seam has a line naming the
 * planned order that caused it.
 */
export function createExecutionPolicy(
  wiring: VenueWiring,
  log: (line: string) => void,
): {
  timeInForceFor: (order: PlannedOrderView) => TimeInForce;
  statedExpiryNsFor: () => bigint | undefined;
  sameInstantAdditionsFor: () => "NOT_OBSERVED";
} {
  return {
    timeInForceFor(order: PlannedOrderView): TimeInForce {
      const resolved = wiring.trader?.loop.timeInForceFor(order.plannedOrderId);
      if (resolved === undefined) {
        log(
          `SUBMISSION REFUSED: no time-in-force was recorded for planned order ` +
            `${order.plannedOrderId}. The composition root refuses to assume one (§12.1 ` +
            "ExecutionPolicy); the venue contains this into a refused ExecutionResult and " +
            "nothing was submitted.",
        );
        throw new Error(
          `no time-in-force was recorded for planned order ${order.plannedOrderId}; the ` +
            "composition root refuses to assume one (§12.1 ExecutionPolicy)",
        );
      }
      return resolved;
    },
    statedExpiryNsFor(): bigint | undefined {
      return undefined;
    },
    sameInstantAdditionsFor() {
      // §12.2's CONSERVATIVE queue arm assumes we sit behind size added at our
      // price in the same recorded instant. This process does not observe that
      // — a book snapshot is an aggregate per level — so it says NOT_OBSERVED
      // rather than claiming a zero it did not measure.
      return "NOT_OBSERVED";
    },
  };
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
  const transport = await RedisStreamsEventTransport.connect({
    connection: { url: redisUrl },
    retention: { maxEvents: config.infrastructure.retentionMaxEvents },
  });

  // --- 3b + 4. the durable store, the registration check, the venue, the root
  const assembled = await assembleDurableTrader({
    env: ports.env,
    config,
    document: configured.document,
    postgresUrl,
    clock: new SystemPaperClock(),
    log: ports.log,
  });
  if (!assembled.ok) {
    await transport.close();
    return assembled.code;
  }
  const { store, trader } = assembled;

  // --- 5. the pump ----------------------------------------------------------
  const subscription = await transport.subscribe({
    stream: config.infrastructure.eventStream,
    consumerId: config.infrastructure.consumerId,
  });
  const feed = new RedisMarketEventFeed({
    subscription,
    maxEvents: config.infrastructure.receiveBatchSize,
  });

  const result = await pump({
    loop: trader.loop,
    feed,
    halts: trader.halts,
    maxPolls: Number.MAX_SAFE_INTEGER,
  });

  const health = trader.loop.health();
  ports.log(`pump stopped: ${result.stopped} after ${String(result.polls)} poll(s)`);
  for (const halt of health.halts) {
    ports.log(`HALT ${halt.scope.kind} ${halt.code} (${halt.action}): ${halt.detail}`);
  }
  ports.log(`health: ${JSON.stringify(health)}`);

  await feed.close();
  await store.close();
  await transport.close();
  return result.stopped === "HALTED" ? EXIT_CODES.halted : EXIT_CODES.ok;
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
}

export type DurableTraderResult =
  | {
      readonly ok: true;
      readonly trader: PaperTrader;
      /** The store the trader writes through. The caller closes it. */
      readonly store: PostgresTraderStore;
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
 * THE ORDER IS THE POINT. The registration check runs BEFORE the venue and the
 * trader exist — nothing that could write has been constructed when the
 * database is asked whether the writes would land — and after the safety check
 * and the configuration door, which `startup` ran before calling this and
 * which `createPaperTrader` runs again on the document it is given.
 */
export async function assembleDurableTrader(
  options: DurableTraderOptions,
): Promise<DurableTraderResult> {
  const { config, log } = options;
  const database = createDatabase(createPostgresPool({ connectionString: options.postgresUrl }));
  const store = new PostgresTraderStore({
    db: database,
    // §7.5's contract version, as `strategy.definitions` pins it.
    decisionContractVersion: 1,
  });

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

  const fees = readFeeScheduleSnapshot({
    snapshotVersion: config.simulation.feeSchedule.snapshotVersion,
    takerFeeRate: config.simulation.feeSchedule.takerFeeRate,
    makerFeeRate: config.simulation.feeSchedule.makerFeeRate,
    roundingDecimalPlaces: config.simulation.feeSchedule.roundingDecimalPlaces,
    roundingMode: config.simulation.feeSchedule.roundingMode,
    minimumChargedFee: config.simulation.feeSchedule.minimumChargedFee,
    feeCurrency: config.simulation.feeSchedule.feeCurrency,
  });
  if (!fees.ok) {
    log(
      `REFUSING TO START: the configured fee snapshot was refused by the simulator ` +
        `(${fees.refusal.code}: ${fees.refusal.message}); a run without a valid fee snapshot ` +
        "cannot charge a fee (§6 invariant 9)",
    );
    await store.close();
    return { ok: false, code: EXIT_CODES.configurationRefused };
  }

  // The holder the venue's policy reads. Filled the instant the trader exists;
  // see the module header for why the venue may not answer either question
  // itself.
  const wiring: VenueWiring = { trader: undefined };

  const venue = new SimulatedVenue({
    clock: options.clock,
    runMode: "PAPER",
    model: tier0Model({
      fillModelVersion: config.simulation.fillModelVersion,
      fillModelParametersHash: config.simulation.fillModelParametersHash,
    }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits(
      "no venue rate-limit budget is modelled: §9.13's budget is WP-310's package and does " +
        "not exist yet. The trader's own §9.8 check-19 headroom is measured against the " +
        "operator-stated requestBudget and is NOT the venue's published bucket.",
    ),
    policy: createExecutionPolicy(wiring, log),
    startingCash: config.simulation.startingCash,
    books: {
      book(input): BookView | undefined {
        const market = wiring.trader?.markets.get(input.marketId);
        if (market === undefined) return undefined;
        const tokenId =
          input.side === "YES" ? market.config.yesTokenId : market.config.noTokenId;
        return {
          internalMarketId: input.marketId,
          tokenId,
          top() {
            const top = market.bookFor(input.side).topOfBook();
            return {
              ...(top.bestBidPrice === undefined ? {} : { bestBidPrice: top.bestBidPrice }),
              ...(top.bestBidSize === undefined ? {} : { bestBidSize: top.bestBidSize }),
              ...(top.bestAskPrice === undefined ? {} : { bestAskPrice: top.bestAskPrice }),
              ...(top.bestAskSize === undefined ? {} : { bestAskSize: top.bestAskSize }),
              ...(top.spread === undefined ? {} : { spread: top.spread }),
            };
          },
          ladder(side) {
            return market
              .bookFor(input.side)
              .levels(side)
              .map((level) => ({ price: level.price, size: level.size }));
          },
        };
      },
    },
  });

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
    store,
    idNamespace: config.instances.map((instance) => instance.runId).join("|"),
  });
  if (!created.ok) {
    log(`REFUSING TO START: ${created.refusal.code}: ${created.refusal.detail}`);
    for (const issue of created.refusal.issues) log(`  ${issue}`);
    await store.close();
    return { ok: false, code: EXIT_CODES.configurationRefused };
  }
  wiring.trader = created.trader;
  for (const row of created.trader.manifest) {
    log(
      `manifest: ${String(row.position)} ${row.instanceId} ${row.ownership} ` +
        `priority=${String(row.evaluationPriority)} market=${row.marketId}`,
    );
  }
  return { ok: true, trader: created.trader, store };
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
