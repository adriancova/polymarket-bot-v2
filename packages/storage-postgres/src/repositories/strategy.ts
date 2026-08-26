/**
 * Strategy repository (§10.3, §10.7).
 *
 * §10.7: "Immutable strategy configs and market rule versions." A config is
 * therefore created, never edited; a parameter change is a new version, and a
 * new version means a new run (§9.6: "Start a new run for every code, config,
 * model, feature, or state-schema change").
 */

import type { IsoTimestamp, UnsignedBigIntString } from "@polymarket-bot/domain";
import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import { withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import type {
  Code,
  Detail,
  Identifier,
  JsonInput,
  Sha256Hex,
  UuidV7Column,
} from "../schema/columns.js";
import type { OwnershipModeValue, RunModeValue } from "../schema/enums.js";

export type CreateDefinitionInput = {
  readonly strategyName: Code;
  readonly codeVersion: Identifier;
  readonly paramsSchema: JsonInput;
  readonly stateSchemaVersion: number;
  readonly decisionContractVersion: number;
  readonly description?: Detail | null;
};

export type CreateConfigInput = {
  readonly definitionId: UuidV7Column;
  readonly parameters: JsonInput;
  readonly parametersHash: Sha256Hex;
  readonly validatedAt: IsoTimestamp;
  readonly createdBy: Identifier;
};

export type CreateInstanceInput = {
  readonly instanceName: Code;
  readonly definitionId: UuidV7Column;
  readonly configId: UuidV7Column;
  readonly environment: RunModeValue;
  readonly seriesId?: UuidV7Column | null;
  readonly accountRef?: Identifier | null;
  readonly defaultOwnershipMode?: OwnershipModeValue;
  readonly evaluationPriority?: number;
};

export type StartRunInput = {
  readonly instanceId: UuidV7Column;
  readonly definitionId: UuidV7Column;
  readonly configId: UuidV7Column;
  readonly environment: RunModeValue;
  readonly codeCommit: Identifier;
  readonly stateSchemaVersion: number;
  readonly runSeed: UnsignedBigIntString;
  readonly featureSetId?: UuidV7Column | null;
  readonly datasetManifestId?: UuidV7Column | null;
  readonly modelVersion?: Identifier | null;
  readonly simulatorVersion?: Identifier | null;
};

export type StrategyRepository = ReturnType<typeof createStrategyRepository>;

export function createStrategyRepository(db: PolymarketBotDatabase) {
  return {
    async createDefinition(input: CreateDefinitionInput): Promise<UuidV7Column> {
      const definitionId = uuidV7();
      await withMappedErrors(async () =>
        db
          .insertInto("strategy.definitions")
          .values({
            definition_id: definitionId,
            strategy_name: input.strategyName,
            code_version: input.codeVersion,
            params_schema: input.paramsSchema,
            state_schema_version: input.stateSchemaVersion,
            decision_contract_version: input.decisionContractVersion,
            description: input.description ?? null,
          })
          .execute(),
      );
      return definitionId;
    },

    /**
     * Creates the next immutable configuration version.
     *
     * The version is allocated inside the transaction; the unique
     * `(definition_id, config_version)` constraint rejects a concurrent
     * duplicate rather than letting two configs share a version.
     */
    async createConfig(input: CreateConfigInput): Promise<{
      readonly configId: UuidV7Column;
      readonly configVersion: number;
    }> {
      return inTransaction(db, async (trx) => {
        const previous = await trx
          .selectFrom("strategy.configs")
          .select(["config_version"])
          .where("definition_id", "=", input.definitionId)
          .orderBy("config_version", "desc")
          .limit(1)
          .executeTakeFirst();

        const configVersion = (previous?.config_version ?? 0) + 1;
        const configId = uuidV7();

        await trx
          .insertInto("strategy.configs")
          .values({
            config_id: configId,
            definition_id: input.definitionId,
            config_version: configVersion,
            parameters: input.parameters,
            parameters_hash: input.parametersHash,
            validated_at: input.validatedAt,
            created_by: input.createdBy,
          })
          .execute();

        return { configId, configVersion };
      });
    },

    async createInstance(input: CreateInstanceInput): Promise<UuidV7Column> {
      const instanceId = uuidV7();
      await withMappedErrors(async () =>
        db
          .insertInto("strategy.instances")
          .values({
            instance_id: instanceId,
            instance_name: input.instanceName,
            definition_id: input.definitionId,
            config_id: input.configId,
            series_id: input.seriesId ?? null,
            environment: input.environment,
            account_ref: input.accountRef ?? null,
            default_ownership_mode: input.defaultOwnershipMode ?? "OBSERVER",
            evaluation_priority: input.evaluationPriority ?? 0,
            status: "ACTIVE",
          })
          .execute(),
      );
      return instanceId;
    },

    /** Starts a run, pinning everything §12.4 requires for determinism. */
    async startRun(input: StartRunInput): Promise<UuidV7Column> {
      const runId = uuidV7();
      await withMappedErrors(async () =>
        db
          .insertInto("strategy.runs")
          .values({
            run_id: runId,
            instance_id: input.instanceId,
            definition_id: input.definitionId,
            config_id: input.configId,
            environment: input.environment,
            code_commit: input.codeCommit,
            feature_set_id: input.featureSetId ?? null,
            dataset_manifest_id: input.datasetManifestId ?? null,
            model_version: input.modelVersion ?? null,
            state_schema_version: input.stateSchemaVersion,
            simulator_version: input.simulatorVersion ?? null,
            run_seed: input.runSeed,
            status: "RUNNING",
          })
          .execute(),
      );
      return runId;
    },

    /** Ends a run. The pinning stays immutable; only the outcome is recorded. */
    async stopRun(runId: UuidV7Column, reason: Detail): Promise<void> {
      await withMappedErrors(async () =>
        db
          .updateTable("strategy.runs")
          .set({
            status: "STOPPED",
            ended_at: sql<string>`now()`,
            stop_reason: reason,
          })
          .where("run_id", "=", runId)
          .where("status", "=", "RUNNING")
          .execute(),
      );
    },

    async findConfig(configId: UuidV7Column) {
      return withMappedErrors(async () =>
        db
          .selectFrom("strategy.configs")
          .selectAll()
          .where("config_id", "=", configId)
          .executeTakeFirst(),
      );
    },
  };
}
