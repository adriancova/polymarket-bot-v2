/**
 * The reservation service — the asynchronous face of {@link InventoryBook}
 * for callers that persist every reservation fact (§10.5
 * `inventory_reservations`; the journal port is where a composition root binds
 * PostgreSQL).
 *
 * CONCURRENCY. Double reservation must be impossible "including under
 * concurrent requests". JavaScript runs each synchronous block to completion,
 * so the only way two concurrent requests can both pass an availability check
 * is an `await` BETWEEN the check and the apply. This service has none: every
 * method runs the book's check-and-apply as ONE synchronous call and only then
 * awaits the journal. The guarantee therefore lives in the book, whose every
 * mutation checks and applies inside one call; this service must never split
 * a check from its apply across an `await`. The journal's `append` is invoked
 * synchronously, in apply order, so the persisted order equals the decision
 * order. `test/unit/inventory/reservation-concurrency.test.ts` fires
 * interleaved requests through a journal with randomized completion delays and
 * asserts no over-reservation, no second active reservation per holder and
 * asset, one grant per reservation id, and journal order = grant order.
 *
 * FAILURE. If the journal rejects (or `append` throws), the in-memory effect
 * has already happened and may or may not be persisted. The service does not
 * guess: it FAULTS, and every later call is refused (`INVENTORY_FAULTED`) until
 * the composition root rebuilds it from the journal and a reconciliation read.
 * A faulted service holds whatever it held — the fail-closed direction (more
 * reserved, never less).
 *
 * ORDERED ACKNOWLEDGEMENT. Each mutation depends on every mutation decided
 * before it (a reservation may exist only because an earlier release freed
 * the amount). So a mutation is acknowledged (`ok: true`) only once its own
 * append AND every earlier append have succeeded, and only if the service has
 * not faulted meanwhile. The acknowledgement chain slot is registered BEFORE
 * `append` is invoked, so a mutation made reentrantly from inside a
 * synchronous `append` also depends on the outer one and fails with it.
 *
 * The caller must await a reservation before acting on it (for example,
 * before submitting the order it protects).
 */

import type { DecimalString } from "@polymarket-bot/decimal";

import type {
  ActualObservation,
  InventoryBook,
  InventoryLineView,
  PendingSettlement,
  PendingView,
  ReservationView,
  ReserveRequest,
} from "./inventory-book.js";
import { ownData } from "./guards.js";
import { refuse, type InventoryResult } from "./refusals.js";

export type InventoryJournalEvent =
  | { readonly kind: "RESERVED"; readonly reservation: ReservationView }
  | { readonly kind: "CONSUMED"; readonly reservation: ReservationView; readonly pendingId: string; readonly amount: DecimalString }
  | { readonly kind: "RELEASED"; readonly reservation: ReservationView }
  | { readonly kind: "INFLOW_EXPECTED"; readonly pending: PendingView }
  | { readonly kind: "PENDING_SETTLED"; readonly pending: PendingView; readonly settlement: PendingSettlement }
  | { readonly kind: "ACTUAL_OBSERVED"; readonly observation: ActualObservation };

/** The persistence port. A composition root binds it; tests use in-memory fakes. */
export interface ReservationJournal {
  append(event: InventoryJournalEvent): Promise<void>;
}

export class ReservationService {
  readonly #book: InventoryBook;
  readonly #journal: ReservationJournal;
  #faulted = false;
  /** Resolves true iff every append decided so far has succeeded. Never rejects. */
  #acknowledged: Promise<boolean> = Promise.resolve(true);

  constructor(book: InventoryBook, journal: ReservationJournal) {
    this.#book = book;
    this.#journal = journal;
  }

  get faulted(): boolean {
    return this.#faulted;
  }

  /** Read-only view of the underlying book (views are frozen copies). */
  line(accountRef: string, assetId: string): InventoryLineView | undefined {
    return this.#book.line(accountRef, assetId);
  }

  available(accountRef: string, assetId: string): DecimalString {
    return this.#book.available(accountRef, assetId);
  }

  reserve(request: ReserveRequest): Promise<InventoryResult<ReservationView>> {
    return this.#mutate(
      () => this.#book.reserve(request),
      (reservation) => ({ kind: "RESERVED", reservation }),
    );
  }

  consume(input: {
    readonly reservationId: string;
    readonly amount: DecimalString;
    readonly pendingId: string;
  }): Promise<InventoryResult<ReservationView>> {
    // Copy the fields (own data only) BEFORE the book reads them, so the
    // journal records exactly what the book validated.
    const reservationId = ownData(input, "reservationId") as string;
    const pendingId = ownData(input, "pendingId") as string;
    const amount = ownData(input, "amount") as DecimalString;
    return this.#mutate(
      () => this.#book.consume({ reservationId, amount, pendingId }),
      (reservation) => ({ kind: "CONSUMED", reservation, pendingId, amount }),
    );
  }

  release(input: { readonly reservationId: string }): Promise<InventoryResult<ReservationView>> {
    return this.#mutate(
      () => this.#book.release(input),
      (reservation) => ({ kind: "RELEASED", reservation }),
    );
  }

  expectInflow(input: {
    readonly pendingId: string;
    readonly accountRef: string;
    readonly assetId: string;
    readonly amount: DecimalString;
  }): Promise<InventoryResult<PendingView>> {
    return this.#mutate(
      () => this.#book.expectInflow(input),
      (pending) => ({ kind: "INFLOW_EXPECTED", pending }),
    );
  }

  settlePending(input: {
    readonly pendingId: string;
    readonly settlement: PendingSettlement;
  }): Promise<InventoryResult<PendingView>> {
    const pendingId = ownData(input, "pendingId") as string;
    const settlement = ownData(input, "settlement") as PendingSettlement;
    return this.#mutate(
      () => this.#book.settlePending({ pendingId, settlement }),
      (pending) => ({ kind: "PENDING_SETTLED", pending, settlement }),
    );
  }

  observeActual(input: {
    readonly accountRef: string;
    readonly assetId: string;
    readonly balance: DecimalString;
  }): Promise<InventoryResult<ActualObservation>> {
    return this.#mutate(
      () => this.#book.observeActual(input),
      (observation) => ({ kind: "ACTUAL_OBSERVED", observation }),
    );
  }

  async #mutate<T>(
    apply: () => InventoryResult<T>,
    toEvent: (value: T) => InventoryJournalEvent,
  ): Promise<InventoryResult<T>> {
    if (this.#faulted) {
      return refuse("INVENTORY_FAULTED", "the reservation service is faulted; rebuild it from the journal and reconcile");
    }
    // Check and apply: one synchronous step. NO await may precede this line.
    const result = apply();
    if (!result.ok) return result;
    // Register this mutation's slot in the acknowledgement chain BEFORE the
    // journal is invoked (a reentrant mutation made inside `append` must
    // depend on this one).
    let settle: (persisted: boolean) => void = () => undefined;
    const own = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const chained = Promise.all([this.#acknowledged, own]).then(([before, mine]) => before && mine);
    this.#acknowledged = chained;
    try {
      Promise.resolve(this.#journal.append(toEvent(result.value))).then(
        () => settle(true),
        () => {
          this.#faulted = true;
          settle(false);
        },
      );
    } catch {
      this.#faulted = true;
      settle(false);
    }
    const persisted = await chained;
    if (!persisted || this.#faulted) return journalFailed();
    return result;
  }
}

function journalFailed<T>(): InventoryResult<T> {
  return refuse(
    "INVENTORY_JOURNAL_FAILED",
    "the journal rejected this or an earlier event (or the service faulted meanwhile); the in-memory effect stands (fail-closed) and the service is faulted",
  );
}
