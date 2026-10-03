/**
 * WP-310 deliverable 1 and acceptance 1 and 3: the local budgets, the §9.13
 * grant order, and snapshots taking effect at their effective time. Every
 * number here is the SYNTHETIC snapshot's (`fixtures.test-support.ts`).
 */

import { describe, expect, it } from "vitest";

import type { Grant, PollEvent, RateLimitBudget, RequestDecision } from "./budget.js";
import { SIGNER_A, SIGNER_B, T0, ZERO_HEADROOM, budgetOf, iso, snapshot, warm, type Json } from "./fixtures.test-support.js";
import { feedbackFromObservation, parseRateLimitHeaders } from "./headers.js";
import { PRIORITY_LADDER, type PriorityClass } from "./priority.js";
import { MAX_EPOCH_MS, MAX_TOKEN_MAGNITUDE, MILLI_PER_TOKEN } from "./units.js";

/** The operation each ladder class is filed with in these tests. */
const OPERATION_FOR: Readonly<Record<PriorityClass, { operationId: string; signer?: string }>> = {
  ORDER_HEARTBEAT: { operationId: "heartbeat" },
  EMERGENCY_CANCEL: { operationId: "cancel_all", signer: SIGNER_A },
  RECONCILIATION_READ: { operationId: "read" },
  RISK_REDUCING_ORDER: { operationId: "place", signer: SIGNER_A },
  STALE_QUOTE_CANCEL: { operationId: "cancel", signer: SIGNER_A },
  NEW_ORDER: { operationId: "place", signer: SIGNER_A },
  METADATA_ANALYTICS: { operationId: "read" },
};

function ask(budget: RateLimitBudget, priority: PriorityClass, atMs: number): RequestDecision {
  return budget.request({ ...OPERATION_FOR[priority], priority }, atMs);
}

function granted(events: readonly PollEvent[]): string[] {
  return events.filter((event) => event.kind === "GRANTED").map((event) => event.ticketId);
}

function grantOf(decision: RequestDecision): Grant {
  if (decision.kind !== "GRANTED") throw new Error(`expected GRANTED, got ${decision.kind}`);
  return decision.grant;
}

/** Fill the 10-per-second `shared` window with heartbeats sent 1 ms apart from `from`. */
function exhaustShared(budget: RateLimitBudget, from: number): void {
  for (let index = 0; index < 10; index += 1) {
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, from + index).kind).toBe("GRANTED");
  }
}

describe("the §9.13 ladder under exhaustion (acceptance 1)", () => {
  it("grants one freed slot at a time in exactly the ladder order, whatever the arrival order", () => {
    const budget = budgetOf(snapshot({}, { assumedSignerTier: "Big" }));
    warm(budget, SIGNER_A, T0 - 10_000);
    exhaustShared(budget, T0);
    // Arrivals in REVERSE ladder order: metadata first, heartbeat last.
    const tickets = new Map<string, PriorityClass>();
    for (const priority of [...PRIORITY_LADDER].reverse()) {
      const decision = ask(budget, priority, T0 + 10);
      expect(decision.kind, priority).toBe("QUEUED");
      if (decision.kind === "QUEUED") tickets.set(decision.ticketId, priority);
    }
    // The heartbeat sent at T0 + i leaves the 1000 ms window at T0 + 1000 + i: one slot per millisecond.
    const order: PriorityClass[] = [];
    for (let index = 0; index < PRIORITY_LADDER.length; index += 1) {
      const ids = granted(budget.poll(T0 + 1000 + index));
      expect(ids, `slot ${String(index)}`).toHaveLength(1);
      order.push(tickets.get(ids[0] ?? "") as PriorityClass);
    }
    expect(order).toEqual([...PRIORITY_LADDER]);
  });

  it("grants everything affordable at once, still in ladder order", () => {
    const budget = budgetOf(snapshot({}, { assumedSignerTier: "Big" }));
    warm(budget, SIGNER_A, T0 - 10_000);
    exhaustShared(budget, T0);
    const tickets = new Map<string, PriorityClass>();
    for (const priority of [...PRIORITY_LADDER].reverse()) {
      const decision = ask(budget, priority, T0 + 10);
      if (decision.kind === "QUEUED") tickets.set(decision.ticketId, priority);
    }
    const order = granted(budget.poll(T0 + 2000)).map((id) => tickets.get(id));
    expect(order).toEqual([...PRIORITY_LADDER]);
  });

  it("an emergency cancel-all queued AFTER five new orders is granted before any of them", () => {
    const budget = budgetOf(snapshot({}, { assumedSignerTier: "Big" }));
    warm(budget, SIGNER_A, T0 - 10_000);
    exhaustShared(budget, T0);
    const newOrders = [1, 2, 3, 4, 5].map(() => ask(budget, "NEW_ORDER", T0 + 10));
    const cancelAll = ask(budget, "EMERGENCY_CANCEL", T0 + 11);
    expect(newOrders.every((decision) => decision.kind === "QUEUED")).toBe(true);
    expect(cancelAll.kind).toBe("QUEUED");
    const first = budget.poll(T0 + 1000);
    expect(granted(first)).toEqual([cancelAll.kind === "QUEUED" ? cancelAll.ticketId : ""]);
    // Then the new orders, first come first served.
    const rest = granted(budget.poll(T0 + 1004));
    expect(rest).toEqual(newOrders.slice(0, 4).map((decision) => (decision.kind === "QUEUED" ? decision.ticketId : "")));
  });

  it("a request never jumps a higher-ranked waiter: a new order arriving while an emergency cancel waits is queued behind it", () => {
    const budget = budgetOf(snapshot({}, { assumedSignerTier: "Big" }));
    warm(budget, SIGNER_A, T0 - 10_000);
    exhaustShared(budget, T0);
    const cancel = ask(budget, "EMERGENCY_CANCEL", T0 + 10);
    expect(cancel.kind).toBe("QUEUED");
    // At T0 + 1000 one shared slot frees. The new order asks first, but the cancel holds that slot.
    expect(ask(budget, "NEW_ORDER", T0 + 1000).kind).toBe("QUEUED");
    const events = budget.poll(T0 + 1000);
    expect(granted(events)).toEqual([cancel.kind === "QUEUED" ? cancel.ticketId : ""]);
  });

  it("a waiting emergency cancel blocked on its own cancel bucket still holds the shared IP capacity it needs; a request sharing nothing with it proceeds", () => {
    const budget = budgetOf(snapshot());
    warm(budget, SIGNER_A, T0 - 10_000);
    // Drive the cancel bucket into debt: a cancel-all that canceled 30 orders on a negative-balance tier.
    const sweep = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    expect(budget.complete(sweep, { atMs: T0, canceledCount: 30 }).ok).toBe(true);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-25");
    // 1 (the sweep) + 7 heartbeats: 8 of the 10 shared slots are used, 2 are free.
    for (let index = 0; index < 7; index += 1) budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0 + 1);
    const emergency = ask(budget, "EMERGENCY_CANCEL", T0 + 2);
    expect(emergency.kind).toBe("QUEUED");
    // One free slot is held for the emergency cancel: one new order gets the other, the next one waits.
    expect(ask(budget, "NEW_ORDER", T0 + 3).kind).toBe("GRANTED");
    expect(ask(budget, "NEW_ORDER", T0 + 3).kind).toBe("QUEUED");
    expect(granted(budget.poll(T0 + 3))).toEqual([]);
    expect(budget.view(T0 + 3).ipEndpointClasses.find((entry) => entry.budget.dimension === "IP_ENDPOINT_CLASS" && entry.budget.classId === "shared")?.windows[0]?.used).toBe(9);
    // A read that shares no budget with the waiting cancel is not held back.
    expect(budget.request({ operationId: "read_dual", priority: "METADATA_ANALYTICS" }, T0 + 4).kind).toBe("GRANTED");
    // The cancel bucket climbs out of debt at 2 tokens/s: from -25 it holds 1 token after exactly 13 s.
    expect(granted(budget.poll(T0 + 12_999))).not.toContain(emergency.kind === "QUEUED" ? emergency.ticketId : "");
    expect(granted(budget.poll(T0 + 13_000))[0]).toBe(emergency.kind === "QUEUED" ? emergency.ticketId : "");
  });

  it("headroom: a new order cannot take the last part of a shared budget a higher class may need", () => {
    const budget = budgetOf(snapshot({}, { assumedSignerTier: "Big", headroomPermille: { ...ZERO_HEADROOM, NEW_ORDER: 500, METADATA_ANALYTICS: 500 } }));
    warm(budget, SIGNER_A, T0 - 10_000);
    const decisions = [1, 2, 3, 4, 5, 6].map(() => ask(budget, "NEW_ORDER", T0).kind);
    // shared: limit 10, NEW_ORDER must leave 500‰ = 5 slots: only 5 new orders go.
    expect(decisions).toEqual(["GRANTED", "GRANTED", "GRANTED", "GRANTED", "GRANTED", "QUEUED"]);
    // An emergency cancel still finds room at once.
    expect(ask(budget, "EMERGENCY_CANCEL", T0).kind).toBe("GRANTED");
  });

  it("refuses a class the operation's kind does not permit (a new order cannot borrow a safety rank)", () => {
    const budget = budgetOf();
    const misfiled = [
      budget.request({ operationId: "place", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0),
      budget.request({ operationId: "place", priority: "ORDER_HEARTBEAT", signer: SIGNER_A }, T0),
      budget.request({ operationId: "cancel", priority: "NEW_ORDER", signer: SIGNER_A }, T0),
      budget.request({ operationId: "read", priority: "EMERGENCY_CANCEL" }, T0),
      budget.request({ operationId: "heartbeat", priority: "EMERGENCY_CANCEL" }, T0),
    ];
    for (const decision of misfiled) expect(decision).toMatchObject({ kind: "REFUSED", refusal: { code: "PRIORITY_NOT_PERMITTED" } });
  });
});

describe("token buckets per signer (§8: separate order and cancel buckets)", () => {
  it("a signer first seen starts empty and refills at its tier's rate, exactly", () => {
    const budget = budgetOf();
    expect(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0).kind).toBe("QUEUED");
    expect(budget.view(T0 + 999).signers[0]?.order.tokens).toBe("0.999");
    expect(granted(budget.poll(T0 + 999))).toEqual([]);
    expect(granted(budget.poll(T0 + 1000))).toHaveLength(1);
    expect(budget.view(T0 + 1000).signers[0]?.order.tokens).toBe("0");
  });

  it("order and cancel buckets are independent, and so are two signers", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    for (let index = 0; index < 4; index += 1) expect(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0).kind).toBe("QUEUED");
    expect(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_A }, T0).kind).toBe("GRANTED");
    // SIGNER_B has its own (empty) buckets.
    expect(budget.request({ operationId: "place", priority: "RISK_REDUCING_ORDER", signer: SIGNER_B }, T0).kind).toBe("QUEUED");
  });

  it("a batch is all or nothing, and a batch above the burst is refused (split it)", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 2000);
    expect(budget.view(T0).signers[0]?.order.tokens).toBe("2");
    const batch = budget.request({ operationId: "place_batch", priority: "NEW_ORDER", signer: SIGNER_A, entries: 3 }, T0);
    expect(batch.kind).toBe("QUEUED");
    expect(budget.view(T0).signers[0]?.order.tokens).toBe("2");
    expect(granted(budget.poll(T0 + 1000))).toHaveLength(1);
    expect(budget.request({ operationId: "place_batch", priority: "NEW_ORDER", signer: SIGNER_A, entries: 5 }, T0 + 1000)).toMatchObject({
      kind: "REFUSED",
      refusal: { code: "COST_EXCEEDS_CAPACITY" },
    });
  });

  it("cancel-all: one token when granted, one per canceled order on completion; debt on a negative-balance tier, a floor at zero otherwise", () => {
    for (const [tier, expected] of [
      ["Base", "-3"],
      ["Floor", "0"],
    ] as const) {
      const budget = budgetOf(snapshot({}, { assumedSignerTier: tier }));
      warm(budget, SIGNER_A, T0 - 10_000);
      const grant = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
      expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("5");
      const result = budget.complete(grant, { atMs: T0, canceledCount: 8 });
      expect(result.ok && result.value).toContainEqual(expect.objectContaining({ kind: "CANCELED_DEBITED", tokens: 8 }));
      expect(budget.view(T0).signers[0]?.cancel.tokens, tier).toBe(expected);
    }
  });

  it("a cancel-all completed without its canceled count is flagged, not guessed", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    const result = budget.complete(grant, { atMs: T0 });
    expect(result.ok && result.value).toContainEqual(expect.objectContaining({ kind: "CANCELED_COUNT_UNKNOWN" }));
    expect(budget.complete(grant, { atMs: T0 })).toMatchObject({ ok: false, refusal: { code: "GRANT_ALREADY_COMPLETED" } });
  });

  it("refuses a forged grant", () => {
    const budget = budgetOf();
    const forged = { grantId: "grant-1", ticketId: "ticket-1", operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A, entries: null, charges: [], grantedAtMs: T0, snapshotId: "synthetic-a" } as const;
    expect(budget.complete(forged as unknown as Grant, { atMs: T0, canceledCount: 1 })).toMatchObject({ ok: false, refusal: { code: "UNKNOWN_GRANT" } });
  });
});

describe("IP endpoint classes and the relayer (sliding windows)", () => {
  it("a class with a burst and a sustained window is limited by both", () => {
    const budget = budgetOf();
    const at = (ms: number): string => budget.request({ operationId: "read_dual", priority: "METADATA_ANALYTICS" }, ms).kind;
    expect([at(T0), at(T0), at(T0), at(T0)]).toEqual(["GRANTED", "GRANTED", "GRANTED", "QUEUED"]);
    // At T0 + 1000 the burst window is free again, but the 4-per-10-s window allows only one more.
    expect(granted(budget.poll(T0 + 1000))).toHaveLength(1);
    expect(at(T0 + 1000)).toBe("QUEUED");
    expect(granted(budget.poll(T0 + 9999))).toEqual([]);
    expect(granted(budget.poll(T0 + 10_000))).toHaveLength(1);
  });

  it("the relayer budget is separate", () => {
    const budget = budgetOf();
    const submit = (ms: number): string => budget.request({ operationId: "relayer_submit", priority: "NEW_ORDER" }, ms).kind;
    expect([submit(T0), submit(T0), submit(T0)]).toEqual(["GRANTED", "GRANTED", "QUEUED"]);
    expect(budget.view(T0).relayer?.windows[0]).toMatchObject({ limit: 2, used: 2 });
    expect(granted(budget.poll(T0 + 60_000))).toHaveLength(1);
  });
});

describe("the queue", () => {
  it("is bounded: when full, a higher class evicts the lowest-ranked waiter; an equal or lower class is refused", () => {
    const budget = budgetOf(snapshot({}, { maxQueuedRequests: 2 }));
    exhaustShared(budget, T0);
    const meta1 = budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0 + 10);
    const meta2 = budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0 + 10);
    expect([meta1.kind, meta2.kind]).toEqual(["QUEUED", "QUEUED"]);
    expect(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0 + 10)).toMatchObject({ kind: "REFUSED", refusal: { code: "QUEUE_FULL" } });
    expect(budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, T0 + 10).kind).toBe("QUEUED");
    const events = budget.poll(T0 + 10);
    expect(events).toEqual([
      { kind: "REFUSED", ticketId: meta2.kind === "QUEUED" ? meta2.ticketId : "", refusal: { code: "EVICTED_BY_HIGHER_PRIORITY", message: expect.any(String) as string } },
    ]);
  });

  it("withdraw removes a queued request", () => {
    const budget = budgetOf();
    exhaustShared(budget, T0);
    const decision = budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0 + 10);
    expect(decision.kind === "QUEUED" && budget.withdraw(decision.ticketId)).toBe(true);
    expect(granted(budget.poll(T0 + 5000))).toEqual([]);
  });

  it("nextWakeAtMs names the instant a poll can next grant", () => {
    const budget = budgetOf();
    expect(budget.nextWakeAtMs(T0)).toBeNull();
    exhaustShared(budget, T0);
    budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0 + 10);
    expect(budget.nextWakeAtMs(T0 + 10)).toBe(T0 + 1000);
    expect(budget.nextWakeAtMs(T0 + 1000)).toBe(T0 + 1000);
  });

  it("refuses malformed input without throwing", () => {
    const budget = budgetOf();
    expect(budget.request({ operationId: "place", priority: "NEW_ORDER" }, T0)).toMatchObject({ refusal: { code: "SIGNER_REQUIRED" } });
    expect(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS", signer: SIGNER_A }, T0)).toMatchObject({ refusal: { code: "SIGNER_NOT_EXPECTED" } });
    expect(budget.request({ operationId: "place_batch", priority: "NEW_ORDER", signer: SIGNER_A }, T0)).toMatchObject({ refusal: { code: "ENTRIES_REQUIRED" } });
    expect(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A, entries: 2 }, T0)).toMatchObject({ refusal: { code: "ENTRIES_NOT_EXPECTED" } });
    expect(budget.request({ operationId: "nope", priority: "NEW_ORDER" }, T0)).toMatchObject({ refusal: { code: "UNKNOWN_OPERATION" } });
    expect(budget.request({ operationId: "read", priority: "URGENT" as PriorityClass }, T0)).toMatchObject({ refusal: { code: "INVALID_REQUEST" } });
    expect(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, -1)).toMatchObject({ refusal: { code: "INVALID_TIME" } });
    const getter = Object.defineProperty({ priority: "NEW_ORDER" }, "operationId", { get: () => "read", enumerable: true });
    expect(budget.request(getter as never, T0)).toMatchObject({ refusal: { code: "INVALID_REQUEST" } });
  });
});

describe("snapshots take effect at their effective time (acceptance 3)", () => {
  const T1 = T0 + 30_000;
  const later = (): ReturnType<typeof snapshot> =>
    snapshot({
      snapshotId: "synthetic-b",
      effectiveFrom: iso(T1),
      ipEndpointClasses: [
        { classId: "shared", windows: [{ limit: 1, windowMs: 1000 }] },
        { classId: "orders", windows: [{ limit: 100, windowMs: 1000 }] },
        { classId: "cancels", windows: [{ limit: 100, windowMs: 1000 }] },
        { classId: "reads", windows: [{ limit: 100, windowMs: 1000 }] },
        { classId: "dual", windows: [{ limit: 3, windowMs: 1000 }] },
      ],
      signerTiers: [
        { tier: "Base", orderTokensPerSecond: 3, orderBurst: 30, cancelTokensPerSecond: 2, cancelBurst: 6, negativeCancelBalance: true },
        { tier: "Floor", orderTokensPerSecond: 1, orderBurst: 4, cancelTokensPerSecond: 2, cancelBurst: 6, negativeCancelBalance: false },
        { tier: "Big", orderTokensPerSecond: 10, orderBurst: 40, cancelTokensPerSecond: 20, cancelBurst: 60, negativeCancelBalance: true },
      ],
    });

  it("the old limits apply until one millisecond before, the new ones from the effective instant", () => {
    const budget = budgetOf(snapshot(), later());
    expect(budget.configurationAt(T1 - 1)?.snapshotId).toBe("synthetic-a");
    expect(budget.configurationAt(T1)?.snapshotId).toBe("synthetic-b");
    // shared: 10 per second under A, 1 under B.
    expect(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T1 - 2).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T1 - 1).kind).toBe("GRANTED");
    expect(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T1).kind).toBe("QUEUED");
  });

  it("token refill is computed segment by segment: the old rate before, the new rate after", () => {
    const budget = budgetOf(snapshot(), later());
    warm(budget, SIGNER_A, T1 - 2000);
    // Read ONLY after the boundary: 2 s at 1 token/s under A, then 2 s at 3 tokens/s under B. (One rate for
    // the whole span would give 4 under A, capped at A's burst of 4, or 12 under B.)
    expect(budget.view(T1 + 2000).signers[0]?.order.tokens).toBe("8");
  });

  it("the same refill read at the boundary agrees", () => {
    const budget = budgetOf(snapshot(), later());
    warm(budget, SIGNER_A, T1 - 2000);
    expect(budget.view(T1).signers[0]?.order.tokens).toBe("2");
    expect(budget.view(T1 + 2000).signers[0]?.order.tokens).toBe("8");
  });

  it("a snapshot added later must take effect after every instant already processed", () => {
    const budget = budgetOf();
    budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0);
    expect(budget.addConfiguration({ ...later(), effectiveFrom: iso(T0) })).toMatchObject({ ok: false, refusal: { code: "EFFECTIVE_TIME_NOT_IN_FUTURE" } });
    expect(budget.addConfiguration(later())).toMatchObject({ ok: true, value: { snapshotId: "synthetic-b", effectiveFromMs: T1 } });
    expect(budget.configurationAt(T1)?.snapshotId).toBe("synthetic-b");
  });

  it("before the first snapshot nothing is in effect, and every request is refused", () => {
    const budget = budgetOf(snapshot({ effectiveFrom: iso(T0) }));
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0 - 1)).toMatchObject({ kind: "REFUSED", refusal: { code: "NO_ACTIVE_CONFIGURATION" } });
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0).kind).toBe("GRANTED");
  });

  it("a queued request the new snapshot no longer admits is refused at the next poll, not left to block others", () => {
    const withoutRead = later();
    withoutRead["operations"] = (withoutRead["operations"] as readonly { readonly operationId: string }[]).filter((op) => op.operationId !== "read") as never;
    const budget = budgetOf(snapshot(), withoutRead);
    exhaustShared(budget, T1 - 100);
    const queued = budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T1 - 50);
    expect(queued.kind).toBe("QUEUED");
    expect(budget.poll(T1)).toEqual([
      { kind: "REFUSED", ticketId: queued.kind === "QUEUED" ? queued.ticketId : "", refusal: { code: "UNKNOWN_OPERATION", message: expect.any(String) as string } },
    ]);
  });
});

describe("a snapshot binds at its effective instant, and only with complete history (r1: CX310-R1-01, CX310-R1-03, N01)", () => {
  const T1 = T0 + 30_000;
  /** The synthetic snapshot with the Base tier's order burst (and rate) replaced, effective at `atMs`. */
  const withOrderBucket = (snapshotId: string, atMs: number, orderBurst: number, orderTokensPerSecond = 1): ReturnType<typeof snapshot> => {
    const document = snapshot({ snapshotId, effectiveFrom: iso(atMs) });
    const tiers = document["signerTiers"] as { [key: string]: unknown }[];
    document["signerTiers"] = tiers.map((tier) => (tier["tier"] === "Base" ? { ...tier, orderBurst, orderTokensPerSecond } : tier)) as never;
    return document;
  };
  const place = (budget: RateLimitBudget, atMs: number): RequestDecision => budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, atMs);

  it("requests AT the instant a lowered burst takes effect see the new burst (CX310-R1-01)", () => {
    const budget = budgetOf(snapshot(), withOrderBucket("lowered", T1, 1));
    warm(budget, SIGNER_A, T1 - 10_000);
    expect([0, 1, 2, 3].map(() => place(budget, T1).kind)).toEqual(["GRANTED", "QUEUED", "QUEUED", "QUEUED"]);
    expect(budget.view(T1).signers[0]?.order).toMatchObject({ tokens: "0", capacity: 1 });
  });

  it("a poll at exactly that instant (the one nextWakeAtMs names) grants only what the new burst holds (CX310-R1-01)", () => {
    const budget = budgetOf(snapshot(), withOrderBucket("lowered", T1, 1));
    warm(budget, SIGNER_A, T1 - 10_000);
    const grant = grantOf(place(budget, T1 - 2000));
    budget.complete(grant, { atMs: T1 - 2000, error: { kind: "RATE_LIMITED", retryAfterSeconds: 2 } });
    const queued = [0, 1, 2, 3].map(() => place(budget, T1 - 2000));
    expect(queued.every((decision) => decision.kind === "QUEUED")).toBe(true);
    expect(budget.nextWakeAtMs(T1 - 2000)).toBe(T1);
    expect(granted(budget.poll(T1))).toHaveLength(1);
    expect(budget.view(T1).signers[0]?.order).toMatchObject({ tokens: "0", capacity: 1 });
  });

  it("a lowered burst caps the level for the whole segment it governs, before a later raise refills from there (N01)", () => {
    const budget = budgetOf(snapshot(), withOrderBucket("lowered", T1, 1), withOrderBucket("raised", T1 + 10_000, 4));
    warm(budget, SIGNER_A, T1 - 10_000);
    // Read only at the end: 4 under A, capped at 1 from T1, 1 + 1 token/s for 1 s under the raised burst.
    expect(budget.view(T1 + 11_000).signers[0]?.order.tokens).toBe("2");
  });

  it("a snapshot whose longer window would count dropped history is refused; one late enough is accepted and counts exactly (CX310-R1-03)", () => {
    const short = snapshot();
    short["ipEndpointClasses"] = (short["ipEndpointClasses"] as { readonly classId: string }[]).map((entry) => ({ classId: entry.classId, windows: [{ limit: 2, windowMs: 1000 }] })) as never;
    short["relayer"] = { windows: [{ limit: 2, windowMs: 1000 }] };
    const budget = budgetOf(short);
    const read = (atMs: number): string => budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, atMs).kind;
    // The third request drops the first two from history (no window on the timeline can count them any more).
    expect([read(T0), read(T0), read(T0 + 1001)]).toEqual(["GRANTED", "GRANTED", "GRANTED"]);
    const longer = (atMs: number): ReturnType<typeof snapshot> => {
      const document = structuredClone(short) as ReturnType<typeof snapshot>;
      document["snapshotId"] = `longer-${String(atMs - T0)}`;
      document["effectiveFrom"] = iso(atMs);
      document["ipEndpointClasses"] = (short["ipEndpointClasses"] as { readonly classId: string }[]).map((entry) => ({ classId: entry.classId, windows: [{ limit: 2, windowMs: 10_000 }] })) as never;
      return document;
    };
    // At T0 + 2000 a 10 s window would count the two dropped requests at T0.
    expect(budget.addConfiguration(longer(T0 + 2000))).toMatchObject({ ok: false, refusal: { code: "HISTORY_NOT_RETAINED" } });
    expect(budget.configurationAt(T0 + 2000)?.snapshotId).toBe("synthetic-a");
    expect(budget.addConfiguration(longer(T0 + 9999))).toMatchObject({ ok: false, refusal: { code: "HISTORY_NOT_RETAINED" } });
    // From T0 + 10,000 the window counts only requests after T0, all of them still held.
    expect(budget.addConfiguration(longer(T0 + 10_000)).ok).toBe(true);
    expect(read(T0 + 5000)).toBe("GRANTED");
    // The new window at T0 + 10,000 counts T0 + 1001 and T0 + 5000: full.
    expect(read(T0 + 10_000)).toBe("QUEUED");
    expect(budget.view(T0 + 10_000).ipEndpointClasses.find((entry) => entry.budget.dimension === "IP_ENDPOINT_CLASS" && entry.budget.classId === "shared")?.windows).toEqual([
      { limit: 2, windowMs: 10_000, used: 2 },
    ]);
  });
});

describe("budget mechanics pinned in r1 (OP-R1-04: N02, N05, N06, N07, N08)", () => {
  /** The synthetic snapshot with the Base tier's order refill at 3 tokens/s: refills of a token are not whole milliseconds. */
  const thirds = (): ReturnType<typeof snapshot> => {
    const document = snapshot();
    const tiers = document["signerTiers"] as { [key: string]: unknown }[];
    document["signerTiers"] = tiers.map((tier) => (tier["tier"] === "Base" ? { ...tier, orderTokensPerSecond: 3 } : tier)) as never;
    return document;
  };

  it("time never runs backwards: a completion reported with an earlier instant waits from the latest instant seen (N02)", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const grant = grantOf(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0));
    expect(budget.request({ operationId: "read", priority: "METADATA_ANALYTICS" }, T0 + 100).kind).toBe("GRANTED");
    budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 1 } });
    expect(budget.view(T0 + 100).signers[0]?.order.blockedUntilMs).toBe(T0 + 1100);
  });

  it("refill is exact to the thousandth of a token, never rounded up to the burst early (N06)", () => {
    const budget = budgetOf(thirds());
    warm(budget, SIGNER_A, T0);
    expect(budget.view(T0 + 333).signers[0]?.order.tokens).toBe("0.999");
    expect(budget.view(T0 + 1333).signers[0]?.order.tokens).toBe("3.999");
    expect(budget.view(T0 + 1334).signers[0]?.order.tokens).toBe("4");
  });

  it("nextWakeAtMs rounds a refill wait UP: polling then grants (N05)", () => {
    const budget = budgetOf(thirds());
    warm(budget, SIGNER_A, T0);
    const queued = budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0);
    expect(queued.kind).toBe("QUEUED");
    // One token at 3 per second: 333.3 ms, so 334.
    expect(budget.nextWakeAtMs(T0)).toBe(T0 + 334);
    expect(granted(budget.poll(T0 + 333))).toEqual([]);
    expect(granted(budget.poll(T0 + 334))).toEqual([queued.kind === "QUEUED" ? queued.ticketId : ""]);
  });

  it("request() never jumps an earlier waiter of the SAME class: first come, first served (N07)", () => {
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0);
    const first = budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0);
    expect(first.kind).toBe("QUEUED");
    // At T0 + 1000 one token has refilled; a later new order asks before any poll: the earlier one holds it.
    expect(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0 + 1000).kind).toBe("QUEUED");
    expect(granted(budget.poll(T0 + 1000))).toEqual([first.kind === "QUEUED" ? first.ticketId : ""]);
  });

  it("on a tier without a negative cancel balance, the post-cancel floor never raises a debt the venue reported (N08)", () => {
    const budget = budgetOf(snapshot({}, { assumedSignerTier: "Floor" }));
    warm(budget, SIGNER_A, T0 - 10_000);
    const sweep = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    const single = grantOf(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_A }, T0));
    budget.complete(single, { atMs: T0, feedback: parseRateLimitHeaders({ httpStatus: 200, headers: { "Poly-RateLimit-Remaining": "-3" } }) });
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-3");
    expect(budget.complete(sweep, { atMs: T0, canceledCount: 8 }).ok).toBe(true);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-3");
  });

  it("a debt already in the estimate stays when the venue then names a tier that floors at zero (N08, r2)", () => {
    // On the Base tier (negative balance allowed) a cancel-all leaves a debt in the estimate itself.
    const budget = budgetOf();
    warm(budget, SIGNER_A, T0 - 10_000);
    const first = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    const second = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    budget.complete(first, { atMs: T0, canceledCount: 10 });
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-6");
    // The venue names the signer's tier: Floor, which floors the post-cancel balance at zero.
    budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "CANCEL" }, feedbackFromObservation({ bucket: "cancel", remaining: null, resetUnixSeconds: null, tier: "Floor", warning: false }), T0);
    expect(budget.view(T0).signers[0]?.tier).toBe("Floor");
    expect(budget.complete(second, { atMs: T0, canceledCount: 2 }).ok).toBe(true);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-6");
  });
});

describe("nextWakeAtMs never sleeps through a grant: each waiter's earliest grant is net of the reservations above it (CX310-R2-03)", () => {
  /** The synthetic snapshot with `shared` at 2 requests per second (every other class as before). */
  const tight = (): RateLimitBudget =>
    budgetOf(
      snapshot({
        ipEndpointClasses: [
          { classId: "shared", windows: [{ limit: 2, windowMs: 1000 }] },
          { classId: "orders", windows: [{ limit: 100, windowMs: 1000 }] },
          { classId: "cancels", windows: [{ limit: 100, windowMs: 1000 }] },
          { classId: "reads", windows: [{ limit: 100, windowMs: 1000 }] },
          { classId: "dual", windows: [{ limit: 3, windowMs: 1000 }, { limit: 4, windowMs: 10_000 }] },
        ],
      }),
    );

  /** A composition that sleeps until nextWakeAtMs, polls, and re-arms: the instant each ticket is granted (within the horizon). */
  function driveByTimer(budget: RateLimitBudget, from: number, until: number): Map<string, number> {
    const grantedAt = new Map<string, number>();
    let now = from;
    for (let wakes = 0; wakes < 1000; wakes += 1) {
      const next = budget.nextWakeAtMs(now);
      if (next === null || next > until) break;
      now = next;
      for (const event of budget.poll(now)) if (event.kind === "GRANTED") grantedAt.set(event.ticketId, now);
    }
    return grantedAt;
  }

  /** The same budget polled every millisecond. */
  function driveByPolling(budget: RateLimitBudget, from: number, until: number): Map<string, number> {
    const grantedAt = new Map<string, number>();
    for (let now = from; now <= until; now += 1) for (const event of budget.poll(now)) if (event.kind === "GRANTED") grantedAt.set(event.ticketId, now);
    return grantedAt;
  }

  const ticket = (decision: RequestDecision): string => {
    if (decision.kind !== "QUEUED") throw new Error(`expected QUEUED, got ${decision.kind}`);
    return decision.ticketId;
  };

  /** Each scenario queues work at T0 and returns the ticket of the request that must not be slept through. */
  const SCENARIOS: readonly (readonly [string, (budget: RateLimitBudget) => string])[] = [
    [
      "a heartbeat held back an hour by its operation's 429 reserves `shared`; an emergency cancel is grantable once a slot leaves the window",
      (budget) => {
        const heartbeat = grantOf(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0));
        budget.complete(heartbeat, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 3600 } });
        ticket(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0));
        return ticket(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
      },
    ],
    [
      "a signer's emergency cancel held back an hour by its bucket's 429 (no operation wait); another signer's emergency cancel",
      (budget) => {
        const first = grantOf(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
        budget.complete(first, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 3600 } });
        ticket(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
        return ticket(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_B }, T0));
      },
    ],
    [
      "a 30-second bucket wait above a stale-quote cancel of another signer",
      (budget) => {
        const first = grantOf(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
        budget.complete(first, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 30 } });
        ticket(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
        return ticket(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_B }, T0));
      },
    ],
    [
      "reconciliation reads held back an hour reserve `shared` ahead of a stale-quote cancel (OP-R2-04's shape)",
      (budget) => {
        const read = grantOf(budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, T0));
        budget.complete(read, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 3600 } });
        ticket(budget.request({ operationId: "read", priority: "RECONCILIATION_READ" }, T0));
        return ticket(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_B }, T0));
      },
    ],
  ];

  it.each(SCENARIOS)("%s: the timer wakes at +1,000 ms and grants it then", (_label, script) => {
    const budget = tight();
    warm(budget, SIGNER_A, T0 - 10_000);
    warm(budget, SIGNER_B, T0 - 10_000);
    const target = script(budget);
    expect(budget.nextWakeAtMs(T0)).toBe(T0 + 1000);
    expect(budget.poll(T0 + 999)).toEqual([]);
    expect(driveByTimer(budget, T0, T0 + 3_600_000).get(target)).toBe(T0 + 1000);
  });

  it.each(SCENARIOS)("%s: a timer-driven loop grants every request at exactly the instant a 1 ms poller does", (_label, script) => {
    const twins = [tight(), tight()] as const;
    const targets = twins.map((budget) => {
      warm(budget, SIGNER_A, T0 - 10_000);
      warm(budget, SIGNER_B, T0 - 10_000);
      return script(budget);
    });
    expect(targets[0]).toBe(targets[1]);
    const byTimer = driveByTimer(twins[0], T0, T0 + 3000);
    const byPolling = driveByPolling(twins[1], T0, T0 + 3000);
    expect(byPolling.get(targets[1] ?? "")).toBe(T0 + 1000);
    expect([...byTimer.entries()]).toEqual([...byPolling.entries()]);
  });

  /** The synthetic snapshot plus a `slow` class (one request per 10 s) that two cancel operations also draw on. */
  const withSlowCancels = (): RateLimitBudget => {
    const document = snapshot();
    const classes = document["ipEndpointClasses"] as Json[];
    const operations = document["operations"] as Json[];
    return budgetOf({
      ...document,
      ipEndpointClasses: [...classes, { classId: "slow", windows: [{ limit: 1, windowMs: 10_000 }] }],
      operations: [
        ...operations,
        { operationId: "cancel_slow", kind: "CANCEL", ipEndpointClasses: ["slow"], signerBucket: "CANCEL", relayer: false, tokenCost: { base: 1, perEntry: 0, perCanceled: 0 } },
        { operationId: "cancel_slow_batch", kind: "CANCEL", ipEndpointClasses: ["slow"], signerBucket: "CANCEL", relayer: false, tokenCost: { base: 0, perEntry: 1, perCanceled: 0 } },
      ],
    });
  };

  it("on a signer bucket, a lower waiter's wake is when the bucket holds its cost AND the reservation above it", () => {
    const budget = withSlowCancels();
    warm(budget, SIGNER_A, T0 - 10_000);
    // The slow class is used until T0 + 10,000; the cancel bucket (2 per second) is drained.
    grantOf(budget.request({ operationId: "cancel_slow", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    for (let index = 0; index < 5; index += 1) grantOf(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("0");
    // The emergency cancel waits for the slow window and reserves one token; the stale-quote cancel needs a second.
    ticket(budget.request({ operationId: "cancel_slow", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    const stale = ticket(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_A }, T0));
    expect(budget.nextWakeAtMs(T0)).toBe(T0 + 1000);
    expect(budget.poll(T0 + 999)).toEqual([]);
    expect(granted(budget.poll(T0 + 1000))).toEqual([stale]);
  });

  it("on a signer bucket, a reservation that leaves no room for a lower waiter's cost: the wake is the higher waiter's", () => {
    const budget = withSlowCancels();
    warm(budget, SIGNER_A, T0 - 10_000);
    grantOf(budget.request({ operationId: "cancel_slow", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    for (let index = 0; index < 5; index += 1) grantOf(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    // A six-id emergency batch cancel reserves the whole burst (6) until the slow window frees at T0 + 10,000.
    const batch = ticket(budget.request({ operationId: "cancel_slow_batch", priority: "EMERGENCY_CANCEL", signer: SIGNER_A, entries: 6 }, T0));
    ticket(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_A }, T0));
    expect(budget.nextWakeAtMs(T0)).toBe(T0 + 10_000);
    expect(granted(budget.poll(T0 + 10_000))).toEqual([batch]);
  });

  it("the queue is walked in RANK order: a lower class that arrived first never reserves ahead of an emergency cancel", () => {
    const budget = tight();
    // SIGNER_B stays cold: its buckets start empty when first touched (2 cancel tokens per second).
    warm(budget, SIGNER_A, T0 - 10_000);
    const first = grantOf(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    budget.complete(first, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 3600 } });
    // SIGNER_A's stale-quote cancel arrives first and waits an hour on its bucket.
    ticket(budget.request({ operationId: "cancel", priority: "STALE_QUOTE_CANCEL", signer: SIGNER_A }, T0));
    // SIGNER_B's emergency cancel arrives second and waits only for one token (500 ms); `shared` has room for it.
    const emergency = ticket(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_B }, T0));
    expect(budget.nextWakeAtMs(T0)).toBe(T0 + 500);
    expect(driveByTimer(budget, T0, T0 + 3000).get(emergency)).toBe(T0 + 500);
  });

  it("the reservations of the requests ranked above it can leave no room at all: the wake is then the instant one of THEM can go", () => {
    const budget = tight();
    warm(budget, SIGNER_A, T0 - 10_000);
    // Two heartbeats held back an hour reserve the whole of `shared` (2 per second).
    const heartbeat = grantOf(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0));
    budget.complete(heartbeat, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 3600 } });
    ticket(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0));
    ticket(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, T0));
    const cancel = ticket(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    expect(budget.nextWakeAtMs(T0)).toBe(T0 + 3_600_000);
    expect(driveByPolling(budget, T0, T0 + 3000).size).toBe(0);
    const granted = budget.poll(T0 + 3_600_000).filter((event) => event.kind === "GRANTED").map((event) => event.ticketId);
    // Both heartbeats take the window; the cancel follows when they leave it.
    expect(granted).not.toContain(cancel);
    expect(budget.nextWakeAtMs(T0 + 3_600_000)).toBe(T0 + 3_601_000);
  });
});

describe("every derived figure stays exact (OP-R2-02)", () => {
  /** A tier at the bound: rate and burst MAX_TOKEN_MAGNITUDE, and the slowest cancel refill (one token per second). */
  const extreme = (): RateLimitBudget =>
    budgetOf(
      snapshot({
        signerTiers: [
          { tier: "Base", orderTokensPerSecond: MAX_TOKEN_MAGNITUDE, orderBurst: MAX_TOKEN_MAGNITUDE, cancelTokensPerSecond: 1, cancelBurst: MAX_TOKEN_MAGNITUDE, negativeCancelBalance: true },
        ],
      }),
    );

  it("an instant after MAX_EPOCH_MS is refused; MAX_EPOCH_MS itself is accepted", () => {
    const budget = budgetOf();
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, MAX_EPOCH_MS + 1)).toMatchObject({ kind: "REFUSED", refusal: { code: "INVALID_TIME" } });
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, Number.MAX_SAFE_INTEGER)).toMatchObject({ kind: "REFUSED", refusal: { code: "INVALID_TIME" } });
    expect(budget.request({ operationId: "heartbeat", priority: "ORDER_HEARTBEAT" }, MAX_EPOCH_MS).kind).toBe("GRANTED");
    expect(budget.configurationAt(MAX_EPOCH_MS + 1)).toBeUndefined();
  });

  it("at MAX_EPOCH_MS, the deepest debt's refill deadline and the longest Retry-After are exact", () => {
    const budget = extreme();
    warm(budget, SIGNER_A, MAX_EPOCH_MS - 1);
    // The deepest debt the budget holds: MAX_TOKEN_MAGNITUDE tokens below zero.
    budget.observeSignerFeedback(
      { signer: SIGNER_A, bucket: "CANCEL" },
      feedbackFromObservation({ bucket: "cancel", remaining: -MAX_TOKEN_MAGNITUDE, resetUnixSeconds: null, tier: null, warning: false }),
      MAX_EPOCH_MS,
    );
    expect(budget.view(MAX_EPOCH_MS).signers[0]?.cancel.tokens).toBe(`-${String(MAX_TOKEN_MAGNITUDE)}`);
    expect(budget.request({ operationId: "cancel", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, MAX_EPOCH_MS).kind).toBe("QUEUED");
    const wake = budget.nextWakeAtMs(MAX_EPOCH_MS);
    expect(Number.isSafeInteger(wake)).toBe(true);
    // From MAX_TOKEN_MAGNITUDE tokens below zero to one token, at one token per second.
    expect(wake).toBe(MAX_EPOCH_MS + (MAX_TOKEN_MAGNITUDE + 1) * MILLI_PER_TOKEN);
    const order = grantOf(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, MAX_EPOCH_MS));
    const result = budget.complete(order, { atMs: MAX_EPOCH_MS, error: { kind: "RATE_LIMITED", retryAfterSeconds: 86_400 } });
    expect(result.ok && result.value).toContainEqual(expect.objectContaining({ kind: "WAIT_APPLIED", untilMs: MAX_EPOCH_MS + 86_400_000 }));
  });

  it("a Retry-After beyond WP-260's bound, or a canceled count that would push a level past the bound, is refused before anything changes", () => {
    const budget = extreme();
    warm(budget, SIGNER_A, T0 - 10_000);
    const order = grantOf(budget.request({ operationId: "place", priority: "NEW_ORDER", signer: SIGNER_A }, T0));
    expect(budget.complete(order, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 86_401 } })).toMatchObject({ ok: false, refusal: { code: "INVALID_COMPLETION" } });
    const forged = { httpStatus: 429, remaining: null, resetUnixSeconds: null, tier: null, warning: false, retryAfterSeconds: 86_401, flags: [] };
    expect(budget.observeSignerFeedback({ signer: SIGNER_A, bucket: "ORDER" }, forged, T0)).toMatchObject({ ok: false, refusal: { code: "INVALID_REQUEST" } });
    // Ten seconds at one token per second: 10; two cancel-alls leave 8.
    const first = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    const second = grantOf(budget.request({ operationId: "cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER_A }, T0));
    expect(budget.complete(first, { atMs: T0, canceledCount: MAX_TOKEN_MAGNITUDE }).ok).toBe(true);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe(`-${String(MAX_TOKEN_MAGNITUDE - 8)}`);
    // Nine more would take the level one token past the deepest debt it may hold: refused, nothing changed.
    expect(budget.complete(second, { atMs: T0, canceledCount: 9 })).toMatchObject({ ok: false, refusal: { code: "INVALID_COMPLETION" } });
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe(`-${String(MAX_TOKEN_MAGNITUDE - 8)}`);
    expect(budget.complete(second, { atMs: T0, canceledCount: 8 }).ok).toBe(true);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe(`-${String(MAX_TOKEN_MAGNITUDE)}`);
  });
});
