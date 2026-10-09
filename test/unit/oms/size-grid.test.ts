/**
 * ADR-034 D2.4 (`CO3-N1`): the OMS's guards are CHECKS, never second quantizers.
 *
 * - THE TICKET DOOR refuses an off-grid share quantity with `OMS_SIZE_OFF_GRID`, before the PLANNED row and
 *   before `reserve`: nothing is recorded, reserved, signed or sent. It applies to `submit`, `submitBatch` and a
 *   staged replacement alike.
 * - `identityMismatch` compares the SIGNED AMOUNTS with the order's quantities, exactly, in base units (the GTC
 *   and GTD rows of D2.4's table); one base unit off in either amount is `OMS_SIGNED_ORDER_MISMATCH`, and the
 *   attempt is never persisted or transmitted. FAK and FOK stay refused (their rows arrive with ADR-034 R3).
 *
 * Mocked ports only: the fake venue, the memory store, the mock cipher, a recording reservation port.
 */

import { describe, expect, it } from "vitest";

import { SHARE_SIZE_DECIMALS, VENUE_FACTS, type LimitOrderRequest, type SignOutcome } from "../../../packages/oms/src/index.js";

import { FakeSignedOrder, MAKER, SIGNER, limitOrderAmounts, signatureFor } from "./support/fake-venue.js";
import { RecordingReservations, group, openHarness, ticket } from "./support/harness.js";

/** A signed order for `request` carrying `amounts` (default: the SDK's), and `orderType` (default: GTC/GTD by expiration). */
function signedWith(
  request: LimitOrderRequest,
  salt: string,
  patch: { readonly makerAmount?: string; readonly takerAmount?: string; readonly orderType?: string } = {},
): SignOutcome {
  const amounts = limitOrderAmounts(request.side, request.price, request.size);
  return Object.freeze({
    kind: "SIGNED" as const,
    order: new FakeSignedOrder({
      builder: `0x${"0".repeat(64)}`,
      expiration: request.expirationUnixSeconds ?? 0,
      maker: MAKER,
      makerAmount: patch.makerAmount ?? amounts.makerAmount,
      metadata: `0x${"0".repeat(64)}`,
      orderType: patch.orderType ?? (request.expirationUnixSeconds === undefined ? "GTC" : "GTD"),
      postOnly: request.postOnly === true,
      salt,
      side: request.side,
      signature: signatureFor(salt),
      signatureType: 3,
      signer: SIGNER,
      takerAmount: patch.takerAmount ?? amounts.takerAmount,
      timestamp: "1790000000000",
      tokenId: request.assetId,
    }),
  });
}

const plusOne = (amount: string): string => (BigInt(amount) + 1n).toString();
const minusOne = (amount: string): string => (BigInt(amount) - 1n).toString();

describe("the ticket door: OMS_SIZE_OFF_GRID, before the PLANNED row and before reserve (ADR-034 D2.4)", () => {
  it("the share grid is the cited venue fact's 2 decimals", () => {
    expect(SHARE_SIZE_DECIMALS).toBe(2);
    expect(VENUE_FACTS.SHARE_GRID.source).toBe("docs/venue/verified-2026-10-06.md");
  });

  it.each(["5.009", "0.001", "10.123", "1.000001", "49.995", "0.019"])("submit(%s): refused; no store write, no reservation, no signature, no transmission", async (shares) => {
    const reservations = new RecordingReservations();
    const h = await openHarness({ reservations });
    const g = group(1);
    expect((await h.manager.registerGroup(g)).ok).toBe(true);
    const writes = h.store.log.length;
    const result = await h.manager.submit(ticket(g, { n: 1, shares }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "OMS_SIZE_OFF_GRID", details: { shares } } });
    expect(h.store.log.length).toBe(writes);
    expect(reservations.calls).toEqual([]);
    expect(h.venue.signed).toEqual([]);
    expect(h.venue.received).toEqual([]);
    expect(h.manager.orders()).toEqual([]);
    // The order id was never consumed: the same ticket, on the grid, is admitted.
    const admitted = await h.manager.submit(ticket(g, { n: 1, shares: "5" }));
    expect(admitted.ok && admitted.value.orderState).toBe("LIVE");
  });

  it.each(["5", "5.1", "5.12", "0.01", "10"])("submit(%s): on the grid, admitted, and signed for exactly that quantity", async (shares) => {
    const h = await openHarness();
    const g = group(2);
    await h.manager.registerGroup(g);
    const result = await h.manager.submit(ticket(g, { n: 2, shares }));
    expect(result.ok && result.value.orderState).toBe("LIVE");
    expect(h.manager.orders()[0]?.originalShares).toBe(shares);
  });

  it("submitBatch: one off-grid ticket refuses the whole batch before anything is recorded or reserved", async () => {
    const reservations = new RecordingReservations();
    const h = await openHarness({ reservations });
    const a = group(3);
    const b = group(4);
    await h.manager.registerGroup(a);
    await h.manager.registerGroup(b);
    const writes = h.store.log.length;
    const result = await h.manager.submitBatch([ticket(a, { n: 3, shares: "5" }), ticket(b, { n: 4, shares: "5.005" })]);
    expect(result).toMatchObject({ ok: false, refusal: { code: "OMS_SIZE_OFF_GRID" } });
    expect(h.store.log.length).toBe(writes);
    expect(reservations.calls).toEqual([]);
    expect(h.venue.signed).toEqual([]);
  });

  it("requestReplace: an off-grid replacement is refused before it is staged, so the live order is NOT canceled for it", async () => {
    const h = await openHarness();
    const g = group(5);
    await h.manager.registerGroup(g);
    const t = ticket(g, { n: 5, shares: "6" });
    expect((await h.manager.submit(t)).ok).toBe(true);
    const result = await h.manager.requestReplace(t.orderId, ticket(g, { n: 6, shares: "3.999" }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "OMS_SIZE_OFF_GRID" } });
    expect(h.venue.cancels).toEqual([]);
    expect(h.manager.order(t.orderId)?.state).toBe("LIVE");
    expect(h.manager.saltGate(g.executionGroupId)?.open).toBe(false);
  });
});

describe("identityMismatch compares the signed amounts, exactly (ADR-034 D2.4's GTC and GTD rows)", () => {
  // Shares 5, price 0.5: BUY maker 2500000 (quote), taker 5000000 (shares); SELL the reverse.
  for (const side of ["BUY", "SELL"] as const) {
    for (const gtd of [false, true] as const) {
      const row = `${gtd ? "GTD" : "GTC"} ${side}`;

      it(`${row}: the exact amounts are SIGNED and sent`, async () => {
        const h = await openHarness();
        const g = group(10, { side });
        await h.manager.registerGroup(g);
        h.venue.sign = (request, salt) => signedWith(request, salt);
        const t = ticket(g, { n: 10, shares: "5", limitPrice: "0.5", ...(gtd ? { expirationUnixSeconds: 1_900_000_000 } : {}) });
        const result = await h.manager.submit(t);
        expect(result.ok && result.value.orderState).toBe("LIVE");
        expect(h.venue.received).toHaveLength(1);
        expect(h.manager.order(t.orderId)?.originalShares).toBe("5");
      });

      for (const [label, patch] of [
        ["makerAmount + 1", (a: { makerAmount: string; takerAmount: string }) => ({ makerAmount: plusOne(a.makerAmount) })],
        ["makerAmount − 1", (a: { makerAmount: string; takerAmount: string }) => ({ makerAmount: minusOne(a.makerAmount) })],
        ["takerAmount + 1", (a: { makerAmount: string; takerAmount: string }) => ({ takerAmount: plusOne(a.takerAmount) })],
        ["takerAmount − 1", (a: { makerAmount: string; takerAmount: string }) => ({ takerAmount: minusOne(a.takerAmount) })],
        ["the amounts swapped", (a: { makerAmount: string; takerAmount: string }) => ({ makerAmount: a.takerAmount, takerAmount: a.makerAmount })],
      ] as const) {
        it(`${row}: ${label} is OMS_SIGNED_ORDER_MISMATCH; nothing persisted or sent; the reservation released`, async () => {
          const h = await openHarness();
          const g = group(11, { side });
          await h.manager.registerGroup(g);
          h.venue.sign = (request, salt) => signedWith(request, salt, patch(limitOrderAmounts(request.side, request.price, request.size)));
          const t = ticket(g, { n: 11, shares: "5", limitPrice: "0.5", ...(gtd ? { expirationUnixSeconds: 1_900_000_000 } : {}) });
          const result = await h.manager.submit(t);
          expect(result).toMatchObject({ ok: false, refusal: { code: "OMS_SIGNED_ORDER_MISMATCH" } });
          expect(h.manager.attempts()).toEqual([]);
          expect(h.store.snapshotSync().attempts.size).toBe(0);
          expect(h.venue.received).toEqual([]);
          expect(h.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0", reservation: { released: true } });
        });
      }
    }
  }

  it.each(["FAK", "FOK"])("a signed %s order is still refused (its row arrives with ADR-034 R3)", async (orderType) => {
    const h = await openHarness();
    const g = group(12);
    await h.manager.registerGroup(g);
    h.venue.sign = (request, salt) => signedWith(request, salt, { orderType });
    const result = await h.manager.submit(ticket(g, { n: 12, shares: "5" }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "OMS_SIGNED_ORDER_MISMATCH" } });
    expect(h.venue.received).toEqual([]);
  });

  it("a price whose quote is not a whole number of base units can match no signed order: refused, never rounded", async () => {
    const h = await openHarness();
    const g = group(13, { limitPrice: "0.1234567" });
    await h.manager.registerGroup(g);
    // Whatever the signer signs (here: the quote floored to base units), the OMS refuses it.
    const result = await h.manager.submit(ticket(g, { n: 13, shares: "1", limitPrice: "0.1234567" }));
    expect(result).toMatchObject({ ok: false, refusal: { code: "OMS_SIGNED_ORDER_MISMATCH" } });
    expect(h.venue.received).toEqual([]);
  });

  it("an amount that is not a canonical base-unit integer is refused at the sign door, and nothing is sent", async () => {
    for (const takerAmount of ["5000000.0", "05000000", "5e6", "", "-5000000"]) {
      const h = await openHarness();
      const g = group(14);
      await h.manager.registerGroup(g);
      h.venue.sign = (request, salt) => signedWith(request, salt, { takerAmount });
      const result = await h.manager.submit(ticket(g, { n: 14, shares: "5" }));
      expect(result, takerAmount).toMatchObject({ ok: false, refusal: { code: "OMS_SIGN_FAILED" } });
      expect(h.venue.received, takerAmount).toEqual([]);
    }
  });
});
