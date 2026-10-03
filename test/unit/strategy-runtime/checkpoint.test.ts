/**
 * §9.6 "Checkpoint strategy state after defined transitions", "Restore
 * compatible state on restart", and "Start a new run for every code, config,
 * model, feature, or state-schema change".
 *
 * Two properties are pinned here:
 *
 * 1. **Versioned, and refusing on unknown versions.** A checkpoint carries its
 *    own `checkpointSchemaVersion` and the full run identity. Restore is a
 *    typed refusal on any unknown version and on every identity mismatch —
 *    never a partial load, never a silent field-by-field merge. Loading a
 *    checkpoint written by different code into a running instance is exactly
 *    how a replay stops being reproducible.
 * 2. **Rebuildable.** Checkpoints are an optimization, not the source of truth
 *    (§6 invariant 8 applied to strategy state): the fold of the persisted
 *    `statePatch` values reproduces the checkpointed bytes.
 *
 * `CKPT-1` (ADR-027) re-pins two things here, each stated where it changes:
 * a restore takes a RESTORE POINT (the last checkpoint plus the highest durable
 * `evaluationSeq`, D2), so `restoreCheckpoint` validates the document but no
 * longer answers a next sequence; and a checkpoint is written after a decision
 * that meets Decision 1 — not after every one.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  createStrategyInstanceRuntime,
  rebuildStateFromPatches,
  restoreCheckpoint,
  restoreFromPoint,
  STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
  type CheckpointIdentity,
  type StrategyStateCheckpoint,
} from "../../../packages/strategy-runtime/src/index.js";
import {
  CONFIG_ID,
  INSTANCE_ID,
  makeDefinition,
  makeHarness,
  makeInput,
  restorePoint,
  RUN_ID,
  RUN_SEED,
} from "./helpers.js";

const IDENTITY: CheckpointIdentity = {
  runId: RUN_ID,
  instanceId: INSTANCE_ID,
  strategyName: "test-strategy",
  strategyVersion: "1.0.0",
  stateSchemaVersion: 1,
  configId: CONFIG_ID,
  runSeed: RUN_SEED,
};

function makeCheckpoint(
  overrides: Partial<StrategyStateCheckpoint> = {},
): StrategyStateCheckpoint {
  return {
    checkpointSchemaVersion: STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
    runId: RUN_ID,
    instanceId: INSTANCE_ID,
    strategyName: "test-strategy",
    strategyVersion: "1.0.0",
    stateSchemaVersion: 1,
    configId: CONFIG_ID,
    runSeed: RUN_SEED,
    checkpointSeq: 4,
    status: "ACTIVE",
    rngState: [1, 2, 3, 4],
    stateJson: '{"count":2}',
    ...overrides,
  };
}

function refusalCode(overrides: Partial<StrategyStateCheckpoint>): string {
  const result = restoreCheckpoint(makeCheckpoint(overrides), IDENTITY);
  if (result.ok) {
    throw new Error("expected a refusal");
  }
  return result.refusal.code;
}

describe("state checkpointing: versioned, rebuildable, refusing on incompatibility", () => {
  it("restores a compatible checkpoint into frozen state; the NEXT sequence is the highest durable one plus one (ADR-027 D2)", () => {
    const result = restoreCheckpoint(makeCheckpoint(), IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.restored.state).toEqual({ count: 2 });
    expect(Object.isFrozen(result.restored.state)).toBe(true);
    // `CKPT-1` re-pin: this was `nextEvaluationSeq` 5 (= checkpointSeq + 1).
    // A checkpoint alone no longer knows the next sequence — decisions that
    // owed no checkpoint may be durable after it — so it answers its OWN
    // sequence, and the restore point answers the next one.
    expect(result.restored.checkpointSeq).toBe(4);
    expect(result.restored).not.toHaveProperty("nextEvaluationSeq");
    expect(result.restored.rngState).toEqual([1, 2, 3, 4]);
    expect(result.restored.status).toBe("ACTIVE");

    const atCheckpoint = restoreFromPoint(restorePoint(makeCheckpoint()), IDENTITY);
    expect(atCheckpoint.ok && atCheckpoint.restored.nextEvaluationSeq).toBe(5);
    // Three decisions with no checkpoint are durable after it (5, 6, 7): the
    // next sequence is 8, never the checkpoint's 5.
    const afterLater = restoreFromPoint(restorePoint(makeCheckpoint(), 7), IDENTITY);
    expect(afterLater.ok && afterLater.restored.nextEvaluationSeq).toBe(8);
    expect(afterLater.ok && afterLater.restored.state).toEqual({ count: 2 });
  });

  it("REFUSES an unknown checkpoint schema version rather than best-effort loading it", () => {
    expect(refusalCode({ checkpointSchemaVersion: 2 })).toBe("CHECKPOINT_UNKNOWN_SCHEMA_VERSION");
    expect(refusalCode({ checkpointSchemaVersion: 0 })).toBe("CHECKPOINT_UNKNOWN_SCHEMA_VERSION");
    expect(refusalCode({ checkpointSchemaVersion: -1 })).toBe("CHECKPOINT_UNKNOWN_SCHEMA_VERSION");
    expect(refusalCode({ checkpointSchemaVersion: 1.5 })).toBe(
      "CHECKPOINT_UNKNOWN_SCHEMA_VERSION",
    );
    expect(refusalCode({ checkpointSchemaVersion: "1" as never })).toBe(
      "CHECKPOINT_UNKNOWN_SCHEMA_VERSION",
    );
    expect(refusalCode({ checkpointSchemaVersion: undefined as never })).toBe(
      "CHECKPOINT_UNKNOWN_SCHEMA_VERSION",
    );
  });

  it("refuses a checkpoint belonging to another run or instance", () => {
    expect(refusalCode({ runId: "other-run" })).toBe("CHECKPOINT_RUN_MISMATCH");
    expect(refusalCode({ instanceId: "other-instance" })).toBe("CHECKPOINT_RUN_MISMATCH");
  });

  it("refuses a CODE change — a different strategy name or version starts a new run (§9.6)", () => {
    expect(refusalCode({ strategyName: "other-strategy" })).toBe("CHECKPOINT_STRATEGY_MISMATCH");
    expect(refusalCode({ strategyVersion: "1.0.1" })).toBe("CHECKPOINT_STRATEGY_MISMATCH");
  });

  it("refuses a STATE-SCHEMA change", () => {
    expect(refusalCode({ stateSchemaVersion: 2 })).toBe("CHECKPOINT_STATE_SCHEMA_MISMATCH");
  });

  it("refuses a CONFIG change", () => {
    expect(refusalCode({ configId: "config-2" })).toBe("CHECKPOINT_CONFIG_MISMATCH");
  });

  it("refuses a SEED change", () => {
    expect(refusalCode({ runSeed: "999" })).toBe("CHECKPOINT_SEED_MISMATCH");
  });

  it("refuses a malformed sequence, status, or RNG state", () => {
    for (const bad of [-1, 1.5, Number.NaN, "4", undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(refusalCode({ checkpointSeq: bad as never }), `seq ${String(bad)}`).toBe(
        "CHECKPOINT_SEQ_INVALID",
      );
    }
    for (const bad of ["RUNNING", "active", "", undefined]) {
      expect(refusalCode({ status: bad as never }), `status ${String(bad)}`).toBe(
        "CHECKPOINT_STATUS_INVALID",
      );
    }
    for (const bad of [[1, 2, 3], [1, 2, 3, 4, 5], [1, 2, 3, -1], [1, 2, 3, 2 ** 32], "1,2,3,4"]) {
      expect(refusalCode({ rngState: bad as never }), `rng ${String(bad)}`).toBe(
        "CHECKPOINT_RNG_STATE_INVALID",
      );
    }
  });

  it("refuses state bytes that are unparseable, not an object, or not canonical", () => {
    expect(refusalCode({ stateJson: "{not json" })).toBe("CHECKPOINT_STATE_INVALID");
    expect(refusalCode({ stateJson: "[]" })).toBe("CHECKPOINT_STATE_INVALID");
    expect(refusalCode({ stateJson: "null" })).toBe("CHECKPOINT_STATE_INVALID");
    expect(refusalCode({ stateJson: '"a string"' })).toBe("CHECKPOINT_STATE_INVALID");
    // Same value, non-canonical key order: refused, because the store hashes
    // these exact bytes (§10.3 state_checkpoints.state_hash).
    expect(refusalCode({ stateJson: '{"b":1,"a":2}' })).toBe("CHECKPOINT_STATE_INVALID");
    expect(refusalCode({ stateJson: '{ "count": 2 }' })).toBe("CHECKPOINT_STATE_INVALID");
  });

  it("accepts canonical nested state and preserves it exactly", () => {
    const stateJson = '{"a":[1,2,{"z":null,"a":true}],"b":{"c":"0.01"}}';
    const canonical = canonicalJsonStringify(JSON.parse(stateJson));
    const result = restoreCheckpoint(makeCheckpoint({ stateJson: canonical }), IDENTITY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonicalJsonStringify(result.restored.state)).toBe(canonical);
    }
  });

  it("the runtime surfaces the checkpoint refusal code when a restore is attempted at creation", () => {
    const { definition } = makeDefinition();
    const created = createStrategyInstanceRuntime({
      ...definition,
      restoreFrom: restorePoint(makeCheckpoint({ checkpointSchemaVersion: 99 })),
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.refusal.code).toBe("CHECKPOINT_UNKNOWN_SCHEMA_VERSION");
    }

    const mismatched = createStrategyInstanceRuntime({
      ...definition,
      restoreFrom: restorePoint(makeCheckpoint({ strategyVersion: "2.0.0" })),
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.refusal.code).toBe("CHECKPOINT_STRATEGY_MISMATCH");
    }
  });

  it("a restored PAUSED checkpoint yields a paused instance that refuses to evaluate", () => {
    const { definition, sink } = makeDefinition();
    const created = createStrategyInstanceRuntime({
      ...definition,
      restoreFrom: restorePoint(makeCheckpoint({ status: "PAUSED" })),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.runtime.instanceStatus()).toBe("PAUSED");
    const outcome = created.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind === "REFUSED") {
      expect(outcome.refusal.code).toBe("INSTANCE_PAUSED");
    }
    expect(sink.calls).toHaveLength(0);
  });

  it("the START decision writes a checkpoint, which pins the full run identity; a no-change decision writes none (ADR-027 D1)", () => {
    // `CKPT-1` re-pin (ADR-027 §5): this was "a checkpoint is written after
    // EVERY persisted decision". The first decision of the instance is the
    // START transition and still writes one; a second hold that changes
    // neither state, status nor RNG, at the same instant, writes none.
    const { runtime, store, sink } = makeHarness();
    expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    const second = runtime.evaluate(makeInput("onFeatures"));
    expect(second.kind === "DECIDED" && second.checkpoint).toBeNull();
    expect(sink.calls).toHaveLength(2);
    expect(store.checkpoints).toHaveLength(1);
    const checkpoint = store.checkpoints[0];
    expect(checkpoint).toMatchObject({
      checkpointSchemaVersion: STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
      runId: RUN_ID,
      instanceId: INSTANCE_ID,
      strategyName: "test-strategy",
      strategyVersion: "1.0.0",
      stateSchemaVersion: 1,
      configId: CONFIG_ID,
      runSeed: RUN_SEED,
      checkpointSeq: 0,
      status: "ACTIVE",
      stateJson: "{}",
    });
    // Round-trips through restore against the same identity.
    expect(restoreCheckpoint(checkpoint as StrategyStateCheckpoint, IDENTITY).ok).toBe(true);
  });

  it("rebuildStateFromPatches is the shallow-merge fold, skips absent patches, and freezes the result", () => {
    // The fold is unchanged; the SIGNATURE returns a typed result as of
    // remediation round 3, because the patches come from a caller-loaded
    // decision log and a fold that cannot report an unreadable patch would have
    // to throw or lie (see the round-3 tests in `boundary-snapshots.test.ts`).
    const rebuilt = rebuildStateFromPatches([
      { a: 1, b: "x" },
      undefined,
      { b: "y", c: true },
      {},
    ]);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) {
      return;
    }
    expect(rebuilt.state).toEqual({ a: 1, b: "y", c: true });
    expect(Object.isFrozen(rebuilt.state)).toBe(true);
    const empty = rebuildStateFromPatches([]);
    expect(empty.ok && empty.state).toEqual({});
  });
});
