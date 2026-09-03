/**
 * Regression suite for review round 3's HIGH finding (remediation round 3,
 * 2026-09-03): the evaluation INPUT views were deep-frozen but not
 * materialized, so a live accessor or `Proxy` survived into — and past — the
 * callback.
 *
 * Freezing makes properties non-configurable. It does NOT make a getter or a
 * Proxy trap inert. The runtime validated the caller's live object, froze it,
 * handed it to the strategy, and then RE-READ it to build the persisted record.
 * The reviewer's two reproductions, verbatim against the round-2 code:
 *
 * ```
 * outcome=THREW:POST_CALLBACK_MARKET_ID_GET
 * invoked=1  persist=0  checkpoints=0  evaluationSeq=0  status=ACTIVE
 * ```
 *
 * ```
 * outcome=DECIDED
 * callbackSaw=018f4a7e-1111-7abc-8def-0123456789ab
 * recorded=018f4a7e-2222-7abc-8def-0123456789ab
 * frozen=true
 * ```
 *
 * The first: a market view whose third `marketId` read threw made `evaluate()`
 * throw AFTER the callback had run — the RNG had advanced, no record and no
 * checkpoint represented the evaluation, and sequence 0 was still unconsumed
 * (acceptance 1 and 3, both failing). The second is worse because it is silent:
 * the callback decided about market A and the durable record named market B.
 *
 * The fix is the same shape as round 2's, applied one boundary earlier:
 * `acquireEvaluationInput` materializes ONE inert, deep-frozen snapshot before
 * anything is validated or invoked, and validation, the context, the callback,
 * the record and the checkpoint all read that snapshot. A larger `try`/`catch`
 * would have contained the first reproduction and left the second silent.
 */

import { describe, expect, it } from "vitest";

import type {
  EvaluationInput,
  EvaluationOutcome,
} from "../../../packages/strategy-runtime/src/index.js";
import { validateEvaluationInput } from "../../../packages/strategy-runtime/src/index.js";
import type { DecisionResult, StrategyContext } from "../../../packages/strategy-sdk/src/index.js";
import { holdDecision, makeHarness, makeInput, makeStrategy, MARKET_ID } from "./helpers.js";

const MARKET_B = "018f4a7e-2222-7abc-8def-0123456789ab";

function marketTarget(): Record<string, unknown> {
  return {
    marketId: MARKET_ID,
    conditionId: "0xcondition",
    yesTokenId: "123",
    noTokenId: "456",
    tickSize: "0.01",
    minimumOrderSize: "5",
  };
}

/** A strategy that reports what it saw through the context. */
function observingStrategy(seen: { marketId?: string }) {
  return makeStrategy({
    onFeatures: (ctx: StrategyContext): DecisionResult => {
      seen.marketId = ctx.market().marketId;
      return holdDecision(ctx);
    },
  });
}

describe("the evaluation input is materialized once, not merely frozen", () => {
  it("the reviewer's transcript 1: a Proxy that turns hostile on its third read cannot throw out of evaluate()", () => {
    let reads = 0;
    const target = marketTarget();
    const proxy = new Proxy(target, {
      get(t, key, receiver): unknown {
        if (key === "marketId") {
          reads += 1;
          if (reads >= 3) {
            throw new Error("POST_CALLBACK_MARKET_ID_GET");
          }
        }
        return Reflect.get(t, key, receiver);
      },
    });
    const seen: { marketId?: string } = {};
    const harness = makeHarness({ strategy: observingStrategy(seen) });

    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(
        makeInput("onFeatures", { market: proxy }) as EvaluationInput,
      );
    }).not.toThrow();

    // `invoked=1 persist=0 checkpoints=0 evaluationSeq=0` was the finding.
    expect(outcome?.kind).toBe("DECIDED");
    expect(seen.marketId).toBe(MARKET_ID);
    expect(harness.sink.calls).toHaveLength(1);
    expect(harness.store.checkpoints).toHaveLength(1);
    expect(harness.runtime.nextEvaluationSeq()).toBe(1);
    expect(harness.runtime.instanceStatus()).toBe("ACTIVE");
    // The third read never happens: the runtime reads each property exactly
    // once, into its own copy.
    expect(reads).toBe(1);
    expect(harness.sink.calls[0]?.record.marketId).toBe(MARKET_ID);
  });

  it("the reviewer's transcript 2: what the callback saw is what the record and the checkpoint carry", () => {
    let reads = 0;
    const market = {
      ...marketTarget(),
      get marketId(): string {
        reads += 1;
        return reads <= 3 ? MARKET_ID : MARKET_B;
      },
    };
    const seen: { marketId?: string } = {};
    const harness = makeHarness({ strategy: observingStrategy(seen) });

    const outcome = harness.runtime.evaluate(
      makeInput("onFeatures", { market }) as EvaluationInput,
    );
    expect(outcome.kind).toBe("DECIDED");
    // `callbackSaw=…1111…` / `recorded=…2222…` was the finding: a silent
    // divergence no exception would have revealed.
    expect(seen.marketId).toBe(MARKET_ID);
    expect(harness.sink.calls[0]?.record.marketId).toBe(seen.marketId);
    expect(reads).toBe(1);
    // …and `frozen=true` was the other half of it: the runtime used to freeze
    // the caller's own object, which changed nothing about the getter.
    expect(Object.isFrozen(market)).toBe(false);
  });

  it("PROBE (permanent): a view Proxy that turns hostile AFTER being frozen is never frozen at all", () => {
    // The post-freeze trap is the exact mechanism of round 2's HIGH, pointed at
    // the input boundary. Materialization never calls `preventExtensions`, so
    // the trap cannot arm.
    const target = marketTarget();
    let frozen = false;
    const proxy = new Proxy(target, {
      get(t, key, receiver): unknown {
        if (frozen) {
          throw new Error("POST_FREEZE_VIEW_GET");
        }
        return Reflect.get(t, key, receiver);
      },
      preventExtensions(t): boolean {
        frozen = true;
        Object.preventExtensions(t);
        return true;
      },
    });
    const harness = makeHarness();

    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(
        makeInput("onFeatures", { market: proxy }) as EvaluationInput,
      );
    }).not.toThrow();
    expect(outcome?.kind).toBe("DECIDED");
    expect(frozen).toBe(false);
    expect(Object.isExtensible(target)).toBe(true);
    expect(harness.sink.calls[0]?.record.marketId).toBe(MARKET_ID);
  });

  it("PROBE (permanent): a view whose accessors change on EVERY read cannot make two consumers disagree", () => {
    // Every string field answers a fresh value per read. If any consumer read
    // the caller's object a second time, these assertions would diverge.
    let tick = 0;
    const shifting: Record<string, unknown> = {};
    for (const key of ["conditionId", "yesTokenId", "noTokenId", "tickSize", "minimumOrderSize"]) {
      Object.defineProperty(shifting, key, {
        get: () => {
          tick += 1;
          return `${key}-${String(tick)}`;
        },
        enumerable: true,
        configurable: true,
      });
    }
    let marketIdReads = 0;
    Object.defineProperty(shifting, "marketId", {
      get: () => {
        marketIdReads += 1;
        return marketIdReads === 1 ? MARKET_ID : MARKET_B;
      },
      enumerable: true,
      configurable: true,
    });

    const seenViews: Array<Record<string, unknown>> = [];
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          seenViews.push({ ...ctx.market() }, { ...ctx.market() });
          return holdDecision(ctx);
        },
      }),
    });

    const outcome = harness.runtime.evaluate(
      makeInput("onFeatures", { market: shifting }) as EvaluationInput,
    );
    expect(outcome.kind).toBe("DECIDED");
    expect(marketIdReads).toBe(1);
    // Two reads inside the callback agree, and the record agrees with both.
    expect(seenViews[0]).toEqual(seenViews[1]);
    expect(harness.sink.calls[0]?.record.marketId).toBe(seenViews[0]?.["marketId"]);
    expect(harness.sink.calls[0]?.record.marketId).toBe(MARKET_ID);
  });

  it("the snapshot shares no object with the caller, and a later mutation cannot reach the record", () => {
    const views = makeInput("onFeatures") as unknown as Record<string, Record<string, unknown>>;
    let seenBooks: unknown;
    let seenMarket: unknown;
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          seenMarket = ctx.market();
          seenBooks = ctx.book("YES");
          return holdDecision(ctx);
        },
      }),
    });

    expect(harness.runtime.evaluate(views as unknown as EvaluationInput).kind).toBe("DECIDED");
    expect(seenMarket).not.toBe(views["market"]);
    expect(seenMarket).toEqual(views["market"]);
    expect(seenBooks).not.toBe((views["books"] as Record<string, unknown>)["yes"]);

    // The producer may still mutate its own object — the round-1 obligation on
    // WP-230 is discharged by copying rather than by an integration test — and
    // the mutation changes nothing about the evaluation already recorded.
    (views["market"] as Record<string, unknown>)["marketId"] = MARKET_B;
    expect(harness.sink.calls[0]?.record.marketId).toBe(MARKET_ID);
    expect((seenMarket as Record<string, unknown>)["marketId"]).toBe(MARKET_ID);
  });

  it("a view the runtime cannot read is REFUSED with the reason, invoking nothing", () => {
    let invoked = false;
    const harness = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx: StrategyContext): DecisionResult => {
          invoked = true;
          return holdDecision(ctx);
        },
      }),
    });
    const hostile = new Proxy(marketTarget(), {
      ownKeys(): ArrayLike<string | symbol> {
        throw new Error("VIEW_OWN_KEYS");
      },
    });

    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(
        makeInput("onFeatures", { market: hostile }) as EvaluationInput,
      );
    }).not.toThrow();
    expect(outcome?.kind).toBe("REFUSED");
    if (outcome?.kind !== "REFUSED") {
      return;
    }
    expect(outcome.refusal.code).toBe("INPUT_INVALID");
    expect(outcome.refusal.detail).toContain("VIEW_OWN_KEYS");
    expect(invoked).toBe(false);
    expect(harness.sink.calls).toHaveLength(0);
    expect(harness.runtime.nextEvaluationSeq()).toBe(0);
    expect(harness.runtime.instanceStatus()).toBe("ACTIVE");
  });

  it("a REVOKED Proxy view is refused rather than thrown, at evaluate() and at validateEvaluationInput", () => {
    const { proxy, revoke } = Proxy.revocable(marketTarget(), {});
    revoke();
    const harness = makeHarness();

    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(
        makeInput("onFeatures", { market: proxy }) as EvaluationInput,
      );
    }).not.toThrow();
    expect(outcome?.kind).toBe("REFUSED");

    expect(() =>
      validateEvaluationInput(makeInput("onFeatures", { market: proxy })),
    ).not.toThrow();
    expect(validateEvaluationInput(makeInput("onFeatures", { market: proxy })).ok).toBe(false);
  });

  it("an input nested past the materialization depth bound is refused, not overflowed", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 3000; index += 1) {
      deep = { nested: deep };
    }
    const harness = makeHarness();
    let outcome: EvaluationOutcome | undefined;
    expect(() => {
      outcome = harness.runtime.evaluate(
        makeInput("onFeatures", {
          features: { snapshotRef: "snap-1", asOf: "2026-01-02T03:04:05.000Z", values: deep },
        }) as EvaluationInput,
      );
    }).not.toThrow();
    expect(outcome?.kind).toBe("REFUSED");
    if (outcome?.kind !== "REFUSED") {
      return;
    }
    expect(outcome.refusal.code).toBe("INPUT_INVALID");
    expect(outcome.refusal.detail).toContain("nesting exceeds the maximum");
  });

  it("validation reads the SNAPSHOT: a view that is valid on its first read only is judged on that read", () => {
    // The input is refused for the value the snapshot holds, and the callback
    // never runs — but the decisive property is that the caller's getter was
    // consulted exactly once, so "what was validated" and "what would have been
    // used" cannot be different values.
    let reads = 0;
    const market = {
      ...marketTarget(),
      get marketId(): string {
        reads += 1;
        return reads === 1 ? "not-a-uuid" : MARKET_ID;
      },
    };
    const harness = makeHarness();
    const outcome = harness.runtime.evaluate(
      makeInput("onFeatures", { market }) as EvaluationInput,
    );
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") {
      return;
    }
    expect(outcome.refusal.code).toBe("INPUT_INVALID");
    expect(outcome.refusal.detail).toContain("UUIDv7");
    expect(reads).toBe(1);
  });

  it("a view getter that re-enters evaluate() during acquisition is refused as re-entrant", () => {
    // Acquisition runs caller code (a getter is invoked exactly once), so it is
    // inside the re-entrancy guard: a nested evaluation the outer one knows
    // nothing about could otherwise persist a record and move the sequence out
    // from under it.
    let inner: EvaluationOutcome | undefined;
    const harness = makeHarness();
    const market = {
      ...marketTarget(),
      get conditionId(): string {
        inner ??= harness.runtime.evaluate(makeInput("onFeatures"));
        return "0xcondition";
      },
    };

    const outer = harness.runtime.evaluate(
      makeInput("onFeatures", { market }) as EvaluationInput,
    );
    expect(outer.kind).toBe("DECIDED");
    expect(inner?.kind).toBe("REFUSED");
    if (inner?.kind === "REFUSED") {
      expect(inner.refusal.code).toBe("EVALUATION_REENTRANT");
    }
    // Exactly one record, one checkpoint, one sequence.
    expect(harness.sink.calls.map((call) => call.record.evaluationSeq)).toEqual([0]);
    expect(harness.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toEqual([0]);
  });

  it("does NOT over-refuse: ordinary views, optional fields, payloads and sourceEvent survive the copy", () => {
    const input = makeInput("onFill", {
      sourceEvent: {
        eventId: "018f4a7e-3333-7abc-8def-0123456789ab",
        gatewayEpoch: "018f4a7e-4444-7abc-8def-0123456789ab",
        ingestSeq: "42",
      },
      market: { ...marketTarget(), openTime: "2026-01-02T00:00:00.000Z" },
      orders: [
        {
          orderId: "order-1",
          marketId: MARKET_ID,
          outcome: "YES",
          side: "BUY",
          price: "0.5",
          requestedShares: "10",
          filledShares: "4",
          status: "PARTIALLY_FILLED",
          placedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
    });
    let seenOrders: readonly unknown[] = [];
    let seenFill: unknown;
    const harness = makeHarness({
      strategy: makeStrategy({
        onFill: (ctx: StrategyContext, fill: unknown): DecisionResult => {
          seenOrders = ctx.orders();
          seenFill = fill;
          return holdDecision(ctx);
        },
      }),
    });

    const outcome = harness.runtime.evaluate(input);
    expect(outcome.kind).toBe("DECIDED");
    expect(seenOrders).toEqual((input as unknown as Record<string, unknown>)["orders"]);
    expect(seenFill).toEqual((input as unknown as Record<string, unknown>)["fill"]);
    const record = harness.sink.calls[0]?.record;
    expect(record?.sourceEvent).toEqual({
      eventId: "018f4a7e-3333-7abc-8def-0123456789ab",
      gatewayEpoch: "018f4a7e-4444-7abc-8def-0123456789ab",
      ingestSeq: "42",
    });
    expect(record?.marketId).toBe(MARKET_ID);
  });
});
