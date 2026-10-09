/**
 * The DRIFT PIN between `apps/trader`'s health surface and this API's door.
 *
 * ## Why this test exists and why it can only live here
 *
 * `packages/observability`'s `TraderHealthReportInput` and this API's health
 * door both describe `apps/trader`'s `HealthSnapshot` — the five seam sections,
 * `observeOnlyIntents`, `halts`, the risk refusal counts, `riskSeamCaveat`
 * (`docs/handoffs/WP-230.md` follow-up 4). Neither can IMPORT it:
 * `docs/contracts/dependency-direction.md` F10 forbids any package depending on
 * an app, and `apps/control-api` is itself an app, so it cannot depend on
 * `apps/trader` either.
 *
 * This tree sits outside every workspace package and creates no manifest edge,
 * so it is the one place that may alias both — and it does the only thing that
 * makes the claim real: it builds a snapshot with the **REAL `HealthState`
 * class**, serializes it the way a wire would, and drives it through the
 * control API's door. A rename in `apps/trader/src/health.ts` fails HERE,
 * loudly, instead of quietly emptying a dashboard.
 *
 * ## What it does NOT claim
 *
 * It does not claim anything about a wire: what this pins is the SHAPE, the
 * half `WP-240` could own. (This paragraph used to say "`apps/trader` does not
 * serve this document over HTTP … a documented composition obligation on a
 * future `apps/trader` grant"; `TRDR-3` discharged that — the served bytes are
 * pinned in `trader-health-http-source.test.ts` beside this file, through the
 * REAL `HttpTraderHealthSource` against the REAL `startTraderHealthServer`.)
 */

import { describe, expect, it } from "vitest";

import {
  HealthState,
  OrderTombstones,
  RISK_SEAM_CAVEAT,
  RealizedPnlBook,
  RetentionLog,
  TRANSPORT_SAMPLE_INTERVAL_MS,
  transportHealthOf,
  type FoldHealth,
  type HealthSnapshot,
  type OrderLifecycleMetrics,
  type RetentionHealth,
} from "@polymarket-bot/trader";
import { readTraderHealthReport } from "@polymarket-bot/control-api";
import {
  PLATFORM_METRIC_FAMILIES,
  renderExpositionFor,
  traderHealthSamples,
} from "@polymarket-bot/observability";

/**
 * `TRDR-4`: the two seams `CoreLoop.health()` always publishes, built from the
 * REAL producers — `OrderTombstones.metrics()` and `RetentionLog.metrics()` —
 * so a rename in `apps/trader/src/order-lifecycle.ts` fails here too. One log
 * is driven past its bound so `evicted` is a measured non-zero.
 */
function loopSeams(): {
  readonly orders: OrderLifecycleMetrics;
  readonly retention: RetentionHealth;
  readonly folds: FoldHealth;
} {
  const tombstones = new OrderTombstones({ maximumRemembered: 2 });
  tombstones.remember("order-1", "sb-1");
  tombstones.remember("order-2", "sb-1");
  tombstones.remember("order-3", "sb-1");
  const decisions = new RetentionLog<number>({ name: "decision", maximumRetained: 2 });
  for (const value of [1, 2, 3]) decisions.append(value);
  const traces = new RetentionLog<number>({ name: "trace", maximumRetained: 50_000 });
  traces.append(1);
  const provenance = new RetentionLog<number>({ name: "order provenance", maximumRetained: 50_000 });
  provenance.append(1);
  return {
    orders: {
      tracked: 1,
      settled: 3,
      ...tombstones.metrics(),
      unownedFills: 1,
      lateFillsAfterSettlement: 1,
      settleMismatches: 0,
    },
    retention: {
      decisions: decisions.metrics(),
      traces: traces.metrics(),
      provenance: provenance.metrics(),
    },
    // `FOLD-1`: the loop's held accounting state, typed as the trader's own
    // `FoldHealth` so a rename in `apps/trader/src/folds.ts` fails this
    // suite's typecheck. A test cadence with one refused PnL record (F3).
    folds: {
      checkEveryFills: 1,
      pnlCheck: true,
      fillsPosted: 4,
      ledgerChecks: 4,
      pnlChecks: 3,
      fillsAtLastCheck: 4,
      ledgerMismatches: 0,
      pnlMismatches: 0,
      pnlRefusals: { "sb-1": { PNL_OVERSELL: 1 } },
    },
  };
}

/**
 * Builds a snapshot from the REAL `HealthState`, exercising every counter it
 * has a mutator for — and, since `TRDR-3`, the attached `RealizedPnlBook`
 * (`accounting.realizedPnl`, exact decimal strings) — so the pin covers the
 * whole surface rather than a corner.
 */
function realSnapshot(): HealthSnapshot {
  const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
  const realizedPnl = new RealizedPnlBook();
  realizedPnl.record({ instanceId: "sb-1", realizedPnl: "-1.2" });
  realizedPnl.record({ instanceId: "sb-2", realizedPnl: "0.3" });
  state.attachRealizedPnl(realizedPnl);
  // `THROUGHPUT-1a`: the process attaches its transport-lag sampler at
  // startup; the section is built by the REAL producer (`transportHealthOf`)
  // from one sample: 250 entries behind a head of 1,250, read at 00:00:09.500,
  // seen at 00:00:12.000 — 2.5 s old, 2 s past the last event (the snapshot's
  // `asOf`, 00:00:10.000).
  state.attachTransport({
    transportHealth: (lastEventAt) =>
      transportHealthOf({
        intervalMs: TRANSPORT_SAMPLE_INTERVAL_MS,
        samples: 3,
        sampleFailures: 0,
        latest: {
          atMs: Date.parse("2026-09-05T00:00:09.500Z"),
          headPosition: 1_250,
          consumerPosition: 1_000,
          committedPosition: 990,
          entriesBehindHead: 250,
        },
        lastEventAt,
        nowMs: Date.parse("2026-09-05T00:00:12.000Z"),
      }),
  });

  state.countLoop("eventsAccepted", 40);
  state.countLoop("eventsProcessed", 39);
  state.countLoop("eventsRefused");
  state.countLoop("featureSnapshots", 12);
  state.countLoop("snapshotsUnavailable", 3);
  state.countLoop("featureProjectionRefusals");
  state.countLoop("evaluations", 12);
  state.countLoop("decisionsPersisted", 12);
  state.countLoop("containedEvaluations");
  state.countLoop("refusedEvaluations");
  state.countLoop("deliveriesSuppressedByHalt", 2);
  // `CADENCE-1` (ADR-026 D5.6, D2.10).
  state.countLoop("evaluationsCoalesced", 27);
  state.countLoop("cadenceForwardJumpAlarms", 4);

  state.countRiskApproval();
  state.countRiskApproval();
  state.countRiskRefusal(["RISK_NO_NET_EDGE"], true);
  state.countRiskRefusal(["RISK_ENTRY_CUTOFF"], false);
  state.countRecommendations(["RECONCILE_ACCOUNT", "CANCEL_RESTING_ORDERS"]);

  state.countExecution("plansBuilt", 4);
  state.countExecution("plansRefused");
  state.countExecution("submissionsAccepted", 4);
  state.countExecution("submissionsRefused");
  state.countExecution("fillsObserved", 3);
  state.countExecution("duplicateFillsRefused");
  state.countExecution("cancelsRequested");
  state.countExecution("cancelsConfirmed");
  state.countExecution("cancelsRejected");
  state.countExecution("cancelsSilenceExceeded");
  state.countExecution("allocationsRefused");
  state.countExecution("reservationsReleasedOnRefusal");
  state.countExecution("observeOnlyIntents", 2);

  state.countAccounting("ledgerTransactions", 7);
  state.countAccounting("ledgerRefusals");
  state.countAccounting("unattributedActivity");
  state.countAccounting("unexplainedMovements");
  state.countAccounting("pnlRecords", 3);

  return state.snapshot({
    asOf: "2026-09-05T00:00:10.000Z",
    halts: [
      {
        scope: { kind: "MARKET", marketId: "market-1" },
        code: "BOOK_DESYNCHRONIZED",
        detail: "a book refused an update",
        at: "2026-09-05T00:00:09.000Z",
      },
    ],
    bookRefusals: { "market-1": { benign: 3, divergence: 1 } },
    queues: [
      {
        name: "market-events",
        currentDepth: 2,
        maximumDepth: 1024,
        oldestMessageAgeMs: 17,
        messagesDropped: 0,
        producerBlockedMs: 0,
        consumerLag: 1,
        accepted: 40,
        consumed: 39,
      },
      {
        name: "fills",
        currentDepth: 0,
        maximumDepth: 256,
        oldestMessageAgeMs: null,
        messagesDropped: 0,
        producerBlockedMs: 0,
        consumerLag: 0,
        accepted: 3,
        consumed: 3,
      },
    ],
    seams: {
      fills: { remembered: 3, maximumRemembered: 4096, admitted: 3, refused: 1, evictions: 0 },
      reservations: { open: 1, taken: 4, released: 3, reservedCollateral: "12.50" },
      cancels: { pending: 0, requested: 1, confirmed: 1, rejected: 0, silenceExceeded: 0 },
      orderViews: { emitted: 9, repeats: 2, tracked: 4 },
      allocator: {
        open: 1,
        applied: 4,
        released: 3,
        reservedCollateral: "12.50",
        refusalsByCode: { CAPITAL_CAP_EXCEEDED: 1 },
      },
      ...loopSeams(),
    },
  });
}

/** What a wire would carry: JSON in, JSON out. */
function overTheWire(snapshot: HealthSnapshot): unknown {
  return JSON.parse(JSON.stringify(snapshot));
}

describe("the REAL trader health snapshot passes the control API's door", () => {
  it("is accepted, unmodified, with every section present", () => {
    const result = readTraderHealthReport(overTheWire(realSnapshot()));
    expect(
      result.ok
        ? "accepted"
        : `REFUSED: ${result.refusal.detail} — ${result.refusal.issues.join("; ")}`,
    ).toBe("accepted");
    if (!result.ok) return;

    const report = result.value;
    expect(report.runMode).toBe("PAPER");
    expect(report.maximumRunMode).toBe("PAPER");
    expect(report.healthy).toBe(false);
    expect(report.halts).toHaveLength(1);
    // C1-TIDY: a halt carries no action (every halt ends the run), and the
    // snapshot carries the book-refusal counts.
    expect(Object.keys(report.halts[0] ?? {}).sort()).toEqual(["at", "code", "detail", "scope"]);
    expect((report as unknown as { bookRefusals: unknown }).bookRefusals).toEqual({
      "market-1": { benign: 3, divergence: 1 },
    });
    expect(report.queues).toHaveLength(2);
    expect(report.execution.observeOnlyIntents).toBe(2);
    expect(report.loop.deliveriesSuppressedByHalt).toBe(2);
    // `CADENCE-1`: the health door admits a trader health report carrying the
    // evaluation cadence's two counters, exactly (work-plan acceptance 10).
    expect(report.loop.evaluationsCoalesced).toBe(27);
    expect(report.loop.cadenceForwardJumpAlarms).toBe(4);
    expect(report.risk.refusedExits).toBe(1);
    expect(report.risk.refusedExitsByCode).toEqual({ RISK_NO_NET_EDGE: 1 });
    expect(report.seams.allocator.refusalsByCode).toEqual({ CAPITAL_CAP_EXCEEDED: 1 });
    // `TRDR-3`: the exact decimals and the trader's exact sum, through the door.
    expect(report.accounting.realizedPnl).toEqual({
      byInstance: { "sb-1": "-1.2", "sb-2": "0.3" },
      account: "-0.9",
    });
    // `TRDR-4`: the loop's per-order state and audit-log retention, through the
    // door, as the real producers measured them.
    const seams = report.seams as unknown as Record<string, unknown>;
    expect(seams["orders"]).toEqual({
      tracked: 1,
      settled: 3,
      tombstones: 2,
      maximumTombstones: 2,
      tombstoneEvictions: 1,
      unownedFills: 1,
      lateFillsAfterSettlement: 1,
      settleMismatches: 0,
    });
    expect(seams["retention"]).toEqual({
      decisions: { retained: 2, maximumRetained: 2, evicted: 1 },
      traces: { retained: 1, maximumRetained: 50_000, evicted: 0 },
      provenance: { retained: 1, maximumRetained: 50_000, evicted: 0 },
    });
    // `FOLD-1`: the held accounting state, through the door, as published.
    expect(seams["folds"]).toEqual({
      checkEveryFills: 1,
      pnlCheck: true,
      fillsPosted: 4,
      ledgerChecks: 4,
      pnlChecks: 3,
      fillsAtLastCheck: 4,
      ledgerMismatches: 0,
      pnlMismatches: 0,
      pnlRefusals: { "sb-1": { PNL_OVERSELL: 1 } },
    });
  });

  it("the door REFUSES a snapshot whose producer supplied no TRDR-4 seams — absent is never read as zero", () => {
    // `HealthState.snapshot` carries `orders` / `retention` (and, since
    // `FOLD-1`, `folds`) only when its caller measured them
    // (`CoreLoop.health()` always does). A holder of no loop that omits them
    // produces a document the door must refuse, not default.
    const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
    const { orders: _orders, retention: _retention, folds: _folds, ...fiveSeams } = realSnapshot().seams;
    void _orders;
    void _retention;
    void _folds;
    const without = state.snapshot({ asOf: "2026-09-26T00:00:00Z", halts: [], queues: [], seams: fiveSeams });
    expect(Object.keys(without.seams)).toEqual(["fills", "reservations", "cancels", "orderViews", "allocator"]);
    const result = readTraderHealthReport(overTheWire(without));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issues = result.refusal.issues.join(" ");
    expect(issues).toContain("orders");
    expect(issues).toContain("retention");
    expect(issues).toContain("folds");
  });

  it("the door REFUSES a snapshot whose producer supplied the TRDR-4 seams but not the FOLD-1 seam", () => {
    const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
    const { folds: _folds, ...sevenSeams } = realSnapshot().seams;
    void _folds;
    const without = state.snapshot({ asOf: "2026-09-27T00:00:00Z", halts: [], queues: [], seams: sevenSeams });
    expect(Object.keys(without.seams)).not.toContain("folds");
    const result = readTraderHealthReport(overTheWire(without));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.issues.join(" ")).toContain("folds");
  });

  it("accepts the 'no snapshot observed' form — account null, no instances — that a fresh trader serves", () => {
    const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
    const fresh = state.snapshot({
      asOf: "2026-09-16T00:00:00Z",
      halts: [],
      queues: [],
      seams: realSnapshot().seams,
    });
    expect(fresh.accounting.realizedPnl).toEqual({ byInstance: {}, account: null });
    const result = readTraderHealthReport(overTheWire(fresh));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accounting.realizedPnl.account).toBeNull();
    // …and the samples then OMIT both PnL families rather than rendering a 0.
    const exposition = renderExpositionFor(PLATFORM_METRIC_FAMILIES, traderHealthSamples(result.value));
    expect(exposition).not.toContain("trader_realized_pnl_info{");
    expect(exposition).not.toContain("trader_account_realized_pnl_info{");
    expect(exposition).toContain("trader_pnl_records_total 0");
  });

  it("carries WP-230's riskSeamCaveat through verbatim", () => {
    const result = readTraderHealthReport(overTheWire(realSnapshot()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The real constant, from the real trader — not a paraphrase.
    expect(result.value.riskSeamCaveat).toBe(RISK_SEAM_CAVEAT);
    // C1-HALTS (TRADE-09): one present-tense sentence, no superseded history.
    expect(result.value.riskSeamCaveat).toContain("refusedExits counts risk refusals");
    expect(result.value.riskSeamCaveat).not.toContain("SUPERSEDED");
  });

  it("keeps the empty queue's null age as null, and the other queue's number", () => {
    const result = readTraderHealthReport(overTheWire(realSnapshot()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.queues[0]?.oldestMessageAgeMs).toBe(17);
    expect(result.value.queues[1]?.oldestMessageAgeMs).toBeNull();
  });

  it("renders to exposition with EVERY trader family present but the queue-age gap", () => {
    const result = readTraderHealthReport(overTheWire(realSnapshot()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exposition = renderExpositionFor(
      PLATFORM_METRIC_FAMILIES,
      traderHealthSamples(result.value),
    );

    // Every `trader_*` family the table declares appears — the dashboards bind
    // these names, and a family that never renders would leave a blank panel.
    for (const family of PLATFORM_METRIC_FAMILIES) {
      if (!family.name.startsWith("trader_")) continue;
      expect(exposition, `${family.name} did not render`).toContain(family.name);
    }

    expect(exposition).toContain('trader_halt_info{scope="MARKET",scope_ref="market-1"');
    // `THROUGHPUT-1a`: the input stream's lag, exactly as the section states it.
    expect(exposition).toContain("\ntrader_transport_lag_entries 250\n");
    // C1-RISK (OPS-07): the trader's retention setting is no longer a series.
    expect(exposition).not.toContain("trader_transport_retention_max_events");
    expect(exposition).toContain("\ntrader_transport_sample_age_seconds 2.5\n");
    expect(exposition).toContain("\ntrader_event_time_lag_seconds 2\n");
    expect(exposition).toContain('trader_queue_oldest_message_age_ms{queue="market-events"} 17');
    // The EMPTY queue is omitted from that family rather than reported as 0.
    expect(exposition).not.toContain('trader_queue_oldest_message_age_ms{queue="fills"}');
    // …while its other series ARE present, so "absent" is not "unscraped".
    expect(exposition).toContain('trader_queue_depth{queue="fills"} 0');
  });

  it("keeps EXACT decimals as label strings through the whole path", () => {
    const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
    const snapshot = state.snapshot({
      asOf: "2026-09-05T00:00:10.000Z",
      halts: [],
      queues: [],
      seams: {
        fills: { remembered: 0, maximumRemembered: 1, admitted: 0, refused: 0, evictions: 0 },
        reservations: {
          open: 0,
          taken: 0,
          released: 0,
          reservedCollateral: "12345678901234567890.12345",
        },
        cancels: { pending: 0, requested: 0, confirmed: 0, rejected: 0, silenceExceeded: 0 },
        orderViews: { emitted: 0, repeats: 0, tracked: 0 },
        allocator: {
          open: 0,
          applied: 0,
          released: 0,
          reservedCollateral: "0.30",
          refusalsByCode: {},
        },
        ...loopSeams(),
      },
    });
    const result = readTraderHealthReport(overTheWire(snapshot));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exposition = renderExpositionFor(
      PLATFORM_METRIC_FAMILIES,
      traderHealthSamples(result.value),
    );
    expect(exposition).toContain(
      'trader_seam_reservations_reserved_collateral_info{exact_decimal="12345678901234567890.12345"} 1',
    );
    expect(exposition).toContain(
      'trader_seam_allocator_reserved_collateral_info{exact_decimal="0.30"} 1',
    );
    // The float round trip a value-typed metric would have taken.
    expect(String(Number("12345678901234567890.12345"))).not.toBe("12345678901234567890.12345");
  });

  it("the door REFUSES a snapshot with a section removed — it is not permissive", () => {
    // The pin only means something if the door would notice a change. Remove a
    // seam section from a REAL snapshot and the door must say so.
    const document = overTheWire(realSnapshot()) as Record<string, Record<string, unknown>>;
    Reflect.deleteProperty(document["seams"] ?? {}, "allocator");
    const result = readTraderHealthReport(document);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.issues.join(" ")).toContain("allocator");
  });

  it("the door REFUSES a snapshot with an ADDED field — a new one must be adopted, not ignored", () => {
    const document = overTheWire(realSnapshot()) as Record<string, unknown>;
    document["somethingNew"] = 1;
    expect(readTraderHealthReport(document).ok).toBe(false);
  });
});
