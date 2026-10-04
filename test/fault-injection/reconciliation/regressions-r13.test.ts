/**
 * WP-290 r13: the round-13 joint report's finding (Claude Opus and Codex gpt-6-astra, `reconcile-r13/joint.md`), and
 * the instances of its class the round's closed-vocabulary audit found, kept as named regressions with their controls.
 * Every finding pin fails on 2708cb5 on a BEHAVIOURAL assertion (a resume on lagging reads, an oracle violation, an
 * ABSENT accepted for an order the venue holds, an UNATTRIBUTED booking of a wallet operation's own effect), and passes
 * here. Each journal and trigger check is asserted AFTER the behavioural ones, so that on 2708cb5 each pin fails on its
 * behaviour first.
 *
 * - WP290-V13-STREAM-UNKNOWN-KIND-SILENT = WP290-CX-R13-01 (HIGH): a WP-280 output whose `kind` is a READABLE string
 *   outside WP-280's closed vocabulary (`""`, `"Trade"`, `"TRADE "`, `"order"`, ...) was read as carrying nothing (the
 *   early returns in `coordinator.ts` `onUserStreamOutput` and `door.ts` `readStreamOutput`). Now one classifier
 *   (`door.ts`, `classifyStreamOutput`) decides for both: such a kind, and a non-activity kind on an output carrying an
 *   activity output's key, is the durable unreadable `kind` obligation, and a run (`P13-KIND-*`).
 * - The audit (the finding's required re-audit of every closed-vocabulary discriminant): a settlement status no one can
 *   ORDER (unreadable, or outside the documented vocabulary) fixed no constraint on a later read, so a lagging read
 *   showing the trade MATCHED answered a trade the venue had FAILED, and the account resumed with the fill booked:
 *   - on a user-stream settlement (WP-280's five statuses are closed: `P13-SETTLE-STATUS`);
 *   - on a keyed trades-read row (`P13-READ-STATUS`), and on a row whose trade id was unreadable (r11's
 *     `settlementAgrees`: `P13-UNKEYED-STATUS`).
 *   Now such a status marks the trade, and only an observation of it at a terminal status answers it (`evidence.ts`).
 * - The audit, the inventory's events: an event whose state was outside WP-300's closed vocabulary (or unreadable), an
 *   event that was not own data, an events answer that was not a list, or a view whose quarantine flag was not `false`,
 *   was read as settled, so the holdings were judged while the operation moved them, and its own effect was booked
 *   UNATTRIBUTED (`P13-WALLET-*`). Now each is unsettled and in flight.
 *
 * PAPER only: every port is the in-memory simulated venue (and a real WP-300 manager whose executor is a mock); no
 * network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { ApprovalTracker, WalletOperationManager } from "../../../packages/inventory/src/index.js";
import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager, ReconciledWalletOperations } from "../../../packages/oms/src/index.js";
import { classifyStreamOutput, readStreamOutput, streamItemFragments } from "../../../packages/oms/src/reconciliation/door.js";
import { ACCOUNT as INVENTORY_ACCOUNT, CONDITION, NO as INV_NO, PUSD as INV_PUSD, YES as INV_YES, requestTokens, seededBook } from "../../unit/inventory/helpers.js";

import { boot, streamTrade } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import type { ReadFaults } from "./support/world.js";

type Row = Record<string, unknown>;
type Output = { readonly kind: string; readonly oms: Row };

async function restarted(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`no ${what}`);
  return value;
}

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

/** Every read lags behind the fill: no trades, no positions, the collateral as before, the order by id with 0 matched (r7's helper). */
function lagEveryRead(r: Ready, collateral: string): void {
  r.u.world.faults = {
    listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
    readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
    readCollateral: (answer) => ({ ...(answer() as Row), balance: collateral }),
    readOrder: (_id, answer) => {
      const read = answer() as { order?: Row };
      return { ...read, order: { ...read.order, sizeMatched: "0" } };
    },
  };
}

/** A consistent snapshot of every read, as the venue answers now (a lagging adapter replays it). */
async function snapshot(r: Ready, venueOrderId: string | null): Promise<ReadFaults> {
  const port = r.u.world.readPort();
  const open = await port.listOpenOrders();
  const trades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  const faults: ReadFaults = { listOpenOrders: () => open, listTrades: () => trades, readPositions: () => positions, readCollateral: () => collateral };
  if (venueOrderId !== null) {
    const byId = await port.readOrder(venueOrderId);
    faults.readOrder = () => byId;
  }
  return faults;
}

/** `rounds` runs on the reads as they are, the clock past the horizon after each: whether ANY resumed. */
async function anyResumed(r: Ready, rounds: number): Promise<boolean> {
  let resumed = false;
  for (let round = 0; round < rounds; round += 1) {
    resumed = (await r.p.coordinator.reconcile()).resumed || resumed;
    r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
  }
  return resumed;
}

/** The journaled stream obligations of the account: [evidence kind, source, unreadable names]. */
function streamObligations(r: Ready): (string | readonly string[])[][] {
  return r.p.journal
    .evidence()
    .filter((record) => record.source === "STREAM_UNREADABLE" || record.source === "STREAM_ORDER_UNKEYED")
    .map((record) => [record.evidenceKind, record.source, record.unreadable]);
}

/** One more run's detections whose detail says a settlement status could not be ordered (r13). */
async function unorderedNow(r: Ready): Promise<string[]> {
  const report = await r.p.coordinator.reconcile();
  return report.runs.flatMap((run) => run.detections).filter((entry) => entry.detail.includes("no one can order")).map((entry) => `${entry.breakClass} ${entry.subjectKey}`);
}

// ---------------------------------------------------------------------------
// The finding: a stream output's kind outside WP-280's vocabulary.

/**
 * A tracked BUY of 1 at 0.5, resumed; the venue matches 0.4; the stream reports it as `shape` (WP-280's TRADE output);
 * the order is canceled and every read lags; possibly a restart.
 */
async function fillThenLag(shape: (full: Output) => unknown, withRestart: boolean): Promise<{ r: Ready; triggered: readonly string[] }> {
  const r0 = await ready();
  await submitOne(r0.oms);
  expect(await reconcileRounds(r0, 3)).toBe(true);
  const collateral = r0.u.world.collateral;
  const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4"), "match");
  r0.p.coordinator.onUserStreamOutput(shape(streamTrade(r0.u, trade.venueTradeId) as Output));
  await r0.p.coordinator.settled();
  const triggered = r0.p.coordinator.status().pendingTriggers;
  r0.u.world.cancel(trade.venueOrderId);
  lagEveryRead(r0, collateral);
  return { r: withRestart ? await restarted(r0) : r0, triggered };
}

/** An UNKNOWN submission the venue took (LIVE); the stream's ORDER output for it as `shape`; the list reads replay a snapshot from before it; possibly a restart. */
async function unknownOrderThenLag(shape: (full: Output) => unknown, withRestart: boolean): Promise<{ r: Ready; attempt: string; holding: boolean; triggered: readonly string[] }> {
  const r0 = await ready();
  const stale = await snapshot(r0, null);
  r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
  const attempt = must(await submitOne(r0.oms), "attempt");
  const order = must(r0.u.world.orders.get(must(r0.u.world.receipts.at(-1), "receipt")), "venue order");
  expect(order.status).toBe("LIVE");
  r0.p.coordinator.onUserStreamOutput(shape({ kind: "ORDER", oms: { observation: { venueOrderId: order.venueOrderId, status: "LIVE" }, shortfalls: [] } }));
  await r0.p.coordinator.settled();
  const holding = r0.p.coordinator.status().holding;
  const triggered = r0.p.coordinator.status().pendingTriggers;
  r0.u.world.faults = stale;
  return { r: withRestart ? await restarted(r0) : r0, attempt, holding, triggered };
}

function absents(r: Ready, attempt: string): unknown[] {
  return r.u.accepted.filter((answer) => answer.attemptId === attempt && answer.verdict === "ABSENT");
}

describe("WP-290 r13 (WP290-V13-STREAM-UNKNOWN-KIND-SILENT = WP290-CX-R13-01): a stream output's kind outside WP-280's vocabulary is an unreadable obligation, journaled, and a run", () => {
  for (const withRestart of [false, true]) {
    const tag = withRestart ? ", a restart" : "";
    for (const kind of ["", "Trade", "TRADE ", "TRADE_BAD", "STATE"]) {
      it(`(P13-KIND-TRADE ${JSON.stringify(kind)}${tag}) a TRADE output under that kind, then every read lags: never resumed, nothing lost; caught up: still held (the obligation), the fill never delivered from an unsound run`, async () => {
        const { r, triggered } = await fillThenLag((full) => ({ ...full, kind }), withRestart);
        // 2708cb5: resumed with the fill lost (OMS 0 vs venue 0.4; the ledger's collateral and token out of line).
        expect(await anyResumed(r, 4)).toBe(false);
        expect(oracle(r)).toEqual([]);
        r.u.world.faults = {};
        expect(await anyResumed(r, 4)).toBe(false);
        expect(r.oms.orders()[0]?.filledShares).toBe("0");
        expect(oracle(r)).toEqual([]);
        // The mechanism, asserted last: the unreadable kind is a journaled obligation of the account; a run was due at once.
        expect(streamObligations(r)).toEqual([["UNKEYED_TRADE", "STREAM_UNREADABLE", ["kind"]]]);
        expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
      });
    }
    for (const kind of ["order", "ORDERS", "ORDER_BAD", "UNRECOGNIZED_MESSAGE"]) {
      it(`(P13-KIND-ORDER ${JSON.stringify(kind)}${tag}) an unknown submission's ORDER output under that kind; the list reads lag behind the order: never ABSENT, never resumed`, async () => {
        const { r, attempt, holding, triggered } = await unknownOrderThenLag((full) => ({ ...full, kind }), withRestart);
        // 2708cb5: ABSENT accepted for an order the venue holds (R2), and resumed.
        expect(await anyResumed(r, 4)).toBe(false);
        expect(absents(r, attempt)).toEqual([]);
        expect(oracle(r)).toEqual([]);
        r.u.world.faults = {};
        expect(await anyResumed(r, 3)).toBe(false);
        expect(absents(r, attempt)).toEqual([]);
        expect(oracle(r)).toEqual([]);
        expect(streamObligations(r)).toEqual([["UNKEYED_TRADE", "STREAM_UNREADABLE", ["kind"]]]);
        expect(holding).toBe(true);
        expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
      });
    }
  }

  it("(P13-KIND, RECONCILIATION_REQUESTED carrying a projection) the request is taken AND the output is an unreadable obligation: never resumed while it stands", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    const request = { requestId: "r13-request", cause: "SOCKET_CLOSED", markets: [] };
    stream.pending.push(request);
    r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request, oms: { fills: [], settlements: [], shortfalls: [] } });
    // The request is taken at once, whatever else the output carries.
    expect(r.p.coordinator.status().pendingStreamRequests).toBe(1);
    await r.p.coordinator.settled();
    // 2708cb5: the request alone; the projection was never routed, and the next complete run resumed (acknowledging it).
    expect(await anyResumed(r, 3)).toBe(false);
    expect(streamObligations(r)).toEqual([["UNKEYED_TRADE", "STREAM_UNREADABLE", ["kind"]]]);
    // A run holding an account obligation is not sound: the request stays owed, never acknowledged by it.
    expect(stream.acknowledged).toEqual([]);
    expect(r.p.coordinator.status().pendingStreamRequests).toBe(1);
  });

  for (const [name, output] of [
    ["STATE", { kind: "STATE", from: "CONNECTED", to: "RECONNECTING", cause: null, subscriptionGeneration: 1 }],
    ["UNRECOGNIZED_MESSAGE", { kind: "UNRECOGNIZED_MESSAGE", reason: "UNKNOWN_EVENT_TYPE", field: "event_type", receipt: { subscriptionGeneration: 1, frameSequence: 1, indexInFrame: 0, receivedAt: null } }],
  ] as const) {
    it(`(P13, control: ${name} as WP-280 emits it) carries nothing: no hold, no run, nothing journaled; trading continues`, async () => {
      const r = await ready();
      r.p.coordinator.onUserStreamOutput(output);
      await r.p.coordinator.settled();
      expect(r.p.coordinator.status().holding).toBe(false);
      expect(r.p.coordinator.status().pendingTriggers).toEqual([]);
      expect(streamObligations(r)).toEqual([]);
      expect(await reconcileRounds(r, 2)).toBe(true);
    });
  }

  it("(P13, control: RECONCILIATION_REQUESTED as WP-280 emits it) the request is taken at once, acknowledged by id after a complete run, and trading resumes; nothing is journaled as an obligation", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    const request = { requestId: "r13-plain", cause: "SOCKET_CLOSED", markets: [] };
    stream.pending.push(request);
    r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request });
    expect(r.p.coordinator.status().pendingStreamRequests).toBe(1);
    expect(r.p.coordinator.status().holding).toBe(true);
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(stream.acknowledged).toEqual(["r13-plain"]);
    expect(streamObligations(r)).toEqual([]);
  });

  for (const withRestart of [false, true]) {
    it(`(P13, control: well formed${withRestart ? ", a restart" : ""}) a TRADE output: applied, nothing journaled; the lagging reads hold; caught up, resumed consistent`, async () => {
      const { r } = await fillThenLag((full) => full, withRestart);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(streamObligations(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 6)).toBe(true);
      expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
      expect(oracle(r)).toEqual([]);
    });
  }

  for (const withRestart of [false, true]) {
    it(`(P13-KIND-REREAD${withRestart ? ", a restart" : ""}) an output whose kind reads TRADE when received and STATE (its projection gone) when routed: the routed output read as nothing is the unreadable obligation; every read lags: never resumed`, async () => {
      // A proxy: its own data changes between the coordinator's read at receipt and the door's read at routing.
      const flipping = (output: Row): object => {
        let kindReads = 0;
        const hidden = (key: string | symbol): boolean => kindReads >= 2 && (key === "oms" || key === "event");
        return new Proxy(output, {
          getOwnPropertyDescriptor(target, key) {
            if (key === "kind") {
              kindReads += 1;
              return { value: kindReads === 1 ? "TRADE" : "STATE", writable: true, enumerable: true, configurable: true };
            }
            return hidden(key) ? undefined : Reflect.getOwnPropertyDescriptor(target, key);
          },
          has(target, key) {
            return hidden(key) ? false : Reflect.has(target, key);
          },
        });
      };
      const { r, triggered } = await fillThenLag((full) => flipping(full as unknown as Row), withRestart);
      // 2708cb5 (and r13 before this guard): the routed output carried nothing, only a run: resumed with the fill lost.
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(streamObligations(r)).toEqual([["UNKEYED_TRADE", "STREAM_UNREADABLE", ["kind"]]]);
      expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
    });
  }

  it("(P13, the classifier) every kind outside WP-280's five, and a non-activity kind carrying an activity key, is unreadable in both entry points' one classifier; WP-280's own outputs are read as before", () => {
    const projection = { fills: [], settlements: [], shortfalls: [] };
    for (const kind of ["", "Trade", "TRADE ", "trade", "order", "ORDERS", "TRADE_BAD", "ORDER_BAD"]) {
      expect(classifyStreamOutput({ kind, oms: projection }), kind).toEqual({ read: "UNREADABLE", request: false });
      expect(readStreamOutput({ kind, oms: projection }), kind).toEqual({ kind: null, items: [], unreadable: [{ kind: "FILL", field: "kind" }] });
      expect(classifyStreamOutput({ kind }), `${kind}, no projection`).toEqual({ read: "UNREADABLE", request: false });
    }
    for (const kind of ["STATE", "UNRECOGNIZED_MESSAGE"]) {
      expect(classifyStreamOutput({ kind }), kind).toEqual({ read: "NOTHING", request: false });
      expect(readStreamOutput({ kind }), kind).toEqual({ kind: null, items: [], unreadable: [] });
      for (const key of ["oms", "event"]) {
        expect(classifyStreamOutput({ kind, [key]: {} }), `${kind} + ${key}`).toEqual({ read: "UNREADABLE", request: false });
        expect(classifyStreamOutput({ kind, [key]: undefined }), `${kind} + ${key} undefined`).toEqual({ read: "UNREADABLE", request: false });
      }
      const accessor = { kind };
      Object.defineProperty(accessor, "oms", { get: () => projection, enumerable: true });
      expect(classifyStreamOutput(accessor), `${kind} + an accessor`).toEqual({ read: "UNREADABLE", request: false });
    }
    expect(classifyStreamOutput({ kind: "RECONCILIATION_REQUESTED", request: {} })).toEqual({ read: "NOTHING", request: true });
    expect(classifyStreamOutput({ kind: "RECONCILIATION_REQUESTED", request: {}, oms: projection })).toEqual({ read: "UNREADABLE", request: true });
    expect(classifyStreamOutput({ kind: "ORDER" })).toEqual({ read: "ORDER", request: false });
    expect(classifyStreamOutput({ kind: "TRADE", oms: projection })).toEqual({ read: "TRADE", request: false });
    for (const kind of [7, null, undefined, ["TRADE"], { kind: "TRADE" }]) expect(classifyStreamOutput({ kind, oms: projection }), String(kind)).toEqual({ read: "UNREADABLE", request: false });
    expect(classifyStreamOutput({ oms: projection })).toEqual({ read: "UNREADABLE", request: false });
    expect(classifyStreamOutput(null)).toEqual({ read: "UNREADABLE", request: false });
  });
});

// ---------------------------------------------------------------------------
// The audit: a settlement status no one can order.

/** WP-280's projection of one settlement event (no fill: the OMS holds it), its status as given. */
function settlementOutput(trade: { readonly venueTradeId: string; readonly venueOrderId: string }, status: unknown): Row {
  return { kind: "TRADE", oms: { fills: [], settlements: [{ venueTradeId: trade.venueTradeId, venueOrderId: trade.venueOrderId, status, transactionHash: null, observedAt: "2026-10-03T00:00:01Z" }], shortfalls: [] } };
}

/**
 * A tracked BUY of 1 at 0.5 matched 0.4 (MATCHED), its fill delivered by the stream, resumed; the venue then FAILS the
 * trade; the stream reports the FAILED settlement with its status as `status`; the reads replay the snapshot from
 * before the failure; possibly a restart.
 */
async function failedThenLag(status: unknown, withRestart: boolean): Promise<{ r: Ready; tradeId: string }> {
  const r0 = await ready();
  await submitOne(r0.oms);
  expect(await reconcileRounds(r0, 3)).toBe(true);
  const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
  r0.p.coordinator.onUserStreamOutput(streamTrade(r0.u, trade.venueTradeId));
  await r0.p.coordinator.settled();
  expect(await reconcileRounds(r0, 3)).toBe(true);
  const stale = await snapshot(r0, trade.venueOrderId);
  r0.u.world.failTrade(trade);
  r0.p.coordinator.onUserStreamOutput(settlementOutput(trade, status));
  await r0.p.coordinator.settled();
  r0.u.world.faults = stale;
  return { r: withRestart ? await restarted(r0) : r0, tradeId: trade.venueTradeId };
}

function settlementAlerts(r: Ready): string[] {
  return r.oms
    .alerts()
    .map((alert) => (alert as { kind?: string }).kind ?? "?")
    .filter((kind) => kind.startsWith("SETTLEMENT"));
}

describe("WP-290 r13 (the closed-vocabulary audit): a settlement status no one can order is answered only by an observation of the trade at a terminal status", () => {
  for (const withRestart of [false, true]) {
    const tag = withRestart ? ", a restart" : "";
    for (const status of ["FAILED ", "Failed", "BOGUS", 7, null]) {
      it(`(P13-SETTLE-STATUS ${JSON.stringify(status)}${tag}) the stream's FAILED settlement under that status, then the snapshot from before replays: never resumed (the ledger would keep a token the venue no longer holds); the venue's FAILED read answers it`, async () => {
        const { r, tradeId } = await failedThenLag(status, withRestart);
        // 2708cb5: resumed on the stale snapshot, the ledger projecting 0.4 of a token the venue holds 0 of.
        expect(await anyResumed(r, 4)).toBe(false);
        expect(oracle(r)).toEqual([]);
        // The reads are truthful: the venue shows the trade FAILED (terminal), which answers the status; the OMS
        // applies the failure from the read, and holds on its own halting alert, exactly as for a well-formed FAILED.
        r.u.world.faults = {};
        expect(await anyResumed(r, 3)).toBe(false);
        expect(oracle(r)).toEqual([]);
        expect(settlementAlerts(r)).toContain("SETTLEMENT_FAILED");
        expect(await unorderedNow(r)).toEqual([]);
        // The mechanism, asserted last: the door read the status as unreadable (WP-280's five are closed).
        expect(streamItemFragments("SETTLEMENT", { venueTradeId: tradeId, venueOrderId: "v", status, transactionHash: null }).unreadable).toEqual(["status"]);
      });
    }
  }

  for (const withRestart of [false, true]) {
    it(`(P13-SETTLE-STATUS, control: omitted${withRestart ? ", a restart" : ""}) the stream's FAILED settlement under an unreadable status, then complete trades reads that OMIT the trade (the rest of the snapshot from before): never resumed (the order's own guards hold it too: ORDER_TRADES_INCOMPLETE, ORDER_FILLS_AHEAD_OF_VENUE); the venue's FAILED read answers it`, async () => {
      const r0 = await ready();
      await submitOne(r0.oms);
      expect(await reconcileRounds(r0, 3)).toBe(true);
      const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
      r0.p.coordinator.onUserStreamOutput(streamTrade(r0.u, trade.venueTradeId));
      await r0.p.coordinator.settled();
      expect(await reconcileRounds(r0, 3)).toBe(true);
      const stale = await snapshot(r0, trade.venueOrderId);
      r0.u.world.failTrade(trade);
      r0.p.coordinator.onUserStreamOutput(settlementOutput(trade, "Failed"));
      await r0.p.coordinator.settled();
      r0.u.world.faults = { ...stale, listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }) };
      const r = withRestart ? await restarted(r0) : r0;
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await anyResumed(r, 3)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(settlementAlerts(r)).toContain("SETTLEMENT_FAILED");
    });
  }

  it("(P13-SETTLE-STATUS, liveness) the stream's CONFIRMED settlement under an unreadable status, the trade confirmed: held while the reads show it MATCHED; a read showing it CONFIRMED answers it, and trading resumes", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = must(r.u.world.match(must(r.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade.venueTradeId));
    await r.p.coordinator.settled();
    expect(await reconcileRounds(r, 3)).toBe(true);
    const stale = await snapshot(r, trade.venueOrderId);
    trade.status = "CONFIRMED";
    r.p.coordinator.onUserStreamOutput(settlementOutput(trade, "Confirmed"));
    await r.p.coordinator.settled();
    r.u.world.faults = stale;
    // 2708cb5: resumed at once on the stale MATCHED read (harmless here, as the trade confirmed; the FAILED arms above
    // show what the same resume costs when it did not).
    expect(await anyResumed(r, 3)).toBe(false);
    expect((await unorderedNow(r)).length).toBeGreaterThan(0);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(await unorderedNow(r)).toEqual([]);
    expect(oracle(r)).toEqual([]);
  });

  for (const status of ["FAILED", "TRADE_STATUS_FAILED"]) {
    it(`(P13-SETTLE-STATUS, control: ${status}) ${status === "FAILED" ? "well formed: the OMS applies it and holds on its halting alert" : "the REST spelling, outside WP-280's projection: unreadable now (it held on 2708cb5 too, as a READ_REGRESSION)"}; never resumed on the stale snapshot`, async () => {
      const { r } = await failedThenLag(status, false);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await anyResumed(r, 3)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(settlementAlerts(r)).toContain("SETTLEMENT_FAILED");
    });
  }

  /**
   * A tracked BUY matched 0.4 (MATCHED), no stream; then (`keyedFirst`) a run reads it MATCHED, resumed; the venue FAILS
   * the trade (`stale`: the snapshot from before the failure). One run reads the truth with the trade's row showing
   * `status` (and, `unkeyed`, its trade id unreadable); then the snapshot replays; possibly a restart.
   */
  async function readStatusThenLag(status: unknown, unkeyed: boolean, withRestart: boolean): Promise<Ready> {
    const r0 = await ready();
    await submitOne(r0.oms);
    expect(await reconcileRounds(r0, 3)).toBe(true);
    const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
    if (!unkeyed) expect(await reconcileRounds(r0, 4)).toBe(true);
    const stale = await snapshot(r0, trade.venueOrderId);
    r0.u.world.failTrade(trade);
    r0.u.world.faults = {
      listTrades: (answer) => {
        const read = answer() as { trades: Row[] };
        return { ...read, trades: read.trades.map((row) => (row["venueTradeId"] === trade.venueTradeId ? { ...row, status, ...(unkeyed ? { venueTradeId: 42 } : {}) } : row)) };
      },
    };
    r0.p.coordinator.trigger("PERIODIC_TIMER");
    expect((await r0.p.coordinator.reconcile()).resumed).toBe(false);
    r0.u.clock.t += r0.u.policy.quiescenceHorizonMs + 1;
    r0.u.world.faults = stale;
    return withRestart ? await restarted(r0) : r0;
  }

  for (const withRestart of [false, true]) {
    const tag = withRestart ? ", a restart" : "";
    for (const status of ["Failed", 7, "MATCHED_NOT_BROADCASTED"]) {
      it(`(P13-READ-STATUS ${JSON.stringify(status)}${tag}) a trades read shows the FAILED trade's row under that status; then the snapshot from before replays (MATCHED): never resumed; the FAILED read answers it`, async () => {
        const r = await readStatusThenLag(status, false, withRestart);
        // 2708cb5: STATUS_UNRECOGNISED (or the malformed read) held that run only; the stale MATCHED read resumed it.
        expect(await anyResumed(r, 4)).toBe(false);
        expect(oracle(r)).toEqual([]);
        r.u.world.faults = {};
        expect(await anyResumed(r, 3)).toBe(false);
        expect(oracle(r)).toEqual([]);
        expect(await unorderedNow(r)).toEqual([]);
      });

      it(`(P13-UNKEYED-STATUS ${JSON.stringify(status)}${tag}) a trades read shows the FAILED trade's row under that status AND its trade id unreadable, before any read named the trade; then the snapshot from before replays (MATCHED, by id): never resumed`, async () => {
        const r = await readStatusThenLag(status, true, withRestart);
        // 2708cb5: the stale MATCHED witness "agreed" with a status that fixed no constraint (r11), and it resumed.
        expect(await anyResumed(r, 4)).toBe(false);
        expect(oracle(r)).toEqual([]);
        r.u.world.faults = {};
        await anyResumed(r, 3);
        expect(oracle(r)).toEqual([]);
      });
    }
  }

  it("(P13-READ-STATUS, liveness) C-3's MATCHED_NOT_BROADCASTED, then MINED: held (MINED may be behind it); then CONFIRMED: answered, and trading resumes", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = must(r.u.world.match(must(r.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED_NOT_BROADCASTED" }), "match");
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    trade.status = "MINED";
    // 2708cb5: resumed at MINED (no constraint from the unrecognised status).
    expect(await anyResumed(r, 3)).toBe(false);
    expect((await unorderedNow(r)).length).toBeGreaterThan(0);
    trade.status = "CONFIRMED";
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(P13-READ-STATUS, control: after a terminal status) a trade already shown CONFIRMED, then read under an unrecognised status: the run that read it still holds (STATUS_UNRECOGNISED: never assumed harmless, though its terminal status answers the unordered mark); the next CONFIRMED read resumes", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = must(r.u.world.match(must(r.u.world.receipts.at(-1), "receipt"), "0.4"), "match");
    expect(trade.status).toBe("CONFIRMED");
    expect(await reconcileRounds(r, 4)).toBe(true);
    trade.status = "BOGUS";
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(report.resumed).toBe(false);
    expect(report.runs.flatMap((run) => run.detections).map((entry) => entry.subjectKey)).toContain(compositeKey("STATUS_UNRECOGNISED", "trade", trade.venueTradeId));
    expect(await unorderedNow(r)).toEqual([]);
    trade.status = "CONFIRMED";
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(P13-READ-STATUS, control: FAILED) the same read with the documented status: held on both trees (a READ_REGRESSION once the stale MATCHED replays)", async () => {
    const r = await readStatusThenLag("FAILED", false, false);
    expect(await anyResumed(r, 4)).toBe(false);
    expect(oracle(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The audit: the inventory's events.

class FakeStream {
  readonly pending: { readonly requestId: string; readonly cause: string; readonly markets: readonly string[] }[] = [];
  readonly acknowledged: string[] = [];
  pendingReconciliationRequests(): readonly { readonly requestId: string; readonly cause: string; readonly markets: readonly string[] }[] {
    return [...this.pending];
  }
  acknowledgeReconciliationRequest(requestId: string): boolean {
    const index = this.pending.findIndex((request) => request.requestId === requestId);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.acknowledged.push(requestId);
    return true;
  }
}

const HASH_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const split = { type: "SPLIT", operationId: "op-split-290", accountRef: INVENTORY_ACCOUNT, conditionId: CONDITION, amount: "10" };

/** A real WP-300 manager bound to the coordinator (its executor a mock: nothing is signed or sent), its events and views passed through `events` and `view`. */
function walletRig(r: Ready, events: (real: readonly Row[]) => unknown, view: (real: unknown) => unknown): WalletOperationManager {
  const wallet = new WalletOperationManager({
    requestToken: requestTokens("w"),
    book: seededBook({ [INV_PUSD]: "100", [INV_YES]: "20", [INV_NO]: "20" }),
    approvals: new ApprovalTracker(),
    executor: { submit: async () => ({ status: "SUBMITTED", transactionHash: HASH_A, transactionId: null }) },
    reconciler: { request: (request) => r.p.coordinator.walletRequester.request(request) },
  });
  const port = {
    resolveByReconciliation: (operationId: string, evidence: unknown) => wallet.resolveByReconciliation(operationId, evidence),
    retryReconciliationRequests: () => wallet.retryReconciliationRequests(),
    outstandingReconciliationRequests: () => wallet.outstandingReconciliationRequests(),
    events: () => events(wallet.events() as unknown as readonly Row[]),
    operation: (operationId: string) => view(wallet.operation(operationId)),
  } as unknown as ReconciledWalletOperations;
  r.p.coordinator.bindWalletOperations(port);
  return wallet;
}

const lastEvent =
  (change: (event: Row) => unknown) =>
  (events: readonly Row[]): unknown[] =>
    events.map((event, index) => (index === events.length - 1 ? change(event) : event));

function corrections(r: Ready): number {
  return r.u.ledger.transactions().filter((appended) => appended.transaction.eventType === "RECONCILIATION_CORRECTION").length;
}

describe("WP-290 r13 (the closed-vocabulary audit): an inventory event or view outside WP-300's vocabulary is unsettled and in flight, never settled", () => {
  const same = (value: unknown): unknown => value;
  for (const [name, events] of [
    ['newState "Submitted"', lastEvent((event) => ({ ...event, newState: "Submitted" }))],
    ['newState "SUBMITTED "', lastEvent((event) => ({ ...event, newState: "SUBMITTED " }))],
    ["newState 7", lastEvent((event) => ({ ...event, newState: 7 }))],
    ["the last event's operationId 7", lastEvent((event) => ({ ...event, operationId: 7 }))],
    ["the last event an accessor", (real: readonly Row[]) => {
      const copy: unknown[] = [...real];
      const last = copy.length - 1;
      const value = copy[last];
      Object.defineProperty(copy, String(last), { get: () => value, enumerable: true });
      return copy;
    }],
    ["the events not a list", () => ({ length: 0 })],
  ] as const) {
    it(`(P13-WALLET ${name}) an operation submitted, the chain moved by it: holdings are not judged, and its effect is never booked UNATTRIBUTED`, async () => {
      const r = await ready();
      const wallet = walletRig(r, events as (real: readonly Row[]) => unknown, same);
      expect(wallet.plan(split).ok).toBe(true);
      expect((await wallet.submit(split.operationId)).ok).toBe(true);
      r.u.world.adjustCollateral("-10");
      const classes = new Set<string>();
      let resumed = false;
      for (let round = 0; round < 3; round += 1) {
        r.p.coordinator.trigger("PERIODIC_TIMER");
        const report = await r.p.coordinator.reconcile();
        resumed = resumed || report.resumed;
        for (const run of report.runs) for (const detection of run.detections) classes.add(detection.breakClass);
        r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
      }
      // 2708cb5: the state (or the event) was read as settled; the holdings were judged and the operation's own effect
      // booked UNATTRIBUTED (a RECONCILIATION_CORRECTION in the ledger).
      expect(corrections(r)).toBe(0);
      expect(resumed).toBe(false);
      expect(classes.has("WALLET_OPERATION_IN_FLIGHT")).toBe(true);
      expect(classes.has("WALLET_OPERATION_UNSETTLED")).toBe(true);
    });
  }

  it("(P13-WALLET, control: SUBMITTED as WP-300 reports it) in flight: holdings are not judged, nothing booked (X2)", async () => {
    const r = await ready();
    const wallet = walletRig(r, same as (real: readonly Row[]) => unknown, same);
    expect(wallet.plan(split).ok).toBe(true);
    expect((await wallet.submit(split.operationId)).ok).toBe(true);
    r.u.world.adjustCollateral("-10");
    for (let round = 0; round < 3; round += 1) {
      r.p.coordinator.trigger("PERIODIC_TIMER");
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
    }
    expect(corrections(r)).toBe(0);
  });

  for (const [name, view] of [
    ['quarantined "false" (text)', (real: unknown) => ({ ...(real as Row), quarantined: "false" })],
    ["quarantined missing", (real: unknown) => {
      const copy = { ...(real as Row) };
      delete copy["quarantined"];
      return copy;
    }],
    ["no view", () => undefined],
  ] as const) {
    it(`(P13-WALLET-VIEW ${name}) a CONFIRMED operation whose view does not say, as own data, that it is not quarantined: unsettled, never resumed`, async () => {
      const r = await ready();
      const wallet = walletRig(r, same as (real: readonly Row[]) => unknown, view);
      expect(wallet.plan(split).ok).toBe(true);
      expect((await wallet.submit(split.operationId)).ok).toBe(true);
      wallet.observe(split.operationId, { status: "CONFIRMED", transactionHash: HASH_A, transactionId: null });
      expect(wallet.operation(split.operationId)?.state).toBe("CONFIRMED");
      r.p.coordinator.trigger("PERIODIC_TIMER");
      // 2708cb5: `quarantined === true` read anything else as not quarantined, and it resumed.
      expect(await reconcileRounds(r, 3)).toBe(false);
      expect(r.p.journal.unresolvedBreaks().map((entry) => entry.subjectKey)).toContain(compositeKey("WALLET_OPERATION_UNSETTLED", split.operationId));
    });
  }

  it("(P13-WALLET-VIEW, control: quarantined false) the same CONFIRMED operation as WP-300 reports it: settled, and trading resumes", async () => {
    const r = await ready();
    const wallet = walletRig(r, (real) => real, (real) => real);
    expect(wallet.plan(split).ok).toBe(true);
    expect((await wallet.submit(split.operationId)).ok).toBe(true);
    wallet.observe(split.operationId, { status: "CONFIRMED", transactionHash: HASH_A, transactionId: null });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 3)).toBe(true);
  });
});
