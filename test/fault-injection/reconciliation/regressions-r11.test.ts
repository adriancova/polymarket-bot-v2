/**
 * WP-290 r11: the round-11 joint report's finding (Claude Opus and Codex gpt-6-astra, `reconcile-r11/joint.md`), kept
 * as named regressions with its controls and recovery tails. Every finding pin fails on c62489f on a BEHAVIOURAL
 * assertion (a resume during the stale window), and passes here.
 *
 * - WP290-V11-UNKEYED-STATUS-DROPPED / WP290-CX-R11-01: an own leg shown under an unreadable trade id kept its fill
 *   facts as an obligation, but its settlement status only as detail: never folded, and dropped by the grouping (only
 *   the first status among rows of identical facts survived). A FAILED settlement shown unkeyed in a WHOLE answer was
 *   then discharged by a stale witness read by id: a CONFIRMED one (a terminal contradiction) or a MINED one (a
 *   backwards read). The fill was booked and the account resumed with the ledger disagreeing with the venue; an
 *   unknown submission was answered PRESENT.
 *
 * r11 keeps the status through grouping (one record per status, each with the fill's whole count), dedup and replay,
 * and lets a witness answer the obligation only when its settlement AGREES with every status the unkeyed rows showed
 * (`evidence.ts`, `settlementAgrees`): the same terminal status, or a status at or after a non-terminal one; a terminal
 * contradiction, a backwards read, or a candidate that disagrees (an ambiguous assignment) keeps the hold. Nothing
 * unkeyed is ever booked. The units are in `units-r11.test.ts`. Each journal check is asserted after the behavioural
 * ones, so that on c62489f each finding pin fails on its behaviour first.
 *
 * PAPER only: every port is the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";

import { boot, bookReversal } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import type { ReadFaults, VenueTrade } from "./support/world.js";

type Row = Record<string, unknown>;
type TradeRow = Row & { readonly venueTradeId: string; readonly ownLegs: Row[] };

async function restarted(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

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

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

function unresolved(r: Ready, breakClass: string, ...subject: string[]): { readonly detail: string; readonly status: string } | undefined {
  return r.p.journal.unresolvedBreaks().find((view) => view.breakClass === breakClass && view.subjectKey === compositeKey(breakClass, ...subject));
}

/** One more run (the reads as they are now): the detail its own detection of the subject gave, if any (a break's journaled detail is its FIRST run's). */
async function detectedNow(r: Ready, breakClass: string, ...subject: string[]): Promise<string | undefined> {
  const report = await r.p.coordinator.reconcile();
  expect(report.resumed).toBe(false);
  return report.runs.flatMap((run) => run.detections).find((entry) => entry.breakClass === breakClass && entry.subjectKey === compositeKey(breakClass, ...subject))?.detail;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

/** The UNKEYED_LEG records the journal holds on one venue order: [source, status, level]. */
function unkeyedRecords(r: Ready, venueOrderId: string): (string | number | null)[][] {
  return r.p.journal
    .evidence()
    .filter((record) => record.evidenceKind === "UNKEYED_LEG" && record.venueOrderId === venueOrderId)
    .map((record) => [record.source, record.status, record.level]);
}

/** A consistent snapshot of every read, as the venue answers now: a lagging adapter replays it. */
async function snapshot(r: Ready, venueOrderId: string): Promise<ReadFaults> {
  const port = r.u.world.readPort();
  const open = await port.listOpenOrders();
  const trades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  const byId = await port.readOrder(venueOrderId);
  return { listOpenOrders: () => open, listTrades: () => trades, readPositions: () => positions, readCollateral: () => collateral, readOrder: () => byId };
}

type Shape = "UNKEYED" | "KEYED_MALFORMED" | "VALID";

/** The trades answer with the given trades shown as `shape` (an unreadable trade id; a readable id with a malformed leg; as is). */
function garble(read: unknown, targets: readonly string[], shape: Shape, complete = true): unknown {
  const answer = read as { trades: TradeRow[] };
  return {
    ...answer,
    complete,
    trades: answer.trades.map((entry, index) => {
      if (!targets.includes(entry.venueTradeId) || shape === "VALID") return entry;
      if (shape === "UNKEYED") return { ...entry, venueTradeId: index % 2 === 0 ? 42 : "" };
      return { ...entry, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, feeAmount: "bad" })) };
    }),
  };
}

/**
 * A TRACKED order: trade-1 (0.4) delivered; trade-2 (0.4) matched with `status2`; the snapshot taken; trade-2 FAILS at
 * the venue (its holdings move back); one run reads the truth with trade-2's row shown as `shape`. Returns before the
 * stale window.
 */
async function tracked(status2: "CONFIRMED" | "MINED", shape: Shape, complete = true): Promise<{ r: Ready; t2: VenueTrade; stale: ReadFaults }> {
  const r = await ready();
  await submitOne(r.oms);
  expect(await reconcileRounds(r, 3)).toBe(true);
  const salt = must(r.u.world.receipts.at(-1), "receipt");
  must(r.u.world.match(salt, "0.4"), "first match");
  expect(await reconcileRounds(r, 3)).toBe(true);
  const t2 = must(r.u.world.match(salt, "0.4", { status: status2 }), "second match");
  const stale = await snapshot(r, t2.venueOrderId);
  r.u.world.failTrade(t2);
  r.u.world.faults.listTrades = (answer) => garble(answer(), [t2.venueTradeId], shape, complete);
  expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
  return { r, t2, stale };
}

/** An UNKNOWN submission whose order the venue took and matched (status `status`), the snapshot taken, then the trade FAILS; one run reads the truth, the trade shown as `shape`. */
async function unknown(status: "CONFIRMED" | "MINED", shape: Shape): Promise<{ r: Ready; t: VenueTrade; stale: ReadFaults; attempt: string | null }> {
  const r = await ready();
  r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
  const attempt = await submitOne(r.oms);
  const t = must(r.u.world.match(must(r.u.world.receipts.at(-1), "receipt"), "0.4", { status }), "match");
  const stale = await snapshot(r, t.venueOrderId);
  r.u.world.failTrade(t);
  r.u.world.faults.listTrades = (answer) => garble(answer(), [t.venueTradeId], shape);
  expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
  return { r, t, stale, attempt };
}

/** The keyed FAILED path, once the witness agrees: the operator books the reversal and releases; the account resumes consistent. */
async function settleFailed(r: Ready, trade: VenueTrade): Promise<void> {
  expect(await reconcileRounds(r, 3)).toBe(false);
  bookReversal(r.u, trade.venueTradeId, trade.venueOrderId);
  await releaseAll(r, "the FAILED fill's reversal is booked");
  expect(await reconcileRounds(r, 4)).toBe(true);
  expect(r.p.journal.unresolvedBreaks()).toEqual([]);
  expect(oracle(r)).toEqual([]);
}

describe("WP-290 r11 (WP290-V11-UNKEYED-STATUS-DROPPED / WP290-CX-R11-01): an unkeyed row's settlement status is kept, and a witness answers it only when its settlement agrees", () => {
  for (const withRestart of [false, true]) {
    it(`(V11, tracked, a FAILED row unkeyed, a stale CONFIRMED witness${withRestart ? ", a restart" : ""}) a terminal contradiction: never resumed while it lags; the truthful reads then show the trade both ways: held for good, as the keyed control`, async () => {
      const setup = await tracked("CONFIRMED", "UNKEYED");
      let r = setup.r;
      r.u.world.faults = setup.stale;
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(fills(r)).toEqual(["trade-1"]);
      const held = must(await detectedNow(r, "READ_CONFLICT", "order", setup.t2.venueOrderId), "the order's hold");
      expect(held).toContain("status FAILED");
      expect(held).toContain(`disagreeing: ${setup.t2.venueTradeId}`);
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(unresolved(r, "READ_CONFLICT", "trade", setup.t2.venueTradeId)?.detail).toContain("both CONFIRMED and FAILED");
      expect(oracle(r)).toEqual([]);
      // The status reached the journal (and so the restart): one record, FAILED, whole.
      expect(unkeyedRecords(r, setup.t2.venueOrderId)).toEqual([["TRADES_LEG_UNKEYED", "FAILED", 1]]);
    });

    it(`(V11, tracked, a FAILED row unkeyed, a stale MINED witness${withRestart ? ", a restart" : ""}) a backwards read: never resumed while it lags; the truthful FAILED witness agrees: the keyed FAILED path, reversed, resumes consistent`, async () => {
      const setup = await tracked("MINED", "UNKEYED");
      let r = setup.r;
      r.u.world.faults = setup.stale;
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(fills(r)).toEqual(["trade-1"]);
      expect(must(await detectedNow(r, "READ_CONFLICT", "order", setup.t2.venueOrderId), "the order's hold")).toContain(`disagreeing: ${setup.t2.venueTradeId}`);
      r.u.world.faults = {};
      await settleFailed(r, setup.t2);
      expect(fills(r).sort()).toEqual(["trade-1", "trade-2"]);
      expect(unkeyedRecords(r, setup.t2.venueOrderId)).toEqual([["TRADES_LEG_UNKEYED", "FAILED", 1]]);
    });

    it(`(V11, unknown, a FAILED row unkeyed, a stale CONFIRMED witness${withRestart ? ", a restart" : ""}) never answered PRESENT, never resumed while it lags; held for good once the trade is shown both ways`, async () => {
      const setup = await unknown("CONFIRMED", "UNKEYED");
      let r = setup.r;
      r.u.world.faults = setup.stale;
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(r.u.accepted.filter((answer) => answer.attemptId === setup.attempt)).toEqual([]);
      expect(fills(r)).toEqual([]);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(unkeyedRecords(r, setup.t.venueOrderId)).toEqual([["TRADES_LEG_UNKEYED", "FAILED", 1]]);
    });

    it(`(V11, unknown, a FAILED row unkeyed, a stale MINED witness${withRestart ? ", a restart" : ""}) never answered, never resumed while it lags; the truthful FAILED witness agrees: answered PRESENT, the keyed FAILED path, reversed, resumes consistent`, async () => {
      const setup = await unknown("MINED", "UNKEYED");
      let r = setup.r;
      r.u.world.faults = setup.stale;
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(r.u.accepted.filter((answer) => answer.attemptId === setup.attempt)).toEqual([]);
      expect(fills(r)).toEqual([]);
      expect(oracle(r)).toEqual([]);
      r.u.world.faults = {};
      await settleFailed(r, setup.t);
      expect(r.u.accepted.filter((answer) => answer.attemptId === setup.attempt).map((answer) => answer.verdict)).toEqual(["PRESENT"]);
      expect(unkeyedRecords(r, setup.t.venueOrderId)).toEqual([["TRADES_LEG_UNKEYED", "FAILED", 1]]);
    });
  }

  it("(V11, status progression) an unkeyed MINED row, then a stale MATCHED witness (a backwards read): held while it lags; a MINED or later witness agrees, and the account resumes", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const salt = must(r.u.world.receipts.at(-1), "receipt");
    must(r.u.world.match(salt, "0.4"), "first match");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const t2 = must(r.u.world.match(salt, "0.4", { status: "MATCHED" }), "second match");
    const stale = await snapshot(r, t2.venueOrderId);
    t2.status = "MINED";
    r.u.world.faults.listTrades = (answer) => garble(answer(), [t2.venueTradeId], "UNKEYED");
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = stale;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(oracle(r)).toEqual([]);
    const held = must(await detectedNow(r, "READ_CONFLICT", "order", t2.venueOrderId), "the order's hold");
    expect(held).toContain("status MINED");
    expect(held).toContain(`disagreeing: ${t2.venueTradeId}`);
    // The venue confirms; the reads catch up: the witness is past MINED, so it agrees.
    t2.status = "CONFIRMED";
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual(["trade-1", "trade-2"]);
    expect(oracle(r)).toEqual([]);
    expect(unkeyedRecords(r, t2.venueOrderId)).toEqual([["TRADES_LEG_UNKEYED", "MINED", 1]]);
  });

  for (const withRestart of [false, true]) {
    it(`(V11, grouping${withRestart ? ", a restart" : ""}) two unkeyed rows of the same fill facts in one whole answer, CONFIRMED then FAILED: both statuses kept; stale CONFIRMED witnesses never discharge them; never resumed`, async () => {
      let r = await ready();
      await submitOne(r.oms);
      expect(await reconcileRounds(r, 3)).toBe(true);
      const salt = must(r.u.world.receipts.at(-1), "receipt");
      must(r.u.world.match(salt, "0.2"), "first match");
      expect(await reconcileRounds(r, 3)).toBe(true);
      const t2 = must(r.u.world.match(salt, "0.3"), "second match");
      const t3 = must(r.u.world.match(salt, "0.3"), "third match");
      const stale = await snapshot(r, t2.venueOrderId);
      r.u.world.failTrade(t3);
      r.u.world.faults.listTrades = (answer) => garble(answer(), [t2.venueTradeId, t3.venueTradeId], "UNKEYED");
      expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
      r.u.world.faults = stale;
      if (withRestart) r = await restarted(r);
      expect(await reconcileRounds(r, 5)).toBe(false);
      expect(oracle(r)).toEqual([]);
      expect(fills(r)).toEqual(["trade-1"]);
      // Each status of the one fill, each owing the fill's two trades: every candidate must agree with both.
      expect(unkeyedRecords(r, t2.venueOrderId).sort()).toEqual([
        ["TRADES_LEG_UNKEYED", "CONFIRMED", 2],
        ["TRADES_LEG_UNKEYED", "FAILED", 2],
      ]);
    });
  }

  it("(V11, control: a malformed row under a READABLE trade id) the FAILED status is the trade's own: the stale CONFIRMED read is the trade's durable contradiction, as before r11", async () => {
    const setup = await tracked("CONFIRMED", "KEYED_MALFORMED");
    const r = setup.r;
    r.u.world.faults = setup.stale;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(unresolved(r, "READ_CONFLICT", "trade", setup.t2.venueTradeId)?.detail).toContain("both CONFIRMED and FAILED");
    expect(oracle(r)).toEqual([]);
  });

  it("(V11, control: a valid read) the FAILED trade shown in full, then the stale snapshot: held, as before r11", async () => {
    const setup = await tracked("CONFIRMED", "VALID");
    const r = setup.r;
    r.u.world.faults = setup.stale;
    expect(await reconcileRounds(r, 5)).toBe(false);
    expect(unresolved(r, "READ_CONFLICT", "trade", setup.t2.venueTradeId)?.detail).toContain("both CONFIRMED and FAILED");
    expect(oracle(r)).toEqual([]);
  });

  it("(V11, control: a partial answer) its unkeyed FAILED row is never answered (r10's whole-answer rule): held through the stale window and after it", async () => {
    const setup = await tracked("MINED", "UNKEYED", false);
    const r = setup.r;
    r.u.world.faults = setup.stale;
    expect(await reconcileRounds(r, 5)).toBe(false);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(must(unresolved(r, "READ_CONFLICT", "order", setup.t2.venueOrderId), "the order's hold").detail).toContain("did not show every trade of the account");
    expect(oracle(r)).toEqual([]);
    expect(unkeyedRecords(r, setup.t2.venueOrderId)).toEqual([["TRADES_LEG_UNKEYED_PARTIAL", "FAILED", 1]]);
  });

  it("(V11, control: an unrecognised status, as a keyed row's) an unkeyed MATCHED_NOT_BROADCASTED row fixes no constraint a later read can contradict: a CONFIRMED witness answers it, as a keyed row's later CONFIRMED read does", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const salt = must(r.u.world.receipts.at(-1), "receipt");
    must(r.u.world.match(salt, "0.4"), "first match");
    expect(await reconcileRounds(r, 3)).toBe(true);
    const t2 = must(r.u.world.match(salt, "0.4"), "second match");
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: TradeRow[] };
      const relabelled = { ...read, trades: read.trades.map((entry) => (entry.venueTradeId === t2.venueTradeId ? { ...entry, status: "MATCHED_NOT_BROADCASTED" } : entry)) };
      return garble(relabelled, [t2.venueTradeId], "UNKEYED");
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 5)).toBe(true);
    expect(fills(r).sort()).toEqual(["trade-1", "trade-2"]);
    expect(oracle(r)).toEqual([]);
    expect(unkeyedRecords(r, t2.venueOrderId)).toEqual([["TRADES_LEG_UNKEYED", "MATCHED_NOT_BROADCASTED", 1]]);
  });
});
