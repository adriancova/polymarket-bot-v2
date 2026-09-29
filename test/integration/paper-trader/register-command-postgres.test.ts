/**
 * `REGISTER-1` — the operator registration command composes with the durable
 * trader, against a REAL PostgreSQL.
 *
 * ## What this file proves
 *
 * 1. **The round trip.** The command's own code path (`runRegisterCommand`,
 *    exactly what `dist/register.mjs`'s process shell calls) registers a
 *    template into a fresh migrated database; the COMPLETED document it writes
 *    is handed, unchanged, to the durable trader's own assembly
 *    (`assembleDurableTrader`, the function `startup()` calls): the
 *    registration check answers `registration: OK`, and the assembled trader
 *    DECIDES — its decisions and checkpoints land against the rows the command
 *    registered. No row is seeded outside the command; `createTradingChain` is
 *    not used.
 * 2. **The rows are what the document states**, column by column, and the
 *    config row is the one `BOOT-1`'s hand registration writes for the same
 *    document (the rendering `OUTAGE-1`'s parameter check will compare).
 * 3. **The definition row states the strategy the trader runs**: its mirrored
 *    name, version and state-schema version equal
 *    `@polymarket-bot/strategy-static-bracket`'s own exports AND what the
 *    trader then writes (`state_checkpoints.state_schema_version`,
 *    `decisions.decision_contract_version`).
 * 4. **The hazards, each as ruled**: a re-run is REFUSED with nothing written;
 *    an existing `--out` is never overwritten; an unsafe environment refuses
 *    before any CONNECTION (a counting TCP listener, with its control); a
 *    failure at the LAST repository call leaves every table at zero rows (one
 *    transaction); a template naming identities, or malformed, or refused by
 *    the trader's own doors, is refused before any connection; the two
 *    content-addressed rows are reused and the three identities are not; a
 *    failure to REPORT after COMMIT is never reported as "nothing was
 *    registered"; a connection cut (a byte-relaying proxy) DURING a repository
 *    call registers nothing, and one cut at the COMMIT — after the server
 *    committed, or instead of the COMMIT — is reported as an UNKNOWN outcome
 *    with the document KEPT, which the trader's own registration check then
 *    accepts, or refuses, as the rows say.
 * 5. **Non-vacuity of the round trip**: the completed document with ONE
 *    registered field broken is refused by the trader's registration check.
 *
 * ## Docker
 *
 * Testcontainers, as the other `*-postgres` files in this suite: its own
 * `beforeAll`, no `globalSetup`, no skip when Docker is absent. Throwaway
 * credentials that live only for the run (§0.2, ADR-010); `PAPER` throughout;
 * no venue, no signer, no real order. One fresh database per scenario, so no
 * scenario can pass on rows another created.
 */

import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import { uuidV7 } from "@polymarket-bot/storage-postgres";
import {
  STATIC_BRACKET_NAME,
  STATIC_BRACKET_STATE_SCHEMA_VERSION,
  STATIC_BRACKET_VERSION,
} from "@polymarket-bot/strategy-static-bracket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../../apps/trader/src/main.js";
import { REGISTER_EXIT_CODES, runRegisterCommand } from "../../../apps/trader/src/register/main.js";
import { STATIC_BRACKET_DEFINITION } from "../../../apps/trader/src/register/registration.js";
import { recordedEvents, strategyParams, traderConfig } from "./support/fixture.js";
import {
  CODE_COMMIT,
  CREATED_BY,
  NO_LABEL,
  NO_TOKEN,
  OUTER_COMMIT_MESSAGE,
  QUESTION_TITLE,
  START_RUN_INSERT,
  Scratch,
  YES_LABEL,
  YES_TOKEN,
  ZERO_ROWS,
  assemble,
  conditionFor,
  printedIdentities,
  registerArgv,
  registerEnvironment,
  registrationRowCounts,
  runRegister,
  templateFor,
  unsafeEnvironment,
  withConnectionCounter,
  withCuttingProxy,
} from "./support/register-command.js";
import { registerThroughTheRepositories, withFreshDatabase as withFreshDatabaseOn, type Fresh } from "./support/registration.js";

let container: Awaited<ReturnType<typeof startPostgresContainer>>;
const scratch = new Scratch("postgres");

beforeAll(async () => {
  container = await startPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
  await scratch.remove();
});

async function withFreshDatabase<T>(label: string, run: (fresh: Fresh) => Promise<T>): Promise<T> {
  return await withFreshDatabaseOn(container.getConnectionUri(), label, run);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** A template and an output path in a directory of the scenario's own. */
async function scenario(label: string, template: unknown = templateFor(label)) {
  const directory = await scratch.directory(label);
  const templatePath = await scratch.write(directory, "template.json", template);
  return { directory, template: templatePath, out: path.join(directory, "completed.json") };
}

describe("the registration command composes with the durable trader (REGISTER-1)", () => {
  it("registers through the WP-040 repositories; the completed document assembles, passes the registration check, and the trader DECIDES", async () => {
    await withFreshDatabase("reg1-round-trip", async ({ connectionString, context }) => {
      const files = await scenario("round-trip");
      const run = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-round-trip" }),
        registerEnvironment(connectionString),
      );
      expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.registered);
      const ids = printedIdentities(run);
      expect(ids.completedDocument).toBe(files.out);
      expect(ids.definitionReused).toBe(false);
      expect(ids.configReused).toBe(false);
      expect(ids.configVersion).toBe(1);
      expect(run.log).toContain("safety: OK");
      expect(run.log).toContain("template: OK");
      expect(run.log).toContain(`committed: catalog.markets ${ids.marketId}`);
      // The command says what it did NOT do (UNIV4-R1).
      expect(run.log).toContain("REMINDER (UNIV4-R1): this command did NOT verify any gammaMarketId");

      // --- the completed document: the template, plus the minted identities ---
      const completed = JSON.parse(await readFile(files.out, "utf8")) as Record<string, unknown>;
      const template = templateFor("round-trip");
      const completedMarket = (completed["markets"] as Record<string, unknown>[])[0];
      const completedInstance = (completed["instances"] as Record<string, unknown>[])[0];
      expect(completedMarket?.["marketId"]).toBe(ids.marketId);
      expect(completedInstance?.["instanceId"]).toBe(ids.instanceId);
      expect(completedInstance?.["runId"]).toBe(ids.runId);
      expect(completedInstance?.["configId"]).toBe(ids.configId);
      expect(completedInstance?.["marketId"]).toBe(ids.marketId);
      expect({
        ...completed,
        markets: [{ ...completedMarket, marketId: undefined }],
        instances: [
          { ...completedInstance, instanceId: undefined, runId: undefined, configId: undefined, marketId: undefined },
        ],
      }).toEqual({
        ...template,
        markets: [{ ...(template["markets"] as Record<string, unknown>[])[0], marketId: undefined }],
        instances: [
          {
            ...(template["instances"] as Record<string, unknown>[])[0],
            instanceId: undefined,
            runId: undefined,
            configId: undefined,
            marketId: undefined,
          },
        ],
      });

      // --- the durable trader's own assembly, on the completed document --------
      const { result, log } = await assemble(completed, connectionString);
      expect(result.ok ? "ok" : log).toBe("ok");
      if (!result.ok) throw new Error("unreachable");
      expect(log).toContain("registration: OK");
      expect(log).toContain(`manifest: 0 ${ids.instanceId} OWNER`);
      const { trader, store } = result;
      try {
        for (const event of recordedEvents(ids.marketId, conditionFor("round-trip"))) {
          expect(trader.loop.ingest(event)).toBe(true);
        }
        await trader.loop.drain();
        const health = trader.loop.health();
        expect(health.halts).toEqual([]);
        expect(health.loop.decisionsPersisted).toBeGreaterThanOrEqual(1);

        // The trader DECIDED, and its decisions and checkpoints landed against
        // the rows the command registered.
        const decisions = await context.db
          .selectFrom("strategy.decisions")
          .selectAll()
          .where("run_id", "=", ids.runId)
          .execute();
        expect(decisions.length).toBe(trader.loop.decisions().length);
        expect(decisions.length).toBeGreaterThanOrEqual(1);
        expect(decisions.some((row) => row.decision_type === "enter")).toBe(true);
        const checkpoints = await context.db
          .selectFrom("strategy.state_checkpoints")
          .selectAll()
          .where("run_id", "=", ids.runId)
          .execute();
        expect(checkpoints.length).toBeGreaterThanOrEqual(1);

        // --- the definition states the strategy the trader RUNS ---------------
        const definition = await context.db
          .selectFrom("strategy.definitions")
          .selectAll()
          .where("definition_id", "=", ids.definitionId)
          .executeTakeFirstOrThrow();
        expect(definition.strategy_name).toBe(STATIC_BRACKET_NAME);
        expect(definition.code_version).toBe(STATIC_BRACKET_VERSION);
        expect(definition.state_schema_version).toBe(STATIC_BRACKET_STATE_SCHEMA_VERSION);
        for (const row of checkpoints) {
          expect(row.instance_id).toBe(ids.instanceId);
          expect(row.state_schema_version).toBe(definition.state_schema_version);
        }
        for (const row of decisions) {
          expect(row.instance_id).toBe(ids.instanceId);
          expect(row.market_id).toBe(ids.marketId);
          expect(row.decision_contract_version).toBe(definition.decision_contract_version);
        }
        // …and the mirror in the command is the package's own value.
        expect(STATIC_BRACKET_DEFINITION.strategyName).toBe(STATIC_BRACKET_NAME);
        expect(STATIC_BRACKET_DEFINITION.codeVersion).toBe(STATIC_BRACKET_VERSION);
        expect(STATIC_BRACKET_DEFINITION.stateSchemaVersion).toBe(STATIC_BRACKET_STATE_SCHEMA_VERSION);
      } finally {
        await store.close();
      }
    });
  }, 180_000);

  it("writes each row as the document and the flags state it — and the config row BOOT-1's hand registration writes for the same document", async () => {
    const params = strategyParams();
    const commandRows = await withFreshDatabase("reg1-rows", async ({ connectionString, context }) => {
      const files = await scenario("rows");
      const run = await runRegister(
        registerArgv({
          template: files.template,
          out: files.out,
          instanceName: "static-bracket-rows",
          negRisk: "true",
          tradingDelaySeconds: "3",
          lifecycleState: "DISCOVERED",
        }),
        registerEnvironment(connectionString),
      );
      expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.registered);
      const ids = printedIdentities(run);
      const fixtureMarket = (traderConfig()["markets"] as Record<string, unknown>[])[0];
      if (fixtureMarket === undefined) throw new Error("fixture lost its market");

      const market = await context.db
        .selectFrom("catalog.markets")
        .selectAll()
        .where("market_id", "=", ids.marketId)
        .executeTakeFirstOrThrow();
      expect(market.condition_id).toBe(conditionFor("rows"));
      expect(market.question_title).toBe(QUESTION_TITLE);
      expect(market.neg_risk).toBe(true);
      expect(market.trading_delay_seconds).toBe(3);
      expect(market.lifecycle_state).toBe("DISCOVERED");
      expect(market.tick_size).toBe(fixtureMarket["tickSize"]);
      expect(market.minimum_order_size).toBe(fixtureMarket["minimumOrderSize"]);
      expect(Date.parse(String(market.open_time))).toBe(Date.parse(String(fixtureMarket["openTime"])));
      expect(Date.parse(String(market.close_time))).toBe(Date.parse(String(fixtureMarket["closeTime"])));
      expect(market.current_parameters_version).toBe(1);

      const tokens = await context.db
        .selectFrom("catalog.market_tokens")
        .select(["token_id", "outcome_side", "outcome_label"])
        .where("market_id", "=", ids.marketId)
        .orderBy("token_id")
        .execute();
      expect(tokens).toEqual([
        { token_id: YES_TOKEN, outcome_side: "YES", outcome_label: YES_LABEL },
        { token_id: NO_TOKEN, outcome_side: "NO", outcome_label: NO_LABEL },
      ]);
      const history = await context.db
        .selectFrom("catalog.market_parameter_history")
        .selectAll()
        .where("market_id", "=", ids.marketId)
        .execute();
      expect(history).toHaveLength(1);
      expect(history[0]?.parameters_version).toBe(1);
      expect(history[0]?.neg_risk).toBe(true);
      expect(history[0]?.trading_delay_seconds).toBe(3);

      const instance = await context.db
        .selectFrom("strategy.instances")
        .selectAll()
        .where("instance_id", "=", ids.instanceId)
        .executeTakeFirstOrThrow();
      expect(instance.instance_name).toBe("static-bracket-rows");
      expect(instance.environment).toBe("PAPER");
      expect(instance.account_ref).toBe("paper-account");
      expect(instance.default_ownership_mode).toBe("LIVE_OWNER");
      expect(instance.evaluation_priority).toBe(0);
      expect(instance.status).toBe("ACTIVE");
      expect(instance.definition_id).toBe(ids.definitionId);
      expect(instance.config_id).toBe(ids.configId);

      const runRow = await context.db
        .selectFrom("strategy.runs")
        .selectAll()
        .where("run_id", "=", ids.runId)
        .executeTakeFirstOrThrow();
      expect(runRow.environment).toBe("PAPER");
      expect(runRow.status).toBe("RUNNING");
      expect(runRow.run_seed).toBe("424242");
      expect(runRow.code_commit).toBe(CODE_COMMIT);
      expect(runRow.instance_id).toBe(ids.instanceId);
      expect(runRow.config_id).toBe(ids.configId);
      expect(runRow.definition_id).toBe(ids.definitionId);
      expect(runRow.state_schema_version).toBe(STATIC_BRACKET_STATE_SCHEMA_VERSION);

      const config = await context.db
        .selectFrom("strategy.configs")
        .selectAll()
        .where("config_id", "=", ids.configId)
        .executeTakeFirstOrThrow();
      expect(config.created_by).toBe(CREATED_BY);
      expect(config.config_version).toBe(1);
      return { parameters: config.parameters, parametersHash: config.parameters_hash };
    });

    // The params exactly as the document states them, numbers as their decimal
    // strings: `version` 1 → "1", `maximum_entries_per_market` 1 → "1", …
    const reentry = (commandRows.parameters as Record<string, Record<string, unknown>>)["reentry"];
    expect(reentry).toEqual({ maximum_entries_per_market: "1", cooldown_seconds: "30" });
    expect((commandRows.parameters as Record<string, unknown>)["strategy"]).toBe(params["strategy"]);
    expect((commandRows.parameters as Record<string, unknown>)["version"]).toBe("1");

    // BOOT-1's hand registration of the SAME params, in a database of its own.
    const handRows = await withFreshDatabase("reg1-rows-by-hand", async ({ context }) => {
      const registered = await registerThroughTheRepositories(context, "rows-by-hand", { params });
      const config = await context.db
        .selectFrom("strategy.configs")
        .selectAll()
        .where("config_id", "=", registered.configId)
        .executeTakeFirstOrThrow();
      return { parameters: config.parameters, parametersHash: config.parameters_hash };
    });
    expect(commandRows.parameters).toEqual(handRows.parameters);
    expect(commandRows.parametersHash).toBe(handRows.parametersHash);
    // …and the hash is the sha256 of the document's own rendering.
    expect(commandRows.parametersHash).toBe(
      createHash("sha256").update(JSON.stringify(renderedParams(params)), "utf8").digest("hex"),
    );
  }, 180_000);

  it("REFUSES a re-run: nothing is written, the existing identities are named, the output is not created", async () => {
    await withFreshDatabase("reg1-rerun", async ({ connectionString, context }) => {
      const files = await scenario("rerun");
      const first = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-rerun" }),
        registerEnvironment(connectionString),
      );
      expect(first.code, first.log).toBe(REGISTER_EXIT_CODES.registered);
      const ids = printedIdentities(first);
      const before = await registrationRowCounts(context.db);
      const completedBefore = await readFile(files.out, "utf8");

      // The same command again, to a new output path.
      const again = path.join(files.directory, "again.json");
      const second = await runRegister(
        registerArgv({ template: files.template, out: again, instanceName: "static-bracket-rerun" }),
        registerEnvironment(connectionString),
      );
      expect(second.code, second.log).toBe(REGISTER_EXIT_CODES.refused);
      expect(second.printed).toBe("");
      expect(second.log).toContain("REFUSING TO REGISTER: REGISTER_DUPLICATE");
      expect(second.log).toContain(
        `catalog.markets: condition_id "${conditionFor("rerun")}" is already registered as market_id ${ids.marketId}`,
      );
      expect(second.log).toContain(`catalog.market_tokens: token_id ${YES_TOKEN} is already registered to market_id ${ids.marketId}`);
      expect(second.log).toContain(`catalog.market_tokens: token_id ${NO_TOKEN} is already registered to market_id ${ids.marketId}`);
      expect(second.log).toContain(
        `strategy.instances: the PAPER instance_name "static-bracket-rerun" is already registered as instance_id ${ids.instanceId}`,
      );
      expect(second.log).not.toContain("committed:");
      expect(await registrationRowCounts(context.db)).toEqual(before);
      expect(await exists(again)).toBe(false);
      expect(await readFile(files.out, "utf8")).toBe(completedBefore);

      // A NEW market under the SAME instance name is refused on the name alone.
      const other = await scenario(
        "rerun-other-market",
        templateFor("rerun-other-market", { market: { yesTokenId: "333", noTokenId: "444" } }),
      );
      const third = await runRegister(
        registerArgv({ template: other.template, out: other.out, instanceName: "static-bracket-rerun" }),
        registerEnvironment(connectionString),
      );
      expect(third.code, third.log).toBe(REGISTER_EXIT_CODES.refused);
      expect(third.log).toContain("REGISTER_DUPLICATE");
      expect(third.log).toContain(`strategy.instances: the PAPER instance_name "static-bracket-rerun"`);
      expect(third.log).not.toContain("catalog.markets: condition_id");
      expect(await registrationRowCounts(context.db)).toEqual(before);
      expect(await exists(other.out)).toBe(false);
    });
  }, 180_000);

  it("REUSES the definition and the config for a second deployment with the same parameters; the market, instance and run are new", async () => {
    await withFreshDatabase("reg1-reuse", async ({ connectionString, context }) => {
      const a = await scenario("reuse-a");
      const first = await runRegister(
        registerArgv({ template: a.template, out: a.out, instanceName: "static-bracket-reuse-a" }),
        registerEnvironment(connectionString),
      );
      expect(first.code, first.log).toBe(REGISTER_EXIT_CODES.registered);
      const firstIds = printedIdentities(first);

      const b = await scenario("reuse-b", templateFor("reuse-b", { market: { yesTokenId: "333", noTokenId: "444" } }));
      const second = await runRegister(
        registerArgv({ template: b.template, out: b.out, instanceName: "static-bracket-reuse-b" }),
        registerEnvironment(connectionString),
      );
      expect(second.code, second.log).toBe(REGISTER_EXIT_CODES.registered);
      const secondIds = printedIdentities(second);
      expect(secondIds.definitionReused).toBe(true);
      expect(secondIds.configReused).toBe(true);
      expect(secondIds.definitionId).toBe(firstIds.definitionId);
      expect(secondIds.configId).toBe(firstIds.configId);
      expect(secondIds.marketId).not.toBe(firstIds.marketId);
      expect(secondIds.instanceId).not.toBe(firstIds.instanceId);
      expect(secondIds.runId).not.toBe(firstIds.runId);
      expect(second.log).toContain(`strategy.definitions: REUSED definition_id ${firstIds.definitionId}`);
      expect(second.log).toContain(`strategy.configs: REUSED config_id ${firstIds.configId}`);

      // Different parameters: the definition is reused, the config is a new version.
      const c = await scenario(
        "reuse-c",
        templateFor("reuse-c", {
          market: { yesTokenId: "555", noTokenId: "666" },
          instance: { params: { ...strategyParams(), reentry: { maximum_entries_per_market: 1, cooldown_seconds: 31 } } },
        }),
      );
      const third = await runRegister(
        registerArgv({ template: c.template, out: c.out, instanceName: "static-bracket-reuse-c" }),
        registerEnvironment(connectionString),
      );
      expect(third.code, third.log).toBe(REGISTER_EXIT_CODES.registered);
      const thirdIds = printedIdentities(third);
      expect(thirdIds.definitionReused).toBe(true);
      expect(thirdIds.configReused).toBe(false);
      expect(thirdIds.configVersion).toBe(2);

      expect(await registrationRowCounts(context.db)).toEqual({
        "catalog.markets": 3,
        "catalog.market_tokens": 6,
        "catalog.market_parameter_history": 3,
        "strategy.definitions": 1,
        "strategy.configs": 2,
        "strategy.instances": 3,
        "strategy.runs": 3,
      });
      // Every completed document passes the trader's registration check.
      for (const files of [a, b, c]) {
        const completed = JSON.parse(await readFile(files.out, "utf8")) as unknown;
        const { result, log } = await assemble(completed, connectionString);
        expect(result.ok ? "ok" : log).toBe("ok");
        expect(log).toContain("registration: OK");
        if (result.ok) await result.store.close();
      }
    });
  }, 180_000);

  it("a failure to REPORT after COMMIT is said as that — never as the 'nothing was registered' of a failure before COMMIT — and exits 0", async () => {
    await withFreshDatabase("reg1-report", async ({ connectionString, context }) => {
      const files = await scenario("report");
      const lines: string[] = [];
      const code = await runRegisterCommand({
        argv: registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-report" }),
        env: registerEnvironment(connectionString),
        log: (line) => {
          lines.push(line);
        },
        // stdout closed under the operator: the JSON line cannot be printed.
        print: () => {
          throw new Error("stdout is closed");
        },
        nowMs: () => Date.now(),
      });
      const log = lines.join("\n");
      expect(code, log).toBe(REGISTER_EXIT_CODES.registered);
      expect(log).toContain("committed: catalog.markets");
      expect(log).toContain(
        `REGISTER_REPORT_FAILED: the registration COMMITTED and ${files.out} was written, but reporting it failed (Error: stdout is closed)`,
      );
      expect(log).not.toContain("nothing was registered");
      expect(log).not.toContain("REGISTER_DATABASE_UNAVAILABLE");
      expect(log).not.toContain("REGISTER_FAILED_UNEXPECTEDLY");
      // …and it is true: the rows landed, and the document names them.
      expect(await registrationRowCounts(context.db)).toEqual({
        "catalog.markets": 1,
        "catalog.market_tokens": 2,
        "catalog.market_parameter_history": 1,
        "strategy.definitions": 1,
        "strategy.configs": 1,
        "strategy.instances": 1,
        "strategy.runs": 1,
      });
      const completed = JSON.parse(await readFile(files.out, "utf8")) as Record<string, unknown>;
      const run = await context.db.selectFrom("strategy.runs").select("run_id").executeTakeFirstOrThrow();
      expect((completed["instances"] as Record<string, unknown>[])[0]?.["runId"]).toBe(run.run_id);
    });
  }, 180_000);

  it("is ONE transaction: a failure at the LAST repository call (startRun) leaves every table at zero rows and no output", async () => {
    await withFreshDatabase("reg1-atomic", async ({ connectionString, context }) => {
      const files = await scenario("atomic");
      // `strategy.runs.code_commit` is `internal.identifier` (1-200 characters):
      // 201 passes the command line and is refused by the database at the
      // fifth and last write, after the market, definition, config and
      // instance were written inside the same transaction.
      const run = await runRegister(
        registerArgv({
          template: files.template,
          out: files.out,
          instanceName: "static-bracket-atomic",
          codeCommit: "c".repeat(201),
        }),
        registerEnvironment(connectionString),
      );
      expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.refused);
      // The four earlier writes DID run…
      expect(run.log).toContain("catalog.markets: registered market_id");
      expect(run.log).toContain("strategy.definitions: registered definition_id");
      expect(run.log).toContain("strategy.configs: registered config_id");
      expect(run.log).toContain("strategy.instances: registered instance_id");
      expect(run.log).not.toContain("strategy.runs: started");
      expect(run.log).toContain("REGISTER_REFUSED_BY_DATABASE");
      expect(run.log).toContain("SQLSTATE 23514");
      expect(run.log).not.toContain("committed:");
      expect(run.printed).toBe("");
      // …and none of them landed.
      expect(await registrationRowCounts(context.db)).toEqual(ZERO_ROWS);
      expect(await exists(files.out)).toBe(false);

      // The same template with a valid commit then registers: nothing was left
      // behind to collide with.
      const retry = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-atomic" }),
        registerEnvironment(connectionString),
      );
      expect(retry.code, retry.log).toBe(REGISTER_EXIT_CODES.registered);
    });
  }, 180_000);
});

describe("a database connection that dies mid-registration (REGISTER-1)", () => {
  it("cut DURING a repository call (startRun's insert): exit 69, nothing registered, no output — and the process survives pg's client `error` event", async () => {
    await withFreshDatabase("reg1-cut-mid", async ({ connectionString, context }) => {
      const files = await scenario("cut-mid");
      await withCuttingProxy(connectionString, { match: START_RUN_INSERT, cut: "INSTEAD_OF_FORWARDING" }, async (url, cuts) => {
        const run = await runRegister(
          registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-cut-mid" }),
          registerEnvironment(url),
        );
        expect(cuts()).toBe(1);
        expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.databaseUnavailable);
        expect(run.log).toContain("strategy.instances: registered instance_id");
        expect(run.log).not.toContain("strategy.runs: started");
        expect(run.log).toContain("REFUSING TO REGISTER: REGISTER_DATABASE_UNAVAILABLE: the database stopped answering");
        expect(run.log).not.toContain("committed:");
        expect(run.printed).toBe("");
      });
      expect(await registrationRowCounts(context.db)).toEqual(ZERO_ROWS);
      expect(await exists(files.out)).toBe(false);
    });
  }, 180_000);

  it("cut AFTER the server COMMITTED: exit 69 as an UNKNOWN outcome; the rows landed, and the KEPT document passes the trader's registration check", async () => {
    await withFreshDatabase("reg1-cut-after-commit", async ({ connectionString, context }) => {
      const files = await scenario("cut-after-commit");
      await withCuttingProxy(connectionString, { match: OUTER_COMMIT_MESSAGE, cut: "AFTER_THE_SERVER_ANSWERS" }, async (url, cuts) => {
        const run = await runRegister(
          registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-cut-after" }),
          registerEnvironment(url),
        );
        expect(cuts()).toBe(1);
        expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.databaseUnavailable);
        expect(run.log).toContain("REGISTER_COMMIT_OUTCOME_UNKNOWN: the connection failed during COMMIT");
        expect(run.log).toContain(`The completed document was KEPT at ${files.out}`);
        expect(run.log).not.toContain("committed:");
        expect(run.printed).toBe("");
      });
      // The rows DID land…
      expect(await registrationRowCounts(context.db)).toEqual({
        "catalog.markets": 1,
        "catalog.market_tokens": 2,
        "catalog.market_parameter_history": 1,
        "strategy.definitions": 1,
        "strategy.configs": 1,
        "strategy.instances": 1,
        "strategy.runs": 1,
      });
      // …and the kept document is the one to start from: the trader accepts it.
      const kept = JSON.parse(await readFile(files.out, "utf8")) as unknown;
      const { result, log } = await assemble(kept, connectionString);
      expect(result.ok ? "ok" : log).toBe("ok");
      expect(log).toContain("registration: OK");
      if (result.ok) await result.store.close();
    });
  }, 180_000);

  it("cut INSTEAD of the COMMIT: exit 69 as an UNKNOWN outcome; nothing landed, the trader refuses the KEPT document, and after deleting it a re-run registers", async () => {
    await withFreshDatabase("reg1-cut-commit", async ({ connectionString, context }) => {
      const files = await scenario("cut-commit");
      const argv = registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-cut-commit" });
      await withCuttingProxy(connectionString, { match: OUTER_COMMIT_MESSAGE, cut: "INSTEAD_OF_FORWARDING" }, async (url, cuts) => {
        const run = await runRegister(argv, registerEnvironment(url));
        expect(cuts()).toBe(1);
        expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.databaseUnavailable);
        expect(run.log).toContain("REGISTER_COMMIT_OUTCOME_UNKNOWN");
        expect(run.printed).toBe("");
      });
      expect(await registrationRowCounts(context.db)).toEqual(ZERO_ROWS);
      // The kept document names rows that never landed: the trader's own check
      // says so, which is the arbiter the command's message points to.
      const kept = JSON.parse(await readFile(files.out, "utf8")) as unknown;
      const { result, log } = await assemble(kept, connectionString);
      expect(result.ok).toBe(false);
      expect(log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISSING");
      // The message's remedy: delete the document, run again.
      await rm(files.out);
      const retry = await runRegister(argv, registerEnvironment(connectionString));
      expect(retry.code, retry.log).toBe(REGISTER_EXIT_CODES.registered);
    });
  }, 180_000);
});

describe("the registration command refuses before it connects (REGISTER-1)", () => {
  it("an UNSAFE environment is refused before any connection is ATTEMPTED — and the counter that shows it does count", async () => {
    const files = await scenario("unsafe");
    await withConnectionCounter(async (databaseUrl, connections) => {
      const refused = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-unsafe" }),
        unsafeEnvironment(databaseUrl),
      );
      expect(refused.code, refused.log).toBe(REGISTER_EXIT_CODES.unsafeEnvironment);
      expect(refused.log).toContain("REFUSING TO REGISTER: REGISTER_UNSAFE_ENVIRONMENT");
      expect(refused.log).toContain("No file was read and no connection was attempted.");
      for (const code of [
        "PAPER_RUN_MODE_CEILING_RAISED",
        "PAPER_RUN_MODE_NOT_PERMITTED",
        "PAPER_REAL_ORDERS_ENABLED",
        "PAPER_LIVE_MICRO_CAP_NONZERO",
      ]) {
        expect(refused.log).toContain(code);
      }
      expect(refused.log).not.toContain("safety: OK");
      expect(refused.log).not.toContain("template: OK");
      expect(connections()).toBe(0);

      // Control: the same command in a SAFE environment does reach the
      // listener, which hangs up, and is refused as an unavailable database.
      const control = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-unsafe" }),
        registerEnvironment(databaseUrl),
      );
      expect(control.code, control.log).toBe(REGISTER_EXIT_CODES.databaseUnavailable);
      expect(control.log).toContain("REGISTER_DATABASE_UNAVAILABLE");
      expect(connections()).toBeGreaterThanOrEqual(1);
    });
    expect(await exists(files.out)).toBe(false);

    // Against a REAL migrated database: nothing registered.
    await withFreshDatabase("reg1-unsafe", async ({ connectionString, context }) => {
      const refused = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-unsafe" }),
        unsafeEnvironment(connectionString),
      );
      expect(refused.code).toBe(REGISTER_EXIT_CODES.unsafeEnvironment);
      expect(await registrationRowCounts(context.db)).toEqual(ZERO_ROWS);
      expect(await exists(files.out)).toBe(false);
    });
  }, 120_000);

  it("never overwrites an existing --out: refused with 73 before any connection, the file byte-identical", async () => {
    const files = await scenario("existing-out");
    await writeFile(files.out, "an operator's file\n");
    await withConnectionCounter(async (databaseUrl, connections) => {
      const run = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-existing-out" }),
        registerEnvironment(databaseUrl),
      );
      expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.outputNotCreatable);
      expect(run.log).toContain("REGISTER_OUTPUT_NOT_CREATABLE");
      expect(run.log).toContain("already exists, and this command never overwrites a file");
      expect(connections()).toBe(0);
    });
    expect(await readFile(files.out, "utf8")).toBe("an operator's file\n");
  }, 60_000);

  it("refuses a template that NAMES identities — a completed document is not a template", async () => {
    const files = await scenario("has-ids", traderConfig());
    await withConnectionCounter(async (databaseUrl, connections) => {
      const run = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-has-ids" }),
        registerEnvironment(databaseUrl),
      );
      expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.refused);
      expect(run.log).toContain("REGISTER_TEMPLATE_HAS_IDENTITIES");
      for (const field of [
        "markets[0].marketId",
        "instances[0].instanceId",
        "instances[0].runId",
        "instances[0].configId",
        "instances[0].marketId",
      ]) {
        expect(run.log).toContain(`${field} is present`);
      }
      expect(connections()).toBe(0);
    });
    expect(await exists(files.out)).toBe(false);
  }, 60_000);

  it("refuses a malformed template, or one the trader's own doors refuse, before any connection", async () => {
    const withoutParamsStrategy = templateFor("malformed-strategy");
    const instance = (withoutParamsStrategy["instances"] as Record<string, unknown>[])[0];
    const cases: readonly { readonly name: string; readonly template: unknown; readonly code: string; readonly says: string }[] = [
      { name: "not-json", template: "{ this is not json", code: "REGISTER_TEMPLATE_UNREADABLE", says: "the template is not JSON" },
      { name: "an-array", template: [], code: "REGISTER_TEMPLATE_UNREADABLE", says: "is not a JSON object" },
      {
        name: "two-instances",
        template: { ...templateFor("two"), instances: [instance, instance] },
        code: "REGISTER_TEMPLATE_UNREADABLE",
        says: "instances: must be an array holding exactly one instance object",
      },
      {
        name: "live-environment",
        template: templateFor("live", { document: { environment: "LIVE" } }),
        code: "REGISTER_TEMPLATE_INVALID",
        says: "environment",
      },
      {
        name: "strategy-refuses",
        template: templateFor("strategy", {
          instance: { params: { ...strategyParams(), strategy: "some-other-strategy" } },
        }),
        code: "REGISTER_TEMPLATE_REFUSED_BY_TRADER",
        says: "TRADER_INSTANCE_INVALID",
      },
      {
        name: "live-micro-cap",
        template: templateFor("caps", {
          document: {
            allocatorCaps: {
              globalAccountCap: "10000",
              perStrategyCap: "1000",
              liveMicroMaxOrderNotional: "5",
              liveMicroMaxAccountExposure: "0",
            },
          },
        }),
        code: "REGISTER_TEMPLATE_REFUSED_BY_TRADER",
        says: "TRADER_ALLOCATOR_CAPS_REFUSED",
      },
      {
        name: "parameters-version",
        template: templateFor("version", { market: { parametersVersion: 2 } }),
        code: "REGISTER_TEMPLATE_NOT_REGISTRABLE",
        says: "markets[0].parametersVersion is 2",
      },
      {
        name: "float-parameter",
        template: templateFor("float", {
          instance: { params: { ...strategyParams(), reentry: { maximum_entries_per_market: 1.5, cooldown_seconds: 30 } } },
        }),
        code: "REGISTER_TEMPLATE_NOT_REGISTRABLE",
        says: "instances[0].params.reentry.maximum_entries_per_market: the number 1.5 is not a safe integer",
      },
    ];
    await withConnectionCounter(async (databaseUrl, connections) => {
      for (const entry of cases) {
        const files = await scenario(`malformed-${entry.name}`, entry.template);
        const run = await runRegister(
          registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-malformed" }),
          registerEnvironment(databaseUrl),
        );
        expect(run.code, `${entry.name}\n${run.log}`).toBe(REGISTER_EXIT_CODES.refused);
        expect(run.log, entry.name).toContain(`REFUSING TO REGISTER: ${entry.code}`);
        expect(run.log, entry.name).toContain(entry.says);
        expect(await exists(files.out), entry.name).toBe(false);
      }
      expect(connections()).toBe(0);
    });
  }, 60_000);
});

describe("non-vacuity: the trader's registration check refuses a completed document with a registered field broken", () => {
  it("a configId the run does not pin is TRADER_REGISTRATION_MISMATCH; a runId nothing registered is _MISSING", async () => {
    await withFreshDatabase("reg1-broken", async ({ connectionString, context }) => {
      const files = await scenario("broken");
      const run = await runRegister(
        registerArgv({ template: files.template, out: files.out, instanceName: "static-bracket-broken" }),
        registerEnvironment(connectionString),
      );
      expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.registered);
      const ids = printedIdentities(run);
      const completed = JSON.parse(await readFile(files.out, "utf8")) as Record<string, unknown>;
      const instance = (completed["instances"] as Record<string, unknown>[])[0];

      const otherConfig = uuidV7();
      const wrongConfig = await assemble(
        { ...completed, instances: [{ ...instance, configId: otherConfig }] },
        connectionString,
      );
      expect(wrongConfig.result.ok).toBe(false);
      if (wrongConfig.result.ok) throw new Error("a broken configId assembled");
      expect(wrongConfig.result.code).toBe(EXIT_CODES.configurationRefused);
      expect(wrongConfig.log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISMATCH");
      expect(wrongConfig.log).toContain(
        `strategy.runs ${ids.runId}: the row pins config ${ids.configId} but the configuration states configId ${otherConfig}`,
      );

      const otherRun = uuidV7();
      const wrongRun = await assemble({ ...completed, instances: [{ ...instance, runId: otherRun }] }, connectionString);
      expect(wrongRun.result.ok).toBe(false);
      expect(wrongRun.log).toContain("REFUSING TO START: TRADER_REGISTRATION_MISSING");
      expect(wrongRun.log).toContain(`strategy.runs: no row with run_id ${otherRun}`);

      // The control: the completed document as written assembles.
      const control = await assemble(completed, connectionString);
      expect(control.result.ok ? "ok" : control.log).toBe("ok");
      if (control.result.ok) await control.result.store.close();
      // Neither refusal wrote anything. (This read also makes the fixture's
      // `close()` real: `createMigratedContext.close()` is Kysely's `destroy()`,
      // which returns early when no query ever went through `context.db`,
      // leaving the migration pool open — `BOOT-1`'s recorded fixture defect.)
      expect((await context.db.selectFrom("strategy.decisions").select("decision_id").execute()).length).toBe(0);
    });
  }, 120_000);
});

/** The document's params with every number as its decimal string, key order kept. */
function renderedParams(value: unknown): unknown {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((element) => renderedParams(element));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renderedParams(inner)]));
  }
  return value;
}
