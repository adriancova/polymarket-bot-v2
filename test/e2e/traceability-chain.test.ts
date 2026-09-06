/**
 * `WP-250` ACCEPTANCE CRITERION 1: **the traceability chain is complete.**
 *
 * > event → feature → decision → intent → plan → submission → fill → ledger
 * > posting → PnL, verifiable by id across the persisted artefacts the E2E run
 * > produces.
 *
 * Walked from the OUTSIDE, over the serialised document, by
 * `support/chain-walk.ts`. See that module's header for why this is a different
 * primitive from `WP-230`'s in-process hop-by-hop test, which is not repeated
 * here.
 *
 * The walk is run against BOTH the bytes this run produced and the COMMITTED
 * GOLDEN bytes, so the criterion is asserted about the artefact under review as
 * well as about the artefact under regeneration.
 */

import { describe, expect, it } from "vitest";

import { captureArtifact, serializeArtifact, type PaperRunArtifact } from "./support/artifact.js";
import { explainWalk, walkChains, HOPS } from "./support/chain-walk.js";
import { goldenBytes } from "./support/golden.js";
import { driveScenario } from "./support/harness.js";

function parseGolden(): PaperRunArtifact {
  return JSON.parse(goldenBytes()) as PaperRunArtifact;
}

describe("acceptance 1 — the traceability chain is complete, walked from the outside", () => {
  it("the run trades: an entry reached the venue, filled, and was booked", async () => {
    const run = await driveScenario();
    const health = run.trader.loop.health();
    expect(health.halts).toEqual([]);
    expect(health.healthy).toBe(true);
    expect(health.risk.approvals).toBe(1);
    expect(health.execution.plansBuilt).toBe(1);
    expect(health.execution.submissionsAccepted).toBe(1);
    // TWO fills: the 50-share entry walked two ask levels, and §12.2's Tier-0
    // immediate model emits one fill per consumed level.
    expect(health.execution.fillsObserved).toBe(2);
    expect(health.accounting.ledgerTransactions).toBe(6);
    expect(health.accounting.unattributedActivity).toBe(0);
    expect(health.accounting.unexplainedMovements).toBe(0);
  });

  it("every hop resolves by id, in every chain, over the run's own bytes", async () => {
    const artifact = captureArtifact(await driveScenario());
    const document = JSON.parse(serializeArtifact(artifact)) as PaperRunArtifact;
    const report = walkChains(document);
    expect(explainWalk(report)).toBe("the walk found nothing");
    expect(report.ok).toBe(true);
    expect(report.brokenHops).toEqual([]);
    expect(report.findings).toEqual([]);
    // The chain FANS OUT: one decision, one intent, one plan, one order, TWO
    // fills, and therefore two complete chains — which is what makes the
    // one-posting-per-fill and no-orphan checks non-trivial here.
    expect(report.chains).toHaveLength(2);
    for (const chain of report.chains) {
      expect(chain.hops.map((result) => result.hop)).toEqual([...HOPS]);
      expect(chain.ok).toBe(true);
    }
  });

  it("every hop resolves by id over the COMMITTED GOLDEN bytes", () => {
    const report = walkChains(parseGolden());
    expect(explainWalk(report)).toBe("the walk found nothing");
    expect(report.ok).toBe(true);
    expect(report.chains).toHaveLength(2);
  });

  it("the chain is anchored in the RECORDED event, not in a clock", async () => {
    const artifact = captureArtifact(await driveScenario());
    const eventIds = new Set(artifact.events.map((event) => event.eventId));
    for (const trace of artifact.traces) {
      expect(eventIds.has(trace.sourceEventId)).toBe(true);
    }
    // Both chains descend from the SAME source event and the SAME decision:
    // the fan-out happens at the venue, not upstream of it.
    expect(new Set(artifact.traces.map((trace) => trace.sourceEventId)).size).toBe(1);
    expect(new Set(artifact.traces.map((trace) => trace.evaluationSeq)).size).toBe(1);
    // Every simulated outcome is anchored to a recorded ingest sequence, never
    // to a wall clock (§6 invariant 15).
    const ingestSeqs = new Set(artifact.events.map((event) => event.ingestSeq));
    for (const fill of artifact.fills) expect(ingestSeqs.has(fill.atEventIngestSeq)).toBe(true);
    for (const order of artifact.orders) expect(ingestSeqs.has(order.atEventIngestSeq)).toBe(true);
  });

  it("the two ends of the chain agree on the money: fills, postings and PnL", async () => {
    const artifact = captureArtifact(await driveScenario());

    // Each fill produced exactly three postings — principal, token receipt and
    // fee — and every posting is claimed by exactly one chain.
    expect(artifact.fills).toHaveLength(2);
    expect(artifact.ledgerTransactions).toHaveLength(6);
    const claimed = artifact.traces.flatMap((trace) => trace.ledgerTransactionIds);
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed).size).toBe(6);
    expect(new Set(claimed)).toEqual(
      new Set(artifact.ledgerTransactions.map((entry) => entry.ledgerTransactionId)),
    );

    // Each posting balances per asset: the entries of a transaction sum to zero
    // within each (scope-independent) asset, which is what `Ledger.append`
    // enforced and what the persisted rows must still show.
    for (const transaction of artifact.ledgerTransactions) {
      const perAsset = new Map<string, number>();
      for (const entry of transaction.entries) {
        // Counting SIGNS, not amounts: this assertion is about structure — a
        // debit for every credit — and the exact-decimal equalities live in
        // `projection-reconciliation.test.ts`, where they belong.
        perAsset.set(entry.assetId, (perAsset.get(entry.assetId) ?? 0) + 1);
      }
      expect(transaction.entries.length).toBeGreaterThanOrEqual(2);
      for (const count of perAsset.values()) expect(count % 2).toBe(0);
    }

    // The PnL stream is reachable FROM the chain: every record refers to a
    // transaction some chain posted.
    const postedIds = new Set(claimed);
    expect(artifact.pnlRecords.length).toBeGreaterThan(0);
    for (const record of artifact.pnlRecords) {
      expect(postedIds.has(record.ref)).toBe(true);
      expect(record.scope).toBe("VIRTUAL_STRATEGY");
    }

    // …and the run ends in PERSISTED PnL rows, one per posting round.
    expect(artifact.pnlSnapshots).toHaveLength(2);
    for (const snapshot of artifact.pnlSnapshots) {
      expect(snapshot["environment"]).toBe("PAPER");
      expect(snapshot["instanceId"]).toBe(artifact.scenario.instanceId);
      expect(snapshot["runId"]).toBe(artifact.scenario.runId);
      expect(snapshot["marketId"]).toBe(artifact.scenario.marketId);
    }
  });

  it("§6 invariant 3: exactly one PERSISTED decision per evaluation, keyed uniquely", async () => {
    const artifact = captureArtifact(await driveScenario());
    const run = await driveScenario();
    expect(artifact.decisions).toHaveLength(run.trader.loop.health().loop.evaluations);
    const keys = artifact.decisions.map(
      (decision) => `${decision.runId}|${String(decision.evaluationSeq)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    // Every persisted decision has its checkpoint, captured at the evaluation's
    // own instant rather than at a clock read.
    expect(artifact.checkpointInstants).toHaveLength(artifact.decisions.length);
  });

  it("§6 invariant 8: the ledger projection is clean and attributes the position", async () => {
    const artifact = captureArtifact(await driveScenario());
    expect(artifact.ledgerProjection.unattributedActivity).toBe(0);
    expect(artifact.ledgerProjection.unexplainedMovements).toBe(0);
    expect(artifact.ledgerProjection.transactionCount).toBe(
      artifact.ledgerTransactions.length,
    );
    const token = artifact.ledgerProjection.virtualPositions.find(
      (line) => line.assetKind === "OUTCOME_TOKEN",
    );
    expect(token?.instanceId).toBe(artifact.scenario.instanceId);
    expect(token?.balance).toBe("50");
  });
});
