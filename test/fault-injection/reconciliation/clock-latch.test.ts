/**
 * WP-290 r5 (WP290-CX-R5-02): A CLOCK FAULT DETECTED AT ANY POINT OF A RUN IS LATCHED INTO THE RUN.
 *
 * The coordinator measures two things with its own clock: the quiescence an ABSENT attests (receipt, then a full
 * horizon, then the reads), and the time over which an unexplained delta is confirmed. A reading that is unreadable
 * or went backwards means no earlier reading can be trusted to measure either. Before r5 that was checked only just
 * after the reads: a fault the coordinator detected later (while it recorded an answer, at its closing reading, or
 * while the PASSED record was written) left the run valid, so an ABSENT queued before the fault was still given
 * (for an order still travelling, in the late-arrival case), and the run passed and resumed.
 *
 * Now, from the moment a fault is detected, the run concludes nothing more: no further answer (OMS, wallet, stream),
 * no booking, no action on a break, no clearing; it records `READ_STALE`, and it does not resume. Every pending OMS
 * request's quiescence window restarts, so a later run, with fresh reads and a full horizon after the restart,
 * answers what was withheld. What the run did before the fault was detected stands.
 *
 * The faults are injected where the coordinator would detect them: after an answer is applied (its record reads the
 * clock), during the record of an answer (the run's closing reading detects it), and while the PASSED record is
 * written (an operator's release attempted then reads the clock). Every venue read is the simulated venue's
 * (`support/world.ts`). PAPER only.
 */

import { describe, expect, it } from "vitest";

import type { ReconciliationJournalEvent } from "../../../packages/ledger/src/index.js";
import { compositeKey } from "../../../packages/oms/src/guards.js";
import { group, ticket } from "../../unit/oms/support/harness.js";
import { uuid7 } from "../../unit/oms/support/ids.js";

import { YES } from "./support/harness.js";
import { G_YES, expectPaused, ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

type Fault = "BACKWARD" | "UNREADABLE";

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

function events(r: Ready, kind: ReconciliationJournalEvent["kind"]): ReconciliationJournalEvent[] {
  return r.p.journal.events().filter((event) => event.kind === kind);
}

function unresolvedClasses(r: Ready): string[] {
  return r.p.journal.unresolvedBreaks().map((view) => view.breakClass);
}

/**
 * After the `nth` OMS answer is applied, the clock steps back 1 ms or becomes unreadable (the record of that answer
 * reads it, and detects the fault). Returns a function that makes the clock sound again.
 */
function faultAfterAnswer(r: Ready, fault: Fault, nth = 1): () => void {
  const sound = { t: 0 };
  let applied = 0;
  r.u.seams.applyReconciliation = async (raw, real) => {
    const result = await real(raw);
    applied += 1;
    if (applied === nth) {
      sound.t = r.u.clock.t;
      r.u.clock.t = fault === "BACKWARD" ? r.u.clock.t - 1 : Number.NaN;
    }
    return result;
  };
  return () => {
    delete r.u.seams.applyReconciliation;
    if (Number.isNaN(r.u.clock.t)) r.u.clock.t = sound.t;
  };
}

/** Run `inject` once, while the coordinator appends the first event `when` selects (before it is durable). */
function duringAppend(r: Ready, when: (event: { readonly kind?: string; readonly status?: string }) => boolean, inject: () => void): () => boolean {
  const append = r.p.journal.append.bind(r.p.journal);
  let fired = false;
  r.p.journal.append = async (event: unknown) => {
    if (!fired && when(event as { kind?: string; status?: string })) {
      fired = true;
      inject();
    }
    return append(event);
  };
  return () => fired;
}

/** A tracked live order of the account, and a pending ORDER_STATE request about it (answered PRESENT by a run). */
async function trackedOrderRequest(r: Ready): Promise<string> {
  await submitOne(r.oms);
  const order = r.oms.orders().at(-1);
  expect((await r.oms.requestOrderReconciliation(order?.orderId as string)).ok).toBe(true);
  return order?.orderId as string;
}

class FakeStream {
  readonly pending: { readonly requestId: string; readonly cause: string; readonly markets: readonly string[] }[] = [];
  readonly acknowledged: string[] = [];
  pendingReconciliationRequests(): readonly { readonly requestId: string; readonly cause: string; readonly markets: readonly string[] }[] {
    return [...this.pending];
  }
  acknowledgeReconciliationRequest(requestId: string): boolean {
    const index = this.pending.findIndex((request) => request.requestId === requestId);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.acknowledged.push(requestId);
    return true;
  }
}

describe("WP-290 r5 (WP290-CX-R5-02): a clock fault detected after the reads is latched into the run", () => {
  for (const fault of ["BACKWARD", "UNREADABLE"] as const) {
    it(`(R5-02, one answer, ${fault}) the fault detected while the answer is recorded: READ_STALE is recorded, the run does not pass and does not resume; a later run with a sound clock does`, async () => {
      const r = await ready();
      await trackedOrderRequest(r);
      const restore = faultAfterAnswer(r, fault);
      const report = await r.p.coordinator.reconcile();
      const run = report.runs[0];
      // The answer given before the fault stands.
      expect(run?.answers.map((answer) => [answer.verdict, answer.accepted])).toEqual([["PRESENT", true]]);
      expect(run?.detections.map((detection) => detection.breakClass)).toContain("READ_STALE");
      expect(run?.status).toBe("FAILED");
      expect(run?.reason).toContain("the clock was unreadable or went backwards during the run");
      await expectPaused(r, report.resumed, "READ_STALE");
      expect(events(r, "RUN_COMPLETED").find((event) => event.kind === "RUN_COMPLETED" && event.runId === run?.runId)).toMatchObject({ status: "FAILED" });
      expect(events(r, "RESUME_REFUSED")).toEqual([]);
      restore();
      expect(await reconcileRounds(r, 2)).toBe(true);
      expect(unresolvedClasses(r)).toEqual([]);
      expect(oracle(r)).toEqual([]);
    });
  }

  it("(R5-02, the closing reading) the clock steps back while the run records its last answer, and only its closing reading sees it: READ_STALE, not resumed", async () => {
    const r = await ready();
    await trackedOrderRequest(r);
    const fired = duringAppend(r, (event) => event.kind === "ANSWER_RECORDED", () => {
      r.u.clock.t -= 1;
    });
    const report = await r.p.coordinator.reconcile();
    expect(fired()).toBe(true);
    expect(report.runs[0]?.answers.map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    expect(report.runs[0]?.status).toBe("FAILED");
    await expectPaused(r, report.resumed, "READ_STALE");
    expect(events(r, "RESUME_REFUSED")).toEqual([]);
    expect(await reconcileRounds(r, 2)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  for (const fault of ["BACKWARD", "UNREADABLE"] as const) {
    it(`(R5-02, between answers, ${fault}) two queued ABSENT answers, the fault detected after the first: the second is withheld; its window restarts, and a later run answers it`, async () => {
      const r = await ready();
      const second = group(9002, { tokenId: YES, plannedShares: "5" });
      expect((await r.oms.registerGroup(second)).ok).toBe(true);
      r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT", "UNKNOWN_ABSENT"]);
      expect((await r.oms.submitBatch([ticket(G_YES, { n: 950, shares: "1" }), ticket(second, { n: 951, shares: "1" })])).ok).toBe(true);
      r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
      const restore = faultAfterAnswer(r, fault);
      const report = await r.p.coordinator.reconcile();
      expect(r.u.accepted.map((answer) => [answer.verdict, answer.quiescent])).toEqual([["ABSENT", true]]);
      expect(report.runs.flatMap((run) => run.answers)).toHaveLength(1);
      await expectPaused(r, report.resumed, "READ_STALE");
      restore();
      // Its window restarted at the fault: the next run, at once, does not answer it yet.
      r.p.coordinator.trigger("PERIODIC_TIMER");
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      expect(r.u.accepted).toHaveLength(1);
      expect(await reconcileRounds(r, 3)).toBe(true);
      expect(r.u.accepted.map((answer) => [answer.verdict, answer.quiescent])).toEqual([
        ["ABSENT", true],
        ["ABSENT", true],
      ]);
      expect(oracle(r)).toEqual([]);
    });
  }

  it("(R5-02, late arrival) the coordinator's clock ran a horizon ahead of the venue's and is corrected back after the first ABSENT: the second attempt, still travelling, is never answered ABSENT; it is found PRESENT once it arrives", async () => {
    const r = await ready();
    const second = group(9002, { tokenId: YES, plannedShares: "5" });
    expect((await r.oms.registerGroup(second)).ok).toBe(true);
    r.u.world.lateMs = 1000; // under the horizon: the transmission is still travelling when the reads run
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT", "LATE_ARRIVAL"]);
    expect((await r.oms.submitBatch([ticket(G_YES, { n: 960, shares: "1" }), ticket(second, { n: 961, shares: "1" })])).ok).toBe(true);
    let ahead = r.u.policy.quiescenceHorizonMs + 1;
    r.u.seams.localClock = (venueMs) => venueMs + ahead;
    let first = true;
    r.u.seams.applyReconciliation = async (raw, real) => {
      const result = await real(raw);
      if (first) {
        first = false;
        ahead = 0; // corrected: the next reading is lower, so the coordinator detects the step
      }
      return result;
    };
    const report = await r.p.coordinator.reconcile();
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["ABSENT"]);
    expect(oracle(r)).toEqual([]);
    await expectPaused(r, report.resumed, "READ_STALE");
    delete r.u.seams.applyReconciliation;
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["ABSENT", "PRESENT"]);
    expect(oracle(r)).toEqual([]);
  });

  it("(R5-02, stream) the fault detected while an OMS answer is recorded: a WP-280 request pending in the same run is not acknowledged by it; the next run acknowledges it", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    await trackedOrderRequest(r);
    const request = { requestId: "gap-r5", cause: "SOCKET_CLOSED", markets: [] };
    stream.pending.push(request);
    r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request });
    const restore = faultAfterAnswer(r, "UNREADABLE");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.answers.map((answer) => answer.channel)).toEqual(["ORDER"]);
    expect(stream.acknowledged).toEqual([]);
    await expectPaused(r, report.resumed, "READ_STALE");
    restore();
    expect(await reconcileRounds(r, 2)).toBe(true);
    expect(stream.acknowledged).toEqual(["gap-r5"]);
  });

  it("(R5-02, booking) the fault detected while an OMS answer is recorded: a confirmed unexplained delta is not booked by that run; a later run books it", async () => {
    const r = await ready();
    const orderId = (await submitOne(r.oms)) === null ? null : r.oms.orders().at(-1)?.orderId;
    r.u.world.adjustPosition(YES, "3");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "HOLDING_DELTA_UNCONFIRMED");
    r.u.clock.t += r.u.policy.holdingConfirmationMs;
    expect((await r.oms.requestOrderReconciliation(orderId as string)).ok).toBe(true);
    const restore = faultAfterAnswer(r, "UNREADABLE");
    const report = await r.p.coordinator.reconcile();
    const corrections = (): number => r.u.ledger.transactions().filter((appended) => appended.transaction.eventType === "RECONCILIATION_CORRECTION").length;
    expect(corrections()).toBe(0);
    expect(report.runs[0]?.detections.find((detection) => detection.breakClass === "HOLDING_DELTA_UNCONFIRMED")?.detail).toContain("not booked: the clock was unreadable or went backwards");
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).not.toContain("POSITION_UNATTRIBUTED");
    await expectPaused(r, report.resumed, "READ_STALE");
    restore();
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "POSITION_UNATTRIBUTED");
    expect(corrections()).toBe(1);
  });

  it("(R5-02, an act) the fault detected while an OMS answer is recorded: a missed fill found by that run is not delivered by it (TRADE_MISSING_IN_OMS stays open); the next run delivers it", async () => {
    const r = await ready();
    const second = group(9002, { tokenId: YES, plannedShares: "5" });
    expect((await r.oms.registerGroup(second)).ok).toBe(true);
    expect((await r.oms.submitBatch([ticket(G_YES, { n: 970, shares: "1" }), ticket(second, { n: 971, shares: "1" })])).ok).toBe(true);
    const [first, other] = r.oms.orders();
    const missed = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    expect(missed?.venueOrderId).toBe(other?.venueOrderId);
    expect((await r.oms.requestOrderReconciliation(first?.orderId as string)).ok).toBe(true);
    const restore = faultAfterAnswer(r, "UNREADABLE");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toEqual(expect.arrayContaining(["TRADE_MISSING_IN_OMS", "READ_STALE"]));
    expect(r.oms.orders().find((order) => order.orderId === other?.orderId)?.filledShares).toBe("0");
    expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "TRADE_MISSING_IN_OMS")?.status).toBe("OPEN");
    expect(events(r, "BREAK_RESOLVED").filter((event) => event.kind === "BREAK_RESOLVED" && event.resolution === "RESOLVED_IN_RUN")).toEqual([]);
    await expectPaused(r, report.resumed, "READ_STALE");
    restore();
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.oms.orders().find((order) => order.orderId === other?.orderId)?.filledShares).toBe("0.4");
    expect(oracle(r)).toEqual([]);
  });

  it("(r6, R5-C5, a state act) the fault detected while an OMS answer is recorded: a tracked order the venue shows CANCELED is not routed to the OMS by that run (no act, ORDER_STATE_MISMATCH stays open); the next run routes it", async () => {
    const r = await ready();
    const second = group(9003, { tokenId: YES, plannedShares: "5" });
    expect((await r.oms.registerGroup(second)).ok).toBe(true);
    expect((await r.oms.submitBatch([ticket(G_YES, { n: 972, shares: "1" }), ticket(second, { n: 973, shares: "1" })])).ok).toBe(true);
    const [first, other] = r.oms.orders();
    r.u.world.cancel(other?.venueOrderId as string);
    expect((await r.oms.requestOrderReconciliation(first?.orderId as string)).ok).toBe(true);
    const routed: string[] = [];
    const real = r.oms.requestOrderReconciliation.bind(r.oms);
    r.oms.requestOrderReconciliation = async (orderId) => {
      routed.push(orderId);
      return real(orderId);
    };
    const restore = faultAfterAnswer(r, "UNREADABLE");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toEqual(expect.arrayContaining(["ORDER_STATE_MISMATCH", "READ_STALE"]));
    // Found, recorded (a hold), but not acted on: the latch is checked before every act.
    expect(routed).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_STATE_MISMATCH")?.status).toBe("OPEN");
    await expectPaused(r, report.resumed, "READ_STALE");
    restore();
    await reconcileRounds(r, 3);
    expect(routed).toContain(other?.orderId);
    expect(oracle(r)).toEqual([]);
  });

  it("(R5-02, clearing) the fault detected while an OMS answer is recorded: a hold an earlier run left, which this run's complete reads no longer find, is not cleared by it; the next run clears it", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.faults.listTrades = () => {
      throw new Error("timeout");
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "READ_MISSING");
    r.u.world.faults = {};
    expect((await r.oms.requestOrderReconciliation(r.oms.orders()[0]?.orderId as string)).ok).toBe(true);
    const restore = faultAfterAnswer(r, "UNREADABLE");
    const report = await r.p.coordinator.reconcile();
    const runId = report.runs[0]?.runId;
    expect(events(r, "BREAK_RESOLVED").filter((event) => event.kind === "BREAK_RESOLVED" && event.runId === runId)).toEqual([]);
    expect(unresolvedClasses(r)).toEqual(expect.arrayContaining(["READ_MISSING", "READ_STALE"]));
    await expectPaused(r, report.resumed, "READ_MISSING");
    restore();
    expect(await reconcileRounds(r, 2)).toBe(true);
    expect(unresolvedClasses(r)).toEqual([]);
  });

  it("(R5-02, the final journal boundary) an operator's release attempted with an unreadable clock while the PASSED record is written: that run does not resume (RECON_CLOCK_FAULT); the next run, at once, does", async () => {
    const r = await ready();
    await trackedOrderRequest(r);
    let attempted: Promise<unknown> | null = null;
    const fired = duringAppend(
      r,
      (event) => event.kind === "RUN_COMPLETED" && event.status === "PASSED",
      () => {
        const at = r.u.clock.t;
        r.u.clock.t = Number.NaN;
        attempted = r.p.coordinator.releaseQuarantine({ breakId: uuid7(0xdead, 1), operatorRef: "operator-1", reason: "a release while the clock is unreadable" });
        r.u.clock.t = at;
      },
    );
    const resumesBefore = r.u.resumes;
    const report = await r.p.coordinator.reconcile();
    expect(fired()).toBe(true);
    expect(await attempted).toMatchObject({ ok: false, code: "CLOCK_UNREADABLE" });
    const [first, next] = report.runs;
    expect(first?.resumed).toBe(false);
    expect(first?.rerun).toBe(true);
    expect(first?.reason).toContain("while the run's completion was being recorded");
    expect(events(r, "RESUME_REFUSED")).toEqual([expect.objectContaining({ runId: first?.runId, refusalCode: "RECON_CLOCK_FAULT" })]);
    expect(next?.resumed).toBe(true);
    expect(r.u.resumes - resumesBefore).toBe(1);
    expect(oracle(r)).toEqual([]);
  });
});

describe("WP-290 r5 (WP290-CX-R5-02, M08): a clock fault DURING the reads concludes nothing from them", () => {
  it("(R5-02, during the reads) the clock steps back as a request arrives mid-read, and the closing reading is sound again: the run writes nothing to the OMS from those reads (no settlement), records READ_STALE; the next run, at once, does write it", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4", { status: "MINED" });
    expect(await reconcileRounds(r, 4)).toBe(true);
    const states = (): string[] => r.u.store.snapshotSync().settlements.map((record) => record.state);
    expect(states()).toContain("MINED");
    expect(states()).not.toContain("CONFIRMED");
    if (trade !== undefined) trade.status = "CONFIRMED";
    let stepped = false;
    r.u.world.faults.onRead = (name) => {
      if (name !== "listTrades" || stepped) return;
      stepped = true;
      // Only the receipt's reading sees the step (the closing reading equals it, so it is sound again).
      r.u.clock.t -= 10;
      const request = { requestId: "gap-mid-read", cause: "SOCKET_CLOSED", markets: [] };
      stream.pending.push(request);
      r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request });
    };
    let atFirstCompletion = null as string[] | null;
    duringAppend(r, (event) => event.kind === "RUN_COMPLETED", () => {
      atFirstCompletion = states();
    });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toContain("READ_STALE");
    expect(report.runs[0]?.status).toBe("FAILED");
    // Nothing was written to the OMS from the stale reads: the CONFIRMED settlement was not recorded by that run.
    expect(atFirstCompletion).not.toBeNull();
    expect(atFirstCompletion ?? []).not.toContain("CONFIRMED");
    // The next run, at once (the request arrived during the first), reads afresh and records it.
    expect(report.runs[1]?.status).toBeDefined();
    expect(states()).toContain("CONFIRMED");
    expect(oracle(r)).toEqual([]);
  });

  it("(r6, M08) the same step during the reads, with a foreign order listed: the stale run classifies nothing (no ORDER_UNATTRIBUTED quarantine from those reads; the order is only held, read by id); the next run, at once, classifies it", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.3", size: "2" });
    let stepped = false;
    r.u.world.faults.onRead = (name) => {
      if (name !== "listTrades" || stepped) return;
      stepped = true;
      r.u.clock.t -= 10;
      const request = { requestId: "gap-mid-read-2", cause: "SOCKET_CLOSED", markets: [] };
      stream.pending.push(request);
      r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request });
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    const [first, next] = report.runs;
    expect(first?.detections.map((detection) => detection.breakClass)).toContain("READ_STALE");
    // Nothing concluded from the stale reads: the foreign order is held as unclassified, never quarantined by them.
    expect(first?.detections.map((detection) => detection.breakClass)).not.toContain("ORDER_UNATTRIBUTED");
    expect(first?.detections.map((detection) => detection.subjectKey)).toContain(compositeKey("ORDER_UNRESOLVED", "venue-order", foreign.venueOrderId));
    const openedBy = (runId: string | null | undefined): string[] =>
      events(r, "BREAK_OPENED")
        .filter((event) => "runId" in event && event.runId === runId)
        .map((event) => ("breakClass" in event ? event.breakClass : ""));
    expect(openedBy(first?.runId)).not.toContain("ORDER_UNATTRIBUTED");
    // The next run, at once (the request arrived during the first), reads afresh and classifies it.
    expect(next?.detections.map((detection) => detection.breakClass)).toContain("ORDER_UNATTRIBUTED");
    expect(openedBy(next?.runId)).toContain("ORDER_UNATTRIBUTED");
    expect(oracle(r)).toEqual([]);
  });
});
