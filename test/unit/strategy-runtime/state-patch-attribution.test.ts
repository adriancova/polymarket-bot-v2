/**
 * Attribution does not depend on WHERE inside `statePatch` the hostility sits
 * (remediation round 4, 2026-09-03 — review round 4's MEDIUM 2).
 *
 * Round 3 split the containment region in two — reading the decision is
 * `RUNTIME.DECISION_INVALID`, materializing the patch is
 * `RUNTIME.STATE_PATCH_INVALID` — but still ran
 * `DecisionResultSchema.safeParse` over the WHOLE returned value first, and the
 * domain types `statePatch` as `z.record(z.string(), z.unknown())`: a record
 * whose own keys Zod enumerates. So the same hostile value got two different
 * attributions depending on its depth. Reproduced verbatim against the round-3
 * code:
 *
 * ```
 * topLevelRevoked outcome=CONTAINED reason=RUNTIME.DECISION_INVALID
 * nestedRevoked   outcome=CONTAINED reason=RUNTIME.STATE_PATCH_INVALID
 * topLevelOwnKeys outcome=CONTAINED reason=RUNTIME.DECISION_INVALID
 * topLevelGet     outcome=CONTAINED reason=RUNTIME.DECISION_INVALID
 * ```
 *
 * An operator reading `RUNTIME.DECISION_INVALID` looks at the strategy's
 * decision logic; the actual fault was its state patch. The fix isolates the
 * raw patch BEFORE any schema traversal can inspect it, validates the rest of
 * the decision separately, and materializes the patch afterwards under its own
 * attribution — so the two probes agree, which is what this file asserts as a
 * property rather than as two separate expectations.
 */

import { describe, expect, it } from "vitest";

import type { EvaluationOutcome } from "../../../packages/strategy-runtime/src/index.js";
import type { DecisionResult, StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import { makeHarness, makeInput, makeStrategy, SNAPSHOT_REF } from "./helpers.js";

/** A strategy whose `onFeatures` returns `patch` as its `statePatch`. */
function patching(patch: () => unknown) {
  return makeStrategy({
    onFeatures: (): DecisionResult =>
      ({
        decisionType: "hold",
        reasonCodes: ["TEST.HOLD"],
        featureSnapshotRef: SNAPSHOT_REF,
        intents: [],
        statePatch: patch(),
      }) as unknown as DecisionResult,
  });
}

function evaluateWithPatch(patch: () => unknown): EvaluationOutcome {
  const harness = makeHarness({ strategy: patching(patch) });
  let outcome: EvaluationOutcome | undefined;
  expect(() => {
    outcome = harness.runtime.evaluate(makeInput("onFeatures"));
  }).not.toThrow();
  // Containment invariants that must hold whatever the attribution: exactly one
  // record, exactly one checkpoint, and a paused instance.
  if (outcome?.kind === "CONTAINED") {
    expect(harness.sink.calls).toHaveLength(1);
    expect(harness.store.checkpoints).toHaveLength(1);
    expect(harness.runtime.instanceStatus()).toBe("PAUSED");
    expect(harness.sink.calls[0]?.record.attribution).toBe("RUNTIME");
  }
  if (outcome === undefined) {
    throw new Error("evaluate() returned nothing");
  }
  return outcome;
}

function reasonOf(outcome: EvaluationOutcome): string {
  return outcome.kind === "CONTAINED" ? outcome.failure.reasonCode : outcome.kind;
}

/** The four hostilities the reviewer exercised, each buildable at any depth. */
const HOSTILITIES: ReadonlyArray<readonly [string, () => unknown]> = [
  [
    "revoked proxy",
    () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return revocable.proxy;
    },
  ],
  [
    "throwing ownKeys",
    () =>
      new Proxy(
        { a: 1 },
        {
          ownKeys(): never {
            throw new Error("OWN_KEYS");
          },
        },
      ),
  ],
  [
    "throwing get",
    () =>
      new Proxy(
        { a: 1 },
        {
          get(): never {
            throw new Error("GET_TRAP");
          },
        },
      ),
  ],
  [
    "throwing getPrototypeOf",
    () =>
      new Proxy(
        { a: 1 },
        {
          getPrototypeOf(): never {
            throw new Error("PROTOTYPE");
          },
        },
      ),
  ],
];

describe("MEDIUM 2: a statePatch failure is attributed to the statePatch, wherever it sits", () => {
  it("the reviewer's transcript: a TOP-LEVEL revoked patch is STATE_PATCH_INVALID, like the nested one", () => {
    const top = evaluateWithPatch(() => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return revocable.proxy;
    });
    expect(top.kind).toBe("CONTAINED");
    expect(reasonOf(top)).toBe("RUNTIME.STATE_PATCH_INVALID");

    const nested = evaluateWithPatch(() => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return { nested: revocable.proxy };
    });
    expect(reasonOf(nested)).toBe("RUNTIME.STATE_PATCH_INVALID");
  });

  it("THE PROPERTY: top-level and nested hostility get the SAME attribution, for every hostility", () => {
    for (const [label, build] of HOSTILITIES) {
      const top = evaluateWithPatch(() => build());
      const nested = evaluateWithPatch(() => ({ nested: build() }));
      const deeper = evaluateWithPatch(() => ({ a: { b: { c: build() } } }));
      expect(reasonOf(top), `${label} at the top level`).toBe("RUNTIME.STATE_PATCH_INVALID");
      expect(reasonOf(nested), `${label} nested`).toBe(reasonOf(top));
      expect(reasonOf(deeper), `${label} three deep`).toBe(reasonOf(top));
    }
  });

  it("a hostile field that is NOT the patch is still a DECISION problem — the attribution did not collapse", () => {
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (): DecisionResult => {
          const decision: Record<string, unknown> = {
            decisionType: "hold",
            featureSnapshotRef: SNAPSHOT_REF,
            intents: [],
            statePatch: { count: 1 },
          };
          Object.defineProperty(decision, "reasonCodes", {
            get: (): never => {
              throw new Error("REASON_CODES_GET");
            },
            enumerable: true,
          });
          return decision as unknown as DecisionResult;
        },
      }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe("RUNTIME.DECISION_INVALID");
    expect(outcome.failure.detail).toContain("REASON_CODES_GET");
  });

  it("a decision object the runtime cannot enumerate at all is a DECISION problem", () => {
    const outcome = evaluateWithPatch(() => ({ count: 1 }));
    expect(outcome.kind).toBe("DECIDED");

    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (): DecisionResult =>
          new Proxy(
            {},
            {
              ownKeys(): never {
                throw new Error("DECISION_OWNKEYS");
              },
            },
          ) as unknown as DecisionResult,
      }),
    });
    const hostile = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(hostile.kind).toBe("CONTAINED");
    if (hostile.kind === "CONTAINED") {
      expect(hostile.failure.reasonCode).toBe("RUNTIME.DECISION_INVALID");
      expect(hostile.failure.detail).toContain("DECISION_OWNKEYS");
    }
  });

  it("a statePatch whose own PROPERTY READ throws is a PATCH problem, not a decision problem", () => {
    // The one place where reading a decision field is attributed to the patch:
    // the field IS the patch.
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (): DecisionResult => {
          const decision: Record<string, unknown> = {
            decisionType: "hold",
            reasonCodes: ["TEST.HOLD"],
            featureSnapshotRef: SNAPSHOT_REF,
            intents: [],
          };
          Object.defineProperty(decision, "statePatch", {
            get: (): never => {
              throw new Error("PATCH_GETTER");
            },
            enumerable: true,
          });
          return decision as unknown as DecisionResult;
        },
      }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind === "CONTAINED") {
      expect(outcome.failure.reasonCode).toBe("RUNTIME.STATE_PATCH_INVALID");
      expect(outcome.failure.detail).toContain("PATCH_GETTER");
    }
  });

  it("a statePatch that is not a JSON object is a PATCH problem naming the shape rule", () => {
    for (const patch of ["a string", 42, true, ["a", "list"], new Date(0)]) {
      const outcome = evaluateWithPatch(() => patch);
      expect(outcome.kind, JSON.stringify(patch)).toBe("CONTAINED");
      expect(reasonOf(outcome), JSON.stringify(patch)).toBe("RUNTIME.STATE_PATCH_INVALID");
    }
  });

  it("the isolated patch is traversed exactly ONCE — the schema no longer walks it first", () => {
    // Before round 4 a top-level patch was enumerated twice: once by Zod's
    // record parse inside the decision region, once by the boundary. Counting
    // traps is the oracle; it does not consult the implementation.
    let gets = 0;
    let ownKeys = 0;
    const counting = new Proxy(
      { a: 1, b: 2 },
      {
        get(target, key, receiver): unknown {
          gets += 1;
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target): ArrayLike<string | symbol> {
          ownKeys += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const harness = makeHarness({ strategy: patching(() => counting) });
    expect(harness.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(ownKeys).toBe(1);
    expect(gets).toBe(2);
    // …and what was persisted is the runtime's copy, not the proxy.
    const persisted = harness.sink.calls[0]?.record.decision.statePatch;
    expect(persisted).not.toBe(counting);
    expect(persisted).toEqual({ a: 1, b: 2 });
    expect(harness.store.checkpoints[0]?.stateJson).toBe('{"a":1,"b":2}');
  });

  it("an ordinary decision with an ordinary patch is unaffected by the isolation", () => {
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => ({
          decisionType: "quote",
          reasonCodes: ["TEST.QUOTE"],
          featureSnapshotRef: ctx.features().snapshotRef,
          modelOutputs: { edge: "0.03", flag: true, missing: null },
          statePatch: { count: 1, nested: { list: [1, 2] } },
          intents: [],
          nextWakeupAt: "2026-01-02T03:04:06.000Z",
        }),
      }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("DECIDED");
    if (outcome.kind !== "DECIDED") {
      return;
    }
    // Every field the schema owns survives the round trip, and the patch is the
    // runtime's frozen copy.
    expect(outcome.record.decision.decisionType).toBe("quote");
    expect(outcome.record.decision.modelOutputs).toEqual({
      edge: "0.03",
      flag: true,
      missing: null,
    });
    expect(outcome.record.decision.nextWakeupAt).toBe("2026-01-02T03:04:06.000Z");
    expect(outcome.record.decision.statePatch).toEqual({ count: 1, nested: { list: [1, 2] } });
    expect(Object.isFrozen(outcome.record.decision.statePatch)).toBe(true);
    expect(outcome.checkpoint.stateJson).toBe('{"count":1,"nested":{"list":[1,2]}}');
  });

  it("an own __proto__ on the returned decision is copied as DATA, never re-parented", () => {
    // The isolation copy is a new object built key by key, so `__proto__`
    // needs `defineProperty` — plain assignment would invoke the inherited
    // setter and silently change the copy's prototype instead of holding the
    // value. Verified end to end: the domain schema drops the key from its
    // output (it is not part of the §7.5 shape), nothing is polluted, and the
    // evaluation is an ordinary DECIDED.
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (): DecisionResult =>
          JSON.parse(
            '{"decisionType":"hold","reasonCodes":["TEST.HOLD"],"featureSnapshotRef":"snap-1",' +
              '"intents":[],"__proto__":{"polluted":true},' +
              '"statePatch":{"nested":{"__proto__":{"alsoPolluted":true}}}}',
          ) as DecisionResult,
      }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("DECIDED");
    if (outcome.kind !== "DECIDED") {
      return;
    }
    expect(Reflect.ownKeys(outcome.record.decision)).not.toContain("__proto__");
    // STRENGTHENED, `WP-170-FU1`: was `toBe(Object.prototype)`. The decision is
    // now built by the door from the CONTRACT's own field names over the
    // materialized tree (D3) into a prototype-free container (D4), so it
    // still drops `__proto__` — asserted on the line above, unchanged — and it
    // additionally cannot answer an absent optional field from the chain.
    expect(Object.getPrototypeOf(outcome.record.decision)).toBeNull();
    // The patch keeps its own `__proto__` as an ordinary data property, and the
    // canonical bytes say so.
    expect(outcome.checkpoint.stateJson).toBe('{"nested":{"__proto__":{"alsoPolluted":true}}}');
    const patched = outcome.record.decision.statePatch?.["nested"];
    // STRENGTHENED, `WP-170-FU1`: was `toBe(Object.prototype)`. The claim under
    // test — `__proto__` is held as DATA and never re-parents the copy — is
    // unchanged; the materialized copy is now prototype-free (D4), so it also
    // cannot answer an absent key from `Object.prototype`.
    expect(Object.getPrototypeOf(patched as object)).toBeNull();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["alsoPolluted"]).toBeUndefined();
  });

  it("a required field supplied only through an own __proto__ does NOT satisfy the decision contract", () => {
    // The observable consequence of using `defineProperty` rather than
    // assignment when the isolation copy carries an own `__proto__`: assignment
    // would re-parent the copy, and the schema would then find `decisionType`
    // on the prototype and accept a decision that never declared one.
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (): DecisionResult =>
          JSON.parse(
            '{"reasonCodes":["TEST.HOLD"],"featureSnapshotRef":"snap-1","intents":[],' +
              '"__proto__":{"decisionType":"hold"}}',
          ) as DecisionResult,
      }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind === "CONTAINED") {
      expect(outcome.failure.reasonCode).toBe("RUNTIME.DECISION_INVALID");
      expect(outcome.failure.detail).toContain("decisionType");
    }
  });
});
