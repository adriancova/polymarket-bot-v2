/**
 * `TRDR-4` — the bounded pieces of the loop's per-order lifecycle, in
 * isolation: the audit-log ring (`RetentionLog`), the settled-order tombstone
 * map (`OrderTombstones`), the (a)-(d) settlement predicate, the
 * order-view tracker's `forget`, and the default bounds.
 *
 * The loop-level behaviour of each is pinned in `loop-order-lifecycle.test.ts`
 * and `loop-long-run.test.ts`; this file pins the mechanics a loop test could
 * only observe indirectly — oldest-first order, the exact eviction count, and
 * the refusal of a bound below 1.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETENTION,
  OrderTombstones,
  RetentionLog,
  UNREADABLE_BOOKED_SHARES,
  retentionBoundsProblem,
  settlementBlocker,
} from "./order-lifecycle.js";
import { OrderViewTracker } from "./orders.js";

describe("RetentionLog — bounded, append-only, oldest-first eviction, counted", () => {
  it("below its bound it is the whole log, in append order", () => {
    const log = new RetentionLog<string>({ name: "test", maximumRetained: 4 });
    for (const entry of ["a", "b", "c"]) log.append(entry);
    expect(log.entries()).toEqual(["a", "b", "c"]);
    expect(log.metrics()).toEqual({ retained: 3, maximumRetained: 4, evicted: 0 });
    expect(log.size).toBe(3);
  });

  it("at its bound it evicts the OLDEST entry per append, and counts every eviction", () => {
    const log = new RetentionLog<number>({ name: "test", maximumRetained: 3 });
    for (let value = 1; value <= 10; value += 1) {
      log.append(value);
      const expected = Array.from({ length: Math.min(value, 3) }, (_, index) => value - Math.min(value, 3) + 1 + index);
      expect(log.entries(), `after ${String(value)}`).toEqual(expected);
      expect(log.metrics()).toEqual({
        retained: Math.min(value, 3),
        maximumRetained: 3,
        evicted: Math.max(0, value - 3),
      });
    }
  });

  it("a bound of 1 keeps exactly the newest entry", () => {
    const log = new RetentionLog<string>({ name: "test", maximumRetained: 1 });
    log.append("first");
    log.append("second");
    log.append("third");
    expect(log.entries()).toEqual(["third"]);
    expect(log.metrics()).toEqual({ retained: 1, maximumRetained: 1, evicted: 2 });
  });

  it("answers a FRESH array: a caller's mutation never reaches the log", () => {
    const log = new RetentionLog<string>({ name: "test", maximumRetained: 2 });
    log.append("x");
    const answer = log.entries();
    answer.push("tampered");
    answer[0] = "tampered";
    expect(log.entries()).toEqual(["x"]);
  });

  it("REFUSES a bound below 1, a fraction and a non-number at construction", () => {
    for (const bound of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => new RetentionLog({ name: "test", maximumRetained: bound }), String(bound)).toThrow(RangeError);
    }
  });
});

describe("OrderTombstones — built like FillDeduplicator", () => {
  it("remembers a settled order's probable owner, and forgets the OLDEST at the bound, counted", () => {
    const tombstones = new OrderTombstones({ maximumRemembered: 2 });
    tombstones.remember("order-1", "instance-a");
    tombstones.remember("order-2", "instance-b");
    expect(tombstones.probableOwner("order-1")).toBe("instance-a");
    expect(tombstones.metrics()).toEqual({ tombstones: 2, maximumTombstones: 2, tombstoneEvictions: 0 });

    tombstones.remember("order-3", "instance-a");
    expect(tombstones.probableOwner("order-1")).toBeUndefined();
    expect(tombstones.probableOwner("order-2")).toBe("instance-b");
    expect(tombstones.probableOwner("order-3")).toBe("instance-a");
    expect(tombstones.metrics()).toEqual({ tombstones: 2, maximumTombstones: 2, tombstoneEvictions: 1 });
    expect(tombstones.size).toBe(2);
  });

  it("a repeat of a remembered id neither evicts nor re-orders", () => {
    const tombstones = new OrderTombstones({ maximumRemembered: 2 });
    tombstones.remember("order-1", "instance-a");
    tombstones.remember("order-2", "instance-a");
    tombstones.remember("order-1", "instance-z");
    expect(tombstones.probableOwner("order-1")).toBe("instance-a");
    expect(tombstones.metrics().tombstoneEvictions).toBe(0);
    tombstones.remember("order-3", "instance-a");
    expect(tombstones.probableOwner("order-1")).toBeUndefined();
  });

  it("REFUSES a bound below 1 at construction", () => {
    for (const bound of [0, -3, 0.5, Number.NaN]) {
      expect(() => new OrderTombstones({ maximumRemembered: bound }), String(bound)).toThrow(RangeError);
    }
  });
});

describe("settlementBlocker — conditions (a) to (d)", () => {
  const settled = {
    terminal: true,
    bookedShares: "50",
    filledShares: "50",
    retired: true,
    cancelPending: false,
  } as const;

  it("answers undefined only when ALL four hold", () => {
    expect(settlementBlocker(settled)).toBeUndefined();
  });

  it("names each failing condition", () => {
    expect(settlementBlocker({ ...settled, terminal: false })).toBe("NOT_TERMINAL");
    expect(settlementBlocker({ ...settled, bookedShares: "30" })).toBe("BOOKED_SHARES_MISMATCH");
    expect(settlementBlocker({ ...settled, retired: false })).toBe("NOT_RETIRED");
    expect(settlementBlocker({ ...settled, cancelPending: true })).toBe("CANCEL_PENDING");
  });

  it("compares booked and filled shares as EXACT decimals", () => {
    expect(settlementBlocker({ ...settled, bookedShares: "0", filledShares: "0" })).toBeUndefined();
    expect(settlementBlocker({ ...settled, bookedShares: "0.5", filledShares: "0.5" })).toBeUndefined();
    expect(
      settlementBlocker({ ...settled, bookedShares: "49.999999999999999999", filledShares: "50" }),
    ).toBe("BOOKED_SHARES_MISMATCH");
    expect(settlementBlocker({ ...settled, bookedShares: "55", filledShares: "50" })).toBe(
      "BOOKED_SHARES_MISMATCH",
    );
  });

  it("is TOTAL: a quantity that is not a canonical decimal cannot prove equality — a mismatch, never a throw", () => {
    for (const [bookedShares, filledShares] of [
      ["50.000", "50"],
      ["50", "50.0"],
      [UNREADABLE_BOOKED_SHARES, "50"],
      ["50", ""],
      ["50", "1e2"],
    ] as const) {
      expect(settlementBlocker({ ...settled, bookedShares, filledShares }), `${bookedShares} vs ${filledShares}`).toBe(
        "BOOKED_SHARES_MISMATCH",
      );
    }
  });

  it("reports the mismatch before a pending cancel, so an operator sees it", () => {
    expect(settlementBlocker({ ...settled, bookedShares: "10", cancelPending: true })).toBe(
      "BOOKED_SHARES_MISMATCH",
    );
  });
});

describe("OrderViewTracker.forget — only a settled order's signature is dropped", () => {
  it("forgets one order; a later delivery of it is a non-repeat, others are untouched", () => {
    const tracker = new OrderViewTracker();
    const view = (orderId: string, status: "OPEN" | "FILLED") => ({
      orderId,
      marketId: "m",
      outcome: "YES" as const,
      side: "BUY" as const,
      price: "0.34",
      requestedShares: "50",
      filledShares: status === "FILLED" ? "50" : "0",
      status,
      placedAt: "2026-05-01T09:00:00Z",
    });
    tracker.deliverable("i", view("a", "FILLED"));
    tracker.deliverable("i", view("b", "OPEN"));
    expect(tracker.metrics()).toEqual({ emitted: 2, repeats: 0, tracked: 2 });
    expect(tracker.forget("a")).toBe(true);
    expect(tracker.forget("a")).toBe(false);
    expect(tracker.metrics()).toEqual({ emitted: 2, repeats: 0, tracked: 1 });
    expect(tracker.deliverable("i", view("b", "OPEN")).repeat).toBe(true);
    expect(tracker.deliverable("i", view("a", "FILLED")).repeat).toBe(false);
  });
});

describe("the default bounds, and the TOTAL-caller check", () => {
  it("are the argued values, each a positive safe integer far above every fixture", () => {
    expect(DEFAULT_RETENTION).toEqual({
      decisions: 100_000,
      traces: 50_000,
      provenance: 50_000,
      tombstones: 100_000,
    });
    // The largest fixture in the repository persists 12 decisions, books 3
    // fills and places 3 orders (both goldens, after R1). Each default is
    // more than a thousand times its fixture maximum.
    expect(DEFAULT_RETENTION.decisions).toBeGreaterThan(12 * 1000);
    expect(DEFAULT_RETENTION.traces).toBeGreaterThan(3 * 1000);
    expect(DEFAULT_RETENTION.provenance).toBeGreaterThan(3 * 1000);
    expect(DEFAULT_RETENTION.tombstones).toBeGreaterThan(3 * 1000);
    expect(retentionBoundsProblem(DEFAULT_RETENTION)).toBeUndefined();
  });

  it("names the first bad bound, and ignores an omitted one", () => {
    expect(retentionBoundsProblem({})).toBeUndefined();
    expect(retentionBoundsProblem({ traces: 1 })).toBeUndefined();
    expect(retentionBoundsProblem({ traces: 0 })).toBe(
      "retention.traces must be a positive safe integer; received 0",
    );
    expect(retentionBoundsProblem({ decisions: 2.5 })).toContain("retention.decisions");
  });
});
