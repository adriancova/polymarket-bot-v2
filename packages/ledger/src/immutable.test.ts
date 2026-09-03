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
import {
  applyTransaction,
  balanceLineKey,
  balancesOfScope,
  projectLedger,
  serializeProjection,
  unattributedExposure,
  virtualPositionKey,
  virtualPositions,
} from "./projections.js";
import type { LedgerProjection } from "./projections.js";
import {
  ACCOUNT,
  ATTRIBUTION_CLEARING,
  INSTANCE_A,
  PUSD,
  VENUE_CLEARING,
  collateral,
  transaction,
  tx,
  unattributedDeposit,
} from "./testing/scenarios.js";

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

/**
 * Review round 2, HIGH-4: round 1 sealed the CONTAINERS and left their VALUES
 * writable, so `projection.balances.get(key).balance = "999"` succeeded by
 * ordinary property assignment — no `Map.prototype.set.call`, no `Reflect`, no
 * capability bypass of any kind. The tests below assert the mutation now fails,
 * AND assert what the reviewer actually demonstrated: that when it succeeded,
 * the corrupted line COMPOUNDED into every later fold, so an incremental state
 * and a rebuild of the same history disagreed about how much money there was.
 */
describe("a returned projection's VALUES cannot be edited either", () => {
  const key = balanceLineKey("ACTUAL_ACCOUNT", ACCOUNT, PUSD);

  function seededFive(): { readonly ledger: Ledger; readonly projection: LedgerProjection } {
    const result = Ledger.empty("PAPER").append(unattributedDeposit(tx(1), "5"));
    if (!result.ok) {
      throw new Error(`append refused: ${JSON.stringify(result.refusals)}`);
    }
    return { ledger: result.value.ledger, projection: projectLedger(result.value.ledger) };
  }

  it("refuses to rewrite a balance line's amount", () => {
    const { projection } = seededFive();
    const line = projection.balances.get(key);
    expect(line?.balance).toBe("5");
    expect(() => {
      (line as unknown as { balance: string }).balance = "999";
    }).toThrow(TypeError);
    expect(projection.balances.get(key)?.balance).toBe("5");
  });

  it("keeps the fold and the rebuild agreeing about the money afterwards", () => {
    // THE DIVERGENCE, not just the throw. With the line mutated to 999, the
    // reviewer's next `+2` produced 1001 incrementally and 7 on rebuild — two
    // different answers about one history, from one process.
    const { ledger, projection } = seededFive();
    const line = projection.balances.get(key);
    expect(() => {
      (line as unknown as { balance: string }).balance = "999";
    }).toThrow(TypeError);

    const second = ledger.append(unattributedDeposit(tx(2), "2"));
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const incremental = applyTransaction(projection, second.value.appended);
    const rebuilt = projectLedger(second.value.ledger);
    expect(incremental.balances.get(key)?.balance).toBe("7");
    expect(rebuilt.balances.get(key)?.balance).toBe("7");
    expect(serializeProjection(incremental)).toBe(serializeProjection(rebuilt));
  });

  it("refuses to rewrite a virtual position line", () => {
    const seeded = Ledger.empty("PAPER").append(
      transaction({
        ledgerTransactionId: tx(1),
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
          collateral("VIRTUAL_STRATEGY", ACCOUNT, "5", { instanceId: INSTANCE_A }),
          collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-5"),
        ],
      }),
    );
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }
    const projection = projectLedger(seeded.value.ledger);
    const line = projection.virtualPositions.get(virtualPositionKey(INSTANCE_A, PUSD));
    expect(line?.balance).toBe("5");
    expect(() => {
      (line as unknown as { balance: string }).balance = "999";
    }).toThrow(TypeError);
    expect(() => {
      (line as unknown as { instanceId: string }).instanceId = "someone-else";
    }).toThrow(TypeError);
    expect(virtualPositions(projection)[0]).toMatchObject({
      instanceId: INSTANCE_A,
      balance: "5",
    });
  });

  it("refuses to rewrite an unattributed record's halt obligation or amount", () => {
    const projection = seededProjection();
    const record = projection.unattributedActivity[0];
    expect(record?.haltRequired).toBe(true);
    expect(() => {
      (record as unknown as { haltRequired: boolean }).haltRequired = false;
    }).toThrow(TypeError);
    expect(() => {
      (record as unknown as { amount: string }).amount = "0";
    }).toThrow(TypeError);
    expect(projection.unattributedActivity[0]?.haltRequired).toBe(true);
    expect(unattributedExposure(projection)[0]?.haltRequired).toBe(true);
  });

  it("refuses to rewrite a line reached through balancesOfScope or the array holding it", () => {
    const projection = seededProjection();
    const lines = balancesOfScope(projection, "ACTUAL_ACCOUNT");
    expect(() => {
      (lines[0] as unknown as { balance: string }).balance = "999";
    }).toThrow(TypeError);
    expect(() => {
      (lines as unknown as unknown[])[0] = { forged: true };
    }).toThrow(TypeError);
    expect(projection.balances.get(key)?.balance).toBe("100");
  });

  it("refuses to rewrite an exposure line an operator reads the halt from", () => {
    const line = unattributedExposure(seededProjection())[0];
    expect(() => {
      (line as unknown as { haltRequired: boolean }).haltRequired = false;
    }).toThrow(TypeError);
    expect(() => {
      (line as unknown as { haltTriggerCount: number }).haltTriggerCount = 0;
    }).toThrow(TypeError);
    expect(line?.haltRequired).toBe(true);
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
