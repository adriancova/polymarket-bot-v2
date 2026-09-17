/**
 * The producer→sample mapping, and the two properties that make it trustworthy:
 * DETERMINISM and EXACT DECIMALS.
 */

import { describe, expect, it } from "vitest";

import { renderExpositionFor } from "./exposition.js";
import { PLATFORM_METRIC_FAMILIES } from "./metric-families.js";
import { controlPlaneSamples, traderHealthSamples } from "./samples.js";
import { fullControlPlaneInput, fullTraderHealthReport } from "./testing.js";

function sample(name: string, labels?: Readonly<Record<string, string>>) {
  return traderHealthSamples(fullTraderHealthReport()).find(
    (entry) =>
      entry.name === name &&
      (labels === undefined ||
        Object.entries(labels).every(([key, value]) => entry.labels?.[key] === value)),
  );
}

describe("traderHealthSamples", () => {
  it("maps each counter to its OWN field (no two fields share a value in the fixture)", () => {
    expect(sample("trader_events_accepted_total")?.value).toBe(101);
    expect(sample("trader_events_processed_total")?.value).toBe(102);
    expect(sample("trader_decisions_persisted_total")?.value).toBe(108);
    expect(sample("trader_deliveries_suppressed_by_halt_total")?.value).toBe(111);
    expect(sample("trader_risk_refused_exits_total")?.value).toBe(204);
    expect(sample("trader_observe_only_intents_total")?.value).toBe(313);
    expect(sample("trader_unexplained_movements_total")?.value).toBe(404);
    expect(sample("trader_seam_fills_evictions_total")?.value).toBe(505);
    expect(sample("trader_seam_allocator_open")?.value).toBe(517);
  });

  it("emits one halt series per latched halt, with the §14.1 scope in the labels", () => {
    const halts = traderHealthSamples(fullTraderHealthReport()).filter(
      (entry) => entry.name === "trader_halt_info",
    );
    expect(halts).toHaveLength(3);
    expect(halts.map((entry) => entry.labels)).toEqual([
      { scope: "GLOBAL", scope_ref: "", code: "STORE_UNAVAILABLE", action: "FULL_HALT" },
      {
        scope: "MARKET",
        scope_ref: "market-1",
        code: "UNATTRIBUTED_ACTIVITY",
        action: "RECONCILE_ACCOUNT",
      },
      {
        scope: "STRATEGY_INSTANCE",
        scope_ref: "sb-1",
        code: "OPERATOR_HALT",
        action: "FULL_HALT",
      },
    ]);
    expect(sample("trader_halt_count")?.value).toBe(3);
    expect(sample("trader_healthy")?.value).toBe(0);
  });

  it("OMITS the oldest-message age of an empty queue rather than reporting 0", () => {
    expect(sample("trader_queue_oldest_message_age_ms", { queue: "market-events" })?.value).toBe(
      41,
    );
    expect(sample("trader_queue_oldest_message_age_ms", { queue: "fills" })).toBeUndefined();
    // …while every other field of the empty queue IS reported, so "absent"
    // cannot be confused with "this queue is not being scraped".
    expect(sample("trader_queue_depth", { queue: "fills" })?.value).toBe(0);
    expect(sample("trader_queue_accepted_total", { queue: "fills" })?.value).toBe(9);
  });

  it("carries EXACT decimals as labels and never as float values (§6 invariant 1)", () => {
    const reservations = sample("trader_seam_reservations_reserved_collateral_info");
    expect(reservations?.value).toBe(1);
    expect(reservations?.labels?.["exact_decimal"]).toBe("0.30");

    const allocator = sample("trader_seam_allocator_reserved_collateral_info");
    expect(allocator?.value).toBe(1);
    // The round trip a float64 would destroy: 20 significant digits.
    expect(allocator?.labels?.["exact_decimal"]).toBe("12345678901234567890.12345");
    expect(String(Number("12345678901234567890.12345"))).not.toBe(
      "12345678901234567890.12345",
    );
  });

  it("carries realized PnL as EXACT decimal labels, per instance in sorted order and for the account (TRDR-3)", () => {
    const perInstance = traderHealthSamples(fullTraderHealthReport()).filter(
      (entry) => entry.name === "trader_realized_pnl_info",
    );
    expect(perInstance.map((entry) => entry.value)).toEqual([1, 1]);
    expect(perInstance.map((entry) => entry.labels)).toEqual([
      { instance_id: "sb-1", exact_decimal: "12345678901234567890.12345" },
      { instance_id: "sb-2", exact_decimal: "-0.1000000000000000055511151231257827" },
    ]);
    const account = sample("trader_account_realized_pnl_info");
    expect(account?.value).toBe(1);
    expect(account?.labels).toEqual({
      exact_decimal: "12345678901234567890.0234499999999999944488848768742173",
    });
    // Both fixture values are ones float64 cannot hold; the labels are the
    // bytes the trader wrote, untouched.
    expect(String(Number("-0.1000000000000000055511151231257827"))).not.toBe(
      "-0.1000000000000000055511151231257827",
    );
    const rendered = renderExpositionFor(
      PLATFORM_METRIC_FAMILIES,
      traderHealthSamples(fullTraderHealthReport()),
    );
    expect(rendered).toContain(
      'trader_realized_pnl_info{instance_id="sb-2",exact_decimal="-0.1000000000000000055511151231257827"} 1',
    );
    expect(rendered).toContain(
      'trader_account_realized_pnl_info{exact_decimal="12345678901234567890.0234499999999999944488848768742173"} 1',
    );
  });

  it("OMITS the account realized-PnL series while no snapshot has been observed, rather than reporting 0", () => {
    const unobserved = traderHealthSamples(
      fullTraderHealthReport({
        accounting: {
          ...fullTraderHealthReport().accounting,
          realizedPnl: { byInstance: {}, account: null },
        },
      }),
    );
    expect(unobserved.find((entry) => entry.name === "trader_realized_pnl_info")).toBeUndefined();
    expect(
      unobserved.find((entry) => entry.name === "trader_account_realized_pnl_info"),
    ).toBeUndefined();
    // …while the count families of the same section ARE reported.
    expect(unobserved.find((entry) => entry.name === "trader_pnl_records_total")?.value).toBe(405);
  });

  it("raises the risk-seam caveat flag exactly when a protective exit was refused", () => {
    expect(sample("trader_risk_seam_caveat_active")?.value).toBe(1);
    const clean = traderHealthSamples(
      fullTraderHealthReport({
        risk: {
          evaluations: 1,
          approvals: 1,
          refusals: 0,
          refusalsByCode: {},
          refusedExits: 0,
          refusedExitsByCode: {},
          recommendationsByAction: {},
        },
      }),
    );
    expect(
      clean.find((entry) => entry.name === "trader_risk_seam_caveat_active")?.value,
    ).toBe(0);
  });

  it("emits map-valued sections in SORTED key order", () => {
    const codes = traderHealthSamples(fullTraderHealthReport())
      .filter((entry) => entry.name === "trader_risk_refusals_by_code_total")
      .map((entry) => entry.labels?.["code"]);
    expect(codes).toEqual(["RISK_NO_NET_EDGE", "RISK_STALE_INPUT"]);

    const allocatorCodes = traderHealthSamples(fullTraderHealthReport())
      .filter((entry) => entry.name === "trader_seam_allocator_refusals_by_code_total")
      .map((entry) => entry.labels?.["code"]);
    expect(allocatorCodes).toEqual([
      "CAPITAL_CAP_EXCEEDED",
      "CAPITAL_LIVE_OWNERSHIP_MISSING",
    ]);
  });

  it("is DETERMINISTIC: the same report renders byte-identical exposition twice", () => {
    const once = renderExpositionFor(
      PLATFORM_METRIC_FAMILIES,
      traderHealthSamples(fullTraderHealthReport()),
    );
    const twice = renderExpositionFor(
      PLATFORM_METRIC_FAMILIES,
      traderHealthSamples(fullTraderHealthReport()),
    );
    expect(once).toBe(twice);
    expect(once).toContain(
      'trader_seam_allocator_reserved_collateral_info{exact_decimal="12345678901234567890.12345"} 1',
    );
  });

  it("reads a report whose key insertion order differs and renders the SAME bytes", () => {
    const report = fullTraderHealthReport();
    const shuffled = {
      ...report,
      risk: {
        recommendationsByAction: { RECONCILE_ACCOUNT: 3, CANCEL_RESTING_ORDERS: 1 },
        refusedExitsByCode: { RISK_NO_NET_EDGE: 7, RISK_ENTRY_CUTOFF: 2 },
        refusalsByCode: { RISK_STALE_INPUT: 5, RISK_NO_NET_EDGE: 9 },
        refusedExits: report.risk.refusedExits,
        refusals: report.risk.refusals,
        approvals: report.risk.approvals,
        evaluations: report.risk.evaluations,
      },
    };
    expect(
      renderExpositionFor(PLATFORM_METRIC_FAMILIES, traderHealthSamples(shuffled)),
    ).toBe(renderExpositionFor(PLATFORM_METRIC_FAMILIES, traderHealthSamples(report)));
  });
});

describe("controlPlaneSamples", () => {
  it("reports the ceiling as an info gauge naming all three modes", () => {
    const info = controlPlaneSamples(fullControlPlaneInput()).find(
      (entry) => entry.name === "control_run_mode_info",
    );
    expect(info?.value).toBe(1);
    expect(info?.labels).toEqual({
      run_mode: "PAPER",
      maximum_run_mode: "PAPER",
      repository_maximum_run_mode: "PAPER",
    });
  });

  it("reports allow-real-orders as 0", () => {
    expect(
      controlPlaneSamples(fullControlPlaneInput()).find(
        (entry) => entry.name === "control_allow_real_orders",
      )?.value,
    ).toBe(0);
  });

  it("counts refused mode-raise attempts — acceptance 1, made visible", () => {
    expect(
      controlPlaneSamples(fullControlPlaneInput()).find(
        (entry) => entry.name === "control_mode_raise_attempts_refused_total",
      )?.value,
    ).toBe(2);
  });

  it("emits one series per latched kill switch, GLOBAL carrying an empty scope_ref", () => {
    const switches = controlPlaneSamples(fullControlPlaneInput()).filter(
      (entry) => entry.name === "control_kill_switch_active",
    );
    expect(switches.map((entry) => entry.labels)).toEqual([
      { scope: "GLOBAL", scope_ref: "", action: "FULL_HALT" },
      { scope: "MARKET", scope_ref: "market-1", action: "CANCEL_MARKET" },
    ]);
    expect(
      controlPlaneSamples(fullControlPlaneInput()).find(
        (entry) => entry.name === "control_kill_switches_active",
      )?.value,
    ).toBe(2);
  });

  it("reports the audit sink's size, bound and failures", () => {
    const samples = controlPlaneSamples(fullControlPlaneInput());
    const value = (name: string) => samples.find((entry) => entry.name === name)?.value;
    expect(value("control_audit_records")).toBe(7);
    expect(value("control_audit_capacity")).toBe(4096);
    expect(value("control_audit_append_failures_total")).toBe(1);
  });

  it("is DETERMINISTIC across differing key insertion order", () => {
    const base = fullControlPlaneInput();
    const shuffled = fullControlPlaneInput({
      authenticationFailuresByReason: { UNKNOWN_CREDENTIAL: 2, MISSING_CREDENTIAL: 4 },
      strategyInstancesByState: { RUNNING: 2, PAUSED: 1 },
    });
    expect(renderExpositionFor(PLATFORM_METRIC_FAMILIES, controlPlaneSamples(shuffled))).toBe(
      renderExpositionFor(PLATFORM_METRIC_FAMILIES, controlPlaneSamples(base)),
    );
  });
});
