/**
 * Intent normalization: disposition, legs, and CONSERVATIVE BOUNDING.
 *
 * Every bounding choice here must overstate risk rather than understate it, so
 * each test states which direction its case errs in.
 */

import { describe, expect, it } from "vitest";

import { IntentSchema } from "../../../packages/domain/src/index.js";
import { buildIntentView, heldShares } from "../../../packages/risk/src/index.js";
import { MARKET_A, MARKET_B, VALID_UNTIL, positionIntent } from "./fixtures.js";

const emptyPortfolio = { positions: [], openOrders: [] } as const;

function view(intent: unknown, portfolio: unknown = emptyPortfolio) {
  const parsed = IntentSchema.parse(intent);
  return buildIntentView(
    parsed,
    portfolio as { positions: never[]; openOrders: never[] },
  );
}

describe("disposition is derived from the intent TYPE", () => {
  it("REDUCE_POSITION is an EXIT", () => {
    const built = view(
      { type: "REDUCE_POSITION", marketId: MARKET_A, targetShares: "0", urgency: "NORMAL", reason: "r" },
      { positions: [{ marketId: MARKET_A, side: "YES", shares: "10", costBasis: "5" }], openOrders: [] },
    );
    expect(built.view.disposition).toBe("EXIT");
  });

  it("CANCEL is a CANCEL", () => {
    expect(view({ type: "CANCEL", reason: "r" }).view.disposition).toBe("CANCEL");
  });

  it("a POSITION that happens to reduce is still an ENTRY — the stricter treatment", () => {
    const built = view(positionIntent({ targetShares: "-10" }), {
      positions: [{ marketId: MARKET_A, side: "YES", shares: "100", costBasis: "40" }],
      openOrders: [],
    });
    expect(built.view.disposition).toBe("ENTRY");
    expect(built.view.legs[0]?.action).toBe("SELL");
  });
});

describe("conservative bounding", () => {
  it("takes the TIGHTER of maximumBuyPrice × shares and maximumTotalCost", () => {
    const byCost = view(positionIntent({ maximumTotalCost: "10" }));
    expect(byCost.view.boundedCost).toBe("10");
    const byPrice = view(positionIntent({ maximumTotalCost: "1000" }));
    expect(byPrice.view.boundedCost).toBe("50");
  });

  it("reports UNBOUNDED (undefined, never zero) when the intent bounds no ceiling", () => {
    const intent = positionIntent();
    delete intent["maximumBuyPrice"];
    expect(view(intent).view.boundedCost).toBeUndefined();
  });

  it("a SELL leg commits no new pUSD", () => {
    const built = view(positionIntent({ targetShares: "-10", minimumSellPrice: "0.9" }), {
      positions: [{ marketId: MARKET_A, side: "YES", shares: "100", costBasis: "40" }],
      openOrders: [],
    });
    expect(built.view.legs[0]?.boundedCost).toBe("0");
    expect(built.view.buyShares).toBe("0");
  });

  it("an ABSOLUTE target resolves against the held quantity", () => {
    const built = view(positionIntent({ targetMode: "ABSOLUTE", targetShares: "150" }), {
      positions: [{ marketId: MARKET_A, side: "YES", shares: "100", costBasis: "40" }],
      openOrders: [],
    });
    expect(built.view.legs[0]?.action).toBe("BUY");
    expect(built.view.legs[0]?.shares).toBe("50");
    expect(built.view.boundedCost).toBe("25");
  });

  it("refuses a zero delta rather than emitting a no-op leg", () => {
    const built = view(positionIntent({ targetMode: "ABSOLUTE", targetShares: "100" }), {
      positions: [{ marketId: MARKET_A, side: "YES", shares: "100", costBasis: "40" }],
      openOrders: [],
    });
    expect(built.refusals.map((r) => r.code)).toEqual(["RISK_ZERO_DELTA"]);
    expect(built.view.legs).toEqual([]);
  });

  it("a QUOTE's bid levels carry no outcome token and bound their own cost", () => {
    const built = view({
      type: "QUOTE",
      intentId: "q",
      marketId: MARKET_A,
      bids: [
        { price: "0.4", shares: "10" },
        { price: "0.3", shares: "20" },
      ],
      asks: [{ price: "0.9", shares: "5" }],
      postOnly: true,
      quoteLifetimeMs: 1000,
      replaceThresholdTicks: 1,
      maximumInventory: "100",
      tags: [],
    });
    expect(built.view.legs.filter((leg) => leg.action === "BUY").every((leg) => leg.side === undefined)).toBe(true);
    // 0.4 × 10 + 0.3 × 20 = 10, exactly.
    expect(built.view.boundedCost).toBe("10");
    expect(built.view.buyShares).toBe("30");
  });

  it("a BASKET's combined ceiling tightens the per-leg sum, and legs span markets", () => {
    const built = view({
      type: "BASKET",
      intentId: "b",
      legs: [
        { marketId: MARKET_A, direction: "YES", targetShares: "100", maximumBuyPrice: "0.5" },
        { marketId: MARKET_B, direction: "NO", targetShares: "100", maximumBuyPrice: "0.5" },
      ],
      maximumCombinedCost: "60",
      minimumLockedEdge: "1",
      legRiskLimit: "10",
      failurePolicy: "ABANDON",
      validUntil: VALID_UNTIL,
    });
    expect([...built.view.marketIds].sort()).toEqual([MARKET_A, MARKET_B].sort());
    // Per-leg sum is 100; the basket's own ceiling of 60 is tighter and wins.
    expect(built.view.boundedCost).toBe("60");
  });

  it("refuses a buying BASKET leg with no price ceiling", () => {
    const built = view({
      type: "BASKET",
      intentId: "b",
      legs: [{ marketId: MARKET_A, direction: "YES", targetShares: "100" }],
      maximumCombinedCost: "60",
      minimumLockedEdge: "1",
      legRiskLimit: "10",
      failurePolicy: "ABANDON",
      validUntil: VALID_UNTIL,
    });
    expect(built.refusals.map((r) => r.code)).toContain("RISK_BASKET_LEG_UNBOUNDED");
  });

  it("returns a frozen view", () => {
    const built = view(positionIntent());
    expect(Object.isFrozen(built.view)).toBe(true);
    expect(() => {
      (built.view.legs as unknown as { length: number }).length = 0;
    }).toThrow(TypeError);
  });
});

describe("heldShares", () => {
  it("sums a side's positions and ignores the other side and other markets", () => {
    const portfolio = {
      positions: [
        { marketId: MARKET_A, side: "YES" as const, shares: "10", costBasis: "4" },
        { marketId: MARKET_A, side: "YES" as const, shares: "2.5", costBasis: "1" },
        { marketId: MARKET_A, side: "NO" as const, shares: "7", costBasis: "3" },
        { marketId: MARKET_B, side: "YES" as const, shares: "99", costBasis: "40" },
      ],
      openOrders: [],
    };
    expect(heldShares(portfolio, MARKET_A, "YES")).toBe("12.5");
    expect(heldShares(portfolio, MARKET_A, "NO")).toBe("7");
    expect(heldShares(portfolio, "unknown-market", "YES")).toBe("0");
  });
});
