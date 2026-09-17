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
 * `appendLedgerTransaction`, which also says what that severs: the fill id is
 * carried nowhere else, so the durable transactions of one fill share only
 * `occurred_at`/market/account and a rebuild from the durable rows cannot
 * reproduce per-fill economics).
 *
 * TWO pins, measuring two different things (review R5 — the first round said
 * the NULL pin "fails the day the chain lands", which it would not): the
 * `fill_id IS NULL` assertion measures the ADAPTER's binding and stays green
 * whatever the chain does; the `execution.fills` row count of ZERO measures the
 * CHAIN'S ABSENCE, and is what fails when a round persists fills — at which
 * point the NULL binding must be deleted and this file must assert the link.
 *
 * ## The restart case (review R1)
 *
 * `status = 'RUNNING'` does not mean a run accepts decisions. A run that
 * persisted decisions and then stopped without `stopRun` — a crash, an
 * operator kill — is still RUNNING; the first round's check let it through and
 * the restarted trader GLOBAL-halted at its first decision on
 * `decisions_evaluation_unique` (measured by the review). The check now reads
 * `strategy.decisions` and refuses such a run as
 * `TRADER_REGISTRATION_RUN_NOT_RESUMABLE` with the remedy (a new run). Pinned
 * below by doing exactly that: register, decide through the real assembly,
 * stop, start again.
 *
 * ## Docker
 *
 * Testcontainers, as `durable-pnl-snapshot-postgres.test.ts`: its own
 * `beforeAll`, no `globalSetup`, no skip when Docker is absent. Throwaway
 * credentials that live only for the run (§0.2, ADR-010); `environment` is
 * `PAPER` throughout; no venue, no signer, no real order.
 */

import { hashOf, startPostgresContainer, fixtureTimestamp } from "@polymarket-bot/storage-postgres/testing";
import { parseTraderConfig } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assembleDurableTrader,
  EXIT_CODES,
  SystemPaperClock,
} from "../../../apps/trader/src/main.js";
import { recordedEvents, safeEnvironment, traderConfig } from "./support/fixture.js";
import {
  ACCOUNT,
  CONDITION_ID,
  RUN_SEED,
  documentFor,
  registerThroughTheRepositories,
  withFreshDatabase as withFreshDatabaseOn,
  type Fresh,
} from "./support/registration.js";

let container: Awaited<ReturnType<typeof startPostgresContainer>>;

beforeAll(async () => {
  container = await startPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

/**
 * One fresh database per scenario — `support/registration.ts`'s
 * `withFreshDatabase` over this file's container (`TRDR-3` factored the
 * registration helpers out of this file for its sibling; nothing below
 * changed).
 */
async function withFreshDatabase<T>(
  label: string,
  run: (fresh: Fresh) => Promise<T>,
): Promise<T> {
  return await withFreshDatabaseOn(container.getConnectionUri(), label, run);
}

/** Runs the process's assembly on a document, capturing what it logged. */
async function assemble(
  document: Record<string, unknown>,
  postgresUrl: string,
  env: Record<string, string | undefined> = safeEnvironment(),
) {
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) {
    throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
  }
  const lines: string[] = [];
  const result = await assembleDurableTrader({
    env,
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

  it("REFUSES each of the four cross-checks the first round left unpinned (review R3)", async () => {
    await withFreshDatabase("boot1-cross-checks", async ({ connectionString, context }) => {
      // The PAPER instance P with its RUNNING run rP under config A.
      const primary = await registerThroughTheRepositories(context, "cross");
      const { strategy } = context.repositories;
      // A second immutable config B of the same definition.
      const { configId: configB } = await strategy.createConfig({
        definitionId: primary.definitionId,
        parameters: { note: "config B, never run" },
        parametersHash: hashOf("config-b"),
        validatedAt: fixtureTimestamp(1),
        createdBy: "boot-1-acceptance",
      });
      // A SHADOW instance S with its own RUNNING run rS — the composite key
      // `runs_instance_environment_fk` makes a run's environment its
      // instance's, so a run in another environment is always a run of an
      // instance in that environment.
      const shadowInstance = await strategy.createInstance({
        instanceName: "static-bracket-cross-shadow",
        definitionId: primary.definitionId,
        configId: primary.configId,
        environment: "SHADOW",
        accountRef: ACCOUNT,
        defaultOwnershipMode: "SHADOW",
        evaluationPriority: 1,
      });
      const shadowRun = await strategy.startRun({
        instanceId: shadowInstance,
        definitionId: primary.definitionId,
        configId: primary.configId,
        environment: "SHADOW",
        codeCommit: "boot-1-acceptance-test",
        stateSchemaVersion: 1,
        runSeed: RUN_SEED,
      });

      // (1) instances.environment: the PAPER trader names the SHADOW instance.
      const x = await assemble(
        documentFor(primary, "cross", { instanceId: shadowInstance, runId: shadowRun }),
        connectionString,
      );
      expect(x.result.ok).toBe(false);
      expect(x.log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
      expect(x.log).toContain(
        `strategy.instances ${shadowInstance}: the row's environment is SHADOW but this is a PAPER trader`,
      );

      // (2) runs.instance_id and (3) runs.environment: the PAPER instance P
      // names S's run as its own.
      const y = await assemble(documentFor(primary, "cross", { runId: shadowRun }), connectionString);
      expect(y.result.ok).toBe(false);
      expect(y.log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
      expect(y.log).toContain(
        `strategy.runs ${shadowRun}: the row belongs to instance ${shadowInstance} but the ` +
          `configuration names it as instance ${primary.instanceId}'s run`,
      );
      expect(y.log).toContain(
        `strategy.runs ${shadowRun}: the row's environment is SHADOW but this is a PAPER trader`,
      );

      // (4) runs.config_id: rP pins config A; the configuration states B.
      const z = await assemble(documentFor(primary, "cross", { configId: configB }), connectionString);
      expect(z.result.ok).toBe(false);
      expect(z.log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
      expect(z.log).toContain(
        `strategy.runs ${primary.runId}: the row pins config ${primary.configId} but the ` +
          `configuration states configId ${configB}`,
      );

      // The control: the rows as registered assemble.
      const ok = await assemble(documentFor(primary, "cross"), connectionString);
      expect(ok.result.ok ? "ok" : ok.log).toBe("ok");
      if (ok.result.ok) await ok.result.store.close();
    });
  }, 120_000);

  it("REFUSES an instance registered under another account — every ledger entry would be booked to it (review R8)", async () => {
    await withFreshDatabase("boot1-account", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "account", {
        accountRef: "someone-elses-account",
      });
      const { result, log } = await assemble(documentFor(registered, "account"), connectionString);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an instance under another account assembled");
      expect(result.code).toBe(EXIT_CODES.configurationRefused);
      expect(log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
      expect(log).toContain(
        `strategy.instances ${registered.instanceId}: the row's account_ref is ` +
          `"someone-elses-account" but the configuration books every ledger entry and PnL row ` +
          `to accounting.accountRef "${ACCOUNT}"`,
      );
    });
  }, 120_000);

  it("REFUSES to restart a run that already holds decisions, and names the remedy (review R1)", async () => {
    await withFreshDatabase("boot1-restart", async ({ connectionString, context }) => {
      const registered = await registerThroughTheRepositories(context, "restart");
      const document = documentFor(registered, "restart");

      // First start: the production assembly, one decision at least.
      const first = await assemble(document, connectionString);
      expect(first.result.ok ? "ok" : first.log).toBe("ok");
      if (!first.result.ok) throw new Error("unreachable");
      for (const event of recordedEvents(registered.marketId, `${CONDITION_ID}-restart`)) {
        expect(first.result.trader.loop.ingest(event)).toBe(true);
      }
      await first.result.trader.loop.drain();
      expect(first.result.trader.loop.health().halts).toEqual([]);
      const before = {
        decisions: await context.db.selectFrom("strategy.decisions").selectAll().execute(),
        checkpoints: await context.db.selectFrom("strategy.state_checkpoints").selectAll().execute(),
        snapshots: await context.db.selectFrom("accounting.pnl_snapshots").selectAll().execute(),
      };
      expect(before.decisions.length).toBeGreaterThanOrEqual(1);
      // Stop — without `stopRun`, as a crash or an operator kill would. The run
      // row is still RUNNING.
      await first.result.store.close();
      const run = await context.db
        .selectFrom("strategy.runs")
        .select("status")
        .where("run_id", "=", registered.runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe("RUNNING");

      // Second start against the same run: REFUSED, typed, with the remedy.
      // (At the first round's tip this assembled, and the first decision
      // GLOBAL-halted on `decisions_evaluation_unique`.)
      const second = await assemble(document, connectionString);
      expect(second.result.ok).toBe(false);
      if (second.result.ok) throw new Error("a run holding decisions was resumed");
      expect(second.result.code).toBe(EXIT_CODES.configurationRefused);
      expect(second.log).toContain("REFUSING TO START: TRADER_REGISTRATION_RUN_NOT_RESUMABLE");
      expect(second.log).toContain(
        `strategy.runs ${registered.runId}: the run already holds persisted decisions`,
      );
      expect(second.log).toContain("decisions_evaluation_unique");
      expect(second.log).toContain("Start a NEW run");
      expect(second.log).toContain("startRun");
      // Zero new rows: the refusal wrote nothing and the old run's rows stand.
      const after = {
        decisions: await context.db.selectFrom("strategy.decisions").selectAll().execute(),
        checkpoints: await context.db.selectFrom("strategy.state_checkpoints").selectAll().execute(),
        snapshots: await context.db.selectFrom("accounting.pnl_snapshots").selectAll().execute(),
      };
      expect(after.decisions).toEqual(before.decisions);
      expect(after.checkpoints).toEqual(before.checkpoints);
      expect(after.snapshots).toEqual(before.snapshots);

      // The remedy works: a NEW run for the same instance and config, and the
      // configuration pointed at it, assembles.
      const newRunId = await context.repositories.strategy.startRun({
        instanceId: registered.instanceId,
        definitionId: registered.definitionId,
        configId: registered.configId,
        environment: "PAPER",
        codeCommit: "boot-1-acceptance-test",
        stateSchemaVersion: 1,
        runSeed: RUN_SEED,
      });
      const third = await assemble(documentFor(registered, "restart", { runId: newRunId }), connectionString);
      expect(third.result.ok ? "ok" : third.log).toBe("ok");
      if (third.result.ok) await third.result.store.close();
    });
  }, 120_000);

  it("checks the safety posture BEFORE any database read — an unsafe environment never reaches a SELECT (review R4)", async () => {
    const unsafe = {
      ...safeEnvironment(),
      MAX_RUN_MODE: "LIVE",
      RUN_MODE: "LIVE",
      ALLOW_REAL_ORDERS: "true",
    };
    // An UNREACHABLE database: had a query run, the answer would have been
    // `TRADER_REGISTRATION_UNREADABLE`. It is not, because no pool was built.
    const unreachable = await assemble(
      traderConfig(),
      "postgres://nobody:nothing@127.0.0.1:1/nowhere",
      unsafe,
    );
    expect(unreachable.result.ok).toBe(false);
    if (unreachable.result.ok) throw new Error("an unsafe environment assembled");
    expect(unreachable.result.code).toBe(EXIT_CODES.unsafeEnvironment);
    expect(unreachable.log).toContain("REFUSING TO START: TRADER_UNSAFE_ENVIRONMENT");
    expect(unreachable.log).not.toContain("TRADER_REGISTRATION");
    expect(unreachable.log).toContain("PAPER_RUN_MODE_CEILING_RAISED");

    // And against a real, unseeded database — where the first round's seam
    // answered `TRADER_REGISTRATION_MISSING` (the SELECTs had run) — the
    // answer is the environment, and nothing was read.
    await withFreshDatabase("boot1-unsafe", async ({ connectionString, context }) => {
      const { result, log } = await assemble(traderConfig(), connectionString, unsafe);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an unsafe environment assembled");
      expect(result.code).toBe(EXIT_CODES.unsafeEnvironment);
      expect(log).toContain("REFUSING TO START: TRADER_UNSAFE_ENVIRONMENT");
      expect(log).not.toContain("TRADER_REGISTRATION");
      // Nothing was written either. (This read also matters mechanically:
      // `createMigratedContext.close()` is Kysely's `destroy()`, which returns
      // EARLY when no query ever initialised the driver, leaving the raw pool
      // `migrateUp` used open — `BOOT-1` r1 measured two `57P01 terminating
      // connection` uncaught errors at container stop from exactly this
      // scenario. A storage-testing fixture defect, reported, not this file's
      // to fix; one query through `context.db` makes `close()` real.)
      const decisions = await context.db.selectFrom("strategy.decisions").selectAll().execute();
      expect(decisions).toHaveLength(0);
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
      // The same six events, addressed to the REGISTERED market: its minted id
      // and the condition id it was registered under (review R10).
      for (const event of recordedEvents(registered.marketId, `${CONDITION_ID}-first-fill`)) {
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
        // the fill link is NULL here (module header). This pair pins the
        // ADAPTER's binding only.
        expect(row.fill_id).toBeNull();
        expect(row.order_id).toBeNull();
      }
      // …and THIS pins the chain's absence (review R5): the fill was observed,
      // booked and snapshotted, and `execution.fills` holds NOTHING. When a
      // round persists fills, this assertion FAILS — that failure is the
      // instruction to delete the NULL binding in `appendLedgerTransaction` and
      // to flip the pair above to assert the fill link.
      const persistedFills = await context.db.selectFrom("execution.fills").selectAll().execute();
      expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
      expect(persistedFills).toHaveLength(0);
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
