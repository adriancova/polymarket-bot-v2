/**
 * WP-280: normalization of raw user-channel messages. Identifiers are carried
 * exactly; decimals are exact and canonical; anything outside the verified
 * vocabulary or the documented structure is surfaced as UNRECOGNIZED, never
 * coerced; no owner (a CLOB API key) is ever carried.
 *
 * (The fixture-driven contract test is `test/contract/user-stream/`.)
 */

import { describe, expect, it } from "vitest";

import { normalizeUserChannelFrame, normalizeUserChannelMessage, type NormalizedTradeEvent, type UserChannelMessage } from "./normalize.js";
import { FIXTURE_MARKET, FIXTURE_OWNER } from "./testing/harness.js";

const ORDER_ID = "0x00000000000000000000000000000000000000000000000000000000feed0001";
const ASSET = "107505882767731489358349912513945399560393482969656700824895970500493757150417";

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type: "order",
    type: "UPDATE",
    id: ORDER_ID,
    owner: FIXTURE_OWNER,
    market: FIXTURE_MARKET,
    asset_id: ASSET,
    side: "BUY",
    original_size: "100",
    size_matched: "40",
    price: "0.08",
    outcome: "Yes",
    status: "MATCHED",
    timestamp: "1782753360000",
    ...overrides,
  };
}

function trade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type: "trade",
    type: "TRADE",
    id: "00000000-0000-0000-0000-00000000t001",
    taker_order_id: "0x00000000000000000000000000000000000000000000000000000000feed0004",
    market: FIXTURE_MARKET,
    asset_id: ASSET,
    side: "BUY",
    size: "40",
    fee_rate_bps: "0",
    price: "0.08",
    status: "MATCHED",
    match_time: "1782753360",
    owner: FIXTURE_OWNER,
    trade_owner: FIXTURE_OWNER,
    maker_orders: [
      {
        order_id: "0x00000000000000000000000000000000000000000000000000000000feed0005",
        owner: FIXTURE_OWNER,
        matched_amount: "40",
        price: "0.08",
        asset_id: ASSET,
        side: "SELL",
      },
    ],
    trader_side: "TAKER",
    timestamp: "1782753360000",
    ...overrides,
  };
}

function tradeEvent(message: UserChannelMessage): NormalizedTradeEvent {
  if (message.kind !== "TRADE") throw new Error(`expected TRADE, got ${message.kind}`);
  return message.event;
}

describe("order events", () => {
  it("carries every identifier exactly and every amount as an exact canonical decimal", () => {
    const message = normalizeUserChannelMessage(order({ original_size: "0100.00", size_matched: "40.50", price: "0.080" }));
    expect(message).toEqual({
      kind: "ORDER",
      event: {
        venueOrderId: ORDER_ID,
        market: FIXTURE_MARKET,
        assetId: ASSET,
        side: "BUY",
        lifecycle: { kind: "KNOWN", value: "UPDATE" },
        status: { kind: "KNOWN", value: "MATCHED" },
        originalSize: "100",
        sizeMatched: "40.5",
        price: "0.08",
        orderType: { kind: "ABSENT" },
        associateTrades: null,
        createdAt: null,
        expiresAt: null,
        venueTimestamp: { wire: "1782753360000", iso: "2026-06-29T17:16:00.000Z" },
      },
    });
  });

  it.each(["LIVE", "MATCHED", "DELAYED", "UNMATCHED", "CANCELED"])("recognises the documented status %s", (status) => {
    expect(normalizeUserChannelMessage(order({ status }))).toMatchObject({ kind: "ORDER", event: { status: { kind: "KNOWN", value: status } } });
  });

  it.each(["PLACEMENT", "UPDATE", "CANCELLATION"])("recognises the documented lifecycle type %s", (type) => {
    expect(normalizeUserChannelMessage(order({ type }))).toMatchObject({ event: { lifecycle: { kind: "KNOWN", value: type } } });
  });

  it("an undocumented status (even one the OMS knows, EXPIRED) is UNRECOGNIZED, keeping only an upper-case token lexeme", () => {
    expect(normalizeUserChannelMessage(order({ status: "EXPIRED" }))).toMatchObject({
      event: { status: { kind: "UNRECOGNIZED", lexeme: "EXPIRED", reason: "NOT_IN_VERIFIED_VOCABULARY" } },
    });
    expect(normalizeUserChannelMessage(order({ status: "live" }))).toMatchObject({ event: { status: { kind: "UNRECOGNIZED", lexeme: null } } });
    expect(normalizeUserChannelMessage(order({ status: FIXTURE_OWNER }))).toMatchObject({ event: { status: { kind: "UNRECOGNIZED", lexeme: null } } });
  });

  it("an absent or null status is ABSENT (the SDK types it nullish); an undocumented type is UNRECOGNIZED", () => {
    const { status: _omitted, ...withoutStatus } = order();
    void _omitted;
    expect(normalizeUserChannelMessage(withoutStatus)).toMatchObject({ event: { status: { kind: "ABSENT" } } });
    expect(normalizeUserChannelMessage(order({ status: null }))).toMatchObject({ event: { status: { kind: "ABSENT" } } });
    expect(normalizeUserChannelMessage(order({ type: "AMENDMENT" }))).toMatchObject({ event: { lifecycle: { kind: "UNRECOGNIZED", lexeme: "AMENDMENT" } } });
    expect(normalizeUserChannelMessage(order({ order_type: "GTX" }))).toMatchObject({ event: { orderType: { kind: "UNRECOGNIZED", lexeme: "GTX" } } });
    expect(normalizeUserChannelMessage(order({ order_type: "FAK" }))).toMatchObject({ event: { orderType: { kind: "KNOWN", value: "FAK" } } });
  });

  it("reads the optional fields: associate_trades exactly, created_at, and expiration with the SDK's '0' = none", () => {
    const message = normalizeUserChannelMessage(order({ associate_trades: ["t-1", "t-2"], created_at: "1782753357", expiration: "0" }));
    expect(message).toMatchObject({
      event: { associateTrades: ["t-1", "t-2"], createdAt: { wire: "1782753357", iso: "2026-06-29T17:15:57.000Z" }, expiresAt: null },
    });
    expect(normalizeUserChannelMessage(order({ expiration: "1782753957" }))).toMatchObject({ event: { expiresAt: { wire: "1782753957" } } });
  });

  it.each([
    ["a missing id", { id: undefined }, "id"],
    ["an id with a space", { id: "0x12 34" }, "id"],
    ["a malformed condition id", { market: "0x1234" }, "market"],
    ["a float size", { original_size: 100 }, "original_size"],
    ["scientific notation", { size_matched: "4e1" }, "size_matched"],
    ["a signed amount", { size_matched: "-1" }, "size_matched"],
    ["whitespace", { size_matched: " 40" }, "size_matched"],
    ["a price above 1", { price: "1.2" }, "price"],
    ["an unknown side", { side: "HOLD" }, "side"],
    ["a missing type", { type: undefined }, "type"],
    ["a non-string status", { status: 7 }, "status"],
    ["a non-digit timestamp", { timestamp: "2026-06-29" }, "timestamp"],
    ["a missing owner", { owner: undefined }, "owner"],
    ["a malformed associated trade id", { associate_trades: ["ok", "not ok"] }, "associate_trades"],
  ])("refuses %s as MALFORMED_ORDER_EVENT naming the field", (_label, overrides, field) => {
    const raw = order(overrides);
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete raw[key];
    expect(normalizeUserChannelMessage(raw)).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_ORDER_EVENT", field });
  });

  it("accepts a 31-byte condition id (the SDK's runtime grammar, not the fixtures' 32-byte narrowing)", () => {
    const short = `0x${"a".repeat(62)}`;
    expect(normalizeUserChannelMessage(order({ market: short }))).toMatchObject({ kind: "ORDER", event: { market: short } });
  });

  it("upper-cases the side as the SDK does", () => {
    expect(normalizeUserChannelMessage(order({ side: "sell" }))).toMatchObject({ event: { side: "SELL" } });
  });
});

describe("trade events", () => {
  it.each(["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"])("recognises %s in both spellings (ADR-002)", (status) => {
    expect(tradeEvent(normalizeUserChannelMessage(trade({ status }))).status).toEqual({ kind: "KNOWN", value: status });
    expect(tradeEvent(normalizeUserChannelMessage(trade({ status: `TRADE_STATUS_${status}` }))).status).toEqual({ kind: "KNOWN", value: status });
  });

  it("C-3: MATCHED_NOT_BROADCASTED, in either spelling, is UNRECOGNIZED with its own reason, never MATCHED", () => {
    for (const status of ["MATCHED_NOT_BROADCASTED", "TRADE_STATUS_MATCHED_NOT_BROADCASTED"]) {
      expect(tradeEvent(normalizeUserChannelMessage(trade({ status }))).status).toEqual({
        kind: "UNRECOGNIZED",
        lexeme: status,
        reason: "C3_REST_ONLY_STATUS_ON_STREAM",
      });
    }
  });

  it("any other status is UNRECOGNIZED: a new value, a lower-case spelling, a bare prefix", () => {
    expect(tradeEvent(normalizeUserChannelMessage(trade({ status: "SETTLED" }))).status).toEqual({
      kind: "UNRECOGNIZED",
      lexeme: "SETTLED",
      reason: "NOT_IN_VERIFIED_VOCABULARY",
    });
    expect(tradeEvent(normalizeUserChannelMessage(trade({ status: "mined" }))).status).toMatchObject({ kind: "UNRECOGNIZED", lexeme: null });
    expect(tradeEvent(normalizeUserChannelMessage(trade({ status: "TRADE_STATUS_" }))).status).toMatchObject({ kind: "UNRECOGNIZED" });
  });

  it("carries the trade's identifiers exactly and its maker legs with an ownership verdict, never an owner", () => {
    const message = normalizeUserChannelMessage(trade({ transaction_hash: "0xC0FFEE" }), { isAccountOwner: (owner) => owner === FIXTURE_OWNER });
    const event = tradeEvent(message);
    expect(event).toMatchObject({
      venueTradeId: "00000000-0000-0000-0000-00000000t001",
      takerOrderId: "0x00000000000000000000000000000000000000000000000000000000feed0004",
      transactionHash: "0xC0FFEE",
      feeRateBps: "0",
      matchedAt: { wire: "1782753360", iso: "2026-06-29T17:16:00.000Z" },
      traderSide: { kind: "KNOWN", value: "TAKER" },
      makerOrders: [
        {
          venueOrderId: "0x00000000000000000000000000000000000000000000000000000000feed0005",
          matchedAmount: "40",
          price: "0.08",
          side: "SELL",
          feeRateBps: null,
          account: "OWN",
        },
      ],
    });
    expect(JSON.stringify(message)).not.toContain(FIXTURE_OWNER);
  });

  it("maker-leg ownership: OTHER on false; UNDETERMINED without a predicate, on a throw, or on a non-boolean answer", () => {
    const leg = (options: Parameters<typeof normalizeUserChannelMessage>[1]) => tradeEvent(normalizeUserChannelMessage(trade(), options)).makerOrders?.[0]?.account;
    expect(leg({ isAccountOwner: () => false })).toBe("OTHER");
    expect(leg({})).toBe("UNDETERMINED");
    expect(
      leg({
        isAccountOwner: () => {
          throw new Error("down");
        },
      }),
    ).toBe("UNDETERMINED");
    expect(leg({ isAccountOwner: () => "yes" as unknown as boolean })).toBe("UNDETERMINED");
  });

  it("the wire empty fee rate means absent; `matchtime` is the SDK's alias; two different match times are a contradiction", () => {
    expect(tradeEvent(normalizeUserChannelMessage(trade({ fee_rate_bps: "" }))).feeRateBps).toBeNull();
    const { match_time: _drop, ...noMatchTime } = trade();
    void _drop;
    expect(tradeEvent(normalizeUserChannelMessage({ ...noMatchTime, matchtime: "1782753361" })).matchedAt?.wire).toBe("1782753361");
    expect(tradeEvent(normalizeUserChannelMessage(trade({ matchtime: "1782753360" }))).matchedAt?.wire).toBe("1782753360");
    expect(normalizeUserChannelMessage(trade({ matchtime: "1782753361" }))).toEqual({
      kind: "UNRECOGNIZED",
      reason: "MALFORMED_TRADE_EVENT",
      field: "matchtime",
    });
  });

  it.each([
    ["a type other than TRADE", { type: "trade" }, "type"],
    ["a missing taker order id", { taker_order_id: null }, "taker_order_id"],
    ["a non-string status", { status: null }, "status"],
    ["maker_orders that is not an array", { maker_orders: {} }, "maker_orders"],
    ["a maker leg without an owner", { maker_orders: [{ order_id: "a", matched_amount: "1", price: "0.5", asset_id: ASSET, side: "SELL" }] }, "owner"],
    ["a malformed transaction hash", { transaction_hash: "0x c0" }, "transaction_hash"],
    ["a fee rate in a float", { fee_rate_bps: 0 }, "fee_rate_bps"],
  ])("refuses %s as MALFORMED_TRADE_EVENT", (_label, overrides, field) => {
    expect(normalizeUserChannelMessage(trade(overrides))).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_TRADE_EVENT", field });
  });

  it("an undocumented trader side is UNRECOGNIZED; an absent one is ABSENT", () => {
    expect(tradeEvent(normalizeUserChannelMessage(trade({ trader_side: "BOTH" }))).traderSide).toMatchObject({ kind: "UNRECOGNIZED", lexeme: "BOTH" });
    expect(tradeEvent(normalizeUserChannelMessage(trade({ trader_side: null }))).traderSide).toEqual({ kind: "ABSENT" });
  });
});

describe("frames and hostile input", () => {
  it("PONG is the heartbeat reply; nothing else is", () => {
    expect(normalizeUserChannelFrame("PONG")).toEqual([{ kind: "PONG" }]);
    expect(normalizeUserChannelFrame("pong")).toEqual([{ kind: "UNRECOGNIZED", reason: "NOT_JSON", field: null }]);
  });

  it.each([
    ["a non-string frame", 42, "NOT_TEXT"],
    ["invalid JSON", "{", "NOT_JSON"],
    ["a JSON scalar", "7", "NOT_AN_OBJECT"],
    ["an empty batch", "[]", "EMPTY_BATCH"],
    ["an unknown event type", '{"event_type":"book"}', "UNKNOWN_EVENT_TYPE"],
    ["no event type", "{}", "UNKNOWN_EVENT_TYPE"],
    ["an oversized frame", `"${"x".repeat(1_048_577)}"`, "TOO_LARGE"],
    ["an oversized batch", `[${Array.from({ length: 1_001 }, () => "{}").join(",")}]`, "BATCH_TOO_LARGE"],
  ])("%s is UNRECOGNIZED (%s)", (_label, frame, reason) => {
    expect(normalizeUserChannelFrame(frame)).toEqual([{ kind: "UNRECOGNIZED", reason, field: null }]);
  });

  it("a batch normalizes each message on its own", () => {
    const messages = normalizeUserChannelFrame(JSON.stringify([order(), { event_type: "book" }, trade()]));
    expect(messages.map((message) => message.kind)).toEqual(["ORDER", "UNRECOGNIZED", "TRADE"]);
  });

  it("never invokes a getter, and never throws on a hostile object", () => {
    let invoked = 0;
    const withGetter = order();
    Object.defineProperty(withGetter, "price", {
      enumerable: true,
      get: () => {
        invoked += 1;
        return "0.08";
      },
    });
    expect(normalizeUserChannelMessage(withGetter)).toEqual({ kind: "UNRECOGNIZED", reason: "MALFORMED_ORDER_EVENT", field: "price" });
    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("trap");
        },
        getPrototypeOf: () => Object.prototype,
      },
    );
    expect(normalizeUserChannelMessage(throwing)).toEqual({ kind: "UNRECOGNIZED", reason: "UNREADABLE", field: null });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(normalizeUserChannelMessage(proxy)).toEqual({ kind: "UNRECOGNIZED", reason: "UNREADABLE", field: null });
    expect(normalizeUserChannelMessage(Object.create({ event_type: "order" }))).toEqual({ kind: "UNRECOGNIZED", reason: "NOT_AN_OBJECT", field: null });
    expect(invoked).toBe(0);
  });

  it("outputs are frozen", () => {
    const message = normalizeUserChannelMessage(trade());
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(tradeEvent(message).makerOrders)).toBe(true);
    expect(Object.isFrozen(tradeEvent(message).makerOrders?.[0])).toBe(true);
  });
});
