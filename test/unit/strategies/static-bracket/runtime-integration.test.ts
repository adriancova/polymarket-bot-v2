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
  protectedReductions,
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

/**
 * RE-ENTRY, DRIVEN TWICE.
 *
 * `maximum_entries_per_market` is a §13.3 rule-3 bound on ACTUAL EXECUTIONS, and
 * it is enforced by a counter that only increments on an entry order's FIRST
 * confirmed fill. Before the remediation `planRearm` cleared only the two order
 * tracks, so bracket 2 inherited bracket 1's `allocatedShares` and no fill ever
 * looked like a first fill again: the counter froze at 1 and the bound stopped
 * binding. It also inherited `openedAtMs`, so a 180-second bracket was
 * force-exited seconds after opening, on a clock belonging to a bracket that had
 * already closed.
 */
describe("through the real runtime — re-entry runs a SECOND complete bracket", () => {
  const twoEntries = (): Record<string, unknown> => {
    const config = baseConfig();
    (config["reentry"] as Record<string, unknown>)["maximum_entries_per_market"] = 2;
    (config["reentry"] as Record<string, unknown>)["cooldown_seconds"] = 0;
    return config;
  };

  /** One whole bracket: enter, rest, fill, take profit, exit-fill, close. */
  function bracket(runtime: StrategyInstanceRuntime, exitOrderId: string): void {
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    step(runtime, "onFill", { yesShares: "50" }, fillPayload());
    step(
      runtime,
      "onFill",
      { yesShares: "0" },
      fillPayload({ orderId: exitOrderId, side: "SELL", price: "0.5", shares: "50" }),
    );
  }

  it("counts each execution, gives bracket 2 a FRESH holding clock, and refuses a third", () => {
    const { runtime, store } = harness(twoEntries());
    step(runtime, "onStart");

    bracket(runtime, "order-2");
    const afterFirst = currentState(store);
    expect(afterFirst["instanceState"]).toBe("CLOSED");
    expect(afterFirst["entriesExecuted"]).toBe(1);
    expect(afterFirst["exitedShares"]).toBe("50");
    const firstOpenedAt = afterFirst["openedAtMs"];
    expect(typeof firstOpenedAt).toBe("number");

    // Re-arm: every PER-BRACKET field is reset, every PER-MARKET field survives.
    step(runtime, "onFeatures", { yesShares: "0" });
    const rearmed = currentState(store);
    expect(rearmed["instanceState"]).toBe("ARMED");
    expect(rearmed["allocatedShares"]).toBe("0");
    expect(rearmed["allocatedCost"]).toBe("0");
    expect(rearmed["exitedShares"]).toBe("0");
    expect(rearmed["legOutcome"]).toBeNull();
    expect(rearmed["legBaselineShares"]).toBe("0");
    expect(rearmed["openedAtMs"]).toBeNull();
    // Per-market, and carried: the execution count, the cool-down anchor, and
    // the monotone intent sequence.
    expect(rearmed["entriesExecuted"]).toBe(1);
    expect(rearmed["closedAtMs"]).toBe(afterFirst["closedAtMs"]);
    expect(Number(rearmed["intentSequence"])).toBeGreaterThan(0);

    bracket(runtime, "order-4");
    const afterSecond = currentState(store);
    expect(afterSecond["instanceState"]).toBe("CLOSED");
    // THE COUNTER MOVED. This is the assertion the frozen counter failed.
    expect(afterSecond["entriesExecuted"]).toBe(2);
    // And bracket 2's holding clock is its own, not bracket 1's.
    expect(afterSecond["openedAtMs"]).toBe(firstOpenedAt);
    expect(afterSecond["allocatedShares"]).toBe("50");
    expect(afterSecond["exitedShares"]).toBe("50");

    // A third entry is refused: two executions is the configured maximum.
    const third = step(runtime, "onFeatures", { yesShares: "0" });
    expect(third.kind === "DECIDED" && third.record.decision.reasonCodes).toContain(
      "SB.REFUSED_MAXIMUM_ENTRIES",
    );
    expect(
      third.kind === "DECIDED" &&
        third.record.decision.intents.filter((intent) => intent.type === "POSITION").length,
    ).toBe(0);
    expect(currentState(store)["instanceState"]).toBe("CLOSED");
  });

  it("bracket 2 is not force-exited by bracket 1's holding clock", () => {
    const { runtime, store } = harness(twoEntries());
    step(runtime, "onStart");
    bracket(runtime, "order-2");
    step(runtime, "onFeatures", { yesShares: "0" });

    // Re-enter and fill: `maximum_holding_seconds` is 180 and no time has
    // passed on the fixture clock, so the bracket must be MANAGED (a resting
    // take-profit), never reduced.
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    const filled = step(runtime, "onFill", { yesShares: "50" }, fillPayload());
    expect(filled.kind === "DECIDED" && filled.record.decision.decisionType).toBe("exit");
    if (filled.kind === "DECIDED") {
      expect(filled.record.decision.reasonCodes).not.toContain("SB.HOLDING_TIMEOUT");
      // FORCING FINDING r2-B1: read through the tag, not the intent type.
      expect(protectedReductions(filled.record.decision)).toHaveLength(0);
    }
    expect(currentState(store)["instanceState"]).toBe("EXIT_PLANNED");
  });
});

/**
 * §8.1 GIVES NO ORDERING between a `StrategyOrderView` and the `StrategyFill` it
 * describes. A view that reports FILLED before the fill arrives used to be read
 * as "this order executed nothing": the entry order was discarded, the instance
 * returned to ARMED, and the very next evaluation entered again — a second real
 * POSITION intent on a market it had already fully entered.
 */
describe("through the real runtime — a FILLED view that outruns its fill", () => {
  const roomForTwo = (): Record<string, unknown> => {
    const config = baseConfig();
    // Deliberately generous, so the position cap is not what saves us: the
    // question is whether the STRATEGY re-enters, not whether a cap catches it.
    (config["risk"] as Record<string, unknown>)["maximum_position_shares"] = "500";
    return config;
  };

  it("waits for the fill stream instead of re-entering", () => {
    const { runtime, store } = harness(roomForTwo());
    step(runtime, "onStart");
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });

    const filledView = order({ status: "FILLED", filledShares: "50" });
    const seen = step(
      runtime,
      "onOrderUpdate",
      { yesShares: "50", orders: [filledView] },
      { order: filledView },
    );
    expect(seen.kind === "DECIDED" && seen.record.decision.reasonCodes).toContain(
      "SB.AWAITING_FILL_ALLOCATION",
    );
    const waiting = currentState(store);
    // NOT ARMED, and the execution is not discarded.
    expect(waiting["instanceState"]).toBe("ENTRY_WORKING");
    expect((waiting["entryOrder"] as Record<string, unknown>)["viewFilledShares"]).toBe("50");
    // The fold is still the only writer of the allocation (§13.3 rule 1).
    expect(waiting["allocatedShares"]).toBe("0");

    // The next evaluation must NOT emit a second entry.
    const next = step(runtime, "onFeatures", { yesShares: "50" });
    expect(
      next.kind === "DECIDED" &&
        next.record.decision.intents.filter((intent) => intent.type === "POSITION").length,
    ).toBe(0);
    expect(next.kind === "DECIDED" && next.record.decision.reasonCodes).toContain(
      "SB.AWAITING_FILL_ALLOCATION",
    );

    // When the fill finally lands, the allocation is folded from it and the
    // exit is sized to the fold — the view's number never became an allocation.
    const landed = step(runtime, "onFill", { yesShares: "50" }, fillPayload());
    expect(landed.kind === "DECIDED" && landed.record.decision.decisionType).toBe("exit");
    const open = currentState(store);
    expect(open["allocatedShares"]).toBe("50");
    expect(open["entriesExecuted"]).toBe(1);
    const exitIntent =
      landed.kind === "DECIDED"
        ? landed.record.decision.intents.find((intent) => intent.type === "POSITION")
        : undefined;
    expect(exitIntent && "targetShares" in exitIntent ? exitIntent.targetShares : null).toBe("-50");
  });

  it("never lets the total requested exposure exceed maximum_position_shares", () => {
    // The coherence rule the packet asks to pin: across the whole sequence, the
    // sum of entry-side POSITION deltas may never exceed the configured cap.
    const { runtime, sink } = harness(roomForTwo());
    step(runtime, "onStart");
    step(runtime, "onFeatures", { features: { [TRIGGER_KEY]: "0.35" } });
    step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
    const filledView = order({ status: "FILLED", filledShares: "50" });
    step(runtime, "onOrderUpdate", { yesShares: "50", orders: [filledView] }, { order: filledView });
    step(runtime, "onFeatures", { yesShares: "50" });
    step(runtime, "onFeatures", { yesShares: "50" });

    let requested = 0;
    for (const call of sink.calls) {
      for (const intent of call.record.decision.intents) {
        if (intent.type !== "POSITION") continue;
        if (intent.targetShares.startsWith("-")) continue;
        requested += Number(intent.targetShares);
      }
    }
    expect(requested).toBe(50);
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
      // FORCING FINDING r2-B1: a protected reduction is a tagged POSITION delta
      // now, so "no reduction was emitted" is asserted on the tag AND on the
      // absence of any position-changing intent at all.
      expect(protectedReductions(decision)).toHaveLength(0);
      expect(decision.intents.filter((intent) => intent.type === "POSITION")).toHaveLength(0);
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
      expect(protectedReductions(stillPaused.record.decision)).toHaveLength(0);
      expect(
        stillPaused.record.decision.intents.filter((intent) => intent.type === "POSITION"),
      ).toHaveLength(0);
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
      const reduction = protectedReductions(stopped.record.decision)[0];
      expect(reduction).toBeDefined();
      // FORCING FINDING r2-B1(b): a signed DELTA on this bracket's own leg,
      // never a market-wide sell-down level of "0".
      expect((reduction as { direction: string }).direction).toBe("YES");
      expect((reduction as { targetShares: string }).targetShares).toBe("-50");
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

  /**
   * The same byte-identity property over the two lifecycles the remediation
   * added: a COMPLEMENT-LEG bracket (whose exits are buy-backs at complemented
   * prices) and a TWO-BRACKET re-entry (whose second bracket runs on freshly
   * reset per-bracket state). Both are longer and touch more of the ladder than
   * the happy path, so both are worth pinning.
   */
  it("is byte-identical over a complement-leg bracket and a two-bracket re-entry", () => {
    const complementConfig = (): Record<string, unknown> => {
      const config = baseConfig();
      (config["entry"] as Record<string, unknown>)["economic_leg_policy"] =
        "PREFER_CHEAPEST_WITH_INVENTORY";
      (config["reentry"] as Record<string, unknown>)["maximum_entries_per_market"] = 2;
      (config["reentry"] as Record<string, unknown>)["cooldown_seconds"] = 0;
      return config;
    };

    const CHEAP_NO: ViewOptions = {
      noShares: "100",
      no: { bids: [["0.7", "2000"]], asks: [["0.72", "2000"]] },
    };
    const noEntryOrder = (overrides: Record<string, unknown> = {}) =>
      order({ orderId: "no-1", outcome: "NO", side: "SELL", price: "0.65", ...overrides });
    const noExitOrder = (overrides: Record<string, unknown> = {}) =>
      order({ orderId: "no-2", outcome: "NO", side: "BUY", price: "0.5", ...overrides });

    const script = (runSeed: string): { bytes: string; evaluations: number } => {
      const clock = new ManualClock();
      const sink = new RecordingSink();
      const created = createStrategyInstanceRuntime({
        strategy: staticBracketStrategy,
        params: complementConfig(),
        run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed },
        watchdog: { evaluationBudgetUs: 500_000 },
        clock,
        decisionSink: sink,
        checkpointStore: new RecordingStore(),
      });
      if (!created.ok) throw new Error("the runtime must accept the configuration");
      const runtime = created.runtime;

      // Bracket 1, on the COMPLEMENT leg: sell NO, buy it back.
      step(runtime, "onStart", CHEAP_NO);
      step(runtime, "onFeatures", CHEAP_NO);
      step(
        runtime,
        "onOrderUpdate",
        { ...CHEAP_NO, orders: [noEntryOrder()] },
        { order: noEntryOrder() },
      );
      step(
        runtime,
        "onFill",
        { ...CHEAP_NO, noShares: "50" },
        fillPayload({ orderId: "no-1", outcome: "NO", side: "SELL", price: "0.7", shares: "50" }),
      );
      step(
        runtime,
        "onOrderUpdate",
        { ...CHEAP_NO, noShares: "50", orders: [noExitOrder()] },
        { order: noExitOrder() },
      );
      step(
        runtime,
        "onFill",
        CHEAP_NO,
        fillPayload({ orderId: "no-2", outcome: "NO", side: "BUY", price: "0.5", shares: "50" }),
      );
      // Bracket 2, re-armed and run on the DIRECT leg (no NO inventory left to
      // beat it once the complement book moves against it).
      step(runtime, "onFeatures", { noShares: "0" });
      step(runtime, "onFeatures", { noShares: "0" });
      step(runtime, "onOrderUpdate", { orders: [order()] }, { order: order() });
      step(runtime, "onFill", { yesShares: "50" }, fillPayload());
      step(runtime, "onTimer", { yesShares: "50" });
      step(
        runtime,
        "onFill",
        { yesShares: "0" },
        fillPayload({ orderId: "order-2", side: "SELL", price: "0.5", shares: "50" }),
      );
      step(runtime, "onFeatures", { yesShares: "0" });
      step(runtime, "onMarketClosing", { yesShares: "0" }, { secondsRemaining: 19 });
      return {
        bytes: JSON.stringify(sink.calls.map((call) => call.record.decision)),
        evaluations: sink.calls.length,
      };
    };

    const first = script(RUN_SEED);
    expect(first.evaluations).toBe(14);
    expect(script(RUN_SEED).bytes).toBe(first.bytes);
    // A different seed changes the RNG stream and nothing else.
    expect(script("999999999").bytes).toBe(first.bytes);

    // And the lifecycle really did run both legs and both brackets.
    expect(first.bytes).toContain("sb.leg:NO");
    expect(first.bytes).toContain("sb.leg:YES");
    expect(first.bytes).toContain("SB.REARMED");
    expect(first.bytes).toContain("SB.ENTRY_LEG_COMPLEMENT");
  });

  /**
   * DETERMINISM OVER THE TWO LIFECYCLES REVIEW ROUND 2 ADDED.
   *
   * 1. A COMPLEMENT-LEG PROTECTED REDUCTION (r2-B1): a bracket that established
   *    YES exposure by SELLING NO, stopped out, and unwound by BUYING that NO
   *    back. Before the remediation this path emitted a market-scoped
   *    `REDUCE_POSITION` that the merged planner turned into a further SALE of
   *    the token the bracket was already short.
   * 2. A FILL THAT ARRIVES WHILE THE INSTANCE IS PAUSED (r2-M1), followed by a
   *    resume. Before the remediation the fill was discarded and the instance
   *    resumed believing it held nothing.
   *
   * Both are byte-identical across repeats and across run seeds, because the
   * fold depends on the fill and not on when the evaluation happened.
   */
  it("is byte-identical over a complement-leg REDUCTION and a fill-while-PAUSED episode", () => {
    const complementConfig = (): Record<string, unknown> => {
      const config = baseConfig();
      (config["entry"] as Record<string, unknown>)["economic_leg_policy"] =
        "PREFER_CHEAPEST_WITH_INVENTORY";
      return config;
    };
    const CHEAP_NO: ViewOptions = {
      noShares: "100",
      no: { bids: [["0.7", "2000"]], asks: [["0.72", "2000"]] },
    };
    const STALE_NO: ViewOptions = {
      ...CHEAP_NO,
      noShares: "100",
      no: {
        bids: [["0.7", "2000"]],
        asks: [["0.72", "2000"]],
        asOf: "2026-03-04T12:04:50.000Z",
      },
    };
    const noEntryOrder = (overrides: Record<string, unknown> = {}) =>
      order({ orderId: "no-1", outcome: "NO", side: "SELL", price: "0.65", ...overrides });

    const script = (runSeed: string): { bytes: string; evaluations: number } => {
      const clock = new ManualClock();
      const sink = new RecordingSink();
      const created = createStrategyInstanceRuntime({
        strategy: staticBracketStrategy,
        params: complementConfig(),
        run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed },
        watchdog: { evaluationBudgetUs: 500_000 },
        clock,
        decisionSink: sink,
        checkpointStore: new RecordingStore(),
      });
      if (!created.ok) throw new Error("the runtime must accept the configuration");
      const runtime = created.runtime;

      step(runtime, "onStart", CHEAP_NO);
      step(runtime, "onFeatures", CHEAP_NO);
      step(
        runtime,
        "onOrderUpdate",
        { ...CHEAP_NO, orders: [noEntryOrder()] },
        { order: noEntryOrder() },
      );
      // The book goes stale BEFORE the entry fill arrives: the instance pauses,
      // and the fill lands on a PAUSED instance.
      step(runtime, "onFeatures", STALE_NO);
      step(
        runtime,
        "onFill",
        { ...STALE_NO, noShares: "50" },
        fillPayload({ orderId: "no-1", outcome: "NO", side: "SELL", price: "0.7", shares: "50" }),
      );
      // Data recovers with the stop deep in the money: resume, then reduce.
      step(runtime, "onFeatures", { ...CHEAP_NO, noShares: "50", features: { [STOP_KEY]: "0.1" } });
      step(runtime, "onFeatures", { ...CHEAP_NO, noShares: "50", features: { [STOP_KEY]: "0.1" } });
      step(runtime, "onFeatures", { ...CHEAP_NO, noShares: "50", features: { [STOP_KEY]: "0.1" } });
      return {
        bytes: JSON.stringify(sink.calls.map((call) => call.record.decision)),
        evaluations: sink.calls.length,
      };
    };

    const first = script(RUN_SEED);
    expect(first.evaluations).toBe(8);
    expect(script(RUN_SEED).bytes).toBe(first.bytes);
    expect(script("999999999").bytes).toBe(first.bytes);

    // The episode really did fold a fill while paused and really did reduce on
    // the complement leg — a determinism assertion over a lifecycle that never
    // happened would be worth nothing.
    expect(first.bytes).toContain("SB.FILL_FOLDED_WHILE_PAUSED");
    expect(first.bytes).toContain("SB.RESUMED");
    expect(first.bytes).toContain("SB.STOP_TRIGGERED");
    expect(first.bytes).toContain("sb.protected-reduce");
    expect(first.bytes).not.toContain("REDUCE_POSITION");
    expect(first.bytes).not.toContain("SB.HALTED");
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
