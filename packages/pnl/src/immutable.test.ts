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
import { applyPnlRecord, emptyPnlState, foldPnlRecords } from "./state.js";
import type { PnlState } from "./state.js";
import { INSTANCE_STREAM, PUSD, YES_TOKEN, buy, fee, sell } from "./testing/samples.js";

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
