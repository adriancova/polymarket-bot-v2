/**
 * WP-290 r8: the round-8 joint report's reproductions (Claude Opus and Codex gpt-6-astra, `reconcile-r8/joint.md`),
 * kept as named regressions, each with its control. Every finding pin fails on bfd40e4 on a BEHAVIOURAL assertion
 * (a resume, an answer accepted, a fill booked, a break resolved or missing), and passes here.
 *
 * - WP290-CX-R8-01: a trade identity the user stream named (a settlement without its fill, refused by the OMS) lost
 *   its obligation once another trade covered the order's matched size, or the order was claimed: the account
 *   resumed with that trade unanswered.
 * - WP290-CX-R8-02: a CONFIRMED-then-FAILED contradiction was cleared by a later read repeating the first terminal
 *   status: PRESENT answered, the fill delivered, resumed.
 * - WP290-V8-ACCOUNTED-WHILE-QUARANTINED (a text fix): the documented "accounted for" rule, pinned as the code keeps
 *   it (a trade's own TRADE_UNATTRIBUTED quarantine, released or not, accounts for it). This one passes on bfd40e4 by
 *   construction: the code did not change, the three texts did.
 *
 * PAPER only: every port is the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";

import { NO, YES, boot } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

type Row = Record<string, unknown>;
type OrderRow = Row & { readonly venueOrderId: string };
type TradeRow = Row & { readonly venueTradeId: string };
type PositionRow = Row & { readonly tokenId: string };

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

function partial(answer: () => unknown): unknown {
  return { ...(answer() as Row), complete: false };
}

/** A WP-280 projection of one trade event whose fill it could not project (a maker leg): its settlement alone. */
function settlementOnly(trade: { readonly venueTradeId: string; readonly venueOrderId: string; readonly transactionHash: string }, status = "CONFIRMED"): unknown {
  return {
    kind: "TRADE",
    oms: {
      fills: [],
      settlements: [{ venueTradeId: trade.venueTradeId, venueOrderId: trade.venueOrderId, status, transactionHash: trade.transactionHash, observedAt: "2026-10-03T00:00:01Z" }],
      shortfalls: [],
    },
  };
}

function fills(r: Ready): string[] {
  return r.u.store.snapshotSync().fills.map((fill) => fill.venueTradeId);
}

function unresolved(r: Ready, breakClass: string, id: string): { readonly detail: string } | undefined {
  return r.p.journal.unresolvedBreaks().find((view) => view.breakClass === breakClass && view.subjectKey === compositeKey(breakClass, "trade", id));
}

describe("WP-290 r8 (WP290-CX-R8-01): a trade identity only the user stream named is answered by a read, or explicitly quarantined", () => {
  for (const withRestart of [false, true]) {
    it(`(R8-01, a replacement id${withRestart ? ", a restart" : ""}) a tracked order's settlement the stream named, then reads showing the same fill under another trade id: never resumed, nothing delivered`, async () => {
      let r = await ready();
      await submitOne(r.oms);
      expect(await reconcileRounds(r, 3)).toBe(true);
      const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
      if (trade === undefined) throw new Error("no match");
      r.p.coordinator.onUserStreamOutput(settlementOnly(trade));
      await r.p.coordinator.settled();
      // The OMS refused it (no fill under that identity): the coordinator journaled it as NAMED evidence.
      expect(r.p.journal.evidence().filter((record) => record.source === "STREAM_SETTLEMENT").map((record) => [record.venueTradeId, record.provenance])).toEqual([[trade.venueTradeId, "NAMED"]]);
      r.u.world.faults.listTrades = (answer) => {
        const read = answer() as { trades: Row[] };
        return { ...read, trades: read.trades.map((entry) => ({ ...entry, venueTradeId: "replacement-trade" })) };
      };
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(unresolved(r, "READ_CONFLICT", trade.venueTradeId)?.detail).toContain("the user stream named");
      expect(fills(r)).toEqual([]);
      expect(r.u.violations).toEqual([]);
    });
  }

  for (const withRestart of [false, true]) {
    it(`(R8-01, O1-LAG${withRestart ? ", a restart" : ""}) a tracked order matched twice; the stream names the second trade by its settlement alone; a consistent snapshot from before it: never resumed while it lags; once the reads catch up, both fills, resumed`, async () => {
      let r = await ready();
      await submitOne(r.oms);
      expect(await reconcileRounds(r, 3)).toBe(true);
      const salt = r.u.world.receipts.at(-1) as string;
      const first = r.u.world.match(salt, "0.4");
      expect(await reconcileRounds(r, 3)).toBe(true);
      const position = r.u.world.positions.get(YES) ?? "0";
      const collateral = r.u.world.collateral;
      const second = r.u.world.match(salt, "0.4");
      if (first === undefined || second === undefined) throw new Error("no match");
      r.p.coordinator.onUserStreamOutput(settlementOnly(second));
      await r.p.coordinator.settled();
      const lag = (order: OrderRow | undefined): OrderRow | undefined => (order !== undefined && order.venueOrderId === first.venueOrderId ? { ...order, sizeMatched: "0.4" } : order);
      r.u.world.faults.listTrades = (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== second.venueTradeId) };
      };
      r.u.world.faults.listOpenOrders = (answer) => {
        const read = answer() as { orders: OrderRow[] };
        return { ...read, orders: read.orders.map((order) => lag(order)) };
      };
      r.u.world.faults.readOrder = (_id, answer) => {
        const read = answer() as { found: boolean; order?: OrderRow };
        return read.found ? { ...read, order: lag(read.order) } : read;
      };
      r.u.world.faults.readPositions = (answer) => {
        const read = answer() as { positions: PositionRow[] };
        return { ...read, positions: read.positions.map((entry) => (entry.tokenId === YES ? { ...entry, size: position } : entry)) };
      };
      r.u.world.faults.readCollateral = (answer) => ({ ...(answer() as Row), balance: collateral });
      if (withRestart) r = await restarted(r);
      r.p.coordinator.trigger("PERIODIC_TIMER");
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(unresolved(r, "READ_CONFLICT", second.venueTradeId)?.detail).toContain("the user stream named");
      expect(fills(r)).toEqual([first.venueTradeId]);
      expect(r.u.violations).toEqual([]);
      // The reads catch up: the trade is shown, its fill delivered, and the account resumes consistently.
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 5)).toBe(true);
      expect(fills(r).sort()).toEqual([first.venueTradeId, second.venueTradeId].sort());
      expect(r.u.violations).toEqual([]);
    });
  }

  it("(R8-01, an attempt could own its order) an unknown submission matched twice; the stream names the second trade by its settlement alone; a consistent snapshot from before it: no answer, never resumed while it lags; then PRESENT, both fills", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const first = r.u.world.match(salt, "0.4");
    const position = r.u.world.positions.get(YES) ?? "0";
    const collateral = r.u.world.collateral;
    const second = r.u.world.match(salt, "0.4");
    if (first === undefined || second === undefined) throw new Error("no match");
    r.p.coordinator.onUserStreamOutput(settlementOnly(second));
    await r.p.coordinator.settled();
    const lag = (order: OrderRow | undefined): OrderRow | undefined => (order !== undefined && order.venueOrderId === first.venueOrderId ? { ...order, sizeMatched: "0.4" } : order);
    r.u.world.faults = {
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== second.venueTradeId) };
      },
      listOpenOrders: (answer) => {
        const read = answer() as { orders: OrderRow[] };
        return { ...read, orders: read.orders.map((order) => lag(order)) };
      },
      readOrder: (_id, answer) => {
        const read = answer() as { found: boolean; order?: OrderRow };
        return read.found ? { ...read, order: lag(read.order) } : read;
      },
      readPositions: (answer) => {
        const read = answer() as { positions: PositionRow[] };
        return { ...read, positions: read.positions.map((entry) => (entry.tokenId === YES ? { ...entry, size: position } : entry)) };
      },
      readCollateral: (answer) => ({ ...(answer() as Row), balance: collateral }),
    };
    expect(await reconcileRounds(r, 5)).toBe(false);
    // Its order could be the attempt's: an answer would claim it with nothing left to stand for the named trade.
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(unresolved(r, "READ_CONFLICT", second.venueTradeId)?.detail).toContain("the user stream named");
    expect(r.u.violations).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    expect(fills(r).sort()).toEqual([first.venueTradeId, second.venueTradeId].sort());
    expect(r.u.violations).toEqual([]);
  });

  it("(R8-01, control) the stream's settlement answered by its own trade: delivered under that identity, resumed", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    if (trade === undefined) throw new Error("no match");
    r.p.coordinator.onUserStreamOutput(settlementOnly(trade));
    await r.p.coordinator.settled();
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r)).toEqual([trade.venueTradeId]);
    expect(r.u.violations).toEqual([]);
  });

  it("(R8-01, a foreign order: explicitly quarantined) the stream names a trade on an order no one can own, which the trades read does not show: TRADE_UNATTRIBUTED under its own id, no READ_CONFLICT; released, resumed", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    const trade = r.u.world.match(foreign.salt, "0.4");
    if (trade === undefined) throw new Error("no match");
    r.p.coordinator.onUserStreamOutput(settlementOnly(trade));
    await r.p.coordinator.settled();
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: TradeRow[] };
      return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== trade.venueTradeId) };
    };
    expect(await reconcileRounds(r, 2)).toBe(false);
    const quarantine = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("TRADE_UNATTRIBUTED", trade.venueTradeId, foreign.venueOrderId));
    expect(quarantine?.status).toBe("QUARANTINED");
    expect(r.p.journal.breaks().filter((view) => view.breakClass === "READ_CONFLICT")).toEqual([]);
    let resumed = false;
    for (let round = 0; round < 5 && !resumed; round += 1) {
      await releaseAll(r, "acknowledged");
      r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
      resumed = await reconcileRounds(r, 2);
    }
    expect(resumed).toBe(true);
    expect(r.u.violations).toEqual([]);
  });

  it("(R8-01, a foreign order beside an attempt on another token) the stream names a trade on a foreign NO order while a YES attempt is unresolved: judged by the order's own token, TRADE_UNATTRIBUTED, no READ_CONFLICT; the attempt answered; released, resumed", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    const foreign = r.u.world.placeForeign({ tokenId: NO, side: "BUY", price: "0.5", size: "1" });
    const trade = r.u.world.match(foreign.salt, "0.4");
    if (trade === undefined) throw new Error("no match");
    r.p.coordinator.onUserStreamOutput(settlementOnly(trade));
    await r.p.coordinator.settled();
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: TradeRow[] };
      return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== trade.venueTradeId) };
    };
    // The attempt (BUY YES) is unresolved when the trade is judged: its order's own token (NO) says it cannot be the
    // attempt's, so the trade is unmatched activity, quarantined under its own id, and the run is sound (it answers).
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect(r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("TRADE_UNATTRIBUTED", trade.venueTradeId, foreign.venueOrderId))?.status).toBe("QUARANTINED");
    expect(r.p.journal.breaks().filter((view) => view.breakClass === "READ_CONFLICT")).toEqual([]);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    let resumed = false;
    for (let round = 0; round < 6 && !resumed; round += 1) {
      await releaseAll(r, "acknowledged");
      r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
      resumed = await reconcileRounds(r, 2);
    }
    expect(resumed).toBe(true);
    expect(r.u.violations).toEqual([]);
  });

  it("(R8-01, a ghost: explicitly quarantined) the stream names a trade on a venue order the venue's by-id read does not find: its not-found quarantine covers it (no READ_CONFLICT); released, resumed", async () => {
    const r = await ready();
    r.p.coordinator.onUserStreamOutput(settlementOnly({ venueTradeId: "trade-ghost", venueOrderId: "venue-ghost", transactionHash: `0x${"9".repeat(64)}` }));
    await r.p.coordinator.settled();
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect(r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("ORDER_NOT_FOUND_BY_ID", "venue-ghost"))?.status).toBe("QUARANTINED");
    expect(r.p.journal.breaks().filter((view) => view.breakClass === "READ_CONFLICT")).toEqual([]);
    await releaseAll(r, "the venue does not show it");
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.u.violations).toEqual([]);
  });
});

describe("WP-290 r8 (WP290-CX-R8-02): a trade shown both CONFIRMED and FAILED is a durable contradiction", () => {
  /** An unknown submission whose order matched 0.4: a partial trades answer shows the trade CONFIRMED, then FAILED. */
  async function twoTerminals(complete: boolean): Promise<{ r: Ready; attempt: string | null; tradeId: string }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    if (trade === undefined) throw new Error("no match");
    r.u.world.faults.listTrades = partial;
    await r.p.coordinator.reconcile();
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: Row[] };
      return { ...read, complete, trades: read.trades.map((entry) => ({ ...entry, status: "FAILED" })) };
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    return { r, attempt, tradeId: trade.venueTradeId };
  }

  for (const complete of [false, true]) {
    for (const withRestart of [false, true]) {
      it(`(R8-02, ${complete ? "the conflict already opened" : "two partial answers"}${withRestart ? ", a restart" : ""}) CONFIRMED, then FAILED, then reads repeating CONFIRMED: never answered, never resolved, never resumed`, async () => {
        const setup = await twoTerminals(complete);
        if (complete) expect(unresolved(setup.r, "READ_CONFLICT", setup.tradeId)).toBeDefined();
        const r = withRestart ? await restarted(setup.r) : setup.r;
        expect(await reconcileRounds(r, 5)).toBe(false);
        expect(r.u.accepted.filter((answer) => answer.attemptId === setup.attempt)).toEqual([]);
        expect(unresolved(r, "READ_CONFLICT", setup.tradeId)?.detail).toContain("both CONFIRMED and FAILED");
        expect(r.p.journal.breaks().filter((view) => view.breakClass === "READ_CONFLICT" && view.resolution === "NOT_REPRODUCED")).toEqual([]);
        expect(fills(r)).toEqual([]);
        expect(r.u.violations).toEqual([]);
      });
    }
  }

  for (const withRestart of [false, true]) {
    it(`(R8-02, O2-HARM${withRestart ? ", a restart" : ""}) the venue's truth is FAILED; a partial CONFIRMED, a complete FAILED, then a stale CONFIRMED snapshot: nothing answered or delivered, never resumed`, async () => {
      let r = await ready();
      r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
      const attempt = await submitOne(r.oms);
      const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
      if (trade === undefined) throw new Error("no match");
      const position = r.u.world.positions.get(YES) ?? "0";
      const collateral = r.u.world.collateral;
      r.u.world.faults.listTrades = partial;
      await r.p.coordinator.reconcile();
      r.u.world.failTrade(trade);
      r.u.world.faults = {};
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      r.u.world.faults = {
        listTrades: (answer) => {
          const read = answer() as { trades: Row[] };
          return { ...read, trades: read.trades.map((entry) => ({ ...entry, status: "CONFIRMED" })) };
        },
        readPositions: (answer) => {
          const read = answer() as { positions: PositionRow[] };
          return { ...read, positions: [...read.positions.filter((entry) => entry.tokenId !== YES), { tokenId: YES, size: position }] };
        },
        readCollateral: (answer) => ({ ...(answer() as Row), balance: collateral }),
      };
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
      expect(fills(r)).toEqual([]);
      expect(unresolved(r, "READ_CONFLICT", trade.venueTradeId)?.detail).toContain("both CONFIRMED and FAILED");
      expect(r.u.violations).toEqual([]);
    });
  }

  it("(R8-02, the stream's FAILED) a FAILED settlement the stream reported (the OMS could not apply it) between two CONFIRMED reads: never answered, never resumed", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    if (trade === undefined) throw new Error("no match");
    r.u.world.faults.listTrades = partial;
    await r.p.coordinator.reconcile();
    r.p.coordinator.onUserStreamOutput(settlementOnly(trade, "FAILED"));
    await r.p.coordinator.settled();
    expect(r.p.journal.evidence().filter((record) => record.source === "STREAM_SETTLEMENT").map((record) => record.status)).toEqual(["FAILED"]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(unresolved(r, "READ_CONFLICT", trade.venueTradeId)?.detail).toContain("both CONFIRMED and FAILED");
    expect(r.u.violations).toEqual([]);
  });

  it("(R8-02, a tracked order) CONFIRMED applied, a FAILED read, then CONFIRMED again: once the FAILED quarantine is released, the contradiction still holds", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    if (trade === undefined) throw new Error("no match");
    expect(await reconcileRounds(r, 3)).toBe(true);
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: Row[] };
      return { ...read, trades: read.trades.map((entry) => ({ ...entry, status: "FAILED" })) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    expect(await releaseAll(r, "the FAILED read was wrong")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(unresolved(r, "READ_CONFLICT", trade.venueTradeId)?.detail).toContain("both CONFIRMED and FAILED");
    expect(r.u.violations).toEqual([]);
  });

  it("(R8-02, control: forward progress) MATCHED, then MINED, then CONFIRMED: no contradiction, resumed", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4", { status: "MATCHED" });
    if (trade === undefined) throw new Error("no match");
    for (const status of ["MATCHED", "MINED", "CONFIRMED"]) {
      trade.status = status;
      r.p.coordinator.trigger("PERIODIC_TIMER");
      expect(await reconcileRounds(r, 3)).toBe(true);
    }
    expect(r.p.journal.breaks().filter((view) => view.breakClass === "READ_CONFLICT" || view.breakClass === "READ_REGRESSION")).toEqual([]);
    expect(r.u.violations).toEqual([]);
  });
});

describe("WP-290 r8 (WP290-V8-ACCOUNTED-WHILE-QUARANTINED): the documented 'accounted for' rule", () => {
  it("(V8, the documented rule) a foreign trade quarantined TRADE_UNATTRIBUTED, then dropped from complete reads before its release: its own quarantine accounts for it (no READ_CONFLICT); released, resumed", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    const trade = r.u.world.match(foreign.salt, "0.4");
    if (trade === undefined) throw new Error("no match");
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect(r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("TRADE_UNATTRIBUTED", trade.venueTradeId, foreign.venueOrderId))?.status).toBe("QUARANTINED");
    // The trades history drops it before the operator releases anything.
    r.u.world.trades.splice(r.u.world.trades.indexOf(trade), 1);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect(r.p.journal.breaks().filter((view) => view.breakClass === "READ_CONFLICT")).toEqual([]);
    let resumed = false;
    for (let round = 0; round < 5 && !resumed; round += 1) {
      await releaseAll(r, "acknowledged");
      r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
      resumed = await reconcileRounds(r, 2);
    }
    expect(resumed).toBe(true);
    expect(r.u.violations).toEqual([]);
  });
});
