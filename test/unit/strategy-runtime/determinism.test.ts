/**
 * WP-170 acceptance 3: "Same event/config/seed yields identical state and
 * decisions." (§12.4; ADR-005 §5.)
 *
 * The same scripted event sequence is run twice through two independently
 * created runtimes with identical config and seed, and the FULL serialized
 * outputs — every decision record and every checkpoint (state bytes and RNG
 * state included) — are compared byte-for-byte via the canonical JSON
 * serializer. The strategy draws from the seeded RNG and folds the draws into
 * its state, so the comparison cannot pass by ignoring randomness.
 *
 * Non-vacuousness probe: the SAME sequence under a DIFFERENT seed must change
 * the decisions (the drawn model outputs differ), so a mutation that ignores
 * the injected seed fails this file rather than passing it silently.
 *
 * Restore determinism: a run interrupted at the midpoint checkpoint and
 * restored into a fresh runtime must produce the identical remaining records
 * (§9.6 "Restore compatible state on restart").
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  createStrategyInstanceRuntime,
  rebuildStateFromPatches,
  type EvaluationInput,
} from "../../../packages/strategy-runtime/src/index.js";
import type { DecisionResult, StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import {
  makeDefinition,
  makeInput,
  makeStrategy,
  ManualClock,
  RecordingSink,
  RecordingStore,
} from "./helpers.js";

/** Decisions and state depend on the seeded RNG and accumulate across events. */
function rngDrivenStrategy() {
  return makeStrategy({
    onFeatures: (ctx: StrategyContext): DecisionResult => {
      const draw = ctx.rng().nextUint32();
      const flip = ctx.rng().nextIntBelow(2);
      const count = (ctx.state<{ count?: number }>().count ?? 0) + 1;
      return {
        decisionType: flip === 0 ? "hold" : "skip",
        reasonCodes: ["TEST.RNG_DRIVEN"],
        featureSnapshotRef: ctx.features().snapshotRef,
        modelOutputs: { draw: String(draw) },
        statePatch: { count, lastDraw: String(draw) },
        intents: [],
      };
    },
  });
}

function makeSequence(): EvaluationInput[] {
  return [
    makeInput("onStart"),
    makeInput("onFeatures"),
    makeInput("onFeatures"),
    makeInput("onTimer"),
    makeInput("onFeatures"),
    makeInput("onFeatures"),
  ];
}

interface RunOutput {
  readonly recordsJson: string;
  readonly checkpointsJson: string;
  readonly sink: RecordingSink;
  readonly store: RecordingStore;
}

function runSequence(seed: string): RunOutput {
  const sink = new RecordingSink();
  const store = new RecordingStore();
  const { definition } = makeDefinition({
    strategy: rngDrivenStrategy(),
    decisionSink: sink,
    checkpointStore: store,
    run: { runId: "run-1", instanceId: "instance-1", configId: "config-1", runSeed: seed },
  });
  const created = createStrategyInstanceRuntime(definition);
  if (!created.ok) {
    throw new Error(`creation refused: ${created.refusal.code}`);
  }
  for (const input of makeSequence()) {
    const outcome = created.runtime.evaluate(input);
    if (outcome.kind !== "DECIDED") {
      throw new Error(`unexpected outcome ${outcome.kind}`);
    }
  }
  return {
    recordsJson: canonicalJsonStringify(sink.calls.map((call) => call.record)),
    checkpointsJson: canonicalJsonStringify(store.checkpoints),
    sink,
    store,
  };
}

describe("acceptance 3: same event/config/seed yields identical state and decisions", () => {
  it("two runs with the same seed are byte-identical: every record, every checkpoint, all state bytes", () => {
    const first = runSequence("12345");
    const second = runSequence("12345");
    expect(second.recordsJson).toBe(first.recordsJson);
    expect(second.checkpointsJson).toBe(first.checkpointsJson);
    // The comparison is not vacuous: the strategy consumed randomness and
    // accumulated state.
    const lastCheckpoint = first.store.checkpoints.at(-1);
    expect(lastCheckpoint?.stateJson).toContain('"count":4');
    expect(lastCheckpoint?.stateJson).toContain('"lastDraw"');
  });

  it("probe: a DIFFERENT injected seed actually changes the decisions (the test cannot pass vacuously)", () => {
    const first = runSequence("12345");
    const other = runSequence("54321");
    expect(other.recordsJson).not.toBe(first.recordsJson);
    // Specifically the drawn model outputs differ, not merely some timestamp.
    const firstDraw = first.sink.calls[1]?.record.decision.modelOutputs?.["draw"];
    const otherDraw = other.sink.calls[1]?.record.decision.modelOutputs?.["draw"];
    expect(firstDraw).toBeDefined();
    expect(otherDraw).toBeDefined();
    expect(otherDraw).not.toBe(firstDraw);
  });

  it("state is rebuildable from the persisted statePatches alone and matches the checkpointed bytes (§9.6)", () => {
    const { sink, store } = runSequence("12345");
    const rebuilt = rebuildStateFromPatches(
      sink.calls.map((call) => call.record.decision.statePatch),
    );
    expect(canonicalJsonStringify(rebuilt)).toBe(store.checkpoints.at(-1)?.stateJson);
  });

  it("a run interrupted mid-way and RESTORED from its checkpoint reproduces the identical tail (§9.6 restore)", () => {
    const uninterrupted = runSequence("12345");

    // First half in one runtime.
    const sinkA = new RecordingSink();
    const storeA = new RecordingStore();
    const firstHalf = makeDefinition({
      strategy: rngDrivenStrategy(),
      decisionSink: sinkA,
      checkpointStore: storeA,
    });
    const createdA = createStrategyInstanceRuntime(firstHalf.definition);
    if (!createdA.ok) {
      throw new Error("creation refused");
    }
    const sequence = makeSequence();
    for (const input of sequence.slice(0, 3)) {
      expect(createdA.runtime.evaluate(input).kind).toBe("DECIDED");
    }
    const midCheckpoint = storeA.checkpoints.at(-1);
    if (midCheckpoint === undefined) {
      throw new Error("expected a mid-run checkpoint");
    }

    // Second half in a FRESH runtime restored from the checkpoint.
    const sinkB = new RecordingSink();
    const storeB = new RecordingStore();
    const secondHalf = makeDefinition({
      strategy: rngDrivenStrategy(),
      decisionSink: sinkB,
      checkpointStore: storeB,
    });
    const createdB = createStrategyInstanceRuntime({
      ...secondHalf.definition,
      restoreFrom: midCheckpoint,
    });
    expect(createdB.ok).toBe(true);
    if (!createdB.ok) {
      return;
    }
    expect(createdB.runtime.nextEvaluationSeq()).toBe(3);
    for (const input of sequence.slice(3)) {
      expect(createdB.runtime.evaluate(input).kind).toBe("DECIDED");
    }

    const tailFromRestore = canonicalJsonStringify(sinkB.calls.map((call) => call.record));
    const tailUninterrupted = canonicalJsonStringify(
      uninterrupted.sink.calls.slice(3).map((call) => call.record),
    );
    expect(tailFromRestore).toBe(tailUninterrupted);
    expect(storeB.checkpoints.at(-1)?.stateJson).toBe(
      uninterrupted.store.checkpoints.at(-1)?.stateJson,
    );
  });

  it("machine timing stays OUT of the deterministic record even when evaluations take (varying) time", () => {
    const sink = new RecordingSink();
    const clock = new ManualClock();
    let call = 0;
    const base = rngDrivenStrategy();
    const slowStrategy = makeStrategy({
      onFeatures: (ctx: StrategyContext): DecisionResult => {
        call += 1;
        clock.advanceUs(37 * call); // within the 1000us budget, varying per call
        return base.onFeatures(ctx);
      },
    });
    const { definition } = makeDefinition({
      strategy: slowStrategy,
      decisionSink: sink,
      clock,
    });
    const created = createStrategyInstanceRuntime(definition);
    if (!created.ok) {
      throw new Error("creation refused");
    }
    for (const input of makeSequence()) {
      expect(created.runtime.evaluate(input).kind).toBe("DECIDED");
    }
    // The telemetry saw the elapsed time; the records did not.
    expect(sink.calls[1]?.telemetry.evaluationDurationUs).toBe(37);
    expect(sink.calls[2]?.telemetry.evaluationDurationUs).toBe(74);
    const noisyRecords = canonicalJsonStringify(sink.calls.map((entry) => entry.record));
    expect(noisyRecords).toBe(runSequence("12345").recordsJson);
  });
});
