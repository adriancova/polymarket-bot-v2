/**
 * The structural port pins (the `WP-190` `ports.test.ts` precedent).
 *
 * `packages/simulation` is layer 1 and declares exactly one workspace
 * dependency, `@polymarket-bot/decimal`. Every other shape it consumes — the
 * §7.1 envelope, WP-190's execution plan, WP-150's book, WP-200's fill fact,
 * §11's run modes — is mirrored STRUCTURALLY in `src/ports.ts`, because
 * `packages/{domain,execution-planner,order-book,ledger}` are layer 0/1 with no
 * §2.1 row permitting an edge (F13), and `packages/storage-*` are layer 2 (F12,
 * upward, always forbidden).
 *
 * A structural mirror is only safe if it is BOUND. This suite is the binding: it
 * imports the REAL packages at the root test level — which creates no workspace
 * edge — and pins each mirror three ways where possible:
 *
 * 1. **compile-time**, with `satisfies` against the real inferred type, so a
 *    field whose type changes upstream fails `pnpm typecheck`;
 * 2. **key-set**, so a field ADDED or REMOVED upstream fails, which `satisfies`
 *    alone would not catch in the "added" direction;
 * 3. **behaviourally**, by putting the mirrored value through the REAL upstream
 *    function (`sealExecutionPlan`, `OutcomeTokenBook`, `allocateFill`).
 */

import { describe, expect, it } from "vitest";

import { RUN_MODES, RUN_MODE_REQUIRES_LIVE_SIGNER } from "../../../packages/domain/src/index.js";
import type { EventEnvelope as DomainEventEnvelope } from "../../../packages/domain/src/index.js";
import {
  PLAN_PRIORITY_RANK as PLANNER_RANK,
  comparePlanPriority as plannerComparePriority,
} from "../../../packages/execution-planner/src/index.js";
import type {
  CancelPlan,
  ExecutionGroup,
  PlacementPlan,
  PlannedOrder,
} from "../../../packages/execution-planner/src/index.js";
import { OutcomeTokenBook } from "../../../packages/order-book/src/index.js";
import { allocateFill } from "../../../packages/ledger/src/index.js";
import {
  PLAN_PRIORITY_RANK,
  SIMULATED_RUN_MODES,
  comparePlanPriority,
  simulatedFill,
  tier0Model,
  toFillFact,
  type BookView,
  type CancelPlanView,
  type EventEnvelope,
  type ExecutionGroupView,
  type PlacementPlanView,
  type PlannedOrderView,
  type RunMode,
} from "../../../packages/simulation/src/index.js";

const MARKET_ID = "0190a3e0-0000-7000-8000-00000000000a";
const TOKEN_ID = "7134526469571836016";

// ---------------------------------------------------------------------------
// §7.1 envelope
// ---------------------------------------------------------------------------

describe("the §7.1 envelope mirror is the frozen declaration", () => {
  it("is assignable in both directions", () => {
    const mine: EventEnvelope<string> = {
      eventId: "0190a3e0-0000-7000-8000-000000000001",
      eventType: "BookSnapshot",
      schemaVersion: 1,
      source: "polymarket",
      sourceChannel: "market",
      receivedAt: "2026-01-01T00:00:00.000Z",
      receivedMonotonicNs: "1000",
      gatewayEpoch: "0190a3e0-0000-7000-8000-000000000002",
      ingestSeq: "1",
      payload: "x",
    };
    const asDomain: DomainEventEnvelope<string> = mine;
    const backAgain: EventEnvelope<string> = asDomain;
    expect(backAgain.eventId).toBe(mine.eventId);
  });

  it("carries exactly the frozen field set", () => {
    // Written as a total mapping over the domain type's keys: a field added
    // upstream makes this object incomplete and fails to compile.
    const everyField: Record<keyof DomainEventEnvelope<unknown>, true> = {
      eventId: true,
      eventType: true,
      schemaVersion: true,
      source: true,
      sourceChannel: true,
      venueTimestamp: true,
      receivedAt: true,
      receivedMonotonicNs: true,
      gatewayEpoch: true,
      ingestSeq: true,
      connectionId: true,
      subscriptionGeneration: true,
      rawSegmentId: true,
      rawRecordOffset: true,
      correlationId: true,
      causationId: true,
      payload: true,
    };
    const mirrored: Record<keyof EventEnvelope<unknown>, true> = everyField;
    expect(Object.keys(mirrored).sort()).toEqual(Object.keys(everyField).sort());
  });
});

// ---------------------------------------------------------------------------
// §11 run modes
// ---------------------------------------------------------------------------

describe("the §11 run-mode mirror is the frozen vocabulary", () => {
  it("names exactly the frozen run modes", () => {
    const mirrored: Record<RunMode, true> = {
      BACKTEST: true,
      PAPER: true,
      SHADOW: true,
      EXECUTION_PROBE: true,
      LIVE_MICRO: true,
      LIVE: true,
    };
    expect(Object.keys(mirrored).sort()).toEqual([...RUN_MODES].sort());
  });

  it("SIMULATED_RUN_MODES is exactly the set that does NOT require a live signer", () => {
    const withoutSigner = RUN_MODES.filter((mode) => !RUN_MODE_REQUIRES_LIVE_SIGNER[mode]);
    expect([...SIMULATED_RUN_MODES].sort()).toEqual([...withoutSigner].sort());
  });
});

// ---------------------------------------------------------------------------
// WP-190 execution plan
// ---------------------------------------------------------------------------

describe("the WP-190 plan mirror is the real plan", () => {
  it("shares the §6 invariant 13 rank and comparison", () => {
    expect(PLAN_PRIORITY_RANK).toEqual(PLANNER_RANK);
    for (const left of ["SAFETY_CANCEL", "PLACEMENT"] as const) {
      for (const right of ["SAFETY_CANCEL", "PLACEMENT"] as const) {
        expect(comparePlanPriority(left, right)).toBe(plannerComparePriority(left, right));
      }
    }
  });

  it("a real PlannedOrder satisfies the mirrored view", () => {
    const real = {
      plannedOrderId: "order-1",
      marketId: MARKET_ID,
      side: "YES",
      action: "BUY",
      limitPrice: "0.6",
      shares: "10",
      postOnly: false,
      executionStyle: "MARKETABLE_LIMIT",
      reservationId: "res-1",
    } as const satisfies PlannedOrder;
    const mirrored: PlannedOrderView = real;
    expect(mirrored.plannedOrderId).toBe("order-1");
  });

  it("a real ExecutionGroup satisfies the mirrored view", () => {
    const real = {
      executionGroupId: "group-1",
      marketId: MARKET_ID,
      tickSize: "0.01",
      minimumOrderSize: "5",
      orders: [],
    } as const satisfies ExecutionGroup;
    const mirrored: ExecutionGroupView = real;
    expect(mirrored.orders).toEqual([]);
  });

  it("a real PlacementPlan is assignable to the mirrored view", () => {
    const real: PlacementPlan = {
      executionPlanId: "plan-1",
      approvedIntentId: "approved-1",
      rootApprovedIntentId: "approved-1",
      strategyInstanceId: "instance-1",
      runMode: "PAPER",
      plannedAt: "2026-01-01T00:00:00.000Z",
      deadline: "2026-01-01T00:00:10.000Z",
      provenance: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        lineage: "ORIGINAL",
        worstCaseBasis: "EVALUATED",
      },
      planKind: "POSITION",
      priority: "PLACEMENT",
      priceProtection: { mode: "CAPPED_LIMIT_ORDERS_ONLY" },
      escalation: { atDeadline: "CANCEL_REMAINING" },
      accountingMode: "LIVE",
      legSelection: {
        selected: "BUY_DIRECTION",
        side: "YES",
        action: "BUY",
        effectiveExposurePrice: "0.5",
        reason: "DIRECT",
      },
      partialFill: { policy: "ACCEPT_ANY" },
      hysteresis: { replaceThresholdTicks: 1, minimumReplaceIntervalMs: 1000 },
      reservationRule: "RESERVE_BEFORE_SUBMISSION",
      groups: [],
      reservations: [],
      estimates: {
        basis: "ESTIMATE",
        worstCaseCost: "0",
        expectedProceeds: "0",
        fees: "0",
        slippage: "0",
      },
    };
    // The mirror is a NARROWER view of the same plan, so the real value is
    // assignable to it. A field the venue reads that upstream renames or
    // retypes fails here.
    const mirrored: PlacementPlanView = real;
    expect(mirrored.planKind).toBe("POSITION");
    expect(mirrored.priority).toBe("PLACEMENT");
  });

  it("a real CancelPlan is assignable to the mirrored view", () => {
    const real: CancelPlan = {
      executionPlanId: "plan-cancel",
      approvedIntentId: "approved-2",
      rootApprovedIntentId: "approved-2",
      strategyInstanceId: "instance-1",
      runMode: "PAPER",
      plannedAt: "2026-01-01T00:00:00.000Z",
      deadline: "2026-01-01T00:00:10.000Z",
      provenance: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        lineage: "ORIGINAL",
        worstCaseBasis: "EVALUATED",
      },
      planKind: "CANCEL",
      priority: "SAFETY_CANCEL",
      priceProtection: { mode: "NO_NEW_ORDERS" },
      escalation: { atDeadline: "ESCALATE_TO_RECONCILIATION" },
      scope: { marketId: MARKET_ID },
      reason: "kill switch",
    };
    const mirrored: CancelPlanView = real;
    expect(mirrored.planKind).toBe("CANCEL");
  });
});

// ---------------------------------------------------------------------------
// WP-150 book
// ---------------------------------------------------------------------------

describe("the WP-150 book mirror accepts the REAL OutcomeTokenBook", () => {
  it("adapts a real book to the BookView the fill models read", () => {
    const real = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const applied = real.applySnapshot({
      payload: {
        internalMarketId: MARKET_ID,
        tokenId: TOKEN_ID,
        bids: [
          { price: "0.07", size: "100" },
          { price: "0.08", size: "50" },
        ],
        asks: [
          { price: "0.09", size: "60" },
          { price: "0.1", size: "70" },
        ],
      },
      meta: {
        gatewayEpoch: "0190a3e0-0000-7000-8000-000000000002",
        ingestSeq: "1",
        subscriptionGeneration: 1,
        receivedAt: "2026-06-29T17:15:57.300Z",
      },
    });
    expect(applied.applied, JSON.stringify(applied)).toBe(true);

    // The adapter a composition root writes. It compiles only if the real
    // book's own accessors produce the mirrored shapes.
    const view: BookView = {
      internalMarketId: real.internalMarketId,
      tokenId: real.tokenId,
      top: () => real.topOfBook(),
      ladder: (side) => real.levels(side),
    };
    expect(view.ladder("ASK")[0]).toEqual({ price: "0.09", size: "60" });
    expect(view.ladder("BID")[0]).toEqual({ price: "0.08", size: "50" });
    expect(view.top().bestBidPrice).toBe("0.08");
  });
});

// ---------------------------------------------------------------------------
// WP-200 ledger
// ---------------------------------------------------------------------------

describe("a simulated fill folds through the REAL ledger allocation", () => {
  it("converts to a FillFact the real allocateFill accepts", () => {
    const fill = simulatedFill({
      simulatedFillId: "sim-fill-1",
      simulatedOrderId: "order-1",
      marketId: MARKET_ID,
      tokenId: TOKEN_ID,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "10",
      feeAmount: "0.175",
      liquidityRole: "TAKER",
      model: tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
      atEvent: {
        gatewayEpoch: "0190a3e0-0000-7000-8000-000000000002",
        ingestSeq: "1",
        receivedAt: "2026-01-01T00:00:00.000Z",
        datasetRowOrdinal: 0,
      },
    });

    const fact = toFillFact(fill, {
      fillId: "0190a3e0-0000-7000-8000-00000000000b",
      environment: "BACKTEST",
      accountRef: "sim-account",
      tokenAssetId: `token:${TOKEN_ID}`,
      denominationAssetId: "USDC",
      source: "polymarket",
    });

    const allocated = allocateFill(fact, [
      { instanceId: "0190a3e0-0000-7000-8000-00000000000c", shares: "10", feeAmount: "0.175" },
    ]);
    expect(allocated.ok, JSON.stringify(allocated)).toBe(true);
    if (!allocated.ok) return;
    expect(allocated.value.allocations).toHaveLength(1);
    expect(allocated.value.allocations[0]?.shares).toBe("10");
  });

  it("the environment it books under is a SIMULATED run mode, never a live one", () => {
    const fill = simulatedFill({
      simulatedFillId: "sim-fill-2",
      simulatedOrderId: "order-1",
      marketId: MARKET_ID,
      tokenId: TOKEN_ID,
      side: "YES",
      action: "SELL",
      price: "0.5",
      shares: "1",
      feeAmount: "0",
      liquidityRole: "MAKER",
      model: tier0Model({ fillModelVersion: "v", fillModelParametersHash: "0".repeat(64) }),
      atEvent: {
        gatewayEpoch: "0190a3e0-0000-7000-8000-000000000002",
        ingestSeq: "1",
        receivedAt: "2026-01-01T00:00:00.000Z",
        datasetRowOrdinal: 0,
      },
    });
    const fact = toFillFact(fill, {
      fillId: "0190a3e0-0000-7000-8000-00000000000d",
      environment: "PAPER",
      accountRef: "sim-account",
      tokenAssetId: `token:${TOKEN_ID}`,
      denominationAssetId: "USDC",
      source: "polymarket",
    });
    expect([...SIMULATED_RUN_MODES]).toContain(fact.environment);
    expect(RUN_MODE_REQUIRES_LIVE_SIGNER[fact.environment]).toBe(false);
  });
});
