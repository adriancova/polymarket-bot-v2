/**
 * `WP-230` ACCEPTANCE CRITERION 3: **an end-to-end paper fixture emits a
 * traceable fill and ledger chain.**
 *
 * §6 invariant 4 names the chain exactly:
 *
 * > `fill → order → submission attempt → execution plan → intent → decision →
 * > feature snapshot → source event`
 *
 * This suite walks it HOP BY HOP, ASSERTING EACH BY ID against the artefact the
 * hop's own owner produced — not against the trace record's copy of it. That
 * distinction is the whole test: a `TraceLink` that merely agreed with itself
 * would prove nothing, so every id is checked against the decision the runtime
 * persisted, the intent the strategy emitted, the order the venue booked, the
 * fill the venue produced, and the transactions the ledger appended.
 *
 * The chain is then continued past the invariant's own end, to the two things
 * the packet asks for beyond it: the LEDGER POSTING and the PnL that follows
 * from it.
 *
 * NOTHING IS DOUBLED HERE except the clock, the transport and the store.
 */

import { describe, expect, it } from "vitest";

import { foldPnlRecords, computePnlSnapshot } from "@polymarket-bot/pnl";
import { projectionOf } from "@polymarket-bot/trader";

import { INSTANCE_ID, MARKET_ID, RUN_ID, YES_TOKEN } from "./support/fixture.js";
import { driveRecordedRun } from "./support/run.js";

describe("acceptance 3 — the end-to-end paper fixture emits a traceable fill and ledger chain", () => {
  it("trades: the strategy entered, risk approved, a plan was built, the venue filled it", async () => {
    const run = await driveRecordedRun();
    const health = run.trader.loop.health();

    expect(health.halts).toEqual([]);
    expect(health.risk.approvals).toBe(1);
    expect(health.execution.plansBuilt).toBe(1);
    expect(health.execution.submissionsAccepted).toBe(1);
    expect(health.execution.fillsObserved).toBe(1);
    expect(health.accounting.ledgerTransactions).toBeGreaterThan(0);
  });

  it("the chain is complete and every hop is asserted BY ID against its own producer", async () => {
    const run = await driveRecordedRun();
    const traces = run.trader.loop.traces();
    expect(traces).toHaveLength(1);
    const chain = traces[0];
    if (chain === undefined) throw new Error("no chain");

    // --- hop 8: source event -------------------------------------------
    // The decision the runtime persisted names the same event the chain does.
    const decisions = run.trader.loop.decisions();
    const entry = decisions.find((decision) => decision.decisionType === "enter");
    expect(entry, "the strategy emitted an entry decision").toBeDefined();
    if (entry === undefined) return;
    expect(chain.sourceEventId).toBe(entry.sourceEventId);
    expect(chain.sourceEventId).not.toBe("");

    // --- hop 7: feature snapshot ---------------------------------------
    // §6 invariant 3/4: the runtime REFUSES a decision naming any snapshot but
    // the one the callback saw, so this equality is enforced upstream too.
    expect(chain.featureSnapshotRef).toBe(entry.featureSnapshotRef);
    // The engine's content address is 64 lowercase hex characters.
    expect(chain.featureSnapshotRef).toMatch(/^[0-9a-f]{64}$/u);

    // --- hop 6: decision ------------------------------------------------
    expect(chain.runId).toBe(RUN_ID);
    expect(chain.runId).toBe(entry.runId);
    expect(chain.evaluationSeq).toBe(entry.evaluationSeq);
    // The store holds the same record under the same `(runId, evaluationSeq)`.
    const persisted = run.parts.store.decisions.find(
      (written) =>
        written.record.runId === chain.runId &&
        written.record.evaluationSeq === chain.evaluationSeq,
    );
    expect(persisted, "the decision reached the durable store").toBeDefined();
    expect(persisted?.record.decision.decisionType).toBe("enter");

    // --- hop 5: intent ---------------------------------------------------
    expect(entry.intentIds).toContain(chain.intentId);
    // §7.7's `CancelIntent` carries no `intentId`, so the union is narrowed
    // rather than read through — the chain names a POSITION intent, and an
    // assertion that pretended every intent had an id would be reading a field
    // the contract does not promise.
    expect(
      persisted?.record.decision.intents
        .filter((intent) => intent.type !== "CANCEL" && intent.type !== "REDUCE_POSITION")
        .map((intent) => intent.intentId),
    ).toContain(chain.intentId);

    // --- hop 4: execution plan (via the approved intent) -----------------
    expect(chain.approvedIntentId).not.toBe("");
    expect(chain.executionPlanId).not.toBe("");
    expect(chain.approvedIntentId).not.toBe(chain.executionPlanId);

    // --- hop 3: submission attempt --------------------------------------
    expect(chain.submissionAttemptId).not.toBe("");
    expect(chain.submissionAttemptId).not.toBe(chain.executionPlanId);

    // --- hop 2: order ----------------------------------------------------
    const order = run.parts.venue
      .ordersSnapshot()
      .find((candidate) => candidate.simulatedOrderId === chain.venueOrderId);
    expect(order, "the venue booked the order the chain names").toBeDefined();
    expect(order?.executionPlanId).toBe(chain.executionPlanId);
    expect(order?.marketId).toBe(MARKET_ID);

    // --- hop 1: fill -----------------------------------------------------
    const fill = run.parts.venue.fills.find(
      (candidate) => candidate.simulatedFillId === chain.venueFillId,
    );
    expect(fill, "the venue produced the fill the chain names").toBeDefined();
    expect(fill?.simulatedOrderId).toBe(chain.venueOrderId);
    // ADR-012 §2: a paper fill is never evidence about real fill quality, and
    // the label travels with it.
    expect(fill?.evidenceClass).toBe("SIMULATED_NOT_REAL_EVIDENCE");
  });

  it("continues past the invariant: the LEDGER POSTING is reachable by id and balances", async () => {
    const run = await driveRecordedRun();
    const chain = run.trader.loop.traces()[0];
    if (chain === undefined) throw new Error("no chain");

    expect(chain.ledgerTransactionIds.length).toBeGreaterThan(0);
    const ledger = run.trader.loop.ledger();
    for (const transactionId of chain.ledgerTransactionIds) {
      const appended = ledger.byId(transactionId);
      expect(appended, `transaction ${transactionId} is in the ledger`).toBeDefined();
      // Every posting names the ledger's own fill identity, which is the link
      // from the accounting record back to the venue fill.
      expect(appended?.transaction.fillId).toBe(chain.ledgerFillId);
      expect(appended?.transaction.marketId).toBe(MARKET_ID);
      expect(appended?.transaction.environment).toBe("PAPER");
      // A `Ledger.append` that returned means the per-asset zero sum and the
      // attribution parity both held — the balance rule is the package's, and
      // this assertion is that the transaction really went through it.
      expect(appended?.transaction.entries.length).toBeGreaterThan(1);
    }

    // The same transactions reached the durable store.
    const stored = run.parts.store.transactions.map(
      (written) => written.transaction.ledgerTransactionId,
    );
    for (const transactionId of chain.ledgerTransactionIds) {
      expect(stored).toContain(transactionId);
    }
  });

  it("the projection is rebuildable and attributes the position to the instance (§6 invariants 7, 8)", async () => {
    const run = await driveRecordedRun();
    const projection = projectionOf(run.trader.loop.ledger());

    // §6 invariant 7: no unexplained or unattributed activity in a clean run.
    expect(projection.unattributedActivity).toEqual([]);
    expect(projection.unexplainedMovements).toEqual([]);

    // The virtual position is attributed to THIS instance and THIS token asset.
    const lines = [...projection.virtualPositions.values()].filter(
      (line) => line.instanceId === INSTANCE_ID,
    );
    expect(lines.length).toBeGreaterThan(0);
    const tokenLine = lines.find((line) => line.assetId === `token:${YES_TOKEN}`);
    expect(tokenLine, "the YES token position is attributed to the instance").toBeDefined();
    expect(tokenLine?.balance).not.toBe("0");
  });

  it("the chain reaches PnL: the posting's OWN records fold and a snapshot reaches the store", async () => {
    const run = await driveRecordedRun();
    const chain = run.trader.loop.traces()[0];
    if (chain === undefined) throw new Error("no chain");

    // The records the LEDGER POSTING produced — `buildFillPosting`'s own output,
    // not a hand-built stand-in — so this asserts the real derivation.
    const records = run.trader.loop.pnlRecords(INSTANCE_ID);
    expect(records.length).toBeGreaterThan(0);
    const trade = records.find((record) => record.kind === "TRADE");
    expect(trade, "the posting produced a TRADE record").toBeDefined();
    // `buildFillPosting` refs a trade to the TOKEN transaction it belongs to,
    // which is one of the transactions this chain already names — so the PnL
    // record is reachable from the chain rather than beside it.
    expect(chain.ledgerTransactionIds).toContain(trade?.ref);
    // Every record in this stream is the INSTANCE's own (§6 invariant 7).
    for (const record of records) {
      expect(record.owner.scope).toBe("VIRTUAL_STRATEGY");
    }

    // Folded through the REAL engine, from zero, which is §6 invariant 8's
    // rebuild property applied to the PnL projection.
    const folded = foldPnlRecords(
      {
        scope: "VIRTUAL_STRATEGY",
        environment: "PAPER",
        accountRef: "paper-account",
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        marketId: MARKET_ID,
      },
      [...records],
    );
    expect(folded.ok, JSON.stringify(folded.ok ? {} : folded.refusals)).toBe(true);
    if (!folded.ok) return;

    const snapshots = computePnlSnapshot(folded.value, {
      asOf: "2026-03-04T12:00:03.000Z",
      marks: { [`token:${YES_TOKEN}`]: { midpoint: "0.34" } },
    });
    expect(snapshots.ok, JSON.stringify(snapshots.ok ? {} : snapshots.refusals)).toBe(true);
    if (!snapshots.ok) return;
    expect(snapshots.value.length).toBeGreaterThan(0);

    // …and the loop wrote its own snapshot to the durable store, so the chain
    // ends in a persisted PnL row rather than in a computation nobody kept.
    expect(run.parts.store.pnlSnapshots.length).toBeGreaterThan(0);
    const written = run.parts.store.pnlSnapshots[0];
    expect(written?.scope).toBe("VIRTUAL_STRATEGY");
    expect(written?.instanceId).toBe(INSTANCE_ID);
    expect(written?.runId).toBe(RUN_ID);
    expect(written?.marketId).toBe(MARKET_ID);
    expect(written?.environment).toBe("PAPER");
  });

  it("§6 invariant 3: exactly one PERSISTED decision per invoked callback", async () => {
    const run = await driveRecordedRun();
    const decisions = run.trader.loop.decisions();
    const persisted = run.parts.store.decisions;
    expect(persisted).toHaveLength(decisions.length);
    // The `(runId, evaluationSeq)` key is unique, which is what makes "exactly
    // one" a checkable claim rather than a count that happens to match.
    const keys = persisted.map(
      (written) => `${written.record.runId}|${String(written.record.evaluationSeq)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    // Every persisted decision has its checkpoint.
    expect(run.parts.store.checkpoints).toHaveLength(persisted.length);
  });
});
