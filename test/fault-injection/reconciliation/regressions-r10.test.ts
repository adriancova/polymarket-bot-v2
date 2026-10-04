/**
 * WP-290 r10: the round-10 joint report's reproductions (Claude Opus and Codex gpt-6-astra, `reconcile-r10/joint.md`),
 * kept as named regressions, each with its controls and a recovery tail. Every finding pin fails on 37cfcf7 on a
 * BEHAVIOURAL assertion (a resume, an answer accepted, a quarantine missing), and passes here.
 *
 * - WP290-CX-R10-01: a by-id answer that was unusable for the order asked about (`found: false` carrying an order,
 *   `found` absent, a valid row naming ANOTHER order) was discarded whole: its fully validated row reached neither the
 *   evidence nor the journal. A later lagging snapshot then resumed with a fill unanswered (reproduction 1); a twin's
 *   row returned for the attempt's own order skipped the signed-identity ambiguity (reproduction 2); an opposite-side
 *   order's row skipped its UNATTRIBUTED classification (reproduction 3).
 * - WP290-V10-UNKEYED-LEG-DISCHARGED: an own leg that validated in full in a trades row whose trade id was unreadable
 *   (a number, an empty string, an accessor) was kept only as its order's matched LOWER BOUND, which adds nothing when
 *   the order already showed that much; a later lagging trades read then discharged it, and the account resumed.
 *
 * r10 keeps the row of an unusable by-id answer as evidence under the row's OWN id (`door.ts`, `BY_ID_ROW` /
 * `BY_ID_ID`), and records an unkeyed leg as a durable obligation (`evidence.ts`, `UNKEYED_LEG`): its order holds
 * until the reads show, under readable trade ids and with a leg of exactly its facts, as many trades the evidence did
 * NOT hold on the order when the leg was seen (fail closed: the unkeyed row may be any of those, so none of them
 * answers it); and its order matched at least every known trade (the evidence's, and the OMS's fills) plus the
 * unkeyed legs. The units are in `units-r10.test.ts`. Each journal check here is asserted after the behavioural ones
 * where the pin is a finding's, so that on 37cfcf7 it fails on its behaviour first.
 *
 * PAPER only: every port is the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";

import { YES, boot, streamTrade } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import type { VenueTrade } from "./support/world.js";

type Row = Record<string, unknown>;
type TradeRow = Row & { readonly venueTradeId: string; readonly ownLegs: Row[] };

/** The same universe, after a restart (a fresh process over what survives). */
async function restarted(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

/** Release every QUARANTINED break (an operator acknowledging everything presented); returns how many. */
async function releaseAll(r: Ready, reason: string): Promise<number> {
  let released = 0;
  for (const view of r.p.journal.unresolvedBreaks()) {
    if (view.status !== "QUARANTINED") continue;
    if ((await r.p.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason })).ok) released += 1;
  }
  return released;
}

function fills(r: Ready): string[] {
  return r.u.store.snapshotSync().fills.map((fill) => fill.venueTradeId);
}

function unresolved(r: Ready, breakClass: string, ...subject: string[]): { readonly detail: string; readonly status: string } | undefined {
  return r.p.journal.unresolvedBreaks().find((view) => view.breakClass === breakClass && view.subjectKey === compositeKey(breakClass, ...subject));
}

/** The evidence records the journal holds of one venue order from one source: [provenance, size, level]. */
function recordsOf(r: Ready, venueOrderId: string, source: string): (string | number | null)[][] {
  return r.p.journal
    .evidence()
    .filter((record) => record.venueOrderId === venueOrderId && record.source === source)
    .map((record) => [record.evidenceKind, record.provenance, record.size, record.level]);
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

// ---- WP290-CX-R10-01 ------------------------------------------------------------------------------------------

/** The id a relabelled row carries (reproduction 1's WRONG_ID shape: astra's `other-observed-order`). */
const OTHER = "other-observed-order";

/** How the faulty by-id answer for the order asked about is shaped (the finding's three shapes, and the valid control). */
type ByIdShape = "VALID" | "FALSE_FOUND" | "MISSING_FOUND" | "WRONG_ID";

function shapedById(shape: ByIdShape, raw: unknown): unknown {
  const read = raw as Row & { readonly order?: Row };
  switch (shape) {
    case "VALID":
      return read;
    case "FALSE_FOUND":
      return { ...read, found: false };
    case "MISSING_FOUND": {
      const absent: Row = { ...read };
      delete absent["found"];
      return absent;
    }
    case "WRONG_ID":
      return { ...read, order: { ...read.order, venueOrderId: OTHER } };
  }
}

/**
 * astra's reproduction 1: a tracked order matched 0.4 (its fill held), then 0.4 again. The open-orders list omits the
 * order and every other read lags (a snapshot from before the second match), except the by-id answer, which shows the
 * order's TRUE row (0.8 matched) in `shape`. Returns the process, both trades, and the lagging list and by-id answer.
 */
async function lostFill(shape: ByIdShape): Promise<{ r: Ready; first: VenueTrade; second: VenueTrade; open: unknown; oldById: unknown }> {
  const r = await ready();
  await submitOne(r.oms);
  expect(await reconcileRounds(r, 3)).toBe(true);
  const salt = r.u.world.receipts.at(-1) as string;
  const first = must(r.u.world.match(salt, "0.4"), "first match");
  expect(await reconcileRounds(r, 3)).toBe(true);
  const port = r.u.world.readPort();
  const open = await port.listOpenOrders();
  const oldTrades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  const oldById = await port.readOrder(first.venueOrderId);
  const second = must(r.u.world.match(salt, "0.4"), "second match");
  r.u.world.faults = {
    listOpenOrders: () => ({ route: "/data/orders", complete: true, orders: [] }),
    listTrades: () => oldTrades,
    readPositions: () => positions,
    readCollateral: () => collateral,
    readOrder: (_id, answer) => shapedById(shape, answer()),
  };
  return { r, first, second, open, oldById };
}

describe("WP-290 r10 (WP290-CX-R10-01): an unusable by-id answer keeps its validated row, under the row's own id", () => {
  for (const shape of ["FALSE_FOUND", "MISSING_FOUND", "WRONG_ID"] as const) {
    for (const withRestart of [false, true]) {
      it(`(R10-01, lost fill, ${shape}${withRestart ? ", a restart" : ""}) the true 0.8 row in an unusable by-id answer, then a lagging snapshot: never resumed while it lags; ${shape === "WRONG_ID" ? "the relabelled id is held for good (fail closed)" : "once the reads catch up, the fill is delivered and the account resumes"}`, async () => {
        const setup = await lostFill(shape);
        let r = setup.r;
        expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
        const rowId = shape === "WRONG_ID" ? OTHER : setup.first.venueOrderId;
        const kept = recordsOf(r, rowId, "BY_ID_ROW");
        // The lag: a consistent snapshot from before the second match, by-id read included.
        r.u.world.faults.listOpenOrders = () => setup.open;
        r.u.world.faults.readOrder = () => setup.oldById;
        if (withRestart) r = await restarted(r);
        expect(await reconcileRounds(r, 4)).toBe(false);
        expect(r.u.violations).toEqual([]);
        expect(fills(r)).toEqual([setup.first.venueTradeId]);
        // The answer for the order asked about stays unusable: its read break is recorded.
        expect(r.p.journal.breaks().some((view) => view.breakClass === "READ_MALFORMED" && view.subjectKey === compositeKey("READ_MALFORMED", compositeKey("order", setup.first.venueOrderId)))).toBe(true);
        // The row was kept as SHOWN evidence under the id it carries (never relabelled to the id asked about), journaled.
        expect(kept).toEqual([["ORDER", "SHOWN", "0.8", null]]);
        r.u.world.faults = {};
        if (shape === "WRONG_ID") {
          // An order the venue showed in full that its own by-id read does not find: a contradiction, held for good.
          expect(await reconcileRounds(r, 4)).toBe(false);
          expect(unresolved(r, "READ_CONFLICT", "order", OTHER)?.detail).toContain("its by-id read does not find it");
          expect(fills(r)).toEqual([setup.first.venueTradeId]);
        } else {
          expect(await reconcileRounds(r, 4)).toBe(true);
          expect(fills(r).sort()).toEqual([setup.first.venueTradeId, setup.second.venueTradeId].sort());
        }
        expect(r.u.violations).toEqual([]);
      });
    }
  }

  it("(R10-01, control: the valid envelope) the same lag after a VALID by-id answer showing 0.8: held by READ_REGRESSION, as before r10", async () => {
    const setup = await lostFill("VALID");
    const r = setup.r;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listOpenOrders = () => setup.open;
    r.u.world.faults.readOrder = () => setup.oldById;
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(unresolved(r, "READ_REGRESSION", "order", setup.first.venueOrderId)).toBeDefined();
    expect(r.u.violations).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.u.violations).toEqual([]);
  });

  /**
   * astra's reproductions 2 and 3: an unknown attempt's own order is listed; another order of the account (an exact
   * twin, or the opposite side) is left out of the list (`listed`: it is not), and the by-id read of the attempt's
   * order returns the OTHER order's valid row. Then the other order is cancelled and every read is truthful.
   */
  async function wrongRow(opposite: boolean, listed: boolean): Promise<{ r: Ready; attempt: string; own: string; other: string }> {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = must((await submitOne(r.oms)) ?? undefined, "attempt");
    const own = must([...r.u.world.orders.values()][0], "own order");
    const other = r.u.world.placeForeign({ tokenId: own.tokenId, side: opposite ? (own.side === "BUY" ? "SELL" : "BUY") : own.side, price: own.price, size: own.original });
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Row[] };
      return listed ? read : { ...read, orders: read.orders.filter((order) => order["venueOrderId"] !== other.venueOrderId) };
    };
    r.u.world.faults.readOrder = (id, answer) => (id === own.venueOrderId ? { route: "/data/order", found: true, order: r.u.world.orderView(other) } : answer());
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.cancel(other.venueOrderId);
    r.u.world.faults = {};
    return { r, attempt, own: own.venueOrderId, other: other.venueOrderId };
  }

  for (const listed of [false, true]) {
    for (const withRestart of listed ? [false] : [false, true]) {
      it(`(R10-01, ${listed ? "control: the twin listed" : "a twin's row for the attempt's own order"}${withRestart ? ", a restart" : ""}) the signed identity is AMBIGUOUS between the two exact twins: never answered, never resumed`, async () => {
        const setup = await wrongRow(false, listed);
        let r = setup.r;
        if (withRestart) r = await restarted(r);
        expect(await reconcileRounds(r, 4)).toBe(false);
        expect(r.u.accepted).toEqual([]);
        expect(unresolved(r, "SIGNED_IDENTITY_AMBIGUOUS", setup.attempt)?.detail).toContain(setup.other);
        expect(r.u.violations).toEqual([]);
        if (!listed) expect(recordsOf(r, setup.other, "BY_ID_ROW")).toEqual([["ORDER", "SHOWN", "0", null]]);
      });
    }
  }

  for (const withRestart of [false, true]) {
    it(`(R10-01, an INVALID row naming another order${withRestart ? ", a restart" : ""}) its id alone is kept (NAMED): read by id, found, and classified ORDER_UNATTRIBUTED; never resumed before`, async () => {
      let r = await ready();
      r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
      await submitOne(r.oms);
      const own = must([...r.u.world.orders.values()][0], "own order");
      const other = r.u.world.placeForeign({ tokenId: own.tokenId, side: own.side === "BUY" ? "SELL" : "BUY", price: own.price, size: own.original });
      r.u.world.faults.listOpenOrders = (answer) => {
        const read = answer() as { orders: Row[] };
        return { ...read, orders: read.orders.filter((order) => order["venueOrderId"] !== other.venueOrderId) };
      };
      r.u.world.faults.readOrder = (id, answer) => (id === own.venueOrderId ? { route: "/data/order", found: true, order: { ...r.u.world.orderView(other), price: "not a price" } } : answer());
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      r.u.world.cancel(other.venueOrderId);
      r.u.world.faults = {};
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(unresolved(r, "ORDER_UNATTRIBUTED", other.venueOrderId)?.status).toBe("QUARANTINED");
      expect(r.u.violations).toEqual([]);
      expect(recordsOf(r, other.venueOrderId, "BY_ID_ID")).toEqual([["ORDER", "NAMED", null, null]]);
    });
  }

  for (const listed of [false, true]) {
    for (const withRestart of listed ? [false] : [false, true]) {
      it(`(R10-01, ${listed ? "control: the opposite-side order listed" : "an opposite-side order's row for the attempt's own order"}${withRestart ? ", a restart" : ""}) the other order is unmatched activity: ORDER_UNATTRIBUTED, quarantined; once released, the account resumes`, async () => {
        const setup = await wrongRow(true, listed);
        let r = setup.r;
        if (withRestart) r = await restarted(r);
        expect(await reconcileRounds(r, 4)).toBe(false);
        expect(unresolved(r, "ORDER_UNATTRIBUTED", setup.other)?.status).toBe("QUARANTINED");
        // The attempt's own order is the only candidate on its side: it is answered PRESENT, by its own id.
        expect(r.u.accepted.map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([["PRESENT", setup.own]]);
        expect(r.u.violations).toEqual([]);
        // The recovery tail: the operator acknowledges the foreign order; the account resumes, consistent.
        expect(await releaseAll(r, "acknowledge the foreign order")).toBeGreaterThan(0);
        expect(await reconcileRounds(r, 4)).toBe(true);
        expect(r.u.violations).toEqual([]);
        if (!listed) expect(recordsOf(r, setup.other, "BY_ID_ROW")).toEqual([["ORDER", "SHOWN", "0", null]]);
      });
    }
  }
});

// ---- WP290-V10-UNKEYED-LEG-DISCHARGED ---------------------------------------------------------------------------

/** How the second trade's row carries its trade id (the finding's three unreadable shapes, and the readable control). */
type IdShape = "NUMBER" | "EMPTY" | "ACCESSOR" | "READABLE";

function withId(shape: IdShape, row: TradeRow): Row {
  switch (shape) {
    case "NUMBER":
      return { ...row, venueTradeId: 42 };
    case "EMPTY":
      return { ...row, venueTradeId: "" };
    case "ACCESSOR": {
      const copy: Row = { ...row };
      delete copy["venueTradeId"];
      Object.defineProperty(copy, "venueTradeId", { get: () => row.venueTradeId, enumerable: true });
      return copy;
    }
    case "READABLE":
      // isIdentifier accepts it (Opus's `has space` control): the leg is keyed under it.
      return { ...row, venueTradeId: "has space" };
  }
}

/**
 * Opus's P10-UNKEYED setup (the CX-R9-01 lag model): a tracked order matched `s1`, its fill held, then `s2`. Every read
 * but the trades read lags (a snapshot from before the second match); one trades answer (`complete` or partial) shows
 * the second trade's row with its id in `shape` and its leg valid.
 */
async function trackedUnkeyed(shape: IdShape, complete: boolean, s1 = "0.4", s2 = "0.4"): Promise<{ r: Ready; first: VenueTrade; second: VenueTrade; oldTrades: unknown }> {
  const r = await ready();
  await submitOne(r.oms);
  expect(await reconcileRounds(r, 3)).toBe(true);
  const salt = r.u.world.receipts.at(-1) as string;
  const first = must(r.u.world.match(salt, s1), "first match");
  expect(await reconcileRounds(r, 3)).toBe(true);
  const port = r.u.world.readPort();
  const open = (await port.listOpenOrders()) as { orders: Row[] };
  const oldTrades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  const second = must(r.u.world.match(salt, s2), "second match");
  r.u.world.faults = {
    listOpenOrders: () => open,
    readOrder: (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] }),
    readPositions: () => positions,
    readCollateral: () => collateral,
    listTrades: (answer) => {
      const read = answer() as { trades: TradeRow[] };
      return { ...read, complete, trades: read.trades.map((entry) => (entry.venueTradeId === second.venueTradeId ? withId(shape, entry) : entry)) };
    },
  };
  return { r, first, second, oldTrades };
}

const UNKEYED_DETAIL = "in a row whose trade id was unreadable";

describe("WP-290 r10 (WP290-V10-UNKEYED-LEG-DISCHARGED): an own leg under an unreadable trade id is owed until the reads show its trade by id", () => {
  for (const shape of ["NUMBER", "EMPTY", "ACCESSOR"] as const) {
    for (const complete of [true, false]) {
      for (const withRestart of [false, true]) {
        it(`(V10, tracked, the id ${shape}, a ${complete ? "complete-malformed" : "partial"} answer${withRestart ? ", a restart" : ""}) the second trade under an unreadable id, then a lagging snapshot: never resumed while it lags; ${complete ? "once the reads catch up, both fills, resumed" : "held for good (the partial answer may have left out a trade of the same facts)"}`, async () => {
          const setup = await trackedUnkeyed(shape, complete);
          let r = setup.r;
          const order = setup.first.venueOrderId;
          expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
          const owed = recordsOf(r, order, complete ? "TRADES_LEG_UNKEYED" : "TRADES_LEG_UNKEYED_PARTIAL").filter((record) => record[0] === "UNKEYED_LEG");
          r.u.world.faults.listTrades = () => setup.oldTrades;
          if (withRestart) r = await restarted(r);
          expect(await reconcileRounds(r, 5)).toBe(false);
          expect(r.u.violations).toEqual([]);
          expect(fills(r)).toEqual([setup.first.venueTradeId]);
          expect(unresolved(r, "READ_CONFLICT", "order", order)?.detail).toContain(UNKEYED_DETAIL);
          // Journaled (and so replayed): the leg's shares, and the one unkeyed leg of those facts the answer showed. It
          // owes a trade beyond trade-1, which the evidence held on the order and which shares every fill fact with it.
          expect(owed).toEqual([["UNKEYED_LEG", "SHOWN", "0.4", 1]]);
          r.u.world.faults = {};
          if (complete) {
            // The reads catch up: the second trade is shown under its id, its fill delivered, and the account resumes.
            expect(await reconcileRounds(r, 5)).toBe(true);
            expect(fills(r).sort()).toEqual([setup.first.venueTradeId, setup.second.venueTradeId].sort());
            expect(unresolved(r, "READ_CONFLICT", "order", order)).toBeUndefined();
          } else {
            // A partial answer may have left out a trade of exactly the same facts, which a lagging read could show in
            // the unkeyed one's place: no read can answer it, so it holds for good (fail closed), never booked.
            expect(await reconcileRounds(r, 5)).toBe(false);
            expect(fills(r)).toEqual([setup.first.venueTradeId]);
            expect(unresolved(r, "READ_CONFLICT", "order", order)?.detail).toContain("in an answer that did not show every trade of the account");
          }
          expect(r.u.violations).toEqual([]);
        });
      }
    }
  }

  it("(V10, a complete answer with a row nothing of which could be identified) the answer is not whole: its unkeyed leg holds for good, the truthful reads included (fail closed)", async () => {
    const setup = await trackedUnkeyed("NUMBER", true);
    let r = setup.r;
    const order = setup.first.venueOrderId;
    // Beside the garbled row, a row with no readable trade id and a leg that does not validate: a trade the answer
    // shows but nothing of which could be kept.
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: TradeRow[] };
      const rows = read.trades.map((entry) => (entry.venueTradeId === setup.second.venueTradeId ? withId("NUMBER", entry) : entry));
      return { ...read, trades: [...rows, { venueTradeId: "", status: "CONFIRMED", transactionHash: null, ownershipUndetermined: false, ownLegs: [{ venueOrderId: order, price: "garbled" }] }] };
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => setup.oldTrades;
    r = await restarted(r);
    expect(await reconcileRounds(r, 4)).toBe(false);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(unresolved(r, "READ_CONFLICT", "order", order)?.detail).toContain("in an answer that did not show every trade of the account");
    expect(fills(r)).toEqual([setup.first.venueTradeId]);
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, control: a readable id) the same lag with the second trade's id readable (`has space`): held by its keyed leg, as before r10", async () => {
    const setup = await trackedUnkeyed("READABLE", true);
    const r = setup.r;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => setup.oldTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(recordsOf(r, setup.first.venueOrderId, "TRADES_LEG_UNKEYED")).toEqual([]);
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, control: the larger leg) an unkeyed 0.6 leg after a 0.2 match: held by the order's matched lower bound (READ_REGRESSION), as before r10", async () => {
    const setup = await trackedUnkeyed("NUMBER", true, "0.2", "0.6");
    const r = setup.r;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => setup.oldTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(unresolved(r, "READ_REGRESSION", "order", setup.first.venueOrderId)).toBeDefined();
    expect(r.u.violations).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, an answer that omits known trades) a COMPLETE answer shows ONLY an unkeyed leg after two trades of the same facts were shown (aged out of it): the two known ones can never answer it, so a lagging read showing them never discharges it", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const salt = r.u.world.receipts.at(-1) as string;
    const first = must(r.u.world.match(salt, "0.3"), "first match");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const second = must(r.u.world.match(salt, "0.3"), "second match");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const port = r.u.world.readPort();
    const open = (await port.listOpenOrders()) as { orders: Row[] };
    const oldTrades = await port.listTrades();
    const positions = await port.readPositions();
    const collateral = await port.readCollateral();
    const third = must(r.u.world.match(salt, "0.3"), "third match");
    r.u.world.faults = {
      listOpenOrders: () => open,
      readOrder: (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] }),
      readPositions: () => positions,
      readCollateral: () => collateral,
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId === third.venueTradeId).map((entry) => withId("NUMBER", entry)) };
      },
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => oldTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(r.u.violations).toEqual([]);
    expect(unresolved(r, "READ_CONFLICT", "order", first.venueOrderId)?.detail).toContain(`beyond the 2 it already held there (${[first.venueTradeId, second.venueTradeId].sort().join(", ")})`);
    expect(recordsOf(r, first.venueOrderId, "TRADES_LEG_UNKEYED").filter((record) => record[0] === "UNKEYED_LEG")).toEqual([["UNKEYED_LEG", "SHOWN", "0.3", 1]]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual([first.venueTradeId, second.venueTradeId, third.venueTradeId].sort());
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, the same answer's keyed rows count, whatever their order) an unkeyed row listed BEFORE a new keyed row of the same facts owes both: a snapshot showing only the keyed one never discharges it", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const salt = r.u.world.receipts.at(-1) as string;
    const port = r.u.world.readPort();
    const first = must(r.u.world.match(salt, "0.4"), "first match");
    // A consistent snapshot after the first match, before the second (no run has seen either yet).
    const open = (await port.listOpenOrders()) as { orders: Row[] };
    const oneTrade = await port.listTrades();
    const positions = await port.readPositions();
    const collateral = await port.readCollateral();
    const second = must(r.u.world.match(salt, "0.4"), "second match");
    r.u.world.faults = {
      listOpenOrders: () => open,
      readOrder: (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] }),
      readPositions: () => positions,
      readCollateral: () => collateral,
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        const garbled = read.trades.filter((entry) => entry.venueTradeId === second.venueTradeId).map((entry) => withId("EMPTY", entry));
        return { ...read, trades: [...garbled, ...read.trades.filter((entry) => entry.venueTradeId !== second.venueTradeId)] };
      },
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => oneTrade;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(r.u.violations).toEqual([]);
    expect(unresolved(r, "READ_CONFLICT", "order", first.venueOrderId)?.detail).toContain(`beyond the 1 it already held there (${first.venueTradeId})`);
    expect(recordsOf(r, first.venueOrderId, "TRADES_LEG_UNKEYED").filter((record) => record[0] === "UNKEYED_LEG")).toEqual([["UNKEYED_LEG", "SHOWN", "0.4", 1]]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual([first.venueTradeId, second.venueTradeId].sort());
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, two unkeyed rows of the same facts in one answer) they owe two distinct trades: a snapshot showing only one of them never discharges both", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const salt = r.u.world.receipts.at(-1) as string;
    const first = must(r.u.world.match(salt, "0.3"), "first match");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const port = r.u.world.readPort();
    const second = must(r.u.world.match(salt, "0.3"), "second match");
    // A consistent snapshot after the second match, before the third (no run has seen either).
    const open = (await port.listOpenOrders()) as { orders: Row[] };
    const twoTrades = await port.listTrades();
    const positions = await port.readPositions();
    const collateral = await port.readCollateral();
    const third = must(r.u.world.match(salt, "0.3"), "third match");
    r.u.world.faults = {
      listOpenOrders: () => open,
      readOrder: (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] }),
      readPositions: () => positions,
      readCollateral: () => collateral,
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === second.venueTradeId ? withId("NUMBER", entry) : entry.venueTradeId === third.venueTradeId ? withId("EMPTY", entry) : entry)) };
      },
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => twoTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(r.u.violations).toEqual([]);
    expect(recordsOf(r, first.venueOrderId, "TRADES_LEG_UNKEYED").filter((record) => record[0] === "UNKEYED_LEG")).toEqual([["UNKEYED_LEG", "SHOWN", "0.3", 2]]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual([first.venueTradeId, second.venueTradeId, third.venueTradeId].sort());
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, unkeyed legs on two orders in one answer) each order owes its own trades, counted on its own order: held while they lag; once shown by id, the tracked fill is delivered and the foreign trade is TRADE_UNATTRIBUTED", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    await reconcileRounds(r, 3);
    expect(await releaseAll(r, "acknowledge this foreign order only")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const own = r.u.world.receipts.at(-1) as string;
    const a1 = must(r.u.world.match(own, "0.4"), "a1");
    const b1 = must(r.u.world.match(foreign.salt, "0.4"), "b1");
    await reconcileRounds(r, 3);
    expect(await releaseAll(r, "acknowledge the first foreign trade")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const port = r.u.world.readPort();
    const open = (await port.listOpenOrders()) as { orders: Row[] };
    const oldTrades = await port.listTrades();
    const positions = await port.readPositions();
    const collateral = await port.readCollateral();
    const byIdOf = new Map<string, unknown>();
    for (const id of [a1.venueOrderId, b1.venueOrderId]) byIdOf.set(id, await port.readOrder(id));
    const a2 = must(r.u.world.match(own, "0.4"), "a2");
    const b2 = must(r.u.world.match(foreign.salt, "0.4"), "b2");
    r.u.world.faults = {
      listOpenOrders: () => open,
      readOrder: (id, answer) => byIdOf.get(id) ?? answer(),
      readPositions: () => positions,
      readCollateral: () => collateral,
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === a2.venueTradeId || entry.venueTradeId === b2.venueTradeId ? withId("NUMBER", entry) : entry)) };
      },
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => oldTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(r.u.violations).toEqual([]);
    for (const order of [a1.venueOrderId, b1.venueOrderId]) {
      expect(unresolved(r, "READ_CONFLICT", "order", order)?.detail).toContain(UNKEYED_DETAIL);
      expect(recordsOf(r, order, "TRADES_LEG_UNKEYED").filter((record) => record[0] === "UNKEYED_LEG")).toEqual([["UNKEYED_LEG", "SHOWN", "0.4", 1]]);
    }
    // The reads catch up: the tracked fill is delivered; the foreign trade is unmatched activity, by its own id.
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(unresolved(r, "TRADE_UNATTRIBUTED", b2.venueTradeId, b1.venueOrderId)?.status).toBe("QUARANTINED");
    expect(await releaseAll(r, "acknowledge the second foreign trade")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(fills(r).sort()).toEqual([a1.venueTradeId, a2.venueTradeId].sort());
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, a fill only the OMS holds) the stream delivered trade-2 to the OMS (no read showed it); a complete answer shows only trade-3, unkeyed (it leaves trade-1 and trade-2 out): the order matched at least every known trade plus the unkeyed leg, so a snapshot showing trade-1 and trade-2 never discharges it", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const salt = r.u.world.receipts.at(-1) as string;
    const first = must(r.u.world.match(salt, "0.3"), "first match");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const second = must(r.u.world.match(salt, "0.3"), "second match");
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, second.venueTradeId));
    await r.p.coordinator.settled();
    expect(fills(r).sort()).toEqual([first.venueTradeId, second.venueTradeId].sort());
    const port = r.u.world.readPort();
    const open = (await port.listOpenOrders()) as { orders: Row[] };
    const twoTrades = await port.listTrades();
    const positions = await port.readPositions();
    const collateral = await port.readCollateral();
    const third = must(r.u.world.match(salt, "0.3"), "third match");
    r.u.world.faults = {
      listOpenOrders: () => open,
      readOrder: (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] }),
      readPositions: () => positions,
      readCollateral: () => collateral,
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId === third.venueTradeId).map((entry) => withId("NUMBER", entry)) };
      },
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => twoTrades;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(r.u.violations).toEqual([]);
    expect(fills(r).sort()).toEqual([first.venueTradeId, second.venueTradeId].sort());
    // The OMS's two fills (0.6) plus the unkeyed leg (0.3): a read showing 0.6 matched is behind it.
    expect(unresolved(r, "READ_REGRESSION", "order", first.venueOrderId)?.detail).toContain("less than the 0.9");
    expect(recordsOf(r, first.venueOrderId, "TRADES_LEG_UNKEYED").filter((record) => record[0] === "ORDER")).toEqual([["ORDER", "SHOWN", "0.9", null]]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual([first.venueTradeId, second.venueTradeId, third.venueTradeId].sort());
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, a trade only the user stream named) a foreign order's trade-2 settlement the OMS could not apply, then a complete answer showing only trade-3, unkeyed, with the same facts: trade-2 is already held, so a snapshot showing trade-1 and trade-2 never discharges trade-3", async () => {
    const r = await ready();
    const order = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    await reconcileRounds(r, 3);
    expect(await releaseAll(r, "acknowledge this foreign order only")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 2)).toBe(true);
    const first = must(r.u.world.match(order.salt, "0.3"), "first match");
    await reconcileRounds(r, 3);
    expect(await releaseAll(r, "acknowledge the first foreign trade")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const port = r.u.world.readPort();
    const second = must(r.u.world.match(order.salt, "0.3"), "second match");
    // The stream reports trade-2's settlement (no fill: WP-280's maker projection); the OMS tracks no such order.
    r.p.coordinator.onUserStreamOutput({
      kind: "TRADE",
      oms: { fills: [], settlements: [{ venueTradeId: second.venueTradeId, venueOrderId: order.venueOrderId, status: "CONFIRMED", transactionHash: second.transactionHash, observedAt: "2026-10-03T00:00:01Z" }], shortfalls: [] },
    });
    await r.p.coordinator.settled();
    const open = (await port.listOpenOrders()) as { orders: Row[] };
    const twoTrades = await port.listTrades();
    const positions = await port.readPositions();
    const collateral = await port.readCollateral();
    const byId = await port.readOrder(order.venueOrderId);
    const third = must(r.u.world.match(order.salt, "0.3"), "third match");
    r.u.world.faults = {
      listOpenOrders: () => open,
      readOrder: (id, answer) => (id === order.venueOrderId ? byId : answer()),
      readPositions: () => positions,
      readCollateral: () => collateral,
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.filter((entry) => entry.venueTradeId === third.venueTradeId).map((entry) => withId("EMPTY", entry)) };
      },
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => twoTrades;
    expect(await reconcileRounds(r, 3)).toBe(false);
    // An operator acknowledges whatever is quarantined (trade-2's TRADE_UNATTRIBUTED, had a run classified it): trade-3
    // still holds, since trade-2 was held on the order before the unkeyed leg was seen and cannot answer it.
    await releaseAll(r, "acknowledge the second foreign trade");
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(r.u.violations).toEqual([]);
    expect(unresolved(r, "READ_CONFLICT", "order", order.venueOrderId)?.detail).toContain(`beyond the 2 it already held there (${[first.venueTradeId, second.venueTradeId].sort().join(", ")})`);
    // The reads catch up: trade-3 is shown by its id, and classified as unmatched activity by its own id.
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(unresolved(r, "TRADE_UNATTRIBUTED", third.venueTradeId, order.venueOrderId)?.status).toBe("QUARANTINED");
    expect(unresolved(r, "READ_CONFLICT", "order", order.venueOrderId)).toBeUndefined();
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, foreign, the order reads current, the trades read lagging) the order's matched size already shows the second trade: only the trade identity owes it, and trade-1 (held before) never answers it", async () => {
    const r = await ready();
    const order = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    await reconcileRounds(r, 3);
    expect(await releaseAll(r, "acknowledge this foreign order only")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 2)).toBe(true);
    const first = must(r.u.world.match(order.salt, "0.4"), "first match");
    await reconcileRounds(r, 3);
    expect(await releaseAll(r, "acknowledge the first foreign trade")).toBeGreaterThan(0);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const port = r.u.world.readPort();
    const oldTrades = await port.listTrades();
    const positions = await port.readPositions();
    const collateral = await port.readCollateral();
    const second = must(r.u.world.match(order.salt, "0.4"), "second match");
    r.u.world.faults = {
      readPositions: () => positions,
      readCollateral: () => collateral,
      listTrades: (answer) => {
        const read = answer() as { trades: TradeRow[] };
        return { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === second.venueTradeId ? withId("NUMBER", entry) : entry)) };
      },
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = () => oldTrades;
    expect(await reconcileRounds(r, 3)).toBe(false);
    await releaseAll(r, "acknowledge whatever is quarantined");
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(r.u.violations).toEqual([]);
    expect(unresolved(r, "READ_CONFLICT", "order", order.venueOrderId)?.detail).toContain(`beyond the 1 it already held there (${first.venueTradeId})`);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(unresolved(r, "TRADE_UNATTRIBUTED", second.venueTradeId, order.venueOrderId)?.status).toBe("QUARANTINED");
    expect(r.u.violations).toEqual([]);
  });

  it("(V10, liveness) the same garbled answer read in two runs owes nothing new: once the reads show the trade by id, the account resumes", async () => {
    const setup = await trackedUnkeyed("NUMBER", true);
    const r = setup.r;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    expect(recordsOf(r, setup.first.venueOrderId, "TRADES_LEG_UNKEYED").filter((record) => record[0] === "UNKEYED_LEG")).toEqual([["UNKEYED_LEG", "SHOWN", "0.4", 1]]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(r.u.violations).toEqual([]);
  });

  for (const shape of ["NUMBER", "EMPTY"] as const) {
    for (const withRestart of [false, true]) {
      it(`(V10, foreign, the id ${shape}${withRestart ? ", a restart" : ""}) a second trade on a released foreign order under an unreadable id, then a lagging snapshot: never resumed; once the reads catch up, TRADE_UNATTRIBUTED by its own id`, async () => {
        let r = await ready();
        const order = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
        await reconcileRounds(r, 3);
        expect(await releaseAll(r, "acknowledge this foreign order only")).toBeGreaterThan(0);
        expect(await reconcileRounds(r, 2)).toBe(true);
        must(r.u.world.match(order.salt, "0.4"), "first match");
        await reconcileRounds(r, 3);
        expect(await releaseAll(r, "acknowledge the first foreign trade")).toBeGreaterThan(0);
        expect(await reconcileRounds(r, 3)).toBe(true);
        const port = r.u.world.readPort();
        const open = (await port.listOpenOrders()) as { orders: Row[] };
        const oldTrades = await port.listTrades();
        const positions = await port.readPositions();
        const collateral = await port.readCollateral();
        const second = must(r.u.world.match(order.salt, "0.4"), "second match");
        r.u.world.faults = {
          listOpenOrders: () => open,
          readOrder: (_id, answer) => ({ ...(answer() as Row), order: open.orders[0] }),
          readPositions: () => positions,
          readCollateral: () => collateral,
          listTrades: (answer) => {
            const read = answer() as { trades: TradeRow[] };
            return { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === second.venueTradeId ? withId(shape, entry) : entry)) };
          },
        };
        expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
        r.u.world.faults.listTrades = () => oldTrades;
        if (withRestart) r = await restarted(r);
        expect(await reconcileRounds(r, 5)).toBe(false);
        expect(r.u.violations).toEqual([]);
        expect(unresolved(r, "READ_CONFLICT", "order", order.venueOrderId)?.detail).toContain(UNKEYED_DETAIL);
        // The reads catch up: the trade is shown by its id on an order no one can own: unmatched activity, by its own id.
        r.u.world.faults = {};
        expect(await reconcileRounds(r, 3)).toBe(false);
        expect(unresolved(r, "TRADE_UNATTRIBUTED", second.venueTradeId, order.venueOrderId)?.status).toBe("QUARANTINED");
        expect(unresolved(r, "READ_CONFLICT", "order", order.venueOrderId)).toBeUndefined();
        expect(r.u.violations).toEqual([]);
      });
    }
  }
});
