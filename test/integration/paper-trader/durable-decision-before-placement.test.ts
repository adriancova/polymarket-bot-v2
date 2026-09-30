/**
 * `DURABLE-1` (closeout blocker X1, from E-01) — a decision is DURABLE before
 * any placement it emits reaches the venue, and so before any ledger posting
 * that placement's fill causes.
 *
 * Handoff §8.1 orders "persist DecisionResults" before "allocate capital → run
 * risk checks → create execution plans → … submit"; §6 invariants 3 and 4 ask
 * for one PERSISTED decision per callback and a complete trace from a fill to
 * its source; ADR-005 §2 puts that guarantee on the runtime; WP-230 acceptance
 * #4 asks that a store failure halt safely. Until `DURABLE-1` the loop routed a
 * decision's intents straight away and wrote the decision only at the flush
 * AFTER the event's fill harvest, so a store that refused the intent-bearing
 * decision still saw — on the real `createPaperTrader`, both with per-row
 * writes and with group commit —
 *
 * ```text
 * venue_submit, ledger_write, ledger_write, venue_submit, decision_refused
 * fills=1, transactions=2, persistedIntentDecisions=0, halt=STORE_UNAVAILABLE
 * ```
 *
 * These cases are that probe, turned around: the REAL assembled trader (the
 * paper fixture's six recorded events: an entry that fills, then its
 * take-profit exit placed from the `onFill` callback), with ONLY the store
 * port observed (and, in the refusal cases, refusing one decision). Each case
 * runs in BOTH arms — per-row writes and group commit.
 *
 * 1. ORDER: at every placement submit, every decision the loop has emitted is
 *    already durable; at every ledger write, every intent-bearing one is.
 * 2. REFUSAL AT THE ENTRY: zero submissions, zero orders, zero fills, zero
 *    ledger rows, a GLOBAL `STORE_UNAVAILABLE` halt.
 * 3. REFUSAL AT THE `onFill` EXIT (a loop-originated callback): the entry —
 *    whose decision IS durable — trades and books; the exit is never
 *    submitted; the same halt.
 */

import type { GroupCommit, StagedEvaluations, TraderStore } from "@polymarket-bot/trader";
import { portFailed, portOk } from "@polymarket-bot/trader";
import type { MemoryTraderStore } from "@polymarket-bot/trader/testing";
import { describe, expect, it } from "vitest";

import { assembleOrThrow, type Run } from "./support/run.js";
import { recordedEvents } from "./support/fixture.js";

type Operation =
  | { readonly op: "decision_durable"; readonly evaluationSeq: number; readonly intents: number }
  | { readonly op: "decision_refused"; readonly evaluationSeq: number }
  | { readonly op: "ledger_write"; readonly undurableIntentDecisions: readonly number[] }
  | {
      readonly op: "venue_submit";
      readonly planKind: string;
      readonly undurableDecisions: readonly number[];
      readonly undurableIntentDecisions: readonly number[];
    };

interface Observed {
  readonly run: Run;
  readonly timeline: Operation[];
}

const REFUSAL = { kind: "UNAVAILABLE" as const, detail: "DURABLE-1: the store refuses this decision" };

/**
 * The fixture's trader over an OBSERVED store. `refuse` names the decision
 * the store will not write — by its position among the intent-bearing
 * decisions offered to the store (0 = the first), or never.
 */
function observe(grouped: boolean, refuse: number | undefined): Observed {
  const timeline: Operation[] = [];
  let intentDecisionsOffered = 0;
  const assembled: { run?: Run } = {};

  /** The decisions the loop has EMITTED that the store does not hold. */
  const undurable = (inner: MemoryTraderStore, intentOnly: boolean): number[] => {
    const current = assembled.run;
    if (current === undefined) return [];
    const durable = new Set(inner.decisions.map((entry) => `${entry.record.runId}|${String(entry.record.evaluationSeq)}`));
    return current.trader.loop
      .decisions()
      .filter((decision) => !intentOnly || decision.intentIds.length > 0)
      .filter((decision) => !durable.has(`${decision.runId}|${String(decision.evaluationSeq)}`))
      .map((decision) => decision.evaluationSeq);
  };

  /** Writes one decision, or refuses it (the store's own failure, answered as data). */
  const write = async (
    inner: MemoryTraderStore,
    entry: StagedEvaluations["decisions"][number],
  ): Promise<boolean> => {
    if (entry.record.decision.intents.length > 0) {
      const position = intentDecisionsOffered;
      intentDecisionsOffered += 1;
      if (refuse !== undefined && position === refuse) {
        timeline.push({ op: "decision_refused", evaluationSeq: entry.record.evaluationSeq });
        return false;
      }
    }
    const written = await inner.persistDecision(entry.record, entry.telemetry);
    if (!written.ok) return false;
    timeline.push({
      op: "decision_durable",
      evaluationSeq: entry.record.evaluationSeq,
      intents: entry.record.decision.intents.length,
    });
    return true;
  };

  const run = assembleOrThrow({
    wrapStore(inner): TraderStore {
      const staged: StagedEvaluations[] = [];
      const group: GroupCommit = {
        stage(evaluations) {
          staged.push(evaluations);
          return portOk(null);
        },
        get stagedEvents() {
          return staged.length;
        },
        async commit() {
          const batch = staged.splice(0, staged.length);
          // A refused batch commits NOTHING — one transaction.
          const decisions = batch.flatMap((evaluation) => evaluation.decisions);
          let position = intentDecisionsOffered;
          for (const entry of decisions) {
            if (entry.record.decision.intents.length === 0) continue;
            if (refuse !== undefined && position === refuse) {
                    timeline.push({ op: "decision_refused", evaluationSeq: entry.record.evaluationSeq });
              return portFailed<{ decisions: number; checkpoints: number }>(REFUSAL.kind, REFUSAL.detail);
            }
            position += 1;
          }
          for (const entry of decisions) await write(inner, entry);
          let checkpoints = 0;
          for (const evaluation of batch) {
            for (const entry of evaluation.checkpoints) {
              await inner.saveCheckpoint(entry.checkpoint, entry.capturedAt);
              checkpoints += 1;
            }
          }
          return portOk({ decisions: decisions.length, checkpoints });
        },
      };
      return {
        persistDecision: async (record, telemetry) =>
          (await write(inner, { record, telemetry }))
            ? portOk(null)
            : portFailed<null>(REFUSAL.kind, REFUSAL.detail),
        saveCheckpoint: (checkpoint, capturedAt) => inner.saveCheckpoint(checkpoint, capturedAt),
        appendLedgerTransaction: (transaction) => {
          timeline.push({ op: "ledger_write", undurableIntentDecisions: undurable(inner, true) });
          return inner.appendLedgerTransaction(transaction);
        },
        writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
        replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
        close: () => inner.close(),
        ...(grouped ? { groupCommit: group } : {}),
      };
    },
  });
  assembled.run = run;
  const submit = run.parts.venue.submit.bind(run.parts.venue);
  run.parts.venue.submit = async (plan) => {
    timeline.push({
      op: "venue_submit",
      planKind: plan.planKind,
      undurableDecisions: undurable(run.parts.store, false),
      undurableIntentDecisions: undurable(run.parts.store, true),
    });
    return await submit(plan);
  };
  return { run, timeline };
}

async function drive(observed: Observed): Promise<void> {
  for (const event of recordedEvents()) observed.run.trader.loop.ingest(event);
  await observed.run.trader.loop.drain();
}

function operations(timeline: readonly Operation[], op: Operation["op"]): readonly Operation[] {
  return timeline.filter((entry) => entry.op === op);
}

describe.each([
  { arm: "per-row writes", grouped: false },
  { arm: "group commit", grouped: true },
])("a decision is durable before its placement and its ledger effects — $arm (DURABLE-1)", ({ grouped }) => {
  it("ORDER: every emitted decision is durable at each placement submit, every intent-bearing one at each ledger write", async () => {
    const observed = observe(grouped, undefined);
    await drive(observed);
    const submits = operations(observed.timeline, "venue_submit");
    const ledger = operations(observed.timeline, "ledger_write");

    // Non-vacuous: the entry and its take-profit exit were both placed, and
    // the entry's fill was booked.
    expect(submits).toHaveLength(2);
    expect(ledger.length).toBeGreaterThan(0);
    expect(observed.run.parts.venue.fills).toHaveLength(1);
    expect(observed.run.trader.halts.anyHalt).toBe(false);

    for (const submit of submits) {
      if (submit.op !== "venue_submit") throw new Error("unreachable");
      expect(submit.planKind).not.toBe("CANCEL");
      expect(submit.undurableDecisions).toEqual([]);
      expect(submit.undurableIntentDecisions).toEqual([]);
    }
    for (const write of ledger) {
      if (write.op !== "ledger_write") throw new Error("unreachable");
      expect(write.undurableIntentDecisions).toEqual([]);
    }
    // And the store holds every decision the loop emitted, intent-bearing
    // ones included, in evaluation order.
    const durable = observed.run.parts.store.decisions.map((entry) => entry.record.evaluationSeq);
    expect(durable).toEqual(observed.run.trader.loop.decisions().map((decision) => decision.evaluationSeq));
    expect(
      observed.run.parts.store.decisions.filter((entry) => entry.record.decision.intents.length > 0),
    ).toHaveLength(2);
  });

  it("REFUSAL AT THE ENTRY: the store refuses the intent-bearing decision — zero venue and ledger effects, and a GLOBAL halt", async () => {
    const observed = observe(grouped, 0);
    await drive(observed);
    const { run, timeline } = observed;

    // The strategy DID emit the entry: the refusal is what stopped it.
    const emitted = run.trader.loop.decisions().filter((decision) => decision.intentIds.length > 0);
    expect(emitted.length).toBeGreaterThan(0);
    expect(operations(timeline, "decision_refused")).toHaveLength(1);

    expect(operations(timeline, "venue_submit")).toEqual([]);
    expect(operations(timeline, "ledger_write")).toEqual([]);
    expect(run.parts.venue.fills).toHaveLength(0);
    expect(run.parts.venue.ordersSnapshot()).toHaveLength(0);
    expect(run.parts.store.transactions).toHaveLength(0);
    expect(run.parts.store.pnlSnapshots).toHaveLength(0);
    expect(run.parts.store.decisions.filter((entry) => entry.record.decision.intents.length > 0)).toHaveLength(0);
    const health = run.trader.loop.health();
    expect(health.execution.submissionsAccepted).toBe(0);
    expect(health.risk.approvals).toBe(0);
    expect(health.seams.reservations.taken).toBe(0);

    const halts = run.trader.halts.records();
    expect(halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
    expect(run.trader.halts.globalHalt()?.code).toBe("STORE_UNAVAILABLE");
  });

  it("REFUSAL AT THE onFill EXIT: the durable entry trades and books; the exit is never submitted; a GLOBAL halt", async () => {
    const observed = observe(grouped, 1);
    await drive(observed);
    const { run, timeline } = observed;

    const refusedAt = operations(timeline, "decision_refused");
    expect(refusedAt).toHaveLength(1);
    const exitDecision = run.trader.loop
      .decisions()
      .find((decision) => decision.intentIds.length > 0 && decision.callback === "onFill");
    expect(exitDecision, "the take-profit exit is emitted from the onFill callback").toBeDefined();
    if (refusedAt[0]?.op !== "decision_refused") throw new Error("unreachable");
    expect(refusedAt[0].evaluationSeq).toBe(exitDecision?.evaluationSeq);

    // The entry: submitted once, with its decision durable; filled; booked.
    const submits = operations(timeline, "venue_submit");
    expect(submits).toHaveLength(1);
    if (submits[0]?.op !== "venue_submit") throw new Error("unreachable");
    expect(submits[0].undurableIntentDecisions).toEqual([]);
    expect(run.parts.venue.fills).toHaveLength(1);
    expect(run.parts.store.transactions.length).toBeGreaterThan(0);
    // Every ledger write precedes the refusal, and no economic effect follows it.
    const refusalIndex = timeline.findIndex((entry) => entry.op === "decision_refused");
    expect(timeline.slice(refusalIndex + 1).filter((entry) => entry.op !== "decision_durable")).toEqual([]);
    expect(run.parts.venue.ordersSnapshot()).toHaveLength(1);

    expect(run.trader.halts.records().map((halt) => [halt.scope.kind, halt.code])).toEqual([
      ["GLOBAL", "STORE_UNAVAILABLE"],
    ]);
  });
});
