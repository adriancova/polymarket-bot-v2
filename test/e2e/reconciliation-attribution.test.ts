/**
 * `RECON-1` — the reconciler's two latent traps, closed and pinned; `RECON-2` —
 * every order attributed BY ID, and an open position at run end named.
 *
 * `RISK-2` fixed the ENTRY side of `support/reconcile.ts` (its rows are
 * attributed by id down the §6 invariant 4 chain, never by `action`) and its
 * review recorded two traps that are exact for this one-bracket scenario and
 * wrong for the next one:
 *
 * - **`RISK2-R3`** — the EXIT side was the COMPLEMENT of the entry set, and only
 *   the FIRST `enter` decision was read. A second entry's purchase, or a fill no
 *   chain accounts for at all, would have been summed into exit proceeds; an
 *   entry order withdrawn unfilled would have been reported under
 *   `exit.cancelled_proceeds.*` as a withdrawn take-profit.
 * - **`RISK2-R4`** — the FIFO fold iterated the entry fills in ARRAY order, so a
 *   partial exit would have made `pnl.capital_committed` depend on how the
 *   document happened to be serialised.
 *
 * `RECON-1` r1 then replaced that FIFO fold with `packages/pnl`'s own cost
 * method, average cost, restated from its specification: a FIFO oracle flagged
 * a correct partial-exit run as unexplained. The sequence ordering stays —
 * average cost is order-sensitive across interleaved purchases and sales.
 *
 * `RECON-2` (closing `RECON1-ORIGIN`): the loop records every order's trace
 * PREFIX at SUBMISSION, filled or not, and the artefact now carries it (golden
 * format 2, `orderProvenance`). `RECON-1` had no such record for an order that
 * never filled and attributed those orders by a CLOSED-WORLD INFERENCE — a
 * compatible origin, no non-exit candidate, a one-to-one matching. That
 * inference is retired: every order is resolved through its own record to the
 * emission `(runId, evaluationSeq, intentId)` that placed it, an order without
 * a record is refused, and a record a fill's trace contradicts is refused. Every
 * `RECON-1` pin that existed for the closed-world rule is CONVERTED below, not
 * deleted; where a pin's refusal now fires for a different reason, its comment
 * says so. (`RECON1-EDGE`, the last describe block, is the orchestrator's ruling
 * on an open position at run end.)
 *
 * Every probe here follows `projection-reconciliation.test.ts`'s falsifiability
 * pattern: the COMMITTED GOLDEN is parsed afresh (a deep copy), changed in one
 * deliberate way, and handed to `buildReconciliation`. Each synthetic artefact
 * carries a precondition that makes it non-vacuous — the change really is
 * reachable by the rule under test. A synthetic order is given the provenance
 * record the loop would have written for it unless the probe is ABOUT a missing
 * or contradicting record, so each refusal below fires for the reason it names
 * and not because the synthetic was malformed in some other way.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DIVISION_PRECISION,
  DIVISION_ROUNDING,
  addDecimal,
  compareDecimal,
  divDecimalExact,
  mulDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";
import {
  computePnlSnapshot,
  foldPnlRecords,
  type PnlFeeRecord,
  type PnlRecord,
  type PnlSnapshot,
  type PnlStreamIdentity,
  type PnlTradeRecord,
} from "@polymarket-bot/pnl";

import {
  captureArtifact,
  type ArtifactDecision,
  type ArtifactFill,
  type ArtifactIntent,
  type ArtifactOrder,
  type ArtifactOrderProvenance,
  type ArtifactTrace,
  type PaperRunArtifact,
} from "./support/artifact.js";
import { walkChains } from "./support/chain-walk.js";
import { goldenBytes } from "./support/golden.js";
import { driveScenario } from "./support/harness.js";
import { COMPUTED_SPECIFIER, moduleSpecifiersIn } from "./support/module-specifiers.js";
import {
  PNL_COST_DIVISION,
  buildReconciliation,
  compareFillIds,
  compareIngestSeq,
  unexplainedRows,
  type ReconciliationRow,
} from "./support/reconcile.js";
import { INSTANCE_ID } from "./support/scenario.js";

// --- the golden, and its landmarks, found by id ------------------------------

/** A fresh deep copy of the committed golden: a mutation cannot leak between tests. */
function golden(): PaperRunArtifact {
  return JSON.parse(goldenBytes()) as PaperRunArtifact;
}

function only<T>(values: readonly T[], what: string): T {
  const [value] = values;
  if (value === undefined || values.length !== 1) {
    throw new Error(`the golden should hold exactly one ${what}; it holds ${String(values.length)}`);
  }
  return value;
}

function row(rows: readonly ReconciliationRow[], id: string): ReconciliationRow {
  const found = rows.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`the table has no row ${id}`);
  return found;
}

/** The one provenance record the artefact holds for `orderId`. */
function recordOf(artifact: PaperRunArtifact, orderId: string): ArtifactOrderProvenance {
  return only(
    artifact.orderProvenance.filter((record) => record.venueOrderId === orderId),
    `provenance record of order ${orderId}`,
  );
}

interface Landmarks {
  readonly enter: ArtifactDecision;
  readonly entryIntent: ArtifactIntent;
  readonly entryTrace: ArtifactTrace;
  readonly entryOrder: ArtifactOrder;
  readonly entryRecord: ArtifactOrderProvenance;
  readonly entryFills: readonly ArtifactFill[];
  readonly exitDecision: ArtifactDecision;
  readonly reduce: ArtifactDecision;
  readonly exitTrace: ArtifactTrace;
  readonly exitOrder: ArtifactOrder;
  readonly exitRecord: ArtifactOrderProvenance;
  readonly exitFill: ArtifactFill;
  readonly takeProfit: ArtifactOrder;
  readonly takeProfitRecord: ArtifactOrderProvenance;
}

/** The golden's chain, walked by id — the same walk the reconciler makes. */
function landmarks(artifact: PaperRunArtifact): Landmarks {
  const enter = only(
    artifact.decisions.filter((decision) => decision.decisionType === "enter"),
    "enter decision",
  );
  const entryIntent = only(
    enter.intents.filter((intent) => intent.type === "POSITION"),
    "entry POSITION intent",
  );
  const entryTraces = artifact.traces.filter((trace) => trace.intentId === entryIntent.intentId);
  const entryTrace = entryTraces[0];
  if (entryTrace === undefined) throw new Error("the golden's entry has no trace");
  const entryOrder = only(
    artifact.orders.filter((order) => order.executionPlanId === entryTrace.executionPlanId),
    "entry order",
  );
  const reduce = only(
    artifact.decisions.filter((decision) => decision.decisionType === "reduce"),
    "reduce decision",
  );
  const reduceIntentId = only(reduce.intents, "reduce intent").intentId;
  const exitTrace = only(
    artifact.traces.filter((trace) => trace.intentId === reduceIntentId),
    "exit trace",
  );
  const exitOrder = only(
    artifact.orders.filter((order) => order.executionPlanId === exitTrace.executionPlanId),
    "exit order",
  );
  const takeProfit = only(
    artifact.orders.filter((order) => order.state === "CANCELLED"),
    "withdrawn order",
  );
  return {
    enter,
    entryIntent,
    entryTrace,
    entryOrder,
    entryRecord: recordOf(artifact, entryOrder.simulatedOrderId),
    entryFills: artifact.fills.filter(
      (fill) => fill.simulatedOrderId === entryOrder.simulatedOrderId,
    ),
    exitDecision: only(
      artifact.decisions.filter((decision) => decision.decisionType === "exit"),
      "exit decision",
    ),
    reduce,
    exitTrace,
    exitOrder,
    exitRecord: recordOf(artifact, exitOrder.simulatedOrderId),
    exitFill: only(
      artifact.fills.filter((fill) => fill.simulatedFillId === exitTrace.venueFillId),
      "exit fill",
    ),
    takeProfit,
    takeProfitRecord: recordOf(artifact, takeProfit.simulatedOrderId),
  };
}

// --- synthetic pieces, in the golden's own id namespace ----------------------

/** An execution-plan id the golden does not use (it stops at `…018000`). */
function planId(suffix: string): string {
  return `9280f970-9280-7000-8000-0000000${suffix}`;
}

/** An order under a plan of its own, shaped like `base`. */
function orderUnder(
  base: ArtifactOrder,
  plan: string,
  changes: Partial<ArtifactOrder>,
): ArtifactOrder {
  const id = `${plan}:g0:o0`;
  return {
    ...base,
    simulatedOrderId: id,
    plannedOrderId: id,
    executionPlanId: plan,
    ...changes,
  };
}

/** A fill of `order`, shaped like `base`. */
function fillOf(
  base: ArtifactFill,
  order: ArtifactOrder,
  changes: Partial<ArtifactFill>,
): ArtifactFill {
  return {
    ...base,
    simulatedFillId: `${order.simulatedOrderId}/t0/0`,
    simulatedOrderId: order.simulatedOrderId,
    ...changes,
  };
}

/**
 * The provenance record the loop would write at SUBMISSION for `order`, placed
 * by the emission `(base.runId, evaluationSeq, intentId)`. `base` supplies the
 * source event and feature snapshot; every per-order id is the order's own.
 */
function provenanceFor(
  base: ArtifactOrderProvenance,
  emission: { readonly evaluationSeq: number; readonly intentId: string },
  order: ArtifactOrder,
): ArtifactOrderProvenance {
  return {
    ...base,
    evaluationSeq: emission.evaluationSeq,
    intentId: emission.intentId,
    approvedIntentId: `${order.executionPlanId}-approved`,
    executionPlanId: order.executionPlanId,
    submissionAttemptId: `${order.executionPlanId}-submission`,
    venueOrderId: order.simulatedOrderId,
  };
}

/** The trace the loop would record for `fill`: its order's record, completed by the fill. */
function traceOf(record: ArtifactOrderProvenance, fill: ArtifactFill): ArtifactTrace {
  return {
    ...record,
    venueFillId: fill.simulatedFillId,
    ledgerFillId: `${fill.simulatedFillId}-ledger`,
    ledgerTransactionIds: [],
  };
}

/** `artifact` with `records` appended to its provenance section. */
function withRecords(
  artifact: PaperRunArtifact,
  ...records: readonly ArtifactOrderProvenance[]
): PaperRunArtifact {
  return { ...artifact, orderProvenance: [...artifact.orderProvenance, ...records] };
}

/** `artifact` with `orderId`'s provenance record removed. */
function withoutRecordOf(artifact: PaperRunArtifact, orderId: string): PaperRunArtifact {
  return {
    ...artifact,
    orderProvenance: artifact.orderProvenance.filter((record) => record.venueOrderId !== orderId),
  };
}

/** `artifact` with `orderId`'s provenance record changed. */
function withRecordChanged(
  artifact: PaperRunArtifact,
  orderId: string,
  changes: Partial<ArtifactOrderProvenance>,
): PaperRunArtifact {
  return {
    ...artifact,
    orderProvenance: artifact.orderProvenance.map((record) =>
      record.venueOrderId === orderId ? { ...record, ...changes } : record,
    ),
  };
}

/** A copy of `decision`, re-keyed to `evaluationSeq` — a distinct emission of the same intents. */
function reemitted(decision: ArtifactDecision, evaluationSeq: number): ArtifactDecision {
  return { ...decision, evaluationSeq };
}

/** A QUOTE decision at `evaluationSeq`, emitting one QUOTE intent `intentId`. */
function quoteDecision(
  artifact: PaperRunArtifact,
  marks: Landmarks,
  evaluationSeq: number,
  intentId: string,
): ArtifactDecision {
  return {
    ...marks.exitDecision,
    evaluationSeq,
    decisionType: "quote",
    intents: [{ type: "QUOTE", intentId, marketId: artifact.scenario.marketId }],
  };
}

/**
 * A SECOND BRACKET's entry: a new `enter` decision, its own POSITION intent, and
 * an order under a plan of its own, with the provenance record the loop would
 * write for it — either FILLED (with its fill and trace), or WITHDRAWN
 * UNFILLED, which has no trace because the loop traces fills.
 */
function withSecondEntry(
  artifact: PaperRunArtifact,
  outcome: "FILLED" | "WITHDRAWN_UNFILLED",
): PaperRunArtifact {
  const marks = landmarks(artifact);
  const intentId = `sb-entry-3-${artifact.scenario.marketId}`;
  const evaluationSeq = 18;
  const decision: ArtifactDecision = {
    ...marks.enter,
    evaluationSeq,
    intents: [
      { ...marks.entryIntent, intentId, targetShares: "10", maximumTotalCost: "3.5" },
    ],
  };
  if (outcome === "WITHDRAWN_UNFILLED") {
    // A PASSIVE entry that rested and was withdrawn: the realistic way a second
    // bracket's entry ends with no fill.
    const order = orderUnder(marks.entryOrder, planId("fa000"), {
      requestedShares: "10",
      filledShares: "0",
      state: "CANCELLED",
      postOnly: true,
      executionStyle: "REST",
      limitPrice: "0.33",
      atEventIngestSeq: "8",
    });
    return withRecords(
      {
        ...artifact,
        decisions: [...artifact.decisions, decision],
        orders: [...artifact.orders, order],
      },
      provenanceFor(marks.entryRecord, { evaluationSeq, intentId }, order),
    );
  }
  const order = orderUnder(marks.entryOrder, planId("fa000"), {
    requestedShares: "10",
    filledShares: "10",
    atEventIngestSeq: "8",
  });
  const base = marks.entryFills[0];
  if (base === undefined) throw new Error("the golden's entry has no fill");
  const fill = fillOf(base, order, {
    price: "0.33",
    shares: "10",
    feeAmount: "0.043",
    atEventIngestSeq: "8",
  });
  const record = provenanceFor(marks.entryRecord, { evaluationSeq, intentId }, order);
  return withRecords(
    {
      ...artifact,
      decisions: [...artifact.decisions, decision],
      traces: [...artifact.traces, traceOf(record, fill)],
      orders: [...artifact.orders, order],
      fills: [...artifact.fills, fill],
    },
    record,
  );
}

/**
 * The strategy's own `SB.REARMED` (`BRACKET-1b`): a `hold` at `evaluationSeq`,
 * anchored where the golden's `onMarketClosing` decision is — its LAST recorded
 * event, ingest sequence 8 — after bracket 1's close at `evaluationSeq 9`, and
 * before a second entry placed at `evaluationSeq` 18 by {@link withSecondEntry}.
 * (Anchored at the second entry's own source event instead — event 5, which
 * {@link withSecondEntry} copies from the first — the boundary would precede
 * bracket 1's fills, and is refused: `two-brackets.test.ts` pins that refusal.)
 */
function rearmDecision(artifact: PaperRunArtifact, evaluationSeq: number): ArtifactDecision {
  const closing = only(
    artifact.decisions.filter((decision) => decision.callback === "onMarketClosing"),
    "onMarketClosing decision",
  );
  return {
    ...closing,
    evaluationSeq,
    callback: "onFeatures",
    decisionType: "hold",
    reasonCodes: ["SB.REARMED"],
    modelOutputs: {},
    intents: [],
  };
}

/** `artifact` with {@link rearmDecision} at `evaluationSeq` 17. */
function withRearm(artifact: PaperRunArtifact): PaperRunArtifact {
  return { ...artifact, decisions: [...artifact.decisions, rearmDecision(artifact, 17)] };
}

/**
 * {@link withSecondEntry}'s FILLED chain with its decision's projections made
 * CONSISTENT with its own fill (10 shares at 0.33), so that as bracket 2 its rows
 * are explained on their merits: `trigger 0.33`, `entryCost 3.3`, `worstPrice
 * 0.33`, and the strategy's formula `0.5 × 10 − 3.3 − (0.001 + 0.001) × 10 =
 * 1.68` as the intent's `expectedNetEdge`.
 */
function consistentSecondEntry(artifact: PaperRunArtifact): PaperRunArtifact {
  return {
    ...artifact,
    decisions: artifact.decisions.map((decision) =>
      decision.evaluationSeq === 18 && decision.decisionType === "enter"
        ? {
            ...decision,
            modelOutputs: {
              trigger: "0.33",
              entryCost: "3.3",
              worstPrice: "0.33",
              expectedNetEdge: "1.68",
            },
            intents: decision.intents.map((intent) => ({ ...intent, expectedNetEdge: "1.68" })),
          }
        : decision,
    ),
  };
}

/**
 * {@link withSecondEntry}'s FILLED chain BOOKED in the instance's §9.16 stream
 * (`BRACKET-1b` r1, BR1B-M2), the way `packages/ledger` books every fill: its
 * chain names a principal, a token-movement and a fee transaction — copies of
 * the golden's first chain's three, re-keyed and booked for this fill's ledger
 * fill — and the stream gains a BUY TRADE record following from the token
 * movement, plus its FEE record. The per-bracket realized rows refuse a fill
 * the stream books by no TRADE record; this is the booking they require. The
 * ledger PROJECTION and the PnL snapshots are NOT refolded, so the
 * run-cumulative rows still disagree with the synthetic chain, as they should.
 */
function bookedSecondEntry(artifact: PaperRunArtifact): PaperRunArtifact {
  const synthetic = artifact.traces.find(
    (trace) => trace.intentId === `sb-entry-3-${artifact.scenario.marketId}`,
  );
  const fill = artifact.fills.find(
    (candidate) => candidate.simulatedFillId === synthetic?.venueFillId,
  );
  const template = artifact.traces[0];
  if (synthetic === undefined || fill === undefined || template === undefined) {
    throw new Error("the synthetic second entry's chain is missing");
  }
  const ids = ["principal", "token", "fee"].map((kind) => `${synthetic.executionPlanId}-${kind}`);
  const [, tokenId, feeId] = ids;
  const transactions = template.ledgerTransactionIds.map((id, index) => ({
    ...only(
      artifact.ledgerTransactions.filter((entry) => entry.ledgerTransactionId === id),
      `ledger transaction ${id}`,
    ),
    sequence: artifact.ledgerTransactions.length + index,
    ledgerTransactionId: ids[index] ?? "",
    fillId: synthetic.ledgerFillId,
  }));
  const [trade, fee] = artifact.pnlRecords;
  if (
    tokenId === undefined ||
    feeId === undefined ||
    trade?.kind !== "TRADE" ||
    trade.side !== "BUY" ||
    fee?.kind !== "FEE" ||
    transactions.map((entry) => entry.eventType).join() !==
      "TRADE_PRINCIPAL,OUTCOME_TOKEN_RECEIPT,PLATFORM_FEE"
  ) {
    throw new Error("the golden's first booking is not a purchase's TRADE and FEE");
  }
  return {
    ...artifact,
    traces: artifact.traces.map((trace) =>
      trace === synthetic ? { ...trace, ledgerTransactionIds: ids } : trace,
    ),
    ledgerTransactions: [...artifact.ledgerTransactions, ...transactions],
    pnlRecords: [
      ...artifact.pnlRecords,
      { ...trade, ref: tokenId, shares: fill.shares, price: fill.price },
      { ...fee, ref: feeId, amount: fill.feeAmount },
    ],
  };
}

// =============================================================================

describe("RECON-1 / RECON-2 — the golden's own attribution, positively and by id", () => {
  it("every golden fill is reached by exactly one chain, and the table is unchanged", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // Two entry fills, one exit fill, and no third kind: the partition the
    // reconciler now PROVES rather than assumes.
    expect(marks.entryFills).toHaveLength(2);
    expect(artifact.fills).toHaveLength(3);
    expect(buildReconciliation(artifact)).toEqual(artifact.reconciliation);
  });

  /**
   * `RECON-2`: the section the attribution now reads. One record per booked
   * order — including the withdrawn take-profit, which no trace names — and a
   * filled order's record is exactly its traces' shared prefix.
   */
  it("every booked order has exactly ONE provenance record, and every trace is its order's record completed", () => {
    const artifact = golden();
    expect(artifact.orderProvenance.map((record) => record.venueOrderId)).toEqual(
      artifact.orders.map((order) => order.simulatedOrderId),
    );
    const fillSide = new Set(["venueFillId", "ledgerFillId", "ledgerTransactionIds"]);
    for (const trace of artifact.traces) {
      const prefix = Object.fromEntries(
        Object.entries(trace).filter(([key]) => !fillSide.has(key)),
      );
      expect(prefix).toEqual(recordOf(artifact, trace.venueOrderId));
    }
    // The record the closed-world rule never had: the unfilled order's own.
    const marks = landmarks(artifact);
    expect(artifact.traces.map((trace) => trace.venueOrderId)).not.toContain(
      marks.takeProfit.simulatedOrderId,
    );
    expect(marks.takeProfitRecord.executionPlanId).toBe(marks.takeProfit.executionPlanId);
  });

  /**
   * CONVERTED (`RECON-2`). `RECON-1` reached the take-profit by the
   * closed-world rule — "the only order-placing intent no trace names is the
   * take-profit the `exit` decision emitted". It is now reached BY ID: its
   * provenance record names the `exit` decision's evaluation and the
   * take-profit's intent, and the row names it from that record.
   */
  it("the withdrawn take-profit is the ONLY exit cancellation, and its record names the exit decision", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const rows = buildReconciliation(artifact);
    const cancelled = rows.filter((entry) => entry.id.startsWith("exit.cancelled_proceeds."));
    expect(cancelled.map((entry) => entry.id)).toEqual([
      `exit.cancelled_proceeds.${marks.takeProfit.simulatedOrderId}`,
    ]);
    // It has no trace — the loop traces FILLS — so only its record names it.
    expect(
      artifact.traces.some((trace) => trace.executionPlanId === marks.takeProfit.executionPlanId),
    ).toBe(false);
    const takeProfitIntent = only(marks.exitDecision.intents, "take-profit intent");
    expect(takeProfitIntent.type).toBe("POSITION");
    expect(marks.takeProfitRecord.runId).toBe(marks.exitDecision.runId);
    expect(marks.takeProfitRecord.evaluationSeq).toBe(marks.exitDecision.evaluationSeq);
    expect(marks.takeProfitRecord.intentId).toBe(takeProfitIntent.intentId);
    // `RECON1-TEXT`: the row names WHAT was withdrawn, from the record.
    const [withdrawn] = cancelled;
    expect(withdrawn?.quantity).toBe("the proceeds a withdrawn take-profit projected");
    expect(withdrawn?.contributions[0]?.note).toContain(
      `the take-profit the \`exit\` decision at evaluationSeq ${String(marks.exitDecision.evaluationSeq)} placed ` +
        `(intent ${takeProfitIntent.intentId ?? ""}), by its provenance record`,
    );
  });

  /**
   * CONVERTED (`RECON-2`) — the refusal's REASON changed. `RECON-1` refused
   * because nothing left in the document "could have placed" the order (`no
   * possible origin`). The order's record still names the take-profit emission;
   * the emission is gone, so the record resolves to nothing. The complement
   * would still have reported the row with its origin erased.
   */
  it("remove the take-profit's intent and its order is REFUSED: its record names an emission no decision made", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const decisions = artifact.decisions.map((decision) =>
      decision.evaluationSeq === marks.exitDecision.evaluationSeq
        ? { ...decision, intents: [] }
        : decision,
    );
    expect(() => buildReconciliation({ ...artifact, decisions })).toThrow(
      marks.takeProfit.simulatedOrderId,
    );
    expect(() => buildReconciliation({ ...artifact, decisions })).toThrow(
      /no persisted decision emitted that intent there/u,
    );
  });

  it("an exit fill is the exit's because a REDUCE decision emitted it, not because it is not the entry's", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // Re-type the decision that emitted the protective reduction. Its fill is
    // untouched — same order, same plan, same record and trace — but no exit or
    // reduce decision now owns the emission the record names.
    const decisions = artifact.decisions.map((decision) =>
      decision.evaluationSeq === marks.reduce.evaluationSeq
        ? { ...decision, decisionType: "hold" }
        : decision,
    );
    expect(() => buildReconciliation({ ...artifact, decisions })).toThrow(
      marks.exitFill.simulatedFillId,
    );
    expect(() => buildReconciliation({ ...artifact, decisions })).toThrow(
      /belongs to neither the entry's chain nor any exit's: its order's provenance resolves to/u,
    );
  });
});

describe("RISK2-R3 — a fill in neither chain is refused, by name (R3a)", () => {
  const shapes: readonly {
    readonly name: string;
    readonly refusal: RegExp;
    readonly build: (artifact: PaperRunArtifact) => {
      readonly tampered: PaperRunArtifact;
      readonly fill: ArtifactFill;
    };
  }[] = [
    {
      // CONVERTED (`RECON-2`): `RECON-1` refused this fill because no TRACE
      // named its order's plan. The order now has no provenance RECORD either,
      // and that is the first thing refused — with the fill named.
      name: "a fill on an order with no provenance record and no trace",
      refusal: /has no provenance record/u,
      build: (artifact) => {
        const marks = landmarks(artifact);
        const order = orderUnder(marks.exitOrder, planId("fb000"), {
          requestedShares: "10",
          filledShares: "10",
          limitPrice: "0.4",
          atEventIngestSeq: "7",
        });
        const fill = fillOf(marks.exitFill, order, {
          price: "0.4",
          shares: "10",
          feeAmount: "0.047",
        });
        return {
          tampered: {
            ...artifact,
            orders: [...artifact.orders, order],
            fills: [...artifact.fills, fill],
          },
          fill,
        };
      },
    },
    {
      name: "a fill naming an order the venue never booked",
      refusal: /belongs to neither the entry's chain nor any exit's: the venue never booked/u,
      build: (artifact) => {
        const marks = landmarks(artifact);
        const order = orderUnder(marks.exitOrder, planId("fb000"), {});
        const fill = fillOf(marks.exitFill, order, { shares: "10", feeAmount: "0.042" });
        return { tampered: { ...artifact, fills: [...artifact.fills, fill] }, fill };
      },
    },
    {
      name: "a fill whose order's record names an intent neither the entry nor an exit emitted (a QUOTE)",
      refusal: /belongs to neither the entry's chain nor any exit's: its order's provenance resolves to QUOTE/u,
      build: (artifact) => {
        const marks = landmarks(artifact);
        const quoteIntentId = `quote-4-${artifact.scenario.marketId}`;
        const order = orderUnder(marks.exitOrder, planId("fb000"), {
          requestedShares: "10",
          filledShares: "10",
          limitPrice: "0.4",
        });
        const fill = fillOf(marks.exitFill, order, {
          price: "0.4",
          shares: "10",
          feeAmount: "0.047",
        });
        const record = provenanceFor(
          marks.entryRecord,
          { evaluationSeq: 18, intentId: quoteIntentId },
          order,
        );
        return {
          tampered: withRecords(
            {
              ...artifact,
              decisions: [...artifact.decisions, quoteDecision(artifact, marks, 18, quoteIntentId)],
              traces: [...artifact.traces, traceOf(record, fill)],
              orders: [...artifact.orders, order],
              fills: [...artifact.fills, fill],
            },
            record,
          ),
          fill,
        };
      },
    },
  ];

  for (const shape of shapes) {
    it(`${shape.name}: the table is refused and the refusal names the fill`, () => {
      const { tampered, fill } = shape.build(golden());
      // Non-vacuous: the fill is not the entry's by any chain, so the base
      // reconciler's complement summed it into `exitProceeds` without a word.
      const marks = landmarks(tampered);
      expect(fill.simulatedOrderId).not.toBe(marks.entryOrder.simulatedOrderId);
      expect(fill.simulatedOrderId).not.toBe(marks.exitOrder.simulatedOrderId);
      expect(() => buildReconciliation(tampered)).toThrow(fill.simulatedFillId);
      expect(() => buildReconciliation(tampered)).toThrow(shape.refusal);
    });
  }
});

describe("RISK2-R3 — more than one entry is refused, not read as the first (R3b)", () => {
  /**
   * CONVERTED (`BRACKET-1b`) into the PER-BRACKET rule. `RECON-1` refused a
   * second `enter` outright: the table had ONE bracket's shape. Brackets are
   * now read from the run — split at the strategy's own `SB.REARMED`, each
   * boundary after a close and at a flat position — so the same second chain is
   * still REFUSED when nothing separates it from the first (two entries in one
   * bracket: reading the first would still be silent), and is reconciled as
   * BRACKET 2 once the strategy's own re-arm does. Refusal and acceptance are
   * pinned on one synthetic, so neither can pass vacuously.
   */
  it("a second `enter` with its own filled chain: refused in ONE bracket, reconciled as bracket 2 after an SB.REARMED", () => {
    const tampered = withSecondEntry(golden(), "FILLED");
    // Non-vacuous: the second entry is a complete chain of its own — decision,
    // intent, record, trace, plan, order, fill — which the base reconciler
    // ignored as an entry and summed, BUY and all, into exit proceeds.
    expect(tampered.decisions.filter((decision) => decision.decisionType === "enter")).toHaveLength(2);
    expect(tampered.fills).toHaveLength(4);
    expect(tampered.orderProvenance).toHaveLength(4);
    expect(() => buildReconciliation(tampered)).toThrow(
      /the run's only bracket \(the run holds no `SB\.REARMED`\) holds 2 `enter` decisions/u,
    );
    expect(() => buildReconciliation(tampered)).toThrow(/evaluationSeq 1, 18/u);
    expect(() => buildReconciliation(tampered)).toThrow(/with no `SB\.REARMED` between them/u);
    expect(() => buildReconciliation(tampered)).toThrow(/instead of reading only the first/u);

    // The SAME chain, after the strategy's own re-arm (and a close, and a flat
    // position — bracket 1 sold its 50): two brackets. As `withSecondEntry`
    // builds it, the stream books no TRADE record for its fill, and since
    // `BRACKET-1b` r1 (BR1B-M2) a per-bracket realized row refuses a fill the
    // stream does not book — before r1 both of that row's sides read 0 and it
    // passed. Booked the way `packages/ledger` books a fill, it reconciles.
    const separated = withRearm(consistentSecondEntry(tampered));
    expect(() => buildReconciliation(separated)).toThrow(
      /fill 9280f970-9280-7000-8000-0000000fa000:g0:o0\/t0\/0 \(bracket 2\) is booked by no §9\.16 TRADE record/u,
    );
    const rows = buildReconciliation(bookedSecondEntry(separated));
    // Bracket 1 IS the golden's bracket, row for row, under its qualified id.
    const perBracket = golden().reconciliation.filter(
      (entry) => !entry.id.startsWith("ledger.") && !entry.id.startsWith("pnl."),
    );
    expect(perBracket).toHaveLength(12);
    for (const entry of perBracket) {
      expect(row(rows, `bracket.1.${entry.id}`)).toEqual({ ...entry, id: `bracket.1.${entry.id}` });
    }
    // Bracket 2 is the second entry's own, and explained on its merits — its 10
    // shares still open at run end.
    const second = rows.filter((entry) => entry.id.startsWith("bracket.2."));
    expect(second.map((entry) => entry.id.replace(/fee\.fill\..*$/u, "fee.fill.<its fill>"))).toEqual([
      "bracket.2.entry.executable_price_notional",
      "bracket.2.entry.projected_cost",
      "bracket.2.entry.shares",
      "bracket.2.entry.worst_price",
      "bracket.2.entry.cost_cap",
      "bracket.2.entry.expected_net_edge_formula",
      "bracket.2.fee.fill.<its fill>",
      "bracket.2.fee.total_model_vs_venue",
      "bracket.2.exit.expected_net_edge",
      "bracket.2.pnl.realized",
    ]);
    expect(unexplainedRows(second)).toEqual([]);
    expect(row(rows, "bracket.2.entry.shares").realized).toBe("10");
    expect(
      row(rows, "bracket.2.exit.expected_net_edge").contributions.map((entry) => entry.mechanism),
    ).toContain("POSITION_OPEN_AT_RUN_END");
    // Its realized row agrees on the POSITION too: 10 shares at 3.3 held by both
    // folds, none realized.
    expect(row(rows, "bracket.2.pnl.realized")).toMatchObject({
      projected: "0",
      realized: "0",
      unexplainedReasons: [],
    });
    // The run-cumulative rows are NOT explained, and must not be: the synthetic
    // chain was never folded into the ledger projection or a PnL snapshot, and
    // the table says so instead of absorbing it.
    expect(row(rows, "ledger.virtual_token_balance").explained).toBe(false);
    expect(row(rows, "ledger.virtual_token_balance").projected).toBe("10");
  });

  it("an entry decision that emits TWO order-placing intents is refused the same way", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const decisions = artifact.decisions.map((decision) =>
      decision.evaluationSeq === marks.enter.evaluationSeq
        ? {
            ...decision,
            intents: [
              ...decision.intents,
              { ...marks.entryIntent, intentId: `sb-entry-9-${artifact.scenario.marketId}` },
            ],
          }
        : decision,
    );
    expect(() => buildReconciliation({ ...artifact, decisions })).toThrow(
      /emitted 2 order-placing intents/u,
    );
  });
});

describe("RISK2-R3 — an entry order withdrawn unfilled is not an exit cancellation (R3c)", () => {
  /**
   * CONVERTED (`BRACKET-1b`) into the per-bracket rule. The property is
   * unchanged — a withdrawn ENTRY is never reported as a withdrawn exit — and
   * now holds both ways the second entry can stand: in the first bracket it is
   * a second `enter` there, refused; after the strategy's own `SB.REARMED` it is
   * bracket 2's entry, which never filled, and a bracket with no entry fill has
   * nothing to reconcile, so it is refused by name — never listed under
   * `exit.cancelled_proceeds`.
   */
  it("a second bracket's entry, rested and withdrawn: refused, never a withdrawn take-profit — in one bracket or after an SB.REARMED", () => {
    const artifact = golden();
    const tampered = withSecondEntry(artifact, "WITHDRAWN_UNFILLED");
    const withdrawn = tampered.orders.at(-1);
    if (withdrawn === undefined) throw new Error("the synthetic order is missing");
    // Non-vacuous: CANCELLED, nothing filled, and not under the first entry's
    // plan — exactly the three things the base reconciler's complement checked
    // before it reported `exit.cancelled_proceeds.<this entry order>`.
    expect(withdrawn.state).toBe("CANCELLED");
    expect(compareDecimal(withdrawn.filledShares, "0")).toBe(0);
    expect(withdrawn.executionPlanId).not.toBe(landmarks(artifact).entryOrder.executionPlanId);
    expect(() => buildReconciliation(tampered)).toThrow(/2 `enter` decisions/u);
    expect(() => buildReconciliation(tampered)).toThrow(/with no `SB\.REARMED` between them/u);
    const separated = withRearm(tampered);
    expect(() => buildReconciliation(separated)).toThrow(
      /bracket 2 \(opened by the `SB\.REARMED` decision at evaluationSeq 17\): no fill could be attributed to the entry intent/u,
    );
  });

  /**
   * CONVERTED (`RECON-2`) — the refusal's REASON changed. `RECON-1`: "no
   * untraced intent could have placed" an extra BUY, because the only
   * untraced order-placing emission (the take-profit) could not have minted a
   * second plan (`no possible origin`). Now: the order has no provenance record,
   * so nothing names its origin. And a FABRICATED record that borrows the
   * take-profit's emission — the emission a real plan already holds — is
   * refused by the one-plan-per-emission cross-check the matcher left behind.
   */
  it("an unfilled order with no provenance record is refused, and a record borrowing a held emission is too", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const order = orderUnder(marks.entryOrder, planId("fc000"), {
      requestedShares: "10",
      filledShares: "0",
      state: "CANCELLED",
      limitPrice: "0.33",
    });
    const tampered = { ...artifact, orders: [...artifact.orders, order] };
    expect(() => buildReconciliation(tampered)).toThrow(order.simulatedOrderId);
    expect(() => buildReconciliation(tampered)).toThrow(/has no provenance record/u);

    const borrowed = withRecords(
      tampered,
      provenanceFor(
        marks.takeProfitRecord,
        {
          evaluationSeq: marks.takeProfitRecord.evaluationSeq,
          intentId: marks.takeProfitRecord.intentId,
        },
        order,
      ),
    );
    expect(() => buildReconciliation(borrowed)).toThrow(/is claimed by two plans/u);
    expect(() => buildReconciliation(borrowed)).toThrow(marks.takeProfit.executionPlanId);
  });

  /**
   * CONVERTED (`RECON-2`) — the property INVERTED, by design. `RECON-1` could
   * only DEDUCE an unfilled order's side, so the take-profit's attribution was
   * withdrawn the moment any non-exit intent (a QUOTE) could also have placed
   * it (`not an exit`). With the record, an unrelated QUOTE emission cannot
   * cloud it: the table is the golden's. What the rule must still refuse is a
   * record that NAMES the QUOTE.
   */
  it("a QUOTE emission beside the take-profit no longer clouds it; a record naming the QUOTE is refused", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const quoteIntentId = `quote-4-${artifact.scenario.marketId}`;
    const withQuote = {
      ...artifact,
      decisions: [...artifact.decisions, quoteDecision(artifact, marks, 18, quoteIntentId)],
    };
    expect(buildReconciliation(withQuote)).toEqual(artifact.reconciliation);

    const namingQuote = withRecordChanged(withQuote, marks.takeProfit.simulatedOrderId, {
      evaluationSeq: 18,
      intentId: quoteIntentId,
    });
    expect(() => buildReconciliation(namingQuote)).toThrow(marks.takeProfit.simulatedOrderId);
    expect(() => buildReconciliation(namingQuote)).toThrow(
      /neither the entry intent nor one an exit or reduce decision emitted/u,
    );
  });

  it("an entry order withdrawn beside a filled sibling stays the ENTRY's: no exit row, no refusal", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // Under the entry's OWN plan, and its record names the entry's emission.
    const sibling: ArtifactOrder = {
      ...marks.entryOrder,
      simulatedOrderId: `${marks.entryOrder.executionPlanId}:g1:o0`,
      plannedOrderId: `${marks.entryOrder.executionPlanId}:g1:o0`,
      requestedShares: "10",
      filledShares: "0",
      state: "CANCELLED",
    };
    const withSibling = { ...artifact, orders: [...artifact.orders, sibling] };
    const rows = buildReconciliation(
      withRecords(withSibling, { ...marks.entryRecord, venueOrderId: sibling.simulatedOrderId }),
    );
    expect(rows.map((entry) => entry.id)).not.toContain(
      `exit.cancelled_proceeds.${sibling.simulatedOrderId}`,
    );
    // …and the rest of the table is the golden's.
    expect(rows).toEqual(artifact.reconciliation);
    // `RECON-2`: without its record the sibling is not attributed at all —
    // sharing a plan with a traced order no longer stands in for a record.
    expect(() => buildReconciliation(withSibling)).toThrow(/has no provenance record/u);
  });
});

describe("RECON-1 / RECON-2 — emissions resolve by KEY, and every broken chain is refused", () => {
  /**
   * CONVERTED (`RECON-2`). §9.8 check 18's duplicate guard remembers only the
   * last 256 intent ids, so an id can be emitted — and planned — twice in a
   * long run. `RECON-1` counted each untraced EMISSION as a possible origin.
   * The record now NAMES the emission by `(runId, evaluationSeq, intentId)`, so
   * the second emission of the id places the second order and the first keeps
   * its own; a record naming the FIRST emission for the second order is
   * refused, because that emission's plan already exists.
   */
  it("an exit id re-emitted by a later reduce decision: the record's KEY decides which emission placed the order", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const order = orderUnder(marks.exitOrder, planId("fd000"), {
      requestedShares: "50",
      filledShares: "0",
      state: "CANCELLED",
    });
    const reduceIntentId = marks.exitRecord.intentId;
    const reEmitted = {
      ...artifact,
      decisions: [...artifact.decisions, reemitted(marks.reduce, 18)],
      orders: [...artifact.orders, order],
    };
    const rows = buildReconciliation(
      withRecords(
        reEmitted,
        provenanceFor(marks.exitRecord, { evaluationSeq: 18, intentId: reduceIntentId }, order),
      ),
    );
    expect(rows.map((entry) => entry.id).filter((id) => id.startsWith("exit.cancelled_proceeds."))).toEqual([
      `exit.cancelled_proceeds.${marks.takeProfit.simulatedOrderId}`,
      `exit.cancelled_proceeds.${order.simulatedOrderId}`,
    ]);
    // `RECON1-TEXT`: a withdrawn PROTECTIVE REDUCTION is named as one.
    const withdrawn = row(rows, `exit.cancelled_proceeds.${order.simulatedOrderId}`);
    expect(withdrawn.quantity).toBe("the proceeds a withdrawn protective reduction projected");
    expect(withdrawn.contributions[0]?.note).toContain("the `reduce` decision at evaluationSeq 18");

    const namingTheFirst = withRecords(
      reEmitted,
      provenanceFor(
        marks.exitRecord,
        { evaluationSeq: marks.reduce.evaluationSeq, intentId: reduceIntentId },
        order,
      ),
    );
    expect(() => buildReconciliation(namingTheFirst)).toThrow(/is claimed by two plans/u);
  });

  /**
   * `RECON-1` r2 RELAXED one refusal, deliberately. The first commit refused an
   * artefact in which the entry's `intentId` also appeared in an exit or reduce
   * decision, because it classified traces by id and the fills would have
   * counted twice. Emissions resolve by KEY, so the entry's fills stay the
   * entry's — its record names the enter decision's evaluation — and the second
   * emission of the id placed nothing.
   */
  it("the entry's intent id re-emitted by a reduce decision leaves the entry's fills the entry's", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const decisions = artifact.decisions.map((decision) =>
      decision.evaluationSeq === marks.reduce.evaluationSeq
        ? { ...decision, intents: [...decision.intents, marks.entryIntent] }
        : decision,
    );
    expect(buildReconciliation({ ...artifact, decisions })).toEqual(artifact.reconciliation);
  });

  const broken: readonly {
    readonly name: string;
    readonly refusal: RegExp;
    readonly tamper: (artifact: PaperRunArtifact, marks: Landmarks) => PaperRunArtifact;
  }[] = [
    {
      // CONVERTED (`RECON-2`): was "one plan traced to two intents"
      // (`is traced to two intents`). A trace is its order's record completed,
      // so a trace naming another intent now contradicts the record.
      name: "a trace naming another intent than its order's provenance record",
      refusal: /disagrees with order .+'s provenance record on intentId/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        traces: [...artifact.traces, { ...marks.entryTrace, intentId: marks.exitRecord.intentId }],
      }),
    },
    {
      name: "a filled order whose record names an emission that is a CANCEL, which places no order",
      refusal: /belongs to neither the entry's chain nor any exit's/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        decisions: artifact.decisions.map((decision) =>
          decision.evaluationSeq === marks.reduce.evaluationSeq
            ? {
                ...decision,
                intents: decision.intents.map((intent) => ({ ...intent, type: "CANCEL" })),
              }
            : decision,
        ),
      }),
    },
    {
      // `RECON-2`: the same rule for an UNFILLED order, which only its record
      // links to an emission — the withdrawn take-profit, its intent re-typed.
      name: "an unfilled order whose record names an emission that is a CANCEL",
      refusal: /placed under CANCEL .+ — neither the entry intent nor one an exit or reduce decision emitted/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        decisions: artifact.decisions.map((decision) =>
          decision.evaluationSeq === marks.exitDecision.evaluationSeq
            ? {
                ...decision,
                intents: decision.intents.map((intent) => ({ ...intent, type: "CANCEL" })),
              }
            : decision,
        ),
      }),
    },
    {
      name: "one decision emitting the same intent id twice",
      refusal: /emits intent .+ twice; one emission identity may name one intent/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        decisions: artifact.decisions.map((decision) =>
          decision.evaluationSeq === marks.exitDecision.evaluationSeq
            ? { ...decision, intents: [...decision.intents, ...decision.intents] }
            : decision,
        ),
      }),
    },
    {
      // CONVERTED (`RECON-2`): was `is reached from the entry's chain AND from
      // an exit's`. The book is checked against itself first now: one order id
      // booked twice cannot be matched to one record.
      name: "one order id booked under the entry's plan and under an exit's",
      refusal: /is booked twice/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        orders: [
          ...artifact.orders,
          { ...marks.exitOrder, simulatedOrderId: marks.entryOrder.simulatedOrderId },
        ],
      }),
    },
    {
      name: "an entry intent with no id",
      refusal: /carries no intentId/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        decisions: artifact.decisions.map((decision) =>
          decision.evaluationSeq === marks.enter.evaluationSeq
            ? {
                ...decision,
                intents: decision.intents.map(
                  (intent) =>
                    Object.fromEntries(
                      Object.entries(intent).filter(([key]) => key !== "intentId"),
                    ) as unknown as ArtifactIntent,
                ),
              }
            : decision,
        ),
      }),
    },
    {
      // CONVERTED (`RECON-2`): was `…no trace names its plan`, reached through
      // the closed-world rule. The order is given a VALID record — a distinct
      // reduce emission — so the refusal is the traced-fill rule itself.
      name: "an order that reports filled shares while no trace names it",
      refusal: /reports 10 filled shares, but no trace names it/u,
      tamper: (artifact, marks) => {
        const order = orderUnder(marks.exitOrder, planId("fe000"), {
          requestedShares: "10",
          filledShares: "10",
        });
        return withRecords(
          {
            ...artifact,
            decisions: [...artifact.decisions, reemitted(marks.reduce, 18)],
            orders: [...artifact.orders, order],
          },
          provenanceFor(marks.exitRecord, { evaluationSeq: 18, intentId: marks.exitRecord.intentId }, order),
        );
      },
    },
    {
      name: "an unfilled order whose record names a QUOTE",
      refusal: /neither the entry intent nor one an exit or reduce decision emitted/u,
      tamper: (artifact, marks) => {
        const quoteIntentId = `quote-4-${artifact.scenario.marketId}`;
        const order = orderUnder(marks.exitOrder, planId("fe000"), {
          requestedShares: "10",
          filledShares: "0",
          state: "CANCELLED",
        });
        return withRecords(
          {
            ...artifact,
            decisions: [...artifact.decisions, quoteDecision(artifact, marks, 18, quoteIntentId)],
            orders: [...artifact.orders, order],
          },
          provenanceFor(marks.entryRecord, { evaluationSeq: 18, intentId: quoteIntentId }, order),
        );
      },
    },
    // --- `RECON-2`: the provenance section itself ---------------------------
    {
      name: "two provenance records for one order",
      refusal: /has two provenance records/u,
      tamper: (artifact, marks) => withRecords(artifact, marks.takeProfitRecord),
    },
    {
      name: "a provenance record for an order the venue never booked (an orphan)",
      refusal: /which the venue never booked/u,
      tamper: (artifact, marks) =>
        withRecords(artifact, { ...marks.takeProfitRecord, venueOrderId: "no-such-order:g0:o0" }),
    },
    {
      name: "a record whose plan is not the booked order's plan",
      refusal: /but its provenance record says plan/u,
      tamper: (artifact, marks) =>
        withRecordChanged(artifact, marks.takeProfit.simulatedOrderId, {
          executionPlanId: planId("ff000"),
        }),
    },
    {
      name: "one plan whose orders' records name two emissions",
      refusal: /names two emissions/u,
      tamper: (artifact, marks) => {
        // A second order under the ENTRY's plan whose record names the
        // take-profit's emission: one plan, two origins.
        const sibling: ArtifactOrder = {
          ...marks.entryOrder,
          simulatedOrderId: `${marks.entryOrder.executionPlanId}:g1:o0`,
          plannedOrderId: `${marks.entryOrder.executionPlanId}:g1:o0`,
          filledShares: "0",
          state: "CANCELLED",
        };
        return withRecords(
          { ...artifact, orders: [...artifact.orders, sibling] },
          {
            ...marks.entryRecord,
            evaluationSeq: marks.takeProfitRecord.evaluationSeq,
            intentId: marks.takeProfitRecord.intentId,
            venueOrderId: sibling.simulatedOrderId,
          },
        );
      },
    },
    {
      name: "a trace naming an order that has no provenance record",
      refusal: /which has no provenance\s+record; a trace is its order's submission-time record/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        traces: [...artifact.traces, { ...marks.exitTrace, venueOrderId: "no-such-order:g0:o0" }],
      }),
    },
    {
      name: "a format-1 artefact, with no provenance section at all",
      refusal: /carries no orderProvenance section/u,
      tamper: (artifact) =>
        Object.fromEntries(
          Object.entries(artifact).filter(([key]) => key !== "orderProvenance"),
        ) as unknown as PaperRunArtifact,
    },
  ];

  for (const probe of broken) {
    it(`${probe.name}: refused`, () => {
      const artifact = golden();
      const tampered = probe.tamper(artifact, landmarks(artifact));
      expect(() => buildReconciliation(tampered)).toThrow(probe.refusal);
    });
  }
});

/**
 * `RECON-2` — the two refusals `RECON1-ORIGIN` asked for, over every order and
 * every shared field.
 */
describe("RECON-2 — an order without a record, or a record a trace contradicts, is refused", () => {
  it("deleting ANY order's record refuses the table, naming that order — filled or not", () => {
    const artifact = golden();
    // Three orders: two filled (entry, protective reduction), one not (the
    // withdrawn take-profit, which only its record ever named).
    expect(artifact.orders).toHaveLength(3);
    for (const order of artifact.orders) {
      const tampered = withoutRecordOf(artifact, order.simulatedOrderId);
      expect(() => buildReconciliation(tampered), order.simulatedOrderId).toThrow(
        `order ${order.simulatedOrderId}`,
      );
      expect(() => buildReconciliation(tampered), order.simulatedOrderId).toThrow(
        /has no provenance record/u,
      );
    }
  });

  /**
   * The loop builds a trace FROM the record — `{ ...prefix, venueFillId, … }`
   * (`apps/trader/src/loop.ts` `#harvestFills`) — so the two share eight fields
   * that can disagree (the ninth, `venueOrderId`, is how the record is found;
   * the probe above for a trace naming an order with no record covers it, and
   * a trace naming ANOTHER booked order than its own fill's is `RECON2-R1`'s,
   * pinned in the next block).
   * Each field of the exit fill's trace is changed on its own, to a value that
   * leaves every other rule satisfied, and each is refused by name.
   */
  it("a fill's trace that disagrees with its order's record on ANY shared field is refused, by field", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const changes: readonly [keyof ArtifactOrderProvenance, string | number][] = [
      ["sourceEventId", "018f5c20-9000-7a90-8b00-000000000006"],
      ["featureSnapshotRef", "f".repeat(64)],
      ["runId", "018f5c20-3000-7a30-8b00-0000000000ff"],
      ["evaluationSeq", marks.enter.evaluationSeq],
      ["intentId", marks.entryRecord.intentId],
      ["approvedIntentId", "9280f970-9280-7000-8000-00000000a0a0"],
      ["executionPlanId", marks.entryRecord.executionPlanId],
      ["submissionAttemptId", "9280f970-9280-7000-8000-00000000b0b0"],
    ];
    expect(changes).toHaveLength(8);
    for (const [field, value] of changes) {
      const traces = artifact.traces.map((trace) =>
        trace.venueFillId === marks.exitFill.simulatedFillId ? { ...trace, [field]: value } : trace,
      );
      const tampered = { ...artifact, traces };
      expect(() => buildReconciliation(tampered), field).toThrow(
        new RegExp(`disagrees with order .+'s provenance record on ${field} \\(`, "u"),
      );
      expect(() => buildReconciliation(tampered), field).toThrow(marks.exitFill.simulatedFillId);
    }
  });

  it("a record naming a different emission than the fill's trace is refused, even when the record resolves", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // The exit order's RECORD is re-pointed at a distinct re-emission of the
    // reduce (evaluation 18), which resolves, is an exit, and holds no other
    // plan — every order-side rule passes. Only the fill's trace, which still
    // names evaluation 8, says the record is not the run's. (`TRDR-4`: the
    // reduce was evaluation 9 until R1 retired the terminal repeat deliveries
    // that preceded it; the golden's evaluationSeq renumbered 9 → 8.)
    const tampered = withRecordChanged(
      { ...artifact, decisions: [...artifact.decisions, reemitted(marks.reduce, 18)] },
      marks.exitOrder.simulatedOrderId,
      { evaluationSeq: 18 },
    );
    expect(() => buildReconciliation(tampered)).toThrow(
      /disagrees with order .+'s provenance record on evaluationSeq \(trace 8, provenance 18\)/u,
    );
  });
});

/**
 * Every trace in `artifact` names a booked order whose record it agrees with
 * field for field, and every order reporting filled shares is named by some
 * trace: the conditions the reconciler checked before `RECON2-R1`. A probe
 * that satisfies them shows its refusal is the fill-to-trace join's alone.
 */
function tracesAgreeWithTheirOrdersRecords(artifact: PaperRunArtifact): void {
  const fields = [
    "sourceEventId",
    "featureSnapshotRef",
    "runId",
    "evaluationSeq",
    "intentId",
    "approvedIntentId",
    "executionPlanId",
    "submissionAttemptId",
    "venueOrderId",
  ] as const satisfies readonly (keyof ArtifactOrderProvenance)[];
  for (const trace of artifact.traces) {
    const record = recordOf(artifact, trace.venueOrderId);
    for (const field of fields) expect(trace[field], field).toBe(record[field]);
  }
  const traced = new Set(artifact.traces.map((trace) => trace.venueOrderId));
  for (const order of artifact.orders) {
    if (compareDecimal(order.filledShares, "0") !== 0) {
      expect(traced.has(order.simulatedOrderId), order.simulatedOrderId).toBe(true);
    }
  }
}

/**
 * `RECON2-R1` (RECON-2 r1 review, MEDIUM): a trace names a fill AND an order,
 * and the reconciler selected the record by the trace's order without asking
 * whether the trace's FILL belongs to that order. The loop builds a trace by
 * looking the submission-time prefix up under the fill's OWN order id
 * (`#orderTraces.get(fill.simulatedOrderId)`), so the two cannot differ in a
 * run. Each probe below passes every pre-join check
 * ({@link tracesAgreeWithTheirOrdersRecords}), and was accepted by the r0
 * reconciler.
 */
describe("RECON2-R1 — a trace is bound to the fill whose id it carries", () => {
  /**
   * The review's reproduction 1: the first entry fill's trace and the exit
   * fill's trace SWAP their nine-field submission prefixes and keep their own
   * fill and ledger ids. Every trace then agrees with the record of the order
   * it names, and both filled orders still carry a trace. The r0 reconciler
   * returned the golden's table unchanged and fully explained; the chain walk
   * already reported the `fill` hop broken.
   */
  it("two traces that swap their orders' prefixes, keeping their own fill ids, are refused", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const entryFillId = marks.entryTrace.venueFillId;
    const exitFillId = marks.exitFill.simulatedFillId;
    const tampered: PaperRunArtifact = {
      ...artifact,
      traces: artifact.traces.map((trace) =>
        trace.venueFillId === entryFillId
          ? { ...trace, ...marks.exitRecord }
          : trace.venueFillId === exitFillId
            ? { ...trace, ...marks.entryRecord }
            : trace,
      ),
    };
    // Non-vacuous: both swapped traces still carry their own fill ids, and
    // every pre-join rule is satisfied.
    expect(tampered.traces.map((trace) => trace.venueFillId)).toEqual(
      artifact.traces.map((trace) => trace.venueFillId),
    );
    expect(
      tampered.traces.find((trace) => trace.venueFillId === entryFillId)?.venueOrderId,
    ).toBe(marks.exitOrder.simulatedOrderId);
    tracesAgreeWithTheirOrdersRecords(tampered);
    expect(walkChains(tampered).brokenHops).toEqual(["fill"]);

    expect(() => buildReconciliation(tampered)).toThrow(
      `the trace of fill ${entryFillId} names order ${marks.exitOrder.simulatedOrderId}, but ` +
        `fill ${entryFillId} belongs to order ${marks.entryOrder.simulatedOrderId}`,
    );
  });

  /**
   * The review's reproduction 2: the exit fill is re-pointed at the ENTRY
   * order while its trace still names the exit order. The r0 reconciler
   * counted the exit fill as an entry purchase (`entry.shares.realized` 100,
   * `exit.expected_net_edge.realized` −33.632) instead of refusing.
   */
  it("a fill re-pointed at another order, while its trace names the order that placed it, is refused", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const exitFillId = marks.exitFill.simulatedFillId;
    const tampered: PaperRunArtifact = {
      ...artifact,
      fills: artifact.fills.map((fill) =>
        fill.simulatedFillId === exitFillId
          ? { ...fill, simulatedOrderId: marks.entryOrder.simulatedOrderId }
          : fill,
      ),
    };
    // Non-vacuous: the traces are the golden's own, and the re-pointed fill
    // lands on a booked order whose record resolves to the entry.
    expect(tampered.traces).toEqual(artifact.traces);
    tracesAgreeWithTheirOrdersRecords(tampered);

    expect(() => buildReconciliation(tampered)).toThrow(
      `the trace of fill ${exitFillId} names order ${marks.exitOrder.simulatedOrderId}, but ` +
        `fill ${exitFillId} belongs to order ${marks.entryOrder.simulatedOrderId}`,
    );
  });

  it("a trace naming a fill the venue never produced is refused", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const ghost = `${marks.exitOrder.simulatedOrderId}/t0/9`;
    // A second trace of the exit order, its prefix the exit's own record, for a
    // fill no venue produced.
    const tampered: PaperRunArtifact = {
      ...artifact,
      traces: [
        ...artifact.traces,
        { ...marks.exitTrace, venueFillId: ghost, ledgerFillId: `${ghost}-ledger` },
      ],
    };
    expect(tampered.fills.some((fill) => fill.simulatedFillId === ghost)).toBe(false);
    tracesAgreeWithTheirOrdersRecords(tampered);

    expect(() => buildReconciliation(tampered)).toThrow(
      `the trace of fill ${ghost} (order ${marks.exitOrder.simulatedOrderId}) names a fill the ` +
        "venue never produced",
    );
  });

  it("a fill id carried by two fills, under two orders, is refused as ambiguous", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const exitFillId = marks.exitFill.simulatedFillId;
    // The exit fill, and a copy of it under the ENTRY order with the same id.
    const tampered: PaperRunArtifact = {
      ...artifact,
      fills: [
        ...artifact.fills,
        { ...marks.exitFill, simulatedOrderId: marks.entryOrder.simulatedOrderId },
      ],
    };
    // Non-vacuous: the exit trace's own fill is still there, under its order.
    tracesAgreeWithTheirOrdersRecords(tampered);
    expect(
      tampered.fills.filter(
        (fill) =>
          fill.simulatedFillId === exitFillId &&
          fill.simulatedOrderId === marks.exitOrder.simulatedOrderId,
      ),
    ).toHaveLength(1);

    expect(() => buildReconciliation(tampered)).toThrow(
      `fill id ${exitFillId}, which the trace of order ${marks.exitOrder.simulatedOrderId} ` +
        `names, is carried by 2 fills (orders ${marks.exitOrder.simulatedOrderId}, ` +
        `${marks.entryOrder.simulatedOrderId})`,
    );
  });
});

/**
 * `RECON-1` r2 — the independent review's reproductions, each of which the
 * first two commits mis-reconciled SILENTLY: an explained row, no throw. Each
 * is REBUILT against the format-2 artefact (`RECON-2`).
 */
describe("RECON-1 r2 — the review's silent mis-attributions are refused", () => {
  /**
   * Review R1, probe 1. An untraced BUY under a new plan was refused on its
   * own; appending an exact COPY of the golden's exit decision then made the
   * global candidate count reach two, and the phantom was reported as a second
   * withdrawn take-profit: projected 3.3, `explained: true`.
   *
   * `RECON-2`: the phantom alone is now refused because it has NO RECORD (was:
   * `no possible origin`). The copy is still refused as a duplicate decision
   * key. `RECON1-ORIGIN`'s own reproduction — a DISTINCT compatible exit
   * re-emission, which `RECON-1`'s matcher let absorb the phantom — is refused
   * for the same reason: an emission is no longer a candidate, only a record
   * names an origin. A record borrowing the take-profit's emission is refused
   * by one-plan-per-emission.
   */
  it("R1: a copied exit decision cannot stand in for a phantom order's origin", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const phantom: ArtifactOrder = {
      ...marks.entryOrder,
      simulatedOrderId: "review-phantom-entry:g0:o0",
      plannedOrderId: "review-phantom-entry:g0:o0",
      executionPlanId: "review-phantom-entry",
      requestedShares: "10",
      filledShares: "0",
      state: "CANCELLED",
      limitPrice: "0.33",
    };
    const withPhantom = { ...artifact, orders: [...artifact.orders, phantom] };
    expect(() => buildReconciliation(withPhantom)).toThrow(/has no provenance record/u);

    const copy = JSON.parse(JSON.stringify(marks.exitDecision)) as ArtifactDecision;
    const copied = { ...withPhantom, decisions: [...withPhantom.decisions, copy] };
    expect(() => buildReconciliation(copied)).toThrow(
      /two persisted decisions share \(runId, evaluationSeq\)/u,
    );

    // `RECON1-ORIGIN`: a distinct, compatible exit re-emission.
    const reEmission = {
      ...withPhantom,
      decisions: [...withPhantom.decisions, reemitted(marks.exitDecision, 18)],
    };
    expect(() => buildReconciliation(reEmission)).toThrow(phantom.simulatedOrderId);
    expect(() => buildReconciliation(reEmission)).toThrow(/has no provenance record/u);

    const borrowing = withRecords(
      withPhantom,
      provenanceFor(
        marks.takeProfitRecord,
        {
          evaluationSeq: marks.takeProfitRecord.evaluationSeq,
          intentId: marks.takeProfitRecord.intentId,
        },
        phantom,
      ),
    );
    expect(() => buildReconciliation(borrowing)).toThrow(/is claimed by two plans/u);
  });

  /**
   * THE BOUNDARY, stated rather than hidden. A document fabricated
   * CONSISTENTLY at every id — a new `exit` decision, and a record, plan and
   * order that all name it — is indistinguishable, by ids, from a run whose
   * strategy emitted a second take-profit, and it is attributed as exactly that.
   * What `RECON1-ORIGIN` closed is attribution WITHOUT a link: the matcher let
   * an emission absorb an order no id tied to it. Here the link is the loop's
   * own record, and the row names the decision it names. (Nor is an order's
   * action checked against its intent: the artefact carries no intent
   * `direction` — `RECON-1`'s compatibility boundary, unchanged.)
   */
  it("the boundary: an order, record and decision consistent at every id are attributed as the record says", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const phantom = orderUnder(marks.takeProfit, planId("fc000"), {
      requestedShares: "10",
      limitPrice: "0.33",
    });
    const rows = buildReconciliation(
      withRecords(
        {
          ...artifact,
          decisions: [...artifact.decisions, reemitted(marks.exitDecision, 18)],
          orders: [...artifact.orders, phantom],
        },
        provenanceFor(
          marks.takeProfitRecord,
          { evaluationSeq: 18, intentId: marks.takeProfitRecord.intentId },
          phantom,
        ),
      ),
    );
    const attributed = row(rows, `exit.cancelled_proceeds.${phantom.simulatedOrderId}`);
    expect(attributed.projected).toBe("3.3");
    expect(attributed.contributions[0]?.note).toContain("the `exit` decision at evaluationSeq 18");
  });

  /**
   * Review R1, probe 2, and its two neighbours. The withdrawn take-profit is
   * moved where the emission its record names — the take-profit, in the
   * scenario market — could not have placed it.
   *
   * `RECON-2`: still refused, now by the compatibility CROSS-CHECK on the
   * emission the record names (`could not have placed it`), not by a search
   * for a candidate that finds none.
   */
  const displaced: readonly {
    readonly name: string;
    readonly changes: Partial<ArtifactOrder>;
  }[] = [
    {
      name: "in another market, on another token (the review's probe: projected 17.5)",
      changes: {
        marketId: "018f5c20-1000-7a10-8b00-0000000000ff",
        tokenId: "9901",
        requestedShares: "50",
        limitPrice: "0.35",
      },
    },
    { name: "in the scenario market, on a token that is not one of its two", changes: { tokenId: "7777" } },
    { name: "on the YES token but labelled NO", changes: { side: "NO" } },
  ];
  for (const probe of displaced) {
    it(`R1: an order ${probe.name} contradicts the emission its record names`, () => {
      const artifact = golden();
      const marks = landmarks(artifact);
      const orders = artifact.orders.map((order) =>
        order.simulatedOrderId === marks.takeProfit.simulatedOrderId
          ? { ...order, ...probe.changes }
          : order,
      );
      expect(() => buildReconciliation({ ...artifact, orders })).toThrow(
        marks.takeProfit.simulatedOrderId,
      );
      expect(() => buildReconciliation({ ...artifact, orders })).toThrow(
        /which could not have placed it/u,
      );
    });
  }

  /**
   * Review R2. The filled emission at evaluation 8 becomes a QUOTE, a separate
   * `reduce` decision at evaluation 99 carries the SAME intent id, and the
   * fill's trace — and now its order's record — still name evaluation 8.
   * (Evaluation 9 before `TRDR-4`'s R1 renumbered the golden.)
   * Classified by id, the QUOTE's fill was accepted as an exit and a cancelled
   * sibling under the QUOTE's plan was reported as an explained exit
   * cancellation. `RECON-2`: the sibling carries the record the loop would
   * have written (the same emission as its plan), so the refusal is the
   * KEY's, not a missing record's.
   */
  it("R2: an order resolves by (runId, evaluationSeq, intentId), not by the id alone", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const reduceIntentId = only(marks.reduce.intents, "reduce intent").intentId ?? "";
    const decisions: ArtifactDecision[] = [
      ...artifact.decisions.map((decision) =>
        decision.evaluationSeq === marks.reduce.evaluationSeq
          ? {
              ...decision,
              decisionType: "quote",
              intents: [
                { type: "QUOTE", intentId: reduceIntentId, marketId: artifact.scenario.marketId },
              ],
            }
          : decision,
      ),
      reemitted(marks.reduce, 99),
    ];
    const sibling: ArtifactOrder = {
      ...marks.exitOrder,
      simulatedOrderId: `${marks.exitOrder.executionPlanId}:g1:o0`,
      plannedOrderId: `${marks.exitOrder.executionPlanId}:g1:o0`,
      requestedShares: "10",
      filledShares: "0",
      state: "CANCELLED",
    };
    const tampered = withRecords(
      { ...artifact, decisions, orders: [...artifact.orders, sibling] },
      { ...marks.exitRecord, venueOrderId: sibling.simulatedOrderId },
    );
    expect(() => buildReconciliation(tampered)).toThrow(marks.exitFill.simulatedFillId);
    expect(() => buildReconciliation(tampered)).toThrow(
      /belongs to neither the entry's chain nor any exit's/u,
    );
    // The review's second form: a later reduce emission that was REJECTED —
    // it produced no plan — and no sibling at all. Same refusal.
    const rejected = { ...artifact, decisions };
    expect(() => buildReconciliation(rejected)).toThrow(marks.exitFill.simulatedFillId);
  });

  /** Review R4. Validation ran inside the sort comparator, which one element never calls. */
  it("R4: a single fill's non-canonical sequence is refused, not folded", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const [lot] = marks.entryFills;
    if (lot === undefined) throw new Error("an entry lot expected");
    // `RECON2-R1`: the ONE fill keeps its own trace, and the fills it replaces
    // take theirs with them (the reduction withdrawn unfilled, the second entry
    // lot dropped). Before r1 this probe left three traces naming fills the
    // document no longer held, which the fill-to-trace join now refuses first;
    // the synthetic is made well formed so that the refusal is still the
    // sequence check's, reached through a fold with ONE element.
    const withdrawn = withReductionWithdrawn(artifact);
    const single = (atEventIngestSeq: string): PaperRunArtifact => ({
      ...withdrawn,
      fills: [{ ...lot, atEventIngestSeq }],
      traces: withdrawn.traces.filter((trace) => trace.venueFillId === lot.simulatedFillId),
    });
    expect(single("05").fills).toHaveLength(1);
    expect(single("05").traces).toHaveLength(1);
    // Control: the same document with the canonical spelling is folded.
    expect(() => buildReconciliation(single("5"))).not.toThrow();
    expect(() => buildReconciliation(single("05"))).toThrow(
      /not a canonical unsigned integer string/u,
    );
  });
});

// --- RISK2-R4 -----------------------------------------------------------------

/** The golden, with the protective reduction selling 25 of its 50 shares. */
function withPartialExit(artifact: PaperRunArtifact): PaperRunArtifact {
  const marks = landmarks(artifact);
  return {
    ...artifact,
    orders: artifact.orders.map((order) =>
      order.simulatedOrderId === marks.exitOrder.simulatedOrderId
        ? { ...order, filledShares: "25", state: "PARTIALLY_FILLED" }
        : order,
    ),
    fills: artifact.fills.map((fill) =>
      fill.simulatedFillId === marks.exitFill.simulatedFillId
        ? // 25 × 0.0195 × 0.32 × 0.68 = 0.10608, HALF_UP to 3 places.
          { ...fill, shares: "25", feeAmount: "0.106" }
        : fill,
    ),
  };
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

/**
 * FIFO over the lots in the order GIVEN — the fold `RECON-1` r1 replaced. Used
 * only to show that the replaced model would have answered differently on a
 * synthetic, so an agreement asserted against the engine is not vacuous.
 */
function fifoInGivenOrder(lots: readonly ArtifactFill[], retired: string): string {
  let unretired = retired;
  let open = "0";
  for (const lot of lots) {
    if (compareDecimal(unretired, lot.shares) >= 0) {
      unretired = subDecimal(unretired, lot.shares);
      continue;
    }
    open = addDecimal(open, mulDecimal(lot.price, subDecimal(lot.shares, unretired)));
    unretired = "0";
  }
  return open;
}

function openBasis(artifact: PaperRunArtifact): { capital: string; worstCase: string } {
  const rows = buildReconciliation(artifact);
  return {
    capital: row(rows, "pnl.capital_committed").projected,
    worstCase: row(rows, "pnl.worst_case_resolution").projected,
  };
}

// --- the ENGINE's own answer for the same fills (test side only) --------------

/** The PnL records the real run booked for one fill: its trade and its fee. */
interface Booking {
  readonly trade: PnlTradeRecord;
  readonly fee: PnlFeeRecord;
}

function isTrade(record: PnlRecord): record is PnlTradeRecord {
  return record.kind === "TRADE";
}

function isFee(record: PnlRecord): record is PnlFeeRecord {
  return record.kind === "FEE";
}

/**
 * The real run, and the PnL records it booked for each fill — found by id,
 * through the fill's trace and the ledger transactions it names.
 *
 * `packages/pnl` is called HERE, in the test, to establish what the engine
 * returns. `support/reconcile.ts` never calls it: the oracle must not run the
 * system it checks.
 */
async function bookedRun(): Promise<{
  readonly artifact: PaperRunArtifact;
  readonly booking: (fill: ArtifactFill) => Booking;
}> {
  const run = await driveScenario();
  const artifact = captureArtifact(run);
  const byRef = new Map(
    run.trader.loop.pnlRecords(INSTANCE_ID).map((record) => [record.ref, record] as const),
  );
  return {
    artifact,
    booking: (fill) => {
      const trace = only(
        artifact.traces.filter((candidate) => candidate.venueFillId === fill.simulatedFillId),
        `trace of fill ${fill.simulatedFillId}`,
      );
      const records = trace.ledgerTransactionIds.flatMap((id) => {
        const record = byRef.get(id);
        return record === undefined ? [] : [record];
      });
      return {
        trade: only(records.filter(isTrade), "trade record"),
        fee: only(records.filter(isFee), "fee record"),
      };
    },
  };
}

/** A booking re-sized for a synthetic fill, optionally under fresh refs. */
function resized(
  booking: Booking,
  shares: string,
  feeAmount: string,
  refs?: { readonly trade: string; readonly fee: string },
): Booking {
  return {
    trade: { ...booking.trade, shares, ...(refs === undefined ? {} : { ref: refs.trade }) },
    fee: { ...booking.fee, amount: feeAmount, ...(refs === undefined ? {} : { ref: refs.fee }) },
  };
}

/** What `packages/pnl` itself reports after folding these bookings, in this order. */
function engineSnapshot(artifact: PaperRunArtifact, bookings: readonly Booking[]): PnlSnapshot {
  const scenario = artifact.scenario;
  const identity: PnlStreamIdentity = {
    scope: "VIRTUAL_STRATEGY",
    environment: "PAPER",
    accountRef: scenario.accountRef,
    instanceId: scenario.instanceId,
    runId: scenario.runId,
    marketId: scenario.marketId,
  };
  const folded = foldPnlRecords(
    identity,
    bookings.flatMap((booking) => [booking.trade, booking.fee]),
  );
  if (!folded.ok) throw new Error(`packages/pnl refused the records: ${JSON.stringify(folded)}`);
  const token = bookings[0]?.trade.tokenAssetId ?? "";
  const snapshots = computePnlSnapshot(folded.value, {
    asOf: "2026-05-01T09:14:49Z",
    marks: { [token]: { midpoint: "0.32" } },
  });
  if (!snapshots.ok) throw new Error(`packages/pnl refused the snapshot: ${JSON.stringify(snapshots)}`);
  return only(snapshots.value, "snapshot");
}

/** The artefact, with the engine's snapshot as the LAST one — the one the table reads. */
function withSnapshot(artifact: PaperRunArtifact, snapshot: PnlSnapshot): PaperRunArtifact {
  return {
    ...artifact,
    pnlSnapshots: [...artifact.pnlSnapshots, Object.fromEntries(Object.entries(snapshot))],
  };
}

/**
 * Purchases and sales INTERLEAVED: buy 30 @ 0.34 (event 5), sell 5 (event 6),
 * buy 20 @ 0.35 (event 7), sell 25 (event 8). The second sale removes 25 of 45
 * shares from a lot whose basis is 15.5, and 15.5 × 25 / 45 = 8.61… does not
 * terminate, so `divDecimal`'s rounding is exercised.
 */
function interleaved(artifact: PaperRunArtifact, sequences: readonly string[]): PaperRunArtifact {
  const marks = landmarks(artifact);
  const [a, b] = marks.entryFills;
  if (a === undefined || b === undefined) throw new Error("two entry lots expected");
  const [sa = "5", s1 = "6", sb = "7", s2 = "8"] = sequences;
  return {
    ...artifact,
    orders: artifact.orders.map((order) =>
      order.simulatedOrderId === marks.exitOrder.simulatedOrderId
        ? { ...order, filledShares: "30", state: "PARTIALLY_FILLED" }
        : order,
    ),
    fills: [
      { ...a, atEventIngestSeq: sa },
      // 5 × 0.0195 × 0.32 × 0.68 = 0.021216, HALF_UP to 3 places.
      { ...marks.exitFill, shares: "5", feeAmount: "0.021", atEventIngestSeq: s1 },
      { ...b, atEventIngestSeq: sb },
      {
        ...marks.exitFill,
        simulatedFillId: `${marks.exitOrder.simulatedOrderId}/t0/1`,
        shares: "25",
        feeAmount: "0.106",
        atEventIngestSeq: s2,
      },
    ],
  };
}

/** The interleaved fills' bookings, in the order the ENGINE is to fold them. */
function interleavedBookings(
  booking: (fill: ArtifactFill) => Booking,
  marks: Landmarks,
  order: "INTERLEAVED" | "PURCHASES_FIRST",
): readonly Booking[] {
  const [a, b] = marks.entryFills;
  if (a === undefined || b === undefined) throw new Error("two entry lots expected");
  const x1 = resized(booking(marks.exitFill), "5", "0.021");
  const x2 = resized(booking(marks.exitFill), "25", "0.106", {
    trade: "9280f970-9280-7000-8000-0000000f1000",
    fee: "9280f970-9280-7000-8000-0000000f2000",
  });
  return order === "INTERLEAVED"
    ? [booking(a), x1, booking(b), x2]
    : [booking(a), booking(b), x1, x2];
}

// --- what support/reconcile.ts imports, read from its PARSED source -----------

/** The only modules the oracle may import: the decimal arithmetic and the artefact's types. */
const ORACLE_IMPORTS = ["./artifact.js", "@polymarket-bot/decimal"];

/**
 * The oracle's imports outside {@link ORACLE_IMPORTS}, read from its syntax
 * tree by the SHARED parse helper `support/module-specifiers.ts` (`RECON-2`,
 * `RECON1-SCAN`) — the one `safety-posture.test.ts`'s allowlist scan also
 * uses, so the two scans cannot drift back into two readers. A specifier that
 * is not a string literal is reported as {@link COMPUTED_SPECIFIER}.
 */
function independenceViolations(text: string): readonly string[] {
  return [
    ...new Set(moduleSpecifiersIn(text).filter((specifier) => !ORACLE_IMPORTS.includes(specifier))),
  ];
}

/** Hand-derived from the specification; see the test that pins it. */
const INTERLEAVED_OPEN_BASIS = "6.888888888888888888888888888888889";
const INTERLEAVED_REALIZED = "-0.711111111111111111111111111111111";

describe("RISK2-R4 — the fold follows atEventIngestSeq, not array order", () => {
  it("interleaved purchases and sales: all 24 array orders give the ENGINE's open basis", async () => {
    const { artifact, booking } = await bookedRun();
    const marks = landmarks(artifact);
    // Non-vacuous: the ENGINE itself answers differently when the same fills
    // are folded purchases-first, so the order genuinely matters here.
    expect(
      engineSnapshot(artifact, interleavedBookings(booking, marks, "PURCHASES_FIRST"))
        .capitalCommitted,
    ).toBe("6.88");
    const engine = engineSnapshot(artifact, interleavedBookings(booking, marks, "INTERLEAVED"));
    expect(engine.capitalCommitted).toBe(INTERLEAVED_OPEN_BASIS);

    const synthetic = withSnapshot(interleaved(artifact, []), engine);
    const orders = permutations(synthetic.fills);
    expect(orders).toHaveLength(24);
    for (const fills of orders) {
      const basis = openBasis({ ...synthetic, fills });
      expect(basis.capital).toBe(INTERLEAVED_OPEN_BASIS);
      expect(basis.worstCase).toBe(engine.worstCaseResolutionPnl);
    }
  });

  it("the sequence is compared as an INTEGER: event 9 is consumed before event 10", () => {
    const artifact = golden();
    // Events 9, 10, 11, 12. Compared as text, "10" sorts before "9", so the
    // first SALE would be folded before the first PURCHASE and refused as an
    // oversell; compared as integers the fold is the interleaved one above.
    const resequenced = interleaved(artifact, ["9", "10", "11", "12"]);
    for (const fills of permutations(resequenced.fills)) {
      expect(openBasis({ ...resequenced, fills }).capital).toBe(INTERLEAVED_OPEN_BASIS);
    }
  });

  it("a sale sequenced before the purchase it would draw on is refused, as the engine refuses it", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const fills = artifact.fills.map((fill) =>
      fill.simulatedFillId === marks.exitFill.simulatedFillId
        ? { ...fill, atEventIngestSeq: "4" }
        : fill,
    );
    expect(() => buildReconciliation({ ...artifact, fills })).toThrow(/PNL_OVERSELL/u);
    expect(() => buildReconciliation({ ...artifact, fills })).toThrow(
      marks.exitFill.simulatedFillId,
    );
  });

  it("a non-canonical sequence is refused rather than ordered", () => {
    const partial = withPartialExit(golden());
    const marks = landmarks(partial);
    const lot = marks.entryFills[0];
    if (lot === undefined) throw new Error("an entry lot expected");
    const fills = partial.fills.map((fill) =>
      fill.simulatedFillId === lot.simulatedFillId ? { ...fill, atEventIngestSeq: "05" } : fill,
    );
    expect(() => buildReconciliation({ ...partial, fills })).toThrow(
      /not a canonical unsigned integer string/u,
    );
  });
});

describe("the two comparators the fold sorts by", () => {
  it("compareIngestSeq is exact across lengths, including past 2^53", () => {
    expect(compareIngestSeq("9", "10")).toBe(-1);
    expect(compareIngestSeq("10", "9")).toBe(1);
    expect(compareIngestSeq("10", "10")).toBe(0);
    expect(compareIngestSeq("0", "1")).toBe(-1);
    expect(compareIngestSeq("99999999999999999999", "100000000000000000000")).toBe(-1);
    expect(compareIngestSeq("9007199254740993", "9007199254740992")).toBe(1);
    for (const bad of ["", "05", "-1", "1.0", " 1", "1e3"]) {
      expect(() => compareIngestSeq(bad, "1")).toThrow(/canonical/u);
      expect(() => compareIngestSeq("1", bad)).toThrow(/canonical/u);
    }
  });

  it("compareFillIds orders embedded indices by value and is a TOTAL order", () => {
    const order = "9280f970-9280-7000-8000-000000002000:g0:o0";
    expect(compareFillIds(`${order}/t0/9`, `${order}/t0/10`)).toBe(-1);
    expect(compareFillIds(`${order}/t0/10`, `${order}/t0/9`)).toBe(1);
    expect(compareFillIds(`${order}/t0/1`, `${order}/t0/1`)).toBe(0);
    expect(compareFillIds(`${order}/t0/99999999999999999999`, `${order}/t0/100000000000000000000`)).toBe(-1);
    // Equal by value but different strings: never 0, and antisymmetric.
    expect(compareFillIds(`${order}/t0/01`, `${order}/t0/1`)).not.toBe(0);
    expect(compareFillIds(`${order}/t0/01`, `${order}/t0/1`)).toBe(
      -compareFillIds(`${order}/t0/1`, `${order}/t0/01`),
    );
    // A sort by it is stable under any starting order.
    const ids = [
      `${order}/t0/10`,
      `${order}/t0/2`,
      `${order}/t0m/7`,
      `${order}/t0/0`,
      "9280f970-9280-7000-8000-000000013000:g0:o0/t0/0",
      `${order}/t1/3`,
    ];
    const sorted = [...ids].sort(compareFillIds);
    for (const start of permutations(ids.slice(0, 5))) {
      expect([...start, ids[5] ?? ""].sort(compareFillIds)).toEqual(sorted);
    }
    expect(sorted.slice(0, 3)).toEqual([`${order}/t0/0`, `${order}/t0/2`, `${order}/t0/10`]);
  });
});

/**
 * `RECON-1` r1 — the PnL rows reconcile against the ENGINE'S OWN COST METHOD.
 *
 * `packages/pnl/src/state.ts` specifies average cost: "Removing q shares from a
 * lot of Q shares with basis B removes basis B·q/Q — computed exactly when
 * q = Q, otherwise via `divDecimal`'s documented policy (34 significant
 * digits, ROUND_HALF_EVEN), with the REMAINING basis derived by exact
 * subtraction". `support/reconcile.ts` restates that rule without calling the
 * engine; each test below derives the expected numbers BY HAND from the
 * specification, confirms them against what the real `packages/pnl` fold
 * returns for the same fills, and then requires the table to agree.
 *
 * These replace the `RECON-1` finding pin, which asserted the FIFO fold's
 * DISAGREEMENT with the engine (8.7 against 8.6) and was built to fail the day
 * the model was aligned.
 */
describe("RECON-1 r1 — PnL reconciles against packages/pnl's own cost method (average cost)", () => {
  const PNL_ROWS = [
    "pnl.fees_paid",
    "pnl.capital_committed",
    "pnl.gross_trading",
    "pnl.core_net",
    "pnl.worst_case_resolution",
  ] as const;

  /**
   * Sell 25 of the 50 shares bought as 30 @ 0.34 and 20 @ 0.35.
   *
   *   lot before the sale:  Q = 50, B = 30 × 0.34 + 20 × 0.35 = 10.2 + 7 = 17.2
   *   removed (q = 25 ≠ Q): B·q/Q = 17.2 × 25 / 50 = 430 / 50 = 8.6
   *   remaining basis:      17.2 − 8.6 = 8.6            → capitalCommitted  8.6
   *   realized:             25 × 0.32 − 8.6 = 8 − 8.6   → realizedPnl      −0.6
   *   worst case:           realized − open = −0.6 − 8.6 → worstCase       −9.2
   *
   * FIFO would have left 5 × 0.34 + 20 × 0.35 = 8.7 open, and flagged this
   * correct run as unexplained.
   */
  it("a partial exit (25 of 50): both rows reconcile to the engine's own snapshot", async () => {
    const { artifact, booking } = await bookedRun();
    const marks = landmarks(artifact);
    const [a, b] = marks.entryFills;
    if (a === undefined || b === undefined) throw new Error("two entry lots expected");

    const engine = engineSnapshot(artifact, [
      booking(a),
      booking(b),
      resized(booking(marks.exitFill), "25", "0.106"),
    ]);
    // The hand derivation above, confirmed against the real engine.
    expect(engine.capitalCommitted).toBe("8.6");
    expect(engine.realizedPnl).toBe("-0.6");
    expect(engine.worstCaseResolutionPnl).toBe("-9.2");
    // Non-vacuous: the fold this replaces answers differently here.
    expect(fifoInGivenOrder(marks.entryFills, "25")).toBe("8.7");

    const rows = buildReconciliation(withSnapshot(withPartialExit(artifact), engine));
    for (const id of PNL_ROWS) {
      expect(row(rows, id).unexplainedReasons).toEqual([]);
      expect(row(rows, id).explained).toBe(true);
    }
    expect(row(rows, "pnl.capital_committed").projected).toBe("8.6");
    expect(row(rows, "pnl.capital_committed").realized).toBe("8.6");
    expect(row(rows, "pnl.worst_case_resolution").projected).toBe("-9.2");
    expect(row(rows, "pnl.worst_case_resolution").realized).toBe("-9.2");
  });

  /**
   * The split that does NOT divide evenly — `divDecimal`'s rounding, tested.
   *
   *   buy 30 @ 0.34:  Q = 30, B = 10.2
   *   sell 5:         removed 10.2 × 5 / 30 = 51 / 30 = 1.7        (terminates)
   *                   Q = 25, B = 8.5;   realized 5 × 0.32 − 1.7 = −0.1
   *   buy 20 @ 0.35:  Q = 45, B = 8.5 + 7 = 15.5
   *   sell 25:        removed 15.5 × 25 / 45 = 387.5 / 45 = 8.6111…  (DOES NOT)
   *                   → 34 significant digits, ROUND_HALF_EVEN (the 35th digit
   *                     is 1, so it rounds down):
   *                     8.611111111111111111111111111111111
   *                   remaining B = 15.5 − 8.611111111111111111111111111111111
   *                               = 6.888888888888888888888888888888889
   *                   realized 25 × 0.32 − 8.611111111111111111111111111111111
   *                               = −0.611111111111111111111111111111111
   *   capitalCommitted  6.888888888888888888888888888888889
   *   realizedPnl      −0.1 − 0.611111111111111111111111111111111
   *                               = −0.711111111111111111111111111111111
   *   worstCase        −0.711111111111111111111111111111111
   *                    − 6.888888888888888888888888888888889 = −7.6 exactly,
   *                    because the remainder was DERIVED by subtraction, so the
   *                    basis is conserved across the rounded split.
   */
  it("an uneven split exercises divDecimal's rounding, and still reconciles exactly", async () => {
    const { artifact, booking } = await bookedRun();
    const marks = landmarks(artifact);
    // The quotient genuinely does not terminate: this is the rounding branch.
    expect(() => divDecimalExact("387.5", "45")).toThrow();

    const engine = engineSnapshot(artifact, interleavedBookings(booking, marks, "INTERLEAVED"));
    expect(engine.capitalCommitted).toBe(INTERLEAVED_OPEN_BASIS);
    expect(engine.realizedPnl).toBe(INTERLEAVED_REALIZED);
    expect(engine.worstCaseResolutionPnl).toBe("-7.6");
    // Non-vacuous: FIFO would retire the whole 0.34 lot and leave 20 × 0.35.
    expect(fifoInGivenOrder(marks.entryFills, "30")).toBe("7");

    const rows = buildReconciliation(withSnapshot(interleaved(artifact, []), engine));
    for (const id of PNL_ROWS) {
      expect(row(rows, id).unexplainedReasons).toEqual([]);
      expect(row(rows, id).explained).toBe(true);
    }
    expect(row(rows, "pnl.capital_committed").projected).toBe(INTERLEAVED_OPEN_BASIS);
    expect(row(rows, "pnl.worst_case_resolution").projected).toBe("-7.6");
  });

  it("fully open and fully closed — the golden's only states — are unchanged", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // Fully CLOSED — the golden itself: nothing is left open.
    expect(openBasis(artifact).capital).toBe("0");
    // Fully OPEN — the exit fill removed: the whole entry notional is open.
    // `RECON2-R1`: the fill goes WITH its trace, and its order reports nothing
    // filled (`withReductionWithdrawn`); a trace left naming a fill the
    // document no longer holds is now refused, which is not this pin's subject.
    const open = withReductionWithdrawn(artifact);
    expect(open.fills.some((fill) => fill.simulatedFillId === marks.exitFill.simulatedFillId)).toBe(
      false,
    );
    expect(openBasis(open).capital).toBe(
      marks.entryFills.reduce(
        (total, fill) => addDecimal(total, mulDecimal(fill.price, fill.shares)),
        "0",
      ),
    );
    expect(openBasis(open).capital).toBe("17.2");
  });


  /**
   * `RECON-1` r2 (review R3): this pin used to be a LINE regex that required
   * the specifier to end the line, so
   * `import { foldPnlRecords as reviewEngine } from "@polymarket-bot/pnl"; // …`
   * passed it. It now reads the PARSED module: every import and export
   * declaration, side-effect import, `import x = require(…)`, `import(…)` call,
   * import type node and `require(…)` call, wherever the grammar puts one;
   * text inside comments and string data is inert. `RECON-2`: the parse is the
   * shared helper's (`support/module-specifiers.ts`), not a private copy.
   */
  it("the oracle does not run the engine: support/reconcile.ts imports only the decimal arithmetic", () => {
    const source = readFileSync(new URL("./support/reconcile.ts", import.meta.url), "utf8");
    expect([...new Set(moduleSpecifiersIn(source))].sort()).toEqual(ORACLE_IMPORTS);
    expect(independenceViolations(source)).toEqual([]);

    // Each plant is an engine import the old line regex could not see, or one
    // of the other spellings the grammar allows. Every one is caught.
    const plants = [
      `import { foldPnlRecords as reviewEngine } from "@polymarket-bot/pnl"; // review independence probe`,
      `import "@polymarket-bot/pnl";`,
      `const engine = await import("@polymarket-bot/pnl");`,
      `export { foldPnlRecords } from "@polymarket-bot/pnl";`,
      `import engine = require("@polymarket-bot/pnl");`,
      `const engine = require("@polymarket-bot/pnl");`,
      `type Engine = typeof import("@polymarket-bot/pnl");`,
    ];
    for (const plant of plants) {
      expect(independenceViolations(`${source}\n${plant}\n`), plant).toEqual(["@polymarket-bot/pnl"]);
    }
    // A specifier the parser cannot read is a violation, not a pass.
    expect(independenceViolations(`${source}\nconst where = "x";\nawait import(where);\n`)).toEqual([
      COMPUTED_SPECIFIER,
    ]);
    // A MENTION is not an import: comments and string data stay inert.
    expect(
      independenceViolations(
        `${source}\n// the spec lives in "@polymarket-bot/pnl"\nconst note = "@polymarket-bot/pnl";\n`,
      ),
    ).toEqual([]);
  });

  it("the restated division policy is the decimal package's default, which packages/pnl relies on", () => {
    // `packages/pnl` calls `divDecimal` with no options. The reconciler states
    // 34 / ROUND_HALF_EVEN explicitly; if the package default ever moves, the
    // engine moves with it and this pin names the drift.
    expect(PNL_COST_DIVISION).toEqual({
      precision: DIVISION_PRECISION,
      rounding: DIVISION_ROUNDING,
    });
    expect(DIVISION_PRECISION).toBe(34);
  });
});

// --- RECON1-EDGE ---------------------------------------------------------------

/** A row's contributions as `[mechanism, amount]` pairs, in order. */
function amounts(entry: ReconciliationRow): readonly (readonly [string, string])[] {
  return entry.contributions.map((contribution) => [contribution.mechanism, contribution.amount] as const);
}

function edgeRow(artifact: PaperRunArtifact): ReconciliationRow {
  return row(buildReconciliation(artifact), "exit.expected_net_edge");
}

/** The golden with its protective reduction WITHDRAWN unfilled: the whole position open at run end. */
function withReductionWithdrawn(artifact: PaperRunArtifact): PaperRunArtifact {
  const marks = landmarks(artifact);
  return {
    ...artifact,
    orders: artifact.orders.map((order) =>
      order.simulatedOrderId === marks.exitOrder.simulatedOrderId
        ? { ...order, filledShares: "0", state: "CANCELLED" }
        : order,
    ),
    fills: artifact.fills.filter((fill) => fill.simulatedFillId !== marks.exitFill.simulatedFillId),
    traces: artifact.traces.filter((trace) => trace.venueFillId !== marks.exitFill.simulatedFillId),
  };
}

/**
 * `RECON1-EDGE` — the orchestrator's ruling, implemented and pinned.
 *
 * `exit.expected_net_edge` stays the ENTRY intent's persisted projection
 * against the round trip realized SO FAR. The strategy's formula
 * (`packages/strategies/static-bracket`, recomputed on the
 * `entry.expected_net_edge_formula` row) is, with E the entry's shares, TP the
 * take-profit price and fe / fx the configured per-share entry / exit fees:
 *
 *     projected = TP × E − entryCost − (fe + fx) × E
 *
 * The realized round trip is P − N − C: exit proceeds, entry notional, and the
 * fee charged on every fill. With X shares exited, O = E − X still open and U
 * the fees' exact, unrounded total, the named contributions are
 *
 *     EXIT_BELOW_TAKE_PROFIT      P − TP × X
 *     POSITION_OPEN_AT_RUN_END    −(TP − fx) × O               (only when O ≠ 0)
 *     FEE_MODEL_BASIS             −(U − (fe × E + fx × X))
 *     FEE_ROUNDING_HALF_UP        −(C − U)
 *
 * They sum to P − TP × E + (fe + fx) × E − C, which is the difference EXACTLY
 * when entryCost = N: the persisted projection decomposes term for term, so
 * the residual is not zero by coincidence. The last two pins probe exactly
 * that — per-side fees that differ, and an entry that cost more than it
 * projected.
 *
 * The golden's fills, from which every number below is derived by hand:
 *
 *     entry   30 @ 0.34 (fee 0.131, exact 0.131274)  +  20 @ 0.35 (fee 0.089, exact 0.088725)
 *             N = 10.2 + 7 = 17.2, E = 50
 *     exit    SELL @ 0.32; the fee on q shares is q × 0.0195 × 0.32 × 0.68 = q × 0.0042432
 *     TP = 0.5, fe = fx = 0.001, so projected = 0.5 × 50 − 17.2 − 0.002 × 50 = 25 − 17.2 − 0.1 = 7.7
 */
describe("RECON1-EDGE — shares open at run end are a NAMED mechanism, not a residual", () => {
  /**
   * Sell 25 of the 50 (X = 25, O = 25). Exit fee 25 × 0.0042432 = 0.10608,
   * charged 0.106.
   *
   *   P = 25 × 0.32 = 8
   *   C = 0.131 + 0.089 + 0.106      = 0.326
   *   U = 0.131274 + 0.088725 + 0.10608 = 0.326079
   *   realized   = 8 − 17.2 − 0.326   = −9.526
   *   difference = −9.526 − 7.7       = −17.226
   *
   *   EXIT_BELOW_TAKE_PROFIT     8 − 0.5 × 25                            = −4.5
   *   POSITION_OPEN_AT_RUN_END   −(0.5 − 0.001) × 25 = −0.499 × 25        = −12.475
   *   FEE_MODEL_BASIS            −(0.326079 − (0.001 × 50 + 0.001 × 25))
   *                              = −(0.326079 − 0.075)                   = −0.251079
   *   FEE_ROUNDING_HALF_UP       −(0.326 − 0.326079)                     = +0.000079
   *   Σ = −4.5 − 12.475 − 0.251079 + 0.000079 = −17.226 → residual 0
   *
   * `RECON-1` had no open-position term and modelled the exit fee on all 50
   * shares: FEE_MODEL_BASIS −(0.326079 − 0.1) = −0.226079, Σ = −4.726, and the
   * residual was −17.226 − (−4.726) = −12.5 = TP × (X − E) = 0.5 × (25 − 50).
   * The ruling closes exactly that: the new term (−12.475) plus the fee
   * model's move (−0.251079 − (−0.226079) = −0.025 = −fx × O) is −12.5.
   */
  it("a partial exit (25 of 50): the open 25 shares are POSITION_OPEN_AT_RUN_END, and the residual is 0", () => {
    const edge = edgeRow(withPartialExit(golden()));
    expect(edge.projected).toBe("7.7");
    expect(edge.realized).toBe("-9.526");
    expect(edge.difference).toBe("-17.226");
    expect(amounts(edge)).toEqual([
      ["EXIT_BELOW_TAKE_PROFIT", "-4.5"],
      ["POSITION_OPEN_AT_RUN_END", "-12.475"],
      ["FEE_MODEL_BASIS", "-0.251079"],
      ["FEE_ROUNDING_HALF_UP", "0.000079"],
    ]);
    expect(edge.residual).toBe("0");
    expect(edge.explained).toBe(true);
    expect(edge.unexplainedReasons).toEqual([]);
    expect(edge.contributions[1]?.note).toContain("(0.5 − 0.001) × 25 = 12.475");

    // Non-vacuous: RECON-1's decomposition of the SAME row left −12.5.
    const recon1 = ["-4.5", subDecimal("0.1", "0.326079"), "0.000079"].reduce(
      (total, value) => addDecimal(total, value),
      "0",
    );
    expect(recon1).toBe("-4.726");
    expect(subDecimal(edge.difference ?? "", recon1)).toBe("-12.5");
    expect(mulDecimal("0.5", subDecimal("25", "50"))).toBe("-12.5");
  });

  /**
   * RISK2-R4's interleaved fills: buy 30 @ 0.34, sell 5 (fee 0.021, exact
   * 0.021216), buy 20 @ 0.35, sell 25 (fee 0.106, exact 0.10608). X = 30,
   * O = 20. (This row sums; the order of the fold does not enter it.)
   *
   *   P = 30 × 0.32 = 9.6
   *   C = 0.131 + 0.089 + 0.021 + 0.106 = 0.347
   *   U = 0.131274 + 0.088725 + 0.021216 + 0.10608 = 0.347295
   *   realized   = 9.6 − 17.2 − 0.347 = −7.947
   *   difference = −7.947 − 7.7       = −15.647
   *
   *   EXIT_BELOW_TAKE_PROFIT     9.6 − 0.5 × 30                    = −5.4
   *   POSITION_OPEN_AT_RUN_END   −0.499 × 20                       = −9.98
   *   FEE_MODEL_BASIS            −(0.347295 − (0.05 + 0.001 × 30)) = −0.267295
   *   FEE_ROUNDING_HALF_UP       −(0.347 − 0.347295)               = +0.000295
   *   Σ = −5.4 − 9.98 − 0.267295 + 0.000295 = −15.647 → residual 0
   */
  it("two exit fills leaving 20 of 50 open: explained, residual 0", () => {
    const edge = edgeRow(interleaved(golden(), []));
    expect(edge.realized).toBe("-7.947");
    expect(edge.difference).toBe("-15.647");
    expect(amounts(edge)).toEqual([
      ["EXIT_BELOW_TAKE_PROFIT", "-5.4"],
      ["POSITION_OPEN_AT_RUN_END", "-9.98"],
      ["FEE_MODEL_BASIS", "-0.267295"],
      ["FEE_ROUNDING_HALF_UP", "0.000295"],
    ]);
    expect(edge.residual).toBe("0");
    expect(edge.explained).toBe(true);
  });

  /**
   * The protective reduction WITHDRAWN unfilled: X = 0, O = 50, the whole
   * position open at run end.
   *
   *   P = 0,  C = 0.22,  U = 0.219999
   *   realized   = 0 − 17.2 − 0.22 = −17.42
   *   difference = −17.42 − 7.7    = −25.12
   *
   *   EXIT_BELOW_TAKE_PROFIT     0 − 0.5 × 0                  = 0
   *   POSITION_OPEN_AT_RUN_END   −0.499 × 50                  = −24.95
   *   FEE_MODEL_BASIS            −(0.219999 − (0.05 + 0))     = −0.169999
   *   FEE_ROUNDING_HALF_UP       −(0.22 − 0.219999)           = −0.000001
   *   Σ = −24.95 − 0.169999 − 0.000001 = −25.12 → residual 0
   *
   * …and `RECON1-TEXT`: its own absent-proceeds row names a withdrawn
   * PROTECTIVE REDUCTION (0.3 × 50 = 15), not a take-profit.
   */
  it("no exit fill at all (the reduction withdrawn unfilled): explained, and the withdrawn reduction is named", () => {
    const artifact = withReductionWithdrawn(golden());
    const marks = landmarks(golden());
    const rows = buildReconciliation(artifact);
    const edge = row(rows, "exit.expected_net_edge");
    expect(edge.realized).toBe("-17.42");
    expect(edge.difference).toBe("-25.12");
    expect(amounts(edge)).toEqual([
      ["EXIT_BELOW_TAKE_PROFIT", "0"],
      ["POSITION_OPEN_AT_RUN_END", "-24.95"],
      ["FEE_MODEL_BASIS", "-0.169999"],
      ["FEE_ROUNDING_HALF_UP", "-0.000001"],
    ]);
    expect(edge.residual).toBe("0");
    expect(edge.explained).toBe(true);

    const withdrawn = row(rows, `exit.cancelled_proceeds.${marks.exitOrder.simulatedOrderId}`);
    expect(withdrawn.quantity).toBe("the proceeds a withdrawn protective reduction projected");
    expect(withdrawn.projected).toBe("15");
    expect(withdrawn.explained).toBe(true);
    expect(withdrawn.contributions[0]?.note).toContain(
      `the protective reduction the \`reduce\` decision at evaluationSeq ${String(marks.reduce.evaluationSeq)} placed`,
    );
  });

  /**
   * Per-side fees that DIFFER: fe = 0.001, fx = 0.003. With fe = fx, as in the
   * golden, a fee basis that swapped the two share counts would be
   * indistinguishable; here it is not. The persisted projection is set to what
   * the strategy's formula gives for these fees, so the entry's own formula row
   * stays exact:
   *
   *   projected = 25 − 17.2 − (0.001 + 0.003) × 50 = 25 − 17.2 − 0.2 = 7.6
   *
   * Sell 25 of 50 (fills as in the first pin):
   *
   *   realized   = −9.526;  difference = −9.526 − 7.6 = −17.126
   *   EXIT_BELOW_TAKE_PROFIT     −4.5
   *   POSITION_OPEN_AT_RUN_END   −(0.5 − 0.003) × 25 = −0.497 × 25          = −12.425
   *   FEE_MODEL_BASIS            −(0.326079 − (0.001 × 50 + 0.003 × 25))
   *                              = −(0.326079 − 0.125)                      = −0.201079
   *   FEE_ROUNDING_HALF_UP       +0.000079
   *   Σ = −4.5 − 12.425 − 0.201079 + 0.000079 = −17.126 → residual 0
   *
   * The swapped basis, fe × X + fx × E = 0.025 + 0.15 = 0.175, would give
   * FEE_MODEL_BASIS −0.151079 and leave a residual of −0.05.
   */
  it("per-side fees that differ: the exit fee is modelled on EXITED shares, and the residual is 0", () => {
    const partial = withPartialExit(golden());
    const marks = landmarks(partial);
    const artifact: PaperRunArtifact = {
      ...partial,
      scenario: { ...partial.scenario, exitFeePerShare: "0.003" },
      decisions: partial.decisions.map((decision) =>
        decision.evaluationSeq === marks.enter.evaluationSeq
          ? {
              ...decision,
              modelOutputs: { ...decision.modelOutputs, expectedNetEdge: "7.6" },
              intents: decision.intents.map((intent) =>
                intent.intentId === marks.entryIntent.intentId
                  ? { ...intent, expectedNetEdge: "7.6" }
                  : intent,
              ),
            }
          : decision,
      ),
    };
    const rows = buildReconciliation(artifact);
    // The formula row agrees with the re-stated projection, so the projection
    // is what the strategy WOULD have persisted for these fees.
    expect(row(rows, "entry.expected_net_edge_formula").explained).toBe(true);
    expect(row(rows, "entry.expected_net_edge_formula").projected).toBe("7.6");

    const edge = row(rows, "exit.expected_net_edge");
    expect(edge.projected).toBe("7.6");
    expect(edge.difference).toBe("-17.126");
    expect(amounts(edge)).toEqual([
      ["EXIT_BELOW_TAKE_PROFIT", "-4.5"],
      ["POSITION_OPEN_AT_RUN_END", "-12.425"],
      ["FEE_MODEL_BASIS", "-0.201079"],
      ["FEE_ROUNDING_HALF_UP", "0.000079"],
    ]);
    expect(edge.residual).toBe("0");
    expect(edge.explained).toBe(true);
    // Non-vacuous: the two share counts give different bases here.
    expect(addDecimal(mulDecimal("0.001", "25"), mulDecimal("0.003", "50"))).toBe("0.175");
    expect(addDecimal(mulDecimal("0.001", "50"), mulDecimal("0.003", "25"))).toBe("0.125");
  });

  /**
   * An entry that cost MORE than it projected — the second lot fills at 0.365,
   * not 0.35 (exact fee 20 × 0.0195 × 0.365 × 0.635 = 0.09039225, charged
   * 0.090) — then sells 25 of 50. The open-position term must not absorb a gap
   * that is not an open position:
   *
   *   N = 10.2 + 7.3 = 17.5 against the persisted entryCost 17.2
   *   C = 0.131 + 0.09 + 0.106 = 0.327;  U = 0.131274 + 0.09039225 + 0.10608 = 0.32774625
   *   realized   = 8 − 17.5 − 0.327 = −9.827;  difference = −9.827 − 7.7 = −17.527
   *   EXIT_BELOW_TAKE_PROFIT     −4.5
   *   POSITION_OPEN_AT_RUN_END   −12.475           (unchanged: O is still 25)
   *   FEE_MODEL_BASIS            −(0.32774625 − 0.075) = −0.25274625
   *   FEE_ROUNDING_HALF_UP       −(0.327 − 0.32774625) = +0.00074625
   *   Σ = −17.227, so the residual is −17.527 − (−17.227) = −0.3 = entryCost − N
   *
   * The row stays UNEXPLAINED by exactly the entry's own gap, which
   * `entry.projected_cost` reports on its own row.
   */
  it("an entry that cost more than projected stays unexplained by exactly entryCost − N", () => {
    const partial = withPartialExit(golden());
    const marks = landmarks(partial);
    const [, second] = marks.entryFills;
    if (second === undefined) throw new Error("two entry lots expected");
    const artifact: PaperRunArtifact = {
      ...partial,
      fills: partial.fills.map((fill) =>
        fill.simulatedFillId === second.simulatedFillId
          ? { ...fill, price: "0.365", feeAmount: "0.09" }
          : fill,
      ),
    };
    const rows = buildReconciliation(artifact);
    const edge = row(rows, "exit.expected_net_edge");
    expect(edge.difference).toBe("-17.527");
    expect(amounts(edge)).toEqual([
      ["EXIT_BELOW_TAKE_PROFIT", "-4.5"],
      ["POSITION_OPEN_AT_RUN_END", "-12.475"],
      ["FEE_MODEL_BASIS", "-0.25274625"],
      ["FEE_ROUNDING_HALF_UP", "0.00074625"],
    ]);
    expect(edge.residual).toBe("-0.3");
    expect(edge.explained).toBe(false);
    expect(edge.unexplainedReasons).toEqual([
      "the named mechanisms leave an unexplained residual of -0.3",
    ]);
    expect(subDecimal("17.2", "17.5")).toBe(edge.residual);
    expect(row(rows, "entry.projected_cost").difference).toBe("0.3");
    expect(row(rows, "entry.projected_cost").explained).toBe(false);
  });

  /**
   * The golden, fully CLOSED (X = E = 50, O = 0): P = 16, C = 0.432,
   * U = 0.432159.
   *
   *   EXIT_BELOW_TAKE_PROFIT   16 − 0.5 × 50            = −9
   *   FEE_MODEL_BASIS          −(0.432159 − (0.05 + 0.05)) = −0.332159
   *   FEE_ROUNDING_HALF_UP     −(0.432 − 0.432159)      = +0.000159
   *   Σ = −9.332 = −1.632 − 7.7 → residual 0
   *
   * No `POSITION_OPEN_AT_RUN_END`, and fe × E + fx × X = 0.1 = (fe + fx) × E,
   * `RECON-1`'s basis: the golden's row is unchanged, number and word.
   */
  it("a fully closed round trip — the golden — carries no open-position term, and its row is unchanged", () => {
    const artifact = golden();
    const edge = edgeRow(artifact);
    expect(amounts(edge)).toEqual([
      ["EXIT_BELOW_TAKE_PROFIT", "-9"],
      ["FEE_MODEL_BASIS", "-0.332159"],
      ["FEE_ROUNDING_HALF_UP", "0.000159"],
    ]);
    expect(edge.difference).toBe("-9.332");
    expect(edge.residual).toBe("0");
    expect(edge.contributions[1]?.note).toBe(
      "the strategy modelled (entry_fee_per_share + exit_fee_per_share) × shares = 0.1; the " +
        "schedule's exact ad-valorem total over every fill is 0.432159",
    );
    expect(edge).toEqual(row(artifact.reconciliation, "exit.expected_net_edge"));
  });
});
