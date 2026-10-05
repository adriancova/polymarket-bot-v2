/**
 * WP-290 r9 units (WP290-CX-R9-01, WP290-V9-UNFOLDED-TERMINAL): the door keeps every readable trade identity of an
 * unusable trades answer; the evidence store folds TRADE records (their status, and whether they identified the trade's
 * own legs); the door and the journal keep a TRADE record in its shape, and replay it. The integration pins are in
 * `regressions-r9.test.ts`.
 *
 * PAPER only: pure units; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { ReconciliationJournal } from "../../../packages/ledger/src/index.js";
import type { VenueTradeView } from "../../../packages/oms/src/index.js";
import { readTrades } from "../../../packages/oms/src/reconciliation/door.js";
import { EvidenceStore, legRecord, readEvidenceRecord, readEvidenceRecords, tradeRecord, type EvidenceRecord } from "../../../packages/oms/src/reconciliation/evidence.js";

import { legsOf, tradesOf } from "./support/salvage.js";

type Row = Record<string, unknown>;

describe("WP-290 r9 units: the door keeps every readable trade identity; the store folds TRADE records; the journal keeps them", () => {
  const LEG = { venueOrderId: "venue-1", role: "MAKER", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" };
  const row = (overrides: Row = {}): Row => ({ venueTradeId: "t", status: "CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: [LEG], ...overrides });
  const answer = (trades: unknown[], complete = true): unknown => ({ route: "/data/trades", complete, trades });

  it("(door) a malformed leg, a legless row of an incomplete answer, an unreadable leg list: the trade id is kept with its status; an unreadable trade id keeps no trade", () => {
    // (r11) The door's salvage is read through `support/salvage.ts`: the same views the r9 door returned.
    const malformedLeg = readTrades(answer([row({ ownLegs: [{ ...LEG, feeAmount: "bad" }] })]));
    expect(malformedLeg.kind).toBe("MALFORMED");
    if (malformedLeg.kind !== "MALFORMED") return;
    expect(tradesOf(malformedLeg)).toEqual([{ venueTradeId: "t", status: "CONFIRMED", shape: "MALFORMED" }]);
    expect(legsOf(malformedLeg)).toEqual([]);
    const legless = readTrades(answer([row({ ownershipUndetermined: true, ownLegs: [] })], false));
    expect(legless.kind).toBe("INCOMPLETE");
    if (legless.kind !== "INCOMPLETE") return;
    expect(tradesOf(legless)).toEqual([{ venueTradeId: "t", status: "CONFIRMED", shape: "OWNERSHIP_UNDETERMINED" }]);
    const inFull = readTrades(answer([row()], false));
    expect(inFull.kind === "INCOMPLETE" ? tradesOf(inFull) : undefined).toEqual([{ venueTradeId: "t", status: "CONFIRMED", shape: "IN_FULL" }]);
    const noList = readTrades(answer([row({ ownLegs: "unreadable", status: 7 })]));
    expect(noList.kind === "MALFORMED" ? tradesOf(noList) : undefined).toEqual([{ venueTradeId: "t", status: null, shape: "MALFORMED" }]);
    const noId = readTrades(answer([row({ venueTradeId: 7, ownLegs: [{ ...LEG, feeAmount: "bad" }] })]));
    expect(noId.kind).toBe("MALFORMED");
    // No readable trade identity is kept for it (as in r9); (r11, the class fix) but the row is NOT dropped: it is kept
    // unkeyed, with its leg's every readable fact and its unreadable fee (an UNREADABLE obligation: `units-r11.test.ts`).
    expect(tradesOf(noId)).toEqual([]);
    expect(noId.salvage.trades.map((trade) => [trade.venueTradeId, trade.status, trade.unreadable, trade.legs.map((leg) => [leg.venueOrderId, leg.shares, leg.unreadable])])).toEqual([
      [null, "CONFIRMED", ["venueTradeId"], [["venue-1", "0.4", ["feeAmount"]]]],
    ]);
  });

  it("(store) a FAILED shown with no own leg is kept: a later CONFIRMED read of the trade is the durable CONFLICT, after a rebuild too", () => {
    const records: EvidenceRecord[] = [tradeRecord("t", "FAILED", "TRADES_ROW_PARTIAL")];
    for (const store of [EvidenceStore.fold(records), (() => { const live = new EvidenceStore(); for (const record of records) expect(live.add(record)).toBe(true); return live; })()]) {
      expect(store.trade("t")).toMatchObject({ terminals: ["FAILED"], status: "FAILED", identityOpen: true, legs: [] });
      const shown: VenueTradeView = { venueTradeId: "t", status: "CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: [LEG as VenueTradeView["ownLegs"][number]] };
      store.add(tradeRecord("t", "CONFIRMED", "TRADES_ROW"));
      const verdict = store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown } });
      expect(verdict.kind === "CONFLICT" ? verdict.problems.map((entry) => entry.detail).join(" ") : "").toContain("both CONFIRMED and FAILED");
    }
  });

  it("(store) an OPEN identity is a CONFLICT when omitted, whatever its known legs' accounting; a row with its ownership determined closes it", () => {
    for (const source of ["TRADES_ROW_PARTIAL", "TRADES_ROW_ID"] as const) {
      const store = EvidenceStore.fold([legRecord("t", { venueOrderId: "venue-1", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5" }, "CONFIRMED", "SHOWN", "TRADES_LEG_SALVAGED"), tradeRecord("t", "CONFIRMED", source)]);
      expect(store.trade("t")?.identityOpen).toBe(true);
      const omitted = store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: undefined } });
      expect(omitted.kind === "CONFLICT" ? omitted.problems.map((entry) => entry.detail).join(" ") : "").toContain("without identifying all of its own legs");
      // Repeating the open observation is no new information; a row with its ownership determined is, and closes it.
      expect(store.add(tradeRecord("t", "CONFIRMED", source))).toBe(false);
      expect(store.add(tradeRecord("t", "CONFIRMED", "TRADES_ROW"))).toBe(true);
      expect(store.trade("t")?.identityOpen).toBe(false);
      expect(store.judge({ trade: "t", reads: { tradesOk: true, held: false, accounted: () => true, shown: undefined } })).toEqual({ kind: "UNREAD" });
      // Closed first, then an open observation: still closed (the legs are known; each is judged on its own).
      const closedFirst = EvidenceStore.fold([tradeRecord("t", "CONFIRMED", "TRADES_ROW"), tradeRecord("t", "CONFIRMED", source)]);
      expect(closedFirst.trade("t")?.identityOpen).toBe(false);
      // On a trade the evidence already holds, an open observation with no new status is still new information: it is
      // journaled, so a restart folds the same open identity.
      const known = EvidenceStore.fold([legRecord("t", { venueOrderId: "venue-1", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5" }, "CONFIRMED", "SHOWN", "TRADES_LEG")]);
      expect(known.add(tradeRecord("t", null, source))).toBe(true);
      expect(known.trade("t")?.identityOpen).toBe(true);
    }
    // A trade the evidence holds only through legs (every journal before r9) is not open.
    expect(EvidenceStore.fold([legRecord("t", { venueOrderId: "venue-1", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5" }, "CONFIRMED", "SHOWN", "TRADES_LEG")]).trade("t")?.identityOpen).toBe(false);
  });

  it("(door and journal) a TRADE record names its trade and no order, carries its status alone, and comes from a trade row; it replays", async () => {
    const good = tradeRecord("t", "CONFIRMED", "TRADES_ROW_ID");
    expect(good).toMatchObject({ evidenceKind: "TRADE", venueOrderId: null, venueTradeId: "t", provenance: "NAMED" });
    expect(tradeRecord("t", null, "TRADES_ROW")).toMatchObject({ provenance: "SHOWN", status: null });
    expect(readEvidenceRecord({ ...good })).toEqual(good);
    expect(readEvidenceRecord({ ...good, venueOrderId: "venue-1" })).toBeUndefined();
    expect(readEvidenceRecord({ ...good, venueTradeId: null })).toBeUndefined();
    expect(readEvidenceRecord({ ...good, source: "TRADES_LEG" })).toBeUndefined();
    expect(readEvidenceRecord({ ...good, provenance: "SHOWN" })).toBeUndefined();
    expect(readEvidenceRecord({ ...tradeRecord("t", "CONFIRMED", "TRADES_ROW"), provenance: "NAMED" })).toBeUndefined();
    expect(readEvidenceRecord({ ...good, size: "0.4" })).toBeUndefined();
    expect(readEvidenceRecord({ ...good, tokenId: "1" })).toBeUndefined();
    expect(readEvidenceRecord({ ...good, feeAmount: "0" })).toBeUndefined();
    expect(readEvidenceRecord({ ...legRecord("t", { venueOrderId: "venue-1", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5" }, null, "SHOWN", "TRADES_LEG"), source: "TRADES_ROW" })).toBeUndefined();
    expect(readEvidenceRecord({ ...legRecord("t", { venueOrderId: "venue-1", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5" }, null, "SHOWN", "TRADES_LEG"), venueOrderId: null })).toBeUndefined();
    const events: unknown[] = [];
    const opened = ReconciliationJournal.open({ accountRef: "account-1", history: [], sink: { append: async (event) => void events.push(event) } });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const journal = opened.value;
    const event = (record: Record<string, unknown>): Record<string, unknown> => ({ kind: "EVIDENCE_RECORDED", runId: null, ...record, atMs: 1 });
    expect((await journal.append(event({ ...good }))).ok).toBe(true);
    expect((await journal.append(event({ ...good, venueOrderId: "venue-1" }))).ok).toBe(false);
    expect((await journal.append(event({ ...good, venueTradeId: null }))).ok).toBe(false);
    expect((await journal.append(event({ ...good, size: "0.4" }))).ok).toBe(false);
    expect((await journal.append(event({ ...good, side: "BUY" }))).ok).toBe(false);
    expect((await journal.append(event({ ...good, matchedAt: "2026-10-03T00:00:00Z" }))).ok).toBe(false);
    expect((await journal.append(event({ ...legRecord("t", { venueOrderId: "venue-1", tokenId: "1", side: "BUY", shares: "0.4", price: "0.5" }, null, "SHOWN", "TRADES_LEG"), venueOrderId: null }))).ok).toBe(false);
    expect(readEvidenceRecords(journal.evidence())).toEqual([good]);
    const replayed = ReconciliationJournal.open({ accountRef: "account-1", history: events as never, sink: { append: async () => undefined } });
    expect(replayed.ok && readEvidenceRecords(replayed.value.evidence())).toEqual([good]);
  });
});
