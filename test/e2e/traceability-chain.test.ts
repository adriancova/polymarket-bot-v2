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
 *
 * `BRACKET-1b` converted two rows here into the rules they always stood for,
 * now that a run exists in which each rule's other case occurs
 * (`two-brackets.test.ts` walks it): a chain is anchored in a RECORDED event
 * unless the loop ORIGINATED its evaluation (`RECON2-EVENTHOP`), and a fill
 * books a fee posting exactly when its fee is not zero (a MAKER fill at
 * `makerFeeRate "0"` books two, `packages/ledger/src/fill-posting.ts:355`).
 */

import { describe, expect, it } from "vitest";

import { addDecimal, compareDecimal } from "@polymarket-bot/decimal";

import { captureArtifact, serializeArtifact, type PaperRunArtifact } from "./support/artifact.js";
import { explainWalk, walkChains, HOPS } from "./support/chain-walk.js";
import { goldenBytes } from "./support/golden.js";
import { driveScenario } from "./support/harness.js";

function parseGolden(): PaperRunArtifact {
  return JSON.parse(goldenBytes()) as PaperRunArtifact;
}

describe("acceptance 1 — the traceability chain is complete, walked from the outside", () => {
  /**
   * `RISK-2` widened this from an entry to a ROUND TRIP.
   *
   * It used to read `approvals 1`, `plansBuilt 1`, `submissionsAccepted 1`,
   * `fillsObserved 2`, `ledgerTransactions 6` — an entry, and nothing after it,
   * because GOV-2B blocker B2 refused every protective exit at the risk seam.
   * The counters are now 4/4/4 and 3: the entry, the take-profit, the cancel
   * that replaced it when the confirmed allocation grew, and the protective
   * reduction that closed the position.
   */
  it("the run trades a ROUND TRIP: an entry and an exit both reached the venue", async () => {
    const run = await driveScenario();
    const health = run.trader.loop.health();
    expect(health.halts).toEqual([]);
    expect(health.healthy).toBe(true);
    expect(health.risk.approvals).toBe(4);
    expect(health.risk.refusals).toBe(0);
    expect(health.execution.plansBuilt).toBe(4);
    expect(health.execution.submissionsAccepted).toBe(4);
    // THREE fills: the 50-share entry walked two ask levels (§12.2's Tier-0
    // immediate model emits one fill per consumed level), and the protective
    // reduction closed all 50 against the resting bid in one.
    expect(health.execution.fillsObserved).toBe(3);
    // The position really is closed — the property those counters exist to show.
    expect(run.fills.filter((fill) => fill.action === "BUY")).toHaveLength(2);
    expect(run.fills.filter((fill) => fill.action === "SELL")).toHaveLength(1);
    // Principal and token movement for every fill, and a fee posting exactly
    // when the fee is not zero (`fill-posting.ts:355`, `BRACKET-1b`): all three
    // of this run's fills are TAKER fills with a fee, so 3 × 3.
    expect(run.fills.every((fill) => compareDecimal(fill.feeAmount, "0") !== 0)).toBe(true);
    expect(health.accounting.ledgerTransactions).toBe(9);
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
    // The chain FANS OUT and now also BRANCHES. The entry decision produced one
    // intent, one plan, one order and TWO fills; the protective reduction that
    // closed the position produced a third. Three complete chains, from two
    // different decisions — which is what makes the one-posting-per-fill and
    // no-orphan checks non-trivial here. (`RISK-2`: this was 2 while B2 kept
    // every exit off the venue.)
    expect(report.chains).toHaveLength(3);
    for (const chain of report.chains) {
      expect(chain.hops.map((result) => result.hop)).toEqual([...HOPS]);
      expect(chain.ok).toBe(true);
    }
  });

  it("every hop resolves by id over the COMMITTED GOLDEN bytes", () => {
    const report = walkChains(parseGolden());
    expect(explainWalk(report)).toBe("the walk found nothing");
    expect(report.ok).toBe(true);
    expect(report.chains).toHaveLength(3);
  });

  /**
   * `RECON-2`. A chain exists only once a FILL completes it, so the take-profit
   * that rested and was withdrawn unfilled is on none of the three above. Its
   * origin is still resolvable by id: the loop recorded its trace PREFIX at
   * submission (`CoreLoop.orderProvenance()`), the document carries it, and the
   * walk resolves every record as a node — over the run's bytes and the
   * golden's alike (`traceability-chain-negative.test.ts` mutates each check).
   */
  it("every booked order's origin resolves by id — the withdrawn take-profit, on no chain, included", async () => {
    const produced = JSON.parse(
      serializeArtifact(captureArtifact(await driveScenario())),
    ) as PaperRunArtifact;
    for (const document of [produced, parseGolden()]) {
      expect(document.orderProvenance.map((record) => record.venueOrderId)).toEqual(
        document.orders.map((order) => order.simulatedOrderId),
      );
      const traced = new Set(document.traces.map((trace) => trace.venueOrderId));
      const [unfilled, ...others] = document.orderProvenance.filter(
        (record) => !traced.has(record.venueOrderId),
      );
      expect(others).toEqual([]);
      expect(unfilled).toBeDefined();
      if (unfilled === undefined) return;
      const order = document.orders.find((candidate) => candidate.simulatedOrderId === unfilled.venueOrderId);
      expect(order?.state).toBe("CANCELLED");
      expect(order?.filledShares).toBe("0");
      const decision = document.decisions.find(
        (candidate) =>
          candidate.runId === unfilled.runId && candidate.evaluationSeq === unfilled.evaluationSeq,
      );
      expect(decision?.decisionType).toBe("exit");
      expect(decision?.intents.map((intent) => intent.intentId)).toEqual([unfilled.intentId]);
      // An `onFill` evaluation, which the loop originated: the decision names
      // no source event, and the loop's record carries "" for it.
      expect(decision?.sourceEventId).toBeNull();
      expect(unfilled.sourceEventId).toBe("");
      expect(walkChains(document).findings).toEqual([]);
    }
  });

  /**
   * CONVERTED (`BRACKET-1b`, `RECON2-EVENTHOP`). This row read "every trace's
   * source event is recorded", which held only because no order placed by an
   * evaluation the loop ORIGINATED (`onFill`, `onOrderUpdate`) had ever filled
   * — this run's take-profit rests and is withdrawn. The rule it stands for is
   * the provenance rule: a chain names a RECORDED event, or names `""` exactly
   * when its persisted decision states none, and then ends at that decision
   * and its feature snapshot. Every chain of THIS run is of the first kind; the
   * two-bracket run's filled take-profit is of the second
   * (`two-brackets.test.ts`).
   */
  it("the chain is anchored in the RECORDED event, not in a clock", async () => {
    const artifact = captureArtifact(await driveScenario());
    const eventIds = new Set(artifact.events.map((event) => event.eventId));
    for (const trace of artifact.traces) {
      const decision = artifact.decisions.find(
        (candidate) =>
          candidate.runId === trace.runId && candidate.evaluationSeq === trace.evaluationSeq,
      );
      const anchored =
        eventIds.has(trace.sourceEventId) && decision?.sourceEventId === trace.sourceEventId;
      const loopOriginated = trace.sourceEventId === "" && decision?.sourceEventId === null;
      expect(anchored || loopOriginated).toBe(true);
      // THIS run's chains are all of the first kind.
      expect(anchored).toBe(true);
    }
    // TWO source events and TWO evaluations, not one: the entry's two chains
    // descend from the same event and the same decision — the fan-out happens
    // at the venue — and the protective reduction's chain descends from the
    // book refresh just before the close. (`RISK-2`: both were 1 while B2 kept
    // every exit off the venue. What the row still asserts is that the traces
    // are anchored in RECORDED events, which is checked exhaustively above.)
    expect(new Set(artifact.traces.map((trace) => trace.sourceEventId)).size).toBe(2);
    expect(new Set(artifact.traces.map((trace) => trace.evaluationSeq)).size).toBe(2);
    // The entry's chains still share one event and one evaluation between them.
    const entryTraces = artifact.traces.filter((trace) => trace.intentId.includes("sb-entry"));
    expect(entryTraces).toHaveLength(2);
    expect(new Set(entryTraces.map((trace) => trace.evaluationSeq)).size).toBe(1);
    // Every simulated outcome is anchored to a recorded ingest sequence, never
    // to a wall clock (§6 invariant 15).
    const ingestSeqs = new Set(artifact.events.map((event) => event.ingestSeq));
    for (const fill of artifact.fills) expect(ingestSeqs.has(fill.atEventIngestSeq)).toBe(true);
    for (const order of artifact.orders) expect(ingestSeqs.has(order.atEventIngestSeq)).toBe(true);
  });

  it("the two ends of the chain agree on the money: fills, postings and PnL", async () => {
    const artifact = captureArtifact(await driveScenario());

    // Each fill produced a principal and a token-movement posting, plus a fee
    // posting exactly when its fee is not zero — and every posting is claimed by
    // exactly one chain. (`RISK-2`: two fills and six postings became three and
    // nine when the exit began to execute. `BRACKET-1b` CONVERTED "three per
    // fill" into the rule it stood for, `fill-posting.ts:355`: every fill here
    // is a TAKER fill with a fee, so it is still nine; the two-bracket run's
    // zero-fee MAKER fill books two.)
    expect(artifact.fills).toHaveLength(3);
    const perFill = artifact.fills.map((fill) => {
      const trace = artifact.traces.find((candidate) => candidate.venueFillId === fill.simulatedFillId);
      return [trace?.ledgerTransactionIds.length, compareDecimal(fill.feeAmount, "0") !== 0 ? 3 : 2];
    });
    for (const [booked, expected] of perFill) expect(booked).toBe(expected);
    expect(artifact.ledgerTransactions).toHaveLength(9);
    const claimed = artifact.traces.flatMap((trace) => trace.ledgerTransactionIds);
    expect(claimed).toHaveLength(9);
    expect(new Set(claimed).size).toBe(9);
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

    // …and the run ends in PERSISTED PnL rows, one per instance per INSTANT
    // with fills (`SNAP-1`, the database's `pnl_snapshots_scope_unique` key):
    // TWO — the entry's two fills share `09:00:02`, and the exit posts its own
    // at `09:14:49`. (Three before `SNAP-1`, one per fill: two rows at one
    // instant, which the durable store refuses.)
    expect(artifact.pnlSnapshots).toHaveLength(2);
    expect(artifact.pnlSnapshots.map((snapshot) => snapshot["asOf"])).toEqual([
      "2026-05-01T09:00:02Z",
      "2026-05-01T09:14:49Z",
    ]);
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
    // `CKPT-1` re-pin (ADR-027): this was "every persisted decision has its
    // checkpoint" (`checkpointInstants` as long as `decisions`). A checkpoint
    // now follows only a decision that changes the state, the status or the
    // RNG, or starts, stops or heartbeats the instance (Decision 1). Here:
    // every checkpoint carries the sequence of a persisted decision of its own
    // instance, and every decision whose persisted patch CHANGED the folded
    // state has one — the scenario's last two holds (no patch) have none.
    const store = run.parts.store;
    const owed: string[] = [];
    const folded = new Map<string, Record<string, unknown>>();
    const lastBytes = new Map<string, string>();
    for (const entry of store.decisions) {
      const instance = entry.record.instanceId;
      // The state fold, done here with the test's own sorted-key bytes rather
      // than the runtime's serializer, so the oracle is independent of it.
      const state = { ...(folded.get(instance) ?? {}), ...(entry.record.decision.statePatch ?? {}) };
      folded.set(instance, state);
      const bytes = sortedJson(state);
      if (lastBytes.get(instance) !== bytes) owed.push(`${instance}|${String(entry.record.evaluationSeq)}`);
      lastBytes.set(instance, bytes);
    }
    expect(store.checkpoints.map((checkpoint) => `${checkpoint.instanceId}|${String(checkpoint.checkpointSeq)}`)).toEqual(owed);
    expect(artifact.checkpointInstants).toHaveLength(store.checkpoints.length);
    expect(artifact.checkpointInstants.length).toBeLessThan(artifact.decisions.length);
  });

  it("§6 invariant 8: the ledger projection is clean and attributes the position", async () => {
    const artifact = captureArtifact(await driveScenario());
    expect(artifact.ledgerProjection.unattributedActivity).toBe(0);
    expect(artifact.ledgerProjection.unexplainedMovements).toBe(0);
    expect(artifact.ledgerProjection.transactionCount).toBe(
      artifact.ledgerTransactions.length,
    );
    // `RISK-2`: this used to read
    //     expect(token?.instanceId).toBe(artifact.scenario.instanceId);
    //     expect(token?.balance).toBe("50");
    // — the position the run could not exit. The bracket now closes, and this
    // projection carries no line for a zero balance, so the outcome-token line
    // is ABSENT. The two things worth asserting survive the change and are
    // asserted directly: every line the projection does carry is attributed to
    // this instance, and the token position is FLAT — cross-checked against the
    // venue's own fills rather than inferred from the absence.
    for (const line of artifact.ledgerProjection.virtualPositions) {
      expect(line.instanceId).toBe(artifact.scenario.instanceId);
    }
    const token = artifact.ledgerProjection.virtualPositions.find(
      (line) => line.assetKind === "OUTCOME_TOKEN",
    );
    expect(token).toBeUndefined();
    const bought = artifact.fills.filter((fill) => fill.action === "BUY");
    const sold = artifact.fills.filter((fill) => fill.action === "SELL");
    expect(bought.reduce((total, fill) => addDecimal(total, fill.shares), "0")).toBe(
      sold.reduce((total, fill) => addDecimal(total, fill.shares), "0"),
    );
    // The collateral line is what remains, and it is the round trip's result.
    const cash = artifact.ledgerProjection.virtualPositions.find(
      (line) => line.assetKind === "COLLATERAL",
    );
    expect(cash?.balance).toBe("-1.632");
  });
});

/** `CKPT-1`: plain JSON with sorted keys — the oracle's own byte form (above). */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
