/**
 * CANCEL planning — §6 invariant 13 as MECHANISM, not aspiration.
 *
 * "Safety cancellation outranks new order placement", and the binding reading
 * of WP-180's round-8 BLOCKER: a malformed-input refusal must never be
 * converted into, or block, a valid CANCEL disposition. The planner's cancel
 * path therefore reads ONLY the fields a cancel plan carries — this suite
 * proves both halves: hostile values in fields a cancel never consumes do
 * not block it (while the SAME values DO block a placement, showing the
 * asymmetry is deliberate), and a genuinely malformed cancel still refuses
 * with a typed result rather than becoming a plan or a throw.
 */

import { describe, expect, it } from "vitest";

import {
  PLAN_PRIORITY_RANK,
  buildExecutionPlan,
  comparePlanPriority,
  type CancelPlan,
} from "../../../packages/execution-planner/src/index.js";
import {
  MARKET_A,
  approvedCancel,
  approvedPosition,
  planCodesOf,
  planningInputs,
} from "./fixtures.js";

function cancelPlan(record: unknown, inputs: unknown): CancelPlan {
  const result = buildExecutionPlan(record, inputs);
  if (!result.ok) throw new Error(JSON.stringify(result.refusals, null, 2));
  if (result.value.planKind !== "CANCEL") throw new Error(`expected CANCEL, got ${result.value.planKind}`);
  return result.value;
}

/** A mutable JSON clone of a real record (frozen originals cannot be edited). */
function clone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe("CANCEL plans — the baseline", () => {
  const record = approvedCancel();
  const plan = cancelPlan(record, planningInputs());

  it("schedules as SAFETY_CANCEL, ahead of every placement (§6 invariant 13)", () => {
    expect(plan.priority).toBe("SAFETY_CANCEL");
    expect(PLAN_PRIORITY_RANK.SAFETY_CANCEL).toBeLessThan(PLAN_PRIORITY_RANK.PLACEMENT);
    expect(comparePlanPriority("SAFETY_CANCEL", "PLACEMENT")).toBe(-1);
    expect(comparePlanPriority("PLACEMENT", "SAFETY_CANCEL")).toBe(1);
    expect(comparePlanPriority("SAFETY_CANCEL", "SAFETY_CANCEL")).toBe(0);
  });

  it("places nothing at any price, with a deadline that escalates to reconciliation", () => {
    expect(plan.priceProtection).toEqual({ mode: "NO_NEW_ORDERS" });
    expect(plan.escalation).toEqual({ atDeadline: "ESCALATE_TO_RECONCILIATION" });
    expect(plan.deadline).toBe("2026-09-02T12:00:30.000Z"); // plannedAt + 30000ms
    expect(plan.scope).toEqual({ marketId: MARKET_A });
    expect(plan.reason).toBe("kill switch");
    expect(plan.approvedIntentId).toBe(record.approvedIntentId);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("carries venue order ids VERBATIM — never UUID-checked, never case-folded", () => {
    const withOrders = approvedCancel({
      orderIds: ["0xABCDEF0123456789", "VENUE-ORDER-2"],
    });
    const scoped = cancelPlan(withOrders, planningInputs());
    expect(scoped.scope.orderIds).toEqual(["0xABCDEF0123456789", "VENUE-ORDER-2"]);
  });
});

describe("CANCEL plans — hostile fields a cancel never consumes cannot block it", () => {
  it("plans despite a throwing getter on the record's worstCase and a Proxy on reasons", () => {
    const hostile = clone(approvedCancel());
    Object.defineProperty(hostile, "worstCase", {
      get() {
        throw new Error("hostile worstCase getter");
      },
      enumerable: true,
      configurable: true,
    });
    hostile["reasons"] = new Proxy([], {
      get() {
        throw new Error("hostile reasons trap");
      },
    });
    hostile["recommendations"] = { toJSON: undefined, length: Symbol("junk") };
    const plan = cancelPlan(hostile, planningInputs());
    expect(plan.planKind).toBe("CANCEL");
  });

  it("plans despite hostile planning-input fields a cancel does not read", () => {
    const inputs = planningInputs() as unknown as Record<string, unknown>;
    Object.defineProperty(inputs, "markets", {
      get() {
        throw new Error("hostile markets getter");
      },
      enumerable: true,
      configurable: true,
    });
    inputs["availableCollateral"] = new Proxy({}, {
      get() {
        throw new Error("hostile collateral trap");
      },
    });
    const plan = cancelPlan(approvedCancel(), inputs);
    expect(plan.planKind).toBe("CANCEL");
  });

  it("…while the SAME hostile inputs refuse a PLACEMENT (typed, not thrown)", () => {
    const inputs = planningInputs() as unknown as Record<string, unknown>;
    Object.defineProperty(inputs, "markets", {
      get() {
        throw new Error("hostile markets getter");
      },
      enumerable: true,
      configurable: true,
    });
    let result: ReturnType<typeof buildExecutionPlan> | undefined;
    expect(() => {
      result = buildExecutionPlan(approvedPosition(), inputs);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    expect(planCodesOf(result ?? { ok: true })).toContain("PLAN_INPUT_INVALID");
  });

  it("…and a hostile worstCase DOES refuse a placement record (the asymmetry is deliberate)", () => {
    const hostile = clone(approvedPosition());
    Object.defineProperty(hostile, "worstCase", {
      get() {
        throw new Error("hostile worstCase getter");
      },
      enumerable: true,
      configurable: true,
    });
    const result = buildExecutionPlan(hostile, planningInputs());
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_RECORD_INVALID");
  });
});

describe("CANCEL plans — a malformed cancel still refuses; nothing becomes a cancel by accident", () => {
  it("refuses a cancel whose own reason is missing (typed, not thrown, not planned)", () => {
    const broken = clone(approvedCancel());
    delete (broken["intent"] as Record<string, unknown>)["reason"];
    let result: ReturnType<typeof buildExecutionPlan> | undefined;
    expect(() => {
      result = buildExecutionPlan(broken, planningInputs());
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    expect(planCodesOf(result ?? { ok: true })).toContain("PLAN_RECORD_INVALID");
  });

  it("refuses a cancel whose approvedIntentId is a throwing getter — a field the cancel DOES need", () => {
    const broken = clone(approvedCancel());
    Object.defineProperty(broken, "approvedIntentId", {
      get() {
        throw new Error("hostile id getter");
      },
      enumerable: true,
      configurable: true,
    });
    const result = buildExecutionPlan(broken, planningInputs());
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_RECORD_INVALID");
  });

  it("refuses a cancel with a non-canonical UUID identity (ADR-016 §2 still applies to identities)", () => {
    const broken = clone(approvedCancel());
    broken["approvedIntentId"] = "01890000-0000-7000-8000-0000000000AB"; // uppercase
    const result = buildExecutionPlan(broken, planningInputs());
    expect(result.ok).toBe(false);
  });

  it("refuses cancel inputs whose OWN needed fields are malformed", () => {
    const inputs = planningInputs({ plannedAt: "not-an-instant" });
    const result = buildExecutionPlan(approvedCancel(), inputs);
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_INPUT_INVALID");
  });

  it("never converts a refusal into a cancel: garbage in, refusal out", () => {
    for (const garbage of [null, 42, "cancel", [], { intent: { type: "CANCEL" } }]) {
      const result = buildExecutionPlan(garbage, planningInputs());
      expect(result.ok).toBe(false);
    }
  });
});
