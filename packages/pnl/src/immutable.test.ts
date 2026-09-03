/**
 * Runtime immutability of a folded PnL state (review round 1, LOW-2).
 *
 * `Object.freeze` does not reach a `Map`'s internal slots, so a frozen state
 * still accepted `realizedTrading.set(...)` and `refs.add(...)` from any
 * JavaScript consumer — `readonly` in the type system binds a TypeScript
 * caller and nobody else. These are the money buckets; the fold is the only
 * thing allowed to write them.
 */

import { describe, expect, it } from "vitest";

import { serializePnlState, serializeRealizedPnl } from "./serialize.js";
import { computePnlSnapshot } from "./snapshot.js";
import { applyPnlRecord, emptyPnlState, foldPnlRecords } from "./state.js";
import type { PnlState } from "./state.js";
import {
  INSTANCE_OWNER,
  INSTANCE_STREAM,
  PUSD,
  TIMESTAMP,
  YES_TOKEN,
  buy,
  fee,
  ref,
  sell,
} from "./testing/samples.js";

function folded(): PnlState {
  const result = foldPnlRecords(INSTANCE_STREAM, [
    buy(1, "10", "0.4"),
    sell(2, "4", "0.6"),
    fee(3, "0.05", "fees-v1"),
  ]);
  if (!result.ok) {
    throw new Error(`fold refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

describe("a folded state cannot be edited by a JavaScript consumer", () => {
  it("refuses to invent realized PnL, and the state does not move", () => {
    const state = folded();
    const before = serializeRealizedPnl(state);
    expect(() => (state.realizedTrading as Map<string, string>).set(PUSD, "1000000")).toThrow(
      TypeError,
    );
    expect(state.realizedTrading.get(PUSD)).toBe("0.8");
    expect(serializeRealizedPnl(state)).toBe(before);
  });

  it("refuses to invent an open lot, a fee, or a realized reward", () => {
    const state = folded();
    expect(() => (state.lots as Map<string, unknown>).set(YES_TOKEN, { shares: "999" })).toThrow(
      TypeError,
    );
    expect(() => (state.feesPaid as Map<string, string>).set(PUSD, "0")).toThrow(TypeError);
    expect(() => (state.realizedRewards as Map<string, string>).set(PUSD, "9999")).toThrow(
      TypeError,
    );
    expect(state.lots.get(YES_TOKEN)?.shares).toBe("6");
    expect(state.feesPaid.get(PUSD)).toBe("0.05");
    expect(state.realizedRewards.size).toBe(0);
  });

  it("refuses to erase a lot or clear a bucket", () => {
    const state = folded();
    expect(() => (state.lots as Map<string, unknown>).delete(YES_TOKEN)).toThrow(TypeError);
    expect(() => (state.realizedTrading as Map<string, string>).clear()).toThrow(TypeError);
    expect(state.lots.has(YES_TOKEN)).toBe(true);
    expect(state.realizedTrading.size).toBe(1);
  });

  it("refuses to forge a folded ref or a reversal marker", () => {
    const state = folded();
    expect(() => (state.refs as Set<string>).add("forged")).toThrow(TypeError);
    expect(() => (state.reversedRefs as Set<string>).add("forged")).toThrow(TypeError);
    expect(state.refs.has("forged")).toBe(false);
  });

  it("guards an empty state too, before anything has been folded", () => {
    const empty = emptyPnlState(INSTANCE_STREAM);
    expect(() => (empty.realizedRewards as Map<string, string>).set(PUSD, "1")).toThrow(TypeError);
    expect(() => (empty.refs as Set<string>).add("x")).toThrow(TypeError);
  });

  it("names the reason, so the failure is diagnosable", () => {
    expect(() => (folded().feesPaid as Map<string, string>).set(PUSD, "1")).toThrow(
      /immutable/u,
    );
  });
});

/**
 * Review round 2, HIGH-4: round 1 sealed the CONTAINERS and left their VALUES
 * writable. `state.lots.get(token).costBasis = "999"` succeeded by ordinary
 * property assignment, and the very next snapshot reported
 * `capitalCommitted = 999` and `unrealizedPnlMidpoint = −994` from a lot that
 * cost 4 — no throw, no divergence, just a wrong number in a monetary report.
 * These tests assert the throw AND the downstream figures.
 */
describe("a folded state's VALUES cannot be edited either", () => {
  function bought(): PnlState {
    const result = foldPnlRecords(INSTANCE_STREAM, [buy(1, "10", "0.4")]);
    if (!result.ok) {
      throw new Error(`fold refused: ${JSON.stringify(result.refusals)}`);
    }
    return result.value;
  }

  const MARKS = { asOf: TIMESTAMP, marks: { [YES_TOKEN]: { midpoint: "0.5" } } };

  it("refuses to rewrite an open lot's cost basis or share count", () => {
    const state = bought();
    const lot = state.lots.get(YES_TOKEN);
    expect(lot?.costBasis).toBe("4");
    expect(() => {
      (lot as unknown as { costBasis: string }).costBasis = "999";
    }).toThrow(TypeError);
    expect(() => {
      (lot as unknown as { shares: string }).shares = "999";
    }).toThrow(TypeError);
    expect(() => {
      (lot as unknown as { denominationAsset: string }).denominationAsset = "USDC";
    }).toThrow(TypeError);
    expect(state.lots.get(YES_TOKEN)).toMatchObject({ shares: "10", costBasis: "4" });
  });

  it("keeps the snapshot reporting the basis the trades actually paid", () => {
    // THE REPORTED FIGURES, not just the throw: 10 shares marked at 0.5 are
    // worth 5 against a basis of 4, so the unrealized midpoint is +1 and the
    // committed capital is 4. With the mutation it was −994 and 999.
    const state = bought();
    const lot = state.lots.get(YES_TOKEN);
    expect(() => {
      (lot as unknown as { costBasis: string }).costBasis = "999";
    }).toThrow(TypeError);
    const snapshot = computePnlSnapshot(state, MARKS);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      return;
    }
    expect(snapshot.value[0]).toMatchObject({
      capitalCommitted: "4",
      unrealizedPnlMidpoint: "1",
      worstCaseResolutionPnl: "-4",
    });
  });

  it("refuses to rewrite a trade-log effect, so a reversal unwinds what was booked", () => {
    // The trade log is what a reversal replays. Editing an effect's `shares`
    // from 10 to 4 made a "full" reversal leave 6 shares behind with no basis:
    // a reversal that does not reverse, and no error anywhere.
    const state = bought();
    const effect = state.tradeLog.get(ref(1));
    expect(effect?.shares).toBe("10");
    expect(() => {
      (effect as unknown as { shares: string }).shares = "4";
    }).toThrow(TypeError);
    expect(() => {
      (effect as unknown as { basisDelta: string }).basisDelta = "999";
    }).toThrow(TypeError);

    const reversed = applyPnlRecord(state, {
      kind: "TRADE_REVERSAL",
      ref: ref(2),
      owner: INSTANCE_OWNER,
      reversesRef: ref(1),
    });
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) {
      return;
    }
    // The whole buy is unwound: no lot, no basis, nothing left behind.
    expect(reversed.value.lots.has(YES_TOKEN)).toBe(false);
  });

  it("refuses to rewrite the stream identity a snapshot row is keyed by", () => {
    const state = bought();
    expect(() => {
      (state.identity as unknown as { environment: string }).environment = "LIVE";
    }).toThrow(TypeError);
    expect(() => {
      (state.owner as unknown as { accountRef: string }).accountRef = "someone-else";
    }).toThrow(TypeError);
    expect(state.identity.environment).toBe("PAPER");
  });

  it("refuses to rewrite the consumed-evidence record that stops a double payout", () => {
    const state = bought();
    expect(() => {
      (state as unknown as { consumedRewardEvidence: unknown }).consumedRewardEvidence = new Map();
    }).toThrow(TypeError);
    expect(() =>
      (state.consumedRewardEvidence as Map<string, string>).delete("anything"),
    ).toThrow(TypeError);
  });
});

describe("the guard does not change what the fold sees", () => {
  it("still folds forward from a guarded state", () => {
    const state = folded();
    const next = applyPnlRecord(state, sell(4, "6", "0.7"));
    expect(next.ok).toBe(true);
    if (!next.ok) {
      return;
    }
    expect(next.value.lots.has(YES_TOKEN)).toBe(false);
    // The receiver is untouched, as before.
    expect(state.lots.get(YES_TOKEN)?.shares).toBe("6");
  });

  it("keeps rebuild-equals-incremental byte-for-byte", () => {
    const history = [buy(1, "10", "0.4"), sell(2, "4", "0.6"), fee(3, "0.05", "fees-v1")];
    let incremental = emptyPnlState(INSTANCE_STREAM);
    for (const record of history) {
      const result = applyPnlRecord(incremental, record);
      if (!result.ok) {
        throw new Error(`refused: ${JSON.stringify(result.refusals)}`);
      }
      incremental = result.value;
    }
    expect(serializePnlState(incremental)).toBe(serializePnlState(folded()));
  });
});
