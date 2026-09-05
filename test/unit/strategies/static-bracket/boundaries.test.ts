/**
 * Totality of every reader this package exposes, and the one place it is
 * allowed to throw.
 *
 * A strategy callback that throws is contained by the runtime as a
 * RUNTIME-attributed skip that PAUSES the instance (ADR-005 §3). That is a
 * worse outcome than a recorded strategy refusal for every fault a strategy can
 * anticipate, so the bar this file holds the package to is: **no callback
 * throws for any view, payload, state or configuration a caller can supply** —
 * with exactly one deliberate exception, the missing feature-snapshot
 * reference, which is the runtime's own to refuse because a decision that
 * cannot name the snapshot it saw may not be persisted (§6 invariant 4).
 */

import { describe, expect, it } from "vitest";

import {
  INITIAL_STATE,
  formatInstantMs,
  parseInstantMs,
  readState,
  stateToPatch,
  staticBracketStrategy,
  walkForSize,
  observe,
  REASONS,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import type { Intent } from "../../../../packages/domain/src/index.js";
import type { StaticBracketState } from "../../../../packages/strategies/static-bracket/src/index.js";
import {
  context,
  parsedParams,
  protectedReductions,
  stateWith,
  T_NOW,
  type ViewOptions,
} from "./helpers.js";
import { staticBracketParamsSchema } from "../../../../packages/strategies/static-bracket/src/index.js";

const params = () => parsedParams(staticBracketParamsSchema);

/**
 * `Date.parse` is used ONCE, here, to derive a fixture constant from the fixed
 * instant printed in `helpers.ts` — never inside the strategy and never as a
 * clock (the same discipline `acceptance.test.ts` states).
 */
const NOW_MS = Date.parse(T_NOW);

describe("the state document reader is total", () => {
  it("reads an empty document as a fresh instance", () => {
    const read = readState({});
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual(INITIAL_STATE);
  });

  it("round-trips: patch -> read -> patch is a fixpoint", () => {
    const state = stateWith({
      instanceState: "PARTIALLY_OPEN",
      allocatedShares: "10",
      allocatedCost: "3.5",
      legOutcome: "YES",
      entriesExecuted: 1,
      openedAtMs: 5,
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
        placedAtMs: 1,
        escalated: true,
      },
    });
    const patch = stateToPatch(state);
    const read = readState(patch);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(stateToPatch(read.value)).toEqual(patch);
  });

  const refusals: { name: string; value: unknown; expected: RegExp }[] = [
    { name: "a non-object", value: 7, expected: /must be an object/u },
    { name: "an array", value: [], expected: /must be an object/u },
    {
      name: "an unknown key",
      value: { ...stateToPatch(INITIAL_STATE), rogue: 1 },
      expected: /not part of the static-bracket state document/u,
    },
    {
      name: "a foreign schema version",
      // Any version that is not this build's; the document's own is 2.
      value: { ...stateToPatch(INITIAL_STATE), schemaVersion: 3 },
      expected: /requires a new run for a state-schema change/u,
    },
    {
      name: "an unknown instance state",
      value: { ...stateToPatch(INITIAL_STATE), instanceState: "GOING_LONG" },
      expected: /not a §13.3 instance state/u,
    },
    {
      name: "a non-canonical allocation",
      value: { ...stateToPatch(INITIAL_STATE), allocatedShares: "10.0" },
      expected: /must be a canonical decimal string/u,
    },
    {
      name: "a negative counter",
      value: { ...stateToPatch(INITIAL_STATE), entriesExecuted: -1 },
      expected: /non-negative safe integer/u,
    },
    {
      name: "an order record with an unknown sub-state",
      value: {
        ...stateToPatch(INITIAL_STATE),
        entryOrder: {
          kind: "ENTRY",
          intentId: "i",
          orderId: null,
          state: "MAYBE",
          outcome: "YES",
          side: "BUY",
          limitPrice: "0.35",
          requestedShares: "50",
          filledShares: "0",
          viewFilledShares: "0",
          placedAtMs: 1,
          escalated: false,
        },
      },
      expected: /not a §13.3 working-order state/u,
    },
    {
      name: "an order record missing a field",
      value: { ...stateToPatch(INITIAL_STATE), entryOrder: { kind: "ENTRY" } },
      expected: /required and absent/u,
    },
  ];

  for (const testCase of refusals) {
    it(`refuses ${testCase.name}`, () => {
      const read = readState(testCase.value);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.problem).toMatch(testCase.expected);
    });
  }

  it("HALTS the instance rather than guessing when the state cannot be read", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), { schemaVersion: 99 }, {}),
    );
    expect(decision.reasonCodes).toContain(REASONS.stateUnreadable);
    expect(decision.reasonCodes).toContain(REASONS.halted);
    expect(decision.intents).toHaveLength(0);
    expect((decision.statePatch as Record<string, unknown>)["instanceState"]).toBe("HALTED");
  });

  it("holds and does nothing once halted", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), stateWith({ instanceState: "HALTED", haltReason: "x" }), {}),
    );
    expect(decision.decisionType).toBe("hold");
    expect(decision.intents).toHaveLength(0);
  });
});

describe("the timestamp reader is total and strict", () => {
  it("round-trips every instant it accepts", () => {
    for (const text of [
      "2026-03-04T12:05:00.000Z",
      "1999-12-31T23:59:59.999Z",
      "2000-02-29T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]) {
      const parsed = parseInstantMs(text, "t");
      expect(parsed.ok, text).toBe(true);
      if (!parsed.ok) continue;
      const formatted = formatInstantMs(parsed.value, "t");
      expect(formatted.ok).toBe(true);
      if (!formatted.ok) continue;
      expect(formatted.value).toBe(text);
    }
  });

  it("accepts the second-precision form and renders it with milliseconds", () => {
    const parsed = parseInstantMs("2026-03-04T12:05:00Z", "t");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toBe(1772625900000);
  });

  const rejected = [
    "2026-03-04T12:05:00+01:00",
    "2026-03-04T12:05:00",
    "2026-03-04T12:05:00.000000Z",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-03-04T24:00:00Z",
    "2026-03-04T12:60:00Z",
    "2026-03-04T12:05:60Z",
    "1500-03-04T12:05:00Z",
    "not a time",
    "",
  ];

  for (const text of rejected) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      const parsed = parseInstantMs(text, "t");
      expect(parsed.ok).toBe(false);
    });
  }

  it("refuses a non-string without throwing", () => {
    for (const value of [null, undefined, 0, {}, []]) {
      expect(parseInstantMs(value, "t").ok).toBe(false);
    }
  });

  it("refuses an instant it cannot render", () => {
    expect(formatInstantMs(Number.MAX_SAFE_INTEGER, "t").ok).toBe(false);
    expect(formatInstantMs(0.5, "t").ok).toBe(false);
  });
});

describe("the book walk refuses rather than answering partially", () => {
  it("reports the available size when the depth is insufficient", () => {
    const walk = walkForSize([{ price: "0.35", shares: "10" }], "50");
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.value.outcome).toBe("INSUFFICIENT_DEPTH");
    if (walk.value.outcome !== "INSUFFICIENT_DEPTH") return;
    expect(walk.value.availableShares).toBe("10");
  });

  it("consumes exactly the requested size across levels", () => {
    const walk = walkForSize(
      [
        { price: "0.3", shares: "20" },
        { price: "0.4", shares: "50" },
      ],
      "30",
    );
    expect(walk.ok).toBe(true);
    if (!walk.ok || walk.value.outcome !== "CONSUMED") return;
    expect(walk.value.totalMoney).toBe("10");
    expect(walk.value.worstPrice).toBe("0.4");
  });

  it("treats an empty side as insufficient, never as a free fill", () => {
    const walk = walkForSize([], "1");
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.value.outcome).toBe("INSUFFICIENT_DEPTH");
  });
});

describe("the view reader classifies faults by severity", () => {
  it("HALTS on an unreadable position view — an instance that cannot tell what it holds must not act", () => {
    const fault = observe(context(params(), INITIAL_STATE, { yesShares: "1.0" }));
    expect(fault.ok).toBe(false);
    if (fault.ok) return;
    expect(fault.fault.severity).toBe("HALT");
  });

  it("PAUSES on an unreadable book — §9.9's response to unusable market data", () => {
    const fault = observe(
      context(params(), INITIAL_STATE, { yes: { bids: [], asks: [["0.350", "10"]] } }),
    );
    expect(fault.ok).toBe(false);
    if (fault.ok) return;
    expect(fault.fault.severity).toBe("PAUSE");
  });

  it("PAUSES on an unparseable book timestamp", () => {
    const fault = observe(
      context(params(), INITIAL_STATE, {
        yes: { bids: [], asks: [], asOf: "2026-03-04T12:05:00+02:00" },
      }),
    );
    expect(fault.ok).toBe(false);
    if (fault.ok) return;
    expect(fault.fault.severity).toBe("PAUSE");
  });
});

describe("§6 invariant 12 — no blind flatten", () => {
  const open = stateWith({
    instanceState: "OPEN",
    allocatedShares: "50",
    allocatedCost: "17.5",
    legOutcome: "YES",
    entriesExecuted: 1,
  });

  it("refuses to reduce when the virtual position disagrees with the confirmed allocation", () => {
    for (const held of ["40", "60"]) {
      const decision = staticBracketStrategy.onFeatures(
        context(params(), open, {
          yesShares: held,
          features: { "polymarket.executable_sell_price@50": "0.2" },
        }),
      );
      // FORCING FINDING r2-B1: a protected reduction is now a tagged POSITION
      // delta, so filtering for `REDUCE_POSITION` would assert nothing.
      expect(protectedReductions(decision), `held ${held} must not be flattened`).toHaveLength(0);
      expect(decision.intents.filter((intent) => intent.type === "POSITION")).toHaveLength(0);
      expect(decision.reasonCodes).toContain(REASONS.positionMismatch);
      expect(decision.reasonCodes).toContain(REASONS.noBlindFlatten);
      expect((decision.statePatch as Record<string, unknown>)["instanceState"]).toBe("PAUSED");
    }
  });

  it("reduces once the position agrees exactly", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), open, {
        yesShares: "50",
        features: { "polymarket.executable_sell_price@50": "0.2" },
      }),
    );
    expect(protectedReductions(decision)).toHaveLength(1);
    // FORCING FINDING r2-B1(b): the reduction names this bracket's own leg and
    // exactly its confirmed open allocation, not a market-wide sell-down level.
    const reduction = protectedReductions(decision)[0] as Extract<Intent, { type: "POSITION" }>;
    expect(reduction.direction).toBe("YES");
    expect(reduction.targetShares).toBe("-50");
    expect(decision.intents.filter((intent) => intent.type === "REDUCE_POSITION")).toHaveLength(0);
  });

  it("pauses on a fill it cannot attribute to one of its own intents (§6 invariant 7)", () => {
    const decision = staticBracketStrategy.onFill(
      context(params(), open, { yesShares: "50" }),
      {
        orderId: "someone-elses-order",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "BUY",
        price: "0.35",
        shares: "5",
        filledAt: T_NOW,
      } as never,
    );
    expect(decision.reasonCodes).toContain(REASONS.unattributedFill);
    expect(decision.intents.filter((intent) => intent.type === "POSITION")).toHaveLength(0);
    expect((decision.statePatch as Record<string, unknown>)["allocatedShares"]).toBe("50");
  });
});

/**
 * A CONFIRMED FILL THAT ARRIVES WHILE THE INSTANCE IS PAUSED (r2-M1).
 *
 * §13.3 draws no fill edge out of `PAUSED`, so consulting the machine first
 * refused the fill and the instance carried on recording an allocation of zero
 * while it really held the position — §6 invariant 10 and §13.3 rule 1 both
 * violated, and the very next healthy evaluation would either wait forever for
 * a fill that had already arrived or re-arm and enter on top of the position.
 *
 * The fold is settlement accounting (§6 invariant 5), not a transition: it is
 * applied, and the instance stays exactly where it was.
 */
describe("a fill folds into the allocation even while PAUSED", () => {
  function pausedEntry(overrides: Partial<StaticBracketState> = {}): StaticBracketState {
    return stateWith({
      instanceState: "PAUSED",
      resumeTo: "ENTRY_WORKING",
      legOutcome: "YES",
      lastIncident: "stale book",
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
        placedAtMs: NOW_MS,
        escalated: true,
      },
      ...overrides,
    });
  }

  const entryFill = {
    orderId: "order-1",
    marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
    outcome: "YES",
    side: "BUY",
    price: "0.35",
    shares: "50",
    filledAt: T_NOW,
  };

  it("records the allocation, stays PAUSED, and emits nothing", () => {
    const decision = staticBracketStrategy.onFill(
      context(params(), pausedEntry(), { yesShares: "50" }),
      entryFill as never,
    );
    expect(decision.decisionType).toBe("hold");
    expect(decision.intents).toHaveLength(0);
    expect(decision.reasonCodes).toContain(REASONS.allocated);
    expect(decision.reasonCodes).toContain(REASONS.fillFoldedWhilePaused);
    expect(decision.reasonCodes).toContain(REASONS.paused);
    // The b17d461 route this replaced: an illegal transition read as a position
    // mismatch, which discarded the fill.
    expect(decision.reasonCodes).not.toContain(REASONS.illegalTransition);
    expect(decision.reasonCodes).not.toContain(REASONS.halted);

    const patch = decision.statePatch as Record<string, unknown>;
    expect(patch["instanceState"]).toBe("PAUSED");
    expect(patch["resumeTo"]).toBe("ENTRY_WORKING");
    expect(patch["allocatedShares"]).toBe("50");
    expect(patch["allocatedCost"]).toBe("17.5");
    expect(patch["legOutcome"]).toBe("YES");
    expect(patch["legBaselineShares"]).toBe("0");
    expect(patch["entriesExecuted"]).toBe(1);
  });

  it("and the exit that follows the resume is sized from the folded allocation", () => {
    const folded = staticBracketStrategy.onFill(
      context(params(), pausedEntry(), { yesShares: "50" }),
      entryFill as never,
    );
    const afterFold = folded.statePatch as unknown as StaticBracketState;

    // Data recovers. The instance resumes into ENTRY_WORKING, settles the
    // terminal entry order, and exits at the size the fold recorded.
    const resumed = staticBracketStrategy.onFeatures(
      context(params(), afterFold, { yesShares: "50" }),
    );
    expect(resumed.reasonCodes).toContain(REASONS.resumed);
    const afterResume = (resumed.statePatch ?? afterFold) as unknown as StaticBracketState;
    const exiting = staticBracketStrategy.onFeatures(
      context(params(), afterResume, { yesShares: "50" }),
    );
    const exit = [...exiting.intents, ...resumed.intents].filter(
      (intent) => intent.type === "POSITION",
    )[0] as Extract<Intent, { type: "POSITION" }>;
    expect(exit, "an exit is planned from the folded allocation").toBeDefined();
    expect(exit.direction).toBe("YES");
    expect(exit.targetShares).toBe("-50");
  });

  it("folds an EXIT fill too, without starting the cool-down clock early", () => {
    const paused = stateWith({
      instanceState: "PAUSED",
      resumeTo: "EXIT_WORKING",
      legOutcome: "YES",
      allocatedShares: "50",
      allocatedCost: "17.5",
      entriesExecuted: 1,
      openedAtMs: NOW_MS - 1000,
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
        placedAtMs: NOW_MS - 500,
        escalated: false,
      },
    });
    const decision = staticBracketStrategy.onFill(context(params(), paused, { yesShares: "0" }), {
      orderId: "order-2",
      marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
      outcome: "YES",
      side: "SELL",
      price: "0.5",
      shares: "50",
      filledAt: T_NOW,
    } as never);
    expect(decision.intents).toHaveLength(0);
    const patch = decision.statePatch as Record<string, unknown>;
    expect(patch["instanceState"]).toBe("PAUSED");
    expect(patch["exitedShares"]).toBe("50");
    // `closedAtMs` anchors the re-entry cool-down and belongs to the CLOSED
    // edge, which a paused instance has not taken.
    expect(patch["closedAtMs"]).toBeNull();
  });

  it("folds a COMPLEMENT-leg fill on both sides of the bracket", () => {
    const paused = pausedEntry({
      resumeTo: "ENTRY_WORKING",
      legOutcome: "NO",
      entryOrder: {
        kind: "ENTRY",
        intentId: "sb-entry-0",
        orderId: "order-1",
        state: "WORKING",
        outcome: "NO",
        side: "SELL",
        limitPrice: "0.65",
        requestedShares: "50",
        filledShares: "0",
        viewFilledShares: "0",
        placedAtMs: NOW_MS,
        escalated: true,
      },
    });
    const decision = staticBracketStrategy.onFill(
      context(params(), paused, { noShares: "50" }),
      {
        orderId: "order-1",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "NO",
        side: "SELL",
        price: "0.7",
        shares: "50",
        filledAt: T_NOW,
      } as never,
    );
    const patch = decision.statePatch as Record<string, unknown>;
    expect(patch["instanceState"]).toBe("PAUSED");
    expect(patch["allocatedShares"]).toBe("50");
    expect(patch["allocatedCost"]).toBe("35");
    expect(patch["legOutcome"]).toBe("NO");
    // A SELL entry recovers the baseline by ADDING the allocation back.
    expect(patch["legBaselineShares"]).toBe("100");
  });

  it("a HALTED instance still refuses the fill outright — that route stays closed", () => {
    const decision = staticBracketStrategy.onFill(
      context(params(), pausedEntry({ instanceState: "HALTED", haltReason: "x" }), {
        yesShares: "50",
      }),
      entryFill as never,
    );
    expect(decision.decisionType).toBe("hold");
    expect(decision.reasonCodes).toEqual([REASONS.halted]);
    expect(decision.intents).toHaveLength(0);
  });
});

/**
 * `planRearm` RESETS `legBaselineShares` (r2-L1).
 *
 * It is per-BRACKET state, and a second bracket that inherited the first one's
 * inventory baseline would measure its own exposure against a number that
 * belongs to a bracket that already closed. Deleting the field from the reset
 * list survived all 274 tests at 293a640; the persisted checkpoint is where the
 * stale value is observable (§6 invariant 8), so that is where it is pinned.
 */
describe("re-arming resets the per-bracket fields", () => {
  it("clears legBaselineShares in the persisted state document", () => {
    const closed = stateWith({
      instanceState: "CLOSED",
      closedAtMs: NOW_MS - 60_000,
      entriesExecuted: 0,
      allocatedShares: "50",
      allocatedCost: "35",
      exitedShares: "50",
      legOutcome: "NO",
      legBaselineShares: "100",
      openedAtMs: NOW_MS - 120_000,
    });
    const decision = staticBracketStrategy.onFeatures(
      context(params(), closed, { noShares: "100" }),
    );
    expect(decision.reasonCodes).toContain(REASONS.rearmed);
    const patch = decision.statePatch as Record<string, unknown>;
    expect(patch["instanceState"]).toBe("ARMED");
    // Every per-bracket field, so a deletion from the reset list dies here.
    expect(patch["legBaselineShares"]).toBe("0");
    expect(patch["allocatedShares"]).toBe("0");
    expect(patch["allocatedCost"]).toBe("0");
    expect(patch["exitedShares"]).toBe("0");
    expect(patch["legOutcome"]).toBeNull();
    expect(patch["openedAtMs"]).toBeNull();
    expect(patch["entryOrder"]).toBeNull();
    expect(patch["exitOrder"]).toBeNull();
    // And what is per-MARKET is carried, not reset.
    expect(patch["entriesExecuted"]).toBe(0);
    expect(patch["closedAtMs"]).toBe(NOW_MS - 60_000);
  });
});

describe("no callback throws for a caller-supplied value", () => {
  const hostileViews: ViewOptions[] = [
    { yesShares: "1.0" },
    { yes: { bids: [["x", "1"]], asks: [] } },
    { features: { "polymarket.executable_buy_price@50": true as never } },
    { tickSize: "0" },
    { minimumOrderSize: "abc" },
    { closeTime: "yesterday" },
    { orders: [{ orderId: "" } as never] },
  ];

  for (const view of hostileViews) {
    it(`survives ${JSON.stringify(view)} on every callback`, () => {
      const state = stateWith({ instanceState: "ARMED" });
      const ctx = context(params(), state, view);
      const calls: (() => unknown)[] = [
        () => staticBracketStrategy.onStart(ctx),
        () => staticBracketStrategy.onMarketOpen(ctx),
        () => staticBracketStrategy.onFeatures(ctx),
        () => staticBracketStrategy.onTimer(ctx),
        () => staticBracketStrategy.onFill(ctx, { orderId: "x" } as never),
        () => staticBracketStrategy.onOrderUpdate(ctx, { orderId: "x" } as never),
        () => staticBracketStrategy.onMarketClosing(ctx, 30),
        () => staticBracketStrategy.onMarketResolved(ctx, { outcome: "YES_WIN" } as never),
        () => staticBracketStrategy.onStop(ctx, "stop"),
      ];
      for (const call of calls) {
        expect(call).not.toThrow();
        const decision = call() as { featureSnapshotRef: string; intents: unknown[] };
        expect(decision.featureSnapshotRef).toBe("snapshot-1");
        expect(Array.isArray(decision.intents)).toBe(true);
      }
    });
  }

  it("survives hostile payloads on the payload-taking callbacks", () => {
    const ctx = context(params(), stateWith({ instanceState: "ARMED" }), {});
    for (const payload of [null, undefined, 0, "x", [], { orderId: 1 }]) {
      expect(() => staticBracketStrategy.onFill(ctx, payload as never)).not.toThrow();
      expect(() => staticBracketStrategy.onOrderUpdate(ctx, payload as never)).not.toThrow();
      expect(() => staticBracketStrategy.onMarketResolved(ctx, payload as never)).not.toThrow();
      expect(() => staticBracketStrategy.onStop(ctx, payload as never)).not.toThrow();
    }
    for (const seconds of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => staticBracketStrategy.onMarketClosing(ctx, seconds)).not.toThrow();
    }
  });

  it("refuses params it cannot read, as a recorded decision rather than a throw", () => {
    const decision = staticBracketStrategy.onFeatures(
      context({ strategy: "static-bracket" }, INITIAL_STATE, {}),
    );
    expect(decision.decisionType).toBe("skip");
    expect(decision.reasonCodes).toContain(REASONS.paramsUnreadable);
  });

  it("throws ONLY when the snapshot reference is unusable — the runtime's own case", () => {
    const ctx = context(params(), INITIAL_STATE, {});
    const broken = {
      ...ctx,
      features: () => ({ asOf: T_NOW, values: {} }) as never,
    };
    expect(() => staticBracketStrategy.onFeatures(broken as never)).toThrow(/snapshotRef/u);
  });
});
