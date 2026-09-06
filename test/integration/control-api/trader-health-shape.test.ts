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
 * It does not claim `apps/trader` serves this document over HTTP. It does not.
 * See `apps/control-api/src/health-source.ts` — the endpoint is a documented
 * composition obligation on a future `apps/trader` grant. What this pins is the
 * SHAPE, which is the half `WP-240` can own.
 */

import { describe, expect, it } from "vitest";

import { HealthState, RISK_SEAM_CAVEAT, type HealthSnapshot } from "@polymarket-bot/trader";
import { readTraderHealthReport } from "@polymarket-bot/control-api";
import {
  PLATFORM_METRIC_FAMILIES,
  renderExpositionFor,
  traderHealthSamples,
} from "@polymarket-bot/observability";

/**
 * Builds a snapshot from the REAL `HealthState`, exercising every counter it
 * has a mutator for, so the pin covers the whole surface rather than a corner.
 */
function realSnapshot(): HealthSnapshot {
  const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });

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
        action: "CANCEL_RESTING_ORDERS",
      },
    ],
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
    expect(report.queues).toHaveLength(2);
    expect(report.execution.observeOnlyIntents).toBe(2);
    expect(report.loop.deliveriesSuppressedByHalt).toBe(2);
    expect(report.risk.refusedExits).toBe(1);
    expect(report.risk.refusedExitsByCode).toEqual({ RISK_NO_NET_EDGE: 1 });
    expect(report.seams.allocator.refusalsByCode).toEqual({ CAPITAL_CAP_EXCEEDED: 1 });
  });

  it("carries WP-230's riskSeamCaveat through verbatim", () => {
    const result = readTraderHealthReport(overTheWire(realSnapshot()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The real constant, from the real trader — not a paraphrase.
    expect(result.value.riskSeamCaveat).toBe(RISK_SEAM_CAVEAT);
    expect(result.value.riskSeamCaveat).toContain("WP-220 accepted residual");
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
