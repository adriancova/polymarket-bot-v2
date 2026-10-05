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
    expect(store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: trade({ status: "MATCHED" }) } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_REGRESSION" }] });
    const confirmed = EvidenceStore.fold([leg("0.4", "t", "CONFIRMED")]);
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: trade({ status: "FAILED" }) } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: trade({ shares: "0.3" }) } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: trade({ ownLegs: [] , ownershipUndetermined: true }) } })).toMatchObject({ kind: "CONFLICT" });
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: trade() } })).toEqual({ kind: "CONSISTENT", status: "CONFIRMED" });
    expect(confirmed.judge({ trade: "t", reads: { tradesOk: false, held: false, accounted: () => false, shown: undefined } })).toEqual({ kind: "UNREAD" });
  });
});

describe("r7: immutable facts shown two ways are a durable contradiction (WP290-CX-R7-01, R7-02); a shown trade carries a classification obligation (R7-03)", () => {
  function fullLeg(overrides: Partial<Record<"shares" | "price" | "feeAmount" | "feeAssetId" | "matchedAt", string | null>> & { readonly role?: "MAKER" | "TAKER" } = {}, tradeId = "t"): EvidenceRecord {
    return legRecord(
      tradeId,
      { venueOrderId: "x", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5", feeAmount: "0", feeAssetId: null, role: "MAKER", matchedAt: "2026-10-03T00:00:00Z", ...overrides },
      "CONFIRMED",
      "SHOWN",
      "TRADES_LEG",
    );
  }

  it("an order's fixed fact shown with another value is information (journaled) and a contradiction in every later verdict, after a rebuild too", () => {
    for (const changed of [{ price: "0.6" }, { tokenId: "2" }, { originalSize: "2" }, { side: "SELL" as const }]) {
      const records = [shownOrder(order(), "OPEN_ORDERS_ROW")];
      const store = EvidenceStore.fold(records);
      const second = shownOrder(order(changed), "BY_ID");
      expect(store.add(second)).toBe(true);
      expect(store.order("x")?.contradictions).toHaveLength(1);
      const rebuilt = EvidenceStore.fold([...records, second]);
      rebuilt.beginRun();
      // Even a read that agrees with the first value is a conflict now: which value is the venue's is unknown.
      const verdict = judge(rebuilt, { byId: order({ status: "CANCELED" }) });
      expect(verdict.kind).toBe("CONFLICT");
      expect(verdict.kind === "CONFLICT" ? verdict.problems[0]?.detail : "").toContain("different fixed facts");
    }
  });

  it("filling in a fixed fact no observation showed yet is not a contradiction; a value seen again is not information", () => {
    const store = EvidenceStore.fold([namedOrder("x", "OMS_RETAINED")]);
    expect(store.add(shownOrder(order(), "BY_ID"))).toBe(true);
    expect(store.add(shownOrder(order(), "OPEN_ORDERS_LIST"))).toBe(false);
    expect(store.order("x")?.contradictions).toEqual([]);
    store.beginRun();
    expect(judge(store, { byId: order() }).kind).toBe("CONSISTENT");
  });

  it("a leg's fill facts shown two ways (an offsetting price and fee) are a durable contradiction; the same instant at another precision, or a fee newly fixed, is not", () => {
    const store = EvidenceStore.fold([fullLeg()]);
    expect(store.add(fullLeg({ matchedAt: "2026-10-03T00:00:00.000Z" }))).toBe(false);
    expect(store.add(fullLeg({ matchedAt: "2026-10-03T02:00:00+02:00" }))).toBe(false);
    expect(store.trade("t")?.legs[0]?.contradictions).toEqual([]);
    const unfixed = EvidenceStore.fold([fullLeg({ feeAmount: null })]);
    expect(unfixed.add(fullLeg())).toBe(true);
    expect(unfixed.trade("t")?.legs[0]?.contradictions).toEqual([]);
    const changes: { readonly first?: Parameters<typeof fullLeg>[0]; readonly then: Parameters<typeof fullLeg>[0] }[] = [
      { then: { price: "0.49", feeAmount: "0.004", feeAssetId: "pusd" } },
      { then: { role: "TAKER" } },
      { then: { matchedAt: "2026-10-03T00:00:01Z" } },
      { then: { shares: "0.3" } },
      { first: { feeAssetId: "other" }, then: { feeAssetId: "pusd" } },
    ];
    for (const { first, then } of changes) {
      const records = [fullLeg(first), fullLeg(then)];
      const rebuilt = EvidenceStore.fold(records);
      expect(rebuilt.trade("t")?.legs[0]?.contradictions.length).toBeGreaterThan(0);
      const verdict = rebuilt.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: trade() } });
      expect(verdict.kind).toBe("CONFLICT");
      // Absent from a complete read, accounted for or not: still a conflict (the contradiction is durable).
      expect(rebuilt.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: undefined } }).kind).toBe("CONFLICT");
    }
  });

  it("a SHOWN trade a complete read omits is a CONFLICT until accounted for (or while held); an accounted one, or one not read, is not judged", () => {
    const shown = EvidenceStore.fold([fullLeg()]);
    expect(shown.tradeIds()).toEqual(["t"]);
    expect(shown.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: undefined } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
    expect(shown.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: undefined } })).toEqual({ kind: "UNREAD" });
    expect(shown.judge({ trade: "t", reads: { tradesOk: true, held: true, accounted: () => true, shown: undefined } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
    expect(shown.judge({ trade: "t", reads: { tradesOk: false, held: false, accounted: () => false, shown: undefined } })).toEqual({ kind: "UNREAD" });
  });

  it("(r8, WP290-CX-R8-01) a trade only the user stream NAMED carries the same obligation: a complete read omitting it is a CONFLICT until each of its legs is accounted for", () => {
    for (const named of [
      legRecord("t", { venueOrderId: "x", tokenId: null, side: null, shares: "0.4", price: "0.5" }, null, "NAMED", "STREAM_FILL"),
      legRecord("t", { venueOrderId: "x", tokenId: null, side: null, shares: null, price: null }, "CONFIRMED", "NAMED", "STREAM_SETTLEMENT"),
    ]) {
      const store = EvidenceStore.fold([named]);
      expect(store.tradeIds()).toEqual(["t"]);
      expect(store.trade("t")).toMatchObject({ shown: false, legs: [{ venueOrderId: "x", shown: false }] });
      const verdict = store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: undefined } });
      expect(verdict).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
      expect(verdict.kind === "CONFLICT" ? verdict.problems[0]?.detail : "").toContain("the user stream named");
      // The predicate is asked about the NAMED leg itself.
      const asked: unknown[] = [];
      expect(store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: (leg) => (asked.push(leg), true), shown: undefined } })).toEqual({ kind: "UNREAD" });
      expect(asked).toMatchObject([{ venueOrderId: "x", shown: false }]);
      // A read that shows the trade answers it.
      expect(store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: trade() } }).kind).toBe("CONSISTENT");
    }
  });

  it("(r8, WP290-CX-R8-01) a leg the stream named that a read of its trade does not show is a CONFLICT until accounted for; a leg a read showed missing is one regardless", () => {
    const named = legRecord("t", { venueOrderId: "y", tokenId: null, side: null, shares: null, price: null }, "CONFIRMED", "NAMED", "STREAM_SETTLEMENT");
    const store = EvidenceStore.fold([named, leg("0.4")]);
    expect(store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => false, shown: trade() } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
    expect(store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: (entry) => entry.venueOrderId === "y", shown: trade() } }).kind).toBe("CONSISTENT");
    const shownTwice = EvidenceStore.fold([legRecord("t", { venueOrderId: "y", tokenId: "1", side: "BUY", shares: "0.1", price: "0.5" }, "CONFIRMED", "SHOWN", "TRADES_LEG"), leg("0.4")]);
    expect(shownTwice.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: trade() } })).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
  });

  it("(r8, WP290-CX-R8-02) CONFIRMED and FAILED, from any source and run, are a durable contradiction: a read repeating either never ends it; forward progress to one is no contradiction", () => {
    const failedStream = legRecord("t", { venueOrderId: "x", tokenId: null, side: null, shares: null, price: null }, "FAILED", "NAMED", "STREAM_SETTLEMENT");
    for (const [first, second] of [
      [leg("0.4", "t", "CONFIRMED"), leg("0.4", "t", "FAILED")],
      [leg("0.4", "t", "FAILED"), leg("0.4", "t", "TRADE_STATUS_CONFIRMED")],
      [leg("0.4", "t", "CONFIRMED"), failedStream],
    ] as const) {
      const store = EvidenceStore.fold([first]);
      // The second terminal status is information (journaled), even once every other status text has been seen.
      expect(store.add(second)).toBe(true);
      expect(store.trade("t")?.terminals).toHaveLength(2);
      const rebuilt = EvidenceStore.fold([first, second]);
      for (const status of ["CONFIRMED", "FAILED", "TRADE_STATUS_CONFIRMED"]) {
        const verdict = rebuilt.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: trade({ status }) } });
        expect(verdict).toMatchObject({ kind: "CONFLICT", problems: [{ breakClass: "READ_CONFLICT" }] });
        expect(verdict.kind === "CONFLICT" ? verdict.problems.map((entry) => entry.detail).join(" ") : "").toContain("both CONFIRMED and FAILED");
      }
      expect(rebuilt.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: undefined } }).kind).toBe("CONFLICT");
    }
    // A terminal status is never dropped: the bounded list of status texts may be full.
    const crowded = EvidenceStore.fold([leg("0.4", "t", "CONFIRMED"), ...Array.from({ length: 20 }, (_, index) => leg("0.4", "t", `STATUS_${String(index)}`))]);
    expect(crowded.add(leg("0.4", "t", "FAILED"))).toBe(true);
    expect(crowded.trade("t")?.terminals).toEqual(["CONFIRMED", "FAILED"]);
    // Forward progress (MATCHED, MINED, RETRYING, then ONE terminal status) is no contradiction.
    const forward = EvidenceStore.fold(["MATCHED", "MINED", "RETRYING", "MINED", "CONFIRMED"].map((status) => leg("0.4", "t", status)));
    expect(forward.trade("t")).toMatchObject({ status: "CONFIRMED", terminals: ["CONFIRMED"] });
    expect(forward.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: trade() } })).toEqual({ kind: "CONSISTENT", status: "CONFIRMED" });
    const failing = EvidenceStore.fold(["MATCHED", "RETRYING", "FAILED"].map((status) => leg("0.4", "t", status)));
    expect(failing.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: trade({ status: "FAILED" }) } })).toEqual({ kind: "CONSISTENT", status: "FAILED" });
    // This read's own status counts: one terminal in the evidence, the other in the read.
    const confirmed = EvidenceStore.fold([leg("0.4", "t", "CONFIRMED")]);
    const verdict = confirmed.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: trade({ status: "FAILED", ownLegs: [], ownershipUndetermined: true }) } });
    expect(verdict.kind === "CONFLICT" ? verdict.problems.map((entry) => entry.detail).join(" ") : "").toContain("both CONFIRMED and FAILED");
  });

  it("an order a trade names (a settlement the stream reported, its shares unknown) matched something: a read showing nothing matched is a CONFLICT", () => {
    const store = EvidenceStore.fold([legRecord("t", { venueOrderId: "x", tokenId: null, side: null, shares: null, price: null }, "CONFIRMED", "NAMED", "STREAM_SETTLEMENT")]);
    expect(store.order("x")).toMatchObject({ tradeCount: 1, legSum: "0" });
    store.beginRun();
    expect(judge(store, { byId: order({ status: "CANCELED" }) }).kind).toBe("CONFLICT");
    expect(judge(store, { byId: order({ status: "CANCELED", sizeMatched: "0.4" }) }).kind).toBe("CONSISTENT");
  });

  it("the journal keeps a leg's fill facts, refuses them on any other record, and refuses one out of shape", async () => {
    const opened = ReconciliationJournal.open({ accountRef: "account-1", history: [], sink: { append: async () => undefined } });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const journal = opened.value;
    const event = (record: EvidenceRecord, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: "EVIDENCE_RECORDED", runId: null, ...record, ...extra, atMs: 1 });
    expect((await journal.append(event(fullLeg({ feeAmount: "0.004", feeAssetId: "pusd" })))).ok).toBe(true);
    expect(readEvidenceRecords(journal.evidence())?.[0]).toMatchObject({ feeAmount: "0.004", feeAssetId: "pusd", role: "MAKER", matchedAt: "2026-10-03T00:00:00Z" });
    expect((await journal.append(event(shownOrder(order(), "BY_ID"), { feeAmount: "0" }))).ok).toBe(false);
    expect((await journal.append(event(fullLeg(), { role: "BOTH" }))).ok).toBe(false);
    expect((await journal.append(event(fullLeg(), { matchedAt: "yesterday" }))).ok).toBe(false);
    expect((await journal.append(event(fullLeg(), { feeAmount: "0.10" }))).ok).toBe(false);
    expect(readEvidenceRecord({ ...fullLeg(), feeAmount: "0.10" })).toBeUndefined();
    expect(readEvidenceRecord({ ...shownOrder(order(), "BY_ID"), role: "MAKER" })).toBeUndefined();
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
