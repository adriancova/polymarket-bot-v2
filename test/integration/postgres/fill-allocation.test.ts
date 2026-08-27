/**
 * WP-040 acceptance 2: "Fill allocation cannot exceed fill quantity."
 *
 * §10.7: "Every fill allocation sum equals the actual fill quantity."
 * ADR-006 §4: allocations can never exceed the fill; §6 invariant 7 makes the
 * equality reachable by allocating anything unattributable to `UNATTRIBUTED`.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp } from "@polymarket-bot/storage-postgres/testing";
import {
  FillAllocationExceedsFillError,
  FillAllocationIncompleteError,
  UniqueViolationError,
  uuidV7,
} from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("fill_allocation");

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;
let orderId: string;
let tradeCounter = 0;

function nextTradeId(): string {
  tradeCounter += 1;
  return `trade-${tradeCounter}`;
}

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "fills" });

  orderId = await context.repositories.orders.insertOrder({
    planId: chain.planId,
    executionGroupId: chain.executionGroupId,
    // A fill requires its order to carry the attempt that signed it (§9.11).
    submissionAttemptId: chain.submissionAttemptId,
    marketId: chain.marketId,
    tokenId: chain.tokenId,
    side: "BUY",
    limitPrice: "0.42",
    originalShares: "100",
    state: "LIVE",
  });
});

function baseFill(overrides: Partial<Parameters<typeof context.repositories.fills.recordFill>[0]> = {}) {
  return {
    orderId,
    marketId: chain.marketId,
    tokenId: chain.tokenId,
    venueTradeId: nextTradeId(),
    venueOrderId: "venue-order-1",
    side: "BUY" as const,
    shares: "10",
    price: "0.42",
    notional: "4.2",
    liquidityRole: "TAKER" as const,
    matchedAt: fixtureTimestamp(),
    allocations: [
      {
        scope: "VIRTUAL_STRATEGY" as const,
        instanceId: chain.instanceId,
        runId: chain.runId,
        allocatedShares: "10",
      },
    ],
    ...overrides,
  };
}

describe("fill allocation", () => {
  it("accepts an allocation that exactly equals the fill quantity", async () => {
    const fillId = await context.repositories.fills.recordFill(baseFill());
    const stored = await context.repositories.fills.findFill(fillId);

    expect(stored?.fill.shares).toBe("10");
    expect(stored?.allocations.map((allocation) => allocation.allocated_shares)).toEqual(["10"]);
  });

  it("accepts a split across a strategy and UNATTRIBUTED (§6 invariant 7)", async () => {
    const fillId = await context.repositories.fills.recordFill(
      baseFill({
        allocations: [
          {
            scope: "VIRTUAL_STRATEGY",
            instanceId: chain.instanceId,
            runId: chain.runId,
            allocatedShares: "7.5",
          },
          { scope: "UNATTRIBUTED", allocatedShares: "2.5" },
        ],
      }),
    );

    const stored = await context.repositories.fills.findFill(fillId);
    expect(
      stored?.allocations
        .map((allocation) => allocation.allocated_shares)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["2.5", "7.5"]);
  });

  it("REJECTS an allocation total above the fill quantity", async () => {
    const error = await captureRejection(async () =>
      context.repositories.fills.recordFill(
        baseFill({
          shares: "10",
          allocations: [
            {
              scope: "VIRTUAL_STRATEGY",
              instanceId: chain.instanceId,
              runId: chain.runId,
              allocatedShares: "10.000001",
            },
          ],
        }),
      ),
    );

    expect(error).toBeInstanceOf(FillAllocationExceedsFillError);
    expect((error as FillAllocationExceedsFillError).sqlState).toBe("PMB03");
  });

  it("REJECTS over-allocation assembled from several allocations", async () => {
    const error = await captureRejection(async () =>
      context.repositories.fills.recordFill(
        baseFill({
          shares: "10",
          allocations: [
            {
              scope: "VIRTUAL_STRATEGY",
              instanceId: chain.instanceId,
              runId: chain.runId,
              allocatedShares: "6",
            },
            { scope: "UNATTRIBUTED", allocatedShares: "5" },
          ],
        }),
      ),
    );

    expect(error).toBeInstanceOf(FillAllocationExceedsFillError);
  });

  it("REJECTS over-allocation appended in a later transaction", async () => {
    const fillId = await context.repositories.fills.recordFill(baseFill({ shares: "4" , allocations: [
      { scope: "UNATTRIBUTED", allocatedShares: "4" },
    ] }));

    const error = await captureRejection(async () =>
      context.repositories.fills.appendAllocations(fillId, [
        {
          scope: "VIRTUAL_STRATEGY",
          instanceId: chain.instanceId,
          runId: chain.runId,
          allocatedShares: "0.000000001",
        },
      ]),
    );

    expect(error).toBeInstanceOf(FillAllocationExceedsFillError);
  });

  it("REJECTS a fill whose allocations do not close, at COMMIT", async () => {
    const error = await captureRejection(async () =>
      context.repositories.fills.recordFill(
        baseFill({
          shares: "10",
          allocations: [{ scope: "UNATTRIBUTED", allocatedShares: "9" }],
        }),
      ),
    );

    expect(error).toBeInstanceOf(FillAllocationIncompleteError);
    expect((error as FillAllocationIncompleteError).sqlState).toBe("PMB04");
  });

  it("REJECTS a fill recorded with no allocation at all", async () => {
    const error = await captureRejection(async () =>
      context.repositories.fills.recordFill(baseFill({ allocations: [] })),
    );

    expect(error).toBeInstanceOf(FillAllocationIncompleteError);
  });

  it("compares exactly, with no floating-point tolerance", async () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; in `numeric` it is exact, so this closes.
    const fillId = await context.repositories.fills.recordFill(
      baseFill({
        shares: "0.3",
        allocations: [
          {
            scope: "VIRTUAL_STRATEGY",
            instanceId: chain.instanceId,
            runId: chain.runId,
            allocatedShares: "0.1",
          },
          { scope: "UNATTRIBUTED", allocatedShares: "0.2" },
        ],
      }),
    );

    const stored = await context.repositories.fills.findFill(fillId);
    expect(stored?.fill.shares).toBe("0.3");
  });

  it("deduplicates fills on the §10.7 venue identity", async () => {
    const venueTradeId = nextTradeId();
    await context.repositories.fills.recordFill(baseFill({ venueTradeId }));

    const error = await captureRejection(async () =>
      context.repositories.fills.recordFill(baseFill({ venueTradeId })),
    );
    expect(error).toBeInstanceOf(UniqueViolationError);
  });

  it("distinguishes two facts of one venue trade by the allocation discriminator", async () => {
    const venueTradeId = nextTradeId();
    await context.repositories.fills.recordFill(
      baseFill({ venueTradeId, allocationDiscriminator: "0" }),
    );
    const second = await context.repositories.fills.recordFill(
      baseFill({ venueTradeId, allocationDiscriminator: "1" }),
    );
    expect(second).toMatch(/^[0-9a-f]{8}-/u);
  });

  it("rejects a VIRTUAL_STRATEGY allocation with no instance", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into execution.fill_allocations
           (fill_allocation_id, fill_id, scope, allocated_shares)
         values ($1, (select fill_id from execution.fills limit 1), 'VIRTUAL_STRATEGY', '1')`,
        [uuidV7()],
      ),
    );
    expect((error as { code?: string }).code).toBe("23514");
  });

  it("rejects an allocation scope that is not an attribution scope (ADR-006 §2)", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into execution.fill_allocations
           (fill_allocation_id, fill_id, scope, allocated_shares)
         values ($1, (select fill_id from execution.fills limit 1), 'EXTERNAL_CLEARING', '1')`,
        [uuidV7()],
      ),
    );
    expect((error as { code?: string }).code).toBe("23514");
  });
});
