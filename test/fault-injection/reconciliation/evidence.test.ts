/**
 * WP-290 r6: the EVIDENCE STORE (`packages/oms/src/reconciliation/evidence.ts`) and its durable record (the
 * journal's `EVIDENCE_RECORDED`), as units: what is folded, what a verdict says, and what the journal accepts.
 */

import { describe, expect, it } from "vitest";

import { ReconciliationJournal, type ReconciliationJournalEvent } from "../../../packages/ledger/src/index.js";
import {
  EvidenceStore,
  legRecord,
  namedOrder,
  readEvidenceRecord,
  readEvidenceRecords,
  settledRecord,
  shownOrder,
  type EvidenceRecord,
  type OrderVerdict,
} from "../../../packages/oms/src/reconciliation/evidence.js";
import type { VenueOrderView, VenueTradeView } from "../../../packages/oms/src/index.js";

const RUN_1 = "00000000-0000-7000-8000-000000000001";
const RUN_2 = "00000000-0000-7000-8000-000000000002";

function order(overrides: Partial<VenueOrderView> = {}): VenueOrderView {
  return { venueOrderId: "x", tokenId: "1", side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0", status: "LIVE", ...overrides };
}

function trade(overrides: Partial<VenueTradeView> & { readonly shares?: string } = {}): VenueTradeView {
  const { shares = "0.4", ...rest } = overrides;
  return {
    venueTradeId: "t",
    status: "CONFIRMED",
    transactionHash: null,
    ownershipUndetermined: false,
    ownLegs: [{ venueOrderId: "x", role: "MAKER", tokenId: "1", side: "BUY", shares, price: "0.5", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" }],
    ...rest,
  };
}

function leg(shares: string, tradeId = "t", status: string | null = "CONFIRMED"): EvidenceRecord {
  return legRecord(tradeId, { venueOrderId: "x", tokenId: "1", side: "BUY", shares, price: "0.5" }, status, "SHOWN", "TRADES_LEG");
}

function judge(store: EvidenceStore, reads: { listed?: VenueOrderView; byId?: VenueOrderView | null; claimed?: boolean; legs?: VenueTradeView["ownLegs"] }): OrderVerdict {
  return store.judge({ order: "x", reads: { claimed: reads.claimed ?? false, listed: reads.listed, byId: reads.byId, legs: reads.legs ?? [] } });
}

describe("the evidence store folds every observation monotonically", () => {
  it("the high-water matched size moves on any record, never down; a terminal observation is sticky; distinct trades' legs sum", () => {
    const store = new EvidenceStore();
    expect(store.add(shownOrder(order({ sizeMatched: "0.4" }), "OPEN_ORDERS_ROW"))).toBe(true);
    expect(store.add(shownOrder(order({ sizeMatched: "0.2" }), "BY_ID"))).toBe(false);
    expect(store.order("x")?.matchedHigh).toBe("0.4");
    expect(store.add(leg("0.3", "t1"))).toBe(true);
    expect(store.add(leg("0.3", "t2"))).toBe(true);
    expect(store.add(leg("0.3", "t1"))).toBe(false);
    expect(store.order("x")).toMatchObject({ legSum: "0.6", matchedHigh: "0.6", observedMatched: "0.4", shown: true });
    expect(store.add(shownOrder(order({ sizeMatched: "0.6", status: "CANCELED" }), "BY_ID"))).toBe(true);
    expect(store.add(shownOrder(order({ sizeMatched: "0.6", status: "LIVE" }), "OPEN_ORDERS_LIST"))).toBe(false);
    expect(store.order("x")?.terminal).toBe(true);
  });

  it("a sound run's settlement covers the evidence up to its level; new information makes the order unsettled again", () => {
    const store = EvidenceStore.fold([namedOrder("x", "OMS_RETAINED")]);
    expect(store.unsettled()).toEqual(["x"]);
    const level = store.order("x")?.level as number;
    expect(store.add(settledRecord("x", level, "SOUND_RUN"))).toBe(true);
    expect(store.unsettled()).toEqual([]);
    expect(store.add(namedOrder("x", "OMS_RETAINED"))).toBe(false);
    expect(store.unsettled()).toEqual([]);
    expect(store.add(namedOrder("x", "STREAM_ORDER", { status: "CANCELED" }))).toBe(true);
    expect(store.unsettled()).toEqual(["x"]);
  });

  it("a rebuild from the same records is the same store (a restart forgets nothing)", () => {
    const records = [shownOrder(order({ sizeMatched: "0.4" }), "OPEN_ORDERS_ROW"), leg("0.4"), namedOrder("y", "OPEN_ORDERS_ID")];
    const live = new EvidenceStore();
    for (const record of records) live.add(record);
    const rebuilt = EvidenceStore.fold(records);
    expect(rebuilt.order("x")).toEqual(live.order("x"));
    expect(rebuilt.order("y")).toEqual(live.order("y"));
    expect(rebuilt.unsettled()).toEqual(live.unsettled());
  });
});

describe("the one query: a verdict on this run's reads against each other and against ALL the evidence", () => {
  it("an observation below what an earlier read showed is a READ_REGRESSION, though a later read of this run catches up", () => {
    const store = EvidenceStore.fold([shownOrder(order({ sizeMatched: "0.4" }), "OPEN_ORDERS_ROW")]);
    store.beginRun();
    store.add(shownOrder(order({ sizeMatched: "0.3" }), "OPEN_ORDERS_LIST"));
    store.add(shownOrder(order({ sizeMatched: "0.4" }), "BY_ID"));
    const verdict = judge(store, { listed: order({ sizeMatched: "0.3" }), byId: order({ sizeMatched: "0.4" }) });
    expect(verdict.kind).toBe("CONFLICT");
    expect(verdict.kind === "CONFLICT" ? verdict.problems.map((entry) => entry.breakClass) : []).toEqual(["READ_REGRESSION"]);
  });

  it("the latest read showing less than the trades the evidence holds is a READ_CONFLICT; live after terminal is a READ_REGRESSION", () => {
    const store = EvidenceStore.fold([leg("0.4", "t1")]);
    store.beginRun();
    expect(judge(store, { byId: order({ sizeMatched: "0", status: "CANCELED" }) }).kind).toBe("CONFLICT");
    const terminal = EvidenceStore.fold([shownOrder(order({ status: "CANCELED" }), "BY_ID")]);
    terminal.beginRun();
    const verdict = judge(terminal, { listed: order({ status: "LIVE" }) });
    expect(verdict.kind === "CONFLICT" ? verdict.problems.map((entry) => entry.breakClass) : []).toEqual(["READ_REGRESSION"]);
  });

  it("consistent reads give the latest view (a later by-id read further along than the list)", () => {
    const store = EvidenceStore.fold([shownOrder(order({ sizeMatched: "0.2" }), "OPEN_ORDERS_LIST")]);
    store.beginRun();
    const byId = order({ sizeMatched: "0.4", status: "CANCELED" });
    store.add(shownOrder(byId, "BY_ID"));
    expect(judge(store, { listed: order({ sizeMatched: "0.2" }), byId })).toEqual({ kind: "CONSISTENT", order: byId });
  });

  it("not found by id: a claimed order is MISSING; one a source showed is a CONFLICT; one only named is a GHOST, ACKNOWLEDGED once settled; no evidence is MISSING", () => {
    const shown = EvidenceStore.fold([shownOrder(order(), "OPEN_ORDERS_ROW")]);
    expect(judge(shown, { byId: null, claimed: true }).kind).toBe("MISSING");
    expect(judge(shown, { byId: null }).kind).toBe("CONFLICT");
    const named = EvidenceStore.fold([namedOrder("x", "OMS_RETAINED")]);
    expect(judge(named, { byId: null }).kind).toBe("GHOST");
    named.add(settledRecord("x", named.order("x")?.level as number, "OPERATOR_RELEASE"));
    expect(judge(named, { byId: null }).kind).toBe("ACKNOWLEDGED");
    expect(judge(new EvidenceStore(), { byId: null }).kind).toBe("MISSING");
    expect(judge(named, {}).kind).toBe("UNREAD");
  });

  it("a trade: status backwards is a READ_REGRESSION; CONFIRMED against FAILED a READ_CONFLICT; a leg missing or of other shares a READ_CONFLICT", () => {
    const store = EvidenceStore.fold([leg("0.4", "t", "MINED")]);
    expect(store.judge({ trade: "t", reads: { tradesOk: true, shown: trade({ status: "MATCHED" }) } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_REGRESSION" }] });
    const confirmed = EvidenceStore.fold([leg("0.4", "t", "CONFIRMED")]);
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: true, shown: trade({ status: "FAILED" }) } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: true, shown: trade({ shares: "0.3" }) } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: true, shown: trade({ ownLegs: [] , ownershipUndetermined: true }) } })).toMatchObject({ kind: "CONFLICT" });
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: true, shown: trade() } })).toEqual({ kind: "CONSISTENT", status: "CONFIRMED" });
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: false, shown: undefined } })).toEqual({ kind: "UNREAD" });
  });
});

describe("the evidence door and the journal's EVIDENCE_RECORDED", () => {
  it("the door reads only records in their shape", () => {
    const good = shownOrder(order(), "OPEN_ORDERS_LIST");
    expect(readEvidenceRecord({ ...good })).toEqual(good);
    expect(readEvidenceRecord({ ...good, source: "NOT_A_SOURCE" })).toBeUndefined();
    expect(readEvidenceRecord({ ...good, size: "0.10" })).toBeUndefined();
    expect(readEvidenceRecord({ ...good, venueTradeId: "t" })).toBeUndefined();
    expect(readEvidenceRecords([good, { ...good, level: 1 }])).toBeUndefined();
    expect(readEvidenceRecords("not a list")).toBeUndefined();
  });

  it("names the RUNNING run or none; refuses another run's; a leg names its trade; a settlement carries a level; it replays from history", async () => {
    const events: ReconciliationJournalEvent[] = [];
    const opened = ReconciliationJournal.open({ accountRef: "account-1", history: [], sink: { append: async (event) => void events.push(event) } });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const journal = opened.value;
    const record = (runId: string | null, extra: Partial<EvidenceRecord> = {}): Record<string, unknown> => ({ kind: "EVIDENCE_RECORDED", runId, ...shownOrder(order(), "OPEN_ORDERS_LIST"), ...extra, atMs: 1 });
    expect((await journal.append(record(null))).ok).toBe(true);
    expect((await journal.append(record(RUN_1))).ok).toBe(false);
    expect((await journal.append({ kind: "RUN_STARTED", runId: RUN_1, accountRef: "account-1", trigger: "STARTUP", triggers: ["STARTUP"], atMs: 2 })).ok).toBe(true);
    expect((await journal.append(record(RUN_1))).ok).toBe(true);
    expect((await journal.append(record(RUN_2))).ok).toBe(false);
    expect((await journal.append(record(null, { evidenceKind: "LEG" }))).ok).toBe(false);
    expect((await journal.append(record(null, { evidenceKind: "SETTLED", level: null }))).ok).toBe(false);
    expect((await journal.append(record(null, { tokenId: "not-a-token" }))).ok).toBe(false);
    expect((await journal.append(record(RUN_1, settledRecord("x", 1, "SOUND_RUN")))).ok).toBe(true);
    expect(journal.evidence()).toHaveLength(3);
    expect(Object.isFrozen(journal.evidence())).toBe(true);
    const replayed = ReconciliationJournal.open({ accountRef: "account-1", history: events, sink: { append: async () => undefined } });
    expect(replayed.ok && replayed.value.evidence()).toEqual(journal.evidence());
    expect(readEvidenceRecords(journal.evidence())).toHaveLength(3);
  });
});
