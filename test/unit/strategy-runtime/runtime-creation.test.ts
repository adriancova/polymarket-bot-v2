/**
 * §9.6 "Load a strategy definition and immutable configuration" and "Validate
 * parameters against JSON Schema/Zod".
 *
 * Every failure here is a TYPED REFUSAL, never a throw and never a silent
 * best-effort load: an instance that cannot be constructed correctly must not
 * exist at all, because a half-configured instance would still be able to
 * persist decisions.
 *
 * The immutability half is pinned behaviourally: what the strategy sees through
 * `ctx.params()` is frozen, so a strategy cannot mutate its own configuration
 * between evaluations and make a replay diverge (§12.4).
 */

import { describe, expect, it } from "vitest";

import { createStrategyInstanceRuntime } from "../../../packages/strategy-runtime/src/index.js";
import type { StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import {
  holdDecision,
  makeDefinition,
  makeHarness,
  makeInput,
  makeStrategy,
  passthroughParamsSchema,
  RUN_SEED,
} from "./helpers.js";

function refusalOf(overrides: Parameters<typeof makeDefinition>[0]): {
  code: string;
  detail: string;
} {
  const { definition } = makeDefinition(overrides);
  const created = createStrategyInstanceRuntime(definition);
  if (created.ok) {
    throw new Error("expected creation to be refused");
  }
  return { code: created.refusal.code, detail: created.refusal.detail };
}

describe("runtime creation: strategy definition and immutable configuration", () => {
  it("creates an ACTIVE instance at evaluation sequence 0 for a well-formed definition", () => {
    const { runtime } = makeHarness();
    expect(runtime.instanceStatus()).toBe("ACTIVE");
    expect(runtime.nextEvaluationSeq()).toBe(0);
  });

  it("validates params through the strategy's own schema and uses the PARSED value", () => {
    let seen: unknown;
    const schema = {
      safeParse: (value: unknown) => ({
        success: true as const,
        data: { ...(value as Record<string, unknown>), defaulted: "0.05" },
      }),
    };
    const { runtime } = makeHarness({
      strategy: makeStrategy({
        paramsSchema: schema,
        onFeatures: (ctx: StrategyContext) => {
          seen = ctx.params<Record<string, unknown>>();
          return holdDecision(ctx);
        },
      }),
      params: { edgeThreshold: "0.02" },
    });
    expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(seen).toEqual({ edgeThreshold: "0.02", defaulted: "0.05" });
  });

  it("the configuration a strategy sees is IMMUTABLE — a mutation attempt throws in strict mode", () => {
    let mutationError: unknown;
    const { runtime } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext) => {
          const params = ctx.params<{ edgeThreshold: string }>();
          expect(Object.isFrozen(params)).toBe(true);
          try {
            (params as { edgeThreshold: string }).edgeThreshold = "9";
          } catch (cause) {
            mutationError = cause;
          }
          return holdDecision(ctx);
        },
      }),
    });
    expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(mutationError).toBeInstanceOf(TypeError);
  });

  it("refuses params the strategy's schema rejects (PARAMS_REJECTED), naming the schema's own message", () => {
    const refusal = refusalOf({
      strategy: makeStrategy({
        paramsSchema: {
          safeParse: () => ({
            success: false as const,
            error: new Error("edgeThreshold is required"),
          }),
        },
      }),
    });
    expect(refusal.code).toBe("PARAMS_REJECTED");
    expect(refusal.detail).toContain("edgeThreshold is required");
  });

  it("refuses a paramsSchema that cannot be evaluated rather than guessing (PARAMS_SCHEMA_UNSUPPORTED)", () => {
    expect(refusalOf({ strategy: makeStrategy({ paramsSchema: {} }) }).code).toBe(
      "PARAMS_SCHEMA_UNSUPPORTED",
    );
    expect(refusalOf({ strategy: makeStrategy({ paramsSchema: undefined }) }).code).toBe(
      "PARAMS_SCHEMA_UNSUPPORTED",
    );
    expect(
      refusalOf({
        strategy: makeStrategy({ paramsSchema: { safeParse: () => "yes" } }),
      }).code,
    ).toBe("PARAMS_SCHEMA_UNSUPPORTED");
  });

  it("refuses a strategy that is missing any of the nine §9.6 callbacks", () => {
    for (const missing of [
      "onStart",
      "onMarketOpen",
      "onFeatures",
      "onFill",
      "onOrderUpdate",
      "onTimer",
      "onMarketClosing",
      "onMarketResolved",
      "onStop",
    ] as const) {
      const strategy = makeStrategy();
      const refusal = refusalOf({
        strategy: { ...strategy, [missing]: undefined } as never,
      });
      expect(refusal.code, `missing ${missing}`).toBe("STRATEGY_SHAPE_INVALID");
      expect(refusal.detail).toContain(missing);
    }
  });

  it("refuses an unversioned or wrongly versioned strategy", () => {
    expect(refusalOf({ strategy: makeStrategy({ name: "" }) }).code).toBe(
      "STRATEGY_SHAPE_INVALID",
    );
    expect(refusalOf({ strategy: makeStrategy({ version: "" }) }).code).toBe(
      "STRATEGY_SHAPE_INVALID",
    );
    for (const bad of [0, -1, 1.5, Number.NaN, "1"]) {
      expect(
        refusalOf({ strategy: makeStrategy({ stateSchemaVersion: bad as never }) }).code,
        `stateSchemaVersion ${String(bad)}`,
      ).toBe("STRATEGY_SHAPE_INVALID");
    }
  });

  it("refuses a UUID-shaped run identifier that is not canonical lowercase — never case-folds it (ADR-016)", () => {
    const upper = "018F4A7E-1111-7ABC-8DEF-0123456789AB";
    const lowerA = "018f4a7e-aaaa-7abc-8def-0123456789ab";
    const lowerB = "018f4a7e-bbbb-7abc-8def-0123456789ab";
    const lowerC = "018f4a7e-cccc-7abc-8def-0123456789ab";
    const cases = [
      { field: "run.runId", run: { runId: upper, instanceId: lowerB, configId: lowerC } },
      { field: "run.instanceId", run: { runId: lowerA, instanceId: upper, configId: lowerC } },
      { field: "run.configId", run: { runId: lowerA, instanceId: lowerB, configId: upper } },
    ] as const;
    for (const { field, run } of cases) {
      const refusal = refusalOf({ run: { ...run, runSeed: RUN_SEED } });
      expect(refusal.code, field).toBe("RUN_IDENTITY_INVALID");
      expect(refusal.detail).toContain("ADR-016");
      expect(refusal.detail).toContain(field);
    }
  });

  it("accepts the canonical lowercase spelling of the same identifiers", () => {
    const { definition } = makeDefinition({
      run: {
        runId: "018f4a7e-aaaa-7abc-8def-0123456789ab",
        instanceId: "018f4a7e-bbbb-7abc-8def-0123456789ab",
        configId: "018f4a7e-cccc-7abc-8def-0123456789ab",
        runSeed: RUN_SEED,
      },
    });
    expect(createStrategyInstanceRuntime(definition).ok).toBe(true);
  });

  it("refuses an empty or over-long run identifier", () => {
    expect(
      refusalOf({
        run: { runId: "", instanceId: "i", configId: "c", runSeed: RUN_SEED },
      }).code,
    ).toBe("RUN_IDENTITY_INVALID");
    expect(
      refusalOf({
        run: { runId: "r".repeat(201), instanceId: "i", configId: "c", runSeed: RUN_SEED },
      }).code,
    ).toBe("RUN_IDENTITY_INVALID");
  });

  it("refuses a seed that is not a canonical unsigned integer string (§10.3 runs.run_seed)", () => {
    for (const bad of ["-1", "0012", "1.0", "abc", "", " 1", 12345]) {
      const refusal = refusalOf({
        run: { runId: "r", instanceId: "i", configId: "c", runSeed: bad as never },
      });
      expect(refusal.code, `seed ${String(bad)}`).toBe("RUN_SEED_INVALID");
    }
    const { definition } = makeDefinition({
      run: { runId: "r", instanceId: "i", configId: "c", runSeed: "0" },
    });
    expect(createStrategyInstanceRuntime(definition).ok).toBe(true);
  });

  it("refuses a watchdog budget that is not a positive safe integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1000", undefined]) {
      expect(
        refusalOf({ watchdog: { evaluationBudgetUs: bad as never } }).code,
        `budget ${String(bad)}`,
      ).toBe("WATCHDOG_BUDGET_INVALID");
    }
  });

  it("refuses missing or malformed ports rather than persisting nowhere", () => {
    expect(refusalOf({ clock: {} as never }).code).toBe("PORTS_INVALID");
    expect(refusalOf({ decisionSink: {} as never }).code).toBe("PORTS_INVALID");
    expect(refusalOf({ checkpointStore: {} as never }).code).toBe("PORTS_INVALID");
    expect(refusalOf({ decisionSink: { persist: "no" } as never }).code).toBe("PORTS_INVALID");
  });

  it("never throws, even for a wholly malformed definition", () => {
    expect(() =>
      createStrategyInstanceRuntime({
        strategy: null as never,
        params: undefined,
        run: undefined as never,
        watchdog: undefined as never,
        clock: undefined as never,
        decisionSink: undefined as never,
        checkpointStore: undefined as never,
      }),
    ).not.toThrow();
    const created = createStrategyInstanceRuntime({
      strategy: null as never,
      params: undefined,
      run: undefined as never,
      watchdog: undefined as never,
      clock: undefined as never,
      decisionSink: undefined as never,
      checkpointStore: undefined as never,
    });
    expect(created.ok).toBe(false);
  });

  it("a params schema that accepts anything still yields a frozen params object", () => {
    let frozen = false;
    const { runtime } = makeHarness({
      strategy: makeStrategy({
        paramsSchema: passthroughParamsSchema,
        onFeatures: (ctx: StrategyContext) => {
          frozen = Object.isFrozen(ctx.params<{ nested: { deep: string } }>().nested);
          return holdDecision(ctx);
        },
      }),
      params: { nested: { deep: "0.1" } },
    });
    expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(frozen).toBe(true);
  });
});
