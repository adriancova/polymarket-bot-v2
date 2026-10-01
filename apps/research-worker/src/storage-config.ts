/**
 * Configuration of the storage command (`STORAGE-1`): the research tier,
 * pins, and raw-WAL expiry.
 *
 * ## Deleting is never the default
 *
 * - `RESEARCH_WORKER_EXPIRY_MODE` defaults to **`dry-run`**: extract, classify,
 *   pin, plan and report, and delete nothing. Given a state directory, a dry
 *   run also makes the evidence holds it learned durable, releasing none
 *   (`evidence-holds.ts`). `execute` is an explicit word.
 * - Even in `execute`, the deletion capability refuses a WAL root that has not
 *   opted in with its marker file (`expireAfterExtractDeletion`), so pointing
 *   this command at a directory by mistake deletes nothing.
 * - The retention cannot be shortened below ADR-028's 72 hours.
 * - A state directory is required in EITHER mode (round 5, N2): what a dry
 *   run reads of the trader's rows is made durable there too, so a window
 *   pruned from the registry before the first `execute` cycle loses nothing
 *   a dry run already read.
 *
 * This process holds no signer, no venue credential and places no order; it
 * reads, writes datasets, and — only as above — deletes expired WAL segments.
 * It neither reads nor relaxes `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS` or the
 * live-micro caps.
 */

import { ResearchWorkerConfigurationError } from "./config.js";
import { DEFAULT_CLOCK_STEP_TOLERANCE_MS } from "./retention/clock-guard.js";
import { DEFAULT_PIN_BUDGET_BYTES_PER_DAY } from "./retention/metrics.js";
import { RAW_RETENTION_MS } from "./retention/plan.js";
import type { ExpiryMode } from "./retention/cycle.js";

export type StorageConfig = {
  readonly walRootPath: string;
  readonly objectStoreRoot: string;
  /** Required in either mode (round 5, N2): every cycle's evidence holds are made durable there. */
  readonly stateDirectory: string;
  readonly windowRegistryPath: string | null;
  readonly operatorPinsPath: string | null;
  readonly traderDatabaseUrl: string | null;
  readonly traderEnvironment: "PAPER" | "BACKTEST";
  readonly mode: ExpiryMode;
  readonly retentionMs: number;
  readonly leadInMs: number;
  readonly durabilityGraceMs: number;
  readonly pinBudgetBytesPerDay: number;
  readonly expiryStuckAfterMs: number;
  readonly walMaxTotalBytes: number | null;
  readonly maxSegmentsPerDataset: number;
  readonly extractionBatchDelayMs: number;
  /** Clock movement between cycles below which nothing is a step (`clock-guard.ts`). */
  readonly clockStepToleranceMs: number;
};

function value(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  return raw === undefined || raw.trim().length === 0 ? null : raw.trim();
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const raw = value(env, key);
  if (raw === null) throw new ResearchWorkerConfigurationError(key, "is required and must not be empty");
  return raw;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number): number {
  const raw = value(env, key);
  if (raw === null) return fallback;
  if (!/^[0-9]+$/u.test(raw)) throw new ResearchWorkerConfigurationError(key, "must be a non-negative integer");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new ResearchWorkerConfigurationError(key, `must be an integer of at least ${String(minimum)}`);
  }
  return parsed;
}

/** Parse and validate the storage command's configuration. */
export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const mode = value(env, "RESEARCH_WORKER_EXPIRY_MODE") ?? "dry-run";
  if (mode !== "dry-run" && mode !== "execute") {
    throw new ResearchWorkerConfigurationError("RESEARCH_WORKER_EXPIRY_MODE", "must be dry-run or execute");
  }
  const walRootPath = required(env, "RESEARCH_WORKER_WAL_ROOT");
  const objectStoreRoot = required(env, "RESEARCH_WORKER_OBJECT_STORE_ROOT");
  const stateDirectory = value(env, "RESEARCH_WORKER_STATE_DIR");
  if (stateDirectory === null) {
    throw new ResearchWorkerConfigurationError(
      "RESEARCH_WORKER_STATE_DIR",
      mode === "execute"
        ? "is required in execute mode: the expiry plan is made durable there before any deletion, and the evidence holds every cycle reads"
        : "is required in dry-run mode too: the evidence holds a dry run reads are made durable there, so a window pruned before the first execute cycle loses nothing already read",
    );
  }
  const traderEnvironment = value(env, "RESEARCH_WORKER_TRADER_ENVIRONMENT") ?? "PAPER";
  if (traderEnvironment !== "PAPER" && traderEnvironment !== "BACKTEST") {
    throw new ResearchWorkerConfigurationError("RESEARCH_WORKER_TRADER_ENVIRONMENT", "must be PAPER or BACKTEST");
  }
  const walMaxTotal = value(env, "RESEARCH_WORKER_WAL_MAX_TOTAL_BYTES");
  return {
    walRootPath,
    objectStoreRoot,
    stateDirectory,
    windowRegistryPath: value(env, "RESEARCH_WORKER_WINDOW_REGISTRY"),
    operatorPinsPath: value(env, "RESEARCH_WORKER_OPERATOR_PINS"),
    traderDatabaseUrl: value(env, "RESEARCH_WORKER_TRADER_DATABASE_URL"),
    traderEnvironment,
    mode,
    // ADR-028 Decision 2.1: at least 72 hours. A shorter value is refused.
    retentionMs: integer(env, "RESEARCH_WORKER_RAW_RETENTION_MS", RAW_RETENTION_MS, RAW_RETENTION_MS),
    leadInMs: integer(env, "RESEARCH_WORKER_PIN_LEAD_IN_MS", 15 * 60 * 1000, 0),
    durabilityGraceMs: integer(env, "RESEARCH_WORKER_DURABILITY_GRACE_MS", 60 * 1000, 0),
    pinBudgetBytesPerDay: integer(env, "RESEARCH_WORKER_PIN_BUDGET_BYTES_PER_DAY", DEFAULT_PIN_BUDGET_BYTES_PER_DAY, 1),
    expiryStuckAfterMs: integer(env, "RESEARCH_WORKER_EXPIRY_STUCK_AFTER_MS", 6 * 60 * 60 * 1000, 1),
    walMaxTotalBytes: walMaxTotal === null ? null : integer(env, "RESEARCH_WORKER_WAL_MAX_TOTAL_BYTES", 0, 1),
    maxSegmentsPerDataset: integer(env, "RESEARCH_WORKER_MAX_SEGMENTS_PER_RESEARCH_DATASET", 64, 1),
    extractionBatchDelayMs: Math.min(
      integer(env, "RESEARCH_WORKER_EXTRACTION_BATCH_DELAY_MS", 60 * 60 * 1000, 0),
      // Far below the 72 h retention: extraction must never be what holds expiry back.
      12 * 60 * 60 * 1000,
    ),
    // At most 10 minutes: a wider tolerance would let a real step through.
    clockStepToleranceMs: Math.min(
      integer(env, "RESEARCH_WORKER_CLOCK_STEP_TOLERANCE_MS", DEFAULT_CLOCK_STEP_TOLERANCE_MS, 1_000),
      10 * 60 * 1000,
    ),
  };
}
