/**
 * WP-200 acceptance 1, stated as a property rather than as examples.
 *
 * The example tests pin specific imbalances. These two properties pin the
 * rule itself over arbitrary generated transactions:
 *
 * 1. A transaction assembled from balanced pairs ALWAYS appends — the check
 *    has no false positives that would make legitimate accounting impossible.
 * 2. Perturbing ANY single entry by ANY non-zero delta ALWAYS refuses, and
 *    the refusal names that entry's asset with EXACTLY the delta as the
 *    imbalance — no tolerance band, no partial detection, no wrong asset.
 *
 * Property 2 is the important one: it is the mutation probe generalized. A
 * tolerance introduced anywhere in the balance path fails it immediately for
 * the deltas inside the band.
 */

import { addDecimal, isZeroDecimal, negateDecimal } from "@polymarket-bot/decimal";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Ledger } from "./ledger.js";
import {
  ACCOUNT,
  ATTRIBUTION_CLEARING,
  INSTANCE_A,
  MARKET_A,
  PUSD,
  USDC,
  VENUE_CLEARING,
  YES_TOKEN,
  transaction,
  tx,
} from "./testing/scenarios.js";
import type { LedgerEntryInput, LedgerTransactionInput } from "./transaction.js";

/** Canonical decimal strings with up to six places, never zero. */
const nonZeroAmount = fc
  .tuple(fc.integer({ min: 1, max: 9_999_999 }), fc.integer({ min: 0, max: 6 }))
  .map(([digits, places]) => {
    if (places === 0) {
      return String(digits);
    }
    const padded = String(digits).padStart(places + 1, "0");
    const whole = padded.slice(0, padded.length - places);
    const fraction = padded.slice(padded.length - places).replace(/0+$/u, "");
    return fraction === "" ? whole : `${whole}.${fraction}`;
  });

const ASSETS = [
  { assetId: PUSD, assetKind: "COLLATERAL" as const },
  { assetId: USDC, assetKind: "COLLATERAL" as const },
  { assetId: YES_TOKEN, assetKind: "OUTCOME_TOKEN" as const },
];

/**
 * A transaction assembled from balanced movements: for each generated leg,
 * an `ACTUAL_ACCOUNT` movement, its external-clearing counterpart, the
 * attribution mirror, and that mirror's counterpart. Balanced per asset and
 * parity-satisfying by construction.
 */
const balancedTransaction = fc
  .array(
    fc.record({
      assetIndex: fc.integer({ min: 0, max: ASSETS.length - 1 }),
      amount: nonZeroAmount,
      attributed: fc.boolean(),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((legs): LedgerTransactionInput => {
    const entries: LedgerEntryInput[] = [];
    legs.forEach((leg) => {
      const asset = ASSETS[leg.assetIndex]!;
      const common = {
        assetId: asset.assetId,
        assetKind: asset.assetKind,
        ...(asset.assetKind === "OUTCOME_TOKEN" ? { marketId: MARKET_A } : {}),
      };
      entries.push(
        { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, amount: leg.amount, ...common },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: VENUE_CLEARING,
          amount: negateDecimal(leg.amount),
          ...common,
        },
        leg.attributed
          ? {
              scope: "VIRTUAL_STRATEGY",
              accountRef: ACCOUNT,
              amount: leg.amount,
              instanceId: INSTANCE_A,
              ...common,
            }
          : { scope: "UNATTRIBUTED", accountRef: ACCOUNT, amount: leg.amount, ...common },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: ATTRIBUTION_CLEARING,
          amount: negateDecimal(leg.amount),
          ...common,
        },
      );
    });
    return transaction({ ledgerTransactionId: tx(1), entries });
  });

describe("property: the per-asset invariant has no false positives", () => {
  it("accepts every transaction assembled from balanced, attributed movements", () => {
    fc.assert(
      fc.property(balancedTransaction, (candidate) => {
        const result = Ledger.empty("PAPER").append(candidate);
        if (!result.ok) {
          throw new Error(
            `balanced transaction refused: ${JSON.stringify(result.refusals)}`,
          );
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe("property: any perturbation of any entry is refused, exactly", () => {
  it("names the perturbed entry's asset and the exact imbalance", () => {
    fc.assert(
      fc.property(
        balancedTransaction,
        fc.nat(),
        nonZeroAmount,
        fc.boolean(),
        (candidate, rawIndex, delta, negative) => {
          const index = rawIndex % candidate.entries.length;
          const target = candidate.entries[index]!;
          const signedDelta = negative ? negateDecimal(delta) : delta;
          const perturbedAmount = addDecimal(target.amount, signedDelta);
          // A perturbation that lands exactly on zero is refused by the
          // zero-amount rule BEFORE the balance check runs, which is correct
          // behavior but a different assertion; this property is about the
          // balance rule.
          fc.pre(!isZeroDecimal(perturbedAmount));
          const perturbed = {
            ...candidate,
            entries: candidate.entries.map((entry, position) =>
              position === index ? { ...entry, amount: perturbedAmount } : entry,
            ),
          };

          const result = Ledger.empty("PAPER").append(perturbed);
          expect(result.ok).toBe(false);
          if (result.ok) {
            return false;
          }
          const unbalanced = result.refusals.filter(
            (refusal) => refusal.code === "LEDGER_UNBALANCED_ASSET",
          );
          expect(unbalanced).toHaveLength(1);
          expect(unbalanced[0]?.details["assetId"]).toBe(target.assetId);
          expect(unbalanced[0]?.details["netImbalance"]).toBe(signedDelta);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});
