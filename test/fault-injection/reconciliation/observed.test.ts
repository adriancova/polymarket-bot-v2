/**
 * WP-290 r4: EVERY VENUE ORDER ID A READ OBSERVED IS KEPT, WITH ITS PROVENANCE, UNTIL IT IS CLASSIFIED.
 *
 * - WP290-CX-R4-01: a partial, malformed or duplicated open-orders answer (or trades answer) is discarded whole,
 *   but the venue order ids its rows carry are NOT: each is recorded (`ORDER_UNRESOLVED` keyed by
 *   `venue-order-named`), read by id in every later run, and classified there, so a candidate seen once is never
 *   lost to false uniqueness, and an unmatched order is never lost to a restart.
 * - WP290-V4-BYID-SOURCE-UNPINNED: each observation source has its own pin (a complete list, a row of an unusable
 *   answer, a valid trade leg, a leg of an unusable answer, a by-id read that found the order, one that did not).
 * - WP290-V4-GHOST-ID-PERMANENT-HOLD: an id no read ever showed in full, which a sound run's by-id read does not
 *   find, is an `ORDER_NOT_FOUND_BY_ID` quarantine (releasable), never a `READ_CONFLICT` with a false detail.
 *
 * Every venue read is the simulated venue's (`support/world.ts`). PAPER only.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";

import { MARKET, YES, boot, streamTrade } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

async function restart(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

function unresolvedSubjects(r: Ready): string[] {
  return r.p.journal.unresolvedBreaks().map((view) => view.subjectKey);
}

function named(id: string): string {
  return compositeKey("ORDER_UNRESOLVED", "venue-order-named", id);
}

function shown(id: string): string {
  return compositeKey("ORDER_UNRESOLVED", "venue-order", id);
}

/** Record every by-id read from now on (replacing every other fault). */
function recordReads(r: Ready): string[] {
  const reads: string[] = [];
  r.u.world.faults = {
    readOrder: (id, answer) => {
      reads.push(id);
      return answer();
    },
  };
  return reads;
}

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

type Corruption = "INCOMPLETE" | "MALFORMED_SIBLING" | "DUPLICATE";

/** The open-orders answer, made unusable: a page missing, a malformed row beside the valid ones, a row listed twice. */
function corrupt(corruption: Corruption): (answer: () => unknown) => unknown {
  return (answer) => {
    const read = answer() as { orders: unknown[] };
    if (corruption === "INCOMPLETE") return { ...read, complete: false };
    return { ...read, orders: [...read.orders, corruption === "DUPLICATE" ? read.orders[0] : { venueOrderId: "broken-sibling" }] };
  };
}

describe("WP-290 r4 (WP290-CX-R4-01): the ids an unusable open-orders answer carries are kept, read by id, and classified", () => {
  /** One attempt whose answer was lost while the venue took its order, and a foreign exact twin: two candidates. */
  async function twins(): Promise<{ r: Ready; attempt: string; real: string; twin: string }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const real = r.u.world.orders.get(r.u.world.receipts.at(-1) as string)?.venueOrderId as string;
    const twin = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" }).venueOrderId;
    return { r, attempt, real, twin };
  }

  for (const corruption of ["INCOMPLETE", "MALFORMED_SIBLING", "DUPLICATE"] as const) {
    it(`(R4-01, R4-A ${corruption}) both candidates the unusable list carried are kept; the twin canceled later is still read by id and still a candidate: never PRESENT, paused`, async () => {
      const { r, attempt, real, twin } = await twins();
      r.u.world.faults.listOpenOrders = corrupt(corruption);
      const first = await r.p.coordinator.reconcile();
      expect(first.resumed).toBe(false);
      // Run 1 concluded nothing, but recorded both ids its unusable answer carried. Each row validated in full, so
      // each is SHOWN (r5, R5-NAMED: the answer was discarded, not what its valid rows showed); only the id alone of
      // a malformed row is NAMED.
      expect(unresolvedSubjects(r)).toEqual(expect.arrayContaining([shown(real), shown(twin)]));
      expect(unresolvedSubjects(r)).not.toContain(named(real));
      expect(unresolvedSubjects(r)).not.toContain(named(twin));
      if (corruption === "MALFORMED_SIBLING") expect(unresolvedSubjects(r)).toContain(named("broken-sibling"));
      r.u.world.cancel(twin);
      const reads = recordReads(r);
      expect(await reconcileRounds(r, 4)).toBe(false);
      await expectPaused(r, false, "SIGNED_IDENTITY_AMBIGUOUS");
      expect(reads).toEqual(expect.arrayContaining([real, twin]));
      expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
      expect(oracle(r)).toEqual([]);
    });
  }

  it("(R4-01, R4-A, restart) the same after a restart: the journal's NAMED records alone keep both candidates", async () => {
    const { r, attempt, real, twin } = await twins();
    r.u.world.faults.listOpenOrders = corrupt("INCOMPLETE");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.cancel(twin);
    const again = await restart(r);
    const reads = recordReads(again);
    expect(await reconcileRounds(again, 4)).toBe(false);
    await expectPaused(again, false, "SIGNED_IDENTITY_AMBIGUOUS");
    expect(reads).toEqual(expect.arrayContaining([real, twin]));
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(oracle(again)).toEqual([]);
  });

  it("(R4-01, control) a complete list keeps the canceled twin as a candidate the same way", async () => {
    const { r, attempt, real, twin } = await twins();
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.cancel(twin);
    const reads = recordReads(r);
    expect(await reconcileRounds(r, 4)).toBe(false);
    await expectPaused(r, false, "SIGNED_IDENTITY_AMBIGUOUS");
    expect(reads).toEqual(expect.arrayContaining([real, twin]));
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
  });

  it("(R4-01, R4-B) an unmatched foreign order seen only in a partial list, canceled, then a restart: read by id, ORDER_UNATTRIBUTED, its market halted, never resumed until released", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" }).venueOrderId;
    r.u.world.faults.listOpenOrders = corrupt("INCOMPLETE");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_INCOMPLETE");
    const hold = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === shown(foreign));
    expect(hold).toMatchObject({ breakClass: "ORDER_UNRESOLVED", scope: "MARKET", marketId: MARKET });
    r.u.world.cancel(foreign);
    const again = await restart(r);
    const reads = recordReads(again);
    await expectPaused(again, (await again.p.coordinator.reconcile()).resumed, "ORDER_UNATTRIBUTED");
    expect(reads).toContain(foreign);
    const quarantined = again.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_UNATTRIBUTED");
    expect(quarantined).toMatchObject({ status: "QUARANTINED", marketId: MARKET });
    expect(quarantined?.detail).toContain(foreign);
    expect(r.u.halts.some((halt) => halt.breakId === quarantined?.breakId && halt.marketId === MARKET)).toBe(true);
    // The SHOWN record was judged (its by-id read found it) and is cleared; the order is classified now.
    expect(unresolvedSubjects(again)).not.toContain(shown(foreign));
    expect(await reconcileRounds(again, 2)).toBe(false);
    expect((await again.p.coordinator.releaseQuarantine({ breakId: quarantined?.breakId ?? "", operatorRef: "operator-1", reason: "a manual order" })).ok).toBe(true);
    expect(await reconcileRounds(again, 3)).toBe(true);
    expect(oracle(again)).toEqual([]);
  });

  it("(R4-01) a leg of a partial trades answer names the attempt's fully matched order; after a restart, with every other read lagging, it is read by id: PRESENT, never ABSENT", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const salt = r.u.world.receipts.at(-1) as string;
    const before = r.u.world.collateral;
    const trade = r.u.world.match(salt, "1"); // fully matched: never in the open-orders list
    const x = trade?.venueOrderId as string;
    // Run 1: the trades read is partial; the page it has shows x's trade.
    r.u.world.faults.listTrades = (answer) => ({ ...(answer() as object), complete: false });
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_INCOMPLETE");
    // The leg validated in full: SHOWN (r5, R5-NAMED).
    expect(unresolvedSubjects(r)).toContain(shown(x));
    const again = await restart(r);
    const reads = recordReads(again);
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { venueTradeId: string }[] };
      return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== trade?.venueTradeId) };
    };
    r.u.world.faults.readPositions = (answer) => {
      const read = answer() as { positions: { tokenId: string }[] };
      return { ...read, positions: read.positions.filter((position) => position.tokenId !== YES) };
    };
    r.u.world.faults.readCollateral = (answer) => ({ ...(answer() as object), balance: before });
    expect(await reconcileRounds(again, 5)).toBe(false);
    expect(reads).toContain(x);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect(oracle(again)).toEqual([]);
  });
});

describe("WP-290 r4 (WP290-V4-BYID-SOURCE-UNPINNED): each observation source keeps what only it saw", () => {
  /**
   * The attempt's order is fully matched (not listed) and its fill reached the OMS only through the user stream:
   * the OMS retains the evidence (no attempt has the venue id yet), so the coordinator reads that id by id. Run 1
   * is unsound (the trades read fails). Then a restart (the retained evidence is gone with its process), and every
   * other read lags: only what run 1 recorded names the order.
   */
  async function retainedOnly(byIdInRun1: "found" | "failed"): Promise<{ r: Ready; again: Ready; attempt: string; x: string; reads: string[]; run1: string[]; tradeId: string }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const salt = r.u.world.receipts.at(-1) as string;
    const before = r.u.world.collateral;
    const trade = r.u.world.match(salt, "1");
    const x = trade?.venueOrderId as string;
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId as string));
    await r.p.coordinator.settled();
    expect(r.oms.retainedEvidence().map((item) => item.venueOrderId)).toEqual([x]);
    r.u.world.faults.listTrades = () => {
      throw new Error("timeout");
    };
    if (byIdInRun1 === "failed") {
      r.u.world.faults.readOrder = (id, answer) => {
        if (id === x) throw new Error("timeout");
        return answer();
      };
    }
    const report = await r.p.coordinator.reconcile();
    const run1 = report.runs.flatMap((run) => run.detections.map((detection) => detection.subjectKey));
    const again = await restart(r);
    const reads = recordReads(again);
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { venueTradeId: string }[] };
      return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== trade?.venueTradeId) };
    };
    r.u.world.faults.readPositions = (answer) => {
      const read = answer() as { positions: { tokenId: string }[] };
      return { ...read, positions: read.positions.filter((position) => position.tokenId !== YES) };
    };
    r.u.world.faults.readCollateral = (answer) => ({ ...(answer() as object), balance: before });
    return { r, again, attempt, x, reads, run1, tradeId: trade?.venueTradeId as string };
  }

  it("(BYID-SOURCE, found) an order seen ONLY by its by-id read in an unsound run, then a restart: read by id again, never ABSENT; held while the trades read omits the stream's trade (r8), then PRESENT", async () => {
    const { r, again, attempt, x, reads, run1, tradeId } = await retainedOnly("found");
    expect(run1).toContain(shown(x));
    expect(await reconcileRounds(again, 5)).toBe(false);
    expect(reads).toContain(x);
    // r8 (WP290-CX-R8-01): the stream named the fill (kept by the coordinator, journaled) and no read has shown its
    // trade, while the attempt could own its order: its identity is unanswered, so nothing is answered (never ABSENT).
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(unresolvedSubjects(again)).toContain(compositeKey("READ_CONFLICT", "trade", tradeId));
    // The trades read catches up: PRESENT on the order run 1 recorded.
    delete r.u.world.faults.listTrades;
    expect(await reconcileRounds(again, 5)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect(oracle(again)).toEqual([]);
  });

  it("(BYID-SOURCE, not shown) its by-id read FAILED in the unsound run: the id is kept as NAMED, read by id after the restart, never ABSENT; held while the trades read omits the stream's trade (r8), then PRESENT", async () => {
    const { r, again, attempt, x, reads, run1, tradeId } = await retainedOnly("failed");
    expect(run1).toContain(named(x));
    expect(await reconcileRounds(again, 5)).toBe(false);
    expect(reads).toContain(x);
    // r8 (WP290-CX-R8-01): the stream named the fill (kept by the coordinator, journaled) and no read has shown its
    // trade, while the attempt could own its order: its identity is unanswered, so nothing is answered (never ABSENT).
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(unresolvedSubjects(again)).toContain(compositeKey("READ_CONFLICT", "trade", tradeId));
    // The trades read catches up: PRESENT on the order run 1 recorded.
    delete r.u.world.faults.listTrades;
    expect(await reconcileRounds(again, 5)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", x]]);
    expect(oracle(again)).toEqual([]);
  });

  it("(BYID-SOURCE, trade leg) an order a VALID trades read showed (its by-id read failed), which later neither the trades read nor its by-id read shows: READ_CONFLICT, never ORDER_NOT_FOUND_BY_ID, never resumed", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "SELL", price: "0.7", size: "1" });
    const trade = r.u.world.match(foreign.salt, "1"); // fully matched: never in the open-orders list
    const y = foreign.venueOrderId;
    r.u.world.faults.readOrder = (id, answer) => {
      if (id === y) throw new Error("timeout");
      return answer();
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_MISSING");
    // Shown by the trades read's leg (a read that answered in full), though its by-id read failed.
    expect(unresolvedSubjects(r)).toContain(shown(y));
    r.u.world.faults = {
      listTrades: (answer) => {
        const read = answer() as { trades: { venueTradeId: string }[] };
        return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== trade?.venueTradeId) };
      },
      readOrder: (id, answer) => (id === y ? { route: "/data/order", found: false } : answer()),
    };
    for (let round = 0; round < 3; round += 1) {
      for (const view of r.p.journal.unresolvedBreaks()) {
        if (view.status === "QUARANTINED") await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason: "try" });
      }
      r.p.coordinator.trigger("PERIODIC_TIMER");
      await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_CONFLICT");
    }
    expect(r.p.journal.unresolvedBreaks().map((view) => view.detail)).toContainEqual(expect.stringContaining(`venue order ${y} was seen by an earlier read, but its by-id read does not find it`));
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("ORDER_NOT_FOUND_BY_ID");
  });
});

describe("WP-290 r4 (WP290-V4-GHOST-ID-PERMANENT-HOLD): an id no read showed, which the venue does not find, is a releasable quarantine", () => {
  /**
   * The user stream names a venue order the venue never had; the OMS retains it; run 1 is unsound. Its by-id read in
   * run 1 finds nothing, or fails (a `READ_MISSING` keyed by the order then names it too: a by-id read's problem
   * never SHOWED the order either).
   */
  async function ghost(byIdInRun1: "not found" | "failed" = "not found"): Promise<{ r: Ready; attempt: string }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    const attempt = (await submitOne(r.oms)) as string;
    r.p.coordinator.onUserStreamOutput({
      kind: "TRADE",
      oms: {
        fills: [{ venueTradeId: "ghost-trade", venueOrderId: "venue-ghost", shares: "0.1", price: "0.5", liquidityRole: "MAKER", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" }],
        settlements: [],
        shortfalls: [],
      },
    });
    await r.p.coordinator.settled();
    expect(r.oms.retainedEvidence().map((item) => item.venueOrderId)).toEqual(["venue-ghost"]);
    r.u.world.faults.listTrades = () => {
      throw new Error("timeout");
    };
    if (byIdInRun1 === "failed") {
      r.u.world.faults.readOrder = (id, answer) => {
        if (id === "venue-ghost") throw new Error("timeout");
        return answer();
      };
    }
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    if (byIdInRun1 === "failed") expect(unresolvedSubjects(r)).toContain(compositeKey("READ_MISSING", compositeKey("order", "venue-ghost")));
    r.u.world.faults = {};
    // Kept, as NAMED, with a detail that says what happened: its by-id read did not show it.
    const hold = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === named("venue-ghost"));
    expect(hold?.detail).toContain("no read showed it in full");
    expect(unresolvedSubjects(r)).not.toContain(shown("venue-ghost"));
    return { r, attempt };
  }

  async function checkQuarantined(r: Ready): Promise<void> {
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("READ_CONFLICT");
    const quarantine = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_NOT_FOUND_BY_ID");
    expect(quarantine).toMatchObject({ status: "QUARANTINED", scope: "ACCOUNT", subjectKey: compositeKey("ORDER_NOT_FOUND_BY_ID", "venue-ghost") });
    expect(quarantine?.detail).toContain("the venue's by-id read does not find it");
    expect(r.u.halts.some((halt) => halt.breakId === quarantine?.breakId && halt.marketId === null)).toBe(true);
    expect(unresolvedSubjects(r)).not.toContain(named("venue-ghost"));
    // Every quarantine released (the OMS's own alert too, where its process still has it): the account resumes.
    // (r5) While the not-found quarantine stands no attempt is answered by signed identity, so the attempt is answered
    // only once it is released; where the process still retains the ghost's stream evidence, the OMS then raises its
    // own halting alert about it (UNKNOWN_VENUE_ORDER), a second quarantine, released the same way.
    let resumed = false;
    for (let round = 0; round < 2 && !resumed; round += 1) {
      for (const view of r.p.journal.unresolvedBreaks()) {
        if (view.status !== "QUARANTINED") continue;
        if (round > 0) expect(view.breakClass).toBe("OMS_HALTING_ALERT");
        expect((await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason: "not the account's order" })).ok).toBe(true);
      }
      resumed = await reconcileRounds(r, 4);
    }
    expect(resumed).toBe(true);
    expect(oracle(r)).toEqual([]);
  }

  it("(GHOST) the next complete run's by-id read does not find it: ORDER_NOT_FOUND_BY_ID (the account halted), no READ_CONFLICT; released, the account resumes", async () => {
    const { r } = await ghost();
    expect(await reconcileRounds(r, 3)).toBe(false);
    await expectPaused(r, false, "ORDER_NOT_FOUND_BY_ID");
    await checkQuarantined(r);
  });

  for (const byIdInRun1 of ["not found", "failed"] as const) {
    it(`(GHOST, restart, by-id read ${byIdInRun1} in run 1) the same after a restart: the NAMED records alone name it; quarantined, released, resumes`, async () => {
      const { r } = await ghost(byIdInRun1);
      const again = await restart(r);
      expect(again.oms.retainedEvidence()).toEqual([]);
      const reads = recordReads(again);
      expect(await reconcileRounds(again, 3)).toBe(false);
      expect(reads).toContain("venue-ghost");
      await expectPaused(again, false, "ORDER_NOT_FOUND_BY_ID");
      await checkQuarantined(again);
    });
  }

  it("(GHOST, restart, the quarantine alone) once the NAMED record is cleared, the quarantine alone names the id: after a restart it is read by id while it stands, never a READ_CONFLICT", async () => {
    const { r } = await ghost();
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect(unresolvedSubjects(r)).toContain(compositeKey("ORDER_NOT_FOUND_BY_ID", "venue-ghost"));
    expect(unresolvedSubjects(r)).not.toContain(named("venue-ghost"));
    const again = await restart(r);
    const reads = recordReads(again);
    expect(await reconcileRounds(again, 3)).toBe(false);
    expect(reads).toContain("venue-ghost");
    await expectPaused(again, false, "ORDER_NOT_FOUND_BY_ID");
    await checkQuarantined(again);
  });

  it("(GHOST, a tracked order) a tracked order's id only NAMED (its by-id read failed), which the venue then does not find, is the OMS's to judge: ORDER_STATE_MISMATCH holds, never ORDER_NOT_FOUND_BY_ID; found again, it resumes with nothing to release", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 2)).toBe(true);
    const x = r.oms.orders()[0]?.venueOrderId as string;
    // The venue cancels it (the OMS does not know yet), and its by-id read fails: a READ_MISSING keyed by the order.
    r.u.world.cancel(x);
    r.u.world.faults.readOrder = (id, answer) => {
      if (id === x) throw new Error("timeout");
      return answer();
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_MISSING");
    expect(unresolvedSubjects(r)).toContain(compositeKey("READ_MISSING", compositeKey("order", x)));
    // Its by-id read now finds nothing: the tracked order's rule applies (open in the OMS, not found at the venue).
    r.u.world.faults.readOrder = (id, answer) => (id === x ? { route: "/data/order", found: false } : answer());
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "ORDER_STATE_MISMATCH");
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("ORDER_NOT_FOUND_BY_ID");
    expect(unresolvedSubjects(r)).not.toContain(compositeKey("READ_MISSING", compositeKey("order", x)));
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.oms.orders()[0]?.state).toBe("CANCELED");
    expect(oracle(r)).toEqual([]);
  });

  it("(GHOST, found later) while the quarantine stands the id is read by id in every run: once the venue shows it, it is classified like any order (here UNATTRIBUTED)", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    await submitOne(r.oms);
    // The stream names the id the next foreign order will carry (an order observation), before the venue shows any
    // such order. (r6: a FILL the stream reported is evidence of a match; a venue order later shown with less matched
    // than that is a contradiction, never classified: the "(GHOST, found later, with less matched)" pin below.)
    const id = "venue-foreign-1";
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: id, status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    r.u.world.faults.listTrades = () => {
      throw new Error("timeout");
    };
    await r.p.coordinator.reconcile();
    r.u.world.faults = {};
    const again = await restart(r);
    expect(await reconcileRounds(again, 3)).toBe(false);
    expect(unresolvedSubjects(again)).toContain(compositeKey("ORDER_NOT_FOUND_BY_ID", id));
    expect(unresolvedSubjects(again)).not.toContain(named(id));
    // Now the venue shows it (an order of the account placed outside the OMS, canceled): only its by-id read does.
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "SELL", price: "0.9", size: "3" });
    expect(foreign.venueOrderId).toBe(id);
    r.u.world.cancel(id);
    const reads = recordReads(again);
    again.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(again, (await again.p.coordinator.reconcile()).resumed, "ORDER_UNATTRIBUTED");
    expect(reads).toContain(id);
    expect(again.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_UNATTRIBUTED")?.subjectKey).toBe(compositeKey("ORDER_UNATTRIBUTED", id));
  });

  it("(GHOST, found later, with less matched) r6: a fill the stream reported for an id is evidence that survives a restart; the venue later showing that order with less matched is a read behind the evidence (READ_REGRESSION), never classified, never resumed", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    await submitOne(r.oms);
    const id = "venue-foreign-1";
    r.p.coordinator.onUserStreamOutput({
      kind: "TRADE",
      oms: { fills: [{ venueTradeId: "late-trade", venueOrderId: id, shares: "0.1", price: "0.5", liquidityRole: "MAKER", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" }], settlements: [], shortfalls: [] },
    });
    await r.p.coordinator.settled();
    const again = await restart(r);
    expect(await reconcileRounds(again, 2)).toBe(false);
    expect(unresolvedSubjects(again)).toContain(compositeKey("ORDER_NOT_FOUND_BY_ID", id));
    // The venue now shows an order under that id, canceled, with NOTHING matched: less than the fill the stream saw.
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "SELL", price: "0.9", size: "3" });
    expect(foreign.venueOrderId).toBe(id);
    r.u.world.cancel(id);
    for (let round = 0; round < 3; round += 1) {
      again.p.coordinator.trigger("PERIODIC_TIMER");
      await expectPaused(again, (await again.p.coordinator.reconcile()).resumed, "READ_REGRESSION");
    }
    expect(again.p.journal.breaks().map((view) => view.breakClass)).not.toContain("ORDER_UNATTRIBUTED");
    expect(again.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("READ_REGRESSION", "order", id))?.detail).toContain("less than the 0.1");
    // The fill was durable evidence the moment it was routed (the OMS retained it in memory only).
    expect(again.p.journal.evidence().map((record) => [record.evidenceKind, record.venueOrderId, record.venueTradeId, record.size, record.source])).toContainEqual(["LEG", id, "late-trade", "0.1", "STREAM_FILL"]);
  });

  it("(GHOST, MALFORMED_SIBLING) an id only a malformed row carried, which the venue does not find, is quarantined the same way", async () => {
    const r = await ready();
    r.u.world.faults.listOpenOrders = corrupt("MALFORMED_SIBLING");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_MALFORMED");
    expect(unresolvedSubjects(r)).toContain(named("broken-sibling"));
    r.u.world.faults = {};
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "ORDER_NOT_FOUND_BY_ID");
    expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_NOT_FOUND_BY_ID")?.subjectKey).toBe(compositeKey("ORDER_NOT_FOUND_BY_ID", "broken-sibling"));
    await checkQuarantinedAt(r, "broken-sibling");
  });
});

async function checkQuarantinedAt(r: Ready, id: string): Promise<void> {
  const quarantine = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("ORDER_NOT_FOUND_BY_ID", id));
  expect(quarantine?.status).toBe("QUARANTINED");
  expect((await r.p.coordinator.releaseQuarantine({ breakId: quarantine?.breakId ?? "", operatorRef: "operator-1", reason: "a malformed row" })).ok).toBe(true);
  const reads = recordReads(r);
  expect(await reconcileRounds(r, 3)).toBe(true);
  // Released: acknowledged, and no longer read by id.
  reads.length = 0;
  r.p.coordinator.trigger("PERIODIC_TIMER");
  expect((await r.p.coordinator.reconcile()).resumed).toBe(true);
  expect(reads).not.toContain(id);
  expect(oracle(r)).toEqual([]);
}
