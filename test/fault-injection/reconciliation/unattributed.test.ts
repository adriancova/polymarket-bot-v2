/**
 * WP-290 acceptance 2: UNMATCHED ACTUAL ACTIVITY BECOMES UNATTRIBUTED
 * (handoff §6 invariant 7, §9.15: "Unexplained activity goes to UNATTRIBUTED
 * and halts the affected market").
 *
 * - ORDERS: an order of the account that no tracked order and no unresolved
 *   attempt can own is an `ORDER_UNATTRIBUTED` break, quarantined, its market
 *   halted, submissions paused until an operator releases it.
 * - TRADES: each trade on such an order is a `TRADE_UNATTRIBUTED` break.
 * - POSITION AND BALANCE DELTAS: a holding delta no activity explains is held
 *   once (`HOLDING_DELTA_UNCONFIRMED`), and, confirmed by a later read, booked
 *   to the ledger's `UNATTRIBUTED` scope by a `RECONCILIATION_CORRECTION`
 *   (the real `Ledger` accepts it, and its projection records an
 *   `ACTUAL_ARRIVAL` with `haltRequired: true`); the token's market (or, for
 *   collateral, the account) is halted and the break quarantined.
 *
 * A released quarantine is acknowledged: the same activity does not reopen it,
 * while new activity does. Booking is crash-safe: a crash between the ledger
 * booking and the journal entry is recovered from the ledger's own halt
 * obligation, and nothing is booked twice.
 */

import { describe, expect, it } from "vitest";

import { projectLedger, projectedHoldings } from "../../../packages/ledger/src/index.js";

import { ACCOUNT, Killed, MARKET, PUSD, YES, boot, ledgerHoldings, reconcileUntilResumed, universe, type KillPlan, type Process, type Universe } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, submitOne } from "./support/scenario.js";

function corrections(ledger: Parameters<typeof projectLedger>[0]): { readonly id: string; readonly eventType: string; readonly entries: readonly { readonly scope: string; readonly assetId: string; readonly amount: string }[] }[] {
  return ledger
    .transactions()
    .filter((appended) => appended.transaction.eventType === "RECONCILIATION_CORRECTION")
    .map((appended) => ({ id: appended.transaction.ledgerTransactionId, eventType: appended.transaction.eventType, entries: appended.transaction.entries }));
}

describe("WP-290 acceptance 2: unmatched actual activity becomes UNATTRIBUTED", () => {
  it("an ORDER no tracked order or unresolved attempt can own: UNATTRIBUTED, market halted, paused until released", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "2" });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "ORDER_UNATTRIBUTED");
    const quarantined = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_UNATTRIBUTED");
    expect(quarantined).toMatchObject({ status: "QUARANTINED", rule: "UNATTRIBUTED_HALT", scope: "MARKET", marketId: MARKET, assetId: YES });
    expect(quarantined?.detail).toContain(foreign.venueOrderId);
    expect(r.u.halts.some((halt) => halt.marketId === MARKET && halt.breakId === quarantined?.breakId)).toBe(true);
    // Released by an operator: acknowledged, not reopened by the same order; the next run must pass on its own.
    const released = await r.p.coordinator.releaseQuarantine({ breakId: quarantined?.breakId ?? "", operatorRef: "operator-1", reason: "manual order, known" });
    expect(released.ok).toBe(true);
    expect(await reconcileRounds(r, 2)).toBe(true);
    // New activity on it is new: a trade on the foreign order is UNATTRIBUTED again.
    r.u.world.match(foreign.salt, "0.5");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const again = await r.p.coordinator.reconcile();
    await expectPaused(r, again.resumed, "TRADE_UNATTRIBUTED");
  });

  it("a TRADE on an order the account placed outside the OMS: UNATTRIBUTED, market halted, paused", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "1" });
    const trade = r.u.world.match(foreign.salt, "1");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "TRADE_UNATTRIBUTED");
    const view = r.p.journal.unresolvedBreaks().find((entry) => entry.breakClass === "TRADE_UNATTRIBUTED");
    expect(view).toMatchObject({ status: "QUARANTINED", scope: "MARKET", marketId: MARKET, observedValue: "1" });
    expect(view?.detail).toContain(trade?.venueTradeId ?? "?");
    expect(r.u.halts.some((halt) => halt.breakId === view?.breakId)).toBe(true);
    // Nothing is attributed to a strategy: the OMS recorded no fill for it.
    expect(r.oms.orders().every((order) => order.filledShares === "0")).toBe(true);
  });

  it("a POSITION delta no activity explains: confirmed, booked to UNATTRIBUTED in the real ledger, market halted", async () => {
    const r = await ready();
    r.u.world.adjustPosition(YES, "3");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const first = await r.p.coordinator.reconcile();
    await expectPaused(r, first.resumed, "HOLDING_DELTA_UNCONFIRMED");
    expect(corrections(r.u.ledger)).toEqual([]);
    r.u.clock.t += r.u.policy.holdingConfirmationMs;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const second = await r.p.coordinator.reconcile();
    await expectPaused(r, second.resumed, "POSITION_UNATTRIBUTED");
    const booked = corrections(r.u.ledger);
    expect(booked).toHaveLength(1);
    expect(booked[0]?.entries.filter((entry) => entry.scope === "UNATTRIBUTED")).toEqual([expect.objectContaining({ assetId: YES, amount: "3" })]);
    const arrivals = projectLedger(r.u.ledger).unattributedActivity;
    expect(arrivals).toEqual([expect.objectContaining({ activityKind: "ACTUAL_ARRIVAL", haltRequired: true, assetId: YES, amount: "3", affectedMarketId: MARKET })]);
    const view = r.p.journal.unresolvedBreaks().find((entry) => entry.breakClass === "POSITION_UNATTRIBUTED");
    expect(view).toMatchObject({ status: "QUARANTINED", marketId: MARKET, resolutionLedgerTransactionId: booked[0]?.id });
    expect(r.u.halts.some((halt) => halt.marketId === MARKET)).toBe(true);
    expect(ledgerHoldings(r.u).get(YES)).toBe("3");
    // Released: the projection now explains the holding, and the booked arrival is acknowledged.
    await r.p.coordinator.releaseQuarantine({ breakId: view?.breakId ?? "", operatorRef: "operator-1", reason: "tokens received from a known transfer" });
    expect(await reconcileRounds(r, 2)).toBe(true);
    expect(corrections(r.u.ledger)).toHaveLength(1);
  });

  it("a negative POSITION delta (tokens the venue no longer shows) is booked with its sign", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "1");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 3)).toBe(true);
    r.u.world.adjustPosition(YES, "-0.25");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    r.u.clock.t += r.u.policy.holdingConfirmationMs;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "POSITION_UNATTRIBUTED");
    expect(corrections(r.u.ledger)[0]?.entries.filter((entry) => entry.scope === "UNATTRIBUTED")).toEqual([expect.objectContaining({ amount: "-0.25" })]);
  });

  it("a BALANCE delta no activity explains: booked to UNATTRIBUTED; the account is halted", async () => {
    const r = await ready();
    r.u.world.adjustCollateral("25");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    r.u.clock.t += r.u.policy.holdingConfirmationMs;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "BALANCE_UNATTRIBUTED");
    const view = r.p.journal.unresolvedBreaks().find((entry) => entry.breakClass === "BALANCE_UNATTRIBUTED");
    expect(view).toMatchObject({ status: "QUARANTINED", scope: "ACCOUNT", marketId: null, assetId: PUSD });
    expect(r.u.halts.some((halt) => halt.breakId === view?.breakId && halt.marketId === null)).toBe(true);
    expect(projectLedger(r.u.ledger).unattributedActivity).toEqual([expect.objectContaining({ assetId: PUSD, amount: "25", haltRequired: true })]);
  });

  it("a delta that changes before it is confirmed is not booked; one that disappears clears", async () => {
    const r = await ready();
    r.u.world.adjustPosition(YES, "3");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    r.u.world.adjustPosition(YES, "1");
    r.u.clock.t += r.u.policy.holdingConfirmationMs;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const changed = await r.p.coordinator.reconcile();
    await expectPaused(r, changed.resumed, "HOLDING_DELTA_UNCONFIRMED");
    expect(corrections(r.u.ledger)).toEqual([]);
    r.u.world.adjustPosition(YES, "-4");
    expect(await reconcileRounds(r, 2)).toBe(true);
    expect(corrections(r.u.ledger)).toEqual([]);
  });

  it("a crash right after the ledger booking, before its journal entry: recovered from the ledger's halt obligation, never booked twice", async () => {
    const run = async (plan: KillPlan | null): Promise<{ readonly u: Universe; readonly first: Process }> => {
      const u = universe();
      const first = await boot(u, plan);
      try {
        await reconcileUntilResumed(first, u, 2);
        u.world.adjustPosition(YES, "2");
        first.coordinator.trigger("PERIODIC_TIMER");
        await first.coordinator.reconcile();
        u.clock.t += u.policy.holdingConfirmationMs;
        first.coordinator.trigger("PERIODIC_TIMER");
        await first.coordinator.reconcile();
      } catch (error) {
        if (!(error instanceof Killed)) throw error;
      }
      return { u, first };
    };
    const dry = await run(null);
    const at = dry.first.inc.trace.indexOf("ledger.book") + 1;
    expect(at).toBeGreaterThan(0);
    const { u, first } = await run({ at, phase: "after" });
    expect(first.inc.alive).toBe(false);
    expect(corrections(u.ledger)).toHaveLength(1);
    expect(u.journalEvents.some((event) => event.kind === "BREAK_OPENED" && event.breakClass === "POSITION_UNATTRIBUTED")).toBe(false);
    const second = await boot(u);
    const report = await second.coordinator.reconcile();
    expect(report.resumed).toBe(false);
    const recovered = second.journal.unresolvedBreaks().find((view) => view.breakClass === "LEDGER_UNATTRIBUTED_ARRIVAL");
    expect(recovered).toMatchObject({ status: "QUARANTINED", scope: "MARKET", marketId: MARKET, assetId: YES });
    expect(second.oms?.paused).toBe(true);
    expect(u.halts.some((halt) => halt.breakId === recovered?.breakId && halt.marketId === MARKET)).toBe(true);
    // Never booked twice: the holding now matches the projection, so nothing more is owed.
    await second.coordinator.reconcile();
    u.clock.t += u.policy.holdingConfirmationMs;
    second.coordinator.trigger("PERIODIC_TIMER");
    await second.coordinator.reconcile();
    expect(corrections(u.ledger)).toHaveLength(1);
    expect(projectedHoldings(projectLedger(u.ledger), ACCOUNT).unattributedArrivals).toHaveLength(1);
  });
});
