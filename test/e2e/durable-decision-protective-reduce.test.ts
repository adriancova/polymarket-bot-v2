/**
 * `DURABLE-1` — the PROTECTIVE REDUCE path (`BRACKET-1a`) and the CANCEL's
 * priority, under the durability boundary the loop now keeps before a
 * placement (closeout blocker X1).
 *
 * The original `WP-250` scenario is the run that exercises both: its decisions
 * are an entry (`evaluationSeq` 1, `onFeatures`), a take-profit exit from
 * `onFill` (2), a CANCEL of that exit (6) and the protected reduce that
 * replaces it (8, `sb.protected-reduce`), which fills. Each case runs with
 * per-row writes and with group commit, through the harness's own in-memory
 * store observed by a wrapper (the only change to the composition).
 *
 * What is pinned:
 *
 * 1. The run is UNCHANGED — its artifact equals the committed golden byte for
 *    byte — and each placement's decision (the protected reduce's included)
 *    is durable when it is submitted. The CANCEL is not held for its OWN
 *    decision: it goes out first, as it always did (§6 invariant 13; a safety
 *    exit does not wait on a store round trip).
 * 2. A store that refuses the protected reduce's decision: the reduce is never
 *    submitted and books nothing; a GLOBAL `STORE_UNAVAILABLE` halt.
 * 3. A store that refuses the CANCEL's decision: the CANCEL still goes out,
 *    the halt follows, and no placement is made after it.
 */

import type { GroupCommit, StagedEvaluations, TraderStore } from "@polymarket-bot/trader";
import { portFailed, portOk } from "@polymarket-bot/trader";
import type { MemoryTraderStore } from "@polymarket-bot/trader/testing";
import { describe, expect, it } from "vitest";

import { captureArtifact, serializeArtifact } from "./support/artifact.js";
import { goldenBytes } from "./support/golden.js";
import { assembleOrThrow, type Run } from "./support/harness.js";
import { PAPER_E2E_SCENARIO } from "./support/scenario.js";

/** The golden's decisions (`test/replay-golden/paper-e2e/paper-e2e-run.json`). */
const ENTRY = 1;
const TAKE_PROFIT = 2;
const CANCEL = 6;
const PROTECTED_REDUCE = 8;

type Operation =
  | { readonly op: "decision_refused"; readonly evaluationSeq: number }
  | { readonly op: "ledger_write"; readonly undurableIntentDecisions: readonly number[] }
  | {
      readonly op: "venue_submit";
      readonly planKind: string;
      /** The decision whose intent this is: the loop routes a decision's intents right after it. */
      readonly origin: number;
      readonly originDurable: boolean;
    };

interface Observed {
  readonly run: Run;
  readonly timeline: readonly Operation[];
}

const REFUSAL = "DURABLE-1: the store refuses this decision";

async function observe(grouped: boolean, refuseSeq: number | undefined): Promise<Observed> {
  const timeline: Operation[] = [];
  let durableSeqs = (): Set<number> => new Set();
  let emitted = (): readonly { readonly evaluationSeq: number; readonly intentIds: readonly string[] }[] => [];

  const parts = assembleOrThrow({
    wrapStore(inner: MemoryTraderStore): TraderStore {
      durableSeqs = () => new Set(inner.decisions.map((entry) => entry.record.evaluationSeq));
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
          const decisions = batch.flatMap((evaluation) => evaluation.decisions);
          const refused = decisions.find((entry) => entry.record.evaluationSeq === refuseSeq);
          if (refused !== undefined) {
            timeline.push({ op: "decision_refused", evaluationSeq: refused.record.evaluationSeq });
            return portFailed<{ decisions: number; checkpoints: number }>("UNAVAILABLE", REFUSAL);
          }
          for (const entry of decisions) await inner.persistDecision(entry.record, entry.telemetry);
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
        persistDecision: async (record, telemetry) => {
          if (record.evaluationSeq === refuseSeq) {
            timeline.push({ op: "decision_refused", evaluationSeq: record.evaluationSeq });
            return portFailed<null>("UNAVAILABLE", REFUSAL);
          }
          return await inner.persistDecision(record, telemetry);
        },
        saveCheckpoint: (checkpoint, capturedAt) => inner.saveCheckpoint(checkpoint, capturedAt),
        appendLedgerTransaction: (transaction) => {
          const durable = durableSeqs();
          timeline.push({
            op: "ledger_write",
            undurableIntentDecisions: emitted()
              .filter((decision) => decision.intentIds.length > 0 && !durable.has(decision.evaluationSeq))
              .map((decision) => decision.evaluationSeq),
          });
          return inner.appendLedgerTransaction(transaction);
        },
        writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
        replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
        close: () => inner.close(),
        ...(grouped ? { groupCommit: group } : {}),
      };
    },
  });
  emitted = () => parts.trader.loop.decisions();

  const submit = parts.venue.submit.bind(parts.venue);
  parts.venue.submit = async (plan) => {
    const origin = [...emitted()].reverse().find((decision) => decision.intentIds.length > 0);
    if (origin === undefined) throw new Error("a submission with no intent-bearing decision before it");
    timeline.push({
      op: "venue_submit",
      planKind: plan.planKind,
      origin: origin.evaluationSeq,
      originDurable: durableSeqs().has(origin.evaluationSeq),
    });
    return await submit(plan);
  };

  // `driveScenario`, with the venue observed.
  for (const event of PAPER_E2E_SCENARIO.events()) {
    if (!parts.trader.loop.ingest(event)) throw new Error("the bounded ingest queue refused an event");
  }
  await parts.trader.loop.drain();
  parts.trader.loop.checkAccountingRebuild("END_OF_RUN");
  const run: Run = {
    scenario: PAPER_E2E_SCENARIO,
    parts,
    trader: parts.trader,
    orders: parts.venue.ordersSnapshot(),
    fills: parts.venue.fills,
  };
  return { run, timeline };
}

function submits(timeline: readonly Operation[]): readonly Extract<Operation, { op: "venue_submit" }>[] {
  return timeline.filter((entry): entry is Extract<Operation, { op: "venue_submit" }> => entry.op === "venue_submit");
}

describe.each([
  { arm: "per-row writes", grouped: false },
  { arm: "group commit", grouped: true },
])("the protective reduce and the CANCEL under the durability boundary — $arm (DURABLE-1)", ({ grouped }) => {
  it("the run is byte-identical to its golden; every placement's decision — the protected reduce's too — is durable at its submit; the CANCEL is not held for its own", async () => {
    const { run, timeline } = await observe(grouped, undefined);
    expect(serializeArtifact(captureArtifact(run))).toBe(goldenBytes(PAPER_E2E_SCENARIO));

    const sent = submits(timeline);
    expect(sent.map((entry) => entry.origin)).toEqual([ENTRY, TAKE_PROFIT, CANCEL, PROTECTED_REDUCE]);
    for (const entry of sent) {
      if (entry.planKind === "CANCEL") {
        expect(entry.origin).toBe(CANCEL);
        expect(entry.originDurable).toBe(false);
      } else {
        expect(entry.originDurable, `the decision at evaluationSeq ${String(entry.origin)}`).toBe(true);
      }
    }
    const ledger = timeline.filter((entry) => entry.op === "ledger_write");
    expect(ledger.length).toBeGreaterThan(0);
    for (const write of ledger) {
      if (write.op !== "ledger_write") throw new Error("unreachable");
      expect(write.undurableIntentDecisions).toEqual([]);
    }
    // The reduce filled: the protective exit still trades.
    const reduceDecision = run.parts.store.decisions.find((entry) => entry.record.evaluationSeq === PROTECTED_REDUCE);
    expect(reduceDecision?.record.decision.intents[0]).toMatchObject({ tags: expect.arrayContaining(["sb.protected-reduce"]) });
    expect(run.fills.length).toBeGreaterThanOrEqual(2);
  });

  it("a store that refuses the protected reduce's decision: the reduce is never submitted and books nothing; a GLOBAL halt", async () => {
    const baseline = await observe(grouped, undefined);
    const { run, timeline } = await observe(grouped, PROTECTED_REDUCE);

    expect(timeline.filter((entry) => entry.op === "decision_refused")).toEqual([
      { op: "decision_refused", evaluationSeq: PROTECTED_REDUCE },
    ]);
    // The strategy DID emit the reduce: the refusal is what stopped it.
    expect(run.trader.loop.decisions().some((decision) => decision.evaluationSeq === PROTECTED_REDUCE)).toBe(true);
    expect(submits(timeline).map((entry) => entry.origin)).toEqual([ENTRY, TAKE_PROFIT, CANCEL]);
    // Nothing after the refusal: no submission, no ledger write.
    const refusal = timeline.findIndex((entry) => entry.op === "decision_refused");
    expect(timeline.slice(refusal + 1)).toEqual([]);
    // Exactly the reduce's fill and postings are missing.
    expect(run.fills).toHaveLength(baseline.run.fills.length - 1);
    expect(run.parts.store.transactions.length).toBeLessThan(baseline.run.parts.store.transactions.length);
    expect(run.trader.halts.records().map((halt) => [halt.scope.kind, halt.code])).toEqual([
      ["GLOBAL", "STORE_UNAVAILABLE"],
    ]);
  });

  it("a store that refuses the CANCEL's decision: the CANCEL still goes out, the halt follows, and nothing is placed after it", async () => {
    const { run, timeline } = await observe(grouped, CANCEL);

    const sent = submits(timeline);
    expect(sent.map((entry) => [entry.origin, entry.planKind])).toEqual([
      [ENTRY, expect.not.stringMatching(/^CANCEL$/u)],
      [TAKE_PROFIT, expect.not.stringMatching(/^CANCEL$/u)],
      [CANCEL, "CANCEL"],
    ]);
    const cancelAt = timeline.findIndex((entry) => entry.op === "venue_submit" && entry.planKind === "CANCEL");
    const refusedAt = timeline.findIndex((entry) => entry.op === "decision_refused");
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(refusedAt).toBeGreaterThan(cancelAt);
    expect(run.trader.loop.health().execution.cancelsRequested).toBe(1);
    expect(run.trader.halts.records().map((halt) => [halt.scope.kind, halt.code])).toEqual([
      ["GLOBAL", "STORE_UNAVAILABLE"],
    ]);
  });
});
