/**
 * The emergency budget against WP-310's REAL `RateLimitBudget` and its dated
 * contract snapshot: the batch size is exactly the admission boundary
 * (burst minus headroom), the D-21 plan's arithmetic, the canceled count, and
 * the bounded wait.
 */

import { RateLimitBudget, type CancelOutcome } from "@polymarket-bot/polymarket-secure";
import { describe, expect, it } from "vitest";

import { canceledCountOf, CANCEL_PRIORITY, EmergencyBudget, EMERGENCY_OPERATIONS, tokensText } from "./budget.js";
import { contractSnapshot, FakeClock, SIGNER, T0, transportFailure } from "./harness.test-support.js";

function budget(policy: Record<string, unknown> = {}, maxWaitMs = 30_000): { readonly emergency: EmergencyBudget; readonly clock: FakeClock } {
  const clock = new FakeClock();
  const created = EmergencyBudget.create([contractSnapshot(policy as never)], clock, maxWaitMs);
  if (!created.ok) throw new Error(created.problem);
  created.value.signer = SIGNER;
  return { emergency: created.value, clock };
}

const HEADROOM = (emergency: number): Record<string, unknown> => ({
  headroomPermille: { ORDER_HEARTBEAT: 0, EMERGENCY_CANCEL: emergency, RECONCILIATION_READ: Math.max(50, emergency), RISK_REDUCING_ORDER: Math.max(100, emergency), STALE_QUOTE_CANCEL: Math.max(150, emergency), NEW_ORDER: Math.max(200, emergency), METADATA_ANALYTICS: Math.max(300, emergency) },
});

describe("batchCapacity is the real budget's admission boundary", () => {
  for (const permille of [0, 50, 100, 250]) {
    it(`emergency headroom ${String(permille)}‰: maxEntries is admitted, maxEntries + 1 is refused COST_EXCEEDS_CAPACITY`, () => {
      const { emergency } = budget(HEADROOM(permille));
      const capacity = emergency.batchCapacity();
      if ("problem" in capacity) throw new Error(capacity.problem);
      expect(capacity.maxEntries).toBe(120 - Math.floor((120 * permille) / 1000));
      const real = RateLimitBudget.create([contractSnapshot(HEADROOM(permille) as never)]);
      if (!real.ok) throw new Error(real.refusal.message);
      const at = T0;
      const fits = real.value.request({ operationId: EMERGENCY_OPERATIONS.CANCEL_ORDERS, priority: CANCEL_PRIORITY, signer: SIGNER, entries: capacity.maxEntries }, at);
      expect(fits.kind).not.toBe("REFUSED");
      const tooMany = real.value.request({ operationId: EMERGENCY_OPERATIONS.CANCEL_ORDERS, priority: CANCEL_PRIORITY, signer: SIGNER, entries: capacity.maxEntries + 1 }, at);
      expect(tooMany).toMatchObject({ kind: "REFUSED", refusal: { code: "COST_EXCEEDS_CAPACITY" } });
    });
  }

  it("never above WP-260's 1,000-id batch limit (C-11), even on a tier whose cancel burst is larger (Elite: 1,800)", () => {
    const { emergency } = budget({ assumedSignerTier: "Elite" });
    const capacity = emergency.batchCapacity();
    if ("problem" in capacity) throw new Error(capacity.problem);
    expect(capacity.tier).toBe("Elite");
    expect(capacity.cancelBurst).toBe(1800);
    expect(capacity.maxEntries).toBe(1000);
  });
});

describe("the D-21 plan", () => {
  it("cold start, Standard tier: the cancel-all waits one token (13 ms at 80/s); 100 canceled leave about -100; a 120-id batch waits (120 + 100) / 80 s", () => {
    const { emergency } = budget();
    const plan = emergency.cancelDebtPlan(100, 120);
    if ("problem" in plan) throw new Error(plan.problem);
    expect(plan).toMatchObject({ tier: "Standard", cancelBurst: 120, cancelTokensPerSecond: 80, negativeCancelBalance: true, levelNow: "0", firstGrantWaitMs: 13 });
    expect(plan.levelAfterDebit).toBe("-100");
    expect(plan.sweepWaitMs).toBe(2750);
  });

  it("an unknown listed count: no debit estimate", () => {
    const { emergency } = budget();
    const plan = emergency.cancelDebtPlan(null, 120);
    if ("problem" in plan) throw new Error(plan.problem);
    expect(plan.levelAfterDebit).toBeNull();
    expect(plan.sweepWaitMs).toBeNull();
  });

  it("tokensText is exact", () => {
    expect([tokensText(0), tokensText(-1500), tokensText(1250), tokensText(-40), tokensText(120000)]).toEqual(["0", "-1.5", "1.25", "-0.04", "120"]);
  });
});

describe("the canceled count (OP-R1-09: always passed)", () => {
  it("the venue's count when answered; 0 when not sent or refused unapplied; the estimate when unknown", () => {
    const completed: CancelOutcome = { kind: "COMPLETED", canceled: ["a", "b"], notCanceled: [{ orderId: "c", reason: "Order already matched" }] };
    expect(canceledCountOf(completed, 9)).toBe(2);
    expect(canceledCountOf({ kind: "UNKNOWN", error: transportFailure("CANCEL_ALL") }, 9)).toBe(9);
    expect(canceledCountOf({ kind: "UNKNOWN", error: null }, null)).toBeNull();
  });
});

describe("the bounded wait", () => {
  it("a grant within maxBudgetWaitMs is waited for on the budget's own wake times", async () => {
    const { emergency, clock } = budget();
    const result = await emergency.acquire({ operationId: EMERGENCY_OPERATIONS.CANCEL_ALL, priority: CANCEL_PRIORITY, signer: SIGNER });
    expect(result.kind).toBe("GRANTED");
    expect(clock.now - T0).toBe(13);
  });

  it("a grant beyond maxBudgetWaitMs is withdrawn at once: TIMED_OUT, and the clock barely moved", async () => {
    const { emergency, clock } = budget({}, 1_000);
    const result = await emergency.acquire({ operationId: EMERGENCY_OPERATIONS.CANCEL_ORDERS, priority: CANCEL_PRIORITY, signer: SIGNER, entries: 120 });
    expect(result.kind).toBe("TIMED_OUT");
    expect(clock.now - T0).toBeLessThan(1_000);
  });
});
