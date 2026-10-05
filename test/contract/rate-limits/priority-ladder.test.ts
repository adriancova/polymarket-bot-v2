/**
 * Contract: the §9.13 ladder over the DOCUMENTED snapshot (WP-310 acceptance
 * 1, "Safety cancels outrank new orders"). The CLOB general IP class (9,000
 * requests / 10 s) is exhausted; every ladder class is filed on an operation
 * that draws on it. Also on the documented snapshot: a lower class's 429
 * never holds back the safety classes (r1, OP-R1-01), a cancel-all's
 * response is counted once (OP-R1-03), also with another cancel in flight
 * (r2, CX310-R2-01), and a wake timer never sleeps through a grant (r2,
 * CX310-R2-03).
 *
 * OFFLINE: every test installs WP-260's network tripwire; none may be refused.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { feedbackFromObservation, parseRateLimitHeaders, RateLimitBudget, type Grant, type PollEvent, type PriorityClass, type RequestDecision } from "../../../packages/polymarket-secure/src/index.js";
import { PRIORITY_LADDER } from "../../../packages/polymarket-secure/src/rate-limit/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";

import { SIGNER, T0, documentedBudget, rateLimitSnapshot } from "./support.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

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

function grantOf(decision: RequestDecision): Grant {
  if (decision.kind !== "GRANTED") throw new Error(`expected GRANTED, got ${decision.kind}`);
  return decision.grant;
}

describe("a 429 on a request with no signer bucket never holds back the safety classes (OP-R1-01)", () => {
  it.each([
    ["gamma.markets", "METADATA_ANALYTICS"],
    ["clob.book", "METADATA_ANALYTICS"],
    ["clob.get_order", "RECONCILIATION_READ"],
  ] as const)("after a 429 (Retry-After one hour) on %s filed as %s, a heartbeat and an emergency cancel-all are granted at once", (operationId, priority) => {
    const budget = documentedBudget();
    warm(budget, T0 - 60_000);
    const grant = grantOf(budget.request({ operationId, priority }, T0));
    const effects = budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 3600 } });
    expect(effects.ok && effects.value).toEqual([
      { kind: "OPERATION_WAIT_APPLIED", operationId, priorities: PRIORITY_LADDER.slice(PRIORITY_LADDER.indexOf(priority)), untilMs: T0 + 3_600_000, basis: "RETRY_AFTER" },
    ]);
    expect(ask(budget, "ORDER_HEARTBEAT", T0 + 1000).kind).toBe("GRANTED");
    expect(ask(budget, "EMERGENCY_CANCEL", T0 + 1000).kind).toBe("GRANTED");
    expect(ask(budget, "NEW_ORDER", T0 + 1000).kind).toBe("GRANTED");
    // The operation itself waits exactly the hour, for its class.
    const again = budget.request({ operationId, priority }, T0 + 1000);
    expect(again.kind).toBe("QUEUED");
    expect(budget.nextWakeAtMs(T0 + 1000)).toBe(T0 + 3_600_000);
    expect(granted(budget.poll(T0 + 3_600_000))).toEqual([again.kind === "QUEUED" ? again.ticketId : ""]);
  });

  it("without Retry-After (the fallback), the heartbeat is still granted at once", () => {
    const budget = documentedBudget();
    const grant = grantOf(budget.request({ operationId: "gamma.markets", priority: "METADATA_ANALYTICS" }, T0));
    budget.complete(grant, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: null } });
    expect(budget.view(T0).operationWaits).toEqual([{ operationId: "gamma.markets", priority: "METADATA_ANALYTICS", untilMs: T0 + 1000 }]);
    expect(ask(budget, "ORDER_HEARTBEAT", T0 + 500).kind).toBe("GRANTED");
  });
});

describe("a cancel-all's response is counted once under the prescribed wiring (OP-R1-03)", () => {
  it("the SDK observation (fired before the call returns) and complete({ canceledCount }) leave -381, and the next emergency cancel waits 4,775 ms", () => {
    for (const viaObservation of [false, true]) {
      const budget = documentedBudget();
      warm(budget, T0 - 60_000);
      const sweep = grantOf(ask(budget, "EMERGENCY_CANCEL", T0));
      expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("119");
      if (viaObservation) {
        const observed = budget.observeSignerFeedback(
          { signer: SIGNER, bucket: "CANCEL" },
          feedbackFromObservation({ bucket: "cancel", remaining: -381, resetUnixSeconds: null, tier: "standard", warning: false }),
          T0,
        );
        // Applied at once, held apart from the debit of the cancel-all it may answer.
        expect(observed.ok && observed.value.map((effect) => effect.kind)).toEqual(["TIER_APPLIED", "REMAINING_APPLIED", "BALANCE_MAY_INCLUDE_DEBIT"]);
        expect(budget.complete(sweep, { atMs: T0, canceledCount: 500 }).ok).toBe(true);
      } else {
        const feedback = parseRateLimitHeaders({ httpStatus: 200, headers: { "Poly-RateLimit-Remaining": "-381", "Poly-RateLimit-Tier": "standard" } });
        expect(budget.complete(sweep, { atMs: T0, canceledCount: 500, feedback }).ok).toBe(true);
      }
      expect(budget.view(T0).signers[0]?.cancel.tokens, String(viaObservation)).toBe("-381");
      expect(ask(budget, "EMERGENCY_CANCEL", T0 + 1).kind).toBe("QUEUED");
      expect(budget.nextWakeAtMs(T0 + 1), String(viaObservation)).toBe(T0 + 4775);
    }
  });
});

describe("a cancel-all's response is counted once with another cancel in flight (r2, CX310-R2-01)", () => {
  it("cancel-all and a stale-quote cancel outstanding, Remaining -382, 500 canceled: -382 and 4,788 ms, with or without the observation", () => {
    const outcomes = [false, true].map((viaObservation) => {
      const budget = documentedBudget();
      warm(budget, T0 - 60_000);
      const sweep = grantOf(ask(budget, "EMERGENCY_CANCEL", T0));
      grantOf(ask(budget, "STALE_QUOTE_CANCEL", T0));
      expect(budget.view(T0).signers[0]?.cancel.tokens).toBe("118");
      if (viaObservation) {
        const observed = budget.observeSignerFeedback(
          { signer: SIGNER, bucket: "CANCEL" },
          feedbackFromObservation({ bucket: "cancel", remaining: -382, resetUnixSeconds: null, tier: null, warning: false }),
          T0,
        );
        expect(observed.ok && observed.value).toContainEqual({
          kind: "BALANCE_MAY_INCLUDE_DEBIT",
          budget: { dimension: "SIGNER_CANCEL_BUCKET", signer: SIGNER },
          grantIds: [sweep.grantId],
        });
      }
      expect(budget.complete(sweep, { atMs: T0, canceledCount: 500 }).ok).toBe(true);
      const tokens = budget.view(T0).signers[0]?.cancel.tokens;
      expect(ask(budget, "EMERGENCY_CANCEL", T0 + 1).kind).toBe("QUEUED");
      return { tokens, wake: budget.nextWakeAtMs(T0 + 1) };
    });
    // 118 - 500 = -382; 383 tokens at 80 per second: 4,787.5 ms, rounded up.
    expect(outcomes[0]).toEqual({ tokens: "-382", wake: T0 + 4788 });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

describe("a wake timer never sleeps through a grant (r2, CX310-R2-03)", () => {
  it("8,999 heartbeats in clob.general, a heartbeat 429 (Retry-After one hour) and a queued heartbeat ahead of an emergency cancel-all: the timer wakes when the window frees", () => {
    const budget = documentedBudget();
    warm(budget, T0 - 60_000);
    let last: Grant | undefined;
    for (let index = 0; index < 8999; index += 1) last = grantOf(budget.request({ operationId: "clob.heartbeat", priority: "ORDER_HEARTBEAT" }, T0));
    if (last === undefined) throw new Error("no heartbeat");
    budget.complete(last, { atMs: T0, error: { kind: "RATE_LIMITED", retryAfterSeconds: 3600 } });
    // The held-back heartbeat reserves one clob.general slot: the cancel-all cannot take the last one.
    expect(ask(budget, "ORDER_HEARTBEAT", T0).kind).toBe("QUEUED");
    const sweep = ask(budget, "EMERGENCY_CANCEL", T0);
    expect(sweep.kind).toBe("QUEUED");
    // A timer set from nextWakeAtMs wakes when the heartbeats sent at T0 leave the 10 s window, not in an hour.
    expect(budget.nextWakeAtMs(T0)).toBe(T0 + 10_000);
    expect(granted(budget.poll(T0 + 9999))).toEqual([]);
    expect(granted(budget.poll(T0 + 10_000))).toEqual([sweep.kind === "QUEUED" ? sweep.ticketId : ""]);
  });
});
