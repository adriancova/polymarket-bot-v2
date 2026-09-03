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
 * KEY GRANULARITY (remediation round 1, 2026-09-02). Attribution parity is
 * keyed by `(accountRef, assetId)`, not by `assetId` alone. Netting an asset
 * across accounts lets one account's real, unattributed movement cancel
 * against another account's, so a transaction in which account A loses 5 with
 * no attribution at all and account B gains 5 passed a per-asset parity check
 * with both violations invisible. §9.15 is explicit — "Any actual balance
 * change lacking attribution is allocated to UNATTRIBUTED" — and the balance
 * that changed is an ACCOUNT's, which is why `ledger_entries.account_ref` is
 * NOT NULL for every scope (WP-040 obligation F20). One account's attribution
 * is not another account's, so the two are never summed.
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
 * The `(accountRef, assetId)` bucket an entry belongs to.
 *
 * JSON-encoded rather than delimiter-joined so no account reference containing
 * the delimiter can collide with another bucket (the `pnlCompositeKey`
 * precedent). Exported so the projection classifies unattributed activity
 * against exactly the buckets this check enforces — one key rule, one place.
 */
export function attributionBucketKey(accountRef: string, assetId: string): string {
  return JSON.stringify([accountRef, assetId]);
}

/** One `(accountRef, assetId)` bucket's actual and attributed movement. */
export interface AttributionBucket {
  readonly accountRef: string;
  readonly assetId: string;
  /** Net `ACTUAL_ACCOUNT` movement in this bucket. */
  readonly actualDelta: DecimalString;
  /** Net `VIRTUAL_STRATEGY` + `UNATTRIBUTED` movement in this bucket. */
  readonly attributedDelta: DecimalString;
}

/**
 * Actual and attributed movement per `(accountRef, assetId)`, in first-appearance
 * order. Only holding scopes participate: `EXTERNAL_CLEARING`, `FEE_EXPENSE`,
 * and `REWARD_INCOME` are counter-accounts, not holdings, and attribute nothing.
 */
export function attributionBuckets(
  transaction: LedgerTransactionInput,
): ReadonlyMap<string, AttributionBucket> {
  const actual = new Map<string, DecimalString>();
  const attributed = new Map<string, DecimalString>();
  const identity = new Map<string, { readonly accountRef: string; readonly assetId: string }>();
  for (const entry of transaction.entries) {
    if (
      entry.scope !== "ACTUAL_ACCOUNT" &&
      entry.scope !== "VIRTUAL_STRATEGY" &&
      entry.scope !== "UNATTRIBUTED"
    ) {
      continue;
    }
    const key = attributionBucketKey(entry.accountRef, entry.assetId);
    if (!identity.has(key)) {
      identity.set(key, { accountRef: entry.accountRef, assetId: entry.assetId });
      actual.set(key, ZERO);
      attributed.set(key, ZERO);
    }
    if (entry.scope === "ACTUAL_ACCOUNT") {
      addInto(actual, key, entry.amount);
    } else {
      addInto(attributed, key, entry.amount);
    }
  }

  const buckets = new Map<string, AttributionBucket>();
  for (const [key, { accountRef, assetId }] of identity) {
    buckets.set(key, {
      accountRef,
      assetId,
      actualDelta: actual.get(key) ?? ZERO,
      attributedDelta: attributed.get(key) ?? ZERO,
    });
  }
  return buckets;
}

/**
 * ADR-006 §2 attribution parity, per `(accountRef, assetId)`:
 *
 * Δ(ACTUAL_ACCOUNT) = Δ(VIRTUAL_STRATEGY) + Δ(UNATTRIBUTED)
 *
 * A transaction that moves an actual holding must state, in the same
 * transaction, whose it is — a strategy instance's, or explicitly
 * `UNATTRIBUTED` (§9.15: "Any actual balance change lacking attribution is
 * allocated to UNATTRIBUTED"). Re-attribution later is a new transaction
 * moving value from `UNATTRIBUTED` to `VIRTUAL_STRATEGY`; parity holds there
 * too (both sides move by zero actual).
 *
 * Keyed per ACCOUNT and asset, never per asset alone: see the key-granularity
 * note at the top of this module. A cross-account transfer therefore states
 * the attribution on BOTH sides — which account lost the value and which
 * gained it — instead of relying on the two movements cancelling in a global
 * sum. Every violation is reported, one refusal per bucket.
 */
export function checkAttributionParity(
  transaction: LedgerTransactionInput,
): readonly LedgerRefusal[] {
  const refusals: LedgerRefusal[] = [];
  for (const bucket of attributionBuckets(transaction).values()) {
    if (!isZeroDecimal(subDecimal(bucket.actualDelta, bucket.attributedDelta))) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_ATTRIBUTION_PARITY_BROKEN",
          `transaction ${transaction.ledgerTransactionId} moves asset ${bucket.assetId} by ` +
            `${bucket.actualDelta} in ACTUAL_ACCOUNT of ${bucket.accountRef} but attributes ` +
            `${bucket.attributedDelta} there (ADR-006 §2: attribution is a partition of the ` +
            "real balance, per account — one account's attribution is not another's)",
          {
            ledgerTransactionId: transaction.ledgerTransactionId,
            accountRef: bucket.accountRef,
            assetId: bucket.assetId,
            actualDelta: bucket.actualDelta,
            attributedDelta: bucket.attributedDelta,
          },
        ),
      );
    }
  }
  return refusals;
}

/**
 * The identity of one leg: scope, account, instance, asset.
 *
 * JSON-encoded, like every other composite key here, because a delimiter
 * inside an identifier would merge two legs into one — and a merged leg
 * signature can make a reversal that is NOT an exact negation look like one
 * (remediation round 1, 2026-09-02).
 */
export function legKey(entry: {
  readonly scope: string;
  readonly accountRef: string;
  readonly instanceId?: string | undefined;
  readonly assetId: string;
}): string {
  return JSON.stringify([entry.scope, entry.accountRef, entry.instanceId ?? null, entry.assetId]);
}

/**
 * Per-leg delta signature of a transaction, keyed by {@link legKey}. Used by
 * the compensating-reversal check: a reversal must negate the original
 * exactly, leg for leg (ADR-006 §5.2).
 */
export function legDeltas(
  transaction: LedgerTransactionInput,
): ReadonlyMap<string, DecimalString> {
  const deltas = new Map<string, DecimalString>();
  for (const entry of transaction.entries) {
    addInto(deltas, legKey(entry), entry.amount);
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
