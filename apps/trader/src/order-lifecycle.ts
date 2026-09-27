/**
 * The per-order lifecycle's bounded pieces — `TRDR-4` (the trader loop's
 * unbounded state; the user's rulings R1 and R2 of 2026-09-26).
 *
 * `CoreLoop` used to keep every order it had ever placed, every fill chain,
 * every provenance record and every decision for the life of the process, and
 * it re-delivered EVERY order ever placed to its strategy on EVERY harvest.
 * Ruling R1 changed the delivery rule — a terminal order is delivered until
 * ONE delivery has been EVALUATED, and then it is RETIRED — and that is what
 * makes the per-order state prunable at all. This module holds the three
 * pieces the loop needs to prune without ever dropping silently:
 *
 * | Piece | What it bounds | What an eviction costs |
 * | --- | --- | --- |
 * | {@link OrderTombstones} | the memory of SETTLED orders (`orderId → instanceId`) | a late fill for an evicted order is classified "unknown" rather than "late after settlement" — it is STILL posted UNATTRIBUTED, halted and counted |
 * | {@link RetentionLog} | an audit log (`decisions()`, `traces()`, `orderProvenance()`) | the in-process accessor returns a shorter window; the durable store is unaffected |
 * | {@link settlementBlocker} | nothing — it is the (a)-(d) predicate, stated once | — |
 *
 * ## No silent drop, anywhere
 *
 * Every piece counts what it forgets and publishes the count on the health
 * surface (`seams.orders.tombstoneEvictions`, `seams.retention.*.evicted`),
 * the `FillDeduplicator` precedent: "a run that evicts is a run whose bound is
 * too small, and `evictions > 0` on the health surface says so".
 *
 * ## What this round does NOT bound, stated so it is not over-claimed
 *
 * `CoreLoop.#pnlRecords` (re-folded from zero on every fill by design) and the
 * in-memory `Ledger` (append-only, the §6 invariant 8 authority) still grow
 * without bound — they are the queued `LOOPMEM-FOLD` item. The injected
 * `SimulatedVenue` grew too when this was written (`LOOPMEM-SIM`); SIM-2
 * bounded it (live orders plus bounded, counted history; Tier-1 trades are
 * still unbounded, `SIM2-TIER1-TRADES`) and the loop no longer reads its
 * history. The trader process is therefore still NOT memory-bounded; what is
 * bounded is the loop's own per-order maps, its three audit logs and the
 * venue.
 */

import { compareDecimal, isCanonicalDecimalString } from "@polymarket-bot/decimal";

/**
 * Default retention bounds, argued from the `TRDR-4` scoping census's measured
 * entry sizes (Node v24, representative shapes).
 *
 * - **decisions — 100 000.** A `DecisionTrace` is about 170 B with shared
 *   strings and about 600 B with its own; the worst case at the bound is about
 *   60 MB. After R1 a run persists roughly one decision per evaluable event per
 *   instance plus one per fill and per order-state change, so 100 000 is hours
 *   of history at the scoping's illustrative 10 evaluable events/s. The
 *   largest fixture in the repository persists 12 decisions (both goldens);
 *   the bound is more than 8 000 times that.
 * - **traces — 50 000.** A `TraceLink` is about 1.5 KB; worst case about
 *   75 MB. One per FILL; the largest fixture books 3 fills.
 * - **provenance — 50 000.** A provenance record is about 1.9 KB; worst case
 *   about 95 MB. One per ACCEPTED ORDER; the largest fixture places 3 orders.
 * - **tombstones — 100 000.** One small `Map<string, string>` entry per
 *   SETTLED order (about 37 B plus two id strings); worst case well under
 *   20 MB. It matches `FillDeduplicator`'s `maximumRemembered`, the seam the
 *   tombstone is modelled on.
 *
 * Each is a `CoreLoopOptions.retention` override. A bound is a real limit and
 * is stated rather than hidden: `evicted > 0` on the health surface means the
 * window an in-process reader sees is shorter than the run.
 */
export const DEFAULT_RETENTION = Object.freeze({
  decisions: 100_000,
  traces: 50_000,
  provenance: 50_000,
  tombstones: 100_000,
});

/** The bounds a caller may override, each a positive safe integer. */
export interface RetentionBounds {
  readonly decisions?: number;
  readonly traces?: number;
  readonly provenance?: number;
  readonly tombstones?: number;
}

/**
 * Why a caller's retention bounds would be refused, or `undefined` when every
 * supplied bound is a positive safe integer. Lets a TOTAL caller
 * (`createPaperTrader`, which never throws) refuse by name instead of letting a
 * constructor throw.
 */
export function retentionBoundsProblem(bounds: RetentionBounds): string | undefined {
  for (const [name, value] of Object.entries(bounds)) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      return `retention.${name} must be a positive safe integer; received ${String(value)}`;
    }
  }
  return undefined;
}

function requireBound(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `${what} needs a positive integral bound; an unbounded log is the memory leak this ` +
        "seam exists to close, and a bound of zero is no log at all",
    );
  }
  return value;
}

/** `retained / maximumRetained / evicted` — one audit log's counters. */
export interface RetentionMetrics {
  /** Entries currently held (and returned by the accessor). */
  readonly retained: number;
  /** The bound. */
  readonly maximumRetained: number;
  /** Entries dropped, oldest first, because the bound was reached. Never silent. */
  readonly evicted: number;
}

/** The three audit logs' counters, on the health surface as `seams.retention`. */
export interface RetentionHealth {
  readonly decisions: RetentionMetrics;
  readonly traces: RetentionMetrics;
  readonly provenance: RetentionMetrics;
}

/**
 * A bounded, append-only log with oldest-first eviction.
 *
 * A ring buffer rather than `Array.prototype.shift`, so an append at the bound
 * is O(1) whatever the bound is. Deterministic and clock-free: its contents
 * depend only on the sequence of values appended.
 */
export class RetentionLog<T> {
  readonly maximumRetained: number;
  readonly #slots: (T | undefined)[] = [];
  /** Index of the OLDEST retained entry once the ring is full. */
  #head = 0;
  #evicted = 0;

  constructor(options: { readonly maximumRetained: number; readonly name: string }) {
    this.maximumRetained = requireBound(options.maximumRetained, `the ${options.name} log`);
  }

  append(entry: T): void {
    if (this.#slots.length < this.maximumRetained) {
      this.#slots.push(entry);
      return;
    }
    this.#slots[this.#head] = entry;
    this.#head = (this.#head + 1) % this.maximumRetained;
    this.#evicted += 1;
  }

  /** The retained window, oldest first, as a fresh array. */
  entries(): T[] {
    if (this.#head === 0) return this.#slots.slice() as T[];
    return [...this.#slots.slice(this.#head), ...this.#slots.slice(0, this.#head)] as T[];
  }

  get size(): number {
    return this.#slots.length;
  }

  metrics(): RetentionMetrics {
    return Object.freeze({
      retained: this.#slots.length,
      maximumRetained: this.maximumRetained,
      evicted: this.#evicted,
    });
  }
}

/** The tombstone map's counters. */
export interface OrderTombstoneMetrics {
  readonly tombstones: number;
  readonly maximumTombstones: number;
  readonly tombstoneEvictions: number;
}

/**
 * `orderId → instanceId` for SETTLED orders, bounded — the memory a late fill
 * is classified against.
 *
 * Built like `FillDeduplicator`: an insertion-ordered map, a hard bound,
 * oldest-first eviction, an `evictions` counter, and a constructor that
 * refuses a bound below 1. A tombstone NEVER attributes anything: a fill whose
 * owner lookup misses is posted UNATTRIBUTED whether or not a tombstone
 * matched; the tombstone only names the PROBABLE owner in the halt detail and
 * moves `lateFillsAfterSettlement`. Keyed by the VENUE's order id (for the
 * simulator, `SimulatedOrder.simulatedOrderId`), because that is what a fill
 * names.
 */
export class OrderTombstones {
  readonly maximumRemembered: number;
  readonly #byOrder = new Map<string, string>();
  #evictions = 0;

  constructor(options: { readonly maximumRemembered: number }) {
    this.maximumRemembered = requireBound(options.maximumRemembered, "the order tombstone map");
  }

  /** Records one settled order. A repeat for the same id refreshes nothing. */
  remember(venueOrderId: string, instanceId: string): void {
    if (this.#byOrder.has(venueOrderId)) return;
    if (this.#byOrder.size >= this.maximumRemembered) {
      const oldest = this.#byOrder.keys().next();
      if (!oldest.done) {
        this.#byOrder.delete(oldest.value);
        this.#evictions += 1;
      }
    }
    this.#byOrder.set(venueOrderId, instanceId);
  }

  /** The probable owner of a settled order, if it is still remembered. */
  probableOwner(venueOrderId: string): string | undefined {
    return this.#byOrder.get(venueOrderId);
  }

  get size(): number {
    return this.#byOrder.size;
  }

  metrics(): OrderTombstoneMetrics {
    return Object.freeze({
      tombstones: this.#byOrder.size,
      maximumTombstones: this.maximumRemembered,
      tombstoneEvictions: this.#evictions,
    });
  }
}

/**
 * `seams.orders` — the loop's per-order state, as counters an operator can read.
 */
export interface OrderLifecycleMetrics {
  /** Orders this process still OWNS (placed, not yet settled): `#orderOwners`' size. */
  readonly tracked: number;
  /** Orders settled and pruned since start. */
  readonly settled: number;
  readonly tombstones: number;
  readonly maximumTombstones: number;
  readonly tombstoneEvictions: number;
  /**
   * Fills whose owner lookup MISSED — an unknown order, a settled one, one
   * evicted from the tombstone map, or an owner the registry does not hold.
   * Each was posted UNATTRIBUTED and halted its market (§6 invariant 7).
   */
  readonly unownedFills: number;
  /** The subset of {@link unownedFills} whose order a tombstone still named. */
  readonly lateFillsAfterSettlement: number;
  /**
   * Retired terminal orders whose BOOKED fill shares differ from the venue's
   * `filledShares`. Counted once per order; such an order is never pruned.
   */
  readonly settleMismatches: number;
}

/**
 * The booked-shares counter's value once a quantity it was asked to add could
 * not be read as a canonical decimal. Deliberately NOT a decimal, so
 * {@link settlementBlocker} answers `BOOKED_SHARES_MISMATCH` for the order from
 * then on: it is never pruned, and the mismatch is counted.
 */
export const UNREADABLE_BOOKED_SHARES = "UNREADABLE";

/** Why an order may not be settled yet, or `undefined` when it may. */
export type SettlementBlocker =
  | "NOT_TERMINAL"
  | "BOOKED_SHARES_MISMATCH"
  | "NOT_RETIRED"
  | "CANCEL_PENDING";

/**
 * The settlement predicate — conditions (a) to (d), stated once.
 *
 * (a) the order is terminal, as observed at a harvest boundary (the caller's
 *     obligation: it passes the view the harvest read after booking every fill
 *     of that harvest);
 * (b) the fill shares BOOKED for it equal the venue view's `filledShares`,
 *     compared as exact decimals;
 * (c) it is retired under R1 (one terminal delivery was EVALUATED);
 * (d) no pending cancel names it.
 *
 * Checked in that order, so a caller reading the answer learns the FIRST
 * reason, and (b) is reported for a retired terminal order even while a
 * cancel is also pending — the mismatch is the fact an operator must see.
 *
 * TOTAL: never throws. `compareDecimal` refuses a non-canonical string, and a
 * venue-reported `filledShares` is not this process's to trust; a quantity
 * that is not a canonical decimal cannot PROVE the equality (b) asks for, so it
 * answers `BOOKED_SHARES_MISMATCH` — never pruned, and counted.
 */
export function settlementBlocker(input: {
  readonly terminal: boolean;
  readonly bookedShares: string;
  readonly filledShares: string;
  readonly retired: boolean;
  readonly cancelPending: boolean;
}): SettlementBlocker | undefined {
  if (!input.terminal) return "NOT_TERMINAL";
  if (
    !isCanonicalDecimalString(input.bookedShares) ||
    !isCanonicalDecimalString(input.filledShares) ||
    compareDecimal(input.bookedShares, input.filledShares) !== 0
  ) {
    return "BOOKED_SHARES_MISMATCH";
  }
  if (!input.retired) return "NOT_RETIRED";
  if (input.cancelPending) return "CANCEL_PENDING";
  return undefined;
}
