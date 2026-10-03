/**
 * Regression suite for review round 3's MEDIUM 1, MEDIUM 2 and LOW
 * (remediation round 3, 2026-09-03), plus the sweep those findings implied.
 *
 * The three rounds of review found one defect class on three surfaces, and the
 * rule this file pins is the general form of it:
 *
 * - **P1** every caller-supplied value is read ONCE into inert data, and every
 *   downstream consumer reads that same data;
 * - **P2** every function whose contract says it never throws is TOTAL — no
 *   unguarded operation on a caller value, no recursion that can exhaust the
 *   stack, and no error-formatting path that can itself throw.
 *
 * The reviewer's reproductions, verbatim against the round-2 code:
 *
 * ```
 * materializer=THREW:TypeError:Cannot perform 'IsArray' on a proxy that has been revoked
 * validator=THREW:TypeError:Cannot perform 'IsArray' on a proxy that has been revoked
 * throwingCause=THREW:TypeError:Cannot perform 'getPrototypeOf' on a proxy that has been revoked
 * depth=3500 materializer=THREW:RangeError: Maximum call stack size exceeded validator=THREW:RangeError: Maximum call stack size exceeded
 * revokedPatch outcome=CONTAINED reason=RUNTIME.DECISION_INVALID
 * deepRestore=THREW:RangeError: Maximum call stack size exceeded
 * drift=RETURNED:true/reads=2
 * restoreThrow=SECOND_READ/reads=2
 * createThrow=SECOND_READ_CREATE/reads=2
 * ```
 */

import { describe, expect, it } from "vitest";

import * as runtimeModule from "../../../packages/strategy-runtime/src/index.js";
import {
  canonicalJsonStringify,
  createStrategyInstanceRuntime,
  deepFreeze,
  materializeCheckpointableJson,
  MAX_MATERIALIZED_DEPTH,
  rebuildStateFromPatches,
  restoreCheckpoint,
  type CheckpointIdentity,
  type EvaluationOutcome,
  type MonotonicClock,
  type StrategyStateCheckpoint,
} from "../../../packages/strategy-runtime/src/index.js";
import type { DecisionResult, StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import {
  CONFIG_ID,
  holdDecision,
  INSTANCE_ID,
  makeDefinition,
  makeHarness,
  makeInput,
  makeStrategy,
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

const CHECKPOINT_BASE = {
  checkpointSchemaVersion: 1,
  runId: RUN_ID,
  instanceId: INSTANCE_ID,
  strategyName: "test-strategy",
  strategyVersion: "1.0.0",
  stateSchemaVersion: 1,
  configId: CONFIG_ID,
  runSeed: RUN_SEED,
  checkpointSeq: 4,
  status: "ACTIVE" as const,
  rngState: [1, 2, 3, 4] as const,
};

function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
  revoke();
  return proxy;
}

function nestPlainObjects(depth: number): unknown {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

function nestJson(depth: number): string {
  let json = "1";
  for (let index = 0; index < depth; index += 1) {
    json = `{"n":${json}}`;
  }
  return json;
}

function patchingStrategy(patch: () => unknown) {
  return makeStrategy({
    onFeatures: (ctx: StrategyContext): DecisionResult => ({
      decisionType: "hold",
      reasonCodes: ["TEST.HOLD"],
      featureSnapshotRef: ctx.features().snapshotRef,
      statePatch: patch() as Record<string, unknown>,
      intents: [],
    }),
  });
}

describe("MEDIUM 1: the JSON boundary is total", () => {
  it("a REVOKED Proxy is a stated problem, not the TypeError from an unguarded Array.isArray", () => {
    const positions: ReadonlyArray<[string, unknown]> = [
      ["top level", revoked()],
      ["nested value", { nested: revoked() }],
      ["array element", [revoked()]],
      ["deeply nested", { a: { b: [{ c: revoked() }] } }],
    ];
    for (const [name, value] of positions) {
      let result: ReturnType<typeof materializeCheckpointableJson> | undefined;
      expect(() => {
        result = materializeCheckpointableJson(value);
      }, `${name} must not throw`).not.toThrow();
      expect(result?.ok, name).toBe(false);
      if (result?.ok === false) {
        expect(result.problem).toContain("revoked");
      }
    }
  });

  it("a cause that cannot be formatted does not break the refusal path", () => {
    // `describeCause` used to evaluate `cause instanceof Error`, which walks the
    // thrown value's prototype chain — and throws for a revoked Proxy. The three
    // shapes below break each formatting strategy in turn.
    const causes: ReadonlyArray<[string, unknown]> = [
      ["revoked proxy", revoked()],
      ["symbol", Symbol("no-string-conversion")],
      ["null-prototype object", Object.create(null) as object],
      [
        "object whose toString throws",
        {
          toString(): string {
            throw new Error("TO_STRING");
          },
        },
      ],
      [
        "Error whose message accessor throws",
        Object.defineProperty(new Error("hidden"), "message", {
          get(): string {
            throw new Error("MESSAGE_GETTER");
          },
        }),
      ],
    ];
    for (const [name, cause] of causes) {
      const hostile = new Proxy(
        { a: 1 },
        {
          get(): unknown {
            throw cause;
          },
        },
      );
      let result: ReturnType<typeof materializeCheckpointableJson> | undefined;
      expect(() => {
        result = materializeCheckpointableJson({ nested: hostile });
      }, `${name} must not throw`).not.toThrow();
      expect(result?.ok, name).toBe(false);
      if (result?.ok === false) {
        expect(result.problem, name).toContain("$.nested.a");
      }
    }
  });

  it("nesting is bounded by a stated refusal instead of a RangeError", () => {
    // The bound is a contract the boundary owes consumers it does not control
    // (`JSON.stringify` in the composition root, `jsonb` in the store), so it is
    // checked at both edges rather than approximated.
    // Exactly `MAX_MATERIALIZED_DEPTH` nested containers is accepted; one more
    // is refused — the bound is stated, not approximate.
    const atLimit = nestPlainObjects(MAX_MATERIALIZED_DEPTH);
    expect(materializeCheckpointableJson(atLimit).ok).toBe(true);
    const overLimit = nestPlainObjects(MAX_MATERIALIZED_DEPTH + 1);
    const refusal = materializeCheckpointableJson(overLimit);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.problem).toContain(`maximum of ${String(MAX_MATERIALIZED_DEPTH)} containers`);
    }

    // The reviewer's depth, which used to be `RangeError` from both APIs.
    let deepResult: ReturnType<typeof materializeCheckpointableJson> | undefined;
    expect(() => {
      deepResult = materializeCheckpointableJson(nestPlainObjects(3500));
    }).not.toThrow();
    expect(deepResult?.ok).toBe(false);
  });

  it("the serializer and the freezer are stack-safe too, well past the depth any input can reach", () => {
    // These two are reachable with data the runtime built itself, so their
    // safety cannot rest on the boundary's bound alone.
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let index = 0; index < 20_000; index += 1) {
      deep = { n: deep };
    }
    let bytes = "";
    expect(() => {
      bytes = canonicalJsonStringify(deep);
    }).not.toThrow();
    expect(bytes.startsWith('{"n":{"n":')).toBe(true);
    expect(bytes.endsWith('{"leaf":1}' + "}".repeat(20_000))).toBe(true);
    expect(() => deepFreeze(deep)).not.toThrow();
    expect(Object.isFrozen(deep)).toBe(true);
  });

  it("the canonical serializer refuses a cycle loudly instead of hanging or overflowing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    // Its documented precondition is a MATERIALIZED value, and materialization
    // refuses cycles; a caller that skips it gets a typed error rather than an
    // infinite loop (the iterative walk's one new failure mode).
    expect(() => canonicalJsonStringify(cyclic)).toThrow(TypeError);
    expect(materializeCheckpointableJson(cyclic).ok).toBe(false);
  });

  it("a statePatch the boundary cannot read is attributed to the PATCH, not to the decision", () => {
    // `revokedPatch outcome=CONTAINED reason=RUNTIME.DECISION_INVALID` was the
    // mis-attribution: the throw escaped the (total-by-claim) boundary into the
    // outer catch, which calls everything a decision problem.
    const harness = makeHarness({ strategy: patchingStrategy(() => ({ nested: revoked() })) });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe("RUNTIME.STATE_PATCH_INVALID");
    expect(harness.sink.calls).toHaveLength(1);
    expect(harness.store.checkpoints).toHaveLength(1);
    expect(harness.runtime.instanceStatus()).toBe("PAUSED");
  });

  it("an over-deep statePatch is contained as STATE_PATCH_INVALID, and the instance never throws", () => {
    const harness = makeHarness({
      strategy: patchingStrategy(() => ({ deep: nestPlainObjects(3500) })),
    });
    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    }).not.toThrow();
    expect(outcome?.kind).toBe("CONTAINED");
    if (outcome?.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe("RUNTIME.STATE_PATCH_INVALID");
    expect(outcome.failure.detail).toContain("nesting exceeds the maximum");
    expect(harness.store.checkpoints[0]?.stateJson).toBe("{}");
  });
});

describe("MEDIUM 2: the checkpoint document is snapshotted, and both public entry points are total", () => {
  it("the disclosed double read is gone: non-canonical bytes cannot be laundered by a second read", () => {
    // `drift=RETURNED:true/reads=2` — a getter answered the parser with
    // non-canonical bytes and the canonical-form comparison with canonical
    // bytes, so a document that was never canonical restored anyway.
    let reads = 0;
    const drifting = {
      ...CHECKPOINT_BASE,
      get stateJson(): string {
        reads += 1;
        return reads === 1 ? '{"b":1,"a":2}' : '{"a":2,"b":1}';
      },
    } as unknown as StrategyStateCheckpoint;

    const result = restoreCheckpoint(drifting, IDENTITY);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusal.code).toBe("CHECKPOINT_STATE_INVALID");
    expect(result.refusal.detail).toContain("canonical");
    expect(reads).toBe(1);
  });

  it("a getter that throws on its SECOND read cannot escape — there is no second read", () => {
    let reads = 0;
    const throwing = {
      ...CHECKPOINT_BASE,
      get stateJson(): string {
        reads += 1;
        if (reads >= 2) {
          throw new Error("SECOND_READ");
        }
        return '{"a":2}';
      },
    } as unknown as StrategyStateCheckpoint;

    let result: ReturnType<typeof restoreCheckpoint> | undefined;
    expect(() => {
      result = restoreCheckpoint(throwing, IDENTITY);
    }).not.toThrow();
    expect(result?.ok).toBe(true);
    expect(reads).toBe(1);
  });

  it("a getter that throws on its FIRST read is a typed refusal", () => {
    for (const field of ["stateJson", "runId", "rngState", "checkpointSeq", "status"] as const) {
      const document = {
        ...CHECKPOINT_BASE,
        stateJson: '{"a":2}',
      } as unknown as Record<string, unknown>;
      Object.defineProperty(document, field, {
        get: () => {
          throw new Error(`FIELD_${field}`);
        },
        enumerable: true,
        configurable: true,
      });

      let result: ReturnType<typeof restoreCheckpoint> | undefined;
      expect(() => {
        result = restoreCheckpoint(document as unknown as StrategyStateCheckpoint, IDENTITY);
      }, `${field} must not throw`).not.toThrow();
      expect(result?.ok, field).toBe(false);
      if (result?.ok === false) {
        expect(result.refusal.code, field).toBe("CHECKPOINT_STATE_INVALID");
        expect(result.refusal.detail, field).toContain(`FIELD_${field}`);
      }
    }
  });

  it("the same document through the FACTORY is a creation refusal, never a throw", () => {
    // `createThrow=SECOND_READ_CREATE/reads=2` — the escape reached
    // `createStrategyInstanceRuntime`, whose doc says nothing there throws.
    const hostile = {
      ...CHECKPOINT_BASE,
      stateJson: '{"a":2}',
    } as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "stateJson", {
      get: () => {
        throw new Error("STATE_JSON_GETTER");
      },
      enumerable: true,
      configurable: true,
    });
    const { definition } = makeDefinition();

    let created: ReturnType<typeof createStrategyInstanceRuntime> | undefined;
    expect(() => {
      created = createStrategyInstanceRuntime({
        ...definition,
        // `CKPT-1`: a restore takes a restore POINT (ADR-027 D2); the hostile
        // document is its checkpoint, and is still what refuses.
        restoreFrom: restorePoint(hostile as unknown as StrategyStateCheckpoint),
      });
    }).not.toThrow();
    expect(created?.ok).toBe(false);
    if (created?.ok === false) {
      expect(created.refusal.code).toBe("CHECKPOINT_STATE_INVALID");
      expect(created.refusal.detail).toContain("STATE_JSON_GETTER");
    }
  });

  it("deep canonical bytes are refused as CHECKPOINT_STATE_INVALID, not propagated as RangeError", () => {
    const deep = nestJson(3000);
    let result: ReturnType<typeof restoreCheckpoint> | undefined;
    expect(() => {
      result = restoreCheckpoint(
        { ...CHECKPOINT_BASE, stateJson: deep } as unknown as StrategyStateCheckpoint,
        IDENTITY,
      );
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.refusal.code).toBe("CHECKPOINT_STATE_INVALID");
    }
  });

  it("an exotic rngState is refused on the ONE copy that is validated and used", () => {
    let lengthReads = 0;
    const lying = new Proxy([1, 2, 3, 4], {
      get(target, key, receiver): unknown {
        if (key === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? 4 : 2;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = restoreCheckpoint(
      {
        ...CHECKPOINT_BASE,
        rngState: lying as unknown as readonly [number, number, number, number],
        stateJson: "{}",
      } as unknown as StrategyStateCheckpoint,
      IDENTITY,
    );
    // Materialized first, so the lanes that are validated are the lanes that
    // are restored — whichever way the trap answers afterwards.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.restored.rngState).toEqual([1, 2, 3, 4]);
    }

    const hostile = restoreCheckpoint(
      {
        ...CHECKPOINT_BASE,
        rngState: revoked() as unknown as readonly [number, number, number, number],
        stateJson: "{}",
      } as unknown as StrategyStateCheckpoint,
      IDENTITY,
    );
    expect(hostile.ok).toBe(false);
    if (!hostile.ok) {
      expect(hostile.refusal.code).toBe("CHECKPOINT_RNG_STATE_INVALID");
    }
  });

  it("a missing or non-object document and a hostile IDENTITY are refusals too", () => {
    for (const document of [null, undefined, 7, "checkpoint"]) {
      let result: ReturnType<typeof restoreCheckpoint> | undefined;
      expect(() => {
        result = restoreCheckpoint(document as unknown as StrategyStateCheckpoint, IDENTITY);
      }, String(document)).not.toThrow();
      expect(result?.ok).toBe(false);
    }
    const hostileIdentity = {
      ...IDENTITY,
      get runId(): string {
        throw new Error("IDENTITY_RUN_ID");
      },
    } as unknown as CheckpointIdentity;
    let result: ReturnType<typeof restoreCheckpoint> | undefined;
    expect(() => {
      result = restoreCheckpoint(
        { ...CHECKPOINT_BASE, stateJson: "{}" } as unknown as StrategyStateCheckpoint,
        hostileIdentity,
      );
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.refusal.detail).toContain("IDENTITY_RUN_ID");
    }
  });

  it("restore keeps the MATERIALIZED state, not the parsed object the caller could reach", () => {
    const result = restoreCheckpoint(
      { ...CHECKPOINT_BASE, stateJson: '{"a":{"b":[1,2]}}' } as unknown as StrategyStateCheckpoint,
      IDENTITY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.restored.state).toEqual({ a: { b: [1, 2] } });
    expect(Object.isFrozen(result.restored.state)).toBe(true);
    expect(Object.isFrozen((result.restored.state as { a: object }).a)).toBe(true);
  });

  it("rebuildStateFromPatches is total and shares nothing with the decision log it folds", () => {
    const live = { nested: { deep: 1 } };
    const rebuilt = rebuildStateFromPatches([live, undefined, { other: true }]);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) {
      return;
    }
    expect(rebuilt.state).toEqual({ nested: { deep: 1 }, other: true });
    // The caller's objects are neither kept nor frozen.
    expect((rebuilt.state as { nested: object }).nested).not.toBe(live.nested);
    expect(Object.isFrozen(live.nested)).toBe(false);

    for (const patches of [
      [{ nested: revoked() }],
      [revoked()],
      [nestPlainObjects(3500) as Record<string, unknown>],
      "not an array" as unknown as [],
      [{ fn: (): number => 1 }],
    ]) {
      let result: ReturnType<typeof rebuildStateFromPatches> | undefined;
      expect(() => {
        result = rebuildStateFromPatches(patches as ReadonlyArray<Record<string, unknown>>);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    }
  });
});

describe("LOW: the public API no longer offers a validate-then-retain predicate", () => {
  it("exports the materializing boundary and NOT checkpointableJsonProblem", () => {
    const exported = Object.keys(runtimeModule);
    expect(exported).toContain("materializeCheckpointableJson");
    expect(exported).toContain("MAX_MATERIALIZED_DEPTH");
    // Round 2's HIGH came from validating a value and then keeping the original.
    // The predicate that invited that workflow is gone; `restoreCheckpoint`, its
    // last internal caller, keeps the materialized copy instead.
    expect(exported).not.toContain("checkpointableJsonProblem");
  });
});

describe("the P1/P2 sweep: definition, ports and callbacks are captured once and guarded", () => {
  it("a definition whose accessors throw is a typed creation refusal", () => {
    const hostile = new Proxy(
      {},
      {
        get(): unknown {
          throw new Error("DEFINITION_GET");
        },
      },
    );
    let created: ReturnType<typeof createStrategyInstanceRuntime> | undefined;
    expect(() => {
      created = createStrategyInstanceRuntime(
        hostile as unknown as Parameters<typeof createStrategyInstanceRuntime>[0],
      );
    }).not.toThrow();
    expect(created?.ok).toBe(false);
    if (created?.ok === false) {
      expect(created.refusal.detail).toContain("DEFINITION_GET");
    }
  });

  it("a paramsSchema whose safeParse throws is PARAMS_SCHEMA_UNSUPPORTED, not an escaped throw", () => {
    const { definition } = makeDefinition({
      strategy: makeStrategy({
        paramsSchema: {
          safeParse: (): never => {
            throw new Error("SCHEMA_THREW");
          },
        },
      }),
    });
    let created: ReturnType<typeof createStrategyInstanceRuntime> | undefined;
    expect(() => {
      created = createStrategyInstanceRuntime(definition);
    }).not.toThrow();
    expect(created?.ok).toBe(false);
    if (created?.ok === false) {
      expect(created.refusal.code).toBe("PARAMS_SCHEMA_UNSUPPORTED");
      expect(created.refusal.detail).toContain("SCHEMA_THREW");
    }
  });

  it("params that merely refuse to be FROZEN are materialized and accepted (round 4 supersedes the round-3 refusal)", () => {
    // Round 3 refused this as PARAMS_NOT_FREEZABLE, which was the same mistake
    // it had just corrected for evaluation views: freezing a caller's object is
    // not owning it. Since round 4 the params are COPIED, so a proxy whose
    // `preventExtensions` throws is never asked to freeze — only to be read —
    // and the run gets inert data. The caller's object is left alone.
    const target = { edgeThreshold: "0.02" };
    const unfreezable = new Proxy(target, {
      preventExtensions(): boolean {
        throw new Error("PARAMS_PREVENT_EXTENSIONS");
      },
    });
    const { definition } = makeDefinition({ params: unfreezable });
    let created: ReturnType<typeof createStrategyInstanceRuntime> | undefined;
    expect(() => {
      created = createStrategyInstanceRuntime(definition);
    }).not.toThrow();
    expect(created?.ok).toBe(true);
    expect(Object.isFrozen(target)).toBe(false);
    if (created?.ok !== true) {
      return;
    }
    let seen: unknown;
    // The copy is what the callback sees, and it is not the caller's object.
    const harness = makeHarness({
      params: unfreezable,
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          seen = ctx.params();
          return holdDecision(ctx);
        },
      }),
    });
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(seen).toEqual({ edgeThreshold: "0.02" });
    expect(seen).not.toBe(unfreezable);
    expect(seen).not.toBe(target);
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it("params the runtime cannot READ are PARAMS_NOT_MATERIALIZABLE, never an escaped throw", () => {
    const unreadable = new Proxy(
      { edgeThreshold: "0.02" },
      {
        get(): unknown {
          throw new Error("PARAMS_GET_THREW");
        },
      },
    );
    const { definition } = makeDefinition({ params: unreadable });
    let created: ReturnType<typeof createStrategyInstanceRuntime> | undefined;
    expect(() => {
      created = createStrategyInstanceRuntime(definition);
    }).not.toThrow();
    expect(created?.ok).toBe(false);
    if (created?.ok === false) {
      expect(created.refusal.code).toBe("PARAMS_NOT_MATERIALIZABLE");
      expect(created.refusal.detail).toContain("PARAMS_GET_THREW");
    }
  });

  it("the CALLBACK that was validated is the callback that runs", () => {
    // A strategy whose callback property answers a different function on every
    // read: the runtime captured one at creation and applies that one, so the
    // second function never runs and the identity check is not a coincidence.
    let reads = 0;
    const first = (ctx: StrategyContext): DecisionResult => holdDecision(ctx);
    const second = (): DecisionResult => {
      throw new Error("SECOND_FUNCTION_RAN");
    };
    const strategy = makeStrategy();
    Object.defineProperty(strategy, "onFeatures", {
      get: () => {
        reads += 1;
        return reads === 1 ? first : second;
      },
      enumerable: true,
      configurable: true,
    });

    const harness = makeHarness({ strategy });
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(reads).toBe(1);
  });

  it("the checkpoint identity comes from the captured strategy, not from a re-read", () => {
    let nameReads = 0;
    const strategy = makeStrategy();
    Object.defineProperty(strategy, "name", {
      get: () => {
        nameReads += 1;
        return nameReads === 1 ? "test-strategy" : "impostor-strategy";
      },
      enumerable: true,
      configurable: true,
    });

    const harness = makeHarness({ strategy });
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    // `CKPT-1` (ADR-027 D1): a second no-change hold writes NO checkpoint, so
    // the second evaluation is `onStop` — the STOP transition writes one — to
    // keep a LATER checkpoint in the probe.
    expect(harness.runtime.evaluate(makeInput("onStop")).kind).toBe("DECIDED");
    expect(harness.store.checkpoints.map((checkpoint) => checkpoint.strategyName)).toEqual([
      "test-strategy",
      "test-strategy",
    ]);
    expect(nameReads).toBe(1);
    // …and the checkpoints still restore against the identity they pin.
    const last = harness.store.checkpoints.at(-1);
    expect(last).toBeDefined();
    expect(restoreCheckpoint(last as StrategyStateCheckpoint, IDENTITY).ok).toBe(true);
  });

  it("a clock that fails BEFORE the callback is a refusal that invokes nothing", () => {
    let invoked = false;
    const clock: MonotonicClock = {
      nowNs: (): bigint => {
        throw new Error("CLOCK_THREW");
      },
    };
    const harness = makeHarness({
      clock,
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          invoked = true;
          return holdDecision(ctx);
        },
      }),
    });

    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    }).not.toThrow();
    expect(outcome?.kind).toBe("REFUSED");
    if (outcome?.kind !== "REFUSED") {
      return;
    }
    expect(outcome.refusal.code).toBe("CLOCK_INVALID");
    expect(invoked).toBe(false);
    expect(harness.sink.calls).toHaveLength(0);
    expect(harness.runtime.nextEvaluationSeq()).toBe(0);
  });

  it("a clock that fails AFTER the callback is CONTAINED with one record, one checkpoint, and no claimed duration", () => {
    let calls = 0;
    const clock: MonotonicClock = {
      nowNs: (): bigint => {
        calls += 1;
        if (calls >= 2) {
          throw new Error("CLOCK_THREW_LATE");
        }
        return 1_000_000n;
      },
    };
    const harness = makeHarness({ clock });

    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    }).not.toThrow();
    expect(outcome?.kind).toBe("CONTAINED");
    if (outcome?.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe("RUNTIME.CLOCK_INVALID");
    expect(outcome.telemetry.evaluationDurationUs).toBeNull();
    expect(harness.sink.calls).toHaveLength(1);
    // `CKPT-1` (ADR-027 §5 re-pin): still exactly one checkpoint, now for a
    // stated reason — this is the instance's first decision, the START
    // transition (with no earlier checkpoint there is no status to differ
    // from); the case below covers a LATER containment, where the pause alone
    // (STATUS) writes it.
    expect(harness.store.checkpoints).toHaveLength(1);
    expect(outcome.checkpointTransitions).toEqual(["START"]);
    expect(harness.store.checkpoints[0]?.status).toBe("PAUSED");
    expect(harness.runtime.instanceStatus()).toBe("PAUSED");
  });

  it("CKPT-1: a clock that fails AFTER a LATER callback is contained with its checkpoint too (STATUS alone)", () => {
    // The re-pin's second half: not the first decision, so START cannot be
    // what writes the checkpoint — the pause must.
    let calls = 0;
    const clock: MonotonicClock = {
      nowNs: (): bigint => {
        calls += 1;
        if (calls >= 4) {
          throw new Error("CLOCK_THREW_LATE");
        }
        return 1_000_000n;
      },
    };
    const harness = makeHarness({ clock });
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.checkpointTransitions).toEqual(["STATUS"]);
    expect(harness.sink.calls).toHaveLength(2);
    expect(harness.store.checkpoints.map((checkpoint) => [checkpoint.checkpointSeq, checkpoint.status])).toEqual([
      [0, "ACTIVE"],
      [1, "PAUSED"],
    ]);
  });

  it("a clock that returns a non-bigint is refused rather than mixed into arithmetic", () => {
    const clock = { nowNs: (): bigint => 12345 as unknown as bigint };
    const harness = makeHarness({ clock });
    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    }).not.toThrow();
    expect(outcome?.kind).toBe("REFUSED");
    if (outcome?.kind === "REFUSED") {
      expect(outcome.refusal.code).toBe("CLOCK_INVALID");
    }
  });
});
