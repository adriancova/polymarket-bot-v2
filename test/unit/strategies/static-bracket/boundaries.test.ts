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
import { context, parsedParams, stateWith, T_NOW, type ViewOptions } from "./helpers.js";
import { staticBracketParamsSchema } from "../../../../packages/strategies/static-bracket/src/index.js";

const params = () => parsedParams(staticBracketParamsSchema);

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
      value: { ...stateToPatch(INITIAL_STATE), schemaVersion: 2 },
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
      expect(
        decision.intents.filter((intent) => intent.type === "REDUCE_POSITION"),
        `held ${held} must not be flattened`,
      ).toHaveLength(0);
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
    expect(decision.intents.some((intent) => intent.type === "REDUCE_POSITION")).toBe(true);
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
