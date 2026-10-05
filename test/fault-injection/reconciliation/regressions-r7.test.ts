/**
 * WP-290 r7: the round-7 joint report's reproductions (Claude Opus and Codex gpt-6-astra, `reconcile-r7/joint.md`),
 * kept as named regressions, each with its control. Every pin fails on 0c6ad41 on a BEHAVIOURAL assertion (an answer
 * accepted, a fill booked, a resume, an oracle violation, a missing break), and passes here.
 *
 * - WP290-CX-R7-01: contradictory immutable order facts made a foreign twin the only exact candidate (PRESENT).
 * - WP290-CX-R7-02: a fill's changed economics (an offsetting price and fee, the same net debit) were booked.
 * - WP290-CX-R7-03: a foreign trade a read showed, later left out of complete reads, was never classified.
 * - WP290-V7-STREAM-REFUSAL-DROPPED: a stream fill or settlement the OMS refused with a code outside the r6 list
 *   (a store failure, a standing fault, an unknown fill) was neither applied nor kept, and triggered no run.
 *
 * PAPER only: every port is the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";

import { NO, PUSD, YES, boot, reopenOms, streamTrade } from "./support/harness.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import { OUR_OWNER, wireTrade, wp280Emit } from "./support/wp280.js";

type Row = Record<string, unknown>;

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

function partial(answer: () => unknown): unknown {
  return { ...(answer() as Row), complete: false };
}

/**
 * The R7-01 setup: an attempt whose answer was lost (its order reached the venue), and a foreign EXACT twin (BUY 1
 * at 0.5 on YES). A partial open-orders answer shows both; the attempt's own order is then canceled with nothing
 * matched, and its by-id read shows another value of one fixed fact.
 */
async function twinWithChangedFact(fact: "price" | "tokenId" | "originalSize" | null): Promise<{ r0: Ready; attempt: string | null; real: string; twin: string }> {
  const r0 = await ready();
  r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
  const attempt = await submitOne(r0.oms);
  const real = r0.u.world.orders.get(r0.u.world.receipts.at(-1) as string)?.venueOrderId as string;
  const twin = r0.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" }).venueOrderId;
  r0.u.world.faults.listOpenOrders = partial;
  await r0.p.coordinator.reconcile();
  r0.u.world.cancel(real);
  const changed = { price: "0.6", tokenId: NO, originalSize: "2" };
  r0.u.world.faults =
    fact === null
      ? {}
      : {
          readOrder: (id, answer) => {
            const read = answer() as { order?: Row };
            return id === real ? { ...read, order: { ...read.order, [fact]: changed[fact] } } : read;
          },
        };
  return { r0, attempt, real, twin };
}

describe("WP-290 r7 (WP290-CX-R7-01): a replaced known fixed fact is a durable contradiction; it never manufactures a unique signed-identity candidate", () => {
  for (const withRestart of [false, true]) {
    for (const fact of ["price", "tokenId", "originalSize"] as const) {
      it(`(R7-01, ${fact}${withRestart ? ", a restart" : ""}) the attempt's own order, seen beside its exact twin, then read by id with another ${fact}: never PRESENT on the twin, held for good`, async () => {
        const { r0, attempt, real } = await twinWithChangedFact(fact);
        const r = withRestart ? await restarted(r0) : r0;
        expect(await reconcileRounds(r, 3)).toBe(false);
        expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
        expect(r.u.violations).toEqual([]);
        // Truthful reads again: the order's facts were shown two ways, so the contradiction stands (no identity answer).
        r.u.world.faults = {};
        expect(await reconcileRounds(r, 3)).toBe(false);
        expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
        const conflict = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_CONFLICT" && view.subjectKey.includes(real));
        expect(conflict?.detail).toContain("different fixed facts");
        expect(r.u.violations).toEqual([]);
      });
    }
  }

  for (const withRestart of [false, true]) {
    it(`(OPUS-R7-01-RELEASE${withRestart ? ", a restart" : ""}) an operator releases everything presented: no resume, the OMS never tracks the twin, and the twin's later fill is never booked as the attempt's`, async () => {
      const { r0, attempt, twin } = await twinWithChangedFact("price");
      const r = withRestart ? await restarted(r0) : r0;
      expect(await reconcileRounds(r, 3)).toBe(false);
      await releaseAll(r, "canceled with nothing matched");
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(r.oms.orders().filter((order) => order.venueOrderId === twin)).toEqual([]);
      const salt = [...r.u.world.orders.values()].find((order) => order.venueOrderId === twin)?.salt as string;
      r.u.world.match(salt, "0.4");
      await releaseAll(r, "acknowledged");
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(r.u.store.snapshotSync().fills.filter((fill) => fill.venueOrderId === twin)).toEqual([]);
      expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
      expect(r.u.violations).toEqual([]);
    });
  }

  it("(R7-01, control) the same facts read again keep both candidates: nothing is answered (the disclosed identity ambiguity)", async () => {
    const { r0: r, attempt } = await twinWithChangedFact(null);
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.u.accepted.filter((answer) => answer.attemptId === attempt)).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("SIGNED_IDENTITY_AMBIGUOUS");
    expect(r.u.violations).toEqual([]);
  });
});

/** The R7-02 setup: a lost answer whose order matched 0.4 at 0.5, fee 0; a partial trades answer shows the fill. */
async function fillSeenOnce(): Promise<Ready> {
  const r0 = await ready();
  r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
  await submitOne(r0.oms);
  r0.u.world.match(r0.u.world.receipts.at(-1) as string, "0.4");
  r0.u.world.faults.listTrades = partial;
  expect((await r0.p.coordinator.reconcile()).resumed).toBe(false);
  return r0;
}

/** Every later trades read shows the fill at 0.49 with a 0.004 collateral fee: 0.4 x 0.49 + 0.004 = 0.4 x 0.5. */
function offsettingEconomics(r: Ready): void {
  r.u.world.faults = {
    listTrades: (answer) => {
      const read = answer() as { trades: { ownLegs: Row[] }[] };
      return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, price: "0.49", feeAmount: "0.004", feeAssetId: PUSD })) })) };
    },
  };
}

describe("WP-290 r7 (WP290-CX-R7-02): a fill's economics shown two ways are a durable contradiction, even at equal shares and equal net balances", () => {
  for (const withRestart of [false, true]) {
    it(`(R7-02${withRestart ? ", a restart" : ""}) shown at 0.5 with fee 0 in a partial answer, then at 0.49 with fee 0.004 in complete ones: never delivered or booked, never resumed`, async () => {
      const r0 = await fillSeenOnce();
      offsettingEconomics(r0);
      const r = withRestart ? await restarted(r0) : r0;
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(r.u.store.snapshotSync().fills).toEqual([]);
      const conflict = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_CONFLICT" && view.detail.includes("different fill facts"));
      expect(conflict?.detail).toContain("price 0.5 / 0.49");
      expect(conflict?.detail).toContain("feeAmount 0 / 0.004");
      await releaseAll(r, "acknowledged");
      expect(await reconcileRounds(r, 3)).toBe(false);
      expect(r.u.violations).toEqual([]);
    });
  }

  for (const [variant, change] of [
    ["the fee alone", { feeAmount: "0.004", feeAssetId: PUSD }],
    ["the liquidity role alone", { role: "TAKER" }],
  ] as const) {
    it(`(R7-02, ${variant}) shown one way in a partial answer, another in complete ones: never delivered or booked, never resumed`, async () => {
      const r = await fillSeenOnce();
      r.u.world.faults = {
        listTrades: (answer) => {
          const read = answer() as { trades: { ownLegs: Row[] }[] };
          return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, ...change })) })) };
        },
      };
      expect(await reconcileRounds(r, 4)).toBe(false);
      expect(r.u.store.snapshotSync().fills).toEqual([]);
      expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_CONFLICT")?.detail ?? "").toContain("different fill facts");
      expect(r.u.violations).toEqual([]);
    });
  }

  it("(R7-02, the stream's facts) a fill the stream reported (fee 0) that the OMS could not record, then reads showing it with a fee: the two venue sources disagree, never delivered", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    refuseFillWrites(r);
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? "?"));
    await r.p.coordinator.settled();
    r.u.store.hooks.before = undefined;
    r.u.world.faults = {
      listTrades: (answer) => {
        const read = answer() as { trades: { ownLegs: Row[] }[] };
        return { ...read, trades: read.trades.map((entry) => ({ ...entry, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, feeAmount: "0.001", feeAssetId: PUSD })) })) };
      },
    };
    const p = await reopenOms(r.u, r.p);
    const again: Ready = { ...r, p, oms: p.oms as OrderManager };
    expect(await reconcileRounds(again, 4)).toBe(false);
    expect(again.u.store.snapshotSync().fills).toEqual([]);
    expect(again.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_CONFLICT")?.detail ?? "").toContain("feeAmount 0 / 0.001");
    expect(again.u.violations).toEqual([]);
  });

  it("(R7-02, control) the truthful reads resume with the fill booked at 0.5, fee 0", async () => {
    const r = await fillSeenOnce();
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.u.store.snapshotSync().fills.map((fill) => [fill.price, fill.feeAmount])).toEqual([["0.5", "0"]]);
    expect(r.u.violations).toEqual([]);
  });

  it("(R7-02, a match time) the same instant at another precision is no contradiction; another instant is", async () => {
    const r = await fillSeenOnce();
    r.u.world.faults = {
      listTrades: (answer) => {
        const read = answer() as { trades: { ownLegs: Row[] }[] };
        return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, matchedAt: "2026-10-03T00:00:00.000Z" })) })) };
      },
    };
    expect(await reconcileRounds(r, 4)).toBe(true);
    r.u.world.faults = {
      listTrades: (answer) => {
        const read = answer() as { trades: { ownLegs: Row[] }[] };
        return { ...read, trades: read.trades.map((trade) => ({ ...trade, ownLegs: trade.ownLegs.map((leg) => ({ ...leg, matchedAt: "2026-10-03T00:00:01Z" })) })) };
      },
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 3)).toBe(false);
    // (A mechanism pin for the r7 comparator: 0c6ad41 holds here too, by the OMS's FILL_MISMATCH.)
    const conflict = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_CONFLICT");
    expect(conflict?.detail ?? "").toContain("matchedAt");
  });
});

/** The R7-03 setup: a foreign order matched 0.4; a partial trades answer shows the trade; the order is canceled. */
async function foreignTradeSeenOnce(): Promise<{ r0: Ready; tradeId: string; foreign: string }> {
  const r0 = await ready();
  const foreign = r0.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
  const trade = r0.u.world.match(foreign.salt, "0.4");
  r0.u.world.faults.listTrades = partial;
  expect((await r0.p.coordinator.reconcile()).resumed).toBe(false);
  r0.u.world.cancel(foreign.venueOrderId);
  return { r0, tradeId: trade?.venueTradeId as string, foreign: foreign.venueOrderId };
}

describe("WP-290 r7 (WP290-CX-R7-03): every trade a read showed carries a classification obligation; a complete read that drops it holds", () => {
  for (const withRestart of [false, true]) {
    it(`(R7-03${withRestart ? ", a restart" : ""}) a foreign trade a partial answer showed, then left out of complete answers: named TRADE_UNATTRIBUTED from its evidence, and the account never resumes, every quarantine released`, async () => {
      const { r0, tradeId, foreign } = await foreignTradeSeenOnce();
      r0.u.world.faults = { listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }) };
      const r = withRestart ? await restarted(r0) : r0;
      let resumed = false;
      for (let round = 0; round < 5; round += 1) {
        resumed = (await reconcileRounds(r, 2)) || resumed;
        await releaseAll(r, "acknowledge only recorded external activity");
      }
      expect(resumed).toBe(false);
      const breaks = r.p.journal.breaks();
      expect(breaks.some((view) => view.breakClass === "TRADE_UNATTRIBUTED" && view.subjectKey.includes(tradeId) && view.subjectKey.includes(foreign))).toBe(true);
      const held = r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "READ_CONFLICT" && view.subjectKey.includes(tradeId));
      expect(held?.detail).toContain("missing from a complete trades read");
      // While the trade's absence holds, no run is conclusive: nothing is booked from the holdings, nothing resolved.
      expect(r.u.ledger.transactions().filter((appended) => appended.transaction.eventType === "RECONCILIATION_CORRECTION")).toEqual([]);
      expect(r.p.journal.events().filter((event) => event.kind === "BREAK_RESOLVED" && event.resolution !== "OPERATOR_RELEASED")).toEqual([]);
      expect(r.u.violations).toEqual([]);
    });
  }

  for (const withRestart of [false, true]) {
    it(`(OPUS-R7-03-PRESENTED${withRestart ? ", a restart" : ""}) what the operator is shown names the trade itself`, async () => {
      const { r0, tradeId } = await foreignTradeSeenOnce();
      r0.u.world.faults = { listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }) };
      const r = withRestart ? await restarted(r0) : r0;
      expect(await reconcileRounds(r, 2)).toBe(false);
      const presented = r.p.journal.unresolvedBreaks();
      expect(presented.some((view) => view.subjectKey.includes(tradeId) || view.detail.includes(tradeId))).toBe(true);
      expect(presented.filter((view) => view.status === "QUARANTINED").some((view) => view.breakClass === "TRADE_UNATTRIBUTED" && view.subjectKey.includes(tradeId))).toBe(true);
    });
  }

  it("(R7-03, control) the trade read again is classified UNATTRIBUTED, and the hold on its absence clears", async () => {
    const { r0: r, tradeId } = await foreignTradeSeenOnce();
    r.u.world.faults = { listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }) };
    expect(await reconcileRounds(r, 2)).toBe(false);
    r.u.world.faults = {};
    await reconcileRounds(r, 3);
    expect(r.p.journal.breaks().some((view) => view.breakClass === "TRADE_UNATTRIBUTED" && view.subjectKey.includes(tradeId))).toBe(true);
    expect(r.p.journal.unresolvedBreaks().filter((view) => view.breakClass === "READ_CONFLICT")).toEqual([]);
    await releaseAll(r, "acknowledged");
    await releaseAll(r, "acknowledged");
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.u.violations).toEqual([]);
  });

  it("(R7-03, the evidence's legs) a trade only the stream named, on an UNATTRIBUTED order the trades read shows without it: TRADE_UNATTRIBUTED under its own id", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    const trade = r.u.world.match(foreign.salt, "0.4");
    // The stream reports the foreign fill (the OMS refuses it: no attempt can own its order); the trades read lags.
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? "?"));
    await r.p.coordinator.settled();
    r.u.world.faults = { listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }) };
    expect(await reconcileRounds(r, 2)).toBe(false);
    const breaks = r.p.journal.breaks();
    expect(breaks.some((view) => view.breakClass === "ORDER_UNATTRIBUTED" && view.subjectKey.includes(foreign.venueOrderId))).toBe(true);
    expect(breaks.some((view) => view.breakClass === "TRADE_UNATTRIBUTED" && view.subjectKey.includes(trade?.venueTradeId ?? "?"))).toBe(true);
  });

  it("(R7-03, an attempt could own it) a missing trade held for another reason (its economics shown two ways) whose order an unresolved attempt could own is never classified UNATTRIBUTED", async () => {
    // The attempt's answer was lost (its order reached the venue and matched 0.4); partial trades answers show the
    // fill two ways (a durable contradiction), then a complete one omits it. The order could be the attempt's own.
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    r.u.world.faults.listTrades = partial;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults.listTrades = (answer) => {
      const read = answer() as { trades: { ownLegs: Row[] }[] };
      return { ...read, complete: false, trades: read.trades.map((entry) => ({ ...entry, ownLegs: entry.ownLegs.map((leg) => ({ ...leg, price: "0.49" })) })) };
    };
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.world.faults = { listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }) };
    expect(await reconcileRounds(r, 3)).toBe(false);
    expect(r.oms.attempts().some((entry) => entry.submissionAttemptId === attempt && entry.venueOrderId === null)).toBe(true);
    expect(r.p.journal.unresolvedBreaks().some((view) => view.breakClass === "READ_CONFLICT" && view.subjectKey.includes(trade?.venueTradeId ?? "?"))).toBe(true);
    expect(r.p.journal.breaks().filter((view) => view.breakClass === "TRADE_UNATTRIBUTED")).toEqual([]);
    expect(r.u.violations).toEqual([]);
  });

  it("(R7-03, liveness) a trade already accounted for (TRADE_UNATTRIBUTED, released) that a complete read later leaves out (history ages it out) does not hold", async () => {
    const r = await ready();
    const foreign = r.u.world.placeForeign({ tokenId: YES, side: "BUY", price: "0.5", size: "1" });
    r.u.world.match(foreign.salt, "0.4");
    expect(await reconcileRounds(r, 2)).toBe(false);
    for (let round = 0; round < 3; round += 1) {
      await releaseAll(r, "acknowledged");
      r.u.clock.t += r.u.policy.holdingConfirmationMs + 1;
      await reconcileRounds(r, 1);
    }
    await releaseAll(r, "acknowledged");
    expect(await reconcileRounds(r, 2)).toBe(true);
    r.u.world.faults = { listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }) };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    expect(await reconcileRounds(r, 2)).toBe(true);
    expect(r.u.violations).toEqual([]);
  });
});

/** The store refuses every fill write while armed (the OMS faults on the failed commit: `storeFailed`). */
function refuseFillWrites(r: Ready): void {
  r.u.store.hooks.before = (writes) => {
    if (writes.some((write) => write.kind === "INSERT_FILL")) throw new Error("the database is unavailable");
  };
}

/** Every read lags behind the fill: no trades, no positions, the collateral as before, the order by id with 0 matched. */
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

describe("WP-290 r7 (WP290-V7-STREAM-REFUSAL-DROPPED): every stream item the OMS did not apply is kept as evidence and triggers a run, whatever the refusal", () => {
  for (const reopen of ["a restart", "a rebind to the same coordinator"] as const) {
    it(`(P7-STREAM-REFUSED, STORE_FAIL and FAULTED, ${reopen}) two fills the OMS could not record, then every read lags: never resumed, the reservation never released, nothing lost; caught up, both delivered`, async () => {
      const r0 = await ready();
      await submitOne(r0.oms);
      expect(await reconcileRounds(r0, 3)).toBe(true);
      const salt = r0.u.world.receipts.at(-1) as string;
      const collateral = r0.u.world.collateral;
      const a = r0.u.world.match(salt, "0.2");
      const b = r0.u.world.match(salt, "0.2");
      const venueOrderId = a?.venueOrderId as string;
      const codes: string[] = [];
      const record = r0.oms.recordFill.bind(r0.oms);
      Object.defineProperty(r0.oms, "recordFill", {
        configurable: true,
        value: async (raw: unknown) => {
          const result = await record(raw);
          codes.push(result.ok ? "OK" : result.refusal.code);
          return result;
        },
      });
      refuseFillWrites(r0);
      r0.p.coordinator.onUserStreamOutput(streamTrade(r0.u, a?.venueTradeId ?? "?"));
      r0.p.coordinator.onUserStreamOutput(streamTrade(r0.u, b?.venueTradeId ?? "?"));
      await r0.p.coordinator.settled();
      r0.u.store.hooks.before = undefined;
      expect(codes).toEqual(["OMS_STORE_WRITE_FAILED", "OMS_FAULTED"]);
      expect(r0.oms.faulted).toBe(true);
      const kept = r0.p.journal.evidence().filter((record) => record.venueOrderId === venueOrderId && record.source === "STREAM_FILL");
      const triggered = r0.p.coordinator.status().pendingTriggers;
      r0.u.world.cancel(venueOrderId);
      lagEveryRead(r0, collateral);
      let r: Ready;
      if (reopen === "a restart") {
        r = await restarted(r0);
      } else {
        const p = await reopenOms(r0.u, r0.p);
        r = { ...r0, p, oms: p.oms as OrderManager };
      }
      for (let round = 0; round < 4; round += 1) {
        expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
        r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
      }
      const order = r.oms.orders()[0];
      expect(order?.finalSize).toBeNull();
      expect(r.u.violations).toEqual([]);
      // The reads catch up: both fills are delivered, then the account resumes consistent.
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 6)).toBe(true);
      expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
      expect(r.u.violations).toEqual([]);
      // The mechanism (asserted last, so 0c6ad41 fails on the behaviour above): both fills were kept as journaled
      // evidence the moment the OMS refused them, and a run was due at once.
      expect(kept.map((record) => [record.venueTradeId, record.size])).toEqual([
        [a?.venueTradeId, "0.2"],
        [b?.venueTradeId, "0.2"],
      ]);
      expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
    });
  }

  for (const withRestart of [false, true]) {
    it(`(P7-STREAM-REFUSED, OMS_UNKNOWN_FILL${withRestart ? ", a restart" : ""}) a settlement the stream reports for a fill the OMS never recorded (a maker leg: no fee on the stream), then every read lags: never resumed with nothing matched`, async () => {
      const r0 = await ready();
      await submitOne(r0.oms);
      expect(await reconcileRounds(r0, 3)).toBe(true);
      const salt = r0.u.world.receipts.at(-1) as string;
      const collateral = r0.u.world.collateral;
      const trade = r0.u.world.match(salt, "0.4");
      const settlement = { venueTradeId: trade?.venueTradeId, venueOrderId: trade?.venueOrderId, status: "CONFIRMED", transactionHash: trade?.transactionHash, observedAt: "2026-10-03T00:00:01Z" };
      expect((await r0.oms.applySettlement(settlement)).ok).toBe(false);
      // (r14) WP-280 always emits the output's `event` (its normalized event): here the venue's maker trade, our order the
      // OWN maker leg. Its projection's shortfall makes the event required (WP290-V14-WP280-EVENT-IDS-DISCARDED).
      const event = wp280Emit(
        wireTrade({
          id: trade?.venueTradeId ?? "?",
          takerOrderId: "their-taker-order-1",
          assetId: trade?.tokenId ?? "?",
          side: trade?.side === "BUY" ? "SELL" : "BUY",
          size: trade?.shares ?? "?",
          price: trade?.price ?? "?",
          status: "CONFIRMED",
          traderSide: "MAKER",
          transactionHash: trade?.transactionHash ?? null,
          makers: [{ orderId: trade?.venueOrderId ?? "?", owner: OUR_OWNER, matchedAmount: trade?.shares ?? "?", price: trade?.price ?? "?", assetId: trade?.tokenId ?? "?", side: trade?.side ?? "BUY" }],
        }),
      ).output["event"];
      r0.p.coordinator.onUserStreamOutput({ kind: "TRADE", event, oms: { fills: [], settlements: [settlement], shortfalls: ["MAKER_FEE_NOT_ON_STREAM"] } });
      await r0.p.coordinator.settled();
      const kept = r0.p.journal.evidence().filter((record) => record.source === "STREAM_SETTLEMENT").map((record) => record.venueTradeId);
      const triggered = r0.p.coordinator.status().pendingTriggers;
      r0.u.world.cancel(trade?.venueOrderId as string);
      lagEveryRead(r0, collateral);
      const r = withRestart ? await restarted(r0) : r0;
      for (let round = 0; round < 4; round += 1) {
        expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
        r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
      }
      expect(r.oms.orders()[0]?.finalSize).toBeNull();
      expect(r.u.violations).toEqual([]);
      r.u.world.faults = {};
      expect(await reconcileRounds(r, 6)).toBe(true);
      expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
      expect(r.u.violations).toEqual([]);
      // The mechanism, asserted last: the settlement was kept as journaled evidence, and a run was due at once.
      expect(kept).toEqual([trade?.venueTradeId]);
      expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
    });
  }

  it("(P7-STREAM-REFUSED, no OMS bound) a fill routed while the coordinator has no OMS is kept as evidence and triggers a run; the OMS bound later, every read lagging: never resumed with the fill lost", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const collateral = r.u.world.collateral;
    const trade = r.u.world.match(r.u.world.receipts.at(-1) as string, "0.4");
    // A process whose OMS is not open yet (the composition binds it later); the stream is already live.
    const unbound = await boot(r.u, null, { openOms: false });
    unbound.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? "?"));
    await unbound.coordinator.settled();
    const kept = unbound.journal.evidence().filter((record) => record.source === "STREAM_FILL").map((record) => [record.venueTradeId, record.size]);
    const triggered = unbound.coordinator.status().pendingTriggers;
    r.u.world.cancel(trade?.venueOrderId as string);
    lagEveryRead(r, collateral);
    const p = await reopenOms(r.u, unbound);
    const again: Ready = { ...r, p, oms: p.oms as OrderManager };
    for (let round = 0; round < 4; round += 1) {
      expect((await again.p.coordinator.reconcile()).resumed).toBe(false);
      again.u.clock.t += again.u.policy.quiescenceHorizonMs + 1;
    }
    expect(again.u.violations).toEqual([]);
    again.u.world.faults = {};
    expect(await reconcileRounds(again, 6)).toBe(true);
    expect(again.oms.orders()[0]?.filledShares).toBe("0.4");
    expect(again.u.violations).toEqual([]);
    // The mechanism, asserted last: kept as journaled evidence, and a run due at once.
    expect(kept).toEqual([[trade?.venueTradeId, "0.4"]]);
    expect(triggered).toContain("POSITION_BALANCE_DISCREPANCY");
  });

  it("(P7-STREAM-REFUSED, control) the healthy store applies both fills: nothing is kept as evidence, and the lagging reads hold", async () => {
    const r = await ready();
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const salt = r.u.world.receipts.at(-1) as string;
    const collateral = r.u.world.collateral;
    const a = r.u.world.match(salt, "0.2");
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, a?.venueTradeId ?? "?"));
    await r.p.coordinator.settled();
    expect(r.p.journal.evidence().filter((record) => record.source === "STREAM_FILL")).toEqual([]);
    r.u.world.cancel(a?.venueOrderId as string);
    lagEveryRead(r, collateral);
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(r.u.violations).toEqual([]);
  });
});
