/**
 * `PROVENANCE-1` — a §9.8 pre-trade refusal is made DURABLE, in the shape the
 * research worker reads (`ops.risk_events`, ADR-028 Decision 3.1: a window
 * with a refusal is pinned).
 *
 * Before this round a refusal was a health counter only
 * (`risk.refusals`, `refusalsByCode`): nothing reached the store, and
 * `ops.risk_events` had no writer (ADR-028 Amendment 1, rule 6). Here the loop
 * hands each refused intent to the store port (`persistRiskRefusal`, or the
 * group commit's `riskRefusals`), with the event's other rows, and never after
 * a store failure it halted on.
 *
 * The REAL assembled core; the risk policy is the fixture's with ONE limit
 * lowered (`limits.maxWorstCaseContractualLoss` "1": the 50-share entry at
 * `0.34` risks `17`), so the refusal is the real risk engine's. The store is
 * the in-memory double, read at the port.
 *
 * NON-VACUOUS: on `c5157c3` the store records no refusal at all (and the port
 * has no such method).
 */

import type { GroupCommit, StagedEvaluations, TraderStore } from "@polymarket-bot/trader";
import { portFailed, portOk } from "@polymarket-bot/trader";
import type { MemoryTraderStore } from "@polymarket-bot/trader/testing";
import { describe, expect, it } from "vitest";

import { INSTANCE_ID, MARKET_ID, RUN_ID, recordedEvents, riskPolicy, traderConfig } from "./support/fixture.js";
import { assembleOrThrow, type Run } from "./support/run.js";

/** The fixture's configuration, with the worst-case loss limit below the entry's. */
function refusingConfig(): Record<string, unknown> {
  const policy = riskPolicy();
  return traderConfig({
    riskPolicy: { ...policy, limits: { ...(policy["limits"] as Record<string, unknown>), maxWorstCaseContractualLoss: "1" } },
  });
}

async function drive(run: Run): Promise<void> {
  for (const event of recordedEvents()) expect(run.trader.loop.ingest(event)).toBe(true);
  await run.trader.loop.drain();
}

/** Everything a store wrote, in ONE order, so "after" is a position and not a guess. */
function journaling(inner: MemoryTraderStore, journal: string[]): TraderStore {
  return {
    persistDecision: async (record, telemetry) => {
      journal.push(`decision ${String(record.evaluationSeq)}`);
      return await inner.persistDecision(record, telemetry);
    },
    // `CKPT-1` (ADR-027 D3): a decision and the checkpoint it owes are ONE
    // write, journaled as the two rows it carries.
    persistDecisionWithCheckpoint: async (record, telemetry, checkpoint, capturedAt) => {
      journal.push(`decision ${String(record.evaluationSeq)}`, `checkpoint ${String(checkpoint.checkpointSeq)}`);
      return await inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt);
    },
    persistRiskRefusal: async (refusal) => {
      journal.push(`refusal ${String(refusal.evaluationSeq)}`);
      return await inner.persistRiskRefusal(refusal);
    },
    appendLedgerTransaction: (transaction) => inner.appendLedgerTransaction(transaction),
    writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
    replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
    close: () => inner.close(),
  };
}

describe("a risk refusal is recorded at the store port (PROVENANCE-1)", () => {
  it("one record per refused intent: the decision, the intent, every refusal, the instant and the dispatch position", async () => {
    const run = assembleOrThrow({ config: refusingConfig() });
    await drive(run);
    const health = run.trader.loop.health();
    expect(health.risk.refusals).toBeGreaterThanOrEqual(1);
    expect(health.risk.approvals).toBe(0);
    expect(health.execution.submissionsAccepted).toBe(0);

    const refusals = run.parts.store.riskRefusals;
    // Exactly one record per counted refusal.
    expect(refusals).toHaveLength(health.risk.refusals);
    const decisions = run.parts.store.decisions.map((entry) => entry.record);
    for (const refusal of refusals) {
      const decision = decisions.find((record) => record.evaluationSeq === refusal.evaluationSeq);
      if (decision === undefined) throw new Error(`refusal names evaluation ${String(refusal.evaluationSeq)}, which was not persisted`);
      const intentIds = decision.decision.intents.map((intent) => ("intentId" in intent ? intent.intentId : ""));
      expect(refusal).toMatchObject({
        runId: RUN_ID,
        instanceId: INSTANCE_ID,
        marketId: MARKET_ID,
        protectiveExit: false,
        occurredAt: decision.evaluatedAt,
      });
      expect(intentIds).toContain(refusal.intentId);
      expect(refusal.intentId).toMatch(/^sb-entry-/u);
      expect({ ...refusal.sourceEvent }).toStrictEqual({ ...decision.sourceEvent });
      expect(refusal.sourceEvent?.ingestSeq).toBeDefined();
      expect(refusal.refusals.map((entry) => entry.code)).toContain("RISK_WORST_CASE_LOSS_EXCEEDED");
      for (const entry of refusal.refusals) expect(entry.message.length).toBeGreaterThan(0);
    }
    // The counted codes and the recorded codes are the same multiset.
    const recorded = new Map<string, number>();
    for (const refusal of refusals) {
      for (const entry of refusal.refusals) recorded.set(entry.code, (recorded.get(entry.code) ?? 0) + 1);
    }
    expect(Object.fromEntries(recorded)).toEqual({ ...health.risk.refusalsByCode });
  });

  it("per-row store: the refusal is written AFTER its event's decision and checkpoint, in the same flush", async () => {
    const journal: string[] = [];
    const run = assembleOrThrow({ config: refusingConfig(), wrapStore: (inner) => journaling(inner, journal) });
    await drive(run);
    const first = run.parts.store.riskRefusals[0];
    if (first === undefined) throw new Error("no refusal was recorded");
    const seq = String(first.evaluationSeq);
    const at = (entry: string): number => journal.indexOf(entry);
    expect(at(`decision ${seq}`)).toBeGreaterThanOrEqual(0);
    expect(at(`refusal ${seq}`)).toBeGreaterThan(at(`decision ${seq}`));
    expect(at(`refusal ${seq}`)).toBeGreaterThan(at(`checkpoint ${seq}`));
    // ... and before any later decision.
    const later = journal.findIndex((entry, index) => index > at(`decision ${seq}`) && /^decision /u.test(entry));
    if (later >= 0) expect(at(`refusal ${seq}`)).toBeLessThan(later);
  });

  it("group-commit store: the refusal is STAGED with its event's remaining rows and commits in that batch, before any later decision", async () => {
    const stagings: StagedEvaluations[] = [];
    const committed: string[] = [];
    let wrapped: MemoryTraderStore | undefined;
    const run = assembleOrThrow({
      config: refusingConfig(),
      wrapStore: (inner) => {
        wrapped = inner;
        let pending: StagedEvaluations[] = [];
        const group: GroupCommit = {
          stage(evaluations) {
            stagings.push(evaluations);
            pending.push(evaluations);
            return portOk(null);
          },
          get stagedEvents() {
            return pending.length;
          },
          async commit() {
            const batch = pending;
            pending = [];
            let decisions = 0;
            let checkpoints = 0;
            for (const evaluation of batch) {
              for (const entry of evaluation.decisions) {
                committed.push(`decision ${String(entry.record.evaluationSeq)}`);
                await inner.persistDecision(entry.record, entry.telemetry);
                decisions += 1;
              }
              for (const entry of evaluation.checkpoints) {
                committed.push(`checkpoint ${String(entry.checkpoint.checkpointSeq)}`);
                await inner.saveCheckpoint(entry.checkpoint, entry.capturedAt);
                checkpoints += 1;
              }
              for (const refusal of evaluation.riskRefusals) {
                committed.push(`refusal ${String(refusal.evaluationSeq)}`);
                await inner.persistRiskRefusal(refusal);
              }
            }
            return portOk({ decisions, checkpoints });
          },
        };
        return { ...journaling(inner, []), groupCommit: group };
      },
    });
    await drive(run);
    expect(run.trader.loop.groupCommits).toBe(true);
    const refusals = wrapped?.riskRefusals ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    const first = refusals[0];
    if (first === undefined) throw new Error("unreachable");
    // `CKPT-1` re-pin (ADR-027 D3; `DURABLE-1` LOW-3). This used to read: "the
    // staging that carries the refusal also carries its decision's checkpoint"
    // and "the DURABLE-1 boundary staged the decision ALONE, with no
    // refusal" — that is, the boundary staged the decision WITHOUT its
    // checkpoint, and the checkpoint followed in the event's later staging
    // (LOW-3: two transactions). Now the boundary stages the decision WITH the
    // checkpoint it owes, and the event's flush stages the refusal after it.
    const carrying = stagings.filter((staging) => staging.riskRefusals.length > 0);
    expect(carrying.length).toBeGreaterThanOrEqual(1);
    for (const staging of carrying) {
      for (const refusal of staging.riskRefusals) {
        const decisionStaging = stagings.findIndex((candidate) =>
          candidate.decisions.some((entry) => entry.record.evaluationSeq === refusal.evaluationSeq),
        );
        expect(decisionStaging, "the refused intent's decision was staged").toBeGreaterThanOrEqual(0);
        // …with its checkpoint, in the SAME staging (ADR-027 D3)…
        expect(
          stagings[decisionStaging]?.checkpoints.map((entry) => entry.checkpoint.checkpointSeq),
        ).toContain(refusal.evaluationSeq);
        // …and the refusal no EARLIER than that staging.
        expect(stagings.indexOf(staging)).toBeGreaterThanOrEqual(decisionStaging);
      }
    }
    // The DURABLE-1 boundary staged the decision with no refusal.
    for (const staging of stagings.filter((candidate) =>
      candidate.decisions.some((entry) => entry.record.decision.intents.length > 0),
    )) {
      expect(staging.riskRefusals).toEqual([]);
    }
    const seq = String(first.evaluationSeq);
    const position = (entry: string): number => committed.indexOf(entry);
    expect(position(`refusal ${seq}`)).toBeGreaterThan(position(`decision ${seq}`));
    const later = committed.findIndex((entry, index) => index > position(`decision ${seq}`) && /^decision /u.test(entry));
    if (later >= 0) expect(position(`refusal ${seq}`)).toBeLessThan(later);
  });

  it("a decision that could not be made durable (DURABLE-1): the refusal under the STORE_UNAVAILABLE halt is NOT written — nothing is written after the failure", async () => {
    const journal: string[] = [];
    let wrapped: MemoryTraderStore | undefined;
    // The store refuses every intent-bearing decision (and nothing else), so
    // the DURABLE-1 boundary halts and the risk seam refuses the placement
    // under the halt (RISK_RUN_STATE_BLOCKS) — with the FIXTURE's policy, so
    // the halt, not a limit, is the refusal's cause.
    const run = assembleOrThrow({
      wrapStore: (inner) => {
        wrapped = inner;
        const base = journaling(inner, journal);
        return {
          ...base,
          persistDecision: async (record, telemetry) =>
            record.decision.intents.length > 0
              ? portFailed<null>("UNAVAILABLE", "provenance-1: the store refuses this decision")
              : await base.persistDecision(record, telemetry),
          // `CKPT-1`: the same refusal for the paired write (decision + its owed checkpoint).
          persistDecisionWithCheckpoint: async (record, telemetry, checkpoint, capturedAt) =>
            record.decision.intents.length > 0
              ? portFailed<null>("UNAVAILABLE", "provenance-1: the store refuses this decision")
              : await base.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt),
        };
      },
    });
    await drive(run);
    const health = run.trader.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
    expect(health.risk.refusals).toBeGreaterThanOrEqual(1);
    expect(health.risk.refusalsByCode).toMatchObject({ RISK_RUN_STATE_BLOCKS: 1 });
    expect(wrapped?.riskRefusals).toEqual([]);
    expect(journal.filter((entry) => entry.startsWith("refusal"))).toEqual([]);
  });

  it("the same, through a GROUP-COMMITTING store whose staging refuses the decision: the refusal is neither staged nor committed", async () => {
    const stagings: StagedEvaluations[] = [];
    let wrapped: MemoryTraderStore | undefined;
    const run = assembleOrThrow({
      wrapStore: (inner) => {
        wrapped = inner;
        let pending: StagedEvaluations[] = [];
        const group: GroupCommit = {
          stage(evaluations) {
            if (evaluations.decisions.some((entry) => entry.record.decision.intents.length > 0)) {
              return portFailed<null>("UNAVAILABLE", "provenance-1: this decision cannot be staged");
            }
            stagings.push(evaluations);
            pending.push(evaluations);
            return portOk(null);
          },
          get stagedEvents() {
            return pending.length;
          },
          async commit() {
            const batch = pending;
            pending = [];
            for (const evaluation of batch) {
              for (const entry of evaluation.decisions) await inner.persistDecision(entry.record, entry.telemetry);
              for (const entry of evaluation.checkpoints) await inner.saveCheckpoint(entry.checkpoint, entry.capturedAt);
              for (const refusal of evaluation.riskRefusals) await inner.persistRiskRefusal(refusal);
            }
            return portOk({ decisions: 0, checkpoints: 0 });
          },
        };
        return { ...journaling(inner, []), groupCommit: group };
      },
    });
    await drive(run);
    const health = run.trader.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
    expect(health.risk.refusalsByCode).toMatchObject({ RISK_RUN_STATE_BLOCKS: 1 });
    expect(stagings.flatMap((staging) => staging.riskRefusals)).toEqual([]);
    expect(wrapped?.riskRefusals).toEqual([]);
  });

  it("a refusal the store cannot record is a store failure like any other: GLOBAL STORE_UNAVAILABLE", async () => {
    const run = assembleOrThrow({ config: refusingConfig() });
    run.parts.store.failOnly(["persistRiskRefusal"], "UNAVAILABLE", "provenance-1: ops.risk_events is unavailable");
    await drive(run);
    const halts = run.trader.loop.health().halts;
    expect(halts.map((halt) => [halt.scope.kind, halt.code, halt.action])).toEqual([["GLOBAL", "STORE_UNAVAILABLE", "FULL_HALT"]]);
    expect(halts[0]?.detail).toContain("a risk refusal could not be persisted");
    expect(halts[0]?.detail).toContain("ops.risk_events is unavailable");
    expect(run.parts.store.riskRefusals).toEqual([]);
  });

  it("an APPROVED intent records no refusal (the fixture's own policy)", async () => {
    const run = assembleOrThrow();
    await drive(run);
    expect(run.trader.loop.health().risk.approvals).toBeGreaterThanOrEqual(1);
    expect(run.trader.loop.health().risk.refusals).toBe(0);
    expect(run.parts.store.riskRefusals).toEqual([]);
  });
});
