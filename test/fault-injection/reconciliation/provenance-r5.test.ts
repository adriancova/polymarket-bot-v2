/**
 * WP-290 r5: A ROW OR LEG THAT VALIDATED IN FULL SHOWED ITS ORDER, WHATEVER THE ANSWER AROUND IT.
 *
 * - R5-NAMED (WP290-V5-NAMED-ROW-RESOLVES = WP290-CX-R5-01): r4 kept the ids of a partial, malformed or duplicated
 *   open-orders answer (and of such a trades answer), but recorded every one as only NAMED, even a row that validated
 *   in full. A later by-id read that did not find such an order then took the path meant for an id no read ever
 *   showed: a releasable `ORDER_NOT_FOUND_BY_ID`, with the id out of identity resolution, and the same sound run
 *   resolved the attempt: `ABSENT` for an order the venue holds, or `PRESENT` on a foreign exact twin. Now such a row
 *   or leg is SHOWN, durably (`ORDER_UNRESOLVED` keyed `venue-order`), so the same contradiction is a `READ_CONFLICT`,
 *   exactly as after a complete list: nothing is answered while it lasts. Only the id alone of a malformed row or leg
 *   (nothing else of it validated) keeps the ghost policy (`ORDER_NOT_FOUND_BY_ID`, releasable).
 * - WP290-V5-NAMED-DUPLICATE-RECORD: an order a read showed keeps ONE record, keyed `venue-order`, however a later
 *   unsound run observes it (its by-id read not finding it, say); no record says "no read showed it in full" of it.
 *
 * Every pin runs with and without a restart between the run that saw the rows and the runs that contradict them,
 * and beside its control: the same contradiction after a complete list (or a valid trades read). Every venue read is
 * the simulated venue's (`support/world.ts`). PAPER only.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";

import { group, ticket } from "../../unit/oms/support/harness.js";

import { NO, YES, boot } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

async function restart(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

function named(id: string): string {
  return compositeKey("ORDER_UNRESOLVED", "venue-order-named", id);
}

function shown(id: string): string {
  return compositeKey("ORDER_UNRESOLVED", "venue-order", id);
}

function unresolvedSubjects(r: Ready): string[] {
  return r.p.journal.unresolvedBreaks().map((view) => view.subjectKey);
}

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

/** Reconcile `times` times, advancing the clock past the horizon after each run. */
async function rounds(r: Ready, times: number): Promise<void> {
  for (let round = 0; round < times; round += 1) {
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
  }
}

/** The journal never kept `id` as only named, nor said of it that no read showed it in full (DUPLICATE-RECORD). */
function expectNeverOnlyNamed(r: Ready, id: string): void {
  const about = r.p.journal.breaks().filter((view) => view.subjectKey.includes(id));
  expect(about.map((view) => view.subjectKey)).not.toContain(named(id));
  expect(about.map((view) => view.subjectKey)).not.toContain(compositeKey("ORDER_NOT_FOUND_BY_ID", id));
  expect(about.filter((view) => view.detail.includes("no read showed it in full") || view.detail.includes("no read ever showed it in full"))).toEqual([]);
}

type OpenCorruption = "INCOMPLETE" | "MALFORMED_SIBLING" | "DUPLICATE";

/** The open-orders answer made unusable: a page missing, an id-only malformed row beside the valid ones, a row twice. */
function corruptOpen(corruption: OpenCorruption): (answer: () => unknown) => unknown {
  return (answer) => {
    const read = answer() as { orders: unknown[] };
    if (corruption === "INCOMPLETE") return { ...read, complete: false };
    return { ...read, orders: [...read.orders, corruption === "DUPLICATE" ? read.orders[0] : { venueOrderId: "broken-sibling" }] };
  };
}

describe("WP-290 r5 (R5-NAMED): a fully valid row of an unusable open-orders answer is SHOWN; a later by-id not-found holds identity resolution", () => {
  /**
   * The attempt's answer was lost while the venue took its order (`real`), and a foreign exact twin is live: two
   * candidates, both in run 1's answer. Then the real order is canceled and its by-id read wrongly finds nothing
   * (E-14 says canceled orders are found by id), while the twin stays listed.
   */
  for (const corruption of ["INCOMPLETE", "MALFORMED_SIBLING", "DUPLICATE", "COMPLETE"] as const) {
    for (const restarted of [false, true]) {
      const label = `${corruption === "COMPLETE" ? "control, a complete list" : corruption}${restarted ? ", after a restart" : ""}`;
      it(`(R5-NAMED, twin, ${label}) both candidates were shown; the real one not found by id is a READ_CONFLICT: never PRESENT on the twin, paused`, async () => {
        const r0 = await ready();
        r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
        const attempt = (await submitOne(r0.oms)) as string;
        const real = r0.u.world.orders.get(r0.u.world.receipts.at(-1) as string)?.venueOrderId as string;
        const twin = r0.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" }).venueOrderId;
        if (corruption !== "COMPLETE") r0.u.world.faults.listOpenOrders = corruptOpen(corruption);
        expect((await r0.p.coordinator.reconcile()).resumed).toBe(false);
        const afterRun1 = unresolvedSubjects(r0);
        r0.u.world.cancel(real);
        r0.u.world.faults = { readOrder: (id, answer) => (id === real ? { route: "/data/order", found: false, order: null } : answer()) };
        const r = restarted ? await restart(r0) : r0;
        await rounds(r, 3);
        expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
        await expectPaused(r, false, "READ_CONFLICT");
        expect(r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("READ_CONFLICT", "order", real))?.detail).toContain("was seen by an earlier read");
        expectNeverOnlyNamed(r, real);
        // The genuine ghost beside it (the id alone of a malformed row) keeps its NAMED provenance, so it is never a
        // READ_CONFLICT; these runs are unsound, so none classifies it yet (a sound run makes it a releasable
        // ORDER_NOT_FOUND_BY_ID: observed.test.ts, "(GHOST, MALFORMED_SIBLING)").
        if (corruption === "MALFORMED_SIBLING") {
          expect(unresolvedSubjects(r)).toContain(named("broken-sibling"));
          expect(unresolvedSubjects(r)).not.toContain(shown("broken-sibling"));
          expect(r.p.journal.breaks().map((view) => view.subjectKey)).not.toContain(compositeKey("READ_CONFLICT", "order", "broken-sibling"));
        }
        expect(oracle(r)).toEqual([]);
        // Run 1 recorded each row that validated in full as SHOWN, durably; only the id alone of the malformed
        // sibling as NAMED (asserted last, so that on the r4 code the behaviour above is what fails first).
        expect(afterRun1).toEqual(expect.arrayContaining([shown(real), shown(twin)]));
        expect(afterRun1).not.toContain(named(real));
        if (corruption === "MALFORMED_SIBLING") expect(afterRun1).toContain(named("broken-sibling"));
      });
    }
  }

  /**
   * The attempt's own order `x` is live at the venue and is the only candidate. Run 1 shows it in a valid row of an
   * unusable answer (the control: in a complete list, with run 1 unsound because x's by-id read fails). Then the
   * list leaves x out and its by-id read finds nothing: two reads contradict run 1's row.
   */
  for (const corruption of ["INCOMPLETE", "MALFORMED_SIBLING", "DUPLICATE", "COMPLETE"] as const) {
    for (const restarted of [false, true]) {
      const label = `${corruption === "COMPLETE" ? "control, a complete list" : corruption}${restarted ? ", after a restart" : ""}`;
      it(`(R5-NAMED, ABSENT, ${label}) the attempt's own order, shown by a valid row, then left out and not found by id: never ABSENT, paused`, async () => {
        const r0 = await ready();
        r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
        const attempt = (await submitOne(r0.oms)) as string;
        const x = r0.u.world.orders.get(r0.u.world.receipts.at(-1) as string)?.venueOrderId as string;
        if (corruption === "COMPLETE") {
          r0.u.world.faults.readOrder = (id, answer) => {
            if (id === x) throw new Error("timeout");
            return answer();
          };
        } else r0.u.world.faults.listOpenOrders = corruptOpen(corruption);
        expect((await r0.p.coordinator.reconcile()).resumed).toBe(false);
        const afterRun1 = unresolvedSubjects(r0);
        r0.u.world.faults = {
          listOpenOrders: (answer) => {
            const read = answer() as { orders: { venueOrderId: string }[] };
            return { ...read, orders: read.orders.filter((order) => order.venueOrderId !== x) };
          },
          readOrder: (id, answer) => (id === x ? { route: "/data/order", found: false } : answer()),
        };
        const r = restarted ? await restart(r0) : r0;
        await rounds(r, 4);
        expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
        expect(oracle(r)).toEqual([]);
        await expectPaused(r, false, "READ_CONFLICT");
        expectNeverOnlyNamed(r, x);
        expect(afterRun1).toContain(shown(x));
      });
    }
  }
});

describe("WP-290 r5 (R5-NAMED): a fully valid leg of an unusable trades answer is SHOWN", () => {
  /**
   * The attempt's own order `x` is fully matched (never in the open-orders list), so only its trade's leg shows it.
   * Run 1's trades answer is unusable: a page missing; a malformed trade beside it (whose leg is an id alone); or the
   * trade's own row malformed (a transaction hash that is not an id) while its leg validates in full. The control: a
   * valid trades read, with run 1 unsound because x's by-id read fails. Then every read lags (the trade gone from
   * the trades read, the holdings back where they were) and x's by-id read finds nothing.
   */
  for (const corruption of ["INCOMPLETE", "MALFORMED_SIBLING", "MALFORMED_ROW", "COMPLETE"] as const) {
    for (const restarted of [false, true]) {
      const label = `${corruption === "COMPLETE" ? "control, a valid trades read" : corruption}${restarted ? ", after a restart" : ""}`;
      it(`(R5-NAMED, trade leg, ${label}) the attempt's fully matched order, shown by a valid leg, later not found by id while every read lags: never ABSENT, paused`, async () => {
        const r0 = await ready();
        r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
        const attempt = (await submitOne(r0.oms)) as string;
        const salt = r0.u.world.receipts.at(-1) as string;
        const before = r0.u.world.collateral;
        const trade = r0.u.world.match(salt, "1");
        const x = trade?.venueOrderId as string;
        if (corruption === "COMPLETE") {
          r0.u.world.faults.readOrder = (id, answer) => {
            if (id === x) throw new Error("timeout");
            return answer();
          };
        } else {
          r0.u.world.faults.listTrades = (answer) => {
            const read = answer() as { trades: Record<string, unknown>[] };
            if (corruption === "INCOMPLETE") return { ...read, complete: false };
            if (corruption === "MALFORMED_ROW") return { ...read, trades: read.trades.map((row) => ({ ...row, transactionHash: 42 })) };
            return { ...read, trades: [...read.trades, { venueTradeId: "broken-trade", ownLegs: [{ venueOrderId: "broken-leg-order" }] }] };
          };
        }
        expect((await r0.p.coordinator.reconcile()).resumed).toBe(false);
        const afterRun1 = unresolvedSubjects(r0);
        r0.u.world.faults = {
          listTrades: (answer) => {
            const read = answer() as { trades: { venueTradeId: string }[] };
            return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId !== trade?.venueTradeId) };
          },
          readPositions: (answer) => {
            const read = answer() as { positions: { tokenId: string }[] };
            return { ...read, positions: read.positions.filter((position) => position.tokenId !== YES) };
          },
          readCollateral: (answer) => ({ ...(answer() as object), balance: before }),
          readOrder: (id, answer) => (id === x ? { route: "/data/order", found: false } : answer()),
        };
        const r = restarted ? await restart(r0) : r0;
        await rounds(r, 5);
        expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
        expect(oracle(r)).toEqual([]);
        await expectPaused(r, false, "READ_CONFLICT");
        expectNeverOnlyNamed(r, x);
        expect(afterRun1).toContain(shown(x));
        if (corruption === "MALFORMED_SIBLING") expect(afterRun1).toContain(named("broken-leg-order"));
        // The id alone of the malformed trade's leg keeps its NAMED provenance (never a READ_CONFLICT).
        if (corruption === "MALFORMED_SIBLING") {
          expect(unresolvedSubjects(r)).toContain(named("broken-leg-order"));
          expect(r.p.journal.breaks().map((view) => view.subjectKey)).not.toContain(compositeKey("READ_CONFLICT", "order", "broken-leg-order"));
        }
      });
    }
  }
});

describe("WP-290 r5 (WP290-V5-NAMED-DUPLICATE-RECORD): an order a read showed keeps one record, keyed by what a read showed", () => {
  for (const restarted of [false, true]) {
    it(`(DUPLICATE-RECORD${restarted ? ", after a restart" : ""}) shown by a complete list in an unsound run, then only named by unsound runs (its by-id read finds nothing): one venue-order record, never a venue-order-named one`, async () => {
      const r0 = await ready();
      const foreign = r0.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "2" }).venueOrderId;
      // Run 1 is unsound (the trades read fails): the complete list SHOWED the foreign order, which nothing classifies.
      r0.u.world.faults.listTrades = () => {
        throw new Error("timeout");
      };
      r0.p.coordinator.trigger("PERIODIC_TIMER");
      await expectPaused(r0, (await r0.p.coordinator.reconcile()).resumed, "READ_MISSING");
      expect(unresolvedSubjects(r0)).toContain(shown(foreign));
      // From now on the list leaves it out, and its by-id read finds nothing: a contradiction of run 1's list, so
      // every later run is unsound, and in each only the by-id read names it.
      r0.u.world.faults = {
        listOpenOrders: (answer) => {
          const read = answer() as { orders: { venueOrderId: string }[] };
          return { ...read, orders: read.orders.filter((order) => order.venueOrderId !== foreign) };
        },
        readOrder: (id, answer) => (id === foreign ? { route: "/data/order", found: false } : answer()),
      };
      const r = restarted ? await restart(r0) : r0;
      for (let round = 0; round < 3; round += 1) {
        r.p.coordinator.trigger("PERIODIC_TIMER");
        await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_CONFLICT");
      }
      expect(unresolvedSubjects(r).filter((subject) => subject === shown(foreign))).toHaveLength(1);
      expectNeverOnlyNamed(r, foreign);
      expect(oracle(r)).toEqual([]);
    });
  }
});

describe("WP-290 r5 (R5-NAMED's family): an id only named, which the venue's by-id read does not find, withholds every signed-identity answer while it stands", () => {
  /**
   * The attempt's own order `real` reached the venue, but run 1's open-orders answer carries its row malformed: only
   * its id is readable (NAMED, the ghost policy). Then its by-id read wrongly finds nothing (E-14 says canceled and
   * live orders are found by id). In the PRESENT variant a foreign exact twin is live and fully shown; in the ABSENT
   * variant nothing else is. The not-found id is an `ORDER_NOT_FOUND_BY_ID` quarantine (releasable, never a
   * READ_CONFLICT), and while it stands no attempt is answered by signed identity: its token is unknown, so it could
   * be any attempt's. (Released by an operator, the attempt is answered: observed.test.ts, the GHOST tests.)
   */
  for (const variant of ["PRESENT on a twin", "ABSENT"] as const) {
    for (const restarted of [false, true]) {
      it(`(R5-NAMED, the id alone, ${variant}${restarted ? ", after a restart" : ""}) the attempt's own order seen only as the id of a malformed row, then not found by id: ORDER_NOT_FOUND_BY_ID, and never ${variant === "ABSENT" ? "ABSENT" : "PRESENT"} while it stands`, async () => {
        const r0 = await ready();
        r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
        const attempt = (await submitOne(r0.oms)) as string;
        const real = r0.u.world.orders.get(r0.u.world.receipts.at(-1) as string)?.venueOrderId as string;
        if (variant === "PRESENT on a twin") r0.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
        r0.u.world.faults.listOpenOrders = (answer) => {
          const read = answer() as { orders: { venueOrderId: string }[] };
          return { ...read, orders: read.orders.map((row) => (row.venueOrderId === real ? { venueOrderId: real, price: "not a price" } : row)) };
        };
        // (r6) An id with unsettled evidence is read by id in the very run that observed it: here that read fails too,
        // so only the id is known (the premise of this test: nothing of the order validated).
        r0.u.world.faults.readOrder = (id, answer) => {
          if (id === real) throw new Error("timeout");
          return answer();
        };
        expect((await r0.p.coordinator.reconcile()).resumed).toBe(false);
        expect(unresolvedSubjects(r0)).toContain(named(real));
        r0.u.world.faults = {
          listOpenOrders: (answer) => {
            const read = answer() as { orders: { venueOrderId: string }[] };
            return { ...read, orders: read.orders.filter((order) => order.venueOrderId !== real) };
          },
          readOrder: (id, answer) => (id === real ? { route: "/data/order", found: false } : answer()),
        };
        const r = restarted ? await restart(r0) : r0;
        await rounds(r, 4);
        expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
        expect(oracle(r)).toEqual([]);
        await expectPaused(r, false, "ORDER_NOT_FOUND_BY_ID");
        expect(r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("ORDER_NOT_FOUND_BY_ID", real))?.status).toBe("QUARANTINED");
        const ambiguity = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("SIGNED_IDENTITY_AMBIGUOUS", attempt));
        expect(ambiguity?.detail).toContain(`venue order ${real} was only named`);
        expect(r.p.journal.breaks().map((view) => view.subjectKey)).not.toContain(compositeKey("READ_CONFLICT", "order", real));
      });
    }
  }
});

describe("WP-290 r5 (R5-NAMED's family, liveness): a tracked order's id is the OMS's to judge, and withholds no other attempt's answer", () => {
  it("(R5-NAMED, the id alone, a tracked order) a tracked order's id only named (its by-id read failed), then not found: ORDER_STATE_MISMATCH, and another attempt's own order is still answered PRESENT in the same run", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 2)).toBe(true);
    const x = r.oms.orders()[0]?.venueOrderId as string;
    // The other attempt trades the other token (one live order per token: the venue model's S2).
    const second = group(9002, { tokenId: NO, plannedShares: "5" });
    expect((await r.oms.registerGroup(second)).ok).toBe(true);
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const submitted = await r.oms.submit(ticket(second, { n: 980, shares: "1" }));
    expect(submitted.ok).toBe(true);
    const attempt = submitted.ok ? submitted.value.submissionAttemptId : "";
    const own = r.u.world.orders.get(r.u.world.receipts.at(-1) as string)?.venueOrderId as string;
    // The venue cancels x (the OMS does not know), and x's by-id read fails: a READ_MISSING keyed by the order, which
    // only NAMES it.
    r.u.world.cancel(x);
    r.u.world.faults.readOrder = (id, answer) => {
      if (id === x) throw new Error("timeout");
      return answer();
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_MISSING");
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    // Now x's by-id read finds nothing: a tracked order, so the OMS's rule judges it; it is no ghost for the attempt.
    r.u.world.faults.readOrder = (id, answer) => (id === x ? { route: "/data/order", found: false } : answer());
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toContain("ORDER_STATE_MISMATCH");
    expect(report.runs[0]?.answers.map((answer) => [answer.subjectId, answer.verdict, answer.accepted])).toEqual([[attempt, "PRESENT", true]]);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => answer.venueOrderId)).toEqual([own]);
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("ORDER_NOT_FOUND_BY_ID");
    expect(oracle(r)).toEqual([]);
  });
});
