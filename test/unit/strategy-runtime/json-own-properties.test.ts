/**
 * Regression suite for review finding **M1** (remediation round 1, 2026-09-02):
 * `checkpointableJsonProblem` validated with `Object.keys`, which cannot see
 * symbol-keyed or non-enumerable own properties, so it accepted state that
 * canonical serialization then dropped in silence.
 *
 * The reviewer's reproduction:
 *
 * ```
 * problemOf({ visible: 1, [Symbol("lost")]: 2 })  -> null
 * canonicalJsonStringify   ({ visible: 1, [Symbol("lost")]: 2 })  -> {"visible":1}
 * ```
 *
 * Reproduced again end to end during remediation: a NESTED symbol key rode an
 * accepted `statePatch` into live in-memory state while the checkpoint bytes
 * dropped it (`{"nested":{"visible":1}}`), so a restored instance and the live
 * one disagreed — a §12.4 replay divergence with no loud failure anywhere.
 *
 * Every own-property form that JSON cannot round-trip is now refused with a
 * path. The rulings, deliberately one per form:
 *
 * | form | ruling | why |
 * | --- | --- | --- |
 * | symbol key | REFUSE | invisible to `Object.keys`; dropped silently |
 * | non-enumerable property | REFUSE | same |
 * | accessor (getter/setter) | REFUSE | value is computed, returns as a data property; a getter over mutable state can serialize differently on two passes |
 * | non-index own property on an array | REFUSE | arrays serialize positionally; dropped silently |
 * | array hole | already refused | reading the index yields `undefined` |
 *
 * The complementary pin at the bottom is the general statement: for any value
 * the grammar ACCEPTS, canonical serialization emits every own property. That
 * is the invariant M1 violated, and it fails for any future hole of the same
 * shape even if nobody thinks to name the form.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  createStrategyInstanceRuntime,
  deepFreeze,
  materializeCheckpointableJson,
  restoreCheckpoint,
} from "../../../packages/strategy-runtime/src/index.js";
import type { DecisionResult, StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import { CONFIG_ID, INSTANCE_ID, makeDefinition, makeInput, makeStrategy, RUN_ID, RUN_SEED } from "./helpers.js";

/**
 * The validate-only shape these tests were written against; the export it used
 * to call (`checkpointableJsonProblem`) was removed in remediation round 3 (see
 * `json.test.ts` for the reasoning). Every assertion is unchanged.
 */
function problemOf(value: unknown): string | null {
  const result = materializeCheckpointableJson(value);
  return result.ok ? null : result.problem;
}

/** Builds `{ visible: 1, [Symbol("lost")]: 2 }` — the reviewer's exact value. */
function withSymbolKey(): Record<string, unknown> {
  const value: Record<string, unknown> = { visible: 1 };
  (value as Record<PropertyKey, unknown>)[Symbol("lost")] = 2;
  return value;
}

describe("M1: own-property forms that JSON cannot round-trip are refused, not silently dropped", () => {
  it("refuses a symbol-keyed property — the exact value the review reproduced", () => {
    const value = withSymbolKey();
    const problem = problemOf(value);
    expect(problem).not.toBeNull();
    expect(problem).toContain("symbol-keyed property");
    expect(problem).toContain("Symbol(lost)");
    // The serializer's silent behavior is unchanged and is exactly why
    // validation must refuse: these bytes are missing a property.
    expect(canonicalJsonStringify(value)).toBe('{"visible":1}');
  });

  it("refuses a symbol key at any depth, naming the path", () => {
    const inner = withSymbolKey();
    expect(problemOf({ outer: { inner } })).toContain("$.outer.inner:");
    expect(problemOf([{ a: inner }])).toContain("$[0].a:");
  });

  it("refuses a non-enumerable own property (invisible to Object.keys)", () => {
    const value: Record<string, unknown> = { visible: 1 };
    Object.defineProperty(value, "hidden", { value: 2, enumerable: false });
    const problem = problemOf(value);
    expect(problem).toContain("$.hidden");
    expect(problem).toContain("non-enumerable");
    expect(canonicalJsonStringify(value)).toBe('{"visible":1}');
  });

  it("refuses an accessor property WITHOUT invoking the getter", () => {
    let getterCalls = 0;
    const value: Record<string, unknown> = { visible: 1 };
    Object.defineProperty(value, "computed", {
      get: () => {
        getterCalls += 1;
        return getterCalls;
      },
      enumerable: true,
    });
    const problem = problemOf(value);
    expect(problem).toContain("$.computed");
    expect(problem).toContain("accessor");
    // Validating strategy state must not execute strategy code — and a getter
    // that counts calls is precisely the value whose serialization is not
    // reproducible: two passes would emit different bytes.
    expect(getterCalls).toBe(0);
  });

  it("refuses a setter-only property too (it serializes as undefined)", () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "writeOnly", { set: () => undefined, enumerable: true });
    expect(problemOf(value)).toContain("accessor");
  });

  it("refuses non-index own properties on an array (arrays serialize positionally)", () => {
    const withExtra = Object.assign([1, 2], { extra: 3 });
    expect(problemOf(withExtra)).toContain("non-index own property extra");
    expect(canonicalJsonStringify(withExtra)).toBe("[1,2]");

    const withSymbol: unknown[] = [1];
    (withSymbol as unknown as Record<PropertyKey, unknown>)[Symbol("s")] = 9;
    expect(problemOf(withSymbol)).toContain("symbol-keyed property");

    const withNonEnumerableIndex = [1, 2];
    Object.defineProperty(withNonEnumerableIndex, 0, { enumerable: false });
    expect(problemOf(withNonEnumerableIndex)).toContain("non-enumerable");
  });

  it("still refuses an array hole (the value axis already covered it)", () => {
    // Built with `deleteProperty` rather than the sparse literal `[1, , 3]`,
    // which `no-sparse-arrays` forbids in this repository's lint config.
    const holed: unknown[] = [1, 2, 3];
    Reflect.deleteProperty(holed, 1);
    expect(problemOf(holed)).toContain("$[1]: undefined");
    // Why it must stay refused: the canonical serializer emits invalid text.
    expect(canonicalJsonStringify(holed)).toBe("[1,,3]");
    expect(() => JSON.parse(canonicalJsonStringify(holed)) as unknown).toThrow();
  });

  it("does NOT over-refuse: ordinary, deep-frozen, and JSON.parse-produced state still validates", () => {
    expect(problemOf({ a: 1, b: [1, 2, { c: "0.5" }], d: null })).toBeNull();
    expect(problemOf(deepFreeze({ a: { b: [1, { c: true }] } }))).toBeNull();
    expect(problemOf(Object.create(null) as object)).toBeNull();
    expect(
      problemOf(JSON.parse('{"z":1,"a":{"b":[1,2,null]}}') as unknown),
    ).toBeNull();
    // Length is the array intrinsic, not a serialized key.
    expect(problemOf([1, 2, 3])).toBeNull();
    expect(problemOf(Object.freeze([1, 2, 3]))).toBeNull();
  });

  it("the restore path is unaffected: a canonical checkpoint still restores", () => {
    const restored = restoreCheckpoint(
      {
        checkpointSchemaVersion: 1,
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
        stateJson: '{"a":1,"b":{"c":[1,2]}}',
      },
      {
        runId: RUN_ID,
        instanceId: INSTANCE_ID,
        strategyName: "test-strategy",
        strategyVersion: "1.0.0",
        stateSchemaVersion: 1,
        configId: CONFIG_ID,
        runSeed: RUN_SEED,
      },
    );
    expect(restored.ok).toBe(true);
  });

  it("INVARIANT: for any accepted value, canonical bytes carry every own property", () => {
    const accepted: unknown[] = [
      { visible: 1, nested: { a: [1, 2, { b: "x" }] } },
      [1, "two", null, { three: 3 }],
      {},
      [],
      { "": 0, "0": 1, "é": true },
    ];
    for (const value of accepted) {
      expect(problemOf(value)).toBeNull();
      const roundTripped = JSON.parse(canonicalJsonStringify(value)) as unknown;
      expect(ownKeyTree(roundTripped)).toEqual(ownKeyTree(value));
    }
    // …and the rejected forms are exactly the ones that break it.
    for (const value of [withSymbolKey(), Object.assign([1], { x: 2 })]) {
      expect(problemOf(value)).not.toBeNull();
      const roundTripped = JSON.parse(canonicalJsonStringify(value)) as unknown;
      expect(ownKeyTree(roundTripped)).not.toEqual(ownKeyTree(value));
    }
  });

  it("end to end: a nested symbol-keyed statePatch is CONTAINED, not silently dropped", () => {
    const nested: Record<string, unknown> = { visible: 1 };
    (nested as Record<PropertyKey, unknown>)[Symbol("lost")] = 2;
    const { definition, store, sink } = makeDefinition({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => ({
          decisionType: "hold",
          reasonCodes: ["TEST.HOLD"],
          featureSnapshotRef: ctx.features().snapshotRef,
          statePatch: { nested },
          intents: [],
        }),
      }),
    });
    const created = createStrategyInstanceRuntime(definition);
    if (!created.ok) {
      throw new Error("creation refused");
    }
    const outcome = created.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe("RUNTIME.STATE_PATCH_INVALID");
    expect(outcome.failure.detail).toContain("symbol-keyed property");
    // Exactly one record, and NOTHING of the patch reached the state bytes —
    // before the fix this evaluation was DECIDED with checkpoint bytes
    // {"nested":{"visible":1}} while the live state still held the symbol.
    expect(sink.calls).toHaveLength(1);
    expect(store.checkpoints.at(-1)?.stateJson).toBe("{}");
  });
});

/**
 * The own-key structure of a value, symbols included — what a round trip must
 * preserve. Used to state the invariant without enumerating property forms.
 */
function ownKeyTree(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value;
  }
  const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
  return keys
    .map((key) => String(key))
    .sort()
    .map((key) => [key, ownKeyTree((value as Record<string, unknown>)[key])]);
}
