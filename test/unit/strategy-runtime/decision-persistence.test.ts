/**
 * WP-170 acceptance 1: "Runtime persists exactly one decision per callback."
 * (§6 invariant 3; §9.6; ADR-005 §2–§3.)
 *
 * Probed here: every callback persists exactly once; a NO-OP decision (hold,
 * zero intents) is persisted like any other — "no action" is a recorded fact
 * (ADR-005 §2), which pins the §9.6 no-op semantics; a throwing strategy, an
 * over-budget strategy, and an invalid returned value each produce exactly ONE
 * runtime-attributed `skip` record; double-persist attempts (a hostile sink or
 * strategy re-entering `evaluate`) are refused without a second record; a
 * failing sink is attempted exactly once and never retried; refused
 * evaluations (paused/stopped instance, invalid input) persist NOTHING because
 * the callback never ran.
 */

import { describe, expect, it } from "vitest";

import {
  RUNTIME_REASON_CODES,
  type EvaluationOutcome,
} from "../../../packages/strategy-runtime/src/index.js";
import type { StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import {
  holdDecision,
  makeHarness,
  makeInput,
  makeStrategy,
  ManualClock,
  RecordingSink,
  SNAPSHOT_REF,
} from "./helpers.js";

const ALL_CALLBACKS = [
  "onStart",
  "onMarketOpen",
  "onFeatures",
  "onFill",
  "onOrderUpdate",
  "onTimer",
  "onMarketClosing",
  "onMarketResolved",
  "onStop",
] as const;

describe("acceptance 1: exactly one persisted DecisionResult per callback", () => {
  it("persists exactly one record for every one of the nine callbacks", () => {
    const { runtime, sink, store } = makeHarness();
    for (const [index, callback] of ALL_CALLBACKS.entries()) {
      const outcome = runtime.evaluate(makeInput(callback));
      expect(outcome.kind).toBe("DECIDED");
      expect(sink.calls).toHaveLength(index + 1);
      const call = sink.calls[index];
      expect(call?.record.callback).toBe(callback);
      expect(call?.record.evaluationSeq).toBe(index);
      expect(call?.record.attribution).toBe("STRATEGY");
      // One checkpoint follows every persisted decision.
      expect(store.checkpoints).toHaveLength(index + 1);
      expect(store.checkpoints[index]?.checkpointSeq).toBe(index);
    }
    // onStop was last: the instance is stopped and the run recorded 9 decisions.
    expect(runtime.instanceStatus()).toBe("STOPPED");
    expect(sink.calls).toHaveLength(9);
  });

  it("pins the no-op semantics: a hold with ZERO intents is persisted like any other decision (ADR-005 §2)", () => {
    const { runtime, sink } = makeHarness();
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("DECIDED");
    expect(sink.calls).toHaveLength(1);
    const record = sink.calls[0]?.record;
    expect(record?.decision.decisionType).toBe("hold");
    expect(record?.decision.intents).toHaveLength(0);
    expect(record?.attribution).toBe("STRATEGY");
  });

  it("adds the runtime-owned identifiers the strategy cannot forge (§7.5)", () => {
    const { runtime, sink } = makeHarness();
    const input = makeInput("onFeatures", {
      sourceEvent: {
        eventId: "018f4a7e-2222-7abc-8def-0123456789ab",
        gatewayEpoch: "018f4a7e-3333-7abc-8def-0123456789ab",
        ingestSeq: "42",
      },
    });
    const outcome = runtime.evaluate(input);
    expect(outcome.kind).toBe("DECIDED");
    const record = sink.calls[0]?.record;
    expect(record).toMatchObject({
      decisionContractVersion: 1,
      runId: "run-1",
      instanceId: "instance-1",
      marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
      evaluationSeq: 0,
      callback: "onFeatures",
      evaluatedAt: "2026-01-02T03:04:05.000Z",
      sourceEvent: {
        eventId: "018f4a7e-2222-7abc-8def-0123456789ab",
        gatewayEpoch: "018f4a7e-3333-7abc-8def-0123456789ab",
        ingestSeq: "42",
      },
    });
    // Telemetry is separate from the record: machine timing never enters the
    // deterministic decision content (§12.4).
    expect(record).not.toHaveProperty("evaluationDurationUs");
    expect(sink.calls[0]?.telemetry.evaluationDurationUs).toBe(0);
  });

  it("contains a THROWING strategy with exactly one RUNTIME-attributed skip and pauses the instance (ADR-005 §3)", () => {
    const { runtime, sink } = makeHarness({
      strategy: makeStrategy({
        onFeatures: () => {
          throw new Error("strategy bug");
        },
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe(RUNTIME_REASON_CODES.callbackThrew);
    expect(sink.calls).toHaveLength(1);
    const record = sink.calls[0]?.record;
    expect(record?.attribution).toBe("RUNTIME");
    expect(record?.decision.decisionType).toBe("skip");
    expect(record?.decision.reasonCodes).toEqual(["RUNTIME.CALLBACK_THREW"]);
    expect(record?.decision.intents).toHaveLength(0);
    expect(runtime.instanceStatus()).toBe("PAUSED");

    // A paused instance refuses WITHOUT a record: the callback never runs.
    const refused = runtime.evaluate(makeInput("onFeatures"));
    expect(refused.kind).toBe("REFUSED");
    if (refused.kind === "REFUSED") {
      expect(refused.refusal.code).toBe("INSTANCE_PAUSED");
    }
    expect(sink.calls).toHaveLength(1);
  });

  it("contains a watchdog TIMEOUT: the strategy's returned decision is discarded, one runtime skip is persisted (ADR-005 §3)", () => {
    const clock = new ManualClock();
    const { runtime, sink } = makeHarness({
      clock,
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext) => {
          clock.advanceUs(5000); // budget is 1000us
          return {
            decisionType: "enter",
            reasonCodes: ["TEST.SHOULD_BE_DISCARDED"],
            featureSnapshotRef: ctx.features().snapshotRef,
            statePatch: { mustNotSurvive: true },
            intents: [],
          };
        },
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind !== "CONTAINED") {
      return;
    }
    expect(outcome.failure.reasonCode).toBe(RUNTIME_REASON_CODES.watchdogTimeout);
    expect(sink.calls).toHaveLength(1);
    const record = sink.calls[0]?.record;
    // The over-budget "enter" is gone; the persisted truth is a runtime skip.
    expect(record?.attribution).toBe("RUNTIME");
    expect(record?.decision.decisionType).toBe("skip");
    expect(record?.decision.reasonCodes).toEqual(["RUNTIME.WATCHDOG_TIMEOUT"]);
    // Its statePatch was discarded with it.
    expect(outcome.checkpoint.stateJson).toBe("{}");
    expect(sink.calls[0]?.telemetry.evaluationDurationUs).toBe(5000);
    expect(runtime.instanceStatus()).toBe("PAUSED");
  });

  it("an exactly-at-budget return is NOT a timeout", () => {
    const clock = new ManualClock();
    const { runtime, sink } = makeHarness({
      clock,
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext) => {
          clock.advanceUs(1000); // budget is exactly 1000us
          return holdDecision(ctx);
        },
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("DECIDED");
    expect(sink.calls[0]?.record.attribution).toBe("STRATEGY");
  });

  it("contains an INVALID returned value (not a §7.5 DecisionResult) with exactly one record", () => {
    const { runtime, sink } = makeHarness({
      strategy: makeStrategy({
        onFeatures: () => ({ decision: "yolo" }) as never,
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind === "CONTAINED") {
      expect(outcome.failure.reasonCode).toBe(RUNTIME_REASON_CODES.decisionInvalid);
    }
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.record.attribution).toBe("RUNTIME");
  });

  it("contains an ASYNC callback (a Promise is not a synchronous DecisionResult, §9.6)", () => {
    const { runtime, sink } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (async () => holdDecision) as never,
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    expect(sink.calls).toHaveLength(1);
  });

  it("contains a decision whose modelOutputs carry a JavaScript number (§6 invariant 1)", () => {
    const { runtime, sink } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext) => ({
          decisionType: "hold",
          reasonCodes: ["TEST.HOLD"],
          featureSnapshotRef: ctx.features().snapshotRef,
          modelOutputs: { edge: 0.012 } as never,
          intents: [],
        }),
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    expect(sink.calls).toHaveLength(1);
  });

  it("contains a FORGED featureSnapshotRef — the decision must name the snapshot this evaluation saw (§6 invariant 4)", () => {
    const { runtime, sink } = makeHarness({
      strategy: makeStrategy({
        onFeatures: () => ({
          decisionType: "hold",
          reasonCodes: ["TEST.HOLD"],
          featureSnapshotRef: "some-other-snapshot",
          intents: [],
        }),
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind === "CONTAINED") {
      expect(outcome.failure.reasonCode).toBe(RUNTIME_REASON_CODES.decisionInvalid);
      expect(outcome.failure.detail).toContain(SNAPSHOT_REF);
    }
    expect(sink.calls).toHaveLength(1);
  });

  it("contains a strategy claiming a reserved RUNTIME.* reason code (attribution cannot be forged, ADR-005 §3)", () => {
    const { runtime, sink } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext) => ({
          decisionType: "skip",
          reasonCodes: ["RUNTIME.WATCHDOG_TIMEOUT"],
          featureSnapshotRef: ctx.features().snapshotRef,
          intents: [],
        }),
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.record.attribution).toBe("RUNTIME");
  });

  it("contains an uncheckpointable statePatch (a function cannot be persisted or replayed)", () => {
    const { runtime, sink } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext) => ({
          decisionType: "hold",
          reasonCodes: ["TEST.HOLD"],
          featureSnapshotRef: ctx.features().snapshotRef,
          statePatch: { evil: () => 1 } as never,
          intents: [],
        }),
      }),
    });
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("CONTAINED");
    if (outcome.kind === "CONTAINED") {
      expect(outcome.failure.reasonCode).toBe(RUNTIME_REASON_CODES.statePatchInvalid);
    }
    expect(sink.calls).toHaveLength(1);
  });

  it("refuses a DOUBLE-PERSIST attempt from a hostile strategy that re-enters evaluate()", () => {
    // A mutable holder, because the strategy needs the runtime that owns it —
    // the circularity is the point of the probe.
    const owner: { runtime?: { evaluate(input: never): EvaluationOutcome } } = {};
    let innerOutcome: EvaluationOutcome | undefined;
    const { runtime, sink } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext) => {
          innerOutcome = owner.runtime?.evaluate(makeInput("onTimer") as never);
          return holdDecision(ctx);
        },
      }),
    });
    owner.runtime = runtime as never;
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("DECIDED");
    expect(innerOutcome?.kind).toBe("REFUSED");
    if (innerOutcome?.kind === "REFUSED") {
      expect(innerOutcome.refusal.code).toBe("EVALUATION_REENTRANT");
    }
    // Exactly one record for the one callback that ran.
    expect(sink.calls).toHaveLength(1);
  });

  it("refuses a DOUBLE-PERSIST attempt from a hostile sink that re-enters evaluate() during persist", () => {
    const sink = new RecordingSink();
    const owner: { runtime?: { evaluate(input: never): EvaluationOutcome } } = {};
    let innerOutcome: EvaluationOutcome | undefined;
    sink.onPersist = () => {
      innerOutcome = owner.runtime?.evaluate(makeInput("onTimer") as never);
    };
    const { runtime } = makeHarness({ decisionSink: sink });
    owner.runtime = runtime as never;
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("DECIDED");
    expect(innerOutcome?.kind).toBe("REFUSED");
    if (innerOutcome?.kind === "REFUSED") {
      expect(innerOutcome.refusal.code).toBe("EVALUATION_REENTRANT");
    }
    expect(sink.calls).toHaveLength(1);
  });

  it("HALTS on a sink failure: exactly one attempt, no retry, no checkpoint, instance paused", () => {
    const { runtime, sink, store } = makeHarness();
    sink.failNext = true;
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("HALTED");
    if (outcome.kind === "HALTED") {
      expect(outcome.stage).toBe("PERSIST_DECISION");
    }
    // The failed attempt threw before recording; no second attempt was made.
    expect(sink.calls).toHaveLength(0);
    expect(store.checkpoints).toHaveLength(0);
    expect(runtime.instanceStatus()).toBe("PAUSED");
    // Next evaluation is refused without any persist call.
    const refused = runtime.evaluate(makeInput("onFeatures"));
    expect(refused.kind).toBe("REFUSED");
    expect(sink.calls).toHaveLength(0);
  });

  it("HALTS on a checkpoint failure AFTER the decision persisted exactly once", () => {
    const { runtime, sink, store } = makeHarness();
    store.failNext = true;
    const outcome = runtime.evaluate(makeInput("onFeatures"));
    expect(outcome.kind).toBe("HALTED");
    if (outcome.kind === "HALTED") {
      expect(outcome.stage).toBe("SAVE_CHECKPOINT");
    }
    expect(sink.calls).toHaveLength(1);
    expect(store.checkpoints).toHaveLength(0);
    expect(runtime.instanceStatus()).toBe("PAUSED");
  });

  it("a STOPPED instance refuses evaluation with zero records (the callback never runs)", () => {
    const { runtime, sink } = makeHarness();
    expect(runtime.evaluate(makeInput("onStop")).kind).toBe("DECIDED");
    expect(runtime.instanceStatus()).toBe("STOPPED");
    const refused = runtime.evaluate(makeInput("onFeatures"));
    expect(refused.kind).toBe("REFUSED");
    if (refused.kind === "REFUSED") {
      expect(refused.refusal.code).toBe("INSTANCE_STOPPED");
    }
    expect(sink.calls).toHaveLength(1);
  });

  it("an INVALID input refuses with zero records (the callback never runs)", () => {
    const { runtime, sink } = makeHarness();
    const outcome = runtime.evaluate(makeInput("onFeatures", { evaluatedAt: "not-a-timestamp" }));
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind === "REFUSED") {
      expect(outcome.refusal.code).toBe("INPUT_INVALID");
    }
    expect(sink.calls).toHaveLength(0);
  });

  it("evaluation sequence numbers are contiguous and match the checkpoint sequence", () => {
    const { runtime, sink, store } = makeHarness();
    runtime.evaluate(makeInput("onStart"));
    runtime.evaluate(makeInput("onFeatures"));
    runtime.evaluate(makeInput("onTimer"));
    expect(sink.calls.map((call) => call.record.evaluationSeq)).toEqual([0, 1, 2]);
    expect(store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0, 1, 2]);
  });
});
