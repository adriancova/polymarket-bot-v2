/**
 * WP-290: the pure pieces, one rule at a time.
 *
 * - The ledger's UNATTRIBUTED correction (`buildUnattributedCorrection`): the
 *   real `Ledger` accepts it; its projection records the halt obligation.
 * - The holding comparison (`compareHolding`, `pendingDeltas`): the all-or-
 *   nothing in-transit rule, and exactness of fees.
 * - The read door (`door.ts`): both trade-status spellings (E-13), C-3
 *   refused, routes checked, every malformed shape refused rather than read
 *   as empty.
 * - Signed identity (`identity.ts`): the strict rule, in both directions.
 */

import { describe, expect, it } from "vitest";

import {
  Ledger,
  applyTransaction,
  buildUnattributedCorrection,
  emptyProjection,
  isoFromEpochMs,
  projectLedger,
  projectedHoldings,
  validateTransactionInput,
} from "../../../packages/ledger/src/index.js";
import { compareHolding, pendingDeltas, reconciliationIsoFromEpochMs, resolveBySignedIdentity, tradeStatusOf, type VenueOrderView, type VenueTradeLeg } from "../../../packages/oms/src/index.js";
import {
  readCollateral,
  readOpenOrders,
  readOrderById,
  readPositions,
  readProjectedHoldings,
  readTrades,
  readWalletMember,
} from "../../../packages/oms/src/reconciliation/door.js";
import { uuid7 } from "../../unit/oms/support/ids.js";

const ACCOUNT = "paper-account-1";
const MARKET = uuid7(0xc, 1);
const YES = "71321045679252212594626385532706912750332728571942532289631379312455583992563";

function correction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ledgerTransactionId: uuid7(0x41, 1),
    reconciliationRunId: uuid7(0x31, 1),
    environment: "PAPER",
    accountRef: ACCOUNT,
    assetId: YES,
    assetKind: "OUTCOME_TOKEN",
    marketId: MARKET,
    delta: "3",
    occurredAt: "2026-10-03T00:00:00.000Z",
    venueClearingAccount: "clearing-venue",
    attributionClearingAccount: "clearing-attribution",
    ...overrides,
  };
}

describe("the ledger's UNATTRIBUTED correction", () => {
  it("books a delta to UNATTRIBUTED; the real ledger accepts it; the projection records an ACTUAL_ARRIVAL that requires a halt", () => {
    const built = buildUnattributedCorrection(correction());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.eventType).toBe("RECONCILIATION_CORRECTION");
    expect(built.value.reconciliationRunId).toBe(uuid7(0x31, 1));
    const appended = Ledger.empty("PAPER").append(built.value);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const projection = projectLedger(appended.value.ledger);
    expect(projection.unattributedActivity).toEqual([
      expect.objectContaining({ activityKind: "ACTUAL_ARRIVAL", haltRequired: true, assetId: YES, amount: "3", affectedMarketId: MARKET }),
    ]);
    const holdings = projectedHoldings(projection, ACCOUNT);
    expect(holdings.lines).toEqual([{ assetId: YES, assetKind: "OUTCOME_TOKEN", balance: "3" }]);
    expect(holdings.unattributedArrivals).toEqual([
      { kind: "ACTUAL_ARRIVAL", ledgerTransactionId: uuid7(0x41, 1), assetId: YES, amount: "3", marketId: MARKET },
    ]);
    // The door the coordinator reads the projection through accepts exactly this shape.
    expect(readProjectedHoldings(holdings).kind).toBe("OK");
  });

  it("books a negative delta with every sign flipped; collateral needs no market", () => {
    const negative = buildUnattributedCorrection(correction({ delta: "-0.25" }));
    expect(negative.ok && negative.value.entries.map((entry) => [entry.scope, entry.amount])).toEqual([
      ["ACTUAL_ACCOUNT", "-0.25"],
      ["EXTERNAL_CLEARING", "0.25"],
      ["UNATTRIBUTED", "-0.25"],
      ["EXTERNAL_CLEARING", "0.25"],
    ]);
    const collateral = buildUnattributedCorrection(correction({ assetId: "asset-pusd", assetKind: "COLLATERAL", marketId: null }));
    expect(collateral.ok).toBe(true);
  });

  it("refuses a zero or inexact delta, a token without its market, and any extra field", () => {
    for (const bad of [
      correction({ delta: "0" }),
      correction({ delta: "1.50" }),
      correction({ delta: 3 }),
      correction({ marketId: null }),
      { ...correction(), extra: 1 },
    ]) {
      expect(buildUnattributedCorrection(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("history written around the ledger's door is still a halt obligation (an unexplained movement)", () => {
    const hidden = validateTransactionInput({
      ledgerTransactionId: uuid7(0x41, 2),
      eventType: "MANUAL_ADJUSTMENT",
      environment: "PAPER",
      accountRef: ACCOUNT,
      source: "internal",
      occurredAt: "2026-10-03T00:00:00Z",
      entries: [
        { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: "asset-pusd", assetKind: "COLLATERAL", amount: "5" },
        { scope: "EXTERNAL_CLEARING", accountRef: "clearing-venue", assetId: "asset-pusd", assetKind: "COLLATERAL", amount: "-5" },
      ],
    });
    if (!hidden.ok) throw new Error("fixture");
    const projection = applyTransaction(emptyProjection(), { sequence: 0, transaction: hidden.value });
    expect(projectedHoldings(projection, ACCOUNT).unattributedArrivals).toEqual([
      { kind: "UNEXPLAINED_MOVEMENT", ledgerTransactionId: uuid7(0x41, 2), assetId: "asset-pusd", amount: "5", marketId: null },
    ]);
  });

  it("the two epoch-to-ISO formatters agree with each other and with the platform", () => {
    for (const ms of [0, 1, 999, 86_399_999, 951_782_400_000, 1_790_000_000_123, 4_102_444_799_999]) {
      expect(isoFromEpochMs(ms)).toBe(new Date(ms).toISOString());
      expect(reconciliationIsoFromEpochMs(ms)).toBe(isoFromEpochMs(ms));
    }
    expect(isoFromEpochMs(-1)).toBeUndefined();
    expect(isoFromEpochMs(1.5)).toBeUndefined();
  });
});

function leg(overrides: Partial<VenueTradeLeg> = {}): VenueTradeLeg {
  return {
    venueOrderId: "venue-1",
    role: "MAKER",
    tokenId: YES,
    side: "BUY",
    shares: "2",
    price: "0.4",
    feeAmount: "0",
    feeAssetId: null,
    matchedAt: "2026-10-03T00:00:00Z",
    ...overrides,
  };
}

describe("the holding comparison", () => {
  it("MATCH; an exact all-in-transit difference is MATCH_IN_TRANSIT; anything else in transit is ambiguous; none in transit is UNEXPLAINED", () => {
    const pending = pendingDeltas([{ leg: leg(), attributed: true }], "asset-pusd");
    expect(pending.get(YES)).toEqual({ delta: "2", exact: true, unattributed: false });
    expect(pending.get("asset-pusd")).toEqual({ delta: "-0.8", exact: true, unattributed: false });
    expect(compareHolding("5", "5", undefined).kind).toBe("MATCH");
    expect(compareHolding("5", "5", pending.get(YES)).kind).toBe("MATCH");
    expect(compareHolding("3", "5", pending.get(YES)).kind).toBe("MATCH_IN_TRANSIT");
    expect(compareHolding("4", "5", pending.get(YES))).toEqual({ kind: "IN_TRANSIT_AMBIGUOUS", delta: "-1" });
    expect(compareHolding("4", "5", undefined)).toEqual({ kind: "UNEXPLAINED", delta: "-1" });
  });

  it("an unknown fee makes both holdings of the leg inexact; a known fee is charged to its own asset", () => {
    const unknown = pendingDeltas([{ leg: leg({ feeAmount: null }), attributed: true }], "asset-pusd");
    expect(unknown.get(YES)?.exact).toBe(false);
    expect(unknown.get("asset-pusd")?.exact).toBe(false);
    expect(compareHolding("3", "5", unknown.get(YES)).kind).toBe("IN_TRANSIT_AMBIGUOUS");
    const fee = pendingDeltas([{ leg: leg({ feeAmount: "0.01", feeAssetId: "asset-pusd" }), attributed: true }], "asset-pusd");
    expect(fee.get("asset-pusd")).toEqual({ delta: "-0.81", exact: true, unattributed: false });
  });

  it("a leg on an untracked order is never booked in the projection: its assets are ambiguous while in transit", () => {
    const pending = pendingDeltas([{ leg: leg(), attributed: false }], "asset-pusd");
    expect(compareHolding("3", "5", pending.get(YES)).kind).toBe("IN_TRANSIT_AMBIGUOUS");
  });
});

const ORDER = { venueOrderId: "venue-1", tokenId: YES, side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0", status: "LIVE" };

describe("the read door", () => {
  it("accepts both trade-status spellings (E-13, C-5) and refuses C-3's MATCHED_NOT_BROADCASTED", () => {
    for (const status of ["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"]) {
      expect(tradeStatusOf(status)).toBe(status);
      expect(tradeStatusOf(`TRADE_STATUS_${status}`)).toBe(status);
    }
    expect(tradeStatusOf("TRADE_STATUS_MATCHED_NOT_BROADCASTED")).toBeNull();
    expect(tradeStatusOf("MATCHED_NOT_BROADCASTED")).toBeNull();
    expect(tradeStatusOf("matched")).toBeNull();
  });

  it("the open-orders read: its route, its completeness, and every malformed shape", () => {
    expect(readOpenOrders({ route: "/data/orders", complete: true, orders: [ORDER] }).kind).toBe("OK");
    expect(readOpenOrders({ route: "/data/orders", complete: false, orders: [ORDER] }).kind).toBe("INCOMPLETE");
    expect(readOpenOrders({ route: "/orders", complete: true, orders: [ORDER] }).kind).toBe("WRONG_ROUTE");
    for (const bad of [
      { ...ORDER, price: "0.50" },
      { ...ORDER, price: 0.5 },
      { ...ORDER, sizeMatched: "2" },
      { ...ORDER, side: "buy" },
      { ...ORDER, venueOrderId: "venue 1" },
    ]) {
      expect(readOpenOrders({ route: "/data/orders", complete: true, orders: [bad] }).kind, JSON.stringify(bad)).toBe("MALFORMED");
    }
    expect(readOpenOrders({ route: "/data/orders", complete: true, orders: [ORDER, ORDER] }).kind).toBe("MALFORMED");
    expect(readOpenOrders({ route: "/data/orders", orders: [] }).kind).toBe("MALFORMED");
    const getter = { ...ORDER };
    Object.defineProperty(getter, "status", { get: () => "LIVE", enumerable: true });
    expect(readOpenOrders({ route: "/data/orders", complete: true, orders: [getter] }).kind).toBe("MALFORMED");
  });

  it("the by-id read must name the order asked for", () => {
    expect(readOrderById({ route: "/data/order", found: true, order: ORDER }, "venue-1").kind).toBe("OK");
    expect(readOrderById({ route: "/data/order", found: true, order: ORDER }, "venue-2").kind).toBe("MALFORMED");
    expect(readOrderById({ route: "/data/order", found: false }, "venue-2")).toEqual({ kind: "OK", value: null });
  });

  it("trades: a fee above zero must name its asset; one own order is named once per trade", () => {
    const trade = (legs: unknown[]): unknown => ({
      route: "/data/trades",
      complete: true,
      trades: [{ venueTradeId: "t1", status: "TRADE_STATUS_CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: legs }],
    });
    expect(readTrades(trade([leg()])).kind).toBe("OK");
    expect(readTrades(trade([leg({ feeAmount: "0.1", feeAssetId: null })])).kind).toBe("MALFORMED");
    expect(readTrades(trade([leg(), leg()])).kind).toBe("MALFORMED");
    expect(readTrades(trade([])).kind).toBe("MALFORMED");
    expect(readTrades(trade([leg({ matchedAt: "1782753360" })])).kind).toBe("MALFORMED");
  });

  it("positions only from /v2 (E-15); collateral only from the chain (U-22); a CONFIRMED member names its hash", () => {
    expect(readPositions({ route: "/v2/positions", complete: true, positions: [{ tokenId: YES, size: "1" }] }).kind).toBe("OK");
    expect(readPositions({ route: "/positions", complete: true, positions: [] }).kind).toBe("WRONG_ROUTE");
    expect(readCollateral({ source: "ONCHAIN_ERC20_BALANCE", assetId: "asset-pusd", balance: "1" }, "asset-pusd").kind).toBe("OK");
    expect(readCollateral({ source: "CLOB_BALANCE_ALLOWANCE", assetId: "asset-pusd", balance: "1" }, "asset-pusd").kind).toBe("WRONG_ROUTE");
    expect(readWalletMember({ state: "CONFIRMED", transactionHash: null, credited: null }).kind).toBe("MALFORMED");
    expect(readWalletMember({ state: "SOMETHING", transactionHash: null, credited: null }).kind).toBe("MALFORMED");
  });
});

function order(id: string, overrides: Partial<VenueOrderView> = {}): VenueOrderView {
  return { venueOrderId: id, tokenId: YES, side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0", status: "LIVE", ...overrides };
}

describe("reconciliation by signed identity", () => {
  const facts = { attemptId: "a1", marketId: MARKET, tokenId: YES, side: "BUY" as const, limitPrice: "0.5", originalShares: "1" };

  it("exactly one unclaimed match, and no rival: PRESENT", () => {
    expect(resolveBySignedIdentity(facts, [order("v1")], [{ attemptId: "a1", facts }])).toMatchObject({ kind: "PRESENT", order: { venueOrderId: "v1" } });
  });

  it("two matches; a rival with the same economics; a rival with unknown facts: AMBIGUOUS", () => {
    expect(resolveBySignedIdentity(facts, [order("v1"), order("v2")], []).kind).toBe("AMBIGUOUS");
    expect(resolveBySignedIdentity(facts, [order("v1")], [{ attemptId: "a2", facts: { ...facts, attemptId: "a2" } }]).kind).toBe("AMBIGUOUS");
    expect(resolveBySignedIdentity(facts, [order("v1")], [{ attemptId: "a2", facts: null }]).kind).toBe("AMBIGUOUS");
  });

  it("a near order (same token and side, other price or size): AMBIGUOUS, never NO_CANDIDATE", () => {
    expect(resolveBySignedIdentity(facts, [order("v1", { price: "0.51" })], []).kind).toBe("AMBIGUOUS");
    expect(resolveBySignedIdentity(facts, [order("v1", { originalSize: "2" })], []).kind).toBe("AMBIGUOUS");
  });

  it("orders on another token or side are not candidates", () => {
    expect(resolveBySignedIdentity(facts, [order("v1", { side: "SELL" }), order("v2", { tokenId: "1" })], []).kind).toBe("NO_CANDIDATE");
  });
});
