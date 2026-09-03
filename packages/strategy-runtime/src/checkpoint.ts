/**
 * Versioned strategy-state checkpoints (§9.6 "Checkpoint strategy state after
 * defined transitions" / "Restore compatible state on restart").
 *
 * The defined transitions: the runtime checkpoints after EVERY persisted
 * decision record (strategy-attributed or runtime-attributed). That is a
 * superset of any narrower "state actually changed" rule and it is what keeps
 * `checkpointSeq` aligned with the decisions table's unique
 * `(run_id, evaluation_seq)` key — a restore never re-uses an evaluation
 * sequence number that already has a persisted decision.
 *
 * A checkpoint pins the full run identity (§9.6 "Start a new run for every
 * code, config, model, feature, or state-schema change"): strategy name and
 * version (code), `configId` (config), `stateSchemaVersion` (state schema),
 * and `runSeed`. Restore REFUSES on any mismatch and on any unknown
 * `checkpointSchemaVersion` — a refusal, never a silent best-effort load.
 *
 * `stateJson` is the canonical serialization (`canonicalJsonStringify`) of the
 * instance state; `rngState` is the serialized deterministic generator. State
 * is REBUILDABLE without checkpoints: it is the shallow-merge fold of every
 * persisted decision's `statePatch` over the empty object —
 * `rebuildStateFromPatches` below is that fold, and the tests pin that the
 * fold reproduces the checkpointed bytes.
 */

import { deepFreeze, canonicalJsonStringify, checkpointableJsonProblem } from "./json.js";
import { isRngState, type RngState } from "./rng.js";

export const STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION = 1;

/** Mirrors the storage vocabulary (`internal.instance_status`, WP-040). */
export type InstanceStatus = "ACTIVE" | "PAUSED" | "STOPPED";

export interface StrategyStateCheckpoint {
  readonly checkpointSchemaVersion: number;
  readonly runId: string;
  readonly instanceId: string;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly stateSchemaVersion: number;
  readonly configId: string;
  readonly runSeed: string;
  /** The `evaluationSeq` of the decision this checkpoint follows. */
  readonly checkpointSeq: number;
  readonly status: InstanceStatus;
  readonly rngState: RngState;
  /** Canonical JSON of the instance state after that evaluation. */
  readonly stateJson: string;
}

const INSTANCE_STATUSES: readonly InstanceStatus[] = ["ACTIVE", "PAUSED", "STOPPED"];

export interface CheckpointIdentity {
  readonly runId: string;
  readonly instanceId: string;
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly stateSchemaVersion: number;
  readonly configId: string;
  readonly runSeed: string;
}

export type CheckpointRefusalCode =
  | "CHECKPOINT_UNKNOWN_SCHEMA_VERSION"
  | "CHECKPOINT_RUN_MISMATCH"
  | "CHECKPOINT_STRATEGY_MISMATCH"
  | "CHECKPOINT_STATE_SCHEMA_MISMATCH"
  | "CHECKPOINT_CONFIG_MISMATCH"
  | "CHECKPOINT_SEED_MISMATCH"
  | "CHECKPOINT_SEQ_INVALID"
  | "CHECKPOINT_STATUS_INVALID"
  | "CHECKPOINT_RNG_STATE_INVALID"
  | "CHECKPOINT_STATE_INVALID";

export interface CheckpointRefusal {
  readonly code: CheckpointRefusalCode;
  readonly detail: string;
}

export interface RestoredCheckpoint {
  readonly state: Readonly<Record<string, unknown>>;
  readonly rngState: RngState;
  readonly nextEvaluationSeq: number;
  readonly status: InstanceStatus;
}

export type RestoreCheckpointResult =
  | { readonly ok: true; readonly restored: RestoredCheckpoint }
  | { readonly ok: false; readonly refusal: CheckpointRefusal };

/**
 * Validates a checkpoint document against the current run identity and
 * returns the restored state, or a typed refusal. Never throws.
 */
export function restoreCheckpoint(
  checkpoint: StrategyStateCheckpoint,
  identity: CheckpointIdentity,
): RestoreCheckpointResult {
  if (checkpoint.checkpointSchemaVersion !== STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION) {
    return refuse(
      "CHECKPOINT_UNKNOWN_SCHEMA_VERSION",
      `checkpointSchemaVersion ${String(checkpoint.checkpointSchemaVersion)} is not the ` +
        `supported version ${String(STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION)}`,
    );
  }
  if (checkpoint.runId !== identity.runId || checkpoint.instanceId !== identity.instanceId) {
    return refuse(
      "CHECKPOINT_RUN_MISMATCH",
      `checkpoint belongs to run ${checkpoint.runId} / instance ${checkpoint.instanceId}, ` +
        `not to run ${identity.runId} / instance ${identity.instanceId}`,
    );
  }
  if (
    checkpoint.strategyName !== identity.strategyName ||
    checkpoint.strategyVersion !== identity.strategyVersion
  ) {
    return refuse(
      "CHECKPOINT_STRATEGY_MISMATCH",
      `checkpoint was written by ${checkpoint.strategyName}@${checkpoint.strategyVersion}, ` +
        `not by ${identity.strategyName}@${identity.strategyVersion} — a code change starts a new run (§9.6)`,
    );
  }
  if (checkpoint.stateSchemaVersion !== identity.stateSchemaVersion) {
    return refuse(
      "CHECKPOINT_STATE_SCHEMA_MISMATCH",
      `checkpoint stateSchemaVersion ${String(checkpoint.stateSchemaVersion)} does not match ` +
        `the strategy's ${String(identity.stateSchemaVersion)} — a state-schema change starts a new run (§9.6)`,
    );
  }
  if (checkpoint.configId !== identity.configId) {
    return refuse(
      "CHECKPOINT_CONFIG_MISMATCH",
      `checkpoint pins configId ${checkpoint.configId}, not ${identity.configId} — ` +
        `a config change starts a new run (§9.6)`,
    );
  }
  if (checkpoint.runSeed !== identity.runSeed) {
    return refuse(
      "CHECKPOINT_SEED_MISMATCH",
      `checkpoint pins runSeed ${checkpoint.runSeed}, not ${identity.runSeed}`,
    );
  }
  if (
    typeof checkpoint.checkpointSeq !== "number" ||
    !Number.isSafeInteger(checkpoint.checkpointSeq) ||
    checkpoint.checkpointSeq < 0
  ) {
    return refuse(
      "CHECKPOINT_SEQ_INVALID",
      `checkpointSeq must be a non-negative safe integer; received ${String(checkpoint.checkpointSeq)}`,
    );
  }
  if (!INSTANCE_STATUSES.includes(checkpoint.status)) {
    return refuse(
      "CHECKPOINT_STATUS_INVALID",
      `status must be one of ${INSTANCE_STATUSES.join(", ")}; received ${String(checkpoint.status)}`,
    );
  }
  if (!isRngState(checkpoint.rngState)) {
    return refuse(
      "CHECKPOINT_RNG_STATE_INVALID",
      "rngState must be four unsigned 32-bit integers",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(checkpoint.stateJson) as unknown;
  } catch (cause) {
    return refuse(
      "CHECKPOINT_STATE_INVALID",
      `stateJson is not parseable JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("CHECKPOINT_STATE_INVALID", "stateJson must encode a JSON object");
  }
  const problem = checkpointableJsonProblem(parsed);
  if (problem !== null) {
    return refuse("CHECKPOINT_STATE_INVALID", `state is not checkpointable: ${problem}`);
  }
  if (canonicalJsonStringify(parsed) !== checkpoint.stateJson) {
    return refuse(
      "CHECKPOINT_STATE_INVALID",
      "stateJson is not in canonical form (sorted keys, canonical scalars)",
    );
  }

  const [laneA, laneB, laneC, laneD] = checkpoint.rngState;
  return {
    ok: true,
    restored: {
      state: deepFreeze(parsed as Record<string, unknown>),
      rngState: [laneA, laneB, laneC, laneD],
      nextEvaluationSeq: checkpoint.checkpointSeq + 1,
      status: checkpoint.status,
    },
  };
}

function refuse(code: CheckpointRefusalCode, detail: string): RestoreCheckpointResult {
  return { ok: false, refusal: { code, detail } };
}

/**
 * Rebuilds instance state from the persisted decisions' `statePatch` values in
 * evaluation order: the shallow-merge fold over the empty object. This is the
 * §9.6 "rebuildable" property — checkpoints are an optimization, never the
 * source of truth (§6 invariant 8 applied to strategy state).
 */
export function rebuildStateFromPatches(
  patches: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>,
): Readonly<Record<string, unknown>> {
  let state: Record<string, unknown> = {};
  for (const patch of patches) {
    if (patch !== undefined) {
      state = { ...state, ...patch };
    }
  }
  return deepFreeze(state);
}
