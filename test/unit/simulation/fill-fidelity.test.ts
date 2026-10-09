/**
 * V2-10 — simulation fill fidelity (Protocol V2 plan row D1).
 *
 * The venue facts this file pins, from `docs/venue/verified-2026-10-05.md`:
 *
 * - F-63 (S-D02 lines 135-149): "If you calculate fills yourself, use integer
 *   base units and the maker's signed amounts for each maker fill:"
 *   `counterAmount = floor(makerAssetFill × takerAmount / makerAmount)`;
 *   "`makerAssetFill` is collateral for a BUY and shares for a SELL. ExchangeV3
 *   reduces a BUY's remaining collateral budget by the amount actually spent.
 *   CLOB GTC/GTD BUY targets are shares; FOK/FAK BUY targets are collateral."
 *   "Reconcile fills and fees separately: BUY fees add to collateral spend;
 *   SELL fees are deducted from proceeds."
 * - F-73 (S-D04 lines 55-56): "Six-decimal base units: `1_000_000` is one pUSD
 *   or one share."
 * - F-64: the fee parameters equal V1's, so the fee formula
 *   (`fee = C × feeRate × p × (1 − p)`, `./fees.ts`) is unchanged.
 *
 * Sections: (1) the formula's golden; (2) the floor reaches every simulated
 * maker fill — taker fills on both ladders, Tier-0 maker fills, Tier-1 band
 * fills, the venue's cash and the replay economics; (3) the targets — FOK/FAK
 * BUYs target collateral, GTC/GTD BUYs and every SELL target shares, and the
 * ONE conversion at the limit price; (4) the fee path, unchanged.
 *
 * Every economic value is derived in the comment beside it, in base units
 * (1 share = 1 pUSD = 1 000 000). PAPER/BACKTEST only: no network,
 * credential, signing key or real order.
 */

import { describe, expect, it } from "vitest";

import {
  BASE_UNITS_PER_WHOLE,
  DEFAULT_FOK_FAK_BUY_TARGET,
  FOK_FAK_BUY_TARGETS,
  SimulatedVenue,
  checkBandOrdering,
  collateralTargetAtLimitPrice,
  consumeDepth,
  counterAmount,
  createReplayClock,
  deriveStreams,
  replayPathEconomics,
  simulateResting,
  simulatedFill,
  tier0Maker,
  tier0Model,
  tier1Immediate,
  tier1Model,
  unmodeledRateLimits,
  type BookLevelView,
  type ExecutionPolicy,
  type FeeScheduleSnapshot,
  type LatencyModel,
  type PlacementPlanView,
  type PlannedOrderView,
  type QueueModelParameters,
  type RecordedEventIdentity,
  type RestingFillBand,
  type SimulatedVenueOptions,
  type SimulationResult,
  type TimeInForce,
} from "../../../packages/simulation/src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The frozen 2026-08-24 snapshot (F-64: V2's parameters equal V1's). */
const FEES: FeeScheduleSnapshot = {
  snapshotVersion: "fees/2026-08-24",
  takerFeeRate: "0.07",
  makerFeeRate: "0",
  roundingDecimalPlaces: 5,
  roundingMode: "HALF_UP",
  minimumChargedFee: "0.00001",
  feeCurrency: "USDC",
};

const MARKET = "0190a3e0-0000-7000-8000-00000000000a";
const TOKEN = "1234";
const START_NS = 1_000_000_000n;

const TIER0 = tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) });
const TIER1 = tier1Model({ fillModelVersion: "sim/tier1/v1", fillModelParametersHash: "0".repeat(64) });

const LATENCY: LatencyModel = {
  latencyModelVersion: "sim/latency/v1",
  decision: { samples: [{ milliseconds: 0, weight: 1 }] },
  signing: { samples: [{ milliseconds: 0, weight: 1 }] },
  network: { samples: [{ milliseconds: 0, weight: 1 }] },
  venue: { samples: [{ milliseconds: 0, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

const QUEUE: QueueModelParameters = {
  queueModelVersion: "sim/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

function event(ingestSeq: number): RecordedEventIdentity {
  return {
    gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
    ingestSeq: String(ingestSeq),
    receivedAt: `2026-01-01T00:00:${String(ingestSeq).padStart(2, "0")}.000Z`,
    datasetRowOrdinal: ingestSeq,
  };
}

function unwrap<TValue>(result: SimulationResult<TValue>): TValue {
  if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

/** A book port over fixed ladders. */
function book(asks: readonly BookLevelView[], bids: readonly BookLevelView[]) {
  return {
    internalMarketId: MARKET,
    tokenId: TOKEN,
    top: () => ({}),
    ladder: (side: "BID" | "ASK") => (side === "ASK" ? asks : bids),
  };
}

/** Asks 0.4 × 100; bid 0.3 × 100. */
const DEEP_ASKS: readonly BookLevelView[] = [{ price: "0.4", size: "100" }];
/** Asks 0.4 × 5 only: 2 pUSD of depth inside a 0.5 limit. */
const THIN_ASKS: readonly BookLevelView[] = [{ price: "0.4", size: "5" }];
const BIDS: readonly BookLevelView[] = [{ price: "0.3", size: "100" }];

function policy(timeInForce: TimeInForce): ExecutionPolicy {
  return {
    timeInForceFor: () => timeInForce,
    // A GTD order states an expiry far past every event here.
    statedExpiryNsFor: () => (timeInForce === "GTD" ? START_NS + 3_600_000_000_000n : undefined),
    sameInstantAdditionsFor: () => "NOT_OBSERVED",
  };
}

function replayClock() {
  return unwrap(
    createReplayClock({ receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: START_NS.toString() }),
  );
}

/** A Tier-0 venue over one fixed book, positioned at event 1. */
function tier0Venue(
  timeInForce: TimeInForce,
  asks: readonly BookLevelView[],
  overrides: Partial<SimulatedVenueOptions> = {},
): SimulatedVenue {
  const venue = new SimulatedVenue({
    clock: replayClock(),
    runMode: "BACKTEST",
    model: TIER0,
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: policy(timeInForce),
    startingCash: "1000",
    books: { book: ({ marketId }) => (marketId === MARKET ? book(asks, BIDS) : undefined) },
    ...overrides,
  });
  venue.observe(event(1));
  return venue;
}

/** A Tier-1 venue over one fixed book (zero latency, no delay), positioned at event 1. */
function tier1Venue(
  timeInForce: TimeInForce,
  asks: readonly BookLevelView[],
  overrides: Partial<SimulatedVenueOptions> = {},
): SimulatedVenue {
  const venue = new SimulatedVenue({
    clock: replayClock(),
    runMode: "BACKTEST",
    model: TIER1,
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: policy(timeInForce),
    startingCash: "1000",
    timeline: { bookAt: () => ({ book: book(asks, BIDS), atEvent: event(1) }) },
    latencyModel: LATENCY,
    streams: deriveStreams("42"),
    marketParameters: () => ({
      marketId: MARKET,
      tickSize: "0.01",
      minimumOrderSize: "1",
      secondsDelay: 0,
      parametersVersion: 1,
    }),
    queueParameters: QUEUE,
    ...overrides,
  });
  venue.observe(event(1));
  return venue;
}

function order(overrides: Partial<PlannedOrderView> = {}): PlannedOrderView {
  return {
    plannedOrderId: "o-1",
    marketId: MARKET,
    side: "YES",
    action: "BUY",
    limitPrice: "0.5",
    shares: "10",
    postOnly: false,
    executionStyle: "MARKETABLE_LIMIT",
    reservationId: "res-o-1",
    ...overrides,
  };
}

function plan(planned: PlannedOrderView): PlacementPlanView {
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
        executionGroupId: "group-0",
        marketId: MARKET,
        tickSize: "0.01",
        minimumOrderSize: "1",
        orders: [planned],
      },
    ],
  };
}

async function cash(venue: SimulatedVenue): Promise<string> {
  return (await venue.queryAccountState()).cashBalance;
}

/** What the venue booked for its one order, compactly. */
function booked(venue: SimulatedVenue) {
  const [only] = venue.ordersSnapshot();
  if (only === undefined) throw new Error("the venue booked no order");
  return only;
}

// ---------------------------------------------------------------------------
// 1. The formula (F-63), golden
// ---------------------------------------------------------------------------

describe("V2-10 (1): F-63's counter amount, in integer base units", () => {
  it("is floor(makerAssetFill × takerAmount / makerAmount): the golden cases", () => {
    // F-73: one share = one pUSD = 1 000 000 base units.
    expect(BASE_UNITS_PER_WHOLE).toBe(1_000_000n);
    // Exact: a maker SELL of 10 shares at 0.47 (makerAmount : takerAmount = 100 : 47).
    // 10 000 000 × 47 / 100 = 4 700 000, no remainder.
    expect(unwrap(counterAmount(10_000_000n, 100n, 47n))).toBe(4_700_000n);
    // REMAINDER: 10 638 297 × 47 = 499 999 959; / 100 = 4 999 999.59 → 4 999 999.
    expect(unwrap(counterAmount(10_638_297n, 100n, 47n))).toBe(4_999_999n);
    // The maker's own SIGNED amounts: a SELL of 50 shares at 0.35 signs
    // makerAmount 50 000 000 (shares) and takerAmount 17 500 000 (pUSD). A fill
    // of 20 857 142 of its shares: × 17 500 000 / 50 000 000 = 7 299 999.7 → 7 299 999.
    expect(unwrap(counterAmount(20_857_142n, 50_000_000n, 17_500_000n))).toBe(7_299_999n);
    // A maker BUY (its asset is pUSD): BUY 10 at 0.47 signs makerAmount
    // 4 700 000 (pUSD), takerAmount 10 000 000 (shares). A fill of 2 base units
    // of its pUSD: 2 × 10 000 000 / 4 700 000 = 4.255… → 4 shares' base units.
    expect(unwrap(counterAmount(2n, 4_700_000n, 10_000_000n))).toBe(4n);
    // Zero fills to zero.
    expect(unwrap(counterAmount(0n, 100n, 47n))).toBe(0n);
  });

  it("FLOORS: never rounds half up, never rounds up, whatever the remainder", () => {
    // 19 × 1 / 10 = 1.9 → 1 (rounding would give 2).
    expect(unwrap(counterAmount(19n, 10n, 1n))).toBe(1n);
    // 15 × 1 / 10 = 1.5 → 1 (half-up would give 2).
    expect(unwrap(counterAmount(15n, 10n, 1n))).toBe(1n);
    // 11 × 1 / 10 = 1.1 → 1 (ceil would give 2).
    expect(unwrap(counterAmount(11n, 10n, 1n))).toBe(1n);
    // 999 999 × 1 / 1 000 000 = 0.999999 → 0.
    expect(unwrap(counterAmount(999_999n, 1_000_000n, 1n))).toBe(0n);
  });

  it("is floor by DEFINITION over an exhaustive grid: r × m ≤ f × t < (r + 1) × m", () => {
    for (let fill = 0n; fill <= 40n; fill += 1n) {
      for (let makerAmount = 1n; makerAmount <= 12n; makerAmount += 1n) {
        for (let takerAmount = 0n; takerAmount <= 12n; takerAmount += 1n) {
          const counter = unwrap(counterAmount(fill, makerAmount, takerAmount));
          expect(counter * makerAmount <= fill * takerAmount).toBe(true);
          expect(fill * takerAmount < (counter + 1n) * makerAmount).toBe(true);
        }
      }
    }
  });

  it("REFUSES what the formula does not define, rather than throwing", () => {
    // The formula divides by makerAmount.
    expect(counterAmount(10n, 0n, 1n)).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    expect(counterAmount(10n, -1n, 1n)).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    expect(counterAmount(-1n, 10n, 1n)).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    expect(counterAmount(1n, 10n, -1n)).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    // Integer base units only: a JavaScript number is not one (ADR-001).
    expect(counterAmount(1 as unknown as bigint, 10n, 1n)).toMatchObject({
      ok: false,
      refusal: { code: "SIMULATION_INPUT_INVALID" },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The floor reaches every simulated maker fill
// ---------------------------------------------------------------------------

describe("V2-10 (2): every simulated maker fill moves F-63's legs in whole base units", () => {
  it("a BUY taking an ask (the maker SELLS shares): its pUSD leg is floored", () => {
    // Maker SELL at 0.47, fill 10 638 297 share units → pUSD floor(… × 47 / 100) = 4 999 999.
    const walk = unwrap(
      consumeDepth({ ladder: [{ price: "0.47", size: "100" }], action: "BUY", limitPrice: "0.5", shares: "10.638297" }),
    );
    expect(walk.matched).toEqual([{ price: "0.47", shares: "10.638297", collateral: "4.999999" }]);
    expect(walk.collateral).toBe("4.999999");
    // The exact product is kept beside it, so the floor's effect is visible.
    expect(walk.notional).toBe("4.99999959");
    expect(walk).toMatchObject({ filledShares: "10.638297", remainingShares: "0", complete: true, target: "SHARES" });
  });

  it("a SELL hitting a bid (the maker BUYS with pUSD): the floor lands on the SHARES", () => {
    // Maker BUY at 0.47. SELL 10.000001: its pUSD fill is floor(10 000 001 × 47 / 100)
    // = floor(4 700 000.47) = 4 700 000; the shares that move are F-63's counter of
    // that, floor(4 700 000 × 100 / 47) = 10 000 000. The 1 unit left is the
    // floor's, not missing liquidity: the walk is COMPLETE.
    const walk = unwrap(
      consumeDepth({ ladder: [{ price: "0.47", size: "100" }], action: "SELL", limitPrice: "0.4", shares: "10.000001" }),
    );
    expect(walk.matched).toEqual([{ price: "0.47", shares: "10", collateral: "4.7" }]);
    expect(walk).toMatchObject({ filledShares: "10", remainingShares: "0.000001", complete: true });
    // A whole number of base units at the price moves exactly: 50 at 0.32 → 16.
    const round = unwrap(
      consumeDepth({ ladder: [{ price: "0.32", size: "100" }], action: "SELL", limitPrice: "0.3", shares: "50" }),
    );
    expect(round.matched).toEqual([{ price: "0.32", shares: "50", collateral: "16" }]);
    expect(round).toMatchObject({ remainingShares: "0", complete: true });
  });

  it("a quantity finer than one base unit is FLOORED before it fills (F-73), never rounded up", () => {
    // 10.0000005 shares at 0.4: 10 000 000.5 units → a fill of 10 000 000; the
    // half unit stays, and the walk is complete (its target ended it).
    const walk = unwrap(consumeDepth({ ladder: DEEP_ASKS, action: "BUY", limitPrice: "0.5", shares: "10.0000005" }));
    expect(walk.matched).toEqual([{ price: "0.4", shares: "10", collateral: "4" }]);
    expect(walk).toMatchObject({ filledShares: "10", remainingShares: "0.0000005", complete: true });
    // The same when the LEVEL, not the target, decided the fill and the ladder
    // then ends: what is left (0.0000005) is under one base unit, which no
    // further depth could fill, so the walk is complete rather than short.
    const levelBound = unwrap(
      consumeDepth({ ladder: [{ price: "0.4", size: "10.0000003" }], action: "BUY", limitPrice: "0.5", shares: "10.0000005" }),
    );
    expect(levelBound.matched).toEqual([{ price: "0.4", shares: "10", collateral: "4" }]);
    expect(levelBound).toMatchObject({ remainingShares: "0.0000005", complete: true, stoppedAtLimit: false });
  });

  it("a Tier-0 MAKER fill (our resting order is the maker): both sides", () => {
    const common = {
      model: TIER0,
      simulatedOrderId: "rest-1",
      marketId: MARKET,
      tokenId: TOKEN,
      side: "YES" as const,
      restingPrice: "0.47",
      observedTradePrice: "0.47",
      feeSnapshot: FEES,
      atEvent: event(2),
    };
    // Our resting SELL is a maker SELL: shares whole, pUSD floored (4 999 999).
    const sell = unwrap(tier0Maker({ ...common, action: "SELL", remainingShares: "10.638297" }));
    expect(sell.fills.map((fill) => [fill.shares, fill.collateralAmount, fill.liquidityRole])).toEqual([
      ["10.638297", "4.999999", "MAKER"],
    ]);
    expect(sell).toMatchObject({ filledShares: "10.638297", remainingShares: "0", trigger: "TOUCH" });
    // Our resting BUY is a maker BUY: pUSD floor(10 000 001 × 0.47) = 4 700 000,
    // shares floor(4 700 000 / 0.47) = 10 000 000; one unit stays unfilled.
    const buy = unwrap(tier0Maker({ ...common, action: "BUY", remainingShares: "10.000001" }));
    expect(buy.fills.map((fill) => [fill.shares, fill.collateralAmount])).toEqual([["10", "4.7"]]);
    expect(buy).toMatchObject({ filledShares: "10", remainingShares: "0.000001" });
  });

  it("a Tier-1 BAND fill (an estimate of our maker fill) moves the same legs", () => {
    // Resting BUY 10.000001 at 0.47, nothing ahead, one trade THROUGH it at 0.46:
    // every scenario fills the remainder, which moves 10 shares for 4.7 pUSD.
    const band = unwrap(
      simulateResting({
        model: TIER1,
        order: {
          simulatedOrderId: "rest-2",
          marketId: MARKET,
          tokenId: TOKEN,
          side: "YES",
          action: "BUY",
          restingPrice: "0.47",
          shares: "10.000001",
          queueAheadAtPlacement: "0",
          sameInstantAdditions: "NOT_OBSERVED",
          restingFromNs: START_NS,
        },
        trades: [{ price: "0.46", shares: "50", monotonicNs: START_NS + 1n, atEvent: event(2) }],
        parameters: QUEUE,
        feeSnapshot: FEES,
      }),
    );
    for (const scenario of [band.optimistic, band.base, band.conservative]) {
      expect(scenario).toMatchObject({ filledShares: "10", remainingShares: "0.000001" });
      expect(scenario.fills.map((fill) => [fill.shares, fill.collateralAmount])).toEqual([["10", "4.7"]]);
    }
  });

  it("REFUSES a maker the formula cannot price: a level, or a resting order, at a non-positive price", () => {
    // F-63 divides by the maker's amount; a maker at price 0 signs none.
    const level = consumeDepth({ ladder: [{ price: "0", size: "10" }], action: "SELL", limitPrice: "0", shares: "1" });
    expect(level).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    const resting = tier0Maker({
      model: TIER0,
      simulatedOrderId: "rest-0",
      marketId: MARKET,
      tokenId: TOKEN,
      side: "YES",
      action: "BUY",
      restingPrice: "0",
      remainingShares: "10",
      observedTradePrice: "0.1",
      feeSnapshot: FEES,
      atEvent: event(2),
    });
    expect(resting).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
  });

  it("REFUSES a resting order whose action names neither side of the formula", () => {
    const outcome = tier0Maker({
      model: TIER0,
      simulatedOrderId: "rest-0",
      marketId: MARKET,
      tokenId: TOKEN,
      side: "YES",
      action: "HOLD" as never,
      restingPrice: "0.47",
      remainingShares: "10",
      observedTradePrice: "0.47",
      feeSnapshot: FEES,
      atEvent: event(2),
    });
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    const band = simulateResting({
      model: TIER1,
      order: {
        simulatedOrderId: "rest-0",
        marketId: MARKET,
        tokenId: TOKEN,
        side: "YES",
        action: "HOLD" as never,
        restingPrice: "0.47",
        shares: "10",
        queueAheadAtPlacement: "0",
        sameInstantAdditions: "NOT_OBSERVED",
        restingFromNs: START_NS,
      },
      trades: [],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(band).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
  });

  it("the venue's cash moves by the fill's floored pUSD, not by price × shares", async () => {
    // GTC BUY 10.638297 at limit 0.5 against asks 0.47 × 100: one fill,
    // pUSD 4.999999 (not 4.99999959), taker fee on C = 10.638297 shares:
    // 10.638297 × 0.07 × 0.47 × 0.53 = 0.185499984789 → 0.18550 (5 dp, HALF_UP).
    // Cash: 1000 − 4.999999 − 0.1855 = 994.814501.
    const venue = tier0Venue("GTC", [{ price: "0.47", size: "100" }]);
    const result = await venue.submit(plan(order({ shares: "10.638297" })));
    expect(result.accepted).toBe(true);
    expect(result.fills.map((fill) => [fill.shares, fill.collateralAmount, fill.feeAmount])).toEqual([
      ["10.638297", "4.999999", "0.1855"],
    ]);
    expect(await cash(venue)).toBe("994.814501");
  });

  it("the replay path's economics fold the fills' pUSD legs, not price × shares", () => {
    const fill = simulatedFill({
      simulatedFillId: "f-1",
      simulatedOrderId: "o-1",
      marketId: MARKET,
      tokenId: TOKEN,
      side: "YES",
      action: "BUY",
      price: "0.47",
      shares: "10.638297",
      collateralAmount: "4.999999",
      feeAmount: "0.1855",
      liquidityRole: "TAKER",
      model: TIER0,
      atEvent: event(1),
    });
    const economics = unwrap(replayPathEconomics([fill]));
    expect(economics).toMatchObject({ buyNotional: "4.999999", fees: "0.1855", netCashFlow: "-5.185499" });
  });
});

// ---------------------------------------------------------------------------
// 3. The targets
// ---------------------------------------------------------------------------

describe("V2-10 (3a): the ONE conversion of a FOK/FAK BUY's share size to its collateral target", () => {
  it("is shares × LIMIT price, floored to whole base units (F-73)", () => {
    expect(unwrap(collateralTargetAtLimitPrice("10", "0.5"))).toBe("5");
    expect(unwrap(collateralTargetAtLimitPrice("50", "0.35"))).toBe("17.5");
    // 10.1234567 × 0.47 = 4.758024649 → 4 758 024 units, floored (not 4.758025).
    expect(unwrap(collateralTargetAtLimitPrice("10.1234567", "0.47"))).toBe("4.758024");
  });

  it("REFUSES a target that floors to zero, and a size or price that is not one", () => {
    // 0.000001 × 0.5 = 0.0000005: under one base unit.
    expect(collateralTargetAtLimitPrice("0.000001", "0.5")).toMatchObject({ ok: false });
    expect(collateralTargetAtLimitPrice("0", "0.5")).toMatchObject({ ok: false });
    expect(collateralTargetAtLimitPrice("10", "0")).toMatchObject({ ok: false });
    expect(collateralTargetAtLimitPrice("-10", "0.5")).toMatchObject({ ok: false });
    expect(collateralTargetAtLimitPrice("1,5", "0.5")).toMatchObject({ ok: false });
  });
});

describe("V2-10 (3b): a collateral-targeted walk spends pUSD; its shares follow from the fills", () => {
  it("PRICE IMPROVEMENT buys MORE shares: 5 pUSD at an ask of 0.4 buys 12.5, not 10", () => {
    // affordable = floor(5 000 000 × 10 / 4) = 12 500 000 ≤ the level; pUSD
    // floor(12 500 000 × 4 / 10) = 5 000 000.
    const walk = unwrap(consumeDepth({ ladder: DEEP_ASKS, action: "BUY", limitPrice: "0.5", collateral: "5" }));
    expect(walk.matched).toEqual([{ price: "0.4", shares: "12.5", collateral: "5" }]);
    expect(walk).toMatchObject({
      target: "COLLATERAL",
      filledShares: "12.5",
      remainingShares: "0",
      collateralTarget: "5",
      remainingCollateral: "0",
      complete: true,
      stoppedAtLimit: false,
    });
  });

  it("walks levels, each maker fill floored, reducing the budget by what it SPENT", () => {
    // Asks 0.34 × 30, 0.35 × 100; target 17.5 (50 × 0.35). Level 1: affordable
    // floor(17 500 000 × 100 / 34) = 51 470 588 > 30 000 000 → take the level,
    // spend floor(30 000 000 × 34 / 100) = 10 200 000; 7 300 000 left. Level 2:
    // affordable floor(7 300 000 × 100 / 35) = 20 857 142; spend
    // floor(20 857 142 × 35 / 100) = floor(7 299 999.7) = 7 299 999; 1 left,
    // which cannot buy one share unit at 0.35: COMPLETE.
    const walk = unwrap(
      consumeDepth({
        ladder: [
          { price: "0.34", size: "30" },
          { price: "0.35", size: "100" },
        ],
        action: "BUY",
        limitPrice: "0.35",
        collateral: "17.5",
      }),
    );
    expect(walk.matched).toEqual([
      { price: "0.34", shares: "30", collateral: "10.2" },
      { price: "0.35", shares: "20.857142", collateral: "7.299999" },
    ]);
    expect(walk).toMatchObject({
      filledShares: "50.857142",
      collateral: "17.499999",
      remainingCollateral: "0.000001",
      complete: true,
    });
  });

  it("is INCOMPLETE when the ladder or the limit ends it with budget left", () => {
    // Ladder: 0.4 × 5 spends 2 of 5.
    const exhausted = unwrap(consumeDepth({ ladder: THIN_ASKS, action: "BUY", limitPrice: "0.5", collateral: "5" }));
    expect(exhausted).toMatchObject({
      filledShares: "5",
      collateral: "2",
      remainingCollateral: "3",
      complete: false,
      stoppedAtLimit: false,
    });
    // Limit: the 0.6 ask is past the 0.5 limit.
    const limited = unwrap(
      consumeDepth({
        ladder: [
          { price: "0.4", size: "5" },
          { price: "0.6", size: "100" },
        ],
        action: "BUY",
        limitPrice: "0.5",
        collateral: "5",
      }),
    );
    expect(limited).toMatchObject({ filledShares: "5", remainingCollateral: "3", complete: false, stoppedAtLimit: true });
  });

  it("REFUSES a collateral-targeted SELL, two targets, no target, and a target under one base unit", () => {
    const sell = consumeDepth({ ladder: BIDS, action: "SELL", limitPrice: "0.3", collateral: "5" });
    expect(sell).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    const both = consumeDepth({ ladder: DEEP_ASKS, action: "BUY", limitPrice: "0.5", shares: "10", collateral: "5" } as never);
    expect(both).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    const neither = consumeDepth({ ladder: DEEP_ASKS, action: "BUY", limitPrice: "0.5" } as never);
    expect(neither).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
    const dust = consumeDepth({ ladder: DEEP_ASKS, action: "BUY", limitPrice: "0.5", collateral: "0.0000001" });
    expect(dust).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
  });
});

describe("V2-10 (3c): the venue — FOK/FAK BUYs target collateral; GTC/GTD BUYs and SELLs target shares", () => {
  const DOCUMENTED = { fokFakBuyTarget: "COLLATERAL_AT_LIMIT_PRICE" } as const;

  it("a FAK BUY with price improvement buys MORE shares than planned, and its order says why", async () => {
    // Planned 10 at limit 0.5 → target 5 pUSD; the ask is 0.4 → 12.5 shares.
    // Fee on C = 12.5: 12.5 × 0.07 × 0.4 × 0.6 = 0.21. Cash 1000 − 5 − 0.21 = 994.79.
    const venue = tier0Venue("FAK", DEEP_ASKS, DOCUMENTED);
    const result = await venue.submit(plan(order()));
    expect(result.accepted).toBe(true);
    expect(booked(venue)).toMatchObject({
      state: "FILLED",
      requestedShares: "10",
      collateralTarget: "5",
      filledShares: "12.5",
    });
    expect(result.fills.map((fill) => [fill.price, fill.shares, fill.collateralAmount, fill.feeAmount])).toEqual([
      ["0.4", "12.5", "5", "0.21"],
    ]);
    expect(await cash(venue)).toBe("994.79");
  });

  it("a FOK BUY the depth cannot fund whole is REJECTED with nothing filled", async () => {
    // Target 5; 0.4 × 5 spends 2 and the ladder ends: not complete.
    const venue = tier0Venue("FOK", THIN_ASKS, DOCUMENTED);
    await venue.submit(plan(order()));
    expect(booked(venue)).toMatchObject({ state: "REJECTED", filledShares: "0", collateralTarget: "5" });
    expect(venue.fills).toEqual([]);
    expect(await cash(venue)).toBe("1000");
  });

  it("a FOK BUY the depth funds whole FILLS, at the improved share count", async () => {
    const venue = tier0Venue("FOK", DEEP_ASKS, DOCUMENTED);
    await venue.submit(plan(order()));
    expect(booked(venue)).toMatchObject({ state: "FILLED", filledShares: "12.5", collateralTarget: "5" });
  });

  it("a FAK BUY the depth cannot fund whole keeps what it bought and CANCELS the unspent budget", async () => {
    // 5 shares at 0.4 = 2 pUSD; fee 5 × 0.07 × 0.4 × 0.6 = 0.084. Cash 997.916.
    const venue = tier0Venue("FAK", THIN_ASKS, DOCUMENTED);
    await venue.submit(plan(order()));
    expect(booked(venue)).toMatchObject({ state: "CANCELLED", filledShares: "5", collateralTarget: "5" });
    expect(await cash(venue)).toBe("997.916");
  });

  it("a GTC and a GTD BUY still target SHARES under the documented setting", async () => {
    for (const timeInForce of ["GTC", "GTD"] as const) {
      const venue = tier0Venue(timeInForce, DEEP_ASKS, DOCUMENTED);
      await venue.submit(plan(order()));
      const only = booked(venue);
      expect(only).toMatchObject({ state: "FILLED", filledShares: "10" });
      expect(only.collateralTarget).toBeUndefined();
    }
  });

  it("a FAK and a FOK SELL still target SHARES under the documented setting", async () => {
    // SELL 10 at limit 0.3 into the 0.3 bid: 10 shares for 3 pUSD.
    for (const timeInForce of ["FAK", "FOK"] as const) {
      const venue = tier0Venue(timeInForce, DEEP_ASKS, DOCUMENTED);
      await venue.submit(plan(order({ action: "SELL", limitPrice: "0.3" })));
      const only = booked(venue);
      expect(only).toMatchObject({ state: "FILLED", filledShares: "10" });
      expect(only.collateralTarget).toBeUndefined();
      expect(venue.fills.map((fill) => [fill.shares, fill.collateralAmount])).toEqual([["10", "3"]]);
    }
  });

  it("the Tier-1 path targets collateral the same way", async () => {
    const venue = tier1Venue("FAK", DEEP_ASKS, DOCUMENTED);
    await venue.submit(plan(order()));
    expect(booked(venue)).toMatchObject({ state: "FILLED", filledShares: "12.5", collateralTarget: "5" });
    const rejected = tier1Venue("FOK", THIN_ASKS, DOCUMENTED);
    await rejected.submit(plan(order()));
    expect(booked(rejected)).toMatchObject({ state: "REJECTED", filledShares: "0" });
  });

  it("tier1Immediate REFUSES a collateral target on anything but a FOK/FAK BUY", () => {
    const common = {
      model: TIER1,
      timeline: { bookAt: () => ({ book: book(DEEP_ASKS, BIDS), atEvent: event(1) }) },
      latencyModel: LATENCY,
      streams: deriveStreams("42"),
      simulatedOrderId: "o-1",
      marketId: MARKET,
      side: "YES" as const,
      limitPrice: "0.5",
      shares: "10",
      collateralTarget: "5",
      postOnly: false,
      submittedAtNs: START_NS,
      market: { marketId: MARKET, tickSize: "0.01", minimumOrderSize: "1", secondsDelay: 0, parametersVersion: 1 },
      feeSnapshot: FEES,
    };
    expect(tier1Immediate({ ...common, action: "BUY", timeInForce: "GTC" })).toMatchObject({
      ok: false,
      refusal: { code: "SIMULATED_VENUE_PLAN_UNSUPPORTED" },
    });
    expect(tier1Immediate({ ...common, action: "SELL", timeInForce: "FAK" })).toMatchObject({
      ok: false,
      refusal: { code: "SIMULATED_VENUE_PLAN_UNSUPPORTED" },
    });
    expect(unwrap(tier1Immediate({ ...common, action: "BUY", timeInForce: "FAK" })).filledShares).toBe("12.5");
  });

  it("the conversion is made at PRE-FLIGHT: a target that floors to zero books nothing", async () => {
    const venue = tier0Venue("FAK", DEEP_ASKS, DOCUMENTED);
    const result = await venue.submit(plan(order({ shares: "0.000001" })));
    expect(result).toMatchObject({ accepted: false, outcome: "REFUSED", refusalCode: "SIMULATION_INPUT_INVALID" });
    expect(venue.ordersSnapshot()).toEqual([]);
    expect(await cash(venue)).toBe("1000");
  });

  it("ABSENT the setting, a FAK BUY targets shares (the pre-V2-10 behaviour), and says so by name", async () => {
    expect(DEFAULT_FOK_FAK_BUY_TARGET).toBe("SHARES_UNDOCUMENTED");
    expect(FOK_FAK_BUY_TARGETS).toEqual(["COLLATERAL_AT_LIMIT_PRICE", "SHARES_UNDOCUMENTED"]);
    for (const overrides of [{}, { fokFakBuyTarget: "SHARES_UNDOCUMENTED" } as const]) {
      // 10 at 0.4 = 4 pUSD; fee 10 × 0.07 × 0.4 × 0.6 = 0.168. Cash 995.832.
      const venue = tier0Venue("FAK", DEEP_ASKS, overrides);
      await venue.submit(plan(order()));
      const only = booked(venue);
      expect(only).toMatchObject({ state: "FILLED", filledShares: "10" });
      expect(only.collateralTarget).toBeUndefined();
      expect(await cash(venue)).toBe("995.832");
    }
  });

  it("a non-positive limit price is refused at PRE-FLIGHT: it is no maker's signed ratio", async () => {
    // F-63's counter divides by the maker's amount; a resting order at 0 has none.
    const venue = tier0Venue("GTC", DEEP_ASKS);
    const result = await venue.submit(plan(order({ action: "SELL", limitPrice: "0" })));
    expect(result).toMatchObject({ accepted: false, outcome: "REFUSED", refusalCode: "SIMULATION_INPUT_INVALID" });
    expect(venue.ordersSnapshot()).toEqual([]);
  });

  it("an unknown setting is a composition-root mistake: the constructor throws", () => {
    expect(() => tier0Venue("FAK", DEEP_ASKS, { fokFakBuyTarget: "COLLATERAL" as never })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 4. Fees: unchanged, and reconciled separately from the fill (F-63, F-64)
// ---------------------------------------------------------------------------

describe("V2-10 (4): the fee path is UNCHANGED — fills and fees reconcile separately", () => {
  it("a BUY's fee ADDS to its collateral spend; a SELL's is DEDUCTED from its proceeds", async () => {
    // BUY 10 at 0.4 (GTC): pUSD 4, fee 0.168 → cash 1000 − 4 − 0.168 = 995.832.
    const buy = tier0Venue("GTC", DEEP_ASKS);
    await buy.submit(plan(order()));
    expect(buy.fills.map((fill) => [fill.collateralAmount, fill.feeAmount])).toEqual([["4", "0.168"]]);
    expect(await cash(buy)).toBe("995.832");
    // SELL 10 at 0.3 (GTC): pUSD 3, fee 10 × 0.07 × 0.3 × 0.7 = 0.147 →
    // cash 1000 + 3 − 0.147 = 1002.853.
    const sell = tier0Venue("GTC", DEEP_ASKS);
    await sell.submit(plan(order({ action: "SELL", limitPrice: "0.3" })));
    expect(sell.fills.map((fill) => [fill.collateralAmount, fill.feeAmount])).toEqual([["3", "0.147"]]);
    expect(await cash(sell)).toBe("1002.853");
  });

  it("the fee is still C × rate × p × (1 − p) on the fill's SHARES, not on its floored pUSD", async () => {
    // 10.638297 shares at 0.47: fee 0.1855 from C = 10.638297 (see section 2);
    // the pUSD leg 4.999999 is not an input to it.
    const venue = tier0Venue("GTC", [{ price: "0.47", size: "100" }]);
    await venue.submit(plan(order({ shares: "10.638297" })));
    expect(venue.fills.map((fill) => fill.feeAmount)).toEqual(["0.1855"]);
  });

  it("a collateral target EXCLUDES the fee: the fee is spent on top of it", async () => {
    // Target 5, fee 0.21: the order spends 5.21 in all (994.79 left of 1000).
    const venue = tier0Venue("FAK", DEEP_ASKS, { fokFakBuyTarget: "COLLATERAL_AT_LIMIT_PRICE" });
    await venue.submit(plan(order()));
    expect(venue.fills.map((fill) => [fill.collateralAmount, fill.feeAmount])).toEqual([["5", "0.21"]]);
    expect(await cash(venue)).toBe("994.79");
  });
});

// ---------------------------------------------------------------------------
// 5. Round 1 (V2-10 r1): the budget a resting BUY signs, the exhausted level,
//    and the band's order in the maker's asset
// ---------------------------------------------------------------------------

/** A canonical non-negative decimal of at most six places, as base units. Exact. */
function units(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > 6) throw new Error(`${value} is finer than one base unit`);
  return BigInt(whole) * BASE_UNITS_PER_WHOLE + BigInt(fraction.padEnd(6, "0"));
}

/** Σ of the fills' pUSD legs, in base units. */
function spentUnits(fills: readonly { readonly collateralAmount: string }[]): bigint {
  return fills.reduce((total, fill) => total + units(fill.collateralAmount), 0n);
}

/** A Tier-1 band for a resting order over the given trades, each 1 ns after the last. */
function restingBand(input: {
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
  readonly queueAhead?: string;
  readonly trades: readonly { readonly price: string; readonly shares: string }[];
}): SimulationResult<RestingFillBand> {
  return simulateResting({
    model: TIER1,
    order: {
      simulatedOrderId: "rest-r1",
      marketId: MARKET,
      tokenId: TOKEN,
      side: "YES",
      action: input.action,
      restingPrice: input.price,
      shares: input.shares,
      queueAheadAtPlacement: input.queueAhead ?? "0",
      sameInstantAdditions: "NOT_OBSERVED",
      restingFromNs: START_NS,
    },
    trades: input.trades.map((trade, index) => ({
      price: trade.price,
      shares: trade.shares,
      monotonicNs: START_NS + BigInt(index + 1),
      atEvent: event(index + 2),
    })),
    parameters: QUEUE,
    feeSnapshot: FEES,
  });
}

function scenarios(band: RestingFillBand) {
  return [band.optimistic, band.base, band.conservative] as const;
}

describe("V2-10 r1 (R1-01): a resting BUY's maker fills spend, TOGETHER, at most the collateral it signed", () => {
  it("BUY 10 at 0.6, filled in ten pieces of 1.000002: exactly the 6 pUSD it signed, never 6.000003", () => {
    // Signed: makerAmount 6 000 000 (pUSD), takerAmount 10 000 000 (shares).
    // Fills 1-9: pUSD floor(1 000 002 × 0.6) = 600 001, shares
    // floor(600 001 / 0.6) = 1 000 001; after nine, 5 400 009 spent and
    // 599 991 left. Fill 10: the 999 991 shares still unfilled are worth
    // floor(599 994.6) = 599 994 > 599 991, so it is CAPPED at 599 991, and
    // moves floor(599 991 / 0.6) = 999 985 shares. Total: 9 999 994 shares for
    // exactly 6 000 000. The 6 share units left are the formula's floors; the
    // eleventh trade fills nothing, because the budget is spent.
    const band = unwrap(
      restingBand({
        action: "BUY",
        price: "0.6",
        shares: "10",
        trades: Array.from({ length: 11 }, () => ({ price: "0.6", shares: "1.000002" })),
      }),
    );
    for (const scenario of scenarios(band)) {
      expect(scenario.fills.map((fill) => [fill.shares, fill.collateralAmount])).toEqual([
        ...Array.from({ length: 9 }, () => ["1.000001", "0.600001"]),
        ["0.999985", "0.599991"],
      ]);
      expect(spentUnits(scenario.fills)).toBe(6_000_000n);
      expect(scenario).toMatchObject({ filledShares: "9.999994", remainingShares: "0.000006" });
    }
  });

  it("a trade THROUGH the price after partial fills spends exactly what is left of the budget", () => {
    // Three fills of 1.000001 for 0.600001 leave 4 199 997 of 6 000 000 and
    // 6 999 997 share units. The through trade fills the remainder, worth
    // floor(6 999 997 × 0.6) = floor(4 199 998.2) = 4 199 998 — one MORE than
    // is left — so it is capped at 4 199 997 and moves floor(4 199 997 / 0.6)
    // = 6 999 995 shares. Total spend: exactly 6.
    const band = unwrap(
      restingBand({
        action: "BUY",
        price: "0.6",
        shares: "10",
        trades: [
          { price: "0.6", shares: "1.000002" },
          { price: "0.6", shares: "1.000002" },
          { price: "0.6", shares: "1.000002" },
          { price: "0.59", shares: "50" },
        ],
      }),
    );
    for (const scenario of scenarios(band)) {
      expect(scenario.fills.map((fill) => [fill.shares, fill.collateralAmount])).toEqual([
        ["1.000001", "0.600001"],
        ["1.000001", "0.600001"],
        ["1.000001", "0.600001"],
        ["6.999995", "4.199997"],
      ]);
      expect(spentUnits(scenario.fills)).toBe(6_000_000n);
      expect(scenario).toMatchObject({ filledShares: "9.999998", remainingShares: "0.000002" });
    }
  });

  // An exhaustive grid: about 1.5 s alone and over 5 s on a loaded CI runner
  // (CI run 37937579843), so it gets its own timeout instead of vitest's 5 s.
  it("CONSERVES the signed collateral over a grid of prices, sizes, queues and partial-fill sequences", () => {
    // The budget is floor(size in whole base units × price). For every band:
    // every arm's fills spend at most it, and a final trade THROUGH the price
    // spends it exactly. Every band is also ACCEPTED by `checkBandOrdering`
    // (`unwrap` throws on a refusal), which orders a BUY band in pUSD.
    const pieces: readonly (readonly string[])[] = [
      Array.from({ length: 12 }, () => "1.000002"),
      Array.from({ length: 31 }, () => "0.333333"),
      ["0.000003", "1.7", "2.000001", "0.5", "0.000001", "3.333337", "0.9", "1.000009"],
      ["2.5", "2.5", "2.5", "2.5", "2.5"],
    ];
    let bands = 0;
    for (const price of ["0.6", "0.47", "0.35", "0.03", "0.97", "0.333"]) {
      for (const shares of ["10", "7.5", "1.000003"]) {
        for (const queueAhead of ["0", "0.5", "2.000004"]) {
          for (const sequence of pieces) {
            const budget = (units(shares) * units(price)) / BASE_UNITS_PER_WHOLE;
            const atPrice = sequence.map((size) => ({ price, shares: size }));
            const partial = unwrap(restingBand({ action: "BUY", price, shares, queueAhead, trades: atPrice }));
            for (const scenario of scenarios(partial)) {
              expect(spentUnits(scenario.fills) <= budget, `${price} ${shares} ${queueAhead} ${scenario.scenario}`).toBe(
                true,
              );
            }
            const through = unwrap(
              restingBand({
                action: "BUY",
                price,
                shares,
                queueAhead,
                trades: [...atPrice, { price: "0.01", shares: "1000" }],
              }),
            );
            for (const scenario of scenarios(through)) {
              expect(spentUnits(scenario.fills), `${price} ${shares} ${queueAhead} ${scenario.scenario}`).toBe(budget);
            }
            bands += 2;
          }
        }
      }
    }
    expect(bands).toBe(432);
  }, 30_000);

  it("reaches the venue: a Tier-1 resting BUY's band never spends more than the order signed", async () => {
    // GTC BUY 10 at 0.6 against asks at 0.7: nothing crosses, so it rests, with
    // nothing ahead at 0.6 (the bid is 0.3). Ten observed trades of 1.000002.
    const venue = tier1Venue("GTC", [{ price: "0.7", size: "100" }]);
    const submitted = await venue.submit(plan(order({ limitPrice: "0.6" })));
    expect(booked(venue).state).toBe("RESTING");
    expect(submitted.fills).toEqual([]);
    let last: RestingFillBand | undefined;
    for (let index = 0; index < 10; index += 1) {
      const observed = unwrap(
        venue.observeTrade({
          marketId: MARKET,
          side: "YES",
          price: "0.6",
          shares: "1.000002",
          monotonicNs: START_NS + 1_000n + BigInt(index),
          atEvent: event(index + 2),
        }),
      );
      last = observed.bands[0];
    }
    if (last === undefined) throw new Error("the venue reported no band");
    for (const scenario of scenarios(last)) {
      expect(spentUnits(scenario.fills)).toBe(6_000_000n);
      expect(scenario.filledShares).toBe("9.999994");
    }
  });
});

describe("V2-10 r1 (self-found): a resting band is ordered in the MAKER'S ASSET — pUSD for a BUY, shares for a SELL", () => {
  // Resting at 0.6 behind 2.000004; trades 2.000004 then 20. OPTIMISTIC
  // (ratio 0.5) is reached by 1.000002 of the first trade and fills the rest
  // from the second; BASE (ratio 0.1) by 0.2000004 of it, floored to 0.2;
  // CONSERVATIVE (ratio 0) by none of it. All three fill from the second.
  const trades = [
    { price: "0.6", shares: "2.000004" },
    { price: "0.6", shares: "20" },
  ];

  it("a BUY band whose arms receive different SHARES for the same pUSD is a valid band", () => {
    // OPTIMISTIC: 1.000001 shares for 0.600001, then the 8.999999 unfilled are
    // worth floor(5 399 999.4) = 5 399 999 — exactly what is left of 6 — for
    // floor(5 399 999 / 0.6) = 8 999 998 shares: 9.999999 for 6. BASE: 0.2 for
    // 0.12, then 9.8 for 5.88: 10 for 6. CONSERVATIVE: 10 for 6. F-63 floors
    // each fill's share counter, so the arm filled in more pieces receives
    // fewer shares for the same pUSD: shares are NOT ordered, pUSD is.
    const band = unwrap(restingBand({ action: "BUY", price: "0.6", shares: "10", queueAhead: "2.000004", trades }));
    expect(scenarios(band).map((scenario) => [scenario.filledShares, spentUnits(scenario.fills)])).toEqual([
      ["9.999999", 6_000_000n],
      ["10", 6_000_000n],
      ["10", 6_000_000n],
    ]);
    expect(checkBandOrdering(band).ok).toBe(true);
  });

  it("a SELL band whose arms receive different pUSD for the same SHARES is a valid band", () => {
    // The maker's asset is shares: OPTIMISTIC sells 1.000002 for 0.600001 and
    // 8.999998 for floor(5 399 998.8) = 5.399998 — 10 shares for 5.999999;
    // BASE and CONSERVATIVE sell 10 for 6. pUSD is NOT ordered, shares are.
    const band = unwrap(restingBand({ action: "SELL", price: "0.6", shares: "10", queueAhead: "2.000004", trades }));
    expect(scenarios(band).map((scenario) => [scenario.filledShares, spentUnits(scenario.fills)])).toEqual([
      ["10", 5_999_999n],
      ["10", 6_000_000n],
      ["10", 6_000_000n],
    ]);
  });

  it("carries each arm's post-cancel pUSD beside its post-cancel shares", () => {
    // BUY 10 at 0.6, cancel requested at +2 ns; OPTIMISTIC's cancel takes
    // effect 10 ms later, so both trades fill it, the second after the request.
    const band = unwrap(
      simulateResting({
        model: TIER1,
        order: {
          simulatedOrderId: "rest-r1-cancel",
          marketId: MARKET,
          tokenId: TOKEN,
          side: "YES",
          action: "BUY",
          restingPrice: "0.6",
          shares: "10",
          queueAheadAtPlacement: "0",
          sameInstantAdditions: "NOT_OBSERVED",
          restingFromNs: START_NS,
          cancelRequestedAtNs: START_NS + 2n,
        },
        trades: [
          { price: "0.6", shares: "1.000002", monotonicNs: START_NS + 1n, atEvent: event(2) },
          { price: "0.6", shares: "1.000002", monotonicNs: START_NS + 3n, atEvent: event(3) },
        ],
        parameters: QUEUE,
        feeSnapshot: FEES,
      }),
    );
    expect(band.optimistic).toMatchObject({
      filledShares: "2.000002",
      fillsAfterCancelRequest: "1.000001",
      collateralAfterCancelRequest: "0.600001",
    });
  });

  it("checkBandOrdering REFUSES an inverted BUY band in pUSD, a band of two sides, and an impossible post-cancel spend", () => {
    // BUY 1000 at 0.5 behind 100 (+50 same-instant for CONSERVATIVE), one trade
    // of 100. OPTIMISTIC (ratio 1): 100 of the queue cancels, the trade fills
    // 100 for 50. BASE (ratio 0.6): 60 cancels, 40 trades ahead, 60 fills for
    // 30. CONSERVATIVE (ratio 0, 150 ahead): nothing.
    const built = unwrap(
      simulateResting({
        model: TIER1,
        order: {
          simulatedOrderId: "rest-r1-order",
          marketId: MARKET,
          tokenId: TOKEN,
          side: "YES",
          action: "BUY",
          restingPrice: "0.5",
          shares: "1000",
          queueAheadAtPlacement: "100",
          sameInstantAdditions: { observedShares: "50" },
          restingFromNs: START_NS,
        },
        trades: [{ price: "0.5", shares: "100", monotonicNs: START_NS + 1n, atEvent: event(2) }],
        parameters: { ...QUEUE, cancellationRatio: { OPTIMISTIC: "1", BASE: "0.6", CONSERVATIVE: "0" } },
        feeSnapshot: FEES,
      }),
    );
    expect(scenarios(built).map((scenario) => spentUnits(scenario.fills))).toEqual([50_000_000n, 30_000_000n, 0n]);

    const swapped = checkBandOrdering({
      ...built,
      optimistic: { ...built.conservative, scenario: "OPTIMISTIC" as const },
      conservative: { ...built.optimistic, scenario: "CONSERVATIVE" as const },
    });
    expect(swapped).toMatchObject({
      ok: false,
      refusal: { code: "FILL_MODEL_BAND_INCONSISTENT", details: { makerAsset: "PUSD", optimistic: "0", conservative: "50" } },
    });

    const [first, ...rest] = built.optimistic.fills;
    if (first === undefined) throw new Error("the optimistic arm filled nothing");
    const twoSides = checkBandOrdering({
      ...built,
      optimistic: { ...built.optimistic, fills: [{ ...first, action: "SELL" as const }, ...rest] },
    });
    expect(twoSides).toMatchObject({ ok: false, refusal: { code: "FILL_MODEL_BAND_INCONSISTENT" } });
    expect(twoSides.ok ? "" : twoSides.refusal.message).toContain("both a BUY and a SELL");

    // On the CONSERVATIVE arm, which spent nothing: its pre-cancel pUSD would
    // be −999, which the ORDERING check alone would accept (30 ≥ −999), so only
    // the post-cancel bound can refuse it.
    const impossible = checkBandOrdering({
      ...built,
      conservative: { ...built.conservative, collateralAfterCancelRequest: "999" },
    });
    expect(impossible).toMatchObject({ ok: false, refusal: { code: "FILL_MODEL_BAND_INCONSISTENT" } });
    expect(impossible.ok ? "" : impossible.refusal.message).toContain("more pUSD after a cancel request");

    const withoutField: Record<string, unknown> = { ...built.base };
    delete withoutField["collateralAfterCancelRequest"];
    const missing = checkBandOrdering({ ...built, base: withoutField as never });
    expect(missing).toMatchObject({ ok: false, refusal: { code: "SIMULATION_INPUT_INVALID" } });
  });
});

describe("V2-10 r1 (R1-02): a collateral walk leaves a level only once it is EXHAUSTED, then spends what the floor left", () => {
  const DOCUMENTED = { fokFakBuyTarget: "COLLATERAL_AT_LIMIT_PRICE" } as const;
  /** 10.638297 at 0.47 is worth 4.99999959: a 5-pUSD budget buys it EXACTLY and keeps 1 base unit. */
  const EXACT_THEN_DEEPER: readonly BookLevelView[] = [
    { price: "0.47", size: "10.638297" },
    { price: "0.5", size: "100" },
  ];

  it("a budget that buys a level exactly moves the base unit the floor left on to the next level", () => {
    // Level 1: affordable floor(5 000 000 × 100 / 47) = 10 638 297 = the level:
    // EXHAUSTED, spending floor(10 638 297 × 0.47) = 4 999 999. Level 2: the 1
    // left buys floor(1 / 0.5) = 2 share units for floor(2 × 0.5) = 1. Spent: 5.
    const walk = unwrap(consumeDepth({ ladder: EXACT_THEN_DEEPER, action: "BUY", limitPrice: "0.5", collateral: "5" }));
    expect(walk.matched).toEqual([
      { price: "0.47", shares: "10.638297", collateral: "4.999999" },
      { price: "0.5", shares: "0.000002", collateral: "0.000001" },
    ]);
    expect(walk).toMatchObject({
      filledShares: "10.638299",
      collateral: "5",
      remainingCollateral: "0",
      complete: true,
      stoppedAtLimit: false,
    });
  });

  it("with no reachable level after it, the unspent base unit leaves the walk INCOMPLETE", () => {
    const ladderEnds = unwrap(
      consumeDepth({ ladder: [{ price: "0.47", size: "10.638297" }], action: "BUY", limitPrice: "0.5", collateral: "5" }),
    );
    expect(ladderEnds).toMatchObject({
      filledShares: "10.638297",
      remainingCollateral: "0.000001",
      complete: false,
      stoppedAtLimit: false,
    });
    const limitEnds = unwrap(
      consumeDepth({
        ladder: [
          { price: "0.47", size: "10.638297" },
          { price: "0.6", size: "100" },
        ],
        action: "BUY",
        limitPrice: "0.5",
        collateral: "5",
      }),
    );
    expect(limitEnds).toMatchObject({ remainingCollateral: "0.000001", complete: false, stoppedAtLimit: true });
  });

  it("a budget that buys LESS than a level still ends the walk there (price priority): unchanged", () => {
    // One more share unit at 0.47 (10.638298): affordable 10 638 297 < the
    // level, so the budget BOUND it. The 1 base unit left cannot buy one more
    // unit at 0.47 within the budget (10 638 298 × 0.47 = 5 000 000.06), and the
    // 0.5 level sits behind the size still resting at 0.47.
    const walk = unwrap(
      consumeDepth({
        ladder: [
          { price: "0.47", size: "10.638298" },
          { price: "0.5", size: "100" },
        ],
        action: "BUY",
        limitPrice: "0.5",
        collateral: "5",
      }),
    );
    expect(walk.matched).toEqual([{ price: "0.47", shares: "10.638297", collateral: "4.999999" }]);
    expect(walk).toMatchObject({ remainingCollateral: "0.000001", complete: true });
  });

  it("the venue: a FAK and a FOK BUY, under both tiers, FILL 10.638299 shares for exactly 5 pUSD", async () => {
    // Fees: 10.638297 at 0.47 → 0.1855 (section 2); 0.000002 at 0.5 →
    // 0.000002 × 0.07 × 0.25 = 0.000000035, so the 0.00001 minimum charge.
    // Cash: 1000 − 5 − 0.1855 − 0.00001 = 994.81449.
    for (const make of [tier0Venue, tier1Venue]) {
      for (const timeInForce of ["FAK", "FOK"] as const) {
        const venue = make(timeInForce, EXACT_THEN_DEEPER, DOCUMENTED);
        await venue.submit(plan(order()));
        expect(booked(venue), `${make.name} ${timeInForce}`).toMatchObject({
          state: "FILLED",
          filledShares: "10.638299",
          collateralTarget: "5",
        });
        expect(venue.fills.map((fill) => [fill.price, fill.shares, fill.collateralAmount, fill.feeAmount])).toEqual([
          ["0.47", "10.638297", "4.999999", "0.1855"],
          ["0.5", "0.000002", "0.000001", "0.00001"],
        ]);
        expect(await cash(venue)).toBe("994.81449");
      }
    }
  });

  it("the venue: with nothing reachable after the exhausted level, a FAK CANCELS what is unspent and a FOK is REJECTED (both tiers)", async () => {
    const onlyLevel: readonly BookLevelView[] = [{ price: "0.47", size: "10.638297" }];
    for (const make of [tier0Venue, tier1Venue]) {
      const fak = make("FAK", onlyLevel, DOCUMENTED);
      await fak.submit(plan(order()));
      expect(booked(fak), make.name).toMatchObject({ state: "CANCELLED", filledShares: "10.638297" });
      expect(await cash(fak)).toBe("994.814501");
      const fok = make("FOK", onlyLevel, DOCUMENTED);
      await fok.submit(plan(order()));
      expect(booked(fok), make.name).toMatchObject({ state: "REJECTED", filledShares: "0" });
      expect(fok.fills).toEqual([]);
      expect(await cash(fok)).toBe("1000");
    }
  });
});
