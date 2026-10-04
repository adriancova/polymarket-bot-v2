/**
 * WP-290 r11 units: the rules the round-11 fixes rest on, one at a time.
 *
 * - WP290-V11-UNKEYED-STATUS-DROPPED / WP290-CX-R11-01: a witness answers an unkeyed leg only when its settlement
 *   agrees with the status the unkeyed row showed (`settlementAgrees`), and every candidate must agree (an ambiguous
 *   assignment holds); the status is part of the observation (dedup), journaled and replayed.
 * - The class fix at the door layer: the record kinds every fragment reaches the store in (`ORDER` and `LEG` with
 *   fragments, `ORPHAN_LEG`, `UNKEYED_ORDER`, `UNKEYED_TRADE`, `UNKEYED_LEG` that no read answers, `HOLDING`,
 *   `MEMBER`, `BY_ID_FOUND`), what the store decides on each, and the shape BOTH journal doors (the coordinator's
 *   `readEvidenceRecord` and the ledger's `ReconciliationJournal`) enforce for each, alike; and the stream door.
 *
 * PAPER only: pure units; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { ReconciliationJournal } from "../../../packages/ledger/src/index.js";
import type { VenueOrderView, VenueTradeView } from "../../../packages/oms/src/index.js";
import { readStreamOutput, readTrades } from "../../../packages/oms/src/reconciliation/door.js";
import {
  EvidenceStore,
  holdingRecord,
  legRecord,
  memberRecord,
  namedOrder,
  orderFragmentsRecord,
  orphanLegRecord,
  readEvidenceRecord,
  readEvidenceRecords,
  settlementAgrees,
  shownOrder,
  tradeRecord,
  unkeyedFragmentsLegRecord,
  unkeyedLegRecord,
  unkeyedOrderRecord,
  unkeyedTradeRecord,
  type EvidenceRecord,
  type PartialLeg,
} from "../../../packages/oms/src/reconciliation/evidence.js";

type Leg = VenueTradeView["ownLegs"][number];
type Row = Record<string, unknown>;

const ORDER: VenueOrderView = { venueOrderId: "venue-1", tokenId: "1", side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0.8", status: "LIVE" };
const LEG: Leg = { venueOrderId: "venue-1", role: "MAKER", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" };
const PARTIAL: PartialLeg = { ...LEG, unreadable: [] };

/** A record as written before r11: none of the four r11 fields. */
function preR11(record: EvidenceRecord): Row {
  const copy: Row = { ...record };
  for (const key of ["unreadable", "transactionHash", "subject", "value"]) delete copy[key];
  return copy;
}

function keyed(tradeId: string, status: string, leg: Leg = LEG): EvidenceRecord {
  return legRecord(tradeId, { ...leg }, status, "SHOWN", "TRADES_LEG");
}

describe("WP-290 r11 units (WP290-V11-UNKEYED-STATUS-DROPPED): a witness's settlement must agree with the unkeyed row's status", () => {
  it("(settlementAgrees) the same terminal status, never the other; a status at or after a non-terminal one; an unreadable or unrecognised status fixes nothing", () => {
    const at = (status: "MATCHED" | "MINED" | "RETRYING" | "CONFIRMED" | "FAILED" | null, terminals: ("CONFIRMED" | "FAILED")[] = []): { status: typeof status; terminals: typeof terminals } => ({ status, terminals });
    // Terminal rows.
    expect(settlementAgrees(at("FAILED", ["FAILED"]), "FAILED")).toBe(true);
    expect(settlementAgrees(at("FAILED", ["FAILED"]), "TRADE_STATUS_FAILED")).toBe(true);
    expect(settlementAgrees(at("CONFIRMED", ["CONFIRMED"]), "FAILED")).toBe(false);
    expect(settlementAgrees(at("MINED"), "FAILED")).toBe(false);
    expect(settlementAgrees(at("MATCHED"), "CONFIRMED")).toBe(false);
    expect(settlementAgrees(at(null), "CONFIRMED")).toBe(false);
    expect(settlementAgrees(at("CONFIRMED", ["CONFIRMED", "FAILED"]), "CONFIRMED")).toBe(false);
    // Non-terminal rows: the witness at the row's status or after it, never before.
    expect(settlementAgrees(at("MINED"), "MINED")).toBe(true);
    expect(settlementAgrees(at("CONFIRMED", ["CONFIRMED"]), "MINED")).toBe(true);
    expect(settlementAgrees(at("FAILED", ["FAILED"]), "MATCHED")).toBe(true);
    expect(settlementAgrees(at("RETRYING"), "MINED")).toBe(true);
    expect(settlementAgrees(at("MATCHED"), "MINED")).toBe(false);
    expect(settlementAgrees(at(null), "MATCHED")).toBe(false);
    expect(settlementAgrees(at("FAILED", ["CONFIRMED", "FAILED"]), "MATCHED")).toBe(false);
    // (r13, the closed-vocabulary audit) An unreadable status, or one outside the documented vocabulary, is not
    // "nothing to compare": it could have been FAILED. Only a witness at ONE terminal status answers it (r11 answered
    // it with any witness; these two assertions stated that, and are restated here under the r13 rule).
    expect(settlementAgrees(at(null), null)).toBe(false);
    expect(settlementAgrees(at("MATCHED"), "MATCHED_NOT_BROADCASTED")).toBe(false);
    expect(settlementAgrees(at("MINED"), null)).toBe(false);
    expect(settlementAgrees(at("CONFIRMED", ["CONFIRMED"]), "MATCHED_NOT_BROADCASTED")).toBe(true);
    expect(settlementAgrees(at("FAILED", ["FAILED"]), null)).toBe(true);
    expect(settlementAgrees(at("CONFIRMED", ["CONFIRMED"]), "Failed")).toBe(true);
    expect(settlementAgrees(at("FAILED", ["CONFIRMED", "FAILED"]), null)).toBe(false);
    expect(settlementAgrees(at("CONFIRMED", ["CONFIRMED", "FAILED"]), "MATCHED_NOT_BROADCASTED")).toBe(false);
  });

  it("(store) a FAILED unkeyed leg: a CONFIRMED or MINED witness never answers it; a FAILED one does; after a rebuild too", () => {
    for (const witness of ["CONFIRMED", "MINED"]) {
      const records = [shownOrder(ORDER, "OPEN_ORDERS_LIST"), unkeyedLegRecord(LEG, "FAILED", 1, true), keyed("trade-2", witness)];
      for (const store of [EvidenceStore.fold(records), (() => { const live = new EvidenceStore(); for (const record of records) live.add(record); return live; })()]) {
        expect(store.unaccountedUnkeyed("venue-1").map((fill) => [fill.status, fill.shown, fill.disagreeing])).toEqual([["FAILED", ["trade-2"], ["trade-2"]]]);
      }
    }
    const answered = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), unkeyedLegRecord(LEG, "FAILED", 1, true), keyed("trade-2", "MINED")]);
    answered.add(keyed("trade-2", "FAILED"));
    expect(answered.unaccountedUnkeyed("venue-1")).toEqual([]);
  });

  it("(store) every candidate must agree: one that disagrees holds the leg, however many agree (an ambiguous assignment)", () => {
    const store = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), unkeyedLegRecord(LEG, "FAILED", 1, true), keyed("trade-2", "FAILED"), keyed("trade-3", "CONFIRMED")]);
    expect(store.unaccountedUnkeyed("venue-1").map((fill) => [fill.shown, fill.disagreeing])).toEqual([[["trade-2", "trade-3"], ["trade-3"]]]);
  });

  it("(store) the grouping case: one fill's rows CONFIRMED and FAILED owe two trades, each agreeing with both: never met by CONFIRMED witnesses, nor by one of each", () => {
    const records = [shownOrder(ORDER, "OPEN_ORDERS_LIST"), unkeyedLegRecord(LEG, "CONFIRMED", 2, true), unkeyedLegRecord(LEG, "FAILED", 2, true)];
    const confirmed = EvidenceStore.fold([...records, keyed("trade-2", "CONFIRMED"), keyed("trade-3", "CONFIRMED")]);
    expect(confirmed.unaccountedUnkeyed("venue-1").map((fill) => [fill.status, fill.need, fill.disagreeing])).toEqual([["FAILED", 2, ["trade-2", "trade-3"]]]);
    const mixed = EvidenceStore.fold([...records, keyed("trade-2", "CONFIRMED"), keyed("trade-3", "FAILED")]);
    expect(mixed.unaccountedUnkeyed("venue-1").map((fill) => [fill.status, fill.disagreeing])).toEqual([
      ["CONFIRMED", ["trade-3"]],
      ["FAILED", ["trade-2"]],
    ]);
  });

  it("(store) an unkeyed row whose STATUS (or hash) was unreadable: named on the record, and (r13) answerable only by a witness at one terminal status, as a keyed trade whose status was unreadable", () => {
    const record = unkeyedLegRecord(LEG, null, 1, true, null, ["status"]);
    expect(record.unreadable).toEqual(["status"]);
    expect(readEvidenceRecord({ ...record })).toEqual(record);
    // r11 answered it with a witness of ANY settlement (MATCHED included); r13: only a terminal one.
    for (const witness of ["CONFIRMED", "FAILED"]) {
      const store = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), record, keyed("trade-2", witness)]);
      expect(store.unaccountedUnkeyed("venue-1"), witness).toEqual([]);
    }
    for (const witness of ["MATCHED", "MINED", "RETRYING"]) {
      const store = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), record, keyed("trade-2", witness)]);
      expect(store.unaccountedUnkeyed("venue-1").map((fill) => [fill.status, fill.disagreeing]), witness).toEqual([[null, ["trade-2"]]]);
    }
    // A fill fact unreadable is another matter: never answered (and not the answerable source's shape).
    expect(readEvidenceRecord({ ...record, unreadable: ["feeAmount"] })).toBeUndefined();
  });

  it("(store) the status, the unreadable facts and the row's hash are part of the observation: each new one is information, journaled; the same one is not", () => {
    const store = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST")]);
    expect(store.add(unkeyedLegRecord(LEG, "FAILED", 1, true))).toBe(true);
    expect(store.add(unkeyedLegRecord(LEG, "FAILED", 1, true))).toBe(false);
    expect(store.add(unkeyedLegRecord(LEG, "CONFIRMED", 1, true))).toBe(true);
    expect(store.add(unkeyedLegRecord(LEG, "FAILED", 1, true, "0xa"))).toBe(true);
    expect(store.add(unkeyedLegRecord(LEG, null, 1, true))).toBe(true);
    expect(store.unaccountedUnkeyed("venue-1").map((fill) => fill.status)).toEqual(["FAILED", "CONFIRMED", "FAILED", null]);
  });
});

describe("WP-290 r11 units (the class fix): every fragment reaches the store; what the store decides on each", () => {
  it("(orders) a NAMED row keeps every fragment it validated: its matched size bounds a later read, its fixed facts are compared", () => {
    const fragments = { venueOrderId: "venue-1", tokenId: "1", side: "BUY" as const, price: null, originalSize: "1", sizeMatched: "0.8", status: "LIVE", unreadable: ["price" as const], inFull: null };
    const store = EvidenceStore.fold([orderFragmentsRecord(fragments, "OPEN_ORDERS_ID")]);
    expect(store.order("venue-1")).toMatchObject({ shown: false, observedMatched: "0.8", tokenId: "1", side: "BUY" });
    const lagging = store.judge({ order: "venue-1", reads: { claimed: true, listed: { ...ORDER, sizeMatched: "0.4" }, byId: undefined, legs: [] } });
    expect(lagging.kind === "CONFLICT" ? lagging.problems.map((entry) => entry.breakClass) : lagging.kind).toEqual(["READ_REGRESSION"]);
  });

  it("(orders) a by-id answer's `found: true` makes a later not-found a contradiction (E-14), where an id only NAMED would be a releasable ghost", () => {
    const named = EvidenceStore.fold([namedOrder("venue-1", "STREAM_ORDER")]);
    expect(named.judge({ order: "venue-1", reads: { claimed: false, listed: undefined, byId: null, legs: [] } }).kind).toBe("GHOST");
    const found = EvidenceStore.fold([namedOrder("venue-1", "STREAM_ORDER"), namedOrder("venue-1", "BY_ID_FOUND")]);
    expect(found.order("venue-1")?.found).toBe(true);
    const verdict = found.judge({ order: "venue-1", reads: { claimed: false, listed: undefined, byId: null, legs: [] } });
    expect(verdict.kind === "CONFLICT" ? verdict.problems[0]?.detail : verdict.kind).toContain("a by-id answer said it was found");
  });

  it("(account obligations) an unkeyed order row, a legless unkeyed trade row, a leg with neither id: each held, in fold order, once; replayed the same", () => {
    const order = unkeyedOrderRecord({ venueOrderId: null, tokenId: "1", side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0.4", status: "LIVE", unreadable: ["venueOrderId"] }, "OPEN_ORDERS_UNKEYED");
    const trade = unkeyedTradeRecord({ status: "CONFIRMED", transactionHash: null, ownershipUndetermined: true, unreadable: ["venueTradeId"] }, "TRADES_ROW_UNKEYED");
    const leg = unkeyedFragmentsLegRecord({ ...PARTIAL, venueOrderId: null, unreadable: ["venueOrderId"] }, "MINED", 1, "TRADES_LEG_UNKEYED_FRAGMENTS");
    const live = new EvidenceStore();
    expect([order, trade, leg, order].map((record) => live.add(record))).toEqual([true, true, true, false]);
    expect(live.accountObligations().map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
    expect(live.accountObligations()[0]?.detail).toContain("an order row whose venue order id was unreadable");
    expect(live.accountObligations()[1]?.detail).toContain("a trade row whose trade id was unreadable");
    expect(live.accountObligations()[2]?.detail).toContain("trade and order ids were both unreadable");
    expect(EvidenceStore.fold([order, trade, leg]).accountObligations()).toEqual(live.accountObligations());
  });

  it("(unkeyed legs no read answers) a fact unreadable, the stream's, or a partial answer's: never met, whatever the reads show", () => {
    for (const record of [
      unkeyedFragmentsLegRecord({ ...PARTIAL, feeAmount: null, unreadable: ["feeAmount"] }, "CONFIRMED", 1, "TRADES_LEG_UNKEYED_FRAGMENTS"),
      unkeyedFragmentsLegRecord(PARTIAL, null, 1, "STREAM_FILL_UNKEYED"),
      unkeyedLegRecord(LEG, "CONFIRMED", 1, false),
    ]) {
      const store = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), record, keyed("trade-2", "CONFIRMED"), keyed("trade-3", "CONFIRMED")]);
      expect(store.unaccountedUnkeyed("venue-1").map((fill) => fill.never), record.source).toEqual([true]);
    }
  });

  it("(orphan legs) the trade is open until a valid row shows its legs in full; then the orphan must be one of them (a fact it could not read is not compared)", () => {
    const orphan = orphanLegRecord("trade-1", { ...PARTIAL, venueOrderId: null, feeAmount: null, unreadable: ["feeAmount", "venueOrderId"] }, "CONFIRMED", "TRADES_LEG_ORPHAN");
    const open = EvidenceStore.fold([orphan]);
    expect(open.trade("trade-1")).toMatchObject({ identityOpen: true, status: "CONFIRMED" });
    const omitted = open.judge({ trade: "trade-1", reads: { tradesOk: true, shown: undefined, held: false, accounted: () => true } });
    expect(omitted.kind).toBe("CONFLICT");
    const shown = { venueTradeId: "trade-1", status: "CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: [LEG] };
    const matched = EvidenceStore.fold([orphan, tradeRecord("trade-1", "CONFIRMED", "TRADES_ROW"), keyed("trade-1", "CONFIRMED")]);
    expect(matched.judge({ trade: "trade-1", reads: { tradesOk: true, shown, held: false, accounted: () => true } }).kind).toBe("CONSISTENT");
    const other = { ...LEG, shares: "0.3" };
    const contradicted = EvidenceStore.fold([orphan, tradeRecord("trade-1", "CONFIRMED", "TRADES_ROW"), keyed("trade-1", "CONFIRMED", other)]);
    const verdict = contradicted.judge({ trade: "trade-1", reads: { tradesOk: true, shown: { ...shown, ownLegs: [other] }, held: false, accounted: () => true } });
    expect(verdict.kind === "CONFLICT" ? verdict.problems.map((entry) => entry.detail).join(" | ") : verdict.kind).toContain("whose venue order id was unreadable");
  });

  it("(holdings) kept as detail, journaled only when they change; (members) every terminal state and amount credited is kept", () => {
    const store = new EvidenceStore();
    const position = holdingRecord({ kind: "POSITION", key: "1", value: "0.4", unreadable: [] });
    expect([store.add(position), store.add(position), store.add(holdingRecord({ kind: "POSITION", key: "1", value: "0.8", unreadable: [] }))]).toEqual([true, false, true]);
    expect(store.add(holdingRecord({ kind: "POSITION", key: null, value: "0.8", unreadable: ["tokenId"] }))).toBe(true);
    expect([...store.holdings().keys()]).toHaveLength(2);
    expect(store.add(memberRecord("hash:0xa", { state: "FAILED", transactionHash: "0xa", credited: null, unreadable: ["credited"] }))).toBe(true);
    expect(store.add(memberRecord("hash:0xa", { state: "CONFIRMED", transactionHash: "0xa", credited: "5", unreadable: [] }))).toBe(true);
    expect(store.add(memberRecord("hash:0xa", { state: "CONFIRMED", transactionHash: "0xa", credited: "5", unreadable: [] }))).toBe(false);
    expect(store.memberEvidence("hash:0xa")).toMatchObject({ terminals: ["FAILED", "CONFIRMED"], credited: ["5"] });
  });
});

describe("WP-290 r11 units (the class fix): both journal doors keep every new kind in its shape, alike, and replay it", () => {
  const order = unkeyedOrderRecord({ venueOrderId: null, tokenId: "1", side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0.4", status: "LIVE", unreadable: ["venueOrderId"] }, "OPEN_ORDERS_UNKEYED");
  const good: readonly EvidenceRecord[] = [
    order,
    unkeyedTradeRecord({ status: "CONFIRMED", transactionHash: "0xh", ownershipUndetermined: false, unreadable: ["venueTradeId"] }, "TRADES_ROW_UNKEYED"),
    unkeyedFragmentsLegRecord({ ...PARTIAL, feeAmount: null, unreadable: ["feeAmount"] }, "CONFIRMED", 1, "TRADES_LEG_UNKEYED_FRAGMENTS", "0xh"),
    unkeyedFragmentsLegRecord({ ...PARTIAL, venueOrderId: null, unreadable: ["venueOrderId"] }, null, 1, "STREAM_FILL_UNKEYED"),
    orphanLegRecord("trade-1", { ...PARTIAL, venueOrderId: null, unreadable: ["venueOrderId"] }, "MINED", "TRADES_LEG_ORPHAN", "0xh"),
    orderFragmentsRecord({ venueOrderId: "venue-1", tokenId: null, side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0.8", status: "LIVE", unreadable: ["tokenId"], inFull: null }, "OPEN_ORDERS_ID"),
    legRecord("trade-1", { ...LEG, feeAmount: null }, "CONFIRMED", "NAMED", "TRADES_LEG_FRAGMENTS", ["feeAmount"]),
    legRecord("trade-1", { venueOrderId: "venue-1", tokenId: null, side: null, shares: null, price: null }, "MINED", "NAMED", "STREAM_SETTLEMENT", [], "0xh"),
    tradeRecord("trade-1", "CONFIRMED", "TRADES_ROW_ID", { transactionHash: "0xh", ownershipUndetermined: false, unreadable: ["ownLegs"] }),
    namedOrder("venue-1", "BY_ID_FOUND"),
    holdingRecord({ kind: "POSITION", key: "1", value: "0.4", unreadable: [] }),
    holdingRecord({ kind: "APPROVAL", key: "0xspender", value: "true", unreadable: [] }),
    holdingRecord({ kind: "COLLATERAL", key: null, value: "1000", unreadable: ["assetId"] }),
    memberRecord("hash:0xa", { state: "CONFIRMED", transactionHash: "0xa", credited: "5", unreadable: [] }),
    memberRecord("id:r1", { state: null, transactionHash: null, credited: null, unreadable: ["state"] }),
  ];
  const bad: readonly (readonly [string, EvidenceRecord, Row])[] = [
    ["an unkeyed order naming an order", order, { venueOrderId: "venue-1" }],
    ["an unkeyed order SHOWN", order, { provenance: "SHOWN" }],
    ["an unkeyed order from a list source", order, { source: "OPEN_ORDERS_ROW" }],
    ["an unknown unreadable name", order, { unreadable: ["nonsense"] }],
    ["an unsorted unreadable list", order, { unreadable: ["venueOrderId", "price"] }],
    ["an orphan with no trade", good[4] as EvidenceRecord, { venueTradeId: null }],
    ["an orphan naming its order", good[4] as EvidenceRecord, { venueOrderId: "venue-1" }],
    ["an orphan with a level", good[4] as EvidenceRecord, { level: 1 }],
    ["a holding with a status", good[10] as EvidenceRecord, { status: "LIVE" }],
    ["a holding of economics", good[10] as EvidenceRecord, { size: "1" }],
    ["an approval that is not a flag", good[11] as EvidenceRecord, { value: "1" }],
    ["a position that is not a decimal", good[10] as EvidenceRecord, { value: "x" }],
    ["a member with no member", good[13] as EvidenceRecord, { subject: null }],
    ["a member's credit not a decimal", good[13] as EvidenceRecord, { value: "five" }],
    ["a member SHOWN with an unreadable field", good[14] as EvidenceRecord, { provenance: "SHOWN" }],
    ["a found flag with a size", good[9] as EvidenceRecord, { size: "1" }],
    ["a trade's ownership flag misspelled", good[8] as EvidenceRecord, { value: "YES" }],
    ["an order with a hash", good[5] as EvidenceRecord, { transactionHash: "0xh" }],
    ["an order with a subject", good[5] as EvidenceRecord, { subject: "x" }],
    ["a stream unkeyed leg SHOWN", good[3] as EvidenceRecord, { provenance: "SHOWN" }],
    ["an answerable unkeyed leg with an unreadable fact", unkeyedLegRecord(LEG, "MINED", 1, true), { unreadable: ["feeAmount"] }],
    ["an answerable unkeyed leg with no order", unkeyedLegRecord(LEG, "MINED", 1, true), { venueOrderId: null }],
    ["a holding source on an order", shownOrder(ORDER, "OPEN_ORDERS_LIST"), { source: "POSITIONS" }],
  ];

  it("(the coordinator's door) every good shape is read back equal; every bad one is refused; a record written before r11 (none of the four r11 fields) reads with them empty", () => {
    for (const record of good) expect(readEvidenceRecord({ ...record }), `${record.evidenceKind} ${record.source}`).toEqual(record);
    for (const [label, record, change] of bad) expect(readEvidenceRecord({ ...record, ...change }), label).toBeUndefined();
    expect(readEvidenceRecord(preR11(shownOrder(ORDER, "OPEN_ORDERS_LIST")))).toEqual(shownOrder(ORDER, "OPEN_ORDERS_LIST"));
  });

  it("(the ledger's journal) the same: every good shape appended and replayed; every bad one refused; a pre-r11 record accepted", async () => {
    const events: unknown[] = [];
    const opened = ReconciliationJournal.open({ accountRef: "account-1", history: [], sink: { append: async (event) => void events.push(event) } });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const journal = opened.value;
    const event = (record: Row): Row => ({ kind: "EVIDENCE_RECORDED", runId: null, ...record, atMs: 1 });
    for (const record of good) expect((await journal.append(event({ ...record }))).ok, `${record.evidenceKind} ${record.source}`).toBe(true);
    for (const [label, record, change] of bad) expect((await journal.append(event({ ...record, ...change }))).ok, label).toBe(false);
    expect((await journal.append(event(preR11(shownOrder(ORDER, "OPEN_ORDERS_LIST"))))).ok).toBe(true);
    expect(readEvidenceRecords(journal.evidence())).toEqual([...good, shownOrder(ORDER, "OPEN_ORDERS_LIST")]);
    const replayed = ReconciliationJournal.open({ accountRef: "account-1", history: events as never, sink: { append: async () => undefined } });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    const records = readEvidenceRecords(replayed.value.evidence()) ?? [];
    expect(records).toEqual([...good, shownOrder(ORDER, "OPEN_ORDERS_LIST")]);
    expect(EvidenceStore.fold(records).accountObligations()).toHaveLength(3);
  });
});

describe("WP-290 r11 units (the stream door): every item read on its own; an entry or list that is not own data is unreadable, never dropped with its siblings", () => {
  const fill = { venueTradeId: "t1", venueOrderId: "venue-1", shares: "0.4", price: "0.5", liquidityRole: "MAKER", matchedAt: "2026-10-03T00:00:00Z" };

  it("a fills list with an opaque entry keeps its other items; an inexact share keeps the trade and order ids; an unreadable list is one unreadable entry", () => {
    const fills: unknown[] = [{ ...fill }, { ...fill, venueTradeId: "t2" }];
    Object.defineProperty(fills, "0", { get: () => fill, enumerable: true });
    const read = readStreamOutput({ kind: "TRADE", oms: { fills, settlements: [{ venueTradeId: "t3", venueOrderId: "venue-1", status: 7 }], shortfalls: [] } });
    expect(read.items.map((item) => [item.fragments.kind, item.fragments.venueTradeId, item.fragments.unreadable])).toEqual([
      ["FILL", "t2", []],
      ["SETTLEMENT", "t3", ["status"]],
    ]);
    expect(read.unreadable).toEqual([{ kind: "FILL", field: "entry" }]);
    // (r12) Every input carries both lists, as WP-280 always does: a MISSING list is itself an unreadable entry.
    const inexact = readStreamOutput({ kind: "TRADE", oms: { fills: [{ ...fill, shares: "0.40" }], settlements: [] } });
    expect(inexact.items.map((item) => [item.fragments.venueTradeId, item.fragments.venueOrderId, item.fragments.shares, item.fragments.feeAmount, item.fragments.unreadable])).toEqual([["t1", "venue-1", null, null, ["shares"]]]);
    expect(readStreamOutput({ kind: "TRADE", oms: { fills: "not a list", settlements: [] } }).unreadable).toEqual([{ kind: "FILL", field: "fills" }]);
    expect(readStreamOutput({ kind: "TRADE" }).unreadable).toEqual([{ kind: "FILL", field: "oms" }]);
    expect(readStreamOutput({ kind: "STATE" })).toMatchObject({ kind: null, unreadable: [] });
    // An output whose kind cannot be read may have been a TRADE: it is one unreadable entry.
    expect(readStreamOutput({ kind: 7, oms: {} })).toMatchObject({ kind: null, unreadable: [{ kind: "FILL", field: "kind" }] });
  });

  it("an order observation whose id is unreadable is an item every readable field of which is kept", () => {
    const read = readStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: 7, status: "CANCELED" } } });
    expect(read.items.map((item) => [item.fragments.venueOrderId, item.fragments.status, item.fragments.unreadable])).toEqual([[null, "CANCELED", ["venueOrderId"]]]);
  });
});

describe("WP-290 r11 units: the trades door keeps an unkeyed row's status per row", () => {
  it("two unkeyed rows of one fill, CONFIRMED and FAILED: both statuses are in the door's output", () => {
    const row = (status: string, id: unknown): Row => ({ venueTradeId: id, status, transactionHash: null, ownershipUndetermined: false, ownLegs: [{ ...LEG }] });
    const outcome = readTrades({ route: "/data/trades", complete: true, trades: [row("CONFIRMED", 42), row("FAILED", "")] });
    expect(outcome.salvage.whole).toBe(true);
    expect(outcome.salvage.trades.map((trade) => [trade.venueTradeId, trade.status, trade.legs[0]?.inFull !== null])).toEqual([
      [null, "CONFIRMED", true],
      [null, "FAILED", true],
    ]);
  });
});
