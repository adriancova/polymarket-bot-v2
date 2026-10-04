/**
 * WP-290 r10 units (WP290-CX-R10-01, WP290-V10-UNKEYED-LEG-DISCHARGED): the by-id door keeps the row of an unusable
 * answer under the row's own id; every salvaging door keeps the rows of an answer one of whose top-level fields is not
 * own data, or one of whose list entries is not, when its route is the right one (the door audit); the evidence store
 * folds UNKEYED_LEG records into a durable obligation that only trades shown by id with exactly the leg's facts, which
 * the evidence did not hold on the order when the leg was seen, meet; the door and the journal keep an UNKEYED_LEG in
 * its shape, and replay it. The integration pins are in `regressions-r10.test.ts`.
 *
 * PAPER only: pure units; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { ReconciliationJournal } from "../../../packages/ledger/src/index.js";
import type { VenueOrderView, VenueTradeView } from "../../../packages/oms/src/index.js";
import { readOpenOrders, readOrderById, readTrades } from "../../../packages/oms/src/reconciliation/door.js";
import {
  EvidenceStore,
  fillFactsOfLeg,
  legRecord,
  readEvidenceRecord,
  readEvidenceRecords,
  shownOrder,
  tradeRecord,
  unkeyedLegRecord,
  type EvidenceRecord,
} from "../../../packages/oms/src/reconciliation/evidence.js";

type Row = Record<string, unknown>;
type Leg = VenueTradeView["ownLegs"][number];

const ORDER: VenueOrderView = { venueOrderId: "venue-1", tokenId: "1", side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0.8", status: "LIVE" };
const LEG: Leg = { venueOrderId: "venue-1", role: "MAKER", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" };

/** An object whose `key` is an accessor (not own data), every other field as given. */
function withAccessor(fields: Row, key: string): Row {
  const copy: Row = { ...fields };
  const value = copy[key];
  delete copy[key];
  Object.defineProperty(copy, key, { get: () => value, enumerable: true });
  return copy;
}

describe("WP-290 r10 units (WP290-CX-R10-01): the by-id door keeps an unusable answer's row under the row's own id", () => {
  const answer = (fields: Row): Row => ({ route: "/data/order", ...fields });

  it("(door) a usable answer is unchanged: found with the order asked about is OK; not found with no order is OK null", () => {
    expect(readOrderById(answer({ found: true, order: { ...ORDER } }), "venue-1")).toEqual({ kind: "OK", value: ORDER });
    expect(readOrderById(answer({ found: false }), "venue-1")).toEqual({ kind: "OK", value: null });
    expect(readOrderById(answer({ found: false, order: null }), "venue-1")).toEqual({ kind: "OK", value: null });
  });

  it("(door) not found but carrying a valid order, found absent or not a boolean: MALFORMED for the order asked about, and the row kept (SHOWN) under its own id", () => {
    for (const fields of [{ found: false, order: { ...ORDER } }, { order: { ...ORDER } }, { found: undefined, order: { ...ORDER } }, { found: "yes", order: { ...ORDER } }]) {
      const outcome = readOrderById(answer(fields), "venue-1");
      expect(outcome.kind).toBe("MALFORMED");
      if (outcome.kind !== "MALFORMED") continue;
      expect(outcome.salvage?.rows).toEqual([ORDER]);
      expect(outcome.named).toEqual(new Map([["venue-1", "1"]]));
    }
  });

  it("(door) a valid row naming ANOTHER order: MALFORMED for the order asked about, the row kept under the id it carries, never relabelled", () => {
    const outcome = readOrderById(answer({ found: true, order: { ...ORDER, venueOrderId: "venue-2" } }), "venue-1");
    expect(outcome.kind).toBe("MALFORMED");
    if (outcome.kind !== "MALFORMED") return;
    expect(outcome.why).toBe("the order answer names another order");
    expect(outcome.salvage?.rows.map((row) => row.venueOrderId)).toEqual(["venue-2"]);
    expect([...(outcome.named ?? new Map()).keys()]).toEqual(["venue-2"]);
  });

  it("(door) an invalid row keeps only its readable id (NAMED); one with no readable id, and an answer of another route, keep nothing", () => {
    const invalid = readOrderById(answer({ found: true, order: { ...ORDER, price: "not a price" } }), "venue-1");
    expect(invalid.kind === "MALFORMED" ? [invalid.named, invalid.salvage] : undefined).toEqual([new Map([["venue-1", null]]), undefined]);
    const notFoundInvalid = readOrderById(answer({ found: false, order: { ...ORDER, venueOrderId: "venue-3", sizeMatched: "2" } }), "venue-1");
    expect(notFoundInvalid.kind === "MALFORMED" ? [notFoundInvalid.named, notFoundInvalid.salvage] : undefined).toEqual([new Map([["venue-3", null]]), undefined]);
    const noId = readOrderById(answer({ found: true, order: { ...ORDER, venueOrderId: 7 } }), "venue-1");
    expect(noId.kind === "MALFORMED" ? [noId.named, noId.salvage] : undefined).toEqual([undefined, undefined]);
    expect(readOrderById({ route: "/v1/order", found: false, order: { ...ORDER } }, "venue-1")).toEqual({ kind: "WRONG_ROUTE", route: "/v1/order" });
  });

  it("(door audit) a by-id answer whose `found` is an accessor keeps its valid row when its route is the right one; with an unreadable or other route, nothing", () => {
    const opaque = readOrderById(withAccessor(answer({ found: true, order: { ...ORDER, venueOrderId: "venue-2" } }), "found"), "venue-1");
    expect(opaque.kind === "MALFORMED" ? [opaque.why, opaque.salvage?.rows.map((row) => row.venueOrderId)] : undefined).toEqual(["the order answer carries a field that is not own data", ["venue-2"]]);
    const noRoute = readOrderById(withAccessor(answer({ found: true, order: { ...ORDER } }), "route"), "venue-1");
    expect(noRoute.kind === "MALFORMED" ? [noRoute.named, noRoute.salvage] : undefined).toEqual([undefined, undefined]);
    const otherRoute = readOrderById(withAccessor({ route: "/v1/order", found: true, order: { ...ORDER } }, "found"), "venue-1");
    expect(otherRoute.kind === "MALFORMED" ? [otherRoute.named, otherRoute.salvage] : undefined).toEqual([undefined, undefined]);
  });
});

describe("WP-290 r10 units (the door audit): an answer with an opaque top-level field keeps its rows when its route is the right one", () => {
  it("(open orders) `complete` an accessor: MALFORMED, every valid row SHOWN and every readable id NAMED", () => {
    const outcome = readOpenOrders(withAccessor({ route: "/data/orders", complete: true, orders: [{ ...ORDER }, { venueOrderId: "venue-9", price: "x" }] }, "complete"));
    expect(outcome.kind).toBe("MALFORMED");
    if (outcome.kind !== "MALFORMED") return;
    expect(outcome.why).toBe("the open-orders answer carries a field that is not own data");
    expect(outcome.salvage?.rows).toEqual([ORDER]);
    expect(outcome.named).toEqual(new Map([["venue-1", "1"], ["venue-9", null]]));
    const otherRoute = readOpenOrders(withAccessor({ route: "/v1/orders", complete: true, orders: [{ ...ORDER }] }, "complete"));
    expect(otherRoute.kind === "MALFORMED" ? [otherRoute.named, otherRoute.salvage] : undefined).toEqual([undefined, undefined]);
  });

  it("(trades) `complete` an accessor: MALFORMED, every trade identity and every valid leg kept", () => {
    const row = { venueTradeId: "t", status: "CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: [{ ...LEG }] };
    const outcome = readTrades(withAccessor({ route: "/data/trades", complete: true, trades: [row] }, "complete"));
    expect(outcome.kind).toBe("MALFORMED");
    if (outcome.kind !== "MALFORMED") return;
    expect(outcome.salvage?.trades).toEqual([{ venueTradeId: "t", status: "CONFIRMED", shape: "IN_FULL" }]);
    expect(outcome.salvage?.legs).toEqual([{ venueTradeId: "t", status: "CONFIRMED", leg: LEG }]);
    const unrouted = readTrades(withAccessor({ route: "/data/trades", complete: true, trades: [row] }, "route"));
    expect(unrouted.kind === "MALFORMED" ? [unrouted.named, unrouted.salvage] : undefined).toEqual([undefined, undefined]);
  });

  it("(trades, WHOLE) an answer is whole only when complete, its list and fields readable, and every row identified (a valid row, a readable trade id, or every own leg valid with its ownership determined)", () => {
    const row = (overrides: Row = {}): Row => ({ venueTradeId: "t", status: "CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: [{ ...LEG }], ...overrides });
    const whole = (raw: unknown): boolean | undefined => {
      const outcome = readTrades(raw);
      // No salvage at all (nothing kept) is never whole either.
      return outcome.kind === "MALFORMED" || outcome.kind === "INCOMPLETE" ? (outcome.salvage?.whole ?? false) : undefined;
    };
    const answer = (trades: unknown[], complete: unknown = true): Row => ({ route: "/data/trades", complete, trades });
    const garbled = row({ venueTradeId: 42 });
    expect(whole(answer([row({ venueTradeId: "t0" }), garbled]))).toBe(true);
    // A readable trade id identifies its row, whatever its legs.
    expect(whole(answer([row({ venueTradeId: "t9", ownLegs: [{ ...LEG, feeAmount: "bad" }] }), garbled]))).toBe(true);
    expect(whole(answer([garbled], false))).toBe(false);
    expect(whole(answer([garbled], "yes"))).toBe(false);
    // A row with no readable id is identified only by every own leg, valid, its ownership determined.
    expect(whole(answer([garbled, row({ venueTradeId: "", ownLegs: [{ ...LEG, venueOrderId: "venue-2", feeAmount: "bad" }] })]))).toBe(false);
    expect(whole(answer([garbled, row({ venueTradeId: 7, ownLegs: [{ ...LEG, venueOrderId: "venue-2" }], ownershipUndetermined: true })]))).toBe(false);
    expect(whole(answer([row({ venueTradeId: 7, ownLegs: [] })]))).toBe(false);
    expect(whole(answer([garbled, row({ venueTradeId: 7, ownLegs: [] })]))).toBe(false);
    expect(whole(answer([garbled, 42]))).toBe(false);
    expect(whole(answer([garbled, row({ venueTradeId: 7, ownershipUndetermined: "no" })]))).toBe(false);
    // A list or an answer that is not own data is never whole.
    const list = [garbled, row({ venueTradeId: "t2" })];
    Object.defineProperty(list, "1", { get: () => row({ venueTradeId: "t2" }), enumerable: true });
    expect(whole(answer(list))).toBe(false);
    expect(whole(withAccessor(answer([garbled]), "complete"))).toBe(false);
  });

  it("(trades) a row whose trade id is a number, empty, or an accessor keeps its valid leg UNKEYED (no trade identity)", () => {
    const row = { venueTradeId: "t", status: "CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: [{ ...LEG }] };
    for (const garbled of [{ ...row, venueTradeId: 42 }, { ...row, venueTradeId: "" }, withAccessor(row, "venueTradeId")]) {
      const outcome = readTrades({ route: "/data/trades", complete: true, trades: [garbled] });
      expect(outcome.kind).toBe("MALFORMED");
      if (outcome.kind !== "MALFORMED") continue;
      expect(outcome.salvage?.trades).toEqual([]);
      expect(outcome.salvage?.legs).toEqual([{ venueTradeId: null, status: "CONFIRMED", leg: LEG }]);
    }
  });
});

describe("WP-290 r10 units (WP290-V10-UNKEYED-LEG-DISCHARGED): an unkeyed leg is an obligation only new trades shown by id with exactly its facts meet", () => {
  const keyed = (tradeId: string, leg: Leg = LEG, source: "TRADES_LEG" | "TRADES_LEG_SALVAGED" = "TRADES_LEG"): EvidenceRecord =>
    legRecord(tradeId, { ...leg }, "CONFIRMED", "SHOWN", source);
  const judgeOrder = (store: EvidenceStore): string => {
    const verdict = store.judge({ order: "venue-1", reads: { claimed: true, listed: { ...ORDER, sizeMatched: "0.8" }, byId: undefined, legs: [] } });
    return verdict.kind === "CONFLICT" ? verdict.problems.map((entry) => entry.detail).join(" | ") : verdict.kind;
  };

  it("(store) the order is a CONFLICT until the reads show, by id and with exactly the leg's facts, a trade the evidence did not hold on the order when the unkeyed leg was seen; after a rebuild too", () => {
    const records = [shownOrder(ORDER, "OPEN_ORDERS_LIST"), keyed("trade-1"), unkeyedLegRecord(LEG, "CONFIRMED", 1, true)];
    for (const store of [EvidenceStore.fold(records), (() => { const live = new EvidenceStore(); for (const record of records) live.add(record); return live; })()]) {
      expect(store.keyedTradesShowing("venue-1", fillFactsOfLeg(LEG))).toEqual(["trade-1"]);
      expect(store.unaccountedUnkeyed("venue-1").map((fill) => [fill.need, fill.known, fill.shown])).toEqual([[1, ["trade-1"], []]]);
      expect(judgeOrder(store)).toContain("in a row whose trade id was unreadable");
      expect(judgeOrder(store)).toContain("the reads owe 1 distinct trade(s) with a leg of exactly those facts on it, shown by a readable id, beyond the 1 it already held there (trade-1), and they have shown 0 (none)");
      // trade-1 shown again cannot answer it: the unkeyed row may have been trade-1.
      store.add(keyed("trade-1", LEG, "TRADES_LEG_SALVAGED"));
      expect(store.unaccountedUnkeyed("venue-1")).toHaveLength(1);
      store.add(keyed("trade-2", LEG, "TRADES_LEG_SALVAGED"));
      expect(store.unaccountedUnkeyed("venue-1")).toEqual([]);
      expect(judgeOrder(store)).toBe("CONSISTENT");
    }
  });

  it("(store) a trade any source named BEFORE the unkeyed leg was seen never answers it, whatever its provenance (a stream settlement's, its facts unknown; a malformed row's identity)", () => {
    const named = legRecord("trade-2", { venueOrderId: "venue-1", tokenId: null, side: null, shares: null, price: null }, "CONFIRMED", "NAMED", "STREAM_SETTLEMENT");
    const store = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), named, unkeyedLegRecord(LEG, null, 1, true)]);
    store.add(keyed("trade-2"));
    expect(store.unaccountedUnkeyed("venue-1").map((fill) => [fill.known, fill.shown])).toEqual([[["trade-2"], []]]);
    store.add(keyed("trade-3"));
    expect(store.unaccountedUnkeyed("venue-1")).toEqual([]);
    // A trade the evidence held only as an identity (a malformed row's readable id, with no leg on the order) was held
    // too: it cannot answer an unkeyed leg seen after it.
    const identity = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), tradeRecord("trade-4", "CONFIRMED", "TRADES_ROW_ID"), unkeyedLegRecord(LEG, null, 1, true)]);
    identity.add(keyed("trade-4"));
    expect(identity.unaccountedUnkeyed("venue-1").map((fill) => [fill.known, fill.shown])).toEqual([[["trade-4"], []]]);
    // Two unkeyed legs of the same facts in one answer owe two trades.
    const two = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), unkeyedLegRecord(LEG, null, 2, true), keyed("trade-5")]);
    expect(two.unaccountedUnkeyed("venue-1").map((fill) => [fill.need, fill.shown])).toEqual([[2, ["trade-5"]]]);
    two.add(keyed("trade-6"));
    expect(two.unaccountedUnkeyed("venue-1")).toEqual([]);
  });

  it("(store) an unkeyed leg of an answer that was NOT whole is never answered, whatever the reads show; it owes nothing more after it", () => {
    const store = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), keyed("trade-1"), unkeyedLegRecord(LEG, null, 1, false)]);
    store.add(keyed("trade-2"));
    store.add(keyed("trade-3"));
    expect(store.unaccountedUnkeyed("venue-1").map((fill) => [fill.partial, fill.known, fill.shown])).toEqual([[true, ["trade-1"], ["trade-2", "trade-3"]]]);
    expect(judgeOrder(store)).toContain("in an answer that did not show every trade of the account");
    // Nothing about the same fill is new information after it; a whole observation before it does not stop it.
    expect(store.add(unkeyedLegRecord(LEG, null, 1, true))).toBe(false);
    expect(store.add(unkeyedLegRecord(LEG, null, 2, false))).toBe(false);
    const after = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), unkeyedLegRecord(LEG, null, 1, true)]);
    expect(after.add(unkeyedLegRecord(LEG, null, 1, false))).toBe(true);
    after.add(keyed("trade-5"));
    expect(after.unaccountedUnkeyed("venue-1").map((fill) => fill.partial)).toEqual([true]);
    // Replayed the same.
    const records = [shownOrder(ORDER, "OPEN_ORDERS_LIST"), unkeyedLegRecord(LEG, null, 1, false), keyed("trade-2")];
    expect(EvidenceStore.fold(records).unaccountedUnkeyed("venue-1").map((fill) => fill.partial)).toEqual([true]);
  });

  it("(store) a trade is a witness only when a read SHOWED its leg with exactly the same facts: another fee, time, side or shares, a stream-only leg, or a leg shown two ways is not", () => {
    const owed = (extra: EvidenceRecord): EvidenceStore => EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST"), unkeyedLegRecord(LEG, null, 1, true), extra]);
    for (const other of [{ ...LEG, feeAmount: "0.01", feeAssetId: "pusd" }, { ...LEG, matchedAt: "2026-10-03T00:00:01Z" }, { ...LEG, shares: "0.3" }, { ...LEG, role: "TAKER" as const }]) {
      expect(owed(keyed("trade-2", other)).unaccountedUnkeyed("venue-1")).toHaveLength(1);
    }
    // The same instant, spelled with another offset, is the same fill (decimals are canonical at every door).
    expect(owed(keyed("trade-2", { ...LEG, matchedAt: "2026-10-03T01:00:00+01:00" })).unaccountedUnkeyed("venue-1")).toEqual([]);
    // A leg only the user stream NAMED is no witness: no read showed it.
    expect(owed(legRecord("trade-2", { ...LEG }, "CONFIRMED", "NAMED", "STREAM_FILL")).unaccountedUnkeyed("venue-1")).toHaveLength(1);
    // A leg shown with two values of a fill fact (a durable contradiction of its own) is no witness either.
    const contradicted = owed(keyed("trade-2"));
    expect(contradicted.unaccountedUnkeyed("venue-1")).toEqual([]);
    contradicted.add(keyed("trade-2", { ...LEG, price: "0.6" }));
    expect(contradicted.unaccountedUnkeyed("venue-1")).toHaveLength(1);
    // A leg with no fee fixed is a witness only for an unkeyed leg with no fee fixed.
    const noFee = { ...LEG, feeAmount: null };
    expect(EvidenceStore.fold([unkeyedLegRecord(noFee, null, 1, true), keyed("trade-2", noFee)]).unaccountedUnkeyed("venue-1")).toEqual([]);
    expect(EvidenceStore.fold([unkeyedLegRecord(noFee, null, 1, true), keyed("trade-2")]).unaccountedUnkeyed("venue-1")).toHaveLength(1);
    expect(EvidenceStore.fold([unkeyedLegRecord(LEG, null, 1, true), keyed("trade-2", noFee)]).unaccountedUnkeyed("venue-1")).toHaveLength(1);
  });

  it("(store) a record is information only when it owes something new: a new fill, more legs, or a trade learned on the order since; a repeated observation is not", () => {
    const store = EvidenceStore.fold([shownOrder(ORDER, "OPEN_ORDERS_LIST")]);
    expect(store.add(unkeyedLegRecord(LEG, "CONFIRMED", 1, true))).toBe(true);
    expect(store.add(unkeyedLegRecord(LEG, "MATCHED", 1, true))).toBe(false);
    expect(store.add(unkeyedLegRecord({ ...LEG, matchedAt: "2026-10-03T00:00:00.000Z" }, "CONFIRMED", 1, true))).toBe(false);
    expect(store.add(unkeyedLegRecord(LEG, "CONFIRMED", 2, true))).toBe(true);
    expect(store.add(unkeyedLegRecord(LEG, "CONFIRMED", 1, true))).toBe(false);
    expect(store.unaccountedUnkeyed("venue-1").map((fill) => fill.need)).toEqual([1, 2]);
    // A trade of those facts shown since: the same garbled answer read again owes a trade beyond it too (fail closed:
    // the unkeyed row may be a new trade the read omits); it is new information, journaled.
    store.add(keyed("trade-1"));
    expect(store.unaccountedUnkeyed("venue-1").map((fill) => fill.need)).toEqual([2]);
    expect(store.add(unkeyedLegRecord(LEG, "CONFIRMED", 1, true))).toBe(true);
    expect(store.unaccountedUnkeyed("venue-1").map((fill) => [fill.need, fill.known])).toEqual([[2, []], [1, ["trade-1"]]]);
    // A new fill (other facts) on the same order is its own obligation; new information unsettles the order.
    const level = store.order("venue-1")?.level ?? -1;
    expect(store.add(unkeyedLegRecord({ ...LEG, shares: "0.2" }, null, 1, true))).toBe(true);
    expect(store.order("venue-1")?.level).toBe(level + 1);
    expect(store.unaccountedUnkeyed("venue-1")).toHaveLength(3);
    // An unkeyed leg is activity the venue showed on its order: the order is SHOWN, its token and side known.
    const fresh = EvidenceStore.fold([unkeyedLegRecord(LEG, null, 1, true)]);
    expect(fresh.order("venue-1")).toMatchObject({ shown: true, tokenId: "1", side: "BUY", settled: false });
  });

  it("(door and journal) an UNKEYED_LEG is a SHOWN own leg with every fill fact, no trade id, and at least one trade owed; it replays to the same obligation", async () => {
    const good = unkeyedLegRecord(LEG, "CONFIRMED", 2, true);
    expect(good).toMatchObject({ evidenceKind: "UNKEYED_LEG", venueOrderId: "venue-1", venueTradeId: null, provenance: "SHOWN", source: "TRADES_LEG_UNKEYED", size: "0.4", level: 2 });
    expect(readEvidenceRecord({ ...good })).toEqual(good);
    expect(readEvidenceRecord({ ...good, feeAmount: null })).toEqual({ ...good, feeAmount: null });
    for (const bad of [
      { level: null },
      { level: 0 },
      { venueTradeId: "t" },
      { venueOrderId: null },
      { provenance: "NAMED" },
      { source: "TRADES_LEG_SALVAGED" },
      { originalSize: "1" },
      { size: null },
      { size: "0" },
      { role: null },
      { matchedAt: null },
      { tokenId: null },
      { side: null },
      { price: null },
    ]) {
      expect(readEvidenceRecord({ ...good, ...bad }), JSON.stringify(bad)).toBeUndefined();
    }
    // An UNKEYED_LEG of an answer that was not whole has its own source; only an UNKEYED_LEG may carry it.
    const partial = unkeyedLegRecord(LEG, "CONFIRMED", 1, false);
    expect(partial.source).toBe("TRADES_LEG_UNKEYED_PARTIAL");
    expect(readEvidenceRecord({ ...partial })).toEqual(partial);
    expect(readEvidenceRecord({ ...shownOrder(ORDER, "TRADES_LEG_UNKEYED_PARTIAL") })).toBeUndefined();
    // Only a SETTLED and an UNKEYED_LEG carry a level; only a LEG and an UNKEYED_LEG carry fill facts.
    expect(readEvidenceRecord({ ...shownOrder(ORDER, "BY_ID_ROW"), level: 1 })).toBeUndefined();
    expect(readEvidenceRecord({ ...shownOrder(ORDER, "BY_ID_ROW") })).toEqual(shownOrder(ORDER, "BY_ID_ROW"));
    const events: unknown[] = [];
    const opened = ReconciliationJournal.open({ accountRef: "account-1", history: [], sink: { append: async (event) => void events.push(event) } });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const journal = opened.value;
    const event = (record: Record<string, unknown>): Record<string, unknown> => ({ kind: "EVIDENCE_RECORDED", runId: null, ...record, atMs: 1 });
    expect((await journal.append(event({ ...good }))).ok).toBe(true);
    for (const bad of [{ level: null }, { level: 0 }, { venueTradeId: "t" }, { venueOrderId: null }, { provenance: "NAMED" }, { originalSize: "1" }, { size: null }, { role: null }, { matchedAt: null }, { tokenId: null }, { side: null }, { price: null }]) {
      expect((await journal.append(event({ ...good, ...bad }))).ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await journal.append(event({ ...shownOrder(ORDER, "BY_ID_ROW"), level: 1 }))).ok).toBe(false);
    expect((await journal.append(event({ ...shownOrder(ORDER, "BY_ID_ROW"), matchedAt: "2026-10-03T00:00:00Z" }))).ok).toBe(false);
    expect(readEvidenceRecords(journal.evidence())).toEqual([good]);
    const replayed = ReconciliationJournal.open({ accountRef: "account-1", history: events as never, sink: { append: async () => undefined } });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    const records = readEvidenceRecords(replayed.value.evidence());
    expect(records).toEqual([good]);
    expect(EvidenceStore.fold(records ?? []).unaccountedUnkeyed("venue-1").map((fill) => fill.need)).toEqual([2]);
  });
});

describe("WP-290 r10 units (the door audit): one list entry that is not own data never drops the others", () => {
  /** A list whose entry at `index` is an accessor (not own data), the others as given. */
  function withOpaqueEntry(entries: unknown[], index: number): unknown[] {
    const list = [...entries];
    Object.defineProperty(list, String(index), { get: () => entries[index], enumerable: true });
    return list;
  }
  const tradeRow = (id: unknown, legs: unknown[]): Row => ({ venueTradeId: id, status: "CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: legs });

  it("(open orders) an opaque row: MALFORMED (the list is not one), every other valid row SHOWN", () => {
    const outcome = readOpenOrders({ route: "/data/orders", complete: true, orders: withOpaqueEntry([{ ...ORDER, venueOrderId: "venue-0" }, { ...ORDER }], 0) });
    expect(outcome.kind === "MALFORMED" ? [outcome.why, outcome.salvage?.rows] : undefined).toEqual(["the open orders are not a list", [ORDER]]);
    const partial = readOpenOrders({ route: "/data/orders", complete: false, orders: withOpaqueEntry([{ ...ORDER, venueOrderId: "venue-0" }, { ...ORDER }], 0) });
    expect(partial.kind === "INCOMPLETE" ? partial.salvage?.rows : undefined).toEqual([ORDER]);
  });

  it("(trades) an opaque row: MALFORMED, every other row's identity and valid legs kept; an opaque leg: the row's other legs kept, unkeyed ones included", () => {
    const outcome = readTrades({ route: "/data/trades", complete: true, trades: withOpaqueEntry([tradeRow("t0", [{ ...LEG }]), tradeRow("t", [{ ...LEG }])], 0) });
    expect(outcome.kind === "MALFORMED" ? [outcome.why, outcome.salvage?.trades.map((trade) => trade.venueTradeId), outcome.salvage?.legs.map((leg) => leg.venueTradeId)] : undefined).toEqual([
      "the trades are not a list",
      ["t"],
      ["t"],
    ]);
    const leg2 = { ...LEG, venueOrderId: "venue-2" };
    const opaqueLeg = readTrades({ route: "/data/trades", complete: true, trades: [tradeRow(42, withOpaqueEntry([{ ...LEG }, leg2], 0))] });
    expect(opaqueLeg.kind === "MALFORMED" ? opaqueLeg.salvage?.legs : undefined).toEqual([{ venueTradeId: null, status: "CONFIRMED", leg: leg2 }]);
  });
});
