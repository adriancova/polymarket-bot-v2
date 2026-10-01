/**
 * WP-300 acceptance 1 (concurrency form): double reservation is impossible
 * under concurrent requests.
 *
 * Many reserve/consume/release requests are started without awaiting, through
 * a journal whose appends complete after randomized timer delays, so request
 * N+1 starts while request N's journal write is still in flight. The harness
 * asserts that interleaving really happened (else the test would prove
 * nothing), then that:
 * - the granted amounts never exceed the actual balance;
 * - no holder ever holds two ACTIVE reservations on one asset;
 * - a reservation id is granted at most once, even when requested
 *   concurrently many times;
 * - the journal holds exactly the granted events, in grant order.
 */

import { describe, expect, it } from "vitest";

import {
  ReservationService,
  type InventoryJournalEvent,
  type ReservationJournal,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, PUSD, YES, prng, seededBook } from "./helpers.js";

class DelayedJournal implements ReservationJournal {
  readonly events: InventoryJournalEvent[] = [];
  inFlight = 0;
  maxInFlight = 0;
  readonly #random: () => number;
  failNext = false;

  constructor(seed: number) {
    this.#random = prng(seed);
  }

  append(event: InventoryJournalEvent): Promise<void> {
    this.events.push(event);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const fail = this.failNext;
    this.failNext = false;
    const delay = Math.floor(this.#random() * 4);
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.inFlight -= 1;
        if (fail) reject(new Error("journal unavailable"));
        else resolve();
      }, delay);
    });
  }
}

describe("reservation service under concurrent requests", () => {
  it("never over-reserves: 300 concurrent BUY reservations against 100 pUSD", async () => {
    const book = seededBook({ [PUSD]: "100" });
    const journal = new DelayedJournal(7);
    const service = new ReservationService(book, journal);
    const random = prng(11);
    const requests = Array.from({ length: 300 }, (_, i) => ({
      reservationId: `r${i}`,
      holderRef: `order-${i % 40}`,
      accountRef: ACCOUNT,
      assetId: PUSD,
      amount: String(1 + Math.floor(random() * 9)),
    }));
    const results = await Promise.all(requests.map((request) => service.reserve(request)));
    expect(journal.maxInFlight, "the harness must actually interleave").toBeGreaterThan(1);

    let granted = 0;
    const grantedIds: string[] = [];
    const activeHolders = new Set<string>();
    for (const [i, result] of results.entries()) {
      if (!result.ok) continue;
      const request = requests[i];
      if (request === undefined) throw new Error("index");
      granted += Number(request.amount);
      grantedIds.push(request.reservationId);
      expect(activeHolders.has(request.holderRef), `double reservation for ${request.holderRef}`).toBe(false);
      activeHolders.add(request.holderRef);
    }
    expect(granted).toBeLessThanOrEqual(100);
    expect(results.some((r) => !r.ok && r.refusal.code === "INVENTORY_DOUBLE_RESERVATION")).toBe(true);
    expect(results.some((r) => !r.ok && r.refusal.code === "INVENTORY_INSUFFICIENT_AVAILABLE")).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe(String(granted));
    expect(journal.events.map((e) => (e.kind === "RESERVED" ? e.reservation.reservationId : e.kind))).toEqual(grantedIds);
    expect(book.checkInvariants()).toEqual([]);
  });

  it("grants one reservation id once, however many times it is requested concurrently", async () => {
    const book = seededBook({ [YES]: "1000" });
    const journal = new DelayedJournal(3);
    const service = new ReservationService(book, journal);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        service.reserve({ reservationId: "same-id", holderRef: `h${i}`, accountRef: ACCOUNT, assetId: YES, amount: "1" }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.refusal.code === "INVENTORY_DUPLICATE_RESERVATION_ID")).toHaveLength(49);
    expect(book.line(ACCOUNT, YES)?.reserved).toBe("1");
  });

  it("interleaved reserve / consume / release keep the book sound, and a released holder may reserve again", async () => {
    const book = seededBook({ [YES]: "50" });
    const journal = new DelayedJournal(19);
    const service = new ReservationService(book, journal);
    const first = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        service.reserve({ reservationId: `a${i}`, holderRef: `sell-${i}`, accountRef: ACCOUNT, assetId: YES, amount: "5" }),
      ),
    );
    expect(first.every((r) => r.ok)).toBe(true);
    // Now: partial fills, releases and new reservations all at once.
    const mixed = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => service.consume({ reservationId: `a${i}`, amount: "2", pendingId: `fill-${i}` })),
      ...Array.from({ length: 10 }, (_, i) => service.release({ reservationId: `a${i}` })),
      ...Array.from({ length: 10 }, (_, i) =>
        service.reserve({ reservationId: `b${i}`, holderRef: `sell-${i}`, accountRef: ACCOUNT, assetId: YES, amount: "3" }),
      ),
    ]);
    expect(mixed.every((r) => r.ok)).toBe(true);
    // 10 × 2 consumed (pending), 10 × 3 newly reserved, 10 × 3 released.
    expect(book.line(ACCOUNT, YES)).toMatchObject({ actual: "50", reserved: "30", pendingOut: "20", available: "0" });
    expect(book.checkInvariants()).toEqual([]);
    const extra = await service.reserve({ reservationId: "c", holderRef: "late", accountRef: ACCOUNT, assetId: YES, amount: "0.01" });
    expect(extra.ok).toBe(false);
  });

  it("a journal failure faults the service fail-closed: the hold stands and every later call is refused", async () => {
    const book = seededBook({ [PUSD]: "10" });
    const journal = new DelayedJournal(5);
    const service = new ReservationService(book, journal);
    journal.failNext = true;
    const failed = await service.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "4" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.refusal.code).toBe("INVENTORY_JOURNAL_FAILED");
    expect(service.faulted).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("4");
    const later = await service.release({ reservationId: "r1" });
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.refusal.code).toBe("INVENTORY_FAULTED");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("4");
  });

  it("a refused request writes nothing to the journal", async () => {
    const book = seededBook({ [PUSD]: "1" });
    const journal = new DelayedJournal(1);
    const service = new ReservationService(book, journal);
    const refused = await service.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "2" });
    expect(refused.ok).toBe(false);
    expect(journal.events).toEqual([]);
  });
});
