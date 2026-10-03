/**
 * WP-280: the projection of normalized events into the OMS's observation,
 * fill and settlement inputs is fail-closed. It states only what the event
 * states unambiguously; everything else is a shortfall (and the stream then
 * requests reconciliation, `manager.test.ts`).
 */

import { describe, expect, it } from "vitest";

import { normalizeUserChannelMessage, type NormalizedOrderEvent, type NormalizedTradeEvent } from "./normalize.js";
import { projectOrderEventForOms, projectTradeEventForOms, UNRECOGNIZED_ORDER_STATUS } from "./oms-projection.js";
import { FIXTURE_MARKET, FIXTURE_OWNER } from "./testing/harness.js";

const ASSET = "107505882767731489358349912513945399560393482969656700824895970500493757150417";
const OTHER_ASSET = "52114319501245915516055106046884209969926127482827954674443846427813813222426";
const TAKER = "0x00000000000000000000000000000000000000000000000000000000feed0004";
const MAKER = "0x00000000000000000000000000000000000000000000000000000000feed0005";
const STRANGER = "11111111-1111-1111-1111-111111111111";

function orderEvent(overrides: Record<string, unknown> = {}): NormalizedOrderEvent {
  const message = normalizeUserChannelMessage({
    event_type: "order",
    type: "UPDATE",
    id: "0xfeed",
    owner: FIXTURE_OWNER,
    market: FIXTURE_MARKET,
    asset_id: ASSET,
    side: "BUY",
    original_size: "100",
    size_matched: "40",
    price: "0.08",
    status: "MATCHED",
    timestamp: "1782753360000",
    ...overrides,
  });
  if (message.kind !== "ORDER") throw new Error(message.kind);
  return message.event;
}

function maker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { order_id: MAKER, owner: STRANGER, matched_amount: "40", price: "0.08", asset_id: ASSET, side: "SELL", ...overrides };
}

function tradeEvent(overrides: Record<string, unknown> = {}): NormalizedTradeEvent {
  const message = normalizeUserChannelMessage(
    {
      event_type: "trade",
      type: "TRADE",
      id: "trade-1",
      taker_order_id: TAKER,
      market: FIXTURE_MARKET,
      asset_id: ASSET,
      side: "BUY",
      size: "40",
      fee_rate_bps: "0",
      price: "0.08",
      status: "MATCHED",
      match_time: "1782753360",
      owner: FIXTURE_OWNER,
      maker_orders: [maker()],
      trader_side: "TAKER",
      timestamp: "1782753361000",
      ...overrides,
    },
    { isAccountOwner: (owner) => owner === FIXTURE_OWNER },
  );
  if (message.kind !== "TRADE") throw new Error(message.kind);
  return message.event;
}

describe("order events → OrderObservation", () => {
  it.each(["LIVE", "MATCHED", "DELAYED", "UNMATCHED", "CANCELED"])("%s is observed as itself", (status) => {
    expect(projectOrderEventForOms(orderEvent({ status }))).toEqual({ observation: { venueOrderId: "0xfeed", status }, shortfalls: [] });
  });

  it("an unrecognized status reaches the OMS as the fixed sentinel, never as the wire lexeme (EXPIRED would be recognised by the OMS)", () => {
    expect(projectOrderEventForOms(orderEvent({ status: "EXPIRED" }))).toEqual({
      observation: { venueOrderId: "0xfeed", status: UNRECOGNIZED_ORDER_STATUS },
      shortfalls: ["ORDER_STATUS_UNRECOGNIZED"],
    });
  });

  it("an absent status observes nothing and is a shortfall; an unrecognized lifecycle is a shortfall beside the observation", () => {
    expect(projectOrderEventForOms(orderEvent({ status: null }))).toEqual({ observation: null, shortfalls: ["ORDER_STATUS_ABSENT"] });
    expect(projectOrderEventForOms(orderEvent({ type: "AMENDMENT", status: "LIVE" }))).toEqual({
      observation: { venueOrderId: "0xfeed", status: "LIVE" },
      shortfalls: ["ORDER_LIFECYCLE_UNRECOGNIZED"],
    });
  });
});

describe("trade events → FillReport and SettlementObservation", () => {
  it("a TAKER trade whose single maker leg fixes the economics: one taker fill, zero fee from a zero rate, and the settlement", () => {
    expect(projectTradeEventForOms(tradeEvent())).toEqual({
      fills: [
        {
          venueTradeId: "trade-1",
          venueOrderId: TAKER,
          shares: "40",
          price: "0.08",
          liquidityRole: "TAKER",
          feeAmount: "0",
          feeAssetId: null,
          matchedAt: "2026-06-29T17:16:00.000Z",
        },
      ],
      settlements: [{ venueTradeId: "trade-1", venueOrderId: TAKER, status: "MATCHED", transactionHash: null, observedAt: "2026-06-29T17:16:01.000Z" }],
      shortfalls: [],
    });
  });

  it("several maker legs at the trade price that sum to the size: one taker fill", () => {
    const projection = projectTradeEventForOms(tradeEvent({ maker_orders: [maker({ matched_amount: "15.5" }), maker({ order_id: "m2", matched_amount: "24.5" })] }));
    expect(projection.fills).toEqual([expect.objectContaining({ venueOrderId: TAKER, shares: "40", price: "0.08" })]);
    expect(projection.shortfalls).toEqual([]);
  });

  it.each([
    ["no maker legs", { maker_orders: null }],
    ["a maker leg at another price (the taker's execution price is not fixed)", { maker_orders: [maker({ price: "0.07" })] }],
    ["a complementary-asset maker leg", { maker_orders: [maker({ asset_id: OTHER_ASSET, side: "BUY", price: "0.92" })] }],
    ["a maker leg on the same side", { maker_orders: [maker({ side: "BUY" })] }],
    ["matched amounts that do not sum to the size", { maker_orders: [maker({ matched_amount: "39.99" })] }],
  ])("%s: no taker fill (TAKER_ECONOMICS_UNVERIFIABLE), the settlement still projects", (_label, overrides) => {
    const projection = projectTradeEventForOms(tradeEvent(overrides));
    expect(projection.fills).toEqual([]);
    expect(projection.settlements).toHaveLength(1);
    expect(projection.shortfalls).toEqual(["TAKER_ECONOMICS_UNVERIFIABLE"]);
  });

  it.each([
    ["a non-zero rate", { fee_rate_bps: "700" }],
    ["an absent rate", { fee_rate_bps: undefined }],
    ["the wire empty rate", { fee_rate_bps: "" }],
  ])("a taker leg with %s has no exact fee amount on the stream: no fill, never a zero-fee fill", (_label, overrides) => {
    const projection = projectTradeEventForOms(tradeEvent(overrides));
    expect(projection.fills).toEqual([]);
    expect(projection.shortfalls).toEqual(["TAKER_FEE_NOT_ON_STREAM"]);
  });

  it("a MAKER trade: only the maker legs the transport affirmed are fills, at their own amount and price, with no fee", () => {
    const projection = projectTradeEventForOms(
      tradeEvent({
        trader_side: "MAKER",
        side: "SELL",
        fee_rate_bps: "700",
        maker_orders: [maker({ order_id: "mine", owner: FIXTURE_OWNER, side: "BUY", matched_amount: "10", price: "0.09" }), maker({ order_id: "theirs", side: "BUY" })],
      }),
    );
    expect(projection.fills).toEqual([
      {
        venueTradeId: "trade-1",
        venueOrderId: "mine",
        shares: "10",
        price: "0.09",
        liquidityRole: "MAKER",
        feeAmount: "0",
        feeAssetId: null,
        matchedAt: "2026-06-29T17:16:00.000Z",
      },
    ]);
    expect(projection.settlements.map((settlement) => settlement.venueOrderId)).toEqual(["mine"]);
    expect(projection.shortfalls).toEqual([]);
  });

  it("a MAKER trade whose ownership cannot be decided projects nothing for the undecided legs", () => {
    const message = normalizeUserChannelMessage({
      event_type: "trade",
      type: "TRADE",
      id: "trade-2",
      taker_order_id: TAKER,
      market: FIXTURE_MARKET,
      asset_id: ASSET,
      side: "SELL",
      size: "10",
      price: "0.09",
      status: "MATCHED",
      match_time: "1782753360",
      owner: FIXTURE_OWNER,
      maker_orders: [maker({ owner: FIXTURE_OWNER })],
      trader_side: "MAKER",
      timestamp: "1782753361000",
    });
    if (message.kind !== "TRADE") throw new Error(message.kind);
    expect(projectTradeEventForOms(message.event)).toEqual({ fills: [], settlements: [], shortfalls: ["MAKER_LEG_OWNERSHIP_UNDETERMINED"] });
  });

  it("a MAKER trade with no own leg, or the same own leg twice, is a shortfall", () => {
    expect(projectTradeEventForOms(tradeEvent({ trader_side: "MAKER" })).shortfalls).toEqual(["NO_OWN_MAKER_LEG"]);
    expect(projectTradeEventForOms(tradeEvent({ trader_side: "MAKER", maker_orders: [] })).shortfalls).toEqual(["NO_OWN_MAKER_LEG"]);
    const twice = projectTradeEventForOms(tradeEvent({ trader_side: "MAKER", maker_orders: [maker({ owner: FIXTURE_OWNER }), maker({ owner: FIXTURE_OWNER })] }));
    expect(twice).toEqual({ fills: [], settlements: [], shortfalls: ["DUPLICATE_OWN_MAKER_LEG"] });
  });

  it("an own maker leg on our own TAKER trade (same-account matching, an undocumented case) is a shortfall, not a fill", () => {
    const projection = projectTradeEventForOms(tradeEvent({ maker_orders: [maker({ owner: FIXTURE_OWNER })] }));
    expect(projection.fills.map((fill) => fill.liquidityRole)).toEqual(["TAKER"]);
    expect(projection.shortfalls).toEqual(["OWN_MAKER_LEG_ON_TAKER_TRADE"]);
  });

  it("an absent or undocumented trader side projects nothing", () => {
    expect(projectTradeEventForOms(tradeEvent({ trader_side: null }))).toEqual({ fills: [], settlements: [], shortfalls: ["TRADER_SIDE_UNKNOWN"] });
    expect(projectTradeEventForOms(tradeEvent({ trader_side: "BOTH" }))).toEqual({ fills: [], settlements: [], shortfalls: ["TRADER_SIDE_UNKNOWN"] });
  });

  it("C-3 and any unrecognized status project no settlement and no fill", () => {
    expect(projectTradeEventForOms(tradeEvent({ status: "MATCHED_NOT_BROADCASTED" }))).toEqual({ fills: [], settlements: [], shortfalls: ["TRADE_STATUS_C3"] });
    expect(projectTradeEventForOms(tradeEvent({ status: "TRADE_STATUS_MATCHED_NOT_BROADCASTED" })).shortfalls).toEqual(["TRADE_STATUS_C3"]);
    expect(projectTradeEventForOms(tradeEvent({ status: "SETTLED" }))).toEqual({ fills: [], settlements: [], shortfalls: ["TRADE_STATUS_UNRECOGNIZED"] });
  });

  it("the MATCHED event owes the fill: without a match time it is a shortfall; a later settlement event without one is not", () => {
    expect(projectTradeEventForOms(tradeEvent({ match_time: undefined })).shortfalls).toEqual(["MATCH_TIME_ABSENT"]);
    for (const status of ["MINED", "CONFIRMED", "RETRYING", "FAILED"]) {
      const projection = projectTradeEventForOms(tradeEvent({ status, match_time: undefined, fee_rate_bps: undefined, transaction_hash: "0xc0ffee" }));
      expect(projection).toEqual({
        fills: [],
        settlements: [{ venueTradeId: "trade-1", venueOrderId: TAKER, status, transactionHash: "0xc0ffee", observedAt: "2026-06-29T17:16:01.000Z" }],
        shortfalls: [],
      });
    }
  });

  it("a later settlement event that carries the complete facts projects the same fill again (the OMS de-duplicates it)", () => {
    const matched = projectTradeEventForOms(tradeEvent());
    const confirmed = projectTradeEventForOms(tradeEvent({ status: "CONFIRMED", transaction_hash: "0xc0ffee" }));
    expect(confirmed.fills).toEqual(matched.fills);
  });

  it("a zero-size taker trade is no fill", () => {
    const projection = projectTradeEventForOms(tradeEvent({ size: "0", maker_orders: [maker({ matched_amount: "0" })] }));
    expect(projection.fills).toEqual([]);
    expect(projection.shortfalls).toEqual(["FILL_SIZE_NOT_POSITIVE"]);
  });
});
