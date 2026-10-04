/**
 * WP-290 r4: the pure pieces the round-4 fixes rest on, one rule at a time.
 *
 * - The door keeps the ids an unusable answer's rows carry (WP290-CX-R4-01): an INCOMPLETE or MALFORMED
 *   open-orders or trades answer still names every venue order id its rows (or legs) carry, with the token when
 *   the row validated in full; a WRONG_ROUTE answer names none.
 * - The ledger's remaining booking of a fill (`remainingFillBookings`) and the door's read of it
 *   (`readRemainingBookings`) (WP290-CX-R4-02): linked reversals net to zero, a reversed reversal books again, a
 *   fee is part of the fill's booking; one answer per fill asked, exact non-zero amounts only.
 * - A FAILED fill explains exactly its remaining booking (`pendingDeltas`).
 * - Subject provenance (`subjects.ts`): which subjects name a venue order a read SHOWED, and which only NAMED it.
 */

import { describe, expect, it } from "vitest";

import { negateDecimal } from "../../../packages/decimal/src/index.js";
import { Ledger, remainingFillBookings } from "../../../packages/ledger/src/index.js";
import { compositeKey } from "../../../packages/oms/src/guards.js";
import { compareHolding, pendingDeltas } from "../../../packages/oms/src/index.js";
import { readOpenOrders, readRemainingBookings, readTrades } from "../../../packages/oms/src/reconciliation/door.js";
import { namesOrderOnly, venueSubjectOf } from "../../../packages/oms/src/reconciliation/subjects.js";
import { uuid7 } from "../../unit/oms/support/ids.js";

const ACCOUNT = "paper-account-1";
const MARKET = uuid7(0xc, 1);
const INSTANCE = uuid7(0xa, 1);
const YES = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const PUSD = "asset-pusd";

const ORDER = { venueOrderId: "venue-1", tokenId: YES, side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0", status: "LIVE" };

function leg(venueOrderId: string): Record<string, unknown> {
  return { venueOrderId, role: "MAKER", tokenId: YES, side: "BUY", shares: "2", price: "0.4", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" };
}

function trade(venueTradeId: string, legs: unknown[], status = "TRADE_STATUS_MINED"): Record<string, unknown> {
  return { venueTradeId, status, transactionHash: null, ownershipUndetermined: false, ownLegs: legs };
}

function namedOf(outcome: ReturnType<typeof readOpenOrders> | ReturnType<typeof readTrades>): [string, string | null][] {
  return outcome.kind === "INCOMPLETE" || outcome.kind === "MALFORMED" ? [...(outcome.named ?? new Map<string, string | null>())] : [];
}

describe("the door keeps the ids an unusable answer carries (r4, WP290-CX-R4-01)", () => {
  it("open orders: a partial answer, a malformed row beside valid ones, a row listed twice, an unusable 'complete': every id kept; a wrong route keeps none", () => {
    const other = { ...ORDER, venueOrderId: "venue-2" };
    const partial = readOpenOrders({ route: "/data/orders", complete: false, orders: [ORDER, other] });
    expect(partial.kind).toBe("INCOMPLETE");
    expect(namedOf(partial)).toEqual([
      ["venue-1", YES],
      ["venue-2", YES],
    ]);
    const sibling = readOpenOrders({ route: "/data/orders", complete: true, orders: [ORDER, { venueOrderId: "broken-sibling" }, { ...other, price: 0.5 }] });
    expect(sibling.kind).toBe("MALFORMED");
    // A row that does not validate keeps its id (when that field is a venue id), with no token.
    expect(namedOf(sibling)).toEqual([
      ["venue-1", YES],
      ["broken-sibling", null],
      ["venue-2", null],
    ]);
    const twice = readOpenOrders({ route: "/data/orders", complete: true, orders: [ORDER, other, ORDER] });
    expect(twice.kind).toBe("MALFORMED");
    expect(namedOf(twice).map(([id]) => id)).toEqual(["venue-1", "venue-2"]);
    const unsaid = readOpenOrders({ route: "/data/orders", complete: "yes", orders: [ORDER] });
    expect(unsaid.kind).toBe("MALFORMED");
    expect(namedOf(unsaid)).toEqual([["venue-1", YES]]);
    // Nothing usable carries nothing: a wrong route, a list that is not a list, a row id that is not a venue id.
    expect(readOpenOrders({ route: "/orders", complete: false, orders: [ORDER] })).toEqual({ kind: "WRONG_ROUTE", route: "/orders" });
    expect(namedOf(readOpenOrders({ route: "/data/orders", complete: false, orders: "venue-1" }))).toEqual([]);
    expect(namedOf(readOpenOrders({ route: "/data/orders", complete: true, orders: [{ venueOrderId: "venue 1" }] }))).toEqual([]);
    // A complete, valid answer is OK, as before.
    expect(readOpenOrders({ route: "/data/orders", complete: true, orders: [ORDER, other] }).kind).toBe("OK");
  });

  it("trades: every own leg's venue order of a partial or malformed answer is kept, a malformed trade's valid legs included", () => {
    const partial = readTrades({ route: "/data/trades", complete: false, trades: [trade("t1", [leg("venue-1")])] });
    expect(partial.kind).toBe("INCOMPLETE");
    expect(namedOf(partial)).toEqual([["venue-1", YES]]);
    const malformed = readTrades({ route: "/data/trades", complete: true, trades: [trade("t1", [leg("venue-1")]), trade("t2", [leg("venue-2"), { ...leg("venue-3"), price: 0.4 }])] });
    expect(malformed.kind).toBe("MALFORMED");
    expect(namedOf(malformed)).toEqual([
      ["venue-1", YES],
      ["venue-2", YES],
      ["venue-3", null],
    ]);
    const twice = readTrades({ route: "/data/trades", complete: true, trades: [trade("t1", [leg("venue-1")]), trade("t1", [leg("venue-1")])] });
    expect(twice.kind).toBe("MALFORMED");
    expect(namedOf(twice)).toEqual([["venue-1", YES]]);
    expect(readTrades({ route: "/data/trade", complete: false, trades: [trade("t1", [leg("venue-1")])] }).kind).toBe("WRONG_ROUTE");
  });
});

describe("a FAILED fill's remaining booking (r4, WP290-CX-R4-02)", () => {
  const FILL = uuid7(0xf1, 1);
  const OTHER_FILL = uuid7(0xf1, 2);
  let next = 0;
  const id = (): string => uuid7(0x7e, (next += 1));

  function principal(fillId: string, shares: string, notional: string): Record<string, unknown> {
    const entry = (scope: string, account: string, assetId: string, kind: string, amount: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      scope,
      accountRef: account,
      assetId,
      assetKind: kind,
      amount,
      ...extra,
    });
    return {
      ledgerTransactionId: id(),
      eventType: "TRADE_PRINCIPAL",
      environment: "PAPER",
      accountRef: ACCOUNT,
      source: "polymarket",
      occurredAt: "2026-10-03T00:00:00Z",
      marketId: MARKET,
      fillId,
      entries: [
        entry("ACTUAL_ACCOUNT", ACCOUNT, YES, "OUTCOME_TOKEN", shares, { marketId: MARKET }),
        entry("VIRTUAL_STRATEGY", ACCOUNT, YES, "OUTCOME_TOKEN", shares, { marketId: MARKET, instanceId: INSTANCE }),
        entry("EXTERNAL_CLEARING", "clearing-venue", YES, "OUTCOME_TOKEN", negateDecimal(shares)),
        entry("EXTERNAL_CLEARING", "clearing-attribution", YES, "OUTCOME_TOKEN", negateDecimal(shares)),
        entry("ACTUAL_ACCOUNT", ACCOUNT, PUSD, "COLLATERAL", negateDecimal(notional)),
        entry("VIRTUAL_STRATEGY", ACCOUNT, PUSD, "COLLATERAL", negateDecimal(notional), { instanceId: INSTANCE }),
        entry("EXTERNAL_CLEARING", "clearing-venue", PUSD, "COLLATERAL", notional),
        entry("EXTERNAL_CLEARING", "clearing-attribution", PUSD, "COLLATERAL", notional),
      ],
    };
  }

  function reversal(target: Record<string, unknown>, withFill: boolean): Record<string, unknown> {
    const { fillId, ...rest } = target;
    return {
      ...rest,
      ...(withFill ? { fillId } : {}),
      ledgerTransactionId: id(),
      eventType: "MANUAL_ADJUSTMENT",
      source: "internal",
      reversesLedgerTransactionId: target["ledgerTransactionId"],
      entries: (target["entries"] as Record<string, unknown>[]).map((entry) => ({ ...entry, amount: negateDecimal(entry["amount"] as string) })),
    };
  }

  function append(ledger: Ledger, transaction: Record<string, unknown>): Ledger {
    const result = ledger.append(transaction);
    if (!result.ok) throw new Error(JSON.stringify(result.refusals));
    return result.value.ledger;
  }

  it("a booked fill remains in full; a linked reversal (with or without the fill's id) nets it to nothing; a reversed reversal books it again; other fills are their own", () => {
    const booked = principal(FILL, "0.4", "0.2");
    let ledger = append(Ledger.empty("PAPER"), booked);
    ledger = append(ledger, principal(OTHER_FILL, "1", "0.5"));
    expect(remainingFillBookings(ledger.transactions(), ACCOUNT, [FILL, OTHER_FILL])).toEqual(
      new Map([
        [FILL, [{ assetId: YES, amount: "0.4" }, { assetId: PUSD, amount: "-0.2" }].sort((a, b) => (a.assetId < b.assetId ? -1 : 1))],
        [OTHER_FILL, [{ assetId: YES, amount: "1" }, { assetId: PUSD, amount: "-0.5" }].sort((a, b) => (a.assetId < b.assetId ? -1 : 1))],
      ]),
    );
    for (const withFill of [true, false]) {
      const back = reversal(booked, withFill);
      const reversed = append(ledger, back);
      expect(remainingFillBookings(reversed.transactions(), ACCOUNT, [FILL]).get(FILL), String(withFill)).toEqual([]);
      expect(remainingFillBookings(reversed.transactions(), ACCOUNT, [OTHER_FILL]).get(OTHER_FILL)?.length).toBe(2);
      const again = append(reversed, reversal(back, false));
      expect(remainingFillBookings(again.transactions(), ACCOUNT, [FILL]).get(FILL)?.length, String(withFill)).toBe(2);
    }
    // Another account's entries, and a fill never booked, remain nothing; a fill asked twice answers once per ask.
    expect(remainingFillBookings(ledger.transactions(), "someone-else", [FILL]).get(FILL)).toEqual([]);
    expect(remainingFillBookings(ledger.transactions(), ACCOUNT, [uuid7(0xf1, 9)]).get(uuid7(0xf1, 9))).toEqual([]);
  });

  it("the door: exactly one answer per fill asked, exact non-zero amounts, no asset twice", () => {
    const asked = [{ venueTradeId: "t1", venueOrderId: "venue-1" }];
    const key = compositeKey("t1", "venue-1");
    const good = readRemainingBookings({ bookings: [{ venueTradeId: "t1", venueOrderId: "venue-1", entries: [{ assetId: PUSD, amount: "-0.2" }] }] }, asked);
    expect(good).toEqual({ kind: "OK", value: new Map([[key, [{ assetId: PUSD, amount: "-0.2" }]]]) });
    expect(readRemainingBookings({ bookings: [{ venueTradeId: "t1", venueOrderId: "venue-1", entries: [] }] }, asked)).toEqual({ kind: "OK", value: new Map([[key, []]]) });
    for (const bad of [
      { bookings: [] },
      { bookings: [{ venueTradeId: "t2", venueOrderId: "venue-1", entries: [] }] },
      { bookings: [{ venueTradeId: "t1", venueOrderId: "venue-1", entries: [] }, { venueTradeId: "t1", venueOrderId: "venue-1", entries: [] }] },
      { bookings: [{ venueTradeId: "t1", venueOrderId: "venue-1", entries: [{ assetId: PUSD, amount: "0" }] }] },
      { bookings: [{ venueTradeId: "t1", venueOrderId: "venue-1", entries: [{ assetId: PUSD, amount: "-0.20" }] }] },
      { bookings: [{ venueTradeId: "t1", venueOrderId: "venue-1", entries: [{ assetId: PUSD, amount: -0.2 }] }] },
      { bookings: [{ venueTradeId: "t1", venueOrderId: "venue-1", entries: [{ assetId: PUSD, amount: "-0.1" }, { assetId: PUSD, amount: "-0.1" }] }] },
      { bookings: "none" },
      null,
    ]) {
      expect(readRemainingBookings(bad, asked).kind, JSON.stringify(bad)).toBe("MALFORMED");
    }
  });

  it("pendingDeltas: a FAILED fill's remaining booking is an exact difference; nothing remaining explains nothing", () => {
    const remaining = pendingDeltas([], PUSD, [
      { assetId: YES, amount: "0.4" },
      { assetId: PUSD, amount: "-0.21" },
    ]);
    expect(remaining.get(YES)).toEqual({ delta: "0.4", exact: true, unattributed: false });
    expect(remaining.get(PUSD)).toEqual({ delta: "-0.21", exact: true, unattributed: false });
    // The chain shows the fill gone (A = P - booked): explained exactly; any other difference is not.
    expect(compareHolding("1000", "999.79", remaining.get(PUSD)).kind).toBe("MATCH_IN_TRANSIT");
    expect(compareHolding("1000.1", "999.79", remaining.get(PUSD)).kind).toBe("IN_TRANSIT_AMBIGUOUS");
    const none = pendingDeltas([], PUSD, []);
    expect(none.get(PUSD)).toBeUndefined();
    expect(compareHolding("1000.2", "1000", none.get(PUSD))).toEqual({ kind: "UNEXPLAINED", delta: "0.2" });
  });
});

describe("subject provenance (r4): a venue order a read SHOWED, or one only NAMED", () => {
  it("names the new subjects' venue objects, and tells shown from named", () => {
    expect(venueSubjectOf("ORDER_UNRESOLVED", compositeKey("ORDER_UNRESOLVED", "venue-order-named", "venue-1"))).toEqual({ kind: "order", id: "venue-1" });
    expect(venueSubjectOf("ORDER_NOT_FOUND_BY_ID", compositeKey("ORDER_NOT_FOUND_BY_ID", "venue-1"))).toEqual({ kind: "order", id: "venue-1" });
    expect(venueSubjectOf("SETTLEMENT_REVERSAL_OWED", compositeKey("SETTLEMENT_REVERSAL_OWED", "trade-1", "venue-1"))).toEqual({ kind: "trade", id: "trade-1" });
    expect(venueSubjectOf("ORDER_NOT_FOUND_BY_ID", compositeKey("ORDER_NOT_FOUND_BY_ID", ""))).toBeNull();
    expect(venueSubjectOf("SETTLEMENT_REVERSAL_OWED", compositeKey("SETTLEMENT_REVERSAL_OWED", "trade-1"))).toBeNull();
    // Only named: a by-id read's problem, a NAMED record, a not-found quarantine.
    expect(namesOrderOnly("ORDER_UNRESOLVED", compositeKey("ORDER_UNRESOLVED", "venue-order-named", "venue-1"))).toBe(true);
    expect(namesOrderOnly("ORDER_NOT_FOUND_BY_ID", compositeKey("ORDER_NOT_FOUND_BY_ID", "venue-1"))).toBe(true);
    for (const breakClass of ["READ_MISSING", "READ_MALFORMED", "READ_WRONG_ROUTE"] as const) {
      expect(namesOrderOnly(breakClass, compositeKey(breakClass, compositeKey("order", "venue-1"))), breakClass).toBe(true);
    }
    // Shown: a conflict, a regression or an unrecognised status keyed by the order; a SHOWN record.
    expect(namesOrderOnly("ORDER_UNRESOLVED", compositeKey("ORDER_UNRESOLVED", "venue-order", "venue-1"))).toBe(false);
    for (const breakClass of ["READ_CONFLICT", "READ_REGRESSION", "STATUS_UNRECOGNISED"] as const) {
      expect(namesOrderOnly(breakClass, compositeKey(breakClass, "order", "venue-1")), breakClass).toBe(false);
    }
    // No venue order at all.
    expect(namesOrderOnly("READ_MISSING", compositeKey("READ_MISSING", "trades"))).toBe(false);
    expect(namesOrderOnly("SETTLEMENT_REVERSAL_OWED", compositeKey("SETTLEMENT_REVERSAL_OWED", "trade-1", "venue-1"))).toBe(false);
  });
});
