/**
 * §7.6 `StrategyContext`: "No context method performs network or database I/O.
 * The runtime constructs the context from current in-memory state."
 *
 * What is pinned here is the part a strategy can actually observe:
 *
 * - **Read-only views.** Every view the context hands out is deep-frozen, so a
 *   strategy cannot mutate the book, the feature snapshot, its position, its
 *   orders, or its own state in place. Mutation is not merely discouraged; in
 *   an ES module (always strict mode) it throws.
 * - **No ambient clock.** `now()` returns the injected logical evaluation
 *   timestamp — the same value the persisted record carries — and nothing else
 *   in the context exposes time (§6 invariant 2, F11).
 * - **No ambient randomness.** `rng()` is a draw-only facade over the
 *   runtime-owned generator: a strategy can consume the sequence but cannot
 *   snapshot, restore, or replant it, so it cannot rewind its way out of a
 *   deterministic replay.
 * - **The surface is exactly §7.6.** No extra method smuggles in a capability.
 */

import { describe, expect, it } from "vitest";

import type { StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import type { DecisionResult } from "../../../packages/strategy-sdk/src/index.js";
import { holdDecision, makeHarness, makeInput, makeStrategy, T0 } from "./helpers.js";

/** Runs one evaluation and hands the test whatever the callback observed. */
function observe<T>(observer: (ctx: StrategyContext) => T): T {
  let seen: T | undefined;
  let ran = false;
  const { runtime } = makeHarness({
    strategy: makeStrategy({
      onFeatures: (ctx: StrategyContext): DecisionResult => {
        seen = observer(ctx);
        ran = true;
        return holdDecision(ctx);
      },
    }),
  });
  const outcome = runtime.evaluate(makeInput("onFeatures"));
  if (outcome.kind !== "DECIDED") {
    throw new Error(`expected DECIDED, got ${outcome.kind}`);
  }
  if (!ran) {
    throw new Error("callback did not run");
  }
  return seen as T;
}

describe("StrategyContext: read-only views, injected time, seeded randomness only", () => {
  it("exposes exactly the §7.6 surface — no extra method", () => {
    const keys = observe((ctx) => Object.keys(ctx).sort());
    expect(keys).toEqual([
      "book",
      "features",
      "market",
      "now",
      "orders",
      "params",
      "position",
      "riskBudget",
      "rng",
      "state",
    ]);
  });

  it("the context object itself is frozen — a strategy cannot swap a method out", () => {
    const frozen = observe((ctx) => Object.isFrozen(ctx));
    expect(frozen).toBe(true);
  });

  it("now() returns the INJECTED logical timestamp, not a wall clock", () => {
    const now = observe((ctx) => ctx.now());
    expect(now).toBe(T0);
    // Same evaluation, called twice: identical. A wall clock would drift.
    const twice = observe((ctx) => [ctx.now(), ctx.now()]);
    expect(twice[0]).toBe(twice[1]);
    expect(twice[0]).toBe(T0);
  });

  it("every view is deep-frozen and a mutation attempt THROWS (ES module strict mode)", () => {
    const results = observe((ctx) => {
      const attempts: Record<string, boolean> = {};
      const record = (name: string, mutate: () => void): void => {
        try {
          mutate();
          attempts[name] = false;
        } catch (cause) {
          attempts[name] = cause instanceof TypeError;
        }
      };
      record("market", () => {
        (ctx.market() as { tickSize: string }).tickSize = "0.5";
      });
      record("bookLevel", () => {
        (ctx.book("YES").bids[0] as { price: string }).price = "0.99";
      });
      record("bookArray", () => {
        (ctx.book("YES").bids as unknown as { push(value: unknown): void }).push({
          price: "0.1",
          shares: "1",
        });
      });
      record("features", () => {
        (ctx.features().values as Record<string, string>)["midpoint"] = "0.99";
      });
      record("position", () => {
        (ctx.position() as { yesShares: string }).yesShares = "1000";
      });
      record("orders", () => {
        (ctx.orders() as unknown as { push(value: unknown): void }).push({});
      });
      record("riskBudget", () => {
        (ctx.riskBudget() as { availableCollateral: string }).availableCollateral = "1000000";
      });
      record("state", () => {
        (ctx.state<Record<string, unknown>>() as Record<string, unknown>)["injected"] = true;
      });
      return attempts;
    });
    for (const [name, threw] of Object.entries(results)) {
      expect(threw, `mutating ${name} must throw`).toBe(true);
    }
  });

  it("book(outcome) selects the requested outcome's book", () => {
    const [yesBid, noBid] = observe((ctx) => [
      ctx.book("YES").bids[0]?.price,
      ctx.book("NO").bids[0]?.price,
    ]);
    expect(yesBid).toBe("0.4");
    expect(noBid).toBe("0.39");
  });

  it("rng() is DRAW-ONLY: no snapshot, restore, or seed is reachable from a strategy", () => {
    const surface = observe((ctx) => ({
      keys: Object.keys(ctx.rng()).sort(),
      frozen: Object.isFrozen(ctx.rng()),
      hasSnapshot: "snapshot" in ctx.rng(),
      hasRestore: "restore" in ctx.rng(),
    }));
    expect(surface.keys).toEqual(["nextFloat53", "nextIntBelow", "nextUint32"]);
    expect(surface.frozen).toBe(true);
    expect(surface.hasSnapshot).toBe(false);
    expect(surface.hasRestore).toBe(false);
  });

  it("rng draws advance within an evaluation and CARRY OVER to the next one", () => {
    const draws: number[] = [];
    const { runtime } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext) => {
          draws.push(ctx.rng().nextUint32(), ctx.rng().nextUint32());
          return holdDecision(ctx);
        },
      }),
    });
    expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(new Set(draws).size).toBe(4);
  });

  it("state() reflects the accumulated statePatch fold, and only after the decision is persisted", () => {
    const seen: Array<Record<string, unknown>> = [];
    const { runtime } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          const state = ctx.state<{ count?: number }>();
          seen.push({ ...state });
          return {
            decisionType: "hold",
            reasonCodes: ["TEST.HOLD"],
            featureSnapshotRef: ctx.features().snapshotRef,
            statePatch: { count: (state.count ?? 0) + 1 },
            intents: [],
          };
        },
      }),
    });
    for (let index = 0; index < 3; index += 1) {
      expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    }
    expect(seen).toEqual([{}, { count: 1 }, { count: 2 }]);
  });

  it("params() and state() return the same frozen objects on repeated calls (no per-call copying)", () => {
    const identical = observe((ctx) => ({
      params: ctx.params<object>() === ctx.params<object>(),
      state: ctx.state<object>() === ctx.state<object>(),
      market: ctx.market() === ctx.market(),
    }));
    expect(identical).toEqual({ params: true, state: true, market: true });
  });
});
