/**
 * WP-290 r9: the round-9 joint report's reproductions (Claude Opus and Codex gpt-6-astra, `reconcile-r9/joint.md`),
 * kept as named regressions, each with its control. Every finding pin fails on e3cbae3 on a BEHAVIOURAL assertion
 * (a resume, an answer accepted, a fill booked, a quarantine missing, a record never journaled), and passes here.
 *
 * - WP290-CX-R9-01: an unusable trades answer dropped a readable trade identity: a leg that failed validation kept
 *   only its order id, and a legless row (its ownership undetermined) of an incomplete answer left nothing. A later
 *   lagging complete answer omitting the trade then resolved the answer-level read break and resumed.
 * - WP290-V9-UNFOLDED-TERMINAL: a terminal status a VALID, COMPLETE trades read showed on a trade with no own leg (its
 *   ownership undetermined) was judged only in that run and never kept: a later stale CONFIRMED read was CONSISTENT,
 *   and the account resumed (an unknown submission answered PRESENT, its fill delivered), with no SETTLEMENT_FAILED.
 *
 * Both share one root: no trade-level evidence record existed. r9 adds one (`TRADE`, `evidence.ts`), journaled and
 * replayed: every trade row's identity and status, whatever its legs, from every answer. The units are in
 * `units-r9.test.ts`. Each journal check here is asserted after the behavioural ones, so that on e3cbae3 a pin fails on
 * its behaviour first.
 *
 * PAPER only: every port is the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";

import { YES, boot } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

type Row = Record<string, unknown>;
type TradeRow = Row & { readonly venueTradeId: string; readonly ownLegs: Row[] };

/** The same universe, after a restart (a fresh process over what survives). */
async function restarted(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

/** Release every QUARANTINED break (an operator acknowledging everything presented); returns how many. */
async function releaseAll(r: Ready, reason: string): Promise<number> {
  let released = 0;
  for (const view of r.p.journal.unresolvedBreaks()) {
    if (view.status !== "QUARANTINED") continue;
    if ((await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason })).ok) released += 1;
  }
  return released;
}

function fills(r: Ready): string[] {
  return r.u.store.snapshotSync().fills.map((fill) => fill.venueTradeId);
}

function unresolved(r: Ready, breakClass: string, id: string): { readonly detail: string } | undefined {
  return r.p.journal.unresolvedBreaks().find((view) => view.breakClass === breakClass && view.subjectKey === compositeKey(breakClass, "trade", id));
}

/** The TRADE records the journal holds for one trade: [source, provenance, status]. */
function tradeRecords(r: Ready, tradeId: string): (string | null)[][] {
  return r.p.journal
    .evidence()
    .filter((record) => record.evidenceKind === "TRADE" && record.venueTradeId === tradeId)
    .map((record) => [record.source, record.provenance, record.status]);
}

/** How the faulty trades answer shows the second trade (CX-R9-01's shapes, and the controls). */
type Shape = "VALID" | "MALFORMED_FEE" | "MALFORMED_TIME" | "PARTIAL_NO_OWN_LEG" | "COMPLETE_NO_OWN_LEG";

function shaped(shape: Shape, row: TradeRow): TradeRow {
  switch (shape) {
    case "VALID":
      return row;
    case "MALFORMED_FEE":
      return { ...row, ownLegs: row.ownLegs.map((leg) => ({ ...leg, feeAmount: "bad" })) };
    case "MALFORMED_TIME":
      return { ...row, ownLegs: row.ownLegs.map((leg) => ({ ...leg, matchedAt: "yesterday" })) };
    case "PARTIAL_NO_OWN_LEG":
    case "COMPLETE_NO_OWN_LEG":
      return { ...row, ownershipUndetermined: true, ownLegs: [] };
  }
}

/**
 * astra's CX-R9-01 setup: a tracked order matched once (its fill held), then matched again. Every read but the trades
 * read lags (a snapshot from before the second match); one trades answer shows the second trade in `shape`. Returns the
 * process, both trades and the trades answer from before the second match.
 */
async function trackedSecondMatch(shape: Shape): Promise<{ r: Ready; first: string; second: string; oldTrades: unknown }> {
  const r = await ready();
  await submitOne(r.oms);
  expect(await reconcileRounds(r, 3)).toBe(true);
  const salt = r.u.world.receipts.at(-1) as string;
  const first = r.u.world.match(salt, "0.4");
  expect(await reconcileRounds(r, 3)).toBe(true);
  const port = r.u.world.readPort();
  const open = (await port.listOpenOrders()) as { orders: Row[] };
  const oldTrades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  const second = r.u.world.match(salt, "0.4");
  if (first === undefined || second === undefined) throw new Error("no match");
  r.u.world.faults.listOpenOrders = () => open;
  r.u.world.faults.readOrder = (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] });
  r.u.world.faults.readPositions = () => positions;
  r.u.world.faults.readCollateral = () => collateral;
  r.u.world.faults.listTrades = (answer) => {
    const read = answer() as { trades: TradeRow[] };
    return {
      ...read,
      complete: shape !== "PARTIAL_NO_OWN_LEG",
      trades: read.trades.map((entry) => (entry.venueTradeId === second.venueTradeId ? shaped(shape, entry) : entry)),
    };
  };
  return { r, first: first.venueTradeId, second: second.venueTradeId, oldTrades };
}

describe("WP-290 r9 (WP290-CX-R9-01): a readable trade identity of an unusable trades answer is kept, and no later omission discharges it", () => {
  const shapes: readonly { readonly shape: Shape; readonly source: string; readonly provenance: string }[] = [
    { shape: "MALFORMED_FEE", source: "TRADES_ROW_ID", provenance: "NAMED" },
    { shape: "MALFORMED_TIME", source: "TRADES_ROW_ID", provenance: "NAMED" },
    { shape: "PARTIAL_NO_OWN_LEG", source: "TRADES_ROW_PARTIAL", provenance: "SHOWN" },
  ];
  for (const { shape, source, provenance } of shapes) {
    for (const withRestart of [false, true]) {
      it(`(R9-01, tracked, ${shape}${withRestart ? ", a restart" : ""}) the second trade of a tracked order, carried only by an unusable answer, then a lagging snapshot: never resumed while it lags; once the reads catch up, both fills, resumed`, async () => {
        const setup = await trackedSecondMatch(shape);
        let r = setup.r;
        expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
        const journaled = tradeRecords(r, setup.second);
        const legs = r.p.journal.evidence().filter((record) => record.evidenceKind === "LEG" && record.venueTradeId === setup.second);
        r.u.world.faults.listTrades = () => setup.oldTrades;
        if (withRestart) r = await restarted(r);
        expect(await reconcileRounds(r, 5)).toBe(false);
        expect(unresolved(r, "READ_CONFLICT", setup.second)?.detail).toContain("without identifying all of its own legs");
        // The identity was journaled (and so replayed), with its status as read: never its economics.
        expect(journaled).toEqual([[source, provenance, "CONFIRMED"]]);
        expect(legs).toEqual([]);
        expect(fills(r)).toEqual([setup.first]);
        expect(r.u.violations).toEqual([]);
        // The reads catch up: the trade is shown with its own legs, its fill delivered, and the account resumes.
        r.u.world.faults = {};
        expect(await reconcileRounds(r, 5)).toBe(true);
        expect(fills(r).sort()).toEqual([setup.first, setup.second].sort());
        expect(unresolved(r, "READ_CONFLICT", setup.second)).toBeUndefined();
        expect(r.u.violations).toEqual([]);
      });
    }
  }

  it("(R9-01, control: a valid leg) the same lag with the second trade shown in full: held by its shown leg, as before r9", async () => {
    const setup = await trackedSecondMatch("VALID");
    const r = setup.r;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => setup.oldTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(fills(r)).toEqual([setup.first]);
    expect(r.u.violations).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual([setup.first, setup.second].sort());
  });

  it("(R9-01, control: a legless row in a COMPLETE valid answer) held by the trade's own READ_INCOMPLETE, as before r9 (r9 adds its open identity: `units-r9.test.ts`)", async () => {
    const setup = await trackedSecondMatch("COMPLETE_NO_OWN_LEG");
    const r = setup.r;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    expect(unresolved(r, "READ_INCOMPLETE", setup.second)).toBeDefined();
    r.u.world.faults.listTrades = () => setup.oldTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(unresolved(r, "READ_INCOMPLETE", setup.second)).toBeDefined();
    expect(r.u.violations).toEqual([]);
  });

  for (const withRestart of [false, true]) {
    it(`(R9-01, foreign, a malformed leg${withRestart ? ", a restart" : ""}) a trade on a released foreign order, carried only by a malformed row, then a lagging snapshot: never resumed; once the reads catch up, TRADE_UNATTRIBUTED`, async () => {
      let r = await ready();
      const order = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
      await reconcileRounds(r, 3);
      expect(await releaseAll(r, "acknowledge this foreign order only")).toBeGreaterThan(0);
      expect(await reconcileRounds(r, 2)).toBe(true);
      const port = r.u.world.readPort();
      const open = (await port.listOpenOrders()) as { orders: Row[] };
      const oldTrades = await port.listTrades();
      const positions = await port.readPositions();
      const collateral = await port.readCollateral();
      const trade = r.u.world.match(order.salt, "0.4");
      if (trade === undefined) throw new Error("no match");
      r.u.world.faults = {
        listOpenOrders: () => open,
        readOrder: (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] }),
        readPositions: () => positions,
        readCollateral: () => collateral,
        listTrades: (answer) => {
          const read = answer() as { trades: TradeRow[] };
          return { ...read, trades: read.trades.map((entry) => shaped("MALFORMED_FEE", entry)) };
        },
      };
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      const journaled = tradeRecords(r, trade.venueTradeId);
      r.u.world.faults.listTrades = () => oldTrades;
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(unresolved(r, "READ_CONFLICT", trade.venueTradeId)?.detail).toContain("without identifying all of its own legs");
      expect(journaled).toEqual([["TRADES_ROW_ID", "NAMED", "CONFIRMED"]]);
      expect(r.u.violations).toEqual([]);
      // The reads catch up: the trade is shown in full on an order no one can own: unmatched activity, by its own id.
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 3)).toBe(false);
      const quarantined = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("TRADE_UNATTRIBUTED", trade.venueTradeId, trade.venueOrderId));
      expect(quarantined?.status).toBe("QUARANTINED");
      expect(unresolved(r, "READ_CONFLICT", trade.venueTradeId)).toBeUndefined();
      expect(r.u.violations).toEqual([]);
    });
  }

  it("(R9-01, control: a foreign trade shown in full) the same lag: quarantined TRADE_UNATTRIBUTED and held, as before r9", async () => {
    const r = await ready();
    const order = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    await reconcileRounds(r, 3);
    await releaseAll(r, "acknowledge this foreign order only");
    expect(await reconcileRounds(r, 2)).toBe(true);
    const port = r.u.world.readPort();
    const open = (await port.listOpenOrders()) as { orders: Row[] };
    const oldTrades = await port.listTrades();
    const trade = r.u.world.match(order.salt, "0.4");
    if (trade === undefined) throw new Error("no match");
    r.u.world.faults = { listOpenOrders: () => open, readOrder: (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] }) };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => oldTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(r.u.violations).toEqual([]);
  });
});

describe("WP-290 r9 (WP290-V9-UNFOLDED-TERMINAL): a terminal status shown on a trade with no own leg is durable evidence", () => {
  /** Opus's O2-HARM model: the truth becomes FAILED, a VALID complete read shows it FAILED with no own leg, then a stale CONFIRMED snapshot. */
  const legless = (answer: () => unknown): unknown => {
    const read = answer() as { trades: TradeRow[] };
    return { ...read, trades: read.trades.map((entry) => ({ ...entry, ownershipUndetermined: true, ownLegs: [] })) };
  };
  const kept = (answer: () => unknown): unknown => {
    const read = answer() as { trades: TradeRow[] };
    return { ...read, trades: read.trades.map((entry) => ({ ...entry, ownershipUndetermined: true })) };
  };
  function stale(r: Ready, position: string, collateral: string): void {
    r.u.world.faults = {
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.map((entry) => ({ ...entry, status: "CONFIRMED" })) };
      },
      readPositions: (answer) => {
        const read = answer() as { positions: Row[] };
        return { ...read, positions: [...read.positions.filter((entry) => entry["tokenId"] !== YES), { tokenId: YES, size: position }] };
      },
      readCollateral: (answer) => ({ ...(answer() as Row), balance: collateral }),
    };
  }

  for (const earlier of [true, false]) {
    for (const withRestart of [false, true]) {
      it(`(V9, an unknown submission${earlier ? ", an earlier CONFIRMED read" : ""}${withRestart ? ", a restart" : ""}) the trade FAILS; a valid read shows it FAILED with no own leg; a stale CONFIRMED snapshot: never answered PRESENT, never resumed`, async () => {
        let r = await ready();
        r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
        await submitOne(r.oms);
        const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
        if (trade === undefined) throw new Error("no match");
        const position = r.u.world.positions.get(YES) ?? "0";
        const collateral = r.u.world.collateral;
        if (earlier) {
          r.u.world.faults.listTrades = (answer) => ({ ...(answer() as Row), complete: false });
          expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
        }
        r.u.world.failTrade(trade);
        r.u.world.faults = { listTrades: legless };
        expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
        const journaled = tradeRecords(r, trade.venueTradeId);
        stale(r, position, collateral);
        if (withRestart) r = await restarted(r);
        const before = r.u.violations.length;
        expect(await reconcileRounds(r, 5)).toBe(false);
        expect(r.u.accepted.filter((answer) => answer.verdict === "PRESENT")).toEqual([]);
        expect(fills(r)).toEqual([]);
        expect(r.u.violations.slice(before)).toEqual([]);
        expect(unresolved(r, "READ_CONFLICT", trade.venueTradeId)?.detail).toContain("both CONFIRMED and FAILED");
        // The FAILED the legless row showed was journaled (and so replayed).
        expect(journaled).toContainEqual(["TRADES_ROW_PARTIAL", "SHOWN", "FAILED"]);
      });
    }
  }

  for (const withRestart of [false, true]) {
    it(`(V9, a tracked order${withRestart ? ", a restart" : ""}) its CONFIRMED fill FAILS; a valid read shows it FAILED with no own leg: SETTLEMENT_FAILED for its leg the evidence holds; a stale CONFIRMED snapshot never resumes`, async () => {
      let r = await ready();
      await submitOne(r.oms);
      expect(await reconcileRounds(r, 3)).toBe(true);
      const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
      if (trade === undefined) throw new Error("no match");
      expect(await reconcileRounds(r, 3)).toBe(true);
      const position = r.u.world.positions.get(YES) ?? "0";
      const collateral = r.u.world.collateral;
      r.u.world.failTrade(trade);
      r.u.world.faults = { listTrades: legless };
      r.p.coordinator.trigger("PERIODIC_TIMER");
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      const gate = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("SETTLEMENT_FAILED", trade.venueTradeId, trade.venueOrderId));
      stale(r, position, collateral);
      if (withRestart) r = await restarted(r);
      const before = r.u.violations.length;
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(r.u.violations.slice(before)).toEqual([]);
      expect(unresolved(r, "READ_CONFLICT", trade.venueTradeId)?.detail).toContain("both CONFIRMED and FAILED");
      // The gate the FAILED settlement owes, for the leg the evidence holds (the row showed none).
      expect(gate?.status).toBe("QUARANTINED");
      expect(gate?.detail).toContain("known from its evidence");
    });
  }

  it("(V9, control: the FAILED row keeps its leg, ownership undetermined) held, and SETTLEMENT_FAILED from the leg the row shows, as before r9", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    if (trade === undefined) throw new Error("no match");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const position = r.u.world.positions.get(YES) ?? "0";
    const collateral = r.u.world.collateral;
    r.u.world.failTrade(trade);
    r.u.world.faults = { listTrades: kept };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    const gate = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("SETTLEMENT_FAILED", trade.venueTradeId, trade.venueOrderId));
    expect(gate?.status).toBe("QUARANTINED");
    expect(gate?.detail).not.toContain("known from its evidence");
    stale(r, position, collateral);
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(r.u.violations).toEqual([]);
  });
});

describe("WP-290 r9 (the P9-C observation, not a finding): a not-found quarantine names the trades it covers", () => {
  it("(P9-C) the stream names a trade on a venue order the venue's by-id read does not find: the ORDER_NOT_FOUND_BY_ID detail lists the trade by its id", async () => {
    const r = await ready();
    r.p.coordinator.onUserStreamOutput({
      kind: "TRADE",
      oms: {
        fills: [],
        settlements: [{ venueTradeId: "trade-ghost", venueOrderId: "venue-ghost", status: "CONFIRMED", transactionHash: `0x${"9".repeat(64)}`, observedAt: "2026-10-03T00:00:01Z" }],
        shortfalls: [],
      },
    });
    await r.p.coordinator.settled();
    expect(await reconcileRounds(r, 2)).toBe(false);
    const ghost = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("ORDER_NOT_FOUND_BY_ID", "venue-ghost"));
    expect(ghost?.status).toBe("QUARANTINED");
    expect(ghost?.detail).toContain("it covers the trade(s) named on it: trade-ghost");
    expect(await releaseAll(r, "the venue does not show it")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.u.violations).toEqual([]);
  });
});
