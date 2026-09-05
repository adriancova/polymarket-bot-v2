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

import { deepFreeze, frozenMap, frozenSet, plainFrozen } from "./immutable.js";
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

  /**
   * THE MUTATION THIS TEST EXISTS TO KILL, and why it did not (`WP-200-FU1`
   * review round 1, finding L2).
   *
   * Round 1's version installed `Object.prototype.value = "inherited"`, put an
   * ACCESSOR on the holder, and asserted only that `deepFreeze` returned
   * ("FROZE") and that the holder ended up frozen. Under the mutation —
   * `"value" in descriptor` in place of `Object.hasOwn(descriptor, "value")` —
   * the accessor's descriptor DOES read as a data descriptor, `descriptor.value`
   * resolves to the inherited STRING, and `deepFreeze("inherited")` returns it
   * untouched at the primitive guard. Same return, same frozen holder, same
   * outcome string: the test could not tell the two implementations apart.
   *
   * MEASURED at tip `7d5ac34`: with the mutation applied to `deepFreeze` in BOTH
   * this package and `@polymarket-bot/pnl`, the whole root suite — 229 files,
   * 5354 tests — passed.
   *
   * What discriminates is making the inherited `value` an OBJECT and then asking
   * what happened TO IT. The correct implementation never looks at an accessor's
   * `value`, so the inherited object is untouched; the mutation walks into it and
   * freezes it. Freezing a value nobody handed to this module is not cosmetic:
   * `deepFreeze` is how this package makes a monetary record unwritable, and a
   * version that follows an INHERITED reference freezes whatever the prototype
   * chain points at — including an object a caller is still filling in.
   */
  it("reads a descriptor with `Object.hasOwn`, not `in`, so an inherited `value` cannot fool it", () => {
    // The same class as `plain-data.ts` review round 6: `"value" in descriptor`
    // answers for an INHERITED name, so with `Object.prototype.value` defined
    // every ACCESSOR descriptor read as a data descriptor.
    const inheritedTarget: Record<string, unknown> = { costBasis: "4" };
    const holder: Record<string, unknown> = {};
    let getterRuns = 0;
    Object.defineProperty(holder, "computed", {
      get: () => {
        getterRuns += 1;
        return "never read";
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(Object.prototype, "value", {
      value: inheritedTarget,
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
    // THE DISCRIMINATOR. `Object.hasOwn` skips the accessor, so the inherited
    // object is never reached; `"value" in descriptor` reaches it and freezes it.
    expect(Object.isFrozen(inheritedTarget)).toBe(false);
    inheritedTarget["costBasis"] = "5";
    expect(inheritedTarget["costBasis"]).toBe("5");
    // And the accessor itself is never invoked, under either reading.
    expect(getterRuns).toBe(0);
  });

  it("`plainFrozen` reads descriptors the same way: an inherited `value` is not COPIED", () => {
    // The same mutation on the other `Object.hasOwn` in this module. There it is
    // worse than an over-freeze: `plainFrozen` builds what this package EMITS, so
    // reading an accessor's descriptor as a data descriptor would copy the
    // INHERITED value into a monetary record under the accessor's own key.
    const source: Record<string, unknown> = { shares: "10" };
    Object.defineProperty(source, "price", {
      get: () => "0.99",
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(Object.prototype, "value", {
      value: "0.01",
      writable: true,
      enumerable: false,
      configurable: true,
    });
    let keys: readonly string[];
    let priceRead: unknown;
    try {
      const emitted = plainFrozen(source);
      keys = Object.getOwnPropertyNames(emitted).sort();
      priceRead = (emitted as Record<string, unknown>)["price"];
    } finally {
      delete (Object.prototype as Record<string, unknown>)["value"];
    }
    // The accessor is dropped, not copied: only the own DATA property survives.
    expect(keys).toEqual(["shares"]);
    expect(priceRead).toBeUndefined();
  });
});
