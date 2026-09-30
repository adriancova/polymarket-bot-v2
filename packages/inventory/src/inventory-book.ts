/**
 * The inventory book — handoff §9.14 "Track actual and reserved pUSD", "Track
 * actual and reserved outcome tokens", "Prevent double reservation"; §10.5
 * `balance_projection` ("Actual and reserved balances") and
 * `inventory_reservations`; §10.7 "No negative available balance after
 * reservations"; ADR-006 §9.
 *
 * Per (account, asset) line:
 *
 *   actual     the last authoritative balance (seeded from the ledger's
 *              ACTUAL_ACCOUNT lines or a reconciliation read) plus the pending
 *              amounts this book has since settled;
 *   reserved   the sum of the ACTIVE reservations' unused remainders;
 *   pendingOut amounts consumed from a reservation (a fill at match, a wallet
 *              operation's debit) whose settlement is not yet confirmed;
 *   pendingIn  expected receipts not yet confirmed. NEVER available: an
 *              unconfirmed receipt is not inventory (§6 invariant 5);
 *   available  actual − reserved − pendingOut.
 *
 * WHAT THIS BOOK IS NOT. It is not the monetary source of truth: that is the
 * append-only ledger (ADR-006 §1; `packages/ledger`). The book DELEGATES actual
 * balances to it (seeded through {@link InventoryBook.seedFromLedgerBalances},
 * which takes the ledger's `BalanceLine` shape structurally) and owns only what
 * the ledger does not hold as state: reservations and in-flight amounts. It is
 * not the capital allocator either (`packages/capital-allocator`, §9.7), which
 * budgets per strategy instance; this book is the account-level physical
 * inventory whose `available` is the number the allocator's
 * `availableCollateral` input expects ("the pUSD committed NOWHERE",
 * `capital-allocator/src/state.ts`). Neither package is imported: a same-layer
 * edge needs a `dependency-direction.md` §2.1 row, which WP-300 does not own.
 *
 * DOUBLE RESERVATION IS IMPOSSIBLE by two rules checked on every reserve,
 * inside one synchronous call (no interleaving point exists between check and
 * apply):
 *   1. a reservation id is single-use for the book's lifetime, and one holder
 *      (an order, plan or wallet operation) holds at most ONE active
 *      reservation per (account, asset) — the WP-040 unique index
 *      `inventory_reservations_no_double_reservation (order_id, asset_id)
 *      where status = 'ACTIVE'`;
 *   2. a reservation is granted only if `available >= amount`, so the sum of
 *      reservations and in-flight debits never exceeds the actual balance.
 *
 * Partial fills: {@link InventoryBook.consume} moves only the filled part
 * from `reserved` to `pendingOut`; {@link InventoryBook.release} then frees
 * only the unused remainder (work plan WP-270 acceptance "Partial fills release
 * only unused reservations"; §16.2).
 */

import { addDecimal, compareDecimal, isNegativeDecimal, subDecimal, type DecimalString } from "@polymarket-bot/decimal";

import type { AssetKind, AssetRegistry } from "./assets.js";
import {
  compositeKey,
  ownData,
  ownNonEmptyString,
  ownNonNegativeAmount,
  ownPositiveAmount,
} from "./guards.js";
import { ok, refuse, type InventoryResult } from "./refusals.js";

export type ReservationStatus = "ACTIVE" | "RELEASED" | "CONSUMED";
export type PendingDirection = "OUT" | "IN";
export type PendingSettlement = "APPLIED" | "VOIDED";

export interface ReserveRequest {
  readonly reservationId: string;
  /** The order, plan or wallet operation the reservation is held for. */
  readonly holderRef: string;
  readonly accountRef: string;
  readonly assetId: string;
  readonly amount: DecimalString;
}

export interface ReservationView {
  readonly reservationId: string;
  readonly holderRef: string;
  readonly accountRef: string;
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly amount: DecimalString;
  readonly consumed: DecimalString;
  readonly released: DecimalString;
  readonly remaining: DecimalString;
  readonly status: ReservationStatus;
}

export interface PendingView {
  readonly pendingId: string;
  readonly direction: PendingDirection;
  readonly accountRef: string;
  readonly assetId: string;
  readonly amount: DecimalString;
  /** The reservation an OUT entry was consumed from; null for IN entries. */
  readonly reservationId: string | null;
}

export interface InventoryLineView {
  readonly accountRef: string;
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly actual: DecimalString;
  readonly reserved: DecimalString;
  readonly pendingOut: DecimalString;
  readonly pendingIn: DecimalString;
  readonly available: DecimalString;
  readonly blocked: LineBlock | null;
}

export interface ActualObservation {
  readonly accountRef: string;
  readonly assetId: string;
  readonly previous: DecimalString;
  readonly observed: DecimalString;
  readonly changed: boolean;
  /**
   * The observed balance no longer covers the line's reservations and
   * in-flight debits (available < 0). The book refuses new reservations on the
   * line until a later observation covers them; the caller owes
   * reconciliation and a halt of the affected market (§9.15, §9.17).
   */
  readonly overCommitted: boolean;
}

/**
 * Why a line refuses new reservations:
 * - `OVER_COMMITTED`: an authoritative observation left available < 0;
 * - `AWAITING_OBSERVATION`: a wallet operation's effect on the line is known
 *   to have happened but was not applied as deltas (it was resolved by
 *   reconciliation, or its deltas did not fit the book), so only a fresh
 *   authoritative balance read may say what the line holds.
 * Both clear only on the next {@link InventoryBook.observeActual}.
 */
export type LineBlock = "OVER_COMMITTED" | "AWAITING_OBSERVATION";

export interface InvariantViolation {
  readonly accountRef: string;
  readonly assetId: string;
  readonly rule: "RESERVED_SUM" | "PENDING_OUT_SUM" | "PENDING_IN_SUM" | "NEGATIVE_AVAILABLE" | "NEGATIVE_ACTUAL";
  readonly detail: string;
}

interface Line {
  readonly accountRef: string;
  readonly assetId: string;
  readonly assetKind: AssetKind;
  actual: DecimalString;
  reserved: DecimalString;
  pendingOut: DecimalString;
  pendingIn: DecimalString;
  blocked: LineBlock | null;
}

interface Reservation {
  readonly reservationId: string;
  readonly holderRef: string;
  readonly accountRef: string;
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly amount: DecimalString;
  consumed: DecimalString;
  released: DecimalString;
  status: ReservationStatus;
}

interface Pending {
  readonly pendingId: string;
  readonly direction: PendingDirection;
  readonly accountRef: string;
  readonly assetId: string;
  readonly amount: DecimalString;
  readonly reservationId: string | null;
}

const ZERO: DecimalString = "0";

export class InventoryBook {
  readonly #registry: AssetRegistry;
  readonly #lines = new Map<string, Line>();
  readonly #reservations = new Map<string, Reservation>();
  readonly #activeByHolder = new Map<string, string>();
  readonly #pending = new Map<string, Pending>();

  constructor(registry: AssetRegistry) {
    this.#registry = registry;
  }

  get registry(): AssetRegistry {
    return this.#registry;
  }

  // ---------------------------------------------------------------- actual --

  /**
   * Seed actual balances from ledger balance lines (the `packages/ledger`
   * `BalanceLine` shape: `scope`, `accountRef`, `assetId`, `assetKind`,
   * `balance`). Only `ACTUAL_ACCOUNT` lines are account inventory; a line of
   * any other scope (virtual attribution, clearing, fee, reward) is refused,
   * never silently skipped or summed. All-or-nothing.
   */
  seedFromLedgerBalances(lines: readonly unknown[]): InventoryResult<readonly ActualObservation[]> {
    if (!Array.isArray(lines)) return refuse("INVENTORY_INVALID_INPUT", "lines must be an array");
    const parsed: { accountRef: string; assetId: string; balance: DecimalString }[] = [];
    for (const [index, line] of lines.entries()) {
      if (ownData(line, "scope") !== "ACTUAL_ACCOUNT") {
        return refuse("INVENTORY_INVALID_INPUT", "only ACTUAL_ACCOUNT ledger lines are account inventory", {
          index,
        });
      }
      const accountRef = ownNonEmptyString(line, "accountRef");
      const assetId = ownNonEmptyString(line, "assetId");
      const balance = ownNonNegativeAmount(line, "balance");
      if (accountRef === undefined || assetId === undefined || balance === undefined) {
        return refuse("INVENTORY_INVALID_INPUT", "ledger line needs accountRef, assetId and a non-negative balance", {
          index,
        });
      }
      const registration = this.#registry.lookup(assetId);
      if (registration === undefined) {
        return refuse("INVENTORY_UNKNOWN_ASSET", "ledger line names an unregistered asset", { index, assetId });
      }
      if (ownData(line, "assetKind") !== registration.assetKind) {
        return refuse("INVENTORY_ASSET_ROLE_MISMATCH", "ledger line assetKind disagrees with the registry", {
          index,
          assetId,
        });
      }
      const blocked = this.#unresolvedPendingOn(accountRef, assetId);
      if (blocked !== undefined) return blocked;
      parsed.push({ accountRef, assetId, balance });
    }
    const results: ActualObservation[] = [];
    for (const line of parsed) results.push(this.#setActual(line.accountRef, line.assetId, line.balance));
    return ok(Object.freeze(results));
  }

  /**
   * Record an authoritative balance read (reconciliation, §9.17 step 4).
   * Refused while the line has unresolved pending amounts: the reconciler
   * settles or voids them first, so a receipt can never be counted twice
   * (once in the observation and once when its pending entry settles).
   */
  observeActual(input: {
    readonly accountRef: string;
    readonly assetId: string;
    readonly balance: DecimalString;
  }): InventoryResult<ActualObservation> {
    const accountRef = ownNonEmptyString(input, "accountRef");
    const assetId = ownNonEmptyString(input, "assetId");
    const balance = ownNonNegativeAmount(input, "balance");
    if (accountRef === undefined || assetId === undefined || balance === undefined) {
      return refuse("INVENTORY_INVALID_INPUT", "observation needs accountRef, assetId and a non-negative balance");
    }
    if (this.#registry.lookup(assetId) === undefined) {
      return refuse("INVENTORY_UNKNOWN_ASSET", "observation names an unregistered asset", { assetId });
    }
    const blocked = this.#unresolvedPendingOn(accountRef, assetId);
    if (blocked !== undefined) return blocked;
    return ok(this.#setActual(accountRef, assetId, balance));
  }

  // ---------------------------------------------------------- reservations --

  /** Reserve `amount` of an asset for one holder. See the header for the rules. */
  reserve(request: ReserveRequest): InventoryResult<ReservationView> {
    const reservationId = ownNonEmptyString(request, "reservationId");
    const holderRef = ownNonEmptyString(request, "holderRef");
    const accountRef = ownNonEmptyString(request, "accountRef");
    const assetId = ownNonEmptyString(request, "assetId");
    const amount = ownPositiveAmount(request, "amount");
    if (
      reservationId === undefined ||
      holderRef === undefined ||
      accountRef === undefined ||
      assetId === undefined ||
      amount === undefined
    ) {
      return refuse(
        "INVENTORY_INVALID_INPUT",
        "reservation needs reservationId, holderRef, accountRef, assetId and a positive canonical decimal amount",
      );
    }
    const registration = this.#registry.lookup(assetId);
    if (registration === undefined) {
      return refuse("INVENTORY_UNKNOWN_ASSET", "reservation names an unregistered asset", { assetId });
    }
    if (this.#reservations.has(reservationId)) {
      return refuse("INVENTORY_DUPLICATE_RESERVATION_ID", "reservation ids are single-use", { reservationId });
    }
    const holderKey = compositeKey(holderRef, accountRef, assetId);
    const held = this.#activeByHolder.get(holderKey);
    if (held !== undefined) {
      return refuse(
        "INVENTORY_DOUBLE_RESERVATION",
        "this holder already has an active reservation on this asset; a second one is a bug, not a top-up",
        { holderRef, accountRef, assetId, activeReservationId: held },
      );
    }
    const line = this.#line(accountRef, assetId, registration.assetKind);
    const available = availableOf(line);
    if (line.blocked !== null || compareDecimal(available, amount) < 0) {
      return refuse("INVENTORY_INSUFFICIENT_AVAILABLE", "not enough available inventory for this reservation", {
        accountRef,
        assetId,
        requested: amount,
        available,
        blocked: line.blocked,
      });
    }
    const reservation: Reservation = {
      reservationId,
      holderRef,
      accountRef,
      assetId,
      assetKind: registration.assetKind,
      amount,
      consumed: ZERO,
      released: ZERO,
      status: "ACTIVE",
    };
    line.reserved = addDecimal(line.reserved, amount);
    this.#reservations.set(reservationId, reservation);
    this.#activeByHolder.set(holderKey, reservationId);
    return ok(viewReservation(reservation));
  }

  /**
   * Consume part of an active reservation: the consumed amount leaves
   * `reserved` and becomes an in-flight debit (`pendingOut`, keyed by
   * `pendingId`) until {@link settlePending} applies or voids it. When the
   * remainder reaches zero the reservation is `CONSUMED`.
   */
  consume(input: {
    readonly reservationId: string;
    readonly amount: DecimalString;
    readonly pendingId: string;
  }): InventoryResult<ReservationView> {
    const reservationId = ownNonEmptyString(input, "reservationId");
    const amount = ownPositiveAmount(input, "amount");
    const pendingId = ownNonEmptyString(input, "pendingId");
    if (reservationId === undefined || amount === undefined || pendingId === undefined) {
      return refuse("INVENTORY_INVALID_INPUT", "consume needs reservationId, a positive amount and pendingId");
    }
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) {
      return refuse("INVENTORY_RESERVATION_NOT_FOUND", "no such reservation", { reservationId });
    }
    if (reservation.status !== "ACTIVE") {
      return refuse("INVENTORY_RESERVATION_NOT_ACTIVE", "reservation is not active", {
        reservationId,
        status: reservation.status,
      });
    }
    if (this.#pending.has(pendingId)) {
      return refuse("INVENTORY_DUPLICATE_PENDING_ID", "pending ids are single-use", { pendingId });
    }
    const remaining = remainingOf(reservation);
    if (compareDecimal(amount, remaining) > 0) {
      return refuse("INVENTORY_OVER_CONSUMPTION", "cannot consume more than the reservation's remainder", {
        reservationId,
        requested: amount,
        remaining,
      });
    }
    const line = this.#mustLine(reservation.accountRef, reservation.assetId);
    reservation.consumed = addDecimal(reservation.consumed, amount);
    line.reserved = subDecimal(line.reserved, amount);
    line.pendingOut = addDecimal(line.pendingOut, amount);
    this.#pending.set(pendingId, {
      pendingId,
      direction: "OUT",
      accountRef: reservation.accountRef,
      assetId: reservation.assetId,
      amount,
      reservationId,
    });
    if (compareDecimal(remainingOf(reservation), ZERO) === 0) this.#close(reservation, "CONSUMED");
    return ok(viewReservation(reservation));
  }

  /**
   * Release an active reservation's UNUSED remainder (a terminal order path,
   * a cancelled plan, a failed wallet operation). Consumed parts are not
   * touched: they are in-flight debits owned by their pending entries.
   */
  release(input: { readonly reservationId: string }): InventoryResult<ReservationView> {
    const reservationId = ownNonEmptyString(input, "reservationId");
    if (reservationId === undefined) return refuse("INVENTORY_INVALID_INPUT", "release needs reservationId");
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) {
      return refuse("INVENTORY_RESERVATION_NOT_FOUND", "no such reservation", { reservationId });
    }
    if (reservation.status !== "ACTIVE") {
      return refuse("INVENTORY_RESERVATION_NOT_ACTIVE", "reservation is not active", {
        reservationId,
        status: reservation.status,
      });
    }
    const remaining = remainingOf(reservation);
    const line = this.#mustLine(reservation.accountRef, reservation.assetId);
    line.reserved = subDecimal(line.reserved, remaining);
    reservation.released = addDecimal(reservation.released, remaining);
    this.#close(reservation, "RELEASED");
    return ok(viewReservation(reservation));
  }

  // --------------------------------------------------------------- pending --

  /** Record an expected, unconfirmed receipt. Never counted as available. */
  expectInflow(input: {
    readonly pendingId: string;
    readonly accountRef: string;
    readonly assetId: string;
    readonly amount: DecimalString;
  }): InventoryResult<PendingView> {
    const pendingId = ownNonEmptyString(input, "pendingId");
    const accountRef = ownNonEmptyString(input, "accountRef");
    const assetId = ownNonEmptyString(input, "assetId");
    const amount = ownPositiveAmount(input, "amount");
    if (pendingId === undefined || accountRef === undefined || assetId === undefined || amount === undefined) {
      return refuse("INVENTORY_INVALID_INPUT", "inflow needs pendingId, accountRef, assetId and a positive amount");
    }
    const registration = this.#registry.lookup(assetId);
    if (registration === undefined) {
      return refuse("INVENTORY_UNKNOWN_ASSET", "inflow names an unregistered asset", { assetId });
    }
    if (this.#pending.has(pendingId)) {
      return refuse("INVENTORY_DUPLICATE_PENDING_ID", "pending ids are single-use", { pendingId });
    }
    const line = this.#line(accountRef, assetId, registration.assetKind);
    line.pendingIn = addDecimal(line.pendingIn, amount);
    const entry: Pending = { pendingId, direction: "IN", accountRef, assetId, amount, reservationId: null };
    this.#pending.set(pendingId, entry);
    return ok(viewPending(entry));
  }

  /**
   * Resolve a pending entry from an authoritative settlement fact:
   * `APPLIED` (confirmed: an OUT debits actual, an IN credits it) or `VOIDED`
   * (the settlement failed: an OUT's amount becomes available again, an IN is
   * dropped). Nothing resolves a pending entry by elapsed time.
   */
  settlePending(input: {
    readonly pendingId: string;
    readonly settlement: PendingSettlement;
  }): InventoryResult<PendingView> {
    const pendingId = ownNonEmptyString(input, "pendingId");
    const settlement = ownData(input, "settlement");
    if (pendingId === undefined || (settlement !== "APPLIED" && settlement !== "VOIDED")) {
      return refuse("INVENTORY_INVALID_INPUT", "settlePending needs pendingId and settlement APPLIED|VOIDED");
    }
    const entry = this.#pending.get(pendingId);
    if (entry === undefined) return refuse("INVENTORY_PENDING_NOT_FOUND", "no such pending entry", { pendingId });
    const line = this.#mustLine(entry.accountRef, entry.assetId);
    if (entry.direction === "OUT") {
      if (settlement === "APPLIED" && compareDecimal(line.actual, entry.amount) < 0) {
        return refuse("INVENTORY_PENDING_EXCEEDS_ACTUAL", "the debit exceeds the actual balance; reconcile", {
          pendingId,
          actual: line.actual,
          amount: entry.amount,
        });
      }
      line.pendingOut = subDecimal(line.pendingOut, entry.amount);
      if (settlement === "APPLIED") line.actual = subDecimal(line.actual, entry.amount);
    } else {
      line.pendingIn = subDecimal(line.pendingIn, entry.amount);
      if (settlement === "APPLIED") line.actual = addDecimal(line.actual, entry.amount);
    }
    this.#pending.delete(pendingId);
    return ok(viewPending(entry));
  }

  /**
   * Block new reservations on a line until the next authoritative
   * observation (see {@link LineBlock}). Used by the wallet-operation manager;
   * never unblocks anything.
   */
  requireObservation(accountRef: string, assetId: string): InventoryResult<InventoryLineView> {
    const registration = this.#registry.lookup(assetId);
    if (registration === undefined) {
      return refuse("INVENTORY_UNKNOWN_ASSET", "line names an unregistered asset", { assetId });
    }
    const line = this.#line(accountRef, assetId, registration.assetKind);
    if (line.blocked === null) line.blocked = "AWAITING_OBSERVATION";
    return ok(viewLine(line));
  }

  // ----------------------------------------------------------------- views --

  line(accountRef: string, assetId: string): InventoryLineView | undefined {
    const line = this.#lines.get(compositeKey(accountRef, assetId));
    return line === undefined ? undefined : viewLine(line);
  }

  /** Available amount; `"0"` for a line the book has never seen. */
  available(accountRef: string, assetId: string): DecimalString {
    const line = this.#lines.get(compositeKey(accountRef, assetId));
    return line === undefined ? ZERO : availableOf(line);
  }

  reservation(reservationId: string): ReservationView | undefined {
    const reservation = this.#reservations.get(reservationId);
    return reservation === undefined ? undefined : viewReservation(reservation);
  }

  activeReservationFor(holderRef: string, accountRef: string, assetId: string): ReservationView | undefined {
    const id = this.#activeByHolder.get(compositeKey(holderRef, accountRef, assetId));
    return id === undefined ? undefined : this.reservation(id);
  }

  pending(pendingId: string): PendingView | undefined {
    const entry = this.#pending.get(pendingId);
    return entry === undefined ? undefined : viewPending(entry);
  }

  lines(): readonly InventoryLineView[] {
    return Object.freeze([...this.#lines.values()].map(viewLine));
  }

  reservations(): readonly ReservationView[] {
    return Object.freeze([...this.#reservations.values()].map(viewReservation));
  }

  /**
   * Recompute every line from the reservations and pending entries and report
   * any disagreement, plus any negative available/actual. Empty on a sound
   * book. The property tests assert this after every step.
   */
  checkInvariants(): readonly InvariantViolation[] {
    const violations: InvariantViolation[] = [];
    const reserved = new Map<string, DecimalString>();
    const out = new Map<string, DecimalString>();
    const inflow = new Map<string, DecimalString>();
    for (const r of this.#reservations.values()) {
      if (r.status !== "ACTIVE") continue;
      const key = compositeKey(r.accountRef, r.assetId);
      reserved.set(key, addDecimal(reserved.get(key) ?? ZERO, remainingOf(r)));
    }
    for (const p of this.#pending.values()) {
      const key = compositeKey(p.accountRef, p.assetId);
      const target = p.direction === "OUT" ? out : inflow;
      target.set(key, addDecimal(target.get(key) ?? ZERO, p.amount));
    }
    for (const [key, line] of this.#lines) {
      const where = { accountRef: line.accountRef, assetId: line.assetId };
      if (compareDecimal(reserved.get(key) ?? ZERO, line.reserved) !== 0) {
        violations.push({ ...where, rule: "RESERVED_SUM", detail: `${reserved.get(key) ?? ZERO} != ${line.reserved}` });
      }
      if (compareDecimal(out.get(key) ?? ZERO, line.pendingOut) !== 0) {
        violations.push({ ...where, rule: "PENDING_OUT_SUM", detail: `${out.get(key) ?? ZERO} != ${line.pendingOut}` });
      }
      if (compareDecimal(inflow.get(key) ?? ZERO, line.pendingIn) !== 0) {
        violations.push({ ...where, rule: "PENDING_IN_SUM", detail: `${inflow.get(key) ?? ZERO} != ${line.pendingIn}` });
      }
      if (isNegativeDecimal(line.actual)) {
        violations.push({ ...where, rule: "NEGATIVE_ACTUAL", detail: line.actual });
      }
      if (line.blocked === null && isNegativeDecimal(availableOf(line))) {
        violations.push({ ...where, rule: "NEGATIVE_AVAILABLE", detail: availableOf(line) });
      }
    }
    return Object.freeze(violations);
  }

  // -------------------------------------------------------------- internal --

  #line(accountRef: string, assetId: string, assetKind: AssetKind): Line {
    const key = compositeKey(accountRef, assetId);
    let line = this.#lines.get(key);
    if (line === undefined) {
      line = {
        accountRef,
        assetId,
        assetKind,
        actual: ZERO,
        reserved: ZERO,
        pendingOut: ZERO,
        pendingIn: ZERO,
        blocked: null,
      };
      this.#lines.set(key, line);
    }
    return line;
  }

  #mustLine(accountRef: string, assetId: string): Line {
    const line = this.#lines.get(compositeKey(accountRef, assetId));
    if (line === undefined) throw new Error("inventory book invariant: a referenced line is missing");
    return line;
  }

  #setActual(accountRef: string, assetId: string, balance: DecimalString): ActualObservation {
    const registration = this.#registry.lookup(assetId);
    if (registration === undefined) throw new Error("inventory book invariant: asset checked before setActual");
    const line = this.#line(accountRef, assetId, registration.assetKind);
    const previous = line.actual;
    line.actual = balance;
    line.blocked = isNegativeDecimal(availableOf(line)) ? "OVER_COMMITTED" : null;
    return Object.freeze({
      accountRef,
      assetId,
      previous,
      observed: balance,
      changed: compareDecimal(previous, balance) !== 0,
      overCommitted: line.blocked === "OVER_COMMITTED",
    });
  }

  #unresolvedPendingOn(accountRef: string, assetId: string): InventoryResult<never> | undefined {
    for (const entry of this.#pending.values()) {
      if (entry.accountRef === accountRef && entry.assetId === assetId) {
        return refuse(
          "INVENTORY_PENDING_UNRESOLVED",
          "the line has unresolved pending amounts; settle or void them before recording an authoritative balance",
          { accountRef, assetId, pendingId: entry.pendingId },
        );
      }
    }
    return undefined;
  }

  #close(reservation: Reservation, status: "RELEASED" | "CONSUMED"): void {
    reservation.status = status;
    this.#activeByHolder.delete(compositeKey(reservation.holderRef, reservation.accountRef, reservation.assetId));
  }
}

function remainingOf(reservation: Reservation): DecimalString {
  return subDecimal(subDecimal(reservation.amount, reservation.consumed), reservation.released);
}

function availableOf(line: Line): DecimalString {
  return subDecimal(subDecimal(line.actual, line.reserved), line.pendingOut);
}

function viewReservation(r: Reservation): ReservationView {
  return Object.freeze({
    reservationId: r.reservationId,
    holderRef: r.holderRef,
    accountRef: r.accountRef,
    assetId: r.assetId,
    assetKind: r.assetKind,
    amount: r.amount,
    consumed: r.consumed,
    released: r.released,
    remaining: remainingOf(r),
    status: r.status,
  });
}

function viewPending(p: Pending): PendingView {
  return Object.freeze({
    pendingId: p.pendingId,
    direction: p.direction,
    accountRef: p.accountRef,
    assetId: p.assetId,
    amount: p.amount,
    reservationId: p.reservationId,
  });
}

function viewLine(line: Line): InventoryLineView {
  return Object.freeze({
    accountRef: line.accountRef,
    assetId: line.assetId,
    assetKind: line.assetKind,
    actual: line.actual,
    reserved: line.reserved,
    pendingOut: line.pendingOut,
    pendingIn: line.pendingIn,
    available: availableOf(line),
    blocked: line.blocked,
  });
}
