/**
 * `BRACKET-1b` — the TWO-BRACKET run, its reconciliation, its chains, and the
 * two ride-alongs (`N1`, `SIM2-E2E-MSG`).
 *
 * The scenario is `support/scenarios/two-brackets.ts` and its golden is
 * `test/replay-golden/paper-e2e/two-brackets-run.json`, whose README section
 * derives every number below by hand. Evidence class: SIMULATED
 * (`SIMULATED_NOT_REAL_EVIDENCE`); no soak, execution probe or live gate is
 * claimed, and handoff §7 item 1 is NOT claimed closed (ruling R1: `BRACKET-1c`
 * and a fresh closeout follow).
 *
 * | Block | Packet item |
 * | --- | --- |
 * | the run, as specified | E2 / acceptance 2 |
 * | the reconciliation, and its refusals | E3 / acceptance 3 |
 * | the loop-originated chain | E4 / acceptance 4 (`RECON2-EVENTHOP`) |
 * | a fee posting exactly when the fee is not zero | E4 / acceptance 5 |
 * | the `pnlRecords` counter | ride-along `N1` |
 * | an evicted venue history | ride-along `SIM2-E2E-MSG` |
 *
 * Every tamper works on a FRESH deep copy of a committed golden, changed in one
 * deliberate way, so a mutation cannot leak between tests.
 */

import { describe, expect, it } from "vitest";

import { addDecimal, compareDecimal, subDecimal } from "@polymarket-bot/decimal";
import { foldPnlRecords, type PnlRecord } from "@polymarket-bot/pnl";

import {
  captureArtifact,
  serializeArtifact,
  type ArtifactDecision,
  type ArtifactFill,
  type ArtifactPnlRecord,
  type ArtifactTrace,
  type PaperRunArtifact,
} from "./support/artifact.js";
import { explainWalk, walkChains } from "./support/chain-walk.js";
import { goldenBytes } from "./support/golden.js";
import { driveScenario } from "./support/harness.js";
import {
  buildReconciliation,
  unexplainedRows,
  type ReconciliationRow,
} from "./support/reconcile.js";
import { PAPER_E2E_SCENARIO, traderConfig } from "./support/scenario.js";
import {
  MAXIMUM_ENTRIES_PER_MARKET,
  TWO_BRACKETS_SCENARIO,
  twoBracketsTraderConfig,
} from "./support/scenarios/two-brackets.js";

// --- documents ---------------------------------------------------------------

/** A fresh deep copy of the committed two-bracket golden. */
function twoBrackets(): PaperRunArtifact {
  return JSON.parse(goldenBytes(TWO_BRACKETS_SCENARIO)) as PaperRunArtifact;
}

/** A fresh deep copy of the committed original (one-bracket) golden. */
function paperE2e(): PaperRunArtifact {
  return JSON.parse(goldenBytes(PAPER_E2E_SCENARIO)) as PaperRunArtifact;
}

/** The two-bracket run's own bytes, parsed back — what the golden was captured from. */
async function producedTwoBrackets(): Promise<PaperRunArtifact> {
  const artifact = captureArtifact(await driveScenario({ scenario: TWO_BRACKETS_SCENARIO }));
  return JSON.parse(serializeArtifact(artifact)) as PaperRunArtifact;
}

function only<T>(values: readonly T[], what: string): T {
  const [value] = values;
  if (value === undefined || values.length !== 1) {
    throw new Error(`expected exactly one ${what}; found ${String(values.length)}`);
  }
  return value;
}

function row(rows: readonly ReconciliationRow[], id: string): ReconciliationRow {
  const found = rows.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`the table has no row ${id}`);
  return found;
}

function decisionAt(artifact: PaperRunArtifact, evaluationSeq: number): ArtifactDecision {
  return only(
    artifact.decisions.filter((decision) => decision.evaluationSeq === evaluationSeq),
    `decision at evaluationSeq ${String(evaluationSeq)}`,
  );
}

function withCode(artifact: PaperRunArtifact, code: string): readonly ArtifactDecision[] {
  return artifact.decisions.filter((decision) => decision.reasonCodes.includes(code));
}

function eventIdAt(artifact: PaperRunArtifact, ingestSeq: string): string {
  return only(
    artifact.events.filter((event) => event.ingestSeq === ingestSeq),
    `event ${ingestSeq}`,
  ).eventId;
}

function secondsBetween(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / 1000;
}

/** The order a decision's single order-placing intent placed, through its provenance record. */
function orderPlacedBy(
  artifact: PaperRunArtifact,
  decision: ArtifactDecision,
): { readonly orderId: string; readonly sourceEventId: string } {
  const record = only(
    artifact.orderProvenance.filter(
      (candidate) =>
        candidate.runId === decision.runId && candidate.evaluationSeq === decision.evaluationSeq,
    ),
    `provenance record of the decision at evaluationSeq ${String(decision.evaluationSeq)}`,
  );
  return { orderId: record.venueOrderId, sourceEventId: record.sourceEventId };
}

function fillsOfOrder(artifact: PaperRunArtifact, orderId: string): readonly ArtifactFill[] {
  return artifact.fills.filter((fill) => fill.simulatedOrderId === orderId);
}

interface Landmarks {
  readonly enter1: ArtifactDecision;
  readonly enter2: ArtifactDecision;
  readonly takeProfit1: ArtifactDecision;
  readonly takeProfit2: ArtifactDecision;
  readonly withdraw: ArtifactDecision;
  readonly reduce: ArtifactDecision;
  readonly rearmed: ArtifactDecision;
  readonly closes: readonly ArtifactDecision[];
}

/** The decisions of the run that matter, found by what the strategy wrote. */
function landmarks(artifact: PaperRunArtifact): Landmarks {
  const enters = artifact.decisions.filter((decision) => decision.decisionType === "enter");
  const exits = artifact.decisions.filter((decision) => decision.decisionType === "exit");
  const [enter1, enter2] = enters;
  const [takeProfit1, takeProfit2] = exits;
  if (enters.length !== 2 || enter1 === undefined || enter2 === undefined) {
    throw new Error(`two enter decisions expected, found ${String(enters.length)}`);
  }
  if (exits.length !== 2 || takeProfit1 === undefined || takeProfit2 === undefined) {
    throw new Error(`two take-profit decisions expected, found ${String(exits.length)}`);
  }
  return {
    enter1,
    enter2,
    takeProfit1,
    takeProfit2,
    withdraw: only(
      artifact.decisions.filter((decision) => decision.decisionType === "cancel"),
      "cancel decision",
    ),
    reduce: only(
      artifact.decisions.filter((decision) => decision.decisionType === "reduce"),
      "reduce decision",
    ),
    rearmed: only(withCode(artifact, "SB.REARMED"), "SB.REARMED decision"),
    closes: withCode(artifact, "SB.CLOSED"),
  };
}

/** `text` as a literal inside a regular expression. */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The one chain (trace) of `fill`. */
function chainOf(artifact: PaperRunArtifact, fill: ArtifactFill): ArtifactTrace {
  return only(
    artifact.traces.filter((trace) => trace.venueFillId === fill.simulatedFillId),
    `chain of fill ${fill.simulatedFillId}`,
  );
}

/** `fill`'s §9.16 TRADE record: the one following from a transaction its chain names. */
function tradeRecordOf(artifact: PaperRunArtifact, fill: ArtifactFill): ArtifactPnlRecord {
  const posted = chainOf(artifact, fill).ledgerTransactionIds;
  return only(
    artifact.pnlRecords.filter((record) => record.kind === "TRADE" && posted.includes(record.ref)),
    `TRADE record of fill ${fill.simulatedFillId}`,
  );
}

/** The one fill of the order `decision` placed. */
function fillPlacedBy(artifact: PaperRunArtifact, decision: ArtifactDecision): ArtifactFill {
  return only(
    fillsOfOrder(artifact, orderPlacedBy(artifact, decision).orderId),
    `fill of the order placed at evaluationSeq ${String(decision.evaluationSeq)}`,
  );
}

/** The document with one fill, and optionally its order, changed. */
function withTrade(
  artifact: PaperRunArtifact,
  fill: ArtifactFill,
  fillChange: Partial<ArtifactFill>,
  orderChange?: Partial<PaperRunArtifact["orders"][number]>,
): PaperRunArtifact {
  return {
    ...artifact,
    fills: artifact.fills.map((candidate) =>
      candidate.simulatedFillId === fill.simulatedFillId ? { ...candidate, ...fillChange } : candidate,
    ),
    orders: artifact.orders.map((order) =>
      order.simulatedOrderId === fill.simulatedOrderId && orderChange !== undefined
        ? { ...order, ...orderChange }
        : order,
    ),
  };
}

/** The document with the §9.16 records whose ref is `ref` changed (or removed, with `null`). */
function withRecord(
  artifact: PaperRunArtifact,
  ref: string,
  change: Partial<ArtifactPnlRecord> | null,
): PaperRunArtifact {
  return {
    ...artifact,
    pnlRecords: artifact.pnlRecords.flatMap((record) =>
      record.ref !== ref ? [record] : change === null ? [] : [{ ...record, ...change }],
    ),
  };
}

/**
 * What `packages/pnl` ITSELF does with a stream (test side only; the oracle
 * never calls it): the fold's refusal codes, or the position and realized PnL
 * it leaves.
 */
function engineFold(
  artifact: PaperRunArtifact,
  records: readonly PnlRecord[],
):
  | { readonly ok: false; readonly codes: readonly string[] }
  | {
      readonly ok: true;
      readonly lots: readonly (readonly [string, string, string])[];
      readonly realized: readonly string[];
    } {
  const scenario = artifact.scenario;
  const folded = foldPnlRecords(
    {
      scope: "VIRTUAL_STRATEGY",
      environment: "PAPER",
      accountRef: scenario.accountRef,
      instanceId: scenario.instanceId,
      runId: scenario.runId,
      marketId: scenario.marketId,
    },
    records,
  );
  if (!folded.ok) return { ok: false, codes: folded.refusals.map((refusal) => refusal.code) };
  return {
    ok: true,
    lots: [...folded.value.lots].map(([token, lot]) => [token, lot.shares, lot.costBasis] as const),
    realized: [...folded.value.realizedTrading.values()],
  };
}

/**
 * `packages/pnl`'s fold of `records` IN THE ORDER GIVEN (test side only),
 * with its refusal messages and the fees it paid — what {@link engineFold}
 * leaves out (`BRACKET-1b` r2).
 */
function engineState(
  artifact: PaperRunArtifact,
  records: readonly unknown[],
):
  | { readonly ok: false; readonly codes: readonly string[]; readonly messages: readonly string[] }
  | {
      readonly ok: true;
      readonly lots: readonly (readonly [string, string, string])[];
      readonly realized: readonly string[];
      readonly fees: readonly string[];
    } {
  const scenario = artifact.scenario;
  const folded = foldPnlRecords(
    {
      scope: "VIRTUAL_STRATEGY",
      environment: "PAPER",
      accountRef: scenario.accountRef,
      instanceId: scenario.instanceId,
      runId: scenario.runId,
      marketId: scenario.marketId,
    },
    records,
  );
  if (!folded.ok) {
    return {
      ok: false,
      codes: folded.refusals.map((refusal) => refusal.code),
      messages: folded.refusals.map((refusal) => refusal.message),
    };
  }
  return {
    ok: true,
    lots: [...folded.value.lots].map(([token, lot]) => [token, lot.shares, lot.costBasis] as const),
    realized: [...folded.value.realizedTrading.values()],
    fees: [...folded.value.feesPaid.values()],
  };
}

/** A copy of `list` with the entries at `left` and `right` exchanged. */
function swapped<T>(list: readonly T[], left: number, right: number): T[] {
  const copy = [...list];
  const a = copy[left];
  const b = copy[right];
  if (a === undefined || b === undefined) {
    throw new Error(`no entry at ${String(left)} or ${String(right)}`);
  }
  copy[left] = b;
  copy[right] = a;
  return copy;
}

/** The document with one decision replaced. */
function withDecision(
  artifact: PaperRunArtifact,
  evaluationSeq: number,
  change: (decision: ArtifactDecision) => ArtifactDecision,
): PaperRunArtifact {
  return {
    ...artifact,
    decisions: artifact.decisions.map((decision) =>
      decision.evaluationSeq === evaluationSeq ? change(decision) : decision,
    ),
  };
}

// =============================================================================

describe("BRACKET-1b E2 — the two-bracket run, as the scenario specifies it", () => {
  it("the ONE configuration delta is reentry.maximum_entries_per_market 2 (cooldown 30 kept)", () => {
    const original = traderConfig();
    const delta = twoBracketsTraderConfig();
    const reentry = (document: Record<string, unknown>): Record<string, unknown> => {
      const [instance] = document["instances"] as Record<string, unknown>[];
      const params = instance?.["params"] as Record<string, unknown>;
      return params["reentry"] as Record<string, unknown>;
    };
    expect(reentry(original)).toEqual({ maximum_entries_per_market: 1, cooldown_seconds: 30 });
    expect(reentry(delta)).toEqual({
      maximum_entries_per_market: MAXIMUM_ENTRIES_PER_MARKET,
      cooldown_seconds: 30,
    });
    expect(MAXIMUM_ENTRIES_PER_MARKET).toBe(2);
    // Everything else is the original document, value for value.
    const erase = (document: Record<string, unknown>): string => {
      const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
      for (const instance of copy["instances"] as Record<string, unknown>[]) {
        const params = instance["params"] as Record<string, unknown>;
        delete (params["reentry"] as Record<string, unknown>)["maximum_entries_per_market"];
      }
      return JSON.stringify(copy);
    };
    expect(erase(delta)).toBe(erase(original));
    expect(erase(twoBracketsTraderConfig({ withShadow: true }))).toBe(
      erase(traderConfig({ withShadow: true })),
    );
    // …and the scenario section differs from the original golden's in the id seed only.
    const { idNamespace: ownSeed, ...own } = twoBrackets().scenario;
    const { idNamespace: originalSeed, ...theirs } = paperE2e().scenario;
    expect(own).toEqual(theirs);
    expect(ownSeed).not.toBe(originalSeed);
  });

  it("bracket 1 is closed by a NON-cutoff protective reduction, its take-profit withdrawn first", async () => {
    const artifact = await producedTwoBrackets();
    const marks = landmarks(artifact);
    // The take-profit rests from the entry's onFill…
    const takeProfit1 = orderPlacedBy(artifact, marks.takeProfit1);
    // …and the HOLDING TIMEOUT (not the close cutoff) withdraws it first.
    expect(marks.withdraw.reasonCodes).toEqual(["SB.HOLDING_TIMEOUT", "SB.SAFETY_CANCEL"]);
    expect(marks.withdraw.intents.map((intent) => intent.type)).toEqual(["CANCEL"]);
    const canceledView = decisionAt(artifact, marks.withdraw.evaluationSeq + 1);
    expect(canceledView.callback).toBe("onOrderUpdate");
    expect(canceledView.reasonCodes).toEqual(["SB.EXIT_ORDER_WORKING", "SB.EXIT_ORDER_TERMINAL"]);
    const withdrawn = only(
      artifact.orders.filter((order) => order.simulatedOrderId === takeProfit1.orderId),
      "take-profit 1",
    );
    expect([withdrawn.state, withdrawn.filledShares]).toEqual(["CANCELLED", "0"]);
    // The reduction: SB.PROTECTED_REDUCE, a non-cutoff cause, planned only after
    // the CANCELED view arrived.
    expect(marks.reduce.evaluationSeq).toBeGreaterThan(canceledView.evaluationSeq);
    expect(marks.reduce.reasonCodes).toEqual([
      "SB.HOLDING_TIMEOUT",
      "SB.EXIT_SIZED_TO_ALLOCATION",
      "SB.PROTECTED_REDUCE",
    ]);
    expect(marks.reduce.reasonCodes).not.toContain("SB.EXIT_CUTOFF");
    expect(marks.reduce.reasonCodes).not.toContain("SB.FINAL_PROTECTED_REDUCE");
    expect(marks.reduce.modelOutputs["reduceCause"]).toBe("maximum holding time");
    expect(
      secondsBetween(marks.enter1.evaluatedAt, marks.reduce.evaluatedAt),
    ).toBeGreaterThanOrEqual(180);
    // It crossed the bids and filled; its own onFill closes the bracket.
    const reduction = orderPlacedBy(artifact, marks.reduce);
    const [sale, ...more] = fillsOfOrder(artifact, reduction.orderId);
    expect(more).toEqual([]);
    expect([sale?.action, sale?.shares, sale?.price, sale?.liquidityRole]).toEqual([
      "SELL",
      "50",
      "0.32",
      "TAKER",
    ]);
    const closing = decisionAt(artifact, marks.reduce.evaluationSeq + 1);
    expect([closing.callback, closing.reasonCodes]).toEqual([
      "onFill",
      ["SB.EXIT_FILLED", "SB.CLOSED"],
    ]);
  });

  it("SB.REARMED follows the 30 s cooldown, and bracket 2 enters well before both entry cutoffs", async () => {
    const artifact = await producedTwoBrackets();
    const marks = landmarks(artifact);
    const [close1] = marks.closes;
    expect(marks.closes).toHaveLength(2);
    if (close1 === undefined) return;
    expect(close1.evaluationSeq).toBe(marks.reduce.evaluationSeq + 1);
    expect(marks.rearmed.reasonCodes).toEqual(["SB.REARMED"]);
    expect(marks.rearmed.callback).toBe("onFeatures");
    expect(marks.rearmed.evaluationSeq).toBeGreaterThan(close1.evaluationSeq);
    expect(
      secondsBetween(close1.evaluatedAt, marks.rearmed.evaluatedAt),
    ).toBeGreaterThanOrEqual(30);
    // The very next evaluation enters bracket 2.
    expect(marks.enter2.evaluationSeq).toBe(marks.rearmed.evaluationSeq + 1);
    // More than 45 s (strategy) and 30 s (risk) before the 09:15:00 close.
    expect(secondsBetween(marks.enter2.evaluatedAt, "2026-05-01T09:15:00Z")).toBeGreaterThan(45);
    expect(marks.enter2.modelOutputs).toEqual({
      entryCost: "16.5",
      expectedNetEdge: "8.4",
      trigger: "0.33",
      worstPrice: "0.33",
    });
  });

  it("bracket 2's take-profit is placed FROM onFill (sourceEventId \"\") and FILLED as a MAKER at fee 0", async () => {
    const artifact = await producedTwoBrackets();
    const marks = landmarks(artifact);
    expect(marks.takeProfit2.callback).toBe("onFill");
    expect(marks.takeProfit2.sourceEventId).toBeNull();
    expect(marks.takeProfit2.evaluationSeq).toBeGreaterThan(marks.enter2.evaluationSeq);
    const placed = orderPlacedBy(artifact, marks.takeProfit2);
    // The loop's own record of an evaluation it originated.
    expect(placed.sourceEventId).toBe("");
    const order = only(
      artifact.orders.filter((candidate) => candidate.simulatedOrderId === placed.orderId),
      "take-profit 2",
    );
    expect([order.state, order.executionStyle, order.postOnly, order.limitPrice]).toEqual([
      "FILLED",
      "REST",
      true,
      "0.5",
    ]);
    const fill = only(fillsOfOrder(artifact, placed.orderId), "take-profit 2 fill");
    expect([fill.liquidityRole, fill.feeAmount, fill.shares, fill.price]).toEqual([
      "MAKER",
      "0",
      "50",
      "0.5",
    ]);
    expect(artifact.scenario.feeSchedule.makerFeeRate).toBe("0");
    // The public trade that filled it, and the close it made.
    const trade = only(
      artifact.events.filter((event) => event.eventType === "PublicTradeObserved"),
      "public trade",
    );
    expect(fill.atEventIngestSeq).toBe(trade.ingestSeq);
    const [, close2] = marks.closes;
    expect(close2?.callback).toBe("onFill");
    expect(close2?.reasonCodes).toEqual(["SB.EXIT_FILLED", "SB.CLOSED"]);
  });

  it("the run ends REFUSED_MAXIMUM_ENTRIES with no pause, no unattributed fill, no halt, and clean books", async () => {
    const run = await driveScenario({ scenario: TWO_BRACKETS_SCENARIO });
    const artifact = captureArtifact(run);
    expect(artifact.decisions.at(-1)?.reasonCodes).toEqual(["SB.REFUSED_MAXIMUM_ENTRIES"]);
    const everyCode = artifact.decisions.flatMap((decision) => decision.reasonCodes);
    for (const forbidden of [
      "SB.PAUSED",
      "SB.UNATTRIBUTED_FILL",
      "SB.POSITION_MISMATCH",
      "SB.NO_BLIND_FLATTEN",
      "SB.ILLEGAL_TRANSITION",
      "SB.HALTED",
    ]) {
      expect(everyCode).not.toContain(forbidden);
    }
    const health = run.trader.loop.health();
    expect(health.halts).toEqual([]);
    expect(health.healthy).toBe(true);
    expect(health.accounting.unattributedActivity).toBe(0);
    expect(health.accounting.unexplainedMovements).toBe(0);
    expect(artifact.ledgerProjection.unattributedActivity).toBe(0);
    expect(artifact.pnlRecords.length).toBeGreaterThan(0);
    for (const record of artifact.pnlRecords) {
      expect(record.scope).toBe("VIRTUAL_STRATEGY");
      expect(record.instanceId).toBe(artifact.scenario.instanceId);
    }
    // Two entries executed, two brackets closed, and the instance is flat.
    expect(withCode(artifact, "SB.ENTRY_INTENT_EMITTED")).toHaveLength(2);
    expect(withCode(artifact, "SB.CLOSED")).toHaveLength(2);
    expect(
      artifact.ledgerProjection.virtualPositions.filter(
        (line) => line.assetKind === "OUTCOME_TOKEN",
      ),
    ).toEqual([]);
  });

  it("BRACKET1-TPRACE is unreachable here: each take-profit is placed ONCE, at the whole allocation, never resized", async () => {
    const artifact = await producedTwoBrackets();
    const marks = landmarks(artifact);
    for (const takeProfit of [marks.takeProfit1, marks.takeProfit2]) {
      const intent = only(takeProfit.intents, "take-profit intent");
      expect(intent.targetShares).toBe("-50");
      expect(takeProfit.modelOutputs["allocatedShares"]).toBe("50");
    }
    expect(withCode(artifact, "SB.TAKE_PROFIT_REPLACED")).toEqual([]);
    for (const enter of [marks.enter1, marks.enter2]) {
      expect(fillsOfOrder(artifact, orderPlacedBy(artifact, enter).orderId)).toHaveLength(1);
    }
  });
});

// =============================================================================

describe("BRACKET-1b E3 — the two-bracket reconciliation", () => {
  it("every row is explained, and the golden's table is rebuilt from its own bytes", async () => {
    const golden = twoBrackets();
    expect(buildReconciliation(golden)).toEqual(golden.reconciliation);
    expect((await producedTwoBrackets()).reconciliation).toEqual(golden.reconciliation);
    expect(unexplainedRows(golden.reconciliation).map((entry) => entry.id)).toEqual([]);
    for (const entry of golden.reconciliation) {
      if (entry.realized !== null) expect(entry.residual).toBe("0");
    }
    expect(golden.reconciliation).toHaveLength(31);
  });

  it("brackets are delimited by the strategy's own SB.REARMED, and the instance is flat at the boundary", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const boundary = only(
      golden.events.filter((event) => event.eventId === marks.rearmed.sourceEventId),
      "the boundary's event",
    ).ingestSeq;
    // By hand, over the fills consumed before the boundary: +50 − 50.
    const before = golden.fills.filter(
      (fill) => compareDecimal(fill.atEventIngestSeq, boundary) < 0,
    );
    expect(before.map((fill) => `${fill.action} ${fill.shares}`)).toEqual(["BUY 50", "SELL 50"]);
    const position = before.reduce(
      (held, fill) =>
        fill.action === "BUY" ? addDecimal(held, fill.shares) : subDecimal(held, fill.shares),
      "0",
    );
    expect(position).toBe("0");
    // Every per-bracket row is qualified; the cumulative ones are not.
    const ids = golden.reconciliation.map((entry) => entry.id);
    const prefixes = new Set(
      ids.map((id) => (id.startsWith("bracket.") ? id.split(".").slice(0, 2).join(".") : "run")),
    );
    expect([...prefixes]).toEqual(["bracket.1", "bracket.2", "run"]);
    expect(ids.filter((id) => !id.startsWith("bracket."))).toEqual([
      "ledger.virtual_cash_delta",
      "ledger.virtual_token_balance",
      "pnl.fees_paid",
      "pnl.capital_committed",
      "pnl.gross_trading",
      "pnl.core_net",
      "pnl.worst_case_resolution",
      "pnl.realized",
    ]);
  });

  it("per-bracket entry and exit rows, each from ITS bracket's decision and fills", () => {
    const rows = twoBrackets().reconciliation;
    for (const [bracket, cost, edge, realized] of [
      ["1", "17", "7.9", "-1.431"],
      ["2", "16.5", "8.4", "8.284"],
    ] as const) {
      expect(row(rows, `bracket.${bracket}.entry.projected_cost`).projected).toBe(cost);
      expect(row(rows, `bracket.${bracket}.entry.projected_cost`).realized).toBe(cost);
      expect(row(rows, `bracket.${bracket}.entry.shares`).realized).toBe("50");
      const exit = row(rows, `bracket.${bracket}.exit.expected_net_edge`);
      expect([exit.projected, exit.realized, exit.residual, exit.explained]).toEqual([
        edge,
        realized,
        "0",
        true,
      ]);
    }
    // Bracket 1 exited by the protective reduction, below the take-profit…
    const exit1 = row(rows, "bracket.1.exit.expected_net_edge");
    expect(exit1.contributions[0]).toMatchObject({
      mechanism: "EXIT_BELOW_TAKE_PROFIT",
      amount: "-9",
    });
    expect(exit1.contributions[0]?.note).toContain("the protective reduction realized 16");
    // …bracket 2 by its take-profit, AT it.
    const exit2 = row(rows, "bracket.2.exit.expected_net_edge");
    expect(exit2.contributions[0]).toMatchObject({
      mechanism: "EXIT_BELOW_TAKE_PROFIT",
      amount: "0",
    });
    expect(exit2.contributions[0]?.note).toContain("the take-profit realized 25");
    // The withdrawn take-profit is bracket 1's, and only bracket 1's.
    const cancelled = rows.filter((entry) => entry.id.includes(".exit.cancelled_proceeds."));
    expect(cancelled.map((entry) => entry.id.split(".exit.")[0])).toEqual(["bracket.1"]);
    // The MAKER fill's fee is recomputed at the maker rate, 0.
    const makerFee = only(
      rows.filter((entry) => entry.id.startsWith("bracket.2.fee.fill.") && entry.realized === "0"),
      "maker fee row",
    );
    expect(makerFee.projectedSource).toContain("shares × 0 × price");
    expect(makerFee.projected).toBe("0");
  });

  it("the per-bracket realized PnL sums to the cumulative row, which is the engine's own snapshot", () => {
    const golden = twoBrackets();
    const rows = golden.reconciliation;
    const bracket1 = row(rows, "bracket.1.pnl.realized");
    const bracket2 = row(rows, "bracket.2.pnl.realized");
    expect([bracket1.projected, bracket1.realized]).toEqual(["-1", "-1"]);
    expect([bracket2.projected, bracket2.realized]).toEqual(["8.5", "8.5"]);
    const cumulative = row(rows, "pnl.realized");
    expect(cumulative.projected).toBe(addDecimal(bracket1.projected, bracket2.projected));
    expect(cumulative.realized).toBe(String(golden.pnlSnapshots.at(-1)?.["realizedPnl"]));
    expect(cumulative.realized).toBe("7.5");
    expect(cumulative.explained).toBe(true);
  });

  it("the realized rows can FAIL, from each of their three sources", () => {
    // A §9.16 trade record that disagrees with its fill (bracket 2's take-profit
    // booked at 0.49): the bracket's two sources part.
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const takeProfitFill = only(
      fillsOfOrder(golden, orderPlacedBy(golden, marks.takeProfit2).orderId),
      "take-profit 2 fill",
    );
    const posted = only(
      golden.traces.filter((trace) => trace.venueFillId === takeProfitFill.simulatedFillId),
      "take-profit 2 chain",
    ).ledgerTransactionIds;
    const repriced = golden.pnlRecords.map((record) =>
      record.kind === "TRADE" && posted.includes(record.ref) ? { ...record, price: "0.49" } : record,
    );
    const wrongRecord = buildReconciliation({ ...golden, pnlRecords: repriced });
    expect(row(wrongRecord, "bracket.2.pnl.realized").explained).toBe(false);
    expect(row(wrongRecord, "bracket.1.pnl.realized").explained).toBe(true);
    // A snapshot that disagrees with the per-bracket sum.
    const snapshots = golden.pnlSnapshots.map((snapshot, index, all) =>
      index === all.length - 1 ? { ...snapshot, realizedPnl: "7.4" } : snapshot,
    );
    const wrongSnapshot = buildReconciliation({ ...golden, pnlSnapshots: snapshots });
    expect(row(wrongSnapshot, "pnl.realized").explained).toBe(false);
    expect(row(wrongSnapshot, "pnl.realized").difference).toBe("-0.1");
    // A trade record no chain posted cannot be placed in a bracket: refused.
    const orphan = golden.pnlRecords.map((record) =>
      record.kind === "TRADE" && posted.includes(record.ref)
        ? { ...record, ref: "e44bcb0f-e44b-7000-8000-00000000dead" }
        : record,
    );
    expect(() => buildReconciliation({ ...golden, pnlRecords: orphan })).toThrow(
      /follows from a transaction no chain in this document posted/u,
    );
  });

  // --- the refusals, each by name -------------------------------------------

  it("two `enter` decisions inside ONE bracket are still refused (bracket 2 here)", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const extra: ArtifactDecision = { ...marks.enter2, evaluationSeq: 99 };
    const tampered = { ...golden, decisions: [...golden.decisions, extra] };
    expect(() => buildReconciliation(tampered)).toThrow(
      /bracket 2 \(opened by the `SB\.REARMED` decision at evaluationSeq 10\) holds 2 `enter` decisions \(evaluationSeq 11, 99\) with no `SB\.REARMED` between them/u,
    );
    expect(() => buildReconciliation(tampered)).toThrow(/instead of reading only the first/u);
  });

  it("a bracket whose entry emits two order-placing intents is still refused, naming the bracket", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const [intent] = marks.enter2.intents;
    if (intent === undefined) throw new Error("bracket 2's entry has no intent");
    const tampered = withDecision(golden, marks.enter2.evaluationSeq, (decision) => ({
      ...decision,
      intents: [
        ...decision.intents,
        { ...intent, intentId: `sb-entry-9-${golden.scenario.marketId}` },
      ],
    }));
    expect(() => buildReconciliation(tampered)).toThrow(
      /bracket 2 \(opened by the `SB\.REARMED` decision at evaluationSeq 10\): the entry decision \(evaluationSeq 11\) emitted 2 order-placing intents/u,
    );
  });

  it("a bracket with no `enter` at all is refused", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const tampered = withDecision(golden, marks.enter2.evaluationSeq, (decision) => ({
      ...decision,
      decisionType: "hold",
    }));
    expect(() => buildReconciliation(tampered)).toThrow(
      /bracket 2 .*the bracket holds no `enter` decision/u,
    );
  });

  it("a boundary where the fold is NOT flat is refused (the reduction sold 40 of 50)", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const reduction = orderPlacedBy(golden, marks.reduce).orderId;
    const tampered: PaperRunArtifact = {
      ...golden,
      fills: golden.fills.map((fill) =>
        fill.simulatedOrderId === reduction ? { ...fill, shares: "40", feeAmount: "0.17" } : fill,
      ),
    };
    // Non-vacuous: every id-level check still passes; only the position is wrong.
    expect(() => buildReconciliation(tampered)).toThrow(
      /the instance is not flat at the boundary the `SB\.REARMED` at evaluationSeq 10 marks .*still holds 10 shares of token 9001/u,
    );
  });

  it("a boundary placed BEFORE a fill of the bracket it closes is refused, and so is the reverse", () => {
    // The re-arm moved to event 6 — before the reduction's fill at event 7.
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const moved = withDecision(golden, marks.rearmed.evaluationSeq, (decision) => ({
      ...decision,
      sourceEventId: eventIdAt(golden, "6"),
    }));
    expect(() => buildReconciliation(moved)).toThrow(
      /is bracket 1's by its provenance, but it was consumed at ingestSeq 7, at or after the boundary/u,
    );
    // A fill of bracket 2 dated before the boundary is refused the same way.
    const entry2 = orderPlacedBy(golden, marks.enter2).orderId;
    const early: PaperRunArtifact = {
      ...golden,
      fills: golden.fills.map((fill) =>
        fill.simulatedOrderId === entry2 ? { ...fill, atEventIngestSeq: "7" } : fill,
      ),
    };
    expect(() => buildReconciliation(early)).toThrow(
      /is bracket 2's by its provenance, but it was consumed at ingestSeq 7, before the boundary/u,
    );
  });

  it("a boundary with no recorded source event cannot be placed, and is refused", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const tampered = withDecision(golden, marks.rearmed.evaluationSeq, (decision) => ({
      ...decision,
      sourceEventId: null,
    }));
    expect(() => buildReconciliation(tampered)).toThrow(
      /marks \(opening bracket 2\) names no source event/u,
    );
  });

  it("an SB.REARMED with no preceding close is refused — after an entry that never closed, or as the first decision", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const [close1] = marks.closes;
    if (close1 === undefined) throw new Error("no close");
    const unclosed = withDecision(golden, close1.evaluationSeq, (decision) => ({
      ...decision,
      reasonCodes: decision.reasonCodes.filter((code) => code !== "SB.CLOSED"),
    }));
    expect(() => buildReconciliation(unclosed)).toThrow(
      /the strategy's `SB\.REARMED` at evaluationSeq 10 opens bracket 2, but no decision carrying `SB\.CLOSED` precedes it in bracket 1/u,
    );
    // The one-bracket golden whose FIRST decision is re-labelled a re-arm.
    const rearmedFirst = withDecision(paperE2e(), 0, (decision) => ({
      ...decision,
      reasonCodes: ["SB.REARMED"],
    }));
    expect(() => buildReconciliation(rearmedFirst)).toThrow(
      /opens bracket 2, but no decision carrying `SB\.CLOSED` precedes it in bracket 1 \(which holds no decision at all\)/u,
    );
  });

  it("scope by instanceId: a SHADOW observer's `enter` decisions are not a second bracket", async () => {
    // The original scenario with a SHADOW instance over the same market: it
    // persists `enter` decisions of its own, which RECON-1 counted.
    const artifact = captureArtifact(
      await driveScenario({ config: traderConfig({ withShadow: true }) }),
    );
    const enters = artifact.decisions.filter((decision) => decision.decisionType === "enter");
    expect(new Set(enters.map((decision) => decision.instanceId)).size).toBe(2);
    expect(artifact.reconciliation).toEqual(paperE2e().reconciliation);
  });
});

// =============================================================================

/**
 * `BRACKET-1b` r1, BR1B-M1. Until r1 both averaging folds took each fill's
 * direction FROM the attribution — the entry's fills added, the exits'
 * removed — so a fill RECORDED the other way was folded the way its id said:
 * the review's reproduction turned bracket 1's reduction into a purchase, the
 * boundary over 100 purchased shares was reported flat, and every row stayed
 * explained. The direction is now the record's, cross-checked against the
 * attribution, and a contradiction is refused by name.
 */
describe("BRACKET-1b r1 — BR1B-M1: the recorded direction is cross-checked, never overridden by attribution", () => {
  it("an EXIT fill recorded as a PURCHASE is refused — against its own order, then (order changed too) against its side", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const sale = fillPlacedBy(golden, marks.reduce);
    // The review's reproduction: the fill alone now buys.
    expect(() => buildReconciliation(withTrade(golden, sale, { action: "BUY" }))).toThrow(
      new RegExp(
        `fill ${literally(sale.simulatedFillId)} disagrees with its own order ` +
          `${literally(sale.simulatedOrderId)} on action \\(fill "BUY", order "SELL"\\)`,
        "u",
      ),
    );
    // …or trades the other token.
    expect(() =>
      buildReconciliation(withTrade(golden, sale, { tokenId: golden.scenario.noTokenId })),
    ).toThrow(
      new RegExp(
        `disagrees with its own order ${literally(sale.simulatedOrderId)} on tokenId \\(fill ` +
          `"${golden.scenario.noTokenId}", order "${golden.scenario.yesTokenId}"\\)`,
        "u",
      ),
    );
    // Fill and order agree with each other, and contradict the side their ids
    // put them on.
    expect(() =>
      buildReconciliation(withTrade(golden, sale, { action: "BUY" }, { action: "BUY" })),
    ).toThrow(
      new RegExp(
        `order ${literally(sale.simulatedOrderId)} \\(fill ${literally(sale.simulatedFillId)}\\) ` +
          "is an EXIT of bracket 1 \\(the protective reduction the `reduce` decision at " +
          `evaluationSeq ${String(marks.reduce.evaluationSeq)} placed\\) by its provenance, but ` +
          'its recorded action is "BUY", not SELL',
        "u",
      ),
    );
    // An ENTRY that sells, the same way.
    const purchase = fillPlacedBy(golden, marks.enter2);
    expect(() =>
      buildReconciliation(withTrade(golden, purchase, { action: "SELL" }, { action: "SELL" })),
    ).toThrow(/is the ENTRY of bracket 2 by its provenance, but its recorded action is "SELL", not BUY/u);
  });

  it("the ONE-bracket table is held to the same rule (its exit recorded as a purchase left every row explained)", () => {
    const golden = paperE2e();
    const reduce = only(
      golden.decisions.filter((decision) => decision.decisionType === "reduce"),
      "reduce decision",
    );
    const sale = fillPlacedBy(golden, reduce);
    expect(() =>
      buildReconciliation(withTrade(golden, sale, { action: "BUY" }, { action: "BUY" })),
    ).toThrow(/is an EXIT of bracket 1 \(the protective reduction .*its recorded action is "BUY", not SELL/u);
    expect(() => buildReconciliation(withTrade(golden, sale, { action: "BUY" }))).toThrow(
      /on action \(fill "BUY", order "SELL"\)/u,
    );
    // …and the honest document still rebuilds its own table, byte for byte.
    expect(buildReconciliation(golden)).toEqual(golden.reconciliation);
  });

  it("a TRADE record whose side contradicts its fill is refused, and so is a token movement booked the other way", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    // The review's reproduction: the final record books a purchase.
    const takeProfit = fillPlacedBy(golden, marks.takeProfit2);
    const last = golden.pnlRecords.at(-1);
    expect(last).toEqual(tradeRecordOf(golden, takeProfit));
    expect(last?.side).toBe("SELL");
    expect(() =>
      buildReconciliation(withRecord(golden, last?.ref ?? "", { side: "BUY" })),
    ).toThrow(
      /contradicts its fill's direction: the fill's action is "SELL", the token movement is OUTCOME_TOKEN_DELIVERY and the record's side is "BUY"/u,
    );
    // Bracket 2's purchase, its token movement booked as a DELIVERY.
    const movement = tradeRecordOf(golden, fillPlacedBy(golden, marks.enter2)).ref;
    const delivered: PaperRunArtifact = {
      ...golden,
      ledgerTransactions: golden.ledgerTransactions.map((entry) =>
        entry.ledgerTransactionId === movement
          ? { ...entry, eventType: "OUTCOME_TOKEN_DELIVERY" }
          : entry,
      ),
    };
    expect(() => buildReconciliation(delivered)).toThrow(
      /the fill's action is "BUY", the token movement is OUTCOME_TOKEN_DELIVERY and the record's side is "BUY"/u,
    );
  });
});

/**
 * `BRACKET-1b` r1, BR1B-M2. Until r1 every transaction a chain named mapped to
 * its fill, any number of TRADE records could book one fill, and only the
 * realized values were compared: a duplicated record (which `packages/pnl`
 * refuses) and an extra purchase under a principal transaction (which it folds
 * into an open position) both reconciled with every row explained.
 */
describe("BRACKET-1b r1 — BR1B-M2: the PnL stream books the fills ONE TO ONE, and leaves the fills' position", () => {
  it("a ref the stream carries twice is refused — as packages/pnl itself refuses it (PNL_DUPLICATE_REF)", async () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const purchase = tradeRecordOf(golden, fillPlacedBy(golden, marks.enter2));
    // The review's reproduction: bracket 2's entry record, twice.
    expect(() =>
      buildReconciliation({ ...golden, pnlRecords: [...golden.pnlRecords, { ...purchase }] }),
    ).toThrow(
      new RegExp(
        `the instance's §9\\.16 stream carries ref ${literally(purchase.ref)} twice \\(a TRADE ` +
          "record, then a TRADE record\\); packages/pnl folds a ref ONCE and refuses the repeat " +
          "\\(PNL_DUPLICATE_REF\\)",
        "u",
      ),
    );
    // A FEE record's ref, twice, the same way: the engine's refs span every kind.
    const fee = only(
      golden.pnlRecords.filter(
        (record) =>
          record.kind === "FEE" &&
          chainOf(golden, fillPlacedBy(golden, marks.enter2)).ledgerTransactionIds.includes(record.ref),
      ),
      "bracket 2's entry fee record",
    );
    expect(() =>
      buildReconciliation({ ...golden, pnlRecords: [...golden.pnlRecords, { ...fee }] }),
    ).toThrow(/twice \(a FEE record, then a FEE record\)/u);
    // What the engine does with the same stream, from the run's own records.
    const run = await driveScenario({ scenario: TWO_BRACKETS_SCENARIO });
    const live = run.trader.loop.pnlRecords(golden.scenario.instanceId);
    const copy = only(
      live.filter((record) => record.kind === "TRADE" && record.ref === purchase.ref),
      "live purchase record",
    );
    expect(engineFold(golden, live)).toMatchObject({ ok: true, lots: [], realized: ["7.5"] });
    const refused = engineFold(golden, [...live, copy]);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.codes).toContain("PNL_DUPLICATE_REF");
  });

  it("a TRADE record under a fill's PRINCIPAL transaction is refused — packages/pnl would fold it into an open position", async () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const entry = fillPlacedBy(golden, marks.enter2);
    const chain = chainOf(golden, entry);
    const [principal] = chain.ledgerTransactionIds;
    expect(
      golden.ledgerTransactions.find((entry_) => entry_.ledgerTransactionId === principal)
        ?.eventType,
    ).toBe("TRADE_PRINCIPAL");
    const purchase = tradeRecordOf(golden, entry);
    // The review's reproduction: a distinct record, under the principal.
    expect(() =>
      buildReconciliation({
        ...golden,
        pnlRecords: [...golden.pnlRecords, { ...purchase, ref: principal ?? "" }],
      }),
    ).toThrow(
      new RegExp(
        `follows from a TRADE_PRINCIPAL transaction booked for ledger fill ` +
          `${literally(chain.ledgerFillId)}, not from the token movement of ledger fill ` +
          literally(chain.ledgerFillId),
        "u",
      ),
    );
    // The engine accepts that stream, and holds 50 shares the fills do not.
    const run = await driveScenario({ scenario: TWO_BRACKETS_SCENARIO });
    const live = run.trader.loop.pnlRecords(golden.scenario.instanceId);
    const copy = only(
      live.filter((record) => record.kind === "TRADE" && record.ref === purchase.ref),
      "live purchase record",
    );
    expect(engineFold(golden, [...live, { ...copy, ref: principal ?? "" }])).toEqual({
      ok: true,
      lots: [[purchase.tokenAssetId, "50", "16.5"]],
      realized: ["7.5"],
    });
  });

  it("a fill the stream does not book is refused — bracket 2's purchase, or its sale", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    for (const decision of [marks.enter2, marks.takeProfit2]) {
      const fill = fillPlacedBy(golden, decision);
      expect(() =>
        buildReconciliation(withRecord(golden, tradeRecordOf(golden, fill).ref, null)),
      ).toThrow(
        new RegExp(
          `fill ${literally(fill.simulatedFillId)} \\(bracket 2\\) is booked by no §9\\.16 TRADE ` +
            "record in the instance's stream",
          "u",
        ),
      );
    }
  });

  it("the stream's other one-to-one links refuse when broken: a transaction two chains name, one the ledger lacks, a token named two ways", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const entry = fillPlacedBy(golden, marks.enter2);
    const exit = fillPlacedBy(golden, marks.takeProfit2);
    const entryMovement = tradeRecordOf(golden, entry).ref;
    const exitMovement = tradeRecordOf(golden, exit).ref;
    // The purchase's token movement, named by the sale's chain as well.
    const shared: PaperRunArtifact = {
      ...golden,
      traces: golden.traces.map((trace) =>
        trace.venueFillId === exit.simulatedFillId
          ? { ...trace, ledgerTransactionIds: [...trace.ledgerTransactionIds, entryMovement] }
          : trace,
      ),
    };
    expect(() => buildReconciliation(shared)).toThrow(
      new RegExp(
        `ledger transaction ${literally(entryMovement)} is named by the chains of fill ` +
          `${literally(entry.simulatedFillId)} and fill ${literally(exit.simulatedFillId)}`,
        "u",
      ),
    );
    // The sale's token movement, missing from the ledger section.
    const unheld: PaperRunArtifact = {
      ...golden,
      ledgerTransactions: golden.ledgerTransactions.filter(
        (entry_) => entry_.ledgerTransactionId !== exitMovement,
      ),
    };
    expect(() => buildReconciliation(unheld)).toThrow(
      /follows from a transaction the document's ledger section does not hold/u,
    );
    // The sale's record naming another stream token for the same venue token.
    expect(() =>
      buildReconciliation(withRecord(golden, exitMovement, { tokenAssetId: "token:9999" })),
    ).toThrow(
      new RegExp(
        `names stream token token:9999 for venue token ${literally(exit.tokenId)}, but an ` +
          "earlier record names stream token token:9001 for the same venue token",
        "u",
      ),
    );
  });

  it("the POSITION is reconciled alongside realized PnL: a purchase booked at 60 shares realizes the same 8.5, keeps 10, and the row fails", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const purchase = tradeRecordOf(golden, fillPlacedBy(golden, marks.enter2));
    // 60 at 0.33 = 19.8; selling 50 removes 19.8 × 50 / 60 = 16.5 and realizes
    // 25 − 16.5 = 8.5 — the fills' number — while 10 shares at 3.3 stay open.
    const rows = buildReconciliation(withRecord(golden, purchase.ref, { shares: "60" }));
    const realized = row(rows, "bracket.2.pnl.realized");
    expect([
      realized.projected,
      realized.realized,
      realized.difference,
      realized.residual,
      realized.explained,
    ]).toEqual(["8.5", "8.5", "0", "0", false]);
    expect(realized.unexplainedReasons).toEqual([
      "the bracket's TRADE records leave 10 shares of token token:9001 at a cost basis of 3.3, " +
        "where its fills leave 0 at 0: the realized values may agree, but the positions the two " +
        "folds leave do not, so the agreement is not an explanation",
    ]);
    // Non-vacuous: no other row of the table sees it.
    expect(unexplainedRows(rows).map((entry) => entry.id)).toEqual(["bracket.2.pnl.realized"]);
  });
});

/**
 * `BRACKET-1b` r2, BR1B-R2-M1. Until r2 the records side of every
 * `bracket.<n>.pnl.realized` SORTED its bracket's TRADE records into their
 * fills' consumption order and folded each bracket from zero, while
 * `packages/pnl` folds the whole stream once, in the order it is recorded. So
 * a stream the engine refuses (a sale recorded before its purchase) and one it
 * folds to different per-bracket numbers (a purchase recorded before the
 * previous bracket's sale) both reconciled with every row explained. The
 * stream's TRADE records must now be in the order the run consumed their
 * fills and the ledger booked their token movements, and are folded as ONE
 * stream, in that recorded order.
 */
describe("BRACKET-1b r2 — BR1B-R2-M1: the stream is folded in the order it was recorded, never re-sorted or split", () => {
  it("reproduction A — bracket 2's SALE recorded before its PURCHASE is refused; packages/pnl refuses the same stream (PNL_OVERSELL at record index 4)", async () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const entry = fillPlacedBy(golden, marks.enter2);
    const exit = fillPlacedBy(golden, marks.takeProfit2);
    const purchase = tradeRecordOf(golden, entry);
    const sale = tradeRecordOf(golden, exit);
    // The review's reproduction: the stream's records 4 and 6 exchanged.
    expect([golden.pnlRecords[4]?.ref, golden.pnlRecords[6]?.ref]).toEqual([purchase.ref, sale.ref]);
    const reordered = { ...golden, pnlRecords: swapped(golden.pnlRecords, 4, 6) };
    expect(() => buildReconciliation(reordered)).toThrow(
      new RegExp(
        `the instance's §9\\.16 stream records the TRADE record of fill ` +
          `${literally(exit.simulatedFillId)} \\(bracket 2, ledger transaction ` +
          `${literally(sale.ref)}\\) before the TRADE record of fill ` +
          `${literally(entry.simulatedFillId)} \\(bracket 2, ledger transaction ` +
          `${literally(purchase.ref)}\\), but the run consumed fill ` +
          `${literally(entry.simulatedFillId)} first \\(ingestSeq 9, before 10\\) and the ledger ` +
          "booked its token movement first \\(sequence 7, not after 10\\)\\. packages/pnl folds a " +
          "stream in the order it is recorded \\(foldPnlRecords\\)",
        "u",
      ),
    );
    // The engine, given the run's own records in the same order, refuses them.
    const run = await driveScenario({ scenario: TWO_BRACKETS_SCENARIO });
    const live = run.trader.loop.pnlRecords(golden.scenario.instanceId);
    expect(live.map((record) => record.ref)).toEqual(golden.pnlRecords.map((record) => record.ref));
    expect(engineState(golden, live)).toEqual({ ok: true, lots: [], realized: ["7.5"], fees: ["0.647"] });
    expect(engineState(golden, swapped(live, 4, 6))).toMatchObject({
      ok: false,
      codes: expect.arrayContaining(["PNL_INPUT_INVALID", "PNL_OVERSELL"]) as unknown,
      messages: expect.arrayContaining(["fold refused at record index 4"]) as unknown,
    });
  });

  it("reproduction B — bracket 2's PURCHASE recorded before bracket 1's exit is refused across the boundary; packages/pnl would realize −0.75 on that exit, not −1", async () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const reduction = fillPlacedBy(golden, marks.reduce);
    const entry = fillPlacedBy(golden, marks.enter2);
    const sale = tradeRecordOf(golden, reduction);
    const purchase = tradeRecordOf(golden, entry);
    // The review's reproduction: the stream's records 2 and 4 exchanged.
    expect([golden.pnlRecords[2]?.ref, golden.pnlRecords[4]?.ref]).toEqual([sale.ref, purchase.ref]);
    const reordered = { ...golden, pnlRecords: swapped(golden.pnlRecords, 2, 4) };
    expect(() => buildReconciliation(reordered)).toThrow(
      new RegExp(
        `records the TRADE record of fill ${literally(entry.simulatedFillId)} \\(bracket 2, ` +
          `ledger transaction ${literally(purchase.ref)}\\) before the TRADE record of fill ` +
          `${literally(reduction.simulatedFillId)} \\(bracket 1, ledger transaction ` +
          `${literally(sale.ref)}\\), across the boundary between bracket 1 and bracket 2, but ` +
          `the run consumed fill ${literally(reduction.simulatedFillId)} first \\(ingestSeq 7, ` +
          "before 9\\) and the ledger booked its token movement first \\(sequence 4, not after 7\\)",
        "u",
      ),
    );
    // What the engine makes of the run's own records in that order
    // [TRADE e1, FEE e1, TRADE e2, FEE r, TRADE r, FEE e2, TRADE tp2]: ONE lot
    // of 100 shares costing 17 + 16.5 = 33.5 before the first sale, which
    // removes 33.5 × 50 / 100 = 16.75 and realizes 16 − 16.75 = −0.75. The
    // total still reads 7.5, which is why only a per-bracket row could be
    // fooled — and until r2 it was: bracket 1 certified −1.
    const run = await driveScenario({ scenario: TWO_BRACKETS_SCENARIO });
    const live = swapped(run.trader.loop.pnlRecords(golden.scenario.instanceId), 2, 4);
    expect(engineState(golden, live.slice(0, 5))).toEqual({
      ok: true,
      lots: [[sale.tokenAssetId, "50", "16.75"]],
      realized: ["-0.75"],
      fees: ["0.431"],
    });
    expect(engineState(golden, live)).toMatchObject({ ok: true, lots: [], realized: ["7.5"] });
    expect(row(golden.reconciliation, "bracket.1.pnl.realized").realized).toBe("-1");
  });

  it("the LEDGER's order binds as well: the stream unchanged, but a ledger that booked bracket 2's purchase before bracket 1's exit, is refused", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const reduction = fillPlacedBy(golden, marks.reduce);
    const entry = fillPlacedBy(golden, marks.enter2);
    const sale = tradeRecordOf(golden, reduction).ref;
    const purchase = tradeRecordOf(golden, entry).ref;
    const sequenceOf = (id: string): number =>
      only(
        golden.ledgerTransactions.filter((transaction) => transaction.ledgerTransactionId === id),
        `ledger transaction ${id}`,
      ).sequence;
    expect([sequenceOf(sale), sequenceOf(purchase)]).toEqual([4, 7]);
    // The two token movements' booking positions exchanged; the stream, the
    // fills and every id untouched, so the venue's order has nothing to say.
    const rebooked: PaperRunArtifact = {
      ...golden,
      ledgerTransactions: golden.ledgerTransactions.map((transaction) =>
        transaction.ledgerTransactionId === sale
          ? { ...transaction, sequence: 7 }
          : transaction.ledgerTransactionId === purchase
            ? { ...transaction, sequence: 4 }
            : transaction,
      ),
    };
    expect(() => buildReconciliation(rebooked)).toThrow(
      new RegExp(
        `records the TRADE record of fill ${literally(reduction.simulatedFillId)} \\(bracket 1, ` +
          `ledger transaction ${literally(sale)}\\) before the TRADE record of fill ` +
          `${literally(entry.simulatedFillId)} \\(bracket 2, ledger transaction ` +
          `${literally(purchase)}\\), across the boundary between bracket 1 and bracket 2, but ` +
          "the ledger booked its token movement first \\(sequence 4, not after 7\\)\\. ",
        "u",
      ),
    );
  });

  it("a position one bracket's records leave open is CARRIED into the next, as the engine carries it: bracket 1's purchase booked at 60 fails bracket 1 AND bracket 2", async () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const purchase = tradeRecordOf(golden, fillPlacedBy(golden, marks.enter1));
    const rows = buildReconciliation(withRecord(golden, purchase.ref, { shares: "60" }));
    // Bracket 1: 60 at 0.34 = 20.4; selling 50 removes 20.4 × 50 / 60 = 17 and
    // realizes 16 − 17 = −1, the fills' number, while 10 shares at 3.4 stay open.
    expect(row(rows, "bracket.1.pnl.realized")).toMatchObject({
      projected: "-1",
      realized: "-1",
      explained: false,
      unexplainedReasons: [
        "the bracket's TRADE records leave 10 shares of token token:9001 at a cost basis of 3.4, " +
          "where its fills leave 0 at 0: the realized values may agree, but the positions the " +
          "two folds leave do not, so the agreement is not an explanation",
      ],
    });
    // Bracket 2, as the engine folds it: 10 + 50 = 60 shares at 3.4 + 16.5 =
    // 19.9; selling 50 removes 19.9 × 50 / 60 = 16.58333333333333333333333333333333
    // (34 significant digits, half-even) and realizes 25 − that =
    // 8.41666666666666666666666666666667, keeping 10 at
    // 3.31666666666666666666666666666667. Until r2 bracket 2's records were
    // folded from ZERO: 8.5, flat, and the row was explained.
    const second = row(rows, "bracket.2.pnl.realized");
    expect([second.projected, second.realized, second.difference, second.explained]).toEqual([
      "8.5",
      "8.41666666666666666666666666666667",
      "-0.08333333333333333333333333333333",
      false,
    ]);
    expect(second.unexplainedReasons[0]).toBe(
      "the bracket's TRADE records leave 10 shares of token token:9001 at a cost basis of " +
        "3.31666666666666666666666666666667, where its fills leave 0 at 0: the realized values " +
        "may agree, but the positions the two folds leave do not, so the agreement is not an " +
        "explanation",
    );
    expect(unexplainedRows(rows).map((entry) => entry.id)).toEqual([
      "bracket.1.pnl.realized",
      "bracket.2.pnl.realized",
    ]);
    // The engine's own fold of the run's records, with the same change: the
    // per-bracket shares add up to its realized PnL, and it holds the same lot.
    const run = await driveScenario({ scenario: TWO_BRACKETS_SCENARIO });
    const live = run.trader.loop
      .pnlRecords(golden.scenario.instanceId)
      .map((record) => (record.ref === purchase.ref ? { ...record, shares: "60" } : record));
    expect(engineState(golden, live)).toMatchObject({
      ok: true,
      lots: [["token:9001", "10", "3.31666666666666666666666666666667"]],
      realized: ["7.41666666666666666666666666666667"],
    });
    expect(addDecimal("-1", second.realized ?? "")).toBe("7.41666666666666666666666666666667");
  });

  it("FEE records are not ordered: moved to the front of the stream they reconcile unchanged, and packages/pnl folds them to the same state", async () => {
    const golden = twoBrackets();
    const fees = golden.pnlRecords.filter((record) => record.kind === "FEE");
    expect(fees).toHaveLength(3);
    const moved: PaperRunArtifact = {
      ...golden,
      pnlRecords: [...fees, ...golden.pnlRecords.filter((record) => record.kind !== "FEE")],
    };
    expect(buildReconciliation(moved)).toEqual(golden.reconciliation);
    // `applyFee` adds to the fees paid and touches no lot.
    const run = await driveScenario({ scenario: TWO_BRACKETS_SCENARIO });
    const live = run.trader.loop.pnlRecords(golden.scenario.instanceId);
    expect(
      engineState(golden, [
        ...live.filter((record) => record.kind === "FEE"),
        ...live.filter((record) => record.kind !== "FEE"),
      ]),
    ).toEqual(engineState(golden, live));
  });
});

// =============================================================================

describe("BRACKET-1b E4 — RECON2-EVENTHOP: a loop-originated chain walks, and ends at its decision", () => {
  it("every hop of every chain resolves, over the run's bytes and the committed golden", async () => {
    for (const document of [await producedTwoBrackets(), twoBrackets()]) {
      const report = walkChains(document);
      expect(explainWalk(report)).toBe("the walk found nothing");
      expect(report.ok).toBe(true);
      expect(report.chains).toHaveLength(4);
    }
  });

  it("the filled take-profit's chain ends at its decision and featureSnapshotRef, not at a recorded event", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const trace = only(
      golden.traces.filter(
        (candidate) => candidate.evaluationSeq === marks.takeProfit2.evaluationSeq,
      ),
      "take-profit 2 chain",
    );
    expect(trace.sourceEventId).toBe("");
    expect(marks.takeProfit2.sourceEventId).toBeNull();
    expect(trace.featureSnapshotRef).toBe(marks.takeProfit2.featureSnapshotRef);
    const chain = walkChains(golden).chains[golden.traces.indexOf(trace)];
    const event = chain?.hops.find((result) => result.hop === "event");
    expect(event?.ok).toBe(true);
    expect(event?.detail).toContain("an evaluation the loop originated");
    // Three chains still descend from RECORDED events; one from the loop.
    const recorded = new Set(golden.events.map((candidate) => candidate.eventId));
    expect(golden.traces.map((candidate) => recorded.has(candidate.sourceEventId))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("NEGATIVE: a \"\" chain whose decision names a recorded event stays broken, on both hops", () => {
    const golden = twoBrackets();
    const marks = landmarks(golden);
    const tampered = withDecision(golden, marks.takeProfit2.evaluationSeq, (decision) => ({
      ...decision,
      sourceEventId: eventIdAt(golden, "9"),
    }));
    const report = walkChains(tampered);
    expect(report.ok).toBe(false);
    const index = golden.traces.findIndex(
      (candidate) => candidate.evaluationSeq === marks.takeProfit2.evaluationSeq,
    );
    expect(report.chains[index]?.brokenHops).toEqual(["event", "decision"]);
    expect(report.brokenHops).toEqual(["event", "decision"]);
    // The provenance node says the same about the order the decision placed.
    expect(report.findings.map((finding) => finding.split(":")[0])).toEqual([
      "PROVENANCE_UNRESOLVED",
    ]);
  });
});

// =============================================================================

describe("BRACKET-1b E4 — a fee posting exactly when the fee is not zero (fill-posting.ts:355)", () => {
  for (const [name, document] of [
    ["paper-e2e", paperE2e],
    ["two-brackets", twoBrackets],
  ] as const) {
    it(`${name}: every fill's chain names principal + token movement, and a PLATFORM_FEE iff its fee is not zero`, () => {
      const golden = document();
      const byId = new Map(
        golden.ledgerTransactions.map((entry) => [entry.ledgerTransactionId, entry]),
      );
      for (const fill of golden.fills) {
        const trace = only(
          golden.traces.filter((candidate) => candidate.venueFillId === fill.simulatedFillId),
          `chain of fill ${fill.simulatedFillId}`,
        );
        const types = trace.ledgerTransactionIds.map((id) => byId.get(id)?.eventType);
        const charged = compareDecimal(fill.feeAmount, "0") !== 0;
        expect(types).toEqual([
          "TRADE_PRINCIPAL",
          fill.action === "BUY" ? "OUTCOME_TOKEN_RECEIPT" : "OUTCOME_TOKEN_DELIVERY",
          ...(charged ? ["PLATFORM_FEE"] : []),
        ]);
      }
      const expected = golden.fills.reduce(
        (total, fill) => total + 2 + (compareDecimal(fill.feeAmount, "0") !== 0 ? 1 : 0),
        0,
      );
      expect(golden.ledgerTransactions).toHaveLength(expected);
    });
  }

  it("the zero-fee MAKER fill books EXACTLY TWO ledger transactions", () => {
    const golden = twoBrackets();
    const maker = only(
      golden.fills.filter((fill) => fill.liquidityRole === "MAKER"),
      "maker fill",
    );
    expect(maker.feeAmount).toBe("0");
    const trace = only(
      golden.traces.filter((candidate) => candidate.venueFillId === maker.simulatedFillId),
      "maker chain",
    );
    expect(trace.ledgerTransactionIds).toHaveLength(2);
    expect(golden.ledgerTransactions).toHaveLength(11);
    expect(
      golden.ledgerTransactions.filter((entry) => entry.eventType === "PLATFORM_FEE"),
    ).toHaveLength(3);
  });
});

// =============================================================================

/**
 * `N1` (GOV-2B closeout): `health.accounting.pnlRecords` counts EVERY §9.16
 * record `postFill` returned — the ACTUAL account's stream AND each claiming
 * instance's (`fill-posting.ts`, `owners = [ACTUAL_ACCOUNT, ...slices]`;
 * `loop.ts` `#harvestFills`, `countAccounting("pnlRecords", …)`) — while the
 * artefact's `pnlRecords` is the instance's stream alone
 * (`loop.pnlRecords(instanceId)`). One owner instance claiming every fill
 * whole makes the counter EXACTLY twice the array; each owned fill adds a
 * TRADE record, and a FEE record only when its fee is not zero. The counter
 * is not wrong: it counts a larger set. Pinned in both goldens.
 */
describe("N1 — health.accounting.pnlRecords is twice the pnlRecords array, by construction", () => {
  for (const [name, document, array, counter] of [
    ["paper-e2e", paperE2e, 6, 12],
    ["two-brackets", twoBrackets, 7, 14],
  ] as const) {
    it(`${name}: counter ${String(counter)} = 2 × array ${String(array)}, and array = Σ fills (1 + [fee ≠ 0])`, () => {
      const golden = document();
      expect(golden.pnlRecords).toHaveLength(array);
      expect(golden.health.accounting["pnlRecords"]).toBe(counter);
      expect(golden.health.accounting["pnlRecords"]).toBe(2 * golden.pnlRecords.length);
      const perFill = golden.fills.reduce(
        (total, fill) => total + 1 + (compareDecimal(fill.feeAmount, "0") !== 0 ? 1 : 0),
        0,
      );
      expect(golden.pnlRecords).toHaveLength(perFill);
      // Every record the array carries is the instance's; the other half of
      // the counter is the ACTUAL account's stream, which the artefact omits.
      for (const record of golden.pnlRecords) {
        expect(record.scope).toBe("VIRTUAL_STRATEGY");
        expect(record.instanceId).toBe(golden.scenario.instanceId);
      }
      // …and no unowned fill, which would add account records alone.
      expect(golden.health.execution["fillsObserved"]).toBe(golden.fills.length);
      expect(golden.health.seams.orders["unownedFills"]).toBe(0);
    });
  }
});

// =============================================================================

describe("SIM2-E2E-MSG — an evicted venue history is refused at capture, and called EVICTED", () => {
  it("a venue that evicted orders makes the capture refuse, naming the eviction and its counts", async () => {
    const run = await driveScenario({ venueRetention: { orders: 1 } });
    const retention = run.parts.venue.retention();
    // Non-vacuous: the venue really did evict, and the run itself was sound.
    expect(retention.historyEvicted).toBe(true);
    expect(retention.orders.evicted).toBe(2);
    expect(run.trader.loop.health().halts).toEqual([]);
    expect(() => captureArtifact(run)).toThrow(
      /the simulated venue EVICTED part of its history during this run \(orders evicted 2, fills evicted 0, bands evicted 0/u,
    );
  });

  it("evicted fills are named too, and the default retention evicts nothing", async () => {
    const evicting = await driveScenario({ venueRetention: { fills: 1 } });
    const evicted = evicting.parts.venue.retention().fills.evicted;
    expect(evicted).toBeGreaterThan(0);
    expect(() => captureArtifact(evicting)).toThrow(
      new RegExp(`EVICTED part of its history .*fills evicted ${String(evicted)}`, "u"),
    );
    const whole = await driveScenario();
    expect(whole.parts.venue.retention().historyEvicted).toBe(false);
    expect(() => captureArtifact(whole)).not.toThrow();
  });
});
