/**
 * Holding comparison (WP-290; handoff §9.17 step 5, §9.15, §6 invariant 7).
 *
 * For one asset, A is the authoritative holding (a `/v2/positions` size, or
 * the on-chain collateral balance), P the ledger's projected actual holding,
 * and d = A − P. The ledger books a fill when it is matched (ADR-006 §5: a
 * FAILED settlement is a compensating reversal, so the booking precedes the
 * final settlement), while the chain, and so A, shows it only once it
 * settles. So trades still in transit (MATCHED, MINED, RETRYING) may explain
 * a difference, and only in one of two ways, all or nothing:
 *
 * | d | Trades in transit in the asset | Verdict |
 * | --- | --- | --- |
 * | 0 | any | `MATCH` |
 * | −(their exact delta) | all on tracked orders, every delta exact | `MATCH_IN_TRANSIT` |
 * | anything else | some | `IN_TRANSIT_AMBIGUOUS` (held until they settle) |
 * | anything else | none | `UNEXPLAINED` (d is booked to UNATTRIBUTED once confirmed) |
 *
 * A leg's delta is exact only when its fee is exactly known: a fee rate is
 * not an amount (U-16), and the asset a fee is charged in must be named. A
 * leg on an order the OMS does not track is never booked in the projection,
 * so it makes its assets ambiguous while in transit (and is already an
 * UNATTRIBUTED trade).
 *
 * A FAILED trade never moves the chain, and the ledger books its fill until a
 * compensating reversal cancels it (ADR-006 §5, decision 2). So a FAILED leg
 * explains EXACTLY what the ledger still books of its fill (r4,
 * WP290-CX-R4-02: `remaining`, from `packages/ledger`'s
 * `remainingFillBookings`), never its nominal delta: a fully reversed fill
 * explains nothing, and a later unrelated movement equal to it is
 * UNEXPLAINED. The coordinator holds the account while any of it remains
 * (`SETTLEMENT_REVERSAL_OWED`), so a remaining booking never resumes trading.
 *
 * Pure decimal arithmetic. No I/O, no clock, no randomness.
 */

import { addDecimal, compareDecimal, isZeroDecimal, mulDecimal, negateDecimal, subDecimal, type DecimalString } from "@polymarket-bot/decimal";

import type { BookedAmount, VenueTradeLeg } from "./ports.js";

export interface PendingDelta {
  /** The summed delta the legs in transit would add to the holding once settled; meaningful only when `exact`. */
  readonly delta: DecimalString;
  readonly exact: boolean;
  /** A leg in transit on an order no tracked order owns. */
  readonly unattributed: boolean;
}

export type HoldingVerdict =
  | { readonly kind: "MATCH" }
  | { readonly kind: "MATCH_IN_TRANSIT" }
  | { readonly kind: "IN_TRANSIT_AMBIGUOUS"; readonly delta: DecimalString }
  | { readonly kind: "UNEXPLAINED"; readonly delta: DecimalString };

interface MutablePending {
  delta: DecimalString;
  exact: boolean;
  unattributed: boolean;
}

/**
 * The per-asset deltas of the account's legs still in transit. `attributed`
 * says whether the leg's order is tracked by the OMS (and so booked in the
 * projection at its match). `remaining` is what the ledger still books of the
 * FAILED fills (see the header): each amount is booked in the projection and
 * absent from the chain, exactly.
 */
export function pendingDeltas(
  legs: readonly { readonly leg: VenueTradeLeg; readonly attributed: boolean }[],
  collateralAssetId: string,
  remaining: readonly BookedAmount[] = [],
): ReadonlyMap<string, PendingDelta> {
  const out = new Map<string, MutablePending>();
  const touch = (assetId: string): MutablePending => {
    let entry = out.get(assetId);
    if (entry === undefined) {
      entry = { delta: "0", exact: true, unattributed: false };
      out.set(assetId, entry);
    }
    return entry;
  };
  for (const { leg, attributed } of legs) {
    const notional = mulDecimal(leg.shares, leg.price);
    const token = touch(leg.tokenId);
    const collateral = touch(collateralAssetId);
    token.delta = addDecimal(token.delta, leg.side === "BUY" ? leg.shares : negateDecimal(leg.shares));
    collateral.delta = addDecimal(collateral.delta, leg.side === "BUY" ? negateDecimal(notional) : notional);
    if (leg.feeAmount === null) {
      // The fee is unknown, and so is the asset it is charged in: neither holding can be explained exactly.
      token.exact = false;
      collateral.exact = false;
    } else if (compareDecimal(leg.feeAmount, "0") > 0) {
      const feeAsset = touch(leg.feeAssetId as string);
      feeAsset.delta = subDecimal(feeAsset.delta, leg.feeAmount);
    }
    if (!attributed) {
      token.unattributed = true;
      collateral.unattributed = true;
    }
  }
  for (const booked of remaining) {
    const asset = touch(booked.assetId);
    asset.delta = addDecimal(asset.delta, booked.amount);
  }
  const frozen = new Map<string, PendingDelta>();
  for (const [assetId, entry] of out) frozen.set(assetId, Object.freeze({ ...entry }));
  return frozen;
}

/** The verdict for one asset (see the header). */
export function compareHolding(authoritative: DecimalString, projected: DecimalString, pending: PendingDelta | undefined): HoldingVerdict {
  const delta = subDecimal(authoritative, projected);
  if (isZeroDecimal(delta)) return Object.freeze({ kind: "MATCH" });
  if (pending === undefined) return Object.freeze({ kind: "UNEXPLAINED", delta });
  if (pending.exact && !pending.unattributed && compareDecimal(delta, negateDecimal(pending.delta)) === 0) {
    return Object.freeze({ kind: "MATCH_IN_TRANSIT" });
  }
  return Object.freeze({ kind: "IN_TRANSIT_AMBIGUOUS", delta });
}
