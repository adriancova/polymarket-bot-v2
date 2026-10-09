/**
 * C1-OMS06 (COMPLEXITY-1, audit OMS-06): the live gate's reconciliation halts
 * have ONE source, the REAL `ReconciliationCoordinator`'s journal, read at
 * every ask through `quarantinedBreaks()`. At `2c2cf33` they were latched
 * twice: every run pushed each QUARANTINED break into a halt port, and
 * live-safety kept its own add-only latch, cleared only all at once by a
 * `releaseReconciliationHalts()` nothing called. So after an operator released
 * one market's quarantine, that market's entries stayed blocked, and the one
 * act that unblocked it lifted every other market's halt too.
 *
 * Against the REAL coordinator, OMS and LiveSafety (§18.3):
 * - (5a) the journal unreadable: every entry is refused (`HALTS_UNREADABLE`);
 * - (5b) a QUARANTINED MARKET break blocks that market's entries only; an
 *   ACCOUNT-scope one blocks every entry;
 * - (5c) `releaseQuarantine` of one market's break lets that market's entries
 *   through at the next ask, while another market's quarantine still blocks;
 * - (5d) a break unresolved but not QUARANTINED (a hold) blocks nothing here
 *   (the OMS stays paused while any break is unresolved);
 * - (5e) reductions are never blocked by this input.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";
import { ACCOUNT, MARKET, MARKET_NO, NO, PUSD, YES } from "../reconciliation/support/harness.js";

import { liveProcess, SUITE_INSTANCE, type LiveProcess } from "./support/live-process.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

/** The gate's reconciliation reasons for one request (the other inputs are the suite's healthy defaults). */
function halts(live: LiveProcess, kind: "NEW_ENTRY" | "REDUCTION", marketId: string): readonly string[] {
  return live.safety.gate({ kind, marketId, instanceId: SUITE_INSTANCE }).reasons.filter((reason) => reason.startsWith("RECONCILIATION_") || reason === "HALTS_UNREADABLE");
}

/** Book an UNATTRIBUTED arrival per entry (one ledger transaction) that the venue's holdings agree with. */
function unattributedArrivals(live: LiveProcess, arrivals: readonly { readonly assetId: string; readonly marketId: string | null }[]): void {
  const { u } = live;
  const entries = arrivals.flatMap(({ assetId, marketId }) => {
    const assetKind = assetId === PUSD ? "COLLATERAL" : "OUTCOME_TOKEN";
    const market = marketId === null ? {} : { marketId };
    return [
      { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId, assetKind, ...market, amount: "2" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-venue", assetId, assetKind, ...market, amount: "-2" },
      { scope: "UNATTRIBUTED", accountRef: ACCOUNT, assetId, assetKind, ...market, amount: "2" },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-attribution", assetId, assetKind, ...market, amount: "-2" },
    ];
  });
  const appended = u.ledger.append({
    ledgerTransactionId: u.ledgerIds(),
    eventType: "RECONCILIATION_CORRECTION",
    environment: "PAPER",
    accountRef: ACCOUNT,
    source: "internal",
    occurredAt: "2026-10-03T00:00:00Z",
    entries,
  } as Parameters<typeof u.ledger.append>[0]);
  expect(appended.ok, JSON.stringify(appended)).toBe(true);
  if (appended.ok) u.ledger = appended.value.ledger;
  for (const { assetId } of arrivals) {
    if (assetId === PUSD) u.world.adjustCollateral("2");
    else u.world.adjustPosition(assetId, "2");
  }
}

async function run(live: LiveProcess): Promise<void> {
  live.p.coordinator.trigger("PERIODIC_TIMER");
  await live.p.coordinator.reconcile();
}

function quarantined(live: LiveProcess): readonly { readonly breakId: string; readonly scope: string; readonly marketId: string | null }[] {
  return live.p.journal.unresolvedBreaks().filter((view) => view.status === "QUARANTINED");
}

describe("C1-OMS06: the live gate reads WP-290's quarantines from the journal, one source, no latch (real coordinator)", () => {
  it("(5b, 5c) two markets quarantined: each blocks only its own entries; releasing one lets that market through at once, the other still blocks", async () => {
    const live = await liveProcess();
    expect(halts(live, "NEW_ENTRY", MARKET)).toEqual([]);
    unattributedArrivals(live, [
      { assetId: YES, marketId: MARKET },
      { assetId: NO, marketId: MARKET_NO },
    ]);
    await run(live);
    const [first, second] = quarantined(live);
    expect([first?.scope, first?.marketId, second?.scope, second?.marketId]).toEqual(["MARKET", MARKET, "MARKET", MARKET_NO]);
    expect(halts(live, "NEW_ENTRY", MARKET)).toEqual(["RECONCILIATION_MARKET_HALT"]);
    expect(halts(live, "NEW_ENTRY", MARKET_NO)).toEqual(["RECONCILIATION_MARKET_HALT"]);
    // A third market is not halted by either.
    expect(halts(live, "NEW_ENTRY", "0190a3e0-0000-7000-8000-0000000000ee")).toEqual([]);
    // One operator act, and only that break's halt is lifted: no run, no second release.
    expect((await live.p.coordinator.releaseQuarantine({ breakId: first?.breakId ?? "", operatorRef: "operator-1", reason: "market A's arrival reviewed" })).ok).toBe(true);
    expect(halts(live, "NEW_ENTRY", MARKET)).toEqual([]);
    expect(halts(live, "NEW_ENTRY", MARKET_NO)).toEqual(["RECONCILIATION_MARKET_HALT"]);
    // A later run does not bring it back, and the other stays.
    await run(live);
    expect(halts(live, "NEW_ENTRY", MARKET)).toEqual([]);
    expect(halts(live, "NEW_ENTRY", MARKET_NO)).toEqual(["RECONCILIATION_MARKET_HALT"]);
    expect(live.safety.status().reconciliationHalts).toEqual({ account: false, markets: [MARKET_NO] });
    expect((await live.p.coordinator.releaseQuarantine({ breakId: second?.breakId ?? "", operatorRef: "operator-1", reason: "market B's arrival reviewed" })).ok).toBe(true);
    expect(halts(live, "NEW_ENTRY", MARKET_NO)).toEqual([]);
  });

  it("(5b) an ACCOUNT-scope quarantine (collateral, no market) blocks every entry, in every market", async () => {
    const live = await liveProcess();
    unattributedArrivals(live, [{ assetId: PUSD, marketId: null }]);
    await run(live);
    expect(quarantined(live).map((view) => [view.scope, view.marketId])).toEqual([["ACCOUNT", null]]);
    expect(halts(live, "NEW_ENTRY", MARKET)).toEqual(["RECONCILIATION_ACCOUNT_HALT"]);
    expect(halts(live, "NEW_ENTRY", MARKET_NO)).toEqual(["RECONCILIATION_ACCOUNT_HALT"]);
    expect(live.safety.status().reconciliationHalts).toEqual({ account: true, markets: [] });
  });

  it("(5e) exits are never blocked by a quarantine: a REDUCTION in a quarantined market, under an account quarantine too, passes the gate", async () => {
    const live = await liveProcess();
    unattributedArrivals(live, [
      { assetId: YES, marketId: MARKET },
      { assetId: PUSD, marketId: null },
    ]);
    await run(live);
    expect(halts(live, "NEW_ENTRY", MARKET)).toEqual(["RECONCILIATION_ACCOUNT_HALT", "RECONCILIATION_MARKET_HALT"]);
    expect(halts(live, "REDUCTION", MARKET)).toEqual([]);
    expect(live.safety.gate({ kind: "REDUCTION", marketId: MARKET, instanceId: SUITE_INSTANCE })).toEqual({ permitted: true, reasons: [] });
  });

  it("(5d) a break unresolved but not QUARANTINED (a read hold) blocks no entry through this input; the OMS pause covers it", async () => {
    const live = await liveProcess();
    live.u.world.faults.listTrades = () => {
      throw new Error("timeout (synthetic)");
    };
    await run(live);
    const unresolved = live.p.journal.unresolvedBreaks();
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((view) => view.status === "OPEN")).toBe(true);
    expect(live.oms.paused).toBe(true);
    expect(halts(live, "NEW_ENTRY", MARKET)).toEqual([]);
    expect(live.safety.status().reconciliationHalts).toEqual({ account: false, markets: [] });
  });

  it("(5a) the journal unreadable (a throw, or not a list): every new entry is refused (HALTS_UNREADABLE), reductions are not; `status().unresolvedBreaks` would have read it as none", async () => {
    const live = await liveProcess();
    unattributedArrivals(live, [{ assetId: YES, marketId: MARKET }]);
    await run(live);
    expect(halts(live, "NEW_ENTRY", MARKET_NO)).toEqual([]);
    const journal = live.p.journal as unknown as { unresolvedBreaks: () => unknown };
    const real = journal.unresolvedBreaks.bind(journal);
    for (const unreadable of [
      () => {
        throw new Error("the journal's store is unreachable (synthetic)");
      },
      () => "not a list",
    ]) {
      journal.unresolvedBreaks = unreadable;
      expect(() => live.p.coordinator.quarantinedBreaks()).toThrow();
      // The fail-open read the gate must never use: an unreadable journal reads as no breaks at all.
      expect(live.p.coordinator.status().unresolvedBreaks).toEqual([]);
      expect(halts(live, "NEW_ENTRY", MARKET)).toEqual(["HALTS_UNREADABLE"]);
      expect(halts(live, "NEW_ENTRY", MARKET_NO)).toEqual(["HALTS_UNREADABLE"]);
      expect(halts(live, "REDUCTION", MARKET)).toEqual([]);
      expect(live.safety.status().reconciliationHalts).toEqual({ account: true, markets: [] });
    }
    journal.unresolvedBreaks = real;
    expect(halts(live, "NEW_ENTRY", MARKET)).toEqual(["RECONCILIATION_MARKET_HALT"]);
    expect(halts(live, "NEW_ENTRY", MARKET_NO)).toEqual([]);
  });
});
