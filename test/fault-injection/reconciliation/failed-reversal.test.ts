/**
 * WP-290 r4 (WP290-CX-R4-02): A FAILED FILL EXPLAINS ONLY WHAT THE LEDGER STILL BOOKS OF IT, AND ITS REVERSAL IS
 * OWED UNTIL THE LEDGER BOOKS IT.
 *
 * A FAILED settlement never moved the chain (`world.failTrade` moves the holdings back), and the ledger booked the
 * fill at its match until a compensating reversal cancels it (ADR-006 §5, decision 2; `Ledger.append` accepts a
 * reversal only as the exact negation of the transaction it names). Before r4 every FAILED leg explained its
 * nominal delta forever, so a fully reversed fill concealed a later unrelated movement of the same size, and a
 * release of the FAILED quarantines resumed trading whether or not the reversal was booked.
 *
 * Now: a FAILED leg explains exactly its fill's REMAINING booking (`remainingFillBookings`), and while any remains,
 * `SETTLEMENT_REVERSAL_OWED` holds the account (no release exists for it). Arrivals, departures, a missing
 * reversal, inexact deltas, fees and restarts are pinned here, all with the real `Ledger`. PAPER only.
 */

import { describe, expect, it } from "vitest";

import { negateDecimal } from "../../../packages/decimal/src/index.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";

import { PUSD, YES, boot, bookReversal, ledgerHoldings } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, submitOne, type Ready } from "./support/scenario.js";
import type { VenueTrade } from "./support/world.js";

async function restart(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

function classes(r: Ready): string[] {
  return r.p.journal.unresolvedBreaks().map((view) => view.breakClass);
}

async function releaseAll(r: Ready, reason = "handled"): Promise<number> {
  let released = 0;
  for (const view of r.p.journal.unresolvedBreaks()) {
    if (view.status !== "QUARANTINED") continue;
    expect((await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason })).ok).toBe(true);
    released += 1;
  }
  return released;
}

/** Runs `times` runs, each after the confirmation and quiescence windows passed; `true` if any resumed. */
async function patientRounds(r: Ready, times: number): Promise<boolean> {
  let resumed = false;
  for (let round = 0; round < times; round += 1) {
    r.p.coordinator.trigger("PERIODIC_TIMER");
    resumed = (await r.p.coordinator.reconcile()).resumed || resumed;
    r.u.clock.t += r.u.policy.holdingConfirmationMs + r.u.policy.quiescenceHorizonMs + 1;
  }
  return resumed;
}

/**
 * One BUY of 1 at 0.5, matched 0.4 (MINED), reconciled and resumed (optionally after a CONFIRMED BUY of 1 YES, so
 * the account holds YES before the failure); then the trade FAILS: the holdings move back, the OMS records the
 * failure, and the run that sees it holds.
 */
async function failed(options: { readonly priorYes?: boolean; readonly fee?: string } = {}): Promise<{ r: Ready; trade: VenueTrade }> {
  const r = await ready();
  if (options.priorYes === true) {
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "1", { status: "CONFIRMED" });
    expect(await reconcileRounds(r, 6)).toBe(true);
  }
  await submitOne(r.oms);
  const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4", {
    status: "MINED",
    ...(options.fee === undefined ? {} : { feeAmount: options.fee, feeAssetId: PUSD }),
  }) as VenueTrade;
  expect(await reconcileRounds(r, 6)).toBe(true);
  r.u.world.failTrade(trade);
  r.p.coordinator.trigger("PERIODIC_TIMER");
  await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "SETTLEMENT_REVERSAL_OWED");
  expect(classes(r)).toEqual(expect.arrayContaining(["SETTLEMENT_FAILED", "OMS_HALTING_ALERT"]));
  return { r, trade };
}

/** `failed`, then the operator books the exact reversal and releases every quarantine: the account resumes. */
async function reversed(options: { readonly priorYes?: boolean; readonly fee?: string } = {}): Promise<{ r: Ready; trade: VenueTrade }> {
  const { r, trade } = await failed(options);
  expect(bookReversal(r.u, trade.venueTradeId, trade.venueOrderId)).toBe(options.fee === undefined ? 1 : 2);
  expect(await releaseAll(r)).toBe(2);
  expect(await reconcileRounds(r, 4)).toBe(true);
  expect(r.p.journal.unresolvedBreaks()).toEqual([]);
  expect(oracle(r)).toEqual([]);
  return { r, trade };
}

describe("WP-290 r4 (WP290-CX-R4-02): a fully reversed FAILED fill explains no later movement", () => {
  it("(R4-02, R4-C) a +0.2 collateral arrival after the reversal: BALANCE_UNATTRIBUTED, booked; never resumed until released (three runs, then a restart)", async () => {
    const { r } = await reversed();
    r.u.world.adjustCollateral("0.2");
    expect(await patientRounds(r, 3)).toBe(false);
    const again = await restart(r);
    expect(await patientRounds(again, 1)).toBe(false);
    const booking = again.p.journal.unresolvedBreaks().find((view) => view.breakClass === "BALANCE_UNATTRIBUTED");
    expect(booking).toMatchObject({ status: "QUARANTINED", assetId: PUSD });
    expect(ledgerHoldings(r.u).get(PUSD)).toBe(r.u.world.collateral);
    expect(r.u.world.collateral).toBe("1000.2");
    expect(await releaseAll(again)).toBe(1);
    expect(await reconcileRounds(again, 3)).toBe(true);
    expect(oracle(again)).toEqual([]);
  });

  it("(R4-02, TOKEN-DEPARTURE) an unrelated departure of 0.4 YES after a reversed FAILED BUY of 0.4: POSITION_UNATTRIBUTED, never concealed", async () => {
    const { r } = await reversed({ priorYes: true });
    r.u.world.adjustPosition(YES, "-0.4");
    expect(await patientRounds(r, 3)).toBe(false);
    const booking = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "POSITION_UNATTRIBUTED");
    expect(booking).toMatchObject({ status: "QUARANTINED", assetId: YES });
    expect(ledgerHoldings(r.u).get(YES)).toBe("0.6");
    expect(r.u.world.positions.get(YES)).toBe("0.6");
    const again = await restart(r);
    expect(await reconcileRounds(again, 2)).toBe(false);
    expect(await releaseAll(again)).toBe(1);
    expect(await reconcileRounds(again, 3)).toBe(true);
    expect(oracle(again)).toEqual([]);
  });

  it("(R4-02, INEXACT) a +0.1 arrival after the reversal (not the fill's size) is booked UNATTRIBUTED, never held as in transit forever", async () => {
    const { r } = await reversed();
    r.u.world.adjustCollateral("0.1");
    expect(await patientRounds(r, 3)).toBe(false);
    expect(classes(r)).toEqual(["BALANCE_UNATTRIBUTED"]);
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("HOLDING_IN_TRANSIT_AMBIGUOUS");
    expect(ledgerHoldings(r.u).get(PUSD)).toBe("1000.1");
  });

  it("(R4-02) before the reversal, an unrelated arrival in the same asset is held as ambiguous, never concealed; once the reversal is booked it is booked UNATTRIBUTED", async () => {
    const { r, trade } = await failed();
    r.u.world.adjustCollateral("0.2");
    expect(await patientRounds(r, 3)).toBe(false);
    expect(classes(r)).toContain("HOLDING_IN_TRANSIT_AMBIGUOUS");
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("BALANCE_UNATTRIBUTED");
    bookReversal(r.u, trade.venueTradeId, trade.venueOrderId);
    await releaseAll(r);
    expect(await patientRounds(r, 3)).toBe(false);
    expect(classes(r)).toEqual(["BALANCE_UNATTRIBUTED"]);
    expect(classes(r)).not.toContain("SETTLEMENT_REVERSAL_OWED");
    expect(ledgerHoldings(r.u).get(PUSD)).toBe("1000.2");
  });
});

describe("WP-290 r4 (WP290-CX-R4-02): a release is not a booking: the reversal is owed until the ledger books it", () => {
  it("(R4-02, NO-REVERSAL) every quarantine released without the reversal: SETTLEMENT_REVERSAL_OWED holds (no release exists), after a restart too; booked, the account resumes consistent", async () => {
    const { r, trade } = await failed();
    expect(await releaseAll(r, "released without the reversal")).toBe(2);
    expect(await patientRounds(r, 3)).toBe(false);
    await expectPaused(r, false, "SETTLEMENT_REVERSAL_OWED");
    const owed = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "SETTLEMENT_REVERSAL_OWED");
    expect(owed?.status).toBe("OPEN");
    expect(owed?.detail).toContain(trade.venueTradeId);
    expect((await r.p.coordinator.releaseQuarantine({ breakId: owed?.breakId ?? "", operatorRef: "operator-1", reason: "try" })).ok).toBe(false);
    // The FAILED fill's own difference is explained by what the ledger still books: nothing is booked UNATTRIBUTED.
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toEqual(expect.arrayContaining(["BALANCE_UNATTRIBUTED"]));
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("POSITION_UNATTRIBUTED");
    expect(ledgerHoldings(r.u).get(PUSD)).toBe("999.8");
    const again = await restart(r);
    expect(await patientRounds(again, 2)).toBe(false);
    await expectPaused(again, false, "SETTLEMENT_REVERSAL_OWED");
    expect(bookReversal(r.u, trade.venueTradeId, trade.venueOrderId)).toBe(1);
    expect(await reconcileRounds(again, 3)).toBe(true);
    expect(ledgerHoldings(r.u).get(PUSD)).toBe("1000");
    expect(r.u.world.collateral).toBe("1000");
    expect(oracle(again)).toEqual([]);
  });

  it("(R4-02) a correction that names neither the fill nor one of its transactions does not discharge it: still owed", async () => {
    const { r } = await failed();
    // The actual holdings are corrected by an adjustment that does not name the fill (no fillId, no reversal link):
    // the fill is still booked to the strategy, so the reversal is still owed.
    const principal = r.u.ledger.transactions().find((entry) => entry.transaction.eventType === "TRADE_PRINCIPAL")?.transaction;
    expect(principal?.fillId).toBeDefined();
    if (principal === undefined) return;
    const unnamed: Record<string, unknown> = { ...principal };
    delete unnamed["fillId"];
    const appended = r.u.ledger.append({
      ...unnamed,
      ledgerTransactionId: r.u.ledgerIds(),
      eventType: "MANUAL_ADJUSTMENT",
      source: "internal",
      entries: principal.entries.map((entry) => ({ ...entry, amount: negateDecimal(entry.amount) })),
    });
    expect(appended.ok).toBe(true);
    if (appended.ok) r.u.ledger = appended.value.ledger;
    expect(ledgerHoldings(r.u).get(PUSD)).toBe(r.u.world.collateral);
    await releaseAll(r);
    expect(await patientRounds(r, 3)).toBe(false);
    await expectPaused(r, false, "SETTLEMENT_REVERSAL_OWED");
  });

  it("(R4-02, FEES) a FAILED fill with a fee: reversing the principal alone leaves the fee booked (still owed, it explains the fee only); the fee reversed, it resumes; a fee-sized arrival later is UNATTRIBUTED", async () => {
    const { r, trade } = await failed({ fee: "0.01" });
    expect(ledgerHoldings(r.u).get(PUSD)).toBe("999.79");
    expect(r.u.world.collateral).toBe("1000");
    expect(bookReversal(r.u, trade.venueTradeId, trade.venueOrderId, "TRADE_PRINCIPAL")).toBe(1);
    expect(await releaseAll(r)).toBe(2);
    expect(await patientRounds(r, 3)).toBe(false);
    await expectPaused(r, false, "SETTLEMENT_REVERSAL_OWED");
    // The hold stands (one break, opened when the whole fill was booked); what this run found still booked is the fee alone.
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    const owed = report.runs.flatMap((run) => run.detections).filter((detection) => detection.breakClass === "SETTLEMENT_REVERSAL_OWED");
    expect(owed.map((detection) => detection.detail.split("still books ")[1]?.split(" of its fill")[0])).toEqual([`-0.01 ${PUSD}`]);
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("BALANCE_UNATTRIBUTED");
    expect(bookReversal(r.u, trade.venueTradeId, trade.venueOrderId, "PLATFORM_FEE")).toBe(1);
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(oracle(r)).toEqual([]);
    r.u.world.adjustCollateral("0.01");
    expect(await patientRounds(r, 3)).toBe(false);
    expect(classes(r)).toEqual(["BALANCE_UNATTRIBUTED"]);
  });

  it("(R4-02) the ledger's answer about FAILED fills that omits one, or fails, holds: nothing is judged or booked from it", async () => {
    const { r, trade } = await failed();
    bookReversal(r.u, trade.venueTradeId, trade.venueOrderId);
    await releaseAll(r);
    for (const [variant, seam] of [
      ["omits the fill", () => ({ bookings: [] })],
      ["fails", () => {
        throw new Error("the ledger is unreachable");
      }],
      ["answers twice", (_fills: unknown, real: () => unknown) => {
        const read = real() as { bookings: unknown[] };
        return { bookings: [...read.bookings, ...read.bookings] };
      }],
    ] as const) {
      r.u.seams.remainingBookings = seam as (fills: unknown, real: () => unknown) => unknown;
      r.u.world.adjustCollateral("0.2");
      r.p.coordinator.trigger("PERIODIC_TIMER");
      const report = await r.p.coordinator.reconcile();
      await expectPaused(r, report.resumed, variant === "fails" ? "READ_MISSING" : "READ_MALFORMED");
      expect(r.p.journal.breaks().map((view) => view.breakClass), variant).not.toContain("BALANCE_UNATTRIBUTED");
      r.u.world.adjustCollateral("-0.2");
    }
    delete r.u.seams.remainingBookings;
    expect(await reconcileRounds(r, 3)).toBe(true);
  });

  it("(R4-02) the reversal hold is cleared only by a run that judged the holdings and whose trades read showed the trade", async () => {
    const { r, trade } = await failed();
    await releaseAll(r);
    const owed = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "SETTLEMENT_REVERSAL_OWED");
    expect(owed?.status).toBe("OPEN");
    bookReversal(r.u, trade.venueTradeId, trade.venueOrderId);
    const resolved = (): unknown[] => r.p.journal.events().filter((event) => event.kind === "BREAK_RESOLVED" && event.breakId === owed?.breakId);
    // A run that did not judge the holdings (the order's group token is unknown: its fills are not compared).
    r.u.seams.tokenOfGroup = () => null;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "SETTLEMENT_REVERSAL_OWED");
    expect(resolved()).toEqual([]);
    delete r.u.seams.tokenOfGroup;
    // A complete run whose trades read does not show the FAILED trade (it lags): it did not look at it.
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { venueTradeId: string }[] };
      return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== trade.venueTradeId) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "SETTLEMENT_REVERSAL_OWED");
    expect(resolved()).toEqual([]);
    r.u.world.faults = {};
    // A run that looked at both: cleared, and the account resumes.
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(resolved()).toEqual([expect.objectContaining({ resolution: "NOT_REPRODUCED" })]);
  });

  it("(R4-02) a FAILED trade on an order nothing tracks: nothing was booked, nothing is owed or explained; released, it resumes (no permanent in-transit hold)", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "1" });
    const trade = r.u.world.match(foreign.salt, "0.5", { status: "MINED" }) as VenueTrade;
    r.u.world.failTrade(trade);
    expect(await patientRounds(r, 3)).toBe(false);
    expect(classes(r)).not.toContain("SETTLEMENT_REVERSAL_OWED");
    expect(classes(r)).not.toContain("HOLDING_IN_TRANSIT_AMBIGUOUS");
    expect(classes(r)).toEqual(expect.arrayContaining(["ORDER_UNATTRIBUTED", "TRADE_UNATTRIBUTED"]));
    r.u.world.cancel(foreign.venueOrderId);
    await releaseAll(r, "a manual order; its trade failed");
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });
});
