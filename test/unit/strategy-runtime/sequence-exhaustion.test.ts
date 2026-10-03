/**
 * The evaluation sequence is finite, and reaching the end is a refusal
 * (remediation round 4, 2026-09-03 — review round 4's HIGH 1).
 *
 * The reviewer's transcript against the round-3 code: a checkpoint carrying
 * `checkpointSeq: Number.MAX_SAFE_INTEGER` restored happily, and the two
 * ordinary DECIDED evaluations that followed persisted the SAME sequence
 * number:
 *
 * ```
 * created=true
 * sequences=[9007199254740992,9007199254740992]
 * checkpoints=[9007199254740992,9007199254740992]
 * safe=[false,false]
 * ```
 *
 * That is the reused-sequence class round 2 closed, reopened from the other
 * end: not by a failure path skipping the commit, but by arithmetic. Above
 * `Number.MAX_SAFE_INTEGER` the successor function on doubles stops being
 * injective, so `seq += 1` silently does nothing.
 *
 * Two enforced bounds close it, and this file pins both at exactly the pair the
 * arithmetic implies:
 *
 * - `restoreCheckpoint` refuses a `checkpointSeq` whose SUCCESSOR — the next
 *   evaluation sequence — is not exactly representable. `MAX_EVALUATION_SEQ`
 *   (= `Number.MAX_SAFE_INTEGER - 1`) is accepted; `Number.MAX_SAFE_INTEGER` is
 *   refused;
 * - `evaluate()` refuses BEFORE the callback once the counter has passed
 *   `MAX_EVALUATION_SEQ`, so nothing runs, no record is owed, and the condition
 *   cannot un-trip.
 *
 * The oracles below do not ask the runtime what its counter is: they read the
 * sequences off the persisted records and check distinctness and exact
 * representability directly.
 *
 * `CKPT-1` (ADR-027 D2): a restore now takes a restore POINT, and the next
 * sequence is its `highestEvaluationSeq + 1`, not `checkpointSeq + 1`. The
 * restores here say "the checkpoint is the last durable decision", which keeps
 * every bound where it was; the new bound on `highestEvaluationSeq` is pinned
 * beside the old one. A restored runtime is not at START (D1.4), so the
 * evaluations that must still write a checkpoint are placed 60 s apart in
 * event time — the HEARTBEAT (D1.6) — and each re-pin says so.
 */

import { describe, expect, it } from "vitest";

import {
  createStrategyInstanceRuntime,
  MAX_EVALUATION_SEQ,
  restoreCheckpoint,
  restoreFromPoint,
  type CheckpointIdentity,
  type CreateRuntimeResult,
  type StrategyStateCheckpoint,
} from "../../../packages/strategy-runtime/src/index.js";
import {
  CONFIG_ID,
  INSTANCE_ID,
  makeDefinition,
  makeInput,
  restorePoint,
  RUN_ID,
  RUN_SEED,
  type Harness,
} from "./helpers.js";

/** `CKPT-1`: the k-th minute after the helpers' `T0` (2026-01-02T03:04:05.000Z). */
function minutesAfterT0(minutes: number): string {
  return new Date(Date.parse("2026-01-02T03:04:05.000Z") + minutes * 60_000).toISOString();
}

const IDENTITY: CheckpointIdentity = {
  runId: RUN_ID,
  instanceId: INSTANCE_ID,
  strategyName: "test-strategy",
  strategyVersion: "1.0.0",
  stateSchemaVersion: 1,
  configId: CONFIG_ID,
  runSeed: RUN_SEED,
};

function checkpointAt(checkpointSeq: number): StrategyStateCheckpoint {
  return {
    checkpointSchemaVersion: 1,
    runId: RUN_ID,
    instanceId: INSTANCE_ID,
    strategyName: "test-strategy",
    strategyVersion: "1.0.0",
    stateSchemaVersion: 1,
    configId: CONFIG_ID,
    runSeed: RUN_SEED,
    checkpointSeq,
    status: "ACTIVE",
    rngState: [1, 2, 3, 4],
    stateJson: "{}",
  };
}

type RestoreAttempt =
  | { readonly ok: true; readonly harness: Harness }
  | { readonly ok: false; readonly refusal: Extract<CreateRuntimeResult, { ok: false }>["refusal"] };

function restoredHarness(checkpointSeq: number): RestoreAttempt {
  const { definition, sink, store, clock } = makeDefinition({
    restoreFrom: restorePoint(checkpointAt(checkpointSeq)),
  });
  const created = createStrategyInstanceRuntime(definition);
  if (!created.ok) {
    return { ok: false, refusal: created.refusal };
  }
  return { ok: true, harness: { runtime: created.runtime, sink, store, clock } };
}

/** The oracle: every persisted sequence, read off the records themselves. */
function persistedSequences(harness: Harness): number[] {
  return harness.sink.calls.map((call) => call.record.evaluationSeq);
}

describe("HIGH 1: the evaluation sequence cannot silently stop advancing", () => {
  it("the constant states the arithmetic: the last consumable sequence is MAX_SAFE_INTEGER - 1", () => {
    // Pinned so that widening it is a deliberate, visible act. The successor of
    // this value is `Number.MAX_SAFE_INTEGER`, which is still exact; the
    // successor of THAT is not.
    expect(MAX_EVALUATION_SEQ).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(Number.isSafeInteger(MAX_EVALUATION_SEQ + 1)).toBe(true);
    // The property that makes the finding possible, stated independently of the
    // product: above the safe bound, `+ 1` is the identity function.
    expect(Number.MAX_SAFE_INTEGER + 1 + 1).toBe(Number.MAX_SAFE_INTEGER + 1);
  });

  it("the reviewer's transcript: a checkpoint at MAX_SAFE_INTEGER is REFUSED, so the duplicate never happens", () => {
    const result = restoredHarness(Number.MAX_SAFE_INTEGER);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusal.code).toBe("CHECKPOINT_SEQ_INVALID");
    expect(result.refusal.detail).toContain("exactly representable");
  });

  it("the boundary pair, at restore: MAX_EVALUATION_SEQ is accepted and MAX_SAFE_INTEGER is refused", () => {
    // `CKPT-1` re-pin: the next sequence is the restore POINT's answer now.
    const accepted = restoreFromPoint(restorePoint(checkpointAt(MAX_EVALUATION_SEQ)), IDENTITY);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.restored.nextEvaluationSeq).toBe(Number.MAX_SAFE_INTEGER);
      expect(Number.isSafeInteger(accepted.restored.nextEvaluationSeq)).toBe(true);
    }
    // …and the same pair on the restore point's own bound: a highest durable
    // sequence of MAX_SAFE_INTEGER is refused, whatever the checkpoint says.
    const pointPastBound = restoreFromPoint(
      restorePoint(checkpointAt(MAX_EVALUATION_SEQ - 5), MAX_EVALUATION_SEQ + 1),
      IDENTITY,
    );
    expect(pointPastBound.ok).toBe(false);
    if (!pointPastBound.ok) {
      expect(pointPastBound.refusal.code).toBe("RESTORE_SEQ_INVALID");
      expect(pointPastBound.refusal.detail).toContain("exactly representable");
    }
    const pointAtBound = restoreFromPoint(
      restorePoint(checkpointAt(MAX_EVALUATION_SEQ - 5), MAX_EVALUATION_SEQ),
      IDENTITY,
    );
    expect(pointAtBound.ok && pointAtBound.restored.nextEvaluationSeq).toBe(Number.MAX_SAFE_INTEGER);

    const refused = restoreCheckpoint(checkpointAt(MAX_EVALUATION_SEQ + 1), IDENTITY);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("CHECKPOINT_SEQ_INVALID");
    }

    // …and a value past the safe range at all is refused by the older rule.
    const unsafe = restoreCheckpoint(checkpointAt(Number.MAX_SAFE_INTEGER + 1), IDENTITY);
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) {
      expect(unsafe.refusal.code).toBe("CHECKPOINT_SEQ_INVALID");
      expect(unsafe.refusal.detail).toContain("non-negative safe integer");
    }
  });

  it("an instance whose counter has reached the bound refuses every evaluation, forever, with no record", () => {
    const attempt = restoredHarness(MAX_EVALUATION_SEQ);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) {
      return;
    }
    const harness = attempt.harness;
    expect(harness.runtime.nextEvaluationSeq()).toBe(Number.MAX_SAFE_INTEGER);

    // Repeated, because "cannot silently continue" is a claim about EVERY later
    // call: the condition is monotone in a counter that only grows.
    for (let call = 0; call < 5; call += 1) {
      const outcome = harness.runtime.evaluate(makeInput());
      expect(outcome.kind).toBe("REFUSED");
      if (outcome.kind === "REFUSED") {
        expect(outcome.refusal.code).toBe("EVALUATION_SEQ_EXHAUSTED");
        expect(outcome.refusal.detail).toContain("new run");
      }
    }
    // Nothing was invoked, nothing was persisted, nothing was checkpointed, and
    // the instance is still ACTIVE rather than pretending to have failed.
    expect(harness.sink.calls).toHaveLength(0);
    expect(harness.store.checkpoints).toHaveLength(0);
    expect(harness.runtime.instanceStatus()).toBe("ACTIVE");
    expect(harness.runtime.nextEvaluationSeq()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("the last usable sequence is consumed exactly ONCE, and the next attempt is refused", () => {
    const attempt = restoredHarness(MAX_EVALUATION_SEQ - 1);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) {
      return;
    }
    const harness = attempt.harness;
    expect(harness.runtime.nextEvaluationSeq()).toBe(MAX_EVALUATION_SEQ);

    // `CKPT-1`: 60 s after the restored checkpoint's instant (T0), so the
    // HEARTBEAT writes this decision's checkpoint (a restored runtime has no
    // START, and this hold changes nothing else).
    const first = harness.runtime.evaluate(makeInput("onFeatures", { evaluatedAt: minutesAfterT0(1) }));
    expect(first.kind).toBe("DECIDED");
    expect(first.kind === "DECIDED" && first.checkpointTransitions).toEqual(["HEARTBEAT"]);
    const second = harness.runtime.evaluate(makeInput("onFeatures", { evaluatedAt: minutesAfterT0(2) }));
    expect(second.kind).toBe("REFUSED");
    if (second.kind === "REFUSED") {
      expect(second.refusal.code).toBe("EVALUATION_SEQ_EXHAUSTED");
    }

    const sequences = persistedSequences(harness);
    expect(sequences).toEqual([MAX_EVALUATION_SEQ]);
    expect(harness.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([MAX_EVALUATION_SEQ]);
    // The oracle, applied to what was actually persisted rather than to the
    // counter: every sequence is exactly representable and no two are equal.
    expect(sequences.every((seq) => Number.isSafeInteger(seq))).toBe(true);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("an ordinary run near the bound still produces distinct, exactly representable sequences", () => {
    const attempt = restoredHarness(MAX_EVALUATION_SEQ - 4);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) {
      return;
    }
    const harness = attempt.harness;
    const kinds: string[] = [];
    // `CKPT-1`: one minute apart, so every decided evaluation is a HEARTBEAT
    // and the checkpoint sequences can still be compared with the records'.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      kinds.push(
        harness.runtime.evaluate(makeInput("onFeatures", { evaluatedAt: minutesAfterT0(attempt + 1) })).kind,
      );
    }
    expect(kinds).toEqual([
      "DECIDED",
      "DECIDED",
      "DECIDED",
      "DECIDED",
      "REFUSED",
      "REFUSED",
    ]);
    const sequences = persistedSequences(harness);
    expect(sequences).toEqual([
      MAX_EVALUATION_SEQ - 3,
      MAX_EVALUATION_SEQ - 2,
      MAX_EVALUATION_SEQ - 1,
      MAX_EVALUATION_SEQ,
    ]);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences.every((seq) => Number.isSafeInteger(seq))).toBe(true);
    expect(harness.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual(sequences);
  });

  it("a fresh run is nowhere near the bound, and the guard costs it nothing", () => {
    const { definition, sink } = makeDefinition({});
    const created = createStrategyInstanceRuntime(definition);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(created.runtime.evaluate(makeInput()).kind).toBe("DECIDED");
    }
    expect(sink.calls.map((call) => call.record.evaluationSeq)).toEqual([0, 1, 2]);
  });
});
