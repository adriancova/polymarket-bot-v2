/**
 * WP-290's obligation on WP-330: `reconcile` uses `ReconciliationCoordinator`
 * and its read ports, and is READ-ONLY: it never resumes a trader, never
 * releases a quarantine. The coordinator here is the REAL one (handoff §18.3:
 * "Do not mock away the central behavior being tested"), over the fake venue's
 * reads, each granted by WP-310's budget.
 */

import { ReconciliationCoordinator } from "@polymarket-bot/oms";
import { RateLimitBudget } from "@polymarket-bot/polymarket-secure";
import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readOnlyHoldings, ReadOnlyOmsView } from "./commands/reconcile.js";
import { EXIT_CODES } from "./exit-codes.js";
import { args, harness, order, PUSD, TOKEN_YES, testConfiguration } from "./harness.test-support.js";
import type { ProjectionSource } from "./ports.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  vi.restoreAllMocks();
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

/** A durable projection that matches the fake venue: 100 pUSD, no position. */
function matchingProjection(collateral = "100"): ProjectionSource {
  return {
    projected: () => Promise.resolve({ lines: [{ assetId: PUSD, assetKind: "COLLATERAL", balance: collateral }], unattributedArrivals: [] }),
    remainingBookings: (fills) => Promise.resolve({ bookings: fills.map((fill) => ({ ...fill, entries: [] })) }),
  };
}

describe("WP-290: reconcile runs the real coordinator, read-only", () => {
  it("a clean account against a matching projection: the run PASSES in the journal, and NOTHING is resumed (the read-only view refuses)", async () => {
    const resume = vi.spyOn(ReadOnlyOmsView.prototype, "resume");
    const release = vi.spyOn(ReconciliationCoordinator.prototype, "releaseQuarantine");
    const h = harness({ projection: matchingProjection() });
    const outcome = await runOpsCli(h.deps(args("reconcile")));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(resume).toHaveBeenCalled();
    expect(resume.mock.results.every((result) => result.type === "return" && (result.value as { ok: boolean }).ok === false)).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(h.text()).toMatch(/run [0-9a-f-]+: PASSED/u);
    expect(h.text()).toContain("resumed: no (the coordinator asked 1 time(s); the read-only view refused)");
    expect(h.audit.records.at(-1)?.detail["resumed"]).toBe(false);
  });

  it("an open order the trader's memory would own is UNATTRIBUTED here: a quarantine is REPORTED, none released", async () => {
    const release = vi.spyOn(ReconciliationCoordinator.prototype, "releaseQuarantine");
    const h = harness({ projection: matchingProjection() });
    h.venue.add(order("o-1", { tokenId: TOKEN_YES }));
    const outcome = await runOpsCli(h.deps(args("reconcile")));
    expect(outcome.exitName).toBe("RECONCILE_BREAKS");
    expect(outcome.exitCode).toBe(EXIT_CODES.RECONCILE_BREAKS);
    expect(h.text()).toContain("break ORDER_UNATTRIBUTED");
    expect(h.text()).toContain("quarantines released: none (never called)");
    expect(release).not.toHaveBeenCalled();
    // Nothing was cancelled or written at the venue: reads only.
    for (const method of ["cancelOrder", "cancelOrders", "cancelMarketOrders", "cancelAll"]) expect(h.venue.callsOf(method)).toEqual([]);
  });

  it("an unexplained holding delta is reported and held, never booked: one run sees it once (HOLDING_DELTA_UNCONFIRMED)", async () => {
    const h = harness({ projection: matchingProjection("90") });
    const outcome = await runOpsCli(h.deps(args("reconcile")));
    expect(outcome.exitName).toBe("RECONCILE_BREAKS");
    expect(h.text()).toContain("break HOLDING_DELTA_UNCONFIRMED");
    expect(h.text()).not.toContain("UNATTRIBUTED booking refused");
  });

  it("the holdings port refuses every booking (read-only) and records it; it reads the projection only when one is configured", async () => {
    const refused: string[] = [];
    const holdings = readOnlyHoldings(null, refused);
    const answer = await holdings.bookUnattributed({
      ledgerTransactionId: "01a10bef-6200-7000-8000-0000000000aa",
      reconciliationRunId: "01a10bef-6200-7000-8000-0000000000bb",
      assetId: PUSD,
      assetKind: "COLLATERAL",
      marketId: null,
      delta: "-10",
      occurredAtMs: 1,
    });
    expect(answer).toEqual({ ok: false, reason: "OPS_CLI_READ_ONLY" });
    expect(refused).toEqual([`COLLATERAL ${PUSD}: -10`]);
    await expect(holdings.projected()).rejects.toThrow("no ledger projection is configured");
    await expect(readOnlyHoldings(matchingProjection(), refused).projected()).resolves.toMatchObject({ lines: [{ assetId: PUSD }] });
  });

  it("without a ledger projection, the holdings comparison holds as unread (fail-closed): RECONCILE_BREAKS, never a pass", async () => {
    const h = harness();
    const outcome = await runOpsCli(h.deps(args("reconcile")));
    expect(outcome.exitName).toBe("RECONCILE_BREAKS");
    expect(h.text()).toContain("NO ledger projection");
    expect(h.text()).toContain("the ledger projection: none is configured, so holdings were not compared");
  });

  it("every venue read goes through the budget at RECONCILIATION_READ; positions only through /v2 (data.v2.positions)", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const h = harness({ projection: matchingProjection() });
    await runOpsCli(h.deps(args("reconcile")));
    const reads = requests.mock.calls.map(([request]) => request);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((request) => request.priority === "RECONCILIATION_READ")).toBe(true);
    expect(reads.map((request) => request.operationId)).toEqual(expect.arrayContaining(["clob.data_orders", "clob.get_trades", "data.v2.positions", "data.v2.approvals"]));
  });

  it("a positions answer from a v1 route is refused by the coordinator's door (E-15): never read as empty", async () => {
    const h = harness({ projection: matchingProjection() });
    h.venue.scripted.set("readPositions", () => ({ route: "/positions", complete: true, positions: [] }));
    const outcome = await runOpsCli(h.deps(args("reconcile")));
    expect(outcome.exitName).toBe("RECONCILE_BREAKS");
    expect(h.text()).toContain("READ_WRONG_ROUTE");
  });

  it("no reconciliation policy in the configuration: CONFIGURATION_REFUSED, nothing is run", async () => {
    const h = harness({ configuration: testConfiguration({ reconciliation: null }) });
    const outcome = await runOpsCli(h.deps(args("reconcile")));
    expect(outcome.exitName).toBe("CONFIGURATION_REFUSED");
    expect(h.venue.calls).toEqual([]);
  });

  it("the read-only view: no order, no attempt, no alert; resume and every write refused", async () => {
    const view = new ReadOnlyOmsView();
    expect(view.orders()).toEqual([]);
    expect(view.attempts()).toEqual([]);
    expect(view.alerts()).toEqual([]);
    expect(view.retainedEvidence()).toEqual([]);
    expect(view.resume()).toMatchObject({ ok: false, refusal: { code: "OMS_RESUME_BLOCKED" } });
    expect(await view.applyOrderObservation()).toMatchObject({ ok: false });
    expect(await view.recordFill()).toMatchObject({ ok: false });
    expect(await view.applySettlement()).toMatchObject({ ok: false });
    expect(await view.applyReconciliation()).toMatchObject({ ok: false });
    expect(await view.requestOrderReconciliation()).toMatchObject({ ok: false });
    expect(view.refusedWrites).toEqual(["applyOrderObservation", "recordFill", "applySettlement", "applyReconciliation", "requestOrderReconciliation"]);
  });
});
