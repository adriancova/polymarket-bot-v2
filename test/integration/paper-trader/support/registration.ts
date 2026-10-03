/**
 * The operator's registration act, for the Testcontainers files that drive
 * the REAL composition root (`BOOT-1`'s
 * `durable-trader-first-fill-postgres.test.ts`, `TRDR-3`'s
 * `trader-health-endpoint-postgres.test.ts`).
 *
 * Factored out of the `BOOT-1` file by `TRDR-3` unchanged in behaviour: the
 * three parent rows every durable write references are created through the
 * SAME repositories an operator uses — `registerMarket`, `createDefinition`,
 * `createConfig`, `createInstance`, `startRun` — never through
 * `createTradingChain` (see that file's header for why), and the identities
 * THEY mint are what the configuration document names.
 *
 * `BRACKET-1c` (`durable-two-brackets-postgres-redis.test.ts`) added ONE
 * optional input, `params`: the strategy document the registered
 * `strategy.configs` row records. Absent — every earlier caller — it is the
 * fixture's `strategyParams()`, exactly as before; the two-bracket file passes
 * the params its run actually uses (`maximum_entries_per_market` 2), so the
 * registered config row and the configuration the trader runs agree.
 */

import type { DecimalSafeJsonValue } from "@polymarket-bot/storage-postgres";
import {
  createIsolatedDatabase,
  createMigratedContext,
  fixtureTimestamp,
  hashOf,
  type TestContext,
} from "@polymarket-bot/storage-postgres/testing";

import { NO_TOKEN, T_CLOSE, T_OPEN, YES_TOKEN, strategyParams, traderConfig } from "./fixture.js";

export const ACCOUNT = "paper-account";
export const CONDITION_ID = "0xcondition";
export const RUN_SEED = "424242";

/** The identities the operator's registration minted. */
export interface Registered {
  readonly marketId: string;
  readonly definitionId: string;
  readonly configId: string;
  readonly instanceId: string;
  readonly runId: string;
}

/** A migrated, UNSEEDED database of this scenario's own. */
export interface Fresh {
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
export async function withFreshDatabase<T>(
  containerUri: string,
  label: string,
  run: (fresh: Fresh) => Promise<T>,
): Promise<T> {
  const isolated = await createIsolatedDatabase(containerUri, label);
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
 * handoff. This renders every number as its decimal string so the row can
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
export async function registerThroughTheRepositories(
  context: TestContext,
  label: string,
  options: {
    readonly accountRef?: string;
    /** The §13.2 document the config row records; the fixture's own when absent. */
    readonly params?: Record<string, unknown>;
    /**
     * `CADENCE-1` (ADR-026 D1.4): the evaluation cadence the run row pins;
     * the PAPER cadence, 1000 / 5000, when absent — what every live run records.
     */
    readonly evaluationCadence?: { readonly intervalMs: number; readonly heartbeatMs: number };
  } = {},
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

  const parameters = decimalSafeDocument(options.params ?? strategyParams());
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
    accountRef: options.accountRef ?? ACCOUNT,
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
    evaluationIntervalMs: options.evaluationCadence?.intervalMs ?? 1000,
    evaluationHeartbeatMs: options.evaluationCadence?.heartbeatMs ?? 5000,
  });

  return { marketId, definitionId, configId, instanceId, runId };
}

/** The fixture configuration, naming the identities registration minted. */
export function documentFor(
  registered: Registered,
  label: string,
  overrides: {
    readonly conditionId?: string;
    readonly runSeed?: string;
    readonly instanceId?: string;
    readonly runId?: string;
    readonly configId?: string;
  } = {},
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
        instanceId: overrides.instanceId ?? registered.instanceId,
        runId: overrides.runId ?? registered.runId,
        configId: overrides.configId ?? registered.configId,
        runSeed: overrides.runSeed ?? RUN_SEED,
        marketId: registered.marketId,
      },
    ],
  });
}
