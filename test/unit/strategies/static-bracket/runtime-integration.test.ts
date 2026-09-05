/**
 * The strategy driven through the REAL WP-170 runtime.
 *
 * Everything else in this suite calls the callbacks directly, which is precise
 * but proves nothing about the seam. Here the actual
 * `createStrategyInstanceRuntime` loads the strategy, validates the RAW §13.2
 * configuration through the shipped `paramsSchema`, owns the state, folds every
 * `statePatch`, persists one decision per evaluation and writes a checkpoint —
 * so what is exercised is the composition the trader process will build.
 *
 * Three paths, as the work-package packet requires: a full happy path to
 * CLOSED, the partial-fill path, and the stale-data path. The root test tree
 * imports both packages relatively, which creates no workspace edge (the
 * `ports.test.ts` precedent).
 */

import { describe, expect, it } from "vitest";

import { staticBracketStrategy } from "../../../../packages/strategies/static-bracket/src/index.js";
import {
  createStrategyInstanceRuntime,
  type EvaluationInput,
  type EvaluationOutcome,
  type StrategyInstanceRuntime,
} from "../../../../packages/strategy-runtime/src/index.js";
import {
  CONFIG_ID,
  HEALTHY_YES,
  INSTANCE_ID,
  ManualClock,
  RUN_ID,
  RUN_SEED,
  RecordingSink,
  RecordingStore,
  STOP_KEY,
  T_NOW,
  TRIGGER_KEY,
  baseConfig,
  evaluationInput,
  fillPayload,
  order,
  type ViewOptions,
} from "./helpers.js";

interface Harness {
  readonly runtime: StrategyInstanceRuntime;
  readonly sink: RecordingSink;
  readonly store: RecordingStore;
  readonly clock: ManualClock;
}

function harness(config: Record<string, unknown> = baseConfig()): Harness {
  const clock = new ManualClock();
  const sink = new RecordingSink();
  const store = new RecordingStore();
  const created = createStrategyInstanceRuntime({
    strategy: staticBracketStrategy,
    params: config,
    run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: RUN_SEED },
    watchdog: { evaluationBudgetUs: 500_000 },
    clock,
    decisionSink: sink,
    checkpointStore: store,
  });
  if (!created.ok) {
    throw new Error(`the runtime refused the strategy: ${created.refusal.code} ${created.refusal.detail}`);
  }
  return { runtime: created.runtime, sink, store, clock };
}

function decided(outcome: EvaluationOutcome): EvaluationOutcome {
  if (outcome.kind !== "DECIDED") {
    const detail =
      outcome.kind === "CONTAINED"
        ? `${outcome.incident.code}: ${outcome.incident.detail}`
        : outcome.kind === "REFUSED"
          ? `${outcome.refusal.code}: ${outcome.refusal.detail}`
          : outcome.stage;
    throw new Error(`expected a DECIDED evaluation, got ${outcome.kind} (${detail})`);
  }
  return outcome;
}

function step(
  runtime: StrategyInstanceRuntime,
  callback: EvaluationInput["callback"],
  options: ViewOptions = {},
  payload: Record<string, unknown> = {},
): EvaluationOutcome {
  return decided(runtime.evaluate(evaluationInput(callback, options, payload)));
}

/** The state document the runtime is holding, read out of its last checkpoint. */
function currentState(store: RecordingStore): Record<string, unknown> {
  const last = store.checkpoints[store.checkpoints.length - 1];
  expect(last, "the runtime must have checkpointed").toBeDefined();
  return JSON.parse((last as { stateJson: string }).stateJson) as Record<string, unknown>;
}

describe("through the real runtime — the happy path to CLOSED", () => {
  it("arms, enters, fills, exits and closes, with one persisted decision per evaluation", () => {
    const { runtime, sink, store } = harness();

    step(runtime, "onStart");
    expect(currentState(store)["instanceState"]).toBe("ARMED");

    const entry = step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    expect(entry.kind === "DECIDED" && entry.record.decision.decisionType).toBe("enter");
    expect(currentState(store)["instanceState"]).toBe("ENTRY_PLANNED");

    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    expect(currentState(store)["instanceState"]).toBe("ENTRY_WORKING");

    const filled = step(
      runtime,
      "onFill",
      { yesShares: "50", orders: [order({ status: "FILLED", filledShares: "50" })] },
      fillPayload(),
    );
    expect(filled.kind === "DECIDED" && filled.record.decision.decisionType).toBe("exit");
    const afterFill = currentState(store);
    expect(afterFill["instanceState"]).toBe("EXIT_PLANNED");
    expect(afterFill["allocatedShares"]).toBe("50");
    expect(afterFill["entriesExecuted"]).toBe(1);

    const exitOrder = order({ orderId: "order-2", side: "SELL", price: "0.5", requestedShares: "50" });
    step(runtime, "onOrderUpdate", { yesShares: "50", orders: [exitOrder] }, { order: exitOrder });
    expect(currentState(store)["instanceState"]).toBe("EXIT_WORKING");

    step(
      runtime,
      "onFill",
      { yesShares: "0" },
      fillPayload({ orderId: "order-2", side: "SELL", price: "0.5", shares: "50" }),
    );
    const closed = currentState(store);
    expect(closed["instanceState"]).toBe("CLOSED");
    expect(closed["exitedShares"]).toBe("50");

    // §6 invariant 3: exactly one persisted decision per evaluation, and a
    // checkpoint for each.
    expect(sink.calls).toHaveLength(6);
    expect(store.checkpoints).toHaveLength(6);
    for (const call of sink.calls) {
      expect(call.record.attribution).toBe("STRATEGY");
      expect(call.record.decision.featureSnapshotRef).toBe("snapshot-1");
    }
    expect(sink.calls.map((call) => call.record.evaluationSeq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("refuses re-entry after CLOSED while maximum_entries_per_market is reached", () => {
    const { runtime, store } = harness();
    step(runtime, "onStart");
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    step(runtime, "onFill", { yesShares: "50" }, fillPayload());
    step(
      runtime,
      "onFill",
      { yesShares: "0" },
      fillPayload({ orderId: "order-2", side: "SELL", price: "0.5", shares: "50" }),
    );
    expect(currentState(store)["instanceState"]).toBe("CLOSED");
    const after = step(runtime, "onFeatures", { yesShares: "0" });
    expect(after.kind === "DECIDED" && after.record.decision.reasonCodes).toContain(
      "SB.REFUSED_MAXIMUM_ENTRIES",
    );
    expect(currentState(store)["instanceState"]).toBe("CLOSED");
  });
});

describe("through the real runtime — the partial-fill path", () => {
  it("allocates each partial and exits only what is actually allocated", () => {
    const { runtime, sink, store } = harness();
    step(runtime, "onStart");
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });

    const first = step(
      runtime,
      "onFill",
      { yesShares: "10", orders: [order({ status: "PARTIALLY_FILLED", filledShares: "10" })] },
      fillPayload({ shares: "10" }),
    );
    const afterFirst = currentState(store);
    expect(afterFirst["allocatedShares"]).toBe("10");
    expect(afterFirst["instanceState"]).toBe("EXIT_PLANNED");
    const exitIntent =
      first.kind === "DECIDED"
        ? first.record.decision.intents.find((intent) => intent.type === "POSITION")
        : undefined;
    expect(exitIntent).toBeDefined();
    expect((exitIntent as { targetShares: string }).targetShares).toBe("-10");

    // The resting take-profit is surfaced, then a further entry fill enlarges
    // the allocation: the strategy cancels the stale exit BEFORE replacing it.
    const restingExit = order({
      orderId: "order-2",
      side: "SELL",
      price: "0.5",
      requestedShares: "10",
    });
    step(
      runtime,
      "onOrderUpdate",
      { yesShares: "10", orders: [restingExit] },
      { order: restingExit },
    );
    expect(currentState(store)["instanceState"]).toBe("EXIT_WORKING");

    const second = step(
      runtime,
      "onFill",
      { yesShares: "25", orders: [restingExit] },
      fillPayload({ shares: "15" }),
    );
    expect(second.kind === "DECIDED" && second.record.decision.decisionType).toBe("cancel");
    const afterSecond = currentState(store);
    expect(afterSecond["allocatedShares"]).toBe("25");
    // §13.3 rule 3: maximum entries count actual EXECUTIONS. Two fills of one
    // entry order are ONE execution, not two — and not two intents either.
    expect(afterSecond["entriesExecuted"]).toBe(1);
    expect((afterSecond["exitOrder"] as Record<string, unknown>)["state"]).toBe("CANCEL_PENDING");
    if (second.kind === "DECIDED") {
      expect(second.record.decision.intents.filter((intent) => intent.type === "POSITION")).toHaveLength(
        0,
      );
    }

    // Once the cancel is confirmed the replacement is sized to the FULL
    // confirmed allocation, and to nothing else.
    const canceled = order({
      orderId: "order-2",
      side: "SELL",
      price: "0.5",
      requestedShares: "10",
      status: "CANCELED",
    });
    step(runtime, "onOrderUpdate", { yesShares: "25", orders: [canceled] }, { order: canceled });
    const replaced = step(runtime, "onFeatures", { yesShares: "25" });
    const replacement =
      replaced.kind === "DECIDED"
        ? replaced.record.decision.intents.find((intent) => intent.type === "POSITION")
        : undefined;
    expect(replacement).toBeDefined();
    expect((replacement as { targetShares: string }).targetShares).toBe("-25");
    expect(sink.calls.every((call) => call.record.attribution === "STRATEGY")).toBe(true);
  });
});

describe("through the real runtime — the stale-data path", () => {
  it("pauses, cancels and never flattens on a stale book, then resumes when data recovers", () => {
    const { runtime, sink, store } = harness();
    step(runtime, "onStart");
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    step(runtime, "onFill", { yesShares: "50" }, fillPayload());
    const restingExit = order({
      orderId: "order-2",
      side: "SELL",
      price: "0.5",
      requestedShares: "50",
    });
    step(
      runtime,
      "onOrderUpdate",
      { yesShares: "50", orders: [restingExit] },
      { order: restingExit },
    );

    // The book goes stale while the stop condition is satisfied.
    const stale = { ...HEALTHY_YES, asOf: "2026-03-04T12:04:50.000Z" };
    const paused = step(runtime, "onFeatures", {
      yesShares: "50",
      yes: stale,
      orders: [restingExit],
      features: { [STOP_KEY]: "0.2" },
    });
    expect(paused.kind === "DECIDED" && paused.record.decision.decisionType).toBe("cancel");
    if (paused.kind === "DECIDED") {
      const decision = paused.record.decision;
      expect(decision.reasonCodes).toContain("SB.INCIDENT_POLICY_FIRST");
      expect(decision.reasonCodes).toContain("SB.STOP_SUPPRESSED_STALE_DATA");
      expect(decision.reasonCodes).toContain("SB.NO_BLIND_FLATTEN");
      expect(decision.intents.filter((intent) => intent.type === "REDUCE_POSITION")).toHaveLength(0);
      expect(decision.intents.filter((intent) => intent.type === "CANCEL")).toHaveLength(1);
    }
    expect(currentState(store)["instanceState"]).toBe("PAUSED");

    // While the data stays stale the instance keeps holding: no reduction ever.
    const stillPaused = step(runtime, "onFeatures", {
      yesShares: "50",
      yes: stale,
      features: { [STOP_KEY]: "0.2" },
    });
    if (stillPaused.kind === "DECIDED") {
      expect(stillPaused.record.decision.intents.filter((intent) => intent.type === "REDUCE_POSITION")).toHaveLength(
        0,
      );
    }
    expect(currentState(store)["instanceState"]).toBe("PAUSED");

    // Data recovers: the instance resumes into the state it paused from — but
    // the safety cancel it issued is still in flight, so it waits for the
    // confirmation instead of placing a reduction alongside a possibly-live
    // sell order (§6 invariant 13).
    const resumed = step(runtime, "onFeatures", {
      yesShares: "50",
      features: { [STOP_KEY]: "0.2" },
    });
    expect(resumed.kind === "DECIDED" && resumed.record.decision.reasonCodes).toContain(
      "SB.RESUMED",
    );
    if (resumed.kind === "DECIDED") {
      expect(resumed.record.decision.reasonCodes).toContain("SB.AWAITING_CANCEL_CONFIRMATION");
      expect(resumed.record.decision.intents).toHaveLength(0);
    }

    // The cancel is confirmed; only NOW may the stop act.
    const canceled = order({
      orderId: "order-2",
      side: "SELL",
      price: "0.5",
      requestedShares: "50",
      status: "CANCELED",
    });
    step(runtime, "onOrderUpdate", { yesShares: "50", orders: [canceled] }, { order: canceled });
    const stopped = step(runtime, "onFeatures", {
      yesShares: "50",
      features: { [STOP_KEY]: "0.2" },
    });
    if (stopped.kind === "DECIDED") {
      expect(stopped.record.decision.decisionType).toBe("reduce");
      expect(stopped.record.decision.reasonCodes).toContain("SB.STOP_TRIGGERED");
      const reduction = stopped.record.decision.intents.find(
        (intent) => intent.type === "REDUCE_POSITION",
      );
      expect(reduction).toBeDefined();
      expect((reduction as { targetShares: string }).targetShares).toBe("0");
      expect((reduction as { minimumSellPrice?: string }).minimumSellPrice).toBe("0.26");
    }
    // Every evaluation produced exactly one STRATEGY-attributed record: no
    // callback threw, so the runtime never had to contain one.
    expect(sink.calls.every((call) => call.record.attribution === "STRATEGY")).toBe(true);
    expect(sink.calls).toHaveLength(store.checkpoints.length);
  });
});

describe("through the real runtime — determinism and safety", () => {
  it("is byte-identical across two runtimes with different seeds", () => {
    const script = (): string => {
      const { runtime, sink } = harness();
      step(runtime, "onStart");
      step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
      step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
      step(runtime, "onFill", { yesShares: "50" }, fillPayload());
      step(runtime, "onMarketClosing", { yesShares: "50" }, { secondsRemaining: 19 });
      return JSON.stringify(sink.calls.map((call) => call.record.decision));
    };
    const first = script();
    const second = script();
    expect(second).toBe(first);

    // A different run seed changes the RNG stream and nothing else, because
    // this strategy never draws from it.
    const clock = new ManualClock();
    const sink = new RecordingSink();
    const created = createStrategyInstanceRuntime({
      strategy: staticBracketStrategy,
      params: baseConfig(),
      run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: "999999999" },
      watchdog: { evaluationBudgetUs: 500_000 },
      clock,
      decisionSink: sink,
      checkpointStore: new RecordingStore(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    step(created.runtime, "onStart");
    step(created.runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(created.runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    step(created.runtime, "onFill", { yesShares: "50" }, fillPayload());
    step(created.runtime, "onMarketClosing", { yesShares: "50" }, { secondsRemaining: 19 });
    expect(JSON.stringify(sink.calls.map((call) => call.record.decision))).toBe(first);
  });

  it("emits only intents — never an order, a credential, or a venue call", () => {
    const { runtime, sink } = harness();
    step(runtime, "onStart");
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    step(runtime, "onFill", { yesShares: "50" }, fillPayload());
    step(runtime, "onStop", { yesShares: "50" }, { reason: "operator stop" });
    const types = new Set(
      sink.calls.flatMap((call) => call.record.decision.intents.map((intent) => intent.type)),
    );
    for (const type of types) {
      expect(["POSITION", "CANCEL", "REDUCE_POSITION"]).toContain(type);
    }
    const serialized = JSON.stringify(sink.calls);
    for (const forbidden of ["privateKey", "apiKey", "signature", "http", "wss"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("refuses a configuration the schema rejects, before any evaluation happens", () => {
    const clock = new ManualClock();
    const sink = new RecordingSink();
    const created = createStrategyInstanceRuntime({
      strategy: staticBracketStrategy,
      params: { strategy: "static-bracket" },
      run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: RUN_SEED },
      watchdog: { evaluationBudgetUs: 500_000 },
      clock,
      decisionSink: sink,
      checkpointStore: new RecordingStore(),
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.refusal.code).toBe("PARAMS_REJECTED");
    expect(sink.calls).toHaveLength(0);
  });

  it("stops with a safety cancel and no position action", () => {
    const { runtime, sink } = harness();
    step(runtime, "onStart");
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    const stopped = step(runtime, "onStop", {}, { reason: "run ended" });
    expect(stopped.kind === "DECIDED" && stopped.record.decision.decisionType).toBe("cancel");
    if (stopped.kind === "DECIDED") {
      expect(stopped.record.decision.intents.every((intent) => intent.type === "CANCEL")).toBe(true);
    }
    // The runtime stops the instance after `onStop`, so a further evaluation is
    // refused without a record.
    const after = runtime.evaluate(evaluationInput("onFeatures", {}));
    expect(after.kind).toBe("REFUSED");
    expect(sink.calls).toHaveLength(4);
  });

  it("keeps every checkpoint restorable: the state document round-trips", () => {
    const { runtime, store } = harness();
    step(runtime, "onStart");
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    for (const checkpoint of store.checkpoints) {
      const parsed = JSON.parse(checkpoint.stateJson) as Record<string, unknown>;
      expect(parsed["schemaVersion"]).toBe(staticBracketStrategy.stateSchemaVersion);
      expect(checkpoint.strategyName).toBe("static-bracket");
      expect(checkpoint.runSeed).toBe(RUN_SEED);
    }
    expect(T_NOW).toBe("2026-03-04T12:05:00.000Z");
  });
});
