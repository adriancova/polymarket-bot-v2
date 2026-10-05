/**
 * WP-290 r11: the class fix at the door layer, end to end (the orchestrator's requirement after rounds 9 and 10:
 * "no validated fact is lost between the wire and the evidence store"). Each pin delivers, through one door, an answer
 * one fragment of which c62489f's door dropped before it reached the evidence store, then a lagging read, and asserts
 * what r11 does with it: the fragment is kept (journaled, replayed) and holds; an unreadable identity is an explicit
 * UNREADABLE obligation that holds the account. The named regressions of the class (CX-R9-01, CX-R10-01,
 * V10-UNKEYED) stay in `regressions-r9.test.ts` and `regressions-r10.test.ts`; the door property is
 * `door-property.test.ts`.
 *
 * Doors: open orders (a keyed row with an unreadable price; an unkeyed row), by id (`found: true` with an unkeyed
 * row), trades (an own leg whose order id is unreadable), positions (every row kept as detail), a wallet member (a
 * terminal state shown in an unusable answer), the user stream (an inexact fill; an opaque entry beside a valid one).
 *
 * PAPER only: every port is the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { ApprovalTracker, WalletOperationManager, type ReconciliationRequest as InventoryRequest } from "../../../packages/inventory/src/index.js";
import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager, ReconciledWalletOperations } from "../../../packages/oms/src/index.js";
import { ACCOUNT as INVENTORY_ACCOUNT, CONDITION, NO as INV_NO, PUSD as INV_PUSD, YES as INV_YES, requestTokens, seededBook } from "../../unit/inventory/helpers.js";

import { boot, streamTrade } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import type { ReadFaults, VenueTrade } from "./support/world.js";

type Row = Record<string, unknown>;
type TradeRow = Row & { readonly venueTradeId: string; readonly ownLegs: Row[] };

async function restarted(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

function fills(r: Ready): string[] {
  return r.u.store.snapshotSync().fills.map((fill) => fill.venueTradeId);
}

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

/** The subjects of the account-level UNREADABLE obligations one more run detects (`[READ_CONFLICT, "unreadable", n]`). */
async function obligationsNow(r: Ready): Promise<string[]> {
  const report = await r.p.coordinator.reconcile();
  expect(report.resumed).toBe(false);
  return report.runs.flatMap((run) => run.detections).filter((entry) => entry.subjectKey.startsWith(compositeKey("READ_CONFLICT", "unreadable"))).map((entry) => entry.detail);
}

async function snapshot(r: Ready, venueOrderId: string): Promise<ReadFaults> {
  const port = r.u.world.readPort();
  const open = await port.listOpenOrders();
  const trades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  const byId = await port.readOrder(venueOrderId);
  return { listOpenOrders: () => open, listTrades: () => trades, readPositions: () => positions, readCollateral: () => collateral, readOrder: () => byId };
}

/** A tracked BUY with trade-1 (0.4) delivered and resumed; trade-2 (0.4) matched, the snapshot taken BEFORE it. */
async function trackedLag(): Promise<{ r: Ready; t2: VenueTrade; stale: ReadFaults }> {
  const r = await ready();
  await submitOne(r.oms);
  expect(await reconcileRounds(r, 3)).toBe(true);
  const salt = must(r.u.world.receipts.at(-1), "receipt");
  const t1 = must(r.u.world.match(salt, "0.4"), "first match");
  expect(await reconcileRounds(r, 3)).toBe(true);
  const stale = await snapshot(r, t1.venueOrderId);
  const t2 = must(r.u.world.match(salt, "0.4"), "second match");
  return { r, t2, stale };
}

describe("WP-290 r11 (the class fix at the door layer): every validated fragment reaches the evidence store; every unreadable identity is an obligation", () => {
  for (const withRestart of [false, true]) {
    it(`(open orders and by id) a row whose price is unreadable still SHOWS its matched size 0.8: the lagging 0.4 snapshot is a READ_REGRESSION, never resumed${withRestart ? "; after a restart too" : ""}; the reads catch up, the fill is delivered, resumed`, async () => {
      const setup = await trackedLag();
      let r = setup.r;
      const garble = (row: Row): Row => ({ ...row, price: "not a price" });
      r.u.world.faults = {
        listOpenOrders: (answer) => {
          const read = answer() as { orders: Row[] };
          return { ...read, orders: read.orders.map(garble) };
        },
        readOrder: (_id, answer) => {
          const read = answer() as Row;
          return { ...read, order: garble(read["order"] as Row) };
        },
        // The trades read is unreadable whole: nothing of it is validated (its read break is its obligation).
        listTrades: (answer) => ({ ...(answer() as Row), trades: "unreadable" }),
      };
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      r.u.world.faults = setup.stale;
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(fills(r)).toEqual(["trade-1"]);
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 5)).toBe(true);
      expect(fills(r).sort()).toEqual(["trade-1", "trade-2"]);
      expect(oracle(r)).toEqual([]);
      // The fragments were journaled: NAMED, with the matched size, the price named unreadable.
      const named = r.p.journal.evidence().filter((record) => record.venueOrderId === setup.t2.venueOrderId && (record.source === "OPEN_ORDERS_ID" || record.source === "BY_ID_ID"));
      expect(named.map((record) => [record.provenance, record.size, record.unreadable])).toContainEqual(["NAMED", "0.8", ["price"]]);
    });
  }

  it("(open orders) a row whose venue order id is unreadable is an UNKEYED_ORDER obligation: it holds the account in every run, after a restart too (no read can say which order it was)", async () => {
    let r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    r.u.world.faults.listOpenOrders = (answer) => {
      const read = answer() as { orders: Row[] };
      return { ...read, orders: read.orders.map((row) => ({ ...row, venueOrderId: 7 })) };
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(false);
    r = await restarted(r);
    const held = await obligationsNow(r);
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("an order row whose venue order id was unreadable");
    expect(oracle(r)).toEqual([]);
    expect(r.p.journal.evidence().filter((record) => record.evidenceKind === "UNKEYED_ORDER").map((record) => [record.source, record.unreadable])).toEqual([["OPEN_ORDERS_UNKEYED", ["venueOrderId"]]]);
  });

  for (const withRestart of [false, true]) {
    it(`(open orders) an unknown attempt whose own order was listed once, under an unreadable id, then a lagging list without it${withRestart ? ", a restart" : ""}: never answered ABSENT (the UNKEYED_ORDER makes every run conclude nothing)`, async () => {
      let r = await ready();
      const port = r.u.world.readPort();
      const before: ReadFaults = { listOpenOrders: await port.listOpenOrders().then((answer) => () => answer), listTrades: await port.listTrades().then((answer) => () => answer) };
      r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
      const attempt = await submitOne(r.oms);
      r.u.world.faults.listOpenOrders = (answer) => {
        const read = answer() as { orders: Row[] };
        return { ...read, orders: read.orders.map((row) => ({ ...row, venueOrderId: 7 })) };
      };
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      // A lagging adapter: the open-orders and trades reads from before the order existed.
      r.u.world.faults = before;
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
      expect(oracle(r)).toEqual([]);
    });
  }

  it("(by id) `found: true` with a row whose id is unreadable: the order asked about exists (BY_ID_FOUND), and the row is an UNKEYED_ORDER obligation", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const order = must([...r.u.world.orders.values()][0], "order");
    r.u.world.faults.listOpenOrders = (answer) => ({ ...(answer() as Row), orders: [] });
    r.u.world.faults.readOrder = (id, answer) => {
      const read = answer() as Row;
      return id === order.venueOrderId ? { ...read, order: { ...(read["order"] as Row), venueOrderId: "" } } : read;
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    expect(await obligationsNow(r)).toHaveLength(1);
    expect(r.p.journal.evidence().filter((record) => record.source === "BY_ID_FOUND" || record.source === "BY_ID_UNKEYED").map((record) => [record.evidenceKind, record.venueOrderId])).toEqual([
      ["UNKEYED_ORDER", null],
      ["ORDER", order.venueOrderId],
    ]);
    expect(oracle(r)).toEqual([]);
  });

  it("(by id, control) `found: true` whose row names ANOTHER readable id: the flag may be that row's, so the id asked about is not credited found; not found by id, it is a releasable ghost, not a contradiction", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const other = must([...r.u.world.orders.values()][0], "order");
    const phantom = "venue-phantom-r11";
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: phantom, status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    r.u.world.faults.readOrder = (id, answer) => (id === phantom ? { route: "/data/order", found: true, order: r.u.world.orderView(other) } : answer());
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.p.journal.evidence().filter((record) => record.source === "BY_ID_FOUND")).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().some((view) => view.breakClass === "ORDER_NOT_FOUND_BY_ID" && view.subjectKey.includes(phantom))).toBe(true);
    expect(r.p.journal.unresolvedBreaks().some((view) => view.breakClass === "READ_CONFLICT" && view.subjectKey === compositeKey("READ_CONFLICT", "order", phantom))).toBe(false);
  });

  it("(trades) a row whose trade id AND a leg fact are unreadable: the leg is kept with every fact it validated, an obligation no read can meet (no trade can be shown to have exactly its facts): held for good, never booked", async () => {
    const setup = await trackedLag();
    const r = setup.r;
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: TradeRow[] };
      return { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === setup.t2.venueTradeId ? { ...entry, venueTradeId: 42, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, feeAmount: "bad" })) } : entry)) };
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = setup.stale;
    expect(await reconcileRounds(r, 3)).toBe(false);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 4)).toBe(false);
    // The order holds for good, so nothing is delivered from it: trade-2's fill waits with it (fail closed).
    expect(fills(r)).toEqual(["trade-1"]);
    expect(oracle(r)).toEqual([]);
    const report = await r.p.coordinator.reconcile();
    expect(report.runs.flatMap((run) => run.detections).some((entry) => entry.subjectKey === compositeKey("READ_CONFLICT", "order", setup.t2.venueOrderId) && entry.detail.includes("a fact of it could not be read"))).toBe(true);
    expect(r.p.journal.evidence().filter((record) => record.evidenceKind === "UNKEYED_LEG").map((record) => [record.source, record.size, record.unreadable])).toEqual([["TRADES_LEG_UNKEYED_FRAGMENTS", "0.4", ["feeAmount"]]]);
  });

  it("(trades) an own leg whose ORDER id is unreadable, under a readable trade id, is an ORPHAN_LEG: a later in-full read of the trade with another leg is a durable contradiction, never resumed", async () => {
    const setup = await trackedLag();
    const r = setup.r;
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: TradeRow[] };
      return { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === setup.t2.venueTradeId ? { ...entry, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, venueOrderId: 7 })) } : entry)) };
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    // A read that shows the trade in full, with other economics (an offsetting price and fee): a lie the orphan's facts expose.
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: TradeRow[] };
      return { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === setup.t2.venueTradeId ? { ...entry, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, price: "0.4", feeAmount: "0.04", feeAssetId: "asset-pusd" })) } : entry)) };
    };
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(oracle(r)).toEqual([]);
    expect(fills(r)).toEqual(["trade-1"]);
    const report = await r.p.coordinator.reconcile();
    expect(report.runs.flatMap((run) => run.detections).some((entry) => entry.subjectKey === compositeKey("READ_CONFLICT", "trade", setup.t2.venueTradeId) && entry.detail.includes("whose venue order id was unreadable"))).toBe(true);
  });

  it("(trades, control) the same orphan, then the truthful in-full read: it is one of the trade's legs; the fill is delivered and the account resumes", async () => {
    const setup = await trackedLag();
    const r = setup.r;
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: TradeRow[] };
      return { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === setup.t2.venueTradeId ? { ...entry, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, venueOrderId: 7 })) } : entry)) };
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual(["trade-1", "trade-2"]);
    expect(oracle(r)).toEqual([]);
    expect(r.p.journal.evidence().filter((record) => record.evidenceKind === "ORPHAN_LEG").map((record) => [record.venueTradeId, record.size, record.unreadable])).toEqual([[setup.t2.venueTradeId, "0.4", ["venueOrderId"]]]);
  });

  it("(the user stream) a fill whose shares are inexact (the OMS refuses it) still names its trade and order: a lagging trades read without that trade holds; the reads catch up, resumed", async () => {
    const setup = await trackedLag();
    const r = setup.r;
    const output = streamTrade(r.u, setup.t2.venueTradeId) as { kind: string; oms: { fills: Row[] } };
    r.p.coordinator.onUserStreamOutput({ ...output, oms: { ...output.oms, fills: output.oms.fills.map((fill) => ({ ...fill, shares: "0.40" })) } });
    await r.p.coordinator.settled();
    expect(fills(r)).toEqual(["trade-1"]);
    r.u.world.faults = setup.stale;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(oracle(r)).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual(["trade-1", "trade-2"]);
    expect(oracle(r)).toEqual([]);
    expect(r.p.journal.evidence().filter((record) => record.source === "STREAM_FILL").map((record) => [record.venueTradeId, record.venueOrderId, record.size, record.unreadable])).toEqual([[setup.t2.venueTradeId, setup.t2.venueOrderId, null, ["shares"]]]);
  });

  it("(the user stream) a fills list with one entry that is not own data: the valid sibling reaches the OMS at once; the opaque entry is an obligation of the account, held in every run", async () => {
    const setup = await trackedLag();
    const r = setup.r;
    const output = streamTrade(r.u, setup.t2.venueTradeId) as { kind: string; oms: { fills: Row[]; settlements: unknown[]; shortfalls: unknown[] } };
    const list: unknown[] = [output.oms.fills[0], { ...output.oms.fills[0] }];
    Object.defineProperty(list, "1", { get: () => output.oms.fills[0], enumerable: true });
    r.p.coordinator.onUserStreamOutput({ ...output, oms: { ...output.oms, fills: list } });
    await r.p.coordinator.settled();
    expect(fills(r).sort()).toEqual(["trade-1", "trade-2"]);
    const held = await obligationsNow(r);
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("a trade row whose trade id was unreadable");
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(oracle(r)).toEqual([]);
  });

  it("(the user stream) an output whose kind cannot be read is not ignored: it is an obligation of the account, and a run is triggered", async () => {
    const r = await ready();
    const output: Record<string, unknown> = { oms: { fills: [], settlements: [], shortfalls: [] } };
    Object.defineProperty(output, "kind", { get: () => "TRADE", enumerable: true });
    r.p.coordinator.onUserStreamOutput(output);
    await r.p.coordinator.settled();
    expect(r.p.coordinator.status().holding).toBe(true);
    const held = await obligationsNow(r);
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("unreadable: kind");
    expect(oracle(r)).toEqual([]);
  });

  it("(positions) every row of an unusable positions answer is kept as HOLDING evidence (detail: not monotonic), its unreadable fragments named", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    must(r.u.world.match(must(r.u.world.receipts.at(-1), "receipt"), "0.4"), "match");
    r.u.world.faults.readPositions = (answer) => {
      const read = answer() as { positions: Row[] };
      return { ...read, positions: [...read.positions, { tokenId: "not a token", size: "0.2" }] };
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    const holdings = r.p.journal.evidence().filter((record) => record.evidenceKind === "HOLDING" && record.source === "POSITIONS");
    expect(holdings.map((record) => [record.provenance, record.value, record.unreadable])).toEqual(
      expect.arrayContaining([
        ["SHOWN", "0.4", []],
        ["NAMED", "0.2", ["tokenId"]],
      ]),
    );
  });
});

// ---- the wallet member door -----------------------------------------------------------------------------------

const HASH_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const split = { type: "SPLIT", operationId: "op-split-r11", accountRef: INVENTORY_ACCOUNT, conditionId: CONDITION, amount: "10" };

function walletRig(r: Ready): { readonly wallet: WalletOperationManager; readonly answers: Record<string, unknown>[] } {
  const answers: Record<string, unknown>[] = [];
  const wallet = new WalletOperationManager({
    requestToken: requestTokens("w11"),
    book: seededBook({ [INV_PUSD]: "100", [INV_YES]: "20", [INV_NO]: "20" }),
    approvals: new ApprovalTracker(),
    executor: { submit: async () => ({ status: "SUBMITTED", transactionHash: HASH_A, transactionId: null }) },
    reconciler: { request: (request: InventoryRequest) => r.p.coordinator.walletRequester.request(request) },
  });
  const port: ReconciledWalletOperations = {
    resolveByReconciliation: (operationId, evidence) => {
      answers.push(evidence as Record<string, unknown>);
      return wallet.resolveByReconciliation(operationId, evidence);
    },
    retryReconciliationRequests: () => wallet.retryReconciliationRequests(),
    outstandingReconciliationRequests: () => wallet.outstandingReconciliationRequests(),
    events: () => wallet.events(),
    operation: (operationId) => wallet.operation(operationId),
  };
  r.p.coordinator.bindWalletOperations(port);
  return { wallet, answers };
}

describe("WP-290 r11 (the class fix): a wallet member's state shown in an unusable answer is evidence", () => {
  it("(wallet member) FAILED in an answer whose amount is unreadable, then CONFIRMED in a valid one: a durable contradiction, never answered, never resumed", async () => {
    const r = await ready();
    const rig = walletRig(r);
    expect(rig.wallet.plan(split).ok).toBe(true);
    expect((await rig.wallet.submit(split.operationId)).ok).toBe(true);
    rig.wallet.observe(split.operationId, { status: "DROPPED", transactionHash: HASH_A });
    r.u.world.faults.readWalletMember = () => ({ state: "FAILED", transactionHash: HASH_A, credited: "bad" });
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    r.u.world.walletMembers.set(`hash:${HASH_A}`, { state: "CONFIRMED", transactionHash: HASH_A, credited: null });
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(rig.answers).toEqual([]);
    const conflict = r.p.journal.unresolvedBreaks().find((view) => view.subjectKey === compositeKey("READ_CONFLICT", "wallet-member", `hash:${HASH_A}`));
    expect(conflict?.detail).toContain("both FAILED and CONFIRMED");
    expect(r.p.journal.evidence().filter((record) => record.evidenceKind === "MEMBER").map((record) => [record.status, record.unreadable])).toEqual([
      ["FAILED", ["credited"]],
      ["CONFIRMED", []],
    ]);
  });

  it("(wallet member, control) a malformed answer with no state, then CONFIRMED: nothing contradicts it: answered by name", async () => {
    const r = await ready();
    const rig = walletRig(r);
    expect(rig.wallet.plan(split).ok).toBe(true);
    expect((await rig.wallet.submit(split.operationId)).ok).toBe(true);
    rig.wallet.observe(split.operationId, { status: "DROPPED", transactionHash: HASH_A });
    r.u.world.faults.readWalletMember = () => ({ state: 42, transactionHash: HASH_A, credited: null });
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    r.u.world.walletMembers.set(`hash:${HASH_A}`, { state: "CONFIRMED", transactionHash: HASH_A, credited: null });
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(rig.answers.map((answer) => answer["state"])).toEqual(["CONFIRMED"]);
  });
});
