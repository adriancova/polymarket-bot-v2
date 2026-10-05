/**
 * WP-290 r6: the round-6 reproductions, kept as named regressions (the verifiers' probes, typed and repointed).
 *
 * - WP290-CX-R6-01 (class A, evidence forgetting): a 0.4 fill that an UNUSABLE run validated (a partial list's
 *   valid row; a complete list in a run whose by-id read failed; a partial trades answer's valid leg) is evidence:
 *   a later read showing the order canceled with 0 matched is a read behind it, never an answer, never a final size
 *   of 0, never a released reservation, never a resume; with and without a restart (the evidence is the journal's).
 * - WP290-V6-RETAINED-ID-RESOLVES (class A): an id the OMS retains as user-stream evidence, which the by-id read
 *   does not find, is a GHOST like any id only named: no attempt is answered by signed identity while it stands
 *   (neither PRESENT on a foreign twin nor ABSENT), and the stream's fill is never booked UNATTRIBUTED; released by
 *   an operator, the attempt is answered (liveness).
 * - WP290-CX-R6-02 (class D, validity after await): a clock fault detected while the first missed fill is being
 *   delivered stops the second delivery and resolves nothing in that run.
 *
 * Every venue read is the simulated venue's (`support/world.ts`). PAPER only.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import { uuid7 } from "../../unit/oms/support/ids.js";

import { YES, boot, streamTrade } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

interface Orders {
  orders: Record<string, unknown>[];
}
interface Trades {
  trades: Record<string, unknown>[];
}
interface ByIdRead {
  order?: Record<string, unknown>;
}

describe("WP-290 r6 (WP290-CX-R6-01): matched facts an unusable run validated are evidence a later regressing read can never discharge", () => {
  for (const source of ["INCOMPLETE_ORDER", "COMPLETE_UNSOUND", "INCOMPLETE_TRADE", "STALE"] as const) {
    for (const restart of [false, true]) {
      it(`(R6-01, ${source}${restart ? ", after a restart" : ""}) a 0.4 fill seen only by an unusable run; then the order reads canceled with 0 matched: never answered, never released, never resumed`, async () => {
        const r0 = await ready();
        r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
        const attempt = (await submitOne(r0.oms)) as string;
        const salt = r0.u.world.receipts.at(-1) as string;
        const before = r0.u.world.collateral;
        const trade = r0.u.world.match(salt, "0.4");
        expect(trade).toBeDefined();
        const id = trade?.venueOrderId as string;
        if (source === "INCOMPLETE_ORDER") r0.u.world.faults.listOpenOrders = (answer) => ({ ...(answer() as Orders), complete: false });
        if (source === "COMPLETE_UNSOUND") {
          r0.u.world.faults.readOrder = () => {
            throw new Error("timeout");
          };
        }
        if (source === "INCOMPLETE_TRADE") {
          r0.u.world.faults.listOpenOrders = () => ({ route: "/data/orders", complete: true, orders: [] });
          r0.u.world.faults.listTrades = (answer) => ({ ...(answer() as Trades), complete: false });
        }
        // Every read complete and consistent, but the reads span more than the bound: a stale run (READ_STALE).
        if (source === "STALE") {
          r0.u.world.faults.onRead = (name) => {
            if (name === "readPositions") r0.u.clock.t += r0.u.policy.maxReadSpanMs + 1;
          };
        }
        expect((await r0.p.coordinator.reconcile()).resumed).toBe(false);
        r0.u.world.cancel(id);
        // Every later read regresses: no trade, no position, the collateral as before, and the order canceled with 0.
        r0.u.world.faults = {
          listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
          readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
          readCollateral: (answer) => ({ ...(answer() as Record<string, unknown>), balance: before }),
          readOrder: (_id, answer) => {
            const read = answer() as ByIdRead;
            return { ...read, order: { ...(read.order ?? {}), sizeMatched: "0" } };
          },
        };
        const p = restart ? await boot(r0.u) : r0.p;
        const r: Ready = { ...r0, p, oms: p.oms as OrderManager };
        const report = await reconcileRounds(r, 3);
        expect(report).toBe(false);
        expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
        const order = r.oms.orders().find((candidate) => candidate.submissionAttemptId === attempt);
        expect(order?.finalSize ?? null).toBeNull();
        expect(order?.reservation.released).toBe(false);
        expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toEqual(expect.arrayContaining(["READ_REGRESSION"]));
        expect(r.u.resumes).toBe(1);
        expect(oracle(r)).toEqual([]);
        // The evidence the unusable run saw is durable: the journal holds the 0.4.
        expect(r.p.journal.evidence().some((record) => record.venueOrderId === id && record.size === "0.4")).toBe(true);
      });
    }
  }

  for (const soundFirst of [false, true]) {
    it(`(R6-01, control${soundFirst ? ", a sound first run" : ""}) once the reads are truthful, the attempt is answered with the 0.4 and the account resumes consistent`, async () => {
      const r = await ready();
      r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
      await submitOne(r.oms);
      r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
      if (!soundFirst) r.u.world.faults.listOpenOrders = (answer) => ({ ...(answer() as Orders), complete: false });
      await r.p.coordinator.reconcile();
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 4)).toBe(true);
      expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
      expect(oracle(r)).toEqual([]);
    });
  }

  it("(R6-01, control) evidence from a sound run refuses the same regression", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    expect(await reconcileRounds(r, 4)).toBe(true);
    r.u.world.cancel(trade?.venueOrderId as string);
    r.u.world.faults = {
      listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
      readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
      readCollateral: (answer) => ({ ...(answer() as Record<string, unknown>), balance: "1000" }),
      readOrder: (_id, answer) => {
        const read = answer() as ByIdRead;
        return { ...read, order: { ...(read.order ?? {}), sizeMatched: "0" } };
      },
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    expect(oracle(r)).toEqual([]);
  });
});

describe("WP-290 r6 (WP290-CX-R6-01, R5-NAMED): a row or leg that validated in full inside an unusable answer, the ONLY read that saw the order, SHOWED it", () => {
  /** The attempt's order matched 0.4; the first run's only view of it is one valid row (or leg) of an unusable answer. */
  async function onlyRead(only: "ROW" | "LEG"): Promise<{ r: Ready; attempt: string; id: string; before: string }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const before = r.u.world.collateral;
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    const id = trade?.venueOrderId as string;
    const down = (): never => {
      throw new Error("timeout");
    };
    r.u.world.faults =
      only === "ROW"
        ? { listOpenOrders: (answer) => ({ ...(answer() as Orders), complete: false }), listTrades: down, readOrder: down }
        : { listOpenOrders: () => ({ route: "/data/orders", complete: true, orders: [] }), listTrades: (answer) => ({ ...(answer() as Trades), complete: false }), readOrder: down };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    return { r, attempt, id, before };
  }

  /** Asserted last (after the behaviour): the one source that SHOWED the order is the salvaged row or leg. */
  function shownBy(r: Ready, id: string): string[] {
    return r.p.journal.evidence().filter((record) => record.venueOrderId === id && record.provenance === "SHOWN").map((record) => record.source);
  }

  it("(ROW alone) then the order reads canceled with 0 matched: a read behind the row's 0.4 (READ_REGRESSION), never answered, never resumed", async () => {
    const { r, attempt, id, before } = await onlyRead("ROW");
    r.u.world.cancel(id);
    r.u.world.faults = {
      listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
      readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
      readCollateral: (answer) => ({ ...(answer() as Record<string, unknown>), balance: before }),
      readOrder: (_id, answer) => {
        const read = answer() as ByIdRead;
        return { ...read, order: { ...(read.order ?? {}), sizeMatched: "0" } };
      },
    };
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("READ_REGRESSION");
    expect(oracle(r)).toEqual([]);
    expect(shownBy(r, id)[0]).toBe("OPEN_ORDERS_ROW");
  });

  it("(LEG alone) then nothing shows the order and its by-id read does not find it: a contradiction (READ_CONFLICT), never a releasable ghost; never answered, an operator's releases included", async () => {
    const { r, attempt, id } = await onlyRead("LEG");
    r.u.world.faults = {
      listOpenOrders: (answer) => {
        const read = answer() as Orders;
        return { ...read, orders: read.orders.filter((order) => order["venueOrderId"] !== id) };
      },
      listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
      readOrder: (candidate, answer) => (candidate === id ? { route: "/data/order", found: false } : answer()),
    };
    for (let round = 0; round < 3; round += 1) {
      await reconcileRounds(r, 2);
      for (const view of r.p.journal.unresolvedBreaks()) {
        if (view.status === "QUARANTINED") await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason: "released by the test" });
      }
    }
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    const breaks = r.p.journal.breaks();
    expect(breaks.filter((view) => view.breakClass === "ORDER_NOT_FOUND_BY_ID")).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_CONFLICT")?.detail).toContain(id);
    expect(oracle(r)).toEqual([]);
    expect(shownBy(r, id)).toEqual(["TRADES_LEG_SALVAGED"]);
  });
});

describe("WP-290 r6 (WP290-V6-RETAINED-ID-RESOLVES): an id the OMS retains as stream evidence, not found by id, withholds every signed-identity answer", () => {
  /** The attempt's own order is live; the stream names it; then the list leaves it out and its by-id read finds nothing. */
  async function streamNamed(variant: "TWIN" | "ABSENT" | "TWIN-UNSOUND-FIRST"): Promise<{ r: Ready; attempt: string; real: string }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const real = r.u.world.orders.get(r.u.world.receipts.at(-1) as string)?.venueOrderId as string;
    if (variant !== "ABSENT") r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: real, status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    expect(r.oms.retainedEvidence().map((item) => item.venueOrderId)).toEqual([real]);
    const lagging = {
      listOpenOrders: (answer: () => unknown) => {
        const read = answer() as Orders;
        return { ...read, orders: read.orders.filter((order) => order["venueOrderId"] !== real) };
      },
      readOrder: (id: string, answer: () => unknown) => (id === real ? { route: "/data/order", found: false } : answer()),
    };
    if (variant === "TWIN-UNSOUND-FIRST") {
      r.u.world.faults = {
        ...lagging,
        listTrades: () => {
          throw new Error("timeout");
        },
      };
      await r.p.coordinator.reconcile();
    }
    r.u.world.faults = { ...lagging };
    return { r, attempt, real };
  }

  for (const variant of ["TWIN", "ABSENT", "TWIN-UNSOUND-FIRST"] as const) {
    it(`(P6-STREAM-${variant}) never answered while the retained id is not found: no PRESENT on a twin, no ABSENT; a releasable ORDER_NOT_FOUND_BY_ID`, async () => {
      const { r, attempt, real } = await streamNamed(variant);
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
      expect(oracle(r)).toEqual([]);
      const ghost = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("ORDER_NOT_FOUND_BY_ID", real));
      expect(ghost?.status).toBe("QUARANTINED");
      expect(r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("SIGNED_IDENTITY_AMBIGUOUS", attempt))?.detail).toContain(real);
    });
  }

  it("(P6-STREAM-DIRECT) the same when the stream reached the OMS without passing through the coordinator: the id the OMS retains is evidence of its own (OMS_RETAINED); no PRESENT on the twin, a releasable ORDER_NOT_FOUND_BY_ID", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const real = r.u.world.orders.get(r.u.world.receipts.at(-1) as string)?.venueOrderId as string;
    r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    // A composition that hands the stream's projection to the OMS itself: the coordinator never sees it.
    expect((await r.oms.applyOrderObservation({ venueOrderId: real, status: "LIVE" })).ok).toBe(false);
    expect(r.oms.retainedEvidence().map((item) => item.venueOrderId)).toEqual([real]);
    r.u.world.faults = {
      listOpenOrders: (answer) => {
        const read = answer() as Orders;
        return { ...read, orders: read.orders.filter((order) => order["venueOrderId"] !== real) };
      },
      readOrder: (id, answer) => (id === real ? { route: "/data/order", found: false } : answer()),
    };
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(oracle(r)).toEqual([]);
    const ghost = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("ORDER_NOT_FOUND_BY_ID", real));
    expect(ghost?.status).toBe("QUARANTINED");
    expect(ghost?.detail).toContain("OMS_RETAINED");
    // Asserted last: the coordinator never saw the stream; its only source for the id is the OMS's retention.
    expect(r.p.journal.evidence().filter((record) => record.venueOrderId === real).map((record) => record.source)).toContain("OMS_RETAINED");
    expect(r.p.journal.evidence().filter((record) => record.venueOrderId === real).map((record) => record.source)).not.toContain("STREAM_ORDER");
  });

  it("(P6-STREAM-SETTLED) a retained id of the attempt's own order, canceled with nothing matched, and a live foreign twin: read by id in every run while the OMS retains it (its evidence settled included); never PRESENT on the twin", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const real = r.u.world.orders.get(r.u.world.receipts.at(-1) as string)?.venueOrderId as string;
    r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: real, status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    expect(r.oms.retainedEvidence().map((item) => item.venueOrderId)).toEqual([real]);
    // The venue cancels the attempt's own order with nothing matched: only its by-id read shows it any more (E-14).
    r.u.world.cancel(real);
    for (let round = 0; round < 4; round += 1) {
      await r.p.coordinator.reconcile();
      r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
    }
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("SIGNED_IDENTITY_AMBIGUOUS", attempt))?.detail).toContain(real);
    expect(oracle(r)).toEqual([]);
  });

  it("(r6, an id only the stream named) the OMS refuses it (no attempt could own it): it is read by id in the very next run (E-14), not first reported unread; not found, a ghost at once", async () => {
    const r = await ready();
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: "venue-phantom-2", status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    const first = report.runs[0]?.detections ?? [];
    expect(first.map((detection) => detection.subjectKey)).toContain(compositeKey("ORDER_NOT_FOUND_BY_ID", "venue-phantom-2"));
    expect(first.map((detection) => detection.breakClass)).not.toContain("READ_MISSING");
    expect(oracle(r)).toEqual([]);
    // Asserted last: the stream's report was recorded as evidence the moment it was routed (and is its only source).
    // (r11) The holdings each run reads are evidence too now (HOLDING, detail only): the venue-object records are these.
    expect(r.p.journal.evidence().filter((record) => record.evidenceKind !== "HOLDING").map((record) => [record.venueOrderId, record.source])).toEqual([["venue-phantom-2", "STREAM_ORDER"]]);
  });

  it("(P6-STREAM-FILL-TWIN) a retained fill of the attempt's own order, a live foreign twin, every read lagging: never PRESENT on the twin, the fill never booked UNATTRIBUTED", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const salt = r.u.world.receipts.at(-1) as string;
    r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    const trade = r.u.world.match(salt, "0.4");
    const x = trade?.venueOrderId as string;
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? ""));
    await r.p.coordinator.settled();
    expect(r.oms.retainedEvidence().map((item) => item.venueOrderId)).toEqual([x]);
    r.u.world.faults = {
      listOpenOrders: (answer) => {
        const read = answer() as Orders;
        return { ...read, orders: read.orders.filter((order) => order["venueOrderId"] !== x) };
      },
      readOrder: (id, answer) => (id === x ? { route: "/data/order", found: false } : answer()),
      listTrades: (answer) => {
        const read = answer() as Trades;
        return { ...read, trades: read.trades.filter((entry) => entry["venueTradeId"] !== trade?.venueTradeId) };
      },
    };
    for (let round = 0; round < 4; round += 1) {
      await r.p.coordinator.reconcile();
      r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
    }
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("POSITION_UNATTRIBUTED");
    expect(r.p.journal.breaks().map((view) => view.breakClass)).not.toContain("BALANCE_UNATTRIBUTED");
    expect(oracle(r)).toEqual([]);
  });

  it("(liveness) a stream-named id the venue truly does not have: released by an operator, the attempt is answered PRESENT on its own order, and the account resumes", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const own = r.u.world.orders.get(r.u.world.receipts.at(-1) as string)?.venueOrderId as string;
    // The stream names an id the venue never had (it retains it: the attempt could own it).
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: "venue-phantom", status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    let resumed = false;
    for (let round = 0; round < 3 && !resumed; round += 1) {
      for (const view of r.p.journal.unresolvedBreaks()) {
        if (view.status !== "QUARANTINED") continue;
        expect((await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason: "not the account's order" })).ok).toBe(true);
      }
      resumed = await reconcileRounds(r, 4);
    }
    expect(resumed).toBe(true);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", own]]);
    expect(oracle(r)).toEqual([]);
  });
});

describe("WP-290 r6 (WP290-CX-R6-02): a clock fault detected during an awaited delivery stops every later commit of that run", () => {
  for (const variant of ["FAULT", "SOUND"] as const) {
    it(`(R6-02, ${variant}) two missed fills; ${variant === "FAULT" ? "the clock faults while the first is delivered: the second is not delivered and nothing is resolved in that run" : "control: both delivered and resolved in the run"}`, async () => {
      const r = await ready();
      await submitOne(r.oms);
      const salt = r.u.world.receipts.at(-1) as string;
      r.u.world.match(salt, "0.2");
      r.u.world.match(salt, "0.2");
      const real = r.oms.recordFill.bind(r.oms);
      let fired = false;
      let deliveredAfterFault = 0;
      let faulted = false;
      // Only the first run's deliveries count (a later run of the same call may deliver what was withheld).
      let firstCompleted = false;
      const append = r.p.journal.append.bind(r.p.journal);
      r.p.journal.append = async (event: unknown) => {
        if ((event as { kind?: unknown }).kind === "RUN_COMPLETED") firstCompleted = true;
        return append(event);
      };
      r.oms.recordFill = async (raw: unknown) => {
        if (faulted && !firstCompleted) deliveredAfterFault += 1;
        const result = await real(raw);
        if (variant === "FAULT" && !fired) {
          fired = true;
          const t = r.u.clock.t;
          r.u.clock.t = Number.NaN;
          await r.p.coordinator.releaseQuarantine({ breakId: uuid7(0xdead, 1), operatorRef: "review", reason: "clock fault probe" });
          faulted = true;
          r.u.clock.t = t;
        }
        return result;
      };
      const report = await r.p.coordinator.reconcile();
      const firstRun = report.runs[0]?.runId;
      const resolvedInFirst = r.p.journal.events().filter((event) => event.kind === "BREAK_RESOLVED" && event.runId === firstRun);
      if (variant === "FAULT") {
        // The first run delivered one fill, then stopped: the second waits for a fresh run (which this call makes).
        expect(deliveredAfterFault).toBe(0);
        expect(resolvedInFirst).toEqual([]);
        expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toContain("READ_STALE");
        expect(report.runs[0]?.resumed).toBe(false);
        // A fresh run delivers the rest and resumes consistent.
        expect(report.resumed || (await reconcileRounds(r, 3))).toBe(true);
      } else {
        expect(r.u.store.snapshotSync().fills).toHaveLength(2);
        expect(resolvedInFirst.length).toBeGreaterThan(0);
      }
      expect(r.u.store.snapshotSync().fills).toHaveLength(2);
      expect(oracle(r)).toEqual([]);
    });
  }
});
