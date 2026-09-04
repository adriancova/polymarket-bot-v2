/**
 * The replay clock (§12.1, §12.4, §6 invariant 15) and the simulated execution
 * venue (§12.1, §11, §6 invariant 13).
 *
 * The safety assertions here are the ones a reviewer should be able to check
 * without reading the implementation: a simulated venue REFUSES the three run
 * modes §11 gives a live signer, a cancel outranks a placement, and the clock
 * cannot be moved by anything except a recorded event.
 */

import { describe, expect, it } from "vitest";

import {
  SIMULATED_RUN_MODES,
  SimulatedVenue,
  addMilliseconds,
  comparePlanPriority,
  createReplayClock,
  deriveStreams,
  tier0Model,
  tier1Model,
  tokenBucketRateLimits,
  unmodeledRateLimits,
  type CancelPlanView,
  type ExecutionPolicy,
  type FeeScheduleSnapshot,
  type LatencyModel,
  type PlacementPlanView,
  type SimulatedVenueOptions,
} from "../../../packages/simulation/src/index.js";

const FEES: FeeScheduleSnapshot = {
  snapshotVersion: "fees/2026-08-24",
  takerFeeRate: "0.07",
  makerFeeRate: "0",
  roundingDecimalPlaces: 5,
  roundingMode: "HALF_UP",
  minimumChargedFee: "0.00001",
  feeCurrency: "USDC",
};

const MARKET_ID = "0190a3e0-0000-7000-8000-00000000000a";

const AT_EVENT = {
  gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
  ingestSeq: "1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  datasetRowOrdinal: 0,
};

const POLICY: ExecutionPolicy = {
  timeInForceFor: () => "GTC",
  statedExpiryNsFor: () => undefined,
};

const LATENCY: LatencyModel = {
  latencyModelVersion: "sim/latency/v1",
  decision: { samples: [{ milliseconds: 0, weight: 1 }] },
  signing: { samples: [{ milliseconds: 0, weight: 1 }] },
  network: { samples: [{ milliseconds: 0, weight: 1 }] },
  venue: { samples: [{ milliseconds: 0, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

function clock() {
  const built = createReplayClock({
    receivedAt: "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: "1000000000",
  });
  if (!built.ok) throw new Error("clock refused");
  return built.value;
}

function book(levels: readonly { price: string; size: string }[]) {
  return {
    internalMarketId: MARKET_ID,
    tokenId: "1234",
    top: () => ({}),
    ladder: () => levels,
  };
}

function venue(overrides: Partial<SimulatedVenueOptions> = {}): SimulatedVenue {
  const created = new SimulatedVenue({
    clock: clock(),
    runMode: "BACKTEST",
    model: tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: POLICY,
    startingCash: "1000",
    books: { book: () => book([{ price: "0.5", size: "100" }]) },
    ...overrides,
  });
  created.observe(AT_EVENT);
  return created;
}

function placement(overrides: Partial<PlacementPlanView> = {}): PlacementPlanView {
  return {
    executionPlanId: "plan-1",
    strategyInstanceId: "instance-1",
    runMode: "BACKTEST",
    plannedAt: "2026-01-01T00:00:00.000Z",
    deadline: "2026-01-01T00:00:10.000Z",
    planKind: "POSITION",
    priority: "PLACEMENT",
    priceProtection: { mode: "CAPPED_LIMIT_ORDERS_ONLY" },
    escalation: { atDeadline: "CANCEL_REMAINING" },
    partialFill: { policy: "ACCEPT_ANY" },
    groups: [
      {
        executionGroupId: "group-1",
        marketId: MARKET_ID,
        tickSize: "0.01",
        minimumOrderSize: "5",
        orders: [
          {
            plannedOrderId: "order-1",
            marketId: MARKET_ID,
            side: "YES",
            action: "BUY",
            limitPrice: "0.6",
            shares: "10",
            postOnly: false,
            executionStyle: "MARKETABLE_LIMIT",
            reservationId: "res-1",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function cancelPlan(): CancelPlanView {
  return {
    executionPlanId: "plan-cancel",
    strategyInstanceId: "instance-1",
    runMode: "BACKTEST",
    plannedAt: "2026-01-01T00:00:00.000Z",
    deadline: "2026-01-01T00:00:10.000Z",
    planKind: "CANCEL",
    priority: "SAFETY_CANCEL",
    priceProtection: { mode: "NO_NEW_ORDERS" },
    escalation: { atDeadline: "ESCALATE_TO_RECONCILIATION" },
    scope: { marketId: MARKET_ID },
    reason: "kill switch",
  };
}

// ---------------------------------------------------------------------------

describe("the replay clock is driven only by recorded events (§12.1, §12.4)", () => {
  it("is positioned at a recorded instant and reports it verbatim", () => {
    const built = clock();
    expect(built.now()).toBe("2026-01-01T00:00:00.000Z");
    expect(built.monotonicNs()).toBe(1_000_000_000n);
  });

  it("advances to a later recorded instant", () => {
    const built = clock();
    const advanced = built.advanceTo({
      receivedAt: "2026-01-01T00:00:01.000Z",
      receivedMonotonicNs: "2000000000",
    });
    expect(advanced.ok).toBe(true);
    expect(built.now()).toBe("2026-01-01T00:00:01.000Z");
    expect(built.observations().advances).toBe(1);
  });

  it("REFUSES a monotonic regression", () => {
    const built = clock();
    const advanced = built.advanceTo({
      receivedAt: "2026-01-01T00:00:01.000Z",
      receivedMonotonicNs: "999999999",
    });
    expect(advanced.ok).toBe(false);
    if (advanced.ok) return;
    expect(advanced.refusal.code).toBe("REPLAY_CLOCK_NOT_MONOTONE");
    // …and the clock did not move.
    expect(built.now()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("OBSERVES a wall-clock regression rather than enforcing one", () => {
    // `wal-format.md` §12.1: frame wall clocks are not monotonic across boots,
    // so refusing here would assert an invariant the recording does not carry.
    const built = clock();
    const advanced = built.advanceTo({
      receivedAt: "2025-12-31T23:59:59.000Z",
      receivedMonotonicNs: "2000000000",
    });
    expect(advanced.ok).toBe(true);
    expect(built.observations().wallClockRegressions).toBe(1);
  });

  it("refuses an instant that is not in the §7.1 grammar", () => {
    const built = clock();
    expect(built.advanceTo({ receivedAt: "yesterday", receivedMonotonicNs: "2000" }).ok).toBe(false);
    expect(
      built.advanceTo({ receivedAt: "2026-01-01T00:00:01.000Z", receivedMonotonicNs: "0x10" }).ok,
    ).toBe(false);
  });

  it("has no way to be advanced by a duration — latency is arithmetic, not a clock move", () => {
    const built = clock();
    // The type carries no `advanceBy`; the only forward step is recorded.
    expect((built as unknown as Record<string, unknown>)["advanceBy"]).toBeUndefined();
    // A Tier-1 latency window is expressed as arithmetic on the recorded value.
    expect(addMilliseconds(built.monotonicNs(), 15)).toBe(1_015_000_000n);
    expect(built.monotonicNs()).toBe(1_000_000_000n);
  });

  it("refuses to be built from an unrecordable instant", () => {
    expect(createReplayClock({ receivedAt: "2026-02-30T00:00:00Z", receivedMonotonicNs: "1" }).ok).toBe(
      false,
    );
  });
});

describe("the simulated venue refuses the run modes §11 gives a live signer", () => {
  it("enumerates exactly the three simulated-execution run modes", () => {
    expect([...SIMULATED_RUN_MODES]).toEqual(["BACKTEST", "PAPER", "SHADOW"]);
  });

  it.each(["EXECUTION_PROBE", "LIVE_MICRO", "LIVE"] as const)(
    "refuses a %s plan by name",
    async (runMode) => {
      const result = await venue().submit(placement({ runMode }));
      expect(result.accepted).toBe(false);
      expect(result.refusalCode).toBe("SIMULATED_VENUE_RUN_MODE_REQUIRES_LIVE_SIGNER");
      expect(result.venueClass).toBe("SIMULATED");
      expect(result.fills).toHaveLength(0);
    },
  );

  it("refuses a plan whose run mode is not the one this venue serves", async () => {
    const result = await venue({ runMode: "BACKTEST" }).submit(placement({ runMode: "PAPER" }));
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_PLAN_UNSUPPORTED");
  });
});

describe("§6 invariant 13 — safety cancellation outranks new order placement", () => {
  it("ranks SAFETY_CANCEL ahead of PLACEMENT", () => {
    expect(comparePlanPriority("SAFETY_CANCEL", "PLACEMENT")).toBe(-1);
    expect(comparePlanPriority("PLACEMENT", "SAFETY_CANCEL")).toBe(1);
    expect(comparePlanPriority("PLACEMENT", "PLACEMENT")).toBe(0);
  });

  it("schedules a cancel before a placement handed to it in the other order", async () => {
    const simulated = venue();
    const results = await simulated.submitAll([placement(), cancelPlan()]);
    expect(results.map((result) => result.executionPlanId)).toEqual(["plan-cancel", "plan-1"]);
  });

  it("a cancel draws on its own budget and is not starved by placement traffic", async () => {
    // One order token and one cancel token per window: the placement exhausts
    // the ORDER bucket, and the cancel still lands.
    const budget = tokenBucketRateLimits({
      orderTokensPerWindow: 1,
      cancelTokensPerWindow: 1,
      windowMs: 60_000,
      snapshotVersion: "test/rate-limits/v1",
    });
    const simulated = venue({ rateLimits: budget });
    // A resting order (limit below the ask), so it is still cancellable.
    const first = await simulated.submit(
      placement({
        groups: [
          {
            executionGroupId: "group-1",
            marketId: MARKET_ID,
            tickSize: "0.01",
            minimumOrderSize: "5",
            orders: [
              {
                plannedOrderId: "order-1",
                marketId: MARKET_ID,
                side: "YES",
                action: "BUY",
                limitPrice: "0.4",
                shares: "10",
                postOnly: false,
                executionStyle: "REST",
                reservationId: "res-1",
              },
            ],
          },
        ],
      }),
    );
    expect(first.accepted).toBe(true);
    expect(first.orders[0]?.state).toBe("RESTING");

    const second = await simulated.submit(
      placement({
        executionPlanId: "plan-2",
        groups: [
          {
            executionGroupId: "group-2",
            marketId: MARKET_ID,
            tickSize: "0.01",
            minimumOrderSize: "5",
            orders: [
              {
                plannedOrderId: "order-2",
                marketId: MARKET_ID,
                side: "YES",
                action: "BUY",
                limitPrice: "0.6",
                shares: "1",
                postOnly: false,
                executionStyle: "MARKETABLE_LIMIT",
                reservationId: "res-2",
              },
            ],
          },
        ],
      }),
    );
    expect(second.accepted).toBe(false);
    expect(second.refusalCode).toBe("SIMULATED_VENUE_RATE_LIMITED");

    const cancelled = await simulated.cancel({
      executionPlanId: "plan-cancel",
      reason: "kill switch",
      scope: { marketId: MARKET_ID },
      priority: "SAFETY_CANCEL",
    });
    // The cancel landed: the ORDER bucket is exhausted and the CANCEL bucket is
    // not, which is §6 invariant 13's scheduling priority made mechanical.
    expect(cancelled.cancelled).toEqual(["order-1"]);
    expect(cancelled.notCancelled).toEqual([]);
  });

  it("says NOT_MODELED when no budget model is wired, rather than implying one", () => {
    const budget = unmodeledRateLimits("no venue budget model is wired");
    expect(budget.modelKind).toBe("NOT_MODELED");
    expect(budget.disclosure).toContain("no venue budget model");
    expect(budget.admit({ kind: "PLACE", priority: "PLACEMENT", count: 1, atNs: 0n }).admitted).toBe(
      true,
    );
  });
});

describe("the venue's results and account state", () => {
  it("labels every result SIMULATED and top-of-book-only", async () => {
    const result = await venue().submit(placement());
    expect(result.accepted).toBe(true);
    expect(result.venueClass).toBe("SIMULATED");
    // WP-190 follow_up 1: the PLAN saw only top-of-book, and the label travels
    // with the result so a reader cannot infer depth-aware participation.
    expect(result.planningDepthAwareness).toBe("TOP_OF_BOOK_ONLY");
    expect(result.fills[0]?.evidenceClass).toBe("SIMULATED_NOT_REAL_EVIDENCE");
  });

  it("refuses a repeated planned-order id rather than retrying silently", async () => {
    const simulated = venue();
    expect((await simulated.submit(placement())).accepted).toBe(true);
    const again = await simulated.submit(placement({ executionPlanId: "plan-2" }));
    expect(again.accepted).toBe(false);
    expect(again.refusalCode).toBe("SIMULATED_VENUE_DUPLICATE_ORDER");
  });

  it("refuses when no book exists for the market the plan names (§6 invariant 12)", async () => {
    const result = await venue({ books: { book: () => undefined } }).submit(placement());
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_NO_BOOK");
  });

  it("refuses before it is positioned at any recorded event", async () => {
    const unpositioned = new SimulatedVenue({
      clock: clock(),
      runMode: "BACKTEST",
      model: tier0Model({ fillModelVersion: "v", fillModelParametersHash: "0".repeat(64) }),
      feeSnapshot: FEES,
      rateLimits: unmodeledRateLimits("none"),
      policy: POLICY,
      startingCash: "1000",
      books: { book: () => book([{ price: "0.5", size: "100" }]) },
    });
    const result = await unpositioned.submit(placement());
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_NO_BOOK");
  });

  it("keeps cash and positions exactly, and anchors the snapshot to a recorded event", async () => {
    const simulated = venue();
    await simulated.submit(placement());
    const account = await simulated.queryAccountState();
    expect(account.venueClass).toBe("SIMULATED");
    // 10 shares at 0.5 = 5.00; fee 10 × 0.07 × 0.5 × 0.5 = 0.175.
    expect(account.cashBalance).toBe("994.825");
    expect(account.positions).toEqual([
      { marketId: MARKET_ID, tokenId: "1234", side: "YES", shares: "10" },
    ]);
    expect(account.atEvent).toEqual(AT_EVENT);
  });

  it("reports a null anchor rather than a fabricated one before positioning", async () => {
    const unpositioned = new SimulatedVenue({
      clock: clock(),
      runMode: "BACKTEST",
      model: tier0Model({ fillModelVersion: "v", fillModelParametersHash: "0".repeat(64) }),
      feeSnapshot: FEES,
      rateLimits: unmodeledRateLimits("none"),
      policy: POLICY,
      startingCash: "1000",
    });
    const account = await unpositioned.queryAccountState();
    expect(account.atEvent).toBeNull();
  });

  it("a Tier-1 venue needs its timeline, latency model, streams and market parameters", async () => {
    const incomplete = venue({
      model: tier1Model({ fillModelVersion: "t1", fillModelParametersHash: "0".repeat(64) }),
    });
    const result = await incomplete.submit(placement());
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_PLAN_UNSUPPORTED");

    const complete = venue({
      model: tier1Model({ fillModelVersion: "t1", fillModelParametersHash: "0".repeat(64) }),
      timeline: {
        bookAt: () => ({ book: book([{ price: "0.5", size: "100" }]), atEvent: AT_EVENT }),
      },
      latencyModel: LATENCY,
      streams: deriveStreams("42"),
      marketParameters: () => ({
        marketId: MARKET_ID,
        tickSize: "0.01",
        minimumOrderSize: "5",
        secondsDelay: 0,
        parametersVersion: 1,
      }),
    });
    const filled = await complete.submit(placement());
    expect(filled.accepted).toBe(true);
    expect(filled.fills[0]?.price).toBe("0.5");
  });

  it("cancels an unknown order by naming it, never by pretending", async () => {
    const result = await venue().cancel({
      executionPlanId: "plan-x",
      reason: "kill switch",
      scope: { orderIds: ["nope"] },
      priority: "SAFETY_CANCEL",
    });
    expect(result.cancelled).toEqual([]);
    expect(result.notCancelled).toEqual([
      { simulatedOrderId: "nope", reason: "SIMULATED_VENUE_UNKNOWN_ORDER" },
    ]);
  });
});
