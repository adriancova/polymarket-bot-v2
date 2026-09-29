/**
 * The registration's database half (`REGISTER-1`): the duplicate check, then the
 * five `WP-040` repository calls, all on the ONE transaction
 * `one-transaction.ts` opens.
 *
 * ## The rows, and where each value comes from
 *
 * | row | repository call | values |
 * | --- | --- | --- |
 * | `catalog.markets` + `market_tokens` + `market_parameter_history` v1 | `registerMarket` | the document's `conditionId`, `yesTokenId`/`noTokenId`, `tickSize`, `minimumOrderSize`, `openTime`/`closeTime` (strict UTC); the operator's flags for what the document does not carry |
 * | `strategy.definitions` | `createDefinition` | {@link STATIC_BRACKET_DEFINITION} — the one strategy `createPaperTrader` runs |
 * | `strategy.configs` | `createConfig` | the instance's `params`, canonically (`template.ts`), its sha256, the operator's `--created-by` |
 * | `strategy.instances` | `createInstance` | `PAPER`, `accounting.accountRef`, `ownership` (`OWNER` → `LIVE_OWNER`, `SHADOW` → `SHADOW`), `evaluationPriority` |
 * | `strategy.runs` | `startRun` | `PAPER`, `runSeed`, the operator's `--code-commit`, `RUNNING` |
 *
 * Every write goes through a repository; this module writes no SQL of its own.
 * Its reads — the duplicate check and the two content-addressed lookups — go
 * through the typed builder, as `adapters/postgres-registration.ts` does, with
 * no type assertion.
 *
 * ## Re-running is REFUSED, per table
 *
 * - **`catalog.markets` / `market_tokens` — refused if present.** A market row
 *   is a venue identity (`markets_condition_id_unique`,
 *   `market_tokens_token_unique`). A second registration of the same
 *   `conditionId` or token is either a re-run of this command or a second
 *   deployment on a market someone already registered — neither may silently
 *   reuse or shadow the first.
 * - **`strategy.instances` — refused if present.** An instance is a named
 *   deployment (`instances_name_environment_unique`), with an account and a
 *   history; re-registering its name would be a second deployment under one
 *   name.
 * - **`strategy.definitions` — REUSED when present and agreeing.** A
 *   definition is `(strategy_name, code_version)`: static-bracket 1.1.0 is ONE
 *   definition however many instances run it, and the table is append-only.
 *   Reused only if its state-schema and decision-contract versions equal
 *   {@link STATIC_BRACKET_DEFINITION}'s; a disagreement is refused.
 * - **`strategy.configs` — REUSED when the same parameters are registered.** A
 *   config is an immutable, content-addressed version
 *   (`configs_hash_unique (definition_id, parameters_hash)`). Reused only if the
 *   stored `parameters` equal the document's canonically; a row whose hash
 *   matches and whose content does not is refused (its hash would not describe
 *   it).
 * - **`strategy.runs` — always new.** A run belongs to the instance just
 *   created.
 *
 * So a re-run of the same command is refused before any write, with the
 * existing identities named. Registering a SECOND run for an existing instance
 * (`BOOT-1`'s remedy for a run that already holds decisions) is not this
 * command's; it says so.
 */

import {
  createCatalogRepository,
  createStrategyRepository,
  type MarketLifecycleStateValue,
  type OwnershipModeValue,
  type PolymarketBotDatabase,
} from "@polymarket-bot/storage-postgres";

/**
 * The `strategy.definitions` row of the ONE strategy the trader runs.
 *
 * `createPaperTrader` (`packages/trading-core/src/trader.ts`) runs
 * `staticBracketStrategy` for every instance, so that is the definition every
 * run this command registers pins. `apps/trader` does not declare
 * `@polymarket-bot/strategy-static-bracket` (the lockfile is outside
 * `REGISTER-1`'s grant), so the strategy's name, version and state-schema
 * version are MIRRORED here, and
 * `test/integration/paper-trader/register-command-postgres.test.ts` pins each
 * against the package's own export — `STATIC_BRACKET_NAME`,
 * `STATIC_BRACKET_VERSION`, `STATIC_BRACKET_STATE_SCHEMA_VERSION` — and against
 * what the assembled trader then WRITES (`strategy.state_checkpoints
 * .state_schema_version`, `strategy.decisions.decision_contract_version`). A
 * strategy release that bumps either fails that test until this row follows.
 *
 * `decisionContractVersion` is the §7.5 contract version `main.ts` hands the
 * durable store (`decisionContractVersion: 1`).
 */
export const STATIC_BRACKET_DEFINITION = Object.freeze({
  strategyName: "static-bracket",
  codeVersion: "1.1.0",
  stateSchemaVersion: 2,
  decisionContractVersion: 1,
});

/**
 * `strategy.definitions.params_schema`. Descriptive: the authority on the
 * parameters is the strategy's own validator, which the trader runs at startup
 * and this command runs in its dry assembly (`template.ts`) — a second grammar
 * here could drift from it.
 */
const PARAMS_SCHEMA = Object.freeze({
  $comment:
    "The Static Bracket §13.2 parameter document. Authority: validateStaticBracketParams " +
    "(@polymarket-bot/strategy-static-bracket), run by the trader at startup and by the " +
    "register command before it registers anything.",
  type: "object",
});

/** Everything the registration writes, decided before the transaction opens. */
export interface RegistrationPlan {
  readonly market: {
    readonly conditionId: string;
    readonly questionTitle: string;
    readonly yesTokenId: string;
    readonly noTokenId: string;
    readonly yesLabel: string;
    readonly noLabel: string;
    readonly tickSize: string;
    readonly minimumOrderSize: string;
    readonly tradingDelaySeconds: number;
    readonly negRisk: boolean;
    readonly lifecycleState: MarketLifecycleStateValue;
    readonly openTime: string;
    readonly closeTime: string;
    readonly observedAt: string;
  };
  readonly config: {
    /** The exact text `strategy.configs.parameters` receives. */
    readonly parametersText: string;
    /** sha256 hex of {@link parametersText}'s UTF-8 bytes. */
    readonly parametersHash: string;
    readonly validatedAt: string;
    readonly createdBy: string;
  };
  readonly instance: {
    readonly instanceName: string;
    readonly accountRef: string;
    readonly defaultOwnershipMode: OwnershipModeValue;
    readonly evaluationPriority: number;
  };
  readonly run: {
    readonly codeCommit: string;
    readonly runSeed: string;
  };
}

/** The identities the repositories minted (or, for the two shared rows, found). */
export interface RegisteredIdentities {
  readonly marketId: string;
  readonly definitionId: string;
  readonly definitionReused: boolean;
  readonly configId: string;
  readonly configVersion: number;
  readonly configReused: boolean;
  readonly instanceId: string;
  readonly runId: string;
}

export interface RegistrationRefusal {
  readonly code:
    /** A market, token or PAPER instance name this registration needs is already registered. */
    | "REGISTER_DUPLICATE"
    /** static-bracket 1.1.0 is registered with other versions than this command pins. */
    | "REGISTER_DEFINITION_MISMATCH"
    /** A config carries this parameters hash and different parameters. */
    | "REGISTER_CONFIG_MISMATCH";
  readonly detail: string;
  readonly issues: readonly string[];
}

export type RegistrationOutcome =
  | { readonly ok: true; readonly registered: RegisteredIdentities }
  | { readonly ok: false; readonly refusal: RegistrationRefusal };

/**
 * Runs the duplicate check and the five repository calls on `db`, which must be
 * the ONE transaction's handle. A refusal is returned before any write; a
 * database error is THROWN, and the caller rolls the transaction back.
 */
export async function registerRows(
  db: PolymarketBotDatabase,
  plan: RegistrationPlan,
  log: (line: string) => void,
): Promise<RegistrationOutcome> {
  // --- the duplicate check: every collision at once, before any write --------
  const duplicates: string[] = [];
  const market = await db
    .selectFrom("catalog.markets")
    .select(["market_id"])
    .where("condition_id", "=", plan.market.conditionId)
    .executeTakeFirst();
  if (market !== undefined) {
    duplicates.push(
      `catalog.markets: condition_id ${JSON.stringify(plan.market.conditionId)} is already ` +
        `registered as market_id ${market.market_id}`,
    );
  }
  const tokens = await db
    .selectFrom("catalog.market_tokens")
    .select(["token_id", "market_id"])
    .where("token_id", "in", [plan.market.yesTokenId, plan.market.noTokenId])
    .orderBy("token_id")
    .execute();
  for (const token of tokens) {
    duplicates.push(
      `catalog.market_tokens: token_id ${token.token_id} is already registered to market_id ` +
        token.market_id,
    );
  }
  const instance = await db
    .selectFrom("strategy.instances")
    .select(["instance_id"])
    .where("environment", "=", "PAPER")
    .where("instance_name", "=", plan.instance.instanceName)
    .executeTakeFirst();
  if (instance !== undefined) {
    duplicates.push(
      `strategy.instances: the PAPER instance_name ${JSON.stringify(plan.instance.instanceName)} ` +
        `is already registered as instance_id ${instance.instance_id}`,
    );
  }
  if (duplicates.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "REGISTER_DUPLICATE",
        detail:
          `${String(duplicates.length)} identity(ies) this registration would create already ` +
          "exist, so nothing was written: a re-run of this command is refused rather than " +
          "repeated, and a registered market or instance is never reused or shadowed. If an " +
          "earlier run of this command registered them, its completed document names them. " +
          "A NEW run for an existing instance (BOOT-1's remedy for a run that already holds " +
          "decisions) is not this command's: startRun, then point the document's runId at it",
        issues: duplicates,
      },
    };
  }

  // --- the two content-addressed rows: reused when they agree ---------------
  // Looked up before the first write too, so every refusal leaves nothing to
  // roll back but the reads.
  const existingDefinition = await db
    .selectFrom("strategy.definitions")
    .select(["definition_id", "state_schema_version", "decision_contract_version"])
    .where("strategy_name", "=", STATIC_BRACKET_DEFINITION.strategyName)
    .where("code_version", "=", STATIC_BRACKET_DEFINITION.codeVersion)
    .executeTakeFirst();
  if (
    existingDefinition !== undefined &&
    (existingDefinition.state_schema_version !== STATIC_BRACKET_DEFINITION.stateSchemaVersion ||
      existingDefinition.decision_contract_version !==
        STATIC_BRACKET_DEFINITION.decisionContractVersion)
  ) {
    return {
      ok: false,
      refusal: {
        code: "REGISTER_DEFINITION_MISMATCH",
        detail:
          `strategy.definitions already holds ${STATIC_BRACKET_DEFINITION.strategyName} ` +
          `${STATIC_BRACKET_DEFINITION.codeVersion} with other versions than the trader runs; ` +
          "the table is append-only and a run must pin the definition it executes, so nothing " +
          "was written rather than pinning the run to the wrong row",
        issues: [
          `strategy.definitions ${existingDefinition.definition_id}: state_schema_version ` +
            `${String(existingDefinition.state_schema_version)} (the trader runs ` +
            `${String(STATIC_BRACKET_DEFINITION.stateSchemaVersion)}), ` +
            `decision_contract_version ${String(existingDefinition.decision_contract_version)} ` +
            `(the trader writes ${String(STATIC_BRACKET_DEFINITION.decisionContractVersion)})`,
        ],
      },
    };
  }
  const existingConfig =
    existingDefinition === undefined
      ? undefined
      : await db
          .selectFrom("strategy.configs")
          .select(["config_id", "config_version", "parameters"])
          .where("definition_id", "=", existingDefinition.definition_id)
          .where("parameters_hash", "=", plan.config.parametersHash)
          .executeTakeFirst();
  if (existingConfig !== undefined) {
    const stored = canonicalJson(existingConfig.parameters);
    const wanted = canonicalJson(JSON.parse(plan.config.parametersText));
    if (stored !== wanted) {
      return {
        ok: false,
        refusal: {
          code: "REGISTER_CONFIG_MISMATCH",
          detail:
            `strategy.configs ${existingConfig.config_id} carries parameters_hash ` +
            `${plan.config.parametersHash} but not these parameters, so its hash does not ` +
            "describe its content; nothing was written rather than pinning a run to it",
          issues: [`stored: ${stored}`, `document: ${wanted}`],
        },
      };
    }
  }

  const catalog = createCatalogRepository(db);
  const strategy = createStrategyRepository(db);

  // --- catalog.markets (+ tokens, parameter history v1) ---------------------
  const marketId = await catalog.registerMarket({
    conditionId: plan.market.conditionId,
    questionTitle: plan.market.questionTitle,
    parameters: {
      tickSize: plan.market.tickSize,
      minimumOrderSize: plan.market.minimumOrderSize,
      tradingDelaySeconds: plan.market.tradingDelaySeconds,
      negRisk: plan.market.negRisk,
      lifecycleState: plan.market.lifecycleState,
      openTime: plan.market.openTime,
      closeTime: plan.market.closeTime,
    },
    tokens: [
      { tokenId: plan.market.yesTokenId, outcomeSide: "YES", outcomeLabel: plan.market.yesLabel },
      { tokenId: plan.market.noTokenId, outcomeSide: "NO", outcomeLabel: plan.market.noLabel },
    ],
    source: "polymarket",
    observedAt: plan.market.observedAt,
  });
  log(
    `catalog.markets: registered market_id ${marketId} (condition_id ` +
      `${JSON.stringify(plan.market.conditionId)}; tokens YES ${plan.market.yesTokenId}, ` +
      `NO ${plan.market.noTokenId}; parameters version 1) — not yet committed`,
  );

  // --- strategy.definitions: static-bracket 1.1.0 ---------------------------
  const definitionReused = existingDefinition !== undefined;
  const definitionId =
    existingDefinition === undefined
      ? await strategy.createDefinition({
          strategyName: STATIC_BRACKET_DEFINITION.strategyName,
          codeVersion: STATIC_BRACKET_DEFINITION.codeVersion,
          paramsSchema: PARAMS_SCHEMA,
          stateSchemaVersion: STATIC_BRACKET_DEFINITION.stateSchemaVersion,
          decisionContractVersion: STATIC_BRACKET_DEFINITION.decisionContractVersion,
          description:
            "The Static Bracket strategy, as apps/trader runs it (registered by its register command)",
        })
      : existingDefinition.definition_id;
  log(
    `strategy.definitions: ${definitionReused ? "REUSED" : "registered"} definition_id ` +
      `${definitionId} (${STATIC_BRACKET_DEFINITION.strategyName} ` +
      `${STATIC_BRACKET_DEFINITION.codeVersion}, state schema ` +
      `${String(STATIC_BRACKET_DEFINITION.stateSchemaVersion)}, decision contract ` +
      `${String(STATIC_BRACKET_DEFINITION.decisionContractVersion)})` +
      (definitionReused ? "" : " — not yet committed"),
  );

  // --- strategy.configs: the parameters --------------------------------------
  const configReused = existingConfig !== undefined;
  const config =
    existingConfig === undefined
      ? await strategy.createConfig({
          definitionId,
          parameters: plan.config.parametersText,
          parametersHash: plan.config.parametersHash,
          validatedAt: plan.config.validatedAt,
          createdBy: plan.config.createdBy,
        })
      : { configId: existingConfig.config_id, configVersion: existingConfig.config_version };
  const { configId, configVersion } = config;
  log(
    `strategy.configs: ${configReused ? "REUSED" : "registered"} config_id ${configId} ` +
      `(version ${String(configVersion)}, parameters_hash ${plan.config.parametersHash})` +
      (configReused ? "" : " — not yet committed"),
  );

  // --- strategy.instances ----------------------------------------------------
  const instanceId = await strategy.createInstance({
    instanceName: plan.instance.instanceName,
    definitionId,
    configId,
    environment: "PAPER",
    accountRef: plan.instance.accountRef,
    defaultOwnershipMode: plan.instance.defaultOwnershipMode,
    evaluationPriority: plan.instance.evaluationPriority,
  });
  log(
    `strategy.instances: registered instance_id ${instanceId} (PAPER, ` +
      `${JSON.stringify(plan.instance.instanceName)}, account_ref ` +
      `${JSON.stringify(plan.instance.accountRef)}, ${plan.instance.defaultOwnershipMode}, ` +
      `priority ${String(plan.instance.evaluationPriority)}) — not yet committed`,
  );

  // --- strategy.runs ---------------------------------------------------------
  const runId = await strategy.startRun({
    instanceId,
    definitionId,
    configId,
    environment: "PAPER",
    codeCommit: plan.run.codeCommit,
    stateSchemaVersion: STATIC_BRACKET_DEFINITION.stateSchemaVersion,
    runSeed: plan.run.runSeed,
  });
  log(
    `strategy.runs: started run_id ${runId} (PAPER, RUNNING, run_seed ${plan.run.runSeed}, ` +
      `code_commit ${JSON.stringify(plan.run.codeCommit)}) — not yet committed`,
  );

  return {
    ok: true,
    registered: {
      marketId,
      definitionId,
      definitionReused,
      configId,
      configVersion,
      configReused,
      instanceId,
      runId,
    },
  };
}

/**
 * A JSON value's text with every object's keys in code-unit order, so two
 * documents that differ only in key order — `jsonb` does not keep the order it
 * was given — compare equal.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, element]) => `${JSON.stringify(key)}:${canonicalJson(element)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
