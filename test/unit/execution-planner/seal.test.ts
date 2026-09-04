/**
 * The emission boundary — what is IMPOSSIBLE to construct, not merely flagged.
 *
 * Every probe here takes a REAL sealed plan, clones it into a mutable draft,
 * breaks exactly one contract clause, and asserts the seal refuses. The
 * workplan acceptance criteria live here as impossibilities: a plan without a
 * deadline (2), an order without price protection (2), and a basket labeled
 * atomic (3) cannot leave `sealExecutionPlan`.
 */

import { describe, expect, it } from "vitest";

import {
  buildExecutionPlan,
  sealExecutionPlan,
  type BasketPlan,
  type ExecutionPlan,
  type PlacementPlan,
} from "../../../packages/execution-planner/src/index.js";
import {
  approvedBasket,
  approvedCancel,
  approvedPosition,
  planCodesOf,
  planningInputs,
} from "./fixtures.js";

function realPlan(record: unknown): ExecutionPlan {
  const result = buildExecutionPlan(record, planningInputs());
  if (!result.ok) throw new Error(JSON.stringify(result.refusals, null, 2));
  return result.value;
}

function draft(): PlacementPlan {
  return JSON.parse(JSON.stringify(realPlan(approvedPosition()))) as PlacementPlan;
}

function basketDraft(): BasketPlan {
  return JSON.parse(JSON.stringify(realPlan(approvedBasket()))) as BasketPlan;
}

function refusedCodes(value: unknown): string[] {
  const result = sealExecutionPlan(value as ExecutionPlan);
  if (result.ok) throw new Error("expected the seal to refuse");
  return planCodesOf(result);
}

describe("the seal — deadlines and price protection are unconstructible absences (acceptance 2)", () => {
  it("reseals an untouched clone (the probe baseline is valid)", () => {
    const sealed = sealExecutionPlan(draft());
    expect(sealed.ok).toBe(true);
  });

  it("refuses a draft with no deadline", () => {
    const d = draft() as unknown as Record<string, unknown>;
    delete d["deadline"];
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a deadline at or before the planning instant", () => {
    const d = draft() as unknown as Record<string, unknown>;
    d["deadline"] = d["plannedAt"];
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a draft with no priceProtection", () => {
    const d = draft() as unknown as Record<string, unknown>;
    delete d["priceProtection"];
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a weakened priceProtection mode", () => {
    const d = draft() as unknown as { priceProtection: Record<string, unknown> };
    d.priceProtection["mode"] = "NONE";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses an order with no limit price — BY THE PRICE-PROTECTION CLAUSE itself", () => {
    // The refusal must NAME the limitPrice path: mutation round 1 found that
    // merely asserting "some refusal fired" was masked by the reservation
    // bijection (the price mismatch also refuses), so a weakened
    // price-protection clause survived. The named-issue assertion kills it.
    const d = draft();
    delete (d.groups[0]?.orders[0] as unknown as Record<string, unknown>)["limitPrice"];
    const result = sealExecutionPlan(d);
    if (result.ok) throw new Error("expected the seal to refuse");
    const issues = result.refusals.flatMap((refusal) =>
      Array.isArray(refusal.details["issues"]) ? (refusal.details["issues"] as string[]) : [],
    );
    expect(issues.some((issue) => issue.includes("orders[0].limitPrice"))).toBe(true);
  });

  it("refuses an off-tick limit price (§7.3 exact modulo)", () => {
    const d = draft();
    (d.groups[0]?.orders[0] as unknown as Record<string, unknown>)["limitPrice"] = "0.485";
    // …and the matching reservation, so ONLY tick conformance is at issue:
    (d.reservations[0] as unknown as Record<string, unknown>)["price"] = "0.485";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses limit prices outside the open unit interval", () => {
    for (const price of ["0", "1", "1.01"]) {
      const d = draft();
      (d.groups[0]?.orders[0] as unknown as Record<string, unknown>)["limitPrice"] = price;
      (d.reservations[0] as unknown as Record<string, unknown>)["price"] = price;
      expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
    }
  });

  it("refuses a number where an economic field must be a decimal string", () => {
    const d = draft();
    (d.groups[0]?.orders[0] as unknown as Record<string, unknown>)["limitPrice"] = 0.48;
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses an incoherent postOnly/executionStyle pairing", () => {
    const d = draft();
    (d.groups[0]?.orders[0] as unknown as Record<string, unknown>)["postOnly"] = false;
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });
});

describe("the seal — the atomic label is refused BY NAME (acceptance 3)", () => {
  it("refuses coordination: ATOMIC with its own code", () => {
    const d = basketDraft() as unknown as Record<string, unknown>;
    d["coordination"] = "ATOMIC";
    expect(refusedCodes(d)).toContain("PLAN_ATOMIC_LABEL_FORBIDDEN");
  });

  it("refuses any other coordination value as a contract violation", () => {
    const d = basketDraft() as unknown as Record<string, unknown>;
    d["coordination"] = "COORDINATED ";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses an `atomic` flag smuggled in as an extra key", () => {
    const d = basketDraft() as unknown as Record<string, unknown>;
    d["atomic"] = true;
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a placement plan claiming a coordination label at all", () => {
    const d = draft() as unknown as Record<string, unknown>;
    d["coordination"] = "COORDINATED";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });
});

describe("the seal — §6 invariant-13 priority coupling, both directions", () => {
  it("refuses a placement claiming SAFETY_CANCEL priority (queue jumping)", () => {
    const d = draft() as unknown as Record<string, unknown>;
    d["priority"] = "SAFETY_CANCEL";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a cancel demoted to PLACEMENT priority (a trapped cancel)", () => {
    const cancel = JSON.parse(JSON.stringify(realPlan(approvedCancel()))) as Record<string, unknown>;
    cancel["priority"] = "PLACEMENT";
    expect(refusedCodes(cancel)).toContain("PLAN_SEAL_INVALID");
  });
});

describe("the seal — reservation-before-submission is structural (§9.10)", () => {
  it("refuses a plan with an order whose reservation is missing", () => {
    const d = draft() as unknown as { reservations: unknown[] };
    d.reservations.pop();
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a reservation claiming different economics than its order", () => {
    const d = draft();
    (d.reservations[0] as unknown as Record<string, unknown>)["shares"] = "1";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses duplicated reservation identifiers", () => {
    const d = draft();
    const r0 = d.reservations[0] as unknown as Record<string, unknown>;
    const r1 = d.reservations[1] as unknown as Record<string, unknown>;
    r1["reservationId"] = r0["reservationId"];
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a weakened reservationRule literal", () => {
    const d = draft() as unknown as Record<string, unknown>;
    d["reservationRule"] = "RESERVE_AFTER_SUBMISSION";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a reservation whose runMode differs from the plan's", () => {
    const d = draft();
    (d.reservations[0] as unknown as Record<string, unknown>)["runMode"] = "LIVE";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });
});

describe("the seal — closed key sets, identities, and labeling", () => {
  it("refuses an unrecognized top-level field", () => {
    const d = draft() as unknown as Record<string, unknown>;
    d["submitNow"] = true;
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses a non-canonical UUID identity anywhere (ADR-016 §2)", () => {
    const d = draft() as unknown as Record<string, unknown>;
    d["approvedIntentId"] = "01890000-0000-7000-8000-0000000000AB";
    expect(refusedCodes(d)).toContain("PLAN_UUID_NOT_CANONICAL");
  });

  it("accepts venue order ids on a cancel without UUID rules (NON_IDENTITY_KEYS)", () => {
    const cancel = JSON.parse(
      JSON.stringify(realPlan(approvedCancel({ orderIds: ["0XAABBCCDD-EEFF-0011-2233-445566778899"] }))),
    ) as ExecutionPlan;
    const sealed = sealExecutionPlan(cancel);
    expect(sealed.ok).toBe(true);
  });

  it("refuses a malformed legSelection (found by lint round 1: the validator existed unwired)", () => {
    const d = draft();
    (d.legSelection as unknown as Record<string, unknown>)["reason"] = "BECAUSE";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
    const d2 = draft() as unknown as Record<string, unknown>;
    d2["legSelection"] = "BUY_DIRECTION";
    expect(refusedCodes(d2)).toContain("PLAN_SEAL_INVALID");
  });

  it("refuses estimates not labeled as estimates", () => {
    const d = draft();
    (d.estimates as unknown as Record<string, unknown>)["basis"] = "ACTUAL";
    expect(refusedCodes(d)).toContain("PLAN_SEAL_INVALID");
  });

  it("returns a materialized frozen tree that shares nothing with the draft", () => {
    const d = draft();
    const sealed = sealExecutionPlan(d);
    if (!sealed.ok) throw new Error("expected the seal to accept");
    expect(sealed.value).not.toBe(d);
    expect(Object.isFrozen(sealed.value)).toBe(true);
    // Editing the DRAFT after sealing must not reach the sealed plan.
    (d as unknown as Record<string, unknown>)["deadline"] = "2099-01-01T00:00:00.000Z";
    expect(sealed.value.deadline).toBe("2026-09-02T12:10:00.000Z");
  });

  it("never throws, whatever the draft is", () => {
    for (const junk of [null, 42, "plan", Symbol("x"), () => undefined, new Proxy({}, {})]) {
      expect(() => sealExecutionPlan(junk as unknown as ExecutionPlan)).not.toThrow();
      const result = sealExecutionPlan(junk as unknown as ExecutionPlan);
      expect(result.ok).toBe(false);
    }
  });
});
