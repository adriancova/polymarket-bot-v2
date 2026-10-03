/**
 * Contract: the §9.13 ladder over the DOCUMENTED snapshot (WP-310 acceptance
 * 1, "Safety cancels outrank new orders"). The CLOB general IP class (9,000
 * requests / 10 s) is exhausted; every ladder class is filed on an operation
 * that draws on it.
 */

import { describe, expect, it } from "vitest";

import { RateLimitBudget, type PollEvent, type PriorityClass, type RequestDecision } from "../../../packages/polymarket-secure/src/index.js";
import { PRIORITY_LADDER } from "../../../packages/polymarket-secure/src/rate-limit/index.js";

import { SIGNER, T0, documentedBudget, rateLimitSnapshot } from "./support.js";

const OPERATION_FOR: Readonly<Record<PriorityClass, { readonly operationId: string; readonly signer?: string }>> = {
  ORDER_HEARTBEAT: { operationId: "clob.heartbeat" },
  EMERGENCY_CANCEL: { operationId: "clob.cancel_all", signer: SIGNER },
  RECONCILIATION_READ: { operationId: "clob.get_order" },
  RISK_REDUCING_ORDER: { operationId: "clob.post_order", signer: SIGNER },
  STALE_QUOTE_CANCEL: { operationId: "clob.cancel_order", signer: SIGNER },
  NEW_ORDER: { operationId: "clob.post_order", signer: SIGNER },
  METADATA_ANALYTICS: { operationId: "clob.book" },
};

function ask(budget: RateLimitBudget, priority: PriorityClass, atMs: number): RequestDecision {
  return budget.request({ ...OPERATION_FOR[priority], priority }, atMs);
}

function granted(events: readonly PollEvent[]): string[] {
  return events.filter((event) => event.kind === "GRANTED").map((event) => event.ticketId);
}

function warm(budget: RateLimitBudget, atMs: number): void {
  for (const [operationId, priority] of [
    ["clob.post_order", "NEW_ORDER"],
    ["clob.cancel_order", "STALE_QUOTE_CANCEL"],
  ] as const) {
    const decision = budget.request({ operationId, priority, signer: SIGNER }, atMs);
    if (decision.kind !== "QUEUED") throw new Error("a signer first seen starts empty");
    budget.withdraw(decision.ticketId);
  }
}

/** Fill `clob.general` (9,000 / 10 s): `first` heartbeats at `at`, the rest one millisecond later. */
function exhaustClobGeneral(budget: RateLimitBudget, at: number, first: number): void {
  for (let index = 0; index < 9000; index += 1) {
    const decision = budget.request({ operationId: "clob.heartbeat", priority: "ORDER_HEARTBEAT" }, index < first ? at : at + 1);
    if (decision.kind !== "GRANTED") throw new Error(`heartbeat ${String(index)} was not granted`);
  }
  expect(budget.view(at + 1).ipEndpointClasses.find((entry) => entry.budget.dimension === "IP_ENDPOINT_CLASS" && entry.budget.classId === "clob.general")?.windows[0]?.used).toBe(9000);
}

function zeroHeadroomBudget(): RateLimitBudget {
  const document = rateLimitSnapshot();
  const policy = document["policy"] as Record<string, unknown>;
  policy["headroomPermille"] = Object.fromEntries(PRIORITY_LADDER.map((priority) => [priority, 0]));
  const created = RateLimitBudget.create([document]);
  if (!created.ok) throw new Error(created.refusal.message);
  return created.value;
}

describe("the documented snapshot under exhaustion", () => {
  it("when the window frees, the queue is served in exactly the §9.13 order, whatever the arrival order", () => {
    const budget = documentedBudget();
    warm(budget, T0 - 60_000);
    exhaustClobGeneral(budget, T0, 9000);
    const tickets = new Map<string, PriorityClass>();
    for (const priority of [...PRIORITY_LADDER].reverse()) {
      const decision = ask(budget, priority, T0 + 2);
      expect(decision.kind, priority).toBe("QUEUED");
      if (decision.kind === "QUEUED") tickets.set(decision.ticketId, priority);
    }
    expect(granted(budget.poll(T0 + 9999))).toEqual([]);
    expect(granted(budget.poll(T0 + 10_000)).map((id) => tickets.get(id))).toEqual([...PRIORITY_LADDER]);
  });

  it("one freed slot goes to the emergency cancel-all queued after five new orders (a heartbeat arriving then outranks even that)", () => {
    const budget = zeroHeadroomBudget();
    warm(budget, T0 - 60_000);
    exhaustClobGeneral(budget, T0, 2);
    const orders = [1, 2, 3, 4, 5].map(() => ask(budget, "NEW_ORDER", T0 + 2));
    const cancelAll = ask(budget, "EMERGENCY_CANCEL", T0 + 3);
    expect([...orders, cancelAll].every((decision) => decision.kind === "QUEUED")).toBe(true);
    // At T0 + 10,000 the two heartbeats sent at T0 leave the window: two slots.
    const heartbeat = ask(budget, "ORDER_HEARTBEAT", T0 + 10_000);
    expect(heartbeat.kind).toBe("GRANTED");
    expect(granted(budget.poll(T0 + 10_000))).toEqual([cancelAll.kind === "QUEUED" ? cancelAll.ticketId : ""]);
    expect(budget.view(T0 + 10_000).queue.map((entry) => entry.priority)).toEqual(["NEW_ORDER", "NEW_ORDER", "NEW_ORDER", "NEW_ORDER", "NEW_ORDER"]);
  });

  it("with the snapshot's headroom, new orders cannot drain the last 20% of CLOB general: an emergency cancel arriving later is granted at once", () => {
    const budget = documentedBudget();
    warm(budget, T0 - 60_000);
    // 7,180 heartbeats leave 1,820 slots; new orders must keep 200‰ of 9,000 = 1,800 free, so only 20 go
    // (the Standard order bucket alone would allow 48: burst 60 minus its own 200‰ = 12).
    for (let index = 0; index < 7180; index += 1) budget.request({ operationId: "clob.heartbeat", priority: "ORDER_HEARTBEAT" }, T0);
    let placed = 0;
    for (let index = 0; index < 50; index += 1) {
      if (ask(budget, "NEW_ORDER", T0 + 1).kind === "GRANTED") placed += 1;
    }
    expect(placed).toBe(20);
    expect(budget.view(T0 + 1).signers[0]?.order.tokens).toBe("40");
    expect(ask(budget, "EMERGENCY_CANCEL", T0 + 1).kind).toBe("GRANTED");
    expect(ask(budget, "ORDER_HEARTBEAT", T0 + 1).kind).toBe("GRANTED");
  });

  it("a large cancel-all on Standard (a negative cancel balance, D-21) leaves the cancel bucket in debt: the next emergency cancel waits for it", () => {
    const budget = documentedBudget();
    warm(budget, T0 - 60_000);
    const sweep = ask(budget, "EMERGENCY_CANCEL", T0);
    if (sweep.kind !== "GRANTED") throw new Error("the sweep should be granted");
    expect(budget.complete(sweep.grant, { atMs: T0, canceledCount: 500 }).ok).toBe(true);
    expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("-381");
    const next = ask(budget, "EMERGENCY_CANCEL", T0 + 1);
    expect(next.kind).toBe("QUEUED");
    // 382 tokens at 80 per second: 4,775 ms.
    expect(budget.nextWakeAtMs(T0 + 1)).toBe(T0 + 4775);
    expect(granted(budget.poll(T0 + 4774))).toEqual([]);
    expect(granted(budget.poll(T0 + 4775))).toEqual([next.kind === "QUEUED" ? next.ticketId : ""]);
  });
});
