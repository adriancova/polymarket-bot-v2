/**
 * Configuration for the research worker.
 *
 * Read from the environment once, at startup, and validated eagerly: a worker
 * that starts with a wrong WAL path and discovers it an hour later has already
 * published a misleading "compaction lag: 0".
 *
 * ## Safety
 *
 * This process performs **no trading action of any kind**. It reads WAL files,
 * writes Parquet objects, and writes a dataset manifest. It holds no signer, no
 * API credential, and no venue connection, so the §0.2 run-mode ladder does not
 * gate it — and nothing here reads, defaults, or overrides `MAX_RUN_MODE`,
 * `ALLOW_REAL_ORDERS`, or the live-micro caps. That is deliberate: a process
 * that cannot place an order should not be in a position to relax a control
 * that governs placing orders.
 *
 * ## Retention defaults to keeping everything
 *
 * `RESEARCH_WORKER_RETENTION` defaults to `retain`. Deleting a WAL segment is
 * irreversible, ADR-004's Consequences section states that filling the disk is
 * the *intended* failure direction, and an operator who wants the space back
 * says so explicitly.
 */

export type RetentionPolicyName = "retain" | "delete-after-verified-upload";

export type ResearchWorkerConfig = {
  /** Directory the recorder writes WAL segments into. */
  readonly walDirectoryPath: string;
  /** Root of the filesystem object store. */
  readonly objectStoreRoot: string;
  /** Object-key prefix under which datasets are written. */
  readonly datasetKeyPrefix: string;
  /** Identity of the dataset produced by each cycle, as a prefix. */
  readonly datasetIdPrefix: string;
  /** Delay between compaction cycles, in milliseconds. */
  readonly intervalMs: number;
  /** Retention policy. Defaults to `retain`. */
  readonly retention: RetentionPolicyName;
  /** Optional JSON file holding the incident windows to exclude. */
  readonly incidentWindowsPath: string | null;
  /** Optional normalizer version to pin, when the gateway records one. */
  readonly normalizerVersion: string | null;
  /** Compression codec for the compacted objects. */
  readonly codec: "UNCOMPRESSED" | "SNAPPY";
  /** Rows per Parquet row group. */
  readonly rowGroupSize: number;
  /** Run one cycle and exit, instead of looping. */
  readonly runOnce: boolean;
};

export class ResearchWorkerConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = "ResearchWorkerConfigurationError";
    this.variable = variable;
  }
}

const DEFAULT_INTERVAL_MS = 60_000;
const MINIMUM_INTERVAL_MS = 1_000;
const DEFAULT_ROW_GROUP_SIZE = 10_000;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new ResearchWorkerConfigurationError(key, "is required and must not be empty");
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const raw = optional(env, key);
  if (raw === null) {
    return fallback;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new ResearchWorkerConfigurationError(key, "must be a positive integer");
  }
  const value = Number(raw);
  if (value < minimum) {
    throw new ResearchWorkerConfigurationError(key, `must be at least ${minimum}`);
  }
  return value;
}

function booleanFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = optional(env, key);
  if (raw === null) {
    return false;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  throw new ResearchWorkerConfigurationError(key, "must be one of true, false, 1, 0");
}

/** Parse and validate the worker's configuration. */
export function loadResearchWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResearchWorkerConfig {
  const retentionRaw = optional(env, "RESEARCH_WORKER_RETENTION") ?? "retain";
  if (retentionRaw !== "retain" && retentionRaw !== "delete-after-verified-upload") {
    throw new ResearchWorkerConfigurationError(
      "RESEARCH_WORKER_RETENTION",
      "must be one of retain, delete-after-verified-upload",
    );
  }

  const codecRaw = optional(env, "RESEARCH_WORKER_CODEC") ?? "UNCOMPRESSED";
  if (codecRaw !== "UNCOMPRESSED" && codecRaw !== "SNAPPY") {
    throw new ResearchWorkerConfigurationError(
      "RESEARCH_WORKER_CODEC",
      "must be one of UNCOMPRESSED, SNAPPY",
    );
  }

  return {
    walDirectoryPath: required(env, "RESEARCH_WORKER_WAL_DIR"),
    objectStoreRoot: required(env, "RESEARCH_WORKER_OBJECT_STORE_ROOT"),
    datasetKeyPrefix: optional(env, "RESEARCH_WORKER_DATASET_KEY_PREFIX") ?? "datasets",
    datasetIdPrefix: optional(env, "RESEARCH_WORKER_DATASET_ID_PREFIX") ?? "dataset",
    intervalMs: positiveInteger(
      env,
      "RESEARCH_WORKER_INTERVAL_MS",
      DEFAULT_INTERVAL_MS,
      MINIMUM_INTERVAL_MS,
    ),
    retention: retentionRaw,
    incidentWindowsPath: optional(env, "RESEARCH_WORKER_INCIDENT_WINDOWS"),
    normalizerVersion: optional(env, "RESEARCH_WORKER_NORMALIZER_VERSION"),
    codec: codecRaw,
    rowGroupSize: positiveInteger(
      env,
      "RESEARCH_WORKER_ROW_GROUP_SIZE",
      DEFAULT_ROW_GROUP_SIZE,
      1,
    ),
    runOnce: booleanFlag(env, "RESEARCH_WORKER_RUN_ONCE"),
  };
}
