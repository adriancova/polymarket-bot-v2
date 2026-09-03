/**
 * Regression suite for review finding **H1** (remediation round 1, 2026-09-02):
 * a retained `StrategyContext` could advance the live RNG after its callback
 * returned, so the next decision saw a draw that no replay of the same seed
 * would produce and that no checkpoint described.
 *
 * The defect as reproduced by the reviewer, with seed `1`:
 *
 * ```
 * BASELINE second-decision draw: 2958390140
 * out-of-band draw through the RETAINED ctx: 2958390140
 * RETAINED second-decision draw: 798431460          <-- the stream shifted
 * live tail 798431460 | tail from a runtime restored
 *                       from that exact checkpoint: 2958390140
 * ```
 *
 * The constants below are the actual seed-1 stream, pinned so these tests
 * cannot pass vacuously: an implementation that quietly kept advancing the
 * generator would produce `798431460` where every assertion here demands
 * `2958390140`.
 *
 * The fix: the context is a capability scoped to ONE invocation and is revoked
 * in a `finally` immediately around the callback. A post-return use is a typed
 * `StrategyContextRevokedError` — refused BEFORE the draw, so the generator
 * does not move.
 */

import { describe, expect, it } from "vitest";

import {
  createStrategyInstanceRuntime,
  DeterministicRng,
  STRATEGY_CONTEXT_REVOKED,
  StrategyContextRevokedError,
  type StrategyStateCheckpoint,
} from "../../../packages/strategy-runtime/src/index.js";
import type {
  DecisionResult,
  SeededRandom,
  StrategyContext,
} from "../../../packages/strategy-sdk/src/index.js";
import { holdDecision, makeDefinition, makeInput, makeStrategy } from "./helpers.js";

/** The seed the reviewer's transcript used. */
const SEED = "1";
/** Seed 1, draw 0 — the second decision's draw in a correct runtime. */
const DRAW_0 = 2958390140;
/** Seed 1, draw 1 — what the second decision saw when a retained draw shifted the stream. */
const DRAW_1 = 798431460;

interface Retained {
  ctx?: StrategyContext;
  facade?: SeededRandom;
  boundDraw?: () => number;
  readonly draws: number[];
}

/** `onStart` retains the context and draws NOTHING; `onFeatures` draws once. */
function retainingStrategy(sink: Retained) {
  return makeStrategy({
    onStart: (ctx: StrategyContext): DecisionResult => {
      sink.ctx = ctx;
      sink.facade = ctx.rng();
      sink.boundDraw = ctx.rng().nextUint32;
      return holdDecision(ctx);
    },
    onFeatures: (ctx: StrategyContext): DecisionResult => {
      sink.draws.push(ctx.rng().nextUint32());
      return holdDecision(ctx);
    },
  });
}

function newRuntime(sink: Retained, restoreFrom?: StrategyStateCheckpoint) {
  const { definition, store, sink: decisions } = makeDefinition({
    strategy: retainingStrategy(sink),
    run: { runId: "run-1", instanceId: "instance-1", configId: "config-1", runSeed: SEED },
  });
  const created = createStrategyInstanceRuntime(
    restoreFrom === undefined ? definition : { ...definition, restoreFrom },
  );
  if (!created.ok) {
    throw new Error(`runtime creation refused: ${created.refusal.code}`);
  }
  return { runtime: created.runtime, store, decisions };
}

/**
 * Runs `onStart` then `onFeatures`, optionally attempting an out-of-band draw
 * through the retained context in between. Returns the second decision's draw,
 * the checkpoint written after the first callback, and whatever the attempted
 * out-of-band draw did.
 */
function runTwoEvaluations(attemptOutOfBandDraw: boolean): {
  readonly draw: number | undefined;
  readonly checkpointAfterFirst: StrategyStateCheckpoint;
  readonly outOfBand: unknown;
  readonly sink: Retained;
} {
  const sink: Retained = { draws: [] };
  const { runtime, store } = newRuntime(sink);
  expect(runtime.evaluate(makeInput("onStart")).kind).toBe("DECIDED");
  const checkpointAfterFirst = store.checkpoints.at(-1);
  if (checkpointAfterFirst === undefined) {
    throw new Error("expected a checkpoint after the first evaluation");
  }
  let outOfBand: unknown;
  if (attemptOutOfBandDraw) {
    try {
      outOfBand = sink.ctx?.rng().nextUint32();
    } catch (cause) {
      outOfBand = cause;
    }
  }
  expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
  return { draw: sink.draws[0], checkpointAfterFirst, outOfBand, sink };
}

/** Replays the tail from a checkpoint in a FRESH runtime, as a restart would. */
function tailFromCheckpoint(checkpoint: StrategyStateCheckpoint): number | undefined {
  const sink: Retained = { draws: [] };
  const { runtime } = newRuntime(sink, checkpoint);
  expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
  return sink.draws[0];
}

describe("H1: the StrategyContext is invocation-scoped and revoked when the callback returns", () => {
  it("pins the seed-1 stream the rest of this file reasons about", () => {
    const rng = DeterministicRng.fromSeed(SEED);
    expect([rng.nextUint32(), rng.nextUint32()]).toEqual([DRAW_0, DRAW_1]);
  });

  it("a post-return draw through a retained ctx is REFUSED with a typed refusal", () => {
    const { outOfBand } = runTwoEvaluations(true);
    expect(outOfBand).toBeInstanceOf(StrategyContextRevokedError);
    const error = outOfBand as StrategyContextRevokedError;
    expect(error.code).toBe(STRATEGY_CONTEXT_REVOKED);
    expect(error.capability).toBe("rng");
    expect(error.name).toBe("StrategyContextRevokedError");
  });

  it("the next decision's draw is UNCHANGED by the attempted post-return draw", () => {
    const baseline = runTwoEvaluations(false);
    const retained = runTwoEvaluations(true);
    expect(baseline.draw).toBe(DRAW_0);
    // The whole point: without the fix this was DRAW_1 (798431460).
    expect(retained.draw).toBe(DRAW_0);
    expect(retained.draw).not.toBe(DRAW_1);
  });

  it("the checkpoint-restored tail equals the live tail, with and without the attempted draw", () => {
    const baseline = runTwoEvaluations(false);
    const retained = runTwoEvaluations(true);
    // A checkpoint describes the stream exactly: restoring it reproduces the
    // live tail. Before the fix the live tail was 798431460 while the restored
    // tail was 2958390140 — a divergence from the SAME checkpoint.
    expect(tailFromCheckpoint(baseline.checkpointAfterFirst)).toBe(DRAW_0);
    expect(tailFromCheckpoint(retained.checkpointAfterFirst)).toBe(DRAW_0);
    expect(retained.draw).toBe(tailFromCheckpoint(retained.checkpointAfterFirst));
    // And the two runs' checkpoints are byte-comparable in their RNG state.
    expect(retained.checkpointAfterFirst.rngState).toEqual(baseline.checkpointAfterFirst.rngState);
  });

  it("a retained RNG FACADE (and even a captured bound draw method) is revoked too", () => {
    const { sink } = runTwoEvaluations(false);
    const facadeDraw = (): number => (sink.facade as SeededRandom).nextUint32();
    expect(facadeDraw).toThrow(StrategyContextRevokedError);
    try {
      facadeDraw();
    } catch (cause) {
      expect((cause as StrategyContextRevokedError).capability).toBe("rng.nextUint32");
    }
    const bound = sink.boundDraw as () => number;
    expect(bound).toThrow(StrategyContextRevokedError);
    // The generator did not move while those calls were refused.
    expect(sink.draws[0]).toBe(DRAW_0);
  });

  it("EVERY capability is revoked, not only rng — each naming itself", () => {
    const { sink } = runTwoEvaluations(false);
    const ctx = sink.ctx as StrategyContext;
    const attempts: Array<[string, () => unknown]> = [
      ["now", () => ctx.now()],
      ["market", () => ctx.market()],
      ["book", () => ctx.book("YES")],
      ["features", () => ctx.features()],
      ["position", () => ctx.position()],
      ["orders", () => ctx.orders()],
      ["riskBudget", () => ctx.riskBudget()],
      ["params", () => ctx.params<Record<string, unknown>>()],
      ["state", () => ctx.state<Record<string, unknown>>()],
      ["rng", () => ctx.rng()],
    ];
    for (const [capability, call] of attempts) {
      let caught: unknown;
      try {
        call();
      } catch (cause) {
        caught = cause;
      }
      expect(caught, `${capability} must refuse after the callback returned`).toBeInstanceOf(
        StrategyContextRevokedError,
      );
      expect((caught as StrategyContextRevokedError).capability).toBe(capability);
    }
  });

  it("is not vacuous: every one of those capabilities WORKS during the callback", () => {
    const observed: string[] = [];
    const { definition } = makeDefinition({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          observed.push(
            ctx.now(),
            ctx.market().marketId,
            ctx.book("YES").asOf,
            ctx.features().snapshotRef,
            ctx.position().yesShares,
            String(ctx.orders().length),
            ctx.riskBudget().availableCollateral,
            JSON.stringify(ctx.params<Record<string, unknown>>()),
            JSON.stringify(ctx.state<Record<string, unknown>>()),
            String(ctx.rng().nextUint32()),
          );
          return holdDecision(ctx);
        },
      }),
      run: { runId: "run-1", instanceId: "instance-1", configId: "config-1", runSeed: SEED },
    });
    const created = createStrategyInstanceRuntime(definition);
    if (!created.ok) {
      throw new Error("creation refused");
    }
    expect(created.runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(observed).toHaveLength(10);
    expect(observed.at(-1)).toBe(String(DRAW_0));
  });

  it("revocation also fires when the callback THREW (the containment path)", () => {
    let escaped: StrategyContext | undefined;
    const { definition } = makeDefinition({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          escaped = ctx;
          throw new Error("boom");
        },
      }),
      run: { runId: "run-1", instanceId: "instance-1", configId: "config-1", runSeed: SEED },
    });
    const created = createStrategyInstanceRuntime(definition);
    if (!created.ok) {
      throw new Error("creation refused");
    }
    const outcome = created.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    expect(() => (escaped as StrategyContext).rng()).toThrow(StrategyContextRevokedError);
  });

  it("a retained ctx used inside a LATER callback is CONTAINED as one runtime skip", () => {
    const sink: Retained = { draws: [] };
    const { definition, sink: decisions, store } = makeDefinition({
      strategy: makeStrategy({
        onStart: (ctx: StrategyContext): DecisionResult => {
          sink.ctx = ctx;
          return holdDecision(ctx);
        },
        // Reaches for the PREVIOUS invocation's context instead of its own.
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          const stale = sink.ctx as StrategyContext;
          sink.draws.push(stale.rng().nextUint32());
          return holdDecision(ctx);
        },
      }),
      run: { runId: "run-1", instanceId: "instance-1", configId: "config-1", runSeed: SEED },
    });
    const created = createStrategyInstanceRuntime(definition);
    if (!created.ok) {
      throw new Error("creation refused");
    }
    expect(created.runtime.evaluate(makeInput("onStart")).kind).toBe("DECIDED");
    const outcome = created.runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe("RUNTIME.CALLBACK_THREW");
    expect(outcome.failure.detail).toContain("revoked");
    expect(sink.draws).toEqual([]);
    // Exactly one record for the failed evaluation, and the RNG is untouched:
    // the checkpoint still describes the pre-callback stream.
    expect(decisions.calls).toHaveLength(2);
    expect(store.checkpoints.at(-1)?.rngState).toEqual(store.checkpoints[0]?.rngState);
    expect(created.runtime.instanceStatus()).toBe("PAUSED");
  });
});
