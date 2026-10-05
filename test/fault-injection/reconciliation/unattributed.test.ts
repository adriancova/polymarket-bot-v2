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

import { ACCOUNT, Killed, MARKET, MARKET_NO, NO, PUSD, YES, boot, ledgerHoldings, reconcileUntilResumed, universe, type KillPlan, type Process, type Universe } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, submitOne, type Ready } from "./support/scenario.js";

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

  it("a delta seen again before the confirmation time has passed is not booked yet", async () => {
    const r = await ready();
    r.u.world.adjustPosition(YES, "3");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    r.u.clock.t += r.u.policy.holdingConfirmationMs - 1;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const early = await r.p.coordinator.reconcile();
    await expectPaused(r, early.resumed, "HOLDING_DELTA_UNCONFIRMED");
    expect(corrections(r.u.ledger)).toEqual([]);
    r.u.clock.t += 1;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const confirmed = await r.p.coordinator.reconcile();
    await expectPaused(r, confirmed.resumed, "POSITION_UNATTRIBUTED");
    expect(corrections(r.u.ledger)).toHaveLength(1);
  });

  it("a fill of a TRACKED order the OMS cannot record yet (its fee is not fixed) is never booked as UNATTRIBUTED", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4", { feeAmount: null });
    for (let round = 0; round < 3; round += 1) {
      r.p.coordinator.trigger("PERIODIC_TIMER");
      await r.p.coordinator.reconcile();
      r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
    }
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "FILL_ECONOMICS_UNFIXED");
    expect(corrections(r.u.ledger)).toEqual([]);
    expect(r.u.halts).toEqual([]);
  });

  it("(I-10) a confirmed delta the ledger refuses to book: CORRECTION_FAILED, held; booked by a later run once the ledger takes it", async () => {
    const r = await ready();
    r.u.seams.refuseBooking = true;
    r.u.world.adjustPosition(YES, "3");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    r.u.clock.t += r.u.policy.holdingConfirmationMs;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const refused = await r.p.coordinator.reconcile();
    await expectPaused(r, refused.resumed, "CORRECTION_FAILED");
    expect(corrections(r.u.ledger)).toEqual([]);
    delete r.u.seams.refuseBooking;
    r.u.clock.t += r.u.policy.holdingConfirmationMs;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const booked = await r.p.coordinator.reconcile();
    await expectPaused(r, booked.resumed, "POSITION_UNATTRIBUTED");
    expect(corrections(r.u.ledger)).toHaveLength(1);
  });

  it("(I-10) a halt the halt port cannot take: HALT_DELIVERY_FAILED, held; delivered again by every run", async () => {
    const r = await ready();
    r.u.seams.haltsFail = true;
    r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "2" });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "HALT_DELIVERY_FAILED");
    expect(r.u.halts).toEqual([]);
    delete r.u.seams.haltsFail;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    const quarantined = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_UNATTRIBUTED");
    expect(r.u.halts.some((halt) => halt.breakId === quarantined?.breakId)).toBe(true);
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

describe("WP-290 acceptance 2 (r3, D-A3): every halt obligation of one ledger transaction is its own break, and halts its own market", () => {
  /** One transaction, appended through the real `Ledger.append`, with an UNATTRIBUTED arrival of 3 in each of two markets. */
  function twoMarketArrival(r: Ready): string {
    const id = r.u.ledgerIds();
    const entries = [
      { assetId: YES, marketId: MARKET },
      { assetId: NO, marketId: MARKET_NO },
    ].flatMap(({ assetId, marketId }) => [
      { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "3" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-venue", assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "-3" },
      { scope: "UNATTRIBUTED", accountRef: ACCOUNT, assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "3" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-attribution", assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "-3" },
    ]);
    const appended = r.u.ledger.append({ ledgerTransactionId: id, eventType: "RECONCILIATION_CORRECTION", environment: "PAPER", accountRef: ACCOUNT, source: "internal", occurredAt: "2026-10-03T00:00:00Z", entries });
    expect(appended.ok, JSON.stringify(appended)).toBe(true);
    if (appended.ok) r.u.ledger = appended.value.ledger;
    r.u.world.adjustPosition(YES, "3");
    r.u.world.adjustPosition(NO, "3");
    expect(projectedHoldings(projectLedger(r.u.ledger), ACCOUNT).unattributedArrivals.map((arrival) => [arrival.ledgerTransactionId, arrival.marketId])).toEqual([
      [id, MARKET],
      [id, MARKET_NO],
    ]);
    return id;
  }

  async function release(r: Ready, breakId: string | undefined): Promise<void> {
    expect((await r.p.coordinator.releaseQuarantine({ breakId: breakId ?? "", operatorRef: "operator-1", reason: "this arrival only" })).ok).toBe(true);
  }

  it("(D-A3, R3-C) two markets in one transaction: two breaks, both markets halted; released independently, across a restart", async () => {
    const r = await ready();
    const id = twoMarketArrival(r);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "LEDGER_UNATTRIBUTED_ARRIVAL");
    const breaks = r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "LEDGER_UNATTRIBUTED_ARRIVAL");
    expect(breaks.map((view) => [view.status, view.scope, view.marketId, view.assetId])).toEqual([
      ["QUARANTINED", "MARKET", MARKET, YES],
      ["QUARANTINED", "MARKET", MARKET_NO, NO],
    ]);
    expect(breaks.every((view) => view.detail.includes(id))).toBe(true);
    expect(new Set(r.u.halts.map((halt) => halt.marketId))).toEqual(new Set([MARKET, MARKET_NO]));
    // The operator releases market A's arrival only: market B's still holds, and is still halted.
    const [first, second] = breaks;
    await release(r, first?.breakId);
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakId)).toEqual([second?.breakId]);
    // A restart: the released arrival is acknowledged (not opened again); the other still holds, halted again.
    const p = await boot(r.u);
    const again: Ready = { u: r.u, p, oms: p.oms as Ready["oms"] };
    const haltsBefore = r.u.halts.length;
    expect(await reconcileRounds(again, 2)).toBe(false);
    expect(again.p.journal.unresolvedBreaks().map((view) => view.breakId)).toEqual([second?.breakId]);
    expect(r.u.halts.slice(haltsBefore).some((halt) => halt.breakId === second?.breakId && halt.marketId === MARKET_NO)).toBe(true);
    await release(again, second?.breakId);
    expect(await reconcileRounds(again, 2)).toBe(true);
    // Nothing was booked: the obligations were the ledger's own.
    expect(corrections(r.u.ledger)).toHaveLength(1);
  });

  it("(D-A3) one asset in two markets of one transaction (collateral entries naming two markets): two breaks, both markets halted", async () => {
    const r = await ready();
    const id = r.u.ledgerIds();
    const entries = [MARKET, MARKET_NO].flatMap((marketId) => [
      { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: PUSD, assetKind: "COLLATERAL", marketId, amount: "5" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-venue", assetId: PUSD, assetKind: "COLLATERAL", amount: "-5" },
      { scope: "UNATTRIBUTED", accountRef: ACCOUNT, assetId: PUSD, assetKind: "COLLATERAL", marketId, amount: "5" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-attribution", assetId: PUSD, assetKind: "COLLATERAL", amount: "-5" },
    ]);
    const appended = r.u.ledger.append({ ledgerTransactionId: id, eventType: "RECONCILIATION_CORRECTION", environment: "PAPER", accountRef: ACCOUNT, source: "internal", occurredAt: "2026-10-03T00:00:00Z", entries });
    expect(appended.ok, JSON.stringify(appended)).toBe(true);
    if (appended.ok) r.u.ledger = appended.value.ledger;
    r.u.world.adjustCollateral("10");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "LEDGER_UNATTRIBUTED_ARRIVAL");
    const breaks = r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "LEDGER_UNATTRIBUTED_ARRIVAL");
    expect(breaks.map((view) => [view.marketId, view.assetId])).toEqual([
      [MARKET, PUSD],
      [MARKET_NO, PUSD],
    ]);
    expect(new Set(r.u.halts.map((halt) => halt.marketId))).toEqual(new Set([MARKET, MARKET_NO]));
  });

  it("(D-A3) two obligations equal in transaction, kind, asset and market are two breaks (each its own place)", async () => {
    const r = await ready();
    const id = r.u.ledgerIds();
    const entries = ["1", "2"].flatMap((amount) => [
      { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: YES, assetKind: "OUTCOME_TOKEN", marketId: MARKET, amount },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-venue", assetId: YES, assetKind: "OUTCOME_TOKEN", marketId: MARKET, amount: `-${amount}` },
      { scope: "UNATTRIBUTED", accountRef: ACCOUNT, assetId: YES, assetKind: "OUTCOME_TOKEN", marketId: MARKET, amount },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-attribution", assetId: YES, assetKind: "OUTCOME_TOKEN", marketId: MARKET, amount: `-${amount}` },
    ]);
    const appended = r.u.ledger.append({ ledgerTransactionId: id, eventType: "RECONCILIATION_CORRECTION", environment: "PAPER", accountRef: ACCOUNT, source: "internal", occurredAt: "2026-10-03T00:00:00Z", entries });
    expect(appended.ok, JSON.stringify(appended)).toBe(true);
    if (appended.ok) r.u.ledger = appended.value.ledger;
    r.u.world.adjustPosition(YES, "3");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "LEDGER_UNATTRIBUTED_ARRIVAL");
    const breaks = r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "LEDGER_UNATTRIBUTED_ARRIVAL");
    expect(breaks.map((view) => view.observedValue)).toEqual(["1", "2"]);
    expect(new Set(breaks.map((view) => view.subjectKey)).size).toBe(2);
  });

  it("(r3) a crash between a quarantine's BREAK_OPENED and its BREAK_QUARANTINED: the restarted run that finds it again quarantines it and halts its market", async () => {
    const run = async (plan: KillPlan | null): Promise<{ readonly u: Universe; readonly first: Process }> => {
      const u = universe();
      const first = await boot(u, plan);
      try {
        await reconcileUntilResumed(first, u, 2);
        u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "2" });
        first.coordinator.trigger("PERIODIC_TIMER");
        await first.coordinator.reconcile();
      } catch (error) {
        if (!(error instanceof Killed)) throw error;
      }
      return { u, first };
    };
    const dry = await run(null);
    const opened = dry.u.journalEvents.findIndex((event) => event.kind === "BREAK_OPENED" && event.breakClass === "ORDER_UNATTRIBUTED");
    expect(opened).toBeGreaterThan(0);
    // The k-th journal.append call is the k-th journal event (every append is one port call).
    const appends = dry.first.inc.trace.map((name, index) => [name, index] as const).filter(([name]) => name === "journal.append");
    const at = (appends[opened]?.[1] ?? -1) + 1;
    const { u, first } = await run({ at, phase: "after" });
    expect(first.inc.alive).toBe(false);
    const second = await boot(u);
    const view = (): ReturnType<Process["journal"]["unresolvedBreaks"]>[number] | undefined => second.journal.unresolvedBreaks().find((entry) => entry.breakClass === "ORDER_UNATTRIBUTED");
    expect(view()?.status).toBe("OPEN");
    expect(u.halts).toEqual([]);
    const report = await second.coordinator.reconcile();
    expect(report.resumed).toBe(false);
    expect(view()?.status).toBe("QUARANTINED");
    expect(u.halts.some((halt) => halt.breakId === view()?.breakId && halt.marketId === MARKET)).toBe(true);
  });
});
