/**
 * WP-340, work-plan acceptance 2: "Lost user-stream events reconcile."
 *
 * The REAL WP-280 manager (`createUserStreamManager`, live-shaped context)
 * reads the mock CLOB's user channel through `MockUserChannel`, whose chaos
 * drops, duplicates, delays and reorders the venue's frames and drops the
 * socket at chosen moments. Its outputs go to the REAL WP-290 coordinator,
 * which routes them to the REAL WP-270 OMS; its reads go to the mock CLOB.
 * The venue documents no replay: "Real-time updates do not replace
 * authoritative account reads or replay every change missed during a
 * disconnection" (`verified-2026-09-16.md` §4). So each case asserts:
 *
 * - RECONCILED: after the composition's periodic run (or the run a stream
 *   gap requested), the OMS's orders and fills and the ledger's holdings
 *   equal venue truth (WP-290's `consistencyProblems`, the end-state oracle);
 * - NEVER RESUMED UNDER AMBIGUITY: every resume, in every case, is checked
 *   by WP-290's R1 oracle at that instant; and where the stream KNOWS it lost
 *   something (a socket drop, an unrecognised frame, an event it could not
 *   apply), submissions are paused until a run that read after the loss
 *   passes;
 * - UNMATCHED ACTIVITY BECOMES UNATTRIBUTED: an order, a trade or a holding
 *   no tracked activity explains is quarantined as UNATTRIBUTED (the ledger
 *   books a confirmed holding delta to its UNATTRIBUTED scope), its market or
 *   the account halted, until an operator releases it.
 *
 * A frame that LAGS a read and shows an order LIVE after a read recorded it
 * terminal halts the market (WP340-F1, `findings.test.ts`); where chaos
 * produces it, the recovery driver releases exactly that quarantine (the
 * operator's review) and the oracle still holds everything else.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectLedger } from "../../../packages/ledger/src/index.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import type { PublishedFrame } from "./support/mock-clob.js";
import {
  bootNode,
  liveWorld,
  MARKET,
  PUSD,
  reconcileUntilResumed,
  reconcileUntilResumedOrReviewed,
  YES,
  type LiveNode,
  type LiveWorld,
} from "./support/live-node.js";
import { F1_RELEASES } from "./support/expected-releases.js";
import { recoveryProblems } from "./support/oracle.js";
import type { ChaosVerdict } from "./support/user-channel.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const G = group(34301, { tokenId: YES, plannedShares: "5" });

interface Ready {
  readonly world: LiveWorld;
  readonly node: LiveNode;
  readonly oms: OrderManager;
}

async function ready(): Promise<Ready> {
  const world = await liveWorld();
  world.clob.plannedShares.set(`${G.tokenId}|${G.side}`, G.plannedShares);
  const node = await bootNode(world);
  expect(await reconcileUntilResumed(world, node), "the STARTUP run resumes").toBe(true);
  const oms = node.oms as OrderManager;
  expect((await oms.registerGroup(G)).ok).toBe(true);
  return { world, node, oms };
}

function chaos(r: Ready, policy: (frame: PublishedFrame) => ChaosVerdict, dropAfter: ((frame: PublishedFrame) => boolean) | null = null): void {
  if (r.node.channel === null) throw new Error("no user channel");
  r.node.channel.chaos = { policy, dropAfter, dropCause: "TRANSPORT_ERROR" };
}

function causes(r: Ready): string[] {
  return r.node.outputs.flatMap((output) => (output.kind === "RECONCILIATION_REQUESTED" ? [output.request.cause] : []));
}

async function placeOne(r: Ready, n: number, shares = "1"): Promise<{ readonly salt: string; readonly orderId: string }> {
  const t = ticket(G, { n, shares });
  const submitted = await r.oms.submit(t);
  expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
  return { salt: r.world.clob.receipts.at(-1) as string, orderId: t.orderId };
}

/** The composition's periodic reconciliation (WP-290: PERIODIC_TIMER is the composition's; the coordinator owns no timer). */
async function periodic(r: Ready): Promise<boolean> {
  r.node.coordinator.trigger("PERIODIC_TIMER");
  return reconcileUntilResumedOrReviewed(r.world, r.node);
}

/**
 * The end-state oracle, and the recovery driver's record (J1, WP-340 r1): exactly `f1` WP340-F1 releases (0 unless
 * the case is F1's route 2), and no halting alert the driver refused.
 */
function expectReconciled(label: string, r: Ready, resumed: boolean, f1 = 0): void {
  expect(recoveryProblems(r.world, r.node, resumed), label).toEqual([]);
  expect(r.world.findings.map((entry) => entry.finding), `${label}: WP340-F1 releases`).toEqual(Array.from({ length: f1 }, () => "WP340-F1"));
  expect(r.world.refusedReleases, `${label}: halts the driver refused`).toEqual([]);
}

describe("WP-340 acceptance 2: lost user-stream events reconcile (the real WP-280 manager, chaos on its socket)", () => {
  it("DROPPED: a fill whose every frame is lost is invisible to the stream; the periodic run reads it and the OMS and the ledger equal the venue", async () => {
    const r = await ready();
    const { salt, orderId } = await placeOne(r, 1);
    await r.world.time.advance(0);
    chaos(r, (frame) => (frame.type === "PLACEMENT" ? "DELIVER" : "DROP"));
    r.world.clob.match(salt, "0.4");
    await r.world.time.advance(0);
    // No replay and no request: nothing in the stream says anything was missed.
    expect(r.oms.order(orderId)?.filledShares).toBe("0");
    expect(r.node.channel?.dropped.length).toBeGreaterThanOrEqual(3);
    expect(causes(r)).toEqual(["SUBSCRIPTION_STARTED"]);
    const resumed = await periodic(r);
    expect(r.oms.order(orderId)?.filledShares).toBe("0.4");
    expectReconciled("dropped fill", r, resumed);
  });

  it("DROPPED: a CANCELLATION the venue made (an emergency cancel) is lost; the periodic run reads the order by id (E-14: absent from the open list is not proof) and the OMS closes it", async () => {
    const r = await ready();
    const { salt, orderId } = await placeOne(r, 2);
    await r.world.time.advance(0);
    chaos(r, () => "DROP");
    r.world.clob.cancel(r.world.clob.venueOrderIdOf(salt));
    await r.world.time.advance(0);
    expect(r.oms.order(orderId)?.state).toBe("LIVE");
    const resumed = await periodic(r);
    expect(r.oms.order(orderId)?.state).toBe("CANCELED");
    expect(r.oms.order(orderId)?.reservation.released).toBe(true);
    expectReconciled("dropped cancellation", r, resumed);
  });

  it("DUPLICATED: every frame twice; each fill is recorded once and the ledger books each trade once", async () => {
    const r = await ready();
    chaos(r, () => "DUPLICATE");
    const { salt, orderId } = await placeOne(r, 3, "2");
    r.world.clob.match(salt, "0.5");
    r.world.clob.match(salt, "1.5");
    await r.world.time.advance(0);
    const resumed = await periodic(r);
    expect(r.oms.order(orderId)).toMatchObject({ state: "FILLED", filledShares: "2" });
    const booked = r.world.u.ledger.transactions().filter((entry) => entry.transaction.eventType === "TRADE_PRINCIPAL");
    expect(booked).toHaveLength(2);
    expect((r.node.channel?.delivered.length ?? 0) > r.world.clob.frames.length).toBe(true);
    expectReconciled("duplicated frames", r, resumed);
  });

  it("REORDERED: a trade's settlement before its match, an UPDATE overtaking the PLACEMENT; the reads settle every fill exactly", async () => {
    const r = await ready();
    // Hold the PLACEMENT and every MATCHED trade frame back; everything else overtakes them.
    chaos(r, (frame) => (frame.type === "PLACEMENT" || frame.type === "MATCHED" ? { delayMs: 2_000 } : "DELIVER"));
    const { salt, orderId } = await placeOne(r, 4, "2");
    r.world.clob.match(salt, "0.5");
    await r.world.time.advance(3_000);
    const resumed = await periodic(r);
    expect(r.oms.order(orderId)?.filledShares).toBe("0.5");
    expectReconciled("reordered frames", r, resumed);
  });

  it("DELAYED past a read (WP340-F1's second route): the stale LIVE halts the market; nothing resumes until the operator's review; then the account equals the venue", async () => {
    const r = await ready();
    chaos(r, (frame) => (frame.type === "PLACEMENT" ? { delayMs: 20_000 } : "DELIVER"));
    const { salt } = await placeOne(r, 5);
    r.world.clob.match(salt, "1");
    expect(await periodic(r)).toBe(true);
    await r.world.time.advance(21_000);
    r.node.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileUntilResumed(r.world, r.node, 3), "the stale frame holds the account").toBe(false);
    const resumed = await reconcileUntilResumedOrReviewed(r.world, r.node);
    expectReconciled("delayed past a read", r, resumed, F1_RELEASES.streamNamed);
  });

  it("the SOCKET DROPS at the worst moment (right after the PLACEMENT, before the fill): the manager reconnects and asks; submissions pause until a run that read after the loss passes", async () => {
    const r = await ready();
    chaos(r, () => "DELIVER", (frame) => frame.type === "PLACEMENT");
    const { salt, orderId } = await placeOne(r, 6);
    await r.world.time.advance(0);
    r.world.clob.match(salt, "0.7");
    // The fill's frames are published while the socket is down: never delivered, never replayed.
    expect(r.node.channel?.openConnections()).toBe(0);
    expect(r.oms.order(orderId)?.filledShares).toBe("0");
    // The manager's own loss request reached the coordinator: it holds, and a submission is refused.
    expect(causes(r)).toContain("TRANSPORT_ERROR");
    expect(r.oms.paused).toBe(true);
    expect((await r.oms.submit(ticket(G, { n: 60, shares: "1" }))).ok).toBe(false);
    // Reconnect (the manager's backoff), resubscribe, reconcile.
    await r.world.time.advance(5_000);
    expect(causes(r)).toContain("RESUBSCRIBED");
    const resumed = await reconcileUntilResumedOrReviewed(r.world, r.node);
    expect(r.oms.order(orderId)?.filledShares).toBe("0.7");
    expectReconciled("socket drop", r, resumed);
  });

  it("the SOCKET DROPS DURING a reconciliation run: the loss arrives as work during the run, which therefore does not resume on its reads; a later run does, consistent", async () => {
    const r = await ready();
    const { salt } = await placeOne(r, 7);
    await r.world.time.advance(0);
    let dropped = false;
    r.world.clob.faults.onRead = (name) => {
      if (name === "listTrades" && !dropped) {
        dropped = true;
        // The venue fills the order and the socket drops while the run is reading.
        r.world.clob.match(salt, "1");
        r.node.channel?.dropSocket("SERVER_ERROR");
      }
    };
    r.node.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.node.coordinator.reconcile();
    expect(dropped).toBe(true);
    // The run that was reading when the loss arrived did not resume on those reads.
    expect(report.runs[0]?.resumed ?? false).toBe(false);
    delete r.world.clob.faults.onRead;
    await r.world.time.advance(5_000);
    const resumed = await reconcileUntilResumedOrReviewed(r.world, r.node);
    expect(r.world.u.violations).toEqual([]);
    expectReconciled("drop during a run", r, resumed);
  });

  it("an UNRECOGNISED frame requests reconciliation (WP-280), pauses submissions, and the run that follows resumes a consistent account", async () => {
    const r = await ready();
    const { salt } = await placeOne(r, 8);
    await r.world.time.advance(0);
    r.world.clob.match(salt, "0.25");
    // A frame the venue never documented: the manager neither guesses nor drops it.
    if (r.node.channel === null) throw new Error("no channel");
    r.node.channel.inject('{"event_type":"order","type":"MYSTERY","id":"venue-unknown"}');
    await r.world.time.advance(0);
    expect(causes(r)).toContain("UNRECOGNIZED_MESSAGE");
    expect(r.oms.paused).toBe(true);
    const resumed = await reconcileUntilResumedOrReviewed(r.world, r.node);
    expectReconciled("unrecognised frame", r, resumed);
  });
});

describe("WP-340 acceptance 2: unmatched activity becomes UNATTRIBUTED, with its frames lost", () => {
  it("an ORDER placed outside the OMS, its frames dropped: ORDER_UNATTRIBUTED, its market halted, submissions paused until an operator releases it", async () => {
    const r = await ready();
    chaos(r, () => "DROP");
    const foreign = r.world.clob.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "2" });
    const resumed = await periodic(r);
    expect(resumed).toBe(false);
    const view = r.node.journal.unresolvedBreaks().find((entry) => entry.breakClass === "ORDER_UNATTRIBUTED");
    expect(view).toMatchObject({ status: "QUARANTINED", scope: "MARKET", marketId: MARKET });
    expect(view?.detail).toContain(foreign.venueOrderId);
    expect(r.world.u.halts.some((halt) => halt.breakId === view?.breakId && halt.marketId === MARKET)).toBe(true);
    expect((await r.oms.submit(ticket(G, { n: 70, shares: "1" }))).ok).toBe(false);
    // The driver does not release an UNATTRIBUTED quarantine: only WP340-F1 is its to release (J1).
    expect(r.world.findings).toEqual([]);
    expect((await r.node.coordinator.releaseQuarantine({ breakId: view?.breakId ?? "", operatorRef: "operator-1", reason: "a manual order, known" })).ok).toBe(true);
    expect(await reconcileUntilResumed(r.world, r.node)).toBe(true);
  });

  it("a FILL on that foreign order, its frames dropped: TRADE_UNATTRIBUTED; nothing is attributed to a strategy", async () => {
    const r = await ready();
    chaos(r, () => "DROP");
    const foreign = r.world.clob.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "1" });
    const trade = r.world.clob.match(foreign.salt, "1");
    expect(await periodic(r)).toBe(false);
    const view = r.node.journal.unresolvedBreaks().find((entry) => entry.breakClass === "TRADE_UNATTRIBUTED");
    expect(view).toMatchObject({ status: "QUARANTINED", marketId: MARKET });
    expect(view?.detail).toContain(trade?.venueTradeId ?? "?");
    expect(r.oms.orders().every((order) => order.filledShares === "0")).toBe(true);
    expect(r.world.findings).toEqual([]);
  });

  it("a HOLDING delta no activity explains (tokens and collateral arriving): confirmed, booked to UNATTRIBUTED in the real ledger, halted, paused", async () => {
    const r = await ready();
    r.world.clob.adjustPosition(YES, "3");
    r.world.clob.adjustCollateral("25");
    expect(await periodic(r)).toBe(false);
    await r.world.time.advance(r.world.u.policy.holdingConfirmationMs);
    r.node.coordinator.trigger("PERIODIC_TIMER");
    await r.node.coordinator.reconcile();
    const classes = r.node.journal.unresolvedBreaks().map((entry) => entry.breakClass);
    expect(classes).toEqual(expect.arrayContaining(["POSITION_UNATTRIBUTED", "BALANCE_UNATTRIBUTED"]));
    const arrivals = projectLedger(r.world.u.ledger).unattributedActivity;
    expect(arrivals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: YES, amount: "3", haltRequired: true }),
        expect.objectContaining({ assetId: PUSD, amount: "25", haltRequired: true }),
      ]),
    );
    expect(r.oms.paused).toBe(true);
    expect(r.world.findings).toEqual([]);
  });
});
