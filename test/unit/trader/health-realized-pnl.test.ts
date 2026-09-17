/**
 * `TRDR-3` — realized PnL on the health surface is the PnL engine's own value,
 * observed at the store port, summed exactly, and never a float.
 *
 * Acceptance (c) at unit scale: a `PnlSnapshot.realizedPnl` float64 cannot
 * represent goes through `observeRealizedPnl` → `RealizedPnlBook` →
 * `HealthState.snapshot()` → `healthResponseBody` → `JSON.parse` →
 * `traderHealthSamples` → `renderExpositionFor`, and the rendered `_info` line
 * carries the same bytes. A source scan then pins that `Number(`, `parseFloat`
 * and `parseInt` do not appear on that path.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HealthState, RealizedPnlBook, type HealthSnapshot } from "../../../apps/trader/src/health.js";
import { healthResponseBody } from "../../../apps/trader/src/health-server.js";
import { observeRealizedPnl } from "../../../apps/trader/src/pnl-observation.js";
import { MemoryTraderStore } from "../../../apps/trader/src/testing/index.js";
import {
  PLATFORM_METRIC_FAMILIES,
  renderExpositionFor,
  traderHealthSamples,
} from "../../../packages/observability/src/index.js";
import type { PnlSnapshot } from "../../../packages/pnl/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const UNREPRESENTABLE = "0.1000000000000000055511151231257827";
const TWENTY_DIGITS = "12345678901234567890";

function snapshotFor(instanceId: string | null, realizedPnl: string): PnlSnapshot {
  return {
    scope: "VIRTUAL_STRATEGY",
    environment: "PAPER",
    accountRef: "paper-account",
    instanceId,
    runId: "018f4a7e-3333-7abc-8def-0123456789ab",
    marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
    denominationAsset: "pUSD",
    asOf: "2026-09-16T00:00:00Z",
    grossTradingPnl: realizedPnl,
    coreNetPnl: realizedPnl,
    allInPnl: realizedPnl,
    realizedPnl,
    unrealizedPnlMidpoint: "0",
    unrealizedPnlModel: null,
    unrealizedPnlLiquidation: null,
    worstCaseResolutionPnl: realizedPnl,
    feesPaid: "0",
    rewardEstimateTotal: "0",
    realizedRewards: "0",
    capitalCommitted: "0",
    feesByScheduleVersion: {},
    rewardsByProgram: {},
    estimatesByProgram: {},
  };
}

function seams(): Parameters<HealthState["snapshot"]>[0]["seams"] {
  return {
    fills: { remembered: 0, maximumRemembered: 1, admitted: 0, refused: 0, evictions: 0 },
    reservations: { open: 0, taken: 0, released: 0, reservedCollateral: "0" },
    cancels: { pending: 0, requested: 0, confirmed: 0, rejected: 0, silenceExceeded: 0 },
    orderViews: { emitted: 0, repeats: 0, tracked: 0 },
    allocator: { open: 0, applied: 0, released: 0, reservedCollateral: "0", refusalsByCode: {} },
  };
}

describe("RealizedPnlBook (TRDR-3)", () => {
  it("reads 'no snapshot observed' until a strategy snapshot is recorded — never a defaulted zero", () => {
    const book = new RealizedPnlBook();
    expect(book.view()).toEqual({ byInstance: {}, account: null });
    expect(book.observed).toBe(0);
    // A non-strategy stream has no instance and is not folded in.
    book.record({ instanceId: null, realizedPnl: "5" });
    expect(book.view()).toEqual({ byInstance: {}, account: null });
    expect(book.observed).toBe(0);
  });

  it("keeps the LATEST value per instance, sorts by id, and sums EXACTLY", () => {
    const book = new RealizedPnlBook();
    book.record({ instanceId: "sb-b", realizedPnl: "0" });
    book.record({ instanceId: "sb-a", realizedPnl: TWENTY_DIGITS });
    book.record({ instanceId: "sb-b", realizedPnl: UNREPRESENTABLE });
    expect(book.observed).toBe(3);
    const view = book.view();
    expect(Object.keys(view.byInstance)).toEqual(["sb-a", "sb-b"]);
    expect(view.byInstance).toEqual({ "sb-a": TWENTY_DIGITS, "sb-b": UNREPRESENTABLE });
    expect(view.account).toBe("12345678901234567890.1000000000000000055511151231257827");
    // What float64 would have made of either operand.
    expect(String(Number(UNREPRESENTABLE))).toBe("0.1");
    expect(String(Number(TWENTY_DIGITS))).toBe("12345678901234567000");
    // The view is frozen and its record prototype-free (own data for the encoder).
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.getPrototypeOf(view.byInstance)).toBeNull();
  });

  it("sums to the exact zero form when instances cancel, and the sum is canonical", () => {
    const book = new RealizedPnlBook();
    book.record({ instanceId: "a", realizedPnl: "-1.2" });
    book.record({ instanceId: "b", realizedPnl: "1.2" });
    expect(book.view().account).toBe("0");
    book.record({ instanceId: "c", realizedPnl: "-0.05" });
    expect(book.view().account).toBe("-0.05");
  });
});

describe("HealthState.attachRealizedPnl (TRDR-3)", () => {
  it("snapshots read the attached book; before attachment the field says 'no snapshot observed'", () => {
    const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
    const input = { asOf: "2026-09-16T00:00:00Z", halts: [], queues: [], seams: seams() };
    expect(state.snapshot(input).accounting.realizedPnl).toEqual({ byInstance: {}, account: null });
    const book = new RealizedPnlBook();
    book.record({ instanceId: "sb-1", realizedPnl: "-1.2" });
    state.attachRealizedPnl(book);
    expect(state.snapshot(input).accounting.realizedPnl).toEqual({
      byInstance: { "sb-1": "-1.2" },
      account: "-1.2",
    });
    // The counters are unaffected and still typed to the counter fields only.
    state.countAccounting("pnlRecords", 2);
    expect(state.snapshot(input).accounting.pnlRecords).toBe(2);
  });
});

describe("observeRealizedPnl — the store decorator (TRDR-3)", () => {
  it("records a snapshot's realizedPnl ONLY when the store accepted the write, and forwards every call unchanged", async () => {
    const store = new MemoryTraderStore();
    const book = new RealizedPnlBook();
    const observed = observeRealizedPnl(store, book);

    const accepted = await observed.writePnlSnapshot(snapshotFor("sb-1", UNREPRESENTABLE));
    expect(accepted).toEqual({ ok: true, value: null });
    expect(store.pnlSnapshots).toHaveLength(1);
    expect(book.view()).toEqual({ byInstance: { "sb-1": UNREPRESENTABLE }, account: UNREPRESENTABLE });

    // A refused write is returned as the store refused it and NOT recorded:
    // the loop halts on this answer, and the surface must not contradict it.
    store.fail("UNAVAILABLE", "connection lost");
    const refused = await observed.writePnlSnapshot(snapshotFor("sb-1", "999"));
    expect(refused.ok).toBe(false);
    expect(store.pnlSnapshots).toHaveLength(1);
    expect(book.view().byInstance).toEqual({ "sb-1": UNREPRESENTABLE });
    expect(book.observed).toBe(1);

    // `close` (and every other call) is the store's own; the decorator holds nothing.
    store.recover();
    await observed.close();
    expect(store.closed).toBe(true);
  });
});

describe("acceptance (c): no float anywhere on the PnL path (TRDR-3)", () => {
  it("round-trips a value float64 cannot represent from the PnL snapshot to the rendered _info line, byte for byte", async () => {
    const state = new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
    const book = new RealizedPnlBook();
    const observed = observeRealizedPnl(new MemoryTraderStore(), book);
    state.attachRealizedPnl(book);
    await observed.writePnlSnapshot(snapshotFor("sb-1", UNREPRESENTABLE));
    await observed.writePnlSnapshot(snapshotFor("sb-2", `-${TWENTY_DIGITS}`));

    const snapshot = state.snapshot({ asOf: "2026-09-16T00:00:00Z", halts: [], queues: [], seams: seams() });
    const wire = healthResponseBody(snapshot);
    expect(wire).toContain(`"byInstance":{"sb-1":"${UNREPRESENTABLE}","sb-2":"-${TWENTY_DIGITS}"}`);
    const parsed = JSON.parse(wire) as HealthSnapshot;
    expect(parsed.accounting.realizedPnl.account).toBe("-12345678901234567889.8999999999999999944488848768742173");

    const exposition = renderExpositionFor(PLATFORM_METRIC_FAMILIES, traderHealthSamples(parsed));
    expect(exposition).toContain(`trader_realized_pnl_info{instance_id="sb-1",exact_decimal="${UNREPRESENTABLE}"} 1`);
    expect(exposition).toContain(`trader_realized_pnl_info{instance_id="sb-2",exact_decimal="-${TWENTY_DIGITS}"} 1`);
    expect(exposition).toContain(
      'trader_account_realized_pnl_info{exact_decimal="-12345678901234567889.8999999999999999944488848768742173"} 1',
    );
    // No sample VALUE on the path is anything but the constant 1.
    for (const sample of traderHealthSamples(parsed)) {
      if (sample.name.endsWith("_pnl_info")) expect(sample.value).toBe(1);
    }
  });

  it("the source files on the path contain no Number(...), parseFloat or parseInt", () => {
    for (const path of [
      "apps/trader/src/health.ts",
      "apps/trader/src/pnl-observation.ts",
      "packages/observability/src/control/samples.ts",
      "packages/observability/src/control/metric-shapes.ts",
    ]) {
      // Comments stripped: the headers SAY "`Number(...)` does not appear" and
      // that sentence is not a call.
      const source = readFileSync(resolve(repoRoot, path), "utf8")
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^\s*\/\/.*$/gmu, "");
      expect(source, `${path} uses Number(`).not.toMatch(/\bNumber\s*\(/u);
      expect(source, `${path} uses parseFloat`).not.toContain("parseFloat");
      expect(source, `${path} uses parseInt`).not.toContain("parseInt");
      // Unary plus on an identifier or a string: `+x`, `+"..."`.
      expect(source, `${path} uses unary +`).not.toMatch(/[=(,]\s*\+\s*[A-Za-z_"'`]/u);
    }
  });
});
