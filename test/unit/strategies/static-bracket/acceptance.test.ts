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
  protectedReductions,
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

/**
 * The protected reductions of a decision.
 *
 * FORCING FINDING r2-B1: this used to filter for `type === "REDUCE_POSITION"`.
 * That intent's `targetShares` is a per-side sell-down level for the whole
 * market, so the merged planner turned a complement-leg reduction into a SELL
 * of the token the bracket is already short and sold untraded-side inventory on
 * either leg. Every exit is now a `POSITION` delta; a protected reduction is
 * identified by its `sb.protected-reduce` tag, which keeps both the positive
 * and the NEGATIVE assertions below meaningful.
 */
function reduceIntents(decision: DecisionResult): readonly Intent[] {
  return protectedReductions(decision);
}

/** Emitting a §7.7 `REDUCE_POSITION` at all is now the regression (r2-B1). */
function rawReduceIntents(decision: DecisionResult): Intent[] {
  return [...decision.intents].filter((intent) => intent.type === "REDUCE_POSITION");
}

function cancelIntents(decision: DecisionResult): Intent[] {
  return [...decision.intents].filter((intent) => intent.type === "CANCEL");
}

const ARMED = stateWith({ instanceState: "ARMED" });

/**
 * THE EXPOSURE INVARIANT, checked on an emitted exit against the bracket it
 * belongs to: the exit must trade the OPPOSITE way to the entry, on the SAME
 * leg, and may never name more than the confirmed open allocation.
 *
 * FORCING FINDING r2-B1(d): it used to be applied to the take-profit only —
 * the shape whose delta it could read. The protected reduction was a
 * `REDUCE_POSITION`, which has no direction and no delta, so the one exit that
 * fires under duress was outside the invariant. Every exit now carries a
 * direction and a signed delta, so every exit is inside it.
 */
function assertReducesExposure(
  intent: Intent,
  entry: { readonly direction: "YES" | "NO"; readonly targetShares: string },
  open: string,
): void {
  expect(intent.type, "an exit is a POSITION delta, never a market-scoped reduction").toBe(
    "POSITION",
  );
  const position = intent as Extract<Intent, { type: "POSITION" }>;
  expect(position.direction, "an exit trades the leg the entry established").toBe(entry.direction);
  expect(position.targetMode).toBe("DELTA");
  const entrySign = entry.targetShares.startsWith("-") ? -1 : 1;
  const exitSign = position.targetShares.startsWith("-") ? -1 : 1;
  expect(exitSign, "an exit must trade the opposite way to its entry").toBe(-entrySign);
  const magnitude = position.targetShares.replace("-", "");
  expect(Number(magnitude), "an exit may never exceed the confirmed open allocation").toBeLessThanOrEqual(
    Number(open),
  );
  // A SELL exit is bounded below and a BUY exit above; never both, never neither.
  const floors = [position.minimumSellPrice, position.maximumBuyPrice].filter(
    (bound) => bound !== undefined,
  );
  expect(floors, "an exit always carries exactly one price bound").toHaveLength(1);
  expect(exitSign === -1 ? position.minimumSellPrice : position.maximumBuyPrice).toBeDefined();
}

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
        viewFilledShares: "0",
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
        viewFilledShares: "0",
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
      viewFilledShares: "0",
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
        viewFilledShares: "10",
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
        viewFilledShares: "0",
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
      viewFilledShares: "0",
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
    // FORCING FINDING r2-B1(b)/(d): the reduction names THIS bracket's leg and
    // exactly its confirmed open allocation as a signed delta. The former
    // `REDUCE_POSITION { targetShares: "0" }` named a sell-down level for every
    // side of the market, so it also sold inventory the bracket never created —
    // `planner-shapes.test.ts` drives both shapes through the real planner.
    const intent = intents[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.direction).toBe("YES");
    expect(intent.targetMode).toBe("DELTA");
    expect(intent.targetShares).toBe("-50");
    expect(intent.minimumSellPrice).toBe("0.26");
    expect(intent.maximumBuyPrice).toBeUndefined();
    // §7.7's ReductionUrgency is a subset of PositionUrgency: carried verbatim.
    expect(intent.urgency).toBe("AGGRESSIVE");
    // The posture mapping that reproduces `reductionPosture` exactly (§9.10).
    expect(intent.liquidityPreference).toBe("TAKER_OK");
    expect(intent.partialFillPolicy).toBe("ACCEPT_ANY");
    // No §7.7 REDUCE_POSITION is emitted on any path any more.
    expect(rawReduceIntents(decision)).toHaveLength(0);
  });

  it("does not stop one tick above the stop threshold", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openState(), { ...HELD_50, features: { [STOP_KEY]: "0.28" } }),
    );
    expect(reduceIntents(decision)).toHaveLength(0);
  });

  it("EVERY exit path on a DIRECT bracket satisfies the exposure invariant", () => {
    // FORCING FINDING r2-B1(d), the direct-leg half. The entry is replayed so
    // the invariant compares two real intents.
    const entry = positionIntents(
      staticBracketStrategy.onFeatures(context(params(), ARMED, {})),
    )[0] as Extract<Intent, { type: "POSITION" }>;
    const exits: readonly [string, DecisionResult][] = [
      ["take-profit", staticBracketStrategy.onFeatures(context(params(), openState(), HELD_50))],
      [
        "stop",
        staticBracketStrategy.onFeatures(
          context(params(), openState(), { ...HELD_50, features: { [STOP_KEY]: "0.2" } }),
        ),
      ],
      [
        "holding timeout",
        staticBracketStrategy.onTimer(
          context(params(), openState({ openedAtMs: NOW_MS - 200_000 }), HELD_50),
        ),
      ],
      [
        "final policy",
        staticBracketStrategy.onMarketClosing(context(params(), openState(), HELD_50), 19),
      ],
    ];
    for (const [name, decision] of exits) {
      const emitted = positionIntents(decision);
      expect(emitted, `${name} emits exactly one exit`).toHaveLength(1);
      expect(rawReduceIntents(decision), `${name} emits no market-scoped reduction`).toHaveLength(0);
      assertReducesExposure(emitted[0] as Intent, entry, "50");
    }
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
        viewFilledShares: "0",
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

/**
 * A COMPLEMENT-LEG BRACKET, END TO END.
 *
 * §13.4's leg-comparison bullet is about ENTRY, and the entry was right. What
 * had never been driven was the rest of the bracket: a complement-leg entry
 * establishes YES exposure by SELLING the NO token, so every exit must BUY THAT
 * TOKEN BACK at the complement of the configured, direction-denominated price.
 * Emitting the configured price on the configured side sells more of a token the
 * instance is already short — a second entry at double the size, logged as an
 * exit.
 *
 * Each step asserts the SIDE and the COMPLEMENTED PRICE, and the whole sequence
 * is checked against the invariant that binds them: AN EXIT MAY NEVER INCREASE
 * ABSOLUTE EXPOSURE.
 */
describe("complement-leg bracket — every exit is a buy-back at the complemented price", () => {
  const preferring = () =>
    params(configWith({ "entry.economic_leg_policy": "PREFER_CHEAPEST_WITH_INVENTORY" }));

  /** NO bids at 0.70: selling 50 yields 35, an equivalent cost of 15 < 17.5. */
  const CHEAP_NO: ViewOptions = {
    noShares: "100",
    no: { bids: [["0.7", "2000"]], asks: [["0.72", "2000"]] },
  };

  /** After the entry filled: 50 of the 100 NO have been sold. */
  const AFTER_ENTRY: ViewOptions = { ...CHEAP_NO, noShares: "50" };

  const complementFill = {
    orderId: "order-1",
    marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
    outcome: "NO",
    side: "SELL",
    price: "0.7",
    shares: "50",
    filledAt: T_NOW,
  };

  /** An OPEN complement bracket, as the fill fold leaves it. */
  function openComplement(overrides: Partial<StaticBracketState> = {}): StaticBracketState {
    return stateWith({
      instanceState: "OPEN",
      allocatedShares: "50",
      allocatedCost: "35",
      exitedShares: "0",
      legOutcome: "NO",
      legBaselineShares: "100",
      entriesExecuted: 1,
      openedAtMs: NOW_MS - 1000,
      ...overrides,
    });
  }

  it("ENTRY sells the complement token at the complemented buy limit", () => {
    const decision = staticBracketStrategy.onFeatures(context(preferring(), ARMED, CHEAP_NO));
    const intent = positionIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(intent.direction).toBe("NO");
    expect(intent.targetShares).toBe("-50");
    // complement(maximum_buy_price 0.35) = 0.65.
    expect(intent.minimumSellPrice).toBe("0.65");
    expect(intent.maximumBuyPrice).toBeUndefined();
  });

  it("TAKE-PROFIT buys the same token back at complement(take_profit.price)", () => {
    const entry = staticBracketStrategy.onFeatures(context(preferring(), ARMED, CHEAP_NO));
    const entryIntent = positionIntents(entry)[0] as Extract<Intent, { type: "POSITION" }>;

    const filled = staticBracketStrategy.onFill(
      context(preferring(), entry.statePatch as unknown as StaticBracketState, AFTER_ENTRY),
      complementFill as never,
    );
    expect(filled.decisionType).toBe("exit");
    expect(filled.reasonCodes).toContain(REASONS.takeProfitPlaced);
    expect(filled.reasonCodes).toContain(REASONS.exitProportional);

    const exit = positionIntents(filled)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(exit.direction).toBe("NO");
    // BUY side, positive DELTA, priced at 1 - 0.50.
    expect(exit.targetShares).toBe("50");
    expect(exit.maximumBuyPrice).toBe("0.5");
    expect(exit.minimumSellPrice).toBeUndefined();
    expect(filled.modelOutputs?.["exitSide"]).toBe("BUY");
    assertReducesExposure(exit, entryIntent, "50");

    // The baseline the exit gates are measured against is the inventory this
    // bracket started from, not the raw holding.
    const patch = filled.statePatch as Record<string, unknown>;
    expect(patch["legBaselineShares"]).toBe("100");
    expect(patch["allocatedShares"]).toBe("50");
  });

  it("STOP reduces with a complemented FLOOR carried as a maximum buy price", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(preferring(), openComplement(), {
        ...AFTER_ENTRY,
        features: { [STOP_KEY]: "0.2" },
      }),
    );
    expect(decision.decisionType).toBe("reduce");
    expect(decision.reasonCodes).toContain(REASONS.stopTriggered);
    const reduce = reduceIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    // FORCING FINDING r2-B1(a): a `REDUCE_POSITION` here was planned as a SELL
    // of 50 NO — the token this bracket is already short — because the planner's
    // reduce path only sells and never reads `maximumBuyPrice`. The buy-back is
    // a POSITIVE delta on the NO leg at complement(0.26) = 0.74.
    expect(reduce.direction).toBe("NO");
    expect(reduce.targetMode).toBe("DELTA");
    expect(reduce.targetShares).toBe("50");
    expect(reduce.maximumBuyPrice).toBe("0.74");
    expect(reduce.minimumSellPrice).toBeUndefined();
    expect(reduce.urgency).toBe("AGGRESSIVE");
    expect(reduce.liquidityPreference).toBe("TAKER_OK");
    expect(reduce.partialFillPolicy).toBe("ACCEPT_ANY");
    expect(rawReduceIntents(decision)).toHaveLength(0);
    expect(decision.modelOutputs?.["exitSide"]).toBe("BUY");
    expect(decision.modelOutputs?.["floor"]).toBe("0.74");
    // The free-text `reason` a REDUCE_POSITION carried has no counterpart on a
    // PositionIntent; the cause survives as a reason code and a model output.
    expect(decision.modelOutputs?.["reduceCause"]).toBe("stop trigger");
  });

  it("END-OF-MARKET protected reduce uses the same complemented floor", () => {
    const decision = staticBracketStrategy.onMarketClosing(
      context(preferring(), openComplement(), AFTER_ENTRY),
      19,
    );
    expect(decision.decisionType).toBe("reduce");
    const reduce = reduceIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(reduce.direction).toBe("NO");
    expect(reduce.targetShares).toBe("50");
    expect(reduce.maximumBuyPrice).toBe("0.74");
    expect(reduce.minimumSellPrice).toBeUndefined();
    expect(rawReduceIntents(decision)).toHaveLength(0);
  });

  it("HOLDING TIMEOUT on a complement bracket is a buy-back too", () => {
    const decision = staticBracketStrategy.onTimer(
      context(preferring(), openComplement({ openedAtMs: NOW_MS - 200_000 }), AFTER_ENTRY),
    );
    expect(decision.reasonCodes).toContain(REASONS.holdingTimeout);
    const reduce = reduceIntents(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(reduce.direction).toBe("NO");
    expect(reduce.targetShares).toBe("50");
    expect(reduce.maximumBuyPrice).toBe("0.74");
    expect(rawReduceIntents(decision)).toHaveLength(0);
  });

  it("EVERY exit path on this bracket satisfies the exposure invariant", () => {
    // FORCING FINDING r2-B1(d). The entry that opened this bracket, replayed so
    // the invariant is checked against a real entry rather than a literal.
    const entry = positionIntents(
      staticBracketStrategy.onFeatures(context(preferring(), ARMED, CHEAP_NO)),
    )[0] as Extract<Intent, { type: "POSITION" }>;

    const exits: readonly [string, DecisionResult][] = [
      [
        "take-profit",
        staticBracketStrategy.onFeatures(context(preferring(), openComplement(), AFTER_ENTRY)),
      ],
      [
        "stop",
        staticBracketStrategy.onFeatures(
          context(preferring(), openComplement(), {
            ...AFTER_ENTRY,
            features: { [STOP_KEY]: "0.2" },
          }),
        ),
      ],
      [
        "holding timeout",
        staticBracketStrategy.onTimer(
          context(preferring(), openComplement({ openedAtMs: NOW_MS - 200_000 }), AFTER_ENTRY),
        ),
      ],
      [
        "final policy",
        staticBracketStrategy.onMarketClosing(
          context(preferring(), openComplement(), AFTER_ENTRY),
          19,
        ),
      ],
    ];
    for (const [name, decision] of exits) {
      const emitted = positionIntents(decision);
      expect(emitted, `${name} emits exactly one exit`).toHaveLength(1);
      expect(rawReduceIntents(decision), `${name} emits no market-scoped reduction`).toHaveLength(0);
      assertReducesExposure(emitted[0] as Intent, entry, "50");
    }
  });

  it("the buy-back CLOSES the bracket when it fills", () => {
    const state = openComplement({
      instanceState: "EXIT_WORKING",
      exitOrder: {
        kind: "EXIT",
        intentId: "sb-take-profit-1",
        orderId: "order-2",
        state: "WORKING",
        outcome: "NO",
        side: "BUY",
        limitPrice: "0.5",
        requestedShares: "50",
        filledShares: "0",
        viewFilledShares: "0",
        placedAtMs: NOW_MS - 500,
        escalated: false,
      },
    });
    const decision = staticBracketStrategy.onFill(
      context(preferring(), state, { ...CHEAP_NO, noShares: "100" }),
      {
        orderId: "order-2",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "NO",
        side: "BUY",
        price: "0.5",
        shares: "50",
        filledAt: T_NOW,
      } as never,
    );
    expect(decision.reasonCodes).toContain(REASONS.exitFilled);
    expect(decision.reasonCodes).toContain(REASONS.closed);
    const patch = decision.statePatch as Record<string, unknown>;
    expect(patch["instanceState"]).toBe("CLOSED");
    expect(patch["exitedShares"]).toBe("50");
  });

  it("REFUSES the exit when the view says the short does not exist (§6 invariant 12)", () => {
    // The bracket believes it sold 50 NO out of 100, so it expects to see 50.
    // A view showing the full 100 means nothing was ever sold: an exit here
    // would BUY 50 more NO, taking the instance long on a bracket it never
    // opened. That is the case the raw-holding gate could not see, because 100
    // is comfortably "at least" the 50 the exit names.
    const decision = staticBracketStrategy.onFeatures(
      context(preferring(), openComplement(), { ...CHEAP_NO, noShares: "100" }),
    );
    expect(decision.reasonCodes).toContain(REASONS.positionMismatch);
    expect(decision.reasonCodes).toContain(REASONS.noBlindFlatten);
    expect(positionIntents(decision)).toHaveLength(0);
    expect(reduceIntents(decision)).toHaveLength(0);
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
  /** A deep copy of a plain tree with every object's KEYS inserted in reverse. */
  function reverseKeys<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((element: unknown) => reverseKeys(element)) as unknown as T;
    }
    if (typeof value === "object" && value !== null) {
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
        copy[key] = reverseKeys((value as Record<string, unknown>)[key]);
      }
      return copy as T;
    }
    return value;
  }

  const makeStates: readonly (() => StaticBracketState)[] = [
    () => stateWith({}),
    () => ARMED,
    () => openState(),
    () => openState({ instanceState: "PAUSED", resumeTo: "OPEN" }),
    () =>
      stateWith({ instanceState: "CLOSED", closedAtMs: NOW_MS - 60_000, entriesExecuted: 1 }),
  ];

  function sequence(options: { readonly reverseBuild: boolean }): string[] {
    // The same five evaluations. Under `reverseBuild` the fixture objects are
    // genuinely CONSTRUCTED in the opposite order and the configuration tree is
    // built with every object's keys inserted in the opposite order, while the
    // sequence that is EVALUATED stays canonical. Any dependence on allocation
    // order, object identity or key insertion order shows up as a byte
    // difference.
    //
    // (The pre-remediation version reversed the array and then reversed it
    // again, so both branches built and evaluated the identical list and the
    // assertion had no content.)
    const built = params(options.reverseBuild ? reverseKeys(baseConfig()) : baseConfig());
    const states: StaticBracketState[] = [];
    const indices = makeStates.map((_, index) => index);
    for (const index of options.reverseBuild ? [...indices].reverse() : indices) {
      states[index] = (makeStates[index] as () => StaticBracketState)();
    }
    return states.map((state) =>
      canonicalJsonStringify(
        staticBracketStrategy.onFeatures(context(built, state, HELD_50)) as never,
      ),
    );
  }

  it("the two construction orders really do differ, so the comparison has content", () => {
    // Discrimination check: the reversed fixture is a DIFFERENT object by any
    // key-order-sensitive measure, and the same one only under a canonical
    // serializer. Without this, "byte-identical" could be true vacuously.
    const forward = baseConfig();
    const reversed = reverseKeys(baseConfig());
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(forward));
    expect(canonicalJsonStringify(reversed as never)).toBe(
      canonicalJsonStringify(forward as never),
    );
  });

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
