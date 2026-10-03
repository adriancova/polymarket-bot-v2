/**
 * WP-290 deliverable 3: RESUME ONLY AFTER EVERY REQUIRED INVARIANT PASSES,
 * at the moment of resuming, and never on work that arrived after the
 * decision.
 *
 * - The decision to resume is taken, then the PASSED record is written
 *   (awaited), then the OMS resumes. Work that arrives while the record is
 *   being written (a trigger, a WP-280 request) pauses the OMS, and that run
 *   must not undo the pause (I-01): it records `RESUME_REFUSED`, and the
 *   next run, at once, answers the new work.
 * - Work that arrives during the reads (a trigger) makes the run's reads
 *   older than it: the run does not resume, and another follows (I-10, X4).
 * - One run at a time: a second `reconcile()` in the same tick, or during a
 *   run, finds the run in progress, and never closes it as interrupted (I-07).
 * - A journal whose unresolved breaks cannot be read never lets a run resume
 *   (fail closed, I-14).
 * - Every OMS halting alert is its own quarantine: a release acknowledges that
 *   one alert, never a later one like it, in this process or after a restart
 *   (R2-C).
 * - What still holds the account at the end of a run is recorded: an attempt
 *   awaiting its read, an order still reconciling (R2-E).
 */

import { describe, expect, it } from "vitest";

import type { ReconciliationJournal, ReconciliationJournalEvent } from "../../../packages/ledger/src/index.js";
import type { OmsAlert, OrderManager, ReconciliationJournalPort } from "../../../packages/oms/src/index.js";

import { MARKET, boot } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

/** Run `inject` once, while the coordinator's PASSED completion is being appended (before it is durable). */
function duringPassedWrite(r: Ready, inject: () => void): { readonly fired: () => boolean; readonly pausedAtNextStart: () => boolean | null } {
  const append = r.p.journal.append.bind(r.p.journal);
  let fired = false;
  let pausedAtNextStart: boolean | null = null;
  r.p.journal.append = async (event: unknown) => {
    const kind = (event as { kind?: string }).kind;
    if (!fired && kind === "RUN_COMPLETED" && (event as { status?: string }).status === "PASSED") {
      fired = true;
      inject();
    } else if (fired && pausedAtNextStart === null && kind === "RUN_STARTED") {
      pausedAtNextStart = r.oms.paused;
    }
    return append(event);
  };
  return { fired: () => fired, pausedAtNextStart: () => pausedAtNextStart };
}

function events(r: Ready, kind: ReconciliationJournalEvent["kind"]): ReconciliationJournalEvent[] {
  return r.p.journal.events().filter((event) => event.kind === kind);
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

describe("WP-290 deliverable 3: resume only when every invariant still holds at the moment of resuming", () => {
  it("(I-01) a trigger raised while the PASSED record is being written: that run does not resume; the next run, at once, does", async () => {
    const r = await ready();
    const resumesBefore = r.u.resumes;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const probe = duringPassedWrite(r, () => r.p.coordinator.trigger("MARKET_STREAM_GAP"));
    const report = await r.p.coordinator.reconcile();
    expect(probe.fired()).toBe(true);
    const [first, second] = report.runs;
    expect(first?.resumed, "the run whose decision predates the trigger").toBe(false);
    expect(first?.rerun).toBe(true);
    expect(first?.reason).toContain("work arrived while the run's completion was being recorded");
    expect(events(r, "RESUME_REFUSED")).toEqual([expect.objectContaining({ runId: first?.runId, refusalCode: "RECON_WORK_ARRIVED" })]);
    expect(probe.pausedAtNextStart(), "submissions stayed paused until the next run").toBe(true);
    expect(second?.triggers).toContain("MARKET_STREAM_GAP");
    expect(second?.resumed).toBe(true);
    expect(r.u.resumes - resumesBefore, "one resume, by the run that answered the trigger").toBe(1);
    expect(r.u.violations).toEqual([]);
  });

  it("(I-01) a WP-280 request raised while the PASSED record is being written: never acknowledged or resumed past by that run", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const request = { requestId: "late-gap", cause: "SOCKET_CLOSED", markets: [] };
    const probe = duringPassedWrite(r, () => {
      stream.pending.push(request);
      r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request });
    });
    const report = await r.p.coordinator.reconcile();
    expect(probe.fired()).toBe(true);
    expect(report.runs[0]?.resumed).toBe(false);
    expect(report.runs[0]?.answers).toEqual([]);
    expect(probe.pausedAtNextStart()).toBe(true);
    expect(report.runs[1]?.answers.map((answer) => [answer.channel, answer.requestId, answer.accepted])).toEqual([["USER_STREAM", "late-gap", true]]);
    expect(report.runs[1]?.resumed).toBe(true);
    expect(stream.acknowledged).toEqual(["late-gap"]);
    expect(r.p.coordinator.status().pendingStreamRequests).toBe(0);
  });

  it("(I-10, X4) a trigger raised during the reads: the run does not resume on reads older than it; the next run does", async () => {
    const r = await ready();
    let raised = false;
    r.u.world.faults.onRead = (name) => {
      if (name === "listTrades" && !raised) {
        raised = true;
        r.p.coordinator.trigger("MARKET_STREAM_GAP");
      }
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(raised).toBe(true);
    expect(report.runs.map((run) => [run.triggers, run.resumed])).toEqual([
      [["PERIODIC_TIMER"], false],
      [["MARKET_STREAM_GAP"], true],
    ]);
    expect(report.runs[0]?.reason).toBe("work arrived during the run");
  });

  it("(I-07) one run at a time: a second call in the same tick and a third during the reads find the run in progress", async () => {
    const r = await ready();
    let runningDuringReads: boolean | null = null;
    let third: Promise<Awaited<ReturnType<typeof r.p.coordinator.reconcile>>> | null = null;
    r.u.world.faults.onRead = (name) => {
      if (name === "readPositions" && third === null) {
        runningDuringReads = r.p.coordinator.status().running;
        third = r.p.coordinator.reconcile();
      }
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const [a, b] = await Promise.all([r.p.coordinator.reconcile(), r.p.coordinator.reconcile()]);
    const c = await (third as unknown as Promise<Awaited<ReturnType<typeof r.p.coordinator.reconcile>>>);
    expect(runningDuringReads).toBe(true);
    expect(a.resumed).toBe(true);
    for (const other of [b, c]) {
      expect(other.runs.map((run) => [run.status, run.reason])).toEqual([["NOT_RUN", "a run is already in progress"]]);
    }
    // No run was closed as interrupted, and the journal refused nothing.
    const completions = events(r, "RUN_COMPLETED");
    expect(completions.filter((event) => event.kind === "RUN_COMPLETED" && event.detail.startsWith("interrupted"))).toEqual([]);
    expect(completions.filter((event) => event.kind === "RUN_COMPLETED" && event.status === "FAILED")).toEqual([]);
    expect(r.p.coordinator.status().running).toBe(false);
  });

  it("(I-14) a journal whose unresolved breaks cannot be read never lets a run resume (fail closed)", async () => {
    let failing = false;
    const wrap = (journal: ReconciliationJournal): ReconciliationJournalPort => ({
      get faulted() {
        return journal.faulted;
      },
      get runningRunId() {
        return journal.runningRunId;
      },
      ruleOf: (breakClass) => journal.ruleOf(breakClass),
      releaseAcknowledgesSubject: (breakClass) => journal.releaseAcknowledgesSubject(breakClass),
      breaks: () => journal.breaks(),
      unresolvedBreaks: () => {
        if (failing) throw new Error("the journal's read side is down");
        return journal.unresolvedBreaks();
      },
      append: (event) => journal.append(event),
    });
    const r = await ready({ seams: { journal: wrap } });
    failing = true;
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.oms.paused).toBe(true);
    const completions = events(r, "RUN_COMPLETED").slice(1);
    expect(completions.length).toBeGreaterThan(0);
    expect(completions.every((event) => event.kind === "RUN_COMPLETED" && event.status !== "PASSED")).toBe(true);
    failing = false;
    expect(await reconcileRounds(r, 3)).toBe(true);
  });
});

describe("WP-290 deliverable 3: each OMS halting alert is its own quarantine (r2, R2-C)", () => {
  /** One BUY order matched by two trades, both MINED; reconciled and resumed. */
  async function twoTrades(): Promise<{ r: Ready; first: { status: string }; second: { status: string } }> {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const first = r.u.world.match(salt, "0.4", { status: "MINED" });
    const second = r.u.world.match(salt, "0.3", { status: "MINED" });
    expect(first !== undefined && second !== undefined).toBe(true);
    expect(await reconcileRounds(r, 6)).toBe(true);
    return { r, first: first as { status: string }, second: second as { status: string } };
  }

  function alertBreaks(r: Ready): ReturnType<Ready["p"]["journal"]["unresolvedBreaks"]> {
    return r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "OMS_HALTING_ALERT");
  }

  async function release(r: Ready, breakId: string | undefined): Promise<void> {
    expect((await r.p.coordinator.releaseQuarantine({ breakId: breakId ?? "", operatorRef: "operator-1", reason: "the reversal is booked" })).ok).toBe(true);
  }

  it("(R2-C) a second halting alert of one kind on one order, after the first was released: its own quarantine, its market halted, never resumed past", async () => {
    const { r, first, second } = await twoTrades();
    first.status = "FAILED"; // the OMS raises SETTLEMENT_FAILED (a compensating reversal is owed)
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "OMS_HALTING_ALERT");
    const firstAlert = alertBreaks(r);
    expect(firstAlert).toHaveLength(1);
    await release(r, firstAlert[0]?.breakId);
    expect(await reconcileRounds(r, 4)).toBe(true);
    const haltsBefore = r.u.halts.length;
    second.status = "FAILED"; // the same kind of alert, on the same order: another reversal is owed
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "OMS_HALTING_ALERT");
    expect(r.oms.alerts().filter((alert) => alert.kind === "SETTLEMENT_FAILED" && alert.haltMarket)).toHaveLength(2);
    const secondAlert = alertBreaks(r);
    expect(secondAlert).toHaveLength(1);
    expect(secondAlert[0]?.breakId).not.toBe(firstAlert[0]?.breakId);
    expect(secondAlert[0]?.status).toBe("QUARANTINED");
    expect(r.u.halts.slice(haltsBefore).some((halt) => halt.breakId === secondAlert[0]?.breakId && halt.marketId === MARKET)).toBe(true);
    // Released in turn, the account resumes.
    await release(r, secondAlert[0]?.breakId);
    expect(await reconcileRounds(r, 4)).toBe(true);
  });

  it("(R2-C) two halting alerts raised before one run: two quarantines; releasing one leaves the other holding", async () => {
    const { r, first, second } = await twoTrades();
    first.status = "FAILED";
    second.status = "FAILED";
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "OMS_HALTING_ALERT");
    const both = alertBreaks(r);
    expect(both).toHaveLength(2);
    expect(new Set(both.map((view) => view.subjectKey)).size).toBe(2);
    expect(both.every((view) => view.status === "QUARANTINED")).toBe(true);
    await release(r, both[0]?.breakId);
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(alertBreaks(r).map((view) => view.breakId)).toEqual([both[1]?.breakId]);
    await release(r, both[1]?.breakId);
    expect(await reconcileRounds(r, 3)).toBe(true);
  });

  it("(R2-C) after a restart, a new halting alert is never taken for one released before the restart", async () => {
    const { r, first, second } = await twoTrades();
    first.status = "FAILED";
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    const before = alertBreaks(r);
    expect(before).toHaveLength(1);
    await release(r, before[0]?.breakId);
    expect(await reconcileRounds(r, 4)).toBe(true);
    // A fresh process: its OMS's first alert stands where the released one stood before the restart.
    const p = await boot(r.u);
    const again: Ready = { u: r.u, p, oms: p.oms as OrderManager };
    expect(await reconcileRounds(again, 4)).toBe(true);
    second.status = "FAILED";
    again.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(again, (await again.p.coordinator.reconcile()).resumed, "OMS_HALTING_ALERT");
    const after = alertBreaks(again);
    expect(after).toHaveLength(1);
    expect(after[0]?.subjectKey).not.toBe(before[0]?.subjectKey);
  });

  for (const [variant, rewrite] of [
    ["an earlier alert disappeared", (): readonly OmsAlert[] => []],
    ["an earlier alert changed", (real: readonly OmsAlert[]): readonly OmsAlert[] => real.map((alert, index) => (index === 0 ? { ...alert, detail: "rewritten" } : alert))],
  ] as const) {
    it(`(R2-C) an alert list that is not append-only (${variant}) holds the account: alerts can no longer be told apart`, async () => {
      const { r, first } = await twoTrades();
      first.status = "FAILED";
      r.p.coordinator.trigger("PERIODIC_TIMER");
      await r.p.coordinator.reconcile();
      const alert = alertBreaks(r);
      await release(r, alert[0]?.breakId);
      expect(await reconcileRounds(r, 4)).toBe(true);
      r.u.seams.alerts = rewrite; // the OMS port breaks its contract
      r.p.coordinator.trigger("PERIODIC_TIMER");
      await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "COMPONENT_UNAVAILABLE");
      expect(r.p.journal.unresolvedBreaks().map((view) => view.detail)).toContainEqual(expect.stringContaining("not append-only"));
    });
  }
});

describe("WP-290 deliverable 3: what still awaits a read at the end of a run is recorded, and holds (r2, R2-E)", () => {
  it("(R2-E) an attempt still awaiting its authoritative read (inside the quiescence horizon) is recorded as ORDER_UNRESOLVED by attempt", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    const attempt = await submitOne(r.oms);
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "ORDER_UNRESOLVED");
    const held = r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "ORDER_UNRESOLVED");
    expect(held.map((view) => view.detail)).toContainEqual(`attempt ${attempt ?? "?"} is RECONCILING and still awaits an authoritative read`);
    // Answered ABSENT once quiescent: the attempt resolves, the break clears, trading resumes.
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.p.journal.unresolvedBreaks()).toEqual([]);
  });

  it("(R2-E) an order the OMS is still reconciling (its answer refused) is recorded as ORDER_UNRESOLVED by order", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    expect(await reconcileRounds(r, 2)).toBe(true);
    r.u.world.cancel(r.u.world.orders.get(salt)?.venueOrderId as string);
    r.u.seams.applyReconciliation = async () => ({ ok: false, refusal: { code: "OMS_TEST_REFUSED", message: "refused by the test" } });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "ORDER_UNRESOLVED");
    const orderId = r.oms.orders()[0]?.orderId as string;
    expect(r.oms.orders()[0]?.state).toBe("RECONCILING");
    expect(r.p.journal.unresolvedBreaks().map((view) => view.detail)).toContain(`order ${orderId} is RECONCILING`);
    delete r.u.seams.applyReconciliation;
    expect(await reconcileRounds(r, 4)).toBe(true);
  });
});
