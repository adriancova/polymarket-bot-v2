/**
 * WP-270 acceptance 3: "Partial fills release only unused reservations", with
 * exact decimal conservation, through WP-300's REAL `ReservationService`
 * (`packages/inventory`, layer-1 logic, in memory). Also: many-to-many
 * attribution (fill allocations sum to the fill, §10.7), fill validation, and
 * the trade-settlement state machine (§9.11; §6 invariant 5).
 *
 * r2: a redelivered fill must agree on its liquidity role and its match time
 * as an instant (WP270-R2-02); a repeated settlement state carrying a new
 * transaction hash is kept in the log (WP270-R2-03).
 *
 * r3: a hash already recorded for the current settlement state is a duplicate
 * whichever row recorded it (OP-R3-01); the half-unit rounding boundary and the
 * whole-unit truncation boundary of the match-time comparison are pinned
 * (OP-R3-02).
 */

import { addDecimal, mulDecimal, subDecimal } from "../../../packages/decimal/src/index.js";
import { describe, expect, it } from "vitest";

import { accepted, venueIdFor } from "./support/fake-venue.js";
import { uuid7 } from "./support/ids.js";
import { OrderManager } from "../../../packages/oms/src/index.js";

import { ACCOUNT, INSTANCE_A, INSTANCE_B, PUSD, YES, group, openHarness, reopen, ticket, type Harness } from "./support/harness.js";

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

  it("a redelivered fill must agree on its liquidity role and its match time as an instant; same instant at another offset or precision is the same fill (r2, WP270-R2-02)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { t, venueOrderId } = await live(h, 7);
    const at = (matchedAt: string, extra: Record<string, unknown> = {}) => fill(venueOrderId, "d2", "2", "0.5", { matchedAt, ...extra });
    expect((await h.manager.recordFill(at("2026-10-03T00:00:00.123456789Z"))).ok).toBe(true);
    const pending = h.inventory?.book.line(ACCOUNT, PUSD)?.pendingOut;
    const writes = h.store.calls;
    const conflicts = () => h.manager.alerts().filter((alert) => alert.kind === "EVIDENCE_CONFLICT" && alert.haltMarket && alert.orderId === t.orderId).length;
    // The same instant: another UTC offset; truncated or rounded to a coarser precision (a store keeping microseconds; a
    // report in seconds).
    for (const same of [
      "2026-10-03T00:00:00.123456789Z",
      "2026-10-03T02:00:00.123456789+02:00",
      "2026-10-02T19:30:00.123456789-04:30",
      "2026-10-03T00:00:00.123456Z",
      "2026-10-03T00:00:00.123457Z",
      "2026-10-03T00:00:00.12Z",
      "2026-10-03T00:00:00Z",
      "2026-10-03T00:00:00.1Z",
    ]) {
      const result = await h.manager.recordFill(at(same));
      expect(result.ok, same).toBe(true);
    }
    expect(h.store.calls).toBe(writes);
    expect(conflicts()).toBe(0);
    // Not the same fill: another liquidity role, or a time the texts disagree on at a precision both carry.
    for (const [label, other] of [
      ["MAKER, not TAKER", at("2026-10-03T00:00:00.123456789Z", { liquidityRole: "MAKER" })],
      ["one second later", at("2026-10-03T00:00:01Z")],
      ["0.124 (neither truncation nor rounding of .123456789)", at("2026-10-03T00:00:00.124Z")],
      ["one nanosecond later", at("2026-10-03T00:00:00.123456790Z")],
      ["the same wall time in another offset", at("2026-10-03T00:00:00.123456789+01:00")],
      ["another day", at("2026-10-04T00:00:00.123456789Z")],
    ] as const) {
      const result = await h.manager.recordFill(other);
      expect(!result.ok && result.refusal.code, label).toBe("OMS_FILL_CONFLICT");
    }
    expect(conflicts()).toBe(6);
    expect(h.manager.order(t.orderId)?.filledShares).toBe("2");
    expect(h.inventory?.book.line(ACCOUNT, PUSD)?.pendingOut).toBe(pending);
    expect(h.store.snapshotSync().fills.map((f) => [f.liquidityRole, f.matchedAt])).toEqual([["TAKER", "2026-10-03T00:00:00.123456789Z"]]);
    // After a restart the recovered record is compared the same way.
    const r = await reopen(h);
    expect((await r.manager.recordFill(at("2026-10-03T01:00:00.123+01:00"))).ok).toBe(true);
    const role = await r.manager.recordFill(at("2026-10-03T00:00:00.123456789Z", { liquidityRole: "MAKER" }));
    expect(!role.ok && role.refusal.code).toBe("OMS_FILL_CONFLICT");
  });

  it("the half-unit rounding boundary: a coarser text is the finer instant rounded half up, never a half unit beyond (r3, OP-R3-02)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { venueOrderId } = await live(h, 10);
    const at = (id: string, matchedAt: string) => fill(venueOrderId, id, "1", "0.5", { matchedAt });
    // 00.5 rounded half up to whole seconds is 01: the same instant (the excess is exactly minus half a unit).
    expect((await h.manager.recordFill(at("h1", "2026-10-03T00:00:00.5Z"))).ok).toBe(true);
    expect((await h.manager.recordFill(at("h1", "2026-10-03T00:00:01Z"))).ok).toBe(true);
    // The same boundary at a finer precision: 00.15 rounded half up to tenths is 00.2.
    expect((await h.manager.recordFill(at("h2", "2026-10-03T00:00:00.15Z"))).ok).toBe(true);
    expect((await h.manager.recordFill(at("h2", "2026-10-03T00:00:00.2Z"))).ok).toBe(true);
    // Just below the half unit, the coarser text is neither the truncation nor the rounding: another instant.
    expect((await h.manager.recordFill(at("h3", "2026-10-03T00:00:00.499999999Z"))).ok).toBe(true);
    const below = await h.manager.recordFill(at("h3", "2026-10-03T00:00:01Z"));
    expect(!below.ok && below.refusal.code).toBe("OMS_FILL_CONFLICT");
    // Truncation stays accepted right up to a whole unit, and not at it.
    expect((await h.manager.recordFill(at("h4", "2026-10-03T00:00:01.999999999Z"))).ok).toBe(true);
    expect((await h.manager.recordFill(at("h4", "2026-10-03T00:00:01Z"))).ok).toBe(true);
    expect((await h.manager.recordFill(at("h5", "2026-10-03T00:00:01.0Z"))).ok).toBe(true);
    const whole = await h.manager.recordFill(at("h5", "2026-10-03T00:00:00Z"));
    expect(!whole.ok && whole.refusal.code).toBe("OMS_FILL_CONFLICT");
    expect(h.manager.alerts().filter((alert) => alert.kind === "EVIDENCE_CONFLICT")).toHaveLength(2);
  });

  it("refuses a timestamp naming no instant (month 13, February 30 outside a leap year, hour 24, second 60) on a fill and on a settlement (r2)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { venueOrderId } = await live(h, 8);
    for (const bad of ["2026-13-03T00:00:00Z", "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-03T24:00:00Z", "2026-10-03T00:60:00Z", "2026-10-03T00:00:60Z", "2026-10-03T00:00:00+24:00", "2026-10-00T00:00:00Z"]) {
      const result = await h.manager.recordFill(fill(venueOrderId, "ts", "1", "0.5", { matchedAt: bad }));
      expect(!result.ok && result.refusal.code, bad).toBe("OMS_INVALID_INPUT");
    }
    expect((await h.manager.recordFill(fill(venueOrderId, "ts", "1", "0.5", { matchedAt: "2024-02-29T23:59:59.999+14:00" }))).ok).toBe(true);
    const settlement = await h.manager.applySettlement({ venueTradeId: "ts", venueOrderId, status: "MATCHED", observedAt: "2026-02-29T00:00:00Z" });
    expect(!settlement.ok && settlement.refusal.code).toBe("OMS_INVALID_INPUT");
  });

  it("refuses to open over a stored fill without a readable liquidity role or match time (r2: a redelivery is compared with them)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const { venueOrderId } = await live(h, 9);
    expect((await h.manager.recordFill(fill(venueOrderId, "s1", "1", "0.5"))).ok).toBe(true);
    const snapshot = await h.store.load();
    expect((await OrderManager.open({ ...h.deps, store: { apply: async () => undefined, load: async () => snapshot } })).ok).toBe(true);
    for (const [label, edit] of [
      ["no matchedAt", (f: Record<string, unknown>) => delete f["matchedAt"]],
      ["matchedAt not a timestamp", (f: Record<string, unknown>) => (f["matchedAt"] = "2026-10-03 00:00:00+00")],
      ["no liquidityRole", (f: Record<string, unknown>) => delete f["liquidityRole"]],
      ["liquidityRole unknown", (f: Record<string, unknown>) => (f["liquidityRole"] = "BOTH")],
    ] as const) {
      const tampered = structuredClone(snapshot);
      edit(tampered.fills[0] as unknown as Record<string, unknown>);
      const opened = await OrderManager.open({ ...h.deps, store: { apply: async () => undefined, load: async () => tampered } });
      expect(!opened.ok && opened.refusal.code, label).toBe("OMS_INVALID_INPUT");
    }
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

  it("a repeated state carrying a new transaction hash is kept as a same-state row: the enrichment quietly, a different hash with a non-halting alert; the hash survives a restart (r2, WP270-R2-03)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const id = await filled(h);
    const hashed = (status: string, transactionHash: string | null) => ({ ...at(status, id), transactionHash });
    for (const [status, hash] of [
      ["MINED", null],
      ["MINED", null],
      ["MINED", "0xabc"],
      ["MINED", "0xabc"],
      ["MINED", null],
      ["MINED", "0xdef"],
      ["CONFIRMED", "0xdef"],
      ["CONFIRMED", null],
    ] as const) {
      const result = await h.manager.applySettlement(hashed(status, hash));
      expect(result.ok && result.value, `${status} ${String(hash)}`).toBe(status);
    }
    const history = () => h.store.snapshotSync().settlements.map((s) => [s.stateOrdinal, s.previousState, s.state, s.transactionHash]);
    expect(history()).toEqual([
      [0, null, "MINED", null],
      [1, "MINED", "MINED", "0xabc"],
      [2, "MINED", "MINED", "0xdef"],
      [3, "MINED", "CONFIRMED", "0xdef"],
    ]);
    expect(h.manager.alerts().map((alert) => [alert.kind, alert.haltMarket])).toEqual([["SETTLEMENT_CONFLICT", false]]);
    const r = await reopen(h);
    expect((await r.manager.applySettlement(hashed("CONFIRMED", "0xdef"))).ok).toBe(true);
    expect(history()).toHaveLength(4);
    expect((await r.manager.applySettlement(hashed("CONFIRMED", "0x123"))).ok).toBe(true);
    expect(history().at(-1)).toEqual([4, "CONFIRMED", "CONFIRMED", "0x123"]);
    expect(r.manager.alerts().map((alert) => [alert.kind, alert.haltMarket])).toEqual([["SETTLEMENT_CONFLICT", false]]);
    const stale = await r.manager.applySettlement(hashed("MINED", "0x999"));
    expect(!stale.ok && stale.refusal.code).toBe("OMS_SETTLEMENT_REGRESSION");
    // The recorded hash is read back on recovery, so a stored row must carry a readable one (or null).
    const snapshot = await h.store.load();
    const tampered = structuredClone(snapshot);
    (tampered.settlements[0] as unknown as Record<string, unknown>)["transactionHash"] = 42;
    expect((await OrderManager.open({ ...h.deps, store: { apply: async () => undefined, load: async () => snapshot } })).ok).toBe(true);
    const refused = await OrderManager.open({ ...h.deps, store: { apply: async () => undefined, load: async () => tampered } });
    expect(!refused.ok && refused.refusal.code).toBe("OMS_INVALID_INPUT");
  });

  it("a hash already recorded for the current state is a duplicate, whichever row recorded it: alternating reports add one row and one alert, also after a restart (r3, OP-R3-01)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const id = await filled(h);
    const hashed = (status: string, transactionHash: string) => ({ ...at(status, id), transactionHash });
    for (const hash of ["0xabc", "0xdef", "0xabc", "0xdef", "0xabc"]) {
      const result = await h.manager.applySettlement(hashed("MINED", hash));
      expect(result.ok && result.value, hash).toBe("MINED");
    }
    const history = () => h.store.snapshotSync().settlements.map((s) => [s.stateOrdinal, s.previousState, s.state, s.transactionHash]);
    expect(history()).toEqual([
      [0, null, "MINED", "0xabc"],
      [1, "MINED", "MINED", "0xdef"],
    ]);
    expect(h.manager.alerts().map((alert) => [alert.kind, alert.haltMarket])).toEqual([["SETTLEMENT_CONFLICT", false]]);
    // The set of hashes recorded for the state is rebuilt on recovery from every row of that state.
    const r = await reopen(h);
    for (const hash of ["0xabc", "0xdef"]) expect((await r.manager.applySettlement(hashed("MINED", hash))).ok).toBe(true);
    expect(history()).toHaveLength(2);
    expect(r.manager.alerts()).toEqual([]);
    // A state change starts a new set: CONFIRMED in 0x123, then 0xabc (recorded for MINED, not for CONFIRMED) is new
    // evidence for CONFIRMED: a row and an alert.
    expect((await r.manager.applySettlement(hashed("CONFIRMED", "0x123"))).ok).toBe(true);
    expect((await r.manager.applySettlement(hashed("CONFIRMED", "0xabc"))).ok).toBe(true);
    expect(r.manager.alerts().map((alert) => [alert.kind, alert.haltMarket])).toEqual([["SETTLEMENT_CONFLICT", false]]);
    // Recovery rebuilds the set from the current state's rows only: 0xdef (a MINED row) is new for CONFIRMED.
    const again = await reopen(r);
    expect((await again.manager.applySettlement(hashed("CONFIRMED", "0xdef"))).ok).toBe(true);
    expect((await again.manager.applySettlement(hashed("CONFIRMED", "0xabc"))).ok).toBe(true);
    expect((await again.manager.applySettlement(hashed("CONFIRMED", "0x123"))).ok).toBe(true);
    expect(history().slice(2)).toEqual([
      [2, "MINED", "CONFIRMED", "0x123"],
      [3, "CONFIRMED", "CONFIRMED", "0xabc"],
      [4, "CONFIRMED", "CONFIRMED", "0xdef"],
    ]);
    expect(again.manager.alerts().map((alert) => [alert.kind, alert.haltMarket])).toEqual([["SETTLEMENT_CONFLICT", false]]);
  });

  it("a FAILED settlement re-reported with a hash is recorded once more, without a second SETTLEMENT_FAILED alert (r2)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const id = await filled(h);
    expect((await h.manager.applySettlement(at("FAILED", id))).ok).toBe(true);
    expect((await h.manager.applySettlement({ ...at("FAILED", id), transactionHash: "0xabc" })).ok).toBe(true);
    expect(h.store.snapshotSync().settlements.map((s) => [s.state, s.transactionHash])).toEqual([["FAILED", null], ["FAILED", "0xabc"]]);
    expect(h.manager.alerts().filter((alert) => alert.kind === "SETTLEMENT_FAILED")).toHaveLength(1);
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
