/**
 * Regression suite for the runtime-side half of review round 2's HIGH finding
 * (remediation round 2, 2026-09-02).
 *
 * The finding was not only that an exotic `statePatch` slipped through the
 * grammar (that half is `json-exotic-values.test.ts`); it was WHERE the
 * resulting failure landed. The runtime validated the patch, persisted the
 * decision, and only THEN merged and froze the state — so a `Proxy` whose trap
 * threw at freezing time threw AFTER `DecisionSink.persist()` had run. The
 * reviewer's transcript, verbatim, against the round-1 code:
 *
 * ```
 * validator=null
 * first=Error:POST_FREEZE_PROXY_GET
 * second=DECIDED
 * sequences=[0,0]
 * checkpoints=[0]
 * status=ACTIVE
 * ```
 *
 * Three separate invariants broke at once, and this file pins all three:
 *
 * 1. **Containment.** The throw escaped `evaluate()`. A strategy must never be
 *    able to make the runtime throw; every failure is a typed outcome.
 * 2. **Durability agreement.** A decision was persisted with NO checkpoint, so
 *    the durable record and the recoverable state disagreed.
 * 3. **Sequence identity.** `evaluationSeq` 0 was persisted twice
 *    (`sequences=[0,0]`), because the increment sat after the throwing step.
 *
 * The fix is an ordering rule, stated once and tested here from both ends:
 * everything that reads strategy-supplied data — parsing the decision,
 * materializing the patch, merging the state, serializing it — happens BEFORE
 * `DecisionSink.persist`, and the commit that follows a persist consists only
 * of assignments of values already computed. Anything that fails does so while
 * nothing durable has happened yet, and comes out as a contained runtime skip.
 */

import { describe, expect, it } from "vitest";

import type { EvaluationOutcome } from "../../../packages/strategy-runtime/src/index.js";
import type { DecisionResult, StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import {
  makeHarness,
  makeInput,
  makeStrategy,
  RecordingSink,
  RecordingStore,
  type Harness,
} from "./helpers.js";

/** The reviewer's value: ordinary until frozen, hostile afterwards. */
function postFreezeProxy(): { proxy: object; target: Record<string, unknown> } {
  const target: Record<string, unknown> = { a: 1 };
  let frozen = false;
  const proxy = new Proxy(target, {
    get(t, key, receiver): unknown {
      if (frozen) {
        throw new Error("POST_FREEZE_PROXY_GET");
      }
      return Reflect.get(t, key, receiver);
    },
    preventExtensions(t): boolean {
      frozen = true;
      Object.preventExtensions(t);
      return true;
    },
  });
  return { proxy, target };
}

/** A strategy whose `onFeatures` returns `patch` as its `statePatch`. */
function patchingStrategy(patch: () => Record<string, unknown>) {
  return makeStrategy({
    onFeatures: (ctx: StrategyContext): DecisionResult => ({
      decisionType: "hold",
      reasonCodes: ["TEST.HOLD"],
      featureSnapshotRef: ctx.features().snapshotRef,
      statePatch: patch(),
      intents: [],
    }),
  });
}

/** Every persisted decision has a checkpoint carrying the same sequence. */
function assertRecordsAndCheckpointsAgree(harness: Harness): void {
  const sequences = harness.sink.calls.map((call) => call.record.evaluationSeq);
  const checkpointSeqs = harness.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq);
  expect(checkpointSeqs).toEqual(sequences);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(sequences).toEqual(sequences.map((_, index) => index));
}

describe("a decision is never persisted before the state it depends on is final", () => {
  it("the reviewer's transcript: no escaped throw, a checkpoint per decision, no re-used sequence", () => {
    let call = 0;
    const { proxy, target } = postFreezeProxy();
    const harness = makeHarness({
      strategy: patchingStrategy(() => {
        call += 1;
        return call === 1 ? { nested: proxy } : { plain: call };
      }),
    });

    // 1. Containment: the evaluation that used to throw out of `evaluate()`.
    let first: EvaluationOutcome | undefined;
    expect(() => {
      first = harness.runtime.evaluate(makeInput("onFeatures"));
    }).not.toThrow();
    expect(first?.kind).toBe("DECIDED");
    const second = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(second.kind).toBe("DECIDED");

    // 2. and 3. — `sequences=[0,0]` / `checkpoints=[0]` before the fix.
    expect(harness.sink.calls.map((c) => c.record.evaluationSeq)).toEqual([0, 1]);
    expect(harness.store.checkpoints.map((c) => c.checkpointSeq)).toEqual([0, 1]);
    assertRecordsAndCheckpointsAgree(harness);
    expect(harness.runtime.instanceStatus()).toBe("ACTIVE");

    // The runtime kept its own copy: the strategy's proxy was never frozen,
    // never re-read, and is not what the sink received.
    expect(Object.isExtensible(target)).toBe(true);
    const persistedPatch = harness.sink.calls[0]?.record.decision.statePatch;
    expect(persistedPatch?.["nested"]).not.toBe(proxy);
    expect(persistedPatch?.["nested"]).toEqual({ a: 1 });
    expect(harness.store.checkpoints[0]?.stateJson).toBe('{"nested":{"a":1}}');
  });

  it("the state patch is fully read BEFORE the decision is persisted, and never after", () => {
    let reads = 0;
    let readsAtPersist = -1;
    const counting = new Proxy(
      { a: 1, b: 2 },
      {
        get(t, key, receiver): unknown {
          reads += 1;
          return Reflect.get(t, key, receiver);
        },
      },
    );
    const sink = new RecordingSink();
    const store = new RecordingStore();
    const harness = makeHarness({
      strategy: patchingStrategy(() => ({ nested: counting })),
      decisionSink: sink,
      checkpointStore: store,
    });
    sink.onPersist = (): void => {
      readsAtPersist = reads;
    };

    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    // Both properties were already read when `persist` ran…
    expect(readsAtPersist).toBeGreaterThanOrEqual(2);
    // …and the original was not touched again afterwards, by the freeze, the
    // serializer, or the checkpoint.
    expect(reads).toBe(readsAtPersist);
  });

  it("a patch the boundary refuses is CONTAINED before any persist, with one record and one checkpoint", () => {
    const eager = new Proxy(
      { a: 1 },
      {
        get(): unknown {
          throw new Error("EAGER_PROXY_GET");
        },
      },
    );
    const harness = makeHarness({ strategy: patchingStrategy(() => ({ nested: eager })) });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));

    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe("RUNTIME.STATE_PATCH_INVALID");
    expect(outcome.failure.detail).toContain("EAGER_PROXY_GET");
    expect(outcome.record.attribution).toBe("RUNTIME");
    expect(outcome.record.decision.statePatch).toBeUndefined();
    expect(harness.sink.calls).toHaveLength(1);
    assertRecordsAndCheckpointsAgree(harness);
    expect(harness.store.checkpoints[0]?.stateJson).toBe("{}");
    expect(harness.runtime.instanceStatus()).toBe("PAUSED");
  });

  it("a hostile RETURNED decision is contained too — validation itself may not throw", () => {
    // The throw lands inside `DecisionResultSchema.safeParse`, which is why the
    // whole inspection region, not only the state patch, sits before persist.
    const hostile = new Proxy(
      {},
      {
        get(): unknown {
          throw new Error("RETURNED_PROXY_GET");
        },
        ownKeys(): ArrayLike<string | symbol> {
          throw new Error("RETURNED_PROXY_OWNKEYS");
        },
      },
    ) as unknown as DecisionResult;
    const harness = makeHarness({
      strategy: makeStrategy({ onFeatures: (): DecisionResult => hostile }),
    });

    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    }).not.toThrow();
    expect(outcome?.kind).toBe("CONTAINED");
    if (outcome?.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe("RUNTIME.DECISION_INVALID");
    expect(outcome.failure.detail).toContain("RETURNED_PROXY");
    expect(harness.sink.calls).toHaveLength(1);
    assertRecordsAndCheckpointsAgree(harness);
    expect(harness.runtime.instanceStatus()).toBe("PAUSED");
  });

  it("INVARIANT: no strategy value makes evaluate() throw, and every persisted decision is checkpointed", () => {
    const hostilePatches: ReadonlyArray<{ name: string; patch: () => Record<string, unknown> }> = [
      { name: "post-freeze proxy", patch: () => ({ nested: postFreezeProxy().proxy }) },
      {
        name: "eagerly throwing proxy",
        patch: () => ({
          nested: new Proxy(
            { a: 1 },
            {
              get(): unknown {
                throw new Error("EAGER");
              },
            },
          ),
        }),
      },
      {
        name: "throwing ownKeys",
        patch: () => ({
          nested: new Proxy(
            { a: 1 },
            {
              ownKeys(): ArrayLike<string | symbol> {
                throw new Error("OWN_KEYS");
              },
            },
          ),
        }),
      },
      {
        name: "throwing prototype",
        patch: () => ({
          nested: new Proxy(
            { a: 1 },
            {
              getPrototypeOf(): object | null {
                throw new Error("PROTO");
              },
            },
          ),
        }),
      },
      // The same hostility applied at the TOP level of the patch, where Zod's
      // record parse reads it before the boundary ever sees it.
      {
        name: "top-level post-freeze proxy",
        patch: () => postFreezeProxy().proxy as Record<string, unknown>,
      },
      {
        name: "top-level throwing proxy",
        patch: () =>
          new Proxy(
            { a: 1 },
            {
              get(): unknown {
                throw new Error("TOP_LEVEL_GET");
              },
            },
          ) as Record<string, unknown>,
      },
      { name: "function value", patch: () => ({ fn: (): number => 1 }) },
      { name: "date value", patch: () => ({ when: new Date(0) }) },
      { name: "self-referential patch", patch: selfReferentialPatch },
      { name: "ordinary patch", patch: () => ({ count: 1 }) },
    ];

    for (const { name, patch } of hostilePatches) {
      const harness = makeHarness({ strategy: patchingStrategy(patch) });
      // Two good evaluations first, so a re-used sequence would be visible.
      const outcomes: EvaluationOutcome["kind"][] = [];
      for (let index = 0; index < 3; index += 1) {
        let outcome: EvaluationOutcome | undefined;
        expect(() => {
          outcome = harness.runtime.evaluate(makeInput("onFeatures"));
        }, `${name}: evaluate() must not throw`).not.toThrow();
        if (outcome !== undefined) {
          outcomes.push(outcome.kind);
        }
      }
      expect(outcomes.every((kind) => kind !== "HALTED"), name).toBe(true);
      assertRecordsAndCheckpointsAgree(harness);

      // A contained instance pauses, and a paused instance persists nothing
      // further — so no later record can land on a sequence already used, and
      // an instance that was NOT contained keeps working normally.
      const contained = outcomes.includes("CONTAINED");
      expect(harness.runtime.instanceStatus(), name).toBe(contained ? "PAUSED" : "ACTIVE");
      const persistedBefore = harness.sink.calls.length;
      const next = harness.runtime.evaluate(makeInput("onFeatures"));
      expect(next.kind, name).toBe(contained ? "REFUSED" : "DECIDED");
      expect(harness.sink.calls.length, name).toBe(
        contained ? persistedBefore : persistedBefore + 1,
      );
      assertRecordsAndCheckpointsAgree(harness);
    }
  });

  it("INVARIANT: an evaluation that fails at PERSIST leaves the sequence unconsumed AND the instance unusable", () => {
    const harness = makeHarness({ strategy: patchingStrategy(() => ({ count: 1 })) });
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(harness.runtime.nextEvaluationSeq()).toBe(1);

    harness.sink.failNext = true;
    const halted = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(halted.kind).toBe("HALTED");
    if (halted.kind !== "HALTED") {
      return;
    }
    expect(halted.stage).toBe("PERSIST_DECISION");
    // The sequence was NOT consumed (the write's fate is unknown, and the
    // runtime does not retry) — so the guarantee that no two records share a
    // sequence rests on the instance being unusable from here on.
    expect(harness.runtime.nextEvaluationSeq()).toBe(1);
    expect(harness.runtime.instanceStatus()).toBe("PAUSED");
    const after = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(after.kind).toBe("REFUSED");
    expect(harness.sink.calls).toHaveLength(1);
    assertRecordsAndCheckpointsAgree(harness);
  });

  it("INVARIANT: an evaluation that fails at CHECKPOINT has already consumed its sequence", () => {
    const harness = makeHarness({ strategy: patchingStrategy(() => ({ count: 1 })) });
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");

    harness.store.failNext = true;
    const halted = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(halted.kind).toBe("HALTED");
    if (halted.kind !== "HALTED") {
      return;
    }
    expect(halted.stage).toBe("SAVE_CHECKPOINT");
    expect(halted.record.evaluationSeq).toBe(1);
    // Two durable records, one checkpoint: the disagreement is REPORTED as a
    // halt naming the port, which is the documented §6-invariant-6 behavior —
    // unlike the finding, where the same disagreement was silent.
    expect(harness.sink.calls.map((c) => c.record.evaluationSeq)).toEqual([0, 1]);
    expect(harness.store.checkpoints.map((c) => c.checkpointSeq)).toEqual([0]);
    expect(harness.runtime.instanceStatus()).toBe("PAUSED");
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("REFUSED");
  });

  it("a view that cannot be taken into ownership is REFUSED, not thrown, and burns no sequence", () => {
    const unfreezable = new Proxy(
      { snapshotRef: "snap-1", asOf: "2026-01-02T03:04:05.000Z", values: {} },
      {
        preventExtensions(): boolean {
          throw new Error("VIEW_PREVENT_EXTENSIONS");
        },
      },
    );
    const harness = makeHarness();

    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(makeInput("onFeatures", { features: unfreezable }));
    }).not.toThrow();
    expect(outcome?.kind).toBe("REFUSED");
    if (outcome?.kind !== "REFUSED") {
      return;
    }
    expect(outcome.refusal.code).toBe("INPUT_INVALID");
    expect(outcome.refusal.detail).toContain("VIEW_PREVENT_EXTENSIONS");
    // The callback was never invoked, so §6 invariant 3 does not bind: no
    // record, no checkpoint, no sequence consumed, and the instance is still
    // usable with a well-formed input.
    expect(harness.sink.calls).toHaveLength(0);
    expect(harness.store.checkpoints).toHaveLength(0);
    expect(harness.runtime.instanceStatus()).toBe("ACTIVE");
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(harness.sink.calls[0]?.record.evaluationSeq).toBe(0);
  });

  it("determinism: a Proxy-wrapped patch produces the same bytes as the plain object it copies", () => {
    const run = (wrap: boolean): { records: string; checkpoints: string } => {
      const harness = makeHarness({
        strategy: patchingStrategy(() => {
          const plain = { count: 1, nested: { deep: [1, 2, "x"] } };
          return wrap ? { ...plain, nested: new Proxy(plain.nested, {}) } : plain;
        }),
      });
      expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
      return {
        // `JSON.stringify`, not the canonical serializer: insertion order is
        // compared too, so a copy that merely sorts the same would not pass.
        records: JSON.stringify(harness.sink.calls.map((call) => call.record)),
        checkpoints: JSON.stringify(harness.store.checkpoints),
      };
    };
    const plain = run(false);
    const proxied = run(true);
    expect(proxied.records).toBe(plain.records);
    expect(proxied.checkpoints).toBe(plain.checkpoints);
  });
});

function selfReferentialPatch(): Record<string, unknown> {
  const patch: Record<string, unknown> = { a: 1 };
  patch["self"] = patch;
  return patch;
}
