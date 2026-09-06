/**
 * The §9.7 capital allocator, driven through the assembled system.
 *
 * REVIEW ROUND 1, HIGH-1. The reviewed tip parsed the operator's caps and threw
 * them away, handing `packages/risk` a fabricated `allocation: { permitted:
 * true }`. §9.8 check 14 is fail-closed — an ABSENT verdict refuses every entry
 * — so the fabrication was the only thing satisfying it, and caps of `"1"`
 * everywhere still approved, planned, submitted and filled a ~17 pUSD entry.
 *
 * Every test below is the INVERSE of that probe: the caps decide, and the code
 * that decides is `packages/capital-allocator`'s own.
 *
 * NOTHING IS DOUBLED HERE except the clock, the transport and the store.
 */

import { describe, expect, it } from "vitest";

import { INSTANCE_ID, MARKET_ID, allocatorCaps, traderConfig } from "./support/fixture.js";
import { driveRecordedRun } from "./support/run.js";

/** The fixture's entry: 50 shares bounded at `0.35` — exactly `17.5` pUSD. */
const ENTRY_COST = "17.5";

function withCaps(caps: Record<string, unknown>): Record<string, unknown> {
  return { ...traderConfig(), allocatorCaps: { ...allocatorCaps(), ...caps } };
}

describe("§9.7 capital allocation — the caps decide", () => {
  it("caps of \"1\" REFUSE the entry, and the refusal carries the allocator's own code", async () => {
    const run = await driveRecordedRun({
      config: withCaps({ globalAccountCap: "1", perStrategyCap: "1", perMarketCap: "1" }),
    });
    const health = run.trader.loop.health();

    // The whole chain stops at the risk gate. Not "fewer": zero.
    expect(health.risk.approvals).toBe(0);
    expect(health.execution.plansBuilt).toBe(0);
    expect(health.execution.submissionsAccepted).toBe(0);
    expect(health.execution.fillsObserved).toBe(0);
    expect(run.trader.loop.traces()).toEqual([]);

    // §9.8 check 14 refused because the ALLOCATOR did, not because a verdict
    // was missing: `RISK_ALLOCATION_VERDICT_MISSING` would mean no allocator
    // ran at all, which is exactly the state the fabrication hid.
    expect(Object.keys(health.risk.refusalsByCode)).toContain("RISK_ALLOCATION_REFUSED");
    expect(Object.keys(health.risk.refusalsByCode)).not.toContain(
      "RISK_ALLOCATION_VERDICT_MISSING",
    );

    // …and the allocator's OWN vocabulary says which cap, on the seam surface.
    const codes = Object.keys(health.seams.allocator.refusalsByCode);
    expect(codes).toContain("CAPITAL_GLOBAL_CAP_EXCEEDED");
    expect(codes).toContain("CAPITAL_STRATEGY_CAP_EXCEEDED");
    expect(codes).toContain("CAPITAL_MARKET_CAP_EXCEEDED");
  });

  it("the SHIPPED generous caps still trade end to end (acceptance 3, with the real allocator)", async () => {
    const run = await driveRecordedRun();
    const health = run.trader.loop.health();
    expect(health.risk.approvals).toBe(1);
    expect(health.execution.submissionsAccepted).toBe(1);
    expect(health.execution.fillsObserved).toBe(1);
    // The allocator was ASKED and it permitted: one reservation applied before
    // submission (§9.10) and released when the order reached its terminal
    // state, leaving nothing held.
    expect(health.seams.allocator.applied).toBe(1);
    expect(health.seams.allocator.released).toBe(1);
    expect(health.seams.allocator.open).toBe(0);
    expect(health.seams.allocator.refusalsByCode).toEqual({});
  });

  it("THE BOUNDARY: a per-strategy cap at exactly the entry's cost permits it", async () => {
    const run = await driveRecordedRun({
      config: withCaps({ perStrategyCap: ENTRY_COST }),
    });
    const health = run.trader.loop.health();
    expect(health.risk.approvals).toBe(1);
    expect(health.execution.fillsObserved).toBe(1);
    expect(Object.keys(health.seams.allocator.refusalsByCode)).not.toContain(
      "CAPITAL_STRATEGY_CAP_EXCEEDED",
    );
  });

  it("THE BOUNDARY: one tick below it REFUSES — the cap is compared, not approximated", async () => {
    const run = await driveRecordedRun({
      config: withCaps({ perStrategyCap: "17.49" }),
    });
    const health = run.trader.loop.health();
    expect(health.risk.approvals).toBe(0);
    expect(health.execution.fillsObserved).toBe(0);
    expect(Object.keys(health.seams.allocator.refusalsByCode)).toEqual([
      "CAPITAL_STRATEGY_CAP_EXCEEDED",
    ]);
  });

  it("a scope cap with an attribution the market states is compared against the SCOPE", async () => {
    // §9.7's per-series cap. The fixture's market states `seriesKey`, so the
    // request is attributable and the cap is a real comparison rather than a
    // `CAPITAL_SCOPE_KEY_MISSING` fail-closed.
    const refused = await driveRecordedRun({ config: withCaps({ perSeriesCap: "1" }) });
    const refusedCodes = Object.keys(refused.trader.loop.health().seams.allocator.refusalsByCode);
    expect(refusedCodes).toContain("CAPITAL_SERIES_CAP_EXCEEDED");
    expect(refusedCodes).not.toContain("CAPITAL_SCOPE_KEY_MISSING");

    const permitted = await driveRecordedRun({ config: withCaps({ perSeriesCap: "100" }) });
    expect(permitted.trader.loop.health().execution.fillsObserved).toBe(1);
  });

  it("the §9.8 check-15 exposure snapshot is SUPPLIED, and covers the queried scopes", async () => {
    // An absent snapshot with a configured cap is `RISK_EXPOSURE_SNAPSHOT_MISSING`
    // and an absent ENTRY is `RISK_EXPOSURE_ENTRY_MISSING`; both fail closed.
    // Configuring every scope cap generously proves the snapshot ANSWERS for
    // each of them rather than merely being present.
    const run = await driveRecordedRun({
      config: {
        ...traderConfig(),
        riskPolicy: {
          ...(traderConfig()["riskPolicy"] as Record<string, unknown>),
          limits: {
            maxWorstCaseContractualLoss: "1000",
            globalExposureCap: "1000",
            perInstanceExposureCap: "1000",
            perMarketExposureCap: "1000",
            perSeriesExposureCap: "1000",
            perUnderlyingExposureCap: "1000",
            perResolutionWindowExposureCap: "1000",
          },
        },
      },
    });
    const health = run.trader.loop.health();
    expect(Object.keys(health.risk.refusalsByCode)).not.toContain(
      "RISK_EXPOSURE_SNAPSHOT_MISSING",
    );
    expect(Object.keys(health.risk.refusalsByCode)).not.toContain("RISK_EXPOSURE_ENTRY_MISSING");
    expect(health.execution.fillsObserved).toBe(1);
  });

  it("a configured exposure cap BELOW the entry refuses it — the snapshot is real, not decorative", async () => {
    const run = await driveRecordedRun({
      config: {
        ...traderConfig(),
        riskPolicy: {
          ...(traderConfig()["riskPolicy"] as Record<string, unknown>),
          limits: { maxWorstCaseContractualLoss: "1000", globalExposureCap: "1" },
        },
      },
    });
    const health = run.trader.loop.health();
    expect(health.risk.approvals).toBe(0);
    expect(Object.keys(health.risk.refusalsByCode)).toContain("RISK_GLOBAL_EXPOSURE_EXCEEDED");
  });

  it("the POSITION a fill creates carries its EXACT cost basis into the next evaluation", async () => {
    const run = await driveRecordedRun();
    // 50 shares filled at 0.34 — `packages/simulation`'s own fill, folded FIFO.
    // A `"0"` here (the reviewed tip's value) would tell §9.7's exposure table
    // and §9.8's worst-case builder that the position had consumed nothing.
    expect(run.trader.loop.costBasisOf(INSTANCE_ID, MARKET_ID, "YES")).toBe("17");
  });
});
