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
 *
 * DATED CORRECTION — 2026-09-03, remediation round 3 (review round 3's MEDIUM
 * 2, which also REJECTED round 2's ruling that this surface was out of scope).
 * A checkpoint document is caller-supplied data, `restoreCheckpoint` promises a
 * typed refusal and never a throw, and `createStrategyInstanceRuntime` promises
 * the same — and none of that was true. Reproduced verbatim against the
 * round-2 code:
 *
 *     drift=RETURNED:true/reads=2
 *     restoreThrow=SECOND_READ/reads=2
 *     createThrow=SECOND_READ_CREATE/reads=2
 *
 * `checkpoint.stateJson` was read TWICE — once to parse and once to compare
 * against the canonical form — so a getter could hand non-canonical bytes to
 * the parser and canonical bytes to the comparison and be restored anyway
 * (`drift`), bypassing the canonical-input requirement that §10.3's state hash
 * rests on; and a getter that threw on its second read escaped both public
 * functions. Deeply nested canonical bytes escaped as `RangeError` from the
 * same path.
 *
 * As of this correction the document (and the identity it is checked against)
 * is SNAPSHOTTED once: every field is read exactly once inside a guard, the
 * `stateJson` bytes are held in ONE local that every later step uses, the RNG
 * lanes and the parsed state are materialized into inert copies before they are
 * inspected, and every inspection failure — a throwing accessor, an exotic
 * value, nesting past `MAX_MATERIALIZED_DEPTH` — becomes a typed
 * `CHECKPOINT_STATE_INVALID` refusal.
 */

import { describeCause } from "./describe.js";
import {
  canonicalJsonStringify,
  deepFreeze,
  materializeCheckpointableJsonAt,
} from "./json.js";
import { readOwnFieldsOnce } from "./read-once.js";
import { isRngState, type RngState } from "./rng.js";

export const STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION = 1;

/**
 * The last evaluation sequence a run may consume: `Number.MAX_SAFE_INTEGER - 1`
 * = 9007199254740990.
 *
 * Added 2026-09-03 in remediation round 4 (review round 4's HIGH 1). Sequence
 * numbers are IEEE-754 doubles, and above `Number.MAX_SAFE_INTEGER` the
 * successor function stops being injective: `9007199254740991 + 1` and
 * `9007199254740992 + 1` are the SAME value. A checkpoint carrying
 * `checkpointSeq: Number.MAX_SAFE_INTEGER` restored an instance whose counter
 * could no longer advance, and two ordinary DECIDED evaluations then persisted
 * the same sequence — the reused-sequence class round 2 closed, reopened from
 * the other end. Reproduced verbatim against the round-3 code:
 *
 *     created=true
 *     sequences=[9007199254740992,9007199254740992]
 *     checkpoints=[9007199254740992,9007199254740992]
 *     safe=[false,false]
 *
 * The invariant this constant states: **every value the counter ever holds is
 * an exact integer, and every increment is exact.** It follows that
 * `checkpointSeq` may be at most this value (its successor, the next evaluation
 * sequence, is then exactly `Number.MAX_SAFE_INTEGER`), and that an instance
 * whose next sequence has reached `Number.MAX_SAFE_INTEGER` may not start
 * another evaluation. Both bounds are enforced, not documented: a larger
 * `checkpointSeq` is a `CHECKPOINT_SEQ_INVALID` refusal here, and an exhausted
 * counter is an `EVALUATION_SEQ_EXHAUSTED` refusal in `runtime.ts` that is
 * taken BEFORE the callback runs, so nothing is evaluated and no record is
 * owed.
 *
 * Why the representation stays `number` (the alternative was an exact type):
 * `checkpointSeq` and `DecisionRecord.evaluationSeq` travel in a checkpoint
 * DOCUMENT and a decision record that the composition root serializes as JSON,
 * and this package's own checkpointable grammar refuses `bigint` for exactly
 * that reason ("bigint is not representable in JSON"). Making the counter a
 * `bigint` would put the runtime in contradiction with its own boundary, and a
 * canonical decimal STRING would change a §10.3 column mapping to buy range no
 * run can reach: at one evaluation per millisecond, 2^53 - 1 sequences is
 * ~285,000 years. The chosen answer is therefore a `number` plus two refusals
 * that make exhaustion LOUD and terminal rather than silent and wrong.
 */
export const MAX_EVALUATION_SEQ = Number.MAX_SAFE_INTEGER - 1;

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

/** Every field of one caller-supplied document, read exactly once. */
interface CheckpointSnapshot {
  readonly checkpointSchemaVersion: unknown;
  readonly runId: unknown;
  readonly instanceId: unknown;
  readonly strategyName: unknown;
  readonly strategyVersion: unknown;
  readonly stateSchemaVersion: unknown;
  readonly configId: unknown;
  readonly runSeed: unknown;
  readonly checkpointSeq: unknown;
  readonly status: unknown;
  readonly rngState: unknown;
  /** The ONE copy of the bytes: parsed, compared, and reported from here. */
  readonly stateJson: unknown;
}

interface IdentitySnapshot {
  readonly runId: unknown;
  readonly instanceId: unknown;
  readonly strategyName: unknown;
  readonly strategyVersion: unknown;
  readonly stateSchemaVersion: unknown;
  readonly configId: unknown;
  readonly runSeed: unknown;
}

const CHECKPOINT_FIELDS = [
  "checkpointSchemaVersion",
  "runId",
  "instanceId",
  "strategyName",
  "strategyVersion",
  "stateSchemaVersion",
  "configId",
  "runSeed",
  "checkpointSeq",
  "status",
  "rngState",
  "stateJson",
] as const;

const IDENTITY_FIELDS = [
  "runId",
  "instanceId",
  "strategyName",
  "strategyVersion",
  "stateSchemaVersion",
  "configId",
  "runSeed",
] as const;

/**
 * Validates a checkpoint document against the current run identity and
 * returns the restored state, or a typed refusal.
 *
 * **Never throws** — and since remediation round 3 that holds for a document
 * whose accessors throw, whose accessors answer differently on a second read
 * (there is no second read), whose `rngState` is exotic, and whose `stateJson`
 * decodes to arbitrarily deep data.
 */
export function restoreCheckpoint(
  checkpoint: StrategyStateCheckpoint,
  identity: CheckpointIdentity,
): RestoreCheckpointResult {
  const document = readOwnFieldsOnce(checkpoint, "checkpoint", CHECKPOINT_FIELDS);
  if (!document.ok) {
    return refuse("CHECKPOINT_STATE_INVALID", document.problem);
  }
  const target = readOwnFieldsOnce(identity, "identity", IDENTITY_FIELDS);
  if (!target.ok) {
    return refuse("CHECKPOINT_STATE_INVALID", target.problem);
  }
  const found = document.fields as unknown as CheckpointSnapshot;
  const wanted = target.fields as unknown as IdentitySnapshot;

  if (found.checkpointSchemaVersion !== STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION) {
    return refuse(
      "CHECKPOINT_UNKNOWN_SCHEMA_VERSION",
      `checkpointSchemaVersion ${describeCause(found.checkpointSchemaVersion)} is not the ` +
        `supported version ${String(STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION)}`,
    );
  }
  if (found.runId !== wanted.runId || found.instanceId !== wanted.instanceId) {
    return refuse(
      "CHECKPOINT_RUN_MISMATCH",
      `checkpoint belongs to run ${describeCause(found.runId)} / instance ` +
        `${describeCause(found.instanceId)}, not to run ${describeCause(wanted.runId)} / ` +
        `instance ${describeCause(wanted.instanceId)}`,
    );
  }
  if (
    found.strategyName !== wanted.strategyName ||
    found.strategyVersion !== wanted.strategyVersion
  ) {
    return refuse(
      "CHECKPOINT_STRATEGY_MISMATCH",
      `checkpoint was written by ${describeCause(found.strategyName)}@` +
        `${describeCause(found.strategyVersion)}, not by ${describeCause(wanted.strategyName)}@` +
        `${describeCause(wanted.strategyVersion)} — a code change starts a new run (§9.6)`,
    );
  }
  if (found.stateSchemaVersion !== wanted.stateSchemaVersion) {
    return refuse(
      "CHECKPOINT_STATE_SCHEMA_MISMATCH",
      `checkpoint stateSchemaVersion ${describeCause(found.stateSchemaVersion)} does not match ` +
        `the strategy's ${describeCause(wanted.stateSchemaVersion)} — a state-schema change ` +
        "starts a new run (§9.6)",
    );
  }
  if (found.configId !== wanted.configId) {
    return refuse(
      "CHECKPOINT_CONFIG_MISMATCH",
      `checkpoint pins configId ${describeCause(found.configId)}, not ` +
        `${describeCause(wanted.configId)} — a config change starts a new run (§9.6)`,
    );
  }
  if (found.runSeed !== wanted.runSeed) {
    return refuse(
      "CHECKPOINT_SEED_MISMATCH",
      `checkpoint pins runSeed ${describeCause(found.runSeed)}, not ` +
        `${describeCause(wanted.runSeed)}`,
    );
  }
  if (
    typeof found.checkpointSeq !== "number" ||
    !Number.isSafeInteger(found.checkpointSeq) ||
    found.checkpointSeq < 0
  ) {
    return refuse(
      "CHECKPOINT_SEQ_INVALID",
      `checkpointSeq must be a non-negative safe integer; received ` +
        `${describeCause(found.checkpointSeq)}`,
    );
  }
  if (found.checkpointSeq > MAX_EVALUATION_SEQ) {
    // The SUCCESSOR is what this document is restored as (`checkpointSeq + 1`),
    // so a `checkpointSeq` of `Number.MAX_SAFE_INTEGER` is refused even though
    // it is itself a safe integer: its successor is not exactly representable,
    // and an instance whose counter cannot advance persists two decisions under
    // one sequence (round 4, HIGH 1).
    return refuse(
      "CHECKPOINT_SEQ_INVALID",
      `checkpointSeq ${String(found.checkpointSeq)} is past the last sequence a run can ` +
        `consume (${String(MAX_EVALUATION_SEQ)}): the next evaluation sequence would not be ` +
        "exactly representable, so two decisions could share one sequence number — a run " +
        "that reaches this bound is finished, and resumption is a new run (§9.6)",
    );
  }
  const checkpointSeq = found.checkpointSeq;
  if (!isInstanceStatus(found.status)) {
    return refuse(
      "CHECKPOINT_STATUS_INVALID",
      `status must be one of ${INSTANCE_STATUSES.join(", ")}; received ` +
        `${describeCause(found.status)}`,
    );
  }
  const status = found.status;

  // The lanes are MATERIALIZED before they are inspected: `isRngState` walks an
  // array, and an exotic `rngState` could answer its length one way and the
  // destructuring another. The copy is what is validated and what is returned.
  const lanes = materializeCheckpointableJsonAt(found.rngState, "rngState");
  if (!lanes.ok || !isRngState(lanes.value)) {
    return refuse(
      "CHECKPOINT_RNG_STATE_INVALID",
      lanes.ok
        ? "rngState must be four unsigned 32-bit integers"
        : `rngState could not be read as four unsigned 32-bit integers: ${lanes.problem}`,
    );
  }
  const [laneA, laneB, laneC, laneD] = lanes.value;

  // ONE local holds the bytes. Everything below — the parse, the canonical-form
  // comparison, the refusal messages — uses this local, never the document.
  const stateJson = found.stateJson;
  if (typeof stateJson !== "string") {
    return refuse(
      "CHECKPOINT_STATE_INVALID",
      `stateJson must be a string of canonical JSON; received ${describeCause(stateJson)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson) as unknown;
  } catch (cause) {
    return refuse(
      "CHECKPOINT_STATE_INVALID",
      `stateJson is not parseable JSON: ${describeCause(cause)}`,
    );
  }
  // `JSON.parse` output is inert already; it is materialized anyway because the
  // materializer is where the depth bound and the grammar live, and because the
  // COPY is what is frozen and returned.
  const state = materializeCheckpointableJsonAt(parsed, "state");
  if (!state.ok) {
    return refuse("CHECKPOINT_STATE_INVALID", `state is not checkpointable: ${state.problem}`);
  }
  const materialized = state.value;
  if (materialized === null || typeof materialized !== "object" || Array.isArray(materialized)) {
    return refuse("CHECKPOINT_STATE_INVALID", "stateJson must encode a JSON object");
  }
  if (canonicalJsonStringify(materialized) !== stateJson) {
    return refuse(
      "CHECKPOINT_STATE_INVALID",
      "stateJson is not in canonical form (sorted keys, canonical scalars)",
    );
  }

  return {
    ok: true,
    restored: {
      state: deepFreeze(materialized) as Readonly<Record<string, unknown>>,
      rngState: [laneA, laneB, laneC, laneD],
      nextEvaluationSeq: checkpointSeq + 1,
      status,
    },
  };
}

function isInstanceStatus(value: unknown): value is InstanceStatus {
  return (
    typeof value === "string" && (INSTANCE_STATUSES as readonly string[]).includes(value)
  );
}

function refuse(code: CheckpointRefusalCode, detail: string): RestoreCheckpointResult {
  return { ok: false, refusal: { code, detail } };
}

export type RebuildStateResult =
  | { readonly ok: true; readonly state: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly problem: string };

/**
 * Rebuilds instance state from the persisted decisions' `statePatch` values in
 * evaluation order: the shallow-merge fold over the empty object. This is the
 * §9.6 "rebuildable" property — checkpoints are an optimization, never the
 * source of truth (§6 invariant 8 applied to strategy state).
 *
 * Each patch is MATERIALIZED into the fold (remediation round 3). The patches
 * come from a decision LOG the caller loaded, which is caller-supplied data
 * like any other: spreading it ran its traps, and deep-freezing the result
 * froze the caller's nested objects in place. Now the fold shares no object
 * with its input, an unreadable patch is a typed problem rather than a throw,
 * and the result is the runtime's own inert data.
 *
 * **Never throws.** The signature changed in the same round, from returning the
 * state to returning a result; there is no accepted consumer yet, and a fold
 * that cannot report a bad patch would have to either throw or lie.
 */
export function rebuildStateFromPatches(
  patches: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>,
): RebuildStateResult {
  let isArray = false;
  try {
    isArray = Array.isArray(patches);
  } catch (cause) {
    // `Array.isArray` throws on a REVOKED proxy (round 3, MEDIUM 1).
    return { ok: false, problem: `patches could not be inspected (${describeCause(cause)})` };
  }
  if (!isArray) {
    return { ok: false, problem: "patches must be an array of statePatch values" };
  }
  const listing = readOwnFieldsOnce(patches, "patches", ["length"]);
  if (!listing.ok) {
    return { ok: false, problem: listing.problem };
  }
  const length = listing.fields.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    return { ok: false, problem: "patches.length must be a non-negative safe integer" };
  }

  let state: Record<string, unknown> = {};
  for (let index = 0; index < length; index += 1) {
    const path = `patches[${String(index)}]`;
    let entry: unknown;
    try {
      entry = (patches as readonly unknown[])[index];
    } catch (cause) {
      return { ok: false, problem: `${path} could not be read (${describeCause(cause)})` };
    }
    if (entry === undefined) {
      continue;
    }
    const materialized = materializeCheckpointableJsonAt(entry, path);
    if (!materialized.ok) {
      return {
        ok: false,
        problem: `a persisted statePatch is not checkpointable: ${materialized.problem}`,
      };
    }
    const patch = materialized.value;
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: false, problem: `${path} is not a statePatch object` };
    }
    // `patch` is the runtime's own inert copy, so the spread runs no caller
    // code and the fold shares nothing with the decision log it was built from.
    state = { ...state, ...patch };
  }
  return { ok: true, state: deepFreeze(state) };
}
