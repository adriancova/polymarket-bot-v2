/**
 * WP-290 r12: the round-12 joint report's finding (Claude Opus and Codex gpt-6-astra, `reconcile-r12/joint.md`), kept
 * as named regressions with their controls. Every finding pin fails on b4b2f55 on a BEHAVIOURAL assertion (a resume on
 * lagging reads, an oracle violation, an ABSENT accepted for an order the venue holds), and passes here.
 *
 * - WP290-CX-R12-01 = WP290-V12-STREAM-ABSENT-LIST-SILENT: a WP-280 user-stream projection whose required key was
 *   MISSING (a TRADE output with no `fills` or no `settlements` key, an ORDER output with no `observation` key) was
 *   read as carrying nothing (`door.ts`, `readStreamOutput`): no evidence, no obligation that survives a restart, and
 *   no run. Under lagging reads the account then resumed with the fill lost (the OMS and the ledger out of line with
 *   the venue), or answered ABSENT for an unknown submission whose order the stream had observed. The same outputs
 *   with the key present but not own data, or `null`, were already a durable `UNKEYED_*` obligation.
 *
 * r12 reads a missing key as what it is, an UNREADABLE entry: journaled as an obligation of the account (it holds
 * for good, as every unreadable stream entry does since r11: runbook §10) and a run is triggered. Each journal and
 * trigger check is asserted AFTER the behavioural ones, so that on b4b2f55 each finding pin fails on its behaviour
 * first.
 *
 * The door property's key-deletion mutation and the stream door's end-to-end lag property are in
 * `door-property.test.ts`.
 *
 * PAPER only: every port is the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import { readStreamOutput } from "../../../packages/oms/src/reconciliation/door.js";

import { boot, streamTrade } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import type { ReadFaults } from "./support/world.js";

type Row = Record<string, unknown>;
type Output = { readonly kind: string; readonly oms: Row };

async function restarted(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

/** The output with the named keys of its projection deleted (a fresh object; the input is not changed). */
function withoutKeys(output: unknown, ...keys: string[]): Output {
  const full = output as Output;
  const oms: Row = { ...full.oms };
  for (const key of keys) delete oms[key];
  return { ...full, oms };
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

/** One more run: the details of the account-level UNREADABLE obligations it detects (`[READ_CONFLICT, "unreadable", n]`). */
async function obligationsNow(r: Ready): Promise<string[]> {
  const report = await r.p.coordinator.reconcile();
  expect(report.resumed).toBe(false);
  return report.runs.flatMap((run) => run.detections).filter((entry) => entry.subjectKey.startsWith(compositeKey("READ_CONFLICT", "unreadable"))).map((entry) => entry.detail);
}

/**
 * A tracked BUY of 1 at 0.5, resumed; the venue matches 0.4; the stream reports it as `shape` (WP-280's TRADE output,
 * possibly with keys missing); the order is canceled and every read lags; possibly a restart.
 */
async function fillThenLag(shape: (full: Output) => unknown, withRestart: boolean): Promise<{ r: Ready; r0: Ready; triggered: readonly string[]; venueOrderId: string }> {
  const r0 = await ready();
  await submitOne(r0.oms);
  expect(await reconcileRounds(r0, 3)).toBe(true);
  const salt = must(r0.u.world.receipts.at(-1), "receipt");
  const collateral = r0.u.world.collateral;
  const trade = must(r0.u.world.match(salt, "0.4"), "match");
  r0.p.coordinator.onUserStreamOutput(shape(streamTrade(r0.u, trade.venueTradeId) as Output));
  await r0.p.coordinator.settled();
  const triggered = r0.p.coordinator.status().pendingTriggers;
  r0.u.world.cancel(trade.venueOrderId);
  lagEveryRead(r0, collateral);
  const r = withRestart ? await restarted(r0) : r0;
  return { r, r0, triggered, venueOrderId: trade.venueOrderId };
}

describe("WP-290 r12 (WP290-CX-R12-01 = WP290-V12-STREAM-ABSENT-LIST-SILENT): a WP-280 projection with a MISSING key is an unreadable obligation, journaled, and a run", () => {
  for (const withRestart of [false, true]) {
    const tag = withRestart ? ", a restart" : "";

    it(`(P12-FILLS-ABSENT${tag}) a TRADE output with no fills key, then every read lags: never resumed, nothing lost; the reads catch up: the obligation still holds, as fills: null's does`, async () => {
      const { r, triggered } = await fillThenLag((full) => withoutKeys(full, "fills"), withRestart);
      // b4b2f55: resumed with the fill lost (OMS 0 vs venue 0.4; the ledger's collateral and token out of line).
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(r.oms.orders()[0]?.finalSize).toBeNull();
      // The reads catch up: the obligation holds for good (runbook §10), and a run holding an account obligation is not
      // sound, so nothing is delivered or booked from it (exactly as for fills: null, its control below).
      r.u.world.faults = {};
      expect(await anyResumed(r, 4)).toBe(false);
      expect(r.oms.orders()[0]?.filledShares).toBe("0");
      expect(oracle(r)).toEqual([]);
      // The mechanism, asserted last: the missing list is a journaled obligation of the account, and a run was due at once.
      expect(streamObligations(r)).toEqual([["UNKEYED_TRADE", "STREAM_UNREADABLE", ["fills"]]]);
      expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
      const held = await obligationsNow(r);
      expect(held).toHaveLength(1);
      expect(held[0]).toContain("unreadable: fills");
    });

    it(`(P12-BOTH-ABSENT${tag}) a TRADE output with neither list key, then every read lags: never resumed, nothing lost; both missing lists are obligations`, async () => {
      const { r, triggered } = await fillThenLag((full) => withoutKeys(full, "fills", "settlements"), withRestart);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(streamObligations(r)).toEqual([
        ["UNKEYED_TRADE", "STREAM_UNREADABLE", ["fills"]],
        ["UNKEYED_TRADE", "STREAM_UNREADABLE", ["settlements"]],
      ]);
      expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
    });

    it(`(P12-SETTLEMENTS-ABSENT${tag}) a delivered fill, resumed; the trade FAILS; the stream's TRADE output for it has no settlements key; the snapshot from before replays: never resumed (the ledger would keep a token the venue no longer holds)`, async () => {
      const r0 = await ready();
      await submitOne(r0.oms);
      expect(await reconcileRounds(r0, 3)).toBe(true);
      const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
      r0.p.coordinator.onUserStreamOutput(streamTrade(r0.u, trade.venueTradeId));
      await r0.p.coordinator.settled();
      expect(await reconcileRounds(r0, 3)).toBe(true);
      const stale = await snapshot(r0, trade.venueOrderId);
      r0.u.world.failTrade(trade);
      // WP-280's projection of the FAILED event (no fill: the OMS holds it), its settlements key missing.
      r0.p.coordinator.onUserStreamOutput({ kind: "TRADE", oms: { fills: [], shortfalls: [] } });
      await r0.p.coordinator.settled();
      const triggered = r0.p.coordinator.status().pendingTriggers;
      r0.u.world.faults = stale;
      const r = withRestart ? await restarted(r0) : r0;
      // b4b2f55: resumed on the stale snapshot, the ledger projecting 0.4 of a token the venue holds 0 of.
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(streamObligations(r)).toEqual([["UNKEYED_TRADE", "STREAM_UNREADABLE", ["settlements"]]]);
      expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
    });

    it(`(P12-OBSERVATION-ABSENT${tag}) an unknown submission the venue took; the stream's ORDER output for it has no observation key; the reads lag behind the order: never ABSENT, never resumed`, async () => {
      const r0 = await ready();
      const stale = await snapshot(r0, null);
      r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
      const attempt = must((await submitOne(r0.oms)) ?? undefined, "attempt");
      const order = must(r0.u.world.orders.get(must(r0.u.world.receipts.at(-1), "receipt")), "venue order");
      expect(order.status).toBe("LIVE");
      r0.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { shortfalls: [] } });
      await r0.p.coordinator.settled();
      const holding = r0.p.coordinator.status().holding;
      const triggered = r0.p.coordinator.status().pendingTriggers;
      r0.u.world.faults = stale;
      const r = withRestart ? await restarted(r0) : r0;
      // b4b2f55: ABSENT accepted for an order the venue holds (R2), and resumed.
      expect(await anyResumed(r, 4)).toBe(false);
      expect(r.u.accepted.filter((answer) => answer.attemptId === attempt && answer.verdict === "ABSENT")).toEqual([]);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await anyResumed(r, 3)).toBe(false);
      expect(r.u.accepted.filter((answer) => answer.attemptId === attempt && answer.verdict === "ABSENT")).toEqual([]);
      expect(oracle(r)).toEqual([]);
      expect(streamObligations(r)).toEqual([["UNKEYED_ORDER", "STREAM_ORDER_UNKEYED", []]]);
      expect(holding).toBe(true);
      expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
    });

    it(`(P12-FILLS-ABSENT, control: fills null${tag}) the same output with fills: null was already an obligation: the same hold, the same record (the parity r12 restores)`, async () => {
      const { r, triggered } = await fillThenLag((full) => ({ ...full, oms: { ...full.oms, fills: null } }), withRestart);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await anyResumed(r, 4)).toBe(false);
      expect(r.oms.orders()[0]?.filledShares).toBe("0");
      expect(oracle(r)).toEqual([]);
      expect(streamObligations(r)).toEqual([["UNKEYED_TRADE", "STREAM_UNREADABLE", ["fills"]]]);
      expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
    });

    it(`(P12, control: well formed${tag}) the OMS applies the fill: nothing is journaled from the stream; the lagging reads hold (a read behind the OMS); caught up, resumed consistent`, async () => {
      const { r } = await fillThenLag((full) => full, withRestart);
      expect(await anyResumed(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(streamObligations(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 6)).toBe(true);
      expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
      expect(oracle(r)).toEqual([]);
    });
  }

  it("(P12-OBSERVATION-ABSENT, control: observation present) the same unknown submission, its observation readable: the OMS retains it, its by-id read finds the order: PRESENT, never ABSENT; resumed consistent", async () => {
    const r = await ready();
    const stale = await snapshot(r, null);
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = must((await submitOne(r.oms)) ?? undefined, "attempt");
    const order = must(r.u.world.orders.get(must(r.u.world.receipts.at(-1), "receipt")), "venue order");
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: order.venueOrderId, status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    expect(r.oms.retainedEvidence().map((item) => item.venueOrderId)).toEqual([order.venueOrderId]);
    // Only the list reads lag: the retained id is read by id, which finds it.
    r.u.world.faults = { ...stale };
    await anyResumed(r, 3);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 4)).toBe(true);
    const answers = r.u.accepted.filter((answer) => answer.attemptId === attempt).map((answer) => `${answer.verdict} ${String(answer.venueOrderId)}`);
    expect(answers.length).toBeGreaterThan(0);
    expect(new Set(answers)).toEqual(new Set([`PRESENT ${order.venueOrderId}`]));
    expect(oracle(r)).toEqual([]);
    expect(streamObligations(r)).toEqual([]);
  });

  it("(P12, control: observation null) WP-280's own shape for an event that named no status (it raises its own request for it): not an obligation, no run from this output", async () => {
    const r = await ready();
    expect(readStreamOutput({ kind: "ORDER", oms: { observation: null, shortfalls: ["ORDER_STATUS_ABSENT"] } }).unreadable).toEqual([]);
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: null, shortfalls: ["ORDER_STATUS_ABSENT"] } });
    await r.p.coordinator.settled();
    expect(r.p.coordinator.status().holding).toBe(false);
    expect(r.p.coordinator.status().pendingTriggers).toEqual([]);
    expect(streamObligations(r)).toEqual([]);
    expect(await reconcileRounds(r, 2)).toBe(true);
  });

  it("(P12, control: shortfalls missing) the projection's shortfalls are not read here (WP-280 raises its own request for them): a TRADE output with every list present but no shortfalls key is applied as usual", async () => {
    const { r } = await fillThenLag((full) => withoutKeys(full, "shortfalls"), false);
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    expect(streamObligations(r)).toEqual([]);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 6)).toBe(true);
    expect(oracle(r)).toEqual([]);
  });

  it("(P12, the door) each missing key is one unreadable entry, named; `undefined` is read as missing; an ORDER output's missing projection and kind are unchanged (r11)", () => {
    const fill = { venueTradeId: "t1", venueOrderId: "venue-1", shares: "0.4", price: "0.5", liquidityRole: "MAKER", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" };
    expect(readStreamOutput({ kind: "TRADE", oms: { settlements: [], shortfalls: [] } }).unreadable).toEqual([{ kind: "FILL", field: "fills" }]);
    expect(readStreamOutput({ kind: "TRADE", oms: { fills: [fill], shortfalls: [] } })).toMatchObject({ items: [{ fragments: { kind: "FILL", venueTradeId: "t1" } }], unreadable: [{ kind: "SETTLEMENT", field: "settlements" }] });
    expect(readStreamOutput({ kind: "TRADE", oms: { shortfalls: [] } }).unreadable).toEqual([
      { kind: "FILL", field: "fills" },
      { kind: "SETTLEMENT", field: "settlements" },
    ]);
    expect(readStreamOutput({ kind: "TRADE", oms: { fills: undefined, settlements: [], shortfalls: [] } }).unreadable).toEqual([{ kind: "FILL", field: "fills" }]);
    expect(readStreamOutput({ kind: "ORDER", oms: { shortfalls: [] } })).toEqual({ kind: "ORDER", items: [], unreadable: [{ kind: "ORDER", field: "observation" }] });
    expect(readStreamOutput({ kind: "ORDER", oms: { observation: undefined, shortfalls: [] } })).toEqual({ kind: "ORDER", items: [], unreadable: [{ kind: "ORDER", field: "observation" }] });
    expect(readStreamOutput({ kind: "ORDER" }).unreadable).toEqual([{ kind: "ORDER", field: "oms" }]);
    expect(readStreamOutput({ kind: "TRADE" }).unreadable).toEqual([{ kind: "FILL", field: "oms" }]);
    expect(readStreamOutput({ oms: { fills: [], settlements: [] } }).unreadable).toEqual([{ kind: "FILL", field: "kind" }]);
    expect(readStreamOutput({ kind: "TRADE", oms: { fills: [], settlements: [], shortfalls: [] } })).toEqual({ kind: "TRADE", items: [], unreadable: [] });
  });
});
