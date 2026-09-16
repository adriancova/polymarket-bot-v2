/**
 * The startup REGISTRATION CHECK — `BOOT-1`, `GOV-2B` blocker **B9**.
 *
 * ## The defect this closes
 *
 * Every durable write the assembled trader makes references rows nothing in
 * `apps/trader` ever created. `strategy.decisions.run_id` and `.instance_id`
 * are NOT NULL foreign keys into `strategy.runs` and `strategy.instances`
 * (`db/migrations/0004_strategy.up.sql`); `strategy.state_checkpoints`,
 * `accounting.ledger_entries` and `accounting.pnl_snapshots` reference the same
 * two tables and `catalog.markets` besides. Against the database `main.ts`
 * builds — migrated, unseeded — the REAL `startup()` was measured on `main` at
 * `1aa2238` (real Redis, real PostgreSQL, the fixture configuration, six
 * published events):
 *
 * ```text
 * pump stopped: HALTED after 1 poll(s)
 * HALT GLOBAL STORE_UNAVAILABLE (FULL_HALT): a decision record could not be
 *   persisted (UNAVAILABLE): the durable store could not persist a decision:
 *   error: insert or update on table "decisions" violates foreign key
 *   constraint "decisions_run_id_fkey"; …
 * exit code 75
 * ```
 *
 * — on the first DECISION, before any fill. Every test that exercised the
 * durable adapter satisfied those foreign keys through `createTradingChain`, a
 * `@polymarket-bot/storage-postgres/testing` fixture: a real-looking test whose
 * fixture supplied what production did not.
 *
 * ## The failure mode, decided per table: REFUSE AT STARTUP, all three
 *
 * The composition root VERIFIES that the rows its configuration names exist and
 * agree with the configuration, and refuses to start if they do not. It creates
 * none of them. Per table:
 *
 * - **`catalog.markets` — refuse.** A market row is a VENUE FACT: its
 *   `condition_id`, tokens, tick size and parameter history are what
 *   `packages/universe` observes and `WP-040`'s catalog repository records. The
 *   trader's configuration restates some of those facts for §9.8's checks; it is
 *   not their authority, and a process that minted a market row from its own
 *   configuration would be manufacturing the fact it is supposed to be checked
 *   against. Silently minting one is worse than refusing to trade.
 * - **`strategy.instances` — refuse.** An instance is a NAMED DEPLOYMENT that
 *   outlives any one run (§9.6: "start a new run for every code, config, model,
 *   feature, or state-schema change" — the instance persists across them), with
 *   a `(environment, instance_name)` identity, a validated immutable config and
 *   an account. Every ledger attribution and PnL stream is keyed by it. A trader
 *   that created one at startup would mint a fresh deployment identity on every
 *   restart and orphan the history of the last one.
 * - **`strategy.runs` — refuse, THIS ROUND, and the argument is narrower.** A
 *   run row is plausibly the run's own fact to create. It is not created here
 *   because the ONE writer `WP-040` ships, `createStrategyRepository(db).startRun`,
 *   MINTS the run identity (`packages/storage-postgres/src/repositories/strategy.ts`),
 *   while the configuration names an operator-stated `runId` that the runtime,
 *   every decision, every checkpoint, every ledger entry, every PnL snapshot and
 *   the deterministic id namespace (`main.ts` `idNamespace`) all carry. Creating
 *   the row with the configured id from this app would be a second way of
 *   writing that table, which this round was told not to invent; adopting the
 *   minted id instead would mean rewriting the configuration→trader identity
 *   flow and inventing a `code_commit` this process has no honest source for.
 *   Both are `packages/storage-postgres` / configuration-surface changes and
 *   are recorded as the follow-up, not done here.
 *
 * So the operator registers deliberately, through the repositories that exist
 * for exactly this — `registerMarket`, `createDefinition`, `createConfig`,
 * `createInstance`, `startRun` — and names the identities they minted in the
 * configuration document. A run that cannot find them does not trade. There is
 * no operator CLI for that registration yet; that gap is disclosed in the
 * refusal text and carried as a follow-up rather than papered over.
 *
 * ## What is checked, and why each check is a startup refusal
 *
 * Each check is a fact the configuration states that the database ALSO states,
 * about the same row — the class of disagreement `config.ts`'s
 * `crossFieldRefusal` already refuses within the document, extended across the
 * durable boundary:
 *
 * | row | configured | checked against the row |
 * | --- | --- | --- |
 * | `catalog.markets` by `market_id` | `markets[].conditionId` | `condition_id` — a configuration naming market X while stating condition Y points at the wrong market |
 * | `strategy.instances` by `instance_id` | `environment` | `environment` — `runs_instance_environment_fk` binds a run to its instance's environment, and every PnL row this run writes is stamped `PAPER` |
 * | `strategy.runs` by `run_id` | `instances[].instanceId` | `instance_id` — the run must be a run OF the configured instance |
 * | | `environment` | `environment` |
 * | | `instances[].configId` | `config_id` — §9.6's pin: the run executes the config it was started with |
 * | | `instances[].runSeed` | `run_seed` — §12.4's pin: the seed the runtime is handed is the one the run row records |
 * | | (implicit) | `status = 'RUNNING'` — `runs_end_consistent` makes a stopped run a closed record; no decision may be appended to it |
 *
 * Everything is READ. This module issues `select` statements through the typed
 * builder — the same "composition root binds them to the tables" arrangement
 * `WP-200` describes and `postgres-store.ts` already uses — and never an
 * `insert`, `update` or `delete`. It uses no type assertion of any kind
 * (`test/unit/trader/query-boundary-cast-scan.test.ts`).
 *
 * ## Failure is DATA, and it fails CLOSED
 *
 * A database that cannot answer is `TRADER_REGISTRATION_UNREADABLE`, and the
 * process refuses to start — it does not start degraded and discover the
 * outage at its first write. A row that is absent is `_MISSING`; a row that
 * disagrees is `_MISMATCH`. Every problem found is reported together, so an
 * operator fixing a configuration sees the whole list once rather than one item
 * per restart. Nothing here throws.
 */

import type { PolymarketBotDatabase } from "@polymarket-bot/storage-postgres";

import type { TraderConfig } from "../config.js";

export interface RegistrationRefusal {
  readonly code:
    /** A row the configuration names does not exist. */
    | "TRADER_REGISTRATION_MISSING"
    /** A row exists and disagrees with the configuration about a shared fact. */
    | "TRADER_REGISTRATION_MISMATCH"
    /** The database could not answer; the process refuses rather than guesses. */
    | "TRADER_REGISTRATION_UNREADABLE";
  readonly detail: string;
  readonly issues: readonly string[];
}

export type RegistrationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: RegistrationRefusal };

/** How an operator creates what this check requires. Named in every refusal. */
const HOW_TO_REGISTER =
  "The trader creates none of these rows (see adapters/postgres-registration.ts): register " +
  "them through @polymarket-bot/storage-postgres — createCatalogRepository(db).registerMarket, " +
  "createStrategyRepository(db).createDefinition / createConfig / createInstance / startRun — " +
  "and name the identities they minted in the configuration document";

/**
 * Verifies that every market, instance and run the configuration names exists
 * in the database and agrees with the configuration. TOTAL: never throws.
 */
export async function verifyRegisteredRows(
  db: PolymarketBotDatabase,
  config: TraderConfig,
): Promise<RegistrationResult> {
  try {
    return await verify(db, config);
  } catch (cause) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_REGISTRATION_UNREADABLE",
        detail:
          "the database could not answer whether the configured market, instance and run rows " +
          "exist; a process that started anyway would learn the answer at its first durable " +
          "write, as a GLOBAL halt, so it refuses to start instead (fail closed)",
        issues: [cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)],
      },
    };
  }
}

async function verify(db: PolymarketBotDatabase, config: TraderConfig): Promise<RegistrationResult> {
  const missing: string[] = [];
  const mismatched: string[] = [];

  // --- catalog.markets --------------------------------------------------------
  const marketIds = config.markets.map((market) => market.marketId);
  const marketRows = await db
    .selectFrom("catalog.markets")
    .select(["market_id", "condition_id"])
    .where("market_id", "in", marketIds)
    .execute();
  const marketsById = new Map(marketRows.map((row) => [row.market_id, row]));
  for (const market of config.markets) {
    const row = marketsById.get(market.marketId);
    if (row === undefined) {
      missing.push(`catalog.markets: no row with market_id ${market.marketId}`);
      continue;
    }
    if (row.condition_id !== market.conditionId) {
      mismatched.push(
        `catalog.markets ${market.marketId}: the row's condition_id is ` +
          `${JSON.stringify(row.condition_id)} but the configuration states conditionId ` +
          `${JSON.stringify(market.conditionId)}`,
      );
    }
  }

  // --- strategy.instances -----------------------------------------------------
  const instanceIds = config.instances.map((instance) => instance.instanceId);
  const instanceRows = await db
    .selectFrom("strategy.instances")
    .select(["instance_id", "environment"])
    .where("instance_id", "in", instanceIds)
    .execute();
  const instancesById = new Map(instanceRows.map((row) => [row.instance_id, row]));
  for (const instance of config.instances) {
    const row = instancesById.get(instance.instanceId);
    if (row === undefined) {
      missing.push(`strategy.instances: no row with instance_id ${instance.instanceId}`);
      continue;
    }
    if (row.environment !== config.environment) {
      mismatched.push(
        `strategy.instances ${instance.instanceId}: the row's environment is ${row.environment} ` +
          `but this is a ${config.environment} trader`,
      );
    }
  }

  // --- strategy.runs ----------------------------------------------------------
  const runIds = config.instances.map((instance) => instance.runId);
  const runRows = await db
    .selectFrom("strategy.runs")
    .select(["run_id", "instance_id", "environment", "config_id", "run_seed", "status"])
    .where("run_id", "in", runIds)
    .execute();
  const runsById = new Map(runRows.map((row) => [row.run_id, row]));
  for (const instance of config.instances) {
    const row = runsById.get(instance.runId);
    if (row === undefined) {
      missing.push(`strategy.runs: no row with run_id ${instance.runId}`);
      continue;
    }
    const at = `strategy.runs ${instance.runId}`;
    if (row.instance_id !== instance.instanceId) {
      mismatched.push(
        `${at}: the row belongs to instance ${row.instance_id} but the configuration names it ` +
          `as instance ${instance.instanceId}'s run`,
      );
    }
    if (row.environment !== config.environment) {
      mismatched.push(
        `${at}: the row's environment is ${row.environment} but this is a ${config.environment} trader`,
      );
    }
    if (row.config_id !== instance.configId) {
      mismatched.push(
        `${at}: the row pins config ${row.config_id} but the configuration states configId ` +
          `${instance.configId} (§9.6: a run executes the config it was started with)`,
      );
    }
    if (row.run_seed !== instance.runSeed) {
      mismatched.push(
        `${at}: the row records run_seed ${row.run_seed} but the configuration states runSeed ` +
          `${instance.runSeed} (§12.4: the seed the runtime is handed must be the one the run pins)`,
      );
    }
    if (row.status !== "RUNNING") {
      mismatched.push(
        `${at}: the row's status is ${row.status}; a run that is not RUNNING is a closed record ` +
          "and no decision may be appended to it",
      );
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_REGISTRATION_MISSING",
        detail:
          `${String(missing.length)} row(s) the configuration names do not exist in the ` +
          "database, so every durable write this run would make — decisions, checkpoints, " +
          "ledger entries, PnL snapshots — would violate a foreign key and halt the process " +
          `at its first decision. ${HOW_TO_REGISTER}`,
        issues: [...missing, ...mismatched],
      },
    };
  }
  if (mismatched.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_REGISTRATION_MISMATCH",
        detail:
          `${String(mismatched.length)} row(s) the configuration names exist but disagree ` +
          "with it about a fact both state; refused rather than resolved, because choosing " +
          "a winner here would silently discard a value the operator did set",
        issues: mismatched,
      },
    };
  }
  return { ok: true };
}
