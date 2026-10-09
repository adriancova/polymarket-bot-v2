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

import {
  INSTANCE_ID,
  INSTANCE_ID_2,
  MARKET_ID,
  MARKET_ID_2,
  RUN_ID_2,
  allocatorCaps,
  traderConfig,
  twoMarketConfig,
  twoMarketEvents,
} from "./support/fixture.js";
import { assembleOrThrow, driveRecordedRun, type Run } from "./support/run.js";

/** The fixture's entry: 50 shares bounded at `0.35` — exactly `17.5` pUSD. */
const ENTRY_COST = "17.5";

function withCaps(caps: Record<string, unknown>): Record<string, unknown> {
  return { ...traderConfig(), allocatorCaps: { ...allocatorCaps(), ...caps } };
}

/** The same override, applied to an arbitrary document. */
function capsOn(
  config: Record<string, unknown>,
  caps: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...config,
    allocatorCaps: { ...(config["allocatorCaps"] as Record<string, unknown>), ...caps },
  };
}

/** Drives the TWO-market recorded sequence: market 1 completes before market 2. */
async function driveTwoMarketRun(config: Record<string, unknown>): Promise<Run> {
  const run = assembleOrThrow({ config });
  for (const event of twoMarketEvents()) run.trader.loop.ingest(event);
  await run.trader.loop.drain();
  return run;
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
    // `RISK-2`: `approvals`, `submissionsAccepted` and `applied` each read `1`
    // while the take-profit was refused at the risk seam (GOV-2B blocker B2).
    // The exit is now approved and placed, so each counts the entry AND the
    // exit. `fillsObserved` is unchanged: the exit RESTS at its take-profit
    // price and this fixture's events end before anything lifts it.
    expect(health.risk.approvals).toBe(2);
    expect(health.execution.submissionsAccepted).toBe(2);
    expect(health.execution.fillsObserved).toBe(1);
    // The allocator was ASKED and it permitted BOTH: two reservations applied
    // before submission (§9.10), one released when the entry order reached its
    // terminal state, one still held for the live exit.
    expect(health.seams.allocator.applied).toBe(2);
    expect(health.seams.allocator.released).toBe(1);
    expect(health.seams.allocator.open).toBe(1);
    // THE POINT OF THIS TEST IS UNCHANGED: the generous caps refused nothing.
    expect(health.seams.allocator.refusalsByCode).toEqual({});
  });

  it("THE BOUNDARY: a per-strategy cap at exactly the entry's cost permits it", async () => {
    const run = await driveRecordedRun({
      config: withCaps({ perStrategyCap: ENTRY_COST }),
    });
    const health = run.trader.loop.health();
    // `RISK-2`: was `1` — the take-profit is approved now too. The BOUNDARY this
    // test measures is the allocator's, and it is asserted below, unchanged.
    expect(health.risk.approvals).toBe(2);
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

  it("C1-RISK: a riskPolicy that still states a retired exposure cap is REFUSED at startup, naming allocatorCaps", () => {
    // The capital allocator is the only exposure-cap authority (the user's
    // ruling, 2026-10-08). `riskPolicy.limits` is strict, so an old document is
    // refused loudly rather than silently losing a cap.
    const config = {
      ...traderConfig(),
      riskPolicy: {
        ...(traderConfig()["riskPolicy"] as Record<string, unknown>),
        limits: { maxWorstCaseContractualLoss: "1000", globalExposureCap: "1000", perUnderlyingExposureCap: "20" },
      },
    };
    expect(() => assembleOrThrow({ config })).toThrow(/^TRADER_RISK_POLICY_REFUSED: /u);
    expect(() => assembleOrThrow({ config })).toThrow(/riskPolicy\.limits\.globalExposureCap is retired: .*allocatorCaps\.globalAccountCap/u);
    expect(() => assembleOrThrow({ config })).toThrow(/riskPolicy\.limits\.perUnderlyingExposureCap is retired: .*allocatorCaps\.perUnderlyingCap/u);
    expect(() => assembleOrThrow({ config })).toThrow(/Unrecognized keys: "globalExposureCap", "perUnderlyingExposureCap"/u);
  });

  it("C1-RISK: the account cap BELOW the entry refuses it at the risk gate as RISK_ALLOCATION_REFUSED, naming CAPITAL_GLOBAL_CAP_EXCEEDED", async () => {
    // Was a risk-side `globalExposureCap` of "1" refusing
    // `RISK_GLOBAL_EXPOSURE_EXCEEDED`. The same limit now lives in the
    // allocator: one cent under the entry's 17.5 binds it.
    const run = await driveRecordedRun({ config: withCaps({ globalAccountCap: "17.49" }) });
    const health = run.trader.loop.health();
    expect(health.risk.approvals).toBe(0);
    expect(health.execution.fillsObserved).toBe(0);
    expect(Object.keys(health.risk.refusalsByCode)).toEqual(["RISK_ALLOCATION_REFUSED"]);
    expect(Object.keys(health.seams.allocator.refusalsByCode)).toEqual(["CAPITAL_GLOBAL_CAP_EXCEEDED"]);

    // At the entry's cost exactly, it trades: the cap is compared.
    const atCost = await driveRecordedRun({ config: withCaps({ globalAccountCap: ENTRY_COST }) });
    expect(atCost.trader.loop.health().execution.fillsObserved).toBe(1);
    expect(Object.keys(atCost.trader.loop.health().seams.allocator.refusalsByCode)).not.toContain(
      "CAPITAL_GLOBAL_CAP_EXCEEDED",
    );
  });

  it("the POSITION a fill creates carries its EXACT cost basis into the next evaluation", async () => {
    const run = await driveRecordedRun();
    // 50 shares filled at 0.34 — `packages/simulation`'s own fill, folded FIFO.
    // A `"0"` here (the reviewed tip's value) would tell §9.7's exposure table
    // and §9.8's worst-case builder that the position had consumed nothing.
    expect(run.trader.loop.costBasisOf(INSTANCE_ID, MARKET_ID, "YES")).toBe("17");
  });
});

/**
 * §9.7's central rule on the POSITION half: "open orders AND POSITIONS both
 * consume limits" — measured on an account that already holds one.
 *
 * REVIEW ROUND 2, MEDIUM-1. The shipped code was verified correct and UNPINNED:
 * two mutations survived all 224 tests while changing what the process trades.
 *
 * | Mutation | What it deletes | Killed by |
 * | --- | --- | --- |
 * | A4 (`allocation.ts`) | the LIVE `exposureSnapshotCovering`, replaced by a covered EMPTY snapshot | (moot since C1-RISK: no snapshot reaches risk) |
 * | A7 (`allocation.ts`) | a position's `costBasis`, replaced by `"0"` | the ALLOCATOR probe below |
 *
 * The two markets share `underlyingKey: "BTC"`, and market 1's entry FILLS
 * before market 2 opens, so at market 2's evaluation the per-underlying scope
 * already carries a real position — `17` of cost basis, from 50 shares at
 * `0.34`. A cap of `"20"` therefore binds on the SECOND entry and only on the
 * second, on both sides of the seam:
 *
 * - the ALLOCATOR side (§9.7) counts positions through `#positionsFrom`, which
 *   is where A7 lives;
 * - the RISK side sees the allocator's refusal through §9.8 check 14
 *   (`RISK_ALLOCATION_REFUSED`). Until C1-RISK it also re-checked a copy of the
 *   cap at check 15 over the allocator's snapshot (mutation A4); the user's
 *   ruling of 2026-10-08 made the allocator the only exposure-cap authority.
 */
describe("§9.7 / §9.8 check 14 — a HELD POSITION consumes the caps", () => {
  it("the ALLOCATOR's per-underlying cap counts the position market 1 filled", async () => {
    const run = await driveTwoMarketRun(
      capsOn(twoMarketConfig("1000"), { perUnderlyingCap: "20" }),
    );
    const health = run.trader.loop.health();

    // Cash is not the binding constraint here: `"1000"` funds both entries, and
    // the unchanged two-owner run fills twice.
    expect(health.execution.fillsObserved).toBe(1);
    // `RISK-2`: was `1`. Market 1's entry filled and its take-profit is now
    // approved and submitted as well; market 2's entry is still the one the
    // UNDERLYING cap refuses, which is what this test measures.
    expect(health.execution.submissionsAccepted).toBe(2);
    expect(Object.keys(health.seams.allocator.refusalsByCode)).toContain(
      "CAPITAL_UNDERLYING_CAP_EXCEEDED",
    );
    // Not a collateral or an ownership refusal — the UNDERLYING cap, and the
    // only thing under it is the position market 1 now holds.
    expect(Object.keys(health.seams.allocator.refusalsByCode)).not.toContain(
      "CAPITAL_COLLATERAL_INSUFFICIENT",
    );
    expect(run.trader.loop.costBasisOf(INSTANCE_ID, MARKET_ID, "YES")).toBe("17");
    expect(run.trader.loop.costBasisOf(INSTANCE_ID_2, MARKET_ID_2, "YES")).toBe("0");
  });

  it("the same account with the cap ABOVE the sum trades both — the cap is compared", async () => {
    const run = await driveTwoMarketRun(
      capsOn(twoMarketConfig("1000"), { perUnderlyingCap: "40" }),
    );
    // `17` held + `17.5` committed = `34.5`, under `40`. The refusal above is a
    // comparison, not a constant.
    expect(run.trader.loop.health().execution.fillsObserved).toBe(2);
    expect(run.trader.loop.health().seams.allocator.refusalsByCode).toEqual({});
  });

  it("C1-RISK: the per-underlying cap's refusal reaches the risk gate as RISK_ALLOCATION_REFUSED, naming CAPITAL_UNDERLYING_CAP_EXCEEDED", async () => {
    // Was a risk-side `perUnderlyingExposureCap` of "20" refusing
    // `RISK_UNDERLYING_EXPOSURE_EXCEEDED` over the allocator's snapshot. The
    // same cap is the allocator's now, and check 14 binds its verdict.
    const run = await driveTwoMarketRun(
      capsOn(twoMarketConfig("1000"), { perUnderlyingCap: "20" }),
    );
    const health = run.trader.loop.health();

    expect(health.execution.fillsObserved).toBe(1);
    expect(Object.keys(health.risk.refusalsByCode)).toEqual(["RISK_ALLOCATION_REFUSED"]);
    expect(health.risk.refusalsByCode["RISK_ALLOCATION_REFUSED"]).toBe(1);
    expect(Object.keys(health.seams.allocator.refusalsByCode)).toEqual([
      "CAPITAL_UNDERLYING_CAP_EXCEEDED",
    ]);
  });
});

/**
 * §6 invariant 11 / ADR-011: ownership decides whether an intent may reach the
 * SHARED book at all.
 *
 * REVIEW ROUND 2, HIGH-1 — REPRODUCED at the r1 tip and inverted here. There,
 * `ownership: "SHADOW"` selected `packages/capital-allocator`'s shadow arm,
 * which skips the ADR-011 ownership gate, the live-micro fence and the
 * collateral/inventory checks and compares caps against that instance's own
 * shadow book — while the loop went on to plan `accountingMode: "LIVE"`, submit
 * to the one venue, debit the one cash balance and post to the one ledger.
 * Measured, with two markets on one account:
 *
 * ```text
 * globalAccountCap "20"   OWNER/OWNER  -> 1 fill  + CAPITAL_GLOBAL_CAP_EXCEEDED
 *                         OWNER/SHADOW -> 2 fills + no allocator refusal at all
 * startingCash    "18"    OWNER/OWNER  -> 1 fill  + CAPITAL_COLLATERAL_INSUFFICIENT
 *                         OWNER/SHADOW -> allocator approved BOTH
 * ```
 *
 * The second row of each pair is a live order on a market whose `ownerOf` is
 * `undefined`. The remedy is ADR-011 §5's own sentence — shadow instances
 * "evaluate, produce decisions, and write records; they do not consume venue
 * rate limits, **because they submit nothing**" — so the assertions below are in
 * two halves: the shadow instance still DECIDES, and nothing it decides reaches
 * the shared book.
 */
describe("ADR-011 — a SHADOW instance observes; it does not trade", () => {
  it("an account-wide cap binds the SAME way whether the peer is OWNER or SHADOW", async () => {
    const owned = await driveTwoMarketRun(
      capsOn(twoMarketConfig("1000"), { globalAccountCap: "20" }),
    );
    const ownedHealth = owned.trader.loop.health();
    expect(ownedHealth.execution.fillsObserved).toBe(1);
    expect(Object.keys(ownedHealth.seams.allocator.refusalsByCode)).toContain(
      "CAPITAL_GLOBAL_CAP_EXCEEDED",
    );

    const shadowed = await driveTwoMarketRun(
      capsOn(twoMarketConfig("1000", { secondOwnership: "SHADOW" }), {
        globalAccountCap: "20",
      }),
    );
    const health = shadowed.trader.loop.health();

    // THE REGRESSION. At the r1 tip `fillsObserved` was 2: the cap bound for an
    // owner and evaporated for a shadow, on the same account, in the same
    // process. ONE FILL is still the property under test, and it still holds.
    expect(health.execution.fillsObserved).toBe(1);
    // `RISK-2`: these two were `1`. The owner's take-profit is now approved and
    // submitted alongside its entry; nothing here belongs to the SHADOW, which
    // is what the three assertions below establish.
    expect(health.execution.submissionsAccepted).toBe(2);
    expect(health.execution.plansBuilt).toBe(2);
    // The shadow instance's market is unowned and untouched: no trace carries
    // its run, and it holds nothing.
    expect(shadowed.trader.registry.ownerOf(MARKET_ID_2)).toBeUndefined();
    expect(shadowed.trader.loop.traces().some((trace) => trace.runId === RUN_ID_2)).toBe(false);
    expect(shadowed.trader.loop.costBasisOf(INSTANCE_ID_2, MARKET_ID_2, "YES")).toBe("0");
  });

  it("the shadow instance still EVALUATES and its decision is still persisted", async () => {
    const run = await driveTwoMarketRun(twoMarketConfig("1000", { secondOwnership: "SHADOW" }));
    const health = run.trader.loop.health();

    // ADR-011 §5's first half: it evaluates, decides and writes records.
    const shadowDecisions = run.trader.loop
      .decisions()
      .filter((decision) => decision.instanceId === INSTANCE_ID_2);
    expect(shadowDecisions.length).toBeGreaterThan(0);
    const entered = shadowDecisions.find((decision) => decision.decisionType === "enter");
    expect(entered).toBeDefined();
    expect(entered?.intentIds.length).toBeGreaterThan(0);
    expect(run.parts.store.decisions.length).toBeGreaterThan(0);

    // ADR-011 §5's second half: it submits nothing. The intents it emitted are
    // COUNTED as unrouted rather than dropped silently.
    expect(health.execution.observeOnlyIntents).toBe(entered?.intentIds.length);
    expect(health.execution.fillsObserved).toBe(1);
    // `RISK-2`: was `1`. Both applications belong to the OWNER — its entry and
    // its now-approved take-profit. The assertion that matters is the next one:
    // nothing the SHADOW emitted reached a trace.
    expect(health.seams.allocator.applied).toBe(2);
    expect(run.trader.loop.traces().some((trace) => trace.runId === RUN_ID_2)).toBe(false);
  });

  it("the shadow instance cannot spend the collateral the owner needs", async () => {
    // `"18"` funds exactly ONE 50-share entry at `0.35`. With two OWNERS the
    // allocator refuses the second by name; with a SHADOW peer the second is
    // never proposed — and in NEITHER case is the account overspent.
    const owned = await driveTwoMarketRun(twoMarketConfig("18"));
    expect(Object.keys(owned.trader.loop.health().seams.allocator.refusalsByCode)).toContain(
      "CAPITAL_COLLATERAL_INSUFFICIENT",
    );
    expect(owned.trader.loop.health().execution.fillsObserved).toBe(1);

    const shadowed = await driveTwoMarketRun(twoMarketConfig("18", { secondOwnership: "SHADOW" }));
    const health = shadowed.trader.loop.health();
    expect(health.execution.fillsObserved).toBe(1);
    // `RISK-2`: these three were `1`. The OWNER's take-profit is now approved
    // and placed alongside its entry, so each counts two — both the owner's.
    // "Nothing was reserved for the SHADOW" is the claim, and it is asserted
    // directly below rather than inferred from a count of one.
    expect(health.execution.submissionsAccepted).toBe(2);
    expect(health.execution.observeOnlyIntents).toBeGreaterThan(0);
    expect(health.seams.allocator.applied).toBe(2);
    expect(health.seams.reservations.taken).toBe(2);
    // Nothing was reserved for the shadow instance in EITHER book: it owns no
    // market, no trace carries its run, and it holds nothing.
    expect(shadowed.trader.registry.ownerOf(MARKET_ID_2)).toBeUndefined();
    expect(shadowed.trader.loop.traces().some((trace) => trace.runId === RUN_ID_2)).toBe(
      false,
    );
    expect(shadowed.trader.loop.costBasisOf(INSTANCE_ID_2, MARKET_ID_2, "YES")).toBe("0");
  });
});
