/**
 * WP-290 r6: one pin per CLASS choke point, beyond the round-6 reproductions (`regressions-r6.test.ts`):
 *
 * - CLASS B (resolution without judgement): a break leaves the open state by a run only through `#resolve`, which
 *   needs its exact subject positively judged by the comparison that ran, in a CONCLUSIVE run: a missed fill
 *   delivered in a run whose positions read failed is not RESOLVED_IN_RUN there (a later conclusive run clears it).
 * - CLASS C (obligation collapse or loss): every halt obligation that needs no consistent view of the venue is
 *   derived in EVERY run (an unsound one included): the ledger's arrivals in two markets, a FAILED settlement; a
 *   not-found quarantine released and then named again by new evidence is a NEW occurrence, with its own subject.
 * - CLASS D (validity after await): the one run-validity latch is checked after every await, before every commit:
 *   a settlement probe write after a clock fault detected during the first one; a second OMS answer after the
 *   journal faulted on the first one's record.
 *
 * Every venue read is the simulated venue's (`support/world.ts`). PAPER only.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { ReconciliationJournal } from "../../../packages/ledger/src/index.js";
import type { OmsAlert, ReconciliationJournalPort } from "../../../packages/oms/src/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";
import { uuid7 } from "../../unit/oms/support/ids.js";

import { ACCOUNT, MARKET, MARKET_NO, NO, YES, streamTrade } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

function resolutionOf(r: Ready, breakId: string | undefined): string | null {
  return r.p.journal.breaks().find((view) => view.breakId === breakId)?.resolution ?? null;
}

describe("WP-290 r6 class A: an observation is never lost to a run that failed before journaling it", () => {
  it("(A, a run that throws) a 0.4 fill a run's list showed, before a port broke its contract and the run failed: the next run still holds the regressing read", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const before = r.u.world.collateral;
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    const real = r.oms.retainedEvidence.bind(r.oms);
    let broken = true;
    r.oms.retainedEvidence = () => {
      if (broken) throw new Error("a port that breaks its contract");
      return real();
    };
    const first = await r.p.coordinator.reconcile();
    expect(first.runs[0]?.reason).toContain("failed unexpectedly");
    broken = false;
    // Past the attempt's quiescence horizon: the very next run may answer it, so it must already hold the evidence.
    r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
    r.u.world.cancel(trade?.venueOrderId as string);
    r.u.world.faults = {
      listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
      readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
      readCollateral: (answer) => ({ ...(answer() as Record<string, unknown>), balance: before }),
      readOrder: (_id, answer) => {
        const read = answer() as { order?: Record<string, unknown> };
        return { ...read, order: { ...(read.order ?? {}), sizeMatched: "0" } };
      },
    };
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("READ_REGRESSION");
    expect(oracle(r)).toEqual([]);
  });
});

describe("WP-290 r6 class A: an observation whose journal append failed is kept, appended again, and concludes nothing meanwhile", () => {
  /** The journal refuses every `EVIDENCE_RECORDED` append `refusing` selects (every other event is appended). */
  function refuseEvidence(r: Ready, refusing: (record: { readonly evidenceKind?: unknown }) => boolean): () => number {
    const append = r.p.journal.append.bind(r.p.journal);
    let refused = 0;
    r.p.journal.append = async (event: unknown) => {
      if ((event as { kind?: unknown }).kind === "EVIDENCE_RECORDED" && refusing(event as { evidenceKind?: unknown })) {
        refused += 1;
        return { ok: false, refusal: { code: "RECON_SINK_FAILED", message: "the sink failed (the test)" } } as unknown as Awaited<ReturnType<typeof append>>;
      }
      return append(event as Parameters<typeof append>[0]);
    };
    return () => refused;
  }

  it("(A, a refused evidence append) a 0.4 fill an unusable run saw, its evidence records refused: kept in memory, appended again by the next run, and the later regressing read still holds; never answered", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const before = r.u.world.collateral;
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    const id = trade?.venueOrderId as string;
    let refusing = true;
    const refused = refuseEvidence(r, () => refusing);
    r.u.world.faults.listOpenOrders = (answer) => ({ ...(answer() as { orders: unknown[] }), complete: false });
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    expect(refused()).toBeGreaterThan(0);
    refusing = false;
    r.u.world.cancel(id);
    r.u.world.faults = {
      listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
      readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
      readCollateral: (answer) => ({ ...(answer() as Record<string, unknown>), balance: before }),
      readOrder: (_id, answer) => {
        const read = answer() as { order?: Record<string, unknown> };
        return { ...read, order: { ...(read.order ?? {}), sizeMatched: "0" } };
      },
    };
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("READ_REGRESSION");
    expect(oracle(r)).toEqual([]);
    // Appended again once the journal took it.
    expect(r.p.journal.evidence().some((record) => record.venueOrderId === id && record.size === "0.4")).toBe(true);
  });

  /** A consistent account whose next run sees facts the evidence does not hold yet (a 0.4 match the OMS learned from the stream). */
  async function newFacts(r: Ready): Promise<string> {
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? ""));
    await r.p.coordinator.settled();
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    return trade?.venueOrderId as string;
  }

  it("(A, a refused evidence append, a sound run) a run whose observations could not be journaled concludes nothing and does not resume, nor does one that cannot journal them again; the next run that does resumes", async () => {
    const r = await ready();
    const id = await newFacts(r);
    let refusing = true;
    // Only the observations are refused (a settlement record is journaled): each run's own failure is what holds it.
    const refused = refuseEvidence(r, (record) => refusing && record.evidenceKind !== "SETTLED");
    for (let round = 0; round < 2; round += 1) {
      r.p.coordinator.trigger("PERIODIC_TIMER");
      const report = await r.p.coordinator.reconcile();
      expect(report.runs.map((run) => run.resumed)).not.toContain(true);
      expect(report.runs[0]?.reason).toContain("the journal did not record every event");
    }
    expect(refused()).toBeGreaterThan(1);
    expect(r.p.journal.evidence().some((record) => record.venueOrderId === id && record.size === "0.4")).toBe(false);
    refusing = false;
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.p.journal.evidence().some((record) => record.venueOrderId === id && record.size === "0.4")).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(A, a refused settlement record) a conclusive run whose evidence settlement could not be journaled does not resume; the next run journals it and resumes", async () => {
    const r = await ready();
    const id = await newFacts(r);
    let refusing = true;
    const refused = refuseEvidence(r, (record) => refusing && record.evidenceKind === "SETTLED");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const first = await r.p.coordinator.reconcile();
    expect(refused()).toBeGreaterThan(0);
    expect(first.runs[0]?.resumed).toBe(false);
    expect(first.runs[0]?.reason).toContain("the journal did not record every event");
    refusing = false;
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.p.journal.evidence().some((record) => record.evidenceKind === "SETTLED" && record.venueOrderId === id)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });
});

describe("WP-290 r6 class B: a break is resolved only by a conclusive run that positively judged its subject", () => {
  it("(B, RESOLVED_IN_RUN) a missed fill delivered in a run whose positions read failed is not resolved in that run; a later conclusive run clears it", async () => {
    const r = await ready();
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    r.u.world.faults.readPositions = () => {
      throw new Error("timeout");
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const first = await r.p.coordinator.reconcile();
    const firstRun = first.runs[0]?.runId;
    // The fill was delivered (a fact the venue showed), but nothing was concluded about the break in that run.
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    const missing = r.p.journal.breaks().find((view) => view.breakClass === "TRADE_MISSING_IN_OMS");
    expect(missing).toBeDefined();
    expect(r.p.journal.events().filter((event) => event.kind === "BREAK_RESOLVED" && event.runId === firstRun)).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(resolutionOf(r, missing?.breakId)).toBe("NOT_REPRODUCED");
    expect(oracle(r)).toEqual([]);
  });

  it("(B, a MISSING order) a read problem about a tracked order is not cleared by a run whose by-id read does not find the order (not found is no consistent read of it); a later consistent read clears it", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    const id = trade?.venueOrderId as string;
    expect(await reconcileRounds(r, 3)).toBe(true);
    const unlisted = (answer: () => unknown): unknown => {
      const read = answer() as { orders: Record<string, unknown>[] };
      return { ...read, orders: read.orders.filter((order) => order["venueOrderId"] !== id) };
    };
    // A by-id read behind the evidence: a READ_REGRESSION about the order.
    r.u.world.faults = {
      listOpenOrders: unlisted,
      readOrder: (candidate, answer) => {
        const read = answer() as { order?: Record<string, unknown> };
        return candidate === id ? { ...read, order: { ...(read.order ?? {}), sizeMatched: "0" } } : read;
      },
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await r.p.coordinator.reconcile();
    const regression = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_REGRESSION");
    expect(regression?.detail).toContain(id);
    // Then its by-id read does not find it at all (a tracked order: the OMS's comparison holds it).
    r.u.world.faults = { listOpenOrders: unlisted, readOrder: (candidate, answer) => (candidate === id ? { route: "/data/order", found: false } : answer()) };
    expect(await reconcileRounds(r, 2)).toBe(false);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("ORDER_STATE_MISMATCH");
    expect(resolutionOf(r, regression?.breakId)).toBeNull();
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(resolutionOf(r, regression?.breakId)).toBe("NOT_REPRODUCED");
    expect(oracle(r)).toEqual([]);
  });

  it("(B, I-14) a missed fill delivered in a run that could not read the journal's unresolved breaks is not resolved in that run (it is not conclusive); once they read again, a later run clears it", async () => {
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
      evidence: () => journal.evidence(),
      append: (event) => journal.append(event),
    });
    const r = await ready({ seams: { journal: wrap } });
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    failing = true;
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const first = await r.p.coordinator.reconcile();
    const firstRun = first.runs[0]?.runId;
    // The fill was delivered (a fact the venue showed), but that run concluded nothing about its break.
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    const missing = r.p.journal.breaks().find((view) => view.breakClass === "TRADE_MISSING_IN_OMS");
    expect(missing).toBeDefined();
    expect(r.p.journal.events().filter((event) => event.kind === "BREAK_RESOLVED" && event.runId === firstRun)).toEqual([]);
    failing = false;
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(resolutionOf(r, missing?.breakId)).toBe("NOT_REPRODUCED");
    expect(oracle(r)).toEqual([]);
  });
});

describe("WP-290 r6 class C: every halt obligation has its own durable identity, derived in every run", () => {
  /** One transaction with an UNATTRIBUTED arrival of 2 in each of two markets (the venue shows the same holdings). */
  function twoMarkets(r: Ready): string {
    const id = r.u.ledgerIds();
    const entries = [
      { assetId: YES, marketId: MARKET },
      { assetId: NO, marketId: MARKET_NO },
    ].flatMap(({ assetId, marketId }) => [
      { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "2" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-venue", assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "-2" },
      { scope: "UNATTRIBUTED", accountRef: ACCOUNT, assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "2" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-attribution", assetId, assetKind: "OUTCOME_TOKEN", marketId, amount: "-2" },
    ]);
    const appended = r.u.ledger.append({ ledgerTransactionId: id, eventType: "RECONCILIATION_CORRECTION", environment: "PAPER", accountRef: ACCOUNT, source: "internal", occurredAt: "2026-10-03T00:00:00Z", entries });
    expect(appended.ok).toBe(true);
    if (appended.ok) r.u.ledger = appended.value.ledger;
    r.u.world.adjustPosition(YES, "2");
    r.u.world.adjustPosition(NO, "2");
    return id;
  }

  it("(C, an alert while every run is stale) an OMS halting alert is recorded as a quarantine, its market halted, by a run whose reads are stale (it concludes nothing else)", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const order = r.oms.orders()[0];
    const alert: OmsAlert = {
      kind: "SETTLEMENT_CONFLICT",
      haltMarket: true,
      marketId: MARKET,
      orderId: order?.orderId ?? null,
      submissionAttemptId: null,
      venueOrderId: order?.venueOrderId ?? null,
      detail: "raised by the test",
    };
    r.u.seams.alerts = (real) => [...real, alert];
    // Every run's reads span more than the bound: stale (READ_STALE), whatever else they show.
    r.u.world.faults.onRead = (name) => {
      if (name === "readPositions") r.u.clock.t += r.u.policy.maxReadSpanMs + 1;
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    const first = report.runs[0];
    expect(first?.detections.map((detection) => detection.breakClass)).toEqual(expect.arrayContaining(["READ_STALE", "OMS_HALTING_ALERT"]));
    const quarantine = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "OMS_HALTING_ALERT");
    expect(quarantine?.status).toBe("QUARANTINED");
    expect(r.u.halts.some((halt) => halt.marketId === MARKET && halt.breakId === quarantine?.breakId)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(C, an alert raised during the run) the OMS raises a halting alert while the run's answer is applied (after the reads): that very run records it as a quarantine, halts its market, and does not resume", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const order = r.oms.orders()[0];
    expect((await r.oms.requestOrderReconciliation(order?.orderId as string)).ok).toBe(true);
    let raised = false;
    r.u.seams.applyReconciliation = async (raw, real) => {
      const result = await real(raw);
      raised = true;
      return result;
    };
    const alert: OmsAlert = {
      kind: "SETTLEMENT_CONFLICT",
      haltMarket: true,
      marketId: MARKET,
      orderId: order?.orderId ?? null,
      submissionAttemptId: null,
      venueOrderId: order?.venueOrderId ?? null,
      detail: "raised by the test while the run's answer was applied",
    };
    r.u.seams.alerts = (real) => (raised ? [...real, alert] : real);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    const first = report.runs[0];
    expect(first?.answers.length).toBe(1);
    expect(first?.detections.map((detection) => detection.breakClass)).toContain("OMS_HALTING_ALERT");
    expect(first?.resumed).toBe(false);
    const quarantine = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "OMS_HALTING_ALERT");
    expect(quarantine?.status).toBe("QUARANTINED");
    expect(r.u.halts.some((halt) => halt.marketId === MARKET && halt.breakId === quarantine?.breakId)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(C, the ledger) a transaction with arrivals in two markets is two quarantines, both markets halted, by a run whose trades read failed (no holdings judged)", async () => {
    const r = await ready();
    const id = twoMarkets(r);
    r.u.world.faults.listTrades = () => {
      throw new Error("timeout");
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "LEDGER_UNATTRIBUTED_ARRIVAL");
    const arrivals = r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "LEDGER_UNATTRIBUTED_ARRIVAL");
    expect(arrivals.map((view) => [view.status, view.marketId])).toEqual([
      ["QUARANTINED", MARKET],
      ["QUARANTINED", MARKET_NO],
    ]);
    expect(arrivals.every((view) => view.detail.includes(id))).toBe(true);
    expect(new Set(r.u.halts.map((halt) => halt.marketId))).toEqual(new Set([MARKET, MARKET_NO]));
  });

  it("(C, a FAILED settlement) recorded and its market halted by a run whose open-orders read is unusable", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4", { status: "MINED" });
    expect(await reconcileRounds(r, 4)).toBe(true);
    if (trade !== undefined) r.u.world.failTrade(trade);
    r.u.world.faults.listOpenOrders = (answer) => ({ ...(answer() as Record<string, unknown>), complete: false });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "SETTLEMENT_FAILED");
    const failed = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "SETTLEMENT_FAILED");
    expect(failed?.subjectKey).toBe(compositeKey("SETTLEMENT_FAILED", trade?.venueTradeId ?? "", trade?.venueOrderId ?? ""));
    expect(r.u.halts.some((halt) => halt.breakId === failed?.breakId && halt.marketId === MARKET)).toBe(true);
  });

  it("(C, occurrences) a not-found quarantine released, then the id named again by new evidence and still not found: a NEW occurrence, its own quarantine, and signed-identity answers withheld again", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = (await submitOne(r.oms)) as string;
    const phantom = "venue-phantom";
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: phantom, status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    expect(await reconcileRounds(r, 2)).toBe(false);
    const first = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("ORDER_NOT_FOUND_BY_ID", phantom));
    expect(first?.status).toBe("QUARANTINED");
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect((await r.p.coordinator.releaseQuarantine({ breakId: first?.breakId ?? "", operatorRef: "operator-1", reason: "not the account's" })).ok).toBe(true);
    // New evidence about the same id (the stream reports it again, now with a fill) before any run answers.
    r.p.coordinator.onUserStreamOutput({
      kind: "TRADE",
      oms: { fills: [{ venueTradeId: "phantom-trade", venueOrderId: phantom, shares: "0.1", price: "0.5", liquidityRole: "MAKER", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" }], settlements: [], shortfalls: [] },
    });
    await r.p.coordinator.settled();
    r.p.coordinator.trigger("PERIODIC_TIMER");
    await expectPaused(r, (await r.p.coordinator.reconcile()).resumed, "ORDER_NOT_FOUND_BY_ID");
    const second = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "ORDER_NOT_FOUND_BY_ID");
    expect(second?.subjectKey).toBe(compositeKey("ORDER_NOT_FOUND_BY_ID", phantom, "1"));
    expect(second?.breakId).not.toBe(first?.breakId);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(oracle(r)).toEqual([]);
  });
});

describe("WP-290 r6 class D: the one run-validity latch is checked after every await, before every commit", () => {
  it("(D, a probe write) two legs a run probes; the clock faults during the first settlement write: the second is not written by that run", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const one = r.u.world.match(salt, "0.2", { status: "MINED" });
    const two = r.u.world.match(salt, "0.2", { status: "MINED" });
    expect(await reconcileRounds(r, 4)).toBe(true);
    if (one !== undefined) one.status = "CONFIRMED";
    if (two !== undefined) two.status = "CONFIRMED";
    const real = r.oms.applySettlement.bind(r.oms);
    let calls = 0;
    r.oms.applySettlement = async (raw: unknown) => {
      calls += 1;
      const result = await real(raw);
      if (calls === 1) {
        const t = r.u.clock.t;
        r.u.clock.t = Number.NaN;
        await r.p.coordinator.releaseQuarantine({ breakId: uuid7(0xdead, 2), operatorRef: "review", reason: "clock fault probe" });
        r.u.clock.t = t;
      }
      return result;
    };
    let firstCompleted = false;
    let afterFault = -1;
    const append = r.p.journal.append.bind(r.p.journal);
    r.p.journal.append = async (event: unknown) => {
      if ((event as { kind?: unknown }).kind === "RUN_COMPLETED" && !firstCompleted) {
        firstCompleted = true;
        afterFault = calls;
      }
      return append(event);
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    // The first run made exactly one settlement write: the fault was detected at its await, before the second.
    expect(afterFault).toBe(1);
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toContain("READ_STALE");
    expect(report.runs[0]?.resumed).toBe(false);
    expect(report.resumed || (await reconcileRounds(r, 3))).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(D, a read behind the OMS) two legs a run probes; the first one's read is behind what the OMS learned from the stream: the second leg's newer settlement is not written by that run", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const one = r.u.world.match(salt, "0.2", { status: "MINED" });
    const two = r.u.world.match(salt, "0.2", { status: "MINED" });
    expect(await reconcileRounds(r, 4)).toBe(true);
    // The venue confirms trade one, and the OMS learns it from the user stream only (applied: the OMS's own record).
    if (one !== undefined) one.status = "CONFIRMED";
    r.p.coordinator.onUserStreamOutput({
      kind: "TRADE",
      oms: {
        fills: [],
        settlements: [{ venueTradeId: one?.venueTradeId, venueOrderId: one?.venueOrderId, status: "CONFIRMED", transactionHash: one?.transactionHash ?? null, observedAt: "2026-10-03T00:00:00.000Z" }],
        shortfalls: [],
      },
    });
    await r.p.coordinator.settled();
    const states = (tradeId: string | undefined): string[] =>
      r.u.store
        .snapshotSync()
        .settlements.filter((record) => record.venueTradeId === tradeId)
        .map((record) => record.state);
    expect(states(one?.venueTradeId)).toContain("CONFIRMED");
    // The venue confirms trade two; its trades read still shows trade one MINED (lagging: behind the OMS).
    if (two !== undefined) two.status = "CONFIRMED";
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: Record<string, unknown>[] };
      return { ...read, trades: read.trades.map((trade) => (trade["venueTradeId"] === one?.venueTradeId ? { ...trade, status: "MINED" } : trade)) };
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.detections.map((detection) => detection.breakClass)).toContain("READ_REGRESSION");
    // Nothing more was written from that read set once it was found behind the OMS.
    expect(states(two?.venueTradeId)).not.toContain("CONFIRMED");
    expect(report.runs[0]?.resumed).toBe(false);
    delete r.u.world.faults.listTrades;
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(states(two?.venueTradeId)).toContain("CONFIRMED");
    expect(oracle(r)).toEqual([]);
  });

  it("(D, an evidence settlement) the clock faults while a clearing is recorded: that run settles no evidence (its consistent orders stay read by id); the next run settles it", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    // New facts about the tracked order (a 0.4 match the OMS learned from the stream) seen by a run whose trades read
    // failed: unsettled evidence, and a READ_MISSING hold the next run clears.
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? ""));
    await r.p.coordinator.settled();
    r.u.world.faults.listTrades = () => {
      throw new Error("timeout");
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    let fired = false;
    const append = r.p.journal.append.bind(r.p.journal);
    r.p.journal.append = async (event: unknown) => {
      const result = await append(event as Parameters<typeof append>[0]);
      const resolved = event as { kind?: unknown; resolution?: unknown };
      if (!fired && resolved.kind === "BREAK_RESOLVED" && resolved.resolution === "NOT_REPRODUCED") {
        fired = true;
        const t = r.u.clock.t;
        r.u.clock.t = Number.NaN;
        await r.p.coordinator.releaseQuarantine({ breakId: uuid7(0xdead, 3), operatorRef: "review", reason: "clock fault probe" });
        r.u.clock.t = t;
      }
      return result;
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    const faulted = report.runs[0]?.runId;
    expect(fired).toBe(true);
    expect(report.runs[0]?.resumed).toBe(false);
    const settledBy = (runId: string | null | undefined): (string | null)[] =>
      r.p.journal
        .evidence()
        .filter((record) => record.evidenceKind === "SETTLED" && record.runId === runId)
        .map((record) => record.venueOrderId);
    expect(settledBy(faulted)).toEqual([]);
    expect(report.resumed || (await reconcileRounds(r, 3))).toBe(true);
    expect(r.p.journal.evidence().some((record) => record.evidenceKind === "SETTLED" && record.venueOrderId === trade?.venueOrderId && record.runId !== faulted)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(D, a faulted journal) two answers queued; the journal faults on the first one's record: the second is not given by that run", async () => {
    let failing = false;
    const wrap = (journal: ReconciliationJournal): ReconciliationJournalPort => ({
      get faulted() {
        return failing || journal.faulted;
      },
      get runningRunId() {
        return journal.runningRunId;
      },
      ruleOf: (breakClass) => journal.ruleOf(breakClass),
      releaseAcknowledgesSubject: (breakClass) => journal.releaseAcknowledgesSubject(breakClass),
      breaks: () => journal.breaks(),
      unresolvedBreaks: () => journal.unresolvedBreaks(),
      evidence: () => journal.evidence(),
      append: async (event) => {
        if (failing) return { ok: false, refusal: { code: "RECON_JOURNAL_FAULTED", message: "faulted by the test" } };
        if (event.kind === "ANSWER_RECORDED") {
          failing = true;
          return { ok: false, refusal: { code: "RECON_SINK_FAILED", message: "the sink failed (the test)" } };
        }
        return journal.append(event);
      },
    });
    const r = await ready({ seams: { journal: wrap } });
    // A tracked live order (its own state request below), and an attempt whose answer was lost (in another group).
    const a = (await submitOne(r.oms)) as string;
    expect(await reconcileRounds(r, 2)).toBe(true);
    const second = group(9002, { tokenId: NO, plannedShares: "5" });
    expect((await r.oms.registerGroup(second)).ok).toBe(true);
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const submitted = await r.oms.submit(ticket(second, { n: 981, shares: "1" }));
    expect(submitted.ok).toBe(true);
    const b = submitted.ok ? submitted.value.submissionAttemptId : "";
    expect((await r.oms.requestOrderReconciliation(r.oms.orders()[0]?.orderId as string)).ok).toBe(true);
    const report = await r.p.coordinator.reconcile();
    // Exactly one answer reached the OMS: the one whose record faulted the journal; nothing after it.
    expect(r.u.log.filter((entry) => entry.startsWith("answer:oms:"))).toHaveLength(1);
    expect(r.u.accepted.filter((answer) => answer.attemptId === a || answer.attemptId === b)).toHaveLength(1);
    expect(report.resumed).toBe(false);
    expect(oracle(r)).toEqual([]);
  });
});
