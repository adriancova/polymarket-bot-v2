/**
 * WP-200 acceptance 4, allocation half: "Unattributed activity creates an
 * explicit scope."
 *
 * The property under test is that a fill's quantity is PARTITIONED: every
 * share of it appears in exactly one returned record, claims may never
 * over-cover it (§10.7, §16.2), and a shortfall is never silently absorbed
 * into a claim or dropped — it becomes a named `UNATTRIBUTED` record whose
 * `haltRequired` is the literal `true`.
 */

import { addDecimal } from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import { allocateFill } from "./allocation.js";
import type { FillAllocationResult } from "./allocation.js";
import {
  ACCOUNT,
  INSTANCE_A,
  INSTANCE_B,
  MARKET_A,
  PUSD,
  TIMESTAMP,
  YES_TOKEN,
  fillId,
} from "./testing/scenarios.js";

const FILL = {
  fillId: fillId(1),
  marketId: MARKET_A,
  environment: "PAPER",
  accountRef: ACCOUNT,
  tokenAssetId: YES_TOKEN,
  denominationAssetId: PUSD,
  side: "BUY",
  shares: "10",
  price: "0.42",
  source: "polymarket",
  occurredAt: TIMESTAMP,
} as const;

function allocated(fill: unknown, claims: readonly unknown[]): FillAllocationResult {
  const result = allocateFill(fill, claims);
  if (!result.ok) {
    throw new Error(`unexpected refusal: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function codesOf(fill: unknown, claims: readonly unknown[]): readonly string[] {
  const result = allocateFill(fill, claims);
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

describe("allocateFill: exact partition", () => {
  it("allocates a fully claimed fill with no unattributed remainder", () => {
    const result = allocated(FILL, [
      { instanceId: INSTANCE_A, shares: "6" },
      { instanceId: INSTANCE_B, shares: "4" },
    ]);
    expect(result.allocations.map((allocation) => allocation.shares)).toEqual(["6", "4"]);
    expect(result.unattributed).toBeUndefined();
    expect(result.allocatedShares).toBe("10");
  });

  it("carries the run id when a claim states one", () => {
    const result = allocated(FILL, [
      { instanceId: INSTANCE_A, runId: "018f3a5c-3333-7000-8000-00000000000a", shares: "10" },
    ]);
    expect(result.allocations[0]?.runId).toBe("018f3a5c-3333-7000-8000-00000000000a");
  });

  it("marks every allocation as VIRTUAL_STRATEGY scope", () => {
    const result = allocated(FILL, [{ instanceId: INSTANCE_A, shares: "10" }]);
    expect(result.allocations[0]?.scope).toBe("VIRTUAL_STRATEGY");
  });
});

describe("acceptance 4: an unmatched share lands in an explicit UNATTRIBUTED scope", () => {
  it("creates a named record for a partial shortfall", () => {
    const result = allocated(FILL, [{ instanceId: INSTANCE_A, shares: "6" }]);
    expect(result.unattributed).toEqual({
      fillId: fillId(1),
      scope: "UNATTRIBUTED",
      shares: "4",
      feeAmount: "0",
      affectedMarketId: MARKET_A,
      haltRequired: true,
    });
  });

  it("creates a record for a fill that matches NO claim at all", () => {
    const result = allocated(FILL, []);
    expect(result.allocations).toEqual([]);
    expect(result.unattributed?.shares).toBe("10");
    expect(result.unattributed?.haltRequired).toBe(true);
  });

  it("never silently absorbs the remainder into a claim", () => {
    const result = allocated(FILL, [{ instanceId: INSTANCE_A, shares: "6" }]);
    expect(result.allocations[0]?.shares).toBe("6");
    expect(result.allocations).toHaveLength(1);
  });

  it("accounts for every share exactly once (claims + remainder = fill)", () => {
    // Asserted with EXACT decimal arithmetic. A float sum of 9.999 + 0.001
    // is 9.999999999999998, which would make this test pass for the wrong
    // reason with a tolerance and fail for the wrong reason without one.
    for (const claimed of ["1", "2.5", "9.999", "0.0000001", "10"]) {
      const result = allocated(FILL, [{ instanceId: INSTANCE_A, shares: claimed }]);
      const remainder = result.unattributed?.shares ?? "0";
      expect(result.allocations).toHaveLength(1);
      expect(addDecimal(claimed, remainder)).toBe("10");
      expect(result.allocatedShares).toBe("10");
    }
  });

  it("names the market so the §9.15 halt has a target", () => {
    expect(allocated(FILL, []).unattributed?.affectedMarketId).toBe(MARKET_A);
  });
});

describe("allocateFill: refusals", () => {
  it("refuses claims that over-cover the fill, naming the excess", () => {
    const result = allocateFill(FILL, [
      { instanceId: INSTANCE_A, shares: "7" },
      { instanceId: INSTANCE_B, shares: "4" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("LEDGER_ALLOCATION_EXCEEDS_FILL");
    expect(result.refusals[0]?.details).toMatchObject({
      fillShares: "10",
      claimedShares: "11",
      excess: "1",
    });
  });

  it("refuses two claims naming the same instance", () => {
    expect(
      codesOf(FILL, [
        { instanceId: INSTANCE_A, shares: "3" },
        { instanceId: INSTANCE_A, shares: "3" },
      ]),
    ).toEqual(["LEDGER_ALLOCATION_DUPLICATE_INSTANCE"]);
  });

  it("refuses a zero-share claim: a claim on nothing is not a claim", () => {
    expect(codesOf(FILL, [{ instanceId: INSTANCE_A, shares: "0" }])).toEqual([
      "LEDGER_INPUT_INVALID",
    ]);
  });

  it("refuses a negative-share claim", () => {
    expect(codesOf(FILL, [{ instanceId: INSTANCE_A, shares: "-3" }])).toEqual([
      "LEDGER_INPUT_INVALID",
    ]);
  });

  it("refuses a fill priced outside the unit interval", () => {
    expect(codesOf({ ...FILL, price: "1.5" }, [])).toEqual(["LEDGER_INPUT_INVALID"]);
  });

  it("refuses a numeric share quantity", () => {
    expect(codesOf({ ...FILL, shares: 10 }, [])).toEqual(["LEDGER_INPUT_INVALID"]);
  });
});

describe("fee partition: never a silent proration", () => {
  const FEE_FILL = { ...FILL, feeAmount: "0.07", feeScheduleVersionRef: "fees-2026-09-01" };

  it("gives the whole fee to a single full claimant", () => {
    const result = allocated(FEE_FILL, [{ instanceId: INSTANCE_A, shares: "10" }]);
    expect(result.allocations[0]?.feeAmount).toBe("0.07");
    expect(result.unattributed).toBeUndefined();
  });

  it("gives the whole fee to the unattributed record when nobody claims", () => {
    const result = allocated(FEE_FILL, []);
    expect(result.unattributed?.feeAmount).toBe("0.07");
  });

  it("refuses shared ownership with no explicit split", () => {
    const result = allocateFill(FEE_FILL, [
      { instanceId: INSTANCE_A, shares: "6" },
      { instanceId: INSTANCE_B, shares: "4" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("LEDGER_FEE_SPLIT_MISMATCH");
    expect(result.refusals[0]?.details).toMatchObject({ feeAmount: "0.07", owners: 2 });
  });

  it("accepts an explicit split that sums exactly to the fee", () => {
    const result = allocated(FEE_FILL, [
      { instanceId: INSTANCE_A, shares: "6", feeAmount: "0.042" },
      { instanceId: INSTANCE_B, shares: "4", feeAmount: "0.028" },
    ]);
    expect(result.allocations.map((allocation) => allocation.feeAmount)).toEqual([
      "0.042",
      "0.028",
    ]);
  });

  it("refuses an explicit split that is a penny short", () => {
    const result = allocateFill(FEE_FILL, [
      { instanceId: INSTANCE_A, shares: "6", feeAmount: "0.042" },
      { instanceId: INSTANCE_B, shares: "4", feeAmount: "0.027" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("LEDGER_FEE_SPLIT_MISMATCH");
    expect(result.refusals[0]?.details).toMatchObject({ splitTotal: "0.069", feeAmount: "0.07" });
  });

  it("refuses a split that over-claims the fee, leaving the remainder negative", () => {
    const result = allocateFill(FEE_FILL, [
      { instanceId: INSTANCE_A, shares: "6", feeAmount: "0.08" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("LEDGER_FEE_SPLIT_MISMATCH");
  });

  it("gives an unattributed remainder its exact share of the fee", () => {
    const result = allocated(FEE_FILL, [
      { instanceId: INSTANCE_A, shares: "6", feeAmount: "0.042" },
    ]);
    expect(result.allocations[0]?.feeAmount).toBe("0.042");
    expect(result.unattributed?.feeAmount).toBe("0.028");
  });

  it("assigns zero fee shares when the fill charged no fee", () => {
    const result = allocated(FILL, [{ instanceId: INSTANCE_A, shares: "6" }]);
    expect(result.allocations[0]?.feeAmount).toBe("0");
    expect(result.unattributed?.feeAmount).toBe("0");
  });
});
