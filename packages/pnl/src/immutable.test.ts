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

import { deepFreeze } from "./immutable.js";
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


/**
 * The deep-freeze MEMO — `WP-200`'s carried LOW residual, closed by
 * `WP-200-FU1`.
 *
 * THE DEFECT. `deepFreeze` added the object to `DEEP_FROZEN` and THEN froze it.
 * The memo's soundness argument is stated at its own declaration — "a member of
 * this set is frozen, so its own property values cannot have changed since it
 * was walked" — and a throwing `Object.freeze` falsified it: the object was
 * recorded as done while still mutable, and every later `deepFreeze` of it,
 * including one from a clean caller retrying, returned immediately without
 * freezing anything. In a package whose whole reason for deep-freezing is that
 * "a monetary value a consumer can edit is a monetary value a consumer can
 * invent", a silently-unfrozen memoised value is exactly the outcome the guard
 * exists to prevent.
 *
 * THE REACHABLE TRIGGER, and the reason this is a test rather than a comment: a
 * `Proxy` whose `preventExtensions` trap throws. `Object.freeze` calls
 * `[[PreventExtensions]]`, the trap runs, and the throw leaves `deepFreeze`
 * with the memo already poisoned.
 *
 * EVIDENCE CLASS: EXECUTED. The `throw-then-retry` assertion FAILS on the
 * pre-fix ordering — verified by swapping the two lines back locally — so it is
 * a regression test, not a restatement.
 */
describe("deepFreeze memoises only what it actually froze", () => {
  it("does not memoise an object whose freeze threw, so a retry still freezes it", () => {
    let refuse = true;
    const target: Record<string, unknown> = { costBasis: "4" };
    const hostile = new Proxy(target, {
      preventExtensions() {
        if (refuse) {
          throw new TypeError("preventExtensions refused");
        }
        Object.preventExtensions(target);
        return true;
      },
    });

    // First attempt: the freeze throws out of `deepFreeze`.
    expect(() => deepFreeze(hostile)).toThrow(TypeError);
    expect(Object.isFrozen(target)).toBe(false);

    // Second attempt, with the trap cooperating. Under the OLD ordering the
    // object was already in the memo, so this returned without freezing and
    // `costBasis` stayed writable.
    refuse = false;
    deepFreeze(hostile);
    expect(Object.isFrozen(target)).toBe(true);
    expect(() => {
      target["costBasis"] = "999999";
    }).toThrow(TypeError);
    expect(target["costBasis"]).toBe("4");
  });

  it("still terminates on a cycle (the memo's other job is unchanged)", () => {
    const node: Record<string, unknown> = { value: "1" };
    node["self"] = node;
    expect(() => deepFreeze(node)).not.toThrow();
    expect(Object.isFrozen(node)).toBe(true);
  });

  it("reads a descriptor with `Object.hasOwn`, not `in`, so an inherited `value` cannot fool it", () => {
    // The same class as `plain-data.ts` review round 6: `"value" in descriptor`
    // answers for an INHERITED name, so with `Object.prototype.value` defined
    // every ACCESSOR descriptor read as a data descriptor.
    const holder: Record<string, unknown> = {};
    Object.defineProperty(holder, "computed", {
      get: () => "never read",
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(Object.prototype, "value", {
      value: "inherited",
      writable: true,
      enumerable: false,
      configurable: true,
    });
    let outcome: string;
    try {
      deepFreeze(holder);
      outcome = "FROZE";
    } catch {
      outcome = "THREW";
    } finally {
      delete (Object.prototype as Record<string, unknown>)["value"];
    }
    expect(outcome).toBe("FROZE");
    expect(Object.isFrozen(holder)).toBe(true);
  });
});
