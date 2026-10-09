/**
 * ADR-034 D2.5 and D2.6 item 2, for WP-290's simulated venue (`support/world.ts`): it signs a limit order's
 * amounts as the pinned SDK does (shares floored to 0.01, the quote exact for an on-grid size), and it BOOKS the
 * signed share amount as the order's original size, never the request's. The OMS never asks for an off-grid size
 * (`OMS_SIZE_OFF_GRID`), so this is reached here through the venue port directly. No network, no key.
 */

import { describe, expect, it } from "vitest";

import { ReconWorld } from "./support/world.js";

const TOKEN = "71321045679252212594626385532706912750332728571942532289631379312455583992563";

function world(): ReconWorld {
  return new ReconWorld({ now: () => Date.UTC(2026, 9, 8), collateral: "1000", collateralAssetId: "asset-pusd" });
}

describe("the reconciliation suite's venue signs and books one number (ADR-034 D2.5)", () => {
  it("BUY 5.009 at 0.5 signs takerAmount 5000000 and makerAmount 2500000, and is booked at 5", async () => {
    const w = world();
    const port = w.venuePort(() => true);
    const signed = await port.createLimitOrder({ assetId: TOKEN, side: "BUY", price: "0.5", size: "5.009" });
    if (signed.kind !== "SIGNED") throw new Error("expected a signed order");
    expect(signed.order.identity).toMatchObject({ takerAmount: "5000000", makerAmount: "2500000" });
    await port.postOrder(signed.order);
    expect([...w.orders.values()][0]?.original).toBe("5");
  });

  it("SELL 10.129 at 0.52 signs makerAmount 10120000 and takerAmount 5262400, and is booked at 10.12", async () => {
    const w = world();
    const port = w.venuePort(() => true);
    const signed = await port.createLimitOrder({ assetId: TOKEN, side: "SELL", price: "0.52", size: "10.129" });
    if (signed.kind !== "SIGNED") throw new Error("expected a signed order");
    expect(signed.order.identity).toMatchObject({ makerAmount: "10120000", takerAmount: "5262400" });
    await port.postOrder(signed.order);
    expect([...w.orders.values()][0]?.original).toBe("10.12");
  });

  it("an on-grid size is signed and booked exactly as asked", async () => {
    const w = world();
    const port = w.venuePort(() => true);
    const signed = await port.createLimitOrder({ assetId: TOKEN, side: "BUY", price: "0.37", size: "12.34" });
    if (signed.kind !== "SIGNED") throw new Error("expected a signed order");
    expect(signed.order.identity).toMatchObject({ takerAmount: "12340000", makerAmount: "4565800" });
    await port.postOrder(signed.order);
    expect([...w.orders.values()][0]?.original).toBe("12.34");
  });
});
