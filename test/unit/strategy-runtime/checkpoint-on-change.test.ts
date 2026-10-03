/**
 * `CKPT-1` — ADR-027 (the user's ruling A2): strategy checkpoints on change,
 * plus a 60 s heartbeat. Accepted 2026-09-30; implemented here.
 *
 * Decision 1, the six transitions: after a persisted decision the runtime
 * writes a checkpoint only when the state bytes, the status or the RNG differ
 * from the last checkpoint's (STATE, STATUS, RNG), at the instance's first
 * decision (START), at `onStop` (STOP), or once 60 s of EVENT time — the
 * decisions' `evaluatedAt` — have passed since the last checkpoint's decision
 * (HEARTBEAT). Every other decision writes none.
 *
 * Decision 2: a checkpoint keeps the `evaluationSeq` of the decision it
 * follows, so checkpoint sequences have gaps; a restore resumes at the highest
 * DURABLE `evaluationSeq` plus one, never at the checkpoint's; the
 * `statePatch` fold still rebuilds the state.
 *
 * Decision 4: which decisions write a checkpoint is a pure function of the
 * evaluations, so the same inputs, settings and seed give byte-identical
 * checkpoints — run twice, and across a restore at ANY point.
 *
 * Decision 3 (a decision and its owed checkpoint are durable together) is the
 * composition root's: `packages/trading-core/src/loop-refused-plan.test.ts`
 * (`CKPT-1` block) and
 * `test/integration/paper-trader/checkpoint-durable-together-postgres.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  CHECKPOINT_HEARTBEAT_MS,
  checkpointTransitions,
  createStrategyInstanceRuntime,
  rebuildStateFromPatches,
  type CheckpointMark,
  type EvaluationInput,
  type EvaluationOutcome,
  type StrategyStateCheckpoint,
} from "../../../packages/strategy-runtime/src/index.js";
import type { DecisionResult, StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import {
  holdDecision,
  makeDefinition,
  makeHarness,
  makeInput,
  makeStrategy,
  RecordingSink,
  RecordingStore,
  restorePoint,
  T0,
} from "./helpers.js";

/** `T0` plus `ms` milliseconds, in the strict-UTC form the runtime is handed. */
function at(ms: number): string {
  return new Date(Date.parse(T0) + ms).toISOString();
}

function onFeaturesAt(ms: number): EvaluationInput {
  return makeInput("onFeatures", { evaluatedAt: at(ms) });
}

function transitionsOf(outcome: EvaluationOutcome): readonly string[] {
  if (outcome.kind !== "DECIDED" && outcome.kind !== "CONTAINED") {
    throw new Error(`expected a persisted decision, got ${outcome.kind}`);
  }
  return outcome.checkpointTransitions;
}

/** A strategy whose `onFeatures` returns what `decide` builds. */
function onFeaturesStrategy(decide: (ctx: StrategyContext) => DecisionResult) {
  return makeStrategy({ onFeatures: decide });
}

describe("ADR-027 Decision 1: the six transitions, each one alone", () => {
  it("START: a fresh runtime's first decision writes a checkpoint, even a no-op hold", () => {
    const { runtime, store } = makeHarness();
    expect(transitionsOf(runtime.evaluate(makeInput("onFeatures")))).toEqual(["START"]);
    expect(store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0]);
  });

  it("nothing else writes one: no-op holds at one instant write no checkpoint after the start", () => {
    const { runtime, sink, store } = makeHarness();
    for (let index = 0; index < 5; index += 1) runtime.evaluate(makeInput("onFeatures"));
    expect(sink.calls).toHaveLength(5);
    expect(store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0]);
  });

  it("STATE: a patch that changes the canonical bytes writes one; a patch that round-trips to EQUAL bytes does not", () => {
    const patches: Record<string, unknown>[] = [
      { a: 1, b: "x" },
      // A different key order, the same value: the canonical bytes are equal.
      { b: "x", a: 1 },
      // A value that changes.
      { b: "y" },
      // Re-asserting what is already there.
      { a: 1 },
    ];
    let call = 0;
    const { runtime, store } = makeHarness({
      strategy: onFeaturesStrategy((ctx) => ({ ...holdDecision(ctx), statePatch: patches[call++] ?? {} })),
    });
    const outcomes = patches.map(() => runtime.evaluate(makeInput("onFeatures")));
    expect(outcomes.map(transitionsOf)).toEqual([["START"], [], ["STATE"], []]);
    expect(store.checkpoints.map((checkpoint) => [checkpoint.checkpointSeq, checkpoint.stateJson])).toEqual([
      [0, '{"a":1,"b":"x"}'],
      [2, '{"a":1,"b":"y"}'],
    ]);
  });

  it("STATUS: a containment PAUSES the instance and writes a checkpoint, with no state or RNG change", () => {
    let call = 0;
    const { runtime, store } = makeHarness({
      strategy: onFeaturesStrategy((ctx) => {
        call += 1;
        if (call === 2) throw new Error("the second evaluation fails");
        return holdDecision(ctx);
      }),
    });
    expect(transitionsOf(runtime.evaluate(makeInput("onFeatures")))).toEqual(["START"]);
    const contained = runtime.evaluate(makeInput("onFeatures"));
    expect(contained.kind).toBe("CONTAINED");
    expect(transitionsOf(contained)).toEqual(["STATUS"]);
    expect(store.checkpoints.map((checkpoint) => [checkpoint.checkpointSeq, checkpoint.status])).toEqual([
      [0, "ACTIVE"],
      [1, "PAUSED"],
    ]);
    // State and RNG are those of the start: the status alone moved.
    expect(store.checkpoints[1]?.stateJson).toBe(store.checkpoints[0]?.stateJson);
    expect(store.checkpoints[1]?.rngState).toEqual(store.checkpoints[0]?.rngState);
  });

  it("RNG: a draw that leaves the state unchanged writes a checkpoint carrying the new generator state", () => {
    let call = 0;
    const { runtime, store } = makeHarness({
      strategy: onFeaturesStrategy((ctx) => {
        call += 1;
        if (call === 2) ctx.rng().nextUint32();
        return holdDecision(ctx);
      }),
    });
    expect(transitionsOf(runtime.evaluate(makeInput("onFeatures")))).toEqual(["START"]);
    expect(transitionsOf(runtime.evaluate(makeInput("onFeatures")))).toEqual(["RNG"]);
    expect(transitionsOf(runtime.evaluate(makeInput("onFeatures")))).toEqual([]);
    expect(store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0, 1]);
    expect(store.checkpoints[1]?.stateJson).toBe("{}");
    expect(store.checkpoints[1]?.rngState).not.toEqual(store.checkpoints[0]?.rngState);
  });

  it("STOP: onStop writes a checkpoint (with the STATUS change to STOPPED)", () => {
    const { runtime, store } = makeHarness();
    runtime.evaluate(makeInput("onFeatures"));
    runtime.evaluate(makeInput("onFeatures"));
    expect(transitionsOf(runtime.evaluate(makeInput("onStop")))).toEqual(["STATUS", "STOP"]);
    expect(store.checkpoints.map((checkpoint) => [checkpoint.checkpointSeq, checkpoint.status])).toEqual([
      [0, "ACTIVE"],
      [2, "STOPPED"],
    ]);
  });

  it("HEARTBEAT: due at EXACTLY 60 s of event time after the last checkpoint's decision, not at 59.999 s", () => {
    expect(CHECKPOINT_HEARTBEAT_MS).toBe(60_000);
    const { runtime, store } = makeHarness();
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(0)))).toEqual(["START"]);
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(59_999)))).toEqual([]);
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(60_000)))).toEqual(["HEARTBEAT"]);
    // The anchor moved to the heartbeat's own instant.
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(119_999)))).toEqual([]);
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(120_000)))).toEqual(["HEARTBEAT"]);
    expect(store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0, 2, 4]);
  });

  it("HEARTBEAT counts from the last CHECKPOINT, not the last decision, and any checkpoint resets it", () => {
    let call = 0;
    const { runtime, store } = makeHarness({
      strategy: onFeaturesStrategy((ctx) => {
        call += 1;
        return call === 2 ? { ...holdDecision(ctx), statePatch: { moved: true } } : holdDecision(ctx);
      }),
    });
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(0)))).toEqual(["START"]);
    // A STATE checkpoint at 30 s resets the anchor…
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(30_000)))).toEqual(["STATE"]);
    // …so 60 s after the START is only 30 s after the last checkpoint.
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(60_000)))).toEqual([]);
    // Decisions without a checkpoint do not move it: 89.999 s is 59.999 s after it.
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(89_999)))).toEqual([]);
    expect(transitionsOf(runtime.evaluate(onFeaturesAt(90_000)))).toEqual(["HEARTBEAT"]);
    expect(store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0, 1, 4]);
  });

  it("HEARTBEAT is exact at any precision and in any zone the input door admits; event time running backwards is not 60 s", () => {
    const mark: CheckpointMark = {
      stateJson: "{}",
      status: "ACTIVE",
      rngState: [1, 2, 3, 4],
      evaluatedAt: "2026-01-02T03:04:05.1234567Z",
    };
    const candidate = (evaluatedAt: string) =>
      checkpointTransitions(mark, {
        callback: "onFeatures",
        evaluatedAt,
        stateJson: "{}",
        status: "ACTIVE",
        rngState: [1, 2, 3, 4],
      });
    // One digit past the millisecond decides it.
    expect(candidate("2026-01-02T03:05:05.1234566Z")).toEqual([]);
    expect(candidate("2026-01-02T03:05:05.1234567Z")).toEqual(["HEARTBEAT"]);
    expect(candidate("2026-01-02T03:05:05.12345670000Z")).toEqual(["HEARTBEAT"]);
    // The same instants in an offset form.
    expect(candidate("2026-01-02T04:05:05.1234566+01:00")).toEqual([]);
    expect(candidate("2026-01-02T02:05:05.1234567-01:00")).toEqual(["HEARTBEAT"]);
    // Minutes only (seconds are optional in the domain's form): 03:05 is 54.877 s later.
    expect(candidate("2026-01-02T03:05Z")).toEqual([]);
    // Backwards.
    expect(candidate("2026-01-02T03:03:05.1234567Z")).toEqual([]);
  });

  it("the pure rule: each transition is reported alone, and STOP is reported even when nothing else moved", () => {
    const mark: CheckpointMark = { stateJson: '{"a":1}', status: "ACTIVE", rngState: [1, 2, 3, 4], evaluatedAt: T0 };
    const same = { callback: "onFeatures" as const, evaluatedAt: T0, stateJson: '{"a":1}', status: "ACTIVE" as const, rngState: [1, 2, 3, 4] as const };
    expect(checkpointTransitions(mark, same)).toEqual([]);
    expect(checkpointTransitions(undefined, same)).toEqual(["START"]);
    expect(checkpointTransitions(mark, { ...same, stateJson: '{"a":2}' })).toEqual(["STATE"]);
    expect(checkpointTransitions(mark, { ...same, status: "PAUSED" })).toEqual(["STATUS"]);
    expect(checkpointTransitions(mark, { ...same, rngState: [1, 2, 3, 5] })).toEqual(["RNG"]);
    expect(checkpointTransitions(mark, { ...same, callback: "onStop" })).toEqual(["STOP"]);
    expect(checkpointTransitions(mark, { ...same, evaluatedAt: at(60_000) })).toEqual(["HEARTBEAT"]);
    // An instant the rule cannot read is treated as DUE (the fail-safe side).
    expect(checkpointTransitions({ ...mark, evaluatedAt: "not an instant" }, same)).toEqual(["HEARTBEAT"]);
  });
});

/** Decisions that patch the state, draw from the RNG, hold, and space themselves in event time. */
function mixedStrategy() {
  return makeStrategy({
    onFeatures: (ctx: StrategyContext): DecisionResult => {
      const tick = Number(ctx.features().values["tick"] ?? "0");
      const decision = holdDecision(ctx);
      // A quiet stretch (ticks 11-17, 119 s of event time): only heartbeats.
      if (tick >= 11 && tick <= 17) return decision;
      switch (tick % 4) {
        case 0:
          // A no-change hold.
          return decision;
        case 1:
          // A state change.
          return { ...decision, statePatch: { lastTick: tick } };
        case 2: {
          // An RNG draw with no state change.
          const draw = ctx.rng().nextUint32();
          return { ...decision, modelOutputs: { draw: String(draw) } };
        }
        default:
          // A draw folded into the state.
          return { ...decision, statePatch: { draw: String(ctx.rng().nextUint32()) } };
      }
    },
  });
}

/** Twenty evaluations: ticks 0…19, `evaluatedAt` spaced 17 s apart (so heartbeats fire too). */
function mixedInputs(): EvaluationInput[] {
  const inputs: EvaluationInput[] = [];
  for (let tick = 0; tick < 20; tick += 1) {
    const views = makeInput("onFeatures") as unknown as { features: Record<string, unknown> };
    inputs.push(
      makeInput("onFeatures", {
        evaluatedAt: at(tick * 17_000),
        features: { ...views.features, values: { midpoint: "0.5", tick: String(tick) } },
      }),
    );
  }
  inputs.push(makeInput("onStop", { evaluatedAt: at(20 * 17_000) }));
  return inputs;
}

interface Run {
  readonly sink: RecordingSink;
  readonly store: RecordingStore;
  readonly transitions: readonly (readonly string[])[];
}

function runFrom(inputs: readonly EvaluationInput[], restoreFrom?: ReturnType<typeof restorePoint>): Run {
  const sink = new RecordingSink();
  const store = new RecordingStore();
  const { definition } = makeDefinition({ strategy: mixedStrategy(), decisionSink: sink, checkpointStore: store });
  const created = createStrategyInstanceRuntime(restoreFrom === undefined ? definition : { ...definition, restoreFrom });
  if (!created.ok) throw new Error(`creation refused: ${created.refusal.code}: ${created.refusal.detail}`);
  const transitions: (readonly string[])[] = [];
  for (const input of inputs) {
    const outcome = created.runtime.evaluate(input);
    if (outcome.kind !== "DECIDED") throw new Error(`unexpected ${outcome.kind}`);
    transitions.push(outcome.checkpointTransitions);
  }
  return { sink, store, transitions };
}

describe("ADR-027 Decisions 2 and 4: sequences, rebuild, determinism and restore", () => {
  it("the mixed run exercises every transition but containment, and checkpoint sequences have gaps", () => {
    const { sink, store, transitions } = runFrom(mixedInputs());
    expect([...new Set(transitions.flat())].sort()).toEqual(["HEARTBEAT", "RNG", "START", "STATE", "STATUS", "STOP"]);
    expect(transitions.filter((list) => list.length === 0).length).toBeGreaterThan(3);
    expect(sink.calls).toHaveLength(21);
    const seqs = store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq);
    expect(seqs.length).toBeLessThan(sink.calls.length);
    expect(seqs[0]).toBe(0);
    expect(seqs.at(-1)).toBe(20);
    // Every checkpoint carries the sequence of the decision it follows.
    const recorded = new Set(sink.calls.map((call) => call.record.evaluationSeq));
    for (const seq of seqs) expect(recorded.has(seq)).toBe(true);
    expect(seqs.some((seq, index) => index > 0 && seq !== (seqs[index - 1] ?? -2) + 1)).toBe(true);
  });

  it("rebuildStateFromPatches still folds the persisted patches into the last checkpoint's bytes (D2.4)", () => {
    const { sink, store } = runFrom(mixedInputs());
    const rebuilt = rebuildStateFromPatches(sink.calls.map((call) => call.record.decision.statePatch));
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) expect(canonicalJsonStringify(rebuilt.state)).toBe(store.checkpoints.at(-1)?.stateJson);
    // …and at every checkpoint, the fold of the patches up to its own decision.
    for (const checkpoint of store.checkpoints) {
      const prefix = sink.calls.filter((call) => call.record.evaluationSeq <= checkpoint.checkpointSeq);
      const folded = rebuildStateFromPatches(prefix.map((call) => call.record.decision.statePatch));
      expect(folded.ok && canonicalJsonStringify(folded.state)).toBe(checkpoint.stateJson);
    }
  });

  it("D4: the same inputs, settings and seed give byte-identical checkpoints, twice", () => {
    const first = runFrom(mixedInputs());
    const second = runFrom(mixedInputs());
    expect(canonicalJsonStringify(second.store.checkpoints)).toBe(canonicalJsonStringify(first.store.checkpoints));
    expect(canonicalJsonStringify(second.sink.calls.map((call) => call.record))).toBe(
      canonicalJsonStringify(first.sink.calls.map((call) => call.record)),
    );
  });

  it("D2 + D4: interrupted after ANY decision and restored from (last checkpoint, highest sequence), the run is byte-identical", () => {
    const inputs = mixedInputs();
    const uninterrupted = runFrom(inputs);
    const allCheckpoints = canonicalJsonStringify(uninterrupted.store.checkpoints);
    const allRecords = canonicalJsonStringify(uninterrupted.sink.calls.map((call) => call.record));
    let restoredAfterCheckpointless = 0;
    for (let k = 1; k < inputs.length; k += 1) {
      // The prefix: what was durable when the process died after decision k-1.
      const prefix = runFrom(inputs.slice(0, k));
      const last = prefix.store.checkpoints.at(-1) as StrategyStateCheckpoint;
      const highest = (prefix.sink.calls.at(-1)?.record.evaluationSeq ?? -1);
      const anchor = prefix.sink.calls.find((call) => call.record.evaluationSeq === last.checkpointSeq)?.record.evaluatedAt;
      if (last.checkpointSeq !== highest) restoredAfterCheckpointless += 1;
      // The restart, from the restore point (ADR-027 D2).
      const tail = runFrom(inputs.slice(k), restorePoint(last, highest, anchor));
      expect(canonicalJsonStringify([...prefix.store.checkpoints, ...tail.store.checkpoints]), `restored after ${String(k)}`).toBe(
        allCheckpoints,
      );
      expect(
        canonicalJsonStringify([...prefix.sink.calls, ...tail.sink.calls].map((call) => call.record)),
        `restored after ${String(k)}`,
      ).toBe(allRecords);
    }
    // Non-vacuity: several interruption points left decisions durable AFTER the
    // last checkpoint, where `checkpointSeq + 1` would re-use a sequence.
    expect(restoredAfterCheckpointless).toBeGreaterThan(3);
  });

  it("D2: the next sequence is the highest durable one plus one — the checkpoint's would re-use a durable decision's sequence", () => {
    const { runtime, sink, store } = makeHarness();
    runtime.evaluate(makeInput("onFeatures")); // seq 0: START, checkpointed
    runtime.evaluate(makeInput("onFeatures")); // seq 1: no checkpoint
    runtime.evaluate(makeInput("onFeatures")); // seq 2: no checkpoint
    expect(store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0]);
    const checkpoint = store.checkpoints[0] as StrategyStateCheckpoint;

    const restored = makeHarness({ restoreFrom: restorePoint(checkpoint, 2) });
    expect(restored.runtime.nextEvaluationSeq()).toBe(3);
    restored.runtime.evaluate(makeInput("onFeatures"));
    expect(restored.sink.calls.map((call) => call.record.evaluationSeq)).toEqual([3]);
    const durable = new Set(sink.calls.map((call) => call.record.evaluationSeq));
    expect(durable.has(3)).toBe(false);
  });

  it("the first decision after a restore is NOT a start: a no-change decision writes none, a heartbeat counts from the restored anchor", () => {
    const { runtime, store } = makeHarness();
    runtime.evaluate(onFeaturesAt(0));
    const checkpoint = store.checkpoints[0] as StrategyStateCheckpoint;

    const quiet = makeHarness({ restoreFrom: restorePoint(checkpoint, 0, at(0)) });
    expect(transitionsOf(quiet.runtime.evaluate(onFeaturesAt(59_999)))).toEqual([]);
    expect(quiet.store.checkpoints).toHaveLength(0);
    expect(transitionsOf(quiet.runtime.evaluate(onFeaturesAt(60_000)))).toEqual(["HEARTBEAT"]);
    expect(quiet.store.checkpoints.map((written) => written.checkpointSeq)).toEqual([2]);
  });

  it("a restore point the runtime cannot trust is REFUSED, never resumed from", () => {
    const { runtime, store } = makeHarness();
    runtime.evaluate(makeInput("onFeatures"));
    runtime.evaluate(makeInput("onFeatures"));
    const checkpoint = store.checkpoints[0] as StrategyStateCheckpoint;
    const refusal = (restoreFrom: unknown): string => {
      const { definition } = makeDefinition();
      const created = createStrategyInstanceRuntime({ ...definition, restoreFrom: restoreFrom as never });
      return created.ok ? "CREATED" : created.refusal.code;
    };
    // A checkpoint newer than every durable decision: an inconsistent store.
    expect(refusal(restorePoint({ ...checkpoint, checkpointSeq: 5 }, 4))).toBe("RESTORE_SEQ_INVALID");
    for (const bad of [-1, 1.5, Number.NaN, "2", undefined, null]) {
      expect(refusal({ checkpoint, highestEvaluationSeq: bad, checkpointEvaluatedAt: T0 }), String(bad)).toBe(
        "RESTORE_SEQ_INVALID",
      );
    }
    for (const bad of ["yesterday", "2026-02-30T00:00:00Z", 0, undefined]) {
      expect(refusal({ checkpoint, highestEvaluationSeq: 1, checkpointEvaluatedAt: bad }), String(bad)).toBe(
        "RESTORE_INSTANT_INVALID",
      );
    }
    // The pre-`CKPT-1` call — a bare checkpoint — is refused, not resumed at
    // `checkpointSeq + 1`.
    expect(refusal(checkpoint)).toBe("RESTORE_POINT_INVALID");
    expect(refusal(null)).toBe("RESTORE_POINT_INVALID");
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("RESTORE_POINT_GET");
        },
      },
    );
    expect(refusal(hostile)).toBe("RESTORE_POINT_INVALID");
    // A sound point is accepted.
    expect(refusal(restorePoint(checkpoint, 1))).toBe("CREATED");
  });
});
