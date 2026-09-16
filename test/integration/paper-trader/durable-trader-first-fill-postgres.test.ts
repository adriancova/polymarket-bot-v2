/**
 * `BOOT-1` — the assembled DURABLE trader survives its first decision and its
 * first fill against a REAL PostgreSQL, through the REAL composition root's
 * startup path (`GOV-2B` blocker **B9**).
 *
 * ## What this file is the first to prove
 *
 * Every earlier test of the durable adapter — `durable-pnl-snapshot-postgres.test.ts`
 * (`TRDR-2`) included — satisfied the tables' foreign keys through
 * `createTradingChain`, a `@polymarket-bot/storage-postgres/testing` FIXTURE,
 * and so established a column binding without establishing that the assembled
 * trader survives. It does not: against the migrated-but-unseeded database
 * `apps/trader/src/main.ts` builds, the real `startup()` was measured on `main`
 * at `1aa2238` (real Redis, real PostgreSQL, this fixture's configuration and
 * six events) to halt on its FIRST DECISION —
 *
 * ```text
 * HALT GLOBAL STORE_UNAVAILABLE (FULL_HALT): a decision record could not be
 *   persisted (UNAVAILABLE): … violates foreign key constraint
 *   "decisions_run_id_fkey"
 * exit code 75
 * ```
 *
 * — because nothing in `apps/trader` creates the `catalog.markets`,
 * `strategy.instances` or `strategy.runs` rows every durable write references.
 *
 * ## Two rules this file keeps, and why
 *
 * 1. **No `createTradingChain`.** That fixture seeds decisions, intents, plans
 *    and groups as well as the three parent rows, and a test that used it would
 *    again be supplying what production does not. The rows below are created
 *    through the SAME repositories an operator uses — `registerMarket`,
 *    `createDefinition`, `createConfig`, `createInstance`, `startRun` — which is
 *    the registration act `BOOT-1`'s design requires of an operator, and the
 *    identities THEY mint are what the configuration names.
 * 2. **The production startup path, not a test assembly.** `startup()` as
 *    written pumps until a halt and needs a Redis stream, so the process's
 *    startup was factored into {@link assembleDurableTrader} — the durable
 *    store, the registration check, the simulated venue and the composition
 *    root — which `startup` calls and this file calls, with the process's own
 *    `SystemPaperClock`. What this file does NOT run of `startup()`: the
 *    `checkPaperTraderSafety` call on the environment (run again on the same
 *    environment by `createPaperTrader`), the configuration FILE read (the same
 *    `parseTraderConfig` door is run here), the Redis connect / subscribe /
 *    `RedisMarketEventFeed`, and `pump` — whose per-batch `ingest` + `drain` the
 *    test performs directly on the loop.
 *
 * ## What lands, and what is asserted to be ABSENT (disclosed)
 *
 * Every durable write the trader makes is read back: `strategy.decisions`,
 * `strategy.state_checkpoints`, `accounting.ledger_transactions` with their
 * `ledger_entries`, and `accounting.pnl_snapshots`. One column is pinned NULL
 * on purpose: `ledger_transactions.fill_id`. It is a foreign key into
 * `execution.fills`, a table this process does not write — the trader persists
 * none of the §6 invariant 4 execution chain (`strategy.intents` →
 * `approved_intents` → `execution.plans` → `orders` → `fills`), which is its
 * own round — so a durable transaction cannot name the fill it books and the
 * adapter binds `NULL` there (`adapters/postgres-store.ts`,
 * `appendLedgerTransaction`). The pin fails the day the chain lands, which is
 * the day this file must start asserting the link instead.
 *
 * ## Docker
 *
 * Testcontainers, as `durable-pnl-snapshot-postgres.test.ts`: its own
 * `beforeAll`, no `globalSetup`, no skip when Docker is absent. Throwaway
 * credentials that live only for the run (§0.2, ADR-010); `environment` is
 * `PAPER` throughout; no venue, no signer, no real order.
 */

import type { DecimalSafeJsonValue } from "@polymarket-bot/storage-postgres";
import {
  createIsolatedDatabase,
  createMigratedContext,
  fixtureTimestamp,
  hashOf,
  startPostgresContainer,
  type TestContext,
} from "@polymarket-bot/storage-postgres/testing";
import { parseTraderConfig } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assembleDurableTrader,
  EXIT_CODES,
  SystemPaperClock,
} from "../../../apps/trader/src/main.js";
import {
  NO_TOKEN,
  T_CLOSE,
  T_OPEN,
  YES_TOKEN,
  recordedEvents,
  safeEnvironment,
  strategyParams,
  traderConfig,
} from "./support/fixture.js";

const ACCOUNT = "paper-account";
const CONDITION_ID = "0xcondition";
const RUN_SEED = "424242";

/** The identities the operator's registration minted. */
interface Registered {
  readonly marketId: string;
  readonly definitionId: string;
  readonly configId: string;
  readonly instanceId: string;
  readonly runId: string;
}

let container: Awaited<ReturnType<typeof startPostgresContainer>>;

beforeAll(async () => {
  container = await startPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

/** A migrated, UNSEEDED database of this scenario's own. */
interface Fresh {
  readonly connectionString: string;
  readonly context: TestContext;
}

/**
 * One fresh database per scenario: `migrateUp`, the same runner `db:migrate`
 * runs — and NOTHING else. Each scenario registers into its own, so no scenario
 * can pass on rows another one created, and `catalog.market_tokens`'s global
 * token uniqueness holds without inventing per-scenario token ids the
 * configuration would then have to carry.
 */
async function withFreshDatabase<T>(
  label: string,
  run: (fresh: Fresh) => Promise<T>,
): Promise<T> {
  const isolated = await createIsolatedDatabase(container.getConnectionUri(), label);
  const context = await createMigratedContext(isolated.connectionString);
  try {
    return await run({ connectionString: isolated.connectionString, context });
  } finally {
    await context.close();
  }
}

/**
 * `strategy.configs.parameters` is decimal-guarded: `WP-040`'s
 * `assertDecimalSafeJson` refuses a JavaScript `number` at ANY depth, and the
 * Static Bracket's own §13.2 document carries integers (`version`,
 * `*_ms`, `*_seconds`, `maximum_entries_per_market`). An operator therefore
 * cannot register the strategy's parameters verbatim today — a real contract
 * tension between `packages/storage-postgres` and
 * `packages/strategies/static-bracket`, carried as a follow-up by `BOOT-1`'s
 * handoff. This test renders every number as its decimal string so the row can
 * exist; the trader's configuration document still carries the strategy's own
 * params, which the strategy's own validator checks at startup.
 */
function decimalSafe(value: unknown): DecimalSafeJsonValue {
  if (typeof value === "number") return String(value);
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(decimalSafe);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, decimalSafe(inner)]),
    );
  }
  throw new Error(`the strategy params carry a value JSON cannot hold: ${typeof value}`);
}

/** {@link decimalSafe} at the document root, typed as the repository's input. */
function decimalSafeDocument(value: Record<string, unknown>): {
  readonly [key: string]: DecimalSafeJsonValue;
} {
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, decimalSafe(inner)]),
  );
}

/**
 * The operator's registration act, through the repositories `WP-040` ships and
 * nothing else. Each repository mints the row's identity; the configuration
 * document below names what was minted.
 */
async function registerThroughTheRepositories(
  context: TestContext,
  label: string,
): Promise<Registered> {
  const { catalog, strategy } = context.repositories;

  const marketId = await catalog.registerMarket({
    conditionId: `${CONDITION_ID}-${label}`,
    questionTitle: `Will BTC be up at 12:15? (${label})`,
    parameters: {
      tickSize: "0.01",
      minimumOrderSize: "5",
      tradingDelaySeconds: 0,
      negRisk: false,
      lifecycleState: "OPEN",
      openTime: T_OPEN,
      closeTime: T_CLOSE,
    },
    tokens: [
      { tokenId: YES_TOKEN, outcomeSide: "YES", outcomeLabel: "Yes" },
      { tokenId: NO_TOKEN, outcomeSide: "NO", outcomeLabel: "No" },
    ],
    source: "polymarket",
    observedAt: fixtureTimestamp(),
  });

  const definitionId = await strategy.createDefinition({
    strategyName: `static-bracket-${label}`,
    codeVersion: "0.1.0",
    paramsSchema: {
      $comment: "the §13.2 Static Bracket document; validated by validateStaticBracketParams",
      type: "object",
    },
    stateSchemaVersion: 1,
    decisionContractVersion: 1,
  });

  const parameters = decimalSafeDocument(strategyParams());
  const { configId } = await strategy.createConfig({
    definitionId,
    parameters,
    parametersHash: hashOf(JSON.stringify(parameters)),
    validatedAt: fixtureTimestamp(),
    createdBy: "boot-1-acceptance",
  });

  const instanceId = await strategy.createInstance({
    instanceName: `static-bracket-${label}`,
    definitionId,
    configId,
    environment: "PAPER",
    accountRef: ACCOUNT,
    defaultOwnershipMode: "LIVE_OWNER",
    evaluationPriority: 0,
  });

  const runId = await strategy.startRun({
    instanceId,
    definitionId,
    configId,
    environment: "PAPER",
    // The test cannot know its own commit; a registration CLI would record
    // `git rev-parse HEAD` here. The column is an identifier, not a pin the
    // trader reads.
    codeCommit: "boot-1-acceptance-test",
    stateSchemaVersion: 1,
    runSeed: RUN_SEED,
  });

  return { marketId, definitionId, configId, instanceId, runId };
}

/** The fixture configuration, naming the identities registration minted. */
function documentFor(
  registered: Registered,
  label: string,
  overrides: { readonly conditionId?: string; readonly runSeed?: string } = {},
): Record<string, unknown> {
  const base = traderConfig();
  const market = (base["markets"] as Record<string, unknown>[])[0];
  const instance = (base["instances"] as Record<string, unknown>[])[0];
  if (market === undefined || instance === undefined) {
    throw new Error("the fixture configuration lost its market or its instance");
  }
  return traderConfig({
    markets: [
      {
        ...market,
        marketId: registered.marketId,
        conditionId: overrides.conditionId ?? `${CONDITION_ID}-${label}`,
      },
    ],
    instances: [
      {
        ...instance,
        instanceId: registered.instanceId,
        runId: registered.runId,
        configId: registered.configId,
        runSeed: overrides.runSeed ?? RUN_SEED,
        marketId: registered.marketId,
      },
    ],
  });
}

/** Runs the process's assembly on a document, capturing what it logged. */
async function assemble(document: Record<string, unknown>, postgresUrl: string) {
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) {
    throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
  }
  const lines: string[] = [];
  const result = await assembleDurableTrader({
    env: safeEnvironment(),
    config: parsed.config,
    document,
    postgresUrl,
    clock: new SystemPaperClock(),
    log: (line) => {
      lines.push(line);
    },
  });
  return { result, log: lines.join("\n") };
}

describe("the startup registration check refuses what the database does not hold (BOOT-1)", () => {
  it("REFUSES TO START against a migrated, unseeded database — the B9 shape — naming every missing row", async () => {
    await withFreshDatabase("boot1-unseeded", async ({ connectionString, context }) => {
      // The fixture's constant identities: valid UUIDs that no row carries.
      const document = traderConfig();
      const { result, log } = await assemble(document, connectionString);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("the trader assembled against an unseeded database");
      expect(result.code).toBe(EXIT_CODES.configurationRefused);
      expect(log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISSING");
      // All three, in one refusal, each naming the table and the configured id.
      const market = (document["markets"] as { marketId: string }[])[0];
      const instance = (document["instances"] as { instanceId: string; runId: string }[])[0];
      if (market === undefined || instance === undefined) throw new Error("fixture lost its rows");
      expect(log).toContain(`catalog.markets: no row with market_id ${market.marketId}`);
      expect(log).toContain(`strategy.instances: no row with instance_id ${instance.instanceId}`);
      expect(log).toContain(`strategy.runs: no row with run_id ${instance.runId}`);
      // It tells the operator HOW, because there is no CLI for it yet.
      expect(log).toContain("registerMarket");
      expect(log).toContain("startRun");

      // Fail CLOSED: nothing was written on the way to the refusal.
      const decisions = await context.db.selectFrom("strategy.decisions").selectAll().execute();
      expect(decisions).toHaveLength(0);
    });
  }, 120_000);

  it("REFUSES a configuration that disagrees with the registered rows about a shared fact", async () => {
    await withFreshDatabase("boot1-mismatch", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "mismatch");
      const { result, log } = await assemble(
        documentFor(registered, "mismatch", { conditionId: "0xsomeothercondition", runSeed: "7" }),
        connectionString,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a mismatched configuration assembled");
      expect(result.code).toBe(EXIT_CODES.configurationRefused);
      expect(log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
      expect(log).toContain(`catalog.markets ${registered.marketId}: the row's condition_id is`);
      expect(log).toContain('"0xsomeothercondition"');
      expect(log).toContain(
        `strategy.runs ${registered.runId}: the row records run_seed ${RUN_SEED}`,
      );
    });
  }, 120_000);

  it("REFUSES a run that is no longer RUNNING — a closed record accepts no decision", async () => {
    await withFreshDatabase("boot1-stopped", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "stopped");
      await context.repositories.strategy.stopRun(registered.runId, "stopped by the test");

      const { result, log } = await assemble(documentFor(registered, "stopped"), connectionString);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a stopped run assembled");
      expect(log).toContain("TRADER_REGISTRATION_MISMATCH");
      expect(log).toContain(`strategy.runs ${registered.runId}: the row's status is STOPPED`);
    });
  }, 120_000);

  it("REFUSES TO START, with the infrastructure exit code, when the database cannot answer", async () => {
    // A closed port on the loopback: the pool is lazy, so the first statement
    // the registration check issues is where the process learns the answer —
    // and it refuses there rather than at its first durable write.
    const { result, log } = await assemble(
      traderConfig(),
      "postgres://nobody:nothing@127.0.0.1:1/nowhere",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("the trader assembled without a database");
    expect(result.code).toBe(EXIT_CODES.infrastructureUnavailable);
    expect(log).toContain("REFUSING TO START: TRADER_REGISTRATION_UNREADABLE");
  }, 60_000);
});

describe("the assembled durable trader survives its first decision AND its first fill (BOOT-1 acceptance)", () => {
  it("registers through the repositories, starts through the composition root, decides, fills, and every durable write lands", async () => {
    await withFreshDatabase("boot1-first-fill", async ({ connectionString, context }) => {
    const registered = await registerThroughTheRepositories(context, "first-fill");
    const document = documentFor(registered, "first-fill");

    // --- the REAL startup path, step 3b onward --------------------------------
    const { result, log } = await assemble(document, connectionString);
    expect(result.ok ? "ok" : log).toBe("ok");
    if (!result.ok) throw new Error("unreachable");
    const { trader, store } = result;
    expect(log).toContain("registration: OK");
    expect(log).toContain(`manifest: 0 ${registered.instanceId} OWNER`);

    try {
      // --- the pump's per-batch work, on the real loop --------------------------
      for (const event of recordedEvents(registered.marketId)) {
        expect(trader.loop.ingest(event)).toBe(true);
      }
      await trader.loop.drain();

      // --- the process is HEALTHY: no halt, a decision, a fill -----------------
      const health = trader.loop.health();
      expect(health.halts).toEqual([]);
      expect(health.healthy).toBe(true);
      expect(health.loop.decisionsPersisted).toBeGreaterThanOrEqual(1);
      expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
      expect(health.accounting.ledgerTransactions).toBeGreaterThanOrEqual(2);
      const traces = trader.loop.traces();
      expect(traces.length).toBeGreaterThanOrEqual(1);

      // --- strategy.decisions ---------------------------------------------------
      const decisions = await context.db
        .selectFrom("strategy.decisions")
        .selectAll()
        .where("run_id", "=", registered.runId)
        .orderBy("evaluation_seq")
        .execute();
      expect(decisions.length).toBe(trader.loop.decisions().length);
      expect(decisions.length).toBeGreaterThanOrEqual(1);
      for (const row of decisions) {
        expect(row.instance_id).toBe(registered.instanceId);
        expect(row.market_id).toBe(registered.marketId);
        expect(row.decision_contract_version).toBe(1);
      }
      expect(decisions.some((row) => row.decision_type === "enter")).toBe(true);

      // --- strategy.state_checkpoints ------------------------------------------
      const checkpoints = await context.db
        .selectFrom("strategy.state_checkpoints")
        .selectAll()
        .where("run_id", "=", registered.runId)
        .execute();
      expect(checkpoints.length).toBeGreaterThanOrEqual(1);
      for (const row of checkpoints) {
        expect(row.instance_id).toBe(registered.instanceId);
        expect(row.state_hash).toMatch(/^[0-9a-f]{64}$/u);
      }

      // --- accounting.ledger_transactions + ledger_entries ---------------------
      const transactions = await context.db
        .selectFrom("accounting.ledger_transactions")
        .selectAll()
        .where("market_id", "=", registered.marketId)
        .execute();
      const expectedTransactions = traces.reduce(
        (total, trace) => total + trace.ledgerTransactionIds.length,
        0,
      );
      expect(transactions.length).toBe(expectedTransactions);
      expect(transactions.length).toBe(health.accounting.ledgerTransactions);
      for (const row of transactions) {
        expect(row.environment).toBe("PAPER");
        expect(row.account_ref).toBe(ACCOUNT);
        // DISCLOSED, not hidden: the trader persists no `execution.fills` row, so
        // the fill link is NULL here (module header). When the execution chain
        // is persisted this pin must flip to assert the fill id.
        expect(row.fill_id).toBeNull();
        expect(row.order_id).toBeNull();
      }
      const transactionIds = transactions.map((row) => row.ledger_transaction_id);
      const entries = await context.db
        .selectFrom("accounting.ledger_entries")
        .selectAll()
        .where("ledger_transaction_id", "in", transactionIds)
        .execute();
      expect(entries.length).toBeGreaterThanOrEqual(2 * transactions.length);
      const attributed = entries.filter((row) => row.scope === "VIRTUAL_STRATEGY");
      expect(attributed.length).toBeGreaterThanOrEqual(1);
      for (const row of attributed) {
        expect(row.instance_id).toBe(registered.instanceId);
        expect(row.run_id).toBe(registered.runId);
        expect(row.market_id).toBe(registered.marketId);
      }
      // §6 invariant 1 across the round trip: no amount is a `number`.
      for (const row of entries) expect(typeof row.amount).toBe("string");

      // --- accounting.pnl_snapshots -------------------------------------------
      const snapshots = await context.db
        .selectFrom("accounting.pnl_snapshots")
        .selectAll()
        .where("run_id", "=", registered.runId)
        .execute();
      // One snapshot per fill (`loop.ts` writes after every posting).
      expect(snapshots.length).toBe(health.execution.fillsObserved);
      for (const row of snapshots) {
        expect(row.scope).toBe("VIRTUAL_STRATEGY");
        expect(row.environment).toBe("PAPER");
        expect(row.instance_id).toBe(registered.instanceId);
        expect(row.market_id).toBe(registered.marketId);
        expect(row.account_ref).toBe(ACCOUNT);
        expect(typeof row.realized_pnl).toBe("string");
        expect(typeof row.capital_committed).toBe("string");
      }
    } finally {
      await store.close();
    }
    });
  }, 120_000);
});
