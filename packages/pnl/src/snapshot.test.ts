/**
 * The §9.16 reporting snapshot.
 *
 * Two properties matter beyond arithmetic:
 *
 * - REALIZED and UNREALIZED cannot mix. Unrealized value is computed here,
 *   from open lots and caller-supplied marks; it never enters the folded
 *   state, so a bug cannot leak a mark into realized PnL.
 * - A missing mark is a typed refusal, not a guess. "Unrealized PnL at
 *   midpoint" is a required §9.16 measure; a snapshot that quietly valued an
 *   unmarked position at cost would report a confident wrong number.
 */

import { describe, expect, it } from "vitest";

import { computePnlSnapshot } from "./snapshot.js";
import type { PnlSnapshot } from "./snapshot.js";
import { foldPnlRecords } from "./state.js";
import type { PnlState } from "./state.js";
import {
  INSTANCE_OWNER,
  MARKET_A,
  NO_TOKEN,
  PUSD,
  TIMESTAMP,
  USDC,
  YES_TOKEN,
  buy,
  fee,
  rewardEstimate,
  rewardPayout,
  sell,
} from "./testing/samples.js";

function fold(records: readonly unknown[]): PnlState {
  const result = foldPnlRecords(INSTANCE_OWNER, records);
  if (!result.ok) {
    throw new Error(`fold refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function snapshots(state: PnlState, input: unknown): readonly PnlSnapshot[] {
  const result = computePnlSnapshot(state, input);
  if (!result.ok) {
    throw new Error(`snapshot refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function only(state: PnlState, input: unknown): PnlSnapshot {
  const rows = snapshots(state, input);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("the §9.16 measures", () => {
  // Bought 10 @ 0.4 (basis 4), sold 4 @ 0.6 (proceeds 2.4, basis out 1.6,
  // realized 0.8), paid a 0.05 fee. 6 shares remain with basis 2.4.
  const state = fold([buy(1, "10", "0.4"), sell(2, "4", "0.6"), fee(3, "0.05", "fees-v1")]);
  const row = only(state, {
    asOf: TIMESTAMP,
    marks: { [YES_TOKEN]: { midpoint: "0.5", model: "0.55", liquidation: "0.45" } },
  });

  it("reports realized PnL from closed quantity only", () => {
    expect(row.realizedPnl).toBe("0.8");
  });

  it("reports unrealized PnL at midpoint from open lots and the mark", () => {
    // 6 x 0.5 = 3, less basis 2.4.
    expect(row.unrealizedPnlMidpoint).toBe("0.6");
  });

  it("reports unrealized PnL at model and liquidation value separately", () => {
    expect(row.unrealizedPnlModel).toBe("0.9");
    expect(row.unrealizedPnlLiquidation).toBe("0.3");
  });

  it("reports gross trading PnL as realized plus unrealized at midpoint", () => {
    expect(row.grossTradingPnl).toBe("1.4");
  });

  it("reports core net PnL excluding rewards entirely", () => {
    expect(row.coreNetPnl).toBe("1.35");
  });

  it("reports all-in PnL including realized rewards only", () => {
    expect(row.allInPnl).toBe("1.35");
  });

  it("reports fees paid, and by schedule version", () => {
    expect(row.feesPaid).toBe("0.05");
    expect(row.feesByScheduleVersion).toEqual({
      [JSON.stringify([PUSD, "fees-v1"])]: "0.05",
    });
  });

  it("reports worst-case resolution PnL as every open token resolving to zero", () => {
    // Realized 0.8 less the whole open basis of 2.4.
    expect(row.worstCaseResolutionPnl).toBe("-1.6");
  });

  it("reports capital committed as open basis plus caller-stated reservations", () => {
    expect(row.capitalCommitted).toBe("2.4");
    const withReservation = only(state, {
      asOf: TIMESTAMP,
      marks: { [YES_TOKEN]: { midpoint: "0.5" } },
      reservedCapital: { [PUSD]: "10" },
    });
    expect(withReservation.capitalCommitted).toBe("12.4");
  });

  it("carries the owner and the caller-supplied asOf", () => {
    expect(row.owner).toEqual(INSTANCE_OWNER);
    expect(row.asOf).toBe(TIMESTAMP);
  });
});

describe("realized and unrealized cannot mix", () => {
  it("changes only the unrealized measures when the mark moves", () => {
    const state = fold([buy(1, "10", "0.4"), sell(2, "4", "0.6")]);
    const low = only(state, { asOf: TIMESTAMP, marks: { [YES_TOKEN]: { midpoint: "0.1" } } });
    const high = only(state, { asOf: TIMESTAMP, marks: { [YES_TOKEN]: { midpoint: "0.9" } } });

    expect(low.realizedPnl).toBe(high.realizedPnl);
    expect(low.feesPaid).toBe(high.feesPaid);
    expect(low.realizedRewards).toBe(high.realizedRewards);
    expect(low.unrealizedPnlMidpoint).not.toBe(high.unrealizedPnlMidpoint);
  });

  it("reports zero unrealized when nothing is open, whatever the marks say", () => {
    const flat = fold([buy(1, "10", "0.4"), sell(2, "10", "0.6")]);
    const row = only(flat, {
      asOf: TIMESTAMP,
      marks: { [YES_TOKEN]: { midpoint: "0.99" } },
    });
    expect(row.unrealizedPnlMidpoint).toBe("0");
    expect(row.realizedPnl).toBe("2");
  });
});

describe("a missing mark is refused, never guessed", () => {
  it("refuses when an open position has no midpoint mark", () => {
    const state = fold([buy(1, "10", "0.4")]);
    const result = computePnlSnapshot(state, { asOf: TIMESTAMP, marks: {} });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_MARK_MISSING");
    expect(result.refusals[0]?.details).toMatchObject({ tokenAssetId: YES_TOKEN, shares: "10" });
  });

  it("reports model value as null when any open lot lacks a model mark", () => {
    const state = fold([
      buy(1, "10", "0.4"),
      { ...buy(2, "5", "0.6"), tokenAssetId: NO_TOKEN },
    ]);
    const row = only(state, {
      asOf: TIMESTAMP,
      marks: {
        [YES_TOKEN]: { midpoint: "0.5", model: "0.55" },
        [NO_TOKEN]: { midpoint: "0.5" },
      },
    });
    expect(row.unrealizedPnlMidpoint).not.toBeNull();
    expect(row.unrealizedPnlModel).toBeNull();
  });

  it("reports model value when EVERY open lot has one", () => {
    const state = fold([
      buy(1, "10", "0.4"),
      { ...buy(2, "5", "0.6"), tokenAssetId: NO_TOKEN },
    ]);
    const row = only(state, {
      asOf: TIMESTAMP,
      marks: {
        [YES_TOKEN]: { midpoint: "0.5", model: "0.55" },
        [NO_TOKEN]: { midpoint: "0.5", model: "0.5" },
      },
    });
    // (10 x 0.55 - 4) + (5 x 0.5 - 3) = 1.5 + (-0.5) = 1.
    expect(row.unrealizedPnlModel).toBe("1");
  });

  it("refuses a mark outside the unit interval", () => {
    const state = fold([buy(1, "10", "0.4")]);
    const result = computePnlSnapshot(state, {
      asOf: TIMESTAMP,
      marks: { [YES_TOKEN]: { midpoint: "1.2" } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_INPUT_INVALID");
  });

  it("refuses a numeric mark", () => {
    const state = fold([buy(1, "10", "0.4")]);
    expect(
      computePnlSnapshot(state, {
        asOf: TIMESTAMP,
        marks: { [YES_TOKEN]: { midpoint: 0.5 } },
      }).ok,
    ).toBe(false);
  });
});

describe("denominations are reported separately, never summed", () => {
  it("emits one row per denomination the state touched", () => {
    const state = fold([
      buy(1, "10", "0.4"),
      sell(2, "10", "0.6"),
      { ...fee(3, "0.07"), denominationAsset: USDC },
    ]);
    const rows = snapshots(state, { asOf: TIMESTAMP, marks: {} });
    // Rows are sorted by asset id for determinism; "USDC" sorts before
    // "pUSD" because uppercase precedes lowercase in code-unit order.
    expect(rows.map((row) => row.denominationAsset)).toEqual([USDC, PUSD]);

    const pusd = rows.find((row) => row.denominationAsset === PUSD)!;
    const usdc = rows.find((row) => row.denominationAsset === USDC)!;
    expect(pusd.realizedPnl).toBe("2");
    expect(pusd.feesPaid).toBe("0");
    expect(usdc.realizedPnl).toBe("0");
    expect(usdc.feesPaid).toBe("0.07");
    // The two are never combined into one "total".
    expect(usdc.coreNetPnl).toBe("-0.07");
  });

  it("scopes the per-program breakdowns to the row's own denomination", () => {
    const state = fold([
      rewardPayout(1, "3"),
      { ...rewardEstimate(2, "9"), denominationAsset: USDC },
    ]);
    const rows = snapshots(state, { asOf: TIMESTAMP, marks: {} });
    const pusd = rows.find((row) => row.denominationAsset === PUSD)!;
    const usdc = rows.find((row) => row.denominationAsset === USDC)!;
    expect(pusd.rewardsByProgram).toEqual({
      [JSON.stringify([PUSD, "LIQUIDITY_REWARD"])]: "3",
    });
    expect(pusd.estimatesByProgram).toEqual({});
    expect(usdc.estimatesByProgram).toEqual({
      [JSON.stringify([USDC, "LIQUIDITY_REWARD"])]: "9",
    });
    expect(usdc.rewardsByProgram).toEqual({});
  });
});

describe("edge cases", () => {
  it("returns no rows for a state that has touched nothing", () => {
    expect(snapshots(fold([]), { asOf: TIMESTAMP, marks: {} })).toEqual([]);
  });

  it("refuses a snapshot input with no asOf", () => {
    expect(computePnlSnapshot(fold([]), { marks: {} }).ok).toBe(false);
  });

  it("ignores marks for tokens that are not open", () => {
    const row = only(fold([buy(1, "10", "0.4"), sell(2, "10", "0.6")]), {
      asOf: TIMESTAMP,
      marks: { [NO_TOKEN]: { midpoint: "0.5" }, [YES_TOKEN]: { midpoint: "0.5" } },
    });
    expect(row.unrealizedPnlMidpoint).toBe("0");
  });

  it("keeps the market on an open lot for downstream attribution", () => {
    const state = fold([buy(1, "10", "0.4")]);
    expect(state.lots.get(YES_TOKEN)?.marketId).toBe(MARKET_A);
  });
});
