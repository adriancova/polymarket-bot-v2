/**
 * The trader health document's door.
 *
 * The properties that matter: every counter is required (a missing one is
 * refused, not zeroed), the exact decimals survive as STRINGS, and `null` for
 * an empty queue's oldest-message age is a value the door accepts rather than
 * a field it drops.
 */

import { describe, expect, it } from "vitest";

import { readTraderHealthReport } from "./health-door.js";
import { healthDocument } from "./testing/index.js";

function mutate(path: readonly string[], value: unknown): unknown {
  const document = JSON.parse(JSON.stringify(healthDocument())) as Record<string, unknown>;
  let node: Record<string, unknown> = document;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const last = path.at(-1) ?? "";
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
  return document;
}

describe("a complete report", () => {
  it("passes the door and is deep-frozen", () => {
    const result = readTraderHealthReport(healthDocument());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value.execution.observeOnlyIntents).toBe(2);
    expect(result.value.risk.refusedExitsByCode).toEqual({ RISK_NO_NET_EDGE: 1 });
  });

  it("keeps EXACT decimals as strings, never as numbers", () => {
    const result = readTraderHealthReport(
      mutate(["seams", "reservations", "reservedCollateral"], "12345678901234567890.12345"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value.seams.reservations.reservedCollateral;
    expect(typeof value).toBe("string");
    expect(value).toBe("12345678901234567890.12345");
  });

  it("accepts null for an empty queue's oldest-message age", () => {
    const result = readTraderHealthReport(mutate(["queues", "0", "oldestMessageAgeMs"], null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.queues[0]?.oldestMessageAgeMs).toBeNull();
  });

  it("carries the riskSeamCaveat verbatim", () => {
    const result = readTraderHealthReport(healthDocument());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.riskSeamCaveat).toContain("WP-220");
  });

  it("accepts each of the three halt scope shapes", () => {
    const result = readTraderHealthReport(
      mutate(
        ["halts"],
        [
          { scope: { kind: "GLOBAL" }, code: "STORE_UNAVAILABLE", detail: "", at: "t", action: "FULL_HALT" },
          {
            scope: { kind: "MARKET", marketId: "m" },
            code: "BOOK_DESYNCHRONIZED",
            detail: "",
            at: "t",
            action: "CANCEL_RESTING_ORDERS",
          },
          {
            scope: { kind: "STRATEGY_INSTANCE", instanceId: "sb-1" },
            code: "OPERATOR_HALT",
            detail: "",
            at: "t",
            action: "FULL_HALT",
          },
        ],
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe("no counter is defaulted", () => {
  it.each([
    ["loop", "eventsAccepted"],
    ["loop", "deliveriesSuppressedByHalt"],
    ["risk", "refusedExits"],
    ["execution", "observeOnlyIntents"],
    ["accounting", "unexplainedMovements"],
  ])("REFUSES a report missing %s.%s rather than reading it as 0", (section, field) => {
    expect(readTraderHealthReport(mutate([section, field], undefined)).ok).toBe(false);
  });

  it.each(["fills", "reservations", "cancels", "orderViews", "allocator"])(
    "REFUSES a report missing the %s seam section",
    (seam) => {
      expect(readTraderHealthReport(mutate(["seams", seam], undefined)).ok).toBe(false);
    },
  );

  it("REFUSES a negative counter", () => {
    expect(readTraderHealthReport(mutate(["loop", "eventsAccepted"], -1)).ok).toBe(false);
  });

  it("REFUSES a fractional counter", () => {
    expect(readTraderHealthReport(mutate(["loop", "eventsAccepted"], 1.5)).ok).toBe(false);
  });

  it("REFUSES a numeric collateral — economics cross this boundary as strings", () => {
    expect(readTraderHealthReport(mutate(["seams", "reservations", "reservedCollateral"], 12.5)).ok).toBe(
      false,
    );
  });

  it("REFUSES a non-decimal collateral string", () => {
    for (const bad of ["", "abc", "1.2.3", "1e5", "NaN", "Infinity"]) {
      expect(
        readTraderHealthReport(mutate(["seams", "reservations", "reservedCollateral"], bad)).ok,
        bad,
      ).toBe(false);
    }
  });

  it("REFUSES an unknown key: the report grammar is CLOSED", () => {
    expect(readTraderHealthReport(mutate(["unexpected"], "x")).ok).toBe(false);
    expect(readTraderHealthReport(mutate(["loop", "unexpected"], 1)).ok).toBe(false);
  });

  it("REFUSES an unknown halt scope kind", () => {
    expect(
      readTraderHealthReport(
        mutate(
          ["halts"],
          [{ scope: { kind: "ACCOUNT" }, code: "X", detail: "", at: "t", action: "FULL_HALT" }],
        ),
      ).ok,
    ).toBe(false);
  });
});

describe("the door's prototype bound", () => {
  it("does not adopt an inherited section", () => {
    const document = mutate(["seams"], undefined);
    Object.defineProperty(Object.prototype, "seams", {
      value: healthDocument().seams,
      enumerable: false,
      configurable: true,
    });
    try {
      expect(readTraderHealthReport(document).ok).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, "seams");
    }
  });

  it("still refuses a bad decimal under an inherited skipChecks", () => {
    Object.defineProperty(Object.prototype, "skipChecks", {
      value: true,
      enumerable: false,
      configurable: true,
    });
    try {
      expect(
        readTraderHealthReport(mutate(["seams", "reservations", "reservedCollateral"], "not-a-decimal"))
          .ok,
      ).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, "skipChecks");
    }
  });
});
