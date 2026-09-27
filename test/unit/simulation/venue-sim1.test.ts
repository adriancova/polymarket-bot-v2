/**
 * SIM-1 — `SimulatedVenue` correctness, pinned at the venue.
 *
 * - The user's ruling R3, PER-ORDER RESULTS: a plan's local checks run for the
 *   WHOLE plan before anything is booked; rate-limit admission is per BATCH of
 *   at most 15 orders, all-or-nothing (D-05, ADR-012 §5.6); and whatever was
 *   booked is REPORTED — `outcome: "PARTIAL"`, the booked orders in `orders`,
 *   the rest in `notPlaced` with their own refusals — on every path, the
 *   containment path included (`PP-1..5`).
 * - The orchestrator calls O1-O8 and O10: a FAK remainder is CANCELLED (O1);
 *   a Tier-0 FOK is all-or-nothing (O2); a GTC/GTD remainder RESTS (O3); a
 *   partly filled GTD EXPIRES, on any recorded event (O4); DELAYED is pending
 *   until `matchableAtNs` (O5); a market-scoped cancel targets LIVE orders only
 *   (O6); REJECTED is not cancellable (O7); a cancel re-stamps `atEvent` (O8);
 *   and a throw while resting an order leaves no orphan resting record (O10).
 *
 * Every economic value asserted here is derived in the comment beside it.
 * PAPER/BACKTEST only: no network, credential, signer or real order.
 */

import { describe, expect, it } from "vitest";

import {
  SimulatedVenue,
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
  type RateLimitBudget,
  type RecordedEventIdentity,
  type ReplayClock,
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

const MARKET_A = "0190a3e0-0000-7000-8000-00000000000a";
const MARKET_B = "0190a3e0-0000-7000-8000-00000000000b";
/** The clock's start: 1 s of recorded monotonic time. */
const START_NS = 1_000_000_000n;
const SECOND_NS = 1_000_000_000n;

function event(ingestSeq: number): RecordedEventIdentity {
  return {
    gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
    ingestSeq: String(ingestSeq),
    receivedAt: `2026-01-01T00:00:${String(ingestSeq).padStart(2, "0")}.000Z`,
    datasetRowOrdinal: ingestSeq,
  };
}

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

function replayClock(): ReplayClock {
  const built = createReplayClock({
    receivedAt: "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: START_NS.toString(),
  });
  if (!built.ok) throw new Error("clock refused");
  return built.value;
}

/** Moves the clock to `START_NS + seconds`. */
function advance(clock: ReplayClock, seconds: number): void {
  const moved = clock.advanceTo({
    receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(),
    receivedMonotonicNs: (START_NS + BigInt(seconds) * SECOND_NS).toString(),
  });
  if (!moved.ok) throw new Error(`the clock refused: ${moved.refusal.message}`);
}

/** Bid 0.4 × 100; asks 0.5 × 30 then 0.6 × 20. */
function sidedBook(marketId: string) {
  return {
    internalMarketId: marketId,
    tokenId: marketId === MARKET_A ? "1234" : "5678",
    top: () => ({}),
    ladder: (side: "BID" | "ASK") =>
      side === "ASK"
        ? [
            { price: "0.5", size: "30" },
            { price: "0.6", size: "20" },
          ]
        : [{ price: "0.4", size: "100" }],
  };
}

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    timeInForceFor: () => "GTC",
    statedExpiryNsFor: () => undefined,
    sameInstantAdditionsFor: () => ({ observedShares: "0" }),
    ...overrides,
  };
}

interface Built {
  readonly venue: SimulatedVenue;
  readonly clock: ReplayClock;
}

/** A Tier-0 venue with books for MARKET_A only, positioned at event 1. */
function tier0(overrides: Partial<SimulatedVenueOptions> = {}): Built {
  const clock = replayClock();
  const venue = new SimulatedVenue({
    clock,
    runMode: "BACKTEST",
    model: tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: policy(),
    startingCash: "1000",
    books: { book: ({ marketId }) => (marketId === MARKET_A ? sidedBook(MARKET_A) : undefined) },
    ...overrides,
  });
  venue.observe(event(1));
  return { venue, clock };
}

/** A Tier-1 venue over MARKET_A's fixed book, with `secondsDelay`, positioned at event 1. */
function tier1(secondsDelay: number, overrides: Partial<SimulatedVenueOptions> = {}): Built {
  const clock = replayClock();
  const venue = new SimulatedVenue({
    clock,
    runMode: "BACKTEST",
    model: tier1Model({ fillModelVersion: "sim/tier1/v1", fillModelParametersHash: "0".repeat(64) }),
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: policy(),
    startingCash: "1000",
    timeline: { bookAt: () => ({ book: sidedBook(MARKET_A), atEvent: event(1) }) },
    latencyModel: LATENCY,
    streams: deriveStreams("42"),
    marketParameters: () => ({
      marketId: MARKET_A,
      tickSize: "0.01",
      minimumOrderSize: "1",
      secondsDelay,
      parametersVersion: 1,
    }),
    queueParameters: QUEUE,
    ...overrides,
  });
  venue.observe(event(1));
  return { venue, clock };
}

function order(id: string, overrides: Partial<PlannedOrderView> = {}): PlannedOrderView {
  return {
    plannedOrderId: id,
    marketId: MARKET_A,
    side: "YES",
    action: "BUY",
    limitPrice: "0.5",
    shares: "1",
    postOnly: false,
    executionStyle: "MARKETABLE_LIMIT",
    reservationId: `res-${id}`,
    ...overrides,
  };
}

/** One group per consecutive run of orders in the same market. */
function plan(orders: readonly PlannedOrderView[], overrides: Partial<PlacementPlanView> = {}): PlacementPlanView {
  const groups: { executionGroupId: string; marketId: string; tickSize: string; minimumOrderSize: string; orders: PlannedOrderView[] }[] = [];
  for (const planned of orders) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.marketId === planned.marketId) {
      last.orders.push(planned);
      continue;
    }
    groups.push({
      executionGroupId: `group-${String(groups.length)}`,
      marketId: planned.marketId,
      tickSize: "0.01",
      minimumOrderSize: "1",
      orders: [planned],
    });
  }
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
    groups,
    ...overrides,
  };
}

function cancelPlan(scope: CancelPlanView["scope"], executionPlanId = "plan-cancel"): CancelPlanView {
  return {
    executionPlanId,
    strategyInstanceId: "instance-1",
    runMode: "BACKTEST",
    plannedAt: "2026-01-01T00:00:00.000Z",
    deadline: "2026-01-01T00:00:10.000Z",
    planKind: "CANCEL",
    priority: "SAFETY_CANCEL",
    priceProtection: { mode: "NO_NEW_ORDERS" },
    escalation: { atDeadline: "ESCALATE_TO_RECONCILIATION" },
    scope,
    reason: "kill switch",
  };
}

function budget(orderTokensPerWindow: number, cancelTokensPerWindow = 100): RateLimitBudget {
  return tokenBucketRateLimits({
    orderTokensPerWindow,
    cancelTokensPerWindow,
    windowMs: 3_600_000,
    snapshotVersion: "test/sim-1",
  });
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
}

function states(venue: SimulatedVenue): string[] {
  return venue
    .ordersSnapshot()
    .map((booked) => `${booked.simulatedOrderId} ${booked.state} ${booked.filledShares}/${booked.requestedShares}`);
}

async function cash(venue: SimulatedVenue): Promise<string> {
  return (await venue.queryAccountState()).cashBalance;
}

// ---------------------------------------------------------------------------
// R3 — per-order results
// ---------------------------------------------------------------------------

describe("R3 — a plan's per-order outcome is reported, whatever part of it was booked", () => {
  it("the fully accepted shape: outcome ACCEPTED, every order listed, notPlaced empty", async () => {
    const { venue } = tier0();
    const result = await venue.submit(plan([order("o1"), order("o2")]));
    expect(result).toMatchObject({ accepted: true, outcome: "ACCEPTED", notPlaced: [], notCancelled: [] });
    expect(result.refusalCode).toBeUndefined();
    expect(result.orders.map((booked) => booked.plannedOrderId)).toEqual(["o1", "o2"]);
  });

  it("a 20-order plan refused at its SECOND batch reports the 15 booked orders and the 5 refused (modelled budget)", async () => {
    const { venue } = tier0({ rateLimits: budget(15) });
    const planned = ids("o", 20);
    const result = await venue.submit(plan(planned.map((id) => order(id))));
    expect(result).toMatchObject({ accepted: false, outcome: "PARTIAL", refusalCode: "SIMULATED_VENUE_RATE_LIMITED" });
    expect(result.orders.map((booked) => `${booked.plannedOrderId} ${booked.state}`)).toEqual(
      planned.slice(0, 15).map((id) => `${id} FILLED`),
    );
    expect(result.fills).toHaveLength(15);
    expect(result.notPlaced.map((entry) => `${entry.plannedOrderId} ${entry.refusalCode}`)).toEqual(
      planned.slice(15).map((id) => `${id} SIMULATED_VENUE_RATE_LIMITED`),
    );
    expect(result.refusalMessage).toContain("15 of 20 planned order(s) were BOOKED");
    expect(venue.ordersSnapshot().map((booked) => booked.plannedOrderId)).toEqual(planned.slice(0, 15));
    // 15 × (1 × 0.5 + fee 1 × 0.07 × 0.5 × 0.5 = 0.0175) = 7.7625.
    expect(await cash(venue)).toBe("992.2375");
  });

  it("a batch of at most 15 is admitted ALL-OR-NOTHING: 2 tokens and a 3-order plan book nothing and spend nothing", async () => {
    const { venue } = tier0({ rateLimits: budget(2) });
    const result = await venue.submit(plan([order("o1"), order("o2"), order("o3")]));
    expect(result).toMatchObject({ accepted: false, outcome: "REFUSED", orders: [], fills: [], refusalCode: "SIMULATED_VENUE_RATE_LIMITED" });
    expect(result.notPlaced.map((entry) => `${entry.plannedOrderId} ${entry.refusalCode}`)).toEqual([
      "o1 SIMULATED_VENUE_RATE_LIMITED",
      "o2 SIMULATED_VENUE_RATE_LIMITED",
      "o3 SIMULATED_VENUE_RATE_LIMITED",
    ]);
    expect(venue.ordersSnapshot()).toEqual([]);
    expect(await cash(venue)).toBe("1000");
    // Nothing was spent: a 2-order plan still fits the 2 tokens.
    const next = await venue.submit(plan([order("p1"), order("p2")], { executionPlanId: "plan-2" }));
    expect(next.outcome).toBe("ACCEPTED");
  });

  describe("a plan that fails its PRE-FLIGHT books nothing and spends nothing", () => {
    async function expectNothingBooked(
      built: Built,
      result: Awaited<ReturnType<SimulatedVenue["submit"]>>,
      code: string,
    ): Promise<void> {
      expect(result).toMatchObject({ accepted: false, outcome: "REFUSED", orders: [], fills: [], refusalCode: code });
      expect(built.venue.ordersSnapshot().filter((booked) => booked.executionPlanId === "plan-1")).toEqual([]);
      expect(built.venue.fills.filter((fill) => fill.simulatedOrderId.startsWith("o"))).toEqual([]);
    }

    it("a later planned order that is invalid", async () => {
      const built = tier0({ rateLimits: budget(2) });
      const result = await built.venue.submit(plan([order("o1"), order("o2", { shares: "0" })]));
      await expectNothingBooked(built, result, "SIMULATION_INPUT_INVALID");
      expect(result.notPlaced.map((entry) => `${entry.plannedOrderId} ${entry.refusalCode}`)).toEqual([
        "o1 SIMULATED_VENUE_ORDER_NOT_SUBMITTED",
        "o2 SIMULATION_INPUT_INVALID",
      ]);
      expect(await cash(built.venue)).toBe("1000");
      // No token was spent.
      expect((await built.venue.submit(plan([order("p1"), order("p2")], { executionPlanId: "plan-2" }))).outcome).toBe("ACCEPTED");
    });

    it("a duplicate id WITHIN the plan (the first occurrence used to be booked)", async () => {
      const built = tier0();
      const result = await built.venue.submit(plan([order("o1"), order("o2"), order("o1")]));
      await expectNothingBooked(built, result, "SIMULATED_VENUE_DUPLICATE_ORDER");
      expect(result.notPlaced.map((entry) => `${entry.plannedOrderId} ${entry.refusalCode}`)).toEqual([
        "o1 SIMULATED_VENUE_DUPLICATE_ORDER",
        "o2 SIMULATED_VENUE_ORDER_NOT_SUBMITTED",
      ]);
    });

    it("a duplicate id against the venue's book leaves the booked order untouched", async () => {
      const built = tier0();
      await built.venue.submit(plan([order("x1")], { executionPlanId: "plan-0" }));
      const result = await built.venue.submit(plan([order("o1"), order("x1")]));
      await expectNothingBooked(built, result, "SIMULATED_VENUE_DUPLICATE_ORDER");
      expect(states(built.venue)).toEqual(["x1 FILLED 1/1"]);
    });

    it("a malformed later group", async () => {
      const built = tier0();
      const good = plan([order("o1")]);
      const result = await built.venue.submit({
        ...good,
        groups: [...good.groups, { executionGroupId: "bad", marketId: MARKET_A, tickSize: "0.01", minimumOrderSize: "1" } as never],
      });
      await expectNothingBooked(built, result, "SIMULATION_INPUT_INVALID");
      expect(result.notPlaced.map((entry) => entry.refusalCode)).toEqual(["SIMULATED_VENUE_ORDER_NOT_SUBMITTED"]);
    });

    it("an order type the policy states for a later order that the venue cannot serve", async () => {
      const built = tier0({
        policy: policy({ timeInForceFor: (planned) => (planned.plannedOrderId === "o2" ? "FAK" : "GTC") }),
      });
      const result = await built.venue.submit(plan([order("o1"), order("o2", { executionStyle: "REST", limitPrice: "0.3" })]));
      await expectNothingBooked(built, result, "SIMULATED_VENUE_PLAN_UNSUPPORTED");
    });

    it("an execution policy that THROWS for a later order (it used to book the earlier ones)", async () => {
      const built = tier0({
        policy: policy({
          timeInForceFor: (planned) => {
            if (planned.plannedOrderId === "o2") throw new Error("no time-in-force was recorded for o2");
            return "GTC";
          },
        }),
      });
      const result = await built.venue.submit(plan([order("o1"), order("o2")]));
      await expectNothingBooked(built, result, "SIMULATION_INTERNAL");
      expect(result.executionPlanId).toBe("plan-1");
    });
  });

  it("an execution refusal after booking started: each entry of the batch stands on its own", async () => {
    // o2 names MARKET_B, for which the venue has no book.
    const { venue } = tier0();
    const result = await venue.submit(plan([order("o1"), order("o2", { marketId: MARKET_B }), order("o3")]));
    expect(result).toMatchObject({ accepted: false, outcome: "PARTIAL", refusalCode: "SIMULATED_VENUE_NO_BOOK" });
    expect(result.orders.map((booked) => booked.plannedOrderId)).toEqual(["o1", "o3"]);
    expect(result.notPlaced.map((entry) => `${entry.plannedOrderId} ${entry.refusalCode}`)).toEqual([
      "o2 SIMULATED_VENUE_NO_BOOK",
    ]);
    expect(states(venue)).toEqual(["o1 FILLED 1/1", "o3 FILLED 1/1"]);
  });

  it("after a batch with a failure, the LATER batches are not sent", async () => {
    const { venue } = tier0();
    const planned = ids("o", 17);
    const result = await venue.submit(
      plan(planned.map((id) => order(id, id === "o02" ? { marketId: MARKET_B } : {}))),
    );
    expect(result.outcome).toBe("PARTIAL");
    expect(result.orders).toHaveLength(14);
    expect(result.notPlaced.map((entry) => `${entry.plannedOrderId} ${entry.refusalCode}`)).toEqual([
      "o02 SIMULATED_VENUE_NO_BOOK",
      "o16 SIMULATED_VENUE_ORDER_NOT_SUBMITTED",
      "o17 SIMULATED_VENUE_ORDER_NOT_SUBMITTED",
    ]);
  });

  describe("a THROW after booking started still reports what was booked (PP-3)", () => {
    it("a policy that throws while one order is being rested: that order is refused, the booked one is listed", async () => {
      const { venue } = tier0({
        policy: policy({
          sameInstantAdditionsFor: () => {
            throw new Error("the root could not answer");
          },
        }),
      });
      // o1 takes (no same-instant question); o2 rests below the ask and throws.
      const result = await venue.submit(plan([order("o1"), order("o2", { executionStyle: "REST", limitPrice: "0.3" })]));
      expect(result).toMatchObject({ executionPlanId: "plan-1", accepted: false, outcome: "PARTIAL", refusalCode: "SIMULATION_INTERNAL" });
      expect(result.orders.map((booked) => `${booked.plannedOrderId} ${booked.state}`)).toEqual(["o1 FILLED"]);
      expect(result.notPlaced.map((entry) => `${entry.plannedOrderId} ${entry.refusalCode}`)).toEqual([
        "o2 SIMULATION_INTERNAL",
      ]);
      expect(states(venue)).toEqual(["o1 FILLED 1/1"]);
    });

    it("a budget whose answer throws on the second batch: the containment path lists the 15 booked", async () => {
      let asked = 0;
      const hostile: RateLimitBudget = {
        modelKind: "MODELED",
        disclosure: "a hostile budget (test)",
        admit() {
          asked += 1;
          if (asked === 1) return { admitted: true };
          return {
            get admitted(): boolean {
              throw new Error("the budget's answer could not be read");
            },
          };
        },
      };
      const { venue } = tier0({ rateLimits: hostile });
      const planned = ids("o", 20);
      const result = await venue.submit(plan(planned.map((id) => order(id))));
      expect(result).toMatchObject({ executionPlanId: "plan-1", accepted: false, outcome: "PARTIAL", refusalCode: "SIMULATION_INTERNAL" });
      expect(result.orders.map((booked) => booked.plannedOrderId)).toEqual(planned.slice(0, 15));
      expect(result.fills).toHaveLength(15);
      expect(result.notPlaced.map((entry) => `${entry.plannedOrderId} ${entry.refusalCode}`)).toEqual(
        planned.slice(15).map((id) => `${id} SIMULATION_INTERNAL`),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// O1-O4 — every dead remainder is terminal, or registered to rest
// ---------------------------------------------------------------------------

describe("O1 — a FAK order that partly fills is CANCELLED, keeping what it filled (TERM-A)", () => {
  it("Tier 0: 50 against 30 available → CANCELLED 30/50; nothing of it rests", async () => {
    const { venue } = tier0({ policy: policy({ timeInForceFor: () => "FAK" }) });
    const result = await venue.submit(plan([order("fak", { shares: "50" })]));
    expect(result.outcome).toBe("ACCEPTED");
    expect(states(venue)).toEqual(["fak CANCELLED 30/50"]);
    expect((await venue.queryAccountState()).openOrders).toEqual([]);
    // It cannot fill again: a trade at its limit produces nothing.
    const traded = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.5", shares: "100", monotonicNs: START_NS, atEvent: event(2) });
    expect(traded.ok && traded.value.fills).toEqual([]);
    const cancel = await venue.cancel({ executionPlanId: "c", reason: "r", scope: { orderIds: ["fak"] }, priority: "SAFETY_CANCEL" });
    expect(cancel.notCancelled).toEqual([{ simulatedOrderId: "fak", reason: "already CANCELLED" }]);
  });

  it("Tier 1 (no delay): the same order is CANCELLED 30/50", async () => {
    const { venue } = tier1(0, { policy: policy({ timeInForceFor: () => "FAK" }) });
    await venue.submit(plan([order("fak", { shares: "50" })]));
    expect(states(venue)).toEqual(["fak CANCELLED 30/50"]);
  });
});

describe("O2 — a Tier-0 FOK is all-or-nothing, as Tier 1's is (TERM-G)", () => {
  it("50 against 30 available → REJECTED 0/50, no fill, no cash, no position", async () => {
    const { venue } = tier0({ policy: policy({ timeInForceFor: () => "FOK" }) });
    const result = await venue.submit(plan([order("fok", { shares: "50" })]));
    expect(result.fills).toEqual([]);
    expect(states(venue)).toEqual(["fok REJECTED 0/50"]);
    expect(venue.fills).toEqual([]);
    const account = await venue.queryAccountState();
    expect(account.cashBalance).toBe("1000");
    expect(account.positions).toEqual([]);
    expect(account.openOrders).toEqual([]);
  });

  it("a FOK the book can fill whole is FILLED", async () => {
    const { venue } = tier0({ policy: policy({ timeInForceFor: () => "FOK" }) });
    await venue.submit(plan([order("fok", { shares: "20" })]));
    expect(states(venue)).toEqual(["fok FILLED 20/20"]);
  });

  it("Tier 1 agrees: REJECTED 0/50", async () => {
    const { venue } = tier1(0, { policy: policy({ timeInForceFor: () => "FOK" }) });
    await venue.submit(plan([order("fok", { shares: "50" })]));
    expect(states(venue)).toEqual(["fok REJECTED 0/50"]);
  });
});

describe("O3 — a MARKETABLE_LIMIT GTC/GTD remainder is REGISTERED to rest (TERM-B)", () => {
  it("Tier 0: 50 at ≤ 0.5 against 30 → PARTIALLY_FILLED 30/50; a later trade at its limit fills the 20 as a MAKER", async () => {
    const { venue } = tier0();
    await venue.submit(plan([order("gtc", { shares: "50" })]));
    expect(states(venue)).toEqual(["gtc PARTIALLY_FILLED 30/50"]);
    expect((await venue.queryAccountState()).openOrders.map((open) => open.simulatedOrderId)).toEqual(["gtc"]);
    const traded = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.5", shares: "5", monotonicNs: START_NS, atEvent: event(2) });
    expect(traded.ok).toBe(true);
    expect(states(venue)).toEqual(["gtc FILLED 50/50"]);
    expect(venue.fills.map((fill) => `${fill.shares}@${fill.price} ${fill.liquidityRole} fee=${fill.feeAmount}`)).toEqual([
      "30@0.5 TAKER fee=0.525",
      "20@0.5 MAKER fee=0",
    ]);
    // 1000 − (30 × 0.5 + 0.525) − 20 × 0.5 = 974.475.
    expect(await cash(venue)).toBe("974.475");
    expect(venue.ordersSnapshot()[0]?.atEvent).toEqual(event(2));
  });

  it("Tier 0: a GTC that crosses nothing RESTS registered, and fills on touch", async () => {
    const { venue } = tier0();
    await venue.submit(plan([order("gtc", { limitPrice: "0.45", shares: "10" })]));
    expect(states(venue)).toEqual(["gtc RESTING 0/10"]);
    venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.45", shares: "1", monotonicNs: START_NS, atEvent: event(2) });
    expect(states(venue)).toEqual(["gtc FILLED 10/10"]);
  });

  it("Tier 1: the remainder rests with its §12.2 BAND", async () => {
    const { venue } = tier1(0);
    const result = await venue.submit(plan([order("gtc", { shares: "50" })]));
    expect(states(venue)).toEqual(["gtc PARTIALLY_FILLED 30/50"]);
    expect(venue.ordersSnapshot()[0]?.fillEstimateKind).toBe("TIER_1_RESTING_BAND");
    expect(result.bands.map((band) => band.simulatedOrderId)).toEqual(["gtc"]);
    expect(venue.restingBands().map((band) => band.simulatedOrderId)).toEqual(["gtc"]);
  });
});

describe("O4 — a partly filled GTD EXPIRES at its expiry, keeping what it filled (TERM-C)", () => {
  // Stated expiry 120 s after the start; GTD expires 60 s early (ADR-012 §5.2).
  const GTD = policy({ timeInForceFor: () => "GTD", statedExpiryNsFor: () => START_NS + 120n * SECOND_NS });
  const EFFECTIVE_EXPIRY_NS = START_NS + 60n * SECOND_NS;

  it("on a trade in its own market and side at the expiry", async () => {
    const { venue } = tier0({ policy: GTD });
    await venue.submit(plan([order("gtd", { shares: "50" })]));
    expect(states(venue)).toEqual(["gtd PARTIALLY_FILLED 30/50"]);
    venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.5", shares: "5", monotonicNs: EFFECTIVE_EXPIRY_NS, atEvent: event(2) });
    expect(states(venue)).toEqual(["gtd EXPIRED 30/50"]);
    expect(venue.ordersSnapshot()[0]?.atEvent).toEqual(event(2));
    // It can never fill again.
    const later = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.4", shares: "5", monotonicNs: EFFECTIVE_EXPIRY_NS + 1n, atEvent: event(3) });
    expect(later.ok && later.value.fills).toEqual([]);
    expect((await venue.queryAccountState()).openOrders).toEqual([]);
  });

  it("in a QUIET market: the next recorded event past the expiry expires it (VS-05b), with no trade anywhere", async () => {
    const { venue, clock } = tier0({ policy: GTD });
    await venue.submit(plan([order("gtd", { shares: "50" }), order("gtd-rest", { executionStyle: "REST", limitPrice: "0.3", shares: "10" })]));
    expect(states(venue)).toEqual(["gtd PARTIALLY_FILLED 30/50", "gtd-rest RESTING 0/10"]);
    advance(clock, 59);
    venue.observe(event(2));
    expect(states(venue)).toEqual(["gtd PARTIALLY_FILLED 30/50", "gtd-rest RESTING 0/10"]);
    advance(clock, 60);
    venue.observe(event(3));
    expect(states(venue)).toEqual(["gtd EXPIRED 30/50", "gtd-rest EXPIRED 0/10"]);
    expect(venue.ordersSnapshot().map((booked) => booked.atEvent.ingestSeq)).toEqual(["3", "3"]);
  });

  it("a trade in ANOTHER market past the expiry expires it too", async () => {
    const { venue } = tier0({ policy: GTD });
    await venue.submit(plan([order("gtd", { shares: "50" })]));
    venue.observeTrade({ marketId: MARKET_B, side: "NO", price: "0.5", shares: "5", monotonicNs: EFFECTIVE_EXPIRY_NS, atEvent: event(2) });
    expect(states(venue)).toEqual(["gtd EXPIRED 30/50"]);
  });
});

// ---------------------------------------------------------------------------
// O5 — DELAYED is pending until matchableAtNs (ADR-012 §5.1, D-18)
// ---------------------------------------------------------------------------

describe("O5 — a DELAYED order is pending until matchableAtNs, then takes its already-computed disposition (TERM-D)", () => {
  // secondsDelay 5 and zero latency: submitted at START_NS, matchable at +5 s.
  const FAK = policy({ timeInForceFor: () => "FAK" });

  it("its fills are NOT booked before matchableAtNs, and ARE booked at it", async () => {
    const { venue, clock } = tier1(5, { policy: FAK });
    const result = await venue.submit(plan([order("fak", { shares: "50" })]));
    expect(result.outcome).toBe("ACCEPTED");
    expect(result.orders.map((booked) => `${booked.state} ${booked.filledShares}`)).toEqual(["DELAYED 0"]);
    expect(result.fills).toEqual([]);
    expect(venue.fills).toEqual([]);
    expect(await cash(venue)).toBe("1000");
    expect((await venue.queryAccountState()).openOrders.map((open) => open.state)).toEqual(["DELAYED"]);

    advance(clock, 4);
    venue.observe(event(2));
    expect(states(venue)).toEqual(["fak DELAYED 0/50"]);
    expect(venue.fills).toEqual([]);

    advance(clock, 5);
    venue.observe(event(3));
    // The already-computed FAK disposition: 30 filled, the rest cancelled.
    expect(states(venue)).toEqual(["fak CANCELLED 30/50"]);
    expect(venue.ordersSnapshot()[0]?.atEvent).toEqual(event(3));
    expect(venue.fills.map((fill) => `${fill.shares}@${fill.price}`)).toEqual(["30@0.5"]);
    // 1000 − (30 × 0.5 + 30 × 0.07 × 0.5 × 0.5 = 0.525) = 984.475.
    expect(await cash(venue)).toBe("984.475");
    expect((await venue.queryAccountState()).openOrders).toEqual([]);
  });

  it("a cancel inside the window is REFUSED and the order is unchanged — by id, by market scope, and as a SAFETY_CANCEL plan", async () => {
    const { venue, clock } = tier1(5, { policy: FAK });
    await venue.submit(plan([order("fak", { shares: "50" })]));
    const byId = await venue.cancel({ executionPlanId: "c1", reason: "r", scope: { orderIds: ["fak"] }, priority: "SAFETY_CANCEL" });
    expect(byId.cancelled).toEqual([]);
    expect(byId.notCancelled.map((entry) => entry.simulatedOrderId)).toEqual(["fak"]);
    expect(byId.notCancelled[0]?.reason).toContain("DELAYED");
    expect(byId.notCancelled[0]?.reason).toContain("cannot be canceled");
    const byMarket = await venue.cancel({ executionPlanId: "c2", reason: "r", scope: { marketId: MARKET_A }, priority: "SAFETY_CANCEL" });
    expect(byMarket.notCancelled.map((entry) => entry.simulatedOrderId)).toEqual(["fak"]);
    const asPlan = await venue.submit(cancelPlan({ marketId: MARKET_A }));
    expect(asPlan).toMatchObject({ accepted: false, outcome: "REFUSED", refusalCode: "SIMULATED_VENUE_CANCEL_INCOMPLETE" });
    expect(states(venue)).toEqual(["fak DELAYED 0/50"]);
    // Once the window has closed the order is terminal, and a cancel says so.
    advance(clock, 5);
    const after = await venue.cancel({ executionPlanId: "c3", reason: "r", scope: { orderIds: ["fak"] }, priority: "SAFETY_CANCEL" });
    expect(after.notCancelled).toEqual([{ simulatedOrderId: "fak", reason: "already CANCELLED" }]);
  });

  it("a DELAYED GTD that expires before matching becomes EXPIRED at matchableAtNs", async () => {
    // Stated expiry 62 s → effective 2 s, before the 5 s it could match.
    const { venue, clock } = tier1(5, {
      policy: policy({ timeInForceFor: () => "GTD", statedExpiryNsFor: () => START_NS + 62n * SECOND_NS }),
    });
    await venue.submit(plan([order("gtd", { shares: "50" })]));
    expect(states(venue)).toEqual(["gtd DELAYED 0/50"]);
    advance(clock, 5);
    venue.observe(event(2));
    expect(states(venue)).toEqual(["gtd EXPIRED 0/50"]);
  });

  it("a DELAYED FOK the book cannot fill whole becomes REJECTED at matchableAtNs", async () => {
    const { venue, clock } = tier1(5, { policy: policy({ timeInForceFor: () => "FOK" }) });
    await venue.submit(plan([order("fok", { shares: "50" })]));
    // Pending until the window closes — not REJECTED at submission.
    expect(states(venue)).toEqual(["fok DELAYED 0/50"]);
    advance(clock, 5);
    venue.observe(event(2));
    expect(states(venue)).toEqual(["fok REJECTED 0/50"]);
    expect(venue.fills).toEqual([]);
  });

  it("a DELAYED GTC's remainder rests at matchableAtNs, with its band — resolved by a trade at that instant", async () => {
    const { venue } = tier1(5);
    await venue.submit(plan([order("gtc", { shares: "50" })]));
    expect(venue.restingBands()).toEqual([]);
    const traded = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.5", shares: "5", monotonicNs: START_NS + 5n * SECOND_NS, atEvent: event(2) });
    expect(traded.ok).toBe(true);
    if (!traded.ok) return;
    // The swept fills travel on the answer of the call that settled them.
    expect(traded.value.fills.map((fill) => `${fill.shares}@${fill.price}`)).toEqual(["30@0.5"]);
    expect(traded.value.bands.map((band) => band.simulatedOrderId)).toContain("gtc");
    expect(states(venue)).toEqual(["gtc PARTIALLY_FILLED 30/50"]);
    expect(venue.ordersSnapshot()[0]?.fillEstimateKind).toBe("TIER_1_RESTING_BAND");
    expect(venue.restingBands().map((band) => band.simulatedOrderId)).toEqual(["gtc"]);
  });

  it("a DELAYED order the book fills whole becomes FILLED at matchableAtNs", async () => {
    const { venue, clock } = tier1(5, { policy: FAK });
    const result = await venue.submit(plan([order("fak", { shares: "20" })]));
    // Pending, with nothing filled and no fill booked, until the window closes.
    expect(result.fills).toEqual([]);
    expect(states(venue)).toEqual(["fak DELAYED 0/20"]);
    expect(venue.fills).toEqual([]);
    advance(clock, 5);
    venue.observe(event(2));
    expect(states(venue)).toEqual(["fak FILLED 20/20"]);
  });
});

// ---------------------------------------------------------------------------
// O6-O8 — cancels
// ---------------------------------------------------------------------------

describe("O6 — a market-scoped cancel targets LIVE orders only (VS-13 / TERM-H)", () => {
  it("history is not a target: a sweep that cancelled every live order is ACCEPTED", async () => {
    const { venue } = tier0();
    await venue.submit(plan([order("filled"), order("resting", { executionStyle: "REST", limitPrice: "0.3" })]));
    expect(states(venue)).toEqual(["filled FILLED 1/1", "resting RESTING 0/1"]);
    const result = await venue.submit(cancelPlan({ marketId: MARKET_A }));
    expect(result).toMatchObject({ accepted: true, outcome: "ACCEPTED", notCancelled: [], notPlaced: [] });
    expect(result.refusalCode).toBeUndefined();
    expect(result.orders.map((cancelled) => `${cancelled.simulatedOrderId} ${cancelled.state}`)).toEqual(["resting CANCELLED"]);
  });

  it("history is not CHARGED: 60 filled orders and one resting, against a budget of 50 cancels, still cancel the resting one", async () => {
    const { venue } = tier0({ rateLimits: budget(1_000, 50) });
    const filled = ids("h", 60);
    for (const [index, id] of filled.entries()) {
      await venue.submit(plan([order(id)], { executionPlanId: `plan-h${String(index)}` }));
    }
    await venue.submit(plan([order("live", { executionStyle: "REST", limitPrice: "0.3" })], { executionPlanId: "plan-live" }));
    const result = await venue.cancel({ executionPlanId: "c", reason: "r", scope: { marketId: MARKET_A }, priority: "SAFETY_CANCEL" });
    expect(result).toMatchObject({ cancelled: ["live"], notCancelled: [] });
  });

  it("with NO live target it is a successful no-op, and charges nothing", async () => {
    const { venue } = tier0({ rateLimits: budget(100, 1) });
    await venue.submit(plan([order("filled")]));
    const direct = await venue.cancel({ executionPlanId: "c1", reason: "r", scope: { marketId: MARKET_A }, priority: "SAFETY_CANCEL" });
    expect(direct).toEqual({ executionPlanId: "c1", cancelled: [], notCancelled: [], venueClass: "SIMULATED" });
    const asPlan = await venue.submit(cancelPlan({ marketId: MARKET_A }));
    expect(asPlan).toMatchObject({
      executionPlanId: "plan-cancel",
      accepted: true,
      outcome: "ACCEPTED",
      orders: [],
      fills: [],
      bands: [],
      notCancelled: [],
      notPlaced: [],
    });
    expect(asPlan.refusalCode).toBeUndefined();
    // The single cancel token was never spent: a real cancel still lands.
    await venue.submit(plan([order("resting", { executionStyle: "REST", limitPrice: "0.3" })], { executionPlanId: "plan-2" }));
    const real = await venue.cancel({ executionPlanId: "c2", reason: "r", scope: { marketId: MARKET_A }, priority: "SAFETY_CANCEL" });
    expect(real.cancelled).toEqual(["resting"]);
  });
});

describe("O7 — a REJECTED order is not cancellable, on any cancel path (TERM-E)", () => {
  async function rejected(): Promise<SimulatedVenue> {
    const { venue } = tier0();
    // A postOnly REST BUY at 0.5 crosses the 0.5 ask: REJECTED, unfilled.
    await venue.submit(plan([order("po", { executionStyle: "REST", postOnly: true })]));
    expect(states(venue)).toEqual(["po REJECTED 0/1"]);
    return venue;
  }

  it("by id: notCancelled 'already REJECTED', and the order is unchanged", async () => {
    const venue = await rejected();
    const before = venue.ordersSnapshot()[0];
    const result = await venue.cancel({ executionPlanId: "c", reason: "r", scope: { orderIds: ["po"] }, priority: "SAFETY_CANCEL" });
    expect(result).toMatchObject({ cancelled: [], notCancelled: [{ simulatedOrderId: "po", reason: "already REJECTED" }] });
    expect(venue.ordersSnapshot()[0]).toEqual(before);
  });

  it("by market scope: it is not a target", async () => {
    const venue = await rejected();
    const result = await venue.cancel({ executionPlanId: "c", reason: "r", scope: { marketId: MARKET_A }, priority: "SAFETY_CANCEL" });
    expect(result).toMatchObject({ cancelled: [], notCancelled: [] });
    expect(states(venue)).toEqual(["po REJECTED 0/1"]);
  });

  it("as a SAFETY_CANCEL plan, by id and by market", async () => {
    const venue = await rejected();
    const byId = await venue.submit(cancelPlan({ orderIds: ["po"] }));
    expect(byId).toMatchObject({ accepted: false, outcome: "REFUSED", refusalCode: "SIMULATED_VENUE_CANCEL_INCOMPLETE" });
    expect(byId.notCancelled).toEqual([{ simulatedOrderId: "po", reason: "already REJECTED" }]);
    const byMarket = await venue.submit(cancelPlan({ marketId: MARKET_A }, "plan-cancel-2"));
    expect(byMarket).toMatchObject({ accepted: true, orders: [] });
    expect(states(venue)).toEqual(["po REJECTED 0/1"]);
  });
});

describe("O8 — a cancel re-stamps the order's atEvent with the event it was cancelled at (TERM-I)", () => {
  it("through cancel() and through a CANCEL plan", async () => {
    const { venue } = tier0();
    await venue.submit(plan([order("a", { executionStyle: "REST", limitPrice: "0.3" }), order("b", { executionStyle: "REST", limitPrice: "0.3" })]));
    expect(venue.ordersSnapshot().map((booked) => booked.atEvent.ingestSeq)).toEqual(["1", "1"]);
    venue.observe(event(2));
    await venue.cancel({ executionPlanId: "c", reason: "r", scope: { orderIds: ["a"] }, priority: "SAFETY_CANCEL" });
    venue.observe(event(3));
    const result = await venue.submit(cancelPlan({ orderIds: ["b"] }));
    expect(result.orders[0]?.atEvent).toEqual(event(3));
    expect(venue.ordersSnapshot().map((booked) => `${booked.simulatedOrderId} ${booked.state} ${booked.atEvent.ingestSeq}`)).toEqual([
      "a CANCELLED 2",
      "b CANCELLED 3",
    ]);
  });
});

// ---------------------------------------------------------------------------
// O10 — a throw while resting leaves no orphan resting record (PP-17)
// ---------------------------------------------------------------------------

describe("O10 — a throw while an order is being rested leaves NO resting record behind (PP-17)", () => {
  it("a later touching trade fills nothing, and no cash moves", async () => {
    // The venue's `model` is read once more AFTER the policy's same-instant
    // answer while a REST order is being registered. An options bag whose
    // `model` throws exactly then stands in for any fault at that point.
    let armed = false;
    const model = tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) });
    const options: SimulatedVenueOptions = {
      clock: replayClock(),
      runMode: "BACKTEST",
      model,
      feeSnapshot: FEES,
      rateLimits: unmodeledRateLimits("none"),
      policy: policy({
        sameInstantAdditionsFor: () => {
          armed = true;
          return { observedShares: "0" };
        },
      }),
      startingCash: "1000",
      books: { book: () => sidedBook(MARKET_A) },
    };
    Object.defineProperty(options, "model", {
      enumerable: true,
      get() {
        if (armed) {
          armed = false;
          throw new Error("the model identity could not be read");
        }
        return model;
      },
    });
    const venue = new SimulatedVenue(options);
    venue.observe(event(1));
    const result = await venue.submit(plan([order("rest", { executionStyle: "REST", limitPrice: "0.3", shares: "10" })]));
    expect(result).toMatchObject({ accepted: false, outcome: "REFUSED", refusalCode: "SIMULATION_INTERNAL" });
    expect(result.notPlaced.map((entry) => entry.plannedOrderId)).toEqual(["rest"]);
    expect(venue.ordersSnapshot()).toEqual([]);
    const traded = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.3", shares: "10", monotonicNs: START_NS, atEvent: event(2) });
    expect(traded.ok && traded.value.fills).toEqual([]);
    expect(venue.fills).toEqual([]);
    expect(await cash(venue)).toBe("1000");
  });
});
