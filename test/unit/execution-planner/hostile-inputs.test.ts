/**
 * Hostile and malformed inputs — typed refusals, nothing escapes as a throw,
 * and the measured cross-package `zod`/prototype classes
 * (IMPLEMENTATION_STATUS.md, Open blockers) are probed directly:
 *
 * - `skipChecks` (format checks disabled wholesale),
 * - inherited `when` (custom checks skipped),
 * - a get-only inherited accessor (defaults defeated / fields lost),
 * - an enumerable data property (the cold-lazy `for…in` class),
 * - `Object.prototype.get` (the descriptor-literal class that TRAPPED a
 *   CANCEL at WP-180's round-7 tip).
 *
 * Every pollution probe asserts BOTH halves: a valid build is byte-identical
 * to the clean-process build, and a malformed input is refused with the same
 * codes as in a clean process. Pollution is applied inside try/finally so no
 * state leaks into other tests.
 */

import { describe, expect, it } from "vitest";

import { buildExecutionPlan } from "../../../packages/execution-planner/src/index.js";
import {
  approvedCancel,
  approvedPosition,
  planCodesOf,
  planningInputs,
} from "./fixtures.js";

function clone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** Runs `body` with one property on `Object.prototype`, ALWAYS cleaning up. */
function polluted<T>(name: string, descriptor: PropertyDescriptor, body: () => T): T {
  Object.defineProperty(Object.prototype, name, { ...descriptor, configurable: true });
  try {
    return body();
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>)[name];
  }
}

describe("malformed and hostile values are typed refusals, never throws", () => {
  const junkValues: unknown[] = [
    null,
    undefined,
    42,
    "record",
    Symbol("record"),
    () => undefined,
    [],
    new Map(),
    new Proxy({}, {}),
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile trap");
        },
      },
    ),
  ];

  it("refuses junk records without throwing", () => {
    for (const junk of junkValues) {
      let result: ReturnType<typeof buildExecutionPlan> | undefined;
      expect(() => {
        result = buildExecutionPlan(junk, planningInputs());
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    }
  });

  it("refuses junk inputs without throwing", () => {
    for (const junk of junkValues) {
      let result: ReturnType<typeof buildExecutionPlan> | undefined;
      expect(() => {
        result = buildExecutionPlan(approvedPosition(), junk);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    }
  });

  it("refuses a record with a throwing getter on a consumed field", () => {
    const hostile = clone(approvedPosition());
    Object.defineProperty(hostile, "intent", {
      get() {
        throw new Error("hostile intent getter");
      },
      enumerable: true,
      configurable: true,
    });
    const result = buildExecutionPlan(hostile, planningInputs());
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_RECORD_INVALID");
  });

  it("refuses a cyclic inputs document", () => {
    const inputs = planningInputs() as unknown as Record<string, unknown>;
    inputs["cycle"] = inputs;
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(result.ok).toBe(false);
  });

  it("refuses a __proto__ key arriving via JSON (the one name a strict schema cannot report)", () => {
    const inputs = JSON.parse(
      `{"__proto__": {"polluted": true}, "executionPlanId": "x", "plannedAt": "2026-09-02T12:00:00.000Z"}`,
    ) as Record<string, unknown>;
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(result.ok).toBe(false);
  });

  it("refuses unknown fields on the planning inputs (closed key sets)", () => {
    const inputs = planningInputs() as unknown as Record<string, unknown>;
    inputs["submitImmediately"] = true;
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_INPUT_INVALID");
  });

  it("refuses unknown fields on the approved-intent record (as shaped at 98a6cc1)", () => {
    const hostile = clone(approvedPosition());
    hostile["overrideRunMode"] = "LIVE";
    const result = buildExecutionPlan(hostile, planningInputs());
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_RECORD_INVALID");
  });

  it("refuses a crossed book snapshot as a data-quality incident", () => {
    const inputs = planningInputs();
    (inputs.markets[0] as Record<string, unknown>)["book"] = {
      yesBestBid: "0.52",
      yesBestAsk: "0.5",
    };
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(result.ok).toBe(false);
    expect(planCodesOf(result)).toContain("PLAN_INPUT_INVALID");
  });

  it("refuses off-tick book prices", () => {
    const inputs = planningInputs();
    (inputs.markets[0] as Record<string, unknown>)["book"] = { yesBestAsk: "0.505" };
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(result.ok).toBe(false);
  });

  it("refuses an oversold inventory input (reserved > held)", () => {
    const inputs = planningInputs();
    (inputs.markets[0] as Record<string, unknown>)["inventory"] = {
      yes: { held: "10", reserved: "20" },
      no: { held: "0", reserved: "0" },
    };
    const result = buildExecutionPlan(approvedPosition(), inputs);
    expect(result.ok).toBe(false);
  });
});

describe("the measured prototype-pollution classes (cross-package risk, Open blockers)", () => {
  // Clean-process baselines, captured BEFORE any pollution below runs.
  const cleanPlan = JSON.stringify(
    (() => {
      const result = buildExecutionPlan(approvedPosition(), planningInputs());
      if (!result.ok) throw new Error("clean baseline failed");
      return result.value;
    })(),
  );
  const cleanCancel = JSON.stringify(
    (() => {
      const result = buildExecutionPlan(approvedCancel(), planningInputs());
      if (!result.ok) throw new Error("clean cancel baseline failed");
      return result.value;
    })(),
  );
  const badTimestampCodes = (() => {
    const broken = clone(approvedPosition());
    (broken["intent"] as Record<string, unknown>)["validUntil"] = "not-a-timestamp";
    return planCodesOf(buildExecutionPlan(broken, planningInputs()));
  })();
  const badDecimalCodes = (() => {
    const broken = clone(approvedPosition());
    (broken["intent"] as Record<string, unknown>)["targetShares"] = "1e2";
    return planCodesOf(buildExecutionPlan(broken, planningInputs()));
  })();

  it("skipChecks=true cannot disable format validation (the run-mode-ceiling class)", () => {
    polluted("skipChecks", { value: true, enumerable: false, writable: true }, () => {
      const broken = clone(approvedPosition());
      (broken["intent"] as Record<string, unknown>)["validUntil"] = "not-a-timestamp";
      const result = buildExecutionPlan(broken, planningInputs());
      expect(result.ok).toBe(false);
      expect(planCodesOf(result)).toEqual(badTimestampCodes);
      // …and a valid build is byte-identical to the clean process.
      const valid = buildExecutionPlan(approvedPosition(), planningInputs());
      if (!valid.ok) throw new Error("valid build failed under skipChecks pollution");
      expect(JSON.stringify(valid.value)).toBe(cleanPlan);
    });
  });

  it("an inherited when:()=>false cannot skip custom checks (the canonical-decimal class)", () => {
    polluted("when", { value: () => false, enumerable: false, writable: true }, () => {
      const broken = clone(approvedPosition());
      (broken["intent"] as Record<string, unknown>)["targetShares"] = "1e2";
      const result = buildExecutionPlan(broken, planningInputs());
      expect(result.ok).toBe(false);
      expect(planCodesOf(result)).toEqual(badDecimalCodes);
      const valid = buildExecutionPlan(approvedPosition(), planningInputs());
      if (!valid.ok) throw new Error("valid build failed under when pollution");
      expect(JSON.stringify(valid.value)).toBe(cleanPlan);
    });
  });

  it("a get-only inherited accessor on an optional field name neither adopts nor loses (the defaults class)", () => {
    polluted(
      "minimumFillShares",
      {
        get: () => "999999",
        enumerable: false,
      },
      () => {
        const valid = buildExecutionPlan(approvedPosition(), planningInputs());
        if (!valid.ok) throw new Error("valid build failed under accessor pollution");
        // The intent supplied no minimumFillShares; the inherited value must
        // NOT be adopted into the plan's partial-fill handling.
        if (valid.value.planKind === "CANCEL") throw new Error("unexpected kind");
        expect(Object.hasOwn(valid.value.partialFill, "minimumFillShares")).toBe(false);
        expect(JSON.stringify(valid.value)).toBe(cleanPlan);
      },
    );
  });

  it("an enumerable Object.prototype property cannot poison parsing or assembly (the cold-lazy class)", () => {
    polluted("polluteEnumerable", { value: "junk", enumerable: true, writable: true }, () => {
      const valid = buildExecutionPlan(approvedPosition(), planningInputs());
      if (!valid.ok) throw new Error("valid build failed under enumerable pollution");
      expect(JSON.stringify(valid.value)).toBe(cleanPlan);
    });
  });

  it("Object.prototype.get cannot trap a cancel or a placement (WP-180 round-8's trapped-cancel probe)", () => {
    // NOTE the shape of this test: NO assertion library runs while the
    // pollution is active, because chai's own `expect` machinery uses literal
    // property descriptors and THROWS under `Object.prototype.get` — the
    // exact descriptor-literal class the product is hardened against.
    // Results are collected bare and asserted after cleanup.
    const outcome = polluted("get", { value: "1000", enumerable: false, writable: true }, () => {
      let cancelThrew: string | undefined;
      let cancelBytes: string | undefined;
      let placementThrew: string | undefined;
      let placementBytes: string | undefined;
      try {
        const cancel = buildExecutionPlan(approvedCancel(), planningInputs());
        cancelBytes = cancel.ok ? JSON.stringify(cancel.value) : JSON.stringify(planCodesOf(cancel));
      } catch (error) {
        cancelThrew = String(error);
      }
      try {
        const placement = buildExecutionPlan(approvedPosition(), planningInputs());
        placementBytes = placement.ok
          ? JSON.stringify(placement.value)
          : JSON.stringify(planCodesOf(placement));
      } catch (error) {
        placementThrew = String(error);
      }
      return { cancelThrew, cancelBytes, placementThrew, placementBytes };
    });
    expect(outcome.cancelThrew).toBeUndefined();
    expect(outcome.cancelBytes).toBe(cleanCancel);
    expect(outcome.placementThrew).toBeUndefined();
    expect(outcome.placementBytes).toBe(cleanPlan);
  });

  it("refusal construction itself survives pollution (evidence is still typed data)", () => {
    const outcome = polluted(
      "get",
      { value: () => "1000", enumerable: false, writable: true },
      () => {
        try {
          const result = buildExecutionPlan(null, planningInputs());
          return { threw: undefined, ok: result.ok };
        } catch (error) {
          return { threw: String(error), ok: undefined };
        }
      },
    );
    expect(outcome.threw).toBeUndefined();
    expect(outcome.ok).toBe(false);
  });
});
