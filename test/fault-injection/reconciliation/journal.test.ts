/**
 * WP-290 deliverable 2: the break taxonomy and the APPEND-ONLY journal
 * (`packages/ledger/src/reconciliation/`).
 *
 * - The taxonomy: every class is an `internal.code`; every ambiguity class
 *   is `HOLD_UNTIL_CONSISTENT` and never operator-releasable; every
 *   UNATTRIBUTED class halts.
 * - The journal: events are immutable and only appended; every transition
 *   rule in the journal's header is enforced; a rebuild from the durable
 *   history equals the incremental state; a failing sink faults the journal
 *   and memory is never ahead of what is durable.
 */

import { describe, expect, it } from "vitest";

import {
  BREAK_CLASSES,
  BREAK_TAXONOMY,
  RECONCILIATION_TRIGGERS,
  RELEASE_ACKNOWLEDGES_SUBJECT,
  ReconciliationJournal,
  isOperatorReleasable,
  releaseAcknowledgesSubject,
  type ReconciliationJournalEvent,
} from "../../../packages/ledger/src/index.js";
import { uuid7 } from "../../unit/oms/support/ids.js";

const RUN_1 = uuid7(0x31, 1);
const RUN_2 = uuid7(0x31, 2);
const BREAK_1 = uuid7(0x32, 1);
const BREAK_2 = uuid7(0x32, 2);
const MARKET = uuid7(0xc, 1);
const ACCOUNT = "paper-account-1";

function journal(history: readonly unknown[] = []): { readonly j: ReconciliationJournal; readonly durable: ReconciliationJournalEvent[] } {
  const durable: ReconciliationJournalEvent[] = [...(history as ReconciliationJournalEvent[])];
  const opened = ReconciliationJournal.open({ accountRef: ACCOUNT, history, sink: { append: async (event) => void durable.push(event) } });
  if (!opened.ok) throw new Error(opened.refusal.message);
  return { j: opened.value, durable };
}

const started = (runId: string, atMs = 1): Record<string, unknown> => ({ kind: "RUN_STARTED", runId, accountRef: ACCOUNT, trigger: "STARTUP", triggers: ["STARTUP"], atMs });
const completed = (runId: string, status: string, atMs = 2): Record<string, unknown> => ({
  kind: "RUN_COMPLETED",
  runId,
  status,
  ordersChecked: 0,
  fillsChecked: 0,
  walletOperationsChecked: 0,
  breaksFound: 0,
  detail: "",
  atMs,
});
const opened = (breakId: string, runId: string, breakClass: string, subjectKey = `s-${breakId}`, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "BREAK_OPENED",
  breakId,
  runId,
  breakClass,
  subjectKey,
  scope: "ACCOUNT",
  marketId: null,
  orderId: null,
  fillId: null,
  walletOperationId: null,
  assetId: null,
  expectedValue: null,
  observedValue: null,
  detail: "a detail",
  atMs: 1,
  ...extra,
});
const resolved = (breakId: string, runId: string | null, resolution: string, operatorRef: string | null = null): Record<string, unknown> => ({
  kind: "BREAK_RESOLVED",
  breakId,
  runId,
  resolution,
  operatorRef,
  detail: "why",
  atMs: 3,
});
const quarantined = (breakId: string, runId: string, ledgerTx: string | null = null): Record<string, unknown> => ({
  kind: "BREAK_QUARANTINED",
  breakId,
  runId,
  resolutionLedgerTransactionId: ledgerTx,
  atMs: 2,
});

async function expectRefused(j: ReconciliationJournal, event: unknown, code: string): Promise<void> {
  const result = await j.append(event);
  expect(result.ok, JSON.stringify(event)).toBe(false);
  if (!result.ok) expect(result.refusal.code).toBe(code);
}

describe("the break taxonomy", () => {
  it("every class is a valid internal.code and has a rule, a meaning and a handling", () => {
    // r3: SETTLEMENT_FAILED (41). r4: ORDER_NOT_FOUND_BY_ID and SETTLEMENT_REVERSAL_OWED (43). C1-OMS06: HALT_DELIVERY_FAILED removed (42).
    expect(BREAK_CLASSES.length).toBe(42);
    expect(BREAK_CLASSES).not.toContain("HALT_DELIVERY_FAILED");
    for (const breakClass of BREAK_CLASSES) {
      expect(breakClass).toMatch(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u);
      const spec = BREAK_TAXONOMY[breakClass];
      expect(spec.meaning.length).toBeGreaterThan(10);
      expect(spec.handling.length).toBeGreaterThan(3);
    }
  });

  it("ambiguity is HOLD_UNTIL_CONSISTENT and never operator-releasable (acceptance 1 as a property of the table)", () => {
    const ambiguity = [...BREAK_CLASSES.filter((breakClass) => BREAK_TAXONOMY[breakClass].family === "READ"), "SIGNED_IDENTITY_AMBIGUOUS", "ORDER_UNRESOLVED", "HOLDING_IN_TRANSIT_AMBIGUOUS", "HOLDING_DELTA_UNCONFIRMED", "WALLET_MEMBER_PENDING"] as const;
    expect(ambiguity.length).toBe(13);
    for (const breakClass of ambiguity) {
      expect(BREAK_TAXONOMY[breakClass].rule, breakClass).toBe("HOLD_UNTIL_CONSISTENT");
      expect(isOperatorReleasable(BREAK_TAXONOMY[breakClass].rule)).toBe(false);
    }
  });

  it("unmatched actual activity is UNATTRIBUTED_HALT (acceptance 2 as a property of the table)", () => {
    for (const breakClass of ["ORDER_UNATTRIBUTED", "TRADE_UNATTRIBUTED", "POSITION_UNATTRIBUTED", "BALANCE_UNATTRIBUTED", "LEDGER_UNATTRIBUTED_ARRIVAL"] as const) {
      expect(BREAK_TAXONOMY[breakClass].rule, breakClass).toBe("UNATTRIBUTED_HALT");
    }
    expect(BREAK_CLASSES.filter((breakClass) => BREAK_TAXONOMY[breakClass].rule === "UNATTRIBUTED_HALT")).toHaveLength(5);
  });

  it("a release acknowledges immutable history for good, never a live contradiction (I-06); fill contradictions hold (I-02)", () => {
    const releasable = BREAK_CLASSES.filter((breakClass) => isOperatorReleasable(BREAK_TAXONOMY[breakClass].rule));
    expect(releasable.filter((breakClass) => !releaseAcknowledgesSubject(breakClass))).toEqual(["ORDER_FACTS_MISMATCH"]);
    expect([...RELEASE_ACKNOWLEDGES_SUBJECT].every((breakClass) => isOperatorReleasable(BREAK_TAXONOMY[breakClass].rule))).toBe(true);
    // No HOLD class is ever acknowledged by a release (none can be released).
    expect(BREAK_CLASSES.filter((breakClass) => releaseAcknowledgesSubject(breakClass) && !releasable.includes(breakClass))).toEqual([]);
    const { j } = journal();
    expect(j.releaseAcknowledgesSubject("ORDER_FACTS_MISMATCH")).toBe(false);
    expect(j.releaseAcknowledgesSubject("TRADE_UNATTRIBUTED")).toBe(true);
    expect(BREAK_TAXONOMY.FILL_MISMATCH.rule).toBe("HOLD_UNTIL_CONSISTENT");
  });

  it("the triggers are §9.17's eight, token-identical to internal.reconciliation_trigger", () => {
    expect(RECONCILIATION_TRIGGERS).toEqual([
      "STARTUP",
      "PERIODIC_TIMER",
      "USER_STREAM_RECONNECT",
      "MARKET_STREAM_GAP",
      "SUBMISSION_UNKNOWN",
      "WALLET_OPERATION_UNKNOWN",
      "MANUAL_REQUEST",
      "POSITION_BALANCE_DISCREPANCY",
    ]);
  });
});

describe("the journal is append-only", () => {
  it("appends in order with a sequence, frozen; there is no edit or delete", async () => {
    const { j, durable } = journal();
    expect((await j.append(started(RUN_1))).ok).toBe(true);
    expect((await j.append(opened(BREAK_1, RUN_1, "READ_MISSING"))).ok).toBe(true);
    expect(durable.map((event) => event.sequence)).toEqual([0, 1]);
    expect(Object.isFrozen(durable[0])).toBe(true);
    expect(Object.isFrozen(j.events())).toBe(true);
    const methods = Object.getOwnPropertyNames(ReconciliationJournal.prototype);
    expect(methods.filter((name) => /update|delete|remove|edit|clear|set[A-Z]/u.test(name))).toEqual([]);
  });

  it("a rebuild from the durable history equals the incremental state", async () => {
    const { j, durable } = journal();
    await j.append(started(RUN_1));
    await j.append(opened(BREAK_1, RUN_1, "READ_MISSING"));
    await j.append(opened(BREAK_2, RUN_1, "ORDER_UNATTRIBUTED", "s2", { scope: "MARKET", marketId: MARKET }));
    await j.append(quarantined(BREAK_2, RUN_1, uuid7(0x33, 1)));
    await j.append(completed(RUN_1, "QUARANTINED"));
    await j.append(started(RUN_2, 5));
    await j.append(resolved(BREAK_1, RUN_2, "NOT_REPRODUCED"));
    const rebuilt = journal(durable).j;
    expect(rebuilt.runs()).toEqual(j.runs());
    expect(rebuilt.breaks()).toEqual(j.breaks());
    expect(rebuilt.runningRunId).toBe(RUN_2);
  });

  it("a sink that fails faults the journal; the event is not folded; every later append is refused", async () => {
    let fail = false;
    const opened1 = ReconciliationJournal.open({
      accountRef: ACCOUNT,
      history: [],
      sink: {
        append: async () => {
          if (fail) throw new Error("disk full");
        },
      },
    });
    if (!opened1.ok) throw new Error("open");
    const j = opened1.value;
    await j.append(started(RUN_1));
    fail = true;
    await expectRefused(j, opened(BREAK_1, RUN_1, "READ_MISSING"), "RECON_SINK_FAILED");
    expect(j.breaks()).toEqual([]);
    expect(j.faulted).toBe(true);
    fail = false;
    await expectRefused(j, completed(RUN_1, "FAILED"), "RECON_JOURNAL_FAULTED");
  });

  it("a history that could not have been appended is refused whole", () => {
    const bad = [{ ...started(RUN_1), sequence: 0 }, { ...opened(BREAK_1, RUN_2, "READ_MISSING"), sequence: 1 }];
    const result = ReconciliationJournal.open({ accountRef: ACCOUNT, history: bad, sink: { append: async () => undefined } });
    expect(result.ok).toBe(false);
    const gap = [{ ...started(RUN_1), sequence: 1 }];
    expect(ReconciliationJournal.open({ accountRef: ACCOUNT, history: gap, sink: { append: async () => undefined } }).ok).toBe(false);
  });
});

describe("the journal enforces its transitions", () => {
  it("one run at a time; breaks, quarantines and answers name the RUNNING run", async () => {
    const { j } = journal();
    await expectRefused(j, opened(BREAK_1, RUN_1, "READ_MISSING"), "RECON_TRANSITION_ILLEGAL");
    await j.append(started(RUN_1));
    await expectRefused(j, started(RUN_2), "RECON_TRANSITION_ILLEGAL");
    await expectRefused(j, { ...started(RUN_2), accountRef: "another-account" }, "RECON_TRANSITION_ILLEGAL");
    await expectRefused(j, opened(BREAK_1, RUN_2, "READ_MISSING"), "RECON_TRANSITION_ILLEGAL");
  });

  it("one unresolved break per subject", async () => {
    const { j } = journal();
    await j.append(started(RUN_1));
    await j.append(opened(BREAK_1, RUN_1, "READ_MISSING", "subject"));
    await expectRefused(j, opened(BREAK_2, RUN_1, "READ_STALE", "subject"), "RECON_TRANSITION_ILLEGAL");
  });

  it("a run cannot PASS while any break, from any run, is unresolved; QUARANTINED needs a quarantine", async () => {
    const { j } = journal();
    await j.append(started(RUN_1));
    await j.append(opened(BREAK_1, RUN_1, "SIGNED_IDENTITY_AMBIGUOUS"));
    await expectRefused(j, completed(RUN_1, "PASSED"), "RECON_TRANSITION_ILLEGAL");
    await expectRefused(j, completed(RUN_1, "QUARANTINED"), "RECON_TRANSITION_ILLEGAL");
    expect((await j.append(completed(RUN_1, "FAILED"))).ok).toBe(true);
    await j.append(started(RUN_2));
    await expectRefused(j, completed(RUN_2, "PASSED"), "RECON_TRANSITION_ILLEGAL");
  });

  it("only quarantine rules are quarantined, and only UNATTRIBUTED ones carry a correction", async () => {
    const { j } = journal();
    await j.append(started(RUN_1));
    await j.append(opened(BREAK_1, RUN_1, "READ_MISSING"));
    await expectRefused(j, quarantined(BREAK_1, RUN_1), "RECON_TRANSITION_ILLEGAL");
    await j.append(opened(BREAK_2, RUN_1, "OMS_HALTING_ALERT"));
    await expectRefused(j, quarantined(BREAK_2, RUN_1, uuid7(0x33, 1)), "RECON_TRANSITION_ILLEGAL");
    expect((await j.append(quarantined(BREAK_2, RUN_1))).ok).toBe(true);
  });

  it("ambiguity is never released by an operator; a later complete run clears it; the same run never does", async () => {
    const { j } = journal();
    await j.append(started(RUN_1));
    await j.append(opened(BREAK_1, RUN_1, "SIGNED_IDENTITY_AMBIGUOUS"));
    await expectRefused(j, resolved(BREAK_1, null, "OPERATOR_RELEASED", "operator-1"), "RECON_TRANSITION_ILLEGAL");
    await expectRefused(j, resolved(BREAK_1, RUN_1, "NOT_REPRODUCED"), "RECON_TRANSITION_ILLEGAL");
    await expectRefused(j, resolved(BREAK_1, RUN_1, "RESOLVED_IN_RUN"), "RECON_TRANSITION_ILLEGAL");
    await j.append(completed(RUN_1, "FAILED"));
    await j.append(started(RUN_2));
    expect((await j.append(resolved(BREAK_1, RUN_2, "NOT_REPRODUCED"))).ok).toBe(true);
    expect((await j.append(completed(RUN_2, "PASSED"))).ok).toBe(true);
  });

  it("a quarantine is released only by an operator, naming who and why; never by a run", async () => {
    const { j } = journal();
    await j.append(started(RUN_1));
    await j.append(opened(BREAK_1, RUN_1, "TRADE_UNATTRIBUTED", "t", { scope: "MARKET", marketId: MARKET }));
    await expectRefused(j, resolved(BREAK_1, null, "OPERATOR_RELEASED", "operator-1"), "RECON_TRANSITION_ILLEGAL"); // not yet quarantined
    await j.append(quarantined(BREAK_1, RUN_1));
    await j.append(completed(RUN_1, "QUARANTINED"));
    await j.append(started(RUN_2));
    await expectRefused(j, resolved(BREAK_1, RUN_2, "NOT_REPRODUCED"), "RECON_TRANSITION_ILLEGAL");
    await expectRefused(j, resolved(BREAK_1, null, "OPERATOR_RELEASED", null), "RECON_EVENT_INVALID");
    expect((await j.append(resolved(BREAK_1, null, "OPERATOR_RELEASED", "operator-1"))).ok).toBe(true);
    expect(j.breaks()[0]).toMatchObject({ status: "RESOLVED", resolution: "OPERATOR_RELEASED", operatorRef: "operator-1" });
  });

  it("RESOLVED_IN_RUN only inside the run that opened it; a RESUME_REFUSED only after a PASSED completion", async () => {
    const { j } = journal();
    await j.append(started(RUN_1));
    await j.append(opened(BREAK_1, RUN_1, "TRADE_MISSING_IN_OMS"));
    expect((await j.append(resolved(BREAK_1, RUN_1, "RESOLVED_IN_RUN"))).ok).toBe(true);
    await expectRefused(j, { kind: "RESUME_REFUSED", runId: RUN_1, refusalCode: "OMS_RESUME_BLOCKED", atMs: 4 }, "RECON_TRANSITION_ILLEGAL");
    await j.append(completed(RUN_1, "PASSED"));
    expect((await j.append({ kind: "RESUME_REFUSED", runId: RUN_1, refusalCode: "OMS_RESUME_BLOCKED", atMs: 4 })).ok).toBe(true);
  });
});

describe("the journal's door", () => {
  it("refuses anything outside an event's domain", async () => {
    const { j } = journal();
    await j.append(started(RUN_1));
    for (const event of [
      { ...opened(BREAK_1, RUN_1, "READ_MISSING"), scope: "MARKET" }, // a market scope with no market
      { ...opened(BREAK_1, RUN_1, "READ_MISSING"), marketId: MARKET }, // a market on an account scope
      { ...opened(BREAK_1, RUN_1, "NOT_A_CLASS") },
      { ...opened("not-a-uuid", RUN_1, "READ_MISSING") },
      { ...opened(BREAK_1, RUN_1, "READ_MISSING"), expectedValue: 1.5 }, // a number is never an amount
      { ...opened(BREAK_1, RUN_1, "READ_MISSING"), expectedValue: "1.50" }, // nor an inexact decimal
      { ...opened(BREAK_1, RUN_1, "READ_MISSING"), extra: true },
      { ...opened(BREAK_1, RUN_1, "READ_MISSING"), detail: "" },
      { ...started(RUN_2), triggers: ["STARTUP", "STARTUP"] },
    ]) {
      await expectRefused(j, event, "RECON_EVENT_INVALID");
    }
    const getter = opened(BREAK_1, RUN_1, "READ_MISSING");
    Object.defineProperty(getter, "detail", { get: () => "computed", enumerable: true });
    await expectRefused(j, getter, "RECON_EVENT_INVALID");
  });
});
