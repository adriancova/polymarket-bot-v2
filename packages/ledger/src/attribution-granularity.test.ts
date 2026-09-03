/**
 * Attribution KEY GRANULARITY: the review-round-1 HIGH, pinned permanently.
 *
 * The defect: attribution parity and the §9.15 halt classification were both
 * keyed by `assetId` alone, so movements in DIFFERENT accounts cancelled in
 * one sum. The reviewer's counterexample is one balanced transaction —
 *
 *     ACTUAL_ACCOUNT   A  −5
 *     ACTUAL_ACCOUNT   B  +5
 *     VIRTUAL_STRATEGY B  −5
 *     UNATTRIBUTED     B  +5
 *
 * — in which the per-asset balance is zero and the per-asset attribution
 * parity is zero, yet account B really did receive 5 that nobody claimed and
 * account A really did lose 5 that nobody accounted for. It appended cleanly
 * and its UNATTRIBUTED entry was classified `REATTRIBUTION` with
 * `haltRequired: false`, so §9.15's "any actual balance change lacking
 * attribution … the affected market is halted" never fired.
 *
 * The remediation has TWO independent barriers, because there are two
 * independent write paths into a projection:
 *
 * 1. `Ledger.append` now refuses the shape outright — parity is keyed by
 *    `(accountRef, assetId)`, so account A's unaccounted −5 and account B's
 *    unbacked attribution are each named. Nothing this package appends can
 *    contain a hidden arrival.
 * 2. The projection fold classifies against the entry's OWN bucket by
 *    PRESENCE of a real leg, not by a net — because history reaches a fold
 *    from the WP-040 tables too, and those enforce the per-asset zero-sum in
 *    SQL but NOT this partition. A record written by another writer, replayed
 *    here, is classified as the arrival it is.
 *
 * Both barriers are asserted below on the reviewer's EXACT transaction, and
 * the accept-and-halt path is asserted on the nearest transaction the stricter
 * parity admits.
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { addDecimal, negateDecimal } from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import {
  attributionBuckets,
  checkAttributionParity,
  checkPerAssetBalance,
  legDeltas,
  legKey,
} from "./balance.js";
import { Ledger } from "./ledger.js";
import {
  applyTransaction,
  auditAttributionPartition,
  balanceLineKey,
  emptyProjection,
  unattributedExposure,
} from "./projections.js";
import type { LedgerProjection } from "./projections.js";
import {
  ACCOUNT,
  INSTANCE_A,
  OTHER_ACCOUNT,
  PUSD,
  collateral,
  reattribute,
  transaction,
  tx,
} from "./testing/scenarios.js";
import { validateTransactionInput } from "./transaction.js";
import type { LedgerTransactionInput } from "./transaction.js";

/** The reviewer's counterexample, entry for entry. */
const CROSS_ACCOUNT_ARRIVAL: LedgerTransactionInput = transaction({
  ledgerTransactionId: tx(1),
  eventType: "MANUAL_ADJUSTMENT",
  accountRef: ACCOUNT,
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
    collateral("ACTUAL_ACCOUNT", OTHER_ACCOUNT, "5"),
    collateral("VIRTUAL_STRATEGY", OTHER_ACCOUNT, "-5", { instanceId: INSTANCE_A }),
    collateral("UNATTRIBUTED", OTHER_ACCOUNT, "5"),
  ],
});

/**
 * The same real event recorded legally: account A's loss is attributed (the
 * instance that held it gives it up) and account B's gain is explicitly
 * UNATTRIBUTED, which is what §9.15 asks a writer to do with a movement
 * nobody claims.
 */
const LEGAL_CROSS_ACCOUNT_ARRIVAL: LedgerTransactionInput = transaction({
  ledgerTransactionId: tx(2),
  eventType: "MANUAL_ADJUSTMENT",
  accountRef: ACCOUNT,
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
    collateral("VIRTUAL_STRATEGY", ACCOUNT, "-5", { instanceId: INSTANCE_A }),
    collateral("ACTUAL_ACCOUNT", OTHER_ACCOUNT, "5"),
    collateral("UNATTRIBUTED", OTHER_ACCOUNT, "5"),
  ],
});

/** Folds one transaction the way externally-loaded history reaches a projection. */
function foldExternalHistory(input: LedgerTransactionInput): LedgerProjection {
  const validated = validateTransactionInput(input);
  if (!validated.ok) {
    throw new Error(`fixture is not a well-formed transaction: ${JSON.stringify(validated.refusals)}`);
  }
  return applyTransaction(emptyProjection(), { sequence: 0, transaction: validated.value });
}

describe("the reviewer's cross-account counterexample", () => {
  it("balances per asset and nets to zero per asset in attribution — which is why it slipped through", () => {
    // The preconditions of the finding, stated so the test cannot silently
    // stop being about the reported case. The sums below are the OLD,
    // asset-keyed ones: both are zero, which is exactly what made two real
    // movements invisible. Exact decimal arithmetic, as everywhere.
    expect(checkPerAssetBalance(CROSS_ACCOUNT_ARRIVAL)).toEqual([]);
    const buckets = [...attributionBuckets(CROSS_ACCOUNT_ARRIVAL).values()];
    const perAssetActual = buckets.reduce<DecimalString>(
      (sum, bucket) => addDecimal(sum, bucket.actualDelta),
      "0",
    );
    const perAssetAttributed = buckets.reduce<DecimalString>(
      (sum, bucket) => addDecimal(sum, bucket.attributedDelta),
      "0",
    );
    expect(perAssetActual).toBe("0");
    expect(perAssetAttributed).toBe("0");
  });

  it("is REFUSED by Ledger.append, naming both accounts and their exact gaps", () => {
    const result = Ledger.empty("PAPER").append(CROSS_ACCOUNT_ARRIVAL);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const parity = result.refusals.filter(
      (refusal) => refusal.code === "LEDGER_ATTRIBUTION_PARITY_BROKEN",
    );
    expect(parity).toHaveLength(2);
    expect(parity.map((refusal) => refusal.details)).toEqual([
      {
        ledgerTransactionId: tx(1),
        accountRef: ACCOUNT,
        assetId: PUSD,
        actualDelta: "-5",
        attributedDelta: "0",
      },
      {
        ledgerTransactionId: tx(1),
        accountRef: OTHER_ACCOUNT,
        assetId: PUSD,
        actualDelta: "5",
        attributedDelta: "0",
      },
    ]);
  });

  it("is classified ACTUAL_ARRIVAL with haltRequired true when it reaches a fold anyway", () => {
    // The WP-040 tables enforce the per-asset zero-sum, not this partition, so
    // this shape can exist in history written by another writer. Folding it
    // must raise the halt, not file it as a remediation.
    const projection = foldExternalHistory(CROSS_ACCOUNT_ARRIVAL);
    expect(projection.unattributedActivity).toHaveLength(1);
    expect(projection.unattributedActivity[0]).toMatchObject({
      accountRef: OTHER_ACCOUNT,
      assetId: PUSD,
      amount: "5",
      activityKind: "ACTUAL_ARRIVAL",
      haltRequired: true,
    });
    expect(unattributedExposure(projection)).toEqual([
      {
        accountRef: OTHER_ACCOUNT,
        assetId: PUSD,
        net: "5",
        affectedMarketIds: [],
        haltTriggerCount: 1,
        haltRequired: true,
      },
    ]);
  });

  it("is reported by the partition audit, per account, where a per-asset audit saw nothing", () => {
    const violations = auditAttributionPartition(foldExternalHistory(CROSS_ACCOUNT_ARRIVAL));
    expect(violations).toEqual([
      { accountRef: ACCOUNT, assetId: PUSD, actual: "-5", attributed: "0" },
      { accountRef: OTHER_ACCOUNT, assetId: PUSD, actual: "5", attributed: "0" },
    ]);
  });
});

describe("a cross-account arrival recorded legally", () => {
  it("is ACCEPTED and classified ACTUAL_ARRIVAL with haltRequired true", () => {
    const result = Ledger.empty("PAPER").append(LEGAL_CROSS_ACCOUNT_ARRIVAL);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const projection = applyTransaction(emptyProjection(), result.value.appended);
    expect(projection.unattributedActivity).toHaveLength(1);
    expect(projection.unattributedActivity[0]).toMatchObject({
      accountRef: OTHER_ACCOUNT,
      activityKind: "ACTUAL_ARRIVAL",
      haltRequired: true,
    });
    expect(unattributedExposure(projection)[0]).toMatchObject({
      accountRef: OTHER_ACCOUNT,
      assetId: PUSD,
      haltRequired: true,
      haltTriggerCount: 1,
    });
  });

  it("holds the partition audit clean, per account", () => {
    const result = Ledger.empty("PAPER").append(LEGAL_CROSS_ACCOUNT_ARRIVAL);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(
      auditAttributionPartition(applyTransaction(emptyProjection(), result.value.appended)),
    ).toEqual([]);
  });
});

describe("no cancellation at any granularity hides an arrival", () => {
  it("classifies an arrival whose bucket's actual legs net to zero", () => {
    // Same account, same asset: a real −5 and a real +5 in ONE transaction.
    // The bucket's net actual movement is zero, and two real movements
    // happened; a net-based rule filed this as a remediation.
    const netted = transaction({
      ledgerTransactionId: tx(3),
      entries: [
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
        collateral("VIRTUAL_STRATEGY", ACCOUNT, "-5", { instanceId: INSTANCE_A }),
        collateral("UNATTRIBUTED", ACCOUNT, "5"),
      ],
    });
    // It passes both refusal gates: the bucket balances and parity holds.
    const appended = Ledger.empty("PAPER").append(netted);
    expect(appended.ok).toBe(true);
    if (!appended.ok) {
      return;
    }
    const projection = applyTransaction(emptyProjection(), appended.value.appended);
    expect(projection.unattributedActivity[0]).toMatchObject({
      activityKind: "ACTUAL_ARRIVAL",
      haltRequired: true,
    });
  });

  it("does not net two accounts' exposure into one line", () => {
    const twoAccounts = transaction({
      ledgerTransactionId: tx(4),
      entries: [
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
        collateral("UNATTRIBUTED", ACCOUNT, "-5"),
        collateral("ACTUAL_ACCOUNT", OTHER_ACCOUNT, "5"),
        collateral("UNATTRIBUTED", OTHER_ACCOUNT, "5"),
      ],
    });
    const result = Ledger.empty("PAPER").append(twoAccounts);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const exposure = unattributedExposure(
      applyTransaction(emptyProjection(), result.value.appended),
    );
    expect(exposure.map((line) => [line.accountRef, line.net, line.haltRequired])).toEqual([
      [ACCOUNT, "-5", true],
      [OTHER_ACCOUNT, "5", true],
    ]);
  });
});

describe("a composite key never merges two different lines", () => {
  // Same family of defect, found while re-reading the module: every composite
  // key here used to be `a|b|c`, and `NonEmptyStringSchema` bounds an
  // identifier's LENGTH and nothing else. `("a", "b|c")` and `("a|b", "c")`
  // joined to the same string, so two accounts' balances merged into one line
  // — silently, and after every balance and parity check had already passed.
  const ACCOUNT_ONE = "a";
  const ASSET_ONE = "b|c";
  const ACCOUNT_TWO = "a|b";
  const ASSET_TWO = "c";

  const colliding = transaction({
    ledgerTransactionId: tx(7),
    entries: [
      {
        scope: "ACTUAL_ACCOUNT",
        accountRef: ACCOUNT_ONE,
        assetId: ASSET_ONE,
        assetKind: "COLLATERAL",
        amount: "5",
      },
      {
        scope: "EXTERNAL_CLEARING",
        accountRef: "clearing-venue",
        assetId: ASSET_ONE,
        assetKind: "COLLATERAL",
        amount: "-5",
      },
      {
        scope: "UNATTRIBUTED",
        accountRef: ACCOUNT_ONE,
        assetId: ASSET_ONE,
        assetKind: "COLLATERAL",
        amount: "5",
      },
      {
        scope: "EXTERNAL_CLEARING",
        accountRef: "clearing-attribution",
        assetId: ASSET_ONE,
        assetKind: "COLLATERAL",
        amount: "-5",
      },
      {
        scope: "ACTUAL_ACCOUNT",
        accountRef: ACCOUNT_TWO,
        assetId: ASSET_TWO,
        assetKind: "COLLATERAL",
        amount: "7",
      },
      {
        scope: "EXTERNAL_CLEARING",
        accountRef: "clearing-venue",
        assetId: ASSET_TWO,
        assetKind: "COLLATERAL",
        amount: "-7",
      },
      {
        scope: "UNATTRIBUTED",
        accountRef: ACCOUNT_TWO,
        assetId: ASSET_TWO,
        assetKind: "COLLATERAL",
        amount: "7",
      },
      {
        scope: "EXTERNAL_CLEARING",
        accountRef: "clearing-attribution",
        assetId: ASSET_TWO,
        assetKind: "COLLATERAL",
        amount: "-7",
      },
    ],
  });

  it("the two identifiers really would have collided under `a|b|c`", () => {
    expect(`ACTUAL_ACCOUNT|${ACCOUNT_ONE}|${ASSET_ONE}`).toBe(
      `ACTUAL_ACCOUNT|${ACCOUNT_TWO}|${ASSET_TWO}`,
    );
    expect(balanceLineKey("ACTUAL_ACCOUNT", ACCOUNT_ONE, ASSET_ONE)).not.toBe(
      balanceLineKey("ACTUAL_ACCOUNT", ACCOUNT_TWO, ASSET_TWO),
    );
  });

  it("keeps two balance lines, not one merged 12", () => {
    const result = Ledger.empty("PAPER").append(colliding);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const projection = applyTransaction(emptyProjection(), result.value.appended);
    expect(
      projection.balances.get(balanceLineKey("ACTUAL_ACCOUNT", ACCOUNT_ONE, ASSET_ONE))?.balance,
    ).toBe("5");
    expect(
      projection.balances.get(balanceLineKey("ACTUAL_ACCOUNT", ACCOUNT_TWO, ASSET_TWO))?.balance,
    ).toBe("7");
  });

  it("keeps the two attribution buckets and the two exposures apart", () => {
    // Two buckets — `(a, "b|c")` and `("a|b", "c")` — each carrying its own
    // actual and attributed side. Under the joined key they were one.
    expect(attributionBuckets(colliding).size).toBe(2);
    expect(checkAttributionParity(colliding)).toEqual([]);
    const result = Ledger.empty("PAPER").append(colliding);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const exposure = unattributedExposure(
      applyTransaction(emptyProjection(), result.value.appended),
    );
    expect(exposure.map((line) => [line.accountRef, line.assetId, line.net])).toEqual([
      [ACCOUNT_ONE, ASSET_ONE, "5"],
      [ACCOUNT_TWO, ASSET_TWO, "7"],
    ]);
  });

  it("keeps every leg apart in a reversal signature", () => {
    expect(
      legKey({ scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT_ONE, assetId: ASSET_ONE }),
    ).not.toBe(
      legKey({ scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT_TWO, assetId: ASSET_TWO }),
    );
    expect(legDeltas(colliding).size).toBe(8);
  });

  /**
   * The collision was not cosmetic on the reversal path: a merged leg
   * signature can make a transaction that does NOT negate the original look
   * like an exact compensation (ADR-006 §5.2), which is how a 7 gets booked as
   * the reversal of a 5 and the ledger accepts it forever.
   */
  describe("and a merged signature cannot fake a compensating reversal", () => {
    /** The pre-remediation leg key, reproduced here to state the precondition. */
    function joinedSignature(input: LedgerTransactionInput): ReadonlyMap<string, string> {
      const deltas = new Map<string, string>();
      for (const entry of input.entries) {
        const key = `${entry.scope}|${entry.accountRef}|${entry.instanceId ?? ""}|${entry.assetId}`;
        deltas.set(key, addDecimal(deltas.get(key) ?? "0", entry.amount));
      }
      for (const [key, value] of deltas) {
        if (value === "0") {
          deltas.delete(key);
        }
      }
      return deltas;
    }

    /** Every leg of this shape shares a joined key with its opposite number. */
    function shape(id: string, amount: string, doubled: string): LedgerTransactionInput {
      return transaction({
        ledgerTransactionId: id,
        entries: [
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: "a",
            assetId: "b||c",
            assetKind: "COLLATERAL",
            amount,
          },
          {
            scope: "UNATTRIBUTED",
            accountRef: "a",
            assetId: "b||c",
            assetKind: "COLLATERAL",
            amount,
          },
          {
            scope: "EXTERNAL_CLEARING",
            accountRef: "clr",
            assetId: "b||c",
            assetKind: "COLLATERAL",
            amount: `-${doubled}`,
          },
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: "a||b",
            assetId: "c",
            assetKind: "COLLATERAL",
            amount: `-${amount}`,
          },
          {
            scope: "UNATTRIBUTED",
            accountRef: "a||b",
            assetId: "c",
            assetKind: "COLLATERAL",
            amount: `-${amount}`,
          },
          {
            scope: "EXTERNAL_CLEARING",
            accountRef: "clr||b",
            assetId: "c",
            assetKind: "COLLATERAL",
            amount: doubled,
          },
        ],
      });
    }

    const original = shape(tx(8), "5", "10");
    const notAReversal: LedgerTransactionInput = {
      ...shape(tx(9), "7", "14"),
      reversesLedgerTransactionId: tx(8),
    };

    it("both transactions are legal on their own", () => {
      expect(checkPerAssetBalance(original)).toEqual([]);
      expect(checkAttributionParity(original)).toEqual([]);
      expect(checkPerAssetBalance(notAReversal)).toEqual([]);
      expect(checkAttributionParity(notAReversal)).toEqual([]);
    });

    it("under the joined key BOTH signatures were empty — so either 'negated' the other", () => {
      expect([...joinedSignature(original).entries()]).toEqual([]);
      expect([...joinedSignature(notAReversal).entries()]).toEqual([]);
    });

    it("refuses the 7 that claims to reverse the 5", () => {
      const first = Ledger.empty("PAPER").append(original);
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      expect(legDeltas(original).size).toBe(6);
      const second = first.value.ledger.append(notAReversal);
      expect(second.ok).toBe(false);
      if (second.ok) {
        return;
      }
      expect(second.refusals.map((refusal) => refusal.code)).toContain(
        "LEDGER_REVERSAL_NOT_COMPENSATING",
      );
    });

    it("still accepts the reversal that really does negate it", () => {
      const first = Ledger.empty("PAPER").append(original);
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      const exact: LedgerTransactionInput = {
        ...original,
        ledgerTransactionId: tx(10),
        reversesLedgerTransactionId: tx(8),
        entries: original.entries.map((entry) => ({
          ...entry,
          amount: negateDecimal(entry.amount),
        })),
      };
      expect(first.value.ledger.append(exact).ok).toBe(true);
    });
  });
});

describe("what the stricter rule must NOT break", () => {
  it("keeps a pure re-attribution a REATTRIBUTION, with no halt re-raised", () => {
    const result = Ledger.empty("PAPER").append(reattribute(tx(5), "10", INSTANCE_A));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const projection = applyTransaction(emptyProjection(), result.value.appended);
    expect(projection.unattributedActivity[0]).toMatchObject({
      activityKind: "REATTRIBUTION",
      haltRequired: false,
    });
    expect(unattributedExposure(projection)[0]?.haltRequired).toBe(false);
  });

  it("keeps a re-attribution in one bucket unaffected by a real movement in ANOTHER", () => {
    // A collateral payment out of the account, plus a token-side remediation
    // in the same transaction. The token bucket has no actual leg, so the
    // remediation is still a remediation.
    const mixed = transaction({
      ledgerTransactionId: tx(6),
      entries: [
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
        collateral("EXTERNAL_CLEARING", "clearing-venue", "5"),
        collateral("VIRTUAL_STRATEGY", ACCOUNT, "-5", { instanceId: INSTANCE_A }),
        collateral("EXTERNAL_CLEARING", "clearing-attribution", "5"),
        {
          scope: "UNATTRIBUTED" as const,
          accountRef: ACCOUNT,
          assetId: "token-x",
          assetKind: "OUTCOME_TOKEN" as const,
          amount: "-3",
        },
        {
          scope: "VIRTUAL_STRATEGY" as const,
          accountRef: ACCOUNT,
          assetId: "token-x",
          assetKind: "OUTCOME_TOKEN" as const,
          amount: "3",
          instanceId: INSTANCE_A,
        },
      ],
    });
    const result = Ledger.empty("PAPER").append(mixed);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const projection = applyTransaction(emptyProjection(), result.value.appended);
    expect(projection.unattributedActivity).toHaveLength(1);
    expect(projection.unattributedActivity[0]).toMatchObject({
      assetId: "token-x",
      activityKind: "REATTRIBUTION",
      haltRequired: false,
    });
  });

  it("still refuses an actual movement with no attribution anywhere", () => {
    const refusals = checkAttributionParity(
      transaction({
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "10"),
          collateral("EXTERNAL_CLEARING", "clearing-venue", "-10"),
        ],
      }),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.details).toMatchObject({
      accountRef: ACCOUNT,
      actualDelta: "10",
      attributedDelta: "0",
    });
  });
});
