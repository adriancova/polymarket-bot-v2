/**
 * The twelve handoff §13.4 acceptance scenarios, one named test each.
 *
 * Every scenario drives the SHIPPED callbacks (`staticBracketStrategy.onX`)
 * through a §7.6-faithful context, so what is exercised is the whole path a
 * runtime would take: params validation, state parsing, view reading, the
 * ladder, and the rendered `DecisionResult`.
 *
 * The §13.4 bullet each test implements is quoted in its name, and
 * `covers-13.4.test.ts` proves the twelve names cover the twelve bullets read
 * from the handoff.
 */

import { describe, expect, it } from "vitest";

import type { DecisionResult, Intent } from "../../../../packages/domain/src/index.js";
import {
  REASONS,
  staticBracketParamsSchema,
  staticBracketStrategy,
  type OrderTrack,
  type StaticBracketState,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import { canonicalJsonStringify } from "../../../../packages/strategy-runtime/src/index.js";
import {
  HEALTHY_YES,
  INCIDENT_KEY,
  STOP_KEY,
  T_NOW,
  TRIGGER_KEY,
  baseConfig,
  configWith,
  context,
  order,
  parsedParams,
  stateWith,
  type ViewOptions,
} from "./helpers.js";

const NOW_MS = Date.parse(T_NOW);

/**
 * `Date.parse` is used ONCE, here, to derive a fixture constant — never inside
 * the strategy, and never as a clock: the value is a fixed instant printed in
 * `helpers.ts`. The assertion pins it so a fixture edit cannot silently move
 * every scenario's timeline.
 */
expect(NOW_MS).toBe(1772625900000);

function params(config: Record<string, unknown> = baseConfig()) {
  return parsedParams(staticBracketParamsSchema, config);
}

function intentsOf(decision: DecisionResult): readonly Intent[] {
  return decision.intents;
}

function positionIntents(decision: DecisionResult): Intent[] {
  return [...decision.intents].filter((intent) => intent.type === "POSITION");
}

function reduceIntents(decision: DecisionResult): Intent[] {
  return [...decision.intents].filter((intent) => intent.type === "REDUCE_POSITION");
}

function cancelIntents(decision: DecisionResult): Intent[] {
  return [...decision.intents].filter((intent) => intent.type === "CANCEL");
}

const ARMED = stateWith({ instanceState: "ARMED" });

function openState(overrides: Partial<StaticBracketState> = {}): StaticBracketState {
  return stateWith({
    instanceState: "OPEN",
    allocatedShares: "50",
    allocatedCost: "17.5",
    legOutcome: "YES",
    entriesExecuted: 1,
    openedAtMs: NOW_MS - 1000,
    ...overrides,
  });
}

const HELD_50: ViewOptions = { yesShares: "50" };

describe("§13.4 — Entry at exact threshold", () => {
  it("enters when the trigger feature equals trigger_price_lte exactly", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), ARMED, { features: { [TRIGGER_KEY]: "0.35" } }),
    );
    expect(decision.decisionType).toBe("enter");
    expect(decision.reasonCodes).toContain(REASONS.entryTriggerMet);
    const intents = positionIntents(decision);
    expect(intents).toHaveLength(1);
    const intent = intents[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.targetMode).toBe("DELTA");
    expect(intent.targetShares).toBe("50");
    expect(intent.direction).toBe("YES");
    expect(intent.maximumBuyPrice).toBe("0.35");
    expect(intent.maximumTotalCost).toBe("18");
  });

  it("enters on the equivalent non-canonical spelling of the same threshold", () => {
    // "0.350" is the same number; the config door normalizes it, so the
    // comparison at the boundary is exact rather than textual.
    const decision = staticBracketStrategy.onFeatures(
      context(params(configWith({ "entry.trigger_price_lte": "0.350" })), ARMED, {
        features: { [TRIGGER_KEY]: "0.35" },
      }),
    );
    expect(decision.decisionType).toBe("enter");
  });
});

describe("§13.4 — No entry one tick above threshold", () => {
  it("holds when the trigger feature is one tick above trigger_price_lte", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), ARMED, { features: { [TRIGGER_KEY]: "0.36" } }),
    );
    expect(decision.decisionType).toBe("hold");
    expect(decision.reasonCodes).toContain(REASONS.entryTriggerNotMet);
    expect(intentsOf(decision)).toHaveLength(0);
  });

  it("holds one tick above and enters one tick below, on the same fixtures", () => {
    const below = staticBracketStrategy.onFeatures(
      context(params(), ARMED, { features: { [TRIGGER_KEY]: "0.34" } }),
    );
    expect(below.decisionType).toBe("enter");
  });
});

describe("§13.4 — Tick-size change while resting", () => {
  it("cancels a resting entry whose price left the tick grid, and places nothing new", () => {
    const resting = stateWith({
      instanceState: "ENTRY_WORKING",
      legOutcome: "YES",
      entryOrder: {
        kind: "ENTRY",
        intentId: "sb-entry-0",
        orderId: "order-1",
        state: "WORKING",
        outcome: "YES",
        side: "BUY",
        limitPrice: "0.35",
        requestedShares: "50",
        filledShares: "0",
        placedAtMs: NOW_MS - 500,
        escalated: true,
      },
    });
    const decision = staticBracketStrategy.onFeatures(
      context(params(), resting, { tickSize: "0.02", orders: [order()] }),
    );
    expect(decision.decisionType).toBe("cancel");
    expect(decision.reasonCodes).toContain(REASONS.tickSizeChanged);
    expect(cancelIntents(decision)).toHaveLength(1);
    expect(positionIntents(decision)).toHaveLength(0);
    const patch = decision.statePatch as Record<string, unknown>;
    expect((patch["entryOrder"] as Record<string, unknown>)["state"]).toBe("CANCEL_PENDING");
  });

  it("leaves a resting entry alone while its price is still on the grid", () => {
    const resting = stateWith({
      instanceState: "ENTRY_WORKING",
      legOutcome: "YES",
      entryOrder: {
        kind: "ENTRY",
        intentId: "sb-entry-0",
        orderId: "order-1",
        state: "WORKING",
        outcome: "YES",
        side: "BUY",
        limitPrice: "0.34",
        requestedShares: "50",
        filledShares: "0",
        placedAtMs: NOW_MS - 500,
        escalated: true,
      },
    });
    const decision = staticBracketStrategy.onFeatures(
      context(params(), resting, { tickSize: "0.02", orders: [order()] }),
    );
    expect(decision.decisionType).toBe("hold");
    expect(decision.reasonCodes).not.toContain(REASONS.tickSizeChanged);
  });
});

describe("§13.4 — Partial entry and proportional exit", () => {
  const working = stateWith({
    instanceState: "ENTRY_WORKING",
    legOutcome: "YES",
    entryOrder: {
      kind: "ENTRY",
      intentId: "sb-entry-0",
      orderId: "order-1",
      state: "WORKING",
      outcome: "YES",
      side: "BUY",
      limitPrice: "0.35",
      requestedShares: "50",
      filledShares: "0",
      placedAtMs: NOW_MS - 500,
      escalated: true,
    },
  });

  it("creates ONLY a proportional exit — 10 filled means an exit of 10, never 50", () => {
    const decision = staticBracketStrategy.onFill(
      context(params(), working, { yesShares: "10" }),
      {
        orderId: "order-1",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "BUY",
        price: "0.35",
        shares: "10",
        filledAt: T_NOW,
      } as never,
    );
    expect(decision.decisionType).toBe("exit");
    expect(decision.reasonCodes).toContain(REASONS.exitProportional);
    const intents = positionIntents(decision);
    expect(intents).toHaveLength(1);
    const intent = intents[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.targetShares).toBe("-10");
    expect(intent.minimumSellPrice).toBe("0.5");
    // The requested entry size must appear NOWHERE in the emitted exit.
    expect(JSON.stringify(intent)).not.toContain("50");
  });

  it("records the allocation in the same decision that sizes the exit (rule 2: only after allocation)", () => {
    const decision = staticBracketStrategy.onFill(
      context(params(), working, { yesShares: "10" }),
      {
        orderId: "order-1",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "BUY",
        price: "0.35",
        shares: "10",
        filledAt: T_NOW,
      } as never,
    );
    const patch = decision.statePatch as Record<string, unknown>;
    expect(patch["allocatedShares"]).toBe("10");
    expect(patch["instanceState"]).toBe("EXIT_PLANNED");
    const intent = positionIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.targetShares).toBe(`-${patch["allocatedShares"] as string}`);
  });

  it("emits NO exit at all while nothing has been allocated", () => {
    const decision = staticBracketStrategy.onFeatures(context(params(), working, {}));
    expect(positionIntents(decision)).toHaveLength(0);
    expect(reduceIntents(decision)).toHaveLength(0);
  });

  it("replaces the resting exit when a further fill enlarges the allocation, cancel first", () => {
    const partiallyOpen = stateWith({
      instanceState: "EXIT_PLANNED",
      legOutcome: "YES",
      allocatedShares: "10",
      allocatedCost: "3.5",
      entriesExecuted: 1,
      openedAtMs: NOW_MS - 500,
      entryOrder: {
        kind: "ENTRY",
        intentId: "sb-entry-0",
        orderId: "order-1",
        state: "WORKING",
        outcome: "YES",
        side: "BUY",
        limitPrice: "0.35",
        requestedShares: "50",
        filledShares: "10",
        placedAtMs: NOW_MS - 500,
        escalated: true,
      },
      exitOrder: {
        kind: "EXIT",
        intentId: "sb-take-profit-1",
        orderId: "order-2",
        state: "WORKING",
        outcome: "YES",
        side: "SELL",
        limitPrice: "0.5",
        requestedShares: "10",
        filledShares: "0",
        placedAtMs: NOW_MS - 400,
        escalated: false,
      },
    });
    const decision = staticBracketStrategy.onFill(
      context(params(), partiallyOpen, { yesShares: "25" }),
      {
        orderId: "order-1",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "BUY",
        price: "0.35",
        shares: "15",
        filledAt: T_NOW,
      } as never,
    );
    expect(decision.decisionType).toBe("cancel");
    expect(decision.reasonCodes).toContain(REASONS.takeProfitReplaced);
    expect(cancelIntents(decision)).toHaveLength(1);
    // Cancel-then-replace: no new sell order in the same decision (§6 invariant 13).
    expect(positionIntents(decision)).toHaveLength(0);
    expect((decision.statePatch as Record<string, unknown>)["allocatedShares"]).toBe("25");
  });
});

describe("§13.4 — Entry response lost and later reconciled live", () => {
  const pending = stateWith({
    instanceState: "ENTRY_PLANNED",
    legOutcome: "YES",
    entryOrder: {
      kind: "ENTRY",
      intentId: "sb-entry-0",
      orderId: null,
      state: "PENDING",
      outcome: "YES",
      side: "BUY",
      limitPrice: "0.35",
      requestedShares: "50",
      filledShares: "0",
      placedAtMs: NOW_MS - 6000,
      escalated: true,
    },
  });

  it("marks a silent submission UNKNOWN and neither re-enters nor cancels blindly", () => {
    const decision = staticBracketStrategy.onFeatures(context(params(), pending, {}));
    expect(decision.decisionType).toBe("hold");
    expect(decision.reasonCodes).toContain(REASONS.entrySubmissionUnknown);
    expect(decision.reasonCodes).toContain(REASONS.entryAwaitingReconciliation);
    expect(intentsOf(decision)).toHaveLength(0);
    const patch = decision.statePatch as Record<string, unknown>;
    expect((patch["entryOrder"] as Record<string, unknown>)["state"]).toBe("SUBMISSION_UNKNOWN");
  });

  it("stays put on every later evaluation until the order is reconciled", () => {
    const unknown = stateWith({
      ...pending,
      entryOrder: { ...(pending.entryOrder as OrderTrack), state: "SUBMISSION_UNKNOWN" as const },
    });
    const decision = staticBracketStrategy.onFeatures(context(params(), unknown, {}));
    expect(intentsOf(decision)).toHaveLength(0);
    expect(decision.reasonCodes).toContain(REASONS.entrySubmissionUnknown);
  });

  it("reconciles live when the order surfaces, and allocates from the fill that follows", () => {
    const unknown = stateWith({
      ...pending,
      entryOrder: { ...(pending.entryOrder as OrderTrack), state: "SUBMISSION_UNKNOWN" as const },
    });
    const reconciled = staticBracketStrategy.onOrderUpdate(
      context(params(), unknown, { orders: [order()] }),
      order() as never,
    );
    expect(reconciled.reasonCodes).toContain(REASONS.entryReconciled);
    const patch = reconciled.statePatch as Record<string, unknown>;
    const track = patch["entryOrder"] as Record<string, unknown>;
    expect(track["state"]).toBe("WORKING");
    expect(track["orderId"]).toBe("order-1");

    const afterFill = staticBracketStrategy.onFill(
      context(params(), { ...unknown, ...patch } as never, { yesShares: "50" }),
      {
        orderId: "order-1",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "BUY",
        price: "0.35",
        shares: "50",
        filledAt: T_NOW,
      } as never,
    );
    expect((afterFill.statePatch as Record<string, unknown>)["allocatedShares"]).toBe("50");
  });
});

describe("§13.4 — Stop trigger with healthy book", () => {
  it("reduces to flat under the configured floor when the stop trigger is met", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openState(), { ...HELD_50, features: { [STOP_KEY]: "0.27" } }),
    );
    expect(decision.decisionType).toBe("reduce");
    expect(decision.reasonCodes).toContain(REASONS.stopTriggered);
    const intents = reduceIntents(decision);
    expect(intents).toHaveLength(1);
    const intent = intents[0] as Extract<Intent, { type: "REDUCE_POSITION" }>;
    expect(intent.targetShares).toBe("0");
    expect(intent.minimumSellPrice).toBe("0.26");
    expect(intent.urgency).toBe("AGGRESSIVE");
  });

  it("does not stop one tick above the stop threshold", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openState(), { ...HELD_50, features: { [STOP_KEY]: "0.28" } }),
    );
    expect(reduceIntents(decision)).toHaveLength(0);
  });
});

describe("§13.4 — Stale-book stop does not blind-flatten", () => {
  const staleBook = {
    ...HEALTHY_YES,
    asOf: "2026-03-04T12:04:50.000Z",
  };

  it("suppresses a satisfied stop on a stale book and emits NO reduction", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openState(), {
        ...HELD_50,
        yes: staleBook,
        features: { [STOP_KEY]: "0.2" },
      }),
    );
    expect(reduceIntents(decision)).toHaveLength(0);
    expect(positionIntents(decision)).toHaveLength(0);
    expect(decision.reasonCodes).toContain(REASONS.incidentPolicyFirst);
    expect(decision.reasonCodes).toContain(REASONS.staleBook);
    expect(decision.reasonCodes).toContain(REASONS.stopSuppressedStaleData);
    expect(decision.reasonCodes).toContain(REASONS.noBlindFlatten);
    expect((decision.statePatch as Record<string, unknown>)["instanceState"]).toBe("PAUSED");
  });

  it("cancels resting orders instead (incident policy first), and never sells", () => {
    const withResting = openState({
      instanceState: "EXIT_PLANNED",
      exitOrder: {
        kind: "EXIT",
        intentId: "sb-take-profit-1",
        orderId: "order-2",
        state: "WORKING",
        outcome: "YES",
        side: "SELL",
        limitPrice: "0.5",
        requestedShares: "50",
        filledShares: "0",
        placedAtMs: NOW_MS - 400,
        escalated: false,
      },
    });
    const decision = staticBracketStrategy.onFeatures(
      context(params(), withResting, {
        ...HELD_50,
        yes: staleBook,
        features: { [STOP_KEY]: "0.2" },
      }),
    );
    expect(decision.decisionType).toBe("cancel");
    expect(cancelIntents(decision)).toHaveLength(1);
    expect(reduceIntents(decision)).toHaveLength(0);
    expect(decision.reasonCodes).toContain(REASONS.safetyCancel);
  });

  it("treats an active data-quality incident the same way on a FRESH book", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openState(), {
        ...HELD_50,
        features: { [STOP_KEY]: "0.2", [INCIDENT_KEY]: true },
      }),
    );
    expect(reduceIntents(decision)).toHaveLength(0);
    expect(decision.reasonCodes).toContain(REASONS.dataQualityIncident);
    expect(decision.reasonCodes).toContain(REASONS.stopSuppressedStaleData);
  });

  it("treats an unusable or absent incident flag as an incident, never as an all-clear", () => {
    for (const flag of [null, "false", 0 as unknown as boolean]) {
      const decision = staticBracketStrategy.onFeatures(
        context(params(), openState(), {
          ...HELD_50,
          features: { [STOP_KEY]: "0.2", [INCIDENT_KEY]: flag as never },
        }),
      );
      expect(reduceIntents(decision), `flag ${String(flag)} must not permit a stop`).toHaveLength(0);
      expect(decision.reasonCodes).toContain(REASONS.dataQualityIncident);
    }
  });

  it("resumes and only THEN acts once the data is healthy again", () => {
    const paused = openState({ instanceState: "PAUSED", resumeTo: "OPEN" });
    const decision = staticBracketStrategy.onFeatures(
      context(params(), paused, { ...HELD_50, features: { [STOP_KEY]: "0.2" } }),
    );
    expect(decision.reasonCodes).toContain(REASONS.resumed);
    expect(decision.decisionType).toBe("reduce");
  });
});

describe("§13.4 — Market close cutoff", () => {
  it("refuses a new entry inside entry_cutoff_before_close_seconds", () => {
    const decision = staticBracketStrategy.onMarketClosing(
      context(params(), ARMED, { features: { [TRIGGER_KEY]: "0.3" } }),
      30,
    );
    expect(decision.reasonCodes).toContain(REASONS.refusedEntryCutoff);
    expect(intentsOf(decision)).toHaveLength(0);
  });

  it("still enters outside the cutoff", () => {
    const decision = staticBracketStrategy.onMarketClosing(
      context(params(), ARMED, { features: { [TRIGGER_KEY]: "0.3" } }),
      120,
    );
    expect(decision.decisionType).toBe("enter");
  });

  it("applies the end-of-market policy inside exit_cutoff_before_close_seconds", () => {
    const decision = staticBracketStrategy.onMarketClosing(
      context(params(), openState(), HELD_50),
      19,
    );
    expect(decision.reasonCodes).toContain(REASONS.exitCutoff);
    expect(decision.decisionType).toBe("reduce");
    expect(reduceIntents(decision)).toHaveLength(1);
  });

  it("cancels only, and holds no position action, under CANCEL_ONLY", () => {
    const cancelOnly = params(configWith({ "exit.final_policy": "CANCEL_ONLY" }));
    const decision = staticBracketStrategy.onMarketClosing(
      context(cancelOnly, openState(), HELD_50),
      19,
    );
    expect(decision.reasonCodes).toContain(REASONS.finalCancelOnly);
    expect(reduceIntents(decision)).toHaveLength(0);
    expect(positionIntents(decision)).toHaveLength(0);
  });
});

describe("§13.4 — Resolution hold allowed and disallowed", () => {
  it("DISALLOWED: reduces at the exit cutoff rather than carrying into resolution", () => {
    const decision = staticBracketStrategy.onMarketClosing(
      context(params(), openState(), HELD_50),
      19,
    );
    expect(decision.reasonCodes).toContain(REASONS.resolutionHoldDisallowed);
    expect(reduceIntents(decision)).toHaveLength(1);
  });

  it("ALLOWED: holds to resolution and emits no position intent", () => {
    const holding = params(
      configWith({
        "exit.final_policy": "HOLD_TO_RESOLUTION",
        "exit.allow_resolution_hold": true,
      }),
    );
    const decision = staticBracketStrategy.onMarketClosing(
      context(holding, openState(), HELD_50),
      19,
    );
    expect(decision.decisionType).toBe("hold");
    expect(decision.reasonCodes).toContain(REASONS.finalHoldToResolution);
    expect(decision.reasonCodes).toContain(REASONS.resolutionHoldAllowed);
    expect(reduceIntents(decision)).toHaveLength(0);
    expect(positionIntents(decision)).toHaveLength(0);
  });

  it("records which case an open position at resolution was", () => {
    const disallowed = staticBracketStrategy.onMarketResolved(
      context(params(), openState(), HELD_50),
      { marketId: "018f4a7e-1111-7abc-8def-0123456789ab", outcome: "YES_WIN", resolvedAt: T_NOW } as never,
    );
    expect(disallowed.reasonCodes).toContain(REASONS.resolvedWhileOpen);
    expect(disallowed.reasonCodes).toContain(REASONS.resolutionHoldDisallowed);
    expect((disallowed.statePatch as Record<string, unknown>)["instanceState"]).toBe("CLOSED");

    const allowedParams = params(
      configWith({
        "exit.final_policy": "HOLD_TO_RESOLUTION",
        "exit.allow_resolution_hold": true,
      }),
    );
    const allowed = staticBracketStrategy.onMarketResolved(
      context(allowedParams, openState(), HELD_50),
      { marketId: "018f4a7e-1111-7abc-8def-0123456789ab", outcome: "NO_WIN", resolvedAt: T_NOW } as never,
    );
    expect(allowed.reasonCodes).toContain(REASONS.resolutionHoldAllowed);
  });
});

describe("§13.4 — YES/NO economic-leg comparison with and without inventory", () => {
  const preferring = () =>
    params(configWith({ "entry.economic_leg_policy": "PREFER_CHEAPEST_WITH_INVENTORY" }));

  it("WITHOUT inventory: takes the direct leg and says why the complement was unavailable", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(preferring(), ARMED, { noShares: "0" }),
    );
    expect(decision.decisionType).toBe("enter");
    expect(decision.reasonCodes).toContain(REASONS.entryLegComplementUnavailable);
    expect(decision.reasonCodes).toContain(REASONS.entryLegDirect);
    const intent = positionIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.direction).toBe("YES");
    expect(intent.targetShares).toBe("50");
  });

  it("WITH inventory: takes the cheaper complement leg by exact total cost", () => {
    // Selling 50 NO at 0.70 yields 35, so the equivalent cost of the YES
    // exposure is 50 - 35 = 15, against 17.5 for buying YES at 0.35.
    const decision = staticBracketStrategy.onFeatures(
      context(preferring(), ARMED, {
        noShares: "100",
        no: { bids: [["0.7", "2000"]], asks: [["0.72", "2000"]] },
      }),
    );
    expect(decision.decisionType).toBe("enter");
    expect(decision.reasonCodes).toContain(REASONS.entryLegComplement);
    const intent = positionIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.direction).toBe("NO");
    expect(intent.targetShares).toBe("-50");
    expect(intent.minimumSellPrice).toBe("0.65");
  });

  it("WITH inventory but a worse complement: still takes the direct leg", () => {
    // Selling 50 NO at 0.60 yields 30, an equivalent cost of 20 > 17.5.
    const decision = staticBracketStrategy.onFeatures(
      context(preferring(), ARMED, {
        noShares: "100",
        no: { bids: [["0.6", "2000"]], asks: [["0.62", "2000"]] },
      }),
    );
    expect(decision.reasonCodes).toContain(REASONS.entryLegDirect);
    const intent = positionIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.direction).toBe("YES");
  });

  it("DIRECT_ONLY never considers the complement, however much inventory exists", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), ARMED, {
        noShares: "100",
        no: { bids: [["0.9", "2000"]], asks: [["0.92", "2000"]] },
      }),
    );
    expect(decision.reasonCodes).toContain(REASONS.entryLegDirect);
    expect(decision.reasonCodes).not.toContain(REASONS.entryLegComplement);
    const intent = positionIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.direction).toBe("YES");
  });
});

describe("§13.4 — Fee-aware rejection when expected edge is insufficient", () => {
  it("refuses the entry when fees eat the expected edge", () => {
    const expensive = params(configWith({ "entry.economics.entry_fee_per_share": "0.2" }));
    const decision = staticBracketStrategy.onFeatures(context(expensive, ARMED, {}));
    expect(decision.decisionType).toBe("hold");
    expect(decision.reasonCodes).toContain(REASONS.refusedEdge);
    expect(intentsOf(decision)).toHaveLength(0);
    expect(decision.modelOutputs?.["expectedNetEdge"]).toBe("-2.55");
  });

  it("accepts at exactly the minimum edge and refuses one hundredth below it", () => {
    // Gross edge = 0.5*50 - 17.5 = 7.5; fees = (f + 0.001)*50.
    // f = 0.129 -> fees = 6.5 -> edge 1.0, exactly the configured minimum.
    const atMinimum = params(configWith({ "entry.economics.entry_fee_per_share": "0.129" }));
    const accepted = staticBracketStrategy.onFeatures(context(atMinimum, ARMED, {}));
    expect(accepted.decisionType).toBe("enter");
    expect(
      (positionIntents(accepted)[0] as Extract<Intent, { type: "POSITION" }>).expectedNetEdge,
    ).toBe("1");

    const belowMinimum = params(configWith({ "entry.economics.entry_fee_per_share": "0.1292" }));
    const refused = staticBracketStrategy.onFeatures(context(belowMinimum, ARMED, {}));
    expect(refused.decisionType).toBe("hold");
    expect(refused.reasonCodes).toContain(REASONS.refusedEdge);
  });
});

describe("§13.4 — Deterministic replay", () => {
  function sequence(options: { readonly reverseBuild: boolean }): string[] {
    // The same five evaluations, with the fixture objects constructed in
    // opposite orders, so any dependence on object identity or construction
    // order shows up as a byte difference.
    const build = (): { params: ReturnType<typeof params>; states: StaticBracketState[] } => {
      const built = params();
      const states = [
        stateWith({}),
        ARMED,
        openState(),
        openState({ instanceState: "PAUSED", resumeTo: "OPEN" }),
        stateWith({ instanceState: "CLOSED", closedAtMs: NOW_MS - 60_000, entriesExecuted: 1 }),
      ];
      return { params: built, states: options.reverseBuild ? [...states].reverse() : states };
    };
    const { params: built, states } = build();
    const ordered = options.reverseBuild ? [...states].reverse() : states;
    return ordered.map((state) =>
      canonicalJsonStringify(
        staticBracketStrategy.onFeatures(context(built, state, HELD_50)) as never,
      ),
    );
  }

  it("produces byte-identical decisions across construction orders", () => {
    expect(sequence({ reverseBuild: false })).toEqual(sequence({ reverseBuild: true }));
  });

  it("produces byte-identical decisions on repeated evaluation of the same input", () => {
    const first = canonicalJsonStringify(
      staticBracketStrategy.onFeatures(context(params(), ARMED, {})) as never,
    );
    const second = canonicalJsonStringify(
      staticBracketStrategy.onFeatures(context(params(), ARMED, {})) as never,
    );
    expect(second).toBe(first);
  });

  it("draws no randomness at all, so no seed can change a decision", () => {
    let draws = 0;
    const counting = context(params(), ARMED, {});
    const wrapped = {
      ...counting,
      rng: () => {
        draws += 1;
        return counting.rng();
      },
    };
    staticBracketStrategy.onFeatures(wrapped as never);
    expect(draws).toBe(0);
  });
});
