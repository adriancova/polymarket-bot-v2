/**
 * WP-300 acceptance 2: a sell plan requires available outcome-token
 * inventory. Also: a BUY holds pUSD (never USDC.e), and partial fills release
 * only the unused part of an order's reservation.
 */

import { describe, expect, it } from "vitest";

import { buildOrderReservation, reserveForOrder } from "../../../packages/inventory/src/index.js";
import { ACCOUNT, NO, PUSD, USDC_E, YES, registry, seededBook } from "./helpers.js";

const sell = (overrides: Record<string, unknown> = {}) => ({
  reservationId: "res-sell-1",
  orderRef: "order-sell-1",
  accountRef: ACCOUNT,
  side: "SELL" as const,
  tokenAssetId: YES,
  price: "0.55",
  size: "10",
  ...overrides,
});

const buy = (overrides: Record<string, unknown> = {}) => ({
  reservationId: "res-buy-1",
  orderRef: "order-buy-1",
  accountRef: ACCOUNT,
  side: "BUY" as const,
  tokenAssetId: YES,
  price: "0.45",
  size: "10",
  ...overrides,
});

describe("sell plans require available outcome-token inventory", () => {
  it("refuses a sell with no tokens at all", () => {
    const book = seededBook({ [PUSD]: "1000" });
    const result = reserveForOrder(book, sell());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
  });

  it("refuses a sell larger than the available tokens, and holds nothing", () => {
    const book = seededBook({ [YES]: "9.99" });
    const result = reserveForOrder(book, sell());
    expect(result.ok).toBe(false);
    expect(book.line(ACCOUNT, YES)?.reserved).toBe("0");
  });

  it("refuses a sell of tokens already reserved by another order", () => {
    const book = seededBook({ [YES]: "10" });
    expect(reserveForOrder(book, sell()).ok).toBe(true);
    const second = reserveForOrder(book, sell({ reservationId: "res-sell-2", orderRef: "order-sell-2", size: "1" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal.code).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
  });

  it("does not count unconfirmed receipts (pendingIn) as sellable", () => {
    const book = seededBook({ [YES]: "0" });
    expect(book.expectInflow({ pendingId: "buy-fill-1", accountRef: ACCOUNT, assetId: YES, amount: "10" }).ok).toBe(true);
    expect(reserveForOrder(book, sell()).ok).toBe(false);
    expect(book.settlePending({ pendingId: "buy-fill-1", settlement: "APPLIED" }).ok).toBe(true);
    expect(reserveForOrder(book, sell()).ok).toBe(true);
  });

  it("does not let YES inventory back a NO sell", () => {
    const book = seededBook({ [YES]: "10" });
    expect(reserveForOrder(book, sell({ tokenAssetId: NO })).ok).toBe(false);
  });

  it("holds exactly `size` tokens for an accepted sell", () => {
    const book = seededBook({ [YES]: "25" });
    const result = reserveForOrder(book, sell());
    expect(result.ok && result.value).toMatchObject({ assetId: YES, amount: "10", holderRef: "order-sell-1" });
    expect(book.available(ACCOUNT, YES)).toBe("15");
  });
});

describe("buy plans hold pUSD", () => {
  it("holds price × size (+ declared headroom) of pUSD, exactly", () => {
    const book = seededBook({ [PUSD]: "100" });
    const result = reserveForOrder(book, buy({ price: "0.333", size: "3", additionalCollateral: "0.001" }));
    expect(result.ok && result.value).toMatchObject({ assetId: PUSD, amount: "1" });
  });

  it("never uses USDC.e as trading collateral", () => {
    const built = buildOrderReservation(registry(), buy());
    expect(built.ok && built.value.assetId).toBe(PUSD);
    const book = seededBook({ [USDC_E]: "1000" });
    expect(reserveForOrder(book, buy()).ok).toBe(false);
  });

  it("refuses an order on a collateral asset, an unknown token, a bad price or a bad side", () => {
    const reg = registry();
    expect(buildOrderReservation(reg, buy({ tokenAssetId: PUSD })).ok).toBe(false);
    expect(buildOrderReservation(reg, buy({ tokenAssetId: "unknown" })).ok).toBe(false);
    for (const price of ["0", "1.01", "-0.1", "0.50"]) {
      expect(buildOrderReservation(reg, buy({ price })).ok, price).toBe(false);
    }
    expect(buildOrderReservation(reg, buy({ side: "SHORT" })).ok).toBe(false);
    expect(buildOrderReservation(reg, sell({ additionalCollateral: "1" })).ok).toBe(false);
  });
});

describe("partial fills release only the unused reservation (WP-270 acceptance, supported here)", () => {
  it("a BUY for 10 @ 0.45 filled 4 releases 2.7 pUSD and keeps 1.8 in flight", () => {
    const book = seededBook({ [PUSD]: "100" });
    const reserved = reserveForOrder(book, buy());
    expect(reserved.ok).toBe(true);
    expect(book.consume({ reservationId: "res-buy-1", amount: "1.8", pendingId: "trade-1" }).ok).toBe(true);
    const released = book.release({ reservationId: "res-buy-1" });
    expect(released.ok && released.value).toMatchObject({ consumed: "1.8", released: "2.7" });
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "0", pendingOut: "1.8", available: "98.2" });
  });
});
