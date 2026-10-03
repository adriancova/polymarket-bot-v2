/**
 * WP-290 acceptance 1: AMBIGUOUS STATE NEVER RESUMES TRADING.
 *
 * Each case constructs one kind of ambiguity and shows that submissions stay
 * paused (`expectPaused`: no resume, the OMS paused and refusing a new
 * submission with `OMS_PAUSED`, the break unresolved) for as long as the
 * ambiguity lasts, however many runs pass and however much time. Where the
 * ambiguity can end on its own, the case also shows the converse: once a
 * later complete run no longer finds it, trading resumes (the hold is not a
 * dead end). No operator can release an ambiguity.
 *
 * Kinds: several candidates for one signed identity; one venue order that
 * two attempts could own; a near (inexact) candidate; conflicting reads; a
 * missing read; a stale read (the clock, and the read span); an out-of-order
 * read (orders and trades); an incomplete read; an undetermined trade
 * ownership; an unrecognised status (C-3's MATCHED_NOT_BROADCASTED); a
 * malformed read.
 */

import { describe, expect, it } from "vitest";

import { group, ticket } from "../../unit/oms/support/harness.js";

import { YES, streamTrade } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, sequence, submitOne } from "./support/scenario.js";

describe("WP-290 acceptance 1: ambiguous state never resumes trading", () => {
  it("several candidates for one signed identity: no answer, paused; resumes once only one remains", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    // An order of the account with the very same signed economics, placed outside the OMS.
    const twin = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    expect(await reconcileRounds(r, 4)).toBe(false);
    await expectPaused(r, false, "SIGNED_IDENTITY_AMBIGUOUS");
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(r.oms.attempt(attempt as string)?.venueOrderId).toBeNull();
    // An operator cannot release ambiguity.
    const hold = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "SIGNED_IDENTITY_AMBIGUOUS");
    const release = await r.p.coordinator.releaseQuarantine({ breakId: hold?.breakId ?? "", operatorRef: "operator-1", reason: "try" });
    expect(release.ok).toBe(false);
    // The twin is canceled with nothing matched: invisible now, so one candidate remains, found PRESENT.
    r.u.world.cancel(twin.venueOrderId);
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.oms.attempt(attempt as string)?.venueOrderId).not.toBeNull();
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("one venue order that two unresolved attempts could own: neither is answered, paused", async () => {
    const r = await ready();
    const twin = group(9002, { tokenId: YES, plannedShares: "5" });
    expect((await r.oms.registerGroup(twin)).ok).toBe(true);
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS", "UNKNOWN_ABSENT"]);
    const g1 = group(9001, { tokenId: YES, plannedShares: "5" });
    const batch = await r.oms.submitBatch([ticket(g1, { n: 701, shares: "1" }), ticket(twin, { n: 702, shares: "1" })]);
    expect(batch.ok).toBe(true);
    expect(await reconcileRounds(r, 4)).toBe(false);
    await expectPaused(r, false, "SIGNED_IDENTITY_AMBIGUOUS");
    expect(r.u.accepted).toEqual([]);
    expect(r.oms.attempts().every((attempt) => attempt.venueOrderId === null)).toBe(true);
  });

  it("an unclaimed order on the attempt's token and side that does not match it exactly: no ABSENT, paused", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    const attempt = await submitOne(r.oms);
    r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.51", size: "1" });
    expect(await reconcileRounds(r, 4)).toBe(false);
    await expectPaused(r, false, "SIGNED_IDENTITY_AMBIGUOUS");
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
  });

  it("conflicting reads (the list and the by-id read disagree about a price): nothing concluded, paused", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    await submitOne(r.oms);
    r.u.world.faults.readOrder = (_id, answer) => {
      const read = answer() as { order?: Record<string, unknown> };
      return { ...read, order: { ...(read.order ?? {}), price: "0.49" } };
    };
    expect(await reconcileRounds(r, 3)).toBe(false);
    await expectPaused(r, false, "READ_CONFLICT");
    expect(r.u.accepted).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(true);
  });

  it("conflicting reads (an order's trades sum to more than its matched size): paused", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    r.u.world.match(salt, "0.4");
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, sizeMatched: "0.3" })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 3)).toBe(false);
    await expectPaused(r, false, "READ_CONFLICT");
  });

  for (const read of ["listOpenOrders", "listTrades", "readPositions", "readCollateral", "readApprovals"] as const) {
    it(`a missing read (${read} throws): paused; resumes once it answers`, async () => {
      const r = await ready();
      r.u.world.faults[read] = () => {
        throw new Error("read unavailable");
      };
      r.p.coordinator.trigger("PERIODIC_TIMER");
      expect(await reconcileRounds(r, 3)).toBe(false);
      await expectPaused(r, false, "READ_MISSING");
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 2)).toBe(true);
    });
  }

  it("a missing read never answers an unknown attempt ABSENT, however long it lasts", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    await submitOne(r.oms);
    r.u.world.faults.listTrades = () => {
      throw new Error("read unavailable");
    };
    expect(await reconcileRounds(r, 6)).toBe(false);
    await expectPaused(r, false, "READ_MISSING");
    expect(r.u.accepted).toEqual([]);
  });

  it("a stale read (the reads take longer than the bound): no ABSENT, paused; resumes when reads are quick", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    await submitOne(r.oms);
    r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
    r.u.world.faults.onRead = () => {
      r.u.clock.t += 600; // five reads: 3000 ms, above the 2000 ms bound
    };
    const stale = await r.p.coordinator.reconcile();
    await expectPaused(r, stale.resumed, "READ_STALE");
    expect(r.u.accepted).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 2)).toBe(true);
  });

  it("a stale read (the clock goes backwards during the run): paused", async () => {
    const r = await ready();
    let reads = 0;
    r.u.world.faults.onRead = () => {
      reads += 1;
      if (reads === 3) r.u.clock.t -= 10;
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_STALE");
  });

  it("an out-of-order read (an order's matched size goes down): paused until a read catches up", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    r.u.world.match(salt, "0.4");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    // An older view comes back: the order as it was before the match, and no trade.
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, sizeMatched: "0" })) };
    };
    r.u.world.faults.listTrades = (answer) => ({ ...(answer() as object), trades: [] });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_REGRESSION");
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 2)).toBe(true);
  });

  it("an out-of-order read (a trade's settlement goes backwards): paused", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const trade = r.u.world.match(salt, "0.4");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 3)).toBe(true);
    if (trade !== undefined) trade.status = "TRADE_STATUS_MATCHED";
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_REGRESSION");
  });

  it("an incomplete read (a page is missing): paused", async () => {
    const r = await ready();
    r.u.world.faults.listOpenOrders = (answer) => ({ ...(answer() as object), complete: false });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_INCOMPLETE");
  });

  it("a trade whose ownership the read could not establish: paused", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: Record<string, unknown>[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownershipUndetermined: true })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_INCOMPLETE");
  });

  it("an unrecognised status (C-3's MATCHED_NOT_BROADCASTED) is never assumed harmless: paused", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    if (trade !== undefined) trade.status = "TRADE_STATUS_MATCHED_NOT_BROADCASTED";
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "STATUS_UNRECOGNISED");
  });

  it("trades in transit: a difference they explain all-or-nothing resumes; a partial one is held", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const trade = r.u.world.match(salt, "1", { status: "TRADE_STATUS_MATCHED" });
    // Matched, not yet on chain: the venue's holdings do not show it yet.
    r.u.world.adjustPosition(YES, "-1");
    r.u.world.adjustCollateral("0.5");
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? ""));
    await r.p.coordinator.settled();
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 2)).toBe(true);
    // Half of it on chain: no all-or-nothing reading explains that.
    r.u.world.adjustPosition(YES, "0.5");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "HOLDING_IN_TRANSIT_AMBIGUOUS");
    // Settled, and on chain in full: consistent again.
    r.u.world.adjustPosition(YES, "0.5");
    r.u.world.adjustCollateral("-0.5");
    if (trade !== undefined) trade.status = "TRADE_STATUS_CONFIRMED";
    expect(await reconcileRounds(r, 2)).toBe(true);
    expect(r.u.ledger.transactions().filter((appended) => appended.transaction.eventType === "RECONCILIATION_CORRECTION")).toEqual([]);
  });

  it("a tracked order whose venue facts differ from the order's is quarantined, never answered", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, originalSize: "2" })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "ORDER_FACTS_MISMATCH");
    expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_FACTS_MISMATCH")?.status).toBe("QUARANTINED");
  });

  it("a read behind the OMS (it recorded more fill than the venue shows) is held, never answered into a conflict", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const trade = r.u.world.match(salt, "0.4");
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? ""));
    await r.p.coordinator.settled();
    // The REST reads lag: they show neither the match nor the trade yet.
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, sizeMatched: "0" })) };
    };
    r.u.world.faults.readOrder = (_id, answer) => {
      const read = answer() as { order?: Record<string, unknown> };
      return { ...read, order: { ...(read.order ?? {}), sizeMatched: "0", status: "LIVE" } };
    };
    r.u.world.faults.listTrades = (answer) => ({ ...(answer() as object), trades: [] });
    const orderId = r.oms.orders()[0]?.orderId as string;
    expect((await r.oms.requestOrderReconciliation(orderId)).ok).toBe(true);
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "ORDER_FILLS_AHEAD_OF_VENUE");
    expect(r.u.accepted).toEqual([]);
    expect(r.oms.alerts().filter((alert) => alert.haltMarket)).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(true);
  });

  it("a malformed read (an inexact decimal) is discarded whole, never read as empty: paused", async () => {
    const r = await ready();
    r.u.world.faults.readPositions = () => ({ route: "/v2/positions", complete: true, positions: [{ tokenId: YES, size: "1.50" }] });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_MALFORMED");
  });
});
