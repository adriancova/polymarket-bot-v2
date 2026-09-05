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
  checkBandOrdering,
  computeFee,
  consumeDepth,
  deriveStreams,
  quoteForDeploymentDecision,
  readFeeScheduleSnapshot,
  readLatencyModel,
  readRoundingMode,
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
  type FeeRoundingMode,
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
    const summed = sizeAtPrice([{ price: "0.5", size: "1.5" }, { price: "0.5", size: "2.25" }], "0.5");
    expect(summed.ok).toBe(true);
    if (!summed.ok) return;
    expect(summed.value).toBe("3.75");
    const absent = sizeAtPrice([{ price: "0.5", size: "1" }], "0.6");
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.value).toBe("0");
  });

  it("REFUSES a non-canonical level rather than throwing (ADR-020 §6)", () => {
    // Round-1 review M4: `compareDecimal` throws on a type-valid non-canonical
    // string, and this door reached it unguarded.
    const hostile = sizeAtPrice([{ price: "1,5", size: "1" }], "0.5");
    expect(hostile.ok).toBe(false);
    if (hostile.ok) return;
    expect(hostile.refusal.code).toBe("SIMULATION_INPUT_INVALID");
    expect(sizeAtPrice([{ price: "0.5", size: "1" }], "zero").ok).toBe(false);
  });

  it("does not report stoppedAtLimit for an order that simply finished", () => {
    // Round-1 review L4 (probe P6): the walk used to test the limit before it
    // tested completion, so a fully filled order whose NEXT level was beyond
    // the limit reported that the limit had bound it.
    const complete = consumeDepth({
      ladder: [
        { price: "0.5", size: "10" },
        { price: "0.9", size: "10" },
      ],
      action: "BUY",
      limitPrice: "0.6",
      shares: "10",
    });
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;
    expect(complete.value.remainingShares).toBe("0");
    expect(complete.value.stoppedAtLimit).toBe(false);

    // …and an order that really was bound by its limit still says so.
    const bound = consumeDepth({
      ladder: [
        { price: "0.5", size: "10" },
        { price: "0.9", size: "10" },
      ],
      action: "BUY",
      limitPrice: "0.6",
      shares: "15",
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.value.remainingShares).toBe("5");
    expect(bound.value.stoppedAtLimit).toBe(true);
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
    const rounded = (value: string, places: number, mode: FeeRoundingMode): string => {
      const outcome = roundDecimal(value, places, mode);
      if (!outcome.ok) throw new Error(`${outcome.refusal.code}: ${outcome.refusal.message}`);
      return outcome.value;
    };
    expect(rounded("1.005", 2, "HALF_UP")).toBe("1.01");
    expect(rounded("1.005", 2, "HALF_EVEN")).toBe("1");
    expect(rounded("1.015", 2, "HALF_EVEN")).toBe("1.02");
    expect(rounded("1.0049", 2, "HALF_UP")).toBe("1");
    expect(rounded("1.0001", 2, "UP")).toBe("1.01");
    expect(rounded("1.0099", 2, "DOWN")).toBe("1");
    expect(rounded("9.999", 2, "UP")).toBe("10");
    expect(rounded("0.000001", 0, "UP")).toBe("1");
    expect(rounded("-1.005", 2, "HALF_UP")).toBe("-1.01");
  });

  it("REFUSES an unknown rounding mode instead of quietly rounding DOWN", () => {
    // Round-1 review M5 (probe Q4): `computeFee` fell through a `default:` in
    // its rounding switch, so an unrecognised mode truncated silently — a
    // direction the venue documentation does not state, chosen for the operator.
    const unknown = computeFee({
      shares: "100",
      price: "0.5",
      liquidityRole: "TAKER",
      snapshot: { ...FEES, roundingDecimalPlaces: 0, roundingMode: "SIDEWAYS" as FeeRoundingMode },
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.refusal.code).toBe("FILL_MODEL_FEE_SNAPSHOT_MISSING");
    expect(readRoundingMode("SIDEWAYS" as FeeRoundingMode).ok).toBe(false);
    expect(roundDecimal("1.005", 2, "SIDEWAYS" as FeeRoundingMode).ok).toBe(false);
  });

  it("REFUSES an INHERITED name offered as a rounding mode", () => {
    // Round-2 review N2: the closed vocabulary is now a `Record` keyed by mode,
    // and a bare `TABLE[mode]` answers for a name on `Object.prototype` — so
    // `"constructor"` would resolve to `Object` and read as a known mode. The
    // lookup is `Object.hasOwn`-guarded (ADR-020 §1), so it does not.
    for (const inherited of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
      expect(readRoundingMode(inherited as FeeRoundingMode).ok, inherited).toBe(false);
      expect(roundDecimal("1.005", 2, inherited as FeeRoundingMode).ok, inherited).toBe(false);
    }
    // …and the four it does implement are still accepted, so this is not vacuous.
    for (const mode of ["HALF_UP", "HALF_EVEN", "UP", "DOWN"] as const) {
      expect(readRoundingMode(mode).ok, mode).toBe(true);
    }
  });

  it("REFUSES a snapshot whose rate is not a canonical decimal, rather than throwing", () => {
    const hostile = computeFee({
      shares: "100",
      price: "0.5",
      liquidityRole: "TAKER",
      snapshot: { ...FEES, takerFeeRate: "1,5" },
    });
    expect(hostile.ok).toBe(false);
    if (hostile.ok) return;
    expect(hostile.refusal.code).toBe("FILL_MODEL_FEE_SNAPSHOT_MISSING");
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

  it("refuses an empty distribution ON THE EXECUTION PATH, not only at the door", () => {
    // Round-1 review M6 (probe U2): `sampleLatencyMs` falls back to `?? 0`, so
    // an unvalidated model turned "no latency data" into "no latency" — the
    // Tier-0 assumption §12.2 bounds to wiring use, wearing a Tier-1 label.
    const outcome = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "100" }]),
      streams: streams(),
      timeInForce: "FAK",
      latencyModel: { ...LATENCY, network: { samples: [] } },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("FILL_MODEL_LATENCY_DISTRIBUTION_INVALID");
  });

  it("refuses an unvalidated fee snapshot on the execution path", () => {
    const outcome = tier1Immediate({
      ...base,
      timeline: timeline([{ price: "0.5", size: "100" }]),
      streams: streams(),
      timeInForce: "FAK",
      feeSnapshot: { ...FEES, roundingMode: "SIDEWAYS" as FeeRoundingMode },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("FILL_MODEL_FEE_SNAPSHOT_MISSING");
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
        sameInstantAdditions: { observedShares: "0" },
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
        sameInstantAdditions: { observedShares: "0" },
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
        sameInstantAdditions: { observedShares: "40" },
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
        sameInstantAdditions: { observedShares: "0" },
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
    // The effectiveness INSTANTS are ordered, which is what the delay ordering
    // actually implies — 10 ms, 50 ms and 250 ms after the same request.
    expect(outcome.value.optimistic.cancelEffectiveAtNs).toBe("10000000");
    expect(outcome.value.base.cancelEffectiveAtNs).toBe("50000000");
    expect(outcome.value.conservative.cancelEffectiveAtNs).toBe("250000000");
  });

  it("REFUSES observed trades that are not in recorded monotonic order", () => {
    // Round-1 review M10 (probe P5): the walk stops at the first trade at or
    // after its cancel-effectiveness instant, so an unsorted list truncated the
    // walk and returned a SMALLER fill as though it were the answer — the same
    // trades, sorted, gave 10 rather than 0.
    const restingOrder = {
      simulatedOrderId: "o-1",
      marketId: MARKET.marketId,
      tokenId: "1234",
      side: "YES" as const,
      action: "BUY" as const,
      restingPrice: "0.5",
      shares: "50",
      queueAheadAtPlacement: "0",
      sameInstantAdditions: { observedShares: "0" },
      restingFromNs: 0n,
      cancelRequestedAtNs: 4_000n,
    };
    const parameters: QueueModelParameters = {
      ...QUEUE,
      cancellationRatio: { OPTIMISTIC: "0", BASE: "0", CONSERVATIVE: "0" },
      cancelEffectiveAfterMs: { OPTIMISTIC: 0, BASE: 0, CONSERVATIVE: 0 },
    };
    const early = { price: "0.5", shares: "10", monotonicNs: 1_000n, atEvent: AT_EVENT };
    const late = { price: "0.5", shares: "10", monotonicNs: 5_000n, atEvent: AT_EVENT };

    const sorted = simulateResting({
      model,
      order: restingOrder,
      trades: [early, late],
      parameters,
      feeSnapshot: FEES,
    });
    expect(sorted.ok).toBe(true);
    if (!sorted.ok) return;
    expect(sorted.value.base.filledShares).toBe("10");

    const unsorted = simulateResting({
      model,
      order: restingOrder,
      trades: [late, early],
      parameters,
      feeSnapshot: FEES,
    });
    expect(unsorted.ok).toBe(false);
    if (unsorted.ok) return;
    expect(unsorted.refusal.code).toBe("SIMULATION_INPUT_INVALID");
    expect(unsorted.refusal.message).toContain("non-decreasing");
  });

  // -------------------------------------------------------------------------
  // The derivation's HYPOTHESES, enforced at the door that cites them
  // (round-2 review, MEDIUM-2)
  // -------------------------------------------------------------------------

  const signedOrder = {
    simulatedOrderId: "o-1",
    marketId: MARKET.marketId,
    tokenId: "1234",
    side: "YES" as const,
    action: "BUY" as const,
    restingPrice: "0.5",
    shares: "50",
    queueAheadAtPlacement: "100",
    sameInstantAdditions: { observedShares: "0" },
    restingFromNs: 0n,
  };
  const noCancellation: QueueModelParameters = {
    ...QUEUE,
    cancellationRatio: { OPTIMISTIC: "0", BASE: "0", CONSERVATIVE: "0" },
  };

  it("REFUSES a NEGATIVE observed trade size instead of computing a nonsense band", () => {
    // Reviewer probe: `trade.shares = "-57"` was ACCEPTED at `52a058b` and the
    // queue ahead GREW (100 -> 185.5 optimistic, 157 conservative) because the
    // per-trade step ran backwards. `checkBandOrdering`'s pre-cancel ordering is
    // derived over non-negative sizes, so with a negative one the ordering it
    // asserts is not a property of the model at all — in 775 of the reviewer's
    // 200k randomized negative-input trials it actually inverted.
    const outcome = simulateResting({
      model,
      order: signedOrder,
      trades: [{ price: "0.5", shares: "-57", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATION_INPUT_INVALID");
    expect(outcome.refusal.message).toContain("positive size");
    // The refusal names the TRADE, not the band's ordering.
    expect(outcome.refusal.message).not.toContain("OPTIMISTIC >= BASE");
  });

  it("REFUSES a zero-size observed trade too — the venue's own bound, exactly", () => {
    const outcome = simulateResting({
      model,
      order: signedOrder,
      trades: [{ price: "0.5", shares: "0", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.message).toContain("positive size");
  });

  it("REFUSES negative same-instant additions, and says WHY — not by blaming the band", () => {
    // Reviewer probe: `sameInstantAdditionsShares = "-40"` produced a
    // `FILL_MODEL_BAND_INCONSISTENT` refusal reading "the band is not ordered …
    // which follows from the parameter ordering", which MISATTRIBUTED an
    // unvalidated input to the derivation. The input is now refused where the
    // derivation is written down.
    const outcome = simulateResting({
      model,
      order: { ...signedOrder, sameInstantAdditions: { observedShares: "-40" } },
      trades: [{ price: "0.5", shares: "120", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: noCancellation,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATION_INPUT_INVALID");
    expect(outcome.refusal.message).toContain("non-negative");
    expect(outcome.refusal.code).not.toBe("FILL_MODEL_BAND_INCONSISTENT");
    expect(outcome.refusal.message).not.toContain("the band is not ordered");
  });

  it.each([
    ["shares", "-50"],
    ["queueAheadAtPlacement", "-100"],
  ] as const)("REFUSES a negative %s at the door, naming the field", (field, value) => {
    const outcome = simulateResting({
      model,
      order: { ...signedOrder, [field]: value },
      trades: [{ price: "0.5", shares: "120", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATION_INPUT_INVALID");
    expect(outcome.refusal.message).toContain(field);
    expect(outcome.refusal.message).toContain("non-negative");
  });

  it.each([
    ["-0.5", "a negative resting price"],
    ["0", "a zero resting price"],
  ])("REFUSES %s (round-3 review, NOTE-3): the same bound, applied to PRICE", (price) => {
    // Round 3 NOTE-3: the sign bound the round-2 fix applied to SIZES was not
    // applied to PRICES, so `restingPrice: "-0.5"` produced an ACCEPTED band
    // that serialized as `band … price=-0.5 …`. The price is what the fee is
    // computed on (`fee = C × rate × p × (1 − p)`) and what the §12.4 `band`
    // line prints, so the door enforces what its own computation assumes rather
    // than inheriting the venue's guard.
    const outcome = simulateResting({
      model,
      order: { ...signedOrder, restingPrice: price },
      // A VALID trade, so the only bound that can fire is the ORDER's own price
      // bound. (Written the other way first, this test passed with the order
      // bound deleted, because the trade-price bound answered instead.)
      trades: [{ price: "0.5", shares: "120", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATION_INPUT_INVALID");
    expect(outcome.refusal.message).toContain("a resting order's price is strictly positive");
    // The refusal names the INPUT, not the band's ordering.
    expect(outcome.refusal.message).not.toContain("OPTIMISTIC >= BASE");
  });

  it.each([
    ["-0.5", "a negative traded price"],
    ["0", "a zero traded price"],
  ])("REFUSES an observed trade printed at %s", (price) => {
    const outcome = simulateResting({
      model,
      order: signedOrder,
      trades: [{ price, shares: "120", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("SIMULATION_INPUT_INVALID");
    expect(outcome.refusal.message).toContain("positive price");
  });

  it("still ACCEPTS the boundary values the bounds admit", () => {
    // The bounds are the venue's, exactly: quantities >= 0, traded size > 0 and
    // prices > 0. A zero queue ahead and zero observed additions are ordinary
    // facts, and a price may be arbitrarily small without being zero.
    const outcome = simulateResting({
      model,
      order: {
        ...signedOrder,
        restingPrice: "0.000001",
        queueAheadAtPlacement: "0",
        sameInstantAdditions: { observedShares: "0" },
      },
      trades: [
        { price: "0.000001", shares: "0.000001", monotonicNs: 1_000n, atEvent: AT_EVENT },
      ],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok, outcome.ok ? "" : `${outcome.refusal.code}: ${outcome.refusal.message}`).toBe(
      true,
    );
  });
});

describe("the band's ordering claim is exactly what the parameters imply (§12.2, ADR-012 §1)", () => {
  const model = tier1Model({
    fillModelVersion: "sim/tier1/v1",
    fillModelParametersHash: "0".repeat(64),
  });

  const restingOrder = {
    simulatedOrderId: "o-1",
    marketId: MARKET.marketId,
    tokenId: "1234",
    side: "YES" as const,
    action: "BUY" as const,
    restingPrice: "0.5",
    shares: "50",
    queueAheadAtPlacement: "100",
    sameInstantAdditions: { observedShares: "0" },
    restingFromNs: 0n,
    cancelRequestedAtNs: 0n,
  };

  /** The same order with no cancel requested at all (not `undefined` for it). */
  function withoutCancelRequest(order: typeof restingOrder) {
    const rest: Record<string, unknown> = { ...order };
    delete rest["cancelRequestedAtNs"];
    return rest as Omit<typeof restingOrder, "cancelRequestedAtNs">;
  }

  /**
   * The two parameterizations the previous, non-derivable post-cancel ordering
   * REFUSED (round-1 review HIGH-1, probes P1 and Q5). Both are admissible: they
   * pass `readQueueModelParameters`, and each is a world in which one of the two
   * opposing forces — a longer effectiveness window, a higher cancellation
   * ratio — dominates the other. A band is required, not a monotone one.
   */
  it("P1: ratios 1/0/0 with delays 10/20/30 ms produce a labelled three-scenario band", () => {
    const outcome = simulateResting({
      model,
      order: { ...restingOrder, queueAheadAtPlacement: "50" },
      trades: [{ price: "0.5", shares: "50", monotonicNs: 5n * 1_000_000n, atEvent: AT_EVENT }],
      parameters: {
        queueModelVersion: "sim/queue/p1",
        cancellationRatio: { OPTIMISTIC: "1", BASE: "0", CONSERVATIVE: "0" },
        cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 20, CONSERVATIVE: 30 },
        placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
        basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
      },
      feeSnapshot: FEES,
    });
    expect(outcome.ok, outcome.ok ? "" : `${outcome.refusal.code}: ${outcome.refusal.message}`).toBe(
      true,
    );
    if (!outcome.ok) return;
    expect(outcome.value.optimistic.scenario).toBe("OPTIMISTIC");
    expect(outcome.value.base.scenario).toBe("BASE");
    expect(outcome.value.conservative.scenario).toBe("CONSERVATIVE");
    // The optimistic world's higher cancellation ratio empties the queue ahead,
    // so it fills after the cancel request where the others do not. That is the
    // model working, not a broken band.
    expect(outcome.value.optimistic.fillsAfterCancelRequest).toBe("50");
    expect(outcome.value.base.fillsAfterCancelRequest).toBe("0");
    expect(outcome.value.conservative.fillsAfterCancelRequest).toBe("0");
  });

  it("Q5: ratios .5/.25/.1 with delays 50/150/300 ms produce a labelled three-scenario band", () => {
    const outcome = simulateResting({
      model,
      order: restingOrder,
      trades: [{ price: "0.5", shares: "120", monotonicNs: 100n * 1_000_000n, atEvent: AT_EVENT }],
      parameters: {
        queueModelVersion: "sim/queue/q5",
        cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.25", CONSERVATIVE: "0.1" },
        cancelEffectiveAfterMs: { OPTIMISTIC: 50, BASE: 150, CONSERVATIVE: 300 },
        placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: false },
        basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
      },
      feeSnapshot: FEES,
    });
    expect(outcome.ok, outcome.ok ? "" : `${outcome.refusal.code}: ${outcome.refusal.message}`).toBe(
      true,
    );
    if (!outcome.ok) return;
    // Both forces bind here, in different pairs: the optimistic cancel lands
    // before the trade (0), the base window admits it and its ratio clears the
    // queue (50), and the conservative window admits it but its lower ratio
    // leaves queue ahead (32). Non-monotone, and correct.
    expect(outcome.value.optimistic.fillsAfterCancelRequest).toBe("0");
    expect(outcome.value.base.fillsAfterCancelRequest).toBe("50");
    expect(outcome.value.conservative.fillsAfterCancelRequest).toBe("32");
  });

  it("keeps the ordering that IS derivable: fills BEFORE the cancel request", () => {
    // Every scenario walks the same pre-request trades, so only the ratio and
    // the queue ahead differ — and both are pinned in the same direction by
    // `readQueueModelParameters`. Here the ordering is STRICT, so the check
    // below is binding rather than trivially satisfied by three equal numbers.
    const outcome = simulateResting({
      model,
      order: {
        ...restingOrder,
        shares: "1000",
        queueAheadAtPlacement: "100",
        sameInstantAdditions: { observedShares: "50" },
        cancelRequestedAtNs: 10_000n,
      },
      trades: [{ price: "0.5", shares: "100", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(outcome.ok, outcome.ok ? "" : `${outcome.refusal.code}: ${outcome.refusal.message}`).toBe(
      true,
    );
    if (!outcome.ok) return;
    const preCancel = (scenario: { filledShares: string; fillsAfterCancelRequest: string }) =>
      Number(scenario.filledShares) - Number(scenario.fillsAfterCancelRequest);
    expect(preCancel(outcome.value.optimistic)).toBeGreaterThan(preCancel(outcome.value.base));
    expect(preCancel(outcome.value.base)).toBeGreaterThan(preCancel(outcome.value.conservative));
  });

  it("REFUSES a band whose pre-cancel fills are ordered the wrong way", () => {
    // The same strictly-ordered parameterization as above: 50 / 10 / 0 filled,
    // so swapping two members really does invert the ordering.
    const built = simulateResting({
      model,
      order: {
        ...withoutCancelRequest(restingOrder),
        shares: "1000",
        queueAheadAtPlacement: "100",
        sameInstantAdditions: { observedShares: "50" },
      },
      trades: [{ price: "0.5", shares: "100", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.optimistic.filledShares).not.toBe(built.value.conservative.filledShares);
    // Swap the optimistic and conservative members: the same three outcomes,
    // filed under the wrong names.
    const swapped = {
      ...built.value,
      optimistic: { ...built.value.conservative, scenario: "OPTIMISTIC" as const },
      conservative: { ...built.value.optimistic, scenario: "CONSERVATIVE" as const },
    };
    const checked = checkBandOrdering(swapped);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.refusal.code).toBe("FILL_MODEL_BAND_INCONSISTENT");
    expect(checked.refusal.message).toContain("before a cancel");
  });

  it("REFUSES a band whose members are mislabelled, or whose fills do not add up", () => {
    const built = simulateResting({
      model,
      order: withoutCancelRequest(restingOrder),
      trades: [{ price: "0.5", shares: "150", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const mislabelled = checkBandOrdering({
      ...built.value,
      base: { ...built.value.base, scenario: "OPTIMISTIC" as never },
    });
    expect(mislabelled.ok).toBe(false);
    if (mislabelled.ok) return;
    expect(mislabelled.refusal.message).toContain("misleading names");

    const inflated = checkBandOrdering({
      ...built.value,
      optimistic: { ...built.value.optimistic, filledShares: "999" },
    });
    expect(inflated.ok).toBe(false);
    if (inflated.ok) return;
    expect(inflated.refusal.code).toBe("FILL_MODEL_BAND_INCONSISTENT");

    const impossible = checkBandOrdering({
      ...built.value,
      base: { ...built.value.base, fillsAfterCancelRequest: "999" },
    });
    expect(impossible.ok).toBe(false);
  });

  it("REFUSES a band whose cancel effectiveness is ordered the wrong way", () => {
    const built = simulateResting({
      model,
      order: restingOrder,
      trades: [],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const inverted = checkBandOrdering({
      ...built.value,
      optimistic: { ...built.value.optimistic, cancelEffectiveAtNs: "999999999" },
    });
    expect(inverted.ok).toBe(false);
    if (inverted.ok) return;
    expect(inverted.refusal.message).toContain("cancel effectiveness");
  });

  it("REFUSES a hostile band rather than throwing (ADR-020 §6)", () => {
    const hostile = checkBandOrdering({
      model,
      queueModelVersion: "v",
      simulatedOrderId: "o-1",
      marketId: MARKET.marketId,
      restingPrice: "0.5",
      optimistic: { scenario: "OPTIMISTIC", filledShares: "1,5" },
      base: { scenario: "BASE", filledShares: "0" },
      conservative: { scenario: "CONSERVATIVE", filledShares: "0" },
      bandBasis: "OPTIMISTIC_BASE_CONSERVATIVE_CANCELLATION_ASSUMPTIONS",
      quotationRule: "REPORT_THE_BAND_NEVER_ONE_MEMBER",
    } as never);
    expect(hostile.ok).toBe(false);
    if (hostile.ok) return;
    expect(hostile.refusal.code).toBe("SIMULATION_INPUT_INVALID");
  });
});

describe("what may be quoted in a deployment decision (ADR-012 §1)", () => {
  const tier1 = tier1Model({
    fillModelVersion: "sim/tier1/v1",
    fillModelParametersHash: "0".repeat(64),
  });
  const tier0 = tier0Model({
    fillModelVersion: "sim/tier0/v1",
    fillModelParametersHash: "0".repeat(64),
  });

  it("REFUSES a Tier-1 result that is a single number wearing a Tier-1 identity", () => {
    // Round-1 review M7 (probe P2): the gate checked the identity STRING only,
    // so `{ model, filledShares }` — the exact thing ADR-012 §1 forbids —
    // passed it.
    const quoted = quoteForDeploymentDecision({ model: tier1, filledShares: "10" });
    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.refusal.code).toBe("FILL_MODEL_BAND_INCONSISTENT");
    expect(quoted.refusal.message).toContain("has already violated this ADR");
  });

  it("ACCEPTS the band itself", () => {
    const band = simulateResting({
      model: tier1,
      order: {
        simulatedOrderId: "o-1",
        marketId: MARKET.marketId,
        tokenId: "1234",
        side: "YES",
        action: "BUY",
        restingPrice: "0.5",
        shares: "50",
        queueAheadAtPlacement: "10",
        sameInstantAdditions: { observedShares: "0" },
        restingFromNs: 0n,
      },
      trades: [{ price: "0.5", shares: "30", monotonicNs: 1_000n, atEvent: AT_EVENT }],
      parameters: QUEUE,
      feeSnapshot: FEES,
    });
    expect(band.ok).toBe(true);
    if (!band.ok) return;
    expect(quoteForDeploymentDecision(band.value).ok).toBe(true);
  });

  it("still REFUSES a Tier-0 result (P2b)", () => {
    const quoted = quoteForDeploymentDecision({ model: tier0 } as never);
    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.refusal.message).toContain("pipeline-smoke");
  });

  it("REFUSES a value with no model at all rather than throwing", () => {
    expect(quoteForDeploymentDecision(null as never).ok).toBe(false);
    expect(quoteForDeploymentDecision({} as never).ok).toBe(false);
  });
});
