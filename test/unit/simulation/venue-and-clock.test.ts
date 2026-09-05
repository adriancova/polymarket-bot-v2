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
  type PlannedOrderView,
  type QueueModelParameters,
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
  // This root LOOKED and saw nothing added at our price — which is a different
  // fact from `"NOT_OBSERVED"`, and the band now records which one it was.
  sameInstantAdditionsFor: () => ({ observedShares: "0" }),
};

const QUEUE: QueueModelParameters = {
  queueModelVersion: "sim/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
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

/** A book whose two sides differ, so "crossing" is a real question. */
function sidedBook(
  bids: readonly { price: string; size: string }[],
  asks: readonly { price: string; size: string }[],
) {
  return {
    internalMarketId: MARKET_ID,
    tokenId: "1234",
    top: () => ({}),
    ladder: (side: "BID" | "ASK") => (side === "ASK" ? asks : bids),
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

  it("states whether a rate-limit budget was modelled at all (ADR-012 §5.6)", async () => {
    const unmodelled = await venue().submit(placement());
    expect(unmodelled.rateLimitModel).toBe("NOT_MODELED");
    expect(unmodelled.rateLimitDisclosure).toContain("no venue budget model");

    const modelled = await venue({
      rateLimits: tokenBucketRateLimits({
        orderTokensPerWindow: 5,
        cancelTokensPerWindow: 5,
        windowMs: 60_000,
        snapshotVersion: "test/rate-limits/v1",
      }),
    }).submit(placement());
    expect(modelled.rateLimitModel).toBe("MODELED");
    expect(modelled.rateLimitDisclosure).toContain("test/rate-limits/v1");
  });

  it("turns an unexpected internal failure into a REFUSED result, not a rejected promise", async () => {
    // Round-1 review M4: an unvalidated economic field reached layer-0
    // arithmetic and threw out of `submit`, which documents a typed refusal.
    const hostile = venue({ startingCash: "1,000" });
    const result = await hostile.submit(placement());
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATION_INPUT_INVALID");

    const badFees = venue({ feeSnapshot: { ...FEES, takerFeeRate: "1,5" } });
    const feeResult = await badFees.submit(placement());
    expect(feeResult.accepted).toBe(false);
    expect(feeResult.refusalCode).toBe("FILL_MODEL_FEE_SNAPSHOT_MISSING");
  });
});

// ---------------------------------------------------------------------------
// The §12.1 seam: what `executionStyle` decides
// ---------------------------------------------------------------------------

/** One planned order, with the fields a routing probe varies. */
function order(overrides: Partial<PlannedOrderView> = {}): PlannedOrderView {
  return {
    plannedOrderId: "order-1",
    marketId: MARKET_ID,
    side: "YES",
    action: "BUY",
    limitPrice: "0.6",
    shares: "10",
    postOnly: false,
    executionStyle: "MARKETABLE_LIMIT",
    reservationId: "res-1",
    ...overrides,
  };
}

function planWith(planned: PlannedOrderView, overrides: Partial<PlacementPlanView> = {}) {
  return placement({
    groups: [
      {
        executionGroupId: "group-1",
        marketId: MARKET_ID,
        tickSize: "0.01",
        minimumOrderSize: "5",
        orders: [planned],
      },
    ],
    ...overrides,
  });
}

const TIER1_MODEL = tier1Model({ fillModelVersion: "t1", fillModelParametersHash: "0".repeat(64) });

/** A Tier-1 venue over a fixed book. Built directly: nothing is defaulted. */
function tier1Venue(
  bids: readonly { price: string; size: string }[],
  asks: readonly { price: string; size: string }[],
  overrides: Partial<SimulatedVenueOptions> = {},
): SimulatedVenue {
  const created = new SimulatedVenue({
    clock: clock(),
    runMode: "BACKTEST",
    model: TIER1_MODEL,
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: POLICY,
    startingCash: "1000",
    timeline: { bookAt: () => ({ book: sidedBook(bids, asks), atEvent: AT_EVENT }) },
    latencyModel: LATENCY,
    streams: deriveStreams("42"),
    marketParameters: () => ({
      marketId: MARKET_ID,
      tickSize: "0.01",
      minimumOrderSize: "5",
      secondsDelay: 0,
      parametersVersion: 1,
    }),
    queueParameters: QUEUE,
    ...overrides,
  });
  created.observe(AT_EVENT);
  return created;
}

/** The same Tier-1 venue with one option deliberately ABSENT. */
function tier1VenueWithout(
  bids: readonly { price: string; size: string }[],
  asks: readonly { price: string; size: string }[],
  absent: "queueParameters",
): SimulatedVenue {
  const options: SimulatedVenueOptions = {
    clock: clock(),
    runMode: "BACKTEST",
    model: TIER1_MODEL,
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: POLICY,
    startingCash: "1000",
    timeline: { bookAt: () => ({ book: sidedBook(bids, asks), atEvent: AT_EVENT }) },
    latencyModel: LATENCY,
    streams: deriveStreams("42"),
    marketParameters: () => ({
      marketId: MARKET_ID,
      tickSize: "0.01",
      minimumOrderSize: "5",
      secondsDelay: 0,
      parametersVersion: 1,
    }),
    queueParameters: QUEUE,
  };
  const without = { ...options };
  delete (without as Record<string, unknown>)[absent];
  const created = new SimulatedVenue(without);
  created.observe(AT_EVENT);
  return created;
}

describe("a CROSSING postOnly order is REJECTED, never filled (venue report §2.3, ADR-012 §5.3)", () => {
  it("Tier 0: books it REJECTED with no fill", async () => {
    const simulated = venue({
      books: { book: () => sidedBook([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]) },
    });
    // A BUY at 0.6 crosses an ask of 0.5.
    const result = await simulated.submit(
      planWith(order({ executionStyle: "REST", postOnly: true, limitPrice: "0.6" })),
    );
    expect(result.accepted).toBe(true);
    expect(result.fills).toEqual([]);
    expect(result.orders[0]?.state).toBe("REJECTED");
    expect(result.orders[0]?.filledShares).toBe("0");
    const account = await simulated.queryAccountState();
    expect(account.positions).toEqual([]);
    expect(account.cashBalance).toBe("1000");
  });

  it("Tier 1: books it REJECTED with no fill", async () => {
    const simulated = tier1Venue([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]);
    const result = await simulated.submit(
      planWith(order({ executionStyle: "REST", postOnly: true, limitPrice: "0.6" })),
    );
    expect(result.accepted).toBe(true);
    expect(result.fills).toEqual([]);
    expect(result.orders[0]?.state).toBe("REJECTED");
  });

  it("a NON-crossing postOnly order is not rejected: it RESTS, and is registered", async () => {
    // Round-2 review N1: asserting `state === "RESTING"` alone is satisfiable
    // WITHOUT registering the order for observation — `#book` sets that state
    // from the remainder disposition, so a `#rest` that skipped registration
    // would still pass. What proves registration is that a LATER observed trade
    // at the order's price actually fills it.
    const simulated = venue({
      books: { book: () => sidedBook([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]) },
    });
    const result = await simulated.submit(
      planWith(order({ executionStyle: "REST", postOnly: true, limitPrice: "0.45", shares: "10" })),
    );
    expect(result.orders[0]?.state).toBe("RESTING");
    expect(result.fills).toEqual([]);

    const touch = simulated.observeTrade({
      marketId: MARKET_ID,
      side: "YES",
      price: "0.45",
      shares: "10",
      monotonicNs: 1_000_000_100n,
      atEvent: AT_EVENT,
    });
    expect(touch.ok).toBe(true);
    if (!touch.ok) return;
    expect(touch.value.fills).toHaveLength(1);
    expect(touch.value.fills[0]?.simulatedOrderId).toBe("order-1");
    // A postOnly order that rested is a MAKER when it fills, never a taker.
    expect(touch.value.fills[0]?.liquidityRole).toBe("MAKER");
    expect(simulated.ordersSnapshot()[0]?.state).toBe("FILLED");
  });

  it("postOnly on a MARKETABLE_LIMIT order is refused, not silently dropped", async () => {
    const result = await venue().submit(
      planWith(order({ executionStyle: "MARKETABLE_LIMIT", postOnly: true })),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_PLAN_UNSUPPORTED");
    expect(result.refusalMessage).toContain("resting limit types");
  });
});

describe("a resting order fills from SUBSEQUENT observed trades (§12.2 Tier 0)", () => {
  it("fills on touch, as a MAKER, and moves cash and inventory", async () => {
    const simulated = venue({
      books: { book: () => sidedBook([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]) },
    });
    const submitted = await simulated.submit(
      planWith(order({ executionStyle: "REST", limitPrice: "0.45", shares: "10" })),
    );
    expect(submitted.orders[0]?.state).toBe("RESTING");
    expect(simulated.fills).toEqual([]);

    // A trade AWAY from the price does nothing.
    const away = simulated.observeTrade({
      marketId: MARKET_ID,
      side: "YES",
      price: "0.46",
      shares: "5",
      monotonicNs: 1_000_000_001n,
      atEvent: AT_EVENT,
    });
    expect(away.ok).toBe(true);
    if (!away.ok) return;
    expect(away.value.fills).toEqual([]);

    // A trade AT the price fills it.
    const touch = simulated.observeTrade({
      marketId: MARKET_ID,
      side: "YES",
      price: "0.45",
      shares: "5",
      monotonicNs: 1_000_000_002n,
      atEvent: AT_EVENT,
    });
    expect(touch.ok).toBe(true);
    if (!touch.ok) return;
    expect(touch.value.fills).toHaveLength(1);
    expect(touch.value.fills[0]?.liquidityRole).toBe("MAKER");
    expect(touch.value.fills[0]?.price).toBe("0.45");
    expect(simulated.ordersSnapshot()[0]?.state).toBe("FILLED");

    const account = await simulated.queryAccountState();
    // Maker fee is 0 under the 2026-08-24 snapshot: 1000 − 10 × 0.45 = 995.5.
    expect(account.cashBalance).toBe("995.5");
    expect(account.positions).toEqual([
      { marketId: MARKET_ID, tokenId: "1234", side: "YES", shares: "10" },
    ]);
  });

  it("REFUSES an observed trade that arrives out of recorded order", async () => {
    const simulated = venue({
      books: { book: () => sidedBook([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]) },
    });
    const first = simulated.observeTrade({
      marketId: MARKET_ID,
      side: "YES",
      price: "0.45",
      shares: "5",
      monotonicNs: 5_000n,
      atEvent: AT_EVENT,
    });
    expect(first.ok).toBe(true);
    const backwards = simulated.observeTrade({
      marketId: MARKET_ID,
      side: "YES",
      price: "0.45",
      shares: "5",
      monotonicNs: 4_000n,
      atEvent: AT_EVENT,
    });
    expect(backwards.ok).toBe(false);
    if (backwards.ok) return;
    expect(backwards.refusal.code).toBe("REPLAY_CLOCK_NOT_MONOTONE");
  });
});

describe("a Tier-1 resting order reports the §12.2 BAND through the venue seam", () => {
  it("the band is on the submit result, with all three labelled scenarios", async () => {
    const simulated = tier1Venue([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]);
    const result = await simulated.submit(
      planWith(order({ executionStyle: "REST", limitPrice: "0.4", shares: "50" })),
    );
    expect(result.accepted).toBe(true);
    expect(result.orders[0]?.state).toBe("RESTING");
    // ADR-012 §1: a Tier-1 resting order has no honest single number, and the
    // order says so rather than reporting one.
    expect(result.orders[0]?.fillEstimateKind).toBe("TIER_1_RESTING_BAND");
    expect(result.bands).toHaveLength(1);
    const band = result.bands[0];
    expect(band?.simulatedOrderId).toBe("order-1");
    expect(band?.optimistic.scenario).toBe("OPTIMISTIC");
    expect(band?.base.scenario).toBe("BASE");
    expect(band?.conservative.scenario).toBe("CONSERVATIVE");
    expect(band?.quotationRule).toBe("REPORT_THE_BAND_NEVER_ONE_MEMBER");
    // Queue ahead is the observed aggregate at our price: the 100 on the bid.
    expect(band?.optimistic.filledShares).toBe("0");
  });

  it("the band moves with OBSERVED trades, and stays a band", async () => {
    const simulated = tier1Venue([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]);
    await simulated.submit(planWith(order({ executionStyle: "REST", limitPrice: "0.4", shares: "50" })));
    const observed = simulated.observeTrade({
      marketId: MARKET_ID,
      side: "YES",
      price: "0.4",
      shares: "130",
      monotonicNs: 2_000_000_000n,
      atEvent: AT_EVENT,
    });
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.value.bands).toHaveLength(1);
    const band = observed.value.bands[0];
    // Hand-computed from the observed facts: queue ahead is the 100 resting at
    // our price, and 130 trades through it.
    //   CONSERVATIVE credits no cancellation: 130 − 100 = 30 reaches us.
    //   BASE cancels 0.1 × 130 = 13 of the queue first: 130 − 87 = 43.
    //   OPTIMISTIC cancels 0.5 × 130 = 65: 95 reaches us, capped by our 50.
    expect(band?.conservative.filledShares).toBe("30");
    expect(band?.base.filledShares).toBe("43");
    expect(band?.optimistic.filledShares).toBe("50");
    // No point-precise fill was booked for it: a band is not cash.
    expect(simulated.fills).toEqual([]);
    expect(simulated.restingBands()).toHaveLength(1);
  });

  it("refuses to rest a Tier-1 order with no pinned queue parameters (§12.5)", async () => {
    const simulated = tier1VenueWithout(
      [{ price: "0.4", size: "100" }],
      [{ price: "0.5", size: "100" }],
      "queueParameters",
    );
    const result = await simulated.submit(
      planWith(order({ executionStyle: "REST", limitPrice: "0.4" })),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("FILL_MODEL_PARAMETERS_UNPINNED");
  });

  it("refuses a Tier-1 order whose latency distribution is empty (ADR-012 §7)", async () => {
    const simulated = tier1Venue([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }], {
      latencyModel: { ...LATENCY, network: { samples: [] } },
    });
    const result = await simulated.submit(planWith(order({ executionStyle: "REST", limitPrice: "0.4" })));
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("FILL_MODEL_LATENCY_DISTRIBUTION_INVALID");
  });
});

describe("an order that never reached a book still names its outcome token (L5)", () => {
  /** A GTD policy whose stated expiry has already passed at the clock's instant. */
  const expiredGtd: ExecutionPolicy = {
    ...POLICY,
    timeInForceFor: () => "GTD",
    // The clock is at 1_000_000_000 ns and GTD expires 60 s EARLY, so an expiry
    // stated at the clock's own instant is already past its effective one.
    statedExpiryNsFor: () => 1_000_000_000n,
  };

  it("books the token id the recorded timeline knows, not an empty string", async () => {
    // Round-2 review L1: `tier1Immediate` answers `tokenId: null` for
    // `EXPIRED_BEFORE_MATCHING` — the order never reached a book — and the
    // previous code booked it under `?? ""`, naming no token at all. The
    // identity comes from the recorded timeline. Reverting to `?? ""` left the
    // whole suite green, which is why this test exists.
    const simulated = tier1Venue([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }], {
      policy: expiredGtd,
    });
    const result = await simulated.submit(
      planWith(order({ executionStyle: "MARKETABLE_LIMIT", limitPrice: "0.6" })),
    );
    expect(
      result.accepted,
      `${String(result.refusalCode)}: ${String(result.refusalMessage)}`,
    ).toBe(true);
    expect(result.orders[0]?.state).toBe("EXPIRED");
    expect(result.orders[0]?.tokenId).toBe("1234");
    expect(result.orders[0]?.tokenId).not.toBe("");
    expect(result.fills).toEqual([]);
  });

  it("REFUSES rather than inventing one when the timeline knows no book", async () => {
    const simulated = tier1Venue([], [], {
      policy: expiredGtd,
      timeline: { bookAt: () => undefined },
    });
    const result = await simulated.submit(
      planWith(order({ executionStyle: "MARKETABLE_LIMIT", limitPrice: "0.6" })),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_NO_BOOK");
    expect(result.refusalMessage).toContain("cannot name the outcome token");
  });
});

describe("a REFUSED result discloses the same rate-limit facts an accepted one does", () => {
  it("carries the venue's own modelKind and disclosure on the refusal path (M9)", async () => {
    // Round-2 review L3: `#refuse` was the ONLY place these fields were not
    // pinned by a test, so faking `rateLimitModel: "MODELED"` there left the
    // suite green — a refused result could have claimed a budget model that was
    // never wired, which is exactly what ADR-012 §5.6 says must not happen.
    const unmodelled = await venue().submit(placement({ runMode: "LIVE" }));
    expect(unmodelled.accepted).toBe(false);
    expect(unmodelled.refusalCode).toBe("SIMULATED_VENUE_RUN_MODE_REQUIRES_LIVE_SIGNER");
    expect(unmodelled.rateLimitModel).toBe("NOT_MODELED");
    expect(unmodelled.rateLimitDisclosure).toContain("no venue budget model");

    const modelled = await venue({
      rateLimits: tokenBucketRateLimits({
        orderTokensPerWindow: 5,
        cancelTokensPerWindow: 5,
        windowMs: 60_000,
        snapshotVersion: "test/rate-limits/v1",
      }),
    }).submit(placement({ runMode: "LIVE" }));
    expect(modelled.accepted).toBe(false);
    expect(modelled.rateLimitModel).toBe("MODELED");
    expect(modelled.rateLimitDisclosure).toContain("test/rate-limits/v1");
  });

  it("also carries them when the refusal comes from an internal containment", async () => {
    const hostile = venue({ startingCash: "1,000" });
    const result = await hostile.submit(placement());
    expect(result.accepted).toBe(false);
    expect(result.rateLimitModel).toBe("NOT_MODELED");
    expect(result.rateLimitDisclosure).toContain("no venue budget model");
    expect(result.venueClass).toBe("SIMULATED");
    expect(result.planningDepthAwareness).toBe("TOP_OF_BOOK_ONLY");
  });
});

describe("a crossing REST order that is NOT postOnly matches, and marketable orders are unchanged", () => {
  it("a crossing non-postOnly REST order takes the offered depth", async () => {
    const simulated = venue({
      books: { book: () => sidedBook([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]) },
    });
    const result = await simulated.submit(
      planWith(order({ executionStyle: "REST", postOnly: false, limitPrice: "0.6" })),
    );
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.liquidityRole).toBe("TAKER");
    expect(result.orders[0]?.state).toBe("FILLED");
  });

  it("a MARKETABLE_LIMIT order still consumes depth immediately", async () => {
    const result = await venue().submit(planWith(order({ executionStyle: "MARKETABLE_LIMIT" })));
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.price).toBe("0.5");
    expect(result.orders[0]?.fillEstimateKind).toBe("POINT");
  });

  it("a REST order the policy gives a FAK/FOK time-in-force is refused", async () => {
    const simulated = venue({
      books: { book: () => sidedBook([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]) },
      policy: { ...POLICY, timeInForceFor: () => "FAK" },
    });
    const result = await simulated.submit(planWith(order({ executionStyle: "REST", limitPrice: "0.45" })));
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_PLAN_UNSUPPORTED");
    expect(result.refusalMessage).toContain("does not rest");
  });
});

describe("§6 invariant 13 — a failed SAFETY_CANCEL is never reported as a success", () => {
  it("a CANCEL plan that cancelled nothing is NOT accepted, and says what it missed", async () => {
    const result = await venue().submit({
      ...cancelPlan(),
      scope: { orderIds: ["never-existed"] },
    });
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_CANCEL_INCOMPLETE");
    expect(result.notCancelled).toEqual([
      { simulatedOrderId: "never-existed", reason: "SIMULATED_VENUE_UNKNOWN_ORDER" },
    ]);
  });

  it("a CANCEL plan that cancelled everything it named IS accepted", async () => {
    const simulated = venue({
      books: { book: () => sidedBook([{ price: "0.4", size: "100" }], [{ price: "0.5", size: "100" }]) },
    });
    await simulated.submit(planWith(order({ executionStyle: "REST", limitPrice: "0.45" })));
    const result = await simulated.submit({ ...cancelPlan(), scope: { orderIds: ["order-1"] } });
    expect(result.accepted).toBe(true);
    expect(result.notCancelled).toEqual([]);
    expect(result.orders[0]?.state).toBe("CANCELLED");
  });
});
