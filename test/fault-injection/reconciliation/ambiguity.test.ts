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
 *
 * Round 2: the two reads of one order are each validated before they are
 * merged (R2-A); a break about one tracked order is cleared only by a run that
 * compared that order in full and found it consistent (R2-B); nothing more is
 * written to the OMS from a read set found unsound (R2-D).
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import { EXCHANGE, MARKET, PUSD, YES, boot, streamTrade } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

/** The same universe, after a restart (a fresh process over what survives). */
async function restart(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

/** The journal's BREAK_RESOLVED events for one break. */
function resolutions(r: Ready, breakId: string | undefined): unknown[] {
  return r.p.journal.events().filter((event) => event.kind === "BREAK_RESOLVED" && event.breakId === breakId);
}

describe("WP-290 acceptance 1: ambiguous state never resumes trading", () => {
  it("several candidates for one signed identity: no answer, paused; a candidate canceled later is still read by id and still a candidate (never PRESENT by elimination; r3, D-O1)", async () => {
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
    // The twin is canceled with nothing matched. Before r3 it was then invisible, and the attempt was found PRESENT
    // by elimination. It was SEEN, though: it stays read by id in every run (E-14: the by-id read finds canceled
    // orders), so it stays a candidate, and the attempt stays unanswered (WP-270: more than one candidate, no answer).
    const reads: string[] = [];
    r.u.world.faults.readOrder = (id, answer) => {
      reads.push(id);
      return answer();
    };
    r.u.world.cancel(twin.venueOrderId);
    expect(await reconcileRounds(r, 4)).toBe(false);
    await expectPaused(r, false, "SIGNED_IDENTITY_AMBIGUOUS");
    expect(reads).toContain(twin.venueOrderId);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(resolutions(r, hold?.breakId)).toEqual([]);
    expect(r.oms.attempt(attempt as string)?.venueOrderId).toBeNull();
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

  it("a stale read (the clock steps back during the reads as a request arrives; the end reading is sound again): paused", async () => {
    const r = await ready();
    const pending: { requestId: string; cause: string; markets: string[] }[] = [];
    r.p.coordinator.bindUserStream({
      pendingReconciliationRequests: () => [...pending],
      acknowledgeReconciliationRequest: (requestId: string) => pending.splice(pending.findIndex((entry) => entry.requestId === requestId), 1).length === 1,
    });
    let stepped = false;
    r.u.world.faults.onRead = (name) => {
      if (name === "listTrades" && !stepped) {
        stepped = true;
        r.u.clock.t -= 10;
        const request = { requestId: "stream-mid-read", cause: "SOCKET_CLOSED", markets: [] };
        pending.push(request);
        r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request });
      }
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toContain("READ_STALE");
    expect(report.runs[0]?.status).not.toBe("PASSED");
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

  it("an out-of-order read right after a missed fill was delivered (the OMS holds no settlement for it yet): paused", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    let reads = 0;
    r.u.world.faults.onRead = (name) => {
      // The second trades read (the next run, at once) comes from a replica that has not seen the settlement.
      if (name === "listTrades" && (reads += 1) === 2 && trade !== undefined) trade.status = "TRADE_STATUS_MATCHED";
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toContain("TRADE_MISSING_IN_OMS");
    await expectPaused(r, report.resumed, "READ_REGRESSION");
    expect(r.u.store.snapshotSync().settlements).toEqual([]);
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

  it("an unrecognised status on a trade of an order nothing tracks is never assumed harmless either: paused", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "1" });
    const trade = r.u.world.match(foreign.salt, "1");
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

  it("a tracked order whose venue facts differ from the order's is quarantined (found by the periodic comparison)", async () => {
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

  it("a tracked order whose venue facts differ from the order's is quarantined, and a request about it is not answered", async () => {
    const r = await ready();
    await submitOne(r.oms);
    // The venue shows another price, consistently in both reads (the OMS itself checks only the size).
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, price: "0.51" })) };
    };
    r.u.world.faults.readOrder = (_id, answer) => {
      const read = answer() as { order?: Record<string, unknown> };
      return { ...read, order: { ...(read.order ?? {}), price: "0.51" } };
    };
    expect((await r.oms.requestOrderReconciliation(r.oms.orders()[0]?.orderId as string)).ok).toBe(true);
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "ORDER_FACTS_MISMATCH");
    expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_FACTS_MISMATCH")?.status).toBe("QUARANTINED");
    expect(r.u.accepted).toEqual([]);
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

  it("an unrecognised order status (not in the documented vocabulary) holds: paused", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, status: "ORDER_STATUS_LIVE" })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "STATUS_UNRECOGNISED");
  });

  it("a malformed read (an inexact decimal) is discarded whole, never read as empty: paused", async () => {
    const r = await ready();
    r.u.world.faults.readPositions = () => ({ route: "/v2/positions", complete: true, positions: [{ tokenId: YES, size: "1.50" }] });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_MALFORMED");
  });
});

describe("WP-290 acceptance 1: what the OMS recorded durably is compared by identity, and a contradiction holds (r1)", () => {
  it("(I-02) the same trade with other economics at equal net collateral: FILL_MISMATCH, nothing changed or booked; offered to the OMS once", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const fills = r.u.store.snapshotSync().fills;
    expect(fills.map((fill) => [fill.shares, fill.price, fill.feeAmount])).toEqual([["0.4", "0.5", "0"]]);
    // 0.4 at 0.49 plus a fee of 0.004 costs what 0.4 at 0.5 does: the totals agree, the facts do not.
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { ownLegs: Record<string, unknown>[] }[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, price: "0.49", feeAmount: "0.004", feeAssetId: PUSD })) })) };
    };
    for (let round = 0; round < 3; round += 1) {
      r.p.coordinator.trigger("PERIODIC_TIMER");
      const report = await r.p.coordinator.reconcile();
      await expectPaused(r, report.resumed, "FILL_MISMATCH");
    }
    expect(r.u.store.snapshotSync().fills).toEqual(fills);
    expect(r.u.ledger.transactions().filter((appended) => appended.transaction.eventType === "RECONCILIATION_CORRECTION")).toEqual([]);
    // The OMS raised its own halting alert once: a known contradiction is not offered again every run.
    expect(r.oms.alerts().filter((alert) => alert.kind === "EVIDENCE_CONFLICT")).toHaveLength(1);
    // The read agrees again: the hold clears; the OMS's alert is a quarantine an operator releases.
    r.u.world.faults = {};
    const alert = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "OMS_HALTING_ALERT");
    expect(alert?.status).toBe("QUARANTINED");
    expect((await r.p.coordinator.releaseQuarantine({ breakId: alert?.breakId ?? "", operatorRef: "operator-1", reason: "the read was wrong" })).ok).toBe(true);
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.u.violations).toEqual([]);
  });

  it("(I-02) while a fill's economics are contradicted, the holdings it moves are not judged: nothing is booked UNATTRIBUTED", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    expect(await reconcileRounds(r, 3)).toBe(true);
    // The venue says the fill was at 0.45: the account paid 0.02 less than the OMS recorded, and the chain shows it.
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { ownLegs: Record<string, unknown>[] }[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, price: "0.45" })) })) };
    };
    r.u.world.adjustCollateral("0.02");
    for (let round = 0; round < 3; round += 1) {
      r.p.coordinator.trigger("PERIODIC_TIMER");
      const report = await r.p.coordinator.reconcile();
      await expectPaused(r, report.resumed, "FILL_MISMATCH");
      r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
    }
    expect(r.u.ledger.transactions().filter((appended) => appended.transaction.eventType === "RECONCILIATION_CORRECTION")).toEqual([]);
    expect(r.p.journal.breaks().filter((view) => view.breakClass === "BALANCE_UNATTRIBUTED")).toEqual([]);
  });

  it("(I-02) a trade id the OMS never recorded in place of one it did, at equal shares: FILL_MISMATCH, never delivered (nothing double-counted)", async () => {
    // r6: the OMS learned its fill from the user stream only, so no earlier read showed the trade it recorded: the
    // venue's trades read shows another trade id in its place, and the OMS's own comparison holds it.
    const r = await ready();
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: Record<string, unknown>[] };
      return { ...read, trades: read.trades.map((entry) => ({ ...entry, venueTradeId: "replacement-trade" })) };
    };
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? ""));
    await r.p.coordinator.settled();
    const fills = r.u.store.snapshotSync().fills;
    expect(fills).toHaveLength(1);
    for (let round = 0; round < 2; round += 1) {
      r.p.coordinator.trigger("PERIODIC_TIMER");
      const report = await r.p.coordinator.reconcile();
      await expectPaused(r, report.resumed, "FILL_MISMATCH");
    }
    expect(r.u.store.snapshotSync().fills).toEqual(fills);
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    // r6, class A: the venue has now shown two distinct trades on the order (the replacement, and the original once
    // the read agrees) summing more than its matched size: no later read can explain that away. It holds.
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(false);
    await expectPaused(r, false, "READ_CONFLICT");
    expect(r.u.store.snapshotSync().fills).toEqual(fills);
  });

  it("(I-02, r6) the same after an earlier read showed the trade the OMS recorded: the evidence holds it (READ_CONFLICT), never delivered, nothing double-counted", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const fills = r.u.store.snapshotSync().fills;
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: Record<string, unknown>[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, venueTradeId: "replacement-trade" })) };
    };
    for (let round = 0; round < 2; round += 1) {
      r.p.coordinator.trigger("PERIODIC_TIMER");
      const report = await r.p.coordinator.reconcile();
      await expectPaused(r, report.resumed, "READ_CONFLICT");
    }
    expect(r.u.store.snapshotSync().fills).toEqual(fills);
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.u.store.snapshotSync().fills).toEqual(fills);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(I-02) a settlement contradicting the OMS's terminal one holds for as long as it lasts, even once the OMS's alert is released", async () => {
    // r6: the OMS learned CONFIRMED from the user stream only (no earlier read showed the trade): the read's FAILED
    // contradicts the OMS's durable record, and the OMS's own comparison holds it.
    const r = await ready();
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    const tradeId = trade?.venueTradeId ?? "";
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, tradeId));
    r.p.coordinator.onUserStreamOutput({
      kind: "TRADE",
      oms: {
        fills: [],
        settlements: [{ venueTradeId: tradeId, venueOrderId: trade?.venueOrderId ?? "", status: "CONFIRMED", transactionHash: trade?.transactionHash ?? null, observedAt: "2026-10-03T00:00:00.000Z" }],
        shortfalls: [],
      },
    });
    await r.p.coordinator.settled();
    expect(r.u.store.snapshotSync().settlements.map((settlement) => settlement.state)).toEqual(["CONFIRMED"]);
    if (trade !== undefined) trade.status = "TRADE_STATUS_FAILED";
    const first = await r.p.coordinator.reconcile();
    await expectPaused(r, first.resumed, "FILL_MISMATCH");
    const alert = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "OMS_HALTING_ALERT");
    expect(alert?.status).toBe("QUARANTINED");
    expect((await r.p.coordinator.releaseQuarantine({ breakId: alert?.breakId ?? "", operatorRef: "operator-1", reason: "seen" })).ok).toBe(true);
    for (let round = 0; round < 2; round += 1) {
      const report = await r.p.coordinator.reconcile();
      await expectPaused(r, report.resumed, "FILL_MISMATCH");
    }
    expect(r.oms.alerts().filter((entry) => entry.kind === "SETTLEMENT_CONFLICT")).toHaveLength(1);
  });

  it("(I-02, r6) the same after an earlier read showed the trade CONFIRMED (a restart included): the two reads contradict each other (READ_CONFLICT), nothing is written to the OMS, held until the read agrees", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.u.store.snapshotSync().settlements.map((settlement) => settlement.state)).toEqual(["CONFIRMED"]);
    if (trade !== undefined) trade.status = "TRADE_STATUS_FAILED";
    const again = await restart(r);
    for (let round = 0; round < 3; round += 1) {
      const report = await again.p.coordinator.reconcile();
      await expectPaused(again, report.resumed, "READ_CONFLICT");
    }
    expect(again.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("READ_CONFLICT", "trade", trade?.venueTradeId ?? "?"))?.detail).toContain("contradict");
    expect(again.oms.alerts().filter((entry) => entry.kind === "SETTLEMENT_CONFLICT")).toHaveLength(0);
    expect(again.u.store.snapshotSync().settlements.map((settlement) => settlement.state)).toEqual(["CONFIRMED"]);
    // The FAILED the read showed is still a halt obligation (class C: derived from the trades read in every run,
    // whatever its soundness): its market is halted, and an operator releases it once the read is known wrong.
    const failed = again.p.journal.unresolvedBreaks().find((view) => view.breakClass === "SETTLEMENT_FAILED");
    expect(failed?.status).toBe("QUARANTINED");
    if (trade !== undefined) trade.status = "CONFIRMED";
    expect((await again.p.coordinator.releaseQuarantine({ breakId: failed?.breakId ?? "", operatorRef: "operator-1", reason: "the read was wrong" })).ok).toBe(true);
    expect(await reconcileRounds(again, 3)).toBe(true);
  });

  it("(I-03) after a restart, a FILLED order whose trade a complete trades read does not show: held, never resumed", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    r.u.world.match(salt, "1");
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.oms.orders()[0]?.state).toBe("FILLED");
    r.u.world.faults.listTrades = () => ({ route: "/data/trades", complete: true, trades: [] });
    const again = await restart(r);
    const report = await again.p.coordinator.reconcile();
    await expectPaused(again, report.resumed, "ORDER_FILLS_AHEAD_OF_VENUE");
    // The venue matched more than its trades show, too.
    expect(again.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("ORDER_TRADES_INCOMPLETE");
    // Nor may the by-id read lose it: a filled order the venue does not find is a contradiction too.
    const venueOrderId = again.oms.orders()[0]?.venueOrderId as string;
    r.u.world.faults.readOrder = (id, answer) => (id === venueOrderId ? { route: "/data/order", found: false } : answer());
    const missing = await again.p.coordinator.reconcile();
    await expectPaused(again, missing.resumed, "ORDER_STATE_MISMATCH");
    r.u.world.faults = {};
    expect(await reconcileRounds(again, 4)).toBe(true);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(I-04) after a restart, a settlement read behind the OMS's durable one: READ_REGRESSION, paused until the read catches up", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.u.store.snapshotSync().settlements.map((settlement) => settlement.state)).toEqual(["CONFIRMED"]);
    if (trade !== undefined) trade.status = "MATCHED";
    const again = await restart(r);
    const report = await again.p.coordinator.reconcile();
    await expectPaused(again, report.resumed, "READ_REGRESSION");
    expect(report.runs[0]?.answers).toEqual([]);
    if (trade !== undefined) trade.status = "CONFIRMED";
    expect(await reconcileRounds(again, 3)).toBe(true);
  });

  it("(I-05) a tracked order whose venue token differs: never answered, quarantined (the request's answer)", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const swap = (order: Record<string, unknown>): Record<string, unknown> => ({ ...order, tokenId: "12345" });
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map(swap) };
    };
    r.u.world.faults.readOrder = (_id, answer) => {
      const read = answer() as { order?: Record<string, unknown> };
      return { ...read, order: swap(read.order ?? {}) };
    };
    expect((await r.oms.requestOrderReconciliation(r.oms.orders()[0]?.orderId as string)).ok).toBe(true);
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "ORDER_FACTS_MISMATCH");
    expect(r.u.accepted).toEqual([]);
  });

  it("(I-05) a tracked order whose venue token differs: found by the periodic comparison (the group's token)", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, tokenId: "12345" })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "ORDER_FACTS_MISMATCH");
  });

  it("(I-05) a tracked order whose group's token is unknown is not compared, and holds", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.seams.tokenOfGroup = () => null;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "COMPONENT_UNAVAILABLE");
    delete r.u.seams.tokenOfGroup;
    expect(await reconcileRounds(r, 2)).toBe(true);
  });

  it("(I-06) a release does not acknowledge a live contradiction: still found, it opens again and holds; once consistent, a release resumes", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, price: "0.51" })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "ORDER_FACTS_MISMATCH");
    const first = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_FACTS_MISMATCH");
    expect((await r.p.coordinator.releaseQuarantine({ breakId: first?.breakId ?? "", operatorRef: "operator-1", reason: "looked at it" })).ok).toBe(true);
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "ORDER_FACTS_MISMATCH");
    const second = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_FACTS_MISMATCH");
    expect(second?.breakId).not.toBe(first?.breakId);
    expect(second?.status).toBe("QUARANTINED");
    expect(r.u.halts.some((halt) => halt.breakId === second?.breakId)).toBe(true);
    // The venue agrees again: the contradiction is gone; the quarantine still needs its release.
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect((await r.p.coordinator.releaseQuarantine({ breakId: second?.breakId ?? "", operatorRef: "operator-1", reason: "consistent now" })).ok).toBe(true);
    expect(await reconcileRounds(r, 2)).toBe(true);
  });

  for (const [variant, breakClass, skew] of [
    ["whose venue facts differ", "ORDER_FACTS_MISMATCH", (r: Ready): void => {
      r.u.world.faults.listOpenOrders = (answer) => {
        const read = answer() as { orders: Record<string, unknown>[] };
        return { ...read, orders: read.orders.map((order) => ({ ...order, price: "0.51" })) };
      };
    }],
    ["whose group's token is unknown", "COMPONENT_UNAVAILABLE", (r: Ready): void => {
      r.u.seams.tokenOfGroup = () => null;
    }],
  ] as const) {
    it(`(I-05, I-06) a fill the OMS missed, on a tracked order ${variant}, is never booked UNATTRIBUTED (its fills were not compared)`, async () => {
      const r = await ready();
      await submitOne(r.oms);
      r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4"); // the OMS has not seen it; the holdings show it
      skew(r);
      for (let round = 0; round < 3; round += 1) {
        r.p.coordinator.trigger("PERIODIC_TIMER");
        const report = await r.p.coordinator.reconcile();
        await expectPaused(r, report.resumed, breakClass);
        r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
      }
      expect(r.u.ledger.transactions().filter((appended) => appended.transaction.eventType === "RECONCILIATION_CORRECTION")).toEqual([]);
      expect(r.p.journal.breaks().filter((view) => view.breakClass === "POSITION_UNATTRIBUTED" || view.breakClass === "BALANCE_UNATTRIBUTED")).toEqual([]);
    });
  }

  it("(I-10) a missed fill the OMS refuses (its price is on the wrong side of the limit): FILL_REFUSED, never booked, paused", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { ownLegs: Record<string, unknown>[] }[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, price: "0.6" })) })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "FILL_REFUSED");
    expect(r.u.store.snapshotSync().fills).toEqual([]);
  });

  it("(I-10, X6) a required approval the approvals read does not show: APPROVAL_MISSING, paused; resumes once shown", async () => {
    const r = await ready();
    r.u.world.approvals.set(EXCHANGE, false);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "APPROVAL_MISSING");
    r.u.world.approvals.set(EXCHANGE, true);
    expect(await reconcileRounds(r, 2)).toBe(true);
  });

  it("(I-09) a run that did not judge the holdings never clears a holding break as NOT_REPRODUCED", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.adjustPosition(YES, "3");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    const held = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "HOLDING_DELTA_UNCONFIRMED" && view.assetId === YES);
    expect(held).toBeDefined();
    // A fill whose fee the read does not fix: the OMS and the venue disagree about the order, so holdings are not judged.
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4", { feeAmount: null });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs.length).toBeGreaterThan(0);
    for (const run of report.runs) {
      expect(run.detections.map((detection) => detection.breakClass)).toContain("FILL_ECONOMICS_UNFIXED");
      expect(run.detections.map((detection) => detection.breakClass)).not.toContain("HOLDING_DELTA_UNCONFIRMED");
    }
    expect(resolutions(r, held?.breakId)).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakId)).toContain(held?.breakId);
  });

  it("(I-09) an attempt's identity ambiguity is not cleared by a run that did not judge that identity (its transmission in flight)", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    await r.p.coordinator.reconcile();
    const hold = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "SIGNED_IDENTITY_AMBIGUOUS");
    expect(hold).toBeDefined();
    r.u.seams.attempts = (list) => list.map((entry) => (entry.submissionAttemptId === attempt ? { ...entry, inFlight: true } : entry));
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs.flatMap((run) => run.detections.map((detection) => detection.breakClass))).not.toContain("SIGNED_IDENTITY_AMBIGUOUS");
    expect(resolutions(r, hold?.breakId)).toEqual([]);
    delete r.u.seams.attempts;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "SIGNED_IDENTITY_AMBIGUOUS");
    expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "SIGNED_IDENTITY_AMBIGUOUS")?.breakId).toBe(hold?.breakId);
  });

  it("(I-09) an identity ambiguity is cleared by the run that judged it, though the attempt stays a potential owner (held after ABSENT): resumes", async () => {
    const r = await ready();
    // Attempt A, a 425 (once found ABSENT it is HELD for the retransmission decision, and could still be placed),
    // and attempt B, whose answer was lost, at a near price on the same token and side. B's order is a near
    // candidate for A until B is found PRESENT and claims it (r3: a canceled near candidate no longer clears it, D-O1).
    const near = group(9003, { tokenId: YES, plannedShares: "5", limitPrice: "0.51" });
    expect((await r.oms.registerGroup(near)).ok).toBe(true);
    r.u.world.nextTransmission = sequence(["UNKNOWN_425_ABSENT", "UNKNOWN_EXISTS"]);
    const a = ticket(group(9001, { tokenId: YES, plannedShares: "5" }), { n: 731, shares: "1" });
    const b = ticket(near, { n: 732, shares: "1", limitPrice: "0.51" });
    expect((await r.oms.submitBatch([a, b])).ok).toBe(true);
    const [attemptA, attemptB] = [a, b].map((entry) => r.oms.attempts().find((attempt) => attempt.orderId === entry.orderId)?.submissionAttemptId);
    await r.p.coordinator.reconcile();
    const hold = r.p.journal.breaks().find((view) => view.breakClass === "SIGNED_IDENTITY_AMBIGUOUS");
    expect(hold?.subjectKey).toContain(attemptA as string);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attemptB).map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attemptA).map((answer) => answer.verdict)).toEqual(["ABSENT"]);
    expect(r.oms.attempts().find((attempt) => attempt.submissionAttemptId === attemptA)).toMatchObject({ state: "RECONCILING", absentConfirmed: true });
    expect(resolutions(r, hold?.breakId)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(I-09) a refused ABSENT is cleared by the run whose ABSENT is accepted, though the attempt stays held: resumes", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_425_ABSENT"]);
    await submitOne(r.oms);
    let refusals = 0;
    r.u.seams.applyReconciliation = async (raw, real) => {
      if ((raw as { verdict?: string }).verdict === "ABSENT" && refusals === 0) {
        refusals += 1;
        return { ok: false, refusal: { code: "OMS_TEST_REFUSED", message: "refused once by the test" } };
      }
      return real(raw);
    };
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(refusals).toBe(1);
    const refused = r.p.journal.breaks().find((view) => view.breakClass === "ANSWER_REFUSED");
    expect(refused?.resolution).toBe("NOT_REPRODUCED");
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["ABSENT"]);
    expect(r.oms.attempts().map((attempt) => [attempt.state, attempt.absentConfirmed])).toEqual([["RECONCILING", true]]);
  });

  it("(I-09) a refused answer is not cleared by a run that gave no answer; an accepted one clears it", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    r.u.seams.applyReconciliation = async () => ({ ok: false, refusal: { code: "OMS_TEST_REFUSED", message: "refused by the test" } });
    await r.p.coordinator.reconcile();
    const refused = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ANSWER_REFUSED");
    expect(refused).toBeDefined();
    delete r.u.seams.applyReconciliation;
    r.u.seams.attempts = (list) => list.map((entry) => (entry.submissionAttemptId === attempt ? { ...entry, inFlight: true } : entry));
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs.flatMap((run) => run.answers)).toEqual([]);
    expect(resolutions(r, refused?.breakId)).toEqual([]);
    delete r.u.seams.attempts;
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(resolutions(r, refused?.breakId)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
  });
});

describe("WP-290 acceptance 1: every order observation is validated before two reads of one order are merged (r2, R2-A)", () => {
  /** An attempt whose answer was lost, whose order is at the venue and unclaimed: read in the open-orders list AND by id. */
  async function unclaimed(): Promise<{ r: Ready; salt: string }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    await submitOne(r.oms);
    return { r, salt: r.u.world.receipts.at(-1) as string };
  }

  function listedAs(r: Ready, status: string): void {
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, status })) };
    };
  }

  it("(R2-A) a status outside the vocabulary in the open-orders list is not erased by a recognised one in the by-id read: nothing answered, paused", async () => {
    const { r } = await unclaimed();
    listedAs(r, "MYSTERY"); // the by-id read, later, says LIVE
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "STATUS_UNRECOGNISED");
    expect(report.runs.flatMap((run) => run.answers)).toEqual([]);
    expect(r.u.accepted).toEqual([]);
    // Both reads agree again: the attempt is found PRESENT, and trading resumes.
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["PRESENT"]);
  });

  it("(R2-A) a by-id read showing an order live after the list showed it terminal is an out-of-order read (READ_REGRESSION): nothing answered, paused", async () => {
    const { r } = await unclaimed();
    listedAs(r, "CANCELED"); // the by-id read, later, says LIVE
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_REGRESSION");
    expect(report.runs.flatMap((run) => run.answers)).toEqual([]);
    expect(r.u.accepted).toEqual([]);
  });

  it("(R2-A) the two reads naming another status at the same stage (DELAYED, then LIVE) disagree (READ_CONFLICT): nothing answered, paused", async () => {
    const { r } = await unclaimed();
    listedAs(r, "DELAYED");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_CONFLICT");
    expect(report.runs.flatMap((run) => run.answers)).toEqual([]);
  });

  it("(R2-A) a status outside the vocabulary in the by-id read of an order the list does not show (a FILLED order): paused", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "1");
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.oms.orders()[0]?.state).toBe("FILLED");
    r.u.world.faults.readOrder = (_id, answer) => {
      const read = answer() as { order?: Record<string, unknown> };
      return { ...read, order: { ...read.order, status: "MYSTERY" } };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "STATUS_UNRECOGNISED");
  });

  it("(R2-A, liveness) a by-id read showing the order further along (canceled after the list showed it live) is no disagreement", async () => {
    const { r, salt } = await unclaimed();
    const order = r.u.world.orders.get(salt);
    expect(order).toBeDefined();
    r.u.world.cancel(order?.venueOrderId as string); // canceled between the list read and the by-id read
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: [...read.orders, { ...r.u.world.orderView(order as NonNullable<typeof order>), status: "LIVE" }] };
    };
    const report = await r.p.coordinator.reconcile();
    const classes = report.runs.flatMap((run) => run.detections.map((detection) => detection.breakClass));
    for (const problem of ["READ_CONFLICT", "READ_REGRESSION", "STATUS_UNRECOGNISED"]) expect(classes).not.toContain(problem);
    expect(r.u.accepted.map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", order?.venueOrderId]]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });
});

describe("WP-290 acceptance 1: a break about one tracked order is cleared only by a run that compared that order in full (r2, R2-B)", () => {
  /** The breaks of these classes that a given run resolved. */
  function resolvedBy(r: Ready, runIds: readonly (string | null)[], breakIds: readonly (string | undefined)[]): unknown[] {
    return r.p.journal.events().filter((event) => event.kind === "BREAK_RESOLVED" && runIds.includes(event.runId) && breakIds.includes(event.breakId));
  }

  function unresolved(r: Ready, breakClass: string): string | undefined {
    return r.p.journal.unresolvedBreaks().find((view) => view.breakClass === breakClass)?.breakId;
  }

  /**
   * A FILL_MISMATCH that persists in the read: the trade the OMS recorded is shown with other economics (its price).
   * (r6: not under another trade id: two distinct trade ids the venue showed on one order, summing more than its
   * matched size, are evidence no later read can explain away, so they would hold for good: `(I-02, r6)` above.)
   */
  async function fillMismatch(): Promise<{ r: Ready; mismatch: string | undefined }> {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    expect(await reconcileRounds(r, 3)).toBe(true);
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { ownLegs: Record<string, unknown>[] }[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, price: "0.45" })) })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    const mismatch = unresolved(r, "FILL_MISMATCH");
    expect(mismatch).toBeDefined();
    return { r, mismatch };
  }

  it("(R2-B) a run that skipped the order (its group's token unknown) does not clear its FILL_MISMATCH; a run that compares it again does", async () => {
    const { r, mismatch } = await fillMismatch();
    r.u.seams.tokenOfGroup = () => null;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const skipped = await r.p.coordinator.reconcile();
    expect(skipped.runs.flatMap((run) => run.detections.map((detection) => detection.breakClass))).not.toContain("FILL_MISMATCH");
    expect(resolutions(r, mismatch)).toEqual([]);
    expect(unresolved(r, "FILL_MISMATCH")).toBe(mismatch);
    // Compared again, the mismatch is still there: the same break holds.
    delete r.u.seams.tokenOfGroup;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "FILL_MISMATCH");
    expect(unresolved(r, "FILL_MISMATCH")).toBe(mismatch);
    // The read agrees again: compared in full and consistent, it clears (the OMS's own alert about the contradicted
    // economics is a quarantine an operator releases, as in "(I-02) the same trade with other economics").
    r.u.world.faults = {};
    for (const view of r.p.journal.unresolvedBreaks().filter((entry) => entry.breakClass === "OMS_HALTING_ALERT")) {
      expect((await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason: "the read was wrong" })).ok).toBe(true);
    }
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(resolutions(r, mismatch)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
  });

  it("(R2-B) a run that skipped the order (its venue facts differ: ORDER_FACTS_MISMATCH) does not clear its FILL_MISMATCH", async () => {
    const { r, mismatch } = await fillMismatch();
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.map((order) => ({ ...order, price: "0.51" })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const skipped = await r.p.coordinator.reconcile();
    await expectPaused(r, skipped.resumed, "ORDER_FACTS_MISMATCH");
    expect(resolutions(r, mismatch)).toEqual([]);
    expect(unresolved(r, "FILL_MISMATCH")).toBe(mismatch);
  });

  it("(R2-B) ORDER_TRADES_INCOMPLETE and ORDER_FILLS_AHEAD_OF_VENUE are not cleared by a run that could not verify the order's fills", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "1");
    expect(await reconcileRounds(r, 4)).toBe(true);
    r.u.world.faults.listTrades = () => ({ route: "/data/trades", complete: true, trades: [] });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    const incomplete = unresolved(r, "ORDER_TRADES_INCOMPLETE");
    const ahead = unresolved(r, "ORDER_FILLS_AHEAD_OF_VENUE");
    expect([incomplete, ahead].every((id) => id !== undefined)).toBe(true);
    // The trade is shown again, but its fee is not fixed: the fill the OMS recorded cannot be verified.
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { ownLegs: Record<string, unknown>[] }[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, feeAmount: null })) })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const unverified = await r.p.coordinator.reconcile();
    await expectPaused(r, unverified.resumed, "FILL_ECONOMICS_UNFIXED");
    expect(resolutions(r, incomplete)).toEqual([]);
    expect(resolutions(r, ahead)).toEqual([]);
    // Verifiable and consistent again: both clear, and trading resumes.
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(resolutions(r, incomplete)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
    expect(resolutions(r, ahead)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
  });

  it("(R2-B) a refused delivery (FILL_REFUSED, keyed by trade) and its TRADE_MISSING_IN_OMS are not cleared by a run that skipped the order", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4"); // the OMS has not seen it
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { ownLegs: Record<string, unknown>[] }[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, price: "0.6" })) })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    const refused = unresolved(r, "FILL_REFUSED");
    const missing = unresolved(r, "TRADE_MISSING_IN_OMS");
    expect([refused, missing].every((id) => id !== undefined)).toBe(true);
    r.u.seams.tokenOfGroup = () => null;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "COMPONENT_UNAVAILABLE");
    expect(resolutions(r, refused)).toEqual([]);
    expect(resolutions(r, missing)).toEqual([]);
    // The refused delivery was offered to the OMS once (one halting alert, one quarantine), not once per run.
    expect(r.oms.alerts().filter((alert) => alert.kind === "FILL_INCONSISTENT")).toHaveLength(1);
    const alert = r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "OMS_HALTING_ALERT");
    expect(alert).toHaveLength(1);
    // Compared again with the venue's true price: delivered, then a run finds the order consistent and clears both.
    delete r.u.seams.tokenOfGroup;
    r.u.world.faults = {};
    expect((await r.p.coordinator.releaseQuarantine({ breakId: alert[0]?.breakId ?? "", operatorRef: "operator-1", reason: "the read was wrong" })).ok).toBe(true);
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(resolutions(r, refused)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
    expect(resolutions(r, missing)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
  });

  it("(R2-B) a run that finds the order's state wrong clears none of its other breaks, though its fills now compare equal", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    r.u.world.match(salt, "0.4");
    expect(await reconcileRounds(r, 3)).toBe(true);
    r.u.world.faults.listTrades = () => ({ route: "/data/trades", complete: true, trades: [] });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    const ahead = unresolved(r, "ORDER_FILLS_AHEAD_OF_VENUE");
    expect(ahead).toBeDefined();
    // The trades are shown again (the fills compare equal), but the venue canceled the order the OMS holds live.
    r.u.world.faults = {};
    r.u.world.cancel(r.u.world.orders.get(salt)?.venueOrderId as string);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    const first = report.runs[0];
    expect(first?.detections.map((detection) => detection.breakClass)).toContain("ORDER_STATE_MISMATCH");
    expect(resolvedBy(r, [first?.runId ?? null], [ahead])).toEqual([]);
    // Once the OMS agrees (it read the order by id and concluded it), a later run clears it and resumes.
    expect(report.resumed || (await reconcileRounds(r, 3))).toBe(true);
    expect(resolutions(r, ahead)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
  });

  it("(R2-B) an order the OMS is still reconciling is not judged: its ORDER_STATE_MISMATCH holds until the OMS concludes it", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    expect(await reconcileRounds(r, 2)).toBe(true);
    r.u.world.cancel(r.u.world.orders.get(salt)?.venueOrderId as string);
    // The OMS will not take the answer yet: its order stays RECONCILING.
    r.u.seams.applyReconciliation = async () => ({ ok: false, refusal: { code: "OMS_TEST_REFUSED", message: "refused by the test" } });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs.length).toBeGreaterThan(1);
    expect(r.oms.orders()[0]?.state).toBe("RECONCILING");
    const mismatch = r.p.journal.breaks().find((view) => view.breakClass === "ORDER_STATE_MISMATCH");
    expect(mismatch?.status).toBe("OPEN");
    expect(resolutions(r, mismatch?.breakId)).toEqual([]);
    // The OMS takes the answer: the order is CANCELED, compared in full, and the break clears.
    delete r.u.seams.applyReconciliation;
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.oms.orders()[0]?.state).toBe("CANCELED");
    expect(resolutions(r, mismatch?.breakId)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
  });
});

describe("WP-290 acceptance 1: a break about one tracked order clears once that order is compared again and found consistent (r2, R2-B liveness)", () => {
  it("(R2-B, liveness) after a restart, a break about a canceled order with nothing filled clears once its by-id read finds it consistent", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    expect(await reconcileRounds(r, 2)).toBe(true);
    const venueOrderId = r.u.world.orders.get(salt)?.venueOrderId as string;
    // The venue cancels the order (the OMS holds it live), and the OMS will not take the authoritative answer yet.
    r.u.world.cancel(venueOrderId);
    r.u.seams.applyReconciliation = async () => ({ ok: false, refusal: { code: "OMS_TEST_REFUSED", message: "refused by the test" } });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "ORDER_STATE_MISMATCH");
    const mismatch = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_STATE_MISMATCH");
    expect(mismatch).toBeDefined();
    // After a restart (nothing in memory), the order is read by id, found canceled with nothing matched, the OMS takes
    // the answer, the order is compared in full, and the break clears.
    delete r.u.seams.applyReconciliation;
    const again = await restart(r);
    expect(await reconcileRounds(again, 4)).toBe(true);
    expect([again.oms.orders()[0]?.state, again.oms.orders()[0]?.filledShares]).toEqual(["CANCELED", "0"]);
    expect(resolutions(again, mismatch?.breakId)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(R2-B, r6) a match a read showed on a canceled order, which the venue later withdraws, is evidence: the order's breaks never clear on reads that show less; held, never resumed (the r2 liveness setup)", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    expect(await reconcileRounds(r, 2)).toBe(true);
    const venueOrderId = r.u.world.orders.get(salt)?.venueOrderId as string;
    r.u.world.cancel(venueOrderId);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect([r.oms.orders()[0]?.state, r.oms.orders()[0]?.filledShares]).toEqual(["CANCELED", "0"]);
    // A trades read names the canceled order with a trade, and its by-id read agrees on its size.
    const phantom = {
      venueTradeId: "phantom-1",
      status: "CONFIRMED",
      transactionHash: null,
      ownershipUndetermined: false,
      ownLegs: [{ venueOrderId, role: "MAKER", tokenId: YES, side: "BUY", shares: "0.4", price: "0.5", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" }],
    };
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: unknown[] };
      return { ...read, trades: [...read.trades, phantom] };
    };
    r.u.world.faults.readOrder = (id, answer) => {
      const read = answer() as { order?: Record<string, unknown> };
      return id === venueOrderId ? { ...read, order: { ...read.order, sizeMatched: "0.4" } } : read;
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "FILL_REFUSED");
    const named = r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "FILL_REFUSED" || view.breakClass === "TRADE_MISSING_IN_OMS");
    expect(named).toHaveLength(2);
    // The venue withdraws the trade and shows the order with nothing matched. After a restart, the journal's evidence
    // alone still holds the 0.4 match a read showed: the by-id read showing 0 is a read behind it (READ_REGRESSION),
    // and nothing about the order is cleared or concluded.
    r.u.world.faults = {};
    const again = await restart(r);
    for (const view of again.p.journal.unresolvedBreaks().filter((entry) => entry.breakClass === "OMS_HALTING_ALERT")) {
      expect((await again.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason: "the phantom trade was withdrawn" })).ok).toBe(true);
    }
    expect(await reconcileRounds(again, 3)).toBe(false);
    await expectPaused(again, false, "READ_REGRESSION");
    for (const view of named) expect(resolutions(again, view.breakId)).toEqual([]);
    expect(again.oms.orders()[0]?.filledShares).toBe("0");
  });
});

describe("WP-290 acceptance 1: nothing more is written to the OMS from a read set found unsound (r2, R2-D)", () => {
  it("(R2-D) after a restart, a settlement read behind the OMS's durable one stops the probe: a later leg's settlement is not recorded from that read", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const first = r.u.world.receipts.at(-1) as string;
    await submitOne(r.oms);
    const second = r.u.world.receipts.at(-1) as string;
    const behind = r.u.world.match(first, "0.4", { status: "CONFIRMED" });
    const ahead = r.u.world.match(second, "0.4", { status: "MATCHED" });
    expect(await reconcileRounds(r, 4)).toBe(true);
    const states = (): string[][] => r.u.store.snapshotSync().settlements.map((settlement) => [settlement.venueTradeId, settlement.state]);
    expect(states()).toEqual([
      [behind?.venueTradeId, "CONFIRMED"],
      [ahead?.venueTradeId, "MATCHED"],
    ]);
    // The first order's trade reads behind the OMS; the second's has moved on. The first order is probed first.
    if (behind !== undefined) behind.status = "MATCHED";
    if (ahead !== undefined) ahead.status = "CONFIRMED";
    const again = await restart(r);
    const report = await again.p.coordinator.reconcile();
    await expectPaused(again, report.resumed, "READ_REGRESSION");
    expect(states()).toEqual([
      [behind?.venueTradeId, "CONFIRMED"],
      [ahead?.venueTradeId, "MATCHED"],
    ]);
    // The read catches up: the second trade's settlement is recorded by a sound run, and trading resumes.
    if (behind !== undefined) behind.status = "CONFIRMED";
    expect(await reconcileRounds(again, 3)).toBe(true);
    expect(states()).toEqual([
      [behind?.venueTradeId, "CONFIRMED"],
      [ahead?.venueTradeId, "MATCHED"],
      [ahead?.venueTradeId, "CONFIRMED"],
    ]);
  });
});

describe("WP-290 acceptance 1: a venue order seen once is never forgotten while anything about it is unresolved (r3, D-O1)", () => {
  /**
   * One attempt whose answer was lost while the venue took its order X (`UNKNOWN_EXISTS`). Run 1 sees X but its
   * reads are not one consistent view (`spoil`), so it classifies nothing. Then X leaves the open-orders list
   * (`after`). Every later run's by-id reads are recorded. E-14: an order absent from the list is not proof of
   * cancellation; a missing order is resolved by id. Before r3, no later run read X again, and the attempt was
   * answered ABSENT while the venue held its order (the oracle's R2).
   */
  async function seenOnce(spoil: (r: Ready, venueOrderId: string) => void, after: (r: Ready, salt: string, venueOrderId: string) => void): Promise<{ r: Ready; x: string; attempt: string; reads: string[]; run1: string[] }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const salt = r.u.world.receipts.at(-1) as string;
    const x = r.u.world.orders.get(salt)?.venueOrderId as string;
    spoil(r, x);
    const report = await r.p.coordinator.reconcile();
    const run1 = report.runs.flatMap((run) => run.detections.map((detection) => detection.breakClass));
    after(r, salt, x);
    const reads: string[] = [];
    r.u.world.faults = {
      readOrder: (id, answer) => {
        reads.push(id);
        return answer();
      },
    };
    return { r, x, attempt, reads, run1 };
  }

  const readFails = (r: Ready, x: string): void => {
    r.u.world.faults.readOrder = (id, answer) => {
      if (id === x) throw new Error("timeout");
      return answer();
    };
  };
  const cancel = (r: Ready, _salt: string, x: string): void => {
    r.u.world.cancel(x);
  };

  it("(D-O1, V1) its by-id read failed in run 1, and it is canceled: read by id again, found PRESENT (CANCELED), never ABSENT; resumes consistent", async () => {
    const { r, x, attempt, reads, run1 } = await seenOnce(readFails, cancel);
    expect(run1).toContain("READ_MISSING");
    // Run 1 recorded the order as seen and unclassified, durably.
    expect(r.p.journal.unresolvedBreaks().map((view) => view.detail)).toContainEqual(expect.stringContaining(`venue order ${x} was seen by a run whose reads were not one consistent view`));
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(reads).toContain(x);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([{ verdict: "PRESENT", attemptId: attempt, venueOrderId: x, quiescent: false }]);
    expect(r.oms.orders().map((order) => [order.state, order.venueOrderId, order.filledShares])).toEqual([["CANCELED", x, "0"]]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1, liveness) once a sound run has classified the order (here: tracked, canceled, nothing filled), the watch ends: it is no longer read by id", async () => {
    const { r, x, reads } = await seenOnce(readFails, cancel);
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(reads).toContain(x);
    reads.length = 0;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(true);
    expect(reads).not.toContain(x);
  });

  it("(D-O1, V1, restart) the same after a restart: the in-memory record is gone, the journal's names it, and it is read by id", async () => {
    const { r, x, attempt } = await seenOnce(readFails, cancel);
    const again = await restart(r);
    const reads: string[] = [];
    r.u.world.faults = {
      readOrder: (id, answer) => {
        reads.push(id);
        return answer();
      },
    };
    expect(await reconcileRounds(again, 4)).toBe(true);
    expect(reads).toContain(x);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1, V2) its by-id read failed in run 1, and it fills while the trades read and the holdings lag: found PRESENT with its match, never ABSENT; held", async () => {
    const collateral = { before: "" };
    const { r, x, attempt, reads } = await seenOnce(readFails, (inner, salt) => {
      collateral.before = inner.u.world.collateral;
      inner.u.world.match(salt, "1");
    });
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { ownLegs: { venueOrderId: string }[] }[] };
      return { ...read, trades: read.trades.filter((trade) => trade.ownLegs.every((leg) => leg.venueOrderId !== x)) };
    };
    r.u.world.faults.readPositions = (answer) => {
      const read = answer() as { positions: { tokenId: string }[] };
      return { ...read, positions: read.positions.filter((position) => position.tokenId !== YES) };
    };
    r.u.world.faults.readCollateral = (answer) => ({ ...(answer() as object), balance: collateral.before });
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(reads).toContain(x);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect(r.oms.orders()[0]?.venueSizeMatched).toBe("1");
    await expectPaused(r, false, "ORDER_TRADES_INCOMPLETE");
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1, V3) the list showed it with an unrecognised status, and it is canceled: its STATUS_UNRECOGNISED and READ_CONFLICT clear only once it is read again; PRESENT, never ABSENT", async () => {
    const { r, x, attempt, reads, run1 } = await seenOnce((inner) => {
      inner.u.world.faults.listOpenOrders = (answer) => {
        const read = answer() as { orders: Record<string, unknown>[] };
        return { ...read, orders: read.orders.map((order) => ({ ...order, status: "MYSTERY" })) };
      };
    }, cancel);
    expect(run1).toEqual(expect.arrayContaining(["STATUS_UNRECOGNISED", "READ_CONFLICT"]));
    const held = r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "STATUS_UNRECOGNISED" || view.breakClass === "READ_CONFLICT");
    expect(held).toHaveLength(2);
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(reads).toContain(x);
    for (const view of held) expect(resolutions(r, view.breakId)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1, V3) a break naming one venue order is not cleared by a complete run that did not read that order", async () => {
    const { r, x } = await seenOnce((inner) => {
      inner.u.world.faults.listOpenOrders = (answer) => {
        const read = answer() as { orders: Record<string, unknown>[] };
        return { ...read, orders: read.orders.map((order) => ({ ...order, status: "MYSTERY" })) };
      };
    }, cancel);
    const held = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "STATUS_UNRECOGNISED");
    // Its by-id read keeps failing: that run is not complete, and nothing about the order is cleared.
    readFails(r, x);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "STATUS_UNRECOGNISED");
    expect(resolutions(r, held?.breakId)).toEqual([]);
    expect(r.u.accepted).toEqual([]);
  });

  it("(D-O1, V4) an ambiguity whose candidates are all canceled stays an ambiguity: both read by id in every run, never answered, never cleared", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const x = r.u.world.orders.get(r.u.world.receipts.at(-1) as string)?.venueOrderId as string;
    const twin = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    expect(await reconcileRounds(r, 3)).toBe(false);
    const hold = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "SIGNED_IDENTITY_AMBIGUOUS");
    expect(hold?.detail).toContain(twin.venueOrderId);
    r.u.world.cancel(x);
    r.u.world.cancel(twin.venueOrderId);
    const reads: string[] = [];
    r.u.world.faults = {
      readOrder: (id, answer) => {
        reads.push(id);
        return answer();
      },
    };
    expect(await reconcileRounds(r, 4)).toBe(false);
    await expectPaused(r, false, "SIGNED_IDENTITY_AMBIGUOUS");
    expect(reads).toEqual(expect.arrayContaining([x, twin.venueOrderId]));
    expect(resolutions(r, hold?.breakId)).toEqual([]);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1, V5) run 1 is unsound only because the trades read failed; the order it listed is canceled: read by id, PRESENT, never ABSENT", async () => {
    const { r, x, attempt, reads, run1 } = await seenOnce((inner) => {
      inner.u.world.faults.listTrades = () => {
        throw new Error("timeout");
      };
    }, cancel);
    expect(run1).toContain("READ_MISSING");
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(reads).toContain(x);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1, V5, restart) the same after a restart: the journal's ORDER_UNRESOLVED record alone names the order, and it is read by id", async () => {
    const { r, x, attempt } = await seenOnce((inner) => {
      inner.u.world.faults.listTrades = () => {
        throw new Error("timeout");
      };
    }, cancel);
    const again = await restart(r);
    const reads: string[] = [];
    r.u.world.faults = {
      readOrder: (id, answer) => {
        reads.push(id);
        return answer();
      },
    };
    expect(await reconcileRounds(again, 4)).toBe(true);
    expect(reads).toContain(x);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1) a seen order its by-id read no longer finds is a contradiction (READ_CONFLICT): nothing is answered, never ABSENT, until it is found", async () => {
    const { r, x, attempt } = await seenOnce(readFails, cancel);
    r.u.world.faults.readOrder = (id, answer) => (id === x ? { route: "/data/order", found: false } : answer());
    expect(await reconcileRounds(r, 3)).toBe(false);
    await expectPaused(r, false, "READ_CONFLICT");
    expect(r.p.journal.unresolvedBreaks().map((view) => view.detail)).toContainEqual(expect.stringContaining(`venue order ${x} was seen by an earlier read, but its by-id read does not find it`));
    expect(r.u.accepted).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
  });

  it("(D-O1) a STALE run concludes nothing, but the orders its reads showed are kept: read by id later, PRESENT, never ABSENT", async () => {
    const { r, x, attempt, reads, run1 } = await seenOnce((inner) => {
      inner.u.world.faults.onRead = () => {
        inner.u.clock.t += 600; // the reads take longer than the 2000 ms bound
      };
    }, cancel);
    expect(run1).toContain("READ_STALE");
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(reads).toContain(x);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1) the in-memory record covers a journal write that failed: the order is still read by id, PRESENT, never ABSENT", async () => {
    const refuse = { watch: true };
    const { r, x, attempt, reads } = await (async () => {
      const inner = await ready({
        seams: {
          journal: (real) => ({
            get faulted() {
              return real.faulted;
            },
            get runningRunId() {
              return real.runningRunId;
            },
            ruleOf: (breakClass) => real.ruleOf(breakClass),
            releaseAcknowledgesSubject: (breakClass) => real.releaseAcknowledgesSubject(breakClass),
            breaks: () => real.breaks(),
            unresolvedBreaks: () => real.unresolvedBreaks(),
            evidence: () => real.evidence(),
            append: async (event) => {
              const record = event as { kind: string; subjectKey?: string };
              // The journal refuses the record that would name the order (a refusal, not a fault): only memory has it.
              if (refuse.watch && record.kind === "BREAK_OPENED" && record.subjectKey?.includes("venue-order") === true) {
                return { ok: false, refusal: { code: "RECON_TEST_REFUSED", message: "refused by the test" } };
              }
              return real.append(event);
            },
          }),
        },
      });
      inner.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
      const id = (await submitOne(inner.oms)) as string;
      const venueOrderId = inner.u.world.orders.get(inner.u.world.receipts.at(-1) as string)?.venueOrderId as string;
      // Run 1's reads are unsound only because the trades read fails: the order is seen in the list, nowhere else.
      inner.u.world.faults.listTrades = () => {
        throw new Error("timeout");
      };
      await inner.p.coordinator.reconcile();
      refuse.watch = false;
      expect(inner.p.journal.breaks().some((view) => view.subjectKey.includes("venue-order"))).toBe(false);
      inner.u.world.cancel(venueOrderId);
      const log: string[] = [];
      inner.u.world.faults = {
        readOrder: (readId, answer) => {
          log.push(readId);
          return answer();
        },
      };
      return { r: inner, x: venueOrderId, attempt: id, reads: log };
    })();
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(reads).toContain(x);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("(D-O1, N1-F) an order of the account no attempt can own, seen in run 1 (its by-id read failed) and canceled: read by id, UNATTRIBUTED, its market halted", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "2" });
    readFails(r, foreign.venueOrderId);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_MISSING");
    r.u.world.cancel(foreign.venueOrderId);
    const reads: string[] = [];
    r.u.world.faults = {
      readOrder: (id, answer) => {
        reads.push(id);
        return answer();
      },
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "ORDER_UNATTRIBUTED");
    expect(reads).toContain(foreign.venueOrderId);
    const quarantined = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_UNATTRIBUTED");
    expect(quarantined).toMatchObject({ status: "QUARANTINED", marketId: MARKET });
    expect(r.u.halts.some((halt) => halt.breakId === quarantined?.breakId && halt.marketId === MARKET)).toBe(true);
  });
});

describe("WP-290 acceptance 1: a read problem keyed by one trade is cleared only by a run whose trades read showed that trade (r3, D-A2)", () => {
  it("(D-A2, R3-A) after a restart, a stale settlement opens READ_REGRESSION on the trade; a complete run whose trades read omits the trade does not clear it; the real read does", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4", { status: "CONFIRMED" });
    expect(await reconcileRounds(r, 6)).toBe(true);
    const again = await restart(r);
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: Record<string, unknown>[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, status: "MATCHED" })) };
    };
    await expectPaused(again, (await again.p.coordinator.reconcile()).resumed, "READ_REGRESSION");
    const regression = again.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_REGRESSION");
    expect(regression?.subjectKey).toContain("trade");
    // A complete, consistent trades read that does not show the trade at all: it did not look at it.
    r.u.world.faults.listTrades = (answer) => ({ ...(answer() as object), trades: [] });
    await expectPaused(again, (await again.p.coordinator.reconcile()).resumed, "READ_REGRESSION");
    expect(resolutions(again, regression?.breakId)).toEqual([]);
    expect(again.p.journal.breaks().find((view) => view.breakId === regression?.breakId)?.status).toBe("OPEN");
    // The read shows the trade again, at its real settlement: cleared, and trading resumes.
    r.u.world.faults = {};
    expect(await reconcileRounds(again, 3)).toBe(true);
    expect(resolutions(again, regression?.breakId)).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
  });

  it("(D-A2) an unrecognised status on a trade is not cleared by a run whose trades read omits that trade", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "1" });
    const trade = r.u.world.match(foreign.salt, "1", { status: "MATCHED_NOT_BROADCASTED" });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "STATUS_UNRECOGNISED");
    const held = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "STATUS_UNRECOGNISED");
    expect(held?.subjectKey).toContain(trade?.venueTradeId ?? "?");
    r.u.world.faults.listTrades = (answer) => ({ ...(answer() as object), trades: [] });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "STATUS_UNRECOGNISED");
    expect(resolutions(r, held?.breakId)).toEqual([]);
  });
});
