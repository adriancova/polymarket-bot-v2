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

  it.each(["fills", "reservations", "cancels", "orderViews", "allocator", "orders", "retention", "folds"])(
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

describe("the TRDR-4 seams — the trader loop's per-order state and audit-log retention", () => {
  it("are read through the door, every counter as published", () => {
    const result = readTraderHealthReport(healthDocument());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seams = result.value.seams as unknown as Record<string, unknown>;
    expect(seams["orders"]).toEqual({
      tracked: 1,
      settled: 3,
      tombstones: 3,
      maximumTombstones: 100_000,
      tombstoneEvictions: 0,
      unownedFills: 0,
      lateFillsAfterSettlement: 0,
      settleMismatches: 0,
    });
    expect(seams["retention"]).toEqual({
      decisions: { retained: 12, maximumRetained: 100_000, evicted: 0 },
      traces: { retained: 3, maximumRetained: 50_000, evicted: 0 },
      provenance: { retained: 4, maximumRetained: 50_000, evicted: 0 },
    });
  });

  it.each([
    "tracked",
    "settled",
    "tombstones",
    "maximumTombstones",
    "tombstoneEvictions",
    "unownedFills",
    "lateFillsAfterSettlement",
    "settleMismatches",
  ])("REFUSES a report missing seams.orders.%s rather than reading it as 0", (field) => {
    expect(readTraderHealthReport(mutate(["seams", "orders", field], undefined)).ok).toBe(false);
  });

  it.each(["decisions", "traces", "provenance"])(
    "REFUSES a report missing seams.retention.%s, or any of its three counters",
    (log) => {
      expect(readTraderHealthReport(mutate(["seams", "retention", log], undefined)).ok).toBe(false);
      for (const counter of ["retained", "maximumRetained", "evicted"]) {
        expect(
          readTraderHealthReport(mutate(["seams", "retention", log, counter], undefined)).ok,
          `${log}.${counter}`,
        ).toBe(false);
      }
    },
  );

  it("REFUSES an unknown key, a negative and a fractional counter inside them", () => {
    expect(readTraderHealthReport(mutate(["seams", "orders", "unexpected"], 1)).ok).toBe(false);
    expect(readTraderHealthReport(mutate(["seams", "retention", "unexpected"], {})).ok).toBe(false);
    expect(readTraderHealthReport(mutate(["seams", "orders", "unownedFills"], -1)).ok).toBe(false);
    expect(
      readTraderHealthReport(mutate(["seams", "retention", "traces", "evicted"], 0.5)).ok,
    ).toBe(false);
  });
});

describe("the FOLD-1 seam — the trader loop's held accounting state and its rebuild checks", () => {
  it("is read through the door, every field as published, a null last-check fill count included", () => {
    const result = readTraderHealthReport(healthDocument());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seams = result.value.seams as unknown as Record<string, unknown>;
    expect(seams["folds"]).toEqual({
      checkEveryFills: 50,
      pnlCheck: false,
      fillsPosted: 3,
      ledgerChecks: 0,
      pnlChecks: 0,
      fillsAtLastCheck: null,
      ledgerMismatches: 0,
      pnlMismatches: 0,
      pnlRefusals: {},
    });
  });

  it("carries the F3 refusal counts per instance and code, and a measured last-check fill count", () => {
    const result = readTraderHealthReport(
      mutate(["seams", "folds"], {
        checkEveryFills: 1,
        pnlCheck: true,
        fillsPosted: 7,
        ledgerChecks: 7,
        pnlChecks: 6,
        fillsAtLastCheck: 7,
        ledgerMismatches: 0,
        pnlMismatches: 1,
        pnlRefusals: { "sb-1": { PNL_OVERSELL: 1 } },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const folds = (result.value.seams as unknown as Record<string, Record<string, unknown>>)["folds"];
    expect(folds?.["pnlRefusals"]).toEqual({ "sb-1": { PNL_OVERSELL: 1 } });
    expect(folds?.["fillsAtLastCheck"]).toBe(7);
  });

  it.each([
    "checkEveryFills",
    "pnlCheck",
    "fillsPosted",
    "ledgerChecks",
    "pnlChecks",
    "fillsAtLastCheck",
    "ledgerMismatches",
    "pnlMismatches",
    "pnlRefusals",
  ])("REFUSES a report missing seams.folds.%s rather than reading it as 0", (field) => {
    expect(readTraderHealthReport(mutate(["seams", "folds", field], undefined)).ok).toBe(false);
  });

  it("REFUSES an unknown key, a zero cadence, a negative or fractional counter, and a non-counter refusal count", () => {
    expect(readTraderHealthReport(mutate(["seams", "folds", "unexpected"], 1)).ok).toBe(false);
    expect(readTraderHealthReport(mutate(["seams", "folds", "checkEveryFills"], 0)).ok).toBe(false);
    expect(readTraderHealthReport(mutate(["seams", "folds", "ledgerMismatches"], -1)).ok).toBe(false);
    expect(readTraderHealthReport(mutate(["seams", "folds", "fillsAtLastCheck"], 0.5)).ok).toBe(false);
    expect(readTraderHealthReport(mutate(["seams", "folds", "pnlCheck"], "false")).ok).toBe(false);
    expect(
      readTraderHealthReport(mutate(["seams", "folds", "pnlRefusals"], { "sb-1": { PNL_OVERSELL: -1 } })).ok,
    ).toBe(false);
    expect(readTraderHealthReport(mutate(["seams", "folds", "pnlRefusals"], { "sb-1": 1 })).ok).toBe(false);
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
