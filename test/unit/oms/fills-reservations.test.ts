/**
 * WP-270 acceptance 3: "Partial fills release only unused reservations", with
 * exact decimal conservation, through WP-300's REAL `ReservationService`
 * (`packages/inventory`, layer-1 logic, in memory). Also: many-to-many
 * attribution (fill allocations sum to the fill, §10.7), fill validation, and
 * the trade-settlement state machine (§9.11; §6 invariant 5).
 */

import { addDecimal, mulDecimal, subDecimal } from "../../../packages/decimal/src/index.js";
import { describe, expect, it } from "vitest";

import { accepted, venueIdFor } from "./support/fake-venue.js";
import { uuid7 } from "./support/ids.js";
import { ACCOUNT, INSTANCE_A, INSTANCE_B, PUSD, YES, group, openHarness, ticket, type Harness } from "./support/harness.js";

async function live(h: Harness, n: number, opts: { side?: "BUY" | "SELL"; shares?: string; price?: string; amount?: string } = {}) {
  h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
  const shares = opts.shares ?? "10";
  const g = group(n, { side: opts.side ?? "BUY", plannedShares: shares });
  await h.manager.registerGroup(g);
  const base = ticket(g, { n, shares, limitPrice: opts.price ?? "0.5" });
  const t = opts.amount === undefined ? base : { ...base, reservation: { ...base.reservation, amount: opts.amount } };
  const result = await h.manager.submit(t);
  if (!result.ok) throw new Error(`submit failed: ${result.refusal.code}`);
  return { g, t, attemptId: result.value.submissionAttemptId, venueOrderId: venueIdFor(h.venue.signed.at(-1) as string) };
}

async function finalRead(h: Harness, attemptId: string, venueOrderId: string, sizeMatched: string, originalSize = "10") {
  const read = h.reconciler.latestFor(attemptId);
  const answer = await h.manager.applyReconciliation({
    requestId: read?.requestId,
    submissionAttemptId: attemptId,
    verdict: "PRESENT",
    order: { venueOrderId, status: "CANCELED", sizeMatched, originalSize },
  });
  if (!answer.ok) throw new Error(`final read refused: ${answer.refusal.code}`);
}

function fill(venueOrderId: string, id: string, shares: string, price: string, extra: Record<string, unknown> = {}) {
  return { venueTradeId: id, venueOrderId, shares, price, liquidityRole: "TAKER", matchedAt: "2026-10-03T00:00:00Z", ...extra };
}

describe("acceptance 3: partial fills release only the unused reservation, exactly", () => {
  it("BUY 10 @ 0.5 reserves 5; fills of 4 @ 0.48 and 2 @ 0.5 consume 2.92; cancel; the final read releases exactly 2.08", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { t, attemptId, venueOrderId } = await live(h, 1);
    const book = h.inventory?.book;
    expect(book?.line(ACCOUNT, PUSD)).toMatchObject({ reserved: "5", available: "95" });
    expect((await h.manager.recordFill(fill(venueOrderId, "t1", "4", "0.48"))).ok).toBe(true);
    expect(book?.line(ACCOUNT, PUSD)).toMatchObject({ reserved: "3.08", pendingOut: "1.92", available: "95" });
    expect((await h.manager.recordFill(fill(venueOrderId, "t2", "2", "0.5"))).ok).toBe(true);
    expect(book?.line(ACCOUNT, PUSD)).toMatchObject({ reserved: "2.08", pendingOut: "2.92", available: "95" });
    const canceled = await h.manager.requestCancel(t.orderId);
    expect(canceled.ok && canceled.value.state).toBe("CANCELED");
    // Not released on the cancel answer: a fill may still be reported.
    expect(book?.line(ACCOUNT, PUSD)?.reserved).toBe("2.08");
    await finalRead(h, attemptId, venueOrderId, "6");
    const line = book?.line(ACCOUNT, PUSD);
    expect(line).toMatchObject({ reserved: "0", pendingOut: "2.92", available: "97.08" });
    const view = h.manager.order(t.orderId);
    expect(view?.reservation).toMatchObject({ amount: "5", consumed: "2.92", released: true });
    // Conservation: consumed + released = reserved, exactly.
    const reservation = book?.reservation(t.reservation.reservationId);
    expect(reservation).toMatchObject({ amount: "5", consumed: "2.92", released: "2.08", remaining: "0", status: "RELEASED" });
    expect(book?.checkInvariants()).toEqual([]);
  });

  it("SELL: the token reservation is consumed share for share and only the unfilled shares are released", async () => {
    const h = await openHarness({ balances: { yes: "50" } });
    const { attemptId, venueOrderId, t } = await live(h, 2, { side: "SELL", shares: "10", price: "0.6" });
    const book = h.inventory?.book;
    expect(book?.line(ACCOUNT, YES)).toMatchObject({ reserved: "10", available: "40" });
    await h.manager.recordFill(fill(venueOrderId, "s1", "3.25", "0.61"));
    await h.manager.requestCancel(t.orderId);
    await finalRead(h, attemptId, venueOrderId, "3.25");
    expect(book?.reservation(t.reservation.reservationId)).toMatchObject({ consumed: "3.25", released: "6.75", status: "RELEASED" });
    expect(book?.line(ACCOUNT, YES)).toMatchObject({ reserved: "0", pendingOut: "3.25", available: "46.75" });
  });

  it("a fee charged in the collateral asset is consumed with the notional", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { venueOrderId, t } = await live(h, 3, { amount: "5.1" });
    await h.manager.recordFill(fill(venueOrderId, "f1", "10", "0.5", { feeAmount: "0.0175", feeAssetId: PUSD }));
    expect(h.manager.order(t.orderId)).toMatchObject({ state: "FILLED", finalSize: "10" });
    const reservation = h.inventory?.book.reservation(t.reservation.reservationId);
    expect(reservation).toMatchObject({ consumed: "5.0175", released: "0.0825", status: "RELEASED" });
  });

  it("does not release while the recorded fills fall short of the final size; releases once the missing fill arrives", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { t, attemptId, venueOrderId } = await live(h, 4);
    await h.manager.recordFill(fill(venueOrderId, "a", "1", "0.5"));
    await h.manager.requestCancel(t.orderId);
    await finalRead(h, attemptId, venueOrderId, "3");
    expect(h.manager.order(t.orderId)?.reservation.released).toBe(false);
    expect(h.inventory?.book.line(ACCOUNT, PUSD)?.reserved).toBe("4.5");
    await h.manager.recordFill(fill(venueOrderId, "b", "2", "0.4"));
    expect(h.manager.order(t.orderId)?.reservation.released).toBe(true);
    expect(h.inventory?.book.reservation(t.reservation.reservationId)).toMatchObject({ consumed: "1.3", released: "3.7" });
  });

  it("refuses a fill beyond the confirmed final size, beyond the order, or on the wrong side of the limit, with a halt alert", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { t, attemptId, venueOrderId } = await live(h, 5);
    const overLimit = await h.manager.recordFill(fill(venueOrderId, "x1", "1", "0.51"));
    expect(!overLimit.ok && overLimit.refusal.code).toBe("OMS_FILL_INCONSISTENT");
    const tooMany = await h.manager.recordFill(fill(venueOrderId, "x2", "10.01", "0.5"));
    expect(!tooMany.ok && tooMany.refusal.code).toBe("OMS_FILL_INCONSISTENT");
    await h.manager.recordFill(fill(venueOrderId, "x3", "2", "0.5"));
    await h.manager.requestCancel(t.orderId);
    await finalRead(h, attemptId, venueOrderId, "2");
    const late = await h.manager.recordFill(fill(venueOrderId, "x4", "1", "0.5"));
    expect(!late.ok && late.refusal.code).toBe("OMS_FILL_INCONSISTENT");
    expect(h.manager.alerts().filter((alert) => alert.kind === "FILL_INCONSISTENT" && alert.haltMarket)).toHaveLength(3);
    expect(h.manager.order(t.orderId)?.filledShares).toBe("2");
  });

  it("deduplicates a repeated fill, and refuses the same fill with different facts", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { t, venueOrderId } = await live(h, 6);
    expect((await h.manager.recordFill(fill(venueOrderId, "d1", "2", "0.5"))).ok).toBe(true);
    expect((await h.manager.recordFill(fill(venueOrderId, "d1", "2", "0.5"))).ok).toBe(true);
    expect(h.manager.order(t.orderId)?.filledShares).toBe("2");
    const conflict = await h.manager.recordFill(fill(venueOrderId, "d1", "3", "0.5"));
    expect(!conflict.ok && conflict.refusal.code).toBe("OMS_FILL_CONFLICT");
    expect(h.inventory?.book.line(ACCOUNT, PUSD)?.pendingOut).toBe("1");
  });

  it("refuses a fill for a venue order the manager does not hold (unattributed activity: a halt alert, WP-290 attributes it)", async () => {
    const h = await openHarness();
    const result = await h.manager.recordFill(fill("venue-unknown", "u1", "1", "0.5"));
    expect(!result.ok && result.refusal.code).toBe("OMS_UNKNOWN_VENUE_ORDER");
    expect(h.manager.alerts()[0]).toMatchObject({ kind: "UNKNOWN_VENUE_ORDER", haltMarket: true });
  });

  it("a property: for random partial fills, consumed + released = reserved exactly, and released = reserved - Σ debits", async () => {
    let seed = 0x5eed;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    // Exact fixtures: share sizes in hundredths, prices from a fixed list; no float ever becomes an amount.
    const centi = (n: number): string => (n % 100 === 0 ? String(n / 100) : `${String(Math.floor(n / 100))}.${String(n % 100).padStart(2, "0")}`.replace(/0$/u, ""));
    const PRICES = ["0.01", "0.13", "0.37", "0.5", "0.62", "0.99"];
    for (let run = 0; run < 40; run += 1) {
      const h = await openHarness({ balances: { pusd: "1000" } });
      const totalCenti = 100 * (1 + (next() % 50));
      const shares = centi(totalCenti);
      const priceIndex = next() % PRICES.length;
      const price = PRICES[priceIndex] as string;
      const { t, attemptId, venueOrderId } = await live(h, 1000 + run, { shares, price });
      let filledCenti = 0;
      let debits = "0";
      const count = next() % 5;
      for (let index = 0; index < count && filledCenti < totalCenti; index += 1) {
        const size = 1 + (next() % (totalCenti - filledCenti));
        // A fill at or better than the limit (a BUY fills at or below it).
        const fillPrice = PRICES[next() % (priceIndex + 1)] as string;
        const recorded = await h.manager.recordFill(fill(venueOrderId, `p${String(index)}`, centi(size), fillPrice));
        if (!recorded.ok) throw new Error(`fill refused: ${recorded.refusal.code}`);
        filledCenti += size;
        debits = addDecimal(debits, mulDecimal(centi(size), fillPrice));
      }
      if (filledCenti < totalCenti) {
        await h.manager.requestCancel(t.orderId);
        await finalRead(h, attemptId, venueOrderId, centi(filledCenti), shares);
      }
      const reservation = h.inventory?.book.reservation(t.reservation.reservationId);
      expect(reservation?.consumed).toBe(debits);
      expect(addDecimal(reservation?.consumed ?? "0", reservation?.released ?? "0")).toBe(reservation?.amount);
      expect(reservation?.released).toBe(subDecimal(reservation?.amount ?? "0", debits));
      expect(reservation?.remaining).toBe("0");
      expect(h.inventory?.book.checkInvariants()).toEqual([]);
    }
  });
});

describe("many-to-many attribution", () => {
  it("allocates each fill across the order's intents sequentially, exactly, aggregated per instance; allocations sum to the fill", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const g = group(50, { plannedShares: "10" });
    await h.manager.registerGroup(g);
    const t = {
      ...ticket(g, { n: 50 }),
      attributions: [
        { intentId: uuid7(0x3, 1), instanceId: INSTANCE_A, shares: "3" },
        { intentId: uuid7(0x3, 2), instanceId: INSTANCE_B, shares: "5" },
        { intentId: uuid7(0x3, 3), instanceId: INSTANCE_A, shares: "2" },
      ],
    };
    const submitted = await h.manager.submit(t);
    expect(submitted.ok).toBe(true);
    const links = h.store.snapshotSync().links.filter((link) => link.orderId === t.orderId);
    expect(links.map((link) => link.attributedShares)).toEqual(["3", "5", "2"]);
    const venueOrderId = venueIdFor(h.venue.signed[0] as string);
    await h.manager.recordFill(fill(venueOrderId, "m1", "2", "0.5"));
    await h.manager.recordFill(fill(venueOrderId, "m2", "4.5", "0.5"));
    await h.manager.recordFill(fill(venueOrderId, "m3", "3.5", "0.5"));
    const allocations = h.store.snapshotSync().allocations;
    const byFill = (fillIndex: number) => {
      const fillId = h.store.snapshotSync().fills[fillIndex]?.fillId;
      return Object.fromEntries(allocations.filter((a) => a.fillId === fillId).map((a) => [a.instanceId, a.allocatedShares]));
    };
    expect(byFill(0)).toEqual({ [INSTANCE_A]: "2" });
    expect(byFill(1)).toEqual({ [INSTANCE_A]: "1", [INSTANCE_B]: "3.5" });
    expect(byFill(2)).toEqual({ [INSTANCE_B]: "1.5", [INSTANCE_A]: "2" });
  });

  it("refuses attributions that do not sum to the order, or name one intent twice", async () => {
    const h = await openHarness();
    const g = group(51);
    await h.manager.registerGroup(g);
    const short = { ...ticket(g, { n: 51 }), attributions: [{ intentId: uuid7(0x3, 9), instanceId: INSTANCE_A, shares: "9.99" }] };
    expect(!((await h.manager.submit(short)).ok)).toBe(true);
    const twice = {
      ...ticket(g, { n: 52 }),
      attributions: [
        { intentId: uuid7(0x3, 10), instanceId: INSTANCE_A, shares: "5" },
        { intentId: uuid7(0x3, 10), instanceId: INSTANCE_B, shares: "5" },
      ],
    };
    expect(!((await h.manager.submit(twice)).ok)).toBe(true);
    expect(h.venue.signed).toHaveLength(0);
  });
});

describe("the trade settlement state machine (separate from order state)", () => {
  async function filled(h: Harness) {
    const { venueOrderId } = await live(h, 60);
    await h.manager.recordFill(fill(venueOrderId, "st1", "10", "0.5"));
    return venueOrderId;
  }
  const at = (status: string, venueOrderId: string) => ({ venueTradeId: "st1", venueOrderId, status, observedAt: "2026-10-03T00:00:01Z" });

  it("MATCHED → MINED → CONFIRMED; duplicates are idempotent; regressions are refused as stale", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const id = await filled(h);
    for (const status of ["MATCHED", "MATCHED", "MINED", "CONFIRMED"]) {
      expect((await h.manager.applySettlement(at(status, id))).ok).toBe(true);
    }
    const stale = await h.manager.applySettlement(at("MINED", id));
    expect(!stale.ok && stale.refusal.code).toBe("OMS_SETTLEMENT_REGRESSION");
    expect(h.store.snapshotSync().settlements.map((s) => s.state)).toEqual(["MATCHED", "MINED", "CONFIRMED"]);
    // The order's state is untouched by settlement.
    expect(h.manager.orders()[0]?.state).toBe("FILLED");
  });

  it("a trade first seen as MINED is accepted (stream messages can be missed); RETRYING → CONFIRMED", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const id = await filled(h);
    for (const status of ["MINED", "RETRYING", "CONFIRMED"]) expect((await h.manager.applySettlement(at(status, id))).ok).toBe(true);
  });

  it("FAILED raises a halt alert; CONFIRMED against FAILED is a conflict; an unknown status is refused", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const id = await filled(h);
    expect((await h.manager.applySettlement(at("FAILED", id))).ok).toBe(true);
    expect(h.manager.alerts().some((alert) => alert.kind === "SETTLEMENT_FAILED" && alert.haltMarket)).toBe(true);
    const conflict = await h.manager.applySettlement(at("CONFIRMED", id));
    expect(!conflict.ok && conflict.refusal.code).toBe("OMS_SETTLEMENT_CONFLICT");
    const unknown = await h.manager.applySettlement(at("MATCHED_NOT_BROADCASTED", id));
    expect(!unknown.ok && unknown.refusal.code).toBe("OMS_SETTLEMENT_UNRECOGNISED");
    const noFill = await h.manager.applySettlement({ ...at("MATCHED", id), venueTradeId: "nope" });
    expect(!noFill.ok && noFill.refusal.code).toBe("OMS_UNKNOWN_FILL");
  });
});
