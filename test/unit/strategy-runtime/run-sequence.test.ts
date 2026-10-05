/**
 * `ROLLOVER-1` (ADR-030 Decision 4; the user's ruling Q2, 2026-10-04): the
 * RUN-SCOPED evaluation sequence (`packages/strategy-runtime/src/sequence.ts`).
 *
 * One run spans many windows of a reviewed series, and each window gets its own
 * runtime (fresh per-market strategy state). Without a run-scoped sequence,
 * every runtime numbered its decisions and checkpoints from 0, so the second
 * window's first decision collided with the first window's on the store's
 * `decisions_evaluation_unique (run_id, evaluation_seq)` and
 * `state_checkpoints_seq_unique (run_id, checkpoint_seq)` keys — the first
 * implementer's probe (`run-sequence.probe.ts`, stop report B2), pinned here as
 * the WITHOUT row of the first test.
 *
 * What is pinned:
 *
 * 1. the collision without a run sequence, and none with one — decisions AND
 *    checkpoints, across two windows' runtimes;
 * 2. a runtime with no run sequence numbers exactly as before;
 * 3. only a counter this package minted is accepted;
 * 4. seeding: a fresh run at 0, a restored run at its highest durable sequence
 *    plus one, and a counter BEHIND a runtime's restore point is refused;
 * 5. a number is spent when it is taken: a persist that fails leaves a gap,
 *    never a re-use;
 * 6. exhaustion is refused before the callback is invoked;
 * 7. ADR-027 Decision 1 is unchanged: each window's runtime checkpoints its own
 *    START, and a contained evaluation is numbered from the run's counter too.
 */

import { describe, expect, it } from "vitest";

import {
  createRunEvaluationSequence,
  createStrategyInstanceRuntime,
  isRunEvaluationSequence,
  MAX_EVALUATION_SEQ,
  runEvaluationSequenceAfter,
  type RunEvaluationSequence,
  type StrategyInstanceRuntime,
} from "../../../packages/strategy-runtime/src/index.js";
import {
  CONFIG_ID,
  INSTANCE_ID,
  makeDefinition,
  makeHarness,
  makeInput,
  makeStrategy,
  ManualClock,
  RecordingSink,
  RecordingStore,
  restorePoint,
  RUN_ID,
  RUN_SEED,
} from "./helpers.js";

const WINDOW_A = "018f4a7e-1111-7abc-8def-0123456789ab";
const WINDOW_B = "018f4a7e-2222-7abc-8def-0123456789ab";

/** Two windows of ONE run: one sink and one store, as the trader's outbox is one. */
function twoWindows(sequence: RunEvaluationSequence | undefined): {
  readonly a: StrategyInstanceRuntime;
  readonly b: StrategyInstanceRuntime;
  readonly sink: RecordingSink;
  readonly store: RecordingStore;
} {
  const sink = new RecordingSink();
  const store = new RecordingStore();
  const make = (): StrategyInstanceRuntime => {
    const created = createStrategyInstanceRuntime({
      strategy: makeStrategy(),
      params: {},
      run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: RUN_SEED },
      watchdog: { evaluationBudgetUs: 1_000_000 },
      clock: new ManualClock(),
      decisionSink: sink,
      checkpointStore: store,
      ...(sequence === undefined ? {} : { sequence }),
    });
    if (!created.ok) throw new Error(`${created.refusal.code}: ${created.refusal.detail}`);
    return created.runtime;
  };
  return { a: make(), b: make(), sink, store };
}

function onWindow(callback: Parameters<typeof makeInput>[0], marketId: string) {
  const input = makeInput(callback) as unknown as { market: Record<string, unknown> };
  return makeInput(callback, { market: { ...input.market, marketId } });
}

describe("ROLLOVER-1: the run-scoped evaluation sequence", () => {
  it("WITHOUT a run sequence two windows of one run collide (the stop report's probe); WITH one they never do", () => {
    const without = twoWindows(undefined);
    without.a.evaluate(onWindow("onMarketOpen", WINDOW_A));
    without.b.evaluate(onWindow("onMarketOpen", WINDOW_B));
    expect(without.sink.calls.map((call) => call.record.evaluationSeq)).toEqual([0, 0]);
    expect(without.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0, 0]);

    const withSequence = twoWindows(createRunEvaluationSequence());
    withSequence.a.evaluate(onWindow("onMarketOpen", WINDOW_A));
    withSequence.b.evaluate(onWindow("onMarketOpen", WINDOW_B));
    withSequence.a.evaluate(onWindow("onFeatures", WINDOW_A));
    withSequence.b.evaluate(onWindow("onFeatures", WINDOW_B));
    withSequence.b.evaluate(onWindow("onFeatures", WINDOW_B));
    const keys = withSequence.sink.calls.map(
      (call) => `${call.record.runId}|${String(call.record.evaluationSeq)}|${call.record.marketId}`,
    );
    expect(keys).toEqual([
      `${RUN_ID}|0|${WINDOW_A}`,
      `${RUN_ID}|1|${WINDOW_B}`,
      `${RUN_ID}|2|${WINDOW_A}`,
      `${RUN_ID}|3|${WINDOW_B}`,
      `${RUN_ID}|4|${WINDOW_B}`,
    ]);
    // Each window's START checkpoint (ADR-027 D1.4) carries its own decision's
    // run-wide sequence, so the checkpoint key is unique too.
    expect(withSequence.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0, 1]);
    expect(new Set(withSequence.sink.calls.map((call) => call.record.evaluationSeq)).size).toBe(5);
  });

  it("both runtimes answer the run's next sequence", () => {
    const sequence = createRunEvaluationSequence();
    const { a, b } = twoWindows(sequence);
    a.evaluate(onWindow("onMarketOpen", WINDOW_A));
    expect(a.nextEvaluationSeq()).toBe(1);
    expect(b.nextEvaluationSeq()).toBe(1);
    expect(sequence.peek()).toBe(1);
    expect(sequence.issued).toBe(1);
  });

  it("a runtime with NO run sequence numbers its own decisions exactly as before", () => {
    const { runtime, sink, store } = makeHarness();
    runtime.evaluate(makeInput("onMarketOpen"));
    runtime.evaluate(makeInput("onFeatures"));
    runtime.evaluate(makeInput("onFeatures"));
    expect(sink.calls.map((call) => call.record.evaluationSeq)).toEqual([0, 1, 2]);
    expect(store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0]);
    expect(runtime.nextEvaluationSeq()).toBe(3);
  });

  it("refuses a counter this package did not mint (a caller-built port runs no code in evaluate)", () => {
    let calls = 0;
    const forged = {
      peek: () => {
        calls += 1;
        return 0;
      },
      take: () => {
        calls += 1;
        return 0;
      },
      issued: 0,
    };
    const { definition } = makeDefinition({ sequence: forged as unknown as RunEvaluationSequence });
    const created = createStrategyInstanceRuntime(definition);
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.refusal.code).toBe("SEQUENCE_SOURCE_INVALID");
    expect(calls).toBe(0);
    expect(isRunEvaluationSequence(forged)).toBe(false);
    expect(isRunEvaluationSequence(createRunEvaluationSequence())).toBe(true);
    expect(isRunEvaluationSequence(null)).toBe(false);
  });

  it("seeds a restored run at its highest durable sequence plus one, and refuses an unusable seed", () => {
    const after = runEvaluationSequenceAfter(41);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.sequence.peek()).toBe(42);
    for (const bad of [-1, 1.5, Number.NaN, "41", undefined, MAX_EVALUATION_SEQ + 1]) {
      const refused = runEvaluationSequenceAfter(bad);
      expect(refused.ok, String(bad)).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe("RUN_SEQUENCE_SEED_INVALID");
    }
    expect(createRunEvaluationSequence().peek()).toBe(0);
  });

  it("restores a window's runtime from its checkpoint on the run's counter, and refuses a counter BEHIND the restore point", () => {
    // One runtime of the run decides twice; its checkpoint (seq 0) and the
    // run's highest durable sequence (1) make the restore point.
    const sequence = createRunEvaluationSequence();
    const first = makeHarness({ sequence });
    first.runtime.evaluate(makeInput("onMarketOpen"));
    first.runtime.evaluate(makeInput("onFeatures"));
    const checkpoint = first.store.checkpoints[0];
    expect(checkpoint).toBeDefined();
    if (checkpoint === undefined) return;
    const point = restorePoint(checkpoint, 1);

    const seeded = runEvaluationSequenceAfter(point.highestEvaluationSeq);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const restored = makeHarness({ restoreFrom: point, sequence: seeded.sequence });
    restored.runtime.evaluate(makeInput("onFeatures"));
    expect(restored.sink.calls.map((call) => call.record.evaluationSeq)).toEqual([2]);

    const { definition } = makeDefinition({ restoreFrom: point, sequence: createRunEvaluationSequence() });
    const behind = createStrategyInstanceRuntime(definition);
    expect(behind.ok).toBe(false);
    if (!behind.ok) expect(behind.refusal.code).toBe("SEQUENCE_SOURCE_BEHIND");
  });

  it("spends a sequence when it is TAKEN: a persist that fails leaves a gap, never a re-use", () => {
    const sequence = createRunEvaluationSequence();
    const { a, b, sink } = twoWindows(sequence);
    a.evaluate(onWindow("onMarketOpen", WINDOW_A));
    sink.failNext = true;
    const halted = a.evaluate(onWindow("onFeatures", WINDOW_A));
    expect(halted.kind).toBe("HALTED");
    expect(a.instanceStatus()).toBe("PAUSED");
    b.evaluate(onWindow("onMarketOpen", WINDOW_B));
    // 0 (A), 1 taken by A's failed persist, 2 (B): 1 is never issued again.
    expect(sink.calls.map((call) => call.record.evaluationSeq)).toEqual([0, 2]);
    expect(sequence.peek()).toBe(3);
  });

  it("numbers a CONTAINED evaluation from the run's counter too", () => {
    const sequence = createRunEvaluationSequence();
    const throwing = makeHarness({
      sequence,
      strategy: makeStrategy({
        onFeatures: () => {
          throw new Error("boom");
        },
      }),
    });
    const other = makeHarness({ sequence });
    other.runtime.evaluate(makeInput("onMarketOpen"));
    const contained = throwing.runtime.evaluate(makeInput("onFeatures"));
    expect(contained.kind).toBe("CONTAINED");
    expect(throwing.sink.calls.map((call) => call.record.evaluationSeq)).toEqual([1]);
    expect(throwing.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([1]);
  });

  it("refuses to evaluate once the run's counter is exhausted, before the callback is invoked", () => {
    const seeded = runEvaluationSequenceAfter(MAX_EVALUATION_SEQ);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    let invoked = 0;
    const { runtime, sink } = makeHarness({
      sequence: seeded.sequence,
      strategy: makeStrategy({
        onFeatures: (ctx) => {
          invoked += 1;
          return { decisionType: "hold", reasonCodes: [], featureSnapshotRef: ctx.features().snapshotRef, intents: [] };
        },
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind === "REFUSED") expect(outcome.refusal.code).toBe("EVALUATION_SEQ_EXHAUSTED");
    expect(invoked).toBe(0);
    expect(sink.calls).toHaveLength(0);
    expect(seeded.sequence.take()).toBeUndefined();
  });
});
