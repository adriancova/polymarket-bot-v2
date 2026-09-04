/**
 * The Tier 0 and Tier 1 fill models, the fee arithmetic, and the queue model
 * (§12.2, ADR-012 §5).
 *
 * Every venue behaviour asserted here cites ADR-012 §5, which cites the dated
 * verification report. Nothing is asserted about the venue that is not already
 * in that record, and the two places the documentation is silent — the fee
 * rounding DIRECTION and the "around 3 minutes" GTD minimum — are pinned as
 * REFUSALS to choose rather than as behaviour.
 */

import { describe, expect, it } from "vitest";

import {
  GTD_EARLY_EXPIRY_MS,
  computeFee,
  consumeDepth,
  deriveStreams,
  readFeeScheduleSnapshot,
  readLatencyModel,
  roundDecimal,
  simulateResting,
  sizeAtPrice,
  tier0Immediate,
  tier0Maker,
  tier0Model,
  tier1Immediate,
  tier1Model,
  type BookLevelView,
  type DepthTimeline,
  type FeeScheduleSnapshot,
  type LatencyModel,
  type MarketExecutionParameters,
  type QueueModelParameters,
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

const AT_EVENT = {
  gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
  ingestSeq: "1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  datasetRowOrdinal: 0,
};

const MARKET: MarketExecutionParameters = {
  marketId: "0190a3e0-0000-7000-8000-00000000000a",
  tickSize: "0.01",
  minimumOrderSize: "5",
  secondsDelay: 0,
  parametersVersion: 1,
};

const LATENCY: LatencyModel = {
  latencyModelVersion: "sim/latency/v1",
  decision: { samples: [{ milliseconds: 1, weight: 1 }] },
  signing: { samples: [{ milliseconds: 1, weight: 1 }] },
  network: { samples: [{ milliseconds: 10, weight: 1 }] },
  venue: { samples: [{ milliseconds: 3, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

const QUEUE: QueueModelParameters = {
  queueModelVersion: "sim/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

function book(levels: readonly BookLevelView[]) {
  return {
    internalMarketId: MARKET.marketId,
    tokenId: "1234",
    top: () => ({}),
    ladder: () => levels,
  };
}

function timeline(levels: readonly BookLevelView[]): DepthTimeline {
  return { bookAt: () => ({ book: book(levels), atEvent: AT_EVENT }) };
}

// ---------------------------------------------------------------------------

describe("exact depth arithmetic (§6 invariant 1)", () => {
  it("walks a ladder best-first, capped by the limit price", () => {
    const outcome = consumeDepth({
      ladder: [
        { price: "0.5", size: "10" },
        { price: "0.51", size: "10" },
        { price: "0.6", size: "100" },
      ],
      action: "BUY",
      limitPrice: "0.55",
      shares: "25",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.matched).toEqual([
      { price: "0.5", shares: "10" },
      { price: "0.51", shares: "10" },
    ]);
    expect(outcome.value.filledShares).toBe("20");
    expect(outcome.value.remainingShares).toBe("5");
    expect(outcome.value.notional).toBe("10.1");
    expect(outcome.value.stoppedAtLimit).toBe(true);
  });

  it("walks the bid ladder downward for a SELL", () => {
    const outcome = consumeDepth({
      ladder: [
        { price: "0.5", size: "10" },
        { price: "0.49", size: "10" },
      ],
      action: "SELL",
      limitPrice: "0.495",
      shares: "20",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.filledShares).toBe("10");
    expect(outcome.value.stoppedAtLimit).toBe(true);
  });

  it("refuses an unordered ladder rather than inventing price improvement", () => {
    const outcome = consumeDepth({
      ladder: [
        { price: "0.51", size: "10" },
        { price: "0.5", size: "10" },
      ],
      action: "BUY",
      limitPrice: "0.6",
      shares: "5",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.message).toContain("best-first");
  });

  it("refuses a zero-size level (ADR-013: size 0 is a REMOVED level)", () => {
    const outcome = consumeDepth({
      ladder: [{ price: "0.5", size: "0" }],
      action: "BUY",
      limitPrice: "0.6",
      shares: "5",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.message).toContain("removed level");
  });

  it("sums size at one price exactly", () => {
    expect(sizeAtPrice([{ price: "0.5", size: "1.5" }, { price: "0.5", size: "2.25" }], "0.5")).toBe(
      "3.75",
    );
    expect(sizeAtPrice([{ price: "0.5", size: "1" }], "0.6")).toBe("0");
  });
});

describe("the fee model (ADR-012 §5.4)", () => {
  it("computes fee = C × feeRate × p × (1 − p) exactly", () => {
    const outcome = computeFee({ shares: "100", price: "0.5", liquidityRole: "TAKER", snapshot: FEES });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 100 × 0.07 × 0.5 × 0.5 = 1.75, hand-computed.
    expect(outcome.value.unroundedFee).toBe("1.75");
    expect(outcome.value.feeAmount).toBe("1.75");
    expect(outcome.value.minimumApplied).toBe(false);
  });

  it("is symmetric around p = 0.5", () => {
    const low = computeFee({ shares: "100", price: "0.3", liquidityRole: "TAKER", snapshot: FEES });
    const high = computeFee({ shares: "100", price: "0.7", liquidityRole: "TAKER", snapshot: FEES });
    expect(low.ok && high.ok).toBe(true);
    if (!low.ok || !high.ok) return;
    expect(low.value.feeAmount).toBe(high.value.feeAmount);
  });

  it("charges makers nothing under the 2026-08-24 snapshot", () => {
    const outcome = computeFee({ shares: "100", price: "0.5", liquidityRole: "MAKER", snapshot: FEES });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.feeAmount).toBe("0");
    expect(outcome.value.feeRate).toBe("0");
  });

  it("applies the minimum charged fee only when a fee is charged at all", () => {
    const tiny = computeFee({
      shares: "0.0001",
      price: "0.5",
      liquidityRole: "TAKER",
      snapshot: FEES,
    });
    expect(tiny.ok).toBe(true);
    if (!tiny.ok) return;
    expect(tiny.value.feeAmount).toBe("0.00001");
    expect(tiny.value.minimumApplied).toBe(true);

    const zeroRate = computeFee({
      shares: "100",
      price: "0.5",
      liquidityRole: "TAKER",
      snapshot: { ...FEES, takerFeeRate: "0" },
    });
    expect(zeroRate.ok).toBe(true);
    if (!zeroRate.ok) return;
    expect(zeroRate.value.feeAmount).toBe("0");
    expect(zeroRate.value.minimumApplied).toBe(false);
  });

  it("REFUSES a snapshot with no stated rounding mode — the venue documents none", () => {
    const outcome = readFeeScheduleSnapshot({ ...FEES, roundingMode: undefined as never });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("FILL_MODEL_FEE_SNAPSHOT_MISSING");
    expect(outcome.refusal.message).toContain("not the direction");
  });

  it("refuses a snapshot with no version (§12.5 pins it per run)", () => {
    const outcome = readFeeScheduleSnapshot({ ...FEES, snapshotVersion: "" });
    expect(outcome.ok).toBe(false);
  });

  it("rounds on the digit string, never through a float", () => {
    // 1.005 is famously not representable in binary floating point; a float
    // round-half-up would give 1.00.
    expect(roundDecimal("1.005", 2, "HALF_UP")).toBe("1.01");
    expect(roundDecimal("1.005", 2, "HALF_EVEN")).toBe("1");
    expect(roundDecimal("1.015", 2, "HALF_EVEN")).toBe("1.02");
    expect(roundDecimal("1.0049", 2, "HALF_UP")).toBe("1");
    expect(roundDecimal("1.0001", 2, "UP")).toBe("1.01");
    expect(roundDecimal("1.0099", 2, "DOWN")).toBe("1");
    expect(roundDecimal("9.999", 2, "UP")).toBe("10");
    expect(roundDecimal("0.000001", 0, "UP")).toBe("1");
    expect(roundDecimal("-1.005", 2, "HALF_UP")).toBe("-1.01");
  });
});

describe("Tier 0 (§12.2 — pipeline smoke)", () => {
  const model = tier0Model({
    fillModelVersion: "sim/tier0/v1",
    fillModelParametersHash: "0".repeat(64),
  });

  it("consumes observed depth with no latency, one fill per level", () => {
    const outcome = tier0Immediate({
      model,
      book: book([
        { price: "0.5", size: "6" },
        { price: "0.52", size: "10" },
      ]),
      simulatedOrderId: "o-1",
      marketId: MARKET.marketId,
      side: "YES",
      action: "BUY",
      limitPrice: "0.6",
      shares: "10",
      feeSnapshot: FEES,
      atEvent: AT_EVENT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.fills.map((f) => [f.price, f.shares])).toEqual([
      ["0.5", "6"],
      ["0.52", "4"],
    ]);
    expect(outcome.value.complete).toBe(true);
    for (const produced of outcome.value.fills) expect(produced.liquidityRole).toBe("TAKER");
  });

  it("reports an incomplete fill rather than assuming completion (§6 invariant 10)", () => {
    const outcome = tier0Immediate({
      model,
      book: book([{ price: "0.5", size: "3" }]),
      simulatedOrderId: "o-1",
      marketId: MARKET.marketId,
      side: "YES",
      action: "BUY",
      limitPrice: "0.6",
      shares: "10",
      feeSnapshot: FEES,
      atEvent: AT_EVENT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.complete).toBe(false);
    expect(outcome.value.remainingShares).toBe("7");
  });

  it("fills a maker order on touch and on trade-through, and not otherwise", () => {
    const common = {
      model,
      simulatedOrderId: "o-1",
      marketId: MARKET.marketId,
      tokenId: "1234",
      side: "YES" as const,
      action: "BUY" as const,
      restingPrice: "0.5",
      remainingShares: "10",
      feeSnapshot: FEES,
      atEvent: AT_EVENT,
    };
    const touch = tier0Maker({ ...common, observedTradePrice: "0.5" });
    const through = tier0Maker({ ...common, observedTradePrice: "0.49" });
    const away = tier0Maker({ ...common, observedTradePrice: "0.51" });
    expect(touch.ok && through.ok && away.ok).toBe(true);
    if (!touch.ok || !through.ok || !away.ok) return;
    expect(touch.value.trigger).toBe("TOUCH");
    expect(through.value.trigger).toBe("TRADE_THROUGH");
    expect(away.value.trigger).toBe("NONE");
    expect(away.value.filledShares).toBe("0");
    expect(touch.value.fills[0]?.liquidityRole).toBe("MAKER");
  });
});

describe("Tier 1 immediate orders (§12.2, ADR-012 §5)", () => {
  const model = tier1Model({
    fillModelVersion: "sim/tier1/v1",
    fillModelParametersHash: "0".repeat(64),
  });
  const streams = () => deriveStreams("42");

  const base = {
    model,
    latencyModel: LATENCY,
    simulatedOrderId: "o-1",
    marketId: MARKET.marketId,
    side: "YES" as const,
    action: "BUY" as const,
    limitPrice: "0.6",
    shares: "10",
    postOnly: false,
    submittedAtNs: 1_000_000_000n,
    market: MARKET,
    feeSnapshot: FEES,
  };

  it("adds the four sampled latency components before it executes", () => {
    const outcome = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "100" }]),
      streams: streams(),
      timeInForce: "FAK",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.latency.totalMs).toBe(15); // 1 + 1 + 10 + 3
    expect(BigInt(outcome.value.arrivesAtNs)).toBe(1_000_000_000n + 15n * 1_000_000n);
    expect(outcome.value.matchableAtNs).toBe(outcome.value.arrivesAtNs);
  });

  it("adds the per-market trading delay and labels the order DELAYED (ADR-012 §5.1)", () => {
    const outcome = tier1Immediate({
      ...base,
      timeline: timeline([]),
      streams: streams(),
      timeInForce: "GTC",
      market: { ...MARKET, secondsDelay: 5 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.delayedByMarket).toBe(true);
    expect(BigInt(outcome.value.matchableAtNs) - BigInt(outcome.value.arrivesAtNs)).toBe(
      5n * 1_000n * 1_000_000n,
    );
  });

  it("FOK is all-or-nothing (venue report §2.3)", () => {
    const outcome = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "3" }]),
      streams: streams(),
      timeInForce: "FOK",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.fills).toHaveLength(0);
    expect(outcome.value.filledShares).toBe("0");
    expect(outcome.value.remainderDisposition).toBe("REJECTED_BY_FOK");
  });

  it("FAK fills what is available and cancels the remainder", () => {
    const outcome = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "3" }]),
      streams: streams(),
      timeInForce: "FAK",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.filledShares).toBe("3");
    expect(outcome.value.remainderDisposition).toBe("CANCELLED_BY_FAK");
  });

  it("a GTC remainder rests", () => {
    const outcome = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "3" }]),
      streams: streams(),
      timeInForce: "GTC",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.remainderDisposition).toBe("RESTS");
  });

  it("applies GTD's one-minute early expiry (ADR-012 §5.2)", () => {
    expect(GTD_EARLY_EXPIRY_MS).toBe(60_000);
    // Stated expiry 30 s after arrival: already expired, because the effective
    // expiry is 60 s EARLIER than the stated one.
    const expired = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "100" }]),
      streams: streams(),
      timeInForce: "GTD",
      statedExpiryNs: 1_000_000_000n + 30n * 1_000n * 1_000_000n,
    });
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;
    expect(expired.value.remainderDisposition).toBe("EXPIRED_BEFORE_MATCHING");
    expect(expired.value.fills).toHaveLength(0);
    expect(expired.value.atEvent).toBeNull();

    // Stated expiry 120 s out: still live at arrival.
    const live = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "100" }]),
      streams: streams(),
      timeInForce: "GTD",
      statedExpiryNs: 1_000_000_000n + 120n * 1_000n * 1_000_000n,
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.value.filledShares).toBe("10");
  });

  it("refuses postOnly on a non-resting type (venue report §2.3)", () => {
    const outcome = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "100" }]),
      streams: streams(),
      timeInForce: "FAK",
      postOnly: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATED_VENUE_PLAN_UNSUPPORTED");
  });

  it("refuses when no recorded book exists at the arrival instant (§6 invariant 12)", () => {
    const outcome = tier1Immediate({
      ...base,
      timeline: { bookAt: () => undefined },
      streams: streams(),
      timeInForce: "FAK",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATED_VENUE_NO_BOOK");
  });

  it("executes against the depth AT THE ARRIVAL INSTANT, not at submission", () => {
    // "Replay market events during the delay": the book improves between
    // submission and arrival, and the fill must see the improved book.
    const moving: DepthTimeline = {
      bookAt: ({ monotonicNs }) =>
        monotonicNs >= 1_000_000_000n + 15n * 1_000_000n
          ? { book: book([{ price: "0.45", size: "100" }]), atEvent: AT_EVENT }
          : { book: book([{ price: "0.59", size: "100" }]), atEvent: AT_EVENT },
    };
    const outcome = tier1Immediate({
      ...base,
      timeline: moving,
      streams: streams(),
      timeInForce: "FAK",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.fills[0]?.price).toBe("0.45");
  });

  it("refuses a latency model with an empty distribution", () => {
    const outcome = readLatencyModel({
      ...LATENCY,
      network: { samples: [] },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("FILL_MODEL_LATENCY_DISTRIBUTION_INVALID");
  });
});

describe("Tier 1 resting orders — queue-ahead and the band (§12.2)", () => {
  const model = tier1Model({
    fillModelVersion: "sim/tier1/v1",
    fillModelParametersHash: "0".repeat(64),
  });

  it("decrements queue-ahead by OBSERVED trades and fills only the spill", () => {
    const outcome = simulateResting({
      model,
      order: {
        simulatedOrderId: "o-1",
        marketId: MARKET.marketId,
        tokenId: "1234",
        side: "YES",
        action: "BUY",
        restingPrice: "0.5",
        shares: "50",
        queueAheadAtPlacement: "100",
        sameInstantAdditionsShares: "0",
        restingFromNs: 0n,
      },
      trades: [{ price: "0.5", shares: "130", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: { ...QUEUE, cancellationRatio: { OPTIMISTIC: "0", BASE: "0", CONSERVATIVE: "0" } },
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 130 traded − 100 ahead = 30 reaches us; 20 of our 50 remain.
    expect(outcome.value.base.filledShares).toBe("30");
    expect(outcome.value.base.remainingShares).toBe("20");
    expect(outcome.value.base.queueAheadRemaining).toBe("0");
  });

  it("a trade THROUGH the price sweeps the queue and fills the remainder", () => {
    const outcome = simulateResting({
      model,
      order: {
        simulatedOrderId: "o-1",
        marketId: MARKET.marketId,
        tokenId: "1234",
        side: "YES",
        action: "BUY",
        restingPrice: "0.5",
        shares: "50",
        queueAheadAtPlacement: "1000",
        sameInstantAdditionsShares: "0",
        restingFromNs: 0n,
      },
      trades: [{ price: "0.49", shares: "1", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.base.filledShares).toBe("50");
  });

  it("the CONSERVATIVE scenario is placed behind same-instant additions", () => {
    const outcome = simulateResting({
      model,
      order: {
        simulatedOrderId: "o-1",
        marketId: MARKET.marketId,
        tokenId: "1234",
        side: "YES",
        action: "BUY",
        restingPrice: "0.5",
        shares: "50",
        queueAheadAtPlacement: "100",
        sameInstantAdditionsShares: "40",
        restingFromNs: 0n,
      },
      trades: [{ price: "0.5", shares: "120", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: { ...QUEUE, cancellationRatio: { OPTIMISTIC: "0", BASE: "0", CONSERVATIVE: "0" } },
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.base.queueAheadAtPlacement).toBe("100");
    expect(outcome.value.conservative.queueAheadAtPlacement).toBe("140");
    expect(outcome.value.base.filledShares).toBe("20");
    expect(outcome.value.conservative.filledShares).toBe("0");
  });

  it("our own cancel takes effect soonest in the optimistic world and latest in the conservative one", () => {
    const outcome = simulateResting({
      model,
      order: {
        simulatedOrderId: "o-1",
        marketId: MARKET.marketId,
        tokenId: "1234",
        side: "YES",
        action: "BUY",
        restingPrice: "0.5",
        shares: "50",
        queueAheadAtPlacement: "0",
        sameInstantAdditionsShares: "0",
        restingFromNs: 0n,
        cancelRequestedAtNs: 0n,
      },
      // A trade 100 ms after the cancel request: inside the conservative
      // effectiveness window (250 ms) and outside the optimistic one (10 ms).
      trades: [{ price: "0.5", shares: "50", monotonicNs: 100n * 1_000_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.optimistic.fillsAfterCancelRequest).toBe("0");
    expect(outcome.value.conservative.fillsAfterCancelRequest).toBe("50");
    // The adverse quantity is ordered the other way, and the band check passes.
    expect(Number(outcome.value.optimistic.fillsAfterCancelRequest)).toBeLessThanOrEqual(
      Number(outcome.value.conservative.fillsAfterCancelRequest),
    );
  });
});
