/**
 * The central invariant, as pure functions over one transaction.
 *
 * §9.15 / §10.7 / ADR-006 §1: "Every ledger transaction balances to zero
 * **per asset** using explicit external-clearing accounts." The check is
 * per-asset, never a global sum — two assets that are each unbalanced but
 * happen to cancel numerically are TWO violations, not zero.
 *
 * ADR-006 §2 adds the attribution rule this module enforces alongside it:
 * virtual allocation never creates or destroys value, so within every
 * transaction the actual movement of an asset equals its attributed movement
 * (`VIRTUAL_STRATEGY` + `UNATTRIBUTED`). Enforcing it per transaction makes
 * §6 invariant 7 hold inductively from the empty ledger.
 *
 * All arithmetic is exact decimal-string arithmetic (`addDecimal`); no float
 * ever touches an amount.
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { addDecimal, isZeroDecimal, subDecimal } from "@polymarket-bot/decimal";

import type { LedgerRefusal } from "./refusals.js";
import { ledgerRefusal } from "./refusals.js";
import type { LedgerTransactionInput } from "./transaction.js";

const ZERO: DecimalString = "0";

function addInto(map: Map<string, DecimalString>, key: string, amount: DecimalString): void {
  map.set(key, addDecimal(map.get(key) ?? ZERO, amount));
}

/** Exact net movement per asset over every entry of the transaction. */
export function netByAsset(
  transaction: LedgerTransactionInput,
): ReadonlyMap<string, DecimalString> {
  const nets = new Map<string, DecimalString>();
  for (const entry of transaction.entries) {
    addInto(nets, entry.assetId, entry.amount);
  }
  return nets;
}

/**
 * The per-asset zero-sum check. Returns one refusal PER unbalanced asset,
 * each naming the asset and its exact net imbalance, so an operator sees
 * every violation at once (never only the first).
 */
export function checkPerAssetBalance(
  transaction: LedgerTransactionInput,
): readonly LedgerRefusal[] {
  const refusals: LedgerRefusal[] = [];
  for (const [assetId, net] of netByAsset(transaction)) {
    if (!isZeroDecimal(net)) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_UNBALANCED_ASSET",
          `transaction ${transaction.ledgerTransactionId} does not balance for asset ` +
            `${assetId}: net ${net} (§9.15: balance one-sided movement with an ` +
            "EXTERNAL_CLEARING entry)",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            assetId,
            netImbalance: net,
          },
        ),
      );
    }
  }
  return refusals;
}

/**
 * ADR-006 §2 attribution parity, per asset:
 *
 * Δ(ACTUAL_ACCOUNT) = Δ(VIRTUAL_STRATEGY) + Δ(UNATTRIBUTED)
 *
 * A transaction that moves an actual holding must state, in the same
 * transaction, whose it is — a strategy instance's, or explicitly
 * `UNATTRIBUTED` (§9.15: "Any actual balance change lacking attribution is
 * allocated to UNATTRIBUTED"). Re-attribution later is a new transaction
 * moving value from `UNATTRIBUTED` to `VIRTUAL_STRATEGY`; parity holds there
 * too (both sides move by zero actual).
 */
export function checkAttributionParity(
  transaction: LedgerTransactionInput,
): readonly LedgerRefusal[] {
  const actual = new Map<string, DecimalString>();
  const attributed = new Map<string, DecimalString>();
  for (const entry of transaction.entries) {
    if (entry.scope === "ACTUAL_ACCOUNT") {
      addInto(actual, entry.assetId, entry.amount);
      if (!attributed.has(entry.assetId)) {
        attributed.set(entry.assetId, ZERO);
      }
    } else if (entry.scope === "VIRTUAL_STRATEGY" || entry.scope === "UNATTRIBUTED") {
      addInto(attributed, entry.assetId, entry.amount);
      if (!actual.has(entry.assetId)) {
        actual.set(entry.assetId, ZERO);
      }
    }
  }

  const refusals: LedgerRefusal[] = [];
  for (const [assetId, actualDelta] of actual) {
    const attributedDelta = attributed.get(assetId) ?? ZERO;
    if (!isZeroDecimal(subDecimal(actualDelta, attributedDelta))) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_ATTRIBUTION_PARITY_BROKEN",
          `transaction ${transaction.ledgerTransactionId} moves asset ${assetId} by ` +
            `${actualDelta} in ACTUAL_ACCOUNT but attributes ${attributedDelta} ` +
            "(ADR-006 §2: attribution is a partition of the real balance)",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            assetId,
            actualDelta,
            attributedDelta,
          },
        ),
      );
    }
  }
  return refusals;
}

/**
 * Per-leg delta signature of a transaction, keyed by
 * `scope|accountRef|instanceId|assetId`. Used by the compensating-reversal
 * check: a reversal must negate the original exactly, leg for leg
 * (ADR-006 §5.2).
 */
export function legDeltas(
  transaction: LedgerTransactionInput,
): ReadonlyMap<string, DecimalString> {
  const deltas = new Map<string, DecimalString>();
  for (const entry of transaction.entries) {
    const key = `${entry.scope}|${entry.accountRef}|${entry.instanceId ?? ""}|${entry.assetId}`;
    addInto(deltas, key, entry.amount);
  }
  // Legs that net to zero contribute nothing to the signature.
  for (const [key, value] of deltas) {
    if (isZeroDecimal(value)) {
      deltas.delete(key);
    }
  }
  return deltas;
}

/** True when `candidate` exactly negates `original`, leg for leg. */
export function isExactNegation(
  original: ReadonlyMap<string, DecimalString>,
  candidate: ReadonlyMap<string, DecimalString>,
): boolean {
  if (original.size !== candidate.size) {
    return false;
  }
  for (const [key, value] of original) {
    const candidateValue = candidate.get(key);
    if (candidateValue === undefined || !isZeroDecimal(addDecimal(value, candidateValue))) {
      return false;
    }
  }
  return true;
}
