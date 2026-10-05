/**
 * `ROLLOVER-1` r1 (R1-05): the realized PnL the health surface reads is kept
 * per STREAM — an instance and the market its snapshot is scoped to — and an
 * instance's value is the sum of its streams. A series-bound instance has one
 * stream per window (`loop.ts` keys its PnL streams by registration), each
 * cumulative for its own window only; replacing by instance showed the
 * latest window's value alone (snapshots of 5 and 7 read 7, not 12).
 */

import type { PnlSnapshot } from "@polymarket-bot/pnl";
import { RealizedPnlBook } from "@polymarket-bot/trading-core";
import { MemoryTraderStore } from "@polymarket-bot/trading-core/testing";
import { describe, expect, it } from "vitest";

import { observeRealizedPnl } from "./pnl-observation.js";

const INSTANCE = "c18f4a7e-1111-7abc-8def-0123456789ab";
const W1 = "019db1a2-1c20-7000-8000-000000000001";
const W2 = "019db1a2-2a30-7000-8000-000000000002";

function snapshot(marketId: string | null, realizedPnl: string, asOf: string): PnlSnapshot {
  return {
    scope: "VIRTUAL_STRATEGY",
    environment: "PAPER",
    accountRef: "paper-account",
    instanceId: INSTANCE,
    runId: "018f4a7e-1212-7abc-8def-0123456789ab",
    marketId,
    denominationAsset: "pUSD",
    asOf,
    grossTradingPnl: realizedPnl,
    coreNetPnl: realizedPnl,
    allInPnl: realizedPnl,
    realizedPnl,
    unrealizedPnlMidpoint: "0",
    unrealizedPnlModel: null,
    unrealizedPnlLiquidation: null,
    worstCaseResolutionPnl: realizedPnl,
    feesPaid: "0",
    rewardEstimateTotal: "0",
    realizedRewards: "0",
    capitalCommitted: "0",
    feesByScheduleVersion: {},
    rewardsByProgram: {},
    estimatesByProgram: {},
  };
}

describe("the realized-PnL book sums an instance's window streams (R1-05)", () => {
  it("two windows' accepted snapshots of 5 and 7 read 12 for the instance and the account", async () => {
    const book = new RealizedPnlBook();
    const store = observeRealizedPnl(new MemoryTraderStore(), book);
    expect((await store.writePnlSnapshot(snapshot(W1, "5", "2026-10-04T22:20:00.000Z"))).ok).toBe(true);
    expect((await store.writePnlSnapshot(snapshot(W2, "7", "2026-10-04T22:35:00.000Z"))).ok).toBe(true);
    expect(book.view()).toEqual({ byInstance: { [INSTANCE]: "12" }, account: "12" });
  });

  it("a later snapshot of the SAME window replaces that window's contribution only", async () => {
    const book = new RealizedPnlBook();
    const store = observeRealizedPnl(new MemoryTraderStore(), book);
    await store.writePnlSnapshot(snapshot(W1, "5", "2026-10-04T22:20:00.000Z"));
    await store.writePnlSnapshot(snapshot(W2, "7", "2026-10-04T22:35:00.000Z"));
    await store.writePnlSnapshot(snapshot(W1, "-1.25", "2026-10-04T22:21:00.000Z"));
    expect(book.view()).toEqual({ byInstance: { [INSTANCE]: "5.75" }, account: "5.75" });
    // The same through `replacePnlSnapshot` (SNAP-1 r1): the instant already written.
    expect((await store.replacePnlSnapshot(snapshot(W2, "0.5", "2026-10-04T22:35:00.000Z"))).ok).toBe(true);
    expect(book.view()).toEqual({ byInstance: { [INSTANCE]: "-0.75" }, account: "-0.75" });
  });

  it("an instance's one stream reads verbatim, as before; a stream with no market is its own", () => {
    const book = new RealizedPnlBook();
    book.record({ instanceId: INSTANCE, marketId: W1, realizedPnl: "0.1000000000000000055511151231257827" });
    expect(book.view().byInstance[INSTANCE]).toBe("0.1000000000000000055511151231257827");
    book.record({ instanceId: INSTANCE, realizedPnl: "1" });
    expect(book.view()).toEqual({ byInstance: { [INSTANCE]: "1.1000000000000000055511151231257827" }, account: "1.1000000000000000055511151231257827" });
  });
});
