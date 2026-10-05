/**
 * The four `WP-220` obligation seams, unit-tested in isolation.
 *
 * The integration suite drives them through the assembled system; this file
 * pins their own contracts, so a change that breaks one fails here with a
 * message about the seam rather than three layers away with a message about a
 * fill count.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import { describe, expect, it } from "vitest";

import { AllocatorGate } from "./allocation.js";
import { CancelLedger } from "./cancels.js";
import { FILLS_ARE_DELIVERED_WHILE_PAUSED, FillDeduplicator } from "./fills.js";
import { HealthState, RISK_SEAM_CAVEAT, type SeamHealth } from "./health.js";
import { InstanceRegistry, compareInstances } from "./instances.js";
import {
  OrderViewTracker,
  TERMINAL_STATUSES,
  isTerminalStatus,
  toStrategyOrderView,
} from "./orders.js";
import { ORDER_TYPE_TAG_PREFIX, isProtectiveExitIntent, resolveTimeInForce } from "./pipeline.js";
import { ReservationBook } from "./reservations.js";

const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";
const AT = "2026-03-04T12:00:00Z";

function simulatedOrder(overrides: Record<string, unknown> = {}): Parameters<typeof toStrategyOrderView>[0] {
  return {
    simulatedOrderId: "order-1",
    plannedOrderId: "planned-1",
    executionPlanId: "plan-1",
    marketId: MARKET,
    tokenId: "111",
    side: "YES",
    action: "BUY",
    limitPrice: "0.34",
    requestedShares: "50",
    filledShares: "0",
    state: "RESTING",
    postOnly: false,
    executionStyle: "REST",
    fillEstimateKind: "POINT",
    atEvent: {
      gatewayEpoch: "018f4a7e-5555-7abc-8def-0123456789ab",
      ingestSeq: "1",
      receivedAt: AT,
      datasetRowOrdinal: 1,
    },
    ...overrides,
  } as Parameters<typeof toStrategyOrderView>[0];
}

/** A real gate over the fenced caps, for the seam-metric assertions. */
export function testAllocatorGate(
  caps: Record<string, unknown> = { globalAccountCap: "1000", perStrategyCap: "1000" },
): AllocatorGate {
  const parsed = parseAllocatorCaps(caps);
  if (!parsed.ok) throw new Error(`the test caps were refused: ${parsed.refusals[0]?.code ?? "?"}`);
  return new AllocatorGate({
    caps: parsed.value,
    markets: new Map(),
    tokenAssetIds: new Map(),
  });
}

/**
 * The seam counters, read from REAL seams.
 *
 * Hand-built numbers here would test the snapshot's plumbing against itself;
 * these are the same `metrics()` calls `CoreLoop.health()` makes.
 */
function seamMetrics(): SeamHealth {
  return {
    fills: new FillDeduplicator({ maximumRemembered: 4 }).metrics(),
    reservations: new ReservationBook().metrics(),
    cancels: new CancelLedger().metrics(),
    orderViews: new OrderViewTracker().metrics(),
    allocator: testAllocatorGate().metrics(),
  };
}

describe("obligation 5b — the fill deduplicator", () => {
  it("admits a fill once and refuses every redelivery", () => {
    const dedup = new FillDeduplicator({ maximumRemembered: 4 });
    expect(dedup.admit("f1").admitted).toBe(true);
    expect(dedup.admit("f1").admitted).toBe(false);
    expect(dedup.admit("f2").admitted).toBe(true);
    expect(dedup.metrics().admitted).toBe(2);
    expect(dedup.metrics().refused).toBe(1);
  });

  it("REFUSES a fill with no identity — it cannot be deduplicated, so it fails closed", () => {
    const dedup = new FillDeduplicator({ maximumRemembered: 4 });
    const refused = dedup.admit("");
    expect(refused.admitted).toBe(false);
    if (refused.admitted) return;
    expect(refused.detail).toContain("fail closed");
  });

  it("REPORTS eviction rather than hiding it: the bound is a REAL limit", () => {
    const dedup = new FillDeduplicator({ maximumRemembered: 2 });
    dedup.admit("f1");
    dedup.admit("f2");
    expect(dedup.metrics().evictions).toBe(0);
    dedup.admit("f3");
    // `f1` was forgotten, so a redelivery of it would now be admitted — and the
    // metric SAYS SO instead of the seam silently weakening.
    expect(dedup.metrics().evictions).toBe(1);
    expect(dedup.admit("f1").admitted).toBe(true);
  });

  it("refuses an unusable bound at construction", () => {
    expect(() => new FillDeduplicator({ maximumRemembered: 0 })).toThrow(RangeError);
  });

  it("obligation 8 is stated as a constant the loop reads", () => {
    expect(FILLS_ARE_DELIVERED_WHILE_PAUSED).toBe(true);
  });
});

describe("obligations 4/5a/7 — order views", () => {
  it("maps every venue state onto an SDK status, with a cancel-in-flight reported OPEN", () => {
    // The SDK has no CANCEL_PENDING member; `OPEN` is the only status a root can
    // report for an order whose cancel is in flight, and the strategy's
    // round-3 self-edge exists for exactly that.
    const cases = [
      ["ACCEPTED", "OPEN"],
      ["DELAYED", "OPEN"],
      ["RESTING", "OPEN"],
      ["PARTIALLY_FILLED", "PARTIALLY_FILLED"],
      ["FILLED", "FILLED"],
      ["CANCELLED", "CANCELED"],
      ["EXPIRED", "EXPIRED"],
      ["REJECTED", "REJECTED"],
    ] as const;
    for (const [state, status] of cases) {
      const view = toStrategyOrderView(simulatedOrder({ state }), {
        marketId: MARKET,
        placedAt: AT,
      });
      expect(view.status, state).toBe(status);
    }
  });

  it("filledShares is the CONFIRMED quantity, never the requested size", () => {
    const view = toStrategyOrderView(
      simulatedOrder({ state: "PARTIALLY_FILLED", filledShares: "20" }),
      { marketId: MARKET, placedAt: AT },
    );
    expect(view.filledShares).toBe("20");
    expect(view.requestedShares).toBe("50");
  });

  it("a Tier-1 resting order reports the BOOKED quantity, and the band lives elsewhere", () => {
    const view = toStrategyOrderView(
      simulatedOrder({ fillEstimateKind: "TIER_1_RESTING_BAND", filledShares: "0" }),
      { marketId: MARKET, placedAt: AT },
    );
    // ADR-012 §1: a Tier-1 resting estimate is a BAND, so there is no honest
    // single number to put here — `"0"` is the point-precise booked quantity.
    expect(view.filledShares).toBe("0");
  });

  it("the tracker LABELS a repeat and never suppresses one", () => {
    const tracker = new OrderViewTracker();
    const view = toStrategyOrderView(simulatedOrder({ state: "FILLED", filledShares: "50" }), {
      marketId: MARKET,
      placedAt: AT,
    });
    expect(tracker.deliverable("i", view).repeat).toBe(false);
    expect(tracker.deliverable("i", view).repeat).toBe(true);
    expect(tracker.deliverable("i", view).repeat).toBe(true);
    expect(tracker.metrics()).toEqual({ emitted: 3, repeats: 2, tracked: 1 });
  });

  it("a CHANGED view is not a repeat", () => {
    const tracker = new OrderViewTracker();
    tracker.deliverable(
      "i",
      toStrategyOrderView(simulatedOrder({ filledShares: "0" }), {
        marketId: MARKET,
        placedAt: AT,
      }),
    );
    const changed = tracker.deliverable(
      "i",
      toStrategyOrderView(simulatedOrder({ state: "PARTIALLY_FILLED", filledShares: "20" }), {
        marketId: MARKET,
        placedAt: AT,
      }),
    );
    expect(changed.repeat).toBe(false);
  });

  it("the terminal set is the strategy's four", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ["CANCELED", "EXPIRED", "FILLED", "REJECTED"],
    );
    expect(isTerminalStatus("OPEN")).toBe(false);
    expect(isTerminalStatus("PARTIALLY_FILLED")).toBe(false);
    expect(isTerminalStatus("FILLED")).toBe(true);
  });
});

describe("obligation 10 — cancel reconciliation", () => {
  function pending(overrides: Record<string, unknown> = {}) {
    return {
      cancelId: "c1",
      executionPlanId: "p1",
      instanceId: "i1",
      marketId: MARKET,
      orderIds: ["o1"],
      requestedAt: AT,
      requestedAtEpochMs: 0,
      silenceBoundMs: 5_000,
      ...overrides,
    };
  }

  it("every registered cancel reaches EXACTLY ONE of the three terminal facts", () => {
    const ledger = new CancelLedger();
    ledger.register(pending({ cancelId: "c1" }));
    ledger.register(pending({ cancelId: "c2" }));
    ledger.register(pending({ cancelId: "c3" }));
    expect(ledger.resolve("c1", "CONFIRMED", "ok", AT)?.recommendation).toBe("NONE");
    expect(ledger.resolve("c2", "REJECTED", "no", AT)?.recommendation).toBe(
      "CANCEL_RESTING_ORDERS",
    );
    expect(ledger.sweep(5_000, AT)).toHaveLength(1);
    const metrics = ledger.metrics();
    expect(metrics.requested).toBe(3);
    expect(metrics.confirmed + metrics.rejected + metrics.silenceExceeded).toBe(3);
    expect(metrics.pending).toBe(0);
  });

  it("SILENCE_EXCEEDED is NOT a rejection — §6 invariant 6", () => {
    const ledger = new CancelLedger();
    ledger.register(pending());
    const expired = ledger.sweep(5_000, AT);
    expect(expired[0]?.resolution).toBe("SILENCE_EXCEEDED");
    expect(expired[0]?.recommendation).toBe("RECONCILE_ACCOUNT");
    expect(expired[0]?.detail).toContain("forbids reading the silence as a rejection");
  });

  it("the bound is measured in RECORDED time, so a run that does not advance times nothing out", () => {
    const ledger = new CancelLedger();
    ledger.register(pending());
    expect(ledger.sweep(0, AT)).toEqual([]);
    expect(ledger.sweep(4_999, AT)).toEqual([]);
    expect(ledger.sweep(5_000, AT)).toHaveLength(1);
  });

  it("a resolution for an unknown or already-resolved cancel answers `undefined`", () => {
    const ledger = new CancelLedger();
    expect(ledger.resolve("nope", "CONFIRMED", "?", AT)).toBeUndefined();
    ledger.register(pending());
    ledger.resolve("c1", "CONFIRMED", "ok", AT);
    expect(ledger.resolve("c1", "CONFIRMED", "again", AT)).toBeUndefined();
  });

  it("a repeated registration is not re-registered", () => {
    const ledger = new CancelLedger();
    ledger.register(pending());
    ledger.register(pending());
    expect(ledger.metrics().requested).toBe(1);
  });
});

describe("obligation 9 — reservations", () => {
  it("sums exactly per (market, side) and never across them", () => {
    const book = new ReservationBook();
    book.take({
      reservationId: "r1",
      executionPlanId: "p1",
      plannedOrderId: "o1",
      instanceId: "i1",
      marketId: MARKET,
      side: "YES",
      shares: "50.5",
      collateral: "0",
    });
    book.take({
      reservationId: "r2",
      executionPlanId: "p2",
      plannedOrderId: "o2",
      instanceId: "i1",
      marketId: MARKET,
      side: "YES",
      shares: "0.25",
      collateral: "0",
    });
    book.take({
      reservationId: "r3",
      executionPlanId: "p3",
      plannedOrderId: "o3",
      instanceId: "i1",
      marketId: MARKET,
      side: "NO",
      shares: "10",
      collateral: "0",
    });
    // Exact decimal addition (§6 invariant 1): no float ever touches this.
    expect(book.reservedShares(MARKET, "YES")).toBe("50.75");
    expect(book.reservedShares(MARKET, "NO")).toBe("10");
  });

  it("unreserved collateral floors at zero and over-reservation is REPORTED", () => {
    const book = new ReservationBook();
    book.take({
      reservationId: "r1",
      executionPlanId: "p1",
      plannedOrderId: "o1",
      instanceId: "i1",
      marketId: MARKET,
      side: "YES",
      shares: "0",
      collateral: "150",
    });
    expect(book.unreservedCollateral("100")).toBe("0");
    // The floor is a refusal to go negative, not a repair — and the caller can
    // ask the question the floor hides.
    expect(book.isOverReserved("100")).toBe(true);
    expect(book.isOverReserved("150")).toBe(false);
    expect(book.unreservedCollateral("200")).toBe("50");
  });
});

describe("§8.2 — the instance comparator", () => {
  function instance(overrides: Record<string, unknown>) {
    return {
      // `ROLLOVER-1`: a market-bound registration's key is its instance id.
      key: typeof overrides["instanceId"] === "string" ? overrides["instanceId"] : "a1",
      instanceId: "a1",
      runId: "r1",
      configId: "c1",
      marketId: MARKET,
      ownership: "SHADOW",
      evaluationPriority: 0,
      runtime: {} as never,
      direction: "YES",
      params: {},
      immediateOrderType: "FAK",
      submissionUnknownAfterMs: 5_000,
      ...overrides,
    } as Parameters<typeof compareInstances>[0];
  }

  it("orders by ownership, then priority, then instance id — a TOTAL order", () => {
    const owner = instance({ instanceId: "z", ownership: "OWNER", evaluationPriority: 9 });
    const shadowLowPriority = instance({ instanceId: "a", evaluationPriority: 1 });
    const shadowHighPriority = instance({ instanceId: "b", evaluationPriority: 0 });
    const shadowTieB = instance({ instanceId: "b", evaluationPriority: 5 });
    const shadowTieC = instance({ instanceId: "c", evaluationPriority: 5 });

    expect(compareInstances(owner, shadowLowPriority)).toBeLessThan(0);
    expect(compareInstances(shadowHighPriority, shadowLowPriority)).toBeLessThan(0);
    expect(compareInstances(shadowTieB, shadowTieC)).toBeLessThan(0);
    // Total: no pair is incomparable, and equality only for the same identity.
    expect(compareInstances(shadowTieB, shadowTieB)).toBe(0);
  });

  it("refuses a duplicate instance id", () => {
    const registry = new InstanceRegistry();
    expect(registry.register(instance({ instanceId: "a" })).ok).toBe(true);
    const again = registry.register(instance({ instanceId: "a" }));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("DUPLICATE_INSTANCE");
  });
});

describe("the `immediate_order_type` resolution", () => {
  function positionIntent(tags: readonly string[]): Parameters<typeof resolveTimeInForce>[0] {
    return {
      type: "POSITION",
      intentId: "i1",
      marketId: MARKET,
      direction: "YES",
      targetMode: "DELTA",
      targetShares: "50",
      urgency: "IMMEDIATE",
      liquidityPreference: "TAKER_OK",
      partialFillPolicy: "ACCEPT_ANY",
      validUntil: AT,
      tags: [...tags],
    } as unknown as Parameters<typeof resolveTimeInForce>[0];
  }

  it.each(["GTC", "GTD", "FAK", "FOK"])("reads %s from the intent's tag", (value) => {
    const resolved = resolveTimeInForce(
      positionIntent([`${ORDER_TYPE_TAG_PREFIX}${value}`]),
      "FAK",
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.timeInForce).toBe(value);
  });

  it("REFUSES a tag naming something the venue does not offer — never coerced", () => {
    const resolved = resolveTimeInForce(
      positionIntent([`${ORDER_TYPE_TAG_PREFIX}IOC`]),
      "FAK",
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("refused rather than");
  });

  it("falls back to the instance configuration, and REFUSES when neither states one", () => {
    const fromConfig = resolveTimeInForce(positionIntent([]), "GTD");
    expect(fromConfig.ok && fromConfig.timeInForce).toBe("GTD");
    const neither = resolveTimeInForce(positionIntent([]), undefined);
    expect(neither.ok).toBe(false);
    const bogusConfig = resolveTimeInForce(positionIntent([]), "WHATEVER");
    expect(bogusConfig.ok).toBe(false);
  });
});

describe("the risk-seam caveat's visibility", () => {
  it("a protective-exit tag is recognised for COUNTING only", () => {
    const exit = {
      type: "POSITION",
      tags: ["static-bracket", "sb.protected-reduce"],
    } as unknown as Parameters<typeof isProtectiveExitIntent>[0];
    const entry = {
      type: "POSITION",
      tags: ["static-bracket", "sb.entry"],
    } as unknown as Parameters<typeof isProtectiveExitIntent>[0];
    expect(isProtectiveExitIntent(exit)).toBe(true);
    expect(isProtectiveExitIntent(entry)).toBe(false);
  });

  it("the health surface counts refused exits by reason code and carries the caveat", () => {
    const health = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
    health.countRiskRefusal(["RISK_EDGE_INPUTS_MISSING"], true);
    health.countRiskRefusal(["RISK_MARKET_CLOSE_ONLY"], true);
    health.countRiskRefusal(["RISK_BOOK_STALE"], false);
    health.countRiskApproval();
    const snapshot = health.snapshot({ asOf: AT, halts: [], queues: [], seams: seamMetrics() });
    expect(snapshot.risk.evaluations).toBe(4);
    expect(snapshot.risk.approvals).toBe(1);
    expect(snapshot.risk.refusals).toBe(3);
    expect(snapshot.risk.refusedExits).toBe(2);
    expect(snapshot.risk.refusedExitsByCode).toEqual({
      RISK_EDGE_INPUTS_MISSING: 1,
      RISK_MARKET_CLOSE_ONLY: 1,
    });
    // The disclosure travels WITH the snapshot, not only in a README.
    expect(snapshot.riskSeamCaveat).toBe(RISK_SEAM_CAVEAT);
    expect(snapshot.riskSeamCaveat).toContain("does not weaken risk policy");
  });

  it("counter maps are emitted in SORTED key order, so a snapshot is deterministic", () => {
    const health = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
    health.countRiskRefusal(["Z_CODE"], false);
    health.countRiskRefusal(["A_CODE"], false);
    health.countRiskRefusal(["M_CODE"], false);
    const snapshot = health.snapshot({ asOf: AT, halts: [], queues: [], seams: seamMetrics() });
    expect(Object.keys(snapshot.risk.refusalsByCode)).toEqual(["A_CODE", "M_CODE", "Z_CODE"]);
  });
});
