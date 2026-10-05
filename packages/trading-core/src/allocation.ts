/**
 * The §8.1 "allocate capital" step — `packages/capital-allocator`, wired.
 *
 * ```text
 * … persist DecisionResults
 *   → allocate capital        ← THIS MODULE (§9.7)
 *   → run risk checks         ← §9.8 check 14 consumes the verdict below
 *   → create execution plans
 *   → update OMS / submit eligible actions
 * ```
 *
 * ## Why this file exists at all (review round 1, HIGH-1)
 *
 * The reviewed tip parsed the operator's allocator caps through
 * `parseAllocatorCaps` and then **discarded them**, and handed the risk engine a
 * fabricated `allocation: { permitted: true }`. §9.8 check 14 is fail-closed by
 * construction — an absent verdict refuses every entry — so the fabrication was
 * the only thing satisfying it: caps of `"1"` everywhere still approved,
 * planned, submitted and filled a ~17 pUSD entry. A hardcoded `permitted` is not
 * a wiring shortcut; it is the check itself, deleted.
 *
 * Everything below is therefore WIRING plus one accounting derivation the
 * allocator needs and this process is the only holder of (see
 * {@link CostBasisBook}). No cap is applied here, no refusal is invented here
 * and no verdict is repaired here: {@link AllocatorGate.evaluate} answers with
 * `packages/capital-allocator`'s own verdict, refusal codes included, and the
 * loop hands it to `packages/risk` unaltered.
 *
 * ## The two reservation books, and why BOTH exist
 *
 * | Book | Owner | Answers | Consumed by |
 * | --- | --- | --- | --- |
 * | `ReservationBook` (`reservations.ts`) | this app | "how many SHARES and how much pUSD may the next PLAN still use" | `packages/execution-planner` (`WP-220` obligation 9) |
 * | the allocator's applied reservations (here) | `packages/capital-allocator` | "how much of every §9.7 CAP is already committed" | `packages/risk` §9.8 checks 14 and 15 |
 *
 * They are not the same book and neither can stand in for the other: the first
 * is per-`(market, side)` inventory for a planner that plans one market, the
 * second is the account-wide commitment table every cap compares against. They
 * are TAKEN at the same moment (before submission — §9.10 "reserve
 * collateral/inventory before submission"), both keyed on the PLANNED ORDER,
 * and both let go at a refused submission, for each planned order the venue
 * does not hold. At an order's TERMINAL state they part (`CAP-1`, below): the
 * planner's book releases there, as it always did; the allocator's book
 * releases there only the exact unused remainder, and keeps the capital of a
 * fill no position carries yet until that fill is booked. So the allocator
 * never holds LESS than the planner's book, and no state exists in which the
 * cap check has forgotten a commitment.
 *
 * ## Why the state carries NO open orders
 *
 * `AllocatorStateInput.openOrders` and an applied reservation would both
 * describe the SAME in-flight commitment, and §9.14 forbids double reservation.
 * This process holds an allocator commitment from before submission until the
 * order's capital is fully accounted for elsewhere, so the commitment IS the
 * in-flight capital and `openOrders` is deliberately empty.
 *
 * ## `CAP-1`: a commitment is CONVERTED, never released, as its fills are seen
 *
 * THE INVARIANT, held at ONE choke point ({@link AllocatorGate}'s
 * `#buildState`, which builds the account for every `evaluate` — the §9.8
 * check-14 verdict AND the check-15 snapshot — and every `applyForPlan`): the
 * capital the cap check counts for a strategy is at least the exact sum of its
 * open reservations plus its booked and unbooked filled exposure.
 *
 * `CAP-OVERSHOOT` was the gap. An order's reservation was released at its
 * FILLED view, and its fill became a position only at its harvest point
 * (ADR-024; ADR-026 for the carried path). An order an `onFill` decision
 * places and the venue fills at once is FILLED in the same close, but its fill
 * is read only at the next harvest point — so every evaluation in between saw
 * neither the reservation nor the position. A `CADENCE-1` review probe with a
 * per-strategy cap of 8 pUSD admitted three 10 @ 0.34 BUYs (10.20 pUSD).
 *
 * So each planned order's commitment ({@link Commitment}) is a small state
 * machine, and what it adds to the account is always derived from it
 * (`commitmentRequests`):
 *
 * 1. **Reserved** (`applyForPlan`): `limit × shares` (BUY), or `shares` of
 *    inventory (SELL) — exactly what the planner reserved.
 * 2. **Converted, as each fill is booked** (`observeFill`): the fill's shares
 *    leave the reserved part, and the fill's debit (`price × shares`, the
 *    capital the position's FIFO cost basis now carries) is no longer counted
 *    here — the position counts it. The part of the reservation the fill did
 *    NOT consume (`(limit − price) × shares`, a better price) stays reserved:
 *    before the final size is confirmed the order is counted at exactly its
 *    reservation, never more (no double count with the position) and never
 *    less. A partly sold SELL reserves only its unsold shares, so the account
 *    no longer refuses to rebuild while it rests.
 * 3. **Settled, once the final size is confirmed** (`settle`, at the order's
 *    terminal view): exactly the unused remainder is released —
 *    `reservation − Σ debits` (WP-270 decision 5's rule for the OMS). What
 *    stays is the capital of each fill the position does not carry yet,
 *    counted at that fill's own price when the loop has seen the fill, and at
 *    the order's limit when it has not (never less than its debit).
 * 4. **Closed** when every share of the final size is booked: the positions
 *    now carry all of it.
 *
 * Nothing here changes what a cap means: every cap still compares positions
 * plus in-flight commitments, at the same prices, against the same limits.
 * The change is only that a commitment leaves the in-flight half when, and to
 * the extent that, the position half has taken it over — not before.
 *
 * ## `CAP-1` r0: the same commitments feed §9.8 checks 16 and 17
 *
 * The window hid an unbooked fill from the risk engine's worst-case and
 * scenario checks too: they read booked positions and NON-terminal orders.
 * The orchestrator's ruling (2026-10-04) gives them a SEPARATE input,
 * `unbookedFills`, and it is derived HERE ({@link AllocatorGate.unbookedExposure})
 * from the same commitments and the same kept-fills derivation the cap check
 * counts — so the two cannot disagree about which fill is unbooked. It is never
 * a position and never an open order; `packages/risk` reads it in its lot
 * builder only, and never lets it lower a loss measure.
 *
 * ## `CAP-1` r1: the final size is judged where the evaluation can SEE it
 *
 * Two over-counts survived round 0. Both arose while an order was TERMINAL at
 * the venue and its commitment was not yet settled; settlement waits for a
 * loop site that acts on the terminal view, such as the next harvest's release
 * step or view delivery:
 *
 * - the cap check kept the order's WHOLE reservation, although the venue
 *   already showed its final size (`CAP1-ASTRA-R1-01`);
 * - the risk input priced its unbooked fills at the order's limit, although
 *   the loop had already been handed their prices (`CAP1-ASTRA-R1-03`).
 *
 * So:
 *
 * - **Every question takes the caller's VIEW of the venue** ({@link OrderViewOf}:
 *   one order by its planned id, O(1), moving nothing). `#buildState` judges
 *   an unsettled commitment whose order the view shows TERMINAL at that final
 *   size, exactly as `settle` will, without applying it (`finalSharesNow`).
 *   The exact unused remainder is therefore released at the first evaluation
 *   that can see the final size, not at the next harvest.
 * - **A commitment records the fills the loop has SEEN** (`observeVenueFill`).
 *   The venue hands the loop their prices in its placement answer and its
 *   trade answer. That is evidence of price only: it converts nothing.
 *   `keptFills` prices an unbooked fill at its own price when it was seen, and
 *   at the order's limit only when no answer the loop received carried it
 *   (never less than its debit; r2, below: nor any page it read). No fill
 *   page is read for it. The loop's settle-time page read of round 0 is gone
 *   too: it was a second `fillsSince` in one event, and SIM-2 allows one
 *   cursor read per harvest.
 * - **Risk's open orders present a working order at its UNFILLED remainder**
 *   (`CAP1-ASTRA-R1-02`). Its booked fills are the position's, and its
 *   filled-but-unbooked shares are stated by {@link AllocatorGate.unbookedExposure},
 *   so no share of it is counted twice.
 *
 * ## `CAP-1` r2: every page the loop READ is evidence too
 *
 * `CAP1-ASTRA-R2-01`: the carried harvest reads the venue's fill page, books
 * only its pass's own fills, and used to discard the others' prices. A
 * DELAYED disposition's fill on that page was then held at its order's limit
 * by every later evaluation until its ADR-024 harvest point booked it, and a
 * booked control admitted what the pending account refused. The loop now
 * records every fill of every page it reads as SEEN (`loop.ts`,
 * `#readFills`), with no read added and nothing booked, converted or moved.
 *
 * What is still held at the limit is a fill that NO page or answer the loop
 * has received carries yet: a DELAYED disposition applied by a venue door
 * whose answer carries no fills (`observe()`, or a cancel's own sweep), and
 * judged before the next cursor read. This process cannot have its price
 * without a read that SIM-2's budget does not provide, or an answer that
 * `packages/simulation` does not give. It therefore stays at the limit, never
 * below its debit: the r2 STOPPED item, which awaits the orchestrator's ruling.
 */

import {
  addDecimal,
  compareDecimal,
  isCanonicalDecimalString,
  mulDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";
import {
  EXPOSURE_ZERO,
  applyReservation,
  createAllocatorState,
  evaluateReservation,
  exposureSnapshotCovering,
  shadowExposureSnapshot,
  type AllocatorCaps,
  type AllocatorState,
  type CapitalRefusal,
  type ExposureEntry,
  type ExposureSnapshot,
  type ReservationRequest,
} from "@polymarket-bot/capital-allocator";
import type { Intent } from "@polymarket-bot/domain";
import type { LedgerProjection } from "@polymarket-bot/ledger";
import type { SimulatedFill } from "@polymarket-bot/simulation";

import type { MarketConfig } from "./config.js";
import { TRADER_RUN_MODE } from "./safety.js";

/** The §9.8 check-14 verdict, in the shape `packages/risk` reads structurally. */
export interface AllocationVerdict {
  readonly permitted: boolean;
  readonly refusals: readonly { readonly code: string; readonly message: string }[];
}

/** What {@link AllocatorGate.evaluate} answers for one intent. */
export interface AllocationOutcome {
  /**
   * The allocator's verdict, or `undefined` when the intent commits NOTHING —
   * a `CANCEL`, whose §9.8 disposition is `CANCEL` and which check 14 does not
   * require a verdict for. It is `undefined` for an intent that WOULD commit
   * capital only when no leg of it could be priced, and check 14 then refuses
   * the entry, which is the fail-closed direction.
   */
  readonly verdict: AllocationVerdict | undefined;
  /** The §9.8 check-15 snapshot, covering every scope this evaluation queries. */
  readonly exposures: ExposureSnapshot;
  /** The requests the verdict was computed over, in leg order. */
  readonly requests: readonly ReservationRequest[];
}

export interface AllocatorMetrics {
  /**
   * Allocator commitments currently held (§9.10, pre-submission): applied and
   * not yet CLOSED — the order is working, or it is terminal with a fill no
   * position carries yet (`CAP-1`).
   */
  readonly open: number;
  readonly applied: number;
  /** Commitments CLOSED: released whole (never placed), or settled and fully booked (`CAP-1`). */
  readonly released: number;
  /**
   * §9.7 "reserved pUSD": the pUSD the held BUY commitments add to the account
   * beyond its booked positions — the reserved remainder of each working
   * order, and each terminal order's not-yet-booked fills — exactly summed.
   * `CAP-1` r1: read AS SETTLED (the health surface asks no venue view). An
   * order whose terminal view no loop site has settled yet shows its
   * reservation here; every cap check judges it at its view.
   */
  readonly reservedCollateral: string;
  /** Allocator refusals seen, by the allocator's OWN code. */
  readonly refusalsByCode: Readonly<Record<string, number>>;
}

/** The account state, or the allocator's refusals to describe it. */
type BuiltState =
  | { readonly ok: true; readonly state: AllocatorState }
  | { readonly ok: false; readonly refusals: readonly CapitalRefusal[] };

/** One fill a commitment knows of: its venue id, exact price and shares. */
export type CommitmentFill = Pick<SimulatedFill, "simulatedFillId" | "price" | "shares">;

/**
 * `CAP-1`: one planned order's capital commitment — see the module header,
 * "a commitment is CONVERTED, never released, as its fills are seen".
 *
 * Mutable, and private to {@link AllocatorGate}: nothing outside it can move a
 * commitment, and what a commitment adds to the account is DERIVED from these
 * fields at every question (`commitmentRequests`), never cached beside them.
 */
interface Commitment {
  /** The request applied before submission: `limit × shares` (BUY), or `shares` of inventory (SELL). */
  readonly request: ReservationRequest;
  /** Shares of this order's fills BOOKED into the owning instance's position, exactly summed. */
  bookedShares: string;
  /** The venue ids of those booked fills: a fill is converted once, and never counted again as unbooked. */
  readonly bookedFillIds: Set<string>;
  /**
   * BUY: the booked fills, as `fill price -> shares`, in booking order. Each
   * leaves `(limit − price) × shares` of the reservation unconsumed, and that
   * stays reserved until the final size is confirmed (WP-270 decision 5).
   */
  readonly bookedByPrice: Map<string, string>;
  /**
   * Fills of this order the loop booked UNATTRIBUTED (`TRDR-4`: an order no
   * instance owns — a refused plan's held orphan, a lost answer's order), as
   * `fill id -> fill`. No position will ever carry them, so their capital
   * stays in this commitment, against the instance that reserved it.
   */
  readonly unattributed: Map<string, CommitmentFill>;
  /**
   * `CAP-1` r1: every fill of this order the loop has SEEN at the venue, as
   * `fill id -> fill`, booked or not. The sources are the placement answer,
   * the trade answer and (r2) every fill page the loop reads
   * (`observeVenueFill`), and any fill page `settle` is handed. It is
   * evidence of PRICE only: it converts nothing and releases nothing, and
   * `keptFills` skips a booked or unattributed id.
   */
  readonly seen: Map<string, CommitmentFill>;
  /**
   * The CONFIRMED final size, once `settle` recorded it from the order's
   * terminal view (or `release` from a venue that never held it), or
   * `undefined` while it is not settled. An unsettled commitment whose order
   * a caller's view shows terminal is judged at that view's size meanwhile
   * (`finalSharesNow`).
   */
  finalShares: string | undefined;
}

/**
 * `CAP-1` r1: what the venue shows of one planned order NOW, as the caller
 * read it (one O(1) lookup; nothing moves).
 */
export interface OrderView {
  /**
   * The trader's ONE terminal predicate. The order can fill no more, so
   * `filledShares` is its FINAL size.
   */
  readonly terminal: boolean;
  readonly filledShares: string;
}

/** `CAP-1` r1: the caller's view of a planned order, or `undefined` when the venue shows none. */
export type OrderViewOf = (plannedOrderId: string) => OrderView | undefined;

/** `value > 0`, exactly. */
function positive(value: string): boolean {
  return compareDecimal(value, "0") > 0;
}

/**
 * `CAP-1`: what one commitment adds to the account NOW, as allocator requests,
 * given its final size NOW (`finalSharesNow`). Each request is a real
 * `(price, shares)` commitment, re-applied by `#buildState`:
 *
 * - **SELL**: its shares not yet booked as sold. That is `shares − booked`
 *   while it can still fill, and `final size − booked` once its final size is
 *   known (a sold share the position still shows stays reserved until its sale
 *   is booked). Cost `"0"`, as ever.
 * - **BUY, while it can still fill**: the unfilled-or-unbooked shares at its
 *   limit, plus, per booked fill price below the limit, the unconsumed
 *   `(limit − price) × shares`. Together that is exactly `reservation − Σ
 *   booked debits`; the position carries the debits.
 * - **BUY, once its final size is known**: only the fills no position carries
 *   yet (`keptFills`). The unused remainder is gone: that is the release.
 *
 * Every derived id extends the planned order's own reservation id, so it is
 * unique in the state and names the order it belongs to.
 */
function commitmentRequests(commitment: Commitment, finalShares: string | undefined): ReservationRequest[] {
  const { request, bookedShares } = commitment;
  const out: ReservationRequest[] = [];
  if (request.action === "SELL") {
    const reserved = subDecimal(finalShares ?? request.shares, bookedShares);
    if (positive(reserved)) out.push({ ...request, shares: reserved });
    return out;
  }
  if (finalShares === undefined) {
    const open = subDecimal(request.shares, bookedShares);
    if (positive(open)) out.push({ ...request, shares: open });
    for (const [price, shares] of commitment.bookedByPrice) {
      const unused = subDecimal(request.price, price);
      if (!positive(unused)) continue;
      out.push({ ...request, reservationId: `${request.reservationId}/unused@${price}`, price: unused, shares });
    }
    return out;
  }
  for (const part of keptFills(commitment, finalShares)) {
    if (part.seen) {
      if (!positive(part.price)) continue;
      out.push({ ...request, reservationId: `${request.reservationId}/filled@${part.price}`, price: part.price, shares: part.shares });
    } else {
      out.push({ ...request, reservationId: `${request.reservationId}/filled@limit`, shares: part.shares });
    }
  }
  return out;
}

/**
 * `CAP-1` r1: the final size a commitment is judged at NOW. That is its
 * confirmed size once settled, or, while it is not, the size of its order in
 * the caller's `view` when that view shows it TERMINAL (`CAP1-ASTRA-R1-01`).
 * It is `undefined` while the order can still fill, or when its size is not an
 * exact decimal: such a size cannot be shown to be final, so the commitment
 * keeps its whole reservation (fail closed). Applies nothing; `settle`
 * records the same size at its own site.
 */
function finalSharesNow(commitment: Commitment, view: OrderView | undefined): string | undefined {
  if (commitment.finalShares !== undefined) return commitment.finalShares;
  if (view === undefined || !view.terminal || !isCanonicalDecimalString(view.filledShares)) return undefined;
  return view.filledShares;
}

/**
 * `CAP-1`: the fills a BUY commitment KEEPS when `filledShares` of it are
 * filled: the capital no position carries yet.
 *
 * - **Seen fills** (`seen: true`): each fill the loop has seen
 *   (`Commitment.seen`) that no position carries, plus each fill booked
 *   UNATTRIBUTED, at its own price, grouped by price in the order seen.
 * - **Unseen shares** (`seen: false`): every share of `filledShares` that is
 *   neither booked nor seen, at the order's LIMIT, which is never less than its
 *   debit. Since `CAP-1` r1 that is only a fill no venue answer the loop
 *   received has carried yet, and since r2 no fill page the loop read has
 *   carried either (the module header's r2 section).
 *
 * ONE derivation, two readers, so they cannot disagree: the allocator's
 * account (`commitmentRequests`, once the final size is known) and §9.8
 * checks 16 and 17's filled-but-unbooked input
 * ({@link AllocatorGate.unbookedExposure}).
 */
function keptFills(
  commitment: Commitment,
  filledShares: string,
): { readonly price: string; readonly shares: string; readonly seen: boolean }[] {
  const byPrice = new Map<string, string>();
  let seen = "0";
  const keep = (fill: CommitmentFill): void => {
    byPrice.set(fill.price, addDecimal(byPrice.get(fill.price) ?? "0", fill.shares));
    seen = addDecimal(seen, fill.shares);
  };
  for (const fill of commitment.seen.values()) {
    // A fill a position already carries (booked) is counted there, and one no
    // position ever will (unattributed) is counted below: never twice.
    if (commitment.bookedFillIds.has(fill.simulatedFillId)) continue;
    if (commitment.unattributed.has(fill.simulatedFillId)) continue;
    keep(fill);
  }
  for (const fill of commitment.unattributed.values()) keep(fill);
  const parts: { readonly price: string; readonly shares: string; readonly seen: boolean }[] = [];
  for (const [price, shares] of byPrice) parts.push({ price, shares, seen: true });
  const unseen = subDecimal(subDecimal(filledShares, commitment.bookedShares), seen);
  if (positive(unseen)) parts.push({ price: commitment.request.price, shares: unseen, seen: false });
  return parts;
}

/**
 * `CAP-1` r1: records `fill` as SEEN by `commitment`, when its quantities are
 * exact. A fill that cannot be read exactly is not evidence of a price: the
 * share it filled stays at the order's limit (fail closed).
 */
function see(commitment: Commitment, fill: CommitmentFill): void {
  if (!isCanonicalDecimalString(fill.price) || !isCanonicalDecimalString(fill.shares)) return;
  commitment.seen.set(fill.simulatedFillId, {
    simulatedFillId: fill.simulatedFillId,
    price: fill.price,
    shares: fill.shares,
  });
}

/**
 * `CAP-1`: one BUY commitment's part of §9.8 checks 16 and 17's
 * filled-but-unbooked input, as `(price, shares)` parts; see
 * {@link AllocatorGate.unbookedExposure} for each case.
 */
function unbookedParts(
  plannedOrderId: string,
  commitment: Commitment,
  presentedOpen: ReadonlyMap<string, string>,
  viewOf: OrderViewOf,
): readonly { readonly price: string; readonly shares: string }[] {
  const { request } = commitment;
  if (commitment.finalShares !== undefined) return keptFills(commitment, commitment.finalShares);
  // Presented as open at `requested − filled`: its filled shares are here.
  const presented = presentedOpen.get(plannedOrderId);
  if (presented !== undefined && isCanonicalDecimalString(presented)) return keptFills(commitment, presented);
  const view = viewOf(plannedOrderId);
  if (view === undefined || !isCanonicalDecimalString(view.filledShares)) {
    // The venue shows no order (or no exact size): the whole unconverted
    // reservation, at the limit, exactly as the allocator counts it.
    return [{ price: request.price, shares: subDecimal(request.shares, commitment.bookedShares) }];
  }
  const kept = keptFills(commitment, view.filledShares);
  if (view.terminal) return kept;
  // Working and presented by no open order: its unfilled shares too.
  return [...kept, { price: request.price, shares: subDecimal(request.shares, view.filledShares) }];
}

/**
 * `CAP-1` (orchestrator ruling, 2026-10-04): one market token's
 * filled-but-unbooked BUY exposure of a strategy, in the shape
 * `packages/risk` reads as `unbookedFills` (§9.8 checks 16 and 17 only).
 */
export interface UnbookedExposure {
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly shares: string;
  /** Exact `Σ price × shares`: each seen fill at its own price, each unseen share at the limit. */
  readonly debit: string;
}

/**
 * An order's terminal view, as `settle` reads it: its final size, and the
 * fills of it a caller read past its fill cursor, or `undefined` when no page
 * was read. `CAP-1` r1: any such fills are recorded as SEEN, adding to what the
 * commitment already saw and never replacing it. The trader reads no page
 * here (SIM-2), and passes `undefined`: since r2 every page it reads is
 * already recorded as seen at the read (`loop.ts`, `#readFills`), and this
 * parameter is reached from the unit pins only (`CAP1-R2-FABLE-04`).
 */
export interface TerminalOrderView {
  readonly filledShares: string;
  readonly unbookedFills: readonly CommitmentFill[] | undefined;
}

interface Lot {
  readonly shares: string;
  readonly price: string;
}

/**
 * FIFO cost basis per `(instanceId, marketId, side)`, folded from the fills
 * this process has already booked.
 *
 * WHY IT IS HERE. §9.7's exposure table counts a position at its `costBasis` —
 * "capital already spent" — and neither `packages/ledger`'s projection (which
 * carries balances, not lots) nor `packages/capital-allocator` (which is pure
 * and sees no fills) holds it. Passing `"0"`, as the reviewed tip did for the
 * risk portfolio, would make every held position consume ZERO of every cap:
 * the allocator's central rule — "open orders and positions BOTH consume
 * limits" — defeated on the position half.
 *
 * EXACT, AND WITHOUT A DIVISION. Lots are consumed oldest-first and the cost a
 * sale removes is `lotPrice × sharesTaken`, summed over the lots it touches.
 * There is no average, so there is no rounding policy and no §6 invariant 1
 * exposure. FIFO is a STATED policy, not an inferred one.
 */
export class CostBasisBook {
  readonly #lots = new Map<string, Lot[]>();

  static key(instanceId: string, marketId: string, side: "YES" | "NO"): string {
    return `${instanceId}|${marketId}|${side}`;
  }

  /** Folds one booked fill. BUY opens a lot; SELL consumes the oldest first. */
  observe(
    instanceId: string,
    fill: Pick<SimulatedFill, "marketId" | "side" | "action" | "price" | "shares">,
  ): void {
    const key = CostBasisBook.key(instanceId, fill.marketId, fill.side);
    const lots = this.#lots.get(key) ?? [];
    if (fill.action === "BUY") {
      lots.push({ shares: fill.shares, price: fill.price });
      this.#lots.set(key, lots);
      return;
    }
    let remaining = fill.shares;
    while (compareDecimal(remaining, "0") > 0 && lots.length > 0) {
      const lot = lots[0];
      if (lot === undefined) break;
      if (compareDecimal(lot.shares, remaining) <= 0) {
        remaining = subDecimal(remaining, lot.shares);
        lots.shift();
        continue;
      }
      lots[0] = { shares: subDecimal(lot.shares, remaining), price: lot.price };
      remaining = "0";
    }
    // A sale larger than the lots this book has seen leaves the book EMPTY
    // rather than negative: `packages/ledger` is the authority on shares, this
    // book answers only what the REMAINING ones cost, and a negative cost basis
    // is not a smaller one — it is a broken derivation.
    this.#lots.set(key, lots);
  }

  /** Exact remaining cost basis for one key. */
  costBasis(instanceId: string, marketId: string, side: "YES" | "NO"): string {
    let total = "0";
    for (const lot of this.#lots.get(CostBasisBook.key(instanceId, marketId, side)) ?? []) {
      total = addDecimal(total, mulDecimal(lot.price, lot.shares));
    }
    return total;
  }

  /** Σ of every key's cost basis — the capital this account has spent. */
  total(): string {
    let total = "0";
    for (const lots of this.#lots.values()) {
      for (const lot of lots) total = addDecimal(total, mulDecimal(lot.price, lot.shares));
    }
    return total;
  }
}

/** The §9.7 scope a market states, as the allocator's requests carry it. */
export interface AllocationMarket {
  readonly marketId: string;
  readonly seriesKey: string;
  readonly underlyingKey: string;
  readonly resolutionWindowKey: string;
}

/** The scope keys one evaluation will query. */
export interface AllocationCoverage {
  readonly strategyInstanceIds: readonly string[];
  readonly marketIds: readonly string[];
  readonly seriesKeys: readonly string[];
  readonly underlyingKeys: readonly string[];
  readonly resolutionWindowKeys: readonly string[];
}

/** One BUY or SELL leg of an intent, bounded by the intent's own price. */
export interface IntentLeg {
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
}

function scopeOf(market: AllocationMarket): {
  readonly seriesKey: string;
  readonly underlyingKey: string;
  readonly resolutionWindowKey: string;
} {
  return {
    seriesKey: market.seriesKey,
    underlyingKey: market.underlyingKey,
    resolutionWindowKey: market.resolutionWindowKey,
  };
}

/**
 * The composition root's handle on `packages/capital-allocator`.
 *
 * It holds exactly two things of its own: the operator's parsed caps and the
 * commitments this process has APPLIED and not yet closed (`CAP-1`: each one
 * converted as its fills are booked — see the module header). Everything else
 * is rebuilt from the loop's own authoritative state on every question, so the
 * allocator can never answer from a stale copy of the account.
 */
export class AllocatorGate {
  readonly #caps: AllocatorCaps;
  readonly #markets: ReadonlyMap<string, AllocationMarket>;
  /**
   * `assetId -> (marketId, side)`, inverted from the loop's own token map at
   * construction, and — `ROLLOVER-1` r1 (R1-01) — extended by
   * {@link registerMarketAssets} for every series window admitted later.
   */
  readonly #assets = new Map<string, { readonly marketId: string; readonly side: "YES" | "NO" }>();
  readonly #costBasis = new CostBasisBook();
  /**
   * `plannedOrderId -> its commitment`, keyed exactly as `ReservationBook` is.
   * Insertion-ordered, so the account `#buildState` builds is deterministic.
   */
  readonly #commitments = new Map<string, Commitment>();
  readonly #refusalsByCode = new Map<string, number>();
  #appliedCount = 0;
  #releasedCount = 0;

  constructor(input: {
    readonly caps: AllocatorCaps;
    readonly markets: ReadonlyMap<string, AllocationMarket>;
    /** The loop's `marketId|SIDE -> assetId` map, inverted here. */
    readonly tokenAssetIds: ReadonlyMap<string, string>;
  }) {
    this.#caps = input.caps;
    this.#markets = input.markets;
    for (const [key, assetId] of input.tokenAssetIds) {
      const separator = key.lastIndexOf("|");
      if (separator < 0) continue;
      const marketId = key.slice(0, separator);
      const side = key.slice(separator + 1);
      if (side !== "YES" && side !== "NO") continue;
      this.#assets.set(assetId, { marketId, side });
    }
  }

  /**
   * Folds one fill BOOKED into `instanceId`'s position into the cost-basis
   * book, and — `CAP-1` — CONVERTS the commitment of the planned order it
   * filled: its shares leave the reserved part, and its debit is now the
   * position's. Closes the commitment when its confirmed final size is fully
   * booked.
   *
   * `plannedOrderId` is the order's, as the venue names it. Without one (the
   * venue could not answer) nothing is converted: the commitment keeps its
   * whole reservation, which only ever over-counts.
   */
  observeFill(
    instanceId: string,
    fill: Pick<SimulatedFill, "simulatedFillId" | "marketId" | "side" | "action" | "price" | "shares">,
    plannedOrderId?: string,
  ): void {
    this.#costBasis.observe(instanceId, fill);
    if (plannedOrderId === undefined) return;
    const commitment = this.#commitments.get(plannedOrderId);
    if (commitment === undefined) return;
    const { request } = commitment;
    // A fill that is not this commitment's — another market, side, direction
    // or owner — converts nothing: the commitment keeps its reservation.
    if (
      request.strategyInstanceId !== instanceId ||
      request.marketId !== fill.marketId ||
      request.side !== fill.side ||
      request.action !== fill.action ||
      !isCanonicalDecimalString(fill.shares) ||
      !isCanonicalDecimalString(fill.price)
    ) {
      return;
    }
    // Once per fill: a fill already converted converts nothing more.
    if (commitment.bookedFillIds.has(fill.simulatedFillId)) return;
    commitment.bookedFillIds.add(fill.simulatedFillId);
    commitment.bookedShares = addDecimal(commitment.bookedShares, fill.shares);
    if (request.action === "BUY") {
      commitment.bookedByPrice.set(
        fill.price,
        addDecimal(commitment.bookedByPrice.get(fill.price) ?? "0", fill.shares),
      );
    }
    this.#closeIfBooked(plannedOrderId, commitment);
  }

  /**
   * `CAP-1`: one fill of `plannedOrderId` was booked UNATTRIBUTED (`TRDR-4`:
   * no instance owns its order). No position will ever carry it, so its
   * capital stays in the commitment — at the fill's own price once the final
   * size is confirmed — against the instance that reserved it, and the
   * commitment never closes. Fail closed: the capital the account spent
   * cannot vanish from the cap check, and the market is halted
   * `UNATTRIBUTED_ACTIVITY` for reconciliation meanwhile.
   */
  observeUnattributedFill(
    fill: Pick<SimulatedFill, "simulatedFillId" | "marketId" | "side" | "action" | "price" | "shares">,
    plannedOrderId: string | undefined,
  ): void {
    if (plannedOrderId === undefined) return;
    const commitment = this.#commitments.get(plannedOrderId);
    if (commitment === undefined) return;
    const { request } = commitment;
    if (
      request.marketId !== fill.marketId ||
      request.side !== fill.side ||
      request.action !== fill.action ||
      !isCanonicalDecimalString(fill.shares) ||
      !isCanonicalDecimalString(fill.price)
    ) {
      return;
    }
    commitment.unattributed.set(fill.simulatedFillId, {
      simulatedFillId: fill.simulatedFillId,
      price: fill.price,
      shares: fill.shares,
    });
  }

  /**
   * `CAP-1` r1: one fill of `plannedOrderId` the loop has SEEN at the venue, in
   * a placement answer, a trade answer or (r2) a fill page it read, whether
   * or not it is booked yet.
   *
   * It is evidence of PRICE only: it converts nothing and releases nothing.
   * Once the commitment's final size is known, an unbooked fill it has seen
   * is kept at its own price rather than at the order's limit
   * (`CAP1-ASTRA-R1-03`, `CAP1-ASTRA-R2-01`). A fill that is not this
   * commitment's (another market, side or direction), or is not exact, is
   * ignored, and the share it filled stays at the limit (fail closed).
   */
  observeVenueFill(
    fill: Pick<SimulatedFill, "simulatedFillId" | "marketId" | "side" | "action" | "price" | "shares">,
    plannedOrderId: string | undefined,
  ): void {
    if (plannedOrderId === undefined) return;
    const commitment = this.#commitments.get(plannedOrderId);
    if (commitment === undefined) return;
    const { request } = commitment;
    if (request.marketId !== fill.marketId || request.side !== fill.side || request.action !== fill.action) return;
    see(commitment, fill);
  }

  /**
   * `CAP-1`: one planned order's FINAL size is confirmed: the order is
   * terminal and can fill no more. Releases EXACTLY the unused remainder,
   * `reservation − Σ debits` (WP-270 decision 5), and keeps the capital of
   * every fill no position carries yet (`keptFills`): each fill seen, in
   * `unbookedFills` or earlier (`observeVenueFill`), at its own price, and
   * any share of `filledShares` no fill was seen for at the order's limit.
   * Answers whether the commitment is now CLOSED (every share of the final
   * size booked).
   *
   * Idempotent. The fills of `unbookedFills` are recorded as SEEN, adding to
   * what the commitment already saw, and a fill the commitment has already
   * converted is never counted again. `unbookedFills` `undefined` means the
   * caller read no page here: an unbooked share that no answer and no page
   * the loop read carried is then held at the limit.
   */
  settle(plannedOrderId: string, final: TerminalOrderView): boolean {
    const commitment = this.#commitments.get(plannedOrderId);
    if (commitment === undefined) return false;
    // A final size that is not an exact decimal cannot be shown to be final:
    // the commitment keeps its whole reservation (fail closed).
    if (!isCanonicalDecimalString(final.filledShares)) return false;
    for (const fill of final.unbookedFills ?? []) see(commitment, fill);
    commitment.finalShares = final.filledShares;
    return this.#closeIfBooked(plannedOrderId, commitment);
  }

  /**
   * Closes a commitment whose final size is confirmed and fully booked: every
   * share of it is in a position now, which counts it from here on.
   */
  #closeIfBooked(plannedOrderId: string, commitment: Commitment): boolean {
    if (commitment.finalShares === undefined) return false;
    if (compareDecimal(commitment.bookedShares, commitment.finalShares) < 0) return false;
    this.#commitments.delete(plannedOrderId);
    this.#releasedCount += 1;
    return true;
  }

  /** The exact remaining cost basis of one held position. */
  costBasisOf(instanceId: string, marketId: string, side: "YES" | "NO"): string {
    return this.#costBasis.costBasis(instanceId, marketId, side);
  }

  /**
   * `CAP-1` (orchestrator ruling, 2026-10-04): §9.8 checks 16 and 17's
   * SEPARATE input: `instanceId`'s filled-but-unbooked BUY exposure in
   * `marketId`, per token (`packages/risk`'s `unbookedFills`).
   *
   * THE SAME SOURCE OF TRUTH AS THE CAP CHECK. It is derived from the
   * commitments `#buildState` counts, through the same derivation
   * (`keptFills`, at the same final size, `finalSharesNow`), so the risk
   * checks and the cap check can never disagree about which fill is unbooked
   * or what it cost. Per BUY commitment of the strategy in the market:
   *
   * - **Final size known** (settled, or its order TERMINAL in the caller's
   *   view now): exactly the fills the allocator keeps for it. Each seen fill
   *   is at its own price, and each share that no venue answer and (r2) no
   *   fill page the loop read has carried yet is at the limit (never less
   *   than its debit).
   * - **Presented as OPEN** (`presentedOpen`; `CAP-1` r1): the open order
   *   presents only its UNFILLED remainder, so its filled shares no position
   *   carries yet are stated here, exactly as above. No share is counted twice:
   *   the booked ones are the position's, the unbooked ones are here, and the
   *   unfilled ones are the open order's (`CAP1-ASTRA-R1-02`).
   * - **Working, not presented** (an order no instance owns): its unbooked
   *   filled shares as above, plus its unfilled shares at its limit. It may yet
   *   fill, and the lot builder counts a resting BUY as if it had.
   * - **The venue shows no order**: its whole unconverted reservation at its
   *   limit, exactly as the allocator counts it.
   *
   * SELLs add nothing here. That is NOT fail-closed for every measure (an open
   * item, `CAP1-OPUS-OBS-1`). An unbooked SELL fill leaves its sold shares in
   * the booked position. That over-counts check 16's primary measure (cost),
   * but credits those shares' value to check 17's scenario loss and to check
   * 16's resolution limit, which can then admit what a booked control
   * refuses, when the mark exceeds the sold shares' cost. Stating unbooked
   * SELLs needs more than the ruling's BUY-only input.
   *
   * It is NEVER a position (no exit can sell it, §6 invariant 10) and NEVER an
   * open order (check 18 never reads it): `packages/risk` reads it in the lot
   * builder only. Answers in token order (YES, then NO); a token with nothing
   * unbooked is absent.
   */
  unbookedExposure(input: {
    readonly instanceId: string;
    readonly marketId: string;
    /**
     * The orders the risk portfolio's `openOrders` presents, as `planned order
     * id -> the filled shares that presentation leaves out`: it presents
     * `requested − filled`, the UNFILLED remainder.
     */
    readonly presentedOpen: ReadonlyMap<string, string>;
    /** The caller's view of a planned order (asked only for one neither settled nor presented). */
    readonly viewOf: OrderViewOf;
  }): readonly UnbookedExposure[] {
    const totals = { YES: { shares: "0", debit: "0" }, NO: { shares: "0", debit: "0" } };
    for (const [plannedOrderId, commitment] of this.#commitments) {
      const { request } = commitment;
      if (request.action !== "BUY" || request.strategyInstanceId !== input.instanceId || request.marketId !== input.marketId) {
        continue;
      }
      const total = totals[request.side];
      for (const part of unbookedParts(plannedOrderId, commitment, input.presentedOpen, input.viewOf)) {
        if (!positive(part.shares)) continue;
        total.shares = addDecimal(total.shares, part.shares);
        total.debit = addDecimal(total.debit, mulDecimal(part.price, part.shares));
      }
    }
    const out: UnbookedExposure[] = [];
    for (const side of ["YES", "NO"] as const) {
      const total = totals[side];
      if (positive(total.shares)) out.push(Object.freeze({ marketId: input.marketId, side, shares: total.shares, debit: total.debit }));
    }
    return Object.freeze(out);
  }

  /**
   * `ROLLOVER-1` r7 (R7-FABLE-03): does any commitment this gate still holds
   * name `marketId`? Moves nothing.
   *
   * A series window's teardown retires its registrations, and with them the
   * market's live owner (`InstanceRegistry.retireMarket`). A commitment that
   * names the market is re-applied by {@link #buildState} at EVERY question,
   * and `packages/capital-allocator` refuses a LIVE commitment on a market
   * with no live owner (`CAPITAL_LIVE_OWNERSHIP_MISSING`) — so a commitment
   * that outlived its window's owner would refuse every later question, every
   * window's entries and protective exits alike, for the rest of the run. One
   * that never closes (a fill booked UNATTRIBUTED, {@link observeUnattributedFill})
   * does exactly that. The loop therefore holds a window while this answers
   * `true` (`#windowHoldsWork`): its capital stays committed against a market
   * that still has its owner.
   */
  holdsCommitmentIn(marketId: string): boolean {
    for (const commitment of this.#commitments.values()) {
      if (commitment.request.marketId === marketId) return true;
    }
    return false;
  }

  /** The §9.7 scope this gate knows for a market, if it is configured. */
  marketOf(marketId: string): AllocationMarket | undefined {
    return this.#markets.get(marketId);
  }

  /**
   * `ROLLOVER-1` r1 (R1-01): makes a market ADMITTED after construction — a
   * series window (ADR-030) — known to the position projection, BEFORE any
   * runtime of it can trade (`trader.ts` calls it in the window's attach).
   *
   * The constructor inverts the token map it is given ONCE, and
   * {@link #positionsFrom} skips an asset it does not know. Without this, a
   * window's booked position was invisible here: its protective exit was
   * refused `CAPITAL_INVENTORY_INSUFFICIENT` and its exposure counted ZERO
   * toward every §9.7 cap, so another window could commit past the global cap.
   *
   * The mapping is never removed: a torn-down window keeps its ledger rows
   * (ADR-030 Decision 4.4), so a position or reservation that names its assets
   * stays counted. Answers `false`, and changes nothing, when either asset is
   * already mapped to another market or side, or the two assets are the same:
   * the caller refuses to attach the window (fail closed).
   */
  registerMarketAssets(marketId: string, yesAssetId: string, noAssetId: string): boolean {
    if (yesAssetId === noAssetId) return false;
    for (const [assetId, side] of [[yesAssetId, "YES"], [noAssetId, "NO"]] as const) {
      const known = this.#assets.get(assetId);
      if (known !== undefined && (known.marketId !== marketId || known.side !== side)) return false;
    }
    this.#assets.set(yesAssetId, { marketId, side: "YES" });
    this.#assets.set(noAssetId, { marketId, side: "NO" });
    return true;
  }

  /**
   * §8.1's "allocate capital", for one intent.
   *
   * Answers the allocator's OWN verdict and the exposure snapshot §9.8 check 15
   * queries. It changes nothing: `evaluateReservation` is the question, and
   * {@link applyForPlan} is the commitment.
   */
  evaluate(input: {
    readonly intent: Intent;
    readonly instanceId: string;
    /**
     * The §9.7 accounting mode the commitment is judged under.
     *
     * `apps/trader` always passes `LIVE`, and review round 2's HIGH-1 is why:
     * the trader has ONE book — one cash balance, one ledger, one venue — so a
     * commitment that reaches it is a live commitment however it is attributed.
     * `SHADOW` selects the allocator's independent-shadow-accounting arm, which
     * skips the ADR-011 ownership gate, the live-micro fence and the collateral
     * and inventory sufficiency checks, and compares caps against the
     * instance's OWN shadow book. That is correct for a caller holding a
     * separate book and catastrophic for one that is not: at the r1 tip a
     * `SHADOW` instance was evaluated on the shadow arm and then executed on the
     * shared venue, bypassing every one of those gates. The parameter stays
     * because the package's contract has both arms; the trader's answer to it
     * is a constant (`loop.ts`'s `SHARED_BOOK_ACCOUNTING_MODE`).
     */
    readonly accountingMode: "LIVE" | "SHADOW";
    readonly liveOwners: readonly {
      readonly marketId: string;
      readonly strategyInstanceId: string;
    }[];
    readonly projection: LedgerProjection;
    readonly availableCollateral: string;
    readonly approvedIntentId: string;
    /** Held shares as the loop sees them, for the delta this intent resolves to. */
    readonly heldShares: (marketId: string, side: "YES" | "NO") => string;
    /**
     * `CAP-1` r1: the venue's view of a planned order, asked for each
     * commitment not yet settled (`#buildState`). REQUIRED, so no question
     * can forget it.
     */
    readonly viewOf: OrderViewOf;
  }): AllocationOutcome {
    const built = this.#buildState(input.liveOwners, input.projection, input.availableCollateral, input.viewOf);
    const requests = this.#requestsFor(input);
    const coverage = this.#coverageFor(input.instanceId, requests);

    if (!built.ok) {
      // The state itself could not be built. A cap cannot be shown to hold
      // against an account this process cannot describe, so the answer is a
      // REFUSAL carrying the allocator's own codes — never an absent verdict,
      // which check 14 would read as "the allocator was not asked", and never
      // an absent exposure snapshot, which check 15 would read the same way.
      return {
        verdict: this.#record(false, built.refusals),
        exposures: covering(EMPTY_SNAPSHOT, coverage),
        requests,
      };
    }
    const exposures =
      input.accountingMode === "LIVE"
        ? exposureSnapshotCovering(built.state, coverage)
        : covering(shadowExposureSnapshot(built.state, input.instanceId), coverage);
    if (requests.length === 0) return { verdict: undefined, exposures, requests };

    const refusals: CapitalRefusal[] = [];
    for (const request of requests) {
      const verdict = evaluateReservation(built.state, this.#caps, request);
      if (!verdict.permitted) refusals.push(...verdict.refusals);
    }
    return { verdict: this.#record(refusals.length === 0, refusals), exposures, requests };
  }

  /**
   * §9.10: reserve BEFORE submission.
   *
   * Applies one reservation per PLANNED ORDER — the same key `ReservationBook`
   * uses — so the two books are taken and released together. A refusal is
   * answered as data and nothing is applied: the caller does not submit.
   */
  applyForPlan(input: {
    readonly entries: readonly {
      readonly plannedOrderId: string;
      readonly request: ReservationRequest;
    }[];
    readonly liveOwners: readonly {
      readonly marketId: string;
      readonly strategyInstanceId: string;
    }[];
    readonly projection: LedgerProjection;
    readonly availableCollateral: string;
    /** `CAP-1` r1: as {@link evaluate}'s, so the commitment is judged on the account `evaluate` judged. */
    readonly viewOf: OrderViewOf;
  }): { readonly ok: true } | { readonly ok: false; readonly refusals: readonly CapitalRefusal[] } {
    const built = this.#buildState(input.liveOwners, input.projection, input.availableCollateral, input.viewOf);
    if (!built.ok) return { ok: false, refusals: this.#count(built.refusals) };
    let state = built.state;
    for (const entry of input.entries) {
      const applied = applyReservation(state, this.#caps, entry.request);
      if (!applied.ok) return { ok: false, refusals: this.#count(applied.refusals) };
      state = applied.value.state;
    }
    // Recorded only after EVERY leg was accepted, so a plan is never half
    // reserved: a partial application would leave capital committed against an
    // order this process then refuses to submit.
    for (const entry of input.entries) {
      this.#commitments.set(entry.plannedOrderId, {
        request: entry.request,
        bookedShares: "0",
        bookedFillIds: new Set(),
        bookedByPrice: new Map(),
        unattributed: new Map(),
        seen: new Map(),
        finalShares: undefined,
      });
      this.#appliedCount += 1;
    }
    return { ok: true };
  }

  /**
   * Releases the WHOLE commitment of a planned order the venue does NOT hold
   * — a REFUSED submission's (review round 1, MEDIUM-4: such an order has no
   * view, so nothing else would ever release it; `TRDR-4` round 1: one the
   * venue DOES hold is kept until it is terminal). Nothing of it can fill, so
   * its final size is what was booked — nothing — and it closes.
   *
   * `CAP-1`: an order that reaches a TERMINAL state is not released here; it
   * is {@link settle}d, which releases only its exact unused remainder.
   */
  release(plannedOrderId: string): boolean {
    const commitment = this.#commitments.get(plannedOrderId);
    if (commitment === undefined) return false;
    // What was booked, plus — defensively, for no reachable path — anything
    // booked unattributed, which keeps its capital (and the commitment) open.
    let filledShares = commitment.bookedShares;
    for (const fill of commitment.unattributed.values()) filledShares = addDecimal(filledShares, fill.shares);
    commitment.finalShares = filledShares;
    return this.#closeIfBooked(plannedOrderId, commitment);
  }

  metrics(): AllocatorMetrics {
    let reserved = "0";
    for (const commitment of this.#commitments.values()) {
      // As SETTLED: the health surface reads no venue view. An unsettled
      // commitment whose order is terminal shows its whole reservation here
      // until a loop site settles it; every cap check judges it at its view.
      for (const request of commitmentRequests(commitment, commitment.finalShares)) {
        if (request.action !== "BUY") continue;
        reserved = addDecimal(reserved, mulDecimal(request.price, request.shares));
      }
    }
    const counts: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const code of [...this.#refusalsByCode.keys()].sort()) {
      counts[code] = this.#refusalsByCode.get(code) ?? 0;
    }
    return Object.freeze({
      open: this.#commitments.size,
      applied: this.#appliedCount,
      released: this.#releasedCount,
      reservedCollateral: reserved,
      refusalsByCode: Object.freeze(counts),
    });
  }

  #count(refusals: readonly CapitalRefusal[]): readonly CapitalRefusal[] {
    for (const refusal of refusals) {
      this.#refusalsByCode.set(refusal.code, (this.#refusalsByCode.get(refusal.code) ?? 0) + 1);
    }
    return refusals;
  }

  #record(permitted: boolean, refusals: readonly CapitalRefusal[]): AllocationVerdict {
    if (!permitted) this.#count(refusals);
    return Object.freeze({
      permitted,
      refusals: Object.freeze(
        refusals.map((refusal) => Object.freeze({ code: refusal.code, message: refusal.message })),
      ),
    });
  }

  /**
   * The account, rebuilt from the loop's own authoritative state and then
   * carrying every commitment this process still holds.
   *
   * THE CHOKE POINT (`CAP-1`). Every question the cap check is asked —
   * `evaluate` (the §9.8 check-14 verdict and the check-15 snapshot) and
   * `applyForPlan` — is answered from the account built HERE, and only here:
   * the booked positions at their FIFO cost basis, plus what each commitment
   * adds now (`commitmentRequests`). So at every evaluation the capital
   * counted for a strategy is at least its open reservations plus its booked
   * and unbooked filled exposure, and the converted shares are counted once.
   *
   * The re-application is not ceremony: capacity is re-checked against the
   * state as it is NOW, so a reservation that could no longer be made becomes a
   * refusal rather than a silently retained commitment.
   */
  #buildState(
    liveOwners: readonly { readonly marketId: string; readonly strategyInstanceId: string }[],
    projection: LedgerProjection,
    availableCollateral: string,
    viewOf: OrderViewOf,
  ): BuiltState {
    const created = createAllocatorState({
      accountEquity: addDecimal(availableCollateral, this.#costBasis.total()),
      availableCollateral,
      positions: this.#positionsFrom(projection),
      // See the module header: the applied reservations ARE the in-flight
      // commitments, so declaring them here as well would double-reserve.
      openOrders: [],
      liveOwners: liveOwners.map((owner) => ({
        marketId: owner.marketId,
        strategyInstanceId: owner.strategyInstanceId,
      })),
    });
    if (!created.ok) return { ok: false, refusals: created.refusals };
    let state = created.value;
    for (const [plannedOrderId, commitment] of this.#commitments) {
      // `CAP-1` r1: a commitment not yet settled is judged at the final size
      // its order shows in the caller's view, when that view is terminal: its
      // exact unused remainder is released here (`CAP1-ASTRA-R1-01`).
      const finalShares = commitment.finalShares ?? finalSharesNow(commitment, viewOf(plannedOrderId));
      for (const request of commitmentRequests(commitment, finalShares)) {
        const applied = applyReservation(state, this.#caps, request);
        if (!applied.ok) return { ok: false, refusals: applied.refusals };
        state = applied.value.state;
      }
    }
    return { ok: true, state };
  }

  #positionsFrom(projection: LedgerProjection): readonly {
    readonly positionId: string;
    readonly marketId: string;
    readonly strategyInstanceId: string;
    readonly side: "YES" | "NO";
    readonly shares: string;
    readonly costBasis: string;
    readonly scope?: ReturnType<typeof scopeOf>;
  }[] {
    const rows: {
      positionId: string;
      marketId: string;
      strategyInstanceId: string;
      side: "YES" | "NO";
      shares: string;
      costBasis: string;
      scope?: ReturnType<typeof scopeOf>;
    }[] = [];
    for (const line of projection.virtualPositions.values()) {
      const asset = this.#assets.get(line.assetId);
      if (asset === undefined) continue;
      if (compareDecimal(line.balance, "0") === 0) continue;
      const market = this.#markets.get(asset.marketId);
      rows.push({
        positionId: `${line.instanceId}|${asset.marketId}|${asset.side}`,
        marketId: asset.marketId,
        strategyInstanceId: line.instanceId,
        side: asset.side,
        shares: line.balance,
        costBasis: this.#costBasis.costBasis(line.instanceId, asset.marketId, asset.side),
        ...(market === undefined ? {} : { scope: scopeOf(market) }),
      });
    }
    // The projection's own iteration order is already deterministic (a Map over
    // a canonical key); sorted anyway so the document this process hands the
    // allocator does not depend on the ledger's fold order.
    return Object.freeze(
      rows.sort((left, right) => (left.positionId < right.positionId ? -1 : 1)),
    );
  }

  /**
   * The §7.7 intent, as §9.7 reservation requests.
   *
   * The leg derivation MIRRORS `packages/risk`'s `buildIntentView`: a
   * `POSITION` intent resolves to a signed delta against the held shares, a
   * positive delta BUYS and a negative one SELLS, a `REDUCE_POSITION` sells the
   * excess on each side, and a `CANCEL` commits nothing. It applies no policy of
   * its own — the SHAPE is the allocator's input contract — and the two
   * derivations are held together by the suite: a request the risk engine would
   * not recognise refuses an intent the engine approves, which is a test
   * failure rather than a silent divergence.
   */
  #requestsFor(input: {
    readonly intent: Intent;
    readonly instanceId: string;
    readonly accountingMode: "LIVE" | "SHADOW";
    readonly approvedIntentId: string;
    readonly heldShares: (marketId: string, side: "YES" | "NO") => string;
  }): readonly ReservationRequest[] {
    return Object.freeze(
      intentLegs(input.intent, input.heldShares).map((leg, index) =>
        requestFor({
          reservationId: `${input.approvedIntentId}#${String(index)}`,
          instanceId: input.instanceId,
          accountingMode: input.accountingMode,
          leg,
          market: this.#markets.get(leg.marketId),
        }),
      ),
    );
  }

  /** Every scope this evaluation will query, so the snapshot ANSWERS for it. */
  #coverageFor(
    instanceId: string,
    requests: readonly ReservationRequest[],
  ): AllocationCoverage {
    const marketIds = [...new Set(requests.map((request) => request.marketId))].sort();
    const scopes = marketIds
      .map((marketId) => this.#markets.get(marketId))
      .filter((market): market is AllocationMarket => market !== undefined);
    return {
      strategyInstanceIds: [instanceId],
      marketIds,
      seriesKeys: [...new Set(scopes.map((market) => market.seriesKey))].sort(),
      underlyingKeys: [...new Set(scopes.map((market) => market.underlyingKey))].sort(),
      resolutionWindowKeys: [
        ...new Set(scopes.map((market) => market.resolutionWindowKey)),
      ].sort(),
    };
  }
}

/**
 * The legs of one intent, mirroring `packages/risk`'s own normalization.
 *
 * A leg with no price bound is OMITTED rather than priced at a guess: the
 * allocator's request needs an exact price, and inventing one would commit
 * capital against a number nobody stated. An entry whose legs all vanish that
 * way produces NO request, and §9.8 check 14 then refuses it as a missing
 * verdict — the fail-closed direction.
 */
export function intentLegs(
  intent: Intent,
  heldShares: (marketId: string, side: "YES" | "NO") => string,
): readonly IntentLeg[] {
  const legs: IntentLeg[] = [];
  switch (intent.type) {
    case "CANCEL":
      return Object.freeze([]);
    case "POSITION": {
      const held = heldShares(intent.marketId, intent.direction);
      const delta =
        intent.targetMode === "DELTA" ? intent.targetShares : subDecimal(intent.targetShares, held);
      if (compareDecimal(delta, "0") === 0) return Object.freeze([]);
      const buying = compareDecimal(delta, "0") > 0;
      const price = buying ? intent.maximumBuyPrice : intent.minimumSellPrice;
      if (price === undefined) return Object.freeze([]);
      legs.push({
        marketId: intent.marketId,
        side: intent.direction,
        action: buying ? "BUY" : "SELL",
        price,
        shares: absolute(delta),
      });
      break;
    }
    case "REDUCE_POSITION": {
      if (intent.minimumSellPrice === undefined) return Object.freeze([]);
      for (const side of ["YES", "NO"] as const) {
        const excess = subDecimal(
          heldShares(intent.marketId, side),
          absolute(intent.targetShares),
        );
        if (compareDecimal(excess, "0") <= 0) continue;
        legs.push({
          marketId: intent.marketId,
          side,
          action: "SELL",
          price: intent.minimumSellPrice,
          shares: excess,
        });
      }
      break;
    }
    case "QUOTE":
      // §7.7's `QuoteLevel` names no outcome token, and the allocator's request
      // needs one. The side a level belongs to is NOT derivable from the level,
      // so a quote produces no request here — and §9.8 check 14 then refuses the
      // quote for want of a verdict, which is the fail-closed direction and is
      // stated rather than guessed. `strategy-static-bracket` emits no quote.
      return Object.freeze([]);
    case "BASKET": {
      for (const leg of intent.legs) {
        const shares = absolute(leg.targetShares);
        if (compareDecimal(shares, "0") === 0) continue;
        const buying = compareDecimal(leg.targetShares, "0") > 0;
        const price = buying ? leg.maximumBuyPrice : leg.minimumSellPrice;
        if (price === undefined) continue;
        legs.push({
          marketId: leg.marketId,
          side: leg.direction,
          action: buying ? "BUY" : "SELL",
          price,
          shares,
        });
      }
      break;
    }
  }
  return Object.freeze(legs);
}

/** One §9.7 reservation request, assembled from a leg. */
export function requestFor(input: {
  readonly reservationId: string;
  readonly instanceId: string;
  readonly accountingMode: "LIVE" | "SHADOW";
  readonly leg: IntentLeg;
  readonly market: AllocationMarket | undefined;
}): ReservationRequest {
  return {
    reservationId: input.reservationId,
    strategyInstanceId: input.instanceId,
    // §11: this process serves exactly ONE run mode, and `safety.ts` refuses to
    // start under any other. Stated rather than threaded so a request cannot
    // name a mode the process is not in — and stated as `safety.ts`'s OWN
    // constant (review round 2, note N4), so the mode the allocator's
    // real-order fence reads is the same symbol the startup gate enforced.
    runMode: TRADER_RUN_MODE,
    accountingMode: input.accountingMode,
    marketId: input.leg.marketId,
    side: input.leg.side,
    action: input.leg.action,
    price: input.leg.price,
    shares: input.leg.shares,
    ...(input.market === undefined ? {} : { scope: scopeOf(input.market) }),
  } as ReservationRequest;
}

/** The §9.7 scope a market configuration states. */
export function allocationMarketOf(market: MarketConfig): AllocationMarket {
  return {
    marketId: market.marketId,
    seriesKey: market.seriesKey,
    underlyingKey: market.underlyingKey,
    resolutionWindowKey: market.resolutionWindowKey,
  };
}

function absolute(value: string): string {
  return compareDecimal(value, "0") < 0 ? subDecimal("0", value) : value;
}

/** An account with nothing in it — used only when the state could not be built. */
const EMPTY_SNAPSHOT: ExposureSnapshot = Object.freeze({
  global: EXPOSURE_ZERO,
  byStrategyInstance: Object.freeze({}),
  byMarket: Object.freeze({}),
  bySeries: Object.freeze({}),
  byUnderlying: Object.freeze({}),
  byResolutionWindow: Object.freeze({}),
});

/**
 * {@link exposureSnapshotCovering} for a snapshot the package does not build a
 * covering form of.
 *
 * `packages/capital-allocator` publishes the covering builder for the LIVE
 * snapshot only, and an uncovered snapshot is exactly what
 * `RISK_EXPOSURE_ENTRY_MISSING` refuses. The zeros this adds are honest for the
 * same reason the package's are: a shadow book is that instance's COMPLETE
 * record of its own commitments, so a scope it does not mention holds nothing.
 * The entry written is the package's own {@link EXPOSURE_ZERO}.
 *
 * On the refused-state path it covers the EMPTY snapshot, which is honest in a
 * different way: the verdict travelling with it is a refusal, so nothing is
 * approved against those zeros.
 */
function covering(snapshot: ExposureSnapshot, coverage: AllocationCoverage): ExposureSnapshot {
  const fill = (
    table: Readonly<Record<string, ExposureEntry>>,
    keys: readonly string[],
  ): Readonly<Record<string, ExposureEntry>> => {
    const out: Record<string, ExposureEntry> = { ...table };
    for (const key of keys) {
      if (!Object.hasOwn(out, key)) out[key] = EXPOSURE_ZERO;
    }
    return Object.freeze(out);
  };
  return Object.freeze({
    global: snapshot.global,
    byStrategyInstance: fill(snapshot.byStrategyInstance, coverage.strategyInstanceIds),
    byMarket: fill(snapshot.byMarket, coverage.marketIds),
    bySeries: fill(snapshot.bySeries, coverage.seriesKeys),
    byUnderlying: fill(snapshot.byUnderlying, coverage.underlyingKeys),
    byResolutionWindow: fill(snapshot.byResolutionWindow, coverage.resolutionWindowKeys),
  });
}
