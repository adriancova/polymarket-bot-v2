/**
 * `C1-TIF` (ADR-034 D3.1 item 2, D3.3): the time-in-force is CARRIED ON THE
 * PLAN. The caller resolves it (the intent's tag, else the instance's
 * configuration) and hands it in as `PlanningInputs.timeInForce`; the planner
 * stamps it on every order, never defaults it, and states a GTD order's
 * expiration as its plan's deadline plus the venue's 60-second security
 * threshold, so the venue ends the order at the deadline.
 */

import { describe, expect, it } from "vitest";

import {
  GTD_SECURITY_THRESHOLD_SECONDS,
  TIME_IN_FORCE_VALUES,
  buildExecutionPlan,
  sealExecutionPlan,
  type ExecutionPlan,
  type PlacementPlan,
} from "../../../packages/execution-planner/src/index.js";
import { GTD_EARLY_EXPIRY_MS } from "../../../packages/simulation/src/index.js";
import { approvedCancel, approvedPosition, planCodesOf, planningInputs } from "./fixtures.js";

function placement(inputs: unknown): PlacementPlan {
  const result = buildExecutionPlan(approvedPosition(), inputs);
  if (!result.ok) throw new Error(JSON.stringify(result.refusals, null, 2));
  return result.value as PlacementPlan;
}

function orders(plan: PlacementPlan) {
  return plan.groups.flatMap((group) => group.orders);
}

describe("C1-TIF — the planner carries the caller's time-in-force on every planned order", () => {
  it.each(TIME_IN_FORCE_VALUES)("stamps %s on every order of the plan", (timeInForce) => {
    // 100 shares sliced at 60: two orders, both carry it.
    const plan = placement(planningInputs({ timeInForce }));
    expect(orders(plan).length).toBe(2);
    for (const order of orders(plan)) expect(order.timeInForce).toBe(timeInForce);
  });

  it("refuses a placement whose inputs carry NO time-in-force — never defaulted", () => {
    const inputs = planningInputs();
    delete inputs.timeInForce;
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toEqual(["PLAN_INPUT_INVALID"]);
    if (!result.ok) expect(JSON.stringify(result.refusals)).toContain("inputs.timeInForce");
  });

  it("refuses a value outside the venue's four (IOC included)", () => {
    for (const timeInForce of ["IOC", "gtc", ""]) {
      expect(planCodesOf(buildExecutionPlan(approvedPosition(), planningInputs({ timeInForce })))).toEqual([
        "PLAN_INPUT_INVALID",
      ]);
    }
  });

  it("a CANCEL needs none: the cancel door never reads it (§6 invariant 13)", () => {
    const inputs = planningInputs();
    delete inputs.timeInForce;
    expect(buildExecutionPlan(approvedCancel(), inputs).ok).toBe(true);
  });
});

describe("C1-TIF — a GTD order states its plan's deadline plus the venue's 60 s threshold (ADR-034 D3.3)", () => {
  it("expirationUnixSeconds = the deadline, rounded UP to the second, + 60", () => {
    const plan = placement(planningInputs({ timeInForce: "GTD" }));
    const deadlineMs = Date.parse(plan.deadline);
    for (const order of orders(plan)) {
      expect(order.expirationUnixSeconds).toBe(Math.ceil(deadlineMs / 1000) + 60);
    }
  });

  it("rounds a sub-second deadline UP, so the venue never ends the order before its deadline", () => {
    // 10:00:00.250 + 600 000 ms: the deadline is 10:10:00.250.
    const plan = placement(planningInputs({ timeInForce: "GTD", plannedAt: "2026-03-04T10:00:00.250Z" }));
    expect(plan.deadline).toBe("2026-03-04T10:10:00.250Z");
    const expected = Date.parse("2026-03-04T10:10:01.000Z") / 1000 + 60;
    for (const order of orders(plan)) expect(order.expirationUnixSeconds).toBe(expected);
  });

  it("an intent's validUntil EARLIER than the policy's lifetime is the deadline the expiration states (C1-TIF r1)", () => {
    // Planned 12:00:00 with a 600 000 ms lifetime (12:10:00); the intent dies
    // at 12:05:00.400, so the deadline is that, and the expiration is stated
    // from it — never from the later policy deadline.
    const result = buildExecutionPlan(
      approvedPosition({ validUntil: "2026-09-02T12:05:00.400Z" }),
      planningInputs({ timeInForce: "GTD" }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.refusals, null, 2));
    const plan = result.value as PlacementPlan;
    expect(plan.deadline).toBe("2026-09-02T12:05:00.400Z");
    const expected = Date.parse("2026-09-02T12:05:01.000Z") / 1000 + 60;
    for (const order of orders(plan)) expect(order.expirationUnixSeconds).toBe(expected);
  });

  it("states no expiration for GTC, FAK or FOK", () => {
    for (const timeInForce of ["GTC", "FAK", "FOK"]) {
      for (const order of orders(placement(planningInputs({ timeInForce })))) {
        expect(order).not.toHaveProperty("expirationUnixSeconds");
      }
    }
  });

  it("the planner's threshold is the simulated venue's GTD early expiry", () => {
    expect(GTD_SECURITY_THRESHOLD_SECONDS * 1000).toBe(GTD_EARLY_EXPIRY_MS);
  });
});

describe("C1-TIF — the seal: every order carries one of the four, and an expiration exactly when GTD", () => {
  function draft(timeInForce: string): Record<string, unknown> {
    return JSON.parse(JSON.stringify(placement(planningInputs({ timeInForce })))) as Record<string, unknown>;
  }
  function firstOrder(plan: Record<string, unknown>): Record<string, unknown> {
    return ((plan["groups"] as Record<string, unknown>[])[0]?.["orders"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  }
  function sealCodes(plan: Record<string, unknown>): string[] {
    const result = sealExecutionPlan(plan as unknown as ExecutionPlan);
    return result.ok ? [] : planCodesOf(result);
  }

  it("reseals untouched GTC and GTD plans", () => {
    expect(sealCodes(draft("GTC"))).toEqual([]);
    expect(sealCodes(draft("GTD"))).toEqual([]);
  });

  it("refuses an order with no time-in-force, or an unknown one", () => {
    const missing = draft("GTC");
    delete firstOrder(missing)["timeInForce"];
    expect(sealCodes(missing)).toEqual(["PLAN_SEAL_INVALID"]);
    const unknown = draft("GTC");
    firstOrder(unknown)["timeInForce"] = "IOC";
    expect(sealCodes(unknown)).toEqual(["PLAN_SEAL_INVALID"]);
  });

  it("refuses a GTD order without a whole, positive expiration", () => {
    for (const expiration of [undefined, 0, -1, 1.5, "1777626092"]) {
      const plan = draft("GTD");
      if (expiration === undefined) delete firstOrder(plan)["expirationUnixSeconds"];
      else firstOrder(plan)["expirationUnixSeconds"] = expiration;
      expect(sealCodes(plan), String(expiration)).toEqual(["PLAN_SEAL_INVALID"]);
    }
  });

  it("refuses an expiration on a GTC order", () => {
    const plan = draft("GTC");
    firstOrder(plan)["expirationUnixSeconds"] = 1_777_626_092;
    expect(sealCodes(plan)).toEqual(["PLAN_SEAL_INVALID"]);
  });
});
