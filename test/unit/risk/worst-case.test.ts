/**
 * Worst-case contractual loss: the payoff arithmetic, and its PIN to WP-110.
 *
 * `packages/risk` and `packages/settlement` are both layer 1 and
 * `docs/contracts/dependency-direction.md` §2.1 lists no edge between them, so
 * the risk engine cannot IMPORT WP-110's payoff constants — it mirrors them.
 * A mirror rots silently, so this suite imports BOTH packages (a test tree is
 * not a workspace package and declares no edge) and asserts they agree. A
 * settlement-side change to a payout, or to the `CANCELLED` refusal, fails this
 * suite rather than leaving the risk engine quietly wrong.
 */

import { describe, expect, it } from "vitest";

import {
  LOSING_TOKEN_PAYOUT_PER_SHARE as SETTLEMENT_LOSING,
  SPLIT_50_50_PAYOUT_PER_SHARE as SETTLEMENT_SPLIT,
  WINNING_TOKEN_PAYOUT_PER_SHARE as SETTLEMENT_WINNING,
  payoutPerShare,
} from "../../../packages/settlement/src/index.js";
import {
  CANCELLED_OUTCOME_TREATMENT,
  LOSING_TOKEN_PAYOUT_PER_SHARE,
  SPLIT_50_50_PAYOUT_PER_SHARE,
  VERIFIED_TERMINAL_OUTCOMES,
  WINNING_TOKEN_PAYOUT_PER_SHARE,
  assessWorstCase,
  buildWorstCaseLots,
  settlementValueUnderOutcome,
} from "../../../packages/risk/src/index.js";

describe("WP-110 payoff pin", () => {
  it("mirrors `packages/settlement`'s per-share payouts exactly", () => {
    expect(WINNING_TOKEN_PAYOUT_PER_SHARE).toBe(SETTLEMENT_WINNING);
    expect(LOSING_TOKEN_PAYOUT_PER_SHARE).toBe(SETTLEMENT_LOSING);
    expect(SPLIT_50_50_PAYOUT_PER_SHARE).toBe(SETTLEMENT_SPLIT);
  });

  it("mirrors the per-outcome, per-token table `payoutPerShare` publishes", () => {
    for (const outcome of VERIFIED_TERMINAL_OUTCOMES) {
      const settlement = payoutPerShare(outcome);
      expect(settlement.ok).toBe(true);
      if (!settlement.ok) continue;
      // One YES share and zero NO shares settle at the YES per-share payout.
      expect(settlementValueUnderOutcome("1", "0", outcome)).toBe(settlement.value.yes);
      expect(settlementValueUnderOutcome("0", "1", outcome)).toBe(settlement.value.no);
    }
  });

  it("covers exactly the outcomes WP-110 will value — CANCELLED is not one of them", () => {
    expect([...VERIFIED_TERMINAL_OUTCOMES]).toEqual(["YES_WIN", "NO_WIN", "SPLIT_50_50"]);
    const cancelled = payoutPerShare("CANCELLED");
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.refusals[0]?.code).toBe("SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED");
  });

  it("bounds the unverified CANCELLED outcome instead of valuing it (register row U-10)", () => {
    const assessment = assessWorstCase([
      { marketId: "m", yesShares: "100", noShares: "100", committedCost: "80" },
    ]);
    expect(assessment.cancelledOutcomeTreatment).toBe("ZERO_REDEMPTION_FLOOR_UNVERIFIED_U10");
    expect(CANCELLED_OUTCOME_TREATMENT).toBe("ZERO_REDEMPTION_FLOOR_UNVERIFIED_U10");
    // A fully hedged YES/NO pair is NOT credited its verified hedge value in
    // the PRIMARY measure: crediting it would rely on a cancellation payout the
    // venue documents nowhere.
    expect(assessment.maximumContractualLoss).toBe("80");
    // The VERIFIED-outcome measure does credit the hedge: 100 of either token
    // redeems 100 under every verified outcome, so the position is profitable.
    expect(assessment.worstCaseResolutionLoss).toBe("-20");
  });
});

describe("both-token, per-outcome settlement value", () => {
  it("YES_WIN pays the YES token and zeroes the NO token", () => {
    expect(settlementValueUnderOutcome("100", "40", "YES_WIN")).toBe("100");
  });

  it("NO_WIN pays the NO token and zeroes the YES token", () => {
    expect(settlementValueUnderOutcome("100", "40", "NO_WIN")).toBe("40");
  });

  it("SPLIT_50_50 pays 0.5 for every share of EITHER token", () => {
    expect(settlementValueUnderOutcome("100", "40", "SPLIT_50_50")).toBe("70");
  });

  it("is exact for decimal share counts (no binary float, §6 invariant 1)", () => {
    expect(settlementValueUnderOutcome("0.1", "0.2", "SPLIT_50_50")).toBe("0.15");
    expect(settlementValueUnderOutcome("0.1", "0.2", "YES_WIN")).toBe("0.1");
  });
});

describe("assessWorstCase", () => {
  it("selects the worst VERIFIED outcome per market and sums exactly", () => {
    const assessment = assessWorstCase([
      { marketId: "m1", yesShares: "100", noShares: "0", committedCost: "50" },
      { marketId: "m2", yesShares: "0", noShares: "10", committedCost: "6" },
    ]);
    expect(assessment.committedCost).toBe("56");
    expect(assessment.maximumContractualLoss).toBe("56");
    expect(assessment.perMarket[0]?.worstVerifiedOutcome).toBe("NO_WIN");
    expect(assessment.perMarket[0]?.worstVerifiedValue).toBe("0");
    expect(assessment.perMarket[1]?.worstVerifiedOutcome).toBe("YES_WIN");
    expect(assessment.perMarket[1]?.worstVerifiedValue).toBe("0");
    expect(assessment.worstCaseResolutionLoss).toBe("56");
  });

  it("returns a deeply frozen assessment", () => {
    const assessment = assessWorstCase([
      { marketId: "m", yesShares: "1", noShares: "0", committedCost: "1" },
    ]);
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(() => {
      (assessment as { maximumContractualLoss: string }).maximumContractualLoss = "0";
    }).toThrow(TypeError);
  });

  it("an empty lot set has zero committed cost and zero loss", () => {
    const assessment = assessWorstCase([]);
    expect(assessment.maximumContractualLoss).toBe("0");
    expect(assessment.worstCaseResolutionLoss).toBe("0");
  });
});

describe("buildWorstCaseLots", () => {
  const emptyView = {
    disposition: "ENTRY" as const,
    intentId: undefined,
    validUntil: undefined,
    marketIds: [],
    legs: [],
    boundedCost: "0",
    buyShares: "0",
  };

  it("counts positions AND resting BUY orders, and ignores resting SELL orders", () => {
    const lots = buildWorstCaseLots(
      {
        positions: [{ marketId: "m", side: "YES", shares: "10", costBasis: "4" }],
        openOrders: [
          {
            orderId: "buy",
            marketId: "m",
            side: "NO",
            action: "BUY",
            price: "0.3",
            shares: "20",
          },
          {
            orderId: "sell",
            marketId: "m",
            side: "YES",
            action: "SELL",
            price: "0.9",
            shares: "10",
          },
        ],
      },
      emptyView,
    );
    expect(lots).toEqual([{ marketId: "m", yesShares: "10", noShares: "20", committedCost: "10" }]);
  });

  it("returns undefined when a BUY leg bounds no cost (the fail-closed signal)", () => {
    const lots = buildWorstCaseLots(
      { positions: [], openOrders: [] },
      {
        ...emptyView,
        marketIds: ["m"],
        legs: [
          {
            marketId: "m",
            side: "YES",
            action: "BUY",
            shares: "10",
            limitPrice: undefined,
            boundedCost: undefined,
          },
        ],
        boundedCost: undefined,
      },
    );
    expect(lots).toBeUndefined();
  });

  it("places a QUOTE's token-less shares on whichever side settles WORSE", () => {
    // 100 NO already held. Assigning the token-less shares to YES would build
    // a hedge worth at least 100 under every verified outcome; assigning them
    // to NO leaves a worst verified value of 0 (YES_WIN pays the NO token
    // nothing). The WORSE assignment — all on NO — is the one taken.
    const lots = buildWorstCaseLots(
      {
        positions: [{ marketId: "m", side: "NO", shares: "100", costBasis: "50" }],
        openOrders: [],
      },
      {
        ...emptyView,
        marketIds: ["m"],
        legs: [
          {
            marketId: "m",
            side: undefined,
            action: "BUY",
            shares: "100",
            limitPrice: "0.5",
            boundedCost: "50",
          },
        ],
        boundedCost: "50",
      },
    );
    expect(lots).toEqual([
      { marketId: "m", yesShares: "0", noShares: "200", committedCost: "100" },
    ]);
    expect(assessWorstCase(lots ?? []).worstCaseResolutionLoss).toBe("100");
  });

  it("orders lots deterministically by market id", () => {
    const lots = buildWorstCaseLots(
      {
        positions: [
          { marketId: "m-b", side: "YES", shares: "1", costBasis: "1" },
          { marketId: "m-a", side: "YES", shares: "1", costBasis: "1" },
        ],
        openOrders: [],
      },
      emptyView,
    );
    expect(lots?.map((lot) => lot.marketId)).toEqual(["m-a", "m-b"]);
  });
});
