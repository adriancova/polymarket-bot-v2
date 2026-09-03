/**
 * Evaluation-input validation: the gate in front of the callback.
 *
 * An invalid input is a REFUSED evaluation — the callback never runs, so §6
 * invariant 3 does not bind and no decision record exists. That is the honest
 * outcome: nothing was evaluated, so nothing decided. (Contrast with a callback
 * that ran and misbehaved, which is CONTAINED and does produce exactly one
 * runtime-attributed record; see `decision-persistence.test.ts`.)
 *
 * ADR-016 is pinned explicitly: a UUID-shaped identifier that is not canonical
 * lowercase is refused at this surface, never case-folded into acceptance.
 */

import { describe, expect, it } from "vitest";

import {
  validateEvaluationInput,
  type EvaluationInput,
} from "../../../packages/strategy-runtime/src/index.js";
import { holdDecision, makeHarness, makeInput, makeStrategy, MARKET_ID } from "./helpers.js";

function detailOf(input: unknown): string {
  const result = validateEvaluationInput(input);
  if (result.ok) {
    throw new Error("expected the input to be refused");
  }
  return result.detail;
}

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

describe("validateEvaluationInput", () => {
  it("accepts a well-formed input for every callback", () => {
    for (const callback of ALL_CALLBACKS) {
      expect(validateEvaluationInput(makeInput(callback)).ok, callback).toBe(true);
    }
  });

  it("refuses a non-object input and an unknown callback", () => {
    for (const bad of [null, undefined, 1, "onFeatures", true]) {
      expect(detailOf(bad), String(bad)).toContain("must be an object");
    }
    expect(detailOf(makeInput("onFeatures", { callback: "onWhatever" }))).toContain(
      "callback must be one of",
    );
    expect(detailOf(makeInput("onFeatures", { callback: 7 }))).toContain("callback must be one of");
  });

  it("refuses a non-ISO evaluation timestamp", () => {
    for (const bad of ["not-a-timestamp", "2026-01-02", 1767322445000, null, undefined]) {
      expect(detailOf(makeInput("onFeatures", { evaluatedAt: bad })), String(bad)).toContain(
        "evaluatedAt must be an ISO-8601 timestamp",
      );
    }
  });

  it("refuses a UUID-shaped marketId that is not canonical lowercase (ADR-016), never case-folding it", () => {
    const upper = MARKET_ID.toUpperCase();
    const detail = detailOf(makeInput("onFeatures", { market: { marketId: upper } }));
    expect(detail).toContain("ADR-016");
    expect(detail).toContain("never case-folded");
    // And a non-UUID market identifier is refused too: §7.2 fixes
    // InternalMarketId as a UUIDv7.
    expect(detailOf(makeInput("onFeatures", { market: { marketId: "market-1" } }))).toContain(
      "UUIDv7",
    );
  });

  it("refuses a missing view rather than handing the strategy a partial context", () => {
    expect(detailOf(makeInput("onFeatures", { market: undefined }))).toContain(
      "market view is required",
    );
    expect(detailOf(makeInput("onFeatures", { books: { yes: {} } }))).toContain(
      "books.yes and books.no",
    );
    expect(detailOf(makeInput("onFeatures", { features: undefined }))).toContain(
      "features snapshot view is required",
    );
    expect(detailOf(makeInput("onFeatures", { position: undefined }))).toContain(
      "position view is required",
    );
    expect(detailOf(makeInput("onFeatures", { orders: undefined }))).toContain(
      "orders must be an array",
    );
    expect(detailOf(makeInput("onFeatures", { riskBudget: undefined }))).toContain(
      "riskBudget view is required",
    );
  });

  it("requires a usable feature snapshot reference — it is the traceability anchor (§6 invariant 4)", () => {
    for (const bad of ["", 7, null, undefined, "x".repeat(201)]) {
      expect(
        detailOf(makeInput("onFeatures", { features: { snapshotRef: bad, values: {} } })),
        String(bad),
      ).toContain("features.snapshotRef");
    }
    expect(
      detailOf(makeInput("onFeatures", { features: { snapshotRef: "snap-1", values: "no" } })),
    ).toContain("features.values must be an object");
  });

  it("refuses a malformed source-event identity (§7.1 information-arrival order)", () => {
    const withSource = (sourceEvent: unknown): unknown =>
      makeInput("onFeatures", { sourceEvent });
    expect(detailOf(withSource("nope"))).toContain("sourceEvent must be an object");
    expect(
      detailOf(withSource({ eventId: "018F4A7E-2222-7ABC-8DEF-0123456789AB" })),
    ).toContain("ADR-016");
    expect(detailOf(withSource({ eventId: "not-a-uuid" }))).toContain("sourceEvent.eventId");
    expect(detailOf(withSource({ gatewayEpoch: "not-a-uuid" }))).toContain(
      "sourceEvent.gatewayEpoch",
    );
    for (const bad of ["-1", "007", "1.0", 42]) {
      expect(detailOf(withSource({ ingestSeq: bad })), String(bad)).toContain(
        "sourceEvent.ingestSeq",
      );
    }
    // Absent as a group is valid: a timer evaluation has no source event.
    expect(validateEvaluationInput(makeInput("onTimer")).ok).toBe(true);
  });

  it("requires each callback's own payload", () => {
    expect(detailOf(makeInput("onFill", { fill: undefined }))).toContain(
      "onFill requires a fill payload",
    );
    expect(detailOf(makeInput("onOrderUpdate", { order: undefined }))).toContain(
      "onOrderUpdate requires an order payload",
    );
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "30", undefined]) {
      expect(
        detailOf(makeInput("onMarketClosing", { secondsRemaining: bad })),
        String(bad),
      ).toContain("secondsRemaining");
    }
    expect(detailOf(makeInput("onMarketResolved", { resolution: undefined }))).toContain(
      "onMarketResolved requires a resolution payload",
    );
    for (const bad of ["", undefined, 7, "x".repeat(201)]) {
      expect(detailOf(makeInput("onStop", { reason: bad })), String(bad)).toContain(
        "onStop requires a non-empty reason string",
      );
    }
  });

  it("accepts a whitespace-only stop reason: the bound is emptiness, not blankness", () => {
    // Deliberate, and stated so it is reviewed rather than discovered: the
    // stop reason is free-form operator/caller text, and refusing the INPUT
    // would refuse the whole `onStop` evaluation — leaving the instance unable
    // to record its own stop, which is a worse outcome than a useless reason
    // string. Emptiness and the identifier length bound are enforced; judging
    // the prose is not this layer's job.
    expect(validateEvaluationInput(makeInput("onStop", { reason: " " })).ok).toBe(true);
  });

  it("refuses a DISPUTED or PENDING 'resolution' — a dispute is market state, not a resolution", () => {
    for (const bad of ["DISPUTED", "PENDING", "YES", "yes_win", ""]) {
      const detail = detailOf(
        makeInput("onMarketResolved", {
          resolution: { marketId: MARKET_ID, outcome: bad, resolvedAt: "2026-01-02T03:04:05.000Z" },
        }),
      );
      expect(detail, bad).toContain("terminal market outcome state");
    }
    for (const good of ["YES_WIN", "NO_WIN", "SPLIT_50_50", "CANCELLED"]) {
      const input = makeInput("onMarketResolved", {
        resolution: { marketId: MARKET_ID, outcome: good, resolvedAt: "2026-01-02T03:04:05.000Z" },
      });
      expect(validateEvaluationInput(input).ok, good).toBe(true);
    }
  });

  it("never throws, whatever it is handed", () => {
    const cyclic: Record<string, unknown> = { callback: "onFeatures" };
    cyclic["self"] = cyclic;
    for (const value of [cyclic, [], new Map(), Symbol("s"), () => 1]) {
      expect(() => validateEvaluationInput(value)).not.toThrow();
    }
  });

  it("the runtime refuses an invalid input WITHOUT invoking the callback or persisting anything", () => {
    let invoked = false;
    const { runtime, sink, store } = makeHarness({
      strategy: makeStrategy({
        onFeatures: (ctx) => {
          invoked = true;
          return holdDecision(ctx);
        },
      }),
    });
    const outcome = runtime.evaluate({
      ...makeInput("onFeatures"),
      market: { marketId: "not-a-uuid" },
    } as unknown as EvaluationInput);
    expect(outcome.kind).toBe("REFUSED");
    expect(invoked).toBe(false);
    expect(sink.calls).toHaveLength(0);
    expect(store.checkpoints).toHaveLength(0);
    // The instance stays ACTIVE: a caller error is not a strategy failure.
    expect(runtime.instanceStatus()).toBe("ACTIVE");
    expect(runtime.nextEvaluationSeq()).toBe(0);

    // The same instance still evaluates a VALID input afterwards.
    expect(runtime.evaluate(makeInput("onFeatures")).kind).toBe("DECIDED");
    expect(invoked).toBe(true);
    expect(sink.calls).toHaveLength(1);
  });
});
