/**
 * Runtime immutability of the containers this package returns (review round 1,
 * LOW-2).
 *
 * `Object.freeze` freezes properties, not a `Map`'s internal slots, so a frozen
 * projection still accepted `balances.set(...)` from any JavaScript consumer —
 * `readonly` in the type system stops only a TypeScript caller. For a monetary
 * projection that is a real hole: the fold is the only thing allowed to write
 * a balance line.
 *
 * These tests assert the mutation FAILS and that the failure is loud, and they
 * assert the guard did not quietly change what a `Map` is — the fold copies
 * these maps on every transaction, and the tests compare them structurally.
 */

import { describe, expect, it } from "vitest";

import { frozenMap, frozenSet } from "./immutable.js";
import { Ledger } from "./ledger.js";
import { balanceLineKey, projectLedger, serializeProjection } from "./projections.js";
import type { LedgerProjection } from "./projections.js";
import { ACCOUNT, PUSD, tx, unattributedDeposit } from "./testing/scenarios.js";

function seededProjection(): LedgerProjection {
  const result = Ledger.empty("PAPER").append(unattributedDeposit(tx(1), "100"));
  if (!result.ok) {
    throw new Error(`append refused: ${JSON.stringify(result.refusals)}`);
  }
  return projectLedger(result.value.ledger);
}

const FORGED_KEY = balanceLineKey("ACTUAL_ACCOUNT", "forged-account", PUSD);

describe("a returned projection cannot be edited by a JavaScript consumer", () => {
  const key = balanceLineKey("ACTUAL_ACCOUNT", ACCOUNT, PUSD);

  it("refuses a forged balance line and leaves the projection unchanged", () => {
    const projection = seededProjection();
    const before = serializeProjection(projection);
    expect(() => {
      (projection.balances as Map<string, unknown>).set(FORGED_KEY, {
        scope: "ACTUAL_ACCOUNT",
        accountRef: "acct",
        assetId: PUSD,
        assetKind: "COLLATERAL",
        balance: "1000000",
      });
    }).toThrow(TypeError);
    expect(projection.balances.get(FORGED_KEY)).toBeUndefined();
    expect(serializeProjection(projection)).toBe(before);
  });

  it("refuses deleting and clearing a balance line", () => {
    const projection = seededProjection();
    expect(() => (projection.balances as Map<string, unknown>).delete(key)).toThrow(TypeError);
    expect(() => (projection.balances as Map<string, unknown>).clear()).toThrow(TypeError);
    expect(projection.balances.get(key)?.balance).toBe("100");
  });

  it("refuses overwriting the mutator itself", () => {
    const projection = seededProjection();
    expect(() => {
      (projection.balances as unknown as { set: unknown }).set = (): void => undefined;
    }).toThrow(TypeError);
  });

  it("refuses editing virtual positions and the unattributed audit trail", () => {
    const projection = seededProjection();
    expect(() => (projection.virtualPositions as Map<string, unknown>).set("x", {})).toThrow(
      TypeError,
    );
    expect(() =>
      (projection.unattributedActivity as unknown as unknown[]).push({ forged: true }),
    ).toThrow(TypeError);
    expect(projection.unattributedActivity).toHaveLength(1);
  });

  it("names the reason, so the failure is diagnosable", () => {
    const projection = seededProjection();
    expect(() => (projection.balances as Map<string, unknown>).set("k", {})).toThrow(
      /append-only/u,
    );
  });
});

describe("the guard leaves an ordinary Map/Set otherwise intact", () => {
  it("still reads, iterates, and copies", () => {
    const projection = seededProjection();
    const copy = new Map(projection.balances);
    expect(copy.size).toBe(projection.balances.size);
    expect([...projection.balances.keys()].sort()).toEqual([...copy.keys()].sort());
    expect(projection.balances.has(balanceLineKey("ACTUAL_ACCOUNT", ACCOUNT, PUSD))).toBe(
      true,
    );
    // The copy is a normal mutable Map: the fold depends on that.
    copy.clear();
    expect(copy.size).toBe(0);
    expect(projection.balances.size).toBeGreaterThan(0);
  });

  it("keeps the guards non-enumerable, so structural comparison is unaffected", () => {
    const guarded = frozenMap(new Map([["a", "1"]]));
    expect(Object.keys(guarded)).toEqual([]);
    expect(guarded).toEqual(new Map([["a", "1"]]));
    expect(guarded instanceof Map).toBe(true);
  });

  it("guards a set the same way", () => {
    const guarded = frozenSet(new Set(["a"]));
    expect(guarded.has("a")).toBe(true);
    expect(() => (guarded as Set<string>).add("b")).toThrow(TypeError);
    expect(() => (guarded as Set<string>).delete("a")).toThrow(TypeError);
    expect(guarded.size).toBe(1);
  });
});
