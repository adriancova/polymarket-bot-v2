/**
 * WP-200 acceptance 3: "Reward estimate is not realized PnL."
 *
 * The handoff states the rule verbatim (§9.16): "Reward estimates are never
 * booked as realized." This suite is the probe the work package asks for:
 *
 * - an estimate flows to its OWN bucket;
 * - realized PnL is byte-for-byte UNCHANGED by folding estimates — asserted
 *   over the whole realized projection via `serializeRealizedPnl`, not over a
 *   hand-picked field list;
 * - only a settlement-grade event (an OBSERVED `REWARD_PAYOUT`, which must
 *   name the ledger transaction that booked it) realizes a reward;
 * - the schema makes "an estimate carrying settlement evidence"
 *   UNREPRESENTABLE, so the rule cannot be defeated by a caller.
 */

import { describe, expect, it } from "vitest";

import { PnlRewardEstimateRecordSchema, PnlRewardPayoutRecordSchema } from "./records.js";
import { serializePnlState, serializeRealizedPnl } from "./serialize.js";
import { computePnlSnapshot } from "./snapshot.js";
import type { PnlSnapshot } from "./snapshot.js";
import { applyPnlRecord, emptyPnlState, foldPnlRecords } from "./state.js";
import type { PnlState } from "./state.js";
import {
  INSTANCE_OWNER,
  INSTANCE_STREAM,
  PUSD,
  TIMESTAMP,
  buy,
  evidenceOf,
  fee,
  ledgerTx,
  ref,
  rewardEstimate,
  rewardPayout,
  rewardPayoutEvidence,
  sell,
} from "./testing/samples.js";

/**
 * The bookings the payouts in this suite are proven against (ADR-006 §6). A
 * payout with no matching booking does not realize — that boundary has its own
 * suite in `reward-evidence.test.ts`; here it is simply supplied, so these
 * tests stay about the estimate-versus-realized rule.
 */
const EVIDENCE = evidenceOf([
  rewardPayoutEvidence(2, "3"),
  rewardPayoutEvidence(4, "5"),
]);

function fold(records: readonly unknown[]): PnlState {
  const result = foldPnlRecords(INSTANCE_STREAM, records, EVIDENCE);
  if (!result.ok) {
    throw new Error(`fold refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function snapshotOf(state: PnlState): PnlSnapshot {
  const result = computePnlSnapshot(state, { asOf: TIMESTAMP, marks: {} });
  if (!result.ok) {
    throw new Error(`snapshot refused: ${JSON.stringify(result.refusals)}`);
  }
  const row = result.value.find((entry) => entry.denominationAsset === PUSD);
  if (row === undefined) {
    throw new Error("no pUSD snapshot row");
  }
  return row;
}

/** Buy 10 @ 0.4, sell 10 @ 0.55, pay a 0.07 fee: realized trading PnL 1.5. */
const TRADING_HISTORY: readonly unknown[] = [
  buy(1, "10", "0.4"),
  sell(2, "10", "0.55"),
  fee(3, "0.07", "fees-2026-09-01"),
];

describe("an estimate flows to its own bucket", () => {
  it("accumulates into rewardEstimates, per denomination and per program", () => {
    const state = fold([rewardEstimate(1, "2.5"), rewardEstimate(2, "1.25")]);
    expect(state.rewardEstimates.get(PUSD)).toBe("3.75");
    expect(state.estimatesByProgram.get(JSON.stringify([PUSD, "LIQUIDITY_REWARD"]))).toBe("3.75");
  });

  it("does not touch realizedRewards", () => {
    const state = fold([rewardEstimate(1, "2.5")]);
    expect(state.realizedRewards.size).toBe(0);
  });
});

describe("realized PnL is unchanged by estimates", () => {
  it("is byte-for-byte identical before and after folding an estimate", () => {
    const withoutEstimate = fold(TRADING_HISTORY);
    const withEstimate = fold([...TRADING_HISTORY, rewardEstimate(4, "9999.99")]);
    expect(serializeRealizedPnl(withEstimate)).toBe(serializeRealizedPnl(withoutEstimate));
  });

  it("stays identical no matter how many estimates arrive", () => {
    const base = serializeRealizedPnl(fold(TRADING_HISTORY));
    const many = fold([
      ...TRADING_HISTORY,
      rewardEstimate(4, "1"),
      rewardEstimate(5, "2"),
      rewardEstimate(6, "3"),
      rewardEstimate(7, "4"),
    ]);
    expect(serializeRealizedPnl(many)).toBe(base);
  });

  it("leaves the WHOLE state byte-identical except the estimate buckets", () => {
    // A stricter statement than the previous two: the only difference between
    // the two full serializations is bookkeeping (recordCount, refs) plus the
    // two estimate buckets. Nothing else in the state may move.
    const withoutEstimate = fold(TRADING_HISTORY);
    const withEstimate = fold([...TRADING_HISTORY, rewardEstimate(4, "5")]);
    expect(serializePnlState(withEstimate)).not.toBe(serializePnlState(withoutEstimate));
    expect(serializeRealizedPnl(withEstimate)).toBe(serializeRealizedPnl(withoutEstimate));
    expect(withEstimate.realizedTrading).toEqual(withoutEstimate.realizedTrading);
    expect(withEstimate.feesPaid).toEqual(withoutEstimate.feesPaid);
    expect(withEstimate.realizedRewards).toEqual(withoutEstimate.realizedRewards);
    expect(withEstimate.lots).toEqual(withoutEstimate.lots);
  });

  it("does not change an OPEN position's lots or basis", () => {
    const open = fold([buy(1, "10", "0.4")]);
    const openWithEstimate = fold([buy(1, "10", "0.4"), rewardEstimate(2, "3")]);
    expect(openWithEstimate.lots.get(
      "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    )).toEqual(
      open.lots.get(
        "71321045679252212594626385532706912750332728571942532289631379312455583992563",
      ),
    );
  });
});

describe("the snapshot keeps the estimate out of every PnL figure", () => {
  const withEstimate = snapshotOf(fold([...TRADING_HISTORY, rewardEstimate(4, "5")]));
  const withoutEstimate = snapshotOf(fold(TRADING_HISTORY));

  it("reports the estimate in its own measure only", () => {
    expect(withEstimate.rewardEstimateTotal).toBe("5");
    expect(withoutEstimate.rewardEstimateTotal).toBe("0");
  });

  it("does not move realized PnL", () => {
    expect(withEstimate.realizedPnl).toBe(withoutEstimate.realizedPnl);
    expect(withEstimate.realizedPnl).toBe("1.5");
  });

  it("does not move gross trading, core net, or all-in PnL", () => {
    expect(withEstimate.grossTradingPnl).toBe(withoutEstimate.grossTradingPnl);
    expect(withEstimate.coreNetPnl).toBe(withoutEstimate.coreNetPnl);
    expect(withEstimate.allInPnl).toBe(withoutEstimate.allInPnl);
    expect(withEstimate.allInPnl).toBe("1.43");
  });

  it("does not move realized rewards", () => {
    expect(withEstimate.realizedRewards).toBe("0");
  });
});

describe("only a settlement-grade event realizes a reward", () => {
  it("an OBSERVED payout does move realizedRewards and all-in PnL", () => {
    const realized = fold([...TRADING_HISTORY, rewardPayout(4, "5")]);
    expect(realized.realizedRewards.get(PUSD)).toBe("5");
    const snapshot = snapshotOf(realized);
    expect(snapshot.realizedRewards).toBe("5");
    expect(snapshot.allInPnl).toBe("6.43");
  });

  it("keeps core net PnL free of rewards, realized or estimated (§6 invariant 14)", () => {
    const base = snapshotOf(fold(TRADING_HISTORY)).coreNetPnl;
    expect(snapshotOf(fold([...TRADING_HISTORY, rewardPayout(4, "5")])).coreNetPnl).toBe(base);
    expect(snapshotOf(fold([...TRADING_HISTORY, rewardEstimate(5, "5")])).coreNetPnl).toBe(
      base,
    );
  });

  it("an estimate and a payout of the same amount are NOT interchangeable", () => {
    const estimated = fold([...TRADING_HISTORY, rewardEstimate(4, "5")]);
    const paid = fold([...TRADING_HISTORY, rewardPayout(4, "5")]);
    expect(serializeRealizedPnl(estimated)).not.toBe(serializeRealizedPnl(paid));
    expect(snapshotOf(estimated).allInPnl).not.toBe(snapshotOf(paid).allInPnl);
  });

  it("reports estimates and realized rewards under the same program separately", () => {
    const both = fold([rewardEstimate(1, "4"), rewardPayout(2, "3")]);
    const snapshot = snapshotOf(both);
    expect(snapshot.estimatesByProgram).toEqual({
      [JSON.stringify([PUSD, "LIQUIDITY_REWARD"])]: "4",
    });
    expect(snapshot.rewardsByProgram).toEqual({
      [JSON.stringify([PUSD, "LIQUIDITY_REWARD"])]: "3",
    });
  });
});

describe("the rule is enforced by the schema, not only by the handler", () => {
  it("refuses an estimate that tries to carry settlement evidence", () => {
    const smuggled = { ...rewardEstimate(1, "5"), ledgerTransactionId: ledgerTx(1) };
    expect(PnlRewardEstimateRecordSchema.safeParse(smuggled).success).toBe(false);

    const result = applyPnlRecord(emptyPnlState(INSTANCE_STREAM), smuggled);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_INPUT_INVALID");
  });

  it("refuses a payout that omits its settlement evidence", () => {
    const unevidenced = {
      kind: "REWARD_PAYOUT",
      ref: ref(1),
      owner: INSTANCE_OWNER,
      programType: "LIQUIDITY_REWARD",
      amount: "5",
      denominationAsset: PUSD,
    };
    expect(PnlRewardPayoutRecordSchema.safeParse(unevidenced).success).toBe(false);
    expect(applyPnlRecord(emptyPnlState(INSTANCE_STREAM), unevidenced).ok).toBe(false);
  });

  it("requires an estimate to state its methodology and period", () => {
    const noMethodology = { ...rewardEstimate(1, "5") };
    delete noMethodology["methodology"];
    expect(PnlRewardEstimateRecordSchema.safeParse(noMethodology).success).toBe(false);

    const noPeriod = { ...rewardEstimate(1, "5") };
    delete noPeriod["periodEnd"];
    expect(PnlRewardEstimateRecordSchema.safeParse(noPeriod).success).toBe(false);
  });

  it("allows a zero estimate but not a zero realized payout", () => {
    expect(PnlRewardEstimateRecordSchema.safeParse(rewardEstimate(1, "0")).success).toBe(true);
    expect(PnlRewardPayoutRecordSchema.safeParse(rewardPayout(1, "0")).success).toBe(false);
  });
});
