/**
 * Reconciliation BY SIGNED IDENTITY (WP-290; handoff §9.11 step 8, §6
 * invariant 6; WP-270 follow_up 3).
 *
 * WHAT "BY SIGNED IDENTITY" CAN MEAN HERE. The expected order hash is STOPPED
 * (WP-270: the SDK computes none and no report documents one), and no
 * documented read exposes an order's salt. What the reads do expose of a
 * signed order is its economics: token, side, price and original size
 * (verified-2026-09-30 §W.4, E-14), all within the account's own credential
 * scope (E-16). So an unknown attempt is matched against the account's
 * UNCLAIMED venue orders (orders no OMS order tracks) on exactly those
 * fields, and the match is STRICT in both directions:
 *
 * | Candidates | Verdict |
 * | --- | --- |
 * | exactly one unclaimed order matches the attempt, and no other potential owner matches that order | `PRESENT` |
 * | more than one unclaimed order matches the attempt | `AMBIGUOUS` |
 * | one order matches, but another unresolved attempt (or one whose facts are unknown) could own it | `AMBIGUOUS` |
 * | none matches exactly, but an unclaimed order on the same token and side exists | `AMBIGUOUS` (it could be this attempt's in a representation the read does not show) |
 * | no unclaimed order on the same token and side exists | `NO_CANDIDATE` (ABSENT only once quiescent; the coordinator decides) |
 *
 * A POTENTIAL OWNER of a venue order is any attempt without a venue order id
 * that could have reached the venue: SENDING, SUBMISSION_UNKNOWN or
 * RECONCILING, including one held for the retransmission decision. Its facts
 * come from the requests the coordinator received for it; an attempt whose
 * facts are unknown could own ANY order (so it only ever adds ambiguity).
 *
 * KNOWN LIMIT (see the WP-290 handoff): an order that was placed and then
 * canceled with nothing matched is invisible to every documented read that
 * does not name its id (E-14: the open-orders list holds live orders only, and
 * a trade exists only for a match). "No candidate" then means "no live order
 * and no trade", which fixes the final size at 0 exactly, but does not prove
 * that the signed order never reached the venue. That matters only to the
 * 425 same-salt retransmission, whose ADR WP-270 left owed.
 *
 * Pure. No I/O, no clock, no randomness.
 */

import { compareDecimal, type DecimalString } from "@polymarket-bot/decimal";

import type { VenueOrderView } from "./ports.js";

/** What an attempt signed, as the venue reads can show it (from its reconciliation request). */
export interface AttemptFacts {
  readonly attemptId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly limitPrice: DecimalString;
  readonly originalShares: DecimalString;
}

export interface PotentialOwner {
  readonly attemptId: string;
  /** `null`: no request named its facts yet; it could own any order. */
  readonly facts: AttemptFacts | null;
}

export type IdentityVerdict =
  | { readonly kind: "PRESENT"; readonly order: VenueOrderView }
  | { readonly kind: "AMBIGUOUS"; readonly why: string; readonly candidates: readonly string[] }
  | { readonly kind: "NO_CANDIDATE" };

/** The read's view of an order equals the attempt's signed economics (decimals compared by value). */
export function matchesExactly(order: VenueOrderView, facts: AttemptFacts): boolean {
  return (
    order.tokenId === facts.tokenId &&
    order.side === facts.side &&
    compareDecimal(order.price, facts.limitPrice) === 0 &&
    compareDecimal(order.originalSize, facts.originalShares) === 0
  );
}

/** The order could be the owner's under some reading: the owner's facts are unknown, or token and side agree. */
export function couldBelong(order: VenueOrderView, owner: PotentialOwner): boolean {
  return owner.facts === null || (order.tokenId === owner.facts.tokenId && order.side === owner.facts.side);
}

/**
 * The verdict for one unknown attempt (`attempt.facts` known), against the
 * account's unclaimed venue orders and every potential owner (see the header).
 */
export function resolveBySignedIdentity(
  attempt: AttemptFacts,
  unclaimed: readonly VenueOrderView[],
  owners: readonly PotentialOwner[],
): IdentityVerdict {
  const self: PotentialOwner = { attemptId: attempt.attemptId, facts: attempt };
  const near = unclaimed.filter((order) => couldBelong(order, self));
  const exact = near.filter((order) => matchesExactly(order, attempt));
  if (exact.length > 1) {
    return Object.freeze({
      kind: "AMBIGUOUS",
      why: "more than one unclaimed venue order matches the attempt's signed economics",
      candidates: Object.freeze(exact.map((order) => order.venueOrderId)),
    });
  }
  const [only] = exact;
  if (only !== undefined) {
    const rivals = owners.filter(
      (owner) => owner.attemptId !== attempt.attemptId && (owner.facts === null || matchesExactly(only, owner.facts)),
    );
    if (rivals.length > 0) {
      return Object.freeze({
        kind: "AMBIGUOUS",
        why: "the matching venue order could also be another unresolved attempt's",
        candidates: Object.freeze([only.venueOrderId]),
      });
    }
    return Object.freeze({ kind: "PRESENT", order: only });
  }
  if (near.length > 0) {
    return Object.freeze({
      kind: "AMBIGUOUS",
      why: "an unclaimed venue order on the attempt's token and side does not match it exactly, and could still be it",
      candidates: Object.freeze(near.map((order) => order.venueOrderId)),
    });
  }
  return Object.freeze({ kind: "NO_CANDIDATE" });
}
