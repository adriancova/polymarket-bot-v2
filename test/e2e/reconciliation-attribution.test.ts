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

import { describe, expect, it } from "vitest";

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";

import type {
  ArtifactDecision,
  ArtifactFill,
  ArtifactIntent,
  ArtifactOrder,
  ArtifactTrace,
  PaperRunArtifact,
} from "./support/artifact.js";
import { goldenBytes } from "./support/golden.js";
import {
  buildReconciliation,
  compareFillIds,
  compareIngestSeq,
  type ReconciliationRow,
} from "./support/reconcile.js";

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
      name: "the entry's intent also emitted by a reduce decision",
      refusal: /emitted by the entry decision AND by an exit or reduce decision/u,
      tamper: (artifact, marks) => ({
        ...artifact,
        decisions: artifact.decisions.map((decision) =>
          decision.evaluationSeq === marks.reduce.evaluationSeq
            ? { ...decision, intents: [...decision.intents, marks.entryIntent] }
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
 * FIFO over the lots in the order GIVEN — the fold `RISK2-R4` described. Used
 * only to prove a permutation genuinely changes the answer, so the invariance
 * asserted against the reconciler is not vacuous.
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

describe("RISK2-R4 — the FIFO fold follows atEventIngestSeq, not array order", () => {
  it("a partial exit's open cost basis is the same for EVERY order the fills are written in", () => {
    const partial = withPartialExit(golden());
    const marks = landmarks(partial);
    // Non-vacuous: the two entry lots have DIFFERENT prices (30 @ 0.34, 20 @
    // 0.35), so a fold in array order gives two different answers.
    expect(marks.entryFills.map((fill) => `${fill.shares}@${fill.price}`)).toEqual([
      "30@0.34",
      "20@0.35",
    ]);
    expect(
      [...new Set(permutations(marks.entryFills).map((lots) => fifoInGivenOrder(lots, "25")))].sort(),
    ).toEqual(["8.5", "8.7"]);

    // Both lots were consumed at the same event, so the fill id breaks the tie:
    // `…/t0/0` (the 0.34 level, walked first) is retired first, leaving
    // 5 × 0.34 + 20 × 0.35 = 8.7 open — whatever order the array holds.
    const orders = permutations(partial.fills);
    expect(orders).toHaveLength(6);
    for (const fills of orders) {
      const basis = openBasis({ ...partial, fills });
      expect(basis.capital).toBe("8.7");
      // realizedPnl − Σ open cost basis, against the golden snapshot's −1.2.
      expect(basis.worstCase).toBe("-9.9");
    }
  });

  it("the sequence is compared as an INTEGER: event 9 is consumed before event 10", () => {
    const partial = withPartialExit(golden());
    const marks = landmarks(partial);
    const [first, second] = marks.entryFills;
    if (first === undefined || second === undefined) throw new Error("two entry lots expected");
    // The 0.34 lot at event "10", the 0.35 lot at event "9". Compared as text,
    // "10" sorts before "9" and the 0.34 lot would be retired first (8.7).
    // Compared as integers the 0.35 lot is first: 25 × 0.34 = 8.5 stays open.
    const resequenced = partial.fills.map((fill) =>
      fill.simulatedFillId === first.simulatedFillId
        ? { ...fill, atEventIngestSeq: "10" }
        : fill.simulatedFillId === second.simulatedFillId
          ? { ...fill, atEventIngestSeq: "9" }
          : fill,
    );
    for (const fills of permutations(resequenced)) {
      expect(openBasis({ ...partial, fills }).capital).toBe("8.5");
    }
  });

  it("inside one event, the fill index is compared as an INTEGER: …/t0/9 before …/t0/10", () => {
    const partial = withPartialExit(golden());
    const marks = landmarks(partial);
    const [first, second] = marks.entryFills;
    if (first === undefined || second === undefined) throw new Error("two entry lots expected");
    // The ids a crossing of eleven levels produces. As text, "…/t0/10" sorts
    // before "…/t0/9"; by index, level 9 (the 0.34 lot) was walked first.
    const order = marks.entryOrder.simulatedOrderId;
    const renamed = partial.fills.map((fill) =>
      fill.simulatedFillId === first.simulatedFillId
        ? { ...fill, simulatedFillId: `${order}/t0/9` }
        : fill.simulatedFillId === second.simulatedFillId
          ? { ...fill, simulatedFillId: `${order}/t0/10` }
          : fill,
    );
    for (const fills of permutations(renamed)) {
      expect(openBasis({ ...partial, fills }).capital).toBe("8.7");
    }
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
 * A `RECON-1` FINDING, PINNED — reported, NOT fixed in this round.
 *
 * The fold above is FIFO. The PnL snapshot the two rows compare against is
 * `packages/pnl`'s, and `packages/pnl/src/state.ts` documents "Cost method:
 * average cost per token asset": removing q of Q shares removes B·q/Q of the
 * lot's basis. The two methods agree EXACTLY in the two states any run has
 * reached, and diverge on a partial exit whenever the entry lots differ in
 * price. The divergence is LOUD — the row compares with `EXACT_NO_DIFFERENCE`,
 * so it is unexplained rather than falsely passed — but it means a correct run
 * with a partial exit would fail acceptance 2 for a modelling reason. The day
 * the reconciler's model is aligned with the engine's, this test fails and
 * names the finding.
 */
describe("RECON-1 finding — the reconciler's FIFO is not packages/pnl's average cost", () => {
  it("they agree fully open and fully closed, and diverge on this partial exit", () => {
    const artifact = golden();
    const marks = landmarks(artifact);
    const notional = marks.entryFills.reduce(
      (total, fill) => addDecimal(total, mulDecimal(fill.price, fill.shares)),
      "0",
    );
    expect(notional).toBe("17.2");

    // Fully CLOSED — the golden: both methods leave nothing open.
    expect(openBasis(artifact).capital).toBe("0");
    // Fully OPEN — the exit fill removed: both leave the whole notional open.
    const open = {
      ...artifact,
      fills: artifact.fills.filter((fill) => fill.simulatedFillId !== marks.exitFill.simulatedFillId),
    };
    expect(openBasis(open).capital).toBe(notional);

    // PARTIAL — 25 of 50 retired. Average cost leaves B − B·25/50 = B × 0.5.
    const averageCost = subDecimal(notional, mulDecimal(notional, "0.5"));
    expect(averageCost).toBe("8.6");
    const fifo = openBasis(withPartialExit(artifact)).capital;
    expect(fifo).toBe("8.7");
    expect(fifo).not.toBe(averageCost);
  });
});
