/**
 * The PnL fold: average-cost lots, realized recognition, and the refusals
 * that keep a projection from silently going wrong.
 *
 * WP-200 acceptance 2 applies here too — the fold rebuilds from zero through
 * the same step the incremental path uses, so the two are byte-equal — and
 * the mutation probe for this package lives at the bottom of the file.
 */

import { addDecimal } from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import { PnlConfigurationError } from "./refusals.js";
import { serializePnlState } from "./serialize.js";
import { applyPnlRecord, emptyPnlState, foldPnlRecords } from "./state.js";
import type { PnlState } from "./state.js";
import {
  ACCOUNT_OWNER,
  INSTANCE_OWNER,
  MARKET_A,
  NO_TOKEN,
  PUSD,
  USDC,
  YES_TOKEN,
  buy,
  fee,
  realization,
  ref,
  sell,
} from "./testing/samples.js";

function fold(records: readonly unknown[], owner = INSTANCE_OWNER): PnlState {
  const result = foldPnlRecords(owner, records);
  if (!result.ok) {
    throw new Error(`fold refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function codesOf(state: PnlState, record: unknown): readonly string[] {
  const result = applyPnlRecord(state, record);
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

describe("emptyPnlState", () => {
  it("throws on a value that is not a PnL owner", () => {
    expect(() => emptyPnlState({ scope: "NOBODY" } as never)).toThrow(PnlConfigurationError);
  });

  it("starts with nothing realized and nothing open", () => {
    const state = emptyPnlState(INSTANCE_OWNER);
    expect(state.recordCount).toBe(0);
    expect(state.lots.size).toBe(0);
    expect(state.realizedTrading.size).toBe(0);
  });
});

describe("average-cost lots", () => {
  it("accumulates basis across buys at different prices", () => {
    const state = fold([buy(1, "10", "0.4"), buy(2, "10", "0.6")]);
    expect(state.lots.get(YES_TOKEN)).toEqual({
      shares: "20",
      costBasis: "10",
      denominationAsset: PUSD,
      marketId: MARKET_A,
    });
  });

  it("realizes the difference between proceeds and average basis on a sell", () => {
    // 10 @ 0.4 then 10 @ 0.6 → average 0.5. Sell 10 @ 0.7 → realized 2.
    const state = fold([buy(1, "10", "0.4"), buy(2, "10", "0.6"), sell(3, "10", "0.7")]);
    expect(state.realizedTrading.get(PUSD)).toBe("2");
    expect(state.lots.get(YES_TOKEN)?.shares).toBe("10");
    expect(state.lots.get(YES_TOKEN)?.costBasis).toBe("5");
  });

  it("closes the lot exactly, leaving no dust basis behind", () => {
    // Basis 3 x 0.3333333 = 0.9999999; proceeds 3 x 0.5 = 1.5.
    const state = fold([buy(1, "3", "0.3333333"), sell(2, "3", "0.5")]);
    expect(state.lots.has(YES_TOKEN)).toBe(false);
    expect(state.realizedTrading.get(PUSD)).toBe("0.5000001");
  });

  it("conserves total basis across a partial removal that does not divide evenly", () => {
    // 3 shares with basis 1: removing 1 removes 1/3, which has no exact
    // decimal form. The REMAINING basis is derived by subtraction, so
    // removed + remaining is exactly the original.
    const opened = fold([buy(1, "3", "0.3333333333333333333333333333333333")]);
    const originalBasis = opened.lots.get(YES_TOKEN)?.costBasis ?? "0";
    const after = fold([buy(1, "3", "0.3333333333333333333333333333333333"), sell(2, "1", "1")]);
    const remaining = after.lots.get(YES_TOKEN)?.costBasis ?? "0";
    // realized = proceeds - removed, so removed = proceeds - realized = 1 - realized.
    const realized = after.realizedTrading.get(PUSD) ?? "0";
    const removed = addDecimal("1", `-${realized}`);
    expect(addDecimal(removed, remaining)).toBe(originalBasis);
  });

  it("keeps separate lots for separate tokens", () => {
    const state = fold([
      buy(1, "10", "0.4"),
      { ...buy(2, "5", "0.6"), tokenAssetId: NO_TOKEN },
    ]);
    expect(state.lots.get(YES_TOKEN)?.shares).toBe("10");
    expect(state.lots.get(NO_TOKEN)?.shares).toBe("5");
  });
});

describe("realized recognition and its refusals", () => {
  it("refuses a sell with no inventory (venue report §10.2)", () => {
    expect(codesOf(emptyPnlState(INSTANCE_OWNER), sell(1, "1", "0.5"))).toEqual(["PNL_OVERSELL"]);
  });

  it("refuses a sell larger than the position, naming both quantities", () => {
    const state = fold([buy(1, "5", "0.4")]);
    const result = applyPnlRecord(state, sell(2, "6", "0.5"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.details).toMatchObject({ sharesSold: "6", sharesHeld: "5" });
  });

  it("realizes a REDEEM at the determined payoff per share", () => {
    // Bought 10 @ 0.4 (basis 4); the market resolves YES, so 10 x $1 = 10.
    const state = fold([buy(1, "10", "0.4"), realization(2, "10", "1")]);
    expect(state.realizedTrading.get(PUSD)).toBe("6");
    expect(state.lots.has(YES_TOKEN)).toBe(false);
  });

  it("realizes a total loss when the payoff is zero", () => {
    const state = fold([buy(1, "10", "0.4"), realization(2, "10", "0")]);
    expect(state.realizedTrading.get(PUSD)).toBe("-4");
  });

  it("refuses to settle more shares than are held", () => {
    const state = fold([buy(1, "5", "0.4")]);
    expect(codesOf(state, realization(2, "6", "1"))).toEqual(["PNL_OVERSELL"]);
  });

  it("refuses a trade already marked FAILED: a failure is a reversal, not a recognition", () => {
    expect(
      codesOf(emptyPnlState(INSTANCE_OWNER), { ...buy(1, "1", "0.5"), settlementState: "FAILED" }),
    ).toEqual(["PNL_SETTLEMENT_FAILED_TRADE"]);
  });

  it("accepts a trade in any non-FAILED settlement state", () => {
    for (const settlementState of ["MATCHED", "MINED", "CONFIRMED", "RETRYING"]) {
      expect(
        applyPnlRecord(emptyPnlState(INSTANCE_OWNER), { ...buy(1, "1", "0.5"), settlementState }).ok,
      ).toBe(true);
    }
  });
});

describe("denominations never interchange (ADR-006 §7, C-2 unresolved)", () => {
  it("refuses a record whose denomination contradicts the lot's", () => {
    const state = fold([buy(1, "10", "0.4")]);
    const result = applyPnlRecord(state, { ...sell(2, "5", "0.5"), denominationAsset: USDC });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_DENOMINATION_CONFLICT");
    expect(result.refusals[0]?.details).toMatchObject({
      lotDenomination: PUSD,
      recordDenomination: USDC,
    });
  });

  it("keeps two denominations in separate buckets, never summed", () => {
    const state = fold([
      buy(1, "10", "0.4"),
      sell(2, "10", "0.5"),
      { ...fee(3, "0.07"), denominationAsset: USDC },
    ]);
    expect(state.realizedTrading.get(PUSD)).toBe("1");
    expect(state.feesPaid.get(USDC)).toBe("0.07");
    expect(state.feesPaid.get(PUSD)).toBeUndefined();
  });
});

describe("stream discipline", () => {
  it("refuses a record belonging to a different owner", () => {
    expect(codesOf(emptyPnlState(INSTANCE_OWNER), buy(1, "1", "0.5", ACCOUNT_OWNER))).toEqual([
      "PNL_OWNER_MISMATCH",
    ]);
  });

  it("refuses a duplicate ref: a record is folded exactly once", () => {
    const state = fold([buy(1, "10", "0.4")]);
    expect(codesOf(state, buy(1, "10", "0.4"))).toEqual(["PNL_DUPLICATE_REF"]);
  });

  it("refuses a non-canonical UUID ref, carrying the raw value (ADR-016 §2)", () => {
    const upper = ref(1).toUpperCase();
    const result = applyPnlRecord(emptyPnlState(INSTANCE_OWNER), {
      ...buy(1, "1", "0.5"),
      ref: upper,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_UUID_NOT_CANONICAL");
    expect(result.refusals[0]?.details).toEqual({ field: "ref", raw: upper });
  });

  it("refuses a numeric amount: no economic value passes through a JS number", () => {
    expect(
      codesOf(emptyPnlState(INSTANCE_OWNER), { ...buy(1, "1", "0.5"), shares: 1 }),
    ).toEqual(["PNL_INPUT_INVALID"]);
  });

  it("never mutates the state it folds into", () => {
    const state = fold([buy(1, "10", "0.4")]);
    const before = serializePnlState(state);
    applyPnlRecord(state, sell(2, "10", "0.9"));
    expect(serializePnlState(state)).toBe(before);
  });
});

describe("compensating reversals (ADR-006 §5.2)", () => {
  const reversal = (n: number, reversesRef: string): Record<string, unknown> => ({
    kind: "TRADE_REVERSAL",
    ref: ref(n),
    owner: INSTANCE_OWNER,
    reversesRef,
  });

  it("unwinds a buy exactly, leaving no lot behind", () => {
    const state = fold([buy(1, "10", "0.4"), reversal(2, ref(1))]);
    expect(state.lots.has(YES_TOKEN)).toBe(false);
  });

  it("unwinds a sell exactly, restoring shares, basis, and realized PnL", () => {
    const before = fold([buy(1, "10", "0.4")]);
    const after = fold([buy(1, "10", "0.4"), sell(2, "4", "0.9"), reversal(3, ref(2))]);
    expect(after.lots.get(YES_TOKEN)?.shares).toBe(before.lots.get(YES_TOKEN)?.shares);
    expect(after.lots.get(YES_TOKEN)?.costBasis).toBe(before.lots.get(YES_TOKEN)?.costBasis);
    expect(after.realizedTrading.get(PUSD)).toBe("0");
  });

  it("refuses a reversal of a trade this stream never folded", () => {
    expect(codesOf(emptyPnlState(INSTANCE_OWNER), reversal(2, ref(1)))).toEqual([
      "PNL_REVERSAL_UNKNOWN",
    ]);
  });

  it("refuses a second reversal of the same trade", () => {
    const state = fold([buy(1, "10", "0.4"), reversal(2, ref(1))]);
    expect(codesOf(state, reversal(3, ref(1)))).toEqual(["PNL_ALREADY_REVERSED"]);
  });

  it("refuses an unwind the position can no longer absorb", () => {
    // Bought 10, sold 8: unwinding the buy would leave a negative position.
    const state = fold([buy(1, "10", "0.4"), sell(2, "8", "0.5")]);
    expect(codesOf(state, reversal(3, ref(1)))).toEqual([
      "PNL_REVERSAL_INSUFFICIENT_POSITION",
    ]);
  });
});

describe("fee and reward schedule versioning (§9.16)", () => {
  it("keeps fees by schedule version, and by denomination", () => {
    const state = fold([
      fee(1, "0.05", "fees-2026-09-01"),
      fee(2, "0.03", "fees-2026-09-15"),
      fee(3, "0.02", "fees-2026-09-01"),
    ]);
    expect(state.feesPaid.get(PUSD)).toBe("0.1");
    expect(state.feesBySchedule.get(JSON.stringify([PUSD, "fees-2026-09-01"]))).toBe("0.07");
    expect(state.feesBySchedule.get(JSON.stringify([PUSD, "fees-2026-09-15"]))).toBe("0.03");
  });

  it("reports a version-less fee under the empty key rather than inventing one", () => {
    const state = fold([fee(1, "0.05")]);
    expect(state.feesBySchedule.get(JSON.stringify([PUSD, ""]))).toBe("0.05");
  });
});

describe("acceptance 2 for the PnL fold: rebuild equals incremental", () => {
  const HISTORY: readonly unknown[] = [
    buy(1, "10", "0.4"),
    buy(2, "5", "0.6"),
    sell(3, "7", "0.55"),
    fee(4, "0.03", "fees-2026-09-01"),
    realization(5, "3", "1"),
  ];

  it("is byte-equal between a step-by-step fold and a from-zero rebuild", () => {
    let incremental = emptyPnlState(INSTANCE_OWNER);
    for (const record of HISTORY) {
      const result = applyPnlRecord(incremental, record);
      if (!result.ok) {
        throw new Error(`refused: ${JSON.stringify(result.refusals)}`);
      }
      incremental = result.value;
    }
    expect(serializePnlState(fold(HISTORY))).toBe(serializePnlState(incremental));
  });

  it("diverges detectably when one historical record is mutated", () => {
    const original = serializePnlState(fold(HISTORY));
    const mutated = serializePnlState(
      fold([HISTORY[0], buy(2, "5", "0.61"), ...HISTORY.slice(2)]),
    );
    expect(mutated).not.toBe(original);
  });

  it("diverges when a historical record is dropped", () => {
    const original = serializePnlState(fold(HISTORY));
    const shortened = serializePnlState(fold([HISTORY[0], ...HISTORY.slice(2)]));
    expect(shortened).not.toBe(original);
  });

  it("refuses the rebuild outright when the drop breaks an invariant", () => {
    // Dropping BOTH buys leaves no inventory for the sell: the fold refuses
    // and names the offending index rather than inventing a short position.
    const result = foldPnlRecords(INSTANCE_OWNER, HISTORY.slice(2));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.details).toMatchObject({ index: 0 });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("PNL_OVERSELL");
  });
});
