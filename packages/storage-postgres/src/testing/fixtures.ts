/**
 * Fixtures for the integration suite.
 *
 * §6 invariant 4 makes every fill traceable through
 * `fill → order → submission attempt → execution plan → intent → decision`, and
 * the schema enforces that chain with foreign keys. Testing a fill constraint
 * therefore means building the whole chain, which is what these builders do —
 * the alternative would be to weaken the foreign keys for testability, which
 * would delete the invariant being tested.
 *
 * Dev-only: nothing here is imported by production code paths.
 */

import { createHash } from "node:crypto";

import type { PolymarketBotDatabase } from "../database.js";
import { createDatabase, inTransaction } from "../database.js";
import { uuidV7 } from "../ids.js";
import { migrateUp } from "../migrations/runner.js";
import { createPostgresPool } from "../pool.js";
import type { PostgresPool } from "../pool.js";
import type { Repositories } from "../repositories/index.js";
import { createRepositories } from "../repositories/index.js";
import type { RunModeValue } from "../schema/enums.js";

/** A migrated database plus its handles. */
export type TestContext = {
  readonly pool: PostgresPool;
  readonly db: PolymarketBotDatabase;
  readonly repositories: Repositories;
  readonly close: () => Promise<void>;
};

/** Connects to `connectionString`, applies every migration, and returns handles. */
export async function createMigratedContext(connectionString: string): Promise<TestContext> {
  const pool = createPostgresPool({
    connectionString,
    applicationName: "polymarket-bot-integration-test",
    maxConnections: 5,
    statementTimeoutMs: 60_000,
  });

  await migrateUp(pool, { appliedBy: "integration-test" });

  const db = createDatabase(pool);

  return {
    pool,
    db,
    repositories: createRepositories(db),
    close: async () => {
      await db.destroy();
    },
  };
}

/** Connects without migrating, for the "apply from an empty database" test. */
export function createBareContext(connectionString: string): TestContext {
  const pool = createPostgresPool({
    connectionString,
    applicationName: "polymarket-bot-integration-test",
    maxConnections: 5,
    statementTimeoutMs: 60_000,
  });
  const db = createDatabase(pool);
  return {
    pool,
    db,
    repositories: createRepositories(db),
    close: async () => {
      await db.destroy();
    },
  };
}

/** Deterministic SHA-256 hex, for fixture hash columns. */
export function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** An ISO-8601 instant offset from a fixed base, so fixtures are deterministic. */
export function fixtureTimestamp(offsetSeconds = 0): string {
  const base = Date.UTC(2026, 7, 26, 12, 0, 0);
  return new Date(base + offsetSeconds * 1000).toISOString();
}

export type TradingChain = {
  readonly seriesId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly definitionId: string;
  readonly configId: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly decisionId: string;
  readonly intentId: string;
  readonly approvedIntentId: string;
  readonly planId: string;
  readonly executionGroupId: string;
};

export type TradingChainOptions = {
  readonly environment?: RunModeValue;
  readonly accountRef?: string | null;
  readonly label?: string;
};

/**
 * Builds series → market → strategy → run → decision → intent → approved intent
 * → plan → execution group, and returns every identifier.
 */
export async function createTradingChain(
  context: TestContext,
  options: TradingChainOptions = {},
): Promise<TradingChain> {
  const environment: RunModeValue = options.environment ?? "PAPER";
  const accountRef = options.accountRef ?? "test-account";
  const label = options.label ?? uuidV7().slice(0, 8);
  const tokenId = String(1_000_000 + Math.floor(Math.random() * 1_000_000));

  const seriesId = uuidV7();
  await context.db
    .insertInto("catalog.series")
    .values({
      series_id: seriesId,
      series_key: `series-${label}`,
      display_name: `Series ${label}`,
      underlying_symbol: "BTC",
      cadence: "PT15M",
    })
    .execute();

  const marketId = await context.repositories.catalog.registerMarket({
    conditionId: `condition-${label}`,
    questionTitle: `Will BTC be up at close? (${label})`,
    seriesId,
    parameters: {
      tickSize: "0.01",
      minimumOrderSize: "5",
      tradingDelaySeconds: 0,
      negRisk: false,
      lifecycleState: "OPEN",
      openTime: fixtureTimestamp(-3600),
      closeTime: fixtureTimestamp(3600),
    },
    tokens: [
      { tokenId, outcomeSide: "YES", outcomeLabel: "Yes" },
      { tokenId: String(Number(tokenId) + 1), outcomeSide: "NO", outcomeLabel: "No" },
    ],
    source: "polymarket",
    observedAt: fixtureTimestamp(),
  });

  const definitionId = await context.repositories.strategy.createDefinition({
    strategyName: `static-bracket-${label}`,
    codeVersion: "0.1.0",
    paramsSchema: { type: "object" },
    stateSchemaVersion: 1,
    decisionContractVersion: 1,
  });

  const { configId } = await context.repositories.strategy.createConfig({
    definitionId,
    parameters: { entryOffsetTicks: "2" },
    parametersHash: hashOf(`config-${label}`),
    validatedAt: fixtureTimestamp(),
    createdBy: "fixture",
  });

  const instanceId = await context.repositories.strategy.createInstance({
    instanceName: `instance-${label}`,
    definitionId,
    configId,
    environment,
    seriesId,
    accountRef,
    defaultOwnershipMode: "LIVE_OWNER",
  });

  const runId = await context.repositories.strategy.startRun({
    instanceId,
    definitionId,
    configId,
    environment,
    codeCommit: "0000000000000000000000000000000000000000",
    stateSchemaVersion: 1,
    runSeed: "42",
  });

  const decisionId = uuidV7();
  const intentId = uuidV7();
  const approvedIntentId = uuidV7();
  const planId = uuidV7();
  const executionGroupId = uuidV7();

  await inTransaction(context.db, async (trx) => {
    await trx
      .insertInto("strategy.decisions")
      .values({
        decision_id: decisionId,
        run_id: runId,
        instance_id: instanceId,
        market_id: marketId,
        evaluation_seq: "0",
        callback: "onFeatures",
        decision_type: "enter",
        decision_contract_version: 1,
        reason_codes: ["fixture"],
        feature_snapshot_ref: `snapshot-${label}`,
        intent_count: 1,
        evaluated_at: fixtureTimestamp(),
      })
      .execute();

    await trx
      .insertInto("strategy.intents")
      .values({
        intent_id: intentId,
        decision_id: decisionId,
        run_id: runId,
        instance_id: instanceId,
        market_id: marketId,
        intent_ordinal: 0,
        intent_type: "POSITION",
        contract_version: 1,
        payload: { intentType: "POSITION", targetShares: "10" },
      })
      .execute();

    await trx
      .insertInto("strategy.approved_intents")
      .values({
        approved_intent_id: approvedIntentId,
        intent_id: intentId,
        revision: 1,
        risk_outcome: "APPROVED",
        approved_payload: { intentType: "POSITION", targetShares: "10" },
        approved_shares: "10",
      })
      .execute();

    await trx
      .insertInto("execution.plans")
      .values({
        plan_id: planId,
        approved_intent_id: approvedIntentId,
        run_id: runId,
        instance_id: instanceId,
        market_id: marketId,
        environment,
        account_ref: accountRef,
        token_id: tokenId,
        side: "BUY",
        liquidity_preference: "MAKER_PREFERRED",
        partial_fill_policy: "ACCEPT_ANY",
        planned_price: "0.42",
        planned_shares: "10",
        slice_count: 1,
        parameters_version: 1,
        tick_size: "0.01",
        plan_hash: hashOf(`plan-${label}`),
      })
      .execute();

    await trx
      .insertInto("execution.groups")
      .values({
        execution_group_id: executionGroupId,
        plan_id: planId,
        group_ordinal: 0,
        group_kind: "SLICE",
        token_id: tokenId,
        side: "BUY",
        limit_price: "0.42",
        shares: "10",
      })
      .execute();
  });

  return {
    seriesId,
    marketId,
    tokenId,
    definitionId,
    configId,
    instanceId,
    runId,
    decisionId,
    intentId,
    approvedIntentId,
    planId,
    executionGroupId,
  };
}
