/**
 * `RECON-1` — the reconciler's two latent traps, closed and pinned.
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
 * Every probe here follows `projection-reconciliation.test.ts`'s falsifiability
 * pattern: the COMMITTED GOLDEN is parsed afresh (a deep copy), changed in one
 * deliberate way, and handed to `buildReconciliation`. Each synthetic artefact
 * carries a precondition that makes it non-vacuous — the change really is
 * reachable by the rule under test — and each was run against the base
 * reconciler (`5d8b24f`) to confirm that it mis-reconciled there.
 *
 * The golden itself is NOT changed by `RECON-1`: every fill and order it
 * carries is reached by exactly one chain, and its fills are already in
 * sequence order, so the table it freezes is byte-identical
 * (`determinism-golden.test.ts`).
 */

import { readFileSync } from "node:fs";

import ts from "typescript";
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
  type ArtifactTrace,
  type PaperRunArtifact,
} from "./support/artifact.js";
import { goldenBytes } from "./support/golden.js";
import { driveScenario } from "./support/harness.js";
import {
  PNL_COST_DIVISION,
  buildReconciliation,
  compareFillIds,
  compareIngestSeq,
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

interface Landmarks {
  readonly enter: ArtifactDecision;
  readonly entryIntent: ArtifactIntent;
  readonly entryTrace: ArtifactTrace;
  readonly entryOrder: ArtifactOrder;
  readonly entryFills: readonly ArtifactFill[];
  readonly exitDecision: ArtifactDecision;
  readonly reduce: ArtifactDecision;
  readonly exitOrder: ArtifactOrder;
  readonly exitFill: ArtifactFill;
  readonly takeProfit: ArtifactOrder;
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
  return {
    enter,
    entryIntent,
    entryTrace,
    entryOrder,
    entryFills: artifact.fills.filter(
      (fill) => fill.simulatedOrderId === entryOrder.simulatedOrderId,
    ),
    exitDecision: only(
      artifact.decisions.filter((decision) => decision.decisionType === "exit"),
      "exit decision",
    ),
    reduce,
    exitOrder: only(
      artifact.orders.filter((order) => order.executionPlanId === exitTrace.executionPlanId),
      "exit order",
    ),
    exitFill: only(
      artifact.fills.filter((fill) => fill.simulatedFillId === exitTrace.venueFillId),
      "exit fill",
    ),
    takeProfit: only(
      artifact.orders.filter((order) => order.state === "CANCELLED"),
      "withdrawn order",
    ),
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

/** The trace the loop would record for `fill`, emitted by `intentId`. */
function traceOf(
  base: ArtifactTrace,
  intentId: string,
  evaluationSeq: number,
  order: ArtifactOrder,
  fill: ArtifactFill,
): ArtifactTrace {
  return {
    ...base,
    evaluationSeq,
    intentId,
    approvedIntentId: `${order.executionPlanId}-approved`,
    executionPlanId: order.executionPlanId,
    submissionAttemptId: `${order.executionPlanId}-submission`,
    venueOrderId: order.simulatedOrderId,
    venueFillId: fill.simulatedFillId,
    ledgerFillId: `${fill.simulatedFillId}-ledger`,
    ledgerTransactionIds: [],
  };
}

/**
 * A SECOND BRACKET's entry: a new `enter` decision, its own POSITION intent, and
 * an order under a plan of its own — either FILLED (with its fill and trace), or
 * WITHDRAWN UNFILLED, which has no trace because the loop traces fills.
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
    return {
      ...artifact,
      decisions: [...artifact.decisions, decision],
      orders: [...artifact.orders, order],
    };
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
  return {
    ...artifact,
    decisions: [...artifact.decisions, decision],
    traces: [...artifact.traces, traceOf(marks.entryTrace, intentId, evaluationSeq, order, fill)],
    orders: [...artifact.orders, order],
    fills: [...artifact.fills, fill],
  };
}

// =============================================================================

describe("RECON-1 — the golden's own attribution, positively", () => {
  it("every golden fill is reached by exactly one chain, and the table is unchanged", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // Two entry fills, one exit fill, and no third kind: the partition the
    // reconciler now PROVES rather than assumes.
    expect(marks.entryFills).toHaveLength(2);
    expect(artifact.fills).toHaveLength(3);
    expect(buildReconciliation(artifact)).toEqual(artifact.reconciliation);
  });

  it("the withdrawn take-profit is the ONLY exit cancellation, and it is the exit's", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const cancelled = buildReconciliation(artifact)
      .filter((entry) => entry.id.startsWith("exit.cancelled_proceeds."))
      .map((entry) => entry.id);
    expect(cancelled).toEqual([`exit.cancelled_proceeds.${marks.takeProfit.simulatedOrderId}`]);
    // It has no trace — the loop traces FILLS — so the reconciler reaches it by
    // the closed-world rule: the only order-placing intent no trace names is
    // the take-profit the `exit` decision emitted.
    expect(
      artifact.traces.some((trace) => trace.executionPlanId === marks.takeProfit.executionPlanId),
    ).toBe(false);
    expect(marks.exitDecision.intents.map((intent) => intent.type)).toEqual(["POSITION"]);
  });

  /**
   * The complement would still report the take-profit row with its origin
   * erased; the positive rule cannot, because nothing is left that could have
   * placed the order.
   */
  it("remove the take-profit's intent and its row is REFUSED, not kept by complement", () => {
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
    expect(() => buildReconciliation({ ...artifact, decisions })).toThrow(/no possible origin/u);
  });

  it("an exit fill is the exit's because a REDUCE decision emitted it, not because it is not the entry's", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // Re-type the decision that emitted the protective reduction. Its fill is
    // untouched — same order, same plan, same trace — but no exit or reduce
    // decision now owns the intent that trace names.
    const decisions = artifact.decisions.map((decision) =>
      decision.evaluationSeq === marks.reduce.evaluationSeq
        ? { ...decision, decisionType: "hold" }
        : decision,
    );
    expect(() => buildReconciliation({ ...artifact, decisions })).toThrow(
      marks.exitFill.simulatedFillId,
    );
    expect(() => buildReconciliation({ ...artifact, decisions })).toThrow(
      /belongs to neither the entry's chain nor any exit's/u,
    );
  });
});

describe("RISK2-R3 — a fill in neither chain is refused, by name (R3a)", () => {
  const shapes: readonly {
    readonly name: string;
    readonly build: (artifact: PaperRunArtifact) => {
      readonly tampered: PaperRunArtifact;
      readonly fill: ArtifactFill;
    };
  }[] = [
    {
      name: "a fill on an order whose plan NO trace names",
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
      build: (artifact) => {
        const marks = landmarks(artifact);
        const order = orderUnder(marks.exitOrder, planId("fb000"), {});
        const fill = fillOf(marks.exitFill, order, { shares: "10", feeAmount: "0.042" });
        return { tampered: { ...artifact, fills: [...artifact.fills, fill] }, fill };
      },
    },
    {
      name: "a fill TRACED to an intent that neither the entry nor an exit emitted (a QUOTE)",
      build: (artifact) => {
        const marks = landmarks(artifact);
        const quoteIntentId = `quote-4-${artifact.scenario.marketId}`;
        const decision: ArtifactDecision = {
          ...marks.exitDecision,
          evaluationSeq: 18,
          decisionType: "quote",
          intents: [{ type: "QUOTE", intentId: quoteIntentId, marketId: artifact.scenario.marketId }],
        };
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
        return {
          tampered: {
            ...artifact,
            decisions: [...artifact.decisions, decision],
            traces: [...artifact.traces, traceOf(marks.entryTrace, quoteIntentId, 18, order, fill)],
            orders: [...artifact.orders, order],
            fills: [...artifact.fills, fill],
          },
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
      expect(() => buildReconciliation(tampered)).toThrow(
        /belongs to neither the entry's chain nor any exit's/u,
      );
    });
  }
});

describe("RISK2-R3 — more than one entry is refused, not read as the first (R3b)", () => {
  it("a second `enter` decision with its own filled chain is refused outright", () => {
    const tampered = withSecondEntry(golden(), "FILLED");
    // Non-vacuous: the second entry is a complete chain of its own — decision,
    // intent, trace, plan, order, fill — which the base reconciler ignored as
    // an entry and summed, BUY and all, into exit proceeds.
    expect(tampered.decisions.filter((decision) => decision.decisionType === "enter")).toHaveLength(2);
    expect(tampered.fills).toHaveLength(4);
    expect(() => buildReconciliation(tampered)).toThrow(/2 `enter` decisions/u);
    expect(() => buildReconciliation(tampered)).toThrow(/evaluationSeq 1, 18/u);
    expect(() => buildReconciliation(tampered)).toThrow(/instead of reading only the first/u);
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
  it("a second bracket's entry, rested and withdrawn: refused, never a withdrawn take-profit", () => {
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
  });

  it("an unfilled order that no untraced intent could have placed: refused, by name", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // One entry, one take-profit — and an extra BUY withdrawn unfilled under a
    // plan no trace names. Only ONE order-placing intent lacks a trace (the
    // take-profit), and it cannot have produced TWO plans: the loop mints one
    // plan per approved intent. The base reconciler reported this order as a
    // second withdrawn take-profit.
    const order = orderUnder(marks.entryOrder, planId("fc000"), {
      requestedShares: "10",
      filledShares: "0",
      state: "CANCELLED",
      limitPrice: "0.33",
    });
    const tampered = { ...artifact, orders: [...artifact.orders, order] };
    expect(() => buildReconciliation(tampered)).toThrow(order.simulatedOrderId);
    expect(() => buildReconciliation(tampered)).toThrow(/no possible origin/u);
  });

  /**
   * An unfilled order has no trace, so its side is DEDUCED — and the deduction
   * holds only while every intent that could have placed it is an exit. A
   * QUOTE is the realistic case: quotes rest, and resting orders are withdrawn
   * unfilled all the time.
   */
  it("the take-profit's attribution is withdrawn the moment a non-exit intent could have placed it", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const decision: ArtifactDecision = {
      ...marks.exitDecision,
      evaluationSeq: 18,
      decisionType: "quote",
      intents: [
        {
          type: "QUOTE",
          intentId: `quote-4-${artifact.scenario.marketId}`,
          marketId: artifact.scenario.marketId,
        },
      ],
    };
    const tampered = { ...artifact, decisions: [...artifact.decisions, decision] };
    expect(() => buildReconciliation(tampered)).toThrow(marks.takeProfit.simulatedOrderId);
    expect(() => buildReconciliation(tampered)).toThrow(/not an exit/u);
  });

  it("an entry order withdrawn beside a filled sibling stays the ENTRY's: no exit row, no refusal", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    // Under the entry's OWN plan, so the trace chain reaches it by id.
    const sibling: ArtifactOrder = {
      ...marks.entryOrder,
      simulatedOrderId: `${marks.entryOrder.executionPlanId}:g1:o0`,
      plannedOrderId: `${marks.entryOrder.executionPlanId}:g1:o0`,
      requestedShares: "10",
      filledShares: "0",
      state: "CANCELLED",
    };
    const rows = buildReconciliation({ ...artifact, orders: [...artifact.orders, sibling] });
    expect(rows.map((entry) => entry.id)).not.toContain(
      `exit.cancelled_proceeds.${sibling.simulatedOrderId}`,
    );
    // …and the rest of the table is the golden's.
    expect(rows).toEqual(artifact.reconciliation);
  });
});

describe("RECON-1 — the unfilled-order rule counts EMISSIONS, and every broken chain is refused", () => {
  /**
   * §9.8 check 18's duplicate guard remembers only the last 256 intent ids, so
   * an id can be emitted — and planned — twice in a long run. The rule counts
   * each untraced EMISSION `(runId, evaluationSeq, intentId)` as a possible
   * origin; counting ids would discard the second emission because the first
   * was traced, and refuse a table it can in fact attribute.
   */
  it("an exit id re-emitted by a later reduce decision is a second possible origin", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const decision: ArtifactDecision = { ...marks.reduce, evaluationSeq: 18 };
    const order = orderUnder(marks.exitOrder, planId("fd000"), {
      requestedShares: "50",
      filledShares: "0",
      state: "CANCELLED",
    });
    const rows = buildReconciliation({
      ...artifact,
      decisions: [...artifact.decisions, decision],
      orders: [...artifact.orders, order],
    });
    expect(rows.map((entry) => entry.id).filter((id) => id.startsWith("exit.cancelled_proceeds."))).toEqual([
      `exit.cancelled_proceeds.${marks.takeProfit.simulatedOrderId}`,
      `exit.cancelled_proceeds.${order.simulatedOrderId}`,
    ]);
  });

  /**
   * `RECON-1` r2 RELAXED one refusal, deliberately. The first commit refused an
   * artefact in which the entry's `intentId` also appeared in an exit or reduce
   * decision, because it classified traces by id and the fills would have
   * counted twice. Traces now resolve by EMISSION, so the entry's fills stay
   * the entry's — the trace names the enter decision's evaluation — and the
   * second emission of the id is just another untraced exit emission.
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
      name: "one plan traced to two intents",
      refusal: /is traced to two intents/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        traces: [
          ...artifact.traces,
          { ...marks.entryTrace, intentId: only(marks.reduce.intents, "reduce intent").intentId ?? "" },
        ],
      }),
    },
    {
      name: "a filled plan traced to an emission that is a CANCEL, which places no order",
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
      name: "one order id booked under the entry's plan and under an exit's",
      refusal: /is reached from the entry's chain AND from an exit's/u,
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
      name: "an untraced order that reports filled shares",
      refusal: /reports 10 filled shares, but no trace names its plan/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        orders: [
          ...artifact.orders,
          orderUnder(marks.exitOrder, planId("fe000"), { requestedShares: "10", filledShares: "10" }),
        ],
      }),
    },
    {
      name: "an unfilled order under a plan traced to a QUOTE",
      refusal: /neither the entry intent nor one an exit or reduce decision emitted/u,
      tamper: (artifact, marks) => {
        const quoteIntentId = `quote-4-${artifact.scenario.marketId}`;
        const order = orderUnder(marks.exitOrder, planId("fe000"), {
          requestedShares: "10",
          filledShares: "0",
          state: "CANCELLED",
        });
        const absentFill = fillOf(marks.exitFill, order, {});
        return {
          ...artifact,
          decisions: [
            ...artifact.decisions,
            {
              ...marks.exitDecision,
              evaluationSeq: 18,
              decisionType: "quote",
              intents: [
                { type: "QUOTE", intentId: quoteIntentId, marketId: artifact.scenario.marketId },
              ],
            },
          ],
          traces: [
            ...artifact.traces,
            traceOf(marks.entryTrace, quoteIntentId, 18, order, absentFill),
          ],
          orders: [...artifact.orders, order],
        };
      },
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
 * `RECON-1` r2 — the independent review's reproductions, each of which the
 * first two commits mis-reconciled SILENTLY: an explained row, no throw.
 */
describe("RECON-1 r2 — the review's silent mis-attributions are refused", () => {
  /**
   * Review R1, probe 1. An untraced BUY under a new plan is correctly refused
   * on its own — one untraced emission cannot have placed two plans. Appending
   * an exact COPY of the golden's exit decision then made the global candidate
   * count reach two, and the phantom was reported as a second withdrawn
   * take-profit: projected 3.3, `explained: true`. The copy carries no new
   * `(runId, evaluationSeq, intentId)`; it is a malformed artefact.
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
    expect(() => buildReconciliation(withPhantom)).toThrow(/no possible origin/u);

    const copy = JSON.parse(JSON.stringify(marks.exitDecision)) as ArtifactDecision;
    const copied = { ...withPhantom, decisions: [...withPhantom.decisions, copy] };
    expect(() => buildReconciliation(copied)).toThrow(
      /two persisted decisions share \(runId, evaluationSeq\)/u,
    );
  });

  /**
   * Review R1, probe 2, and its two neighbours. The withdrawn take-profit is
   * moved where its only candidate origin — the take-profit emission, in the
   * scenario market — could not have placed it. The global count still
   * matched, and the order was reported as an explained exit cancellation.
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
    it(`R1: an untraced order ${probe.name} has no possible origin`, () => {
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
      expect(() => buildReconciliation({ ...artifact, orders })).toThrow(/no possible origin/u);
    });
  }

  /**
   * Review R2. The filled emission at evaluation 9 becomes a QUOTE, a separate
   * `reduce` decision at evaluation 99 carries the SAME intent id, and the
   * fill's trace still names evaluation 9. Classified by id, the QUOTE's fill
   * was accepted as an exit and a cancelled sibling under the QUOTE's plan was
   * reported as an explained exit cancellation.
   */
  it("R2: a trace resolves by (runId, evaluationSeq, intentId), not by the id alone", () => {
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
      { ...marks.reduce, evaluationSeq: 99 },
    ];
    const sibling: ArtifactOrder = {
      ...marks.exitOrder,
      simulatedOrderId: `${marks.exitOrder.executionPlanId}:g1:o0`,
      plannedOrderId: `${marks.exitOrder.executionPlanId}:g1:o0`,
      requestedShares: "10",
      filledShares: "0",
      state: "CANCELLED",
    };
    const tampered = { ...artifact, decisions, orders: [...artifact.orders, sibling] };
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
    const fills = [{ ...lot, atEventIngestSeq: "05" }];
    expect(() => buildReconciliation({ ...artifact, fills })).toThrow(
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
 * Every module specifier a TypeScript source names, from its syntax tree — the
 * walk `test/contract/coinbase/isolation.test.ts` uses, plus `require(…)`. A
 * specifier that is not a string literal is reported as `<computed>`.
 */
function moduleSpecifiersIn(text: string): readonly string[] {
  const source = ts.createSourceFile("probe.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const literal = (node: ts.Node | undefined): string =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : "<computed>";
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) specifiers.push(literal(node.moduleSpecifier));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifiers.push(literal(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      specifiers.push(ts.isLiteralTypeNode(argument) ? literal(argument.literal) : "<computed>");
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push(literal(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return specifiers;
}

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
    const open = {
      ...artifact,
      fills: artifact.fills.filter((fill) => fill.simulatedFillId !== marks.exitFill.simulatedFillId),
    };
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
   * text inside comments and string data is inert.
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
      "<computed>",
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
