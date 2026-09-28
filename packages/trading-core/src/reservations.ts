/**
 * The reservation seam — `WP-220` composition-root obligation 9.
 *
 * > "**A reservation an accepted plan took must be honoured before the next
 * > evaluation's reduction is planned.** Every exit is a signed DELTA, so
 * > re-planning a protective exit on consecutive evaluations names the
 * > allocation again each time; §9.10's `RESERVE_BEFORE_SUBMISSION` rule is what
 * > turns the second and later ones into `PLAN_INVENTORY_INSUFFICIENT`
 * > refusals."
 *
 * > "A composition root that plans from stale inventory — or that drops
 * > reservations between evaluations — turns a repeated protective exit into a
 * > multiple of the position."
 *   — `packages/strategies/static-bracket/README.md`
 *
 * ## Where the containment actually lives, and what this module owes it
 *
 * The containment is `packages/execution-planner`'s: `selectDecreaseLeg` reads
 * `freeShares = held − reserved` and REFUSES rather than silently downsizing.
 * That mechanism only works if the `reserved` figure it is handed already
 * includes the reservations earlier accepted plans took. This module is the
 * book of those reservations, and `reservedFor` is what the loop passes into
 * `PlanningInputs.markets[].inventory[side].reserved`.
 *
 * So the rule this module enforces is exactly one sentence: **a reservation is
 * recorded the moment a plan is accepted, and it stays recorded until the
 * order it belongs to reaches a terminal state.** Not until the fill — a
 * partially filled order still holds the rest — and not until the next
 * evaluation, which is the failure mode the obligation names.
 *
 * ## Release is by ORDER, and by terminal state only
 *
 * A plan reserves; an order consumes. The release trigger is therefore the
 * order's terminal state (`FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`), because
 * those are the four states in which the venue can no longer take more of the
 * reserved inventory. Releasing on a fill would free inventory a
 * partially-filled resting order can still consume; releasing on a decision
 * boundary would be the "drops reservations between evaluations" failure
 * verbatim.
 *
 * ## Sides are separate, and pUSD is separate from shares
 *
 * `packages/execution-planner`'s `SideInventory` is `{ held, reserved }` per
 * `(marketId, side)` for SHARES; collateral is the allocator's
 * `availableCollateral`. Both are tracked here, keyed the same way, and never
 * summed across denominations (ADR-006 §7: "there is no implicit 'cash'
 * asset").
 */

import { addDecimal, compareDecimal, subDecimal } from "@polymarket-bot/decimal";

export type OutcomeSide = "YES" | "NO";

export interface ShareReservation {
  readonly reservationId: string;
  readonly executionPlanId: string;
  readonly plannedOrderId: string;
  readonly instanceId: string;
  readonly marketId: string;
  readonly side: OutcomeSide;
  /** Canonical non-negative decimal. Shares held back from planning. */
  readonly shares: string;
  /** Canonical non-negative decimal. Collateral held back from planning. */
  readonly collateral: string;
}

export interface ReservationMetrics {
  readonly open: number;
  readonly taken: number;
  readonly released: number;
  readonly reservedCollateral: string;
}

function key(marketId: string, side: OutcomeSide): string {
  return `${marketId}|${side}`;
}

/**
 * The trader's book of live reservations.
 *
 * Exact decimals throughout (§6 invariant 1): every sum is `addDecimal` /
 * `subDecimal`, never a JavaScript number.
 */
export class ReservationBook {
  /** reservationId -> reservation. Insertion-ordered for deterministic reads. */
  readonly #open = new Map<string, ShareReservation>();
  /** plannedOrderId -> reservationId, so a terminal order releases exactly its own. */
  readonly #byOrder = new Map<string, string>();
  #taken = 0;
  #released = 0;

  /**
   * Records the reservation an accepted plan took.
   *
   * Idempotent on `reservationId`: the planner mints one id per planned order,
   * and re-recording it (a redelivered acceptance) must not double-reserve.
   */
  take(reservation: ShareReservation): void {
    if (this.#open.has(reservation.reservationId)) return;
    this.#open.set(reservation.reservationId, reservation);
    this.#byOrder.set(reservation.plannedOrderId, reservation.reservationId);
    this.#taken += 1;
  }

  /**
   * Releases the reservation belonging to one venue order id.
   *
   * Called ONLY when the order reaches a terminal state. Answers whether
   * anything was released so the caller can tell a real release from a repeat.
   */
  releaseForOrder(plannedOrderId: string): boolean {
    const reservationId = this.#byOrder.get(plannedOrderId);
    if (reservationId === undefined) return false;
    this.#byOrder.delete(plannedOrderId);
    if (!this.#open.delete(reservationId)) return false;
    this.#released += 1;
    return true;
  }

  /** Reserved SHARES for one `(marketId, side)`, exactly summed. */
  reservedShares(marketId: string, side: OutcomeSide): string {
    let total = "0";
    const wanted = key(marketId, side);
    for (const reservation of this.#open.values()) {
      if (key(reservation.marketId, reservation.side) !== wanted) continue;
      total = addDecimal(total, reservation.shares);
    }
    return total;
  }

  /** Reserved COLLATERAL across every open reservation, exactly summed. */
  reservedCollateral(): string {
    let total = "0";
    for (const reservation of this.#open.values()) {
      total = addDecimal(total, reservation.collateral);
    }
    return total;
  }

  /**
   * Unreserved collateral: `available − reserved`, floored at zero.
   *
   * The floor is not a repair. It is refused-to-go-negative: a negative
   * available balance is not a smaller balance, it is a broken accounting
   * state, and handing the planner a negative number would let it plan against
   * a fiction. The caller checks `isOverReserved` when it needs to know.
   */
  unreservedCollateral(available: string): string {
    const remaining = subDecimal(available, this.reservedCollateral());
    return compareDecimal(remaining, "0") < 0 ? "0" : remaining;
  }

  /** True when reservations exceed the available balance — an accounting break. */
  isOverReserved(available: string): boolean {
    return compareDecimal(available, this.reservedCollateral()) < 0;
  }

  /** Every open reservation, in the order it was taken. */
  open(): readonly ShareReservation[] {
    return Object.freeze([...this.#open.values()]);
  }

  metrics(): ReservationMetrics {
    return Object.freeze({
      open: this.#open.size,
      taken: this.#taken,
      released: this.#released,
      reservedCollateral: this.reservedCollateral(),
    });
  }
}
